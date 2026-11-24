import { afterEach, expect, test } from 'bun:test';
import { JOB_API_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, JOB_ERROR_CODES, prepareJobRecordSource, startJobHost, type JobOwnerHost } from '@rig-c/review/job-host';
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_REOPEN_AT } from '../scripts/example-time.ts';
import { objects } from '../src/direction.ts';
import { readProject } from '../src/feedback.ts';
import { closeCreateJob, openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, pendingPublications, publicationVersionHash, readWriterBinding } from '../src/job-outbox.ts';
import { prepareLiveManifest, readPublished, readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, directionCommand, inputCommand, reviewCommand, sceneCommand, testClock } from './clock.ts';
import { obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { isSourceLinkedRun } from './source-only.ts';

const directionSignoff = { kind: 'signoff', stage: 'direction-review' } as const;
const words = 'Accept this synthetic take.';

afterEach(() => testClock.reset());

function readPlan(root: string) {
  const record = { path: 'project.json' as const, sha256: jobHash(readProject(root).bytes) };
  return readRecordPublished({ root, record, result: { kind: 'plan' }, phase: 'inventory' }, testClock.now());
}

function authoredPost(camera: 'fixed' | 'moving'): string {
  const root = realpathSync(tempDir('create-direction-review-'));
  const example = join(import.meta.dir, '../templates/example-chain');
  cpSync(join(example, 'checkpoints/4-direction-post'), root, { recursive: true });
  mkdirSync(join(root, 'inputs'), { recursive: true });
  for (const path of ['inputs/background.png', 'evidence/scene-citations.json']) {
    cpSync(join(example, path), join(root, path));
  }
  testClock.set(EXAMPLE_REOPEN_AT);
  expect(inputCommand(['add', 'inputs/background.png', root, '--origin', 'synthetic plate']).exit).toBe(0);
  expect(sceneCommand(['write', '--rig', '1', '--background', 'inputs/background.png',
    '--citations-file', 'evidence/scene-citations.json', root]).exit).toBe(0);

  const path = 'evidence/direction-input.json';
  const doc = JSON.parse(readFileSync(join(example, path), 'utf8')) as JsonObject;
  const authoredCamera = obj(doc.camera);
  const [first, last] = objects(authoredCamera.keys);
  const box = obj(first!.box);
  const middleBox = camera === 'moving' ? { ...box, width: obj(last!.box).width! } : box;
  // Equal endpoints catch a classifier that misses motion at an interior key.
  authoredCamera.keys = [first!, { time: 2, box: middleBox, easing: 'smoothstep' }, { ...last!, box }];
  writeFileSync(join(root, path), JSON.stringify(doc));
  expect(directionCommand(['write', '2', root, '--file', path, '--rig', '1']).exit).toBe(0);
  return root;
}

/** As in the live-act writer fixtures, serve the exported bytes on a loopback consumer route. */
async function ingestLiveApproval(root: string): Promise<string> {
  const reviewer = { id: 'synthetic-owner', role: 'owner' } as const;
  const jobId = 'synthetic-direction-job';
  const actId = 'synthetic-direction-approval';
  const publicationId = 'synthetic-post-publication';
  const fetchCapability = 'synthetic-fetch';
  let actBytes: string | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('accept') !== 'application/vnd.rig-review.act+json') return new Response(null, { status: 404 });
    const body = await request.json() as { verb: string; actId: string; jobId: string };
    if (!actBytes || body.verb !== 'fetch-act' || body.jobId !== jobId || body.actId !== actId
      || request.headers.get('authorization') !== `Bearer ${fetchCapability}`) return new Response(null, { status: 403 });
    return new Response(actBytes, { headers: { 'content-type': 'application/vnd.rig-review.act+json' } });
  } });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    await openCreateJob(root, reviewer, testClock.now(), async options => {
      await options.installWriterBinding?.({ jobId, origin, fetchCapability });
      return { origin, session: { jobId }, attachment: { listenerIncarnation: 'synthetic-listener' },
        stop: () => server.stop(true) } as unknown as JobOwnerHost;
    });
    const { project, bytes } = readProject(root);
    const path = prepareLiveManifest(root, project, 2);
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as { id: string; revision: string; model: string; direction: string };
    const record = { path: 'project.json' as const, sha256: jobHash(bytes) };
    const result = { path, selector: { kind: 'post' as const, version: 2, rigVersion: 1 } };
    const published = await readPublished({ root, record, result });
    const binding = readWriterBinding(root)!;
    acknowledgePublication({ schema: 'rig-create/job-pending@1', root, id: 'synthetic-intent', jobId, origin,
      identity: binding.identity, recordHash: record.sha256, result, versionHash: publicationVersionHash(bytes, result)!,
      failure: null }, publicationId, 1, 'synthetic-request', published.subjects);
    actBytes = JSON.stringify({ schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'review-verdict', jobId, publicationId,
      actId, askId: 'synthetic-verdict-ask', at: testClock.iso(), authority: { actor: 'human', channel: 'review-ui', reviewer },
      source: { package: { id: manifest.id, revision: manifest.revision }, projectHash: record.sha256,
        sourceHash: jobHash(JSON.stringify(published.files)), selector: result.selector, parts: published.parts, plan: published.plan,
        model: published.files.find(file => file.path === manifest.model), direction: published.files.find(file => file.path === manifest.direction),
        optionSet: null, appliedResult: null },
      value: { stage: 'direction-review', verdict: 'approved', comments: [{ text: words }] } });

    // The writer fetches synchronously, so its loopback fixture must run in the parent process.
    const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), '-e', `
      import { recordReviewAct } from '../src/feedback.ts';
      const [root, actId, now] = process.argv.slice(-3);
      recordReviewAct(root, 2, actId, Number(now));
    `, root, actId, String(testClock.now())], { cwd: import.meta.dir, stderr: 'pipe' });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    expect(objects(readProject(root).project.review_acts)).toContainEqual(expect.objectContaining({ actId, version: 2, verdict: 0 }));
    return actId;
  } finally {
    server.stop(true);
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
  }
}

