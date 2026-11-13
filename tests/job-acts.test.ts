import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectItems } from '../src/check.ts';
import { optionContext } from '../src/choices.ts';
import { fixture, retainSignoffs, arr, obj } from './fixtures.ts';
import { stageIndex } from '../src/stages.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import { nextCommand, nextProject } from '../src/next.ts';
import { pendingJobActs, jobActsText, type PendingJobAct } from '../src/job-acts.ts';
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
const printedBins: string[] = [];

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
    return { stdout, stderr, exit };
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


test('merged record-mode host lists finalized picks and its printed writer command ingests them', async () => {
  testClock.set(Date.now());
  const root = realpathSync(fixture(project => {
    project.stage = 'rigging-interview'; project.versions = []; project.scenes = []; delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex('rigging-interview'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    for (const step of arr(obj(project.plan).steps).map(obj)) if (!['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
  }, 'example-project.json'));
  roots.push(root);
  const project = read(root); const item = collectItems(project, { collection: null }).find(item => item.id === 'motion')!;
  const retained = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(retained.path)), 'utf8')) as JsonObject;
  set.id = 'pending-acts-motion'; set.drafted_at = new Date(testClock.now() - 1000).toISOString();
  set.context = optionContext(project, 'rigging-interview', testClock.now() - 1000, root);
  const path = 'evidence/interview/pending-acts-motion.json';
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  expectExit0(await cli(root, ['interview-options', 'motion', root, '--file', path]));
  const opening = await open(root, ['--question', 'motion']); const view = await page(root, opening.url, 1);
  const selections = (set.asks as JsonObject[]).map(ask => ({ itemId: ask.id, optionId: obj((ask.options as JsonObject[])[0]).id, otherText: null }));
  const act = await view.act('interview-picks', 'interview-picks', { questionId: 'motion', selections, note: WORDS });
  expect(act.schema).toBe('rig-review/act@4');
  const before = snapshot(root); const listed = await cli(root, ['job', 'acts', root, '--json']); expectExit0(listed);
  expect(snapshot(root)).toEqual(before);
  const row = JSON.parse(listed.stdout).acts[0];
  expect(row.args).toEqual(['interview-answer', 'motion', root, '--from-review', act.actId]);
  await executePrinted(root, row.command);
  expect(JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts).toEqual([]);
  expectExit0(await cli(root, ['interview', '--check', root]));
}, 30_000);

test('post scene route: Review pick act, from-review ingestion, scene write without by, check', async () => {
  testClock.set(Date.now());
  const root = copy('4-direction-post');
  expectExit0(await cli(root, ['reopen', 'post-interview', root, '--by', 'user', '--verbatim-file', (() => { const path = join(root, 'reopen.txt'); writeFileSync(path, 'Choose the synthetic two-plate scene.'); return path; })()]));
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
  option.fragment = { scene: { background: { path: 'background.png', rect: model.stage! }, foreground: { path: 'foreground.png', rect: model.stage! } } };
  const path = 'evidence/interview/scene-act-two-plates.json'; writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  expectExit0(await cli(root, ['interview-options', 'post_composition', root, '--file', path]));
  const opening = await open(root, ['--question', 'post_composition']); const view = await page(root, opening.url, 1);
  const act = await view.act('interview-picks', 'interview-picks', { questionId: 'post_composition', selections: [{ itemId: 'post_composition', optionId: 'keep', otherText: null }], note: WORDS });
  expectExit0(await cli(root, ['interview-answer', 'post_composition', root, '--from-review', String(act.actId)]));
  const ingested = obj(collectItems(read(root), { collection: null }).find(i => i.id === 'post_composition')!.raw);
  const citation = { guide: 'post_composition', asks: ['post_composition'], quote: ingested.verbatim! };
  writeFileSync(join(root, 'citations.json'), JSON.stringify({ background: citation, foreground: citation }));
  expectExit0(await cli(root, ['scene', 'write', '--rig', '1', '--background', 'background.png', '--foreground', 'foreground.png', '--citations-file', 'citations.json', root]));
  expect(obj((read(root).scenes as JsonObject[]).at(-1)).by).toBe('agent');
  expectExit0(await cli(root, ['interview', '--check', root]));
}, 30_000);


