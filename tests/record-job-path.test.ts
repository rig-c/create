/** Public CLI -> authenticated Review HTTP API -> CLI ingest, using synthetic records only. */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collectItems, type CheckReport } from '../src/check.ts';
import { interviewAnswerCommand } from '../src/choice-writers.ts';
import { Refusal } from '../src/refusal.ts';
import { loadedPartsIdentity } from '../src/job-publication.ts';
import { JOB_COMMENTS_ACT_SCHEMA, startJobHost, type JobHostOptions } from '@rig-c/review/job-host';
import { openCreateJob } from '../src/job-host.ts';
import reviewPackage from '@rig-c/review/package.json';
import corePackage from '@rig-c/core/package.json';
import { optionContext } from '../src/choices.ts';
import { enqueuePublication, failPublication, pendingPublications, jobHash, jobHostStateRoot, jobPrivateRoot, JOB_BINDING_FILE, readWriterBinding, writePrivateJson, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { fixture, retainSignoffs, obj, arr } from './fixtures.ts';
import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
const CLI = join(import.meta.dir, '../src/cli.ts');
const roots: string[] = [];
const receipt = (value: object) => { if (process.env.RECORD_JOB_RECEIPT) appendFileSync(process.env.RECORD_JOB_RECEIPT, JSON.stringify(value) + '\n'); };
const bytes = (root: string) => readFileSync(join(root, 'project.json'));
const clean = (value: string, root: string) => value.replaceAll(root, '<synthetic>').replace(/http:\/\/127\.0\.0\.1:\d+[^\s]*/g, '<owner-url>');
const opened: { proc: Bun.Subprocess; root: string; finished: Promise<[number, string, string]>; serving: boolean }[] = [];
afterEach(async () => {
  for (const { proc, root, finished, serving } of opened.splice(0)) {
    if (serving && existsSync(root) && readWriterBinding(root)) await cli(root, ['job', 'close', root]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    const [exit] = await finished;
    receipt({ command: ['foreground host', 'exit'], exit });
  }
  for (const root of roots.splice(0)) {
    if (existsSync(root)) {
      rmSync(jobPrivateRoot(root), { recursive: true, force: true });
      rmSync(jobHostStateRoot(root), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
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

async function drainOutput(stream: ReadableStream<Uint8Array>, observe: (text: string) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
      observe(output);
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Start `job open` and wait for its URL and publication summary or a startup failure. */
async function open(root: string, options: string[] = []): Promise<{ url: URL; lines: string[] }> {
  const before = jobHash(bytes(root));
  const previousListener = readWriterBinding(root)?.listenerIncarnation;
  const args = ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...options];
  const command = ['bun', 'src/cli.ts', ...args.map(arg => clean(arg, root))];
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const urlLine = /^http:\/\/[^\n]+\n/;
  const hasSummary = (text: string) => urlLine.test(text) && /\njob: .*\n$/.test(text);
  const namedRefusal = /^(?:rig-create: )?[A-Z][A-Z0-9_]*: .*\n/m;
  const urlWritten = Promise.withResolvers<boolean>();
  const startup = Promise.withResolvers<'published' | 'refused'>();
  let summary = '';
  const stdout = drainOutput(proc.stdout, text => {
    if (urlLine.test(text)) urlWritten.resolve(true);
    if (hasSummary(text)) {
      summary = text;
      startup.resolve('published');
    }
  }).finally(() => urlWritten.resolve(false));
  const stderr = drainOutput(proc.stderr, text => {
    if (namedRefusal.test(text)) startup.resolve('refused');
  });
  const finished = Promise.all([proc.exited, stdout, stderr]);
  const child = { proc, root, finished, serving: false };
  opened.push(child);

  const ownsListener = () => {
    const listener = readWriterBinding(root)?.listenerIncarnation;
    return listener !== undefined && listener !== previousListener;
  };
  const event = await Promise.race([startup.promise, finished.then(() => 'exited' as const)]);
  // The runtime installs its SIGTERM handler before writing the URL. A reused listener's
  // CLI exits by itself, preserving the exit code it already set.
  if (event === 'refused' && await urlWritten.promise && ownsListener()
    && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGTERM');
  }
  if (event === 'published' && ownsListener() && proc.exitCode === null && proc.signalCode === null) {
    child.serving = true;
  } else {
    const [exit, output, errors] = await finished;
    if (exit !== 0 || namedRefusal.test(errors) || !hasSummary(output)) {
      const stderr = clean(errors, root);
      receipt({ command, exit, before, after: jobHash(bytes(root)), stderr });
      throw new Error(`job open exited ${exit} before successful startup\n${stderr.trimEnd()}`);
    }
    summary = output;
  }
  const [url, ...lines] = summary.trim().split('\n');
  receipt({ command, serving: true, before, after: jobHash(bytes(root)), lines });
  return { url: new URL(url!), lines };
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
  const events: JsonObject[] = [];
  const pending = () => {
    const head = events.filter(event => event.type === 'published').at(-1)?.publication as JsonObject | undefined;
    return { head, asks: events.filter(event => event.type === 'pending' && (event.ask as JsonObject).publicationId === head?.publicationId).map(event => event.ask as JsonObject) };
  };
  // Reconnect replays history. Ask counts on an older head do not establish the current page.
  const ready = () => pending().head?.publicationId === expectedPublication.publicationId
    && pending().asks.length >= expectedAsks;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  abort.signal.addEventListener('abort', () => {
    // Cancel a pending read as well as the request, even after headers arrived.
    void reader?.cancel().catch(() => { /* The fetch abort may already have errored the body. */ });
  }, { once: true });
  const timer = setTimeout(() => abort.abort(new Error('Timed out after 10s waiting for the job publication and its asks')), 10_000);
  try {
    const response = await fetch(base + 'events', { headers, signal: abort.signal });
    if (!response.ok || !response.body) throw new Error(`job events did not return a stream (HTTP ${response.status})`);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    while (!ready()) {
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
    abort.signal.throwIfAborted();
  } catch (error) {
    abort.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    abort.abort();
    reader?.releaseLock();
  }
  const { head, asks } = pending();
  expect(head?.publicationId).toBe(expectedPublication.publicationId);
  expect(asks.length).toBeGreaterThanOrEqual(expectedAsks);
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
      const ask = asks.find(item => obj(item.subject).kind === subject && (!('stage' in value) || obj(item.subject).stage === value.stage))!;
      const result = await post('ui/acts', { publicationId: head!.publicationId, askId: ask.askId, pageId,
        displayedNonce: (displayed.value as JsonObject).displayedNonce, expectedGeneration, submissionId: randomUUID(), kind, value });
      expect(result.error).toBeUndefined();
      expectedGeneration++;
      receipt({ command: ['POST', '/jobs/<job>/ui/acts'], exit: 0, act: result.value });
      return result.value as JsonObject;
    },
  };
}


function synthetic(stage: string, legacy = false, ownerLanguage?: string): string {
  const root = realpathSync(fixture(project => {
    project.stage = stage;
    if (ownerLanguage !== undefined) project.owner = { language: ownerLanguage };
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex(stage)
      || (stage === 'parts-review' && signature.stage === 'parts-review'));
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
      if (['bones', 'meshes', 'constraints', 'turn', 'motion'].includes(String(item.id))) item.guide = null;
    }
  }, legacy ? 'legacy-example-project.json' : 'example-project.json'));
  roots.push(root);
  receipt({ seed: 'fixture(example-project.json), synthetic stage prefix only; no pilot', stage, parts: loadedPartsIdentity(root, 'project'), review: reviewPackage.version, core: corePackage.version, bun: Bun.version, record: jobHash(bytes(root)) });
  return root;
}

async function checked(root: string) {
  const result = await cli(root, ['interview', '--check', root]);
  expect(result.exit, result.stderr + result.stdout).toBe(0);
}

async function reviseAfterAnswer(root: string, step: string, reason: string) {
  const before = bytes(root);
  const stale = await cli(root, ['interview', '--check', root, '--json']);
  expect({ exit: stale.exit, stderr: stale.stderr }).toEqual({ exit: 1, stderr: '' });
  const { refusals } = JSON.parse(stale.stdout) as CheckReport;
  expect(refusals.map(({ code, path }) => [code, path])).toEqual([['PLAN_STEP_PREDATES_ANSWER', `plan.steps[${step}]`]]);
  expect(bytes(root)).toEqual(before);
  const revised = await cli(root, ['plan', 'revise', step, root, '--by', 'agent', '--reason', reason]);
  expect(revised.exit, revised.stderr).toBe(0);
}

async function unchanged(root: string, args: string[], code: string, remedy: RegExp[] = [], excluded: string[] = []) {
  const before = readFileSync(join(root, 'project.json'));
  for (let n = 0; n < 2; n++) {
    const result = await cli(root, args);
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain(code);
    for (const token of remedy) expect(result.stderr).toMatch(token);
    for (const token of excluded) expect(result.stderr).not.toContain(token);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  }
}

function stampOptionSet(root: string, project: JsonObject, set: JsonObject) {
  // Draft just after the fixture evidence the set can bind, independently of the CLI clock.
  const contextRecords = [...arr(project.inputs), ...arr(project.signoffs), ...arr(project.scenes ?? [])];
  const times = contextRecords.map(record => Date.parse(String(obj(record).at))).filter(Number.isFinite);
  const draftedAt = Math.max(...times) + 1;
  set.drafted_at = new Date(draftedAt).toISOString();
  set.context = optionContext(project, String(set.stage), draftedAt, root);
}

async function registerReask(root: string, question: string, id: string, customize?: (set: JsonObject) => void): Promise<JsonObject> {
  const project = read(root);
  const item = collectItems(project, { collection: null }).find(item => item.id === question)!;
  const old = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(old.path)), 'utf8')) as JsonObject;
  set.id = id;
  stampOptionSet(root, project, set);
  customize?.(set);
  const path = `evidence/interview/${id}.json`;
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  const registered = await cli(root, ['interview-options', question, root, '--file', path]);
  expect(registered.exit, registered.stderr).toBe(0);
  return set;
}

test('draft, question, then draft publish through the same live owner URL', async () => {
  // Start on the accepted parts draft, before the rigging-interview signoff can be asked.
  const root = synthetic('parts-review');
  const draftId = 'example';
  const draftArgs = ['--draft', draftId];
  const draft = await open(root, draftArgs);
  const initial = await publication(root, draft.url, 0);
  expect(draft.lines).toContain(`job: draft ${draftId} published (publication ${initial.head.publicationId})`);
  expect(obj(initial.head.source).selector).toEqual({ kind: 'draft', id: draftId });
  const bindingFile = join(root, JOB_BINDING_FILE);
  const binding = readFileSync(bindingFile);
  const reopen = (flags: string[]) => cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...flags]);

  const advanced = await cli(root, ['advance', 'rigging-interview', root]);
  expect(advanced.exit, advanced.stderr).toBe(0);
  const set = await registerReask(root, 'motion', 'switch-motion');
  await registerReask(root, 'bones', 'switch-bones');
  const question = await reopen(['--question', 'motion']);
  expect(question.exit, question.stderr).toBe(0);
  expect(question.stdout.trim().split('\n')[0]).toBe(draft.url.href);
  const owner = await page(root, draft.url, 1);
  expect(question.stdout.trimEnd().split('\n')).toContain(`job: option-set motion/switch-motion published (publication ${owner.head.publicationId})`);
  expect(owner.asks.map(ask => ask.subject)).toEqual([{ kind: 'interview-picks', questionId: 'motion', setId: 'switch-motion' }]);

  const before = bytes(root);
  const refusesSwitch = async () => {
    for (const flags of [['--question', 'bones'], draftArgs]) {
      const refused = await reopen(flags);
      expect(refused.exit).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toMatch(/^JOB_ASK_PENDING: /);
      expect(refused.stderr).toContain('interview-picks motion/switch-motion on option-set motion/switch-motion');
    }
    expect(bytes(root)).toEqual(before);
    expect(readFileSync(bindingFile)).toEqual(binding);
    expect(pendingPublications(root)).toEqual([]);
  };
  await refusesSwitch();
  const selections = arr(set.asks).map(raw => {
    const ask = obj(raw);
    return { itemId: ask.id, optionId: obj(arr(ask.options)[0]).id, otherText: null };
  });
  const act = await owner.act('interview-picks', 'interview-picks', { questionId: 'motion', selections, note: WORDS });
  await refusesSwitch();
  const ingested = await cli(root, ['interview-answer', 'motion', root, '--from-review', String(act.actId)]);
  expect(ingested.exit, ingested.stderr).toBe(0);

  const back = await reopen(draftArgs);
  expect(back.exit, back.stderr).toBe(0);
  expect(back.stdout.trim().split('\n')[0]).toBe(draft.url.href);
  const restored = await publication(root, draft.url, 0);
  expect(back.stdout.trimEnd().split('\n')).toContain(`job: draft ${draftId} published (publication ${restored.head.publicationId})`);
  expect(restored.head.publicationId).not.toBe(owner.head.publicationId);
  expect(obj(restored.head.source).selector).toEqual(obj(initial.head.source).selector);
  expect(restored.asks.map(ask => ask.subject)).toEqual([]);
  expect(readFileSync(bindingFile)).toEqual(binding);
}, 60_000);

