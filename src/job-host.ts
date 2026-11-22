import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { startJobHost, waitForJobAct, type JobHostAttachFailure, type JobHostOptions, type JobHostReuseBinding, type JobOwnerHost, type JobReviewerBinding, type JobSelector } from '@rig-c/review/job-host';
import { asArray, checkProject, collectItems, loadCollection, isObject, type Finding } from './check.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { assembleOnlyDraftTarget, assembleOnlyVersionFinding, assertDraftHasRig, readAssembleOnlyDraftTarget } from './draft-layout.ts';
import { Refusal, refuse } from './refusal.ts';
import { liveManifestPath, draftPackageIdentity, draftPublishedContext, eligibleRigDraftModel, inspectDraftPublication, currentJobIdentity, partsEnumerator, prepareDraftManifest, prepareLiveManifest, publicationFile, publicationSelector, publishedDraft, publishedSourcePainting, readPublished, readRecordPublished, recordOptionSets, riggingDraftPartsChange, type RecordPublicationResult } from './job-publication.ts';
import { acknowledgePublication, acquireJobLock, assertJobIdentity, enqueuePublication, ensureJobPrivateIgnores, failPublication, JOB_BINDING_FILE, jobHash, jobHostStateRoot, pendingPublications, privateDirectory, publicationVersionHash, readAcknowledgedPublication, readWriterBinding, reconcilePublication, refuseJobIdentityMismatch, writePrivateJson, isRecordResult, type PublicationResult, type JobIdentity, type PendingPublication, type WriterBinding, type PublicationSubject } from './job-outbox.ts';
import { draftPublicationResult } from './job-writer.ts';
import { attachCreateJobForClose, refusePendingJobAsks } from './job-close.ts';
import { actionablePendingAct, agentCall, ingestedJobActs, ingestedSummary, jobEvents, pendingJobActs, readHostActsAndAsks, shellWord, type AgentReply, type IngestedJobAct, type PendingJobAct } from './job-acts.ts';
import { checkReviewPackages } from './review-package.ts';
import { reviewVerdictSignable } from './signable.ts';
import { rigVerdictDeferred } from './rig-signoff.ts';
import type { JsonObject } from './templates.ts';
import { recoverReplacedJobHostState, replacedRootRefusal } from './job-host-state.ts';
import { requireOwnerLanguage } from './owner-language.ts';
import { postJobProgress } from './job-progress.ts';
import { reportOwnerSubmitRefusal } from './job-refusal.ts';
import { hasStageOrder, interviewStageOfGuide } from './stages.ts';

function installBinding(root: string, binding: WriterBinding): void {
  ensureJobPrivateIgnores(root);
  writePrivateJson(join(root, JOB_BINDING_FILE), binding, true);
}

function reuseBinding(identity: JobIdentity): JobHostReuseBinding {
  return {
    root: identity.root, stateDir: identity.stateDir, fingerprint: identity.fingerprint,
    reviewer: { id: identity.reviewer.id, role: identity.reviewer.role },
    readerId: identity.readerId, bindingId: identity.bindingId,
    partsEnumeratorId: identity.partsEnumeratorId, partsEnumeratorVersion: identity.enumeratorVersion,
    apiSchema: identity.apiSchema as JobHostReuseBinding['apiSchema'],
    actSchema: identity.actSchema as JobHostReuseBinding['actSchema'],
  };
}

type WriterGrant = Pick<WriterBinding, 'jobId' | 'origin' | 'fetchCapability'>;
type RecordPublishedReader = NonNullable<JobHostOptions['readRecordPublished']>;

function options(
  identity: JobIdentity,
  install: boolean,
  binding?: Pick<WriterBinding, 'jobId' | 'origin' | 'listenerIncarnation'>,
  onGrant?: (grant: WriterGrant) => void,
  now?: number,
): JobHostOptions {
  const readRecord: RecordPublishedReader = now === undefined
    ? readRecordPublished
    : (input => readRecordPublished(input, now)) as RecordPublishedReader;
  return {
    root: identity.root, stateDir: identity.stateDir, fingerprint: identity.fingerprint, reviewer: identity.reviewer,
    readerId: identity.readerId, readPublished, partsEnumeratorId: identity.partsEnumeratorId, partsEnumerator,
    onRefusal: reportOwnerSubmitRefusal,
    ...(identity.publicationMode ? {
      publicationMode: identity.publicationMode,
      readRecordPublished: readRecord,
    } : {}),
    bindingId: identity.bindingId,
    installWriterBinding: async grant => {
      if (install) onGrant?.(grant);
    },
    ...(binding ? {
      reuseOnly: {
        expected: {
          jobId: binding.jobId,
          origin: binding.origin,
          listenerIncarnation: binding.listenerIncarnation,
          binding: reuseBinding(identity),
        },
      },
    } : {}),
  };
}

