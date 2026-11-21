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
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { askOutcomeLines, closeCreateJob } from '../src/job-host.ts';
import { jobHostStateRoot, jobPrivateRoot, pendingPublications, readAcknowledgedPublication, readWriterBinding } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';

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
  expect(lines).toEqual(['job: draft chain published']);
  expect(await isOriginListening(url.origin)).toBe(true);

  proc.kill(signal);
  await proc.exited;

  // Give the runtime a brief moment to complete stop() if exiting asynchronously.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && await isOriginListening(url.origin)) {
    await Bun.sleep(50);
  }
  expect(await isOriginListening(url.origin)).toBe(false);
});

test('bound writers surface JOB_ASK_REFUSED by named code when Review refuses a declared ask after acknowledging the publication', async () => {
  const root = copyCheckpoint('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  const binding = readWriterBinding(root)!;

  // Invalidate only the synthetic host's retained model binding after publish succeeds.
  // Review validates a rig verdict against that binding, so its declared ask refuses
  // with JOB_ASK_INVALID without relying on the removed separate signoff subject.
  const sqlitePath = join(binding.identity.stateDir, 'jobs.sqlite');
  const db = new Database(sqlitePath);
  try {
    db.exec(`
      CREATE TRIGGER refuse_verdict_ask AFTER UPDATE OF document ON jobs
      WHEN json_extract(NEW.document, '$.head') IS NOT NULL
        AND json_extract(OLD.document, '$.head') IS NOT json_extract(NEW.document, '$.head')
      BEGIN
        UPDATE jobs
        SET document = json_set(NEW.document, '$.publications.' || json_extract(NEW.document, '$.head') || '.retained.source.model', NULL)
        WHERE job_id = NEW.job_id;
      END;
    `);
  } finally {
    db.close();
  }

  let thrown: unknown;
  try {
    advanceCommand(['rig-review', root, '--json'], EXAMPLE_NOW);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Refusal);
  expect((thrown as Refusal).code).toBe('JOB_ASK_REFUSED');
  expect((thrown as Refusal).message).toContain('review-verdict rig-review (JOB_ASK_INVALID)');

  // The record is committed and the publication is acknowledged (never left pending).
  expect(read(root).stage).toBe('rig-review');
  expect(pendingPublications(root)).toEqual([]);
  const headEvents = await fetch(`${opening.url.origin}/jobs/${binding.jobId}/events`, {
    headers: { origin: opening.url.origin, 'X-Review-Capability': opening.url.hash.replace('#cap=', '') },
    signal: AbortSignal.timeout(1000),
  });
  const reader = headEvents.body!.getReader();
  const firstChunk = await reader.read();
  await reader.cancel();
  const lines = new TextDecoder().decode(firstChunk.value).trim().split('\n').map(line => JSON.parse(line) as JsonObject);
  const published = lines.filter(event => event.type === 'published').at(-1)!.publication as JsonObject;
  const acknowledged = readAcknowledgedPublication(root, binding.jobId, String(published.publicationId));
  expect(acknowledged).not.toBeNull();
  expect(acknowledged?.subjects).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
  ]);

}, 15_000);

