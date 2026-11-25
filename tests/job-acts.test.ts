import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkProject, collectItems, type Finding } from '../src/check.ts';
import { optionContext } from '../src/choices.ts';
import { plantLegacyReopen, fixture, retainSignoffs, arr, obj, step } from './fixtures.ts';
import { stageIndex } from '../src/stages.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import { nextCommand, nextProject } from '../src/next.ts';
import { agentCall, pendingJobActs, pendingJobAsksForTarget, jobActsText, shellWord, type PendingJobAct } from '../src/job-acts.ts';
import { amendCommand } from './clock.ts';
import type { PendingAskV3 } from '@rig-c/review/job-host';
import { acknowledgePublication, enqueuePublication, JOB_BINDING_FILE, writePrivateJson, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { draftPublicationResult, jobRuntimeExecArgv, prepareVersionIntent } from '../src/job-writer.ts';
import { listCreateJobActs, openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { assertNoPendingJobAsk } from '../src/job-close.ts';
import { currentJobIdentity, prepareDraftManifest, readPublished, readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { JOB_COMMENTS_ACT_SCHEMA, JOB_RECORD_ACT_SCHEMA, parseCommentsAct, parseRecordAct, startJobHost, type ActV3, type JobOwnerHost, type JobHostOptions, type RecordPlanSubject } from '@rig-c/review/job-host';
import { interviewAnswerCommand } from '../src/choice-writers.ts';
import { reviewActFindings } from '../src/review-act.ts';
import { sorted, stepHash } from '../src/step-hash.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { testClock } from './clock.ts';
import { EXAMPLE_NOW, EXAMPLE_REOPEN_AT } from '../scripts/example-time.ts';
import { clockedCli } from './helpers.ts';
import { directionPin, TIME_ONLY_BASIS } from './comment-anchor-shapes.ts';
const receipt = (row: object) => { if (process.env.JOB_ACTS_RECEIPT) appendFileSync(process.env.JOB_ACTS_RECEIPT, JSON.stringify(row) + '\n'); };
const scrub = (text: string, root: string) => text.replaceAll(root, '<synthetic>').replaceAll(join(import.meta.dir, '..'), '<create-checkout>').replace(/http:\/\/127\.0\.0\.1:\d+[^\s]*/g, '<owner-url>');
const WORDS = '  Synthetic owner review words.\r\n';
const roots: string[] = [];
const opened: { proc: Bun.Subprocess; root: string }[] = [];
const printedBins: string[] = [];

afterEach(async () => {
  for (const { proc, root } of opened.splice(0)) {
    if (existsSync(root) && readWriterBinding(root) && pendingPublications(root).length === 0) {
      await cli(root, ['job', 'close', root]);
    }
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
  for (const root of roots.splice(0)) {
    if (existsSync(root)) {
      rmSync(jobPrivateRoot(root), { recursive: true, force: true });
      rmSync(jobHostStateRoot(root), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
  for (const bin of printedBins.splice(0)) rmSync(bin, { recursive: true, force: true });
  testClock.reset();
});

const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
const write = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

function copy(checkpoint: string, edit?: (project: JsonObject) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "create-job-acts O'Brien-")));
  roots.push(root);
  const src = checkpoint === 'example-chain'
    ? join(import.meta.dir, '../templates/example-chain')
    : join(import.meta.dir, '../templates/example-chain/checkpoints', checkpoint);
  cpSync(src, root, { recursive: true });
  if (edit) {
    const project = read(root);
    edit(project);
    write(root, project);
  }
  return root;
}

async function cli(root: string, args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  const before = jobHash(readFileSync(join(root, 'project.json')));
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), ...clockedCli(), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  receipt({ command: ['rig-create', ...args.map(arg => scrub(arg, root))], exit, before, after: jobHash(readFileSync(join(root, 'project.json'))), stdout: scrub(stdout, root), stderr: scrub(stderr, root) });
  return { stdout, stderr, exit };
}

async function open(root: string, options: string[] = [], printed?: string) {
  let env = process.env;
  if (printed) {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'create-next-host-bin-')));
    printedBins.push(bin);
    writeFileSync(join(bin, 'rig-create'), '#!/bin/sh\nexec ' + [process.execPath, ...jobRuntimeExecArgv(), ...clockedCli()].map(quote).join(' ') + ' "$@"\n', { mode: 0o700 });
    env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  }
  const proc = Bun.spawn(printed ? ['sh', '-c', printed] : [process.execPath, ...jobRuntimeExecArgv(), ...clockedCli(), 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...options], {
    env,
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  opened.push({ proc, root });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!/\njob: .*\n$/.test(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  // Continue with the same reader: Response cannot wrap a disturbed stream.
  const remainingOutput = (async () => {
    let rest = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return rest;
        rest += decoder.decode(chunk.value);
      }
    } finally { reader.releaseLock(); }
  })();
  const lines = text.trim().split('\n');
  receipt({ command: printed ? scrub(printed, root) : ['rig-create', 'job', 'open', '<synthetic>', '--reviewer', 'synthetic-owner', '--role', 'owner', ...options], serving: true, lines: lines.slice(1) });
  return { url: new URL(lines[0]!), lines: lines.slice(1), proc, remainingOutput };
}

async function page(root: string, url: URL, expectedAsks = 2, requiredSubject?: string) {
  const jobId = /\/jobs\/([^/]+)\//.exec(url.pathname)![1]!;
  const receipts = join(jobPrivateRoot(root), 'acknowledged-publications');
  const expectedPublication = readdirSync(receipts)
    .map(file => JSON.parse(readFileSync(join(receipts, file), 'utf8')) as AcknowledgedPublication)
    .filter(receipt => receipt.jobId === jobId)
    .sort((a, b) => b.generation - a.generation)[0]!;
  expect(expectedPublication).toBeDefined();
  const capability = url.hash.replace('#cap=', '');
  const base = `${url.origin}/jobs/${jobId}/`;
  const headers = { origin: url.origin, 'X-Review-Capability': capability, 'content-type': 'application/json' };
  const abort = new AbortController();
  const response = await fetch(base + 'events', { headers, signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const events: JsonObject[] = [];
  const pending = () => {
    const head = events.filter(event => event.type === 'published').at(-1)?.publication as JsonObject | undefined;
    return {
      head,
      asks: events
        .filter(event => event.type === 'pending' && (event.ask as JsonObject).publicationId === head?.publicationId)
        .map(event => event.ask as JsonObject),
    };
  };
  // Reconnect replays history. Ask counts on an older head do not establish the current page.
  const ready = () => pending().head?.publicationId === expectedPublication.publicationId
    && pending().asks.length >= Math.max(expectedAsks, expectedPublication.subjects?.length ?? 0)
    && (requiredSubject === undefined || pending().asks.some(ask => obj(ask.subject).kind === requiredSubject));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !ready()) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      events.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
      if (ready()) break;
    }
  }
  abort.abort();
  const { head, asks } = pending();
  expect(head?.publicationId).toBe(expectedPublication.publicationId);
  const post = async (route: string, body: object) =>
    (await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })).json() as Promise<JsonObject>;
  const pageId = randomUUID();
  const displayed = await post('ui/displayed', {
    publicationId: head!.publicationId,
    pageId,
    sourceHash: (head!.source as JsonObject).sourceHash,
  });
  let expectedGeneration = Number(events.at(-1)!.generation);
  return {
    pageId,
    head: head!,
    asks,
    tryAct: async (subject: string, kind: string, value: object, extra: object = {}): Promise<JsonObject> => {
      const ask = asks.find(item => (item.subject as JsonObject).kind === subject)!;
      return await post('ui/acts', {
        publicationId: head!.publicationId,
        askId: ask.askId,
        pageId,
        displayedNonce: (displayed.value as JsonObject).displayedNonce,
        expectedGeneration,
        submissionId: randomUUID(),
        kind,
        value,
        ...extra,
      });
    },
    act: async (subject: string, kind: string, value: object, extra: object = {}): Promise<JsonObject> => {
      const ask = asks.find(item => (item.subject as JsonObject).kind === subject)!;
      const result = await post('ui/acts', {
        publicationId: head!.publicationId,
        askId: ask.askId,
        pageId,
        displayedNonce: (displayed.value as JsonObject).displayedNonce,
        expectedGeneration,
        submissionId: randomUUID(),
        kind,
        value,
        ...extra,
      });
      expect(result.error).toBeUndefined();
      expectedGeneration++;
      receipt({ command: ['POST', 'ui/acts'], exit: 0, act: result.value });
      const actValue = result.value as JsonObject;
      const actAt = Date.parse(String(actValue.at));
      if (Number.isFinite(actAt) && actAt > testClock.now()) testClock.set(actAt);
      return actValue;
    },
  };
}

function rigCapture(root: string, view: Awaited<ReturnType<typeof page>>, askId: string): object {
  const png = readFileSync(join(root, 'evidence/setup.png'));
  return {
    capture: {
      png: `data:image/png;base64,${png.toString('base64')}`,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      camera: 'fixed',
      framing: 'default',
      view: 'whole-rig',
      frame: 'setup',
      playing: false,
      binding: {
        publicationId: view.head.publicationId,
        instanceKey: view.head.instanceKey,
        sourceHash: (view.head.source as JsonObject).sourceHash,
        pageId: view.pageId,
        askId,
        drawGeneration: 1,
        playerGeneration: 0,
      },
    },
  };
}

function expectExit0(result: { stdout: string; stderr: string; exit: number }): void {
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: '' });
}


function snapshot(root: string): unknown {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name); const stat = lstatSync(path);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(path) : jobHash(readFileSync(path))];
  });
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function executePrinted(root: string, command: string) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-acts-bin-')));
  try {
    writeFileSync(join(bin, 'rig-create'), '#!/bin/sh\nexec ' + [process.execPath, ...jobRuntimeExecArgv(), ...clockedCli()].map(quote).join(' ') + ' "$@"\n', { mode: 0o700 });
    const before = jobHash(readFileSync(join(root, 'project.json')));
    const proc = Bun.spawn(['sh', '-c', command], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    receipt({ command: scrub(command, root), exit, before, after: jobHash(readFileSync(join(root, 'project.json'))), stdout: scrub(stdout, root), stderr: scrub(stderr, root) });
    expectExit0({ exit, stderr, stdout });
    return { stdout, stderr, exit };
  } finally { rmSync(bin, { recursive: true, force: true }); }
}

test('job acts discovers a finalized rig verdict; its exact quoted command also records the signature', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  expectExit0(await cli(root, ['advance', 'rig-review', root, '--json']));
  expect(JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts).toEqual([]);
  const view = await page(root, opening.url, 1);
  const ask = view.asks.find(item => (item.subject as JsonObject).kind === 'review-verdict')!;
  const verdict = await view.act('review-verdict', 'review-verdict', { stage: 'rig-review', verdict: 'approved', words: WORDS }, rigCapture(root, view, String(ask.askId)));
  const before = snapshot(root);
  const listed = await cli(root, ['job', 'acts', root, '--json']);
  expectExit0(listed);
  expect(snapshot(root)).toEqual(before);
  const result = JSON.parse(listed.stdout);
  expect(result.acts).toHaveLength(1);
  expect(result.acts[0]).toMatchObject({ actId: verdict.actId, publicationId: verdict.publicationId, kind: 'review-verdict', subject: 'rig v1 / rig-review', at: verdict.at,
    value: verdict.value, args: ['review', '1', root, '--from-review', verdict.actId] });
  const text = await cli(root, ['job', 'acts', root]);
  expectExit0(text); expect(text.stdout).toContain(`  verdict: approved\n  comment: ${WORDS}\n`); expect(text.stdout).toContain(result.acts[0].command);
  expect(snapshot(root)).toEqual(before);
  await executePrinted(root, result.acts[0].command);
  expect(JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts).toEqual([]);
  expect(read(root).stage).toBe('rig-review');
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({ stage: 'rig-review', source: `review act ${String(verdict.jobId)}/${String(verdict.actId)}` });
}, 30_000);

test('#756 job acts shows a pending act verdict and comments byte-equal to the host act value, and retains them after a refused review ingest', async () => {
  // The verdict is asked where it can be asked (rig-review, #754), and the owner acts on it. An owner-chat
  // amendment of a rigging-interview answer then moves the effective stage back, which is how a pilot's
  // pending rig verdict becomes un-ingestable.
  const root = copy('3-rig-review');
  const opening = await open(root, ['--rig', '1']);
  const view = await page(root, opening.url, 1);
  const ask = view.asks.find(item => (item.subject as JsonObject).kind === 'review-verdict')!;
  const verdict = await view.act('review-verdict', 'review-verdict', {
    stage: 'rig-review',
    verdict: 'approved',
    words: 'First synthetic owner comment.',
    general: ['Second synthetic owner comment.'],
  }, rigCapture(root, view, String(ask.askId)));
  const change = join(root, 'amend-bones.json');
  writeFileSync(change, '{"synthetic":"owner changed the bones answer"}');
  const amendWords = join(root, 'amend-words.txt');
  writeFileSync(amendWords, WORDS);
  expectExit0(await cli(root, ['amend', 'rigging-interview', root, '--kind', 'interview-answer', '--target', 'interview.waypoints[bones].guide',
    '--change', 'amend-bones.json', '--by', 'synthetic-owner', '--owner-chat', amendWords, '--said-at', testClock.iso(), '--relayed-by', 'synthetic-operator']));
  const projectBefore = readFileSync(join(root, 'project.json'));

  const listed = await cli(root, ['job', 'acts', root, '--json']);
  expectExit0(listed);
  const parsed = JSON.parse(listed.stdout) as { acts: PendingJobAct[] };
  expect(parsed.acts).toHaveLength(1);
  expect(parsed.acts[0]!.publicationId).toBe(String(verdict.publicationId));
  expect(JSON.stringify(parsed.acts[0]!.value)).toBe(JSON.stringify(verdict.value));

  const text = await cli(root, ['job', 'acts', root]);
  expectExit0(text);
  expect(text.stdout).toContain([
    `${String(verdict.actId)} review-verdict rig v1 / rig-review at ${String(verdict.at)}`,
    '  verdict: approved',
    '  comment: First synthetic owner comment.',
    '  comment: Second synthetic owner comment.',
    `  ${parsed.acts[0]!.command!}`,
  ].join('\n'));
  expect(readFileSync(join(root, 'project.json'))).toEqual(projectBefore);

  // After the amendment the ingest refuses; the pending act and its comments remain readable.
  const refused = await cli(root, ['review', '1', root, '--from-review', String(verdict.actId)]);
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toContain('REVIEW_ACT_SOURCE_STALE');
  expect(readFileSync(join(root, 'project.json'))).toEqual(projectBefore);

  const afterRefusalJson = await cli(root, ['job', 'acts', root, '--json']);
  expectExit0(afterRefusalJson);
  const afterParsed = JSON.parse(afterRefusalJson.stdout) as { acts: PendingJobAct[] };
  expect(afterParsed.acts).toHaveLength(1);
  expect(afterParsed.acts[0]!.publicationId).toBe(String(verdict.publicationId));
  expect(JSON.stringify(afterParsed.acts[0]!.value)).toBe(JSON.stringify(verdict.value));

  const afterRefusalText = await cli(root, ['job', 'acts', root]);
  expectExit0(afterRefusalText);
  expect(afterRefusalText.stdout).toBe(text.stdout);
  expect(readFileSync(join(root, 'project.json'))).toEqual(projectBefore);
}, 30_000);

