import { asArray, classify, collectSignoffs, isObject, type Finding } from './check.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { approvalStageOfStep, hasStageOrder } from './stages.ts';
import { stepHash } from './step-hash.ts';
import type { JsonObject } from './templates.ts';

/** Invalid history is reported and never used to resolve a historical signature. */
export function collectPlanReplaced(project: JsonObject, refusals: Finding[]): JsonObject[] {
  const plan = isObject(project.plan) ? project.plan : {};
  const entries: JsonObject[] = [];
  const seen = new Set<string>();
  let previousAt = -Infinity;
  const push = (code: string, path: string, why: string): void => {
    refusals.push({ code, path, message: `${path}: ${why}; restore the original plan.replaced entry and use plan revise or remove` });
  };
  if (plan.replaced !== undefined && !Array.isArray(plan.replaced)) {
    push('PLAN_REPLACED_INVALID', 'plan.replaced', 'must be an append-only list');
    return entries;
  }
  for (const [index, raw] of asArray(plan.replaced).entries()) {
    const path = `plan.replaced[${index}]`;
    if (!isObject(raw) || !isObject(raw.step) || typeof raw.step.id !== 'string' || !raw.step.id.trim()
      || (raw.step.phase !== 'rig' && raw.step.phase !== 'post')
      || typeof raw.by !== 'string' || !raw.by.trim() || typeof raw.at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.at)
      || !Number.isFinite(Date.parse(raw.at))) {
      push('PLAN_REPLACED_INVALID', path, 'needs the full previous step with id and phase, an ISO at and a nonempty by');
      continue;
    }
    const start = refusals.length;
    if (raw.sha256 !== stepHash(raw.step)) push('PLAN_REPLACED_HASH', `${path}.sha256`, 'does not equal stepHash(step)');
    if (raw.action !== 'revised' && raw.action !== 'removed') push('PLAN_REPLACED_ACTION', `${path}.action`, 'must be revised or removed');
    const at = Date.parse(raw.at);
    if (at < previousAt) push('PLAN_REPLACED_ORDER', `${path}.at`, 'must not precede the previous history entry');
    previousAt = Math.max(previousAt, at);
    const identity = JSON.stringify([raw.step.id, raw.at]);
    if (seen.has(identity)) push('PLAN_REPLACED_DUPLICATE', path, 'step.id and at must identify one history entry');
    seen.add(identity);
    if (refusals.length === start) entries.push(raw);
  }
  return entries;
}

/** Only ids with replacement history gain historical hash resolution. Old records are unchanged. */
export function checkReplacedSignoffs(project: JsonObject, entries: JsonObject[], refusals: Finding[]): void {
  const reopens = collectReopens(project, []);
  const signatures = collectSignoffs(project, []).filter(s => s.checkpoint === null);
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  const previousSteps = entries.map(entry => entry.step as JsonObject);
  const ids = new Set(previousSteps.map(step => String(step.id)));
  for (const signature of signatures) {
    if (signature.record.step_hashes === undefined) continue;
    const live = liveSignoff(reopens, signature.stage, signature.at);
    for (const id of ids) {
      if (signature.steps !== null && !signature.steps.includes(id)) continue;
      const hashes = signature.record.step_hashes;
      // An implicit historical approval cannot bind an id added after that signature.
      if (!live && signature.steps === null && isObject(hashes) && !Object.hasOwn(hashes, id)) continue;
      const candidates = [...steps, ...previousSteps].filter(step => step.id === id
        && (step.phase === 'rig' || step.phase === 'post')
        && approvalStageOfStep(step.phase, id, hasStageOrder(project)) === signature.stage);
      if (candidates.length === 0) continue;
      // Preserve latest-covering approval semantics for live re-signatures.
      if (live && signatures.some(other => {
        const at = Number.isNaN(signature.at) ? -Infinity : signature.at;
        const otherAt = Number.isNaN(other.at) ? -Infinity : other.at;
        return other.stage === signature.stage && liveSignoff(reopens, other.stage, other.at)
          && (other.steps === null || other.steps.includes(id))
          && (otherAt > at || (otherAt === at && other.index > signature.index));
      })) continue;
      const allowed = live ? candidates.filter(step => steps.includes(step)) : candidates;
      if (isObject(hashes) && allowed.some(step => stepHash(step) === hashes[id])) continue;
      const path = `signoffs[${signature.index}].step_hashes[${id}]`;
      refusals.push({ code: 'PLAN_REPLACED_SIGNOFF', path,
        message: `${path}: does not match ${live ? 'the current step' : 'a current or retained previous step'}; restore the signed step and its replacement history, or reopen the live approval before replanning` });
    }
  }
}


