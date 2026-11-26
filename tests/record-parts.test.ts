import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assemblyConfigReading } from '@rig-c/parts/assembly-reading';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { EXAMPLE_SOURCE_DATE_EPOCH } from '../scripts/example-time.ts';
import { EXAMPLE_SEETHROUGH } from '../scripts/generate-example-parts.ts';
import { checkProject as checkProjectRaw } from '../src/check.ts';
import { outputSetHash, treeFiles } from '../src/current.ts';
import { ledgerCommand, ledgerRows, liveRows } from '../src/fix-ledger.ts';
import { recordCommand } from '../src/record.ts';
import { Refusal } from '../src/refusal.ts';
import { TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { checkProject, testClock } from './clock.ts';
import { syntheticLedgerReport } from './fix-ledger-report-fixture.ts';
import { fixture } from './fixtures.ts';
import { cli, gitEnv, run, tempDir, treeDigest } from './helpers.ts';

const load = createRequire(import.meta.url);
const { encodePng } = load('@rig-c/core/plate') as {
  encodePng: (width: number, height: number, rgba: Uint8Array) => Uint8Array;
};

const PARTS_BIN = join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs');
const RIG_PRODUCER = join(TEMPLATES_DIR, 'example-draft');
const NEXT = 'outputs/parts.next';
const RIG_NEXT = 'outputs/rig.next';
const PAINTING = 'inputs/painting.png';
const LAYERS_DIR = 'derived/layers';
const LAYERS_MANIFEST = `${LAYERS_DIR}/layers.json`;
const CONFIG = 'specs/rig/config.json';

const sha = (bytes: Buffer | string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const parts = (dir: string): JsonObject => (read(dir).current as JsonObject).parts as JsonObject;
const rig = (dir: string): JsonObject => (read(dir).current as JsonObject).rig as JsonObject;
const codes = (findings: { code: string }[], code: string): number => findings.filter(f => f.code === code).length;

function write(dir: string, path: string, bytes: string | Buffer | Uint8Array): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), bytes);
}

let cachedTemplate: string | undefined;
beforeAll(() => { builtTemplate(); }, 30_000);
afterAll(() => { if (cachedTemplate) rmSync(cachedTemplate, { recursive: true, force: true }); });

