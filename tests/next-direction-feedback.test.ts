import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { optionContext } from '../src/choices.ts';
import { sha256, treeFiles } from '../src/current.ts';
import type { OpenDirectionComment } from '../src/feedback.ts';
import { closeCreateJob, openCreateJob } from '../src/job-host.ts';
import { readWriterBinding } from '../src/job-outbox.ts';
import { nextCommand, type NextReport } from '../src/next.ts';
import { recordCommand } from '../src/record.ts';
import type { JsonObject } from '../src/templates.ts';
import { amendCommand, checkProject, correctionCommand, directionCommand, interviewAnswerCommand, interviewOptionsCommand,
  planCommand, rigVersionCommand, sceneCommand, signoffCommand, stepStatusCommand, TEST_NOW, testClock } from './clock.ts';
import { composeRunFixture } from './direction-compose-fixture.ts';
import { arr, obj } from './fixtures.ts';
import { ownerChatArgs, tempDir } from './helpers.ts';
import { seedStoredVerdict, seedStoredVersionSignoff } from './historical-review-fixture.ts';

const feedbackPath = 'versions[v3].verdicts[0]';

function expectDirectionOnly(report: NextReport): void {
  expect(report).toMatchObject({ stage: 'accepted', effective_stage: 'direction-review', accepted: false, refusals: [] });
  expect(report.moves.some(move => move.field === 'current.rig' || move.field === 'current.motion'
    || /rig-create (?:record (?:rig|motion)|advance accepted)\b/.test(move.command ?? ''))).toBe(false);
}

function expectDeferredDirectionFeedback(dir: string, version: number, ...verdicts: number[]): NextReport {
  const current = JSON.parse(nextCommand([dir, '--json'], testClock.now()).stdout) as NextReport;
  const human = nextCommand([dir], testClock.now()).stdout;
  const flags = verdicts.map(index => `--answers-feedback ${version}:${index}`).join(' ');
  const command = `rig-create record direction ${dir} --from outputs/direction.next --direction specs/direction/direction.json ${flags}`;
  const { moves, awaits, refusals } = current;
  expect({ moves, awaits, refusals }).not.toEqual({ moves: [], awaits: [], refusals: [] });
  expect(current).toMatchObject({ stage: 'accepted', effective_stage: 'direction-review', accepted: false, refusals: [] });
  expect(current.moves.some(move => /\bdirection write \d|--answers(?:-feedback)? \d+:\d/.test(move.command ?? ''))).toBe(false);
  const routes = current.moves.filter(move => move.field === 'current.direction');
  expect(routes).toHaveLength(1);
  const route = routes[0]!;
  expect(route).toMatchObject({ role: 'agent', awaits: 'current.direction', command: null });
  for (const index of verdicts) expect(route.act).toContain(`project.json.versions[v${version}].verdicts[${index}]`);
  expect([...route.act.matchAll(/--answers-feedback (\d+:\d+)/g)].map(match => match[1]))
    .toEqual(verdicts.map(index => `${version}:${index}`));
  expect(route.act).toEndWith(`\n    ${command}`);
  expect(current.awaits).toContain('current.direction');
  expect(human.split('\n')[0]).toEndWith('stage: accepted (effective: direction-review)');
  expect(human).toContain(`  [agent] (current.direction -> current.direction) ${route.act}`);
  return current;
}

