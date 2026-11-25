/**
 * `current.<kind>`: one current output per kind (docs/CURRENT-DATA.md §1.3), and staleness by content hash (§2.2).
 * A node is stale when a `built_from` path now hashes differently, or when a node upstream of it is stale.
 * A producer run record is provenance, not product: an output-set hash leaves it out, and no `built_from` names it (§4.1).
 */
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, readdirSync, readFileSync } from './check-reads.ts';
import { asArray, isObject, type Finding } from './check.ts';
import { runArgvProblem } from './run-record.ts';
import type { Json, JsonObject } from './templates.ts';

export const CURRENT_KINDS = ['parts', 'rig', 'motion', 'direction'] as const;
export type CurrentKind = (typeof CURRENT_KINDS)[number];
export const RUN_RECORD_NAME = 'run.json';
export const REBUILD_RUN_SPECS = ['rig-run/2', 'rigc-run/2'] as const;
export type RebuildRunSpec = (typeof REBUILD_RUN_SPECS)[number];
/**
 * The producers' own rule for run records: a file named `run.json` (`rig-run/1`, `rigc-run/1`) or ending in `-run.json`
 * (core's `render-run.json`, Parts' `rig-run/2` `check-run.json` and `build-run.json`).
 */
/** Whether `path` names a producer run record: the one rule for output identity and `built_from`. */
export function isRunRecordFile(path: string): boolean {
  const name = posix.basename(path);
  return name === RUN_RECORD_NAME || name.endsWith('-run.json');
}
/** The compose check report carries absolute paths in its reasons, so no `built_from` names it (§4.1). */
const COMPOSE_CHECK_REPORT = 'outputs/direction/check/check.json';

export const outputRoot = (kind: CurrentKind): string => `outputs/${kind}`;
export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const hex64 = (value: Json | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const literal = (path: Json | undefined): path is string => typeof path === 'string' && path.length > 0 && !path.startsWith('/')
  && !path.includes('\\') && !path.includes(':') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

/** Whether a `built_from` entry may name `path`: never a run record, never the compose check report. */
export function builtFromNameAllowed(path: string): boolean {
  return !isRunRecordFile(path) && path !== COMPOSE_CHECK_REPORT;
}

/** The output-set hash: sha256 over the sorted `[path, sha256]` pairs of every file that is not a run record. */
export function outputSetHash(files: readonly { path: string; sha256: string }[]): string {
  const rows = files.filter(file => !isRunRecordFile(file.path))
    .map(file => [file.path, file.sha256] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return sha256(JSON.stringify(rows));
}

/** Every regular file under `root` (project-relative), with its sha256 and size; a symlink or other entry throws. */
export function treeFiles(dir: string, root: string, recordAs = root): { path: string; sha256: string; bytes: number }[] {
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, root, rel)).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, root, child));
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) {
        const bytes = readFileSync(join(dir, root, child));
        files.push({ path: `${recordAs}/${child}`, sha256: sha256(bytes), bytes: bytes.length });
      } else throw Error(`${root}/${child} is not a regular file or directory`);
    }
  };
  walk('');
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

const KIND_OF_ROOT = new Map(CURRENT_KINDS.map(kind => [outputRoot(kind), kind]));
/** The kind whose output tree holds `path`, if any. */
function upstreamKind(path: string): CurrentKind | undefined {
  for (const [root, kind] of KIND_OF_ROOT) if (path === root || path.startsWith(`${root}/`)) return kind;
}

const malformed = (path: string, why: string): Finding => ({ code: 'CURRENT_MALFORMED', path,
  message: `${path}: ${why}; restore the record written by rig-create record, or record the output again with rig-create record <kind>` });

function bindingProblem(value: Json | undefined): string | undefined {
  if (!isObject(value) || !literal(value.path) || !hex64(value.sha256)) return 'expected { path, sha256 } with a literal project-relative path and a 64-hex sha256';
}

