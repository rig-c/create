import { OWNER_CHAT_FLAGS, readOwnerChat } from './owner-chat.ts';
import { overrideFindings } from './overrides.ts';
import { intakeItem, intakeWarnings, INTAKE_QUESTION } from './intake.ts';
/** Public record writers; validation precedes every project write. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { acquireBoundJobWrite, beginJobProgress } from './job-writer.ts';
import { assertActSubjectDeclared, decodeReviewAct, fetchReviewActBytes, matchesActProjectSource, reviewActFindings, reviewActTransport, type ReviewActTransport, type InterviewPicksAct } from './review-act.ts';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { answered, asArray, checkProject, collectItems, collectSignoffs, isObject, loadCollection, collectionAnswer, type Item } from './check.ts';
import { approvalStageOfGuide } from './stages.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { readProject } from './feedback.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, findingKey, newFindings, stoppedEarly } from './refusal-baseline.ts';
import { CHOICE_ORDER_SPEC, CHOICE_SPEC, ChoiceError, assembleFragments, choiceAdoption, choiceVerbatim, literalFile, optionFile, refusalBaseline, selection, sha256, validateChoice, validateContext, validateSet } from './choices.ts';
import type { Json, JsonObject } from './templates.ts';

export const CHOICE_HELP = `interview-options <question> [<dir>] --file <retained project-relative JSON>
interview-options --adopt [<dir>]
interview-answer <question> [<dir>] --from-review <actId> [--why-file <file>]
interview-answer --batch [<dir>] --from-review <actId> [--from-review <actId> ...]
  [--why-file <question>=<file> for each member override]
interview-answer <question> [<dir>] --set <path> --sha256 <shown sha> --by <human>
  [--pick <ask>=<option>...] [--other <ask>=<file> --other-fragment <ask>=<JSON file>]...
  [--owner-chat <words file> --said-at <ISO date> --relayed-by <who>]
  [--note-file <file>] [--source <location>] [--why-file <file> for a member override]
interview-decision <question> [<dir>] --by <agent> --reasoning-file <file>
  --fragment <ask>=<JSON file>...
Retain the shown set first. Each ask is picked explicitly; no recommended option is preselected.
Write ask prompts, option labels and effects, and recommendation reasons in the owner's declared language.
To ask an answered question again, retain and register a new set id/path with
interview-options <question> --file <path>, then job open --question <question>
and ingest interview-answer <question> --from-review <actId>; history is kept.
--adopt: split-order projects adopt all choices; legacy-order projects may adopt
post choices at post-interview only. For full adoption, first adopt the split
stage order with a fresh parts/rigging interview (docs/INTERVIEW.md).`;
function usage(why: string): never { refuse('INTERVIEW_OPTIONS_USAGE', `interview: ${why}; ${CHOICE_HELP}`, USAGE_EXIT); }
interface Args { positional: string[]; one: Record<string,string>; many: Record<string,Map<string,string>>; actIds: string[]; adopt: boolean; }
function parse(args: string[], allowed: string[], repeat: string[] = [], batch = false): Args {
  const parsed: Args = { positional: [], one: {}, many: {}, actIds: [], adopt: false };
  for (let i=0;i<args.length;i++) {
    const arg = args[i] as string;
    if (arg === '--adopt' && allowed.includes(arg)) { if (parsed.adopt) usage('duplicate --adopt'); parsed.adopt = true; }
    else if (repeat.includes(arg) || allowed.includes(arg) || (batch && arg === '--from-review')) {
      const v = args[++i]; if (v === undefined || v.startsWith('--')) usage(`${arg} needs a value`);
      if (batch && arg === '--from-review') parsed.actIds.push(v);
      else if (repeat.includes(arg)) {
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
  try { return action(); } catch (e) { if (e instanceof ChoiceError) refuse(e.code, `interview: ${e.message}; retain the shown set and explicitly record each ask`); throw e; }
}
/** Partial interviews may retain unrelated pre-existing refusals, but a writer cannot add a new one. */
export function save(file: string, dir: string, original: JsonObject, candidate: JsonObject, now: number, baseline: JsonObject[] = [], correctedAnswers: readonly string[] = [], originalBytes?: Buffer): void {
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
  const unsignedAnswers = correctedAnswers.filter(id => findings.some(finding => staleBinding(finding, id)));
  const affectedSteps = new Set<string>();
  if (unsignedAnswers.length && isObject(candidate.plan)) {
    for (const step of asArray(candidate.plan.steps).filter(isObject)) {
      if (unsignedAnswers.some(id => asArray(step.rests_on).includes(id))) affectedSteps.add(`plan.steps[${String(step.id)}]`);
    }
  }
  // A guide correction can also require its already-run steps to be re-signed.
  const first = findings.find(finding => !unsignedAnswers.some(id => staleBinding(finding, id))
    && !(finding.code === 'GUIDE_CHANGED_UNSIGNED' && affectedSteps.has(finding.path)));
  if (first) refuse(first.code,first.message);
  if (originalBytes && !readFileSync(file).equals(originalBytes)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during interview validation; retry against the current job');
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
  const release = acquireBoundJobWrite(dir, { kind: 'record-only' });
  try {
    const {file,project} = readProject(dir); const next = structuredClone(project);
    if (opts.adopt) {
      const interview = isObject(next.interview) ? next.interview : null;
      if (interview && interview.order === undefined && isObject(interview.post)) {
        if (project.stage !== 'post-interview') refuse('INTERVIEW_CHOICE_INVALID', 'interview.post: for post-only choices, advance to post-interview before interview-options --adopt; for full adoption, first adopt the split stage order with a fresh parts/rigging interview (docs/INTERVIEW.md)');
        if (interview.post.choices_adopted_at !== undefined) {
          if (!Number.isFinite(Date.parse(String(interview.post.choices_adopted_at)))) refuse('INTERVIEW_CHOICE_INVALID', 'interview.post: restore the original valid choices_adopted_at');
          return 'interview: post choices already adopted; original date preserved';
        }
        interview.post.choices_adopted_at = new Date(now).toISOString();
        save(file,dir,project,next,now); return 'interview: post choices adopted; stage order and earlier answers preserved';
      }
      if (!interview || !isObject(interview.order) || !['rig-create/stage-order@1', CHOICE_ORDER_SPEC].includes(String(interview.order.spec))) refuse('INTERVIEW_CHOICE_INVALID','interview.order: first adopt the split stage order with a fresh parts/rigging interview; then adopt choices');
      if (interview.order.spec === CHOICE_ORDER_SPEC) return 'interview: choices already adopted; original dates preserved';
      interview.order = {...interview.order,spec:CHOICE_ORDER_SPEC,choices_adopted_at:new Date(now).toISOString()};
      save(file,dir,project,next,now); return 'interview: choices adopted; earlier answers preserved';
    }
    const item = itemAt(next,dir,opts.positional[0]); const path = opts.one['--file'];
    let binding: JsonObject;
    try { binding = {path,sha256:sha256(readFileSync(literalFile(dir,path)))}; } catch (e) { throw new ChoiceError('INTERVIEW_OPTIONS_FILE',String(e)); }
    const {set} = optionFile(dir,binding); validateSet(next,item,set,loadCollection(dir)); validateContext(dir,next,set,now,true);
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
    item.record.pending_options = binding; save(file,dir,project,next,now); return JSON.stringify(binding);
  } finally { release(); }
}); }

