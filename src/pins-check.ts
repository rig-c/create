/**
 * Collection pins (docs/COLLECTIONS.md § Pins) and `collection --check`.
 *
 * `collection pin` records a collection version: every member's latest rig
 * version and the sha256 of every rig file that version lists (model, atlas,
 * config, per variant), hashed on disk where the file is present, plus the
 * collection's own `outputs/v<N>/` files. It is run when a collection output
 * is made.
 *
 * `collection --check` (also what `interview --check` runs on a collection)
 * refuses, by member name, a member whose current build no longer hashes to
 * the pins of the latest collection version that has outputs — the output a
 * person would be shown. It also checks the collection record itself: schema,
 * stage, sign-offs, the collection's own answers, and that every member in
 * `members[]` has a project record. It does not run each member's interview
 * check: run `interview --check` in the member.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

import { classify, collectSignoffs, COLLECTION_SCHEMA, readJsonObject, type Finding } from './check.ts';
import { COLLECTION_STAGES, COLLECTION_STAGE_VALUES } from './collection.ts';
import type { CommandResult } from './interview.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export interface PinFile {
  role: string;
  path: string;
  sha256: string;
}
export interface PinRig {
  variant: string;
  files: PinFile[];
}
export interface Pin {
  member: string;
  version: number | null;
  rigs: PinRig[];
  note?: string;
}

/** A rig file of a member build, as the member records it and as it is on disk now. */
interface BuildFile {
  variant: string;
  role: string;
  path: string;
  recorded: string | null;
  on_disk: string | null;
}

export interface CollectionReport {
  readonly kind: 'collection';
  readonly ok: boolean;
  readonly collection_dir: string;
  readonly stage: string | null;
  readonly effective_stage: string | null;
  readonly members: string[];
  /** The collection version whose pins were checked: the latest one with outputs. */
  readonly pins_checked: number | null;
  readonly refusals: Finding[];
  readonly warnings: Finding[];
}

const DEFAULT_VARIANT = 'default';
const MODEL_EXT = new Set(['.json', '.skel']);
const ATLAS_EXT = new Set(['.atlas', '.png', '.webp', '.jpg', '.jpeg', '.ktx2']);

