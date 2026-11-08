import { overrideFindings } from './overrides.ts';
import { intakeItem, intakeWarnings, INTAKE_QUESTION } from './intake.ts';
/** Public record writers; validation precedes every project write. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { asArray, checkProject, collectItems, collectSignoffs, isObject, loadCollection, collectionAnswer, type Item } from './check.ts';
import { approvalStageOfGuide } from './stages.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { readProject } from './feedback.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { countFindings, findingKey, newFindings } from './refusal-baseline.ts';
import { CHOICE_ORDER_SPEC, CHOICE_SPEC, ChoiceError, assembleFragments, choiceAdoption, choiceVerbatim, literalFile, optionFile, refusalBaseline, selection, sha256, validateChoice, validateContext, validateSet } from './choices.ts';
import type { Json, JsonObject } from './templates.ts';

export const CHOICE_HELP = `interview-options <question> [<dir>] --file <retained project-relative JSON>
interview-options --adopt [<dir>]
interview-answer <question> [<dir>] --set <path> --sha256 <shown sha> --by <human>
  [--picks-file <project-relative review JSON> | --pick <ask>=<option>...] [--other <ask>=<file> --other-fragment <ask>=<JSON file>]...
  [--note-file <file>] [--source <location>] [--why-file <file> for a member override]
interview-decision <question> [<dir>] --by <agent> --reasoning-file <file>
  --fragment <ask>=<JSON file>...
Retain the shown set first. Each ask is picked explicitly; no recommended option is preselected.`;
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
  try { return action(); } catch (e) { if (e instanceof ChoiceError) refuse(e.code, `interview: ${e.message}; retain the shown set and explicitly record each ask`); throw e; }
}
/** Partial interviews may retain unrelated pre-existing refusals, but a writer cannot add a new one. */
export function save(file: string, dir: string, original: JsonObject, candidate: JsonObject, now: number, baseline: JsonObject[] = []): void {
  const counts = countFindings(checkProject(dir,original,{now}).refusals);
  for (const f of baseline) {
    const k = findingKey({ code: String(f.code), path: String(f.path) });
    counts.set(k,Math.max(counts.get(k) ?? 0,Number(f.count)));
  }
  const first = newFindings(counts,checkProject(dir,candidate,{now}).refusals)[0];
  if (first) refuse(first.code,first.message);
  const tmp = join(dirname(file), `.interview-${process.pid}-${crypto.randomUUID()}.tmp`);
  writeFileSync(tmp,`${JSON.stringify(candidate,null,2)}\n`, { flag: 'wx' }); renameSync(tmp,file);
}
function checkNewAnswer(dir: string, project: JsonObject, item: Item): void {
  if (item.path === 'intake.choice.answer') {
    if (choiceAdoption(project) === null) refuse('INTERVIEW_CHOICE_REQUIRED', 'intake.choice: adopt choices before recording a new choice');
    return;
  }
  const stage = approvalStageOfGuide(item.id,item.kind === 'post',true);
  const reopens = collectReopens(project,[]);
  if (collectSignoffs(project,[]).some(s => s.stage === stage && s.checkpoint === null && liveSignoff(reopens,s.stage,s.at))) refuse('INTERVIEW_CHOICE_INVALID', `${item.path}: approval is still live; reopen ${stage === 'plan-approved' ? 'interview' : stage} before changing this answer`);
  if (choiceAdoption(project) === null) refuse('INTERVIEW_CHOICE_REQUIRED', `${item.path}: adopt order@2 with interview-options --adopt before recording new choices`);
  if (isObject(item.raw) && item.raw.basis === 'inherited') {
    // This changes the local member record, never its resolved collection source.
    if (!loadCollection(dir)) refuse('INTERVIEW_CHOICE_INVALID', `${item.path}: collection source unavailable; restore it before recording a member-local choice`);
  }
}

