import { describe, expect, test } from 'bun:test';
import type { JobOwnerHost } from '@rig-c/review/job-host';
import { askDeclaredSubjects, askOutcomeLines, refuseAskOutcomes } from '../src/job-host.ts';
import { jobHash, type PublicationSubject } from '../src/job-outbox.ts';

interface RecordedCall {
  verb: string;
  expectedGeneration?: number;
  publicationId?: string;
  subject?: PublicationSubject;
  subjects?: PublicationSubject[];
  idempotencyKey?: string;
}

function makeStubHost(options: {
  askBatch?: boolean;
  alreadyAsked?: PublicationSubject[];
  generation?: number;
  onAskBatch?: (call: RecordedCall, callIndex: number) => { ok: boolean; value?: unknown; error?: { code: string; message?: string } };
  onAsk?: (call: RecordedCall, callIndex: number) => { ok: boolean; value?: unknown; error?: { code: string; message?: string } };
} = {}): { host: JobOwnerHost; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let generation = options.generation ?? 5;
  let askBatchIndex = 0;
  let askIndex = 0;
  const host = {
    origin: 'http://127.0.0.1:43210',
    ownerUrl: 'http://127.0.0.1:43210/jobs/job-stub/#cap=owner-cap',
    reused: false,
    stop: () => {},
    session: {
      jobId: 'job-stub',
      publicationMode: 'record-and-package',
      hostCredentials: () => ({ agent: 'agent-cap', owner: 'owner-cap' }),
      status: () => ({ generation, status: 'open', publication: null, pending: [] }),
    },
    ports: {
      handleJobApi: async (request: Request) => {
        const body = await request.json() as RecordedCall;
        calls.push(body);
        if (body.verb === 'next') {
          const allEvents = (options.alreadyAsked ?? []).map((subject, index) => ({
            type: 'pending',
            cursor: `c-${index + 1}`,
            generation: index + 1,
            ask: { askId: `ask-old-${index + 1}`, publicationId: 'pub-1', subject },
          }));
          const after = (body as { after?: string | null }).after ?? null;
          const events = after === null ? allEvents : [];
          return Response.json({
            schema: 'rig-review/job-api@3',
            ok: true,
            value: {
              capabilities: options.askBatch ? { askBatch: true } : {},
              events,
              cursor: events.at(-1)?.cursor ?? after,
              status: events.length ? 'events' : 'timeout',
            },
          });
        }
        if (body.verb === 'ask-batch') {
          const current = askBatchIndex++;
          if (options.onAskBatch) {
            return Response.json({ schema: 'rig-review/job-api@3', ...options.onAskBatch(body, current) });
          }
          const subjects = body.subjects ?? [];
          generation += subjects.length;
          return Response.json({
            schema: 'rig-review/job-api@3',
            ok: true,
            value: {
              asks: subjects.map((subject, i) => ({
                askId: `ask-${current}-${i}`,
                publicationId: body.publicationId,
                subject,
              })),
            },
          });
        }
        if (body.verb === 'ask') {
          const current = askIndex++;
          if (options.onAsk) {
            return Response.json({ schema: 'rig-review/job-api@3', ...options.onAsk(body, current) });
          }
          generation += 1;
          return Response.json({
            schema: 'rig-review/job-api@3',
            ok: true,
            value: {
              ask: {
                askId: `ask-single-${current}`,
                publicationId: body.publicationId,
                subject: body.subject,
              },
            },
          });
        }
        return Response.json({ schema: 'rig-review/job-api@3', ok: false, error: { code: 'JOB_REQUEST_INVALID' } });
      },
    },
  } as unknown as JobOwnerHost;
  return { host, calls };
}

