import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { commitAdvance } from '../src/job-advance.ts';
import { JOB_BINDING_FILE, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding, writePrivateJson } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
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

const WORDS = '  Synthetic approval, 좋아.\r\n';
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
const write = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

function copy(checkpoint: string, edit?: (project: JsonObject) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-advance-pub-')));
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
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

/** Start `job open` in the background and read its owner URL line and initial status lines. */
async function open(root: string): Promise<{ url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner'], {
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

/** Read the job's HTTP event stream and commit UI acts over the owner page's HTTP routes. */
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
    events,
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

test('advance rig-review on a bound job publishes the current rig, asks review-verdict and signoff, and ingests both UI acts via CLI', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);

  const advanced = await cli(root, ['advance', 'rig-review', root, '--json']);
  expect({ exit: advanced.exit, stderr: advanced.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root).stage).toBe('rig-review');

  const person = await page(opening.url);
  expect((person.head.source as JsonObject).selector).toEqual({ kind: 'rig', version: 1 });
  expect(person.asks.map(ask => ask.subject)).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
    { kind: 'signoff', stage: 'rig-review' },
  ]);

  const verdictAsk = person.asks.find(item => (item.subject as JsonObject).kind === 'review-verdict')!;
  const png = readFileSync(join(root, 'evidence/setup.png'));
  const verdict = await person.act('review-verdict', 'review-verdict', { stage: 'rig-review', verdict: 'approved', words: WORDS }, {
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
        publicationId: person.head.publicationId,
        instanceKey: person.head.instanceKey,
        sourceHash: (person.head.source as JsonObject).sourceHash,
        pageId: person.pageId,
        askId: verdictAsk.askId,
        drawGeneration: 1,
        playerGeneration: 0,
      },
    },
  });
  const signed = await person.act('signoff', 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });

  const reviewed = await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json']);
  expect({ exit: reviewed.exit, stderr: reviewed.stderr }).toEqual({ exit: 0, stderr: '' });
  const signoffRes = await cli(root, ['signoff', 'rig-review', root, '--from-review', String(signed.actId), '--json']);
  expect({ exit: signoffRes.exit, stderr: signoffRes.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(pendingPublications(root)).toEqual([]);
});

test('advance direction-review on a bound job publishes the current post, asks only the verdict, ingests it, and leaves acceptance blocked', async () => {
  const root = copy('example-chain', project => {
    project.stage = 'post';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'direction-review' && entry.stage !== 'accepted');
    project.signoffs = (project.signoffs as JsonObject[]).filter(entry => entry.stage !== 'direction-review');
    const postVersion = (project.versions as JsonObject[]).find(v => v.n === 2)!;
    postVersion.verdicts = [];
  });
  const opening = await open(root);

  const advanced = await cli(root, ['advance', 'direction-review', root, '--json']);
  expect({ exit: advanced.exit, stderr: advanced.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root).stage).toBe('direction-review');

  const person = await page(opening.url, 1);
  expect((person.head.source as JsonObject).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  expect(person.asks.map(ask => ask.subject)).toEqual([
    { kind: 'review-verdict', stage: 'direction-review' },
  ]);

  const verdict = await person.act('review-verdict', 'review-verdict', { stage: 'direction-review', verdict: 'approved', words: WORDS });

  const reviewed = await cli(root, ['review', '2', root, '--from-review', String(verdict.actId), '--json']);
  expect({ exit: reviewed.exit, stderr: reviewed.stderr }).toEqual({ exit: 0, stderr: '' });
  const frozen = readFileSync(join(root, 'project.json'));
  const toAccepted = await cli(root, ['advance', 'accepted', root, '--json']);
  expect(toAccepted.exit).toBe(1);
  expect(toAccepted.stderr).toContain('ADVANCE_UNAUTHORIZED:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(frozen);
  expect(read(root).stage).toBe('direction-review');
  expect((read(root).signoffs as JsonObject[]).some(signature => signature.stage === 'direction-review')).toBe(false);
  const report = checkProject(root, undefined, { now: Date.now() });
  expect(report.refusals).toEqual([]);
  expect(report.holes ?? []).toEqual([]);
});

test('forced publish failure after advance commits project.json, leaves JOB_PUBLISH_PENDING in the outbox, and job reconcile publishes and asks via CLI', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  const binding = readWriterBinding(root)!;
  writePrivateJson(join(root, JOB_BINDING_FILE), { ...binding, listenerIncarnation: 'offline-incarnation' }, true);

  const advanced = await cli(root, ['advance', 'rig-review', root, '--json']);
  expect(advanced.exit).toBe(1);
  expect(advanced.stderr).toContain('JOB_PUBLISH_PENDING');
  expect(read(root).stage).toBe('rig-review');
  expect(pendingPublications(root)).toHaveLength(1);
  expect(pendingPublications(root)[0]!.phase).toBe('pending');

  const checkWhilePending = await cli(root, ['interview', root, '--check', '--json']);
  expect(checkWhilePending.exit).toBe(1);
  const parsedPending = JSON.parse(checkWhilePending.stdout) as { refusals: unknown[]; holes: { code: string }[] };
  expect(parsedPending.refusals).toEqual([]);
  expect(parsedPending.holes.map(h => h.code)).toEqual(['JOB_PUBLISH_PENDING']);

  writePrivateJson(join(root, JOB_BINDING_FILE), binding, true);

  const reconciled = await cli(root, ['job', 'reconcile', root]);
  expect({ exit: reconciled.exit, stderr: reconciled.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(reconciled.stdout.trim()).toBe('job: reconciled 1 publication(s)');
  expect(pendingPublications(root)).toEqual([]);

  const checkAfterReconcile = await cli(root, ['interview', root, '--check', '--json']);
  expect(checkAfterReconcile.exit).toBe(0);

  const person = await page(opening.url);
  expect((person.head.source as JsonObject).selector).toEqual({ kind: 'rig', version: 1 });
  expect(person.asks.map(ask => ask.subject)).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
    { kind: 'signoff', stage: 'rig-review' },
  ]);
  const signed = await person.act('signoff', 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });
  expect(signed.kind).toBe('signoff');
});