/** Shape findings for one `current.<kind>` entry; these are the same rules the writer validates with (invariant 6). */
export function currentShapeFindings(kind: CurrentKind, node: Json | undefined): Finding[] {
  const path = `current.${kind}`;
  if (!isObject(node)) return [malformed(path, 'expected an object')];
  const findings: Finding[] = [];
  if (typeof node.at !== 'string' || !Number.isFinite(Date.parse(node.at)) || new Date(node.at).toISOString() !== node.at) findings.push(malformed(`${path}.at`, 'expected a UTC ISO-8601 instant'));
  if (typeof node.built_by !== 'string' || !node.built_by.trim()) findings.push(malformed(`${path}.built_by`, 'expected a nonempty string'));
  if (!isObject(node.built_with) || Object.values(node.built_with).some(v => typeof v !== 'string' || !v)) findings.push(malformed(`${path}.built_with`, 'expected { package: version }'));
  const root = outputRoot(kind);
  const files = asArray(node.files);
  if (!Array.isArray(node.files) || files.length === 0) findings.push(malformed(`${path}.files`, 'expected a nonempty list'));
  const pairs: { path: string; sha256: string }[] = [];
  let previous = '';
  for (const [index, file] of files.entries()) {
    const at = `${path}.files[${index}]`;
    if (bindingProblem(file) || !isObject(file) || !String(file.path).startsWith(`${root}/`) || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      findings.push(malformed(at, `expected { path under ${root}/, sha256, bytes }`));
      continue;
    }
    if (!(previous < String(file.path))) findings.push(malformed(at, 'files must sort by path with no duplicate'));
    previous = String(file.path);
    pairs.push({ path: String(file.path), sha256: String(file.sha256) });
  }
  if (node.files_sha256 !== outputSetHash(pairs)) findings.push(malformed(`${path}.files_sha256`, 'differs from the output-set hash of files[] (every file that is not a run record)'));
  for (const key of ['run', 'report'] as const) {
    const binding = node[key];
    const problem = bindingProblem(binding);
    if (problem) { findings.push(malformed(`${path}.${key}`, problem)); continue; }
    const b = binding as JsonObject;
    if (!pairs.some(pair => pair.path === b.path && pair.sha256 === b.sha256)) findings.push(malformed(`${path}.${key}`, 'names no entry of files[] with the same sha256'));
  }
  const builtFrom = asArray(node.built_from);
  if (!Array.isArray(node.built_from)) findings.push(malformed(`${path}.built_from`, 'expected a list'));
  for (const [index, entry] of builtFrom.entries()) {
    const at = `${path}.built_from[${index}]`;
    const problem = bindingProblem(entry);
    if (problem) findings.push(malformed(at, problem));
    else if (!builtFromNameAllowed(String((entry as JsonObject).path))) findings.push(malformed(at, `names ${String((entry as JsonObject).path)}; a run record or the compose check report is provenance, so name the product files the output reads`));
    else if (upstreamKind(String((entry as JsonObject).path)) === kind) findings.push(malformed(at, 'names a file of this output itself'));
  }
  const rebuild = node.rebuild;
  if (kind === 'rig') {
    if (!isObject(rebuild) || typeof rebuild.recorded !== 'boolean') {
      findings.push(malformed(`${path}.rebuild`, 'expected { recorded: false, note } or { recorded: true, runs }'));
    } else if (rebuild.recorded === false) {
      if (!isDeepStrictEqual(Object.keys(rebuild), ['recorded', 'note']) || typeof rebuild.note !== 'string' || !rebuild.note.trim()) {
        findings.push(malformed(`${path}.rebuild`, 'expected { recorded: false, note } with a nonempty note'));
      }
    } else if (!isDeepStrictEqual(Object.keys(rebuild), ['recorded', 'runs']) || !Array.isArray(rebuild.runs) || rebuild.runs.length === 0) {
      findings.push(malformed(`${path}.rebuild`, 'expected { recorded: true, runs } with a nonempty list of producer run records'));
    } else {
      let previousRun = '';
      let rigRuns = 0;
      for (const [index, entry] of rebuild.runs.entries()) {
        const at = `${path}.rebuild.runs[${index}]`;
        if (!isObject(entry) || !isDeepStrictEqual(Object.keys(entry), ['path', 'sha256', 'spec', 'argv']) || bindingProblem(entry)) {
          findings.push(malformed(at, 'expected { path, sha256, spec, argv }'));
          continue;
        }
        const entryPath = String(entry.path);
        if (!isRunRecordFile(entryPath)) findings.push(malformed(`${at}.path`, 'expected a producer run record path (run.json or *-run.json)'));
        if (!pairs.some(pair => pair.path === entryPath && pair.sha256 === entry.sha256)) {
          findings.push(malformed(at, 'names no entry of files[] with the same sha256'));
        }
        if (!(previousRun < entryPath)) findings.push(malformed(`${at}.path`, 'runs must sort by path with no duplicate'));
        previousRun = entryPath;
        if (entry.spec !== 'rig-run/2' && entry.spec !== 'rigc-run/2') {
          findings.push(malformed(`${at}.spec`, 'expected rig-run/2 or rigc-run/2'));
          continue;
        }
        if (entry.spec === 'rig-run/2') rigRuns++;
        const argvProblem = runArgvProblem(entry.argv, entry.spec);
        if (argvProblem) findings.push(malformed(`${at}.argv`, argvProblem));
      }
      if (rigRuns !== 1) findings.push(malformed(`${path}.rebuild.runs`, 'expected exactly one rig-run/2 check or build record'));
    }
  }
  return findings;
}

