import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import { expect, test, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STAGE_ORDER_SPEC, STAGE_VALUES } from '../src/stages.ts';
import { STRUCTURE_SCHEMA, latestPartsApproval, acceptsStructureDelta, structureDelta } from '../src/structure.ts';
import { Refusal } from '../src/refusal.ts';
import { arr, fixture, obj, step, waypoint, rehashSignoffs, supersede } from './fixtures.ts';
import { partsPackage, writeReviewedInput } from './parts-package.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { withPartsCheck } from './parts-check-fixture.ts';
import type { JsonObject } from '../src/templates.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
function write(dir: string, path: string, data: string): void { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), data); }
afterEach(() => testClock.reset());
function setup(density?: number, reopen = true, productionParts = false): string {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => {
    p.stage = 'parts-review'; p.stage_values = [...STAGE_VALUES]; p.versions = [];
    obj(p.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-19T00:00:00Z' };
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts'].includes(String(obj(s).stage)));
    for (const id of ['bones', 'meshes', 'constraints', 'motion']) supersede(waypoint(p, id), 'guide', null);
    for (const raw of arr(obj(p.plan).steps)) if (!['seethrough', 'assemble'].includes(String(obj(raw).id))) obj(raw).status = 'pending';
    step(p, 'assemble').rests_on = ['assemble']; rehashSignoffs(p);
  });
  if (productionParts) {
    const image = readFileSync(join(import.meta.dir, 'fixtures/rig-registration/rig/images/rectangle.png'));
    const manifest = JSON.stringify({ rig_size: [8, 16], scale_rig_per_source: 1, ghost_px: {},
      painting_in_rig: { path: 'painting_in_rig.png', sha256: createHash('sha256').update(image).digest('hex'), resample: 'lanczos3-rgb-opaque' },
      parts: [{ name: 'rectangle', from: 'painting:rectangle', x: 0, y: 0, w: 8, h: 16, opaque_px: 128, projected_core_px: 128, source_px_taken: 128, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 }] });
    const pkg = partsPackage({ partsDir: 'derived/parts/rig', verdict: 'evidence/parts-review.json', input: { 'parts.json': manifest, 'parts/rectangle.png': image, 'painting_in_rig.png': image } });
    for (const [path, bytes] of Object.entries(pkg.files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes); }
  }
  const root = 'derived/drafts/shape';
  const entry = density === undefined ? { contour: { bust: { alpha: 0.5 } } } : { density };
  write(dir, `${root}/config.json`, JSON.stringify({ meshes: { torso: entry } }));
  writeReviewedInput(dir, root);
  writeFileSync(join(dir, `${root}/input/recomposite_rig.png`), readFileSync(join(dir, 'derived/parts/rig/recomposite_rig.png')));
  for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) write(dir, `${root}/out/${name}`, '{}');
  write(dir, 'words.txt', 'Approve this synthetic structure.\r\n');
  if (reopen) {
    testClock.set(new Date('2026-11-19T00:00:00.500Z'));
    signoffCommand(['interview', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
    testClock.set(new Date('2026-11-19T00:00:01Z'));
    reopenCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
    testClock.set(new Date('2026-11-19T00:00:02Z'));
    signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_LAGGING');
    advanceCommand(['parts', dir]);
    testClock.set(new Date('2026-11-19T00:00:03Z'));
    completeParts(dir);
    advanceCommand(['parts-review', dir, ...withPartsCheck(dir)]);
    testClock.set(new Date('2026-11-20T00:00:00Z'));
  }
  if (!reopen) return dir;
  draftRigCommand(['shape', dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/input`]);
  recordPartsReceipt(dir, 'shape', testClock.now());
  diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'p10-n3=in-painting:synthetic', '--component', 'p1000-n3=in-painting:synthetic', '--by', 'agent']);
  const draft = obj(arr(read(dir).drafts)[0]);
  write(dir, 'evidence/structure.json', JSON.stringify({ schema: STRUCTURE_SCHEMA, draft_id: 'shape', config: draft.config, entries: [{ path: '/meshes/torso', value: entry }] }));
  return dir;
}
function completeParts(dir: string): void {
  for (const id of ['seethrough', 'assemble']) {
    for (const status of ['in-progress', 'at-checkpoint']) stepStatusCommand([id, status, dir, '--by', 'agent']);
    if (id === 'assemble') signoffCommand(['parts', dir, '--checkpoint', id, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
    stepStatusCommand([id, 'done', dir, '--by', 'agent']);
  }
}
function partsSign(dir: string, draft = 'shape', snapshot = 'evidence/structure.json'): void {
  signoffCommand(['parts-review', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt'),
    '--draft', draft, '--structure-file', snapshot]);
}
function freshRigInterview(dir: string, answerAt = '2026-11-21T00:00:00Z', approvalAt = '2026-11-22T00:00:00Z'): void {
  const p = read(dir); obj(p.plan).rigging_drafted_at = answerAt;
  const old = JSON.parse(readFileSync(join(import.meta.dir, '../templates/legacy-example-project.json'), 'utf8')) as JsonObject;
  for (const id of ['bones', 'meshes', 'constraints', 'motion']) {
    const guide = structuredClone(obj(waypoint(old, id).guide)); guide.at = answerAt; guide.verbatim = 'Fresh synthetic answer after viewing parts.';
    supersede(waypoint(p, id), 'guide', guide);
  }
  save(dir, p); testClock.set(new Date(approvalAt));
  advanceCommand(['rigging-interview', dir]);
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
  advanceCommand(['rigging', dir]);
  expect(checkProject(dir).refusals).toEqual([]);
});

test('missing snapshot, changed bytes, early guide and contradictory declaration refuse before write', () => {
  const dir = setup(); const before = readFileSync(join(dir, 'project.json'));
  try { signoffCommand(['parts-review', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt'), '--draft', 'shape']); throw Error('expected refusal'); } catch (e) { expect((e as Refusal).code).toBe('STRUCTURE_DECISIONS_MISSING'); }
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


test.each([false, true])('structure writer refuses ignored storage, including a tracked-path alias=%s', alias => {
  const dir = setup();
  const ignored = 'derived/drafts/shape/structure.json';
  write(dir, ignored, readFileSync(join(dir, 'evidence/structure.json'), 'utf8'));
  const path = alias ? 'evidence/ignored-structure.json' : ignored;
  if (alias) symlinkSync(join(dir, ignored), join(dir, path));
  const before = readFileSync(join(dir, 'project.json'));
  try { partsSign(dir, 'shape', path); throw Error('expected refusal'); } catch (error) { expect((error as Refusal).code).toBe('STRUCTURE_DECISIONS_INVALID'); }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});
import { checkProject, diffClassesCommand, draftRigCommand, advanceCommand, stepStatusCommand, signoffCommand, reopenCommand, testClock } from './clock.ts';

test('reopen and re-approved density preserve v1 and bind v2 to its own build-time structure', () => {
  const dir = setup(10); partsSign(dir); freshRigInterview(dir);
  signoffCommand(['rigging-interview', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
  function production(n: number, density: number, at: string): JsonObject {
    const path = `evidence/production-v${n}/config.json`;
    const text = JSON.stringify({ meshes: { torso: { density } }, requirements: 'requirements.json' });
    write(dir, path, text);
    write(dir, `evidence/production-v${n}/requirements.json`, JSON.stringify({ spec: 'spine-parts-requirements/1', fps: 12, requirements: [], setup_painting: { required: true } }));
    return { n, kind: 'rig', at, rig_version: null, review_origin: null, verdicts: [], outputs: [], evidence: [], answers_feedback: [],
      built_with: { '@rig-c/parts': PINNED_PACKAGES['@rig-c/parts'] }, provenance: { config: { path, sha256: sha(text) }, sections: {
        meshes: [{ entry: 'torso', guide: 'meshes', quote: 'Fresh synthetic answer after viewing parts.', asks: ['bend'] }],
      } } };
  }
  advanceCommand(['rigging', dir]);
  let p = read(dir); const v1 = production(1, 10, '2026-11-23T00:00:00Z'); arr(p.versions).push(v1); save(dir, p);
  expect(checkProject(dir).refusals).toEqual([]);
  const frozenV1 = JSON.stringify(v1);
  testClock.set(new Date('2026-11-24T00:00:00Z'));
  reopenCommand(['parts', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
  p = read(dir);
  expect(latestPartsApproval(p)).toBeUndefined();
  expect(latestPartsApproval(p, Date.parse('2026-11-23T00:00:00Z'))?.draft_id).toBe('shape');
  testClock.set(new Date('2026-11-24T01:00:00Z'));
  completeParts(dir);
  const root = 'derived/drafts/revised';
  write(dir, `${root}/config.json`, JSON.stringify({ meshes: { torso: { density: 20 } } }));
  writeReviewedInput(dir, root);
  writeFileSync(join(dir, `${root}/input/recomposite_rig.png`), readFileSync(join(dir, 'derived/parts/rig/recomposite_rig.png')));
  for (const file of ['rig.json', 'motion.json', 'mesh_report.json']) write(dir, `${root}/out/${file}`, '{}');
  draftRigCommand(['revised', dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/input`]);
  p = read(dir); const draft = obj(arr(p.drafts).at(-1));
  write(dir, 'evidence/revised-structure.json', JSON.stringify({ schema: STRUCTURE_SCHEMA, draft_id: 'revised', config: draft.config, entries: [{ path: '/meshes/torso', value: { density: 20 } }] }));
  testClock.set(new Date('2026-11-25T00:00:00Z'));
  advanceCommand(['parts-review', dir, ...withPartsCheck(dir)]);
  recordPartsReceipt(dir, 'revised', testClock.now());
  partsSign(dir, 'revised', 'evidence/revised-structure.json');
  freshRigInterview(dir, '2026-11-26T00:00:00Z', '2026-11-27T00:00:00Z');
  expect(signoffCommand(['rigging-interview', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]).exit).toBe(0);
  advanceCommand(['rigging', dir]);
  p = read(dir); arr(p.versions).push(production(2, 20, '2026-11-28T00:00:00Z')); save(dir, p);
  expect(latestPartsApproval(p, Date.parse('2026-11-24T12:00:00Z'))).toBeUndefined();
  expect(latestPartsApproval(p, Date.parse('2026-11-28T00:00:00Z'))?.draft_id).toBe('revised');
  expect(JSON.stringify(arr(p.versions)[0])).toBe(frozenV1);
  expect(checkProject(dir).refusals).toEqual([]);
  obj(arr(p.versions)[1]).provenance = production(2, 10, '2026-11-28T00:00:00Z').provenance as JsonObject; save(dir, p);
  const conflicts = checkProject(dir).refusals.filter(f => f.code === 'STRUCTURE_DELTA_MISMATCH');
  expect(conflicts.map(f => f.path)).toEqual(['versions[v2].provenance.structure_delta']);
});


