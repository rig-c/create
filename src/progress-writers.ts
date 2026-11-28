import { createHash, randomUUID } from 'node:crypto';
import { checkpointRequired } from './plan-history.ts';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { asArray, checkProject, collectItems, collectSignoffs, isObject, loadCollection, postNotPassed, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { acquireAdvanceJobWrite, commitAdvance, isPublishAdvanceStage } from './job-advance.ts';
import { acquireBoundJobWrite, beginJobProgress } from './job-writer.ts';
import { assertCleanProjectStep, commitToolWrite } from './project-step-commit.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { findingKey, newFindings, carriedRefusals } from './refusal-baseline.ts';
import { LEGACY_STAGE_VALUES, PARTS_REVIEW_SINCE, STAGE_VALUES, hasStageOrder, isOpenInterviewArrivalStage, silentInterviewItems, stageIndex, stageOfStep } from './stages.ts';
import { furthestStageSignoff, isSignoffIdentity, nextStepStatus, signoffIdentity, statusTransitionFinding, stepStatusFollows, STEP_STATUSES } from './stage-progress.ts';
import { isPartsCheckMove, partsCheckLines, partsCheckRecord } from './parts-check.ts';
import type { JsonObject } from './templates.ts';
import { eligibleBoundPaths } from './writer-commit-paths.ts';

export const PROGRESS_HELP = `advance:
  <stage> [<project dir>] [--source <text>] [--parts-check <report> --parts <assembled dir>]
  Move the project to any stage and append advances[]. No sign-off is required; when a live
  stage-level signoff exists, the entry records its stable identity, else signoff is null.
  advance takes no --by or words of its own.
  parts -> parts-review requires both: a passing rig-parts check-parts report written
  with --out <project>/evidence (a clone does not carry derived/) and the
  project-relative assembled root it was run on.
step-status:
  <step> <status> [<project dir>] --by <who> [--note-file <path>]
  Record pending -> in-progress -> at-checkpoint -> done and status_history[];
  a step without a checkpoint may go from in-progress straight to done.
  The optional note is verbatim UTF-8, 1–1,000 bytes, with no controls except newline.
  A step may change status in any stage; no checkpoint signature is required.
Both accept --json and validate the complete candidate before writing.`;

function options(args: string[], command: string): { positional: string[]; opts: Record<string, string>; json: boolean } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (command === 'advance' && (arg === '--by' || arg === '--verbatim-file')) {
      refuse('ADVANCE_WORDS_REMOVED', `advances: advance no longer takes ${arg}; the move records the live stage signoff it rests on, so record the person's approval with signoff --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator> and advance without words`, USAGE_EXIT);
    } else if ((command === 'advance' ? ['--source', '--parts-check', '--parts'] : ['--by', '--note-file']).includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value.trim() === '') refuse('PROGRESS_OPTION_INVALID', `${command}: ${arg} needs one value; see help`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `${command}: unsupported ${arg}; see help`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (command !== 'advance' && opts['--by'] === undefined) refuse('PROGRESS_OPTION_INVALID', `${command}: supply --by; see help`, USAGE_EXIT);
  return { positional, opts, json };
}

/**
 * Validate the complete candidate, then write. `advance` passes no baseline: a stage boundary needs 0 refusals
 * (only the arrival's own INTERVIEW_INCOMPLETE is allowed). `step-status` passes the record as read, and only a
 * refusal that record did not already carry blocks its write.
 */
function save(
  dir: string,
  file: string,
  project: JsonObject,
  now: number,
  forwardWrite = false,
  before?: JsonObject,
  original?: Buffer,
  assets: readonly string[] = [],
): string | undefined {
  project.stage_values = [...(hasStageOrder(project) ? STAGE_VALUES : LEGACY_STAGE_VALUES)];
  const allowed = before === undefined ? new Map<string, number>() : carriedRefusals(dir, before, { now, forwardWrite });
  if (forwardWrite && typeof project.stage === 'string' && isOpenInterviewArrivalStage(project.stage)) {
    const items = collectItems(project, { collection: loadCollection(dir) });
    for (const item of silentInterviewItems(project, items, project.stage)) {
      const key = findingKey({ code: 'INTERVIEW_INCOMPLETE', path: item.path });
      allowed.set(key, (allowed.get(key) ?? 0) + 1);
    }
  }
  const first = newFindings(allowed, checkProject(dir, project, { now, forwardWrite }).refusals)[0];
  if (first !== undefined) refuse(first.code, first.message);
  if (forwardWrite) return commitAdvance(dir, file, project, undefined, assets);
  assertCleanProjectStep(dir, ['project.json']);
  const tmp = join(dirname(file), `.step-status-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(project, null, 2)}\n`, { flag: 'wx' });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return commitToolWrite(dir, 'step-status', ['project.json']);
}

export function advanceCommand(args: string[], now: number): { stdout: string; exit: number; stderr?: string } {
  const { positional, opts, json } = options(args, 'advance');
  if (positional.length < 1 || positional.length > 2) refuse('PROGRESS_OPTION_INVALID', 'stage: advance needs a target and optional project directory; see help', USAGE_EXIT);
  const dir = resolve(positional[1] ?? process.cwd());
  readProject(dir);
  const releaseJob = acquireAdvanceJobWrite(dir, positional[0]!);
  // The first milestone waits for the job gate: a refused write leaves the project untouched.
  const progress = beginJobProgress(dir, 'other', 'Preparing to advance the project stage');
  try {
    const { file, project } = readProject(dir);
    const history: Finding[] = [];
    const reopens = collectReopens(project, history);
    const latest = furthestStageSignoff(collectSignoffs(project, history).filter(s => liveSignoff(reopens, s.stage, s.at) && Number.isFinite(s.at)));
    const preParts = !hasStageOrder(project) && stageIndex(String(project.stage)) > stageIndex('parts-review')
      && collectSignoffs(project, []).some(s => s.stage === 'plan-approved' && s.checkpoint === null && s.at < Date.parse(PARTS_REVIEW_SINCE));
    const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
    // The entry records the signoff it rests on and no person's words: the authority is that signature.
    const entry: JsonObject = { stage: positional[0]!, from_stage: project.stage ?? null, at: new Date(now).toISOString(),
      post_not_passed: postNotPassed({ items: collectItems(project, { collection: loadCollection(dir) }) }),
      order: preParts ? 'pre-parts' : hasStageOrder(project) ? 'split' : 'legacy', signoffs_before: asArray(project.signoffs).filter(isObject).map(signoffIdentity).filter(isSignoffIdentity), signoff: latest === undefined ? null : signoffIdentity(latest.record),
      steps_before: steps.map(s => ({ id: s.id ?? null, phase: s.phase ?? null, ...(s.status === undefined ? {} : { status: s.status }) })) };
    if (opts['--source'] !== undefined) entry.source = opts['--source'];
    if (project.advances !== undefined && !Array.isArray(project.advances)) refuse('ADVANCE_MALFORMED', 'advances: must be a list; preserve existing history');
    const checkPath = `advances[${asArray(project.advances).length}].parts_check`;
    const report = opts['--parts-check'];
    const root = opts['--parts']?.replace(/\/+$/, '');
    if (!isPartsCheckMove(entry) && (report !== undefined || root !== undefined)) {
      refuse('PROGRESS_OPTION_INVALID', `${checkPath}: --parts-check and --parts are accepted only on the move from parts to parts-review; see help`, USAGE_EXIT);
    }
    if ((report === undefined) !== (root === undefined)) {
      refuse('PROGRESS_OPTION_INVALID', `${checkPath}: supply --parts-check and --parts together; see help`, USAGE_EXIT);
    }
    // Without both flags the check refuses the move as PARTS_CHECK_MISSING, in check order.
    if (report !== undefined && root !== undefined) {
      const read = partsCheckRecord(dir, report, root, checkPath);
      if ('refusal' in read) refuse(read.refusal.code, read.refusal.message);
      entry.parts_check = read.record;
    }
    project.advances = [...asArray(project.advances), entry];
    project.stage = entry.stage!;
    progress?.('Checking the stage boundary');
    const assets = isObject(entry.parts_check) && typeof entry.parts_check.path === 'string'
      ? eligibleBoundPaths([entry.parts_check.path])
      : [];
    const warning = save(dir, file, project, now, true, undefined, undefined, assets);
    if (!isPublishAdvanceStage(positional[0]!)) progress?.('Project stage advanced');
    const lines = isObject(entry.parts_check) ? partsCheckLines(entry.parts_check, checkPath) : [];
    return {
      stdout: json ? JSON.stringify(entry, null, 2) : [`advance: ${String(entry.from_stage)} -> ${String(entry.stage)}`, ...lines].join('\n'),
      exit: 0,
      ...(warning === undefined ? {} : { stderr: warning }),
    };
  } finally {
    releaseJob();
  }
}

export function stepStatusCommand(args: string[], now: number): { stdout: string; exit: number; stderr?: string } {
  const { positional, opts, json } = options(args, 'step-status');
  if (positional.length < 2 || positional.length > 3) refuse('PROGRESS_OPTION_INVALID', 'plan.steps: step-status needs step, status and optional project directory; see help', USAGE_EXIT);
  const dir = resolve(positional[2] ?? process.cwd());
  readProject(dir);
  const release = acquireBoundJobWrite(dir, undefined, true);
  try {
    const { file, project } = readProject(dir);
    const original = readFileSync(file);
    const before = structuredClone(project);
    const matches = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter((s): s is JsonObject => isObject(s) && s.id === positional[0]);
    const step = matches[0];
    if (matches.length !== 1 || step === undefined || (step.phase !== 'rig' && step.phase !== 'post')) refuse('STEP_STATUS_TRANSITION', `plan.steps[${positional[0]}]: no unique executable step; restore the plan before step-status`);
    const enabled = checkpointRequired(project, step, now);
    const entry: JsonObject = { from_status: step.status ?? 'pending', status: positional[1]!, by: opts['--by']!, at: new Date(now).toISOString(), checkpoint_required: enabled, signoff: null };
    if (opts['--note-file'] !== undefined) {
      const notePath = opts['--note-file'];
      try {
        const bytes = readFileSync(notePath);
        if (bytes.length === 0 || bytes.length > 1000) throw new Error('invalid size');
        // Keep a leading BOM too: the stored text and digest bind the original UTF-8 bytes.
        entry.note = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        entry.note_sha256 = createHash('sha256').update(bytes).digest('hex');
      } catch {
        refuse('PROGRESS_OPTION_INVALID', `plan.steps[${positional[0]}].status_history: ${notePath}: supply a readable non-empty UTF-8 --note-file of at most 1,000 bytes`, USAGE_EXIT);
      }
    }
    const from = STEP_STATUSES.indexOf(entry.from_status as typeof STEP_STATUSES[number]);
    if (from >= 0 && !stepStatusFollows(entry.from_status, entry.status, enabled)) {
      const next = nextStepStatus(String(entry.from_status), enabled);
      refuse('STEP_STATUS_TRANSITION', next === undefined
        ? `plan.steps[${positional[0]}].status: ${String(entry.status)} cannot follow ${String(entry.from_status)}; record a known status`
        : `plan.steps[${positional[0]}].status: ${String(entry.status)} cannot follow ${String(entry.from_status)}; statuses move one at a time through ${STEP_STATUSES.join(' → ')}${enabled ? '' : ' (a step without a checkpoint may go from in-progress straight to done)'} and a done step may return to in-progress, so record rig-create step-status ${String(step.id)} ${next} next`);
    }
    const invalid = statusTransitionFinding(entry, `plan.steps[${positional[0]}].status_history`);
    if (invalid !== null) refuse(invalid.code, invalid.message);
    if (entry.status === 'done' && enabled) {
      // A live checkpoint signoff, when one exists, is recorded; done no longer waits for one (#981).
      const reopens = collectReopens(project, []);
      const legacy = collectSignoffs(project, []).some(s => s.stage === 'plan-approved' && s.checkpoint === null && s.at < Date.parse(PARTS_REVIEW_SINCE) && s.at <= now);
      const stages = [stageOfStep(step.phase, String(step.id)), ...(legacy ? [stageOfStep(step.phase, '')] : [])];
      const signature = collectSignoffs(project, []).filter(s => s.checkpoint === step.id && stages.includes(s.stage)
        && typeof s.record.by === 'string' && s.record.by.toLowerCase() !== 'agent'
        && liveSignoff(reopens, s.stage, s.at) && s.at <= now).sort((a, b) => b.at - a.at || b.index - a.index)[0];
      if (signature !== undefined) entry.signoff = signoffIdentity(signature.record);
    }
    if (step.status_history !== undefined && !Array.isArray(step.status_history)) refuse('STEP_STATUS_TRANSITION', `plan.steps[${positional[0]}].status_history: must be a list; preserve existing history`);
    step.status_history = [...asArray(step.status_history), entry];
    step.status = entry.status!;
    const warning = save(dir, file, project, now, false, before, original);
    return {
      stdout: json ? JSON.stringify(entry, null, 2) : `step-status: ${positional[0]} ${String(entry.status)}`,
      exit: 0,
      ...(warning === undefined ? {} : { stderr: warning }),
    };
  } finally {
    release();
  }
}
