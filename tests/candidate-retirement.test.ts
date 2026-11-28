import { expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobCommentOnlyAct, JobOwnerHost } from '@rig-c/review/job-host';
import { attachCandidateHost, candidateHostBinding } from '../src/candidate-host.ts';
import { CANDIDATE_PROOF_FILE } from '../src/candidate-proof.ts';
import { candidateBatchPaths, candidateOptionPaths, CANDIDATE_STORAGE_PATH } from '../src/candidate-storage.ts';
import { checkProject } from '../src/check.ts';
import { currentRigFileBinding, sha256 } from '../src/current.ts';
import { objects } from '../src/direction.ts';
import { jobPrivateRoot } from '../src/job-outbox.ts';
import { fetchReviewAct } from '../src/review-act.ts';
import { CANDIDATE_QUESTION, CANDIDATE_SET_PATH } from './candidate-fixture.ts';
import {
  finalizeComment, NOW, openArgs, question, record, retirementProject, runCli, stageRecord, standingQuestion, startCli, TIMING, type TraceRow,
} from './candidate-retirement-fixture.ts';
import { obj } from './fixtures.ts';
import { treeDigest } from './helpers.ts';
import { sourceOnlyTest } from './source-only.ts';

const NOTES = ['Keep the baseline framing.', 'Compare this framing against the baseline.'];
const closeArgs = (root: string) => ['candidate', 'close', root, '--question', CANDIDATE_QUESTION];
const traceRows = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as TraceRow);
const storage = (root: string) => join(root, CANDIDATE_STORAGE_PATH);

async function startBatch(root: string, trace: string, count = 2, args = openArgs(root), mode: 'prepared' | 'hold-compose' = 'prepared') {
  const child = startCli(root, args, mode, trace);
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  const decoder = new TextDecoder();
  let stdout = '';
  try {
    while (stdout.split('\n').length <= count) {
      const chunk = await reader.read();
      if (chunk.done) throw Error(`candidate open exited ${await child.exited}: ${await stderr}`);
      stdout += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    child.kill();
    await Promise.all([child.exited, stderr]);
    throw error;
  } finally { reader.releaseLock(); }
  return {
    stdout,
    async stop() {
      if (child.exitCode === null) child.kill();
      await Promise.all([child.exited, stderr]);
    },
  };
}

async function candidateHosts(root: string) {
  const rows = candidateBatchPaths(storage(root)).flatMap(candidateOptionPaths);
  const attached: JobOwnerHost[] = [];
  try {
    for (const row of rows) {
      const binding = candidateHostBinding(row);
      if (!binding) throw Error('Expected a durable candidate host binding');
      const host = await attachCandidateHost(row, binding);
      if (!host) throw Error('Expected a live candidate host');
      attached.push(host);
    }
    return attached;
  } catch (error) {
    for (const host of attached) host.stop();
    throw error;
  }
}

async function collectComment(host: JobOwnerHost, text: string) {
  const act = await finalizeComment(host, text);
  const { jobId, fetchCapability } = host.session.writerGrant();
  const { bytes } = await fetchReviewAct({ actId: act.actId, jobId, fetchCapability, kind: 'comments', origin: host.origin });
  return { act, bytes, text };
}

function expectOrdinaryComment(root: string, evidence: { act: JobCommentOnlyAct; bytes?: string; text: string }) {
  const project = record(root);
  const receipts = objects(project.review_acts).filter(row => row.jobId === evidence.act.jobId && row.actId === evidence.act.actId);
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0]!;
  const bytes = evidence.bytes ?? JSON.stringify(evidence.act);
  expect(receipt).toMatchObject({ schema: 'rig-create/review-act@1', kind: 'comments', bytes, sha256: sha256(Buffer.from(bytes)) });
  const source = `review act ${evidence.act.jobId}/${evidence.act.actId}`;
  const comments = objects(project.comments).filter(row => row.source === source);
  expect(comments).toEqual([objects(project.comments)[Number(receipt.comment)]!]);
  const selector = evidence.act.source.selector;
  if (selector?.kind !== 'candidate') throw Error('Expected attested candidate selector');
  expect(comments[0]).toMatchObject({
    source, at: evidence.act.at, by: 'user', comments: [{ text: evidence.text }], record: null,
    subject: {
      kind: 'candidate', set_sha256: selector.setSha256, ask_id: selector.askId, option_id: selector.optionId,
      receipt_sha256: selector.receipt.sha256,
    },
  });
  const { model, direction } = evidence.act.source;
  if (!model || !direction) throw Error('Expected sealed playback files');
  expect(comments[0]?.saw).toEqual([model, direction].map(({ path, sha256 }) => ({ path, sha256 })));
}

