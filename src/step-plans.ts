/**
 * Step plans (docs/INTERVIEW.md § Step plans): one plan document per user step,
 * proposed at once, bound by content hash, with feedback attached as discussion.
 * Feedback is never a gate: nothing here refuses a record for having none.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from './check-reads.ts';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { answered, asArray, checkProject, collectItems, isObject, loadCollection, type Finding, type Item } from './check.ts';
import { literalFile } from './choices.ts';
import { staleSignoffAnswer } from './signoff-answers.ts';
import { readProject } from './feedback.ts';
import { tryJobDirectoryLock } from './job-outbox.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { OWNER_CHAT_SOURCE, ownerChatFinding } from './owner-chat.ts';
import { assertCleanProjectStep, BASELINE_PATHS, commitToolWrite, trackedProjectStepPaths } from './project-step-commit.ts';
import { readVerbatim, writeRecord } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { PLAN_STEPS, STEP_PLAN_SCHEMA, STEP_PLAN_SOURCE, currentStepPlan, planStepOfGuide, stepPlanValue, type PlanStep } from './stages.ts';
import type { JsonObject } from './templates.ts';

export const REVIEW_COMMENT_SOURCE = 'review comment';
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const HEX = /^[a-f0-9]{64}$/;
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const iso = (value: unknown): value is string => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A project-relative path that stays inside the project folder. */
function insidePath(value: unknown): value is string {
  return nonblank(value) && !isAbsolute(value) && normalize(value) === value
    && value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith('../');
}

function fileHash(dir: string, path: string): string | undefined {
  const file = join(dir, path);
  try { return statSync(file).isFile() ? sha256(readFileSync(file)) : undefined; } catch { return undefined; }
}

function feedbackFinding(entry: JsonObject, path: string): Finding | undefined {
  if (entry.source === OWNER_CHAT_SOURCE) return ownerChatFinding(entry, path, entry.owner_words);
  const said = entry.said_at;
  if (entry.source !== REVIEW_COMMENT_SOURCE || !nonblank(entry.words) || !nonblank(entry.comment_id)
    || !nonblank(entry.by) || entry.by.toLowerCase() === 'agent' || !nonblank(entry.relayed_by)
    || !iso(said) || !iso(entry.at) || Date.parse(said) > Date.parse(String(entry.at))) {
    return { code: 'STEP_PLAN_FEEDBACK_INVALID', path, message: `${path}: feedback is relayed owner chat {source, owner_words, by, said_at, relayed_by, at} or a Review comment {source: "${REVIEW_COMMENT_SOURCE}", words, comment_id, by, said_at, relayed_by, at}; record it with plan feedback` };
  }
}

