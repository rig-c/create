import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isRunRecordFile, outputSetHash, treeFiles } from '../src/current.ts';
import { recordCommand } from '../src/record.ts';
import { Refusal } from '../src/refusal.ts';
import { TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { checkProject, testClock } from './clock.ts';
import { fixture } from './fixtures.ts';
import { treeDigest } from './helpers.ts';

const PRODUCER = join(TEMPLATES_DIR, 'example-draft');
const NEXT = 'outputs/rig.next';
const CONFIG = 'specs/rig/config.json';
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const rig = (dir: string): JsonObject => (read(dir).current as JsonObject).rig as JsonObject;
const codes = (findings: { code: string }[], code: string): number => findings.filter(f => f.code === code).length;

function write(dir: string, path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), bytes);
}

/** A synthetic producer output: the example draft's parts rig and core build, with a check report bound to its model. */
function producerOut(dir: string, at = NEXT): void {
  cpSync(join(PRODUCER, 'out'), join(dir, at), { recursive: true });
  const model = sha(readFileSync(join(dir, at, 'check/build/skeleton.model.json')));
  write(dir, `${at}/check/check.json`, `${JSON.stringify({ spec: 'rig-parts-check/1', bar_outcomes: {}, build: { model_sha256: model }, PASS: true }, null, 1)}\n`);
}

/** Rewrite the producer's check report with the right spec and model but red outcomes. */
function redReport(dir: string, outcomes: JsonObject): void {
  const model = sha(readFileSync(join(dir, NEXT, 'check/build/skeleton.model.json')));
  write(dir, `${NEXT}/check/check.json`, JSON.stringify({ spec: 'rig-parts-check/1', bar_outcomes: {}, build: { model_sha256: model }, ...outcomes, PASS: false }));
}

function project(): string {
  const dir = fixture(() => {}, 'example-project.json');
  write(dir, CONFIG, readFileSync(join(PRODUCER, 'config.json')));
  producerOut(dir);
  return dir;
}

const args = (dir: string, extra: string[] = []): string[] => ['rig', dir, '--from', NEXT, '--config', CONFIG, ...extra];
const record = (dir: string, extra: string[] = []) => recordCommand(args(dir, extra), testClock.now());

function refused(fn: () => unknown, code: string): void {
  try { fn(); } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

test('record rig writes current.rig with the §1.3 shape and renames the producer output into outputs/rig', () => {
  const dir = project();
  const before = checkProject(dir);
  const producerBytes = treeDigest(join(dir, NEXT));
  expect(record(dir).exit).toBe(0);
  expect(existsSync(join(dir, NEXT))).toBe(false);
  expect(treeDigest(join(dir, 'outputs/rig'))).toEqual(producerBytes);
  const node = rig(dir);
  expect(Object.keys(node)).toEqual(['at', 'built_by', 'built_with', 'files', 'files_sha256', 'built_from', 'run', 'report', 'rebuild']);
  expect(node.built_with).toEqual({ '@rig-c/parts': '2.56.0', '@rig-c/core': '3.8.1' });
  expect(node.built_from).toEqual([{ path: CONFIG, sha256: sha(readFileSync(join(dir, CONFIG))) }]);
  expect(node.run).toEqual({ path: 'outputs/rig/run.json', sha256: sha(readFileSync(join(dir, 'outputs/rig/run.json'))) });
  expect((node.report as JsonObject).path).toBe('outputs/rig/check/check.json');
  expect(node.rebuild).toEqual({ recorded: false, note: expect.any(String) });
  // The output-set hash leaves out every run.json; files[] still lists them.
  const files = node.files as { path: string; sha256: string }[];
  expect(files.some(f => f.path === 'outputs/rig/check/build/run.json')).toBe(true);
  expect(node.files_sha256).toBe(outputSetHash(files.filter(f => !f.path.endsWith('/run.json'))));
  const after = checkProject(dir);
  expect(after.refusals).toEqual(before.refusals);
  expect(codes(after.warnings, 'REBUILD_ARGS_UNRECORDED')).toBe(1);
  expect(codes(after.warnings, 'OUTPUT_STALE')).toBe(0);
});

test('a second record replaces outputs/rig and deletes the old tree, leaving no copy beside it', () => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  producerOut(dir);
  write(dir, `${NEXT}/mesh_report.json`, '{"changed":true}\n');
  // The run's own inventory now disagrees with the tree, so the producer must re-run; plant the matching run.json.
  const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { outputs: { path: string; sha256: string }[] };
  run.outputs.find(o => o.path === 'mesh_report.json')!.sha256 = sha('{"changed":true}\n');
  write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  expect(record(dir).exit).toBe(0);
  expect(readFileSync(join(dir, 'outputs/rig/mesh_report.json'), 'utf8')).toBe('{"changed":true}\n');
  expect(readdirSync(join(dir, 'outputs')).filter(name => name.startsWith('rig')).sort()).toEqual(['rig']);
});

