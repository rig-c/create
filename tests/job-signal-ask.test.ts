/**
 * `job open` forwards SIGTERM/SIGINT from the CLI wrapper to its spawned runtime so the
 * host port stops without leaving an orphan listener, and bound writers surface refused ask
 * outcomes (`JOB_ASK_REFUSED`) after acknowledging the publication (#355).
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { draftRigCommand } from '../src/drafts.ts';
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

async function open(root: string): Promise<{ proc: Bun.Subprocess; url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner'], {
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
  expect(lines).toEqual(['job: draft chain published', 'job: asked parts-verdict chain']);
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

  // Plant a one-shot SQLite trigger in the synthetic host state so the published snapshot's
  // retained subjects drop `signoff rig-review` after `publish` succeeds, causing Review's
  // subsequent `ask` for `signoff rig-review` to refuse with `JOB_ASK_INVALID`.
  const sqlitePath = join(binding.identity.stateDir, 'jobs.sqlite');
  const db = new Database(sqlitePath);
  try {
    db.exec(`
      CREATE TRIGGER refuse_signoff_ask AFTER UPDATE OF document ON jobs
      WHEN json_extract(NEW.document, '$.head') IS NOT NULL
        AND json_extract(OLD.document, '$.head') IS NOT json_extract(NEW.document, '$.head')
      BEGIN
        UPDATE jobs
        SET document = json_remove(NEW.document, '$.publications.' || json_extract(NEW.document, '$.head') || '.retained.subjects[1]')
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
  expect((thrown as Refusal).message).toContain('signoff rig-review (JOB_ASK_INVALID)');

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
    { kind: 'signoff', stage: 'rig-review' },
  ]);

  // Also verify via draftRigCommand and the CLI entrypoint on a bound draft-rig writer that JOB_ASK_REFUSED exits 1 with the named code.
  const draftRoot = copyCheckpoint('1-parts-verdict', project => {
    project.signoffs = (project.signoffs as JsonObject[]).filter(signoff => signoff.checkpoint !== 'assemble');
  });
  cpSync(join(draftRoot, 'derived/drafts/chain'), join(draftRoot, 'derived/drafts/chain-2'), { recursive: true });
  cpSync(join(draftRoot, 'derived/drafts/chain'), join(draftRoot, 'derived/drafts/chain-3'), { recursive: true });
  await open(draftRoot);
  const draftBinding = readWriterBinding(draftRoot)!;
  const draftDb = new Database(join(draftBinding.identity.stateDir, 'jobs.sqlite'));
  try {
    draftDb.exec(`
      CREATE TRIGGER refuse_draft_ask AFTER UPDATE OF document ON jobs
      WHEN json_extract(NEW.document, '$.head') IS NOT NULL
        AND json_extract(OLD.document, '$.head') IS NOT json_extract(NEW.document, '$.head')
      BEGIN
        UPDATE jobs
        SET document = json_remove(NEW.document, '$.publications.' || json_extract(NEW.document, '$.head') || '.retained.subjects[0]')
        WHERE job_id = NEW.job_id;
      END;
    `);
  } finally {
    draftDb.close();
  }
  expect(() =>
    draftRigCommand(['chain-2', draftRoot, '--config', 'derived/drafts/chain-2/config.json', '--from', 'derived/drafts/chain-2/out', '--parts', 'derived/drafts/chain-2/input'], EXAMPLE_NOW),
  ).toThrow(expect.objectContaining({ code: 'JOB_ASK_REFUSED' }));
  const cliDraft = await cli(draftRoot, [
    'draft-rig', 'chain-3', draftRoot,
    '--config', 'derived/drafts/chain-3/config.json',
    '--from', 'derived/drafts/chain-3/out',
    '--parts', 'derived/drafts/chain-3/input',
  ]);
  expect(cliDraft.exit).toBe(1);
  expect(cliDraft.stdout.trim()).toBe('job: asked checkpoint assemble');
  expect(cliDraft.stderr).toContain('JOB_ASK_REFUSED: ');
  expect(cliDraft.stderr).toContain('parts-verdict chain-3 (JOB_ASK_INVALID)');
  expect(pendingPublications(draftRoot)).toEqual([]);
});

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
    'job: asked review-verdict rig-review, signoff rig-review',
  ]);

  const draftRoot = copyCheckpoint('1-parts-verdict', project => {
    project.signoffs = (project.signoffs as JsonObject[]).filter(signoff => signoff.checkpoint !== 'assemble');
  });
  cpSync(join(draftRoot, 'derived/drafts/chain'), join(draftRoot, 'derived/drafts/chain-2'), { recursive: true });
  cpSync(join(draftRoot, 'derived/drafts/chain'), join(draftRoot, 'derived/drafts/chain-3'), { recursive: true });
  await open(draftRoot);

  const drafted = await cli(draftRoot, [
    'draft-rig', 'chain-2', draftRoot,
    '--config', 'derived/drafts/chain-2/config.json',
    '--from', 'derived/drafts/chain-2/out',
    '--parts', 'derived/drafts/chain-2/input',
  ]);
  expect({ exit: drafted.exit, stderr: drafted.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(drafted.stdout.trim().split('\n')).toEqual([
    'draft-rig: recorded chain-2; no production version created',
    'job: asked parts-verdict chain-2, checkpoint assemble',
  ]);

  const draftedJson = await cli(draftRoot, [
    'draft-rig', 'chain-3', draftRoot,
    '--config', 'derived/drafts/chain-3/config.json',
    '--from', 'derived/drafts/chain-3/out',
    '--parts', 'derived/drafts/chain-3/input',
    '--json',
  ]);
  expect({ exit: draftedJson.exit, stderr: draftedJson.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(JSON.parse(draftedJson.stdout)).toMatchObject({ id: 'chain-3' });
});
