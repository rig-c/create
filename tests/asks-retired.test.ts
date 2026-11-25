import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JOB_COMMENTS_ACT_SCHEMA,
  JOB_RECORD_ACT_SCHEMA,
  parseCommentsAct,
  parseRecordAct,
  startJobHost,
  type JobOwnerHost,
} from '@rig-c/review/job-host';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { checkProject } from '../src/check.ts';
import { interviewCommand } from '../src/interview.ts';
import { agentCall, readHostActsAndAsks } from '../src/job-acts.ts';
import { openCreateJob, openDraftPublication, openRecordPublication, reconcileCreateJob } from '../src/job-host.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, jobPrivateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { prepareDraftManifest, prepareLiveManifest, readPublished, readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { nextProject } from '../src/next.ts';
import { planCommand } from '../src/plan-writers.ts';
import { fetchReviewAct, reviewActFindings } from '../src/review-act.ts';
import { signoffCommand } from '../src/signoff.ts';
import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, obj, retainSignoffs } from './fixtures.ts';

const roots: string[] = [];
const hosts: JobOwnerHost[] = [];
const reviewer = { id: 'synthetic-owner', role: 'owner' as const };

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
const save = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

function copyCheckpoint(checkpoint: string, edit?: (project: JsonObject) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-asks-retired-')));
  roots.push(root);
  const src = checkpoint === 'example-chain'
    ? join(import.meta.dir, '../templates/example-chain')
    : join(import.meta.dir, '../templates/example-chain/checkpoints', checkpoint);
  cpSync(src, root, { recursive: true });
  if (edit) {
    const project = read(root);
    edit(project);
    save(root, project);
  }
  return root;
}

function isRetiredAskKind(kind: string): boolean {
  return kind === 'signoff' || kind === 'checkpoint' || kind === 'reopen';
}

