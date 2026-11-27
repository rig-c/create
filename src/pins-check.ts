/**
 * Collection pins (docs/COLLECTIONS.md § Pins) and `collection --check`.
 *
 * `collection pin` records the committed current rig or the selected/latest
 * numbered rig of each member, plus the collection's `outputs/v<N>/` files.
 *
 * `collection --check` (also what `interview --check` runs on a collection)
 * verifies the pins of the latest collection version that has outputs. A
 * verified current pin can describe an earlier rig. It also checks the collection record: schema,
 * stage, sign-offs, the collection's own answers, and that every member in
 * `members[]` has a project record. It does not run each member's interview
 * check: run `interview --check` in the member.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { classify, collectSignoffs, COLLECTION_SCHEMA, PROJECT_SCHEMA, readJsonObject, type Finding } from './check.ts';
import { COLLECTION_STAGES, COLLECTION_STAGE_VALUES } from './collection.ts';
import { currentShapeFindings, isCurrentProject, sha256 } from './current.ts';
import type { CommandResult } from './interview.ts';
import { tryJobDirectoryLock } from './job-outbox.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { checkScratchBindings } from './scratch-bindings.ts';
import { collectionAnswerCommand } from './collection-answer.ts';
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
interface NumberedPin {
  member: string;
  version: number | null;
  rigs: PinRig[];
  note?: string;
  selection?: 'explicit';
}

interface CurrentRigPin {
  member: string;
  kind: 'current-rig';
  record: { path: string; sha256: string; commit: string };
  rig: { files_sha256: string };
}

export type Pin = NumberedPin | CurrentRigPin;

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
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

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
  registeredPath: string | null;
}

function readMembers(dir: string, collection: JsonObject, refusals: Finding[], currentMembers?: ReadonlySet<string>): Member[] {
  const out: Member[] = [];
  asArray(collection.members).forEach((m, index) => {
    const name = isObject(m) ? asString(m.name) : null;
    if (!isObject(m) || name === null) {
      refusals.push({ code: 'MEMBER_MALFORMED', path: `members[${index}]`, message: `members[${index}]: a member is an object with a string name` });
      return;
    }
    const registeredPath = asString(m.project);
    const projectRel = registeredPath ?? `members/${name}/project.json`;
    const file = resolve(dir, projectRel);
    const memberDir = resolve(file, '..');
    const path = `members[${name}]`;
    const member = { name, dir: memberDir, path, registeredPath };
    if (currentMembers?.has(name) && liveCurrentMemberProblem(dir, member)) {
      // A live path that leaves the collection cannot supply a live digest.
      // A current pin is still resolved independently from its committed tree.
      out.push({ ...member, project: null, why: null });
      return;
    }
    if (!existsSync(file)) {
      out.push({ ...member, project: null, why: `${projectRel} does not exist` });
      return;
    }
    const read = readJsonObject(file);
    out.push(read.ok ? { ...member, project: read.value, why: null } : { ...member, project: null, why: `${projectRel}: ${read.error}` });
  });
  return out;
}

type MemberLocation = Pick<Member, 'name' | 'registeredPath'>;

function registeredCurrentPath(member: MemberLocation): string | undefined {
  const name = member.name;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  const expected = `members/${name}/project.json`;
  return member.registeredPath === expected ? expected : undefined;
}

/** Follow only ordinary directories in the collection work tree when reading a live current rig. */
function liveCurrentMemberProblem(dir: string, member: MemberLocation): string | undefined {
  const path = registeredCurrentPath(member);
  if (path === undefined) return 'the registration must name the literal members/<name>/project.json path';
  try {
    let parent = dir;
    const components = path.split('/');
    for (const [index, component] of components.entries()) {
      const file = join(parent, component);
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat === undefined) return undefined; // The normal missing-record check handles this.
      if (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory()) return `${path} uses a link or non-regular entry`;
      if (index < components.length - 1 && lstatSync(join(file, '.git'), { throwIfNoEntry: false })) return `${path} is inside a nested repository`;
      parent = file;
    }
  } catch {
    return `${path} cannot be inspected inside the collection work tree`;
  }
}

type CollectionGit = (args: string[]) => Buffer | undefined;

