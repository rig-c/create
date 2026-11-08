import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Finding } from '../src/check.ts';
import { Refusal } from '../src/refusal.ts';
import { rigRegistrationFindings } from '../src/rig-version.ts';
import { checkProject, rigVersionCommand, testClock } from './clock.ts';
import { RUN_RECORD_SINCE, validateRunRecord } from '../src/run-record.ts';
import type { JsonObject } from '../src/templates.ts';
import { fixture, obj } from './fixtures.ts';

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
  put(dir, 'source/parts/parts.json', { parts: [{ name: 'rectangle', x: 0, y: 0, w: 8, h: 16 }] });
  mkdirSync(join(dir, 'source/parts/parts'), { recursive: true });
  cpSync(join(dir, 'source/rig/images/rectangle.png'), join(dir, 'source/parts/parts/rectangle.png'));
  put(dir, 'source/parts-run.json', partsRunRecord());
  put(dir, 'source/core-run.json', coreRunRecord());
  const baseArgs = ['1', dir, '--parts', 'source/parts', '--rig', 'source/rig', '--build', 'source/build', '--idle', 'source/idle',
    '--config', 'source/config.json', '--path-adapter', 'source/adapter.json', '--compile-report', 'source/compile-report.json',
    '--toolchain-lock', 'source/package-lock.json', '--at-source', 'source/at-source.json', '--at-pointer', '/finished_at', '--by', 'registrant', '--json'];
  const args = [...baseArgs, '--run-record', 'source/parts-run.json', '--run-record', 'source/core-run.json'];
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  return { dir, baseArgs, args, load };
}

function refused(args: string[], code: string): void {
  let caught: unknown;
  try { rigVersionCommand(args); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Refusal);
  expect((caught as Refusal).code).toBe(code);
}

describe('producer run records (rig-run/1 and rigc-run/1)', () => {
  test('binds repeatable --run-record files by sha256 and spec in the order given beside toolchain lock', () => {
    const { dir, baseArgs, load } = setup();
    const result = rigVersionCommand([...baseArgs, '--run-record', 'source/core-run.json', '--run-record', 'source/parts-run.json']);
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
      expect(typeof source.bytes).toBe('number');
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

  test('refuses a planted unknown spec in writer and check, leaving project.json byte-identical', () => {
    const { dir, baseArgs, args, load } = setup();
    put(dir, 'source/unknown-run.json', { ...partsRunRecord(), spec: 'rig-run/2' });
    const before = readFileSync(join(dir, 'project.json'));
    refused([...baseArgs, '--run-record', 'source/unknown-run.json'], 'RUN_RECORD_SPEC_UNKNOWN');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);

    rigVersionCommand(args);
    const project = load();
    const runs = obj((project.versions as JsonObject[])[0]!.registration).runs as JsonObject[];
    runs[0]!.spec = 'unknown-run/1';
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RUN_RECORD_SPEC_UNKNOWN');
    expect(checkProject(dir, project).refusals.map(f => f.code)).toContain('RUN_RECORD_SPEC_UNKNOWN');
  });

  test('refuses a byte mismatch on a bound run record in check and before a subsequent write', () => {
    const { dir, args, load } = setup();
    rigVersionCommand(args);
    const project = load();
    const runs = obj((project.versions as JsonObject[])[0]!.registration).runs as JsonObject[];
    const targetPath = String(obj(runs[0]!.source).path);
    const originalBytes = readFileSync(join(dir, targetPath));

    writeFileSync(join(dir, targetPath), `${originalBytes.toString()} `);
    expect(rigRegistrationFindings(dir, load()).map(f => f.code)).toEqual(['RUN_RECORD_HASH_MISMATCH']);
    expect(checkProject(dir, load()).refusals.map(f => f.code)).toContain('RUN_RECORD_HASH_MISMATCH');

    const beforeSecond = readFileSync(join(dir, 'project.json'));
    refused(['2', ...args.slice(1)], 'RUN_RECORD_HASH_MISMATCH');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeSecond);
    expect(existsSync(join(dir, 'outputs/v2'))).toBe(false);

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
  ])('refuses core rigc-run/1 with %s and leaves project.json byte-identical', (_label, inputs) => {
    const { dir, baseArgs } = setup();
    put(dir, 'source/core-run.json', coreRunRecord({ inputs }));
    const before = readFileSync(join(dir, 'project.json'));
    refused([...baseArgs, '--run-record', 'source/core-run.json'], 'RUN_RECORD_ROLE_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
  });

  test('check refuses a bound core record whose required input role was removed', () => {
    const { dir, args, load } = setup();
    rigVersionCommand(args);
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
    ['wrong package name for core', coreRunRecord({ package: { name: '@rig-c/core', version: '3.5.0' } })],
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
  ])('refuses malformed run record (%s) and leaves project.json byte-identical', (_label, record) => {
    const { dir, baseArgs } = setup();
    put(dir, 'source/bad-run.json', record);
    const before = readFileSync(join(dir, 'project.json'));
    refused([...baseArgs, '--run-record', 'source/bad-run.json'], 'RUN_RECORD_MALFORMED');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
  });

  test('refuses duplicate --run-record for the same spec and leaves project.json byte-identical', () => {
    const { dir, baseArgs } = setup();
    const before = readFileSync(join(dir, 'project.json'));
    refused([...baseArgs, '--run-record', 'source/parts-run.json', '--run-record', 'source/parts-run.json'], 'RUN_RECORD_MALFORMED');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
  });

  test('lock-only frozen-rig/1 versions WARN before RUN_RECORD_SINCE and refuse from RUN_RECORD_SINCE onward under the same code', () => {
    expect(RUN_RECORD_SINCE).toBe('2026-11-08T00:00:00Z');

    const beforeSince = setup('2026-11-07T23:59:59Z');
    const res = rigVersionCommand(beforeSince.baseArgs);
    expect(res.exit).toBe(0);
    const preProject = beforeSince.load();
    expect(obj((preProject.versions as JsonObject[])[0]!.registration).runs).toBeUndefined();
    const preWarnings: Finding[] = [];
    expect(rigRegistrationFindings(beforeSince.dir, preProject, preWarnings)).toEqual([]);
    expect(preWarnings.map(f => f.code)).toEqual(['RUN_RECORD_REQUIRED']);
    const preCheck = checkProject(beforeSince.dir, preProject);
    expect(preCheck.warnings.map(f => f.code)).toContain('RUN_RECORD_REQUIRED');
    expect(preCheck.refusals.map(f => f.code)).not.toContain('RUN_RECORD_REQUIRED');

    const onSince = setup('2026-11-08T00:00:00Z');
    const beforeBytes = readFileSync(join(onSince.dir, 'project.json'));
    refused(onSince.baseArgs, 'RUN_RECORD_REQUIRED');
    expect(readFileSync(join(onSince.dir, 'project.json'))).toEqual(beforeBytes);
    expect(existsSync(join(onSince.dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(onSince.dir, 'evidence/v1/registration'))).toBe(false);

    obj((preProject.versions as JsonObject[])[0]!.registration).at = '2026-11-08T00:00:00Z';
    const postWarnings: Finding[] = [];
    expect(rigRegistrationFindings(beforeSince.dir, preProject, postWarnings).map(f => f.code)).toEqual(['RUN_RECORD_REQUIRED']);
    expect(postWarnings).toEqual([]);
    expect(checkProject(beforeSince.dir, preProject).refusals.map(f => f.code)).toContain('RUN_RECORD_REQUIRED');
  });
});
