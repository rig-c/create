import { afterEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJobHost, type RecordPlanSubject } from '@rig-c/review/job-host';
import { checkProject } from '../src/check.ts';
import { askDeclaredSubjects, openCreateJob, openRecordPublication, reconcileCreateJob } from '../src/job-host.ts';
import { agentCall, readHostActsAndAsks } from '../src/job-acts.ts';
import { acknowledgePublication, enqueuePublication, JOB_BINDING_FILE, jobHash, jobHostStateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';
import { appendWithdrawalReceipt, buildDiscardActReceipt, matchesActProjectSource } from '../src/review-act.ts';
import { readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { CLI } from './helpers.ts';

const roots: string[] = [];
const recordBytes = (root: string): Buffer => readFileSync(join(root, 'project.json'));
const reviewer = { id: 'synthetic-owner', role: 'owner' as const };
const signoff = { kind: 'signoff', stage: 'plan-approved' } as const;
const legacyReopen = { kind: 'reopen', stage: 'interview' } as const;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
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

/** Seed a retained Review publication that predates removal of the Create writer. */
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
      expect(await askDeclaredSubjects(host, publication!.publicationId, subjects, false)).toEqual(
        subjects.map(subject => ({ subject, status: 'asked' })));
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

    const url = new URL(host.ownerUrl);
    const endpoint = url.origin + '/jobs/' + host.session.jobId + '/ui/';
    const headers = {
      origin: url.origin, 'X-Review-Capability': url.hash.slice('#cap='.length), 'content-type': 'application/json',
    };
    const post = async (route: string, body: object) => {
      const response = await fetch(endpoint + route, { method: 'POST', headers, body: JSON.stringify(body) });
      const payload = await response.json() as JsonObject;
      expect(response.ok, JSON.stringify(payload)).toBe(true);
      return obj(payload.value);
    };
    const { generation, publication } = host.session.status();
    const { publicationId, source: { sourceHash } } = publication!;
    const pageId = crypto.randomUUID();
    const { displayedNonce } = await post('displayed', { publicationId, pageId, sourceHash });
    const value = { stage: 'interview', words: '  Please correct the first synthetic answer.\r\n' };
    const exported = await post('acts', {
      publicationId, askId: asks[0]!.askId, pageId, displayedNonce, expectedGeneration: generation,
      submissionId: crypto.randomUUID(), kind: 'reopen', value,
    });
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
    expect(await openRecordPublication(root, host, undefined, true, Date.now())).toEqual(
      ['job: plan published', 'job: asked signoff plan-approved']);
    const { publication, generation } = host.session.status();
    expect(publication!.publicationId).not.toBe(oldId);
    expect(publication!.source).toMatchObject({ subjects: [signoff] });
    expect(await openRecordPublication(root, host, undefined, true, Date.now())).toEqual(
      ['job: plan already published', 'job: already asked signoff plan-approved']);
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

    const url = new URL(host.ownerUrl);
    const endpoint = url.origin + '/jobs/' + host.session.jobId + '/ui/';
    const headers = {
      origin: url.origin, 'X-Review-Capability': url.hash.slice('#cap='.length), 'content-type': 'application/json',
    };
    const post = async (route: string, body: object) => {
      const response = await fetch(endpoint + route, { method: 'POST', headers, body: JSON.stringify(body) });
      const payload = await response.json() as JsonObject;
      expect(response.ok, JSON.stringify(payload)).toBe(true);
      return obj(payload.value);
    };
    const { publication } = host.session.status();
    const { publicationId, source: { sourceHash } } = publication!;
    const pageId = crypto.randomUUID();
    const { displayedNonce } = await post('displayed', { publicationId, pageId, sourceHash });

    const signoffAsk = asks.find(ask => ask.subject.kind === 'signoff')!;
    const reopenAsk = asks.find(ask => ask.subject.kind === 'reopen')!;
    const signoffAct = await post('acts', {
      publicationId, askId: signoffAsk.askId, pageId, displayedNonce, expectedGeneration: host.session.status().generation,
      submissionId: crypto.randomUUID(), kind: 'signoff', value: { stage: 'plan-approved', decision: 'approved', words: 'Approve the synthetic plan.\n' },
    });
    const reopenAct = await post('acts', {
      publicationId, askId: reopenAsk.askId, pageId, displayedNonce, expectedGeneration: host.session.status().generation,
      submissionId: crypto.randomUUID(), kind: 'reopen', value: { stage: 'interview', words: 'Misclicked reopen.\n' },
    });

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
    expect(unknownAct.stderr).toContain('unknown-act-id');
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

    // A substantive field edit still makes the signoff stale.
    const ingest = ['signoff', 'plan-approved', root, '--from-review', String(signoffAct.actId)];
    const recordFile = join(root, 'project.json');
    const changed = Buffer.from(afterFirstBytes.toString().replace(/"name": "[^"]*"/, '"name": "Different synthetic project"'));
    expect(changed).not.toEqual(afterFirstBytes);
    writeFileSync(recordFile, changed);
    const stale = await cli(root, ingest);
    expect(stale.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
    expect(stale.exit).toBe(1);
    expect(recordBytes(root)).toEqual(changed);

    // Ledger-only control: an agent discard is valid evidence, but is not an owner withdrawal.
    const agentDiscard = {
      schema: 'rig-create/review-act@1', kind: 'discarded', jobId: host.session.jobId,
      actId: 'synthetic-agent-discard', at: saidAt, by: 'agent', reason: 'Retire finalized acts',
    };
    const ledgerEdit = appendWithdrawalReceipt(afterFirstBytes, agentDiscard);
    writeFileSync(recordFile, ledgerEdit);
    const staleLedger = await cli(root, ingest);
    expect(staleLedger.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
    expect(staleLedger.exit).toBe(1);
    expect(recordBytes(root).toString()).toBe(ledgerEdit);
    writeFileSync(recordFile, afterFirstBytes);

    // Ingest from the still-live publication and keep the withdrawal receipt.
    const ingested = await cli(root, ingest);
    expect(ingested.exit, ingested.stderr).toBe(0);
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
    const ingestedFirst = await cli(root, ingest);
    expect(ingestedFirst.exit, ingestedFirst.stderr).toBe(0);
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