function standingSnapshot(root: string, standing: JobOwnerHost) {
  return {
    url: standing.ownerUrl,
    declaration: record(root).review_job,
    status: standing.session.status(),
    files: treeDigest(jobPrivateRoot(root)),
  };
}

async function expectStanding(root: string, standing: JobOwnerHost, before: ReturnType<typeof standingSnapshot>) {
  expect(standingSnapshot(root, standing)).toEqual(before);
  const response = await fetch(standing.ownerUrl, { signal: AbortSignal.timeout(1000) });
  expect(response.status).toBe(200);
  await response.body?.cancel();
}

async function expectListenerClosed(origin: string, jobId: string) {
  let status: number | undefined;
  try {
    const response = await fetch(`${origin}/jobs/${jobId}/`, { signal: AbortSignal.timeout(1000) });
    status = response.status;
    await response.body?.cancel();
  } catch (error) {
    expect(error).toMatchObject({ code: 'ECONNREFUSED' });
    return;
  }
  expect(status).toBe(404);
}

function withoutComments(project: ReturnType<typeof record>) {
  const copy = structuredClone(project);
  delete copy.comments;
  delete copy.review_acts;
  return copy;
}

const actions = [
  ['pick', '#1171 candidate pick drains finalized comments and leaves the question host untouched'],
  ['set replacement', '#1171 candidate set replacement drains finalized comments and leaves the question host untouched'],
  ['close', '#1171 candidate close drains finalized comments and leaves the question host untouched'],
] as const;

for (const [action, name] of actions) {
  sourceOnlyTest(name, async () => {
    const f = retirementProject();
    const { root } = f;
    const standing = await standingQuestion(root);
    const hosts: JobOwnerHost[] = [];
    let batch: Awaited<ReturnType<typeof startBatch>> | undefined;
    try {
      const before = standingSnapshot(root, standing);
      const projectFile = join(root, 'project.json');
      const projectBytes = readFileSync(projectFile);
      const projectBefore = record(root);
      const setsBefore = treeDigest(join(root, 'evidence/interview'));
      const timingBefore = question(root, TIMING);
      batch = await startBatch(root, join(root, 'open-trace'));
      expect(readFileSync(projectFile)).toEqual(projectBytes);

      hosts.push(...await candidateHosts(root));
      expect(hosts).toHaveLength(2);
      const comments = [];
      for (const [i, host] of hosts.entries()) comments.push(await collectComment(host, NOTES[i]!));
      expect(comments.map(comment => comment.act.source.selector)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'candidate', askId: CANDIDATE_QUESTION, optionId: 'keep', setSha256: f.binding.sha256 }),
        expect.objectContaining({ kind: 'candidate', askId: CANDIDATE_QUESTION, optionId: 'alternative', setSha256: f.binding.sha256 }),
      ]));
      expect(readFileSync(projectFile)).toEqual(projectBytes);

      let args = closeArgs(root);
      let replacement: ReturnType<typeof f.write> | undefined;
      if (action === 'pick') {
        const words = join(root, 'owner-words.txt');
        writeFileSync(words, 'Use the baseline composition.');
        args = ['interview-answer', CANDIDATE_QUESTION, root, '--set', CANDIDATE_SET_PATH, '--sha256', f.binding.sha256,
          '--pick', `${CANDIDATE_QUESTION}=keep`, '--by', 'owner', '--owner-chat', words,
          '--said-at', new Date(NOW - 1000).toISOString(), '--relayed-by', 'synthetic-relay'];
      } else if (action === 'set replacement') {
        replacement = f.write('evidence/interview/replacement.json', { ...f.composition, id: 'replacement-composition' });
        setsBefore.set('replacement.json', replacement.sha256);
        args = ['interview-options', CANDIDATE_QUESTION, root, '--file', replacement.path];
      }

      const result = await runCli(root, args);
      expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: '' });
      expect(candidateBatchPaths(storage(root))).toEqual([]);
      for (const { origin, session } of hosts) await expectListenerClosed(origin, session.jobId);
      for (const comment of comments) expectOrdinaryComment(root, comment);
      expect(objects(record(root).comments)).toHaveLength(2);
      expect(objects(record(root).review_acts)).toHaveLength(2);

      const updated = question(root, CANDIDATE_QUESTION);
      if (action === 'pick') {
        expect(updated.pending_options).toBeUndefined();
        expect(updated.guide).toMatchObject({ owner_words: 'Use the baseline composition.',
          choice: { set: f.binding, picks: [{ ask: CANDIDATE_QUESTION, option_id: 'keep' }] } });
      } else if (action === 'set replacement') {
        expect(updated.pending_options).toEqual(replacement!);
        expect(updated.guide).toBeNull();
      } else {
        expect(withoutComments(record(root))).toEqual(projectBefore);
      }
      expect(question(root, TIMING)).toEqual(timingBefore);
      expect(treeDigest(join(root, 'evidence/interview'))).toEqual(setsBefore);
      await expectStanding(root, standing, before);

      const after = readFileSync(projectFile);
      expect(await runCli(root, closeArgs(root))).toEqual({ exit: 0, stdout: '', stderr: '' });
      const { jobId, actId } = comments[0]!.act;
      const replay = await runCli(root, ['comment', root, '--candidate-job', jobId, '--from-review', actId, '--json']);
      expect(replay.exit).toBe(0);
      expect(JSON.parse(replay.stdout)).toMatchObject({ replayed: true });
      expect(readFileSync(projectFile)).toEqual(after);
    } finally {
      for (const host of hosts) host.stop();
      await batch?.stop();
      standing.stop();
    }
  }, 12_000);
}

