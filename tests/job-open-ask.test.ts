/**
 * `job open` publishes the record's current draft and asks its declared subjects (#352).
 * The cycle tests go through the shipped CLI: no in-process host and no agent credential.
 * The person is the owner page, so its acts go over the host's HTTP UI routes.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startJobHost, type JobSelector } from '@rig-c/review/job-host';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { inputCommand } from '../src/inputs.ts';
import { askDeclaredSubjects, openCreateJob, openDraftPublication, publishPending, reconcileCreateJob, refuseAskOutcomes } from '../src/job-host.ts';
import { enqueuePublication, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';
import { assertDraftPublicationReady, prepareLiveManifest } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { sceneCommand } from '../src/scene-writers.ts';
import type { JsonObject } from '../src/templates.ts';
import { sourceOnlyTest } from './source-only.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
const roots: string[] = [];
const opened: { proc: Bun.Subprocess; root: string }[] = [];
afterEach(async () => {
  for (const { proc, root } of opened.splice(0)) {
    if (readWriterBinding(root)) await cli(root, ['job', 'close', root]);
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

const WORDS = '  Synthetic page words.\n';
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));

async function cli(root: string, args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

/** The example chain's parts stage, moved into parts-review by the shipped advance writer. Its draft `chain` is recorded. */
async function partsReview(): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-ask-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), root, { recursive: true });
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  const advanced = await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']);
  expect(advanced.exit).toBe(0);
  const triaged = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
  expect(triaged.exit).toBe(0);
  return root;
}

/** Start `job open` in the background and read its URL line and the summary it prints after publishing. */
async function open(root: string): Promise<{ url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' });
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

/** The owner page: read the job's events over HTTP, acknowledge the display and commit acts. */
async function page(url: URL) {
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
    return { head, asks: events.filter(event => event.type === 'pending' && (event.ask as JsonObject).publicationId === head?.publicationId).map(event => event.ask as JsonObject) };
  };
  // Every event is delivered on connect; read until the stream pauses.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pending().asks.length < 2) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) { events.push(JSON.parse(buffered.slice(0, newline))); buffered = buffered.slice(newline + 1); }
  }
  abort.abort();
  const { head, asks } = pending();
  const post = async (route: string, body: object) => (await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })).json() as Promise<JsonObject>;
  const pageId = randomUUID();
  const displayed = await post('ui/displayed', { publicationId: head!.publicationId, pageId, sourceHash: (head!.source as JsonObject).sourceHash });
  // The page acts at the generation of the last event it read; each act is one more.
  let expectedGeneration = Number(events.at(-1)!.generation);
  return {
    head: head!, asks,
    act: async (subject: string, kind: string, value: object): Promise<JsonObject> => {
      const ask = asks.find(item => (item.subject as JsonObject).kind === subject)!;
      const result = await post('ui/acts', { publicationId: head!.publicationId, askId: ask.askId, pageId,
        displayedNonce: (displayed.value as JsonObject).displayedNonce, expectedGeneration, submissionId: randomUUID(), kind, value });
      expect(result.error).toBeUndefined();
      expectedGeneration++;
      return result.value as JsonObject;
    },
  };
}

