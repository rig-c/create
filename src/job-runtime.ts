/** Private stdin transport for synchronous writers. Capabilities never enter argv. */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { startJobHost } from '@rig-c/review/job-host';
import { assertNoPendingJobAsk, attachCreateJobForClose, closeCreateJob, withdrawCreateJobAct } from './job-close.ts';
import { assertRequestedCurrent, assertRequestedDraft, assertRequestedRig, listCreateJobActs, openCreateJob, openCurrentPublication, openDraftPublication, openRecordPublication, requestedRecordResult, publishPending, reconcileCreateJob, type JobOpenGitState } from './job-host.ts';
import { failPublication, pendingPublications, readWriterBinding, reconcilePublication } from './job-outbox.ts';
import { postJobProgress, type JobProgressUpdate } from './job-progress.ts';
import { jobActsText, shellWord, type JobWriteAskTarget } from './job-acts.ts';
import { Refusal, refuse } from './refusal.ts';
import { replacedRootRefusal } from './job-host-state.ts';
import { requireOwnerLanguage } from './owner-language.ts';
import type { JsonObject } from './templates.ts';

/** Preserve this known producer refusal without printing an uncontrolled producer message. */
export function publicationFailure(error: unknown, root: string): Refusal | undefined {
  if (error instanceof Refusal) return error;
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'JOB_ROOT_REPLACED') {
    try { replacedRootRefusal(root); } catch (failure) { return failure as Refusal; }
  }
  return undefined;
}

