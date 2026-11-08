import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { checkSignoffTarget, SIGNOFF_TARGET_SINCE } from '../src/signoff-target.ts';
import type { JsonObject } from '../src/templates.ts';
import { directionFixture } from './direction-fixture.ts';
import { arr, fixture, obj, withdrawSignature } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { checkProject, directionCommand, advanceCommand, reopenCommand, signoffCommand, testClock } from './clock.ts';

const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
afterEach(() => testClock.reset());
function setup(stage = 'rig-review'): string {
  const dir = fixture();
  writeFileSync(join(dir, 'words.txt'), 'Approve this reviewed version.\n');
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  if (stage === 'direction-review') reopenCommand([stage, dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
  // A withdrawn approval is signed again at its own instant, so the move it authorized stays linked.
  testClock.set(new Date(stage === 'direction-review' ? '2026-11-20T00:00:01Z' : withdrawSignature(dir, stage)));
  return dir;
}
function sign(dir: string, stage: string, version?: string): JsonObject {
  const signature = JSON.parse(signoffCommand([stage, dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt'), '--json', ...(version ? ['--version', version] : [])]).stdout) as JsonObject;
  if (stage === 'direction-review' && load(dir).stage === stage) {
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_LAGGING');
    advanceCommand(['accepted', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
  }
  return signature;
}
function refused(dir: string, stage: string, version?: string, code = 'SIGNOFF_TARGET_STALE'): void {
  const before = readFileSync(join(dir, 'project.json'));
  try { sign(dir, stage, version); throw Error('writer unexpectedly accepted'); }
  catch (error) { expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code); }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

test.each([undefined, '2'])('rig writer binds independently hashed inventory, version %s', version => {
  const dir = setup(); const result = sign(dir, 'rig-review', version);
  const pkg = obj(obj(arr(load(dir).versions)[1]).review_package);
  const config = obj(pkg.config);
  const independent = JSON.stringify({ config: { path: config.path, sha256: config.sha256 }, files: arr(pkg.files).map(raw => { const f = obj(raw); return { path: f.path, sha256: f.sha256 }; }) });
  expect(result.target).toEqual({ version: 2, verdict: 'versions[1].verdicts[0]', review_package: { path: 'versions[1].review_package', sha256: hash(independent) } });
});

test.each([undefined, '4'])('unadopted post writer binds recorded take config, version %s', version => {
  const dir = setup('direction-review'); const result = sign(dir, 'direction-review', version);
  expect(result.target).toEqual({ version: 4, verdict: 'versions[3].verdicts[0]', post_config: obj(obj(arr(load(dir).versions)[3]).provenance).config });
});

test.each([undefined, '2'])('adopted post writer binds document bytes, version %s', version => {
  const dir = join(tempDir(), 'authored'); const f = directionFixture(dir);
  directionCommand(['write', '2', dir, '--file', 'evidence/input.json', '--rig', '1']);
  const p = f.load(); obj(arr(p.versions)[1]).verdicts = [{ review: 'direction-review', verdict: 'accepted', by: 'user', at: SIGNOFF_TARGET_SINCE, verbatim: 'Accept' }]; f.save(p);
  testClock.set(new Date(SIGNOFF_TARGET_SINCE));
  const result = sign(dir, 'direction-review', version);
  expect(obj(obj(result.target).direction)).toEqual({ path: 'evidence/direction/v2.json', sha256: hash(readFileSync(join(dir, 'evidence/direction/v2.json'))) });
});

test('ambiguous candidates, nonexistent version and unaccepted verdict refuse atomically', () => {
  const dir = setup(); const p = load(dir); const v = obj(arr(p.versions)[0]);
  v.verdicts = [...arr(v.verdicts), { review: 'rig-review', verdict: 'accepted', by: 'user' }]; save(dir, p);
  refused(dir, 'rig-review'); refused(dir, 'rig-review', '999');
  v.verdicts = []; save(dir, p); refused(dir, 'rig-review', '1');
});

test.each(['missing', 'changed'])('writer refuses %s package bytes atomically', state => {
  const dir = setup(); const path = join(dir, 'derived/review/v2/config.json');
  if (state === 'missing') rmSync(path); else writeFileSync(path, '{"distinct":"planted config drift"}\n');
  refused(dir, 'rig-review', '2');
});

test.each(['missing', 'changed'])('writer refuses %s authored document atomically', state => {
  const dir = join(tempDir(), 'authored'); const f = directionFixture(dir);
  directionCommand(['write', '2', dir, '--file', 'evidence/input.json', '--rig', '1']);
  const p = f.load(); obj(arr(p.versions)[1]).verdicts = [{ review: 'direction-review', verdict: 'accepted' }]; f.save(p);
  const path = join(dir, 'evidence/direction/v2.json');
  if (state === 'missing') rmSync(path); else writeFileSync(path, '{"distinct":"planted direction drift"}\n');
  refused(dir, 'direction-review', '2', state === 'missing' ? 'DIRECTION_FILE' : 'DIRECTION_HASH');
});

test('reader catches distinct disk drift, record drift, bounced path and wrong version kind', () => {
  const dir = fixture(); const p = load(dir);
  const signed = arr(p.signoffs).map(obj).find(s => s.stage === 'rig-review')!;
  writeFileSync(join(dir, 'derived/review/v2/config.json'), '{"distinct":"reader disk drift"}\n');
  expect(checkProject(dir, p).refusals.map(f => f.code)).toContain('REVIEW_PACKAGE_CHANGED');
  const pkg = obj(obj(arr(p.versions)[1]).review_package);
  const changed = hash(readFileSync(join(dir, 'derived/review/v2/config.json')));
  obj(pkg.config).sha256 = changed;
  obj(arr(pkg.files).find(f => obj(f).path === 'config.json')).sha256 = changed;
  expect(checkProject(dir, p).refusals.map(f => f.code)).toContain('SIGNOFF_TARGET_STALE');
  const original = structuredClone(signed.target);
  for (const plant of ['hash', 'bounced', 'kind']) {
    signed.target = structuredClone(original); const target = obj(signed.target);
    if (plant === 'hash') obj(target.review_package).sha256 = 'f'.repeat(64);
    if (plant === 'bounced') { target.version = 1; target.verdict = 'versions[0].verdicts[0]'; }
    if (plant === 'kind') { target.version = 4; target.verdict = 'versions[3].verdicts[0]'; }
    const findings: import('../src/check.ts').Finding[] = [];
    checkSignoffTarget(dir, p, signed, 'signoffs[0]', findings, []);
    expect(findings.map(f => f.code)).toEqual(['SIGNOFF_TARGET_STALE']);
  }
});

test('missing target is refused at boundary, with exactly one warning for a legacy signature', () => {
  const signed: JsonObject = { stage: 'rig-review', at: SIGNOFF_TARGET_SINCE };
  const errors: import('../src/check.ts').Finding[] = [];
  const warnings: import('../src/check.ts').Finding[] = [];
  checkSignoffTarget('.', {}, signed, 'signoffs[0]', errors, warnings);
  expect(errors.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING']);
  expect(warnings).toEqual([]);
  signed.at = '2026-11-05T23:59:59.999Z';
  const legacyErrors: import('../src/check.ts').Finding[] = [];
  checkSignoffTarget('.', {}, signed, 'signoffs[0]', legacyErrors, warnings);
  expect(legacyErrors).toEqual([]);
  expect(warnings.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING_LEGACY']);
});

test('live target removes default candidate; after a reopen only a rig accepted since is selectable', () => {
  const dir = setup(); sign(dir, 'rig-review'); refused(dir, 'rig-review');
  testClock.set(new Date('2026-11-21T00:00:00Z'));
  reopenCommand(['rig-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
  testClock.set(new Date('2026-11-22T00:00:00Z'));
  // #243: the reopen made v2's acceptance history, so no live rig is accepted.
  refused(dir, 'rig-review', undefined, 'RIG_VERSION_UNACCEPTED');
  refused(dir, 'rig-review', '2', 'RIG_VERSION_UNACCEPTED');
  // A rig built and accepted after the reopen (synthetic copy of v2's retained package).
  const p = load(dir); const v2 = structuredClone(obj(arr(p.versions)[1]));
  cpSync(join(dir, 'derived/review/v2'), join(dir, 'derived/review/v5'), { recursive: true });
  arr(p.versions).push({ ...v2, n: 5, at: '2026-11-21T12:00:00.000Z', review_package: { ...obj(v2.review_package), open: "rig-review open 'derived/review/v5/out'" },
    verdicts: [{ review: 'rig-review', verdict: 'accepted', by: 'user', at: '2026-11-21T13:00:00.000Z', verbatim: 'Accept the new rig.', on_items: [] }] });
  save(dir, p);
  // The history rig is no candidate even with --version, and the live accepted one is the default.
  refused(dir, 'rig-review', '2');
  expect(obj(sign(dir, 'rig-review').target).version).toBe(5);
});

test('post config drift is stale and source locations are excluded from package content', () => {
  const dir = fixture(); const p = load(dir);
  const signatures = arr(p.signoffs).map(obj);
  const post = signatures.find(s => s.stage === 'direction-review')!;
  obj(obj(arr(p.versions)[3]).provenance).config = { path: 'evidence/changed-take.json', sha256: 'b'.repeat(64) };
  const errors: import('../src/check.ts').Finding[] = [];
  checkSignoffTarget(dir, p, post, 'signoffs[9]', errors, []);
  expect(errors.map(f => f.code)).toEqual(['SIGNOFF_TARGET_STALE']);
  expect(errors[0]!.message).toContain('post config changed since signing');
  const pkg = obj(obj(arr(p.versions)[1]).review_package);
  pkg.from = 'outputs/relocated'; pkg.open = 'relocated command';
  const rigErrors: import('../src/check.ts').Finding[] = [];
  checkSignoffTarget(dir, p, signatures.find(s => s.stage === 'rig-review')!, 'signoffs[8]', rigErrors, []);
  expect(rigErrors).toEqual([]);
});

test('candidate refusal names every version without a recency preference', () => {
  const dir = setup(); const p = load(dir);
  obj(arr(p.versions)[0]).verdicts = [{ review: 'rig-review', verdict: 'accepted', by: 'user' }]; save(dir, p);
  expect(() => sign(dir, 'rig-review')).toThrow('candidates [1, 2]');
});
