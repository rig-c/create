import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { STAGE_ORDER_SPEC, STAGE_VALUES } from '../src/stages.ts';
import { STRUCTURE_SCHEMA } from '../src/structure.ts';
import { PARTS_VERDICT_DRAFT_SINCE, sourceSha256 } from '../src/parts-verdict.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, checkProject, draftRigCommand, main, reopenCommand, signoffCommand, stepStatusCommand, testClock } from './clock.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { retainedPartsFiles } from './draft-fixture.ts';
import { arr, fixture, obj, rehashSignoffs, step, supersede, waypoint } from './fixtures.ts';
import { EXAMPLE_VERDICT, writeMeshVerdict, writeReviewedInput } from './parts-package.ts';
import { withPartsCheck } from './parts-check-fixture.ts';

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
function write(dir: string, path: string, data: string): void { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), data); }
afterEach(() => testClock.reset());

/** Part names exercise JSON Pointer escaping; values are copied, never derived. */
const MESHES = { torso: { contour: { bust: { alpha: 0.5 } } }, 'arm/l~1': { density: 3 } };
const OUT = 'evidence/structure-decisions.json';

/**
 * Records draft `id`; its parts (and the rig outputs a mesh verdict lists) are the ones `verdict` reviewed
 * unless `input` (parts-relative path → bytes) names others. Outputs the verdict does not list are written `{}`.
 */
