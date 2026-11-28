import { expect, test } from 'bun:test';
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJobHost, type JobOwnerHost } from '@rig-c/review/job-host';
import { agentCall, readHostActsAndAsks } from '../src/job-acts.ts';
import { openCreateJob } from '../src/job-host.ts';
import { acknowledgePublication, enqueuePublication, jobHash, pendingPublications, readWriterBinding, reconcilePublication } from '../src/job-outbox.ts';
import { prepareLiveManifest, readPublished } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, obj, waypoint } from './fixtures.ts';
import { seedStoredReviewVerdictAct } from './historical-review-fixture.ts';
import { tempDir } from './helpers.ts';
import { seedRetainedRigVersion } from './numbered-seed.ts';

const checkpoint = join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review');
const remesh = join(import.meta.dir, '../templates/example-remesh');
const reviewer = { id: 'synthetic-owner', role: 'owner' } as const;
const comment = '  Increase the idle motion slightly.\r\n';
const approval = 'Approve the updated motion guide.\n';
const expectedRefusals = [
  { code: 'SIGNOFF_ANSWERS_STALE', path: 'signoffs[4].answer_hashes[motion]' },
];

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
}

async function commitOwnerAct(host: JobOwnerHost, kind: 'review-verdict', value: object, picture?: Buffer) {
  const { publication, generation } = host.session.status();
  if (!publication) throw Error('Review has no publication');
  const { publicationId, instanceKey, source: { sourceHash } } = publication;
  const { head, asks } = await readHostActsAndAsks(host);
  expect(head).toBe(publicationId);
  const subject = { kind, stage: 'rig-review' } as const;
  const matches = asks.filter(ask => ask.subject.kind === subject.kind && ask.subject.stage === subject.stage);
  expect(matches.map(ask => ask.subject)).toEqual([subject]);
  const { askId } = matches[0]!;
  const pageId = crypto.randomUUID();
  const ui = (route: string, body: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, {
    method: 'POST', headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui,
      'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const displayed = await host.ports.ackDisplayed(host.session.jobId, ui('displayed', { publicationId, pageId, sourceHash }));
  if (!displayed.ok) throw Error(displayed.error.code);
  const act = await host.ports.commitUIAct(host.session.jobId, ui('acts', {
    publicationId, askId, pageId, displayedNonce: displayed.value.displayedNonce,
    expectedGeneration: generation, submissionId: crypto.randomUUID(), kind, value,
    ...(picture ? { capture: { png: `data:image/png;base64,${picture.toString('base64')}`, width: 128, height: 128,
      camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
      binding: { publicationId, instanceKey, sourceHash, pageId, askId, drawGeneration: 1, playerGeneration: 0 } } } : {}),
  }));
  if (!act.ok) throw Error(act.error.code);
  return act.value;
}

async function routeReviewComment() {
  // The generated split-order checkpoint ends just before the first rig verdict.
  const root = join(realpathSync(tempDir('create-plan-resign-')), 'project');
  cpSync(checkpoint, root, { recursive: true });
  const file = join(root, 'project.json');
  const load = () => readJson(file);
  const bytes = () => readFileSync(file);
  const planArgs = ['job', 'open', root, '--reviewer', reviewer.id, '--role', reviewer.role, '--plan'];
  let now = Date.now();
  const afterAct = (at: string) => { now = Math.max(now, Date.parse(at), Date.now()) + 1_000; };
  const spawn = (...argv: string[]) => Bun.spawn([
    process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'cli-at.ts'), new Date(now).toISOString(), ...argv,
  ], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 12_000 });
  const cli = async (...argv: string[]) => {
    const child = spawn(...argv);
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr };
  };
  const success = async (...argv: string[]) => {
    const result = await cli(...argv);
    expect(result.exit, `${argv.join(' ')}\n${result.stderr}`).toBe(0);
    return result.stdout;
  };
  const inspect = async (exit: number) => {
    const checked = await cli('interview', '--check', root, '--json');
    expect(checked.exit, checked.stderr).toBe(exit);
    return JSON.parse(checked.stdout) as JsonObject;
  };
  const additions = () => arr(obj(waypoint(load(), 'motion').guide).additions ?? []);
  const beforeReview = await inspect(0);
  expect(beforeReview.effective_stage).toBe('rig-review');
  expect(additions()).toEqual([]);

  const historicalSubject = { kind: 'review-verdict' as const, stage: 'rig-review' as const };
  const host = await openCreateJob(root, reviewer, now, options => startJobHost({
    ...options,
    readPublished: async input => ({ ...await readPublished(input), subjects: [historicalSubject] }),
  }));
  let verdictSource: string;
  try {
    const manifest = prepareLiveManifest(root, load(), 1);
    const result = { path: manifest, selector: { kind: 'rig' as const, version: 1 } };
    const binding = readWriterBinding(root)!;
    const entry = enqueuePublication(root, binding, result);
    const pubReqId = crypto.randomUUID();
    await reconcilePublication(root, entry, async pending => {
      const pubReply = await agentCall(host, {
        schema: binding.identity.apiSchema,
        verb: 'publish',
        requestId: pubReqId,
        idempotencyKey: pubReqId,
        expectedGeneration: host.session.status().generation,
        result,
        freeze: { kind: 'producer-held', holdId: pending.id, record: { path: 'project.json', sha256: pending.recordHash } },
      });
      expect(pubReply.ok, JSON.stringify(pubReply.error)).toBe(true);
      const pub = host.session.status().publication!;
      acknowledgePublication(pending, pub.publicationId, pub.generation, pubReqId, [historicalSubject]);
    });
    // Recreate a historical verdict ask on the numbered view through Review's manual API.
    const { publication, generation } = host.session.status();
    const reply = await agentCall(host, {
      schema: 'rig-review/job-api@2',
      verb: 'ask',
      publicationId: publication!.publicationId,
      expectedGeneration: generation,
      idempotencyKey: crypto.randomUUID(),
      subject: historicalSubject,
    });
    expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
    const act = await commitOwnerAct(host, 'review-verdict', {
      stage: 'rig-review', verdict: 'changes-requested', words: '', general: [comment],
    }, readFileSync(join(root, 'evidence/setup.png')));
    afterAct(act.at);
    const retired = await cli('review', '1', root, '--from-review', act.actId, '--json');
    expect(retired.exit).toBe(2);
    expect(retired.stderr).toContain('NUMBERED_WRITER_REMOVED');
    const ingested = seedStoredReviewVerdictAct(root, 1, host.session.readActExport(act.actId, false).toString('utf8'), { now });
    verdictSource = `review act ${act.jobId}/${act.actId}`;
    expect(ingested.verdict).toMatchObject({ verdict: 'bounced', source: verdictSource, verbatim: `[general]\n${comment}` });
    expect(additions()).toEqual([]);

    const beforeClose = bytes();
    expect(await success('job', 'close', root)).toBe('job: closed\n');
    expect(readWriterBinding(root)).toBeNull();
    expect(bytes()).toEqual(beforeClose);
    afterAct(act.at);
    const current = load();
    const receipt = arr(current.review_acts).map(obj).find(row => row.actId === act.actId)!;
    const routedAt = new Date(now).toISOString();
    receipt.feedback_route = { by: 'agent', at: routedAt, item: 'motion', comment_index: 0, verbatim: comment };
    const motionGuide = obj(waypoint(current, 'motion').guide);
    motionGuide.additions = [
      ...arr(motionGuide.additions ?? []),
      { by: 'user', at: routedAt, verbatim: comment, value: null, source: 'polish feedback, v1', review_act: verdictSource },
    ];
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  } finally {
    host.stop();
  }
  expect(additions()).toEqual([{ by: 'user', at: new Date(now).toISOString(), verbatim: comment, value: null,
    source: 'polish feedback, v1', review_act: verdictSource }]);
  const checked = await inspect(1);
  console.info(`#820 step 3: interview --check exit 1; effective stage ${String(checked.effective_stage)}; motion addition value ${JSON.stringify(obj(additions()[0]).value)}; all refusals ${JSON.stringify(checked.refusals)}`);
  expect(checked.effective_stage).toBe('rig-review');
  expect(arr(checked.refusals).map(row => ({ code: obj(row).code, path: obj(row).path }))).toEqual(expectedRefusals);
  expect(checked.holes ?? []).toEqual([]);
  return { root, file, load, bytes, planArgs, spawn, cli, success, inspect, additions, afterAct, now: () => now };
}

