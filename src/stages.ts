import type { JsonObject } from './templates.ts';

/**
 * The project's stages, in order, and how each one is left — the one place the
 * order is written (docs/PROJECT.md § Stages). `interview --check` reads it;
 * the review order and the post hand-off (src/review.ts) read `REVIEW_ACCEPTS`
 * below rather than naming stages themselves.
 *
 * `closed_by`:
 * - `signoff`: the stage ends only on a human `signoffs[]` entry naming it
 *   with `checkpoint: null`. A project whose `stage` is past such a stage
 *   without that entry is refused (`STAGE_UNSIGNED`).
 * - `bar`: the stage ends when the last plan step it runs meets its bar; no
 *   stage-level sign-off, but a step whose checkpoint is on needs a
 *   `{ stage, checkpoint: <step id> }` entry before the next step runs
 *   (`CHECKPOINT_UNSIGNED`).
 * - `none`: terminal.
 *
 * The rig phase runs in two `bar` stages: `parts` runs the steps that make the
 * parts (`steps`), `rigging` runs the rest. A phase's stage without `steps`
 * runs every step of the phase the other stages do not name.
 */
export interface StageSpec {
  readonly id: string;
  readonly closed_by: 'signoff' | 'bar' | 'none';
  /** For a `bar` stage: the plan phase whose steps run in it. */
  readonly phase?: 'rig' | 'post';
  /** For a `bar` stage that runs only some of its phase's steps: their ids. */
  readonly steps?: readonly string[];
}

export const STAGES: readonly StageSpec[] = [
  { id: 'interview', closed_by: 'signoff' },
  { id: 'plan-approved', closed_by: 'signoff' },
  { id: 'parts', closed_by: 'bar', phase: 'rig', steps: ['seethrough', 'assemble'] },
  { id: 'parts-review', closed_by: 'signoff' },
  { id: 'rigging-interview', closed_by: 'signoff' },
  { id: 'rigging', closed_by: 'bar', phase: 'rig' },
  { id: 'rig-review', closed_by: 'signoff' },
  { id: 'post-interview', closed_by: 'signoff' },
  { id: 'post', closed_by: 'bar', phase: 'post' },
  { id: 'direction-review', closed_by: 'signoff' },
  { id: 'accepted', closed_by: 'none' },
] as const;

/** Stopped by a human sign-off; outside the order. Resuming starts at the first stage whose sign-off is missing. */
export const PAUSED_STAGE = 'paused';

/** What a record's `stage_values` is expected to hold: the order, then `paused`. */
export const STAGE_VALUES: readonly string[] = [...STAGES.map((s) => s.id), PAUSED_STAGE];

/**
 * The stages skipped when every post item is answered not applicable
 * (PROJECT.md § When post is not passed): the project moves from
 * `post-interview` straight to `accepted`.
 */
export const SKIPPED_WHEN_NO_POST: readonly string[] = ['post', 'direction-review'];

/** The stage whose sign-off approves the steps of a phase: rig steps by `plan-approved`, post steps by `post-interview`. */
export const PHASE_APPROVED_BY: Readonly<Record<'rig' | 'post', string>> = {
  rig: 'rigging-interview',
  post: 'post-interview',
};

/** The stage a step runs in (a `bar` stage of its phase), i.e. the `stage` its checkpoint sign-off names. */
export function stageOfStep(phase: 'rig' | 'post', id: string): string {
  const ofPhase = STAGES.filter((s) => s.phase === phase);
  const found = ofPhase.find((s) => s.steps?.includes(id) === true) ?? ofPhase.find((s) => s.steps === undefined);
  if (found === undefined) throw new Error(`no stage runs ${phase} step ${id}`);
  return found.id;
}

/** The sign-off a person gives on the assembled parts before any rig is built (rig-c/create#48). */
export const PARTS_REVIEW = 'parts-review';

/**
 * When `parts` and `parts-review` entered the order. A project whose first
 * `plan-approved` sign-off is dated before this passed that point when the two
 * stages did not exist: it is reported (`PARTS_REVIEW_PREDATES_STAGE`, a
 * warning), not refused, and no sign-off is assumed for it.
 */
export const PARTS_REVIEW_SINCE = '2026-11-04T00:00:00Z';

/** History entries before this date (or without a readable date) retain free-form bounces with a warning. */
export const AGENT_BOUNCE_SINCE = '2026-11-05T00:00:00Z';

export function stageIndex(id: string): number {
  return STAGES.findIndex((s) => s.id === id);
}

/**
 * The two reviews and the version kind each one accepts (PROJECT.md § Stages):
 * `rig-review` accepts one `kind: "rig"` version on its still frame, and post
 * work runs only on it; `direction-review` accepts one `kind: "post"` version.
 * A verdict's `review` names one of these keys.
 */
export const REVIEW_ACCEPTS: Readonly<Record<'rig-review' | 'direction-review', 'rig' | 'post'>> = {
  'rig-review': 'rig',
  'direction-review': 'post',
};

/** The review that accepts the rig version post work runs on. */
export const RIG_REVIEW = 'rig-review' satisfies keyof typeof REVIEW_ACCEPTS;


export const STAGE_ORDER_SPEC = 'rig-create/stage-order@1';
export const PARTS_STEPS: readonly string[] = ['seethrough', 'assemble'];
export const GUIDE_INTERVIEW: Readonly<Record<string, string>> = {
  rig_type: 'interview', reference: 'interview', seethrough: 'interview', assemble: 'interview',
  bones: 'rigging-interview', meshes: 'rigging-interview', constraints: 'rigging-interview', motion: 'rigging-interview',
};

/** Adoption is explicit, independent of dates and answer representation. */
export function hasStageOrder(project: JsonObject): boolean {
  const interview = project.interview;
  if (interview === null || typeof interview !== 'object' || Array.isArray(interview)) return false;
  const order = interview.order;
  return order !== null && typeof order === 'object' && !Array.isArray(order) && order.spec === STAGE_ORDER_SPEC;
}

/** Legacy phase=rig approvals retain their original all-step meaning. */
export function approvalStageOfStep(phase: 'rig' | 'post', id: string, newOrder = false): string {
  if (phase === 'post') return PHASE_APPROVED_BY.post;
  if (!newOrder || PARTS_STEPS.includes(id)) return 'plan-approved';
  return PHASE_APPROVED_BY.rig;
}

export function interviewStageOfGuide(id: string, post = false, newOrder = false): string {
  if (post) return 'post-interview';
  return newOrder ? GUIDE_INTERVIEW[id] ?? 'rigging-interview' : 'interview';
}

/** Frozen order used by projects that have not adopted the split interview. */
export const LEGACY_STAGES = STAGES.filter(s => s.id !== 'rigging-interview');
export const LEGACY_STAGE_VALUES: readonly string[] = [...LEGACY_STAGES.map(s => s.id), PAUSED_STAGE];