sourceOnlyTest('#1171 candidate close retries a stale generation and drains the late finalized comment', async () => {
  const { root } = retirementProject();
  const before = record(root);
  const batch = await startBatch(root, join(root, 'open-trace'));
  const hosts: JobOwnerHost[] = [];
  try {
    hosts.push(...await candidateHosts(root));
    const initiallyFinal = await collectComment(hosts[0]!, 'First finalized framing note.');
    const trace = join(root, 'close-trace');
    expect(await runCli(root, closeArgs(root), 'close-race', trace)).toEqual({ exit: 0, stdout: '', stderr: '' });
    for (const host of hosts) {
      const jobId = host.session.jobId;
      const route = traceRows(trace).filter(row => row.jobId === jobId);
      expect(route.map(row => [row.event, row.code])).toEqual([
        ['late-comment', undefined], ['close', 'JOB_GENERATION_STALE'], ['close', 'ok'],
      ]);
      expect(route[2]!.generation).toBe(route[1]!.generation! + 1);
      expectOrdinaryComment(root, { act: route[0]!.act!, text: 'Late finalized framing note.' });
      await expectListenerClosed(host.origin, jobId);
    }
    expectOrdinaryComment(root, initiallyFinal);
    expect(objects(record(root).comments)).toHaveLength(3);
    expect(objects(record(root).review_acts)).toHaveLength(3);
    expect(withoutComments(record(root))).toEqual(before);
    expect(candidateBatchPaths(storage(root))).toEqual([]);
  } finally {
    for (const host of hosts) host.stop();
    await batch.stop();
  }
}, 12_000);

const sourceChanges = [
  ['rig', 'model', '#1171 record rig retires candidates bound to the replaced model and retains finalized comments'],
  ['rig', 'rig-check', '#1171 record rig retires candidates when a sealed rig input changes with the same model'],
  ['motion', 'frames', '#1171 record motion retires candidates bound to the replaced frame set and retains finalized comments'],
] as const;

