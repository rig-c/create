import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';

import { asArray, asString, collectSignoffs, isObject, type Finding } from './check.ts';
import { collectAmendments } from './amend.ts';
import { readProject } from './feedback.ts';
import { jobHash } from './job-outbox.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { assertActSubjectDeclared, decodeReviewAct, fetchReviewActBytes, reviewActFindings, reviewActTransport, type ReviewActTransport, type ReopenAct } from './review-act.ts';
import { stepHash } from './step-hash.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { newRefusals } from './refusal-baseline.ts';
import { stageIndex, stageOfStep, STAGE_VALUES } from './stages.ts';
import type { JsonObject } from './templates.ts';

export interface Reopen {
  readonly stage: string;
  readonly at: number;
}

/** Validate history before using it as authority. Invalid entries supersede nothing. */
export function collectReopens(project: JsonObject, refusals: Finding[]): Reopen[] {
  const out: Reopen[] = [];
  const push = (code: string, path: string, why: string): void => {
    refusals.push({ code, path, message: `${path}: ${why}; record a human reopen to a previously reached stage` });
  };
  if (project.reopens !== undefined && !Array.isArray(project.reopens)) {
    push('REOPEN_MALFORMED', 'reopens', 'must be a list');
    return out;
  }
  for (const [index, raw] of asArray(project.reopens).entries()) {
    const path = `reopens[${index}]`;
    if (!isObject(raw) || ['stage', 'from_stage', 'by', 'at', 'verbatim'].some(k => asString(raw[k]) === null)
      || !Number.isFinite(Date.parse(raw.at as string)) || (raw.source !== undefined && typeof raw.source !== 'string')) {
      push('REOPEN_MALFORMED', path, 'needs stage, from_stage, by, a valid at, verbatim and optional text source');
      continue;
    }
    if ((raw.by as string).toLowerCase() === 'agent') {
      push('SIGNOFF_NOT_HUMAN', path, 'signed by agent');
      continue;
    }
    if (!Array.isArray(raw.steps_before) || raw.steps_before.some(s => !isObject(s) || typeof s.id !== 'string'
      || (s.status !== undefined && (typeof s.status !== 'string' || !['pending', 'in-progress', 'at-checkpoint', 'done'].includes(s.status))))) {
      push('REOPEN_MALFORMED', path, 'steps_before must snapshot step ids and original statuses');
      continue;
    }
    const stage = raw.stage as string;
    if (stageIndex(stage) < 0 || stage === 'accepted') {
      push('REOPEN_STAGE_UNKNOWN', path, `target ${stage} is not a reopenable stage`);
      continue;
    }
    const fromStage = raw.from_stage as string;
    if (!STAGE_VALUES.includes(fromStage)) {
      push('REOPEN_MALFORMED', `${path}.from_stage`, 'must be a known project stage');
      continue;
    }
    const at = Date.parse(raw.at as string);
    if (stageIndex(stage) > reachedIndex(project, at, fromStage)) {
      push('REOPEN_NOT_PASSED', path, `target ${stage} was not reached at ${String(raw.at)}`);
      continue;
    }
    out.push({ stage, at });
  }
  return [...out, ...collectAmendments(project, refusals)];
}

/** Historical stages and dated builds witness reach even after stage has moved back. */
function reachedIndex(project: JsonObject, at: number, fromStage: string): number {
  let reached = stageIndex(fromStage);
  for (const raw of asArray(project.signoffs)) {
    if (!isObject(raw) || typeof raw.by !== 'string' || raw.by.toLowerCase() === 'agent'
      || typeof raw.verbatim !== 'string' || typeof raw.at !== 'string' || !(Date.parse(raw.at) <= at)) continue;
    reached = Math.max(reached, stageIndex(asString(raw.stage) ?? ''));
  }
  for (const raw of asArray(project.versions)) {
    if (!isObject(raw) || typeof raw.at !== 'string' || !(Date.parse(raw.at) <= at)) continue;
    if (raw.kind === 'rig') reached = Math.max(reached, stageIndex('rigging'));
    if (raw.kind === 'post') reached = Math.max(reached, stageIndex('post'));
  }
  return reached;
}

