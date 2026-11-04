import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { asArray, classify, isObject } from './check.ts';
import { readProject } from './feedback.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { PHASE_APPROVED_BY, STAGE_VALUES } from './stages.ts';
import { stepHash } from './step-hash.ts';
import type { JsonObject } from './templates.ts';

export const SIGNOFF_HELP = `signoff:
  <stage> [<project dir>]  record a human signature without moving project.stage
  --by <who>              the person signing (agent is refused)
  --verbatim-file <file>  UTF-8 words unchanged, or - for stdin (default: stdin)
  --steps <id,id,...>      narrow plan-approved rig steps or post-interview post steps
  --json                  print the signature as JSON
  The clock supplies at. With no --steps, signs all steps of the stage's phase.
  Fills null checkpoints from checkpoint_proposed and hashes covered steps after filling.
  Existing checkpoints are preserved. Other stages record a signature only.`;

export function signoffCommand(args: string[]): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (['--by', '--verbatim-file', '--steps'].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value === '') refuse('SIGNOFF_OPTION_INVALID', `${arg} needs one non-empty value`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `signoff does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const stage = positional[0];
  if (positional.length > 2 || stage === undefined || !STAGE_VALUES.includes(stage)) refuse('SIGNOFF_OPTION_INVALID', 'signoff takes a known stage and one optional project folder', USAGE_EXIT);
  const by = opts['--by'];
  if (by === undefined) refuse('SIGNOFF_OPTION_INVALID', 'signoff needs --by', USAGE_EXIT);
  if (by.toLowerCase() === 'agent') refuse('SIGNOFF_NOT_HUMAN', `stage ${stage}: signed by agent`);
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = readProject(dir);
  if (!Array.isArray(project.signoffs)) refuse('SIGNOFF_MALFORMED', 'signoffs must be a list');
  const phase = Object.entries(PHASE_APPROVED_BY).find(([, approvedBy]) => approvedBy === stage)?.[0];
  if (phase === undefined && opts['--steps'] !== undefined) refuse('SIGNOFF_OPTION_INVALID', '--steps requires plan-approved or post-interview', USAGE_EXIT);
  const requested = opts['--steps']?.split(',');
  if (requested !== undefined && (requested.some((id) => id === '') || new Set(requested).size !== requested.length)) refuse('SIGNOFF_STEP_INVALID', '--steps needs distinct non-empty step ids', USAGE_EXIT);
  const steps = phase === undefined ? [] : asArray(isObject(project.plan) ? project.plan.steps : undefined)
    .filter((step): step is JsonObject => isObject(step) && step.phase === phase);
  for (const id of requested ?? []) {
    if (!steps.some((step) => step.id === id)) refuse('SIGNOFF_STEP_INVALID', `${id}: no step in phase ${phase}`);
  }
  const covered = steps.filter((step) => requested === undefined || requested.includes(step.id as string));
  if (phase !== undefined && covered.length === 0) refuse('SIGNOFF_STEP_INVALID', `no ${phase} steps to sign`);
  const ids = covered.map((step) => step.id);
  if (ids.some((id) => typeof id !== 'string' || id === '') || new Set(ids).size !== ids.length) refuse('SIGNOFF_STEP_INVALID', 'covered steps need distinct non-empty string ids');
  for (const step of covered) {
    if (typeof step.checkpoint_proposed !== 'boolean') refuse('SIGNOFF_CHECKPOINT_INVALID', `${String(step.id)}: checkpoint_proposed must be boolean`);
    const checkpoint = classify(step.checkpoint, { collection: null });
    if (checkpoint.state === 'silent') continue;
    const value = checkpoint.state === 'user' ? checkpoint.answer.value
      : checkpoint.state === 'delegated' && checkpoint.decided && isObject(checkpoint.answer.agent_decision) ? checkpoint.answer.agent_decision.value : undefined;
    if (typeof value !== 'boolean') refuse('SIGNOFF_CHECKPOINT_INVALID', `${String(step.id)}: checkpoint needs a boolean user answer or a decided boolean delegation`);
  }
  const verbatim = readVerbatim(opts['--verbatim-file'] ?? '-');
  const at = new Date().toISOString();
  const hashes: JsonObject = Object.create(null) as JsonObject;
  for (const step of covered) {
    if (step.checkpoint === null || step.checkpoint === undefined) {
      step.checkpoint = { delegated: false, by, at, verbatim, value: step.checkpoint_proposed };
    }
    hashes[step.id as string] = stepHash(step);
  }
  const signoff: JsonObject = { stage, checkpoint: null, by, at, verbatim };
  if (phase !== undefined) {
    signoff.steps = ids;
    signoff.step_hashes = hashes;
  }
  project.signoffs.push(signoff);
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(signoff, null, 2) : `signoff: recorded ${stage} by ${by} at ${at}; stage unchanged`, exit: 0 };
}
