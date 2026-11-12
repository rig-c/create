/** Public CLI -> authenticated Review HTTP API -> CLI ingest, using synthetic records only. */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectItems } from '../src/check.ts';
import { interviewAnswerCommand } from '../src/choice-writers.ts';
import { Refusal } from '../src/refusal.ts';
import { loadedPartsIdentity } from '../src/job-publication.ts';
import reviewPackage from '@rig-c/review/package.json';
import corePackage from '@rig-c/core/package.json';
import { optionContext } from '../src/choices.ts';
import { enqueuePublication, failPublication, pendingPublications, jobHash, jobHostStateRoot, jobPrivateRoot, readWriterBinding, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { fixture, retainSignoffs, obj, arr } from './fixtures.ts';
import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
const CLI = join(import.meta.dir, '../src/cli.ts');
const roots: string[] = [];
const receipt = (value: object) => { if (process.env.RECORD_JOB_RECEIPT) appendFileSync(process.env.RECORD_JOB_RECEIPT, JSON.stringify(value) + '\n'); };
const bytes = (root: string) => readFileSync(join(root, 'project.json'));
const clean = (value: string, root: string) => value.replaceAll(root, '<synthetic>').replace(/http:\/\/127\.0\.0\.1:\d+[^\s]*/g, '<owner-url>');
const opened: { proc: Bun.Subprocess; root: string }[] = [];
afterEach(async () => {
  for (const { proc, root } of opened.splice(0)) {
    if (readWriterBinding(root)) await cli(root, ['job', 'close', root]);
    if (proc.exitCode === null) proc.kill();
    receipt({ command: ['foreground host', 'exit'], exit: await proc.exited });
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
  const before = jobHash(bytes(root));
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  receipt({ command: ['bun', 'src/cli.ts', ...args.map(arg => clean(arg, root))], exit, before, after: jobHash(bytes(root)), stdout: clean(stdout, root), stderr: clean(stderr, root) });
  return { stdout, stderr, exit };
}

/** Start `job open` in the background and read its URL line and the summary it prints after publishing. */
async function open(root: string, options: string[] = []): Promise<{ url: URL; lines: string[] }> {
  const before = jobHash(bytes(root));
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...options],
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
  if (!lines[0]?.startsWith('http://')) {
    const stderr = await new Response(proc.stderr).text();
    expect({ exit: await proc.exited, stderr }).toEqual({ exit: 0, stderr: '' });
  }
  receipt({ command: ['bun', 'src/cli.ts', 'job', 'open', '<synthetic>', '--reviewer', 'synthetic-owner', '--role', 'owner', ...options], serving: true, before, after: jobHash(bytes(root)), lines: lines.slice(1) });
  return { url: new URL(lines[0]!), lines: lines.slice(1) };
}

/** Read the publication and its declared asks without acknowledging a display or submitting an act. */
async function publication(root: string, url: URL, expectedAsks = 2) {
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
    return { head, asks: events.filter(event => event.type === 'pending' && (event.ask as JsonObject).publicationId === head?.publicationId).map(event => event.ask as JsonObject) };
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
      // Inspect each event so this regression also covers one-event transport chunks.
      if (ready()) break;
    }
  }
  abort.abort();
  const { head, asks } = pending();
  expect(head?.publicationId).toBe(expectedPublication.publicationId);
  receipt({ publication: head, asks });
  return { head: head!, asks, events, base, headers };
}

/** The owner page: read the job's events over HTTP, acknowledge the display and commit acts. */
async function page(root: string, url: URL, expectedAsks = 2) {
  const { head, asks, events, base, headers } = await publication(root, url, expectedAsks);
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
      receipt({ command: ['POST', '/jobs/<job>/ui/acts'], exit: 0, act: result.value });
      return result.value as JsonObject;
    },
  };
}


