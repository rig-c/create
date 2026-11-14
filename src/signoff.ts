import { latestPartsVerdictFinding, recordedPartsVerdict } from './parts-verdict-record.ts';
import { selectAnswerHashes } from './signoff-answers.ts';
import { selectSignoffTarget } from './signoff-target.ts';
import { signoffPairFinding } from './signoff-pair.ts';
import { assertDirectionApproval } from './direction.ts';
import { assertCorrectionApproval } from './correction-writers.ts';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { acquireBoundJobWrite } from './job-writer.ts';
import { assertInterviewRecordSignable, checkpointProblem } from './signable.ts';
import { checkpointReceipt, commitIngestedSignoff, ingestCheckpointAct, type CheckpointIngest, type SignoffHooks } from './signoff-checkpoint-act.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { jobHash } from './job-outbox.ts';
import { assertActSubjectDeclared, decodeReviewAct, fetchReviewActBytes, isRecordDirectionSignoff, isRecordInterviewSignoff, recordSignoffActVersion, PLAN_BOUND_SIGNOFF_STAGES, reviewActFindings, reviewActSignoff, reviewActTransport, SIGNOFF_TARGET_KINDS, signoffActIdentity, signoffActVersion, type ReviewActTransport, type SignoffAct } from './review-act.ts';

import { asArray, checkProject, classify, collectItems, collectSignoffs, isObject, loadCollection, postNotPassed, type Finding } from './check.ts';
import { checkDiffMap } from './diff-map.ts';
import { readProject } from './feedback.ts';
import { checkStructure, riggingContext, structurePathIsIgnored } from './structure.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { approvalStageOfStep, hasStageOrder, PARTS_REVIEW, RIG_REVIEW, STAGE_ORDER_SPEC, STAGE_VALUES } from './stages.ts';
import { assertRigReviewSignable } from './review.ts';
import { furthestStageSignoff } from './stage-progress.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { stepHash } from './step-hash.ts';
import type { JsonObject } from './templates.ts';

export const SIGNOFF_HELP = `signoff:
  <stage> [<project dir>]  record a human signature without moving project.stage
  --version <n>           reviewed rig or post version (single candidate defaults)
  --from-review <actId>   without --checkpoint: record the person's Review signoff act for <stage>
                          (excludes --by, --verbatim-file and --steps on both routes)
  --by <who>              the person signing (agent is refused)
  --verbatim-file <file>  UTF-8 words unchanged, or - for stdin (default: stdin)
  --steps <id,id,...>      narrow parts plan, rigging-interview rig steps, or post steps
  --checkpoint <id>       sign an enabled checkpoint in this execution stage
  --from-review <actId>   with --checkpoint: record the passed Review checkpoint act (no --by or --verbatim-file)
  --draft <id>            labelled draft with a recorded parts-review API receipt
  --structure-file <path> retained structure decisions snapshot
  --json                  print the signature as JSON
  The clock supplies at. With no --steps, signs all steps of the stage's phase.
  Fills null checkpoints from checkpoint_proposed and hashes covered steps after filling.
  Existing checkpoints are preserved. Parts-review validates evidence before recording.`;

interface FetchedSignoff { act: SignoffAct; bytes: string; human: JsonObject }

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
    else if (arg === '--component' || arg === '--diff-report' || arg === '--triage-file') {
      hasDiffFlag = true;
      i++;
    } else if (arg.startsWith('--component=') || arg.startsWith('--diff-report=') || arg.startsWith('--triage-file=')) {
      hasDiffFlag = true;
    } else if (['--version', '--draft', '--structure-file', '--by', '--verbatim-file', '--steps', '--checkpoint', '--from-review'].includes(arg)) {
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
  const actId = opts['--from-review'];
  if (actId !== undefined) {
    const mixed = ['--by', '--verbatim-file', '--steps'].filter(flag => opts[flag] !== undefined);
    if (mixed.length > 0) refuse('SIGNOFF_OPTION_INVALID', `project.json.review_acts: --from-review excludes ${mixed.join(', ')}; the person's identity, words and covered steps come from the review act`, USAGE_EXIT);
  }
  if (actId === undefined) return recordSignoff(stage, positional, opts, json, now, hooks);
  // One bound write lock per route covers the fetch, validation and the write.
  const root = resolve(positional[1] ?? process.cwd());
  const release = acquireBoundJobWrite(root);
  try {
    // With --checkpoint the passed checkpoint act is fetched inside the writer; without it, the stage signoff act.
    const review = opts['--checkpoint'] === undefined ? fetchSignoffAct(root, stage, actId, now, hooks) : undefined;
    return recordSignoff(stage, positional, opts, json, now, hooks, review);
  } finally { release(); }
}