/** Shape refusals for every entry; staleness of the current plan per step is a WARN. */
export function checkStepPlans(dir: string, project: JsonObject, refusals: Finding[], warnings: Finding[], items: readonly Item[] = []): void {
  const interview = isObject(project.interview) ? project.interview : {};
  if (interview.step_plans === undefined) return;
  if (!Array.isArray(interview.step_plans)) {
    refusals.push({ code: 'STEP_PLAN_INVALID', path: 'interview.step_plans', message: 'interview.step_plans: must be a list of step plans; restore it or record plans with plan propose' });
    return;
  }
  interview.step_plans.forEach((entry, index) => {
    const path = `interview.step_plans[${index}]`;
    const inputs = isObject(entry) ? entry.inputs : undefined;
    if (!isObject(entry) || entry.schema !== STEP_PLAN_SCHEMA || !PLAN_STEPS.includes(entry.step as PlanStep)
      || !insidePath(entry.path) || typeof entry.sha256 !== 'string' || !HEX.test(entry.sha256)
      || typeof entry.bytes !== 'number' || !nonblank(entry.by) || !iso(entry.at)
      || !Array.isArray(inputs) || !inputs.every(input => isObject(input) && insidePath(input.path) && typeof input.sha256 === 'string' && HEX.test(input.sha256))
      || !Array.isArray(entry.feedback)) {
      refusals.push({ code: 'STEP_PLAN_INVALID', path, message: `${path}: a step plan is {schema: "${STEP_PLAN_SCHEMA}", step (${PLAN_STEPS.join(', ')}), path inside the project, sha256, bytes, inputs [{path, sha256}], by, at, feedback []}; restore the writer's record or propose the plan again with plan propose` });
      return;
    }
    asArray(entry.feedback).forEach((feedback, at) => {
      const feedbackPath = `${path}.feedback[${at}]`;
      const finding = isObject(feedback) ? feedbackFinding(feedback, feedbackPath)
        : { code: 'STEP_PLAN_FEEDBACK_INVALID', path: feedbackPath, message: `${feedbackPath}: feedback is an object; record it with plan feedback` };
      if (finding) refusals.push(finding);
    });
  });
  for (const step of PLAN_STEPS) {
    const current = currentStepPlan(project, step);
    if (!current || !insidePath(current.path)) continue;
    const index = interview.step_plans.indexOf(current);
    const changed = [{ path: current.path, sha256: current.sha256 }, ...asArray(current.inputs).filter(isObject)]
      .filter(bound => insidePath(bound.path) && fileHash(dir, bound.path) !== bound.sha256).map(bound => String(bound.path));
    if (changed.length > 0) warnings.push({ code: 'STEP_PLAN_STALE', path: `interview.step_plans[${index}]`,
      message: `interview.step_plans[${index}] (${step}): ${changed.join(', ')} no longer match${changed.length === 1 ? 'es' : ''} the bytes the plan was proposed against; propose the plan again with plan propose ${step} so feedback binds the current content` });
  }
  for (const item of items) {
    if (item.state.state !== 'delegated' || !stepPlanValue(project, item, item.state.answer)) continue;
    const step = planStepOfGuide(item.id, item.kind === 'post');
    const current = currentStepPlan(project, step);
    const quote = typeof item.state.answer.plan_quote === 'string' ? squash(item.state.answer.plan_quote) : '';
    const text = current && insidePath(current.path) ? planText(dir, current.path) : undefined;
    if (quote !== '' && text !== undefined && squash(text).includes(quote)) continue;
    warnings.push({ code: 'STEP_PLAN_VALUE_UNSAID', path: item.path,
      message: `${item.path}: the ${item.id} value's plan_quote is not in the current ${step} plan${current ? ` (${String(current.path)})` : ''}; say the value in plain words in the plan, propose it again, and record the value with interview-decision ${item.id} --value-file <json> --plan-quote-file <the sentence>` });
  }
}

