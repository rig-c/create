import { OWNER_CHAT_FLAGS, readOwnerChat } from './owner-chat.ts';
import { validateCameraOptions } from './camera-choice.ts';
import { overrideFindings } from './overrides.ts';
import { intakeItem, intakeWarnings, INTAKE_QUESTION } from './intake.ts';
import { prepareInterviewCommentClosure } from './interview-comment-closures.ts';
/** Public record writers; validation precedes every project write. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { acquireBoundJobWrite } from './job-writer.ts';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { answered, asArray, checkProject, collectItems, collectSignoffs, isObject, loadCollection, collectionAnswer, type Item } from './check.ts';
import { approvalStageOfGuide, currentStepPlan, planStepOfGuide, STEP_PLAN_SOURCE, stepPlanValue, VALUE_QUESTIONS } from './stages.ts';
import { SECTIONLESS_POST_ITEMS, WAYPOINT_ASKS } from './waypoints.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { readProject } from './feedback.ts';
import { assertCleanProjectStep, BASELINE_PATHS, commitToolWrite } from './project-step-commit.ts';
import { readVerbatim } from './record-input.ts';
import { assertTurnBody } from './rig-version.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, findingKey, newFindings, stoppedEarly } from './refusal-baseline.ts';
import { CHOICE_ORDER_SPEC, CHOICE_SPEC, ChoiceError, assembleFragments, choiceAdoption, choiceVerbatim, literalFile, optionFile, refusalBaseline, selection, sha256, validateChoice, validateContext, validateSet } from './choices.ts';
import type { Json, JsonObject } from './templates.ts';

export const CHOICE_HELP = `interview-options <question> [<dir>] --file <retained project-relative JSON>
interview-options --adopt [<dir>]
interview-answer <source-question> [<dir>] --close-comment --job <jobId> --act <actId> --order <n>
  --by agent --reason-file <file> [--resolved-by-answer <question>]
interview-answer <question> [<dir>] --set <path> --sha256 <shown sha> --by <human>
  [--pick <ask>=<option>...] [--other <ask>=<file> --other-fragment <ask>=<JSON file>]...
  [--owner-chat <words file> --said-at <ISO date> --relayed-by <who>]
  [--note-file <file>] [--source <location>] [--why-file <file> for a member override]
interview-decision <question> [<dir>] --by <agent> --reasoning-file <file>
  --fragment <ask>=<JSON file>...
interview-decision <question> [<dir>] --by agent --reasoning-file <file>
  --value-file <JSON file> --plan-quote-file <file>   (a value code reads, under a step plan)
Retain the shown set first. Each ask is picked explicitly; no recommended option is preselected.
Write ask prompts, option labels and effects, and recommendation reasons in the owner's declared language.
To ask an answered question again, retain and register a new set id/path with
interview-options <question> --file <path>, then relay the owner's answer with
interview-answer <question> --set <id> --sha256 <hash> --pick <option> --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>; history is kept.
--adopt: split-order projects adopt all choices; legacy-order projects may adopt
post choices at post-interview only. For full adoption, first adopt the split
stage order with a fresh parts/rigging interview (docs/INTERVIEW.md).`;
function usage(why: string): never { refuse('INTERVIEW_OPTIONS_USAGE', `interview: ${why}; ${CHOICE_HELP}`, USAGE_EXIT); }
interface Args { positional: string[]; one: Record<string,string>; many: Record<string,Map<string,string>>; adopt: boolean; }
function parse(args: string[], allowed: string[], repeat: string[] = []): Args {
  const parsed: Args = { positional: [], one: {}, many: {}, adopt: false };
  for (let i=0;i<args.length;i++) {
    const arg = args[i] as string;
    if (arg === '--adopt' && allowed.includes(arg)) { if (parsed.adopt) usage('duplicate --adopt'); parsed.adopt = true; }
    else if (repeat.includes(arg) || allowed.includes(arg)) {
      const v = args[++i]; if (v === undefined || v.startsWith('--')) usage(`${arg} needs a value`);
      if (repeat.includes(arg)) {
        const eq = v.indexOf('='); if (eq < 1 || eq === v.length-1) usage(`${arg} needs ask=value`);
        const key = v.slice(0,eq); const values = parsed.many[arg] ?? new Map<string,string>();
        if (values.has(key)) usage(`${arg}: duplicate ask ${key}`);
        values.set(key,v.slice(eq+1)); parsed.many[arg] = values;
      } else { if (parsed.one[arg] !== undefined) usage(`duplicate ${arg}`); parsed.one[arg] = v; }
    } else if (arg.startsWith('-')) usage(`unknown flag ${arg}`);
    else parsed.positional.push(arg);
  }
  return parsed;
}
function itemAt(project: JsonObject, dir: string, question: string | undefined): Item {
  if (!question) usage('question required');
  if (question === INTAKE_QUESTION) {
    if (project.stage !== 'parts') usage('intake_suitability is offered only in parts after recording a preflight');
    if (intakeWarnings(dir,project).some(w => w.code === 'INTAKE_REPORT_INVALID')) refuse('INTAKE_REPORT_INVALID','intake.reports: restore bound producer bytes before drafting choices');
    const intake = intakeItem(project); if (!intake) usage('record a preflight with intake-report first'); return intake;
  }
  const found = collectItems(project, { collection: loadCollection(dir) }).find(i => i.id === question);
  if (!found) usage(`unknown question ${question}`);
  return found;
}
function readText(file: string): string { try { return readFileSync(file,'utf8'); } catch { return usage(`cannot read ${file}`); } }
function jsonFile(file: string): Json { try { return JSON.parse(readText(file)) as Json; } catch { return usage(`invalid JSON file ${file}`); } }
function run(action: () => string): string {
  try { return action(); } catch (e) { if (e instanceof ChoiceError) refuse(e.code, `interview: ${e.message}; retain the shown set and explicitly record each ask`, ); throw e; }
}
/** Partial interviews may retain unrelated pre-existing refusals, but a writer cannot add a new one. */
export function save(file: string, dir: string, original: JsonObject, candidate: JsonObject, now: number, baseline: JsonObject[] = [],
  recordedAnswers: readonly { id: string; correction: boolean }[] = [], originalBytes?: Buffer, beforeWrite?: () => void): void {
  const asRead = checkProject(dir,original,{now});
  const counts = baselineOf(asRead);
  // A pending answer's stored baseline widens the record's own; it never stands in for a check that stopped early.
  if (!stoppedEarly(asRead)) for (const f of baseline) {
    const k = findingKey({ code: String(f.code), path: String(f.path) });
    counts.set(k,Math.max(counts.get(k) ?? 0,Number(f.count)));
  }
  const findings = newFindings(counts,checkProject(dir,candidate,{now}).refusals);
  const staleBinding = (finding: (typeof findings)[number], id: string): boolean =>
    finding.code === 'SIGNOFF_ANSWERS_STALE' && finding.path.endsWith(`.answer_hashes[${id}]`);
  const unsignedAnswers = recordedAnswers.filter(({ id, correction }) => correction && findings.some(finding => staleBinding(finding, id))).map(({ id }) => id);
  const stepsToRevise = new Set<string>();
  if (recordedAnswers.length && isObject(candidate.plan)) {
    for (const step of asArray(candidate.plan.steps).filter(isObject)) {
      const basis = asArray(step.rests_on);
      const stepPath = `plan.steps[${String(step.id)}]`;
      if (recordedAnswers.some(({ id }) => basis.includes(id))) stepsToRevise.add(stepPath);
    }
  }
  // A guide correction can also require its already-run steps to be re-signed.
  // Record an answer before asking for additions or revisions to steps that depend on it.
  const recordsTurn = asRead.effective_stage === 'rigging-interview' && recordedAnswers.some(({ id }) => id === 'turn');
  const first = findings.find(finding => !unsignedAnswers.some(id => staleBinding(finding, id))
    && !(finding.code === 'PLAN_STEP_PREDATES_ANSWER' && stepsToRevise.has(finding.path))
    && !(finding.code === 'RIG_DEPTH_PLAN_MISSING' && finding.path === 'plan.steps[turn]' && recordsTurn));
  if (first) refuse(first.code,first.message);
  if (originalBytes && !readFileSync(file).equals(originalBytes)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during interview validation; retry against the current job');
  beforeWrite?.();
  const tmp = join(dirname(file), `.interview-${process.pid}-${crypto.randomUUID()}.tmp`);
  writeFileSync(tmp,`${JSON.stringify(candidate,null,2)}\n`, { flag: 'wx' }); renameSync(tmp,file);
}
function checkNewAnswer(dir: string, project: JsonObject, item: Item, correction = false): void {
  if (item.path === 'intake.choice.answer') {
    if (choiceAdoption(project, item) === null) refuse('INTERVIEW_CHOICE_REQUIRED', 'intake.choice: adopt choices before recording a new choice');
    return;
  }
  const stage = approvalStageOfGuide(item.id,item.kind === 'post',true);
  const reopens = collectReopens(project,[]);
  if (!correction && collectSignoffs(project,[]).some(s => s.stage === stage && s.checkpoint === null && liveSignoff(reopens,s.stage,s.at))) refuse('INTERVIEW_CHOICE_INVALID', `${item.path}: approval is still live; resolve the missing earlier answer with the owner and record amend ${stage === 'plan-approved' ? 'interview' : stage} before adding it`);
  if (choiceAdoption(project, item) === null) refuse('INTERVIEW_CHOICE_REQUIRED', `${item.path}: adopt order@2 with interview-options --adopt before recording new choices`);
  if (isObject(item.raw) && item.raw.basis === 'inherited') {
    // This changes the local member record, never its resolved collection source.
    if (!loadCollection(dir)) refuse('INTERVIEW_CHOICE_INVALID', `${item.path}: collection source unavailable; restore it before recording a member-local choice`);
  }
}

export function interviewOptionsCommand(args: string[], now: number): string { return run(() => {
  const opts = parse(args,['--file','--adopt']);
  if (opts.adopt) {
    if (opts.positional.length > 1 || Object.keys(opts.one).length) usage('--adopt takes only a project folder');
  } else if (opts.positional.length > 2 || !opts.one['--file']) usage('question and --file required');
  const dir = resolve(opts.positional[opts.adopt ? 0 : 1] ?? process.cwd());
  const release = acquireBoundJobWrite(dir, { kind: 'record-only', writer: 'interview' }, true);
  try {
    const {file,project,bytes} = readProject(dir); const next = structuredClone(project);
    const persist = (output: string, binding?: { path: string; sha256: string }): string => {
      const recordPaths = ['project.json'];
      save(file, dir, project, next, now, [], [], undefined, () => {
        assertCleanProjectStep(dir, recordPaths);
        if (!readFileSync(file).equals(bytes)) refuse('INTERVIEW_OPTIONS_STALE', 'project.json: record changed during interview validation; retry against the current record');
        if (binding) {
          assertCleanProjectStep(dir, [binding.path], true);
          optionFile(dir, binding);
        }
      });
      const paths = binding ? [...recordPaths, binding.path] : recordPaths;
      const warning = commitToolWrite(dir, 'interview-options', paths);
      if (warning !== undefined) process.stderr.write(`${warning}\n`);
      return output;
    };
    if (opts.adopt) {
      const interview = isObject(next.interview) ? next.interview : null;
      if (interview && interview.order === undefined && isObject(interview.post)) {
        if (project.stage !== 'post-interview') refuse('INTERVIEW_CHOICE_INVALID', 'interview.post: for post-only choices, advance to post-interview before interview-options --adopt; for full adoption, first adopt the split stage order with a fresh parts/rigging interview (docs/INTERVIEW.md)');
        if (interview.post.choices_adopted_at !== undefined) {
          if (!Number.isFinite(Date.parse(String(interview.post.choices_adopted_at)))) refuse('INTERVIEW_CHOICE_INVALID', 'interview.post: restore the original valid choices_adopted_at');
          return 'interview: post choices already adopted; original date preserved';
        }
        interview.post.choices_adopted_at = new Date(now).toISOString();
        return persist('interview: post choices adopted; stage order and earlier answers preserved');
      }
      if (!interview || !isObject(interview.order) || !['rig-create/stage-order@1', CHOICE_ORDER_SPEC].includes(String(interview.order.spec))) refuse('INTERVIEW_CHOICE_INVALID','interview.order: first adopt the split stage order with a fresh parts/rigging interview; then adopt choices');
      if (interview.order.spec === CHOICE_ORDER_SPEC) return 'interview: choices already adopted; original dates preserved';
      interview.order = {...interview.order,spec:CHOICE_ORDER_SPEC,choices_adopted_at:new Date(now).toISOString()};
      return persist('interview: choices adopted; earlier answers preserved');
    }
    const item = itemAt(next,dir,opts.positional[0]); const path = opts.one['--file'];
    if ([...BASELINE_PATHS, '.gitignore', 'collection.json', 'review-live.json'].includes(path) || /^(?:scratch\/|node_modules\/|\.rig-create-)/.test(path)) {
      refuse('INTERVIEW_OPTIONS_FILE', `${item.path}: retain the option set in a separate file before registering it`);
    }
    let binding: { path: string; sha256: string };
    try { binding = {path,sha256:sha256(readFileSync(literalFile(dir,path)))}; } catch (e) { throw new ChoiceError('INTERVIEW_OPTIONS_FILE',String(e)); }
    const {set} = optionFile(dir,binding); validateSet(next,item,set,loadCollection(dir)); validateContext(dir,next,set,now,true);
    validateCameraOptions(dir, set);
    if (choiceAdoption(next, item) === null) refuse('INTERVIEW_CHOICE_REQUIRED',`${item.path}: adopt choices before drafting a new question`);
    // A retained path/id may never be reused with a different hash, even after answer replacement.
    for (const other of [...collectItems(next,{collection:loadCollection(dir)}), ...(item.path === 'intake.choice.answer' ? [item] : [])]) {
      const bindings = [other.record.pending_options, ...[other.raw,...asArray(other.record.history)].filter(isObject).map(a => isObject(a.choice) ? a.choice.set : undefined)];
      for (const old of bindings) if (isObject(old)) {
        if (old.path === path && !equal(old,binding)) refuse('INTERVIEW_OPTIONS_FILE',`${item.path}: option path is already bound to other bytes; retain the original and use a new set id/path`);
        const retained = optionFile(dir,old).set;
        if (retained.id === set.id && !equal(old,binding)) refuse('INTERVIEW_OPTIONS_FILE',`${item.path}: option id is already retained; use a new id/path for a redraft`);
      }
    }
    if (equal(item.record.pending_options, binding)) return JSON.stringify(binding);
    item.record.pending_options = binding;
    return persist(JSON.stringify(binding), binding);
  } finally { release(); }
}); }

interface AnswerDraft {
  item: Item;
  answer: JsonObject;
  correction: boolean;
}

function prepareInterviewAnswer(
  dir: string, project: JsonObject, item: Item, opts: Args, now: number,
  chat: ReturnType<typeof readOwnerChat>,
): AnswerDraft {
  const correction = answered(item.state);
  checkNewAnswer(dir,project,item,correction);
  const binding = {path:opts.one['--set'] as string,sha256:opts.one['--sha256'] as string};
  const registered = item.record.pending_options;
  if (isObject(registered) && binding.sha256 !== registered.sha256) refuse('INTERVIEW_OPTIONS_STALE',`${item.path}: displayed set sha differs from the registered set; refresh the questionnaire`);
  if (!equal(registered,binding)) refuse('INTERVIEW_CHOICE_INVALID',`${item.path}: displayed set is not the registered pending set; register/refresh the shown options`);
  const {set} = optionFile(dir,binding); validateSet(project,item,set,loadCollection(dir)); validateContext(dir,project,set,now,true);
  validateCameraOptions(dir, set);
  const offered = asArray(set.asks).filter(isObject);
  const selected = opts.many['--pick'] ?? new Map<string,string>();
  if (selected.size !== offered.length || [...selected.keys()].some(k => !offered.some(a => a.id === k))) throw new ChoiceError('INTERVIEW_CHOICE_INVALID','pick exactly once per applicable ask in questionnaire order');
  const picks: JsonObject[] = offered.map(ask => {
    const option = asArray(ask.options).filter(isObject).find(o => o.id === selected.get(String(ask.id)));
    if (!option) throw new ChoiceError('INTERVIEW_CHOICE_INVALID',`unknown option for ${String(ask.id)}`);
    const pick: JsonObject = {ask:ask.id as Json,option_id:option.id as Json,shown:{label:option.label as Json,effect:option.effect as Json}};
    if (option.kind === 'other') {
      const textPath = opts.many['--other']?.get(String(ask.id)); const fragment = opts.many['--other-fragment']?.get(String(ask.id));
      const words = textPath ? readText(textPath) : undefined;
      if (typeof words !== 'string' || !words.trim()) throw new ChoiceError('INTERVIEW_CHOICE_INVALID','Other requires exact nonempty text');
      pick.other_text = words;
      if (fragment) pick.other_fragment = jsonFile(fragment);
    }
    return pick;
  });
  for (const flag of ['--other','--other-fragment']) for (const ask of opts.many[flag]?.keys() ?? []) if (!picks.some(p => p.ask === ask && 'other_text' in p)) usage(`${flag} supplied for non-Other ask ${ask}`);
  const choice: JsonObject = {spec:CHOICE_SPEC,set:binding,picks};
  if (opts.one['--note-file']) choice.note = readText(opts.one['--note-file']);
  const result = selection(set,choice);
  if (result.autos.length && SECTIONLESS_POST_ITEMS.includes(item.id)) refusePostOwnerChoice(item.id);
  const answer: JsonObject = {delegated:result.delegated,by:opts.one['--by'],at:new Date(now).toISOString(),verbatim:choiceVerbatim(picks,choice.note),source:opts.one['--source'] ?? 'review questionnaire',choice,asks:result.asks};
  if (chat) { answer.owner_words = chat.owner_words!; answer.said_at = chat.said_at!; answer.relayed_by = chat.relayed_by!; answer.source = chat.source!; }
  if (result.value !== undefined) answer.value = result.value;
  if (result.autos.length) answer.agent_decision = {covers:result.autos.join(',')};
  if (isObject(item.raw) && typeof item.raw.basis === 'string') answer.basis = item.raw.basis === 'inherited' ? (item.state.state === 'silent' ? 'own' : 'overridden') : item.raw.basis;
  if (answer.basis === 'overridden') {
    const collection = loadCollection(dir);
    const prior = item.raw as JsonObject;
    const inherited = prior.basis === 'inherited' ? prior : prior.overrides === undefined ? asArray(item.record.history).filter(isObject).reverse().find(a => a.basis === 'inherited') : undefined;
    if (inherited !== undefined) {
      const from = isObject(inherited.from) ? inherited.from : {};
      const source = collection !== null && typeof from.question === 'string' ? collectionAnswer(collection, from.question) : undefined;
      answer.overrides = { collection: from.collection ?? null, question: from.question ?? null, collection_answer_at: isObject(source) ? source.at ?? null : null };
    } else if (prior.overrides !== undefined) answer.overrides = structuredClone(prior.overrides);
    answer.why_verbatim = null;
    if (opts.one['--why-file']) {
      try { answer.why_verbatim = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(opts.one['--why-file'])); }
      catch { refuse('OVERRIDE_REASON_MISSING', `${item.path}: --why-file must be readable UTF-8; ask for and retain the user's exact nonblank reason`); }
    }
    const findings = overrideFindings(answer, collection, item.path);
    if (findings.length) refuse(findings[0]!.code, findings[0]!.message);
  } else if (opts.one['--why-file']) usage('--why-file applies only to a member override');
  if (result.autos.length || result.pending.length) {
    answer.refusal_baseline = [...baselineOf(checkProject(dir,project,{now}))].map(([key,count]) => {
      const [code,path] = JSON.parse(key) as [string,string];
      return {code,path,count};
    });
  }
  validateChoice(dir,project,item,answer);
  return { item, answer, correction };
}

