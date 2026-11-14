import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverReplacedJobHostState, hostPortRefuses } from '../src/job-host-state.ts';
import { publicationFailure } from '../src/job-runtime.ts';
import { openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { acquireJobLock, jobHash, jobHostStateRoot } from '../src/job-outbox.ts';

const NOW = Date.parse('2026-11-14T00:00:00Z');
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) {
    const state = jobHostStateRoot(root);
    for (const name of readdirSync(dirname(state))) {
      if (name === state.slice(state.lastIndexOf('/') + 1) || name.startsWith(state.slice(state.lastIndexOf('/') + 1) + '.replaced-')) {
        rmSync(join(dirname(state), name), { recursive: true, force: true });
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function listener(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer(socket => socket.destroy()); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected TCP address');
  return { server, port: address.port };
}

async function fixture(replaced = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-host-state-'))); roots.push(root);
  writeFileSync(join(root, 'project.json'), '{"versions":[]}\n');
  const state = jobHostStateRoot(root), host = join(state, 'host'), control = join(host, 'job-ui');
  mkdirSync(control, { recursive: true, mode: 0o700 });
  const info = lstatSync(root), jobId = randomUUID(), fingerprint = 'rig-create/live-review/1';
  const storedRoot = { path: root, dev: info.dev, ino: info.ino + (replaced ? 1 : 0) };
  const db = new Database(join(host, 'jobs.sqlite'), { create: true });
  db.exec('CREATE TABLE jobs(job_id TEXT, root_key TEXT, active INTEGER, document TEXT)');
  db.query('INSERT INTO jobs VALUES(?,?,1,?)').run(jobId, jobHash(JSON.stringify([root, fingerprint])), JSON.stringify({ root: storedRoot, fingerprint }));
  db.close(); chmodSync(join(host, 'jobs.sqlite'), 0o600);
  // A real exited process and a real released port provide independent dead-owner controls.
  const child = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' });
  expect(await child.exited).toBe(0);
  const { server, port } = await listener();
  await new Promise<void>(resolve => server.close(() => resolve()));
  const descriptor = join(control, `${jobId}.json`);
  const record = { schema: 'rig-review-job-host/1', jobId, fingerprint, pid: child.pid, origin: `http://127.0.0.1:${port}` };
  writeFileSync(descriptor, JSON.stringify(record), { mode: 0o600 });
  return { root, state, host, control, jobId, descriptor, record };
}

async function recover(root: string, probe?: (port: number) => Promise<boolean>) {
  const release = acquireJobLock(root)!;
  try { return await recoverReplacedJobHostState(root, NOW, probe); }
  finally { release(); }
}

function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(directory: string, prefix = ''): void {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), relative = prefix + name;
      if (lstatSync(path).isDirectory()) visit(path, relative + '/');
      else result[relative] = jobHash(readFileSync(path));
    }
  }
  visit(root); return result;
}

test('#523 preserves stopped replaced-root state in a dated sibling without rewriting any retained bytes', async () => {
  const f = await fixture(), before = inventory(f.state), project = readFileSync(join(f.root, 'project.json'));
  const archive = await recover(f.root);
  expect(archive).toStartWith(`${f.state}.replaced-2026-11-14T00-00-00-000Z-`);
  expect(existsSync(f.state)).toBe(false);
  expect(inventory(archive!)).toEqual(before);
  expect(readFileSync(join(f.root, 'project.json'))).toEqual(project);
  expect(await recover(f.root)).toBeUndefined();
});

test('#523 leaves a same-root host alone even when its recorded PID is alive', async () => {
  const f = await fixture(false);
  writeFileSync(f.descriptor, JSON.stringify({ ...f.record, pid: process.pid }));
  const before = inventory(f.state);
  expect(await recover(f.root)).toBeUndefined();
  expect(inventory(f.state)).toEqual(before);
});

