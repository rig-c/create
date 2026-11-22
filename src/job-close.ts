import { OWNER_CHAT_USAGE, readOwnerChat } from './owner-chat.ts';
import { readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  startJobHost,
  type JobHostAttachFailure,
  type JobHostOptions,
  type JobHostReuseBinding,
  type JobOwnerHost,
  type JobPublicationReader,
  type JobSelector,
} from '@rig-c/review/job-host';
import { asArray, checkProject } from './check.ts';
import { pendingActRemedy, pendingJobActs, pendingJobAsksForTarget, readHostActs, readHostActsAndAsks, shellWord, type JobAskTarget } from './job-acts.ts';
import {
  acquireJobLock,
  JOB_BINDING_FILE,
  pendingPublications,
  retireRefusedPublications,
  readWriterBinding,
  type JobIdentity,
  type WriterBinding,
} from './job-outbox.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { appendWithdrawalReceipt, buildDiscardActReceipt, reviewActFindings } from './review-act.ts';
import type { JsonObject } from './templates.ts';

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

function closeReuseBinding(identity: JobIdentity): JobHostReuseBinding {
  return {
    root: identity.root,
    stateDir: identity.stateDir,
    fingerprint: identity.fingerprint,
    reviewer: { id: identity.reviewer.id, role: identity.reviewer.role },
    readerId: identity.readerId,
    bindingId: identity.bindingId,
    partsEnumeratorId: identity.partsEnumeratorId,
    partsEnumeratorVersion: identity.enumeratorVersion,
    apiSchema: identity.apiSchema as JobHostReuseBinding['apiSchema'],
    actSchema: identity.actSchema as JobHostReuseBinding['actSchema'],
  };
}

export const failClosedCloseReadPublished: JobPublicationReader = async () => {
  refuse('JOB_HOST_REUSE_MISMATCH', 'project.json: close attach must not invoke readPublished; reopen the live job at the current pin before publishing');
};

export function failClosedCloseEnumerate(): never {
  refuse('JOB_HOST_REUSE_MISMATCH', 'project.json: close attach must not invoke partsEnumerator.enumerate; reopen the live job at the current pin before publishing');
}

export async function failClosedCloseInstallBinding(): Promise<never> {
  refuse('JOB_HOST_REUSE_MISMATCH', 'project.json: close attach must not install a writer binding');
}

export function closeHostOptions(binding: WriterBinding): JobHostOptions {
  const { identity } = binding;
  return {
    root: identity.root,
    stateDir: identity.stateDir,
    fingerprint: identity.fingerprint,
    reviewer: { id: identity.reviewer.id, role: identity.reviewer.role },
    readerId: identity.readerId,
    readPublished: failClosedCloseReadPublished,
    ...(identity.publicationMode ? { publicationMode: identity.publicationMode, readRecordPublished: () => refuse('JOB_HOST_REUSE_MISMATCH', 'project.json: close attach must not invoke the record reader; reopen the live job before publishing') } : {}),
    partsEnumeratorId: identity.partsEnumeratorId,
    partsEnumerator: {
      version: identity.enumeratorVersion,
      enumerate: failClosedCloseEnumerate,
    },
    bindingId: identity.bindingId,
    installWriterBinding: failClosedCloseInstallBinding,
    reuseOnly: {
      expected: {
        jobId: binding.jobId,
        origin: binding.origin,
        listenerIncarnation: binding.listenerIncarnation,
        binding: closeReuseBinding(identity),
      },
    },
  };
}