for (const [kind, change, name] of sourceChanges) {
  sourceOnlyTest(name, async () => {
    const f = retirementProject();
    const { root } = f;
    const standing = await standingQuestion(root);
    let batch: Awaited<ReturnType<typeof startBatch>> | undefined;
    const hosts: JobOwnerHost[] = [];
    try {
      const before = standingSnapshot(root, standing);
      const projectBefore = record(root);
      const model = 'check/build/skeleton.model.json';
      const pending = question(root, CANDIDATE_QUESTION);
      batch = await startBatch(root, join(root, 'open-trace'));
      hosts.push(...await candidateHosts(root));
      const comments = [];
      for (const [i, host] of hosts.entries()) comments.push(await collectComment(host, NOTES[i]!));
      expect(comments).toHaveLength(2);

      const args = stageRecord(root, kind, change);
      const stagedTrace = join(root, 'staged-trace');
      expect(await runCli(root, openArgs(root), 'prepared', stagedTrace)).toEqual({ exit: 0, stdout: batch.stdout, stderr: '' });
      expect(existsSync(stagedTrace)).toBe(false);
      expect(record(root)).toEqual(projectBefore);

      if (kind === 'rig') {
        const staged = treeDigest(join(root, 'outputs/rig.next'));
        expect(await runCli(root, args)).toEqual({ exit: 1, stdout: '', stderr: expect.stringContaining('INTERVIEW_OPTIONS_STALE') });
        expect(record(root)).toEqual(projectBefore);
        expect(treeDigest(join(root, 'outputs/rig.next'))).toEqual(staged);
        expect(candidateBatchPaths(storage(root))).toHaveLength(1);

        // Exercise the successful writer with the stale context already carried.
        // The pending option binding and the published candidate proofs stay byte-identical.
        const carried = structuredClone(projectBefore);
        obj(obj(carried.current).rig).at = new Date(NOW - 1).toISOString();
        f.write('project.json', carried);
        expect(checkProject(root, undefined, { now: NOW }).refusals
          .filter(finding => finding.code === 'INTERVIEW_OPTIONS_STALE')).toHaveLength(2);
      }
      const result = await runCli(root, args);
      expect(result.exit).toBe(0);
      expect(result.stderr).toContain('PROJECT_NOT_IN_GIT');
      expect(result.stderr).not.toContain('JOB_WRITE_BUSY');
      const projectAfter = record(root);
      const output = obj(projectAfter.current)[kind]!;
      expect(output).toEqual(JSON.parse(result.stdout));
      expect(obj(output).files_sha256).not.toBe(obj(obj(projectBefore.current)[kind]).files_sha256);
      const beforeModel = currentRigFileBinding(projectBefore, model);
      const afterModel = currentRigFileBinding(projectAfter, model);
      if (change === 'model') expect(afterModel?.sha256).not.toBe(beforeModel?.sha256);
      else expect(afterModel).toEqual(beforeModel);
      expect(question(root, CANDIDATE_QUESTION)).toEqual(pending);
      expect(candidateBatchPaths(storage(root))).toEqual([]);
      for (const host of hosts) await expectListenerClosed(host.origin, host.session.jobId);
      for (const comment of comments) expectOrdinaryComment(root, comment);
      expect(objects(projectAfter.comments)).toHaveLength(2);
      expect(objects(projectAfter.review_acts)).toHaveLength(2);
      await expectStanding(root, standing, before);
      if (kind === 'rig') {
        const reopen = await runCli(root, openArgs(root), 'prepared', join(root, 'stale-reopen-trace'));
        expect(reopen).toEqual({ exit: 1, stdout: '', stderr: expect.stringContaining('INTERVIEW_OPTIONS_STALE') });
      } else {
        const fresh = await startBatch(root, join(root, 'fresh-motion-trace'));
        try {
          expect(fresh.stdout).not.toEqual(batch.stdout);
          const rows = candidateBatchPaths(storage(root)).flatMap(candidateOptionPaths);
          expect(rows).toHaveLength(2);
          for (const row of rows) expect(JSON.parse(readFileSync(join(row, CANDIDATE_PROOF_FILE), 'utf8')))
            .toMatchObject({ motionSha256: obj(output).files_sha256 });
        } finally { await fresh.stop(); }
      }
    } finally {
      for (const host of hosts) host.stop();
      await batch?.stop();
      standing.stop();
    }
  }, 16_000);
}

