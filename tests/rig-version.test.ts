import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { rigRegistrationFindings } from '../src/rig-version.ts';
import { checkProject, rigVersionCommand, testClock } from './clock.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import { plateReceiptSpec } from '../src/config-inputs.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, waypoint } from './fixtures.ts';
import { clockedCli, run } from './helpers.ts';
import { openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';
import { readRecordPublished } from '../src/job-publication.ts';

const roots: string[] = [];
const frozen = join(import.meta.dir, 'fixtures/rig-registration');
afterEach(() => { testClock.reset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function put(dir: string, path: string, value: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}
function setup() {
  const dir = fixture(project => { project.stage = 'interview'; project.signoffs = []; project.versions = []; project.reopens = []; for (const step of obj(project.plan).steps as JsonObject[]) step.status = 'pending'; });
  roots.push(dirname(dir));
  testClock.set(new Date('2026-11-08T00:00:00Z'));
  for (const path of ['outputs', 'derived/review']) rmSync(join(dir, path), { recursive: true, force: true });
  cpSync(frozen, join(dir, 'source'), { recursive: true });
  put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json' });
  put(dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: { required: true } });
  put(dir, 'source/adapter.json', []);
  const painting = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
  put(dir, 'source/parts/parts.json', { rig_size: [8, 16], scale_rig_per_source: 1, ghost_px: {},
    painting_in_rig: { path: 'painting_in_rig.png', sha256: jobHash(painting), resample: 'lanczos3-rgb-opaque' },
    parts: [{ name: 'rectangle', from: 'painting:rectangle', x: 0, y: 0, w: 8, h: 16,
      opaque_px: 128, projected_core_px: 128, source_px_taken: 128, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 }] });
  writeFileSync(join(dir, 'source/parts/painting_in_rig.png'), painting);
  mkdirSync(join(dir, 'source/parts/parts'), { recursive: true });
  cpSync(join(dir, 'source/rig/images/rectangle.png'), join(dir, 'source/parts/parts/rectangle.png'));
  put(dir, 'source/run.json', {
    spec: 'rigc-run/1',
    package: { name: 'rig-c', version: '3.4.1' },
    command: 'build',
    started_at: '2026-11-06T20:44:40.000Z',
    finished_at: '2026-11-06T20:44:41.000Z',
    inputs: [
      { role: 'rig', path: '../rig/rig.json', sha256: '1'.repeat(64) },
      { role: 'motion', path: '../rig/motion.json', sha256: '2'.repeat(64) },
    ],
    outputs: [
      { path: '../compile-report.json', sha256: '3'.repeat(64) },
      { path: 'skeleton.model.json', sha256: '4'.repeat(64) },
    ],
  });
  const args = ['1', dir, '--parts', 'source/parts', '--rig', 'source/rig', '--build', 'source/build', '--idle', 'source/idle',
    '--config', 'source/config.json', '--path-adapter', 'source/adapter.json', '--compile-report', 'source/compile-report.json',
    '--toolchain-lock', 'source/package-lock.json', '--run-record', 'source/run.json', '--at-source', 'source/at-source.json', '--at-pointer', '/finished_at', '--by', 'registrant', '--json'];
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  return { dir, args, load };
}

function setupSharedAssets() {
  const base = setup();
  const imageBytes = readFileSync(join(base.dir, 'source/rig/images/rectangle.png'));
  const receiptBytes = `${JSON.stringify({ spec: plateReceiptSpec(base.dir), synthetic: 'occluder plate receipt' })}\n`;
  put(base.dir, 'source/inputs/plate/receipt.json', receiptBytes);
  writeFileSync(join(base.dir, 'source/inputs/plate/plate.png'), imageBytes);
  writeFileSync(join(base.dir, 'source/inputs/other.png'), imageBytes);
  put(base.dir, 'source/inputs/plate/mask.png', 'unreferenced sibling mask');
  put(base.dir, 'source/inputs/different.png', 'different image bytes');
  put(base.dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
  return { ...base, args: [...base.args, '--citations', 'source/citations.json'], imageBytes, receiptBytes };
}

function refused(args: string[], code: string): Refusal {
  const projectFile = join(args[1]!, 'project.json');
  const before = readFileSync(projectFile);
  let caught: unknown;
  try { rigVersionCommand(args); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Refusal);
  expect((caught as Refusal).code).toBe(code);
  expect(readFileSync(projectFile)).toEqual(before);
  return caught as Refusal;
}

function setupProvenancePointers() {
  const base = setup();
  const backdrop = readFileSync(join(base.dir, 'source/rig/images/rectangle.png'));
  writeFileSync(join(base.dir, 'source/backdrop.png'), backdrop);
  const requirements = {
    spec: 'spine-parts-requirements/1', fps: 4, requirements: [],
    setup_painting: {
      required: true,
      backdrop: { path: 'backdrop.png', sha256: jobHash(backdrop) },
      regions: Array.from({ length: 7 }, (_, index) => ({
        name: `region-${index}`, box: [0, 0, 1, 1], max_pixels: 0,
        'x-source': { json_pointer: `/METRICS/regions/${index}/pixel_count` },
      })),
    },
  };
  put(base.dir, 'source/requirements.json', requirements);
  return { ...base, requirements };
}

describe('frozen rig registration', () => {
  test('#409 seven requirements provenance JSON pointers survive public writer registration', () => {
    const { dir, args, load, requirements } = setupProvenancePointers();
    const originalConfig = readFileSync(join(dir, 'source/config.json'));
    const originalRequirements = readFileSync(join(dir, 'source/requirements.json'));
    const result = run([process.execPath, ...clockedCli(), 'rig-version', ...args], dir, process.env as Record<string, string>);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, 'evidence/v1/registration/config-source.json'))).toEqual(originalConfig);
    expect(readFileSync(join(dir, 'evidence/v1/registration/requirements-source.json'))).toEqual(originalRequirements);
    const runtime = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/requirements.json'), 'utf8'));
    const packaged = JSON.parse(readFileSync(join(dir, 'derived/review/v1/requirements.json'), 'utf8'));
    expect(runtime.setup_painting.regions).toEqual(requirements.setup_painting.regions);
    expect(packaged).toEqual(runtime);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test.each(['/METRICS/a~1b/~0name', '/', '/METRICS//pixel_count', '/report.json', ''])('#409 provenance pointer syntax preserves %j', pointer => {
    const { dir, args, load, requirements } = setupProvenancePointers();
    requirements.setup_painting.regions[0]!['x-source'].json_pointer = pointer;
    put(dir, 'source/requirements.json', requirements);
    const original = readFileSync(join(dir, 'source/requirements.json'));
    expect(rigVersionCommand(args).exit).toBe(0);
    expect(readFileSync(join(dir, 'evidence/v1/registration/requirements-source.json'))).toEqual(original);
    const runtime = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/requirements.json'), 'utf8'));
    expect(runtime.setup_painting.regions[0]['x-source'].json_pointer).toBe(pointer);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test.each([
    ['declared asset', 'RIG_RUNTIME_PATH_UNRESOLVED', (requirements: JsonObject) => {
      obj(requirements.setup_painting).figure_mask = { path: '/foreign/mask.png', sha256: '1'.repeat(64) };
    }],
    ['undeclared field', 'RIG_REGISTRATION_FILE_INVALID', (requirements: JsonObject) => {
      obj(requirements.setup_painting).unlisted = '/foreign/asset.png';
    }],
    ['other provenance field', 'RIG_REGISTRATION_FILE_INVALID', (requirements: JsonObject) => {
      obj((obj(requirements.setup_painting).regions as JsonObject[])[0]!['x-source']).unlisted = '/foreign/asset.png';
    }],
    ['json_pointer outside x-source', 'RIG_REGISTRATION_FILE_INVALID', (requirements: JsonObject) => {
      (obj(requirements.setup_painting).regions as JsonObject[])[0]!.json_pointer = '/METRICS/regions/0/pixel_count';
    }],
    ['json_pointer under another extension', 'RIG_REGISTRATION_FILE_INVALID', (requirements: JsonObject) => {
      (obj(requirements.setup_painting).regions as JsonObject[])[0]!['x-other'] = { json_pointer: '/METRICS/regions/0/pixel_count' };
    }],
  ] as const)('#409 refuses an absolute value in %s and rolls back', (name, code, mutate) => {
    const { dir, args, requirements } = setupProvenancePointers();
    mutate(requirements);
    put(dir, 'source/requirements.json', requirements);
    const original = readFileSync(join(dir, 'source/requirements.json'));
    const failure = refused(args, code);
    if (name !== 'declared asset') {
      expect(failure.message).toContain('evidence/v1/registration/requirements.json#/');
      expect(failure.message).toContain('restore the retained registration inputs');
    }
    expect(readFileSync(join(dir, 'source/requirements.json'))).toEqual(original);
    for (const path of ['outputs/v1', 'evidence/v1/registration', 'derived/review/v1']) expect(existsSync(join(dir, path))).toBe(false);
  });

  test.each(['/METRICS/bad~2escape', '/METRICS/trailing~', 'C:\\foreign\\report.json'])('#409 refuses invalid provenance pointer %j', pointer => {
    const { dir, args, requirements } = setupProvenancePointers();
    requirements.setup_painting.regions[0]!['x-source'].json_pointer = pointer;
    put(dir, 'source/requirements.json', requirements);
    const failure = refused(args, 'RIG_REGISTRATION_FILE_INVALID');
    expect(failure.message).toContain('requirements.json#/setup_painting/regions/0/x-source/json_pointer');
    expect(failure.message).toContain('RFC 6901');
    for (const path of ['outputs/v1', 'evidence/v1/registration', 'derived/review/v1']) expect(existsSync(join(dir, path))).toBe(false);
  });

  test.each([false, true])('writer commit owns live publication, with stopped host=%s', async stopped => {
    const { dir, args, load } = setup();
    const source = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(dir, 'inputs/painting.png'), source);
    const record = load();
    record.inputs = [{ path: 'inputs/painting.png', sha256: jobHash(source), bytes: source.length,
      origin: 'synthetic original painting', at: new Date(testClock.now()).toISOString() }];
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(record, null, 2)}\n`);
    const host = await openCreateJob(dir, { id: 'reviewer', role: 'owner' }, testClock.now());
    const binding = readWriterBinding(dir)!;
    expect(binding.listenerIncarnation).toBe(host.attachment!.listenerIncarnation);
    let recovery: Awaited<ReturnType<typeof openCreateJob>> | undefined;
    try {
      if (stopped) host.stop();
      // The agent only invokes the writer. No test/agent publish call occurs here.
      const child = Bun.spawn([process.execPath, ...clockedCli(), 'rig-version', ...args], {
        cwd: dir, stdout: 'pipe', stderr: 'pipe',
      });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      const bytes = readFileSync(join(dir, 'project.json'));
      if (stopped) {
        expect(exit).toBe(1);
        expect(stderr).toContain('JOB_PUBLISH_PENDING');
        expect(pendingPublications(dir)[0].failure?.code).toBe('JOB_HOST_ATTACH_REFUSED');
        expect(checkProject(dir).holes?.map(hole => hole.code)).toEqual(['JOB_PUBLISH_PENDING']);
        recovery = await openCreateJob(dir, { id: 'reviewer', role: 'owner' }, testClock.now());
        expect(recovery.session.status().generation).toBe(0);
        await reconcileCreateJob(dir);
        expect(checkProject(dir).holes ?? []).toEqual([]);
        expect(recovery.session.status().publication?.source.projectHash).toBe(jobHash(bytes));
        expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
      } else {
        expect(stderr).toBe('');
        expect(exit).toBe(0);
        expect(host.session.status().publication?.source.projectHash).toBe(jobHash(bytes));
        expect(host.session.status().publication?.label).toBe('rig v1');
        const painting = host.session.status().publication?.source.parts?.images.find(image => image.path === 'painting_in_rig.png');
        expect(painting?.sha256).toBe(jobHash(readFileSync(join(dir, 'outputs/v1/out/painting_in_rig.png'))));
        expect(painting?.sha256).toBe(jobHash(readFileSync(join(dir, 'derived/review/v1/out/painting_in_rig.png'))));
        expect(((load().versions as JsonObject[])[0].review_package as JsonObject).files).toContainEqual({ path: 'out/painting_in_rig.png', sha256: painting!.sha256 });
      }
    } finally {
      recovery?.stop(); host.stop();
      rmSync(jobPrivateRoot(dir), { recursive: true, force: true });
      rmSync(jobHostStateRoot(dir), { recursive: true, force: true });
    }
  });

  test('public CLI records real producer frames, declared tools, cited date and unchanged stage', () => {
    const { dir, args, load } = setup();
    expect(checkProject(dir).refusals).toEqual([]);
    const before = load();
    const result = run([process.execPath, ...clockedCli(), 'rig-version', ...args], dir, process.env as Record<string, string>);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const version = JSON.parse(result.stdout) as JsonObject;
    const paintingHash = jobHash(readFileSync(join(dir, 'source/parts/painting_in_rig.png')));
    expect((version.outputs as JsonObject[]).find(file => file.path === 'outputs/v1/out/painting_in_rig.png')?.sha256).toBe(paintingHash);
    expect((version.review_package as JsonObject).files).toContainEqual({ path: 'out/painting_in_rig.png', sha256: paintingHash });
    expect(version.built_with).toEqual({ '@rig-c/parts': '2.23.4', '@rig-c/core': '3.4.1' });
    expect(version.at).toBe(JSON.parse(readFileSync(join(frozen, 'at-source.json'), 'utf8')).finished_at);
    expect(version.at_basis).toBe('not-after');
    expect(obj(version.registration).at).not.toBe(version.at);
    expect(version.verdicts).toEqual([]);
    expect(load().stage).toBe(before.stage);
    expect(load().signoffs).toEqual(before.signoffs);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
    expect(readFileSync(join(dir, 'outputs/v1/out/check/build/skeleton.model.json'))).toEqual(readFileSync(join(frozen, 'build/skeleton.model.json')));
    expect(readFileSync(join(dir, 'outputs/v1/idle/frames.json'))).toEqual(readFileSync(join(frozen, 'idle/frames.json')));
    const review = run([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/review/src/cli.ts'), 'check', join(dir, 'derived/review/v1/out')], dir, process.env as Record<string, string>);
    expect(review.code).toBe(0);
    rmSync(join(dir, 'source'), { recursive: true });
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test.each([
    ['missing idle manifest', 'RIG_IDLE_MANIFEST_MISSING', (dir: string) => rmSync(join(dir, 'source/idle/frames.json'))],
    ['missing lock', 'RIG_TOOLCHAIN_LOCK_INVALID', (dir: string) => rmSync(join(dir, 'source/package-lock.json'))],
    ['wrong lock version', 'RIG_TOOLCHAIN_LOCK_INVALID', (dir: string) => put(dir, 'source/package-lock.json', { lockfileVersion: 2 })],
    ['missing package', 'RIG_TOOLCHAIN_LOCK_INVALID', (dir: string) => put(dir, 'source/package-lock.json', { lockfileVersion: 3, packages: {} })],
    ['missing date record', 'RIG_AT_SOURCE_INVALID', (dir: string) => rmSync(join(dir, 'source/at-source.json'))],
    ['unresolved absolute path', 'RIG_RUNTIME_PATH_UNRESOLVED', (dir: string) => put(dir, 'source/config.json', { requirements: '/foreign/requirements.json' })],
    ['Windows absolute path', 'RIG_RUNTIME_PATH_UNRESOLVED', (dir: string) => put(dir, 'source/config.json', { requirements: 'C:\\foreign\\requirements.json' })],
    ['output symlink', 'RIG_REGISTRATION_PATH_INVALID', (dir: string) => symlinkSync(join(dir, 'source/config.json'), join(dir, 'source/rig/link.json'))],
    ['symlinked directory', 'RIG_REGISTRATION_PATH_INVALID', (dir: string) => { mkdirSync(join(dir, 'source/real-sub')); symlinkSync(join(dir, 'source/real-sub'), join(dir, 'source/rig/linked-sub')); }],
    ['symlinked lock', 'RIG_REGISTRATION_PATH_INVALID', (dir: string) => { renameSync(join(dir, 'source/package-lock.json'), join(dir, 'source/real-lock.json')); symlinkSync(join(dir, 'source/real-lock.json'), join(dir, 'source/package-lock.json')); }],
    ['symlinked date record', 'RIG_REGISTRATION_PATH_INVALID', (dir: string) => { renameSync(join(dir, 'source/at-source.json'), join(dir, 'source/real-at.json')); symlinkSync(join(dir, 'source/real-at.json'), join(dir, 'source/at-source.json')); }],
  ])('%s refuses by code and leaves project byte-identical', (_name, code, mutate) => {
    const { dir, args } = setup();
    mutate(dir);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);
  });

  test('registers external frozen sources under os.tmpdir() while refusing symlinked files and directories inside the source tree', () => {
    const { dir, load } = setup();
    const savedTmp = process.env.TMPDIR;
    if (savedTmp?.startsWith(process.cwd())) delete process.env.TMPDIR;
    const realTmp = os.tmpdir();
    if (savedTmp !== undefined) process.env.TMPDIR = savedTmp;
    const external = mkdtempSync(join(realTmp, 'rig-version-ext-'));
    roots.push(external);
    const src = join(external, 'source');
    renameSync(join(dir, 'source'), src);
    const extArgs = ['1', dir, '--parts', join(src, 'parts'), '--rig', join(src, 'rig'), '--build', join(src, 'build'), '--idle', join(src, 'idle'),
      '--config', join(src, 'config.json'), '--path-adapter', join(src, 'adapter.json'), '--compile-report', join(src, 'compile-report.json'),
      '--toolchain-lock', join(src, 'package-lock.json'), '--run-record', join(src, 'run.json'), '--at-source', join(src, 'at-source.json'), '--at-pointer', '/finished_at', '--by', 'registrant', '--json'];
    const before = readFileSync(join(dir, 'project.json'));

    symlinkSync(join(src, 'config.json'), join(src, 'rig/linked-file.json'));
    refused(extArgs, 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    rmSync(join(src, 'rig/linked-file.json'));

    mkdirSync(join(external, 'real-dir'));
    writeFileSync(join(external, 'real-dir/extra.json'), '{}\n');
    symlinkSync(join(external, 'real-dir'), join(src, 'rig/linked-dir'));
    refused(extArgs, 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    rmSync(join(src, 'rig/linked-dir'));

    symlinkSync(join(external, 'real-dir'), join(src, 'linked-lock-dir'));
    cpSync(join(src, 'package-lock.json'), join(external, 'real-dir/package-lock.json'));
    const lockViaSymlinkDir = [...extArgs];
    lockViaSymlinkDir[lockViaSymlinkDir.indexOf('--toolchain-lock') + 1] = join(src, 'linked-lock-dir/package-lock.json');
    refused(lockViaSymlinkDir, 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    rmSync(join(src, 'linked-lock-dir'));

    expect(rigVersionCommand(extArgs).exit).toBe(0);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test.each(['config-pointer', 'requirements-pointer', 'config-project-pointer', 'legacy-absolute'] as const)('external config root refuses new external relative assets and accepts project-relative or legacy absolute adapters (%s)', mode => {
    const { dir, args, load } = setup();
    const external = realpathSync(mkdtempSync(join(os.tmpdir(), 'rig-version-adapter-external-')));
    roots.push(external);
    const assetBytes = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(external, 'receipt.png'), assetBytes);
    writeFileSync(join(external, 'backdrop.png'), assetBytes);
    const receiptPath = mode === 'config-project-pointer'
      ? relative(external, join(dir, 'source/rig/images/rectangle.png')).split(sep).join('/')
      : mode === 'config-pointer' ? 'receipt.png' : '/runtime/receipt.png';
    put(external, 'config.json', { key: 'synthetic', requirements: '/runtime/requirements.json', assemble: {
      editor_receipts: { receipts: [{ file: receiptPath, sha256: jobHash(assetBytes) }] },
    } });
    put(external, 'requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: {
      required: true,
      ...(mode === 'requirements-pointer' ? { backdrop: { path: 'backdrop.png', sha256: jobHash(assetBytes) } } : {}),
    } });
    const adapter: JsonObject[] = [
      { at: '.requirements', before: join(external, 'requirements.json'), after: '/runtime/requirements.json' },
      mode.startsWith('config-')
        ? { doc: 'config', pointer: '/assemble/editor_receipts/receipts/0/file', before: receiptPath, after: 'inputs/receipt.png' }
        : { at: '.assemble.editor_receipts.receipts.0.file', before: join(external, 'receipt.png'), after: '/runtime/receipt.png' },
    ];
    if (mode === 'requirements-pointer') adapter.push({ doc: 'requirements', pointer: '/setup_painting/backdrop/path', before: 'backdrop.png', after: 'inputs/backdrop.png' });
    put(external, 'adapter.json', adapter);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    const externalArgs = [...args, '--citations', 'source/citations.json'];
    externalArgs[externalArgs.indexOf('--config') + 1] = join(external, 'config.json');
    externalArgs[externalArgs.indexOf('--path-adapter') + 1] = join(external, 'adapter.json');
    const originalConfig = readFileSync(join(external, 'config.json'));
    const originalRequirements = readFileSync(join(external, 'requirements.json'));
    if (mode === 'legacy-absolute' || mode === 'config-project-pointer') {
      expect(rigVersionCommand(externalArgs).exit).toBe(0);
      expect(rigRegistrationFindings(dir, load())).toEqual([]);
      expect(checkProject(dir).refusals).toEqual([]);
      const registration = obj((load().versions as JsonObject[])[0]!.registration);
      if (mode === 'legacy-absolute') expect(obj(registration.path_adapter).format).toBeUndefined();
      else expect(obj(registration.path_adapter).format).toBe('json-pointer/1');
      const retainedReceipt = mode === 'legacy-absolute' ? 'inputs/assemble/editor_receipts/receipts/0/file' : 'inputs/receipt.png';
      expect(readFileSync(join(dir, 'evidence/v1/registration', retainedReceipt))).toEqual(assetBytes);
    } else {
      refused(externalArgs, 'RIG_REGISTRATION_PATH_INVALID');
      for (const target of ['outputs/v1', 'evidence/v1/registration', 'derived/review/v1']) expect(existsSync(join(dir, target))).toBe(false);
    }
    expect(readFileSync(join(external, 'config.json'))).toEqual(originalConfig);
    expect(readFileSync(join(external, 'requirements.json'))).toEqual(originalRequirements);
    expect(readFileSync(join(external, 'receipt.png'))).toEqual(assetBytes);
    expect(readFileSync(join(external, 'backdrop.png'))).toEqual(assetBytes);
  });

  test('system temp aliases retain project-contained config and requirements inputs', () => {
    const { dir, args, load } = setup();
    const aliasRoot = mkdtempSync(join(realpathSync(os.tmpdir()), 'rig-version-system-alias-'));
    roots.push(aliasRoot);
    mkdirSync(join(aliasRoot, 'real'));
    symlinkSync(join(aliasRoot, 'real'), join(aliasRoot, 'alias'), 'dir');
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = join(aliasRoot, 'alias');
    try {
    const external = mkdtempSync(join(os.tmpdir(), 'external-'));
    const maskBytes = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(dir, 'mask.png'), maskBytes);
    put(dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: {
      required: true, figure_mask: { path: '../mask.png', sha256: jobHash(maskBytes) },
    } });
    const originalReceipt = relative(external, join(dir, 'source/rig/images/rectangle.png')).split(sep).join('/');
    put(external, 'config.json', { key: 'synthetic', requirements: '/runtime/requirements.json', assemble: {
      editor_receipts: { receipts: [{ file: originalReceipt, sha256: jobHash(maskBytes) }] },
    } });
    put(external, 'adapter.json', [
      { at: '.requirements', before: join(dir, 'source/requirements.json'), after: '/runtime/requirements.json' },
      { doc: 'config', pointer: '/assemble/editor_receipts/receipts/0/file', before: originalReceipt, after: 'inputs/receipt.png' },
    ]);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    const aliasedArgs = [...args, '--citations', 'source/citations.json'];
    aliasedArgs[aliasedArgs.indexOf('--config') + 1] = join(external, 'config.json');
    aliasedArgs[aliasedArgs.indexOf('--path-adapter') + 1] = join(external, 'adapter.json');
    const originalConfig = readFileSync(join(external, 'config.json'));
    const originalRequirements = readFileSync(join(dir, 'source/requirements.json'));
    expect(rigVersionCommand(aliasedArgs).exit).toBe(0);
    const project = load();
    const registration = obj((project.versions as JsonObject[])[0]!.registration);
    expect(obj(registration.requirements_source).source_path).toBe('source/requirements.json');
    expect(readFileSync(join(dir, 'evidence/v1/registration/inputs/receipt.png'))).toEqual(maskBytes);
    expect(readFileSync(join(external, 'config.json'))).toEqual(originalConfig);
    expect(readFileSync(join(dir, 'source/requirements.json'))).toEqual(originalRequirements);
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  test('legacy absolute adapter rows on relative values remain unused declarations', () => {
    const { dir, args, load } = setup();
    const config = { key: 'synthetic', requirements: 'requirements.json', assemble: {
      editor_receipts: { receipts: [{ file: 'rig/images/rectangle.png' }] },
    } };
    const adapter = [
      { at: '.requirements', before: join(dir, 'unused-requirements.json'), after: 'requirements.json' },
      { at: '.assemble.editor_receipts.receipts.0.file', before: join(dir, 'unused-receipt.png'), after: 'rig/images/rectangle.png' },
    ];
    put(dir, 'source/config.json', config);
    put(dir, 'source/adapter.json', adapter);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    expect(rigVersionCommand([...args, '--citations', 'source/citations.json']).exit).toBe(0);
    const project = load();
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
    const runtime = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/config.json'), 'utf8')) as JsonObject;
    expect(runtime.requirements).toBe('requirements.json');
    expect(((obj(obj(runtime.assemble).editor_receipts).receipts as JsonObject[])[0]!).file).toBe('inputs/assemble/editor_receipts/receipts/0/file');
    const retainedRows = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'), 'utf8')) as JsonObject[];
    expect(retainedRows.slice(0, 2)).toEqual(adapter);
    expect(retainedRows[2]!.doc).toBe('config');
  });

  const sharingCases: { name: string; occluders: JsonObject[]; adapter: JsonObject[] }[] = [
    {
      name: 'image inside its plate directory',
      occluders: [{ image: 'inputs/plate/plate.png', plate: 'inputs/plate' }],
      adapter: [],
    },
    {
      name: 'repeated image',
      occluders: [{ image: 'inputs/plate/plate.png' }, { image: 'inputs/plate/plate.png' }],
      adapter: [],
    },
    {
      name: 'pointer image inside its plate directory',
      occluders: [{ image: 'inputs/plate/plate.png', plate: 'inputs/plate' }],
      adapter: [
        { doc: 'config', pointer: '/assemble/occluders/0/image', before: 'inputs/plate/plate.png', after: 'runtime/plate/plate.png' },
        { doc: 'config', pointer: '/assemble/occluders/0/plate', before: 'inputs/plate', after: 'runtime/plate' },
      ],
    },
    {
      name: 'pointer shared image target',
      occluders: [{ image: 'inputs/plate/plate.png' }, { image: 'inputs/other.png' }],
      adapter: [
        { doc: 'config', pointer: '/assemble/occluders/0/image', before: 'inputs/plate/plate.png', after: 'runtime/shared.png' },
        { doc: 'config', pointer: '/assemble/occluders/1/image', before: 'inputs/other.png', after: 'runtime/shared.png' },
      ],
    },
    {
      name: 'pointer shared requirements target',
      occluders: [{ image: 'inputs/plate/plate.png' }],
      adapter: [
        { doc: 'requirements', pointer: '/setup_painting/figure_mask/path', before: 'inputs/plate/plate.png', after: 'runtime/shared.png' },
        { doc: 'requirements', pointer: '/setup_painting/backdrop/path', before: 'inputs/other.png', after: 'runtime/shared.png' },
      ],
    },
  ];
  test.each(sharingCases)('registration shares byte-identical assets for $name', scenario => {
    const { dir, args, load, imageBytes, receiptBytes } = setupSharedAssets();
    put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: { occluders: scenario.occluders } });
    put(dir, 'source/adapter.json', scenario.adapter);
    if (scenario.name === 'pointer shared requirements target') {
      put(dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: {
        required: true,
        figure_mask: { path: 'inputs/plate/plate.png', sha256: jobHash(imageBytes) },
        backdrop: { path: 'inputs/other.png', sha256: jobHash(imageBytes) },
      } });
    }
    const originalConfig = readFileSync(join(dir, 'source/config.json'));
    const originalRequirements = readFileSync(join(dir, 'source/requirements.json'));
    expect(rigVersionCommand(args).exit).toBe(0);
    const project = load();
    const version = (project.versions as JsonObject[])[0]!;
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
    const runtime = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/config.json'), 'utf8')) as JsonObject;
    for (const entry of obj(runtime.assemble).occluders as JsonObject[]) {
      expect(readFileSync(join(dir, 'evidence/v1/registration', String(entry.image)))).toEqual(imageBytes);
      expect(readFileSync(join(dir, 'derived/review/v1', String(entry.image)))).toEqual(imageBytes);
      if (typeof entry.plate === 'string') {
        expect(readFileSync(join(dir, 'derived/review/v1', entry.plate, 'receipt.json'), 'utf8')).toBe(receiptBytes);
        expect(existsSync(join(dir, 'derived/review/v1', entry.plate, 'mask.png'))).toBe(false);
      }
    }
    const inventory = obj(version.registration).files as JsonObject[];
    expect(new Set(inventory.map(file => file.path)).size).toBe(inventory.length);
    expect(readFileSync(join(dir, 'source/config.json'))).toEqual(originalConfig);
    expect(readFileSync(join(dir, 'source/requirements.json'))).toEqual(originalRequirements);
    const beforePackage = version.review_package;
    rmSync(join(dir, 'derived/review/v1'), { recursive: true });
    expect(reviewPackageCommand(['1', dir, '--config', 'evidence/v1/registration/config.json', '--from', 'outputs/v1/out']).exit).toBe(0);
    expect((load().versions as JsonObject[])[0]!.review_package).toEqual(beforePackage);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test.each([
    {
      name: 'different file bytes', firstSource: 'inputs/plate/plate.png', firstTarget: 'runtime/shared.png',
      secondSource: 'inputs/different.png', secondTarget: 'runtime/shared.png', secondKind: 'image',
    },
    {
      name: 'different bytes inside a copied directory', firstSource: 'inputs/different.png', firstTarget: 'runtime/plate/plate.png',
      secondSource: 'inputs/plate', secondTarget: 'runtime/plate', secondKind: 'plate',
    },
    {
      name: 'file replacing a directory', firstSource: 'inputs/plate/plate.png', firstTarget: 'runtime/shared/child.png',
      secondSource: 'inputs/other.png', secondTarget: 'runtime/shared', secondKind: 'image',
    },
    {
      name: 'file used as a parent directory', firstSource: 'inputs/plate/plate.png', firstTarget: 'runtime/shared',
      secondSource: 'inputs/other.png', secondTarget: 'runtime/shared/child.png', secondKind: 'image',
    },
    {
      name: 'directory replacing a file', firstSource: 'inputs/plate/plate.png', firstTarget: 'runtime/shared',
      secondSource: 'inputs/plate', secondTarget: 'runtime/shared', secondKind: 'plate',
    },
    {
      name: 'reserved metadata parent', firstSource: 'inputs/plate/plate.png', firstTarget: 'config-source.json/child.png',
      secondSource: 'inputs/other.png', secondTarget: 'runtime/shared.png', secondKind: 'image',
    },
  ])('registration refuses incompatible asset sharing for $name', scenario => {
    const { dir, args } = setupSharedAssets();
    put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: { occluders: [
      { image: scenario.firstSource }, { [scenario.secondKind]: scenario.secondSource },
    ] } });
    put(dir, 'source/adapter.json', [
      { doc: 'config', pointer: '/assemble/occluders/0/image', before: scenario.firstSource, after: scenario.firstTarget },
      { doc: 'config', pointer: `/assemble/occluders/1/${scenario.secondKind}`, before: scenario.secondSource, after: scenario.secondTarget },
    ]);
    refused(args, 'RIG_REGISTRATION_PATH_INVALID');
    for (const target of ['outputs/v1', 'evidence/v1/registration', 'derived/review/v1']) expect(existsSync(join(dir, target))).toBe(false);
  });

  test('strict shared-target checking rejects a plate rebound to a retained file', () => {
    const { dir, args, load } = setupSharedAssets();
    put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: {
      occluders: [{ image: 'inputs/plate/plate.png', plate: 'inputs/plate' }],
    } });
    put(dir, 'source/adapter.json', [
      { doc: 'config', pointer: '/assemble/occluders/0/image', before: 'inputs/plate/plate.png', after: 'runtime/plate/plate.png' },
      { doc: 'config', pointer: '/assemble/occluders/0/plate', before: 'inputs/plate', after: 'runtime/plate' },
    ]);
    expect(rigVersionCommand(args).exit).toBe(0);
    const candidate = load();
    const version = (candidate.versions as JsonObject[])[0]!;
    const registration = obj(version.registration);
    const saved = new Map<string, Buffer>();
    const replaceRetained = (binding: JsonObject, raw: unknown): void => {
      const path = String(binding.path);
      saved.set(path, readFileSync(join(dir, path)));
      const bytes = Buffer.from(`${JSON.stringify(raw)}\n`);
      writeFileSync(join(dir, path), bytes);
      binding.sha256 = jobHash(bytes);
      binding.bytes = bytes.length;
      for (const file of registration.files as JsonObject[]) if (file.path === path) file.sha256 = binding.sha256;
    };
    try {
      const configBinding = obj(obj(version.provenance).config);
      const runtime = JSON.parse(readFileSync(join(dir, String(configBinding.path)), 'utf8')) as JsonObject;
      ((obj(runtime.assemble).occluders as JsonObject[])[0]!).plate = 'runtime/plate/plate.png';
      replaceRetained(configBinding, runtime);
      const adapterBinding = obj(registration.path_adapter);
      const rows = JSON.parse(readFileSync(join(dir, String(adapterBinding.path)), 'utf8')) as JsonObject[];
      rows[1]!.after = 'runtime/plate/plate.png';
      replaceRetained(adapterBinding, rows);
      expect(rigRegistrationFindings(dir, candidate).map(finding => finding.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
    } finally {
      for (const [path, bytes] of saved) writeFileSync(join(dir, path), bytes);
    }
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test.each(['pending 1', '2026-02-30T00:00:00Z', '2026-11-06', '2026-11-06T20:44:42', '2026-11-06T20:44:42+09:00', '2026-11-06T24:00:00Z'])('refuses invalid/non-UTC date %s', at => {
    const { dir, args } = setup();
    put(dir, 'source/at-source.json', { finished_at: at });
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'RIG_AT_SOURCE_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('resolves an exact adapter and copies relative named inputs into the retained config directory', () => {
    const { dir, args, load } = setup();
    put(dir, 'source/requirements.json', { setup_painting: { required: true } });
    put(dir, 'source/config.json', { key: 'synthetic', requirements: '/runtime/requirements.json' });
    put(dir, 'source/adapter.json', [{ at: '.requirements', before: join(dir, 'source/requirements.json'), after: '/runtime/requirements.json' }]);
    rigVersionCommand(args);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    const version = (load().versions as JsonObject[])[0]!;
    const config = JSON.parse(readFileSync(join(dir, String(obj(obj(version.provenance).config).path)), 'utf8'));
    expect(config.requirements).toBe('inputs/requirements');
    expect(readFileSync(join(dir, 'derived/review/v1/inputs/requirements'), 'utf8')).toBe('{"setup_painting":{"required":true}}\n');
  });

  test.each(['built_with', 'at_source', 'outputs', 'config_source', 'copied', 'added-frame'])('check observes planted %s drift through the shared validator', field => {
    const { dir, args, load } = setup();
    rigVersionCommand(args);
    const project = load();
    const version = (project.versions as JsonObject[])[0]!;
    if (field === 'built_with') obj(version.built_with)['@rig-c/core'] = '0.0.0';
    if (field === 'at_source') obj(version.at_source).pointer = '/missing';
    if (field === 'outputs') writeFileSync(join(dir, 'outputs/v1/idle/idle@4fps/f0000.png'), 'changed bytes');
    if (field === 'config_source') obj(obj(version.registration).config_source).sha256 = 'a'.repeat(64);
    if (field === 'copied') obj(obj(version.registration).copied).files = 1;
    if (field === 'added-frame') writeFileSync(join(dir, 'outputs/v1/idle/idle@4fps/f9999.png'), 'new frame');
    const code = field === 'built_with' ? 'RIG_TOOLCHAIN_MISMATCH' : field === 'at_source' ? 'RIG_AT_SOURCE_INVALID' : 'RIG_REGISTRATION_FILE_INVALID';
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain(code);
    expect(checkProject(dir, project).refusals.map(f => f.code)).toContain(code);
  });

  test('a reopen before registration refuses the cited old bound, but a later reopen preserves history', () => {
    const { dir, args, load } = setup();
    const project = load();
    project.reopens = [{ stage: 'interview', from_stage: 'rig-review', by: 'user', at: '2026-11-07T07:47:00Z', verbatim: 'Reopen', steps_before: [] }];
    put(dir, 'project.json', project);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'RIG_BUILD_BEFORE_REOPEN');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    project.reopens = [];
    put(dir, 'project.json', project);
    rigVersionCommand(args);
    const registered = load();
    registered.reopens = [{ stage: 'interview', from_stage: 'rig-review', by: 'user', at: '2099-01-01T00:00:00Z', verbatim: 'Reopen later', steps_before: [] }];
    expect(rigRegistrationFindings(dir, registered)).toEqual([]);
  });

  test('missing producer files and invalid compile spec roll back the copied package and version', () => {
    const { dir, args } = setup();
    put(dir, 'source/compile-report.json', { spec: 'unknown', gates: [] });
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'RIG_REGISTRATION_FILE_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
  });

  test('a declared built_with disagreement is RED before another registration writes', () => {
    const { dir, args, load } = setup();
    rigVersionCommand(args);
    const project = load();
    obj((project.versions as JsonObject[])[0]!.built_with)['@rig-c/core'] = '0.0.0';
    put(dir, 'project.json', project);
    const before = readFileSync(join(dir, 'project.json'));
    refused(['2', ...args.slice(1)], 'RIG_TOOLCHAIN_MISMATCH');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v2'))).toBe(false);
  });

  test('accepts explicitly cited UTC microseconds and an escaped JSON pointer', () => {
    const { dir, args, load } = setup();
    put(dir, 'source/at-source.json', { 'event/date': { '~at': '2026-11-06T20:44:42.081669+00:00' } });
    args[args.indexOf('--at-pointer') + 1] = '/event~1date/~0at';
    rigVersionCommand(args);
    expect((load().versions as JsonObject[])[0]!.at).toBe('2026-11-06T20:44:42.081669+00:00');
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test('copies and binds a requirements-relative figure mask with its existing producer hash', () => {
    const { dir, args, load } = setup();
    const mask = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    const hash = new Bun.CryptoHasher('sha256').update(mask).digest('hex');
    put(dir, 'source/requirements.json', { setup_painting: { required: true, figure_mask: { path: 'mask.png', sha256: hash } } });
    writeFileSync(join(dir, 'source/mask.png'), mask);
    rigVersionCommand(args);
    expect(readFileSync(join(dir, 'derived/review/v1/mask.png'))).toEqual(mask);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test('relative donor directories and editor files survive package regeneration', () => {
    const { dir, args, load } = setup();
    put(dir, 'source/donor/layers.json', { layers: [] });
    put(dir, 'source/donor/source.png', 'synthetic source input');
    put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: {
      take: [{ run: 'full', tags: ['piece'], run_dir: 'donor', st_input: 'donor/source.png' }],
      editor_receipts: { receipts: [{ file: 'donor/source.png' }] },
    } });
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    rigVersionCommand([...args, '--citations', 'source/citations.json']);
    const version = (load().versions as JsonObject[])[0]!;
    const before = version.review_package;
    expect(readFileSync(join(dir, 'derived/review/v1/inputs/assemble/take/0/run_dir/layers.json'), 'utf8')).toBe('{"layers":[]}\n');
    rmSync(join(dir, 'derived/review/v1'), { recursive: true });
    reviewPackageCommand(['1', dir, '--config', String(obj(obj(version.provenance).config).path), '--from', 'outputs/v1/out']);
    expect((load().versions as JsonObject[])[0]!.review_package).toEqual(before);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test.each(['rig/rig.json', 'rig/motion.json', 'build/skeleton.model.json'])('refuses unsupported producer spec in %s before recording', path => {
    const { dir, args } = setup();
    const source = JSON.parse(readFileSync(join(dir, 'source', path), 'utf8'));
    source.spec = 'unsupported/1';
    put(dir, `source/${path}`, source);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'RIG_REGISTRATION_FILE_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
  });

  test.each([
    ['an uncited config section', 'SECTION_UNCITED', { key: 'synthetic', requirements: 'requirements.json', bones: {} }, null],
    ['a misspelt cited section', 'SECTION_UNKNOWN', { key: 'synthetic', requirements: 'requirements.json' }, { bonez: [] }],
  ])('the full check refuses %s before recording', (_name, code, config, citations) => {
    const { dir, args } = setup();
    put(dir, 'source/config.json', config);
    if (citations) { put(dir, 'source/citations.json', citations); args.push('--citations', 'source/citations.json'); }
    expect(checkProject(dir).refusals).toEqual([]);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);
  });

  test('a pre-existing unrelated refusal does not block a valid registration', () => {
    const { dir, args, load } = setup();
    const project = load();
    // An input inventory that is not a list; registration never touches inputs.
    project.inputs = 'not-a-list';
    put(dir, 'project.json', project);
    const planted = checkProject(dir).refusals.map(f => `${f.code} ${f.path}`);
    expect(planted).toEqual(['INPUTS_INVALID inputs']);
    rigVersionCommand(args);
    expect((load().versions as JsonObject[]).length).toBe(1);
    expect(checkProject(dir).refusals.map(f => `${f.code} ${f.path}`)).toEqual(planted);
  });

  test('a record whose stage check stopped early is no baseline: registration is refused', () => {
    const { dir, args, load } = setup();
    const project = load();
    project.stage = 'no-such-stage';
    put(dir, 'project.json', project);
    expect(checkProject(dir).refusals.map(f => f.code)).toEqual(['STAGE_UNKNOWN']);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'STAGE_UNKNOWN');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);
  });

  test('admits n > maxRegistered when every intermediate K has an occupied unregistered destination and binds registration.skipped', () => {
    const { dir, args, load } = setup();
    put(dir, 'outputs/v1/legacy.txt', 'occupied v1 output\n');
    put(dir, 'evidence/v2/registration/note.txt', 'occupied v2 registration\n');
    put(dir, 'derived/review/v2/index.html', '<html>v2</html>\n');
    mkdirSync(join(dir, 'derived/review/v3'), { recursive: true });

    const v4Args = ['4', ...args.slice(1)];
    rigVersionCommand(v4Args);

    const projectAfterV4 = load();
    const v4 = (projectAfterV4.versions as JsonObject[])[0]!;
    expect(v4.n).toBe(4);
    const reg4 = obj(v4.registration);
    expect(reg4.skipped).toEqual([
      { n: 1, destinations: ['outputs/v1'] },
      { n: 2, destinations: ['evidence/v2/registration', 'derived/review/v2'] },
      { n: 3, destinations: ['derived/review/v3'] },
    ]);
    expect(rigRegistrationFindings(dir, projectAfterV4)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);

    // Next contiguous registration (v5) needs no skipped entry.
    rigVersionCommand(['5', ...args.slice(1)]);
    const projectAfterV5 = load();
    const v5 = (projectAfterV5.versions as JsonObject[])[1]!;
    expect(v5.n).toBe(5);
    expect(obj(v5.registration).skipped).toBeUndefined();
    expect(rigRegistrationFindings(dir, projectAfterV5)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test('refuses occupied destination on n itself, unexplained gaps, <= maxRegistered, and non-directory/symlinked skipped paths without touching project.json', () => {
    const { dir, args } = setup();
    put(dir, 'outputs/v1/legacy.txt', 'occupied v1\n');

    // Unexplained gap at v2 when requesting v3 (v1 occupied, v2 empty)
    const beforeGap = readFileSync(join(dir, 'project.json'));
    refused(['3', ...args.slice(1)], 'RIG_REGISTRATION_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeGap);
    expect(existsSync(join(dir, 'outputs/v3'))).toBe(false);

    // Requesting v2 when v2 itself has an occupied destination (evidence/v2/registration or derived/review/v2)
    put(dir, 'derived/review/v2/existing.txt', 'occupied target\n');
    const beforeTargetOccupied = readFileSync(join(dir, 'project.json'));
    refused(['2', ...args.slice(1)], 'RIG_REGISTRATION_EXISTS');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeTargetOccupied);
    expect(readFileSync(join(dir, 'derived/review/v2/existing.txt'), 'utf8')).toBe('occupied target\n');
    rmSync(join(dir, 'derived/review/v2'), { recursive: true });

    // Non-directory file or symlink at skipped destination refuses with RIG_REGISTRATION_PATH_INVALID
    rmSync(join(dir, 'outputs/v1'), { recursive: true });
    put(dir, 'outputs/v1', 'regular file instead of directory');
    const beforeFileDest = readFileSync(join(dir, 'project.json'));
    refused(['2', ...args.slice(1)], 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeFileDest);
    rmSync(join(dir, 'outputs/v1'));

    mkdirSync(join(dir, 'source/real-v1'), { recursive: true });
    symlinkSync(join(dir, 'source/real-v1'), join(dir, 'outputs/v1'));
    const beforeSymlinkDest = readFileSync(join(dir, 'project.json'));
    refused(['2', ...args.slice(1)], 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeSymlinkDest);
    rmSync(join(dir, 'outputs/v1'));

    // Register v2 cleanly with v1 occupied by a real directory, then refuse n <= maxRegistered (v1 and v2) with RIG_REGISTRATION_INVALID
    put(dir, 'outputs/v1/legacy.txt', 'occupied v1\n');
    rigVersionCommand(['2', ...args.slice(1)]);
    const afterV2 = readFileSync(join(dir, 'project.json'));
    refused(['1', ...args.slice(1)], 'RIG_REGISTRATION_INVALID');
    refused(['2', ...args.slice(1)], 'RIG_REGISTRATION_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(afterV2);

    // Malformed existing versions entries (string n or non-object) refuse with RIG_REGISTRATION_INVALID and leave project.json byte-identical
    for (const malformed of [[{ n: '1' }], [null]]) {
      const broken = JSON.parse(afterV2.toString('utf8')) as JsonObject;
      broken.versions = malformed as unknown as JsonObject[];
      put(dir, 'project.json', broken);
      const beforeMalformed = readFileSync(join(dir, 'project.json'));
      refused(['3', ...args.slice(1)], 'RIG_REGISTRATION_INVALID');
      expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeMalformed);
    }
  });

  test('validates registration.skipped receipt shape, remains valid after historical archival, and roundtrips through record publication retained root', () => {
    const { dir, args, load } = setup();
    const painting = Buffer.from('Synthetic immutable painting input');
    put(dir, 'inputs/painting.png', painting.toString('utf8'));
    const initial = load();
    initial.inputs = [{ ...(initial.inputs as JsonObject[])[0], path: 'inputs/painting.png', sha256: jobHash(painting), bytes: painting.length }];
    put(dir, 'project.json', initial);
    // Empty historical skipped directory: no files inside outputs/v1.
    mkdirSync(join(dir, 'outputs/v1'), { recursive: true });
    rigVersionCommand(['2', ...args.slice(1)]);

    // 1. Registration -> record publication inventory (while empty outputs/v1 exists in dir) -> retained root (copying only sealed files, without fabricating outputs/v1).
    const root = realpathSync(dir);
    const record = { path: 'project.json' as const, sha256: jobHash(readFileSync(join(root, 'project.json'))) };
    const inventory = readRecordPublished({ root, record, result: { kind: 'plan' }, phase: 'inventory' }, testClock.now());
    const retainedRoot = join(realpathSync(dirname(dir)), 'retained');
    mkdirSync(retainedRoot);
    for (const file of inventory.files) {
      mkdirSync(dirname(join(retainedRoot, file.path)), { recursive: true });
      cpSync(join(root, file.path), join(retainedRoot, file.path));
    }
    expect(existsSync(join(root, 'outputs/v1'))).toBe(true);
    expect(existsSync(join(retainedRoot, 'outputs/v1'))).toBe(false);
    expect(checkProject(retainedRoot).refusals).toEqual([]);
    expect(readRecordPublished({
      root: retainedRoot,
      record,
      result: { kind: 'plan' },
      phase: 'retained',
      parts: inventory.parts,
    }, testClock.now())).toEqual(inventory);

    // 2. Receipt remains valid in the live root after the historical unregistered directory is archived/removed from disk.
    rmSync(join(dir, 'outputs/v1'), { recursive: true });
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);

    // 3. Receipt shape invalid cases in rigRegistrationFindings and checkProject.
    for (const badSkipped of [
      undefined,
      [],
      [{ n: 2, destinations: ['outputs/v2'] }],
      [{ n: 1, destinations: [] }],
      [{ n: 1, destinations: ['outputs/v99'] }],
      [{ n: 1, destinations: ['derived/review/v1', 'outputs/v1'] }],
      [{ n: 1, destinations: ['outputs/v1', 'outputs/v1'] }],
      [{ n: 1, destinations: ['outputs/v1'], extra: true }],
    ]) {
      const candidate = load();
      const reg = obj((candidate.versions as JsonObject[])[0]!.registration);
      if (badSkipped === undefined) delete reg.skipped;
      else reg.skipped = badSkipped as unknown as JsonObject[];
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_INVALID');
      expect(checkProject(dir, candidate).refusals.map(f => f.code)).toContain('RIG_REGISTRATION_INVALID');
    }

    // 4. Supplying registration.skipped when no version gap exists refuses with RIG_REGISTRATION_INVALID.
    const { dir: dirNoSkip, args: argsNoSkip, load: loadNoSkip } = setup();
    rigVersionCommand(argsNoSkip);
    const unexpectedSkipped = loadNoSkip();
    obj((unexpectedSkipped.versions as JsonObject[])[0]!.registration).skipped = [{ n: 1, destinations: ['outputs/v1'] }];
    expect(rigRegistrationFindings(dirNoSkip, unexpectedSkipped).map(f => f.code)).toContain('RIG_REGISTRATION_INVALID');
  });

  test('retains original config/requirements and relative assets byte-identical, adapts runtime package paths, regenerates review-package, and roundtrips record publication', () => {
    const setupRelativeAssets = (explicitAdapter: boolean, literalMask: boolean) => {
      const { dir, load } = setup();
      const paintingBytes = Buffer.from('Synthetic painting input bytes');
      const backdropBytes = Buffer.from('Synthetic backdrop input bytes');
      const maskBytes = Buffer.from('Synthetic figure mask PNG bytes');
      const receiptBytes = [
        Buffer.from('Synthetic receipt author:hand_r.png'),
        Buffer.from('Synthetic receipt author:hand_l.png'),
        Buffer.from('Synthetic receipt handwear-r.png'),
        Buffer.from('Synthetic receipt handwear-l.png'),
      ];
      writeFileSync(join(dir, 'inputs/painting.png'), paintingBytes);
      writeFileSync(join(dir, 'inputs/background.png'), backdropBytes);
      const originalMaskPath = literalMask ? 'evidence/v1/figure_mask.png' : 'evidence/figure-mask/figure_mask.png';
      mkdirSync(dirname(join(dir, originalMaskPath)), { recursive: true });
      writeFileSync(join(dir, originalMaskPath), maskBytes);
      mkdirSync(join(dir, 'derived/v0/layers/full/parts'), { recursive: true });
      const receiptNames = ['author:hand_r.png', 'author:hand_l.png', 'handwear-r.png', 'handwear-l.png'];
      for (const [i, name] of receiptNames.entries()) {
        writeFileSync(join(dir, 'derived/v0/layers/full/parts', name), receiptBytes[i]!);
      }

      const initial = load();
      const guide = obj(waypoint(initial, 'assemble').guide);
      obj(guide.value).ground = 'busy';
      arr(guide.asks).push({ id: 'ground', state: 'user' });
      const baseInput = (initial.inputs as JsonObject[])[0]!;
      initial.inputs = [
        { ...baseInput, path: 'inputs/painting.png', sha256: jobHash(paintingBytes), bytes: paintingBytes.length },
        { ...baseInput, path: 'inputs/background.png', sha256: jobHash(backdropBytes), bytes: backdropBytes.length },
      ];
      initial.derived = [{
        path: originalMaskPath,
        kind: 'prepared-input',
        sha256: jobHash(maskBytes),
        bytes: maskBytes.length,
        at: '2026-11-06T20:00:00Z',
        tool: 'birefnet',
        operation: 'birefnet-general: alpha >= 128; foreground subtracted: none',
        source: { path: 'inputs/painting.png', sha256: jobHash(paintingBytes) },
      }];
      put(dir, 'project.json', initial);

      const originalConfig: JsonObject = {
        key: 'synthetic',
        requirements: 'requirements.json',
        assemble: {
          project: 'visible',
          ground: 'busy',
          editor_receipts: {
            trace_parts: true,
            receipts: receiptNames.map((name, i) => ({
              part: name.replace('.png', ''),
              file: `../../derived/v0/layers/full/parts/${name}`,
              sha256: jobHash(receiptBytes[i]!),
            })),
          },
        },
      };
      const originalRequirements: JsonObject = {
        spec: 'spine-parts-requirements/1',
        fps: 24,
        requirements: [],
        setup_painting: {
          required: true,
          figure_mask: { path: literalMask ? 'figure_mask.png' : '../figure-mask/figure_mask.png', sha256: jobHash(maskBytes) },
          backdrop: { path: '../../inputs/background.png', sha256: jobHash(backdropBytes) },
        },
        seam_over_motion: { required: true },
        boundary_colour: { max_step_excess: 12 },
      };
      put(dir, 'evidence/v1/config.json', originalConfig);
      put(dir, 'evidence/v1/requirements.json', originalRequirements);
      put(dir, 'evidence/v1/citations.json', {
        assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis', 'ground'] }],
      });
      put(dir, 'source/compile-report.json', {
        spec: 'build-report/1',
        command: 'build',
        gates: [
          { gate: 'seam_over_motion', failures: [], checked: 4 },
          { gate: 'boundary_colour', failures: [], worst_step_excess: 4.5 },
        ],
      });
      const adapterEntries = explicitAdapter ? [
        ...receiptNames.map((name, i) => ({
          doc: 'config',
          pointer: `/assemble/editor_receipts/receipts/${i}/file`,
          before: `../../derived/v0/layers/full/parts/${name}`,
          after: `inputs/editor_receipts/${i}.png`,
        })),
        {
          doc: 'requirements',
          pointer: '/setup_painting/figure_mask/path',
          before: '../figure-mask/figure_mask.png',
          after: 'inputs/setup_painting/figure_mask.png',
        },
        {
          doc: 'requirements',
          pointer: '/setup_painting/backdrop/path',
          before: '../../inputs/background.png',
          after: 'inputs/setup_painting/backdrop.png',
        },
      ] : [];
      put(dir, 'evidence/v1/adapter.json', adapterEntries);
      const v1Args = [
        '1', dir,
        '--parts', 'source/parts',
        '--rig', 'source/rig',
        '--build', 'source/build',
        '--idle', 'source/idle',
        '--config', 'evidence/v1/config.json',
        '--path-adapter', 'evidence/v1/adapter.json',
        '--compile-report', 'source/compile-report.json',
        '--toolchain-lock', 'source/package-lock.json',
        '--run-record', 'source/run.json',
        '--at-source', 'source/at-source.json',
        '--at-pointer', '/finished_at',
        '--citations', 'evidence/v1/citations.json',
        '--by', 'registrant',
        '--json',
      ];
      return { dir, v1Args, load, maskBytes, backdropBytes, receiptBytes, receiptNames, originalMaskPath };
    };

    for (const [explicitAdapter, literalMask] of [[true, false], [false, false], [false, true]] as const) {
      const { dir, v1Args, load, maskBytes, backdropBytes, receiptBytes, receiptNames, originalMaskPath } = setupRelativeAssets(explicitAdapter, literalMask);
      const origConfigBytes = readFileSync(join(dir, 'evidence/v1/config.json'));
      const origReqBytes = readFileSync(join(dir, 'evidence/v1/requirements.json'));

      expect(rigVersionCommand(v1Args).exit).toBe(0);

      // 1. Original config and requirements are retained byte-identical.
      expect(readFileSync(join(dir, 'evidence/v1/registration/config-source.json'))).toEqual(origConfigBytes);
      expect(readFileSync(join(dir, 'evidence/v1/registration/requirements-source.json'))).toEqual(origReqBytes);

      const project = load();
      const version = (project.versions as JsonObject[])[0]!;
      const reg = obj(version.registration);
      expect(obj(reg.config_source).sha256).toBe(jobHash(origConfigBytes));
      expect(obj(reg.requirements_source).sha256).toBe(jobHash(origReqBytes));
      expect(obj(reg.requirements_source).source_path).toBe('evidence/v1/requirements.json');
      expect(obj(reg.requirements).path).toBe('evidence/v1/registration/requirements.json');

      // 2. Runtime config and requirements in evidence and review package match each other and have literal paths.
      const runtimeConfig = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/config.json'), 'utf8')) as JsonObject;
      const pkgConfig = JSON.parse(readFileSync(join(dir, 'derived/review/v1/config.json'), 'utf8')) as JsonObject;
      expect(pkgConfig).toEqual(runtimeConfig);

      const runtimeReq = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/requirements.json'), 'utf8')) as JsonObject;
      const pkgReq = JSON.parse(readFileSync(join(dir, 'derived/review/v1/requirements.json'), 'utf8')) as JsonObject;
      expect(pkgReq).toEqual(runtimeReq);

      const maskAfter = literalMask ? 'figure_mask.png' : explicitAdapter ? 'inputs/setup_painting/figure_mask.png' : 'inputs/setup_painting/figure_mask/path';
      const backdropAfter = explicitAdapter ? 'inputs/setup_painting/backdrop.png' : 'inputs/setup_painting/backdrop/path';
      expect(obj(obj(runtimeReq.setup_painting).figure_mask).path).toBe(maskAfter);
      expect(obj(obj(runtimeReq.setup_painting).figure_mask).sha256).toBe(jobHash(maskBytes));
      expect(obj(obj(runtimeReq.setup_painting).backdrop).path).toBe(backdropAfter);
      expect(obj(obj(runtimeReq.setup_painting).backdrop).sha256).toBe(jobHash(backdropBytes));

      expect(readFileSync(join(dir, 'evidence/v1/registration', maskAfter))).toEqual(maskBytes);
      expect(readFileSync(join(dir, 'derived/review/v1', maskAfter))).toEqual(maskBytes);
      expect(readFileSync(join(dir, 'evidence/v1/registration', backdropAfter))).toEqual(backdropBytes);
      expect(readFileSync(join(dir, 'derived/review/v1', backdropAfter))).toEqual(backdropBytes);

      const runtimeReceipts = obj(obj(runtimeConfig.assemble).editor_receipts).receipts as JsonObject[];
      for (let i = 0; i < 4; i++) {
        const expectedPath = explicitAdapter ? `inputs/editor_receipts/${i}.png` : `inputs/assemble/editor_receipts/receipts/${i}/file`;
        expect(runtimeReceipts[i]!.file).toBe(expectedPath);
        expect(runtimeReceipts[i]!.sha256).toBe(jobHash(receiptBytes[i]!));
        expect(readFileSync(join(dir, 'evidence/v1/registration', expectedPath))).toEqual(receiptBytes[i]!);
        expect(readFileSync(join(dir, 'derived/review/v1', expectedPath))).toEqual(receiptBytes[i]!);
        expect(readFileSync(join(dir, 'derived/v0/layers/full/parts', receiptNames[i]!))).toEqual(receiptBytes[i]!);
      }

      expect(readFileSync(join(dir, 'evidence/v1/config.json'))).toEqual(origConfigBytes);
      expect(readFileSync(join(dir, 'evidence/v1/requirements.json'))).toEqual(origReqBytes);
      expect(readFileSync(join(dir, originalMaskPath))).toEqual(maskBytes);
      expect(readFileSync(join(dir, 'inputs/background.png'))).toEqual(backdropBytes);

      // 3. Full check and registration findings pass.
      expect(rigRegistrationFindings(dir, project)).toEqual([]);
      expect(checkProject(dir).refusals).toEqual([]);

      // 4. Review package regeneration preserves all adapted runtime inputs.
      const beforePkg = version.review_package;
      rmSync(join(dir, 'derived/review/v1'), { recursive: true });
      reviewPackageCommand(['1', dir, '--config', 'evidence/v1/registration/config.json', '--from', 'outputs/v1/out']);
      expect((load().versions as JsonObject[])[0]!.review_package).toEqual(beforePkg);
      expect(checkProject(dir).refusals).toEqual([]);

      // 5. Record publication inventory -> retained root roundtrip is GREEN.
      const root = realpathSync(dir);
      const record = { path: 'project.json' as const, sha256: jobHash(readFileSync(join(root, 'project.json'))) };
      const inventory = readRecordPublished({ root, record, result: { kind: 'plan' }, phase: 'inventory' }, testClock.now());
      const retainedRoot = join(realpathSync(dirname(dir)), `retained-${String(explicitAdapter)}`);
      mkdirSync(retainedRoot);
      for (const file of inventory.files) {
        mkdirSync(dirname(join(retainedRoot, file.path)), { recursive: true });
        cpSync(join(root, file.path), join(retainedRoot, file.path));
      }
      expect(checkProject(retainedRoot).refusals).toEqual([]);
      expect(readRecordPublished({
        root: retainedRoot,
        record,
        result: { kind: 'plan' },
        phase: 'retained',
        parts: inventory.parts,
      }, testClock.now())).toEqual(inventory);
    }
  });

  test('refuses unlisted runtime edits, wrong path_adapter entries, target collisions, missing/tampered assets, stale figure-mask path, outside-project refs, and symlinks', () => {
    const { dir, load } = setup();
    const maskBytes = Buffer.from('Synthetic figure mask bytes');
    const backdropBytes = Buffer.from('Synthetic backdrop bytes');
    const receiptBytes = Buffer.from('Synthetic receipt bytes');
    const paintingBytes = Buffer.from('Synthetic painting bytes');
    writeFileSync(join(dir, 'inputs/painting.png'), paintingBytes);
    writeFileSync(join(dir, 'inputs/background.png'), backdropBytes);
    mkdirSync(join(dir, 'evidence/figure-mask'), { recursive: true });
    writeFileSync(join(dir, 'evidence/figure-mask/figure_mask.png'), maskBytes);
    mkdirSync(join(dir, 'derived/v0/parts'), { recursive: true });
    writeFileSync(join(dir, 'derived/v0/parts/author:hand_r.png'), receiptBytes);

    const baseProject = load();
    const guide = obj(waypoint(baseProject, 'assemble').guide);
    obj(guide.value).ground = 'busy';
    arr(guide.asks).push({ id: 'ground', state: 'user' });
    const baseInput = (baseProject.inputs as JsonObject[])[0]!;
    baseProject.inputs = [
      { ...baseInput, path: 'inputs/painting.png', sha256: jobHash(paintingBytes), bytes: paintingBytes.length },
      { ...baseInput, path: 'inputs/background.png', sha256: jobHash(backdropBytes), bytes: backdropBytes.length },
    ];
    baseProject.derived = [{
      path: 'evidence/figure-mask/figure_mask.png',
      kind: 'prepared-input',
      sha256: jobHash(maskBytes),
      bytes: maskBytes.length,
      at: '2026-11-06T20:00:00Z',
      tool: 'birefnet',
      operation: 'birefnet-general: alpha >= 128; foreground subtracted: none',
      source: { path: 'inputs/painting.png', sha256: jobHash(paintingBytes) },
    }];
    put(dir, 'project.json', baseProject);

    const writeValidSources = () => {
      put(dir, 'evidence/v1/config.json', {
        key: 'synthetic',
        requirements: 'requirements.json',
        assemble: {
          project: 'visible',
          ground: 'busy',
          editor_receipts: {
            trace_parts: true,
            receipts: [{ part: 'hand_r', file: '../../derived/v0/parts/author:hand_r.png', sha256: jobHash(receiptBytes) }],
          },
        },
      });
      put(dir, 'evidence/v1/requirements.json', {
        spec: 'spine-parts-requirements/1',
        fps: 4,
        requirements: [],
        setup_painting: {
          required: true,
          figure_mask: { path: '../figure-mask/figure_mask.png', sha256: jobHash(maskBytes) },
          backdrop: { path: '../../inputs/background.png', sha256: jobHash(backdropBytes) },
        },
        seam_over_motion: { required: true },
        boundary_colour: { max_step_excess: 12 },
      });
      put(dir, 'evidence/v1/citations.json', {
        assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis', 'ground'] }],
      });
      put(dir, 'source/compile-report.json', {
        spec: 'build-report/1',
        command: 'build',
        gates: [
          { gate: 'seam_over_motion', failures: [], checked: 2 },
          { gate: 'boundary_colour', failures: [], worst_step_excess: 1 },
        ],
      });
      put(dir, 'evidence/v1/adapter.json', []);
    };
    writeValidSources();

    const v1Args = [
      '1', dir,
      '--parts', 'source/parts',
      '--rig', 'source/rig',
      '--build', 'source/build',
      '--idle', 'source/idle',
      '--config', 'evidence/v1/config.json',
      '--path-adapter', 'evidence/v1/adapter.json',
      '--compile-report', 'source/compile-report.json',
      '--toolchain-lock', 'source/package-lock.json',
      '--run-record', 'source/run.json',
      '--at-source', 'source/at-source.json',
      '--at-pointer', '/finished_at',
      '--citations', 'evidence/v1/citations.json',
      '--by', 'registrant',
      '--json',
    ];

    // 1. Wrong path_adapter cases at registration time (wrong before, wrong pointer, non-asset pointer, unknown doc, duplicate pointer).
    for (const badAdapter of [
      [{ doc: 'config', pointer: '/assemble/editor_receipts/receipts/0/file', before: 'wrong.png', after: 'inputs/r0.png' }],
      [{ doc: 'config', pointer: '/assemble/editor_receipts/receipts/99/file', before: '../../derived/v0/parts/author:hand_r.png', after: 'inputs/r0.png' }],
      [{ doc: 'config', pointer: '/key', before: 'synthetic', after: 'inputs/key' }],
      [{ doc: 'requirements', pointer: '/setup_painting/figure_mask/path', before: 'wrong.png', after: 'inputs/mask.png' }],
      [{ doc: 'requirements', pointer: '/fps', before: '4', after: 'inputs/fps' }],
      [{ doc: 'unknown', pointer: '/setup_painting/figure_mask/path', before: '../figure-mask/figure_mask.png', after: 'inputs/mask.png' }],
      [{ doc: 'requirements', pointer: '/setup_painting/figure_mask/path', before: '../figure-mask/figure_mask.png', after: '../escape.png' }],
    ]) {
      put(dir, 'evidence/v1/adapter.json', badAdapter);
      const before = readFileSync(join(dir, 'project.json'));
      refused(v1Args, 'RIG_PATH_ADAPTER_INVALID');
      expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
      expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    }

    // 2. Target path collision in path_adapter refuses with RIG_REGISTRATION_PATH_INVALID.
    put(dir, 'evidence/v1/adapter.json', [
      { doc: 'requirements', pointer: '/setup_painting/figure_mask/path', before: '../figure-mask/figure_mask.png', after: 'inputs/shared.png' },
      { doc: 'requirements', pointer: '/setup_painting/backdrop/path', before: '../../inputs/background.png', after: 'inputs/shared.png' },
    ]);
    refused(v1Args, 'RIG_REGISTRATION_PATH_INVALID');
    writeValidSources();

    // 3. Outside-project relative references refuse with RIG_REGISTRATION_PATH_INVALID before copy/write.
    for (const mutateOutside of [
      () => {
        const cfg = JSON.parse(readFileSync(join(dir, 'evidence/v1/config.json'), 'utf8')) as JsonObject;
        ((obj(obj(cfg.assemble).editor_receipts).receipts as JsonObject[])[0]!).file = '../../../outside.png';
        put(dir, 'evidence/v1/config.json', cfg);
      },
      () => {
        const req = JSON.parse(readFileSync(join(dir, 'evidence/v1/requirements.json'), 'utf8')) as JsonObject;
        obj(obj(req.setup_painting).figure_mask).path = '../../../outside-mask.png';
        put(dir, 'evidence/v1/requirements.json', req);
      },
      () => {
        const req = JSON.parse(readFileSync(join(dir, 'evidence/v1/requirements.json'), 'utf8')) as JsonObject;
        obj(obj(req.setup_painting).backdrop).path = '../../../outside-backdrop.png';
        put(dir, 'evidence/v1/requirements.json', req);
      },
    ]) {
      writeValidSources();
      mutateOutside();
      refused(v1Args, 'RIG_REGISTRATION_PATH_INVALID');
      expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    }

    // 4. Symlinked assets or symlinked parent directories refuse with RIG_REGISTRATION_PATH_INVALID.
    writeValidSources();
    rmSync(join(dir, 'derived/v0/parts/author:hand_r.png'));
    writeFileSync(join(dir, 'derived/v0/real-hand.png'), receiptBytes);
    symlinkSync(join(dir, 'derived/v0/real-hand.png'), join(dir, 'derived/v0/parts/author:hand_r.png'));
    refused(v1Args, 'RIG_REGISTRATION_PATH_INVALID');
    rmSync(join(dir, 'derived/v0/parts/author:hand_r.png'));
    writeFileSync(join(dir, 'derived/v0/parts/author:hand_r.png'), receiptBytes);

    rmSync(join(dir, 'inputs/background.png'));
    symlinkSync(join(dir, 'inputs/painting.png'), join(dir, 'inputs/background.png'));
    refused(v1Args, 'RIG_REGISTRATION_PATH_INVALID');
    rmSync(join(dir, 'inputs/background.png'));
    writeFileSync(join(dir, 'inputs/background.png'), backdropBytes);

    // 5. Missing asset or declared sha256 mismatch refuses with RIG_REGISTRATION_FILE_INVALID.
    rmSync(join(dir, 'inputs/background.png'));
    refused(v1Args, 'RIG_REGISTRATION_FILE_INVALID');
    writeFileSync(join(dir, 'inputs/background.png'), Buffer.from('wrong backdrop bytes'));
    refused(v1Args, 'RIG_REGISTRATION_FILE_INVALID');
    writeFileSync(join(dir, 'inputs/background.png'), backdropBytes);

    writeFileSync(join(dir, 'derived/v0/parts/author:hand_r.png'), Buffer.from('wrong receipt bytes'));
    refused(v1Args, 'RIG_REGISTRATION_FILE_INVALID');
    writeFileSync(join(dir, 'derived/v0/parts/author:hand_r.png'), receiptBytes);

    // 6. Stale user asset at a different path (same sha256) refuses with FIGURE_MASK_UNRECORDED.
    const staleProject = load();
    staleProject.derived = [{
      ...(staleProject.derived as JsonObject[])[0]!,
      path: 'evidence/stale-mask.png',
    }];
    put(dir, 'project.json', staleProject);
    refused(v1Args, 'FIGURE_MASK_UNRECORDED');
    put(dir, 'project.json', baseProject);

    // 7. Register v1 cleanly, then plant post-registration mutations and verify rigRegistrationFindings catches each one.
    expect(rigVersionCommand(v1Args).exit).toBe(0);
    const cleanProject = load();
    const rebindFile = (candidate: JsonObject, relPath: string, newBytes: Buffer) => {
      writeFileSync(join(dir, relPath), newBytes);
      const h = jobHash(newBytes);
      const ver = (candidate.versions as JsonObject[])[0]!;
      const reg = obj(ver.registration);
      for (const f of reg.files as JsonObject[]) {
        if (f.path === relPath) f.sha256 = h;
      }
      if (relPath === 'evidence/v1/registration/config.json') obj(obj(ver.provenance).config).sha256 = h;
      if (relPath === 'evidence/v1/registration/requirements.json') obj(reg.requirements).sha256 = h;
      if (relPath === 'evidence/v1/registration/path-adapter.json') obj(reg.path_adapter).sha256 = h;
    };

    // 7a. Unlisted runtime field change in config.json (even when hashes are updated).
    {
      const candidate = structuredClone(cleanProject);
      const runtimeCfg = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/config.json'), 'utf8')) as JsonObject;
      runtimeCfg.key = 'tampered-key';
      rebindFile(candidate, 'evidence/v1/registration/config.json', Buffer.from(`${JSON.stringify(runtimeCfg, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/config.json'), readFileSync(join(dir, 'derived/review/v1/config.json')));
    }

    // 7b. Unlisted runtime field change in requirements.json (even when hashes are updated).
    {
      const candidate = structuredClone(cleanProject);
      const runtimeReq = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/requirements.json'), 'utf8')) as JsonObject;
      runtimeReq.fps = 99;
      rebindFile(candidate, 'evidence/v1/registration/requirements.json', Buffer.from(`${JSON.stringify(runtimeReq, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/requirements.json'), readFileSync(join(dir, 'derived/review/v1/requirements.json')));
    }

    // 7c. Tampered path-adapter.json with wrong before or non-asset pointer refuses with RIG_PATH_ADAPTER_INVALID.
    {
      const savedAdapter = readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'));
      const candidate = structuredClone(cleanProject);
      const badRows = JSON.parse(savedAdapter.toString('utf8')) as JsonObject[];
      badRows[0]!.before = 'wrong-before.png';
      rebindFile(candidate, 'evidence/v1/registration/path-adapter.json', Buffer.from(`${JSON.stringify(badRows, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_PATH_ADAPTER_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'), savedAdapter);
    }

    // 7d. Tampered retained asset bytes in evidence/v1/registration refuse with RIG_REGISTRATION_FILE_INVALID.
    {
      const targetRel = 'evidence/v1/registration/inputs/setup_painting/backdrop/path';
      const savedBackdrop = readFileSync(join(dir, targetRel));
      const candidate = structuredClone(cleanProject);
      rebindFile(candidate, targetRel, Buffer.from('tampered backdrop bytes'));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, targetRel), savedBackdrop);
    }

    // 7e. Removing a declared config pointer row from path-adapter.json on a new pointer-adapted record refuses with RIG_REGISTRATION_FILE_INVALID.
    {
      const savedAdapter = readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'));
      const candidate = structuredClone(cleanProject);
      const rowsOnlyReq = (JSON.parse(savedAdapter.toString('utf8')) as JsonObject[]).filter(r => r.doc === 'requirements');
      rebindFile(candidate, 'evidence/v1/registration/path-adapter.json', Buffer.from(`${JSON.stringify(rowsOnlyReq, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'), savedAdapter);
    }
    expect(rigRegistrationFindings(dir, cleanProject)).toEqual([]);
  });

  test('keeps the pointer contract after removing its sole adapter row, including stripped requirements bindings', () => {
    for (const removeRequirementsBindings of [false, true]) {
      const { dir, args, load } = setup();
      put(dir, 'source/donor/input.png', 'synthetic receipt');
      const config: JsonObject = { key: 'synthetic', requirements: 'requirements.json', assemble: { editor_receipts: { receipts: [{ file: 'donor/input.png' }] } } };
      put(dir, 'source/config.json', config);
      put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
      rigVersionCommand([...args, '--citations', 'source/citations.json']);
      const project = load();
      const registration = obj((project.versions as JsonObject[])[0]!.registration);
      expect(obj(registration.path_adapter).format).toBe('json-pointer/1');
      expect(rigRegistrationFindings(dir, project)).toEqual([]);
      if (removeRequirementsBindings) {
        delete registration.requirements_source;
        delete registration.requirements;
      }
      const adapterPath = String(obj(registration.path_adapter).path);
      const rows = JSON.parse(readFileSync(join(dir, adapterPath), 'utf8')) as JsonObject[];
      expect(rows).toHaveLength(1);
      const emptyAdapter = Buffer.from('[]\n');
      writeFileSync(join(dir, adapterPath), emptyAdapter);
      obj(registration.path_adapter).sha256 = jobHash(emptyAdapter);
      for (const file of registration.files as JsonObject[]) if (file.path === adapterPath) file.sha256 = jobHash(emptyAdapter);
      expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
    }
  });

  test('checks a reconstructed pre-#394 frozen-rig/1 layout with implicit take/editor_receipts relocation, empty retained directories, legacy extra-key adapters, and uncopied source-only fields while refusing unlisted mutations', () => {
    const { dir, args, load } = setup();
    const paintingBytes = Buffer.from('Synthetic immutable painting input');
    writeFileSync(join(dir, 'inputs/painting.png'), paintingBytes);
    const initial = load();
    initial.inputs = [{ ...(initial.inputs as JsonObject[])[0]!, path: 'inputs/painting.png', sha256: jobHash(paintingBytes), bytes: paintingBytes.length }];
    put(dir, 'project.json', initial);

    mkdirSync(join(dir, 'source/donor'), { recursive: true });
    mkdirSync(join(dir, 'empty-donor'), { recursive: true });
    put(dir, 'source/donor/layers.json', { layers: [] });
    put(dir, 'source/donor/source.png', 'synthetic source input');
    put(dir, 'source/donor/extra.png', 'synthetic extra input');
    const maskBytes = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    const maskHash = jobHash(maskBytes);
    writeFileSync(join(dir, 'mask.png'), maskBytes);
    writeFileSync(join(dir, 'backdrop-old.png'), maskBytes);

    // Pre-#394 config with relative take (including a ../ empty directory and source-only reference.painting), editor_receipts, and absolute requirements via legacy adapter with extra keys.
    const legacyConfigSource: JsonObject = {
      key: 'synthetic',
      requirements: '/runtime/requirements.json',
      assemble: {
        take: [
          { run: 'full', tags: ['piece'], run_dir: 'donor', st_input: 'donor/source.png', reference: { painting: 'donor/extra.png' } },
          { run: 'head', tags: ['piece'], run_dir: '../empty-donor' },
        ],
        editor_receipts: { receipts: [{ file: 'donor/source.png' }] },
      },
    };
    const legacyRequirements: JsonObject = {
      spec: 'spine-parts-requirements/1',
      fps: 4,
      requirements: [],
      setup_painting: {
        required: true,
        figure_mask: { path: '../mask.png', sha256: maskHash },
        backdrop: { path: '../backdrop-old.png', sha256: maskHash },
      },
    };
    const legacyAdapter = [
      { at: '.requirements', before: join(dir, 'source/requirements.json'), after: '/runtime/requirements.json', note: 'legacy extra key allowed' },
      { at: '.unused_abs', before: '/abs/unused-before.json', after: '/abs/unused-after.json', extra: true },
    ];
    put(dir, 'source/config.json', legacyConfigSource);
    put(dir, 'source/requirements.json', legacyRequirements);
    put(dir, 'source/adapter.json', legacyAdapter);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });

    rigVersionCommand([...args, '--citations', 'source/citations.json']);

    // Reconstruct the pre-#394 layout as a checker unit control. This does not execute the historical writer.
    // - path-adapter.json contains only legacyAdapter (no pointer rows)
    // - registration has no requirements_source or requirements bindings
    // - config.json has implicit relocation only on take.run_dir, take.st_input, editor_receipts.file, and legacy-abs .requirements (leaving take[0].reference.painting un-relocated/uncopied and backdrop uncopied)
    const pre394PortableConfig: JsonObject = {
      key: 'synthetic',
      requirements: 'inputs/requirements',
      assemble: {
        take: [
          { run: 'full', tags: ['piece'], run_dir: 'inputs/assemble/take/0/run_dir', st_input: 'inputs/assemble/take/0/st_input', reference: { painting: 'donor/extra.png' } },
          { run: 'head', tags: ['piece'], run_dir: 'inputs/assemble/take/1/run_dir' },
        ],
        editor_receipts: { receipts: [{ file: 'inputs/assemble/editor_receipts/receipts/0/file' }] },
      },
    };
    writeFileSync(join(dir, 'evidence/v1/registration/config.json'), `${JSON.stringify(pre394PortableConfig, null, 2)}\n`);
    writeFileSync(join(dir, 'evidence/v1/registration/inputs/requirements'), `${JSON.stringify(legacyRequirements, null, 2)}\n`);
    writeFileSync(join(dir, 'evidence/v1/registration/mask.png'), maskBytes);
    writeFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'), `${JSON.stringify(legacyAdapter, null, 2)}\n`);
    rmSync(join(dir, 'evidence/v1/registration/requirements-source.json'), { force: true });
    rmSync(join(dir, 'evidence/v1/registration/inputs/assemble/take/0/reference'), { recursive: true, force: true });
    rmSync(join(dir, 'evidence/v1/registration/inputs/setup_painting'), { recursive: true, force: true });

    const rebuildRetainedList = (rootRel: string): JsonObject[] => {
      const out: JsonObject[] = [];
      const scan = (r: string): void => {
        for (const name of readdirSync(join(dir, r)).sort()) {
          const p = `${r}/${name}`;
          if (lstatSync(join(dir, p)).isDirectory()) scan(p);
          else out.push({ path: p, sha256: jobHash(readFileSync(join(dir, p))) });
        }
      };
      scan(rootRel);
      return out;
    };

    const project = load();
    const v1 = (project.versions as JsonObject[])[0]!;
    const reg = obj(v1.registration);
    delete obj(reg.path_adapter).format;
    delete reg.requirements_source;
    delete reg.requirements;
    const cfgBytes = readFileSync(join(dir, 'evidence/v1/registration/config.json'));
    const adapterBytes = readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'));
    obj(v1.provenance).config = { path: 'evidence/v1/registration/config.json', sha256: jobHash(cfgBytes), bytes: cfgBytes.length };
    reg.path_adapter = { path: 'evidence/v1/registration/path-adapter.json', sha256: jobHash(adapterBytes), bytes: adapterBytes.length };
    reg.files = rebuildRetainedList('evidence/v1/registration');
    put(dir, 'project.json', project);

    rmSync(join(dir, 'derived/review/v1'), { recursive: true, force: true });
    reviewPackageCommand(['1', dir, '--config', 'evidence/v1/registration/config.json', '--from', 'outputs/v1/out']);

    const pre394Project = load();
    expect(rigRegistrationFindings(dir, pre394Project)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);

    // Retained publication roundtrip succeeds on the pre-#394 record (including empty run_dir).
    const root = realpathSync(dir);
    const record = { path: 'project.json' as const, sha256: jobHash(readFileSync(join(root, 'project.json'))) };
    const inventory = readRecordPublished({ root, record, result: { kind: 'plan' }, phase: 'inventory' }, testClock.now());
    const retainedRoot = join(realpathSync(dirname(dir)), 'retained-pre394');
    mkdirSync(retainedRoot);
    for (const file of inventory.files) {
      mkdirSync(dirname(join(retainedRoot, file.path)), { recursive: true });
      cpSync(join(root, file.path), join(retainedRoot, file.path));
    }
    expect(checkProject(retainedRoot).refusals).toEqual([]);
    expect(readRecordPublished({
      root: retainedRoot,
      record,
      result: { kind: 'plan' },
      phase: 'retained',
      parts: inventory.parts,
    }, testClock.now())).toEqual(inventory);

    // Unlisted runtime field edits on the pre-#394 record still refuse with RIG_REGISTRATION_FILE_INVALID.
    for (const mutateRuntime of [
      (cfg: JsonObject) => { cfg.key = 'tampered'; },
      (cfg: JsonObject) => { ((obj(obj(cfg.assemble).editor_receipts).receipts as JsonObject[])[0]!).file = 'donor/source.png'; },
    ]) {
      const candidate = structuredClone(pre394Project);
      const tamperedCfg = structuredClone(pre394PortableConfig);
      mutateRuntime(tamperedCfg);
      const tamperedBytes = Buffer.from(`${JSON.stringify(tamperedCfg, null, 2)}\n`);
      writeFileSync(join(dir, 'evidence/v1/registration/config.json'), tamperedBytes);
      const h = jobHash(tamperedBytes);
      const cv = (candidate.versions as JsonObject[])[0]!;
      obj(obj(cv.provenance).config).sha256 = h;
      for (const f of obj(cv.registration).files as JsonObject[]) {
        if (f.path === 'evidence/v1/registration/config.json') f.sha256 = h;
      }
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/config.json'), cfgBytes);
    }
  });
});