export interface InterviewAnswerHooks {
  fetch?: (transport: ReviewActTransport) => { bytes: string };
}
type FetchedInterviewAct = { act: InterviewPicksAct; bytes: string };

function fetchInterviewAct(dir: string, actId: string, now: number, hooks: InterviewAnswerHooks): FetchedInterviewAct {
  const transport: ReviewActTransport = { ...reviewActTransport(dir, actId), kind: 'interview-picks' };
  const { bytes } = hooks.fetch ? hooks.fetch(transport) : { bytes: fetchReviewActBytes(transport) };
  const act = decodeReviewAct(bytes, 'interview-picks');
  if (act.jobId !== transport.jobId || act.actId !== transport.actId || Date.parse(act.at) > now) {
    refuse('REVIEW_ACT_INVALID', 'project.json.interview: fetched identity or date differs; fetch the correct interview act');
  }
  return { act, bytes };
}

function retainedInterviewAnswer(project: JsonObject, item: Item, { act, bytes }: FetchedInterviewAct): JsonObject | undefined {
  const existing = asArray(project.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === act.actId);
  if (!existing) return;
  if (existing.bytes !== bytes) refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: immutable interview act changed; restore the original receipt');
  const retained = [item.raw,...asArray(item.record.history)].filter(isObject).find(answer => answer.at === act.at
    && sha256(Buffer.from(JSON.stringify(answer.choice))) === existing.version_hash);
  if (!retained) refuse('REVIEW_ACT_LEDGER_INVALID', `${item.path}: original interview answer is absent; restore its history`);
  return retained;
}

