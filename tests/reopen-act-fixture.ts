/** Review's installed producer makes the synthetic sealed act; tests never hand-build its source digest. */
import { prepareJobRecordAct, prepareJobRecordSource, type RecordPublicationReader, type RecordReaderInput, type RecordOptionResult, type RecordPlanResult, type RecordPublishedContext, type OptionContext, type PlanContext } from '@rig-c/review/job-host';
import { readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentJobIdentity } from '../src/job-publication.ts';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';

export async function exportedReopen(root: string, stage: string, at: number, words = '  Revisit the review.\r\nKeep the framing — unchanged.  ', reviewer = 'synthetic-owner') {
  root = realpathSync(root);
  const jobId = 'synthetic-reopen-job';
  const identity = currentJobIdentity({ root, stateDir: 'unused-private-state', fingerprint: 'synthetic', reviewer: { id: reviewer, role: 'owner' } }, root);
  writePrivateJson(join(root, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId, origin: 'http://127.0.0.1:43123', fetchCapability: 'synthetic-read-grant' }, true);
  const file = join(root, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  project.review_job = { jobId, origin: 'http://127.0.0.1:43123' };
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  const stateRoot = realpathSync(tempDir());
  try {
    const record = { path: 'project.json' as const, sha256: jobHash(readFileSync(file)) };
    const stat = statSync(root);
    const retained = await prepareJobRecordSource({ root: { path: root, dev: stat.dev, ino: stat.ino }, stateRoot, fingerprint: 'synthetic',
      request: { result: { kind: 'plan' }, freeze: { kind: 'producer-held', holdId: 'synthetic-freeze', record } },
      // Unit fixture boundary: the context is synthetic; Review produces its sealed source and finalized act.
      readRecordPublished: syntheticReopenReader(stage),
    });
    const publicationId = 'synthetic-reopen-publication';
    const askId = 'synthetic-reopen-ask';
    const act = prepareJobRecordAct({ jobId, actId: 'synthetic-reopen-act', at: new Date(at).toISOString(), reviewer: { id: reviewer, role: 'owner' }, retained,
      ask: { askId, publicationId, subject: { kind: 'reopen', stage }, source: retained.source, status: 'pending' },
      submission: { publicationId, askId, pageId: 'synthetic-page', displayedNonce: 'synthetic-nonce', expectedGeneration: 2,
        submissionId: 'synthetic-submit', kind: 'reopen', value: { stage, words } },
    });
    if (act.kind !== 'reopen') throw Error('producer returned another kind');
    return { act, bytes: JSON.stringify(act) };
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
}


export function syntheticReopenReader(stage: string): RecordPublicationReader {
  function read(input: RecordReaderInput<RecordOptionResult>): OptionContext;
  function read(input: RecordReaderInput<RecordPlanResult>): PlanContext;
  function read(input: RecordReaderInput): RecordPublishedContext {
    if (input.result.kind !== 'plan') throw Error('synthetic reopen requires a plan');
    const project = JSON.parse(readFileSync(join(input.root, 'project.json'), 'utf8')) as JsonObject;
    return { label: 'synthetic reopen plan', parts: { name: '@rig-c/parts', version: '2.37.0', integrity: 'synthetic-lock' },
      inputs: [], files: [input.record], plan: { steps: arr(obj(project.plan).steps).map(raw => ({ id: String(obj(raw).id), hash: stepHash(obj(raw)) })) },
      subjects: [{ kind: 'reopen', stage }] };
  }
  return read;
}
