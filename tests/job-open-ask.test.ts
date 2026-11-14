/**
 * `job open` publishes the record's current draft and asks its declared subjects (#352).
 * The cycle tests go through the shipped CLI: no in-process host and no agent credential.
 * The person is the owner page, so its acts go over the host's HTTP UI routes.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startJobHost, type JobSelector } from '@rig-c/review/job-host';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { inputCommand } from '../src/inputs.ts';
import { askDeclaredSubjects, openCreateJob, openDraftPublication, publishPending, reconcileCreateJob, refuseAskOutcomes } from '../src/job-host.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readAcknowledgedPublication, readWriterBinding, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { draftPublicationContext, prepareLiveManifest, readPublished } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { hostPortRefuses } from '../src/job-host-state.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { sceneCommand } from '../src/scene-writers.ts';
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
  expect(second.lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain']);
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
  expect((await open(root)).lines[0]).toBe('job: draft chain published');
}, 20_000);

const WORDS = '  Synthetic page words.\n';
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));

function registeredRig(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-rig-selector-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), root, { recursive: true });
  const project = read(root);
  project.stage = 'rigging';
  const meshes = ((project.plan as JsonObject).steps as JsonObject[]).find(step => step.id === 'meshes')!;
  (meshes.checkpoint as JsonObject).value = true;
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
  const advanced = await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']);
  expect(advanced.exit).toBe(0);
  if (prepareMap) {
    const triaged = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
    expect(triaged.exit).toBe(0);
  }
  return root;
}

/** Start `job open` in the background and read its URL line and the summary it prints after publishing. */
async function open(root: string, options: string[] = []): Promise<{ url: URL; lines: string[] }> {
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
  expect(selected.lines).toEqual(['job: rig v1 published', 'job: asked review-verdict rig-review, checkpoint meshes']);
  const first = await publication(root, selected.url);
  expect((first.head.source as JsonObject).selector).toEqual({ kind: 'rig', version: 1 });
  expect(first.asks.map(ask => ask.subject)).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
    { kind: 'checkpoint', checkpointId: 'meshes' },
  ]);
  const saved = readFileSync(join(root, 'project.json'));
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', 'v1']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n')).toEqual([
    selected.url.href, 'job: rig v1 already published', 'job: already asked review-verdict rig-review, checkpoint meshes',
  ]);
  const repeated = await publication(root, selected.url);
  expect(repeated.head.publicationId).toBe(first.head.publicationId);
  expect(repeated.asks.map(ask => ask.askId)).toEqual(first.asks.map(ask => ask.askId));
  expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  expect(read(root).stage).toBe(before.stage);
  expect(read(root).versions).toEqual(before.versions);
  expect(read(root).signoffs).toEqual(before.signoffs);
  expect(read(root).plan).toEqual(before.plan);
  expect(pendingPublications(root)).toEqual([]);
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
  expect(opening.lines.slice(1)).toEqual(['job: draft chain published', 'job: asked parts-verdict chain']);
  expect(opening.lines.at(-1)).toBe('job: asked parts-verdict chain');
  const missing = await page(root, opening.url, 1);
  expect(missing.asks.map(ask => ask.subject)).toEqual([{ kind: 'parts-verdict', draftId: 'chain' }]);
  expect(pendingPublications(root)).toEqual([]);
  const firstMap = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
  expect({ exit: firstMap.exit, stderr: firstMap.stderr }).toEqual({ exit: 0, stderr: '' });
  const initialReady = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(initialReady.exit).toBe(0);
  expect(initialReady.stdout.trim().split('\n').slice(1)).toEqual([
    'job: draft chain published', 'job: asked parts-verdict chain, signoff parts-review',
  ]);
  // A re-open while the host runs shows the same publication and asks nothing twice.
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n')).toEqual([opening.url.href, 'job: draft chain already published', 'job: already asked parts-verdict chain, signoff parts-review']);
  // Producer report drift invalidates approval even when project.json and its selector are unchanged.
  const oldReport = readFileSync(join(root, 'evidence/diff-components.json'));
  const beforeDrift = readFileSync(join(root, 'project.json'));
  writeFileSync(join(root, 'evidence/diff-components.json'), 'synthetic invalid producer report');
  const invalid = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(invalid.exit).toBe(0);
  expect(invalid.stdout).toContain('WARN DIFF_MAP_REPORT:');
  expect(invalid.stdout).not.toContain('signoff parts-review');
  expect(invalid.stdout.trim().split('\n').at(-1)).toBe('job: asked parts-verdict chain');
  expect((await page(root, opening.url, 1)).asks.map(ask => ask.subject)).toEqual([{ kind: 'parts-verdict', draftId: 'chain' }]);
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
  const replacement = await cli(root, ['draft-rig', 'next', root, '--config', 'derived/drafts/next/config.json',
    '--from', 'derived/drafts/next/out', '--parts', 'derived/drafts/next/input']);
  expect({ exit: replacement.exit, stderr: replacement.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(replacement.stdout).toContain('WARN DIFF_MAP_STACK_MISMATCH:');
  expect(replacement.stdout.trim().split('\n').at(-1)).toBe('job: asked parts-verdict next');
  expect((read(root).drafts as JsonObject[]).at(-1)!.id).toBe('next');
  expect(pendingPublications(root)).toEqual([]);
  const unready = await page(root, opening.url, 1);
  expect(unready.asks.map(ask => ask.subject)).toEqual([{ kind: 'parts-verdict', draftId: 'next' }]);
  expect(readAcknowledgedPublication(root, readWriterBinding(root)!.jobId, String(unready.head.publicationId))!.subjects)
    .toEqual([{ kind: 'parts-verdict', draftId: 'next' }]);
  const unreadyOpen = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(unreadyOpen.exit).toBe(0);
  expect(unreadyOpen.stdout).toContain('WARN DIFF_MAP_STACK_MISMATCH:');
  expect(unreadyOpen.stdout).toContain('already asked parts-verdict next');
  expect(unreadyOpen.stdout).not.toContain('signoff parts-review');
  expect(unreadyOpen.stdout.trim().split('\n').at(-1)).toBe('job: already asked parts-verdict next');
  const mapped = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/next-diff-components.json', '--by', 'agent']);
  expect({ exit: mapped.exit, stderr: mapped.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(pendingPublications(root)).toEqual([]);
  const ready = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: ready.exit, stderr: ready.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(ready.stdout.trim().split('\n').slice(1)).toEqual([
    'job: draft next published', 'job: asked parts-verdict next, signoff parts-review',
  ]);
  const readyAgain = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(readyAgain.exit).toBe(0);
  expect(readyAgain.stdout).toContain('already asked parts-verdict next, signoff parts-review');
  const person = await page(root, opening.url);
  expect((person.head.source as JsonObject).selector).toEqual({ kind: 'draft', id: 'next' });
  expect(person.asks.map(ask => ask.subject)).toEqual([{ kind: 'parts-verdict', draftId: 'next' }, { kind: 'signoff', stage: 'parts-review' }]);
  const verdict = await person.act('parts-verdict', 'parts-verdict', { verdict: 'approved', issues: [], words: WORDS });
  const signed = await person.act('signoff', 'signoff', { stage: 'parts-review', decision: 'approved', words: WORDS });

  const ingested = await cli(root, ['parts-review', root, '--from-review', String(verdict.actId), '--json']);
  expect({ exit: ingested.exit, stderr: ingested.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(JSON.parse(ingested.stdout)).toMatchObject({ draft_id: 'next', verdict: 'approved', by: 'user', verbatim: `[general]\n${WORDS}` });
  expect((await cli(root, ['structure-snapshot', root, '--draft', 'next', '--out', 'evidence/structure.json'])).exit).toBe(0);
  const signoff = await cli(root, ['signoff', 'parts-review', root, '--from-review', String(signed.actId), '--draft', 'next',
    '--structure-file', 'evidence/structure.json', '--json']);
  expect({ exit: signoff.exit, stderr: signoff.stderr }).toEqual({ exit: 0, stderr: '' });
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({ stage: 'parts-review', checkpoint: null, by: 'user', verbatim: `[general]\n${WORDS}`,
    source: `review act ${String(signed.jobId)}/${String(signed.actId)}` });
  // The signature authorizes the next stage; the separate advance writer records the move.
  const report = JSON.parse((await cli(root, ['interview', '--check', root, '--json'])).stdout);
  expect(report.refusals.map((finding: JsonObject) => finding.code)).toEqual(['STAGE_LAGGING']);
  expect(report.holes ?? []).toEqual([]);

  // The writes changed the record, so a re-open publishes the draft again. Both the verdict and the stage are recorded, so nothing is asked.
  const after = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: after.exit, stderr: after.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(after.stdout.trim().split('\n').slice(1)).toEqual(['job: draft next published']);
}, 20_000);

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

test('job open retries a refused ask on an acknowledged rig head without overwriting it with a draft or duplicating pending or answered asks', async () => {
  const kind = 'rig';
  const root = realpathSync(mkdtempSync(join(tmpdir(), `create-job-open-${kind}-`)));
  roots.push(root);
  const stage = 'rig-review';
  const version = 1;
  const selector: JobSelector = { kind: 'rig', version: 1 };
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), root, { recursive: true });
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
  const person = await page(root, opening.url);
  expect((person.head.source as { selector: unknown }).selector).toEqual(selector);
  expect(person.asks.map(ask => ask.subject)).toEqual([{ kind: 'review-verdict', stage }, { kind: 'signoff', stage }]);
  await person.act('signoff', 'signoff', { stage, decision: 'approved', words: WORDS });

  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n')).toEqual([opening.url.href, `job: ${kind} v${version} already published`, `job: already asked review-verdict ${stage}, signoff ${stage}`]);
  expect((await page(root, opening.url)).asks).toHaveLength(2);
});

function registeredPost(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-post-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/4-direction-post'), root, { recursive: true });
  mkdirSync(join(root, 'inputs'), { recursive: true });
  for (const path of ['inputs/background.png', 'evidence/scene-citations.json', 'evidence/direction-input.json']) {
    cpSync(join(import.meta.dir, '../templates/example-chain', path), join(root, path));
  }
  inputCommand(['add', 'inputs/background.png', root, '--origin', 'synthetic plate'], EXAMPLE_NOW);
  sceneCommand(['write', '--rig', '1', '--background', 'inputs/background.png', '--citations-file', 'evidence/scene-citations.json', root], EXAMPLE_NOW);
  directionCommand(['write', '2', root, '--file', 'evidence/direction-input.json', '--rig', '1'], EXAMPLE_NOW);
  advanceCommand(['direction-review', root], EXAMPLE_NOW);
  return root;
}

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
    expect((await askDeclaredSubjects(legacy, previousId, subjects)).map(outcome => outcome.status)).toEqual(subjects.map(() => 'asked'));
    expect(legacy.session.status().pending.map(ask => ask.subject)).toEqual(subjects);
    expect(readAcknowledgedPublication(root, binding.jobId, previousId)!.subjects).toEqual(subjects);
    expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  } finally { legacy.stop(); }

  const reopened = await open(root, ['--rig', '2']);
  expect(reopened.lines).toEqual(['job: post v2 published', 'job: asked review-verdict direction-review']);
  const current = await publication(root, reopened.url, 1);
  expect(current.head.publicationId).not.toBe(previousId!);
  expect(current.asks.map(ask => ask.subject)).toEqual([{ kind: 'review-verdict', stage: 'direction-review' }]);
  expect((current.head.source as JsonObject).projectHash).toBe(jobHash(saved));
  expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
  expect(pendingPublications(root)).toEqual([]);
}, 20_000);