function acceptWithoutReceipt(root: string, version: number) {
  expect(reviewCommand([String(version), root, '--review', 'direction-review', '--verdict', 'accepted', '--by', 'user',
    '--verbatim', words, '--source', 'synthetic review']).exit).toBe(0);
}

function postRequest(root: string, version: number) {
  const { project, bytes } = readProject(root);
  const record = { path: 'project.json', sha256: jobHash(bytes) } as const;
  const result = { path: prepareLiveManifest(root, project, version),
    selector: { kind: 'post', version, rigVersion: 1 } } as const;
  return { root, record, result };
}

async function publishPost(host: JobOwnerHost, { record, result }: ReturnType<typeof postRequest>) {
  const { jobId } = host.session;
  const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${jobId}/api`, {
    method: 'POST',
    headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: JOB_API_SCHEMA, verb: 'publish', jobId, requestId: crypto.randomUUID(),
      expectedGeneration: host.session.status().generation, idempotencyKey: crypto.randomUUID(),
      freeze: { kind: 'producer-held', holdId: 'direction-test-hold', record }, result }),
  }));
  const body = await response.json();
  expect(body).toMatchObject({ ok: true });
  return host.session.status().publication!;
}

type PostPublication = Awaited<ReturnType<typeof publishPost>>;
function publicationContent({ publicationId: _, generation: __, previousPublicationId: ___, interview, ...rest }: PostPublication) {
  return JSON.stringify({ ...rest, interview: interview && { ...interview, evaluatedAt: '' } });
}

async function runDirectionWriter(expression: string, root: string, actId: string, now: number) {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), '-e', expression, root, actId, String(now)], {
    cwd: import.meta.dir, stderr: 'pipe',
  });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
}

test('#955 a direction post projects an ingested same-job bounce only when Review supports it', async () => {
  const root = authoredPost('fixed');
  expect(advanceCommand(['direction-review', root]).exit).toBe(0);
  const reviewer = { id: 'synthetic-owner', role: 'owner' } as const;
  const host = await openCreateJob(root, reviewer, testClock.now());
  let laterHost: JobOwnerHost | undefined;
  const { jobId } = host.session;
  const text = 'Keep this synthetic shot fixed.';
  try {
    const input = postRequest(root, 2);
    enqueuePublication(root, readWriterBinding(root)!, input.result);
    expect(await reconcileCreateJob(root, undefined, testClock.now())).toBe(1);
    const earlier = host.session.status().publication!;
    const ask = host.session.status().pending.find(row => row.subject.kind === 'review-verdict')!;
    const pageId = 'synthetic-direction-owner-page';
    const request = (route: string, value: object) => new Request(`${host.origin}/jobs/${jobId}/ui/${route}`, {
      method: 'POST',
      headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    const displayed = await host.ports.ackDisplayed(jobId, request('displayed', {
      publicationId: earlier.publicationId, pageId, sourceHash: earlier.source.sourceHash,
    }));
    if (!displayed.ok) throw Error(displayed.error.code);
    const submitted = await host.ports.commitUIAct(jobId, request('acts', {
      publicationId: earlier.publicationId, askId: ask.askId, pageId, displayedNonce: displayed.value.displayedNonce,
      expectedGeneration: host.session.status().generation, submissionId: 'synthetic-bounce-submit',
      kind: 'review-verdict', value: { stage: 'direction-review', verdict: 'changes-requested', comments: [{ text }] },
    }));
    if (!submitted.ok) throw Error(submitted.error.code);
    const { actId, at } = submitted.value;
    const now = Math.max(testClock.now(), Date.parse(at));
    await runDirectionWriter(`
      import { recordReviewAct } from '../src/feedback.ts';
      const [root, actId, now] = process.argv.slice(-3);
      recordReviewAct(root, 2, actId, Number(now));
    `, root, actId, now);
    await runDirectionWriter(`
      import { directionCommand } from '../src/direction-writers.ts';
      const [root, , now] = process.argv.slice(-3);
      const result = directionCommand(['write', '3', root, '--file', 'evidence/direction-input.json',
        '--rig', '1', '--answers', '2:0'], Number(now));
      process.exitCode = result.exit;
    `, root, actId, now + 1000);
    expect(pendingPublications(root)).toEqual([]);
    const actual = await readPublished(postRequest(root, 3));
    const publication = host.session.status().publication!;
    expect(publication.source.selector).toEqual({ kind: 'post', version: 3, rigVersion: 1 });
    const { answeredDirectionFeedback: references, ...baseline } = actual as typeof actual & {
      answeredDirectionFeedback?: readonly { jobId: string; actId: string }[];
    };
    const errorCodes: readonly string[] = JOB_ERROR_CODES;
    if (isSourceLinkedRun() || errorCodes.includes('JOB_ANSWERED_DIRECTION_FEEDBACK_INVALID')) {
      expect(references).toStrictEqual([{ jobId, actId }]);
      expect(publication).toHaveProperty('answeredDirectionFeedback', [{
        jobId, actId, postVersion: 2, answeredByPostVersion: 3, comments: [{ text, kind: 'general' }],
      }]);
    } else {
      expect(Object.hasOwn(actual, 'answeredDirectionFeedback')).toBe(false);
      expect(Object.hasOwn(publication, 'answeredDirectionFeedback')).toBe(false);
    }

    const { project, bytes } = readProject(root);
    const recordPath = join(root, 'project.json');
    // Model a historical verdict with no ingested Review act. Keep the answer ref.
    writeFileSync(recordPath, JSON.stringify({ ...project, review_acts: [] }));
    const noAct = await readPublished(postRequest(root, 3));
    expect(JSON.stringify(noAct)).toBe(JSON.stringify(baseline));
    writeFileSync(recordPath, bytes);

    await closeCreateJob(root);
    let forceLegacyContext = false;
    laterHost = await openCreateJob(root, reviewer, now + 1000, options => startJobHost({
      ...options, async readPublished(input) {
        return forceLegacyContext ? baseline : readPublished(input);
      },
    }));
    expect(laterHost.session.jobId).not.toBe(jobId);
    const laterInput = postRequest(root, 3);
    const otherJob = await readPublished(laterInput);
    expect(JSON.stringify(otherJob)).toBe(JSON.stringify(baseline));
    const later = await publishPost(laterHost, laterInput);
    forceLegacyContext = true;
    const legacy = await publishPost(laterHost, laterInput);
    expect(Object.hasOwn(later, 'answeredDirectionFeedback')).toBe(false);
    expect(publicationContent(later)).toBe(publicationContent(legacy));
  } finally {
    laterHost?.stop();
    host.stop();
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
  }
});

test('#881 projects the accepted live verdict and detects an interior camera move', async () => {
  const root = authoredPost('moving');
  expect(advanceCommand(['direction-review', root]).exit).toBe(0);
  const actId = await ingestLiveApproval(root);

  const context = readPlan(root);
  expect(context.subjects).toEqual([directionSignoff]);
  expect(context.directionReview).toStrictEqual({ postVersion: 2, verdictActId: actId,
    take: { duration: 4, loop: false }, camera: 'moving' });
  const path = 'evidence/direction/v2.json';
  expect(context.files).toContainEqual({ path, sha256: jobHash(readFileSync(join(root, path))) });
});

// Review 4.17.0 rejects this field; the source pin includes Review #1111.
test.skipIf(!isSourceLinkedRun())('#881 Review retains the direction summary without changing record source identity', async () => {
  const root = authoredPost('moving');
  expect(advanceCommand(['direction-review', root]).exit).toBe(0);
  const actId = await ingestLiveApproval(root);
  const now = testClock.now();
  const record = { path: 'project.json', sha256: jobHash(readProject(root).bytes) } as const;
  const { dev, ino } = statSync(root);
  const options = {
    root: { path: root, dev, ino },
    stateRoot: join(root, '.synthetic-snapshots'),
    fingerprint: 'synthetic',
    request: { freeze: { kind: 'producer-held', holdId: 'synthetic-hold', record }, result: { kind: 'plan' } },
  } as const;

  type PlanRequest = RecordPublicationRequest & { result: { kind: 'plan' } };
  type PublicationReader = NonNullable<Parameters<typeof prepareJobRecordSource>[0]['readRecordPublished']>;
  const publishPlan = (input: PlanRequest) => readRecordPublished(input, now);
  const publishWithoutSummary = (input: PlanRequest) => {
    const { directionReview: _, ...context } = publishPlan(input);
    return context;
  };
  const { source: withSummary } = await prepareJobRecordSource({ ...options,
    readRecordPublished: publishPlan as unknown as PublicationReader });
  const { source: withoutSummary } = await prepareJobRecordSource({ ...options,
    readRecordPublished: publishWithoutSummary as unknown as PublicationReader });

  expect('directionReview' in withSummary ? withSummary.directionReview : undefined).toStrictEqual({
    postVersion: 2, verdictActId: actId, take: { duration: 4, loop: false }, camera: 'moving',
  });
  expect(Object.hasOwn(withoutSummary, 'directionReview')).toBe(false);
  expect(withSummary.sourceHash).toBe(withoutSummary.sourceHash);
  expect(withSummary.projectHash).toBe(record.sha256);
  expect(withSummary.projectHash).toBe(withoutSummary.projectHash);
  expect(withSummary.inputs).toStrictEqual(withoutSummary.inputs);
  expect(withSummary.files).toStrictEqual(withoutSummary.files);
});

test('#881 only a signable direction plan projects the fixed take, even without a verdict receipt', () => {
  const root = authoredPost('fixed');
  const post = readPlan(root);
  expect(post.label).toBe('plan / post');
  expect(post.subjects).not.toContainEqual(directionSignoff);
  expect(Object.hasOwn(post, 'directionReview')).toBe(false);

  expect(advanceCommand(['direction-review', root]).exit).toBe(0);
  acceptWithoutReceipt(root, 2);
  const context = readPlan(root);
  expect(context.subjects).toEqual([directionSignoff]);
  expect(context.directionReview).toStrictEqual({ postVersion: 2, verdictActId: null,
    take: { duration: 4, loop: false }, camera: 'fixed' });
});