test('#820 a routed motion comment can be re-signed in Review and cited by the next rig version', async () => {
  const f = await routeReviewComment();
  const addition = f.additions();
  const opening = f.spawn(...f.planArgs);
  const stderr = new Response(opening.stderr).text();
  try {
    let stdout = '';
    const published = /\njob: plan published \(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)\n/;
    const decoder = new TextDecoder();
    const reader = opening.stdout.getReader();
    try {
      while (!published.test(stdout)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stdout += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    if (!published.test(stdout)) {
      throw Error(`step 4 job open --plan exit ${await opening.exited}\n${await stderr}`);
    }
    const host = await openCreateJob(f.root, reviewer, f.now(), undefined, true);
    try {
      expect(host.reused).toBe(true);
      expect(pendingPublications(f.root)).toEqual([]);
      expect(host.session.status().publication?.source).toMatchObject({ projectHash: jobHash(f.bytes()), subjects: [] });
      expect(f.additions()).toEqual(addition);

      const wordsFile = join(f.root, 'resign-approval.txt');
      writeFileSync(wordsFile, approval);
      const saidAt = new Date(f.now() - 500).toISOString();
      await f.success('signoff', 'rigging-interview', f.root, '--by', reviewer.id,
        '--owner-chat', wordsFile, '--said-at', saidAt, '--relayed-by', 'synthetic-operator');
      expect(arr(f.load().signoffs).at(-1)).toMatchObject({ stage: 'rigging-interview', by: reviewer.id, verbatim: approval,
        source: 'owner chat, relayed', answer_hashes: { motion: expect.any(String) } });
      expect((await f.inspect(0)).refusals).toEqual([]);
      expect(f.additions()).toEqual(addition);

      const next = JSON.parse(await f.success('next', f.root, '--json')) as JsonObject;
      expect(next.refusals).toEqual([]);
      expect(next.moves).toContainEqual(expect.objectContaining({ role: 'agent', field: 'versions',
        command: expect.stringMatching(/^rig-create rig-version 2 .* --answers 1:0$/) }));
      expect(f.additions()).toEqual(addition);

      // Reuse a frozen producer build with stronger motion and byte-identical assembled parts.
      const producer = 'rebuild';
      cpSync(join(remesh, 'outputs/v3'), join(f.root, producer), { recursive: true });
      const evidence = `${producer}/registration`;
      cpSync(join(remesh, 'evidence/v3/registration'), join(f.root, evidence), { recursive: true });
      const citations = readJson(join(f.root, evidence, 'citations.json'));
      const motionCitation = { entry: 'motion', guide: 'motion', quote: comment };
      citations.motion = [...arr(citations.motion), motionCitation];
      writeFileSync(join(f.root, evidence, 'citations.json'), JSON.stringify(citations));
      const registered = JSON.parse(seedRetainedRigVersion(['2', f.root,
        '--parts', `${producer}/out`, '--rig', `${producer}/out/rig`, '--build', `${producer}/out/check/build`, '--idle', `${producer}/idle`,
        '--config', `${evidence}/config-source.json`, '--path-adapter', `${evidence}/path-adapter.json`,
        '--compile-report', `${evidence}/compile-report.json`, '--toolchain-lock', `${evidence}/package-lock.json`,
        '--check-report', `${evidence}/check.json`, '--run-record', `${evidence}/rigc-run-1.json`,
        '--at-source', `${evidence}/at-source.json`, '--at-pointer', '/finished_at',
        '--by', 'agent', '--answers', '1:0', '--citations', `${evidence}/citations.json`, '--json'], Date.now()).stdout) as JsonObject;
      expect(registered).toMatchObject({ n: 2, kind: 'rig', answers_feedback: [{ version: 1, verdict: 0 }] });
      expect(arr(obj(obj(registered.provenance).sections).motion)).toContainEqual(motionCitation);
      expect(arr(f.load().versions).at(-1)).toEqual(registered);
      expect(f.additions()).toEqual(addition);
      expect((await f.inspect(0)).refusals).toEqual([]);
    } finally {
      host.stop();
    }
  } finally {
    if (opening.exitCode === null) opening.kill('SIGTERM');
    await opening.exited;
    await stderr;
  }
}, 30_000);

test('#820 a separate invalid signoff still blocks plan publication byte-identically', async () => {
  const f = await routeReviewComment();
  // Plant a separate refusal after the real verdict intake, close and route.
  const project = f.load();
  const signoffs = arr(project.signoffs);
  const other = { code: 'SIGNOFF_NOT_HUMAN', path: `signoffs[${signoffs.length}]` };
  signoffs.push({ stage: 'rig-review', checkpoint: null, by: 'agent',
    at: new Date(f.now()).toISOString(), verbatim: 'Synthetic unauthorized signature.' });
  writeFileSync(f.file, JSON.stringify(project));
  const before = f.bytes();
  const checked = await f.inspect(1);
  expect(arr(checked.refusals).map(row => ({ code: obj(row).code, path: obj(row).path }))).toEqual([other, ...expectedRefusals]);
  const denied = await f.cli(...f.planArgs);
  console.info(`#820 negative control: job open --plan exit ${denied.exit}; ${denied.stderr.trim()}`);
  expect(denied).toMatchObject({ exit: 1, stdout: '', stderr: expect.stringContaining(`JOB_RECORD_INCOMPLETE: project.json: ${other.code} at ${other.path}`) });
  expect(f.bytes()).toEqual(before);
  expect(readWriterBinding(f.root)).toBeNull();
  expect(pendingPublications(f.root)).toEqual([]);
}, 30_000);
