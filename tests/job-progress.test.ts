import { expect, spyOn, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startJobHost } from '@rig-c/review/job-host';
import reviewPackage from '@rig-c/review/package.json';
import { currentJobIdentity, partsEnumerator, readPublished, readRecordPublished } from '../src/job-publication.ts';
import { JOB_BINDING_FILE, jobHash, jobHostStateRoot, jobPrivateRoot, writePrivateJson } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { TEST_NOW } from './clock.ts';
import { materializeFixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { isSourceLinkedRun } from './source-only.ts';

async function cli(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'cli-at.ts'),
    new Date(TEST_NOW).toISOString(), ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(),
  ]);
  return { exit, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

const check = (root: string) => cli(root, ['interview', '--check', root, '--json']);

function snapshot(root: string): unknown {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name); const stat = lstatSync(path);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(path) : jobHash(readFileSync(path))];
  });
}

const progressAdvertised = () => isSourceLinkedRun() || Bun.semver.satisfies(reviewPackage.version, '>=4.10.0');

interface ProgressRequest {
  schema: string;
  jobId: string;
  requestId: string;
  verb: string;
  seq: number;
  phase: string;
  text: string;
  step?: { i: number; n: number };
}

interface ProgressHost {
  host: Awaited<ReturnType<typeof startJobHost>>;
  calls: { body: ProgressRequest; bytes: number; authorized: boolean; reply: unknown }[];
  discovered: unknown[];
  failPosts: (fail: boolean) => void;
}

/** A bound record-and-package Review host whose HTTP listener records negotiation and progress. */
async function startProgressHost(root: string, stateDir: string): Promise<ProgressHost> {
  const identity = currentJobIdentity({ root, stateDir, fingerprint: 'synthetic-progress',
    reviewer: { id: 'synthetic-owner', role: 'owner' }, publicationMode: 'record-and-package' }, root);
  const calls: ProgressHost['calls'] = [];
  const discovered: unknown[] = [];
  let failPosts = false;
  let agent = '';
  // Observe the actual HTTP listener while forwarding normal negotiation and progress to Review.
  const serve = Bun.serve;
  const spy = spyOn(Bun, 'serve').mockImplementation((options) => {
    if (options.websocket || !options.fetch) return serve(options);
    const handler = options.fetch;
    return serve({ ...options, async fetch(request, server) {
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/api')) return handler.call(this, request, server);
      const raw = await request.clone().text();
      const body = JSON.parse(raw) as ProgressRequest;
      if (body.verb === 'next') {
        const response = await handler.call(this, request, server);
        const result = await response.clone().json() as { value: { capabilities: { progress?: boolean } } };
        discovered.push(result.value.capabilities.progress);
        if (!failPosts) return response;
        result.value.capabilities.progress = true;
        return Response.json(result);
      }
      if (body.verb !== 'progress') return handler.call(this, request, server);
      const response = failPosts ? Response.json({ ok: false }, { status: 503 }) : await handler.call(this, request, server);
      calls.push({ body, bytes: Buffer.byteLength(raw), authorized: request.headers.get('authorization') === `Bearer ${agent}`,
        reply: await response.clone().json() });
      return response;
    } });
  });
  const grants: { jobId: string; origin: string; fetchCapability: string }[] = [];
  const host = await (async () => {
    try {
      return await startJobHost({ root, stateDir, fingerprint: identity.fingerprint, reviewer: identity.reviewer,
        readerId: identity.readerId, bindingId: identity.bindingId, partsEnumeratorId: identity.partsEnumeratorId,
        partsEnumerator, publicationMode: 'record-and-package', readPublished, readRecordPublished,
        installWriterBinding: async grant => { grants.push(grant); } });
    } finally { spy.mockRestore(); }
  })();
  agent = host.session.hostCredentials().agent;
  expect(grants).toHaveLength(1);
  expect(host.attachment?.listenerIncarnation).toBeDefined();
  writePrivateJson(join(root, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, ...grants[0],
    listenerIncarnation: host.attachment!.listenerIncarnation }, true);
  return { host, calls, discovered, failPosts: fail => { failPosts = fail; } };
}

