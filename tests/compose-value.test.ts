import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';
import { collectItems, type Ctx, type Finding } from '../src/check.ts';
import { choiceVerbatim, optionContext, sha256 } from '../src/choices.ts';
import {
  COMPOSE_SCALAR_TRACK_PROPERTIES,
  COMPOSE_TRACK_PROPERTIES,
  COMPOSE_VALUE_INVALID,
  COMPOSE_VECTOR_TRACK_PROPERTIES,
  ComposeValueError,
  checkComposeValues,
  readComposeValue,
} from '../src/compose-value.ts';
import { stageIndex } from '../src/stages.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { checkProject, interviewAnswerCommand, interviewOptionsCommand, testClock } from './clock.ts';
import { arr, fixture, obj, retainSignoffs } from './fixtures.ts';

afterEach(() => testClock.reset());

const BASE_PATH = 'interview.post.items[post_composition].guide.value.compose';

function validCompose(end = 8): JsonObject {
  return {
    canvas: { width: 1664, height: 1216 },
    plates: [
      { name: 'room', image: 'inputs/room.png', at: [0, 0], opaque_backdrop: true },
      { name: 'front', image: 'derived/front.png', at: [-12, 24] },
    ],
    order: ['room', 'hero', 'front'],
    character: { offset: [0, 0], scale: 1 },
    idle_tracks: [
      {
        bone: 'room',
        property: 'translate',
        keys: [
          { t: 0, v: [0, 0], curve: [1, 0, 3, -24, 0, 0, 0, 0] },
          { t: end / 2, v: [-24, 0], curve: 'stepped' },
          { t: end, v: [0, 0] },
        ],
      },
      {
        bone: 'hero:yaw_dial',
        property: 'rotate',
        keys: [
          { t: 0, v: [-8] },
          { t: end / 2, v: [8] },
          { t: end, v: [-8] },
        ],
      },
    ],
  };
}

function expectRefusal(value: Json | undefined, expectedPath: string, path = BASE_PATH, expectedMessageSubstring?: string): void {
  let caught: unknown;
  try {
    readComposeValue(value, path);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComposeValueError);
  const err = caught as ComposeValueError;
  expect(err.code).toBe(COMPOSE_VALUE_INVALID);
  expect(err.path).toBe(expectedPath);
  expect(err.message).toContain(expectedPath);
  expect(err.message).toContain('value.compose');
  if (expectedMessageSubstring !== undefined) {
    expect(err.message).toContain(expectedMessageSubstring);
  }
}

test('accepts a valid composed take value with canvas, two plates, one character, translate and rotate tracks', () => {
  const input = validCompose();
  const parsed = readComposeValue(input, BASE_PATH);
  expect(parsed).toEqual({ ...(input as unknown as ReturnType<typeof readComposeValue>), end: 8 });

  // Also accepts a wrapper { compose } at the parent value path.
  const wrapped = readComposeValue({ compose: input }, 'interview.post.items[post_composition].guide.value');
  expect(wrapped).toEqual(parsed);

  // Accepts optional character.scale omitted and every rigc vector/scalar bone property.
  for (const prop of COMPOSE_VECTOR_TRACK_PROPERTIES) {
    const c = validCompose();
    delete (c.character as JsonObject).scale;
    c.idle_tracks = [{ bone: 'room', property: prop, keys: [{ t: 0, v: [1, 2] }, { t: 8, v: [1, 2] }] }];
    expect(readComposeValue(c, BASE_PATH).idle_tracks[0]!.property).toBe(prop);
  }
  for (const prop of COMPOSE_SCALAR_TRACK_PROPERTIES) {
    const c = validCompose();
    c.idle_tracks = [{ bone: 'hero:yaw_dial', property: prop, keys: [{ t: 0, v: [1.5] }, { t: 8, v: [1.5] }] }];
    expect(readComposeValue(c, BASE_PATH).idle_tracks[0]!.property).toBe(prop);
  }
  expect(COMPOSE_TRACK_PROPERTIES).toEqual([
    'translate',
    'scale',
    'shear',
    'translatex',
    'translatey',
    'scalex',
    'scaley',
    'shearx',
    'sheary',
    'rotate',
  ]);

  // Invariant 1: dial range and loop closure are compose's responsibility, not Create's.
  const unclosedAndWideDial = validCompose();
  unclosedAndWideDial.idle_tracks = [
    {
      bone: 'hero:yaw_dial',
      property: 'rotate',
      keys: [
        { t: 0, v: [-720] },
        { t: 8, v: [720] },
      ],
    },
  ];
  expect(readComposeValue(unclosedAndWideDial, BASE_PATH).idle_tracks[0]!.keys).toEqual([
    { t: 0, v: [-720] },
    { t: 8, v: [720] },
  ]);
});

