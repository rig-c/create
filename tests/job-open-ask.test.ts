/**
 * `job open` publishes the record's current draft and asks its declared subjects (#352).
 * The cycle tests go through the shipped CLI: no in-process host and no agent credential.
 * The person is the owner page, so its acts go over the host's HTTP UI routes.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startJobHost } from '@rig-c/review/job-host';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { inputCommand } from '../src/inputs.ts';
import { closeCreateJob, openCreateJob, openDraftPublication, openRecordPublication, publishPending, reconcileCreateJob } from '../src/job-host.ts';
import { acknowledgePublication, enqueuePublication, failPublication, isRecordResult, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, publicationVersionHash, readAcknowledgedPublication, readWriterBinding, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { draftPublicationContext, prepareLiveManifest, readPublished } from '../src/job-publication.ts';
import { draftPublicationResult, jobRuntimeExecArgv, prepareDraftIntent } from '../src/job-writer.ts';
import { hostPortRefuses } from '../src/job-host-state.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import type { JsonObject } from '../src/templates.ts';
import { OWN_NODE_MODULES, PARTS_PACKAGE } from '../src/parts-sections.ts';
import { seedHistoricalPendingAsk } from './historical-review-fixture.ts';
import { seedRetainedDirectionPost, seedRetainedDraft, seedRetainedScene } from './numbered-seed.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
const roots: string[] = [];
const opened: { proc: Bun.Subprocess; root: string }[] = [];

test('#532 job open prints the retained producer code and full lockfile refusal in its host terminal', async () => {
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-reader-output-')));
  const root = join(container, 'project');
  roots.push(root, container);
  const host = join(container, 'host');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/0a-interview-options'), root, { recursive: true });
  mkdirSync(host);
  cpSync(join(import.meta.dir, '../src'), join(host, 'src'), { recursive: true });
  cpSync(join(import.meta.dir, '../scripts'), join(host, 'scripts'), { recursive: true });
  writeFileSync(join(host, 'package.json'), '{"type":"module"}\n');
  // Inventory uses the project's valid lock. Only the host's fallback install has
  // the planted npm entry: no shared install or checkout lockfile is changed.
  for (const base of [root, host]) {
    symlinkSync(OWN_NODE_MODULES, join(base, 'node_modules'));
    cpSync(join(OWN_NODE_MODULES, '..', 'bun.lock'), join(base, 'bun.lock'));
  }
  const version = JSON.parse(readFileSync(join(OWN_NODE_MODULES, PARTS_PACKAGE, 'package.json'), 'utf8')).version as string;
  writeFileSync(join(host, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
    packages: { [`node_modules/${PARTS_PACKAGE}`]: { version } } }));
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(host, 'src/cli.ts'),
    'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'rig_type'],
  { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  opened.push({ proc, root });
  let stderr = '';
  const errors = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stderr += decoder.decode(chunk.value, { stream: true });
      }
      stderr += decoder.decode();
    } finally { reader.releaseLock(); }
  })();
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(first.value)).toStartWith('http://');
  const expected = `JOB_RECORD_PARTS_LOCK_MISSING: project.json: the host's @rig-c/parts ${version} has no matching package-lock.json entry with an integrity; install it from a lockfile that records its integrity and publish again`;
  try {
    for (let i = 0; i < 200 && !stderr.includes('JOB_PUBLISH_PENDING:'); i++) await Bun.sleep(25);
    expect(stderr).toContain(`${expected}\n`);
    expect(stderr).toContain('(JOB_RECORD_INCOMPLETE): JOB_RECORD_PARTS_LOCK_MISSING;');
    // The full detail stays in the host terminal, outside Review's safe API reply.
    expect(pendingPublications(root)[0]?.failure?.message).not.toContain('has no matching package-lock.json');
  } finally {
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(1);
    await errors;
  }
}, 15000);

afterEach(async () => {
  for (const { proc, root } of opened.splice(0)) {
    if (readWriterBinding(root)) await cli(root, ['job', 'close', root]);
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    const state = jobHostStateRoot(root);
    rmSync(state, { recursive: true, force: true });
    // These uniquely keyed siblings were preserved by this test's same-path redo.
    if (existsSync(dirname(state))) for (const name of readdirSync(dirname(state))) {
      if (name.startsWith(`${basename(state)}.replaced-`)) rmSync(join(dirname(state), name), { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** Allocate while the original inode is still live: rm/copy alone can reuse it on Linux. */
function replaceProjectRoot(root: string, source: string, scenario: string): void {
  const replacement = mkdtempSync(join(dirname(root), `${basename(root)}-replacement-`));
  const identity = (path: string) => { const info = lstatSync(path); return { dev: info.dev, ino: info.ino }; };
  try {
    cpSync(source, replacement, { recursive: true });
    const previous = identity(root), allocated = identity(replacement);
    console.log('#523 replacement precondition', { scenario, previous, allocated });
    expect(allocated.dev).toBe(previous.dev);
    expect(allocated.ino).not.toBe(previous.ino);
    rmSync(root, { recursive: true });
    renameSync(replacement, root);
    const installed = identity(root);
    console.log('#523 replacement installed', { scenario, previous, installed });
    expect(installed).toEqual(allocated);
  } finally { rmSync(replacement, { recursive: true, force: true }); }
}

test('#523 a killed host permits a pristine same-path redo and retains the old state bytes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-redo-'))); roots.push(root);
  const source = join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict');
  cpSync(source, root, { recursive: true });
  await open(root);
  // Kill the recorded host, not an arbitrary process matching a command or port.
  const state = jobHostStateRoot(root), binding = readWriterBinding(root)!;
  const descriptor = join(state, 'host/job-ui', `${binding.jobId}.json`);
  const record = JSON.parse(readFileSync(descriptor, 'utf8')) as { pid: number };
  process.kill(record.pid, 'SIGKILL');
  expect(await opened.at(-1)!.proc.exited).toBe(137);
  const retainedDb = readFileSync(join(state, 'host/jobs.sqlite'));
  const retainedDescriptor = readFileSync(descriptor);
  replaceProjectRoot(root, source, 'killed-host');
  const second = await open(root);
  expect(second.lines).toEqual([publishedLine('draft chain published', root)]);
  expect(readWriterBinding(root)!.jobId).not.toBe(binding.jobId);
  const archives = readdirSync(dirname(state)).filter(name => name.startsWith(`${basename(state)}.replaced-`));
  expect(archives).toHaveLength(1);
  const archived = join(dirname(state), archives[0]!, 'host');
  expect(readFileSync(join(archived, 'jobs.sqlite'))).toEqual(retainedDb);
  expect(readFileSync(join(archived, 'job-ui', `${binding.jobId}.json`))).toEqual(retainedDescriptor);
}, 20_000);