function openCollectionGit(dir: string): CollectionGit | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0' };
  // Resolve the repository at the collection root even when invoked from another Git command.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const git: CollectionGit = (args) => {
    try {
      const result = Bun.spawnSync(['git', '--no-replace-objects', '--literal-pathspecs', ...args], { cwd: dir, env, stdout: 'pipe', stderr: 'ignore' });
      return result.exitCode === 0 ? Buffer.from(result.stdout) : undefined;
    } catch { return undefined; }
  };
  return git(['rev-parse', '--show-prefix'])?.toString('utf8').replace(/\r?\n$/, '') === '' ? git : undefined;
}

function parseRecord(bytes: Buffer): JsonObject | undefined {
  const parsed: Json = JSON.parse(bytes.toString('utf8'));
  return isObject(parsed) ? parsed : undefined;
}

function currentRig(project: JsonObject | null): JsonObject | undefined {
  const node = project && isObject(project.current) ? project.current.rig : undefined;
  return isObject(node) ? node : undefined;
}

/** Resolve a pin against the committed tree. The working record is only a constraint when writing a new pin. */
function currentPinProblem(member: MemberLocation, pin: CurrentRigPin, git: CollectionGit | undefined, working?: Buffer): string | undefined {
  const { path, commit } = pin.record;
  if (registeredCurrentPath(member) !== path) return `record.path ${JSON.stringify(path)} does not match the literal registered member path`;
  if (git === undefined) return 'the collection root is not a readable Git work tree';
  if (git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])?.toString('utf8').trim() !== commit) return `commit ${commit} cannot be resolved as the named commit object`;
  const tree = git(['ls-tree', '--full-tree', '-z', commit, '--', path])?.toString('utf8');
  const entry = /^(?:100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(tree ?? '');
  if (!entry || entry[2] !== path) return `commit ${commit} does not contain a regular tracked blob at ${path}`;
  const blob = git(['cat-file', 'blob', entry[1]!]);
  if (blob === undefined) return `commit ${commit} has an unreadable blob at ${path}`;
  if (working !== undefined && !blob.equals(working)) return `commit ${commit} does not contain the exact working bytes of ${path}`;
  if (sha256(blob) !== pin.record.sha256) return `the committed ${path} differs from record.sha256`;
  let project: JsonObject | undefined;
  try { project = parseRecord(blob); } catch { return `the committed ${path} is invalid JSON`; }
  if (project?.schema !== PROJECT_SCHEMA) return `the committed ${path} must be a ${PROJECT_SCHEMA} record`;
  const rig = currentRig(project);
  const shape = currentShapeFindings('rig', rig, project)[0];
  if (shape !== undefined) return `the committed ${path} has an invalid ${shape.path}`;
  if (rig?.files_sha256 !== pin.rig.files_sha256) return `the committed ${path} current.rig.files_sha256 differs from the pin`;
}

function unverifiedCurrentPin(path: string, member: string, problem: string): Finding {
  return { code: 'PIN_MEMBER_COMMIT_UNVERIFIED', path, message: `${path} (${member}): ${problem}. Restore the exact member record and collection Git history, or commit the live rig record and run collection pin for a new output.` };
}

function readCurrentMemberBytes(dir: string, member: MemberLocation): { bytes: Buffer } | { problem: string } {
  const problem = liveCurrentMemberProblem(dir, member);
  if (problem !== undefined) return { problem };
  const path = member.registeredPath!;
  try { return { bytes: readFileSync(join(dir, path)) }; }
  catch { return { problem: `${path} cannot be read in the collection work tree` }; }
}

