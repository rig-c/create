/** Retire only a replaced project's demonstrably stopped managed host. Never edit Review's store. */
import { Database, constants as sqlite } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { jobHash, jobHostStateRoot, pendingPublications, privateJson } from './job-outbox.ts';
import { Refusal, refuse } from './refusal.ts';

interface StoredRoot { path: string; dev: number; ino: number }
interface ActiveJob { jobId: string; rootKey: string; root: StoredRoot; fingerprint: string }
interface Host { jobId: string; fingerprint: string; pid: number; origin: string }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function replacedRootRefusal(root: string, recorded?: { pid: number; origin: string }): never {
  refuse('JOB_ROOT_REPLACED', `project.json: the retained Review host belongs to a replaced project directory at ${root}; stop the original job open host in its terminal${recorded ? ` (recorded PID ${recorded.pid}, ${recorded.origin})` : ''}, then retry rig-create job open or job reconcile. Recovery requires its recorded PID to be absent, its recorded port to refuse connections, no startup claim and no pending publication; restore missing or unsafe host metadata before retrying`);
}

function absent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

function owned(path: string, directory: boolean): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())
    || (info.mode & 0o077) || !directory && info.nlink !== 1
    || process.getuid && info.uid !== process.getuid() || realpathSync(path) !== path) throw Error();
}

function dead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** A timeout, reset or any other network error is uncertainty, never proof of a stopped listener. */
export function hostPortRefuses(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (refused: boolean) => { socket.destroy(); resolve(refused); };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
  });
}