/** Build one real producer assemble + check-parts tree from project-root relative paths, then clone per test. */
function builtTemplate(): string {
  if (cachedTemplate) return cachedTemplate;
  const dir = mkdtempSync(join(tmpdir(), 'record-parts-template-'));
  const size = EXAMPLE_SEETHROUGH.resolution;
  const plate = new Uint8Array(size * size * 4);
  const blocks = [
    { name: 'background', tag: 'author:background', x: 0, y: 0, w: 128, h: 128, rgb: [32, 48, 64] },
    { name: 'torso', tag: 'topwear', x: 40, y: 56, w: 48, h: 64, rgb: [64, 144, 192] },
    { name: 'lantern', tag: 'author:lantern', x: 96, y: 72, w: 16, h: 24, rgb: [240, 176, 64] },
    { name: 'face', tag: 'face', x: 44, y: 16, w: 40, h: 32, rgb: [224, 176, 144] },
    { name: 'eye_r', tag: 'eyewhite-r', x: 50, y: 28, w: 8, h: 8, rgb: [240, 240, 240] },
    { name: 'eye_l', tag: 'eyewhite-l', x: 70, y: 28, w: 8, h: 8, rgb: [240, 240, 240] },
  ];
  const layers = blocks.map(block => {
    const rgba = new Uint8Array(block.w * block.h * 4);
    for (let y = 0; y < block.h; y++) for (let x = 0; x < block.w; x++) {
      const colour = [...block.rgb, 255];
      rgba.set(colour, (y * block.w + x) * 4);
      plate.set(colour, ((y + block.y) * size + x + block.x) * 4);
    }
    const filename = `${block.name}.png`;
    write(dir, `${LAYERS_DIR}/${filename}`, encodePng(block.w, block.h, rgba));
    return { name: block.tag, filename, left: block.x, top: block.y, right: block.x + block.w, bottom: block.y + block.h, depth_median: null };
  });
  write(dir, LAYERS_MANIFEST, JSON.stringify({ width: size, height: size, layers }));
  write(dir, PAINTING, encodePng(size, size, plate));
  const rigCfg = JSON.parse(readFileSync(join(RIG_PRODUCER, 'config.json'), 'utf8')) as JsonObject;
  write(dir, CONFIG, `${JSON.stringify({
    ...rigCfg,
    seethrough: EXAMPLE_SEETHROUGH,
    assemble: { rig_scale: 1, plan: blocks.map(block => [block.name, 'full', block.tag]) },
  }, null, 2)}\n`);
  const env = { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH };
  const assembled = Bun.spawnSync([process.execPath, PARTS_BIN,
    'assemble', '--source', PAINTING, '--full', LAYERS_DIR, '--config', CONFIG, '--out', NEXT],
    { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  if (assembled.exitCode !== 0) throw new Error(`assemble failed: ${assembled.stderr}\n${assembled.stdout}`);
  const checked = Bun.spawnSync([process.execPath, PARTS_BIN,
    'check-parts', '--parts', `${NEXT}/rig`, '--out', `${NEXT}/check`],
    { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  if (checked.exitCode !== 0) throw new Error(`check-parts failed: ${checked.stderr}\n${checked.stdout}`);
  cachedTemplate = dir;
  return dir;
}

function producerOut(dir: string, at = NEXT): void {
  cpSync(join(builtTemplate(), NEXT), join(dir, at), { recursive: true });
}

function project({ withLedger = true } = {}): string {
  const dir = fixture(() => {}, 'example-project.json');
  if (!withLedger) {
    const reasonFile = join(tempDir(), 'retire-t1.txt');
    writeFileSync(reasonFile, 'This fixture exercises recording after the fix has been retired.\n');
    ledgerCommand(['retire', 'T1', dir, '--by', 'user', '--reason-file', reasonFile], testClock.now());
  }
  const src = builtTemplate();
  for (const rel of [PAINTING, LAYERS_DIR, CONFIG]) cpSync(join(src, rel), join(dir, rel), { recursive: true });
  producerOut(dir);
  return dir;
}

const args = (dir: string, extra: string[] = []): string[] => ['parts', dir, '--from', NEXT, '--config', CONFIG, ...extra];
function record(dir: string) {
  const now = testClock.now();
  const rows = liveRows(ledgerRows(read(dir), [], now) ?? [], now);
  const manifest = join(dir, NEXT, 'rig/parts.json');
  const ledgerArgs = rows.length && existsSync(manifest)
    ? ['--ledger-report', syntheticLedgerReport(dir, sha(readFileSync(manifest)), Object.fromEntries(rows.map(row => [row.id, 'pass'])))] : [];
  return recordCommand(args(dir, ledgerArgs), now);
}

function refused(fn: () => unknown, code: string): void {
  try { fn(); } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

test('record parts writes current.parts with the §1.3 shape and renames the producer output into outputs/parts', () => {
  const dir = project({ withLedger: false });
  const before = checkProject(dir);
  const producerBytes = treeDigest(join(dir, NEXT));
  expect(record(dir).exit).toBe(0);
  expect(existsSync(join(dir, NEXT))).toBe(false);
  expect(treeDigest(join(dir, 'outputs/parts'))).toEqual(producerBytes);
  const node = parts(dir);
  expect(Object.keys(node)).toEqual(['at', 'built_by', 'built_with', 'files', 'files_sha256', 'built_from', 'run', 'report']);
  expect(node.built_with).toEqual({ '@rig-c/parts': '2.57.0' });
  expect(node.built_from).toEqual([
    { path: LAYERS_MANIFEST, sha256: sha(readFileSync(join(dir, LAYERS_MANIFEST))) },
    { path: PAINTING, sha256: sha(readFileSync(join(dir, PAINTING))) },
    { path: CONFIG, sha256: sha(readFileSync(join(dir, CONFIG))) },
  ]);
  expect(node.run).toEqual({ path: 'outputs/parts/run.json', sha256: sha(readFileSync(join(dir, 'outputs/parts/run.json'))) });
  expect(node.report).toEqual({ path: 'outputs/parts/check/parts-check.json', sha256: sha(readFileSync(join(dir, 'outputs/parts/check/parts-check.json'))) });
  const files = node.files as { path: string; sha256: string }[];
  expect(files.some(f => f.path === 'outputs/parts/rig/parts.json')).toBe(true);
  expect(files.some(f => f.path === 'outputs/parts/run.json')).toBe(true);
  expect(node.files_sha256).toBe(outputSetHash(files.filter(f => !f.path.endsWith('/run.json'))));
  const after = checkProject(dir);
  expect(after.refusals).toEqual(before.refusals);
  expect(codes(after.warnings, 'OUTPUT_STALE')).toBe(0);
  expect(codes(after.warnings, 'REBUILD_ARGS_UNRECORDED')).toBe(0);
});

test('the signed example with live row T1 refuses a missing ledger report without changing either parts tree or the record', () => {
  const dir = project();
  const file = join(dir, 'project.json');
  cpSync(join(TEMPLATES_DIR, 'example-project.json'), file);
  producerOut(dir, 'outputs/parts');
  write(dir, 'outputs/parts/previous.txt', 'previous output');
  const original = readFileSync(file);
  const installed = treeDigest(join(dir, 'outputs/parts'));
  const staged = treeDigest(join(dir, NEXT));
  refused(() => recordCommand(args(dir), testClock.now()), 'CURRENT_PARTS_LEDGER_REPORT_MISSING');
  expect(readFileSync(file)).toEqual(original);
  expect(treeDigest(join(dir, 'outputs/parts'))).toEqual(installed);
  expect(treeDigest(join(dir, NEXT))).toEqual(staged);
});

test('a second record replaces outputs/parts and deletes the old tree, leaving no copy beside it', () => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  producerOut(dir);
  const support = 'rig/part_support_domains.json';
  const updated = `${readFileSync(join(dir, NEXT, support), 'utf8').trimEnd()}\n\n`;
  write(dir, `${NEXT}/${support}`, updated);
  const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { outputs: { path: string; sha256: string }[] };
  run.outputs.find(o => o.path === support)!.sha256 = sha(updated);
  write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  const report = JSON.parse(readFileSync(join(dir, NEXT, 'check/parts-check.json'), 'utf8')) as { inputs: { path: string; sha256: string | null }[] };
  report.inputs.find(i => i.path === 'part_support_domains.json')!.sha256 = sha(updated);
  write(dir, `${NEXT}/check/parts-check.json`, JSON.stringify(report));
  expect(record(dir).exit).toBe(0);
  expect(readFileSync(join(dir, `outputs/parts/${support}`), 'utf8')).toBe(updated);
  expect(readdirSync(join(dir, 'outputs')).filter(name => name.startsWith('parts')).sort()).toEqual(['parts']);
});

test('a new-convention assemble record (--out-relative paths and <dir>/layers.json) records and rebinds in place with built_from unchanged', () => {
  const dir = project({ withLedger: false });
  const headManifest = 'derived/head/layers.json';
  write(dir, headManifest, '{"width":128,"height":128,"layers":[]}\n');
  // rig-parts#1555 (src/runstamp.ts buildAssembleInputs + src/outputpaths.ts recordedInputPath):
  // every assemble input is relative to --out, and a See-through directory names <dir>/layers.json directly.
  const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as {
    config: { path: string; sha256: string };
    inputs: { role: string; path: string; sha256: string }[];
  };
  run.config = { path: posix.relative(NEXT, CONFIG), sha256: sha(readFileSync(join(dir, CONFIG))) };
  run.inputs = [
    { role: 'source', path: posix.relative(NEXT, PAINTING), sha256: sha(readFileSync(join(dir, PAINTING))) },
    { role: 'full', path: posix.relative(NEXT, LAYERS_MANIFEST), sha256: sha(readFileSync(join(dir, LAYERS_MANIFEST))) },
    { role: 'head', path: posix.relative(NEXT, headManifest), sha256: sha(readFileSync(join(dir, headManifest))) },
  ];
  expect(run.inputs.map(i => i.path)).toEqual([
    '../../inputs/painting.png',
    '../../derived/layers/layers.json',
    '../../derived/head/layers.json',
  ]);
  write(dir, `${NEXT}/run.json`, JSON.stringify(run));

  expect(record(dir).exit).toBe(0);
  expect(existsSync(join(dir, NEXT))).toBe(false);
  const initialBuiltFrom = parts(dir).built_from;
  expect(initialBuiltFrom).toEqual([
    { path: headManifest, sha256: sha(readFileSync(join(dir, headManifest))) },
    { path: LAYERS_MANIFEST, sha256: sha(readFileSync(join(dir, LAYERS_MANIFEST))) },
    { path: PAINTING, sha256: sha(readFileSync(join(dir, PAINTING))) },
    { path: CONFIG, sha256: sha(readFileSync(join(dir, CONFIG))) },
  ]);

  // §4.4 in-place rebind (--from outputs/parts --config specs/rig/config.json): same depth as outputs/parts.next, so built_from is unchanged.
  expect(recordCommand(['parts', dir, '--from', 'outputs/parts', '--config', CONFIG], testClock.now()).exit).toBe(0);
  expect(parts(dir).built_from).toEqual(initialBuiltFrom);
  expect(checkProject(dir).refusals.filter(f => f.code === 'CURRENT_MALFORMED')).toEqual([]);
  expect(codes(checkProject(dir).warnings, 'OUTPUT_STALE')).toBe(0);
});

test('an old-convention assemble record (cwd-relative paths and See-through directory path) still records and rebinds in place', () => {
  const dir = project({ withLedger: false });
  const headDir = 'derived/head';
  const headManifest = `${headDir}/layers.json`;
  write(dir, headManifest, '{"width":128,"height":128,"layers":[]}\n');
  const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as {
    inputs: { role: string; path: string; sha256: string }[];
  };
  run.inputs = [
    { role: 'source', path: PAINTING, sha256: sha(readFileSync(join(dir, PAINTING))) },
    { role: 'full', path: LAYERS_DIR, sha256: sha(readFileSync(join(dir, LAYERS_MANIFEST))) },
    { role: 'head', path: headDir, sha256: sha(readFileSync(join(dir, headManifest))) },
  ];
  write(dir, `${NEXT}/run.json`, JSON.stringify(run));

  expect(record(dir).exit).toBe(0);
  const expectedBuiltFrom = [
    { path: headManifest, sha256: sha(readFileSync(join(dir, headManifest))) },
    { path: LAYERS_MANIFEST, sha256: sha(readFileSync(join(dir, LAYERS_MANIFEST))) },
    { path: PAINTING, sha256: sha(readFileSync(join(dir, PAINTING))) },
    { path: CONFIG, sha256: sha(readFileSync(join(dir, CONFIG))) },
  ];
  expect(parts(dir).built_from).toEqual(expectedBuiltFrom);

  expect(recordCommand(['parts', dir, '--from', 'outputs/parts', '--config', CONFIG], testClock.now()).exit).toBe(0);
  expect(parts(dir).built_from).toEqual(expectedBuiltFrom);
});

test.each([
  ['depth-1 non-sibling folder', 'parts.next'],
  ['depth-2 folder under another parent', 'derived/parts.next'],
  ['nested folder inside outputs/parts', 'outputs/parts/nested'],
] as const)('a non-sibling --from (%s) refuses RECORD_FROM_INVALID and leaves project.json and outputs/parts byte-identical', (_label, nonSibling) => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  if (nonSibling !== 'outputs/parts/nested') producerOut(dir, nonSibling);
  const recordBytes = readFileSync(join(dir, 'project.json'));
  const outputs = treeDigest(join(dir, 'outputs/parts'));
  refused(() => recordCommand(['parts', dir, '--from', nonSibling, '--config', CONFIG], testClock.now()), 'RECORD_FROM_INVALID');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(recordBytes);
  expect(treeDigest(join(dir, 'outputs/parts'))).toEqual(outputs);
});

test('RECORD_INPUT_CHANGED names both the --from candidate and the project-root candidate when neither matches', () => {
  const dir = project();
  const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as {
    inputs: { role: string; path: string; sha256: string }[];
  };
  run.inputs = [
    { role: 'source', path: posix.relative(NEXT, PAINTING), sha256: sha(readFileSync(join(dir, PAINTING))) },
    { role: 'full', path: posix.relative(NEXT, LAYERS_MANIFEST), sha256: sha(readFileSync(join(dir, LAYERS_MANIFEST))) },
  ];
  write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  write(dir, PAINTING, 'changed painting bytes');

  let newConvErr: Refusal | undefined;
  try { record(dir); } catch (error) { if (error instanceof Refusal) newConvErr = error; else throw error; }
  expect(newConvErr?.code).toBe('RECORD_INPUT_CHANGED');
  expect(newConvErr?.message).toContain(PAINTING);
  expect(newConvErr?.message).toContain('../../inputs/painting.png');

  // Parts 2.57.0 records the See-through manifest relative to --out.
  const dir2 = project();
  write(dir2, LAYERS_MANIFEST, '{"changed":true}\n');
  let manifestErr: Refusal | undefined;
  try { record(dir2); } catch (error) { if (error instanceof Refusal) manifestErr = error; else throw error; }
  expect(manifestErr?.code).toBe('RECORD_INPUT_CHANGED');
  expect(manifestErr?.message).toContain(`neither ${LAYERS_MANIFEST} (from ${NEXT})`);
  expect(manifestErr?.message).toContain(`nor ${posix.relative(NEXT, LAYERS_MANIFEST)} (from project root)`);
});

test.each([
  ['config differs from the run', (dir: string) => write(dir, CONFIG, '{"changed":true}\n'), 'RECORD_CONFIG_MISMATCH'],
  ['painting changed after assemble', (dir: string) => write(dir, PAINTING, 'changed painting bytes'), 'RECORD_INPUT_CHANGED'],
  ['See-through layers.json changed after assemble', (dir: string) => write(dir, LAYERS_MANIFEST, '{"changed":true}\n'), 'RECORD_INPUT_CHANGED'],
  ['assemble run input resolves outside the project', (dir: string) => {
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { inputs: { role: string; path: string; sha256: string }[] };
    run.inputs[0]!.path = '../outside/painting.png';
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'RECORD_INPUT_CHANGED'],
  ['assemble input names a run record', (dir: string) => {
    write(dir, 'specs/rig/extra-run.json', '{}\n');
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { inputs: { role: string; path: string; sha256: string }[] };
    run.inputs[0] = { role: 'source', path: 'specs/rig/extra-run.json', sha256: sha('{}\n') };
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'RECORD_BUILT_FROM_INVALID'],
  ['assemble input names a run record (--out-relative)', (dir: string) => {
    write(dir, 'specs/rig/extra-run.json', '{}\n');
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { inputs: { role: string; path: string; sha256: string }[] };
    run.inputs[0] = { role: 'source', path: '../../specs/rig/extra-run.json', sha256: sha('{}\n') };
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'RECORD_BUILT_FROM_INVALID'],
  ['assemble input lies inside the parts output', (dir: string) => {
    write(dir, `${NEXT}/inside.png`, readFileSync(join(dir, PAINTING)));
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { inputs: { role: string; path: string; sha256: string }[] };
    run.inputs[0] = { role: 'source', path: `${NEXT}/inside.png`, sha256: sha(readFileSync(join(dir, PAINTING))) };
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'RECORD_BUILT_FROM_INVALID'],
  ['assemble input lies inside the parts output (--out-relative)', (dir: string) => {
    write(dir, `${NEXT}/inside.png`, readFileSync(join(dir, PAINTING)));
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { inputs: { role: string; path: string; sha256: string }[] };
    run.inputs[0] = { role: 'source', path: 'inside.png', sha256: sha(readFileSync(join(dir, PAINTING))) };
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'RECORD_BUILT_FROM_INVALID'],
  ['assemble input lies inside the parts output, with a byte-identical copy at the project root', (dir: string) => {
    write(dir, `${NEXT}/inside.png`, readFileSync(join(dir, PAINTING)));
    write(dir, 'inside.png', readFileSync(join(dir, PAINTING)));
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { inputs: { role: string; path: string; sha256: string }[] };
    run.inputs[0] = { role: 'source', path: 'inside.png', sha256: sha(readFileSync(join(dir, PAINTING))) };
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'RECORD_BUILT_FROM_INVALID'],
  ['run record missing', (dir: string) => rmSync(join(dir, NEXT, 'run.json')), 'RECORD_RUN_INVALID'],
  ['run record command is rig instead of assemble', (dir: string) => {
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as JsonObject;
    delete run.inputs;
    run.command = 'rig';
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'RECORD_RUN_INVALID'],
  ['run record lacks assemble inputs', (dir: string) => {
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as JsonObject;
    delete run.inputs;
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'RECORD_RUN_INVALID'],
  ['output differs from the run', (dir: string) => write(dir, `${NEXT}/rig/parts.json`, '{}'), 'RECORD_RUN_INVALID'],
  ['check report missing', (dir: string) => rmSync(join(dir, NEXT, 'check/parts-check.json')), 'RECORD_REPORT_INVALID'],
  ['check report has wrong spec', (dir: string) => {
    const report = JSON.parse(readFileSync(join(dir, NEXT, 'check/parts-check.json'), 'utf8')) as JsonObject;
    report.spec = 'rig-parts-parts-check/0';
    write(dir, `${NEXT}/check/parts-check.json`, JSON.stringify(report));
  }, 'RECORD_REPORT_INVALID'],
  ['check report is malformed under rig-parts-parts-check/1', (dir: string) => {
    const report = JSON.parse(readFileSync(join(dir, NEXT, 'check/parts-check.json'), 'utf8')) as JsonObject;
    report.stage = 'rig';
    write(dir, `${NEXT}/check/parts-check.json`, JSON.stringify(report));
  }, 'PARTS_CHECK_INVALID'],
  ['check report is stale against reassembled parts', (dir: string) => {
    const support = 'rig/part_support_domains.json';
    const updated = `${readFileSync(join(dir, NEXT, support), 'utf8').trimEnd()}\n\n`;
    write(dir, `${NEXT}/${support}`, updated);
    const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { outputs: { path: string; sha256: string }[] };
    run.outputs.find(o => o.path === support)!.sha256 = sha(updated);
    write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  }, 'PARTS_CHECK_STALE'],
  ['red check report: non-zero exit_code and refusals', (dir: string) => {
    const report = JSON.parse(readFileSync(join(dir, NEXT, 'check/parts-check.json'), 'utf8')) as JsonObject;
    report.exit_code = 1;
    report.refusals = [{ code: 'PARTS_FILE_PRESENT', object: 'parts/face.png', found: null, required: 'file', detail: 'missing' }];
    write(dir, `${NEXT}/check/parts-check.json`, JSON.stringify(report));
  }, 'PARTS_CHECK_FAILED'],
  ['producer folder missing', (dir: string) => { rmSync(join(dir, NEXT), { recursive: true }); }, 'RECORD_FROM_INVALID'],
  ['producer folder holds a symlink', (dir: string) => { symlinkSync(join(dir, PAINTING), join(dir, NEXT, 'linked.png')); }, 'RECORD_FROM_INVALID'],
] as const)('a refused record leaves project.json and outputs/parts byte-identical: %s', (_name, plant, code) => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  producerOut(dir);
  plant(dir);
  const recordBytes = readFileSync(join(dir, 'project.json'));
  const outputs = treeDigest(join(dir, 'outputs/parts'));
  refused(() => record(dir), code);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(recordBytes);
  expect(treeDigest(join(dir, 'outputs/parts'))).toEqual(outputs);
});

test('record parts refuses invalid flags or paths outside the project before reading anything', () => {
  const dir = project();
  const recordBytes = readFileSync(join(dir, 'project.json'));
  refused(() => recordCommand(['parts', dir, '--from', '../elsewhere', '--config', CONFIG], testClock.now()), 'RECORD_FROM_INVALID');
  refused(() => recordCommand(['parts', dir, '--from', NEXT, '--config', '../elsewhere'], testClock.now()), 'RECORD_CONFIG_MISMATCH');
  refused(() => recordCommand(['parts', dir, '--from', NEXT, '--config', `${NEXT}/config.json`], testClock.now()), 'RECORD_CONFIG_MISMATCH');
  refused(() => recordCommand(['parts', dir, '--from', NEXT], testClock.now()), 'RECORD_USAGE');
  refused(() => recordCommand(['parts', dir], testClock.now()), 'RECORD_USAGE');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(recordBytes);
  expect(existsSync(join(dir, NEXT))).toBe(true);
});

/** Record current.rig bound to outputs/parts/rig/parts.json so downstream staleness goes through real record writers. */
function recordDownstreamRig(dir: string, rigConfigPath = 'specs/rig/rig-only.json'): void {
  if (rigConfigPath === 'specs/rig/rig-only.json') {
    write(dir, rigConfigPath, readFileSync(join(RIG_PRODUCER, 'config.json')));
  }
  const rigCfgBytes = readFileSync(join(dir, rigConfigPath));
  cpSync(join(RIG_PRODUCER, 'out'), join(dir, RIG_NEXT), { recursive: true });
  const run = JSON.parse(readFileSync(join(dir, RIG_NEXT, 'run.json'), 'utf8')) as { config: { path: string; sha256: string } };
  run.config.sha256 = sha(rigCfgBytes);
  write(dir, `${RIG_NEXT}/run.json`, JSON.stringify(run));
  const buildRunPath = `${RIG_NEXT}/check/build/run.json`;
  const buildRun = JSON.parse(readFileSync(join(dir, buildRunPath), 'utf8')) as { inputs: { role: string; path: string; sha256: string }[] };
  const manifestSha = sha(readFileSync(join(dir, 'outputs/parts/rig/parts.json')));
  buildRun.inputs = [
    ...buildRun.inputs.filter(i => i.role !== 'manifest'),
    { role: 'manifest', path: '../../../parts/rig/parts.json', sha256: manifestSha },
  ];
  write(dir, buildRunPath, JSON.stringify(buildRun));
  const model = sha(readFileSync(join(dir, RIG_NEXT, 'check/build/skeleton.model.json')));
  write(dir, `${RIG_NEXT}/check/check.json`, `${JSON.stringify({ spec: 'rig-parts-check/1', bar_outcomes: {}, build: { model_sha256: model }, PASS: true }, null, 1)}\n`);
  expect(recordCommand(['rig', dir, '--from', RIG_NEXT, '--config', rigConfigPath], testClock.now()).exit).toBe(0);
}

test('#1029 parts then rig commit exact scoped paths and preserve unrelated staged bytes', () => {
  const dir = project({ withLedger: false });
  const env = gitEnv();
  const git = (...args: string[]): string => {
    const result = run(['git', ...args], dir, env);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  const old = '/derived/\r\n/outputs/\r\n/outputs/parts/excluded.bin\n# /outputs/\r\n # custom ';
  const original = Buffer.concat([Buffer.from(old), Buffer.from([0xff])]);
  const migrated = Buffer.concat([Buffer.from(old.replace('/outputs/\r\n', '/outputs/*\r\n!/outputs/parts/\r\n')), Buffer.from([0xff])]);
  const deleted = 'outputs/parts/obsolete.bin';
  const excluded = 'outputs/parts/excluded.bin';
  write(dir, '.gitignore', original);
  write(dir, 'unrelated.txt', 'original');
  write(dir, deleted, 'remove with the old tree');
  write(dir, `${NEXT}/excluded.bin`, 'stays in the record inventory only');
  git('init', '-q');
  git('config', 'user.name', 'Synthetic Test');
  git('config', 'user.email', 'synthetic@example.com');
  git('config', 'core.autocrlf', 'false');
  git('add', '--', '.');
  git('add', '--force', '--', deleted);
  git('commit', '-qm', 'Seed synthetic project');
  write(dir, 'unrelated.txt', 'staged');
  git('add', '--', 'unrelated.txt');
  const index = git('ls-files', '--stage', '--', 'unrelated.txt');
  const baseline = checkProject(dir).refusals;

  const result = cli(['record', ...args(dir), '--json'], dir, env);
  if (result.code !== 0) console.error(result.stderr);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('gitignore: /outputs/ -> /outputs/* !/outputs/parts/\n');
  expect(JSON.parse(result.stdout)).toEqual(parts(dir));
  expect(readFileSync(join(dir, '.gitignore'))).toEqual(migrated);
  const committedIgnore = Bun.spawnSync(['git', 'show', 'HEAD:.gitignore'], { cwd: dir, env });
  expect(committedIgnore.exitCode).toBe(0);
  expect(committedIgnore.stdout).toEqual(migrated);
  expect(checkProject(dir).refusals).toEqual(baseline);

  const inventory = (parts(dir).files as { path: string; sha256: string }[]).map(file => file.path);
  expect(inventory).toContain(excluded);
  const added = inventory.filter(path => path !== excluded);
  const partPaths = ['.gitignore', ...added, deleted, 'project.json'].sort();
  const changes = (paths: string[]) => paths.map(path =>
    `changed: ${path} ${path === deleted ? 'removed' : sha(readFileSync(join(dir, path))).slice(0, 12)}`);
  const version = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as { name: string; version: string };
  const trailer = ['stale: none', `create: ${version.name} ${version.version}`];
  const partMessage = [
    'parts: record current output', '', `writer: rig-create record parts --from ${NEXT} --config ${CONFIG}`,
    ...changes(partPaths), ...trailer,
  ].join('\n');
  expect(git('log', '-2', '--format=%B')).toBe(`${partMessage}\n\nSeed synthetic project\n\n`);
  expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim().split('\n')).toEqual(partPaths);
  expect(git('ls-files', '--', 'outputs/parts').trim().split('\n')).toEqual(added);
  expect(git('status', '--porcelain')).toBe('M  unrelated.txt\n');
  expect(git('ls-files', '--stage', '--', 'unrelated.txt')).toBe(index);

  recordDownstreamRig(dir, CONFIG);
  const rigMessage = [
    'rig: record current output', '', `writer: rig-create record rig --from ${RIG_NEXT} --config ${CONFIG}`,
    ...changes(['project.json']), ...trailer,
  ].join('\n');
  expect(git('log', '-2', '--format=%B')).toBe(`${rigMessage}\n\n${partMessage}\n\n`);
  expect(git('ls-files', '--', 'outputs/rig')).toBe('');
  expect(git('status', '--porcelain')).toBe('M  unrelated.txt\n');
  expect(git('ls-files', '--stage', '--', 'unrelated.txt')).toBe(index);
  expect(checkProject(dir).refusals).toEqual(baseline);
});

test('planted: one byte changed in the painting marks parts stale and, transitively, a rig built from outputs/parts', () => {
  const dir = project();
  expect(record(dir).exit).toBe(0);
  recordDownstreamRig(dir);
  expect((rig(dir).built_from as JsonObject[]).some(b => b.path === 'outputs/parts/rig/parts.json')).toBe(true);
  expect(codes(checkProject(dir).warnings, 'OUTPUT_STALE')).toBe(0);

  // Timestamp-only edit in outputs/parts/run.json marks nothing stale.
  const runPath = join(dir, 'outputs/parts/run.json');
  const originalRun = readFileSync(runPath, 'utf8');
  const firstStamp = (JSON.parse(originalRun) as { started_at: string }).started_at;
  const bumpedRun = originalRun.replaceAll(firstStamp, '2026-11-25T09:30:00.000Z');
  expect(bumpedRun).toContain('2026-11-25T09:30:00.000Z');
  writeFileSync(runPath, bumpedRun);
  expect(codes(checkProject(dir).warnings, 'OUTPUT_STALE')).toBe(0);
  expect(codes(checkProject(dir).refusals, 'CURRENT_MALFORMED')).toBe(0);

  // Flip one byte in the painting: parts is directly stale, and rig (whose built_from names outputs/parts/rig/parts.json) is transitively stale.
  const paintingBytes = Buffer.from(readFileSync(join(dir, PAINTING)));
  paintingBytes[paintingBytes.length - 1]! ^= 1;
  writeFileSync(join(dir, PAINTING), paintingBytes);
  const report = checkProject(dir);
  expect(codes(report.refusals, 'CURRENT_MALFORMED')).toBe(0);
  const stale = report.warnings.filter(f => f.code === 'OUTPUT_STALE');
  expect(stale.map(f => f.path)).toEqual(['current.parts', 'current.rig']);
  expect(stale[0]!.message).toContain(PAINTING);
  expect(stale[1]!.message).toContain('upstream parts is stale');
});

test('check validates current.parts shape under CURRENT_MALFORMED and leaves projects without current.parts untouched', () => {
  const legacy = fixture();
  const legacyReport = checkProject(legacy);
  expect(codes([...legacyReport.refusals, ...legacyReport.warnings], 'CURRENT_MALFORMED')).toBe(0);
  expect(codes([...legacyReport.refusals, ...legacyReport.warnings], 'OUTPUT_STALE')).toBe(0);

  const dir = project();
  expect(record(dir).exit).toBe(0);
  const p = read(dir);
  const currentParts = (p.current as JsonObject).parts as JsonObject;
  currentParts.rebuild = { recorded: false, note: 'not on parts' };
  // Extra keys on parts are harmless, whereas a built_from naming outputs/parts itself or a broken files_sha256 refuses CURRENT_MALFORMED.
  delete currentParts.rebuild;
  (currentParts.built_from as JsonObject[]).push({ path: 'outputs/parts/rig/parts.json', sha256: 'a'.repeat(64) });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  const bad = checkProject(dir);
  expect(bad.refusals.filter(f => f.code === 'CURRENT_MALFORMED').map(f => f.path)).toEqual(['current.parts.built_from[3]']);
  // TreeFiles helper still matches outputs/parts on disk.
  expect(treeFiles(dir, 'outputs/parts').length).toBeGreaterThan(0);
});

/** Rewrite NEXT/rig/parts.json (updating run.json and parts-check.json bindings) before calling record parts. */
function rewriteProducerPartsManifest(
  dir: string,
  mutate: (manifest: JsonObject) => void,
): void {
  const manifestRel = 'rig/parts.json';
  const manifest = JSON.parse(readFileSync(join(dir, NEXT, manifestRel), 'utf8')) as JsonObject;
  mutate(manifest);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const digest = sha(text);
  write(dir, `${NEXT}/${manifestRel}`, text);
  const run = JSON.parse(readFileSync(join(dir, NEXT, 'run.json'), 'utf8')) as { outputs: { path: string; sha256: string }[] };
  run.outputs.find(o => o.path === manifestRel)!.sha256 = digest;
  write(dir, `${NEXT}/run.json`, JSON.stringify(run));
  const report = JSON.parse(readFileSync(join(dir, NEXT, 'check/parts-check.json'), 'utf8')) as { inputs: { path: string; sha256: string | null }[] };
  report.inputs.find(i => i.path === 'parts.json')!.sha256 = digest;
  write(dir, `${NEXT}/check/parts-check.json`, JSON.stringify(report));
}

test('a rig-only config edit leaves current.parts and downstream current.rig current when assembly_config is present', () => {
  const dir = project();
  rewriteProducerPartsManifest(dir, manifest => {
    delete manifest.assembly_config;
    manifest.assembly_config = assemblyConfigReading(
      join(dir, CONFIG),
      manifest as unknown as Parameters<typeof assemblyConfigReading>[1],
    ) as unknown as JsonObject;
  });
  expect(record(dir).exit).toBe(0);

  // Edit rig-only fields that assemble does not read (bones, meshes, motion), then record the rebuilt rig on that config.
  const cfg = JSON.parse(readFileSync(join(dir, CONFIG), 'utf8')) as JsonObject;
  cfg.bones = [
    ...(cfg.bones as JsonObject[]),
    { name: 'head', parent: 'body', at: [64, 28] },
  ];
  cfg.meshes = { face: { grid: 16 } };
  (cfg.motion as JsonObject).duration = 6;
  write(dir, CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  expect(sha(readFileSync(join(dir, CONFIG)))).not.toBe(
    ((parts(dir).built_from as JsonObject[]).find(b => b.path === CONFIG) as JsonObject).sha256,
  );
  recordDownstreamRig(dir, CONFIG);

  const afterRigOnly = checkProjectRaw(dir, undefined, { now: testClock.now(), readOnly: true, recordReads: true });
  expect(codes(afterRigOnly.refusals, 'CURRENT_MALFORMED')).toBe(0);
  expect(afterRigOnly.warnings.filter(f => f.code === 'OUTPUT_STALE')).toEqual([]);
});

test('editing an assembly-read config field (or making the config unreadable or missing) marks parts stale and transitively rig stale', () => {
  const dir = project();
  rewriteProducerPartsManifest(dir, manifest => {
    delete manifest.assembly_config;
    manifest.assembly_config = assemblyConfigReading(
      join(dir, CONFIG),
      manifest as unknown as Parameters<typeof assemblyConfigReading>[1],
    ) as unknown as JsonObject;
  });
  expect(record(dir).exit).toBe(0);

  // Edit fields assemble reads (assemble.rig_scale and assemble.seam): parts is stale naming those fields, and rig is transitively stale.
  const cfg = JSON.parse(readFileSync(join(dir, CONFIG), 'utf8')) as JsonObject;
  (cfg.assemble as JsonObject).rig_scale = 0.5;
  (cfg.assemble as JsonObject).seam = 'silhouette';
  write(dir, CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  recordDownstreamRig(dir, CONFIG);

  const stale = checkProject(dir).warnings.filter(f => f.code === 'OUTPUT_STALE');
  expect(stale.map(f => f.path)).toEqual(['current.parts', 'current.rig']);
  expect(stale[0]!.message).toContain(CONFIG);
  expect(stale[0]!.message).toContain('assemble.rig_scale');
  expect(stale[0]!.message).toContain('assemble.seam');
  expect(stale[1]!.message).toContain('upstream parts is stale');

  // Unreadable config throws inside assemblyConfigChanges: check never throws, marks parts stale, and includes the error text.
  write(dir, CONFIG, '{invalid json\n');
  const unreadable = checkProject(dir).warnings.filter(f => f.code === 'OUTPUT_STALE');
  expect(unreadable.map(f => f.path)).toEqual(['current.parts', 'current.rig']);
  expect(unreadable[0]!.message).toContain(CONFIG);
  expect(unreadable[0]!.message).toContain('CONFIG_IS_JSON');

  // Missing config stays stale with "is missing" as before.
  rmSync(join(dir, CONFIG));
  const missing = checkProject(dir).warnings.filter(f => f.code === 'OUTPUT_STALE');
  expect(missing.map(f => f.path)).toEqual(['current.parts', 'current.rig']);
  expect(missing[0]!.message).toContain(`${CONFIG} is missing`);
});

test('a parts.json replaced after record does not vouch for the config: the whole-file hash decides', () => {
  const dir = project();
  rewriteProducerPartsManifest(dir, manifest => {
    delete manifest.assembly_config;
    manifest.assembly_config = assemblyConfigReading(
      join(dir, CONFIG),
      manifest as unknown as Parameters<typeof assemblyConfigReading>[1],
    ) as unknown as JsonObject;
  });
  expect(record(dir).exit).toBe(0);

  // Edit an assembly-read field, then overwrite the recorded parts.json with a reading of the edited config (a newer assemble, not recorded).
  const cfg = JSON.parse(readFileSync(join(dir, CONFIG), 'utf8')) as JsonObject;
  (cfg.assemble as JsonObject).rig_scale = 0.5;
  write(dir, CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  const manifestPath = 'outputs/parts/rig/parts.json';
  const manifest = JSON.parse(readFileSync(join(dir, manifestPath), 'utf8')) as JsonObject;
  manifest.assembly_config = assemblyConfigReading(
    join(dir, CONFIG),
    manifest as unknown as Parameters<typeof assemblyConfigReading>[1],
  ) as unknown as JsonObject;
  write(dir, manifestPath, JSON.stringify(manifest));

  const stale = checkProject(dir).warnings.filter(f => f.code === 'OUTPUT_STALE' && f.path === 'current.parts');
  expect(stale).toHaveLength(1);
  expect(stale[0]!.message).toContain(`${CONFIG} now hashes`);
});

test('legacy parts.json without assembly_config falls back to whole-file sha256 comparison', () => {
  const dir = project();
  rewriteProducerPartsManifest(dir, manifest => {
    delete manifest.assembly_config;
  });
  expect(record(dir).exit).toBe(0);
  recordDownstreamRig(dir, CONFIG);
  expect(codes(checkProject(dir).warnings, 'OUTPUT_STALE')).toBe(0);

  // Even a rig-only edit changes the whole-file sha256, so the legacy fallback marks parts (and transitively rig) stale.
  const cfg = JSON.parse(readFileSync(join(dir, CONFIG), 'utf8')) as JsonObject;
  cfg.bones = [
    ...(cfg.bones as JsonObject[]),
    { name: 'head', parent: 'body', at: [64, 28] },
  ];
  write(dir, CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  recordDownstreamRig(dir, CONFIG);

  const stale = checkProject(dir).warnings.filter(f => f.code === 'OUTPUT_STALE');
  expect(stale.map(f => f.path)).toEqual(['current.parts', 'current.rig']);
  expect(stale[0]!.message).toContain(`${CONFIG} now hashes`);
  expect(stale[1]!.message).toContain('upstream parts is stale');
});
