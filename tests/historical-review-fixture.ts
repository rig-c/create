import { randomUUID } from 'node:crypto';
import {
  JOB_COMMENTS_ACT_SCHEMA, JOB_RECORD_ACT_SCHEMA, parseCommentsAct, parseRecordAct,
  type JobActV3, type JobComment, type JobOwnerHost, type JobRetainedSourceV3, type JobReviewerBinding,
  type JobSourceV3, type RecordCheckpointSubject,
} from '@rig-c/review/job-host';

type PendingCheckpoint = {
  askId: string;
  publicationId: string;
  subject: RecordCheckpointSubject;
  source: JobSourceV3;
  status: 'pending' | 'answered';
};
type StoredJob = { data: {
  generation: number;
  reviewer: JobReviewerBinding;
  publications: Record<string, { retained: JobRetainedSourceV3 }>;
  asks: Record<string, PendingCheckpoint>;
  acts: Record<string, JobActV3>;
} };

function historicalSession(host: JobOwnerHost) {
  return host.session as unknown as {
    jobId: string;
    store: { update(jobId: string, rev: null, write: (row: StoredJob) => StoredJob): StoredJob };
    event(data: StoredJob['data'], event: { type: 'pending'; ask: PendingCheckpoint } | { type: 'act'; act: JobActV3 }): void;
  };
}

/** Seed a retired checkpoint ask against the real retained publication. */
export function seedHistoricalCheckpointAsk(host: JobOwnerHost, publicationId: string, subject: RecordCheckpointSubject): string {
  const session = historicalSession(host);
  const askId = randomUUID();
  session.store.update(session.jobId, null, ({ data }) => {
    const { source, subjects } = data.publications[publicationId]!.retained;
    if (!subjects.some(candidate => candidate.kind === 'checkpoint' && candidate.checkpointId === subject.checkpointId)) {
      throw Error('Historical checkpoint ask needs a publication that declared it');
    }
    const ask: PendingCheckpoint = { askId, publicationId, subject, source, status: 'pending' };
    data.generation++;
    data.asks[askId] = ask;
    session.event(data, { type: 'pending', ask });
    return { data };
  });
  return askId;
}

/** Store the answered ask and finalized event as Review did before retiring checkpoint submissions. */
export function seedHistoricalCheckpointAct(host: JobOwnerHost, askId: string, outcome: 'pass' | 'fail',
  content: { words: string } | { comments: readonly JobComment[] },
  { actId = randomUUID(), at = new Date().toISOString() }: { actId?: string; at?: string } = {}) {
  const session = historicalSession(host);
  const { data } = session.store.update(session.jobId, null, ({ data }) => {
    const ask = data.asks[askId]!;
    const { publicationId, source, subject: { checkpointId } } = ask;
    const act = { actId, jobId: session.jobId, askId, publicationId, kind: 'checkpoint', source, at,
      authority: { actor: 'human', channel: 'review-ui', reviewer: data.reviewer },
      value: { checkpointId, planStepId: checkpointId, outcome, ...content } };
    const parsed = 'words' in content
      ? parseRecordAct({ ...act, schema: JOB_RECORD_ACT_SCHEMA })
      : parseCommentsAct({ ...act, schema: JOB_COMMENTS_ACT_SCHEMA });
    data.generation++;
    data.asks[askId] = { ...ask, status: 'answered' };
    data.acts[actId] = parsed;
    session.event(data, { type: 'act', act: parsed });
    return { data };
  });
  const act = data.acts[actId];
  if (act?.kind !== 'checkpoint') throw Error('Historical checkpoint act was not stored');
  return act;
}