export function interviewOptionsCommand(args: string[], now: number): string { return run(() => {
  const opts = parse(args,['--file','--adopt']);
  if (opts.adopt) {
    if (opts.positional.length > 1 || Object.keys(opts.one).length) usage('--adopt takes only a project folder');
    const dir = resolve(opts.positional[0] ?? process.cwd()); const {file,project} = readProject(dir); const next = structuredClone(project);
    const interview = isObject(next.interview) ? next.interview : null;
    if (!interview || !isObject(interview.order) || !['rig-create/stage-order@1', CHOICE_ORDER_SPEC].includes(String(interview.order.spec))) refuse('INTERVIEW_CHOICE_INVALID','interview.order: first adopt the split stage order with a fresh parts/rigging interview; then adopt choices');
    if (interview.order.spec === CHOICE_ORDER_SPEC) return 'interview: choices already adopted; original dates preserved';
    interview.order = {...interview.order,spec:CHOICE_ORDER_SPEC,choices_adopted_at:new Date(now).toISOString()};
    save(file,dir,project,next,now); return 'interview: choices adopted; earlier answers preserved';
  }
  if (opts.positional.length > 2 || !opts.one['--file']) usage('question and --file required');
  const dir = resolve(opts.positional[1] ?? process.cwd()); const {file,project} = readProject(dir); const next = structuredClone(project);
  const item = itemAt(next,dir,opts.positional[0]); const path = opts.one['--file'];
  let binding: JsonObject;
  try { binding = {path,sha256:sha256(readFileSync(literalFile(dir,path)))}; } catch (e) { throw new ChoiceError('INTERVIEW_OPTIONS_FILE',String(e)); }
  const {set} = optionFile(dir,binding); validateSet(next,item,set,loadCollection(dir)); validateContext(dir,next,set,now,true);
  if (choiceAdoption(next) === null) refuse('INTERVIEW_CHOICE_REQUIRED',`${item.path}: adopt choices before drafting a new question`);
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
}); }

