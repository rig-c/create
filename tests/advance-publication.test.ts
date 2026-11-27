import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputRoot, outputSetHash, sha256, treeFiles } from '../src/current.ts';
import { commitAdvance } from '../src/job-advance.ts';
import { jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';
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
async function open(root: string, args: string[] = []): Promise<{ url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...args], {
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
async function page(url: URL, expectedAsks = 1) {
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
  while (Date.now() < deadline && (pending().head === undefined || pending().asks.length < expectedAsks)) {
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
  return { head: head!, asks, events };
}

test('advances into other stages on a bound job and advances without a bound job do not publish or touch the outbox', async () => {
  const boundRoot = copy('1-parts-verdict');
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(boundRoot, 'evidence/diff-components.json'));
  const opening = await open(boundRoot);

  const ackDir = join(jobPrivateRoot(boundRoot), 'acknowledged-publications');
  const receiptsBefore = readdirSync(ackDir).sort();
  const beforePage = await page(opening.url, 0);
  const headBefore = beforePage.head.publicationId;
  expect(opening.lines).toEqual([`job: draft chain published (publication ${headBefore})`]);
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

  const afterPage = await page(opening.url, 0);
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
}, 30_000);

test.each([
  { checkpoint: '3-rig-review', from: 'rigging', stage: 'rig-review', version: '1' },
  { checkpoint: 'example-chain', from: 'post', stage: 'direction-review', version: '2' },
])('bound numbered advance to $stage commits without replacing the page or queuing publication', async ({ checkpoint, from, stage, version }) => {
  const root = copy(checkpoint, project => {
    project.stage = from;
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== stage && entry.stage !== 'accepted');
  });
  const opening = await open(root, ['--rig', version]);
  const before = await page(opening.url, 0);
  const ackDir = join(jobPrivateRoot(root), 'acknowledged-publications');
  const receipts = readdirSync(ackDir).sort();
  const advanced = await cli(root, ['advance', stage, root, '--json']);
  expect({ exit: advanced.exit, stderr: advanced.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root).stage).toBe(stage);
  const after = await page(opening.url, 0);
  expect(after.head).toEqual(before.head);
  expect(after.asks).toEqual([]);
  expect(readdirSync(ackDir).sort()).toEqual(receipts);
  expect(pendingPublications(root)).toEqual([]);
}, 30_000);

test('planted write failures on advance with an existing version keep the numbered record atomic and allocate no publication', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root, ['--rig', '1']);
  const beforePage = await page(opening.url, 0);
  const file = join(root, 'project.json');
  const preAdvanceBytes = readFileSync(file);
  const candidate = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review/project.json'), 'utf8')) as JsonObject;
  candidate.review_job = read(root).review_job!;

  // 1. Pre-rename write failure: project.json is still at rigging, with an empty outbox.
  expect(() =>
    commitAdvance(root, file, structuredClone(candidate), () => {
      throw new Error('planted pre-rename write failure');
    }),
  ).toThrow('planted pre-rename write failure');
  expect(readFileSync(file)).toEqual(preAdvanceBytes);
  expect(read(root).stage).toBe('rigging');
  expect(pendingPublications(root)).toEqual([]);

  // 2. Post-rename failure leaves the committed stage and an empty outbox.
  expect(() =>
    commitAdvance(root, file, structuredClone(candidate), (temp, target, bytes) => {
      writeFileSync(temp, bytes, { flag: 'wx' });
      renameSync(temp, target);
      throw new Error('planted post-rename failure before publish');
    }),
  ).toThrow('planted post-rename failure before publish');
  expect(read(root).stage).toBe('rig-review');
  expect(pendingPublications(root)).toEqual([]);
  expect((await page(opening.url, 0)).head).toEqual(beforePage.head);
}, 30_000);

