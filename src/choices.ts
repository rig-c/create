import { SceneError, currentScene, sceneCurrentAt, sceneReference } from './scene.ts';
import { humanReviewVerdicts } from './review.ts';
import { intakeContext } from './intake.ts';
/** Per-ask proposals and human selections. No producer is run or measurement derived here. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { asArray, collectItems, collectSignoffs, collectionQuestion, loadCollection, isObject, type Ctx, type Finding, type Item } from './check.ts';
import { draftFileUnavailable } from './drafts.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { latestPartsApproval, structurePathIsIgnored } from './structure.ts';
import { CHOICE_ORDER_SPEC, approvalStageOfGuide, hasStageOrder, interviewStageOfGuide, stageIndex } from './stages.ts';
import { WAYPOINT_ASKS } from './waypoints.ts';
import type { Json, JsonObject } from './templates.ts';

export const OPTIONS_SPEC = 'rig-create/interview-options@1';
export const CHOICE_SPEC = 'rig-create/interview-choice@1';
export { CHOICE_ORDER_SPEC } from './stages.ts';
/** Labels legacy warnings; dates alone never adopt choices. Correct at landing. */
export const CHOICE_ANSWERS_SINCE = '2026-11-06T00:00:00Z';
/** Scene-kind option sets drafted earlier keep the rule of their day: the latest scene, current or not. */
export const SCENE_CONTEXT_SINCE = '2026-11-08T00:00:00Z';
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const text = (v: Json | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const date = (v: Json | undefined): number => typeof v === 'string' ? Date.parse(v) : NaN;
const id = (v: Json | undefined): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
const objects = (v: Json | undefined): JsonObject[] => asArray(v).filter(isObject);
export class ChoiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, why: string): never { throw new ChoiceError(code, why); }
function invalid(why: string): never { return fail('INTERVIEW_OPTIONS_INVALID', why); }
function badChoice(why: string): never { return fail('INTERVIEW_CHOICE_INVALID', why); }
export function choiceAdoption(project: JsonObject): number | null {
  const interview = isObject(project.interview) ? project.interview : {};
  if (!isObject(interview.order) || interview.order.spec !== CHOICE_ORDER_SPEC) return null;
  return date(interview.order.choices_adopted_at);
}

/** Read exact retained bytes, rejecting both lexical and canonical ignored roots. */
export function literalFile(dir: string, path: string): string {
  if (isAbsolute(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('expected literal project-relative file path');
  let file = realpathSync(dir);
  const segments = path.split('/');
  for (const [i, segment] of segments.entries()) {
    file = resolve(file, segment);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (i < segments.length-1 && !stat.isDirectory()) || (i === segments.length-1 && !stat.isFile())) throw Error('symlinks and nonregular files are not supported');
  }
  return file;
}
export function optionFile(dir: string, binding: Json | undefined): { set: JsonObject; bytes: Buffer } {
  try {
    if (!isObject(binding) || !text(binding.path) || isAbsolute(binding.path) || binding.path.split('/').some(p => !p || p === '.' || p === '..')
      || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256)) throw Error('expected retained project-relative path and raw sha256');
    const file = literalFile(dir, binding.path);
    const rel = relative(realpathSync(dir), realpathSync(file));
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || structurePathIsIgnored(dir, binding.path) || !lstatSync(file).isFile()) throw Error('expected retained regular file within the project');
    const bytes = readFileSync(file);
    if (sha256(bytes) !== binding.sha256) throw Error('retained option bytes changed');
    const parsed: Json = JSON.parse(bytes.toString('utf8'));
    if (!isObject(parsed)) throw Error('expected option object');
    return { set: parsed, bytes };
  } catch (e) { fail('INTERVIEW_OPTIONS_FILE', `${e instanceof Error ? e.message : String(e)}; restore the original retained option file`); }
}