/** The same reach rule the writer validates, exposed as Review's reopen subjects. */
export function reopenableStages(project: JsonObject, at: number): string[] {
  const fromStage = asString(project.stage) ?? '';
  if (!STAGE_VALUES.includes(fromStage)) return [];
  const reached = reachedIndex(project, at, fromStage);
  return STAGE_VALUES.filter(stage => stage !== 'accepted' && stageIndex(stage) >= 0 && stageIndex(stage) <= reached);
}

/** An acceptance remains authoring authority until an explicit reopen supersedes it. */
export function directionReviewClosed(project: JsonObject): boolean {
  const reopens = collectReopens(project, []);
  return collectSignoffs(project, []).some(signoff => signoff.stage === 'direction-review'
    && signoff.checkpoint === null && liveSignoff(reopens, signoff.stage, signoff.at))
    || asArray(project.versions).filter(isObject).some(version => version.kind === 'post'
      && asArray(version.verdicts).filter(isObject).some(verdict => verdict.review === 'direction-review'
        && verdict.verdict === 'accepted' && liveSignoff(reopens, 'direction-review', Date.parse(String(verdict.at)))));
}

/** Each reopen invalidates its suffix; a later, narrower reopen cannot resurrect an earlier suffix. */
export function reopenTime(reopens: readonly Reopen[], stage: string): number {
  return Math.max(-Infinity, ...reopens.filter(r => stageIndex(r.stage) <= stageIndex(stage)).map(r => r.at));
}

/** The `reopens[]` index of a validated reopen, matched by its stage and time. */
export function reopenIndex(project: JsonObject, reopen: Reopen): number {
  return asArray(project.reopens).findIndex(r => isObject(r) && r.stage === reopen.stage && Date.parse(asString(r.at) ?? '') === reopen.at);
}

export function liveSignoff(reopens: readonly Reopen[], stage: string, at: number): boolean {
  const since = reopenTime(reopens, stage);
  return since === -Infinity || at > since;
}

export const REOPEN_HELP = `reopen:
  <stage> [<project dir>]  record a human backward move and set project.stage
  --from-review <actId>   ingest the exported Review reopen (excludes --by, --verbatim-file and --source)
  --by <who>              human signer (agent is refused)
  --verbatim-file <file>  unchanged UTF-8 words; relative to the current working directory, not the project; or - for stdin (default)
  --source <text>         optional origin of the words, separate from verbatim
  --json                  print the reopen record
  The clock supplies at; sign-offs and versions remain history.`;

export function reopenCommand(args: string[], now: number, hooks: { fetch?: (transport: ReviewActTransport) => { bytes: string } } = {}): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (['--by', '--verbatim-file', '--source', '--from-review'].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value === '') refuse('REOPEN_OPTION_INVALID', `reopens: ${arg} needs one non-empty value; supply it once`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `reopens: unsupported ${arg}; see reopen help`, USAGE_EXIT);
    else positional.push(arg);
  }
  const actId = opts['--from-review'];
  if (positional.length < 1 || positional.length > 2 || actId === undefined && opts['--by'] === undefined) refuse('REOPEN_OPTION_INVALID', 'reopens: supply a stage, --by or --from-review, and one optional project directory', USAGE_EXIT);
  if (actId !== undefined && ['--by', '--verbatim-file', '--source'].some(flag => opts[flag] !== undefined)) {
    refuse('REOPEN_OPTION_INVALID', 'project.json.reopens: --from-review excludes --by, --verbatim-file and --source; use the exported human values', USAGE_EXIT);
  }
  const dir = resolve(positional[1] ?? process.cwd());
  const release = actId === undefined ? () => {} : acquireBoundJobWrite(dir);
  try { return recordReopen(dir, positional[0]!, opts, json, now, hooks); }
  finally { release(); }
}

