import { afterEach, expect, test } from 'bun:test';
import { JOB_API_SCHEMA, JOB_ERROR_CODES, startJobHost, type JobOwnerHost } from '@rig-c/review/job-host';
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_REOPEN_AT } from '../scripts/example-time.ts';
import { objects } from '../src/direction.ts';
import { readProject } from '../src/feedback.ts';
import { askDeclaredSubjects, closeCreateJob, openCreateJob } from '../src/job-host.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, pendingPublications, readWriterBinding, reconcilePublication } from '../src/job-outbox.ts';
import { prepareLiveManifest, readPublished } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, directionCommand, inputCommand, sceneCommand, testClock } from './clock.ts';
import { obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { isSourceLinkedRun } from './source-only.ts';

afterEach(() => testClock.reset());

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

function postRequest(root: string, version: number) {
  const { project, bytes } = readProject(root);
  const record = { path: 'project.json', sha256: jobHash(bytes) } as const;
  const result = { path: prepareLiveManifest(root, project, version),
    selector: { kind: 'post', version, rigVersion: 1 } } as const;
  return { root, record, result };
}

async function publishPost(host: JobOwnerHost, { record, result }: ReturnType<typeof postRequest>,
  requestId = crypto.randomUUID(), holdId = 'direction-test-hold') {
  const { jobId } = host.session;
  const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${jobId}/api`, {
    method: 'POST',
    headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: JOB_API_SCHEMA, verb: 'publish', jobId, requestId,
      expectedGeneration: host.session.status().generation, idempotencyKey: requestId,
      freeze: { kind: 'producer-held', holdId, record }, result }),
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
  const subjects = [{ kind: 'review-verdict', stage: 'direction-review' }] as const;
  const host = await openCreateJob(root, reviewer, testClock.now(), options => startJobHost({
    ...options, readPublished: async input => {
      const published = await readPublished(input);
      return input.result.selector?.kind === 'post' && input.result.selector.version === 2
        ? { ...published, subjects } : published;
    },
  }));
  let laterHost: JobOwnerHost | undefined;
  const { jobId } = host.session;
  const text = 'Keep this synthetic shot fixed.';
  try {
    const input = postRequest(root, 2);
    const entry = enqueuePublication(root, readWriterBinding(root)!, input.result);
    const requestId = crypto.randomUUID();
    const earlier = await publishPost(host, input, requestId, entry.id);
    await reconcilePublication(root, entry, async pending => {
      acknowledgePublication(pending, earlier.publicationId, earlier.generation, requestId, subjects);
    });
    expect(await askDeclaredSubjects(host, earlier.publicationId, subjects, false)).toEqual([{ status: 'asked', subject: subjects[0] }]);
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
    expect(host.session.status().publication?.publicationId).toBe(earlier.publicationId);
    const publication = await publishPost(host, postRequest(root, 3));
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
