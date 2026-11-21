import { existsSync, readFileSync, realpathSync } from './check-reads.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { JobSelector } from '@rig-c/review/job-host';
import { acquireJobLock, enqueuePublication, failPublication, jobPrivateRoot, pendingPublications, readWriterBinding, type PendingPublication, type WriterBinding } from './job-outbox.ts';
import { liveManifestPath, livePublicationSubjects, draftPackageIdentity, inspectDraftPublication, prepareDraftManifest, prepareLiveManifest, publicationSelector } from './job-publication.ts';
import { asArray, checkProject, isObject, type Finding } from './check.ts';
import { rigVerdictDeferred } from './rig-signoff.ts';
import { Refusal, refuse } from './refusal.ts';
import { shellWord } from './job-acts.ts';
import { acceptedReviewVerdict } from './review.ts';
import { validCarriedRigDraftVerdict } from './rig-draft-verdict.ts';
import type { JsonObject } from './templates.ts';

let checkedBoundTarget: { target: { root: string; jobId: string; selector: JobSelector }; head: string | null } | null = null;

function isSameProcessHost(binding: WriterBinding): boolean {
  try {
    const descriptor = JSON.parse(readFileSync(join(binding.identity.stateDir, 'job-ui', `${binding.jobId}.json`), 'utf8')) as { pid?: unknown };
    return descriptor.pid === process.pid;
  } catch {
    return false;
  }
}

function assertBoundJobAskReady(root: string, binding: WriterBinding, selector: JobSelector): string | null {
  const canonicalRoot = realpathSync(root);
  const target = { root: canonicalRoot, jobId: binding.jobId, selector };
  if (checkedBoundTarget && isDeepStrictEqual(checkedBoundTarget.target, target)) return checkedBoundTarget.head;
  if (isSameProcessHost(binding) || !existsSync(join(jobPrivateRoot(canonicalRoot), 'acknowledged-publications'))) return null;
  let child: ReturnType<typeof Bun.spawnSync<'pipe', 'pipe'>>;
  try {
    child = Bun.spawnSync(jobRuntimeCommand('check-ask'), {
      stdin: Buffer.from(JSON.stringify({ root: canonicalRoot, selector })), stdout: 'pipe', stderr: 'pipe',
    });
  } catch {
    return null;
  }
  if (child.exitCode !== 0) {
    const match = /^([A-Z][A-Z0-9_]*): ([\s\S]+)$/.exec(child.stderr.toString('utf8').trim());
    if (match) refuse(match[1]!, match[2]!);
    return null;
  }
  const head = child.stdout.toString('utf8').trim() || null;
  checkedBoundTarget = { target, head };
  return head;
}

export function acquireBoundJobWrite(root: string, target?: JobSelector): () => void {
  const binding = readWriterBinding(root);
  if (!binding) return () => {};
  const release = acquireJobLock(root)!;
  try {
    if (pendingPublications(root, true).length) refuse('JOB_PUBLISH_PENDING', 'project.json: an earlier committed publication is pending; run rig-create job reconcile before another bound write');
    if (target) assertBoundJobAskReady(root, binding, target);
  } catch (error) { checkedBoundTarget = null; release(); throw error; }
  return () => {
    checkedBoundTarget = null;
    release();
  };
}

export function prepareVersionIntent(root: string, bytes: Buffer, n: number): PendingPublication | null {
  const binding = readWriterBinding(root);
  if (!binding) return null;
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  const selector = publicationSelector(project, n);
  const head = assertBoundJobAskReady(root, binding, selector);
  if (head !== null && livePublicationSubjects(root, project, selector).length === 0) {
    const version = asArray(project.versions).filter(isObject).find(row => row.n === n);
    const verdict = version && asArray(version.verdicts)[acceptedReviewVerdict(version, 'rig-review')];
    if (!version || !isObject(verdict) || !validCarriedRigDraftVerdict(root, project, version, verdict)) {
      // Before rig-review the rig verdict is deferred, not missing: name that route (#754).
      const deferred = selector.kind === 'rig'
        ? rigVerdictDeferred(root, project, checkProject(root, structuredClone(project), { now: Date.now(), readOnly: true }).effective_stage, selector.version, Date.now(), head)
        : null;
      if (deferred) refuse(deferred.code, deferred.message);
      refuse('JOB_PUBLICATION_ASK_REQUIRED', `project.json: replacing open publication ${head} requires an owner ask; keep the open page or use job open when the next review is ready`);
    }
  }
  return enqueuePublication(root, binding, { path: liveManifestPath(root, project, n), selector }, bytes);
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
  const draftWarnings: Finding[] = [];
  const result = typeof n === 'string'
    ? draftPublicationResult(n, inspectDraftPublication(root, project, n, draftWarnings).rigging)
    : { path: liveManifestPath(root, project, n), selector: publicationSelector(project, n) };
  publishedLines.push(...draftWarnings.map(finding => `WARN ${finding.code}: ${finding.message}`));
  const entry = enqueuePublication(root, binding, result);
  entry.phase = 'pending';
  failPublication(root, entry, entry.failure);
  try {
    if (typeof n === 'string') prepareDraftManifest(root, project, n, result.path);
    else {
      const warnings: Finding[] = [];
      prepareLiveManifest(root, project, n, warnings);
      publishedLines.push(...warnings.map(finding => `WARN ${finding.code}: ${finding.message}`));
    }
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

export function draftPublicationResult(id: string, rigging = false): { path: string; selector: { kind: 'draft'; id: string } } {
  return { path: draftPackageIdentity(id, rigging).path, selector: { kind: 'draft', id } };
}

export function prepareDraftIntent(
  root: string, bytes: Buffer, id: string,
): { intent: PendingPublication | null; deferred?: string } {
  const binding = readWriterBinding(root);
  if (!binding) return { intent: null };
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  const dir = shellWord(root);
  const draft = shellWord(id);
  const open = `rig-create job open ${dir} --draft ${draft} --reviewer '<reviewer>' --role owner`;
  const defer = (reason: string) => ({ intent: null, deferred: `job: open page not updated: ${reason} Then run ${open}` });
  let readiness: ReturnType<typeof inspectDraftPublication>;
  try { readiness = inspectDraftPublication(root, project, id); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return defer(`${error.code}: ${error.message}. Run rig-create next ${dir} to prepare the next review.`);
  }
  const { context, missingStructure, diffFinding, rigging } = readiness;
  const repairs: string[] = [];
  if (missingStructure !== undefined) {
    repairs.push(`structure snapshot missing or invalid at ${missingStructure}. Run rig-create structure-snapshot ${dir} --draft ${draft} --out ${shellWord(missingStructure)}.`);
  }
  if (diffFinding !== undefined) {
    repairs.push(`${diffFinding.code}. Run the diff report and diff-classes moves from rig-create next ${dir}.`);
  }
  if (repairs.length > 0) return defer(repairs.join(' '));
  if (context.subjects.length === 0) return defer(`no owner ask is ready. Run rig-create next ${dir} to prepare the next review.`);
  const result = draftPublicationResult(id, rigging);
  try { assertBoundJobAskReady(root, binding, result.selector); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    if (error.code === 'JOB_ASK_PENDING') {
      return defer(`an owner ask for another result is still open. Run rig-create job acts ${dir} and ingest the owner's answer.`);
    }
    return defer(`${error.code}: ${error.message}.`);
  }
  return { intent: enqueuePublication(root, binding, result, bytes) };
}
