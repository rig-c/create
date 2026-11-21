import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startJobHost } from '@rig-c/review/job-host';
import reviewPackage from '@rig-c/review/package.json';
import { currentJobIdentity, partsEnumerator, readPublished, readRecordPublished } from '../src/job-publication.ts';
import { JOB_BINDING_FILE, jobPrivateRoot, writePrivateJson } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { TEST_NOW } from './clock.ts';
import { materializeFixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { isSourceLinkedRun } from './source-only.ts';

async function check(root: string) {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'cli-at.ts'),
    new Date(TEST_NOW).toISOString(), 'interview', '--check', root, '--json'], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(),
  ]);
  return { exit, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

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

test('#688 filled project CLI progress uses the live Review API and keeps its command result', async () => {
  const scratch = realpathSync(tempDir());
  const root = materializeFixture(join(scratch, 'project'));
  const stateDir = join(scratch, 'review');
  mkdirSync(stateDir, { mode: 0o700 });
  const identity = currentJobIdentity({ root, stateDir, fingerprint: 'synthetic-progress',
    reviewer: { id: 'synthetic-owner', role: 'owner' }, publicationMode: 'record-and-package' }, root);
  const project = join(root, 'project.json');
  const original = readFileSync(project);
  const binding = join(root, JOB_BINDING_FILE);
  const calls: { body: ProgressRequest; bytes: number; authorized: boolean; reply: unknown }[] = [];
  const discovered: unknown[] = [];
  let failPosts = false;
  let agent = '';
  let stop: (() => void) | undefined;
  try {
    const baseline = await check(root);
    expect(baseline.exit).toBe(0);
    expect(baseline.stderr.byteLength).toBe(0);
    expect(JSON.parse(baseline.stdout.toString())).toMatchObject({ ok: true, refusals: [], warnings: [] });
    expect(existsSync(jobPrivateRoot(root))).toBe(false);

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
    stop = () => host.stop();
    agent = host.session.hostCredentials().agent;
    expect(grants).toHaveLength(1);
    expect(host.attachment?.listenerIncarnation).toBeDefined();
    writePrivateJson(binding, { schema: 'rig-create/job-binding@1', identity, ...grants[0],
      listenerIncarnation: host.attachment!.listenerIncarnation }, true);

    expect(await check(root)).toEqual(baseline);
    if (isSourceLinkedRun() || Bun.semver.satisfies(reviewPackage.version, '>=4.10.0')) {
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
    failPosts = true;
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
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
