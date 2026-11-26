/** Bind producer run records by raw SHA-256 and spec shape without re-running or recomputing producer measurements. */
import { createHash } from 'node:crypto';
import { readFileSync } from './check-reads.ts';
import { isAbsolute, posix, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, isObject, type Finding } from './check.ts';
import { literalFile } from './choices.ts';
import { structurePathIsIgnored } from './structure.ts';
import type { Json, JsonObject } from './templates.ts';

export const RUN_RECORD_SINCE = '2026-11-08T00:00:00Z';
export const FROZEN_RUN_SPECS = ['rig-run/1', 'rigc-run/1'] as const;
export type FrozenRunSpec = (typeof FROZEN_RUN_SPECS)[number];
export const RUN_SPECS = ['rig-run/1', 'rig-run/2', 'rig-run/3', 'rigc-run/1', 'rigc-run/2'] as const;
export type RunSpec = (typeof RUN_SPECS)[number];
export const RIGC_INPUT_ROLES = ['rig', 'motion', 'manifest', 'cuts'] as const;
export const RIGC_REQUIRED_ROLES = ['rig', 'motion'] as const;
export const RIGC_RENDER_INPUT_ROLES = ['skeleton', 'atlas', 'model', 'environment', 'viewport', 'boundary'] as const;
export const RIGC_RENDER_REQUIRED_ROLES = ['skeleton'] as const;

const RIG_RUN_2_CHECK_KEYS = ['spec', 'package', 'command', 'started_at', 'finished_at', 'outputs', 'argv'] as const;
const RIG_RUN_2_BUILD_KEYS = ['spec', 'package', 'command', 'started_at', 'finished_at', 'config', 'outputs', 'argv'] as const;
const RIG_RUN_3_BUILD_KEYS = ['spec', 'package', 'command', 'started_at', 'finished_at', 'config', 'inputs', 'outputs', 'argv'] as const;
const PARTS_BUILD_OPTIONAL_ROLES = ['head', 'requirements', 'environment', 'wind-band'] as const;
const TOP_KEYS: Record<Exclude<RunSpec, 'rig-run/2'>, readonly string[]> = {
  'rig-run/1': ['spec', 'package', 'command', 'started_at', 'finished_at', 'config', 'outputs'],
  'rig-run/3': RIG_RUN_3_BUILD_KEYS,
  'rigc-run/1': ['spec', 'package', 'command', 'started_at', 'finished_at', 'inputs', 'outputs'],
  'rigc-run/2': ['spec', 'package', 'command', 'argv', 'started_at', 'finished_at', 'inputs', 'outputs'],
};
const ASSEMBLE_RUN_KEYS = ['spec', 'package', 'command', 'started_at', 'finished_at', 'config', 'inputs', 'outputs'];
const ASSEMBLE_INPUT_ROLES = ['source', 'full', 'head'];

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const absolute = (path: string): boolean => isAbsolute(path) || win32.isAbsolute(path);
const literal = (path: string): boolean => !!path && !absolute(path) && !path.includes('\\') && !path.includes(':') && path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
const relativeRunPath = (path: Json | undefined): path is string =>
  typeof path === 'string' && path.length > 0 && !absolute(path) && !path.startsWith('~') && !path.includes('\\') && !path.includes(':')
  && path.split('/').every(segment => segment !== '' && segment !== '.');
