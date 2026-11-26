import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from './check-reads.ts';
import { asArray, asString, collectItems, collectSignoffs, isObject, loadCollection, postNotPassed, type Ctx, type Finding } from './check.ts';
import { currentShapeFindings } from './current.ts';
import { DIRECTION_SCENE_SINCE } from './direction.ts';
import { DIRECTION_COMPOSE_SPEC } from './direction-compose.ts';
import { currentScene as currentSceneEntry, SceneError, sceneCurrentAt } from './scene.ts';
import { LEGACY_STAGES, PARTS_REVIEW_SINCE, PAUSED_STAGE, STAGES, stageIndex, stageOfStep, type StageSpec } from './stages.ts';
import { amendmentResetsStep, collectAmendments } from './amend.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import type { Json, JsonObject } from './templates.ts';

/** Dates a history link break by the earliest recorded event the unrecorded move must follow. */
export const PROGRESS_HISTORY_SINCE = '2026-11-08T00:00:00Z';

/** Dates the post authoring requirement on a post → direction-review move by the advance's own `at`. */
export const DIRECTION_REVIEW_ADVANCE_SINCE = '2026-11-18T00:00:00Z';

/** Dates the required painting declaration by the move into production rigging. */
export const RIGGING_INTERVIEW_PAINTING_SINCE = '2026-11-22T00:00:00Z';

export function checkRiggingInterviewPainting(ctx: Ctx): void {
  if (ctx.project.painting !== undefined) return;
  const exit = asArray(ctx.project.advances).findLast(move => isObject(move) && move.stage === 'rigging'
    && ['rigging-interview', 'parts-review', 'plan-approved'].includes(String(move.from_stage)));
  const rigging = stageIndex('rigging');
  // Before explicit moves, a retained downstream signature witnesses that the project
  // had already crossed the boundary, even when the project has since reopened.
  const historicalDates = exit === undefined ? collectSignoffs(ctx.project, [])
    .filter(s => stageIndex(s.stage) >= rigging
      || (s.stage === 'rigging-interview' && s.checkpoint === null && stageIndex(ctx.stage) >= rigging))
    .map(s => s.at).filter(Number.isFinite) : [];
  if (!isObject(exit) && historicalDates.length === 0) return;
  const at = isObject(exit) ? Date.parse(String(exit.at)) : Math.min(...historicalDates);
  const old = at < Date.parse(RIGGING_INTERVIEW_PAINTING_SINCE);
  (old ? ctx.warnings : ctx.refusals).push({
    code: old ? 'RIGGING_INTERVIEW_PAINTING_LEGACY' : 'RIGGING_INTERVIEW_PAINTING_REQUIRED',
    path: 'painting',
    message: `painting: ${old ? 'historical rigging-interview exit has no declared painting' : 'declare a painting before leaving rigging-interview'}; run rig-create input painting <registered input path>`,
  });
}

/** Select the latest signature at the furthest still-live closing stage. */
export function furthestStageSignoff(signoffs: Ctx['signoffs']): Ctx['signoffs'][number] | undefined {
  return signoffs.filter(s => s.checkpoint === null && STAGES.some(stage => stage.id === s.stage && stage.closed_by === 'signoff'))
    .sort((a, b) => stageIndex(b.stage) - stageIndex(a.stage)
      || (Number.isFinite(b.at) ? b.at : -Infinity) - (Number.isFinite(a.at) ? a.at : -Infinity) || b.index - a.index)[0];
}

/** Stable approval identity survives insertion and reordering of signoffs[]. */
export function signoffIdentity(record: JsonObject): JsonObject {
  return { stage: record.stage!, checkpoint: record.checkpoint ?? null, at: record.at! };
}

export function isSignoffIdentity(value: Json | undefined): value is JsonObject {
  return isObject(value) && Object.keys(value).length === 3 && typeof value.stage === 'string'
    && (value.checkpoint === null || typeof value.checkpoint === 'string')
    && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at));
}

export function matchesSignoff(identity: Json | undefined, record: JsonObject): boolean {
  return isSignoffIdentity(identity) && identity.stage === record.stage
    && identity.checkpoint === (record.checkpoint ?? null) && identity.at === record.at;
}

