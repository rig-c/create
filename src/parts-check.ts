/**
 * The parts-stage check report that a `parts` → `parts-review` move binds
 * (docs/PROJECT.md § Recording forward progress, docs/CHECKS.md § Parts-stage check at the parts → parts-review move).
 *
 * The report is `@rig-c/parts`' `rig-parts check-parts` output, spec `rig-parts-parts-check/1`.
 * create reads it bound by the sha256 of its bytes and by its spec, copies `exit_code`, `holes` and
 * `reported` from it, and never runs or recomputes it. Matching the report to the parts on disk hashes
 * the files under the assembled root and compares them with the report's own `inputs` rows; that is a
 * binding, not a measurement. The writer and the check share `partsCheckFindings`.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, isObject, type Ctx, type Finding } from './check.ts';
import { sha256 } from './choices.ts';
import { IGNORED_DIRS } from './init.ts';
import type { Json, JsonObject } from './templates.ts';

export const PARTS_CHECK_SPEC = 'rig-parts-parts-check/1';

/** Dates the parts-check requirement by the advance's own `at`. */
export const PARTS_CHECK_SINCE = '2026-11-08T00:00:00Z';

const REPORT_KEYS = ['spec', 'stage', 'inputs', 'parts', 'refusals', 'reported', 'holes', 'exit_code'];
const RECORD_KEYS = ['path', 'sha256', 'spec', 'parts', 'exit_code', 'holes', 'reported'];
const ROW_KEYS: Record<string, readonly string[]> = {
  inputs: ['path', 'status', 'sha256'],
  refusals: ['code', 'object', 'found', 'required', 'detail'],
  reported: ['code', 'set', 'part', 'source', 'count', 'spans'],
  holes: ['code', 'object', 'reason', 'line'],
};
const STATUSES = ['read', 'missing', 'unreadable', 'absent'];
/** The roots a clone does not carry, as the path is written; a link inside the project is followed as for the parts verdict. */
const IGNORED: readonly string[] = [...IGNORED_DIRS, 'node_modules', '.git'];
const RUN = 'run rig-parts check-parts --parts <assembled dir> --out <dir outside it>, retain parts-check.json under the project (for example evidence/) and advance with --parts-check <report> --parts <assembled dir>';

/** The move whose arrival needs a passing parts-stage check. */
export function isPartsCheckMove(entry: JsonObject): boolean {
  return entry.from_stage === 'parts' && entry.stage === 'parts-review';
}

const literal = (value: Json | undefined): value is string => typeof value === 'string' && value !== ''
  && !isAbsolute(value) && !value.includes('\\') && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
const code = (value: Json | undefined): boolean => typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value);
const finding = (code: string, path: string, why: string, remedy: string): Finding => ({ code, path, message: `${path}: ${why}; ${remedy}` });