test.each([
  ['config differs from the run', (dir: string) => write(dir, CONFIG, '{"changed":true}\n'), 'RECORD_CONFIG_MISMATCH'],
  ['run record missing', (dir: string) => rmSync(join(dir, NEXT, 'run.json')), 'RECORD_RUN_INVALID'],
  ['output differs from the run', (dir: string) => write(dir, `${NEXT}/rig.json`, '{}'), 'RECORD_RUN_INVALID'],
  ['report names another model', (dir: string) => write(dir, `${NEXT}/check/check.json`, JSON.stringify({ spec: 'rig-parts-check/1', bar_outcomes: {}, build: { model_sha256: '0'.repeat(64) } })), 'RECORD_REPORT_INVALID'],
  ['Parts rerun into the folder without rebuilding Core (mixed tree)', (dir: string) => {
    write(dir, `${NEXT}/rig.json`, '{"rerun":true}\n');
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { outputs: { path: string; sha256: string }[] };
    run.outputs.find(o => o.path === 'rig.json')!.sha256 = sha('{"rerun":true}\n');
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'RECORD_INPUT_CHANGED'],
  ['red check report: a failed bar', (dir: string) => redReport(dir, { bar_outcomes: { SEAM: { status: 'FAIL' } } }), 'RIG_CHECK_BAR_FAILED'],
  ['red check report: an unmet requirement', (dir: string) => redReport(dir, { requirements: { lines: { BREATH: { status: 'NOT MEASURABLE' } } } }), 'RIG_CHECK_LINE_UNMET'],
  ['red check report: failed source exposure', (dir: string) => redReport(dir, { SOURCE_EXPOSURE: { status: 'FAIL' } }), 'RIG_CHECK_LINE_UNMET'],
  ['producer folder missing', (dir: string) => { rmSync(join(dir, NEXT), { recursive: true }); }, 'RECORD_FROM_INVALID'],
] as const)('a refused record leaves project.json and outputs/rig byte-identical: %s', (_name, plant, code) => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  producerOut(dir);
  plant(dir);
  const recordBytes = readFileSync(join(dir, 'project.json'));
  const outputs = treeDigest(join(dir, 'outputs/rig'));
  refused(() => record(dir), code);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(recordBytes);
  expect(treeDigest(join(dir, 'outputs/rig'))).toEqual(outputs);
});

test('record rig refuses a --from outside the project before reading anything', () => {
  const dir = project();
  const recordBytes = readFileSync(join(dir, 'project.json'));
  refused(() => recordCommand(['rig', dir, '--from', '../elsewhere', '--config', CONFIG], testClock.now()), 'RECORD_FROM_INVALID');
  refused(() => recordCommand(['motion', dir, '--from', NEXT], testClock.now()), 'RECORD_USAGE');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(recordBytes);
  expect(existsSync(join(dir, NEXT))).toBe(true);
});

/** Plant a downstream motion and direction node, as a later `record motion` / `record direction` would write them. */
function plantDownstream(dir: string): void {
  const p = read(dir);
  const node = (kind: string, file: string, bytes: string, runName: string, builtFrom: { path: string; sha256: string }[]): JsonObject => {
    write(dir, `outputs/${kind}/${file}`, bytes);
    write(dir, `outputs/${kind}/${runName}`, '{"started_at":"2026-11-24T00:00:00.000Z","finished_at":"2026-11-24T00:00:00.000Z"}\n');
    const files = treeFiles(dir, `outputs/${kind}`);
    const at = (path: string) => ({ path, sha256: files.find(f => f.path === path)!.sha256 });
    return { at: testClock.iso(), built_by: 'agent', built_with: { '@rig-c/core': '3.8.1' }, files, files_sha256: outputSetHash(files),
      built_from: builtFrom, run: at(`outputs/${kind}/${runName}`), report: at(`outputs/${kind}/${file}`) };
  };
  const model = 'outputs/rig/check/build/skeleton.model.json';
  const current = p.current as JsonObject;
  // Core's idle render writes render-run.json (rigc-run/2); it is a run record, so the output-set hash leaves it out.
  const motion = node('motion', 'frames.json', '{"frames":1}\n', 'render-run.json', [
    { path: 'outputs/rig', sha256: String(rig(dir).files_sha256) },
    { path: model, sha256: sha(readFileSync(join(dir, model))) },
  ]);
  current.motion = motion;
  current.direction = node('direction', 'take.json', '{"take":1}\n', 'run.json', [
    { path: 'outputs/motion', sha256: String(motion.files_sha256) },
    { path: 'outputs/motion/frames.json', sha256: sha('{"frames":1}\n') },
  ]);
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
}