export async function openCreateJob(
  root: string,
  reviewer: JobReviewerBinding,
  now: number,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
  recordMode = false,
): Promise<JobOwnerHost> {
  root = realpathSync(root);
  const release = acquireJobLock(root)!;
  try {
    // A binding whose root is another directory was copied with the project (a clone or a
    // move). Its host state and port belong to that other root, so this open never reads that
    // state or connects to that port: it starts this root's own job and replaces the copy.
    const found = readWriterBinding(root);
    const existing = found && found.identity.root === root ? found : null;
    if (recordMode && existing && !existing.identity.publicationMode) {
      refuse('JOB_HOST_REUSE_MISMATCH', 'project.json: publicationMode expected=record-and-package found=package-only; finish and ingest pending acts, then run job close once and retry job open');
    }
    const publicationMode = existing ? existing.identity.publicationMode : 'record-and-package';
    const identity = currentJobIdentity({
      root, stateDir: existing?.identity.stateDir ?? join(jobHostStateRoot(root), 'host'),
      fingerprint: 'rig-create/live-review/1', reviewer, ...(publicationMode ? { publicationMode } : {}),
    }, root);
    if (existing) assertJobIdentity(existing.identity, identity);
    privateDirectory(identity.stateDir);
    let writerGrant: WriterGrant | undefined;
    const start = () => startHost({
      ...options(identity, true, undefined, grant => { writerGrant = grant; }),
      ...(existing ? { port: Number(new URL(existing.origin).port) } : {}),
    });
    let host: JobOwnerHost;
    try {
      host = await start();
    } catch (error) {
      if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'JOB_ROOT_REPLACED') throw error;
      if (identity.stateDir !== join(jobHostStateRoot(root), 'host') || !await recoverReplacedJobHostState(root, now)) replacedRootRefusal(root);
      privateDirectory(identity.stateDir);
      try { host = await start(); }
      catch (retryError) {
        if (typeof retryError === 'object' && retryError !== null && (retryError as { code?: unknown }).code === 'JOB_ROOT_REPLACED') replacedRootRefusal(root);
        throw retryError;
      }
    }
    const file = join(root, 'project.json');
    const temporary = join(root, '.rig-create-job-record.tmp');
    try {
      if (host.attachment && writerGrant) {
        installBinding(identity.root, {
          schema: 'rig-create/job-binding@1',
          identity,
          ...writerGrant,
          listenerIncarnation: host.attachment.listenerIncarnation,
        });
      }
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

function isAttachRefused(error: unknown): error is Extract<JobHostAttachFailure, { code: 'JOB_HOST_ATTACH_REFUSED' }> {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'JOB_HOST_ATTACH_REFUSED'
    && typeof (error as { reason?: unknown }).reason === 'string'
    && typeof (error as { phase?: unknown }).phase === 'string';
}

function isReuseMismatch(error: unknown): error is Extract<JobHostAttachFailure, { code: 'JOB_HOST_REUSE_MISMATCH' }> {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'JOB_HOST_REUSE_MISMATCH'
    && typeof (error as { field?: unknown }).field === 'string'
    && 'expected' in error && 'actual' in error;
}

/** One attachment boundary, using Review's strict reuse-only operation. */
export async function attachCreateJob(
  entry: PendingPublication,
  requested = currentJobIdentity(entry.identity, entry.root),
  beforeAttach?: () => void | Promise<void>,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
  now?: number,
): Promise<JobOwnerHost> {
  assertJobIdentity(entry.identity, requested);
  const binding = readWriterBinding(requested.root);
  if (!binding || binding.jobId !== entry.jobId || binding.origin !== entry.origin) {
    refuse('JOB_HOST_REUSE_MISMATCH', `project.json: host incarnation expected=${entry.jobId} found=${binding?.jobId ?? 'absent'}; reopen the original live job before rig-create job reconcile`);
  }
  if (!binding.listenerIncarnation) {
    refuse('JOB_HOST_REUSE_MISMATCH', 'project.json: listenerIncarnation expected=a bound listener found=absent in the private binding; reopen the live job through rig-create job open, then run rig-create job reconcile');
  }
  assertJobIdentity(entry.identity, binding.identity);
  await beforeAttach?.();
  let host: JobOwnerHost;
  try { host = await startHost(options(requested, false, binding, undefined, now)); }
  catch (error) {
    if (isAttachRefused(error)) {
      refuse('JOB_HOST_ATTACH_REFUSED', `project.json: live host attach refused (reason=${error.reason}, phase=${error.phase}); reopen or restore the bound live host before rig-create job reconcile`);
    }
    if (isReuseMismatch(error)) {
      refuseJobIdentityMismatch(error.field, error.expected, error.actual);
    }
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

export async function publishPending(
  entry: PendingPublication,
  requested?: JobIdentity,
  beforeAttach?: () => void | Promise<void>,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
  onPublished?: (publication: { publicationId: string; replaced: boolean }) => void,
  now?: number,
): Promise<AskOutcome[]> {
  const host = await attachCreateJob(entry, requested, beforeAttach, startHost, now);
  try {
    const reportsProgress = await postJobProgress(entry.root, host, { phase: 'publish', text: 'Preparing the Review publication', step: { i: 1, n: 2 } });
    const bytes = readFileSync(join(entry.root, 'project.json'));
    if (publicationVersionHash(bytes, entry.result) !== entry.versionHash) refuse('JOB_PUBLICATION_STALE', 'project.json: pending version changed; restore its retained entry/files before reconciling');
    const currentHash = jobHash(bytes);
    if (currentHash !== entry.recordHash) { entry.recordHash = currentHash; delete entry.generation; }
    const project = JSON.parse(bytes.toString('utf8'));
    let subjects: readonly PublicationSubject[];
    if (isRecordResult(entry.result)) {
      subjects = readRecordPublished({ root: entry.root, record: { path: 'project.json', sha256: entry.recordHash }, result: entry.result, phase: 'inventory' }, now).subjects;
    } else {
      if (!entry.result.selector) refuse('JOB_PUBLICATION_INVALID', 'project.json: a result selector is required for reconciliation');
      if (entry.result.selector.kind === 'draft') prepareDraftManifest(entry.root, project, entry.result.selector.id, entry.result.path);
      else prepareLiveManifest(entry.root, project, entry.result.selector.version);
      subjects = (await readPublished({ root: entry.root, record: { path: 'project.json', sha256: entry.recordHash }, result: entry.result })).subjects;
    }
    const status = host.session.status();
    if (entry.generation === undefined) {
      if (isRecordResult(entry.result)) {
        // A recovered outbox entry may not have reached its first guarded attempt.
        await refusePendingJobAsks(entry.root, entry.jobId, host, entry.result);
      } else if (entry.result.selector?.kind === 'draft' && status.publication && 'selection' in status.publication.source) {
        // A record published earlier in this reconcile can have opened a new ask.
        await refusePendingJobAsks(entry.root, entry.jobId, host, entry.result.selector);
      }
      entry.generation = status.generation;
    }
    entry.phase = 'pending';
    failPublication(entry.root, entry, entry.failure);
    // Draft readiness can change when producer bytes drift without a record write.
    // Keep retries on the stored generation, and give a fresh enqueue its own attempt.
    const attempt = jobHash(JSON.stringify((isRecordResult(entry.result) || entry.result.selector?.kind === 'draft')
      ? [entry.id, entry.recordHash, entry.generation]
      : [entry.id, entry.recordHash]));
    const request = {
      schema: isRecordResult(entry.result) ? 'rig-review/job-api@3' : entry.identity.apiSchema, verb: 'publish', jobId: entry.jobId,
      requestId: attempt, idempotencyKey: attempt, expectedGeneration: entry.generation,
      result: entry.result, freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
    };
    if (reportsProgress) {
      await postJobProgress(entry.root, host, { phase: 'publish', text: 'Sending the publication to Review', step: { i: 2, n: 2 } });
    }
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${entry.jobId}/api`, {
      method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }));
    const result = await response.json() as { schema: string; ok: boolean; error?: { code: string; message?: string }; value?: {
      publicationId: string; generation: number;
      source?: { sourceHash: string; projectHash: string; selector?: JobSelector; package?: { id: string; revision: string }; model?: unknown; direction?: unknown };
    } };
    if (result.schema !== request.schema || !result.ok) {
      const code = result.error?.code ?? 'JOB_PUBLICATION_INVALID';
      // Review rejected this attempt before publishing. Reconciliation must
      // scan the refreshed asks before attempting the new generation.
      if (result.schema === request.schema && code === 'JOB_GENERATION_STALE' && isRecordResult(entry.result)) delete entry.generation;
      const reason = typeof result.error?.message === 'string' && result.error.message.trim() ? `: ${result.error.message}` : '';
      refuse(code, `project.json: publication of record ${entry.recordHash} was refused by review (${code})${reason}; run rig-create job reconcile after restoring the bound sources`);
    }
    if (!result.value) refuse('JOB_OUTBOX_INVALID', 'project.json: publication response lacks its identity; reconcile the pending publication');
    const selector = entry.result.selector;
    const draftIdentity = selector?.kind === 'draft' ? draftPackageIdentity(selector.id, true) : undefined;
    let draftSource;
    let draftReview;
    if (draftIdentity && entry.result.path === draftIdentity.path) {
      const source = result.value.source;
      if (!source || source.package?.id !== draftIdentity.id || source.package.revision !== entry.versionHash
        || !isDeepStrictEqual(source.selector, selector) || source.projectHash !== entry.recordHash
        || !/^[a-f0-9]{64}$/.test(source.sourceHash)) {
        refuse('JOB_PUBLICATION_INVALID', 'project.json: Review acknowledged a different rigging draft source; reconcile the retained draft');
      }
      draftSource = { sourceHash: source.sourceHash, projectHash: source.projectHash };
    } else if (selector?.kind === 'draft' && subjects.some(subject => subject.kind === 'review-verdict' && subject.stage === 'rig-review')) {
      const source = result.value.source;
      const model = eligibleRigDraftModel(publishedDraft(project, selector.id));
      if (!model || !source || source.package?.id !== draftPackageIdentity(selector.id).id || source.package.revision !== entry.versionHash
        || !isDeepStrictEqual(source.selector, selector) || source.projectHash !== entry.recordHash
        || typeof source.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceHash)
        || !isDeepStrictEqual(source.model, model) || source.direction !== null) {
        refuse('JOB_PUBLICATION_INVALID', `drafts[${selector.id}]: Review acknowledged a different compiled draft source; reconcile the retained draft`);
      }
      draftReview = { projectHash: source.projectHash, sourceHash: source.sourceHash, model,
        painting: publishedSourcePainting(entry.root, project, `drafts[${selector.id}]`) };
    }
    acknowledgePublication(entry, result.value.publicationId, result.value.generation, attempt, subjects, draftSource, draftReview);
    onPublished?.({ publicationId: result.value.publicationId, replaced: Boolean(status.publication && status.publication.publicationId !== result.value.publicationId) });
    // The person answers on the page, so every declared subject is asked here, with the
    // agent authority this process already holds in memory. An ask Review refuses never
    // makes the acknowledged publication pending again; the caller names it afterwards.
    return await askDeclaredSubjects(host, result.value.publicationId, subjects, isRecordResult(entry.result));
  } finally { host.stop(); }
}

/** One declared subject after the ask step: asked now, asked before on this publication, or refused by Review. */
export type AskOutcome = { readonly subject: PublicationSubject; readonly status: 'asked' | 'already' }
  | { readonly subject: PublicationSubject; readonly status: 'refused'; readonly code: string; readonly message?: string };

/**The subjects already asked on this publication, from the same event reader as job acts, plus host capabilities from the `next` response. */
async function askedSubjects(host: JobOwnerHost, publicationId: string): Promise<{ asked: PublicationSubject[]; askBatch: boolean }> {
  const asked: PublicationSubject[] = [];
  const capabilities: { askBatch?: boolean } = {};
  for await (const event of jobEvents(host, false, capabilities)) {
    if (event.type === 'pending' && event.ask.publicationId === publicationId) asked.push(event.ask.subject as PublicationSubject);
  }
  return { asked, askBatch: capabilities.askBatch === true };
}

/** Read through the official strict attachment; never bootstrap, publish or install a writer binding. */
export async function listCreateJobActs(
  root: string,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
  wait?: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ jobId: string; acts: PendingJobAct[]; ingested: IngestedJobAct[]; asked: number }> {
  try { root = realpathSync(root); }
  catch { refuse('JOB_HOST_ATTACH_REFUSED', 'project.json: project has no bound live host; open it with job open before job acts'); }
  const binding = readWriterBinding(root);
  if (!binding) refuse('JOB_HOST_ATTACH_REFUSED', 'project.json: no bound live host; open it with job open before job acts');
  const host = await attachCreateJobForClose(root, binding, startHost);
  try {
    const list = async () => {
      const { acts, asks, cursor } = await readHostActsAndAsks(host);
      const project: JsonObject = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
      return { acts: pendingJobActs(project, acts, root), ingested: ingestedJobActs(project, asks, acts, root), asked: asks.length, cursor };
    };
    let listed = await list();
    const result = () => ({ jobId: binding.jobId, acts: listed.acts, ingested: listed.ingested, asked: listed.asked });
    if (!wait || listed.acts.some(actionablePendingAct)) return result();

    const deadline = performance.now() + wait.timeoutMs;
    for (;;) {
      const remaining = Math.min(wait.timeoutMs, Math.ceil(deadline - performance.now()));
      if (remaining <= 0) break;
      const outcome = await waitForJobAct(host, { after: listed.cursor, deadlineMs: remaining, signal: wait.signal }).catch((error: unknown) => {
        if (wait.signal?.aborted) throw error;
        refuse('JOB_ACTS_READ_REFUSED', 'project.json: live job act wait failed; restore the bound host and retry job acts');
      });
      if (outcome.kind === 'timeout') break;
      listed = await list();
      if (listed.acts.some(actionablePendingAct)) return result();
      if (outcome.kind === 'closed') {
        refuse('JOB_ACTS_READ_REFUSED', 'project.json: live job closed during the act wait; reopen it with job open before retrying job acts');
      }
      // Another writer may already have ingested the act that woke the waiter.
    }
    const waiting = listed.acts.find(act => act.waiting)?.waiting;
    if (waiting) {
      refuse('JOB_NEXT_TIMEOUT', `project.json: a grouped interview page is still waiting for ${waiting.received}/${waiting.total} sets before the deadline; ingest nothing yet, have the owner submit the remaining sets, then retry job acts --wait`, 3);
    }
    refuse('JOB_NEXT_TIMEOUT', `project.json: no finalized un-ingested act arrived before the deadline; ${ingestedSummary(listed)}; an ingested act needs no ingest, otherwise retry job acts --wait`, 3);
  } finally { host.stop(); }
}

const ASK_BATCH_LIMIT = 64;

function refusedAskOutcome(subject: PublicationSubject, code: string, message?: string): AskOutcome {
  const trimmed = code === 'JOB_ASK_SUPERSEDED' && typeof message === 'string'
    ? message.replace(/^subjects\[\d+\]: /, '').trim()
    : '';
  return { subject, status: 'refused', code, ...(trimmed ? { message: trimmed } : {}) };
}

/**
 * Ask each declared subject of a publication once. A subject already asked on that
 * publication, pending or answered, is not asked again, so a re-open never shows a second
 * control. Asks stay limited to the declared list (`REVIEW_ACT_SUBJECT_UNDECLARED`).
 */
export async function askDeclaredSubjects(host: JobOwnerHost, publicationId: string, subjects: readonly PublicationSubject[], record: boolean): Promise<AskOutcome[]> {
  const { asked: before, askBatch } = await askedSubjects(host, publicationId);
  // Review's ask-batch is record mode only; a package-retained head refuses it (review#963).
  if (!askBatch || !record) {
    const outcomes: AskOutcome[] = [];
    for (const subject of subjects) {
      if (before.some(asked => isDeepStrictEqual(asked, subject))) { outcomes.push({ subject, status: 'already' }); continue; }
      const expectedGeneration = host.session.status().generation;
      let reply: AgentReply;
      try {
        reply = await agentCall(host, { verb: 'ask', expectedGeneration, publicationId, subject,
          idempotencyKey: jobHash(JSON.stringify([publicationId, subject, expectedGeneration])) });
      } catch { reply = { ok: false }; }
      outcomes.push(reply.ok ? { subject, status: 'asked' } : refusedAskOutcome(subject, reply.error?.code ?? 'JOB_ASK_INVALID', reply.error?.message));
    }
    return outcomes;
  }
  const outcomes: (AskOutcome | undefined)[] = subjects.map(subject =>
    before.some(asked => isDeepStrictEqual(asked, subject)) ? { subject, status: 'already' } : undefined);
  const remaining = subjects.flatMap((subject, index) => outcomes[index] ? [] : [{ subject, index }]);
  for (let offset = 0; offset < remaining.length; offset += ASK_BATCH_LIMIT) {
    const chunk = remaining.slice(offset, offset + ASK_BATCH_LIMIT);
    const batchSubjects = chunk.map(item => item.subject);
    const expectedGeneration = host.session.status().generation;
    let reply: AgentReply;
    try {
      reply = await agentCall(host, { verb: 'ask-batch', expectedGeneration, publicationId, subjects: batchSubjects,
        idempotencyKey: jobHash(JSON.stringify([publicationId, batchSubjects, expectedGeneration])) });
    } catch { reply = { ok: false }; }
    const asks = reply.ok && Array.isArray(reply.value?.asks) ? reply.value.asks : undefined;
    if (asks && asks.length === chunk.length) {
      for (let i = 0; i < chunk.length; i++) outcomes[chunk[i]!.index] = { subject: chunk[i]!.subject, status: 'asked' };
      continue;
    }
    const code = reply.error?.code ?? 'JOB_ASK_INVALID';
    const message = reply.error?.message;
    const match = typeof message === 'string' ? /^subjects\[(\d+)\]: /.exec(message) : null;
    const failedIndex = match ? Number(match[1]) : -1;
    if (failedIndex >= 0 && failedIndex < chunk.length) {
      outcomes[chunk[failedIndex]!.index] = refusedAskOutcome(chunk[failedIndex]!.subject, code, message);
    } else {
      for (const item of chunk) outcomes[item.index] = refusedAskOutcome(item.subject, code, message);
    }
    break;
  }
  return outcomes.filter((outcome): outcome is AskOutcome => outcome !== undefined);
}

export function subjectLabel(subject: PublicationSubject): string {
  switch (subject.kind) {
    case 'parts-verdict': return `parts-verdict ${subject.draftId}`;
    case 'checkpoint': return `checkpoint ${subject.checkpointId}`;
    case 'interview-picks': return `interview-picks ${subject.questionId}/${subject.setId}`;
    default: return `${subject.kind} ${subject.stage}`;
  }
}

/** Format `asked` and `already` outcome lines for `job open` and bound writers. */
export function askOutcomeLines(outcomes: readonly AskOutcome[]): string[] {
  const lines: string[] = [];
  for (const status of ['asked', 'already'] as const) {
    const named = outcomes.filter(outcome => outcome.status === status).map(outcome => subjectLabel(outcome.subject));
    if (named.length) lines.push(`job: ${status === 'asked' ? 'asked' : 'already asked'} ${named.join(', ')}`);
  }
  return lines;
}

/** Name every ask Review refused. The publications themselves are acknowledged. */
export function refuseAskOutcomes(outcomes: readonly AskOutcome[]): void {
  const refused = outcomes.filter((outcome): outcome is Extract<AskOutcome, { status: 'refused' }> => outcome.status === 'refused');
  if (!refused.length) return;
  const named = refused.map(outcome => `${subjectLabel(outcome.subject)} (${outcome.code}${outcome.message ? `: ${outcome.message}` : ''})`).join(', ');
  refuse('JOB_ASK_REFUSED', `project.json: the publication is acknowledged but review refused the ask for ${named}; restore the published record bytes and run rig-create job open to ask again`);
}

export async function reconcileCreateJob(root: string, publish?: (entry: PendingPublication) => Promise<unknown>, now?: number): Promise<number> {
  root = realpathSync(root);
  const release = acquireJobLock(root)!;
  let outcomes: AskOutcome[];
  let count: number;
  try {
    const binding = readWriterBinding(root);
    if (!binding || binding.identity.stateDir === join(jobHostStateRoot(root), 'host')) await recoverReplacedJobHostState(root, now);
    ({ count, outcomes } = await reconcileLocked(root, publish, now));
  }
  finally { release(); }
  refuseAskOutcomes(outcomes);
  return count;
}

/**
 * Receipt IDs are hashes and carry no order, so pending entries go in record order (#849).
 * Record results go first: a draft or version published before them could invalidate the
 * generation a queued record publication reserved. Drafts follow in project.drafts order,
 * then rig and post versions by number, so the newest version ends as the page head.
 * `last` names the entry the caller asked for; it goes last and ends as the head.
 */
function inRecordOrder(root: string, entries: PendingPublication[], last?: string): PendingPublication[] {
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  const drafts = asArray(project.drafts).map(draft => isObject(draft) ? draft.id : undefined);
  const unknown = Number.MAX_SAFE_INTEGER;
  const rank = (entry: PendingPublication): [number, number] => {
    if (entry.id === last) return [3, 0];
    if (isRecordResult(entry.result)) return [0, 0];
    const selector = entry.result.selector;
    if (selector?.kind === 'draft') {
      const index = drafts.indexOf(selector.id);
      return [1, index < 0 ? unknown : index];
    }
    return [2, typeof selector?.version === 'number' ? selector.version : unknown];
  };
  return entries.map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .sort((left, right) => left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || left.index - right.index)
    .map(item => item.entry);
}

/** The label `job open` prints for a publication result. */
function resultLabel(result: PublicationResult): string {
  if (isRecordResult(result)) {
    return result.kind === 'plan' ? 'plan' : `option-set ${recordOptionSets(result).map(({ questionId, setId }) => `${questionId}/${setId}`).join(', ')}`;
  }
  return result.selector ? selectorLabel(result.selector) : 'publication';
}

/** One line for every pending publication a `job open` published besides the one it asked for (#849). */
function pendingPublishedLines(published: readonly PendingPublication[], target: string): string[] {
  return published.filter(entry => entry.id !== target).map(entry => `job: pending ${resultLabel(entry.result)} published`);
}

/** Publish every pending entry under the caller's job lock. Ask outcomes are returned, not thrown. */
async function reconcileLocked(
  root: string,
  publish: (entry: PendingPublication) => Promise<unknown> = entry => publishPending(entry, undefined, undefined, undefined, undefined, now),
  now?: number,
  last?: string,
): Promise<{ count: number; outcomes: AskOutcome[]; published: PendingPublication[] }> {
  const outcomes: AskOutcome[] = [];
  const published: PendingPublication[] = [];
  const entries = inRecordOrder(root, pendingPublications(root, true), last);
  for (const entry of entries) {
    try {
      await reconcilePublication(root, entry, async item => {
        const result = await publish(item);
        if (Array.isArray(result)) outcomes.push(...result as AskOutcome[]);
      });
    } catch (error) {
      const failure = error instanceof Refusal ? { code: error.code, message: error.message }
        : { code: 'JOB_PUBLISH_PENDING', message: 'project.json: host publication failed; restore the live host before rig-create job reconcile' };
      failPublication(root, entry, failure);
      refuse('JOB_PUBLISH_PENDING', `project.json: record ${entry.recordHash} remains pending (${failure.code}: ${failure.message}); run rig-create job reconcile after restoring the sources, or job close --retire-refused to archive failed publications and close without publishing them`);
    }
    published.push(entry);
  }
  return { count: entries.length, outcomes, published };
}

/** The stages whose record consumes a draft: `job open` publishes the latest one there. */
const DRAFT_OPEN_STAGES = ['parts', 'parts-review'];

export function assertRequestedDraft(root: string, requested?: string, now = Date.now()): { bytes: Buffer; ids: string[]; stage: string | null; draftId?: string } {
  root = realpathSync(root);
  const bytes = readFileSync(join(root, 'project.json'));
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  const ids = (Array.isArray(project.drafts) ? project.drafts : []).map(draft => (draft as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string');
  if (requested !== undefined && !ids.includes(requested)) {
    refuse('JOB_DRAFT_UNKNOWN', `project.json.drafts: no recorded draft has id ${requested}; record it with rig-create draft-rig or name a recorded draft`);
  }
  const stage = checkProject(root, project, { now, readOnly: true }).effective_stage;
  if (requested !== undefined && stage === 'rigging') {
    const draft = publishedDraft(project, requested);
    const change = riggingDraftPartsChange(root, project, draft, stage);
    if (change) refuse(change.code, change.message);
    if (eligibleRigDraftModel(draft)) draftPublishedContext(root, project, requested);
  }
  if (requested !== undefined && stage === 'parts-review') {
    const { missingStructure } = inspectDraftPublication(root, project, requested, [], stage);
    if (missingStructure !== undefined) {
      const command = ['rig-create', 'structure-snapshot', root, '--draft', requested].map(shellWord).join(' ');
      refuse('JOB_PARTS_VERDICT_UNASKABLE', `drafts[${requested}]: stage parts-review requires a valid structure snapshot at ${missingStructure} before publishing a draft for its parts-verdict; run ${command} and retry job open --draft ${shellWord(requested)}`);
    }
  }
  const draftId = requested ?? (DRAFT_OPEN_STAGES.includes(String(stage)) ? ids.at(-1) : undefined);
  return { bytes, ids, stage, ...(draftId === undefined ? {} : { draftId }) };
}

/** Validate an explicit registered rig or post before job open installs a binding or starts a host. */
export function assertRequestedRig(root: string, requested?: string, draft?: string): Exclude<JobSelector, { kind: 'draft' }> | undefined {
  if (requested === undefined) return undefined;
  if (draft !== undefined) refuse('JOB_BINDING_INVALID', 'project.json: job open takes either --draft <id> or --rig <n>; choose one recorded result');
  const n = Number(requested.replace(/^v/, ''));
  if (!Number.isSafeInteger(n) || n < 1) {
    assertDraftHasRig(readAssembleOnlyDraftTarget(root, requested), 'project.json.versions');
    refuse('JOB_PUBLICATION_INVALID', 'project.json.versions: --rig needs a positive registered rig or post version (1 or v1); choose its recorded number');
  }
  root = realpathSync(root);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  assertDraftHasRig(assembleOnlyDraftTarget(project, requested), 'project.json.versions');
  const matches = asArray(project.versions).filter(version => isObject(version) && version.n === n);
  if (matches.length === 1 && isObject(matches[0])) {
    const finding = assembleOnlyVersionFinding(root, project, matches[0], `versions[v${n}]`);
    if (finding) refuse(finding.code, finding.message);
  }
  if (matches.length !== 1 || !isObject(matches[0]) || !['rig', 'post'].includes(String(matches[0].kind))) {
    refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: --rig needs one recorded rig or post version; choose an existing result number`);
  }
  const selector = publicationSelector(project, n);
  const rig = selector.kind === 'post' ? selector.rigVersion : n;
  if (selector.kind === 'post') assertDraftHasRig(assembleOnlyDraftTarget(project, rig), `versions[v${n}].rig_version`);
  const parents = asArray(project.versions).filter(version => isObject(version) && version.n === rig && version.kind === 'rig');
  if (parents.length !== 1 || !isObject(parents[0])) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}].rig_version: restore the one recorded parent rig before job open`);
  const rigVersion = parents[0];
  if (selector.kind === 'post') {
    const finding = assembleOnlyVersionFinding(root, project, rigVersion, `versions[v${rig}]`);
    if (finding) refuse(finding.code, finding.message);
  }
  const pkg = rigVersion.review_package;
  if (!isObject(pkg) || !Array.isArray(pkg.files) || pkg.files.length === 0) {
    refuse('JOB_PUBLICATION_INVALID', `versions[v${rig}].review_package: retained package identity is missing; restore the recorded package before job open`);
  }
  publicationFile(root, `derived/review/v${rig}/out/check/build/skeleton.model.json`);
  const context = {
    dir: root,
    // Explicit publication requires package integrity even for a pre-interview rig.
    project: { ...project, versions: asArray(project.versions).map(version => version === rigVersion ? { ...rigVersion, pre_interview: false } : version) },
    refusals: [] as Finding[], warnings: [] as Finding[],
  };
  checkReviewPackages(context);
  const failure = context.refusals[0];
  if (failure) refuse(failure.code, `${failure.message}; restore the frozen review package before job open`);
  return selector;
}

function selectorResult(root: string, selector: JobSelector, rigging = false): PendingPublication['result'] {
  return selector.kind === 'draft'
    ? draftPublicationResult(selector.id, rigging)
    : { path: liveManifestPath(root, JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')), selector.version), selector };
}

function selectorLabel(selector: JobSelector): string {
  return selector.kind === 'draft' ? `draft ${selector.id}` : `${selector.kind} v${selector.version}`;
}

/** A single --question, repeated --question values, or --questions for the stage. */
type QuestionSelection = string | readonly string[] | true;

/** Resolve the requested current record subjects before opening a host. */
export function requestedRecordResult(root: string, question?: QuestionSelection, plan = false, now = Date.now()): RecordPublicationResult | undefined {
  return requestedRecordPublication(root, question, plan, now)?.result;
}

function requestedRecordPublication(root: string, question: QuestionSelection | undefined, plan: boolean, now: number): {
  result: RecordPublicationResult;
  recordHash: string;
  subjects: readonly PublicationSubject[];
} | undefined {
  if (question === undefined && !plan) return undefined;
  if (question !== undefined && plan) refuse('JOB_BINDING_INVALID', 'project.json: choose one of --question, --questions or --plan');
  const bytes = readFileSync(join(root, 'project.json'));
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  requireOwnerLanguage(project);
  let result: RecordPublicationResult = { kind: 'plan' };
  if (question !== undefined) {
    const items = collectItems(project, { collection: loadCollection(root, project) });
    let questions: readonly string[];
    if (question === true) {
      const stage = checkProject(root, project, { now, readOnly: true, recordPublication: true }).effective_stage;
      questions = items.filter(item => item.record.pending_options !== undefined
        && interviewStageOfGuide(item.id, item.kind === 'post', hasStageOrder(project)) === stage).map(item => item.id);
    } else {
      questions = typeof question === 'string' ? [question] : question;
    }
    if (questions.length === 0 || questions.length > 64) {
      refuse('JOB_RECORD_SUBJECT_INVALID', 'project.json: select 1 to 64 pending option sets in the effective stage; register missing sets with rig-create interview-options or select a group with repeated --question');
    }
    const sets = questions.map(questionId => {
      const matches = items.filter(item => item.id === questionId);
      const binding = matches.length === 1 ? matches[0]!.record.pending_options : undefined;
      if (!isObject(binding) || typeof binding.path !== 'string') refuse('JOB_RECORD_SUBJECT_INVALID', `project.json: requested question has no unique pending option set; register it with rig-create interview-options ${questionId} '${root.replaceAll("'", "'\\''")}' --file '<option-set.json>' first (draft a new option set to re-ask an answered question)`);
      const set = JSON.parse(publicationFile(root, binding.path).toString('utf8')) as JsonObject;
      if (typeof set.id !== 'string') refuse('JOB_RECORD_SUBJECT_INVALID', 'project.json: pending option set has no id; restore its original identity');
      return { questionId, setId: set.id };
    });
    result = { kind: 'option-set', ...sets[0]!, ...(sets.length > 1 ? { sets } : {}) };
  }
  const recordHash = jobHash(bytes);
  const { subjects } = readRecordPublished({ root, record: { path: 'project.json', sha256: recordHash }, result, phase: 'inventory' }, now);
  return { result, recordHash, subjects };
}
export async function openRecordPublication(root: string, host: JobOwnerHost, question: QuestionSelection | undefined, plan: boolean, now: number): Promise<string[]> {
  const release = acquireJobLock(root)!;
  let outcomes: AskOutcome[];
  let reused = false;
  let others: string[] = [];
  let result: RecordPublicationResult;
  try {
    const publication = requestedRecordPublication(root, question, plan, now);
    if (!publication) refuse('JOB_PUBLICATION_INVALID', 'project.json: expected a record subject; choose --question, --questions or --plan');
    result = publication.result;
    const head = host.session.status().publication;
    const ack = head ? readAcknowledgedPublication(root, host.session.jobId, head.publicationId) : null;
    if (head && ack && isDeepStrictEqual(ack.result, result) && ack.versionHash === publication.recordHash
      && isDeepStrictEqual(ack.subjects, publication.subjects)) {
      reused = true;
      outcomes = await askDeclaredSubjects(host, head.publicationId, publication.subjects, true);
    } else {
      const binding = readWriterBinding(root);
      if (!binding || binding.jobId !== host.session.jobId) refuse('JOB_BINDING_INVALID', 'project.json: open the writer-owned job before publishing');
      // A new publication supersedes the job's pending asks (#737).
      const generation = host.session.status().generation;
      await refusePendingJobAsks(root, binding.jobId, host, result);
      const pending = enqueuePublication(root, binding, result);
      if (pending.generation === undefined) {
        pending.generation = generation;
        failPublication(root, pending, pending.failure);
      }
      let published: PendingPublication[];
      ({ outcomes, published } = await reconcileLocked(root, undefined, now));
      others = pendingPublishedLines(published, pending.id);
    }
  } finally { release(); }
  refuseAskOutcomes(outcomes);
  return [`job: ${resultLabel(result)} ${reused ? 'already published' : 'published'}`, ...others, ...askOutcomeLines(outcomes)];
}

/**
 * After `job open`: show or refresh the record's current publication on the owner's page.
 * The latest recorded draft (or `--draft <id>`), or the head's `rig` / `post` selector at
 * later stages, is published unless the job's head publication already covers that selector
 * over the current record bytes, and every subject the publication declares is asked once.
 * Returns the lines `job open` prints.
 */
export async function openDraftPublication(root: string, host: JobOwnerHost, now: number, requested?: string, requestedRig?: string): Promise<string[]> {
  root = realpathSync(root);
  const rigSelector = assertRequestedRig(root, requestedRig, requested);
  const { bytes, ids, stage, draftId } = assertRequestedDraft(root, requested, now);
  const head = host.session.status().publication;
  const source = head?.source as { selector?: JobSelector; projectHash?: unknown; package?: { id: string } } | undefined;
  const acknowledged = head ? readAcknowledgedPublication(root, host.session.jobId, head.publicationId) : null;
  const headSelector = acknowledged?.result.selector ?? source?.selector ?? null;
  const targetSelector: JobSelector | undefined = rigSelector ?? (draftId !== undefined
    ? { kind: 'draft', id: draftId }
    : headSelector && headSelector.kind !== 'draft'
      ? headSelector
      : undefined);
  const warnings: Finding[] = [];
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  const deferred = targetSelector?.kind === 'rig' ? rigVerdictDeferred(root, project, stage, targetSelector.version, now) : null;
  if (deferred) warnings.push(deferred);
  const draft = targetSelector?.kind === 'draft'
    ? inspectDraftPublication(root, project, targetSelector.id, warnings, stage)
    : undefined;
  // Re-publish an older post head that still declares a sign-off or checkpoint:
  // either pending ask would prevent the legacy direction panel from rendering.
  const currentSubjects = draft?.context.subjects ?? (targetSelector?.kind === 'post'
    ? (reviewVerdictSignable(project, targetSelector.version, 'direction-review')
      ? [{ kind: 'review-verdict' as const, stage: 'direction-review' as const }]
      : [])
    : undefined);
  const sameDraftPackage = targetSelector?.kind !== 'draft'
    || Boolean(draft?.rigging) === (source?.package?.id === draftPackageIdentity(targetSelector.id, true).id);
  const reuseHead = Boolean(head && headSelector && sameDraftPackage && source?.projectHash === jobHash(bytes) && (
    targetSelector === undefined || isDeepStrictEqual(headSelector, targetSelector)
  ) && (currentSubjects === undefined || isDeepStrictEqual(acknowledged?.subjects, currentSubjects)));
  let selector: JobSelector;
  let outcomes: AskOutcome[];
  let published: boolean;
  let others: string[] = [];
  if (reuseHead && head && headSelector) {
    const result = acknowledged?.result ?? selectorResult(root, headSelector, draft?.rigging);
    const subjects = acknowledged?.subjects
      ?? (await readPublished({ root, record: { path: 'project.json', sha256: jobHash(bytes) }, result: result as Parameters<typeof readPublished>[0]['result'] })).subjects;
    outcomes = await askDeclaredSubjects(host, head.publicationId, subjects, false);
    selector = headSelector;
    published = false;
  } else {
    if (targetSelector === undefined) {
      return ids.length === 0 ? ['job: no recorded draft to publish'] : [`job: stage ${stage} shows no draft; name one with --draft <id>`];
    }
    const release = acquireJobLock(root)!;
    try {
      const binding = readWriterBinding(root);
      if (!binding || binding.jobId !== host.session.jobId) refuse('JOB_BINDING_INVALID', 'project.json: the open job has no matching writer-owned binding; restore the writer-owned binding and retry rig-create job open to publish into the existing job');
      if (targetSelector.kind === 'draft' && pendingPublications(root, true).some(entry => isRecordResult(entry.result))) {
        refuse('JOB_PUBLISH_PENDING', 'project.json: a record publication is pending; run rig-create job reconcile before opening the draft');
      }
      const current = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
      requireOwnerLanguage(current);
      // A new publication supersedes the job's pending asks: one ask at a time (#737, #740).
      await refusePendingJobAsks(root, binding.jobId, host, targetSelector);
      const rigging = targetSelector.kind === 'draft' && inspectDraftPublication(root, current, targetSelector.id).rigging;
      const result = selectorResult(root, targetSelector, rigging);
      if (rigSelector) prepareLiveManifest(root, current, rigSelector.version, warnings);
      const pending = enqueuePublication(root, binding, result);
      // A named --rig or --draft ends as the head; a republished head yields to newer pending versions (#849).
      const named = rigSelector !== undefined || requested !== undefined;
      let published: PendingPublication[];
      ({ outcomes, published } = await reconcileLocked(root, undefined, now, named ? pending.id : undefined));
      others = pendingPublishedLines(published, pending.id);
    } finally { release(); }
    selector = targetSelector;
    published = true;
  }
  const lines = [...warnings.map(finding => `WARN ${finding.code}: ${finding.message}`),
    `job: ${selectorLabel(selector)} ${published ? 'published' : 'already published'}`, ...others, ...askOutcomeLines(outcomes)];
  refuseAskOutcomes(outcomes);
  return lines;
}

export { closeCreateJob, withdrawCreateJobAct } from './job-close.ts';