test('record question public path, API@2 fetch, retry, stale source and wrong subject', async () => {
  const root = synthetic('rigging-interview', false, 'ko');
  const set = await registerReask(root, 'motion', 'pending-motion', set => {
    const ask = obj(arr(set.asks)[0]);
    ask.prompt = 'Spine 움직임을 골라 주세요.';
    const option = obj(arr(ask.options)[0]);
    option.label = 'Spine';
    option.effect = '24';
  });
  const opened = await open(root, ['--question', 'motion']);
  const first = await publication(root, opened.url, 1);
  expect(opened.lines).toEqual([`job: option-set motion/pending-motion published (publication ${first.head.publicationId})`, 'job: asked interview-picks motion/pending-motion']);
  const before = readFileSync(join(root, 'project.json'));
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'motion']);
  expect(again.exit, again.stderr).toBe(0);
  expect(again.stdout.startsWith(opened.url.href + '\n')).toBe(true);
  expect(again.stdout.trimEnd().split('\n')).toContain(`job: option-set motion/pending-motion already published (publication ${first.head.publicationId})`);
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
  expect(act.schema).toBe(JOB_COMMENTS_ACT_SCHEMA);
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
  // Republish the same question on a noncanonical record while an earlier pick is still pending.
  writeFileSync(join(root, 'project.json'), Buffer.concat([before, Buffer.from(' ')]));
  await unchanged(root, ['interview-answer', 'motion', root, '--from-review', String(act.actId)], 'REVIEW_ACT_SOURCE_STALE');
  const republished = await open(root, ['--question', 'motion']);
  expect(republished.url.href).toBe(opened.url.href);
  const latest = await page(root, republished.url, 1);
  const kept = await latest.act('interview-picks', 'interview-picks', { questionId: 'motion', selections: otherSelections, note: WORDS });
  expect(kept.actId).not.toBe(act.actId);
  const words = join(root, 'withdraw-words.txt');
  writeFileSync(words, 'Withdraw my earlier pick.\n');
  const binding = readWriterBinding(root);
  const withdrew = await cli(root, ['job', 'withdraw-act', String(act.actId), root, '--by', 'synthetic-owner',
    '--owner-chat', words, '--said-at', new Date(Date.now() - 1000).toISOString(), '--relayed-by', 'synthetic-operator']);
  expect(withdrew.exit, withdrew.stderr).toBe(0);
  expect(readWriterBinding(root)).toEqual(binding);
  expect(arr(read(root).review_acts).at(-1)).toMatchObject({ kind: 'discarded', actId: act.actId });
  const answerArgs = ['interview-answer', 'motion', root, '--from-review', String(kept.actId)];
  const result = await cli(root, answerArgs);
  expect(result.exit, result.stderr).toBe(0);
  const saved = readFileSync(join(root, 'project.json'));
  const retry = await cli(root, answerArgs);
  expect(retry.exit, retry.stderr).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  expect(read(root).stage).toBe('rigging-interview');
  const answer = collectItems(read(root), { collection: null }).find(item => item.id === 'motion')!.raw as JsonObject;
  expect((obj(answer.choice).picks as JsonObject[]).map(pick => pick.ask)).toEqual(otherSelections.map(row => row.itemId));
  expect(obj((obj(answer.choice).picks as JsonObject[])[0]).other_text).toBe(otherWords);
  expect(obj(answer.choice).note).toBe(WORDS);
  // Unresolved Other needs an explicit fresh pick. Register/refresh through the CLI.
  set.id = 'resolved-motion';
  stampOptionSet(root, read(root), set);
  const resolved = 'evidence/interview/resolved-motion.json';
  writeFileSync(join(root, resolved), JSON.stringify(set, null, 2) + '\n');
  const refreshed = await cli(root, ['interview-options', 'motion', root, '--file', resolved]);
  expect(refreshed.exit, refreshed.stderr).toBe(0);
  const current = await open(root, ['--question', 'motion']);
  const resolvedOwner = await page(root, current.url, 1);
  expect(current.lines).toContain(`job: option-set motion/resolved-motion published (publication ${resolvedOwner.head.publicationId})`);
  const resolvedAct = await resolvedOwner.act('interview-picks', 'interview-picks', { questionId: 'motion', selections, note: WORDS });
  const ingested = await cli(root, ['interview-answer', 'motion', root, '--from-review', String(resolvedAct.actId)]);
  expect(ingested.exit, ingested.stderr).toBe(0);
  const resolvedAnswer = collectItems(read(root), { collection: null }).find(item => item.id === 'motion')!.raw;
  const resolvedPick = obj(arr(obj(obj(resolvedAnswer).choice).picks)[0]);
  expect(resolvedPick.shown).toEqual({ label: 'Spine', effect: '24' });
  await reviseAfterAnswer(root, 'motion', '기록된 선택에 기존 모션 계획이 맞는지 확인했어요.');
  await checked(root);
}, 30_000);