function assertStoredCloseBinding(root: string, binding: WriterBinding): void {
  const identity = binding.identity as Partial<JobIdentity> | null | undefined;
  if (
    typeof identity !== 'object' || identity === null
    || typeof identity.root !== 'string'
    || typeof identity.stateDir !== 'string'
    || typeof identity.fingerprint !== 'string'
    || typeof identity.reviewer !== 'object' || identity.reviewer === null
    || typeof identity.reviewer.id !== 'string'
    || (identity.reviewer.role !== 'owner' && identity.reviewer.role !== 'delegate')
    || typeof identity.readerId !== 'string'
    || typeof identity.bindingId !== 'string'
    || typeof identity.partsEnumeratorId !== 'string'
    || typeof identity.apiSchema !== 'string'
    || typeof identity.actSchema !== 'string'
    || typeof identity.enumeratorVersion !== 'string'
  ) {
    refuse('JOB_BINDING_INVALID', 'project.json: malformed private live-job binding; reopen the job through rig-create job open');
  }
  if (identity.root !== root) {
    refuse('JOB_HOST_REUSE_MISMATCH', `project.json: root expected=${JSON.stringify(identity.root)} found=${JSON.stringify(root)}; restore the bound host configuration, then run rig-create job close`);
  }
  let project: { review_job?: unknown };
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw Error();
    project = parsed as { review_job?: unknown };
  } catch {
    refuse('PROJECT_JSON_INVALID', 'project.json: project record is not a JSON object');
  }
  if (project.review_job !== undefined) {
    if (
      typeof project.review_job !== 'object' || project.review_job === null || Array.isArray(project.review_job)
      || typeof (project.review_job as { jobId?: unknown }).jobId !== 'string'
      || typeof (project.review_job as { origin?: unknown }).origin !== 'string'
    ) {
      refuse('JOB_BINDING_INVALID', 'project.json: malformed review_job locator; reopen the job through rig-create job open');
    }
    const locator = project.review_job as { jobId: string; origin: string };
    if (locator.jobId !== binding.jobId) {
      refuse('JOB_HOST_REUSE_MISMATCH', `project.json: jobId expected=${JSON.stringify(locator.jobId)} found=${JSON.stringify(binding.jobId)}; restore the bound host configuration, then run rig-create job close`);
    }
    if (locator.origin !== binding.origin) {
      refuse('JOB_HOST_REUSE_MISMATCH', `project.json: origin expected=${JSON.stringify(locator.origin)} found=${JSON.stringify(binding.origin)}; restore the bound host configuration, then run rig-create job close`);
    }
  }
  if (!binding.listenerIncarnation) {
    refuse('JOB_HOST_REUSE_MISMATCH', 'project.json: listenerIncarnation expected=a bound listener found=absent in the private binding; reopen the live job through rig-create job open, then run rig-create job close');
  }
}

/**
 * Close-only attachment boundary: uses the stored private binding's hook IDs and
 * `enumeratorVersion` so a live host opened before a pin bump or reader ID bump can
 * still be retired without weakening normal publication/reconcile/attach checks.
 */
export async function attachCreateJobForClose(
  root: string,
  binding: WriterBinding,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
): Promise<JobOwnerHost> {
  assertStoredCloseBinding(root, binding);
  let host: JobOwnerHost;
  try {
    host = await startHost(closeHostOptions(binding));
  } catch (error) {
    if (isAttachRefused(error)) {
      // Close reads the finalized owner acts and retires the job through the live host only:
      // a stopped host's acts are never read from the record, so restarting it is the remedy.
      const reopen = `rig-create job open ${shellWord(root)} --reviewer ${shellWord(binding.identity.reviewer.id)} --role ${binding.identity.reviewer.role}`;
      refuse('JOB_HOST_ATTACH_REFUSED', `project.json: live host attach refused (reason=${error.reason}, phase=${error.phase}); job close reads the job's finalized owner acts from the bound live host, so restart it with ${reopen} and retry rig-create job close, which waits out the restarted host's publication freeze`);
    }
    if (isReuseMismatch(error)) {
      refuse('JOB_HOST_REUSE_MISMATCH', `project.json: ${error.field} expected=${JSON.stringify(error.expected)} found=${JSON.stringify(error.actual)}; restore the bound host configuration, then run rig-create job close`);
    }
    if (error instanceof Error) {
      const code = (error as Error & { code?: string }).code;
      if (code === 'JOB_HOST_REUSE_MISMATCH') {
        refuse('JOB_HOST_REUSE_MISMATCH', `project.json: ${error.message}; restore the bound host options before rig-create job close`);
      }
      if (code && ['JOB_REQUEST_INVALID', 'JOB_AUTHORITY_REFUSED', 'JOB_PARTS_ENUMERATOR_UNSUPPORTED', 'JOB_SOURCE_UNRETAINABLE'].includes(code)) {
        refuse('JOB_BINDING_INVALID', `project.json: malformed private live-job binding (${code}); reopen the job through rig-create job open`);
      }
    }
    throw error;
  }
  if (!host.reused || host.session.jobId !== binding.jobId || host.origin !== binding.origin) {
    host.stop();
    refuse('JOB_HOST_REUSE_MISMATCH', `project.json: host incarnation expected=${binding.jobId}@${binding.origin} found=${host.session.jobId}@${host.origin} reused=${host.reused}; restore the original live host before rig-create job close`);
  }
  return host;
}

