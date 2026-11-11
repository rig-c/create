import { collectBarAmendments } from './plan-bar-amendments.ts';
import { checkpointEnabled, checkpointGeneration, checkpointRequired, collectCheckpointWithdrawals } from './plan-history.ts';
import { readVerbatim } from './record-input.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { asArray, checkProject, collectSignoffs, isObject } from './check.ts';
import { readProject } from './feedback.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { approvalStageOfStep, hasStageOrder, stageOfStep } from './stages.ts';
import { stepHash } from './step-hash.ts';
import type { JsonObject } from './templates.ts';

export const PLAN_HELP = `plan add|revise|remove <id> [<project dir>] --by <drafter> [--json]
  --phase rig|post --order <number> --does <text> --produces <text>
  --rests-on <id,id,...> --bar <text> --checkpoint-proposed true|false
  checkpoint-withdraw <id> [<project dir>] --by <operator> --reason-file <file> --quote-file <file>
  bar-amend <id> [<project dir>] --by <operator> --reason-file <file> --quote-file <file> --bar-file <file>
  Amend one execution bar without changing the signed step.
  Withdraw one enabled execution checkpoint without changing the signed step.
  Add requires all fields. Revise accepts any of these fields and preserves the id.
  Revise/remove retain the full previous step in plan.replaced[].
  Reopen live covering plan signatures first. Completed steps require removal and a new id.
  Dates follow approval ownership: parts/legacy rig update drafted_at and drafted_by,
  production rigging updates rigging_drafted_at, and post preserves plan dates.
  Each candidate passes check's refusal delta before writing.`;

const FIELDS = ['phase', 'order', 'does', 'produces', 'rests_on', 'bar', 'checkpoint_proposed'];

/** Reopen resets status, but cannot make completed work a new draft under the same id. */
function completed(project: JsonObject, step: JsonObject): boolean {
  return step.status === 'done' || asArray(step.status_history).some(event => isObject(event) && event.status === 'done')
    || asArray(project.reopens).some(entry => isObject(entry) && asArray(entry.steps_before).some(before => isObject(before) && before.id === step.id && before.status === 'done'));
}

