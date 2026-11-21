import { missingPickSignoffSteps, pickSignoffEvidence } from './pick-signoff.ts';
import { OWNER_CHAT_FLAGS, readOwnerChat, assertOwnerChatSignoff } from './owner-chat.ts';
import { pendingInterviewOptions, pendingInterviewOptionsPath } from './choices.ts';
import { assertSignoffCandidate, bindPartsSignoff } from './parts-signoff.ts';
import { currentPartsAmendment } from './parts-act.ts';
import { latestPartsVerdictFinding, partsReceiptDraftId, recordedPartsActReceipt, recordedPartsVerdict } from './parts-verdict-record.ts';
import { selectAnswerHashes } from './signoff-answers.ts';
import { selectSignoffTarget } from './signoff-target.ts';
import { assembleOnlyDraftTarget, assertDraftHasRig } from './draft-layout.ts';
import { signoffPairFinding } from './signoff-pair.ts';
import { assertDirectionApproval } from './direction.ts';
import { assertCorrectionApproval } from './correction-writers.ts';
import { writeFileSync } from 'node:fs';
import { readFileSync, recordCheckReads, type CheckRead } from './check-reads.ts';
import { acquireBoundJobWrite, beginJobProgress } from './job-writer.ts';
import { assertInterviewRecordSignable, checkpointProblem } from './signable.ts';
import { checkpointReceipt, commitIngestedSignoff, ingestCheckpointAct, type CheckpointIngest, type SignoffHooks } from './signoff-checkpoint-act.ts';
import { resolve } from 'node:path';
import { jobHash } from './job-outbox.ts';
import { assertActSubjectDeclared, decodeReviewAct, fetchReviewActBytes, isRecordDirectionSignoff, isRecordInterviewSignoff, matchesActProjectSource, partsVerdictSignoff, recordSignoffActVersion, PLAN_BOUND_SIGNOFF_STAGES, reviewActFindings, reviewActSignoff, reviewActTransport, SIGNOFF_TARGET_KINDS, signoffActIdentity, signoffActVersion, type ReviewActTransport, type SignoffAct } from './review-act.ts';

