import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { startJobHost, type JobHostAttachFailure, type JobHostOptions, type JobHostReuseBinding, type JobOwnerHost, type JobReviewerBinding, type JobSelector, type JobSubject } from '@rig-c/review/job-host';
import { checkProject, type Finding } from './check.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { Refusal, refuse } from './refusal.ts';
import { draftPublicationContext, currentJobIdentity, partsEnumerator, prepareDraftManifest, prepareLiveManifest, readPublished } from './job-publication.ts';
import { acknowledgePublication, acquireJobLock, assertJobIdentity, enqueuePublication, ensureJobPrivateIgnores, failPublication, JOB_BINDING_FILE, jobHash, jobHostStateRoot, pendingPublications, privateDirectory, publicationVersionHash, readAcknowledgedPublication, readWriterBinding, reconcilePublication, writePrivateJson, type JobIdentity, type PendingPublication, type WriterBinding } from './job-outbox.ts';
import { draftPublicationResult } from './job-writer.ts';

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

function options(
  identity: JobIdentity,
  install: boolean,
  binding?: Pick<WriterBinding, 'jobId' | 'origin' | 'listenerIncarnation'>,
  onGrant?: (grant: WriterGrant) => void,
): JobHostOptions {
  return {
    root: identity.root, stateDir: identity.stateDir, fingerprint: identity.fingerprint, reviewer: identity.reviewer,
    readerId: identity.readerId, readPublished, partsEnumeratorId: identity.partsEnumeratorId, partsEnumerator,
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
): Promise<JobOwnerHost> {
  root = realpathSync(root);
  const release = acquireJobLock(root)!;
  try {
    // A binding whose root is another directory was copied with the project (a clone or a
    // move). Its host state and port belong to that other root, so this open never reads that
    // state or connects to that port: it starts this root's own job and replaces the copy.
    const found = readWriterBinding(root);
    const existing = found && found.identity.root === root ? found : null;
    const identity = currentJobIdentity({ root, stateDir: existing?.identity.stateDir ?? join(jobHostStateRoot(root), 'host'), fingerprint: 'rig-create/live-review/1', reviewer }, root);
    if (existing) assertJobIdentity(existing.identity, identity);
    privateDirectory(identity.stateDir);
    let writerGrant: WriterGrant | undefined;
    const host = await startHost({
      ...options(identity, true, undefined, grant => { writerGrant = grant; }),
      ...(existing ? { port: Number(new URL(existing.origin).port) } : {}),
    });
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
  try { host = await startHost(options(requested, false, binding)); }
  catch (error) {
    if (isAttachRefused(error)) {
      refuse('JOB_HOST_ATTACH_REFUSED', `project.json: live host attach refused (reason=${error.reason}, phase=${error.phase}); reopen or restore the bound live host before rig-create job reconcile`);
    }
    if (isReuseMismatch(error)) {
      refuse('JOB_HOST_REUSE_MISMATCH', `project.json: ${error.field} expected=${JSON.stringify(error.expected)} found=${JSON.stringify(error.actual)}; restore the bound host configuration, then run rig-create job reconcile`);
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
): Promise<AskOutcome[]> {
  const host = await attachCreateJob(entry, requested, beforeAttach, startHost);
  try {
    const bytes = readFileSync(join(entry.root, 'project.json'));
    if (publicationVersionHash(bytes, entry.result) !== entry.versionHash) refuse('JOB_PUBLICATION_STALE', 'project.json: pending version changed; restore its retained entry/files before reconciling');
    const currentHash = jobHash(bytes);
    if (currentHash !== entry.recordHash) { entry.recordHash = currentHash; delete entry.generation; }
    const project = JSON.parse(bytes.toString('utf8'));
    if (!entry.result.selector) refuse('JOB_PUBLICATION_INVALID', 'project.json: a result selector is required for reconciliation');
    if (entry.result.selector.kind === 'draft') prepareDraftManifest(entry.root, project, entry.result.selector.id);
    else prepareLiveManifest(entry.root, project, entry.result.selector.version);
    // The subjects this record declares; ingest refuses an act for one it did not (REVIEW_ACT_SUBJECT_UNDECLARED).
    const { subjects } = await readPublished({ root: entry.root, record: { path: 'project.json', sha256: entry.recordHash }, result: entry.result });
    entry.generation ??= host.session.status().generation;
    entry.phase = 'pending';
    failPublication(entry.root, entry, entry.failure);
    // Draft readiness can change when producer bytes drift without a record write.
    // Keep retries on the stored generation, and give a fresh enqueue its own attempt.
    const attempt = jobHash(JSON.stringify(entry.result.selector.kind === 'draft'
      ? [entry.id, entry.recordHash, entry.generation]
      : [entry.id, entry.recordHash]));
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
    acknowledgePublication(entry, result.value.publicationId, result.value.generation, attempt, subjects);
    // The person answers on the page, so every declared subject is asked here, with the
    // agent authority this process already holds in memory. An ask Review refuses never
    // makes the acknowledged publication pending again; the caller names it afterwards.
    return await askDeclaredSubjects(host, result.value.publicationId, subjects);
  } finally { host.stop(); }
}

/** One declared subject after the ask step: asked now, asked before on this publication, or refused by Review. */
export type AskOutcome = { readonly subject: JobSubject; readonly status: 'asked' | 'already' } | { readonly subject: JobSubject; readonly status: 'refused'; readonly code: string };

type AgentReply = { ok?: boolean; error?: { code?: string }; value?: { events?: unknown; status?: unknown; cursor?: unknown } };

async function agentCall(host: JobOwnerHost, body: object): Promise<AgentReply> {
  const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
    method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: 'rig-review/job-api@2', jobId: host.session.jobId, requestId: randomUUID(), ...body }),
  }));
  return await response.json() as AgentReply;
}

