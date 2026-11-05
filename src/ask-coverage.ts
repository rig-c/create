import { asArray, isDecision, isObject, type Ctx } from './check.ts';
import { assembleAnswer, checkAssembleAnswers, PROJECTION_ASKS_SINCE } from './assemble-answers.ts';
import { approvalStageOfStep, hasStageOrder } from './stages.ts';
import { WAYPOINT_ASKS } from './waypoints.ts';

/** Independent of other contract dates; read the resolved guide's own at. */
export const ASK_COVERAGE_SINCE = '2026-11-05T00:00:00Z';

export function checkAskCoverage(ctx: Ctx): void {
  const assemble = checkAssembleAnswers(ctx);
  const rigType = ctx.items.find((item) => item.id === 'rig_type')?.state;
  const rigValue = rigType?.state === 'user' ? rigType.answer.value
    : rigType?.state === 'delegated' && isObject(rigType.answer.agent_decision) ? rigType.answer.agent_decision.value : null;
  for (const item of ctx.items) {
    if (item.kind !== 'waypoint' || (item.state.state !== 'user' && item.state.state !== 'delegated')) continue;
    const answer = item.state.answer;
    const asks = WAYPOINT_ASKS[item.id]?.filter((ask) => (ask.id !== 'ground' || item.id !== 'assemble' || assemble.visible)
      && (ask.required_for === undefined || (ask.required_for === 'fullscreen.game_logic' ? rigValue === 'fullscreen.game_logic' : rigValue !== 'fullscreen.game_logic')));
    if (asks === undefined) continue;
    const path = `${item.path}.asks`;
    if (!('asks' in answer)) {
      const at = typeof answer.at === 'string' ? Date.parse(answer.at) : Number.NaN;
      const legacy = !Number.isFinite(at) || at < Date.parse(ASK_COVERAGE_SINCE);
      if (legacy) {
        ctx.warnings.push({ code: 'GUIDE_ASKS_LEGACY', path, message: `${path}: no per-ask record; guide predates ${ASK_COVERAGE_SINCE} or has no readable at; preserve the legacy answer` });
        continue;
      }
    }
    const entries = asArray(answer.asks);
    const ids = new Set(asks.map((ask) => ask.id));
    const seen = new Set<string>();
    let malformed = !Array.isArray(answer.asks) && 'asks' in answer;
    for (const entry of entries) {
      if (!isObject(entry) || typeof entry.id !== 'string' || !ids.has(entry.id) || seen.has(entry.id)
        || (entry.state !== 'user' && entry.state !== 'delegated')
        || (entry.state === 'user' && item.state.state !== 'user')) {
        malformed = true;
        continue;
      }
      seen.add(entry.id);
    }
    if (malformed) ctx.refusals.push({ code: 'GUIDE_ASKS_MALFORMED', path, message: `${path}: use one { id, state: 'user' | 'delegated' } per applicable ask, with known, unique ids; a full delegation cannot claim user answers` });
    for (const ask of asks) {
      const projectionAsk = item.id === 'assemble' && (ask.id === 'projection' || ask.id === 'ground');
      if (projectionAsk && assemble.legacy && !seen.has(ask.id)) {
        ctx.warnings.push({ code: 'GUIDE_ASKS_LEGACY', path: `${path}[${ask.id}]`, message: `${item.id}: '${ask.id}' predates ${PROJECTION_ASKS_SINCE}; preserve the old guide and ask when it is next revised` });
        continue;
      }
      const value = projectionAsk ? assembleAnswer(answer, ask.id === 'projection' ? 'project' : 'ground') : undefined;
      const valid = !projectionAsk || (ask.id === 'projection' ? value === 'core' || value === 'visible' : value === 'plain' || value === 'busy');
      if (!seen.has(ask.id) || !valid) ctx.refusals.push({ code: 'GUIDE_ASK_UNANSWERED', path: `${path}[${ask.id}]`, message: `${item.id}: unanswered ask '${ask.id}': ${ask.text} Record its user answer or explicit delegation.` });
    }
    const partialDelegation = item.state.state === 'user' && entries.some((entry) => isObject(entry) && entry.state === 'delegated');
    if (partialDelegation) {
      const decision = answer.agent_decision;
      if (!isObject(decision) || typeof decision.covers !== 'string' || decision.covers.trim() === '') {
        if (!ctx.refusals.some((finding) => finding.code === 'GUIDE_PARTIAL_UNMARKED' && finding.path === item.path)) {
          ctx.refusals.push({ code: 'GUIDE_PARTIAL_UNMARKED', path: item.path, message: `${item.path}: delegated asks need agent_decision.covers naming the remainder` });
        }
      }
      const approved = ctx.signoffs.some((signoff) => signoff.stage === approvalStageOfStep('rig', item.id, hasStageOrder(ctx.project)) && signoff.checkpoint === null);
      if (approved && !isDecision(decision)
        && !ctx.refusals.some((finding) => finding.code === 'DELEGATION_UNDECIDED' && finding.path === item.path)) {
        ctx.refusals.push({ code: 'DELEGATION_UNDECIDED', path: item.path, message: `${item.path}: delegated asks need agent_decision.value and reasoning before plan approval` });
      }
    }
  }
}