function applyInterviewAnswer(dir: string, next: JsonObject, draft: AnswerDraft): void {
  const item = itemAt(next, dir, draft.item.id);
  if (item.raw !== null && item.raw !== undefined) {
    const prior = [item.raw];
    if (isObject(item.raw) && item.raw.basis === 'inherited' && (item.state.state === 'user' || item.state.state === 'delegated')) prior.push(structuredClone(item.state.answer));
    item.record.history = [...asArray(item.record.history),...prior];
  }
  item.record[item.kind === 'framing' ? 'answer' : 'guide'] = draft.answer;
  delete item.record.pending_options;
}

function closeInterviewComment(args: string[], now: number): string {
  if (args.indexOf('--close-comment') !== args.lastIndexOf('--close-comment')) usage('duplicate --close-comment');
  const { positional, one } = parse(args.filter(arg => arg !== '--close-comment'),
    ['--job', '--act', '--order', '--by', '--reason-file', '--resolved-by-answer']);
  const [question, directory] = positional;
  const jobId = one['--job'];
  const actId = one['--act'];
  const orderText = one['--order'];
  const reasonFile = one['--reason-file'];
  if (!question || positional.length > 2 || !jobId || !actId || !orderText || !one['--by'] || !reasonFile) {
    usage('--close-comment requires a source question, --job, --act, --order, --by agent and --reason-file');
  }
  if (one['--by'] !== 'agent') refuse('INTERVIEW_COMMENT_CLOSURE_INVALID', 'project.json.interview_comment_closures: name the agent with --by agent');
  const order = /^[1-9]\d*$/.test(orderText) ? Number(orderText) : NaN;
  const reason = readVerbatim(reasonFile);
  const dir = resolve(directory ?? process.cwd());
  const release = acquireBoundJobWrite(dir, { kind: 'record-only', writer: 'interview' });
  try {
    const { file, project, bytes } = readProject(dir);
    const { row, replay } = prepareInterviewCommentClosure(dir, project, now, { jobId, actId, question, order }, reason, one['--resolved-by-answer']);
    if (!replay) {
      const next = { ...project, interview_comment_closures: [...asArray(project.interview_comment_closures), row] };
      save(file, dir, project, next, now, [], [], bytes);
    }
    return JSON.stringify(row);
  } finally { release(); }
}

