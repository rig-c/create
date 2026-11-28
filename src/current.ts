/**
 * `current.<kind>`: one current output per kind (docs/CURRENT-DATA.md §1.3), and staleness by content hash (§2.2).
 * A node is stale when a `built_from` path now hashes differently (for `current.parts`' config edge, when Parts'
 * `assemblyConfigChanges` against `outputs/parts/rig/parts.json` is non-empty), when its adopted rig basis is replaced,
 * or when a node upstream of it is stale.
 * A producer run record is provenance, not product: an output-set hash leaves it out, and no `built_from` names it (§4.1).
 */
import { assemblyConfigChanges } from '@rig-c/parts/assembly-reading';
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, withExternalCheckRead } from './check-reads.ts';
import { asArray, isObject, type Finding } from './check.ts';
import { LOOP_SEAM_REPORT_SINCE, motionLoopSeamFindings, readMotionLoopSeamPolicy } from './motion-loop-seam.ts';
import { directionLoopSeamFindings } from './direction-loop-seam.ts';
import { adoptedOutputBindings, legacyMotionRegistration } from './record-adopt.ts';
import { runArgvProblem } from './run-record.ts';
import type { Json, JsonObject } from './templates.ts';

export const CURRENT_KINDS = ['parts', 'rig', 'motion', 'direction'] as const;
export type CurrentKind = (typeof CURRENT_KINDS)[number];
type FileBinding = { path: string; sha256: string };

export function isCurrentProject(project: JsonObject): boolean {
  return project.current !== undefined;
}

/** A `versions[]` row with `pre_interview: true` is migrated history, not a numbered output (#1075). */
export function hasNumberedOutputs(project: JsonObject): boolean {
  return asArray(project.drafts).length > 0
    || asArray(project.versions).some(entry => !isObject(entry) || entry.pre_interview !== true)
    || asArray(project.scenes).length > 0;
}

export const RUN_RECORD_NAME = 'run.json';
export const REBUILD_RUN_SPECS = ['rig-run/2', 'rig-run/3', 'rigc-run/2'] as const;
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
  && !/^[A-Za-z]:/.test(path) && !path.includes('\\') && !path.includes('\0')
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

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

const PROVENANCE_PATH = 'current.motion.provenance';
const invalidMotionProvenance = (why: string): Finding => ({ code: 'CURRENT_MOTION_PROVENANCE_INVALID', path: PROVENANCE_PATH,
  message: `${PROVENANCE_PATH}: ${why}; restore the accepted numbered registration and its bound render, or render and record motion again with --from` });

function adoptedVersion(node: JsonObject): number | undefined {
  const marker = node.adopted;
  if (isObject(marker) && Object.keys(marker).length === 1 && typeof marker.version === 'number'
    && Number.isSafeInteger(marker.version) && marker.version > 0) return marker.version;
}

const legacyMotionRoot = (version: number): string => `outputs/v${version}/idle`;
const isLegacyMotionRoot = (path: string): boolean => /^outputs\/v[1-9]\d*\/idle$/.test(path);

function deriveMotionProvenance(project: JsonObject, version: number, files: readonly FileBinding[]): JsonObject | undefined {
  const legacy = legacyMotionRegistration(project, version);
  if (!legacy) return undefined;
  return { kind: 'legacy-co-registration', version, registration: `versions[v${version}].registration`,
    model_sha256: legacy.model.sha256, frames_sha256: legacy.frames.sha256, files_sha256: motionSetHash(files, legacyMotionRoot(version)) };
}

function bindingProblem(value: Json | undefined): string | undefined {
  if (!isObject(value) || !literal(value.path) || !hex64(value.sha256)) return 'expected { path, sha256 } with a literal project-relative path and a 64-hex sha256';
}

