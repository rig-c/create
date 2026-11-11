/** Producer declarations only: no raster decoding, resampling or measurement. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { join, resolve } from 'node:path';
import { asArray, isObject, type Finding } from './check.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

type Seal = { path: string; sha256: string };
type Reference = { draft_id: string; path: string; sha256: string };
type LoadedReference = { draft_id: string; manifest: Seal; files: Seal[] };
const FIELD = 'parts_references';
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const portable = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && !/[\\:%?#\x00-\x1f\x7f]/.test(value) && value.split('/').every(piece => piece !== '' && piece !== '.' && piece !== '..');
const size = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2
  && value.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);

function invalid(code: string, path: string, why: string): never {
  refuse(code, `${path}: ${why}; retain the producer's sealed adjacent painting_in_rig.json and PNG, then register them with parts-reference`);
}

/** Every path component is contained and real; hashes always bind raw bytes. */
function bytesAt(root: string, name: unknown, at: string, expected?: string): Buffer {
  if (!portable(name)) invalid('PARTS_REFERENCE_PATH', at, 'expected a literal portable project-relative file path');
  let bytes: Buffer;
  try {
    const target = join(realpathSync(root), name);
    if (realpathSync(target) !== target || !lstatSync(target).isFile()) throw Error();
    bytes = readFileSync(target);
  } catch { invalid('PARTS_REFERENCE_PATH', at, `${name} must be a readable regular file without symlinks`); }
  if (expected !== undefined && sha(bytes) !== expected) invalid('PARTS_REFERENCE_HASH', at, `${name} differs from its raw SHA-256`);
  return bytes;
}

function jsonObject(bytes: Buffer, at: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (object(value)) return value;
  } catch { /* Named below. */ }
  return invalid('PARTS_REFERENCE_INVALID', at, 'expected a UTF-8 JSON object');
}

/** Shared writer/check/publication validator. Absence performs no additional reads or findings. */
export function readPartsReferences(root: string, project: JsonObject): LoadedReference[] {
  if (!Object.hasOwn(project, FIELD)) return [];
  const records = project.parts_references;
  if (!Array.isArray(records)) invalid('PARTS_REFERENCE_INVALID', FIELD, 'expected an optional list');
  const seen = new Set<string>();
  return records.map((raw, index) => {
    const at = `${FIELD}[${index}]`;
    if (!exact(raw, ['draft_id', 'path', 'sha256']) || typeof raw.draft_id !== 'string' || !raw.draft_id || !hex(raw.sha256)) {
      invalid('PARTS_REFERENCE_INVALID', at, 'expected exactly {draft_id,path,sha256} with a lowercase SHA-256');
    }
    if (seen.has(raw.draft_id)) invalid('PARTS_REFERENCE_CONFLICT', at, 'only one immutable binding per draft is allowed');
    seen.add(raw.draft_id);
    const drafts = asArray(project.drafts).filter(isObject).filter(draft => draft.id === raw.draft_id);
    if (drafts.length !== 1 || !isObject(drafts[0]!.parts)) invalid('PARTS_REFERENCE_DRAFT', at, 'draft_id must name one existing draft with retained parts');
    const parts = drafts[0]!.parts as JsonObject;
    if (!portable(parts.path)) invalid('PARTS_REFERENCE_PATH', at, 'draft parts.path must be a portable project-relative directory');
    const manifestPath = `${parts.path}/parts.json`;
    if (raw.path !== `${parts.path}/painting_in_rig.json`) invalid('PARTS_REFERENCE_PATH', at, 'path must name painting_in_rig.json adjacent to this draft\'s parts.json');
    const bindings = asArray(parts.files).filter(isObject).filter(file => file.path === manifestPath);
    if (bindings.length !== 1 || !hex(bindings[0]!.sha256)) invalid('PARTS_REFERENCE_DRAFT', at, 'draft must bind its unique parts.json raw SHA-256');
    const manifest = { path: manifestPath, sha256: bindings[0]!.sha256 as string };
    const loaded = jsonObject(bytesAt(root, manifest.path, at, manifest.sha256), at);
    // Presence, including null or malformed inline data, always owns selection.
    if (Object.hasOwn(loaded, 'painting_in_rig')) invalid('PARTS_REFERENCE_INLINE_PRESENT', at, 'parts.json owns painting_in_rig; sidecar activation cannot replace its inline validation');
    const sidecarBytes = bytesAt(root, raw.path, at, raw.sha256);
    const sidecar = jsonObject(sidecarBytes, at);
    if (!exact(sidecar, ['schema', 'manifest_sha256', 'path', 'sha256', 'resample', 'rig_size'])
      || sidecar.schema !== 'rig-parts-painting-reference/1' || !hex(sidecar.manifest_sha256) || !hex(sidecar.sha256)
      || sidecar.resample !== 'lanczos3-rgb-opaque' || !size(sidecar.rig_size)) {
      invalid('PARTS_REFERENCE_INVALID', at, 'sidecar must have the frozen six-key rig-parts-painting-reference/1 shape');
    }
    if (sidecar.manifest_sha256 !== manifest.sha256 || !size(loaded.rig_size)
      || sidecar.rig_size[0] !== loaded.rig_size[0] || sidecar.rig_size[1] !== loaded.rig_size[1]) {
      invalid('PARTS_REFERENCE_BINDING', at, 'sidecar manifest_sha256 and rig_size must match the exact loaded parts.json');
    }
    if (!portable(sidecar.path)) invalid('PARTS_REFERENCE_PATH', at, 'sidecar path must be literal, portable and relative to its directory');
    const image = { path: `${parts.path}/${sidecar.path}`, sha256: sidecar.sha256 };
    bytesAt(root, image.path, at, image.sha256);
    return { draft_id: raw.draft_id, manifest, files: [{ path: raw.path as string, sha256: raw.sha256 }, image] };
  });
}