function synthetic(stage: string): string {
  const root = realpathSync(fixture(project => {
    project.stage = stage;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex(stage));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex(stage));
    if (stage !== 'post-interview') {
      project.versions = []; project.scenes = []; delete project.direction_contract;
      for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    } else {
      project.versions = arr(project.versions).filter(value => obj(value).kind === 'rig');
      delete project.direction_contract;
    }
    for (const step of arr(obj(project.plan).steps).map(obj)) {
      if (stage === 'parts') step.status = step.id === 'assemble' ? 'at-checkpoint' : step.id === 'seethrough' ? 'done' : 'pending';
      else if (stage === 'post-interview' ? step.phase === 'post' : !['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
    }
    if (stage === 'parts') for (const item of arr(obj(project.interview).waypoints).map(obj)) {
      if (['bones', 'meshes', 'constraints', 'motion'].includes(String(item.id))) item.guide = null;
    }
  }, 'example-project.json'));
  roots.push(root);
  receipt({ seed: 'fixture(example-project.json), synthetic stage prefix only; no pilot', stage, parts: loadedPartsIdentity(root, 'project'), review: reviewPackage.version, core: corePackage.version, bun: Bun.version, record: jobHash(bytes(root)) });
  return root;
}

async function checked(root: string) {
  const result = await cli(root, ['interview', '--check', root]);
  expect(result.exit, result.stderr + result.stdout).toBe(0);
}

async function unchanged(root: string, args: string[], code: string) {
  const before = readFileSync(join(root, 'project.json'));
  for (let n = 0; n < 2; n++) {
    const result = await cli(root, args);
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain(code);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  }
}

