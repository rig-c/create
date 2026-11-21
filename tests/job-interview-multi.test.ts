import { afterEach, expect, test } from 'bun:test';
import type { JobOwnerHost } from '@rig-c/review/job-host';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { checkProject, collectItems } from '../src/check.ts';
import { interviewAnswerCommand, interviewOptionsCommand } from '../src/choice-writers.ts';
import { ingestedJobActs, jobActsText, pendingJobActs, pendingJobAsksForTarget, readHostActsAndAsks } from '../src/job-acts.ts';
import { refusePendingJobAsks } from '../src/job-close.ts';
import { listCreateJobActs, openCreateJob, openRecordPublication, publishPending, reconcileCreateJob } from '../src/job-host.ts';
import { enqueuePublication, failPublication, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';
import { fetchReviewAct, appendWithdrawalReceipt, buildDiscardActReceipt, reviewActTransport } from '../src/review-act.ts';
import { nextProject } from '../src/next.ts';
import type { JsonObject } from '../src/templates.ts';

const questions = ['rig_type', 'reference', 'seethrough'];
const chain = join(import.meta.dir, '../templates/example-chain');
const fixtures: { root: string; host?: JobOwnerHost }[] = [];
const bytes = (root: string) => readFileSync(join(root, 'project.json'));
const read = (root: string) => JSON.parse(bytes(root).toString('utf8')) as JsonObject;
const item = (root: string, question: string) => collectItems(read(root), { collection: null }).find(item => item.id === question)!;
const target = (question: string) => ({ kind: 'option-set' as const, questionId: question, setId: `chain-${question}` });

afterEach(() => {
  for (const { root, host } of fixtures.splice(0)) {
    host?.stop();
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

async function open(referenceSetId?: string, publish = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-multi-interview-')));
  const fixture: (typeof fixtures)[number] = { root };
  fixtures.push(fixture);
  cpSync(join(chain, 'checkpoints/0a-interview-options'), root, { recursive: true });
  const now = Math.max(EXAMPLE_NOW, Date.now() + 60_000);
  for (const question of [...questions.slice(1), 'assemble']) {
    const path = `evidence/interview/${question}.json`;
    cpSync(join(chain, path), join(root, path));
    interviewOptionsCommand([question, root, '--file', path], now);
  }
  // Complete the unrelated fourth interview question before this three-set publication.
  const assemble = 'evidence/interview/assemble.json';
  const words = join(root, 'assemble-words.txt');
  writeFileSync(words, 'Use the synthetic assembly choice.\n');
  interviewAnswerCommand(['assemble', root, '--set', assemble, '--sha256', jobHash(readFileSync(join(root, assemble))),
    '--by', 'user', '--owner-chat', words, '--said-at', new Date(now - 1_000).toISOString(), '--relayed-by', 'synthetic-agent',
    ...selections(root, 'assemble').flatMap(pick => ['--pick', `${pick.itemId}=${pick.optionId}`])], now);
  if (referenceSetId) {
    // Plant a pre-existing binding to exercise Review's question/set identity independently of the registration writer.
    const path = 'evidence/interview/reference.json';
    const file = join(root, path);
    const set = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    const setBytes = JSON.stringify({ ...set, id: referenceSetId });
    writeFileSync(file, setBytes);
    const project = read(root);
    const reference = collectItems(project, { collection: null }).find(item => item.id === 'reference')!;
    reference.record.pending_options = { path, sha256: jobHash(Buffer.from(setBytes)) };
    writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  }
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, now, undefined, true);
  fixture.host = host;
  if (publish) await openRecordPublication(root, host, questions, false, now);
  return { root, host, now };
}

function selections(root: string, question: string) {
  const path = join(root, `evidence/interview/${question}.json`);
  const set = JSON.parse(readFileSync(path, 'utf8')) as { asks: { id: string }[] };
  return set.asks.map(ask => ({ itemId: ask.id, optionId: 'keep', otherText: null }));
}

async function ownerPage(root: string, host: JobOwnerHost) {
  const status = host.session.status();
  const publication = status.publication!;
  const url = new URL(host.ownerUrl);
  const headers = { origin: url.origin, 'X-Review-Capability': url.hash.slice('#cap='.length), 'content-type': 'application/json' };
  const post = async (route: string, body: object) => {
    const response = await fetch(new URL(route, url), { method: 'POST', headers, body: JSON.stringify(body) });
    return await response.json() as { ok: boolean; value?: { displayedNonce: string; actId: string }; error?: { code: string } };
  };
  const pageId = randomUUID();
  const displayed = await post('ui/displayed', { publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash });
  expect(displayed.ok).toBe(true);
  let expectedGeneration = status.generation;
  return async (question: string) => {
    const ask = status.pending.find(entry => entry.subject.kind === 'interview-picks' && entry.subject.questionId === question)!;
    const result = await post('ui/acts', {
      publicationId: publication.publicationId, askId: ask.askId, pageId, expectedGeneration,
      displayedNonce: displayed.value!.displayedNonce, submissionId: randomUUID(), kind: 'interview-picks',
      value: { questionId: question, selections: selections(root, question), note: '' },
    });
    if (result.ok) expectedGeneration++;
    return result;
  };
}

async function fetchPicks(root: string, actId: string) {
  return (await fetchReviewAct({ ...reviewActTransport(root, actId), kind: 'interview-picks' })).bytes;
}

test('#558 ingests a ready subset atomically and republishes the exact remaining set against fresh project bytes', async () => {
  const sharedSetId = 'chain-rig_type';
  const { root, host, now } = await open(sharedSetId);
  const submit = await ownerPage(root, host);
  // Submit in reverse publication order so the first received act names the second set.
  const actIds = [(await submit('reference')).value!.actId, (await submit('rig_type')).value!.actId];
  const initial = await readHostActsAndAsks(host);
  expect(initial.acts.flatMap(act => act.kind === 'interview-picks' ? [[act.value.questionId, act.source.optionSet.id]] : []))
    .toEqual([['reference', sharedSetId], ['rig_type', sharedSetId]]);
  const args = ['interview-answer', '--batch', root, ...actIds.flatMap(id => ['--from-review', id])];
  // job acts offers no ingest for 2 of 3 sets; the explicit writer still accepts the subset.
  const listed = pendingJobActs(read(root), initial.acts, root);
  expect(listed.map(row => [row.command, row.waiting])).toEqual([[null, { received: 2, total: 3 }], [null, { received: 2, total: 3 }]]);
  expect(jobActsText({ acts: listed })).not.toContain('interview-answer');
  const fetched = new Map(await Promise.all(actIds.map(async id => [id, await fetchPicks(root, id)] as const)));
  const hooks = { fetch: ({ actId }: { actId: string }) => ({ bytes: fetched.get(actId)! }) };
  const original = bytes(root);
  const last = actIds[1]!;
  const valid = fetched.get(last)!;
  const altered = JSON.parse(valid);

  altered.publicationId = 'unrelated-publication';
  fetched.set(last, JSON.stringify(altered));
  expect(() => interviewAnswerCommand(args.slice(1), now, hooks)).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
  expect(bytes(root)).toEqual(original);
  altered.publicationId = initial.head;
  altered.value.selections[0].optionId = 'unknown-option';
  fetched.set(last, JSON.stringify(altered));
  expect(() => interviewAnswerCommand(args.slice(1), now, hooks)).toThrow(expect.objectContaining({ code: 'INTERVIEW_CHOICE_INVALID' }));
  expect(bytes(root)).toEqual(original);
  fetched.set(last, valid);

  expect(() => interviewAnswerCommand([...args.slice(1), '--from-review', last], now, hooks))
    .toThrow(expect.objectContaining({ code: 'JOB_OPTION_SET_DUPLICATE' }));
  expect(bytes(root)).toEqual(original);
  const unrelatedDrift = Buffer.concat([original, Buffer.from(' ')]);
  const file = join(root, 'project.json');
  writeFileSync(file, unrelatedDrift);
  expect(() => interviewAnswerCommand(args.slice(1), now, hooks)).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
  expect(bytes(root)).toEqual(unrelatedDrift);
  writeFileSync(file, original);

  const output = interviewAnswerCommand(args.slice(1), now, hooks);
  const partial = bytes(root);
  expect(JSON.parse(output)).toHaveLength(2);
  expect(interviewAnswerCommand(args.slice(1), now, hooks)).toBe(output);
  expect(bytes(root)).toEqual(partial);
  const after = await readHostActsAndAsks(host);
  expect(ingestedJobActs(read(root), after.asks, after.acts, root).map(row => row.question)).toEqual(questions.slice(0, 2));
  expect(pendingJobActs(read(root), after.acts, root)).toEqual([]);
  expect(host.session.status().pending.map(ask => ask.subject)).toEqual([{ kind: 'interview-picks', questionId: 'seethrough', setId: 'chain-seethrough' }]);
  expect((await submit('seethrough')).error?.code).toBe('JOB_RECORD_MOVED');
  await expect(refusePendingJobAsks(root, host.session.jobId, host, { kind: 'plan' })).rejects.toMatchObject({ code: 'JOB_ASK_PENDING' });
  expect(bytes(root)).toEqual(partial);

  await openRecordPublication(root, host, 'seethrough', false, now);
  const secondPublication = host.session.status().publication!;
  expect(secondPublication.publicationId).not.toBe(initial.head);
  expect(secondPublication.source.projectHash).toBe(jobHash(partial));
  const nextSubmit = await ownerPage(root, host);
  const freshId = (await nextSubmit('seethrough')).value!.actId;
  const freshBytes = await fetchPicks(root, freshId);
  const { acts } = await readHostActsAndAsks(host);
  const [only] = pendingJobActs(read(root), acts, root);
  expect(only!.args).toEqual(['interview-answer', 'seethrough', root, '--from-review', freshId]);
  interviewAnswerCommand(only!.args!.slice(1), now, { fetch: () => ({ bytes: freshBytes }) });
  expect(checkProject(root, undefined, { now }).refusals).toEqual([]);
  for (const question of questions) expect(item(root, question).record.pending_options).toBeUndefined();
  expect((read(root).review_acts as JsonObject[]).map(row => row.actId)).toEqual([...actIds, freshId]);
}, 30_000);

test('#558 owner chat settles only its own set, and a finalized stale act stays visible and blocks refresh', async () => {
  const { root, host, now } = await open();
  const submit = await ownerPage(root, host);
  const finalized = (await submit('rig_type')).value!.actId;
  const finalizeBytes = await fetchPicks(root, finalized);
  const binding = item(root, 'reference').record.pending_options as JsonObject;
  const words = join(root, 'owner-words.txt');
  writeFileSync(words, 'Use the retained synthetic reference choice.\n');
  interviewAnswerCommand(['reference', root, '--set', String(binding.path), '--sha256', String(binding.sha256),
    '--by', 'user', '--pick', 'reference=keep', '--owner-chat', words, '--said-at', new Date(now - 1_000).toISOString(), '--relayed-by', 'synthetic-agent'], now);
  const view = await readHostActsAndAsks(host);
  expect(pendingJobActs(read(root), view.acts, root).map(row => row.actId)).toEqual([finalized]);
  const before = bytes(root);
  expect(() => interviewAnswerCommand(['rig_type', root, '--from-review', finalized], now, { fetch: () => ({ bytes: finalizeBytes }) }))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
  expect(bytes(root)).toEqual(before);
  await expect(refusePendingJobAsks(root, host.session.jobId, host, target('seethrough')))
    .rejects.toMatchObject({ code: 'JOB_ASK_PENDING' });
  // The non-primary reference ask was settled by the exact bound owner-chat answer.
  expect(pendingJobAsksForTarget(read(root), view.asks, view.acts, root, { kind: 'plan' }).map(row => row.label))
    .toEqual(['interview-picks rig_type/chain-rig_type', 'interview-picks seethrough/chain-seethrough']);
  expect(bytes(root)).toEqual(before);
}, 30_000);

test('#785 staleInterviewAct accepts a withdraw-act discard receipt and still reports a changed record as stale', async () => {
  const { root, host, now } = await open();
  const submit = await ownerPage(root, host);
  const first = (await submit('rig_type')).value!.actId;
  const second = (await submit('reference')).value!.actId;
  const file = join(root, 'project.json');
  const receipt = buildDiscardActReceipt(host.session.jobId, first, {
    by: 'user',
    at: new Date(now).toISOString(),
    source: 'owner chat, relayed',
    owner_words: 'Withdraw the first synthetic interview pick.\n',
    said_at: new Date(now - 1_000).toISOString(),
    relayed_by: 'synthetic-agent',
  });
  const afterWithdraw = Buffer.from(appendWithdrawalReceipt(bytes(root), receipt));
  writeFileSync(file, afterWithdraw);

  const view = await readHostActsAndAsks(host);
  const start = async () => ({ ...host, reused: true, stop: () => {} }) as JobOwnerHost;
  const listed = await listCreateJobActs(root, start);
  expect(listed.acts.map(row => row.actId)).toEqual([second]);
  expect(jobActsText(listed)).not.toContain('--discard-acts');
  expect(JSON.stringify(nextProject(root, now))).not.toContain('--discard-acts');
  expect(pendingJobAsksForTarget(read(root), view.asks, view.acts, root, target('seethrough'), afterWithdraw).some(row => row.staleInterviewAct)).toBe(false);
  await expect(refusePendingJobAsks(root, host.session.jobId, host, target('seethrough'))).rejects.toMatchObject({
    code: 'JOB_ASK_PENDING',
    message: expect.not.stringContaining('--discard-acts'),
  });
  expect(bytes(root)).toEqual(afterWithdraw);

  // Negative control: a truly changed record is still reported stale.
  const changed = Buffer.concat([afterWithdraw, Buffer.from(' ')]);
  writeFileSync(file, changed);
  expect(pendingJobAsksForTarget(read(root), view.asks, view.acts, root, target('seethrough'), changed).some(row => row.staleInterviewAct)).toBe(true);
  await expect(refusePendingJobAsks(root, host.session.jobId, host, target('seethrough'))).rejects.toMatchObject({
    code: 'JOB_ASK_PENDING',
    message: expect.stringContaining('use job close --discard-acts <reason> --by agent to record the stale acts, then open the remaining sets on the current record'),
  });
}, 30_000);

test('#558 job acts holds a partial grouped page: no command, n/K, and --wait waits for every set', async () => {
  const { root, host, now } = await open();
  const submit = await ownerPage(root, host);
  // Reuse the in-process host for the strict attach; the fixture stops it.
  const start = async () => ({ ...host, reused: true, stop: () => {} }) as JobOwnerHost;
  const first = (await submit('rig_type')).value!.actId;
  const partial = await listCreateJobActs(root, start);
  expect(partial.acts.map(row => [row.actId, row.command, row.waiting])).toEqual([[first, null, { received: 1, total: 3 }]]);
  expect(jobActsText(partial)).toContain('waiting for 1/3 sets on this page');
  expect(jobActsText(partial)).not.toContain('interview-answer');
  await expect(listCreateJobActs(root, start, { timeoutMs: 300 })).rejects.toMatchObject({ code: 'JOB_NEXT_TIMEOUT' });
  await expect(listCreateJobActs(root, start, { timeoutMs: 300 })).rejects.toThrow('waiting for 1/3 sets');

  let settled = false;
  const waiting = listCreateJobActs(root, start, { timeoutMs: 10_000 }).finally(() => { settled = true; });
  const second = (await submit('reference')).value!.actId;
  await Bun.sleep(500);
  expect(settled).toBe(false);
  const third = (await submit('seethrough')).value!.actId;
  const complete = await waiting;
  const args = ['interview-answer', '--batch', root, ...[first, second, third].flatMap(id => ['--from-review', id])];
  expect(complete.acts.map(row => [row.args, row.waiting])).toEqual([[args, undefined], [args, undefined], [args, undefined]]);
  expect(jobActsText(complete).match(/interview-answer --batch/g)).toHaveLength(1);
  const fetched = new Map(await Promise.all([first, second, third].map(async id => [id, await fetchPicks(root, id)] as const)));
  interviewAnswerCommand(args.slice(1), now, { fetch: ({ actId }) => ({ bytes: fetched.get(actId)! }) });
  expect(checkProject(root, undefined, { now }).refusals).toEqual([]);
  for (const question of questions) expect(item(root, question).record.pending_options).toBeUndefined();
}, 30_000);

test('#558 JOB_GENERATION_STALE drops the retained generation, and the next reconcile re-scans the asks and publishes', async () => {
  const { root, host } = await open(undefined, false);
  const binding = readWriterBinding(root)!;
  const sets = questions.map(questionId => ({ questionId, setId: `chain-${questionId}` }));
  const pending = enqueuePublication(root, binding, { kind: 'option-set', ...sets[0]!, sets });
  pending.generation = host.session.status().generation;
  failPublication(root, pending, pending.failure);
  const publishes: { expectedGeneration: number }[] = [];
  let stale = true;
  const start = async () => ({ ...host, reused: true, stop: () => {}, ports: { ...host.ports, async handleJobApi(request: Request) {
    const body = await request.clone().json() as { verb: string; schema: string; expectedGeneration: number };
    if (body.verb === 'publish') {
      publishes.push({ expectedGeneration: body.expectedGeneration });
      if (stale) return Response.json({ schema: body.schema, ok: false, error: { code: 'JOB_GENERATION_STALE' } });
    }
    return host.ports.handleJobApi(request);
  } } }) as JobOwnerHost;
  const publish = (entry: Parameters<typeof publishPending>[0]) => publishPending(entry, undefined, undefined, start);
  const before = bytes(root);

  const refused = await reconcileCreateJob(root, publish).then(() => null, (error: unknown) => error);
  expect(refused).toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  expect((refused as Error).message).toContain('JOB_GENERATION_STALE');
  const [retained] = pendingPublications(root);
  expect(retained!.failure).toMatchObject({ code: 'JOB_GENERATION_STALE' });
  expect(retained!.generation).toBeUndefined();
  expect(bytes(root)).toEqual(before);

  stale = false;
  expect(await reconcileCreateJob(root, publish)).toBe(1);
  expect(pendingPublications(root)).toEqual([]);
  expect(publishes).toHaveLength(2);
  expect(host.session.status().pending.map(ask => ask.subject)).toEqual(sets.map(set => ({ kind: 'interview-picks', ...set })));
  expect(bytes(root)).toEqual(before);
}, 30_000);
