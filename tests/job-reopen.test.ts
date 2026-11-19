import { afterEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJobHost, type RecordPlanSubject } from '@rig-c/review/job-host';
import { askDeclaredSubjects, openCreateJob, openRecordPublication, reconcileCreateJob, subjectLabel } from '../src/job-host.ts';
import { agentCall, readHostActsAndAsks } from '../src/job-acts.ts';
import { assertNoPendingJobAsk } from '../src/job-close.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { CLI } from './helpers.ts';

const roots: string[] = [];
const read = (root: string): JsonObject => JSON.parse(recordBytes(root).toString('utf8'));
const recordBytes = (root: string): Buffer => readFileSync(join(root, 'project.json'));
const reviewer = { id: 'synthetic-owner', role: 'owner' as const };
const REOPEN_STAGES = [
  'interview', 'plan-approved', 'parts', 'parts-review', 'rigging-interview',
  'rigging', 'rig-review', 'post-interview', 'post', 'direction-review',
];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

async function cli(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

async function checked(root: string) {
  const result = await cli(root, ['interview', '--check', root]);
  expect(result.exit, result.stderr + result.stdout).toBe(0);
}

async function pauseForReopen(root: string) {
  const file = join(root, 'pause.txt');
  writeFileSync(file, 'Pause the synthetic project.\n');
  for (const args of [['signoff', 'paused', root], ['pause', root]]) {
    const result = await cli(root, [...args, '--by', reviewer.id, '--verbatim-file', file]);
    expect(result.exit, result.stderr).toBe(0);
  }
  expect(read(root).stage).toBe('paused');
  await checked(root);
}

async function ingestReopen(root: string, stage: string, stages: readonly string[], forward: readonly RecordPlanSubject[] = [], emptyPlan = false) {
  const fromStage = read(root).stage;
  const subjects = [...forward, ...stages.map(stage => ({ kind: 'reopen' as const, stage }))];
  const host = await openCreateJob(root, reviewer, Date.now(), undefined, true);
  try {
    const lines = await openRecordPublication(root, host, undefined, true, Date.now());
    expect(lines).toEqual(['job: plan published', `job: asked ${subjects.map(subjectLabel).join(', ')}`]);
    const published = host.session.status();
    const publication = published.publication!;
    expect(publication.source).toMatchObject({ projectHash: jobHash(recordBytes(root)), subjects });
    if (emptyPlan) expect(publication.source.plan).toEqual({ steps: [] });
    const { asks } = await readHostActsAndAsks(host);
    expect(asks.map(ask => ask.subject)).toEqual(subjects);
    const nextDraft = { kind: 'draft' as const, id: 'synthetic-replacement' };
    if (forward.length === 0) await assertNoPendingJobAsk(root, nextDraft);
    const ask = asks.find(ask => ask.subject.kind === 'reopen' && ask.subject.stage === stage)!;
    const url = new URL(host.ownerUrl);
    const endpoint = `${url.origin}/jobs/${host.session.jobId}/ui/`;
    const headers = {
      origin: url.origin, 'X-Review-Capability': url.hash.slice('#cap='.length), 'content-type': 'application/json',
    };
    const post = async (route: string, body: object) => {
      const response = await fetch(endpoint + route, { method: 'POST', headers, body: JSON.stringify(body) });
      const payload = await response.json() as JsonObject;
      expect(response.ok, JSON.stringify(payload)).toBe(true);
      return obj(payload.value);
    };
    const { publicationId, source: { sourceHash } } = publication;
    const pageId = crypto.randomUUID();
    const { displayedNonce } = await post('displayed', { publicationId, pageId, sourceHash });
    const words = '  Revisit the synthetic stage.\r\nKeep the recorded notes.  ';
    const exported = await post('acts', {
      publicationId, askId: ask.askId, pageId, displayedNonce, expectedGeneration: published.generation,
      submissionId: crypto.randomUUID(), kind: 'reopen', value: { stage, words },
    });
    expect(exported).toMatchObject({ schema: 'rig-review/act@4', kind: 'reopen', value: { stage, words } });
    if (forward.length === 0) {
      await expect(assertNoPendingJobAsk(root, nextDraft)).rejects.toMatchObject({
        code: 'JOB_ASK_PENDING', message: expect.stringContaining('run the printed ingest commands'),
      });
    }

    const listed = await cli(root, ['job', 'acts', root, '--json']);
    expect(listed.exit, listed.stderr).toBe(0);
    const args = ['reopen', stage, root, '--from-review', String(exported.actId)];
    expect(JSON.parse(listed.stdout).acts).toMatchObject([{ actId: exported.actId, kind: 'reopen', args }]);
    const result = await cli(root, [...args, '--json']);
    expect(result.exit, result.stderr).toBe(0);
    const entry = { stage, from_stage: fromStage, by: reviewer.id, at: exported.at, verbatim: words };
    expect(JSON.parse(result.stdout)).toMatchObject(entry);
    expect(read(root).stage).toBe(stage);
    expect(arr(read(root).reopens).at(-1)).toMatchObject(entry);
    const closed = await cli(root, ['job', 'close', root]);
    expect(closed.exit, closed.stderr).toBe(0);
    await checked(root);
  } finally { host.stop(); }
}

test.each(REOPEN_STAGES)('#639 completed plan publishes, asks and ingests reopen %s', async stage => {
  const root = realpathSync(fixture(() => {}, 'example-project.json'));
  roots.push(root);
  await ingestReopen(root, stage, REOPEN_STAGES);
});

function earlyPlan(empty = false): string {
  const checkpoint = 'example-chain/checkpoints/0b-plan-pending';
  const root = realpathSync(fixture(project => {
    if (empty) obj(project.plan).steps = [];
  }, checkpoint + '/project.json'));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates', checkpoint), root, {
    recursive: true, filter: path => !path.endsWith('/project.json'),
  });
  return root;
}