/** The subjects already asked on this publication, from the job's own event log. */
async function askedSubjects(host: JobOwnerHost, publicationId: string): Promise<JobSubject[]> {
  const asked: JobSubject[] = [];
  let after: unknown = null;
  for (let page = 0; page < 10_000; page++) {
    const reply = await agentCall(host, { verb: 'next', after, waitMs: 0 });
    const events = reply.ok ? reply.value?.events : undefined;
    if (!Array.isArray(events)) break;
    for (const event of events as { type?: unknown; ask?: { publicationId?: unknown; subject?: JobSubject } }[]) {
      if (event?.type === 'pending' && event.ask?.publicationId === publicationId && event.ask.subject) asked.push(event.ask.subject);
    }
    if (reply.value?.status !== 'events' || reply.value.cursor === after) break;
    after = reply.value.cursor;
  }
  return asked;
}

/**
 * Ask each declared subject of a publication once. A subject already asked on that
 * publication, pending or answered, is not asked again, so a re-open never shows a second
 * control. Asks stay limited to the declared list (`REVIEW_ACT_SUBJECT_UNDECLARED`).
 */
export async function askDeclaredSubjects(host: JobOwnerHost, publicationId: string, subjects: readonly JobSubject[]): Promise<AskOutcome[]> {
  const before = await askedSubjects(host, publicationId);
  const outcomes: AskOutcome[] = [];
  for (const subject of subjects) {
    if (before.some(asked => isDeepStrictEqual(asked, subject))) { outcomes.push({ subject, status: 'already' }); continue; }
    const expectedGeneration = host.session.status().generation;
    let reply: AgentReply;
    try {
      reply = await agentCall(host, { verb: 'ask', expectedGeneration, publicationId, subject,
        idempotencyKey: jobHash(JSON.stringify([publicationId, subject, expectedGeneration])) });
    } catch { reply = { ok: false }; }
    outcomes.push(reply.ok ? { subject, status: 'asked' } : { subject, status: 'refused', code: reply.error?.code ?? 'JOB_ASK_INVALID' });
  }
  return outcomes;
}

export function subjectLabel(subject: JobSubject): string {
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
  const refused = outcomes.filter(outcome => outcome.status === 'refused');
  if (!refused.length) return;
  const named = refused.map(outcome => `${subjectLabel(outcome.subject)} (${outcome.status === 'refused' ? outcome.code : ''})`).join(', ');
  refuse('JOB_ASK_REFUSED', `project.json: the publication is acknowledged but review refused the ask for ${named}; restore the published record bytes and run rig-create job open to ask again`);
}

export async function reconcileCreateJob(root: string, publish: (entry: PendingPublication) => Promise<unknown> = publishPending): Promise<number> {
  const release = acquireJobLock(root)!;
  let outcomes: AskOutcome[];
  let count: number;
  try { ({ count, outcomes } = await reconcileLocked(root, publish)); }
  finally { release(); }
  refuseAskOutcomes(outcomes);
  return count;
}

/** Publish every pending entry under the caller's job lock. Ask outcomes are returned, not thrown. */
async function reconcileLocked(root: string, publish: (entry: PendingPublication) => Promise<unknown>): Promise<{ count: number; outcomes: AskOutcome[] }> {
  const outcomes: AskOutcome[] = [];
  const entries = pendingPublications(root, true);
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
      refuse('JOB_PUBLISH_PENDING', `project.json: record ${entry.recordHash} remains pending (${failure.code}: ${failure.message}); run rig-create job reconcile`);
    }
  }
  return { count: entries.length, outcomes };
}