function resolvedValue(project: JsonObject, question: string, collection: JsonObject | null = null): Json | undefined {
  const item = collectItems(project, { collection }).find(i => i.id === question);
  if (item?.state.state === 'user') return item.state.answer.value;
  if (item?.state.state === 'delegated' && isObject(item.state.answer.agent_decision)) return item.state.answer.agent_decision.value;
  return undefined;
}
/** Ground is applicable if any offered projection can choose visible; a core pick must explicitly constrain it. */
export function applicableAsks(project: JsonObject, item: Item, set?: JsonObject, collection: JsonObject | null = null): string[] {
  if (item.kind !== 'waypoint') return [item.id];
  const rig = resolvedValue(project, 'rig_type',collection);
  const projection = objects(set?.asks).find(a => a.id === 'projection');
  const offeredVisible = objects(projection?.options).some(o => isObject(o.fragment) && o.fragment.project === 'visible');
  const currentAssemble = resolvedValue(project, 'assemble',collection);
  return (WAYPOINT_ASKS[item.id] ?? []).filter(a => (a.required_for === undefined || (a.required_for === 'fullscreen.game_logic' ? rig === 'fullscreen.game_logic' : rig !== 'fullscreen.game_logic'))
    && (a.id !== 'ground' || item.id !== 'assemble' || offeredVisible || (isObject(currentAssemble) && currentAssemble.project === 'visible'))).map(a => a.id);
}

