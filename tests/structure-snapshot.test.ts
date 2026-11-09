import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { STAGE_ORDER_SPEC, STAGE_VALUES } from '../src/stages.ts';
import { STRUCTURE_SCHEMA } from '../src/structure.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, checkProject, diffClassesCommand, draftRigCommand, main, reopenCommand, signoffCommand, stepStatusCommand, testClock } from './clock.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { arr, fixture, obj, rehashSignoffs, step, supersede, waypoint } from './fixtures.ts';
import { EXAMPLE_VERDICT, writeReviewedInput } from './parts-package.ts';
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
  writeFileSync(join(dir, `${root}/input/recomposite_rig.png`), readFileSync(join(dir, 'derived/parts/rig/recomposite_rig.png')));
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
  advanceCommand(['parts', dir]);
  testClock.set(new Date('2026-11-19T00:00:03Z'));
  for (const id of ['seethrough', 'assemble']) {
    for (const status of ['in-progress', 'at-checkpoint']) stepStatusCommand([id, status, dir, '--by', 'agent']);
    if (id === 'assemble') signoffCommand(['parts', dir, '--checkpoint', id, '--by', 'owner', '--verbatim-file', words]);
    stepStatusCommand([id, 'done', dir, '--by', 'agent']);
  }
  advanceCommand(['parts-review', dir, ...withPartsCheck(dir)]);
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  draft(dir, 'shape', { meshes: MESHES, bones: { root: {} } });
  recordPartsReceipt(dir, 'shape', testClock.now());
  diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT,
    '--component', 'p10-n3=in-painting:synthetic', '--component', 'p1000-n3=in-painting:synthetic', '--by', 'agent']);
  return dir;
}

const snapshot = (dir: string): { stdout: string; exit: number } =>
  structureSnapshotCommand([dir, '--draft', 'shape', '--out', OUT]);
const partsSign = (dir: string, structure = OUT): ReturnType<typeof signoffCommand> =>
  signoffCommand(['parts-review', dir, '--by', 'owner',
    '--verbatim-file', join(dir, 'words.txt'), '--draft', 'shape', '--structure-file', structure]);

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
  recordPartsReceipt(dir, 'plain', testClock.now());
  expect(structureSnapshotCommand([dir, '--draft', 'plain', '--out', OUT]).exit).toBe(0);
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
    recordPartsReceipt(dir, 'shape', testClock.now(), 'changes-requested');
    return ['--draft', 'shape', '--out', OUT];
  }],
  ['an unknown draft id', 'STRUCTURE_SNAPSHOT_DRAFT_UNKNOWN', (): string[] => ['--draft', 'missing', '--out', OUT]],
  ['a draft config changed since it was recorded', 'STRUCTURE_SNAPSHOT_CONFIG_CHANGED', (dir: string): string[] => {
    write(dir, 'derived/drafts/shape/config.json', JSON.stringify({ meshes: { torso: { density: 9 } } }));
    return ['--draft', 'shape', '--out', OUT];
  }],
  ['meshes that are not an object of declarations', 'STRUCTURE_DECISIONS_INVALID', (dir: string): string[] => {
    draft(dir, 'odd', { meshes: [{ density: 3 }] });
    recordPartsReceipt(dir, 'odd', testClock.now());
    return ['--draft', 'odd', '--out', OUT];
  }],
  ['--out under an ignored root', 'STRUCTURE_SNAPSHOT_OUT_IGNORED', (): string[] => ['--draft', 'shape', '--out', 'scratch/new/structure.json']],
  ['--out through an alias into an ignored root', 'STRUCTURE_SNAPSHOT_OUT_IGNORED', (dir: string): string[] => {
    mkdirSync(join(dir, 'derived/kept'), { recursive: true });
    symlinkSync(join(dir, 'derived/kept'), join(dir, 'evidence/kept'));
    return ['--draft', 'shape', '--out', 'evidence/kept/structure.json'];
  }],
  ['--out outside the project', 'STRUCTURE_SNAPSHOT_OUT_INVALID', (): string[] => ['--draft', 'shape', '--out', '../structure.json']],
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
  expect(refused(() => structureSnapshotCommand([dir, '--draft', 'shape']), 'STRUCTURE_SNAPSHOT_USAGE').exitCode).toBe(2);
  refused(() => structureSnapshotCommand([dir, '--draft', 'shape', '--draft', 'shape', '--out', OUT]), 'STRUCTURE_SNAPSHOT_USAGE');
  expect(main(['structure-snapshot', dir, '--out', OUT])).toBe(2);
  expect(existsSync(join(dir, OUT))).toBe(false);
});

test('a draft with no API receipt refuses both writers without writing', () => {
  const dir = setup();
  draft(dir, 'other', { meshes: MESHES });
  const before = readFileSync(join(dir, 'project.json'));
  refused(() => structureSnapshotCommand([dir, '--draft', 'other', '--out', OUT]), 'PARTS_VERDICT_RECEIPT_REQUIRED');
  refused(() => signoffCommand(['parts-review', dir, '--by', 'user', '--draft', 'other', '--structure-file', OUT]), 'PARTS_VERDICT_RECEIPT_REQUIRED');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  expect(existsSync(join(dir, OUT))).toBe(false);
});