test('#523 reconcile recovers a dead same-path host before job open, and live replaced-root refuses before writes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-redo-reconcile-'))); roots.push(root);
  const source = join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict');
  cpSync(source, root, { recursive: true });
  await open(root);
  const binding = readWriterBinding(root)!;
  const descriptor = join(jobHostStateRoot(root), 'host/job-ui', `${binding.jobId}.json`);
  const { pid } = JSON.parse(readFileSync(descriptor, 'utf8')) as { pid: number };
  // Keep the old host live while replacing only this synthetic project directory.
  replaceProjectRoot(root, source, 'live-host');
  const pristine = readFileSync(join(root, 'project.json'));
  for (const action of ['open', 'reconcile']) {
    const result = await cli(root, ['job', action, root, ...(action === 'open' ? ['--reviewer', 'synthetic-owner', '--role', 'owner'] : [])]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toStartWith('JOB_ROOT_REPLACED: ');
    expect(result.stderr).toContain(`recorded PID ${pid}`);
    expect(readFileSync(join(root, 'project.json'))).toEqual(pristine);
    expect(readWriterBinding(root)).toBeNull();
    expect(existsSync(descriptor)).toBe(true);
  }
  // The live listener was preserved even though requests against replaced sources may refuse.
  expect(await hostPortRefuses(Number(new URL(binding.origin).port))).toBe(false);
  process.kill(pid, 'SIGKILL');
  expect(await opened.at(-1)!.proc.exited).toBe(137);
  const reconciled = await cli(root, ['job', 'reconcile', root]);
  expect({ exit: reconciled.exit, stderr: reconciled.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(reconciled.stdout).toContain('reconciled 0 publication(s)');
  expect(existsSync(jobHostStateRoot(root))).toBe(false);
  expect((await open(root)).lines[0]).toBe(publishedLine('draft chain published', root));
}, 20_000);

const WORDS = '  Synthetic page words.\n';
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));

function registeredRig(stage = 'rigging', edit: (project: JsonObject) => void = () => {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-rig-selector-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), root, { recursive: true });
  const project = read(root);
  project.stage = stage;
  const meshes = ((project.plan as JsonObject).steps as JsonObject[]).find(step => step.id === 'meshes')!;
  (meshes.checkpoint as JsonObject).value = true;
  edit(project);
  writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return root;
}

async function cli(root: string, args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

/** The example chain's parts stage, moved into parts-review by the shipped advance writer. Its draft `chain` is recorded. */
async function partsReview(prepareMap = true): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-ask-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), root, { recursive: true });
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  const structure = await cli(root, ['structure-snapshot', root, '--draft', 'chain', '--out', 'evidence/structure-chain.json']);
  expect({ exit: structure.exit, stderr: structure.stderr }).toEqual({ exit: 0, stderr: '' });
  if (prepareMap) {
    const triaged = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
    expect(triaged.exit).toBe(0);
  }
  const advanced = await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']);
  expect(advanced.exit).toBe(0);
  return root;
}

test.each(['record', 'draft'] as const)('#827 reconcile drains a pending plan and draft with the %s receipt ID first', async first => {
  const root = await partsReview();
  const openHost = () => openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now());
  let host = await openHost();
  const file = join(root, 'project.json');
  const draft = draftPublicationResult('chain');
  const plan = { kind: 'plan' } as const;
  const id = (result: typeof draft | typeof plan) => jobHash(JSON.stringify([
    host.session.jobId, publicationVersionHash(readFileSync(file), result), result,
  ]));
  const order = () => id(plan) < id(draft) ? 'record' : 'draft';
  try {
    // Avoid draft hashes near either extreme, where varying the record hash could
    // require many writes. Both operations use the normal host and record writers.
    const middle = () => /^[4-9ab]/.test(id(draft));
    for (let n = 0; !middle() && n < 32; n++) {
      await closeCreateJob(root);
      host.stop();
      host = await openHost();
    }
    expect(middle()).toBe(true);
    for (let n = 0; order() !== first && n < 64; n++) {
      const name = `order-control-${n}.txt`;
      writeFileSync(join(root, name), `Synthetic receipt order control ${n}\n`);
      expect(inputCommand(['add', name, root, '--origin', 'synthetic receipt order control'], EXAMPLE_NOW).exit).toBe(0);
    }
    expect(order()).toBe(first);
    const before = readFileSync(file);
    const config = join(root, 'bunfig.toml');
    writeFileSync(config, 'preload = ["./fail-attach.ts"]\n');
    // Fail only the publication probe after the CLI has enqueued the plan. The
    // host stays live, and removing the preload restores the normal probe.
    writeFileSync(join(root, 'fail-attach.ts'), `
      import { existsSync } from 'node:fs';
      const original = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        if (String(url).endsWith('/host') && options?.method === 'POST' && existsSync('.rig-create-review/outbox/${id(plan)}.json')) {
          throw Error('planted attachment probe failure after record enqueue');
        }
        return original(url, options);
      };
    `);
    const openArgs = ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner'];
    const planOpen = await cli(root, [...openArgs, '--plan']);
    rmSync(config);
    expect(planOpen).toMatchObject({ exit: 1, stderr: expect.stringMatching(/^JOB_PUBLISH_PENDING:.*JOB_HOST_ATTACH_REFUSED/) });
    expect(readFileSync(file)).toEqual(before);
    expect(pendingPublications(root)).toMatchObject([{ id: id(plan), result: plan, phase: 'pending', generation: 0,
      failure: { code: 'JOB_HOST_ATTACH_REFUSED' } }]);
    expect((await fetch(new URL(host.ownerUrl))).status).toBe(200);

    const draftOpen = await cli(root, [...openArgs, '--draft', 'chain']);
    expect(draftOpen).toMatchObject({ exit: 1, stderr: expect.stringMatching(/^JOB_PUBLISH_PENDING:.*job reconcile/) });
    expect(pendingPublications(root).map(entry => entry.id)).toEqual([id(plan)]);
    expect(readFileSync(file)).toEqual(before);

    // Emulate the second receipt left by an older Create, using the real outbox writer.
    enqueuePublication(root, readWriterBinding(root)!, draft);
    const mixed = pendingPublications(root);
    expect(mixed.map(entry => entry.id)).toEqual(first === 'record' ? [id(plan), id(draft)] : [id(draft), id(plan)]);
    expect(mixed.find(entry => !isRecordResult(entry.result))).toMatchObject({ phase: 'pending', failure: null });
    expect(host.session.status().generation).toBe(0);
    expect(readFileSync(file)).toEqual(before);
    const revise = await cli(root, ['plan', 'revise', 'meshes', root, '--by', 'agent', '--bar', 'Synthetic changed bar']);
    expect(revise).toMatchObject({ exit: 1, stderr: expect.stringMatching(/^rig-create: JOB_PUBLISH_PENDING:/) });
    expect(readFileSync(file)).toEqual(before);
    const close = await cli(root, ['job', 'close', root]);
    expect(close).toMatchObject({ exit: 1, stderr: expect.stringMatching(/^JOB_PUBLISH_PENDING:/) });
    expect(pendingPublications(root)).toEqual(mixed);
    expect(readFileSync(file)).toEqual(before);

    const reconciled = await cli(root, ['job', 'reconcile', root]);
    expect(reconciled).toEqual({ exit: 0, stdout: 'job: reconciled 2 publication(s)\n', stderr: '' });
    expect(pendingPublications(root)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
    const receipts = join(jobPrivateRoot(root), 'acknowledged-publications');
    const acknowledged = readdirSync(receipts)
      .map(name => JSON.parse(readFileSync(join(receipts, name), 'utf8')) as AcknowledgedPublication)
      .sort((a, b) => a.generation - b.generation);
    expect(acknowledged.map(receipt => receipt.result)).toEqual([plan, draft]);
    const status = host.session.status();
    expect(status.publication?.publicationId).toBe(acknowledged[1]!.publicationId);
    expect(status.pending).toEqual([]);
    expect(await cli(root, ['job', 'reconcile', root])).toEqual({ exit: 0, stdout: 'job: reconciled 0 publication(s)\n', stderr: '' });
  } finally { host.stop(); }
}, 45_000);

