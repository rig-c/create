/**
 * `job open` forwards SIGTERM/SIGINT from the CLI wrapper to its spawned runtime so the
 * host port stops without leaving an orphan listener, and bound writers surface refused ask
 * outcomes (`JOB_ASK_REFUSED`) after acknowledging the publication (#355).
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askOutcomeLines, closeCreateJob } from '../src/job-host.ts';
import { jobHostStateRoot, jobPrivateRoot, pendingPublications, readAcknowledgedPublication, readWriterBinding } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv, prepareDraftIntent } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { seedRetainedDraft } from './numbered-seed.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
const roots: string[] = [];
const opened: { proc: Bun.Subprocess; root: string; origin?: string }[] = [];

async function isOriginListening(origin: string): Promise<boolean> {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(300) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const { proc, root, origin } of opened.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
    }
    await proc.exited;
    if (readWriterBinding(root) && pendingPublications(root).length === 0) {
      try { await closeCreateJob(root); } catch { /* Already closed or unreachable. */ }
    }
    if (origin) {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && await isOriginListening(origin)) {
        await Bun.sleep(100);
      }
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
const write = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

function copyCheckpoint(checkpoint: string, edit?: (project: JsonObject) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-signal-ask-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints', checkpoint), root, { recursive: true });
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

async function open(root: string, args: string[] = []): Promise<{ proc: Bun.Subprocess; url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const entry: { proc: Bun.Subprocess; root: string; origin?: string } = { proc, root };
  opened.push(entry);
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
  const url = new URL(lines[0]!);
  entry.origin = url.origin;
  return { proc, url, lines: lines.slice(1) };
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) test(`job open CLI forwards ${signal} to its runtime and stops its own host port without leaving an orphan listener`, async () => {
  const root = copyCheckpoint('1-parts-verdict');
  const { proc, url, lines } = await open(root);
  // Parts-stage inventory is publishable, but approval waits for parts-review readiness.
  expect(lines).toEqual([`job: draft chain published (publication ${publicationId(root)})`]);
  expect(await isOriginListening(url.origin)).toBe(true);

  proc.kill(signal);
  await proc.exited;

  // Give the runtime a brief moment to complete stop() if exiting asynchronously.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && await isOriginListening(url.origin)) {
    await Bun.sleep(50);
  }
  expect(await isOriginListening(url.origin)).toBe(false);
}, 20_000);

