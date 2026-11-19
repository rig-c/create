import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { checkPreparedInputs, derivedCommand } from '../src/prepared-inputs.ts';
import { checkPlateRegistrations, PLATE_RECEIPT_SINCE } from '../src/plate-receipt.ts';
import type { Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { externalMaskEvidence } from './external-receipt-fixture.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { sceneFixture } from './scene-fixture.ts';
import { checkProject, inputCommand, sceneCommand, testClock } from './clock.ts';

const load = createRequire(import.meta.url);
const { publishPlate } = load('@rig-c/parts/src/plate.ts') as typeof import('../node_modules/@rig-c/parts/src/plate.ts');
const { newRaster } = load('@rig-c/parts/src/raster/types.ts') as typeof import('../node_modules/@rig-c/parts/src/raster/types.ts');
const { encodePngBytes } = load('@rig-c/parts/src/raster/png.ts') as typeof import('../node_modules/@rig-c/parts/src/raster/png.ts');
const { MATTE_SPEC, MATTE_GRAPH_ID, MATTE_NODE, MATTE_MODEL, matteGraph, matteGraphHash, matteParams, publishMatte } = load('@rig-c/parts/src/matte.ts') as typeof import('../node_modules/@rig-c/parts/src/matte.ts');

afterEach(() => testClock.reset());
function producer() {
  const dir = tempDir();
  const painting = newRaster(2, 2);
  painting.data.fill(255);
  const paintingBytes = encodePngBytes(painting);
  writeFileSync(join(dir, 'painting.png'), paintingBytes);
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ schema: 'rig-create/project@0', derived: [] }));
  // The installed producer's own atomic writer creates all three real output files offline.
  publishPlate({ out: join(dir, 'plate'), stageTag: 'synthetic', mode: 'foreground', paintingPath: join(dir, 'painting.png'), paintingBytes,
    source: 'figure-mask', sourceDir: dir, mask: { width: 2, height: 2, inside: new Uint8Array([1, 0, 0, 1]) }, plate: painting,
    model: null, params: {}, graph: 'rig-parts/plate-foreground/1', gpu: null });
  const args = ['add', dir, '--source', 'painting.png', '--source', 'plate/mask.png', '--file', 'plate/plate.png', '--operation', 'synthetic producer plate', '--receipt', 'plate/receipt.json', '--json'];
  const project = () => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const findings = () => {
    const ctx = { dir, project: project(), refusals: [] as Finding[], warnings: [] as Finding[] };
    checkPreparedInputs(ctx);
    return ctx;
  };
  return { dir, args, project, findings };
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function matteProducer() {
  const dir = tempDir();
  const painting = newRaster(2, 2);
  painting.data.fill(255);
  const bytes = encodePngBytes(painting);
  const modelMask = newRaster(2, 2);
  modelMask.data.set([0, 0, 0, 255, 64, 64, 64, 255, 8, 8, 8, 255, 128, 128, 128, 255]);
  const paintingPath = join(dir, 'painting.png');
  const receiptPath = join(dir, 'matte/receipt.json');
  const projectPath = join(dir, 'project.json');
  const graph = matteGraph('synthetic.png', 'synthetic');
  writeFileSync(paintingPath, bytes);
  writeFileSync(projectPath, JSON.stringify({ schema: 'rig-create/project@0', derived: [] }));
  const receipt = publishMatte(join(dir, 'matte'), paintingPath, bytes, encodePngBytes(modelMask), {
    model: { node: MATTE_NODE, name: MATTE_MODEL, checkpoint_sha256: 'a'.repeat(64), checkpoint_sha256_from: 'declared' },
    params: matteParams(64, 10),
    graph: { id: MATTE_GRAPH_ID, api: graph, sha256: matteGraphHash(graph) },
    gpu: 'synthetic', input_transform: null, input_sha256: sha256(bytes),
  });
  const args = ['add', dir, '--source', 'painting.png', '--file', 'matte/mask.png', '--receipt', 'matte/receipt.json', '--json'];
  const project = () => JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
  const findings = () => {
    const ctx = { dir, project: project(), refusals: [] as Finding[], warnings: [] as Finding[] };
    checkPreparedInputs(ctx);
    return ctx;
  };
  return { dir, args, receipt, receiptPath, projectPath, project, findings };
}