test('exclusive record selectors and missing pending question refuse before host writes', async () => {
  const root = synthetic('rigging-interview');
  for (const flags of [['--plan', '--question', 'motion'], ['--question', 'motion', '--draft', 'example'], ['--plan', '--rig', '1']]) {
    await unchanged(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...flags], 'JOB_BINDING_INVALID');
  }
  await unchanged(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'absent'], 'JOB_RECORD_SUBJECT_INVALID',
    [/project\.json\.interview/, /rig-create interview --check .* --json/], ['rig-create interview-options']);
  expect(readWriterBinding(root)).toBeNull();
}, 20_000);

test.each([
  ['rigging-interview', 'publish', [/rig-create interview-options motion .* --file/, /rig-create job open .* --question motion/]],
  ['parts', 'wait', [/rig-create interview --check .* --json/, /complete the current stage/]],
  ['rig-review', 'chat', [/owner changes-requested/, /exactly one page-level comment/, /rig-create review 2 --from-review .* --item motion:not-asked/, /re-sign rigging-interview/]],
  ['post-interview', 'chat', [/rig-create interview --check .* --json/]],
] as const)('#974 job open names the remedy at %s', async (stage, route, remedies) => {
  const root = synthetic(stage === 'rig-review' ? 'post-interview' : stage);
  const project = read(root);
  if (stage === 'rig-review') {
    project.stage = stage;
    retainSignoffs(project, signature => signature.stage !== stage);
    project.advances = arr(project.advances).filter(value => obj(value).stage !== 'post-interview');
    arr(project.versions).map(obj).find(version => version.n === 2)!.verdicts = [];
    writeFileSync(join(root, 'project.json'), JSON.stringify(project));
  }
  // Exercise the reader's stage-mismatch refusal for an actually registered set.
  if (stage === 'post-interview') await registerReask(root, 'motion', 'wrong-stage-motion');
  const args = ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'motion'];
  const path = /project\.json\.interview\.waypoints\[motion\]\.pending_options/;
  const chat = route === 'chat' ? [
    /Review publication is not available/,
    /rig-create interview-options motion .* --file/,
    /rig-create interview-answer motion .* --set .* --sha256 .* --by .* --pick .* --owner-chat .* --said-at .* --relayed-by/,
    /re-sign .*rig-create next/,
  ] : [];
  const excluded = route === 'publish' ? ['--owner-chat'] : ['rig-create job open'];
  if (route === 'wait') excluded.push('rig-create interview-options', 'rig-create interview-answer');
  await unchanged(root, args, 'JOB_RECORD_SUBJECT_INVALID', [path, ...remedies, ...chat], excluded);
  expect(readWriterBinding(root)).toBeNull();
}, 15_000);

