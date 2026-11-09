import { preparePartsApproval } from './parts-receipt-fixture.ts';
import { materializeFixture, arr, obj, retimeFixture } from './fixtures.ts';
import { PARTS_REVIEW_SINCE } from '../src/stages.ts';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { checkReviewPackages, PART_FILE_IDENTITY_SINCE, reviewPackageCommand } from '../src/review-package.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { clockedCli, tempDir } from './helpers.ts';
import { partsPackage } from './parts-package.ts';
import { advanceCommand, checkProject, diffClassesCommand, reviewCommand, handoffCommand, signoffCommand, testClock } from './clock.ts';

const roots: string[] = [];
afterEach(() => {
  testClock.reset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function put(dir: string, path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), bytes);
}
function load(dir: string): JsonObject {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
}
function approveParts(dir: string): void {
  const flags = preparePartsApproval(dir, testClock.now(), 'reviewed');
  // Negative consumer tests restore a separately recorded version population
  // after approval so they can plant disagreements the forward writer refuses.
  const original = load(dir);
  const versions = original.versions;
  original.versions = [];
  put(dir, 'project.json', JSON.stringify(original));
  diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT,
    '--component', 'p10-n3=in-painting:synthetic source', '--component', 'p1000-n3=in-painting:synthetic source', '--by', 'agent']);
  signoffCommand(['parts-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt'),
    ...flags]);
  const approved = load(dir);
  approved.versions = versions!;
  put(dir, 'project.json', JSON.stringify(approved));
}
/** Two stable source cohorts allow a reader control without forging a published package inventory. */
function setup(at = PART_FILE_IDENTITY_SINCE, approval = true, differentBuild = false): string {
  testClock.set(new Date(at));
  const preParts = Date.parse(at) < Date.parse(PARTS_REVIEW_SINCE);
  const dir = join(tempDir(), 'project');
  materializeFixture(dir, p => {
    p.stage = preParts ? 'rigging' : 'parts-review'; p.versions = [];
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts', 'rigging'].includes(String(obj(s).stage)));
    for (const raw of arr(obj(p.plan).steps)) if (obj(raw).phase === 'post') obj(raw).status = 'pending';
    if (preParts) {
      p.advances = [];
      for (const raw of arr(p.signoffs)) if (obj(raw).stage === 'parts') obj(raw).stage = 'rigging';
    }
    retimeFixture(p, Date.parse(at));
  }, 'legacy-example-project.json');
  roots.push(dirname(dir));
  rmSync(join(dir, 'derived/review'), { recursive: true });
  const approved = partsPackage({ partsDir: 'reviewed', verdict: 'evidence/parts-review.json', edit: verdict => { verdict.updatedAt = at; } });
  for (const [path, bytes] of Object.entries(approved.files)) put(dir, path, bytes);
  put(dir, 'words.txt', 'Approve these synthetic retained inputs.\n');
  const config = '{"key":"synthetic","bones":[{"name":"root"}]}\n';
  put(dir, 'frozen/config.json', config);
  for (const path of ['parts.json', 'parts/background.png', 'parts/torso.png', 'parts/lantern.png']) {
    put(dir, `build/${path}`, readFileSync(join(dir, 'reviewed', path)));
  }
  if (differentBuild) put(dir, 'build/parts/torso.png', 'distinct synthetic build torso\n');
  for (const name of ['rig', 'motion', 'mesh_report']) put(dir, `build/rig/${name}.json`, '{}\n');
  put(dir, 'build/check/build/skeleton.model.json', '{}\n');
  if (approval) {
    if (!preParts) {
      approveParts(dir);
      advanceCommand(['rigging', dir]);
    }
    advanceCommand(['rig-review', dir]);
  }
  const registered = load(dir);
  registered.versions = [{ n: 1, kind: 'rig', at, rig_version: null, built_by: 'agent',
    built_with: { '@rig-c/parts': '2.16.0', '@rig-c/core': '3.2.1' },
    changed: 'Synthetic retained-byte identity control.', review_origin: null, answers_feedback: [],
    outputs: [], evidence: [{ kind: 'still', path: 'evidence/still.png', sha256: sha('synthetic still'), camera: 'fixed', frame: 'setup' }],
    provenance: { config: { path: 'frozen/config.json', sha256: sha(config) }, sections: {} }, verdicts: [] }];
  put(dir, 'project.json', JSON.stringify(registered));
  return dir;
}
function packageRig(dir: string): void {
  reviewPackageCommand(['1', dir, '--config', 'frozen/config.json', '--from', 'build']);
}
function accept(dir: string, n = '1'): void {
  reviewCommand([n, dir, '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review',
    '--verbatim-file', join(dir, 'words.txt'), '--source', 'synthetic retained-byte control']);
}
function sign(dir: string, n = '1'): void {
  signoffCommand(['rig-review', dir, '--version', n, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
}
function checked(dir: string) {
  const ctx = { dir, project: load(dir), refusals: [] as { code: string; path: string; message: string }[], warnings: [] as { code: string; path: string; message: string }[] };
  checkReviewPackages(ctx);
  return ctx;
}
function refusal(action: () => void): Refusal {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    return error as Refusal;
  }
  throw new Error('expected a named refusal');
}

for (const state of ['changed', 'missing'] as const) test(`package refuses a ${state} listed part before publishing, including retries`, () => {
  const dir = setup();
  const expected = sha(readFileSync(join(dir, 'build/parts/torso.png')));
  if (state === 'changed') put(dir, 'build/parts/torso.png', 'changed synthetic torso\n');
  else rmSync(join(dir, 'build/parts/torso.png'));
  const before = readFileSync(join(dir, 'project.json'));
  let message: string | undefined;
  for (let retry = 0; retry < 2; retry++) {
    const error = refusal(() => packageRig(dir));
    expect(error.code).toBe('REVIEW_PACKAGE_PART_FILE_MISMATCH');
    expect(error.message).toContain('out/parts/torso.png');
    expect(error.message).toContain(expected);
    expect(error.message).toContain(state === 'missing' ? 'missing' : sha('changed synthetic torso\n'));
    message ??= error.message;
    expect(error.message).toBe(message);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);
    expect(readdirSync(join(dir, 'derived/review'))).toEqual([]);
    expect(existsSync(join(dir, 'project.json.review-package.lock'))).toBe(false);
  }
});

