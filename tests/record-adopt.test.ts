import { expect, spyOn, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';
import { asArray, checkProject, formatReport, isObject, type CheckReport } from '../src/check.ts';
import { CURRENT_RIG_MODEL, currentFileBinding, currentFindings, currentHash, currentMotionSetBinding, currentRigFileBinding, currentShapeFindings, legacyMotionProvenance, outputSetHash, sha256, treeFiles, verifiedLegacyMotionProvenance, type CurrentKind } from '../src/current.ts';
import { type OpenDirectionComment } from '../src/feedback.ts';
import { seedStoredVerdict } from './historical-review-fixture.ts';
import { interviewCommand } from '../src/interview.ts';
import { nextCommand, type NextReport } from '../src/next.ts';
import { OWNER_CHAT_SOURCE } from '../src/owner-chat.ts';
import { resolveAdoptSource } from '../src/record-adopt.ts';
import { recordCommand } from '../src/record.ts';
import { readTemplate, TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { fixture as exampleFixture } from './fixtures.ts';
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

function acceptedLegacyFixture() {
  const f = fixture();
  const frames = f.write(frame, JSON.stringify({ spec: 'rigc-frames/1', sets: [{ animation: 'idle', dir: 'idle@1fps', fps: 1, written: 1 }] }));
  const png = f.write(`${outputs}/idle/idle@1fps/f0000.png`, 'synthetic frame');
  const receipt = f.write(`${outputs}/idle/render-run.json`, '{}');
  const registration = { ...f.version.registration, kind: 'frozen-rig/1', idle: { path: frames.path, sha256: frames.sha256 } };
  const verdicts = [{ by: 'synthetic-owner', at, review: 'rig-review', verdict: 'accepted', verbatim: 'Synthetic acceptance.', source: 'synthetic', on_items: [] }];
  const version = { ...f.version, registration, verdicts, outputs: [...f.version.outputs.slice(0, -1), frames, png, receipt] };
  f.project.versions = [version];
  f.save();
  const load = (): JsonObject => JSON.parse(f.original().toString()) as JsonObject;
  return { ...f, version, frames, png, receipt, load };
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

function stagedRig(f: ReturnType<typeof fixture>) {
  const producer = join(TEMPLATES_DIR, 'example-draft');
  const from = 'outputs/rig.next';
  const canonicalConfig = 'specs/rig/config.json';
  cpSync(join(producer, 'out'), join(f.dir, from), { recursive: true });
  const configBytes = readFileSync(join(producer, 'config.json'), 'utf8');
  f.write(canonicalConfig, configBytes);
  const model = readFileSync(join(f.dir, from, 'check/build/skeleton.model.json'), 'utf8');
  f.write(`${from}/check/check.json`, JSON.stringify({ spec: 'rig-parts-check/1', bar_outcomes: {}, build: { model_sha256: sha256(model) }, PASS: true }));
  return { from, configBytes, model, args: ['--from', from, '--config', canonicalConfig] };
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
  expect(currentRigFileBinding(saved, 'check/build/skeleton.model.json'))
    .toEqual({ path: `${build}/skeleton.model.json`, sha256: f.version.outputs[0]!.sha256 });
  expect(currentRigFileBinding(saved, '../parts.json')).toBeUndefined();
  const recorded = f.original();
  expect(resolveAdoptSource(saved, 'rig')).toMatchObject({ ok: false, code: 'RECORD_ADOPT_CURRENT_EXISTS' });
  expect(() => f.record('rig')).toThrow(expect.objectContaining({ code: 'RECORD_ADOPT_CURRENT_EXISTS' }));
  expect(f.original()).toEqual(recorded);
});

test('first manual adoption emits a notice before writing and keeps JSON stdout parseable', () => {
  const f = fixture();
  const original = f.original();
  expect(f.project.current).toBeUndefined();
  const receipts: { notice: string; record: Buffer }[] = [];
  const stderr = spyOn(process.stderr, 'write').mockImplementation(chunk => {
    receipts.push({ notice: String(chunk), record: f.original() });
    return true;
  });
  try {
    const run = join(f.dir, outputs, 'out/rig/run.json');
    renameSync(run, `${run}.kept`);
    expect(() => f.record('rig')).toThrow(expect.objectContaining({ code: 'RECORD_ADOPT_SOURCE_INVALID' }));
    expect(receipts).toEqual([]);
    expect(f.original()).toEqual(original);
    renameSync(`${run}.kept`, run);

    const rig = f.record('rig');
    expect(receipts).toEqual([{ notice: expect.stringMatching(/numbered verdict moves.*sign off.*rebuild.*record <kind> --from/), record: original }]);
    expect(JSON.parse(f.original().toString()).current.rig).toEqual(rig);

    const motion = f.record('motion');
    expect(JSON.parse(f.original().toString()).current).toEqual({ rig, motion });
    expect(receipts).toHaveLength(1);
  } finally { stderr.mockRestore(); }
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

test('adopts accepted co-registered motion with a normalized attestation and preserves frozen bytes', () => {
  const f = acceptedLegacyFixture();
  const inventory = treeFiles(f.dir, `${outputs}/idle`);
  const normalized = outputSetHash(inventory.map(file => ({ ...file, path: file.path.replace(`${outputs}/idle/`, 'outputs/motion/') })));
  const motion = f.record('motion');
  const provenance = { kind: 'legacy-co-registration', version: 4, registration: 'versions[v4].registration',
    model_sha256: f.version.outputs[0]!.sha256, frames_sha256: f.frames.sha256, files_sha256: normalized };
  expect(motion.provenance).toEqual(provenance);
  expect(motion.files_sha256).toBe(outputSetHash(inventory));
  expect(motion.files_sha256).not.toBe(normalized);
  const project = f.load();
  expect(legacyMotionProvenance(project)).toEqual(provenance);
  expect(verifiedLegacyMotionProvenance(f.dir, project)).toEqual(provenance);
  const report = checkProject(f.dir, project, { now });
  expect(report.current_motion_provenance).toEqual(provenance);
  expect(formatReport(report)).toContain('INFO CURRENT_MOTION_PROVENANCE_VERIFIED');
  expect(currentMotionSetBinding(f.dir, project)).toEqual({ path: `${outputs}/idle`, sha256: normalized });
  expect(currentHash(f.dir, `${outputs}/idle`)).toBe(normalized);
  expect(treeFiles(f.dir, `${outputs}/idle`)).toEqual(inventory);
  expect(existsSync(join(f.dir, 'outputs/motion'))).toBe(false);

  f.write(f.receipt.path, 'changed run receipt');
  expect(currentHash(f.dir, `${outputs}/idle`)).toBe(normalized);
  expect(currentMotionSetBinding(f.dir, project)).toBeUndefined();
  expect(checkProject(f.dir, project, { now }).refusals).toContainEqual(expect.objectContaining({ code: 'CURRENT_MOTION_PROVENANCE_INVALID' }));
  f.write(f.receipt.path, '{}');
  f.write(f.png.path, 'changed frame');
  expect(currentHash(f.dir, `${outputs}/idle`)).not.toBe(normalized);
  expect(verifiedLegacyMotionProvenance(f.dir, project)).toBeUndefined();
});

test('derives compatible old motion and backfills provenance once without changing bindings or output bytes', () => {
  const f = acceptedLegacyFixture();
  const motion = f.record('motion');
  const { provenance, ...oldMotion } = motion;
  f.project.current = { motion: oldMotion };
  f.save();
  const legacyBytes = treeFiles(f.dir, outputs);
  const oldCheck = checkProject(f.dir, undefined, { now });
  expect(oldCheck.current_motion_provenance).toEqual(provenance as JsonObject);
  expect(f.record('motion')).toEqual(motion);
  const backfilled = f.original();
  expect(f.record('motion')).toEqual(motion);
  expect(f.original()).toEqual(backfilled);
  expect(treeFiles(f.dir, outputs)).toEqual(legacyBytes);
  const newCheck = checkProject(f.dir, undefined, { now });
  expect(newCheck.refusals).toEqual(oldCheck.refusals);
  expect(newCheck.warnings).toEqual(oldCheck.warnings);
});

test.each(['no-acceptance', 'wrong-idle-binding', 'incomplete-sidecar'] as const)('retains old motion adoption behavior when legacy provenance is ineligible (%s)', defect => {
  const f = acceptedLegacyFixture();
  if (defect === 'no-acceptance') f.version.verdicts = [];
  if (defect === 'wrong-idle-binding') f.version.registration.idle.sha256 = '0'.repeat(64);
  if (defect === 'incomplete-sidecar') {
    const frames = f.write(frame, '{"spec":"rigc-frames/1","sets":[{"animation":"idle","dir":"idle@1fps","fps":1,"written":2}]}');
    f.version.registration.idle.sha256 = frames.sha256;
    f.version.outputs = f.version.outputs.map(file => file.path === frames.path ? frames : file);
  }
  f.save();
  const motion = f.record('motion');
  expect(motion.provenance).toBeUndefined();
  const project = f.load();
  if (defect !== 'incomplete-sidecar') expect(legacyMotionProvenance(project)).toBeUndefined();
  expect(verifiedLegacyMotionProvenance(f.dir, project)).toBeUndefined();
  const report = checkProject(f.dir, project, { now });
  expect(report.current_motion_provenance).toBeUndefined();
  expect(report.refusals.map(finding => finding.code)).not.toContain('CURRENT_MOTION_PROVENANCE_INVALID');
  const saved = f.original();
  expect(() => f.record('motion')).toThrow(expect.objectContaining({ code: 'RECORD_ADOPT_CURRENT_EXISTS' }));
  expect(f.original()).toEqual(saved);
});

test('explicit motion provenance is closed and must use the normalized digest', () => {
  const f = acceptedLegacyFixture();
  const motion = f.record('motion');
  const provenance = motion.provenance as JsonObject;
  const project = f.load();
  for (const invalid of [null, { ...provenance, extra: true }, { ...provenance, files_sha256: motion.files_sha256! }, { ...provenance, registration: 'versions[v5].registration' }]) {
    expect(currentShapeFindings('motion', { ...motion, provenance: invalid }, project)).toContainEqual(expect.objectContaining({
      code: 'CURRENT_MOTION_PROVENANCE_INVALID', path: 'current.motion.provenance',
    }));
  }
});

test('an adopted motion root propagates staleness by its frame set and through its adopted rig', () => {
  const f = acceptedLegacyFixture();
  f.project.versions = [f.version, postVersion(f)];
  f.save();
  f.record('rig');
  f.record('motion');
  const direction = f.record('direction');
  const project = f.load();
  const motion = currentMotionSetBinding(f.dir, project)!;
  (project.current as JsonObject).direction = { ...direction, built_from: [motion] };
  const stale = () => {
    const warnings: CheckReport['warnings'] = [];
    currentFindings(f.dir, project, warnings);
    return warnings.filter(finding => finding.code === 'OUTPUT_STALE');
  };
  expect(stale()).toEqual([]);
  f.write(config, '{"changed":true}');
  // Remove the numbered post's direct rig dependency to exercise propagation through built_from.
  (project.versions as JsonObject[])[1]!.rig_version = null;
  expect(stale()).toContainEqual(expect.objectContaining({ path: 'current.direction', message: expect.stringContaining('upstream motion is stale') }));
  f.write(config, '{}');
  f.write(f.png.path, 'different frame');
  expect(stale()).toContainEqual(expect.objectContaining({ path: 'current.direction', message: expect.stringContaining(`${motion.path} now hashes`) }));
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
  const rig = f.record('rig', stagedRig(f).args);
  expect(rig).not.toHaveProperty('adopted');
  expect(treeFiles(f.dir, 'outputs').filter(file => file.path.startsWith('outputs/v'))).toEqual(legacyFiles);
  expect(staleOutputs(f.dir)).toEqual(['motion', 'direction'].map(kind => expect.objectContaining({
    path: `current.${kind}`, message: expect.stringContaining('requires upstream rig v4 (current.rig is canonical)'),
  })));
});

test.each(['model', 'atlas', 'atlas page'] as const)('refuses changed accepted adopted rig %s bytes on the same recorded config', changed => {
  const f = acceptedLegacyFixture();
  const staged = stagedRig(f);
  f.version.registration.config_source = f.write(config, staged.configBytes);
  if (changed !== 'model') {
    f.version.outputs[0] = f.write(`${build}/skeleton.model.json`, staged.model);
    const filename = changed === 'atlas' ? 'skeleton.atlas' : 'skeleton.png';
    f.version.outputs.push(f.write(`${build}/${filename}`, 'different atlas bytes'));
  }
  f.save();
  f.record('rig');
  const original = f.original();
  const legacy = treeFiles(f.dir, outputs);
  const pending = treeFiles(f.dir, staged.from);
  expect(() => f.record('rig', staged.args)).toThrow(expect.objectContaining({ code: 'RECORD_ADOPTED_RIG_OUTPUT_CHANGED' }));
  expect(f.original()).toEqual(original);
  expect(treeFiles(f.dir, outputs)).toEqual(legacy);
  expect(treeFiles(f.dir, staged.from)).toEqual(pending);
  expect(existsSync(join(f.dir, 'outputs/rig'))).toBe(false);
});

test('warns when changed recorded input replaces accepted adopted rig bytes', () => {
  const f = acceptedLegacyFixture();
  f.record('rig');
  f.record('motion');
  const legacy = treeFiles(f.dir, outputs);
  const result = recordCommand(['rig', f.dir, ...stagedRig(f).args, '--json'], now);
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain(`rig-create: WARN RECORD_ADOPTED_RIG_INPUT_CHANGED: current.rig.files: replacement of accepted v4 changes check/build/skeleton.model.json after recorded inputs changed at ${config} -> specs/rig/config.json`);
  expect(currentRigFileBinding(f.load(), 'check/build/skeleton.model.json')?.path).toBe(CURRENT_RIG_MODEL);
  expect(treeFiles(f.dir, outputs)).toEqual(legacy);
  expect(staleOutputs(f.dir).map(finding => finding.path)).toContain('current.motion');
});

test.each(['changed', 'uncovered', 'unchanged', 'unrecorded'] as const)(
  'replaces an accepted adopted rig on unchanged config only with changed or uncovered recorded Parts (%s)',
  coverage => {
    const f = acceptedLegacyFixture();
    const staged = stagedRig(f);
    f.version.registration.config_source = f.write(config, staged.configBytes);
    const producer = join(TEMPLATES_DIR, 'example-current');
    const partsFrom = 'outputs/parts.next';
    const manifest = 'outputs/parts/rig/parts.json';
    const legacyManifest = `${outputs}/out/parts.json`;
    const oldManifestIndex = f.version.outputs.findIndex(file => file.path === legacyManifest);
    if (coverage === 'uncovered') f.version.outputs.splice(oldManifestIndex, 1);
    if (coverage === 'unchanged') {
      f.version.outputs[oldManifestIndex] = f.write(legacyManifest, readFileSync(join(producer, manifest), 'utf8'));
    }
    f.save();
    f.record('rig');
    f.record('parts');

    cpSync(join(producer, 'outputs/parts'), join(f.dir, partsFrom), { recursive: true });
    for (const path of ['inputs/painting.png', 'derived/layers', 'specs/rig/assemble.json']) {
      const target = join(f.dir, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(producer, path), target, { recursive: true });
    }
    f.record('parts', ['--from', partsFrom, '--config', 'specs/rig/assemble.json']);

    const input = coverage === 'unrecorded'
      ? f.write('outputs/parts/rig/unrecorded.json', '{}')
      : currentFileBinding(f.load(), 'parts', manifest)!;
    const runPath = `${staged.from}/check/build/run.json`;
    const run = JSON.parse(readFileSync(join(f.dir, runPath), 'utf8')) as JsonObject;
    (run.inputs as JsonObject[]).push({ role: 'manifest', path: posix.relative(posix.dirname(runPath), input.path), sha256: input.sha256 });
    f.write(runPath, JSON.stringify(run));

    const before = f.original();
    const args = ['rig', f.dir, ...staged.args, '--json'];
    if (coverage === 'unchanged' || coverage === 'unrecorded') {
      expect(() => recordCommand(args, now)).toThrow(expect.objectContaining({ code: 'RECORD_ADOPTED_RIG_OUTPUT_CHANGED' }));
      expect(f.original()).toEqual(before);
      expect(existsSync(join(f.dir, 'outputs/rig'))).toBe(false);
      return;
    }

    const result = recordCommand(args, now);
    expect(result.exit).toBe(0);
    expect(result.stderr).toContain('WARN RECORD_ADOPTED_RIG_INPUT_CHANGED');
    const reason = coverage === 'changed' ? 'changed' : 'without a retained binding were used';
    expect(result.stderr).toContain(`after recorded inputs ${reason} at ${manifest}`);
    const rig = (f.load().current as JsonObject).rig;
    expect(rig).toEqual(JSON.parse(result.stdout!));
    expect(rig).toMatchObject({ built_from: expect.arrayContaining([{ path: manifest, sha256: input.sha256 }]) });
    expect(rig).not.toHaveProperty('adopted');
    expect(currentRigFileBinding(f.load(), 'check/build/skeleton.model.json')?.path).toBe(CURRENT_RIG_MODEL);
    expect(existsSync(join(f.dir, staged.from))).toBe(false);
  },
);

test('allows a byte-identical rig replacement while retaining the adopted motion’s historical provenance', () => {
  const f = acceptedLegacyFixture();
  const staged = stagedRig(f);
  f.version.registration.config_source = f.write(config, staged.configBytes);
  f.version.outputs[0] = f.write(`${build}/skeleton.model.json`, staged.model);
  f.save();
  f.record('rig');
  const motion = f.record('motion');
  const result = recordCommand(['rig', f.dir, ...staged.args, '--json'], now);
  expect(result.exit).toBe(0);
  expect(result.stderr ?? '').not.toContain('RECORD_ADOPTED_RIG_INPUT_CHANGED');
  expect(staleOutputs(f.dir)).toContainEqual(expect.objectContaining({ path: 'current.motion', message: expect.stringContaining('requires upstream rig v4') }));
  expect(verifiedLegacyMotionProvenance(f.dir, f.load())).toEqual(motion.provenance as JsonObject);
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
  const project = JSON.parse(f.original().toString()) as JsonObject;
  expect(currentMotionSetBinding(f.dir, project)).toEqual({ path: 'outputs/motion', sha256: String(node.files_sha256) });
  expect(checkProject(f.dir, project, { now })).not.toHaveProperty('current_motion_provenance');
  expect(existsSync(join(f.dir, from))).toBe(false);
  expect(treeFiles(f.dir, `${outputs}/idle`)).toEqual(idle);
});

function numberedPostFixture(bounce = false): string {
  const composeFiles: Record<string, string> = {
    'outputs/v4/compose/compose-run.json': '{"spec":"rig-compose-run/1"}',
    'outputs/v4/compose/check/check.json': '{"spec":"rig-parts-check/1","PASS":true}',
    'outputs/v4/compose/check/build/skeleton.model.json': '{"spec":"rigc-compiled/3"}',
    'outputs/v4/compose/check/extremes/actor:body_turn/extremes.json': '{"extremes":[]}',
    'outputs/v4/compose/check/extremes/actor:body_turn/extremes.png': 'synthetic extreme pose',
    'outputs/v4/compose/check/extremes/actor:tilt/extremes.json': '{"extremes":[]}',
  };
  return exampleFixture(project => {
    if (bounce) {
      project.stage = 'direction-review';
      project.signoffs = asArray(project.signoffs).filter(row => isObject(row) && row.stage !== 'direction-review');
      project.advances = asArray(project.advances).filter(row => isObject(row) && row.stage !== 'accepted');
    }
    const post = (project.versions as JsonObject[]).find(version => version.n === 4)!;
    post.outputs = [
      ...(post.outputs as JsonObject[]),
      ...Object.entries(composeFiles).map(([path, body]) => ({
        path, sha256: sha256(body), bytes: Buffer.byteLength(body),
      })),
    ];
  }, 'example-numbered/example-project.json', composeFiles);
}

test('adopts a numbered post with <id>:<pose> output directories and checks with 0 refusals', () => {
  const checkNow = EXAMPLE_ANCHOR + 60 * 60_000;
  const dir = numberedPostFixture();
  const adopted = recordCommand(['direction', dir, '--adopt', '--json'], checkNow);
  expect(adopted.exit).toBe(0);
  expect(adopted.stderr).toBeUndefined();
  const node = JSON.parse(adopted.stdout) as JsonObject;
  expect(node.adopted).toEqual({ version: 4 });
  const paths = (node.files as { path: string }[]).map(file => file.path);
  expect(paths).toContain('outputs/v4/compose/check/extremes/actor:body_turn/extremes.json');
  expect(paths).toContain('outputs/v4/compose/check/extremes/actor:body_turn/extremes.png');
  expect(paths).toContain('outputs/v4/compose/check/extremes/actor:tilt/extremes.json');

  const checked = interviewCommand(['--check', dir, '--json'], checkNow);
  const report = JSON.parse(checked.stdout) as CheckReport;
  expect(report.refusals.map(finding => finding.code)).toEqual([]);
  expect(report.feedback.some(feedback => feedback.open_direction_comment !== undefined)).toBe(false);
  expect(checked.exit).toBe(0);
});

test('adopts a bounced post in place and exposes its open comment through the legacy binding', () => {
  const dir = numberedPostFixture(true);
  const checkNow = EXAMPLE_ANCHOR + 60 * 60_000;
  const file = join(dir, 'project.json');
  const words = 'The beam still starts too early.\nKeep the last sweep.';
  const wordsFile = join(dir, 'owner-words.txt');
  writeFileSync(wordsFile, words);
  seedStoredVerdict(dir, 4, { review: 'direction-review', verdict: 'bounced', by: 'user', at: checkNow,
    verbatim: words, source: 'synthetic chat', on_items: [{ id: 'post_timing', answer_was: 'user' }] });
  const before = readFileSync(file);
  const composeRun = join(dir, 'outputs/v4/compose/compose-run.json');
  renameSync(composeRun, `${composeRun}.kept`);
  expect(() => recordCommand(['direction', dir, '--adopt'], checkNow + 1))
    .toThrow(expect.objectContaining({ code: 'RECORD_ADOPT_SOURCE_INVALID' }));
  expect(readFileSync(file)).toEqual(before);
  renameSync(`${composeRun}.kept`, composeRun);

  const adopted = recordCommand(['direction', dir, '--adopt', '--json'], checkNow + 1);
  expect(adopted.exit).toBe(0);
  expect(adopted.stderr).toContain('WARN [RECORD_ADOPT_DIRECTION_BOUNCED]');
  expect(adopted.stderr).toContain('versions[v4].verdicts[1]');
  const saved = readFileSync(file);
  const project = JSON.parse(saved.toString()) as JsonObject;
  expect(JSON.parse(adopted.stdout)).toMatchObject({ adopted: { version: 4 } });
  // The 1.26.0 writer added only current.direction. The view reads those same bytes.
  expect(project).toEqual({ ...JSON.parse(before.toString()), current: { direction: JSON.parse(adopted.stdout) } });

  const comment: OpenDirectionComment = {
    field: 'current.direction', verdict: 'versions[v4].verdicts[1]', by: 'user',
    at: new Date(checkNow).toISOString(), source: 'synthetic chat', verbatim: words,
    on_items: [{ id: 'post_timing', answer_was: 'user' }],
  };
  const check = interviewCommand(['--check', dir, '--json'], checkNow + 1);
  expect(check.exit).toBe(0);
  const report = JSON.parse(check.stdout) as CheckReport;
  expect(report.refusals).toEqual([]);
  expect(report.feedback.flatMap(feedback => feedback.open_direction_comment ?? [])).toEqual([comment]);
  const next = JSON.parse(nextCommand([dir, '--json'], checkNow + 1).stdout) as NextReport;
  expect(next.open_direction_comments).toEqual([comment]);
  for (const result of [interviewCommand(['--check', dir], checkNow + 1), nextCommand([dir], checkNow + 1)]) {
    expect(result.stdout).toContain('FEEDBACK_OPEN');
    expect(result.stdout).toContain(`Open comment from user: ${JSON.stringify(words)}`);
  }
  expect(readFileSync(file)).toEqual(saved);
});

test.each([
  'outputs/v7/compose\\extremes.json',
  'outputs/v7/compose/\0extremes.json',
  '/outputs/v7/compose/extremes.json',
  'C:/outputs/v7/compose/extremes.json',
  'outputs/v7/compose//extremes.json',
  'outputs/v7/compose/./extremes.json',
  'outputs/v7/compose/../compose/extremes.json',
])('continues refusing non-literal adopted or current paths (%j)', malformedPath => {
  const f = fixture();
  const valid = f.write('outputs/v7/compose/check/extremes/actor:turn/extremes.json', '{}');
  f.project.versions = [f.version, {
    n: 7, kind: 'post', rig_version: 4, at, built_by: f.version.built_by, built_with: f.version.built_with,
    ...(malformedPath.startsWith('outputs/v7/compose/')
      ? { outputs: [{ path: malformedPath, sha256: valid.sha256 }] }
      : { provenance: { direction: { path: malformedPath, sha256: valid.sha256 } }, outputs: [valid] }),
  }];
  f.save();
  const original = f.original();
  if (malformedPath.startsWith('outputs/v7/compose/')) {
    expect(() => f.record('direction')).toThrow(expect.objectContaining({ code: 'RECORD_ADOPT_SOURCE_INVALID' }));
    expect(f.original()).toEqual(original);
  } else {
    const adopted = f.record('direction');
    expect(adopted.built_from).toEqual([]);
  }
  const files = [{ path: malformedPath, sha256: valid.sha256, bytes: valid.bytes }];
  expect(currentShapeFindings('direction', {
    at, built_by: 'synthetic-builder', built_with: {}, files, files_sha256: outputSetHash(files), built_from: [],
    run: { path: malformedPath, sha256: valid.sha256 }, report: { path: malformedPath, sha256: valid.sha256 },
  }).map(finding => finding.code)).toContain('CURRENT_MALFORMED');
});
