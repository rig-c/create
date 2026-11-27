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
import { rigVerdictIngestible } from './signable.ts';
import { selectSignoffTarget } from './signoff-target.ts';
import { signoffPairFinding } from './signoff-pair.ts';
import type { JsonObject } from './templates.ts';

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