test.each([true, false])('#969 post answer remedy with a live direction bounce = %s', async bounced => {
  const root = realpathSync(fixture(project => {
    project.stage = 'direction-review';
    retainSignoffs(project, signature => signature.stage !== 'direction-review');
    project.advances = arr(project.advances).filter(value => obj(value).stage !== 'accepted');
    if (bounced) project.versions = arr(project.versions).filter(value => obj(value).n !== 4);
  }, 'example-project.json'));
  roots.push(root);
  const path = /project\.json\.interview\.post\.items\[camera_depth\]\.pending_options/;
  const remedies = bounced ? [
    /rig-create interview-options camera_depth .* --file/,
    /rig-create job open .* --question camera_depth.*rig-create interview-answer camera_depth .* --from-review .*rig-create amend post-interview .* --kind interview-answer --target camera_depth/,
    /replan .* re-sign post-interview/,
  ] : [/rig-create interview --check .* --json/, /rig-create interview-answer camera_depth .* --owner-chat/];
  await unchanged(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'camera_depth'],
    'JOB_RECORD_SUBJECT_INVALID', [path, ...remedies], bounced ? ['--owner-chat'] : ['rig-create job open', 'rig-create amend']);
  expect(readWriterBinding(root)).toBeNull();
}, 15_000);

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
  stampOptionSet(root, project, set);
  const path = 'evidence/interview/first-pending.json';
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  const registered = await cli(root, ['interview-options', question, root, '--file', path]);
  expect(registered.exit, registered.stderr).toBe(0);
  await unchanged(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--plan'], 'JOB_RECORD_INCOMPLETE');
  const beforeCheck = await cli(root, ['interview', '--check', root, '--json']);
  const beforeCodes = JSON.parse(beforeCheck.stdout).refusals.map((finding: { code: string; path: string }) => [finding.code, finding.path]);
  expect(beforeCodes).toContainEqual(['INTERVIEW_INCOMPLETE', item.path]);
  const opened = await open(root, ['--question', question]);
  const afterCheck = await cli(root, ['interview', '--check', root, '--json']);
  const afterCodes = JSON.parse(afterCheck.stdout).refusals.map((finding: { code: string; path: string }) => [finding.code, finding.path]);
  expect(afterCodes).toEqual(beforeCodes);
  expect(afterCheck.exit).toBe(beforeCheck.exit);
  receipt({ control: 'ordinary-check-parity-before-after-record-publication', stage, beforeCodes, afterCodes, beforeExit: beforeCheck.exit, afterExit: afterCheck.exit });
  const owner = await page(root, opened.url, 1);
  const selections = (set.asks as JsonObject[]).map(ask => ({ itemId: ask.id, optionId: obj((ask.options as JsonObject[])[0]).id, otherText: null }));
  const act = await owner.act('interview-picks', 'interview-picks', { questionId: question, selections, note: WORDS });
  const ingested = await cli(root, ['interview-answer', question, root, '--from-review', String(act.actId)]);
  expect(ingested.exit, ingested.stderr).toBe(0);
  const step = stage === 'rigging-interview' ? 'motion' : 'camera';
  await reviseAfterAnswer(root, step, `The ${step} definition still fits the recorded synthetic choice.`);
  await checked(root);
}, 30_000);