test('advances into other stages on a bound job and advances without a bound job do not publish or touch the outbox', async () => {
  const boundRoot = copy('1-parts-verdict');
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(boundRoot, 'evidence/diff-components.json'));
  const opening = await open(boundRoot);
  expect(opening.lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain']);

  const ackDir = join(jobPrivateRoot(boundRoot), 'acknowledged-publications');
  const receiptsBefore = readdirSync(ackDir).sort();
  const beforePage = await page(opening.url, 1);
  const headBefore = beforePage.head.publicationId;
  const generationBefore = Number(beforePage.events.at(-1)!.generation);

  const toPartsReview = await cli(boundRoot, [
    'advance',
    'parts-review',
    boundRoot,
    '--parts-check',
    'evidence/parts-check.json',
    '--parts',
    'derived/drafts/chain/input',
    '--json',
  ]);
  expect({ exit: toPartsReview.exit, stderr: toPartsReview.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(boundRoot).stage).toBe('parts-review');
  expect(pendingPublications(boundRoot)).toEqual([]);
  expect(readdirSync(ackDir).sort()).toEqual(receiptsBefore);

  const afterPage = await page(opening.url, 1);
  expect(afterPage.head.publicationId).toBe(headBefore);
  expect(Number(afterPage.events.at(-1)!.generation)).toBe(generationBefore);

  const unboundRoot = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const unboundAdvance = await cli(unboundRoot, ['advance', 'rig-review', unboundRoot, '--json']);
  expect({ exit: unboundAdvance.exit, stderr: unboundAdvance.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(unboundRoot).stage).toBe('rig-review');
  expect(existsSync(jobPrivateRoot(unboundRoot))).toBe(false);
});

test('planted write failures on advance with an existing version never leave an advanced stage without a pending or acknowledged publication', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  const file = join(root, 'project.json');
  const preAdvanceBytes = readFileSync(file);
  const candidate = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review/project.json'), 'utf8')) as JsonObject;
  candidate.review_job = read(root).review_job!;

  // 1. Pre-rename write failure: project.json is still at rigging, and the intent for existing v1 is cleaned up.
  expect(() =>
    commitAdvance(root, file, structuredClone(candidate), () => {
      throw new Error('planted pre-rename write failure');
    }),
  ).toThrow('planted pre-rename write failure');
  expect(readFileSync(file)).toEqual(preAdvanceBytes);
  expect(read(root).stage).toBe('rigging');
  expect(pendingPublications(root)).toEqual([]);

  // 2. Post-rename failure before publishCommittedVersion runs: stage is advanced AND durable outbox entry is retained.
  expect(() =>
    commitAdvance(root, file, structuredClone(candidate), (temp, target, bytes) => {
      writeFileSync(temp, bytes, { flag: 'wx' });
      renameSync(temp, target);
      throw new Error('planted post-rename failure before publish');
    }),
  ).toThrow('planted post-rename failure before publish');
  expect(read(root).stage).toBe('rig-review');
  expect(pendingPublications(root)).toHaveLength(1);
  expect(checkProject(root, undefined, { now: Date.now() }).holes?.map(h => h.code)).toEqual(['JOB_PUBLISH_PENDING']);

  const reconciled = await cli(root, ['job', 'reconcile', root]);
  expect({ exit: reconciled.exit, stderr: reconciled.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(pendingPublications(root)).toEqual([]);
  const person = await page(opening.url);
  expect(person.asks.map(ask => ask.subject)).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
    { kind: 'signoff', stage: 'rig-review' },
  ]);
});

test('advance rig-review on a bound job refuses before writing when no live rig version exists', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  await open(root);
  const withoutVersions = read(root);
  withoutVersions.versions = [];
  write(root, withoutVersions);
  const beforeBytes = readFileSync(join(root, 'project.json'));

  const advanced = await cli(root, ['advance', 'rig-review', root, '--json']);
  expect(advanced.exit).toBe(1);
  expect(advanced.stderr).toContain('JOB_PUBLICATION_INVALID');
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeBytes);
  expect(pendingPublications(root)).toEqual([]);
});