function captureCurrentPin(dir: string, member: Member, git: CollectionGit | undefined, head: string | undefined): CurrentRigPin | Finding {
  const working = readCurrentMemberBytes(dir, member);
  if ('problem' in working) return unverifiedCurrentPin(member.path, member.name, working.problem);
  let project: JsonObject | undefined;
  try { project = parseRecord(working.bytes); } catch { /* The rig is unreadable. */ }
  const rig = currentRig(project ?? null);
  const shape = currentShapeFindings('rig', rig, project)[0];
  if (shape !== undefined) {
    return { code: 'PIN_NO_BUILD', path: member.path, message: `${member.path}: no valid recorded rig (${shape.path}). Build and run rig-create record rig before pinning.` };
  }
  if (head === undefined || !GIT_OID.test(head)) return unverifiedCurrentPin(member.path, member.name, 'the collection HEAD is not a readable commit');
  const pin: CurrentRigPin = {
    member: member.name, kind: 'current-rig',
    record: { path: member.registeredPath!, sha256: sha256(working.bytes), commit: head },
    rig: { files_sha256: String(rig?.files_sha256) },
  };
  const problem = currentPinProblem(member, pin, git, working.bytes);
  return problem === undefined ? pin : unverifiedCurrentPin(member.path, member.name, problem);
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
 * Builds pins from an explicitly selected rig version or the member's latest.
 * Refuses by member name — all of them, not the first — a member with
 * no project record, no rig version, no rig file, or a file on disk that no
 * longer hashes to the version that lists it (rebuilt in place: record a new
 * member version first, so the pin names a build that exists).
 */
export function buildPins(dir: string, collection: JsonObject, selectors: string[] = []): { pins: Pin[]; refusals: Finding[] } {
  const refusals: Finding[] = [];
  const members = readMembers(dir, collection, refusals);
  const selected = new Map<string, number>();
  for (const selector of selectors) {
    const match = /^([^=]+)=([1-9][0-9]*)$/.exec(selector);
    const name = match?.[1];
    const n = Number(match?.[2]);
    if (name === undefined || !Number.isSafeInteger(n) || selected.has(name) || !members.some(m => m.name === name)) {
      refusals.push({ code: 'PIN_SELECTION_INVALID', path: 'members', message: `members: invalid or duplicate --member ${selector}; supply each registered name once as name=positive-integer-version` });
      continue;
    }
    selected.set(name, n);
  }
  if (members.length === 0 && refusals.length === 0) {
    refusals.push({ code: 'PIN_NO_MEMBERS', path: 'members', message: 'collection.json members[] is empty; there is nothing to pin' });
  }
  const pins: Pin[] = [];
  let git: CollectionGit | undefined;
  let head: string | undefined;
  for (const m of members) {
    if (m.project === null) {
      refusals.push({ code: 'MEMBER_PROJECT_MISSING', path: m.path, message: `${m.path}: ${m.why}` });
      continue;
    }
    const wanted = selected.get(m.name);
    if (isCurrentProject(m.project)) {
      if (wanted !== undefined) {
        refusals.push({ code: 'PIN_SELECTION_INVALID', path: m.path, message: `${m.path}: --member cannot select a numbered version for a current member. Omit its --member selector to pin current.rig.` });
        continue;
      }
      if (git === undefined) {
        git = openCollectionGit(dir);
        head = git?.(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.toString('utf8').trim();
      }
      const pin = captureCurrentPin(dir, m, git, head);
      if ('code' in pin) refusals.push(pin);
      else pins.push(pin);
      continue;
    }
    const version = wanted === undefined ? latestRigVersion(m.project) : asArray(m.project.versions).filter(isObject).find(v => v.n === wanted && (v.kind === undefined || v.kind === 'rig')) ?? null;
    if (wanted !== undefined && version === null) {
      refusals.push({ code: 'PIN_SELECTION_INVALID', path: m.path, message: `${m.path}: selected rig version ${wanted} is absent from versions[]; select an existing rig version` });
      continue;
    }
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
    pins.push({ member: m.name, version: n, rigs, ...(wanted === undefined ? {} : { selection: 'explicit' as const }) });
  }
  const currentNames = new Set(pins.filter(pin => 'kind' in pin).map(pin => pin.member));
  for (const name of currentNames) {
    if (members.filter(member => member.name === name).length < 2) continue;
    const path = `members[${name}]`;
    refusals.push({ code: 'PIN_MALFORMED', path, message: `${path}: duplicate registrations for a current-rig member. Keep one registration and rerun collection pin.` });
  }
  return { pins, refusals };
}

function collectionOutputs(dir: string, n: number): PinResult['outputs'] {
  return listFiles(join(dir, 'outputs', `v${n}`)).map(file => {
    const bytes = readFileSync(file);
    return { path: relative(dir, file).split('\\').join('/'), sha256: sha256(bytes), bytes: bytes.length };
  });
}

function pinSourceDrift(path: string, problem: string): Finding {
  return { code: 'PIN_SOURCE_DRIFT', path, message: `${path}: ${problem}. Reread the collection and retry pinning against stable member records and outputs.` };
}

/** Writes a new `versions[]` entry with pins and the hashed `outputs/v<N>/` files. */
export function pinCollection(dirArg: string, changed: string | null, now: Date, selectors: string[] = []): { result: PinResult | null; refusals: Finding[]; dir: string } {
  const dir = resolve(dirArg);
  const file = join(dir, 'collection.json');
  if (!existsSync(file)) refuse('COLLECTION_JSON_MISSING', `${file} does not exist; run in a collection folder or name one`);
  let original: Buffer;
  let collection: JsonObject | undefined;
  try {
    original = readFileSync(file);
    collection = parseRecord(original);
  } catch (error) { return refuse('COLLECTION_JSON_INVALID', `${file}: ${error instanceof Error ? error.message : String(error)}`); }
  if (collection === undefined) refuse('COLLECTION_JSON_INVALID', `${file}: not a JSON object`);
  if (collection.schema !== COLLECTION_SCHEMA) refuse('SCHEMA_UNKNOWN', `${file}: schema is ${JSON.stringify(collection.schema ?? null)}; this reads ${COLLECTION_SCHEMA}`);
  const { pins, refusals } = buildPins(dir, collection, selectors);
  if (refusals.length > 0) return { result: null, refusals, dir };
  const versions = asArray(collection.versions);
  const n = versions.reduce<number>((max, v) => (isObject(v) && typeof v.n === 'number' && v.n > max ? v.n : max), 0) + 1;
  const currentPins = pins.filter(pin => 'kind' in pin);
  const outputPath = `outputs/v${n}`;
  let outputs: PinResult['outputs'];
  try { outputs = collectionOutputs(dir, n); }
  catch (error) {
    if (currentPins.length === 0) throw error;
    return { result: null, refusals: [pinSourceDrift(outputPath, 'the collection outputs could not be read while pinning')], dir };
  }
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
  const release = tryJobDirectoryLock(`${file}.pin.lock`);
  if (!release) return { result: null, refusals: [pinSourceDrift('collection.json', 'another collection pin writer is active')], dir };
  try {
    for (const pin of currentPins) {
      const live = readCurrentMemberBytes(dir, { name: pin.member, registeredPath: pin.record.path });
      if ('problem' in live || sha256(live.bytes) !== pin.record.sha256) {
        refusals.push(pinSourceDrift(`members[${pin.member}]`, `${pin.record.path} changed while pinning`));
      }
    }
    if (currentPins.length > 0) {
      let unchanged = false;
      try { unchanged = isDeepStrictEqual(collectionOutputs(dir, n), outputs); } catch { /* Refuse below. */ }
      if (!unchanged) refusals.push(pinSourceDrift(outputPath, 'the collection outputs changed while pinning'));
    }
    let recordUnchanged = false;
    try {
      recordUnchanged = (currentPins.length === 0 || lstatSync(file).isFile()) && readFileSync(file).equals(original);
    } catch { /* Refuse below. */ }
    if (!recordUnchanged) refusals.push(pinSourceDrift('collection.json', 'the collection record changed or is no longer a regular file'));
    if (refusals.length > 0) return { result: null, refusals, dir };
    const bytes = `${JSON.stringify(collection, null, 2)}\n`;
    if (currentPins.length === 0) {
      writeFileSync(file, bytes);
    } else {
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, bytes, { flag: 'wx', mode: statSync(file).mode & 0o777 });
        renameSync(temp, file);
      } finally { rmSync(temp, { force: true }); }
    }
  } finally { release(); }
  return { result: { version: n, pins, outputs }, refusals: [], dir };
}

