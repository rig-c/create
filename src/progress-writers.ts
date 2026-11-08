import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asArray, checkProject, classify, collectItems, collectSignoffs, isObject, loadCollection, postNotPassed } from './check.ts';
import { readProject } from './feedback.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { LEGACY_STAGE_VALUES, PARTS_REVIEW_SINCE, STAGE_VALUES, hasStageOrder, interviewStageOfGuide, stageIndex, stageOfStep } from './stages.ts';
import { furthestStageSignoff, isSignoffIdentity, signoffIdentity, statusTransitionFinding } from './stage-progress.ts';
import type { JsonObject } from './templates.ts';

export const PROGRESS_HELP = `advance:
  <stage> [<project dir>] --by <who> [--verbatim-file <file>] [--source <text>]
  Move one authorized stage forward and append advances[] with its stable signoff identity.
step-status:
  <step> <status> [<project dir>] --by <who>
  Record pending -> in-progress -> at-checkpoint -> done and status_history[].
  A checkpointed done needs a live human checkpoint signature.
Both accept --json and validate the complete candidate before writing.`;

function options(args: string[], command: string): { positional: string[]; opts: Record<string, string>; json: boolean } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (['--by', ...(command === 'advance' ? ['--verbatim-file', '--source'] : [])].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value.trim() === '') refuse('PROGRESS_OPTION_INVALID', `${command}: ${arg} needs one value; see help`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `${command}: unsupported ${arg}; see help`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (opts['--by'] === undefined) refuse('PROGRESS_OPTION_INVALID', `${command}: supply --by; see help`, USAGE_EXIT);
  return { positional, opts, json };
}

function save(dir: string, file: string, project: JsonObject, forwardWrite = false): void {
  project.stage_values = [...(hasStageOrder(project) ? STAGE_VALUES : LEGACY_STAGE_VALUES)];
  const incomplete = new Map<string, number>();
  if (forwardWrite && ['rigging-interview', 'post-interview'].includes(String(project.stage))) {
    for (const item of collectItems(project, { collection: loadCollection(dir) })) {
      if (item.state.state !== 'silent' || interviewStageOfGuide(item.id, item.kind === 'post', hasStageOrder(project)) !== project.stage) continue;
      const key = `INTERVIEW_INCOMPLETE:${item.path}`;
      incomplete.set(key, (incomplete.get(key) ?? 0) + 1);
    }
  }
  for (const finding of checkProject(dir, project, { forwardWrite }).refusals) {
    const key = `${finding.code}:${finding.path}`;
    const remaining = incomplete.get(key) ?? 0;
    if (!remaining) refuse(finding.code, finding.message);
    incomplete.set(key, remaining - 1);
  }
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
}

export function advanceCommand(args: string[]): { stdout: string; exit: number } {
  const { positional, opts, json } = options(args, 'advance');
  if (positional.length < 1 || positional.length > 2) refuse('PROGRESS_OPTION_INVALID', 'stage: advance needs a target and optional project directory; see help', USAGE_EXIT);
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = readProject(dir);
  const reopens = collectReopens(project, []);
  const latest = furthestStageSignoff(collectSignoffs(project, []).filter(s => liveSignoff(reopens, s.stage, s.at)));
  if (latest !== undefined && !Number.isFinite(latest.at)) refuse('STAGE_SIGNOFF_DATE_INVALID', `signoffs[${latest.index}].at: frontier approval needs a readable date; restore its original date before advancing`);
  if (latest === undefined) refuse('ADVANCE_UNAUTHORIZED', 'stage: no live stage-level human signoff authorizes a move; sign the current stage first');
  const preParts = !hasStageOrder(project) && stageIndex(String(project.stage)) > stageIndex('parts-review')
    && collectSignoffs(project, []).some(s => s.stage === 'plan-approved' && s.checkpoint === null && s.at < Date.parse(PARTS_REVIEW_SINCE));
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  const entry: JsonObject = { stage: positional[0]!, from_stage: project.stage ?? null, by: opts['--by']!, at: new Date().toISOString(),
    post_not_passed: postNotPassed({ items: collectItems(project, { collection: loadCollection(dir) }) }),
    order: preParts ? 'pre-parts' : hasStageOrder(project) ? 'split' : 'legacy', signoffs_before: asArray(project.signoffs).filter(isObject).map(signoffIdentity).filter(isSignoffIdentity), verbatim: readVerbatim(opts['--verbatim-file'] ?? '-'), signoff: signoffIdentity(latest.record),
    steps_before: steps.map(s => ({ id: s.id ?? null, phase: s.phase ?? null, ...(s.status === undefined ? {} : { status: s.status }) })) };
  if (opts['--source'] !== undefined) entry.source = opts['--source'];
  if (project.advances !== undefined && !Array.isArray(project.advances)) refuse('ADVANCE_MALFORMED', 'advances: must be a list; preserve existing history');
  project.advances = [...asArray(project.advances), entry];
  project.stage = entry.stage!;
  save(dir, file, project, true);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `advance: ${String(entry.from_stage)} -> ${String(entry.stage)}`, exit: 0 };
}

export function stepStatusCommand(args: string[]): { stdout: string; exit: number } {
  const { positional, opts, json } = options(args, 'step-status');
  if (positional.length < 2 || positional.length > 3) refuse('PROGRESS_OPTION_INVALID', 'plan.steps: step-status needs step, status and optional project directory; see help', USAGE_EXIT);
  const dir = resolve(positional[2] ?? process.cwd());
  const { file, project } = readProject(dir);
  const matches = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter((s): s is JsonObject => isObject(s) && s.id === positional[0]);
  const step = matches[0];
  if (matches.length !== 1 || step === undefined || (step.phase !== 'rig' && step.phase !== 'post')) refuse('STEP_STATUS_TRANSITION', `plan.steps[${positional[0]}]: no unique executable step; restore the plan before step-status`);
  const stage = stageOfStep(step.phase, String(step.id));
  const oldOrder = !hasStageOrder(project) && project.stage === 'rigging' && collectSignoffs(project, []).some(s => s.stage === 'plan-approved' && s.at < Date.parse(PARTS_REVIEW_SINCE));
  if (project.stage !== stage && !(oldOrder && step.phase === 'rig')) refuse('STEP_STATUS_TRANSITION', `plan.steps[${positional[0]}]: runs in ${stage}, current stage is ${String(project.stage)}; advance to its execution stage first`);
  const checkpoint = classify(step.checkpoint, { collection: null });
  const enabled = checkpoint.state === 'user' ? checkpoint.answer.value === true
    : checkpoint.state === 'delegated' && isObject(checkpoint.answer.agent_decision) && checkpoint.answer.agent_decision.value === true;
  const entry: JsonObject = { from_status: step.status ?? 'pending', status: positional[1]!, by: opts['--by']!, at: new Date().toISOString(), checkpoint_required: enabled, signoff: null };
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
  save(dir, file, project);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `step-status: ${positional[0]} ${String(entry.status)}`, exit: 0 };
}
