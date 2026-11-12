import { checkPublicationGenerations } from './job-publication.ts';
import { collectBarAmendments, effectiveBar } from './plan-bar-amendments.ts';
import { partsReadFindings, latestPartsVerdictFinding, PARTS_VERDICT_LATEST_SINCE, recordedPartsVerdict, recordedPartsFinding } from './parts-verdict-record.ts';
import { partsActFindings } from './parts-act.ts';
import { reviewActFindings } from './review-act.ts';
import { checkCheckpointEvidence } from './checkpoint-evidence.ts';
import { checkAdvances, checkAdvanceBars, checkPauses, checkProgressLinkage, checkStageProgress, checkStepStatusHistory } from './stage-progress.ts';
import { checkPartsChecks } from './parts-check.ts';
import { pendingPublicationHoles } from './job-outbox.ts';
import { checkSignoffAnswers } from './signoff-answers.ts';
import { checkSignoffTarget } from './signoff-target.ts';
import { checkOverrides } from './overrides.ts';
import { intakeWarnings } from './intake.ts';
import { checkDirections } from './direction.ts';
import { checkScenes } from './scene.ts';
import { checkCorrections } from './corrections.ts';
import { amendmentSummaries, collectAmendments, type AmendmentSummary } from './amend.ts';
/**
 * `interview --check`: reads a project's `project.json` and reports, by name,
 * every place the record breaks the contract in docs/INTERVIEW.md and
 * docs/PROJECT.md — every refusal it finds, not the first. The codes and what
 * clears each are listed in docs/CHECKS.md; a code added here is added there.
 *
 * The waypoint set is not a hand list: it is derived from the installed
 * `@rig-c/parts` sections (src/parts-sections.ts) through the placement table
 * (src/waypoints.ts). The stage order comes from src/stages.ts.
 *
 * Later cards plug in as further `check*` functions over the same `Ctx`:
 * provenance per config section (src/provenance.ts, over `versions[].provenance`), the
 * review order and post hand-off (src/review.ts, with src/stages.ts), feedback
 * answered by the next version (#9, over `versions[].verdicts` and
 * `answers_feedback`), collection pins (#7, over `collection.json`), and the
 * CG gates a full-screen scene's rig versions declare (src/cg-gates.ts), and the
 * bust's default or reasoned exclusion at `meshes` (src/meshes-bust.ts).
 */
import { existsSync, readFileSync, recordCheckReads, type CheckRead } from './check-reads.ts';
import { basename, join, resolve } from 'node:path';
import { checkCollectionBinding, loadCollectionForDir, withCandidateProject } from './collection-binding-reader.ts';

import { PartsUnreadable, readPartsSections, type PartsSections } from './parts-sections.ts';
import { checkRiggingContext } from './structure.ts';
import { checkDrafts, draftVersionFindings } from './drafts.ts';
import { checkFixLedger, type LedgerSummary } from './fix-ledger.ts';
import { checkCgGates } from './cg-gates.ts';
import { checkFigureMask } from './figure-mask.ts';
import { checkSetupPainting } from './setup-painting.ts';
import { checkChoices } from './choices.ts';
import { translateInvariants, type InvariantsDocument } from './invariants.ts';
import { checkAskCoverage } from './ask-coverage.ts';
import { checkAgentBounces } from './agent-bounce.ts';
import { checkInputs } from './inputs.ts';
import { checkPreparedInputs } from './prepared-inputs.ts';
import { checkMeshesBust } from './meshes-bust.ts';
import { checkProvenance, formatProvenance, type ProvenanceSummary } from './provenance.ts';
import { checkFeedback, formatFeedback, type FeedbackSummary } from './feedback.ts';
import { checkDiffMap } from './diff-map.ts';
import { checkReviews, latestAccepted, readVersions } from './review.ts';
import { checkAppliedReview } from './applied-review.ts';
import { checkReviewPackages } from './review-package.ts';
import { rigRegistrationFindings } from './rig-version.ts';
import { checkPreInterview } from './pre-interview.ts';
import {
  PARTS_REVIEW,
  PARTS_REVIEW_SINCE,
  PAUSED_STAGE,
  approvalStageOfStep,
  approvalStageOfGuide,
  hasStageOrder,
  interviewStageOfGuide,
  LEGACY_STAGES,
  LEGACY_STAGE_VALUES,
  SKIPPED_WHEN_NO_POST,
  STAGE_VALUES,
  STAGES,
  stageIndex,
  stageOfStep,
} from './stages.ts';
import type { Json, JsonObject } from './templates.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { reopenLapseWarnings } from './reopen-lapses.ts';
import { stepHash } from './step-hash.ts';
import { collectPlanReplaced, checkReplacedSignoffs, collectCheckpointWithdrawals, checkpointRequired } from './plan-history.ts';
import { deriveWaypoints, FRAMING_IDS, type DerivedSet } from './waypoints.ts';

export const PROJECT_SCHEMA = 'rig-create/project@0';
export const STAGE_ORDER_LEGACY_FINDING: Finding = { code: 'STAGE_ORDER_LEGACY', path: 'interview.order', message: 'interview.order: legacy interview order; preserve old rig guides as history, not as answers asked after parts; adopt explicitly with a fresh rigging-interview sign-off' };

export const COLLECTION_SCHEMA = 'rig-create/collection@0';

/** Heuristic only: these phrases name appearance calls, not measured step readings. */
export const APPEARANCE_IN_MOTION_PHRASES = [
  'perceived jiggle',
  'perceived motion',
  'looks right in the loop',
  'looks right in loop',
  'looks natural in motion',
  'natural motion',
  'smooth motion',
  'visible at 1x',
  'seen at 1x',
] as const;

/** Numeric prose only: commands/URLs and viewing scales such as 1x are not readings. */
function hasNumericReading(bar: string): boolean {
  const prose = bar.replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const number = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
  const unit = String.raw`(?:px|pixels?|mm|cm|m|deg|degrees?|rad|radians?|ms|s|seconds?|frames?|world units?|units?)\b|[%°]`;
  return new RegExp(String.raw`(?<![\w.])${number}\s*(?:${unit})`, 'i').test(prose)
    || new RegExp(String.raw`(?:<=|>=|<|>|=|≤|≥)\s*${number}(?![\w.])|(?<![\w.])${number}\s*(?:<=|>=|<|>|=|≤|≥)`).test(prose);
}

/** Warning-only wording lint; it cannot watch motion or certify a numeric clause. */
export function appearanceBarWarnings(project: JsonObject, now = Date.now()): Finding[] {
  const plan = isObject(project.plan) ? project.plan : {};
  const warnings: Finding[] = [];
  for (const raw of asArray(plan.steps)) {
    if (!isObject(raw) || typeof raw.id !== 'string' || (raw.phase !== 'rig' && raw.phase !== 'post') || typeof raw.bar !== 'string') continue;
    const bar = effectiveBar(project, raw, now);
    const text = bar.toLowerCase().replace(/\s+/g, ' ');
    const phrase = APPEARANCE_IN_MOTION_PHRASES.find((p) => new RegExp(String.raw`\b${p}\b`).test(text));
    if (phrase === undefined || hasNumericReading(bar)) continue;
    const path = `plan.steps[${raw.id}].bar`;
    const review = raw.phase === 'rig' ? 'rig-review' : 'direction-review';
    warnings.push({
      code: 'STEP_APPEARANCE_REVIEW', path,
      message: `${path}: "${phrase}" has no numeric reading; move the appearance call to a person's ${review}, with the step's measured readings as context (docs/INTERVIEW.md § Appearance belongs to a person's review)`,
    });
  }
  return warnings;
}

