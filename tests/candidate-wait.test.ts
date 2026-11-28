import { expect } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobOwnerHost } from '@rig-c/review/job-host';
import { closeCandidateHost, openCandidateHost } from '../src/candidate-host.ts';
import { candidateBatchPath, candidateStorage } from '../src/candidate-storage.ts';
import { agentCall, readHostActsAndAsks } from '../src/job-acts.ts';
import { readWriterBinding, writePrivateJson } from '../src/job-outbox.ts';
import { SOURCE_CONDITION_FLAG } from '../src/job-writer.ts';
import { candidateFixture, CANDIDATE_QUESTION, CANDIDATE_SET, literalDigest } from './candidate-fixture.ts';
import { CLI } from './helpers.ts';
import { sourceOnlyTest } from './source-only.ts';

async function openCandidates(fixture: ReturnType<typeof candidateFixture>, options: string[]) {
  const { root } = fixture;
  const set = fixture.save();
  const batch = candidateBatchPath(candidateStorage(root), {
    question: CANDIDATE_QUESTION, setId: CANDIDATE_SET, setSha256: set.sha256,
  });
  const candidates: { row: string; host: JobOwnerHost }[] = [];
  try {
    for (const optionId of options) {
      const identity = { setSha256: set.sha256, askId: CANDIDATE_QUESTION, optionId };
      const row = join(batch, `option-${literalDigest(JSON.stringify([identity.askId, optionId]))}`);
      const pkg = join(row, 'package');
      mkdirSync(pkg, { recursive: true, mode: 0o700 });
      const modelPath = 'skeleton.model.json';
      const build = join(import.meta.dir, 'fixtures/rig-registration/build');
      for (const file of [modelPath, 'rectangle.png']) copyFileSync(join(build, file), join(pkg, file));
      const model = { path: modelPath, sha256: literalDigest(readFileSync(join(pkg, modelPath))) };
      const seal = (path: string, data: object) => {
        const bytes = JSON.stringify(data);
        writeFileSync(join(pkg, path), bytes);
        return { path, sha256: literalDigest(bytes) };
      };
      const take = seal('take.json', {
        schema: 'rig-create/candidate-take@1', clip: 'idle', duration: 0.25, loop: true, model, sceneReport: null,
      });
      const receipt = seal('candidate.json', {
        schema: 'rig-create/candidate-preview@1', ...identity, camera: 'unkeyed', model, take, sceneReport: null,
      });
      seal('review.json', {
        schema: 'rig-review/1', id: 'candidate', revision: receipt.sha256, title: 'Synthetic candidate',
        model: model.path, direction: take.path,
      });
      const selector = { kind: 'candidate', ...identity, receipt };
      const host = await openCandidateHost(row, { id: 'synthetic-owner', role: 'owner' });
      candidates.push({ row, host });
      const published = await agentCall(host, {
        verb: 'publish', expectedGeneration: 0, idempotencyKey: 'synthetic-candidate',
        freeze: { kind: 'producer-held', holdId: 'test', record: null }, result: { path: 'review.json', selector },
      });
      expect(published.ok).toBe(true);
      const { publicationId, source: { sourceHash } } = host.session.status().publication!;
      writePrivateJson(join(row, 'link.json'), { url: host.ownerUrl, selector, publicationId, sourceHash });
    }
    writePrivateJson(join(batch, 'ready.json'), { count: candidates.length });
    return candidates;
  } catch (error) {
    for (const { host } of candidates) host.stop();
    throw error;
  }
}

async function finalizeComment(host: JobOwnerHost) {
  const { jobId } = host.session;
  const { publicationId, source: { sourceHash } } = host.session.status().publication!;
  const pageId = 'candidate-page';
  const post = (path: string, body: object) => new Request(`${host.origin}/jobs/${jobId}/${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Origin: host.origin, 'Content-Type': 'application/json', 'X-Review-Capability': host.session.hostCredentials().ui },
  });
  const displayed = await host.ports.ackDisplayed(jobId, post('ui/displayed', { publicationId, pageId, sourceHash }));
  if (!displayed.ok) throw Error(displayed.error.code);
  const saved = await host.ports.commitUIAct(jobId, post('ui/acts', {
    kind: 'comments', publicationId, pageId, displayedNonce: displayed.value.displayedNonce,
    expectedGeneration: host.session.status().generation, submissionId: 'candidate-comment',
    value: { comments: [{ text: 'Keep the synthetic framing.' }] },
  }));
  if (!saved.ok) throw Error(saved.error.code);
  return saved.value;
}

function runCli(root: string, args: string[], preload?: string) {
  const child = Bun.spawn([process.execPath, SOURCE_CONDITION_FLAG, CLI, ...args], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
    timeout: 12_000, killSignal: 'SIGTERM',
    ...(preload ? { env: { ...process.env, BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${preload}` } } : {}),
  });
  const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    .then(([exit, stdout, stderr]) => ({ exit, stdout, stderr }));
  return { child, result };
}

interface WaitEvent {
  jobId: string;
  after: string | null;
  pid: number;
  kind: 'started' | 'act' | 'closed' | 'timeout' | 'aborted' | 'refused';
  elapsed?: number;
}