const isRunRecordOutputName = (path: string): boolean => {
  const name = posix.basename(path);
  return name === 'run.json' || name.endsWith('-run.json');
};
const hex64 = (value: Json | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const runTimestamp = (value: Json | undefined): value is string =>
  typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export class RunRecordError extends Error {
  constructor(readonly code: string, readonly path: string, readonly why: string) {
    super(`${path}: ${why}; retain the producer run.json with --run-record and register a new rig version`);
  }
}

function fail(code: string, path: string, why: string): never {
  throw new RunRecordError(code, path, why);
}

export function isFrozenRunSpec(value: Json | undefined): value is FrozenRunSpec {
  return value === 'rig-run/1' || value === 'rigc-run/1';
}

export function isRunSpec(value: Json | undefined): value is RunSpec {
  return (RUN_SPECS as readonly unknown[]).includes(value);
}

/** Validate recorded argv, including the command token for Parts records. */
export function runArgvProblem(argv: Json | undefined, spec: 'rig-run/2' | 'rig-run/3' | 'rigc-run/2', command?: string): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0) return 'argv must be a nonempty array of strings';
  for (const token of argv) {
    if (typeof token !== 'string') return 'argv entries must be strings';
    if (absolute(token)) return `argv token ${JSON.stringify(token)} must be relative to the output directory, not an absolute path`;
    if (token.startsWith('--') && token.includes('=')) {
      const value = token.slice(token.indexOf('=') + 1);
      if (absolute(value)) return `argv token ${JSON.stringify(token)} must carry a path relative to the output directory, not an absolute path`;
    }
  }
  if (spec === 'rig-run/3' && argv[0] !== 'build') return 'argv[0] must be "build"';
  if (spec === 'rig-run/2') {
    const first = argv[0];
    if (command !== undefined ? first !== command : (first !== 'check' && first !== 'build')) {
      return command !== undefined
        ? `argv[0] must equal command ${JSON.stringify(command)}`
        : 'argv[0] must be "check" or "build"';
    }
  }
  return undefined;
}

function validatePartsBuildInputs(inputs: Json | undefined, path: string): void {
  if (!Array.isArray(inputs)) fail('RUN_RECORD_MALFORMED', path, 'inputs must be an array');
  const roles = inputs.map((input, index) => {
    const at = `${path}[${index}]`;
    if (!isObject(input) || !isDeepStrictEqual(Object.keys(input), ['role', 'path', 'sha256'])
      || !relativeRunPath(input.path) || input.path.includes('\0') || !hex64(input.sha256)) {
      fail('RUN_RECORD_MALFORMED', at, 'input entry must have keys role, path, sha256 in that order with a relative path and 64-hex sha256');
    }
    return input.role;
  });

  // Parts STABILITY orders the primary CLI inputs first, then each --alt tuple in CLI order.
  let next = 0;
  const expectRole = (expected: string): void => {
    if (next === roles.length) fail('RUN_RECORD_ROLE_INVALID', path, `missing required input role ${expected}`);
    if (roles[next] !== expected) {
      fail('RUN_RECORD_ROLE_INVALID', `${path}[${next}].role`, `expected input role ${expected}, got ${JSON.stringify(roles[next])}`);
    }
    next++;
  };
  expectRole('source');
  expectRole('full');
  for (const role of PARTS_BUILD_OPTIONAL_ROLES) {
    if (roles[next] === role) next++;
  }
  for (let alt = 0; next < roles.length; alt++) {
    expectRole(`alt[${alt}].source`);
    expectRole(`alt[${alt}].full`);
    if (roles[next] === `alt[${alt}].head`) next++;
  }
}