test('live bound plan bases nulled during adoption stay refused by check; the carried refusal does not block a draft', () => {
  const dir = setup(undefined, false);
  const carried = checkProject(dir).refusals.filter(f => f.code === 'SIGNOFF_ANSWERS_STALE').map(f => f.path);
  draftRigCommand(['shape', dir, '--config', 'derived/drafts/shape/config.json', '--from', 'derived/drafts/shape/out', '--parts', 'derived/drafts/shape/input']);
  expect(arr(read(dir).drafts).map(d => obj(d).id)).toContain('shape');
  const stale = checkProject(dir).refusals.filter(f => f.code === 'SIGNOFF_ANSWERS_STALE');
  expect(stale.map(f => f.path)).toEqual(carried);
  expect(stale.some(f => f.message.includes('bones'))).toBe(true);
  expect(stale.some(f => f.message.includes('constraints'))).toBe(true);
});


test.each(['valid', 'missing', 'early', 'late', 'equal', 'reopened'])('meshes approval gate: %s', mode => {
  const project: JsonObject = { interview: { waypoints: [{ id: 'meshes', guide: { at: mode === 'early' ? '2026-11-01T00:00:00Z' : mode === 'late' ? '2026-11-05T00:00:00Z' : mode === 'equal' ? '2026-11-02T00:00:00Z' : '2026-11-03T00:00:00Z' } }] },
    signoffs: mode === 'missing' ? [] : [{ stage: 'rigging-interview', checkpoint: null, at: '2026-11-04T00:00:00Z', by: 'owner', verbatim: 'Approved.' }],
    reopens: mode === 'reopened' ? [{ stage: 'rigging-interview', from_stage: 'rigging', by: 'owner', at: '2026-11-05T00:00:00Z', verbatim: 'Reopen.', steps_before: [] }] : [] };
  expect(acceptsStructureDelta(project, { at: '2026-11-02T00:00:00Z' })).toBe(mode === 'valid');
});

