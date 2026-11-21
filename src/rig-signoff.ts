/** A fresh rig approval signs the same reviewed version in the verdict writer's transaction. */
import { asArray, checkProject, isObject, type CheckReport } from './check.ts';
import { readFileSync } from './check-reads.ts';
import { join } from 'node:path';
import { assertCorrectionApproval } from './correction-writers.ts';
import { assertDirectionApproval } from './direction.ts';
import { readAcknowledgedPublication } from './job-outbox.ts';
import { assertSignoffCandidate } from './parts-signoff.ts';
import { refuse } from './refusal.ts';
import { matchesActProjectSource, rigVerdictSignoff, type ReviewVerdictAct } from './review-act.ts';
import { assertRigReviewSignable } from './review.ts';
import { effectiveBar } from './plan-bar-amendments.ts';
import { shellWord } from './job-acts.ts';
import { reviewVerdictSignable, rigVerdictIngestible } from './signable.ts';
import { stageIndex, stageOfStep } from './stages.ts';
import type { Finding } from './check.ts';
import { selectSignoffTarget } from './signoff-target.ts';
import { signoffPairFinding } from './signoff-pair.ts';
import type { JsonObject } from './templates.ts';

/**
 * JOB_RIG_VERDICT_DEFERRED: the rig page leaves out its review-verdict ask because the
 * record is not at effective rig-review. `job open --rig <n>` prints it as a WARN; a bound
 * writer whose page would then ask nothing refuses with it. It names the stage and the
 * rigging bars that still block the move. Null when the ask is declared or not needed.
 */
export function rigVerdictDeferred(root: string, project: JsonObject, effectiveStage: string | null, n: number, now: number, replacing?: string): Finding | null {
  if (rigVerdictIngestible(effectiveStage) || !reviewVerdictSignable(project, n, 'rig-review')) return null;
  const shown = `stage ${String(project.stage)}${effectiveStage !== project.stage ? ` (effective ${String(effectiveStage)})` : ''}`;
  const open = `rig-create job open ${shellWord(root)} --rig ${n}`;
  let route: string;
  if (stageIndex(String(effectiveStage)) < stageIndex('rig-review')) {
    const unmet = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject)
      .filter(step => (step.phase === 'rig' || step.phase === 'post') && stageOfStep(step.phase, String(step.id)) === 'rigging' && step.status !== 'done')
      .map(step => `plan.steps[${String(step.id)}] is ${String(step.status ?? 'pending')}, bar ${JSON.stringify(effectiveBar(project, step, now))}`);
    route = `${unmet.length ? `unmet bars before rig-review: ${unmet.join('; ')}; meet them, then ` : ''}run rig-create advance rig-review ${shellWord(root)} and ${open} again`;
  } else {
    route = `follow rig-create next ${shellWord(root)} back to rig-review before ${open}`;
  }
  const path = `versions[v${n}]`;
  const lead = replacing === undefined
    ? `${shown} publishes rig v${n} without its review-verdict rig-review ask`
    : `${shown} would replace open publication ${replacing} with rig v${n} and nothing to ask: its review-verdict rig-review ask`;
  return { code: 'JOB_RIG_VERDICT_DEFERRED', path, message: `${path}: ${lead}, which review --from-review could not ingest here; the verdict becomes askable at rig-review: ${route}${replacing === undefined ? '' : `; or keep the open page, or close it with rig-create job close ${shellWord(root)} to record without publishing`}` };
}

/** Missing retained subjects and the old two-subject publication keep their separate signing contract. */
export function foldsRigVerdict(root: string, project: JsonObject, act: ReviewVerdictAct, now: number): CheckReport | null {
  if (act.value.stage !== 'rig-review' || act.value.verdict !== 'approved') return null;
  const publication = readAcknowledgedPublication(root, act.jobId, act.publicationId);
  if (!publication?.subjects?.some(subject => subject.kind === 'review-verdict' && subject.stage === 'rig-review')
    || publication.subjects.some(subject => subject.kind === 'signoff' && subject.stage === 'rig-review')) return null;
  if (!matchesActProjectSource(act, readFileSync(join(root, 'project.json')))) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: rig approval predates the current record; publish the current rig-review record and ask again');
  const asRead = checkProject(root, project, { now });
  if (!rigVerdictIngestible(asRead.effective_stage)) refuse('REVIEW_ACT_TARGET_MISMATCH', 'project.json.stage: this rig approval requires effective rig-review; restore the ready rig-review stage, publish its current record and ask again');
  return asRead;
}

/** Reuse the separate writer's gates before its candidate check, against the pre-write baseline. */
export function foldRigSignoff(root: string, candidate: JsonObject, act: ReviewVerdictAct, original: Buffer, asRead: CheckReport, now: number): void {
  if (!matchesActProjectSource(act, original)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: rig approval predates the current record; publish the current rig-review record and ask again');
  const lag = asRead.refusals.find(f => f.code === 'STAGE_LAGGING');
  if (lag) refuse(lag.code, lag.message);
  if (!Array.isArray(candidate.signoffs)) refuse('SIGNOFF_MALFORMED', 'project.json.signoffs: expected a list; restore recorded signatures before ingesting the verdict');
  const selector = act.source.selector;
  if (selector?.kind !== 'rig') refuse('REVIEW_ACT_TARGET_MISMATCH', 'project.json.signoffs.target: rig approval must display a rig version; publish the current rig and ask again');
  const signoff = rigVerdictSignoff(act);
  assertDirectionApproval(root, candidate, 'rig-review', now);
  assertCorrectionApproval(root, candidate, 'rig-review', now, signoff);
  assertRigReviewSignable(candidate, `signoffs[${candidate.signoffs.length}]`);
  signoff.target = selectSignoffTarget(root, candidate, 'rig-review', String(selector.version))!;
  const receipt = asArray(candidate.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === act.actId)!;
  receipt.signoff = candidate.signoffs.length;
  candidate.signoffs.push(signoff);
  const pair = signoffPairFinding(candidate, signoff, `signoffs[${candidate.signoffs.length - 1}]`, true);
  if (pair) refuse(pair.code, pair.message);
  assertSignoffCandidate(root, asRead, candidate, signoff, [], now);
}
