import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { checkSignoffTarget } from '../src/signoff-target.ts';
import { signoffCommand } from '../src/signoff.ts';
import { checkProject } from '../src/check.ts';
import type { Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj } from './fixtures.ts';

const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(p, null, 2) + '\n');
const historical = JSON.parse(readFileSync(join(import.meta.dir, 'data/pre-interview.json'), 'utf8')) as { versions: JsonObject[] };
afterEach(() => setSystemTime());
function setup(): string {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => { p.signoffs = arr(p.signoffs).filter(s => obj(s).stage !== 'rig-review'); });
  writeFileSync(join(dir, 'words.txt'), 'Approve this exact version.\n');
  return dir;
}
function sign(dir: string): JsonObject {
  return JSON.parse(signoffCommand(['rig-review', dir, '--version', '2', '--by', 'user', '--verbatim-file', join(dir, 'words.txt'), '--json']).stdout);
}

test('raw legacy signatures remain targetless and report both new refusals', () => {
  const dir = fixture(() => {}, 'legacy-example-project.json', {}, true);
  const p = load(dir);
  expect(arr(p.signoffs).map(obj).filter(s => s.target)).toEqual([]);
  expect(checkProject(dir).refusals.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING', 'SIGNOFF_TARGET_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH']);
});

test('current review binds imported rig outputs and detects subsequent output drift', () => {
  const dir = setup(); const p = load(dir);
  arr(p.versions)[1] = structuredClone(historical.versions[1]!); save(dir, p);
  const result = sign(dir);
  const outputs = arr(obj(arr(p.versions)[1]).outputs).map(raw => {
    const f = obj(raw); return { bytes: f.bytes, path: f.path, sha256: f.sha256 };
  });
  const sha256 = createHash('sha256').update(JSON.stringify(outputs)).digest('hex');
  expect(result.target).toEqual({ version: 2, outputs: { path: 'versions[1].outputs', sha256 }, verdict: 'versions[1].verdicts[0]' });
  obj(arr(obj(arr(p.versions)[1]).outputs)[0]).sha256 = 'd'.repeat(64);
  const errors: Finding[] = [];
  checkSignoffTarget(dir, p, result, 'signoffs[0]', errors, []);
  expect(errors.map(f => f.code)).toEqual(['SIGNOFF_TARGET_STALE']);
});

test('lost imported outputs refuse before writing', () => {
  const dir = setup(); const p = load(dir); const v = structuredClone(historical.versions[1]!);
  v.outputs = []; v.outputs_lost = { note: 'Historical outputs lost', source: 'inventory' }; arr(p.versions)[1] = v; save(dir, p);
  const before = readFileSync(join(dir, 'project.json'));
  let failure: unknown;
  try { sign(dir); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Refusal);
  expect((failure as Refusal).code).toBe('SIGNOFF_TARGET_STALE');
  expect((failure as Refusal).message).toContain('outputs lost: nothing to bind');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test.each(['bounced', 'agent'])('withdrawn or nonhuman acceptance %s is refused by writer and reader', kind => {
  const dir = setup(); const signed = sign(dir); const p = load(dir); const v = obj(arr(p.versions)[1]);
  if (kind === 'bounced') arr(v.verdicts).push({ review: 'rig-review', verdict: 'bounced', by: 'user', at: '2026-11-20T01:00:00Z', verbatim: 'Withdraw approval' });
  else obj(arr(v.verdicts)[0]).by = 'agent';
  save(dir, p); const before = readFileSync(join(dir, 'project.json'));
  try { sign(dir); throw Error('unexpected approval'); }
  catch (error) { expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe('SIGNOFF_TARGET_STALE'); }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  const errors: Finding[] = [];
  checkSignoffTarget(dir, p, signed, 'signoffs[0]', errors, []);
  expect(errors.map(f => f.code)).toEqual(['SIGNOFF_TARGET_STALE']);
});
