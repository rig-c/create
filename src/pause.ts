import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { asArray, checkProject, collectSignoffs, isObject } from './check.ts';
import { readProject } from './feedback.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { signoffIdentity } from './stage-progress.ts';
import { PAUSED_STAGE, stageIndex } from './stages.ts';
import type { JsonObject } from './templates.ts';

export const PAUSE_HELP = `pause:
  [<project dir>] --by <who> [--verbatim-file <file>] [--source <text>]
  Set stage to paused and append pauses[] { from_stage, stage, by, at, verbatim, signoff }.
  Needs a human { "stage": "paused" } sign-off dated after the latest recorded move.
resume:
  <stage> [<project dir>] --by <who> [--verbatim-file <file>] [--source <text>]
  Return to the stage the project was paused from and append pauses[]; any other stage is refused.
Both accept --json, take at from the clock and validate the complete candidate before writing.`;

/** A stage a project may be paused from: in the order, before the terminal `accepted`. */
export function pausable(stage: string): boolean {
  return stageIndex(stage) >= 0 && stage !== 'accepted';
}

const time = (value: unknown): number => Date.parse(String(value));

/**
 * The latest recorded stage event: a stage-changing advance or reopen, as check reads them,
 * or a pauses[] entry. On a tie the pause entry is later, since it is written after the move it follows.
 */
function latestEvent(project: JsonObject): { at: number; stage: string; from: string } | undefined {
  const moves = [...asArray(project.advances), ...asArray(project.reopens)].filter(isObject)
    .filter(m => typeof m.stage === 'string' && m.from_stage !== m.stage && Number.isFinite(time(m.at)))
    .map(m => ({ at: time(m.at), stage: String(m.stage), from: String(m.from_stage), pause: false }));
  const pauses = asArray(project.pauses).filter(isObject).filter(e => typeof e.stage === 'string' && Number.isFinite(time(e.at)))
    .map(e => ({ at: time(e.at), stage: String(e.stage), from: String(e.from_stage), pause: true }));
  return [...moves, ...pauses].sort((a, b) => b.at - a.at || Number(b.pause) - Number(a.pause))[0];
}

/**
 * Where a paused project resumes by the writer: the stage its latest pause left or, when it was paused by
 * hand, the stage its latest recorded move reached (the stage STAGE_SKIPPED requires after the resume).
 */
export function pausedFrom(project: JsonObject): string {
  const latest = latestEvent(project);
  if (latest === undefined) return 'interview';
  return latest.stage === PAUSED_STAGE ? latest.from : latest.stage;
}

function options(args: string[], command: 'pause' | 'resume'): { positional: string[]; opts: Record<string, string>; json: boolean } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (['--by', '--verbatim-file', '--source'].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value.trim() === '') refuse('PROGRESS_OPTION_INVALID', `${command}: ${arg} needs one value; see help`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `${command}: unsupported ${arg}; see help`, USAGE_EXIT);
    else positional.push(arg);
  }
  const most = command === 'pause' ? 1 : 2;
  if (positional.length < most - 1 || positional.length > most) {
    refuse('PROGRESS_OPTION_INVALID', `${command}: ${command === 'pause' ? 'takes one optional project directory' : 'needs the stage and an optional project directory'}; see help`, USAGE_EXIT);
  }
  if (opts['--by'] === undefined) refuse('PROGRESS_OPTION_INVALID', `${command}: supply --by; see help`, USAGE_EXIT);
  if (opts['--by'].toLowerCase() === 'agent') refuse('SIGNOFF_NOT_HUMAN', `pauses: ${command} by agent; a person stops and restarts the work`);
  return { positional, opts, json };
}

/** Validate the complete candidate with the check, then replace project.json in one rename; a refusal writes nothing. */
function commit(dir: string, file: string, project: JsonObject, entry: JsonObject, stage: string, now: number): void {
  if (project.pauses !== undefined && !Array.isArray(project.pauses)) refuse('PAUSE_MALFORMED', 'pauses: must be a list; preserve existing history');
  const candidate: JsonObject = { ...project, pauses: [...asArray(project.pauses), entry], stage };
  const rejected = checkProject(dir, candidate, { now }).refusals[0];
  if (rejected !== undefined) refuse(rejected.code, rejected.message);
  const tmp = join(dirname(file), `.pause-${process.pid}-${crypto.randomUUID()}.tmp`);
  try { writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' }); renameSync(tmp, file); }
  finally { rmSync(tmp, { force: true }); }
}

export function pauseCommand(args: string[], now: number): { stdout: string; exit: number } {
  const { positional, opts, json } = options(args, 'pause');
  const dir = resolve(positional[0] ?? process.cwd());
  const { file, project } = readProject(dir);
  const from = String(project.stage);
  if (from === PAUSED_STAGE) refuse('PAUSE_ALREADY_PAUSED', 'stage: already paused; resume it, or reopen a passed stage');
  if (!pausable(from)) refuse('PAUSE_STAGE_INVALID', `stage: ${from} is not a stage in the order before accepted; only work in progress can be paused`);
  const after = latestEvent(project)?.at ?? -Infinity;
  const signature = collectSignoffs(project, []).filter(s => s.stage === PAUSED_STAGE && s.checkpoint === null && s.at >= after && s.at <= now)
    .sort((a, b) => b.at - a.at || b.index - a.index)[0];
  if (signature === undefined) refuse('PAUSED_UNSIGNED', 'stage: no human { "stage": "paused" } sign-off is dated after the latest recorded move; record signoff paused first');
  const entry: JsonObject = { from_stage: from, stage: PAUSED_STAGE, by: opts['--by']!, at: new Date(now).toISOString(),
    verbatim: readVerbatim(opts['--verbatim-file'] ?? '-'), signoff: signoffIdentity(signature.record) };
  if (opts['--source'] !== undefined) entry.source = opts['--source'];
  commit(dir, file, project, entry, PAUSED_STAGE, now);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `pause: ${from} -> ${PAUSED_STAGE}`, exit: 0 };
}

export function resumeCommand(args: string[], now: number): { stdout: string; exit: number } {
  const { positional, opts, json } = options(args, 'resume');
  const target = positional[0]!;
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = readProject(dir);
  if (project.stage !== PAUSED_STAGE) refuse('RESUME_NOT_PAUSED', `stage: ${String(project.stage)} is not paused; there is nothing to resume`);
  const from = pausedFrom(project);
  if (target !== from) refuse('RESUME_STAGE_MISMATCH', `stage: the project was paused from ${from}, not ${target}; resume ${from}, then advance or reopen from there`);
  const entry: JsonObject = { from_stage: PAUSED_STAGE, stage: target, by: opts['--by']!, at: new Date(now).toISOString(), verbatim: readVerbatim(opts['--verbatim-file'] ?? '-') };
  if (opts['--source'] !== undefined) entry.source = opts['--source'];
  commit(dir, file, project, entry, target, now);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `resume: ${PAUSED_STAGE} -> ${target}`, exit: 0 };
}