test('planted: a timestamp-only change inside run.json or render-run.json marks nothing downstream stale', () => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  plantDownstream(dir);
  expect(codes(checkProject(dir).warnings, 'OUTPUT_STALE')).toBe(0);
  for (const path of ['outputs/rig/run.json', 'outputs/rig/check/build/run.json', 'outputs/motion/render-run.json']) {
    const before = readFileSync(join(dir, path), 'utf8');
    const text = before.replace(/"(started_at|finished_at)": ?"[^"]+"/g, '"$1":"2099-01-01T09:30:00.000Z"');
    expect(text).not.toBe(before);
    writeFileSync(join(dir, path), text);
  }
  const report = checkProject(dir);
  expect(report.warnings.filter(f => f.code === 'OUTPUT_STALE')).toEqual([]);
  expect(codes(report.refusals, 'CURRENT_MALFORMED')).toBe(0);
});

test('planted: a product-byte change in a rig output file marks its dependents stale, transitively', () => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  plantDownstream(dir);
  const model = join(dir, 'outputs/rig/check/build/skeleton.model.json');
  writeFileSync(model, `${readFileSync(model, 'utf8')} `);
  const stale = checkProject(dir).warnings.filter(f => f.code === 'OUTPUT_STALE').map(f => f.path);
  expect(stale).toEqual(['current.motion', 'current.direction']);
});

test('isRunRecordFile is the producers\' rule: run.json or any *-run.json', () => {
  expect(['outputs/rig/run.json', 'outputs/rig/check/build/run.json', 'outputs/motion/render-run.json',
    'outputs/rig/check/check-run.json', 'outputs/rig/check/build/build-run.json'].map(isRunRecordFile)).toEqual([true, true, true, true, true]);
  expect(['outputs/rig/rig.json', 'outputs/motion/frames.json', 'outputs/rig/check/check.json', 'outputs/rig/rerun.json']
    .map(isRunRecordFile)).toEqual([false, false, false, false]);
});

test('check-run.json and build-run.json are left out of output identity', () => {
  const product = { path: 'outputs/rig/check/build/skeleton.model.json', sha256: 'a'.repeat(64) };
  const records = (stamp: string) => ['outputs/rig/check/check-run.json', 'outputs/rig/check/build/build-run.json']
    .map(path => ({ path, sha256: sha(`${path}${stamp}`) }));
  expect(outputSetHash([product, ...records('2026-11-24')])).toBe(outputSetHash([product, ...records('2026-11-25')]));
  expect(outputSetHash([product, ...records('2026-11-24')])).toBe(outputSetHash([product]));
  expect(outputSetHash([{ ...product, sha256: 'b'.repeat(64) }])).not.toBe(outputSetHash([product]));
});

test('check refuses a built_from that names a run record', () => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  plantDownstream(dir);
  const p = read(dir);
  const motion = (p.current as JsonObject).motion as JsonObject;
  (motion.built_from as JsonObject[]).push({ path: 'outputs/rig/run.json', sha256: String(rig(dir).run && (rig(dir).run as JsonObject).sha256) });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  const report = checkProject(dir);
  expect(report.refusals.filter(f => f.code === 'CURRENT_MALFORMED').map(f => f.path)).toEqual(['current.motion.built_from[2]']);
});

test('REBUILD_ARGS_UNRECORDED warns while current.rig.rebuild says the arguments are not recorded', () => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  const warning = checkProject(dir).warnings.find(f => f.code === 'REBUILD_ARGS_UNRECORDED');
  expect(warning?.path).toBe('current.rig.rebuild');
  const p = read(dir);
  ((p.current as JsonObject).rig as JsonObject).rebuild = { recorded: false, note: '' };
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  expect(checkProject(dir).refusals.filter(f => f.code === 'CURRENT_MALFORMED').map(f => f.path)).toEqual(['current.rig.rebuild']);
});

test('an old-process project with versions[] and no current gets no current finding', () => {
  const dir = fixture();
  const report = checkProject(dir);
  for (const code of ['CURRENT_MALFORMED', 'OUTPUT_STALE', 'REBUILD_ARGS_UNRECORDED']) {
    expect(codes([...report.refusals, ...report.warnings], code)).toBe(0);
  }
  expect(Array.isArray(read(dir).versions)).toBe(true);
});
