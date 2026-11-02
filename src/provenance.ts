/**
 * Provenance per config section (docs/INTERVIEW.md § Provenance): every
 * section of the config a version was built from cites the guide sentence or
 * the delegation it rests on, in `versions[].provenance`. Run as part of
 * `interview --check`, over the same `Ctx`; the codes are in docs/CHECKS.md
 * § Provenance.
 *
 * Which sections a config has:
 * - The config file named in `provenance.config.path` is read when it is under
 *   the project folder and its sha256 matches `provenance.config.sha256`; its
 *   top-level keys are the sections, and each must be cited.
 * - Otherwise (`derived/` is not kept, so this is the usual case) the sections
 *   `provenance.sections` lists are the ones checked, and the report says the
 *   config's own list could not be verified (`provenance[].config`).
 *
 * Which sections need a citation:
 * - `kind: "rig"`: the config is a `@rig-c/parts` config; a section placed
 *   `none` in src/waypoints.ts (`key`, `note`, `generation`, …) is not a
 *   direction call and needs none. Every other section does.
 * - `kind: "post"`: the config is the post tool's, whose sections are not
 *   parts sections and are not on the placement table; every one of them is a
 *   direction call and needs a citation, and it cites a post item (or a
 *   framing answer), never a rig waypoint.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { answered, asArray, asString, isDecision, isObject, itemFor, type Ctx, type Item } from './check.ts';
import type { PartsSections } from './parts-sections.ts';
import type { Json, JsonObject } from './templates.ts';
import { SECTION_PLACEMENT } from './waypoints.ts';

/** How the version's section list was obtained. */
export type ConfigRead =
  | 'verified' // the config file was read and its hash matched; its keys are the sections
  | 'absent' // no file at provenance.config.path under the project; the listed sections were checked
  | 'changed' // the file is there but its hash differs; the listed sections were checked
  | 'unreadable'; // the file is there but is not a JSON object, or the path leaves the project

export interface ProvenanceSummary {
  readonly version: string;
  readonly kind: 'rig' | 'post';
  readonly config_path: string | null;
  readonly config: ConfigRead;
  /** The sections checked: the config's keys when verified, else the ones provenance lists. */
  readonly sections: string[];
}