export interface Finding {
  readonly code: string;
  /** The object refused, as a path into project.json: `interview.waypoints[bones].guide`, `plan.steps[assemble]`, `signoffs[2]`, `stage`. */
  readonly path: string;
  readonly message: string;
}

export interface CheckReport {
  readonly ok: boolean;
  readonly project_dir: string;
  readonly stage: string | null;
  /** The stage the checks were applied as: `stage`, or for `paused` the first stage whose sign-off is missing. */
  readonly effective_stage: string | null;
  readonly parts: { version: string; read_from: string; dir: string } | null;
  readonly derived: { waypoints: string[]; post_items: string[] } | null;
  /** Current guide translation, not a rig check or a stored project field. */
  readonly invariants: InvariantsDocument | null;
  /** Per version built from a config: whether the config file was read to list its sections (docs/CHECKS.md § Provenance). */
  readonly provenance: ProvenanceSummary[];
  /** Per human bounced verdict: its items counted by cause, and the versions that answer it (docs/CHECKS.md § Polish feedback). */
  readonly feedback: FeedbackSummary[];
  /** Present only on amended records, preserving the report shape of older projects. */
  readonly amendments?: AmendmentSummary[];
  /** Per draft bound to a ledger report: the fix_ledger rows it fixes and its known regressions (docs/CHECKS.md § Fix ledger). Present only when one is. */
  readonly ledger?: LedgerSummary[];
  readonly refusals: Finding[];
  readonly warnings: Finding[];
  /** Local delivery gaps, distinct from record-validation refusals. */
  readonly holes?: Finding[];
  /** Present only with `recordReads`: every project file the check read, as `{path, sha256}` sorted by path (src/check-reads.ts). */
  readonly reads?: readonly CheckRead[];
}

type Phase = 'rig' | 'post';

export type AnswerState =
  | { state: 'silent'; via?: string }
  | { state: 'user'; answer: JsonObject }
  | { state: 'delegated'; answer: JsonObject; decided: boolean }
  | { state: 'not_applicable'; answer: JsonObject }
  | { state: 'malformed'; why: string }
  | { state: 'unresolved'; why: string };

export interface Item {
  readonly id: string;
  readonly path: string;
  readonly kind: 'framing' | 'waypoint' | 'post';
  readonly record: JsonObject;
  readonly raw: Json;
  readonly state: AnswerState;
}

interface Signoff {
  readonly index: number;
  readonly stage: string;
  readonly checkpoint: string | null;
  readonly at: number;
  /** For a plan re-sign: the steps re-approved; `null` means every step. */
  readonly steps: string[] | null;
  /** The record as written, for the fields one stage reads (`parts-review`'s `evidence`). */
  readonly record: JsonObject;
}

interface Step {
  readonly index: number;
  readonly id: string;
  readonly path: string;
  readonly phase: Phase;
  readonly record: JsonObject;
}

export interface Ctx {
  readonly dir: string;
  readonly project: JsonObject;
  readonly refusals: Finding[];
  readonly warnings: Finding[];
  readonly items: Item[];
  readonly signoffs: Signoff[];
  readonly steps: Step[];
  readonly stage: string;
  readonly effectiveStage: string;
  readonly collection: JsonObject | null;
  /**
   * Set when the project passed `plan-approved` before `parts` and
   * `parts-review` existed (src/stages.ts `PARTS_REVIEW_SINCE`): the date of
   * its first `plan-approved` sign-off. Such a project is warned about, not
   * refused, and its parts steps' checkpoints may name `rigging`, as they were
   * signed then.
   */
  readonly predatesPartsReview: string | null;
}

// ---------------------------------------------------------------- JSON access

export function isObject(v: Json | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}
export function asArray(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}
export function asString(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : null;
}
function time(v: Json | undefined): number {
  const s = asString(v);
  if (s === null) return Number.NaN;
  return Date.parse(s);
}

type ReadJson = { ok: true; value: JsonObject } | { ok: false; error: string };

export function readJsonObject(file: string): ReadJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'not a JSON object' };
  return { ok: true, value: parsed as JsonObject };
}

// ------------------------------------------------------------- answer states

/** Looks an answer up in a collection's interview by question id (COLLECTIONS.md § What the collection owns). */
/** The question record a collection answer sits on (its `history[]` lives there), or undefined. */
export function collectionQuestion(collection: JsonObject, question: string): JsonObject | undefined {
  const interview = isObject(collection.interview) ? collection.interview : {};
  const post = isObject(interview.post) ? interview.post : {};
  for (const list of [interview.questions, interview.framing, interview.waypoints, post.items]) {
    for (const q of asArray(list)) if (isObject(q) && q.id === question) return q;
  }
  return undefined;
}

export function collectionAnswer(collection: JsonObject, question: string): Json | undefined {
  const interview = isObject(collection.interview) ? collection.interview : {};
  for (const q of asArray(interview.questions)) if (isObject(q) && q.id === question) return q.answer;
  for (const q of asArray(interview.framing)) if (isObject(q) && q.id === question) return q.answer;
  for (const w of asArray(interview.waypoints)) if (isObject(w) && w.id === question) return w.guide;
  const post = isObject(interview.post) ? interview.post : {};
  for (const p of asArray(post.items)) if (isObject(p) && p.id === question) return p.guide;
  return undefined;
}

export function classify(raw: Json | undefined, ctx: Pick<Ctx, 'collection'>, depth = 0): AnswerState {
  if (raw === null || raw === undefined) return { state: 'silent' };
  if (!isObject(raw)) return { state: 'malformed', why: 'an answer is an object or null' };
  if ('deferred' in raw) return { state: 'malformed', why: 'deferral belongs only to a collection-scope question; record a member answer or delegation' };
  if (raw.basis === 'inherited') {
    const from = isObject(raw.from) ? raw.from : null;
    const collectionName = from === null ? null : asString(from.collection);
    const question = from === null ? null : asString(from.question);
    if (collectionName === null || question === null) return { state: 'malformed', why: 'inherited needs from.collection and from.question' };
    if (ctx.collection === null) {
      return { state: 'unresolved', why: `inherits from collection '${collectionName}', but this project is not under <collection>/members/<name>/ with a collection.json` };
    }
    if (ctx.collection.name !== collectionName) {
      return { state: 'unresolved', why: `inherits from collection '${collectionName}'; the parent collection is '${String(ctx.collection.name)}'` };
    }
    const answer = collectionAnswer(ctx.collection, question);
    if (answer === undefined) return { state: 'unresolved', why: `inherits '${question}', which the collection '${collectionName}' does not ask` };
    if (depth > 2) return { state: 'unresolved', why: 'inheritance chain too deep' };
    if (isObject(answer) && 'deferred' in answer) return { state: 'silent', via: `collection '${collectionName}' deferred '${question}'; this member must answer it` };
    const resolved = classify(answer, { collection: null }, depth + 1);
    if (resolved.state === 'silent') return { state: 'silent', via: `collection '${collectionName}' answer '${question}' is null` };
    if (resolved.state === 'user' && resolved.answer.value === 'per-member') {
      return { state: 'silent', via: `collection '${collectionName}' answered '${question}' per-member; this member must answer it` };
    }
    return resolved;
  }
  if (raw.not_applicable === true) {
    if (asString(raw.because) === null || raw.because === '') return { state: 'malformed', why: 'not applicable needs a reason in `because`' };
    return { state: 'not_applicable', answer: raw };
  }
  if (raw.delegated === true) {
    return { state: 'delegated', answer: raw, decided: isDecision(raw.agent_decision) };
  }
  if (raw.delegated === false) {
    if (!('value' in raw) || !('verbatim' in raw)) return { state: 'malformed', why: 'a user answer carries verbatim and value' };
    return { state: 'user', answer: raw };
  }
  return { state: 'malformed', why: 'neither a user answer (delegated: false), a delegation (delegated: true) nor not applicable' };
}