describe('askDeclaredSubjects batch ask (#658)', () => {
  const sampleSubjects: PublicationSubject[] = [
    { kind: 'signoff', stage: 'plan-approved' },
    { kind: 'reopen', stage: 'interview' },
    { kind: 'checkpoint', checkpointId: 'spine' },
  ];

  test('with capabilities.askBatch: sends one ask-batch call in declared order and maps asks[i] to subjects[i]', async () => {
    const { host, calls } = makeStubHost({ askBatch: true, generation: 10 });
    const outcomes = await askDeclaredSubjects(host, 'pub-1', sampleSubjects, true);
    expect(calls.map(c => c.verb)).toEqual(['next', 'ask-batch']);
    expect(calls[1]).toMatchObject({
      verb: 'ask-batch',
      expectedGeneration: 10,
      publicationId: 'pub-1',
      subjects: sampleSubjects,
      idempotencyKey: jobHash(JSON.stringify(['pub-1', sampleSubjects, 10])),
    });
    expect(outcomes).toEqual(sampleSubjects.map(subject => ({ subject, status: 'asked' })));
    expect(askOutcomeLines(outcomes)).toEqual([
      'job: asked signoff plan-approved, reopen interview, checkpoint spine',
    ]);
  });

  test('a package-mode publication keeps single asks even when Review advertises askBatch', async () => {
    const { host, calls } = makeStubHost({ askBatch: true, generation: 10 });
    const outcomes = await askDeclaredSubjects(host, 'pub-1', sampleSubjects, false);
    expect(calls.map(c => c.verb)).toEqual(['next', 'ask', 'ask', 'ask']);
    expect(outcomes).toEqual(sampleSubjects.map(subject => ({ subject, status: 'asked' })));
  });

  test('without capabilities.askBatch: sends N single ask calls as today', async () => {
    const { host, calls } = makeStubHost({ askBatch: false, generation: 10 });
    const outcomes = await askDeclaredSubjects(host, 'pub-1', sampleSubjects, true);
    expect(calls.map(c => c.verb)).toEqual(['next', 'ask', 'ask', 'ask']);
    expect(calls[1]).toMatchObject({
      verb: 'ask',
      expectedGeneration: 10,
      publicationId: 'pub-1',
      subject: sampleSubjects[0],
      idempotencyKey: jobHash(JSON.stringify(['pub-1', sampleSubjects[0], 10])),
    });
    expect(calls[2]).toMatchObject({
      verb: 'ask',
      expectedGeneration: 11,
      publicationId: 'pub-1',
      subject: sampleSubjects[1],
      idempotencyKey: jobHash(JSON.stringify(['pub-1', sampleSubjects[1], 11])),
    });
    expect(calls[3]).toMatchObject({
      verb: 'ask',
      expectedGeneration: 12,
      publicationId: 'pub-1',
      subject: sampleSubjects[2],
      idempotencyKey: jobHash(JSON.stringify(['pub-1', sampleSubjects[2], 12])),
    });
    expect(outcomes).toEqual(sampleSubjects.map(subject => ({ subject, status: 'asked' })));
  });

  test('refusal at subjects[i]: returns one refused outcome naming subject i and nothing asked', async () => {
    const { host, calls } = makeStubHost({
      askBatch: true,
      alreadyAsked: [sampleSubjects[0]!],
      onAskBatch: () => ({
        ok: false,
        error: { code: 'JOB_ASK_INVALID', message: 'subjects[1]: subject is not declared' },
      }),
    });
    const outcomes = await askDeclaredSubjects(host, 'pub-1', sampleSubjects, true);
    expect(calls.filter(c => c.verb !== 'next').map(c => c.verb)).toEqual(['ask-batch']);
    expect(calls.find(c => c.verb === 'ask-batch')!.subjects).toEqual([sampleSubjects[1]!, sampleSubjects[2]!]);
    // subjects[1] in the batch is sampleSubjects[2] ("checkpoint spine"); sampleSubjects[1] was not asked.
    expect(outcomes).toEqual([
      { subject: sampleSubjects[0]!, status: 'already' },
      { subject: sampleSubjects[2]!, status: 'refused', code: 'JOB_ASK_INVALID' },
    ]);
    expect(() => refuseAskOutcomes(outcomes)).toThrow(
      expect.objectContaining({
        code: 'JOB_ASK_REFUSED',
        message: expect.stringContaining('checkpoint spine (JOB_ASK_INVALID)'),
      }),
    );
  });

  test('freshness refusal without subject index: names the whole batch in refuseAskOutcomes', async () => {
    const { host } = makeStubHost({
      askBatch: true,
      onAskBatch: () => ({
        ok: false,
        error: { code: 'JOB_SOURCE_STALE', message: 'project.json changed since publication' },
      }),
    });
    const outcomes = await askDeclaredSubjects(host, 'pub-1', sampleSubjects, true);
    expect(outcomes).toEqual(sampleSubjects.map(subject => ({
      subject,
      status: 'refused',
      code: 'JOB_SOURCE_STALE',
    })));
    expect(() => refuseAskOutcomes(outcomes)).toThrow(
      expect.objectContaining({
        code: 'JOB_ASK_REFUSED',
        message: expect.stringContaining(
          'signoff plan-approved (JOB_SOURCE_STALE), reopen interview (JOB_SOURCE_STALE), checkpoint spine (JOB_SOURCE_STALE)',
        ),
      }),
    );
  });

  test('already-asked subjects are excluded from the batch and retain status already', async () => {
    const { host, calls } = makeStubHost({
      askBatch: true,
      alreadyAsked: [sampleSubjects[1]!],
      generation: 7,
    });
    const outcomes = await askDeclaredSubjects(host, 'pub-1', sampleSubjects, true);
    expect(calls.filter(c => c.verb !== 'next').map(c => c.verb)).toEqual(['ask-batch']);
    expect(calls.find(c => c.verb === 'ask-batch')!.subjects).toEqual([sampleSubjects[0]!, sampleSubjects[2]!]);
    expect(outcomes).toEqual([
      { subject: sampleSubjects[0]!, status: 'asked' },
      { subject: sampleSubjects[1]!, status: 'already' },
      { subject: sampleSubjects[2]!, status: 'asked' },
    ]);
  });

  test('0 subjects left to ask: sends no ask or ask-batch call', async () => {
    const { host, calls } = makeStubHost({
      askBatch: true,
      alreadyAsked: sampleSubjects,
    });
    const outcomes = await askDeclaredSubjects(host, 'pub-1', sampleSubjects, true);
    expect(calls.filter(c => c.verb !== 'next')).toEqual([]);
    expect(outcomes).toEqual(sampleSubjects.map(subject => ({ subject, status: 'already' })));
  });

  test('65 subjects: sends 2 ask-batch calls in chunks of 64 and 1 in order', async () => {
    const manySubjects: PublicationSubject[] = Array.from({ length: 65 }, (_, i) => ({
      kind: 'checkpoint',
      checkpointId: `step-${i + 1}`,
    }));
    const { host, calls } = makeStubHost({ askBatch: true, generation: 1 });
    const outcomes = await askDeclaredSubjects(host, 'pub-1', manySubjects, true);
    expect(calls.map(c => c.verb)).toEqual(['next', 'ask-batch', 'ask-batch']);
    expect(calls[1]!.subjects).toHaveLength(64);
    expect(calls[1]!.subjects).toEqual(manySubjects.slice(0, 64));
    expect(calls[1]!.expectedGeneration).toBe(1);
    expect(calls[2]!.subjects).toHaveLength(1);
    expect(calls[2]!.subjects).toEqual(manySubjects.slice(64));
    expect(calls[2]!.expectedGeneration).toBe(65);
    expect(outcomes).toEqual(manySubjects.map(subject => ({ subject, status: 'asked' })));
  });

  test('#743 keeps only the JOB_ASK_SUPERSEDED message and strips non-superseded messages', async () => {
    const singleHost = makeStubHost({
      askBatch: false,
      onAsk: (_call, index) => index === 0
        ? { ok: false, error: { code: 'JOB_ASK_SUPERSEDED', message: 'ask ask-1 is superseded; head pub-2' } }
        : { ok: false, error: { code: 'JOB_ASK_INVALID', message: 'subject is not declared' } },
    });
    const singleOutcomes = await askDeclaredSubjects(singleHost.host, 'pub-1', sampleSubjects.slice(0, 2), false);
    expect(singleOutcomes).toEqual([
      { subject: sampleSubjects[0]!, status: 'refused', code: 'JOB_ASK_SUPERSEDED', message: 'ask ask-1 is superseded; head pub-2' },
      { subject: sampleSubjects[1]!, status: 'refused', code: 'JOB_ASK_INVALID' },
    ]);
    let singleThrown: unknown;
    try { refuseAskOutcomes(singleOutcomes); } catch (error) { singleThrown = error; }
    expect(singleThrown).toMatchObject({ code: 'JOB_ASK_REFUSED' });
    expect((singleThrown as Error).message).toContain('signoff plan-approved (JOB_ASK_SUPERSEDED: ask ask-1 is superseded; head pub-2)');
    expect((singleThrown as Error).message).toContain('reopen interview (JOB_ASK_INVALID)');
    expect((singleThrown as Error).message).not.toContain('subject is not declared');

    const batchHost = makeStubHost({
      askBatch: true,
      onAskBatch: () => ({
        ok: false,
        error: { code: 'JOB_ASK_SUPERSEDED', message: 'subjects[1]: ask ask-2 is superseded; head pub-2' },
      }),
    });
    const batchOutcomes = await askDeclaredSubjects(batchHost.host, 'pub-1', sampleSubjects, true);
    expect(batchOutcomes).toEqual([
      { subject: sampleSubjects[1]!, status: 'refused', code: 'JOB_ASK_SUPERSEDED', message: 'ask ask-2 is superseded; head pub-2' },
    ]);
    let batchThrown: unknown;
    try { refuseAskOutcomes(batchOutcomes); } catch (error) { batchThrown = error; }
    expect(batchThrown).toMatchObject({ code: 'JOB_ASK_REFUSED' });
    expect((batchThrown as Error).message).toContain('reopen interview (JOB_ASK_SUPERSEDED: ask ask-2 is superseded; head pub-2)');
  });
});