function draft(dir: string, id: string, config: JsonObject, input?: Record<string, string | Uint8Array>, verdict = EXAMPLE_VERDICT): void {
  const root = `derived/drafts/${id}`;
  write(dir, `${root}/config.json`, JSON.stringify(config));
  if (input === undefined) writeReviewedInput(dir, root, verdict);
  else for (const [path, bytes] of Object.entries(input)) { mkdirSync(dirname(join(dir, root, 'input', path)), { recursive: true }); writeFileSync(join(dir, root, 'input', path), bytes); }
  for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) if (!existsSync(join(dir, root, 'out', name))) write(dir, `${root}/out/${name}`, '{}');
  draftRigCommand([id, dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/input`]);
}

/** A new-order project at parts-review with the labelled draft `shape` recorded, as in tests/structure.test.ts. */
function setup(): string {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => {
    p.stage = 'parts-review'; p.stage_values = [...STAGE_VALUES]; p.versions = [];
    obj(p.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-19T00:00:00Z' };
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts'].includes(String(obj(s).stage)));
    for (const id of ['bones', 'meshes', 'constraints', 'motion']) supersede(waypoint(p, id), 'guide', null);
    for (const raw of arr(obj(p.plan).steps)) if (!['seethrough', 'assemble'].includes(String(obj(raw).id))) obj(raw).status = 'pending';
    step(p, 'assemble').rests_on = ['assemble']; rehashSignoffs(p);
  });
  const words = join(dir, 'words.txt');
  write(dir, 'words.txt', 'Approve this synthetic structure.\n');
  testClock.set(new Date('2026-11-19T00:00:00.500Z'));
  signoffCommand(['interview', dir, '--by', 'owner', '--verbatim-file', words]);
  testClock.set(new Date('2026-11-19T00:00:01Z'));
  reopenCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words]);
  testClock.set(new Date('2026-11-19T00:00:02Z'));
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words]);
  advanceCommand(['parts', dir, '--by', 'owner', '--verbatim-file', words]);
  testClock.set(new Date('2026-11-19T00:00:03Z'));
  for (const id of ['seethrough', 'assemble']) {
    for (const status of ['in-progress', 'at-checkpoint']) stepStatusCommand([id, status, dir, '--by', 'agent']);
    if (id === 'assemble') signoffCommand(['parts', dir, '--checkpoint', id, '--by', 'owner', '--verbatim-file', words]);
    stepStatusCommand([id, 'done', dir, '--by', 'agent']);
  }
  advanceCommand(['parts-review', dir, '--by', 'owner', '--verbatim-file', words, ...withPartsCheck(dir)]);
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  draft(dir, 'shape', { meshes: MESHES, bones: { root: {} } });
  return dir;
}

const snapshot = (dir: string): { stdout: string; exit: number } =>
  structureSnapshotCommand([dir, '--draft', 'shape', '--verdict', EXAMPLE_VERDICT, '--out', OUT]);
const partsSign = (dir: string, structure = OUT): ReturnType<typeof signoffCommand> => signoffCommand(['parts-review', dir, '--by', 'owner',
  '--verbatim-file', join(dir, 'words.txt'), '--evidence', EXAMPLE_VERDICT, '--diff-report', EXAMPLE_DIFF_REPORT,
  '--component', 'p10-n3=in-painting:synthetic', '--component', 'p1000-n3=in-painting:synthetic', '--draft', 'shape', '--structure-file', structure]);

function refused(run: () => unknown, code: string): Refusal {
  try { run(); } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

test('the written snapshot copies every meshes declaration of the draft config and signs parts-review through writers', () => {
  const dir = setup();
  const project = readFileSync(join(dir, 'project.json'));
  const config = obj(arr(read(dir).drafts)[0]).config;
  expect(snapshot(dir).exit).toBe(0);
  const bytes = readFileSync(join(dir, OUT), 'utf8');
  expect(bytes).toBe(`${JSON.stringify({ schema: STRUCTURE_SCHEMA, draft_id: 'shape', config,
    entries: [{ path: '/meshes/torso', value: MESHES.torso }, { path: '/meshes/arm~1l~01', value: MESHES['arm/l~1'] }] }, null, 2)}\n`);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(project);
  // The same bytes again are a no-op success.
  expect(snapshot(dir).stdout).toContain('unchanged');
  expect(readFileSync(join(dir, OUT), 'utf8')).toBe(bytes);
  expect(partsSign(dir).exit).toBe(0);
  const signed = obj(arr(read(dir).signoffs).at(-1));
  expect(signed.draft_id).toBe('shape');
  expect(signed.structure).toEqual({ path: OUT, sha256: sha(bytes) });
});

test('a draft config without meshes gives explicit entries:[]', () => {
  const dir = setup();
  draft(dir, 'plain', { bones: { root: {} } });
  expect(structureSnapshotCommand([dir, '--draft', 'plain', '--verdict', EXAMPLE_VERDICT, '--out', OUT]).exit).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, OUT), 'utf8')).entries).toEqual([]);
});

test('a hand-edited entry of a written snapshot is refused at signoff and the record is unchanged', () => {
  const dir = setup();
  snapshot(dir);
  const file = join(dir, OUT);
  const edited = JSON.parse(readFileSync(file, 'utf8'));
  edited.entries[0].value.contour.bust.alpha = 0.8;
  writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
  const before = readFileSync(join(dir, 'project.json'));
  refused(() => partsSign(dir), 'STRUCTURE_DECISIONS_CONFLICT');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test.each([
  ['a not-approved verdict', 'PARTS_VERDICT_NOT_APPROVED', (dir: string): string[] => {
    const verdict = JSON.parse(readFileSync(join(dir, EXAMPLE_VERDICT), 'utf8'));
    verdict.status = 'changes-requested';
    write(dir, 'evidence/changes-requested.json', JSON.stringify(verdict));
    return ['--draft', 'shape', '--verdict', 'evidence/changes-requested.json', '--out', OUT];
  }],
  ['an unknown draft id', 'STRUCTURE_SNAPSHOT_DRAFT_UNKNOWN', (): string[] => ['--draft', 'missing', '--verdict', EXAMPLE_VERDICT, '--out', OUT]],
  ['a draft config changed since it was recorded', 'STRUCTURE_SNAPSHOT_CONFIG_CHANGED', (dir: string): string[] => {
    write(dir, 'derived/drafts/shape/config.json', JSON.stringify({ meshes: { torso: { density: 9 } } }));
    return ['--draft', 'shape', '--verdict', EXAMPLE_VERDICT, '--out', OUT];
  }],
  ['meshes that are not an object of declarations', 'STRUCTURE_DECISIONS_INVALID', (dir: string): string[] => {
    draft(dir, 'odd', { meshes: [{ density: 3 }] });
    return ['--draft', 'odd', '--verdict', EXAMPLE_VERDICT, '--out', OUT];
  }],
  ['--out under an ignored root', 'STRUCTURE_SNAPSHOT_OUT_IGNORED', (): string[] => ['--draft', 'shape', '--verdict', EXAMPLE_VERDICT, '--out', 'scratch/new/structure.json']],
  ['--out through an alias into an ignored root', 'STRUCTURE_SNAPSHOT_OUT_IGNORED', (dir: string): string[] => {
    mkdirSync(join(dir, 'derived/kept'), { recursive: true });
    symlinkSync(join(dir, 'derived/kept'), join(dir, 'evidence/kept'));
    return ['--draft', 'shape', '--verdict', EXAMPLE_VERDICT, '--out', 'evidence/kept/structure.json'];
  }],
  ['--out outside the project', 'STRUCTURE_SNAPSHOT_OUT_INVALID', (): string[] => ['--draft', 'shape', '--verdict', EXAMPLE_VERDICT, '--out', '../structure.json']],
] as const)('%s is refused and nothing is written', (_name, code, flags) => {
  const dir = setup();
  const args = flags(dir);
  const project = readFileSync(join(dir, 'project.json'));
  const out = args[args.indexOf('--out') + 1]!;
  refused(() => structureSnapshotCommand([dir, ...args]), code);
  expect(existsSync(join(dir, out))).toBe(false);
  expect(existsSync(join(dir, 'scratch/new'))).toBe(false);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(project);
});

test('--out holding different bytes is refused and left as it was', () => {
  const dir = setup();
  write(dir, OUT, '{"kept":true}\n');
  refused(() => snapshot(dir), 'STRUCTURE_SNAPSHOT_OUT_EXISTS');
  expect(readFileSync(join(dir, OUT), 'utf8')).toBe('{"kept":true}\n');
});

test('missing and repeated flags are usage refusals with exit 2', () => {
  const dir = setup();
  expect(refused(() => structureSnapshotCommand([dir, '--draft', 'shape', '--verdict', EXAMPLE_VERDICT]), 'STRUCTURE_SNAPSHOT_USAGE').exitCode).toBe(2);
  refused(() => structureSnapshotCommand([dir, '--draft', 'shape', '--draft', 'shape', '--verdict', EXAMPLE_VERDICT, '--out', OUT]), 'STRUCTURE_SNAPSHOT_USAGE');
  expect(main(['structure-snapshot', dir, '--out', OUT])).toBe(2);
  expect(existsSync(join(dir, OUT))).toBe(false);
});

// rig-c/create#236: the verdict binds the draft it approves by the sha256 multiset of the parts it reviewed.
const MISMATCH = 'PARTS_VERDICT_DRAFT_MISMATCH';
const exampleTree = (): Record<string, Uint8Array> => retainedPartsFiles(join(import.meta.dir, '../templates/example-draft/input'));
const signDraft = (dir: string, id: string): ReturnType<typeof signoffCommand> => signoffCommand(['parts-review', dir, '--by', 'owner',
  '--verbatim-file', join(dir, 'words.txt'), '--evidence', EXAMPLE_VERDICT, '--diff-report', EXAMPLE_DIFF_REPORT,
  '--component', 'p10-n3=in-painting:synthetic', '--component', 'p1000-n3=in-painting:synthetic', '--draft', id, '--structure-file', OUT]);

test('a verdict of one parts tree approves no other draft: both writers refuse and write nothing', () => {
  const dir = setup();
  // Draft "other" holds the example draft tree, which the verdict (the synthetic package) never reviewed.
  draft(dir, 'other', { meshes: MESHES }, exampleTree());
  const project = readFileSync(join(dir, 'project.json'));
  const error = refused(() => structureSnapshotCommand([dir, '--draft', 'other', '--verdict', EXAMPLE_VERDICT, '--out', OUT]), MISMATCH);
  // Up to three unmatched files on each side: 4 verdict entries, 7 draft entries once the declared painting is left out.
  expect(error.message).toContain('and 1 more');
  expect(error.message).toContain('and 4 more');
  expect(error.message).not.toContain('painting_in_rig.png (');
  expect(existsSync(join(dir, OUT))).toBe(false);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(project);
  expect(snapshot(dir).exit).toBe(0);
  const before = readFileSync(join(dir, 'project.json'));
  refused(() => signDraft(dir, 'other'), MISMATCH);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('one part image differing by one byte from the reviewed one is refused', () => {
  const dir = setup();
  const reviewed = join(dir, 'derived/parts/rig/parts/torso.png');
  const flipped = Buffer.from(readFileSync(reviewed));
  flipped[0] = flipped[0]! ^ 1;
  draft(dir, 'flipped', { meshes: MESHES }, {
    'parts.json': readFileSync(join(dir, 'derived/parts/rig/parts.json')),
    'parts/background.png': readFileSync(join(dir, 'derived/parts/rig/parts/background.png')),
    'parts/torso.png': flipped,
    'parts/lantern.png': readFileSync(join(dir, 'derived/parts/rig/parts/lantern.png')),
  });
  const error = refused(() => structureSnapshotCommand([dir, '--draft', 'flipped', '--verdict', EXAMPLE_VERDICT, '--out', OUT]), MISMATCH);
  expect(error.message).toContain('the verdict lists 1 file(s)');
  expect(error.message).toContain('the draft binds 1 the verdict does not list (derived/drafts/flipped/input/parts/torso.png)');
  expect(existsSync(join(dir, OUT))).toBe(false);
});

test.each([
  ['from the contract date', '2026-11-20T00:00:00.000Z', 'refusals'],
  ['before the contract date', new Date(Date.parse(PARTS_VERDICT_DRAFT_SINCE) - 1).toISOString(), 'warnings'],
] as const)('the check reads a sign-off naming another draft, dated %s (%s), among its %s', (_name, at, where) => {
  const dir = setup();
  draft(dir, 'other', { meshes: MESHES }, exampleTree());
  expect(snapshot(dir).exit).toBe(0);
  expect(signDraft(dir, 'shape').exit).toBe(0);
  const signed = read(dir);
  const index = arr(signed.signoffs).length - 1;
  expect(checkProject(dir).refusals.map(f => f.code)).not.toContain(MISMATCH);
  const signoff = obj(arr(signed.signoffs)[index]);
  signoff.draft_id = 'other';
  signoff.at = at;
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(signed, null, 2)}\n`);
  const report = checkProject(dir);
  const other = where === 'refusals' ? report.warnings : report.refusals;
  expect(report[where].filter(f => f.code === MISMATCH).map(f => f.path)).toEqual([`signoffs[${index}].draft_id`]);
  expect(other.map(f => f.code)).not.toContain(MISMATCH);
});

