/** Private stdin transport for synchronous writers. Capabilities never enter argv. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { askOutcomeLines, assertRequestedDraft, assertRequestedRig, closeCreateJob, listCreateJobActs, openCreateJob, openDraftPublication, publishPending, reconcileCreateJob, refuseAskOutcomes, type AskOutcome } from './job-host.ts';
import { failPublication, pendingPublications, reconcilePublication } from './job-outbox.ts';
import { jobActsText } from './job-acts.ts';
import { Refusal, refuse } from './refusal.ts';

async function run(): Promise<void> {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { root: string; id?: string; reviewer?: string; role?: 'owner' | 'delegate'; draft?: string; rig?: string; now: number; json?: boolean };
  const root = resolve(input.root);
  switch (process.argv[2]) {
    case 'publish': {
      const entry = pendingPublications(root).find(entry => entry.id === input.id);
      if (!entry) refuse('JOB_OUTBOX_INVALID', 'project.json: pending writer receipt is absent; restore the private outbox');
      let outcomes: AskOutcome[] = [];
      try { await reconcilePublication(root, entry, async item => { outcomes = await publishPending(item); }); }
      catch (error) {
        const failure = error instanceof Refusal ? { code: error.code, message: error.message }
          : { code: 'JOB_PUBLISH_PENDING', message: 'project.json: host publication failed; restore the bound host before rig-create job reconcile' };
        failPublication(root, entry, failure);
        throw new Refusal('JOB_PUBLISH_PENDING', 'project.json: committed publication is pending; run rig-create job reconcile');
      }
      const lines = askOutcomeLines(outcomes);
      if (lines.length) console.log(lines.join('\n'));
      refuseAskOutcomes(outcomes);
      break;
    }
    case 'acts': {
      const result = await listCreateJobActs(root);
      console.log(input.json ? JSON.stringify(result) : jobActsText(result));
      break;
    }
    case 'reconcile': console.log(`job: reconciled ${await reconcileCreateJob(root)} publication(s)`); break;
    case 'close': await closeCreateJob(root); console.log('job: closed'); break;
    case 'open': {
      if (!input.reviewer || !input.role) refuse('JOB_BINDING_INVALID', 'project.json: job open needs --reviewer and --role owner|delegate');
      assertRequestedRig(root, input.rig, input.draft);
      assertRequestedDraft(root, input.draft);
      let stopping = false;
      let stopHost: (() => void) | null = null;
      const onSignal = () => {
        stopping = true;
        stopHost?.();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      const host = await openCreateJob(root, { id: input.reviewer, role: input.role }, input.now);
      if (stopping) {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        host.stop();
        break;
      }
      console.log(host.ownerUrl);
      // The page shows the record's current draft and its asks. A refused publish or ask is
      // named here; a foreground host keeps serving so `job reconcile` and `job open` can retry.
      try { console.log((await openDraftPublication(root, host, input.now, input.draft, input.rig)).join('\n')); }
      catch (error) {
        if (host.reused) {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          host.stop();
          throw error;
        }
        console.error(error instanceof Refusal ? `${error.code}: ${error.message}` : 'JOB_PUBLISH_PENDING: project.json: draft publication failed; run rig-create job reconcile');
        process.exitCode = 1;
      }
      if (host.reused || stopping) {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        host.stop();
      } else {
        const timer = setInterval(() => {
          if (host.session.status().status === 'closed') stopHost?.();
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
    default: refuse('JOB_BINDING_INVALID', 'project.json: use rig-create job open|acts|reconcile|close');
  }
}

if (import.meta.main) {
  try { await run(); }
  catch (error) {
    // Unexpected errors may embed producer input. Only controlled refusals leave this process.
    console.error(error instanceof Refusal ? `${error.code}: ${error.message}` : 'JOB_PUBLISH_PENDING: project.json: publication operation failed; run rig-create job reconcile');
    process.exitCode = 1;
  }
}