sourceOnlyTest('#1171 identical rig and motion re-records preserve live candidate links and finalized comments', async () => {
  const { root } = retirementProject();
  const batch = await startBatch(root, join(root, 'open-trace'));
  const hosts: JobOwnerHost[] = [];
  try {
    const [path] = candidateBatchPaths(storage(root));
    expect(traceRows(join(root, 'open-trace')).filter(row => row.event === 'opened')).toHaveLength(2);
    hosts.push(...await candidateHosts(root));
    const comment = await collectComment(hosts[0]!, NOTES[0]!);
    const digest = treeDigest(path!);
    for (const kind of ['rig', 'motion'] as const) {
      const before = obj(obj(record(root).current)[kind]);
      // Live post options also bind the rig record's provenance, so replay it exactly.
      const by = kind === 'rig' ? String(before.built_by) : 'synthetic-rerecord';
      const now = kind === 'rig' ? Date.parse(String(before.at)) : NOW;
      const result = await runCli(root, stageRecord(root, kind, undefined, by), undefined, undefined, now);
      expect(result.stderr).toContain('PROJECT_NOT_IN_GIT');
      expect(result.exit).toBe(0);
      const output = JSON.parse(result.stdout);
      if (kind === 'rig') expect(output).toEqual(before);
      else expect(output).toMatchObject({ files_sha256: before.files_sha256, built_by: by });
      expect(candidateBatchPaths(storage(root))).toEqual([path]);
      expect(treeDigest(path!)).toEqual(digest);
      expect(record(root).review_acts).toBeUndefined();
    }
    const trace = join(root, 'reuse-trace');
    expect(await runCli(root, openArgs(root), 'prepared', trace)).toEqual({ exit: 0, stdout: batch.stdout, stderr: '' });
    expect(existsSync(trace)).toBe(false);
    expect(await runCli(root, closeArgs(root))).toEqual({ exit: 0, stdout: '', stderr: '' });
    expectOrdinaryComment(root, comment);
  } finally {
    for (const host of hosts) host.stop();
    await batch.stop();
  }
}, 12_000);

sourceOnlyTest('#1171 record motion refuses during candidate compose and retry drains both live batches', async () => {
  const f = retirementProject(true);
  const { root } = f;
  const standing = await standingQuestion(root);
  let first: Awaited<ReturnType<typeof startBatch>> | undefined;
  let waiting: Promise<Awaited<ReturnType<typeof startBatch>> | undefined> | undefined;
  let openError: unknown;
  const trace = join(root, 'held-trace');
  const hosts: JobOwnerHost[] = [];
  try {
    const before = standingSnapshot(root, standing);
    first = await startBatch(root, join(root, 'open-trace'));
    const args = stageRecord(root, 'motion', 'frames');
    const original = readFileSync(join(root, 'project.json'));
    const current = treeDigest(join(root, 'outputs/motion'));
    const staged = treeDigest(join(root, 'outputs/motion.next'));
    waiting = startBatch(root, trace, 1, openArgs(root, TIMING, String(f.timing.id)), 'hold-compose')
      .catch(error => { openError = error; return undefined; });
    const deadline = performance.now() + 4000;
    while (!existsSync(trace) && !openError && performance.now() < deadline) await Bun.sleep(20);
    expect(traceRows(trace).map(row => row.event)).toEqual(['compose']);

    expect(await runCli(root, args)).toEqual({ exit: 1, stdout: '', stderr: expect.stringContaining('JOB_WRITE_BUSY') });
    expect(readFileSync(join(root, 'project.json'))).toEqual(original);
    expect(treeDigest(join(root, 'outputs/motion'))).toEqual(current);
    expect(treeDigest(join(root, 'outputs/motion.next'))).toEqual(staged);

    writeFileSync(`${trace}.release`, '');
    if (!(await waiting)) throw openError;
    hosts.push(...await candidateHosts(root));
    expect(hosts).toHaveLength(3);
    const comments = [];
    for (const host of hosts) comments.push(await collectComment(host, NOTES[0]!));
    const result = await runCli(root, args);
    expect(result.exit).toBe(0);
    expect(result.stderr).toContain('PROJECT_NOT_IN_GIT');
    expect(result.stderr).not.toContain('JOB_WRITE_BUSY');
    expect(candidateBatchPaths(storage(root))).toEqual([]);
    for (const host of hosts) await expectListenerClosed(host.origin, host.session.jobId);
    for (const comment of comments) expectOrdinaryComment(root, comment);
    expect(objects(record(root).review_acts)).toHaveLength(3);
    await expectStanding(root, standing, before);
  } finally {
    for (const host of hosts) host.stop();
    writeFileSync(`${trace}.release`, '');
    await (await waiting)?.stop();
    await first?.stop();
    standing.stop();
  }
}, 12_000);