/**
 * A written agent decision: it carries its choice (`value`) and a non-empty
 * `reasoning`. An empty object is not a decision.
 */
export function isDecision(raw: Json | undefined): boolean {
  return isObject(raw) && 'value' in raw && typeof raw.reasoning === 'string' && raw.reasoning.trim() !== '';
}

/**
 * The moments an answer changed: when it was given, when the agent's decision
 * on it (full or partial delegation) was written, and every addition. A
 * decision changed after a sign-off is a change the sign-off never covered.
 * NaN dates are skipped.
 */
function changeTimes(state: AnswerState): number[] {
  if (state.state !== 'user' && state.state !== 'delegated' && state.state !== 'not_applicable') return [];
  const times = [time(state.answer.at)];
  if (isObject(state.answer.agent_decision)) times.push(time(state.answer.agent_decision.at));
  for (const add of asArray(state.answer.additions)) if (isObject(add)) times.push(time(add.at));
  return times.filter((t) => !Number.isNaN(t));
}

export function answered(state: AnswerState): boolean {
  return state.state === 'user' || state.state === 'delegated' || state.state === 'not_applicable';
}

// ------------------------------------------------------------------ loading

export function loadCollection(dir: string, project?: JsonObject): JsonObject | null {
  return loadCollectionForDir(dir, project);
}

export function collectItems(project: JsonObject, ctx: Pick<Ctx, 'collection'>): Item[] {
  const interview = isObject(project.interview) ? project.interview : {};
  const items: Item[] = [];
  for (const q of asArray(interview.framing)) {
    if (!isObject(q) || asString(q.id) === null) continue;
    const id = q.id as string;
    items.push({ id, kind: 'framing', path: `interview.framing[${id}].answer`, record: q, raw: q.answer ?? null, state: classify(q.answer, ctx) });
  }
  for (const w of asArray(interview.waypoints)) {
    if (!isObject(w) || asString(w.id) === null) continue;
    const id = w.id as string;
    items.push({ id, kind: 'waypoint', path: `interview.waypoints[${id}].guide`, record: w, raw: w.guide ?? null, state: classify(w.guide, ctx) });
  }
  const post = isObject(interview.post) ? interview.post : {};
  for (const p of asArray(post.items)) {
    if (!isObject(p) || asString(p.id) === null) continue;
    const id = p.id as string;
    items.push({ id, kind: 'post', path: `interview.post.items[${id}].guide`, record: p, raw: p.guide ?? null, state: classify(p.guide, ctx) });
  }
  return items;
}

function collectSteps(project: JsonObject, refusals: Finding[]): Step[] {
  const plan = isObject(project.plan) ? project.plan : {};
  const steps: Step[] = [];
  asArray(plan.steps).forEach((s, index) => {
    const path = `plan.steps[${index}]`;
    if (!isObject(s) || asString(s.id) === null) {
      refusals.push({ code: 'STEP_MALFORMED', path, message: `${path}: a step is an object with a string id` });
      return;
    }
    const id = s.id as string;
    if (s.phase !== 'rig' && s.phase !== 'post') {
      refusals.push({ code: 'STEP_MALFORMED', path: `plan.steps[${id}]`, message: `plan.steps[${id}]: phase is 'rig' or 'post', got ${JSON.stringify(s.phase ?? null)}` });
      return;
    }
    steps.push({ index, id, path: `plan.steps[${id}]`, phase: s.phase, record: s });
  });
  return steps;
}

export function collectSignoffs(project: JsonObject, refusals: Finding[]): Signoff[] {
  const out: Signoff[] = [];
  asArray(project.signoffs).forEach((s, index) => {
    const path = `signoffs[${index}]`;
    if (!isObject(s)) {
      refusals.push({ code: 'SIGNOFF_MALFORMED', path, message: `${path}: not an object` });
      return;
    }
    const stage = asString(s.stage);
    const missing = ['stage', 'by', 'at', 'verbatim'].filter((k) => asString(s[k]) === null);
    if (missing.length > 0) {
      refusals.push({ code: 'SIGNOFF_MALFORMED', path, message: `${path}: missing ${missing.join(', ')} (a sign-off is stage, checkpoint, by, at, verbatim)` });
      return;
    }
    if ((s.by as string).toLowerCase() === 'agent') {
      refusals.push({ code: 'SIGNOFF_NOT_HUMAN', path, message: `${path} (stage ${stage}): signed by 'agent'; a stage moves only on a human sign-off` });
      return;
    }
    const checkpoint = asString(s.checkpoint);
    const steps = Array.isArray(s.steps) ? s.steps.filter((x): x is string => typeof x === 'string') : null;
    out.push({ index, stage: stage as string, checkpoint, at: time(s.at), steps, record: s });
  });
  return out;
}

// ------------------------------------------------------------------- helpers

function signoffsFor(ctx: Ctx, stage: string): Signoff[] {
  return ctx.signoffs.filter((s) => s.stage === stage && s.checkpoint === null);
}
function signed(ctx: Ctx, stage: string): boolean {
  return signoffsFor(ctx, stage).length > 0;
}
function effectiveIndex(ctx: Ctx): number {
  return stageIndex(ctx.effectiveStage);
}
function stepFor(ctx: Ctx, id: string): Step | undefined {
  return ctx.steps.find((s) => s.id === id);
}
export function itemFor(ctx: Ctx, id: string): Item | undefined {
  return ctx.items.find((i) => i.id === id);
}
/** Every post item answered not applicable — the project may skip `post` and `direction-review`. */
export function postNotPassed(ctx: Pick<Ctx, 'items'>): boolean {
  const post = ctx.items.filter((i) => i.kind === 'post');
  return post.length > 0 && post.every((i) => i.state.state === 'not_applicable');
}

/**
 * Where a paused project resumes, and what its checks are applied as: the
 * first stage closed by a sign-off that has none, or, before it, a `bar` stage
 * that names its steps (`parts`) while one of them in the plan is not `done`.
 * Amendments resume at unfinished bars only within an amended stage suffix.
 * Ordinary paused records retain their previous resume behavior.
 */
function firstUnsignedStage(signoffs: Signoff[], steps: Step[], predatesPartsReview: boolean, newOrder = false, amendedFrom = Infinity, noPost = false): string {
  const amended = Number.isFinite(amendedFrom);
  for (const s of newOrder ? STAGES : LEGACY_STAGES) {
    if (amended && noPost && SKIPPED_WHEN_NO_POST.includes(s.id)) continue;
    // A project that predates parts-review resumes where it would have before the two stages existed.
    if (predatesPartsReview && (s.id === PARTS_REVIEW || s.id === 'parts')) continue;
    const enforceBar = amended ? stageIndex(s.id) >= amendedFrom : s.steps !== undefined;
    if (s.closed_by === 'bar' && enforceBar) {
      if (steps.some((x) => (amended ? stageOfStep(x.phase, x.id) === s.id : s.steps?.includes(x.id)) && (asString(x.record.status) ?? 'pending') !== 'done')) return s.id;
      continue;
    }
    if (s.closed_by === 'signoff' && !signoffs.some((x) => x.stage === s.id && x.checkpoint === null)) return s.id;
  }
  return STAGES[STAGES.length - 1]?.id ?? 'accepted';
}

