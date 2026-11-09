import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';
import type { JsonObject } from '../src/templates.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
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
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

async function open(root: string): Promise<{ url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner'], {
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
  return { url: new URL(lines[0]!), lines: lines.slice(1) };
}

async function page(url: URL, expectedAsks = 2) {
  const jobId = /\/jobs\/([^/]+)\//.exec(url.pathname)![1]!;
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pending().asks.length < expectedAsks) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      events.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  }
  abort.abort();
  const { head, asks } = pending();
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
      return result.value as JsonObject;
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

test('parts-review verdict -> ingest -> triage -> job open refresh -> UI signoff -> ingest succeeds after JOB_RECORD_MOVED on the pre-triage publication', async () => {
  const root = copy('1-parts-verdict');
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expect((await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'])).exit).toBe(0);

  const opening = await open(root);
  expect(opening.lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain, signoff parts-review']);

  const firstView = await page(opening.url);
  const names = (JSON.parse(readFileSync(join(root, 'derived/drafts/chain/input/parts.json'), 'utf8')).parts as { name: string }[]).map(part => part.name);
  const verdict = await firstView.act('parts-verdict', 'parts-verdict', {
    verdict: 'approved',
    words: WORDS,
    parts: names.map(partId => ({ partId, part: { outcome: 'clean', note: '' }, mesh: { outcome: 'clean', note: '' } })),
  });

  expect((await cli(root, ['parts-review', root, '--from-review', String(verdict.actId), '--json'])).exit).toBe(0);
  expect((await cli(root, ['structure-snapshot', root, '--draft', 'chain', '--out', 'evidence/structure.json'])).exit).toBe(0);
  expect((await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'])).exit).toBe(0);

  // The pre-ingest publication now has an old projectHash, so UI signoff on it is refused as JOB_RECORD_MOVED.
  const staleSignoff = await firstView.tryAct('signoff', 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });
  expect((staleSignoff.error as JsonObject | undefined)?.code).toBe('JOB_RECORD_MOVED');

  // Refresh via job open republishes the draft over the current project.json and re-asks declared subjects.
  const refreshed = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: refreshed.exit, stderr: refreshed.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(refreshed.stdout.trim().split('\n')).toEqual([
    opening.url.href,
    'job: draft chain published',
    'job: asked parts-verdict chain, signoff parts-review',
  ]);

  const refreshedView = await page(opening.url);
  expect(refreshedView.head.publicationId).not.toBe(firstView.head.publicationId);
  expect((refreshedView.head.source as JsonObject).selector).toEqual({ kind: 'draft', id: 'chain' });
  expect((refreshedView.head.source as JsonObject).projectHash).toBe(jobHash(readFileSync(join(root, 'project.json'))));

  const signed = await refreshedView.act('signoff', 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });
  const signoffRes = await cli(root, ['signoff', 'parts-review', root, '--from-review', String(signed.actId), '--structure-file', 'evidence/structure.json', '--json']);
  expect({ exit: signoffRes.exit, stderr: signoffRes.stderr }).toEqual({ exit: 0, stderr: '' });
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({
    stage: 'parts-review',
    checkpoint: null,
    by: 'user',
    verbatim: WORDS,
    draft_id: 'chain',
    source: `review act ${String(signed.jobId)}/${String(signed.actId)}`,
  });
});

test('rig-review verdict -> ingest -> job open refresh -> UI signoff -> ingest preserves rig selector, updates projectHash, and keeps stale/authority guards', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  expect((await cli(root, ['advance', 'rig-review', root, '--json'])).exit).toBe(0);

  const firstView = await page(opening.url);
  expect((firstView.head.source as JsonObject).selector).toEqual({ kind: 'rig', version: 1 });
  const verdictAsk = firstView.asks.find(item => (item.subject as JsonObject).kind === 'review-verdict')!;
  const verdict = await firstView.act(
    'review-verdict',
    'review-verdict',
    { stage: 'rig-review', verdict: 'approved', words: WORDS },
    rigCapture(root, firstView, String(verdictAsk.askId)),
  );

  const reviewed = await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json']);
  expect({ exit: reviewed.exit, stderr: reviewed.stderr }).toEqual({ exit: 0, stderr: '' });

  // Submitting signoff on the pre-verdict publication fails with JOB_RECORD_MOVED because review modified project.json.
  const staleSignoff = await firstView.tryAct('signoff', 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });
  expect((staleSignoff.error as JsonObject | undefined)?.code).toBe('JOB_RECORD_MOVED');

  // Refresh via job open republishes rig v1 with the current project.json hash and asks review-verdict and signoff.
  const refreshed = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: refreshed.exit, stderr: refreshed.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(refreshed.stdout.trim().split('\n')).toEqual([
    opening.url.href,
    'job: rig v1 published',
    'job: asked review-verdict rig-review, signoff rig-review',
  ]);

  // Re-opening again when project.json has not moved reuses the refreshed head without republishing.
  const reused = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: reused.exit, stderr: reused.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(reused.stdout.trim().split('\n')).toEqual([
    opening.url.href,
    'job: rig v1 already published',
    'job: already asked review-verdict rig-review, signoff rig-review',
  ]);

  const refreshedView = await page(opening.url);
  expect(refreshedView.head.publicationId).not.toBe(firstView.head.publicationId);
  expect((refreshedView.head.source as JsonObject).selector).toEqual({ kind: 'rig', version: 1 });
  expect((refreshedView.head.source as JsonObject).projectHash).toBe(jobHash(readFileSync(join(root, 'project.json'))));
  expect(refreshedView.asks.map(ask => ask.subject)).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
    { kind: 'signoff', stage: 'rig-review' },
  ]);

  const signed = await refreshedView.act('signoff', 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });

  // Negative guards: wrong version, wrong stage, or competing authority flags refuse and leave project.json byte-identical.
  const beforeSignoffBytes = readFileSync(join(root, 'project.json'));
  const wrongVersion = await cli(root, ['signoff', 'rig-review', root, '--from-review', String(signed.actId), '--version', '2']);
  expect(wrongVersion.exit).toBe(1);
  expect(wrongVersion.stderr).toContain('REVIEW_ACT_TARGET_MISMATCH:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeSignoffBytes);

  const wrongStage = await cli(root, ['signoff', 'direction-review', root, '--from-review', String(signed.actId)]);
  expect(wrongStage.exit).toBe(1);
  expect(wrongStage.stderr).toContain('REVIEW_ACT_KIND_MISMATCH:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeSignoffBytes);

  const mixedBy = await cli(root, ['signoff', 'rig-review', root, '--from-review', String(signed.actId), '--by', 'user']);
  expect(mixedBy.exit).toBe(2);
  expect(mixedBy.stderr).toContain('SIGNOFF_OPTION_INVALID:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeSignoffBytes);

  // Valid signoff ingest succeeds and records target.version = 1.
  const signoffRes = await cli(root, ['signoff', 'rig-review', root, '--from-review', String(signed.actId), '--json']);
  expect({ exit: signoffRes.exit, stderr: signoffRes.stderr }).toEqual({ exit: 0, stderr: '' });
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({
    stage: 'rig-review',
    checkpoint: null,
    by: 'user',
    verbatim: WORDS,
    target: { version: 1 },
    source: `review act ${String(signed.jobId)}/${String(signed.actId)}`,
  });

  // Replay of the earlier verdict act still succeeds without rewriting project.json, and corrupting a bound source refuses REVIEW_ACT_SOURCE_STALE.
  const afterSignoffBytes = readFileSync(join(root, 'project.json'));
  const replayVerdict = await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json']);
  expect({ exit: replayVerdict.exit, stderr: replayVerdict.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(readFileSync(join(root, 'project.json'))).toEqual(afterSignoffBytes);

  const modelPath = join(root, 'derived/review/v1/out/check/build/skeleton.model.json');
  const savedModel = readFileSync(modelPath);
  writeFileSync(modelPath, '{}\n');
  try {
    const staleReplay = await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json']);
    expect(staleReplay.exit).toBe(1);
    expect(staleReplay.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
    expect(readFileSync(join(root, 'project.json'))).toEqual(afterSignoffBytes);
  } finally {
    writeFileSync(modelPath, savedModel);
  }

  const report = checkProject(root, undefined, { now: Date.now() });
  expect(report.refusals.map(f => f.code)).toEqual(['STAGE_LAGGING']);
  expect(report.holes ?? []).toEqual([]);
});

test('direction-review verdict -> ingest -> job open refresh -> UI signoff -> ingest -> advance accepted completes cleanly', async () => {
  const root = copy('example-chain', project => {
    project.stage = 'post';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'direction-review' && entry.stage !== 'accepted');
    project.signoffs = (project.signoffs as JsonObject[]).filter(entry => entry.stage !== 'direction-review');
    const postVersion = (project.versions as JsonObject[]).find(v => v.n === 2)!;
    postVersion.verdicts = [];
  });
  const opening = await open(root);
  expect((await cli(root, ['advance', 'direction-review', root, '--json'])).exit).toBe(0);

  const firstView = await page(opening.url);
  expect((firstView.head.source as JsonObject).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  const verdict = await firstView.act('review-verdict', 'review-verdict', { stage: 'direction-review', verdict: 'approved', words: WORDS });

  const reviewed = await cli(root, ['review', '2', root, '--from-review', String(verdict.actId), '--json']);
  expect({ exit: reviewed.exit, stderr: reviewed.stderr }).toEqual({ exit: 0, stderr: '' });

  // Pre-verdict publication rejects subsequent UI signoff with JOB_RECORD_MOVED.
  const staleSignoff = await firstView.tryAct('signoff', 'signoff', { stage: 'direction-review', decision: 'approved', words: WORDS });
  expect((staleSignoff.error as JsonObject | undefined)?.code).toBe('JOB_RECORD_MOVED');

  // Refresh via job open republishes post v2 over the current project.json and asks review-verdict and signoff.
  const refreshed = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: refreshed.exit, stderr: refreshed.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(refreshed.stdout.trim().split('\n')).toEqual([
    opening.url.href,
    'job: post v2 published',
    'job: asked review-verdict direction-review, signoff direction-review',
  ]);

  const refreshedView = await page(opening.url);
  expect(refreshedView.head.publicationId).not.toBe(firstView.head.publicationId);
  expect((refreshedView.head.source as JsonObject).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  expect((refreshedView.head.source as JsonObject).projectHash).toBe(jobHash(readFileSync(join(root, 'project.json'))));

  const signed = await refreshedView.act('signoff', 'signoff', { stage: 'direction-review', decision: 'approved', words: WORDS });
  const signoffRes = await cli(root, ['signoff', 'direction-review', root, '--from-review', String(signed.actId), '--json']);
  expect({ exit: signoffRes.exit, stderr: signoffRes.stderr }).toEqual({ exit: 0, stderr: '' });

  expect((await cli(root, ['advance', 'accepted', root, '--json'])).exit).toBe(0);
  const report = checkProject(root, undefined, { now: Date.now() });
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(report.holes ?? []).toEqual([]);
});

test('both-acts-before-ingest remains supported without an intermediate refresh, and pending refresh failure recovers via job reconcile', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  expect((await cli(root, ['advance', 'rig-review', root, '--json'])).exit).toBe(0);

  // Both UI acts submitted before any ingest remain supported.
  const firstView = await page(opening.url);
  const verdictAsk = firstView.asks.find(item => (item.subject as JsonObject).kind === 'review-verdict')!;
  const verdict = await firstView.act(
    'review-verdict',
    'review-verdict',
    { stage: 'rig-review', verdict: 'approved', words: WORDS },
    rigCapture(root, firstView, String(verdictAsk.askId)),
  );
  const signedBeforeIngest = await firstView.act('signoff', 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });

  expect((await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json'])).exit).toBe(0);

  // Plant a corrupted package source before running job open refresh: leaves JOB_PUBLISH_PENDING in the outbox.
  const partsPath = join(root, 'derived/review/v1/out/parts.json');
  const savedParts = readFileSync(partsPath);
  writeFileSync(partsPath, '{}\n');
  const failedRefresh = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(failedRefresh.exit).toBe(1);
  expect(failedRefresh.stderr).toContain('JOB_PUBLISH_PENDING:');
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
  expect({ exit: signoffRes.exit, stderr: signoffRes.stderr }).toEqual({ exit: 0, stderr: '' });
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({
    stage: 'rig-review',
    target: { version: 1 },
    source: `review act ${String(signedBeforeIngest.jobId)}/${String(signedBeforeIngest.actId)}`,
  });
});