async function serveStoredRecordAct(
  root: string,
  subject: RecordPlanSubject,
  kind: 'checkpoint' | 'signoff',
  value: JsonObject,
): Promise<{ host: JobOwnerHost; act: JsonObject }> {
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, testClock.now(), options => startJobHost({
    ...options,
    readRecordPublished: ((request: RecordPublicationRequest) => {
      const context = readRecordPublished(request, testClock.now());
      return context.plan === null ? context : { ...context, subjects: [subject] };
    }) as typeof readRecordPublished,
  }), true);
  try {
    enqueuePublication(root, readWriterBinding(root)!, { kind: 'plan' });
    await reconcileCreateJob(root, async entry => {
      const requestId = randomUUID();
      const reply = await agentCall(host, {
        verb: 'publish',
        requestId,
        idempotencyKey: requestId,
        expectedGeneration: 0,
        result: { kind: 'plan' },
        freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
      });
      expect(reply.ok).toBe(true);
      const { publication, generation } = host.session.status();
      acknowledgePublication(entry, publication!.publicationId, generation, requestId, [subject]);
    });
    const session = host.session as unknown as {
      jobId: string;
      store: { update(jobId: string, rev: null, fn: (row: { data: { generation: number; reviewer: { id: string; role: string }; publications: Record<string, { retained: { source: unknown } }>; asks: Record<string, unknown>; acts: Record<string, unknown> } }) => { data: unknown }): unknown };
      event(data: unknown, value: object): unknown;
    };
    const publicationId = host.session.status().publication!.publicationId;
    let act!: JsonObject;
    session.store.update(session.jobId, null, ({ data }) => {
      data.generation++;
      const askId = randomUUID();
      const source = data.publications[publicationId]!.retained.source;
      const ask = { askId, publicationId, subject, source, status: 'answered' };
      data.asks[askId] = ask;
      session.event(data, { type: 'pending', ask: { ...ask, status: 'pending' } });
      const actId = randomUUID();
      act = parseRecordAct({
        schema: JOB_RECORD_ACT_SCHEMA,
        actId,
        jobId: session.jobId,
        askId,
        publicationId,
        authority: { actor: 'human', channel: 'review-ui', reviewer: { ...data.reviewer } },
        at: testClock.iso(),
        kind,
        source,
        value,
      }) as unknown as JsonObject;
      data.generation++;
      data.acts[actId] = act;
      session.event(data, { type: 'act', act });
      return { data };
    });
    return { host, act };
  } catch (error) {
    host.stop();
    throw error;
  }
}

test('#789 job acts preserves checkpoint and signoff words and interview comments in text and JSON', async () => {
  const root = copy('1-parts-verdict', project => {
    project.stage = 'parts';
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex('parts'));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex('parts'));
    for (const step of arr(obj(project.plan).steps).map(obj)) {
      step.status = step.id === 'assemble' ? 'at-checkpoint' : step.id === 'seethrough' ? 'done' : 'pending';
      delete step.status_history;
    }
    for (const item of arr(obj(project.interview).waypoints).map(obj)) {
      if (['bones', 'meshes', 'constraints', 'turn', 'motion'].includes(String(item.id))) item.guide = null;
    }
  });
  const label = `["rig-review-comment/1","setup","reference","evidence/setup.png","${'a'.repeat(64)}",10,21,8,3]`;
  const words = `[${label}]\nFix this reference region.\n\n[general]\nApprove assemble checkpoint.`;
  const servedCheckpoint = await serveStoredRecordAct(root, { kind: 'checkpoint', checkpointId: 'assemble' }, 'checkpoint', {
    checkpointId: 'assemble',
    planStepId: 'assemble',
    outcome: 'pass',
    words,
  });
  try {
    const checkpoint = servedCheckpoint.act;
    expect(checkpoint.schema).toBe('rig-review/act@4');
    const projectBefore = readFileSync(join(root, 'project.json'));

    const listed = await cli(root, ['job', 'acts', root, '--json']);
    expectExit0(listed);
    const parsed = JSON.parse(listed.stdout) as { acts: PendingJobAct[] };
    expect(parsed.acts).toHaveLength(1);
    expect(parsed.acts[0]!.publicationId).toBe(String(checkpoint.publicationId));
    expect((parsed.acts[0]!.value as { words?: string }).words).toBe(words);
    expect(JSON.stringify(parsed.acts[0]!.value)).toBe(JSON.stringify(checkpoint.value));

    const text = await cli(root, ['job', 'acts', root]);
    expectExit0(text);
    expect(text.stdout).toContain([
      `${String(checkpoint.actId)} checkpoint checkpoint assemble / parts at ${String(checkpoint.at)}`,
      `  words: ${words}`,
      `  ${parsed.acts[0]!.command!}`,
    ].join('\n'));
    expect(readFileSync(join(root, 'project.json'))).toEqual(projectBefore);
  } finally {
    servedCheckpoint.host.stop();
  }

  // Record signoff act words also print byte-for-byte in text and JSON.
  const signoffRoot = copy('0b-plan-pending');
  const pointLabel = `["rig-review-comment/1","setup","reference","evidence/setup.png","${'b'.repeat(64)}",32,4,0,0]`;
  const signoffWords = `[${pointLabel}]\nApprove the plan picture point.`;
  const servedSignoff = await serveStoredRecordAct(signoffRoot, { kind: 'signoff', stage: 'plan-approved' }, 'signoff', {
    stage: 'plan-approved',
    decision: 'approved',
    words: signoffWords,
  });
  try {
    const signoff = servedSignoff.act;
    expect(signoff.schema).toBe('rig-review/act@4');
    const signoffJson = await cli(signoffRoot, ['job', 'acts', signoffRoot, '--json']);
    expectExit0(signoffJson);
    const signoffParsed = JSON.parse(signoffJson.stdout) as { acts: PendingJobAct[] };
    expect(signoffParsed.acts).toHaveLength(1);
    expect((signoffParsed.acts[0]!.value as { words?: string }).words).toBe(signoffWords);
    expect(JSON.stringify(signoffParsed.acts[0]!.value)).toBe(JSON.stringify(signoff.value));

    const signoffText = await cli(signoffRoot, ['job', 'acts', signoffRoot]);
    expectExit0(signoffText);
    expect(signoffText.stdout).toContain([
      `${String(signoff.actId)} signoff stage plan-approved at ${String(signoff.at)}`,
      `  words: ${signoffWords}`,
      `  ${signoffParsed.acts[0]!.command!}`,
    ].join('\n'));
  } finally {
    servedSignoff.host.stop();
  }

  // Review wraps legacy submission words in a comment, preserving the text byte-for-byte.
  const { root: picksRoot, view: picksView, value: picksValue } = await openMotionQuestion();
  const picksLabel = `["rig-review-comment/1","setup","reference","evidence/setup.png","${'c'.repeat(64)}",14,28,40,30]`;
  const picksWords = `[${picksLabel}]\nPin on the interview question image.`;
  const picksAct = await picksView.act('interview-picks', 'interview-picks', {
    ...picksValue,
    words: picksWords,
  });
  expect(picksAct.schema).toBe(JOB_COMMENTS_ACT_SCHEMA);
  const picksJson = await cli(picksRoot, ['job', 'acts', picksRoot, '--json']);
  expectExit0(picksJson);
  const picksParsed = JSON.parse(picksJson.stdout) as { acts: PendingJobAct[] };
  expect(picksParsed.acts).toHaveLength(1);
  expect(picksParsed.acts[0]!.value).toMatchObject({ comments: [{ text: picksWords }] });
  expect(JSON.stringify(picksParsed.acts[0]!.value)).toBe(JSON.stringify(picksAct.value));

  const picksText = await cli(picksRoot, ['job', 'acts', picksRoot]);
  expectExit0(picksText);
  expect(picksText.stdout).toContain([
    `${String(picksAct.actId)} interview-picks question motion at ${String(picksAct.at)}`,
    `  comment: ${picksWords}`,
    `  ${picksParsed.acts[0]!.command!}`,
  ].join('\n'));
  await executePrinted(picksRoot, picksParsed.acts[0]!.command!);
}, 30_000);

test('#760 a rig verdict ask and its un-ingested act on a rig the amendment superseded no longer hold a new ask', () => {
  testClock.set(EXAMPLE_NOW);
  const dir = fixture(() => {}, 'example-project.json');
  const rig = { kind: 'rig', version: 2 } as const;
  const ask = { askId: 'ask-rig', publicationId: 'pub-rig', status: 'pending', subject: { kind: 'review-verdict', stage: 'rig-review' }, source: { selector: rig } } as unknown as PendingAskV3;
  const act = { jobId: 'job', actId: 'act-rig', askId: 'ask-rig', publicationId: 'pub-rig', kind: 'review-verdict', source: { selector: rig },
    value: { stage: 'rig-review', verdict: 'approved' }, at: '2026-11-20T00:00:52.000Z' } as unknown as ActV3;
  const signoff = { askId: 'ask-sign', publicationId: 'pub-v1', status: 'pending', subject: { kind: 'signoff', stage: 'rig-review' }, source: { selector: { kind: 'rig', version: 1 } } } as unknown as PendingAskV3;
  const question = { kind: 'option-set', questionId: 'bones', setId: 'synthetic-set' } as const;
  const pending = () => pendingJobAsksForTarget(read(dir), [ask, signoff], [act], dir, question).map(row => row.label);
  const orphan = () => pendingJobAsksForTarget(read(dir), [], [act], dir, question).map(row => row.label);
  // Control: on the live rig the approved verdict holds the job until it is ingested.
  expect(pending()).toEqual(['review-verdict rig-review on rig v2', 'signoff rig-review on rig v1']);
  expect(orphan()).toEqual(['review-verdict (act-rig) on rig v2']);
  writeFileSync(join(dir, 'direction.txt'), 'Synthetic new direction.\n');
  amendCommand(['rigging-interview', dir, '--kind', 'interview-answer', '--target', 'bones', '--change', 'direction.txt', '--by', 'owner', '--verbatim-file', join(dir, 'direction.txt')]);
  expect(pending()).toEqual([]);
  expect(orphan()).toEqual([]);
  // The act stays readable for job acts.
  expect(pendingJobActs(read(dir), [act], dir).map(row => row.actId)).toEqual(['act-rig']);
});

test('missing and stopped hosts refuse without bootstrapping or changing producer files', async () => {
  const root = copy('3-rig-review');
  const before = snapshot(root);
  const missing = await cli(root, ['job', 'acts', root, '--json']);
  expect(missing.exit).toBe(1); expect(missing.stderr).toContain('JOB_HOST_ATTACH_REFUSED'); expect(snapshot(root)).toEqual(before);
  await open(root);
  const proc = opened.at(-1)!.proc; proc.kill('SIGTERM'); await proc.exited;
  const stopped = snapshot(root);
  const dead = await cli(root, ['job', 'acts', root]);
  expect(dead.exit).toBe(1); expect(dead.stderr).toContain('JOB_HOST_ATTACH_REFUSED'); expect(snapshot(root)).toEqual(stopped);
}, 20_000);

test('routing covers existing writers, exact replay identities and unmapped subjects without guesses', () => {
  const act = (actId: string, kind: string, source: object, value: object) => ({ jobId: 'job', actId, kind, source, value, at: '2026-11-01T00:00:00Z' } as unknown as ActV3);
  const root = "synthetic project's root";
  const actors = [
    act('rig', 'review-verdict', { selector: { kind: 'rig', version: 15 } }, { stage: 'rig-review' }),
    act('post', 'review-verdict', { selector: { kind: 'post', version: 19 } }, { stage: 'direction-review' }),
    act('parts', 'parts-verdict', { selector: { kind: 'draft', id: 'draft' } }, {}),
    act('pick', 'interview-picks', {}, { questionId: 'motion' }),
    act('checkpoint', 'checkpoint', {}, { planStepId: 'assemble' }),
    act('sign', 'signoff', {}, { stage: 'rig-review' }),
    act('image', 'review-verdict', { subject: 'image-set' }, { stage: 'image-review' }),
    act('removed', 'checkpoint', {}, { planStepId: 'gone' }),
  ];
  const rows = pendingJobActs({ plan: { steps: [{ id: 'assemble', phase: 'rig' }] }, review_acts: [{ jobId: 'another-job', actId: 'rig' }] }, [...actors, actors[0]!], root);
  expect(rows).toHaveLength(8);
  expect(rows.slice(0, 6).map(row => row.args)).toEqual([
    ['review', '15', root, '--from-review', 'rig'], ['review', '19', root, '--from-review', 'post'],
    ['parts-review', root, '--from-review', 'parts'], ['interview-answer', 'motion', root, '--from-review', 'pick'],
    ['signoff', 'parts', root, '--checkpoint', 'assemble', '--from-review', 'checkpoint'], ['signoff', 'rig-review', root, '--from-review', 'sign'],
  ]);
  for (const row of rows.slice(6)) { expect(row.command).toBeNull(); expect(row.unavailable?.code).toBe('JOB_ACTS_WRITER_UNAVAILABLE'); }
  const remaining = pendingJobActs({ review_acts: [{ jobId: 'job', actId: 'rig' }], signoffs: [{ source: 'review act job/sign' }] }, actors, root);
  expect(remaining.map(row => row.actId)).not.toContain('rig'); expect(remaining.map(row => row.actId)).not.toContain('sign');
});


test.each([false, true])('agent next pagination is shared and read failures remain visible (refused=%s)', async refused => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-acts-pages-')));
  roots.push(root);
  const jobId = 'synthetic-job'; const origin = 'http://127.0.0.1:1';
  writeFileSync(join(root, 'project.json'), JSON.stringify({ review_job: { jobId, origin }, signoffs: [], review_acts: [] }));
  const identity = currentJobIdentity({ root, stateDir: join(tmpdir(), randomUUID()), fingerprint: 'synthetic-paging', reviewer: { id: 'synthetic-owner', role: 'owner' } }, root);
  writePrivateJson(join(root, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId, origin, fetchCapability: 'synthetic-fetch', listenerIncarnation: 'synthetic-listener' }, true);
  const before = snapshot(root); const cursors: unknown[] = []; let stopped = false;
  const act = (id: string) => ({ jobId, actId: id, kind: 'signoff', at: '2026-11-01T00:00:00Z', source: {}, value: { stage: 'rig-review' } });
  const host = { reused: true, origin, session: { jobId, hostCredentials: () => ({ agent: 'synthetic-agent' }) }, stop: () => { stopped = true; },
    ports: { handleJobApi: async (request: Request) => {
      const body = await request.json() as { verb: string; after: unknown; waitMs: number };
      expect(body.verb).toBe('next'); expect(body.waitMs).toBe(0); cursors.push(body.after);
      if (refused) return Response.json({ ok: false, error: { code: 'JOB_CLOSED' } });
      const index = cursors.length - 1;
      return Response.json({ ok: true, value: { status: index < 2 ? 'events' : 'timeout', cursor: index === 0 ? 'one' : 'two',
        events: index < 2 ? [{ type: 'act', act: act(`act-${index}`) }] : [] } });
    } },
  } as unknown as JobOwnerHost;
  const start = async (options: JobHostOptions) => {
    expect(options.reuseOnly?.expected.jobId).toBe(jobId);
    return host;
  };
  if (refused) {
    try { await listCreateJobActs(root, start); throw Error('expected refusal'); }
    catch (error) { expect((error as { code?: string }).code).toBe('JOB_ACTS_READ_REFUSED'); }
  } else {
    const result = await listCreateJobActs(root, start);
    expect(result.acts.map(row => row.actId)).toEqual(['act-0', 'act-1']);
    expect(result).toMatchObject({ ingested: [], asked: 0 });
    expect(jobActsText({ ...result, acts: [] })).toBe('job: no un-ingested acts; none asked on the current publication');
    expect(cursors).toEqual([null, 'one', 'two']);
  }
  expect(stopped).toBe(true); expect(snapshot(root)).toEqual(before);
});