test.each([
  { kind: 'parts-verdict', draftId: 'chain' },
  { kind: 'review-verdict', stage: 'rig-review' },
  { kind: 'signoff', stage: 'direction-review' },
  { kind: 'checkpoint', checkpointId: 'bones' },
  { kind: 'interview-picks', questionId: 'bones', setId: 'chain-bones' },
] as const)('a retained open $kind ask does not block a writer or publication', async subject => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-retired-ask-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/2-rigging-answers'), root, { recursive: true });
  const now = Date.now();
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, now);
  try {
    await openRecordPublication(root, host, 'bones', false, now);
    const publicationId = host.session.status().publication!.publicationId;
    seedHistoricalPendingAsk(host, publicationId, subject);
    expect(host.session.status().pending.map(ask => ask.subject)).toEqual([subject]);

    const path = 'inputs/synthetic-source.txt';
    writeFileSync(join(root, path), 'Synthetic source bytes.\n');
    const write = await cli(root, ['input', 'add', path, root, '--origin', 'synthetic source']);
    const publish = await openDraftPublication(root, host, now, 'chain').catch((error: unknown) => String(error));
    expect({ writerExit: write.exit, writerError: write.stderr, publication: publish }).toEqual({
      writerExit: 0,
      writerError: '',
      publication: [expect.stringMatching(/^job: draft chain published /)],
    });
    expect(host.session.status().publication!.publicationId).not.toBe(publicationId);
    expect(host.session.status().pending).toEqual([]);
  } finally { host.stop(); }
}, 30_000);

test('#827 a mixed outbox reconciles past a retired interview ask', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-ask-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/2-rigging-answers'), root, { recursive: true });
  const now = Date.now();
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, now);
  try {
    const binding = readWriterBinding(root)!;
    const file = join(root, 'project.json');
    const before = readFileSync(file);
    const record = { kind: 'option-set', questionId: 'bones', setId: 'chain-bones' } as const;
    const legacySubject = { kind: 'interview-picks' as const, questionId: 'bones', setId: 'chain-bones' };
    const draft = draftPublicationResult('chain');
    enqueuePublication(root, binding, record);
    enqueuePublication(root, binding, draft);

    // The queued draft replaces the record publication without requiring an answer to its retired ask.
    let seededLegacyAsk = false;
    const publishWithLegacyAsk = async (entry: Parameters<typeof publishPending>[0]) => {
      await publishPending(entry, undefined, undefined, async () => ({ ...host, reused: true, stop: () => {} }));
      if (!seededLegacyAsk && isRecordResult(entry.result)) {
        seededLegacyAsk = true;
        const publicationId = host.session.status().publication!.publicationId;
        seedHistoricalPendingAsk(host, publicationId, legacySubject);
      }
    };

    expect(await reconcileCreateJob(root, publishWithLegacyAsk)).toBe(2);
    expect(seededLegacyAsk).toBe(true);
    const status = host.session.status();
    expect(readAcknowledgedPublication(root, binding.jobId, status.publication!.publicationId)?.result).toEqual(draft);
    expect(status.pending).toEqual([]);
    expect(await cli(root, ['job', 'close', root])).toEqual({ exit: 0, stdout: 'job: closed\n', stderr: '' });
    expect(pendingPublications(root)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
  } finally { host.stop(); }

  // 2. A fresh mixed outbox opens no interview ask on the option-set and reconciles both entries cleanly.
  const freshHost = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, now + 1_000);
  try {
    const binding = readWriterBinding(root)!;
    const file = join(root, 'project.json');
    const before = readFileSync(file);
    const record = { kind: 'option-set', questionId: 'bones', setId: 'chain-bones' } as const;
    const draft = draftPublicationResult('chain');
    enqueuePublication(root, binding, record);
    enqueuePublication(root, binding, draft);

    const reconciled = await cli(root, ['job', 'reconcile', root]);
    expect(reconciled).toEqual({ exit: 0, stdout: 'job: reconciled 2 publication(s)\n', stderr: '' });
    expect(pendingPublications(root)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
  } finally { freshHost.stop(); }
}, 25_000);

