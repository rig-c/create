import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_RECORD_ACT_SCHEMA, parseRecordAct, startJobHost, type JobOwnerHost, type RecordPlanSubject } from '@rig-c/review/job-host';
import { checkProject } from '../src/check.ts';
import { openCreateJob, openRecordPublication, reconcileCreateJob } from '../src/job-host.ts';
import { agentCall, readHostActsAndAsks } from '../src/job-acts.ts';
import { acknowledgePublication, enqueuePublication, JOB_BINDING_FILE, jobHash, jobHostStateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';
import { appendWithdrawalReceipt, buildDiscardActReceipt, matchesActProjectSource } from '../src/review-act.ts';
import { readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { seedStoredSignoffAct } from './historical-review-fixture.ts';
import { CLI } from './helpers.ts';

const roots: string[] = [];
const recordBytes = (root: string): Buffer => readFileSync(join(root, 'project.json'));
const reviewer = { id: 'synthetic-owner', role: 'owner' as const };
const signoff = { kind: 'signoff', stage: 'plan-approved' } as const;
const legacyReopen = { kind: 'reopen', stage: 'interview' } as const;

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (existsSync(root)) rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

async function cli(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

function earlyPlan(): string {
  const checkpoint = 'example-chain/checkpoints/0b-plan-pending';
  const root = realpathSync(fixture(() => {}, checkpoint + '/project.json'));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates', checkpoint), root, {
    recursive: true, filter: path => !path.endsWith('/project.json'),
  });
  return root;
}

/** Review stores a job as one document; its writer and event appender are private (review#995 retired the reopen builders). */
interface ReviewJobDocument {
  generation: number; reviewer: { id: string; role: string };
  publications: Record<string, { retained: { source: unknown } }>;
  asks: Record<string, { askId: string; status: string }>; acts: Record<string, unknown>;
}
type ReviewSessionInternals = {
  jobId: string;
  store: { update(jobId: string, revision: null, operation: (row: { data: ReviewJobDocument }) => { data: ReviewJobDocument }): unknown };
  event(data: ReviewJobDocument, value: object): unknown;
};

/** One write to Review's stored job, appending events as Review does; nothing else changes. */
function writeReviewJob<T>(host: JobOwnerHost, write: (data: ReviewJobDocument, append: (value: object) => void, jobId: string) => T): T {
  const session = host.session as unknown as ReviewSessionInternals;
  let written!: T;
  session.store.update(session.jobId, null, ({ data }) => {
    data.generation++;
    written = write(data, value => { session.event(data, value); }, session.jobId);
    return { data };
  });
  return written;
}

/** Store a pending retired plan ask as Review stored it before retirement: bound to the plan's retained source. */
function seedPlanAsk(host: JobOwnerHost, publicationId: string, subject: RecordPlanSubject): string {
  return writeReviewJob(host, (data, append) => {
    const ask = { askId: crypto.randomUUID(), publicationId, subject, source: data.publications[publicationId]!.retained.source, status: 'pending' };
    data.asks[ask.askId] = ask;
    append({ type: 'pending', ask });
    return ask.askId;
  });
}

/** Store the owner's answered reopen act@4 for a seeded ask; Review's own stored-act decoder builds it. */
function seedReopenAct(host: JobOwnerHost, askId: string, words: string, actId: string = crypto.randomUUID()): JsonObject {
  return writeReviewJob(host, (data, append, jobId) => {
    const ask = data.asks[askId] as unknown as { publicationId: string; subject: { stage: string }; source: unknown };
    const act = parseRecordAct({
      schema: JOB_RECORD_ACT_SCHEMA, actId, jobId, askId, publicationId: ask.publicationId,
      authority: { actor: 'human', channel: 'review-ui', reviewer: { ...data.reviewer } },
      at: new Date().toISOString(), kind: 'reopen', source: ask.source, value: { stage: ask.subject.stage, words },
    }) as unknown as JsonObject;
    data.acts[String(act.actId)] = act;
    data.asks[askId] = { ...data.asks[askId]!, status: 'answered' };
    append({ type: 'act', act });
    return act;
  });
}

/** Store the owner's answered signoff act@4 for a seeded ask; Review's own stored-act decoder builds it. */
function seedSignoffAct(host: JobOwnerHost, askId: string, words: string, actId: string = crypto.randomUUID()): JsonObject {
  return writeReviewJob(host, (data, append, jobId) => {
    const ask = data.asks[askId] as unknown as { publicationId: string; subject: { stage: string }; source: unknown };
    const act = parseRecordAct({
      schema: JOB_RECORD_ACT_SCHEMA, actId, jobId, askId, publicationId: ask.publicationId,
      authority: { actor: 'human', channel: 'review-ui', reviewer: { ...data.reviewer } },
      at: new Date().toISOString(), kind: 'signoff', source: ask.source,
      value: { stage: ask.subject.stage, decision: 'approved', words },
    }) as unknown as JsonObject;
    data.acts[String(act.actId)] = act;
    data.asks[askId] = { ...data.asks[askId]!, status: 'answered' };
    append({ type: 'act', act });
    return act;
  });
}

/** Seed a retained Review publication that predates removal of the Create writer.
 * Review asks the subjects it still supports; retired reopen and signoff asks are seeded as Review stored them. */
async function openLegacyPlan(root: string, subjects: RecordPlanSubject[]) {
  const host = await openCreateJob(root, reviewer, Date.now(), options => startJobHost({
    ...options,
    readRecordPublished: ((request: RecordPublicationRequest) => {
      const context = readRecordPublished(request);
      return context.plan === null ? context : { ...context, subjects };
    }) as typeof readRecordPublished,
  }), true);
  try {
    const result = { kind: 'plan' as const };
    enqueuePublication(root, readWriterBinding(root)!, result);
    await reconcileCreateJob(root, async entry => {
      const requestId = crypto.randomUUID();
      const reply = await agentCall(host, { verb: 'publish', requestId, idempotencyKey: requestId,
        expectedGeneration: 0, result,
        freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
      });
      expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
      const { publication, generation } = host.session.status();
      acknowledgePublication(entry, publication!.publicationId, generation, requestId, subjects);
      for (const subject of subjects) {
        seedPlanAsk(host, publication!.publicationId, subject);
      }
    });
    return host;
  } catch (error) {
    host.stop();
    throw error;
  }
}

test('#674 a retained un-ingested reopen act reports the correction route and leaves project.json byte-identical', async () => {
  const root = earlyPlan();
  const host = await openLegacyPlan(root, [legacyReopen]);
  try {
    const original = recordBytes(root);
    const { asks } = await readHostActsAndAsks(host);
    expect(asks.map(ask => ask.subject)).toEqual([legacyReopen]);

    const value = { stage: 'interview', words: '  Please correct the first synthetic answer.\r\n' };
    const exported = seedReopenAct(host, asks[0]!.askId, value.words);
    expect(exported).toMatchObject({ schema: 'rig-review/act@4', kind: 'reopen', value });
    expect(recordBytes(root)).toEqual(original);

    const listed = await cli(root, ['job', 'acts', root, '--json']);
    expect(listed.exit, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).acts).toEqual([expect.objectContaining({
      actId: exported.actId, kind: 'reopen', args: null, command: null,
      unavailable: {
        code: 'REOPEN_ACT_RETIRED',
        message: expect.stringMatching(/interview-options and interview-answer, then re-sign/),
      },
    })]);
    expect(recordBytes(root)).toEqual(original);
    const closed = await cli(root, ['job', 'close', root]);
    expect(closed.exit).toBe(1);
    expect(closed.stderr).toStartWith('JOB_ACTS_PENDING:');
    expect(closed.stderr).toContain('REOPEN_ACT_RETIRED');
    expect(recordBytes(root)).toEqual(original);
    const checked = await cli(root, ['interview', '--check', root]);
    expect(checked.exit, checked.stderr + checked.stdout).toBe(0);
    expect(recordBytes(root)).toEqual(original);
  } finally { host.stop(); }
}, 30_000);