test('derived add binds the published matte receipt and its painting without operation', () => {
  const f = matteProducer();
  const result = cli(['derived', ...f.args], f.dir, gitEnv());
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    kind: 'prepared-input',
    source: { path: 'painting.png', sha256: f.receipt.painting.sha256 },
    path: 'matte/mask.png', sha256: f.receipt.output.sha256,
    receipt: { path: 'matte/receipt.json', sha256: sha256(readFileSync(f.receiptPath)), spec: MATTE_SPEC },
  });
  expect(f.findings().refusals).toEqual([]);
  expect(f.findings().warnings).toEqual([]);
});

test('plate receipt still requires operation', () => {
  const f = producer();
  f.args.splice(f.args.indexOf('--operation'), 2);
  const path = join(f.dir, 'project.json');
  const before = readFileSync(path);
  expect(() => derivedCommand(f.args)).toThrow(expect.objectContaining({ code: 'DERIVED_USAGE' }));
  expect(readFileSync(path)).toEqual(before);
});

test.each(['painting.png', 'matte/model-mask.png', 'matte/mask.png'])('matte writer and check refuse changed producer bytes at %s', path => {
  const f = matteProducer();
  derivedCommand(f.args);
  const before = readFileSync(f.projectPath);
  writeFileSync(join(f.dir, path), 'changed');
  expect(f.findings().refusals.map(f => f.code)).toEqual(['MATTE_RECEIPT_INVALID']);
  expect(() => derivedCommand(f.args)).toThrow(expect.objectContaining({ code: 'MATTE_RECEIPT_INVALID' }));
  expect(readFileSync(f.projectPath)).toEqual(before);
});

test.each(['matte/model-mask.png', 'matte/mask.png'])('missing matte artifact %s is a refusal', path => {
  const f = matteProducer();
  derivedCommand(f.args);
  rmSync(join(f.dir, path));
  expect(f.findings().refusals.map(f => f.code)).toEqual(['MATTE_RECEIPT_INVALID']);
  expect(f.findings().warnings).toEqual([]);
});

test.each(['receipt bytes', 'receipt spec'])('check refuses a mismatched matte binding by %s', mismatch => {
  const f = matteProducer();
  derivedCommand(f.args);
  if (mismatch === 'receipt bytes') {
    writeFileSync(f.receiptPath, readFileSync(f.receiptPath, 'utf8') + '\n');
  } else {
    const plate = producer();
    const bytes = readFileSync(join(plate.dir, 'plate/receipt.json'));
    writeFileSync(f.receiptPath, bytes);
    const project = f.project();
    ((project.derived as JsonObject[])[0]!.receipt as JsonObject).sha256 = sha256(bytes);
    writeFileSync(f.projectPath, JSON.stringify(project));
  }
  expect(f.findings().refusals.map(f => f.code)).toEqual(['MATTE_RECEIPT_INVALID']);
});

test.each(['painting path', 'output path', 'extra source', 'raw path'])('matte writer refuses %s even with intact declared hashes', mismatch => {
  const f = matteProducer();
  const before = readFileSync(f.projectPath);
  if (mismatch === 'painting path') {
    cpSync(join(f.dir, 'painting.png'), join(f.dir, 'other.png'));
    f.args[f.args.indexOf('--source') + 1] = 'other.png';
  } else if (mismatch === 'output path') {
    cpSync(join(f.dir, 'matte/mask.png'), join(f.dir, 'matte/other.png'));
    f.args[f.args.indexOf('--file') + 1] = 'matte/other.png';
  } else if (mismatch === 'extra source') {
    f.args.push('--source', 'matte/model-mask.png');
  } else {
    cpSync(join(f.dir, 'matte/model-mask.png'), join(f.dir, 'matte/other.png'));
    writeFileSync(f.receiptPath, JSON.stringify({ ...f.receipt, raw_output: { ...f.receipt.raw_output, path: 'other.png' } }));
  }
  expect(() => derivedCommand(f.args)).toThrow(expect.objectContaining({ code: 'MATTE_RECEIPT_INVALID' }));
  expect(readFileSync(f.projectPath)).toEqual(before);
});

