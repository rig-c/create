import { asArray, asString, collectSignoffs, isObject, postNotPassed, type Ctx, type Finding } from './check.ts';
import { LEGACY_STAGES, PARTS_REVIEW_SINCE, PAUSED_STAGE, SKIPPED_WHEN_NO_POST, STAGES, hasStageOrder, stageIndex, stageOfStep } from './stages.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import type { Json, JsonObject } from './templates.ts';

/** Dates the authorizing stage-level signature, including a signature earlier on landing day. */
export const STAGE_PROGRESS_SINCE = '2026-11-08T00:00:00Z';

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

/** Re-signing an earlier plan does not revoke later live approvals. Reopen/amend owns revocation. */
export function stageWindow(ctx: Ctx): { minimum: string; maximum: string; signoff: string | null; at: number } {
  const order = (hasStageOrder(ctx.project) ? STAGES : LEGACY_STAGES).filter(s =>
    !(ctx.predatesPartsReview !== null && ['parts', 'parts-review'].includes(s.id))
    && !(postNotPassed(ctx) && SKIPPED_WHEN_NO_POST.includes(s.id)));
  const latest = furthestStageSignoff(ctx.signoffs.filter(s => order.some(stage => stage.id === s.stage)));
  const start = latest === undefined ? 0 : Math.min(order.findIndex(s => s.id === latest.stage) + 1, order.length - 1);
  let end = start;
  while (order[end]?.closed_by === 'bar') {
    const spec = order[end]!;
    const steps = ctx.steps.filter(s => ctx.predatesPartsReview !== null
      ? s.phase === spec.phase : stageOfStep(s.phase, s.id) === spec.id);
    if (steps.length === 0 || steps.some(s => s.record.status !== 'done')) break;
    end++;
  }
  return { minimum: order[start]!.id, maximum: order[Math.min(end, order.length - 1)]!.id,
    signoff: latest === undefined ? null : `signoffs[${latest.index}]`, at: latest?.at ?? NaN };
}

export function checkStageProgress(ctx: Ctx, forwardWrite = false): void {
  if (ctx.stage === PAUSED_STAGE || ctx.effectiveStage !== ctx.stage) return;
  const window = stageWindow(ctx);
  const current = stageIndex(ctx.stage);
  const frontier = furthestStageSignoff(ctx.signoffs);
  const unreadable = ctx.signoffs.find(s => s.stage === frontier?.stage && s.checkpoint === null && !Number.isFinite(s.at));
  if (unreadable !== undefined) {
    ctx.refusals.push({ code: 'STAGE_SIGNOFF_DATE_INVALID', path: `signoffs[${unreadable.index}].at`, message: `signoffs[${unreadable.index}].at: frontier approval needs a readable date; restore its original date before advancing` });
    return;
  }
  const since = Date.parse(STAGE_PROGRESS_SINCE);
  const moves = [
    ...asArray(ctx.project.advances).filter(isObject).map((record, index) => ({ record, advance: true, index })),
    ...asArray(ctx.project.reopens).filter(isObject).map((record, index) => ({ record, advance: false, index })),
  ].filter(move => move.record.from_stage !== move.record.stage && Number.isFinite(Date.parse(String(move.record.at))))
    .sort((a, b) => Date.parse(String(b.record.at)) - Date.parse(String(a.record.at)) || Number(a.advance) - Number(b.advance) || b.index - a.index);
  const latestMove = moves[0];
  if (latestMove === undefined ? ctx.stage !== 'interview' : latestMove.record.stage !== ctx.stage) {
    // The unrecorded move is no older than the latest recorded move and the stage's arrival authority:
    // the latest live stage-level signature at the furthest stage before the current one.
    const earlier = ctx.signoffs.filter(s => s.checkpoint === null && stageIndex(s.stage) >= 0 && stageIndex(s.stage) < current);
    const arrivalStage = Math.max(...earlier.map(s => stageIndex(s.stage)));
    const arrival = earlier.filter(s => stageIndex(s.stage) === arrivalStage);
    const dates = [
      ...(latestMove === undefined ? [] : [Date.parse(String(latestMove.record.at))]),
      ...(arrival.length === 0 ? [] : [arrival.every(s => Number.isFinite(s.at)) ? Math.max(...arrival.map(s => s.at)) : NaN]),
    ];
    const movedAt = dates.length === 0 ? NaN : Math.max(...dates);
    const finding = { code: 'STAGE_SKIPPED', path: 'stage', message: `stage: ${ctx.stage} differs from its latest recorded move (${latestMove === undefined ? 'none' : String(latestMove.record.stage)}); use advance for the next authorized stage or reopen the unfinished stage` };
    (forwardWrite || !(movedAt < since) ? ctx.refusals : ctx.warnings).push(finding);
  }
  const code = current < stageIndex(window.minimum) ? 'STAGE_LAGGING'
    : current > stageIndex(window.maximum) ? 'STAGE_SKIPPED' : null;
  if (code === null) return;
  const finding = { code, path: 'stage', message: `stage: ${ctx.stage} is outside ${window.minimum} through ${window.maximum} authorized by ${window.signoff ?? 'the unsigned interview'}; use advance for the next authorized stage or reopen the unfinished stage` };
  (forwardWrite || window.at >= since || !Number.isFinite(window.at) ? ctx.refusals : ctx.warnings).push(finding);
}