test('#639 open replaces an unchanged old plan head and reuses the new head on retry', async () => {
  const root = earlyPlan();
  const oldHost = await openLegacyPlan(root, [signoff, legacyReopen]);
  const original = recordBytes(root);
  const oldId = oldHost.session.status().publication!.publicationId;
  oldHost.stop();

  const host = await openCreateJob(root, reviewer, Date.now(), undefined, true);
  try {
    const lines = await openRecordPublication(root, host, undefined, true, Date.now());
    const { publication, generation } = host.session.status();
    expect(lines).toEqual([`job: plan published (publication ${publication!.publicationId})`]);
    expect(publication!.publicationId).not.toBe(oldId);
    expect(publication!.source).toMatchObject({ subjects: [] });
    expect(await openRecordPublication(root, host, undefined, true, Date.now())).toEqual(
      [`job: plan already published (publication ${publication!.publicationId})`]);
    expect(host.session.status()).toMatchObject({ generation, publication: { publicationId: publication!.publicationId } });
    expect(recordBytes(root)).toEqual(original);
  } finally { host.stop(); }
}, 30_000);

test('#677 job withdraw-act withdraws one pending act in place, leaves the job and other asks live, and refuses missing evidence, unknown and ingested act ids', async () => {
  const root = earlyPlan();
  const host = await openLegacyPlan(root, [signoff, legacyReopen]);
  try {
    const bindingPath = join(root, JOB_BINDING_FILE);
    const beforeBinding = readFileSync(bindingPath);
    const { asks } = await readHostActsAndAsks(host);
    expect(asks.map(ask => ask.subject)).toEqual([signoff, legacyReopen]);

    const signoffAsk = asks.find(ask => ask.subject.kind === 'signoff')!;
    const reopenAsk = asks.find(ask => ask.subject.kind === 'reopen')!;
    const signoffAct = seedSignoffAct(host, signoffAsk.askId, 'Approve the synthetic plan.\n');
    const sharedPrefix = String(signoffAct.actId).slice(0, 4);
    const nextChar = String(signoffAct.actId)[4] === 'a' ? 'b' : 'a';
    const reopenAct = seedReopenAct(host, reopenAsk.askId, 'Misclicked reopen.\n', `${sharedPrefix}${nextChar}${crypto.randomUUID().slice(5)}`);

    const listedBefore = JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts as { actId: string }[];
    expect(listedBefore.map(act => act.actId)).toEqual([String(signoffAct.actId), String(reopenAct.actId)]);

    const wordsFile = join(root, 'withdraw-words.txt');
    writeFileSync(wordsFile, 'Ignore the misclicked reopen act.\n');
    const saidAt = new Date(Date.now() - 1000).toISOString();
    const relay = ['--by', 'synthetic-owner', '--owner-chat', wordsFile, '--said-at', saidAt, '--relayed-by', 'synthetic-operator'];

    // 1. Missing owner-chat evidence refuses and leaves project.json byte-identical.
    const beforeProject = recordBytes(root);
    const missingChat = await cli(root, ['job', 'withdraw-act', String(reopenAct.actId), root, '--by', 'synthetic-owner']);
    expect(missingChat.exit).toBe(2);
    expect(missingChat.stderr).toContain('OWNER_CHAT_INVALID:');
    expect(recordBytes(root)).toEqual(beforeProject);
    expect(readFileSync(bindingPath)).toEqual(beforeBinding);

    const agentBy = await cli(root, ['job', 'withdraw-act', String(reopenAct.actId), root, '--by', 'agent', '--owner-chat', wordsFile, '--said-at', saidAt, '--relayed-by', 'synthetic-operator']);
    expect(agentBy.exit).toBe(1);
    expect(agentBy.stderr).toStartWith('OWNER_CHAT_INVALID:');
    expect(recordBytes(root)).toEqual(beforeProject);

    // 2. An unknown act id refuses by name and leaves project.json byte-identical.
    const unknownAct = await cli(root, ['job', 'withdraw-act', 'unknown-act-id', root, ...relay]);
    expect(unknownAct.exit).toBe(1);
    expect(unknownAct.stderr).toStartWith('JOB_ACT_NOT_PENDING:');
    expect(unknownAct.stderr).toContain(`act unknown-act-id is not pending on bound job ${host.session.jobId}; run rig-create job acts to list pending finalized acts`);
    expect(recordBytes(root)).toEqual(beforeProject);
    expect(readFileSync(bindingPath)).toEqual(beforeBinding);

    // 2b. A short prefix of one pending act refuses with JOB_ACT_NOT_PENDING, names the full pending act id, and leaves project.json byte-identical.
    const shortReopenId = String(reopenAct.actId).slice(0, 8);
    expect(String(signoffAct.actId).startsWith(shortReopenId)).toBe(false);
    const shortAct = await cli(root, ['job', 'withdraw-act', shortReopenId, root, ...relay]);
    expect(shortAct.exit).toBe(1);
    expect(shortAct.stderr).toStartWith('JOB_ACT_NOT_PENDING:');
    expect(shortAct.stderr).toContain(shortReopenId);
    expect(shortAct.stderr).toContain(String(reopenAct.actId));
    expect(recordBytes(root)).toEqual(beforeProject);
    expect(readFileSync(bindingPath)).toEqual(beforeBinding);

    // 2c. An ambiguous prefix shared by two pending acts refuses with JOB_ACT_NOT_PENDING, lists both full pending act ids, and leaves project.json byte-identical.
    const ambiguousAct = await cli(root, ['job', 'withdraw-act', sharedPrefix, root, ...relay]);
    expect(ambiguousAct.exit).toBe(1);
    expect(ambiguousAct.stderr).toStartWith('JOB_ACT_NOT_PENDING:');
    expect(ambiguousAct.stderr).toContain(String(signoffAct.actId));
    expect(ambiguousAct.stderr).toContain(String(reopenAct.actId));
    expect(recordBytes(root)).toEqual(beforeProject);
    expect(readFileSync(bindingPath)).toEqual(beforeBinding);

    // 3. Two pending acts; withdraw one: one discarded entry, the job still bound, the other act still pending.
    const withdrew = await cli(root, ['job', 'withdraw-act', String(reopenAct.actId), root, ...relay]);
    expect(withdrew.exit, withdrew.stderr).toBe(0);
    expect(withdrew.stdout.trim()).toBe(`job: withdrew act ${String(reopenAct.actId)}`);
    expect(readFileSync(bindingPath)).toEqual(beforeBinding);
    expect(host.session.status().status).not.toBe('closed');
    expect(pendingPublications(root)).toEqual([]);

    const afterWithdraw = JSON.parse(recordBytes(root).toString('utf8')) as JsonObject;
    expect(arr(afterWithdraw.review_acts)).toEqual([{
      schema: 'rig-create/review-act@1',
      kind: 'discarded',
      jobId: host.session.jobId,
      actId: reopenAct.actId,
      at: expect.any(String),
      by: 'synthetic-owner',
      owner_words: 'Ignore the misclicked reopen act.\n',
      said_at: saidAt,
      relayed_by: 'synthetic-operator',
      source: 'owner chat, relayed',
    }]);
    expect(checkProject(root, afterWithdraw, { now: Date.now(), readOnly: true }).refusals).toEqual([]);

    const listedAfter = JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts as { actId: string }[];
    expect(listedAfter.map(act => act.actId)).toEqual([String(signoffAct.actId)]);

    // Re-withdrawing the already withdrawn act refuses with REVIEW_ACT_DISCARDED and leaves project.json byte-identical.
    const afterFirstBytes = recordBytes(root);
    const rewithdraw = await cli(root, ['job', 'withdraw-act', String(reopenAct.actId), root, ...relay]);
    expect(rewithdraw.exit).toBe(1);
    expect(rewithdraw.stderr).toStartWith('REVIEW_ACT_DISCARDED:');
    expect(recordBytes(root)).toEqual(afterFirstBytes);

    // A substantive field edit still makes the signoff stale; the CLI --from-review route is retired.
    const ingest = ['signoff', 'plan-approved', root, '--from-review', String(signoffAct.actId)];
    const retiredSignoff = await cli(root, ingest);
    expect(retiredSignoff.exit).toBe(2);
    expect(retiredSignoff.stderr).toContain('SIGNOFF_FROM_REVIEW_REMOVED:');
    const recordFile = join(root, 'project.json');
    const changed = Buffer.from(afterFirstBytes.toString().replace(/"name": "[^"]*"/, '"name": "Different synthetic project"'));
    expect(changed).not.toEqual(afterFirstBytes);
    writeFileSync(recordFile, changed);
    expect(() => seedStoredSignoffAct(root, 'plan-approved', signoffAct, { now: Date.now(), checkProjectHash: true }))
      .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
    expect(recordBytes(root)).toEqual(changed);

    // Ledger-only control: an agent discard is valid evidence, but is not an owner withdrawal.
    const agentDiscard = {
      schema: 'rig-create/review-act@1', kind: 'discarded', jobId: host.session.jobId,
      actId: 'synthetic-agent-discard', at: saidAt, by: 'agent', reason: 'Retire finalized acts',
    };
    const ledgerEdit = appendWithdrawalReceipt(afterFirstBytes, agentDiscard);
    writeFileSync(recordFile, ledgerEdit);
    expect(() => seedStoredSignoffAct(root, 'plan-approved', signoffAct, { now: Date.now(), checkProjectHash: true }))
      .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
    expect(recordBytes(root).toString()).toBe(ledgerEdit);
    writeFileSync(recordFile, afterFirstBytes);

    // Ingest from the still-live publication and keep the withdrawal receipt.
    seedStoredSignoffAct(root, 'plan-approved', signoffAct, { now: Date.now(), checkProjectHash: true });
    const afterIngestBytes = recordBytes(root);
    const recorded = JSON.parse(afterIngestBytes.toString()) as JsonObject;
    expect(arr(recorded.review_acts).map(row => obj(row).actId)).toEqual([reopenAct.actId, signoffAct.actId]);
    expect(arr(recorded.signoffs).at(-1)).toMatchObject({
      stage: 'plan-approved', by: 'user', source: `review act ${host.session.jobId}/${String(signoffAct.actId)}`,
      verbatim: 'Approve the synthetic plan.\n',
    });
    const withdrawIngested = await cli(root, ['job', 'withdraw-act', String(signoffAct.actId), root, ...relay]);
    expect(withdrawIngested.exit).toBe(1);
    expect(withdrawIngested.stderr).toStartWith('REVIEW_ACT_REPLAY_CONFLICT:');
    expect(withdrawIngested.stderr).toContain(String(signoffAct.actId));
    expect(recordBytes(root)).toEqual(afterIngestBytes);
    expect(readFileSync(bindingPath)).toEqual(beforeBinding);

    expect(JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts).toEqual([]);

    // Reset the synthetic record to exercise the reverse operation order too.
    writeFileSync(recordFile, beforeProject);
    seedStoredSignoffAct(root, 'plan-approved', signoffAct, { now: Date.now(), checkProjectHash: true });
    const withdrewAfterIngest = await cli(root, ['job', 'withdraw-act', String(reopenAct.actId), root, ...relay]);
    expect(withdrewAfterIngest.exit, withdrewAfterIngest.stderr).toBe(0);
    expect(JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts).toEqual([]);
  } finally { host.stop(); }
}, 30_000);

test.each([
  '{"name":"synthetic","nested":{"review_acts":[]}}',
  '{ "review_acts" : [  ], "name": "synthetic" }\r\n',
  '{"review_acts":[{"kind":"example","quoted":"[],{}"}],"name":"synthetic"}\n',
])('#677 source binding walks only appended withdrawals over %s', original => {
  const jobId = 'synthetic-job';
  const at = '2026-11-20T12:00:00Z';
  const evidence = {
    by: 'owner', at, source: 'owner chat, relayed', owner_words: 'Withdraw this act.\n',
    said_at: at, relayed_by: 'operator',
  };
  const actFor = (bytes: string) => ({ jobId, source: { projectHash: jobHash(bytes) } });
  const first = appendWithdrawalReceipt(Buffer.from(original), buildDiscardActReceipt(jobId, 'first', evidence));
  const second = appendWithdrawalReceipt(Buffer.from(first), buildDiscardActReceipt(jobId, 'second', evidence));
  expect(matchesActProjectSource(actFor(original), second)).toBe(true);
  expect(matchesActProjectSource(actFor(first), second)).toBe(true);
  expect(matchesActProjectSource(actFor(first), second.replace('first', 'edited'))).toBe(false);
  expect(matchesActProjectSource(actFor(original), second.replace('"synthetic"', '"changed"'))).toBe(false);
});

function copyCheckpoint(checkpoint: string): string {
  const root = realpathSync(fixture(() => {}, `${checkpoint}/project.json`));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates', checkpoint), root, {
    recursive: true, filter: path => !path.endsWith('/project.json'),
  });
  return root;
}