import { asArray, checkProject, classify, collectItems, isObject, loadCollection, postNotPassed, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { riggingContext } from './structure.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { approvalStageOfStep, hasStageOrder, interviewStageOfGuide, isOpenInterviewStage, PARTS_REVIEW, PAUSED_STAGE, RIG_REVIEW, STAGE_ORDER_SPEC, STAGE_VALUES } from './stages.ts';
import { assertRigReviewSignable } from './review.ts';
import { stepHash } from './step-hash.ts';
import type { JsonObject } from './templates.ts';

export const SIGNOFF_HELP = `signoff:
  <stage> [<project dir>]  record a human signature without moving project.stage
  --version <n>           reviewed rig or post version (single candidate defaults)
  --from-review <actId>   without --checkpoint: record the person's Review signoff act for <stage>
                          (excludes --by, --verbatim-file and --steps on both routes)
  --from-picks            derive a stage signature from recorded owner picks
  --by <who>              the person signing (agent is refused)
  --verbatim-file <file>  UTF-8 words unchanged, or - for stdin (default: stdin)
  --owner-chat <file>     relay exact owner words (excludes --verbatim-file / --from-review)
  --said-at <ISO date>    explicit owner clock; at remains the write time
  --relayed-by <who>     operator relaying the owner chat
  --steps <id,id,...>      narrow parts plan, rigging-interview rig steps, or post steps
  --checkpoint <id>       sign an enabled checkpoint in this execution stage
  --from-review <actId>   with --checkpoint: record the passed Review checkpoint act (no --by or --verbatim-file)
  --draft <id>            labelled draft with a recorded parts-review API receipt
                         with --from-review, may carry a retained verdict after its owner amendment
  --structure-file <path> retained structure decisions snapshot
  --json                  print the signature as JSON
  The clock supplies at. With no --steps, signs all steps of the stage's phase.
  Fills null checkpoints from checkpoint_proposed and hashes covered steps after filling.
  Existing checkpoints are preserved. Parts-review validates evidence before recording.`;

interface FetchedSignoff { act: SignoffAct; bytes: string; human: JsonObject }
interface RetainedPartsSignoff { file: string; project: JsonObject; original: Buffer; receipt: JsonObject }

/** Fetch and decode a finalized signoff act; its stage, words, identity and date are the person's, never flags. */
function fetchSignoffAct(dir: string, stage: string, actId: string, now: number, hooks: SignoffHooks): FetchedSignoff {
  const invalid = reviewActFindings(readProject(dir).project)[0];
  if (invalid) refuse(invalid.code, invalid.message);
  const transport: ReviewActTransport = { ...reviewActTransport(dir, actId), kind: 'signoff' };
  const bytes = hooks.fetch ? hooks.fetch(transport).bytes : fetchReviewActBytes(transport);
  const act = decodeReviewAct(bytes, 'signoff');
  if (act.jobId !== transport.jobId || act.actId !== transport.actId || Date.parse(act.at) > now) {
    refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: fetched signoff identity or date differs from the request; fetch the correct signoff act');
  }
  if (act.value.stage !== stage) refuse('REVIEW_ACT_KIND_MISMATCH', `project.json.review_acts: act signs ${act.value.stage}, not ${stage}; invoke signoff for the stage the person approved`);
  assertActSubjectDeclared(dir, act, 'project.json.review_acts');
  return { act, bytes, human: reviewActSignoff(act) };
}

export function signoffCommand(args: string[], now: number, hooks: SignoffHooks = {}): { stdout: string; exit: number } {
  if (args.some(arg => arg === '--evidence' || arg.startsWith('--evidence='))) refuse('PARTS_VERDICT_FILE_ROUTE_REMOVED', 'project.json.signoffs.evidence: --evidence was removed; record the API response with parts-review and select it with --draft', USAGE_EXIT);
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  let hasDiffFlag = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
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
    } else if (['--version', '--draft', '--structure-file', '--by', '--verbatim-file', '--steps', '--checkpoint', '--from-review', ...OWNER_CHAT_FLAGS].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value === '') refuse('SIGNOFF_OPTION_INVALID', `${arg} needs one non-empty value`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `signoff does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const stage = positional[0];
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
  const actId = opts['--from-review'];
  if (actId !== undefined) {
    const mixed = ['--by', '--verbatim-file', '--steps', ...OWNER_CHAT_FLAGS].filter(flag => opts[flag] !== undefined);
    if (mixed.length > 0) refuse('SIGNOFF_OPTION_INVALID', `project.json.review_acts: --from-review excludes ${mixed.join(', ')}; the person's identity, words and covered steps come from the review act`, USAGE_EXIT);
  }
  if (actId === undefined && !opts['--from-picks']) return recordSignoff(stage, positional, opts, json, now, hooks);
  // One bound write lock per route covers the fetch, validation and the write.
  const root = resolve(positional[1] ?? process.cwd());
  const release = acquireBoundJobWrite(root);
  // The first milestone waits for the job gate: a refused write leaves the project untouched.
  const progress = actId !== undefined ? beginJobProgress(root, 'ingest', 'Reading the Review signoff') : undefined;
  try {
    if (stage === PARTS_REVIEW && actId !== undefined && opts['--checkpoint'] === undefined) {
      const { file } = readProject(root);
      const original = readFileSync(file);
      const project = JSON.parse(original.toString('utf8')) as JsonObject;
      const receipt = recordedPartsActReceipt(project, actId);
      const amendment = currentPartsAmendment(project, now);
      const amendedDraft = amendment?.target.kind === 'draft' ? String(amendment.target.id) : undefined;
      if (receipt) {
        const recordedDraft = partsReceiptDraftId(receipt);
        const target = receipt.signoff === undefined ? amendedDraft ?? recordedDraft : recordedDraft;
        if (target !== undefined) opts['--draft'] ??= target;
        const result = recordSignoff(stage, positional, opts, json, now, hooks, undefined, undefined, { file, project, original, receipt });
        progress?.('Review signoff recorded');
        return result;
      }
      if (amendedDraft !== undefined && checkProject(root, project, { now }).effective_stage === PARTS_REVIEW) {
        refuse('PARTS_VERDICT_RECEIPT_REQUIRED', `project.json.review_acts: parts verdict act ${actId} was not ingested; record it with parts-review --from-review before signing the amendment`);
      }
    }
    // With --checkpoint the passed checkpoint act is fetched inside the writer; without it, the stage signoff act.
    const review = actId !== undefined && opts['--checkpoint'] === undefined ? fetchSignoffAct(root, stage, actId, now, hooks) : undefined;
    const result = recordSignoff(stage, positional, opts, json, now, hooks, review);
    progress?.('Review signoff recorded');
    return result;
  } finally { release(); }
}

