/** Bind producer run records (rig-run/1 and rigc-run/1) by raw SHA-256 and spec shape without re-running or recomputing producer measurements. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, isObject, type Finding } from './check.ts';
import { literalFile } from './choices.ts';
import { structurePathIsIgnored } from './structure.ts';
import type { Json, JsonObject } from './templates.ts';

export const RUN_RECORD_SINCE = '2026-11-08T00:00:00Z';
export const RUN_SPECS = ['rig-run/1', 'rigc-run/1'] as const;
export type RunSpec = (typeof RUN_SPECS)[number];
export const RIGC_INPUT_ROLES = ['rig', 'motion', 'manifest', 'cuts'] as const;
export const RIGC_REQUIRED_ROLES = ['rig', 'motion'] as const;

const TOP_KEYS: Record<RunSpec, readonly string[]> = {
  'rig-run/1': ['spec', 'package', 'command', 'started_at', 'finished_at', 'config', 'outputs'],
  'rigc-run/1': ['spec', 'package', 'command', 'started_at', 'finished_at', 'inputs', 'outputs'],
};

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const absolute = (path: string): boolean => isAbsolute(path) || win32.isAbsolute(path);
const literal = (path: string): boolean => !!path && !absolute(path) && !path.includes('\\') && !path.includes(':') && path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
const relativeRunPath = (path: Json | undefined): path is string =>
  typeof path === 'string' && path.length > 0 && !absolute(path) && !path.startsWith('~') && !path.includes('\\') && !path.includes(':')
  && path.split('/').every(segment => segment !== '' && segment !== '.');
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

export function isRunSpec(value: Json | undefined): value is RunSpec {
  return value === 'rig-run/1' || value === 'rigc-run/1';
}

export function validateRunRecord(bytes: Buffer, path: string): { spec: RunSpec; record: JsonObject } {
  let parsed: Json;
  try { parsed = JSON.parse(bytes.toString('utf8')) as Json; }
  catch { fail('RUN_RECORD_MALFORMED', path, 'expected valid UTF-8 JSON'); }
  if (!isObject(parsed)) fail('RUN_RECORD_MALFORMED', path, 'expected a JSON object');
  if (!isRunSpec(parsed.spec)) {
    fail('RUN_RECORD_SPEC_UNKNOWN', `${path}.spec`, `unknown producer run spec ${JSON.stringify(parsed.spec ?? null)}; expected rig-run/1 or rigc-run/1`);
  }
  const spec = parsed.spec;
  if (!isDeepStrictEqual(Object.keys(parsed), [...TOP_KEYS[spec]])) {
    fail('RUN_RECORD_MALFORMED', path, `keys must be in published ${spec} order (${TOP_KEYS[spec].join(', ')})`);
  }
  const pkg = parsed.package;
  if (!isObject(pkg) || !isDeepStrictEqual(Object.keys(pkg), ['name', 'version'])) {
    fail('RUN_RECORD_MALFORMED', `${path}.package`, 'package must have keys name, version in that order');
  }
  const expectedName = spec === 'rig-run/1' ? '@rig-c/parts' : 'rig-c';
  if (pkg.name !== expectedName || typeof pkg.version !== 'string' || !pkg.version.trim()) {
    fail('RUN_RECORD_MALFORMED', `${path}.package`, `expected package.name ${JSON.stringify(expectedName)} and a nonempty version`);
  }
  if (spec === 'rig-run/1' ? (parsed.command !== 'rig' && parsed.command !== 'assemble') : parsed.command !== 'build') {
    fail('RUN_RECORD_MALFORMED', `${path}.command`, `invalid ${spec} command ${JSON.stringify(parsed.command ?? null)}`);
  }
  if (!runTimestamp(parsed.started_at)) fail('RUN_RECORD_MALFORMED', `${path}.started_at`, 'expected a UTC ISO-8601 millisecond timestamp ending in Z');
  if (!runTimestamp(parsed.finished_at)) fail('RUN_RECORD_MALFORMED', `${path}.finished_at`, 'expected a UTC ISO-8601 millisecond timestamp ending in Z');

  if (spec === 'rig-run/1') {
    const config = parsed.config;
    if (!isObject(config) || !isDeepStrictEqual(Object.keys(config), ['path', 'sha256']) || !relativeRunPath(config.path) || !hex64(config.sha256)) {
      fail('RUN_RECORD_MALFORMED', `${path}.config`, 'config must have relative path and 64-hex sha256 in that order');
    }
  } else {
    const inputs = parsed.inputs;
    if (!Array.isArray(inputs)) fail('RUN_RECORD_MALFORMED', `${path}.inputs`, 'inputs must be an array');
    const seenRoles = new Set<string>();
    let prevRoleOrder = -1;
    let prevPath = '';
    for (const [i, item] of inputs.entries()) {
      const itemPath = `${path}.inputs[${i}]`;
      if (!isObject(item)) fail('RUN_RECORD_MALFORMED', itemPath, 'input entry must be an object');
      if (typeof item.role !== 'string' || !RIGC_INPUT_ROLES.includes(item.role as (typeof RIGC_INPUT_ROLES)[number])) {
        fail('RUN_RECORD_ROLE_INVALID', `${itemPath}.role`, `unknown input role ${JSON.stringify(item.role ?? null)}; expected one of ${RIGC_INPUT_ROLES.join(', ')}`);
      }
      if (!isDeepStrictEqual(Object.keys(item), ['role', 'path', 'sha256']) || !relativeRunPath(item.path) || !hex64(item.sha256)) {
        fail('RUN_RECORD_MALFORMED', itemPath, 'input entry must have keys role, path, sha256 in that order with a relative path and 64-hex sha256');
      }
      const roleOrder = RIGC_INPUT_ROLES.indexOf(item.role as (typeof RIGC_INPUT_ROLES)[number]);
      if (roleOrder < prevRoleOrder) {
        fail('RUN_RECORD_ROLE_INVALID', `${itemPath}.role`, `input roles must sort in fixed order (${RIGC_INPUT_ROLES.join(', ')})`);
      }
      if (roleOrder === prevRoleOrder && !(prevPath < item.path)) {
        fail('RUN_RECORD_MALFORMED', `${itemPath}.path`, 'inputs with the same role must sort by path in UTF-16 code-unit order');
      }
      seenRoles.add(item.role);
      prevRoleOrder = roleOrder;
      prevPath = item.path;
    }
    for (const required of RIGC_REQUIRED_ROLES) {
      if (!seenRoles.has(required)) {
        fail('RUN_RECORD_ROLE_INVALID', `${path}.inputs`, `rigc-run/1 requires input role ${required}`);
      }
    }
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
      message: `${runsPath}: version registered from the npm lock alone; retain producer run.json records with --run-record and register a new rig version`,
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
    if (!isRunSpec(entry.spec)) {
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
      const validated = validateRunRecord(bytes, entryPath);
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
