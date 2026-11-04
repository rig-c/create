import { asArray, collectionQuestion, isObject, type Ctx } from './check.ts';
import { AGENT_BOUNCE_SINCE } from './stages.ts';
import type { JsonObject } from './templates.ts';

/** A mid-step rejection is history, separate from human version verdicts. */
export function checkAgentBounces(ctx: Ctx): void {
  const records = new Map<string, JsonObject>();
  for (const item of ctx.items) {
    records.set(item.path.replace(/\.(answer|guide)$/, ''), item.record);
    if (isObject(item.raw) && item.raw.basis === 'inherited' && isObject(item.raw.from) && typeof item.raw.from.question === 'string' && ctx.collection !== null) {
      const question = collectionQuestion(ctx.collection, item.raw.from.question);
      if (question !== undefined) records.set(`collection.interview[${item.raw.from.question}]`, question);
    }
  }
  for (const [base, record] of records) asArray(record.history).forEach((entry, i) => {
    if (!isObject(entry) || !('bounce' in entry)) return;
    const bounce = entry.bounce;
    if (isObject(bounce) && bounce.cause === 'agent' && ['failed', 'bar', 'replacement'].every((k) => typeof bounce[k] === 'string' && (bounce[k] as string).trim() !== '')) return;
    const at = typeof entry.at === 'string' ? Date.parse(entry.at) : Number.NaN;
    const legacy = !Number.isFinite(at) || at < Date.parse(AGENT_BOUNCE_SINCE);
    const path = `${base}.history[${i}].bounce`;
    (legacy ? ctx.warnings : ctx.refusals).push({
      code: legacy ? 'AGENT_BOUNCE_LEGACY' : 'AGENT_BOUNCE_MALFORMED', path,
      message: `${path}: needs { cause: 'agent', failed, bar, replacement } with non-empty text${legacy ? `; history entry predates ${AGENT_BOUNCE_SINCE} or has no readable at; kept as legacy` : ''}`,
    });
  });
}