function recordReopen(dir: string, stage: string, opts: Record<string, string>, json: boolean, now: number,
  hooks: { fetch?: (transport: ReviewActTransport) => { bytes: string } }): { stdout: string; exit: number } {
  const { file, project } = readProject(dir);
  const original = readFileSync(file);
  let review: { act: ReopenAct; bytes: string } | undefined;
  const result = (entry: JsonObject): { stdout: string; exit: number } => ({ stdout: json ? JSON.stringify(entry, null, 2) : `reopen: ${String(entry.stage)} by ${String(entry.by)} at ${String(entry.at)}`, exit: 0 });
  const actId = opts['--from-review'];
  if (actId !== undefined) {
    const invalid = reviewActFindings(project)[0];
    if (invalid) refuse(invalid.code, invalid.message);
    const transport: ReviewActTransport = { ...reviewActTransport(dir, actId), kind: 'reopen' };
    const bytes = hooks.fetch ? hooks.fetch(transport).bytes : fetchReviewActBytes(transport);
    const act = decodeReviewAct(bytes, 'reopen');
    if (act.jobId !== transport.jobId || act.actId !== actId || Date.parse(act.at) > now) {
      refuse('REVIEW_ACT_INVALID', 'project.json.reopens: fetched act identity or date differs from the request; request the correct reopen act');
    }
    if (act.value.stage !== stage) refuse('REVIEW_ACT_KIND_MISMATCH', `project.json.reopens: act reopens ${act.value.stage}, not ${stage}; invoke reopen for the exported stage`);
    const existing = asArray(project.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === actId);
    if (existing) {
      if (existing.kind !== 'reopen' || existing.bytes !== bytes) refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: immutable reopen act changed; restore the original receipt');
      return result(asArray(project.reopens)[Number(existing.reopen)] as JsonObject);
    }
    if (act.source.projectHash !== jobHash(original) || !isDeepStrictEqual(act.source.plan.steps,
      asArray(isObject(project.plan) ? project.plan.steps : undefined).map(raw => ({ id: isObject(raw) ? raw.id : null, hash: isObject(raw) ? stepHash(raw) : null })))) {
      refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.reopens: displayed record or plan changed; request a reopen on the current record');
    }
    assertActSubjectDeclared(dir, act, 'project.json.reopens');
    review = { act, bytes };
  }
  const before = structuredClone(project);
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined);
  if (steps.some(s => !isObject(s) || typeof s.id !== 'string' || (s.phase !== 'rig' && s.phase !== 'post'))) {
    refuse('REOPEN_MALFORMED', 'plan.steps: each step needs id and phase; restore the plan before reopening');
  }
  const affected = steps.filter((s): s is JsonObject => isObject(s)
    && stageIndex(stageOfStep(s.phase as 'rig' | 'post', s.id as string)) >= stageIndex(stage));
  const entry: JsonObject = { from_stage: project.stage ?? null, steps_before: affected.map(s => ({ id: s.id as string, ...(s.status === undefined ? {} : { status: s.status }) })), stage, by: review?.act.authority.reviewer.id ?? opts['--by']!, at: review?.act.at ?? new Date(now).toISOString(), verbatim: '' };
  if (review) entry.source = `review act ${review.act.jobId}/${review.act.actId}`;
  else if (opts['--source'] !== undefined) entry.source = opts['--source'];
  const refusals: Finding[] = [];
  // Validate against the original reached stage before moving it backwards.
  const candidate = { ...project, reopens: [...asArray(project.reopens), entry] };
  if (project.reopens !== undefined && !Array.isArray(project.reopens)) collectReopens(project, refusals);
  collectReopens(candidate, refusals);
  const first = refusals[0];
  if (first !== undefined) refuse(first.code, first.message);
  entry.verbatim = review ? review.act.value.words : readVerbatim(opts['--verbatim-file'] ?? '-');
  for (const step of affected) step.status = 'pending';
  project.reopens = candidate.reopens;
  project.stage = entry.stage;
  if (review) {
    project.review_acts = [...asArray(project.review_acts), { schema: 'rig-create/review-act@1', kind: 'reopen',
      jobId: review.act.jobId, actId: review.act.actId, reopen: asArray(project.reopens).length - 1,
      bytes: review.bytes, sha256: jobHash(review.bytes), version_hash: jobHash(JSON.stringify(entry)) }];
    const invalid = reviewActFindings(project)[0];
    if (invalid) refuse(invalid.code, invalid.message);
  }
  const rejected = newRefusals(dir, before, project, { now })[0];
  if (rejected !== undefined) refuse(rejected.code, rejected.message);
  if (review && !readFileSync(file).equals(original)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.reopens: record changed during fetch; retry on the current record');
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return result(entry);
}