export function checkPartsReferences(root: string, project: JsonObject, refusals: Finding[]): void {
  try { readPartsReferences(root, project); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    refusals.push({ code: error.code, path: FIELD, message: error.message });
  }
}

export const PARTS_REFERENCE_HELP = `parts-reference <draft-id> [<project dir>] --file <project-relative painting_in_rig.json> [--json]
  Register existing producer-owned reference bytes without modifying the draft or parts.json.
  One immutable binding per draft; an identical retry writes nothing. Review validates PNG pixels.
  Run job open <project dir> --draft <draft-id> to refresh an existing publication.`;

export function partsReferenceCommand(args: string[]): { stdout: string; exit: number } {
  const positional: string[] = [];
  let file: string | undefined;
  let json = false;
  const usage = (): never => refuse('PARTS_REFERENCE_USAGE', `${FIELD}: ${PARTS_REFERENCE_HELP}`, USAGE_EXIT);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined) { file = args[++index]; if (!file || file.startsWith('--')) usage(); }
    else if (arg.startsWith('-')) usage();
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || !file) usage();
  let root: string;
  try { root = realpathSync(resolve(positional[1] ?? process.cwd())); }
  catch { invalid('PARTS_REFERENCE_PATH', FIELD, 'project directory must exist and be readable'); }
  const release = acquireBoundJobWrite(root);
  const lock = join(root, '.parts-reference.lock');
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx'); }
  catch { release(); invalid('PARTS_REFERENCE_WRITE_CONFLICT', FIELD, 'another registration writer holds the lock; wait and retry'); }
  const temporary = join(root, `.parts-reference-${randomUUID()}.tmp`);
  try {
    const recordPath = join(root, 'project.json');
    const original = bytesAt(root, 'project.json', FIELD);
    const project = jsonObject(original, FIELD) as JsonObject;
    if (project.schema !== 'rig-create/project@0') invalid('PARTS_REFERENCE_INVALID', FIELD, 'project.json must use rig-create/project@0');
    readPartsReferences(root, project); // Never repair or overwrite a malformed optional field.
    const entry: Reference = { draft_id: positional[0]!, path: file!, sha256: sha(bytesAt(root, file, FIELD)) };
    const existing = asArray(project.parts_references).filter(isObject).find(row => row.draft_id === entry.draft_id);
    if (existing && (existing.path !== entry.path || existing.sha256 !== entry.sha256)) invalid('PARTS_REFERENCE_CONFLICT', FIELD, 'draft already has a different immutable binding');
    const next = structuredClone(project);
    if (!existing) next.parts_references = [...asArray(project.parts_references), entry];
    const frozen = readPartsReferences(root, next);
    if (!existing) {
      const fd = openSync(temporary, 'wx');
      try {
        fchmodSync(fd, lstatSync(recordPath).mode);
        writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    // Re-read every referenced manifest/JSON/PNG after staging under both locks.
    if (JSON.stringify(readPartsReferences(root, next)) !== JSON.stringify(frozen) || !readFileSync(recordPath).equals(original)) {
      invalid('PARTS_REFERENCE_WRITE_CONFLICT', FIELD, 'project.json or reference inputs changed during registration; freeze them and retry');
    }
    if (!existing) {
      renameSync(temporary, recordPath);
      const dir = openSync(root, 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
    return { stdout: json ? JSON.stringify(entry, null, 2) : `parts-reference: ${existing ? 'already registered' : 'registered'} ${entry.draft_id}; refresh with job open --draft ${entry.draft_id}`, exit: 0 };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    invalid('PARTS_REFERENCE_WRITE_FAILED', FIELD, 'could not read or atomically register the producer reference; restore writable project storage');
  } finally {
    rmSync(temporary, { force: true });
    closeSync(descriptor);
    rmSync(lock);
    release();
  }
}
