import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { checkProject } from '../src/check.ts';
import { reviewCommand } from '../src/feedback.ts';
import { Refusal } from '../src/refusal.ts';
import { handoffCommand } from '../src/review.ts';
import { checkReviewPackages, PART_FILE_IDENTITY_SINCE, reviewPackageCommand } from '../src/review-package.ts';
import { signoffCommand } from '../src/signoff.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { tempDir } from './helpers.ts';
import { partsPackage } from './parts-package.ts';

const roots: string[] = [];
afterEach(() => {
  setSystemTime();
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
  signoffCommand(['parts-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt'),
    '--evidence', 'evidence/parts-review.json', '--diff-report', EXAMPLE_DIFF_REPORT,
    '--component', 'p10-n3=in-painting:synthetic source', '--component', 'p1000-n3=in-painting:synthetic source']);
}
/** Two stable source cohorts allow a reader control without forging a published package inventory. */
function setup(at = PART_FILE_IDENTITY_SINCE, approval = true, differentBuild = false): string {
  setSystemTime(new Date(at));
  const dir = tempDir();
  roots.push(dir);
  const approved = partsPackage({ partsDir: 'reviewed', verdict: 'evidence/parts-review.json' });
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
  const project: JsonObject = { schema: 'rig-create/project@0', stage: 'rig-review', signoffs: [], versions: [] };
  put(dir, 'project.json', JSON.stringify(project));
  if (approval) approveParts(dir);
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
function accept(dir: string): void {
  reviewCommand(['1', dir, '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review',
    '--verbatim-file', join(dir, 'words.txt'), '--source', 'synthetic retained-byte control']);
}
function sign(dir: string): void {
  signoffCommand(['rig-review', dir, '--version', '1', '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
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
