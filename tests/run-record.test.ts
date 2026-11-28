import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Finding } from '../src/check.ts';
import { rigRegistrationFindings } from '../src/rig-version.ts';
import { checkProject, testClock } from './clock.ts';
import { FROZEN_RUN_SPECS, RUN_RECORD_SINCE, validateRunRecord } from '../src/run-record.ts';
import type { JsonObject } from '../src/templates.ts';
import { fixture, obj } from './fixtures.ts';
import { seedRetainedRigVersion } from './numbered-seed.ts';

const roots: string[] = [];
const frozen = join(import.meta.dir, 'fixtures/rig-registration');
afterEach(() => { testClock.reset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function put(dir: string, path: string, value: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function partsRunRecord(overrides: Partial<Record<string, unknown>> = {}): JsonObject {
  return {
    spec: 'rig-run/1',
    package: { name: '@rig-c/parts', version: '2.27.1' },
    command: 'rig',
    started_at: '2026-11-07T00:00:00.000Z',
    finished_at: '2026-11-07T00:00:01.000Z',
    config: { path: '../config.json', sha256: '1'.repeat(64) },
    outputs: [
      { path: 'images/rectangle.png', sha256: '2'.repeat(64) },
      { path: 'mesh_report.json', sha256: '3'.repeat(64) },
      { path: 'motion.json', sha256: '4'.repeat(64) },
      { path: 'rig.json', sha256: '5'.repeat(64) },
    ],
    ...overrides,
  } as JsonObject;
}

function coreRunRecord(overrides: Partial<Record<string, unknown>> = {}): JsonObject {
  return {
    spec: 'rigc-run/1',
    package: { name: 'rig-c', version: '3.5.0' },
    command: 'build',
    started_at: '2026-11-07T00:00:01.000Z',
    finished_at: '2026-11-07T00:00:02.000Z',
    inputs: [
      { role: 'rig', path: '../rig/rig.json', sha256: '5'.repeat(64) },
      { role: 'motion', path: '../rig/motion.json', sha256: '4'.repeat(64) },
      { role: 'manifest', path: '../parts/parts.json', sha256: '6'.repeat(64) },
      { role: 'cuts', path: '../cuts.json', sha256: '7'.repeat(64) },
    ],
    outputs: [
      { path: '../compile-report.json', sha256: '8'.repeat(64) },
      { path: 'skeleton.atlas', sha256: '9'.repeat(64) },
      { path: 'skeleton.json', sha256: 'a'.repeat(64) },
      { path: 'skeleton.model.json', sha256: 'b'.repeat(64) },
    ],
    ...overrides,
  } as JsonObject;
}

function setup(at = '2026-11-08T00:00:00Z') {
  const dir = fixture(project => {
    project.stage = 'interview';
    project.signoffs = [];
    project.versions = [];
    project.reopens = [];
    for (const step of obj(project.plan).steps as JsonObject[]) step.status = 'pending';
  });
  roots.push(dirname(dir));
  testClock.set(new Date(at));
  for (const path of ['outputs', 'derived/review']) rmSync(join(dir, path), { recursive: true, force: true });
  cpSync(frozen, join(dir, 'source'), { recursive: true });
  put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json' });
  put(dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: { required: true } });
  put(dir, 'source/adapter.json', []);
  put(dir, 'source/parts/parts.json', { rig_size: [8, 16], scale_rig_per_source: 1, ghost_px: {},
    parts: [{ name: 'rectangle', from: 'painting:rectangle', x: 0, y: 0, w: 8, h: 16,
      opaque_px: 128, projected_core_px: 128, source_px_taken: 128, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 }] });
  mkdirSync(join(dir, 'source/parts/parts'), { recursive: true });
  cpSync(join(dir, 'source/rig/images/rectangle.png'), join(dir, 'source/parts/parts/rectangle.png'));
  put(dir, 'source/parts-run.json', partsRunRecord());
  put(dir, 'source/core-run.json', coreRunRecord());
  const model = readFileSync(join(dir, 'source/build/skeleton.model.json'));
  put(dir, 'source/check.json', { spec: 'rig-parts-check/1', bar_outcomes: { gate: { status: 'PASS' } },
    build: { model_sha256: new Bun.CryptoHasher('sha256').update(model).digest('hex') } });
  const baseArgs = ['1', dir, '--parts', 'source/parts', '--rig', 'source/rig', '--build', 'source/build', '--idle', 'source/idle',
    '--config', 'source/config.json', '--path-adapter', 'source/adapter.json', '--compile-report', 'source/compile-report.json',
    '--check-report', 'source/check.json',
    '--toolchain-lock', 'source/package-lock.json', '--at-source', 'source/at-source.json', '--at-pointer', '/finished_at', '--by', 'registrant', '--json'];
  const args = [...baseArgs, '--run-record', 'source/parts-run.json', '--run-record', 'source/core-run.json'];
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  return { dir, baseArgs, args, load };
}

function refused(args: string[], code: string): void {
  let caught: unknown;
  try { seedRetainedRigVersion(args, testClock.now()); } catch (error) { caught = error; }
  expect((caught as { code?: string })?.code).toBe(code);
}

describe('producer run records (rig-run/1 and rigc-run/1)', () => {
  test('binds repeatable --run-record files by sha256 and spec in the order given beside toolchain lock', () => {
    const { dir, baseArgs, load } = setup();
    const result = seedRetainedRigVersion([...baseArgs, '--run-record', 'source/core-run.json', '--run-record', 'source/parts-run.json'], testClock.now());
    expect(result.exit).toBe(0);
    const version = JSON.parse(result.stdout) as JsonObject;
    const registration = obj(version.registration);
    expect(obj(registration.toolchain).kind).toBe('npm-lock-v3');
    const runs = registration.runs as JsonObject[];
    expect(runs.map(r => r.spec)).toEqual(['rigc-run/1', 'rig-run/1']);
    for (const run of runs) {
      const source = obj(run.source);
      expect(typeof source.path).toBe('string');
      expect(typeof source.sha256).toBe('string');
      expect(existsSync(join(dir, String(source.path)))).toBe(true);
    }
    const warnings: Finding[] = [];
    expect(rigRegistrationFindings(dir, load(), warnings)).toEqual([]);
    expect(warnings).toEqual([]);
    expect(checkProject(dir, load()).refusals).toEqual([]);
  });

  test('accepts rig-run/1 assemble command and rigc-run/1 with only required rig and motion roles', () => {
    const assembleRun = partsRunRecord({ command: 'assemble' });
    const minimalCore = coreRunRecord({
      inputs: [
        { role: 'rig', path: '../rig/rig.json', sha256: '5'.repeat(64) },
        { role: 'motion', path: '../rig/motion.json', sha256: '4'.repeat(64) },
      ],
    });
    expect(validateRunRecord(Buffer.from(JSON.stringify(assembleRun)), 'runs[0]').spec).toBe('rig-run/1');
    expect(validateRunRecord(Buffer.from(JSON.stringify(minimalCore)), 'runs[1]').spec).toBe('rigc-run/1');
  });

  test('refuses a planted unknown spec in check', () => {
    const { dir, args, load } = setup();
    expect(() => validateRunRecord(Buffer.from(JSON.stringify({ ...partsRunRecord(), spec: 'rig-run/2' })), 'runs[0]', { specs: FROZEN_RUN_SPECS }))
      .toThrow(expect.objectContaining({ code: 'RUN_RECORD_SPEC_UNKNOWN' }));
    seedRetainedRigVersion(args, testClock.now());
    const project = load();
    const runs = obj((project.versions as JsonObject[])[0]!.registration).runs as JsonObject[];
    runs[0]!.spec = 'unknown-run/1';
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RUN_RECORD_SPEC_UNKNOWN');
    expect(checkProject(dir, project).refusals.map(f => f.code)).toContain('RUN_RECORD_SPEC_UNKNOWN');
  });

  test('refuses a byte mismatch on a bound run record in check', () => {
    const { dir, args, load } = setup();
    seedRetainedRigVersion(args, testClock.now());
    const project = load();
    const runs = obj((project.versions as JsonObject[])[0]!.registration).runs as JsonObject[];
    const targetPath = String(obj(runs[0]!.source).path);
    const originalBytes = readFileSync(join(dir, targetPath));

    writeFileSync(join(dir, targetPath), `${originalBytes.toString()} `);
    expect(rigRegistrationFindings(dir, load()).map(f => f.code)).toEqual(['RUN_RECORD_HASH_MISMATCH']);
    expect(checkProject(dir, load()).refusals.map(f => f.code)).toContain('RUN_RECORD_HASH_MISMATCH');

    writeFileSync(join(dir, targetPath), originalBytes);
    obj(runs[0]!.source).sha256 = 'f'.repeat(64);
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toEqual(['RUN_RECORD_HASH_MISMATCH']);
  });

  test.each([
    ['missing required rig role', [{ role: 'motion', path: '../rig/motion.json', sha256: '4'.repeat(64) }]],
    ['missing required motion role', [{ role: 'rig', path: '../rig/rig.json', sha256: '5'.repeat(64) }]],
    ['unknown input role', [
      { role: 'rig', path: '../rig/rig.json', sha256: '5'.repeat(64) },
      { role: 'motion', path: '../rig/motion.json', sha256: '4'.repeat(64) },
      { role: 'atlas', path: '../rig/atlas.json', sha256: '6'.repeat(64) },
    ]],
    ['roles out of canonical order', [
      { role: 'motion', path: '../rig/motion.json', sha256: '4'.repeat(64) },
      { role: 'rig', path: '../rig/rig.json', sha256: '5'.repeat(64) },
    ]],
  ])('refuses core rigc-run/1 with %s', (_label, inputs) => {
    expect(() => validateRunRecord(Buffer.from(JSON.stringify(coreRunRecord({ inputs }))), 'runs[0]'))
      .toThrow(expect.objectContaining({ code: 'RUN_RECORD_ROLE_INVALID' }));
  });

  test('check refuses a bound core record whose required input role was removed', () => {
    const { dir, args, load } = setup();
    seedRetainedRigVersion(args, testClock.now());
    const project = load();
    const registration = obj((project.versions as JsonObject[])[0]!.registration);
    const coreEntry = (registration.runs as JsonObject[]).find(r => r.spec === 'rigc-run/1')!;
    const source = obj(coreEntry.source);
    const badBytes = Buffer.from(`${JSON.stringify(coreRunRecord({
      inputs: [{ role: 'rig', path: '../rig/rig.json', sha256: '5'.repeat(64) }],
    }), null, 2)}\n`);
    const badSha = new Bun.CryptoHasher('sha256').update(badBytes).digest('hex');
    writeFileSync(join(dir, String(source.path)), badBytes);
    source.sha256 = badSha;
    source.bytes = badBytes.length;
    const fileEntry = (registration.files as JsonObject[]).find(f => f.path === source.path)!;
    fileEntry.sha256 = badSha;
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toEqual(['RUN_RECORD_ROLE_INVALID']);
    expect(checkProject(dir, project).refusals.map(f => f.code)).toContain('RUN_RECORD_ROLE_INVALID');
  });

  test.each([
    ['swapped top-level keys in rig-run/1', {
      package: { name: '@rig-c/parts', version: '2.27.1' },
      spec: 'rig-run/1',
      command: 'rig',
      started_at: '2026-11-07T00:00:00.000Z',
      finished_at: '2026-11-07T00:00:01.000Z',
      config: { path: '../config.json', sha256: '1'.repeat(64) },
      outputs: [{ path: 'rig.json', sha256: '5'.repeat(64) }],
    }],
    ['swapped package keys', partsRunRecord({ package: { version: '2.27.1', name: '@rig-c/parts' } })],
    ['wrong package name for parts', partsRunRecord({ package: { name: 'rig-c', version: '2.27.1' } })],
    ['wrong package name for core', coreRunRecord({ package: { name: '@rig-c/parts', version: '3.5.0' } })],
    ['wrong command for parts', partsRunRecord({ command: 'build' })],
    ['wrong command for core', coreRunRecord({ command: 'rig' })],
    ['non-millisecond timestamp', partsRunRecord({ started_at: '2026-11-07T00:00:00Z' })],
    ['swapped config keys', partsRunRecord({ config: { sha256: '1'.repeat(64), path: '../config.json' } })],
    ['absolute config path', partsRunRecord({ config: { path: '/abs/config.json', sha256: '1'.repeat(64) } })],
    ['unsorted outputs', partsRunRecord({
      outputs: [
        { path: 'rig.json', sha256: '5'.repeat(64) },
        { path: 'motion.json', sha256: '4'.repeat(64) },
      ],
    })],
    ['swapped input keys in rigc-run/1', coreRunRecord({
      inputs: [
        { path: '../rig/rig.json', role: 'rig', sha256: '5'.repeat(64) },
        { role: 'motion', path: '../rig/motion.json', sha256: '4'.repeat(64) },
      ],
    })],
  ])('refuses malformed run record (%s)', (_label, record) => {
    expect(() => validateRunRecord(Buffer.from(JSON.stringify(record)), 'runs[0]'))
      .toThrow(expect.objectContaining({ code: 'RUN_RECORD_MALFORMED' }));
  });

  test('refuses duplicate runs for the same spec in check', () => {
    const { dir, args, load } = setup();
    seedRetainedRigVersion(args, testClock.now());
    const project = load();
    const runs = obj((project.versions as JsonObject[])[0]!.registration).runs as JsonObject[];
    runs.push(structuredClone(runs[0]!));
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RUN_RECORD_MALFORMED');
  });

  test('lock-only frozen-rig/1 versions WARN before RUN_RECORD_SINCE and refuse from RUN_RECORD_SINCE onward under the same code', () => {
    expect(RUN_RECORD_SINCE).toBe('2026-11-08T00:00:00Z');

    const beforeSince = setup('2026-11-07T23:59:59Z');
    const res = seedRetainedRigVersion(beforeSince.baseArgs, testClock.now());
    expect(res.exit).toBe(0);
    const preProject = beforeSince.load();
    expect(obj((preProject.versions as JsonObject[])[0]!.registration).runs).toBeUndefined();
    const preWarnings: Finding[] = [];
    expect(rigRegistrationFindings(beforeSince.dir, preProject, preWarnings)).toEqual([]);
    expect(preWarnings.map(f => f.code)).toEqual(['RUN_RECORD_REQUIRED']);
    const preCheck = checkProject(beforeSince.dir, preProject);
    expect(preCheck.warnings.map(f => f.code)).toContain('RUN_RECORD_REQUIRED');
    expect(preCheck.refusals.map(f => f.code)).not.toContain('RUN_RECORD_REQUIRED');

    obj((preProject.versions as JsonObject[])[0]!.registration).at = '2026-11-08T00:00:00Z';
    const postWarnings: Finding[] = [];
    expect(rigRegistrationFindings(beforeSince.dir, preProject, postWarnings).map(f => f.code)).toEqual(['RUN_RECORD_REQUIRED']);
    expect(postWarnings).toEqual([]);
    expect(checkProject(beforeSince.dir, preProject).refusals.map(f => f.code)).toContain('RUN_RECORD_REQUIRED');
  });
});


test.each(['@rig-c/core', 'rig-c'])('core producer run accepts its published package name %s', name => {
  const raw = Buffer.from(JSON.stringify(coreRunRecord({ package: { name, version: '3.6.0' } })));
  expect(validateRunRecord(raw, 'versions[v1].registration.runs[0]').spec).toBe('rigc-run/1');
});

function partsCheckRunRecord(overrides: Partial<Record<string, unknown>> = {}): JsonObject {
  return {
    spec: 'rig-run/2',
    package: { name: '@rig-c/parts', version: '2.56.0' },
    command: 'check',
    started_at: '2026-11-25T00:00:00.000Z',
    finished_at: '2026-11-25T00:00:01.000Z',
    outputs: [
      { path: 'build/skeleton.atlas', sha256: '1'.repeat(64) },
      { path: 'build/skeleton.json', sha256: '2'.repeat(64) },
      { path: 'build/skeleton.model.json', sha256: '3'.repeat(64) },
      { path: 'check.json', sha256: '4'.repeat(64) },
    ],
    argv: ['check', '--rig', '..', '--out', '.', '--parts', '../../parts', '--no-extremes'],
    ...overrides,
  } as JsonObject;
}

function partsBuildRunRecord(overrides: Partial<Record<string, unknown>> = {}): JsonObject {
  return {
    spec: 'rig-run/2',
    package: { name: '@rig-c/parts', version: '2.56.0' },
    command: 'build',
    started_at: '2026-11-25T00:00:00.000Z',
    finished_at: '2026-11-25T00:00:02.000Z',
    config: { path: '../../specs/rig/config.json', sha256: 'a'.repeat(64) },
    outputs: [
      { path: 'check/check.json', sha256: 'b'.repeat(64) },
      { path: 'parts.json', sha256: 'c'.repeat(64) },
      { path: 'rig/rig.json', sha256: 'd'.repeat(64) },
    ],
    argv: [
      'build',
      '--config', '../../specs/rig/config.json',
      '--source', '../../inputs/painting.png',
      '--full', '../../outputs/parts/sources/full',
      '--out', '.',
      '--alt', 'smile=../../inputs/smile.png:../../outputs/parts/sources/smile',
      '--no-extremes',
    ],
    ...overrides,
  } as JsonObject;
}

function partsBuildRunV3() {
  const { outputs, argv, ...throughConfig } = partsBuildRunRecord({
    argv: ['build', '--config', '../../specs/rig/config.json', '--source', '../../inputs/painting.png', '--full', '../parts/sources/full', '--out', '.'],
  });
  return {
    ...throughConfig,
    spec: 'rig-run/3',
    inputs: [
      { role: 'source', path: '../../inputs/painting.png', sha256: '1'.repeat(64) },
      { role: 'full', path: '../parts/sources/full/layers.json', sha256: '2'.repeat(64) },
    ],
    outputs,
    argv: argv as string[],
  };
}

function coreRenderRunRecord(overrides: Partial<Record<string, unknown>> = {}): JsonObject {
  return {
    spec: 'rigc-run/2',
    package: { name: '@rig-c/core', version: '3.8.1' },
    command: 'render',
    argv: ['--candidate', '../check/build', '--animation', 'idle', '--fps', '24', '--max', '640', '--geometry', '--out', '.'],
    started_at: '2026-11-25T00:00:02.000Z',
    finished_at: '2026-11-25T00:00:03.000Z',
    inputs: [
      { role: 'skeleton', path: '../check/build/skeleton.json', sha256: '2'.repeat(64) },
      { role: 'atlas', path: '../check/build/skeleton.atlas', sha256: '1'.repeat(64) },
      { role: 'model', path: '../check/build/skeleton.model.json', sha256: '3'.repeat(64) },
    ],
    outputs: [
      { path: 'frames.json', sha256: 'e'.repeat(64) },
      { path: 'idle/f0000.png', sha256: 'f'.repeat(64) },
      { path: 'idle/geometry.json', sha256: '9'.repeat(64) },
    ],
    ...overrides,
  } as JsonObject;
}

describe('producer run records (rig-run/2 and rigc-run/2)', () => {
  test('accepts rig-run/2 check and build records and rigc-run/2 render records in published key order', () => {
    expect(validateRunRecord(Buffer.from(JSON.stringify(partsCheckRunRecord())), 'check-run.json').spec).toBe('rig-run/2');
    expect(validateRunRecord(Buffer.from(JSON.stringify(partsBuildRunRecord())), 'build-run.json').spec).toBe('rig-run/2');
    const fullRender = coreRenderRunRecord({
      package: { name: 'rig-c', version: '3.8.1' },
      inputs: [
        { role: 'skeleton', path: '../check/build/skeleton.json', sha256: '2'.repeat(64) },
        { role: 'atlas', path: '../check/build/skeleton.atlas', sha256: '1'.repeat(64) },
        { role: 'model', path: '../check/build/skeleton.model.json', sha256: '3'.repeat(64) },
        { role: 'environment', path: '../../specs/rig/wind.json', sha256: '4'.repeat(64) },
        { role: 'viewport', path: '../prev/frames.json', sha256: '5'.repeat(64) },
        { role: 'boundary', path: '../bound/frames.json', sha256: '6'.repeat(64) },
      ],
    });
    expect(validateRunRecord(Buffer.from(JSON.stringify(fullRender)), 'render-run.json').spec).toBe('rigc-run/2');
  });

  test.each([
    ['check record carrying config', {
      spec: 'rig-run/2',
      package: { name: '@rig-c/parts', version: '2.56.0' },
      command: 'check',
      started_at: '2026-11-25T00:00:00.000Z',
      finished_at: '2026-11-25T00:00:01.000Z',
      config: { path: '../config.json', sha256: 'a'.repeat(64) },
      outputs: [{ path: 'check.json', sha256: '4'.repeat(64) }],
      argv: ['check', '--rig', '..', '--out', '.'],
    }],
    ['build record omitting config', {
      spec: 'rig-run/2',
      package: { name: '@rig-c/parts', version: '2.56.0' },
      command: 'build',
      started_at: '2026-11-25T00:00:00.000Z',
      finished_at: '2026-11-25T00:00:01.000Z',
      outputs: [{ path: 'check/check.json', sha256: '4'.repeat(64) }],
      argv: ['build', '--config', '../config.json', '--out', '.'],
    }],
    ['invalid rig-run/2 command', partsCheckRunRecord({ command: 'rig', argv: ['rig', '--out', '.'] })],
    ['rig-run/2 argv[0] mismatch', partsCheckRunRecord({ argv: ['build', '--rig', '..', '--out', '.'] })],
    ['empty argv', partsCheckRunRecord({ argv: [] })],
    ['absolute path token in rig-run/2 argv', partsCheckRunRecord({ argv: ['check', '--rig', '/abs/rig', '--out', '.'] })],
    ['windows absolute path token in rigc-run/2 argv', coreRenderRunRecord({ argv: ['--candidate=C:\\abs\\build', '--out', '.'] })],
    ['rigc-run/2 argv placed at end instead of after command', {
      spec: 'rigc-run/2',
      package: { name: '@rig-c/core', version: '3.8.1' },
      command: 'render',
      started_at: '2026-11-25T00:00:02.000Z',
      finished_at: '2026-11-25T00:00:03.000Z',
      inputs: [{ role: 'skeleton', path: '../build/skeleton.json', sha256: '2'.repeat(64) }],
      outputs: [{ path: 'frames.json', sha256: 'e'.repeat(64) }],
      argv: ['--candidate', '../build', '--out', '.'],
    }],
    ['invalid rigc-run/2 command', coreRenderRunRecord({ command: 'build' })],
    ['run record listed inside /2 outputs', partsCheckRunRecord({
      outputs: [
        { path: 'build/run.json', sha256: '1'.repeat(64) },
        { path: 'check.json', sha256: '4'.repeat(64) },
      ],
    })],
    ['escaping output path in /2 outputs', coreRenderRunRecord({
      outputs: [{ path: '../frames.json', sha256: 'e'.repeat(64) }],
    })],
  ])('refuses malformed /2 run record (%s) with RUN_RECORD_MALFORMED', (_label, bad) => {
    expect(() => validateRunRecord(Buffer.from(JSON.stringify(bad)), 'run-2.json')).toThrow(/RUN_RECORD_MALFORMED|keys must be|invalid|argv|output/);
    try {
      validateRunRecord(Buffer.from(JSON.stringify(bad)), 'run-2.json');
      throw new Error('expected RunRecordError');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('RUN_RECORD_MALFORMED');
    }
  });

  test.each([
    ['missing skeleton role', [{ role: 'atlas', path: '../check/build/skeleton.atlas', sha256: '1'.repeat(64) }]],
    ['unknown role', [
      { role: 'skeleton', path: '../check/build/skeleton.json', sha256: '2'.repeat(64) },
      { role: 'rig', path: '../rig.json', sha256: '5'.repeat(64) },
    ]],
    ['misordered roles', [
      { role: 'atlas', path: '../check/build/skeleton.atlas', sha256: '1'.repeat(64) },
      { role: 'skeleton', path: '../check/build/skeleton.json', sha256: '2'.repeat(64) },
    ]],
    ['duplicate skeleton role', [
      { role: 'skeleton', path: '../check/build/skeleton.json', sha256: '2'.repeat(64) },
      { role: 'skeleton', path: '../other/skeleton.json', sha256: '7'.repeat(64) },
    ]],
  ])('refuses rigc-run/2 with %s under RUN_RECORD_ROLE_INVALID', (_label, inputs) => {
    try {
      validateRunRecord(Buffer.from(JSON.stringify(coreRenderRunRecord({ inputs }))), 'render-run.json');
      throw new Error('expected RunRecordError');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('RUN_RECORD_ROLE_INVALID');
    }
  });

  test('frozen-rig/1 registration.runs keeps rejecting valid /2 run records as RUN_RECORD_SPEC_UNKNOWN', () => {
    const { dir, args, load } = setup();
    seedRetainedRigVersion(args, testClock.now());
    const project = load();
    const registration = obj((project.versions as JsonObject[])[0]!.registration);
    const run = (registration.runs as JsonObject[])[0]!;
    const source = obj(run.source);
    const v2Bytes = Buffer.from(`${JSON.stringify(partsCheckRunRecord(), null, 2)}\n`);
    const v2Sha = new Bun.CryptoHasher('sha256').update(v2Bytes).digest('hex');
    writeFileSync(join(dir, String(source.path)), v2Bytes);
    source.sha256 = v2Sha;
    run.spec = 'rig-run/2';
    const fileEntry = (registration.files as JsonObject[]).find(f => f.path === source.path)!;
    fileEntry.sha256 = v2Sha;
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RUN_RECORD_SPEC_UNKNOWN');
  });
});

describe('Parts build run records (rig-run/3)', () => {
  const validate = (run: object) => validateRunRecord(Buffer.from(JSON.stringify(run)), 'build-run.json');
  const row = (role: string, path: string) => ({ role, path, sha256: '5'.repeat(64) });

  test('accepts --out-relative inputs including a literal See-through manifest and optional head', () => {
    const run = partsBuildRunV3();
    expect(validate(run)).toEqual({ spec: 'rig-run/3', record: run });
    run.inputs.push(row('head', '../parts/sources/head/layers.json'));
    run.argv.splice(run.argv.indexOf('--out'), 0, '--head', '../parts/sources/head');
    expect(validate(run)).toEqual({ spec: 'rig-run/3', record: run });
  });

  test('accepts skipped optional roles and orders alternate tuples by CLI occurrence through index 10', () => {
    const run = partsBuildRunV3();
    const environment = '../../specs/rig/environment.json';
    run.inputs.push(row('environment', environment));
    for (let i = 0; i <= 10; i++) {
      const dir = `../parts/sources/side-${i}`;
      const source = `${dir}/painting.png`;
      const full = `${dir}/full.psd`;
      const head = `${dir}/head`;
      run.inputs.push(row(`alt[${i}].source`, source), row(`alt[${i}].full`, full));
      if (i === 0) run.inputs.push(row(`alt[${i}].head`, `${head}/layers.json`));
      run.argv.push('--alt', `side-${i}=${source}:${full}${i === 0 ? `:${head}` : ''}`);
    }
    run.argv.push('--environment', environment);
    expect(validate(run)).toEqual({ spec: 'rig-run/3', record: run });
  });

  const { inputs, ...withoutInputs } = partsBuildRunV3();
  const [source, full] = inputs;
  test.each([
    ['top-level input key at the end', { ...withoutInputs, inputs }, 'RUN_RECORD_MALFORMED'],
    ['input keys out of order', { ...partsBuildRunV3(), inputs: [{ path: source!.path, role: 'source', sha256: source!.sha256 }, full] }, 'RUN_RECORD_MALFORMED'],
    ['unknown role', { ...partsBuildRunV3(), inputs: [{ ...source, role: 'unknown' }, full] }, 'RUN_RECORD_ROLE_INVALID'],
    ['missing full role', { ...partsBuildRunV3(), inputs: [source] }, 'RUN_RECORD_ROLE_INVALID'],
    ['duplicate source role', { ...partsBuildRunV3(), inputs: [source, { ...source, path: '../../inputs/other.png' }, full] }, 'RUN_RECORD_ROLE_INVALID'],
    ['absolute path', { ...partsBuildRunV3(), inputs: [{ ...source, path: '/outside/painting.png' }, full] }, 'RUN_RECORD_MALFORMED'],
    ['invalid input hash', { ...partsBuildRunV3(), inputs: [{ ...source, sha256: 'abc' }, full] }, 'RUN_RECORD_MALFORMED'],
    ['/3 check command', { ...partsBuildRunV3(), command: 'check', argv: ['check', '--out', '.'] }, 'RUN_RECORD_MALFORMED'],
    ['/3 check argv', { ...partsBuildRunV3(), argv: ['check', '--out', '.'] }, 'RUN_RECORD_MALFORMED'],
    ['escaping output path', { ...partsBuildRunV3(), outputs: [{ path: '../outside.png', sha256: '4'.repeat(64) }] }, 'RUN_RECORD_MALFORMED'],
  ] as const)('refuses %s with the expected reader code', (_label, run, code) => {
    try {
      validate(run);
      throw new Error(`expected ${code}`);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code);
    }
  });

  test.each([
    ['main roles out of order', ['full', 'source']],
    ['missing main source', ['full']],
    ['auxiliary roles out of order', ['source', 'full', 'wind-band', 'requirements']],
    ['duplicate auxiliary role', ['source', 'full', 'environment', 'environment']],
    ['an auxiliary role after an alternate', ['source', 'full', 'alt[0].source', 'alt[0].full', 'environment']],
    ['an alternate starting at index one', ['source', 'full', 'alt[1].source', 'alt[1].full']],
    ['a skipped alternate index', ['source', 'full', 'alt[0].source', 'alt[0].full', 'alt[2].source', 'alt[2].full']],
    ['an alternate index with leading zeros', ['source', 'full', 'alt[00].source', 'alt[00].full']],
    ['a negative alternate index', ['source', 'full', 'alt[-1].source', 'alt[-1].full']],
    ['a fractional alternate index', ['source', 'full', 'alt[0.0].source', 'alt[0.0].full']],
    ['a misspelled alternate member', ['source', 'full', 'alt[0].source', 'alt[0].Full']],
    ['an alternate missing source', ['source', 'full', 'alt[0].full']],
    ['an alternate missing full', ['source', 'full', 'alt[0].source']],
    ['an alternate head before its full', ['source', 'full', 'alt[0].source', 'alt[0].head', 'alt[0].full']],
    ['a repeated alternate index', ['source', 'full', 'alt[0].source', 'alt[0].full', 'alt[0].source', 'alt[0].full']],
    ['a duplicate alternate member', ['source', 'full', 'alt[0].source', 'alt[0].full', 'alt[0].head', 'alt[0].head']],
  ] as const)('refuses %s with RUN_RECORD_ROLE_INVALID', (_label, roles) => {
    const run = { ...partsBuildRunV3(), inputs: roles.map((role, i) => row(role, `../../inputs/file-${i}`)) };
    try {
      validate(run);
      throw new Error('expected RUN_RECORD_ROLE_INVALID');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('RUN_RECORD_ROLE_INVALID');
    }
  });

  test('frozen rig registration check still refuses a valid /3 build', () => {
    const { dir, args, load } = setup();
    seedRetainedRigVersion(args, testClock.now());
    const project = load();
    const runs = obj((project.versions as JsonObject[])[0]!.registration).runs as JsonObject[];
    runs[0]!.spec = 'rig-run/3';
    expect(checkProject(dir, project).refusals.map(f => f.code)).toContain('RUN_RECORD_SPEC_UNKNOWN');
  });
});
