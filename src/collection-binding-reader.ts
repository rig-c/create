import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import type { Json, JsonObject } from './templates.ts';

export const COLLECTION_SCHEMA = 'rig-create/collection@0';
export const COLLECTION_BINDING_SPEC = 'rig-create/collection-binding@1';
export const DEFAULT_COLLECTION_BINDING_PATH = 'evidence/collection-binding.json';

export const IGNORED_BINDING_ROOTS = new Set([
  '.git',
  'node_modules',
  '.rig-create-review',
  '.rig-review',
  'derived',
  'outputs',
  'scratch',
  'jobs',
  'build',
  'dist',
]);

export interface CollectionBindingFinding {
  readonly code: 'JOB_RECORD_COLLECTION_EXTERNAL';
  readonly path: string;
  readonly message: string;
}

export interface CollectionBindingVerification {
  readonly valid: boolean;
  readonly boundCollection: JsonObject | null;
  readonly bindingFile: { readonly path: string; readonly sha256: string } | null;
  readonly finding: CollectionBindingFinding | null;
}

function isObject(v: Json | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

function asArray(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isLiveMemberRoot(dir: string): boolean {
  return basename(dirname(resolve(dir))) === 'members';
}

export function externalCollectionFile(dir: string): string {
  return join(dirname(dirname(resolve(dir))), 'collection.json');
}

export function isValidCollectionBindingPath(path: string): boolean {
  if (typeof path !== 'string' || !path || !path.endsWith('.json')) return false;
  if (/[\\:%?#\x00-\x1f]/.test(path)) return false;
  const pieces = path.split('/');
  if (pieces.some((piece) => !piece || piece === '.' || piece === '..' || piece.startsWith('.'))) return false;
  if (IGNORED_BINDING_ROOTS.has(pieces[0]!)) return false;
  if (path === 'project.json' || path === 'package.json') return false;
  return true;
}

const candidateStack: { readonly dir: string; readonly project: JsonObject }[] = [];

/**
 * Scope `loadCollection` calls inside `checkProjectOnce` or writer validation
 * so nested checks that call `loadCollection(dir)` without a `project` argument
 * read the in-memory candidate rather than a stale on-disk `project.json`.
 */
export function withCandidateProject<T>(dir: string, project: JsonObject, fn: () => T): T {
  const entry = { dir: resolve(dir), project };
  candidateStack.push(entry);
  try {
    return fn();
  } finally {
    candidateStack.pop();
  }
}

function parseJsonObjectBytes(bytes: Buffer): { ok: true; value: JsonObject } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not a JSON object' };
  }
  return { ok: true, value: parsed as JsonObject };
}

function resolveProjectRecord(dir: string, project?: JsonObject): JsonObject | null {
  if (project !== undefined) return project;
  const resolved = resolve(dir);
  for (let i = candidateStack.length - 1; i >= 0; i--) {
    if (candidateStack[i]!.dir === resolved) return candidateStack[i]!.project;
  }
  const file = join(resolved, 'project.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = parseJsonObjectBytes(readFileSync(file));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

export function readRegularBindingFile(dir: string, relPath: string): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
  if (!isValidCollectionBindingPath(relPath)) {
    return { ok: false, reason: `${relPath} is not a safe project-relative JSON path outside ignored roots` };
  }
  const resolvedRoot = resolve(dir);
  let realRoot = resolvedRoot;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch {
    return { ok: false, reason: `${resolvedRoot} is not a readable directory` };
  }
  const absolute = join(realRoot, relPath);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, reason: `${relPath} must be a regular file without symlinks` };
    }
    if (realpathSync(absolute) !== absolute) {
      return { ok: false, reason: `${relPath} must resolve inside the project root without symlinks` };
    }
    return { ok: true, bytes: readFileSync(absolute) };
  } catch {
    return { ok: false, reason: `${relPath} does not exist or is unreadable` };
  }
}