const INTERVIEW_OWNER_CHAT_REMEDY = 'interview-answer <question> --set <id> --sha256 <hash> --pick <option> --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>';

function refusePostOwnerChoice(id: string): never {
  const relay = INTERVIEW_OWNER_CHAT_REMEDY.replace('<question>', id).replace('<option>', `${id}=<option>`);
  refuse('POST_OWNER_CHOICE_REQUIRED', `interview.post.items[${id}].guide: register a set with interview-options ${id}, ask the owner in chat for a concrete choice, then relay it with ${relay}`);
}

export function interviewAnswerCommand(args: string[], now: number): string { return run(() => {
  if (args.some(arg => arg === '--batch' || arg.startsWith('--batch='))) {
    refuse('SIGNOFF_FROM_REVIEW_REMOVED', `project.json.interview: interview-answer --batch and --from-review were removed; relay the owner's answer with ${INTERVIEW_OWNER_CHAT_REMEDY}`, USAGE_EXIT);
  }
  if (args.some(arg => arg === '--from-review' || arg.startsWith('--from-review='))) {
    refuse('SIGNOFF_FROM_REVIEW_REMOVED', `project.json.interview: interview-answer --from-review was removed; relay the owner's answer with ${INTERVIEW_OWNER_CHAT_REMEDY}`, USAGE_EXIT);
  }
  if (args.includes('--close-comment')) return closeInterviewComment(args, now);
  if (args.includes('--picks-file')) refuse('INTERVIEW_PICKS_FILE_REMOVED', `project.json: --picks-file was removed; relay the owner's answer with ${INTERVIEW_OWNER_CHAT_REMEDY}`, USAGE_EXIT);
  const opts = parse(args,['--set','--sha256','--by','--note-file','--source','--why-file',...OWNER_CHAT_FLAGS],['--pick','--other','--other-fragment']);
  if (opts.positional.length > 2 || !opts.one['--set'] || !opts.one['--sha256'] || !opts.one['--by']) usage('question and --set/--sha256/--by required');
  if (opts.one['--owner-chat'] !== undefined && opts.one['--by']?.toLowerCase() === 'agent') refuse('INTERVIEW_CHOICE_INVALID', 'project.json.interview: --by must name the owner; relay owner words without claiming agent authority');
  const chat = readOwnerChat(opts.one, opts.one['--by'], now, 'project.json.interview');
  const dir = resolve(opts.positional[1] ?? process.cwd());
  const release = acquireBoundJobWrite(dir, { kind: 'record-only', writer: 'interview' });
  try {
    const {file,project} = readProject(dir);
    const original = readFileSync(file);
    // The parsed record and the hash must describe the same snapshot.
    let captured: unknown;
    try { captured = JSON.parse(original.toString('utf8')); } catch { /* The record changed during the read. */ }
    if (!equal(project, captured)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during interview read; retry against the current job');
    const singleItem = itemAt(project, dir, opts.positional[0]);
    const draft = prepareInterviewAnswer(dir, project, singleItem, opts, now, chat);
    const next = structuredClone(project);
    assertTurnBody(draft.item.id, draft.answer, draft.item.path);
    applyInterviewAnswer(dir, next, draft);
    save(file,dir,project,next,now,[],[{ id: draft.item.id, correction: draft.correction }],original);
    return JSON.stringify(draft.answer);
  } finally { release(); }
}); }

/** Asks a waypoint's step-plan value covers, filtered as ask coverage filters them. */
function stepPlanAsks(dir: string, project: JsonObject, item: Item, value: Json): JsonObject[] | undefined {
  const asks = item.kind === 'waypoint' ? WAYPOINT_ASKS[item.id] : undefined;
  if (asks === undefined) return undefined;
  const rig = collectItems(project, { collection: loadCollection(dir) }).find(i => i.id === 'rig_type')?.state;
  const rigValue = rig?.state === 'user' ? rig.answer.value
    : rig?.state === 'delegated' && isObject(rig.answer.agent_decision) ? rig.answer.agent_decision.value : null;
  const visible = isObject(value) && value.project === 'visible';
  return asks.filter(ask => (ask.id !== 'ground' || item.id !== 'assemble' || visible)
    && (ask.required_for === undefined || (ask.required_for === 'fullscreen.game_logic' ? rigValue === 'fullscreen.game_logic' : rigValue !== 'fullscreen.game_logic')))
    .map(ask => ({ id: ask.id, state: 'delegated' }));
}

/** A value code reads, delegated under the current step plan; the plan's prose states it (STEP_PLAN_VALUE_UNSAID). */
function stepPlanDecision(opts: Args, now: number): string {
  if (opts.many['--fragment'] || !opts.one['--plan-quote-file']) usage('a step plan value takes --value-file and --plan-quote-file, without --fragment');
  const dir = resolve(opts.positional[1] ?? process.cwd());
  const release = acquireBoundJobWrite(dir, { kind: 'record-only', writer: 'interview' });
  try {
    const {file,project} = readProject(dir); const next = structuredClone(project);
    const item = itemAt(next,dir,opts.positional[0]);
    if (!VALUE_QUESTIONS.includes(item.id)) usage(`${item.id}: no code reads its value; under a step plan it stays unanswered`);
    const step = planStepOfGuide(item.id, item.kind === 'post'); const plan = currentStepPlan(next, step);
    if (!plan) refuse('STEP_PLAN_MISSING', `${item.path}: propose the ${step} plan with plan propose ${step} before recording its values`);
    const prior = item.state.state === 'silent' ? undefined : isObject(item.raw) && stepPlanValue(next, item, item.raw) ? item.raw : null;
    if (prior === null) refuse('INTERVIEW_CHOICE_INVALID', `${item.path}: already answered; a step plan value fills only a silent question`);
    checkNewAnswer(dir,next,item);
    const quote = readText(opts.one['--plan-quote-file'] as string).trim(); if (!quote) usage('--plan-quote-file is empty');
    const reasoning = readText(opts.one['--reasoning-file'] as string); const value = jsonFile(opts.one['--value-file'] as string);
    const at = new Date(now).toISOString(); const by = opts.one['--by'] as string; const asks = stepPlanAsks(dir,next,item,value);
    const answer: JsonObject = { delegated: true, by, at, source: STEP_PLAN_SOURCE, step_plan: { step, sha256: plan.sha256 as string }, plan_quote: quote,
      ...(asks ? { asks } : {}), agent_decision: { by, at, reasoning, value } };
    if (prior) item.record.history = [...asArray(item.record.history), prior];
    item.record[item.kind === 'framing' ? 'answer' : 'guide'] = answer;
    // Like every other answer writer: steps resting on the new value are marked for revision, not refused.
    save(file,dir,project,next,now,[],[{ id: item.id, correction: false }]); return JSON.stringify(answer);
  } finally { release(); }
}

export function interviewDecisionCommand(args: string[], now: number): string { return run(() => {
  const opts = parse(args,['--by','--reasoning-file','--value-file','--plan-quote-file'],['--fragment']);
  if (opts.positional.length > 2 || !opts.one['--by'] || !opts.one['--reasoning-file']) usage('question, --by and --reasoning-file required');
  const question = opts.positional[0];
  if (question !== undefined && SECTIONLESS_POST_ITEMS.includes(question)) refusePostOwnerChoice(question);
  if (opts.one['--value-file'] !== undefined) return stepPlanDecision(opts, now);
  if (opts.one['--plan-quote-file'] !== undefined) usage('--plan-quote-file goes with --value-file');
  const dir = resolve(opts.positional[1] ?? process.cwd());
  const release = acquireBoundJobWrite(dir, { kind: 'record-only', writer: 'interview' });
  try {
    const {file,project} = readProject(dir); const next = structuredClone(project);
    const item = itemAt(next,dir,opts.positional[0]); checkNewAnswer(dir,next,item);
    if (!isObject(item.raw) || !isObject(item.raw.choice)) refuse('INTERVIEW_CHOICE_INVALID',`${item.path}: explicitly choose auto before writing a decision`);
    const {set} = optionFile(dir,item.raw.choice.set); validateContext(dir,next,set,now,true);
    const result = selection(set,item.raw.choice); const supplied = opts.many['--fragment'] ?? new Map<string,string>();
    if (!result.autos.length || supplied.size !== result.autos.length || [...supplied.keys()].some(k => !result.autos.includes(k))) usage('supply exactly the auto asks with --fragment');
    const fragments = result.autos.map(ask => ({ask,fragment:jsonFile(supplied.get(ask) as string)}));
    const pending = isObject(item.raw.agent_decision) && equal(Object.keys(item.raw.agent_decision),['covers']);
    const baseline = pending ? refusalBaseline(item.raw) : [];
    item.raw.agent_decision = {by:opts.one['--by'],at:new Date(now).toISOString(),reasoning:readText(opts.one['--reasoning-file']),covers:result.autos.join(','),fragments,value:assembleFragments(String((set.assembly as JsonObject).rule),fragments.map(f=>f.fragment))};
    assertTurnBody(item.id,{agent_decision:item.raw.agent_decision},item.path);
    validateChoice(dir,next,item,item.raw); save(file,dir,project,next,now,baseline,[{id:item.id,correction:false}]); return JSON.stringify(item.raw.agent_decision);
  } finally { release(); }
}); }