// ------------------------------------------------------------------ checking

interface StoredPin {
  pin: Pin;
  index: number;
}

function readPins(raw: Json | undefined, version: number, currentMembers: ReadonlySet<string>, refusals: Finding[]): StoredPin[] {
  const pins: StoredPin[] = [];
  const seen = new Set<string>();
  asArray(raw).forEach((p, index) => {
    const member = isObject(p) ? asString(p.member) : null;
    if (member !== null && currentMembers.has(member)) {
      if (seen.has(member)) {
        const path = `versions[n=${version}].pins[${index}]`;
        refusals.push({ code: 'PIN_MALFORMED', path, message: `${path} (${member}): duplicate pin for a member with a current-rig pin. Restore a single verified pin for this member or record a new collection pin.` });
        return;
      }
      seen.add(member);
    }
    if (isObject(p) && p.kind === 'current-rig') {
      const { record, rig } = p;
      const path = `versions[n=${version}].pins[${index}]`;
      if (member === null || !isObject(record) || typeof record.path !== 'string' || record.path === ''
        || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)
        || typeof record.commit !== 'string' || !GIT_OID.test(record.commit)
        || !isObject(rig) || typeof rig.files_sha256 !== 'string' || !SHA256.test(rig.files_sha256)) {
        refusals.push({ code: 'PIN_MALFORMED', path, message: `${path}: a current-rig pin needs member, record { path, sha256, commit } with a full commit ID, and rig { files_sha256 }. Restore the pin or run collection pin again.` });
        return;
      }
      pins.push({ index, pin: { member, kind: 'current-rig', record: { path: record.path, sha256: record.sha256, commit: record.commit }, rig: { files_sha256: rig.files_sha256 } } });
      return;
    }
    if (!isObject(p) || member === null || (p.version !== null && typeof p.version !== 'number') || !Array.isArray(p.rigs)) {
      refusals.push({ code: 'PIN_MALFORMED', path: `versions[${version}].pins[${index}]`, message: `versions[n=${version}].pins[${index}]: a pin is { member, version (number or null), rigs[] }` });
      return;
    }
    if (p.selection !== undefined && (p.selection !== 'explicit' || typeof p.version !== 'number' || !Number.isSafeInteger(p.version) || p.version < 1)) {
      refusals.push({ code: 'PIN_SELECTION_INVALID', path: `versions[${version}].pins[${index}]`, message: `versions[n=${version}].pins[${index}]: selection must be explicit with a positive integer rig version; restore the pin or record a new collection pin --member name=version` });
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
    pins.push({ index, pin: { member, version: p.version as number | null, rigs, ...(p.selection === 'explicit' ? { selection: 'explicit' as const } : {}) } });
  });
  return pins;
}