export function validateRunRecord(
  bytes: Buffer,
  path: string,
  options: { allowAssembleInputs?: boolean; specs?: readonly RunSpec[] } = {},
): { spec: RunSpec; record: JsonObject } {
  let parsed: Json;
  try { parsed = JSON.parse(bytes.toString('utf8')) as Json; }
  catch { fail('RUN_RECORD_MALFORMED', path, 'expected valid UTF-8 JSON'); }
  if (!isObject(parsed)) fail('RUN_RECORD_MALFORMED', path, 'expected a JSON object');
  const allowed = options.specs ?? RUN_SPECS;
  if (!isRunSpec(parsed.spec) || !allowed.includes(parsed.spec)) {
    fail('RUN_RECORD_SPEC_UNKNOWN', `${path}.spec`, `unknown producer run spec ${JSON.stringify(parsed.spec ?? null)}; expected ${allowed.join(' or ')}`);
  }
  const spec = parsed.spec;
  const assembleInputs = options.allowAssembleInputs && spec === 'rig-run/1' && parsed.command === 'assemble' && Object.hasOwn(parsed, 'inputs');
  const keys = assembleInputs
    ? ASSEMBLE_RUN_KEYS
    : spec === 'rig-run/2'
      ? (parsed.command === 'build' || (parsed.command !== 'check' && Object.hasOwn(parsed, 'config')) ? RIG_RUN_2_BUILD_KEYS : RIG_RUN_2_CHECK_KEYS)
      : TOP_KEYS[spec];
  if (!isDeepStrictEqual(Object.keys(parsed), [...keys])) {
    fail('RUN_RECORD_MALFORMED', path, `keys must be in published ${spec} order (${keys.join(', ')})`);
  }
  const pkg = parsed.package;
  if (!isObject(pkg) || !isDeepStrictEqual(Object.keys(pkg), ['name', 'version'])) {
    fail('RUN_RECORD_MALFORMED', `${path}.package`, 'package must have keys name, version in that order');
  }
  const expectedNames = spec.startsWith('rig-run/') ? ['@rig-c/parts'] : ['@rig-c/core', 'rig-c'];
  if (!expectedNames.includes(String(pkg.name)) || typeof pkg.version !== 'string' || !pkg.version.trim()) {
    fail('RUN_RECORD_MALFORMED', `${path}.package`, `expected package.name ${expectedNames.map(name => JSON.stringify(name)).join(' or ')} and a nonempty version`);
  }
  const validCommand = spec === 'rig-run/1'
    ? (parsed.command === 'rig' || parsed.command === 'assemble')
    : spec === 'rig-run/2'
      ? (parsed.command === 'check' || parsed.command === 'build')
      : spec === 'rig-run/3' || spec === 'rigc-run/1'
        ? parsed.command === 'build'
        : parsed.command === 'render';
  if (!validCommand) {
    fail('RUN_RECORD_MALFORMED', `${path}.command`, `invalid ${spec} command ${JSON.stringify(parsed.command ?? null)}`);
  }
  if (!runTimestamp(parsed.started_at)) fail('RUN_RECORD_MALFORMED', `${path}.started_at`, 'expected a UTC ISO-8601 millisecond timestamp ending in Z');
  if (!runTimestamp(parsed.finished_at)) fail('RUN_RECORD_MALFORMED', `${path}.finished_at`, 'expected a UTC ISO-8601 millisecond timestamp ending in Z');

  if (spec === 'rig-run/1' || spec === 'rig-run/3' || (spec === 'rig-run/2' && parsed.command === 'build')) {
    const config = parsed.config;
    if (!isObject(config) || !isDeepStrictEqual(Object.keys(config), ['path', 'sha256']) || !relativeRunPath(config.path) || !hex64(config.sha256)) {
      fail('RUN_RECORD_MALFORMED', `${path}.config`, 'config must have relative path and 64-hex sha256 in that order');
    }
    if (spec === 'rig-run/3') validatePartsBuildInputs(parsed.inputs, `${path}.inputs`);
    if (assembleInputs) {
      const inputs = parsed.inputs;
      if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > ASSEMBLE_INPUT_ROLES.length) {
        fail('RUN_RECORD_MALFORMED', `${path}.inputs`, 'expected source, full and optional head inputs');
      }
      for (const [index, input] of inputs.entries()) {
        if (!isObject(input) || !isDeepStrictEqual(Object.keys(input), ['role', 'path', 'sha256']) || input.role !== ASSEMBLE_INPUT_ROLES[index]
          || !(input.path === '.' || relativeRunPath(input.path)) || !hex64(input.sha256)) {
          fail('RUN_RECORD_MALFORMED', `${path}.inputs[${index}]`, `expected role ${ASSEMBLE_INPUT_ROLES[index]}, a working-directory-relative path and 64-hex sha256 in that order`);
        }
      }
    }
  } else if (spec === 'rigc-run/1' || spec === 'rigc-run/2') {
    const roles = spec === 'rigc-run/1' ? RIGC_INPUT_ROLES : RIGC_RENDER_INPUT_ROLES;
    const requiredRoles = spec === 'rigc-run/1' ? RIGC_REQUIRED_ROLES : RIGC_RENDER_REQUIRED_ROLES;
    const inputs = parsed.inputs;
    if (!Array.isArray(inputs)) fail('RUN_RECORD_MALFORMED', `${path}.inputs`, 'inputs must be an array');
    const seenRoles = new Set<string>();
    let prevRoleOrder = -1;
    let prevPath = '';
    for (const [i, item] of inputs.entries()) {
      const itemPath = `${path}.inputs[${i}]`;
      if (!isObject(item)) fail('RUN_RECORD_MALFORMED', itemPath, 'input entry must be an object');
      if (typeof item.role !== 'string' || !(roles as readonly string[]).includes(item.role)) {
        fail('RUN_RECORD_ROLE_INVALID', `${itemPath}.role`, `unknown input role ${JSON.stringify(item.role ?? null)}; expected one of ${roles.join(', ')}`);
      }
      if (!isDeepStrictEqual(Object.keys(item), ['role', 'path', 'sha256']) || !relativeRunPath(item.path) || !hex64(item.sha256)) {
        fail('RUN_RECORD_MALFORMED', itemPath, 'input entry must have keys role, path, sha256 in that order with a relative path and 64-hex sha256');
      }
      const roleOrder = (roles as readonly string[]).indexOf(item.role);
      if (roleOrder < prevRoleOrder) {
        fail('RUN_RECORD_ROLE_INVALID', `${itemPath}.role`, `input roles must sort in fixed order (${roles.join(', ')})`);
      }
      if (roleOrder === prevRoleOrder) {
        if (spec === 'rigc-run/2') fail('RUN_RECORD_ROLE_INVALID', `${itemPath}.role`, `duplicate input role ${item.role}`);
        if (!(prevPath < item.path)) fail('RUN_RECORD_MALFORMED', `${itemPath}.path`, 'inputs with the same role must sort by path in UTF-16 code-unit order');
      }
      seenRoles.add(item.role);
      prevRoleOrder = roleOrder;
      prevPath = item.path;
    }
    for (const required of requiredRoles) {
      if (!seenRoles.has(required)) {
        fail('RUN_RECORD_ROLE_INVALID', `${path}.inputs`, `${spec} requires input role ${required}`);
      }
    }
  }

  const hasArgv = spec === 'rig-run/2' || spec === 'rig-run/3' || spec === 'rigc-run/2';
  if (hasArgv) {
    const argvProblem = runArgvProblem(parsed.argv, spec, String(parsed.command));
    if (argvProblem) fail('RUN_RECORD_MALFORMED', `${path}.argv`, argvProblem);
  }

  const outputs = parsed.outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) {
    fail('RUN_RECORD_MALFORMED', `${path}.outputs`, 'outputs must be a nonempty array');
  }
  let prevOutputPath = '';
  for (const [i, out] of outputs.entries()) {
    const outPath = `${path}.outputs[${i}]`;
    if (!isObject(out) || !isDeepStrictEqual(Object.keys(out), ['path', 'sha256']) || !relativeRunPath(out.path) || !hex64(out.sha256)) {
      fail('RUN_RECORD_MALFORMED', outPath, 'output entry must have keys path, sha256 in that order with a relative path and 64-hex sha256');
    }
    if (hasArgv && (out.path.split('/').includes('..') || isRunRecordOutputName(out.path))) {
      fail('RUN_RECORD_MALFORMED', `${outPath}.path`, `${spec} output path must stay within the output directory and exclude run records`);
    }
    if (i > 0 && !(prevOutputPath < out.path)) {
      fail('RUN_RECORD_MALFORMED', `${outPath}.path`, 'outputs must sort by path in UTF-16 code-unit order');
    }
    prevOutputPath = out.path;
  }

  return { spec, record: parsed };
}

