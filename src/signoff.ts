import { missingPickSignoffSteps, pickSignoffEvidence } from './pick-signoff.ts';
import { OWNER_CHAT_FLAGS, OWNER_CHAT_USAGE, readOwnerChat } from './owner-chat.ts';
import { literalFile, pendingInterviewOptions, pendingInterviewOptionsPath } from './choices.ts';
import { assertSignoffCandidate } from './parts-signoff.ts';
import { selectAnswerHashes, staleSignoffAnswer } from './signoff-answers.ts';
import { selectSignoffTarget } from './signoff-target.ts';
import { signoffPairFinding } from './signoff-pair.ts';
import { assertCorrectionApproval } from './correction-writers.ts';
import { writeFileSync } from 'node:fs';
import { readFileSync, recordCheckReads, type CheckRead } from './check-reads.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { assertInterviewRecordSignable, checkpointProblem } from './signable.ts';
import { commitIngestedSignoff } from './signoff-checkpoint-act.ts';
import { resolve } from 'node:path';
import { jobHash } from './job-outbox.ts';
import { SIGNOFF_TARGET_KINDS } from './review-act.ts';
import { refuseNumberedWriter } from './numbered-retirement.ts';

import { asArray, checkProject, classify, collectItems, isObject, loadCollection, postNotPassed, type CheckReport, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { assertCurrentPartsStructure, riggingContext } from './structure.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { findingKey } from './refusal-baseline.ts';
import { approvalStageOfStep, hasStageOrder, interviewStageOfGuide, isOpenInterviewStage, PARTS_REVIEW, STAGE_ORDER_SPEC, STAGE_VALUES } from './stages.ts';
import { stepHash } from './step-hash.ts';
import type { JsonObject } from './templates.ts';

export const SIGNOFF_HELP = `signoff:
  <stage> [<project dir>]  record a human signature without moving project.stage
  --from-picks            derive a stage signature from recorded owner picks
  --by <who>              the person signing (agent is refused)
  --verbatim-file <file>  UTF-8 words unchanged, or - for stdin (default: stdin)
  --owner-chat <file>     relay exact owner words (excludes --verbatim-file)
                          required when signing current parts, rig or direction
  --said-at <ISO date>    explicit owner clock; at remains the write time
  --relayed-by <who>      operator relaying the owner chat
  --steps <id,id,...>     narrow parts plan, rigging-interview rig steps, or post steps
  --checkpoint <id>       sign an enabled checkpoint in this execution stage
  --structure-file <path> retained structure decisions snapshot for parts-review
                          current parts default to the snapshot written by structure-snapshot
  --json                  print the signature as JSON
  The clock supplies at. With no --steps, signs all steps of the stage's phase.
  Fills null checkpoints from checkpoint_proposed and hashes covered steps after filling.
  Existing checkpoints are preserved. Parts-review validates evidence before recording.`;

export function currentPartsStructureBinding(dir: string, project: JsonObject, target: JsonObject, path: string | undefined, now: number) {
  const rel = path ?? `evidence/structure/current-parts/${String(target.record_sha256)}.json`;
  const at = `signoffs[${asArray(project.signoffs).length}].structure`;
  const remedy = 'run structure-snapshot on current.parts and use its output or pass --structure-file <path>';
  let bytes: Buffer;
  try { bytes = readFileSync(literalFile(dir, rel)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') refuse('STRUCTURE_DECISIONS_MISSING', `${at}: ${rel} is missing; ${remedy}`);
    return refuse('STRUCTURE_DECISIONS_INVALID', `${at}: ${rel}: ${error instanceof Error ? error.message : String(error)}; ${remedy}`);
  }
  const binding = { path: rel, sha256: jobHash(bytes) };
  assertCurrentPartsStructure(dir, project, binding, now);
  return binding;
}

function splitEqFlag(arg: string, names: readonly string[]): [string, string] | null {
  for (const name of names) {
    if (arg.startsWith(`${name}=`)) return [name, arg.slice(name.length + 1)];
  }
  return null;
}

export function signoffCommand(args: string[], now: number): { stdout: string; exit: number } {
  if (args.some(arg => arg === '--evidence' || arg.startsWith('--evidence='))) refuse('PARTS_VERDICT_FILE_ROUTE_REMOVED', 'project.json.signoffs.evidence: --evidence was removed; record current.parts and relay any owner chat signoff with --owner-chat', USAGE_EXIT);
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  let hasDiffFlag = false;
  let hasVersionFlag = false;
  let hasDraftFlag = false;
  let hasFromReviewFlag = false;
  const eqFlags = ['--version', '--draft', '--from-review', '--checkpoint'] as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = splitEqFlag(arg, eqFlags);
    if (eq) {
      const [name, value] = eq;
      if (name === '--checkpoint') {
        if (name in opts || value === '') refuse('SIGNOFF_OPTION_INVALID', `${name} needs one non-empty value`, USAGE_EXIT);
        opts[name] = value;
        continue;
      }
      if (name === '--version') hasVersionFlag = true;
      else if (name === '--draft') hasDraftFlag = true;
      else if (name === '--from-review') hasFromReviewFlag = true;
      if (value !== '' && !(name in opts)) opts[name] = value;
      continue;
    }
    if (arg === '--json') json = true;
    else if (arg === '--from-picks') {
      if (arg in opts) refuse('SIGNOFF_OPTION_INVALID', '--from-picks can only be supplied once', USAGE_EXIT);
      opts[arg] = 'true';
    }
    else if (arg === '--component' || arg === '--diff-report' || arg === '--triage-file') {
      hasDiffFlag = true;
      i++;
    } else if (arg.startsWith('--component=') || arg.startsWith('--diff-report=') || arg.startsWith('--triage-file=')) {
      hasDiffFlag = true;
    } else if (arg === '--version' || arg === '--draft' || arg === '--from-review') {
      if (arg === '--version') hasVersionFlag = true;
      else if (arg === '--draft') hasDraftFlag = true;
      else hasFromReviewFlag = true;
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith('-')) {
        opts[arg] = value;
        i++;
      }
    } else if (['--structure-file', '--by', '--verbatim-file', '--steps', '--checkpoint', ...OWNER_CHAT_FLAGS].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value === '') refuse('SIGNOFF_OPTION_INVALID', `${arg} needs one non-empty value`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `signoff does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const stageArg = positional[0];
  if (hasFromReviewFlag) {
    const stageLabel = stageArg && STAGE_VALUES.includes(stageArg) ? stageArg : '<stage>';
    const checkpoint = opts['--checkpoint'];
    const removed = checkpoint !== undefined
      ? `signoff --checkpoint ${checkpoint} --from-review`
      : `signoff ${stageLabel} --from-review`;
    const replacement = checkpoint !== undefined
      ? `signoff ${stageLabel} --checkpoint ${checkpoint} --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`
      : `signoff ${stageLabel} --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`;
    refuse('SIGNOFF_FROM_REVIEW_REMOVED', `project.json.signoffs: ${removed} was removed; use ${replacement}`, USAGE_EXIT);
  }
  if (hasVersionFlag) {
    const stageLabel = stageArg === 'rig-review' || stageArg === 'direction-review' ? stageArg : '<stage>';
    refuseNumberedWriter('signoff --version', `record the current output and relay any owner chat signoff with rig-create signoff ${stageLabel} ${OWNER_CHAT_USAGE}`);
  }
  if (hasDraftFlag) {
    refuseNumberedWriter('signoff --draft', `record current.parts and relay any owner chat signoff with rig-create signoff parts-review ${OWNER_CHAT_USAGE} [--structure-file <path>]`);
  }
  const stage = stageArg;
  if (positional.length > 2 || stage === undefined || !STAGE_VALUES.includes(stage)) refuse('SIGNOFF_OPTION_INVALID', 'signoff takes a known stage and one optional project folder', USAGE_EXIT);
  if (hasDiffFlag) {
    if (stage !== PARTS_REVIEW) refuse('SIGNOFF_OPTION_INVALID', '--diff-report, --triage-file and --component are not accepted on signoff', USAGE_EXIT);
    refuse(
      'SIGNOFF_DIFF_MAP_REMOVED',
      "project.json.signoffs.diff_map: --diff-report, --triage-file and --component were removed from signoff; component classification is agent-authored — record it with 'rig-create diff-classes --diff-report <path> --triage-file <file> --by agent' (or '--component <id>=<status>:<why> --by agent')",
      USAGE_EXIT,
    );
  }
  if (opts['--from-picks'] && Object.keys(opts).length !== 1) {
    refuse('SIGNOFF_OPTION_INVALID', '--from-picks supplies the signing evidence and cannot be combined with other signoff options', USAGE_EXIT);
  }
  if (!opts['--from-picks']) return recordSignoff(stage, positional, opts, json, now);
  const root = resolve(positional[1] ?? process.cwd());
  const release = acquireBoundJobWrite(root);
  try {
    return recordSignoff(stage, positional, opts, json, now);
  } finally { release(); }
}

interface PlanResignPreflight {
  readonly clear: readonly Finding[];
  /** The full inventory check, available only on the live project. */
  readonly baseline?: CheckReport;
}

/** Run the candidate gate with a stand-in signature, without writing or inventing an owner act. */
export function assertPlanSignoffCandidate(dir: string, project: JsonObject, stage: string, now: number, resign?: PlanResignPreflight): readonly CheckRead[] {
  return recordSignoff(stage, [stage, dir], { '--by': 'publication-preflight' }, false, now,
    { project: structuredClone(project), resign }).reads ?? [];
}

function recordSignoff(stage: string, positional: string[], opts: Record<string, string>, json: boolean, now: number, preview?: { project: JsonObject; resign?: PlanResignPreflight }): { stdout: string; exit: number; reads?: readonly CheckRead[] } {
  let by = opts['--by'] ?? '';
  if (opts['--by'] === undefined && !opts['--from-picks']) refuse('SIGNOFF_OPTION_INVALID', 'signoff needs --by', USAGE_EXIT);
  if (by.toLowerCase() === 'agent') refuse('SIGNOFF_NOT_HUMAN', `stage ${stage}: signed by agent`);
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = preview ? { file: resolve(dir, 'project.json'), project: preview.project } : readProject(dir);
  const isReviewStage = stage === PARTS_REVIEW || stage in SIGNOFF_TARGET_KINDS;
  if (opts['--checkpoint'] === undefined && isReviewStage && project.current === undefined) {
    if (stage === PARTS_REVIEW) {
      refuseNumberedWriter(`signoff ${stage}`, `record current.parts with rig-create record parts --from <producer out> --config <rig config>, run rig-create structure-snapshot, and relay any owner chat signoff with rig-create signoff parts-review ${OWNER_CHAT_USAGE}`);
    }
    if (stage === 'rig-review') {
      refuseNumberedWriter(`signoff ${stage}`, `record current.rig with rig-create record rig --from <producer out> --config <rig config> and relay any owner chat signoff with rig-create signoff rig-review ${OWNER_CHAT_USAGE}`);
    }
    refuseNumberedWriter(`signoff ${stage}`, 'project.json has no current outputs (current.direction requires recorded current.rig, current.motion and post scene/direction) and numbered direction-review sign-offs are read-only');
  }
  const currentPartsTarget = stage === PARTS_REVIEW && project.current !== undefined;
  const currentTarget = project.current !== undefined && (currentPartsTarget || stage in SIGNOFF_TARGET_KINDS);
  const chat = readOwnerChat(opts, by, now, currentPartsTarget ? 'project.json.signoffs.parts-review' : 'project.json.signoffs', currentPartsTarget);
  if (currentTarget && !chat) {
    refuse('OWNER_CHAT_REQUIRED', `project.json.signoffs.${stage}: signing a current output requires the owner's relayed words; use ${OWNER_CHAT_USAGE}`, USAGE_EXIT);
  }
  const original = opts['--from-picks'] ? readFileSync(file) : undefined;
  // A plan publication may still display the record while its questions are pending.
  if ((preview === undefined || preview.resign) && opts['--checkpoint'] === undefined && isOpenInterviewStage(stage)) {
    const split = hasStageOrder(project);
    const pending = collectItems(project, { collection: loadCollection(dir) }).find(item =>
      interviewStageOfGuide(item.id, item.kind === 'post', split) === stage && pendingInterviewOptions(item));
    if (pending) refuse('SIGNOFF_REASK_PENDING', `project.json.${pendingInterviewOptionsPath(pending)}: ${stage} has a pending option set for ${pending.id}; ask the owner in chat (optionally showing images with rig-create job open --question ${pending.id}) and relay the owner's pick with rig-create interview-answer ${pending.id} --owner-chat before signing`);
  }
  // The record as read: its refusals are the baseline the candidate is judged against below.
  const asRead = preview?.resign?.baseline ?? checkProject(dir, project, { now, readOnly: preview !== undefined });
  const picks = opts['--from-picks'] ? pickSignoffEvidence(dir, project, stage, now) : null;
  if (opts['--from-picks']) {
    if (!picks || project.stage !== stage || asRead.effective_stage !== stage) {
      refuse('SIGNOFF_PICKS_REQUIRED', `project.json.review_acts: ${stage} needs a current ingested owner pick for every interview answer; record the picks before signing`);
    }
    by = picks.by;
    const missing = missingPickSignoffSteps(project, stage);
    if (missing.length) refuse('SIGNOFF_PICKS_PLAN_INCOMPLETE', `project.json.plan.steps: add the required steps ${missing.join(', ')} before signing ${stage}`);
  }
  if (picks && stage === 'interview') assertInterviewRecordSignable(project, asRead);
  if (!Array.isArray(project.signoffs)) refuse('SIGNOFF_MALFORMED', 'signoffs must be a list');
  const checkpointId = opts['--checkpoint'];
  if (checkpointId !== undefined) {
    if (opts['--steps'] !== undefined) refuse('SIGNOFF_OPTION_INVALID', '--checkpoint and --steps cannot be combined', USAGE_EXIT);
    // The publications declare checkpoint subjects with this same rule (src/signable.ts).
    const problem = checkpointProblem(project, stage, checkpointId);
    if (problem !== null) refuse('SIGNOFF_CHECKPOINT_INVALID', problem);
  }
  if (opts['--structure-file'] !== undefined && stage !== PARTS_REVIEW) refuse('SIGNOFF_OPTION_INVALID', '--structure-file requires parts-review', USAGE_EXIT);
  const phase = stage === 'post-interview' ? 'post' : ['plan-approved', 'rigging-interview'].includes(stage) ? 'rig' : undefined;
  if (phase === undefined && opts['--steps'] !== undefined) refuse('SIGNOFF_OPTION_INVALID', '--steps requires plan-approved, rigging-interview or post-interview', USAGE_EXIT);
  const requested = opts['--steps']?.split(',');
  if (requested !== undefined && (requested.some((id) => id === '') || new Set(requested).size !== requested.length)) refuse('SIGNOFF_STEP_INVALID', '--steps needs distinct non-empty step ids', USAGE_EXIT);
  const steps = phase === undefined ? [] : asArray(isObject(project.plan) ? project.plan.steps : undefined)
    .filter((step): step is JsonObject => isObject(step) && step.phase === phase && approvalStageOfStep(phase as 'rig' | 'post', String(step.id), hasStageOrder(project) || stage === 'rigging-interview') === stage);
  for (const id of requested ?? []) {
    if (!steps.some((step) => step.id === id)) refuse('SIGNOFF_STEP_INVALID', `${id}: no step in phase ${phase}`);
  }
  const covered = steps.filter((step) => requested === undefined || requested.includes(step.id as string));
  const emptyPost = stage === 'post-interview' && requested === undefined && steps.length === 0
    && postNotPassed({ items: collectItems(project, { collection: loadCollection(dir) }) });
  if (phase !== undefined && covered.length === 0 && !emptyPost) refuse('SIGNOFF_STEP_INVALID', `no ${phase} steps to sign`);
  const ids = covered.map((step) => step.id);
  if (ids.some((id) => typeof id !== 'string' || id === '') || new Set(ids).size !== ids.length) refuse('SIGNOFF_STEP_INVALID', 'covered steps need distinct non-empty string ids');
  for (const step of covered) {
    if (typeof step.checkpoint_proposed !== 'boolean') refuse('SIGNOFF_CHECKPOINT_INVALID', `${String(step.id)}: checkpoint_proposed must be boolean`);
    const checkpoint = classify(step.checkpoint, { collection: null });
    if (checkpoint.state === 'silent') continue;
    const value = checkpoint.state === 'user' ? checkpoint.answer.value
      : checkpoint.state === 'delegated' && checkpoint.decided && isObject(checkpoint.answer.agent_decision) ? checkpoint.answer.agent_decision.value : undefined;
    if (typeof value !== 'boolean') refuse('SIGNOFF_CHECKPOINT_INVALID', `${String(step.id)}: checkpoint needs a boolean user answer or a decided boolean delegation`);
  }
  const verbatim = preview ? 'Publication preflight stand-in.' : chat ? String(chat.owner_words) : picks ? picks.verbatim : readVerbatim(opts['--verbatim-file'] ?? '-');
  const at = new Date(now).toISOString();
  const hashes: JsonObject = Object.create(null) as JsonObject;
  for (const step of covered) {
    if (step.checkpoint === null || step.checkpoint === undefined) {
      step.checkpoint = { delegated: false, by, at, verbatim, value: step.checkpoint_proposed };
    }
    hashes[step.id as string] = stepHash(step);
  }
  const signoff: JsonObject = { stage, checkpoint: checkpointId ?? null, by, at, verbatim };
  if (picks) signoff.evidence = picks.evidence;
  if (chat) { signoff.source = chat.source!; signoff.said_at = chat.said_at!; signoff.relayed_by = chat.relayed_by!; }
  if (phase !== undefined) {
    signoff.steps = ids;
    signoff.step_hashes = hashes;
  }
  const prepare = () => {
    const answerHashes = selectAnswerHashes(dir, project, signoff, picks?.questions);
    if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
    if (stage === 'rigging-interview') {
      const errors: Finding[] = [];
      const context = riggingContext(dir, project, at, errors);
      if (errors[0] !== undefined) refuse(errors[0].code, errors[0].message);
      if (context !== null) { signoff.accepted_parts = context.accepted_parts as JsonObject; signoff.structure = context.structure as JsonObject; }
      if (!isObject(project.interview)) refuse('RIGGING_INTERVIEW_CONTEXT', 'interview: restore the interview record before adoption');
      project.interview.rigging_context = context;
      if (!hasStageOrder(project)) project.interview.order = { spec: STAGE_ORDER_SPEC, adopted_at: at };
      project.stage_values = [...STAGE_VALUES];
    }
    assertCorrectionApproval(dir, project, stage, now, signoff);
    const target = selectSignoffTarget(dir, project, stage);
    if (target !== undefined) signoff.target = target;
    if (currentPartsTarget && target !== undefined) {
      signoff.structure = currentPartsStructureBinding(dir, project, target, opts['--structure-file'], now);
    }
    return target;
  };
  // Capture signing evidence, while keeping unrelated producer-output validation outside the record closure.
  const prepared = preview ? recordCheckReads(dir, prepare) : { value: prepare(), reads: [] };
  project.signoffs.push(signoff);
  const pair = signoffPairFinding(project, signoff, `signoffs[${project.signoffs.length - 1}]`, true);
  if (pair) refuse(pair.code, pair.message);
  const candidateRefusals = assertSignoffCandidate(dir, asRead, project, signoff, covered, now);
  if (preview?.resign) {
    const clear = preview.resign.clear ?? asRead.refusals.filter(finding => {
      const stale = staleSignoffAnswer(finding);
      const prior = stale && (project.signoffs as JsonObject[])[stale.index];
      return isObject(prior) && prior.stage === stage;
    });
    const keys = new Set(clear.map(findingKey));
    const remaining = preview.resign.baseline ? candidateRefusals[0] : candidateRefusals.find(finding => keys.has(findingKey(finding)));
    if (remaining) refuse(remaining.code, remaining.message);
  }
  if (preview) return { stdout: '', exit: 0, reads: prepared.reads };
  if (picks) commitIngestedSignoff(file, original!, project);
  else writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(signoff, null, 2) : `signoff: recorded ${stage} by ${by} at ${at}; stage unchanged`, exit: 0 };
}