function riggingInterviewRoot(edit?: (project: JsonObject) => void): string {
  testClock.set(Date.now());
  const root = realpathSync(fixture(project => {
    project.stage = 'rigging-interview'; project.versions = []; project.scenes = []; delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex('rigging-interview'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    for (const step of arr(obj(project.plan).steps).map(obj)) if (!['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
    edit?.(project);
  }, 'example-project.json'));
  roots.push(root);
  return root;
}

/** Register a fresh pending option set for one rigging question; returns the page value that answers it. */
async function registerQuestion(root: string, question: string, setId = `pending-acts-${question}`) {
  const project = read(root); const item = collectItems(project, { collection: null }).find(item => item.id === question)!;
  const retained = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(retained.path)), 'utf8')) as JsonObject;
  set.id = setId; set.drafted_at = new Date(testClock.now() - 1000).toISOString();
  set.context = optionContext(project, 'rigging-interview', testClock.now() - 1000, root);
  const path = `evidence/interview/${setId}.json`;
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  expectExit0(await cli(root, ['interview-options', question, root, '--file', path]));
  const selections = (set.asks as JsonObject[]).map(ask => ({
    itemId: ask.id, optionId: obj((ask.options as JsonObject[])[0]).id, otherText: null as string | null,
  }));
  return { questionId: question, selections, note: WORDS };
}

async function openMotionQuestion(also: string[] = [], edit?: (project: JsonObject) => void) {
  const root = riggingInterviewRoot(edit);
  const value = await registerQuestion(root, 'motion');
  const others = [];
  for (const question of also) others.push(await registerQuestion(root, question));
  const opening = await open(root, ['--question', 'motion']); const view = await page(root, opening.url, 1);
  return { root, url: opening.url, view, value, others };
}

// Re-envelope the synthetic legacy picks fixture for the comment-closure tests.
function commentedPicksAct(act4: JsonObject, comments: { text: string; anchor?: JsonObject }[] = []): JsonObject {
  expect(act4.schema).toBe('rig-review/act@4');
  const { words: _, ...survey } = obj(act4.value);
  const act6 = { ...act4, schema: JOB_COMMENTS_ACT_SCHEMA, value: { ...survey, comments } };
  expect(parseCommentsAct(act6) as unknown).toEqual(act6);
  return act6;
}

const COMMENT_CLOSURE_INVALID = 'INTERVIEW_COMMENT_CLOSURE_INVALID';
const stalePlanStep = (id: string) => ({ code: 'PLAN_STEP_PREDATES_ANSWER', path: `plan.steps[${id}]` });
const findingPaths = (findings: Finding[]) => findings.map(({ code, path }) => ({ code, path }));
// The closure fixture records a newer bones guide. Both steps depend on that guide.
const STALE_BONES_PLAN = [stalePlanStep('bones'), stalePlanStep('constraints')];

function ingestClosureFixturePicks(
  root: string, value: Awaited<ReturnType<typeof registerQuestion>>, comments: { text: string }[] = [],
) {
  const project = read(root);
  const envelope = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/record-acts/picks.json'), 'utf8')) as JsonObject;
  const jobId = String(envelope.jobId);
  const actId = randomUUID();
  const origin = 'http://127.0.0.1:1';
  const identity = currentJobIdentity({ root, stateDir: jobHostStateRoot(root), fingerprint: 'synthetic-comment-closure',
    reviewer: { id: 'synthetic-owner', role: 'owner' } }, root);
  writePrivateJson(join(root, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId, origin,
    fetchCapability: 'synthetic-fetch', listenerIncarnation: 'synthetic-listener' }, true);
  project.review_job = { jobId, origin };
  write(root, project);

  const { questionId } = value;
  const item = collectItems(project, { collection: null }).find(item => item.id === questionId)!;
  const pending = obj(item.record.pending_options);
  const optionSetFile = { path: String(pending.path), sha256: String(pending.sha256) };
  const set = JSON.parse(readFileSync(join(root, optionSetFile.path), 'utf8')) as JsonObject;
  const setId = String(set.id);
  const record = { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) };
  const binding = {
    record, selection: { kind: 'option-set', questionId, setId }, inputs: [],
    optionSet: { id: setId, sha256: optionSetFile.sha256 }, optionSetFile, plan: null,
    subjects: [{ kind: 'interview-picks', questionId, setId }], files: [optionSetFile, record],
  };
  const at = testClock.iso();
  const act = commentedPicksAct({ ...envelope, actId, at, value,
    source: { sourceHash: jobHash(JSON.stringify({ schema: 'rig-review-job-record-source/1', ...binding })),
      projectHash: record.sha256, subject: 'option-set', ...binding },
  }, comments);
  const answer = JSON.parse(interviewAnswerCommand([questionId, root, '--from-review', actId], testClock.now(), {
    fetch: () => ({ bytes: JSON.stringify(act) }),
  })) as JsonObject;
  return { question: questionId, jobId, actId, at, answer };
}

async function commentClosureFixture() {
  const root = riggingInterviewRoot();
  const file = join(root, 'project.json');
  const reasonPath = join(root, 'closure-reason.txt');
  const reason = 'Synthetic handling explanation.';
  writeFileSync(reasonPath, reason);
  const sourceAt = EXAMPLE_NOW + 1000;
  testClock.set(sourceAt);
  const source = ingestClosureFixturePicks(root, await registerQuestion(root, 'bones'), [{ text: 'Synthetic owner comment.' }]);
  testClock.set(sourceAt + 2000);
  const args = [source.question, root, '--close-comment', '--job', source.jobId, '--act', source.actId, '--order', '1',
    '--by', 'agent', '--reason-file', reasonPath];
  const close = (question?: string, now = testClock.now()) => interviewAnswerCommand(
    question === undefined ? args : [...args, '--resolved-by-answer', question], now,
  );
  const refuses = (question?: string, now = testClock.now()) => {
    const before = readFileSync(file);
    expect(() => close(question, now)).toThrow(expect.objectContaining({ code: COMMENT_CLOSURE_INVALID }));
    expect(readFileSync(file)).toEqual(before);
  };
  const check = (project?: JsonObject) => checkProject(root, project, { now: testClock.now(), readOnly: true });
  return { root, file, source, reason, reasonPath, close, refuses, check };
}

async function recordClosureOwnerChatAnswer(root: string): Promise<JsonObject> {
  const value = await registerQuestion(root, 'motion');
  const args = ownerChatAnswerArgs(root, value).slice(1);
  return JSON.parse(interviewAnswerCommand(args, testClock.now())) as JsonObject;
}

test.each(['proposed answer', 'pending pick', 'unresolved Other'] as const)(
  '#856 refuses closure by %s and preserves project bytes', async evidence => {
    const { root, refuses } = await commentClosureFixture();
    const value = await registerQuestion(root, 'motion');
    const project = read(root);
    const item = collectItems(project, { collection: null }).find(item => item.id === 'motion')!;
    if (evidence === 'proposed answer') {
      const proposal = { ...obj(item.raw), by: 'agent', at: testClock.iso(), source: 'synthetic agent proposal' };
      item.record.guide = proposal;
      delete item.record.pending_options;
      write(root, project);
    } else if (evidence === 'pending pick') {
      expect(item.record.pending_options).toBeDefined();
    } else if (evidence === 'unresolved Other') {
      const [first, ...rest] = value.selections;
      const target = ingestClosureFixturePicks(root, { ...value, selections: [
        { ...first!, optionId: 'other', otherText: 'A synthetic proposal without a resolved value.' }, ...rest,
      ] });
      expect(target.answer.asks).toContainEqual(expect.objectContaining({ state: 'other-pending' }));
    }
    refuses('motion');
  },
);

test('#856 enforces source, resolving answer and closure time order', async () => {
  const { root, source, reason, close, refuses, check } = await commentClosureFixture();
  const target = ingestClosureFixturePicks(root, await registerQuestion(root, 'motion'));
  const sourceTime = Date.parse(source.at);
  const targetTime = Date.parse(target.at);
  expect(targetTime).toBeGreaterThan(sourceTime);
  refuses(undefined, sourceTime - 1);
  refuses('motion', targetTime - 1);
  const before = read(root);
  close('motion', targetTime);
  const recorded = read(root);
  expect(recorded.interview_comment_closures).toEqual([{
    jobId: source.jobId, actId: source.actId, question: source.question, order: 1, by: 'agent', at: target.at,
    reason, resolution: { kind: 'answer', question: target.question, jobId: target.jobId, actId: target.actId },
  }]);
  const { interview_comment_closures: closures, ...rest } = recorded;
  const closure = obj(arr(closures)[0]);
  expect(rest).toEqual(before);
  const stale = [...STALE_BONES_PLAN, stalePlanStep('motion')];
  expect(findingPaths(check().refusals)).toEqual(stale);
  expect(findingPaths(check({ ...recorded, interview_comment_closures: [{ ...closure, at: source.at }] }).refusals))
    .toEqual([...stale, { code: COMMENT_CLOSURE_INVALID, path: 'interview_comment_closures[0]' }]);
});

test('#856 refuses duplicate retained closures for the same comment', async () => {
  const { root, close, refuses, check } = await commentClosureFixture();
  close();
  expect(findingPaths(check().refusals)).toEqual(STALE_BONES_PLAN);
  const project = read(root);
  const closure = obj(arr(project.interview_comment_closures)[0]);
  project.interview_comment_closures = [closure, { ...closure }];
  write(root, project);
  expect(findingPaths(check().refusals)).toEqual([
    ...STALE_BONES_PLAN,
    { code: COMMENT_CLOSURE_INVALID, path: 'interview_comment_closures[0]' },
    { code: COMMENT_CLOSURE_INVALID, path: 'interview_comment_closures[1]' },
  ]);
  refuses();
});

test('#856 refuses a conflicting closure and preserves project bytes', async () => {
  const { root, reasonPath, close, refuses } = await commentClosureFixture();
  ingestClosureFixturePicks(root, await registerQuestion(root, 'motion'));
  close('motion');
  testClock.set(testClock.now() + 1000);
  refuses();
  writeFileSync(reasonPath, 'A conflicting explanation.\n');
  refuses('motion');
});

test('#856 exact closure replay preserves the original project bytes', async () => {
  const { root, file, close } = await commentClosureFixture();
  ingestClosureFixturePicks(root, await registerQuestion(root, 'motion'));
  const original = close('motion');
  const saved = readFileSync(file);
  testClock.set(testClock.now() + 1000);
  expect(close('motion')).toEqual(original);
  expect(readFileSync(file)).toEqual(saved);
});

test('#856 refuses an ambiguous resolving question with two eligible Review answers', async () => {
  const { root, file, close, refuses } = await commentClosureFixture();
  const first = ingestClosureFixturePicks(root, await registerQuestion(root, 'motion'));
  const beforeClosure = readFileSync(file);
  close('motion');
  writeFileSync(file, beforeClosure);

  testClock.set(testClock.now() + 2000);
  const second = ingestClosureFixturePicks(root, await registerQuestion(root, 'motion', 'pending-acts-motion-follow-up'));
  expect(Date.parse(second.at)).toBeGreaterThan(Date.parse(first.at));
  expect(reviewActFindings(read(root))).toEqual([]);
  refuses('motion');
});

test('#856 accepts a later owner-chat answer and binds its exact record', async () => {
  const { root, source, close, check } = await commentClosureFixture();
  const receipts = read(root).review_acts;
  const answer = await recordClosureOwnerChatAnswer(root);
  expect(answer).toMatchObject({ owner_words: 'Synthetic owner chat words.\n', relayed_by: 'synthetic-operator' });
  expect(Date.parse(String(answer.said_at))).toBeGreaterThan(Date.parse(source.at));
  expect(Date.parse(String(answer.at))).toBeGreaterThan(Date.parse(String(answer.said_at)));
  testClock.set(testClock.now() + 1000);
  close('motion');
  const recorded = read(root);
  expect(obj(arr(recorded.interview_comment_closures)[0]).resolution).toEqual({
    kind: 'answer', question: 'motion', answer_sha256: jobHash(JSON.stringify(sorted(answer))),
  });
  expect(recorded.review_acts).toEqual(receipts);
  expect(findingPaths(check().refusals)).toEqual([...STALE_BONES_PLAN, stalePlanStep('motion')]);
});

test('#856 refuses tampered retained owner-chat evidence and preserves project bytes', async () => {
  const { root, close, refuses, check } = await commentClosureFixture();
  await recordClosureOwnerChatAnswer(root);
  close('motion');
  const stale = [...STALE_BONES_PLAN, stalePlanStep('motion')];
  expect(findingPaths(check().refusals)).toEqual(stale);
  const project = read(root);
  const item = collectItems(project, { collection: null }).find(item => item.id === 'motion')!;
  obj(item.raw).owner_words = 'Different but still valid owner chat words.\n';
  write(root, project);

  expect(findingPaths(check().refusals)).toEqual([...stale, { code: COMMENT_CLOSURE_INVALID, path: 'interview_comment_closures[0]' }]);
  refuses('motion');
});

test('#846 single ingest routes exact comments and preserves survey, receipt and replay bytes', async () => {
  const { root, view, value } = await openMotionQuestion();
  const cropHash = 'b'.repeat(64);
  const nativeCropHash = 'c'.repeat(64);
  const crop = { path: `comment-crops/${cropHash}.png`, sha256: cropHash, width: 2, height: 3 };
  const nativeCrop = { path: `comment-crops/${nativeCropHash}.png`, sha256: nativeCropHash, width: 4, height: 5 };
  const comments: { text: string; anchor?: JsonObject }[] = [
    { text: '  General owner comment.\r\n' },
    { text: 'On the picture.', anchor: { name: 'reference.png' } },
    { text: 'Pinned here.\n끝', anchor: { name: 'reference.png', imageRegion: { x: 1, y: 2, width: 4, height: 5 }, crop, nativeCrop } },
  ];
  const act6 = await view.act('interview-picks', 'interview-picks', { ...value, comments });
  expect(parseCommentsAct(act6) as unknown).toEqual(act6);
  const act4 = { ...act6, schema: 'rig-review/act@4', value };
  const bytes = JSON.stringify(act6, null, 2) + '\n';
  const file = join(root, 'project.json');
  const before = readFileSync(file);
  const ingest = (bytes: string) => interviewAnswerCommand(['motion', root, '--from-review', String(act6.actId)], testClock.now(),
    { fetch: () => ({ bytes }) });
  const answer = ingest(bytes);
  const at6 = readFileSync(file);
  expect(ingest(bytes)).toBe(answer);
  expect(readFileSync(file)).toEqual(at6);
  expect(() => ingest(bytes.trimEnd())).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_REPLAY_CONFLICT' }));
  expect(readFileSync(file)).toEqual(at6);

  writeFileSync(file, before);
  expect(ingest(JSON.stringify(act4))).toBe(answer);
  const at4 = readFileSync(file);
  const project4 = read(root);
  expect(obj(arr(project4.review_acts).at(-1))).not.toHaveProperty('feedback_route');
  // Golden: only this receipt's act bytes, hash and route differ.
  const strip = (bytes: Buffer) => {
    const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
    const entry = obj(arr(project.review_acts).at(-1));
    delete entry.bytes;
    delete entry.sha256;
    delete entry.feedback_route;
    return JSON.stringify(project);
  };
  expect(strip(at6)).toBe(strip(at4));
  const project6 = JSON.parse(at6.toString('utf8')) as JsonObject;
  const index = arr(project6.review_acts).length - 1;
  const entry = obj(arr(project6.review_acts)[index]);
  expect(entry).toMatchObject({ kind: 'interview-picks', actId: act6.actId, bytes, sha256: jobHash(bytes) });
  expect(entry.feedback_route).toEqual({ question: 'motion', comments: comments.map((comment, i) => ({ order: i + 1, ...comment })) });
  expect(JSON.parse(answer).choice.note).toBe(value.note);
  expect(JSON.parse(answer).choice).not.toHaveProperty('comments');
  expect(JSON.parse(answer).verbatim).not.toContain('General owner comment.');

  const check = checkProject(root, project6, { now: testClock.now(), readOnly: true });
  expect(check.refusals).toEqual(checkProject(root, project4, { now: testClock.now(), readOnly: true }).refusals);
  expect(check.warnings.filter(finding => finding.code.startsWith('REVIEW_ANSWER_COMMENT'))).toEqual([]);
  const routed: Finding[] = [];
  expect(reviewActFindings(project6, undefined, routed)).toEqual([]);
  expect(routed).toEqual(comments.map(({ text, anchor }, i) => {
    const path = `review_acts[${index}].feedback_route.comments[${i}]`;
    return { code: 'REVIEW_ANSWER_COMMENT_ROUTED', path,
      message: `project.json.${path}: interview answer motion, owner comment ${i + 1}\n${text}${anchor === undefined ? '' : `\nAnchor: ${JSON.stringify(anchor)}`}` };
  }));
}, 30_000);

