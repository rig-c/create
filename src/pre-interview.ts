/** Checked migration history for versions built before the interview (#39). */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
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
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function checkOutputs(ctx: HistoryCtx, version: JsonObject, label: string): void {
  const push = (code: string, path: string, message: string): void => {
    ctx.refusals.push({ code, path, message: `${path}: ${message}` });
  };
  if (!Array.isArray(version.outputs) || version.outputs.length === 0) {
    push('PRE_INTERVIEW_OUTPUT_MALFORMED', `${label}.outputs`, 'a pre-interview version lists its frozen output files with path, sha256 and bytes');
    return;
  }
  const paths = new Set<string>();
  version.outputs.forEach((raw, index) => {
    const path = `${label}.outputs[${index}]`;
    if (!isObject(raw) || typeof raw.path !== 'string' || raw.path.trim() === '' || typeof raw.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(raw.sha256) || typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) {
      push('PRE_INTERVIEW_OUTPUT_MALFORMED', path, 'an output is { path, sha256 (64 lowercase hex digits), bytes (a nonnegative integer) }');
      return;
    }
    const file = resolve(ctx.dir, raw.path);
    if (isAbsolute(raw.path) || !inside(ctx.dir, file) || paths.has(file)) {
      push('PRE_INTERVIEW_OUTPUT_MALFORMED', path, 'each output names a distinct file relative to the project');
      return;
    }
    paths.add(file);
    let bytes: Buffer;
    try {
      if (!inside(realpathSync(ctx.dir), realpathSync(file))) {
        push('PRE_INTERVIEW_OUTPUT_UNREAD', path, 'the output resolves outside the project');
        return;
      }
      bytes = readFileSync(file);
    } catch {
      push('PRE_INTERVIEW_OUTPUT_UNREAD', path, `${raw.path} cannot be read; restore the frozen file before checking the migration`);
      return;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== raw.sha256 || bytes.length !== raw.bytes) {
      push('PRE_INTERVIEW_OUTPUT_CHANGED', path, `${raw.path} has sha256 ${actual} and ${bytes.length} bytes, different from its frozen record`);
    }
  });
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

/** Also used by handoff so unchecked imported history cannot authorize post work. */
export function checkPreInterview(ctx: HistoryCtx): void {
  const legacy = ctx.project['x-pre_create'];
  if (isObject(legacy) && Object.hasOwn(legacy, 'versions') && (!Array.isArray(legacy.versions) || legacy.versions.length > 0)) {
    ctx.refusals.push({ code: 'PRE_INTERVIEW_UNMIGRATED', path: 'x-pre_create.versions', message: 'x-pre_create.versions is unchecked history; move it into versions[] with pre_interview: true and preserved original verdicts (docs/PROJECT.md, Migrating work done before the interview)' });
  }
  const versions = asArray(ctx.project.versions);
  let createSeen = false;
  let previous = 0;
  const hasPreInterview = versions.some((v) => isObject(v) && v.pre_interview === true);
  versions.forEach((v, index) => {
    if (!isObject(v)) return;
    const label = typeof v.n === 'number' ? `versions[v${v.n}]` : `versions[${index}]`;
    if (v.pre_interview !== undefined && typeof v.pre_interview !== 'boolean') {
      ctx.refusals.push({ code: 'VERSION_MALFORMED', path: `${label}.pre_interview`, message: `${label}.pre_interview is a boolean flag` });
    }
    if (hasPreInterview && (typeof v.n !== 'number' || !Number.isSafeInteger(v.n) || v.n <= previous)) {
      ctx.refusals.push({ code: 'PRE_INTERVIEW_ORDER', path: label, message: `${label}: migrated versions have positive, strictly increasing n in record order` });
    }
    if (typeof v.n === 'number') previous = v.n;
    if (v.pre_interview !== true) {
      createSeen = true;
      return;
    }
    if (createSeen) {
      ctx.refusals.push({ code: 'PRE_INTERVIEW_ORDER', path: label, message: `${label}: every pre-interview version comes before the first create-built version` });
    }
    checkOriginals(ctx, v, label);
    checkOutputs(ctx, v, label);
  });
}