test('the painting parts.json declares is left out: a verdict without it approves the draft that binds it', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const project = read(dir);
  const bound = arr(obj(obj(arr(project.drafts)[0]).parts).files).map(f => String(obj(f).path));
  expect(bound).toContain('derived/drafts/example/input/painting_in_rig.png');
  const reviewed = (JSON.parse(readFileSync(join(dir, EXAMPLE_VERDICT), 'utf8')) as { source: { files: { path: string }[] } }).source.files.map(f => f.path);
  expect(reviewed.some(path => path.endsWith('painting_in_rig.png'))).toBe(false);
  const report = checkProject(dir);
  expect([...report.refusals, ...report.warnings].map(f => f.code)).not.toContain(MISMATCH);
  expect(structureSnapshotCommand([dir, '--draft', 'example', '--verdict', EXAMPLE_VERDICT, '--out', 'evidence/structure-again.json']).exit).toBe(0);
});

// rig-c/create#245: a parts view that shows meshes also lists rig.json, mesh_report.json and the mesh rasters,
// which the draft binds among its outputs (files[]), not its parts.
const MESH_VERDICT = 'evidence/parts-review-meshes.json';
const MESH_OUT = 'derived/parts/out';
const signWith = (dir: string, verdict: string, id: string): ReturnType<typeof signoffCommand> => signoffCommand(['parts-review', dir, '--by', 'owner',
  '--verbatim-file', join(dir, 'words.txt'), '--evidence', verdict, '--diff-report', EXAMPLE_DIFF_REPORT,
  '--component', 'p10-n3=in-painting:synthetic', '--component', 'p1000-n3=in-painting:synthetic', '--draft', id, '--structure-file', OUT]);