export async function assertNoPendingJobAsk(
  root: string,
  target: JobAskTarget,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
): Promise<string | null> {
  root = realpathSync(root);
  const binding = readWriterBinding(root);
  if (!binding || binding.identity.root !== root) return null;
  let host: JobOwnerHost;
  try {
    host = await attachCreateJobForClose(root, binding, startHost);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'JOB_HOST_ATTACH_REFUSED' || error.code === 'JOB_HOST_REUSE_MISMATCH')) {
      return null;
    }
    throw error;
  }
  try {
    return await refusePendingJobAsks(root, binding.jobId, host, target);
  } finally {
    host.stop();
  }
}

/**
 * Publishing supersedes every pending ask on the job, and an answer to a superseded ask
 * never becomes an act. Refuse JOB_ASK_PENDING while an ask for another target is still
 * open, or answered but not ingested. A record-only write checks every actionable ask
 * so the owner can still answer against the displayed record. Returns the job's head publication.
 */
export async function refusePendingJobAsks(root: string, jobId: string, host: JobOwnerHost, target: JobAskTarget): Promise<string | null> {
  const bytes = readFileSync(join(root, 'project.json'));
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  const { head, asks, acts } = await readHostActsAndAsks(host);
  const pending = pendingJobAsksForTarget(project, asks, acts, root, target, bytes);
  if (pending.length > 0) {
    const listed = pending.map(item => item.label).join('; ');
    const version = pending.find(item => item.version !== null)?.version ?? null;
    const wait = `rig-create job acts ${shellWord(root)} --wait`;
    const ingest = version === null || pending.some(item => item.version === null)
      ? `have the owner respond in Review, run ${wait}, and run the printed ingest commands`
      : `have the owner give the verdict in Review, run ${wait}, and ingest with rig-create review ${version} --from-review <actId> (review <n> --from-review <actId>)`;
    const retry = target.kind === 'record-only' ? 're-run this command' : 're-run this command to publish into the existing job';
    let remedy = `${ingest}; ${retry}`;
    const staleActIds = new Set(pending.flatMap(item => item.staleInterviewActId === undefined ? [] : [item.staleInterviewActId]));
    const [staleActId] = staleActIds;
    if (staleActId !== undefined) {
      const binding = staleActIds.size === 1 ? readWriterBinding(root) : null;
      const canWithdraw = binding?.jobId === jobId && binding.identity.root === root
        && binding.origin === host.origin && host.session.status().status === 'active';
      const discard = canWithdraw
        ? `relay the owner's authorization with rig-create job withdraw-act ${shellWord(staleActId)} ${shellWord(root)} ${OWNER_CHAT_USAGE}`
        : 'use job close --discard-acts <reason> --by agent to record the stale acts';
      remedy = `run rig-create job acts ${shellWord(root)} to inspect the finalized acts. After ingesting any current acts, ${discard}, then open the remaining sets on the current record`;
      if (target.kind === 'record-only') remedy += '; re-run this command once the remaining asks are settled';
    } else if (target.kind === 'record-only' && target.writer === 'interview' && pending.some(item => item.interview)) {
      remedy += '. For an interview ask, to keep the page, have the owner submit in Review if they have not already,'
        + ' then run job acts --wait and interview-answer <question> --from-review <actId>,'
        + " or, to record chat words, ingest finalized acts, run job close with the owner's authorization, then retry with --owner-chat.";
    }
    refuse('JOB_ASK_PENDING', `project.json: bound job ${jobId} holds pending owner ask(s) ${listed} with no ingested act; ${remedy}`);
  }
  return head;
}