sourceOnlyTest('job open publishes the recorded draft, asks its subjects, and the page acts are ingested by the CLI', async () => {
  const root = await partsReview();
  const opening = await open(root);
  expect(opening.lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain, signoff parts-review']);
  // A re-open while the host runs shows the same publication and asks nothing twice.
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n')).toEqual([opening.url.href, 'job: draft chain already published', 'job: already asked parts-verdict chain, signoff parts-review']);
  const person = await page(opening.url);
  expect((person.head.source as JsonObject).selector).toEqual({ kind: 'draft', id: 'chain' });
  expect(person.asks.map(ask => ask.subject)).toEqual([{ kind: 'parts-verdict', draftId: 'chain' }, { kind: 'signoff', stage: 'parts-review' }]);
  const verdict = await person.act('parts-verdict', 'parts-verdict', { verdict: 'approved', issues: [], words: WORDS });
  const signed = await person.act('signoff', 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });

  const ingested = await cli(root, ['parts-review', root, '--from-review', String(verdict.actId), '--json']);
  expect({ exit: ingested.exit, stderr: ingested.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(JSON.parse(ingested.stdout)).toMatchObject({ draft_id: 'chain', verdict: 'approved', by: 'user', verbatim: WORDS });
  expect((await cli(root, ['structure-snapshot', root, '--draft', 'chain', '--out', 'evidence/structure.json'])).exit).toBe(0);
  const signoff = await cli(root, ['signoff', 'parts-review', root, '--from-review', String(signed.actId), '--draft', 'chain',
    '--structure-file', 'evidence/structure.json', '--json']);
  expect({ exit: signoff.exit, stderr: signoff.stderr }).toEqual({ exit: 0, stderr: '' });
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({ stage: 'parts-review', checkpoint: null, by: 'user', verbatim: WORDS,
    source: `review act ${String(signed.jobId)}/${String(signed.actId)}` });
  // The signature authorizes the next stage; the separate advance writer records the move.
  const report = JSON.parse((await cli(root, ['interview', '--check', root, '--json'])).stdout);
  expect(report.refusals.map((finding: JsonObject) => finding.code)).toEqual(['STAGE_LAGGING']);
  expect(report.holes ?? []).toEqual([]);

  // The writes changed the record, so a re-open publishes the draft again. The stage is signed, so only the verdict is asked.
  const after = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: after.exit, stderr: after.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(after.stdout.trim().split('\n').slice(1)).toEqual(['job: draft chain published', 'job: asked parts-verdict chain']);
});

test('a --draft that the record does not hold refuses before writing project.json or starting a host', async () => {
  const root = await partsReview();
  const before = readFileSync(join(root, 'project.json'));
  const refused = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--draft', 'absent']);
  expect(refused.exit).toBe(1);
  expect(refused.stdout).toBe('');
  expect(refused.stderr).toStartWith('JOB_DRAFT_UNKNOWN: ');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(read(root).review_job).toBeUndefined();
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(jobHostStateRoot(root))).toBe(false);
});

test.each(['rig', 'post'] as const)('job open retries a refused ask on an acknowledged %s head without overwriting it with a draft or duplicating pending or answered asks', async kind => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `create-job-open-${kind}-`)));
  roots.push(root);
  const stage = kind === 'rig' ? 'rig-review' : 'direction-review';
  const version = kind === 'rig' ? 1 : 2;
  const selector: JobSelector = kind === 'rig' ? { kind: 'rig', version: 1 } : { kind: 'post', version: 2, rigVersion: 1 };
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints', kind === 'rig' ? '3-rig-review' : '4-direction-post'), root, { recursive: true });
  if (kind === 'post') {
    mkdirSync(join(root, 'inputs'), { recursive: true });
    for (const path of ['inputs/background.png', 'evidence/scene-citations.json', 'evidence/direction-input.json']) {
      cpSync(join(import.meta.dir, '../templates/example-chain', path), join(root, path));
    }
    inputCommand(['add', 'inputs/background.png', root, '--origin', 'synthetic plate'], EXAMPLE_NOW);
    sceneCommand(['write', '--rig', '1', '--background', 'inputs/background.png', '--citations-file', 'evidence/scene-citations.json', '--by', 'user', root], EXAMPLE_NOW);
    directionCommand(['write', '2', root, '--file', 'evidence/direction-input.json', '--rig', '1'], EXAMPLE_NOW);
    advanceCommand(['direction-review', root], EXAMPLE_NOW);
  }
  expect((read(root).drafts as JsonObject[]).map(draft => draft.id)).toEqual(['chain']);
  const opening = await open(root);
  expect(opening.lines).toEqual([`job: stage ${stage} shows no draft; name one with --draft <id>`]);
  const path = prepareLiveManifest(root, read(root), version);
  enqueuePublication(root, readWriterBinding(root)!, { path, selector });
  const saved = readFileSync(join(root, 'project.json'));
  await expect(reconcileCreateJob(root, entry => publishPending(entry, undefined, undefined, async options => {
    const attached = await startJobHost(options);
    const handleJobApi = attached.ports.handleJobApi.bind(attached.ports);
    attached.ports.handleJobApi = async request => {
      const body = JSON.parse(await request.clone().text()) as { verb?: string; subject?: { kind?: string } };
      if (body.verb === 'ask' && body.subject?.kind === 'signoff') {
        writeFileSync(join(root, 'project.json'), `${JSON.stringify({ ...read(root), stage: 'paused' }, null, 2)}\n`);
      }
      return await handleJobApi(request);
    };
    return attached;
  }))).rejects.toMatchObject({ code: 'JOB_ASK_REFUSED' });
  writeFileSync(join(root, 'project.json'), saved);
  expect(pendingPublications(root)).toEqual([]);
  const reconciled = await cli(root, ['job', 'reconcile', root]);
  expect({ exit: reconciled.exit, stdout: reconciled.stdout.trim(), stderr: reconciled.stderr }).toEqual({ exit: 0, stdout: 'job: reconciled 0 publication(s)', stderr: '' });

  const retried = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: retried.exit, stderr: retried.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(retried.stdout.trim().split('\n')).toEqual([opening.url.href, `job: ${kind} v${version} already published`, `job: asked signoff ${stage}`, `job: already asked review-verdict ${stage}`]);
  const person = await page(opening.url);
  expect((person.head.source as { selector: unknown }).selector).toEqual(selector);
  expect(person.asks.map(ask => ask.subject)).toEqual([{ kind: 'review-verdict', stage }, { kind: 'signoff', stage }]);
  await person.act('signoff', 'signoff', { stage, decision: 'approved', words: WORDS });

  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n')).toEqual([opening.url.href, `job: ${kind} v${version} already published`, `job: already asked review-verdict ${stage}, signoff ${stage}`]);
  expect((await page(opening.url)).asks).toHaveLength(2);
});

