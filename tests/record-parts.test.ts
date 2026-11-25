import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { EXAMPLE_SOURCE_DATE_EPOCH } from '../scripts/example-time.ts';
import { EXAMPLE_SEETHROUGH } from '../scripts/generate-example-parts.ts';
import { outputSetHash, treeFiles } from '../src/current.ts';
import { recordCommand } from '../src/record.ts';
import { Refusal } from '../src/refusal.ts';
import { TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { checkProject, testClock } from './clock.ts';
import { fixture } from './fixtures.ts';
import { treeDigest } from './helpers.ts';

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

function project(): string {
  const dir = fixture(() => {}, 'example-project.json');
  const src = builtTemplate();
  for (const rel of [PAINTING, LAYERS_DIR, CONFIG]) cpSync(join(src, rel), join(dir, rel), { recursive: true });
  producerOut(dir);
  return dir;
}

const args = (dir: string, extra: string[] = []): string[] => ['parts', dir, '--from', NEXT, '--config', CONFIG, ...extra];
const record = (dir: string, extra: string[] = []) => recordCommand(args(dir, extra), testClock.now());

function refused(fn: () => unknown, code: string): void {
  try { fn(); } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

test('record parts writes current.parts with the §1.3 shape and renames the producer output into outputs/parts', () => {
  const dir = project();
  const before = checkProject(dir);
  const producerBytes = treeDigest(join(dir, NEXT));
  expect(record(dir).exit).toBe(0);
  expect(existsSync(join(dir, NEXT))).toBe(false);
  expect(treeDigest(join(dir, 'outputs/parts'))).toEqual(producerBytes);
  const node = parts(dir);
  expect(Object.keys(node)).toEqual(['at', 'built_by', 'built_with', 'files', 'files_sha256', 'built_from', 'run', 'report']);
  expect(node.built_with).toEqual({ '@rig-c/parts': '2.56.0' });
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
  const dir = project();
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
  const dir = project();
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

  // Old-convention See-through directory mismatch names both <from>/<dir> and <dir>/layers.json.
  const dir2 = project();
  write(dir2, LAYERS_MANIFEST, '{"changed":true}\n');
  let oldConvErr: Refusal | undefined;
  try { record(dir2); } catch (error) { if (error instanceof Refusal) oldConvErr = error; else throw error; }
  expect(oldConvErr?.code).toBe('RECORD_INPUT_CHANGED');
  expect(oldConvErr?.message).toContain(`${NEXT}/${LAYERS_DIR}`);
  expect(oldConvErr?.message).toContain(LAYERS_MANIFEST);
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
function recordDownstreamRig(dir: string): void {
  const rigCfgBytes = readFileSync(join(RIG_PRODUCER, 'config.json'));
  write(dir, 'specs/rig/rig-only.json', rigCfgBytes);
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
  expect(recordCommand(['rig', dir, '--from', RIG_NEXT, '--config', 'specs/rig/rig-only.json'], testClock.now()).exit).toBe(0);
}

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
