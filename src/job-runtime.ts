/** Private stdin transport for synchronous writers. Capabilities never enter argv. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeCreateJob, openCreateJob, publishPending, reconcileCreateJob } from './job-host.ts';
import { failPublication, pendingPublications, reconcilePublication } from './job-outbox.ts';
import { Refusal, refuse } from './refusal.ts';

async function run(): Promise<void> {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { root: string; id?: string; reviewer?: string; role?: 'owner' | 'delegate'; now: number };
  const root = resolve(input.root);
  switch (process.argv[2]) {
    case 'publish': {
      const entry = pendingPublications(root).find(entry => entry.id === input.id);
      if (!entry) refuse('JOB_OUTBOX_INVALID', 'project.json: pending writer receipt is absent; restore the private outbox');
      try { await reconcilePublication(root, entry, publishPending); }
      catch (error) {
        const failure = error instanceof Refusal ? { code: error.code, message: error.message }
          : { code: 'JOB_PUBLISH_PENDING', message: 'project.json: host publication failed; restore the bound host before rig-create job reconcile' };
        failPublication(root, entry, failure);
        throw new Refusal('JOB_PUBLISH_PENDING', 'project.json: committed publication is pending; run rig-create job reconcile');
      }
      break;
    }
    case 'reconcile': console.log(`job: reconciled ${await reconcileCreateJob(root)} publication(s)`); break;
    case 'close': await closeCreateJob(root); console.log('job: closed'); break;
    case 'open': {
      if (!input.reviewer || !input.role) refuse('JOB_BINDING_INVALID', 'project.json: job open needs --reviewer and --role owner|delegate');
      const host = await openCreateJob(root, { id: input.reviewer, role: input.role }, input.now);
      console.log(host.ownerUrl);
      if (host.reused) host.stop();
      else {
        const stop = () => { host.stop(); process.exit(0); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        const timer = setInterval(() => {
          if (host.session.status().status === 'closed') { clearInterval(timer); stop(); }
        }, 1000);
      }
      break;
    }
    default: refuse('JOB_BINDING_INVALID', 'project.json: use rig-create job open|reconcile|close');
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
