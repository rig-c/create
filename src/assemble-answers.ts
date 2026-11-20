import { existsSync } from './check-reads.ts';
import { join, resolve } from 'node:path';

import { asArray, asString, isObject, itemFor, type Ctx } from './check.ts';
import { readObject } from './cg-gates.ts';
import type { Json, JsonObject } from './templates.ts';

/** New asks apply to guides made under the new contract. */
export const PROJECTION_ASKS_SINCE = '2026-11-06T00:00:00Z';
export const ASSEMBLE_CONFIG_MATCH_SINCE = '2026-11-20T00:00:00Z';

/** A partial delegation can decide either field beside the user's own value. */
export function assembleAnswer(answer: JsonObject, field: 'project' | 'ground'): Json | undefined {
  const entry = asArray(answer.asks).find((raw) => isObject(raw) && raw.id === (field === 'project' ? 'projection' : 'ground'));
  if (!isObject(entry)) return undefined;
  const value = entry.state === 'user' ? answer.value
    : entry.state === 'delegated' && isObject(answer.agent_decision) ? answer.agent_decision.value : undefined;
  return isObject(value) ? value[field] : undefined;
}

/** Read the current config and retained version configs with the existing hash/path checks. */
export function checkAssembleAnswers(ctx: Ctx): { visible: boolean; legacy: boolean } {
  const item = itemFor(ctx, 'assemble');
  const state = item?.state;
  const answer = state?.state === 'user' || state?.state === 'delegated' ? state.answer : {};
  const at = typeof answer.at === 'string' ? Date.parse(answer.at) : Number.NaN;
  const legacy = !Number.isFinite(at) || at < Date.parse(PROJECTION_ASKS_SINCE);
  const findings = at >= Date.parse(ASSEMBLE_CONFIG_MATCH_SINCE) ? ctx.refusals : ctx.warnings;
  const projection = assembleAnswer(answer, 'project');
  const ground = assembleAnswer(answer, 'ground');
  const asks = asArray(answer.asks);
  const decision = isObject(answer.agent_decision) ? answer.agent_decision : {};
  const pendingChoice = isObject(answer.choice) && asks.some(a => isObject(a) && a.state === 'other-pending');
  const pendingDelegation = (id: string) => isObject(answer.choice)
    && asks.some(a => isObject(a) && a.id === id && a.state === 'delegated')
    && !asArray(decision.fragments).some(f => isObject(f) && f.ask === id);
  const compareProjection = (projection === 'core' || projection === 'visible') && !pendingDelegation('projection');
  const pendingGround = pendingDelegation('ground');
  const compareGround = (ground === 'plain' || ground === 'busy') && !pendingGround;
  let visible = projection === 'visible';
  const configs: { path: string; sha: string | null; at: string }[] = [];
  if (existsSync(join(ctx.dir, 'config.json'))) configs.push({ path: 'config.json', sha: null, at: 'config.json' });
  asArray(ctx.project.versions).forEach((raw, i) => {
    if (!isObject(raw) || raw.kind !== 'rig' || !isObject(raw.provenance) || !isObject(raw.provenance.config)) return;
    const config = raw.provenance.config;
    const path = asString(config.path);
    if (path !== null) configs.push({ path, sha: asString(config.sha256), at: `versions[${typeof raw.n === 'number' ? `v${raw.n}` : i}].provenance.config` });
  });
  for (const config of configs) {
    const read = readObject(ctx.dir, resolve(ctx.dir, config.path), config.sha);
    // Missing retained files already have provenance checks; this check introduces no new core refusal.
    if (!read.ok) continue;
    const assemble = isObject(read.value.assemble) ? read.value.assemble : {};
    // Parts uses core/plain when their respective fields are omitted.
    const comparisons = [
      { field: 'project', expected: projection, actual: assemble.project === undefined ? 'core' : assemble.project, decided: compareProjection },
      { field: 'ground', expected: ground, actual: assemble.ground === undefined ? 'plain' : assemble.ground, decided: compareGround },
    ];
    for (const { field, expected, actual, decided } of comparisons) {
      if (!decided || actual === expected) continue;
      findings.push({
        code: 'ASSEMBLE_CONFIG_ANSWER_MISMATCH',
        path: `${config.at} assemble.${field}`,
        message: `${config.path}: assemble.${field} is ${JSON.stringify(actual)}, but the recorded assemble answer is ${JSON.stringify(expected)}; align the config with the recorded answer.`,
      });
    }
    if (assemble.project !== 'visible') continue;
    visible = true;
    if (legacy || pendingChoice || pendingGround || ground === 'plain' || ground === 'busy') continue;
    ctx.refusals.push({ code: 'ASSEMBLE_GROUND_UNANSWERED', path: `${config.at} assemble.ground`, message: `${config.path}: assemble.project is visible with no ground answer; ask plain or busy, record the assemble guide's ground ask and value (or explicit decided delegation), then write assemble.ground in the config.` });
  }
  return { visible, legacy };
}