/**
 * The date of the project's first `plan-approved` sign-off when it is before
 * `PARTS_REVIEW_SINCE`, else `null`. Read from the sign-off, not from
 * `stage_values` or a schema mark: leaving `plan-approved` is what put a
 * project past the place the two stages now stand, and that sign-off is the
 * dated, human act that did it. An undated sign-off does not count.
 */
function planApprovedBeforePartsReview(signoffs: Signoff[]): string | null {
  const since = Date.parse(PARTS_REVIEW_SINCE);
  const times = signoffs.filter((s) => s.stage === 'plan-approved' && s.checkpoint === null && !Number.isNaN(s.at)).map((s) => s.at);
  if (times.length === 0) return null;
  const first = Math.min(...times);
  return first < since ? new Date(first).toISOString() : null;
}

/** The stages a step's checkpoint sign-off may name: its stage, and for a parts step of a project that predates `parts`, `rigging` as well. */
function checkpointStages(ctx: Ctx, step: Step): string[] {
  const stage = stageOfStep(step.phase, step.id);
  const legacy = stageOfStep(step.phase, '');
  return ctx.predatesPartsReview !== null && stage !== legacy ? [stage, legacy] : [stage];
}

// -------------------------------------------------------------------- checks

function checkDerived(ctx: Ctx, parts: PartsSections, derived: DerivedSet): void {
  const interview = isObject(ctx.project.interview) ? ctx.project.interview : {};
  for (const section of derived.unplaced) {
    ctx.refusals.push({
      code: 'SECTION_UNPLACED',
      path: `@rig-c/parts ${parts.version} section '${section}'`,
      message: `@rig-c/parts ${parts.version} has section '${section}', which the placement table does not place; decide whether it is a waypoint, a post item or not a direction call (src/waypoints.ts, docs/INTERVIEW.md § Waypoints)`,
    });
  }
  for (const section of derived.retired) {
    ctx.warnings.push({ code: 'SECTION_RETIRED', path: `src/waypoints.ts '${section}'`, message: `the placement table places '${section}', which @rig-c/parts ${parts.version} no longer has` });
  }
  const questionSet = asString(interview.question_set) ?? '';
  if (!questionSet.includes(`@rig-c/parts ${parts.version}`)) {
    ctx.warnings.push({
      code: 'QUESTION_SET_STALE',
      path: 'interview.question_set',
      message: `interview.question_set is ${JSON.stringify(questionSet)}; the installed @rig-c/parts is ${parts.version}`,
    });
  }
  const recordWaypoints = ctx.items.filter((i) => i.kind === 'waypoint');
  for (const d of derived.waypoints) {
    const w = recordWaypoints.find((i) => i.id === d.id);
    if (w === undefined) {
      ctx.refusals.push({ code: 'WAYPOINT_MISSING', path: `interview.waypoints[${d.id}]`, message: `interview.waypoints has no '${d.id}', which @rig-c/parts ${parts.version} passes (sections ${d.config.join(', ')}); the question was never asked` });
      continue;
    }
    const listed = asArray(w.record.config).filter((c): c is string => typeof c === 'string').sort();
    const expected = [...d.config].sort();
    if (listed.join(',') !== expected.join(',')) {
      ctx.warnings.push({ code: 'WAYPOINT_CONFIG_STALE', path: `interview.waypoints[${d.id}].config`, message: `interview.waypoints[${d.id}].config lists [${listed.join(', ')}]; @rig-c/parts ${parts.version} places [${expected.join(', ')}] there` });
    }
  }
  for (const w of recordWaypoints) {
    if (!derived.waypoints.some((d) => d.id === w.id)) {
      ctx.warnings.push({ code: 'WAYPOINT_UNKNOWN', path: `interview.waypoints[${w.id}]`, message: `interview.waypoints[${w.id}] is not derived from @rig-c/parts ${parts.version}; no section is placed there` });
    }
  }
  const recordPost = ctx.items.filter((i) => i.kind === 'post');
  for (const d of derived.post_items) {
    if (!recordPost.some((i) => i.id === d.id)) {
      ctx.refusals.push({ code: 'POST_ITEM_MISSING', path: `interview.post.items[${d.id}]`, message: `interview.post.items has no '${d.id}'${d.config.length > 0 ? ` (sections ${d.config.join(', ')})` : ''}` });
    }
  }
  for (const id of FRAMING_IDS) {
    if (!ctx.items.some((i) => i.kind === 'framing' && i.id === id)) {
      ctx.refusals.push({ code: 'FRAMING_MISSING', path: `interview.framing[${id}]`, message: `interview.framing has no '${id}'` });
    }
  }
}

function checkAnswers(ctx: Ctx): void {
  const cur = effectiveIndex(ctx);
  const interviewIdx = stageIndex('interview');
  const postInterviewIdx = stageIndex('post-interview');
  for (const item of ctx.items) {
    const { state, path } = item;
    const interviewStage = interviewStageOfGuide(item.id, item.kind === 'post', hasStageOrder(ctx.project));
    const ownInterview = stageIndex(interviewStage);
    if (state.state === 'malformed') {
      ctx.refusals.push({ code: 'ANSWER_MALFORMED', path, message: `${path}: ${state.why}` });
      continue;
    }
    if (state.state === 'unresolved') {
      ctx.refusals.push({ code: 'INHERITED_UNRESOLVED', path, message: `${path}: ${state.why}` });
      continue;
    }
    if (state.state === 'silent') {
      if (hasStageOrder(ctx.project) && cur < ownInterview) continue;
      const via = state.via === undefined ? '' : ` (${state.via})`;
      if (item.kind === 'post') {
        if (cur < postInterviewIdx) continue;
        if (cur === postInterviewIdx) {
          ctx.refusals.push({ code: 'INTERVIEW_INCOMPLETE', path, message: `${path}: not answered yet${via}; the post interview is incomplete` });
        } else {
          ctx.refusals.push({ code: 'POST_ITEM_SILENT', path, message: `${path}: no guide and no delegation${via}, yet the stage is past post-interview` });
        }
        continue;
      }
      if (cur <= (hasStageOrder(ctx.project) ? ownInterview : interviewIdx)) {
        ctx.refusals.push({ code: 'INTERVIEW_INCOMPLETE', path, message: `${path}: not answered yet${via}; the interview is incomplete` });
      } else {
        const code = item.kind === 'framing' ? 'FRAMING_SILENT' : 'WAYPOINT_SILENT';
        ctx.refusals.push({ code, path, message: `${path}: no guide and no delegation${via}, yet the stage is past interview` });
      }
      continue;
    }
    if (item.kind !== 'framing' && state.state === 'user' && 'agent_decision' in state.answer) {
      const decision = state.answer.agent_decision;
      const covers = isObject(decision) ? asString(decision.covers) : null;
      if (covers === null || covers.trim() === '') {
        ctx.refusals.push({ code: 'GUIDE_PARTIAL_UNMARKED', path, message: `${path}: a partial guide's agent_decision needs nonempty covers naming the remainder delegated to the agent` });
      }
      const approvedBy = approvalStageOfGuide(item.id, item.kind === 'post', hasStageOrder(ctx.project));
      if (signed(ctx, approvedBy) && !isDecision(decision)) {
        ctx.refusals.push({ code: 'DELEGATION_UNDECIDED', path, message: `${path}: the partially delegated remainder needs agent_decision.value and nonempty reasoning before ${approvedBy} is signed` });
      }
    }
    if (state.state === 'delegated' && !state.decided) {
      const approvedBy = approvalStageOfGuide(item.id, item.kind === 'post', hasStageOrder(ctx.project));
      if (signed(ctx, approvedBy)) {
        ctx.refusals.push({ code: 'DELEGATION_UNDECIDED', path, message: `${path}: delegated, but agent_decision is missing and ${approvedBy} is signed; the agent's decision is written before the plan is signed` });
      }
    }
  }
}

