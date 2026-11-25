import { checkpointRequired } from './plan-history.ts';
/**
 * Stored-act and writer signability checks for legacy sign-off and verdict routes.
 */
import { asArray, isObject, type CheckReport } from './check.ts';
import { refuse } from './refusal.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { acceptedReviewVerdict } from './review.ts';
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

/** An approved rig-review verdict act ingests only at effective rig-review (#754). */
export function rigVerdictIngestible(effectiveStage: string | null): boolean {
  return effectiveStage === 'rig-review';
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
