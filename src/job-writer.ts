import { existsSync, readFileSync } from './check-reads.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireJobLock, enqueuePublication, failPublication, jobPrivateRoot, pendingPublications, readWriterBinding, type PendingPublication } from './job-outbox.ts';
import { assertDraftPublicationReady, prepareDraftManifest, prepareLiveManifest, publicationSelector } from './job-publication.ts';
import { refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export function acquireBoundJobWrite(root: string): () => void {
  if (!readWriterBinding(root)) return () => {};
  const release = acquireJobLock(root)!;
  try {
    if (pendingPublications(root, true).length) refuse('JOB_PUBLISH_PENDING', 'project.json: an earlier committed publication is pending; run rig-create job reconcile before another bound write');
  } catch (error) { release(); throw error; }
  return release;
}

export function prepareVersionIntent(root: string, bytes: Buffer, n: number): PendingPublication | null {
  const binding = readWriterBinding(root);
  if (!binding) return null;
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  return enqueuePublication(root, binding, { path: `review-live-v${n}.json`, selector: publicationSelector(project, n) }, bytes);
}

export const SOURCE_CONDITION = '@rig-c/source';
export const SOURCE_CONDITION_FLAG = `--conditions=${SOURCE_CONDITION}`;

const EXEC_ARGV_VALUE_FLAGS = new Set([
  '-e', '--eval', '-p', '--print', '-r', '--preload', '--import',
  '--config', '-c', '--cwd', '--env-file', '--define', '-d', '--loader', '-l',
]);

/** Forward only the explicit `@rig-c/source` condition to job-runtime child launches; never arbitrary `process.execArgv` flags. */
export function jobRuntimeExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if (arg === '--') break;
    if (arg === SOURCE_CONDITION_FLAG) return [SOURCE_CONDITION_FLAG];
    if (arg === '--conditions') {
      if (execArgv[++i] === SOURCE_CONDITION) return [SOURCE_CONDITION_FLAG];
      continue;
    }
    if (arg !== undefined && EXEC_ARGV_VALUE_FLAGS.has(arg)) i++;
  }
  return [];
}

export function jobRuntimeCommand(
  action: string,
  runtime = fileURLToPath(new URL('./job-runtime.ts', import.meta.url)),
  execArgv: readonly string[] = process.execArgv,
): string[] {
  return [process.execPath, ...jobRuntimeExecArgv(execArgv), runtime, action];
}

const publishedLines: string[] = [];

export function takePublishedLines(): string[] {
  return publishedLines.splice(0);
}

/** Called by the committing writer, before its own locks are released. */
export function publishCommittedVersion(root: string, n: number | string): string[] {
  const binding = readWriterBinding(root);
  if (!binding) return [];
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  if (typeof n === 'string') assertDraftPublicationReady(root, project, n);
  const result = typeof n === 'string' ? draftPublicationResult(n) : { path: `review-live-v${n}.json`, selector: publicationSelector(project, n) };
  const entry = enqueuePublication(root, binding, result);
  entry.phase = 'pending';
  failPublication(root, entry, entry.failure);
  try {
    if (typeof n === 'string') prepareDraftManifest(root, project, n);
    else prepareLiveManifest(root, project, n);
  } catch {
    const failure = { code: 'JOB_PUBLICATION_INVALID', message: 'project.json: retained review package cannot be prepared; restore its model/direction sources' };
    failPublication(root, entry, failure);
    refuse('JOB_PUBLISH_PENDING', `project.json: committed record ${entry.recordHash} is pending (${failure.code}); run rig-create job reconcile`);
  }
  // A separate Bun process runs asynchronous Review while this synchronous writer
  // keeps its existing call contract and retains both write locks.
  let child: ReturnType<typeof Bun.spawnSync<'pipe', 'pipe'>>;
  try {
    child = Bun.spawnSync(jobRuntimeCommand('publish'), {
      stdin: Buffer.from(JSON.stringify({ root, id: entry.id })), stdout: 'pipe', stderr: 'pipe',
    });
  } catch {
    refuse('JOB_PUBLISH_PENDING', `project.json: record ${entry.recordHash} committed but the publication process could not start; restore the runtime and run rig-create job reconcile`);
  }
  const lines = child.stdout.toString('utf8').split('\n').map(line => line.trim()).filter(Boolean);
  publishedLines.push(...lines);
  if (child.exitCode !== 0) {
    const path = join(jobPrivateRoot(root), 'outbox', `${entry.id}.json`);
    if (!existsSync(path)) {
      const match = /^([A-Z][A-Z0-9_]*): ([\s\S]+)$/.exec(child.stderr.toString('utf8').trim());
      if (match) refuse(match[1]!, match[2]!);
      return lines; // The child acknowledged before its abnormal exit.
    }
    const pending = JSON.parse(readFileSync(path, 'utf8')) as PendingPublication;
    refuse('JOB_PUBLISH_PENDING', `project.json: committed record ${entry.recordHash} awaits publication${pending.failure ? ` (${pending.failure.code}: ${pending.failure.message})` : ''}; run rig-create job reconcile`);
  }
  return lines;
}

export function draftPublicationResult(id: string): { path: string; selector: { kind: 'draft'; id: string } } {
  return { path: `review-draft-${id}.json`, selector: { kind: 'draft', id } };
}

export function prepareDraftIntent(root: string, bytes: Buffer, id: string): PendingPublication | null {
  const binding = readWriterBinding(root);
  if (!binding) return null;
  assertDraftPublicationReady(root, JSON.parse(bytes.toString('utf8')) as JsonObject, id);
  return enqueuePublication(root, binding, draftPublicationResult(id), bytes);
}