export function assembleFragments(rule: string, fragments: Json[]): Json {
  if (rule === 'single') {
    if (fragments.length !== 1) badChoice('single needs exactly one contribution');
    return fragments[0] as Json;
  }
  if (rule === 'concat') {
    if (fragments.some(f => !Array.isArray(f))) badChoice('concat contributions must be arrays');
    return fragments.flatMap(f => f as Json[]);
  }
  if (rule === 'merge') {
    const result: JsonObject = {};
    for (const fragment of fragments) {
      if (!isObject(fragment)) badChoice('merge contributions must be objects');
      for (const [key, value] of Object.entries(fragment)) {
        if (Object.hasOwn(result, key)) badChoice(`merge key collision: ${key}`);
        Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    return result;
  }
  return invalid('assembly.rule must be single, concat or merge');
}

export function validateSet(project: JsonObject, item: Item, set: JsonObject, collection: JsonObject | null = null): void {
  if (set.schema !== OPTIONS_SPEC || !id(set.id) || set.question !== item.id || set.stage !== (item.path === 'intake.choice.answer' ? 'parts' : interviewStageOfGuide(item.id, item.kind === 'post', hasStageOrder(project)))
    || !text(set.drafted_by) || !Number.isFinite(date(set.drafted_at)) || !isObject(set.context) || !Array.isArray(set.asks)
    || !isObject(set.assembly) || !['single', 'concat', 'merge'].includes(String(set.assembly.rule))) invalid('set identity, author, clock, question, stage, context, asks and assembly are required');
  const asks = objects(set.asks);
  const expected = applicableAsks(project, item, set,collection);
  if (asks.length !== set.asks.length || !equal(asks.map(a => a.id), expected) || (set.assembly.rule === 'single' && asks.length !== 1)) invalid('asks must list exactly the applicable asks in questionnaire order; single is only for one ask');
  for (const ask of asks) {
    const options = objects(ask.options);
    if (!text(ask.prompt) || !Array.isArray(ask.options) || options.length !== ask.options.length || new Set(options.map(o => o.id)).size !== options.length) invalid('each ask needs prompt and unique option ids');
    let recommended = 0;
    for (const option of options) {
      if (!id(option.id) || !text(option.label) || !text(option.effect) || typeof option.recommended !== 'boolean' || !['value', 'other', 'auto'].includes(String(option.kind))) invalid('option needs id, kind, label, effect and explicit recommended boolean');
      if (option.kind === 'value') {
        if (!('fragment' in option)) invalid('value options require fragment');
        if ((set.assembly.rule === 'concat' && !Array.isArray(option.fragment)) || (set.assembly.rule === 'merge' && !isObject(option.fragment))) invalid('fragment type does not match assembly rule');
      } else if ('fragment' in option || option.recommended) invalid('Other and auto have no preset fragment and cannot be recommended');
      if (option.recommended) { recommended++; if (!text(option.reason)) invalid('recommended option requires a reason'); }
    }
    if (recommended !== 1 || options.filter(o => o.kind === 'value').length < 2 || options.filter(o => o.kind === 'other').length !== 1 || options.filter(o => o.kind === 'auto').length !== 1) invalid('each ask needs two value options, one recommendation, one Other and one auto');
  }
  if (set.constraints !== undefined) {
    if (!Array.isArray(set.constraints)) invalid('constraints must be a list');
    for (const constraint of set.constraints) {
      if (!isObject(constraint) || !Array.isArray(constraint.asks) || constraint.asks.length < 2 || new Set(constraint.asks).size !== constraint.asks.length
        || constraint.asks.some(a => typeof a !== 'string' || !expected.includes(a)) || !Array.isArray(constraint.allowed) || !constraint.allowed.length) invalid('constraint needs distinct known asks and allowed tuples');
      for (const tuple of constraint.allowed) {
        if (!Array.isArray(tuple) || tuple.length !== constraint.asks.length || tuple.some((opt, i) => !objects(asks.find(a => a.id === (constraint.asks as Json[])[i])?.options).some(o => o.kind === 'value' && o.id === opt))) invalid('constraint tuple must name a value option on each corresponding ask');
      }
    }
  }
}

/**
 * A context is a projection of existing identities, never a producer report reconstructed by create.
 * A post set takes the scene kind only while the scene is current at `at`, which reads the scene
 * document under `dir`; `legacyScene` is the rule before SCENE_CONTEXT_SINCE, where any latest scene was taken.
 */
export function optionContext(project: JsonObject, stage: string, at: number, dir?: string, legacyScene = false): JsonObject {
  if (stage === 'parts') {
    try { return intakeContext(project, at); } catch (e) { fail('INTERVIEW_OPTIONS_STALE', `${String(e)}; record the preflight before showing options`); }
  }
  const reopens = collectReopens(project, []).filter(r => r.at <= at);
  if (stage === 'interview') {
    const files = objects(project.inputs).filter(f => f.at === undefined || date(f.at) <= at).map(f => ({ path: f.path as Json, sha256: f.sha256 as Json }));
    if (!files.length) fail('INTERVIEW_OPTIONS_STALE', 'source inputs must be recorded before drafting options');
    return { kind: 'inputs', files };
  }
  if (stage === 'rigging-interview') {
    const approval = latestPartsApproval(project, at);
    const draft = objects(project.drafts).find(d => d.id === approval?.draft_id);
    if (!approval || !draft || date(draft.at) > at || !isObject(approval.evidence) || !isObject(approval.structure) || !isObject(draft.parts)) fail('INTERVIEW_OPTIONS_STALE', 'review and retain parts/structure before drafting rigging options');
    return { kind: 'parts', accepted_parts: { signoff_at: approval.at as Json, evidence: approval.evidence }, structure: approval.structure, draft_id: draft.id as Json, parts: draft.parts };
  }
  try {
    const candidate = currentScene(project, at);
    if (candidate && !legacyScene && dir === undefined) fail('INTERVIEW_OPTIONS_STALE', `${String(candidate.path)}: the scene's currentness needs the project folder; pass dir to optionContext`);
    const scene = legacyScene || !candidate ? candidate : sceneCurrentAt(dir!, project, at);
    if (scene) return { kind: 'scene', scene: sceneReference(scene) };
  } catch (error) {
    if (error instanceof SceneError) fail('INTERVIEW_OPTIONS_STALE', error.message);
    throw error;
  }
  const signoff = collectSignoffs(project, []).filter(s => s.stage === 'rig-review' && s.checkpoint === null && s.at <= at && liveSignoff(reopens, s.stage, s.at)).sort((a,b) => b.at - a.at)[0];
  const rigs = objects(project.versions).filter(v => v.kind === 'rig' && date(v.at) <= at && liveSignoff(reopens, 'rig-review', date(v.at)))
    .filter(v => { const verdicts = humanReviewVerdicts(v.verdicts, 'rig-review').map(v => v.record).filter(d => date(d.at) <= at); return verdicts.at(-1)?.verdict === 'accepted'; }).sort((a,b) => Number(b.n) - Number(a.n));
  const rig = rigs[0];
  const provenance = isObject(rig?.provenance) ? rig.provenance : {};
  if (!signoff || !rig || !isObject(provenance.config)) fail('INTERVIEW_OPTIONS_STALE', 'accept a rig with retained config before drafting post options');
  const approval = latestPartsApproval(project, date(rig.at));
  const draft = objects(project.drafts).find(d => d.id === approval?.draft_id);
  if (!draft || !isObject(draft.parts)) fail('INTERVIEW_OPTIONS_STALE', 'retain the accepted rig parts identity before drafting post options');
  return { kind: 'rig', rig_version: rig.n as Json, signoff_at: signoff.record.at as Json, config: provenance.config, parts: draft.parts };
}

function verifyBinding(dir: string, binding: Json, fresh: boolean): void {
  if (!isObject(binding) || !text(binding.path) || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256) || isAbsolute(binding.path)) fail('INTERVIEW_OPTIONS_STALE', 'invalid context file binding');
  try {
    if (binding.path.startsWith('derived/drafts/')) {
      const root = binding.path.split('/').slice(0,3).join('/');
      if (draftFileUnavailable(dir, binding.path, root)) { if (fresh) throw Error('viewed draft bytes unavailable'); else return; }
    }
    const file = literalFile(dir, binding.path);
    const rel = relative(realpathSync(dir), realpathSync(file));
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !lstatSync(file).isFile() || sha256(readFileSync(file)) !== binding.sha256) throw Error('context file changed or escaped');
  } catch (e) { fail('INTERVIEW_OPTIONS_STALE', `${String(binding.path)}: ${e instanceof Error ? e.message : String(e)}; redraft against current retained context`); }
}
/** `warn` receives the reason when a set drafted before SCENE_CONTEXT_SINCE holds only under that day's rule. */
export function validateContext(dir: string, project: JsonObject, set: JsonObject, at: number, fresh = false, warn?: (why: string) => void): void {
  const drafted = date(set.drafted_at);
  if (!Number.isFinite(at) || drafted > at) fail('INTERVIEW_OPTIONS_STALE','selection must follow drafting; redraft against current accepted inputs');
  const contextProject = isObject(set.context) && set.context.kind === 'rig' ? { ...project, scenes: [] } : project;
  if (isObject(set.context) && set.context.kind === 'inputs' && !fresh) {
    // Inputs are append-only and older declarations need not carry their own clock.
    // A later additional input must not rewrite which immutable input an earlier person saw.
    const declared = objects(project.inputs);
    if (!Array.isArray(set.context.files) || !set.context.files.length || set.context.files.some(f => !isObject(f) || !declared.some(d => d.path === f.path && d.sha256 === f.sha256 && (d.at === undefined || date(d.at) <= drafted)))) fail('INTERVIEW_OPTIONS_STALE','shown source identity is no longer declared; restore the original inputs');
  } else {
    const live = (legacyScene: boolean): void => {
      if (!equal(optionContext(contextProject, String(set.stage), drafted, dir, legacyScene), set.context) || !equal(optionContext(contextProject, String(set.stage), at, dir, legacyScene), set.context)) fail('INTERVIEW_OPTIONS_STALE', 'options no longer match the live context; redraft against current accepted inputs');
    };
    if (!isObject(set.context) || set.context.kind !== 'scene' || !(drafted < Date.parse(SCENE_CONTEXT_SINCE))) live(false);
    else {
      try { live(false); }
      catch (error) {
        if (!(error instanceof ChoiceError)) throw error;
        live(true);
        warn?.(`drafted before ${SCENE_CONTEXT_SINCE} on a scene that was not current (${error.message})`);
      }
    }
  }
  if (collectReopens(project, []).some(r => r.at > drafted && r.at <= at && stageIndex(r.stage) <= stageIndex(String(set.stage)))) fail('INTERVIEW_OPTIONS_STALE', 'context was reopened after drafting; redraft the option set');
  for (const file of optionContextFiles(set.context as JsonObject)) verifyBinding(dir, file, fresh);
}

