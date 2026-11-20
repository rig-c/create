import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { startJobHost, type JobHostAttachFailure, type JobHostOptions, type JobHostReuseBinding, type JobOwnerHost, type JobReviewerBinding, type JobSelector } from '@rig-c/review/job-host';
import { asArray, checkProject, collectItems, loadCollection, isObject, type Finding } from './check.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { assembleOnlyDraftTarget, assembleOnlyVersionFinding, assertDraftHasRig, readAssembleOnlyDraftTarget } from './draft-layout.ts';
import { Refusal, refuse } from './refusal.ts';
import { liveManifestPath, draftPublicationContext, inspectDraftPublication, currentJobIdentity, partsEnumerator, prepareDraftManifest, prepareLiveManifest, publicationFile, publicationSelector, readPublished, readRecordPublished } from './job-publication.ts';
import { acknowledgePublication, acquireJobLock, assertJobIdentity, enqueuePublication, ensureJobPrivateIgnores, failPublication, JOB_BINDING_FILE, jobHash, jobHostStateRoot, pendingPublications, privateDirectory, publicationVersionHash, readAcknowledgedPublication, readWriterBinding, reconcilePublication, writePrivateJson, isRecordResult, type PublicationResult, type JobIdentity, type PendingPublication, type WriterBinding, type PublicationSubject } from './job-outbox.ts';
import { draftPublicationResult } from './job-writer.ts';
import { attachCreateJobForClose } from './job-close.ts';
import { agentCall, jobEvents, pendingJobActs, readHostActs, shellWord, type AgentReply, type PendingJobAct } from './job-acts.ts';
import { checkReviewPackages } from './review-package.ts';
import { reviewVerdictSignable } from './signable.ts';
import type { JsonObject } from './templates.ts';
import { recoverReplacedJobHostState, replacedRootRefusal } from './job-host-state.ts';
import { requireOwnerLanguage } from './owner-language.ts';

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
    ...(identity.publicationMode ? { publicationMode: identity.publicationMode, readRecordPublished } : {}),
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
    const identity = currentJobIdentity({ root, stateDir: existing?.identity.stateDir ?? join(jobHostStateRoot(root), 'host'), fingerprint: 'rig-create/live-review/1', reviewer, ...(existing?.identity.publicationMode || recordMode ? { publicationMode: 'record-and-package' as const } : {}) }, root);
    if (recordMode && existing && !existing.identity.publicationMode) refuse('JOB_HOST_REUSE_MISMATCH', 'project.json: this job uses a package-only host; close it with job close and reopen with --question or --plan');
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
  onPublished?: (publication: { publicationId: string; replaced: boolean }) => void,
): Promise<AskOutcome[]> {
  const host = await attachCreateJob(entry, requested, beforeAttach, startHost);
  try {
    const bytes = readFileSync(join(entry.root, 'project.json'));
    if (publicationVersionHash(bytes, entry.result) !== entry.versionHash) refuse('JOB_PUBLICATION_STALE', 'project.json: pending version changed; restore its retained entry/files before reconciling');
    const currentHash = jobHash(bytes);
    if (currentHash !== entry.recordHash) { entry.recordHash = currentHash; delete entry.generation; }
    const project = JSON.parse(bytes.toString('utf8'));
    let subjects: readonly PublicationSubject[];
    if (isRecordResult(entry.result)) {
      subjects = readRecordPublished({ root: entry.root, record: { path: 'project.json', sha256: entry.recordHash }, result: entry.result, phase: 'inventory' }).subjects;
    } else {
      if (!entry.result.selector) refuse('JOB_PUBLICATION_INVALID', 'project.json: a result selector is required for reconciliation');
      if (entry.result.selector?.kind === 'draft') prepareDraftManifest(entry.root, project, entry.result.selector.id);
      else prepareLiveManifest(entry.root, project, entry.result.selector.version);
      subjects = (await readPublished({ root: entry.root, record: { path: 'project.json', sha256: entry.recordHash }, result: entry.result })).subjects;
    }
    const status = host.session.status();
    entry.generation ??= status.generation;
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
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${entry.jobId}/api`, {
      method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }));
    const result = await response.json() as { schema: string; ok: boolean; error?: { code: string; message?: string }; value?: { publicationId: string; generation: number } };
    if (result.schema !== request.schema || !result.ok) {
      const code = result.error?.code ?? 'JOB_PUBLICATION_INVALID';
      const reason = typeof result.error?.message === 'string' && result.error.message.trim() ? `: ${result.error.message}` : '';
      refuse(code, `project.json: publication of record ${entry.recordHash} was refused by review (${code})${reason}; run rig-create job reconcile after restoring the bound sources`);
    }
    if (!result.value) refuse('JOB_OUTBOX_INVALID', 'project.json: publication response lacks its identity; reconcile the pending publication');
    acknowledgePublication(entry, result.value.publicationId, result.value.generation, attempt, subjects);
    onPublished?.({ publicationId: result.value.publicationId, replaced: Boolean(status.publication && status.publication.publicationId !== result.value.publicationId) });
    // The person answers on the page, so every declared subject is asked here, with the
    // agent authority this process already holds in memory. An ask Review refuses never
    // makes the acknowledged publication pending again; the caller names it afterwards.
    return await askDeclaredSubjects(host, result.value.publicationId, subjects, isRecordResult(entry.result));
  } finally { host.stop(); }
}

/** One declared subject after the ask step: asked now, asked before on this publication, or refused by Review. */
export type AskOutcome = { readonly subject: PublicationSubject; readonly status: 'asked' | 'already' } | { readonly subject: PublicationSubject; readonly status: 'refused'; readonly code: string };

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
): Promise<{ jobId: string; acts: PendingJobAct[] }> {
  try { root = realpathSync(root); }
  catch { refuse('JOB_HOST_ATTACH_REFUSED', 'project.json: project has no bound live host; open it with job open before job acts'); }
  const binding = readWriterBinding(root);
  if (!binding) refuse('JOB_HOST_ATTACH_REFUSED', 'project.json: no bound live host; open it with job open before job acts');
  const host = await attachCreateJobForClose(root, binding, startHost);
  try {
    const project: JsonObject = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
    return { jobId: binding.jobId, acts: pendingJobActs(project, await readHostActs(host), root) };
  } finally { host.stop(); }
}

const ASK_BATCH_LIMIT = 64;

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
      outcomes.push(reply.ok ? { subject, status: 'asked' } : { subject, status: 'refused', code: reply.error?.code ?? 'JOB_ASK_INVALID' });
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
    const match = typeof reply.error?.message === 'string' ? /^subjects\[(\d+)\]: /.exec(reply.error.message) : null;
    const failedIndex = match ? Number(match[1]) : -1;
    if (failedIndex >= 0 && failedIndex < chunk.length) {
      outcomes[chunk[failedIndex]!.index] = { subject: chunk[failedIndex]!.subject, status: 'refused', code };
    } else {
      for (const item of chunk) outcomes[item.index] = { subject: item.subject, status: 'refused', code };
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
  const refused = outcomes.filter(outcome => outcome.status === 'refused');
  if (!refused.length) return;
  const named = refused.map(outcome => `${subjectLabel(outcome.subject)} (${outcome.status === 'refused' ? outcome.code : ''})`).join(', ');
  refuse('JOB_ASK_REFUSED', `project.json: the publication is acknowledged but review refused the ask for ${named}; restore the published record bytes and run rig-create job open to ask again`);
}

export async function reconcileCreateJob(root: string, publish: (entry: PendingPublication) => Promise<unknown> = publishPending, now?: number): Promise<number> {
  root = realpathSync(root);
  const release = acquireJobLock(root)!;
  let outcomes: AskOutcome[];
  let count: number;
  try {
    const binding = readWriterBinding(root);
    if (!binding || binding.identity.stateDir === join(jobHostStateRoot(root), 'host')) await recoverReplacedJobHostState(root, now);
    ({ count, outcomes } = await reconcileLocked(root, publish));
  }
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
      refuse('JOB_PUBLISH_PENDING', `project.json: record ${entry.recordHash} remains pending (${failure.code}: ${failure.message}); run rig-create job reconcile after restoring the sources, or job close --retire-refused to archive failed publications and close without publishing them`);
    }
  }
  return { count: entries.length, outcomes };
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
  const project = JSON.parse(readFileSync(join(realpathSync(root), 'project.json'), 'utf8')) as JsonObject;
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
    dir: realpathSync(root),
    // Explicit publication requires package integrity even for a pre-interview rig.
    project: { ...project, versions: asArray(project.versions).map(version => version === rigVersion ? { ...rigVersion, pre_interview: false } : version) },
    refusals: [] as Finding[], warnings: [] as Finding[],
  };
  checkReviewPackages(context);
  const failure = context.refusals[0];
  if (failure) refuse(failure.code, `${failure.message}; restore the frozen review package before job open`);
  return selector;
}

function selectorResult(root: string, selector: JobSelector): PendingPublication['result'] {
  return selector.kind === 'draft'
    ? draftPublicationResult(selector.id)
    : { path: liveManifestPath(root, JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')), selector.version), selector };
}

function selectorLabel(selector: JobSelector): string {
  return selector.kind === 'draft' ? `draft ${selector.id}` : `${selector.kind} v${selector.version}`;
}

/** Resolve only an explicitly requested current record subject, before opening a host. */
export function requestedRecordResult(root: string, question?: string, plan = false, now = Date.now()): PublicationResult | undefined {
  return requestedRecordPublication(root, question, plan, now)?.result;
}

function requestedRecordPublication(root: string, question: string | undefined, plan: boolean, now: number): {
  result: RecordPublicationRequestResult;
  recordHash: string;
  subjects: readonly PublicationSubject[];
} | undefined {
  if (question === undefined && !plan) return undefined;
  if (question !== undefined && plan) refuse('JOB_BINDING_INVALID', 'project.json: choose --question or --plan, not both');
  const bytes = readFileSync(join(root, 'project.json'));
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  requireOwnerLanguage(project);
  let result: RecordPublicationRequestResult = { kind: 'plan' };
  if (question !== undefined) {
    const items = collectItems(project, { collection: loadCollection(root, project) }).filter(item => item.id === question);
    const binding = items.length === 1 ? items[0]!.record.pending_options : undefined;
    if (!isObject(binding) || typeof binding.path !== 'string') refuse('JOB_RECORD_SUBJECT_INVALID', `project.json: requested question has no unique pending option set; register it with rig-create interview-options ${question} '${root.replaceAll("'", "'\\''")}' --file '<option-set.json>' first (draft a new option set to re-ask an answered question)`);
    const set = JSON.parse(publicationFile(root, binding.path).toString('utf8')) as JsonObject;
    if (typeof set.id !== 'string') refuse('JOB_RECORD_SUBJECT_INVALID', 'project.json: pending option set has no id; restore its original identity');
    result = { kind: 'option-set', questionId: question, setId: set.id };
  }
  const recordHash = jobHash(bytes);
  const { subjects } = readRecordPublished({ root, record: { path: 'project.json', sha256: recordHash }, result, phase: 'inventory' }, now);
  return { result, recordHash, subjects };
}
type RecordPublicationRequestResult = Parameters<typeof readRecordPublished>[0]['result'];

export async function openRecordPublication(root: string, host: JobOwnerHost, question: string | undefined, plan: boolean, now: number): Promise<string[]> {
  const release = acquireJobLock(root)!;
  let outcomes: AskOutcome[];
  let reused = false;
  let result: RecordPublicationRequestResult;
  try {
    const publication = requestedRecordPublication(root, question, plan, now);
    if (!publication) refuse('JOB_PUBLICATION_INVALID', 'project.json: expected an explicit record subject; choose --question or --plan');
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
      enqueuePublication(root, binding, result);
      ({ outcomes } = await reconcileLocked(root, publishPending));
    }
  } finally { release(); }
  const label = result.kind === 'plan' ? 'plan' : `option-set ${result.questionId}/${result.setId}`;
  refuseAskOutcomes(outcomes);
  return [`job: ${label} ${reused ? 'already published' : 'published'}`, ...askOutcomeLines(outcomes)];
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
  const source = head?.source as { selector?: JobSelector; projectHash?: unknown } | undefined;
  const acknowledged = head ? readAcknowledgedPublication(root, host.session.jobId, head.publicationId) : null;
  const headSelector = acknowledged?.result.selector ?? source?.selector ?? null;
  const targetSelector: JobSelector | undefined = rigSelector ?? (draftId !== undefined
    ? { kind: 'draft', id: draftId }
    : headSelector && headSelector.kind !== 'draft'
      ? headSelector
      : undefined);
  const warnings: Finding[] = [];
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  const draftContext = targetSelector?.kind === 'draft'
    ? draftPublicationContext(root, project, targetSelector.id, warnings)
    : undefined;
  // Re-publish an older post head that still declares a sign-off or checkpoint:
  // either pending ask would prevent the legacy direction panel from rendering.
  const currentSubjects = draftContext?.subjects ?? (targetSelector?.kind === 'post'
    ? (reviewVerdictSignable(project, targetSelector.version, 'direction-review')
      ? [{ kind: 'review-verdict' as const, stage: 'direction-review' as const }]
      : [])
    : undefined);
  const reuseHead = Boolean(head && headSelector && source?.projectHash === jobHash(bytes) && (
    targetSelector === undefined || isDeepStrictEqual(headSelector, targetSelector)
  ) && (currentSubjects === undefined || isDeepStrictEqual(acknowledged?.subjects, currentSubjects)));
  let selector: JobSelector;
  let outcomes: AskOutcome[];
  let published: boolean;
  if (reuseHead && head && headSelector) {
    const result = acknowledged?.result ?? selectorResult(root, headSelector);
    const subjects = acknowledged?.subjects
      ?? (await readPublished({ root, record: { path: 'project.json', sha256: jobHash(bytes) }, result: result as Parameters<typeof readPublished>[0]['result'] })).subjects;
    outcomes = await askDeclaredSubjects(host, head.publicationId, subjects, false);
    selector = headSelector;
    published = false;
  } else {
    if (targetSelector === undefined) {
      return ids.length === 0 ? ['job: no recorded draft to publish'] : [`job: stage ${stage} shows no draft; name one with --draft <id>`];
    }
    const result = selectorResult(root, targetSelector);
    const release = acquireJobLock(root)!;
    try {
      const binding = readWriterBinding(root);
      if (!binding || binding.jobId !== host.session.jobId) refuse('JOB_BINDING_INVALID', 'project.json: the open job has no writer-owned binding; run rig-create job close, then rig-create job open');
      const current = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
      requireOwnerLanguage(current);
      if (targetSelector.kind === 'draft') draftPublicationContext(root, current, targetSelector.id);
      if (rigSelector) prepareLiveManifest(root, current, rigSelector.version, warnings);
      enqueuePublication(root, binding, result);
      ({ outcomes } = await reconcileLocked(root, publishPending));
    } finally { release(); }
    selector = targetSelector;
    published = true;
  }
  const lines = [...warnings.map(finding => `WARN ${finding.code}: ${finding.message}`),
    `job: ${selectorLabel(selector)} ${published ? 'published' : 'already published'}`, ...askOutcomeLines(outcomes)];
  refuseAskOutcomes(outcomes);
  return lines;
}

export { closeCreateJob } from './job-close.ts';