test('#846 the ledger refuses tampered routes and warns for missing routes at any act date', async () => {
  const { root, view, value } = await openMotionQuestion();
  const act = await view.act('interview-picks', 'interview-picks', { ...value, comments: [
    { text: 'First synthetic comment.' },
    { text: 'Second synthetic comment.', anchor: { name: 'reference.png' } },
  ] });
  const bytes = JSON.stringify(act);
  const file = join(root, 'project.json');
  const ingest = () => interviewAnswerCommand(['motion', root, '--from-review', String(act.actId)], testClock.now(),
    { fetch: () => ({ bytes }) });
  const answer = ingest();
  const project = read(root);
  const index = arr(project.review_acts).length - 1;
  const entryAt = (record: JsonObject) => obj(arr(record.review_acts)[index]);
  const route = obj(entryAt(project).feedback_route);
  const [first, second] = arr(route.comments).map(obj);
  for (const feedback_route of [
    null,
    { ...route, question: 'bones' },
    { ...route, comments: [second, first] },
    { ...route, comments: [{ ...first, order: 2 }, second] },
    { ...route, comments: [{ ...first, text: String(first.text) + ' ' }, second] },
    { ...route, comments: [first, { ...second, anchor: { name: 'other.png' } }] },
    { ...route, comments: [first] },
    { ...route, extra: true },
  ]) {
    const tampered = structuredClone(project);
    entryAt(tampered).feedback_route = feedback_route;
    const routed: Finding[] = [];
    expect(reviewActFindings(tampered, undefined, routed).map(finding => finding.code)).toEqual(['REVIEW_FEEDBACK_ROUTE_INVALID']);
    expect(routed).toEqual([]);
  }
  const tampered = structuredClone(project);
  entryAt(tampered).feedback_route = { ...route, comments: [] };
  write(root, tampered);
  const beforeRefusal = readFileSync(file);
  expect(ingest).toThrow(expect.objectContaining({ code: 'REVIEW_FEEDBACK_ROUTE_INVALID' }));
  expect(readFileSync(file)).toEqual(beforeRefusal);

  const unrouted = structuredClone(project);
  delete entryAt(unrouted).feedback_route;
  const check = checkProject(root, unrouted, { now: testClock.now(), readOnly: true });
  expect(check.warnings.map(finding => finding.code)).toContain('REVIEW_ANSWER_COMMENTS_UNROUTED');
  write(root, unrouted);
  const beforeReplay = readFileSync(file);
  expect(ingest()).toBe(answer);
  expect(readFileSync(file)).toEqual(beforeReplay);
  for (const at of ['2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
    const entry = entryAt(unrouted);
    entry.bytes = JSON.stringify({ ...JSON.parse(bytes), at });
    entry.sha256 = jobHash(String(entry.bytes));
    obj(collectItems(unrouted, { collection: null }).find(item => item.id === 'motion')!.raw).at = at;
    const warnings: Finding[] = [];
    const routed: Finding[] = [];
    expect(reviewActFindings(unrouted, warnings, routed)).toEqual([]);
    expect(warnings).toContainEqual({ code: 'REVIEW_ANSWER_COMMENTS_UNROUTED', path: `review_acts[${index}]`,
      message: expect.stringContaining('2 owner comments on interview answer motion retained, not routed') });
    expect(routed).toEqual([]);
  }
}, 30_000);

test('#860 act@6 interview feedback preserves a rig point and check refuses an edited anchor', async () => {
  const { root, view, value } = await openMotionQuestion();
  const png = readFileSync(join(root, 'evidence/scene-background.png'));
  const sha256 = jobHash(png);
  const sourceHash = obj(view.head.source).sourceHash;
  const modelHash = 'd'.repeat(64);
  const comment = {
    text: 'Review this point on the rig.',
    anchor: {
      id: 'synthetic-rig-point', frameStart: 3, frameEnd: 3, target: { kind: 'rig', name: 'synthetic-rig' }, category: 'quality',
      context: { comment: {
        schema: 'rig-review-comment/1', mode: 'animate', viewport: 'rig', frame: { index: 3, basis: 'producer' },
        time: 0.25, animation: null, sourceHash, modelHash, referenceHash: null, referenceId: null,
        camera: { space: 'world', center: { x: 0, y: 0 }, zoom: 1,
          viewport: { width: 100, height: 100 }, visible: { x: -50, y: -50, width: 100, height: 100 } },
        screen: { x: 50, y: 50, width: 0, height: 0 }, world: { x: 0, y: 0, width: 0, height: 0 }, slots: [],
        crop: { path: `comment-crops/${sha256}.png`, sha256, png: `data:image/png;base64,${png.toString('base64')}`,
          width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
        bookmark: { schema: 'rig-review-inspection/1', binding: { mode: 'single', sourceHash, rigs: [modelHash] },
          selection: { inspector: 'playback' } },
      } },
    },
  };
  const act = await view.act('interview-picks', 'interview-picks', { ...value, comments: [comment] });
  const decoded = parseCommentsAct(act);
  expect(decoded.kind).toBe('interview-picks');
  expect(decoded.value).toMatchObject({ comments: [comment] });
  expectExit0(await cli(root, ['interview-answer', 'motion', root, '--from-review', decoded.actId]));

  const project = read(root);
  const entry = obj(arr(project.review_acts).at(-1));
  expect(entry.feedback_route).toEqual({ question: 'motion', comments: [{ order: 1, ...comment }] });
  const check = () => checkProject(root, project, { now: testClock.now(), readOnly: true });
  expect(findingPaths(check().refusals)).toEqual([stalePlanStep('motion')]);

  const routed = obj(arr(obj(entry.feedback_route).comments)[0]);
  const mark = obj(obj(obj(routed.anchor).context).comment);
  obj(mark.world).x = 1;
  const after = check();
  expect(after.ok).toBe(false);
  expect(findingPaths(after.refusals)).toEqual([
    { code: 'REVIEW_FEEDBACK_ROUTE_INVALID', path: 'signoffs[3].evidence' },
    stalePlanStep('motion'),
    { code: 'REVIEW_FEEDBACK_ROUTE_INVALID', path: `review_acts[${arr(project.review_acts).length - 1}]` },
  ]);
}, 30_000);

test('#846 batch ingest routes comments atomically and omits the route for an empty act', async () => {
  const root = riggingInterviewRoot();
  const values = [await registerQuestion(root, 'motion'), await registerQuestion(root, 'bones')];
  const { url } = await open(root, ['--question', 'motion', '--question', 'bones']);
  const view = await page(root, url);
  const acts: JsonObject[] = [];
  for (const value of values) {
    const ask = view.asks.find(row => obj(row.subject).questionId === value.questionId)!;
    const comments = value.questionId === 'motion' ? [{ text: 'Synthetic motion feedback.' }] : [];
    acts.push(await view.act('interview-picks', 'interview-picks', { ...value, comments }, { askId: ask.askId }));
  }
  const [motion, bones] = acts;
  const motionId = String(motion.actId);
  const bonesId = String(bones.actId);
  const args = ['--batch', root, '--from-review', motionId, '--from-review', bonesId];
  const bytes = new Map(acts.map(act => [String(act.actId), JSON.stringify(act)]));
  const ingest = () => interviewAnswerCommand(args, testClock.now(), { fetch: ({ actId }) => ({ bytes: bytes.get(actId)! }) });
  const file = join(root, 'project.json');
  const before = readFileSync(file);
  const bonesBytes = bytes.get(bonesId)!;
  bytes.set(bonesId, JSON.stringify({ ...bones, at: new Date(testClock.now() + 1000).toISOString() }));
  expect(ingest).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
  expect(readFileSync(file)).toEqual(before);
  bytes.set(bonesId, bonesBytes);

  const answers = ingest();
  const after = readFileSync(file);
  const project = read(root);
  const [motionEntry, bonesEntry] = arr(project.review_acts).slice(-2).map(obj);
  expect(motionEntry).toMatchObject({ question: 'motion', bytes: bytes.get(motionId),
    feedback_route: { question: 'motion', comments: [{ order: 1, text: 'Synthetic motion feedback.' }] } });
  expect(bonesEntry).toMatchObject({ question: 'bones', bytes: bonesBytes, sha256: jobHash(bonesBytes) });
  expect(bonesEntry).not.toHaveProperty('feedback_route');
  expect(ingest()).toBe(answers);
  expect(readFileSync(file)).toEqual(after);
  const warnings: Finding[] = [];
  const routed: Finding[] = [];
  expect(reviewActFindings(project, warnings, routed)).toEqual([]);
  expect(warnings.filter(finding => finding.code.startsWith('REVIEW_ANSWER_COMMENT'))).toEqual([]);
  expect(routed.map(finding => finding.path)).toEqual([`review_acts[${arr(project.review_acts).length - 2}].feedback_route.comments[0]`]);
  bonesEntry.feedback_route = { question: 'bones', comments: [] };
  expect(reviewActFindings(project).map(finding => finding.code)).toEqual(['REVIEW_FEEDBACK_ROUTE_INVALID']);
}, 30_000);

test('merged record-mode host lists finalized picks and its printed writer command ingests them', async () => {
  const { root, view, value } = await openMotionQuestion();
  const act = await view.act('interview-picks', 'interview-picks', value);
  expect(act.schema).toBe(JOB_COMMENTS_ACT_SCHEMA);
  const before = snapshot(root); const listed = await cli(root, ['job', 'acts', root, '--json']); expectExit0(listed);
  expect(snapshot(root)).toEqual(before);
  const row = JSON.parse(listed.stdout).acts[0];
  expect(row.args).toEqual(['interview-answer', 'motion', root, '--from-review', act.actId]);
  const offered = nextProject(root).moves.filter(move => move.command?.includes('--question motion'));
  expect(offered).toHaveLength(1);
  await executePrinted(root, row.command);
  // #738: an empty pending list names the act already ingested for the current ask.
  const after = JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout);
  expect(after.acts).toEqual([]);
  expect(after.asked).toBe(1);
  expect(after.ingested).toEqual([{ askId: expect.any(String), actId: act.actId, kind: 'interview-picks', question: 'motion',
    subject: 'question motion', at: act.at, recorded: 'interview.waypoints[motion].guide' }]);
  const text = await cli(root, ['job', 'acts', root]); expectExit0(text);
  expect(text.stdout).toContain('job: no un-ingested acts; 1 already ingested for 1 current ask(s)');
  expect(text.stdout).toContain(`${act.actId} interview-picks question motion at ${act.at}\n  already recorded at interview.waypoints[motion].guide; no ingest needed`);
  const timeout = await cli(root, ['job', 'acts', root, '--wait', '--timeout-ms', '1']);
  expect(timeout.exit).toBe(3); expect(timeout.stderr).toContain('JOB_NEXT_TIMEOUT');
  expect(timeout.stderr).toContain(`1 already ingested for 1 current ask(s) (${act.actId} question motion -> interview.waypoints[motion].guide)`);
  // #738: next shows the guide as answered and offers no second publication of the question.
  const report = nextProject(root);
  expect(report.refusals.map(({ code, field }) => ({ code, path: field }))).toEqual([stalePlanStep('motion')]);
  expect(report.moves.filter(move => move.command?.includes('--question motion') || move.review_act?.question_id === 'motion')).toEqual([]);
  expect(report.answers!.find(answer => answer.question_id === 'motion')).toMatchObject({ field: 'interview.waypoints[motion].guide', at: act.at });
  expectExit0(await cli(root, ['plan', 'revise', 'motion', root, '--by', 'agent',
    '--reason', 'The motion definition still covers the recorded synthetic choices.']));
  expectExit0(await cli(root, ['interview', '--check', root]));
}, 30_000);

test('#737 a second --question refuses JOB_ASK_PENDING while the first ask is open, keeps its answer, and publishes after ingest', async () => {
  const { root, url, view, value, others: [bones] } = await openMotionQuestion(['bones']);
  // Re-opening the pending question itself is not a second ask.
  const same = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'motion']);
  expectExit0(same);
  expect(same.stdout.trimEnd().split('\n')).toContain(`job: option-set motion/pending-acts-motion already published (publication ${view.head.publicationId})`);
  const before = snapshot(root);
  const second = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'bones']);
  expect(second.exit).toBe(1);
  expect(second.stderr).toMatch(/^JOB_ASK_PENDING: /);
  expect(second.stderr).toContain('interview-picks motion/pending-acts-motion');
  expect(second.stderr).toContain(`rig-create job acts ${shellWord(root)} --wait`);
  expect(snapshot(root)).toEqual(before);

  // The first page still holds its ask: the owner's answer arrives as an act.
  const act = await view.act('interview-picks', 'interview-picks', value);
  const unIngested = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'bones']);
  expect(unIngested.exit).toBe(1);
  expect(unIngested.stderr).toMatch(/^JOB_ASK_PENDING: /);
  expect(snapshot(root)).toEqual(before);
  const listed = await cli(root, ['job', 'acts', root, '--json', '--wait']); expectExit0(listed);
  const row = JSON.parse(listed.stdout).acts[0] as PendingJobAct;
  expect(row).toMatchObject({ actId: act.actId, kind: 'interview-picks' });
  await executePrinted(root, row.command!);

  const next = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'bones']);
  expectExit0(next);
  const bonesView = await page(root, url, 1);
  expect(next.stdout.trimEnd().split('\n')).toContain(`job: option-set bones/pending-acts-bones published (publication ${bonesView.head.publicationId})`);
  const bonesAct = await bonesView.act('interview-picks', 'interview-picks', bones!);
  const after = JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts as PendingJobAct[];
  expect(after.map(row => row.actId)).toEqual([String(bonesAct.actId)]);
}, 60_000);

