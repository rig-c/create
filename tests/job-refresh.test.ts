import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProject as rawCheckProject } from '../src/check.ts';
import { jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { testClock } from './clock.ts';
import { clockedCli } from './helpers.ts';
import { reviewActFindings } from '../src/review-act.ts';

const WORDS = '  Synthetic owner review words.\r\n';
// Measured 2.59s–3.67s per multi-spawn CLI + live host flow locally; 15_000ms tier avoids 5s default timeout flakes under load.
const REFRESH_FLOW_TIMEOUT_MS = 15_000;
const roots: string[] = [];
const opened: { proc: Bun.Subprocess; root: string }[] = [];
const checkProject = (dir: string, candidate?: JsonObject, _options?: { now: number }) =>
  rawCheckProject(dir, candidate, { now: testClock.now() });

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-refresh-')));
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
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), ...clockedCli(), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

async function open(root: string, options: string[] = []): Promise<{ url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), ...clockedCli(), 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...options], {
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
  if (!text.trim()) throw new Error(await new Response(proc.stderr).text());
  const lines = text.trim().split('\n');
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

test('#475 source-linked clean interview record signoff ingests advances and offers plan-approved', async () => {
  const root = copy('0b-plan-pending', project => {
    project.stage = 'interview'; project.signoffs = []; project.advances = [];
  });
  expectExit0(await cli(root, ['interview', '--check', root]));
  const opening = await open(root, ['--plan']);
  const view = await page(root, opening.url, 1);
  expect(view.asks.map(ask => ask.subject)).toEqual([{ kind: 'signoff', stage: 'interview' }]);
  expect((view.head.source as JsonObject).subject).toBe('plan');
  const displayed = read(root);
  const planBefore = structuredClone(displayed.plan);
  const signed = await view.act('signoff', 'signoff', { stage: 'interview', decision: 'approved', words: WORDS });
  expect(signed.schema).toBe('rig-review/act@4');
  expect((signed.source as JsonObject).projectHash).toBe(jobHash(readFileSync(join(root, 'project.json'))));
  expectExit0(await cli(root, ['signoff', 'interview', root, '--from-review', String(signed.actId)]));
  expect(read(root).stage).toBe('interview');
  expect(read(root).plan).toEqual(planBefore);
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({ stage: 'interview', by: 'user', verbatim: WORDS });
  expect(reviewActFindings(read(root))).toEqual([]);
  expectExit0(await cli(root, ['advance', 'plan-approved', root, '--json']));
  const advanced = readFileSync(join(root, 'project.json'));
  expectExit0(await cli(root, ['signoff', 'interview', root, '--from-review', String(signed.actId)]));
  expect(readFileSync(join(root, 'project.json'))).toEqual(advanced);
  const next = await cli(root, ['next', root, '--json']);
  expectExit0(next);
  const report = JSON.parse(next.stdout) as { moves: JsonObject[] };
  expect(report.moves).toContainEqual(expect.objectContaining({ command: null, review_act: expect.objectContaining({ kind: 'signoff', stage: 'plan-approved' }) }));
  expectExit0(await cli(root, ['job', 'open', root, '--plan', '--reviewer', 'synthetic-owner', '--role', 'owner']));
  const approvalPage = await page(root, opening.url, 1);
  expect(approvalPage.asks.map(ask => ask.subject)).toEqual([{ kind: 'signoff', stage: 'plan-approved' }]);
}, REFRESH_FLOW_TIMEOUT_MS);

test('parts-review verdict -> ingest -> triage -> job open refresh -> UI signoff -> ingest succeeds after JOB_RECORD_MOVED on the pre-triage publication', async () => {
  const root = copy('1-parts-verdict');
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expectExit0(await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']));
  expectExit0(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']));

  const opening = await open(root);
  expect(opening.lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain, signoff parts-review']);

  const firstView = await page(root, opening.url);
  const verdict = await firstView.act('parts-verdict', 'parts-verdict', {
    verdict: 'approved',
    issues: [],
    words: WORDS,
  });

  expectExit0(await cli(root, ['parts-review', root, '--from-review', String(verdict.actId), '--json']));
  expectExit0(await cli(root, ['structure-snapshot', root, '--draft', 'chain', '--out', 'evidence/structure.json']));

  // The pre-ingest publication now has an old projectHash, so UI signoff on it is refused as JOB_RECORD_MOVED.
  const staleSignoff = await firstView.tryAct('signoff', 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });
  expect((staleSignoff.error as JsonObject | undefined)?.code).toBe('JOB_RECORD_MOVED');

  // Refresh via job open republishes the draft over the current project.json and asks the remaining signoff subject.
  const refreshed = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expectExit0(refreshed);
  expect(refreshed.stdout.trim().split('\n')).toEqual([
    opening.url.href,
    'job: draft chain published',
    'job: asked signoff parts-review',
  ]);

  const refreshedView = await page(root, opening.url, 1);
  expect(refreshedView.head.publicationId).not.toBe(firstView.head.publicationId);
  expect((refreshedView.head.source as JsonObject).selector).toEqual({ kind: 'draft', id: 'chain' });
  expect((refreshedView.head.source as JsonObject).projectHash).toBe(jobHash(readFileSync(join(root, 'project.json'))));

  const signed = await refreshedView.act('signoff', 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });
  const signoffRes = await cli(root, ['signoff', 'parts-review', root, '--from-review', String(signed.actId), '--structure-file', 'evidence/structure.json', '--json']);
  expectExit0(signoffRes);
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({
    stage: 'parts-review',
    checkpoint: null,
    by: 'user',
    verbatim: `[general]\n${WORDS}`,
    draft_id: 'chain',
    source: `review act ${String(signed.jobId)}/${String(signed.actId)}`,
  });
}, REFRESH_FLOW_TIMEOUT_MS);

test('rig-review verdict -> ingest -> job open refresh -> UI signoff -> ingest preserves rig selector, updates projectHash, and keeps stale/authority guards', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  expectExit0(await cli(root, ['advance', 'rig-review', root, '--json']));

  const firstView = await page(root, opening.url);
  expect((firstView.head.source as JsonObject).selector).toEqual({ kind: 'rig', version: 1 });
  const verdictAsk = firstView.asks.find(item => (item.subject as JsonObject).kind === 'review-verdict')!;
  const verdict = await firstView.act(
    'review-verdict',
    'review-verdict',
    { stage: 'rig-review', verdict: 'approved', words: WORDS },
    rigCapture(root, firstView, String(verdictAsk.askId)),
  );

  const reviewed = await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json']);
  expectExit0(reviewed);

  // Submitting signoff on the pre-verdict publication fails with JOB_RECORD_MOVED because review modified project.json.
  const staleSignoff = await firstView.tryAct('signoff', 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });
  expect((staleSignoff.error as JsonObject | undefined)?.code).toBe('JOB_RECORD_MOVED');

  // Refresh via job open republishes rig v1 with the current project.json hash and asks the remaining signoff subject.
  const refreshed = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expectExit0(refreshed);
  expect(refreshed.stdout.trim().split('\n')).toEqual([
    opening.url.href,
    'job: rig v1 published',
    'job: asked signoff rig-review',
  ]);

  // Re-opening again when project.json has not moved reuses the refreshed head without republishing.
  const reused = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expectExit0(reused);
  expect(reused.stdout.trim().split('\n')).toEqual([
    opening.url.href,
    'job: rig v1 already published',
    'job: already asked signoff rig-review',
  ]);

  const refreshedView = await page(root, opening.url, 1);
  expect(refreshedView.head.publicationId).not.toBe(firstView.head.publicationId);
  expect((refreshedView.head.source as JsonObject).selector).toEqual({ kind: 'rig', version: 1 });
  expect((refreshedView.head.source as JsonObject).projectHash).toBe(jobHash(readFileSync(join(root, 'project.json'))));
  expect(refreshedView.asks.map(ask => ask.subject)).toEqual([
    { kind: 'signoff', stage: 'rig-review' },
  ]);

  const signed = await refreshedView.act('signoff', 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });

  // Negative guards: wrong version, wrong stage, or competing authority flags refuse and leave project.json byte-identical.
  const beforeSignoffBytes = readFileSync(join(root, 'project.json'));
  const wrongVersion = await cli(root, ['signoff', 'rig-review', root, '--from-review', String(signed.actId), '--version', '2']);
  expect({ exit: wrongVersion.exit, stderr: wrongVersion.stderr }).toEqual({
    exit: 1,
    stderr: expect.stringContaining('REVIEW_ACT_TARGET_MISMATCH:'),
  });
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeSignoffBytes);

  const wrongStage = await cli(root, ['signoff', 'direction-review', root, '--from-review', String(signed.actId)]);
  expect({ exit: wrongStage.exit, stderr: wrongStage.stderr }).toEqual({
    exit: 1,
    stderr: expect.stringContaining('REVIEW_ACT_KIND_MISMATCH:'),
  });
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeSignoffBytes);

  const mixedBy = await cli(root, ['signoff', 'rig-review', root, '--from-review', String(signed.actId), '--by', 'user']);
  expect({ exit: mixedBy.exit, stderr: mixedBy.stderr }).toEqual({
    exit: 2,
    stderr: expect.stringContaining('SIGNOFF_OPTION_INVALID:'),
  });
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeSignoffBytes);

  // Valid signoff ingest succeeds and records target.version = 1.
  const signoffRes = await cli(root, ['signoff', 'rig-review', root, '--from-review', String(signed.actId), '--json']);
  expectExit0(signoffRes);
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({
    stage: 'rig-review',
    checkpoint: null,
    by: 'user',
    verbatim: `[general]\n${WORDS}`,
    target: { version: 1 },
    source: `review act ${String(signed.jobId)}/${String(signed.actId)}`,
  });

  // Replay of the earlier verdict act still succeeds without rewriting project.json, and corrupting a bound source refuses REVIEW_ACT_SOURCE_STALE.
  const afterSignoffBytes = readFileSync(join(root, 'project.json'));
  const replayVerdict = await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json']);
  expectExit0(replayVerdict);
  expect(readFileSync(join(root, 'project.json'))).toEqual(afterSignoffBytes);

  const modelPath = join(root, 'derived/review/v1/out/check/build/skeleton.model.json');
  const savedModel = readFileSync(modelPath);
  writeFileSync(modelPath, '{}\n');
  try {
    const staleReplay = await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json']);
    expect({ exit: staleReplay.exit, stderr: staleReplay.stderr }).toEqual({
      exit: 1,
      stderr: expect.stringContaining('REVIEW_ACT_SOURCE_STALE:'),
    });
    expect(readFileSync(join(root, 'project.json'))).toEqual(afterSignoffBytes);
  } finally {
    writeFileSync(modelPath, savedModel);
  }

  const report = checkProject(root, undefined, { now: Date.now() });
  expect(report.refusals.map(f => f.code)).toEqual(['STAGE_LAGGING']);
  expect(report.holes ?? []).toEqual([]);
}, REFRESH_FLOW_TIMEOUT_MS);

