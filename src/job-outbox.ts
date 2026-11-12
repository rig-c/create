import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, JOB_PRIVATE_DIRECTORY, lstatSync, readFileSync, readdirSync, realpathSync } from './check-reads.ts';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import type { JobPublishRequest, JobReviewerBinding, JobSubject } from '@rig-c/review/job-host';
import { refuse } from './refusal.ts';

export const JOB_BINDING_FILE = '.rig-create-review-binding.json';
export const JOB_OUTBOX_DIRECTORY = JOB_PRIVATE_DIRECTORY;
const PRIVATE_TEMP_ROOT = realpathSync(tmpdir());
export const jobHash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface JobIdentity {
  root: string;
  stateDir: string;
  fingerprint: string;
  reviewer: JobReviewerBinding;
  readerId: string;
  bindingId: string;
  partsEnumeratorId: string;
  apiSchema: string;
  actSchema: string;
  enumeratorVersion: string;
}

export interface WriterBinding {
  schema: 'rig-create/job-binding@1';
  identity: JobIdentity;
  jobId: string;
  origin: string;
  fetchCapability: string;
  listenerIncarnation: string;
}

export interface PendingPublication {
  schema: 'rig-create/job-pending@1';
  root: string;
  id: string;
  jobId: string;
  origin: string;
  identity: JobIdentity;
  recordHash: string;
  versionHash?: string;
  previousVersionHash?: string;
  result: JobPublishRequest['result'];
  failure: { code: string; message: string } | null;
  generation?: number;
  phase?: 'intent' | 'pending';
}

/** Directory installation is atomic. Stale cleanup removes only the dead
 * owner's unique token and cannot remove a replacement owner's nonempty lock.
 */
