/** Real producer integration using only helpers shipped in @rig-c/parts 2.45.0. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JobPublishRequest } from '@rig-c/review/job-host';
import { jobHostStateRoot, jobPrivateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { prepareDraftManifest, readPublished } from '../src/job-publication.ts';
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
interface ReviewSourceModule {
  captureJobRoot(path: string): { path: string; dev: number; ino: number };
  prepareJobSource(options: {
    root: { path: string; dev: number; ino: number };
    stateRoot: string; fingerprint: string; request: JobPublishRequest; readPublished: typeof readPublished;
  }): Promise<unknown>;
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
    const painting = readFileSync(join(import.meta.dir, '../templates/example-draft/input/painting_in_rig.png'));
    const dir = project = realpathSync(fixture(record => {
      Object.assign(obj(arr(record.inputs)[0]), { sha256: hash(painting), bytes: painting.length,
        origin: 'synthetic producer painting' });
    }, 'legacy-example-project.json', { 'inputs/painting.png': painting }));
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

    // #547: depth-prepare and depth-apply relocate depth_out/config.json while copying
    // parts.json with its assemble-relative provenance unchanged.
    const depthId = 'edited-alpha-depth';
    const depthRelativeRoot = `derived/drafts/${depthId}`;
    const depthRoot = join(dir, depthRelativeRoot);
    cpSync(root, depthRoot, { recursive: true });
    const turnConfig = { ...structuredClone(config), turn: { body: { pivot: 0.5, roles: { [part]: 'surface' } } } };
    writeFileSync(join(depthRoot, 'edited-turn.json'), `${JSON.stringify(turnConfig, null, 2)}\n`);
    const turnParts = join(depthRoot, 'with-turn/rig');
    const assembly = Bun.spawnSync([process.execPath, ...runtimeArgs, join(parts, 'cli.ts'),
      'assemble', '--config', 'edited-turn.json', '--source', 'painting.png', '--full', 'full', '--head', 'head', '--out', 'with-turn'],
    { cwd: depthRoot, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(assembly.exitCode, `assemble with turn:\n${assembly.stdout}\n${assembly.stderr}`).toBe(0);
    cpSync(join(depthRoot, 'with-turn/render/recomposite_rig.png'), join(turnParts, 'recomposite_rig.png'));
    const depthMap = {
      spec: 'rig-parts-map/1',
      width: decoded.width,
      height: decoded.height,
      channels: 1,
      data: Array.from({ length: decoded.width * decoded.height }, (_, i) => i / (decoded.width * decoded.height)),
    };
    writeFileSync(join(depthRoot, 'topwear-depth.json'), `${JSON.stringify(depthMap, null, 2)}\n`);
    const depthRecipe = {
      spec: 'rig-parts-depth/1',
      prepare: { longSide: Math.max(decoded.width, decoded.height), paddingFraction: 0, padding: 0 },
      groups: { body: { near: 'white', zScale: 1, pivot: 0.5 } },
      parts: { [part]: { map: 'topwear-depth.json', source: 'depth', frame: 'part', group: 'body', median: 0.5, relief: 0.1 } },
      clear: [],
    };
    writeFileSync(join(depthRoot, 'depth-recipe.json'), `${JSON.stringify(depthRecipe, null, 2)}\n`);
    const prepared = Bun.spawnSync([process.execPath, ...runtimeArgs, join(parts, 'cli.ts'),
      'depth-prepare', '--parts', turnParts, '--config', join(depthRoot, 'depth-recipe.json'),
      '--out', join(depthRoot, 'depth_in')],
    { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(prepared.exitCode, `depth-prepare:\n${prepared.stdout}\n${prepared.stderr}`).toBe(0);
    const applied = Bun.spawnSync([process.execPath, ...runtimeArgs, join(parts, 'cli.ts'),
      'depth-apply', '--parts', turnParts, '--manifest', join(depthRoot, 'depth_in/manifest.json'),
      '--config', join(depthRoot, 'depth-recipe.json'), '--rig-config', join(depthRoot, 'edited-turn.json'),
      '--out', join(depthRoot, 'depth_out')],
    { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(applied.exitCode, `depth-apply:\n${applied.stdout}\n${applied.stderr}`).toBe(0);
    const depthConfigPath = join(depthRoot, 'depth_out/config.json');
    const depthManifestPath = join(depthRoot, 'depth_out/parts.json');
    const depthConfigBytes = readFileSync(depthConfigPath);
    const depthManifestBytes = readFileSync(depthManifestPath);
    expect(obj(obj(json(depthConfigPath).assemble).edited_parts)).toEqual({
      dir: '../edits',
      receipts: [receipt],
    });
    expect(obj(obj(arr(json(depthManifestPath).parts).map(obj).find(entry => entry.name === part)!).provenance).edited_part).toEqual(metadata);

    const depthRig = Bun.spawnSync([process.execPath, ...runtimeArgs, join(parts, 'cli.ts'),
      'rig', '--parts', 'depth_out', '--config', 'depth_out/config.json', '--out', 'depth_rig'],
    { cwd: depthRoot, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(depthRig.exitCode, `rig with depth:\n${depthRig.stdout}\n${depthRig.stderr}`).toBe(0);
    const depthArgs = [depthId, dir, '--config', `${depthRelativeRoot}/depth_out/config.json`, '--from', `${depthRelativeRoot}/depth_rig`,
      '--parts', `${depthRelativeRoot}/depth_out`, '--json'];
    const beforeDepthControls = readFileSync(join(dir, 'project.json'));
    const missingBindingConfig = json(depthConfigPath);
    delete obj(missingBindingConfig.assemble).edited_parts;
    writeFileSync(depthConfigPath, `${JSON.stringify(missingBindingConfig, null, 2)}\n`);
    expect(() => draftRigCommand(depthArgs)).toThrow(expect.objectContaining({ code: 'DRAFT_EDITED_PART_UNBOUND' }));
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeDepthControls);
    writeFileSync(depthConfigPath, depthConfigBytes);

    const wrongShaManifest = json(depthManifestPath);
    obj(obj(obj(arr(wrongShaManifest.parts).map(obj).find(entry => entry.name === part)!).provenance).edited_part).receipt = {
      ...receipt, sha256: 'b'.repeat(64),
    };
    writeFileSync(depthManifestPath, `${JSON.stringify(wrongShaManifest, null, 2)}\n`);
    expect(() => draftRigCommand(depthArgs)).toThrow(expect.objectContaining({ code: 'DRAFT_EDITED_PART_UNBOUND' }));
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeDepthControls);
    writeFileSync(depthManifestPath, depthManifestBytes);

    const depthWritten = draftRigCommand(depthArgs);
    expect(depthWritten.exit).toBe(0);
    const depthRecord = JSON.parse(depthWritten.stdout) as JsonObject;
    const depthEditedPath = `${depthRelativeRoot}/edits/${part}.png`;
    expect(arr(depthRecord.config_inputs).map(obj)).toEqual([{ path: depthEditedPath, sha256: receipt.sha256 }]);
    expect(checkProject(dir).refusals).toEqual([]);
    const depthGreen = check();
    expect(depthGreen.exitCode, `${depthGreen.stdout}\n${depthGreen.stderr}`).toBe(0);
    expect((JSON.parse(depthGreen.stdout.toString()) as JsonObject).refusals).toEqual([]);

    // Release regression: exercise the installed Review through the documented
    // foreground CLI, not only create's draft/config-input checks above.
    const opened = Bun.spawn([process.execPath, ...runtimeArgs, ...clockedCli(),
      'job', 'open', dir, '--reviewer', 'synthetic-owner', '--role', 'owner', '--draft', depthId],
    { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    let stdout = '', stderr = '';
    const diagnostic = (text: string): string => text.replace(/#cap=[^\s]*/g, '');
    const collect = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void): Promise<void> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          append(decoder.decode(chunk.value, { stream: true }));
        }
        append(decoder.decode());
      } finally { reader.releaseLock(); }
    };
    const streams = Promise.all([
      collect(opened.stdout, text => { stdout += text; }),
      collect(opened.stderr, text => { stderr += text; }),
    ]);
    let openingFailure: { error: unknown } | undefined;
    let cleanupFailure: { error: unknown } | undefined;
    let closed: { exitCode: number; stdout: Buffer; stderr: Buffer } | undefined;
    try {
      const prefix = `job: draft ${depthId} published `;
      const published = (line: string) => line.startsWith(prefix)
        && /^\(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)$/.test(line.slice(prefix.length));
      for (let i = 0; i < 600 && !stdout.split('\n').slice(0, -1).some(published) &&
        !stderr && opened.exitCode === null; i++) await Bun.sleep(25);
      console.log('EDITED_DEPTH_REVIEW_OPEN', JSON.stringify({ stdout: diagnostic(stdout), stderr: diagnostic(stderr), exit: opened.exitCode }));
      const lines = stdout.trim().split('\n');
      expect(lines[0], stderr).toStartWith('http://127.0.0.1:');
      expect(lines[1] ?? '', `${diagnostic(stdout)}\n${diagnostic(stderr)}`).toSatisfy(published);
      expect(opened.exitCode).toBeNull();
      console.log('EDITED_DEPTH_REVIEW_PUBLICATION', lines[1]);
    } catch (error) { openingFailure = { error }; }
    finally {
      try {
        if (readWriterBinding(dir)) {
          closed = Bun.spawnSync([process.execPath, ...runtimeArgs, ...clockedCli(), 'job', 'close', dir],
            { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
        }
      } catch (error) { cleanupFailure = { error }; }
      finally {
        try {
          if (opened.exitCode === null && closed?.exitCode !== 0) opened.kill();
          await opened.exited;
          await streams;
        } catch (error) { cleanupFailure ??= { error }; }
        // No assertions in cleanup: a failed publication remains the primary
        // failure even when the foreground host consequently exits nonzero.
        console.log('EDITED_DEPTH_REVIEW_CLOSED', JSON.stringify({ stdout: diagnostic(stdout), stderr: diagnostic(stderr), exit: opened.exitCode,
          close: closed ? { exit: closed.exitCode, stdout: diagnostic(closed.stdout.toString()), stderr: diagnostic(closed.stderr.toString()) } : null,
          ...(cleanupFailure ? { cleanupError: diagnostic(String(cleanupFailure.error)) } : {}) }));
      }
    }
    if (openingFailure) throw openingFailure.error;
    if (cleanupFailure) throw cleanupFailure.error;
    expect(closed).toBeDefined();
    expect({ exit: closed!.exitCode, stdout: closed!.stdout.toString().trim(), stderr: closed!.stderr.toString() })
      .toEqual({ exit: 0, stdout: 'job: closed', stderr: '' });
    expect(opened.exitCode).toBe(0);
    expect(readWriterBinding(dir)).toBeNull();

    // Keep the malformed input honestly hash-bound so Review's handoff loader,
    // rather than create's stale-byte guard, is the negative control. This is
    // deliberate corruption of a synthetic record, never a writer workaround.
    const projectFile = join(dir, 'project.json');
    const beforeMalformed = readFileSync(projectFile);
    const draftManifestPath = join(dir, `review-draft-${depthId}.json`);
    const beforeMalformedManifest = readFileSync(draftManifestPath);
    try {
      const malformed = json(depthConfigPath);
      obj(arr(obj(obj(malformed.assemble).edited_parts).receipts)[0]).file = '../../../../../../outside.png';
      writeFileSync(depthConfigPath, `${JSON.stringify(malformed, null, 2)}\n`);
      const corruptedProject = json(projectFile);
      const changedConfigPath = `${depthRelativeRoot}/depth_out/config.json`;
      const changedConfigHash = hash(readFileSync(depthConfigPath));
      // The config also appears in retained artifact inventories. Rebind only
      // this exact synthetic path wherever its identity is repeated.
      const rebindConfig = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(rebindConfig); return; }
        if (value === null || typeof value !== 'object') return;
        const entry = value as Record<string, unknown>;
        if (entry.path === changedConfigPath && typeof entry.sha256 === 'string') entry.sha256 = changedConfigHash;
        Object.values(entry).forEach(rebindConfig);
      };
      rebindConfig(corruptedProject);
      writeFileSync(projectFile, `${JSON.stringify(corruptedProject, null, 2)}\n`);
      const manifestPath = prepareDraftManifest(dir, corruptedProject, depthId);
      // Import the shipped implementation by its resolved public host entry;
      // no producer reports or publication readers are stubbed.
      const reviewSource = await import(new URL('./job-source.ts', import.meta.resolve('@rig-c/review/job-host')).href) as ReviewSourceModule;
      let sourceError: unknown;
      try { await reviewSource.prepareJobSource({
        root: reviewSource.captureJobRoot(dir), stateRoot: join(dir, '.negative-review-state'),
        fingerprint: 'synthetic-edited-depth-negative', readPublished,
        request: {
          schema: 'rig-review/job-api@2', jobId: 'synthetic-negative', requestId: 'malformed-edited-reference',
          verb: 'publish', expectedGeneration: 0, idempotencyKey: 'malformed-edited-reference',
          freeze: { kind: 'producer-held', holdId: 'synthetic-frozen-draft',
            record: { path: 'project.json', sha256: hash(readFileSync(projectFile)) } },
          result: { path: manifestPath, selector: { kind: 'draft', id: depthId } },
        },
      }); } catch (error) { sourceError = error; }
      expect(sourceError).toBeInstanceOf(Error);
      const refusalCode = (sourceError as Error & { code: string }).code;
      const refusalMessage = (sourceError as Error).message;
      console.log('EDITED_DEPTH_REVIEW_REFUSAL', refusalCode, refusalMessage);
      expect(refusalCode).toBe('JOB_SOURCE_MISMATCH');
      expect(refusalMessage).toContain('HANDOFF_PATH_OUTSIDE_ROOT config assemble.edited_parts.receipts[0].file:');
    } finally {
      writeFileSync(depthConfigPath, depthConfigBytes);
      writeFileSync(projectFile, beforeMalformed);
      writeFileSync(draftManifestPath, beforeMalformedManifest);
    }

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
    if (project !== undefined) {
      rmSync(jobPrivateRoot(project), { recursive: true, force: true });
      rmSync(jobHostStateRoot(project), { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
    testClock.set(previousClock);
  }
}, 180_000);
