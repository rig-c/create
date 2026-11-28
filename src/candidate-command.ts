import { existsSync, realpathSync } from './check-reads.ts';
import { join } from 'node:path';
import { candidateBatchPaths, candidateStorage, CANDIDATE_STORAGE_PATH } from './candidate-storage.ts';
import { tryJobDirectoryLock } from './job-outbox.ts';
import { jobRuntimeCommand } from './job-writer.ts';
import type { PendingJobAct } from './job-acts.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';

export const CANDIDATE_HELP = `  rig-create candidate open <dir> --question <id> --set <id> --reviewer <id> --role owner|delegate
  rig-create candidate close <dir> --question <id>`;

export function candidateRuntimeCommand(action: string): string[] {
  return jobRuntimeCommand(action, join(import.meta.dir, 'candidate-runtime.ts'));
}

export function candidateCommand(args: string[], now: number): number {
  const [verb, ...rest] = args;
  const usage = () => refuse('JOB_BINDING_INVALID', `project.json: choose a candidate operation:\n${CANDIDATE_HELP}`, USAGE_EXIT);
  if (verb !== 'open' && verb !== 'close') return usage();
  const admitted = verb === 'open' ? ['--question', '--set', '--reviewer', '--role'] : ['--question'];
  const options = new Map<string, string>();
  let root: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i]!;
    if (!item.startsWith('-') && root === undefined) { root = item; continue; }
    const value = rest[i + 1];
    if (!admitted.includes(item) || options.has(item) || !value || value.startsWith('-')) return usage();
    options.set(item, value);
    i++;
  }
  const role = options.get('--role');
  if (options.size !== admitted.length || (verb === 'open' && role !== 'owner' && role !== 'delegate')) return usage();
  const stdin = Buffer.from(JSON.stringify({
    root: root ?? process.cwd(), question: options.get('--question'), setId: options.get('--set'),
    reviewer: verb === 'open' ? { id: options.get('--reviewer'), role } : undefined, now,
  }));
  if (verb === 'close') {
    return Bun.spawnSync(candidateRuntimeCommand(verb), { stdin, stdout: 'inherit', stderr: 'inherit' }).exitCode;
  }
  const child = Bun.spawn(candidateRuntimeCommand(verb), { stdin, stdout: 'inherit', stderr: 'inherit' });
  const onInt = () => child.kill('SIGINT');
  const onTerm = () => child.kill('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  void child.exited.then(code => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    process.exitCode = code;
  });
  return 0;
}

export function hasCandidateStorage(root: string): boolean {
  return existsSync(join(root, CANDIDATE_STORAGE_PATH));
}

/** Never wait on a candidate operation while holding a record lock. */
export function acquireCandidateRecordWrite(root: string): (() => void) | undefined {
  if (!hasCandidateStorage(root)) return;
  const release = tryJobDirectoryLock(join(candidateStorage(realpathSync(root)), '.lock'));
  if (!release) refuse('JOB_WRITE_BUSY', 'scratch/candidates: wait for the current candidate operation to finish, then retry the record');
  return release;
}

/** Called after a writer succeeds and releases its project lock. */
export function retireSupersededCandidates(root: string, now: number): void {
  if (!hasCandidateStorage(root)) return;
  try { if (!candidateBatchPaths(join(realpathSync(root), CANDIDATE_STORAGE_PATH)).length) return; } catch { /* Sweep reports unsafe state. */ }
  Bun.spawnSync(candidateRuntimeCommand('sweep'), {
    stdin: Buffer.from(JSON.stringify({ root, now })), stdout: 'ignore', stderr: 'inherit',
  });
}


export function pendingCandidateComments(root: string): PendingJobAct[] {
  if (!hasCandidateStorage(root)) return [];
  try {
    const storage = join(realpathSync(root), CANDIDATE_STORAGE_PATH);
    if (!candidateBatchPaths(storage).some(path => existsSync(join(path, 'ready.json')))) return [];
    const child = Bun.spawnSync(candidateRuntimeCommand('list'), {
      stdin: Buffer.from(JSON.stringify({ root })), stdout: 'pipe', stderr: 'ignore', timeout: 4000,
    });
    return child.exitCode === 0 ? (JSON.parse(child.stdout.toString()) as { acts: PendingJobAct[] }).acts : [];
  } catch { return []; }
}
