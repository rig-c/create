import { expect, test, setSystemTime, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { draftRigCommand } from '../src/drafts.ts';
import { signoffCommand } from '../src/signoff.ts';
import { STAGE_ORDER_SPEC, STAGE_VALUES } from '../src/stages.ts';
import { STRUCTURE_SCHEMA } from '../src/structure.ts';
import { Refusal } from '../src/refusal.ts';
import { arr, fixture, obj, step, waypoint, rehashSignoffs } from './fixtures.ts';
import { EXAMPLE_VERDICT } from './parts-package.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import type { JsonObject } from '../src/templates.ts';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
function write(dir: string, path: string, data: string): void { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), data); }
afterEach(() => setSystemTime());
function setup(): string {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => {
    p.stage = 'parts-review'; p.stage_values = [...STAGE_VALUES]; p.versions = [];
    obj(p.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-19T00:00:00Z' };
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts'].includes(String(obj(s).stage)));
    for (const id of ['bones', 'meshes', 'constraints', 'motion']) waypoint(p, id).guide = null;
    for (const raw of arr(obj(p.plan).steps)) if (!['seethrough', 'assemble'].includes(String(obj(raw).id))) obj(raw).status = 'pending';
    step(p, 'assemble').rests_on = ['assemble']; rehashSignoffs(p);
  });
  const root = 'derived/drafts/shape';
  write(dir, `${root}/config.json`, '{"meshes":{"torso":{"contour":{"bust":{"alpha":0.5}}}}}');
  write(dir, `${root}/input/parts.json`, '{}'); write(dir, `${root}/input/parts/torso.png`, 'synthetic');
  for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) write(dir, `${root}/out/${name}`, '{}');
  write(dir, 'words.txt', 'Approve this synthetic structure.\r\n');
  draftRigCommand(['shape', dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/input`]);
  const draft = obj(arr(read(dir).drafts)[0]);
  write(dir, 'evidence/structure.json', JSON.stringify({ schema: STRUCTURE_SCHEMA, draft_id: 'shape', config: draft.config, entries: [{ path: '/meshes/torso', value: { contour: { bust: { alpha: 0.5 } } } }] }));
  return dir;
}
function partsSign(dir: string): void {
  signoffCommand(['parts-review', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt'), '--evidence', EXAMPLE_VERDICT,
    '--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'p10-n3=in-painting:synthetic', '--component', 'p1000-n3=in-painting:synthetic',
    '--draft', 'shape', '--structure-file', 'evidence/structure.json']);
}
function freshRigInterview(dir: string): void {
  const p = read(dir); p.stage = 'rigging-interview'; obj(p.plan).rigging_drafted_at = '2026-11-21T00:00:00Z';
  const old = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-project.json'), 'utf8')) as JsonObject;
  for (const id of ['bones', 'meshes', 'constraints', 'motion']) {
    const guide = structuredClone(obj(waypoint(old, id).guide)); guide.at = '2026-11-21T00:00:00Z'; guide.verbatim = 'Fresh synthetic answer after viewing parts.';
    waypoint(p, id).guide = guide;
  }
  save(dir, p); setSystemTime(new Date('2026-11-22T00:00:00Z'));
}

test('human snapshot and rigging approval bind exact declarations without rewriting old signatures', () => {
  const dir = setup(); const before = arr(read(dir).signoffs).map(s => sha(JSON.stringify(s)));
  partsSign(dir); freshRigInterview(dir);
  signoffCommand(['rigging-interview', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
  const p = read(dir); const signed = obj(arr(p.signoffs).at(-1));
  expect(signed.accepted_parts).toEqual({ signoff_at: '2026-11-20T00:00:00.000Z', evidence: obj(arr(p.signoffs).at(-2)).evidence });
  expect(signed.structure).toEqual(obj(arr(p.signoffs).at(-2)).structure);
  expect(Object.keys(obj(signed.step_hashes))).toEqual(['bones', 'meshes', 'constraints', 'motion']);
  expect(arr(p.signoffs).slice(0, before.length).map(s => sha(JSON.stringify(s)))).toEqual(before);
  p.stage = 'rigging'; save(dir, p); expect(checkProject(dir).refusals).toEqual([]);
});

test('missing snapshot, changed bytes, early guide and contradictory declaration refuse before write', () => {
  const dir = setup(); const before = readFileSync(join(dir, 'project.json'));
  try { signoffCommand(['parts-review', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt'), '--evidence', EXAMPLE_VERDICT, '--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'p10-n3=in-painting:synthetic', '--component', 'p1000-n3=in-painting:synthetic']); throw Error('expected refusal'); } catch (e) { expect((e as Refusal).code).toBe('STRUCTURE_DECISIONS_MISSING'); }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  partsSign(dir); freshRigInterview(dir);
  const p = read(dir); obj(waypoint(p, 'bones').guide).at = '2026-11-19T00:00:00Z'; save(dir, p);
  const frozen = readFileSync(join(dir, 'project.json'));
  try { signoffCommand(['rigging-interview', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]); throw Error('expected refusal'); } catch (e) { expect((e as Refusal).code).toBe('RIG_GUIDE_BEFORE_PARTS'); }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(frozen);
  write(dir, 'evidence/structure.json', '{}');
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('STRUCTURE_DECISIONS_INVALID');
});


test('a snapshot contradicting its exact reviewed mesh declaration is refused before writing', () => {
  const dir = setup();
  const file = join(dir, 'evidence/structure.json');
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  snapshot.entries[0].value.contour.bust.alpha = 0.8;
  writeFileSync(file, JSON.stringify(snapshot));
  const before = readFileSync(join(dir, 'project.json'));
  try { partsSign(dir); throw Error('expected refusal'); } catch (error) { expect((error as Refusal).code).toBe('STRUCTURE_DECISIONS_CONFLICT'); }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});