/** The exact retained bindings read by validateContext, shared with publication. */
export function optionContextFiles(context: JsonObject): Json[] {
  const files: Json[] = [...(context.kind === 'inputs' ? asArray(context.files) : isObject(context.parts) ? asArray(context.parts.files) : [])];
  if (context.kind === 'parts') files.push(context.structure as Json, (context.accepted_parts as JsonObject).evidence as Json);
  if (context.kind === 'rig') files.push(context.config as Json);
  if (context.kind === 'scene') {
    if (!isObject(context.scene)) fail('INTERVIEW_OPTIONS_STALE', 'retain the scene reference');
    files.push({ path: context.scene.path as Json, sha256: context.scene.sha256 as Json });
  }
  if (context.kind === 'intake') files.push(context.report as Json);
  return files;
}

export function choiceVerbatim(picks: JsonObject[], note?: Json): string {
  const body = picks.map(p => { const shown = p.shown as JsonObject; return `${String(shown.label)}\n${String(shown.effect)}${p.other_text === undefined ? '' : `\n${String(p.other_text)}`}`; }).join('\n\n');
  return body + (note === undefined ? '' : `\n${String(note)}`);
}

export interface Selection { value?: Json; delegated: boolean; asks: JsonObject[]; autos: string[]; pending: string[]; fragments: Map<string, Json>; }
export function selection(set: JsonObject, choice: JsonObject): Selection {
  if (choice.spec !== CHOICE_SPEC || !Array.isArray(choice.picks) || (choice.note !== undefined && typeof choice.note !== 'string')) badChoice('choice needs spec, ordered picks and optional exact note');
  const asks = objects(set.asks); const picks = objects(choice.picks);
  if (picks.length !== choice.picks.length || !equal(picks.map(p => p.ask), asks.map(a => a.id))) badChoice('pick exactly once per ask in questionnaire order');
  const fragments = new Map<string, Json>(); const autos: string[] = []; const pending: string[] = []; const coverage: JsonObject[] = [];
  for (const [i, pick] of picks.entries()) {
    const ask = asks[i] as JsonObject; const option = objects(ask.options).find(o => o.id === pick.option_id);
    if (!option || !equal(pick.shown, { label: option.label, effect: option.effect })) badChoice('unknown pick or shown text differs from the retained option');
    if (option.kind === 'other') {
      if (!text(pick.other_text)) badChoice('Other requires exact nonempty text');
      if ('other_fragment' in pick) fragments.set(String(ask.id), pick.other_fragment as Json);
      else pending.push(String(ask.id));
    } else {
      if ('other_text' in pick || 'other_fragment' in pick) badChoice('only Other has other_text/other_fragment');
      if (option.kind === 'auto') autos.push(String(ask.id)); else fragments.set(String(ask.id), option.fragment as Json);
    }
    coverage.push({ id: ask.id as Json, state: option.kind === 'auto' ? 'delegated' : pending.includes(String(ask.id)) ? 'other-pending' : 'user' });
  }
  const rule = String((set.assembly as JsonObject).rule);
  const user = [...fragments.values()];
  const userValue = user.length ? assembleFragments(rule,user) : undefined;
  return { value: pending.length ? null : userValue, delegated: autos.length === asks.length, asks: coverage, autos, pending, fragments };
}