/** Every way a member's current build differs from its pin, one refusal each, all naming the member. */
function comparePin(m: Member, project: JsonObject, pin: NumberedPin, cv: number, refusals: Finding[]): void {
  const stale = (message: string): void => {
    refusals.push({ code: 'PIN_STALE', path: m.path, message: `${m.path}: ${message}; collection v${cv}'s output is stale until a new collection version pins it` });
  };
  const version = pin.selection === 'explicit' ? asArray(project.versions).filter(isObject).find(v => v.n === pin.version && (v.kind === undefined || v.kind === 'rig')) ?? null : latestRigVersion(project);
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
    stale(pin.selection === 'explicit' ? `recorded rig version ${pin.version} no longer exists for explicit pin v${cv}` : `has no rig version; pin v${cv} names version ${pin.version}`);
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
      } else if (current(build) !== f.sha256 || (pin.selection === 'explicit' && build.recorded !== null && build.recorded !== f.sha256)) {
        stale(`${f.role} sha256 differs from pin v${cv} (${f.path}, variant ${rig.variant}${build.on_disk !== null ? ', hashed on disk' : ''})`);
      }
    }
  }
  for (const f of files) {
    if (!pinned.has(fileKey(f.variant, f.role, f.path))) stale(`${f.role} ${f.path} (variant ${f.variant}) of version ${n} is not pinned in v${cv}`);
  }
}

function shownCollectionVersion(collection: JsonObject): JsonObject | undefined {
  return asArray(collection.versions).filter(isObject)
    .filter((v) => typeof v.n === 'number' && asArray(v.outputs).length > 0)
    .sort((a, b) => (b.n as number) - (a.n as number))[0];
}