test('#467 a post page asks only the direction verdict before and after ingest, and reopens idempotently', async () => {
  const root = registeredPost();

  const before = readFileSync(join(root, 'project.json'));
  const premature = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--plan']);
  expect(premature.exit).toBe(1);
  expect(premature.stderr).toStartWith('JOB_DIRECTION_VERDICT_REQUIRED: ');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(jobHostStateRoot(root))).toBe(false);

  const opening = await open(root, ['--rig', '2']);
  expect(opening.lines).toEqual(['job: post v2 published', 'job: asked review-verdict direction-review']);
  const first = await page(root, opening.url, 1);
  expect((first.head.source as JsonObject).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  expect(first.asks.map(ask => ask.subject)).toEqual([{ kind: 'review-verdict', stage: 'direction-review' }]);
  const verdict = await first.act('review-verdict', 'review-verdict', { stage: 'direction-review', verdict: 'approved', words: WORDS });
  const reviewed = await cli(root, ['review', '2', root, '--from-review', String(verdict.actId)]);
  expect({ exit: reviewed.exit, stderr: reviewed.stderr }).toEqual({ exit: 0, stderr: '' });

  const refreshed = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', 'v2']);
  expect({ exit: refreshed.exit, stderr: refreshed.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(refreshed.stdout.trim().split('\n').slice(1)).toEqual(['job: post v2 published']);
  const current = await publication(root, opening.url, 0);
  expect(current.head.publicationId).not.toBe(first.head.publicationId);
  expect(current.asks.map(ask => ask.subject)).toEqual([]);
  const saved = readFileSync(join(root, 'project.json'));
  const again = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', '2']);
  expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(again.stdout.trim().split('\n').slice(1)).toEqual(['job: post v2 already published']);
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
  expect(copied.lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain, signoff parts-review']);
  const binding = readWriterBinding(copy)!;
  expect(binding.identity.root).toBe(copy);
  expect(binding.identity.stateDir).toBe(join(jobHostStateRoot(copy), 'host'));
  expect(copied.url.origin === first.url.origin).toBe(false);
  expect((read(copy).review_job as JsonObject).jobId).toBe(binding.jobId);
  // The original job still has exactly its own publication and asks.
  const person = await page(original, first.url);
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

test('unready parts-review draft context warns by name and leaves the public map repair writer usable', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-diffmap-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), root, { recursive: true });
  const advanced = await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']);
  expect(advanced.exit).toBe(0);
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now());
  const before = readFileSync(join(root, 'project.json'));
  try {
    const warnings: import('../src/check.ts').Finding[] = [];
    expect(draftPublicationContext(root, read(root), 'chain', warnings).subjects).toEqual([
      { kind: 'parts-verdict', draftId: 'chain' },
    ]);
    expect(warnings.map(finding => finding.code)).toEqual(['DIFF_MAP_MISSING']);
    expect(host.session.status().publication).toBeNull();
    expect(host.session.status().pending).toEqual([]);
    expect(pendingPublications(root)).toEqual([]);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    const triaged = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
    expect(triaged.exit).toBe(0);
    expect(draftPublicationContext(root, read(root), 'chain').subjects).toEqual([
      { kind: 'parts-verdict', draftId: 'chain' }, { kind: 'signoff', stage: 'parts-review' },
    ]);
    expect(pendingPublications(root)).toEqual([]);
  } finally { host.stop(); }
});