test('post-interview --questions opens two pending sets on the same rig', async () => {
  const root = synthetic('post-interview');
  const project = read(root);
  project.scenes = [];
  const rigVersion = 2;
  const questions = ['camera_depth', 'post_timing'];
  const items = collectItems(project, { collection: null });
  const sets = questions.map(question => {
    const item = items.find(item => item.id === question)!;
    const binding = obj(obj(item.raw).choice).set as JsonObject;
    const set = JSON.parse(readFileSync(join(root, String(binding.path)), 'utf8')) as JsonObject;
    item.record.guide = null;
    return set;
  });
  writeFileSync(join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  for (const set of sets) {
    set.id = `grouped-${set.question}`;
    stampOptionSet(root, project, set);
    expect(set.context).toMatchObject({ kind: 'rig', rig_version: rigVersion });
    const path = `evidence/interview/${set.id}.json`;
    writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
    const registered = await cli(root, ['interview-options', String(set.question), root, '--file', path]);
    expect(registered.exit, registered.stderr).toBe(0);
  }

  const { url } = await open(root, ['--questions']);
  const { head, asks, base, headers } = await publication(root, url);
  expect(asks.map(ask => ask.subject)).toEqual(sets.map(set => ({
    kind: 'interview-picks', questionId: set.question, setId: set.id,
  })));
  const response = await fetch(`${base}publications/${head.publicationId}`, { headers });
  expect(response.status).toBe(200);
  const display = await response.json() as { ok: boolean; value: unknown };
  expect(display.ok).toBe(true);

  // Exercise Review's shipped client preparation against the live HTTP routes.
  const { prepareJobInspection } = await import(new URL('../web/job-session.ts', import.meta.resolve('@rig-c/review/job-host')).href) as {
    prepareJobInspection(display: unknown, signal: AbortSignal): Promise<{
      interview: { questions: { set: JsonObject }[] } | null;
      dispose(): void;
    }>;
  };
  const browserGlobals = ['location', 'document'] as const;
  const originals = browserGlobals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: { origin: url.origin } },
    document: { configurable: true, value: { createElement: () => ({}) } },
  });
  try {
    const prepared = await prepareJobInspection(display.value, AbortSignal.timeout(5_000));
    try {
      expect(prepared.interview?.questions.map(({ set }) => ({
        question: set.question, id: set.id, rig: obj(set.context).rig_version,
      }))).toEqual(sets.map(set => ({ question: set.question, id: set.id, rig: rigVersion })));
    } finally {
      prepared.dispose();
    }
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);

