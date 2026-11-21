import { join } from 'node:path';
import type { JobOwnerHost } from '@rig-c/review/job-host';
import { agentCall } from './job-acts.ts';
import { jobHash, jobHostStateRoot, privateDirectory, privateJson, tryJobDirectoryLock, writePrivateJson } from './job-outbox.ts';

export interface JobProgressUpdate {
  phase: 'ingest' | 'build' | 'measure' | 'publish' | 'other';
  text: string;
  step?: { i: number; n: number };
}

function sendToLiveHost(request: Request): Promise<Response> {
  return fetch(request, { redirect: 'error', signal: AbortSignal.timeout(1_000) });
}

/** True means the listener advertised progress, even if this particular update failed. */
export async function postJobProgress(root: string, host: JobOwnerHost, update: JobProgressUpdate): Promise<boolean> {
  if (host.session.publicationMode !== 'record-and-package') return false;
  try {
    const next = await agentCall(host, { verb: 'next', after: null, waitMs: 0 }, sendToLiveHost);
    if (next.ok !== true || next.value?.capabilities?.progress !== true || next.value.status === 'closed') return false;
  } catch { return false; }

  try {
    const { text, step } = update;
    if (text.length > 120 || /[\r\n\u0085\u2028\u2029]/u.test(text)) return true;
    if (step && (!Number.isSafeInteger(step.i) || !Number.isSafeInteger(step.n) || step.i < 1 || step.i > step.n || step.n > 1000)) return true;

    // The seq lives beside Review's managed host state, outside the project root, so a refused
    // writer leaves the project byte-identical even after it sent a milestone.
    const directory = join(jobHostStateRoot(root), 'progress');
    privateDirectory(directory);
    const key = jobHash(host.session.jobId);
    // Use a separate lock: the command can already hold the publication write lock.
    // Keep it through the POST so parallel Create processes send in sequence order.
    const release = tryJobDirectoryLock(join(directory, `${key}.lock`));
    if (!release) return true;
    try {
      const file = join(directory, `${key}.json`);
      let previous: unknown = 0;
      try { previous = privateJson(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (typeof previous !== 'number' || !Number.isSafeInteger(previous) || previous < 0 || previous === Number.MAX_SAFE_INTEGER) return true;
      const seq = previous + 1;
      // Reserve before sending: a lost response may still have reached Review.
      writePrivateJson(file, seq);
      await agentCall(host, { verb: 'progress', seq, phase: update.phase, text, ...(step ? { step } : {}) }, async request => {
        if ((await request.clone().arrayBuffer()).byteLength > 1024) throw new Error('Progress body exceeds the Review limit');
        return sendToLiveHost(request);
      });
    } finally { release(); }
  } catch { /* A progress failure never changes the command's result. */ }
  return true;
}