function reviewPicksPayload(dir: string, item: Item, act: InterviewPicksAct, original: Buffer): JsonObject {
  if (act.schema === 'rig-review/act@4') {
    assertActSubjectDeclared(dir, act, item.path);
    if (!matchesActProjectSource(act, original)) refuse('REVIEW_ACT_SOURCE_STALE', `${item.path}: displayed record differs; publish the current question again`);
    if (act.source.selection.questionId !== item.id || act.source.selection.setId !== act.source.optionSet.id) {
      refuse('REVIEW_ACT_INVALID', `${item.path}: act question or set differs from its sealed source; fetch the correct interview act`);
    }
  }
  const registered = item.record.pending_options;
  if (!isObject(registered) || registered.sha256 !== act.source.optionSet.sha256
    || (act.schema === 'rig-review/act@4' && (registered.path !== act.source.optionSetFile.path || registered.sha256 !== act.source.optionSetFile.sha256))) {
    refuse('INTERVIEW_OPTIONS_STALE', `${item.path}: displayed option set differs; refresh the questionnaire`);
  }
  const {set} = optionFile(dir,registered);
  if (set.id !== act.source.optionSet.id) refuse('INTERVIEW_OPTIONS_STALE', `${item.path}: displayed option set identity differs; refresh the questionnaire`);
  return { set: registered, picks: act.value.selections.map(row => ({ ask: row.itemId, option_id: row.optionId,
    ...(row.otherText === null ? {} : {other_text:row.otherText}) })), note: act.value.note,
    by: act.authority.reviewer.role === 'owner' ? 'user' : 'delegate', at: act.at };
}

interface AnswerDraft {
  item: Item;
  answer: JsonObject;
  correction: boolean;
  receipt?: JsonObject;
}