const snapshotWith = (dir: string, verdict: string, id: string): ReturnType<typeof structureSnapshotCommand> =>
  structureSnapshotCommand([dir, '--draft', id, '--verdict', verdict, '--out', OUT]);
const mismatches = (dir: string): string[] => { const r = checkProject(dir); return [...r.refusals, ...r.warnings].filter(f => f.code === MISMATCH).map(f => f.path); };

/** setup() plus draft `meshed`, recorded from the parts and rig outputs a mesh verdict of torso and lantern reviewed. */
function meshedSetup(): string {
  const dir = setup();
  const listed = writeMeshVerdict(dir, { verdict: MESH_VERDICT, out: MESH_OUT, meshes: ['torso', 'lantern'] });
  expect(listed.slice(-4)).toEqual([`${MESH_OUT}/images/torso.png`, `${MESH_OUT}/images/lantern.png`, `${MESH_OUT}/rig.json`, `${MESH_OUT}/mesh_report.json`]);
  draft(dir, 'meshed', { meshes: MESHES }, undefined, MESH_VERDICT);
  const files = arr(obj(arr(read(dir).drafts).find(d => obj(d).id === 'meshed')).files).map(f => String(obj(f).path));
  // The draft binds outputs the verdict does not list: motion.json and the region rasters (none here) stay unlisted.
  expect(files).toEqual(['derived/drafts/meshed/out/images/lantern.png', 'derived/drafts/meshed/out/images/torso.png',
    'derived/drafts/meshed/out/mesh_report.json', 'derived/drafts/meshed/out/motion.json', 'derived/drafts/meshed/out/rig.json']);
  return dir;
}