/** Run the ingest writer's candidate gate with a stand-in signature, without writing or inventing an owner act. */
export function assertPlanSignoffCandidate(dir: string, project: JsonObject, stage: string, now: number): readonly CheckRead[] {
  return recordSignoff(stage, [stage, dir], { '--by': 'publication-preflight' }, false, now, {}, undefined, structuredClone(project)).reads ?? [];
}

function recordSignoff(stage: string, positional: string[], opts: Record<string, string>, json: boolean, now: number, hooks: SignoffHooks, review?: FetchedSignoff, preview?: JsonObject, retained?: RetainedPartsSignoff): { stdout: string; exit: number; reads?: readonly CheckRead[] } {
  const actId = opts['--from-review'];
  let by = review === undefined ? opts['--by'] ?? '' : String(review.human.by);
  if (opts['--by'] === undefined && actId === undefined && !opts['--from-picks']) refuse('SIGNOFF_OPTION_INVALID', 'signoff needs --by', USAGE_EXIT);
  if (by.toLowerCase() === 'agent') refuse('SIGNOFF_NOT_HUMAN', `stage ${stage}: signed by agent`);
  const dir = resolve(positional[1] ?? process.cwd());
  const chat = readOwnerChat(opts, by, now, 'project.json.signoffs');
  const { file, project } = retained ?? (preview ? { file: resolve(dir, 'project.json'), project: preview } : readProject(dir));
  if (stage in SIGNOFF_TARGET_KINDS) {
    const selector = review?.act.source.selector;
    const draftId = selector?.kind === 'draft' ? selector.id : opts['--draft'];
    const draft = draftId === undefined
      ? assembleOnlyDraftTarget(project, opts['--version'])
      : asArray(project.drafts).filter(isObject).find(d => d.id === draftId);
    assertDraftHasRig(draft, 'project.json.signoffs.target');
  }
  if (chat) assertOwnerChatSignoff(dir, project, stage, opts['--draft'], opts['--version']);
  const original = retained?.original ?? (actId === undefined && !opts['--from-picks'] ? undefined : readFileSync(file));
  if (retained?.receipt.signoff !== undefined) {
    const recorded = asArray(project.signoffs)[Number(retained.receipt.signoff)];
    if (!isObject(recorded)) refuse('REVIEW_ACT_LEDGER_INVALID', 'project.json.review_acts: the retained parts act has no mapped signoff; restore its recorded signature');
    if (recorded.draft_id !== opts['--draft']) {
      refuse('PARTS_VERDICT_DRAFT_MISMATCH', `project.json.signoffs.draft_id: act ${actId} already signed draft ${String(recorded.draft_id)}; replay that signoff with its recorded draft`);
    }
    recordedPartsVerdict(dir, project, opts['--draft'], recorded.evidence, { requireAvailable: false });
    return { stdout: json ? JSON.stringify(recorded, null, 2) : `signoff: ${stage} already recorded from ${String(recorded.source)}; nothing written`, exit: 0 };
  }
  const carried = retained && recordedPartsVerdict(dir, project, opts['--draft'], undefined, { carry: { receipt: retained.receipt, now } });
  const carriedHuman = carried?.carry && partsVerdictSignoff(carried.carry.act, new Date(now).toISOString(), opts['--draft']);
  if (carriedHuman) by = String(carriedHuman.by);
  let ingest: CheckpointIngest | undefined;
  // Recorded checkpoint receipts replay before current eligibility, through the same immutable-byte validator.
  if (actId !== undefined && opts['--checkpoint'] !== undefined && asArray(project.review_acts).some(entry =>
    isObject(entry) && entry.kind === 'checkpoint' && entry.actId === actId)) {
    ingest = ingestCheckpointAct(dir, project, actId, opts['--checkpoint'], now, hooks);
    if (ingest.replay) {
      if (ingest.replay.stage !== stage) refuse('SIGNOFF_CHECKPOINT_INVALID', `signoffs.checkpoint ${opts['--checkpoint']}: recorded act belongs to ${String(ingest.replay.stage)}; replay it for its original stage`);
      return { stdout: json ? JSON.stringify(ingest.replay, null, 2) : `signoff: ${stage} checkpoint ${opts['--checkpoint']} already recorded from ${ingest.source}; nothing written`, exit: 0 };
    }
  }
  // A target stage signs Review's selector or the exact displayed record, never a flag-selected replacement.
  let targetVersion = opts['--version'];
  if (review !== undefined && stage in SIGNOFF_TARGET_KINDS && !isRecordDirectionSignoff(review.act)) {
    const shown = signoffActVersion(review.act);
    const at = `signoffs[${asArray(project.signoffs).length}].target.version`;
    if (shown === null) refuse('REVIEW_ACT_TARGET_MISMATCH', `${at}: the review act names no ${SIGNOFF_TARGET_KINDS[stage]} version it displayed; ask for ${stage} again in Review on the reviewed version`);
    if (targetVersion !== undefined && targetVersion !== String(shown)) refuse('REVIEW_ACT_TARGET_MISMATCH', `${at}: --version ${targetVersion} differs from version ${shown} the person approved in Review; drop --version or ask for ${stage} on version ${targetVersion} in Review`);
    targetVersion = String(shown);
  }
  if (review !== undefined) {
    // Replays dedupe before current eligibility: the recorded signoff is returned unchanged.
    const existing = asArray(project.review_acts).filter(isObject).find(entry => entry.jobId === review.act.jobId && entry.actId === review.act.actId);
    if (existing !== undefined) {
      if (existing.bytes !== review.bytes) refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: immutable signoff act changed; restore the original receipt');
      if (isRecordDirectionSignoff(review.act)) {
        const invalid = reviewActFindings(project)[0];
        if (invalid !== undefined) refuse(invalid.code, invalid.message);
      }
      const recorded = asArray(project.signoffs).filter(isObject).find(entry => entry.source === review.human.source);
      if (recorded === undefined) refuse('REVIEW_ACT_LEDGER_INVALID', 'project.json.review_acts: the signoff this act recorded is absent; restore its signoffs[] entry');
      const pair = signoffPairFinding(project, recorded, `signoffs[${asArray(project.signoffs).indexOf(recorded)}]`, true);
      if (pair) refuse(pair.code, pair.message);
      return { stdout: json ? JSON.stringify(recorded, null, 2) : `signoff: replayed ${stage} by ${by} at ${String(recorded.at)}; stage unchanged`, exit: 0 };
    }
  }
  // A plan publication may still display the record while its questions are pending.
  if (preview === undefined && opts['--checkpoint'] === undefined && isOpenInterviewStage(stage)) {
    const split = hasStageOrder(project);
    const pending = collectItems(project, { collection: loadCollection(dir) }).find(item =>
      interviewStageOfGuide(item.id, item.kind === 'post', split) === stage && pendingInterviewOptions(item));
    if (pending) refuse('SIGNOFF_REASK_PENDING', `project.json.${pendingInterviewOptionsPath(pending)}: ${stage} has a pending option set for ${pending.id}; open it with rig-create job open --question ${pending.id} and record the owner's pick with interview-answer before signing`);
  }
  if (review !== undefined) {
    if (review.act.schema === 'rig-review/act@4' && !matchesActProjectSource(review.act, original!)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: displayed signoff record differs; publish the current plan and ask again');
    if (isRecordDirectionSignoff(review.act)) {
      const shown = recordSignoffActVersion(review.act, original!.toString('utf8'));
      if (shown === null) refuse('REVIEW_ACT_RECORD_TARGET_INVALID', 'project.json.versions: the frozen sign-off record has no single current live post with an accepted direction-review verdict; publish the corrected record after reviewing that post');
      if (targetVersion !== undefined && targetVersion !== String(shown)) refuse('REVIEW_ACT_TARGET_MISMATCH', `signoffs.target.version: --version ${targetVersion} differs from post ${shown} bound by the frozen record; drop --version and sign the displayed record`);
      targetVersion = String(shown);
    }
    if (PLAN_BOUND_SIGNOFF_STAGES.includes(stage) || isRecordInterviewSignoff(review.act)) {
      const displayed = review.act.source.plan?.steps ?? [];
      const current = asArray(isObject(project.plan) ? project.plan.steps : undefined).map(raw => ({ id: isObject(raw) ? raw.id ?? null : null, hash: isObject(raw) ? stepHash(raw) : null }));
      if (displayed.length !== current.length || displayed.some((step, index) => step.id !== current[index]!.id || step.hash !== current[index]!.hash)) {
        refuse('REVIEW_ACT_SOURCE_STALE', `signoffs[${asArray(project.signoffs).length}].step_hashes: the plan steps the person approved differ from the current plan; publish the current plan and ask for ${stage} again`);
      }
    }
  }
  if (review !== undefined && stage === PARTS_REVIEW) {
    const selector = review.act.source.selector;
    const shown = isObject(selector) && selector.kind === 'draft' && typeof selector.id === 'string' && selector.id !== '' ? selector.id : null;
    const at = `signoffs[${asArray(project.signoffs).length}].draft_id`;
    if (selector !== null && (shown === null || (opts['--draft'] !== undefined && opts['--draft'] !== shown))) {
      refuse('REVIEW_ACT_DRAFT_MISMATCH', `${at}: --draft ${opts['--draft'] ?? '<absent>'} differs from draft ${shown ?? '<non-draft>'} the person approved in Review; drop --draft or ask for parts-review on the reviewed draft in Review`);
    }
    if (shown !== null) opts['--draft'] = shown;
  }
  if (stage === PARTS_REVIEW && opts['--draft'] !== undefined) {
    const finding = latestPartsVerdictFinding(project, opts['--draft'], `signoffs[${asArray(project.signoffs).length}].draft_id`);
    if (finding) refuse(finding.code, finding.message);
  }
  // The record as read: its refusals are the baseline the candidate is judged against below.
  const asRead = checkProject(dir, project, { now, readOnly: preview !== undefined });
  if (carriedHuman && (project.stage === PAUSED_STAGE || asRead.effective_stage !== PARTS_REVIEW)) {
    refuse('PARTS_REVIEW_FOLD_NOT_READY', 'project.json.stage: carrying an amended verdict needs active parts-review; resume a paused project and amend the current parts before signing');
  }
  const picks = opts['--from-picks'] ? pickSignoffEvidence(dir, project, stage, now) : null;
  if (opts['--from-picks']) {
    if (!picks || project.stage !== stage || asRead.effective_stage !== stage) {
      refuse('SIGNOFF_PICKS_REQUIRED', `project.json.review_acts: ${stage} needs a current ingested owner pick for every interview answer; record the picks before signing`);
    }
    by = picks.by;
    const missing = missingPickSignoffSteps(project, stage);
    if (missing.length) refuse('SIGNOFF_PICKS_PLAN_INCOMPLETE', `project.json.plan.steps: add the required steps ${missing.join(', ')} before signing ${stage}`);
  }
  if ((review !== undefined && isRecordInterviewSignoff(review.act)) || (picks && stage === 'interview')) assertInterviewRecordSignable(project, asRead);
  const existingLag = asRead.refusals.find(f => f.code === 'STAGE_LAGGING');
  if (existingLag !== undefined) refuse(existingLag.code, existingLag.message);
  if (!Array.isArray(project.signoffs)) refuse('SIGNOFF_MALFORMED', 'signoffs must be a list');
  const checkpointId = opts['--checkpoint'];
  if (checkpointId !== undefined) {
    if (opts['--steps'] !== undefined) refuse('SIGNOFF_OPTION_INVALID', '--checkpoint and --steps cannot be combined', USAGE_EXIT);
    // The publications declare checkpoint subjects with this same rule (src/signable.ts).
    const problem = checkpointProblem(project, stage, checkpointId);
    if (problem !== null) refuse('SIGNOFF_CHECKPOINT_INVALID', problem);
    if (actId !== undefined) {
      ingest = ingestCheckpointAct(dir, project, actId, checkpointId, now, hooks);
      if (ingest.replay) return { stdout: json ? JSON.stringify(ingest.replay, null, 2) : `signoff: ${stage} checkpoint ${checkpointId} already recorded from ${ingest.source}; nothing written`, exit: 0 };
      by = ingest.by;
    }
  }
  if (stage === PARTS_REVIEW && !opts['--draft']) refuse('PARTS_VERDICT_RECEIPT_REQUIRED', 'project.json.signoffs.draft_id: parts-review needs --draft with a recorded API receipt');
  // Preserve refusal-before-words on the separate signing route.
  if (stage === PARTS_REVIEW && !carried) recordedPartsVerdict(dir, project, opts['--draft']);
  if ((opts['--draft'] !== undefined || opts['--structure-file'] !== undefined) && stage !== PARTS_REVIEW) refuse('SIGNOFF_OPTION_INVALID', '--draft and --structure-file require parts-review', USAGE_EXIT);
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
  const verbatim = preview ? 'Publication preflight stand-in.' : carriedHuman ? String(carriedHuman.verbatim) : review !== undefined ? String(review.human.verbatim) : ingest ? ingest.verbatim : chat ? String(chat.owner_words) : picks ? picks.verbatim : readVerbatim(opts['--verbatim-file'] ?? '-');
  const at = review !== undefined ? String(review.human.at) : ingest ? ingest.at : new Date(now).toISOString();
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
  if (review !== undefined) signoff.source = review.human.source!;
  if (carriedHuman) signoff.source = carriedHuman.source!;
  if (phase !== undefined) {
    signoff.steps = ids;
    signoff.step_hashes = hashes;
  }
  const prepare = () => {
    const answerHashes = selectAnswerHashes(dir, project, signoff, picks?.questions);
    if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
    if (stage === PARTS_REVIEW && opts['--draft'] !== undefined) signoff.draft_id = opts['--draft'];
    if (stage === PARTS_REVIEW) bindPartsSignoff(dir, project, signoff, opts['--structure-file'], carried);
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
    assertDirectionApproval(dir, project, stage, now);
    assertCorrectionApproval(dir, project, stage, now, signoff);
    if (stage === RIG_REVIEW) assertRigReviewSignable(project, `signoffs[${asArray(project.signoffs).length}]`);
    const target = selectSignoffTarget(dir, project, stage, targetVersion);
    if (target !== undefined) signoff.target = target;
    return target;
  };
  // Capture signing evidence, while keeping unrelated producer-output validation outside the record closure.
  const prepared = preview ? recordCheckReads(dir, prepare) : { value: prepare(), reads: [] };
  const target = prepared.value;
  if (ingest) signoff.source = ingest.source;
  project.signoffs.push(signoff);
  if (retained && carried?.carry) {
    retained.receipt.signoff = project.signoffs.length - 1;
    retained.receipt.signoff_amendment = { index: carried.carry.amendment, signed_at: at, draft_id: signoff.draft_id! };
    const invalid = reviewActFindings(project)[0];
    if (invalid) refuse(invalid.code, invalid.message);
  }
  if (review !== undefined) {
    project.review_acts = [...asArray(project.review_acts), { schema: 'rig-create/review-act@1', kind: 'signoff', jobId: review.act.jobId, actId: review.act.actId,
      stage, bytes: review.bytes, sha256: jobHash(review.bytes), version_hash: jobHash(JSON.stringify(signoffActIdentity(review.act))),
      ...(isRecordDirectionSignoff(review.act) ? { record_sha256: review.act.source.projectHash,
        target_version: target!.version!, verdict: target!.verdict! } : {}) }];
    const invalid = reviewActFindings(project)[0];
    if (invalid !== undefined) refuse(invalid.code, invalid.message);
  }
  if (ingest) {
    project.review_acts = [...asArray(project.review_acts), checkpointReceipt(ingest, project.signoffs.length - 1)];
    const invalid = reviewActFindings(project)[0];
    if (invalid) refuse(invalid.code, invalid.message);
  }
  const pair = signoffPairFinding(project, signoff, `signoffs[${project.signoffs.length - 1}]`, true);
  if (pair) refuse(pair.code, pair.message);
  assertSignoffCandidate(dir, asRead, project, signoff, covered, now);
  if (preview) return { stdout: '', exit: 0, reads: prepared.reads };
  if (ingest || picks || carried) commitIngestedSignoff(file, original!, project);
  else {
    if (review !== undefined && !readFileSync(file).equals(original!)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during signoff validation; retry against the current live job');
    writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  }
  const source = carried ? ` from ${String(signoff.source)} (sha256 ${String(carried.evidence.sha256)})` : '';
  return { stdout: json ? JSON.stringify(signoff, null, 2) : `signoff: recorded ${stage} by ${by} at ${at}${source}; stage unchanged`, exit: 0 };
}
