import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import type { JobPublishRequest, JobReviewerBinding } from '@rig-c/review/job-host';
import { refuse } from './refusal.ts';

export const JOB_BINDING_FILE = '.rig-create-review-binding.json';
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
}

export interface PendingPublication {
  schema: 'rig-create/job-pending@1';
  root: string;
  id: string;
  jobId: string;
  origin: string;
  identity: JobIdentity;
  recordHash: string;
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
  return join(PRIVATE_TEMP_ROOT, `rig-create-review-${process.getuid?.() ?? 'user'}`, jobHash(realpathSync(root)));
}

export function privateDirectory(path: string): void {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path || (info.mode & 0o077)) {
      refuse('JOB_PRIVATE_STORAGE_INVALID', 'project.json: private publication storage is unsafe; restore its owner-only real directory');
    }
    return;
  }
  const parent = dirname(path);
  if (parent !== PRIVATE_TEMP_ROOT) privateDirectory(parent);
  mkdirSync(path, { mode: 0o700 });
}

export function privateJson(path: string): unknown {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || realpathSync(path) !== path) {
    refuse('JOB_PRIVATE_STORAGE_INVALID', 'project.json: private publication file is unsafe; restore its owner-only regular file');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writePrivateJson(path: string, value: unknown, projectSibling = false): void {
  if (!projectSibling) privateDirectory(dirname(path));
  if (existsSync(path)) privateJson(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function readWriterBinding(root: string): WriterBinding | null {
  const path = join(realpathSync(root), JOB_BINDING_FILE);
  if (!existsSync(path)) return null;
  const value = privateJson(path) as WriterBinding;
  if (value?.schema !== 'rig-create/job-binding@1' || !value.identity || typeof value.jobId !== 'string'
    || typeof value.origin !== 'string' || typeof value.fetchCapability !== 'string') {
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
  const recordHash = jobHash(intentBytes ?? readFileSync(join(root, 'project.json')));
  const id = jobHash(JSON.stringify([binding.jobId, recordHash, result]));
  const pending: PendingPublication = {
    schema: 'rig-create/job-pending@1', root: realpathSync(root), id, jobId: binding.jobId, origin: binding.origin,
    identity: binding.identity, recordHash, result, failure: null, phase: intentBytes ? 'intent' : 'pending',
  };
  const path = pendingPath(root, id);
  if (existsSync(path)) return privateJson(path) as PendingPublication;
  writePrivateJson(path, pending);
  return pending;
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
      || entry.root !== realpathSync(root) || !/^[a-f0-9]{64}$/.test(entry.recordHash) || !entry.result || !entry.identity) {
      refuse('JOB_OUTBOX_INVALID', 'project.json: malformed pending publication; restore the writer-owned outbox before reconciling');
    }
    if (entry.phase === 'intent' && jobHash(readFileSync(join(root, 'project.json'))) !== entry.recordHash) {
      if (recoverIntents) discardIntent(root, entry);
      return [];
    }
    return [entry];
  });
}

function discardIntent(root: string, entry: PendingPublication): void {
  const log = join(jobPrivateRoot(root), 'discarded-intents.jsonl');
  const fd = openSync(log, 'a', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ id: entry.id, recordHash: entry.recordHash, event: 'intent-not-committed' })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  rmSync(pendingPath(root, entry.id), { force: true });
}

export function cancelUncommittedIntent(root: string, entry: PendingPublication | null): void {
  if (entry && existsSync(pendingPath(root, entry.id)) && jobHash(readFileSync(join(root, 'project.json'))) !== entry.recordHash) discardIntent(root, entry);
}

/** Receipt updates and reconciliation never rewrite the published project. */
export function failPublication(root: string, entry: PendingPublication, failure: PendingPublication['failure']): void {
  writePrivateJson(pendingPath(root, entry.id), { ...entry, failure });
}

export async function reconcilePublication(root: string, entry: PendingPublication,
  publish: (entry: PendingPublication) => Promise<void>): Promise<void> {
  if (jobHash(readFileSync(join(root, 'project.json'))) !== entry.recordHash) {
    refuse('JOB_PUBLICATION_STALE', 'project.json: pending publication binds an earlier record; restore that exact committed record before rig-create job reconcile');
  }
  entry.phase = 'pending';
  failPublication(root, entry, entry.failure);
  await publish(entry);
  rmSync(pendingPath(root, entry.id));
}

export function pendingPublicationHoles(root: string): { code: string; path: string; message: string }[] {
  try {
    if (!existsSync(root) || !existsSync(join(jobPrivateRoot(root), 'outbox'))) return [];
    const release = acquireJobLock(root, false);
    let entries: PendingPublication[];
    try { entries = pendingPublications(root, release !== null); }
    finally { release?.(); }
    return entries.map(entry => ({
      code: 'JOB_PUBLISH_PENDING', path: 'project.json',
      message: `project.json: HOLE publication ${entry.id} for record ${entry.recordHash} is pending${entry.failure ? ` (${entry.failure.code}: ${entry.failure.message})` : ''}; run rig-create job reconcile`,
    }));
  } catch {
    return [{ code: 'JOB_OUTBOX_INVALID', path: 'project.json', message: 'project.json: HOLE private publication outbox is unreadable; restore its owner-only bytes before rig-create job reconcile' }];
  }
}