const curStageIndex = (ctx: Ctx): number => stageIndex(ctx.effectiveStage);

function checkPlan(ctx: Ctx): void {
  const planSigned = signed(ctx, 'plan-approved') || signed(ctx, 'rigging-interview');
  if (planSigned && ctx.steps.length === 0) {
    ctx.refusals.push({ code: 'PLAN_EMPTY', path: 'plan.steps', message: 'plan-approved is signed, but plan.steps is empty' });
  }
  const recordWaypointIds = new Set(ctx.items.filter((i) => i.kind === 'waypoint').map((i) => i.id));
  const seen = new Set<string>();
  for (const step of ctx.steps) {
    const { path, record } = step;
    if (seen.has(step.id)) ctx.refusals.push({ code: 'STEP_MALFORMED', path, message: `${path}: id '${step.id}' is used by more than one step` });
    seen.add(step.id);
    if (step.phase === 'rig' && !recordWaypointIds.has(step.id)) {
      ctx.refusals.push({ code: 'STEP_NOT_A_WAYPOINT', path, message: `${path}: a rig step's id is the waypoint's; '${step.id}' is no waypoint of this interview` });
    }
    const laterDraft = hasStageOrder(ctx.project) && stageIndex(stageOfStep(step.phase, step.id)) > curStageIndex(ctx)
      && (record.status === undefined || record.status === 'pending');
    const restsOn = asArray(record.rests_on).filter((x): x is string => typeof x === 'string');
    if (restsOn.length === 0) {
      ctx.refusals.push({ code: 'STEP_NO_BASIS', path, message: `${path}: rests_on is empty; a step never rests on nothing` });
    }
    for (const id of restsOn) {
      const item = itemFor(ctx, id);
      if (item === undefined) {
        ctx.refusals.push({ code: 'STEP_BASIS_UNKNOWN', path, message: `${path}: rests on '${id}', which is no framing, waypoint or post item of this interview` });
      } else if (!answered(item.state) && !laterDraft) {
        ctx.refusals.push({ code: 'STEP_BASIS_SILENT', path, message: `${path}: rests on '${id}', which has no answer (${item.path} is ${item.state.state})` });
      }
    }
    const approvedBy = approvalStageOfStep(step.phase, step.id, hasStageOrder(ctx.project));
    const approvals = signoffsFor(ctx, approvedBy);
    const status = record.status === undefined ? 'pending' : record.status;
    if (typeof status !== 'string' || !['pending', 'in-progress', 'at-checkpoint', 'done'].includes(status)) {
      ctx.refusals.push({ code: 'STEP_STATUS_UNKNOWN', path: `${path}.status`, message: `${path}.status: unknown status ${JSON.stringify(status)}; use pending before approval, then in-progress, at-checkpoint or done` });
      continue;
    }
    const checkpoint = classify(record.checkpoint, { collection: null });
    if (approvals.length > 0) {
      if (checkpoint.state === 'silent') {
        ctx.refusals.push({ code: 'CHECKPOINT_UNANSWERED', path: `${path}.checkpoint`, message: `${path}.checkpoint is null, yet ${approvedBy} is signed; the user sets each step's checkpoint (or delegates it) before signing` });
      } else if (
        checkpoint.state === 'delegated' &&
        (!checkpoint.decided || typeof (checkpoint.answer.agent_decision as JsonObject).value !== 'boolean')
      ) {
        ctx.refusals.push({ code: 'DELEGATION_UNDECIDED', path: `${path}.checkpoint`, message: `${path}.checkpoint: delegated, but agent_decision has no boolean value and reasoning, and ${approvedBy} is signed` });
      }
    }
    if (checkpoint.state === 'malformed') {
      ctx.refusals.push({ code: 'ANSWER_MALFORMED', path: `${path}.checkpoint`, message: `${path}.checkpoint: ${checkpoint.why}` });
    }
    const approval = latestSignoff(ctx, approvedBy, step.id);
    if (approval !== undefined) {
      const hashes = approval.record.step_hashes;
      const signoffPath = `signoffs[${approval.index}]`;
      if (hashes === undefined) {
        ctx.warnings.push({ code: 'STEP_SIGNOFF_HASH_MISSING', path, message: `${path}: covering ${signoffPath} has no step_hashes. Signed contents cannot be verified. Sign again to record the current step` });
      } else if (!isObject(hashes) || hashes[step.id] !== stepHash(record)) {
        ctx.refusals.push({ code: 'STEP_EDITED_AFTER_SIGNOFF', path, message: `${path}: current step does not match ${signoffPath}.step_hashes[${step.id}]. Please sign again at ${approvedBy} to approve this step` });
      }
    }
    if (status === 'pending') continue;
    if (hasStageOrder(ctx.project) && step.phase === 'rig' && stageOfStep(step.phase, step.id) === 'rigging' && !signed(ctx, 'rigging-interview')) {
      ctx.refusals.push({ code: 'RIGGING_INTERVIEW_UNSIGNED', path, message: `${path}: production rigging requires rigging-interview approval; leave this step pending until the person signs` });
    }
    // The step has run (or is running): it needs the approving sign-off, given after every answer it rests on last changed.
    if (approval === undefined) {
      ctx.refusals.push({ code: 'STEP_RUN_UNAPPROVED', path, message: `${path} is ${status}, but no ${approvedBy} sign-off covers it; use pending before approval` });
    } else {
      const latestApproval = Number.isNaN(approval.at) ? Number.NEGATIVE_INFINITY : approval.at;
      for (const id of restsOn) {
        const item = itemFor(ctx, id);
        if (item === undefined) continue;
        const changed = Math.max(...changeTimes(item.state), Number.NEGATIVE_INFINITY);
        if (changed > latestApproval) {
          ctx.refusals.push({
            code: 'GUIDE_CHANGED_UNSIGNED',
            path,
            message: `${path} rests on '${id}', which changed at ${new Date(changed).toISOString()}, after the last ${approvedBy} sign-off covering the step (${latestApproval === Number.NEGATIVE_INFINITY ? 'undated' : new Date(latestApproval).toISOString()}); a changed guide sends the step back for a new sign-off`,
          });
        }
      }
    }
    const on = checkpointRequired(ctx.project, record);
    if (on && status === 'done') {
      const stages = checkpointStages(ctx, step);
      const stage = stages[0] as string;
      if (!ctx.signoffs.some((s) => stages.includes(s.stage) && s.checkpoint === step.id)) {
        ctx.refusals.push({ code: 'CHECKPOINT_UNSIGNED', path, message: `${path} is done with its checkpoint on, but no { "stage": "${stage}", "checkpoint": "${step.id}" } sign-off exists` });
      }
    }
  }
  if (planSigned) {
    for (const item of ctx.items) {
      if (item.kind !== 'waypoint' || !signed(ctx, approvalStageOfStep('rig', item.id, hasStageOrder(ctx.project)))) continue;
      if ((item.state.state === 'user' || item.state.state === 'delegated') && !ctx.steps.some((s) => s.phase === 'rig' && s.id === item.id)) {
        ctx.refusals.push({ code: 'STEP_MISSING_FOR_WAYPOINT', path: `plan.steps[${item.id}]`, message: `waypoint '${item.id}' has a guide but the signed plan has no rig step '${item.id}'; one step per waypoint the plan passes` });
      }
    }
  }
}

