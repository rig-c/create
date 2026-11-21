import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkProject, collectItems } from '../src/check.ts';
import { optionContext } from '../src/choices.ts';
import { plantLegacyReopen, fixture, retainSignoffs, arr, obj } from './fixtures.ts';
import { stageIndex } from '../src/stages.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import { nextCommand, nextProject } from '../src/next.ts';
import { pendingJobActs, pendingJobAsksForTarget, jobActsText, shellWord, type PendingJobAct } from '../src/job-acts.ts';
import { amendCommand } from './clock.ts';
import type { PendingAskV3 } from '@rig-c/review/job-host';
import { JOB_BINDING_FILE, writePrivateJson, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv, prepareVersionIntent } from '../src/job-writer.ts';
import { listCreateJobActs } from '../src/job-host.ts';
import { assertNoPendingJobAsk } from '../src/job-close.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import { startJobHost, type ActV3, type JobOwnerHost, type JobHostOptions } from '@rig-c/review/job-host';
import type { Json, JsonObject } from '../src/templates.ts';
import { testClock } from './clock.ts';
import { EXAMPLE_NOW, EXAMPLE_REOPEN_AT } from '../scripts/example-time.ts';
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

test('#789 job acts shows record checkpoint and signoff words labels byte-for-byte in text and JSON', async () => {
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
  const opening = await open(root, ['--plan']);
  const view = await page(root, opening.url, 1, 'checkpoint');
  const label = `["rig-review-comment/1","setup","reference","evidence/setup.png","${'a'.repeat(64)}",10,21,8,3]`;
  const words = `[${label}]\nFix this reference region.\n\n[general]\nApprove assemble checkpoint.`;
  const checkpoint = await view.act('checkpoint', 'checkpoint', {
    checkpointId: 'assemble',
    outcome: 'pass',
    words,
  });
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

  // Record signoff act words also print byte-for-byte in text and JSON.
  const signoffRoot = copy('0b-plan-pending');
  const signoffOpening = await open(signoffRoot, ['--plan']);
  const signoffView = await page(signoffRoot, signoffOpening.url, 1, 'signoff');
  const pointLabel = `["rig-review-comment/1","setup","reference","evidence/setup.png","${'b'.repeat(64)}",32,4,0,0]`;
  const signoffWords = `[${pointLabel}]\nApprove the plan picture point.`;
  const signoff = await signoffView.act('signoff', 'signoff', {
    stage: 'plan-approved',
    decision: 'approved',
    words: signoffWords,
  });
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

  // Record interview-picks act words also print byte-for-byte in text and JSON and ingest cleanly.
  const { root: picksRoot, view: picksView, value: picksValue } = await openMotionQuestion();
  const picksLabel = `["rig-review-comment/1","setup","reference","evidence/setup.png","${'c'.repeat(64)}",14,28,40,30]`;
  const picksWords = `[${picksLabel}]\nPin on the interview question image.`;
  const picksAct = await picksView.act('interview-picks', 'interview-picks', {
    ...picksValue,
    words: picksWords,
  });
  expect(picksAct.schema).toBe('rig-review/act@4');
  const picksJson = await cli(picksRoot, ['job', 'acts', picksRoot, '--json']);
  expectExit0(picksJson);
  const picksParsed = JSON.parse(picksJson.stdout) as { acts: PendingJobAct[] };
  expect(picksParsed.acts).toHaveLength(1);
  expect((picksParsed.acts[0]!.value as { words?: string }).words).toBe(picksWords);
  expect(JSON.stringify(picksParsed.acts[0]!.value)).toBe(JSON.stringify(picksAct.value));

  const picksText = await cli(picksRoot, ['job', 'acts', picksRoot]);
  expectExit0(picksText);
  expect(picksText.stdout).toContain([
    `${String(picksAct.actId)} interview-picks question motion at ${String(picksAct.at)}`,
    `  words: ${picksWords}`,
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


function riggingInterviewRoot(): string {
  testClock.set(Date.now());
  const root = realpathSync(fixture(project => {
    project.stage = 'rigging-interview'; project.versions = []; project.scenes = []; delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex('rigging-interview'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    for (const step of arr(obj(project.plan).steps).map(obj)) if (!['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
  }, 'example-project.json'));
  roots.push(root);
  return root;
}

/** Register a fresh pending option set for one rigging question; returns the page value that answers it. */
async function registerQuestion(root: string, question: string) {
  const project = read(root); const item = collectItems(project, { collection: null }).find(item => item.id === question)!;
  const retained = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(retained.path)), 'utf8')) as JsonObject;
  set.id = `pending-acts-${question}`; set.drafted_at = new Date(testClock.now() - 1000).toISOString();
  set.context = optionContext(project, 'rigging-interview', testClock.now() - 1000, root);
  const path = `evidence/interview/pending-acts-${question}.json`;
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  expectExit0(await cli(root, ['interview-options', question, root, '--file', path]));
  const selections = (set.asks as JsonObject[]).map(ask => ({ itemId: ask.id, optionId: obj((ask.options as JsonObject[])[0]).id, otherText: null }));
  return { questionId: question, selections, note: WORDS };
}

async function openMotionQuestion(also: string[] = []) {
  const root = riggingInterviewRoot();
  const value = await registerQuestion(root, 'motion');
  const others = [];
  for (const question of also) others.push(await registerQuestion(root, question));
  const opening = await open(root, ['--question', 'motion']); const view = await page(root, opening.url, 1);
  return { root, url: opening.url, view, value, others };
}

test('merged record-mode host lists finalized picks and its printed writer command ingests them', async () => {
  const { root, view, value } = await openMotionQuestion();
  const act = await view.act('interview-picks', 'interview-picks', value);
  expect(act.schema).toBe('rig-review/act@4');
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
  expect(report.moves.filter(move => move.command?.includes('--question motion') || move.review_act?.question_id === 'motion')).toEqual([]);
  expect(report.answers!.find(answer => answer.question_id === 'motion')).toMatchObject({ field: 'interview.waypoints[motion].guide', at: act.at });
  expectExit0(await cli(root, ['interview', '--check', root]));
}, 30_000);

test('#737 a second --question refuses JOB_ASK_PENDING while the first ask is open, keeps its answer, and publishes after ingest', async () => {
  const { root, url, view, value, others: [bones] } = await openMotionQuestion(['bones']);
  // Re-opening the pending question itself is not a second ask.
  const same = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'motion']);
  expectExit0(same);
  expect(same.stdout).toContain('job: option-set motion/pending-acts-motion already published');
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
  expect(next.stdout).toContain('job: option-set bones/pending-acts-bones published');
  const bonesView = await page(root, url, 1);
  const bonesAct = await bonesView.act('interview-picks', 'interview-picks', bones!);
  const after = JSON.parse((await cli(root, ['job', 'acts', root, '--json'])).stdout).acts as PendingJobAct[];
  expect(after.map(row => row.actId)).toEqual([String(bonesAct.actId)]);
}, 60_000);

/** Record the owner's chat answer for the question's registered pending set, as AGENTS.md goal 3 allows. */
async function ownerChatAnswer(root: string, value: { questionId: string; selections: { itemId: Json; optionId: Json }[] }) {
  const binding = obj(collectItems(read(root), { collection: null }).find(item => item.id === value.questionId)!.record.pending_options);
  const words = join(root, `owner-words-${value.questionId}.txt`);
  writeFileSync(words, 'Synthetic owner chat words.\n');
  expectExit0(await cli(root, ['interview-answer', value.questionId, root, '--set', String(binding.path), '--sha256', String(binding.sha256),
    '--by', 'user', '--owner-chat', words, '--said-at', new Date(testClock.now() - 500).toISOString(), '--relayed-by', 'synthetic-operator',
    ...value.selections.flatMap(row => ['--pick', `${String(row.itemId)}=${String(row.optionId)}`])]));
}

test('#737 an owner-chat answer for the published set settles its ask, so the next --question publishes', async () => {
  const { root, value } = await openMotionQuestion(['bones']);
  await ownerChatAnswer(root, value);
  const next = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'bones']);
  expectExit0(next);
  expect(next.stdout).toContain('job: option-set bones/pending-acts-bones published');
}, 60_000);

