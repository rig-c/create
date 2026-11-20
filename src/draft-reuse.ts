/** Create-owned evidence for reusing a reviewed parts inventory. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { lstatSync, realpathSync } from './check-reads.ts';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, isObject, PROJECT_SCHEMA, type Finding } from './check.ts';
import { publicationFile } from './job-publication.ts';
import { latestPartsReceipt, recordedPartsVerdict } from './parts-verdict-record.ts';
import { Refusal, refuse } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (value: Json | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const literal = (path: string): boolean => !path.includes('\\') && path.split('/').every(name => name !== '' && name !== '.' && name !== '..');
export const DRAFT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const recordDirectory = 'evidence/draft-reuse';

function fail(code: 'DRAFT_REUSE_SOURCE' | 'DRAFT_REUSE_MISMATCH' | 'DRAFT_REUSE_PRODUCER', path: string, detail: string): never {
  refuse(code, `${path}: ${detail}; restore the reviewed source and exact parts, or run rig-parts build and record a normal draft`);
}

function restartSource(project: JsonObject, digest: string, path: string): { path: string; sha256: string } {
  if (!hex(digest) || !asArray(project.restarts).some(row => isObject(row) && row.previous_record_sha256 === digest)) {
    fail('DRAFT_REUSE_SOURCE', path, 'the source record sha256 must be named by restarts[].previous_record_sha256');
  }
  return { path: `${recordDirectory}/${digest}.json`, sha256: digest };
}

function parseRecord(bytes: Buffer, digest: string, path: string): JsonObject {
  if (sha(bytes) !== digest) fail('DRAFT_REUSE_SOURCE', path, 'the previous record differs from its restart sha256');
  let value: Json;
  try { value = JSON.parse(bytes.toString('utf8')) as Json; }
  catch { return fail('DRAFT_REUSE_SOURCE', path, 'the previous record is invalid JSON'); }
  if (!isObject(value) || value.schema !== PROJECT_SCHEMA) fail('DRAFT_REUSE_SOURCE', path, `the previous record must be ${PROJECT_SCHEMA}`);
  return value;
}

/** Find the exact project blob among this project's reachable commits. Git is used only by the writer. */
function historicalRecord(dir: string, digest: string, path: string): Buffer {
  const git = (args: string[]) => Bun.spawnSync(['git', '--no-replace-objects', '--literal-pathspecs', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const prefix = git(['rev-parse', '--show-prefix']);
  if (prefix.exitCode !== 0) fail('DRAFT_REUSE_SOURCE', path, 'cannot resolve project.json in the git work tree');
  const file = `${prefix.stdout.toString('utf8').replace(/\n$/, '')}project.json`;
  const blobs = git(['rev-list', '--objects', '--full-history', 'HEAD', '--', 'project.json']);
  if (blobs.exitCode === 0) {
    for (const line of blobs.stdout.toString('utf8').split('\n')) {
      const split = line.indexOf(' ');
      if (split < 0 || line.slice(split + 1) !== file) continue;
      const result = git(['cat-file', 'blob', line.slice(0, split)]);
      if (result.exitCode === 0 && sha(result.stdout) === digest) return Buffer.from(result.stdout);
    }
  }
  return fail('DRAFT_REUSE_SOURCE', path, `git history for project.json does not hold restart sha256 ${digest}; use a clone with the complete project history`);
}

type PartFile = { path: string; sha256: string };

function relativeInventory(parts: JsonObject, path: string): PartFile[] {
  if (typeof parts.path !== 'string' || !literal(parts.path) || !Array.isArray(parts.files)) {
    fail('DRAFT_REUSE_MISMATCH', path, 'the parts root or inventory is malformed');
  }
  const prefix = `${parts.path}/`;
  const seen = new Set<string>();
  const files = parts.files.map(file => {
    if (!isObject(file) || typeof file.path !== 'string' || !literal(file.path) || !file.path.startsWith(prefix) || !hex(file.sha256)) {
      return fail('DRAFT_REUSE_MISMATCH', path, 'the parts inventory contains an invalid file binding');
    }
    const name = file.path.slice(prefix.length);
    if (seen.has(name)) fail('DRAFT_REUSE_MISMATCH', path, `duplicate parts binding for ${name}`);
    seen.add(name);
    return { path: name, sha256: file.sha256 };
  });
  if (!seen.has('parts.json') || !files.some(file => file.path.startsWith('parts/'))) {
    fail('DRAFT_REUSE_MISMATCH', path, 'the inventory must bind parts.json and files under parts/');
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function sameInventory(source: PartFile[], target: PartFile[], path: string): void {
  const expected = new Map(source.map(file => [file.path, file.sha256]));
  for (const file of target) {
    const digest = expected.get(file.path);
    if (digest !== file.sha256) fail('DRAFT_REUSE_MISMATCH', path, digest === undefined ? `unexpected parts file ${file.path}` : `parts file ${file.path} differs from its reviewed sha256`);
    expected.delete(file.path);
  }
  if (expected.size > 0) fail('DRAFT_REUSE_MISMATCH', path, `missing reviewed parts file ${[...expected.keys()][0]}`);
}

function layerSources(bytes: Buffer, inventory: PartFile[], path: string): JsonObject[] {
  const manifest = inventory.find(file => file.path === 'parts.json');
  if (sha(bytes) !== manifest?.sha256) fail('DRAFT_REUSE_MISMATCH', path, 'parts.json differs from its reviewed sha256');
  let value: Json;
  try { value = JSON.parse(bytes.toString('utf8')) as Json; }
  catch { return fail('DRAFT_REUSE_MISMATCH', path, 'the reviewed parts.json is invalid JSON'); }
  if (!isObject(value) || !Array.isArray(value.parts) || value.parts.length === 0) {
    fail('DRAFT_REUSE_MISMATCH', path, 'the reviewed parts.json must declare its parts');
  }
  const files = new Map(inventory.map(file => [file.path, file.sha256]));
  if (value.painting_in_rig !== undefined && (!isObject(value.painting_in_rig) || typeof value.painting_in_rig.path !== 'string'
    || !hex(value.painting_in_rig.sha256) || files.get(value.painting_in_rig.path) !== value.painting_in_rig.sha256)) {
    fail('DRAFT_REUSE_MISMATCH', path, 'the declared painting_in_rig differs from its reviewed binding');
  }
  return value.parts.flatMap(part => {
    if (!isObject(part) || typeof part.name !== 'string' || !files.has(`parts/${part.name}.png`) || typeof part.from !== 'string'
      || (part.taken_layers !== undefined && !Array.isArray(part.taken_layers))) {
      return fail('DRAFT_REUSE_MISMATCH', path, 'parts.json has an unbound part or invalid layer provenance');
    }
    // Copy the producer declarations. Author-made layers and painting patches are not See-through sources.
    const from = /^(full|head):[^:]+$/.test(part.from) ? part.from : undefined;
    const taken = asArray(part.taken_layers);
    return from === undefined && taken.length === 0 ? [] : [{
      part: part.name, ...(from !== undefined ? { from } : {}), ...(taken.length ? { taken_layers: taken } : {}),
    }];
  });
}

function reviewedSource(dir: string, project: JsonObject, id: string, path: string, manifest: Buffer | undefined, reviewSha?: string): {
  producer: JsonObject; parts: PartFile[]; reviewSha: string; validate: () => void;
} {
  const drafts = asArray(project.drafts).filter(isObject).filter(draft => draft.id === id);
  const source = drafts[0];
  const root = `derived/drafts/${id}`;
  if (drafts.length !== 1 || source?.kind !== 'draft-rig' || !isObject(source.parts) || typeof source.parts.path !== 'string'
    || (source.parts.path !== root && !source.parts.path.startsWith(`${root}/`))
    || !isObject(source.producer) || source.producer.name !== '@rig-c/parts' || typeof source.producer.version !== 'string' || !source.producer.version.trim()) {
    fail('DRAFT_REUSE_SOURCE', path, `draft ${id} has no unique retained draft record with parts and a producer`);
  }
  const latest = latestPartsReceipt(project, id);
  const digest = reviewSha ?? (isObject(latest?.evidence) ? latest.evidence.sha256 : undefined);
  const receipts = asArray(project.review_acts).filter(isObject).filter(entry =>
    entry.kind === 'parts-verdict' && entry.draft_id === id && isObject(entry.evidence) && entry.evidence.sha256 === digest);
  if (!hex(digest) || receipts.length !== 1) fail('DRAFT_REUSE_SOURCE', path, `draft ${id} has no unique retained parts verdict for this reuse`);
  return {
    producer: { name: source.producer.name, version: source.producer.version },
    parts: relativeInventory(source.parts, path),
    reviewSha: digest,
    validate: (): void => {
      try {
        // Unrelated historical receipts are not new evidence dependencies of this draft.
        recordedPartsVerdict(dir, { ...project, review_acts: receipts }, id, { ...(receipts[0]!.evidence as JsonObject), kind: 'parts-verdict' }, {
          requireAvailable: false, requireApproval: false, ...(manifest === undefined ? {} : { retainedManifest: manifest }),
        });
      } catch (error) {
        fail('DRAFT_REUSE_SOURCE', path, `draft ${id} needs a valid retained parts verdict (${error instanceof Refusal ? error.code : 'unreadable evidence'})`);
      }
    },
  };
}

export function prepareDraftReuse(dir: string, project: JsonObject, draft: JsonObject, sourceId: string, recordSha: string | undefined, manifest: Buffer | undefined): {
  producer: JsonObject; reuse: JsonObject; snapshot?: Buffer;
} {
  const path = `drafts[${String(draft.id)}].reuse`;
  if (sourceId === draft.id) fail('DRAFT_REUSE_SOURCE', path, 'use a new draft id distinct from the source id');
  const previous = recordSha === undefined ? undefined : restartSource(project, recordSha, path);
  const snapshot = previous === undefined ? undefined : historicalRecord(dir, previous.sha256, path);
  const record = snapshot !== undefined && previous !== undefined ? parseRecord(snapshot, previous.sha256, path) : project;
  const source = reviewedSource(dir, record, sourceId, path, manifest);
  sameInventory(source.parts, relativeInventory(draft.parts as JsonObject, path), path);
  if (manifest === undefined) fail('DRAFT_REUSE_MISMATCH', path, 'parts.json is unavailable');
  const reuse: JsonObject = { draft_id: sourceId, review_sha256: source.reviewSha, parts: source.parts,
    seethrough: layerSources(manifest, source.parts, path), ...(previous === undefined ? {} : { previous_record: previous }) };
  source.validate();
  return { producer: source.producer, reuse, ...(snapshot === undefined ? {} : { snapshot }) };
}

/** A previous record is stored by raw SHA so check's file closure can be copied without git. */
export function retainDraftReuseRecord(dir: string, bytes: Buffer): void {
  const digest = sha(bytes);
  const path = `${recordDirectory}/${digest}.json`;
  const sync = (file: string): void => {
    const fd = openSync(file, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  try {
    const root = realpathSync(dir);
    let parent = root;
    for (const name of recordDirectory.split('/')) {
      const next = join(parent, name);
      try { mkdirSync(next); sync(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!lstatSync(next).isDirectory()) throw new Error('snapshot directory is not a real directory');
      parent = next;
    }
    const temp = join(parent, `.reuse-${randomUUID()}.tmp`);
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temp, join(root, path)); sync(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { rmSync(temp, { force: true }); }
    if (!publicationFile(root, path).equals(bytes)) throw new Error('existing snapshot has different bytes');
  } catch (error) {
    fail('DRAFT_REUSE_SOURCE', path, error instanceof Error ? error.message : String(error));
  }
}

export function checkDraftReuse(
  dir: string, project: JsonObject, draft: JsonObject, index: number, actual: JsonObject[] | undefined,
  manifest: Buffer | undefined, stampedProducer: JsonObject | undefined,
): Finding | undefined {
  const path = `drafts[${index}].reuse`;
  const reuse = draft.reuse;
  try {
    if (!isObject(reuse) || typeof reuse.draft_id !== 'string' || !DRAFT_ID.test(reuse.draft_id) || reuse.draft_id === draft.id
      || !hex(reuse.review_sha256) || !Array.isArray(reuse.seethrough)) {
      fail('DRAFT_REUSE_SOURCE', path, 'reuse requires a distinct source draft, its review sha256 and its layer declarations');
    }
    let sourceRecord: JsonObject = { ...project, drafts: asArray(project.drafts).slice(0, index) };
    if (reuse.previous_record !== undefined) {
      if (!isObject(reuse.previous_record) || typeof reuse.previous_record.sha256 !== 'string') {
        fail('DRAFT_REUSE_SOURCE', path, 'the previous record binding must name the restart sha256');
      }
      const previous = restartSource(project, reuse.previous_record.sha256, path);
      if (!isDeepStrictEqual(reuse.previous_record, previous)) fail('DRAFT_REUSE_SOURCE', path, 'the previous record must use its content-addressed snapshot path');
      let bytes: Buffer;
      try { bytes = publicationFile(realpathSync(dir), previous.path); }
      catch { return fail('DRAFT_REUSE_SOURCE', path, `restore the prior record snapshot at ${previous.path}`); }
      sourceRecord = parseRecord(bytes, previous.sha256, path);
    }
    const source = reviewedSource(dir, sourceRecord, reuse.draft_id, path, manifest, reuse.previous_record === undefined ? reuse.review_sha256 : undefined);
    if (source.reviewSha !== reuse.review_sha256) fail('DRAFT_REUSE_SOURCE', path, 'the retained review sha256 differs from the source verdict');
    if (!isDeepStrictEqual(draft.producer, source.producer)
      || (stampedProducer !== undefined && !isDeepStrictEqual(stampedProducer, source.producer))) {
      fail('DRAFT_REUSE_PRODUCER', path, 'the inherited producer or local run.json differs from the reviewed source producer');
    }
    const parts = draft.parts as JsonObject;
    sameInventory(source.parts, relativeInventory(parts, path), path);
    if (!isDeepStrictEqual(reuse.parts, source.parts)) fail('DRAFT_REUSE_MISMATCH', path, 'the recorded relative parts inventory differs from the reviewed source');
    if (actual !== undefined) sameInventory(source.parts, relativeInventory({ path: parts.path, files: actual }, path), path);
    if (manifest !== undefined && !isDeepStrictEqual(reuse.seethrough, layerSources(manifest, source.parts, path))) {
      fail('DRAFT_REUSE_MISMATCH', path, 'recorded See-through layers differ from the reviewed parts.json');
    }
    source.validate();
  } catch (error) {
    return { code: error instanceof Refusal ? error.code : 'DRAFT_REUSE_SOURCE', path,
      message: error instanceof Refusal ? error.message : `${path}: cannot read the reviewed source (${error instanceof Error ? error.message : String(error)}); restore the reviewed evidence or record a normal build` };
  }
}
