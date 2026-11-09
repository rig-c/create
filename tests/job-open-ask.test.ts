/**
 * `job open` publishes the record's current draft and asks its declared subjects (#352).
 * The cycle tests go through the shipped CLI: no in-process host and no agent credential.
 * The person is the owner page, so its acts go over the host's HTTP UI routes.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { askDeclaredSubjects, openCreateJob, openDraftPublication, refuseAskOutcomes } from '../src/job-host.ts';
import { jobHostStateRoot, jobPrivateRoot, readWriterBinding } from '../src/job-outbox.ts';
import type { JsonObject } from '../src/templates.ts';

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
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
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
  return root;
}

/** Start `job open` in the background and read its URL line and the summary it prints after publishing. */
async function open(root: string): Promise<{ url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner'],
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

test('job open publishes the recorded draft, asks its subjects, and the page acts are ingested by the CLI', async () => {
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
  const names = (JSON.parse(readFileSync(join(root, 'derived/drafts/chain/input/parts.json'), 'utf8')).parts as { name: string }[]).map(part => part.name);
  const verdict = await person.act('parts-verdict', 'parts-verdict', { verdict: 'approved', words: WORDS,
    parts: names.map(partId => ({ partId, part: { outcome: 'clean', note: '' }, mesh: { outcome: 'clean', note: '' } })) });
  const signed = await person.act('signoff', 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });

  const ingested = await cli(root, ['parts-review', root, '--from-review', String(verdict.actId), '--json']);
  expect({ exit: ingested.exit, stderr: ingested.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(JSON.parse(ingested.stdout)).toMatchObject({ draft_id: 'chain', verdict: 'approved', by: 'user', verbatim: WORDS });
  expect((await cli(root, ['structure-snapshot', root, '--draft', 'chain', '--out', 'evidence/structure.json'])).exit).toBe(0);
  const signoff = await cli(root, ['signoff', 'parts-review', root, '--from-review', String(signed.actId), '--draft', 'chain',
    '--structure-file', 'evidence/structure.json', '--diff-report', 'evidence/diff-components.json', '--json']);
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

test('a --draft that the record does not hold refuses by name and the host keeps serving', async () => {
  const root = await partsReview();
  const proc = Bun.spawn([process.execPath, CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--draft', 'absent'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  opened.push({ proc, root });
  const reader = proc.stderr.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  reader.releaseLock();
  expect(text).toStartWith('JOB_DRAFT_UNKNOWN: ');
  expect(proc.exitCode).toBeNull();
});

test('a binding copied from another root is replaced: the copy opens its own job and never attaches the original host', async () => {
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

test('an ask Review refuses is named JOB_ASK_REFUSED, and a declared subject is asked only once', async () => {
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