test('bound writers print concise asked/already subject lines in text mode and preserve JSON stdout in --json mode', async () => {
  expect(askOutcomeLines([
    { subject: { kind: 'parts-verdict', draftId: 'chain-2' }, status: 'asked' },
    { subject: { kind: 'checkpoint', checkpointId: 'assemble' }, status: 'already' },
  ])).toEqual([
    'job: asked parts-verdict chain-2',
    'job: already asked checkpoint assemble',
  ]);

  const root = copyCheckpoint('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  await open(root);
  const advanced = await cli(root, ['advance', 'rig-review', root]);
  expect({ exit: advanced.exit, stderr: advanced.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(advanced.stdout.trim().split('\n')).toEqual([
    'advance: rigging -> rig-review',
    'job: asked review-verdict rig-review',
  ]);

  // --json stdout stays one JSON document; a bound draft-rig carries the page update inside it.
  const draftRoot = await preparedParts();
  const args = copyDraft(draftRoot, 'chain-2');
  const snapshot = JSON.parse(readFileSync(join(draftRoot, 'evidence/structure-chain.json'), 'utf8')) as JsonObject;
  snapshot.draft_id = 'chain-2';
  (snapshot.config as JsonObject).path = 'derived/drafts/chain-2/config.json';
  writeFileSync(join(draftRoot, 'evidence/structure-chain-2.json'), JSON.stringify(snapshot));
  await open(draftRoot);
  const draftedJson = await cli(draftRoot, [...args, '--json']);
  expect({ exit: draftedJson.exit, stderr: draftedJson.stderr }).toEqual({ exit: 0, stderr: '' });
  const printed = JSON.parse(draftedJson.stdout) as JsonObject;
  expect(printed).toMatchObject({ id: 'chain-2', publication: { status: 'published' } });
  expect((printed.publication as { lines: string[] }).lines).toContain(`job: updated the open page: publication ${publicationId(draftRoot)}, ask parts-verdict chain-2`);
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
  return ['draft-rig', id, root, '--config', `${base}/config.json`, '--from', `${base}/out`, '--parts', `${base}/input`];
}

async function preparedParts(): Promise<string> {
  const root = copyCheckpoint('1-parts-verdict');
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expect(await cli(root, ['structure-snapshot', root, '--draft', 'chain', '--out', 'evidence/structure-chain.json'])).toMatchObject({ exit: 0 });
  expect(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'])).toMatchObject({ exit: 0 });
  expect(await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'])).toMatchObject({ exit: 0 });
  return root;
}

test('#690 unready draft records without replacing an asked page and can be shown once prepared', async () => {
  const root = await preparedParts();
  const args = copyDraft(root, 'chain-2');
  expect((await open(root)).lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain']);
  const before = publicationId(root);
  expect(before).toBeTruthy();
  const recorded = await cli(root, args);
  expect({ exit: recorded.exit, stderr: recorded.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root).drafts).toContainEqual(expect.objectContaining({ id: 'chain-2' }));
  const head = publicationId(root);
  const binding = readWriterBinding(root)!;
  console.log('#690 draft publication ID', before, '->', head, 'subjects', readAcknowledgedPublication(root, binding.jobId, head)?.subjects);
  expect(head).toBe(before);
  expect(pendingPublications(root)).toEqual([]);
  expect(recorded.stdout).toContain('open page not updated: structure snapshot missing or invalid at evidence/structure-chain-2.json');
  expect(recorded.stdout).toContain(`rig-create structure-snapshot ${root} --draft chain-2 --out evidence/structure-chain-2.json`);
  expect(recorded.stdout).toContain('Then run rig-create job open');
  expect(recorded.stdout).toContain('--draft chain-2');

  const next = await cli(root, ['next', root, '--json']);
  const moves = JSON.parse(next.stdout).moves as { command: string | null }[];
  expect(moves.some(move => move.command?.includes('structure-snapshot') && move.command.includes('--draft chain-2'))).toBe(true);
  expect(await cli(root, ['structure-snapshot', root, '--draft', 'chain-2', '--out', 'evidence/structure-chain-2.json'])).toMatchObject({ exit: 0 });
  mkdirSync(join(root, 'evidence/parts-chain-2'));
  cpSync(join(root, 'evidence/diff-components.json'), join(root, 'evidence/parts-chain-2/diff-components.json'));
  expect(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/parts-chain-2/diff-components.json', '--by', 'agent'])).toMatchObject({ exit: 0 });
  const afterNext = await cli(root, ['next', root, '--json']);
  expect((JSON.parse(afterNext.stdout).moves as { command: string | null }[])
    .some(move => move.command?.includes('job open') && move.command.includes('--draft chain-2'))).toBe(true);
  const shown = await cli(root, ['job', 'open', root, '--draft', 'chain-2', '--reviewer', 'synthetic-owner', '--role', 'owner']);
  expect(shown).toMatchObject({ exit: 0, stderr: '' });
  expect(shown.stdout).toContain('job: asked parts-verdict chain-2');
  expect(publicationId(root)).not.toBe(before);
}, 30_000);

test('#690 prepared draft updates an open page with its parts-verdict ask', async () => {
  const root = await preparedParts();
  const args = copyDraft(root, 'chain-2');
  // An independent prepared snapshot binds the prospective synthetic draft's exact config.
  const snapshot = JSON.parse(readFileSync(join(root, 'evidence/structure-chain.json'), 'utf8')) as JsonObject;
  snapshot.draft_id = 'chain-2';
  (snapshot.config as JsonObject).path = 'derived/drafts/chain-2/config.json';
  writeFileSync(join(root, 'evidence/structure-chain-2.json'), JSON.stringify(snapshot));
  await open(root);
  const before = publicationId(root);
  const recorded = await cli(root, args);
  const after = publicationId(root);
  expect({ exit: recorded.exit, stderr: recorded.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(after).not.toBe(before);
  expect(recorded.stdout).toContain(`updated the open page: publication ${after}, ask parts-verdict chain-2`);
  const binding = readWriterBinding(root)!;
  expect(readAcknowledgedPublication(root, binding.jobId, after)?.subjects).toEqual([{ kind: 'parts-verdict', draftId: 'chain-2' }]);
  expect(pendingPublications(root)).toEqual([]);
}, 30_000);

test('#690 draft-rig --json reports a deferred update of the open page', async () => {
  const root = await preparedParts();
  const args = copyDraft(root, 'chain-2');
  await open(root);
  const before = publicationId(root);
  const recorded = await cli(root, [...args, '--json']);
  expect({ exit: recorded.exit, stderr: recorded.stderr }).toEqual({ exit: 0, stderr: '' });
  const printed = JSON.parse(recorded.stdout) as JsonObject;
  expect(printed.id).toBe('chain-2');
  const notice = printed.publication as { status: string; lines: string[] };
  expect(notice.status).toBe('deferred');
  expect(notice.lines.join('\n')).toContain('open page not updated: structure snapshot missing or invalid at evidence/structure-chain-2.json');
  expect(publicationId(root)).toBe(before);
  expect(read(root).drafts).toContainEqual(expect.not.objectContaining({ publication: expect.anything() }));
}, 30_000);

test('#690 #754 advance publishes the rig verdict ask that job open --rig refuses before rig-review', async () => {
  const root = copyCheckpoint('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const opening = await open(root);
  expect(opening.lines).toEqual(['job: stage rigging shows no draft; name one with --draft <id>']);
  const record = read(root);
  const early = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', '1']);
  expect(early.exit).toBe(1);
  // Every rigging bar is met, so the refusal names only the move.
  expect(early.stderr).toStartWith(`JOB_RIG_VERDICT_UNASKABLE: project.json.stage: stage rigging cannot ingest a rig-review verdict on rig v1; run rig-create advance rig-review ${root} and retry `);
  expect(read(root)).toEqual(record);
  const advanced = await cli(root, ['advance', 'rig-review', root]);
  const after = publicationId(root);
  expect({ exit: advanced.exit, stderr: advanced.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(advanced.stdout).toContain('job: asked review-verdict rig-review');
  const binding = readWriterBinding(root)!;
  expect(readAcknowledgedPublication(root, binding.jobId, after)?.subjects).toEqual([{ kind: 'review-verdict', stage: 'rig-review' }]);
}, 30_000);
