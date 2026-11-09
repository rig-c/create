import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asArray, checkProject, classify, collectItems, collectSignoffs, isObject, loadCollection, postNotPassed, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { acquireAdvanceJobWrite, commitAdvance } from './job-advance.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { findingKey, newFindings, carriedRefusals } from './refusal-baseline.ts';
import { collectAmendments } from './amend.ts';
import { LEGACY_STAGE_VALUES, PARTS_REVIEW_SINCE, PAUSED_STAGE, STAGE_VALUES, hasStageOrder, interviewStageOfGuide, stageIndex, stageOfStep } from './stages.ts';
import { advanceOrder, furthestStageSignoff, isSignoffIdentity, moveOwner, signoffIdentity, statusTransitionFinding, STEP_STATUSES } from './stage-progress.ts';
import { isPartsCheckMove, partsCheckLines, partsCheckRecord } from './parts-check.ts';
import type { JsonObject } from './templates.ts';

export const PROGRESS_HELP = `advance:
  <stage> [<project dir>] [--source <text>] [--parts-check <report> --parts <assembled dir>]
  Move one authorized stage forward and append advances[] with its stable signoff identity.
  The person's signoff is the move's authority; advance takes no --by or words of its own.
  parts -> parts-review requires both: a passing rig-parts check-parts report retained
  under the project and the project-relative assembled root it was run on.
step-status:
  <step> <status> [<project dir>] --by <who>
  Record pending -> in-progress -> at-checkpoint -> done and status_history[].
  A checkpointed done needs a live human checkpoint signature.
  An amended project also runs steps in the check's effective stage, keeping its stored stage.
Both accept --json and validate the complete candidate before writing.`;

