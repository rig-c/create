import type { Item } from './check.ts';
import type { JsonObject } from './templates.ts';

/**
 * The project's stages, in order, and how each one is left — the one place the
 * order is written (docs/PROJECT.md § Stages). `interview --check` reads it;
 * the review order and the post hand-off (src/review.ts) read `REVIEW_ACCEPTS`
 * below rather than naming stages themselves.
 *
 * `closed_by` names how the old process closed a stage. No stage order or
 * sign-off is enforced (#981): `advance` may move to any stage, and a step may
 * run in any stage. Readers still use the order to label and to offer moves.
 * - `signoff`: the old process closed the stage on a human `signoffs[]` entry.
 * - `bar`: the stage's plan steps meet their bars.
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

/** Stages a `signoff --from-picks` may sign from recorded owner picks. */
export const PICK_SIGNOFF_STAGES: readonly string[] = ['interview', 'plan-approved', 'rigging-interview'];

/**
 * The stages skipped when every post item is answered not applicable
 * (PROJECT.md § When post is not passed): the project moves from
 * `post-interview` straight to `accepted`.
 */
export const SKIPPED_WHEN_NO_POST: readonly string[] = ['post', 'direction-review'];

/** Default new-order phase approvals; parts steps and legacy records use approvalStageOfStep. */
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
 * `rig-review` accepts one `kind: "rig"` version, and post
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
export const CHOICE_ORDER_SPEC = 'rig-create/stage-order@2';
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
  return order !== null && typeof order === 'object' && !Array.isArray(order) && (order.spec === STAGE_ORDER_SPEC || order.spec === CHOICE_ORDER_SPEC);
}

/** Legacy phase=rig approvals retain their original all-step meaning. */
export function approvalStageOfStep(phase: 'rig' | 'post', id: string, newOrder = false): string {
  if (phase === 'post') return PHASE_APPROVED_BY.post;
  if (!newOrder || PARTS_STEPS.includes(id)) return 'plan-approved';
  return PHASE_APPROVED_BY.rig;
}

/** Whether a step belongs to the plan published for this approval stage. */
export function stepCoveredByApproval(project: JsonObject, step: JsonObject, stage: string | null): boolean {
  const phase = stage === 'post-interview' ? 'post' : 'rig';
  return step.phase === phase && approvalStageOfStep(phase, String(step.id), hasStageOrder(project) || stage === 'rigging-interview') === stage;
}

export function interviewStageOfGuide(id: string, post = false, newOrder = false): string {
  if (post) return 'post-interview';
  return newOrder ? GUIDE_INTERVIEW[id] ?? 'rigging-interview' : 'interview';
}

export function isOpenInterviewStage(stage: string | null): stage is 'interview' | 'rigging-interview' | 'post-interview' {
  return stage === 'interview' || stage === 'rigging-interview' || stage === 'post-interview';
}

// The initial interview has its own sign-off path.
export function isOpenInterviewArrivalStage(stage: string): boolean {
  return stage === 'rigging-interview' || stage === 'post-interview';
}

export function silentInterviewItems(project: JsonObject, items: readonly Item[], stage: string): Item[] {
  const splitOrder = hasStageOrder(project);
  return items.filter(item => item.state.state === 'silent' && !coveredByStepPlan(project, item)
    && interviewStageOfGuide(item.id, item.kind === 'post', splitOrder) === stage);
}

/** The user's steps a step plan is proposed for (docs/INTERVIEW.md § Step plans). */
export const PLAN_STEPS = ['parts', 'rigging', 'motion', 'direction'] as const;
export type PlanStep = typeof PLAN_STEPS[number];
export const STEP_PLAN_SCHEMA = 'rig-create/step-plan@1';

/** Which step plan answers a question: by the split order's placement, whatever order the project uses. */
export function planStepOfGuide(id: string, post = false): PlanStep {
  if (post) return 'direction';
  if (id === 'motion') return 'motion';
  return interviewStageOfGuide(id, false, true) === 'interview' ? 'parts' : 'rigging';
}

/** The latest proposal recorded for one step by the given time; check validates its shape. */
export function currentStepPlan(project: JsonObject, step: PlanStep, at = Infinity): JsonObject | undefined {
  const interview = project.interview;
  if (interview === null || typeof interview !== 'object' || Array.isArray(interview)) return undefined;
  const plans = interview.step_plans;
  if (!Array.isArray(plans)) return undefined;
  return plans.findLast((entry): entry is JsonObject => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && entry.schema === STEP_PLAN_SCHEMA && entry.step === step && (at === Infinity || Date.parse(String(entry.at)) <= at));
}

/** A question whose step has a proposed plan needs no per-question answer. */
export function coveredByStepPlan(project: JsonObject, item: Pick<Item, 'id' | 'kind'>): boolean {
  return currentStepPlan(project, planStepOfGuide(item.id, item.kind === 'post')) !== undefined;
}

