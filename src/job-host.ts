import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJobHost, type JobHostOptions, type JobOwnerHost, type JobReviewerBinding } from '@rig-c/review/job-host';
import { checkProject } from './check.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { Refusal, refuse } from './refusal.ts';
import { currentJobIdentity, partsEnumerator, prepareDraftManifest, prepareLiveManifest, readPublished } from './job-publication.ts';
import { acknowledgePublication, acquireJobLock, assertJobIdentity, ensureJobPrivateIgnores, failPublication, JOB_BINDING_FILE, jobHash, jobHostStateRoot, pendingPublications, privateDirectory, publicationVersionHash, readWriterBinding, reconcilePublication, writePrivateJson, type JobIdentity, type PendingPublication, type WriterBinding } from './job-outbox.ts';

function installBinding(root: string, binding: WriterBinding): void {
  ensureJobPrivateIgnores(root);
  writePrivateJson(join(root, JOB_BINDING_FILE), binding, true);
}

function options(identity: JobIdentity, install: boolean): JobHostOptions {
  return {
    root: identity.root, stateDir: identity.stateDir, fingerprint: identity.fingerprint, reviewer: identity.reviewer,
    readerId: identity.readerId, readPublished, partsEnumeratorId: identity.partsEnumeratorId, partsEnumerator,
    bindingId: identity.bindingId,
    installWriterBinding: async grant => {
      if (install) installBinding(identity.root, { schema: 'rig-create/job-binding@1', identity, ...grant });
    },
  };
}

export async function openCreateJob(root: string, reviewer: JobReviewerBinding, now: number): Promise<JobOwnerHost> {
  root = realpathSync(root);
  const release = acquireJobLock(root)!;
  try {
    const existing = readWriterBinding(root);
    const identity = currentJobIdentity({ root, stateDir: existing?.identity.stateDir ?? join(jobHostStateRoot(root), 'host'), fingerprint: 'rig-create/live-review/1', reviewer }, root);
    privateDirectory(identity.stateDir);
    if (existing) assertJobIdentity(existing.identity, identity);
    const host = await startJobHost({ ...options(identity, true), ...(existing ? { port: Number(new URL(existing.origin).port) } : {}) });
    const file = join(root, 'project.json');
    const temporary = join(root, '.rig-create-job-record.tmp');
    try {
      const project = JSON.parse(readFileSync(file, 'utf8'));
      const next = { ...project, review_job: { jobId: host.session.jobId, origin: host.origin } };
      const failure = newFindings(baselineOf(checkProject(root, project, { now })), checkProject(root, next, { now }).refusals);
      // Validation uses the ordinary checker before this writer replaces the record.
      if (failure[0]) refuse(failure[0].code, failure[0].message);
      if (JSON.stringify(project.review_job) !== JSON.stringify(next.review_job)) {
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
        renameSync(temporary, file);
      }
      return host;
    } catch (error) { host.stop(); throw error; }
    finally { rmSync(temporary, { force: true }); }
  } finally { release(); }
}

/** One attachment boundary, to switch to Review's future reuse-only operation. */
export async function attachCreateJob(entry: PendingPublication, requested = currentJobIdentity(entry.identity, entry.root),
  beforeAttach?: () => void | Promise<void>): Promise<JobOwnerHost> {
  assertJobIdentity(entry.identity, requested);
  const binding = readWriterBinding(requested.root);
  if (!binding || binding.jobId !== entry.jobId || binding.origin !== entry.origin) {
    refuse('JOB_HOST_REUSE_MISMATCH', `project.json: host incarnation expected=${entry.jobId} found=${binding?.jobId ?? 'absent'}; reopen the original live job before rig-create job reconcile`);
  }
  assertJobIdentity(entry.identity, binding.identity);
  await beforeAttach?.();
  let host: JobOwnerHost;
  try { host = await startJobHost(options(requested, false)); }
  catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === 'JOB_HOST_REUSE_MISMATCH') {
      refuse('JOB_HOST_REUSE_MISMATCH', `project.json: ${error.message}; restore the bound host options before rig-create job reconcile`);
    }
    throw error;
  }
  if (!host.reused || host.session.jobId !== entry.jobId || host.origin !== entry.origin) {
    host.stop();
    refuse('JOB_HOST_REUSE_MISMATCH', `project.json: host incarnation expected=${entry.jobId}@${entry.origin} found=${host.session.jobId}@${host.origin} reused=${host.reused}; restore the original live host before rig-create job reconcile`);
  }
  return host;
}