const refusalCode = (stderr: string): string | undefined => /^([A-Z][A-Z0-9_]*):/m.exec(stderr.trim())?.[1];

test('#767 fake-clock reopen publishes a redrafted option set after advancing 1 s per CLI step', async () => {
  const root = copyCheckpoint('example-chain/checkpoints/0a-interview-options');
  let clock = Date.now();
  const nextInstant = () => {
    clock = Math.max(clock, Date.now()) + 1_000;
    return new Date(clock).toISOString();
  };
  const stepCli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'cli-at.ts'), nextInstant(), ...args], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };

  const hostProc = Bun.spawn([
    process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'cli-at.ts'), nextInstant(),
    'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'rig_type',
  ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = hostProc.stdout.getReader();
    const decoder = new TextDecoder();
    let initialOut = '';
    while (!/\njob: .*\n$/.test(initialOut)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      initialOut += decoder.decode(chunk.value);
    }
    reader.releaseLock();

    const setRel = 'evidence/interview/rig_type.json';
    const host = await openCreateJob(root, reviewer, clock, undefined, true);
    try {
      const { publication, pending } = host.session.status();
      expect(publication?.source).toMatchObject({
        selection: { kind: 'option-set', questionId: 'rig_type', setId: 'chain-rig_type' },
      });
      expect(pending).toEqual([]);
    } finally { host.stop(); }
    const wordsFile = join(root, 'rig-type-words.txt');
    writeFileSync(wordsFile, 'Use the synthetic rig type.\n');
    const saidAt = nextInstant();
    const answered = await stepCli([
      'interview-answer', 'rig_type', root,
      '--set', setRel,
      '--sha256', jobHash(readFileSync(join(root, setRel))),
      '--by', 'synthetic-owner',
      '--owner-chat', wordsFile,
      '--said-at', saidAt,
      '--relayed-by', 'synthetic-operator',
      '--pick', 'rig_type=keep',
    ]);
    expect(answered.exit, answered.stderr).toBe(0);

    // Advance 1 s per CLI step so the fake clock leads wall time by several seconds.
    const checked = await stepCli(['next', root, '--json']);
    expect(checked.exit, checked.stderr).toBe(0);
    const draftedAt = nextInstant();
    expect(Date.parse(draftedAt)).toBeGreaterThan(Date.now());
    const set = JSON.parse(readFileSync(join(root, setRel), 'utf8')) as JsonObject;
    set.id = 'redraft-rig_type';
    set.drafted_at = draftedAt;
    const redraftRel = 'evidence/interview/redraft-rig_type.json';
    writeFileSync(join(root, redraftRel), `${JSON.stringify(set, null, 2)}\n`);

    const redrafted = await stepCli(['interview-options', 'rig_type', root, '--file', redraftRel]);
    expect(redrafted.exit, redrafted.stderr).toBe(0);

    const reopened = await stepCli(['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'rig_type']);
    expect(reopened.exit, reopened.stderr).toBe(0);
    expect(pendingPublications(root)).toEqual([]);
    const binding = readWriterBinding(root);
    expect(binding).not.toBeNull();
    const checkHost = await openCreateJob(root, reviewer, clock, undefined, true);
    try {
      expect(checkHost.session.status().publication?.source).toMatchObject({
        selection: { kind: 'option-set', questionId: 'rig_type', setId: 'redraft-rig_type' },
      });
      const { asks } = await readHostActsAndAsks(checkHost);
      expect(asks).toEqual([]);
    } finally {
      checkHost.stop();
    }
  } finally {
    if (readWriterBinding(root)) await stepCli(['job', 'close', root]);
    if (hostProc.exitCode === null) hostProc.kill();
    await hostProc.exited;
  }
}, 30_000);