/** The hash a `built_from` path has now: a file's sha256, or an output root's output-set hash; undefined when absent. */
function currentHash(dir: string, path: string): string | undefined {
  try {
    if (!existsSync(join(dir, path))) return undefined;
    if (KIND_OF_ROOT.has(path) && lstatSync(join(dir, path)).isDirectory()) return outputSetHash(treeFiles(dir, path));
    if (!lstatSync(join(dir, path)).isFile()) return undefined;
    return sha256(readFileSync(join(dir, path)));
  } catch { return undefined; }
}

/**
 * Check `current`: refusals for a malformed entry, WARN `OUTPUT_STALE` for a stale one (never a refusal, §2.2).
 * A record without `current` (an old-process project) gets nothing from here.
 */
export function currentFindings(dir: string, project: JsonObject, warnings: Finding[]): Finding[] {
  if (project.current === undefined) return [];
  if (!isObject(project.current)) return [malformed('current', 'expected an object of current outputs by kind')];
  const refusals: Finding[] = [];
  const nodes = new Map<CurrentKind, JsonObject>();
  for (const [key, node] of Object.entries(project.current)) {
    if (!(CURRENT_KINDS as readonly string[]).includes(key)) { refusals.push(malformed(`current.${key}`, `unknown kind; the kinds are ${CURRENT_KINDS.join(', ')}`)); continue; }
    const shape = currentShapeFindings(key as CurrentKind, node);
    refusals.push(...shape);
    if (!shape.length) nodes.set(key as CurrentKind, node as JsonObject);
  }
  // Direct staleness: a built_from path now hashes differently.
  const changed = new Map<CurrentKind, string>();
  for (const [kind, node] of nodes) {
    for (const entry of asArray(node.built_from)) {
      const binding = entry as JsonObject;
      const now = currentHash(dir, String(binding.path));
      if (now !== binding.sha256) {
        changed.set(kind, `${String(binding.path)} ${now === undefined ? 'is missing' : `now hashes ${now.slice(0, 12)}, recorded ${String(binding.sha256).slice(0, 12)}`}`);
        break;
      }
    }
  }
  // Transitive staleness: a built_from path inside a stale upstream output.
  const stale = new Map(changed);
  for (let grew = true; grew;) {
    grew = false;
    for (const [kind, node] of nodes) {
      if (stale.has(kind)) continue;
      const upstream = asArray(node.built_from).map(entry => upstreamKind(String((entry as JsonObject).path))).find(up => up !== undefined && stale.has(up));
      if (upstream) { stale.set(kind, `upstream ${upstream} is stale`); grew = true; }
    }
  }
  const rig = nodes.get('rig');
  if (rig && isObject(rig.rebuild) && rig.rebuild.recorded === false) {
    warnings.push({ code: 'REBUILD_ARGS_UNRECORDED', path: 'current.rig.rebuild',
      message: `current.rig.rebuild: ${String(rig.rebuild.note)}; a rebuild of outputs/rig needs the unrecorded arguments from the operator until it is recorded from rig-run/2 and rigc-run/2 reports` });
  }
  for (const kind of CURRENT_KINDS) {
    const why = stale.get(kind);
    if (why === undefined) continue;
    warnings.push({ code: 'OUTPUT_STALE', path: `current.${kind}`,
      message: `current.${kind}: stale, ${why}; rebuild it upstream-first and record it with rig-create record ${kind}` });
  }
  return refusals;
}