function spawnJobOpen(root: string, options: string[], projectPath = root) {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', projectPath, '--reviewer', 'synthetic-owner', '--role', 'owner', ...options],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  opened.push({ proc, root });
  return proc;
}

/** Start `job open` in the background and read its URL line and the summary it prints after publishing. */
async function open(root: string, options: string[] = [], projectPath = root): Promise<{ url: URL; lines: string[] }> {
  const proc = spawnJobOpen(root, options, projectPath);
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
  return { url: new URL(lines[0]!), lines: lines.slice(1) };
}

function latestReceipt(root: string): AcknowledgedPublication {
  const jobId = readWriterBinding(root)!.jobId;
  const receipts = join(jobPrivateRoot(root), 'acknowledged-publications');
  return readdirSync(receipts)
    .map(file => JSON.parse(readFileSync(join(receipts, file), 'utf8')) as AcknowledgedPublication)
    .filter(receipt => receipt.jobId === jobId)
    .sort((a, b) => b.generation - a.generation)[0]!;
}

const publishedLine = (label: string, root: string) => `job: ${label} (publication ${latestReceipt(root).publicationId})`;

/** Read the publication and its declared asks without acknowledging a display or submitting an act. */
async function publication(root: string, url: URL, expectedAsks = 2) {
  const jobId = /\/jobs\/([^/]+)\//.exec(url.pathname)![1]!;
  const expectedPublication = latestReceipt(root);
  expect(expectedPublication).toBeDefined();
  expect(expectedPublication.jobId).toBe(jobId);
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
    inspect: async (): Promise<JsonObject> => {
      const route = `publications/${String(head.publicationId)}/instances/${String(head.instanceKey)}/api/review`;
      const response = await fetch(base + route, { headers });
      expect(response.status).toBe(200);
      return response.json() as Promise<JsonObject>;
    },
    comment: async (text: string): Promise<JsonObject> => {
      const result = await post('ui/acts', { publicationId: head.publicationId, pageId,
        displayedNonce: (displayed.value as JsonObject).displayedNonce, expectedGeneration, submissionId: randomUUID(),
        kind: 'comments', value: { comments: [{ text }] } });
      expect(result.error).toBeUndefined();
      expectedGeneration++;
      return result.value as JsonObject;
    },
    act: async (subject: string, kind: string, value: object): Promise<JsonObject> => {
      const ask = asks.find(item => (item.subject as JsonObject).kind === subject)!;
      const png = subject === 'review-verdict' && (value as JsonObject).stage === 'rig-review'
        ? readFileSync(join(root, 'evidence/setup.png')) : null;
      const capture = png === null ? {} : { capture: {
        png: `data:image/png;base64,${png.toString('base64')}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
        camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
        binding: { publicationId: head.publicationId, instanceKey: head.instanceKey, sourceHash: (head.source as JsonObject).sourceHash,
          pageId, askId: ask.askId, drawGeneration: 1, playerGeneration: 0 },
      } };
      const result = await post('ui/acts', { publicationId: head!.publicationId, askId: ask.askId, pageId,
        displayedNonce: (displayed.value as JsonObject).displayedNonce, expectedGeneration, submissionId: randomUUID(), kind, value, ...capture });
      expect(result.error).toBeUndefined();
      expectedGeneration++;
      return result.value as JsonObject;
    },
  };
}

test('#412 public job open selects a registered rig on a new empty head and retries idempotently', async () => {
  const root = registeredRig();
  const old = await open(root);
  expect(old.lines).toEqual(['job: stage rigging shows no draft; name one with --draft <id>']);
  expect((await cli(root, ['job', 'close', root])).exit).toBe(0);
  await opened.at(-1)!.proc.exited;
  expect(readWriterBinding(root)).toBeNull();
  const before = read(root);

  const selected = await open(root, ['--rig', '1']);
  expect(selected.lines).toEqual([publishedLine('rig v1 published', root)]);
  const first = await publication(root, selected.url, 0);
  expect((first.head.source as JsonObject).selector).toEqual({ kind: 'rig', version: 1 });
  expect(first.asks.map(ask => ask.subject)).toEqual([]);
  const saved = readFileSync(join(root, 'project.json'));
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', 'v1']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n')).toEqual([
    selected.url.href, publishedLine('rig v1 already published', root),
  ]);
  const repeated = await publication(root, selected.url, 0);
  expect(repeated.head.publicationId).toBe(first.head.publicationId);
  expect(repeated.asks.map(ask => ask.askId)).toEqual(first.asks.map(ask => ask.askId));
  expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  expect(read(root).stage).toBe(before.stage);
  expect(read(root).versions).toEqual(before.versions);
  expect(read(root).signoffs).toEqual(before.signoffs);
  expect(read(root).plan).toEqual(before.plan);
  expect(pendingPublications(root)).toEqual([]);
}, 20_000);

test('#852 job open --rig publishes through a symlink to the project root', async () => {
  const root = registeredRig('rig-review');
  const alias = `${root}-alias`;
  symlinkSync(root, alias, 'dir');
  try {
    const opening = await open(root, ['--rig', '1'], alias);
    expect(opening.lines).toEqual([publishedLine('rig v1 published', root)]);
    expect(opening.lines.join('\n')).not.toMatch(/JOB_PUBLICATION_ASK_REQUIRED|JOB_RIG_VERDICT_DEFERRED/);
    const { head } = await publication(root, opening.url, 0);
    expect((head.source as JsonObject).selector).toEqual({ kind: 'rig', version: 1 });
  } finally {
    rmSync(alias);
  }
}, 20_000);

test('#852 job open --rig refuses a symlinked source inside the project before writing', async () => {
  const root = registeredRig('rig-review');
  const project = join(root, 'project.json');
  const source = 'derived/review/v1/out/check/build/skeleton.model.json';
  const model = join(root, source);
  const target = join(root, 'model-target.json');
  renameSync(model, target);
  symlinkSync(target, model);
  const before = readFileSync(project);

  const proc = spawnJobOpen(root, ['--rig', '1']);
  const stdout = proc.stdout.getReader();
  try {
    // Fail as soon as an unexpected host prints its URL, so teardown can close it.
    expect((await stdout.read()).done).toBe(true);
  } finally { stdout.releaseLock(); }
  const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(exit).toBe(1);
  expect(stderr).toStartWith(`JOB_PUBLICATION_INVALID: project.json: ${source} must be a regular source without symlinks`);
  expect(readFileSync(project)).toEqual(before);
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(jobHostStateRoot(root))).toBe(false);
}, 20_000);

test.each(['0', 'absent', '1.5', '9007199254740992', '2'])('#412 refuses invalid or absent rig %s before creating a host or binding', async rig => {
  const root = registeredRig();
  const before = readFileSync(join(root, 'project.json'));
  const result = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', rig]);
  expect(result.exit).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toStartWith('JOB_PUBLICATION_INVALID: ');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(read(root).review_job).toBeUndefined();
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(jobHostStateRoot(root))).toBe(false);
  expect(existsSync(join(root, 'review-live-v1.json'))).toBe(false);
});

test.each([
  { options: ['--rig', '1', '--draft', 'chain'] },
  { options: ['--rig', '1', '--rig', '1'] },
  { options: ['--rig'] },
])('#412 refuses ambiguous or missing rig options %j before creating a host', async ({ options }) => {
  const root = registeredRig();
  const before = readFileSync(join(root, 'project.json'));
  const result = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...options]);
  expect(result.exit).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toStartWith('rig-create: JOB_BINDING_INVALID: ');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(jobHostStateRoot(root))).toBe(false);
});

test.each(['post', 'duplicate', 'missing-package', 'missing-model'])('#412 refuses an unusable selected rig (%s) before creating a host', async problem => {
  const root = registeredRig();
  const project = read(root);
  const versions = project.versions as JsonObject[];
  if (problem === 'post') versions[0]!.kind = 'post';
  if (problem === 'duplicate') versions.push(structuredClone(versions[0]!));
  if (problem === 'missing-package') delete versions[0]!.review_package;
  if (problem === 'missing-model') rmSync(join(root, 'derived/review/v1/out/check/build/skeleton.model.json'));
  writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  const before = readFileSync(join(root, 'project.json'));
  const result = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', '1']);
  expect(result.exit).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toStartWith('JOB_PUBLICATION_INVALID: ');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(jobHostStateRoot(root))).toBe(false);
  expect(existsSync(join(root, 'review-live-v1.json'))).toBe(false);
});

test.each([
  { change: 'missing', preInterview: false },
  { change: 'changed', preInterview: false },
  { change: 'changed', preInterview: true },
])('#412 P1 rejects a non-model package file %j before host startup', async ({ change, preInterview }) => {
  const root = registeredRig();
  const atlas = join(root, 'derived/review/v1/out/check/build/skeleton.atlas');
  if (change === 'missing') rmSync(atlas);
  else writeFileSync(atlas, `${readFileSync(atlas, 'utf8')}\nchanged synthetic atlas\n`);
  if (preInterview) {
    const project = read(root);
    (project.versions as JsonObject[])[0]!.pre_interview = true;
    writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  }
  const before = readFileSync(join(root, 'project.json'));
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', root,
    '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', '1'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  opened.push({ proc, root });
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(first.done).toBe(true);
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toStartWith('REVIEW_PACKAGE_CHANGED: ');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(read(root).review_job).toBeUndefined();
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(jobHostStateRoot(root))).toBe(false);
  expect(existsSync(jobPrivateRoot(root))).toBe(false);
  expect(existsSync(join(root, 'review-live-v1.json'))).toBe(false);
});

test('job open publishes the recorded draft, asks its subjects, and the page acts are ingested by the CLI', async () => {
  const root = await partsReview(false);
  const opening = await open(root);
  expect(opening.lines[0]).toContain('WARN DIFF_MAP_MISSING:');
  expect(opening.lines.slice(1)).toEqual([publishedLine('draft chain published', root)]);
  expect(opening.lines.at(-1)).toBe(publishedLine('draft chain published', root));
  const missing = await page(root, opening.url, 0);
  expect(missing.asks.map(ask => ask.subject)).toEqual([]);
  expect(pendingPublications(root)).toEqual([]);
  const firstMap = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
  expect({ exit: firstMap.exit, stderr: firstMap.stderr }).toEqual({ exit: 0, stderr: '' });
  const initialReady = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(initialReady.exit).toBe(0);
  expect(initialReady.stdout.trim().split('\n').slice(1)).toEqual([
    publishedLine('draft chain published', root),
  ]);
  // A re-open while the host runs shows the same publication and asks nothing.
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n')).toEqual([opening.url.href, publishedLine('draft chain already published', root)]);
  // Producer report drift invalidates approval even when project.json and its selector are unchanged.
  const oldReport = readFileSync(join(root, 'evidence/diff-components.json'));
  const beforeDrift = readFileSync(join(root, 'project.json'));
  writeFileSync(join(root, 'evidence/diff-components.json'), 'synthetic invalid producer report');
  const invalid = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(invalid.exit).toBe(0);
  expect(invalid.stdout).toContain('WARN DIFF_MAP_REPORT:');
  expect(invalid.stdout).not.toContain('signoff parts-review');
  expect(invalid.stdout.trim().split('\n').at(-1)).toBe(publishedLine('draft chain already published', root));
  const inspection = await page(root, opening.url, 0);
  expect(inspection.asks.map(ask => ask.subject)).toEqual([]);
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeDrift);
  expect(pendingPublications(root)).toEqual([]);
  const invalidWrite = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
  expect(invalidWrite.exit).not.toBe(0);
  expect(invalidWrite.stderr).toContain('DIFF_MAP_REPORT:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeDrift);
  writeFileSync(join(root, 'evidence/diff-components.json'), oldReport);
  const repaired = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
  expect(repaired.exit).toBe(0);

  // A synthetic producer rebuild changes the stack before the public draft writer records it.
  cpSync(join(root, 'derived/drafts/chain'), join(root, 'derived/drafts/next'), { recursive: true });
  const stack = join(root, 'derived/drafts/next/input/recomposite_rig.png');
  writeFileSync(stack, Buffer.concat([readFileSync(stack), Buffer.from('\n')]));
  const replacementReport = JSON.parse(readFileSync(join(root, 'evidence/diff-components.json'), 'utf8')) as JsonObject;
  (replacementReport.stack as JsonObject).sha256 = jobHash(readFileSync(stack));
  writeFileSync(join(root, 'evidence/next-diff-components.json'), `${JSON.stringify(replacementReport, null, 2)}\n`);
  const replacement = seedRetainedDraft(['next', root, '--config', 'derived/drafts/next/config.json',
    '--from', 'derived/drafts/next/out', '--parts', 'derived/drafts/next/input']);
  expect(replacement.exit).toBe(0);
  const replacementIntent = prepareDraftIntent(root, readFileSync(join(root, 'project.json')), 'next');
  expect(replacementIntent.intent).toBeNull();
  expect(replacementIntent.deferred).toContain('open page not updated: structure snapshot missing or invalid');
  expect(replacementIntent.deferred).toContain('DIFF_MAP_STACK_MISMATCH');
  expect(replacementIntent.deferred).not.toContain('job: asked');
  expect((read(root).drafts as JsonObject[]).at(-1)!.id).toBe('next');
  expect(pendingPublications(root)).toEqual([]);
  const unready = await page(root, opening.url, 0);
  expect(unready.head.publicationId).toBe(inspection.head.publicationId);
  expect(unready.asks.map(ask => ask.subject)).toEqual([]);
  expect(readAcknowledgedPublication(root, readWriterBinding(root)!.jobId, String(unready.head.publicationId))!.subjects)
    .toEqual([]);
  const unreadyOpen = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(unreadyOpen.exit).toBe(0);
  expect(unreadyOpen.stdout).toContain('WARN DIFF_MAP_STACK_MISMATCH:');
  expect(unreadyOpen.stdout).not.toContain('asked parts-verdict next');
  expect(unreadyOpen.stdout).not.toContain('signoff parts-review');
  expect(unreadyOpen.stdout.trim().split('\n').at(-1)).toBe(publishedLine('draft next published', root));
  expect((await cli(root, ['structure-snapshot', root, '--draft', 'next', '--out', 'evidence/structure-next.json'])).exit).toBe(0);
  const mapped = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/next-diff-components.json', '--by', 'agent']);
  expect({ exit: mapped.exit, stderr: mapped.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(pendingPublications(root)).toEqual([]);
  const ready = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: ready.exit, stderr: ready.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(ready.stdout.trim().split('\n').slice(1)).toEqual([
    publishedLine('draft next published', root),
  ]);
  const readyAgain = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(readyAgain.exit).toBe(0);
  expect(readyAgain.stdout).toContain('draft next already published');
  const person = await page(root, opening.url, 0);
  expect((person.head.source as JsonObject).selector).toEqual({ kind: 'draft', id: 'next' });
  expect(person.asks).toEqual([]);
  const commentAct = await person.comment(WORDS);

  const retired = await cli(root, ['parts-review', root, '--from-review', String(commentAct.actId), '--json']);
  expect(retired.exit).toBe(2);
  expect(retired.stderr).toContain('NUMBERED_WRITER_REMOVED:');

  const ingested = await cli(root, ['comment', '--from-review', String(commentAct.actId), root, '--json']);
  expect({ exit: ingested.exit, stderr: ingested.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(JSON.parse(ingested.stdout)).toMatchObject({ comment: 'comments[0]' });
  expect((read(root).comments as JsonObject[]).at(-1)).toMatchObject({ by: 'user', comments: [{ text: WORDS }] });
  const report = JSON.parse((await cli(root, ['interview', '--check', root, '--json'])).stdout);
  expect(report.refusals.map((finding: JsonObject) => finding.code)).toEqual([]);
  expect(report.holes ?? []).toEqual([]);

  // The comment write changed the record, so a re-open publishes the draft again without asks.
  const after = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: after.exit, stderr: after.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(after.stdout.trim().split('\n').slice(1)).toEqual([publishedLine('draft next published', root)]);
}, 45_000);

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

test('a parts-review job open --draft publishes view-only without requiring a structure snapshot', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-snapshot-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), root, { recursive: true });
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expect((await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'])).exit).toBe(0);
  expect((await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'])).exit).toBe(0);

  const opening = await open(root, ['--draft', 'chain']);
  expect(opening.lines).toEqual([publishedLine('draft chain published', root)]);
  const view = await publication(root, opening.url, 0);
  expect(view.asks).toEqual([]);
  expect(latestReceipt(root).subjects).toEqual([]);

  const snap = await cli(root, ['structure-snapshot', root, '--draft', 'chain']);
  expect({ exit: snap.exit, stderr: snap.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(existsSync(join(root, 'evidence/structure-chain.json'))).toBe(true);
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--draft', 'chain']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n').slice(1)).toEqual([publishedLine('draft chain already published', root)]);
}, 20_000);

function registeredPost(advance = true): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-post-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/4-direction-post'), root, { recursive: true });
  mkdirSync(join(root, 'inputs'), { recursive: true });
  for (const path of ['inputs/background.png', 'evidence/scene-citations.json', 'evidence/direction-input.json']) {
    cpSync(join(import.meta.dir, '../templates/example-chain', path), join(root, path));
  }
  inputCommand(['add', 'inputs/background.png', root, '--origin', 'synthetic plate'], EXAMPLE_NOW);
  seedRetainedScene(['write', '--rig', '1', '--background', 'inputs/background.png', '--citations-file', 'evidence/scene-citations.json', root], EXAMPLE_NOW);
  seedRetainedDirectionPost(['write', '2', root, '--file', 'evidence/direction-input.json', '--rig', '1'], EXAMPLE_NOW);
  if (advance) advanceCommand(['direction-review', root], EXAMPLE_NOW);
  return root;
}

test.each(['rig', 'post'] as const)('current project publishes retained %s for viewing and comments without asks', async kind => {
  const root = kind === 'rig' ? registeredRig() : registeredPost(false);
  const file = join(root, 'project.json');
  writeFileSync(file, `${JSON.stringify({ ...read(root), current: {} }, null, 2)}\n`);
  const version = kind === 'rig' ? 1 : 2;
  const opening = await open(root, ['--rig', String(version)]);
  expect(opening.lines).toEqual([publishedLine(`${kind} v${version} published`, root)]);
  expect(latestReceipt(root).subjects).toEqual([]);
  const person = await page(root, opening.url, 0);
  expect(person.asks).toEqual([]);
  expect(await person.inspect()).toMatchObject({ capabilities: { playback: true, preRig: false } });
  expect(await person.comment(WORDS)).toMatchObject({ kind: 'comments', publicationId: person.head.publicationId,
    source: { selector: { kind, version } }, value: { comments: [{ text: WORDS }] } });
  const before = readFileSync(file);
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(again).toEqual({ exit: 0, stderr: '', stdout: `${opening.url.href}\n${publishedLine(`${kind} v${version} already published`, root)}\n` });
  expect(latestReceipt(root).publicationId).toBe(person.head.publicationId as string);
  expect(readFileSync(file)).toEqual(before);
  if (kind === 'post') {
    const receipt = latestReceipt(root);
    const writer = seedRetainedDirectionPost(['write', '3', root, '--file', 'evidence/direction-input.json', '--rig', '1'], EXAMPLE_NOW);
    expect(writer).toMatchObject({ exit: 0 });
    expect(writer.stdout).toContain('direction: v3 committed without publishing');
    expect((read(root).versions as JsonObject[]).at(-1)).toMatchObject({ n: 3, kind: 'post', rig_version: 1 });
    expect(latestReceipt(root)).toEqual(receipt);
    const after = await publication(root, opening.url, 0);
    expect(after.head.publicationId).toBe(person.head.publicationId);
    expect(after.asks).toEqual([]);
    expect(pendingPublications(root)).toEqual([]);
  }
}, 30_000);

test('current numbered open and old outbox replay keep immutable verdict subjects without reissuing an ask', async () => {
  const root = registeredRig('rig-review', project => { project.current = {}; });
  const subjects = [{ kind: 'review-verdict', stage: 'rig-review' }] as const;
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, EXAMPLE_NOW, options => startJobHost({
    ...options, readPublished: async input => ({ ...await readPublished(input), subjects }),
  }));
  try {
    const binding = readWriterBinding(root)!;
    const result = { path: prepareLiveManifest(root, read(root), 1), selector: { kind: 'rig' as const, version: 1 } };
    const entry = enqueuePublication(root, binding, result);
    entry.generation = host.session.status().generation;
    failPublication(root, entry, null);
    const attempt = jobHash(JSON.stringify([entry.id, entry.recordHash]));
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
      method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schema: binding.identity.apiSchema, verb: 'publish', jobId: binding.jobId,
        requestId: attempt, idempotencyKey: attempt, expectedGeneration: entry.generation, result,
        freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } } }),
    }));
    const reply = await response.json() as { ok: boolean; error?: unknown; value: { publicationId: string; generation: number } };
    expect(reply.error).toBeUndefined();
    expect(reply.ok).toBe(true);
    const { publicationId, generation } = reply.value;
    acknowledgePublication(entry, publicationId, generation, attempt, subjects);
    const prior = latestReceipt(root);
    const before = readFileSync(join(root, 'project.json'));
    expect(await openDraftPublication(root, host, EXAMPLE_NOW)).toEqual([publishedLine('rig v1 already published', root)]);
    expect(host.session.status().pending).toEqual([]);
    expect(await reconcileCreateJob(root)).toBe(1);
    expect(host.session.status()).toMatchObject({ generation, publication: { publicationId }, pending: [] });
    expect(latestReceipt(root)).toEqual(prior);
    expect(pendingPublications(root)).toEqual([]);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  } finally { host.stop(); }
}, 20_000);

test.each(['signoff', 'checkpoint', 'both'] as const)('#467 replaces an unchanged persisted legacy post head carrying %s asks', async extra => {
  const root = registeredPost();
  const subjects: import('@rig-c/review/job-host').JobSubject[] = [
    { kind: 'review-verdict', stage: 'direction-review' },
    ...(extra !== 'checkpoint' ? [{ kind: 'signoff' as const, stage: 'direction-review' }] : []),
    ...(extra !== 'signoff' ? [{ kind: 'checkpoint' as const, checkpointId: 'camera' }] : []),
  ];
  // Seed an authentic persisted package head through the public producer reader
  // and host API. Only the old declared subjects differ; no act is invented.
  const legacy = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now(), options => startJobHost({
    ...options, readPublished: async input => ({ ...await readPublished(input), subjects }),
  }));
  let previousId: string;
  const saved = readFileSync(join(root, 'project.json'));
  try {
    const binding = readWriterBinding(root)!;
    const result = { path: prepareLiveManifest(root, read(root), 2), selector: { kind: 'post' as const, version: 2, rigVersion: 1 } };
    const entry = enqueuePublication(root, binding, result);
    const requestId = randomUUID();
    const response = await legacy.ports.handleJobApi(new Request(`${legacy.origin}/jobs/${legacy.session.jobId}/api`, {
      method: 'POST', headers: { authorization: `Bearer ${legacy.session.hostCredentials().agent}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schema: binding.identity.apiSchema, verb: 'publish', jobId: legacy.session.jobId,
        requestId, idempotencyKey: requestId, expectedGeneration: legacy.session.status().generation, result,
        freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: jobHash(saved) } } }),
    }));
    const reply = await response.json() as { ok: boolean; error?: unknown; value: { publicationId: string; generation: number } };
    expect(reply.error).toBeUndefined();
    expect(reply.ok).toBe(true);
    previousId = reply.value.publicationId;
    acknowledgePublication(entry, previousId, reply.value.generation, requestId, subjects);
    for (const subject of subjects) {
      seedHistoricalPendingAsk(legacy, previousId, subject);
    }
    expect(legacy.session.status().pending.map(ask => ask.subject)).toEqual(expect.arrayContaining(subjects));
    expect(legacy.session.status().pending).toHaveLength(subjects.length);
    expect(readAcknowledgedPublication(root, binding.jobId, previousId)!.subjects).toEqual(subjects);
    expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  } finally { legacy.stop(); }

  const reopened = await open(root, ['--rig', '2']);
  expect(reopened.lines).toEqual([publishedLine('post v2 published', root)]);
  const current = await publication(root, reopened.url, 0);
  expect(current.head.publicationId).not.toBe(previousId!);
  expect(current.asks).toEqual([]);
  expect((current.head.source as JsonObject).projectHash).toBe(jobHash(saved));
  expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  expect(pendingPublications(root)).toEqual([]);
}, 20_000);

