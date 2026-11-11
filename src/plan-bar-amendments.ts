import { asArray, isObject, type Finding } from './check.ts';
import { checkpointGeneration } from './plan-history.ts';
import { stepHash } from './step-hash.ts';
import type { JsonObject } from './templates.ts';

/** Policy amendments never change the authored step or its approval hash. */
export function collectBarAmendments(project: JsonObject, refusals: Finding[], now = Date.now()): JsonObject[] {
  const plan = isObject(project.plan) ? project.plan : {};
  if (plan.bar_amendments === undefined) return [];
  const start = refusals.length;
  const entries: JsonObject[] = [];
  const identities = new Set<string>();
  let previousAt = -Infinity;
  const fail = (path: string): void => {
    refusals.push({ code: 'BAR_AMENDMENT_INVALID', path,
      message: `${path}: restore the original step, hash, generation, amended bar, operator, date, reason and exact words; use plan bar-amend` });
  };
  if (!Array.isArray(plan.bar_amendments)) { fail('plan.bar_amendments'); return []; }
  for (const [index, raw] of plan.bar_amendments.entries()) {
    const path = `plan.bar_amendments[${index}]`;
    if (!isObject(raw) || Object.keys(raw).sort().join(',') !== 'amended_bar,at,by,generation,reason,schema,sha256,step,verbatim'
      || raw.schema !== 'rig-create/bar-amendment@1' || !isObject(raw.step)
      || typeof raw.step.id !== 'string' || !raw.step.id.trim() || !['rig', 'post'].includes(String(raw.step.phase))
      || typeof raw.step.bar !== 'string' || !raw.step.bar.trim() || raw.sha256 !== stepHash(raw.step)
      || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0
      || Number(raw.generation) > checkpointGeneration(project, raw.step.id)
      || ['amended_bar', 'by', 'reason', 'verbatim'].some(key => typeof raw[key] !== 'string' || !String(raw[key]).trim())
      || typeof raw.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.at)
      || !Number.isFinite(Date.parse(raw.at)) || Date.parse(raw.at) > now) {
      fail(path); continue;
    }
    const id = raw.step.id;
    const versions = asArray(plan.replaced).filter(entry => isObject(entry) && isObject(entry.step) && entry.step.id === id);
    const historical = versions[Number(raw.generation)];
    const bound = isObject(historical) ? historical.step : asArray(plan.steps).find(step => isObject(step) && step.id === id);
    const identity = JSON.stringify([id, raw.sha256, raw.generation]);
    const at = Date.parse(raw.at);
    if (!isObject(bound) || stepHash(bound) !== raw.sha256 || at < previousAt || identities.has(identity)) {
      fail(path); continue;
    }
    previousAt = at;
    identities.add(identity);
    entries.push(raw);
  }
  return refusals.length === start ? entries : [];
}

/** A later revision, even one restoring identical text, does not inherit policy. */
export function effectiveBar(project: JsonObject, step: JsonObject, now = Date.now()): string {
  const entry = collectBarAmendments(project, [], now).find(entry => isObject(entry.step)
    && entry.step.id === step.id && entry.sha256 === stepHash(step)
    && entry.generation === checkpointGeneration(project, String(step.id)));
  return entry ? String(entry.amended_bar) : String(step.bar ?? '');
}