/** Shape findings for one `current.<kind>` entry; these are the same rules the writer validates with (invariant 6). */
export function currentShapeFindings(kind: CurrentKind, node: Json | undefined, project?: JsonObject): Finding[] {
  const path = `current.${kind}`;
  if (!isObject(node)) return [malformed(path, 'expected an object')];
  const findings: Finding[] = [];
  if (typeof node.at !== 'string' || !Number.isFinite(Date.parse(node.at)) || new Date(node.at).toISOString() !== node.at) findings.push(malformed(`${path}.at`, 'expected a UTC ISO-8601 instant'));
  if (typeof node.built_by !== 'string' || !node.built_by.trim()) findings.push(malformed(`${path}.built_by`, 'expected a nonempty string'));
  if (!isObject(node.built_with) || Object.values(node.built_with).some(v => typeof v !== 'string' || !v)) findings.push(malformed(`${path}.built_with`, 'expected { package: version }'));
  const root = outputRoot(kind);
  const marker = node.adopted;
  const version = adoptedVersion(node);
  if (marker !== undefined && version === undefined) findings.push(malformed(`${path}.adopted`, 'expected { version } with a positive legacy version number'));
  const adopted = version === undefined ? undefined : adoptedOutputBindings(project ?? {}, kind, version);
  if (adopted && !adopted.ok) findings.push(malformed(`${path}.adopted`, `versions[v${version}].outputs: ${adopted.why}`));
  const sourceFiles = adopted?.ok ? new Map(adopted.files.map(file => [file.path, file])) : undefined;
  const files = asArray(node.files);
  if (!Array.isArray(node.files) || files.length === 0) findings.push(malformed(`${path}.files`, 'expected a nonempty list'));
  const pairs: { path: string; sha256: string }[] = [];
  let previous = '';
  for (const [index, file] of files.entries()) {
    const at = `${path}.files[${index}]`;
    if (bindingProblem(file) || !isObject(file) || (version === undefined && !String(file.path).startsWith(`${root}/`)) || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      findings.push(malformed(at, version === undefined ? `expected { path under ${root}/, sha256, bytes }`
        : `expected { path, sha256, bytes } bound by versions[v${version}].outputs`));
      continue;
    }
    if (sourceFiles) {
      const source = sourceFiles.get(String(file.path));
      if (!source || source.sha256 !== file.sha256 || (source.bytes !== undefined && source.bytes !== file.bytes)) {
        findings.push(malformed(at, `${String(file.path)} differs from the ${kind} binding in versions[v${version}].outputs`));
      }
      if (source) sourceFiles.delete(source.path);
    }
    if (!(previous < String(file.path))) findings.push(malformed(at, 'files must sort by path with no duplicate'));
    previous = String(file.path);
    pairs.push({ path: String(file.path), sha256: String(file.sha256) });
  }
  if (sourceFiles?.size) findings.push(malformed(`${path}.files`, `missing ${kind} bindings from versions[v${version}].outputs: ${[...sourceFiles.keys()].join(', ')}`));
  if (node.files_sha256 !== outputSetHash(pairs)) findings.push(malformed(`${path}.files_sha256`, 'differs from the output-set hash of files[] (every file that is not a run record)'));
  if (kind === 'motion' && Object.hasOwn(node, 'provenance')) {
    const expected = version !== undefined && project !== undefined ? deriveMotionProvenance(project, version, pairs) : undefined;
    if (expected === undefined || !isDeepStrictEqual(node.provenance, expected)) {
      findings.push(invalidMotionProvenance('expected the matching accepted numbered co-registration and its model, frames and file-set hashes'));
    }
  }
  const rebuild = node.rebuild;
  for (const key of ['run', 'report'] as const) {
    const binding = node[key];
    if (version !== undefined && binding === undefined
      && (key === 'report' || kind !== 'motion' || !isObject(rebuild) || rebuild.recorded !== true)) continue;
    if (kind === 'motion' && rebuild !== undefined) {
      const recorded = isObject(rebuild) && rebuild.recorded === true;
      if (key === 'run' && !recorded && binding !== undefined && version === undefined) findings.push(malformed(`${path}.run`, 'a motion run requires rebuild.recorded=true'));
      if (binding === undefined && (key === 'report' || !recorded)) continue;
    }
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
    else if (upstreamKind(String((entry as JsonObject).path)) === kind
      || (version !== undefined && pairs.some(pair => pair.path === (entry as JsonObject).path))) findings.push(malformed(at, 'names a file of this output itself'));
  }
  if (kind === 'rig' || (kind === 'motion' && rebuild !== undefined) || (isObject(rebuild) && rebuild.recorded === false)) {
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
        const allowed: readonly RebuildRunSpec[] = kind === 'motion' ? ['rigc-run/2'] : REBUILD_RUN_SPECS;
        const spec = allowed.find(candidate => candidate === entry.spec);
        if (spec === undefined) {
          findings.push(malformed(`${at}.spec`, `expected ${allowed.join(' or ')}`));
          continue;
        }
        if (spec === 'rig-run/2' || spec === 'rig-run/3') rigRuns++;
        const argvProblem = runArgvProblem(entry.argv, spec);
        if (argvProblem) findings.push(malformed(`${at}.argv`, argvProblem));
      }
      if (kind === 'rig' && rigRuns !== 1) findings.push(malformed(`${path}.rebuild.runs`, 'expected exactly one Parts run record (rig-run/2 check or build, or rig-run/3 build)'));
    }
  }
  return findings;
}