test.each([false, true])('a numbered post page opens without asks and reopens idempotently (advanced=%s)', async advanced => {
  const root = registeredPost(advanced);
  const opening = await open(root, ['--rig', '2']);
  expect(opening.lines).toEqual([publishedLine('post v2 published', root)]);
  const current = await publication(root, opening.url, 0);
  expect((current.head.source as JsonObject).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  expect(current.asks).toEqual([]);
  const refreshedId = latestReceipt(root).publicationId;
  const saved = readFileSync(join(root, 'project.json'));
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', '2']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n').slice(1)).toEqual([`job: post v2 already published (publication ${refreshedId})`]);
  expect((await publication(root, opening.url, 0)).head.publicationId).toBe(current.head.publicationId);
  expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  expect(pendingPublications(root)).toEqual([]);
}, 20_000);

test('a binding copied from another root is replaced: the copy opens its own job and never attaches the original host', async () => {
  const original = await partsReview();
  const first = await open(original);
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-copy-')));
  roots.push(copy);
  rmSync(copy, { recursive: true });
  cpSync(original, copy, { recursive: true });
  expect(readWriterBinding(copy)!.identity.root).toBe(original);
  const copied = await open(copy);
  expect(copied.lines).toEqual([publishedLine('draft chain published', copy)]);
  const binding = readWriterBinding(copy)!;
  expect(binding.identity.root).toBe(copy);
  expect(binding.identity.stateDir).toBe(join(jobHostStateRoot(copy), 'host'));
  expect(copied.url.origin === first.url.origin).toBe(false);
  expect((read(copy).review_job as JsonObject).jobId).toBe(binding.jobId);
  // The original job still has its own view-only publication with no asks.
  const person = await page(original, first.url, 0);
  expect(person.asks).toHaveLength(0);
  expect((read(original).review_job as JsonObject).origin).toBe(first.url.origin);
}, 20_000);