export function checkChoiceConstraints(set: JsonObject, choice: JsonObject, fragments: Map<string, Json>): void {
  const asks = objects(set.asks); const picks = objects(choice.picks);
  for (const constraint of objects(set.constraints)) {
    const names = asArray(constraint.asks).map(String);
    const tuple = names.map(name => {
      if (!fragments.has(name)) return undefined; // Check every landed contribution even while another is pending.
      const ask = asks.find(a => a.id === name) as JsonObject;
      const pick = picks.find(p => p.ask === name) as JsonObject;
      const option = objects(ask.options).find(o => o.id === pick.option_id) as JsonObject;
      if (option.kind === 'value') return option.id;
      const matches = objects(ask.options).filter(o => o.kind === 'value' && equal(o.fragment, fragments.get(name)));
      if (matches.length !== 1) fail('INTERVIEW_CHOICE_CONSTRAINT', `ask ${name}: fragment resolves to ${matches.length} value options; redraft the set to offer that option`);
      return matches[0]?.id;
    });
    if (tuple.some(id => id === undefined)) continue;
    if (!asArray(constraint.allowed).some(t => equal(t, tuple))) fail('INTERVIEW_CHOICE_CONSTRAINT', 'chosen combination is not allowed; choose an offered allowed combination or redraft the set to offer that option');
  }
}

