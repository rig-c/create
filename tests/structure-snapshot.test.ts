import { recordPartsReceipt, seedPartsCliReceipt } from './parts-receipt-fixture.ts';
import { seedStoredPartsSignoff } from './historical-review-fixture.ts';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { STAGE_ORDER_SPEC, STAGE_VALUES } from '../src/stages.ts';
import { STRUCTURE_SCHEMA } from '../src/structure.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import { locateParts } from '../src/parts-sections.ts';
import { assertPartsReadDraft, decodePartsRead } from '../src/parts-verdict-record.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, checkProject, diffClassesCommand, main, signoffCommand, stepStatusCommand, testClock } from './clock.ts';
import { seedRetainedDraft } from './numbered-seed.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { plantLegacyReopen, arr, fixture, obj, rehashSignoffs, step, supersede, waypoint } from './fixtures.ts';
import { EXAMPLE_VERDICT, writeReviewedInput } from './parts-package.ts';
import { withPartsCheck } from './parts-check-fixture.ts';

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
function write(dir: string, path: string, data: string): void { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), data); }
afterEach(() => testClock.reset());

/** Part names exercise JSON Pointer escaping; values are copied, never derived. */
const MESHES = { torso: { contour: { bust: { alpha: 0.5 } } }, 'arm/l~1': { density: 3 } };
const OUT = 'evidence/structure-shape.json';

/**
 * Records draft `id`; its parts (and the rig outputs a mesh verdict lists) are the ones `verdict` reviewed
 * unless `input` (parts-relative path → bytes) names others. Outputs the verdict does not list are written `{}`.
 */