test('#467 source-linked direction verdict then record sign-off ingests and advances accepted', async () => {
  const historyWords = `Synthetic direction history. ${'retained review words. '.repeat(400)}`;
  const root = copy('example-chain', project => {
    project.stage = 'post';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'direction-review' && entry.stage !== 'accepted');
    project.signoffs = (project.signoffs as JsonObject[]).filter(entry => entry.stage !== 'direction-review');
    const postVersion = (project.versions as JsonObject[]).find(v => v.n === 2)!;
    postVersion.verdicts = Array.from({ length: 64 }, (_, index) => ({ by: 'user', at: postVersion.at!,
      review: 'direction-review', verdict: 'provisional', verbatim: `${index}: ${historyWords}`, source: 'synthetic history', on_items: [] }));
  });
  const opening = await open(root, ['--plan']);
  expectExit0(await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', '2']));
  expectExit0(await cli(root, ['advance', 'direction-review', root, '--json']));

  const firstView = await page(root, opening.url, 1);
  expect((firstView.head.source as JsonObject).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  expect(firstView.asks.map(ask => ask.subject)).toEqual([{ kind: 'review-verdict', stage: 'direction-review' }]);
  const verdict = await firstView.act('review-verdict', 'review-verdict', { stage: 'direction-review', verdict: 'approved', words: WORDS });

  const reviewed = await cli(root, ['review', '2', root, '--from-review', String(verdict.actId), '--json']);
  expectExit0(reviewed);

  // Refresh the post page after ingest; its verdict is already recorded, so no subject is declared.
  const refreshed = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', 'v2']);
  expectExit0(refreshed);
  expect(refreshed.stdout.trim().split('\n')).toEqual([
    opening.url.href,
    'job: post v2 published',
  ]);

  const refreshedView = await page(root, opening.url, 0);
  expect(refreshedView.asks.map(ask => ask.subject)).toEqual([]);
  expect(refreshedView.head.publicationId).not.toBe(firstView.head.publicationId);
  expect((refreshedView.head.source as JsonObject).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  expect((refreshedView.head.source as JsonObject).projectHash).toBe(jobHash(readFileSync(join(root, 'project.json'))));

  const reused = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', '2']);
  expectExit0(reused);
  expect(reused.stdout).toContain('job: post v2 already published');
  expect((await page(root, opening.url, 0)).head.publicationId).toBe(refreshedView.head.publicationId);

  const record = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--plan']);
  expectExit0(record);
  expect(record.stdout.trim().split('\n')).toEqual([opening.url.href, 'job: plan published', 'job: asked signoff direction-review']);
  const recordView = await page(root, opening.url, 1);
  expect((recordView.head.source as JsonObject).subject).toBe('plan');
  expect((recordView.head.source as JsonObject).selector).toBeUndefined();
  expect((recordView.head.source as JsonObject).subjects).toEqual([{ kind: 'signoff', stage: 'direction-review' }]);
  expect(recordView.asks.map(ask => ask.subject)).toEqual([{ kind: 'signoff', stage: 'direction-review' }]);
  const signed = await recordView.act('signoff', 'signoff', { stage: 'direction-review', decision: 'approved', words: WORDS });
  expect(signed.schema).toBe('rig-review/act@4');
  expect((signed.source as JsonObject).selector).toBeUndefined();
  const original = readFileSync(join(root, 'project.json'));
  expect(original.length).toBeGreaterThan(512_000);
  writeFileSync(join(root, 'project.json'), Buffer.concat([original, Buffer.from(' ')]));
  const staleBytes = readFileSync(join(root, 'project.json'));
  const stale = await cli(root, ['signoff', 'direction-review', root, '--from-review', String(signed.actId)]);
  expect(stale.exit).toBe(1);
  expect(stale.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(staleBytes);
  writeFileSync(join(root, 'project.json'), original);
  const wrongVersion = await cli(root, ['signoff', 'direction-review', root, '--from-review', String(signed.actId), '--version', '1']);
  expect(wrongVersion.exit).toBe(1);
  expect(wrongVersion.stderr).toContain('REVIEW_ACT_TARGET_MISMATCH:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(original);
  expectExit0(await cli(root, ['signoff', 'direction-review', root, '--from-review', String(signed.actId)]));
  const saved = read(root);
  const target = (saved.signoffs as JsonObject[]).at(-1)!.target as JsonObject;
  expect(target.version).toBe(2);
  const signedBytes = readFileSync(join(root, 'project.json'));
  const growth = signedBytes.length - original.length;
  expect(growth).toBeGreaterThan(0);
  expect(growth).toBeLessThan(32_768);
  expect(growth).toBeLessThan(original.length / 10);
  const receipt = (saved.review_acts as JsonObject[]).find(entry => entry.actId === signed.actId)!;
  expect(receipt.record_bytes).toBeUndefined();
  expect(JSON.stringify(receipt)).not.toContain(historyWords);
  expect(receipt.record_sha256).toBe(jobHash(original));
  expect(receipt.record_sha256).toBe((signed.source as JsonObject).projectHash);
  expect(receipt.target_version).toBe(target.version);
  expect(receipt.verdict).toBe(target.verdict);
  console.log(JSON.stringify({ evidence: '#467 compact direction receipt growth', before_bytes: original.length,
    after_bytes: signedBytes.length, delta_bytes: growth }));
  expect(reviewActFindings(saved)).toEqual([]);
  const later = structuredClone(saved);
  (later.versions as JsonObject[]).push({ ...(later.versions as JsonObject[]).find(version => version.n === 2)!, n: 99 });
  expect(reviewActFindings(later)).toEqual([]);
  expectExit0(await cli(root, ['advance', 'accepted', root, '--json']));
  const accepted = readFileSync(join(root, 'project.json'));
  expectExit0(await cli(root, ['signoff', 'direction-review', root, '--from-review', String(signed.actId)]));
  expect(readFileSync(join(root, 'project.json'))).toEqual(accepted);
  for (const [key, value] of Object.entries({ record_sha256: '0'.repeat(64), target_version: 99, verdict: 'versions[1].verdicts[0]' })) {
    const tampered = JSON.parse(accepted.toString('utf8')) as JsonObject;
    (tampered.review_acts as JsonObject[]).find(entry => entry.actId === signed.actId)![key] = value;
    write(root, tampered);
    expect(reviewActFindings(tampered).map(finding => finding.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
    const beforeRetry = readFileSync(join(root, 'project.json'));
    const invalidReplay = await cli(root, ['signoff', 'direction-review', root, '--from-review', String(signed.actId)]);
    expect(invalidReplay.exit).toBe(1);
    expect(invalidReplay.stderr).toContain('REVIEW_ACT_LEDGER_INVALID:');
    expect(readFileSync(join(root, 'project.json'))).toEqual(beforeRetry);
  }
  writeFileSync(join(root, 'project.json'), accepted);
  const report = checkProject(root, undefined, { now: Date.now() });
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(report.holes ?? []).toEqual([]);
}, 30_000);

test('both-acts-before-ingest remains supported without an intermediate refresh, and pending refresh failure recovers via job reconcile', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  expectExit0(await cli(root, ['advance', 'rig-review', root, '--json']));

  // Both UI acts submitted before any ingest remain supported.
  const firstView = await page(root, opening.url);
  const verdictAsk = firstView.asks.find(item => (item.subject as JsonObject).kind === 'review-verdict')!;
  const verdict = await firstView.act(
    'review-verdict',
    'review-verdict',
    { stage: 'rig-review', verdict: 'approved', words: WORDS },
    rigCapture(root, firstView, String(verdictAsk.askId)),
  );
  const signedBeforeIngest = await firstView.act('signoff', 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });

  expectExit0(await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json']));

  // Plant a corrupted package source before running job open refresh: leaves JOB_PUBLISH_PENDING in the outbox.
  const partsPath = join(root, 'derived/review/v1/out/parts.json');
  const savedParts = readFileSync(partsPath);
  writeFileSync(partsPath, '{}\n');
  const failedRefresh = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: failedRefresh.exit, stderr: failedRefresh.stderr }).toEqual({
    exit: 1,
    stderr: expect.stringContaining('JOB_PUBLISH_PENDING:'),
  });
  expect(failedRefresh.stderr).toContain('JOB_PUBLICATION_INVALID');
  expect(pendingPublications(root)).toHaveLength(1);
  expect(checkProject(root, undefined, { now: Date.now() }).holes?.map(h => h.code)).toEqual(['JOB_PUBLISH_PENDING']);

  // Restore the corrupted file and recover the pending refresh through job reconcile.
  writeFileSync(partsPath, savedParts);
  const reconciled = await cli(root, ['job', 'reconcile', root]);
  expect({ exit: reconciled.exit, stderr: reconciled.stderr, stdout: reconciled.stdout.trim() }).toEqual({
    exit: 0,
    stderr: '',
    stdout: 'job: reconciled 1 publication(s)',
  });
  expect(pendingPublications(root)).toEqual([]);
  expect(checkProject(root, undefined, { now: Date.now() }).holes ?? []).toEqual([]);

  // The signoff act finalized before ingest still ingests cleanly after reconciliation.
  const signoffRes = await cli(root, ['signoff', 'rig-review', root, '--from-review', String(signedBeforeIngest.actId), '--json']);
  expectExit0(signoffRes);
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({
    stage: 'rig-review',
    target: { version: 1 },
    source: `review act ${String(signedBeforeIngest.jobId)}/${String(signedBeforeIngest.actId)}`,
  });
}, REFRESH_FLOW_TIMEOUT_MS);
