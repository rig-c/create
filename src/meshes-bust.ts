/**
 * The bust at `meshes` (docs/CRAFT.md M2, docs/CHECKS.md § The bust at meshes):
 * the bust is meshed with its own regions by default, and the interview asks
 * only whether to leave it out. The `x_deform` value records that as
 * `bust: "default"` or `bust: { "excluded": true, "reason": "<non-empty>" }`;
 * an absent `bust` is the default. An exclusion without a reason is refused,
 * since the agent passes it to parts as the opt-out (rig-c/parts#986) and a
 * reason nobody wrote cannot be reviewed.
 *
 * Read on the `meshes` guide's value, the agent's decision on a delegation, and
 * every `additions[].value`, since a later sentence can carry the exclusion.
 * A value that is not an object is not read: free-text values predate this shape.
 */
import { asArray, isObject, itemFor, type Ctx } from './check.ts';
import type { Json } from './templates.ts';

/** The waypoint whose guide carries the `x_deform` value. */
export const MESHES_WAYPOINT = 'meshes';

/** The one value of `bust` that is not an exclusion. */
export const BUST_DEFAULT = 'default';

function valuesOf(ctx: Ctx): { value: Json | undefined; path: string }[] {
  const item = itemFor(ctx, MESHES_WAYPOINT);
  if (item === undefined) return [];
  const s = item.state;
  const out: { value: Json | undefined; path: string }[] = [];
  if (s.state === 'user') out.push({ value: s.answer.value, path: `${item.path}.value` });
  else if (s.state === 'delegated' && isObject(s.answer.agent_decision)) {
    out.push({ value: s.answer.agent_decision.value, path: `${item.path}.agent_decision.value` });
  } else return [];
  asArray(s.answer.additions).forEach((add, i) => {
    if (isObject(add)) out.push({ value: add.value, path: `${item.path}.additions[${i}].value` });
  });
  return out;
}

/** Refuses a `bust` that is neither the default nor an exclusion with a non-empty reason. */
export function checkMeshesBust(ctx: Ctx): void {
  for (const { value, path } of valuesOf(ctx)) {
    if (!isObject(value) || !('bust' in value)) continue;
    const bust = value.bust;
    const at = `${path}.bust`;
    if (bust === BUST_DEFAULT) continue;
    if (isObject(bust) && bust.excluded === true) {
      if (typeof bust.reason === 'string' && bust.reason.trim() !== '') continue;
      ctx.refusals.push({
        code: 'BUST_EXCLUSION_UNREASONED',
        path: at,
        message: `${at}: the bust is excluded with no reason; write the user's reason (a rigid breastplate, say) in \`reason\`, or record the default ("${BUST_DEFAULT}")`,
      });
      continue;
    }
    ctx.refusals.push({
      code: 'BUST_VALUE_UNKNOWN',
      path: at,
      message: `${at}: ${JSON.stringify(bust ?? null)} is neither "${BUST_DEFAULT}" nor { "excluded": true, "reason": "…" }`,
    });
  }
}
