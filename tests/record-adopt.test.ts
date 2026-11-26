import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { CURRENT_RIG_MODEL, currentFileBinding, currentShapeFindings, outputSetHash, sha256, treeFiles, type CurrentKind } from '../src/current.ts';
import { OWNER_CHAT_SOURCE } from '../src/owner-chat.ts';
import { resolveAdoptSource } from '../src/record-adopt.ts';
import { recordCommand } from '../src/record.ts';
import { readTemplate, TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { tempDir } from './helpers.ts';

const at = '2026-10-01T00:00:00.000Z';
const now = Date.parse('2026-10-03T00:00:00.000Z');
const outputs = 'outputs/v4';
const build = `${outputs}/out/check/build`;
const frame = `${outputs}/idle/frames.json`;
const config = 'evidence/v4/registration/config-source.json';
const reportPath = 'evidence/v4/registration/check.json';

function fixture() {
  const dir = tempDir('record-adopt-');
  const write = (path: string, body: string): { path: string; sha256: string; bytes: number } => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
    return { path, sha256: sha256(body), bytes: Buffer.byteLength(body) };
  };
  const project = readTemplate('project.json');
  const save = (): void => { write('project.json', JSON.stringify(project)); };
  const original = (): Buffer => readFileSync(join(dir, 'project.json'));
  const record = (kind: CurrentKind, extra = ['--adopt']): JsonObject =>
    JSON.parse(recordCommand([kind, dir, ...extra, '--json'], now).stdout!) as JsonObject;
  const version = { n: 4, kind: 'rig', at, built_by: 'synthetic-builder', built_with: { '@rig-c/parts': '2.57.0', '@rig-c/core': '3.8.1' },
    registration: { config_source: write(config, '{}'), check_report: { ...write(reportPath, '{"spec":"rig-parts-check/1"}'), spec: 'rig-parts-check/1' } },
    outputs: [
      write(`${build}/skeleton.model.json`, '{"spec":"rigc-compiled/3"}'),
      write(`${build}/run.json`, '{"spec":"rigc-run/1","command":"build"}'),
      write(`${outputs}/out/rig/run.json`, '{"spec":"rig-run/1","command":"rig"}'),
      write(`${outputs}/out/parts.json`, '{}'),
      write(`${outputs}/out/parts/body.png`, 'synthetic part'),
      write(frame, '{"spec":"rigc-frames/1","sets":[{"animation":"idle"}]}'),
    ],
  };
  project.versions = [version];
  save();
  return { dir, project, version, write, save, original, record };
}

function postVersion(f: ReturnType<typeof fixture>, rigVersion = 4) {
  return { n: 7, kind: 'post', rig_version: rigVersion, at, built_by: f.version.built_by, built_with: f.version.built_with,
    outputs: [f.write('outputs/v7/compose/check/build/skeleton.model.json', '{"spec":"rigc-compiled/3"}')] };
}

function adoptDownstream() {
  const f = fixture();
  f.project.versions = [f.version, postVersion(f)];
  f.save();
  f.record('motion');
  f.record('direction');
  return f;
}

function staleOutputs(dir: string) {
  const { refusals, warnings } = checkProject(dir, undefined, { now });
  expect(refusals.map(f => f.code)).not.toContain('CURRENT_MALFORMED');
  return warnings.filter(f => f.code === 'OUTPUT_STALE');
}

