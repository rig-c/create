import { readOwnerChat } from './owner-chat.ts';
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { pendingJobActs, pendingJobAsksForTarget, readHostActs, readHostActsAndAsks } from './job-acts.ts';
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
import { reviewActFindings } from './review-act.ts';
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
      refuse('JOB_HOST_ATTACH_REFUSED', `project.json: live host attach refused (reason=${error.reason}, phase=${error.phase}); reopen or restore the bound live host before rig-create job close`);
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
  target: JobSelector,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
): Promise<void> {
  root = realpathSync(root);
  const binding = readWriterBinding(root);
  if (!binding || binding.identity.root !== root) return;
  let host: JobOwnerHost;
  try {
    host = await attachCreateJobForClose(root, binding, startHost);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'JOB_HOST_ATTACH_REFUSED' || error.code === 'JOB_HOST_REUSE_MISMATCH')) {
      return;
    }
    throw error;
  }
  try {
    const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
    const { asks, acts } = await readHostActsAndAsks(host);
    const pending = pendingJobAsksForTarget(project, asks, acts, root, target);
    if (pending.length > 0) {
      const listed = pending.map(item => item.label).join('; ');
      const version = pending.find(item => item.version !== null)?.version ?? null;
      const ingest = version === null || pending.some(item => item.version === null)
        ? 'run rig-create job acts, run the printed ingest commands'
        : `give the verdict, run rig-create job acts, ingest with rig-create review ${version} --from-review <actId> (review <n> --from-review <actId>)`;
      refuse(
        'JOB_ASK_PENDING',
        `project.json: bound job ${binding.jobId} holds pending owner ask(s) ${listed} with no ingested act; ${ingest}, run rig-create job close, then re-run`,
      );
    }
  } finally {
    host.stop();
  }
}

export async function closeCreateJob(
  root: string,
  startHost: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost,
  retireRefused = false,
  discardActs?: Record<string, string>,
  now = Date.now(),
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
  root = realpathSync(root);
  const release = acquireJobLock(root)!;
  try {
    const pending = pendingPublications(root);
    if (pending.length && (!retireRefused || pending.some(entry => !entry.failure))) {
      refuse('JOB_PUBLISH_PENDING', 'project.json: a committed publication remains pending; run rig-create job reconcile, or job close --retire-refused to archive failed publications and close without publishing them');
    }
    const binding = readWriterBinding(root);
    if (!binding) refuse('JOB_BINDING_INVALID', 'project.json: no writer-owned job binding; open the live job first');
    const host = await attachCreateJobForClose(root, binding, startHost);
    const file = join(root, 'project.json');
    const temporary = join(root, '.rig-create-job-record.tmp');
    try {
      try {
        host.session.authorize('consumer', `Bearer ${binding.fetchCapability}`);
      } catch {
        refuse('JOB_BINDING_INVALID', 'project.json: writer binding fetchCapability is not authorized for the bound live job; restore the writer-owned binding before rig-create job close');
      }
      const original = readFileSync(file);
      const project = JSON.parse(original.toString('utf8')) as JsonObject;
      // Close at the generation the act scan saw: a finalized act bumps it, so an act
      // submitted after the scan makes Review refuse the close instead of dropping it.
      const inspectedGeneration = host.session.status().generation;
      const acts = pendingJobActs(project, await readHostActs(host), root);
      let next: JsonObject | undefined;
      if (acts.length > 0) {
        if (!discardEvidence) {
          const listed = acts.map(act => `${act.actId} (${act.command ?? `${act.unavailable!.code}: ${act.unavailable!.message}`})`).join('; ');
          refuse('JOB_ACTS_PENDING', `project.json.review_acts: un-ingested finalized review act(s) ${listed}; ingest each act before closing, or run rig-create job close --discard-acts <reason> --by agent to record and discard them`);
        }
        next = {
          ...project,
          review_acts: [
            ...asArray(project.review_acts),
            ...acts.map(act => ({
              schema: 'rig-create/review-act@1',
              kind: 'discarded',
              jobId: binding.jobId,
              actId: act.actId,
              ...discardEvidence,
            })),
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
      }
      const currentBeforeClose = readWriterBinding(root);
      if (!currentBeforeClose || !isDeepStrictEqual(currentBeforeClose, binding)) {
        refuse('JOB_BINDING_INVALID', 'project.json: private live-job binding changed during close; restore the writer-owned binding');
      }
      if (!readFileSync(file).equals(original)) {
        refuse('JOB_BINDING_INVALID', 'project.json: record changed during close; retry against the current record');
      }
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
      const current = readWriterBinding(root);
      if (!current || !isDeepStrictEqual(current, binding)) {
        refuse('JOB_BINDING_INVALID', 'project.json: private live-job binding changed during close; restore the writer-owned binding');
      }
      if (next !== undefined) {
        if (!readFileSync(file).equals(original)) {
          refuse('JOB_BINDING_INVALID', 'project.json: record changed during close; retry against the current record');
        }
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
        renameSync(temporary, file);
      }
      if (retireRefused) retireRefusedPublications(root, pending);
      rmSync(join(root, JOB_BINDING_FILE));
    } finally {
      rmSync(temporary, { force: true });
      host.stop();
    }
  } finally {
    release();
  }
}