function draft(dir: string, id: string, config: JsonObject, input?: Record<string, string | Uint8Array>, verdict = EXAMPLE_VERDICT, retouch?: string): void {
  const root = `derived/drafts/${id}`;
  write(dir, `${root}/config.json`, JSON.stringify(config));
  if (input === undefined) writeReviewedInput(dir, root, verdict);
  else for (const [path, bytes] of Object.entries(input)) { mkdirSync(dirname(join(dir, root, 'input', path)), { recursive: true }); writeFileSync(join(dir, root, 'input', path), bytes); }
  for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) if (!existsSync(join(dir, root, 'out', name))) write(dir, `${root}/out/${name}`, '{}');
  writeFileSync(join(dir, `${root}/input/recomposite_rig.png`), readFileSync(join(dir, 'derived/parts/rig/recomposite_rig.png')));
  if (retouch !== undefined) {
    const source = join(locateParts(dir)!, 'src/config.ts');
    const manifestPath = `${root}/input/parts.json`;
    const manifest = JSON.parse(readFileSync(join(dir, manifestPath), 'utf8')) as JsonObject;
    const part = obj(arr(manifest.parts)[0]);
    const image = `${root}/input/parts/${String(part.name)}.png`;
    const before = readFileSync(join(dir, image));
    const edited = Buffer.concat([before, Buffer.from(retouch)]);
    const file = `${String(part.name)}.png`;
    const receipt = { part: part.name!, file, from_sha256: sha(before), sha256: sha(edited),
      editor: 'Scripts and an image tool; retouched against the painting reference.' };
    const editedDir = '../../../inputs/retouched';
    config.assemble = { edited_parts: { dir: editedDir, receipts: [receipt] } };
    part.provenance = { edited_part: { edit: 'edited_parts[0]', dir: editedDir, receipt,
      changed_px: 1, changed_counted_px: 1, changed_excluded_px: 0, removed_opaque_px: 0 } };
    write(dir, `${root}/config.json`, JSON.stringify(config));
    write(dir, manifestPath, JSON.stringify(manifest));
    mkdirSync(join(dir, 'inputs/retouched'), { recursive: true });
    writeFileSync(join(dir, 'inputs/retouched', file), edited);
    writeFileSync(join(dir, image), edited);
    // Synthetic consumer fixture: declare the exact #1281 at, not the directory.
    write(dir, 'node_modules/@rig-c/parts/package.json', JSON.stringify({ name: '@rig-c/parts', version: '0.0.0-synthetic', type: 'module' }));
    write(dir, 'node_modules/@rig-c/parts/src/config.ts', `export * from ${JSON.stringify(source)};
export function configFileReferences() { return [{ at: 'assemble.edited_parts.receipts[0].file', value: ${JSON.stringify(`${editedDir}/${file}`)} }]; }
`);
  }
  seedRetainedDraft([id, dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/input`], testClock.now());
}

/** A new-order project at parts-review with the labelled draft `shape` recorded, as in tests/structure.test.ts. */
function setup(retouch?: string): string {
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
  plantLegacyReopen(dir, 'plan-approved', { by: 'owner', wordsFile: words });
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
  draft(dir, 'shape', { meshes: MESHES, bones: { root: {} } }, undefined, EXAMPLE_VERDICT, retouch);
  recordPartsReceipt(dir, 'shape', testClock.now());
  diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT,
    '--component', 'p10-n3=in-painting:synthetic', '--component', 'p1000-n3=in-painting:synthetic', '--by', 'agent']);
  return dir;
}

const snapshot = (dir: string): { stdout: string; exit: number } =>
  structureSnapshotCommand([dir, '--draft', 'shape', '--out', OUT]);
const partsSign = (dir: string, structure = OUT): { exit: number } => {
  seedStoredPartsSignoff(dir, 'shape', {
    by: 'owner',
    at: testClock.now(),
    verbatim: readFileSync(join(dir, 'words.txt'), 'utf8'),
    structureFile: structure,
  });
  return { exit: 0 };
};

test('#543 an exact edited set with the current accepted parts verdict signs and reaches rigging-interview', () => {
  const dir = setup('synthetic retouch A');
  const bound = obj(arr(read(dir).drafts)[0]);
  expect(arr(bound.config_inputs)).toHaveLength(1);
  expect(snapshot(dir).exit).toBe(0);
  expect(partsSign(dir).exit).toBe(0);
  expect(advanceCommand(['rigging-interview', dir]).exit).toBe(0);
  expect(read(dir).stage).toBe('rigging-interview');
  expect(checkProject(dir).refusals.map(f => f.code)).not.toContain('DRAFT_EDITED_PART_UNBOUND');
});

test('#543 receipts without an owner verdict do not sign the edited set', () => {
  const dir = setup('synthetic retouch A');
  const project = read(dir);
  project.review_acts = arr(project.review_acts).filter(raw => obj(raw).draft_id !== 'shape');
  write(dir, 'project.json', JSON.stringify(project));
  const before = readFileSync(join(dir, 'project.json'));
  expect(snapshot(dir).exit).toBe(0);
  refused(() => partsSign(dir), 'PARTS_VERDICT_RECEIPT_REQUIRED');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  expect(existsSync(join(dir, OUT))).toBe(true);
});

test('#543 a newer changes-requested verdict keeps the edited set from signing', () => {
  const dir = setup('synthetic retouch A');
  recordPartsReceipt(dir, 'shape', testClock.now() + 1, 'changes-requested');
  const before = readFileSync(join(dir, 'project.json'));
  expect(snapshot(dir).exit).toBe(0);
  refused(() => partsSign(dir), 'PARTS_VERDICT_LATEST_NOT_APPROVED');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('#543 an accepted verdict for one edited set cannot be recorded for a draft binding different shas', () => {
  const dir = setup('synthetic retouch A');
  const project = read(dir);
  const receipt = arr(project.review_acts).map(obj).find(raw => raw.draft_id === 'shape')!;
  const response = readFileSync(join(dir, String(obj(receipt.evidence).path)));
  const first = obj(arr(project.drafts)[0]);
  // The fixture chooses the producer's first part; no part-name mapping enters create.
  const manifest = JSON.parse(readFileSync(join(dir, String(obj(first.parts).path), 'parts.json'), 'utf8')) as JsonObject;
  const file = `${String(obj(arr(manifest.parts)[0]).name)}.png`;
  const original = readFileSync(join(dir, 'inputs/retouched', file));
  // The second set lives in a distinct project so the first set is never overwritten.
  const other = setup('synthetic retouch B');
  expect(obj(arr(obj(arr(read(other).drafts)[0]).config_inputs)[0]).sha256)
    .not.toBe(obj(arr(first.config_inputs)[0]).sha256);
  const unsigned = read(other);
  unsigned.review_acts = arr(unsigned.review_acts).filter(raw => obj(raw).draft_id !== 'shape');
  write(other, 'project.json', JSON.stringify(unsigned));
  const before = readFileSync(join(other, 'project.json'));
  refused(() => assertPartsReadDraft(other, read(other), decodePartsRead(response), 'shape'), 'PARTS_VERDICT_DRAFT_MISMATCH');
  expect(main(['parts-review', other, '--draft', 'shape', '--from-review-cli', '--by', 'owner', '--', 'synthetic-review'])).toBe(2);
  expect(snapshot(other).exit).toBe(0);
  refused(() => partsSign(other), 'PARTS_VERDICT_RECEIPT_REQUIRED');
  expect(readFileSync(join(other, 'project.json'))).toEqual(before);
  expect(readFileSync(join(dir, 'inputs/retouched', file))).toEqual(original);
});

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
  expect(structureSnapshotCommand([dir, '--draft', 'plain']).exit).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, 'evidence/structure-plain.json'), 'utf8')).entries).toEqual([]);
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
  ['an unknown draft id', 'STRUCTURE_SNAPSHOT_DRAFT_UNKNOWN', (): string[] => ['--draft', 'missing', '--out', OUT]],
  ['a draft config changed since it was recorded', 'STRUCTURE_SNAPSHOT_CONFIG_CHANGED', (dir: string): string[] => {
    write(dir, 'derived/drafts/shape/config.json', JSON.stringify({ meshes: { torso: { density: 9 } } }));
    return ['--draft', 'shape', '--out', OUT];
  }],
  ['meshes that are not an object of declarations', 'STRUCTURE_DECISIONS_INVALID', (dir: string): string[] => {
    draft(dir, 'odd', { meshes: [{ density: 3 }] });
    recordPartsReceipt(dir, 'odd', testClock.now());
    return ['--draft', 'odd', '--out', 'evidence/structure-odd.json'];
  }],
  ['--out that partsStructureSnapshot will not read for this draft', 'STRUCTURE_SNAPSHOT_OUT_UNREAD', (): string[] => ['--draft', 'shape', '--out', 'evidence/structure-decisions.json']],
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
  expect(refused(() => structureSnapshotCommand([dir]), 'STRUCTURE_SNAPSHOT_USAGE').exitCode).toBe(2);
  refused(() => structureSnapshotCommand([dir, '--draft', 'shape', '--draft', 'shape']), 'STRUCTURE_SNAPSHOT_USAGE');
  refused(() => structureSnapshotCommand([dir, '--draft', 'shape', '--out']), 'STRUCTURE_SNAPSHOT_USAGE');
  expect(main(['structure-snapshot', dir, '--out', OUT])).toBe(2);
  expect(existsSync(join(dir, OUT))).toBe(false);
});

test('omitting --out writes the default path partsStructureSnapshot reads, and wrong --out leaves project.json and target unchanged', () => {
  const dir = setup();
  const project = readFileSync(join(dir, 'project.json'));
  const wrongOut = 'evidence/structure-decisions.json';
  const err = refused(() => structureSnapshotCommand([dir, '--draft', 'shape', '--out', wrongOut]), 'STRUCTURE_SNAPSHOT_OUT_UNREAD');
  expect(err.message).toContain(OUT);
  expect(existsSync(join(dir, wrongOut))).toBe(false);
  expect(existsSync(join(dir, OUT))).toBe(false);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(project);
  expect(structureSnapshotCommand([dir, '--draft', 'shape']).exit).toBe(0);
  expect(existsSync(join(dir, OUT))).toBe(true);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(project);
});

test('a draft with no API receipt allows a snapshot but still refuses signoff without changing the record', () => {
  const dir = setup();
  draft(dir, 'other', { meshes: MESHES });
  const before = readFileSync(join(dir, 'project.json'));
  expect(structureSnapshotCommand([dir, '--draft', 'other']).exit).toBe(0);
  refused(() => signoffCommand(['parts-review', dir, '--by', 'user', '--draft', 'other', '--structure-file', 'evidence/structure-other.json']), 'NUMBERED_WRITER_REMOVED');
  refused(() => seedStoredPartsSignoff(dir, 'other', { by: 'user', at: testClock.now(), verbatim: 'Approve', structureFile: 'evidence/structure-other.json' }), 'PARTS_VERDICT_RECEIPT_REQUIRED');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  expect(existsSync(join(dir, 'evidence/structure-other.json'))).toBe(true);
});