test('publication carries no ask of any retired kind', async () => {
  const now = Math.max(EXAMPLE_NOW, Date.now());

  // 1. Interview and plan-approved record publications carry no signoff or plan-approval asks.
  const interviewRoot = copyCheckpoint('0b-plan-pending', project => {
    project.stage = 'interview';
    project.signoffs = [];
    project.advances = [];
  });
  const interviewPlan = readRecordPublished({
    root: interviewRoot,
    record: { path: 'project.json', sha256: jobHash(readFileSync(join(interviewRoot, 'project.json'))) },
    result: { kind: 'plan' },
    phase: 'inventory',
  }, now);
  expect(interviewPlan.subjects).toEqual([]);
  expect(nextProject(interviewRoot, now).moves.some(m => m.command?.includes('--plan'))).toBe(false);

  const planApprovedRoot = copyCheckpoint('0b-plan-pending');
  const planHost = await openCreateJob(planApprovedRoot, reviewer, now, undefined, true);
  hosts.push(planHost);
  const planLines = await openRecordPublication(planApprovedRoot, planHost, undefined, true, now);
  expect(planLines).toHaveLength(1);
  expect(planLines[0]).toMatch(/^job: plan published \(publication .+\)$/);
  expect((await readHostActsAndAsks(planHost)).asks).toEqual([]);
  expect(nextProject(planApprovedRoot, now).moves.some(m => m.command?.includes('--plan') || m.command?.includes('--from-review'))).toBe(false);

  // 2. Parts draft and record plan at an enabled at-checkpoint step carry no checkpoint ask.
  const partsCheckpointRoot = copyCheckpoint('1-parts-verdict', project => {
    project.signoffs = arr(project.signoffs).filter(s => obj(s).checkpoint !== 'assemble');
    const assemble = arr(obj(project.plan).steps).map(obj).find(step => step.id === 'assemble')!;
    assemble.status = 'at-checkpoint';
    delete assemble.status_history;
  });
  const partsManifest = prepareDraftManifest(partsCheckpointRoot, read(partsCheckpointRoot), 'chain');
  const partsDraft = await readPublished({
    root: partsCheckpointRoot,
    record: { path: 'project.json', sha256: jobHash(readFileSync(join(partsCheckpointRoot, 'project.json'))) },
    result: { path: partsManifest, selector: { kind: 'draft', id: 'chain' } },
  });
  expect(partsDraft.subjects).toEqual([]);
  const partsPlan = readRecordPublished({
    root: partsCheckpointRoot,
    record: { path: 'project.json', sha256: jobHash(readFileSync(join(partsCheckpointRoot, 'project.json'))) },
    result: { kind: 'plan' },
    phase: 'inventory',
  }, now);
  expect(partsPlan.subjects).toEqual([]);
  expect(nextProject(partsCheckpointRoot, now).moves.some(m => m.command?.includes('job open') || m.command?.includes('--from-review'))).toBe(false);

  // 3. Rigging interview, rigging checkpoint, and rig-review carry only review-verdict when eligible.
  const riggingRoot = copyCheckpoint('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = arr(project.advances).filter(a => obj(a).stage !== 'rig-review');
    const meshes = arr(obj(project.plan).steps).map(obj).find(step => step.id === 'meshes')!;
    meshes.checkpoint_proposed = true;
    meshes.checkpoint = { delegated: false, value: true, by: 'user', at: '2026-11-05T00:00:00Z', verbatim: 'Check meshes.' };
    meshes.status = 'at-checkpoint';
    delete meshes.status_history;
    project.signoffs = arr(project.signoffs).filter(s => obj(s).checkpoint !== 'meshes');
  });
  const riggingLiveManifest = prepareLiveManifest(riggingRoot, read(riggingRoot), 1);
  const riggingLive = await readPublished({
    root: riggingRoot,
    record: { path: 'project.json', sha256: jobHash(readFileSync(join(riggingRoot, 'project.json'))) },
    result: { path: riggingLiveManifest, selector: { kind: 'rig', version: 1 } },
  });
  expect(riggingLive.subjects).toEqual([]);

  const rigReviewRoot = copyCheckpoint('3-rig-review');
  const rigHost = await openCreateJob(rigReviewRoot, reviewer, now);
  hosts.push(rigHost);
  await openDraftPublication(rigReviewRoot, rigHost, now, undefined, '1');
  const rigAsks = (await readHostActsAndAsks(rigHost)).asks;
  expect(rigAsks.map(a => a.subject)).toEqual([{ kind: 'review-verdict', stage: 'rig-review' }]);
  expect(rigAsks.some(a => isRetiredAskKind(a.subject.kind))).toBe(false);

  // 4. Post-interview, post checkpoint, and direction-review carry no signoff or checkpoint asks.
  const directionRoot = copyCheckpoint('example-chain', project => {
    project.stage = 'direction-review';
    retainSignoffs(project, s => stageIndex(String(s.stage)) < stageIndex('direction-review'));
    project.advances = arr(project.advances).filter(a => obj(a).stage !== 'accepted');
  });
  const directionPlan = readRecordPublished({
    root: directionRoot,
    record: { path: 'project.json', sha256: jobHash(readFileSync(join(directionRoot, 'project.json'))) },
    result: { kind: 'plan' },
    phase: 'inventory',
  }, now);
  expect(directionPlan.subjects).toEqual([]);
  expect(nextProject(directionRoot, now).moves.some(m => m.command?.includes('--plan'))).toBe(false);
}, 30_000);