export async function publishPending(entry: PendingPublication, requested?: JobIdentity,
  beforeAttach?: () => void | Promise<void>): Promise<void> {
  const host = await attachCreateJob(entry, requested, beforeAttach);
  try {
    const bytes = readFileSync(join(entry.root, 'project.json'));
    if (publicationVersionHash(bytes, entry.result) !== entry.versionHash) refuse('JOB_PUBLICATION_STALE', 'project.json: pending version changed; restore its retained entry/files before reconciling');
    const currentHash = jobHash(bytes);
    if (currentHash !== entry.recordHash) { entry.recordHash = currentHash; delete entry.generation; }
    const project = JSON.parse(bytes.toString('utf8'));
    if (!entry.result.selector) refuse('JOB_PUBLICATION_INVALID', 'project.json: a result selector is required for reconciliation');
    if (entry.result.selector.kind === 'draft') prepareDraftManifest(entry.root, project, entry.result.selector.id);
    else prepareLiveManifest(entry.root, project, entry.result.selector.version);
    await readPublished({ root: entry.root, record: { path: 'project.json', sha256: entry.recordHash }, result: entry.result });
    entry.generation ??= host.session.status().generation;
    entry.phase = 'pending';
    failPublication(entry.root, entry, entry.failure);
    const attempt = jobHash(JSON.stringify([entry.id, entry.recordHash]));
    const request = {
      schema: entry.identity.apiSchema, verb: 'publish', jobId: entry.jobId,
      requestId: attempt, idempotencyKey: attempt, expectedGeneration: entry.generation,
      result: entry.result, freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
    };
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${entry.jobId}/api`, {
      method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }));
    const result = await response.json() as { schema: string; ok: boolean; error?: { code: string; detail?: string }; value?: { publicationId: string; generation: number } };
    if (result.schema !== entry.identity.apiSchema || !result.ok) {
      const code = result.error?.code ?? 'JOB_PUBLICATION_INVALID';
      refuse(code, `project.json: publication of record ${entry.recordHash} was refused by review (${code}); run rig-create job reconcile after restoring the bound sources`);
    }
    if (!result.value) refuse('JOB_OUTBOX_INVALID', 'project.json: publication response lacks its identity; reconcile the pending publication');
    acknowledgePublication(entry, result.value.publicationId, result.value.generation, attempt);
  } finally { host.stop(); }
}

export async function reconcileCreateJob(root: string, publish = publishPending): Promise<number> {
  const release = acquireJobLock(root)!;
  try {
    const entries = pendingPublications(root, true);
    for (const entry of entries) {
      try { await reconcilePublication(root, entry, publish); }
      catch (error) {
        const failure = error instanceof Refusal ? { code: error.code, message: error.message }
          : { code: 'JOB_PUBLISH_PENDING', message: 'project.json: host publication failed; restore the live host before rig-create job reconcile' };
        failPublication(root, entry, failure);
        refuse('JOB_PUBLISH_PENDING', `project.json: record ${entry.recordHash} remains pending (${failure.code}: ${failure.message}); run rig-create job reconcile`);
      }
    }
    return entries.length;
  } finally { release(); }
}

export async function closeCreateJob(root: string): Promise<void> {
  const release = acquireJobLock(root)!;
  try {
    if (pendingPublications(root).length) refuse('JOB_PUBLISH_PENDING', 'project.json: a committed publication remains pending; run rig-create job reconcile before closing');
    const binding = readWriterBinding(root);
    if (!binding) refuse('JOB_BINDING_INVALID', 'project.json: no writer-owned job binding; open the live job first');
    const entry: PendingPublication = { schema: 'rig-create/job-pending@1', root: realpathSync(root), id: jobHash('close'), jobId: binding.jobId, origin: binding.origin,
      identity: binding.identity, recordHash: jobHash(readFileSync(join(root, 'project.json'))), result: { path: 'unused', selector: null }, failure: null };
    const host = await attachCreateJob(entry);
    try {
      const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${binding.jobId}/api`, {
        method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
        body: JSON.stringify({ schema: binding.identity.apiSchema, verb: 'close', jobId: binding.jobId, requestId: 'create-close',
          idempotencyKey: 'create-close', expectedGeneration: host.session.status().generation, reason: 'producer-close' }),
      }));
      const result = await response.json() as { ok: boolean };
      if (!result.ok) refuse('JOB_BINDING_INVALID', 'project.json: review refused close; restore the bound live host and retry rig-create job close');
      rmSync(join(root, JOB_BINDING_FILE));
    } finally { host.stop(); }
  } finally { release(); }
}