function resolveSignoff(project: JsonObject, identity: Json | undefined): JsonObject | undefined {
  const matches = asArray(project.signoffs).filter((raw): raw is JsonObject => isObject(raw) && matchesSignoff(identity, raw));
  return matches.length === 1 ? matches[0] : undefined;
}

/** The stage order an advance entry's `order` names. */
export function advanceOrder(order: Json | undefined): readonly StageSpec[] {
  return order === 'pre-parts' ? LEGACY_STAGES.filter(s => !['parts', 'parts-review'].includes(s.id))
    : order === 'legacy' ? LEGACY_STAGES : STAGES;
}

/** Advances are history: a shape check only. Any stage may follow any other; signoff is the live signature at the move, or null. */
export function checkAdvances(ctx: Ctx): void {
  const push = (path: string, why: string): void => {
    ctx.refusals.push({ code: 'ADVANCE_MALFORMED', path, message: `${path}: ${why}; preserve the original move` });
  };
  if (ctx.project.advances !== undefined && !Array.isArray(ctx.project.advances)) push('advances', 'must be a list');
  for (const [index, entry] of asArray(ctx.project.advances).entries()) {
    const path = `advances[${index}]`;
    // Entries written before the signoff identity carry the mover's by and verbatim, both or neither.
    if (!isObject(entry) || ['stage', 'from_stage', 'at'].some(k => asString(entry[k]) === null)
      || ('by' in entry || 'verbatim' in entry) && ['by', 'verbatim'].some(k => asString(entry[k]) === null)
      || !Number.isFinite(Date.parse(String(entry.at))) || (entry.source !== undefined && typeof entry.source !== 'string')
      || typeof entry.post_not_passed !== 'boolean'
      || !(entry.signoff === null || isSignoffIdentity(entry.signoff)) || !Array.isArray(entry.signoffs_before)
      || !entry.signoffs_before.every(isSignoffIdentity)
      || !Array.isArray(entry.steps_before)) { push(path, 'needs reopen-shaped fields and stable signoff identities'); continue; }
    if (entry.steps_before.some(s => !isObject(s) || typeof s.id !== 'string' || !['rig', 'post'].includes(String(s.phase)) || (s.status !== undefined && !STEP_STATUSES.includes(s.status as typeof STEP_STATUSES[number])))) push(path, 'steps_before must retain step ids, phases and original statuses');
    if (stageIndex(String(entry.stage)) < 0 || stageIndex(String(entry.from_stage)) < 0
      || !['legacy', 'split', 'pre-parts'].includes(String(entry.order))) push(path, 'needs a recorded order and stages of that order');
    // A recorded signoff identity must still name a recorded signoff (integrity, not authority).
    if (entry.signoff !== null && resolveSignoff(ctx.project, entry.signoff) === undefined) push(path, 'signoff names no recorded signoff');
  }
}

/**
 * pauses[] is the pause and resume writers' own history, kept apart from advances[] and reopens[], so the
 * move linkage reads exactly what it read before it existed. Only the shape is checked here; the field did not exist before, so no earlier record is refused.
 */
export function checkPauses(ctx: Ctx): void {
  const push = (path: string, why: string): void => {
    ctx.refusals.push({ code: 'PAUSE_MALFORMED', path, message: `${path}: ${why}; preserve the history and record pauses through pause and resume` });
  };
  if (ctx.project.pauses === undefined) return;
  if (!Array.isArray(ctx.project.pauses)) { push('pauses', 'must be a list'); return; }
  let previous = -Infinity;
  for (const [index, entry] of ctx.project.pauses.entries()) {
    const path = `pauses[${index}]`;
    if (!isObject(entry) || ['stage', 'from_stage', 'by', 'at', 'verbatim'].some(k => typeof entry[k] !== 'string')
      || !Number.isFinite(Date.parse(String(entry.at))) || (entry.source !== undefined && typeof entry.source !== 'string')
      || (entry.by as string).trim() === '' || (entry.by as string).toLowerCase() === 'agent') {
      push(path, 'needs stage, from_stage, a human by, a readable at, verbatim and an optional text source'); continue;
    }
    const at = Date.parse(String(entry.at));
    if (at < previous) push(path, 'is dated before the entry before it');
    previous = Math.max(previous, at);
    const from = String(entry.from_stage);
    const signature = resolveSignoff(ctx.project, entry.signoff);
    if (entry.stage === PAUSED_STAGE) {
      if (stageIndex(from) < 0 || from === 'accepted') push(path, `pauses from ${from}, which is not a stage in the order before accepted`);
      else if (!isObject(signature) || signature.stage !== PAUSED_STAGE || signature.checkpoint !== null
        || typeof signature.by !== 'string' || signature.by.toLowerCase() === 'agent' || !(Date.parse(String(signature.at)) <= at)) {
        push(path, 'signoff must be the { stage, checkpoint, at } identity of a human paused sign-off dated at or before it');
      }
    } else if (from !== PAUSED_STAGE || stageIndex(String(entry.stage)) < 0) push(path, 'must enter paused from a stage, or leave paused for a stage in the order');
  }
}