function appendDiscardedJobActs(
  root: string,
  project: JsonObject,
  receipts: readonly JsonObject[],
  now: number,
): JsonObject {
  const next: JsonObject = {
    ...project,
    review_acts: [
      ...asArray(project.review_acts),
      ...receipts,
    ],
  };
  const failure = [
    ...reviewActFindings(next),
    ...newFindings(
      baselineOf(checkProject(root, project, { now, readOnly: true })),
      checkProject(root, next, { now, readOnly: true }).refusals,
    ),
  ];
  if (failure[0]) refuse(failure[0].code, failure[0].message);
  return next;
}

function assertUnchangedBindingAndRecord(
  root: string,
  file: string,
  binding: WriterBinding,
  original: Buffer,
  verb: 'close' | 'withdraw-act',
  checkRecord = true,
): void {
  const current = readWriterBinding(root);
  if (!current || !isDeepStrictEqual(current, binding)) {
    refuse('JOB_BINDING_INVALID', `project.json: private live-job binding changed during ${verb}; restore the writer-owned binding`);
  }
  if (checkRecord && !readFileSync(file).equals(original)) {
    refuse('JOB_BINDING_INVALID', `project.json: record changed during ${verb}; retry against the current record`);
  }
}

/** How long `job close` waits for another process's job write lock (a restarted host's publication freeze) before refusing. */
export const CLOSE_LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 100;

/** The pid in the live lock owner's token, or null when the lock is absent or not a single owner token. */
function jobLockHolder(root: string): number | null {
  try {
    const owners = readdirSync(join(root, '.rig-create-job-write.lock'));
    return owners.length === 1 && /^\d+-[a-f0-9-]{36}$/.test(owners[0]!) ? Number(owners[0]!.split('-')[0]) : null;
  } catch { return null; }
}

/**
 * Take the job write lock, waiting up to `waitMs` while another live process holds it.
 * A refusal names the holding pid and what clears it; nothing is written before the lock.
 */
async function acquireJobLockWaiting(root: string, waitMs: number, verb: 'close' | 'withdraw-act', onWait?: (holder: number | null) => void): Promise<() => void> {
  const deadline = Date.now() + Math.max(0, waitMs);
  let waited = false;
  for (;;) {
    const release = acquireJobLock(root, false);
    if (release) return release;
    const holder = jobLockHolder(root);
    if (Date.now() >= deadline) {
      const who = holder === null ? 'another rig-create process' : `live process ${holder}`;
      const after = waitMs > 0 ? `; job ${verb} waited ${Math.ceil(waitMs / 1000)} s` : '';
      refuse('JOB_WRITE_BUSY', `project.json: the job write lock .rig-create-job-write.lock is held by ${who} (a bound writer, job reconcile, or a job open host publishing into the job)${after}; it clears when that process finishes its publication, so retry rig-create job ${verb} then`);
    }
    if (!waited) { onWait?.(holder); waited = true; }
    await Bun.sleep(LOCK_POLL_MS);
  }
}