/** The documented rule (docs/INTERVIEW.md § Step plans): the quote appears in the plan text, whitespace collapsed. */
function squash(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
function planText(dir: string, path: string): string | undefined {
  try { return readFileSync(join(dir, path), 'utf8'); } catch { return undefined; }
}

export const STEP_PLAN_HELP = `plan propose <step> [<project dir>] --file <plan.md> --by <drafter> [--input <path>]... [--json]
  Record one plan for a whole step (${PLAN_STEPS.join(', ')}): what the agent will do across the figure and why.
  The file stays in the project folder (relative paths resolve against it); the record binds its sha256
  and the sha256 of each registered input and --input.
  Proposing again appends a new entry; the latest entry per step is current. Same bytes and inputs are a no-op.
plan feedback <step> [<project dir>] --words-file <file> --by <who said it> --said-at <ISO> --relayed-by <operator>
  [--comment-id <Review comment id>] [--sha256 <plan sha256>] [--json]
  Attach the person's words to the current plan (or the plan with --sha256). Without --comment-id the words are
  relayed owner chat; with it they are a Review comment. Feedback is discussion: no writer waits for it.`;

/** Writer for plan propose and plan feedback; validates the candidate with check before writing. */
export function stepPlanCommand(args: string[], now: number): { stdout: string; exit: number; stderr?: string } {
  const action = args[0] as 'propose' | 'feedback';
  const usage = (why: string): never => refuse('PLAN_OPTION_INVALID', `interview.step_plans: ${why}; see plan help`, USAGE_EXIT);
  const single = action === 'propose' ? ['--file', '--by'] : ['--words-file', '--by', '--said-at', '--relayed-by', '--comment-id', '--sha256'];
  const opts: Record<string, string> = {};
  const extraInputs: string[] = [];
  const positional: string[] = [];
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json') json = true;
    else if (single.includes(arg) || (action === 'propose' && arg === '--input')) {
      const value = args[++index];
      if (value === undefined || !value.trim() || value.startsWith('--') || opts[arg] !== undefined) usage(`${arg} needs one nonempty value`);
      if (arg === '--input') extraInputs.push(value!);
      else opts[arg] = value!;
    } else if (arg.startsWith('-')) usage(`unsupported option ${arg}`);
    else positional.push(arg);
  }
  const step = positional[0] as PlanStep;
  if (!PLAN_STEPS.includes(step) || positional.length > 2) usage(`name one step (${PLAN_STEPS.join(', ')}) and one optional project directory`);
  const required = action === 'propose' ? ['--file', '--by'] : ['--words-file', '--by', '--said-at', '--relayed-by'];
  const missing = required.filter(flag => opts[flag] === undefined);
  if (missing.length) usage(`${action} needs ${missing.join(', ')}`);
  const dir = resolve(positional[1] ?? process.cwd());
  const readPlanFile = (file: string, flag: string): { path: string; bytes: Buffer } => {
    const path = relative(dir, resolve(dir, file));
    try {
      const privatePath = /^(?:scratch\/|node_modules\/|\.rig-create-)/.test(path);
      if (!insidePath(path) || privatePath || [...BASELINE_PATHS, '.gitignore', 'collection.json', 'review-live.json'].includes(path)) {
        throw new Error('expected a separate project-relative file');
      }
      return { path, bytes: readFileSync(literalFile(dir, path)) };
    } catch {
      refuse('STEP_PLAN_FILE_INVALID', `interview.step_plans: ${flag} ${file} must name a readable regular file inside the project folder; keep the file in the project so its bytes stay bound`);
    }
  };
  const words = action === 'feedback' ? readVerbatim(opts['--words-file']!) : '';
  if (action === 'feedback' && !words.trim()) usage('--words-file must contain the nonblank words');

  readProject(dir);
  const releaseJob = acquireBoundJobWrite(dir, undefined, true);
  let releasePlan: (() => void) | null = null;
  try {
    releasePlan = tryJobDirectoryLock(join(dir, '.plan.lock'));
    if (!releasePlan) refuse('PLAN_WRITE_CONFLICT', 'project.json: cannot acquire its plan writer lock; finish or recover the active plan write before retrying');
    const { file, project, bytes: original } = readProject(dir);
    const next = structuredClone(project);
    if (!isObject(next.interview)) refuse('STEP_PLAN_INVALID', 'interview: missing; restore the interview record before proposing a plan');
    const interview = next.interview as JsonObject;
    if (interview.step_plans !== undefined && !Array.isArray(interview.step_plans)) refuse('STEP_PLAN_INVALID', 'interview.step_plans: must be a list of step plans; restore it before writing');
    const plans = (interview.step_plans ??= []) as JsonObject[];
    const at = new Date(now).toISOString();
    let written: JsonObject;
    const registered = new Map<string, string>();
    if (action === 'propose') {
      const { path, bytes } = readPlanFile(opts['--file']!, '--file');
      if (!bytes.toString('utf8').trim()) refuse('STEP_PLAN_FILE_INVALID', `interview.step_plans: ${path} is empty; write the plan before proposing it`);
      const planHash = sha256(bytes);
      registered.set(path, planHash);
      const bound = new Map<string, string>();
      const explicitInputs: string[] = [];
      for (const input of asArray(project.inputs)) {
        if (isObject(input) && insidePath(input.path) && typeof input.sha256 === 'string' && HEX.test(input.sha256)) bound.set(input.path, input.sha256);
      }
      for (const input of extraInputs) {
        const { path: inputPath, bytes: inputBytes } = readPlanFile(input, '--input');
        const hash = sha256(inputBytes);
        if (inputPath === path && hash !== planHash) refuse('PLAN_WRITE_CONFLICT', `${path}: plan bytes changed while binding --input; retry with stable files`);
        bound.set(inputPath, hash);
        registered.set(inputPath, hash);
        explicitInputs.push(inputPath);
      }
      assertCleanProjectStep(dir, trackedProjectStepPaths(dir, explicitInputs));
      const inputs = [...bound].map(([inputPath, hash]) => ({ path: inputPath, sha256: hash }));
      const current = currentStepPlan(project, step);
      if (current && current.path === path && current.sha256 === planHash && JSON.stringify(current.inputs) === JSON.stringify(inputs)) {
        return { stdout: json ? JSON.stringify(current, null, 2) : `plan: ${step} plan already proposed (${path})`, exit: 0 };
      }
      written = { schema: STEP_PLAN_SCHEMA, step, path, sha256: planHash, bytes: bytes.length, inputs, by: opts['--by']!, at, feedback: [] };
      plans.push(written);
    } else {
      const target = opts['--sha256'] === undefined ? currentStepPlan(next, step)
        : plans.filter(entry => isObject(entry) && entry.schema === STEP_PLAN_SCHEMA && entry.step === step && entry.sha256 === opts['--sha256']).at(-1);
      if (!target) refuse('STEP_PLAN_MISSING', `interview.step_plans: no ${step} plan${opts['--sha256'] ? ` with sha256 ${opts['--sha256']}` : ''}; propose it with plan propose ${step} before attaching feedback`);
      written = opts['--comment-id'] === undefined
        ? { source: OWNER_CHAT_SOURCE, owner_words: words, by: opts['--by']!, said_at: opts['--said-at']!, relayed_by: opts['--relayed-by']!, at }
        : { source: REVIEW_COMMENT_SOURCE, words, comment_id: opts['--comment-id']!, by: opts['--by']!, said_at: opts['--said-at']!, relayed_by: opts['--relayed-by']!, at };
      const index = plans.indexOf(target!);
      const finding = feedbackFinding(written, `interview.step_plans[${index}].feedback[${asArray(target!.feedback).length}]`);
      if (finding) refuse(finding.code, finding.message);
      target!.feedback = [...asArray(target!.feedback), written];
    }
    // Refusals the record already carries stay; a new code/path pair refuses before any byte moves.
    // A revised plan is a new revision of the questions it covers: like an answer correction, it may leave
    // their sign-off bindings stale for re-signing (SIGNOFF_ANSWERS_STALE), and nothing else.
    const covered = (finding: Finding): boolean => {
      const id = action === 'propose' ? staleSignoffAnswer(finding)?.id : undefined;
      const item = id === undefined ? undefined : collectItems(next, { collection: loadCollection(dir) }).find(i => i.id === id);
      if (item === undefined || planStepOfGuide(item.id, item.kind === 'post') !== step) return false;
      return item.state.state === 'silent' || (answered(item.state) && isObject(item.raw) && item.raw.source === STEP_PLAN_SOURCE);
    };
    const fresh = newFindings(baselineOf(checkProject(dir, project, { now })), checkProject(dir, next, { now }).refusals).filter(f => !covered(f))[0];
    if (fresh !== undefined) refuse(fresh.code, fresh.message);
    const assets = [...registered.keys()];
    assertCleanProjectStep(dir, ['project.json']);
    if (action === 'propose') {
      assertCleanProjectStep(dir, assets, true);
      for (const [path, hash] of registered) {
        const { bytes } = readPlanFile(path, 'registered file');
        if (sha256(bytes) !== hash) refuse('PLAN_WRITE_CONFLICT', `${path}: registered bytes changed while validating the plan; retry with stable files`);
      }
    }
    writeRecord(file, original, next, 'plan', 'PLAN_WRITE_CONFLICT');
    const warning = commitToolWrite(dir, `plan ${action}`, ['project.json', ...assets]);
    return { stdout: json ? JSON.stringify(written, null, 2) : `plan: ${action} ${step} by ${opts['--by']} at ${at}`, exit: 0,
      ...(warning === undefined ? {} : { stderr: warning }) };
  } finally {
    try { releasePlan?.(); } finally { releaseJob(); }
  }
}