/** Read only the document kind here; checkProject already validates its seal. */
export function composedPost(dir: string, project: JsonObject, at = Infinity): boolean {
  const reopens = collectReopens(project, []).filter(r => !(r.at > at));
  const post = asArray(project.versions).filter(isObject).filter(v => v.kind === 'post' && liveSignoff(reopens, 'post', Date.parse(String(v.at)))).at(-1);
  if (!post || !isObject(post.provenance) || !isObject(post.provenance.direction) || typeof post.provenance.direction.path !== 'string') return false;
  try { return (JSON.parse(readFileSync(join(dir, post.provenance.direction.path), 'utf8')) as JsonObject).schema === DIRECTION_COMPOSE_SPEC; }
  catch { return false; }
}

export function composeChoice(project: JsonObject, dir: string): boolean {
  const item = collectItems(project, { collection: loadCollection(dir) }).find(i => i.id === 'post_composition');
  if (!item || (item.state.state !== 'user' && item.state.state !== 'delegated')) return false;
  const answer = item.state.answer;
  const value = isObject(answer.agent_decision) ? answer.agent_decision.value : answer.value;
  return isObject(value) && value.compose !== undefined;
}

export interface DirectionReviewPostState {
  readonly ready: boolean;
  readonly latestPost: JsonObject | undefined;
  readonly postN: number | null;
  readonly nextPostN: number;
  readonly composed: boolean;
  readonly currentScene: JsonObject | undefined;
  readonly missingScene: boolean;
  readonly missing: string[];
}

/** Shared predicate for the current direction or numbered post that `direction-review` awaits. */
export function directionReviewPostState(dir: string, project: JsonObject, at = Infinity, { historicalMove = false } = {}): DirectionReviewPostState {
  const reopens = collectReopens(project, []).filter(r => !(r.at > at));
  const versions = asArray(project.versions).filter(isObject);
  const postVersions = versions.filter(
    v => v.kind === 'post' && typeof v.n === 'number' && liveSignoff(reopens, 'post', Date.parse(String(v.at))),
  );
  const latestPost = postVersions[postVersions.length - 1];
  const postN = typeof latestPost?.n === 'number' ? latestPost.n : null;
  const maxVersionN = Math.max(0, ...versions.map(v => (typeof v.n === 'number' ? v.n : 0)));
  const nextPostN = postN ?? maxVersionN + 1;
  const direction = isObject(project.current) ? project.current.direction : undefined;
  if (postN === null && isObject(direction) && currentShapeFindings('direction', direction).length === 0) {
    const recordedAt = Date.parse(String(direction.at));
    // Re-recording replaces current.direction; its latest timestamp cannot date the historical move.
    if ((historicalMove || recordedAt <= at) && liveSignoff(reopens, 'post', recordedAt)) {
      return { ready: true, latestPost, postN, nextPostN, composed: true, currentScene: undefined, missingScene: false, missing: [] };
    }
  }
  const composed = postN === null ? composeChoice(project, dir) : composedPost(dir, project, at);
  const contract = isObject(project.direction_contract) ? project.direction_contract : null;
  const explicit = latestPost !== undefined && isObject(latestPost.provenance) && latestPost.provenance.direction !== undefined;
  const grandfathered = latestPost !== undefined && (
    Boolean(contract && asArray(contract.grandfathered_posts).includes(latestPost.n as number))
    || (!explicit && !contract && Date.parse(String(latestPost.at)) < Date.parse(DIRECTION_SCENE_SINCE))
  );
  let currentScene: JsonObject | undefined;
  if (postN !== null) {
    currentScene = asArray(project.scenes).filter(isObject).at(-1);
  } else {
    try {
      currentScene = sceneCurrentAt(dir, project, at);
    } catch (error) {
      if (error instanceof SceneError) {
        try { currentScene = currentSceneEntry(project, at); }
        catch { currentScene = asArray(project.scenes).filter(isObject).at(-1); }
      } else throw error;
    }
  }
  const missingScene = !composed && !grandfathered && currentScene === undefined;
  const missing: string[] = [];
  if (!grandfathered && !isObject(project.direction_contract)) missing.push('direction_contract');
  if (missingScene) missing.push('scenes[n=1]');
  if (postN === null) missing.push(`versions[n=${nextPostN}]`);
  return {
    ready: missing.length === 0,
    latestPost,
    postN,
    nextPostN,
    composed,
    currentScene,
    missingScene,
    missing,
  };
}