test('a stored sign-off act from before still ingests', async () => {
  const now = Math.max(EXAMPLE_NOW, Date.now());
  const words = 'Approve the synthetic stage from a stored act.\n';

  // 1. Stored record sign-off act@4 ingests and replays byte-identically.
  const planRoot = copyCheckpoint('0b-plan-pending');
  const legacyPlanSubject = { kind: 'signoff' as const, stage: 'plan-approved' as const };
  const planHost = await openCreateJob(planRoot, reviewer, now, options => startJobHost({
    ...options,
    readRecordPublished: ((request: RecordPublicationRequest) => {
      const context = readRecordPublished(request, now);
      return context.plan === null ? context : { ...context, subjects: [legacyPlanSubject] };
    }) as typeof readRecordPublished,
  }), true);
  hosts.push(planHost);
  enqueuePublication(planRoot, readWriterBinding(planRoot)!, { kind: 'plan' });
  await reconcileCreateJob(planRoot, async entry => {
    const requestId = randomUUID();
    const reply = await agentCall(planHost, {
      verb: 'publish',
      requestId,
      idempotencyKey: requestId,
      expectedGeneration: 0,
      result: { kind: 'plan' },
      freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
    });
    expect(reply.ok).toBe(true);
    const { publication, generation } = planHost.session.status();
    acknowledgePublication(entry, publication!.publicationId, generation, requestId, [legacyPlanSubject]);
  });

  const planSession = planHost.session as unknown as {
    jobId: string;
    store: { update(jobId: string, rev: null, fn: (row: { data: { generation: number; reviewer: { id: string; role: string }; publications: Record<string, { retained: { source: unknown } }>; asks: Record<string, unknown>; acts: Record<string, unknown> } }) => { data: unknown }): unknown };
    event(data: unknown, value: object): unknown;
  };
  const planPubId = planHost.session.status().publication!.publicationId;
  let recordActId = '';
  planSession.store.update(planSession.jobId, null, ({ data }) => {
    data.generation++;
    const askId = randomUUID();
    const source = data.publications[planPubId]!.retained.source;
    const ask = { askId, publicationId: planPubId, subject: legacyPlanSubject, source, status: 'answered' };
    data.asks[askId] = ask;
    planSession.event(data, { type: 'pending', ask: { ...ask, status: 'pending' } });
    recordActId = randomUUID();
    const act = parseRecordAct({
      schema: JOB_RECORD_ACT_SCHEMA,
      actId: recordActId,
      jobId: planSession.jobId,
      askId,
      publicationId: planPubId,
      authority: { actor: 'human', channel: 'review-ui', reviewer: { ...data.reviewer } },
      at: new Date(now).toISOString(),
      kind: 'signoff',
      source,
      value: { stage: 'plan-approved', decision: 'approved', words },
    });
    data.generation++;
    data.acts[recordActId] = act;
    planSession.event(data, { type: 'act', act });
    return { data };
  });

  const planBinding = readWriterBinding(planRoot)!;
  const fetchedRecord = await fetchReviewAct({
    origin: planBinding.origin,
    jobId: planBinding.jobId,
    actId: recordActId,
    fetchCapability: planBinding.fetchCapability,
    kind: 'signoff',
  });
  expect(JSON.parse(fetchedRecord.bytes)).toMatchObject({ schema: JOB_RECORD_ACT_SCHEMA, kind: 'signoff', actId: recordActId });
  expect(signoffCommand(['plan-approved', planRoot, '--from-review', recordActId], now + 1000, { fetch: () => fetchedRecord }).exit).toBe(0);
  const signedPlanBytes = readFileSync(join(planRoot, 'project.json'));
  expect(arr(read(planRoot).signoffs).at(-1)).toMatchObject({
    stage: 'plan-approved',
    by: 'user',
    verbatim: words,
    source: `review act ${planBinding.jobId}/${recordActId}`,
  });
  expect(signoffCommand(['plan-approved', planRoot, '--from-review', recordActId], now + 2000, { fetch: () => fetchedRecord }).exit).toBe(0);
  expect(readFileSync(join(planRoot, 'project.json'))).toEqual(signedPlanBytes);
  expect(reviewActFindings(read(planRoot))).toEqual([]);
  expect(checkProject(planRoot, undefined, { now: now + 2000 }).refusals).toEqual([]);

  // 2. Stored package sign-off act@6 ingests against an accepted version and replays byte-identically.
  const rigRoot = copyCheckpoint('example-chain', project => {
    project.stage = 'rig-review';
    project.scenes = [];
    delete project.direction_contract;
    project.versions = arr(project.versions).filter(v => obj(v).kind === 'rig');
    retainSignoffs(project, s => stageIndex(String(s.stage)) < stageIndex('rig-review'));
    project.advances = arr(project.advances).filter(a => stageIndex(String(obj(a).stage)) <= stageIndex('rig-review'));
    for (const step of arr(obj(project.plan).steps).map(obj).filter(step => step.phase === 'post')) {
      step.status = 'pending';
      delete step.status_history;
    }
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
  });
  const legacyRigSubject = { kind: 'signoff' as const, stage: 'rig-review' as const };
  const rigHost = await openCreateJob(rigRoot, reviewer, now, options => startJobHost({
    ...options,
    readPublished: async input => ({ ...await readPublished(input), subjects: [legacyRigSubject] }),
  }));
  hosts.push(rigHost);
  const rigManifest = prepareLiveManifest(rigRoot, read(rigRoot), 1);
  const rigResult = { path: rigManifest, selector: { kind: 'rig' as const, version: 1 } };
  enqueuePublication(rigRoot, readWriterBinding(rigRoot)!, rigResult);
  await reconcileCreateJob(rigRoot, async entry => {
    const requestId = randomUUID();
    const response = await rigHost.ports.handleJobApi(new Request(`${rigHost.origin}/jobs/${rigHost.session.jobId}/api`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rigHost.session.hostCredentials().agent}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: 'rig-review/job-api@2',
        verb: 'publish',
        jobId: rigHost.session.jobId,
        requestId,
        idempotencyKey: requestId,
        expectedGeneration: 0,
        result: rigResult,
        freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
      }),
    }));
    const reply = await response.json() as { ok: boolean };
    expect(reply.ok).toBe(true);
    const { publication, generation } = rigHost.session.status();
    acknowledgePublication(entry, publication!.publicationId, generation, requestId, [legacyRigSubject]);
  });

  const rigSession = rigHost.session as unknown as typeof planSession;
  const rigPubId = rigHost.session.status().publication!.publicationId;
  let pkgActId = '';
  rigSession.store.update(rigSession.jobId, null, ({ data }) => {
    data.generation++;
    const askId = randomUUID();
    const source = data.publications[rigPubId]!.retained.source;
    const ask = { askId, publicationId: rigPubId, subject: legacyRigSubject, source, status: 'answered' };
    data.asks[askId] = ask;
    rigSession.event(data, { type: 'pending', ask: { ...ask, status: 'pending' } });
    pkgActId = randomUUID();
    const act = parseCommentsAct({
      schema: JOB_COMMENTS_ACT_SCHEMA,
      actId: pkgActId,
      jobId: rigSession.jobId,
      askId,
      publicationId: rigPubId,
      authority: { actor: 'human', channel: 'review-ui', reviewer: { ...data.reviewer } },
      at: new Date(now).toISOString(),
      kind: 'signoff',
      source,
      value: { stage: 'rig-review', decision: 'approved', comments: [{ text: words }] },
    });
    data.generation++;
    data.acts[pkgActId] = act;
    rigSession.event(data, { type: 'act', act });
    return { data };
  });

  const rigBinding = readWriterBinding(rigRoot)!;
  const fetchedPkg = await fetchReviewAct({
    origin: rigBinding.origin,
    jobId: rigBinding.jobId,
    actId: pkgActId,
    fetchCapability: rigBinding.fetchCapability,
    kind: 'signoff',
  });
  expect(JSON.parse(fetchedPkg.bytes)).toMatchObject({ schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'signoff', actId: pkgActId });
  expect(signoffCommand(['rig-review', rigRoot, '--from-review', pkgActId], now + 1000, { fetch: () => fetchedPkg }).exit).toBe(0);
  const signedRigBytes = readFileSync(join(rigRoot, 'project.json'));
  expect(arr(read(rigRoot).signoffs).at(-1)).toMatchObject({
    stage: 'rig-review',
    by: 'user',
    target: { version: 1 },
    source: `review act ${rigBinding.jobId}/${pkgActId}`,
  });
  expect(signoffCommand(['rig-review', rigRoot, '--from-review', pkgActId], now + 2000, { fetch: () => fetchedPkg }).exit).toBe(0);
  expect(readFileSync(join(rigRoot, 'project.json'))).toEqual(signedRigBytes);
  expect(reviewActFindings(read(rigRoot))).toEqual([]);
  expect(checkProject(rigRoot, undefined, { now: now + 2000 }).refusals).toEqual([]);
}, 30_000);