test('manifest drift retains its existing code', () => {
  const dir = setup();
  put(dir, 'build/parts.json', '{"parts":[]}\n');
  expect(refusal(() => packageRig(dir)).code).toBe('REVIEW_PACKAGE_PARTS_MISMATCH');
});

test('honest files pass package, acceptance, signoff and handoff through public writers', () => {
  const dir = setup();
  packageRig(dir);
  packageRig(dir);
  accept(dir);
  sign(dir);
  expect(checked(dir).refusals).toEqual([]);
  expect(checked(dir).warnings).toEqual([]);
  expect(JSON.parse(handoffCommand([dir, '--json']).stdout).rig_version).toBe(1);
});

for (const state of ['changed', 'missing'] as const) for (const at of ['2026-11-05T23:59:59.999Z', PART_FILE_IDENTITY_SINCE]) test(`part identity cutoff is fixed at creation, ${state}, ${at}`, () => {
  const dir = setup(at);
  if (state === 'changed') put(dir, 'build/parts/torso.png', 'changed synthetic torso\n');
  else rmSync(join(dir, 'build/parts/torso.png'));
  if (at === PART_FILE_IDENTITY_SINCE) {
    expect(refusal(() => packageRig(dir)).code).toBe('REVIEW_PACKAGE_PART_FILE_MISMATCH');
  } else {
    packageRig(dir);
    const result = checked(dir);
    expect(result.refusals).toEqual([]);
    expect(result.warnings.map(f => f.code)).toEqual(['REVIEW_PACKAGE_PART_FILE_LEGACY']);
    accept(dir);
    sign(dir);
    expect(JSON.parse(handoffCommand([dir, '--json']).stdout).rig_version).toBe(1);
  }
});

