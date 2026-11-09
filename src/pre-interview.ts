/** Checked migration history for versions built before the interview (#39). */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from './check-reads.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { asArray, asString, isObject, type Finding } from './check.ts';
import { REVIEW_ACCEPTS } from './stages.ts';
import type { JsonObject } from './templates.ts';

/** Exact legacy spellings only. An unlisted value requires a documented mapping. */
export const PRE_INTERVIEW_VERDICTS: Readonly<Record<string, string>> = Object.freeze({
  accepted: 'accepted',
  Accepted: 'accepted',
  'accepted (sent to owner)': 'accepted',
  'Accepted (sent to owner)': 'accepted',
  'accepted (HQ-provisional, sent to owner)': 'provisional',
  'accepted-provisional': 'provisional',
  'ok for now, polish wanted': 'accepted',
  'close, polish wanted': 'provisional',
  bounced: 'bounced',
  Bounced: 'bounced',
  provisional: 'provisional',
  Provisional: 'provisional',
});

/** Extra record requirements apply only to pre-interview versions. */
function preInterviewVerdictProblems(d: JsonObject): string[] {
  const problems: string[] = [];
  for (const k of ['by', 'at', 'source']) if (typeof d[k] !== 'string' || d[k].trim() === '') problems.push(`no ${k}`);
  if (typeof d.at === 'string' && !Number.isFinite(Date.parse(d.at))) problems.push('at is not a valid timestamp');
  if (d.verbatim === null) {
    if (typeof d.note !== 'string' || d.note.trim() === '') problems.push('a record of the user needs its note beside verbatim: null');
  } else if (typeof d.verbatim !== 'string' || d.verbatim.trim() === '') problems.push('verbatim is the user words, or null with the record in note');
  return problems;
}