function checkPins(dir: string, shown: JsonObject, pins: StoredPin[], members: Member[], refusals: Finding[], warnings: Finding[]): void {
  const cv = shown.n as number;
  const git = pins.some(({ pin }) => 'kind' in pin) ? openCollectionGit(dir) : undefined;
  for (const m of members) {
    const stored = pins.find(({ pin }) => pin.member === m.name);
    if (stored === undefined) {
      if (m.project === null) continue;
      refusals.push({ code: 'PIN_MISSING', path: m.path, message: `${m.path}: is a member but collection v${cv} has no pin for it; its output was not made from a pinned build of this member` });
      continue;
    }
    const { pin, index } = stored;
    if ('kind' in pin) {
      const path = `versions[n=${cv}].pins[${index}]`;
      const problem = currentPinProblem(m, pin, git);
      if (problem !== undefined) {
        refusals.push(unverifiedCurrentPin(path, m.name, problem));
        continue;
      }
      const live = asString(currentRig(m.project)?.files_sha256);
      const pinned = pin.rig.files_sha256;
      if (live !== pinned) {
        const comparison = live !== null && SHA256.test(live) ? `live rig ${live.slice(0, 12)}` : 'no live rig to compare';
        warnings.push({ code: 'PIN_MEMBER_EARLIER', path, message: `${path} (${m.name}): commit ${pin.record.commit} pins rig ${pinned.slice(0, 12)}, ${comparison}. Keep the pinned output, or make a new output and pin the live rig.` });
      }
    } else if (m.project !== null) {
      comparePin(m, m.project, pin, cv, refusals);
    }
  }
  for (const { pin: p } of pins) {
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
}

/** Collection answers as `interview --check` reads a project's, against the collection's own stages. */
export function checkCollectionRecord(collection: JsonObject, stage: string, refusals: Finding[], warnings: Finding[] = []): string {
  checkScratchBindings(collection, refusals, warnings);
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
      const raw = item[field];
      if (isObject(raw) && 'deferred' in raw) {
        const deferred = raw.deferred;
        const deadline = isObject(deferred) ? order.indexOf(String(deferred.until_stage)) : -1;
        const valid = name === 'questions' && item.scope === 'collection'
          && Object.keys(raw).length === 1 && isObject(deferred)
          && ['by', 'at', 'reason'].every(key => typeof deferred[key] === 'string' && String(deferred[key]).trim() !== '')
          && Number.isFinite(Date.parse(String(deferred.at))) && typeof deferred.until_stage === 'string' && deadline >= 0;
        if (!valid) {
          refusals.push({ code: 'ANSWER_MALFORMED', path, message: `${path}: a collection question deferral needs by, valid at, reason and an ordered until_stage (not paused); record it with collection answer --defer-until` });
        } else if (cur < deadline) {
          warnings.push({ code: 'COLLECTION_ANSWER_DEFERRED', path, message: `${path}: deferred by ${String(deferred.by)} until ${String(deferred.until_stage)} (${String(deferred.reason)}); record an answer with collection answer --value-file before that stage` });
        } else {
          refusals.push({ code: cur === deadline ? 'INTERVIEW_INCOMPLETE' : 'COLLECTION_ITEM_SILENT', path, message: `${path}: deferral reached ${String(deferred.until_stage)}; record an answer with collection answer --value-file` });
        }
        continue;
      }
      const state = classify(raw, { collection: null });
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
  return inspectCollection(dirArg).report;
}

/** The same collection read used by both check and next. */
export function inspectCollection(dirArg: string): { report: CollectionReport; hasCurrentMembers: boolean } {
  const dir = resolve(dirArg);
  const refusals: Finding[] = [];
  const warnings: Finding[] = [];
  const fail = () => ({ hasCurrentMembers: false, report: { kind: 'collection' as const, ok: false, collection_dir: dir, stage: null, effective_stage: null, members: [], pins_checked: null, refusals, warnings } });
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
    warnings.push({ code: 'STAGE_VALUES_STALE', path: 'stage_values', message: `stage_values is [${recordValues.join(', ')}]; the collection order is [${COLLECTION_STAGE_VALUES.join(', ')}]; no collection writer rewrites this list, and the warning blocks nothing` });
  }
  const effective = checkCollectionRecord(collection, stage, refusals, warnings);
  const shown = shownCollectionVersion(collection);
  const pinRefusals: Finding[] = [];
  const currentMembers = new Set(asArray(shown?.pins).filter(isObject)
    .flatMap(pin => pin.kind === 'current-rig' && typeof pin.member === 'string' ? [pin.member] : []));
  const pins = shown === undefined ? [] : readPins(shown.pins, shown.n as number, currentMembers, pinRefusals);
  const members = readMembers(dir, collection, refusals, currentMembers);
  for (const m of members) {
    if (m.why !== null) refusals.push({ code: 'MEMBER_PROJECT_MISSING', path: m.path, message: `${m.path}: ${m.why}` });
  }
  const membersDir = join(dir, 'members');
  if (existsSync(membersDir) && (currentMembers.size === 0 || lstatSync(membersDir, { throwIfNoEntry: false })?.isDirectory())) {
    for (const entry of readdirSync(membersDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !members.some((m) => basename(m.dir) === entry.name)) {
        warnings.push({ code: 'MEMBER_UNREGISTERED', path: `members/${entry.name}`, message: `members/${entry.name}/ is not in collection.json members[]; register it (rig-create init --member makes and registers a member)` });
      }
    }
  }
  refusals.push(...pinRefusals);
  if (shown !== undefined) checkPins(dir, shown, pins, members, refusals, warnings);
  return {
    hasCurrentMembers: members.some(m => m.project !== null && isCurrentProject(m.project)),
    report: { kind: 'collection', ok: refusals.length === 0, collection_dir: dir, stage, effective_stage: effective, members: members.map(m => m.name), pins_checked: shown === undefined ? null : shown.n as number, refusals, warnings },
  };
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
  answer <question> [<dir>] --by <who>
    (--value-file <answer JSON file> | --defer-until <stage> --reason-file <file>)
                   record a collection-scope answer or defer it until a later lifecycle stage;
                   retain the prior answer in history when present, without changing other fields
  pin [<dir>] [--changed <sentence>] [--member <name>=<version>]...
                   pin each committed current rig or a numbered rig (--member selects a numbered version),
                   and hash the collection's outputs/v<N>/
  --check [<dir>] [--json]
                   verify the member pins of the latest collection version with outputs and check the collection
                   record (stage, sign-offs, answers, members[]) (docs/CHECKS.md)`;

export function collectionCommand(args: string[], now: number): CommandResult {
  const [first, ...rest] = args;
  if (first === 'answer') return collectionAnswerCommand(rest, now);
  if (first === 'pin') {
    let changed: string | null = null;
    const selectors: string[] = [];
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === '--changed') {
        const value = rest[++i];
        if (value === undefined) refuse('COLLECTION_USAGE', '--changed takes a sentence', USAGE_EXIT);
        changed = value;
      } else if (arg === '--member') {
        const value = rest[++i];
        if (value === undefined || value.startsWith('--')) refuse('PIN_SELECTION_INVALID', 'members: --member needs name=version; supply a registered member and existing rig version', USAGE_EXIT);
        selectors.push(value);
      } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `collection pin does not take ${arg}`, USAGE_EXIT);
      else positional.push(arg);
    }
    if (positional.length > 1) refuse('COLLECTION_USAGE', `collection pin takes one folder, got ${positional.join(' ')}`, USAGE_EXIT);
    const { result, refusals, dir } = pinCollection(positional[0] ?? process.cwd(), changed, new Date(now), selectors);
    if (result === null) {
      const lines = [`collection pin: ${dir}`, ...refusals.map((r) => `  REFUSED ${r.code}: ${r.message}`), `not pinned: ${refusals.length} refusal${refusals.length === 1 ? '' : 's'}`];
      return { stdout: lines.join('\n'), exit: 1 };
    }
    const lines = [
      `collection pin: ${dir}`,
      `  collection v${result.version}: ${result.pins.map(p => 'kind' in p ? `${p.member} current.rig @ ${p.record.commit}` : `${p.member} v${p.version}`).join(', ')}`,
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