for (const boundary of ['check', 'absent-package', 'acceptance', 'signoff', 'handoff'] as const) test(`${boundary} detects independently recorded stable cohorts`, () => {
  // Both cohorts exist before any signature or package binding. Equal event times are fixed from creation.
  const dir = setup(PART_FILE_IDENTITY_SINCE, false, true);
  packageRig(dir);
  if (boundary === 'handoff' || boundary === 'signoff') accept(dir);
  if (boundary === 'handoff') sign(dir);
  approveParts(dir);
  if (boundary === 'absent-package') rmSync(join(dir, 'derived/review/v1'), { recursive: true });
  const before = readFileSync(join(dir, 'project.json'));
  if (boundary === 'check' || boundary === 'absent-package') {
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('REVIEW_PACKAGE_PART_FILE_MISMATCH');
  } else {
    const actions = {
      acceptance: () => accept(dir),
      signoff: () => sign(dir),
      handoff: () => { handoffCommand([dir, '--json']); },
    };
    expect(refusal(actions[boundary]).code).toBe('REVIEW_PACKAGE_PART_FILE_MISMATCH');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  }
});


test('acceptance scopes the part gate to its selected version', () => {
  const dir = setup(PART_FILE_IDENTITY_SINCE, false);
  // Initialize a separate, stable build cohort before either package is written.
  for (const path of ['parts.json', 'parts/background.png', 'parts/torso.png', 'parts/lantern.png',
    'rig/rig.json', 'rig/motion.json', 'rig/mesh_report.json', 'check/build/skeleton.model.json']) {
    put(dir, `other-build/${path}`, readFileSync(join(dir, 'build', path)));
  }
  put(dir, 'other-build/parts/torso.png', 'distinct second cohort\n');
  const project = load(dir);
  const first = (project.versions as JsonObject[])[0]!;
  (project.versions as JsonObject[]).push({ ...structuredClone(first), n: 2 });
  put(dir, 'project.json', JSON.stringify(project));
  packageRig(dir);
  reviewPackageCommand(['2', dir, '--config', 'frozen/config.json', '--from', 'other-build']);
  approveParts(dir);
  expect(checked(dir).refusals.map(f => [f.code, f.path])).toEqual([
    ['REVIEW_PACKAGE_PART_FILE_MISMATCH', 'versions[v2].review_package.files[out/parts/torso.png]'],
  ]);
  accept(dir);
  sign(dir);
});