/** A synthetic current record with its actual tree and one independently mutable input. */
function recordedOutput(root: string, kind: 'rig' | 'direction'): { output: string; input: string } {
  const tree = outputRoot(kind);
  const run = `${tree}/run.json`;
  const report = `${tree}/check/check.json`;
  const output = `${tree}/check/build/skeleton.model.json`;
  const input = 'evidence/current-build-input.txt';
  mkdirSync(join(root, tree, 'check/build'), { recursive: true });
  writeFileSync(join(root, run), '{}');
  writeFileSync(join(root, report), '{"PASS":true}');
  cpSync(join(root, 'derived/review/v1/out/check/build/skeleton.model.json'), join(root, output));
  const inputBytes = 'synthetic current build input';
  writeFileSync(join(root, input), inputBytes);
  const files = treeFiles(root, tree);
  const binding = (path: string) => ({ path, sha256: files.find(file => file.path === path)!.sha256 });
  const project = read(root);
  project.current = { [kind]: {
    at: new Date(Date.now() - 1000).toISOString(), built_by: 'agent', built_with: {},
    files, files_sha256: outputSetHash(files), run: binding(run), report: binding(report),
    built_from: [{ path: input, sha256: sha256(inputBytes) }],
    ...(kind === 'rig' ? { rebuild: { recorded: false, note: 'synthetic producer arguments' } } : {}),
  } };
  write(root, project);
  return { output, input };
}

test.each([
  ['rig', 'rig-review', 'rigging', '3-rig-review'],
  ['direction', 'direction-review', 'post', '4-direction-post'],
] as const)('bound current %s advance commits without a numbered result and keeps the existing Review page', async (kind, stage, from, checkpoint) => {
  const root = copy(checkpoint, project => {
    project.stage = from;
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== stage);
  });
  const opening = await open(root, ['--rig', '1']);
  const beforePage = await page(opening.url, 0);
  const ackDir = join(jobPrivateRoot(root), 'acknowledged-publications');
  const receiptsBefore = readdirSync(ackDir).sort();
  recordedOutput(root, kind);
  if (kind === 'rig') {
    const record = read(root);
    record.versions = [];
    write(root, record);
  }
  const file = join(root, 'project.json');
  const bytesBefore = readFileSync(file);
  const before = read(root);
  expect((before.versions as JsonObject[]).some(version => version.kind === (kind === 'rig' ? 'rig' : 'post'))).toBe(false);
  expect(() => commitAdvance(root, file, { ...before, stage }, () => {
    throw Error('planted current pre-rename failure');
  })).toThrow('planted current pre-rename failure');
  expect(readFileSync(file)).toEqual(bytesBefore);
  expect(pendingPublications(root)).toEqual([]);

  const result = await cli(root, ['advance', stage, root, '--json']);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root)).toMatchObject({ stage, current: before.current, versions: before.versions, signoffs: before.signoffs });
  expect((read(root).advances as JsonObject[]).at(-1)).toMatchObject({ stage, from_stage: from });
  expect(pendingPublications(root)).toEqual([]);
  expect(readdirSync(ackDir).sort()).toEqual(receiptsBefore);
  const afterPage = await page(opening.url, 0);
  expect(afterPage.head.publicationId).toBe(beforePage.head.publicationId);
  expect(afterPage.asks).toEqual(beforePage.asks);
}, 30_000);

test('bound current rig advance refuses missing, changed, or stale output before writing', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  await open(root, ['--rig', '1']);
  const file = join(root, 'project.json');
  const record = read(root);
  record.current = {};
  write(root, record);
  const refused = async (detail: string): Promise<void> => {
    const bytes = readFileSync(file);
    const result = await cli(root, ['advance', 'rig-review', root]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain('JOB_PUBLICATION_INVALID: current.rig:');
    expect(result.stderr).toContain(detail);
    expect(readFileSync(file)).toEqual(bytes);
    expect(pendingPublications(root)).toEqual([]);
  };
  await refused('record the current output');
  const { output, input } = recordedOutput(root, 'rig');
  const originalOutput = readFileSync(join(root, output));
  writeFileSync(join(root, output), 'modified compiled output');
  await refused('differs from the recorded files_sha256');
  writeFileSync(join(root, output), originalOutput);
  writeFileSync(join(root, input), 'modified producer input');
  await refused(input);
}, 30_000);