function isObject(v: Json | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}
function asArray(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function hashIfPresent(dir: string, path: string): string | null {
  const file = join(dir, path);
  return existsSync(file) && statSync(file).isFile() ? sha256File(file) : null;
}

/**
 * The role of an output: its own `role` field when it carries one, else by
 * extension — `.json`/`.skel` is the model, `.atlas` and page images are the
 * atlas. Anything else (a take, a contact sheet) is not a rig file and is not
 * pinned unless it says it is.
 */
export function outputRole(output: JsonObject): string | null {
  const role = asString(output.role);
  if (role !== null) return role;
  const path = asString(output.path);
  if (path === null) return null;
  const ext = extname(path).toLowerCase();
  if (MODEL_EXT.has(ext)) return 'model';
  if (ATLAS_EXT.has(ext)) return 'atlas';
  return null;
}

/** A member's latest rig version (`kind: "rig"`, or no kind), by `n`. */
export function latestRigVersion(project: JsonObject): JsonObject | null {
  let best: JsonObject | null = null;
  for (const v of asArray(project.versions)) {
    if (!isObject(v) || typeof v.n !== 'number') continue;
    if (v.kind !== undefined && v.kind !== 'rig') continue;
    if (best === null || (v.n as number) > (best.n as number)) best = v;
  }
  return best;
}

/** The rig files a member version lists: its model and atlas outputs, and the config it was built from, for every variant. */
function buildFiles(memberDir: string, version: JsonObject): BuildFile[] {
  const files: BuildFile[] = [];
  for (const o of asArray(version.outputs)) {
    if (!isObject(o)) continue;
    const role = outputRole(o);
    const path = asString(o.path);
    if (role === null || path === null) continue;
    files.push({ variant: asString(o.variant) ?? DEFAULT_VARIANT, role, path, recorded: asString(o.sha256), on_disk: hashIfPresent(memberDir, path) });
  }
  const provenance = isObject(version.provenance) ? version.provenance : {};
  const config = isObject(provenance.config) ? provenance.config : null;
  const configPath = config === null ? null : asString(config.path);
  if (config !== null && configPath !== null) {
    const variants = [...new Set(files.map((f) => f.variant))];
    for (const variant of variants.length > 0 ? variants : [DEFAULT_VARIANT]) {
      files.push({ variant, role: 'config', path: configPath, recorded: asString(config.sha256), on_disk: hashIfPresent(memberDir, configPath) });
    }
  }
  return files;
}

const current = (f: BuildFile): string | null => f.on_disk ?? f.recorded;
const fileKey = (variant: string, role: string, path: string): string => `${variant}\u0000${role}\u0000${path}`;

interface Member {
  name: string;
  dir: string;
  project: JsonObject | null;
  path: string;
  why: string | null;
}

function readMembers(dir: string, collection: JsonObject, refusals: Finding[]): Member[] {
  const out: Member[] = [];
  asArray(collection.members).forEach((m, index) => {
    const name = isObject(m) ? asString(m.name) : null;
    if (!isObject(m) || name === null) {
      refusals.push({ code: 'MEMBER_MALFORMED', path: `members[${index}]`, message: `members[${index}]: a member is an object with a string name` });
      return;
    }
    const projectRel = asString(m.project) ?? `members/${name}/project.json`;
    const file = resolve(dir, projectRel);
    const memberDir = resolve(file, '..');
    const path = `members[${name}]`;
    if (!existsSync(file)) {
      out.push({ name, dir: memberDir, project: null, path, why: `${projectRel} does not exist` });
      return;
    }
    const read = readJsonObject(file);
    out.push(read.ok ? { name, dir: memberDir, project: read.value, path, why: null } : { name, dir: memberDir, project: null, path, why: `${projectRel}: ${read.error}` });
  });
  return out;
}

// ------------------------------------------------------------------- pinning

export interface PinResult {
  version: number;
  pins: Pin[];
  outputs: { path: string; sha256: string; bytes: number }[];
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/**
 * Builds the pins for a new collection version from every member's latest rig
 * version. Refuses by member name — all of them, not the first — a member with
 * no project record, no rig version, no rig file, or a file on disk that no
 * longer hashes to the version that lists it (rebuilt in place: record a new
 * member version first, so the pin names a build that exists).
 */
export function buildPins(dir: string, collection: JsonObject): { pins: Pin[]; refusals: Finding[] } {
  const refusals: Finding[] = [];
  const members = readMembers(dir, collection, refusals);
  if (members.length === 0 && refusals.length === 0) {
    refusals.push({ code: 'PIN_NO_MEMBERS', path: 'members', message: 'collection.json members[] is empty; there is nothing to pin' });
  }
  const pins: Pin[] = [];
  for (const m of members) {
    if (m.project === null) {
      refusals.push({ code: 'MEMBER_PROJECT_MISSING', path: m.path, message: `${m.path}: ${m.why}` });
      continue;
    }
    const version = latestRigVersion(m.project);
    if (version === null) {
      refusals.push({ code: 'PIN_NO_BUILD', path: m.path, message: `${m.path}: has no rig version in versions[]; build and record one before pinning` });
      continue;
    }
    const n = version.n as number;
    const files = buildFiles(m.dir, version);
    if (!files.some((f) => f.role !== 'config')) {
      refusals.push({ code: 'PIN_NO_BUILD', path: m.path, message: `${m.path}: version ${n} lists no model or atlas output` });
      continue;
    }
    let ok = true;
    for (const f of files) {
      if (current(f) === null) {
        refusals.push({ code: 'PIN_NO_BUILD', path: m.path, message: `${m.path}: ${f.role} ${f.path} has no sha256 in version ${n} and is not on disk` });
        ok = false;
      } else if (f.on_disk !== null && f.recorded !== null && f.on_disk !== f.recorded) {
        refusals.push({
          code: 'PIN_SOURCE_DRIFT',
          path: m.path,
          message: `${m.path}: ${f.role} ${f.path} on disk does not hash to version ${n}'s record; it was rebuilt in place — record a new member version, then pin`,
        });
        ok = false;
      }
    }
    if (!ok) continue;
    const rigs: PinRig[] = [];
    for (const f of files) {
      let rig = rigs.find((r) => r.variant === f.variant);
      if (rig === undefined) {
        rig = { variant: f.variant, files: [] };
        rigs.push(rig);
      }
      rig.files.push({ role: f.role, path: f.path, sha256: current(f) as string });
    }
    pins.push({ member: m.name, version: n, rigs });
  }
  return { pins, refusals };
}

/** Writes a new `versions[]` entry with pins and the hashed `outputs/v<N>/` files. */
export function pinCollection(dirArg: string, changed: string | null, now = new Date()): { result: PinResult | null; refusals: Finding[]; dir: string } {
  const dir = resolve(dirArg);
  const file = join(dir, 'collection.json');
  if (!existsSync(file)) refuse('COLLECTION_JSON_MISSING', `${file} does not exist; run in a collection folder or name one`);
  const read = readJsonObject(file);
  if (!read.ok) refuse('COLLECTION_JSON_INVALID', `${file}: ${read.error}`);
  const collection = read.value;
  if (collection.schema !== COLLECTION_SCHEMA) refuse('SCHEMA_UNKNOWN', `${file}: schema is ${JSON.stringify(collection.schema ?? null)}; this reads ${COLLECTION_SCHEMA}`);
  const { pins, refusals } = buildPins(dir, collection);
  if (refusals.length > 0) return { result: null, refusals, dir };
  const versions = asArray(collection.versions);
  const n = versions.reduce<number>((max, v) => (isObject(v) && typeof v.n === 'number' && v.n > max ? v.n : max), 0) + 1;
  const outputs = listFiles(join(dir, 'outputs', `v${n}`)).map((f) => ({ path: relative(dir, f).split('\\').join('/'), sha256: sha256File(f), bytes: statSync(f).size }));
  const entry: JsonObject = {
    n,
    at: now.toISOString(),
    pins: pins as unknown as Json,
    composition_inputs: [],
    outputs,
    evidence: [],
    verdicts: [],
    changed,
    answers_feedback: [],
  };
  collection.versions = [...versions, entry];
  writeFileSync(file, `${JSON.stringify(collection, null, 2)}\n`);
  return { result: { version: n, pins, outputs }, refusals: [], dir };
}

// ------------------------------------------------------------------ checking

function readPins(raw: Json | undefined, version: number, refusals: Finding[]): Pin[] {
  const pins: Pin[] = [];
  asArray(raw).forEach((p, index) => {
    const member = isObject(p) ? asString(p.member) : null;
    if (!isObject(p) || member === null || (p.version !== null && typeof p.version !== 'number') || !Array.isArray(p.rigs)) {
      refusals.push({ code: 'PIN_MALFORMED', path: `versions[${version}].pins[${index}]`, message: `versions[n=${version}].pins[${index}]: a pin is { member, version (number or null), rigs[] }` });
      return;
    }
    // A pin that cannot be compared is malformed, never a silent pass: every rig
    // carries a non-empty files[] and every file a role, path and sha256.
    const rigs: PinRig[] = [];
    let unreadable: string | null = p.rigs.length === 0 ? 'rigs[] is empty' : null;
    p.rigs.forEach((r, ri) => {
      if (unreadable !== null) return;
      if (!isObject(r) || !Array.isArray(r.files) || r.files.length === 0) {
        unreadable = `rigs[${ri}] has no files[] (each rig is { variant, files[{ role, path, sha256 }] })`;
        return;
      }
      const files: PinFile[] = [];
      for (const [fi, f] of r.files.entries()) {
        const role = isObject(f) ? asString(f.role) : null;
        const path = isObject(f) ? asString(f.path) : null;
        const sha256 = isObject(f) ? asString(f.sha256) : null;
        if (role === null || path === null || sha256 === null) {
          unreadable = `rigs[${ri}].files[${fi}] needs role, path and sha256`;
          return;
        }
        files.push({ role, path, sha256 });
      }
      rigs.push({ variant: asString(r.variant) ?? DEFAULT_VARIANT, files });
    });
    if (unreadable !== null) {
      refusals.push({ code: 'PIN_MALFORMED', path: `versions[${version}].pins[${index}]`, message: `versions[n=${version}].pins[${index}] (${member}): ${unreadable}; a pin that cannot be compared verifies nothing` });
      return;
    }
    pins.push({ member, version: p.version as number | null, rigs });
  });
  return pins;
}

/** Every way a member's current build differs from its pin, one refusal each, all naming the member. */
function comparePin(m: Member, project: JsonObject, pin: Pin, cv: number, refusals: Finding[]): void {
  const stale = (message: string): void => {
    refusals.push({ code: 'PIN_STALE', path: m.path, message: `${m.path}: ${message}; collection v${cv}'s output is stale until a new collection version pins it` });
  };
  const version = latestRigVersion(project);
  if (pin.version === null) {
    if (version !== null) {
      stale(`has rig version ${version.n as number}, which is not pinned (pin v${cv} predates the member's versions[])`);
      return;
    }
    for (const rig of pin.rigs) {
      for (const f of rig.files) {
        const disk = hashIfPresent(m.dir, f.path);
        if (disk !== null && disk !== f.sha256) stale(`${f.role} sha256 differs from pin v${cv} (${f.path}, variant ${rig.variant})`);
      }
    }
    return;
  }
  if (version === null) {
    stale(`has no rig version; pin v${cv} names version ${pin.version}`);
    return;
  }
  const n = version.n as number;
  if (n !== pin.version) {
    stale(`rig version ${n} is not pinned; pin v${cv} names version ${pin.version}`);
    return;
  }
  const files = buildFiles(m.dir, version);
  const now = new Map(files.map((f) => [fileKey(f.variant, f.role, f.path), f]));
  const pinned = new Set<string>();
  for (const rig of pin.rigs) {
    for (const f of rig.files) {
      const key = fileKey(rig.variant, f.role, f.path);
      pinned.add(key);
      const build = now.get(key);
      if (build === undefined) {
        stale(`${f.role} ${f.path} (variant ${rig.variant}) is pinned in v${cv} but version ${n} no longer lists it`);
      } else if (current(build) !== f.sha256) {
        stale(`${f.role} sha256 differs from pin v${cv} (${f.path}, variant ${rig.variant}${build.on_disk !== null ? ', hashed on disk' : ''})`);
      }
    }
  }
  for (const f of files) {
    if (!pinned.has(fileKey(f.variant, f.role, f.path))) stale(`${f.role} ${f.path} (variant ${f.variant}) of version ${n} is not pinned in v${cv}`);
  }
}

function checkPins(dir: string, collection: JsonObject, members: Member[], refusals: Finding[], warnings: Finding[]): number | null {
  const versions = asArray(collection.versions).filter(isObject);
  const shown = versions
    .filter((v) => typeof v.n === 'number' && asArray(v.outputs).length > 0)
    .sort((a, b) => (b.n as number) - (a.n as number))[0];
  if (shown === undefined) return null;
  const cv = shown.n as number;
  const pins = readPins(shown.pins, cv, refusals);
  for (const m of members) {
    if (m.project === null) continue;
    const pin = pins.find((p) => p.member === m.name);
    if (pin === undefined) {
      refusals.push({ code: 'PIN_MISSING', path: m.path, message: `${m.path}: is a member but collection v${cv} has no pin for it; its output was not made from a pinned build of this member` });
      continue;
    }
    comparePin(m, m.project, pin, cv, refusals);
  }
  for (const p of pins) {
    if (!members.some((m) => m.name === p.member)) {
      refusals.push({ code: 'PIN_UNKNOWN_MEMBER', path: `members[${p.member}]`, message: `collection v${cv} pins '${p.member}', which is not in members[]` });
    }
  }
  for (const o of asArray(shown.outputs)) {
    if (!isObject(o)) continue;
    const path = asString(o.path);
    if (path === null) continue;
    const disk = hashIfPresent(dir, path);
    if (disk !== null && disk !== asString(o.sha256)) {
      warnings.push({ code: 'OUTPUT_CHANGED', path: `versions[${cv}].outputs`, message: `${path} on disk does not hash to collection v${cv}'s record; an output is frozen when pinned` });
    }
  }
  return cv;
}

/** Collection answers as `interview --check` reads a project's, against the collection's own stages. */
function checkCollectionRecord(collection: JsonObject, stage: string, refusals: Finding[]): string {
  const signoffs = collectSignoffs(collection, refusals);
  const order: readonly string[] = COLLECTION_STAGES.map((s) => s.id);
  const effective = stage === 'paused'
    ? (COLLECTION_STAGES.find((s) => s.closed_by === 'signoff' && !signoffs.some((x) => x.stage === s.id && x.checkpoint === null))?.id ?? 'accepted')
    : stage;
  const cur = order.indexOf(effective);
  for (const s of signoffs) {
    if (!order.includes(s.stage) && s.stage !== 'paused') {
      refusals.push({ code: 'SIGNOFF_UNKNOWN_STAGE', path: `signoffs[${s.index}]`, message: `signoffs[${s.index}]: stage '${s.stage}' is not a collection stage (${COLLECTION_STAGE_VALUES.join(', ')})` });
    }
  }
  if (stage === 'paused' && !signoffs.some((s) => s.stage === 'paused')) {
    refusals.push({ code: 'PAUSED_UNSIGNED', path: 'stage', message: 'stage is paused, but no { "stage": "paused" } sign-off stopped it' });
  }
  COLLECTION_STAGES.forEach((spec, idx) => {
    if (idx >= cur || spec.closed_by !== 'signoff') return;
    if (!signoffs.some((s) => s.stage === spec.id && s.checkpoint === null)) {
      refusals.push({ code: 'STAGE_UNSIGNED', path: 'stage', message: `stage is '${stage}', past '${spec.id}', but no { "stage": "${spec.id}", "checkpoint": null } sign-off closed it` });
    }
  });

  const interview = isObject(collection.interview) ? collection.interview : {};
  const post = isObject(interview.post) ? interview.post : {};
  const groups: [Json | undefined, string, 'answer' | 'guide', boolean][] = [
    [interview.questions, 'questions', 'answer', false],
    [interview.framing, 'framing', 'answer', false],
    [interview.waypoints, 'waypoints', 'guide', false],
    [post.items, 'post.items', 'guide', true],
  ];
  const postIdx = order.indexOf('post-interview');
  for (const [list, name, field, isPost] of groups) {
    for (const item of asArray(list)) {
      if (!isObject(item) || typeof item.id !== 'string') continue;
      const path = `interview.${name}[${item.id}].${field}`;
      const state = classify(item[field], { collection: null });
      if (state.state === 'malformed') {
        refusals.push({ code: 'ANSWER_MALFORMED', path, message: `${path}: ${state.why}` });
      } else if (state.state === 'silent') {
        const gate = isPost ? postIdx : 0;
        if (cur < gate) continue;
        if (cur === gate) refusals.push({ code: 'INTERVIEW_INCOMPLETE', path, message: `${path}: not answered yet; the collection interview is incomplete (answer "per-member" to leave it to each member)` });
        else refusals.push({ code: 'COLLECTION_ITEM_SILENT', path, message: `${path}: no answer, no delegation and not "per-member", yet the collection stage is past ${isPost ? 'post-interview' : 'interview'}` });
      }
    }
  }
  return effective;
}

export function checkCollection(dirArg: string): CollectionReport {
  const dir = resolve(dirArg);
  const refusals: Finding[] = [];
  const warnings: Finding[] = [];
  const fail = (): CollectionReport => ({ kind: 'collection', ok: false, collection_dir: dir, stage: null, effective_stage: null, members: [], pins_checked: null, refusals, warnings });
  const file = join(dir, 'collection.json');
  if (!existsSync(file)) {
    refusals.push({ code: 'COLLECTION_JSON_MISSING', path: file, message: `${file} does not exist; run in a collection folder or name one` });
    return fail();
  }
  const read = readJsonObject(file);
  if (!read.ok) {
    refusals.push({ code: 'COLLECTION_JSON_INVALID', path: file, message: `${file}: ${read.error}` });
    return fail();
  }
  const collection = read.value;
  if (collection.schema !== COLLECTION_SCHEMA) {
    refusals.push({ code: 'SCHEMA_UNKNOWN', path: 'schema', message: `schema is ${JSON.stringify(collection.schema ?? null)}; this check reads ${COLLECTION_SCHEMA}` });
    return fail();
  }
  const stage = asString(collection.stage);
  if (stage === null || !COLLECTION_STAGE_VALUES.includes(stage)) {
    refusals.push({ code: 'STAGE_UNKNOWN', path: 'stage', message: `stage is ${JSON.stringify(collection.stage ?? null)}; the collection stages are ${COLLECTION_STAGE_VALUES.join(', ')}` });
    return fail();
  }
  const recordValues = asArray(collection.stage_values).filter((x): x is string => typeof x === 'string');
  if (recordValues.join(',') !== COLLECTION_STAGE_VALUES.join(',')) {
    warnings.push({ code: 'STAGE_VALUES_STALE', path: 'stage_values', message: `stage_values is [${recordValues.join(', ')}]; the collection order is [${COLLECTION_STAGE_VALUES.join(', ')}]` });
  }
  const effective = checkCollectionRecord(collection, stage, refusals);
  const members = readMembers(dir, collection, refusals);
  for (const m of members) {
    if (m.project === null) refusals.push({ code: 'MEMBER_PROJECT_MISSING', path: m.path, message: `${m.path}: ${m.why}` });
  }
  const membersDir = join(dir, 'members');
  if (existsSync(membersDir)) {
    for (const entry of readdirSync(membersDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !members.some((m) => basename(m.dir) === entry.name)) {
        warnings.push({ code: 'MEMBER_UNREGISTERED', path: `members/${entry.name}`, message: `members/${entry.name}/ is not in collection.json members[]; register it (rig-create init --member makes and registers a member)` });
      }
    }
  }
  const pinsChecked = checkPins(dir, collection, members, refusals, warnings);
  return { kind: 'collection', ok: refusals.length === 0, collection_dir: dir, stage, effective_stage: effective, members: members.map((m) => m.name), pins_checked: pinsChecked, refusals, warnings };
}

export function formatCollectionReport(report: CollectionReport): string {
  const lines = [`collection --check: ${report.collection_dir}`];
  if (report.stage !== null) lines.push(`  stage ${report.stage}${report.effective_stage !== report.stage ? ` (checked as ${report.effective_stage})` : ''}`);
  lines.push(`  members (${report.members.length}): ${report.members.join(', ') || 'none'}`);
  lines.push(report.pins_checked === null ? '  pins: no collection version has outputs yet; nothing to check against' : `  pins: checked against collection v${report.pins_checked} (the latest version with outputs)`);
  for (const r of report.refusals) lines.push(`  REFUSED ${r.code}: ${r.message}`);
  for (const w of report.warnings) lines.push(`  warning ${w.code}: ${w.message}`);
  const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
  lines.push(report.ok ? `clean: ${n(report.warnings.length, 'warning')}` : `not clear: ${n(report.refusals.length, 'refusal')}, ${n(report.warnings.length, 'warning')}`);
  return lines.join('\n');
}

export const COLLECTION_HELP = `collection:
  pin [<dir>] [--changed <sentence>]
                   record a collection version: pin every member's latest rig version and the sha256 of each rig
                   file it lists (model, atlas, config per variant), and hash the collection's outputs/v<N>/
  --check [<dir>] [--json]
                   refuse by member name a member rebuilt since the pins of the latest collection version with
                   outputs, and check the collection record (stage, sign-offs, answers, members[]) (docs/CHECKS.md)`;

export function collectionCommand(args: string[]): CommandResult {
  const [first, ...rest] = args;
  if (first === 'pin') {
    let changed: string | null = null;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === '--changed') {
        const value = rest[++i];
        if (value === undefined) refuse('COLLECTION_USAGE', '--changed takes a sentence', USAGE_EXIT);
        changed = value;
      } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `collection pin does not take ${arg}`, USAGE_EXIT);
      else positional.push(arg);
    }
    if (positional.length > 1) refuse('COLLECTION_USAGE', `collection pin takes one folder, got ${positional.join(' ')}`, USAGE_EXIT);
    const { result, refusals, dir } = pinCollection(positional[0] ?? process.cwd(), changed);
    if (result === null) {
      const lines = [`collection pin: ${dir}`, ...refusals.map((r) => `  REFUSED ${r.code}: ${r.message}`), `not pinned: ${refusals.length} refusal${refusals.length === 1 ? '' : 's'}`];
      return { stdout: lines.join('\n'), exit: 1 };
    }
    const lines = [
      `collection pin: ${dir}`,
      `  collection v${result.version}: ${result.pins.map((p) => `${p.member} v${p.version}`).join(', ')}`,
      `  outputs/v${result.version}/: ${result.outputs.length} file${result.outputs.length === 1 ? '' : 's'} hashed`,
      ...(result.outputs.length === 0 ? [`  no outputs/v${result.version}/ yet: this version is not checked until it has outputs (make the output, then pin)`] : []),
      'collection.json is written, not committed.',
    ];
    return { stdout: lines.join('\n'), exit: 0 };
  }
  let check = false;
  let json = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '--check') check = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `collection does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (!check) refuse('COLLECTION_USAGE', 'collection needs pin or --check: rig-create collection pin [<dir>] | rig-create collection --check [<dir>]', USAGE_EXIT);
  if (positional.length > 1) refuse('COLLECTION_USAGE', `collection --check takes one folder, got ${positional.join(' ')}`, USAGE_EXIT);
  const report = checkCollection(positional[0] ?? process.cwd());
  return { stdout: json ? JSON.stringify(report, null, 2) : formatCollectionReport(report), exit: report.ok ? 0 : 1 };
}

/** Where `interview --check` was pointed, when that is a collection: a folder with collection.json and no project.json, or the collection.json itself. */
export function collectionDirOf(target: string): string | null {
  const abs = resolve(target);
  if (basename(abs) === 'collection.json' && existsSync(abs) && statSync(abs).isFile()) return resolve(abs, '..');
  if (existsSync(join(abs, 'collection.json')) && !existsSync(join(abs, 'project.json'))) return abs;
  return null;
}