test('a matte receipt does not qualify a derived scene plate', () => {
  const f = matteProducer();
  derivedCommand(f.args);
  const project = f.project();
  const entry = (project.derived as JsonObject[])[0]!;
  const bytes = Buffer.from(JSON.stringify({ plates: [{ path: entry.path, sha256: entry.sha256, registered: { kind: 'derived', ref: 'derived[0]' } }] }));
  writeFileSync(join(f.dir, 'scene.json'), bytes);
  project.scenes = [{ path: 'scene.json', sha256: sha256(bytes), at: PLATE_RECEIPT_SINCE }];
  writeFileSync(f.projectPath, JSON.stringify(project));
  expect(f.findings().refusals.map(f => f.code)).toEqual(['PLATE_RECEIPT_INVALID']);
});

test('installed producer receipt binds raw bytes and relative paths, and checks without a scene', () => {
  const f = producer();
  const result = cli(['derived', ...f.args], f.dir, gitEnv());
  expect(result.code).toBe(0);
  const entry = JSON.parse(result.stdout) as JsonObject;
  expect(entry.receipt).toEqual(expect.objectContaining({ path: 'plate/receipt.json', spec: 'rig-parts-plate-receipt/1' }));
  expect(f.findings().refusals).toEqual([]);
  expect(f.findings().warnings).toEqual([]);
  writeFileSync(join(f.dir, 'plate/receipt.json'), readFileSync(join(f.dir, 'plate/receipt.json'), 'utf8') + '\n');
  expect(f.findings().refusals.map(f => f.code)).toContain('PLATE_RECEIPT_INVALID');
});

const cases: [string, (f: ReturnType<typeof producer>) => void][] = [
  ['missing', f => rmSync(join(f.dir, 'plate/receipt.json'))],
  ['outside', f => { f.args[f.args.indexOf('--receipt') + 1] = '../receipt.json'; }],
  ['absolute', f => { f.args[f.args.indexOf('--receipt') + 1] = join(f.dir, 'plate/receipt.json'); }],
  ['symlink', f => { const path = join(f.dir, 'plate/receipt.json'); const bytes = readFileSync(path); rmSync(path); writeFileSync(join(f.dir, 'original.json'), bytes); symlinkSync('../original.json', path); }],
  ['symlink parent', f => { symlinkSync('plate', join(f.dir, 'alias')); f.args[f.args.indexOf('--receipt') + 1] = 'alias/receipt.json'; }],
  ['unknown spec', f => editReceipt(f, r => { r.spec = 'unknown/1'; })],
  ['key order', f => editReceipt(f, r => { const spec = r.spec; delete r.spec; r.spec = spec!; })],
  ...['painting', 'mask', 'output'].map(field => [`${field} hash`, (f: ReturnType<typeof producer>) => editReceipt(f, r => { (r[field] as JsonObject).sha256 = '0'.repeat(64); })] as [string, (f: ReturnType<typeof producer>) => void]),
  ['path mismatch', f => editReceipt(f, r => { (r.painting as JsonObject).path = '../different.png'; })],
];
function editReceipt(f: ReturnType<typeof producer>, edit: (r: JsonObject) => void): void {
  const path = join(f.dir, 'plate/receipt.json');
  const r = JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
  edit(r); writeFileSync(path, JSON.stringify(r));
}
for (const [name, edit] of cases) {
  test(`writer refuses ${name} with project bytes unchanged`, () => {
    const f = producer(); edit(f);
    const before = readFileSync(join(f.dir, 'project.json'));
    expect(() => derivedCommand(f.args)).toThrow(expect.objectContaining({ code: 'PLATE_RECEIPT_INVALID' }));
    expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  });
}

test('check refuses an unknown recorded spec even without a scene', () => {
  const f = producer(); derivedCommand(f.args);
  const p = f.project();
  ((p.derived as JsonObject[])[0]!.receipt as JsonObject).spec = 'unknown/1';
  writeFileSync(join(f.dir, 'project.json'), JSON.stringify(p));
  expect(f.findings().refusals).toEqual([expect.objectContaining({
    code: 'PLATE_RECEIPT_INVALID',
    message: expect.stringContaining('rig-parts-plate-receipt/1 or rig-parts-matte-receipt/1 or rig-parts-external-receipt/1'),
  })]);
});

