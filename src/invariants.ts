/** Pure, conservative translation of current interview records; no producer or file reads. */
import { createHash } from 'node:crypto';
import type { RigInvariants } from '@rig-c/core/rig';
import type { Json, JsonObject } from './templates.ts';

export const INVARIANTS_SPEC = 'rig-create/invariants@1';
export interface InvariantFrom { question: string; verbatim_sha256: string | null; }
export interface InvariantEntry {
  invariant: RigInvariants;
  from: InvariantFrom & { verbatim_sha256: string };
  source_path: string;
  value_path: string;
}
export interface InvariantGap {
  gap: 'sentence_semantics' | 'vocabulary' | 'pending_answer' | 'pending_delegation' | 'pending_other' | 'inherited_answer' | 'not_applicable' | 'malformed_answer';
  from: InvariantFrom;
  source_path: string;
  value_path: string;
  sentence: string | null;
  value: Json;
}
export interface InvariantsDocument {
  spec: typeof INVARIANTS_SPEC;
  /** Exact current records, including choice text, delegation reasons and additions; never history. */
  sources: { question: string; path: string; record: Json }[];
  entries: InvariantEntry[];
  gaps: InvariantGap[];
}
const object = (v: Json | undefined): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v: Json | undefined): Json[] => Array.isArray(v) ? v : [];
const text = (v: Json | undefined): v is string => typeof v === 'string' && v.trim().length > 0;
const strings = (v: Json | undefined): v is string[] => Array.isArray(v) && v.length > 0 && v.every(text);
const keys = (v: JsonObject, allowed: string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const rows = (v: Json, predicate: (r: JsonObject) => boolean): boolean => Array.isArray(v) && v.length > 0 && v.every(r => object(r) && predicate(r));
const unique = (values: Json[]): boolean => new Set(values).size === values.length;

/** Only identically spelled, explicit structural readings qualify. No inference from part counts or prose. */
function structural(key: string, value: Json): RigInvariants | null {
  let valid = false;
  switch (key) {
    case 'meshSlots': case 'meshTriangles': valid = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; break;
    case 'axisBone': case 'massBone': valid = text(value); break;
    case 'axes': valid = rows(value, r => keys(r, ['name', 'through', 'bones', 'tolerance']) && text(r.name)
      && strings(r.through) && r.through.length === 2 && unique(r.through) && strings(r.bones) && unique(r.bones)
      && typeof r.tolerance === 'number' && Number.isFinite(r.tolerance) && r.tolerance > 0 && r.tolerance < 90)
      && unique((value as JsonObject[]).map(r => r.name as Json)); break;
    case 'detached': valid = rows(value, r => keys(r, ['bone', 'notUnder', 'why']) && text(r.bone) && text(r.notUnder) && (r.why === undefined || text(r.why))); break;
    case 'deformMayFold': valid = rows(value, r => keys(r, ['slot', 'why']) && text(r.slot) && text(r.why))
      && unique((value as JsonObject[]).map(r => r.slot as Json)); break;
    case 'consumerDrivenMix': valid = rows(value, r => keys(r, ['constraint', 'type', 'why']) && text(r.constraint) && (r.type === 'ik' || r.type === 'transform') && text(r.why))
      && unique((value as JsonObject[]).map(r => `${String(r.type)}:${String(r.constraint)}`)); break;
    case 'idleDrivesMeshes': valid = object(value) && keys(value, ['why']) && text(value.why); break;
  }
  // Core resolves names and enforces the rig. Shape acceptance here is not a passed core check.
  return valid ? { [key]: structuredClone(value) } as RigInvariants : null;
}

export function translateInvariants(project: JsonObject): InvariantsDocument {
  const result: InvariantsDocument = { spec: INVARIANTS_SPEC, sources: [], entries: [], gaps: [] };
  const visit = (question: string, path: string, raw: Json, addition = false): void => {
    result.sources.push({ question, path, record: structuredClone(raw) });
    const answer = object(raw) ? raw : {};
    const sentence = typeof answer.verbatim === 'string' ? answer.verbatim : null;
    const from: InvariantFrom = { question, verbatim_sha256: sentence === null ? null : createHash('sha256').update(sentence, 'utf8').digest('hex') };
    const gap = (kind: InvariantGap['gap'], value_path: string, value: Json): void => {
      result.gaps.push({ gap: kind, from: { ...from }, source_path: path, value_path, sentence, value: structuredClone(value) });
    };
    const leaves = (value: Json, at: string): void => {
      if (Array.isArray(value) && value.length) value.forEach((v, i) => leaves(v, `${at}[${i}]`));
      else if (object(value) && Object.keys(value).length) for (const [k, v] of Object.entries(value)) leaves(v, `${at}[${JSON.stringify(k)}]`);
      else gap('vocabulary', at, value);
    };
    const reading = (value: Json, at: string): void => {
      if (object(value)) {
        if (!Object.keys(value).length) leaves(value, at);
        for (const [k, v] of Object.entries(value)) {
          const valuePath = `${at}[${JSON.stringify(k)}]`;
          const invariant = sentence === null ? null : structural(k, v);
          if (invariant !== null) result.entries.push({ invariant, from: { question, verbatim_sha256: from.verbatim_sha256 as string }, source_path: path, value_path: valuePath });
          else leaves(v, valuePath);
        }
      } else leaves(value, at);
    };
    if (!object(raw)) gap(raw === null ? 'pending_answer' : 'malformed_answer', path, raw);
    else if (answer.basis === 'inherited') gap('inherited_answer', path, raw);
    else if (answer.not_applicable === true) gap('not_applicable', path, raw);
    else {
      // Retain ALL words, including concepts absent from value. This is an explicit semantic gap,
      // not an NLP claim that the interpreter understood each sentence or verified agreement.
      if (sentence !== null) gap('sentence_semantics', `${path}.verbatim`, sentence);
      else gap('malformed_answer', path, raw);
      if (!addition && answer.delegated !== true && answer.delegated !== false) gap('malformed_answer', path, raw);
      if (answer.value !== undefined && (answer.delegated === false || addition)) {
        // An Other-pending answer has value:null, but other picks/fragments are still retained below.
        reading(answer.value, `${path}.value`);
      }
      const decision = object(answer.agent_decision) ? answer.agent_decision : null;
      const decided = decision !== null && decision.value !== undefined && text(decision.reasoning);
      if (decided) reading(decision.value as Json, `${path}.agent_decision.value`);
      const asks = list(answer.asks).filter(object);
      const delegated = asks.filter(a => a.state === 'delegated');
      if (answer.delegated === true && !decided) gap('pending_delegation', `${path}.agent_decision`, answer.agent_decision ?? null);
      else if (decision !== null && !decided && delegated.length === 0) gap('pending_delegation', `${path}.agent_decision`, decision);
      for (const ask of delegated) {
        const landed = decided && (!object(answer.choice) || list(decision?.fragments).some(f => object(f) && f.ask === ask.id && f.fragment !== undefined));
        if (!landed) gap('pending_delegation', `${path}.asks[${String(ask.id)}]`, ask);
      }
      for (const ask of asks.filter(a => a.state === 'other-pending')) gap('pending_other', `${path}.asks[${String(ask.id)}]`, ask);
      // Completed Other fragments are already in value. Only read picks while a pending
      // Other suppresses that aggregate; no option-file reads or reassembly.
      if (object(answer.choice)) list(answer.choice.picks).forEach((pick, i) => {
        if (!object(pick)) return;
        if (pick.other_text !== undefined) gap('sentence_semantics', `${path}.choice.picks[${i}].other_text`, pick.other_text);
        if (asks.some(a => a.state === 'other-pending') && pick.other_fragment !== undefined) reading(pick.other_fragment, `${path}.choice.picks[${i}].other_fragment`);
      });
      if (answer.delegated === false && answer.value === undefined) gap('malformed_answer', `${path}.value`, null);
    }
    list(answer.additions).forEach((addition, i) => visit(question, `${path}.additions[${i}]`, addition, true));
  };
  const interview = object(project.interview) ? project.interview : {};
  const collect = (records: Json[], prefix: string, field: string): void => {
    records.forEach((record, i) => {
      if (!object(record)) { visit(`${prefix}[${i}]`, `${prefix}[${i}]`, record); return; }
      const question = typeof record.id === 'string' ? record.id : `${prefix}[${i}]`;
      visit(question, `${prefix}[${question}].${field}`, record[field] ?? null);
    });
  };
  collect(list(interview.framing), 'interview.framing', 'answer');
  collect(list(interview.waypoints), 'interview.waypoints', 'guide');
  collect(list(object(interview.post) ? interview.post.items : undefined), 'interview.post.items', 'guide');
  return result;
}