test('#523 refuses a replaced root with a live PID even when its port refuses', async () => {
  const f = await fixture();
  writeFileSync(f.descriptor, JSON.stringify({ ...f.record, pid: process.pid }));
  const before = inventory(f.state), project = readFileSync(join(f.root, 'project.json'));
  await expect(recover(f.root)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  expect(inventory(f.state)).toEqual(before);
  expect(readFileSync(join(f.root, 'project.json'))).toEqual(project);
});

test('#523 refuses a dead PID when the recorded port accepts connections', async () => {
  const f = await fixture(), live = await listener();
  writeFileSync(f.descriptor, JSON.stringify({ ...f.record, origin: `http://127.0.0.1:${live.port}` }));
  const before = inventory(f.state);
  await expect(recover(f.root)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  expect(inventory(f.state)).toEqual(before);
  expect(live.server.listening).toBe(true);
});

test('#523 refuses uncertainty from the port probe without retiring state', async () => {
  const f = await fixture(), before = inventory(f.state);
  await expect(recover(f.root, async () => false)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  expect(inventory(f.state)).toEqual(before);
});

test('#523 detects descriptor changes during the port probe and releases only its own startup claim', async () => {
  const f = await fixture();
  const altered = JSON.stringify({ ...f.record, pid: process.pid });
  await expect(recover(f.root, async () => { writeFileSync(f.descriptor, altered); return true; }))
    .rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  expect(readFileSync(f.descriptor, 'utf8')).toBe(altered);
  expect(readdirSync(f.control)).toEqual([`${f.jobId}.json`]);
});

test('#523 preserves another startup claimant and refuses to retire its state', async () => {
  const f = await fixture(), nonce = randomUUID(), claim = join(f.control, `job-${f.jobId}.claim`);
  mkdirSync(claim, { mode: 0o700 });
  writeFileSync(join(claim, `owner.${nonce}.json`), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
  const before = inventory(f.state);
  await expect(recover(f.root)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  expect(inventory(f.state)).toEqual(before);
});

test('#523 refuses missing, malformed or unsafe descriptor metadata instead of guessing ownership', async () => {
  const f = await fixture();
  rmSync(f.descriptor);
  await expect(recover(f.root)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  writeFileSync(f.descriptor, JSON.stringify({ ...f.record, pid: 0 }), { mode: 0o600 });
  await expect(recover(f.root)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  writeFileSync(f.descriptor, JSON.stringify(f.record)); chmodSync(f.descriptor, 0o644);
  await expect(recover(f.root)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  rmSync(f.descriptor); symlinkSync(join(f.root, 'project.json'), f.descriptor);
  await expect(recover(f.root)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  expect(existsSync(f.state)).toBe(true);
});

test('#523 refuses SQLite sidecars without recovering or changing them', async () => {
  const f = await fixture(), sidecar = join(f.host, 'jobs.sqlite-wal');
  writeFileSync(sidecar, 'retained incomplete journal', { mode: 0o600 });
  await expect(recover(f.root)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  expect(readFileSync(sidecar, 'utf8')).toBe('retained incomplete journal');
  expect(existsSync(f.state)).toBe(true);
});

test('#523 does not retire a replaced host while an in-project publication is pending', async () => {
  const f = await fixture(), id = 'a'.repeat(64), outbox = join(f.root, '.rig-create-review/outbox');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const receipt = JSON.stringify({ schema: 'rig-create/job-pending@1', id, root: f.root, recordHash: 'b'.repeat(64),
    versionHash: 'c'.repeat(64), result: { path: 'review.json', selector: { kind: 'rig', version: 1 } }, identity: {}, phase: 'pending' });
  writeFileSync(join(outbox, `${id}.json`), receipt, { mode: 0o600 });
  await expect(recover(f.root)).rejects.toMatchObject({ code: 'JOB_ROOT_REPLACED' });
  expect(readFileSync(join(outbox, `${id}.json`), 'utf8')).toBe(receipt);
  expect(existsSync(f.state)).toBe(true);
});

test('#523 overlapping recovery cannot bypass the project writer lock', async () => {
  const f = await fixture(), release = acquireJobLock(f.root)!;
  const before = inventory(f.state);
  try {
    await expect(reconcileCreateJob(f.root)).rejects.toMatchObject({ code: 'JOB_WRITE_BUSY' });
    await expect(openCreateJob(f.root, { id: 'synthetic-owner', role: 'owner' }, NOW))
      .rejects.toMatchObject({ code: 'JOB_WRITE_BUSY' });
  }
  finally { release(); }
  expect(inventory(f.state)).toEqual(before);
});

test('#523 exposes only the known Review root code and never its uncontrolled message', () => {
  const refusal = publicationFailure(Object.assign(Error('private producer text'), { code: 'JOB_ROOT_REPLACED' }), 'synthetic-project');
  expect(refusal?.code).toBe('JOB_ROOT_REPLACED');
  expect(refusal?.message).toContain('project.json');
  expect(refusal?.message).not.toContain('private producer text');
  expect(publicationFailure(Object.assign(Error('private producer text'), { code: 'UNKNOWN_PRODUCER_ERROR' }), 'synthetic-project')).toBeUndefined();
});

test('#523 port probe distinguishes a listener from a refused connection', async () => {
  const { server, port } = await listener();
  expect(await hostPortRefuses(port)).toBe(false);
  await new Promise<void>(resolve => server.close(() => resolve()));
  expect(await hostPortRefuses(port)).toBe(true);
});
