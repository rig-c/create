import { join } from 'node:path';
import { startJobHost, type ActV3, type JobHostReuseExpectation, type JobOwnerHost, type JobReviewerBinding } from '@rig-c/review/job-host';
import { agentCall, readHostActs } from './job-acts.ts';
import { privateJson, writePrivateJson } from './job-outbox.ts';
import { refuse } from './refusal.ts';

const FINGERPRINT = 'rig-create/candidate-review/1';
const BINDING_FILE = 'host.json';

function candidateHostOptions(path: string, reviewer: JobReviewerBinding) {
  return {
    root: join(path, 'package'), stateDir: join(path, 'state'), fingerprint: FINGERPRINT,
    reviewer,
  };
}

export async function openCandidateHost(path: string, reviewer: JobReviewerBinding): Promise<JobOwnerHost> {
  const host = await startJobHost({ ...candidateHostOptions(path, reviewer), port: 0 });
  try {
    if (host.reused || !host.attachment) throw Error('candidate host did not open its own listener');
    writePrivateJson(join(path, BINDING_FILE), host.attachment);
    return host;
  } catch (error) {
    host.stop();
    throw error;
  }
}

export function candidateHostBinding(path: string): JobHostReuseExpectation | undefined {
  let expected: JobHostReuseExpectation;
  try { expected = privateJson(join(path, BINDING_FILE)) as JobHostReuseExpectation; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const nominal = candidateHostOptions(path, expected?.binding?.reviewer);
  if (!expected?.binding || expected.binding.root !== nominal.root || expected.binding.stateDir !== nominal.stateDir
    || expected.binding.fingerprint !== FINGERPRINT) {
    refuse('JOB_BINDING_INVALID', 'scratch/candidates: restore the private candidate job binding before retiring the candidate');
  }
  return expected;
}

export async function attachCandidateHost(path: string, expected: JobHostReuseExpectation, recoverStopped = false): Promise<JobOwnerHost | undefined> {
  try {
    return await startJobHost({ ...candidateHostOptions(path, expected.binding.reviewer), reuseOnly: { expected } });
  } catch (error) {
    const failure = error as { code?: string; reason?: string; phase?: string };
    if (failure.code === 'JOB_HOST_ATTACH_REFUSED' && failure.phase === 'state' && failure.reason === 'closed') return;
    if (!recoverStopped || failure.code !== 'JOB_HOST_ATTACH_REFUSED' || !['stopped', 'probe', 'missing'].includes(failure.reason ?? '')) throw error;
    const host = await startJobHost({ ...candidateHostOptions(path, expected.binding.reviewer), port: 0 });
    if (host.session.jobId !== expected.jobId || !host.attachment) {
      host.stop();
      throw error;
    }
    writePrivateJson(join(path, BINDING_FILE), host.attachment);
    return host;
  }
}

/** Drain finalized acts at the observed generation. A racing comment keeps the job alive for another scan. */
export async function closeCandidateHost(host: JobOwnerHost, drain: (acts: ActV3[]) => Promise<void>): Promise<void> {
  for (let retry = 0; retry < 4; retry++) {
    const generation = host.session.status().generation;
    await drain(await readHostActs(host));
    const reply = await agentCall(host, {
      verb: 'close', expectedGeneration: generation, idempotencyKey: `candidate-close-${generation}`, reason: 'candidate-retired',
    });
    if (reply.ok) return;
    if (reply.error?.code !== 'JOB_GENERATION_STALE') break;
  }
  refuse('JOB_BINDING_INVALID', 'scratch/candidates: Review could not seal the candidate job; run candidate close again');
}

export async function awaitCandidateListenerStop(binding: JobHostReuseExpectation): Promise<void> {
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`${binding.origin}/jobs/${binding.jobId}/`, { signal: AbortSignal.timeout(500) });
      void response.body?.cancel();
      if (response.status === 404) return;
    } catch (error) {
      if ((error as { code?: string }).code === 'ECONNREFUSED') return;
    }
    await Bun.sleep(50);
  }
  refuse('JOB_BINDING_INVALID', 'scratch/candidates: candidate listener is still active; run candidate close again');
}