test('record selectors refuse a legacy package-only host byte-identically with the close/reopen remedy', async () => {
  const root = synthetic('rigging-interview');
  let recordOptions!: JobHostOptions;
  const legacy = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now(), options => {
    recordOptions = options;
    return startJobHost({ ...options, publicationMode: 'package-only', readRecordPublished: undefined, recordReaderId: undefined });
  });
  try {
    expect(legacy.session.publicationMode).toBe('package-only');
    const binding = readWriterBinding(root)!;
    delete binding.identity.publicationMode;
    const bindingFile = join(root, JOB_BINDING_FILE);
    writePrivateJson(bindingFile, binding, true);
    const before = readFileSync(bindingFile);
    // Ordinary Review reopen probes the fresh options against the running legacy host.
    expect(recordOptions.reuseOnly).toBeUndefined();
    expect(recordOptions.publicationMode).toBe('record-and-package');
    await expect(startJobHost({ ...recordOptions, port: Number(new URL(legacy.origin).port) }))
      .rejects.toMatchObject({ code: 'JOB_HOST_REUSE_MISMATCH' });
    const args = ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner'];
    const recordBefore = bytes(root);
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await cli(root, [...args, '--plan']);
      expect(refused.exit).toBe(1);
      expect(refused.stderr).toContain('JOB_HOST_REUSE_MISMATCH');
      expect(refused.stderr).toContain('publicationMode expected=record-and-package found=package-only');
      expect(refused.stderr).toContain('finish and ingest pending acts, then run job close once and retry job open');
      expect(bytes(root)).toEqual(recordBefore);
      expect(readFileSync(bindingFile)).toEqual(before);
    }
    const closed = await cli(root, ['job', 'close', root]);
    expect(closed.exit, closed.stderr).toBe(0);
  } finally {
    legacy.stop();
  }
  const record = await open(root, ['--plan']);
  expect(record.lines).toHaveLength(1);
  expect(record.lines[0]).toMatch(/^job: plan published \(publication .+\)$/);
}, 20_000);