function checkStages(ctx: Ctx): void {
  const cur = effectiveIndex(ctx);
  const paused = ctx.stage === PAUSED_STAGE;
  const signoffLimit = collectAmendments(ctx.project, []).length > 0 ? stageIndex(ctx.stage) : cur;
  const plan = isObject(ctx.project.plan) ? ctx.project.plan : {};
  const draftedAt = time(plan.drafted_at);
  const riggingApproval = latestSignoff(ctx, 'rigging-interview');
  if (hasStageOrder(ctx.project) && riggingApproval !== undefined && Number.isFinite(time(plan.rigging_drafted_at)) && riggingApproval.at < time(plan.rigging_drafted_at)) {
    const path = `signoffs[${riggingApproval.index}]`;
    ctx.refusals.push({ code: 'SIGNOFF_BEFORE_PLAN', path, message: `${path}: sign the rigging plan at or after plan.rigging_drafted_at` });
  }
  const approval = latestSignoff(ctx, 'plan-approved');
  if (approval !== undefined && Number.isFinite(draftedAt) && !(approval.at >= draftedAt)) {
    const path = `signoffs[${approval.index}]`;
    ctx.refusals.push({ code: 'SIGNOFF_BEFORE_PLAN', path, message: `${path}: no plan-approved sign-off is at or after plan.drafted_at ${String(plan.drafted_at)}; sign the drafted plan before running its steps` });
  }
  for (const s of ctx.signoffs) {
    const path = `signoffs[${s.index}]`;
    const idx = stageIndex(s.stage);
    if (idx === -1 && s.stage !== PAUSED_STAGE) {
      ctx.refusals.push({ code: 'SIGNOFF_UNKNOWN_STAGE', path, message: `${path}: stage '${s.stage}' is not a stage (${STAGE_VALUES.join(', ')})` });
      continue;
    }
    if (!paused && idx > signoffLimit) {
      ctx.refusals.push({ code: 'SIGNOFF_AHEAD_OF_STAGE', path, message: `${path}: signs '${s.stage}'${s.checkpoint === null ? '' : ` checkpoint '${s.checkpoint}'`}, which is later than the project's stage '${ctx.stage}'` });
    }
    if (s.checkpoint !== null) {
      const step = stepFor(ctx, s.checkpoint);
      if (step === undefined || !checkpointStages(ctx, step).includes(s.stage)) {
        ctx.refusals.push({ code: 'SIGNOFF_UNKNOWN_CHECKPOINT', path, message: `${path}: checkpoint '${s.checkpoint}' names no plan step of the '${s.stage}' phase` });
      }
    }
  }
  if (paused) {
    if (!ctx.signoffs.some((s) => s.stage === PAUSED_STAGE)) {
      ctx.refusals.push({ code: 'PAUSED_UNSIGNED', path: 'stage', message: `stage is paused, but no { "stage": "paused" } sign-off stopped it` });
    }
  }
  const skip = postNotPassed(ctx) ? new Set(SKIPPED_WHEN_NO_POST) : new Set<string>();
  if (ctx.predatesPartsReview !== null) skip.add(PARTS_REVIEW);
  STAGES.forEach((spec, idx) => {
    if (!hasStageOrder(ctx.project) && spec.id === 'rigging-interview') return;
    if (idx >= cur || spec.closed_by !== 'signoff' || skip.has(spec.id)) return;
    if (signed(ctx, spec.id)) return;
    if (spec.id === 'rigging-interview') {
      ctx.refusals.push({ code: 'RIGGING_INTERVIEW_UNSIGNED', path: 'stage', message: `stage: rigging requires the person's rigging-interview sign-off; ask the rig guides after parts review and sign their plan` });
      return;
    }
    if (spec.id === PARTS_REVIEW) {
      ctx.refusals.push({ code: 'PARTS_REVIEW_UNSIGNED', path: 'stage', message: `stage is '${ctx.stage}', past '${PARTS_REVIEW}', but no person signed { "stage": "${PARTS_REVIEW}", "checkpoint": null }; ${PARTS_REVIEW_REMEDY}` });
      return;
    }
    ctx.refusals.push({ code: 'STAGE_UNSIGNED', path: 'stage', message: `stage is '${ctx.stage}', past '${spec.id}', but no { "stage": "${spec.id}", "checkpoint": null } sign-off closed it` });
  });
  checkPartsStages(ctx);
}

const PARTS_REVIEW_REMEDY =
  'rigging does not start until the user has looked at the assembled parts (rig-review\'s parts view) and signed them, or the stage goes back to parts-review';

/**
 * The parts are made and reviewed before any rig is built (rig-c/create#48):
 * past `parts`, every step it runs is `done` (its bar met); no step of
 * `rigging` has run before `parts-review` is signed; and a project that passed
 * `plan-approved` before the two stages existed is reported, not refused.
 *
 * Once rigging has started (the stage is past `parts-review`, or a rigging
 * step is past `pending`) and until a rig version is accepted at rig-review
 * (while the stage is at most `rigging`, or no rig version is accepted yet),
 * the latest `parts-review` sign-off binds its retained API response (src/parts-verdict-record.ts). An in-flight
 * project keeps the warning above and is not asked for one.
 */
function checkPartsStages(ctx: Ctx): void {
  const cur = effectiveIndex(ctx);
  const partsIdx = stageIndex('parts');
  const reviewIdx = stageIndex(PARTS_REVIEW);
  if (ctx.predatesPartsReview !== null) {
    if (cur > reviewIdx && !signed(ctx, PARTS_REVIEW)) {
      const name = asString(ctx.project.name) ?? basename(ctx.dir);
      ctx.warnings.push({
        code: 'PARTS_REVIEW_PREDATES_STAGE',
        path: 'signoffs',
        message: `project '${name}' passed plan-approved at ${ctx.predatesPartsReview}, before the parts and parts-review stages existed (${PARTS_REVIEW_SINCE}); its parts were not reviewed before rigging, and no sign-off is assumed for them`,
      });
    }
    // A legacy project may omit a map, but a map it does carry is checked in full.
    if (latestSignoff(ctx, PARTS_REVIEW)?.record.diff_map !== undefined || ctx.project.diff_map !== undefined) checkPartsReviewEvidence(ctx);
    return;
  }
  for (const step of ctx.steps) {
    const stage = stageOfStep(step.phase, step.id);
    const status = asString(step.record.status) ?? 'pending';
    if (stage === 'parts' && cur > partsIdx && status !== 'done') {
      ctx.refusals.push({ code: 'PARTS_BAR_UNMET', path: step.path, message: `${step.path} is ${status}, yet the stage is past 'parts'; the parts stage ends when every step it runs (${STAGES[partsIdx]?.steps?.join(', ') ?? ''}) has met its bar, the parts check passing on the assembled parts` });
    }
    if (stage === 'rigging' && cur <= reviewIdx && status !== 'pending' && !signed(ctx, PARTS_REVIEW)) {
      ctx.refusals.push({ code: 'PARTS_REVIEW_UNSIGNED', path: step.path, message: `${step.path} is ${status}, but no person signed { "stage": "${PARTS_REVIEW}", "checkpoint": null }; ${PARTS_REVIEW_REMEDY}` });
    }
  }
  checkPartsReviewEvidence(ctx);
}

