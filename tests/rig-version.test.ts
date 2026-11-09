import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { rigRegistrationFindings } from '../src/rig-version.ts';
import { checkProject, rigVersionCommand, testClock } from './clock.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { fixture, obj } from './fixtures.ts';
import { clockedCli, run } from './helpers.ts';
import { openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';

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

function refused(args: string[], code: string): void {
  let caught: unknown;
  try { rigVersionCommand(args); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Refusal);
  expect((caught as Refusal).code).toBe(code);
}

describe('frozen rig registration', () => {
  test.each([false, true])('writer commit owns live publication, with stopped host=%s', async stopped => {
    const { dir, args, load } = setup();
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
});