/**
 * A `post` → `direction-review` advance needs a live current direction or a numbered post
 * with the direction contract and current scene (or composed `direction@3` post).
 * Missing on the move being written or from `DIRECTION_REVIEW_ADVANCE_SINCE` is refused;
 * on an earlier move it WARNs with the same code.
 */
export function checkDirectionReviewAdvances(ctx: Ctx, forwardWrite = false): void {
  if (stageIndex(ctx.effectiveStage) < stageIndex('direction-review') || postNotPassed(ctx)) return;
  const advances = asArray(ctx.project.advances);
  let moveIndex = -1;
  for (let i = advances.length - 1; i >= 0; i--) {
    const entry = advances[i];
    if (isObject(entry) && entry.from_stage === 'post' && entry.stage === 'direction-review') {
      moveIndex = i;
      break;
    }
  }
  if (moveIndex < 0 && !forwardWrite) return;
  const path = moveIndex >= 0 ? `advances[${moveIndex}]` : 'stage';
  const entry = moveIndex >= 0 ? (advances[moveIndex] as JsonObject) : undefined;
  const atMove = forwardWrite && moveIndex === advances.length - 1;
  const since = Date.parse(DIRECTION_REVIEW_ADVANCE_SINCE);
  const movedAt = entry === undefined ? NaN : Date.parse(String(entry.at));
  const state = directionReviewPostState(ctx.dir, ctx.project, Number.isFinite(movedAt) ? movedAt : Infinity, { historicalMove: !atMove });
  if (state.ready) return;
  const missing = state.missing.join(', ');
  const remedy = 'record the current direction with rig-create record direction, or adopt direction with rig-create direction --adopt, write the current scene with rig-create scene write (or compose direction@3) and record the post version with rig-create direction write before advancing to direction-review';
  if (atMove || !(movedAt < since)) {
    ctx.refusals.push({
      code: 'DIRECTION_REVIEW_POST_MISSING',
      path,
      message: `${path}: post → direction-review needs ${missing}; ${remedy}`,
    });
  } else {
    ctx.warnings.push({
      code: 'DIRECTION_REVIEW_POST_MISSING',
      path,
      message: `${path}: the post → direction-review move predates ${DIRECTION_REVIEW_ADVANCE_SINCE} and lacks ${missing}; preserve the historical move or reopen post and ${remedy}`,
    });
  }
}

export const STEP_STATUSES = ['pending', 'in-progress', 'at-checkpoint', 'done'] as const;
export type StepStatus = typeof STEP_STATUSES[number];

/**
 * Whether `to` may follow `from`: one status forward, or in-progress straight to done for a step
 * that needs no checkpoint (#681). A checkpointed step keeps its at-checkpoint hop.
 */
export function stepStatusFollows(from: Json | undefined, to: Json | undefined, checkpointRequired: Json | undefined): boolean {
  const a = STEP_STATUSES.indexOf(from as StepStatus);
  const b = STEP_STATUSES.indexOf(to as StepStatus);
  if (a < 0 || b < 0) return false;
  // #981: a done step may run again (done → in-progress) without an amendment; dependency decides what is rebuilt.
  return b === a + 1 || (checkpointRequired === false && from === 'in-progress' && to === 'done') || (from === 'done' && to === 'in-progress');
}