test('adopts a sparse registered rig in place and omits its evidence-only report', () => {
  const f = fixture();
  const before = checkProject(f.dir, undefined, { now });
  const outputBytes = treeFiles(f.dir, outputs);
  const evidenceBytes = treeFiles(f.dir, 'evidence');
  const offer = resolveAdoptSource(f.project, 'rig');
  expect(offer).toMatchObject({ ok: true, version: 4 });
  const node = f.record('rig');
  expect(node).toMatchObject({
    at, built_by: f.version.built_by, built_with: f.version.built_with, adopted: { version: 4 },
    files: outputBytes.filter(file => file.path.startsWith(`${outputs}/out/rig/`) || file.path.startsWith(`${build}/`)),
    built_from: [{ path: config, sha256: f.version.registration.config_source.sha256 }],
    run: { path: `${outputs}/out/rig/run.json`, sha256: f.version.outputs[2]!.sha256 },
    rebuild: { recorded: false },
  });
  expect(node).not.toHaveProperty('report');
  expect(treeFiles(f.dir, outputs)).toEqual(outputBytes);
  expect(treeFiles(f.dir, 'evidence')).toEqual(evidenceBytes);
  expect(existsSync(join(f.dir, 'outputs/rig'))).toBe(false);
  const saved = JSON.parse(f.original().toString()) as JsonObject;
  expect(saved.versions).toEqual(f.project.versions);
  expect(checkProject(f.dir, undefined, { now }).refusals).toEqual(before.refusals);
  expect(currentFileBinding(saved, 'rig', `${build}/skeleton.model.json`))
    .toEqual({ path: `${build}/skeleton.model.json`, sha256: f.version.outputs[0]!.sha256 });
  const recorded = f.original();
  expect(resolveAdoptSource(saved, 'rig')).toMatchObject({ ok: false, code: 'RECORD_ADOPT_CURRENT_EXISTS' });
  expect(() => f.record('rig')).toThrow(expect.objectContaining({ code: 'RECORD_ADOPT_CURRENT_EXISTS' }));
  expect(f.original()).toEqual(recorded);
});

test('adopts each typed inventory and verifies post hashes before measuring absent byte counts', () => {
  const f = fixture();
  const { path, sha256: composeSha, bytes } = f.write('outputs/v5/compose/check/build/skeleton.model.json', '{"spec":"rigc-compiled/3"}');
  const direction = f.write('evidence/direction/v5.json', '{}');
  const scene = f.write('evidence/compose-src/v5/scene.json', '{}');
  const sourceOnly = [direction, scene].map(({ path, sha256 }) => ({ path, sha256 }));
  f.project.versions = [f.version, { n: 5, kind: 'post', rig_version: 4, at, built_by: 'synthetic-builder', built_with: { create: 'direction@3' },
    provenance: { direction: sourceOnly[0]! }, outputs: [{ path, sha256: composeSha }, ...sourceOnly] }];
  f.save();
  const parts = f.record('parts');
  expect(parts).toMatchObject({ adopted: { version: 4 }, files: f.version.outputs.slice(3, 5), built_from: [] });
  expect(parts).not.toHaveProperty('run');
  const motion = f.record('motion');
  expect(motion).toMatchObject({ adopted: { version: 4 }, files: [f.version.outputs[5]!], built_from: [] });
  const post = f.record('direction');
  expect(post).toMatchObject({ adopted: { version: 5 }, files: [{ path, sha256: composeSha, bytes }], built_from: [...sourceOnly].reverse() });
  expect(post.files_sha256).toBe(outputSetHash([{ path, sha256: composeSha }]));
  expect(existsSync(join(f.dir, 'outputs/direction'))).toBe(false);
  expect((JSON.parse(f.original().toString()) as JsonObject).versions).toEqual(f.project.versions);
});

test('offers only the latest live version of the applicable role and leaves failed writes byte-identical', () => {
  const f = fixture();
  const historical = { ...f.version, n: 21 };
  const newestLive = { ...f.version, n: 8, at: '2026-10-02T00:00:00.000Z', outputs: [] };
  f.project.reopens = [{ stage: 'rig-review', from_stage: 'rig-review', by: 'synthetic-owner',
    at: '2026-10-01T12:00:00.000Z', verbatim: 'Revisit the rig.', source: OWNER_CHAT_SOURCE,
    said_at: '2026-10-01T12:00:00.000Z', relayed_by: 'agent', steps_before: [] }];
  f.project.versions = [historical, newestLive];
  expect(resolveAdoptSource(f.project, 'rig')).toMatchObject({ ok: false, code: 'RECORD_ADOPT_SOURCE_MISSING', path: 'versions[v8].outputs' });
  f.project.versions = [historical];
  expect(resolveAdoptSource(f.project, 'rig')).toMatchObject({ ok: false, code: 'RECORD_ADOPT_SOURCE_MISSING', path: 'versions' });
  delete f.project.reopens;
  f.project.versions = [f.version, { ...newestLive, n: 5 }];
  f.save();
  const original = f.original();
  expect(() => f.record('rig')).toThrow(expect.objectContaining({ code: 'RECORD_ADOPT_SOURCE_MISSING' }));
  expect(() => f.record('rig', ['--adopt', '--from', 'outputs/rig.next'])).toThrow(expect.objectContaining({ code: 'RECORD_USAGE' }));
  expect(f.original()).toEqual(original);
});