test('refuses each malformed compose rule with COMPOSE_VALUE_INVALID and the exact field path', () => {
  // Top-level compose shape
  expectRefusal(null, BASE_PATH);
  expectRefusal([], BASE_PATH);
  expectRefusal({ ...validCompose(), extra: true }, BASE_PATH);
  for (const required of ['canvas', 'plates', 'order', 'character', 'idle_tracks'] as const) {
    const c = validCompose();
    delete c[required];
    expectRefusal(c, `${BASE_PATH}.${required}`);
  }

  // canvas rules
  {
    const c = validCompose();
    c.canvas = 'not-object';
    expectRefusal(c, `${BASE_PATH}.canvas`);
  }
  {
    const c = validCompose();
    (c.canvas as JsonObject).extra = 1;
    expectRefusal(c, `${BASE_PATH}.canvas`);
  }
  for (const field of ['width', 'height'] as const) {
    const c = validCompose();
    delete (c.canvas as JsonObject)[field];
    expectRefusal(c, `${BASE_PATH}.canvas.${field}`);
  }
  for (const badDim of [128.5, 0, -64, Number.NaN, Number.POSITIVE_INFINITY, '128'] as unknown as Json[]) {
    const cw = validCompose();
    (cw.canvas as JsonObject).width = badDim;
    expectRefusal(cw, `${BASE_PATH}.canvas.width`);
    const ch = validCompose();
    (ch.canvas as JsonObject).height = badDim;
    expectRefusal(ch, `${BASE_PATH}.canvas.height`);
  }

  // plates[] rules
  {
    const c = validCompose();
    c.plates = 'not-an-array';
    expectRefusal(c, `${BASE_PATH}.plates`);
  }
  {
    const c = validCompose();
    (c.plates as Json[])[0] = 'not-an-object';
    expectRefusal(c, `${BASE_PATH}.plates[0]`);
  }
  {
    const c = validCompose();
    ((c.plates as JsonObject[])[0] as JsonObject).extra = 1;
    expectRefusal(c, `${BASE_PATH}.plates[0]`);
  }
  for (const field of ['name', 'image', 'at'] as const) {
    const c = validCompose();
    delete ((c.plates as JsonObject[])[0] as JsonObject)[field];
    expectRefusal(c, `${BASE_PATH}.plates[0].${field}`);
  }
  for (const badName of ['', '   ', 123 as unknown as Json]) {
    const c = validCompose();
    ((c.plates as JsonObject[])[0] as JsonObject).name = badName;
    expectRefusal(c, `${BASE_PATH}.plates[0].name`);
  }
  {
    const c = validCompose();
    ((c.plates as JsonObject[])[1] as JsonObject).name = 'room';
    expectRefusal(c, `${BASE_PATH}.plates[1].name`);
  }
  for (const badImage of ['', '/abs/room.png', 'inputs\\room.png', 'C:room.png', '../room.png', './room.png', 'inputs//room.png']) {
    const c = validCompose();
    ((c.plates as JsonObject[])[0] as JsonObject).image = badImage;
    expectRefusal(c, `${BASE_PATH}.plates[0].image`);
  }
  for (const badAt of [[0], [0, 0, 0], [1.5, 0], [0, Number.NaN], '0,0'] as unknown as Json[]) {
    const c = validCompose();
    ((c.plates as JsonObject[])[0] as JsonObject).at = badAt;
    expectRefusal(c, `${BASE_PATH}.plates[0].at`);
  }
  {
    const c = validCompose();
    ((c.plates as JsonObject[])[0] as JsonObject).opaque_backdrop = 'yes';
    expectRefusal(c, `${BASE_PATH}.plates[0].opaque_backdrop`);
  }

  // order rules
  for (const badOrder of ['not-array', []] as unknown as Json[]) {
    const c = validCompose();
    c.order = badOrder;
    expectRefusal(c, `${BASE_PATH}.order`);
  }
  {
    const c = validCompose();
    (c.order as Json[])[1] = '   ';
    expectRefusal(c, `${BASE_PATH}.order[1]`);
  }
  {
    const c = validCompose();
    c.order = ['room', 'hero', 'room', 'front'];
    expectRefusal(c, `${BASE_PATH}.order[2]`);
  }
  {
    const c = validCompose();
    c.order = ['room', 'hero'];
    expectRefusal(c, `${BASE_PATH}.order`);
  }

  // character rules
  {
    const c = validCompose();
    c.character = 'not-object';
    expectRefusal(c, `${BASE_PATH}.character`);
  }
  {
    const c = validCompose();
    (c.character as JsonObject).extra = 1;
    expectRefusal(c, `${BASE_PATH}.character`);
  }
  {
    const c = validCompose();
    delete (c.character as JsonObject).offset;
    expectRefusal(c, `${BASE_PATH}.character.offset`);
  }
  for (const badOffset of [[0], [0, 1, 2], [Number.POSITIVE_INFINITY, 0], ['0', 0]] as unknown as Json[]) {
    const c = validCompose();
    (c.character as JsonObject).offset = badOffset;
    expectRefusal(c, `${BASE_PATH}.character.offset`);
  }
  for (const badScale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1'] as unknown as Json[]) {
    const c = validCompose();
    (c.character as JsonObject).scale = badScale;
    expectRefusal(c, `${BASE_PATH}.character.scale`);
  }

  // idle_tracks[] rules
  for (const badTracks of ['not-array', []] as unknown as Json[]) {
    const c = validCompose();
    c.idle_tracks = badTracks;
    expectRefusal(c, `${BASE_PATH}.idle_tracks`);
  }
  {
    const c = validCompose();
    (c.idle_tracks as Json[])[0] = 'not-object';
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0]`);
  }
  {
    const c = validCompose();
    ((c.idle_tracks as JsonObject[])[0] as JsonObject).extra = 1;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0]`);
  }
  for (const field of ['bone', 'property', 'keys'] as const) {
    const c = validCompose();
    delete ((c.idle_tracks as JsonObject[])[0] as JsonObject)[field];
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].${field}`);
  }
  {
    const c = validCompose();
    ((c.idle_tracks as JsonObject[])[0] as JsonObject).bone = '';
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].bone`);
  }
  for (const badProp of ['unknown', 'inherit', 'rgba', ''] as const) {
    const c = validCompose();
    ((c.idle_tracks as JsonObject[])[0] as JsonObject).property = badProp;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].property`);
  }
  for (const badKeys of ['not-array', []] as unknown as Json[]) {
    const c = validCompose();
    ((c.idle_tracks as JsonObject[])[0] as JsonObject).keys = badKeys;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys`);
  }
  {
    const c = validCompose();
    (((c.idle_tracks as JsonObject[])[0] as JsonObject).keys as Json[])[0] = 'not-object';
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[0]`);
  }
  {
    const c = validCompose();
    ((((c.idle_tracks as JsonObject[])[0] as JsonObject).keys as JsonObject[])[0] as JsonObject).ease = 'linear';
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[0]`);
  }
  for (const field of ['t', 'v'] as const) {
    const c = validCompose();
    delete ((((c.idle_tracks as JsonObject[])[0] as JsonObject).keys as JsonObject[])[0] as JsonObject)[field];
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[0].${field}`);
  }
  // Key time rules: finite, nonnegative, first at 0, strictly increasing, last > 0, and identical last t across tracks
  {
    const c = validCompose();
    ((((c.idle_tracks as JsonObject[])[0] as JsonObject).keys as JsonObject[])[0] as JsonObject).t = Number.NaN;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[0].t`);
  }
  {
    const c = validCompose();
    ((((c.idle_tracks as JsonObject[])[0] as JsonObject).keys as JsonObject[])[0] as JsonObject).t = -1;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[0].t`);
  }
  {
    const c = validCompose();
    ((((c.idle_tracks as JsonObject[])[0] as JsonObject).keys as JsonObject[])[0] as JsonObject).t = 1;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[0].t`);
  }
  {
    const c = validCompose();
    ((c.idle_tracks as JsonObject[])[0] as JsonObject).keys = [{ t: 0, v: [0, 0] }];
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[0].t`);
  }
  {
    const c = validCompose();
    ((((c.idle_tracks as JsonObject[])[0] as JsonObject).keys as JsonObject[])[1] as JsonObject).t = 0;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[1].t`);
  }
  {
    const c = validCompose();
    ((((c.idle_tracks as JsonObject[])[0] as JsonObject).keys as JsonObject[])[2] as JsonObject).t = 3;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[2].t`);
  }
  // Tracks whose last keys differ
  {
    const c = validCompose();
    ((((c.idle_tracks as JsonObject[])[1] as JsonObject).keys as JsonObject[])[2] as JsonObject).t = 10;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[1].keys[2].t`);
  }
  // Key value rules: vector requires [x, y] finite numbers; scalar requires one-number array [n] of a finite number
  for (const badVectorV of [0, [0], [0, 0, 0], [0, Number.NaN], '0,0'] as unknown as Json[]) {
    const c = validCompose();
    ((((c.idle_tracks as JsonObject[])[0] as JsonObject).keys as JsonObject[])[1] as JsonObject).v = badVectorV;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[0].keys[1].v`, BASE_PATH, '[x, y]');
  }
  for (const badScalarV of [8, -8, 0, [], [0, 0], [Number.NaN], [Number.POSITIVE_INFINITY], ['8'], Number.POSITIVE_INFINITY, '8', null] as unknown as Json[]) {
    const c = validCompose();
    ((((c.idle_tracks as JsonObject[])[1] as JsonObject).keys as JsonObject[])[1] as JsonObject).v = badScalarV;
    expectRefusal(c, `${BASE_PATH}.idle_tracks[1].keys[1].v`, BASE_PATH, '[n]');
  }
});

test('check validates post_composition.value.compose and leaves records without value.compose byte-for-byte unchanged', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const projectPath = join(dir, 'project.json');
  const originalProject = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
  const baselineReport = checkProject(dir);
  expect(baselineReport.ok).toBe(true);
  expect(baselineReport.refusals).toEqual([]);

  // Update the retained post_composition option set and choice to carry a valid value.compose.
  const withCompose = structuredClone(originalProject);
  const item = collectItems(withCompose, { collection: null }).find(i => i.id === 'post_composition')!;
  const answer = item.raw as JsonObject;
  const choice = answer.choice as JsonObject;
  const setBinding = choice.set as JsonObject;
  const setFile = join(dir, String(setBinding.path));
  const originalSetBytes = readFileSync(setFile);
  const set = JSON.parse(originalSetBytes.toString('utf8')) as JsonObject;
  const compose = validCompose();
  const nextValue: JsonObject = { ...(answer.value as JsonObject), compose };
  const keepOpt = (((set.asks as JsonObject[])[0]!.options as JsonObject[]).find(o => o.id === 'keep'))!;
  keepOpt.fragment = nextValue;
  const nextSetBytes = Buffer.from(`${JSON.stringify(set, null, 2)}\n`, 'utf8');
  writeFileSync(setFile, nextSetBytes);
  setBinding.sha256 = sha256(nextSetBytes);
  answer.value = nextValue;
  answer.verbatim = choiceVerbatim(choice.picks as JsonObject[], choice.note);

  const ctxPass: Ctx = {
    dir,
    project: withCompose,
    refusals: [],
    warnings: [],
    items: collectItems(withCompose, { collection: null }),
    signoffs: [],
    steps: [],
    stage: String(withCompose.stage),
    effectiveStage: String(withCompose.stage),
    collection: null,
    predatesPartsReview: null,
  };
  checkComposeValues(ctxPass);
  expect(ctxPass.refusals).toEqual([]);

  // A malformed value.compose in checkProject produces COMPOSE_VALUE_INVALID at the exact field path.
  const badCompose = structuredClone(withCompose);
  const badItem = collectItems(badCompose, { collection: null }).find(i => i.id === 'post_composition')!;
  const badAnswer = badItem.raw as JsonObject;
  ((((badAnswer.value as JsonObject).compose as JsonObject).character as JsonObject).scale) = -2;
  const reportBad = checkProject(dir, badCompose);
  expect(reportBad.refusals).toContainEqual(
    expect.objectContaining({
      code: COMPOSE_VALUE_INVALID,
      path: 'interview.post.items[post_composition].guide.value.compose.character.scale',
    }) as Finding,
  );

  // Restore the original option set and verify the project without value.compose checks identically.
  writeFileSync(setFile, originalSetBytes);
  const afterReport = checkProject(dir);
  expect(afterReport).toEqual(baselineReport);
});

test('writers can record 8s timing and compose, then sequentially revise post_timing to 10s and post_composition to 10s', () => {
  const dir = fixture(p => {
    p.stage = 'post-interview';
    p.versions = arr(p.versions).filter(v => obj(v).kind === 'rig');
    p.scenes = [];
    delete p.direction_contract;
    retainSignoffs(p, s => stageIndex(String(obj(s).stage)) < stageIndex('post-interview'));
    p.advances = arr(p.advances).filter(a => stageIndex(String(obj(a).stage)) <= stageIndex('post-interview'));
    for (const step of arr(obj(p.plan).steps).map(obj)) {
      if (step.phase === 'post') step.status = 'pending';
    }
  }, 'example-project.json');

  let clock = EXAMPLE_ANCHOR + 5 * 60_000;
  function writeQuestionAnswer(question: 'post_timing' | 'post_composition', setId: string, fragment: JsonObject): void {
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const item = collectItems(project, { collection: null }).find(i => i.id === question)!;
    const templateBinding = obj(obj(item.raw).choice).set as JsonObject;
    const set = JSON.parse(readFileSync(join(dir, String(templateBinding.path)), 'utf8')) as JsonObject;
    clock += 1_000;
    const draftedAt = new Date(clock).toISOString();
    set.id = setId;
    set.drafted_at = draftedAt;
    set.context = optionContext(project, 'post-interview', Date.parse(draftedAt), dir);
    const keep = arr(obj(arr(set.asks)[0]).options).map(obj).find(o => o.id === 'keep')!;
    keep.fragment = fragment;
    const relPath = `evidence/interview/${setId}.json`;
    const bytes = `${JSON.stringify(set, null, 2)}\n`;
    writeFileSync(join(dir, relPath), bytes);
    const hash = sha256(Buffer.from(bytes));
    clock += 1_000;
    testClock.set(clock);
    interviewOptionsCommand([question, dir, '--file', relPath]);
    clock += 1_000;
    testClock.set(clock);
    interviewAnswerCommand([question, dir, '--set', relPath, '--sha256', hash, '--by', 'user', '--pick', `${question}=keep`]);
  }

  // 1. Record 8s post_composition and 8s post_timing through the real writers.
  writeQuestionAnswer('post_composition', 'compose-8s', { compose: validCompose(8) });
  writeQuestionAnswer('post_timing', 'timing-8s', { seconds: 8, loop: true, beats: [] });
  expect(checkProject(dir).refusals).toEqual([]);

  // 2. Revise post_timing to 10s through the writer while post_composition still holds 8s.
  writeQuestionAnswer('post_timing', 'timing-10s', { seconds: 10, loop: true, beats: [] });
  expect(checkProject(dir).refusals).toEqual([]);

  // 3. Revise post_composition to 10s through the writer.
  writeQuestionAnswer('post_composition', 'compose-10s', { compose: validCompose(10) });
  const finalReport = checkProject(dir);
  expect(finalReport.refusals).toEqual([]);

  const finalProject = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const finalComp = collectItems(finalProject, { collection: null }).find(i => i.id === 'post_composition')!;
  expect(readComposeValue(obj(obj(finalComp.raw).value).compose, BASE_PATH).end).toBe(10);
  expect(arr(finalComp.record.history).length).toBeGreaterThanOrEqual(2);
});