test('a plan replace under a signed plan no longer refuses', () => {
  const now = Math.max(EXAMPLE_NOW, Date.now());
  const root = copyCheckpoint('1-parts-verdict', project => {
    project.drafts = [];
    project.signoffs = arr(project.signoffs).filter(s => obj(s).checkpoint !== 'assemble');
    const assemble = arr(obj(project.plan).steps).map(obj).find(step => step.id === 'assemble')!;
    assemble.status = 'pending';
    delete assemble.status_history;
  });
  expect(arr(read(root).signoffs).some(s => obj(s).stage === 'plan-approved')).toBe(true);
  const beforeStep = arr(obj(read(root).plan).steps).map(obj).find(step => step.id === 'assemble')!;
  expect(obj(beforeStep.checkpoint).value).toBe(true);

  const replaced = planCommand([
    'replace', 'assemble', root,
    '--phase', String(beforeStep.phase),
    '--order', String(beforeStep.order),
    '--rests-on', (beforeStep.rests_on as string[]).join(','),
    '--does', 'Assemble updated synthetic layers after plan approval.',
    '--produces', 'Updated assembled parts directory',
    '--bar', 'Parts check passes with zero refusals.',
    '--checkpoint-proposed', 'false',
    '--by', 'agent',
  ], now);
  expect(replaced.exit).toBe(0);

  const afterStep = arr(obj(read(root).plan).steps).map(obj).find(step => step.id === 'assemble')!;
  expect(afterStep.checkpoint).toBeNull();
  expect(checkProject(root, undefined, { now: now + 1000 }).refusals).toEqual([]);
  const checked = interviewCommand(['--check', root, '--json'], now + 1000);
  expect(checked.exit).toBe(0);
  expect(JSON.parse(checked.stdout).refusals).toEqual([]);
});