test('#1106 next routes a live numbered direction bounce through current outputs after adoption', () => {
  const dir = join(tempDir('next-direction-feedback-'), 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain'), dir, { recursive: true });
  const recordPath = join(dir, 'project.json');
  const readNext = (): NextReport => JSON.parse(nextCommand([dir, '--json'], testClock.now()).stdout) as NextReport;

  try {
    testClock.set(TEST_NOW);
    expect(readNext()).toMatchObject({ stage: 'accepted', effective_stage: 'accepted', accepted: true, refusals: [], awaits: [], moves: [] });

    const words = join(dir, 'evidence/revise-direction.txt');
    writeFileSync(words, 'Keep the push-in and make its camera move gentler.\n');
    const input = 'evidence/direction-revision.json';
    const direction = JSON.parse(readFileSync(join(dir, 'evidence/direction-input.json'), 'utf8')) as JsonObject;
    obj(arr(obj(direction.camera).keys)[1]).box = { x: -61, y: 3, width: 122, height: 122 };
    writeFileSync(join(dir, input), `${JSON.stringify(direction, null, 2)}\n`);
    expect(amendCommand(['direction-review', dir, '--kind', 'motion-track', '--target', 'camera', '--change', input,
      '--by', 'user', ...ownerChatArgs(words)]).exit).toBe(0);
    testClock.set(TEST_NOW + 1_000);
    expect(directionCommand(['write', '3', dir, '--file', input, '--rig', '1']).exit).toBe(0);
    const bounce = join(dir, 'evidence/direction-bounce.txt');
    writeFileSync(bounce, 'Hold the wide view longer before the push-in.\n');
    testClock.set(TEST_NOW + 2_000);
    seedStoredVerdict(dir, 3, { review: 'direction-review', verdict: 'bounced', by: 'user',
      at: testClock.now(), verbatim: readFileSync(bounce, 'utf8'), source: 'synthetic review' });
    const checked = checkProject(dir);
    expect(checked).toMatchObject({ stage: 'accepted', effective_stage: 'direction-review', refusals: [] });
    expect(checked.warnings).toContainEqual(expect.objectContaining({ code: 'FEEDBACK_OPEN', path: feedbackPath }));

    const numbered = readNext();
    expect(numbered).toMatchObject({ accepted: false, refusals: [], awaits: ['versions[n=4]'] });
    expect(numbered.moves).toEqual([expect.objectContaining({ role: 'agent', field: 'versions',
      command: expect.stringMatching(/^rig-create direction write 4 .* --answers 3:0$/) })]);

    // The chain binds a rig model, but never registered adoptable parts, motion, or compose output trees.
    // Adopting the rig alone switches next away from numbered verdict moves.
    const beforeAdoption = JSON.parse(readFileSync(recordPath, 'utf8')) as JsonObject;
    testClock.set(TEST_NOW + 3_000);
    expect(recordCommand(['rig', dir, '--adopt'], testClock.now()).exit).toBe(0);
    expect(directionCommand(['--adopt', dir]).exit).toBe(0);
    expect(correctionCommand(['--adopt', dir]).exit).toBe(0);
    const adoptedBytes = readFileSync(recordPath);
    const adopted = JSON.parse(adoptedBytes.toString('utf8')) as JsonObject;
    expect(adopted).toMatchObject({ versions: beforeAdoption.versions, current: { rig: { adopted: { version: 1 } } } });

    const current = expectDeferredDirectionFeedback(dir, 3, 0);
    expect(current.moves.some(move => move.field === 'current.rig')).toBe(false);
    expect(current.moves).toContainEqual(expect.objectContaining({ field: 'current.motion',
      command: expect.stringContaining('rigc render --candidate outputs/v1/out/check/build') }));
    expect(current.moves.find(move => move.field === 'current.direction')?.act).toContain('SCENE_CURRENT_MOTION_REQUIRED');
    expect(readFileSync(recordPath)).toEqual(adoptedBytes);

    const secondBounce = join(dir, 'evidence/direction-bounce-follow-up.txt');
    writeFileSync(secondBounce, 'Keep the framing steady at the end.\n');
    testClock.set(TEST_NOW + 4_000);
    seedStoredVerdict(dir, 3, { review: 'direction-review', verdict: 'bounced', by: 'user',
      at: testClock.now(), verbatim: readFileSync(secondBounce, 'utf8'), source: 'synthetic review' });
    const repeatedBytes = readFileSync(recordPath);
    expectDeferredDirectionFeedback(dir, 3, 0, 1);
    expect(readFileSync(recordPath)).toEqual(repeatedBytes);
  } finally {
    testClock.reset();
  }
});

test('#1114 next offers adoption and a render from the adopted rig when current-path post needs motion', () => {
  const dir = join(tempDir('next-adopted-rig-motion-'), 'project');
  cpSync(join(import.meta.dir, '../templates/example-current'), dir, { recursive: true });
  const recordPath = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(recordPath, 'utf8')) as JsonObject;
  const current = obj(project.current);
  project.stage = 'post';
  project.advances = arr(project.advances).slice(0, -2);
  const retainSignoff = (row: JsonObject) => !['rig-review', 'post-interview', 'direction-review'].includes(String(row.stage));
  project.signoffs = arr(project.signoffs).map(obj).filter(retainSignoff);
  for (const advance of arr(project.advances).map(obj)) {
    advance.signoffs_before = arr(advance.signoffs_before).map(obj).filter(retainSignoff);
    if (advance.signoff !== null && !retainSignoff(obj(advance.signoff))) advance.signoff = null;
  }
  // Keep the post picks and their shown rig snapshot without the optional rig signature.
  for (const item of arr(obj(obj(project.interview).post).items).map(obj)) {
    const binding = obj(obj(obj(item.guide).choice).set);
    const path = join(dir, String(binding.path));
    const set = JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
    delete obj(set.context).signoff_at;
    const bytes = `${JSON.stringify(set, null, 2)}\n`;
    writeFileSync(path, bytes);
    binding.sha256 = sha256(bytes);
  }
  for (const step of arr(obj(project.plan).steps).map(obj)) {
    if (step.phase !== 'post') continue;
    step.status = 'in-progress';
    step.status_history = arr(step.status_history).slice(0, 1);
  }
  delete current.motion;
  delete current.direction;
  rmSync(join(dir, 'specs/motion/loop-seam.json'), { force: true });
  const save = () => writeFileSync(recordPath, `${JSON.stringify(project, null, 2)}\n`);
  const motionMoves = () => {
    const report = JSON.parse(nextCommand([dir, '--json'], TEST_NOW).stdout) as NextReport;
    expect(report).toMatchObject({ stage: 'post', effective_stage: 'post', refusals: [] });
    expect(report.open_direction_comments).toBeUndefined();
    expect(report.moves.some(move => move.field === 'current.rig')).toBe(false);
    return report.moves.filter(move => move.field === 'current.motion');
  };
  const render = (build: string) => `(cd ${dir} && rigc render --candidate ${build} --out outputs/motion.next --animation idle --fps '<frames-per-second>')`;
  save();
  expect(motionMoves().map(move => move.command)).toEqual([render('outputs/rig/check/build')]);

  const build = 'outputs/v1/out/check/build';
  const idle = 'outputs/v1/idle';
  mkdirSync(join(dir, dirname(build)), { recursive: true });
  cpSync(join(dir, 'outputs/rig/check/build'), join(dir, build), { recursive: true });
  cpSync(join(dir, 'outputs/motion'), join(dir, idle), { recursive: true });
  project.versions = [{ n: 1, kind: 'rig', pre_interview: true, original_n: 1, original_verdicts: [], verdicts: [],
    at: '2026-11-01T00:00:00.000Z', built_by: 'agent', built_with: {}, outputs: [...treeFiles(dir, build), ...treeFiles(dir, idle)] }];
  delete current.rig;
  save();
  expect(recordCommand(['rig', dir, '--adopt'], TEST_NOW).exit).toBe(0);
  expect(motionMoves().map(move => [move.role, move.command])).toEqual([
    ['agent', `rig-create record motion --adopt ${dir}`],
    ['producer', render(build)],
  ]);
});