test('#490 parts signoff prints ordered verdict and structure prerequisites with retained writer flags', async () => {
  testClock.set(Date.now());
  const root = copy('1-parts-verdict');
  const signoff = { jobId: 'synthetic', actId: 'parts-sign', kind: 'signoff', at: testClock.iso(),
    source: { selector: { kind: 'draft', id: 'chain' } }, value: { stage: 'parts-review' } } as unknown as ActV3;
  const [pending] = pendingJobActs(read(root), [signoff], root);
  expect(pending!.args).toEqual(['signoff', 'parts-review', root, '--draft', 'chain', '--structure-file', 'evidence/structure-chain.json', '--from-review', 'parts-sign']);
  expect(pending!.preconditions).toHaveLength(2);
  expect(pending!.preconditions![0]!.command).toBeNull();
  expect(pending!.preconditions![0]!.act).toContain('ingest the approved parts-verdict');
  const text = jobActsText({ acts: [pending!] });
  expect(text.indexOf('ingest the approved parts-verdict')).toBeLessThan(text.indexOf('rig-create structure-snapshot'));
  expect(text.indexOf('rig-create structure-snapshot')).toBeLessThan(text.indexOf('rig-create signoff'));
  recordPartsReceipt(root, 'chain', testClock.now());
  const [ready] = pendingJobActs(read(root), [signoff], root);
  expect(ready!.preconditions).toHaveLength(1);
  await executePrinted(root, ready!.preconditions![0]!.command!);
  expect(pendingJobActs(read(root), [signoff], root)[0]!.preconditions).toBeUndefined();
  // The exact final command needs a real Review act. Open the draft after the
  // prerequisite writes so its source binds the current record.
  expectExit0(await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']));
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expectExit0(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']));
  const opening = await open(root);
  const view = await page(root, opening.url);
  const act = await view.act('signoff', 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });
  const row = pendingJobActs(read(root), [act as unknown as ActV3], root)[0]!;
  expect(row.command).toContain('--structure-file');
  await executePrinted(root, row.command!);
  expect(read(root).signoffs).toContainEqual(expect.objectContaining({ stage: 'parts-review', draft_id: 'chain' }));
  expect(nextProject(root, testClock.now()).refusals.map(row => row.code)).not.toContain('STRUCTURE_DECISIONS_MISSING');
}, 30_000);


/** Execute the surrounding commands from next, with an actual owner-page export in between. */
async function nextReview(root: string, kind: string, value: object, question?: string): Promise<void> {
  const report = nextProject(root, testClock.now());
  expect(report.refusals.filter(row => row.code !== 'INTERVIEW_INCOMPLETE')).toEqual([]);
  const index = report.moves.findIndex(move => move.role === 'human' && move.review_act?.kind === kind
    && (question === undefined || move.review_act.question_id === question));
  expect(index).toBeGreaterThan(0);
  const workflow = report.moves.slice(index - 1, index + 4);
  expect(workflow.map(move => move.role)).toEqual(['agent', 'human', 'agent', 'agent', 'agent']);
  expect(workflow[1]!.command).toBeNull();
  const target = workflow[1]!.review_act!;
  expect(workflow[0]!.command).toContain(question ? `--question ${question}` : target.draft_id ? `--draft ${target.draft_id}`
    : kind === 'review-verdict' || target.stage === 'rig-review' ? `--rig ${target.version_id!.slice(1)}` : '--plan');
  expect(workflow[2]!.command).toBe(`rig-create job acts ${quote(root)} --json`);
  expect(workflow[3]!.command).toContain("--from-review '<actId>'");
  expect(workflow[4]!.command).toBe(`rig-create job close ${quote(root)}`);
  receipt({ rendered: scrub(nextCommand([root], testClock.now()).stdout, root) });
  receipt({ workflow: { stage: target.stage, kind, question, draft: target.draft_id,
    printed: workflow.map(move => ({ role: move.role, command: move.command === null ? null : scrub(move.command, root), act: move.act })) } });
  const opening = await open(root, [], workflow[0]!.command!.replace("'<reviewer>'", "'synthetic-owner'"));
  const view = await page(root, opening.url, 1);
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
  await executePrinted(root, workflow[4]!.command!);
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
])('#507 head picks $checkpoint/$question execute printed host, acts, ingest and close', async ({ checkpoint, question }) => {
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

test('#507 plan-approved signoff executes printed host, acts, ingest and close', async () => {
  receipt({ test: '#507 plan-approved signoff', source: 'checkpoint 0b-plan-pending' });
  const root = copy('0b-plan-pending');
  await nextReview(root, 'signoff', { stage: 'plan-approved', decision: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'plan-approved')).toBe(true);
}, 30_000);

test('#507 reachable interview signoff executes printed host, acts, ingest and close', async () => {
  receipt({ test: '#507 reachable interview signoff', source: 'synthetic fixture from checkpoint 0b-plan-pending' });
  const root = copy('0b-plan-pending', project => {
    project.stage = 'interview'; project.signoffs = []; project.advances = [];
  });
  await nextReview(root, 'signoff', { stage: 'interview', decision: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'interview')).toBe(true);
}, 30_000);

test('#507 parts verdict then reachable parts-review signoff execute printed commands; checkpoint remains unanswered', async () => {
  receipt({ test: '#507 parts verdict then reachable parts-review signoff', source: 'checkpoint 1-parts-verdict then writer-prepared synthetic fixture' });
  const root = copy('1-parts-verdict');
  const before = nextProject(root, testClock.now());
  const unanswered = before.moves.find(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'parts-review')!;
  expect(unanswered).toMatchObject({ role: 'human', command: null,
    unanswered_by_record: 'review_acts[kind=parts-verdict,draft_id=chain], evidence/structure-chain.json' });
  expect(unanswered.act).toContain('unanswered by record');
  receipt({ checkpoint: '1-parts-verdict', stage: 'parts-review', prints_commands: false, move: unanswered });
  await nextReview(root, 'parts-verdict', { verdict: 'approved', issues: [], words: WORDS });
  const advance = nextProject(root, testClock.now()).moves.find(move => move.command?.startsWith('rig-create advance parts-review'))!;
  await executePrinted(root, advance.command!);
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expectExit0(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']));
  const ready = nextProject(root, testClock.now());
  expect(ready.moves.find(move => move.review_act?.kind === 'signoff')!.unanswered_by_record).toBeUndefined();
  // next and job acts share the retained-name selection, including collision handling.
  const snapshot = ready.moves.find(move => move.command?.startsWith('rig-create structure-snapshot'))!;
  await executePrinted(root, snapshot.command!);
  await nextReview(root, 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj)).toContainEqual(expect.objectContaining({ stage: 'parts-review', draft_id: 'chain' }));
}, 30_000);

test('#507 reachable rigging-interview signoff executes printed host, acts, ingest and close', async () => {
  receipt({ test: '#507 reachable rigging-interview signoff', source: 'synthetic fixture from checkpoint 3-rig-review; checkpoint 2-rigging-answers observed separately' });
  const checkpoint = copy('2-rigging-answers');
  const observed = nextProject(checkpoint, testClock.now());
  const signoff = observed.moves.find(move => move.review_act?.kind === 'signoff')!;
  receipt({ checkpoint: '2-rigging-answers', stage: 'rigging-interview',
    prints_commands: observed.moves.some(move => move.command?.includes('signoff rigging-interview') && move.command.includes('--from-review')), move: signoff });
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging-interview'; project.versions = [];
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('rigging-interview'));
    for (const step of arr(obj(project.plan).steps).map(obj).filter(step => ['bones', 'meshes', 'constraints', 'motion'].includes(String(step.id)))) {
      step.status = 'pending'; delete step.status_history;
    }
  });
  await nextReview(root, 'signoff', { stage: 'rigging-interview', decision: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'rigging-interview')).toBe(true);
}, 30_000);