/** Caller holds acquireJobLock(root) through inspection, rename and host startup. */
export async function recoverReplacedJobHostState(
  root: string,
  now?: number,
  probe: (port: number) => Promise<boolean> = hostPortRefuses,
): Promise<string | undefined> {
  const state = jobHostStateRoot(root), host = join(state, 'host'), file = join(host, 'jobs.sqlite');
  if (absent(file)) return;
  let claim: string | undefined, archived: string | undefined;
  let claimIdentity: { dev: number; ino: number } | undefined;
  let recorded: Host | undefined;
  const nonce = randomUUID();
  try {
    // The only private store fields consumed are the active job's identity and root identity.
    owned(state, true); owned(host, true); owned(file, false);
    if (['-journal', '-wal', '-shm'].some(suffix => !absent(file + suffix))) throw Error();
    const current = lstatSync(root);
    const rootIdentity = { path: realpathSync(root), dev: current.dev, ino: current.ino };
    const db = new Database(file, sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_NOFOLLOW);
    let jobs: ActiveJob[];
    try {
      jobs = db.query<{ job_id: string; root_key: string; document: string }, []>(
        'SELECT job_id, root_key, document FROM jobs WHERE active=1',
      ).all().map(row => {
        const data = JSON.parse(row.document) as { root: StoredRoot; fingerprint: string };
        return { jobId: row.job_id, rootKey: row.root_key, root: data.root, fingerprint: data.fingerprint };
      });
    } finally { db.close(); }
    if (!jobs.length) return;
    for (const job of jobs) {
      if (!job.root || job.root.path !== rootIdentity.path || !Number.isSafeInteger(job.root.dev)
        || job.root.dev < 0 || !Number.isSafeInteger(job.root.ino) || job.root.ino < 0) throw Error();
    }
    if (jobs.every(job => job.root.dev === current.dev && job.root.ino === current.ino)) return;
    // Renaming the whole managed directory must not strand a different active incarnation.
    if (jobs.length !== 1 || pendingPublications(root).length) throw Error();
    const job = jobs[0]!;
    if (!UUID.test(job.jobId) || job.fingerprint !== 'rig-create/live-review/1'
      || job.rootKey !== jobHash(JSON.stringify([rootIdentity.path, job.fingerprint]))) throw Error();
    const control = join(host, 'job-ui'); owned(control, true);
    const claimNames = () => readdirSync(control).filter(name => name.endsWith('.claim') || name.endsWith('.claiming'));
    if (claimNames().length) throw Error();
    // Use Review's existing startup-claim protocol, so an overlapping listener cannot adopt the old job.
    const candidate = join(control, `job-${job.jobId}.${nonce}.claiming`);
    mkdirSync(candidate, { mode: 0o700 }); claim = candidate;
    const installed = lstatSync(candidate); claimIdentity = { dev: installed.dev, ino: installed.ino };
    writeFileSync(join(candidate, `owner.${nonce}.json`), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600, flag: 'wx' });
    const target = join(control, `job-${job.jobId}.claim`);
    if (!absent(target)) throw Error();
    renameSync(candidate, target); claim = target;
    const snapshot = (): { seal: string; hosts: Host[] } => {
      owned(state, true); owned(host, true); owned(file, false); owned(control, true);
      const currentRoot = lstatSync(root);
      if (currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino || realpathSync(root) !== root) throw Error();
      if (['-journal', '-wal', '-shm'].some(suffix => !absent(file + suffix))) throw Error();
      const claims = claimNames();
      if (claims.length !== 1 || join(control, claims[0]!) !== claim) throw Error();
      const names = readdirSync(control).filter(name => name.endsWith('.json')).sort();
      if (!names.includes(`${job.jobId}.json`)) throw Error();
      const records = names.map(name => {
        const path = join(control, name); owned(path, false);
        const value = privateJson(path) as Host & { schema: string };
        if (value.schema !== 'rig-review-job-host/1' || !UUID.test(value.jobId) || name !== `${value.jobId}.json`
          || value.fingerprint !== job.fingerprint || !Number.isSafeInteger(value.pid) || value.pid <= 0
          || !/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(value.origin)
          || Number(new URL(value.origin).port || 80) > 65535) throw Error();
        return { path, value };
      });
      owned(claim!, true); owned(join(claim!, `owner.${nonce}.json`), false);
      const paths = [root, state, host, control, file, claim!, join(claim!, `owner.${nonce}.json`), ...records.map(record => record.path)];
      const seal = jobHash(JSON.stringify(paths.map(path => {
        const info = lstatSync(path);
        return [path, info.dev, info.ino, info.isFile() ? jobHash(readFileSync(path)) : null];
      })));
      return { seal, hosts: records.map(record => record.value) };
    };
    const before = snapshot();
    recorded = before.hosts.find(record => record.jobId === job.jobId);
    for (const record of before.hosts) {
      if (!dead(record.pid) || !await probe(Number(new URL(record.origin).port || 80))) throw Error();
    }
    // No await between final identity/claim/PID recheck and rename. Keep all original state bytes.
    if (snapshot().seal !== before.seal || before.hosts.some(record => !dead(record.pid))) throw Error();
    const destination = `${state}.replaced-${new Date(now ?? current.mtimeMs).toISOString().replace(/[:.]/g, '-')}-${nonce}`;
    if (!absent(destination)) throw Error();
    renameSync(state, destination); archived = destination;
    return destination;
  } catch (error) {
    if (error instanceof Refusal && error.code !== 'JOB_ROOT_REPLACED') throw error;
    replacedRootRefusal(root, recorded);
  } finally {
    if (claim) {
      const actual = archived ? join(archived, 'host', 'job-ui', claim.slice(claim.lastIndexOf('/') + 1)) : claim;
      // This marker was created here; never remove a pre-existing Review claim or state directory.
      try {
        const info = lstatSync(actual);
        if (!claimIdentity || !info.isDirectory() || info.isSymbolicLink() || info.dev !== claimIdentity.dev || info.ino !== claimIdentity.ino) throw Error();
        const owner = join(actual, `owner.${nonce}.json`);
        if (!absent(owner)) {
          if (readFileSync(owner, 'utf8') !== JSON.stringify({ pid: process.pid, nonce })) throw Error();
          rmSync(owner);
        }
        // rmdir refuses a competing owner's nonempty replacement.
        rmdirSync(actual);
      } catch { replacedRootRefusal(root, recorded); }
    }
  }
}