test('refuses a changed file or symlink before writing and does not repair the legacy tree', () => {
  const f = fixture();
  const original = f.original();
  const receipt = `${outputs}/out/rig/run.json`;
  renameSync(join(f.dir, receipt), join(f.dir, `${receipt}.kept`));
  symlinkSync(join(f.dir, `${receipt}.kept`), join(f.dir, receipt));
  expect(() => f.record('rig')).toThrow(expect.objectContaining({ code: 'RECORD_ADOPT_SOURCE_INVALID' }));
  f.write(frame, 'different render bytes');
  expect(() => f.record('motion')).toThrow(expect.objectContaining({ code: 'RECORD_ADOPT_SOURCE_INVALID' }));
  expect(f.original()).toEqual(original);
  expect(readFileSync(join(f.dir, frame), 'utf8')).toBe('different render bytes');
});

test('check binds adopted paths and hashes to the cited version and keeps canonical shape strict', () => {
  const f = fixture();
  const rig = f.record('rig');
  const { adopted: _adopted, ...canonical } = rig;
  expect(currentShapeFindings('rig', canonical)).toContainEqual(expect.objectContaining({ code: 'CURRENT_MALFORMED', path: 'current.rig.report' }));
  const files = rig.files as { path: string; sha256: string; bytes: number }[];
  const changed = [{ ...files[0]!, sha256: sha256('another output') }, ...files.slice(1)];
  f.project.current = { rig: { ...rig, files: changed, files_sha256: outputSetHash(changed) } };
  expect(checkProject(f.dir, f.project, { now }).refusals).toContainEqual(expect.objectContaining({
    code: 'CURRENT_MALFORMED', path: 'current.rig.files[0]', message: expect.stringContaining('versions[v4].outputs'),
  }));
  const abbreviated = files.slice(0, -1);
  expect(currentShapeFindings('rig', { ...rig, files: abbreviated, files_sha256: outputSetHash(abbreviated) }, f.project))
    .toContainEqual(expect.objectContaining({ code: 'CURRENT_MALFORMED', path: 'current.rig.files', message: expect.stringContaining('versions[v4].outputs') }));
  expect(currentShapeFindings('rig', { ...rig, adopted: { version: 99 } }, f.project))
    .toContainEqual(expect.objectContaining({ code: 'CURRENT_MALFORMED', path: 'current.rig.adopted', message: expect.stringContaining('versions[v99].outputs') }));
});

test('adopted motion and direction can be current before any rig is adopted', () => {
  const f = adoptDownstream();
  expect((JSON.parse(f.original().toString()) as JsonObject).current).not.toHaveProperty('rig');
  expect(staleOutputs(f.dir)).toEqual([]);
});

test('adopted motion and direction stay current with a matching adopted rig', () => {
  const f = adoptDownstream();
  expect(f.record('rig').adopted).toEqual({ version: 4 });
  expect(staleOutputs(f.dir)).toEqual([]);
});

test('adopted motion and direction inherit staleness from their matching adopted rig', () => {
  const f = adoptDownstream();
  f.record('rig');
  f.write(config, '{"changed":true}');
  expect(staleOutputs(f.dir)).toEqual([
    expect.objectContaining({ path: 'current.rig', message: expect.stringContaining(config) }),
    expect.objectContaining({ path: 'current.motion', message: expect.stringContaining('upstream rig is stale') }),
    expect.objectContaining({ path: 'current.direction', message: expect.stringContaining('upstream rig is stale') }),
  ]);
});

