import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { interviewAnswerCommand } from '../src/choice-writers.ts';
import { main } from '../src/cli.ts';
import { diffClassesCommand } from '../src/diff-classes.ts';
import { interviewCommand } from '../src/interview.ts';
import { agentCall, readHostActsAndAsks } from '../src/job-acts.ts';
import { openCreateJob, openDraftPublication, openRecordPublication, reconcileCreateJob } from '../src/job-host.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, jobPrivateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { prepareDraftManifest, prepareLiveManifest, readPublished, readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { nextProject } from '../src/next.ts';
import { planCommand } from '../src/plan-writers.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { decodeReviewAct, fetchReviewAct, reviewActFindings, reviewActSignoff, signoffActIdentity } from '../src/review-act.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import { selectSignoffTarget } from '../src/signoff-target.ts';
import { signoffCommand } from '../src/signoff.ts';
import { stageIndex, stepCoveredByApproval } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, obj, retainSignoffs } from './fixtures.ts';
import { seedStoredInterviewPicks } from './historical-review-fixture.ts';

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

test('publication carries no ask of any retired kind', async () => {
  const now = Math.max(EXAMPLE_NOW, Date.now());

  // 0. Option-set publications carry the set and context images for looking and commenting, with no interview-picks ask.
  const optionsRoot = copyCheckpoint('0a-interview-options');
  const optionsPublished = readRecordPublished({
    root: optionsRoot,
    record: { path: 'project.json', sha256: jobHash(readFileSync(join(optionsRoot, 'project.json'))) },
    result: { kind: 'option-set', questionId: 'rig_type', setId: 'chain-rig_type' },
    phase: 'inventory',
  }, now);
  expect(optionsPublished.subjects).toEqual([]);
  expect(optionsPublished.files.map(f => f.path)).toContain('evidence/interview/rig_type.json');
  expect(optionsPublished.files.map(f => f.path)).toContain('inputs/painting.png');
  const optionsHost = await openCreateJob(optionsRoot, reviewer, now, undefined, true);
  hosts.push(optionsHost);
  const optionsLines = await openRecordPublication(optionsRoot, optionsHost, 'rig_type', false, now);
  expect(optionsLines).toHaveLength(1);
  expect(optionsLines[0]).toMatch(/^job: option-set rig_type\/chain-rig_type published \(publication .+\)$/);
  expect((await readHostActsAndAsks(optionsHost)).asks).toEqual([]);
  const optionsNext = nextProject(optionsRoot, now);
  expect(optionsNext.moves.some(m => m.command?.includes('--owner-chat'))).toBe(true);
  expect(optionsNext.moves.some(m => m.command?.includes('--from-review') || m.command?.startsWith('rig-create job acts '))).toBe(false);

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

  // 3. Rigging interview, rigging checkpoint, and rig-review carry no verdict or checkpoint ask.
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
  expect(rigAsks).toEqual([]);

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
  const beforePlanBytes = readFileSync(join(planRoot, 'project.json'));
  expect(() => signoffCommand(['plan-approved', planRoot, '--from-review', recordActId], now + 1000))
    .toThrow(expect.objectContaining({ code: 'SIGNOFF_FROM_REVIEW_REMOVED', exitCode: 2 }));
  expect(readFileSync(join(planRoot, 'project.json'))).toEqual(beforePlanBytes);

  const decodedPlanAct = decodeReviewAct(fetchedRecord.bytes, 'signoff');
  const planProject = read(planRoot);
  const coveredSteps = arr(obj(planProject.plan).steps).map(obj).filter(step => stepCoveredByApproval(planProject, step, 'plan-approved'));
  for (const step of coveredSteps) {
    if (step.checkpoint === null || step.checkpoint === undefined) {
      step.checkpoint = { delegated: false, by: 'user', at: decodedPlanAct.at, verbatim: words, value: step.checkpoint_proposed };
    }
  }
  const planSig: JsonObject = {
    ...reviewActSignoff(decodedPlanAct),
    steps: coveredSteps.map(step => step.id!),
    step_hashes: Object.fromEntries(coveredSteps.map(step => [String(step.id), stepHash(step)])),
  };
  const planAnswers = selectAnswerHashes(planRoot, planProject, planSig);
  if (planAnswers !== undefined) planSig.answer_hashes = planAnswers;
  planProject.signoffs = [...arr(planProject.signoffs), planSig];
  planProject.review_acts = [...(Array.isArray(planProject.review_acts) ? planProject.review_acts : []), {
    schema: 'rig-create/review-act@1', kind: 'signoff', jobId: decodedPlanAct.jobId, actId: decodedPlanAct.actId,
    stage: 'plan-approved', bytes: fetchedRecord.bytes, sha256: jobHash(fetchedRecord.bytes),
    version_hash: jobHash(JSON.stringify(signoffActIdentity(decodedPlanAct))),
  }];
  save(planRoot, planProject);
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
  const beforeRigBytes = readFileSync(join(rigRoot, 'project.json'));
  expect(() => signoffCommand(['rig-review', rigRoot, '--from-review', pkgActId], now + 1000))
    .toThrow(expect.objectContaining({ code: 'SIGNOFF_FROM_REVIEW_REMOVED', exitCode: 2 }));
  expect(readFileSync(join(rigRoot, 'project.json'))).toEqual(beforeRigBytes);

  const decodedRigAct = decodeReviewAct(fetchedPkg.bytes, 'signoff');
  const rigProject = read(rigRoot);
  const rigSig: JsonObject = {
    ...reviewActSignoff(decodedRigAct),
    target: selectSignoffTarget(rigRoot, rigProject, 'rig-review', '1')!,
  };
  rigProject.signoffs = [...arr(rigProject.signoffs), rigSig];
  rigProject.review_acts = [...arr(rigProject.review_acts), {
    schema: 'rig-create/review-act@1', kind: 'signoff', jobId: decodedRigAct.jobId, actId: decodedRigAct.actId,
    stage: 'rig-review', bytes: fetchedPkg.bytes, sha256: jobHash(fetchedPkg.bytes),
    version_hash: jobHash(JSON.stringify(signoffActIdentity(decodedRigAct))),
  }];
  save(rigRoot, rigProject);
  expect(reviewActFindings(read(rigRoot))).toEqual([]);
  expect(checkProject(rigRoot, undefined, { now: now + 2000 }).refusals).toEqual([]);
}, 30_000);