/** The status the writers propose next; a step without a checkpoint skips at-checkpoint. */
export function nextStepStatus(from: string, checkpointRequired: boolean): StepStatus | undefined {
  const index = STEP_STATUSES.indexOf(from as StepStatus);
  if (index < 0) return undefined;
  if (!checkpointRequired && from === 'in-progress') return 'done';
  if (from === 'done') return 'in-progress';
  return STEP_STATUSES[index + 1];
}

/** Shared transition validation for the public writer and retained status history. */
export function statusTransitionFinding(entry: JsonObject, path: string): Finding | null {
  if ('note' in entry || 'note_sha256' in entry) {
    if (typeof entry.note !== 'string' || Buffer.byteLength(entry.note, 'utf8') === 0
      || Buffer.byteLength(entry.note, 'utf8') > 1000 || /[\p{Cc}\p{Cs}]/u.test(entry.note.replace(/\n/g, ''))
      || typeof entry.note_sha256 !== 'string' || entry.note_sha256 !== createHash('sha256').update(entry.note, 'utf8').digest('hex')) {
      return { code: 'PROGRESS_OPTION_INVALID', path, message: `${path}: retain both note and its matching note_sha256; record a non-empty UTF-8 note of at most 1,000 bytes with no controls except newline through step-status --note-file` };
    }
  }
  if (!stepStatusFollows(entry.from_status, entry.status, entry.checkpoint_required) || typeof entry.checkpoint_required !== 'boolean' || typeof entry.by !== 'string' || entry.by.trim() === ''
    || !Number.isFinite(Date.parse(String(entry.at))) || (entry.signoff !== null && !isSignoffIdentity(entry.signoff))) {
    return { code: 'STEP_STATUS_TRANSITION', path, message: `${path}: record by, at, boolean checkpoint_required and one forward pending → in-progress → at-checkpoint → done transition (in-progress → done when checkpoint_required is false, done → in-progress to run the step again) with a checkpoint signoff identity or null; use step-status` };
  }
  return null;
}

export function checkStepStatusHistory(ctx: Ctx): void {
  for (const step of ctx.steps) {
    if (step.record.status_history === undefined) continue;
    const path = `${step.path}.status_history`;
    if (!Array.isArray(step.record.status_history)) {
      ctx.refusals.push({ code: 'STEP_STATUS_TRANSITION', path, message: `${path}: must be a list; retain step-status writer history` });
      continue;
    }
    for (const [index, raw] of step.record.status_history.entries()) {
      const entryPath = `${path}[${index}]`;
      const finding = statusTransitionFinding(isObject(raw) ? raw : {}, entryPath);
      if (finding !== null) { ctx.refusals.push(finding); continue; }
      const entry = raw as JsonObject;
      if (entry.signoff === null) continue;
      const signature = resolveSignoff(ctx.project, entry.signoff);
      const allowed = [stageOfStep(step.phase, step.id)];
      const legacyAtEvent = collectSignoffs(ctx.project, []).some(s => s.stage === 'plan-approved' && s.checkpoint === null
        && s.at < Date.parse(PARTS_REVIEW_SINCE) && s.at <= Date.parse(String(entry.at)));
      if (legacyAtEvent) allowed.push(stageOfStep(step.phase, ''));
      if (!isObject(signature) || signature.checkpoint !== step.id || !allowed.includes(String(signature.stage))
        || typeof signature.by !== 'string' || signature.by.toLowerCase() === 'agent'
        || !(Date.parse(String(signature.at)) <= Date.parse(String(entry.at)))) {
        ctx.refusals.push({ code: 'STEP_STATUS_SIGNOFF', path: entryPath, message: `${entryPath}: checkpoint reference does not authorize this step at this time; retain the matching human checkpoint signature` });
      }
    }
  }
}

const eventTime = (value: Json | undefined): number => Date.parse(String(value));

/**
 * Advances and reopens must chain from the initial stage, and each step's status_history must chain from
 * pending through reopen and amendment resets to its current status. A reopen's steps_before must hold the
 * chained status at the reopen. A break is dated by the latest recorded event the unrecorded move must follow,
 * so a later writer entry does not turn an older hand move into a refusal.
 */