sourceOnlyTest('#1171 candidate open reuses the same links and a partial publish failure exposes none', async () => {
  const f = retirementProject(true);
  const { root } = f;
  const standing = await standingQuestion(root);
  const batches: Awaited<ReturnType<typeof startBatch>>[] = [];
  try {
    const before = standingSnapshot(root, standing);
    const projectBytes = readFileSync(join(root, 'project.json'));
    const retained = await startBatch(root, join(root, 'timing-trace'), 1, openArgs(root, TIMING, String(f.timing.id)));
    batches.push(retained);
    const [retainedBatch] = candidateBatchPaths(storage(root));
    const retainedDigest = treeDigest(retainedBatch!);
    const [retainedJob] = traceRows(join(root, 'timing-trace')).filter(row => row.event === 'opened');

    const failedTrace = join(root, 'failed-trace');
    const failed = await runCli(root, openArgs(root), 'reject-second', failedTrace);
    expect(failed).toMatchObject({ exit: 1, stdout: '', stderr: expect.stringContaining('JOB_CANDIDATE_RECEIPT_MISMATCH') });
    const effects = traceRows(failedTrace);
    const opened = effects.filter(row => row.event === 'opened');
    expect(opened).toHaveLength(2);
    const [first, second] = opened.map(row => row.jobId);
    expect(new Set([first, second, retainedJob!.jobId, standing.session.jobId]).size).toBe(4);
    expect(effects.filter(row => row.event === 'publish').map(row => [row.jobId, row.code])).toEqual([
      [first, 'ok'], [second, 'JOB_CANDIDATE_RECEIPT_MISMATCH'],
    ]);
    expect(effects.filter(row => row.event === 'close').map(row => [row.jobId, row.code]).sort()).toEqual([
      [first, 'ok'], [second, 'ok'],
    ].sort());
    expect(candidateBatchPaths(storage(root))).toEqual([retainedBatch]);
    expect(treeDigest(retainedBatch!)).toEqual(retainedDigest);
    for (const row of opened) await expectListenerClosed(row.origin!, row.jobId!);
    const live = await fetch(new URL(retained.stdout.trim().split(' ').at(-1)!), { signal: AbortSignal.timeout(1000) });
    expect(live.status).toBe(200);
    await live.body?.cancel();
    expect(readFileSync(join(root, 'project.json'))).toEqual(projectBytes);
    await expectStanding(root, standing, before);

    const trace = join(root, 'fresh-trace');
    const fresh = await startBatch(root, trace);
    batches.push(fresh);
    expect(traceRows(trace).filter(row => row.event === 'publish').map(row => row.code)).toEqual(['ok', 'ok']);
    const publicationRows = candidateBatchPaths(storage(root)).find(path => path !== retainedBatch)!;
    const digest = treeDigest(publicationRows);
    const replayTrace = join(root, 'replay-trace');
    expect(await runCli(root, openArgs(root), 'prepared', replayTrace)).toEqual({ exit: 0, stdout: fresh.stdout, stderr: '' });
    expect(existsSync(replayTrace)).toBe(false);
    expect(treeDigest(publicationRows)).toEqual(digest);
    expect(readFileSync(join(root, 'project.json'))).toEqual(projectBytes);
    await expectStanding(root, standing, before);
  } finally {
    for (const batch of batches.reverse()) await batch.stop();
    standing.stop();
  }
}, 12_000);