test('#507 rig-review verdict then signoff execute printed host, acts, ingest and close', async () => {
  receipt({ test: '#507 rig-review verdict then signoff', source: 'checkpoint 3-rig-review' });
  const root = copy('3-rig-review');
  await nextReview(root, 'review-verdict', { stage: 'rig-review', verdict: 'approved', words: WORDS });
  await nextReview(root, 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'rig-review')).toBe(true);
}, 30_000);

test('#502 all post-interview picks and plan signoff execute next host, exported-act ingest and close commands', async () => {
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
  for (const question of ['camera_depth', 'post_timing', 'post_composition']) {
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
  }
  const composition = nextProject(root, testClock.now()).moves.find(move => move.command?.startsWith('rig-create plan add composition'))!;
  expect(composition.command).toContain('--rests-on post_composition');
  await executePrinted(root, composition.command!.replace("'<work>'", "'Write the approved composition scene'")
    .replace("'<result>'", "'A cited scene document'").replace("'<acceptance bar>'", "'Roles and rects match the approved choice'"));
  await nextReview(root, 'signoff', { stage: 'post-interview', decision: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'post-interview')).toBe(true);
}, 30_000);

test('#502 direction verdict then record signoff execute next host, exported-act ingest and close commands', async () => {
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
  await nextReview(root, 'signoff', { stage: 'direction-review', decision: 'approved', words: WORDS });
  const advance = nextProject(root, testClock.now()).moves.find(move => move.command?.startsWith('rig-create advance accepted'))!;
  await executePrinted(root, advance.command!);
  expect(nextProject(root, testClock.now()).accepted).toBe(true);
}, 30_000);