function startWait(root: string, timeoutMs: number) {
  const trace = join(root, 'candidate-wait.jsonl');
  const preload = join(root, 'observe-candidate-wait.ts');
  // Observe the actual pinned wait in the CLI's private runtime, leaving its requests and results unchanged.
  writeFileSync(preload, `
    import { appendFileSync } from 'node:fs';
    import { mock } from 'bun:test';
    const modulePath = ${JSON.stringify(import.meta.resolve('@rig-c/review/job-host'))};
    if (process.argv[1]?.endsWith('/job-runtime.ts')) {
      const review = await import(modulePath);
      const wait = review.waitForJobAct;
      mock.module(modulePath, () => ({ ...review, async waitForJobAct(host, options) {
        const details = { pid: process.pid, jobId: host.session.jobId, after: options.after };
        const write = (kind, elapsed) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ ...details, kind, elapsed }) + '\\n');
        const started = performance.now();
        write('started');
        try {
          const result = await wait(host, options);
          write(result.kind, performance.now() - started);
          return result;
        } catch (error) {
          write(options.signal?.aborted ? 'aborted' : 'refused');
          throw error;
        }
      } }));
    }
  `);
  const run = runCli(root, ['job', 'acts', root, '--wait', '--timeout-ms', String(timeoutMs), '--json'], preload);
  const events = (): WaitEvent[] => existsSync(trace)
    ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as WaitEvent)
    : [];
  const waitUntil = async (ready: (rows: WaitEvent[]) => boolean) => {
    const deadline = performance.now() + 8_000;
    while (!ready(events())) {
      if (run.child.exitCode !== null) throw Error(`job acts exited before the expected Review wait event: ${JSON.stringify(await run.result)}`);
      if (performance.now() >= deadline) throw Error('Expected Review wait event was not observed');
      await Bun.sleep(15);
    }
  };
  return { ...run, events, waitUntil };
}

function expectRuntimeExited(events: WaitEvent[]) {
  const pid = events[0]?.pid;
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}

sourceOnlyTest('#1171 job acts waits for a late finalized comment on a candidate-only job', async () => {
  const fixture = candidateFixture();
  const { root } = fixture;
  const candidates = await openCandidates(fixture, ['keep', 'alternative', 'auto']);
  const target = candidates[0]!.host;
  const closed = candidates[1]!.host;
  const idle = candidates[2]!.host;
  const waiting = startWait(root, 30_000);
  try {
    const before = readFileSync(join(root, 'project.json'));
    expect(readWriterBinding(root)).toBeNull();
    await waiting.waitUntil(rows => rows.filter(row => row.kind === 'started').length === candidates.length);
    for (const { host } of candidates) {
      const initial = await readHostActsAndAsks(host);
      expect(initial.acts).toEqual([]);
      expect(initial.cursor).not.toBeNull();
      expect(waiting.events()).toContainEqual(expect.objectContaining({
        jobId: host.session.jobId, after: initial.cursor, kind: 'started',
      }));
    }
    await closeCandidateHost(closed, async acts => expect(acts).toEqual([]));
    await waiting.waitUntil(rows => rows.some(row => row.jobId === closed.session.jobId && row.kind === 'closed'));
    closed.stop();
    rmSync(candidates[1]!.row, { recursive: true });

    const act = await finalizeComment(target);
    await waiting.waitUntil(rows => rows.some(row => row.jobId === idle.session.jobId && row.kind === 'aborted'));
    const { exit, stdout, stderr } = await waiting.result;
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    const args = ['comment', root, '--candidate-job', act.jobId, '--from-review', act.actId];
    expect(JSON.parse(stdout)).toMatchObject({ acts: [expect.objectContaining({
      actId: act.actId, publicationId: act.publicationId, kind: 'comments', args,
    })], asked: 0, ingested: [] });
    expectRuntimeExited(waiting.events());
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    expect(readWriterBinding(root)).toBeNull();

    const ready = await runCli(root, ['job', 'acts', root, '--wait', '--timeout-ms', '1', '--json']).result;
    expect({ exit: ready.exit, stderr: ready.stderr }).toEqual({ exit: 0, stderr: '' });
    expect(JSON.parse(ready.stdout)).toEqual(JSON.parse(stdout));

    const imported = await runCli(root, [...args, '--json']).result;
    expect({ exit: imported.exit, stderr: imported.stderr }).toEqual({ exit: 0, stderr: '' });
    const listed = await runCli(root, ['job', 'acts', root, '--json']).result;
    expect({ exit: listed.exit, stderr: listed.stderr }).toEqual({ exit: 0, stderr: '' });
    expect(JSON.parse(listed.stdout).acts).toEqual([]);
  } finally {
    if (waiting.child.exitCode === null) waiting.child.kill('SIGTERM');
    await waiting.result;
    for (const { host } of candidates) host.stop();
  }
}, 20_000);

sourceOnlyTest('#1171 job acts times out on idle candidate-only jobs without leaving a waiter', async () => {
  const fixture = candidateFixture();
  const { root } = fixture;
  const candidates = await openCandidates(fixture, ['keep']);
  const host = candidates[0]!.host;
  const waiting = startWait(root, 250);
  try {
    expect(readWriterBinding(root)).toBeNull();
    const { exit, stdout, stderr } = await waiting.result;
    expect(exit).toBe(3);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^JOB_NEXT_TIMEOUT: /);
    const events = waiting.events();
    expect(events.map(event => event.kind)).toEqual(['started', 'timeout']);
    expect(events[1]?.elapsed).toBeGreaterThanOrEqual(240);
    expectRuntimeExited(events);
    expect(host.session.status().status).toBe('active');
  } finally {
    if (waiting.child.exitCode === null) waiting.child.kill('SIGTERM');
    await waiting.result;
    host.stop();
  }
}, 15_000);