export function checkProgressLinkage(ctx: Ctx): void {
  const since = Date.parse(PROGRESS_HISTORY_SINCE);
  const remedies: Record<string, string> = {
    STAGE_MOVE_UNLINKED: 'preserve the history and record the move through advance or reopen',
    STEP_STATUS_UNLINKED: 'preserve the history and record the move through step-status',
    REOPEN_STEP_UNLINKED: 'restore the historical reopen snapshot and its recorded step-status chain',
  };
  const push = (code: string, path: string, why: string, after: number): void => {
    (after >= since ? ctx.refusals : ctx.warnings).push({ code, path, message: `${path}: ${why}; ${remedies[code]!}` });
  };
  const signatures = collectSignoffs(ctx.project, []).filter(s => s.checkpoint === null && Number.isFinite(s.at) && stageIndex(s.stage) >= 0);
  type Move = { record: JsonObject; path: string; advance: boolean; index: number };
  const moves = [
    ...asArray(ctx.project.advances).map((record, index) => ({ record, path: `advances[${index}]`, advance: true, index })),
    ...asArray(ctx.project.reopens).map((record, index) => ({ record, path: `reopens[${index}]`, advance: false, index })),
  ].filter((move): move is Move => isObject(move.record) && typeof move.record.stage === 'string'
    && typeof move.record.from_stage === 'string' && Number.isFinite(eventTime(move.record.at)));

  let latestAdvance = -Infinity;
  for (const move of moves.filter(m => m.advance)) {
    const at = eventTime(move.record.at);
    if (at < latestAdvance) push('STAGE_MOVE_UNLINKED', move.path, 'is dated before an earlier advances[] entry', latestAdvance);
    latestAdvance = Math.max(latestAdvance, at);
  }
  // Time order; on a tie, prefer the move that links, then advances before reopens as checkStageProgress does.
  const queue = [...moves].sort((a, b) => eventTime(a.record.at) - eventTime(b.record.at) || Number(b.advance) - Number(a.advance) || a.index - b.index);
  let stage = 'interview';
  let previous = -Infinity;
  const links = (move: Move): boolean => move.record.from_stage === stage || move.record.from_stage === PAUSED_STAGE;
  while (queue.length > 0) {
    const at = eventTime(queue[0]!.record.at);
    const tied = queue.filter(m => eventTime(m.record.at) === at);
    const move = tied.find(links) ?? tied[0]!;
    queue.splice(queue.indexOf(move), 1);
    if (!links(move)) {
      const from = stageIndex(String(move.record.from_stage));
      const before = signatures.filter(s => stageIndex(s.stage) < from && s.at <= at);
      const furthest = Math.max(...before.map(s => stageIndex(s.stage)));
      const arrival = Math.max(-Infinity, ...before.filter(s => stageIndex(s.stage) === furthest).map(s => s.at));
      push('STAGE_MOVE_UNLINKED', move.path, `from_stage ${String(move.record.from_stage)} does not follow ${stage}, the stage its previous recorded move left`, Math.max(previous, arrival));
    }
    stage = String(move.record.stage);
    previous = at;
  }

  const legacy = collectSignoffs(ctx.project, []).some(s => s.stage === 'plan-approved' && s.checkpoint === null && s.at < Date.parse(PARTS_REVIEW_SINCE));
  const amendments = collectAmendments(ctx.project, []);
  for (const step of ctx.steps) {
    const history = step.record.status_history;
    if (!Array.isArray(history) || history.length === 0
      || history.some(raw => statusTransitionFinding(isObject(raw) ? raw : {}, '') !== null)) continue;
    const executes = [stageOfStep(step.phase, step.id), ...(legacy ? [stageOfStep(step.phase, '')] : [])];
    const reopenResets = asArray(ctx.project.reopens).map((r, index) => ({ r, index })).filter(({ r }) => isObject(r)
      && (Array.isArray(r.steps_before) ? r.steps_before.some(s => isObject(s) && s.id === step.id)
        : stageIndex(stageOfStep(step.phase, step.id)) >= stageIndex(String(r.stage))))
      .map(({ r, index }) => ({ index, at: eventTime((r as JsonObject).at) }));
    const amendResets = amendments.filter(a => amendmentResetsStep(a.target, step.phase, step.id, step.record.rests_on)).map(a => a.at);
    // Before #760 an interview-answer amendment reset every step in its stage suffix; that reset stays allowed, never required.
    const allowedResets = amendments.filter(a => a.target.kind === 'interview-answer' && !amendmentResetsStep(a.target, step.phase, step.id, step.record.rests_on)
      && stageIndex(stageOfStep(step.phase, step.id)) >= stageIndex(a.stage)).map(a => a.at);
    const resetsExcept = (reopen: number): number[] =>
      [...reopenResets.filter(r => r.index !== reopen).map(r => r.at), ...amendResets].filter(Number.isFinite);
    const resets = resetsExcept(-1);
    const arrivals = moves.filter(m => m.advance && executes.includes(String(m.record.stage))).map(m => eventTime(m.record.at));
    const after = (until: number, previous: number, events = resets): number => Math.max(previous, ...[...events, ...arrivals].filter(t => t <= until));
    // A reset strictly between two entries forces pending; one tied with an entry may fall on either side.
    const reset = (possible: Set<string>, from: number, to: number, events = resets): Set<string> => {
      const between = events.filter(r => r >= from && r <= to);
      if (between.some(r => r > from && r < to)) return new Set(['pending']);
      return between.length > 0 || allowedResets.some(r => r >= from && r <= to) ? new Set([...possible, 'pending']) : possible;
    };
    let possible = new Set(['pending']);
    let previous = -Infinity;
    for (const [index, raw] of history.entries()) {
      const entry = raw as JsonObject;
      const path = `${step.path}.status_history[${index}]`;
      const at = eventTime(entry.at);
      if (at < previous) push('STEP_STATUS_UNLINKED', path, `is dated before status_history[${index - 1}]`, previous);
      else {
        possible = reset(possible, previous, at);
        if (!possible.has(String(entry.from_status))) push('STEP_STATUS_UNLINKED', path, `from_status ${String(entry.from_status)} does not follow ${[...possible].join(' or ')}, the status before it`, after(at, previous));
      }
      possible = new Set([String(entry.status)]);
      previous = Math.max(previous, at);
    }
    possible = reset(possible, previous, Infinity);
    const current = step.record.status === undefined ? 'pending' : step.record.status;
    if (typeof current === 'string' && STEP_STATUSES.includes(current as typeof STEP_STATUSES[number]) && !possible.has(current)) {
      push('STEP_STATUS_UNLINKED', `${step.path}.status`, `${current} is not the status its last status_history entry recorded (${[...possible].join(' or ')})`, after(Infinity, previous));
    }
    // A reordered history has no single status at a given time; its break is already reported above.
    if (history.some((raw, index) => index > 0 && eventTime((raw as JsonObject).at) < eventTime((history[index - 1] as JsonObject).at))) continue;
    for (const { index: reopen, at } of reopenResets) {
      const steps = (asArray(ctx.project.reopens)[reopen] as JsonObject).steps_before;
      if (!Number.isFinite(at) || !Array.isArray(steps)) continue;
      // The reopen writer copies the current, possibly hand-set status, so the reopen itself is not a dating event.
      const events = resetsExcept(reopen);
      for (const [index, raw] of steps.entries()) {
        if (!isObject(raw) || raw.id !== step.id) continue;
        const claimed = raw.status === undefined ? 'pending' : raw.status;
        if (typeof claimed !== 'string' || !STEP_STATUSES.includes(claimed as typeof STEP_STATUSES[number])) continue;
        // A step with no history before the reopen had no recorded chain then, as #186 leaves a step with no history unjudged.
        // Judging it once a later redo adds history would block that redo with no writer remedy.
        const earlier = (history as JsonObject[]).filter(entry => eventTime(entry.at) < at).at(-1);
        if (earlier === undefined) continue;
        // The chain at the reopen is the last earlier entry's status, then any reset after it.
        const last = eventTime(earlier.at);
        const chained = reset(new Set([String(earlier.status)]), last, at, events);
        // An entry tied in time with the reopen may fall on either side of it.
        const tied = (history as JsonObject[]).filter(entry => eventTime(entry.at) === at);
        for (const entry of tied) chained.add(String(entry.status));
        if (!chained.has(claimed)) {
          push('REOPEN_STEP_UNLINKED', `reopens[${reopen}].steps_before[${index}]`,
            `${step.id} status ${claimed} is not the status its history held at the reopen (${[...chained].join(' or ')})`,
            after(at, last, events));
        }
      }
    }
  }
}