function prepareInterviewAnswer(
  dir: string, project: JsonObject, item: Item, opts: Args, now: number,
  chat: ReturnType<typeof readOwnerChat>, review?: FetchedInterviewAct, payload?: JsonObject,
): AnswerDraft {
  const correction = answered(item.state);
  checkNewAnswer(dir,project,item,correction);
  const binding = payload ? payload.set as JsonObject : {path:opts.one['--set'] as string,sha256:opts.one['--sha256'] as string};
  const registered = item.record.pending_options;
  if (isObject(registered) && binding.sha256 !== registered.sha256) refuse('INTERVIEW_OPTIONS_STALE',`${item.path}: displayed set sha differs from the registered set; refresh the questionnaire`);
  if (payload && ((opts.one['--set'] && opts.one['--set'] !== binding.path) || (opts.one['--sha256'] && opts.one['--sha256'] !== binding.sha256))) refuse('INTERVIEW_OPTIONS_STALE',`${item.path}: review act set differs from the displayed set; refresh the questionnaire`);
  if (payload && opts.one['--by'] && opts.one['--by'] !== payload.by) usage('--by differs from review act human identity');
  if (!equal(registered,binding)) refuse('INTERVIEW_CHOICE_INVALID',`${item.path}: displayed set is not the registered pending set; register/refresh the shown options`);
  const {set} = optionFile(dir,binding); validateSet(project,item,set,loadCollection(dir)); validateContext(dir,project,set,now,true);
  const offered = asArray(set.asks).filter(isObject);
  const reviewPicks = payload ? (payload.picks as Json[]).filter(isObject) : null;
  const selected = reviewPicks ? new Map(reviewPicks.map(p => [String(p.ask),String(p.option_id)])) : opts.many['--pick'] ?? new Map<string,string>();
  if (selected.size !== offered.length || [...selected.keys()].some(k => !offered.some(a => a.id === k)) || (reviewPicks && !equal(reviewPicks.map(p=>p.ask),offered.map(a=>a.id)))) throw new ChoiceError('INTERVIEW_CHOICE_INVALID','pick exactly once per applicable ask in questionnaire order');
  const picks: JsonObject[] = offered.map(ask => {
    const option = asArray(ask.options).filter(isObject).find(o => o.id === selected.get(String(ask.id)));
    if (!option) throw new ChoiceError('INTERVIEW_CHOICE_INVALID',`unknown option for ${String(ask.id)}`);
    const pick: JsonObject = {ask:ask.id as Json,option_id:option.id as Json,shown:{label:option.label as Json,effect:option.effect as Json}};
    const fromReview = reviewPicks?.find(p=>p.ask===ask.id);
    if (option.kind === 'other') {
      const textPath = opts.many['--other']?.get(String(ask.id)); const fragment = opts.many['--other-fragment']?.get(String(ask.id));
      const words = fromReview?.other_text ?? (textPath ? readText(textPath) : undefined);
      if (typeof words !== 'string' || !words.trim()) throw new ChoiceError('INTERVIEW_CHOICE_INVALID','Other requires exact nonempty text');
      pick.other_text = words;
      if (fragment) pick.other_fragment = jsonFile(fragment);
    } else if (fromReview?.other_text !== undefined) throw new ChoiceError('INTERVIEW_CHOICE_INVALID','other_text is only for Other');
    return pick;
  });
  for (const flag of ['--other','--other-fragment']) for (const ask of opts.many[flag]?.keys() ?? []) if (!picks.some(p => p.ask === ask && 'other_text' in p)) usage(`${flag} supplied for non-Other ask ${ask}`);
  const choice: JsonObject = {spec:CHOICE_SPEC,set:binding,picks};
  if (payload?.note !== undefined) choice.note = payload.note;
  else if (opts.one['--note-file']) choice.note = readText(opts.one['--note-file']);
  const result = selection(set,choice);
  const answer: JsonObject = {delegated:result.delegated,by:payload?.by ?? opts.one['--by'],at:payload?.at ?? new Date(now).toISOString(),verbatim:choiceVerbatim(picks,choice.note),source:opts.one['--source'] ?? 'review questionnaire',choice,asks:result.asks};
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
  return { item, answer, correction, receipt: review ? {
    schema:'rig-create/review-act@1',kind:'interview-picks',
    jobId:review.act.jobId,actId:review.act.actId,question:item.id,bytes:review.bytes,sha256:sha256(Buffer.from(review.bytes)),
    version_hash:sha256(Buffer.from(JSON.stringify(choice))),
  } : undefined };
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
  if (draft.receipt) next.review_acts = [...asArray(next.review_acts), draft.receipt];
}