export function readExternalCollection(dir: string): {
  readonly liveMember: boolean;
  readonly file: string;
  readonly exists: boolean;
  readonly rawBytes: Buffer | null;
  readonly sha256: string | null;
  readonly collection: JsonObject | null;
  readonly error: string | null;
} {
  const liveMember = isLiveMemberRoot(dir);
  const file = externalCollectionFile(dir);
  if (!liveMember) {
    return { liveMember: false, file, exists: false, rawBytes: null, sha256: null, collection: null, error: null };
  }
  if (!existsSync(file)) {
    return { liveMember: true, file, exists: false, rawBytes: null, sha256: null, collection: null, error: `${file} does not exist` };
  }
  let rawBytes: Buffer;
  try {
    rawBytes = readFileSync(file);
  } catch (e) {
    return { liveMember: true, file, exists: true, rawBytes: null, sha256: null, collection: null, error: e instanceof Error ? e.message : String(e) };
  }
  const sha256 = sha256Hex(rawBytes);
  const parsed = parseJsonObjectBytes(rawBytes);
  if (!parsed.ok) {
    return { liveMember: true, file, exists: true, rawBytes, sha256, collection: null, error: parsed.error };
  }
  return { liveMember: true, file, exists: true, rawBytes, sha256, collection: parsed.value, error: null };
}

function normalizeQuestionEntries(raw: Json | undefined, valueKey: 'answer' | 'guide'): JsonObject[] | null {
  if (!Array.isArray(raw)) return null;
  const out: JsonObject[] = [];
  for (const entry of raw) {
    if (!isObject(entry) || typeof entry.id !== 'string' || entry.id.trim() === '') return null;
    if (entry.history !== undefined && !Array.isArray(entry.history)) return null;
    const history = Array.isArray(entry.history) ? entry.history : [];
    if (history.some((h) => !isObject(h))) return null;
    out.push({
      id: entry.id,
      [valueKey]: entry[valueKey] ?? null,
      history,
    });
  }
  return out;
}

/**
 * Extracts the exact interview/history snapshot from a `collection.json` record
 * without computing or re-deriving any producer measurements.
 */
export function extractCollectionInterviewSnapshot(collection: JsonObject): JsonObject | null {
  if (!isObject(collection.interview)) return null;
  const interview = collection.interview;
  const post = isObject(interview.post) ? interview.post : null;
  if (post === null) return null;
  const questions = normalizeQuestionEntries(interview.questions, 'answer');
  const framing = normalizeQuestionEntries(interview.framing, 'answer');
  const waypoints = normalizeQuestionEntries(interview.waypoints, 'guide');
  const postItems = normalizeQuestionEntries(post.items, 'guide');
  if (questions === null || framing === null || waypoints === null || postItems === null) return null;
  return {
    questions,
    framing,
    waypoints,
    post: { items: postItems },
  };
}

function lookupCollectionAnswer(collection: JsonObject, question: string): Json | undefined {
  const interview = isObject(collection.interview) ? collection.interview : {};
  for (const q of asArray(interview.questions)) if (isObject(q) && q.id === question) return q.answer;
  for (const q of asArray(interview.framing)) if (isObject(q) && q.id === question) return q.answer;
  for (const w of asArray(interview.waypoints)) if (isObject(w) && w.id === question) return w.guide;
  const post = isObject(interview.post) ? interview.post : {};
  for (const p of asArray(post.items)) if (isObject(p) && p.id === question) return p.guide;
  return undefined;
}

export function projectUsesCollection(project: JsonObject): boolean {
  if (typeof project.collection === 'string' && project.collection.trim() !== '') return true;
  const interview = isObject(project.interview) ? project.interview : {};
  const post = isObject(interview.post) ? interview.post : {};
  const lists: [Json | undefined, 'answer' | 'guide'][] = [
    [interview.framing, 'answer'],
    [interview.waypoints, 'guide'],
    [post.items, 'guide'],
  ];
  for (const [list, key] of lists) {
    for (const item of asArray(list)) {
      if (!isObject(item)) continue;
      for (const candidate of [item[key], ...asArray(item.history)]) {
        if (isObject(candidate) && (candidate.basis === 'inherited' || candidate.basis === 'overridden')) return true;
      }
    }
  }
  return false;
}