test('#639 an early paused plan with no steps asks only its reached interview', async () => {
  const root = earlyPlan(true);
  await pauseForReopen(root);
  await ingestReopen(root, 'interview', ['interview'], [], true);
});

test('#639 active plan retains its signoff and offers reached reopen stages', async () => {
  const root = earlyPlan();
  await ingestReopen(root, 'interview', ['interview', 'plan-approved'], [{ kind: 'signoff', stage: 'plan-approved' }]);
});

test('#639 open replaces an unchanged old plan head and reuses the new head on retry', async () => {
  const root = earlyPlan();
  const oldSubjects = [{ kind: 'signoff' as const, stage: 'plan-approved' as const }];
  const oldHost = await openCreateJob(root, reviewer, Date.now(), options => startJobHost({
    ...options,
    readRecordPublished: ((request: RecordPublicationRequest) => {
      const context = readRecordPublished(request);
      return context.plan === null ? context : { ...context, subjects: oldSubjects };
    }) as typeof readRecordPublished,
  }), true);
  const original = recordBytes(root);
  let oldId: string;
  try {
    const result = { kind: 'plan' as const };
    enqueuePublication(root, readWriterBinding(root)!, result);
    await reconcileCreateJob(root, async entry => {
      const requestId = crypto.randomUUID();
      const reply = await agentCall(oldHost, { verb: 'publish', requestId, idempotencyKey: requestId,
        expectedGeneration: 0, result,
        freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
      });
      expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
      const { publication, generation } = oldHost.session.status();
      acknowledgePublication(entry, publication!.publicationId, generation, requestId, oldSubjects);
      expect(await askDeclaredSubjects(oldHost, publication!.publicationId, oldSubjects, false)).toEqual(
        oldSubjects.map(subject => ({ subject, status: 'asked' })));
    });
    oldId = oldHost.session.status().publication!.publicationId;
  } finally { oldHost.stop(); }

  const host = await openCreateJob(root, reviewer, Date.now(), undefined, true);
  try {
    const subjects = 'signoff plan-approved, reopen interview, reopen plan-approved';
    expect(await openRecordPublication(root, host, undefined, true, Date.now())).toEqual(
      ['job: plan published', `job: asked ${subjects}`]);
    const { publication, generation } = host.session.status();
    expect(publication!.publicationId).not.toBe(oldId);
    expect(await openRecordPublication(root, host, undefined, true, Date.now())).toEqual(
      ['job: plan already published', `job: already asked ${subjects}`]);
    expect(host.session.status()).toMatchObject({ generation, publication: { publicationId: publication!.publicationId } });
    expect(recordBytes(root)).toEqual(original);
  } finally { host.stop(); }
});