test('bound writers print concise asked/already subject lines in text mode and preserve JSON stdout in --json mode', async () => {
  expect(askOutcomeLines([
    { subject: { kind: 'parts-verdict', draftId: 'chain-2' }, status: 'asked' },
    { subject: { kind: 'checkpoint', checkpointId: 'assemble' }, status: 'already' },
  ])).toEqual([
    'job: asked parts-verdict chain-2',
    'job: already asked checkpoint assemble',
  ]);

  // --json stdout stays one JSON document on bound writers; view-only draft preparation defers without an ask.
  const draftRoot = await preparedParts();
  const args = copyDraft(draftRoot, 'chain-2');
  const snapshot = JSON.parse(readFileSync(join(draftRoot, 'evidence/structure-chain.json'), 'utf8')) as JsonObject;
  snapshot.draft_id = 'chain-2';
  (snapshot.config as JsonObject).path = 'derived/drafts/chain-2/config.json';
  writeFileSync(join(draftRoot, 'evidence/structure-chain-2.json'), JSON.stringify(snapshot));
  await openPartsWithoutAsk(draftRoot);
  expect(seedRetainedDraft(args).exit).toBe(0);
  const intent = prepareDraftIntent(draftRoot, readFileSync(join(draftRoot, 'project.json')), 'chain-2');
  expect(intent.intent).toBeNull();
  expect(intent.deferred).toContain('no owner ask is ready');
  const diffJson = await cli(draftRoot, ['diff-classes', draftRoot, '--diff-report', 'evidence/diff-components.json', '--json']);
  expect({ exit: diffJson.exit, stderr: diffJson.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(() => JSON.parse(diffJson.stdout)).not.toThrow();
}, 30_000);

function publicationId(root: string): string {
  const binding = readWriterBinding(root)!;
  const db = new Database(join(binding.identity.stateDir, 'jobs.sqlite'), { readonly: true });
  try {
    return db.query<{ head: string }, [string]>("SELECT json_extract(document, '$.head') AS head FROM jobs WHERE job_id = ?").get(binding.jobId)!.head;
  } finally {
    db.close();
  }
}

function copyDraft(root: string, id: string): string[] {
  const base = `derived/drafts/${id}`;
  cpSync(join(root, 'derived/drafts/chain'), join(root, base), { recursive: true });
  return [id, root, '--config', `${base}/config.json`, '--from', `${base}/out`, '--parts', `${base}/input`];
}

async function preparedParts(): Promise<string> {
  const root = copyCheckpoint('1-parts-verdict');
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expect(await cli(root, ['structure-snapshot', root, '--draft', 'chain', '--out', 'evidence/structure-chain.json'])).toMatchObject({ exit: 0 });
  expect(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'])).toMatchObject({ exit: 0 });
  expect(await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'])).toMatchObject({ exit: 0 });
  return root;
}

async function openPartsWithoutAsk(root: string): Promise<string> {
  const path = join(root, 'evidence/structure-chain.json');
  const snapshot = readFileSync(path);
  // The default open can publish an inspection page while the active draft lacks its snapshot.
  rmSync(path);
  try {
    const opening = await open(root);
    const head = publicationId(root);
    expect(opening.lines.at(-1)).toBe(`job: draft chain published (publication ${head})`);
    const binding = readWriterBinding(root)!;
    expect(readAcknowledgedPublication(root, binding.jobId, head)?.subjects).toEqual([]);
    return head;
  } finally {
    writeFileSync(path, snapshot);
  }
}

function seedHistoricalPendingDraftAsk(root: string, publicationId: string, draftId = 'chain'): void {
  const binding = readWriterBinding(root)!;
  const db = new Database(join(binding.identity.stateDir, 'jobs.sqlite'));
  db.exec('PRAGMA busy_timeout = 5000;');
  try {
    const row = db.query<{ revision: number; document: string }, [string]>('SELECT revision, document FROM jobs WHERE job_id = ?').get(binding.jobId)!;
    const doc = JSON.parse(row.document) as {
      generation: number;
      publications: Record<string, { retained: { source: unknown; subjects: unknown[] } }>;
      asks: Record<string, unknown>;
      events: unknown[];
    };
    const subject = { kind: 'parts-verdict', draftId };
    doc.publications[publicationId]!.retained.subjects = [subject];
    doc.generation++;
    const askId = `legacy-ask-${draftId}`;
    const ask = { askId, publicationId, subject, source: doc.publications[publicationId]!.retained.source, status: 'pending' };
    doc.asks[askId] = ask;
    doc.events.push({ type: 'pending', ask, cursor: crypto.randomUUID(), jobId: binding.jobId, generation: doc.generation });
    db.query('UPDATE jobs SET revision = ?, document = ? WHERE job_id = ?').run(row.revision + 1, JSON.stringify(doc), binding.jobId);
  } finally {
    db.close();
  }
}

test.each([
  { mode: 'plain', flags: [] },
  { mode: '--json', flags: ['--json'] },
])('#833 bound diff-classes ($mode) refuses JOB_ASK_PENDING before writing project.json', async ({ flags }) => {
  const root = await preparedParts();
  const opening = await open(root);
  const head = publicationId(root);
  expect(opening.lines).toEqual([`job: draft chain published (publication ${head})`]);
  seedHistoricalPendingDraftAsk(root, head, 'chain');
  const projectFile = join(root, 'project.json');
  const before = readFileSync(projectFile);
  const refused = await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent', ...flags]);
  expect(refused).toMatchObject({
    exit: 1,
    stdout: '',
    stderr: expect.stringMatching(/^rig-create: JOB_ASK_PENDING: /),
  });
  expect(readFileSync(projectFile)).toEqual(before);
  expect(publicationId(root)).toBe(head);
  expect(pendingPublications(root)).toEqual([]);
}, 30_000);

test('#690 prepareDraftIntent defers an unready draft with no owner ask and preparation makes it publishable', async () => {
  const root = await preparedParts();
  const args = copyDraft(root, 'chain-2');
  const before = await openPartsWithoutAsk(root);
  const recorded = seedRetainedDraft([...args, '--json']);
  expect(recorded.exit).toBe(0);
  const printed = JSON.parse(recorded.stdout) as JsonObject;
  expect(printed.id).toBe('chain-2');
  const intent = prepareDraftIntent(root, readFileSync(join(root, 'project.json')), 'chain-2');
  expect(intent.intent).toBeNull();
  const guidance = intent.deferred ?? '';
  expect(guidance).toContain('open page not updated: structure snapshot missing or invalid at evidence/structure-chain-2.json');
  expect(guidance).toContain(`rig-create structure-snapshot ${root} --draft chain-2 --out evidence/structure-chain-2.json`);
  expect(guidance).toContain(`Then run rig-create job open ${root} --draft chain-2`);
  const draft = (read(root).drafts as JsonObject[]).find(record => record.id === 'chain-2');
  expect(draft).toEqual(expect.objectContaining({ id: 'chain-2' }));
  expect(draft).not.toHaveProperty('publication');
  expect(publicationId(root)).toBe(before);
  expect(pendingPublications(root)).toEqual([]);

  const next = await cli(root, ['next', root, '--json']);
  const moves = JSON.parse(next.stdout).moves as { command: string | null }[];
  expect(moves.some(move => move.command?.includes('structure-snapshot') && move.command.includes('--draft chain-2'))).toBe(true);
  expect(await cli(root, ['structure-snapshot', root, '--draft', 'chain-2', '--out', 'evidence/structure-chain-2.json'])).toMatchObject({ exit: 0 });
  mkdirSync(join(root, 'evidence/parts-chain-2'));
  cpSync(join(root, 'evidence/diff-components.json'), join(root, 'evidence/parts-chain-2/diff-components.json'));
  expect(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/parts-chain-2/diff-components.json', '--by', 'agent'])).toMatchObject({ exit: 0 });
  const afterNext = await cli(root, ['next', root, '--json']);
  expect((JSON.parse(afterNext.stdout).moves as { awaits: string; act: string }[])
    .some(move => move.awaits === 'review_acts[kind=parts-verdict,draft_id=chain-2]' && move.act.includes('NUMBERED_ACT_RETIRED'))).toBe(true);
  const shown = await cli(root, ['job', 'open', root, '--draft', 'chain-2', '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(shown).toMatchObject({ exit: 0, stderr: '' });
  const after = publicationId(root);
  expect(shown.stdout).toContain(`job: draft chain-2 published (publication ${after})`);
  expect(shown.stdout).not.toContain('asked parts-verdict');
  expect(after).not.toBe(before);
}, 30_000);

test('#690 explicit job open --draft replaces a publication with an unanswered earlier-draft ask', async () => {
  const root = await preparedParts();
  const args = copyDraft(root, 'chain-2');
  expect(seedRetainedDraft(args).exit).toBe(0);
  expect(await cli(root, ['structure-snapshot', root, '--draft', 'chain-2'])).toMatchObject({ exit: 0, stderr: '' });
  const opening = await open(root, ['--draft', 'chain']);
  const binding = readWriterBinding(root)!;
  const before = publicationId(root);
  expect(opening.lines).toEqual([`job: draft chain published (publication ${before})`]);
  seedHistoricalPendingDraftAsk(root, before, 'chain');
  const shown = await cli(root, ['job', 'open', root, '--draft', 'chain-2', '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(shown).toMatchObject({ exit: 0, stderr: '' });
  const [url, ...lines] = shown.stdout.trim().split('\n');
  expect(url).toBe(opening.url.href);
  const after = publicationId(root);
  expect(lines).toEqual([`job: draft chain-2 published (publication ${after})`]);
  expect(after).not.toBe(before);
  expect(readAcknowledgedPublication(root, binding.jobId, after)?.subjects).toEqual([]);
  expect(pendingPublications(root)).toEqual([]);
}, 30_000);

test('#690 advance keeps the open numbered rig page unchanged', async () => {
  const root = copyCheckpoint('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root, ['--rig', '1']);
  const before = publicationId(root);
  expect(opening.lines).toEqual([`job: rig v1 published (publication ${before})`]);
  const advanced = await cli(root, ['advance', 'rig-review', root]);
  const after = publicationId(root);
  expect({ exit: advanced.exit, stderr: advanced.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(after).toBe(before);
  expect(advanced.stdout.trim()).toBe('advance: rigging -> rig-review');
  expect(pendingPublications(root)).toEqual([]);
  const binding = readWriterBinding(root)!;
  expect(readAcknowledgedPublication(root, binding.jobId, after)?.subjects).toEqual([]);
}, 30_000);