export function extractInheritedAnswers(
  project: JsonObject,
  collection: JsonObject,
): { readonly ok: true; readonly answers: JsonObject } | { readonly ok: false; readonly reason: string } {
  const collectionName = typeof collection.name === 'string' ? collection.name : '';
  if (!collectionName) return { ok: false, reason: 'collection has no name' };
  if (project.collection !== undefined && project.collection !== null && project.collection !== collectionName) {
    return { ok: false, reason: `project.collection is ${JSON.stringify(project.collection)}, not ${JSON.stringify(collectionName)}` };
  }
  const interview = isObject(project.interview) ? project.interview : {};
  const post = isObject(interview.post) ? interview.post : {};
  const lists: [Json | undefined, 'answer' | 'guide', string][] = [
    [interview.framing, 'answer', 'interview.framing'],
    [interview.waypoints, 'guide', 'interview.waypoints'],
    [post.items, 'guide', 'interview.post.items'],
  ];
  const answers: JsonObject = {};
  for (const [list, key, prefix] of lists) {
    for (const item of asArray(list)) {
      if (!isObject(item) || typeof item.id !== 'string') continue;
      const raw = item[key];
      if (isObject(raw) && raw.basis === 'inherited') {
        const from = isObject(raw.from) ? raw.from : null;
        const fromCollection = from !== null && typeof from.collection === 'string' ? from.collection : null;
        const fromQuestion = from !== null && typeof from.question === 'string' ? from.question : null;
        if (fromCollection === null || fromQuestion === null) {
          return { ok: false, reason: `${prefix}[${item.id}].${key}: inherited answer needs from.collection and from.question` };
        }
        if (fromCollection !== collectionName) {
          return { ok: false, reason: `${prefix}[${item.id}].${key}: inherits from collection '${fromCollection}', not '${collectionName}'` };
        }
        const resolved = lookupCollectionAnswer(collection, fromQuestion);
        if (resolved === undefined) {
          return { ok: false, reason: `${prefix}[${item.id}].${key}: collection '${collectionName}' does not ask '${fromQuestion}'` };
        }
        if (resolved === null || (isObject(resolved) && ('deferred' in resolved || resolved.value === 'per-member'))) {
          return { ok: false, reason: `${prefix}[${item.id}].${key}: collection '${collectionName}' answer '${fromQuestion}' is not an inheritable collection answer` };
        }
        answers[fromQuestion] = resolved;
      }
      for (const entry of [raw, ...asArray(item.history)]) {
        if (!isObject(entry) || entry.basis !== 'overridden') continue;
        const ov = isObject(entry.overrides) ? entry.overrides : null;
        const ovCollection = ov !== null && typeof ov.collection === 'string' ? ov.collection : null;
        if (ovCollection !== collectionName) {
          return { ok: false, reason: `${prefix}[${item.id}].${key}: overrides.collection is ${JSON.stringify(ovCollection)}, not '${collectionName}'` };
        }
      }
    }
  }
  return { ok: true, answers };
}

function failBinding(path: string, detail: string): CollectionBindingVerification {
  return {
    valid: false,
    boundCollection: null,
    bindingFile: null,
    finding: {
      code: 'JOB_RECORD_COLLECTION_EXTERNAL',
      path,
      message: `${path}: ${detail}; bind the current ../../collection.json with rig-create collection-binding <member dir>`,
    },
  };
}