function ownerChatAnswerArgs(root: string, value: { questionId: string; selections: { itemId: Json; optionId: Json }[] }) {
  const binding = obj(collectItems(read(root), { collection: null }).find(item => item.id === value.questionId)!.record.pending_options);
  const words = join(root, `owner-words-${value.questionId}.txt`);
  writeFileSync(words, 'Synthetic owner chat words.\n');
  return ['interview-answer', value.questionId, root, '--set', String(binding.path), '--sha256', String(binding.sha256),
    '--by', 'user', '--owner-chat', words, '--said-at', new Date(testClock.now() - 500).toISOString(), '--relayed-by', 'synthetic-operator',
    ...value.selections.flatMap(row => ['--pick', `${String(row.itemId)}=${String(row.optionId)}`])];
}

test('#826 record-only writers preserve an open interview ask and its finalized answer until Review ingest', async () => {
  const { root, view, value } = await openMotionQuestion();
  const path = 'inputs/synthetic-source.txt';
  writeFileSync(join(root, path), 'Synthetic source bytes.\n');
  const add = ['input', 'add', path, root, '--origin', 'synthetic source'];
  const answer = ownerChatAnswerArgs(root, value);
  const setPath = 'evidence/interview/pending-acts-motion.json';
  const writers = [
    add,
    ['interview-options', 'motion', root, '--file', setPath],
    ['interview-options', '--adopt', root],
    answer,
    ['interview-answer', 'motion', root, '--set', setPath, '--sha256', jobHash(readFileSync(join(root, setPath))),
      '--by', 'user', '--from-review', '', ...value.selections.flatMap(row => ['--pick', `${row.itemId}=${row.optionId}`])],
    ['interview-decision', 'motion', root, '--by', 'agent', '--reasoning-file', join(root, 'owner-words-motion.txt')],
  ];
  const projectFile = join(root, 'project.json');
  const before = readFileSync(projectFile);
  const beforeJob = snapshot(jobPrivateRoot(root));
  const refuses = async () => {
    const beforeHost = snapshot(jobHostStateRoot(root));
    for (const args of writers) {
      const result = await cli(root, args);
      expect(result.exit, `${args[0]} ${args[1]}: ${result.stderr}`).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toStartWith('rig-create: JOB_ASK_PENDING: ');
      expect(result.stderr).toContain('interview-picks motion/pending-acts-motion on option-set motion/pending-acts-motion');
      expect(readFileSync(projectFile)).toEqual(before);
      expect(snapshot(jobPrivateRoot(root))).toEqual(beforeJob);
      expect(snapshot(jobHostStateRoot(root))).toEqual(beforeHost);
    }
  };
  await refuses();
  const act = await view.act('interview-picks', 'interview-picks', value);
  await refuses();
  expectExit0(await cli(root, ['interview-answer', 'motion', root, '--from-review', String(act.actId)]));
  expect(arr(read(root).review_acts).at(-1)).toMatchObject({ kind: 'interview-picks', actId: act.actId });
  expectExit0(await cli(root, add));
  expect(arr(read(root).inputs)).toContainEqual(expect.objectContaining({ path }));
}, 60_000);

test('#833 draft and owner-language writers refuse until the finalized Review answer is ingested', async () => {
  const { root, view, value } = await openMotionQuestion([], project => {
    // This draft tests the owner-ask gate without an unrelated ledger report.
    project.fix_ledger = [];
  });
  const base = 'derived/drafts/pending-ask';
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict/derived/drafts/chain'), join(root, base), { recursive: true });
  const draft = ['draft-rig', 'pending-ask', root, '--config', `${base}/config.json`,
    '--from', `${base}/out`, '--parts', `${base}/input`];
  const language = ['owner-language', 'set', 'ko', root];
  const projectFile = join(root, 'project.json');
  const before = readFileSync(projectFile);
  const beforeJob = snapshot(jobPrivateRoot(root));
  const refuses = async () => {
    const beforeHost = snapshot(jobHostStateRoot(root));
    for (const args of [draft, language]) {
      const result = await cli(root, args);
      expect(result.exit, result.stderr).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toStartWith('rig-create: JOB_ASK_PENDING: ');
      expect(result.stderr).toContain('interview-picks motion/pending-acts-motion on option-set motion/pending-acts-motion');
      expect(result.stderr).toContain(`rig-create job acts ${shellWord(root)} --wait`);
      expect(readFileSync(projectFile)).toEqual(before);
      expect(snapshot(jobPrivateRoot(root))).toEqual(beforeJob);
      expect(snapshot(jobHostStateRoot(root))).toEqual(beforeHost);
    }
  };
  await refuses();
  const act = await view.act('interview-picks', 'interview-picks', value);
  await refuses();
  expectExit0(await cli(root, ['interview-answer', 'motion', root, '--from-review', String(act.actId)]));
  expectExit0(await cli(root, language));
  expectExit0(await cli(root, draft));
  const project = read(root);
  expect(obj(project.owner).language).toBe('ko');
  expect(arr(project.drafts)).toContainEqual(expect.objectContaining({ id: 'pending-ask' }));
  expect(arr(project.review_acts).at(-1)).toMatchObject({ kind: 'interview-picks', actId: act.actId });
}, 60_000);

test.each(['matching', 'different'])('#737 a %s owner-chat answer is compared against the retained ask binding', async binding => {
  const { root, value, view } = await openMotionQuestion();
  const [ask] = view.asks as unknown as PendingAskV3[];
  // Retain the ask for the classifier control and exercise the writers on the unbound record.
  expectExit0(await cli(root, ['job', 'close', root]));
  expect(readWriterBinding(root)).toBeNull();
  const source = 'inputs/unbound-source.txt';
  writeFileSync(join(root, source), 'Synthetic unbound source.\n');
  expectExit0(await cli(root, ['input', 'add', source, root, '--origin', 'synthetic source']));
  expect(arr(read(root).inputs)).toContainEqual(expect.objectContaining({ path: source }));
  if (binding === 'different') {
    const shown = JSON.parse(readFileSync(join(root, 'evidence/interview/pending-acts-motion.json'), 'utf8')) as JsonObject;
    shown.id = 'pending-acts-motion-chat'; shown.drafted_at = new Date(testClock.now() - 900).toISOString();
    const path = 'evidence/interview/pending-acts-motion-chat.json';
    writeFileSync(join(root, path), JSON.stringify(shown, null, 2) + '\n');
    expectExit0(await cli(root, ['interview-options', 'motion', root, '--file', path]));
  }
  expectExit0(await cli(root, ownerChatAnswerArgs(root, value)));
  const pending = pendingJobAsksForTarget(read(root), [ask!], [], root, { kind: 'record-only' });
  expect(pending.map(row => row.label)).toEqual(binding === 'matching' ? []
    : ['interview-picks motion/pending-acts-motion on option-set motion/pending-acts-motion']);
}, 60_000);

test('#558 next at the rigging interview groups the question loop and prints one batch ingest', async () => {
  const root = riggingInterviewRoot();
  for (const question of ['motion', 'bones']) await registerQuestion(root, question);
  const { moves } = nextProject(root);
  expect(moves.filter(move => move.review_act?.kind === 'interview-picks').map(move => move.review_act!.question_id)).toEqual(['bones', 'motion']);
  const commands = moves.filter(move => move.role === 'agent' && move.command);
  const workflow = commands.filter(move => move.command!.startsWith('rig-create job ') || move.command!.includes('--from-review'));
  expect(workflow.map(move => move.command)).toEqual([
    `rig-create job open ${shellWord(root)} --questions --reviewer '<reviewer>' --role owner`,
    `rig-create job acts ${shellWord(root)} --json --wait`,
    `rig-create interview-answer --batch ${shellWord(root)} --from-review '<actId for bones>' --from-review '<actId for motion>'`,
  ]);
  expect(workflow[0]!.act).toContain('rigging-interview question loop');
  expect(workflow[1]!.act).toContain('--wait keeps waiting until every set has submitted');
  expect(workflow[2]!.act).toContain('JOB_ASK_PENDING');
}, 30_000);

test.each([
  { label: '--draft', selector: ['--draft', 'chain'], expected: /\njob: draft chain published \(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)\n/ },
  { label: '--rig', selector: ['--rig', '1'], expected: /\njob: rig v1 published \(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)\n/ },
])('#740 job open $label refuses JOB_ASK_PENDING while an interview ask is open, keeps its answer, and publishes after ingest', async ({ selector, expected }) => {
  testClock.set(Date.now());
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging-interview';
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('rigging-interview'));
    for (const step of arr(obj(project.plan).steps).map(obj).filter(step => ['bones', 'meshes', 'constraints', 'motion'].includes(String(step.id)))) {
      step.status = 'pending'; delete step.status_history;
    }
  });
  const value = await registerQuestion(root, 'motion');
  const opening = await open(root, ['--question', 'motion']);
  const view = await page(root, opening.url, 1);
  const before = snapshot(root);
  const beforePrivate = snapshot(jobPrivateRoot(root));
  const beforeJobState = snapshot(jobHostStateRoot(root));

  const refused = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...selector]);
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toMatch(/^JOB_ASK_PENDING: /);
  expect(refused.stderr).toContain('interview-picks motion/pending-acts-motion on option-set motion/pending-acts-motion');
  expect(refused.stderr).toContain(`rig-create job acts ${shellWord(root)} --wait`);
  expect(snapshot(root)).toEqual(before);
  expect(snapshot(jobPrivateRoot(root))).toEqual(beforePrivate);
  expect(snapshot(jobHostStateRoot(root))).toEqual(beforeJobState);

  const act = await view.act('interview-picks', 'interview-picks', value);
  const beforeUnIngestedJobState = snapshot(jobHostStateRoot(root));
  const unIngested = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...selector]);
  expect(unIngested.exit).toBe(1);
  expect(unIngested.stderr).toMatch(/^JOB_ASK_PENDING: /);
  expect(snapshot(root)).toEqual(before);
  expect(snapshot(jobPrivateRoot(root))).toEqual(beforePrivate);
  expect(snapshot(jobHostStateRoot(root))).toEqual(beforeUnIngestedJobState);

  const listed = await cli(root, ['job', 'acts', root, '--json', '--wait']);
  expectExit0(listed);
  const row = JSON.parse(listed.stdout).acts[0] as PendingJobAct;
  expect(row).toMatchObject({ actId: act.actId, kind: 'interview-picks' });
  await executePrinted(root, row.command!);

  const published = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...selector]);
  expectExit0(published);
  expect(published.stdout).toMatch(expected);
}, 60_000);