/** Replacement generations keep a withdrawal from applying to a later revision under the same id. */
export function checkpointGeneration(project: JsonObject, id: string): number {
  return asArray(isObject(project.plan) ? project.plan.replaced : undefined)
    .filter(entry => isObject(entry) && isObject(entry.step) && entry.step.id === id).length;
}

export function checkpointEnabled(step: JsonObject): boolean {
  const checkpoint = classify(step.checkpoint, { collection: null });
  return checkpoint.state === 'user' ? checkpoint.answer.value === true
    : checkpoint.state === 'delegated' && checkpoint.decided && isObject(checkpoint.answer.agent_decision)
      && checkpoint.answer.agent_decision.value === true;
}

/** Withdrawals preserve the signed step. Their authority is limited to its exact hash and replacement generation. */
export function collectCheckpointWithdrawals(project: JsonObject, refusals: Finding[], now = Infinity): JsonObject[] {
  const plan = isObject(project.plan) ? project.plan : {};
  if (plan.checkpoint_withdrawals === undefined) return [];
  const start = refusals.length;
  const entries: JsonObject[] = [];
  const identities = new Set<string>();
  let previousAt = -Infinity;
  const fail = (path: string): void => {
    refusals.push({ code: 'CHECKPOINT_WITHDRAWAL_INVALID', path,
      message: `${path}: retain a withdrawal with its original enabled step, hash, generation, operator, date, reason and exact words; restore the journal and use plan checkpoint-withdraw` });
  };
  if (!Array.isArray(plan.checkpoint_withdrawals)) { fail('plan.checkpoint_withdrawals'); return []; }
  for (const [index, raw] of plan.checkpoint_withdrawals.entries()) {
    const path = `plan.checkpoint_withdrawals[${index}]`;
    if (!isObject(raw) || Object.keys(raw).sort().join(',') !== 'at,by,generation,reason,schema,sha256,step,verbatim'
      || raw.schema !== 'rig-create/checkpoint-withdrawal@1' || !isObject(raw.step)
      || typeof raw.step.id !== 'string' || !raw.step.id.trim() || !['rig', 'post'].includes(String(raw.step.phase))
      || !checkpointEnabled(raw.step) || raw.sha256 !== stepHash(raw.step)
      || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0
      || Number(raw.generation) > checkpointGeneration(project, raw.step.id)
      || ['by', 'reason', 'verbatim'].some(key => typeof raw[key] !== 'string' || !String(raw[key]).trim())
      || typeof raw.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.at)
      || !Number.isFinite(Date.parse(raw.at)) || Date.parse(raw.at) > now) {
      fail(path); continue;
    }
    const original = raw.step;
    const id = String(original.id);
    const at = Date.parse(raw.at);
    const checkpoint = raw.step.checkpoint as JsonObject;
    const decision = checkpoint.delegated === true && isObject(checkpoint.agent_decision) ? checkpoint.agent_decision : checkpoint;
    const versions = asArray(plan.replaced).filter(entry => isObject(entry) && isObject(entry.step) && entry.step.id === id);
    const historical = versions[Number(raw.generation)];
    const current = asArray(plan.steps).find(step => isObject(step) && step.id === id);
    const bound = isObject(historical) ? historical.step : current;
    const identity = JSON.stringify([raw.step.id, raw.sha256, raw.generation]);
    if (!isObject(bound) || stepHash(bound) !== raw.sha256) { fail(path); continue; }
    if (at < previousAt || !Number.isFinite(Date.parse(String(decision.at ?? checkpoint.at))) || at < Date.parse(String(decision.at ?? checkpoint.at)) || identities.has(identity)) {
      fail(path); continue;
    }
    previousAt = at;
    identities.add(identity);
    entries.push(raw);
  }
  // A broken journal grants no partial exemption.
  return refusals.length === start ? entries : [];
}

export function checkpointRequired(project: JsonObject, step: JsonObject, now = Infinity): boolean {
  if (!checkpointEnabled(step)) return false;
  return !collectCheckpointWithdrawals(project, [], now).some(entry => isObject(entry.step)
    && entry.step.id === step.id && entry.sha256 === stepHash(step)
    && entry.generation === checkpointGeneration(project, String(step.id)));
}