test('publish and reopen send no ask or ask-batch requests and never emit JOB_ASK_REFUSED or JOB_ASK_INVALID', async () => {
  const root = await partsReview();
  const verbs: string[] = [];
  const wrapHost = async (options: Parameters<typeof startJobHost>[0]) => {
    const started = await startJobHost(options);
    const origHandle = started.ports.handleJobApi.bind(started.ports);
    return {
      ...started,
      ports: {
        ...started.ports,
        handleJobApi: async (request: Request) => {
          const body = await request.clone().json() as { verb?: string };
          verbs.push(String(body.verb ?? ''));
          return origHandle(request);
        },
      },
    };
  };
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now(), wrapHost, true);
  try {
    const binding = readWriterBinding(root)!;
    const draftEntry = enqueuePublication(root, binding, draftPublicationResult('chain'));
    await reconcileCreateJob(root, item => publishPending(item, undefined, undefined, opts => wrapHost(opts)));
    const draftPubId = host.session.status().publication!.publicationId;
    expect(readAcknowledgedPublication(root, binding.jobId, draftPubId)?.subjects).toEqual([]);
    expect(host.session.status().pending).toEqual([]);
    expect(verbs.every(verb => verb === 'next' || verb === 'progress' || verb === 'publish')).toBe(true);
    expect(verbs).toContain('publish');

    verbs.length = 0;
    const draftReopen = await openDraftPublication(root, host, Date.now());
    expect(draftReopen).toEqual([`job: draft chain already published (publication ${draftPubId})`]);
    expect(verbs).toEqual([]);
    expect(draftEntry.id).toBeTruthy();

    verbs.length = 0;
    const planEntry = enqueuePublication(root, binding, { kind: 'plan' });
    await reconcileCreateJob(root, item => publishPending(item, undefined, undefined, opts => wrapHost(opts)));
    const planPubId = host.session.status().publication!.publicationId;
    expect(planEntry.id).toBeTruthy();
    expect(host.session.status().pending).toEqual([]);
    expect(verbs.every(verb => verb === 'next' || verb === 'progress' || verb === 'publish')).toBe(true);
    expect(verbs).toContain('publish');

    verbs.length = 0;
    const planLines = await openRecordPublication(root, host, undefined, true, Date.now());
    expect(planLines).toEqual([`job: plan already published (publication ${planPubId})`]);
    expect(verbs).toEqual([]);
  } finally { host.stop(); }
}, 20_000);

test('unready parts-review draft context warns by name and leaves the public map repair writer usable', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-diffmap-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), root, { recursive: true });
  expect((await cli(root, ['structure-snapshot', root, '--draft', 'chain', '--out', 'evidence/structure-chain.json'])).exit).toBe(0);
  const advanced = await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']);
  expect(advanced.exit).toBe(0);
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now());
  const before = readFileSync(join(root, 'project.json'));
  try {
    const warnings: import('../src/check.ts').Finding[] = [];
    expect(draftPublicationContext(root, read(root), 'chain', warnings).subjects).toEqual([]);
    expect(warnings.map(finding => finding.code)).toEqual(['DIFF_MAP_MISSING']);
    expect(host.session.status().publication).toBeNull();
    expect(host.session.status().pending).toEqual([]);
    expect(pendingPublications(root)).toEqual([]);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    const triaged = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
    expect(triaged.exit).toBe(0);
    expect(draftPublicationContext(root, read(root), 'chain').subjects).toEqual([]);
    expect(pendingPublications(root)).toEqual([]);
  } finally { host.stop(); }
});