test('#740 a draft republished over an unanswered earlier-draft ask publishes while an un-ingested earlier-draft act refuses JOB_ASK_PENDING', async () => {
  testClock.set(EXAMPLE_REOPEN_AT);
  const root = copy('1-parts-verdict');
  const first = nextProject(root, testClock.now());
  await executePrinted(root, first.moves.find(move => move.command?.startsWith('rig-create structure-snapshot'))!.command!);
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expectExit0(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']));
  await executePrinted(root, nextProject(root, testClock.now()).moves.find(move => move.command?.startsWith('rig-create advance parts-review'))!.command!);

  cpSync(join(root, 'derived/drafts/chain'), join(root, 'derived/drafts/next'), { recursive: true });
  expectExit0(await cli(root, ['draft-rig', 'next', root, '--config', 'derived/drafts/next/config.json', '--from', 'derived/drafts/next/out', '--parts', 'derived/drafts/next/input']));
  expectExit0(await cli(root, ['structure-snapshot', root, '--draft', 'next']));

  const opening = await open(root, ['--draft', 'chain']);
  const firstView = await page(root, opening.url, 1, 'parts-verdict');
  expect(opening.lines).toEqual([`job: draft chain published (publication ${firstView.head.publicationId})`, 'job: asked parts-verdict chain']);

  // Unanswered earlier-draft ask allows the replacement draft to publish over it.
  const republished = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--draft', 'next']);
  expectExit0(republished);
  expect(republished.stdout).toContain('job: asked parts-verdict next');

  // Once the owner answers a draft ask, an un-ingested act refuses another draft publication.
  const nextView = await page(root, opening.url, 1, 'parts-verdict');
  expect(republished.stdout.trimEnd().split('\n')).toContain(`job: draft next published (publication ${nextView.head.publicationId})`);
  await nextView.act('parts-verdict', 'parts-verdict', { verdict: 'approved', issues: [], words: WORDS });
  const before = snapshot(root);
  const refused = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--draft', 'chain']);
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toMatch(/^JOB_ASK_PENDING: .*parts-verdict next on draft next/);
  expect(snapshot(root)).toEqual(before);
}, 60_000);

test('#698 wait wakes on a finalized pick and reuses the strict attach without timer re-listing', async () => {
  const { root, url, view, value } = await openMotionQuestion();
  const before = readFileSync(join(root, 'project.json'));
  const requests: { after: string | null; waitMs: number }[] = [];
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const start = async (options: JobHostOptions): Promise<JobOwnerHost> => {
    expect(options.reuseOnly).toBeDefined();
    const attached = await startJobHost(options);
    return { ...attached, ports: { ...attached.ports, async handleJobApi(request) {
      const body = await request.clone().json() as { verb: string; after: string | null; waitMs: number };
      expect(body.verb).toBe('next');
      expect(request.headers.get('authorization')).toBe(`Bearer ${attached.session.hostCredentials().agent}`);
      requests.push({ after: body.after, waitMs: body.waitMs });
      if (body.waitMs > 0) entered.resolve();
      return attached.ports.handleJobApi(request);
    } } };
  };
  const waiting = listCreateJobActs(root, start, { timeoutMs: 5_000, signal: controller.signal });
  try {
    await Promise.race([entered.promise, waiting]);
    const beforeWait = requests.slice();
    expect(beforeWait.map(request => request.waitMs === 0)).toEqual([true, true, false]);
    expect(beforeWait[2]!.after).toBe(beforeWait[1]!.after);
    expect(beforeWait[2]!.after).not.toBeNull();

    const refused = await view.tryAct('interview-picks', 'interview-picks', value, { displayedNonce: '0'.repeat(64) });
    expect(obj(refused.error).code).toBe('JOB_DISPLAY_MISMATCH');
    await page(root, url, 1);
    await Bun.sleep(600);
    expect(requests).toEqual(beforeWait);

    const act = await view.act('interview-picks', 'interview-picks', value);
    const result = await waiting;
    expect(result.acts).toHaveLength(1);
    expect(result.acts[0]).toMatchObject({ actId: act.actId, kind: 'interview-picks' });
    expect(requests.slice(beforeWait.length).map(request => request.waitMs)).toEqual([0, 0]);

    const pending = await cli(root, ['job', 'acts', '--wait', '--timeout-ms', '1', '--json']);
    expectExit0(pending);
    expect(JSON.parse(pending.stdout)).toEqual(result);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    await executePrinted(root, result.acts[0]!.command!);

    const ingested = readFileSync(join(root, 'project.json'));
    const timeout = await cli(root, ['job', 'acts', '--wait', '--timeout-ms', '300', '--json']);
    expect(timeout.exit).toBe(3);
    expect(timeout.stderr).toContain('JOB_NEXT_TIMEOUT');
    expect(timeout.stdout).toBe('');
    expect(readFileSync(join(root, 'project.json'))).toEqual(ingested);
  } finally {
    controller.abort();
    await waiting.catch(() => {});
  }
}, 30_000);

test('#698 timeout options require a bounded integer and --wait', async () => {
  const root = copy('0b-plan-pending');
  for (const options of [
    ['--timeout-ms', '1'], ['--wait', '--timeout-ms'], ['--wait', '--timeout-ms', '0'],
    ['--wait', '--timeout-ms', '600001'], ['--wait', '--timeout-ms', '1.5'],
  ]) {
    const result = await cli(root, ['job', 'acts', ...options]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('JOB_BINDING_INVALID');
  }
});

test('#633 post composition Other leads to a cited scene through two Review picks', async () => {
  testClock.set(Date.now());
  const root = copy('4-direction-post', project => {
    // The chain seeds completion. Give this copy the full execution history to retain on replacement.
    const postAt = Date.parse(String(arr(project.advances).map(obj).find(move => move.stage === 'post')!.at));
    step(project, 'composition').status_history = [
      { from_status: 'pending', status: 'in-progress', by: 'agent', at: new Date(postAt + 1).toISOString(), checkpoint_required: false, signoff: null },
      { from_status: 'in-progress', status: 'done', by: 'agent', at: new Date(postAt + 2).toISOString(), checkpoint_required: false, signoff: null },
    ];
  });
  const completed = step(read(root), 'composition');
  expect(completed.status).toBe('done');
  const reopenWords = join(root, 'reopen.txt');
  writeFileSync(reopenWords, 'Choose the synthetic two-plate scene.');
  plantLegacyReopen(root, 'post-interview', { by: 'user', wordsFile: reopenWords });
  const reopened = read(root);
  expect(obj(arr(reopened.reopens).at(-1)).steps_before).toContainEqual({ id: 'composition', status: 'done' });
  expect(step(reopened, 'composition')).toEqual({ ...completed, status: 'pending' });
  const plate = readFileSync(join(import.meta.dir, '../templates/example-chain/inputs/background.png'));
  writeFileSync(join(root, 'background.png'), plate);
  writeFileSync(join(root, 'foreground.png'), Buffer.concat([plate, Buffer.from('\n')]));
  for (const path of ['background.png', 'foreground.png']) expectExit0(await cli(root, ['input', 'add', path, root, '--origin', 'synthetic scene candidate']));
  const project = read(root);
  const item = collectItems(project, { collection: null }).find(i => i.id === 'post_composition')!;
  const retained = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(retained.path)), 'utf8')) as JsonObject;
  set.id = 'scene-act-two-plates'; set.drafted_at = testClock.iso();
  set.context = optionContext(project, 'post-interview', testClock.now(), root);
  const model = JSON.parse(readFileSync(join(root, 'derived/review/v1/out/check/build/skeleton.model.json'), 'utf8')) as JsonObject;
  const option = obj((obj((set.asks as JsonObject[])[0]).options as JsonObject[])[0]);
  const background = { path: 'background.png', rect: model.stage! };
  option.fragment = { scene: { background } };
  const question = 'post_composition';
  const otherText = '배경과 앞쪽 레이어를 함께 보여 주세요.';
  const path = 'evidence/interview/scene-act-two-plates.json';
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  expectExit0(await cli(root, ['interview-options', question, root, '--file', path]));
  const opening = await open(root, ['--question', question]);
  const view = await page(root, opening.url, 1);
  const act = await view.act('interview-picks', 'interview-picks', { questionId: question, selections: [{ itemId: question, optionId: 'other', otherText }], note: '' });
  expectExit0(await cli(root, ['interview-answer', question, root, '--from-review', String(act.actId)]));
  expectExit0(await cli(root, ['job', 'close', root]));
  expect(await opening.proc.exited).toBe(0);
  const composition = () => collectItems(read(root), { collection: null }).find(i => i.id === question)!;
  const otherAnswer = obj(composition().raw);
  expect(obj(arr(obj(otherAnswer.choice).picks)[0]).other_text).toBe(otherText);
  const sceneArgs = ['scene', 'write', '--rig', '1', '--background', 'background.png', '--foreground', 'foreground.png', '--citations-file', 'citations.json', root];
  const writeCitations = (quote: unknown) => {
    const citation = { guide: question, asks: [question], quote };
    writeFileSync(join(root, 'citations.json'), JSON.stringify({ background: citation, foreground: citation }));
  };
  writeCitations(otherAnswer.verbatim);
  const before = readFileSync(join(root, 'project.json'));
  const refused = await cli(root, sceneArgs);
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toContain('SCENE_CHOICE_MISSING');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);

  const report = nextProject(root, testClock.now());
  const move = report.moves.find(move => move.field === composition().path && move.command?.includes('interview-options'))!;
  expect(move.act).toContain('use the recorded Other words to draft concrete scene options with fragment.scene');
  expect(nextCommand([root], testClock.now()).stdout).toContain('draft concrete scene options with fragment.scene');
  expect(move.act).not.toContain('--other-fragment');
  const followUpPath = 'evidence/interview/scene-act-follow-up.json';
  option.label = '배경과 앞쪽 레이어를 함께 보여 줘요.';
  option.effect = '두 레이어를 전체 화면에 맞춰요.';
  option.fragment = { scene: { background, foreground: { path: 'foreground.png', rect: model.stage! } } };
  set.id = 'scene-act-follow-up';
  writeFileSync(join(root, followUpPath), JSON.stringify(set, null, 2) + '\n');
  await executePrinted(root, move.command!.replace("'<option-set.json>'", quote(followUpPath)));
  await nextReview(root, 'interview-picks', { questionId: question, selections: [{ itemId: question, optionId: 'keep', otherText: null }], note: '' }, question, ['INTERVIEW_CHOICE_REQUIRED']);
  const ingested = obj(composition().raw);
  expect(composition().record.history).toContainEqual(otherAnswer);
  expect(ingested.value).toEqual(option.fragment);
  const beforeReplacement = read(root);
  const previous = step(beforeReplacement, 'composition');
  expect(previous).toEqual({ ...completed, status: 'pending' });
  testClock.set(testClock.now() + 1_000);
  expect(nextProject(root, testClock.now()).refusals).toContainEqual(expect.objectContaining({
    code: 'PLAN_STEP_PREDATES_ANSWER', field: 'plan.steps[composition]',
  }));
  expectExit0(await cli(root, ['plan', 'remove', 'composition', root, '--by', 'agent']));
  const removedAt = testClock.iso();
  const does = 'Write the approved scene with a background and a foreground plate.';
  testClock.set(testClock.now() + 1_000);
  expectExit0(await cli(root, ['plan', 'add', 'composition', root, '--by', 'agent', '--phase', String(previous.phase),
    '--order', String(previous.order), '--does', does, '--produces', String(previous.produces),
    '--rests-on', arr(previous.rests_on).join(','), '--bar', String(previous.bar),
    '--checkpoint-proposed', String(previous.checkpoint_proposed)]));
  const replaced = read(root);
  expect(obj(replaced.plan).replaced).toEqual([
    ...arr(obj(beforeReplacement.plan).replaced),
    { step: { ...completed, status: 'pending' }, sha256: stepHash(previous), action: 'removed', at: removedAt, by: 'agent' },
  ]);
  const replacement = step(replaced, 'composition');
  expect(replacement).toMatchObject({ does, status: 'pending', checkpoint: null, drafted_at: testClock.iso() });
  expect(replacement.status_history).toBeUndefined();
  writeCitations(ingested.verbatim);
  expectExit0(await cli(root, sceneArgs));
  expect(obj((read(root).scenes as JsonObject[]).at(-1)).by).toBe('agent');
  expectExit0(await cli(root, ['interview', '--check', root]));
}, 30_000);


test('#490 legacy parts signoff prints ordered verdict and structure prerequisites with retained writer flags', async () => {
  testClock.set(Date.now());
  const root = copy('1-parts-verdict');
  const signoff = { jobId: 'synthetic', actId: 'parts-sign', kind: 'signoff', at: testClock.iso(),
    source: { selector: { kind: 'draft', id: 'chain' } }, value: { stage: 'parts-review' } } as unknown as ActV3;
  const [pending] = pendingJobActs(read(root), [signoff], root);
  expect(pending!.args).toEqual(['signoff', 'parts-review', root, '--draft', 'chain', '--structure-file', 'evidence/structure-chain.json', '--from-review', 'parts-sign']);
  expect(pending!.preconditions).toHaveLength(2);
  expect(pending!.preconditions![0]!.command).toBeNull();
  expect(pending!.preconditions![0]!.act).toContain('midflight approved parts-verdict already ingested unsigned');
  const text = jobActsText({ acts: [pending!] });
  expect(text.indexOf('midflight approved parts-verdict already ingested unsigned')).toBeLessThan(text.indexOf('rig-create structure-snapshot'));
  expect(text.indexOf('rig-create structure-snapshot')).toBeLessThan(text.indexOf('rig-create signoff'));
  recordPartsReceipt(root, 'chain', testClock.now());
  const [ready] = pendingJobActs(read(root), [signoff], root);
  expect(ready!.preconditions).toHaveLength(1);
  await executePrinted(root, ready!.preconditions![0]!.command!);
  expect(pendingJobActs(read(root), [signoff], root)[0]!.preconditions).toBeUndefined();
  // The exact final command needs a stored Review act bound to the current record after prerequisite writes.
  expectExit0(await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']));
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expectExit0(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']));
  const legacySubject = { kind: 'signoff' as const, stage: 'parts-review' as const };
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, testClock.now(), options => startJobHost({
    ...options,
    readPublished: async input => ({ ...await readPublished(input), subjects: [legacySubject] }),
  }));
  try {
    prepareDraftManifest(root, read(root), 'chain');
    enqueuePublication(root, readWriterBinding(root)!, draftPublicationResult('chain'));
    await reconcileCreateJob(root, async entry => {
      const requestId = randomUUID();
      const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
        method: 'POST',
        headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schema: 'rig-review/job-api@2',
          verb: 'publish',
          jobId: host.session.jobId,
          requestId,
          idempotencyKey: requestId,
          expectedGeneration: 0,
          result: entry.result,
          freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
        }),
      }));
      expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
      const { publication, generation } = host.session.status();
      acknowledgePublication(entry, publication!.publicationId, generation, requestId, [legacySubject]);
      return [];
    });
    const session = host.session as unknown as {
      jobId: string;
      store: { update(jobId: string, rev: null, fn: (row: { data: { generation: number; reviewer: { id: string; role: string }; publications: Record<string, { retained: { source: unknown } }>; asks: Record<string, unknown>; acts: Record<string, unknown> } }) => { data: unknown }): unknown };
      event(data: unknown, value: object): unknown;
    };
    const publicationId = host.session.status().publication!.publicationId;
    let act!: ActV3;
    session.store.update(session.jobId, null, ({ data }) => {
      data.generation++;
      const askId = randomUUID();
      const source = data.publications[publicationId]!.retained.source;
      const ask = { askId, publicationId, subject: legacySubject, source, status: 'answered' };
      data.asks[askId] = ask;
      session.event(data, { type: 'pending', ask: { ...ask, status: 'pending' } });
      const actId = randomUUID();
      act = parseCommentsAct({
        schema: JOB_COMMENTS_ACT_SCHEMA,
        actId,
        jobId: session.jobId,
        askId,
        publicationId,
        authority: { actor: 'human', channel: 'review-ui', reviewer: { ...data.reviewer } },
        at: testClock.iso(),
        kind: 'signoff',
        source,
        value: { stage: 'parts-review', decision: 'approved', comments: [{ text: WORDS }] },
      }) as unknown as ActV3;
      data.generation++;
      data.acts[actId] = act;
      session.event(data, { type: 'act', act });
      return { data };
    });
    const row = pendingJobActs(read(root), [act], root)[0]!;
    expect(row.command).toContain('--structure-file');
    await executePrinted(root, row.command!);
    expect(read(root).signoffs).toContainEqual(expect.objectContaining({ stage: 'parts-review', draft_id: 'chain' }));
    expect(nextProject(root, testClock.now()).refusals.map(row => row.code)).not.toContain('STRUCTURE_DECISIONS_MISSING');
  } finally {
    host.stop();
  }
}, 30_000);


/** Execute the surrounding commands from next, with an actual owner-page export in between. */
async function nextReview(root: string, kind: string, value: object, question?: string, expectedRefusals: string[] = []): Promise<void> {
  const report = nextProject(root, testClock.now());
  expect(report.refusals.filter(row => row.code !== 'INTERVIEW_INCOMPLETE').map(row => row.code)).toEqual(expectedRefusals);
  const index = report.moves.findIndex(move => move.role === 'human' && move.review_act?.kind === kind
    && (question === undefined || move.review_act.question_id === question));
  expect(index).toBeGreaterThan(0);
  const workflow = report.moves.slice(index - 1, index + 3);
  expect(workflow.map(move => move.role)).toEqual(['agent', 'human', 'agent', 'agent']);
  expect(workflow[1]!.command).toBeNull();
  const target = workflow[1]!.review_act!;
  expect(workflow[0]!.command).toContain(question ? `--question ${question}` : target.draft_id ? `--draft ${target.draft_id}`
    : kind === 'review-verdict' || target.stage === 'rig-review' ? `--rig ${target.version_id!.slice(1)}` : '--plan');
  expect(workflow[2]!.command).toBe(`rig-create job acts ${quote(root)} --json --wait`);
  expect(workflow[3]!.command).toContain("--from-review '<actId>'");
  expect(report.moves.some(move => move.command?.startsWith('rig-create job close '))).toBe(false);
  receipt({ rendered: scrub(nextCommand([root], testClock.now()).stdout, root) });
  receipt({ workflow: { stage: target.stage, kind, question, draft: target.draft_id,
    printed: workflow.map(move => ({ role: move.role, command: move.command === null ? null : scrub(move.command, root), act: move.act })) } });
  const opening = await open(root, [], workflow[0]!.command!.replace("'<reviewer>'", "'synthetic-owner'"));
  const view = await page(root, opening.url, 1, kind);
  const capture = kind === 'review-verdict' && target.stage === 'rig-review'
    ? rigCapture(root, view, String(view.asks.find(ask => obj(ask.subject).kind === kind)!.askId)) : {};
  const act = await view.act(kind, kind, value, capture);
  expect(act.kind).toBe(kind);
  const listed = await executePrinted(root, workflow[2]!.command!);
  const row = (JSON.parse(listed.stdout) as { acts: PendingJobAct[] }).acts.find(row => row.actId === act.actId)!;
  expect(row.command).not.toBeNull();
  for (const step of row.preconditions ?? []) {
    expect(step.command).not.toBeNull();
    await executePrinted(root, step.command!);
  }
  await executePrinted(root, workflow[3]!.command!.replace("'<actId>'", quote(String(act.actId))));
  expect(JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts).toEqual([]);
  expect(readWriterBinding(root)?.origin).toBe(opening.url.origin);
  // Close the fixture host explicitly so each invocation can start with its selected host mode.
  expectExit0(await cli(root, ['job', 'close', root]));
  const [stdout, stderr, exit] = await Promise.all([
    opening.remainingOutput, new Response(opening.proc.stderr).text(), opening.proc.exited,
  ]);
  receipt({ command: scrub(workflow[0]!.command!, root), exit, stdout: scrub(stdout, root), stderr: scrub(stderr, root), closed: true });
  expectExit0({ stdout, stderr, exit });
  expect(readWriterBinding(root)).toBeNull();
}

test.each([
  { checkpoint: '0a-interview-options', question: 'rig_type' },
  { checkpoint: '2-rigging-answers', question: 'bones' },
])('#507 head picks $checkpoint/$question execute printed host, acts and ingest', async ({ checkpoint, question }) => {
  receipt({ test: '#507 head picks', source: `checkpoint ${checkpoint}`, question });
  const root = copy(checkpoint);
  const project = read(root);
  const item = collectItems(project, { collection: null }).find(item => item.id === question)!;
  const pending = obj(item.record.pending_options);
  const set = JSON.parse(readFileSync(join(root, String(pending.path)), 'utf8')) as JsonObject;
  const selections = arr(set.asks).map(obj).map(ask => ({ itemId: ask.id,
    optionId: arr(ask.options).map(obj).find(option => option.kind === 'value')!.id, otherText: null }));
  await nextReview(root, 'interview-picks', { questionId: question, selections, note: WORDS }, question);
  const answered = collectItems(read(root), { collection: null }).find(item => item.id === question)!;
  expect(answered.state.state).toBe('user');
}, 30_000);

