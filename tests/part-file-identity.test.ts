import { preparePartsApproval } from './parts-receipt-fixture.ts';
import { materializeFixture, arr, obj, retimeFixture } from './fixtures.ts';
import { PARTS_REVIEW_SINCE } from '../src/stages.ts';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { checkReviewPackages, reviewPackageCommand } from '../src/review-package.ts';
/** Retired part-identity contract date (#981): kept as a fixture time only. */
const PART_FILE_IDENTITY_SINCE = '2026-11-06T00:00:00Z';
import { selectSignoffTarget } from '../src/signoff-target.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { clockedCli, tempDir } from './helpers.ts';
import { seedStoredPartsSignoff, seedStoredVerdict, seedStoredVersionSignoff } from './historical-review-fixture.ts';
import { partsPackage } from './parts-package.ts';
import { advanceCommand, checkProject, diffClassesCommand, handoffCommand, testClock } from './clock.ts';

const roots: string[] = [];
afterEach(() => {
  testClock.reset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  preparePartsApproval(dir, testClock.now(), 'reviewed');
  // Negative consumer tests restore a separately recorded version population
  // after approval so they can plant disagreements the forward writer refuses.
  const original = load(dir);
  const versions = original.versions;
  original.versions = [];
  put(dir, 'project.json', JSON.stringify(original));
  diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT,
    '--component', 'p10-n3=in-painting:synthetic source', '--component', 'p1000-n3=in-painting:synthetic source', '--by', 'agent']);
  seedStoredPartsSignoff(dir, 'receipt-fixture', {
    by: 'user',
    at: testClock.now(),
    verbatim: readFileSync(join(dir, 'words.txt'), 'utf8'),
    structureFile: 'evidence/structure-receipt-fixture.json',
  });
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
  seedStoredVerdict(dir, Number(n), { review: 'rig-review', verdict: 'accepted', by: 'user',
    at: testClock.now(), verbatim: readFileSync(join(dir, 'words.txt'), 'utf8'), source: 'synthetic retained-byte control' });
}
function sign(dir: string, n = '1'): void {
  seedStoredVersionSignoff(dir, 'rig-review', Number(n), { by: 'user', at: testClock.now(),
    verbatim: readFileSync(join(dir, 'words.txt'), 'utf8') });
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

for (const artifact of ['parts/torso.png', 'parts.json']) test(`handoff and target selection refuse post-write package drift: ${artifact}`, () => {
  const dir = setup();
  packageRig(dir);
  accept(dir);
  const unsigned = load(dir);
  put(dir, `derived/review/v1/out/${artifact}`, 'distinct post-write bytes\n');
  expect(refusal(() => selectSignoffTarget(dir, unsigned, 'rig-review', '1')).code).toBe('SIGNOFF_TARGET_STALE');
  put(dir, `derived/review/v1/out/${artifact}`, readFileSync(join(dir, 'reviewed', artifact)));
  sign(dir);
  put(dir, `derived/review/v1/out/${artifact}`, 'distinct post-write bytes\n');
  const before = readFileSync(join(dir, 'project.json'));
  const result = Bun.spawnSync([process.execPath, ...clockedCli(), 'handoff', dir, '--json'], { env: process.env });
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
  for (const action of [() => packageRig(dir), () => selectSignoffTarget(dir, load(dir), 'rig-review', '1'), () => { handoffCommand([dir, '--json']); }]) {
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

for (const state of ['changed parts', 'changed manifest'] as const) test(`#981 a rig packages from ${state} that differ from the parts approval`, () => {
  const dir = setup();
  if (state === 'changed parts') put(dir, 'build/parts/torso.png', 'edited synthetic torso\n');
  else put(dir, 'build/parts.json', '{"parts":[]}\n');
  packageRig(dir);
  expect(checked(dir).refusals).toEqual([]);
  expect(checked(dir).warnings).toEqual([]);
});