test('record question public path, API@2 fetch, retry, stale source and wrong subject', async () => {
  const root = synthetic('rigging-interview');
  const project = read(root);
  const item = collectItems(project, { collection: null }).find(item => item.id === 'motion')!;
  const old = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(old.path)), 'utf8')) as JsonObject;
  set.id = 'pending-motion';
  set.drafted_at = new Date(Date.now() - 1000).toISOString();
  set.context = optionContext(project, 'rigging-interview', Date.now() - 1000, root);
  const path = 'evidence/interview/pending-motion.json';
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  const registered = await cli(root, ['interview-options', 'motion', root, '--file', path]);
  expect(registered.exit, registered.stderr).toBe(0);
  const opened = await open(root, ['--question', 'motion']);
  expect(opened.lines).toEqual(['job: option-set motion/pending-motion published', 'job: asked interview-picks motion/pending-motion']);
  const before = readFileSync(join(root, 'project.json'));
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'motion']);
  expect(again.exit, again.stderr).toBe(0);
  expect(again.stdout).toContain('already published');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  // Recover a lost consumer acknowledgement through the public reconcile command.
  const pending = enqueuePublication(root, readWriterBinding(root)!, { kind: 'option-set', questionId: 'motion', setId: 'pending-motion' });
  // This publication was the job's first operation: its stored request generation was 0.
  pending.generation = 0;
  pending.phase = 'pending';
  failPublication(root, pending, null);
  expect(pendingPublications(root)).toHaveLength(1);
  const reconciled = await cli(root, ['job', 'reconcile', root]);
  expect(reconciled.exit, reconciled.stderr).toBe(0);
  expect(pendingPublications(root)).toEqual([]);
  expect(bytes(root)).toEqual(before);
  const owner = await page(root, opened.url, 1);
  const selections = (set.asks as JsonObject[]).map(ask => ({ itemId: ask.id, optionId: obj((ask.options as JsonObject[])[0]).id, otherText: null }));
  const otherWords = '  Exact Other words.\n끝  ';
  const otherSelections = selections.map((row, index) => index === 0 ? { ...row, optionId: 'other', otherText: otherWords } : row);
  const act = await owner.act('interview-picks', 'interview-picks', { questionId: 'motion', selections: otherSelections, note: WORDS });
  expect(act.schema).toBe('rig-review/act@4');
  for (let n = 0; n < 2; n++) {
    const original = bytes(root);
    expect(() => interviewAnswerCommand(['motion', root, '--from-review', String(act.actId)], Date.now(), { fetch: () => ({ bytes: JSON.stringify({ ...act, value: {} }) }) })).toThrow(Refusal);
    try { interviewAnswerCommand(['motion', root, '--from-review', String(act.actId)], Date.now(), { fetch: () => ({ bytes: JSON.stringify({ ...act, value: {} }) }) }); }
    catch (error) { expect((error as Refusal).code).toBe('REVIEW_ACT_INVALID'); receipt({ control: 'malformed-act', code: (error as Refusal).code, before: jobHash(original), after: jobHash(bytes(root)), adapter: 'writer fetch hook; Review never finalizes malformed acts' }); }
    expect(bytes(root)).toEqual(original);
  }
  // Simulate a receipt that did not declare the returned subject; the CLI must refuse.
  const ackDir = join(jobPrivateRoot(root), 'acknowledged-publications');
  const ackPath = readdirSync(ackDir).map(name => join(ackDir, name)).find(path => JSON.parse(readFileSync(path, 'utf8')).publicationId === act.publicationId)!;
  const ackBytes = readFileSync(ackPath);
  writeFileSync(ackPath, JSON.stringify({ ...JSON.parse(ackBytes.toString()), subjects: [] }), { mode: 0o600 });
  await unchanged(root, ['interview-answer', 'motion', root, '--from-review', String(act.actId)], 'REVIEW_ACT_SUBJECT_UNDECLARED');
  writeFileSync(ackPath, ackBytes, { mode: 0o600 });
  await unchanged(root, ['interview-answer', 'bones', root, '--from-review', String(act.actId)], 'REVIEW_ACT_INVALID');
  // A new valid record edit makes the displayed source stale, before an answer is written.
  writeFileSync(join(root, 'project.json'), Buffer.concat([before, Buffer.from(' ')]));
  await unchanged(root, ['interview-answer', 'motion', root, '--from-review', String(act.actId)], 'REVIEW_ACT_SOURCE_STALE');
  writeFileSync(join(root, 'project.json'), before);
  const result = await cli(root, ['interview-answer', 'motion', root, '--from-review', String(act.actId)]);
  expect(result.exit, result.stderr).toBe(0);
  const saved = readFileSync(join(root, 'project.json'));
  const retry = await cli(root, ['interview-answer', 'motion', root, '--from-review', String(act.actId)]);
  expect(retry.exit, retry.stderr).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  expect(read(root).stage).toBe('rigging-interview');
  const answer = collectItems(read(root), { collection: null }).find(item => item.id === 'motion')!.raw as JsonObject;
  expect((obj(answer.choice).picks as JsonObject[]).map(pick => pick.ask)).toEqual(otherSelections.map(row => row.itemId));
  expect(obj((obj(answer.choice).picks as JsonObject[])[0]).other_text).toBe(otherWords);
  expect(obj(answer.choice).note).toBe(WORDS);
  // Unresolved Other needs an explicit fresh pick. Register/refresh through the CLI.
  set.id = 'resolved-motion';
  set.drafted_at = new Date(Date.now() - 1000).toISOString();
  set.context = optionContext(read(root), 'rigging-interview', Date.now() - 1000, root);
  const resolved = 'evidence/interview/resolved-motion.json';
  writeFileSync(join(root, resolved), JSON.stringify(set, null, 2) + '\n');
  const refreshed = await cli(root, ['interview-options', 'motion', root, '--file', resolved]);
  expect(refreshed.exit, refreshed.stderr).toBe(0);
  const current = await open(root, ['--question', 'motion']);
  expect(current.lines).toContain('job: option-set motion/resolved-motion published');
  const resolvedOwner = await page(root, current.url, 1);
  const resolvedAct = await resolvedOwner.act('interview-picks', 'interview-picks', { questionId: 'motion', selections, note: WORDS });
  const ingested = await cli(root, ['interview-answer', 'motion', root, '--from-review', String(resolvedAct.actId)]);
  expect(ingested.exit, ingested.stderr).toBe(0);
  await checked(root);
}, 30_000);