function answersAt(project: JsonObject, at: number, collection: JsonObject | null = null): JsonObject {
  const snapshot = structuredClone(project);
  for (const item of collectItems(snapshot, { collection })) {
    const field = item.kind === 'framing' ? 'answer' : 'guide';
    const all = [...objects(item.record.history), ...(isObject(item.raw) ? [item.raw] : [])];
    if (isObject(item.raw) && item.raw.basis === 'inherited' && collection && isObject(item.raw.from) && item.raw.from.collection === collection.name && typeof item.raw.from.question === 'string') {
      const source = collectionQuestion(collection,item.raw.from.question);
      if (source) all.push(...objects(source.history));
      if (item.state.state === 'user' || item.state.state === 'delegated') all.push(item.state.answer);
    }
    item.record[field] = all.filter(a => date(a.at) <= at).sort((a,b) => date(b.at) - date(a.at))[0] ?? null;
  }
  return snapshot;
}

/** Validate the transition allowance independently of the decision being replaced. */
export function refusalBaseline(answer: JsonObject): JsonObject[] {
  if (answer.refusal_baseline !== undefined && (!Array.isArray(answer.refusal_baseline) || answer.refusal_baseline.some(entry =>
    !isObject(entry) || Object.keys(entry).length !== 3 || !text(entry.code) || !text(entry.path)
    || !Number.isSafeInteger(entry.count) || Number(entry.count) <= 0))) badChoice('refusal_baseline must contain only code, path and positive integer count');
  return (answer.refusal_baseline ?? []) as JsonObject[];
}

export function validateChoice(dir: string, project: JsonObject, item: Item, answer: JsonObject, warn?: (why: string) => void): void {
  if (!isObject(answer.choice)) badChoice('choice must be an object');
  refusalBaseline(answer);
  const choice = answer.choice;
  const { set } = optionFile(dir, choice.set);
  validateSet(answersAt(project, date(set.drafted_at),loadCollection(dir)), item, set); validateContext(dir, project, set, date(answer.at), false, warn);
  if (!text(answer.by) || answer.by.toLowerCase() === 'agent' || !Number.isFinite(date(answer.at))) badChoice('a selection needs a human identity and valid clock');
  const projected = selection(set, choice);
  if (answer.delegated !== projected.delegated || !equal(answer.asks, projected.asks) || answer.verbatim !== choiceVerbatim(objects(choice.picks), choice.note)
    || (projected.value === undefined ? 'value' in answer : !equal(answer.value, projected.value))) badChoice('answer state, asks, value or verbatim differs from selected contributions');
  if (projected.pending.length && item.path !== 'intake.choice.answer') {
    const stage = approvalStageOfGuide(item.id,item.kind === 'post',true);
    const reopens = collectReopens(project,[]).filter(r => r.at <= date(answer.at));
    // History does not become invalid merely because a later resolved answer was signed.
    const end = objects(item.record.history).concat(isObject(item.raw) ? [item.raw] : []).filter(a => date(a.at) > date(answer.at)).reduce((n,a) => Math.min(n,date(a.at)),Infinity);
    if (collectSignoffs(project,[]).some(s => (s.stage === stage || s.stage === interviewStageOfGuide(item.id,item.kind === 'post',true)) && s.checkpoint === null && s.at >= date(answer.at) && s.at < end && liveSignoff(reopens,s.stage,s.at))) fail('INTERVIEW_CHOICE_REQUIRED','Other is pending; redraft with a tailored value option and have the person explicitly pick it before approval');
  }
  const decision = answer.agent_decision;
  if (isObject(decision) && equal(Object.keys(decision),['covers']) && decision.covers === projected.autos.join(',') && projected.autos.length) { checkChoiceConstraints(set,choice,projected.fragments); return; }
  if (decision !== undefined) {
    if (!isObject(decision) || !projected.autos.length || !text(decision.by) || !text(decision.reasoning)
      || date(decision.at) < date(answer.at) || !Number.isFinite(date(decision.at)) || decision.covers !== projected.autos.join(',')
      || !Array.isArray(decision.fragments) || !equal(objects(decision.fragments).map(f => f.ask), projected.autos)
      || objects(decision.fragments).length !== decision.fragments.length || objects(decision.fragments).some(f => !('fragment' in f))) badChoice('decision must record exactly the auto asks in order, exact covers, author, clock and reasoning');
    validateContext(dir, project, set, date(decision.at), false, warn);
    const entries = objects(decision.fragments);
    const assembled = assembleFragments(String((set.assembly as JsonObject).rule), entries.map(f => f.fragment as Json));
    if (!equal(decision.value, assembled)) badChoice('agent_decision.value differs from its per-ask fragments');
    for (const entry of entries) projected.fragments.set(String(entry.ask), entry.fragment as Json);
  }
  if (projected.fragments.size === objects(set.asks).length) assembleFragments(String((set.assembly as JsonObject).rule), objects(set.asks).map(a => projected.fragments.get(String(a.id)) as Json));
  checkChoiceConstraints(set, choice, projected.fragments);
}