function versionLabel(v: JsonObject, index: number): string {
  return typeof v.n === 'number' ? `versions[v${v.n}]` : `versions[${index}]`;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Reads the config's top-level keys when the file is the one the version was built from. */
function readConfigSections(dir: string, config: Json | undefined): { read: ConfigRead; path: string | null; sections: string[] | null } {
  const path = isObject(config) ? asString(config.path) : null;
  if (path === null) return { read: 'absent', path: null, sections: null };
  const file = resolve(dir, path);
  const rel = relative(dir, file);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) return { read: 'unreadable', path, sections: null };
  if (!existsSync(file)) return { read: 'absent', path, sections: null };
  const expected = isObject(config) ? asString(config.sha256) : null;
  if (expected === null || sha256(file) !== expected) return { read: 'changed', path, sections: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { read: 'unreadable', path, sections: null };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { read: 'unreadable', path, sections: null };
  return { read: 'verified', path, sections: Object.keys(parsed) };
}

/**
 * The answers a citation may rest on: the current one, and every earlier one
 * in the question's `history[]` — a version built before an answer was
 * replaced was built from the answer as it was then (INTERVIEW.md § Answer
 * shape: a replaced answer moves whole into `history[]`).
 */
function answersOf(item: Item): JsonObject[] {
  const s = item.state;
  const current = s.state === 'user' || s.state === 'delegated' || s.state === 'not_applicable' ? [s.answer] : [];
  return [...current, ...asArray(item.record.history).filter(isObject)];
}

/** The stored sentences a quote may be taken from: each answer's `verbatim` and every `additions[].verbatim`. */
function sentences(item: Item): string[] {
  const out: string[] = [];
  for (const answer of answersOf(item)) {
    const verbatim = asString(answer.verbatim);
    if (verbatim !== null) out.push(verbatim);
    for (const add of asArray(answer.additions)) if (isObject(add) && asString(add.verbatim) !== null) out.push(add.verbatim as string);
  }
  return out;
}

/** A delegation the citation can rest on: an answer that is delegated, or a user answer that left part open, with the agent's decision written. */
function delegationOf(item: Item): 'ok' | 'not-delegated' | 'undecided' {
  let undecided = false;
  for (const answer of answersOf(item)) {
    if (answer.delegated === true) {
      if (isDecision(answer.agent_decision)) return 'ok';
      undecided = true;
    } else if (answer.delegated === false && isDecision(answer.agent_decision)) {
      return 'ok';
    }
  }
  return undecided ? 'undecided' : 'not-delegated';
}

function needsCitation(kind: 'rig' | 'post', section: string): boolean {
  if (kind === 'post') return true;
  return SECTION_PLACEMENT[section]?.kind !== 'none';
}

function checkEntry(ctx: Ctx, kind: 'rig' | 'post', path: string, raw: Json): void {
  if (!isObject(raw)) {
    ctx.refusals.push({ code: 'ENTRY_UNCITED', path, message: `${path}: an entry is an object { entry, guide, quote | delegated: true }` });
    return;
  }
  const label = asString(raw.entry);
  const named = label === null ? path : `${path} ('${label}')`;
  const quote = asString(raw.quote);
  const delegated = raw.delegated === true;
  const guide = asString(raw.guide);
  if ((quote === null || quote === '') && !delegated) {
    ctx.refusals.push({ code: 'ENTRY_UNCITED', path, message: `${named}: neither a quote nor delegated: true; a decision nobody gave — find the sentence, ask for one, or remove the entry` });
    return;
  }
  if (guide === null) {
    ctx.refusals.push({ code: 'CITATION_GUIDE_UNKNOWN', path, message: `${named}: no guide id; name the answer it rests on` });
    return;
  }
  const item = itemFor(ctx, guide);
  if (item === undefined) {
    ctx.refusals.push({ code: 'CITATION_GUIDE_UNKNOWN', path, message: `${named}: cites '${guide}', which is no framing, waypoint or post item of this interview` });
    return;
  }
  if (!answered(item.state)) {
    ctx.refusals.push({ code: 'CITATION_GUIDE_SILENT', path, message: `${named}: cites '${guide}', which has no answer (${item.path} is ${item.state.state})` });
    return;
  }
  if (kind === 'post' && item.kind === 'waypoint') {
    ctx.refusals.push({ code: 'CITATION_WRONG_PHASE', path, message: `${named}: a post version cites rig waypoint '${guide}'; a post config section rests on a post item (or a framing answer) — rig feedback makes a new rig version` });
    return;
  }
  if (quote !== null && quote !== '') {
    if (!sentences(item).some((s) => s.includes(quote))) {
      ctx.refusals.push({ code: 'QUOTE_NOT_FOUND', path, message: `${named}: quote ${JSON.stringify(quote)} is in no verbatim or additions[] of ${item.path} (current or history[]); a quote is an exact fragment of a stored sentence` });
    }
  } else {
    const d = delegationOf(item);
    if (d === 'not-delegated') {
      ctx.refusals.push({ code: 'DELEGATION_NOT_GIVEN', path, message: `${named}: cites '${guide}' as delegated, but no answer at ${item.path} (current or history[]) is a delegation or carries an agent_decision — the user did not hand this over` });
    } else if (d === 'undecided') {
      ctx.refusals.push({ code: 'DELEGATION_NOT_GIVEN', path, message: `${named}: cites the delegation at '${guide}', but ${item.path} has no agent_decision; the decision the section follows is not written` });
    }
  }
}

/** Checks every `versions[]` entry of kind `rig` or `post`; returns what was read, per version, for the report. */
export function checkProvenance(ctx: Ctx, parts: PartsSections | null): ProvenanceSummary[] {
  const summaries: ProvenanceSummary[] = [];
  const known = new Set([...Object.keys(SECTION_PLACEMENT), ...(parts?.sections ?? [])]);
  asArray(ctx.project.versions).forEach((v, index) => {
    if (!isObject(v) || (v.kind !== 'rig' && v.kind !== 'post')) return;
    const kind = v.kind;
    const label = versionLabel(v, index);
    const prov = v.provenance;
    if (!isObject(prov) || !isObject(prov.sections)) {
      ctx.refusals.push({ code: 'PROVENANCE_MISSING', path: `${label}.provenance`, message: `${label}.provenance has no sections{}; a version built from a config cites, per section, the guide it rests on` });
      return;
    }
    const cited = prov.sections;
    const read = readConfigSections(ctx.dir, prov.config);
    const sections = read.sections ?? Object.keys(cited);
    summaries.push({ version: label, kind, config_path: read.path, config: read.read, sections });
    if (read.read === 'changed') {
      ctx.warnings.push({ code: 'PROVENANCE_CONFIG_CHANGED', path: `${label}.provenance.config`, message: `${label}.provenance.config: ${read.path} is present but its sha256 is not the recorded one; the sections listed were checked, not the file's` });
    }
    for (const section of sections) {
      const path = `${label}.provenance.sections[${section}]`;
      if (kind === 'rig' && !known.has(section)) {
        ctx.refusals.push({ code: 'SECTION_UNKNOWN', path, message: `${path}: '${section}' is no @rig-c/parts${parts === null ? '' : ` ${parts.version}`} section; a misspelt name leaves the real section uncited` });
        continue;
      }
      const entries = asArray(cited[section]);
      if (entries.length === 0) {
        if (needsCitation(kind, section)) {
          ctx.refusals.push({ code: 'SECTION_UNCITED', path, message: `${path}: the config has section '${section}' and nothing cites the guide or delegation it rests on` });
        }
        continue;
      }
      entries.forEach((e, i) => checkEntry(ctx, kind, `${path}[${i}]`, e));
    }
  });
  return summaries;
}

/** Lines for the human report: one per version whose config could not be read, so an unverified section list is said, not implied. */
export function formatProvenance(summaries: readonly ProvenanceSummary[]): string[] {
  const unverified = summaries.filter((s) => s.config !== 'verified');
  if (summaries.length === 0) return [];
  const head = `  provenance: ${summaries.length} version${summaries.length === 1 ? '' : 's'} checked`;
  if (unverified.length === 0) return [`${head}; every config read`];
  return [`${head}; config not read for ${unverified.map((s) => `${s.version} (${s.config})`).join(', ')} — the sections provenance lists were checked`];
}
