import { checkpointRequired } from './plan-history.ts';
/**
 * What a person can sign on the record as it stands. `signoff` uses these to
 * accept a checkpoint, and the publications use them to declare the
 * `signoff` and `checkpoint` subjects Review may ask for (docs/LIVE-REVIEW.md).
 */
import { JOB_PLAN_BOUND_SIGNOFF_STAGES, type JobSelector, type JobSubject } from '@rig-c/review/job-host';
import { asArray, collectSignoffs, isObject } from './check.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { SIGNOFF_TARGET_KINDS } from './review-act.ts';
import { STAGES, stageOfStep } from './stages.ts';
import type { JsonObject } from './templates.ts';

/** Why `signoff <stage> --checkpoint <id>` refuses the step, or null when it can sign it. */
export function checkpointProblem(project: JsonObject, stage: string, id: string): string | null {
  const spec = STAGES.find(spec => spec.id === stage);
  const matches = asArray(isObject(project.plan) ? project.plan.steps : undefined)
    .filter((step): step is JsonObject => isObject(step) && step.id === id);
  const step = matches[0];
  if (matches.length !== 1 || spec?.phase === undefined || step.phase !== spec.phase || stageOfStep(spec.phase, id) !== stage) {
    return `${id}: no unique step runs in stage ${stage}`;
  }
  return checkpointRequired(project, step) ? null : `${id}: checkpoint must be enabled before it can be signed`;
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
    .filter((step): step is JsonObject => isObject(step) && typeof step.id === 'string' && checkpointProblem(project, stage, step.id) === null)
    .map(step => ({ kind: 'checkpoint', checkpointId: String(step.id) }));
  const target = SIGNOFF_TARGET_KINDS[stage];
  if (stageSignable(project, stage) && (target === undefined || selector.kind === target)
    && (!(JOB_PLAN_BOUND_SIGNOFF_STAGES as readonly string[]).includes(stage) || planSteps > 0)) subjects.push({ kind: 'signoff', stage });
  return subjects;
}
