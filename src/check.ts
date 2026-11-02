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
 * review order and post hand-off (#8, by extending src/stages.ts), feedback
 * answered by the next version (#9, over `versions[].verdicts` and
 * `answers_feedback`), collection pins (#7, over `collection.json`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { PartsUnreadable, readPartsSections, type PartsSections } from './parts-sections.ts';
import { checkProvenance, formatProvenance, type ProvenanceSummary } from './provenance.ts';
import { checkReviews } from './review.ts';
import { PAUSED_STAGE, PHASE_APPROVED_BY, SKIPPED_WHEN_NO_POST, STAGE_VALUES, STAGES, stageIndex, stageOfPhase } from './stages.ts';
import type { Json, JsonObject } from './templates.ts';
import { deriveWaypoints, FRAMING_IDS, type DerivedSet } from './waypoints.ts';

export const PROJECT_SCHEMA = 'rig-create/project@0';
export const COLLECTION_SCHEMA = 'rig-create/collection@0';

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
  /** Per version built from a config: whether the config file was read to list its sections (docs/CHECKS.md § Provenance). */
  readonly provenance: ProvenanceSummary[];
  readonly refusals: Finding[];
  readonly warnings: Finding[];
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

function readJsonObject(file: string): ReadJson {
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
function collectionAnswer(collection: JsonObject, question: string): Json | undefined {
  const interview = isObject(collection.interview) ? collection.interview : {};
  for (const q of asArray(interview.questions)) if (isObject(q) && q.id === question) return q.answer;
  for (const q of asArray(interview.framing)) if (isObject(q) && q.id === question) return q.answer;
  for (const w of asArray(interview.waypoints)) if (isObject(w) && w.id === question) return w.guide;
  const post = isObject(interview.post) ? interview.post : {};
  for (const p of asArray(post.items)) if (isObject(p) && p.id === question) return p.guide;
  return undefined;
}

function classify(raw: Json | undefined, ctx: Pick<Ctx, 'collection'>, depth = 0): AnswerState {
  if (raw === null || raw === undefined) return { state: 'silent' };
  if (!isObject(raw)) return { state: 'malformed', why: 'an answer is an object or null' };
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

function loadCollection(dir: string): JsonObject | null {
  if (basename(dirname(dir)) !== 'members') return null;
  const file = join(dirname(dirname(dir)), 'collection.json');
  if (!existsSync(file)) return null;
  const read = readJsonObject(file);
  return read.ok ? read.value : null;
}

function collectItems(project: JsonObject, ctx: Pick<Ctx, 'collection'>): Item[] {
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

function collectSignoffs(project: JsonObject, refusals: Finding[]): Signoff[] {
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
    out.push({ index, stage: stage as string, checkpoint, at: time(s.at), steps });
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
function postNotPassed(ctx: Ctx): boolean {
  const post = ctx.items.filter((i) => i.kind === 'post');
  return post.length > 0 && post.every((i) => i.state.state === 'not_applicable');
}

/** The first stage closed by a sign-off that has none: where a paused project resumes, and what its checks are applied as. */
function firstUnsignedStage(signoffs: Signoff[]): string {
  for (const s of STAGES) {
    if (s.closed_by === 'signoff' && !signoffs.some((x) => x.stage === s.id && x.checkpoint === null)) return s.id;
  }
  return STAGES[STAGES.length - 1]?.id ?? 'accepted';
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
    if (state.state === 'malformed') {
      ctx.refusals.push({ code: 'ANSWER_MALFORMED', path, message: `${path}: ${state.why}` });
      continue;
    }
    if (state.state === 'unresolved') {
      ctx.refusals.push({ code: 'INHERITED_UNRESOLVED', path, message: `${path}: ${state.why}` });
      continue;
    }
    if (state.state === 'silent') {
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
      if (cur <= interviewIdx) {
        ctx.refusals.push({ code: 'INTERVIEW_INCOMPLETE', path, message: `${path}: not answered yet${via}; the interview is incomplete` });
      } else {
        const code = item.kind === 'framing' ? 'FRAMING_SILENT' : 'WAYPOINT_SILENT';
        ctx.refusals.push({ code, path, message: `${path}: no guide and no delegation${via}, yet the stage is past interview` });
      }
      continue;
    }
    if (state.state === 'delegated' && !state.decided) {
      const approvedBy = item.kind === 'post' ? PHASE_APPROVED_BY.post : PHASE_APPROVED_BY.rig;
      if (signed(ctx, approvedBy)) {
        ctx.refusals.push({ code: 'DELEGATION_UNDECIDED', path, message: `${path}: delegated, but agent_decision is missing and ${approvedBy} is signed; the agent's decision is written before the plan is signed` });
      }
    }
  }
}

function checkPlan(ctx: Ctx): void {
  const planSigned = signed(ctx, PHASE_APPROVED_BY.rig);
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
    const restsOn = asArray(record.rests_on).filter((x): x is string => typeof x === 'string');
    if (restsOn.length === 0) {
      ctx.refusals.push({ code: 'STEP_NO_BASIS', path, message: `${path}: rests_on is empty; a step never rests on nothing` });
    }
    for (const id of restsOn) {
      const item = itemFor(ctx, id);
      if (item === undefined) {
        ctx.refusals.push({ code: 'STEP_BASIS_UNKNOWN', path, message: `${path}: rests on '${id}', which is no framing, waypoint or post item of this interview` });
      } else if (!answered(item.state)) {
        ctx.refusals.push({ code: 'STEP_BASIS_SILENT', path, message: `${path}: rests on '${id}', which has no answer (${item.path} is ${item.state.state})` });
      }
    }
    const approvedBy = PHASE_APPROVED_BY[step.phase];
    const approvals = signoffsFor(ctx, approvedBy);
    const status = asString(record.status) ?? 'pending';
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
    if (status === 'pending') continue;
    // The step has run (or is running): it needs the approving sign-off, given after every answer it rests on last changed.
    const covering = approvals.filter((s) => s.steps === null || s.steps.includes(step.id));
    if (covering.length === 0) {
      ctx.refusals.push({ code: 'STEP_RUN_UNAPPROVED', path, message: `${path} is ${status}, but no ${approvedBy} sign-off covers it` });
    } else {
      const latestApproval = Math.max(...covering.map((s) => s.at).filter((t) => !Number.isNaN(t)), Number.NEGATIVE_INFINITY);
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
    const on = checkpoint.state === 'user' ? checkpoint.answer.value === true
      : checkpoint.state === 'delegated' && isObject(checkpoint.answer.agent_decision) ? checkpoint.answer.agent_decision.value === true
      : false;
    if (on && status === 'done') {
      const stage = stageOfPhase(step.phase);
      if (!ctx.signoffs.some((s) => s.stage === stage && s.checkpoint === step.id)) {
        ctx.refusals.push({ code: 'CHECKPOINT_UNSIGNED', path, message: `${path} is done with its checkpoint on, but no { "stage": "${stage}", "checkpoint": "${step.id}" } sign-off exists` });
      }
    }
  }
  if (planSigned) {
    for (const item of ctx.items) {
      if (item.kind !== 'waypoint') continue;
      if ((item.state.state === 'user' || item.state.state === 'delegated') && !ctx.steps.some((s) => s.phase === 'rig' && s.id === item.id)) {
        ctx.refusals.push({ code: 'STEP_MISSING_FOR_WAYPOINT', path: `plan.steps[${item.id}]`, message: `waypoint '${item.id}' has a guide but the signed plan has no rig step '${item.id}'; one step per waypoint the plan passes` });
      }
    }
  }
}

function checkStages(ctx: Ctx): void {
  const cur = effectiveIndex(ctx);
  const paused = ctx.stage === PAUSED_STAGE;
  for (const s of ctx.signoffs) {
    const path = `signoffs[${s.index}]`;
    const idx = stageIndex(s.stage);
    if (idx === -1 && s.stage !== PAUSED_STAGE) {
      ctx.refusals.push({ code: 'SIGNOFF_UNKNOWN_STAGE', path, message: `${path}: stage '${s.stage}' is not a stage (${STAGE_VALUES.join(', ')})` });
      continue;
    }
    if (!paused && idx > cur) {
      ctx.refusals.push({ code: 'SIGNOFF_AHEAD_OF_STAGE', path, message: `${path}: signs '${s.stage}'${s.checkpoint === null ? '' : ` checkpoint '${s.checkpoint}'`}, which is later than the project's stage '${ctx.stage}'` });
    }
    if (s.checkpoint !== null) {
      const step = stepFor(ctx, s.checkpoint);
      const expectedStage = step === undefined ? null : stageOfPhase(step.phase);
      if (step === undefined || expectedStage !== s.stage) {
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
  STAGES.forEach((spec, idx) => {
    if (idx >= cur || spec.closed_by !== 'signoff' || skip.has(spec.id)) return;
    if (!signed(ctx, spec.id)) {
      ctx.refusals.push({ code: 'STAGE_UNSIGNED', path: 'stage', message: `stage is '${ctx.stage}', past '${spec.id}', but no { "stage": "${spec.id}", "checkpoint": null } sign-off closed it` });
    }
  });
}

// ---------------------------------------------------------------------- entry

export function checkProject(projectDirArg: string): CheckReport {
  const dir = resolve(projectDirArg);
  const refusals: Finding[] = [];
  const warnings: Finding[] = [];
  const fail = (partial: Partial<CheckReport> = {}): CheckReport => ({
    ok: false,
    project_dir: dir,
    stage: null,
    effective_stage: null,
    parts: null,
    derived: null,
    provenance: [],
    refusals,
    warnings,
    ...partial,
  });

  const file = join(dir, 'project.json');
  if (!existsSync(file)) {
    refusals.push({ code: 'PROJECT_JSON_MISSING', path: file, message: `${file} does not exist; run the check in a project folder or name one` });
    return fail();
  }
  const read = readJsonObject(file);
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
  const recordValues = asArray(project.stage_values).filter((x): x is string => typeof x === 'string');
  if (recordValues.join(',') !== STAGE_VALUES.join(',')) {
    warnings.push({ code: 'STAGE_VALUES_STALE', path: 'stage_values', message: `stage_values is [${recordValues.join(', ')}]; the order in src/stages.ts is [${STAGE_VALUES.join(', ')}]` });
  }

  const collection = loadCollection(dir);
  const signoffs = collectSignoffs(project, refusals);
  const steps = collectSteps(project, refusals);
  const items = collectItems(project, { collection });
  const effectiveStage = stage === PAUSED_STAGE ? firstUnsignedStage(signoffs) : stage;
  const ctx: Ctx = { dir, project, refusals, warnings, items, signoffs, steps, stage, effectiveStage, collection };

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
  checkAnswers(ctx);
  checkPlan(ctx);
  checkStages(ctx);
  checkReviews(ctx);
  const provenance = checkProvenance(ctx, parts);

  return {
    ok: refusals.length === 0,
    project_dir: dir,
    stage,
    effective_stage: effectiveStage,
    parts: parts === null ? null : { version: parts.version, read_from: parts.read_from, dir: parts.dir },
    derived: derived === null ? null : { waypoints: derived.waypoints.map((w) => w.id), post_items: derived.post_items.map((p) => p.id) },
    provenance,
    refusals,
    warnings,
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
  for (const r of report.refusals) lines.push(`  REFUSED ${r.code}: ${r.message}`);
  for (const w of report.warnings) lines.push(`  warning ${w.code}: ${w.message}`);
  const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
  lines.push(
    report.ok
      ? `clean: ${n(report.warnings.length, 'warning')}; the record is complete for stage ${report.stage}`
      : `not clear: ${n(report.refusals.length, 'refusal')}, ${n(report.warnings.length, 'warning')}`,
  );
  return lines.join('\n');
}