test('rebuilding an adopted rig canonically stales adopted motion and direction while the legacy bytes survive', () => {
  const f = adoptDownstream();
  f.record('rig');
  const legacyFiles = treeFiles(f.dir, 'outputs');
  const producer = join(TEMPLATES_DIR, 'example-draft');
  const from = 'outputs/rig.next';
  const canonicalConfig = 'specs/rig/config.json';
  cpSync(join(producer, 'out'), join(f.dir, from), { recursive: true });
  f.write(canonicalConfig, readFileSync(join(producer, 'config.json'), 'utf8'));
  const model = readFileSync(join(f.dir, from, 'check/build/skeleton.model.json'));
  f.write(`${from}/check/check.json`, JSON.stringify({ spec: 'rig-parts-check/1', bar_outcomes: {}, build: { model_sha256: sha256(model) }, PASS: true }));
  const rig = f.record('rig', ['--from', from, '--config', canonicalConfig]);
  expect(rig).not.toHaveProperty('adopted');
  expect(treeFiles(f.dir, 'outputs').filter(file => file.path.startsWith('outputs/v'))).toEqual(legacyFiles);
  expect(staleOutputs(f.dir)).toEqual(['motion', 'direction'].map(kind => expect.objectContaining({
    path: `current.${kind}`, message: expect.stringContaining('requires upstream rig v4 (current.rig is canonical)'),
  })));
});

test.each([
  [4, ['current.motion', 'current.direction']],
  [6, ['current.motion']],
] as const)('a different adopted rig marks each dependent of v4 stale when the post names rig v%i', (rigVersion, paths) => {
  const f = fixture();
  expect(f.record('motion').adopted).toEqual({ version: 4 });
  f.project.current = (JSON.parse(f.original().toString()) as JsonObject).current!;
  const newerRig = { ...f.version, n: 6, outputs: [f.write('outputs/v6/out/check/build/skeleton.model.json', '{"spec":"rigc-compiled/3"}')] };
  f.project.versions = [f.version, newerRig, postVersion(f, rigVersion)];
  f.save();
  expect(f.record('rig').adopted).toEqual({ version: 6 });
  expect(f.record('direction').adopted).toEqual({ version: 7 });
  expect(staleOutputs(f.dir)).toEqual(paths.map(path => expect.objectContaining({
    path, message: expect.stringContaining('requires upstream rig v4 (current.rig is adopted from v6)'),
  })));
});

test('record motion --from clears adoption and leaves the original idle output available to history', () => {
  const f = fixture();
  f.record('motion');
  f.project.current = (JSON.parse(f.original().toString()) as JsonObject).current!;
  const model = f.write(CURRENT_RIG_MODEL, '{}');
  const run = f.write('outputs/rig/run.json', '{}');
  const report = f.write('outputs/rig/check/check.json', '{}');
  const rigFiles = treeFiles(f.dir, 'outputs/rig');
  (f.project.current as JsonObject).rig = {
    at, built_by: 'synthetic-builder', built_with: {}, files: rigFiles, files_sha256: outputSetHash(rigFiles), built_from: [],
    run: { path: run.path, sha256: run.sha256 }, report: { path: report.path, sha256: report.sha256 },
    rebuild: { recorded: false, note: 'Synthetic bare rig' },
  };
  f.save();
  const idle = treeFiles(f.dir, `${outputs}/idle`);
  const from = 'outputs/motion.next';
  f.write(`${from}/frames.json`, '{"spec":"rigc-frames/1","sets":[{"animation":"idle","fps":1}]}');
  const node = f.record('motion', ['--from', from]);
  expect(node).not.toHaveProperty('adopted');
  expect(node.built_from).toEqual([{ path: model.path, sha256: model.sha256 }]);
  expect(existsSync(join(f.dir, from))).toBe(false);
  expect(treeFiles(f.dir, `${outputs}/idle`)).toEqual(idle);
});