async function withBoundJobRecord(
  root: string,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost>,
  verb: 'close' | 'withdraw-act',
  edit: (context: {
    root: string;
    file: string;
    host: JobOwnerHost;
    binding: WriterBinding;
    project: JsonObject;
    original: Buffer;
  }) => Promise<{ next?: JsonObject | string; afterWrite?: () => void }>,
  beforeAttach?: (root: string) => void,
  lockWaitMs = 0,
): Promise<void> {
  root = realpathSync(root);
  const release = await acquireJobLockWaiting(root, lockWaitMs, verb, holder => {
    process.stderr.write(`job: waiting up to ${Math.ceil(lockWaitMs / 1000)} s for ${holder === null ? 'another rig-create process' : `process ${holder}`} to release the job write lock\n`);
  });
  try {
    beforeAttach?.(root);
    const binding = readWriterBinding(root);
    if (!binding) refuse('JOB_BINDING_INVALID', 'project.json: no writer-owned job binding; open the live job first');
    const host = await attachCreateJobForClose(root, binding, startHost);
    const file = join(root, 'project.json');
    const temporary = join(root, '.rig-create-job-record.tmp');
    try {
      try {
        host.session.authorize('consumer', `Bearer ${binding.fetchCapability}`);
      } catch {
        refuse('JOB_BINDING_INVALID', `project.json: writer binding fetchCapability is not authorized for the bound live job; restore the writer-owned binding before rig-create job ${verb}`);
      }
      const original = readFileSync(file);
      const project = JSON.parse(original.toString('utf8')) as JsonObject;
      const { next, afterWrite } = await edit({ root, file, host, binding, project, original });
      assertUnchangedBindingAndRecord(root, file, binding, original, verb, next !== undefined);
      if (next !== undefined) {
        writeFileSync(temporary, typeof next === 'string' ? next : `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
        renameSync(temporary, file);
      }
      afterWrite?.();
    } finally {
      rmSync(temporary, { force: true });
      host.stop();
    }
  } finally {
    release();
  }
}

export async function withdrawCreateJobAct(
  root: string,
  actId: string,
  options: Record<string, string>,
  now = Date.now(),
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
): Promise<void> {
  const trimmedActId = actId.trim();
  if (!trimmedActId) {
    refuse('JOB_BINDING_INVALID', `project.json.review_acts: job withdraw-act requires <actId> and ${OWNER_CHAT_USAGE}`, USAGE_EXIT);
  }
  const by = options['--by']?.trim() ?? '';
  const chat = readOwnerChat(options, by, now, 'project.json.review_acts');
  if (!chat) {
    refuse('OWNER_CHAT_INVALID', `project.json.review_acts: job withdraw-act requires the owner’s words with ${OWNER_CHAT_USAGE}`, USAGE_EXIT);
  }
  const evidence: JsonObject = { by, at: new Date(now).toISOString(), ...chat };
  await withBoundJobRecord(root, startHost, 'withdraw-act', async ({ root, host, binding, project, original }) => {
    const recordedActs = asArray(project.review_acts);
    const recordedIndex = recordedActs.findIndex(entry =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      && (entry as JsonObject).jobId === binding.jobId && (entry as JsonObject).actId === trimmedActId);
    if (recordedIndex !== -1) {
      const entry = recordedActs[recordedIndex] as JsonObject;
      if (entry.kind === 'discarded') {
        refuse('REVIEW_ACT_DISCARDED', `project.json.review_acts[${recordedIndex}]: Review act ${trimmedActId} was already withdrawn or discarded`);
      }
      refuse('REVIEW_ACT_REPLAY_CONFLICT', `project.json.review_acts[${recordedIndex}]: Review act ${trimmedActId} is already ingested and cannot be withdrawn`);
    }
    if (asArray(project.signoffs).some(row => typeof row === 'object' && row !== null && !Array.isArray(row) && (row as JsonObject).source === `review act ${binding.jobId}/${trimmedActId}`)) {
      refuse('REVIEW_ACT_REPLAY_CONFLICT', `project.json.signoffs: Review act ${trimmedActId} is already ingested and cannot be withdrawn`);
    }
    const acts = pendingJobActs(project, await readHostActs(host), root);
    if (!acts.some(act => act.actId === trimmedActId)) {
      const prefixMatches = acts.filter(act => act.actId.startsWith(trimmedActId)).map(act => act.actId);
      if (prefixMatches.length === 1) {
        refuse('JOB_ACT_NOT_PENDING', `project.json.review_acts: act ${trimmedActId} is a prefix of pending act ${prefixMatches[0]} on bound job ${binding.jobId}; pass the full act id ${prefixMatches[0]} to rig-create job withdraw-act`);
      }
      if (prefixMatches.length > 1) {
        refuse('JOB_ACT_NOT_PENDING', `project.json.review_acts: act ${trimmedActId} matches multiple pending acts (${prefixMatches.join(', ')}) on bound job ${binding.jobId}; pass the full act id from rig-create job acts to rig-create job withdraw-act`);
      }
      refuse('JOB_ACT_NOT_PENDING', `project.json.review_acts: act ${trimmedActId} is not pending on bound job ${binding.jobId}; run rig-create job acts to list pending finalized acts`);
    }
    if (project.review_acts !== undefined && !Array.isArray(project.review_acts)) {
      refuse('REVIEW_ACT_LEDGER_INVALID', 'project.json.review_acts: expected a replay ledger array; restore the original act receipts before withdrawing an act');
    }
    const receipt = buildDiscardActReceipt(binding.jobId, trimmedActId, evidence);
    appendDiscardedJobActs(root, project, [receipt], now);
    return { next: appendWithdrawalReceipt(original, receipt) };
  });
}

export async function closeCreateJob(
  root: string,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
  retireRefused = false,
  discardActs?: Record<string, string>,
  now = Date.now(),
  lockWaitMs = CLOSE_LOCK_WAIT_MS,
): Promise<void> {
  let discardEvidence: JsonObject | undefined;
  if (discardActs) {
    const by = discardActs['--by']?.trim() ?? '';
    const reason = discardActs['--discard-acts']?.trim();
    const chat = readOwnerChat(discardActs, by, now, 'project.json.review_acts');
    if (!chat && (by !== 'agent' || !reason)) {
      refuse('JOB_BINDING_INVALID', 'project.json.review_acts: use --discard-acts <reason> --by agent or relay the owner’s words with --by <owner> --owner-chat --said-at --relayed-by', USAGE_EXIT);
    }
    discardEvidence = { by, at: new Date(now).toISOString(), ...chat, ...(reason ? { reason } : {}) };
  }
  let pending: ReturnType<typeof pendingPublications> = [];
  await withBoundJobRecord(
    root,
    startHost,
    'close',
    async ({ root, file, host, binding, project, original }) => {
      // Close at the generation the act scan saw: a finalized act bumps it, so an act
      // submitted after the scan makes Review refuse the close instead of dropping it.
      const inspectedGeneration = host.session.status().generation;
      const acts = pendingJobActs(project, await readHostActs(host), root);
      let next: JsonObject | undefined;
      if (acts.length > 0) {
        if (!discardEvidence) {
          const listed = acts.map(act => `${act.actId} (${pendingActRemedy(act)})`).join('; ');
          refuse('JOB_ACTS_PENDING', `project.json.review_acts: un-ingested finalized review act(s) ${listed}; ingest each act before closing, or run rig-create job close --discard-acts <reason> --by agent to record and discard them`);
        }
        next = appendDiscardedJobActs(root, project, acts.map(act => buildDiscardActReceipt(binding.jobId, act.actId, discardEvidence)), now);
      }
      assertUnchangedBindingAndRecord(root, file, binding, original, 'close');
      const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${binding.jobId}/api`, {
        method: 'POST',
        headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schema: binding.identity.apiSchema,
          verb: 'close',
          jobId: binding.jobId,
          requestId: 'create-close',
          idempotencyKey: 'create-close',
          expectedGeneration: inspectedGeneration,
          reason: 'producer-close',
        }),
      }));
      const result = await response.json() as { ok: boolean };
      if (!result.ok) refuse('JOB_BINDING_INVALID', 'project.json: review refused close; restore the bound live host and retry rig-create job close');
      return {
        next,
        afterWrite: () => {
          if (retireRefused) retireRefusedPublications(root, pending);
          rmSync(join(root, JOB_BINDING_FILE));
        },
      };
    },
    resolvedRoot => {
      pending = pendingPublications(resolvedRoot);
      if (pending.length && (!retireRefused || pending.some(entry => !entry.failure))) {
        refuse('JOB_PUBLISH_PENDING', 'project.json: a committed publication remains pending; run rig-create job reconcile, or job close --retire-refused to archive failed publications and close without publishing them');
      }
    },
    lockWaitMs,
  );
}
