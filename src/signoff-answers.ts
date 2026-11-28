/** Approval bindings for local and inherited answer revisions. */
import { createHash } from 'node:crypto';
import { answered, asArray, classify, collectItems, isObject, itemFor, loadCollection, postNotPassed, type Ctx, type Finding, type Item } from './check.ts';
import { retainedPlanStepAt } from './plan-history.ts';
import { refuse } from './refusal.ts';
import { approvalStageOfStep, currentStepPlan, hasStageOrder, planStepOfGuide, STEP_PLAN_SOURCE } from './stages.ts';
import { sorted } from './step-hash.ts';
import type { Json, JsonObject } from './templates.ts';

export const SIGNOFF_ANSWERS_SINCE = '2026-11-06T00:00:00Z';
const stages = ['interview', 'plan-approved', 'rigging-interview', 'post-interview'];
const excluded = new Set(['history', 'prompts', 'config', 'text', 'source', 'required_for']);

export function staleSignoffAnswer(finding: Finding): { index: number; id: string } | undefined {
  if (finding.code !== 'SIGNOFF_ANSWERS_STALE') return undefined;
  const match = /^signoffs\[(\d+)\]\.answer_hashes\[(.+)\]$/.exec(finding.path);
  return match ? { index: Number(match[1]), id: match[2]! } : undefined;
}

/** The finding a guide change can introduce on the signoffs that hashed its answer. */
export function guideSignoffMatcher(ids: ReadonlySet<string>): (finding: Finding) => boolean {
  return finding => ids.has(staleSignoffAnswer(finding)?.id ?? '');
}

function retained(value: Json, interview: boolean): Json {
  if (!isObject(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key) && !(interview && key === 'agent_decision')));
}

/** Interview approves the delegation; plan approvals also approve its decision. */
export function answerRevisionHash(item: Item, stage = 'plan-approved'): string {
  const resolved = answered(item.state) && 'answer' in item.state ? item.state.answer : null;
  const envelope = { raw: retained(item.raw, stage === 'interview'), resolved: retained(resolved, stage === 'interview') };
  return createHash('sha256').update(JSON.stringify(sorted(envelope))).digest('hex');
}

/**
 * The revision a signature binds: the answer, or for a silent question its current step plan covers,
 * that plan entry (step and sha256; docs/INTERVIEW.md § Step plans). Undefined when neither exists.
 */
export function boundRevisionHash(project: JsonObject, item: Item, stage = 'plan-approved', at?: number): string | undefined {
  const plan = () => currentStepPlan(project, planStepOfGuide(item.id, item.kind === 'post'), at);
  const planBinding = (current: JsonObject) => ({ step_plan: { step: current.step ?? null, sha256: current.sha256 ?? null } });
  if (answered(item.state)) {
    const answer = answerRevisionHash(item, stage);
    // A value delegated under a step plan is also a revision of the plan that covers it now.
    const current = isObject(item.raw) && item.raw.source === STEP_PLAN_SOURCE ? plan() : undefined;
    if (current === undefined) return answer;
    return createHash('sha256').update(JSON.stringify(sorted({ answer, ...planBinding(current) }))).digest('hex');
  }
  if (item.state.state !== 'silent') return undefined;
  const current = plan();
  if (current === undefined) return undefined;
  return createHash('sha256').update(JSON.stringify(sorted(planBinding(current)))).digest('hex');
}

/** Reconstruct the same binding using answer and proposal records present at signing. */
function historicalRevisionHash(ctx: Ctx, item: Item, stage: string, at: number): string | undefined {
  if (!isObject(item.raw) || !(Date.parse(String(item.raw.at)) > at)) {
    return boundRevisionHash(ctx.project, item, stage, at);
  }
  const raw = asArray(item.record.history).filter(isObject)
    .findLast(answer => Date.parse(String(answer.at)) <= at);
  if (raw !== undefined) return boundRevisionHash(ctx.project, { ...item, raw, state: classify(raw, ctx) }, stage, at);
  const silent = boundRevisionHash(ctx.project, { ...item, raw: null, state: { state: 'silent' } }, stage, at);
  return silent ?? boundRevisionHash(ctx.project, item, stage, at);
}