test.each(['rigging-interview', 'post-interview', 'parts'])('record %s plan public path and immutable retry', async stage => {
  const root = synthetic(stage);
  const opened = await open(root, ['--plan']);
  const owner = await page(root, opened.url, 1);
  const checkpoint = stage === 'parts';
  const act = await owner.act(checkpoint ? 'checkpoint' : 'signoff', checkpoint ? 'checkpoint' : 'signoff', checkpoint
    ? { checkpointId: 'assemble', outcome: 'pass', words: WORDS }
    : { stage, decision: 'approved', words: WORDS });
  expect(act.schema).toBe('rig-review/act@4');
  const before = readFileSync(join(root, 'project.json'));
  const args = ['signoff', stage, root, ...(checkpoint ? ['--checkpoint', 'assemble'] : []), '--from-review', String(act.actId)];
  if (!checkpoint) {
    writeFileSync(join(root, 'project.json'), Buffer.concat([before, Buffer.from(' ')]));
    await unchanged(root, args, 'REVIEW_ACT_SOURCE_STALE');
    writeFileSync(join(root, 'project.json'), before);
  }
  const result = await cli(root, args);
  expect(result.exit, result.stderr).toBe(0);
  const saved = readFileSync(join(root, 'project.json'));
  expect(saved).not.toEqual(before);
  expect(read(root).stage).toBe(stage);
  const retry = await cli(root, args);
  expect(retry.exit, retry.stderr).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  expect((read(root).signoffs as JsonObject[]).at(-1)!.verbatim).toBe(WORDS);
  if (!checkpoint) {
    const advanced = await cli(root, ['advance', stage === 'rigging-interview' ? 'rigging' : 'post', root]);
    expect(advanced.exit, advanced.stderr).toBe(0);
  }
  await checked(root);
}, 30_000);

test('exclusive record selectors and missing pending question refuse before host writes', async () => {
  const root = synthetic('rigging-interview');
  for (const flags of [['--plan', '--question', 'motion'], ['--question', 'motion', '--draft', 'example'], ['--plan', '--rig', '1']]) {
    await unchanged(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...flags], 'JOB_BINDING_INVALID');
  }
  await unchanged(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'absent'], 'JOB_RECORD_SUBJECT_INVALID');
  expect(readWriterBinding(root)).toBeNull();
});

test.each(['rigging-interview', 'post-interview'])('first unanswered %s question can be published before the interview is complete', async stage => {
  const root = synthetic(stage);
  const project = read(root);
  const question = stage === 'rigging-interview' ? 'motion' : 'camera_depth';
  const item = collectItems(project, { collection: null }).find(item => item.id === question)!;
  const binding = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(binding.path)), 'utf8')) as JsonObject;
  item.record.guide = null;
  writeFileSync(join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  set.id = 'first-pending';
  set.drafted_at = new Date(Date.now() - 1000).toISOString();
  set.context = optionContext(project, stage, Date.now() - 1000, root);
  const path = 'evidence/interview/first-pending.json';
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  const registered = await cli(root, ['interview-options', question, root, '--file', path]);
  expect(registered.exit, registered.stderr).toBe(0);
  await unchanged(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--plan'], 'JOB_RECORD_INCOMPLETE');
  const opened = await open(root, ['--question', question]);
  const owner = await page(root, opened.url, 1);
  const selections = (set.asks as JsonObject[]).map(ask => ({ itemId: ask.id, optionId: obj((ask.options as JsonObject[])[0]).id, otherText: null }));
  const act = await owner.act('interview-picks', 'interview-picks', { questionId: question, selections, note: WORDS });
  const ingested = await cli(root, ['interview-answer', question, root, '--from-review', String(act.actId)]);
  expect(ingested.exit, ingested.stderr).toBe(0);
  await checked(root);
}, 30_000);