test('legacy post-only adoption reaches all three owner picks and the post move', async () => {
  const root = synthetic('post-interview', true);
  // The retained legacy seed has no build-time draft. Declare its accepted parts
  // identity and accepted rig from the writer-built example, keeping legacy
  // interview/plan approvals and order. Only this seed is fixture-written.
  const source = synthetic('post-interview');
  const seed = read(root);
  const current = read(source);
  // The legacy interview predates post answers; fixture auto-binding otherwise
  // invents a historical approval of these later post questions.
  const interviewApproval = (seed.signoffs as JsonObject[]).find(s => s.stage === 'interview')!;
  for (const question of ['camera_depth', 'post_timing', 'post_composition']) delete obj(interviewApproval.answer_hashes)[question];
  seed.stage = 'rig-review';
  seed.advances = (seed.advances as JsonObject[]).filter(a => a.stage !== 'post-interview');
  seed.versions = current.versions;
  const rigApproval = (seed.signoffs as JsonObject[]).find(s => s.stage === 'rig-review')!;
  Object.assign(rigApproval, (current.signoffs as JsonObject[]).find(s => s.stage === 'rig-review')!);
  for (const path of ['outputs', 'derived/review']) {
    rmSync(join(root, path), { recursive: true, force: true });
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  cpSync(join(source, 'evidence'), join(root, 'evidence'), { recursive: true });
  seed.inputs = current.inputs;
  seed.derived = current.derived;
  for (const input of current.inputs as JsonObject[]) {
    const path = String(input.path);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path));
  }
  seed.drafts = (current.drafts as JsonObject[]).filter(d => d.id === 'example');
  seed.review_acts = (current.review_acts as JsonObject[]).filter(a => a.draft_id === 'example');
  const parts = (seed.signoffs as JsonObject[]).find(s => s.stage === 'parts-review')!;
  const replacement = (current.signoffs as JsonObject[]).find(s => s.stage === 'parts-review')!;
  Object.assign(parts, replacement, { at: parts.at });
  for (const path of ['derived/drafts', String(obj(parts.evidence).path), String(obj(parts.structure).path)]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  writeFileSync(join(root, 'project.json'), JSON.stringify(seed, null, 2) + '\n');
  const advanced = await cli(root, ['advance', 'post-interview', root]);
  expect(advanced.exit, advanced.stderr).toBe(0);
  const before = bytes(root).toString();
  const adopted = await cli(root, ['interview-options', '--adopt', root]);
  expect(adopted.exit, adopted.stderr).toBe(0);
  const after = bytes(root).toString();
  // Removing the one inserted post property restores every original byte.
  expect(after.replace(/,?\n\s*"choices_adopted_at": "[^"]+"/, '')).toBe(before);
  expect(obj(read(root).interview).order).toBeUndefined();
  const retry = await cli(root, ['interview-options', '--adopt', root]);
  expect(retry.exit, retry.stderr).toBe(0);
  expect(bytes(root).toString()).toBe(after);
  for (const question of ['rig_type', 'motion']) {
    const set = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-interview-options/example-' + question.replaceAll('_', '-') + '.json'), 'utf8')) as JsonObject;
    set.id = 'legacy-control-' + question;
    set.stage = 'interview';
    stampOptionSet(root, read(root), set);
    const path = 'evidence/interview/' + set.id + '.json';
    writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
    await unchanged(root, ['interview-options', question, root, '--file', path], 'INTERVIEW_CHOICE_REQUIRED');
  }
  let ownerUrl: URL | undefined;
  const publishNext = async (selector: string, id?: string): Promise<URL> => {
    const next = await cli(root, ['next', root, '--json']);
    expect(next.exit, next.stderr).toBe(0);
    const commands = arr(obj(JSON.parse(next.stdout)).moves).map(move => obj(move).command);
    const flags = id === undefined ? [selector] : [selector, id];
    expect(commands).toContain(`rig-create job open ${root} ${flags.join(' ')} --reviewer '<reviewer>' --role owner`);
    expect(commands).toContain(`rig-create job acts ${root} --json --wait`);
    expect(commands).not.toContain(`rig-create job close ${root}`);
    if (!ownerUrl) {
      ownerUrl = (await open(root, flags)).url;
    } else {
      const previous = readWriterBinding(root)!;
      const attached = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...flags]);
      expect(attached.exit, attached.stderr).toBe(0);
      expect(attached.stdout.startsWith(ownerUrl.href + '\n')).toBe(true);
      expect(readWriterBinding(root)).toMatchObject({ jobId: previous.jobId, origin: previous.origin });
    }
    return ownerUrl;
  };
  // Open on the first question and keep the same owner URL through the plan signoff.
  for (const question of ['camera_depth', 'post_timing', 'post_composition']) {
    const set = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-interview-options/example-' + question.replaceAll('_', '-') + '.json'), 'utf8')) as JsonObject;
    set.id = 'legacy-' + question;
    stampOptionSet(root, read(root), set);
    const path = 'evidence/interview/' + set.id + '.json';
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
    const registered = await cli(root, ['interview-options', question, root, '--file', path]);
    expect(registered.exit, registered.stderr).toBe(0);
    const owner = await page(root, await publishNext('--question', question), 1);
    const selections = (set.asks as JsonObject[]).map(ask => ({ itemId: ask.id, optionId: obj((ask.options as JsonObject[])[0]).id, otherText: null }));
    const act = await owner.act('interview-picks', 'interview-picks', { questionId: question, selections, note: WORDS });
    const acts = await cli(root, ['job', 'acts', root]);
    expect(acts.exit, acts.stderr).toBe(0);
    const answer = await cli(root, ['interview-answer', question, root, '--from-review', String(act.actId)]);
    expect(answer.exit, answer.stderr).toBe(0);
  }
  const wordsFile = join(root, 'post-approval.txt');
  writeFileSync(wordsFile, WORDS);
  const signed = await cli(root, ['signoff', 'post-interview', root, '--by', 'synthetic-owner',
    '--owner-chat', wordsFile, '--said-at', new Date(Date.now() - 1000).toISOString(), '--relayed-by', 'synthetic-operator']);
  expect(signed.exit, signed.stderr).toBe(0);
  const next = await cli(root, ['next', root]);
  expect(next.exit, next.stderr).toBe(0);
  expect(next.stdout).toContain('advance');
  const post = await cli(root, ['advance', 'post', root]);
  expect(post.exit, post.stderr).toBe(0);
  const move = await cli(root, ['next', root]);
  expect(move.exit, move.stderr).toBe(0);
  expect(move.stdout).toContain('camera');
  await checked(root);
}, 60_000);
