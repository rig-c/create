/** Real producer integration using only helpers shipped in @rig-c/parts 2.38.1. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { locateParts } from '../src/parts-sections.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, draftRigCommand, TEST_NOW, testClock } from './clock.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { clockedCli } from './helpers.ts';

interface Raster { width: number; height: number; data: Uint8ClampedArray }
interface PngModule {
  readPng(file: string): Raster;
  encodePngBytes(image: Raster): Uint8Array;
}
interface ConfigModule {
  configFileReferences(config: unknown): { at: string; value: string }[];
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const json = (file: string): JsonObject => JSON.parse(readFileSync(file, 'utf8')) as JsonObject;

type Box = [number, number, number, number];
interface SyntheticLayer { name: string; depth: number; boxes: Box[]; colour?: [number, number, number] }

/**
 * Local synthetic wrapper inputs replace the producer's unpublished assemble
 * fixture. As in scripts/generate-example-parts.ts, only source pixels and
 * layer manifests are authored here; all reports come from the real CLI.
 * The 128px painting, 64px runs and half-scale rig keep full-run pixels 1:1.
 */
function writeBuildFixture(root: string, png: PngModule): Record<string, unknown> {
  const paint = (width: number, height: number, boxes: Box[], colour: [number, number, number]): Raster => {
    const image: Raster = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (const [left, top, right, bottom] of boxes) {
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        image.data.set([...colour, 255], (y * width + x) * 4);
      }
    }
    return image;
  };
  const colour: [number, number, number] = [100, 60, 40];
  const writeRun = (run: string, layers: SyntheticLayer[]): void => {
    const dir = join(root, run);
    mkdirSync(dir, { recursive: true });
    const entries = layers.map((layer, index) => {
      const left = Math.min(...layer.boxes.map(box => box[0]));
      const top = Math.min(...layer.boxes.map(box => box[1]));
      const right = Math.max(...layer.boxes.map(box => box[2]));
      const bottom = Math.max(...layer.boxes.map(box => box[3]));
      const boxes: Box[] = layer.boxes.map(([x0, y0, x1, y1]) => [x0 - left, y0 - top, x1 - left, y1 - top]);
      const filename = `${index}.png`;
      writeFileSync(join(dir, filename), png.encodePngBytes(paint(right - left, bottom - top, boxes, layer.colour ?? colour)));
      return { name: layer.name, filename, left, top, right, bottom, depth_median: layer.depth };
    });
    writeFileSync(join(dir, 'layers.json'), `${JSON.stringify({ width: 64, height: 64, layers: entries }, null, 2)}\n`);
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'painting.png'), png.encodePngBytes(paint(128, 128, [[0, 0, 128, 128]], colour)));
  writeRun('full', [
    { name: 'headwear', depth: 0.95, boxes: [[4, 2, 20, 14]] },
    { name: 'back hair', depth: 0.9, boxes: [[38, 22, 44, 44]] },
    { name: 'bottomwear', depth: 0.6, boxes: [[48, 30, 62, 54]], colour: [250, 250, 250] },
    { name: 'topwear', depth: 0.5, boxes: [[10, 20, 30, 50]] },
    { name: 'footwear', depth: 0.4, boxes: [[10, 54, 30, 60], [60, 60, 62, 62]] },
    { name: 'neck', depth: 0.3, boxes: [[2, 2, 5, 5]] },
  ]);
  writeRun('head', [
    { name: 'back hair', depth: 0.9, boxes: [[44, 20, 60, 64]] },
    { name: 'face', depth: 0.5, boxes: [[0, 16, 24, 40]] },
  ]);
  const config: Record<string, unknown> = {
    key: 'synthetic-edited-alpha',
    seethrough: { resolution: 64, steps: 1, seed: 0, offload: false, head_box: [32, 0, 96, 64] },
    assemble: {
      rig_scale: 0.5,
      plan: [
        ['hair_back', 'head', 'back hair'], ['topwear', 'full', 'topwear'],
        ['bottomwear', 'full', 'bottomwear'], ['shoes', 'full', 'footwear'], ['face', 'head', 'face'],
      ],
      extend_below_crop: [{ part: 'hair_back', run: 'full', tag: 'back hair' }],
      editor_receipts: { trace_parts: true, receipts: [] },
      stage_map: true,
    },
    // Visible breathing and a swinging skirt, with a still face/shoes anchor.
    // These origins are in rig pixels: the top centres of the two rectangles.
    bones: [
      { name: 'anchor', parent: 'root', at: [0, 0] },
      { name: 'chest', parent: 'root', at: [20, 20] },
      { name: 'skirt', parent: 'root', at: [55, 30] },
    ],
    meshes: {},
    regions: { hair_back: 'anchor', topwear: 'chest', bottomwear: 'skirt', shoes: 'anchor', face: 'anchor' },
    motion: { duration: 1, tracks: [
      { bone: 'chest', prop: 'translatey', amp: 1, period: 1, phase: 0 },
      { bone: 'skirt', prop: 'rotate', amp: 2, period: 1, phase: 0 },
    ] },
  };
  writeFileSync(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

test('#543 source-linked real build alpha receipt rebuild draft binds edited bytes', async () => {
  const previousClock = testClock.now();
  let project: string | undefined;
  testClock.set(TEST_NOW);
  try {
    const dir = project = fixture();
    const installed = locateParts(dir);
    if (installed === null) throw new Error('real build integration requires installed @rig-c/parts');
    const parts = realpathSync(installed);
    mkdirSync(join(dir, 'node_modules/@rig-c'), { recursive: true });
    symlinkSync(parts, join(dir, 'node_modules/@rig-c/parts'));
    expect(realpathSync(locateParts(dir)!)).toBe(parts);

    // Both modules are shipped in the public registry package; no producer test helpers.
    const [png, loader] = await Promise.all([
      import(pathToFileURL(join(parts, 'src/raster/png.ts')).href) as Promise<PngModule>,
      import(pathToFileURL(join(parts, 'src/config.ts')).href) as Promise<ConfigModule>,
    ]);
    const id = 'edited-alpha';
    const relativeRoot = `derived/drafts/${id}`;
    const root = join(dir, relativeRoot);
    const moving = writeBuildFixture(root, png);
    const baselineConfig = readFileSync(join(root, 'config.json'));
    const env = { ...process.env, SOURCE_DATE_EPOCH: String(Math.trunc(testClock.now() / 1000)) };
    // Registry children use published entries; linked-source children inherit only the explicit source condition.
    const runtimeArgs = jobRuntimeExecArgv();
    const build = (config: string, output: string): void => {
      // This is the installed real CLI, with its real assemble/rig/check
      // runners. No injected stages, synthetic reports or success runners.
      const result = Bun.spawnSync([process.execPath, ...runtimeArgs, join(parts, 'cli.ts'),
        'build', '--config', join(root, config), '--source', join(root, 'painting.png'),
        '--full', join(root, 'full'), '--head', join(root, 'head'), '--out', join(root, output)],
      { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
      expect(result.exitCode, `${output}:\n${result.stdout}\n${result.stderr}`).toBe(0);
      // check.json serializes the producer's figures at top level.
      expect(json(join(root, output, 'check/check.json')).PASS).toBe(true);
      for (const file of ['skeleton.json', 'skeleton.atlas', 'skeleton.model.json']) {
        expect(existsSync(join(root, output, 'check/build', file)), `${output}/${file}`).toBe(true);
      }
    };
    build('config.json', 'baseline');

    const part = 'topwear';
    const beforeFile = join(root, 'baseline/parts', `${part}.png`);
    const beforeBytes = readFileSync(beforeFile);
    const original = png.readPng(beforeFile);
    const edited: Raster = { ...original, data: new Uint8ClampedArray(original.data) };
    // Use the first opaque edge pixel rather than punching an interior hole.
    let offset = 3;
    while (offset < edited.data.length && edited.data[offset]! <= 8) offset += 4;
    expect(offset).toBeLessThan(edited.data.length);
    const fromAlpha = edited.data[offset]!;
    expect(fromAlpha).toBeGreaterThan(8);
    edited.data[offset] = 0;
    const editedBytes = png.encodePngBytes(edited);
    mkdirSync(join(root, 'edits'));
    const editedFile = join(root, 'edits', `${part}.png`);
    writeFileSync(editedFile, editedBytes);
    const decoded = png.readPng(editedFile);
    expect([decoded.width, decoded.height]).toEqual([original.width, original.height]);
    expect(decoded.data[offset]).toBe(0);
    const receipt = { part, file: `${part}.png`, sha256: hash(readFileSync(editedFile)),
      from_sha256: hash(beforeBytes), editor: 'synthetic script alpha edit' };
    expect(receipt.sha256).not.toBe(receipt.from_sha256);
    console.log('EDITED_ALPHA_RECEIPT', JSON.stringify({ offset, from_alpha: fromAlpha, to_alpha: 0, receipt }));
    const config = structuredClone(moving);
    Object.assign(config.assemble as Record<string, unknown>, { edited_parts: { dir: 'edits', receipts: [receipt] } });
    writeFileSync(join(root, 'edited.json'), `${JSON.stringify(config, null, 2)}\n`);
    const references = loader.configFileReferences(config);
    expect(references.filter(ref => ref.at.startsWith('assemble.edited_parts'))).toEqual([
      expect.objectContaining({ at: 'assemble.edited_parts.receipts[0].file', value: `edits/${part}.png` }),
    ]);
    build('edited.json', 'rebuilt');
    expect(readFileSync(join(root, 'config.json'))).toEqual(baselineConfig);
    expect(readFileSync(beforeFile)).toEqual(beforeBytes);
    expect(readFileSync(join(root, 'rebuilt/parts', `${part}.png`))).toEqual(Buffer.from(editedBytes));
    const manifest = json(join(root, 'rebuilt/parts.json'));
    const rebuiltPart = arr(manifest.parts).map(obj).find(entry => entry.name === part)!;
    const metadata = obj(obj(rebuiltPart.provenance).edited_part);
    // These are the producer's reported counts for the one known alpha edit;
    // create does not derive or validate producer measurements itself.
    expect(metadata).toMatchObject({ edit: 'edited_parts[0]', dir: 'edits', receipt,
      changed_px: 1, changed_counted_px: 0, changed_excluded_px: 1, removed_opaque_px: 1 });
    const stageMap = json(join(root, 'rebuilt/stage-map.json'));
    expect(arr(stageMap.edits)).toContain('edited_parts[0]');
    expect(arr(stageMap.parts).map(obj).find(entry => entry.name === part)!.edited_part).toEqual(metadata);

    const args = [id, dir, '--config', `${relativeRoot}/edited.json`, '--from', `${relativeRoot}/rebuilt`, '--json'];
    const written = draftRigCommand(args);
    expect(written.exit).toBe(0);
    const record = JSON.parse(written.stdout) as JsonObject;
    const editedPath = `${relativeRoot}/edits/${part}.png`;
    expect(arr(record.config_inputs).map(obj).filter(input => input.path === editedPath)).toEqual([
      { path: editedPath, sha256: receipt.sha256 },
    ]);
    expect(arr(record.config_inputs).map(obj).some(input => input.directory === `${relativeRoot}/edits`)).toBe(false);
    expect(arr(obj(record.parts).files).map(obj)).toContainEqual({
      path: `${relativeRoot}/rebuilt/parts/${part}.png`, sha256: receipt.sha256,
    });
    expect(arr(json(join(dir, 'project.json')).drafts).map(obj).find(draft => draft.id === id)).toEqual(record);
    expect(checkProject(dir).refusals).toEqual([]);
    const check = () => Bun.spawnSync([process.execPath, ...runtimeArgs, ...clockedCli(),
      'interview', '--check', dir, '--json'], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
    const green = check();
    expect(green.exitCode, `${green.stdout}\n${green.stderr}`).toBe(0);
    expect((JSON.parse(green.stdout.toString()) as JsonObject).refusals).toEqual([]);

    // A complete clean candidate with a new id avoids an unrelated duplicate-id
    // or path-boundary refusal. The old draft's edited input alone will drift.
    const nextId = 'edited-alpha-next';
    const nextRoot = `derived/drafts/${nextId}`;
    cpSync(root, join(dir, nextRoot), { recursive: true });
    const frozenProject = readFileSync(join(dir, 'project.json'));
    const changed = Buffer.from(editedBytes);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    writeFileSync(editedFile, changed);
    expect(hash(readFileSync(editedFile))).not.toBe(receipt.sha256);
    expect(checkProject(dir).refusals.map(finding => finding.code)).toContain('DRAFT_RIG_FILE');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(frozenProject);
    const red = check();
    expect(red.exitCode, `${red.stdout}\n${red.stderr}`).toBe(1);
    expect(arr((JSON.parse(red.stdout.toString()) as JsonObject).refusals).map(obj).map(finding => finding.code)).toContain('DRAFT_RIG_FILE');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(frozenProject);
    expect(readFileSync(join(dir, nextRoot, 'edits', `${part}.png`))).toEqual(Buffer.from(editedBytes));
    try {
      draftRigCommand([nextId, dir, '--config', `${nextRoot}/edited.json`, '--from', `${nextRoot}/rebuilt`, '--json']);
      throw new Error('expected the writer to refuse the drifted existing draft');
    } catch (error) {
      expect(error).toBeInstanceOf(Refusal);
      expect((error as Refusal).code).toBe('DRAFT_RIG_FILE');
    }
    expect(readFileSync(join(dir, 'project.json'))).toEqual(frozenProject);
  } finally {
    if (project !== undefined) rmSync(project, { recursive: true, force: true });
    testClock.set(previousClock);
  }
}, 180_000);