/** Advances are history, separate from reopen cutoffs. Their reference must witness the recorded move. */
export function checkAdvances(ctx: Ctx): void {
  const push = (path: string, why: string): void => {
    ctx.refusals.push({ code: 'ADVANCE_MALFORMED', path, message: `${path}: ${why}; preserve the original forward move and its authorizing signoff` });
  };
  if (ctx.project.advances !== undefined && !Array.isArray(ctx.project.advances)) push('advances', 'must be a list');
  for (const [index, entry] of asArray(ctx.project.advances).entries()) {
    const path = `advances[${index}]`;
    if (!isObject(entry) || ['stage', 'from_stage', 'by', 'at', 'verbatim'].some(k => asString(entry[k]) === null)
      || !Number.isFinite(Date.parse(String(entry.at))) || (entry.source !== undefined && typeof entry.source !== 'string')
      || typeof entry.post_not_passed !== 'boolean'
      || !isSignoffIdentity(entry.signoff) || !Array.isArray(entry.signoffs_before)
      || !entry.signoffs_before.every(isSignoffIdentity)
      || !Array.isArray(entry.steps_before)) { push(path, 'needs reopen-shaped fields and stable signoff identities'); continue; }
    const order = entry.order === 'pre-parts' ? LEGACY_STAGES.filter(s => !['parts', 'parts-review'].includes(s.id))
      : entry.order === 'legacy' ? LEGACY_STAGES : STAGES;
    const from = order.findIndex(s => s.id === entry.from_stage);
    const target = order.findIndex(s => s.id === entry.stage);
    const noPost = entry.from_stage === 'post-interview' && entry.stage === 'accepted' && entry.post_not_passed === true;
    const at = Date.parse(String(entry.at));
    const cutoffs = collectReopens(ctx.project, []).filter(r => r.at <= at);
    const authority = furthestStageSignoff(collectSignoffs(ctx.project, []).filter(s => asArray(entry.signoffs_before).some(identity => matchesSignoff(identity, s.record)) && s.at <= at && liveSignoff(cutoffs, s.stage, s.at)));
    const firstPlan = collectSignoffs(ctx.project, []).filter(s => s.stage === 'plan-approved' && s.checkpoint === null).map(s => s.at);
    const historicalOrder = entry.order !== 'pre-parts' || Math.min(...firstPlan) < Date.parse(PARTS_REVIEW_SINCE);
    const signature = resolveSignoff(ctx.project, entry.signoff);
    const owner = order.slice(0, from + 1).filter(s => s.closed_by === 'signoff').at(-1)?.id;
    if (entry.steps_before.some(s => !isObject(s) || typeof s.id !== 'string' || !['rig', 'post'].includes(String(s.phase)) || (s.status !== undefined && !STEP_STATUSES.includes(s.status as typeof STEP_STATUSES[number])))) push(path, 'steps_before must retain step ids, phases and original statuses');
    if ((entry.by as string).trim() === '' || (entry.by as string).toLowerCase() === 'agent' || from < 0 || target <= from
      || !['legacy', 'split', 'pre-parts'].includes(String(entry.order)) || !historicalOrder
      || (target !== from + 1 && !noPost) || !isObject(signature) || signature.checkpoint !== null
      || typeof signature.by !== 'string' || signature.by.toLowerCase() === 'agent'
      || !(Date.parse(String(signature.at)) <= Date.parse(String(entry.at)))
      || signature.stage !== owner || authority === undefined || !matchesSignoff(entry.signoff, authority.record)) push(path, 'invalid human move or authorizing signature');
  }
}

/** Snapshot bars remain historical facts even when the current plan is reopened or replaced. */
export function checkAdvanceBars(ctx: Ctx): void {
  for (const [index, entry] of asArray(ctx.project.advances).entries()) {
    if (!isObject(entry) || !Array.isArray(entry.steps_before)) continue;
    const order = entry.order === 'split' ? STAGES : LEGACY_STAGES;
    const bar = order.find(s => s.id === entry.from_stage);
    if (bar?.closed_by !== 'bar') continue;
    const unfinished = entry.steps_before.some(raw => isObject(raw)
      && (entry.order === 'pre-parts' ? raw.phase === bar.phase
        : (raw.phase === 'rig' || raw.phase === 'post') && stageOfStep(raw.phase, String(raw.id)) === bar.id)
      && raw.status !== 'done');
    if (unfinished) ctx.refusals.push({ code: 'ADVANCE_MALFORMED', path: `advances[${index}].steps_before`,
      message: `advances[${index}].steps_before: the execution stage had unfinished steps at the move; restore its original completed bar and use advance` });
  }
}

export const STEP_STATUSES = ['pending', 'in-progress', 'at-checkpoint', 'done'] as const;

/** Shared transition validation for the public writer and retained status history. */
export function statusTransitionFinding(entry: JsonObject, path: string): Finding | null {
  const from = STEP_STATUSES.indexOf(entry.from_status as typeof STEP_STATUSES[number]);
  const next = STEP_STATUSES.indexOf(entry.status as typeof STEP_STATUSES[number]);
  if (from < 0 || next !== from + 1 || typeof entry.checkpoint_required !== 'boolean' || typeof entry.by !== 'string' || entry.by.trim() === ''
    || !Number.isFinite(Date.parse(String(entry.at))) || (entry.signoff !== null && !isSignoffIdentity(entry.signoff))) {
    return { code: 'STEP_STATUS_TRANSITION', path, message: `${path}: record by, at, boolean checkpoint_required and one forward pending → in-progress → at-checkpoint → done transition with a checkpoint signoff identity or null; use step-status` };
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
      if (entry.status === 'done' && entry.checkpoint_required === true && entry.signoff === null) {
        ctx.refusals.push({ code: 'STEP_STATUS_SIGNOFF', path: entryPath, message: `${entryPath}: checkpointed done needs its authorizing signoff identity; record the human checkpoint with step-status` });
      }
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