function finding(e: unknown, path: string): Finding {
  return { code: e instanceof ChoiceError ? e.code : 'INTERVIEW_CHOICE_INVALID', path, message: `${path}: ${e instanceof Error ? e.message : String(e)}; retain the shown set, explicitly pick each ask, and record the exact contributions` };
}

/** One WARN per record path, however many of its clocks the earlier rule had to hold. */
function legacyScene(ctx: Ctx, path: string): (why: string) => void {
  return why => {
    if (ctx.warnings.some(w => w.code === 'INTERVIEW_OPTIONS_SCENE_LEGACY' && w.path === path)) return;
    ctx.warnings.push({ code: 'INTERVIEW_OPTIONS_SCENE_LEGACY', path, message: `${path}: option set ${why}; preserve the record and redraft against the current context when this question is asked again` });
  };
}
export function checkChoices(ctx: Ctx): void {
  const adopted = choiceAdoption(ctx.project);
  if (adopted !== null && (!Number.isFinite(adopted) || !hasStageOrder(ctx.project))) ctx.refusals.push(finding(new ChoiceError('INTERVIEW_CHOICE_INVALID', 'order@2 requires choices_adopted_at'), 'interview.order'));
  if (adopted === null) ctx.warnings.push({ code: 'CHOICE_ANSWERS_LEGACY', path: 'interview.order', message: `interview.order: choices are not adopted (${CHOICE_ANSWERS_SINCE} legacy label); preserve answers and adopt order@2 explicitly before asking fresh choices` });
  for (const item of ctx.items) {
    if (item.record.pending_options !== undefined) {
      try { const { set } = optionFile(ctx.dir, item.record.pending_options); validateSet(ctx.project, item, set,ctx.collection); validateContext(ctx.dir, ctx.project, set, date(set.drafted_at), false, legacyScene(ctx, `${item.path}.pending_options`)); }
      catch (e) { ctx.refusals.push(finding(e, `${item.path}.pending_options`)); }
    }
    const answers: { answer: JsonObject; path: string; current: boolean }[] = objects(item.record.history).map((answer,i) => ({ answer, path: `${item.path}.history[${i}]`, current: false }));
    if (item.state.state === 'user' || item.state.state === 'delegated') answers.push({ answer: item.state.answer, path: item.path, current: true });
    for (const { answer, path, current } of answers) {
      if (answer.choice !== undefined) { try { validateChoice(ctx.dir, ctx.project, item, answer, legacyScene(ctx, path)); } catch (e) { ctx.refusals.push(finding(e, path)); } }
      else if (current && adopted !== null) {
        // An inherited collection answer is historical evidence, never a fabricated member click.
        const inherited = isObject(item.raw) && item.raw.basis === 'inherited';
        if (!inherited && date(answer.at) >= adopted) ctx.refusals.push(finding(new ChoiceError('INTERVIEW_CHOICE_REQUIRED', 'new adopted answer requires explicit per-ask choices'), path));
        else ctx.warnings.push({ code: 'CHOICE_ANSWERS_LEGACY', path, message: `${path}: grandfathered sentence answer; preserve original words/date and show them as a tailored option when this question is asked again` });
      }
    }
  }
}