function externalProducer() {
  const dir = tempDir();
  const { paintingBytes, maskBytes, receipt } = externalMaskEvidence();
  const receiptPath = join(dir, 'external/receipt.json');
  const projectPath = join(dir, 'project.json');
  mkdirSync(join(dir, 'external'));
  writeFileSync(join(dir, 'painting.png'), paintingBytes);
  writeFileSync(join(dir, 'external/mask.png'), maskBytes);
  const writeReceipt = (report: JsonObject) => writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`);
  writeReceipt(receipt);
  writeFileSync(projectPath, JSON.stringify({ schema: 'rig-create/project@0', derived: [] }));
  const args = ['add', dir, '--source', 'painting.png', '--file', 'external/mask.png', '--receipt', 'external/receipt.json', '--json'];
  const project = () => JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
  const findings = () => {
    const ctx = { dir, project: project(), refusals: [] as Finding[], warnings: [] as Finding[] };
    checkPreparedInputs(ctx);
    return ctx;
  };
  return { dir, args, receipt, receiptPath, projectPath, writeReceipt, project, findings };
}

test.each(['checkpoint_sha256', 'graph_sha256', 'script_sha256'])('external mask writer and check bind %s provenance without operation', digest => {
  const f = externalProducer();
  const producer = { tool: 'synthetic', ...(digest === 'checkpoint_sha256' ? { model: 'synthetic model' } : {}), [digest]: 'd'.repeat(64) };
  f.writeReceipt({ ...f.receipt, producer });
  const result = derivedCommand(f.args);
  expect(result.exit).toBe(0);
  const binding = {
    kind: 'prepared-input', source: { path: 'painting.png', sha256: f.receipt.painting.sha256 },
    path: 'external/mask.png', sha256: f.receipt.file.sha256,
    receipt: { path: 'external/receipt.json', sha256: sha256(readFileSync(f.receiptPath)), spec: f.receipt.spec },
  };
  expect(JSON.parse(result.stdout)).toEqual(binding);
  expect(f.project().derived).toEqual([binding]);
  expect(f.findings().refusals).toEqual([]);
  expect(f.findings().warnings).toEqual([]);
});

test('external mask check binds the reported grid without remeasuring the PNGs', () => {
  const f = externalProducer();
  f.writeReceipt({ ...f.receipt, grid: { width: 7, height: 11 } });
  expect(derivedCommand(f.args).exit).toBe(0);
  expect(f.findings().refusals).toEqual([]);
});

test.each<JsonObject>([
  { producer: { script_sha256: 'a'.repeat(64) } },
  { producer: { tool: ' ', script_sha256: 'a'.repeat(64) } },
  { producer: { tool: 'synthetic', model: ' ', script_sha256: 'a'.repeat(64) } },
  { producer: { tool: 'synthetic' } },
  { producer: { tool: 'synthetic', script_sha256: 'a'.repeat(64), graph_sha256: 'a'.repeat(64) } },
  { producer: { tool: 'synthetic', script_sha256: 'A'.repeat(64) } },
  { producer: { tool: 'synthetic', artifact_sha256: 'a'.repeat(64) } },
  { producer: { tool: 'synthetic', script_sha256: 'a'.repeat(64), extra: true } },
  { grid: { width: 0, height: 2 } },
  { grid: { width: 1.5, height: 2 } },
])('external mask writer and check reject malformed receipt %j', fields => {
  const f = externalProducer();
  const before = readFileSync(f.projectPath);
  f.writeReceipt({ ...f.receipt, ...fields });
  expect(() => derivedCommand(f.args)).toThrow(expect.objectContaining({ code: 'EXTERNAL_RECEIPT_INVALID' }));
  expect(readFileSync(f.projectPath)).toEqual(before);

  f.writeReceipt(f.receipt);
  derivedCommand(f.args);
  f.writeReceipt({ ...f.receipt, ...fields });
  const project = f.project();
  const entry = (project.derived as JsonObject[])[0]!;
  (entry.receipt as JsonObject).sha256 = sha256(readFileSync(f.receiptPath));
  writeFileSync(f.projectPath, JSON.stringify(project));
  expect(f.findings().refusals.map(f => f.code)).toEqual(['EXTERNAL_RECEIPT_INVALID']);
});

test('external receipt kind refusal names mask and the accepted specs before writing', () => {
  const f = externalProducer();
  const before = readFileSync(f.projectPath);
  f.writeReceipt({ ...f.receipt, kind: 'fill' });
  expect(() => derivedCommand(f.args)).toThrow(expect.objectContaining({
    code: 'EXTERNAL_RECEIPT_INVALID',
    message: expect.stringContaining('requires kind "mask"; accepted derived receipt specs are rig-parts-plate-receipt/1 or rig-parts-matte-receipt/1 or rig-parts-external-receipt/1'),
  }));
  expect(readFileSync(f.projectPath)).toEqual(before);
});

test.each(['painting.png', 'external/mask.png'])('external mask refuses tampered %s even when the receipt is intact', path => {
  const f = externalProducer();
  derivedCommand(f.args);
  const before = readFileSync(f.projectPath);
  writeFileSync(join(f.dir, path), 'tampered');
  expect(f.findings().refusals.map(f => f.code)).toEqual(['EXTERNAL_RECEIPT_INVALID']);
  expect(() => derivedCommand(f.args)).toThrow(expect.objectContaining({ code: 'EXTERNAL_RECEIPT_INVALID' }));
  expect(readFileSync(f.projectPath)).toEqual(before);
});

test('external mask check rejects reserialization of the bound receipt', () => {
  const f = externalProducer();
  derivedCommand(f.args);
  writeFileSync(f.receiptPath, JSON.stringify(f.receipt));
  expect(f.findings().refusals).toEqual([expect.objectContaining({
    code: 'EXTERNAL_RECEIPT_INVALID', message: expect.stringContaining('receipt bytes differ'),
  })]);
});

test.each(['--source', '--file'])('external mask writer rejects matching bytes at another %s locator', option => {
  const f = externalProducer();
  const before = readFileSync(f.projectPath);
  const index = f.args.indexOf(option) + 1;
  cpSync(join(f.dir, f.args[index]!), join(f.dir, 'copy.png'));
  f.args[index] = 'copy.png';
  expect(() => derivedCommand(f.args)).toThrow(expect.objectContaining({ code: 'EXTERNAL_RECEIPT_INVALID' }));
  expect(readFileSync(f.projectPath)).toEqual(before);
});

test('an external mask receipt does not qualify a derived scene plate', () => {
  const f = externalProducer();
  derivedCommand(f.args);
  const project = f.project();
  const entry = (project.derived as JsonObject[])[0]!;
  const bytes = Buffer.from(JSON.stringify({ plates: [{ path: entry.path, sha256: entry.sha256, registered: { kind: 'derived', ref: 'derived[0]' } }] }));
  writeFileSync(join(f.dir, 'scene.json'), bytes);
  project.scenes = [{ path: 'scene.json', sha256: sha256(bytes), at: PLATE_RECEIPT_SINCE }];
  writeFileSync(f.projectPath, JSON.stringify(project));
  expect(f.findings().refusals.map(f => f.code)).toEqual(['PLATE_RECEIPT_INVALID']);
});

function derivedScene() {
  const f = sceneFixture();
  const p = f.load();
  p.inputs = (p.inputs as JsonObject[]).filter(input => input.path !== f.background.path);
  p.derived = [{ kind: 'prepared-input', ...f.background, source: f.foreground, operation: 'Synthetic preparation' }];
  f.save(p);
  return f;
}
for (const at of ['2026-11-07T23:59:59Z', PLATE_RECEIPT_SINCE]) {
  test(`agent scene writer refuses missing producer receipt at ${at} byte-identically`, () => {
    const f = derivedScene(); testClock.set(at);
    const before = readFileSync(join(f.dir, 'project.json'));
    expect(() => f.writeScene()).toThrow(expect.objectContaining({ code: 'SCENE_PLATE_UNREGISTERED' }));
    expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  });
  test(`historical human scene retains receipt date and earliest-registration checks at ${at}`, () => {
    const f = derivedScene(); testClock.set(at); f.seedHistoricalScene();
    const ctx = { dir: f.dir, project: f.load(), refusals: [] as Finding[], warnings: [] as Finding[] };
    checkPlateRegistrations(ctx);
    if (at === PLATE_RECEIPT_SINCE) {
      expect(ctx.refusals.map(f => f.code)).toEqual(['PLATE_RECEIPT_MISSING']);
      expect(ctx.warnings).toEqual([]);
    } else {
      expect(ctx.refusals).toEqual([]);
      expect(ctx.warnings.map(f => f.code)).toEqual(['PLATE_RECEIPT_MISSING']);
      testClock.set(PLATE_RECEIPT_SINCE); f.seedHistoricalScene();
      const later = { ...ctx, project: f.load(), warnings: [] as Finding[] };
      checkPlateRegistrations(later);
      expect(later.refusals).toEqual([]);
      expect(later.warnings.map(f => f.code)).toEqual(['PLATE_RECEIPT_MISSING']);
    }
  });
}

test('new input plates remain outside the receipt contract', () => {
  const f = sceneFixture(); testClock.set(PLATE_RECEIPT_SINCE);
  expect(f.writeScene().exit).toBe(0);
});


test('scene writer refuses an existing missing-receipt finding instead of baseline-masking it', () => {
  const f = derivedScene();
  f.seedHistoricalScene();
  const p = f.load();
  (p.scenes as JsonObject[])[0]!.at = PLATE_RECEIPT_SINCE;
  f.save(p);
  testClock.set(PLATE_RECEIPT_SINCE);
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(checkProject(f.dir).refusals.map(f => f.code)).toContain('PLATE_RECEIPT_MISSING');
  expect(() => f.writeScene()).toThrow(expect.objectContaining({ code: 'SCENE_PLATE_UNREGISTERED' }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});


test('check compares declared file hashes even when the receipt byte binding is current', () => {
  const f = producer(); derivedCommand(f.args);
  const p = f.project();
  const entry = (p.derived as JsonObject[])[0]!;
  (entry.sources as JsonObject[])[0]!.sha256 = '0'.repeat(64);
  writeFileSync(join(f.dir, 'project.json'), JSON.stringify(p));
  expect(f.findings().refusals.map(f => f.code)).toContain('PLATE_RECEIPT_INVALID');
});

for (const field of ['path', 'sha256', 'spec']) {
  test(`check refuses missing receipt binding ${field}`, () => {
    const f = producer(); derivedCommand(f.args);
    const p = f.project();
    delete ((p.derived as JsonObject[])[0]!.receipt as JsonObject)[field];
    writeFileSync(join(f.dir, 'project.json'), JSON.stringify(p));
    expect(f.findings().refusals.map(f => f.code)).toContain('PLATE_RECEIPT_INVALID');
  });
}


test('project-relative receipt spelling accepts dot components and either source order', () => {
  const f = producer();
  f.args[f.args.indexOf('--receipt') + 1] = './plate/receipt.json';
  const first = f.args.indexOf('--source') + 1;
  const second = f.args.indexOf('--source', first) + 1;
  [f.args[first], f.args[second]] = [f.args[second]!, f.args[first]!];
  expect(derivedCommand(f.args).exit).toBe(0);
  expect(f.findings().refusals).toEqual([]);
});


test('producer receipt records through derived add and registers a new scene through the public writers', () => {
  const producerFiles = producer();
  const f = sceneFixture();
  cpSync(join(producerFiles.dir, 'painting.png'), join(f.dir, 'painting.png'));
  cpSync(join(producerFiles.dir, 'plate'), join(f.dir, 'plate'), { recursive: true });
  testClock.set(PLATE_RECEIPT_SINCE);
  const baseline = checkProject(f.dir).refusals;
  for (const path of ['painting.png', 'plate/mask.png']) {
    inputCommand(['add', path, f.dir, '--origin', 'Synthetic producer source']);
  }
  producerFiles.args[1] = f.dir;
  expect(derivedCommand(producerFiles.args).exit).toBe(0);
  f.designateScene(f.model.stage, 'plate/plate.png');
  const selectedBaseline = checkProject(f.dir).refusals;
  expect(selectedBaseline).toEqual(baseline);
  const args = f.args();
  args[args.indexOf('--background') + 1] = 'plate/plate.png';
  expect(sceneCommand(args).exit).toBe(0);
  expect(checkProject(f.dir).refusals).toEqual(baseline);
  const ctx = { dir: f.dir, project: f.load(), refusals: [] as Finding[], warnings: [] as Finding[] };
  checkPreparedInputs(ctx);
  expect(ctx.refusals).toEqual([]);
  expect(ctx.warnings).toEqual([]);
});