sourceOnlyTest('a binding copied from another root is replaced: the copy opens its own job and never attaches the original host', async () => {
  const original = await partsReview();
  const first = await open(original);
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-copy-')));
  roots.push(copy);
  rmSync(copy, { recursive: true });
  cpSync(original, copy, { recursive: true });
  expect(readWriterBinding(copy)!.identity.root).toBe(original);
  const copied = await open(copy);
  expect(copied.lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain, signoff parts-review']);
  const binding = readWriterBinding(copy)!;
  expect(binding.identity.root).toBe(copy);
  expect(binding.identity.stateDir).toBe(join(jobHostStateRoot(copy), 'host'));
  expect(copied.url.origin === first.url.origin).toBe(false);
  expect((read(copy).review_job as JsonObject).jobId).toBe(binding.jobId);
  // The original job still has exactly its own publication and asks.
  const person = await page(first.url);
  expect(person.asks).toHaveLength(2);
  expect((read(original).review_job as JsonObject).origin).toBe(first.url.origin);
});

sourceOnlyTest('an ask Review refuses is named JOB_ASK_REFUSED, and a declared subject is asked only once', async () => {
  const root = await partsReview();
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now());
  try {
    await openDraftPublication(root, host, Date.now());
    const publicationId = host.session.status().publication!.publicationId;
    const generation = host.session.status().generation;
    // Review asks only a declared subject; a stage this draft cannot sign is refused.
    const outcomes = await askDeclaredSubjects(host, publicationId, [{ kind: 'parts-verdict', draftId: 'chain' }, { kind: 'signoff', stage: 'rig-review' }]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['already', 'refused']);
    expect(outcomes[1]).toMatchObject({ code: 'JOB_ASK_INVALID' });
    expect(host.session.status().generation).toBe(generation);
    expect(() => refuseAskOutcomes(outcomes)).toThrow(expect.objectContaining({ code: 'JOB_ASK_REFUSED' }));
  } finally { host.stop(); }
});

test('openDraftPublication refuses parts-review approval when agent diff_map is missing and leaves Review unpublished', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-diffmap-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), root, { recursive: true });
  const advanced = await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']);
  expect(advanced.exit).toBe(0);
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now());
  const before = readFileSync(join(root, 'project.json'));
  try {
    await expect(openDraftPublication(root, host, Date.now())).rejects.toMatchObject({
      code: 'DIFF_MAP_MISSING',
    });
    expect(host.session.status().publication).toBeNull();
    expect(host.session.status().pending).toEqual([]);
    expect(pendingPublications(root)).toEqual([]);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    const refused = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
    expect(refused.exit).not.toBe(0);
    expect(refused.stderr).toContain('DIFF_MAP_MISSING:');
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    expect(pendingPublications(root)).toEqual([]);
    const triaged = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
    expect(triaged.exit).toBe(0);
    const context = assertDraftPublicationReady(root, read(root), 'chain');
    expect(context.subjects).toEqual([
      { kind: 'parts-verdict', draftId: 'chain' }, { kind: 'signoff', stage: 'parts-review' },
    ]);
    expect(pendingPublications(root)).toEqual([]);
  } finally { host.stop(); }
});