test('a verdict that also shows the draft\'s meshes approves that draft at structure-snapshot, signoff and the check', () => {
  const dir = meshedSetup();
  expect(snapshotWith(dir, MESH_VERDICT, 'meshed').exit).toBe(0);
  expect(signWith(dir, MESH_VERDICT, 'meshed').exit).toBe(0);
  const signed = arr(read(dir).signoffs);
  expect(obj(signed[signed.length - 1]).draft_id).toBe('meshed');
  expect(mismatches(dir)).toEqual([]);
});

test('a parts-only verdict of the same parts approves the meshed draft: unlisted outputs are not missing', () => {
  const dir = meshedSetup();
  expect(snapshotWith(dir, EXAMPLE_VERDICT, 'meshed').exit).toBe(0);
  expect(signWith(dir, EXAMPLE_VERDICT, 'meshed').exit).toBe(0);
  expect(mismatches(dir)).toEqual([]);
});

test('a verdict file the draft binds among neither its parts nor its outputs is refused at both writers', () => {
  const dir = meshedSetup();
  // The view showed a rig with one more mesh: its rig.json and the extra raster are in no draft list.
  const wide = 'evidence/parts-review-wide.json';
  writeMeshVerdict(dir, { verdict: wide, out: 'derived/parts/out-wide', meshes: ['background', 'torso', 'lantern'] });
  const project = readFileSync(join(dir, 'project.json'));
  const error = refused(() => snapshotWith(dir, wide, 'meshed'), MISMATCH);
  expect(error.message).toContain('the verdict lists 3 file(s)');
  expect(error.message).toContain('the draft binds 0 the verdict does not list');
  expect(existsSync(join(dir, OUT))).toBe(false);
  expect(snapshotWith(dir, MESH_VERDICT, 'meshed').exit).toBe(0);
  refused(() => signWith(dir, wide, 'meshed'), MISMATCH);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(project);
});