for (const artifact of ['parts/torso.png', 'parts.json']) for (const boundary of ['acceptance', 'handoff']) test(`${boundary} refuses post-write package drift: ${artifact}`, () => {
  const dir = setup();
  packageRig(dir);
  if (boundary === 'handoff') { accept(dir); sign(dir); }
  put(dir, `derived/review/v1/out/${artifact}`, 'distinct post-write bytes\n');
  const before = readFileSync(join(dir, 'project.json'));
  const args = boundary === 'acceptance'
    ? ['review', '1', dir, '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review', '--verbatim-file', join(dir, 'words.txt'), '--source', 'synthetic control']
    : ['handoff', dir, '--json'];
  const result = Bun.spawnSync([process.execPath, ...clockedCli(), ...args], { env: process.env });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('REVIEW_PACKAGE_CHANGED');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('an unreadable rig date cannot authorize a drifted part', () => {
  const dir = setup();
  const p = load(dir);
  (p.versions as JsonObject[])[0]!.at = 'pending';
  put(dir, 'project.json', JSON.stringify(p));
  put(dir, 'build/parts/torso.png', 'distinct pending-date torso\n');
  const before = readFileSync(join(dir, 'project.json'));
  let error: unknown;
  try { packageRig(dir); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Refusal);
  expect((error as Refusal).code).toBe('RIG_VERSION_AT_INVALID');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

for (const boundary of ['acceptance', 'handoff']) test(`${boundary} propagates manifest identity disagreement without global gating`, () => {
  const dir = setup(PART_FILE_IDENTITY_SINCE, false);
  // The alternate manifest exists before packaging and before its approval is recorded.
  put(dir, 'build/parts.json', '{"parts":[]}\n');
  packageRig(dir);
  accept(dir);
  sign(dir);
  approveParts(dir);
  const before = readFileSync(join(dir, 'project.json'));
  expect(refusal(() => {
    if (boundary === 'acceptance') accept(dir);
    else handoffCommand([dir, '--json']);
  }).code).toBe('REVIEW_PACKAGE_PARTS_MISMATCH');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

for (const boundary of ['acceptance', 'handoff']) test(`${boundary} ignores package drift on an unselected version`, () => {
  const dir = setup();
  const project = load(dir);
  (project.versions as JsonObject[]).unshift({ ...structuredClone((project.versions as JsonObject[])[0]!), n: 2 });
  put(dir, 'project.json', JSON.stringify(project));
  packageRig(dir);
  reviewPackageCommand(['2', dir, '--config', 'frozen/config.json', '--from', 'build']);
  put(dir, 'derived/review/v1/out/parts/torso.png', 'unselected post-write drift\n');
  expect(checked(dir).refusals.map(f => f.code)).toEqual(['REVIEW_PACKAGE_CHANGED']);
  accept(dir, '2');
  sign(dir, '2');
  if (boundary === 'handoff') expect(handoffCommand([dir, '--json']).exit).toBe(0);
});

for (const at of ['pending', '', null, 123, undefined, '2026-02-31', '2026-02-31T10:00:00Z', '2026-13-01', 'pending 1', '1', 'build 3', '2026-11-07T00:00:00']) test(`all selected readers refuse an unreadable rig date: ${String(at)}`, () => {
  const dir = setup();
  packageRig(dir);
  accept(dir);
  sign(dir);
  const p = load(dir);
  const rig = (p.versions as JsonObject[])[0]!;
  if (at === undefined) delete rig.at;
  else rig.at = at;
  put(dir, 'project.json', JSON.stringify(p));
  put(dir, 'derived/review/v1/out/parts/torso.png', 'distinct reader-date drift\n');
  const before = readFileSync(join(dir, 'project.json'));
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('RIG_VERSION_AT_INVALID');
  for (const action of [() => packageRig(dir), () => accept(dir), () => sign(dir), () => { handoffCommand([dir, '--json']); }]) {
    const error = refusal(action);
    expect(error.code).toBe('RIG_VERSION_AT_INVALID');
    expect(error.message).toContain('versions[v1].at');
    expect(error.message).toContain(JSON.stringify(at) ?? 'undefined');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  }
});

test('date findings include imported rigs and exclude posts and nested member snapshots', () => {
  const ctx = { dir: tempDir(), project: { versions: [
    { n: 1, kind: 'rig', pre_interview: true, at: 'pending' },
    { n: 2, kind: 'post', at: 'pending' },
  ], members: { first: { versions: [{ n: 3, kind: 'rig', at: 'pending' }] } } } as JsonObject,
  refusals: [] as { code: string; path: string; message: string }[], warnings: [] as { code: string; path: string; message: string }[] };
  roots.push(ctx.dir);
  checkReviewPackages(ctx);
  expect(ctx.refusals.map(f => [f.code, f.path])).toEqual([['RIG_VERSION_AT_INVALID', 'versions[v1].at']]);
  expect(ctx.warnings).toEqual([]);
});

for (const at of ['2026-11-02', '2026-11-06T12:00:00+02:00', '2026-11-06T23:30:00-02:00', '2026-11-06T00:30:00+09:00']) test(`calendar dates and zoned ISO dates pass all boundaries: ${at}`, () => {
  const dir = setup(at);
  packageRig(dir);
  accept(dir);
  sign(dir);
  expect(checked(dir).refusals).toEqual([]);
  expect(checked(dir).warnings).toEqual([]);
  expect(handoffCommand([dir, '--json']).exit).toBe(0);
});

test('a date-only cutoff day enforces part identity at UTC midnight', () => {
  const dir = setup('2026-11-06');
  expect(Date.parse('2026-11-06')).toBe(Date.parse(PART_FILE_IDENTITY_SINCE));
  put(dir, 'build/parts/torso.png', 'distinct cutoff-day torso\n');
  const before = readFileSync(join(dir, 'project.json'));
  expect(refusal(() => packageRig(dir)).code).toBe('REVIEW_PACKAGE_PART_FILE_MISMATCH');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('opaque CLI source paths still refuse a planted accepted image mismatch', () => {
  const dir = setup();
  const receipt = (load(dir).review_acts as JsonObject[]).find(receipt => receipt.schema === 'rig-create/parts-verdict-cli@1')!;
  const response = JSON.parse(readFileSync(join(dir, String((receipt.evidence as JsonObject).path)), 'utf8')) as JsonObject;
  expect(((response.source as JsonObject).files as JsonObject[]).every(file => file.path === undefined)).toBe(true);
  put(dir, 'build/parts/torso.png', 'synthetic mismatched accepted image');
  const before = readFileSync(join(dir, 'project.json'));
  const error = refusal(() => packageRig(dir));
  expect(error.code).toBe('REVIEW_PACKAGE_PART_FILE_MISMATCH');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});