/** Plan completeness follows the signature's own covered steps. */
function requiredIds(project: JsonObject, signoff: JsonObject, items: Item[], replaced?: readonly JsonObject[]): string[] {
  if (signoff.stage === 'interview') return [];
  const phase = signoff.stage === 'post-interview' ? 'post' : 'rig';
  const current = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  const at = Date.parse(String(signoff.at));
  const definitions = replaced === undefined ? current : [...new Set([...current.map(step => step.id),
    ...replaced.map(entry => (entry.step as JsonObject).id)])].flatMap(id => {
    const historical = retainedPlanStepAt(replaced, id, at);
    if (historical) return [historical];
    return current.filter(step => step.id === id && (Array.isArray(signoff.steps) || !(Date.parse(String(step.drafted_at)) > at)));
  });
  const phaseSteps = definitions.filter(step => step.phase === phase);
  if (phase === 'post' && phaseSteps.length === 0 && postNotPassed({ items })) return items.filter(item => item.kind === 'post').map(item => item.id);
  const steps = phaseSteps.filter(step => (Array.isArray(signoff.steps) ? signoff.steps.includes(step.id as Json)
      : approvalStageOfStep(phase, String(step.id), hasStageOrder(project) || signoff.stage === 'rigging-interview') === signoff.stage));
  return [...new Set(steps.flatMap(step => asArray(step.rests_on).filter((id): id is string => typeof id === 'string')))];
}

export function selectAnswerHashes(dir: string, project: JsonObject, signoff: JsonObject, extraIds: readonly string[] = []): JsonObject | undefined {
  if (!stages.includes(String(signoff.stage))) return undefined;
  const items = collectItems(project, { collection: loadCollection(dir) });
  // The writer captures every answer present now, independent of its recorded date.
  const ids = signoff.stage === 'interview' ? items.filter(item => boundRevisionHash(project, item, 'interview') !== undefined).map(item => item.id) : requiredIds(project, signoff, items);
  const hashes = Object.create(null) as JsonObject;
  for (const id of new Set([...ids, ...extraIds])) {
    const item = items.find(item => item.id === id);
    const hash = item && boundRevisionHash(project, item, String(signoff.stage));
    if (hash === undefined) refuse('SIGNOFF_ANSWERS_UNANSWERED', `signoffs[${asArray(project.signoffs).length}].answer_hashes[${id}]: answer is missing or unresolved, and no step plan covers it; answer ${id} or propose its step plan before signing ${String(signoff.stage)}`);
    hashes[id] = hash;
  }
  return hashes;
}

/** Called only for live signatures, sharing the writer's coverage resolver. */
export function checkSignoffAnswers(ctx: Ctx, signoff: JsonObject, path: string, currentPath = false, replaced: readonly JsonObject[] = []): void {
  if (!stages.includes(String(signoff.stage))) return;
  const ids = requiredIds(ctx.project, signoff, ctx.items, currentPath ? replaced : undefined);
  const hashes = isObject(signoff.answer_hashes) ? signoff.answer_hashes : null;
  const missing = hashes === null || ids.some(id => !Object.hasOwn(hashes, id));
  if (missing) {
    const legacy = Date.parse(String(signoff.at)) < Date.parse(SIGNOFF_ANSWERS_SINCE);
    const code = `SIGNOFF_ANSWERS_MISSING${legacy ? '_LEGACY' : ''}`;
    const finding: Finding = { code, path: `${path}.answer_hashes`, message: `${path}.answer_hashes: missing answer revisions${hashes === null ? '' : ` for ${ids.filter(id => !Object.hasOwn(hashes, id)).join(', ')}`}; sign ${String(signoff.stage)} again to bind its answers` };
    (legacy ? ctx.warnings : ctx.refusals).push(finding);
  }
  const current = (ctx.signoffs ?? []).find(s => s.record === signoff);
  const at = Date.parse(String(signoff.at));
  const newer = (ctx.signoffs ?? []).filter(s => s.stage === signoff.stage
    && (s.at > at || (s.at === at && s.index > (current?.index ?? -1))));
  for (const [id, hash] of Object.entries(hashes ?? {})) {
    const superseded = newer.some(s => signoff.stage === 'interview'
      || (isObject(s.record.answer_hashes) && Object.hasOwn(s.record.answer_hashes, id)));
    if (superseded) continue;
    const item = itemFor(ctx, id);
    const stage = String(signoff.stage);
    const expected = item && (currentPath && Number.isFinite(at)
      ? historicalRevisionHash(ctx, item, stage, at) : boundRevisionHash(ctx.project, item, stage));
    if (hash === expected) continue;
    const field = `${path}.answer_hashes[${id}]`;
    const remedy = currentPath ? 'restore the signed answer or plan revision and its original hash'
      : `sign ${stage} again after restoring the intended answer`;
    ctx.refusals.push({ code: 'SIGNOFF_ANSWERS_STALE', path: field, message: `${field}: ${id} is missing, unresolved or changed since signing; ${remedy}` });
  }
}