test('#737 an owner-chat answer bound to a different set leaves the published ask open', async () => {
  const { root } = await openMotionQuestion(['bones']);
  // Register a second motion set after the first was published, then answer that one in chat.
  const project = read(root); const item = collectItems(project, { collection: null }).find(item => item.id === 'motion')!;
  const shown = JSON.parse(readFileSync(join(root, String(obj(item.record.pending_options).path)), 'utf8')) as JsonObject;
  shown.id = 'pending-acts-motion-chat'; shown.drafted_at = new Date(testClock.now() - 900).toISOString();
  const path = 'evidence/interview/pending-acts-motion-chat.json';
  writeFileSync(join(root, path), JSON.stringify(shown, null, 2) + '\n');
  expectExit0(await cli(root, ['interview-options', 'motion', root, '--file', path]));
  const selections = (shown.asks as JsonObject[]).map(ask => ({ itemId: ask.id, optionId: obj((ask.options as JsonObject[])[0]).id }));
  await ownerChatAnswer(root, { questionId: 'motion', selections });
  const before = snapshot(root);
  const refused = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'bones']);
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toMatch(/^JOB_ASK_PENDING: .*interview-picks motion\/pending-acts-motion on /);
  expect(snapshot(root)).toEqual(before);
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
  { label: '--draft', selector: ['--draft', 'chain'], expected: 'job: draft chain published' },
  { label: '--rig', selector: ['--rig', '1'], expected: 'job: rig v1 published' },
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
  expect(published.stdout).toContain(expected);
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
  expect(opening.lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain']);
  await page(root, opening.url, 1, 'parts-verdict');

  // Unanswered earlier-draft ask allows the replacement draft to publish over it.
  const republished = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--draft', 'next']);
  expectExit0(republished);
  expect(republished.stdout).toContain('job: draft next published');
  expect(republished.stdout).toContain('job: asked parts-verdict next');

  // Once the owner answers a draft ask, an un-ingested act refuses another draft publication.
  const nextView = await page(root, opening.url, 1, 'parts-verdict');
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
  const root = copy('4-direction-post');
  const reopenWords = join(root, 'reopen.txt');
  writeFileSync(reopenWords, 'Choose the synthetic two-plate scene.');
  plantLegacyReopen(root, 'post-interview', { by: 'user', wordsFile: reopenWords });
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
  // The exact final command needs a real Review act. Open the draft after the
  // prerequisite writes so its source binds the current record.
  expectExit0(await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']));
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expectExit0(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']));
  const opening = await open(root);
  const view = await page(root, opening.url, 1);
  const act = await view.act('signoff', 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });
  const row = pendingJobActs(read(root), [act as unknown as ActV3], root)[0]!;
  expect(row.command).toContain('--structure-file');
  await executePrinted(root, row.command!);
  expect(read(root).signoffs).toContainEqual(expect.objectContaining({ stage: 'parts-review', draft_id: 'chain' }));
  expect(nextProject(root, testClock.now()).refusals.map(row => row.code)).not.toContain('STRUCTURE_DECISIONS_MISSING');
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

test('#507 plan-approved signoff executes printed host, acts and ingest', async () => {
  receipt({ test: '#507 plan-approved signoff', source: 'checkpoint 0b-plan-pending' });
  const root = copy('0b-plan-pending');
  await nextReview(root, 'signoff', { stage: 'plan-approved', decision: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'plan-approved')).toBe(true);
}, 30_000);

test('#507 reachable interview signoff executes printed host, acts and ingest', async () => {
  receipt({ test: '#507 reachable interview signoff', source: 'synthetic fixture from checkpoint 0b-plan-pending' });
  const root = copy('0b-plan-pending', project => {
    project.stage = 'interview'; project.signoffs = []; project.advances = [];
  });
  await nextReview(root, 'signoff', { stage: 'interview', decision: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'interview')).toBe(true);
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

test('#507 reachable rigging-interview signoff executes printed host, acts and ingest', async () => {
  receipt({ test: '#507 reachable rigging-interview signoff', source: 'synthetic fixture from checkpoint 3-rig-review; checkpoint 2-rigging-answers observed separately' });
  const checkpoint = copy('2-rigging-answers');
  const observed = nextProject(checkpoint, testClock.now());
  const signoff = observed.moves.find(move => move.review_act?.kind === 'signoff')!;
  receipt({ checkpoint: '2-rigging-answers', stage: 'rigging-interview',
    prints_commands: observed.moves.some(move => move.command?.includes('signoff rigging-interview') && move.command.includes('--from-review')), move: signoff });
  const root = unsignedRiggingInterview();
  await nextReview(root, 'signoff', { stage: 'rigging-interview', decision: 'approved', words: WORDS });
  expect(arr(read(root).signoffs).map(obj).some(row => row.stage === 'rigging-interview')).toBe(true);
}, 30_000);

test('#711 relayed rigging-interview signoff unblocks draft publication on the same Review host', async () => {
  const root = unsignedRiggingInterview();
  const fixture = read(root);
  const bones = arr(obj(fixture.plan).steps).map(obj).find(step => step.id === 'bones')!;
  bones.checkpoint_proposed = true;
  obj(bones.checkpoint).value = true;
  write(root, fixture);
  const opening = await open(root, ['--plan']);
  const plan = await page(root, opening.url, 1, 'signoff');
  expect(plan.asks.map(ask => ask.subject)).toEqual([{ kind: 'signoff', stage: 'rigging-interview' }]);
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
  const next = await page(root, opening.url, 2, 'checkpoint');
  expect(next.head.publicationId).not.toBe(plan.head.publicationId);
  expect(next.asks.map(ask => ask.subject)).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
    { kind: 'checkpoint', checkpointId: 'bones' },
  ]);
  expect(next.asks.find(ask => obj(ask.subject).kind === 'review-verdict')?.source).toMatchObject({ selector: draft });
  expect(readWriterBinding(root)).toEqual(binding);
  expect(pid()).toBe(originalPid);
  const db = new Database(join(binding.identity.stateDir, 'jobs.sqlite'), { readonly: true });
  try {
    const row = db.query<{ status: string }, [string, string]>(
      "SELECT value ->> '$.status' AS status FROM jobs, json_each(document, '$.asks') WHERE job_id = ? AND key = ?",
    ).get(binding.jobId, String(plan.asks[0]!.askId));
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

test('#502 direction verdict then record signoff execute next host and exported-act ingest commands', async () => {
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

test('#556 job close refuses un-ingested acts byte-identically, closes after ingest, and records discarded acts with a reason', async () => {
  testClock.set(EXAMPLE_NOW);
  const root = copy('0b-plan-pending');

  // 1. A job with no acts closes as before and leaves project.json byte-identical.
  const emptyOpen = await open(root, ['--plan']);
  const emptyBefore = readFileSync(join(root, 'project.json'));
  const emptyClose = await cli(root, ['job', 'close', root]);
  expectExit0(emptyClose);
  expect(emptyClose.stdout.trim()).toBe('job: closed');
  await emptyOpen.proc.exited;
  expect(readWriterBinding(root)).toBeNull();
  expect(readFileSync(join(root, 'project.json'))).toEqual(emptyBefore);

  // 2. An un-ingested finalized act refuses with JOB_ACTS_PENDING, names the act id and ingest command,
  // and leaves both the binding and project.json byte-identical; after ingest, close succeeds.
  const firstOpen = await open(root, ['--plan']);
  const firstView = await page(root, firstOpen.url, 1, 'signoff');
  const firstAct = await firstView.act('signoff', 'signoff', { stage: 'plan-approved', decision: 'approved', words: WORDS });
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
  const discardRoot = copy('0b-plan-pending');
  const secondOpen = await open(discardRoot, ['--plan']);
  const secondView = await page(discardRoot, secondOpen.url, 1, 'signoff');
  const droppedAct = await secondView.act('signoff', 'signoff', { stage: 'plan-approved', decision: 'approved', words: WORDS });
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
  expect(reask.moves).toContainEqual(expect.objectContaining({ role: 'human', review_act: expect.objectContaining({ kind: 'signoff', stage: 'plan-approved' }) }));

  const thirdOpen = await open(discardRoot, ['--plan']);
  const thirdView = await page(discardRoot, thirdOpen.url, 1, 'signoff');
  const freshAct = await thirdView.act('signoff', 'signoff', { stage: 'plan-approved', decision: 'approved', words: WORDS });
  expect(freshAct.jobId).not.toBe(droppedAct.jobId);
  const beforeReplay = readFileSync(join(discardRoot, 'project.json'));
  const beforeReplayBinding = readFileSync(discardBindingPath);
  const replay = await cli(discardRoot, ['signoff', 'plan-approved', discardRoot, '--from-review', String(droppedAct.actId)]);
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
  expect(opening.lines).toEqual(['job: post v2 published', 'job: asked review-verdict direction-review']);
  const binding = readWriterBinding(root)!;
  const firstView = await page(root, opening.url, 1, 'review-verdict');
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