export function interviewAnswerCommand(args: string[], now: number): string { return run(() => {
  const opts = parse(args,['--set','--sha256','--by','--note-file','--source','--picks-file','--why-file'],['--pick','--other','--other-fragment']);
  if (opts.positional.length > 2 || (!opts.one['--picks-file'] && (!opts.one['--set'] || !opts.one['--sha256'] || !opts.one['--by']))) usage('question and --picks-file, or --set/--sha256/--by required');
  const dir = resolve(opts.positional[1] ?? process.cwd()); const {file,project} = readProject(dir); const next = structuredClone(project);
  const item = itemAt(next,dir,opts.positional[0]); checkNewAnswer(dir,next,item);
  let payload: JsonObject | null = null;
  if (opts.one['--picks-file']) {
    if (Object.keys(opts.many).length || opts.one['--note-file']) usage('--picks-file is exclusive with pick/Other/note flags');
    try {
      const parsed: Json = JSON.parse(readFileSync(literalFile(dir,opts.one['--picks-file']),'utf8'));
      if (!isObject(parsed) || Object.keys(parsed).some(k => !['schema','set','picks','note','by','at'].includes(k)) || parsed.schema !== 'rig-review/interview-picks@1'
        || !isObject(parsed.set) || Object.keys(parsed.set).some(k => !['path','sha256'].includes(k)) || typeof parsed.set.path !== 'string' || typeof parsed.set.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.set.sha256)
        || !Array.isArray(parsed.picks) || parsed.by !== 'user' || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || Date.parse(parsed.at) > now
        || (parsed.note !== undefined && typeof parsed.note !== 'string') || parsed.picks.some(p => !isObject(p) || Object.keys(p).some(k => !['ask','option_id','other_text'].includes(k)) || typeof p.ask !== 'string' || typeof p.option_id !== 'string' || (p.other_text !== undefined && typeof p.other_text !== 'string'))) throw Error('invalid picks payload fields');
      literalFile(dir,parsed.set.path);
      payload = parsed;
    } catch (e) { throw new ChoiceError('INTERVIEW_CHOICE_INVALID',`picks file: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const binding = payload ? payload.set as JsonObject : {path:opts.one['--set'] as string,sha256:opts.one['--sha256'] as string};
  const registered = item.record.pending_options;
  if (isObject(registered) && binding.sha256 !== registered.sha256) refuse('INTERVIEW_OPTIONS_STALE',`${item.path}: displayed set sha differs from the registered set; refresh the questionnaire`);
  if (payload && ((opts.one['--set'] && opts.one['--set'] !== binding.path) || (opts.one['--sha256'] && opts.one['--sha256'] !== binding.sha256))) refuse('INTERVIEW_OPTIONS_STALE',`${item.path}: picks file set differs from the displayed set; refresh the questionnaire`);
  if (payload && opts.one['--by'] && opts.one['--by'] !== payload.by) usage('--by differs from picks file human identity');
  if (!equal(registered,binding)) refuse('INTERVIEW_CHOICE_INVALID',`${item.path}: displayed set is not the registered pending set; register/refresh the shown options`);
  const {set} = optionFile(dir,binding); validateSet(next,item,set,loadCollection(dir)); validateContext(dir,next,set,now,true);
  const offered = asArray(set.asks).filter(isObject);
  const filePicks = payload ? (payload.picks as Json[]).filter(isObject) : null;
  const selected = filePicks ? new Map(filePicks.map(p => [String(p.ask),String(p.option_id)])) : opts.many['--pick'] ?? new Map<string,string>();
  if (selected.size !== offered.length || [...selected.keys()].some(k => !offered.some(a => a.id === k)) || (filePicks && !equal(filePicks.map(p=>p.ask),offered.map(a=>a.id)))) throw new ChoiceError('INTERVIEW_CHOICE_INVALID','pick exactly once per applicable ask in questionnaire order');
  const picks: JsonObject[] = offered.map(ask => {
    const option = asArray(ask.options).filter(isObject).find(o => o.id === selected.get(String(ask.id)));
    if (!option) throw new ChoiceError('INTERVIEW_CHOICE_INVALID',`unknown option for ${String(ask.id)}`);
    const pick: JsonObject = {ask:ask.id as Json,option_id:option.id as Json,shown:{label:option.label as Json,effect:option.effect as Json}};
    const fromFile = filePicks?.find(p=>p.ask===ask.id);
    if (option.kind === 'other') {
      const textPath = opts.many['--other']?.get(String(ask.id)); const fragment = opts.many['--other-fragment']?.get(String(ask.id));
      const words = fromFile?.other_text ?? (textPath ? readText(textPath) : undefined);
      if (typeof words !== 'string' || !words.trim()) throw new ChoiceError('INTERVIEW_CHOICE_INVALID','Other requires exact nonempty text');
      pick.other_text = words;
      if (fragment) pick.other_fragment = jsonFile(fragment);
    } else if (fromFile?.other_text !== undefined) throw new ChoiceError('INTERVIEW_CHOICE_INVALID','other_text is only for Other');
    return pick;
  });
  for (const flag of ['--other','--other-fragment']) for (const ask of opts.many[flag]?.keys() ?? []) if (!picks.some(p => p.ask === ask && 'other_text' in p)) usage(`${flag} supplied for non-Other ask ${ask}`);
  const choice: JsonObject = {spec:CHOICE_SPEC,set:binding,picks};
  if (payload?.note !== undefined) choice.note = payload.note;
  else if (opts.one['--note-file']) choice.note = readText(opts.one['--note-file']);
  const result = selection(set,choice);
  const answer: JsonObject = {delegated:result.delegated,by:payload?.by ?? opts.one['--by'],at:payload?.at ?? new Date(now).toISOString(),verbatim:choiceVerbatim(picks,choice.note),source:opts.one['--source'] ?? 'review questionnaire',choice,asks:result.asks};
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
    const baseline = new Map<string,JsonObject>();
    for (const f of checkProject(dir,project,{now}).refusals) {
      const key = `${f.code}:${f.path}`; const entry = baseline.get(key);
      if (entry) entry.count = Number(entry.count)+1;
      else baseline.set(key,{code:f.code,path:f.path,count:1});
    }
    answer.refusal_baseline = [...baseline.values()];
  }
  validateChoice(dir,next,item,answer);
  if (item.raw !== null && item.raw !== undefined) {
    const prior = [item.raw];
    if (isObject(item.raw) && item.raw.basis === 'inherited' && (item.state.state === 'user' || item.state.state === 'delegated')) prior.push(structuredClone(item.state.answer));
    item.record.history = [...asArray(item.record.history),...prior];
  }
  item.record[item.kind === 'framing' ? 'answer' : 'guide'] = answer; delete item.record.pending_options;
  save(file,dir,project,next,now); return JSON.stringify(answer);
}); }

export function interviewDecisionCommand(args: string[], now: number): string { return run(() => {
  const opts = parse(args,['--by','--reasoning-file'],['--fragment']);
  if (opts.positional.length > 2 || !opts.one['--by'] || !opts.one['--reasoning-file']) usage('question, --by and --reasoning-file required');
  const dir = resolve(opts.positional[1] ?? process.cwd()); const {file,project} = readProject(dir); const next = structuredClone(project);
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
}); }