function recordSignoff(stage: string, positional: string[], opts: Record<string, string>, json: boolean, now: number, hooks: SignoffHooks, review?: FetchedSignoff): { stdout: string; exit: number } {
  const actId = opts['--from-review'];
  let by = review === undefined ? opts['--by'] ?? '' : String(review.human.by);
  if (opts['--by'] === undefined && actId === undefined) refuse('SIGNOFF_OPTION_INVALID', 'signoff needs --by', USAGE_EXIT);
  if (by.toLowerCase() === 'agent') refuse('SIGNOFF_NOT_HUMAN', `stage ${stage}: signed by agent`);
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = readProject(dir);
  const original = actId === undefined ? undefined : readFileSync(file);
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
    // Replays dedupe before current-source checks: the recorded signoff is returned unchanged.
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
    if (review.act.schema === 'rig-review/act@4' && review.act.source.projectHash !== jobHash(original!)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: displayed signoff record differs; publish the current plan and ask again');
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
  const asRead = checkProject(dir, project, { now });
  if (review !== undefined && isRecordInterviewSignoff(review.act)) assertInterviewRecordSignable(project, asRead);
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
  let evidence: JsonObject | undefined;
  const recorded = stage === PARTS_REVIEW ? recordedPartsVerdict(dir, project, opts['--draft']) : undefined;
  evidence = recorded?.evidence;
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
  const verbatim = review !== undefined ? String(review.human.verbatim) : ingest ? ingest.verbatim : readVerbatim(opts['--verbatim-file'] ?? '-');
  const at = review !== undefined ? String(review.human.at) : ingest ? ingest.at : new Date(now).toISOString();
  const hashes: JsonObject = Object.create(null) as JsonObject;
  for (const step of covered) {
    if (step.checkpoint === null || step.checkpoint === undefined) {
      step.checkpoint = { delegated: false, by, at, verbatim, value: step.checkpoint_proposed };
    }
    hashes[step.id as string] = stepHash(step);
  }
  const signoff: JsonObject = { stage, checkpoint: checkpointId ?? null, by, at, verbatim };
  if (review !== undefined) signoff.source = review.human.source!;
  if (evidence !== undefined) signoff.evidence = evidence;
  if (phase !== undefined) {
    signoff.steps = ids;
    signoff.step_hashes = hashes;
  }
  const answerHashes = selectAnswerHashes(dir, project, signoff);
  if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
  if (stage === PARTS_REVIEW && opts['--draft'] !== undefined) signoff.draft_id = opts['--draft'];
  if (stage === PARTS_REVIEW && checkpointId === undefined) {
    const errors: Finding[] = [];
    checkDiffMap(dir, signoff, `signoffs[${project.signoffs.length}]`, recorded?.partsFile, errors, [], project);
    if (errors[0] !== undefined) refuse(errors[0].code, errors[0].message);
  }
  if (stage === PARTS_REVIEW && (hasStageOrder(project) || opts['--structure-file'] !== undefined)) {
    const path = opts['--structure-file'];
    if (path !== undefined) {
      try {
        if (structurePathIsIgnored(dir, path)) throw new Error('structure snapshots must survive a clone; retain the file outside ignored roots, for example evidence/');
        const canonical = realpathSync(resolve(dir, path));
        const rel = relative(realpathSync(dir), canonical).split(sep).join('/');
        if (isAbsolute(path) || rel === '' || rel === '..' || rel.startsWith('../')) throw new Error('structure file must stay under the project');
        signoff.structure = { path: rel, sha256: createHash('sha256').update(readFileSync(canonical)).digest('hex') };
      } catch (error) { refuse('STRUCTURE_DECISIONS_INVALID', `signoffs.structure: ${error instanceof Error ? error.message : String(error)}; retain the structure snapshot under the project`); }
    }
    const errors: Finding[] = [];
    checkStructure(dir, project, signoff, `signoffs[${project.signoffs.length}]`, errors);
    if (errors[0] !== undefined) refuse(errors[0].code, errors[0].message);
  }
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
  if (stage === RIG_REVIEW) assertRigReviewSignable(project, `signoffs[${project.signoffs.length}]`);
  const target = selectSignoffTarget(dir, project, stage, targetVersion);
  if (target !== undefined) signoff.target = target;
  if (ingest) signoff.source = ingest.source;
  project.signoffs.push(signoff);
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
  const reopens = collectReopens(project, []);
  const frontier = furthestStageSignoff(collectSignoffs(project, []).filter(s => liveSignoff(reopens, s.stage, s.at)));
  const ownLag = signoff.checkpoint === null && frontier?.index === project.signoffs.length - 1;
  const candidateRefusals = checkProject(dir, project, { now }).refusals;
  // Refusals the record already carried do not block the signature (docs/PROJECT.md); a new one does.
  const fresh = new Set(newFindings(baselineOf(asRead), candidateRefusals));
  const pendingOwnAdvance = (finding: Finding): boolean => ownLag && finding.code === 'STAGE_LAGGING';
  const progress = candidateRefusals.find(f => ['STAGE_LAGGING', 'STAGE_SKIPPED', 'STAGE_SIGNOFF_DATE_INVALID', 'ADVANCE_MALFORMED', 'STEP_STATUS_TRANSITION', 'STEP_STATUS_SIGNOFF'].includes(f.code) && !pendingOwnAdvance(f) && fresh.has(f));
  if (progress !== undefined) refuse(progress.code, progress.message);
  if (hasStageOrder(project) || signoff.structure !== undefined || project.amendments !== undefined) {
    const path = `signoffs[${project.signoffs.length - 1}]`;
    const first = candidateRefusals.find(f => {
      if (pendingOwnAdvance(f)) return false;
      if (f.code.startsWith('SIGNOFF_ANSWERS_')) return f.path.startsWith(`${path}.`);
      // A covered step this signature leaves unapproved is its own failure, even when the record carried it.
      if (f.code === 'GUIDE_CHANGED_UNSIGNED') return covered.some(step => f.path === `plan.steps[${String(step.id)}]`);
      return fresh.has(f);
    });
    if (first !== undefined) refuse(first.code, first.message);
  }
  if (ingest) commitIngestedSignoff(file, original!, project);
  else {
    if (review !== undefined && !readFileSync(file).equals(original!)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during signoff validation; retry against the current live job');
    writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  }
  return { stdout: json ? JSON.stringify(signoff, null, 2) : `signoff: recorded ${stage} by ${by} at ${at}; stage unchanged`, exit: 0 };
}
