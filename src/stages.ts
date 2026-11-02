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
 * - `bar`: the stage ends when the last plan step of its `phase` meets its
 *   bar; no stage-level sign-off, but a step whose checkpoint is on needs a
 *   `{ stage, checkpoint: <step id> }` entry before the next step runs
 *   (`CHECKPOINT_UNSIGNED`).
 * - `none`: terminal.
 */
export interface StageSpec {
  readonly id: string;
  readonly closed_by: 'signoff' | 'bar' | 'none';
  /** For a `bar` stage: the plan phase whose steps run in it. */
  readonly phase?: 'rig' | 'post';
}

export const STAGES: readonly StageSpec[] = [
  { id: 'interview', closed_by: 'signoff' },
  { id: 'plan-approved', closed_by: 'signoff' },
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
  rig: 'plan-approved',
  post: 'post-interview',
};

/** The stage a phase's steps run in (the `bar` stage), i.e. the `stage` a checkpoint sign-off names. */
export function stageOfPhase(phase: 'rig' | 'post'): string {
  const found = STAGES.find((s) => s.phase === phase);
  if (found === undefined) throw new Error(`no stage runs phase ${phase}`);
  return found.id;
}

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