test('#1111 next routes an adopted direction redo and its offered writer closes the numbered comment', async () => {
  const dir = join(tempDir('next-all-adopted-direction-'), 'project');
  const chain = join(import.meta.dir, '../templates/example-chain');
  const donor = join(import.meta.dir, '../templates/example-remesh');
  cpSync(chain, dir, { recursive: true });
  const read = (path = 'project.json', root = dir): JsonObject => JSON.parse(readFileSync(join(root, path), 'utf8')) as JsonObject;
  const put = (path: string, value: JsonObject): string => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(dir, path), bytes);
    return sha256(bytes);
  };
  const words = join(dir, 'evidence/direction-cycle-words.txt');
  const say = (quote: string): string[] => {
    writeFileSync(words, `${quote}\n`);
    return ['--by', 'user', ...ownerChatArgs(words)];
  };
  let now = TEST_NOW;
  const tick = (): void => { testClock.set(++now); };
  try {
    // Remesh v2 uses the same painting, assembled parts and rig config as chain v1.
    const source = join(donor, 'outputs/v2');
    const evidence = join(donor, 'evidence/v2/registration');
    for (const [oldPath, newPath] of [['inputs/painting.png', 'inputs/painting.png'],
      ['outputs/v1/out/parts.json', 'outputs/v2/out/parts.json'],
      ['evidence/v1/config.json', 'evidence/v2/registration/config-source.json']] as const) {
      expect(readFileSync(join(chain, oldPath))).toEqual(readFileSync(join(donor, newPath)));
    }
    const amendmentAt = Date.parse(String(read('evidence/v2/registration/at-source.json', donor).finished_at)) - 1_000;
    expect(amendmentAt).toBeGreaterThan(Date.parse(String(obj(arr(read().advances).at(-1)).at)));
    testClock.set(amendmentAt);
    const change = 'evidence/direction-rig-rebuild.json';
    put(change, { reason: 'Register the rig again with its frozen idle and producer receipts.' });
    expect(amendCommand(['rig-review', dir, '--kind', 'motion-track', '--target', 'motion', '--change', change,
      ...say('Review the rebuilt rig and revisit the direction answers.')]).exit).toBe(0);

    tick();
    const citationsPath = 'evidence/direction-rig-citations.json';
    put(citationsPath, obj(obj(obj(arr(read().versions)[0]).provenance).sections));
    expect(rigVersionCommand(['3', dir, '--parts', join(source, 'out'), '--rig', join(source, 'out/rig'),
      '--build', join(source, 'out/check/build'), '--idle', join(source, 'idle'), '--config', join(evidence, 'config-source.json'),
      '--path-adapter', join(evidence, 'path-adapter.json'), '--compile-report', join(evidence, 'compile-report.json'),
      '--toolchain-lock', join(evidence, 'package-lock.json'), '--check-report', join(evidence, 'check.json'),
      '--run-record', join(evidence, 'rigc-run-1.json'), '--at-source', join(evidence, 'at-source.json'),
      '--at-pointer', '/finished_at', '--citations', citationsPath, '--by', 'agent']).exit).toBe(0);
    tick();
    writeFileSync(words, 'Approve the rebuilt synthetic rig.\n');
    seedStoredVerdict(dir, 3, { review: 'rig-review', verdict: 'accepted', by: 'user',
      at: testClock.now(), verbatim: readFileSync(words, 'utf8'), source: 'synthetic review' });
    tick();
    seedStoredVersionSignoff(dir, 'rig-review', 3, { by: 'user', at: testClock.now(), verbatim: readFileSync(words, 'utf8') });
    expect(checkProject(dir)).toMatchObject({ effective_stage: 'post-interview', refusals: [] });

    const composition: JsonObject = {
      canvas: { width: 128, height: 128 }, plates: [{ name: 'background', image: 'inputs/background.png', at: [0, 0], opaque_backdrop: true }],
      order: ['background', 'actor'], character: { offset: [0, 0], scale: 1 }, idle_tracks: [],
    };
    const postGoals: [string, string, string, JsonObject?][] = [
      ['camera', 'camera_depth', 'Keep the existing push-in.'],
      ['timing', 'post_timing', 'Loop the four-second take.', { seconds: 4, loop: true, beats: [] }],
      ['composition', 'post_composition', 'Keep the background plate still.', { compose: composition }],
    ];
    const citations: JsonObject = {};
    for (const [section, question, quote, fragment] of postGoals) {
      tick();
      const set = read(`evidence/interview/${question}.json`);
      set.id = `${question}-new-take`;
      set.drafted_at = testClock.iso();
      set.context = optionContext(read(), 'post-interview', testClock.now(), dir);
      const keep = arr(obj(arr(set.asks)[0]).options).map(obj).find(option => option.id === 'keep')!;
      keep.label = quote;
      if (fragment !== undefined) keep.fragment = fragment;
      const setPath = `evidence/interview/${set.id}.json`;
      const setHash = put(setPath, set);
      interviewOptionsCommand([question, dir, '--file', setPath]);
      tick();
      interviewAnswerCommand([question, dir, '--set', setPath, '--sha256', setHash, '--pick', `${question}=keep`, ...say(quote)]);
      const post = obj(obj(read().interview).post);
      const guide = obj(arr(post.items).map(obj).find(item => item.id === question)?.guide);
      citations[section] = { guide: question, asks: [question], quote: guide.verbatim! };
      tick();
      expect(planCommand(['revise', section, dir, '--by', 'agent', '--does', quote]).exit).toBe(0);
    }
    tick();
    expect(signoffCommand(['post-interview', dir, ...say('Use the three revised direction choices.')]).exit).toBe(0);

    // Partial numbered adoption at post must preserve offers for whichever input is still missing.
    const recordPath = join(dir, 'project.json');
    const next = (): NextReport => JSON.parse(nextCommand([dir, '--json'], testClock.now()).stdout) as NextReport;
    const beforePostAdoption = readFileSync(recordPath);
    expect(recordCommand(['rig', dir, '--adopt'], testClock.now()).exit).toBe(0);
    const missingMotion = next();
    expect(missingMotion).toMatchObject({ effective_stage: 'post', refusals: [] });
    expect(missingMotion.open_direction_comments).toBeUndefined();
    expect(missingMotion.moves.filter(move => move.field === 'current.motion').map(move => move.command)).toEqual([
      `rig-create record motion --adopt ${dir}`,
      `rig-create record motion ${dir} --from outputs/motion.next`,
    ]);
    expect(missingMotion.moves.some(move => move.field === 'current.rig')).toBe(false);
    expect(recordCommand(['motion', dir, '--adopt'], testClock.now()).exit).toBe(0);
    const bothRecorded = next();
    expect(bothRecorded).toMatchObject({ effective_stage: 'post', refusals: [] });
    expect(bothRecorded.moves.some(move => move.field === 'current.rig' || move.field === 'current.motion')).toBe(false);
    writeFileSync(recordPath, beforePostAdoption);
    expect(recordCommand(['motion', dir, '--adopt'], testClock.now()).exit).toBe(0);
    const missingRig = next();
    expect(missingRig).toMatchObject({ effective_stage: 'post', refusals: [] });
    expect(missingRig.moves).toContainEqual(expect.objectContaining({ field: 'current.rig', command: `rig-create record rig --adopt ${dir}` }));
    expect(missingRig.moves.some(move => move.field === 'current.motion')).toBe(false);
    writeFileSync(recordPath, beforePostAdoption);

    // Supply the same synthetic compose receipt shape as the compose writer tests.
    const scenePath = 'compose-revision.scene.json';
    const plate = obj(arr(composition.plates)[0]);
    const placement = { id: 'actor', build: 'outputs/v3/out', ...obj(composition.character) };
    const scene: JsonObject = { spec: 'spine-parts-scene/1', canvas: composition.canvas!, order: composition.order!,
      plates: [{ ...plate, provenance: 'generated' }], characters: [placement], animations: { idle: { duration: 4, tracks: [] } } };
    put(scenePath, scene);
    const out = 'compose-revision';
    put(`${out}/scene.json`, { spec: 'spine-parts-scene-report/1', scene: scenePath, canvas: composition.canvas!,
      characters: [{ ...placement, rig_size: [128, 128], shift: [0, 0] }],
      plates: [{ ...plate, sha256: sha256(readFileSync(join(dir, String(plate.image)))) }] });
    put(`${out}/compose-run.json`, composeRunFixture(dir, read(), 3, scene, scenePath));
    put(`${out}/check/check.json`, { spec: 'rig-parts-check/1', PASS: true, gate_spine_html_green: true });
    put(`${out}/check/build/skeleton.model.json`, { spec: 'rigc-compiled/3', stage: { x: -64, y: 0, width: 128, height: 128 },
      animations: [{ name: 'idle', duration: 4 }], pages: [] });
    const frozen = 'outputs/v4/compose';
    const placeholder = (path: string) => ({ path, sha256: '0'.repeat(64) });
    const intent = 'evidence/direction-compose-revision.json';
    put(intent, { schema: 'rig-create/direction@3', rig: { version: 3 }, take: { duration: 4, loop: true }, citations,
      compose: { scene: placeholder('evidence/compose-src/v4/scene.json'), out: frozen, report: placeholder(`${frozen}/scene.json`),
        check: placeholder(`${frozen}/check/check.json`), run: placeholder(`${frozen}/compose-run.json`) },
      model: placeholder(`${frozen}/check/build/skeleton.model.json`) });
    tick();
    expect(directionCommand(['write', '4', dir, '--file', intent, '--rig', '3', '--compose-out', out, '--compose-scene', scenePath]).exit).toBe(0);
    for (const [section] of postGoals) for (const status of ['in-progress', 'at-checkpoint', 'done']) {
      tick();
      expect(stepStatusCommand([section, status, dir, '--by', 'agent']).exit).toBe(0);
    }
    tick();
    const bounceWords = 'Give the camera move more time.\n';
    const bouncedAt = testClock.iso();
    writeFileSync(words, bounceWords);
    seedStoredVerdict(dir, 4, { review: 'direction-review', verdict: 'bounced', by: 'user',
      at: bouncedAt, verbatim: bounceWords, source: 'synthetic review' });

    const host = await openCreateJob(dir, { id: 'user', role: 'owner' }, testClock.now());
    try {
      expect(readWriterBinding(dir)).not.toBeNull();
      tick();
      await closeCreateJob(dir, undefined, false, undefined, testClock.now());
      expect(readWriterBinding(dir)).toBeNull();
    } finally {
      host.stop();
    }
    const versions = read().versions;
    for (const kind of ['parts', 'rig', 'motion', 'direction']) {
      tick();
      expect(recordCommand([kind, dir, '--adopt'], testClock.now()).exit).toBe(0);
    }
    expect(directionCommand(['--adopt', dir]).exit).toBe(0);
    expect(correctionCommand(['--adopt', dir]).exit).toBe(0);
    expect(read()).toMatchObject({ versions, current: { parts: { adopted: { version: 3 } }, rig: { adopted: { version: 3 } },
      motion: { adopted: { version: 3 } }, direction: { adopted: { version: 4 } } } });
    const path = 'versions[v4].verdicts[0]';
    const openComment: OpenDirectionComment = { field: 'current.direction', verdict: path, by: 'user', at: bouncedAt,
      source: 'synthetic review', verbatim: bounceWords, on_items: [] };
    const checked = checkProject(dir);
    expect(checked).toMatchObject({ stage: 'accepted', effective_stage: 'direction-review', refusals: [] });
    expect(checked.warnings).toContainEqual(expect.objectContaining({ code: 'FEEDBACK_OPEN', path }));
    expect(checked.feedback.flatMap(feedback => feedback.open_direction_comment ?? [])).toEqual([openComment]);
    // Proof remains optional in old rows. Derive it again from the accepted registration and its retained bytes.
    const adopted = read();
    delete obj(obj(adopted.current).motion).provenance;
    put('project.json', adopted);
    const original = readFileSync(recordPath);
    const retained = treeFiles(dir, 'outputs');
    const staging = next();
    expectDirectionOnly(staging);
    expect(staging.open_direction_comments).toEqual([openComment]);
    expect(staging.warnings?.some(warning => warning.code === 'OUTPUT_STALE' && ['current.rig', 'current.motion'].includes(warning.path))).toBe(false);
    expect(staging.moves).toContainEqual(expect.objectContaining({ field: 'current.direction', command: `rig-create scene stage-adopted ${dir}`,
      act: expect.stringContaining('project.json.versions[v4].verdicts[0]') }));

    for (const path of ['outputs/v3/out/rig/images/unbound.png', 'outputs/v3/idle/idle@1fps/f9999.png']) {
      const extra = join(dir, path);
      writeFileSync(extra, 'Unregistered fixture bytes.\n');
      const unverified = next();
      expect(unverified).toMatchObject({ accepted: false, refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'RIG_REGISTRATION_FILE_INVALID' }),
      ]) });
      expect(unverified.moves.some(move => move.field.startsWith('current.') || move.command?.startsWith('rig-create scene '))).toBe(false);
      rmSync(extra);
    }

    const build = 'derived/direction-adopted-build';
    const staged = sceneCommand(['stage-adopted', dir]);
    expect(staged.exit).toBe(0);
    expect(staged.stdout).toContain('staged adopted v3');
    expect(sceneCommand(['stage-adopted', dir])).toEqual(staged);
    expect(readFileSync(join(dir, build, 'check/check.json'))).toEqual(readFileSync(join(dir, 'evidence/v3/registration/check.json')));
    const composeScene = 'specs/direction/compose-scene.json';
    const author = next();
    expectDirectionOnly(author);
    expect(author.moves).toContainEqual(expect.objectContaining({ command: `rig-create scene write ${dir} --compose-scene ${composeScene}`,
      act: expect.stringContaining('characters[0].build to ../../derived/direction-adopted-build') }));
    const composePlate = { ...plate, image: '../../inputs/background.png', provenance: 'generated' };
    const composeCharacter = { ...placement, build: `../../${build}` };
    const composeSceneHash = put(composeScene, { ...scene, plates: [composePlate], characters: [composeCharacter] });
    expect(sceneCommand(['write', dir, '--compose-scene', composeScene]).exit).toBe(0);
    const sceneRecord = read('specs/direction/scene.json');
    expect(sceneRecord).toMatchObject({ rig: {
      model: { path: 'outputs/v3/out/check/build/skeleton.model.json' },
      animation: { frames: { path: 'outputs/v3/idle/frames.json' }, motion: { path: 'outputs/v3/idle' } },
    } });
    const directionIntent = 'specs/direction/intent.json';
    expect(next().moves).toContainEqual(expect.objectContaining({ command: `rig-create direction write ${dir} --file ${directionIntent}` }));
    put(directionIntent, { take: { duration: 4, loop: true }, citations });
    expect(directionCommand(['write', dir, '--file', directionIntent]).exit).toBe(0);
    const compose = next();
    expectDirectionOnly(compose);
    expect(compose.moves).toContainEqual(expect.objectContaining({ field: 'current.direction',
      command: expect.stringContaining(`rig-parts compose --scene ${composeScene} --out outputs/direction.next`),
      act: expect.stringContaining('project.json.versions[v4].verdicts[0]') }));
    const stagedCheck = join(dir, build, 'check/check.json');
    const stagedCheckBytes = readFileSync(stagedCheck);
    writeFileSync(stagedCheck, '{}');
    expect(next().moves).toContainEqual(expect.objectContaining({ command: `rig-create scene stage-adopted ${dir}` }));
    expect(() => sceneCommand(['stage-adopted', dir])).toThrow(expect.objectContaining({ code: 'ADOPTED_COMPOSE_STAGE_INVALID' }));
    expect(readFileSync(stagedCheck, 'utf8')).toBe('{}');
    expect(readFileSync(recordPath)).toEqual(original);
    expect(treeFiles(dir, 'outputs')).toEqual(retained);
    writeFileSync(stagedCheck, stagedCheckBytes);

    // Stage a synthetic Parts receipt for the newly sealed scene, with its real input hashes.
    const from = 'outputs/direction.next';
    const modelPath = 'check/build/skeleton.model.json';
    const modelHash = put(`${from}/${modelPath}`, read(`${frozen}/${modelPath}`));
    const plateHash = sha256(readFileSync(join(dir, String(plate.image))));
    const consumedFiles = treeFiles(dir, build)
      .map(({ path, sha256 }) => ({ path: path.slice(build.length + 1), sha256 }))
      .filter(({ path }) => ['check/check.json', 'parts.json', 'rig/rig.json', 'rig/motion.json'].includes(path) || path.startsWith('rig/images/'));
    put(`${from}/scene.json`, { spec: 'spine-parts-scene-report/1', scene: composeScene, canvas: composition.canvas!,
      characters: [{ ...composeCharacter, rig_size: [128, 128], shift: [0, 0] }], plates: [{ ...composePlate, sha256: plateHash }] });
    put(`${from}/compose-run.json`, { spec: 'rig-compose-run/1', scene: { path: composeScene, sha256: composeSceneHash },
      characters: [{ id: 'actor', build: composeCharacter.build, files: consumedFiles }], plate: null,
      plates: [{ name: plate.name!, path: composePlate.image, sha256: plateHash }] });
    put(`${from}/check/check.json`, { spec: 'rig-parts-check/1', PASS: true, gate_spine_html_green: true,
      build: { model_sha256: modelHash } });

    const recording = next();
    expectDirectionOnly(recording);
    expect(recording.open_direction_comments).toEqual([openComment]);
    const command = recording.moves.find(move => move.field === 'current.direction')?.command;
    expect(command).toBe(`rig-create record direction ${dir} --from ${from} --direction specs/direction/direction.json --answers-feedback 4:0`);
    tick();
    expect(recordCommand(command!.split(' ').slice(2), testClock.now()).exit).toBe(0);

    const saved = read();
    expect(obj(obj(saved.current).direction).answers_feedback).toEqual([{ version: 4, verdict: 0 }]);
    expect(saved.versions).toEqual(versions);
    expect(treeFiles(dir, 'outputs').filter(file => !file.path.startsWith('outputs/direction/'))).toEqual(retained);
    const closed = checkProject(dir);
    expect(closed.refusals).toEqual([]);
    expect(closed.warnings.some(finding => finding.code === 'FEEDBACK_OPEN' && finding.path === path)).toBe(false);
    expect(closed.feedback.find(feedback => feedback.verdict === path)).toMatchObject({ answered_by_current_direction: true, withdrawn: false });
    expect(closed.feedback.flatMap(feedback => feedback.open_direction_comment ?? [])).toEqual([]);
    expect(next().open_direction_comments).toBeUndefined();
  } finally {
    testClock.reset();
  }
});
