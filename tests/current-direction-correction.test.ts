import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateCurrentDirectionCorrectionFixture } from '../scripts/generate-current-direction-correction-fixture.ts';
import type { Finding } from '../src/check.ts';
import { correctionApprovalFindings, currentDirectionIdentity } from '../src/corrections.ts';
import { COMPOSE_CHECK_PATH, COMPOSE_RUN_PATH, CURRENT_DIRECTION_PATH } from '../src/current-direction.ts';
import { sha256, treeFiles } from '../src/current.ts';
import { DIRECTION_CORRECTION_SPEC, directionPostIdentity } from '../src/direction.ts';
import { recordCommand } from '../src/record.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkCorrections, checkProject, correctionCommand, directionCommand, signoffCommand, testClock } from './clock.ts';
import { tempDir } from './helpers.ts';

afterEach(() => testClock.reset());

const FIXTURE_ROOT = join(import.meta.dir, 'fixtures/correction-current-direction');

function cloneFixture(at = '2026-11-26T09:10:00Z') {
  const dir = join(tempDir(), 'project');
  cpSync(FIXTURE_ROOT, dir, { recursive: true });
  testClock.set(new Date(at));
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const save = (project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return { dir, load, save };
}

function findings(dir: string, project?: JsonObject) {
  const ctx = { dir, project: project ?? JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject, refusals: [] as Finding[], warnings: [] as Finding[] };
  checkCorrections(ctx);
  return ctx;
}

function refusesByteIdentical(dir: string, code: string, exitCode: number, run: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  const files = readdirSync(dir, { recursive: true });
  expect(run).toThrow(expect.objectContaining({ code, exitCode }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  expect(readdirSync(dir, { recursive: true })).toEqual(files);
}

function restageAndRecordDirection(dir: string, intentFile: string, revision: number, writeAt: string, recordAt: string): void {
  testClock.set(new Date(writeAt));
  directionCommand(['write', dir, '--file', intentFile]);
  const composeStage = 'derived/compose-input';
  const directionFrom = 'outputs/direction.next';
  const partsScene = 'specs/direction/compose-scene.json';
  const backdropSha = sha256(readFileSync(join(dir, 'inputs/backdrop.png')));
  const model = JSON.stringify({
    spec: 'rigc-compiled/3',
    stage: { x: -32, y: 0, width: 64, height: 48 },
    animations: [{ name: 'idle', duration: 4 }],
    pages: [],
    synthetic_revision: revision,
  }, null, 2) + '\n';
  mkdirSync(join(dir, `${directionFrom}/check/build`), { recursive: true });
  writeFileSync(join(dir, `${directionFrom}/check/build/skeleton.model.json`), model);
  writeFileSync(join(dir, `${directionFrom}/${COMPOSE_CHECK_PATH}`), JSON.stringify({
    spec: 'rig-parts-check/1',
    PASS: true,
    gate_spine_html_green: true,
    build: { model_sha256: sha256(model) },
  }, null, 2) + '\n');
  writeFileSync(join(dir, `${directionFrom}/scene.json`), JSON.stringify({
    spec: 'spine-parts-scene-report/1',
    scene: partsScene,
    canvas: { width: 64, height: 48 },
    characters: [{ id: 'actor', build: `../../${composeStage}`, offset: [0, 0], scale: 1, rig_size: [64, 48], shift: [0, 0] }],
    plates: [{ name: 'backdrop', image: '../../inputs/backdrop.png', at: [0, 0], opaque_backdrop: true, sha256: backdropSha }],
  }, null, 2) + '\n');
  writeFileSync(join(dir, `${directionFrom}/${COMPOSE_RUN_PATH}`), JSON.stringify({
    spec: 'rig-compose-run/1',
    scene: { path: partsScene, sha256: sha256(readFileSync(join(dir, partsScene))) },
    characters: [{
      id: 'actor',
      build: `../../${composeStage}`,
      files: treeFiles(dir, composeStage).map(({ path, sha256: digest }) => ({
        path: path.slice(composeStage.length + 1),
        sha256: digest,
      })),
    }],
    plate: null,
    plates: [{ name: 'backdrop', path: '../../inputs/backdrop.png', sha256: backdropSha }],
  }, null, 2) + '\n');
  expect(recordCommand(['direction', dir, '--from', directionFrom, '--direction', CURRENT_DIRECTION_PATH], Date.parse(recordAt)).exit).toBe(0);
}

test('current-direction correction fixture reproduces byte-for-byte through writers and passes check', () => {
  const generated = generateCurrentDirectionCorrectionFixture(join(tempDir(), 'fresh'));
  for (const [path, bytes] of Object.entries(generated)) {
    const committed = join(FIXTURE_ROOT, path);
    expect(existsSync(committed)).toBe(true);
    expect(readFileSync(committed).equals(bytes)).toBe(true);
  }
  const f = cloneFixture();
  const project = f.load();
  const record = (project.corrections as JsonObject[])[0]!;
  expect(record.schema).toBe(DIRECTION_CORRECTION_SPEC);
  expect(record.on).toMatchObject({
    kind: 'current.direction',
    direction: { path: CURRENT_DIRECTION_PATH },
  });
  expect(record.outcome).toEqual(currentDirectionIdentity(project));
  expect((record.on as JsonObject).record_sha256).not.toBe((record.outcome as JsonObject).record_sha256);
  expect(((record.on as JsonObject).direction as JsonObject).sha256).not.toBe(((record.outcome as JsonObject).direction as JsonObject).sha256);
  expect(findings(f.dir)).toEqual({ dir: f.dir, project, refusals: [], warnings: [] });
});

test('recording without --version binds current.direction, gates direction-review signoff, and resolves after current.direction changes', () => {
  const f = cloneFixture('2026-11-26T09:10:00Z');
  const openingExpected = currentDirectionIdentity(f.load());
  const recorded = correctionCommand([
    'record', f.dir, '--id', 'second-pass', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'), '--json',
  ]);
  expect(recorded.exit).toBe(0);
  const openRecord = JSON.parse(recorded.stdout) as JsonObject;
  expect(openRecord.schema).toBe(DIRECTION_CORRECTION_SPEC);
  expect(openRecord.on).toEqual(openingExpected);
  expect(openRecord.outcome).toBeNull();
  expect(findings(f.dir).refusals).toEqual([]);
  expect(findings(f.dir).warnings.map(w => w.code)).toEqual(['CORRECTION_OPEN']);
  expect(correctionApprovalFindings(f.load(), 'direction-review').map(x => x.code)).toEqual(['CORRECTION_PENDING']);

  // Relaying a direction-review signoff while the correction is open refuses byte-identically.
  writeFileSync(join(f.dir, 'approve.txt'), 'Approve the current direction.\n');
  testClock.set(new Date('2026-11-26T09:11:00Z'));
  refusesByteIdentical(f.dir, 'CORRECTION_PENDING', 1, () => signoffCommand([
    'direction-review', f.dir, '--by', 'owner', '--owner-chat', join(f.dir, 'approve.txt'),
    '--said-at', '2026-11-26T09:10:30Z', '--relayed-by', 'operator',
  ]));

  // Resolving before current.direction changes refuses with CORRECTION_OUTCOME and leaves project.json byte-identical.
  testClock.set(new Date('2026-11-26T09:12:00Z'));
  refusesByteIdentical(f.dir, 'CORRECTION_OUTCOME', 1, () => correctionCommand([
    'resolve', 'second-pass', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'),
  ]));

  // Re-recording the exact same direction spec without changing its sha256 also cannot resolve the correction.
  expect(recordCommand(['direction', f.dir, '--from', 'outputs/direction', '--direction', CURRENT_DIRECTION_PATH], Date.parse('2026-11-26T09:13:00Z')).exit).toBe(0);
  testClock.set(new Date('2026-11-26T09:14:00Z'));
  refusesByteIdentical(f.dir, 'CORRECTION_OUTCOME', 1, () => correctionCommand([
    'resolve', 'second-pass', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'),
  ]));

  // Updating current.direction with a changed direction spec allows resolve without --version, and a further rebuild keeps earlier records valid.
  restageAndRecordDirection(f.dir, 'evidence/intent-initial.json', 3, '2026-11-26T09:15:00Z', '2026-11-26T09:16:00Z');
  const closingExpected = currentDirectionIdentity(f.load());
  testClock.set(new Date('2026-11-26T09:17:00Z'));
  const resolved = correctionCommand([
    'resolve', 'second-pass', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'), '--json',
  ]);
  expect(resolved.exit).toBe(0);
  const closedRecord = JSON.parse(resolved.stdout) as JsonObject;
  expect(closedRecord.outcome).toEqual(closingExpected);
  expect(findings(f.dir).refusals).toEqual([]);
  expect(findings(f.dir).warnings).toEqual([]);

  // A subsequent rebuild of current.direction preserves both earlier closed corrections without refusal.
  restageAndRecordDirection(f.dir, 'evidence/intent-revised.json', 4, '2026-11-26T09:18:00Z', '2026-11-26T09:19:00Z');
  expect(findings(f.dir).refusals).toEqual([]);
  expect(findings(f.dir).warnings).toEqual([]);

  // Owner chat signoff now succeeds.
  testClock.set(new Date('2026-11-26T09:20:00Z'));
  expect(signoffCommand([
    'direction-review', f.dir, '--by', 'owner', '--owner-chat', join(f.dir, 'approve.txt'),
    '--said-at', '2026-11-26T09:19:30Z', '--relayed-by', 'operator',
  ]).exit).toBe(0);
  expect(findings(f.dir).refusals).toEqual([]);
});

test('missing, malformed or spec-unbound current.direction and invalid flag combinations refuse byte-identically', () => {
  const f = cloneFixture('2026-11-26T09:10:00Z');

  // --model-file without --version is a usage refusal (exit 2).
  refusesByteIdentical(f.dir, 'CORRECTION_USAGE', 2, () => correctionCommand([
    'record', f.dir, '--id', 'bad-flag', '--path', 'described', '--stage', 'direction-review',
    '--model-file', 'outputs/direction/check/build/skeleton.model.json', '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]));

  // Omitting selector flags on rig-review or made path remains a usage refusal (exit 2).
  refusesByteIdentical(f.dir, 'CORRECTION_USAGE', 2, () => correctionCommand([
    'record', f.dir, '--id', 'rig-missing-selector', '--path', 'described', '--stage', 'rig-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]));

  // Passing --version or --model-file when resolving a current.direction correction is a usage refusal (exit 2).
  correctionCommand([
    'record', f.dir, '--id', 'open-current', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]);
  for (const extra of [['--version', '1'], ['--model-file', 'outputs/direction/check/build/skeleton.model.json'], ['--draft', 'd1']]) {
    refusesByteIdentical(f.dir, 'CORRECTION_USAGE', 2, () => correctionCommand([
      'resolve', 'open-current', f.dir, ...extra, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'),
    ]));
  }

  // Missing current.direction refuses record with CORRECTION_SOURCE and resolve with CORRECTION_OUTCOME.
  const withoutDirection = f.load();
  withoutDirection.corrections = [];
  delete (withoutDirection.current as JsonObject).direction;
  f.save(withoutDirection);
  refusesByteIdentical(f.dir, 'CORRECTION_SOURCE', 1, () => correctionCommand([
    'record', f.dir, '--id', 'no-current', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]));

  // Unbound specs/direction/direction.json in current.direction.built_from refuses before writing.
  const restored = cloneFixture('2026-11-26T09:10:00Z');
  const missingSpec = restored.load();
  missingSpec.corrections = [];
  const dirNode = (missingSpec.current as JsonObject).direction as JsonObject;
  dirNode.built_from = (dirNode.built_from as JsonObject[]).filter(row => row.path !== CURRENT_DIRECTION_PATH);
  restored.save(missingSpec);
  refusesByteIdentical(restored.dir, 'CORRECTION_SOURCE', 1, () => correctionCommand([
    'record', restored.dir, '--id', 'unbound-spec', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(restored.dir, 'words.txt'),
  ]));
});

test('check refuses tampered on or outcome hashes and schema downgrades on current.direction records', () => {
  const f = cloneFixture('2026-11-26T09:10:00Z');
  correctionCommand([
    'record', f.dir, '--id', 'tamper-open', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]);

  // One-byte edits to open record_sha256 or direction.sha256 refuse with DIRECTION_CORRECTION_OUTCOME.
  for (const mutate of [
    (on: JsonObject) => { const h = String(on.record_sha256); on.record_sha256 = (h[0] === '0' ? '1' : '0') + h.slice(1); },
    (on: JsonObject) => { const d = on.direction as JsonObject; const h = String(d.sha256); d.sha256 = (h[0] === '0' ? '1' : '0') + h.slice(1); },
    (on: JsonObject) => { (on.direction as JsonObject).path = 'specs/direction/other.json'; },
  ]) {
    const candidate = f.load();
    mutate((candidate.corrections as JsonObject[]).at(-1)!.on as JsonObject);
    expect(findings(f.dir, candidate).refusals.map(r => r.code)).toContain('DIRECTION_CORRECTION_OUTCOME');
  }

  // One-byte edits to closed outcome record_sha256 or direction.sha256 also refuse with DIRECTION_CORRECTION_OUTCOME.
  for (const mutate of [
    (outcome: JsonObject) => { const h = String(outcome.record_sha256); outcome.record_sha256 = (h[0] === '0' ? '1' : '0') + h.slice(1); },
    (outcome: JsonObject) => { const d = outcome.direction as JsonObject; const h = String(d.sha256); d.sha256 = (h[0] === '0' ? '1' : '0') + h.slice(1); },
  ]) {
    const candidate = f.load();
    mutate((candidate.corrections as JsonObject[])[0]!.outcome as JsonObject);
    expect(findings(f.dir, candidate).refusals.map(r => r.code)).toContain('DIRECTION_CORRECTION_OUTCOME');
  }

  // Downgrading a current.direction correction to @1 refuses with CORRECTION_MALFORMED.
  const downgraded = f.load();
  (downgraded.corrections as JsonObject[]).at(-1)!.schema = 'rig-create/correction@1';
  expect(findings(f.dir, downgraded).refusals.map(r => r.code)).toContain('CORRECTION_MALFORMED');
});

test('adopted current.direction binds its legacy direction document on record and resolves against canonical current.direction; --version keeps working', () => {
  const dir = join(tempDir(), 'adopted');
  cpSync(join(import.meta.dir, '../templates/example-numbered/example-direction'), dir, { recursive: true });
  // Keep --version working unchanged on numbered posts.
  testClock.set(new Date('2026-11-06T10:00:00Z'));
  const numbered = correctionCommand([
    'record', dir, '--id', 'legacy-versioned', '--path', 'described', '--stage', 'direction-review',
    '--version', '3', '--by', 'user', '--verbatim-file', join(dir, 'words.txt'), '--json',
  ]);
  expect(numbered.exit).toBe(0);
  const p0 = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  expect(JSON.parse(numbered.stdout).on).toEqual(directionPostIdentity(dir, p0, 3));
  testClock.set(new Date('2026-11-06T10:05:00Z'));
  expect(directionCommand(['write', '4', dir, '--file', 'evidence/input.json', '--rig', '1']).exit).toBe(0);
  testClock.set(new Date('2026-11-06T10:10:00Z'));
  expect(correctionCommand([
    'resolve', 'legacy-versioned', dir, '--version', '4', '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt'),
  ]).exit).toBe(0);

  // Adopt direction in place on a synthetic composed post, record a correction without --version, then rebuild canonical current.direction and resolve.
  const f = cloneFixture('2026-11-26T09:10:00Z');
  const project = f.load();
  const canonicalDirection = structuredClone((project.current as JsonObject).direction as JsonObject);
  const v4DocPath = 'evidence/direction/v4.json';
  mkdirSync(dirname(join(f.dir, v4DocPath)), { recursive: true });
  writeFileSync(join(f.dir, v4DocPath), '{"synthetic":"legacy direction v4"}\n');
  const v4Sha = sha256(readFileSync(join(f.dir, v4DocPath)));
  const composeFilePath = 'outputs/v4/compose/scene.json';
  mkdirSync(dirname(join(f.dir, composeFilePath)), { recursive: true });
  const composeBytes = Buffer.from('{"spec":"spine-parts-scene-report/1"}\n');
  writeFileSync(join(f.dir, composeFilePath), composeBytes);
  const composeSha = sha256(composeBytes);
  project.versions = [{
    n: 4,
    kind: 'post',
    rig_version: 1,
    at: '2026-11-26T08:30:00.000Z',
    built_by: 'agent',
    built_with: { create: 'direction@3' },
    outputs: [
      { path: v4DocPath, sha256: v4Sha },
      { path: composeFilePath, sha256: composeSha, bytes: composeBytes.length },
    ],
    provenance: { config: { path: v4DocPath, sha256: v4Sha }, direction: { path: v4DocPath, sha256: v4Sha }, sections: {} },
  }];
  project.corrections = [];
  delete (project.current as JsonObject).direction;
  f.save(project);

  expect(recordCommand(['direction', f.dir, '--adopt'], Date.parse('2026-11-26T09:11:00Z')).exit).toBe(0);
  testClock.set(new Date('2026-11-26T09:12:00Z'));
  const adoptedRecord = correctionCommand([
    'record', f.dir, '--id', 'from-adopted', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'), '--json',
  ]);
  expect(adoptedRecord.exit).toBe(0);
  expect((JSON.parse(adoptedRecord.stdout) as JsonObject).on).toMatchObject({
    kind: 'current.direction',
    direction: { path: v4DocPath, sha256: v4Sha },
  });

  // Replace adopted current.direction with a fresh canonical current.direction and resolve without --version.
  const afterAdopt = f.load();
  afterAdopt.versions = [];
  (afterAdopt.current as JsonObject).direction = { ...canonicalDirection, at: '2026-11-26T09:15:00.000Z' };
  f.save(afterAdopt);
  testClock.set(new Date('2026-11-26T09:16:00Z'));
  expect(correctionCommand([
    'resolve', 'from-adopted', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'),
  ]).exit).toBe(0);
  expect(findings(f.dir).refusals).toEqual([]);
  expect(findings(f.dir).warnings).toEqual([]);
  expect(checkProject(f.dir).refusals.filter(r => r.path.startsWith('corrections') || r.path.startsWith('current') || r.path.startsWith('signoffs'))).toEqual([]);
});