test('delta preserves snapshot pointer order and absent declarations', () => {
  expect(structureDelta({ entries: [{ path: '/meshes/a~1b', value: { density: 2 } }, { path: '/meshes/gone', value: { density: 3 } }] }, { meshes: { 'a/b': { density: 4 } } })).toEqual([
    { entry: '/meshes/a~1b', snapshot: { density: 2 }, version: { density: 4 } },
    { entry: '/meshes/gone', snapshot: { density: 3 }, version: null },
  ]);
});

test.each(['valid', 'missing', 'early', 'unchanged'])('rig registration structure delta: %s', mode => {
  const dir = setup(10, true, true); partsSign(dir); freshRigInterview(dir);
  signoffCommand(['rigging-interview', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
  advanceCommand(['rigging', dir]);
  for (const path of ['outputs', 'derived/review']) rmSync(join(dir, path), { recursive: true, force: true });
  cpSync(join(import.meta.dir, 'fixtures/rig-registration'), join(dir, 'source'), { recursive: true });
  write(dir, 'source/config.json', JSON.stringify({ key: 'synthetic', meshes: { torso: { density: mode === 'unchanged' ? 10 : 20 } }, requirements: 'requirements.json' }));
  write(dir, 'source/requirements.json', JSON.stringify({ spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: { required: true } }));
  write(dir, 'source/adapter.json', '[]');
  cpSync(join(dir, 'derived/drafts/shape/input'), join(dir, 'source/parts'), { recursive: true });
  write(dir, 'source/at-source.json', JSON.stringify({ finished_at: '2026-11-23T00:00:00Z' }));
  write(dir, 'source/citations.json', JSON.stringify({ meshes: [{ entry: 'torso', guide: 'meshes', quote: 'Fresh synthetic answer after viewing parts.', asks: ['bend'] }] }));
  write(dir, 'source/run.json', JSON.stringify({ spec: 'rigc-run/1', package: { name: 'rig-c', version: '3.4.1' }, command: 'build', started_at: '2026-11-23T00:00:00.000Z', finished_at: '2026-11-23T00:00:00.000Z', inputs: [{ role: 'rig', path: 'rig/rig.json', sha256: '1'.repeat(64) }, { role: 'motion', path: 'rig/motion.json', sha256: '2'.repeat(64) }], outputs: [{ path: 'build/skeleton.model.json', sha256: '2'.repeat(64) }] }));
  if (mode === 'missing' || mode === 'early') {
    const p = read(dir);
    if (mode === 'missing') p.signoffs = arr(p.signoffs).filter(s => obj(s).stage !== 'rigging-interview');
    else obj(waypoint(p, 'meshes').guide).at = '2026-11-19T00:00:00Z';
    save(dir, p);
  }
  testClock.set(new Date('2026-11-24T00:00:00Z'));
  const before = readFileSync(join(dir, 'project.json'));
  const args = ['1', dir, '--parts', 'source/parts', '--rig', 'source/rig', '--build', 'source/build', '--idle', 'source/idle', '--config', 'source/config.json', '--path-adapter', 'source/adapter.json', '--compile-report', 'source/compile-report.json', '--toolchain-lock', 'source/package-lock.json', '--run-record', 'source/run.json', '--at-source', 'source/at-source.json', '--at-pointer', '/finished_at', '--citations', 'source/citations.json', '--by', 'registrant'];
  if (mode === 'missing' || mode === 'early') {
    let caught: unknown;
    try { rigVersionCommand(args); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Refusal);
    expect((caught as Refusal).code).toBe('STRUCTURE_DECISIONS_CONFLICT');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    return;
  }
  expect(rigVersionCommand(args).exit).toBe(0);
  const p = read(dir); const provenance = obj(obj(arr(p.versions)[0]).provenance);
  if (mode === 'unchanged') {
    expect(provenance.structure_delta).toBeUndefined();
    expect(checkProject(dir).warnings.filter(f => f.code === 'STRUCTURE_DELTA_REVIEW')).toEqual([]);
    const frozen = readFileSync(join(dir, 'project.json'));
    expect(nextProject(dir, testClock.now()).warnings).toBeUndefined();
    expect(interviewCommand(['--check', dir, '--json'], testClock.now()).stdout).not.toContain('STRUCTURE_DELTA_REVIEW');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(frozen);
    return;
  }
  expect(provenance.structure_delta).toEqual([{ entry: '/meshes/torso', snapshot: { density: 10 }, version: { density: 20 } }]);
  const report = JSON.parse(interviewCommand(['--check', dir, '--json'], testClock.now()).stdout);
  expect(report.warnings.find((f: { code: string }) => f.code === 'STRUCTURE_DELTA_REVIEW').message).toContain('1 changed structure entries');
  expect(nextProject(dir, testClock.now()).warnings?.map(f => f.code)).toContain('STRUCTURE_DELTA_REVIEW');
  obj(arr(provenance.structure_delta)[0]).version = { density: 99 }; save(dir, p);
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('STRUCTURE_DELTA_MISMATCH');
});
import { rigVersionCommand } from './clock.ts';
import { interviewCommand } from '../src/interview.ts';
import { nextProject } from '../src/next.ts';