test('#557 fresh parts verdict executes printed commands and atomically signs without a second human act', async () => {
  receipt({ test: '#557 fresh parts fold', source: 'writer-prepared synthetic checkpoint 1-parts-verdict' });
  testClock.set(EXAMPLE_REOPEN_AT);
  const root = copy('1-parts-verdict');
  const before = nextProject(root, testClock.now());
  expect(before.moves.some(move => move.review_act?.kind === 'parts-verdict')).toBe(false);
  expect(before.moves.some(move => move.review_act?.kind === 'signoff')).toBe(false);
  const snapshot = before.moves.find(move => move.command?.startsWith('rig-create structure-snapshot'))!;
  await executePrinted(root, snapshot.command!);
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expectExit0(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']));
  const advance = nextProject(root, testClock.now()).moves.find(move => move.command?.startsWith('rig-create advance parts-review'))!;
  await executePrinted(root, advance.command!);
  await nextReview(root, 'parts-verdict', { verdict: 'approved', issues: [], words: WORDS });
  expect(arr(read(root).signoffs).map(obj)).toContainEqual(expect.objectContaining({ stage: 'parts-review', draft_id: 'chain' }));
  const after = nextProject(root, testClock.now());
  expect(after.refusals.map(row => row.code)).not.toContain('PARTS_REVIEW_UNSIGNED');
  expect(after.moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'parts-review')).toBe(false);
}, 30_000);

function unsignedRiggingInterview(): string {
  return copy('3-rig-review', project => {
    project.stage = 'rigging-interview'; project.versions = [];
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('rigging-interview'));
    for (const step of arr(obj(project.plan).steps).map(obj).filter(step => ['bones', 'meshes', 'constraints', 'motion'].includes(String(step.id)))) {
      step.status = 'pending'; delete step.status_history;
    }
  });
}

test('#711 relayed rigging-interview signoff unblocks draft publication on the same Review host', async () => {
  const root = unsignedRiggingInterview();
  const fixture = read(root);
  const bones = arr(obj(fixture.plan).steps).map(obj).find(step => step.id === 'bones')!;
  bones.checkpoint_proposed = true;
  obj(bones.checkpoint).value = true;
  write(root, fixture);

  // Seed a persisted legacy plan publication carrying a pending signoff ask, then start the live background host on it.
  const legacySubject = { kind: 'signoff' as const, stage: 'rigging-interview' as const };
  let planPublicationId = '';
  let legacyAskId = '';
  const seedHost = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, testClock.now(), options => startJobHost({
    ...options,
    readRecordPublished: ((request: RecordPublicationRequest) => {
      const context = readRecordPublished(request, testClock.now());
      return context.plan === null ? context : { ...context, subjects: [legacySubject] };
    }) as typeof readRecordPublished,
  }), true);
  try {
    enqueuePublication(root, readWriterBinding(root)!, { kind: 'plan' });
    await reconcileCreateJob(root, async entry => {
      const requestId = randomUUID();
      const reply = await agentCall(seedHost, {
        verb: 'publish',
        requestId,
        idempotencyKey: requestId,
        expectedGeneration: 0,
        result: { kind: 'plan' },
        freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
      });
      expect(reply.ok).toBe(true);
      const { publication, generation } = seedHost.session.status();
      planPublicationId = publication!.publicationId;
      acknowledgePublication(entry, planPublicationId, generation, requestId, [legacySubject]);
    });
    const session = seedHost.session as unknown as {
      jobId: string;
      store: { update(jobId: string, rev: null, fn: (row: { data: { generation: number; publications: Record<string, { retained: { source: unknown } }>; asks: Record<string, unknown> } }) => { data: unknown }): unknown };
      event(data: unknown, value: object): unknown;
    };
    session.store.update(session.jobId, null, ({ data }) => {
      data.generation++;
      legacyAskId = randomUUID();
      const ask = { askId: legacyAskId, publicationId: planPublicationId, subject: legacySubject, source: data.publications[planPublicationId]!.retained.source, status: 'pending' };
      data.asks[legacyAskId] = ask;
      session.event(data, { type: 'pending', ask });
      return { data };
    });
  } finally {
    seedHost.stop();
  }

  const opening = await open(root);
  const binding = readWriterBinding(root)!;
  const descriptor = join(binding.identity.stateDir, 'job-ui', `${binding.jobId}.json`);
  const pid = () => obj(JSON.parse(readFileSync(descriptor, 'utf8'))).pid;
  const originalPid = pid();
  expect(typeof originalPid).toBe('number');
  const signoff = read(root).signoffs;
  expect(arr(signoff).map(obj).some(row => row.stage === 'plan-approved')).toBe(true);
  const draft = { kind: 'draft', id: 'next' } as const;
  await expect(assertNoPendingJobAsk(root, draft)).rejects.toMatchObject({ code: 'JOB_ASK_PENDING' });

  const words = join(root, 'signoff-words.txt');
  writeFileSync(words, WORDS);
  expectExit0(await cli(root, ['signoff', 'rigging-interview', root, '--by', 'synthetic-owner',
    '--owner-chat', words, '--said-at', testClock.iso(), '--relayed-by', 'synthetic-operator']));
  const project = read(root);
  const lapsed = structuredClone(project);
  const approval = arr(lapsed.signoffs).map(obj).at(-1)!;
  const hashes = obj(approval.step_hashes);
  hashes[Object.keys(hashes)[0]!] = '0'.repeat(64);
  write(root, lapsed);
  try {
    await expect(assertNoPendingJobAsk(root, draft)).rejects.toMatchObject({ code: 'JOB_ASK_PENDING' });
  } finally {
    write(root, project);
  }

  expectExit0(await cli(root, ['advance', 'rigging', root]));
  const base = 'derived/drafts/next';
  cpSync(join(root, 'derived/drafts/chain'), join(root, base), { recursive: true });
  const recorded = await cli(root, ['draft-rig', 'next', root, '--config', `${base}/config.json`,
    '--from', `${base}/out`, '--parts', `${base}/input`, '--json']);
  expectExit0(recorded);
  const draftResult = JSON.parse(recorded.stdout) as { id: string; publication: { status: string; lines: string[] } };
  expect(draftResult.id).toBe('next');
  expect(draftResult.publication, draftResult.publication.lines.join('\n')).toMatchObject({ status: 'published' });
  const next = await page(root, opening.url, 1, 'review-verdict');
  expect(next.head.publicationId).not.toBe(planPublicationId);
  expect(next.asks.map(ask => ask.subject)).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
  ]);
  expect(next.asks.find(ask => obj(ask.subject).kind === 'review-verdict')?.source).toMatchObject({ selector: draft });
  expect(readWriterBinding(root)).toEqual(binding);
  expect(pid()).toBe(originalPid);
  const db = new Database(join(binding.identity.stateDir, 'jobs.sqlite'), { readonly: true });
  try {
    const row = db.query<{ status: string }, [string, string]>(
      "SELECT value ->> '$.status' AS status FROM jobs, json_each(document, '$.asks') WHERE job_id = ? AND key = ?",
    ).get(binding.jobId, legacyAskId);
    expect(row?.status).toBe('superseded');
  } finally { db.close(); }
}, 30_000);

test('#507 rig-review approval folds signature through printed host, acts, ingest and close', async () => {
  receipt({ test: '#507 rig-review verdict then signoff', source: 'checkpoint 3-rig-review' });
  const root = copy('3-rig-review');
  await nextReview(root, 'review-verdict', { stage: 'rig-review', verdict: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'rig-review')).toBe(true);
}, 30_000);

test('#502 all post-interview picks and plan signoff execute next host and exported-act ingest commands', async () => {
  testClock.set(Date.now());
  const root = copy('4-direction-post', project => {
    project.stage = 'post-interview';
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('post-interview'));
    project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('post-interview'));
    obj(project.plan).steps = arr(obj(project.plan).steps).filter(step => obj(step).id !== 'composition');
    for (const step of arr(obj(project.plan).steps).map(obj).filter(step => step.phase === 'post')) {
      step.status = 'pending'; delete step.status_history;
    }
  });
  for (const [question, step] of [['camera_depth', 'camera'], ['post_timing', 'timing'], ['post_composition', null]] as const) {
    const project = read(root);
    const item = collectItems(project, { collection: null }).find(item => item.id === question)!;
    const binding = obj(obj(obj(item.raw).choice).set);
    const set = JSON.parse(readFileSync(join(root, String(binding.path)), 'utf8')) as JsonObject;
    set.id = `next-${question}`; set.drafted_at = testClock.iso();
    set.context = optionContext(project, 'post-interview', testClock.now(), root);
    item.record.guide = null; write(root, project);
    const path = `evidence/interview/next-${question}.json`;
    writeFileSync(join(root, path), JSON.stringify(set));
    expectExit0(await cli(root, ['interview-options', question, root, '--file', path]));
    const selections = arr(set.asks).map(obj).map(ask => ({ itemId: ask.id,
      optionId: arr(ask.options).map(obj).find(option => option.kind === 'value')!.id, otherText: null }));
    await nextReview(root, 'interview-picks', { questionId: question, selections, note: WORDS }, question);
    if (step !== null) expectExit0(await cli(root, ['plan', 'revise', step, root, '--by', 'agent',
      '--reason', `The ${step} definition still fits the recorded synthetic choice.`]));
  }
  const composition = nextProject(root, testClock.now()).moves.find(move => move.command?.startsWith('rig-create plan add composition'))!;
  expect(composition.command).toContain('--rests-on post_composition');
  await executePrinted(root, composition.command!.replace("'<work>'", "'Write the approved composition scene'")
    .replace("'<result>'", "'A cited scene document'").replace("'<acceptance bar>'", "'Roles and rects match the approved choice'"));
  const signReport = nextProject(root, testClock.now());
  expect(signReport.moves.some(m => m.command?.includes('--plan'))).toBe(false);
  const postWords = join(root, 'post-approval.txt');
  writeFileSync(postWords, WORDS);
  const postChatMove = signReport.moves.find(m => m.command?.includes('signoff post-interview') && m.command.includes('--owner-chat'))!;
  expect(postChatMove).toBeDefined();
  expectExit0(await cli(root, ['signoff', 'post-interview', root, '--by', 'synthetic-owner',
    '--owner-chat', postWords, '--said-at', testClock.iso(), '--relayed-by', 'synthetic-operator']));
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'post-interview')).toBe(true);
}, 30_000);

test('#502 direction verdict then owner-chat signoff execute next host and exported-act ingest commands', async () => {
  testClock.set(Date.now());
  const root = copy('example-chain', project => {
    project.stage = 'direction-review';
    retainSignoffs(project, row => row.stage !== 'direction-review');
    project.advances = arr(project.advances).filter(row => obj(row).stage !== 'accepted');
    arr(project.versions).map(obj).find(version => version.n === 2)!.verdicts = [];
  });
  const before = nextProject(root, testClock.now());
  expect(before.moves.filter(move => move.command?.includes('--plan'))).toEqual([]);
  await nextReview(root, 'review-verdict', { stage: 'direction-review', verdict: 'approved', words: WORDS });
  const afterVerdict = nextProject(root, testClock.now());
  expect(afterVerdict.moves.filter(move => move.command?.includes('--plan'))).toEqual([]);
  expect(afterVerdict.moves.some(move => move.command?.includes('signoff direction-review') && move.command.includes('--owner-chat'))).toBe(true);
  const directionWords = join(root, 'direction-approval.txt');
  writeFileSync(directionWords, WORDS);
  expectExit0(await cli(root, ['signoff', 'direction-review', root, '--by', 'synthetic-owner',
    '--owner-chat', directionWords, '--said-at', testClock.iso(), '--relayed-by', 'synthetic-operator']));
  const advance = nextProject(root, testClock.now()).moves.find(move => move.command?.startsWith('rig-create advance accepted'))!;
  await executePrinted(root, advance.command!);
  expect(nextProject(root, testClock.now()).accepted).toBe(true);
}, 30_000);