export function acquireJobLock(root: string, required = true): (() => void) | null {
  const lock = join(root, '.rig-create-job-write.lock');
  const token = `${process.pid}-${randomUUID()}`;
  const candidate = `${lock}.${token}`;
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, token), '', { flag: 'wx', mode: 0o600 });
  const install = (): boolean => {
    try { renameSync(candidate, lock); return true; }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      return false;
    }
  };
  try {
    if (!install()) {
      const owners = lstatSync(lock).isDirectory() ? readdirSync(lock) : [];
      const owner = owners.length === 1 && /^\d+-[a-f0-9-]{36}$/.test(owners[0]) ? owners[0] : null;
      let dead = false;
      if (owner) {
        try { process.kill(Number(owner.split('-')[0]), 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      if (owner && dead) {
        rmSync(join(lock, owner), { force: true });
        try { rmdirSync(lock); } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      if (!install()) {
        if (required) refuse('JOB_WRITE_BUSY', 'project.json: a bound writer holds its publication freeze; wait before retrying');
        return null;
      }
    }
    return () => { rmSync(join(lock, token)); rmdirSync(lock); };
  } finally { rmSync(candidate, { recursive: true, force: true }); }
}

/** Fixed independently of the binding, so close cannot hide an outstanding HOLE. */
export function jobPrivateRoot(root: string): string {
  return join(realpathSync(root), JOB_OUTBOX_DIRECTORY);
}

/** Review's managed host must remain outside the producer root. */
export function jobHostStateRoot(root: string): string {
  return join(PRIVATE_TEMP_ROOT, `rig-create-review-${process.getuid?.() ?? 'user'}`, jobHash(realpathSync(root)));
}

/** Existing repositories use their local exclude so opening a job does not
 * dirty a tracked ignore file. New projects already carry these root patterns.
 */
export function ensureJobPrivateIgnores(root: string): void {
  const names = [JOB_BINDING_FILE, JOB_OUTBOX_DIRECTORY];
  for (const name of names) {
    const tracked = Bun.spawnSync(['git', 'ls-files', '--error-unmatch', '--', name], { cwd: root, stdout: 'ignore', stderr: 'ignore' });
    if (tracked.exitCode === 0) refuse('JOB_BINDING_INVALID', `project.json: private ${name} is tracked; remove it from version control before opening the job`);
  }
  const missing = names.filter(name => Bun.spawnSync(['git', 'check-ignore', '--quiet', '--no-index', '--', name === JOB_OUTBOX_DIRECTORY ? `${name}/receipt.json` : name],
    { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0);
  if (!missing.length) return;
  const gitPath = Bun.spawnSync(['git', 'rev-parse', '--git-path', 'info/exclude'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  const path = gitPath.exitCode === 0 ? resolve(root, gitPath.stdout.toString().trim()) : join(root, '.gitignore');
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) refuse('JOB_BINDING_INVALID', 'project.json: private ignore destination must be a regular file; restore it before opening the job');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const prefix = gitPath.exitCode === 0 ? Bun.spawnSync(['git', 'rev-parse', '--show-prefix'],
    { cwd: root, stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trimEnd() : '';
  const patterns = missing.map(name => `/${prefix}${name}${name === JOB_OUTBOX_DIRECTORY ? '/' : ''}`);
  writeFileSync(path, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${patterns.join('\n')}\n`);
  if (gitPath.exitCode === 0 && names.some(name => Bun.spawnSync(['git', 'check-ignore', '--quiet', '--no-index', '--', name === JOB_OUTBOX_DIRECTORY ? `${name}/receipt.json` : name],
    { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0)) {
    refuse('JOB_BINDING_INVALID', 'project.json: private binding/outbox are not effectively ignored; remove conflicting unignore rules before opening the job');
  }
}

export function privateDirectory(path: string): void {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path || (info.mode & 0o077)
      || process.getuid && info.uid !== process.getuid()) {
      refuse('JOB_PRIVATE_STORAGE_INVALID', 'project.json: private publication storage is unsafe; restore its owner-only real directory');
    }
    return;
  }
  const parent = dirname(path);
  if (parent !== PRIVATE_TEMP_ROOT && basename(path) !== JOB_OUTBOX_DIRECTORY) privateDirectory(parent);
  mkdirSync(path, { mode: 0o700 });
  syncDirectory(parent);
}

function assertPrivateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || realpathSync(path) !== path
    || process.getuid && info.uid !== process.getuid()) {
    refuse('JOB_PRIVATE_STORAGE_INVALID', 'project.json: private publication file is unsafe; restore its owner-only regular file');
  }
}

export function privateJson(path: string): unknown {
  assertPrivateFile(path);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writePrivateJson(path: string, value: unknown, projectSibling = false): void {
  if (!projectSibling) privateDirectory(dirname(path));
  try { privateJson(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function readWriterBinding(root: string): WriterBinding | null {
  const path = join(realpathSync(root), JOB_BINDING_FILE);
  let value: WriterBinding;
  try { value = privateJson(path) as WriterBinding; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (value?.schema !== 'rig-create/job-binding@1' || !value.identity || typeof value.jobId !== 'string'
    || typeof value.origin !== 'string' || typeof value.fetchCapability !== 'string'
    || value.listenerIncarnation !== undefined && typeof value.listenerIncarnation !== 'string') {
    refuse('JOB_BINDING_INVALID', 'project.json: malformed private live-job binding; reopen the job through rig-create job open');
  }
  return value;
}

export function assertJobIdentity(expected: JobIdentity, found: JobIdentity): void {
  for (const field of Object.keys(expected) as (keyof JobIdentity)[]) {
    if (!isDeepStrictEqual(expected[field], found[field])) {
      refuse('JOB_HOST_REUSE_MISMATCH', `project.json: ${field} expected=${JSON.stringify(expected[field])} found=${JSON.stringify(found[field])}; restore the bound host configuration, then run rig-create job reconcile`);
    }
  }
}

export function enqueuePublication(root: string, binding: WriterBinding, result: JobPublishRequest['result'], intentBytes?: Buffer): PendingPublication {
  const bytes = intentBytes ?? readFileSync(join(root, 'project.json'));
  const recordHash = jobHash(bytes);
  const versionHash = publicationVersionHash(bytes, result);
  if (versionHash === null) refuse('JOB_PUBLICATION_INVALID', 'project.json: publication version is absent; restore the recorded rig/post before publishing');
  const id = jobHash(JSON.stringify([binding.jobId, versionHash, result]));
  const pending: PendingPublication = {
    schema: 'rig-create/job-pending@1', root: realpathSync(root), id, jobId: binding.jobId, origin: binding.origin,
    identity: binding.identity, recordHash, versionHash,
    ...(intentBytes && publicationVersionHash(readFileSync(join(root, 'project.json')), result) !== versionHash
      ? { previousVersionHash: publicationVersionHash(readFileSync(join(root, 'project.json')), result) ?? undefined } : {}),
    result, failure: null, phase: intentBytes ? 'intent' : 'pending',
  };
  ensureJobPrivateIgnores(root);
  const path = pendingPath(root, id);
  if (existsSync(path)) return privateJson(path) as PendingPublication;
  writePrivateJson(path, pending);
  return pending;
}

/** The writers use the same two-space JSON serialization for version entries.
 * Whole-record bytes are retained only for Review's current freeze/attempt.
 */
export function publicationVersionHash(bytes: Buffer, result: JobPublishRequest['result']): string | null {
  const selector = result.selector;
  if (!selector) refuse('JOB_PUBLICATION_INVALID', 'project.json: publication requires a result selector; restore the writer result');
  if (selector.kind === 'draft') {
    const project = JSON.parse(bytes.toString('utf8')) as { drafts?: { id: string }[] };
    const found = project.drafts?.filter(draft => draft.id === selector.id) ?? [];
    if (!found.length) return null;
    if (found.length !== 1) refuse('JOB_PUBLICATION_INVALID', 'project.json: draft identity is ambiguous; restore its unique entry');
    return jobHash(`${JSON.stringify(found[0], null, 2)}\n`);
  }
  const project = JSON.parse(bytes.toString('utf8')) as { versions?: { n: number; kind: string }[] };
  if (!Array.isArray(project.versions)) refuse('JOB_PUBLICATION_INVALID', 'project.json: versions must be an array; restore the recorded rig/post');
  const found = project.versions.filter(version => version.n === selector.version);
  if (!found.length) return null;
  if (found.length !== 1) refuse('JOB_PUBLICATION_INVALID', 'project.json: publication version is ambiguous; restore its unique rig/post entry');
  return jobHash(`${JSON.stringify(found[0], null, 2)}\n`);
}

function currentVersionHash(root: string, entry: PendingPublication): string | null {
  return publicationVersionHash(readFileSync(join(root, 'project.json')), entry.result);
}

function pendingPath(root: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) refuse('JOB_OUTBOX_INVALID', 'project.json: invalid pending identity; restore the writer-owned outbox');
  return join(jobPrivateRoot(root), 'outbox', `${id}.json`);
}

export function pendingPublications(root: string, recoverIntents = false): PendingPublication[] {
  const directory = join(jobPrivateRoot(root), 'outbox');
  if (!existsSync(directory)) return [];
  privateDirectory(directory);
  return readdirSync(directory).filter(name => name.endsWith('.json')).sort().flatMap(name => {
    const entry = privateJson(join(directory, name)) as PendingPublication;
    if (entry?.schema !== 'rig-create/job-pending@1' || `${entry.id}.json` !== name
      || entry.root !== realpathSync(root) || !/^[a-f0-9]{64}$/.test(entry.recordHash)
      || entry.versionHash !== undefined && !/^[a-f0-9]{64}$/.test(entry.versionHash)
      || entry.previousVersionHash !== undefined && !/^[a-f0-9]{64}$/.test(entry.previousVersionHash) || !entry.result || !entry.identity) {
      refuse('JOB_OUTBOX_INVALID', 'project.json: malformed pending publication; restore the writer-owned outbox before reconciling');
    }
    if (!entry.versionHash) {
      if (jobHash(readFileSync(join(root, 'project.json'))) !== entry.recordHash) refuse('JOB_OUTBOX_INVALID', 'project.json: legacy receipt cannot identify its version after later edits; restore its original receipt/source before reconciling');
      entry.versionHash = currentVersionHash(root, entry) ?? undefined;
    }
    if (entry.phase === 'intent' && (currentVersionHash(root, entry) === null || entry.previousVersionHash !== undefined && currentVersionHash(root, entry) === entry.previousVersionHash)) {
      if (recoverIntents) discardIntent(root, entry);
      return [];
    }
    return [entry];
  });
}

function discardIntent(root: string, entry: PendingPublication): void {
  const log = join(jobPrivateRoot(root), 'discarded-intents.jsonl');
  if (existsSync(log)) assertPrivateFile(log);
  const fd = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ id: entry.id, versionHash: entry.versionHash, event: 'intent-not-committed' })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  rmSync(pendingPath(root, entry.id), { force: true });
  syncDirectory(join(jobPrivateRoot(root), 'outbox'));
}

export function cancelUncommittedIntent(root: string, entry: PendingPublication | null): void {
  if (entry && existsSync(pendingPath(root, entry.id)) && (currentVersionHash(root, entry) === null || entry.previousVersionHash !== undefined && currentVersionHash(root, entry) === entry.previousVersionHash)) discardIntent(root, entry);
}

/** Receipt updates and reconciliation never rewrite the published project. */
export function failPublication(root: string, entry: PendingPublication, failure: PendingPublication['failure']): void {
  writePrivateJson(pendingPath(root, entry.id), { ...entry, failure });
}

export async function reconcilePublication(root: string, entry: PendingPublication,
  publish: (entry: PendingPublication) => Promise<unknown>): Promise<void> {
  if (currentVersionHash(root, entry) !== entry.versionHash) {
    refuse('JOB_PUBLICATION_STALE', 'project.json: the pending version entry is absent or changed; restore that retained version and its files before rig-create job reconcile');
  }
  const recordHash = jobHash(readFileSync(join(root, 'project.json')));
  if (recordHash !== entry.recordHash) { entry.recordHash = recordHash; delete entry.generation; }
  entry.phase = 'pending';
  failPublication(root, entry, entry.failure);
  await publish(entry);
  rmSync(pendingPath(root, entry.id));
  syncDirectory(join(jobPrivateRoot(root), 'outbox'));
}

export function pendingPublicationHoles(root: string, readOnly = false): { code: string; path: string; message: string }[] {
  try {
    if (!existsSync(root) || !existsSync(join(jobPrivateRoot(root), 'outbox'))) return [];
    const release = readOnly ? null : acquireJobLock(root, false);
    let entries: PendingPublication[];
    try { entries = pendingPublications(root, release !== null); }
    finally { release?.(); }
    return entries.map(entry => {
      const changed = currentVersionHash(root, entry) !== entry.versionHash;
      return {
        code: changed ? 'JOB_PUBLICATION_STALE' : 'JOB_PUBLISH_PENDING', path: 'project.json',
        message: `project.json: HOLE publication ${entry.id} for version hash ${entry.versionHash} ${changed ? 'has a changed or missing version' : 'is pending'}${entry.failure ? ` (${entry.failure.code}: ${entry.failure.message})` : ''}; restore the retained version/files and run rig-create job reconcile`,
      };
    });
  } catch {
    return [{ code: 'JOB_OUTBOX_INVALID', path: 'project.json', message: 'project.json: HOLE private publication outbox is unreadable; restore its owner-only bytes before rig-create job reconcile' }];
  }
}

export interface AcknowledgedPublication {
  schema: 'rig-create/job-acknowledged@1';
  jobId: string;
  publicationId: string;
  generation: number;
  requestId: string;
  result: PendingPublication['result'];
  versionHash: string;
  /** The subjects the published context declared. Receipts written before they were retained omit it. */
  subjects?: readonly JobSubject[];
}

function acknowledgedPath(root: string, jobId: string, publicationId: string): string {
  return join(jobPrivateRoot(root), 'acknowledged-publications', `${jobHash(JSON.stringify([jobId, publicationId]))}.json`);
}

/** Persist the version identity before the pending publication is removed. */
export function acknowledgePublication(entry: PendingPublication, publicationId: string, generation: number, requestId: string, subjects?: readonly JobSubject[]): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(publicationId) || !Number.isSafeInteger(generation) || generation < 0 || !entry.versionHash) {
    refuse('JOB_OUTBOX_INVALID', 'project.json: publication acknowledgment lacks its identity; reconcile the original pending publication');
  }
  const receipt: AcknowledgedPublication = { schema: 'rig-create/job-acknowledged@1', jobId: entry.jobId,
    publicationId, generation, requestId, result: entry.result, versionHash: entry.versionHash, ...(subjects === undefined ? {} : { subjects }) };
  const path = acknowledgedPath(entry.root, entry.jobId, publicationId);
  let existing: unknown;
  try { existing = privateJson(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing !== undefined && !isDeepStrictEqual(existing, receipt)) {
    refuse('JOB_OUTBOX_INVALID', 'project.json: acknowledgment identity conflicts with retained receipt; restore the original publication receipt');
  }
  if (existing === undefined) writePrivateJson(path, receipt);
}

export function readAcknowledgedPublication(root: string, jobId: string, publicationId: string): AcknowledgedPublication | null {
  const directory = join(jobPrivateRoot(root), 'acknowledged-publications');
  if (!existsSync(directory)) return null;
  privateDirectory(directory);
  let value: AcknowledgedPublication;
  try { value = privateJson(acknowledgedPath(root, jobId, publicationId)) as AcknowledgedPublication; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (value?.schema !== 'rig-create/job-acknowledged@1' || value.jobId !== jobId || value.publicationId !== publicationId
    || !/^[a-f0-9]{64}$/.test(value.versionHash) || !Number.isSafeInteger(value.generation) || value.generation < 0
    || typeof value.requestId !== 'string' || !value.result?.selector
    || value.subjects !== undefined && (!Array.isArray(value.subjects) || value.subjects.some(subject => subject === null || typeof subject !== 'object' || typeof subject.kind !== 'string'))) {
    refuse('JOB_OUTBOX_INVALID', 'project.json: acknowledged publication receipt is malformed; restore its owner-only original');
  }
  return value;
}