export function interviewAnswerCommand(args: string[], now: number, hooks: InterviewAnswerHooks = {}): string { return run(() => {
  if (args.includes('--picks-file')) refuse('INTERVIEW_PICKS_FILE_REMOVED', 'project.json: --picks-file was removed; use interview-answer <question> --from-review <actId>', USAGE_EXIT);
  const batch = args.includes('--batch');
  if (batch && args.indexOf('--batch') !== args.lastIndexOf('--batch')) usage('duplicate --batch');
  const opts = batch ? parse(args.filter(arg => arg !== '--batch'), [], ['--why-file'], true)
    : parse(args,['--set','--sha256','--by','--note-file','--source','--from-review','--why-file',...OWNER_CHAT_FLAGS],['--pick','--other','--other-fragment']);
  if (batch) {
    if (opts.positional.length > 1 || opts.actIds.length < 1 || opts.actIds.length > 64) usage('--batch takes a project folder and 1 to 64 --from-review acts');
  } else if (opts.positional.length > 2 || (!opts.one['--from-review'] && (!opts.one['--set'] || !opts.one['--sha256'] || !opts.one['--by']))) usage('question and --from-review, or --set/--sha256/--by required');
  if (opts.one['--owner-chat'] !== undefined && opts.one['--by']?.toLowerCase() === 'agent') refuse('INTERVIEW_CHOICE_INVALID', 'project.json.interview: --by must name the owner; relay owner words without claiming agent authority');
  const chat = readOwnerChat(opts.one, opts.one['--by'] ?? '', now, 'project.json.interview');
  const dir = resolve(opts.positional[batch ? 0 : 1] ?? process.cwd());
  const actIds = batch ? opts.actIds : opts.one['--from-review'] ? [opts.one['--from-review']] : [];
  const release = acquireBoundJobWrite(dir, actIds.length ? undefined : { kind: 'record-only' });
  try {
    // The first milestone waits for the job gate: a refused write leaves the project untouched.
    const progress = actIds.length ? beginJobProgress(dir, 'ingest', 'Reading the Review interview answer') : undefined;
    const {file,project} = readProject(dir);
    const original = readFileSync(file);
    // The parsed record and the hash must describe the same snapshot.
    let captured: unknown;
    try { captured = JSON.parse(original.toString('utf8')); } catch { /* The record changed during the read. */ }
    if (!equal(project, captured)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during interview read; retry against the current job');
    const singleItem = batch ? undefined : itemAt(project, dir, opts.positional[0]);
    const drafts: AnswerDraft[] = [];
    const answers: JsonObject[] = [];
    const reasons = opts.many['--why-file'];
    if (!actIds.length) {
      drafts.push(prepareInterviewAnswer(dir, project, singleItem!, opts, now, chat));
      answers.push(drafts[0]!.answer);
    } else {
      if (!batch && (Object.keys(opts.many).length || opts.one['--note-file'])) usage('--from-review is exclusive with pick/Other/note flags');
      const invalid = reviewActFindings(project)[0];
      if (invalid) refuse(invalid.code,invalid.message);
      const questions = new Set<string>();
      let publication: string | undefined;
      for (const actId of actIds) {
        const fetched = fetchInterviewAct(dir, actId, now, hooks);
        const { act } = fetched;
        if (batch) {
          const key = JSON.stringify([act.jobId, act.publicationId]);
          if (act.schema !== 'rig-review/act@4' || (publication !== undefined && publication !== key)) {
            refuse('REVIEW_ACT_INVALID', 'project.json.interview: batch requires record acts from one job publication; list the acts with job acts');
          }
          publication = key;
          if (questions.has(act.value.questionId)) {
            refuse('JOB_OPTION_SET_DUPLICATE', 'project.json.interview: batch repeats a question; supply one Review act per question');
          }
          questions.add(act.value.questionId);
        }
        const item = singleItem ?? itemAt(project, dir, act.value.questionId);
        if (act.value.questionId !== item.id) refuse('REVIEW_ACT_INVALID', `${item.path}: fetched question differs; fetch the correct interview act`);
        const retained = retainedInterviewAnswer(project, item, fetched);
        if (retained) { answers.push(retained); continue; }
        const answerOpts = batch ? { ...opts, one: { '--why-file': reasons?.get(item.id) ?? '' } } : opts;
        const payload = reviewPicksPayload(dir, item, act, original);
        const draft = prepareInterviewAnswer(dir, project, item, answerOpts, now, chat, fetched, payload);
        drafts.push(draft);
        answers.push(draft.answer);
      }
      for (const question of reasons?.keys() ?? []) if (!questions.has(question)) usage(`--why-file supplied for question ${question} outside this batch`);
    }
    if (drafts.length) {
      const next = structuredClone(project);
      for (const draft of drafts) applyInterviewAnswer(dir, next, draft);
      save(file,dir,project,next,now,[],drafts.filter(draft => draft.correction).map(draft => draft.item.id),original);
    }
    if (actIds.length) progress?.(drafts.length ? 'Review interview answer recorded' : 'Review interview answer already recorded');
    return JSON.stringify(batch ? answers : answers[0]);
  } finally { release(); }
}); }

export function interviewDecisionCommand(args: string[], now: number): string { return run(() => {
  const opts = parse(args,['--by','--reasoning-file'],['--fragment']);
  if (opts.positional.length > 2 || !opts.one['--by'] || !opts.one['--reasoning-file']) usage('question, --by and --reasoning-file required');
  const dir = resolve(opts.positional[1] ?? process.cwd());
  const release = acquireBoundJobWrite(dir, { kind: 'record-only' });
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
    validateChoice(dir,next,item,item.raw); save(file,dir,project,next,now,baseline); return JSON.stringify(item.raw.agent_decision);
  } finally { release(); }
}); }