/** The stages whose record consumes a draft: `job open` publishes the latest one there. */
const DRAFT_OPEN_STAGES = ['parts', 'parts-review'];

export function assertRequestedDraft(root: string, requested?: string): { bytes: Buffer; ids: string[] } {
  root = realpathSync(root);
  const bytes = readFileSync(join(root, 'project.json'));
  const project = JSON.parse(bytes.toString('utf8')) as { drafts?: unknown };
  const ids = (Array.isArray(project.drafts) ? project.drafts : []).map(draft => (draft as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string');
  if (requested !== undefined && !ids.includes(requested)) {
    refuse('JOB_DRAFT_UNKNOWN', `project.json.drafts: no recorded draft has id ${requested}; record it with rig-create draft-rig or name a recorded draft`);
  }
  return { bytes, ids };
}

function selectorResult(selector: JobSelector): PendingPublication['result'] {
  return selector.kind === 'draft'
    ? draftPublicationResult(selector.id)
    : { path: `review-live-v${selector.version}.json`, selector };
}

function selectorLabel(selector: JobSelector): string {
  return selector.kind === 'draft' ? `draft ${selector.id}` : `${selector.kind} v${selector.version}`;
}

/**
 * After `job open`: show or refresh the record's current publication on the owner's page.
 * The latest recorded draft (or `--draft <id>`), or the head's `rig` / `post` selector at
 * later stages, is published unless the job's head publication already covers that selector
 * over the current record bytes, and every subject the publication declares is asked once.
 * Returns the lines `job open` prints.
 */
export async function openDraftPublication(root: string, host: JobOwnerHost, now: number, requested?: string): Promise<string[]> {
  root = realpathSync(root);
  const { bytes, ids } = assertRequestedDraft(root, requested);
  const stage = checkProject(root, JSON.parse(bytes.toString('utf8')), { now, readOnly: true }).effective_stage;
  const draftId = requested ?? (DRAFT_OPEN_STAGES.includes(String(stage)) ? ids.at(-1) : undefined);
  const head = host.session.status().publication;
  const source = head?.source as { selector?: JobSelector; projectHash?: unknown } | undefined;
  const acknowledged = head ? readAcknowledgedPublication(root, host.session.jobId, head.publicationId) : null;
  const headSelector = acknowledged?.result.selector ?? source?.selector ?? null;
  const targetSelector: JobSelector | undefined = draftId !== undefined
    ? { kind: 'draft', id: draftId }
    : headSelector && headSelector.kind !== 'draft'
      ? headSelector
      : undefined;
  const warnings: Finding[] = [];
  const draftContext = targetSelector?.kind === 'draft'
    ? draftPublicationContext(root, JSON.parse(bytes.toString('utf8')), targetSelector.id, warnings)
    : undefined;
  const reuseHead = Boolean(head && headSelector && source?.projectHash === jobHash(bytes) && (
    targetSelector === undefined || isDeepStrictEqual(headSelector, targetSelector)
  ) && (draftContext === undefined || isDeepStrictEqual(acknowledged?.subjects, draftContext.subjects)));
  let selector: JobSelector;
  let outcomes: AskOutcome[];
  let published: boolean;
  if (reuseHead && head && headSelector) {
    const result = acknowledged?.result ?? selectorResult(headSelector);
    const subjects = acknowledged?.subjects
      ?? (await readPublished({ root, record: { path: 'project.json', sha256: jobHash(bytes) }, result })).subjects;
    outcomes = await askDeclaredSubjects(host, head.publicationId, subjects);
    selector = headSelector;
    published = false;
  } else {
    if (targetSelector === undefined) {
      return ids.length === 0 ? ['job: no recorded draft to publish'] : [`job: stage ${stage} shows no draft; name one with --draft <id>`];
    }
    const result = selectorResult(targetSelector);
    const release = acquireJobLock(root)!;
    try {
      const binding = readWriterBinding(root);
      if (!binding || binding.jobId !== host.session.jobId) refuse('JOB_BINDING_INVALID', 'project.json: the open job has no writer-owned binding; run rig-create job close, then rig-create job open');
      if (targetSelector.kind === 'draft') draftPublicationContext(root, JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')), targetSelector.id);
      enqueuePublication(root, binding, result);
      ({ outcomes } = await reconcileLocked(root, publishPending));
    } finally { release(); }
    selector = targetSelector;
    published = true;
  }
  const lines = [`job: ${selectorLabel(selector)} ${published ? 'published' : 'already published'}`, ...askOutcomeLines(outcomes),
    ...warnings.map(finding => `WARN ${finding.code}: ${finding.message}`)];
  refuseAskOutcomes(outcomes);
  return lines;
}

export { closeCreateJob } from './job-close.ts';
