import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { asArray, asString, isObject, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { stageIndex, stageOfStep } from './stages.ts';
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
    if (!isObject(raw) || ['stage', 'by', 'at', 'verbatim'].some(k => asString(raw[k]) === null)
      || !Number.isFinite(Date.parse(raw.at as string)) || (raw.source !== undefined && typeof raw.source !== 'string')) {
      push('REOPEN_MALFORMED', path, 'needs stage, by, a valid at, verbatim and optional text source');
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
    const at = Date.parse(raw.at as string);
    if (stageIndex(stage) > reachedIndex(project, at)) {
      push('REOPEN_NOT_PASSED', path, `target ${stage} was not reached at ${String(raw.at)}`);
      continue;
    }
    out.push({ stage, at });
  }
  return out;
}

/** Historical stages and dated builds witness reach even after stage has moved back. */
function reachedIndex(project: JsonObject, at: number): number {
  let reached = stageIndex(asString(project.stage) ?? '');
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

/** Each reopen invalidates its suffix; a later, narrower reopen cannot resurrect an earlier suffix. */
export function reopenTime(reopens: readonly Reopen[], stage: string): number {
  return Math.max(-Infinity, ...reopens.filter(r => stageIndex(r.stage) <= stageIndex(stage)).map(r => r.at));
}

export function liveSignoff(reopens: readonly Reopen[], stage: string, at: number): boolean {
  const since = reopenTime(reopens, stage);
  return since === -Infinity || at > since;
}

export const REOPEN_HELP = `reopen:
  <stage> [<project dir>]  record a human backward move and set project.stage
  --by <who>              human signer (agent is refused)
  --verbatim-file <file>  unchanged UTF-8 words, or - for stdin (default)
  --source <text>         optional origin of the words, separate from verbatim
  --json                  print the reopen record
  The clock supplies at; sign-offs and versions remain history.`;

export function reopenCommand(args: string[]): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (['--by', '--verbatim-file', '--source'].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value === '') refuse('REOPEN_OPTION_INVALID', `reopens: ${arg} needs one non-empty value; supply it once`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `reopens: unsupported ${arg}; see reopen help`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || opts['--by'] === undefined) refuse('REOPEN_OPTION_INVALID', 'reopens: supply a stage, --by and one optional project directory', USAGE_EXIT);
  const { file, project } = readProject(resolve(positional[1] ?? process.cwd()));
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined);
  if (steps.some(s => !isObject(s) || typeof s.id !== 'string' || (s.phase !== 'rig' && s.phase !== 'post'))) {
    refuse('REOPEN_MALFORMED', 'plan.steps: each step needs id and phase; restore the plan before reopening');
  }
  const affected = steps.filter((s): s is JsonObject => isObject(s)
    && stageIndex(stageOfStep(s.phase as 'rig' | 'post', s.id as string)) >= stageIndex(positional[0] as string));
  const entry: JsonObject = { steps_before: affected.map(s => ({ id: s.id as string, ...(s.status === undefined ? {} : { status: s.status }) })), stage: positional[0] as string, by: opts['--by'], at: new Date().toISOString(), verbatim: '' };
  if (opts['--source'] !== undefined) entry.source = opts['--source'];
  const refusals: Finding[] = [];
  // Validate against the original reached stage before moving it backwards.
  const candidate = { ...project, reopens: [...asArray(project.reopens), entry] };
  if (project.reopens !== undefined && !Array.isArray(project.reopens)) collectReopens(project, refusals);
  collectReopens(candidate, refusals);
  const first = refusals[0];
  if (first !== undefined) refuse(first.code, first.message);
  entry.verbatim = readVerbatim(opts['--verbatim-file'] ?? '-');
  for (const step of affected) step.status = 'pending';
  project.reopens = candidate.reopens;
  project.stage = entry.stage;
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `reopen: ${String(entry.stage)} by ${String(entry.by)} at ${String(entry.at)}`, exit: 0 };
}