export function planCommand(args: string[], now: number): { stdout: string; exit: number } {
  const action = args[0];
  if (action === 'help' || args.includes('--help')) return { stdout: PLAN_HELP, exit: 0 };
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  const usage = (why: string): never => refuse('PLAN_OPTION_INVALID', `plan.steps: ${why}; see plan help`, USAGE_EXIT);
  if (!['add', 'revise', 'remove', 'checkpoint-withdraw', 'bar-amend'].includes(action ?? '')) usage('expected add, revise, remove, checkpoint-withdraw or bar-amend');
  const flags = ['--by', '--reason-file', '--quote-file', '--bar-file', ...FIELDS.map(field => `--${field.replaceAll('_', '-')}`)];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json') json = true;
    else if (flags.includes(arg)) {
      const value = args[++index];
      if (opts[arg] !== undefined || value === undefined || !value.trim() || value.startsWith('--')) usage(`${arg} needs one nonempty value`);
      opts[arg] = value;
    } else if (arg.startsWith('-')) usage(`unsupported option ${arg}`);
    else positional.push(arg);
  }
  const id = positional[0];
  if (!id?.trim() || positional.length > 2 || !opts['--by']) usage('supply an id, --by and one optional project directory');
  const patch: JsonObject = {};
  for (const field of FIELDS) {
    const value = opts[`--${field.replaceAll('_', '-')}`];
    if (value !== undefined) patch[field] = value;
  }
  const withdrawing = action === 'checkpoint-withdraw';
  const amendingBar = action === 'bar-amend';
  const journalAction = withdrawing || amendingBar;
  if (journalAction && (Object.keys(patch).length || !opts['--reason-file'] || !opts['--quote-file'])) usage('journal actions need reason-file and quote-file and take no authored step fields');
  if (amendingBar !== (opts['--bar-file'] !== undefined)) usage('bar-amend requires bar-file; other actions do not accept it');
  if (!journalAction && (opts['--reason-file'] || opts['--quote-file'])) usage('reason-file and quote-file belong only to journal actions');
  const inputFlags = journalAction ? ['--reason-file', '--quote-file', ...(amendingBar ? ['--bar-file'] : [])] : [];
  if (inputFlags.some(flag => opts[flag] === '-')) usage('journal actions need retained files, not shared stdin');
  const inputs = inputFlags.map(flag => ({ file: opts[flag]!, text: readVerbatim(opts[flag]!) }));
  if (inputs.some(input => !input.text.trim())) usage('journal input files must contain nonempty text');
  const reason = inputs[0]?.text ?? '';
  const verbatim = inputs[1]?.text ?? '';
  const amendedBar = inputs[2]?.text ?? '';
  if (action === 'remove' && Object.keys(patch).length) usage('remove takes no step fields');
  if (action === 'add' && FIELDS.some(field => patch[field] === undefined)) usage('add needs every step field');
  if (action === 'revise' && Object.keys(patch).length === 0) usage('revise needs at least one step field');
  if (patch.phase !== undefined && patch.phase !== 'rig' && patch.phase !== 'post') usage('--phase is rig or post');
  if (patch.order !== undefined) {
    const order = Number(patch.order);
    if (!Number.isFinite(order)) usage('--order needs a finite number');
    patch.order = order;
  }
  if (patch.rests_on !== undefined) {
    const ids = String(patch.rests_on).split(',');
    if (ids.some(value => !value.trim()) || new Set(ids).size !== ids.length) usage('--rests-on needs distinct nonempty answer ids');
    patch.rests_on = ids;
  }
  if (patch.checkpoint_proposed !== undefined) {
    if (!['true', 'false'].includes(String(patch.checkpoint_proposed))) usage('--checkpoint-proposed is true or false');
    patch.checkpoint_proposed = patch.checkpoint_proposed === 'true';
  }

  const dir = resolve(positional[1] ?? process.cwd());
  // Validate the target before creating a lock, then reload under the lock.
  readProject(dir);
  const releaseJob = acquireBoundJobWrite(dir);
  const lock = join(dir, '.plan.lock');
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx'); }
  catch { releaseJob(); refuse('PLAN_WRITE_CONFLICT', 'project.json: cannot acquire its plan writer lock; finish or recover the active plan write before retrying'); }
  try {
    const { file, project } = readProject(dir);
    const original = readFileSync(file);
    if (amendingBar && inputs.some(input => readVerbatim(input.file) !== input.text)) refuse('PLAN_WRITE_CONFLICT', 'plan.bar_amendments: input files changed while acquiring locks; restore the intended files and retry');
    if (!isObject(project.plan) || !Array.isArray(project.plan.steps)) refuse('PLAN_STEP_INVALID', 'plan.steps: must be a list in a plan object; restore the plan before drafting');
    if (project.plan.replaced !== undefined && !Array.isArray(project.plan.replaced)) refuse('PLAN_REPLACED_INVALID', 'plan.replaced: must be an append-only list; restore its original history');
    const next = structuredClone(project);
    const plan = next.plan as JsonObject;
    const steps = plan.steps as JsonObject[];
    const matches = steps.filter(step => isObject(step) && step.id === id);
    const previous = matches[0];
    if (action === 'add' ? matches.length !== 0 : matches.length !== 1) refuse('PLAN_STEP_INVALID', `plan.steps[${id}]: ${action === 'add' ? 'id already exists' : 'no unique current step'}; use a distinct id for add or an existing id for revise/remove`);
    if (action === 'add' && asArray(plan.replaced).some(entry => isObject(entry) && isObject(entry.step) && entry.step.id === id && completed(project, entry.step))) {
      refuse('PLAN_STEP_DONE', `plan.steps[${id}]: completed work is retained in history; add the replacement under a new id`);
    }
    const at = new Date(now).toISOString();
    if (amendingBar) {
      const findings: import('./check.ts').Finding[] = [];
      const journal = collectBarAmendments(project, findings, now);
      if (findings[0]) refuse(findings[0].code, findings[0].message);
      const generation = checkpointGeneration(project, id!);
      const replay = journal.find(entry => isObject(entry.step) && entry.step.id === id
        && entry.sha256 === stepHash(previous!) && entry.generation === generation);
      if (replay) {
        if (replay.by !== opts['--by'] || replay.reason !== reason || replay.verbatim !== verbatim || replay.amended_bar !== amendedBar) refuse('BAR_AMENDMENT_CONFLICT', `plan.bar_amendments: ${id} already has a different amendment; retain its original policy entry`);
        return { stdout: json ? JSON.stringify(replay, null, 2) : `plan: bar ${id} already amended`, exit: 0 };
      }
      if (!previous || !['rig', 'post'].includes(String(previous.phase))
        || stageOfStep(previous.phase as 'rig' | 'post', id!) !== project.stage
        || completed(project, previous) || typeof previous.bar !== 'string' || !previous.bar.trim()) {
        refuse('BAR_AMENDMENT_SCOPE', `plan.steps[${id}]: amendment needs one unfinished step with a bar in the current execution stage; preserve other stages and use the matching step`);
      }
      plan.bar_amendments = [...journal, { schema: 'rig-create/bar-amendment@1', step: structuredClone(previous),
        sha256: stepHash(previous), generation, amended_bar: amendedBar, by: opts['--by']!, at, reason, verbatim }];
    } else if (withdrawing) {
      const findings: import('./check.ts').Finding[] = [];
      const journal = collectCheckpointWithdrawals(project, findings, now);
      if (findings[0]) refuse(findings[0].code, findings[0].message);
      const generation = checkpointGeneration(project, id!);
      const replay = journal.find(entry => isObject(entry.step) && entry.step.id === id
        && entry.sha256 === stepHash(previous!) && entry.generation === generation);
      if (replay) {
        if (replay.by !== opts['--by'] || replay.reason !== reason || replay.verbatim !== verbatim) refuse('CHECKPOINT_WITHDRAWAL_CONFLICT', `plan.checkpoint_withdrawals: ${id} already has different withdrawal words or actor; retain its original journal entry`);
        return { stdout: json ? JSON.stringify(replay, null, 2) : `plan: checkpoint ${id} already withdrawn`, exit: 0 };
      }
      if (!previous || !['rig', 'post'].includes(String(previous.phase))
        || stageOfStep(previous.phase as 'rig' | 'post', id!) !== project.stage
        || completed(project, previous) || !checkpointEnabled(previous) || !checkpointRequired(project, previous, now)) {
        refuse('CHECKPOINT_WITHDRAWAL_SCOPE', `plan.steps[${id}]: withdrawal needs one enabled unfinished checkpoint in the current execution stage; preserve other stages and use the matching step`);
      }
      plan.checkpoint_withdrawals = [...journal, { schema: 'rig-create/checkpoint-withdrawal@1', step: structuredClone(previous),
        sha256: stepHash(previous), generation, by: opts['--by']!, at: new Date(now).toISOString(), reason, verbatim }];
    } else {
      if (previous !== undefined) {
        if (previous.phase !== 'rig' && previous.phase !== 'post') refuse('PLAN_STEP_INVALID', `plan.steps[${id}].phase: restore rig or post before drafting`);
        const stage = approvalStageOfStep(previous.phase, id!, hasStageOrder(project));
        const reopens = collectReopens(project, []);
        if (collectSignoffs(project, []).some(signature => signature.stage === stage && signature.checkpoint === null
          && (signature.steps === null || signature.steps.includes(id!)) && liveSignoff(reopens, signature.stage, signature.at))) {
          refuse('PLAN_STEP_SIGNED', `plan.steps[${id}]: a live ${stage} signature binds this step; reopen ${stage} before revising or removing it`);
        }
        if (action === 'revise' && completed(project, previous)) refuse('PLAN_STEP_DONE', `plan.steps[${id}]: completed work cannot be revised; remove it and add the replacement under a new id`);
      }
      if (previous !== undefined) {
        plan.replaced = [...asArray(plan.replaced), { step: structuredClone(previous), sha256: stepHash(previous), action: action === 'revise' ? 'revised' : 'removed', at, by: opts['--by']! }];
        const index = steps.indexOf(previous);
        if (action === 'remove') steps.splice(index, 1);
        else steps[index] = { ...previous, ...patch };
      } else steps.push({ id: id!, ...patch, checkpoint: null, status: 'pending' });
      const changedSteps = [previous, ...steps.filter(step => isObject(step) && step.id === id)].filter(isObject);
      const ownerships = new Set(changedSteps.map(step => approvalStageOfStep(step.phase as 'rig' | 'post', id!, hasStageOrder(project))));
      if (ownerships.has('plan-approved')) {
        plan.drafted_by = opts['--by']!;
        plan.drafted_at = at;
      }
      if (ownerships.has('rigging-interview')) plan.rigging_drafted_at = at;
    }

    const amendmentFindings: import('./check.ts').Finding[] = [];
    collectBarAmendments(next, amendmentFindings, now);
    if (amendmentFindings[0]) refuse(amendmentFindings[0].code, amendmentFindings[0].message);
    // Refusals the record already carries stay; a new code/path pair, or one more copy of a carried one, refuses.
    const fresh = newFindings(baselineOf(checkProject(dir, project, { now })), checkProject(dir, next, { now }).refusals)[0];
    if (fresh !== undefined) refuse(fresh.code, fresh.message);
    const temporary = join(dirname(file), `.plan-${process.pid}-${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
      if (!readFileSync(file).equals(original)) refuse('PLAN_WRITE_CONFLICT', 'project.json: changed while drafting; reload it and retry the plan command');
      if (amendingBar && inputs.some(input => readVerbatim(input.file) !== input.text)) refuse('PLAN_WRITE_CONFLICT', 'plan.bar_amendments: input files changed before commit; restore the intended files and retry');
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
    return { stdout: json ? JSON.stringify(plan, null, 2) : `plan: ${action} ${id} by ${opts['--by']} at ${at}`, exit: 0 };
  } finally {
    closeSync(descriptor);
    rmSync(lock);
    releaseJob();
  }
}
