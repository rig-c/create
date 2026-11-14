import { checkpointRequired } from './plan-history.ts';
/**
 * What a person can sign on the record as it stands. `signoff` uses these to
 * accept a checkpoint, and the publications use them to declare the
 * `signoff` and `checkpoint` subjects Review may ask for (docs/LIVE-REVIEW.md).
 */
import { JOB_PLAN_BOUND_SIGNOFF_STAGES, type JobSelector, type JobSubject } from '@rig-c/review/job-host';
import { asArray, collectSignoffs, isObject, type CheckReport } from './check.ts';
import { refuse } from './refusal.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { acceptedReviewVerdict } from './review.ts';
import { SIGNOFF_TARGET_KINDS } from './review-act.ts';
import { STAGES, stageOfStep } from './stages.ts';
import type { JsonObject } from './templates.ts';

/** Record-mode interview approval uses the full interview check, before any write. */
export function assertInterviewRecordSignable(project: JsonObject, report: CheckReport): void {
  if (project.stage !== 'interview' || report.effective_stage !== 'interview') {
    refuse('REVIEW_ACT_TARGET_MISMATCH', 'project.json.stage: the displayed interview sign-off requires stage interview; publish and sign the current stage in Review');
  }
  if (!asArray(isObject(project.plan) ? project.plan.steps : undefined).length) {
    refuse('INTERVIEW_SIGNOFF_PLAN_REQUIRED', 'project.json.plan.steps: interview record sign-off needs displayed plan steps; draft the plan through the writers and publish it with job open --plan');
  }
  if (report.refusals.length || report.holes?.length) {
    const finding = report.refusals[0] ?? report.holes![0]!;
    refuse('INTERVIEW_SIGNOFF_NOT_CLEAN', `project.json: interview --check reports ${finding.code} at ${finding.path}; resolve the interview check and publish the current record again`);
  }
}

/** Why `signoff <stage> --checkpoint <id>` refuses the step, or null when it can sign it. */
export function checkpointProblem(project: JsonObject, stage: string, id: string, now = Infinity): string | null {
  const spec = STAGES.find(spec => spec.id === stage);
  const matches = asArray(isObject(project.plan) ? project.plan.steps : undefined)
    .filter((step): step is JsonObject => isObject(step) && step.id === id);
  const step = matches[0];
  if (matches.length !== 1 || spec?.phase === undefined || step.phase !== spec.phase || stageOfStep(spec.phase, id) !== stage) {
    return `${id}: no unique step runs in stage ${stage}`;
  }
  return checkpointRequired(project, step, now) ? null : `${id}: checkpoint must be enabled before it can be signed`;
}

/** An enabled, unwithdrawn checkpoint in `stage` that has no live checkpoint signature yet. */
export function checkpointSignable(project: JsonObject, stage: string | null, id: string, now = Infinity): boolean {
  if (stage === null || checkpointProblem(project, stage, id, now) !== null) return false;
  const reopens = collectReopens(project, []);
  return !collectSignoffs(project, []).some(signature => signature.stage === stage && signature.checkpoint === id
    && liveSignoff(reopens, signature.stage, signature.at));
}

/** Whether the displayed version still needs a live accepted review verdict for `stage`. */
export function reviewVerdictSignable(project: JsonObject, n: number, stage: 'rig-review' | 'direction-review'): boolean {
  const version = asArray(project.versions).filter(isObject).find(v => v.n === n);
  if (!version) return true;
  const index = acceptedReviewVerdict(version, stage);
  const verdict = index >= 0 ? asArray(version.verdicts)[index] : undefined;
  if (!isObject(verdict)) return true;
  const reopens = collectReopens(project, []);
  const versionAt = Date.parse(String(version.at));
  return (Number.isFinite(versionAt) && !liveSignoff(reopens, stage === 'direction-review' ? 'post' : 'rig-review', versionAt))
    || !liveSignoff(reopens, stage, Date.parse(String(verdict.at)));
}

/** A stage closed by a sign-off that has no live stage-level signature yet. */
export function stageSignable(project: JsonObject, stage: string | null): boolean {
  if (stage === null || !STAGES.some(spec => spec.id === stage && spec.closed_by === 'signoff')) return false;
  const reopens = collectReopens(project, []);
  return !collectSignoffs(project, []).some(signature => signature.stage === stage && signature.checkpoint === null
    && liveSignoff(reopens, signature.stage, signature.at));
}

/**
 * The `checkpoint` and `signoff` subjects a package publication declares, for the
 * record's effective stage: every checkpoint `signoff` accepts in that stage, and
 * the stage itself while it is signable. rig-review and direction-review sign the
 * displayed version, so only a rig or post selector carries them, and a plan-bound
 * stage needs displayed plan steps (Review's `bindJobAsk` refuses one without).
 */
export function packageSignSubjects(project: JsonObject, stage: string | null, selector: JobSelector, planSteps: number): JobSubject[] {
  if (stage === null) return [];
  const subjects: JobSubject[] = asArray(isObject(project.plan) ? project.plan.steps : undefined)
    .filter((step): step is JsonObject => isObject(step) && typeof step.id === 'string' && checkpointSignable(project, stage, step.id))
    .map(step => ({ kind: 'checkpoint', checkpointId: String(step.id) }));
  const target = SIGNOFF_TARGET_KINDS[stage];
  if (stageSignable(project, stage) && (target === undefined || selector.kind === target)
    && (!(JOB_PLAN_BOUND_SIGNOFF_STAGES as readonly string[]).includes(stage) || planSteps > 0)) subjects.push({ kind: 'signoff', stage });
  return subjects;
}
