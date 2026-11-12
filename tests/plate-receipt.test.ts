import { afterEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { checkPreparedInputs, derivedCommand } from '../src/prepared-inputs.ts';
import { checkPlateRegistrations, PLATE_RECEIPT_SINCE } from '../src/plate-receipt.ts';
import type { Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { sceneFixture } from './scene-fixture.ts';
import { checkProject, inputCommand, sceneCommand, testClock } from './clock.ts';

const load = createRequire(import.meta.url);
const { publishPlate } = load('@rig-c/parts/src/plate.ts') as typeof import('../node_modules/@rig-c/parts/src/plate.ts');
const { newRaster } = load('@rig-c/parts/src/raster/types.ts') as typeof import('../node_modules/@rig-c/parts/src/raster/types.ts');
const { encodePngBytes } = load('@rig-c/parts/src/raster/png.ts') as typeof import('../node_modules/@rig-c/parts/src/raster/png.ts');

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
  expect(f.findings().refusals.map(f => f.code)).toContain('PLATE_RECEIPT_INVALID');
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