function checkPartsReviewEvidence(ctx: Ctx): void {
  const cur = effectiveIndex(ctx);
  const reviewIdx = stageIndex(PARTS_REVIEW);
  const riggingStarted =
    cur > reviewIdx || ctx.steps.some((s) => stageOfStep(s.phase, s.id) === 'rigging' && (asString(s.record.status) ?? 'pending') !== 'pending');
  // The parts gate rigging until a rig version is accepted at rig-review; after that a part change is a new rig
  // version, which RIG_VERSION_UNACCEPTED refuses (src/review.ts), and derived/ need not survive a clone.
  const gating = cur <= stageIndex('rigging') || latestAccepted(readVersions(ctx.project)) === null;
  if (!riggingStarted || !gating) return;
  const latest = latestSignoff(ctx, PARTS_REVIEW);
  if (latest === undefined) return;
  const at = `signoffs[${latest.index}]`;
  let partsFile: string | undefined;
  if (!recordedPartsFinding(ctx.dir, ctx.project, latest.record, at)) partsFile = recordedPartsVerdict(ctx.dir, ctx.project, latest.record.draft_id, latest.record.evidence, { requireAvailable: false }).partsFile;
  checkDiffMap(ctx.dir, latest.record, at, partsFile, ctx.refusals, ctx.warnings, ctx.project);
}

/**
 * Every parts-review signature, reopened ones included, binds a retained API receipt.
 * Legacy saved-file bindings WARN without opening their files.
 */
function checkPartsVerdictDrafts(ctx: Ctx, history: readonly Signoff[]): void {
  for (const s of history) {
    if (s.stage !== PARTS_REVIEW) continue;
    const finding = recordedPartsFinding(ctx.dir, ctx.project, s.record, `signoffs[${s.index}]`);
    if (finding) (finding.code === 'PARTS_VERDICT_FILE_LEGACY' ? ctx.warnings : ctx.refusals).push(finding);
  }
}

