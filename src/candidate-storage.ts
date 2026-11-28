import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statfsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { refuse } from './refusal.ts';

export const CANDIDATE_STORAGE_PATH = 'scratch/candidates';
// Pilot: about 27 MB per live source plus retained Review snapshot.
export const CANDIDATE_STORAGE_LIMIT_BYTES = 320 * 1024 ** 2;
export const CANDIDATE_OPTION_RESERVATION_BYTES = 28 * 1024 ** 2;
export const CANDIDATE_COMPOSE_DISK_RESERVE_BYTES = 192 * 1024 ** 2;
export const CANDIDATE_JOB_STATE_RESERVATION_BYTES = 256 * 1024;

function realDirectory(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory() && realpathSync(path) === path;
}

export function candidateStorage(root: string): string {
  const scratch = join(root, 'scratch');
  mkdirSync(scratch, { mode: 0o700, recursive: true });
  if (!realDirectory(scratch)) refuse('JOB_PRIVATE_STORAGE_INVALID', 'scratch: use a literal project scratch directory');
  const path = join(root, CANDIDATE_STORAGE_PATH);
  mkdirSync(path, { mode: 0o700, recursive: true });
  const stat = lstatSync(path);
  if (!realDirectory(path) || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    refuse('JOB_PRIVATE_STORAGE_INVALID', 'scratch/candidates: restore an owner-only, literal candidate directory');
  }
  return path;
}

export function candidateStorageBytes(path: string): number {
  const stat = lstatSync(path);
  const bytes = stat.blocks * 512;
  if (stat.isFile()) return bytes;
  if (!stat.isDirectory()) refuse('JOB_PRIVATE_STORAGE_INVALID', 'scratch/candidates: restore a tree of regular files and directories');
  return readdirSync(path).reduce((total, name) => total + candidateStorageBytes(join(path, name)), bytes);
}

/** Call after reclaiming expired batches and before starting another producer. */
export function assertCandidateStorage(path: string, question: string, set: string, liveBytes: number,
  reserveBytes: number, diskReserveBytes = reserveBytes, option?: string): void {
  const held = candidateStorageBytes(path);
  if (held + reserveBytes > CANDIDATE_STORAGE_LIMIT_BYTES) {
    const limit = `${CANDIDATE_STORAGE_LIMIT_BYTES}-byte candidate preview ceiling`;
    const bound = option ? `Composing ${option} would cross the ${limit}.` : `The ${limit} was reached.`;
    refuse('CANDIDATE_STORAGE_LIMIT',
      `scratch/candidates: ${bound} The live batch for ${question}/${set} holds ${liveBytes} allocated bytes. Run rig-create candidate close <dir> --question ${question}, then rerun candidate open for the pending set.`);
  }
  if (diskReserveBytes === 0) return;
  const fs = statfsSync(path, { bigint: true });
  if (fs.bavail * fs.bsize < BigInt(diskReserveBytes)) {
    refuse('CANDIDATE_STORAGE_LIMIT',
      `scratch/candidates: free disk space is below ${diskReserveBytes} bytes. The live batch for ${question}/${set} holds ${liveBytes} allocated bytes. Free disk space, then rerun candidate open for the pending set.`);
  }
}

export interface CandidateBatchIdentity {
  question: string;
  setId: string;
  setSha256: string;
}

const privateBatchName = /^[a-f0-9]{64}$/;

export function candidateBatchPath(storage: string, batch: CandidateBatchIdentity): string {
  const key = createHash('sha256').update(JSON.stringify([batch.question, batch.setSha256])).digest('hex');
  return join(storage, key);
}

export function candidateBatchPaths(storage: string): string[] {
  if (lstatSync(storage, { throwIfNoEntry: false }) === undefined) return [];
  if (!realDirectory(storage)) refuse('JOB_PRIVATE_STORAGE_INVALID', 'scratch/candidates: use a literal candidate directory');
  return readdirSync(storage).filter(name => privateBatchName.test(name)).sort().map(name => {
    const path = join(storage, name);
    if (!realDirectory(path)) refuse('JOB_PRIVATE_STORAGE_INVALID', 'scratch/candidates: candidate batch must be a literal directory');
    return path;
  });
}

export function readCandidateBatchIdentity(storage: string, path: string): CandidateBatchIdentity | undefined {
  const entry = join(path, 'batch.json');
  const stat = lstatSync(entry, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || realpathSync(entry) !== entry || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
    refuse('JOB_PRIVATE_STORAGE_INVALID', 'scratch/candidates: restore the original private candidate batch metadata');
  }
  const batch = JSON.parse(readFileSync(entry, 'utf8')) as Partial<CandidateBatchIdentity>;
  if (typeof batch.question !== 'string' || typeof batch.setId !== 'string' || typeof batch.setSha256 !== 'string'
    || !privateBatchName.test(batch.setSha256) || candidateBatchPath(storage, batch as CandidateBatchIdentity) !== path) {
    refuse('JOB_PRIVATE_STORAGE_INVALID', 'scratch/candidates: restore the original private candidate batch identity');
  }
  return { question: batch.question, setId: batch.setId, setSha256: batch.setSha256 };
}

export const candidateOptionPaths = (batch: string) => readdirSync(batch).filter(name => /^option-[a-f0-9]{64}$/.test(name)).sort().map(name => {
  const path = join(batch, name);
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) {
    refuse('JOB_PRIVATE_STORAGE_INVALID', 'scratch/candidates: use a literal candidate directory');
  }
  return path;
});