function options(args: string[], command: string): { positional: string[]; opts: Record<string, string>; json: boolean } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (command === 'advance' && (arg === '--by' || arg === '--verbatim-file')) {
      refuse('ADVANCE_WORDS_REMOVED', `advances: advance no longer takes ${arg}; the move records the live stage signoff it rests on, so record the person's approval with signoff (from the review tool: signoff <stage> --from-review <actId>) and advance without words`, USAGE_EXIT);
    } else if ((command === 'advance' ? ['--source', '--parts-check', '--parts'] : ['--by']).includes(arg)) {
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
function save(dir: string, file: string, project: JsonObject, now: number, forwardWrite = false, before?: JsonObject): void {
  project.stage_values = [...(hasStageOrder(project) ? STAGE_VALUES : LEGACY_STAGE_VALUES)];
  const allowed = before === undefined ? new Map<string, number>() : carriedRefusals(dir, before, { now, forwardWrite });
  if (forwardWrite && ['rigging-interview', 'post-interview'].includes(String(project.stage))) {
    for (const item of collectItems(project, { collection: loadCollection(dir) })) {
      if (item.state.state !== 'silent' || interviewStageOfGuide(item.id, item.kind === 'post', hasStageOrder(project)) !== project.stage) continue;
      const key = findingKey({ code: 'INTERVIEW_INCOMPLETE', path: item.path });
      allowed.set(key, (allowed.get(key) ?? 0) + 1);
    }
  }
  const first = newFindings(allowed, checkProject(dir, project, { now, forwardWrite }).refusals)[0];
  if (first !== undefined) refuse(first.code, first.message);
  if (forwardWrite) commitAdvance(dir, file, project);
  else writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
}

export function advanceCommand(args: string[], now: number): { stdout: string; exit: number } {
  const { positional, opts, json } = options(args, 'advance');
  if (positional.length < 1 || positional.length > 2) refuse('PROGRESS_OPTION_INVALID', 'stage: advance needs a target and optional project directory; see help', USAGE_EXIT);
  const dir = resolve(positional[1] ?? process.cwd());
  const releaseJob = acquireAdvanceJobWrite(dir, positional[0]!);
  try {
    const { file, project } = readProject(dir);
    const history: Finding[] = [];
    const reopens = collectReopens(project, history);
    const latest = furthestStageSignoff(collectSignoffs(project, history).filter(s => liveSignoff(reopens, s.stage, s.at)));
    if (latest !== undefined && !Number.isFinite(latest.at)) refuse('STAGE_SIGNOFF_DATE_INVALID', `signoffs[${latest.index}].at: frontier approval needs a readable date; restore its original date before advancing`);
    if (latest === undefined) refuse('ADVANCE_UNAUTHORIZED', 'stage: no live stage-level human signoff authorizes a move; sign the current stage first');
    const preParts = !hasStageOrder(project) && stageIndex(String(project.stage)) > stageIndex('parts-review')
      && collectSignoffs(project, []).some(s => s.stage === 'plan-approved' && s.checkpoint === null && s.at < Date.parse(PARTS_REVIEW_SINCE));
    const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
    // The entry records the signoff it rests on and no person's words: the authority is that signature.
    const entry: JsonObject = { stage: positional[0]!, from_stage: project.stage ?? null, at: new Date(now).toISOString(),
      post_not_passed: postNotPassed({ items: collectItems(project, { collection: loadCollection(dir) }) }),
      order: preParts ? 'pre-parts' : hasStageOrder(project) ? 'split' : 'legacy', signoffs_before: asArray(project.signoffs).filter(isObject).map(signoffIdentity).filter(isSignoffIdentity), signoff: signoffIdentity(latest.record),
      steps_before: steps.map(s => ({ id: s.id ?? null, phase: s.phase ?? null, ...(s.status === undefined ? {} : { status: s.status }) })) };
    if (opts['--source'] !== undefined) entry.source = opts['--source'];
    // A live signature at an earlier stage is not this move's authority; name the stage to sign, not the candidate.
    // A malformed signoff or reopen may be that signature, so the candidate check names it instead.
    const order = advanceOrder(entry.order);
    const owner = moveOwner(order, entry.from_stage);
    if (history.length === 0 && owner !== undefined && order.findIndex(s => s.id === latest.stage) < order.findIndex(s => s.id === owner)) {
      refuse('ADVANCE_UNAUTHORIZED', `stage: no live ${owner} signoff authorizes the move from ${String(entry.from_stage)}; the latest live stage signoff is ${latest.stage} (signoffs[${latest.index}]); record rig-create signoff ${owner} first, then advance`);
    }
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
    save(dir, file, project, now, true);
    const lines = isObject(entry.parts_check) ? partsCheckLines(entry.parts_check, checkPath) : [];
    return { stdout: json ? JSON.stringify(entry, null, 2) : [`advance: ${String(entry.from_stage)} -> ${String(entry.stage)}`, ...lines].join('\n'), exit: 0 };
  } finally {
    releaseJob();
  }
}

export function stepStatusCommand(args: string[], now: number): { stdout: string; exit: number } {
  const { positional, opts, json } = options(args, 'step-status');
  if (positional.length < 2 || positional.length > 3) refuse('PROGRESS_OPTION_INVALID', 'plan.steps: step-status needs step, status and optional project directory; see help', USAGE_EXIT);
  const dir = resolve(positional[2] ?? process.cwd());
  const { file, project } = readProject(dir);
  const before = structuredClone(project);
  const matches = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter((s): s is JsonObject => isObject(s) && s.id === positional[0]);
  const step = matches[0];
  if (matches.length !== 1 || step === undefined || (step.phase !== 'rig' && step.phase !== 'post')) refuse('STEP_STATUS_TRANSITION', `plan.steps[${positional[0]}]: no unique executable step; restore the plan before step-status`);
  const stage = stageOfStep(step.phase, String(step.id));
  // Amend retains project.stage while its approvals lapse; the work resumes at the check's effective stage (PROJECT.md).
  const resumes = project.stage !== PAUSED_STAGE && collectAmendments(project, []).length > 0
    ? checkProject(dir, structuredClone(project), { now }).effective_stage : null;
  const running = resumes !== null && resumes !== project.stage ? [String(project.stage), resumes] : [String(project.stage)];
  const oldOrder = !hasStageOrder(project) && running.includes('rigging') && collectSignoffs(project, []).some(s => s.stage === 'plan-approved' && s.at < Date.parse(PARTS_REVIEW_SINCE));
  if (!running.includes(stage) && !(oldOrder && step.phase === 'rig')) {
    refuse('STEP_STATUS_TRANSITION', running.length > 1
      ? `plan.steps[${positional[0]}]: runs in ${stage}; the amended project resumes at ${String(resumes)} (stage ${String(project.stage)} retained); sign the lapsed approvals and finish the earlier bars first`
      : `plan.steps[${positional[0]}]: runs in ${stage}, current stage is ${String(project.stage)}; advance to its execution stage first`);
  }
  const checkpoint = classify(step.checkpoint, { collection: null });
  const enabled = checkpoint.state === 'user' ? checkpoint.answer.value === true
    : checkpoint.state === 'delegated' && isObject(checkpoint.answer.agent_decision) && checkpoint.answer.agent_decision.value === true;
  const entry: JsonObject = { from_status: step.status ?? 'pending', status: positional[1]!, by: opts['--by']!, at: new Date(now).toISOString(), checkpoint_required: enabled, signoff: null };
  const from = STEP_STATUSES.indexOf(entry.from_status as typeof STEP_STATUSES[number]);
  if (from >= 0 && STEP_STATUSES.indexOf(entry.status as typeof STEP_STATUSES[number]) !== from + 1) {
    const next = STEP_STATUSES[from + 1];
    refuse('STEP_STATUS_TRANSITION', next === undefined
      ? `plan.steps[${positional[0]}].status: ${String(entry.from_status)} is the last status, so ${String(entry.status)} cannot follow it; to run the step again record rig-create reopen ${stage}`
      : `plan.steps[${positional[0]}].status: ${String(entry.status)} cannot follow ${String(entry.from_status)}; statuses move one at a time through ${STEP_STATUSES.join(' → ')}, so record rig-create step-status ${String(step.id)} ${next} next`);
  }
  const invalid = statusTransitionFinding(entry, `plan.steps[${positional[0]}].status_history`);
  if (invalid !== null) refuse(invalid.code, invalid.message);
  if (entry.status === 'done' && enabled) {
    const reopens = collectReopens(project, []);
    const signature = collectSignoffs(project, []).filter(s => s.checkpoint === step.id && (s.stage === stage || (oldOrder && s.stage === 'rigging'))
      && liveSignoff(reopens, s.stage, s.at) && s.at <= Date.parse(String(entry.at))).sort((a, b) => b.at - a.at || b.index - a.index)[0];
    if (signature === undefined) refuse('CHECKPOINT_UNSIGNED', `plan.steps[${positional[0]}]: done requires its live human checkpoint signoff; record signoff ${stage} --checkpoint ${String(step.id)} first`);
    entry.signoff = signoffIdentity(signature.record);
  }
  if (step.status_history !== undefined && !Array.isArray(step.status_history)) refuse('STEP_STATUS_TRANSITION', `plan.steps[${positional[0]}].status_history: must be a list; preserve existing history`);
  step.status_history = [...asArray(step.status_history), entry];
  step.status = entry.status!;
  save(dir, file, project, now, false, before);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `step-status: ${positional[0]} ${String(entry.status)}`, exit: 0 };
}