test('#556 job close refuses un-ingested acts byte-identically, closes after ingest, and records discarded acts with a reason', async () => {
  testClock.set(EXAMPLE_NOW);
  const root = copy('0a-interview-options');
  const pickValue = {
    questionId: 'rig_type',
    selections: [{ itemId: 'rig_type', optionId: 'keep', otherText: null }],
    note: WORDS,
  };

  // 1. A job with no acts closes as before and leaves project.json byte-identical.
  const emptyOpen = await open(root, ['--question', 'rig_type']);
  const emptyBefore = readFileSync(join(root, 'project.json'));
  const emptyClose = await cli(root, ['job', 'close', root]);
  expectExit0(emptyClose);
  expect(emptyClose.stdout.trim()).toBe('job: closed');
  await emptyOpen.proc.exited;
  expect(readWriterBinding(root)).toBeNull();
  expect(readFileSync(join(root, 'project.json'))).toEqual(emptyBefore);

  // 2. An un-ingested finalized act refuses with JOB_ACTS_PENDING, names the act id and ingest command,
  // and leaves both the binding and project.json byte-identical; after ingest, close succeeds.
  const firstOpen = await open(root, ['--question', 'rig_type']);
  const firstView = await page(root, firstOpen.url, 1, 'interview-picks');
  const firstAct = await firstView.act('interview-picks', 'interview-picks', pickValue);
  const bindingPath = join(root, JOB_BINDING_FILE);
  const beforeBindingBytes = readFileSync(bindingPath);
  const beforeProjectBytes = readFileSync(join(root, 'project.json'));

  const refusedClose = await cli(root, ['job', 'close', root]);
  expect(refusedClose.exit).toBe(1);
  expect(refusedClose.stderr).toStartWith('JOB_ACTS_PENDING: ');
  expect(refusedClose.stderr).toContain(String(firstAct.actId));
  const [pending] = pendingJobActs(read(root), [firstAct as unknown as ActV3], root);
  expect(refusedClose.stderr).toContain(pending!.command!);
  expect(readFileSync(bindingPath)).toEqual(beforeBindingBytes);
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeProjectBytes);

  await executePrinted(root, pending!.command!);
  const afterIngestClose = await cli(root, ['job', 'close', root]);
  expectExit0(afterIngestClose);
  expect(afterIngestClose.stdout.trim()).toBe('job: closed');
  await firstOpen.proc.exited;
  expect(readWriterBinding(root)).toBeNull();

  // 3. --discard-acts validates the reason and record through the check validator, records the dropped act ids, and closes.
  const discardRoot = copy('0a-interview-options');
  const secondOpen = await open(discardRoot, ['--question', 'rig_type']);
  const secondView = await page(discardRoot, secondOpen.url, 1, 'interview-picks');
  const droppedAct = await secondView.act('interview-picks', 'interview-picks', pickValue);
  const discardBindingPath = join(discardRoot, JOB_BINDING_FILE);
  const discardBeforeBinding = readFileSync(discardBindingPath);
  const discardBeforeProject = readFileSync(join(discardRoot, 'project.json'));

  const discardCommand = ['job', 'close', discardRoot, '--discard-acts'];
  const missingReason = await cli(discardRoot, [...discardCommand, '--by', 'agent']);
  expect(missingReason.exit).toBe(2);
  expect(missingReason.stderr).toContain('JOB_BINDING_INVALID:');
  expect(readFileSync(discardBindingPath)).toEqual(discardBeforeBinding);
  expect(readFileSync(join(discardRoot, 'project.json'))).toEqual(discardBeforeProject);

  // If the validator refuses review_acts, close refuses before writing project.json or tearing down the binding.
  const duplicateSeed = read(discardRoot);
  duplicateSeed.review_acts = [
    { schema: 'rig-create/review-act@1', kind: 'discarded', jobId: droppedAct.jobId, actId: 'dup-act', at: '2026-11-18T23:59:59Z', reason: 'first' },
    { schema: 'rig-create/review-act@1', kind: 'discarded', jobId: droppedAct.jobId, actId: 'dup-act', at: '2026-11-18T23:59:59Z', reason: 'second' },
  ];
  const legacy = { ...duplicateSeed, review_acts: arr(duplicateSeed.review_acts).slice(0, 1) };
  const legacyResult = checkProject(discardRoot, legacy, { now: testClock.now(), readOnly: true });
  expect(legacyResult.warnings.map(f => f.code)).toContain('REVIEW_ACT_DISCARD_ACTOR_LEGACY');
  expect(legacyResult.refusals.map(f => f.code)).not.toContain('REVIEW_ACT_LEDGER_INVALID');
  obj(arr(legacy.review_acts)[0]).at = '2026-11-19T00:00:00Z';
  expect(checkProject(discardRoot, legacy, { now: testClock.now(), readOnly: true }).refusals.map(f => f.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
  obj(arr(legacy.review_acts)[0]).at = '2026-11-18T23:59:59Z';
  write(discardRoot, duplicateSeed);
  const invalidBeforeProject = readFileSync(join(discardRoot, 'project.json'));
  const refusedValidatorClose = await cli(discardRoot, [...discardCommand, 'Superseded by updated plan', '--by', 'agent']);
  expect(refusedValidatorClose.exit).toBe(1);
  expect(refusedValidatorClose.stderr).toStartWith('REVIEW_ACT_REPLAY_CONFLICT: ');
  expect(readFileSync(discardBindingPath)).toEqual(discardBeforeBinding);
  expect(readFileSync(join(discardRoot, 'project.json'))).toEqual(invalidBeforeProject);
  writeFileSync(join(discardRoot, 'project.json'), discardBeforeProject);

  const wordsFile = join(discardRoot, 'discard-words.txt');
  writeFileSync(wordsFile, WORDS);
  const saidAt = new Date(testClock.now() - 1000).toISOString();
  const relay = ['--owner-chat', wordsFile, '--said-at', saidAt, '--relayed-by', 'synthetic-operator'];
  const invalidRelay = await cli(discardRoot, [...discardCommand, '--by', 'agent', ...relay]);
  expect(invalidRelay.exit).toBe(1);
  expect(invalidRelay.stderr).toStartWith('OWNER_CHAT_INVALID: ');
  expect(readFileSync(discardBindingPath)).toEqual(discardBeforeBinding);
  expect(readFileSync(join(discardRoot, 'project.json'))).toEqual(discardBeforeProject);
  const discardedClose = await cli(discardRoot, [...discardCommand, '--by', 'synthetic-owner', ...relay]);
  expectExit0(discardedClose);
  expect(discardedClose.stdout.trim()).toBe('job: closed');
  await secondOpen.proc.exited;
  expect(readWriterBinding(discardRoot)).toBeNull();

  const recorded = read(discardRoot);
  expect(arr(recorded.review_acts)).toContainEqual({
    schema: 'rig-create/review-act@1',
    kind: 'discarded',
    jobId: droppedAct.jobId,
    actId: droppedAct.actId,
    at: expect.any(String),
    by: 'synthetic-owner',
    owner_words: WORDS,
    said_at: saidAt,
    relayed_by: 'synthetic-operator',
    source: 'owner chat, relayed',
  });
  expect(pendingJobActs(recorded, [droppedAct as unknown as ActV3], discardRoot)).toEqual([]);
  const reask = nextProject(discardRoot, testClock.now());
  expect(reask.refusals.filter(r => r.code === 'REVIEW_ACT_LEDGER_INVALID')).toEqual([]);
  expect(reask.moves).toContainEqual(expect.objectContaining({ role: 'agent', command: expect.stringContaining('job open') }));
  expect(reask.moves).toContainEqual(expect.objectContaining({ role: 'human', review_act: expect.objectContaining({ kind: 'interview-picks', question_id: 'rig_type' }) }));

  const thirdOpen = await open(discardRoot, ['--question', 'rig_type']);
  const thirdView = await page(discardRoot, thirdOpen.url, 1, 'interview-picks');
  const freshAct = await thirdView.act('interview-picks', 'interview-picks', pickValue);
  expect(freshAct.jobId).not.toBe(droppedAct.jobId);
  const beforeReplay = readFileSync(join(discardRoot, 'project.json'));
  const beforeReplayBinding = readFileSync(discardBindingPath);
  const replay = await cli(discardRoot, ['interview-answer', 'rig_type', discardRoot, '--from-review', String(droppedAct.actId)]);
  expect(replay.exit).toBe(1);
  expect(replay.stderr).toStartWith('rig-create: REVIEW_ACT_DISCARDED: ');
  expect(readFileSync(join(discardRoot, 'project.json'))).toEqual(beforeReplay);
  expect(readFileSync(discardBindingPath)).toEqual(beforeReplayBinding);
  expectExit0(await cli(discardRoot, [...discardCommand, 'Synthetic agent reason', '--by', 'agent']));
  expect(arr(read(discardRoot).review_acts)).toContainEqual(expect.objectContaining({
    jobId: freshAct.jobId, actId: freshAct.actId, by: 'agent', reason: 'Synthetic agent reason',
  }));
  await thirdOpen.proc.exited;
}, 30_000);

test('#604 writer auto-publish refuses JOB_ASK_PENDING when the bound job holds an un-ingested ask for a different target, allows same-target republish, and passes once answered and ingested', async () => {
  testClock.set(Date.parse('2026-11-08T00:00:00Z'));
  const root = copy('example-chain', project => {
    project.stage = 'direction-review';
    retainSignoffs(project, row => row.stage !== 'direction-review');
    project.advances = arr(project.advances).filter(row => obj(row).stage !== 'accepted');
    arr(project.versions).map(obj).find(version => version.n === 2)!.verdicts = [];
  });
  const put = (path: string, value: unknown): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  };
  cpSync(join(import.meta.dir, 'fixtures/rig-registration'), join(root, 'source'), { recursive: true });
  rmSync(join(root, 'source/idle'), { recursive: true, force: true });
  cpSync(join(import.meta.dir, '../templates/example-remesh/outputs/v1/idle'), join(root, 'source/idle'), { recursive: true });
  put('source/adapter.json', []);
  put('source/citations.json', obj(obj(arr(read(root).versions)[0]).provenance).sections);
  put('source/run.json', {
    spec: 'rigc-run/1', package: { name: 'rig-c', version: '3.4.1' }, command: 'build',
    started_at: '2026-11-08T00:00:01.000Z', finished_at: '2026-11-08T00:00:02.000Z',
    inputs: [{ role: 'rig', path: '../rig/rig.json', sha256: '1'.repeat(64) }, { role: 'motion', path: '../rig/motion.json', sha256: '2'.repeat(64) }],
    outputs: [{ path: '../compile-report.json', sha256: '3'.repeat(64) }, { path: 'skeleton.model.json', sha256: '4'.repeat(64) }],
  });
  put('source/at-source.json', { finished_at: '2026-11-08T00:00:02.000Z' });
  put('evidence/reopen.txt', 'Reopen rig-review for synthetic rebuild.\n');

  const opening = await open(root, ['--rig', '2']);
  const binding = readWriterBinding(root)!;
  const firstView = await page(root, opening.url, 1, 'review-verdict');
  expect(opening.lines).toEqual([`job: post v2 published (publication ${firstView.head.publicationId})`, 'job: asked review-verdict direction-review']);
  expect(obj(firstView.head.source).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  const preReopenProject = readFileSync(join(root, 'project.json'));

  testClock.set(Date.parse('2026-11-08T00:00:01Z'));
  plantLegacyReopen(root, 'rig-review', { by: 'user', wordsFile: join(root, 'evidence/reopen.txt') });

  // Same target re-publishing its own ask is not refused.
  const sameTargetBytes = readFileSync(join(root, 'project.json'));
  const sameIntent = prepareVersionIntent(root, sameTargetBytes, 2);
  expect(sameIntent).not.toBeNull();
  rmSync(join(jobPrivateRoot(root), 'outbox', `${sameIntent!.id}.json`));

  const rigVersionArgs = [
    'rig-version', '3', root,
    '--parts', 'derived/drafts/chain/input',
    '--rig', 'outputs/v1/out/rig',
    '--build', 'derived/review/v1/out/check/build',
    '--idle', 'source/idle',
    '--config', 'derived/drafts/chain/config.json',
    '--path-adapter', 'source/adapter.json',
    '--compile-report', 'source/compile-report.json',
    '--toolchain-lock', 'source/package-lock.json',
    '--run-record', 'source/run.json',
    '--citations', 'source/citations.json',
    '--at-source', 'source/at-source.json',
    '--at-pointer', '/finished_at',
    '--by', 'agent',
  ];

  // 1. Unanswered post verdict ask refuses rig-version for a new rig and leaves record and job byte-identical.
  testClock.set(Date.parse('2026-11-08T00:00:03Z'));
  const beforeProject = readFileSync(join(root, 'project.json'));
  const beforeRoot = snapshot(root);
  const beforePrivate = snapshot(jobPrivateRoot(root));
  const beforeJobState = snapshot(jobHostStateRoot(root));

  const refusedUnanswered = await cli(root, rigVersionArgs);
  expect(refusedUnanswered.exit).toBe(1);
  expect(refusedUnanswered.stderr).toContain('JOB_ASK_PENDING:');
  expect(refusedUnanswered.stderr).toContain(binding.jobId);
  expect(refusedUnanswered.stderr).toContain('review-verdict direction-review on post v2');
  expect(refusedUnanswered.stderr).toContain('give the verdict');
  expect(refusedUnanswered.stderr).toContain('job acts');
  expect(refusedUnanswered.stderr).toContain('review 2 --from-review');
  expect(refusedUnanswered.stderr).toContain('review <n> --from-review');
  expect(refusedUnanswered.stderr).toContain('publish into the existing job');
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeProject);
  expect(snapshot(root)).toEqual(beforeRoot);
  expect(snapshot(jobPrivateRoot(root))).toEqual(beforePrivate);
  expect(snapshot(jobHostStateRoot(root))).toEqual(beforeJobState);
  expect(pendingPublications(root)).toEqual([]);

  // 2. Answered but un-ingested act also refuses JOB_ASK_PENDING and preserves both record and job.
  writeFileSync(join(root, 'project.json'), preReopenProject);
  const verdict = await firstView.act('review-verdict', 'review-verdict', { stage: 'direction-review', verdict: 'approved', words: WORDS });
  const beforeUnIngestedProject = readFileSync(join(root, 'project.json'));
  const beforeUnIngestedJobState = snapshot(jobHostStateRoot(root));

  const refusedUnIngested = await cli(root, rigVersionArgs);
  expect(refusedUnIngested.exit).toBe(1);
  expect(refusedUnIngested.stderr).toContain('JOB_ASK_PENDING:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeUnIngestedProject);
  expect(snapshot(jobHostStateRoot(root))).toEqual(beforeUnIngestedJobState);

  // 3. Once the ask is answered and ingested, rig-version passes as today and publishes the new rig.
  expectExit0(await cli(root, ['review', '2', root, '--from-review', String(verdict.actId)]));
  testClock.set(Date.now() + 1000);
  plantLegacyReopen(root, 'rig-review', { by: 'user', wordsFile: join(root, 'evidence/reopen.txt') });
  const builtAt = new Date(testClock.now() + 1000).toISOString();
  put('source/run.json', {
    spec: 'rigc-run/1', package: { name: 'rig-c', version: '3.4.1' }, command: 'build',
    started_at: new Date(testClock.now() + 500).toISOString(), finished_at: builtAt,
    inputs: [{ role: 'rig', path: '../rig/rig.json', sha256: '1'.repeat(64) }, { role: 'motion', path: '../rig/motion.json', sha256: '2'.repeat(64) }],
    outputs: [{ path: '../compile-report.json', sha256: '3'.repeat(64) }, { path: 'skeleton.model.json', sha256: '4'.repeat(64) }],
  });
  put('source/at-source.json', { finished_at: builtAt });
  testClock.set(testClock.now() + 2000);
  const registered = await cli(root, rigVersionArgs);
  expectExit0(registered);
  expect(registered.stdout).toContain('rig-version: v3 registered');
  expect(registered.stdout).toContain('job: asked review-verdict rig-review');
  const thirdView = await page(root, opening.url, 1, 'review-verdict');
  expect(obj(thirdView.head.source).selector).toEqual({ kind: 'rig', version: 3 });
  expect(registered.stdout).toContain(`updated the open page: publication ${String(thirdView.head.publicationId)}, ask review-verdict rig-review`);
}, 30_000);

test('#1136 job acts --json and the fetched act keep a direction pin anchor as Review wrote it', async () => {
  testClock.set(Date.parse('2026-11-08T00:00:00Z'));
  const root = copy('example-chain', project => {
    project.stage = 'direction-review';
    retainSignoffs(project, row => row.stage !== 'direction-review');
    project.advances = arr(project.advances).filter(row => obj(row).stage !== 'accepted');
    arr(project.versions).map(obj).find(version => version.n === 2)!.verdicts = [];
  });
  const opening = await open(root, ['--rig', '2']);
  const view = await page(root, opening.url, 1, 'review-verdict');
  const source = obj(view.head.source);
  const target = String(obj(source.package ?? {}).id ?? 'synthetic-post');
  const comments = [directionPin(String(source.sourceHash), String(obj(source.model).sha256), 1.25, 'Hold the lantern here.', target),
    { text: 'Overall direction note.' }];
  const act = await view.act('review-verdict', 'review-verdict', { stage: 'direction-review', verdict: 'approved', comments });
  expect(act.schema).toBe(JOB_COMMENTS_ACT_SCHEMA);
  expect(obj(act.value).comments).toEqual(comments);
  const anchor = obj(arr(obj(act.value).comments)[0]).anchor as JsonObject;
  const pin = obj(obj(anchor.context).comment);
  expect([anchor.frameStart, anchor.frameEnd, pin.frame, pin.time, pin.timeBasis, pin.screen, pin.world]).toEqual(
    [null, null, null, 1.25, TIME_ONLY_BASIS, { x: 40, y: 30, width: 0, height: 0 }, { x: 4, y: 19, width: 0, height: 0 }]);

  const before = readFileSync(join(root, 'project.json'));
  const listed = await cli(root, ['job', 'acts', root, '--json']);
  expectExit0(listed);
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  const row = (JSON.parse(listed.stdout) as { acts: PendingJobAct[] }).acts.find(item => item.actId === act.actId)!;
  expect(JSON.stringify(row.value)).toBe(JSON.stringify(act.value));

  expectExit0(await cli(root, ['review', '2', root, '--from-review', String(act.actId)]));
  const receipt = obj(arr(read(root).review_acts).at(-1));
  const fetched = JSON.parse(String(receipt.bytes)) as JsonObject;
  expect(fetched.actId).toBe(act.actId);
  expect(JSON.stringify(fetched.value)).toBe(JSON.stringify(act.value));
  expect(obj(arr(obj(fetched.value).comments)[0]).anchor).toEqual(anchor);
}, 30_000);