const PARTS_MANIFEST = 'outputs/parts/rig/parts.json';
type AssemblyManifest = Parameters<typeof assemblyConfigChanges>[1];

/** The canonical parts manifest's hash in an output inventory, including before a staged tree is installed. */
export function currentPartsManifestHash(node: JsonObject): string | undefined {
  const file = asArray(node.files).filter(isObject).find(entry => entry.path === PARTS_MANIFEST);
  return hex64(file?.sha256) ? file.sha256 : undefined;
}

/** The hash a valid current node records for a named product file. */
export function currentFileBinding(project: JsonObject, kind: CurrentKind, path: string): { path: string; sha256: string } | undefined {
  const node = isObject(project.current) ? project.current[kind] : undefined;
  if (!isObject(node) || currentShapeFindings(kind, node, project).length) return undefined;
  const file = asArray(node.files).filter(isObject).find(entry => entry.path === path);
  if (file) return { path, sha256: String(file.sha256) };
}

/** Verify the adopted rig's entire recorded product inventory and name the first difference. */
export function adoptedRigInventoryProblem(dir: string, project: JsonObject, rig: JsonObject,
  { requireComplete = true } = {}): string | undefined {
  const version = adoptedVersion(rig);
  if (version === undefined) return 'current.rig.adopted: expected a numbered rig binding';
  const issue = currentShapeFindings('rig', rig, project)[0];
  if (issue) return issue.message;
  const files = asArray(rig.files).filter(isObject);
  for (const subdir of ['rig', 'check']) {
    const path = `outputs/v${version}/out/${subdir}`;
    const expected = files.filter(file => String(file.path).startsWith(`${path}/`));
    if (expected.length === 0) continue;
    try {
      const absolute = join(realpathSync(dir), path);
      if (realpathSync(absolute) !== absolute) return `${path}: expected the recorded directory at its literal path`;
      const actual = new Map(treeFiles(dir, path).map(file => [file.path, file]));
      for (const recorded of expected) {
        const name = String(recorded.path);
        const file = actual.get(name);
        if (!file) return `${name}: recorded file is missing`;
        if (recorded.sha256 !== file.sha256 || recorded.bytes !== file.bytes) return `${name}: bytes differ from the adopted record`;
        actual.delete(name);
      }
      if (requireComplete && actual.size) return `${actual.keys().next().value}: file is absent from the adopted inventory`;
    } catch (error) {
      return `${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

export const CURRENT_RIG_MODEL = 'outputs/rig/check/build/skeleton.model.json';
export const CURRENT_MOTION_FRAMES = 'outputs/motion/frames.json';
const RIG_MODEL_RELATIVE = 'check/build/skeleton.model.json';

/** Historical rig product names compared across output roots, including any declared atlas pages. */
export function rigModelAtlasRelatives(dir: string, model: FileBinding | undefined): string[] {
  const paths = new Set([RIG_MODEL_RELATIVE, 'check/build/skeleton.atlas']);
  const file = model && regularProjectFile(dir, model.path);
  if (file) {
    try {
      const bytes = readFileSync(file);
      const compiled = sha256(bytes) === model.sha256 ? JSON.parse(bytes.toString('utf8')) as Json : undefined;
      if (isObject(compiled)) {
        for (const page of asArray(compiled.pages).filter(isObject)) {
          if (literal(page.name)) paths.add(`check/build/${page.name}`);
        }
      }
    } catch { /* The producer's recorded model and atlas hashes still apply. */ }
  }
  return [...paths];
}

/** The rig's literal file binding, using a path relative to the rig output root. */
export function currentRigFileBinding(project: JsonObject, relative: string): FileBinding | undefined {
  const rig = isObject(project.current) ? project.current.rig : undefined;
  if (!isObject(rig) || !literal(relative)) return undefined;
  const version = adoptedVersion(rig);
  const root = version === undefined ? outputRoot('rig') : `outputs/v${version}/out`;
  return currentFileBinding(project, 'rig', `${root}/${relative}`);
}

/** Record-only view. File verification belongs to verifiedLegacyMotionProvenance. */
export function legacyMotionProvenance(project: JsonObject): JsonObject | undefined {
  const motion = isObject(project.current) ? project.current.motion : undefined;
  if (!isObject(motion) || currentShapeFindings('motion', motion, project).length) return undefined;
  const version = adoptedVersion(motion);
  if (version !== undefined) return deriveMotionProvenance(project, version, asArray(motion.files) as FileBinding[]);
}

function motionSetHash(files: readonly FileBinding[], root: string): string {
  return outputSetHash(files.map(file => ({ path: `${outputRoot('motion')}${file.path.slice(root.length)}`, sha256: file.sha256 })));
}

function verifiedMotionInventory(dir: string, project: JsonObject): { binding: FileBinding; files: ReturnType<typeof treeFiles> } | undefined {
  const motion = isObject(project.current) ? project.current.motion : undefined;
  if (!isObject(motion) || currentShapeFindings('motion', motion, project).length) return undefined;
  const version = adoptedVersion(motion);
  const root = version === undefined ? outputRoot('motion') : legacyMotionRoot(version);
  try {
    if (realpathSync(join(dir, root)) !== join(realpathSync(dir), root) || !lstatSync(join(dir, root)).isDirectory()) return undefined;
    const files = treeFiles(dir, root);
    const expected = asArray(motion.files);
    if (files.length !== expected.length || !files.every((file, index) => {
      const entry = expected[index] as JsonObject;
      return entry.path === file.path && entry.sha256 === file.sha256 && entry.bytes === file.bytes;
    })) return undefined;
    return { binding: { path: root, sha256: motionSetHash(files, root) }, files };
  } catch { return undefined; }
}

/** Verify every bound byte, then attest the motion set with canonical-relative names. */
export function currentMotionSetBinding(dir: string, project: JsonObject): FileBinding | undefined {
  return verifiedMotionInventory(dir, project)?.binding;
}

/** The co-registration plus its frozen model and rigc frames sidecar, independently checked on disk. */
export function verifiedLegacyMotionProvenance(dir: string, project: JsonObject): JsonObject | undefined {
  const provenance = legacyMotionProvenance(project);
  if (!provenance) return undefined;
  const version = Number(provenance.version);
  const legacy = legacyMotionRegistration(project, version)!;
  const model = regularProjectFile(dir, legacy.model.path);
  const frames = regularProjectFile(dir, legacy.frames.path);
  const inventory = model && frames ? verifiedMotionInventory(dir, project) : undefined;
  if (!model || !frames || !inventory) return undefined;
  try {
    if (sha256(readFileSync(model)) !== legacy.model.sha256) return undefined;
    const bytes = readFileSync(frames);
    if (sha256(bytes) !== legacy.frames.sha256) return undefined;
    const sidecar = JSON.parse(bytes.toString('utf8')) as Json;
    if (!isObject(sidecar) || sidecar.spec !== 'rigc-frames/1' || !Array.isArray(sidecar.sets)) return undefined;
    if (!sidecar.sets.some(set => isObject(set) && set.animation === 'idle') || !sidecar.sets.every(set => isObject(set)
      && typeof set.animation === 'string' && set.animation.length > 0 && typeof set.fps === 'number' && Number.isFinite(set.fps) && set.fps > 0
      && literal(set.dir) && typeof set.written === 'number' && Number.isSafeInteger(set.written)
      && set.written > 0 && inventory.files.filter(file => posix.dirname(file.path) === `${inventory.binding.path}/${String(set.dir)}`
        && /^f\d+\.png$/.test(posix.basename(file.path))).length === set.written)) return undefined;
    return provenance;
  } catch { return undefined; }
}

/** The hash a `built_from` path has now: a file's sha256, or an output root's output-set hash; undefined when absent. */
export function currentHash(dir: string, path: string): string | undefined {
  try {
    if (!existsSync(join(dir, path))) return undefined;
    if (KIND_OF_ROOT.has(path) && lstatSync(join(dir, path)).isDirectory()) return outputSetHash(treeFiles(dir, path));
    if (isLegacyMotionRoot(path)) {
      if (realpathSync(join(dir, path)) !== join(realpathSync(dir), path) || !lstatSync(join(dir, path)).isDirectory()) return undefined;
      return motionSetHash(treeFiles(dir, path), path);
    }
    if (!lstatSync(join(dir, path)).isFile()) return undefined;
    return sha256(readFileSync(join(dir, path)));
  } catch { return undefined; }
}

function hashStaleWhy(dir: string, binding: JsonObject): string | undefined {
  const now = currentHash(dir, String(binding.path));
  if (now === binding.sha256) return undefined;
  return `${String(binding.path)} ${now === undefined ? 'is missing' : `now hashes ${now.slice(0, 12)}, recorded ${String(binding.sha256).slice(0, 12)}`}`;
}

function regularProjectFile(dir: string, rel: string): string | undefined {
  try {
    const file = join(dir, rel);
    if (realpathSync(file) !== join(realpathSync(dir), rel) || !lstatSync(file).isFile()) return undefined;
    return file;
  } catch { return undefined; }
}

/**
 * Identify the `current.parts.built_from` entry that `record parts` bound from `--config`:
 * `record parts` verifies `sha256(config) === run.config.sha256` before sorting `built_from`,
 * and disambiguates any hash tie by excluding the assemble `run.inputs[]` paths.
 */
function partsConfigPath(dir: string, node: JsonObject): string | undefined {
  const runPath = isObject(node.run) && typeof node.run.path === 'string' ? node.run.path : undefined;
  if (!runPath) return undefined;
  let run: Json;
  try {
    const file = regularProjectFile(dir, runPath);
    if (!file) return undefined;
    run = JSON.parse(readFileSync(file, 'utf8')) as Json;
  } catch { return undefined; }
  if (!isObject(run) || !isObject(run.config) || typeof run.config.sha256 !== 'string') return undefined;
  const configSha = run.config.sha256;
  const matches = asArray(node.built_from)
    .filter((entry): entry is JsonObject => isObject(entry) && entry.sha256 === configSha && typeof entry.path === 'string');
  if (matches.length === 1) return String(matches[0]!.path);
  if (matches.length === 0 || !Array.isArray(run.inputs)) return undefined;
  const inputPaths = new Set<string>();
  for (const input of run.inputs) {
    if (!isObject(input) || typeof input.path !== 'string') continue;
    const raw = posix.normalize(input.path);
    inputPaths.add(raw);
    if (input.role === 'full' || input.role === 'head') {
      inputPaths.add(raw === '.' ? 'layers.json' : `${raw}/layers.json`);
    }
  }
  const nonInputs = matches.filter(entry => !inputPaths.has(String(entry.path)));
  return nonInputs.length === 1 ? String(nonInputs[0]!.path) : undefined;
}

/** The recorded parts.json's assembly reading; undefined (whole-file hash) unless its bytes match the `files[]` entry recorded for it. */
function partsAssemblyManifest(dir: string, node: JsonObject): AssemblyManifest | undefined {
  try {
    const file = regularProjectFile(dir, PARTS_MANIFEST);
    if (!file) return undefined;
    const bytes = readFileSync(file);
    if (sha256(bytes) !== currentPartsManifestHash(node)) return undefined;
    const parsed = JSON.parse(bytes.toString('utf8')) as Json;
    if (!isObject(parsed) || parsed.assembly_config === undefined) return undefined;
    return parsed as unknown as AssemblyManifest;
  } catch { return undefined; }
}

function partsConfigStaleWhy(dir: string, binding: JsonObject, manifest: AssemblyManifest | undefined): string | undefined {
  // Legacy parts.json has no assembly_config, where assemblyConfigChanges returns []; keep whole-file sha256 there.
  if (manifest === undefined) return hashStaleWhy(dir, binding);
  const path = String(binding.path);
  const file = regularProjectFile(dir, path);
  if (!file) return `${path} is missing`;
  try { readFileSync(file); } catch { return `${path} is missing`; }
  try {
    const changes = withExternalCheckRead(() => assemblyConfigChanges(file, manifest));
    return changes.length === 0 ? undefined : `${path} assembly config changed (${changes.join(', ')})`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${path} is unreadable (${detail})`;
  }
}

/** The legacy rig dependency of a shape-checked adopted motion or direction entry. */
function requiredAdoptedRigVersion(project: JsonObject, kind: CurrentKind, node: JsonObject): number | undefined {
  const version = isObject(node.adopted) ? node.adopted.version : undefined;
  if (typeof version !== 'number') return undefined;
  if (kind === 'motion') return version;
  if (kind !== 'direction') return undefined;
  const post = asArray(project.versions).filter(isObject).find(row => row.n === version && row.kind === 'post');
  const rigVersion = post?.rig_version;
  if (typeof rigVersion === 'number' && Number.isInteger(rigVersion)) return rigVersion;
}

/** Paths through adopted outputs keep their literal location, even if a later writer replaces the current node. */
function numberedUpstream(path: string): { kind: 'rig' | 'motion'; relative: string } | undefined {
  const motion = /^outputs\/v[1-9]\d*\/idle(?:\/(.+))?$/.exec(path);
  if (motion) return { kind: 'motion', relative: motion[1] ?? '' };
  const rig = /^outputs\/v[1-9]\d*\/out\/((?:rig|check)\/.+)$/.exec(path);
  if (rig) return { kind: 'rig', relative: rig[1]! };
}

function numberedInputStaleWhy(path: string, binding: JsonObject, nodes: Map<CurrentKind, JsonObject>): string | undefined {
  const upstream = numberedUpstream(path);
  const node = upstream && nodes.get(upstream.kind);
  if (!upstream || !node) return undefined;
  const version = adoptedVersion(node);
  const root = version === undefined ? outputRoot(upstream.kind)
    : upstream.kind === 'motion' ? legacyMotionRoot(version) : `outputs/v${version}/out`;
  const files = asArray(node.files) as FileBinding[];
  const hash = upstream.relative ? files.find(file => file.path === `${root}/${upstream.relative}`)?.sha256 : motionSetHash(files, root);
  if (hash !== binding.sha256) return `${path} differs from the active current.${upstream.kind} binding`;
}

/**
 * Check `current`: refusals for a malformed entry, WARN `OUTPUT_STALE` for a stale one (never a refusal, §2.2).
 * A record without `current` (an old-process project) gets nothing from here.
 */
export function currentFindings(dir: string, project: JsonObject, warnings: Finding[], info?: { motionProvenance?: JsonObject }): Finding[] {
  if (project.current === undefined) return [];
  if (!isObject(project.current)) return [malformed('current', 'expected an object of current outputs by kind')];
  const { policy, finding: policyProblem } = readMotionLoopSeamPolicy(dir);
  const refusals: Finding[] = policyProblem ? [policyProblem] : [];
  const nodes = new Map<CurrentKind, JsonObject>();
  for (const [key, node] of Object.entries(project.current)) {
    if (!(CURRENT_KINDS as readonly string[]).includes(key)) { refusals.push(malformed(`current.${key}`, `unknown kind; the kinds are ${CURRENT_KINDS.join(', ')}`)); continue; }
    const shape = currentShapeFindings(key as CurrentKind, node, project);
    refusals.push(...shape);
    if (!shape.length) nodes.set(key as CurrentKind, node as JsonObject);
  }
  const motion = nodes.get('motion');
  if (motion && (info || Object.hasOwn(motion, 'provenance'))) {
    const provenance = verifiedLegacyMotionProvenance(dir, project);
    if (provenance) {
      if (info) info.motionProvenance = provenance;
    } else if (Object.hasOwn(motion, 'provenance')) {
      refusals.push(invalidMotionProvenance('the retained model, frames sidecar or complete adopted motion inventory could not be verified'));
    }
  }
  if (motion && motion.adopted === undefined) {
    const inventory = new Map(asArray(motion.files).filter(isObject).map(file => [String(file.path), String(file.sha256)]));
    const root = outputRoot('motion');
    for (const finding of motionLoopSeamFindings(dir, policy, inventory, root, root)) {
      const needsJudgment = finding.code === 'MOTION_LOOP_SEAM_MISSING' || finding.code === 'MOTION_LOOP_SEAM_UNJUDGED';
      const historicOrUndeclared = policy === undefined || Date.parse(String(motion.at)) < Date.parse(LOOP_SEAM_REPORT_SINCE);
      (needsJudgment && historicOrUndeclared ? warnings : refusals).push(finding);
    }
  }
  const direction = nodes.get('direction');
  if (policy && direction && direction.adopted === undefined) {
    const inventory = new Map(asArray(direction.files).filter(isObject).map(file => [String(file.path), String(file.sha256)]));
    const root = outputRoot('direction');
    for (const finding of directionLoopSeamFindings(dir, policy, inventory, root, direction.report)) {
      const needsJudgment = finding.code === 'DIRECTION_LOOP_SEAM_MISSING' || finding.code === 'DIRECTION_LOOP_SEAM_UNJUDGED';
      const historic = Date.parse(String(direction.at)) < Date.parse(LOOP_SEAM_REPORT_SINCE);
      (needsJudgment && historic ? warnings : refusals).push(finding);
    }
  }
  const rig = nodes.get('rig');
  const rigVersion = isObject(rig?.adopted) ? rig.adopted.version : undefined;
  const adoptedRigDependents = new Set<CurrentKind>();
  // Direct staleness: a replaced rig basis or a changed built_from input.
  const changed = new Map<CurrentKind, string>();
  for (const [kind, node] of nodes) {
    // Partial adoption can leave current.rig absent.
    const requiredRig = rig && requiredAdoptedRigVersion(project, kind, node);
    if (requiredRig !== undefined) {
      if (rigVersion !== requiredRig) {
        const replacement = rigVersion === undefined ? 'canonical' : `adopted from v${String(rigVersion)}`;
        changed.set(kind, `requires upstream rig v${requiredRig} (current.rig is ${replacement})`);
        continue;
      }
      adoptedRigDependents.add(kind);
    }
    const configPath = kind === 'parts' ? partsConfigPath(dir, node) : undefined;
    const manifest = configPath === undefined ? undefined : partsAssemblyManifest(dir, node);
    for (const entry of asArray(node.built_from)) {
      const binding = entry as JsonObject;
      const path = String(binding.path);
      const why = configPath !== undefined && path === configPath
        ? partsConfigStaleWhy(dir, binding, manifest)
        : hashStaleWhy(dir, binding) ?? numberedInputStaleWhy(path, binding, nodes);
      if (why !== undefined) {
        changed.set(kind, why);
        break;
      }
    }
  }
  // Transitive staleness: a bound output path or matching adopted rig is stale upstream.
  const stale = new Map(changed);
  for (let grew = true; grew;) {
    grew = false;
    for (const [kind, node] of nodes) {
      if (stale.has(kind)) continue;
      const upstream = asArray(node.built_from).map(entry => {
        const path = String((entry as JsonObject).path);
        return upstreamKind(path) ?? numberedUpstream(path)?.kind;
      }).find(up => up !== undefined && stale.has(up))
        ?? (adoptedRigDependents.has(kind) && stale.has('rig') ? 'rig' : undefined);
      if (upstream) { stale.set(kind, `upstream ${upstream} is stale`); grew = true; }
    }
  }
  for (const [kind, node] of nodes) {
    if (!isObject(node.rebuild) || node.rebuild.recorded !== false) continue;
    const path = `current.${kind}.rebuild`;
    warnings.push({ code: 'REBUILD_ARGS_UNRECORDED', path,
      message: `${path}: ${String(node.rebuild.note)}; get the unrecorded rebuild arguments from the operator before rebuilding ${outputRoot(kind)}` });
  }
  for (const kind of CURRENT_KINDS) {
    const why = stale.get(kind);
    if (why === undefined) continue;
    warnings.push({ code: 'OUTPUT_STALE', path: `current.${kind}`,
      message: `current.${kind}: stale, ${why}; rebuild it upstream-first and record it with rig-create record ${kind}` });
  }
  return refusals;
}
