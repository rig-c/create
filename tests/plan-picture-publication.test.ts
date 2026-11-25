import { expect, test } from 'bun:test';
import { prepareJobRecordSource } from '@rig-c/review/job-host';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { jobHash } from '../src/job-outbox.ts';
import { stageIndex } from '../src/stages.ts';
import { fixture, retainSignoffs, obj, arr } from './fixtures.ts';
import { TEST_NOW } from './clock.ts';
import type { JsonObject } from '../src/templates.ts';

// A synthetic 1x1 PNG standing in for a post still the record retains.
const STILL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const STILL_PATH = 'evidence/v4/review-still.png';

/** The filled example at direction-review, its live post v4 holding `evidence` as `mutate` leaves it. */
function directionRecord(mutate: (post: JsonObject) => void = () => {}, files: Record<string, Uint8Array> = {}): string {
  return realpathSync(fixture(project => {
    project.stage = 'direction-review';
    retainSignoffs(project, signature => obj(signature).stage !== 'direction-review');
    project.advances = arr(project.advances).filter(value => obj(value).stage !== 'accepted');
    mutate(arr(project.versions).map(obj).find(version => version.n === 4)!);
  }, 'example-project.json', files));
}

function planRequest(root: string): RecordPublicationRequest & { result: { kind: 'plan' } } {
  return { root, record: { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) },
    result: { kind: 'plan' }, phase: 'inventory' };
}

const still = { kind: 'still', path: STILL_PATH, sha256: jobHash(STILL), camera: 'front', frame: 'setup', what: 'Review displayed setup pose' };
const COMPOSE_CHECK = 'outputs/v4/compose/check';
const atlasPage = { path: `${COMPOSE_CHECK}/build/skeleton.png`, sha256: jobHash('atlas page') };
const idleFrame = { path: `${COMPOSE_CHECK}/idle_frames/idle/f0000.png`, sha256: jobHash(STILL) };

test('#665 a post-stage plan publication names the live post picture as a files entry, and Review retains it', async () => {
  const root = directionRecord(post => {
    post.evidence = [still, ...arr(post.evidence)];
    post.outputs = [...arr(post.outputs), idleFrame];
  }, { [STILL_PATH]: STILL, [idleFrame.path]: STILL });
  const context = readRecordPublished(planRequest(root), TEST_NOW);
  expect(context.planPicture).toEqual({ path: STILL_PATH, sha256: jobHash(STILL) });
  expect(context.files).toContainEqual(context.planPicture!);
  expect(context.subjects).toEqual([]);

  const info = statSync(root);
  const request = planRequest(root);
  const retained = await prepareJobRecordSource({ root: { path: root, dev: info.dev, ino: info.ino },
    stateRoot: join(root, '.synthetic-snapshots'), fingerprint: 'synthetic',
    request: { freeze: { kind: 'producer-held', holdId: 'synthetic-hold', record: request.record as { path: 'project.json'; sha256: string } }, result: { kind: 'plan' } },
    readRecordPublished: ((input: RecordPublicationRequest) => readRecordPublished(input, TEST_NOW)) as unknown as NonNullable<Parameters<typeof prepareJobRecordSource>[0]['readRecordPublished']> });
  const source = retained.source as unknown as { planPicture?: unknown; files: unknown[] };
  expect(source.planPicture).toEqual(context.planPicture);
  expect(source.files).toContainEqual(context.planPicture);
});

test.each([
  ['publishes the recorded first idle frame', true],
  ['omits the picture without a recorded first idle frame', false],
] as const)('#867 a composed post %s', (_description, recorded) => {
  const laterFrame = { path: `${COMPOSE_CHECK}/idle_frames/idle/f0001.png`, sha256: jobHash('later frame') };
  const root = directionRecord(post => {
    post.evidence = [];
    post.outputs = [atlasPage, laterFrame, ...(recorded ? [idleFrame] : []), ...arr(post.outputs)];
  }, { [atlasPage.path]: Buffer.from('atlas page'), [laterFrame.path]: Buffer.from('later frame'), [idleFrame.path]: STILL });
  const context = readRecordPublished(planRequest(root), TEST_NOW);
  if (recorded) {
    expect(context.planPicture).toEqual(idleFrame);
    expect(context.files).toContainEqual(idleFrame);
  } else {
    expect('planPicture' in context).toBe(false);
    expect(context.files).not.toContainEqual(idleFrame);
  }
  expect(context.files).not.toContainEqual(atlasPage);
  expect(context.files).not.toContainEqual(laterFrame);
});

test('#665 a post-stage plan whose live post holds no picture publishes without the field', () => {
  // The live post's only output is its direction document; no raster is retained.
  const root = directionRecord(post => { post.evidence = []; });
  const context = readRecordPublished(planRequest(root), TEST_NOW);
  expect('planPicture' in context).toBe(false);
  expect(context.files.some(file => /\.(png|jpe?g|webp)$/i.test(file.path) && file.path.startsWith('evidence/v4/'))).toBe(false);
});

test('#665 a post picture named by the record but absent from disk publishes without the field', () => {
  // The filled example's v4 beat sheet is a record row without retained bytes.
  const root = directionRecord();
  const context = readRecordPublished(planRequest(root), TEST_NOW);
  expect('planPicture' in context).toBe(false);
});

test.each(['rigging-interview', 'post-interview'])('#665 a pre-post %s plan publication carries no plan picture', stage => {
  const root = realpathSync(fixture(project => {
    project.stage = stage;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex(stage));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex(stage));
    if (stage === 'rigging-interview') {
      project.versions = [];
      project.scenes = [];
      for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    } else {
      project.versions = arr(project.versions).filter(value => obj(value).kind === 'rig');
    }
    delete project.direction_contract;
    for (const step of arr(obj(project.plan).steps).map(obj)) {
      if (stage === 'post-interview' ? step.phase === 'post' : !['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
    }
  }, 'example-project.json'));
  const context = readRecordPublished(planRequest(root), TEST_NOW);
  expect(Object.keys(context)).toEqual(['label', 'parts', 'inputs', 'files', 'plan', 'subjects']);
});