export function checkRegisteredRuns(
  dir: string,
  versionPath: string,
  record: JsonObject,
  refusals: Finding[],
  warnings: Finding[],
): Set<string> {
  const runPaths = new Set<string>();
  const runsPath = `${versionPath}.registration.runs`;
  if (record.runs === undefined) {
    const finding: Finding = {
      code: 'RUN_RECORD_REQUIRED',
      path: runsPath,
      message: `${runsPath}: version registered from the toolchain lock alone; retain producer run.json records with --run-record and register a new rig version`,
    };
    const at = Date.parse(String(record.at));
    if (Number.isFinite(at) && at < Date.parse(RUN_RECORD_SINCE)) warnings.push(finding);
    else refusals.push(finding);
    return runPaths;
  }
  if (!Array.isArray(record.runs) || record.runs.length === 0) {
    refusals.push({
      code: 'RUN_RECORD_MALFORMED',
      path: runsPath,
      message: `${runsPath}: expected a nonempty list of bound producer run records; retain the producer run.json with --run-record and register a new rig version`,
    });
    return runPaths;
  }
  const files = asArray(record.files);
  const seenSpecs = new Set<string>();
  for (const [i, entry] of record.runs.entries()) {
    const entryPath = `${runsPath}[${i}]`;
    if (isObject(entry) && isObject(entry.source) && typeof entry.source.path === 'string') {
      runPaths.add(entry.source.path);
    }
    if (!isObject(entry) || !('spec' in entry) || !('source' in entry) || Object.keys(entry).length !== 2) {
      refusals.push({
        code: 'RUN_RECORD_MALFORMED',
        path: entryPath,
        message: `${entryPath}: expected { spec, source }; restore the retained registration inputs or register a new rig version`,
      });
      continue;
    }
    if (!isFrozenRunSpec(entry.spec)) {
      refusals.push({
        code: 'RUN_RECORD_SPEC_UNKNOWN',
        path: `${entryPath}.spec`,
        message: `${entryPath}.spec: unknown producer run spec ${JSON.stringify(entry.spec ?? null)}; retain a rig-run/1 or rigc-run/1 run.json and register a new rig version`,
      });
      continue;
    }
    if (seenSpecs.has(entry.spec)) {
      refusals.push({
        code: 'RUN_RECORD_MALFORMED',
        path: `${entryPath}.spec`,
        message: `${entryPath}.spec: duplicate run record for spec ${entry.spec}; supply at most one --run-record per spec and register a new rig version`,
      });
      continue;
    }
    seenSpecs.add(entry.spec);
    const source = entry.source;
    let bytes: Buffer;
    try {
      if (!isObject(source) || typeof source.path !== 'string' || !literal(source.path)
        || !hex64(source.sha256) || (source.bytes !== undefined && (typeof source.bytes !== 'number' || !Number.isSafeInteger(source.bytes) || source.bytes < 0))) {
        throw Error('expected literal retained path, sha256 and byte count');
      }
      if (structurePathIsIgnored(dir, source.path)) throw Error('run record is under an ignored root');
      const file = literalFile(dir, source.path);
      bytes = readFileSync(file);
      if (sha(bytes) !== source.sha256 || (typeof source.bytes === 'number' && bytes.length !== source.bytes)) {
        throw Error(`${source.path} bytes differ from bound sha256`);
      }
      if (!files.some(f => isObject(f) && f.path === source.path && f.sha256 === source.sha256)) {
        throw Error(`${source.path} is absent from registration.files or its sha256 disagrees`);
      }
    } catch (error) {
      refusals.push({
        code: 'RUN_RECORD_HASH_MISMATCH',
        path: `${entryPath}.source`,
        message: `${entryPath}.source: ${error instanceof Error ? error.message : String(error)}; restore the retained registration inputs or register a new rig version`,
      });
      continue;
    }
    try {
      const validated = validateRunRecord(bytes, entryPath, { specs: FROZEN_RUN_SPECS });
      if (validated.spec !== entry.spec) {
        fail('RUN_RECORD_MALFORMED', `${entryPath}.spec`, `declared spec ${entry.spec} disagrees with retained record spec ${validated.spec}`);
      }
    } catch (error) {
      if (error instanceof RunRecordError) {
        refusals.push({ code: error.code, path: error.path, message: error.message });
      } else {
        refusals.push({
          code: 'RUN_RECORD_MALFORMED',
          path: entryPath,
          message: `${entryPath}: ${error instanceof Error ? error.message : String(error)}; restore the retained registration inputs or register a new rig version`,
        });
      }
    }
  }
  return runPaths;
}