test('a stored interview-picks act from before still ingests', async () => {
  const now = Math.max(EXAMPLE_NOW, Date.now());
  const picksRoot = copyCheckpoint('0a-interview-options');
  const legacyPicksSubject = { kind: 'interview-picks' as const, questionId: 'rig_type', setId: 'chain-rig_type' };
  const picksHost = await openCreateJob(picksRoot, reviewer, now, options => startJobHost({
    ...options,
    readRecordPublished: ((request: RecordPublicationRequest) => {
      const context = readRecordPublished(request, now);
      return context.plan !== null ? context : { ...context, subjects: [legacyPicksSubject] };
    }) as typeof readRecordPublished,
  }), true);
  hosts.push(picksHost);
  const picksResult = { kind: 'option-set' as const, questionId: 'rig_type', setId: 'chain-rig_type' };
  enqueuePublication(picksRoot, readWriterBinding(picksRoot)!, picksResult);
  await reconcileCreateJob(picksRoot, async entry => {
    const requestId = randomUUID();
    const reply = await agentCall(picksHost, {
      verb: 'publish',
      requestId,
      idempotencyKey: requestId,
      expectedGeneration: 0,
      result: picksResult,
      freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
    });
    expect(reply.ok).toBe(true);
    const { publication, generation } = picksHost.session.status();
    acknowledgePublication(entry, publication!.publicationId, generation, requestId, [legacyPicksSubject]);
  });

  const picksSession = picksHost.session as unknown as {
    jobId: string;
    store: { update(jobId: string, rev: null, fn: (row: { data: { generation: number; reviewer: { id: string; role: string }; publications: Record<string, { retained: { source: unknown } }>; asks: Record<string, unknown>; acts: Record<string, unknown> } }) => { data: unknown }): unknown };
    event(data: unknown, value: object): unknown;
  };
  const picksPubId = picksHost.session.status().publication!.publicationId;
  let picksActId = '';
  picksSession.store.update(picksSession.jobId, null, ({ data }) => {
    data.generation++;
    const askId = randomUUID();
    const source = data.publications[picksPubId]!.retained.source;
    const ask = { askId, publicationId: picksPubId, subject: legacyPicksSubject, source, status: 'answered' };
    data.asks[askId] = ask;
    picksSession.event(data, { type: 'pending', ask: { ...ask, status: 'pending' } });
    picksActId = randomUUID();
    const act = parseCommentsAct({
      schema: JOB_COMMENTS_ACT_SCHEMA,
      actId: picksActId,
      jobId: picksSession.jobId,
      askId,
      publicationId: picksPubId,
      authority: { actor: 'human', channel: 'review-ui', reviewer: { ...data.reviewer } },
      at: new Date(now).toISOString(),
      kind: 'interview-picks',
      source,
      value: {
        questionId: 'rig_type',
        selections: [{ itemId: 'rig_type', optionId: 'keep', otherText: null }],
        note: 'Keep the synthetic rig type.',
        comments: [{ text: 'Pin on the synthetic rig type.' }],
      },
    });
    data.generation++;
    data.acts[picksActId] = act;
    picksSession.event(data, { type: 'act', act });
    return { data };
  });

  const picksBinding = readWriterBinding(picksRoot)!;
  const fetchedPicks = await fetchReviewAct({
    origin: picksBinding.origin,
    jobId: picksBinding.jobId,
    actId: picksActId,
    fetchCapability: picksBinding.fetchCapability,
    kind: 'interview-picks',
  });
  expect(JSON.parse(fetchedPicks.bytes)).toMatchObject({ schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'interview-picks', actId: picksActId });
  const beforePicksBytes = readFileSync(join(picksRoot, 'project.json'));
  expect(() => interviewAnswerCommand(['rig_type', picksRoot, '--from-review', picksActId], now + 1000))
    .toThrow(expect.objectContaining({ code: 'SIGNOFF_FROM_REVIEW_REMOVED', exitCode: 2 }));
  expect(readFileSync(join(picksRoot, 'project.json'))).toEqual(beforePicksBytes);
  seedStoredInterviewPicks(picksRoot, fetchedPicks.bytes);
  expect(arr(read(picksRoot).review_acts).at(-1)).toMatchObject({
    kind: 'interview-picks',
    jobId: picksBinding.jobId,
    actId: picksActId,
  });
  expect(reviewActFindings(read(picksRoot))).toEqual([]);
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

test('an unsigned parts draft publishes view-only without parts-verdict asks, and parts-review exits 2', async () => {
  const root = copyCheckpoint('1-parts-verdict');
  const checkpoint = read(root);
  const prepNow = Math.max(...[...arr(checkpoint.advances), ...arr(checkpoint.drafts), ...arr(checkpoint.signoffs)]
    .map(entry => Date.parse(String(obj(entry).at)))) + 1_000;
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expect(structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/structure-chain.json']).exit).toBe(0);
  expect(diffClassesCommand([root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'], prepNow).exit).toBe(0);
  expect(advanceCommand(['parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'], prepNow).exit).toBe(0);

  const host = await openCreateJob(root, reviewer, prepNow);
  hosts.push(host);
  const lines = await openDraftPublication(root, host, prepNow, 'chain');
  expect(lines).toEqual([expect.stringMatching(/^job: draft chain published \(publication .+\)$/)]);
  expect((await readHostActsAndAsks(host)).asks).toEqual([]);

  const before = readFileSync(join(root, 'project.json'));
  expect(main(['parts-review', root, '--from-review', 'act-1', '--json'], prepNow)).toBe(2);
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}, 30_000);