/** The latest stage-level sign-off, optionally covering a step, by date then array position. Undated counts as earliest. */
function latestSignoff(ctx: Ctx, stage: string, stepId?: string): Signoff | undefined {
  let best: Signoff | undefined;
  for (const s of signoffsFor(ctx, stage)) {
    if (stepId !== undefined && s.steps !== null && !s.steps.includes(stepId)) continue;
    const at = Number.isNaN(s.at) ? -Infinity : s.at;
    const bestAt = best === undefined || Number.isNaN(best.at) ? -Infinity : best.at;
    if (best === undefined || at >= bestAt) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------- entry

/**
 * With a candidate record, validate the would-be write against the same project files without writing it.
 * `options.now` is the instant the check runs at (ms since the epoch); see README.md "The clock".
 * With `options.recordReads`, the report also lists every project file the check read (`reads`).
 * `recordPublication` checks the decision record and its answer/approval evidence,
 * without revalidating producer artifacts. Stage resolution and record predicates
 * are shared; the default remains the full project check.
 */
export function checkProject(projectDirArg: string, candidate: JsonObject | undefined, options: { now: number; forwardWrite?: boolean; readOnly?: boolean; recordReads?: boolean; recordPublication?: boolean }): CheckReport {
  const run = (): CheckReport => candidate === undefined
    ? checkProjectOnce(projectDirArg, candidate, options)
    : withCandidateProject(projectDirArg, candidate, () => checkProjectOnce(projectDirArg, candidate, options));
  if (!options.recordReads) return run();
  const { value, reads } = recordCheckReads(projectDirArg, run);
  return { ...value, reads };
}

function checkProjectOnce(projectDirArg: string, candidate: JsonObject | undefined, options: { now: number; forwardWrite?: boolean; readOnly?: boolean; recordPublication?: boolean }): CheckReport {
  const dir = resolve(projectDirArg);
  const refusals: Finding[] = [];
  const warnings: Finding[] = [];
  const holes = pendingPublicationHoles(dir, options.readOnly);
  const fail = (partial: Partial<CheckReport> = {}): CheckReport => ({
    ok: false,
    project_dir: dir,
    stage: null,
    effective_stage: null,
    parts: null,
    derived: null,
    invariants: null,
    provenance: [],
    feedback: [],
    refusals,
    warnings,
    ...(holes.length ? { holes } : {}),
    ...partial,
  });

  const file = join(dir, 'project.json');
  if (candidate === undefined && !existsSync(file)) {
    refusals.push({ code: 'PROJECT_JSON_MISSING', path: file, message: `${file} does not exist; run the check in a project folder or name one` });
    return fail();
  }
  const read = candidate === undefined ? readJsonObject(file) : { ok: true as const, value: candidate };
  if (!read.ok) {
    refusals.push({ code: 'PROJECT_JSON_INVALID', path: file, message: `${file}: ${read.error}` });
    return fail();
  }
  const project = read.value;
  if (project.schema !== PROJECT_SCHEMA) {
    refusals.push({ code: 'SCHEMA_UNKNOWN', path: 'schema', message: `schema is ${JSON.stringify(project.schema ?? null)}; this check reads ${PROJECT_SCHEMA}` });
    return fail();
  }

  const stage = asString(project.stage);
  if (stage === null || !STAGE_VALUES.includes(stage)) {
    refusals.push({ code: 'STAGE_UNKNOWN', path: 'stage', message: `stage is ${JSON.stringify(project.stage ?? null)}; the stages are ${STAGE_VALUES.join(', ')}` });
    return fail();
  }
  const invariants = translateInvariants(project);
  const expectedValues = hasStageOrder(project) ? STAGE_VALUES : LEGACY_STAGE_VALUES;
  const recordValues = asArray(project.stage_values).filter((x): x is string => typeof x === 'string');
  if (recordValues.join(',') !== expectedValues.join(',')) {
    warnings.push({ code: 'STAGE_VALUES_STALE', path: 'stage_values', message: `stage_values is [${recordValues.join(', ')}]; the order in src/stages.ts is [${expectedValues.join(', ')}]` });
  }

  checkCollectionBinding(dir, project, refusals);
  const collection = loadCollection(dir, project);
  const reopens = collectReopens(project, refusals);
  const historySignoffs = collectSignoffs(project, refusals).filter(s => {
    if (STAGE_VALUES.includes(s.stage)) return true;
    const path = `signoffs[${s.index}]`;
    refusals.push({ code: 'SIGNOFF_UNKNOWN_STAGE', path, message: `${path}: unknown stage ${s.stage}; use a known stage` });
    return false;
  });
  for (const s of historySignoffs) checkSignoffTarget(dir, project, s.record, `signoffs[${s.index}]`, refusals, warnings);
  const signoffs = historySignoffs.filter(s => liveSignoff(reopens, s.stage, s.at));
  const steps = collectSteps(project, refusals);
  collectCheckpointWithdrawals(project, refusals, options.now);
  collectBarAmendments(project, refusals, options.now);
  const replaced = collectPlanReplaced(project, refusals);
  checkReplacedSignoffs(project, replaced, refusals);
  const previousSteps = collectSteps({ plan: { steps: replaced.map(entry => entry.step) } }, []);
  const items = collectItems(project, { collection });
  const planApprovedAt = planApprovedBeforePartsReview(historySignoffs);
  // Superseded signatures grant no authority, but malformed checkpoint history is still reported.
  for (const s of historySignoffs) {
    if (liveSignoff(reopens, s.stage, s.at) || s.checkpoint === null) continue;
    const found = [...steps, ...previousSteps].some(step => step.id === s.checkpoint
      && (s.stage === stageOfStep(step.phase, step.id) || (planApprovedAt !== null && s.stage === stageOfStep(step.phase, ''))));
    if (!found) {
      const path = `signoffs[${s.index}]`;
      refusals.push({ code: 'SIGNOFF_UNKNOWN_CHECKPOINT', path, message: `${path}: historical checkpoint ${s.checkpoint} names no step in ${s.stage}; restore the original signature` });
    }
  }
  const amendments = collectAmendments(project, []);
  const postItems = items.filter(i => i.kind === 'post');
  const noPost = postItems.length > 0 && postItems.every(i => i.state.state === 'not_applicable');
  const amendedFrom = Math.min(...amendments.map(a => stageIndex(a.stage)));
  const resumeStage = firstUnsignedStage(signoffs, steps, planApprovedAt !== null, hasStageOrder(project), amendedFrom, noPost);
  const effectiveStage = stage === PAUSED_STAGE ? resumeStage
    : amendments.length > 0 && stageIndex(resumeStage) < stageIndex(stage) ? resumeStage : stage;
  // Only a project already past `parts-review` when the stage arrived is exempt; one still at or before it goes through it.
  const predatesPartsReview = planApprovedAt !== null && stageIndex(effectiveStage) > stageIndex(PARTS_REVIEW) ? planApprovedAt : null;
  const ctx: Ctx = { dir, project, refusals, warnings, items, signoffs, steps, stage, effectiveStage, collection, predatesPartsReview };

  for (const s of signoffs) checkSignoffAnswers(ctx, s.record, `signoffs[${s.index}]`);

  let parts: PartsSections | null = null;
  let derived: DerivedSet | null = null;
  try {
    parts = readPartsSections(dir);
    derived = deriveWaypoints(parts.sections);
    checkDerived(ctx, parts, derived);
  } catch (e) {
    if (!(e instanceof PartsUnreadable)) throw e;
    refusals.push({ code: e.code, path: '@rig-c/parts', message: e.message });
  }
  if (!options.recordPublication) checkDrafts(dir, project, refusals, warnings);
  const ledger = options.recordPublication ? [] : checkFixLedger(dir, project, refusals, warnings, options.now);
  if (!options.recordPublication) refusals.push(...draftVersionFindings(dir, project));
  checkRiggingContext(dir, project, effectiveStage, refusals);
  if (!options.recordPublication) checkPartsVerdictDrafts(ctx, historySignoffs);
  checkAdvances(ctx);
  checkAnswers(ctx);
  checkOverrides(project, collection, refusals, warnings);
  checkAskCoverage(ctx);
  if (!options.recordPublication) checkPreparedInputs(ctx);
  checkAgentBounces(ctx);
  checkPlan(ctx);
  checkCheckpointEvidence(dir, project, refusals);
  warnings.push(...appearanceBarWarnings(project, options.now));
  checkStages(ctx);
  checkStageProgress(ctx, options.forwardWrite);
  checkAdvanceBars(ctx);
  checkStepStatusHistory(ctx);
  checkProgressLinkage(ctx);
  checkPauses(ctx);
  if (!options.recordPublication) checkPartsChecks(ctx, options.forwardWrite);
  if (!options.recordPublication) checkPreInterview(ctx);
  if (!options.recordPublication) checkReviews(ctx);
  if (!options.recordPublication) checkPublicationGenerations(dir, project, refusals);
  if (!options.recordPublication) checkReviewPackages(ctx);
  if (!options.recordPublication) refusals.push(...rigRegistrationFindings(dir, project, warnings));
  if (!options.recordPublication) checkAppliedReview(ctx);
  const provenance = options.recordPublication ? [] : checkProvenance(ctx, parts);
  const feedback = options.recordPublication ? [] : checkFeedback(ctx);
  refusals.push(...reviewActFindings(project), ...partsActFindings(dir, project), ...(options.recordPublication ? [] : partsReadFindings(dir, project)));
  for (const [index, raw] of asArray(project.signoffs).entries()) {
    if (!isObject(raw) || raw.stage !== 'parts-review' || typeof raw.draft_id !== 'string') continue;
    const finding = latestPartsVerdictFinding(project, raw.draft_id, `signoffs[${index}].draft_id`);
    if (finding) (typeof raw.at === 'string' && Date.parse(raw.at) < Date.parse(PARTS_VERDICT_LATEST_SINCE) ? warnings : refusals).push(finding);
  }
  checkCgGates(ctx, options.recordPublication);
  if (!options.recordPublication) checkSetupPainting(ctx);
  if (!options.recordPublication) checkFigureMask(ctx);
  checkMeshesBust(ctx);
  if (!hasStageOrder(project)) warnings.push(STAGE_ORDER_LEGACY_FINDING);
  checkInputs(ctx);
  checkChoices(ctx);
  if (!options.recordPublication) checkCorrections(ctx, options.now);
  if (!options.recordPublication) checkScenes(ctx);
  if (!options.recordPublication) checkDirections(ctx, options.now);
  if (!options.recordPublication) warnings.push(...intakeWarnings(dir, project));
  warnings.push(...reopenLapseWarnings(project));

  return {
    ok: refusals.length === 0 && holes.length === 0,
    project_dir: dir,
    stage,
    effective_stage: effectiveStage,
    parts: parts === null ? null : { version: parts.version, read_from: parts.read_from, dir: parts.dir },
    derived: derived === null ? null : { waypoints: derived.waypoints.map((w) => w.id), post_items: derived.post_items.map((p) => p.id) },
    invariants,
    provenance,
    feedback,
    ...(amendments.length === 0 ? {} : { amendments: amendmentSummaries(project, amendments, reopens) }),
    ...(ledger.length === 0 ? {} : { ledger }),
    refusals,
    warnings,
    ...(holes.length ? { holes } : {}),
  };
}

/** The human-readable report: one line per finding, then a summary. */
export function formatReport(report: CheckReport): string {
  const lines = [`interview --check: ${report.project_dir}`];
  if (report.parts !== null && report.derived !== null) {
    lines.push(
      `  @rig-c/parts ${report.parts.version} (${report.parts.read_from}): ${report.derived.waypoints.length} waypoints (${report.derived.waypoints.join(', ')}), ${report.derived.post_items.length} post items`,
    );
  }
  if (report.stage !== null) {
    lines.push(`  stage ${report.stage}${report.effective_stage !== report.stage ? ` (checked as ${report.effective_stage})` : ''}`);
  }
  lines.push(...formatProvenance(report.provenance));
  lines.push(...formatFeedback(report.feedback));
  for (const amendment of report.amendments ?? []) {
    lines.push(`  ${amendment.path} ${String(amendment.target.stage)} ${String(amendment.target.kind)} ${String(amendment.target.id)}`);
    lines.push(`    lapsed (${amendment.lapsed.length})`);
    for (const a of amendment.lapsed) lines.push(`      ${a.path} ${a.stage}${a.checkpoint === undefined ? '' : ` checkpoint ${a.checkpoint}`}: ${a.reason} (${a.gap})`);
    lines.push(`    upstream live (${amendment.upstream.length})`);
    for (const a of amendment.upstream) lines.push(`      ${a.path} ${a.stage}: ${a.reason}`);
    lines.push(`    keep-by-binding (${amendment.keep_by_binding.length})`);
  }
  for (const entry of report.ledger ?? []) {
    lines.push(`  drafts[${entry.draft}] fixes [${entry.fixes.join(', ')}]${entry.known_regressions.length ? `; known regressions [${entry.known_regressions.join(', ')}]` : ''}`);
  }
  for (const r of report.refusals) lines.push(`  REFUSED ${r.code}: ${r.message}`);
  for (const w of report.warnings) lines.push(`  warning ${w.code}: ${w.message}`);
  for (const hole of report.holes ?? []) lines.push(`  HOLE ${hole.code}: ${hole.message}`);
  const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
  lines.push(
    report.ok
      ? `clean: ${n(report.warnings.length, 'warning')}; the record is complete for stage ${report.stage}`
      : `not clear: ${n(report.refusals.length, 'refusal')}, ${n(report.warnings.length, 'warning')}${report.holes?.length ? `, ${n(report.holes.length, 'hole')}` : ''}`,
  );
  return lines.join('\n');
}