/** Read the retained report bytes at a project-relative path, the way both the writer and the check do. */
export function readPartsCheckBytes(dir: string, path: Json | undefined, at: string): Buffer | Finding {
  const unread = (why: string): Finding => finding('PARTS_CHECK_UNREAD', at, why, RUN);
  if (!literal(path)) return unread('the report needs a literal project-relative path');
  // Contained as the parts verdict is: as written, and with every link on its way followed.
  let file: string;
  try {
    const root = realpathSync(dir);
    file = realpathSync(resolve(dir, path));
    const rel = relative(root, file);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return unread(`${path} leaves the project through a link`);
    if (!statSync(file).isFile()) return unread(`${path} is not a regular file`);
  } catch { return unread(`${path} is not there`); }
  if (IGNORED.includes(path.split('/')[0]!)) return unread(`${path} is under an ignored root and would not survive a clone`);
  try {
    return readFileSync(file);
  } catch (error) {
    return unread(`${path} cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }
}

function parseReport(bytes: Buffer): JsonObject | null {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Json;
    return isObject(value) ? value : null;
  } catch { return null; }
}

/** Shape of `rig-parts-parts-check/1` as STABILITY.md states it; no field is recomputed. */
function reportShape(report: JsonObject): string | null {
  if (report.spec !== PARTS_CHECK_SPEC) return `spec is ${JSON.stringify(report.spec ?? null)}, not ${PARTS_CHECK_SPEC}`;
  if (report.stage !== 'parts') return `stage is ${JSON.stringify(report.stage ?? null)}, not parts`;
  if (Object.keys(report).join(',') !== REPORT_KEYS.join(',')) return `top-level keys must be ${REPORT_KEYS.join(', ')} in that order`;
  if (!isObject(report.parts)) return 'parts must be an object';
  if (!Number.isSafeInteger(report.exit_code)) return 'exit_code must be an integer';
  for (const [key, keys] of Object.entries(ROW_KEYS)) {
    const rows = report[key];
    if (!Array.isArray(rows)) return `${key} must be a list`;
    for (const [index, row] of rows.entries()) {
      if (!isObject(row) || Object.keys(row).join(',') !== keys.join(',')) return `${key}[${index}] must have ${keys.join(', ')}`;
      if (key !== 'inputs' && !code(row.code)) return `${key}[${index}].code must be a SCREAMING_SNAKE_CASE code`;
    }
  }
  const paths = new Set<string>();
  for (const [index, row] of (report.inputs as JsonObject[]).entries()) {
    if (!literal(row.path) || paths.has(row.path)) return `inputs[${index}].path must be a unique relative POSIX path`;
    paths.add(row.path);
    if (!STATUSES.includes(String(row.status))) return `inputs[${index}].status must be ${STATUSES.join(', ')}`;
    if (row.status === 'read' ? !(typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256)) : row.sha256 !== null) {
      return `inputs[${index}].sha256 must be a sha256 for a read file and null otherwise`;
    }
  }
  for (const [index, row] of (report.holes as JsonObject[]).entries()) {
    if (['object', 'reason', 'line'].some(key => typeof row[key] !== 'string')) return `holes[${index}] needs text object, reason and line`;
  }
  return null;
}

/** Every regular file under the root, by relative POSIX path, hashed; a symlink or special file is named. */
function inventory(root: string): { files: Map<string, string>; other: string[] } {
  const files = new Map<string, string>();
  const other: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const stat = lstatSync(join(abs, entry.name));
      if (stat.isDirectory()) walk(join(abs, entry.name), path);
      else if (stat.isFile()) files.set(path, sha256(readFileSync(join(abs, entry.name))));
      else other.push(path);
    }
  };
  walk(root, '');
  return { files, other };
}

/** Why the report no longer matches the assembled parts on disk, or null when it does. */
function staleness(dir: string, partsRoot: string, inputs: JsonObject[]): string[] | null {
  let root: string;
  try {
    root = resolve(realpathSync(dir), partsRoot);
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [`${partsRoot} is not a directory`];
  } catch { return [`${partsRoot} is not a directory`]; }
  const { files, other } = inventory(root);
  const reasons = other.map(path => `${path} is not a regular file`);
  const named = new Set<string>();
  for (const row of inputs) {
    const path = String(row.path);
    named.add(path);
    const now = files.get(path);
    if (row.status === 'read') {
      if (now === undefined) reasons.push(`${path} is gone`);
      else if (now !== row.sha256) reasons.push(`${path} changed after the check`);
    } else if (row.status === 'absent') {
      if (now !== undefined) reasons.push(`${path} was absent at the check and exists now`);
    } else reasons.push(`${path} was ${String(row.status)} at the check`);
  }
  for (const path of files.keys()) if (!named.has(path)) reasons.push(`${path} is not in the report's inputs`);
  return reasons.length === 0 ? null : reasons;
}

/**
 * Validate one recorded `parts_check`. Always: the closed shape, the retained bytes hashing to `sha256`,
 * the report's spec and shape, the copied fields, and a passing report. At the move only: the report
 * matches the parts under `parts` on disk now. The first failing rule is the finding.
 */
export function partsCheckFindings(dir: string, record: Json | undefined, path: string, atMove: boolean): Finding[] {
  const invalid = (why: string): Finding[] => [finding('PARTS_CHECK_INVALID', path, why, `record the report through advance; ${RUN}`)];
  if (!isObject(record) || Object.keys(record).length !== RECORD_KEYS.length || !RECORD_KEYS.every(key => key in record)) {
    return invalid(`must have exactly ${RECORD_KEYS.join(', ')}`);
  }
  if (!literal(record.parts)) return invalid('parts must be the literal project-relative assembled root');
  if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) return invalid('sha256 must be the report bytes\' sha256');
  const bytes = readPartsCheckBytes(dir, record.path, `${path}.path`);
  if (!Buffer.isBuffer(bytes)) return [bytes];
  if (sha256(bytes) !== record.sha256) {
    return [finding('PARTS_CHECK_CHANGED', `${path}.sha256`, `${String(record.path)} no longer hashes to the recorded sha256`, 'restore the retained report bytes the move recorded; a new check is recorded by a new parts → parts-review move')];
  }
  const report = parseReport(bytes);
  if (report === null) return [finding('PARTS_CHECK_UNREAD', `${path}.path`, `${String(record.path)} is not a JSON object`, RUN)];
  const shape = reportShape(report);
  if (shape !== null) return invalid(`${String(record.path)}: ${shape}`);
  if (record.spec !== report.spec || record.exit_code !== report.exit_code || !isDeepStrictEqual(record.holes, report.holes) || !isDeepStrictEqual(record.reported, report.reported)) {
    return invalid('spec, exit_code, holes and reported must be copied verbatim from the retained report');
  }
  const refusals = asArray(report.refusals).filter(isObject);
  if (report.exit_code !== 0 || refusals.length > 0) {
    const codes = refusals.map(row => String(row.code));
    return [finding('PARTS_CHECK_FAILED', path, `the report records exit_code ${String(report.exit_code)}${codes.length === 0 ? '' : ` and refusals ${codes.join(', ')}`}`, 'fix the refused parts, rerun rig-parts check-parts and advance with the passing report')];
  }
  if (atMove) {
    const reasons = staleness(dir, record.parts, report.inputs as JsonObject[]);
    if (reasons !== null) {
      const shown = reasons.slice(0, 3).join('; ') + (reasons.length > 3 ? `; and ${reasons.length - 3} more` : '');
      return [finding('PARTS_CHECK_STALE', path, `the report does not match the parts under ${record.parts}: ${shown}`, 'rerun rig-parts check-parts on the assembled parts as they are now and advance with that report')];
    }
  }
  return [];
}

/** The writer's copy of the report: path and sha256 of its bytes, and spec, exit_code, holes and reported as written. */
export function partsCheckRecord(dir: string, reportPath: string, partsRoot: string, path: string): { record: JsonObject } | { refusal: Finding } {
  const bytes = readPartsCheckBytes(dir, reportPath, `${path}.path`);
  if (!Buffer.isBuffer(bytes)) return { refusal: bytes };
  const report = parseReport(bytes);
  if (report === null) return { refusal: finding('PARTS_CHECK_UNREAD', `${path}.path`, `${reportPath} is not a JSON object`, RUN) };
  const copy = (value: Json | undefined): Json => value === undefined ? null : structuredClone(value);
  return { record: { path: reportPath, sha256: sha256(bytes), spec: copy(report.spec), parts: partsRoot,
    exit_code: copy(report.exit_code), holes: copy(report.holes), reported: copy(report.reported) } };
}

/**
 * Each `parts` → `parts-review` advance binds a passing report. Missing on a move dated from
 * `PARTS_CHECK_SINCE`, or on the move being written, is refused; on an earlier move it WARNs.
 * A `parts_check` on any other move is refused. Staleness is judged only for the move being written.
 */
export function checkPartsChecks(ctx: Ctx, forwardWrite = false): void {
  const advances = asArray(ctx.project.advances);
  const since = Date.parse(PARTS_CHECK_SINCE);
  for (const [index, entry] of advances.entries()) {
    if (!isObject(entry)) continue;
    const path = `advances[${index}].parts_check`;
    const atMove = forwardWrite && index === advances.length - 1;
    if (entry.parts_check === undefined) {
      if (!isPartsCheckMove(entry)) continue;
      if (atMove || !(Date.parse(String(entry.at)) < since)) {
        ctx.refusals.push(finding('PARTS_CHECK_MISSING', path, 'a parts → parts-review move needs a passing parts-stage check report', RUN));
      } else {
        ctx.warnings.push(finding('PARTS_CHECK_MISSING', path, `the move predates ${PARTS_CHECK_SINCE} and binds no parts-stage check report`, 'preserve the historical move; the next parts → parts-review move binds a report'));
      }
      continue;
    }
    if (!isPartsCheckMove(entry)) {
      ctx.refusals.push(finding('PARTS_CHECK_INVALID', path, 'a parts-stage check report is recorded only on a parts → parts-review move', 'restore the move as advance wrote it'));
      continue;
    }
    ctx.refusals.push(...partsCheckFindings(ctx.dir, entry.parts_check, path, atMove));
  }
}

/** One named line per HOLE and per reported row, for the advance output. */
export function partsCheckLines(record: JsonObject, path: string): string[] {
  const holes = asArray(record.holes).filter(isObject);
  const reported = asArray(record.reported).filter(isObject);
  return [
    `  parts check ${String(record.path)}: exit_code ${String(record.exit_code)}, ${holes.length} HOLE, ${reported.length} reported; a HOLE is not a pass`,
    ...holes.map((row, index) => `  ${String(row.line)} (${path}.holes[${index}])`),
    ...reported.map((row, index) => `  REPORTED ${String(row.code)}: part ${String(row.part)}, source ${String(row.source)}, count ${String(row.count)} (${path}.reported[${index}])`),
  ];
}