test('#767 a planted refusal on job open prints its named code on stderr, keeps the host serving, and exits 1 when stopped', async () => {
  const draftRoot = copyCheckpoint('example-chain/checkpoints/1-parts-verdict');
  writeFileSync(join(draftRoot, 'derived/drafts/chain/config.json'), '{}\n');
  const child = Bun.spawn([
    process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'cli-at.ts'), new Date().toISOString(),
    'job', 'open', draftRoot, '--reviewer', 'synthetic-owner', '--role', 'owner',
  ], { cwd: draftRoot, stdout: 'pipe', stderr: 'pipe' });
  try {
    const outReader = child.stdout.getReader();
    const errReader = child.stderr.getReader();
    const decoder = new TextDecoder();
    let stdout = '';
    while (!stdout.includes('\n')) {
      const chunk = await outReader.read();
      if (chunk.done) break;
      stdout += decoder.decode(chunk.value);
    }
    outReader.releaseLock();
    let stderr = '';
    while (!stderr.includes('\n')) {
      const chunk = await errReader.read();
      if (chunk.done) break;
      stderr += decoder.decode(chunk.value);
    }
    errReader.releaseLock();

    const ownerUrl = stdout.trim().split('\n')[0]!;
    expect(refusalCode(stderr)).toBe('JOB_PUBLICATION_INVALID');
    expect(child.exitCode).toBeNull();
    expect((await fetch(ownerUrl)).ok).toBe(true);

    child.kill('SIGINT');
    const exit = await child.exited;
    expect(exit).toBe(1);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 30_000);