export const STEP_PLAN_SOURCE = 'step plan';

/**
 * Every code site that reads an interview answer's value (or its date), by file and question.
 * A question listed here needs a recorded value even when a step plan covers it: the agent
 * records it with interview-decision --by agent (INTERVIEW.md § Step plans). Pinned by
 * tests/step-plans.test.ts, which fails by name on a reader that is not listed.
 * `empty` says what goes wrong when the question has no value.
 */
export const INTERVIEW_VALUE_READERS: readonly { question: string; file: string; empty: string }[] = [
  { question: 'rig_type', file: 'ask-coverage.ts', empty: 'game_logic-only asks are treated as not applicable' },
  { question: 'rig_type', file: 'cg-gates.ts', empty: 'a full-screen (CG) project skips the CG gates' },
  { question: 'rig_type', file: 'choices.ts', empty: 'applicable asks fall back to the non-game_logic branch' },
  { question: 'rig_type', file: 'choice-writers.ts', empty: 'a step-plan value records the non-game_logic asks' },
  { question: 'assemble', file: 'ask-coverage.ts', empty: 'the projection and ground asks are refused as unanswered' },
  { question: 'assemble', file: 'assemble-answers.ts', empty: 'projection and ground are not compared with config.json' },
  { question: 'assemble', file: 'choices.ts', empty: 'the ground ask applies only when a set offers a visible projection' },
  { question: 'turn', file: 'rig-version.ts', empty: 'no depth step is required, so a head turn is never built' },
  { question: 'meshes', file: 'structure.ts', empty: 'a build with a structure delta is refused (no meshes answer date)' },
  { question: 'camera_depth', file: 'direction.ts', empty: 'direction write refuses DIRECTION_CITATION' },
  { question: 'camera_depth', file: 'direction-compose.ts', empty: 'composed direction has no camera citation' },
  { question: 'post_timing', file: 'direction.ts', empty: 'direction write refuses DIRECTION_CITATION' },
  { question: 'post_timing', file: 'direction-compose.ts', empty: 'composed direction has no timing values' },
  { question: 'post_timing', file: 'current-direction.ts', empty: 'the compose citation reader refuses DIRECTION_COMPOSE_CITATION without resolved timing' },
  { question: 'post_composition', file: 'compose-value.ts', empty: 'composed values have no candidates' },
  { question: 'post_composition', file: 'camera-choice.ts', empty: 'a keyed scene has no selected camera binding' },
  { question: 'post_composition', file: 'direction-compose.ts', empty: 'composed direction has no composition values' },
  { question: 'post_composition', file: 'current-direction.ts', empty: 'the compose citation reader refuses DIRECTION_COMPOSE_CITATION without resolved composition, or current direction refuses DIRECTION_COMPOSE_CHOICE_MISMATCH without a compose value' },
  { question: 'post_composition', file: 'next.ts', empty: 'next prints no scene command citation' },
  { question: 'post_composition', file: 'scene-authority.ts', empty: 'scene write refuses SCENE_CITATION_MISSING' },
  { question: 'post_composition', file: 'scene.ts', empty: 'scene check finds no citable answer' },
  { question: 'post_composition', file: 'stage-progress.ts', empty: 'composeChoice is false, so post progress treats the project as having no compose value' },
];

/** The questions whose value code reads; every other covered question stays unanswered under a plan. */
export const VALUE_QUESTIONS: readonly string[] = [...new Set(INTERVIEW_VALUE_READERS.map(reader => reader.question))];

/** A delegated value the agent recorded under the current plan of the question's step (no option set). */
export function stepPlanValue(project: JsonObject, item: Pick<Item, 'id' | 'kind'>, answer: JsonObject): boolean {
  if (answer.source !== STEP_PLAN_SOURCE || answer.delegated !== true || !VALUE_QUESTIONS.includes(item.id)) return false;
  const binding = answer.step_plan;
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const step = planStepOfGuide(item.id, item.kind === 'post');
  const interview = project.interview;
  const plans = interview !== null && typeof interview === 'object' && !Array.isArray(interview) && Array.isArray(interview.step_plans) ? interview.step_plans : [];
  return binding.step === step && plans.some(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && entry.schema === STEP_PLAN_SCHEMA && entry.step === step && entry.sha256 === binding.sha256);
}

/** Answers use interview membership, including framing ids that are not executable steps. */
export function approvalStageOfGuide(id: string, post = false, newOrder = false): string {
  const interview = interviewStageOfGuide(id, post, newOrder);
  return interview === 'interview' ? 'plan-approved' : interview;
}

/** Frozen order used by projects that have not adopted the split interview. */
export const LEGACY_STAGES = STAGES.filter(s => s.id !== 'rigging-interview');
export const LEGACY_STAGE_VALUES: readonly string[] = [...LEGACY_STAGES.map(s => s.id), PAUSED_STAGE];
