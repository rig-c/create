/**
 * `job close` against a stopped host, then a restarted one (#845). Close reads the
 * job's finalized owner acts from the bound live host, so a stopped host refuses
 * and names the restart; after the restart close waits out the job write lock
 * (the restarted host's publication freeze) for a bounded time, then closes.
 */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeCreateJob } from '../src/job-close.ts';
import { acquireJobLock, JOB_BINDING_FILE, jobHostStateRoot, jobPrivateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
const roots: string[] = [];
const hosts: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const proc of hosts.splice(0)) {
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));

function registeredRig(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-close-stopped-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), root, { recursive: true });
  const project = read(root);
  project.stage = 'rigging';
  const meshes = ((project.plan as JsonObject).steps as JsonObject[]).find(step => step.id === 'meshes')!;
  (meshes.checkpoint as JsonObject).value = true;
  writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return root;
}

async function cli(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

/** Start the foreground `job open --rig 1` host and read until its publication lines. */
async function openHost(root: string): Promise<Bun.Subprocess<'ignore', 'pipe', 'pipe'>> {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', '1'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  hosts.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!/\njob: .*\n$/.test(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  reader.releaseLock();
  expect(text).toStartWith('http://');
  return proc;
}

/** Hash every file under the project's private job directory and Review's host state, plus project.json and the binding. */
function jobState(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (base: string, label: string) => {
    if (!existsSync(base)) return;
    for (const name of readdirSync(base).sort()) {
      const path = join(base, name);
      if (lstatSync(path).isDirectory()) walk(path, `${label}/${name}`);
      else out[`${label}/${name}`] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  for (const name of ['project.json', JOB_BINDING_FILE]) {
    const path = join(root, name);
    if (existsSync(path)) out[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  walk(jobPrivateRoot(root), 'private');
  walk(jobHostStateRoot(root), 'host');
  return out;
}

const codeOf = (stderr: string): string | undefined => /([A-Z][A-Z0-9_]+):/.exec(stderr)?.[1];

test('#845 close against a stopped host refuses with the restart command; after the restart it waits out the write lock and closes', async () => {
  const root = registeredRig();
  const first = await openHost(root);
  const { jobId } = readWriterBinding(root)!;
  first.kill('SIGTERM');
  expect(await first.exited).toBe(0);

  const stopped = jobState(root);
  const refused = await cli(root, ['job', 'close', root]);
  expect(refused.exit).toBe(1);
  expect(codeOf(refused.stderr)).toBe('JOB_HOST_ATTACH_REFUSED');
  expect(refused.stderr).toContain(`job open ${root} --reviewer synthetic-owner --role owner`);
  expect(refused.stderr).toContain('finalized owner acts');
  expect(refused.stdout).toBe('');
  expect(jobState(root)).toEqual(stopped);

  // The restart serves the same job, so its finalized acts are still read before closing.
  const restarted = await openHost(root);
  expect(readWriterBinding(root)!.jobId).toBe(jobId);

  // A writer (here this test process) holds the restarted job's publication freeze.
  const release = acquireJobLock(root)!;
  const held = Date.now();
  const timer = setTimeout(release, 1_500);
  try {
    const closed = await cli(root, ['job', 'close', root]);
    expect({ exit: closed.exit, stdout: closed.stdout.trim() }).toEqual({ exit: 0, stdout: 'job: closed' });
    expect(closed.stderr).toContain(`job: waiting up to 120 s for process ${process.pid} to release the job write lock`);
    expect(Date.now() - held).toBeGreaterThanOrEqual(1_400);
  } finally { clearTimeout(timer); }
  expect(readWriterBinding(root)).toBeNull();
  expect(await restarted.exited).toBe(0);
}, 60_000);

test('#845 a close whose wait runs out refuses JOB_WRITE_BUSY naming the holder and leaves the record and job state byte-identical', async () => {
  const root = registeredRig();
  await openHost(root);
  const release = acquireJobLock(root)!;
  let before: Record<string, string>;
  try {
    before = jobState(root);
    const error = await closeCreateJob(root, undefined, false, undefined, Date.now(), 300).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Refusal);
    expect({ code: (error as Refusal).code, exit: (error as Refusal).exitCode }).toEqual({ code: 'JOB_WRITE_BUSY', exit: 1 });
    expect((error as Refusal).message).toContain(`held by live process ${process.pid}`);
    expect((error as Refusal).message).toContain('retry rig-create job close');
    expect(jobState(root)).toEqual(before);
  } finally { release(); }
  // The host is untouched: once the lock clears, the same close succeeds.
  const closed = await cli(root, ['job', 'close', root]);
  expect({ exit: closed.exit, stdout: closed.stdout.trim() }).toEqual({ exit: 0, stdout: 'job: closed' });
}, 60_000);