export function verifyCollectionBinding(
  dir: string,
  project: JsonObject,
  options: { readonly requireBindingWhenExternal?: boolean } = {},
): CollectionBindingVerification {
  const external = readExternalCollection(dir);
  const hasPointer = project.collection_binding !== undefined && project.collection_binding !== null;

  if (!hasPointer) {
    if (external.liveMember && options.requireBindingWhenExternal) {
      return failBinding(
        'project.json',
        "a member record's inherited answers depend on ../../collection.json, which the project-relative closure cannot seal without collection_binding",
      );
    }
    if (!external.liveMember && options.requireBindingWhenExternal && projectUsesCollection(project)) {
      return failBinding(
        'collection_binding',
        'member record references a collection without a retained collection_binding',
      );
    }
    return { valid: true, boundCollection: null, bindingFile: null, finding: null };
  }

  if (!isObject(project.collection_binding)) {
    return failBinding('collection_binding', 'collection_binding must be an object with path, sha256, spec, and collection_sha256');
  }
  const pointer = project.collection_binding;
  if (pointer.spec !== COLLECTION_BINDING_SPEC) {
    return failBinding('collection_binding.spec', `collection_binding.spec is ${JSON.stringify(pointer.spec ?? null)}, expected ${COLLECTION_BINDING_SPEC}`);
  }
  if (typeof pointer.path !== 'string' || !isValidCollectionBindingPath(pointer.path)) {
    return failBinding('collection_binding.path', 'collection_binding.path must be a safe project-relative .json path outside ignored roots');
  }
  if (typeof pointer.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pointer.sha256)) {
    return failBinding('collection_binding.sha256', 'collection_binding.sha256 must be a 64-character lowercase hex sha256');
  }
  if (typeof pointer.collection_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pointer.collection_sha256)) {
    return failBinding('collection_binding.collection_sha256', 'collection_binding.collection_sha256 must be a 64-character lowercase hex sha256');
  }

  const fileRead = readRegularBindingFile(dir, pointer.path);
  if (!fileRead.ok) {
    return failBinding('collection_binding.path', fileRead.reason);
  }
  const actualSha256 = sha256Hex(fileRead.bytes);
  if (actualSha256 !== pointer.sha256) {
    return failBinding('collection_binding.sha256', `${pointer.path} sha256 is ${actualSha256}, not bound ${pointer.sha256}`);
  }

  const parsed = parseJsonObjectBytes(fileRead.bytes);
  if (!parsed.ok) {
    return failBinding(pointer.path, `invalid JSON in ${pointer.path}: ${parsed.error}`);
  }
  const snapshot = parsed.value;
  if (snapshot.schema !== COLLECTION_BINDING_SPEC) {
    return failBinding(pointer.path, `${pointer.path} schema is ${JSON.stringify(snapshot.schema ?? null)}, expected ${COLLECTION_BINDING_SPEC}`);
  }
  if (!isObject(snapshot.collection) || typeof snapshot.collection.name !== 'string' || snapshot.collection.name.trim() === '') {
    return failBinding(pointer.path, `${pointer.path} collection.name must be a non-empty string`);
  }
  if (snapshot.collection.sha256 !== pointer.collection_sha256) {
    return failBinding(pointer.path, `${pointer.path} collection.sha256 does not match collection_binding.collection_sha256`);
  }
  if (typeof project.name !== 'string' || project.name.trim() === '' || snapshot.member !== project.name) {
    return failBinding(pointer.path, `${pointer.path} member ${JSON.stringify(snapshot.member ?? null)} does not match project.name ${JSON.stringify(project.name ?? null)}`);
  }
  if (project.collection !== undefined && project.collection !== null && project.collection !== snapshot.collection.name) {
    return failBinding('collection', `project.collection ${JSON.stringify(project.collection)} does not match bound collection '${snapshot.collection.name}'`);
  }
  if (external.liveMember && basename(resolve(dir)) !== project.name) {
    return failBinding('name', `member folder '${basename(resolve(dir))}' does not match project.name '${project.name}'`);
  }

  const normalizedSnapshotInterview = extractCollectionInterviewSnapshot({ interview: snapshot.interview });
  if (normalizedSnapshotInterview === null || !isDeepStrictEqual(snapshot.interview, normalizedSnapshotInterview)) {
    return failBinding(pointer.path, `${pointer.path} interview snapshot is malformed`);
  }
  if (!isObject(snapshot.inherited_answers)) {
    return failBinding(pointer.path, `${pointer.path} inherited_answers must be an object`);
  }

  const boundCollection: JsonObject = {
    schema: COLLECTION_SCHEMA,
    name: snapshot.collection.name,
    interview: snapshot.interview,
  };
  const fromSnapshot = extractInheritedAnswers(project, boundCollection);
  if (!fromSnapshot.ok) {
    return failBinding(pointer.path, fromSnapshot.reason);
  }
  if (!isDeepStrictEqual(snapshot.inherited_answers, fromSnapshot.answers)) {
    return failBinding(pointer.path, `${pointer.path} inherited_answers does not match the member's inherited items and bound interview`);
  }

  // In a live member root (<collection>/members/<name>), external ../../collection.json
  // must exist, parse cleanly, and match the bound snapshot byte-for-byte and answer-for-answer.
  if (external.liveMember) {
    if (!external.exists || external.collection === null || external.sha256 === null) {
      return failBinding('collection_binding', `external ../../collection.json is missing or unreadable (${external.error ?? 'missing'})`);
    }
    if (external.collection.schema !== COLLECTION_SCHEMA) {
      return failBinding('collection_binding', `external ../../collection.json schema is ${JSON.stringify(external.collection.schema ?? null)}, not ${COLLECTION_SCHEMA}`);
    }
    if (external.collection.name !== snapshot.collection.name) {
      return failBinding('collection_binding', `external ../../collection.json name is ${JSON.stringify(external.collection.name ?? null)}, not bound '${snapshot.collection.name}'`);
    }
    if (
      Array.isArray(external.collection.members) &&
      external.collection.members.length > 0 &&
      !external.collection.members.some((m) => isObject(m) && m.name === project.name)
    ) {
      return failBinding('collection_binding', `member '${project.name}' is not listed in external ../../collection.json members[]`);
    }
    if (external.sha256 !== pointer.collection_sha256) {
      return failBinding('collection_binding.collection_sha256', `external ../../collection.json sha256 changed from bound ${pointer.collection_sha256} to ${external.sha256}`);
    }
    const externalInterview = extractCollectionInterviewSnapshot(external.collection);
    if (externalInterview === null || !isDeepStrictEqual(snapshot.interview, externalInterview)) {
      return failBinding(pointer.path, `${pointer.path} interview/history snapshot differs from external ../../collection.json`);
    }
    const fromExternal = extractInheritedAnswers(project, external.collection);
    if (!fromExternal.ok || !isDeepStrictEqual(snapshot.inherited_answers, fromExternal.answers)) {
      return failBinding(pointer.path, `${pointer.path} inherited_answers differs from external ../../collection.json`);
    }
  }

  return {
    valid: true,
    boundCollection,
    bindingFile: { path: pointer.path, sha256: pointer.sha256 },
    finding: null,
  };
}

/**
 * Loads the collection record for `dir`:
 * - In a live member root (`basename(dirname(dir)) === 'members'`), reads ONLY
 *   the external `../../collection.json` and never falls back to a bound snapshot
 *   if the external file is missing or malformed.
 * - Outside a live member root (such as an isolated `retained` root), returns the
 *   verified bound collection snapshot when `project.collection_binding` is valid.
 */
export function loadCollectionForDir(dir: string, project?: JsonObject): JsonObject | null {
  if (isLiveMemberRoot(dir)) {
    const external = readExternalCollection(dir);
    return external.collection;
  }
  const record = resolveProjectRecord(dir, project);
  if (record === null || record.collection_binding === undefined || record.collection_binding === null) {
    return null;
  }
  const verified = verifyCollectionBinding(dir, record);
  return verified.valid ? verified.boundCollection : null;
}

export function checkCollectionBinding(
  dir: string,
  project: JsonObject,
  refusals: { code: string; path: string; message: string }[],
): void {
  if (project.collection_binding === undefined) return;
  const verified = verifyCollectionBinding(dir, project);
  if (!verified.valid && verified.finding !== null) {
    refusals.push(verified.finding);
  }
}