test('#688 filled project CLI progress uses the live Review API and keeps its command result', async () => {
  const scratch = realpathSync(tempDir());
  const root = materializeFixture(join(scratch, 'project'));
  const stateDir = join(scratch, 'review');
  mkdirSync(stateDir, { mode: 0o700 });
  const project = join(root, 'project.json');
  const original = readFileSync(project);
  let stop: (() => void) | undefined;
  try {
    const baseline = await check(root);
    expect(baseline.exit).toBe(0);
    expect(baseline.stderr.byteLength).toBe(0);
    expect(JSON.parse(baseline.stdout.toString())).toMatchObject({ ok: true, refusals: [], warnings: [] });
    expect(existsSync(jobPrivateRoot(root))).toBe(false);

    const { host, calls, discovered, failPosts } = await startProgressHost(root, stateDir);
    stop = () => host.stop();

    expect(await check(root)).toEqual(baseline);
    if (progressAdvertised()) {
      expect(discovered).toEqual([true, true, true]);
      expect(calls.map(call => [call.body.text, call.body.step])).toEqual([
        ['Starting project check', undefined],
        ['Checking the record and retained evidence', { i: 1, n: 2 }],
        ['Project check finished', { i: 2, n: 2 }],
      ]);
      expect(await check(root)).toEqual(baseline);
      expect(calls.map(call => call.body.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      for (const { body, reply } of calls) {
        expect(reply).toMatchObject({ ok: true, generation: 0, value: { status: 'accepted', seq: body.seq } });
      }
    } else {
      expect(discovered).toEqual([undefined]);
      expect(calls).toHaveLength(0);
      expect(existsSync(jobPrivateRoot(root))).toBe(false);
    }

    const successfulCount = calls.length;
    failPosts(true);
    expect(await check(root)).toEqual(baseline);
    const rejected = calls.slice(successfulCount);
    expect(rejected.map(call => call.body.seq)).toEqual([successfulCount + 1, successfulCount + 2, successfulCount + 3]);
    expect(rejected.map(call => call.reply)).toEqual([{ ok: false }, { ok: false }, { ok: false }]);
    for (const { body, bytes, authorized } of calls) {
      expect(authorized).toBe(true);
      expect(body).toMatchObject({ schema: 'rig-review/job-api@3', jobId: host.session.jobId, phase: 'measure', verb: 'progress' });
      expect(body.text.length).toBeLessThanOrEqual(120);
      expect(body.text).not.toMatch(/[\r\n\u0085\u2028\u2029]/u);
      expect(bytes).toBeLessThanOrEqual(1024);
    }
    expect(readFileSync(project)).toEqual(original);
    expect(host.session.status().generation).toBe(0);
  } finally {
    stop?.();
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);


test('#688 a writer that sends a milestone and then refuses leaves the project byte-identical; the seq lives in host state', async () => {
  const scratch = realpathSync(tempDir());
  const root = materializeFixture(join(scratch, 'project'));
  const stateDir = join(scratch, 'review');
  mkdirSync(stateDir, { mode: 0o700 });
  const project = join(root, 'project.json');
  let stop: (() => void) | undefined;
  try {
    const { host, calls } = await startProgressHost(root, stateDir);
    stop = () => host.stop();
    const before = readFileSync(project);
    const beforeRoot = snapshot(root);

    // advance sends its first milestone after the job gate, then refuses on a flag it checks late.
    const refused = await cli(root, ['advance', 'plan-approved', root, '--parts-check', 'synthetic-check.json']);
    expect(refused.exit).not.toBe(0);
    expect(refused.stderr.toString()).toContain('PROGRESS_OPTION_INVALID:');
    expect(readFileSync(project)).toEqual(before);
    expect(snapshot(root)).toEqual(beforeRoot);

    const seqFile = join(jobHostStateRoot(root), 'progress', `${jobHash(host.session.jobId)}.json`);
    expect(seqFile.startsWith(`${root}/`)).toBe(false);
    if (progressAdvertised()) {
      expect(calls.map(call => [call.body.seq, call.body.text])).toEqual([[1, 'Preparing to advance the project stage']]);
      expect(JSON.parse(readFileSync(seqFile, 'utf8'))).toBe(1);
      expect(lstatSync(seqFile).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(jobHostStateRoot(root), 'progress')).mode & 0o777).toBe(0o700);
    } else {
      expect(calls).toHaveLength(0);
      expect(existsSync(seqFile)).toBe(false);
    }
  } finally {
    stop?.();
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