interface HistoryCtx {
  readonly project: JsonObject;
  readonly dir: string;
  readonly refusals: Finding[];
  readonly warnings: Finding[];
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface OutputBinding {
  readonly path: string;
  readonly sha256: string;
}

export interface PreInterviewOutputsInspection {
  readonly refusals: Finding[];
  readonly malformed: Finding[];
  readonly otherRefusals: Finding[];
  readonly bindings: OutputBinding[];
  readonly missing: OutputBinding[];
  readonly readable: string[];
  readonly allMissing: boolean;
}

/** A loss declaration is usable on a pre-interview version with recorded missing bindings disjoint from surviving outputs, or legacy { note, source } beside outputs: []. */
export function validOutputsLoss(version: JsonObject, dir: string): boolean {
  const loss = version.outputs_lost;
  if (version.pre_interview !== true || !isObject(loss)
    || !Object.keys(loss).every((k) => k === 'note' || k === 'source' || k === 'recorded')
    || typeof loss.note !== 'string' || loss.note.trim() === ''
    || typeof loss.source !== 'string' || loss.source.trim() === ''
    || !Array.isArray(version.outputs)) {
    return false;
  }
  if (loss.recorded === undefined) return version.outputs.length === 0;
  if (!Array.isArray(loss.recorded) || loss.recorded.length === 0) return false;
  const outputFiles = new Set<string>();
  for (const out of version.outputs) {
    if (isObject(out) && typeof out.path === 'string' && out.path.trim() !== '') {
      outputFiles.add(resolve(dir, out.path));
    }
  }
  const paths = new Set<string>();
  for (const raw of loss.recorded) {
    if (!isObject(raw) || !Object.keys(raw).every((k) => k === 'path' || k === 'sha256')
      || typeof raw.path !== 'string' || raw.path.trim() === ''
      || typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
      return false;
    }
    const file = resolve(dir, raw.path);
    if (isAbsolute(raw.path) || !inside(dir, file) || paths.has(file) || outputFiles.has(file)) return false;
    paths.add(file);
    try {
      if (!inside(realpathSync(dir), realpathSync(file))) return false;
      readFileSync(file);
      return false;
    } catch {
      // Missing on disk.
    }
  }
  return true;
}

export const OUTPUTS_LOST_MALFORMED_MESSAGE =
  'record { note, source, recorded } with nonempty strings and missing { path, sha256 } bindings disjoint from surviving outputs (or { note, source } beside outputs: []) on a pre-interview version; restore surviving output records otherwise';

/** Shared output validator for check and `version outputs-lost`. */
export function inspectPreInterviewOutputs(dir: string, version: JsonObject, label: string): PreInterviewOutputsInspection {
  const refusals: Finding[] = [];
  const malformed: Finding[] = [];
  const otherRefusals: Finding[] = [];
  const bindings: OutputBinding[] = [];
  const missing: OutputBinding[] = [];
  const readable: string[] = [];
  const push = (target: Finding[], code: string, path: string, message: string): void => {
    const finding = { code, path, message: `${path}: ${message}` };
    refusals.push(finding);
    target.push(finding);
  };
  const hasOutputsLost = Object.hasOwn(version, 'outputs_lost');
  if (hasOutputsLost) {
    if (!validOutputsLoss(version, dir)) {
      push(malformed, 'PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED', `${label}.outputs_lost`, OUTPUTS_LOST_MALFORMED_MESSAGE);
    }
    if (!Array.isArray(version.outputs) || version.outputs.length === 0) {
      return { refusals, malformed, otherRefusals, bindings, missing, readable, allMissing: false };
    }
  } else if (!Array.isArray(version.outputs) || version.outputs.length === 0) {
    push(malformed, 'PRE_INTERVIEW_OUTPUT_MALFORMED', `${label}.outputs`, 'a pre-interview version lists its frozen output files with path, sha256 and bytes');
    return { refusals, malformed, otherRefusals, bindings, missing, readable, allMissing: false };
  }
  const paths = new Set<string>();
  const outcomes: (
    | { kind: 'malformed'; path: string; message: string }
    | { kind: 'outside'; path: string }
    | { kind: 'missing'; path: string; rawPath: string }
    | { kind: 'changed'; path: string; rawPath: string; actual: string; length: number }
    | { kind: 'ok' }
  )[] = [];
  version.outputs.forEach((raw, index) => {
    const path = `${label}.outputs[${index}]`;
    if (!isObject(raw) || typeof raw.path !== 'string' || raw.path.trim() === '' || typeof raw.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(raw.sha256) || typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) {
      outcomes.push({ kind: 'malformed', path, message: 'an output is { path, sha256 (64 lowercase hex digits), bytes (a nonnegative integer) }' });
      return;
    }
    const file = resolve(dir, raw.path);
    if (isAbsolute(raw.path) || !inside(dir, file) || paths.has(file)) {
      outcomes.push({ kind: 'malformed', path, message: 'each output names a distinct file relative to the project' });
      return;
    }
    paths.add(file);
    bindings.push({ path: raw.path, sha256: raw.sha256 });
    let bytes: Buffer;
    try {
      if (!inside(realpathSync(dir), realpathSync(file))) {
        outcomes.push({ kind: 'outside', path });
        return;
      }
      bytes = readFileSync(file);
    } catch {
      missing.push({ path: raw.path, sha256: raw.sha256 });
      outcomes.push({ kind: 'missing', path, rawPath: raw.path });
      return;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== raw.sha256 || bytes.length !== raw.bytes) {
      outcomes.push({ kind: 'changed', path, rawPath: raw.path, actual, length: bytes.length });
      return;
    }
    readable.push(raw.path);
    outcomes.push({ kind: 'ok' });
  });
  const allMissing = version.pre_interview === true && !hasOutputsLost && missing.length === version.outputs.length && readable.length === 0;
  const canRecordLoss = version.pre_interview === true
    && !hasOutputsLost
    && missing.length > 0
    && outcomes.every((o) => o.kind === 'missing' || o.kind === 'ok');
  const lostRemedy = canRecordLoss && typeof version.n === 'number'
    ? `; if this pre-interview version's frozen outputs did not survive, record the loss with rig-create version outputs-lost ${String(version.n)} --note <text> --source <text>`
    : '';
  for (const outcome of outcomes) {
    if (outcome.kind === 'malformed') {
      push(malformed, 'PRE_INTERVIEW_OUTPUT_MALFORMED', outcome.path, outcome.message);
    } else if (outcome.kind === 'outside') {
      push(otherRefusals, 'PRE_INTERVIEW_OUTPUT_UNREAD', outcome.path, 'the output resolves outside the project');
    } else if (outcome.kind === 'missing') {
      refusals.push({
        code: 'PRE_INTERVIEW_OUTPUT_UNREAD',
        path: outcome.path,
        message: `${outcome.path}: ${outcome.rawPath} cannot be read; restore the frozen file before checking the migration${lostRemedy}`,
      });
    } else if (outcome.kind === 'changed') {
      push(otherRefusals, 'PRE_INTERVIEW_OUTPUT_CHANGED', outcome.path, `${outcome.rawPath} has sha256 ${outcome.actual} and ${outcome.length} bytes, different from its frozen record`);
    }
  }
  return { refusals, malformed, otherRefusals, bindings, missing, readable, allMissing };
}

function checkOutputs(ctx: HistoryCtx, version: JsonObject, label: string): void {
  ctx.refusals.push(...inspectPreInterviewOutputs(ctx.dir, version, label).refusals);
}

function checkOriginals(ctx: HistoryCtx, version: JsonObject, label: string): void {
  const push = (code: string, path: string, message: string): void => {
    ctx.refusals.push({ code, path, message: `${path}: ${message}` });
  };
  if (!Array.isArray(version.original_verdicts)) {
    push('PRE_INTERVIEW_HISTORY_MISSING', `${label}.original_verdicts`, 'keep the complete original verdicts array, unchanged and in order');
    return;
  }
  if (!Array.isArray(version.verdicts)) {
    push('VERDICT_MALFORMED', `${label}.verdicts`, 'verdicts is a list of verdicts in create shape');
  }
  const originals = version.original_verdicts;
  const verdicts = asArray(version.verdicts);
  verdicts.forEach((d, index) => {
    const path = `${label}.verdicts[${index}]`;
    const problems = isObject(d) ? preInterviewVerdictProblems(d) : ['a verdict is an object'];
    if (isObject(d)) {
      if (!['accepted', 'bounced', 'provisional'].includes(d.verdict as string)) problems.push('verdict is accepted, bounced or provisional');
      if (typeof d.review !== 'string' || !Object.hasOwn(REVIEW_ACCEPTS, d.review)) problems.push('review is rig-review or direction-review');
      if (!Array.isArray(d.on_items)) problems.push('on_items is a list');
    }
    if (problems.length > 0) push('VERDICT_MALFORMED', path, problems.join(', '));
  });
  originals.forEach((original, index) => {
    const path = `${label}.verdicts[${index}]`;
    const converted = verdicts[index];
    if (!isObject(converted) || !isDeepStrictEqual(converted.as_recorded, original)) {
      push('PRE_INTERVIEW_VERDICT_LOST', path, `as_recorded must preserve original_verdicts[${index}] unchanged, at the same index`);
    }
    const value = isObject(original) ? asString(original.verdict) : null;
    if (value === null || !Object.hasOwn(PRE_INTERVIEW_VERDICTS, value)) {
      push('PRE_INTERVIEW_VERDICT_UNKNOWN', `${label}.original_verdicts[${index}]`, `original verdict ${JSON.stringify(value)} has no mapping in PRE_INTERVIEW_VERDICTS; do not infer an acceptance`);
    } else if (isObject(converted) && converted.verdict !== PRE_INTERVIEW_VERDICTS[value]) {
      push('PRE_INTERVIEW_VERDICT_MISMATCH', `${path}.verdict`, `${JSON.stringify(value)} maps to ${PRE_INTERVIEW_VERDICTS[value]}, got ${JSON.stringify(converted.verdict ?? null)}`);
    }
  });
  verdicts.slice(originals.length).forEach((verdict, index) => {
    if (isObject(verdict) && Object.hasOwn(verdict, 'as_recorded')) {
      push('PRE_INTERVIEW_VERDICT_LOST', `${label}.verdicts[${originals.length + index}]`, 'as_recorded has no corresponding original verdict; new reviews are appended without as_recorded');
    }
  });
}

/** A loss declaration is usable only when the historical config is absent. */
export function validConfigLoss(version: JsonObject): boolean {
  const loss = version.config_lost;
  const provenance = isObject(version.provenance) ? version.provenance : {};
  return version.pre_interview === true && isObject(loss)
    && typeof loss.note === 'string' && loss.note.trim() !== ''
    && typeof loss.source === 'string' && loss.source.trim() !== ''
    && provenance.config == null;
}

/** Also used by handoff so unchecked imported history cannot authorize post work. */
export function checkPreInterview(ctx: HistoryCtx): void {
  const legacy = ctx.project['x-pre_create'];
  if (isObject(legacy) && Object.hasOwn(legacy, 'versions') && (!Array.isArray(legacy.versions) || legacy.versions.length > 0)) {
    ctx.warnings.push({ code: 'PRE_INTERVIEW_UNMIGRATED', path: 'x-pre_create.versions', message: 'x-pre_create.versions awaits migration. Follow docs/PROJECT.md, Migrating work done before the interview, steps 1–6: preserve original verdicts and frozen outputs, move historical versions first into versions[] with pre_interview: true, normalize verdicts with sources, verify outputs, connect answers_feedback, then run interview --check and handoff' });
  }
  const versions = asArray(ctx.project.versions);
  const originalIds = new Set<string | number>();
  let createSeen = false;
  let previous = 0;
  const hasPreInterview = versions.some((v) => isObject(v) && v.pre_interview === true);
  versions.forEach((v, index) => {
    if (!isObject(v)) return;
    const label = typeof v.n === 'number' ? `versions[v${v.n}]` : `versions[${index}]`;
    if (Object.hasOwn(v, 'config_lost') && !validConfigLoss(v)) {
      ctx.refusals.push({ code: 'PRE_INTERVIEW_CONFIG_LOST_MALFORMED', path: `${label}.config_lost`, message: `${label}.config_lost: record { note, source } with nonempty strings only on a pre-interview version without provenance.config; restore a surviving config instead` });
    }
    if (v.pre_interview !== undefined && typeof v.pre_interview !== 'boolean') {
      ctx.refusals.push({ code: 'VERSION_MALFORMED', path: `${label}.pre_interview`, message: `${label}.pre_interview is a boolean flag` });
    }
    if (hasPreInterview && (typeof v.n !== 'number' || !Number.isSafeInteger(v.n) || v.n <= previous)) {
      ctx.refusals.push({ code: 'PRE_INTERVIEW_ORDER', path: label, message: `${label}: migrated versions have positive, strictly increasing n in record order` });
    }
    if (typeof v.n === 'number') previous = v.n;
    if (v.pre_interview !== true) {
      if (Object.hasOwn(v, 'outputs_lost')) {
        ctx.refusals.push({ code: 'PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED', path: `${label}.outputs_lost`, message: `${label}.outputs_lost: ${OUTPUTS_LOST_MALFORMED_MESSAGE}` });
      }
      createSeen = true;
      return;
    }
    if (createSeen) {
      ctx.refusals.push({ code: 'PRE_INTERVIEW_ORDER', path: label, message: `${label}: every pre-interview version comes before the first create-built version` });
    }
    if (!Object.hasOwn(v, 'original_n') || (v.original_n !== null && typeof v.original_n !== 'number' && typeof v.original_n !== 'string')) {
      ctx.refusals.push({ code: 'PRE_INTERVIEW_ORIGINAL_N_MISSING', path: `${label}.original_n`, message: `${label}.original_n: copy the source version id unchanged as a number, string or null` });
    } else if (v.original_n !== null) {
      if (originalIds.has(v.original_n)) {
        ctx.refusals.push({ code: 'PRE_INTERVIEW_ORIGINAL_N_DUPLICATE', path: `${label}.original_n`, message: `${label}.original_n: two migrated versions share the same non-null source id; restore their distinct original ids` });
      }
      originalIds.add(v.original_n);
    }
    checkOriginals(ctx, v, label);
    checkOutputs(ctx, v, label);
  });
}
