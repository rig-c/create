import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pendingJobActs } from '../src/job-acts.ts';
import { JOB_BINDING_FILE, writePrivateJson, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { listCreateJobActs } from '../src/job-host.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import type { ActV3, JobOwnerHost, JobHostOptions } from '@rig-c/review/job-host';
import type { JsonObject } from '../src/templates.ts';
import { testClock } from './clock.ts';
import { clockedCli } from './helpers.ts';
const receipt = (row: object) => { if (process.env.JOB_ACTS_RECEIPT) appendFileSync(process.env.JOB_ACTS_RECEIPT, JSON.stringify(row) + '\n'); };
const scrub = (text: string, root: string) => text.replaceAll(root, '<synthetic>').replaceAll(join(import.meta.dir, '..'), '<create-checkout>').replace(/http:\/\/127\.0\.0\.1:\d+[^\s]*/g, '<owner-url>');
const WORDS = '  Synthetic owner review words.\r\n';
const roots: string[] = [];
const opened: { proc: Bun.Subprocess; root: string }[] = [];

afterEach(async () => {
  for (const { proc, root } of opened.splice(0)) {
    if (readWriterBinding(root) && pendingPublications(root).length === 0) {
      await cli(root, ['job', 'close', root]);
    }
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
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

async function open(root: string): Promise<{ url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), ...clockedCli(), 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner'], {
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
  reader.releaseLock();
  const lines = text.trim().split('\n');
  receipt({ command: ['rig-create', 'job', 'open', '<synthetic>', '--reviewer', 'synthetic-owner', '--role', 'owner'], serving: true, lines: lines.slice(1) });
  return { url: new URL(lines[0]!), lines: lines.slice(1) };
}

async function page(root: string, url: URL, expectedAsks = 2) {
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
    && pending().asks.length >= expectedAsks;
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
  } finally { rmSync(bin, { recursive: true, force: true }); }
}

test('job acts discovers a finalized rig verdict and signoff; its exact quoted commands ingest them', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  expectExit0(await cli(root, ['advance', 'rig-review', root, '--json']));
  expect(JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts).toEqual([]);
  const view = await page(root, opening.url);
  const ask = view.asks.find(item => (item.subject as JsonObject).kind === 'review-verdict')!;
  const verdict = await view.act('review-verdict', 'review-verdict', { stage: 'rig-review', verdict: 'approved', words: WORDS }, rigCapture(root, view, String(ask.askId)));
  const before = snapshot(root);
  const listed = await cli(root, ['job', 'acts', root, '--json']);
  expectExit0(listed);
  expect(snapshot(root)).toEqual(before);
  const result = JSON.parse(listed.stdout);
  expect(result.acts).toHaveLength(1);
  expect(result.acts[0]).toMatchObject({ actId: verdict.actId, kind: 'review-verdict', subject: 'rig v1 / rig-review', at: verdict.at,
    args: ['review', '1', root, '--from-review', verdict.actId] });
  const text = await cli(root, ['job', 'acts', root]);
  expectExit0(text); expect(text.stdout).toContain(result.acts[0].command);
  expect(snapshot(root)).toEqual(before);
  await executePrinted(root, result.acts[0].command);
  expect(JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts).toEqual([]);
  const checked = await cli(root, ['interview', '--check', root]); expectExit0(checked);
  expectExit0(await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']));
  const refreshed = await page(root, opening.url);
  const signoff = await refreshed.act('signoff', 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });
  const signing = await cli(root, ['job', 'acts', root, '--json']); expectExit0(signing);
  const row = JSON.parse(signing.stdout).acts[0];
  expect(row).toMatchObject({ actId: signoff.actId, kind: 'signoff', subject: 'stage rig-review', args: ['signoff', 'rig-review', root, '--from-review', signoff.actId] });
  await executePrinted(root, row.command);
  expect(JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts).toEqual([]);
  expect(read(root).stage).toBe('rig-review');
}, 30_000);

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
    expect(cursors).toEqual([null, 'one', 'two']);
  }
  expect(stopped).toBe(true); expect(snapshot(root)).toEqual(before);
});