async function run(): Promise<void> {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { root: string; id?: string; actId?: string; askTarget?: JobWriteAskTarget; reviewer?: string; role?: 'owner' | 'delegate'; draft?: string; rig?: string; current?: string; question?: Parameters<typeof requestedRecordResult>[1]; plan?: boolean; now: number; retireRefused?: boolean; discardActs?: Record<string, string>; json?: boolean; timeoutMs?: number; jobId?: string; listenerIncarnation?: string; update?: JobProgressUpdate };
  const root = resolve(input.root);
  switch (process.argv[2]) {
    case 'progress': {
      process.exitCode = 1;
      try {
        const canonical = realpathSync(root);
        const binding = readWriterBinding(canonical);
        if (!input.update || !binding || binding.jobId !== input.jobId || binding.listenerIncarnation !== input.listenerIncarnation) break;
        const host = await attachCreateJobForClose(canonical, binding, startJobHost);
        try {
          if (await postJobProgress(canonical, host, input.update)) process.exitCode = 0;
        } finally { host.stop(); }
      } catch { /* This private verb reports unavailability only to its caller. */ }
      break;
    }
    case 'check-ask': {
      if (!input.askTarget) refuse('JOB_PUBLICATION_INVALID', 'project.json: checking pending asks requires a writer target; restore the writer result');
      const head = await assertNoPendingJobAsk(root, input.askTarget);
      if (head !== null) console.log(head);
      break;
    }
    case 'publish': {
      const entry = pendingPublications(root).find(entry => entry.id === input.id);
      if (!entry) refuse('JOB_OUTBOX_INVALID', 'project.json: pending writer receipt is absent; restore the private outbox');
      let update: { publicationId: string; replaced: boolean } | undefined;
      try {
        await reconcilePublication(root, entry, async item => {
          await publishPending(item, undefined, undefined, undefined, published => { update = published; });
        });
      }
      catch (error) {
        const named = publicationFailure(error, root);
        const failure = named ? { code: named.code, message: named.message }
          : { code: 'JOB_PUBLISH_PENDING', message: 'project.json: host publication failed; restore the bound host before rig-create job reconcile' };
        failPublication(root, entry, failure);
        throw new Refusal('JOB_PUBLISH_PENDING', 'project.json: committed publication is pending; run rig-create job reconcile');
      }
      if (update?.replaced) {
        console.log(`job: updated the open page: publication ${update.publicationId}`);
      }
      break;
    }
    case 'acts': {
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', interrupt);
      try {
        const wait = input.timeoutMs === undefined ? undefined : { timeoutMs: input.timeoutMs, signal: controller.signal };
        const result = await listCreateJobActs(root, undefined, wait);
        console.log(input.json ? JSON.stringify(result) : jobActsText(result));
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        process.exitCode = 1;
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
      }
      break;
    }
    case 'reconcile': console.log(`job: reconciled ${await reconcileCreateJob(root, undefined, input.now)} publication(s)`); break;
    case 'withdraw-act': {
      await withdrawCreateJobAct(root, input.actId ?? '', input.discardActs ?? {}, input.now);
      console.log(`job: withdrew act ${input.actId}`);
      break;
    }
    case 'close': {
      const result = await closeCreateJob(root, undefined, input.retireRefused, input.discardActs, input.now);
      console.log(result.status === 'closed' ? 'job: closed'
        : `job: retired ${result.retired} failed publication(s); kept the job open with ${result.pending} pending publication(s). Run rig-create job reconcile ${shellWord(root)}`);
      break;
    }
    case 'open': {
      if (!input.reviewer || !input.role) refuse('JOB_BINDING_INVALID', 'project.json: job open needs --reviewer and --role owner|delegate');
      const record = requestedRecordResult(root, input.question, input.plan, input.now);
      const current = assertRequestedCurrent(root, input.current, input.draft, input.rig);
      const rig = assertRequestedRig(root, input.rig, input.draft);
      const { bytes, draftId } = current
        ? { bytes: Buffer.alloc(0), draftId: undefined }
        : assertRequestedDraft(root, input.draft, input.now);
      if (rig || draftId !== undefined) requireOwnerLanguage(JSON.parse(bytes.toString('utf8')) as JsonObject);
      const target = record ?? current ?? rig ?? (draftId !== undefined ? { kind: 'draft' as const, id: draftId } : undefined);
      // Refuse before attaching or writing; openRecordPublication/openCurrentPublication/openDraftPublication repeat it under the job lock (#737, #740).
      if (target) await assertNoPendingJobAsk(root, target);
      let stopping = false;
      let stopHost: (() => void) | null = null;
      const onSignal = () => {
        stopping = true;
        stopHost?.();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      const git: JobOpenGitState = current ? { current: current.output } : {};
      const host = await openCreateJob(root, { id: input.reviewer, role: input.role }, input.now, undefined, record !== undefined, git);
      if (stopping) {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        host.stop();
        break;
      }
      console.log(host.ownerUrl);
      // The page shows the record's current draft and its asks. A refused publish or ask is
      // named here; a foreground host keeps serving so `job reconcile` and `job open` can retry.
      try {
        const lines = await (record
          ? openRecordPublication(root, host, input.question, Boolean(input.plan), input.now, git)
          : current
            ? openCurrentPublication(root, host, current.output, input.now, git)
            : openDraftPublication(root, host, input.now, input.draft, input.rig, git));
        console.log(lines.join('\n'));
      }
      catch (error) {
        if (host.reused) {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          host.stop();
          throw error;
        }
        const named = publicationFailure(error, root);
        console.error(named ? `${named.code}: ${named.message}` : 'JOB_PUBLISH_PENDING: project.json: draft publication failed; run rig-create job reconcile');
        process.exitCode = 1;
      }
      if (host.reused || stopping) {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        host.stop();
      } else {
        const timer = setInterval(() => {
          let closed: boolean;
          // Review 4.5.0+ disposes its own host session shortly after a close (job-front subscribe),
          // so a status read on a disposed session means the job closed.
          try { closed = host.session.status().status === 'closed'; } catch { closed = true; }
          if (closed) stopHost?.();
        }, 1000);
        stopHost = () => {
          clearInterval(timer);
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          host.stop();
          process.exit(process.exitCode ?? 0);
        };
      }
      break;
    }
    default: refuse('JOB_BINDING_INVALID', 'project.json: use rig-create job open|acts|reconcile|withdraw-act|close');
  }
}

if (import.meta.main) {
  try { await run(); }
  catch (error) {
    // Unexpected errors may embed producer input. Only controlled refusals leave this process.
    const named = publicationFailure(error, 'the requested project directory');
    console.error(named ? `${named.code}: ${named.message}` : 'JOB_PUBLISH_PENDING: project.json: publication operation failed; run rig-create job reconcile');
    process.exitCode = named?.exitCode ?? 1;
  }
}