test('a mesh verdict missing one of the draft\'s parts is refused at both writers', () => {
  const dir = meshedSetup();
  const short = 'evidence/parts-review-short.json';
  writeMeshVerdict(dir, { verdict: short, out: MESH_OUT, meshes: ['torso', 'lantern'], omit: ['parts/background.png'] });
  const error = refused(() => snapshotWith(dir, short, 'meshed'), MISMATCH);
  expect(error.message).toContain('the verdict lists 0 file(s)');
  expect(error.message).toContain('the draft binds 1 the verdict does not list (derived/drafts/meshed/input/parts/background.png)');
  expect(existsSync(join(dir, OUT))).toBe(false);
  expect(snapshotWith(dir, MESH_VERDICT, 'meshed').exit).toBe(0);
  refused(() => signWith(dir, short, 'meshed'), MISMATCH);
});

test('the check refuses a sign-off whose mesh verdict lists a file of neither draft list', () => {
  const dir = meshedSetup();
  expect(snapshotWith(dir, MESH_VERDICT, 'meshed').exit).toBe(0);
  expect(signWith(dir, MESH_VERDICT, 'meshed').exit).toBe(0);
  expect(mismatches(dir)).toEqual([]);
  // The draft's rig.json changes after the verdict was saved: the verdict's rig.json is now in neither list.
  const signed = read(dir);
  const index = arr(signed.signoffs).length - 1;
  const meshed = obj(arr(signed.drafts).find(d => obj(d).id === 'meshed'));
  const rig = obj(arr(meshed.files).find(f => String(obj(f).path).endsWith('/rig.json')));
  rig.sha256 = sha('{}\n');
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(signed, null, 2)}\n`);
  expect(checkProject(dir).refusals.filter(f => f.code === MISMATCH).map(f => f.path)).toEqual([`signoffs[${index}].draft_id`]);
});

test('a verdict of the draft\'s own parts, painting, rig.json and mesh_report.json approves it', () => {
  // The example draft's rig has regions only, so its parts view lists no mesh raster (rig-c/review 2.4.6 locateMeshRasters).
  const dir = fixture(() => {}, 'example-project.json');
  const input = 'derived/drafts/example/input';
  const own = 'evidence/parts-review-own.json';
  const project = read(dir);
  const bound = obj(arr(project.drafts)[0]);
  const parts = (JSON.parse(readFileSync(join(dir, input, 'parts.json'), 'utf8')) as { parts: { name: string }[] }).parts.map(p => `${input}/parts/${p.name}.png`);
  const listed = [`${input}/parts.json`, ...parts, `${input}/painting_in_rig.png`, 'derived/drafts/example/out/rig.json', 'derived/drafts/example/out/mesh_report.json'];
  const reviewed = JSON.parse(readFileSync(join(dir, EXAMPLE_VERDICT), 'utf8')) as Record<string, unknown>;
  const files = listed.map(path => { const bytes = readFileSync(join(dir, path)); return { path: `../${path}`, bytes: bytes.length, sha256: sha(bytes) }; });
  const ownBytes = `${JSON.stringify({ ...reviewed, source: { sha256: sourceSha256(files), files, flags: [] } }, null, 2)}\n`;
  write(dir, own, ownBytes);
  expect(arr(bound.files).map(f => String(obj(f).path))).toContain('derived/drafts/example/out/rig.json');
  expect(structureSnapshotCommand([dir, '--draft', 'example', '--verdict', own, '--out', 'evidence/structure-again.json']).exit).toBe(0);
  // The check reads the filled example's sign-off resting on that verdict.
  const signoff = obj(arr(project.signoffs).find(s => obj(s).stage === 'parts-review' && obj(s).draft_id === 'example'));
  signoff.evidence = { kind: 'parts-verdict', path: own, sha256: sha(ownBytes) };
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  expect(mismatches(dir)).toEqual([]);
});
