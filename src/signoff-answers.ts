/** Approval bindings for local and inherited answer revisions. */
import { createHash } from 'node:crypto';
import { answered, asArray, collectItems, isObject, loadCollection, type Ctx, type Finding, type Item } from './check.ts';
import { refuse } from './refusal.ts';
import { approvalStageOfStep, hasStageOrder } from './stages.ts';
import { sorted } from './step-hash.ts';
import type { Json, JsonObject } from './templates.ts';

export const SIGNOFF_ANSWERS_SINCE = '2026-11-06T00:00:00Z';
const stages = ['interview', 'plan-approved', 'rigging-interview', 'post-interview'];
const excluded = new Set(['history', 'prompts', 'config', 'text', 'source', 'required_for']);

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

/** Current answered items already present at signing, or the covered steps' bases. */
function requiredIds(project: JsonObject, signoff: JsonObject, items: Item[]): string[] {
  if (signoff.stage === 'interview') {
    return items.filter(item => answered(item.state) && (!isObject(item.raw) || !Number.isFinite(Date.parse(String(item.raw.at)))
      || Date.parse(String(item.raw.at)) <= Date.parse(String(signoff.at)))).map(item => item.id);
  }
  const phase = signoff.stage === 'post-interview' ? 'post' : 'rig';
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject)
    .filter(step => step.phase === phase && (Array.isArray(signoff.steps) ? signoff.steps.includes(step.id as Json)
      : approvalStageOfStep(phase, String(step.id), hasStageOrder(project) || signoff.stage === 'rigging-interview') === signoff.stage));
  return [...new Set(steps.flatMap(step => asArray(step.rests_on).filter((id): id is string => typeof id === 'string')))];
}

export function selectAnswerHashes(dir: string, project: JsonObject, signoff: JsonObject): JsonObject | undefined {
  if (!stages.includes(String(signoff.stage))) return undefined;
  const items = collectItems(project, { collection: loadCollection(dir) });
  // The writer captures every answer present now, independent of its recorded date.
  const ids = signoff.stage === 'interview' ? items.filter(item => answered(item.state)).map(item => item.id) : requiredIds(project, signoff, items);
  const hashes = Object.create(null) as JsonObject;
  for (const id of ids) {
    const item = items.find(item => item.id === id);
    if (!item || !answered(item.state)) refuse('SIGNOFF_ANSWERS_UNANSWERED', `signoffs[${asArray(project.signoffs).length}].answer_hashes[${id}]: answer is missing or unresolved; answer ${id} before signing ${String(signoff.stage)}`);
    hashes[id] = answerRevisionHash(item, String(signoff.stage));
  }
  return hashes;
}

/** Called only for live signatures, sharing the writer's coverage resolver. */
export function checkSignoffAnswers(ctx: Ctx, signoff: JsonObject, path: string): void {
  if (!stages.includes(String(signoff.stage))) return;
  const ids = requiredIds(ctx.project, signoff, ctx.items);
  const hashes = isObject(signoff.answer_hashes) ? signoff.answer_hashes : null;
  const missing = hashes === null || ids.some(id => !Object.hasOwn(hashes, id));
  if (missing) {
    const legacy = Date.parse(String(signoff.at)) < Date.parse(SIGNOFF_ANSWERS_SINCE);
    const code = `SIGNOFF_ANSWERS_MISSING${legacy ? '_LEGACY' : ''}`;
    const finding: Finding = { code, path: `${path}.answer_hashes`, message: `${path}.answer_hashes: missing answer revisions${hashes === null ? '' : ` for ${ids.filter(id => !Object.hasOwn(hashes, id)).join(', ')}`}; reopen and sign ${String(signoff.stage)} again to bind its answers` };
    (legacy ? ctx.warnings : ctx.refusals).push(finding);
  }
  for (const [id, hash] of Object.entries(hashes ?? {})) {
    const item = ctx.items.find(item => item.id === id);
    if (!item || !answered(item.state) || hash !== answerRevisionHash(item, String(signoff.stage))) {
      const at = `${path}.answer_hashes[${id}]`;
      ctx.refusals.push({ code: 'SIGNOFF_ANSWERS_STALE', path: at, message: `${at}: ${id} is missing, unresolved or changed since signing; reopen and sign ${String(signoff.stage)} again after restoring the intended answer` });
    }
  }
}
