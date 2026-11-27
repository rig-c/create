import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';
import { asArray, checkProject, isObject } from '../src/check.ts';
import { COMPOSE_CHECK_PATH, COMPOSE_RUN_PATH, CURRENT_DIRECTION_PATH } from '../src/current-direction.ts';
import { CURRENT_MOTION_FRAMES, CURRENT_RIG_MODEL, currentShapeFindings, outputRoot, outputSetHash, sha256, treeFiles } from '../src/current.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { reviewCommand } from '../src/feedback.ts';
import { LOOP_SEAM_REPORT_SINCE } from '../src/motion-loop-seam.ts';
import { nextProject } from '../src/next.ts';
import { recordCommand } from '../src/record.ts';
import { CURRENT_SCENE_PATH } from '../src/scene.ts';
import { sceneCommand } from '../src/scene-writers.ts';
import type { JsonObject } from '../src/templates.ts';
import { testClock } from './clock.ts';
import { composeFixture } from './direction-compose-fixture.ts';
import { fixture } from './fixtures.ts';
import { keepTempDirs, run } from './helpers.ts';
import { sceneFixture } from './scene-fixture.ts';

afterEach(() => testClock.reset());

const motionFrom = 'outputs/motion.next';
const motionRoot = outputRoot('motion');
const motionPng = `${motionRoot}/idle@1fps/f0000.png`;
const directionFrom = 'outputs/direction.next';
const partsScene = 'specs/direction/compose-scene.json';
const intentPath = 'evidence/direction-intent.json';
const write = (dir: string, path: string, value: string | JsonObject): void => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
};
const raw = (dir: string, path: string): Buffer => readFileSync(join(dir, path));
const json = (dir: string, path: string): JsonObject => JSON.parse(raw(dir, path).toString()) as JsonObject;
const binding = (dir: string, path: string) => ({ path, sha256: sha256(raw(dir, path)) });
const recordMotion = (dir: string) => recordCommand(['motion', dir, '--from', motionFrom, '--json'], testClock.now());
const recordDirection = (dir: string, ...flags: string[]) =>
  recordCommand(['direction', dir, '--from', directionFrom, '--direction', CURRENT_DIRECTION_PATH, '--json', ...flags], testClock.now());
const check = (dir: string) => checkProject(dir, undefined, { now: testClock.now() });

function currentRig(f: { dir: string; model: JsonObject; load: () => JsonObject; save: (value: JsonObject) => void }): void {
  write(f.dir, CURRENT_RIG_MODEL, f.model);
  write(f.dir, 'outputs/rig/check/build/skeleton.json', '{}');
  write(f.dir, 'outputs/rig/check/build/skeleton.atlas', 'atlas bytes');
  write(f.dir, 'outputs/rig/run.json', '{}');
  write(f.dir, 'outputs/rig/check/check.json', { spec: 'rig-parts-check/1', PASS: true });
  write(f.dir, 'outputs/rig/rig.json', '{"synthetic":"current rig"}');
  write(f.dir, 'outputs/rig/motion.json', '{"synthetic":"current motion"}');
  write(f.dir, 'outputs/rig/images/body.png', 'current body');
  const files = treeFiles(f.dir, 'outputs/rig');
  const project = f.load();
  project.current = { rig: { at: testClock.iso(), built_by: 'agent', built_with: {},
    files, files_sha256: outputSetHash(files), built_from: [], run: binding(f.dir, 'outputs/rig/run.json'),
    report: binding(f.dir, 'outputs/rig/check/check.json'), rebuild: { recorded: false, note: 'synthetic rig producer' } } };
  f.save(project);
}

function render(dir: string, stamped: boolean): JsonObject {
  write(dir, `${motionFrom}/frames.json`, { spec: 'rigc-frames/1', sets: [{ dir: 'idle@1fps', animation: 'idle', fps: 1, sampled: 2, written: 2, stride: 1 }] });
  write(dir, `${motionFrom}/idle@1fps/f0000.png`, 'synthetic frame');
  const run: JsonObject = { spec: 'rigc-run/2', package: { name: '@rig-c/core', version: '3.8.1' }, command: 'render',
    argv: ['--candidate', '../rig/check/build', '--out', '.', '--animation', 'idle'],
    started_at: '2026-11-25T00:00:00.000Z', finished_at: '2026-11-25T00:00:01.000Z',
    inputs: ['skeleton', 'atlas', 'model'].map((role, index) => {
      const file = ['skeleton.json', 'skeleton.atlas', 'skeleton.model.json'][index]!;
      return { role, path: `../rig/check/build/${file}`, sha256: binding(dir, `outputs/rig/check/build/${file}`).sha256 };
    }),
    outputs: treeFiles(dir, motionFrom).map(({ path, sha256 }) => ({ path: path.slice(motionFrom.length + 1), sha256 })),
  };
  if (stamped) write(dir, `${motionFrom}/render-run.json`, run);
  return run;
}

test.each([true, false])('record motion binds the frame tree with producer receipt present=%s', stamped => {
  const f = sceneFixture();
  currentRig(f);
  render(f.dir, stamped);
  const before = f.load();
  const result = recordMotion(f.dir);
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain('PROJECT_NOT_IN_GIT');
  const node = JSON.parse(result.stdout) as JsonObject;
  expect(node.report).toBeUndefined();
  expect(node.rebuild).toEqual(stamped ? { recorded: true, runs: [expect.objectContaining({ spec: 'rigc-run/2', ...binding(f.dir, 'outputs/motion/render-run.json') })] }
    : { recorded: false, note: expect.any(String) });
  if (stamped) expect(node.run).toEqual(binding(f.dir, 'outputs/motion/render-run.json'));
  else expect(node.run).toBeUndefined();
  expect(node.built_from).toContainEqual(binding(f.dir, CURRENT_RIG_MODEL));
  expect(node.files).toContainEqual({ ...binding(f.dir, CURRENT_MOTION_FRAMES), bytes: raw(f.dir, CURRENT_MOTION_FRAMES).length });
  expect(currentShapeFindings('motion', node)).toEqual([]);
  expect(existsSync(join(f.dir, motionFrom))).toBe(false);
  expect(f.load().versions).toEqual(before.versions);
  expect(check(f.dir).warnings.some(f => f.code === 'REBUILD_ARGS_UNRECORDED' && f.path === 'current.motion.rebuild')).toBe(!stamped);
});

const seamSpec = 'specs/motion/loop-seam.json';
const seamBudget = { channel_delta: 8, pixels_above: 0, warmup_cap: 12 };
const stagedSeamPath = `${motionFrom}/idle@1fps/loop-seam.json`;

function seamReport(dir: string, status: 'met' | 'unjudged', pixelsAbove = 0): void {
  write(dir, `${motionFrom}/idle@1fps/loop-wrap.png`, 'synthetic wrap frame');
  const endpoint = (name: string, time: number) => {
    const path = `idle@1fps/${name}`;
    return { path, time, sha256: binding(dir, `${motionFrom}/${path}`).sha256 };
  };
  write(dir, stagedSeamPath, {
    spec: 'rigc-loop-seam/1', animation: 'idle', fps: 1, period: 0.9, status, warmup: 0,
    first: endpoint('f0000.png', 0), wrap: { ...endpoint('loop-wrap.png', 0.9), encoding: 'png' },
    ...(status === 'met' ? { bar: { channelDelta: 8, pixelsAbove: 0 }, cap: 12, pixelsAbove } : {}),
  });
}

test('#1073 a missing requested motion verdict warns before the contract date and refuses from that date', () => {
  const f = sceneFixture();
  currentRig(f);
  render(f.dir, false);
  expect(recordMotion(f.dir).exit).toBe(0);
  write(f.dir, seamSpec, seamBudget);
  const project = f.load();
  const motion = (project.current as JsonObject).motion as JsonObject;
  motion.at = new Date(LOOP_SEAM_REPORT_SINCE).toISOString();
  f.save(project);
  expect(check(f.dir).refusals.map(finding => finding.code)).toContain('MOTION_LOOP_SEAM_MISSING');
  motion.at = new Date(Date.parse(LOOP_SEAM_REPORT_SINCE) - 1).toISOString();
  f.save(project);
  expect(check(f.dir).warnings.map(finding => finding.code)).toContain('MOTION_LOOP_SEAM_MISSING');
  const original = raw(f.dir, 'project.json');
  render(f.dir, false);
  expect(() => recordMotion(f.dir)).toThrow(expect.objectContaining({ code: 'MOTION_LOOP_SEAM_MISSING' }));
  seamReport(f.dir, 'unjudged');
  expect(() => recordMotion(f.dir)).toThrow(expect.objectContaining({ code: 'MOTION_LOOP_SEAM_UNJUDGED' }));
  seamReport(f.dir, 'met', 1);
  expect(() => recordMotion(f.dir)).toThrow(expect.objectContaining({ code: 'MOTION_LOOP_SEAM_OVER_BAR' }));
  expect(raw(f.dir, 'project.json')).toEqual(original);
  expect(existsSync(join(f.dir, stagedSeamPath))).toBe(true);
});

test('#1073 motion records producer seam hashes and check detects drift of either endpoint', () => {
  const f = sceneFixture();
  currentRig(f);
  write(f.dir, seamSpec, seamBudget);
  render(f.dir, false);
  seamReport(f.dir, 'met');
  const expected = binding(f.dir, stagedSeamPath).sha256;
  const result = recordMotion(f.dir);
  expect(result.exit).toBe(0);
  expect((JSON.parse(result.stdout) as JsonObject).files).toContainEqual(expect.objectContaining({
    path: 'outputs/motion/idle@1fps/loop-seam.json', sha256: expected,
  }));
  expect([...check(f.dir).refusals, ...check(f.dir).warnings].filter(finding => finding.code.startsWith('MOTION_LOOP_SEAM_'))).toEqual([]);
  write(f.dir, 'outputs/motion/idle@1fps/loop-wrap.png', 'different wrap');
  expect(check(f.dir).refusals.map(finding => finding.code)).toContain('MOTION_LOOP_SEAM_INVALID');
});

test('#1073 motion can retain an unjudged measurement without a declared budget', () => {
  const f = sceneFixture();
  testClock.set(LOOP_SEAM_REPORT_SINCE);
  currentRig(f);
  render(f.dir, false);
  seamReport(f.dir, 'unjudged');
  expect(recordMotion(f.dir).exit).toBe(0);
  expect(check(f.dir).warnings.map(finding => finding.code)).toContain('MOTION_LOOP_SEAM_UNJUDGED');
  write(f.dir, seamSpec, seamBudget);
  expect(check(f.dir).refusals.map(finding => finding.code)).toContain('MOTION_LOOP_SEAM_UNJUDGED');
});

test('#1029 first record motion migrates the legacy pattern without contaminating JSON stdout', () => {
  const f = sceneFixture();
  currentRig(f);
  render(f.dir, false);
  write(f.dir, '.gitignore', '# before\r\n/outputs/\r\n# after\n');
  const first = recordMotion(f.dir);
  expect(first.exit).toBe(0);
  expect(first.stderr?.split('\n')[0]).toBe('gitignore: /outputs/ -> /outputs/* !/outputs/parts/');
  expect(JSON.parse(first.stdout)).toEqual((f.load().current as JsonObject).motion);
  expect(raw(f.dir, '.gitignore').toString()).toBe('# before\r\n/outputs/*\r\n!/outputs/parts/\r\n# after\n');
  const repeat = recordCommand(['motion', f.dir, '--from', motionRoot, '--json'], testClock.now());
  expect(repeat.stderr).toContain('PROJECT_NOT_IN_GIT');
  expect(repeat.stderr).not.toContain('GITIGNORE_PATTERN_ABSENT');
  expect(repeat.stderr).not.toContain('gitignore:');
});

test('motion run and optional report must match files, and rebuild takes only rigc-run/2', () => {
  const f = sceneFixture();
  currentRig(f);
  render(f.dir, true);
  const node = JSON.parse(recordMotion(f.dir).stdout) as JsonObject;
  const fake = { ...binding(f.dir, CURRENT_MOTION_FRAMES), sha256: '0'.repeat(64) };
  expect(currentShapeFindings('motion', { ...node, report: binding(f.dir, CURRENT_MOTION_FRAMES) })).toEqual([]);
  expect(currentShapeFindings('motion', { ...node, report: fake })).toEqual([expect.objectContaining({ code: 'CURRENT_MALFORMED', path: 'current.motion.report' })]);
  expect(currentShapeFindings('motion', { ...node, run: fake })).toEqual([expect.objectContaining({ code: 'CURRENT_MALFORMED', path: 'current.motion.run' })]);
  const { run, ...unbound } = node;
  expect(currentShapeFindings('motion', unbound)).toEqual([expect.objectContaining({ code: 'CURRENT_MALFORMED', path: 'current.motion.run' })]);
  expect(currentShapeFindings('motion', { ...node, rebuild: { recorded: false, note: 'no argv' } })).toEqual([expect.objectContaining({ code: 'CURRENT_MALFORMED', path: 'current.motion.run' })]);
  expect(currentShapeFindings('motion', { ...node, rebuild: { recorded: true, runs: [{ ...run as JsonObject, spec: 'rig-run/2', argv: ['build'] }] } }))
    .toEqual([expect.objectContaining({ code: 'CURRENT_MALFORMED', path: 'current.motion.rebuild.runs[0].spec' })]);
});

test('a present bad render receipt refuses with the old record and both output trees intact', () => {
  const f = sceneFixture();
  currentRig(f);
  render(f.dir, false);
  recordMotion(f.dir);
  const run = render(f.dir, true);
  (run.outputs as JsonObject[])[0]!.sha256 = 'a'.repeat(64);
  write(f.dir, `${motionFrom}/render-run.json`, run);
  const original = raw(f.dir, 'project.json');
  const current = treeFiles(f.dir, 'outputs/motion');
  const staged = treeFiles(f.dir, motionFrom);
  expect(() => recordMotion(f.dir)).toThrow(expect.objectContaining({ code: 'RECORD_RUN_INVALID' }));
  expect(raw(f.dir, 'project.json')).toEqual(original);
  expect(treeFiles(f.dir, 'outputs/motion')).toEqual(current);
  expect(treeFiles(f.dir, motionFrom)).toEqual(staged);
});

test('scene write binds the current model and matching frames, and still requires the owner plate choice', () => {
  const f = sceneFixture();
  currentRig(f);
  render(f.dir, false);
  recordMotion(f.dir);
  const args = ['write', f.dir, '--background', 'background.png', '--citations-file', 'background-citation.json'];
  const original = raw(f.dir, 'project.json');
  expect(sceneCommand(args, testClock.now()).exit).toBe(0);
  const authored = raw(f.dir, CURRENT_SCENE_PATH);
  expect(json(f.dir, CURRENT_SCENE_PATH).rig).toEqual({ model: binding(f.dir, CURRENT_RIG_MODEL),
    animation: { name: 'idle', frames: binding(f.dir, CURRENT_MOTION_FRAMES),
      motion: { path: motionRoot, sha256: outputSetHash(treeFiles(f.dir, motionRoot)) } } });
  expect(() => sceneCommand([...args, '--background-rect', '-63,5,128,128'], testClock.now()))
    .toThrow(expect.objectContaining({ code: 'SCENE_CHOICE_MISMATCH' }));
  expect(raw(f.dir, CURRENT_SCENE_PATH)).toEqual(authored);
  expect(raw(f.dir, 'project.json')).toEqual(original);
});

function stagedDirection(f: ReturnType<typeof composeFixture>): void {
  const files = ['check/check.json', 'rig/rig.json', 'rig/motion.json', 'rig/images/body.png'];
  const stage = 'derived/compose-input';
  for (const path of files) {
    const current = `outputs/rig/${path.replace(/^rig\//, '')}`;
    mkdirSync(dirname(join(f.dir, stage, path)), { recursive: true });
    cpSync(join(f.dir, current), join(f.dir, stage, path));
  }
  write(f.dir, `${stage}/parts.json`, '{}');
  const scene = structuredClone(f.scene);
  (scene.characters as JsonObject[])[0]!.build = '../../derived/compose-input';
  for (const plate of scene.plates as JsonObject[]) plate.image = `../../${String(plate.image)}`;
  write(f.dir, partsScene, scene);
  sceneCommand(['write', f.dir, '--compose-scene', partsScene], testClock.now());
  write(f.dir, intentPath, { take: f.doc.take!, citations: f.doc.citations! });
  directionCommand(['write', f.dir, '--file', intentPath], testClock.now());
  write(f.dir, `${directionFrom}/check/build/skeleton.model.json`, f.model);
  write(f.dir, `${directionFrom}/${COMPOSE_CHECK_PATH}`, { spec: 'rig-parts-check/1', PASS: true, gate_spine_html_green: true,
    build: { model_sha256: binding(f.dir, `${directionFrom}/check/build/skeleton.model.json`).sha256 } });
  const report = structuredClone(f.report);
  report.scene = partsScene;
  (report.characters as JsonObject[])[0]!.build = '../../derived/compose-input';
  for (const plate of report.plates as JsonObject[]) plate.image = `../../${String(plate.image)}`;
  write(f.dir, `${directionFrom}/scene.json`, report);
  write(f.dir, `${directionFrom}/${COMPOSE_RUN_PATH}`, { spec: 'rig-compose-run/1', scene: binding(f.dir, partsScene),
    characters: [{ id: 'actor', build: '../../derived/compose-input', files: treeFiles(f.dir, stage)
      .map(({ path, sha256 }) => ({ path: path.slice(stage.length + 1), sha256 })) }],
    plate: null, plates: (scene.plates as JsonObject[]).map(plate => ({ name: plate.name!, path: plate.image!,
      sha256: binding(f.dir, String(plate.image).slice('../../'.length)).sha256 })) });
}

test('direction write seals current scene and record direction binds the real compose receipts', () => {
  const f = composeFixture();
  currentRig(f);
  render(f.dir, false);
  recordMotion(f.dir);
  stagedDirection(f);
  const before = f.load();
  const baseline = check(f.dir).refusals;
  write(f.dir, '.gitignore', '/outputs/\n');
  const result = recordDirection(f.dir);
  expect(result.stderr?.split('\n')[0]).toBe('gitignore: /outputs/ -> /outputs/* !/outputs/parts/');
  expect(raw(f.dir, '.gitignore').toString()).toBe('/outputs/*\n!/outputs/parts/\n');
  const node = JSON.parse(result.stdout) as JsonObject;
  expect(node.run).toEqual(binding(f.dir, `outputs/direction/${COMPOSE_RUN_PATH}`));
  expect(node.report).toEqual(binding(f.dir, `outputs/direction/${COMPOSE_CHECK_PATH}`));
  expect(node.built_from).toContainEqual(binding(f.dir, CURRENT_SCENE_PATH));
  expect(node.built_from).toContainEqual(binding(f.dir, CURRENT_DIRECTION_PATH));
  expect(node.built_from).toContainEqual(binding(f.dir, CURRENT_MOTION_FRAMES));
  expect(node.built_from).toContainEqual({ path: motionRoot, sha256: outputSetHash(treeFiles(f.dir, motionRoot)) });
  expect(node.built_from).toContainEqual(binding(f.dir, 'outputs/rig/rig.json'));
  expect(f.load().versions).toEqual(before.versions);
  expect(check(f.dir).refusals).toEqual(baseline);
  expect(check(f.dir).warnings.map(f => f.code)).not.toContain('OUTPUT_STALE');
});

function stagedDirectionAfterBounce() {
  const legacyPath = 'outputs/v2/compose/compose-run.json';
  const legacyBytes = '{"spec":"rig-compose-run/1"}';
  const dir = fixture(project => {
    delete (project.current as JsonObject).direction;
    project.stage = 'direction-review';
    project.signoffs = asArray(project.signoffs).filter(row => isObject(row) && row.stage !== 'direction-review');
    project.advances = asArray(project.advances).filter(row => isObject(row) && row.stage !== 'accepted');
    project.versions = [
      { n: 1, kind: 'rig', at: '2024-01-01T00:00:00.000Z', outputs: [], provenance: { sections: {} }, verdicts: [
        { review: 'rig-review', verdict: 'accepted', at: '2024-01-02T00:00:00.000Z',
          by: 'user', verbatim: 'The rig is ready.', source: 'synthetic chat', on_items: [] },
      ] },
      { n: 2, kind: 'post', rig_version: 1, at: '2024-01-03T00:00:00.000Z', built_by: 'agent', built_with: {}, provenance: { sections: {} },
        outputs: [{ path: legacyPath, sha256: sha256(legacyBytes), bytes: Buffer.byteLength(legacyBytes) }] },
    ];
  }, 'example-current/project.json', { [legacyPath]: legacyBytes });
  renameSync(join(dir, 'outputs/direction'), join(dir, directionFrom));
  for (const words of ['Keep the whole actor in frame.', 'Keep the background in view.']) {
    expect(reviewCommand(['2', dir, '--review', 'direction-review', '--verdict', 'bounced',
      '--by', 'user', '--verbatim', words, '--source', 'synthetic chat'], testClock.now()).exit).toBe(0);
  }
  expect(recordCommand(['direction', dir, '--adopt'], testClock.now()).exit).toBe(0);
  expect(check(dir).refusals).toEqual([]);
  return { dir, load: () => json(dir, 'project.json') };
}

test('a current direction explicitly answers both numbered bounces and carries the answers into later recordings', () => {
  const f = stagedDirectionAfterBounce();
  const versions = f.load().versions;
  const result = recordDirection(f.dir, '--answers-feedback', '2:0', '--answers-feedback', '2:1');
  expect(result.exit).toBe(0);
  const answers = [{ version: 2, verdict: 0 }, { version: 2, verdict: 1 }];
  expect(JSON.parse(result.stdout).answers_feedback).toEqual(answers);
  expect(f.load().versions).toEqual(versions);
  const checked = check(f.dir);
  expect(checked.refusals).toEqual([]);
  expect(checked.warnings.map(finding => finding.code)).not.toContain('FEEDBACK_OPEN');
  expect(checked.feedback.map(row => row.answered_by_current_direction)).toEqual([true, true]);
  expect(nextProject(f.dir, testClock.now()).open_direction_comments).toBeUndefined();

  const original = raw(f.dir, 'project.json');
  const recordInPlace = (...flags: string[]) => recordCommand(['direction', f.dir, '--from', 'outputs/direction',
    '--direction', CURRENT_DIRECTION_PATH, '--json', ...flags], testClock.now());
  expect(() => recordInPlace('--answers-feedback', '2:0')).toThrow(expect.objectContaining({ code: 'FEEDBACK_REF_DUPLICATE' }));
  expect(raw(f.dir, 'project.json')).toEqual(original);
  expect(JSON.parse(recordInPlace().stdout).answers_feedback).toEqual(answers);
  expect(check(f.dir).warnings.map(finding => finding.code)).not.toContain('FEEDBACK_OPEN');
});

test('a current direction with no answer leaves numbered bounces open', () => {
  const f = stagedDirectionAfterBounce();
  const result = recordDirection(f.dir);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).not.toHaveProperty('adopted');
  expect(JSON.parse(result.stdout)).not.toHaveProperty('answers_feedback');
  expect(check(f.dir).warnings.filter(finding => finding.code === 'FEEDBACK_OPEN').map(finding => finding.path))
    .toEqual(['versions[v2].verdicts[0]', 'versions[v2].verdicts[1]']);
});

test('a malformed or non-open feedback pair refuses before changing the direction record or output', () => {
  const f = stagedDirectionAfterBounce();
  const original = raw(f.dir, 'project.json');
  const staged = treeFiles(f.dir, directionFrom);
  for (const pair of ['2:not-an-index', '99:0', '1:0', '2:9']) {
    expect(() => recordDirection(f.dir, '--answers-feedback', pair))
      .toThrow(expect.objectContaining({ code: 'DIRECTION_FEEDBACK_REF_INVALID' }));
    expect(raw(f.dir, 'project.json')).toEqual(original);
    expect(treeFiles(f.dir, directionFrom)).toEqual(staged);
    expect(existsSync(join(f.dir, 'outputs/direction'))).toBe(false);
  }
});

test('#1073 direction refuses missing staged evidence and dates the check of a recorded take', () => {
  const f = composeFixture();
  currentRig(f);
  render(f.dir, false);
  recordMotion(f.dir);
  stagedDirection(f);
  const original = raw(f.dir, 'project.json');
  write(f.dir, seamSpec, seamBudget);
  expect(() => recordDirection(f.dir)).toThrow(expect.objectContaining({ code: 'DIRECTION_LOOP_SEAM_MISSING' }));
  expect(raw(f.dir, 'project.json')).toEqual(original);
  expect(existsSync(join(f.dir, directionFrom))).toBe(true);

  rmSync(join(f.dir, seamSpec));
  expect(recordDirection(f.dir).exit).toBe(0);
  write(f.dir, seamSpec, seamBudget);
  const project = f.load();
  const direction = (project.current as JsonObject).direction as JsonObject;
  const since = Date.parse(LOOP_SEAM_REPORT_SINCE);
  direction.at = new Date(since - 1).toISOString();
  f.save(project);
  expect(check(f.dir).warnings.map(f => f.code)).toContain('DIRECTION_LOOP_SEAM_MISSING');
  direction.at = new Date(since).toISOString();
  f.save(project);
  expect(check(f.dir).refusals.map(f => f.code)).toContain('DIRECTION_LOOP_SEAM_MISSING');
});

test('a changed motion PNG with identical frames.json refuses new authoring and stales recorded direction', () => {
  const f = composeFixture();
  currentRig(f);
  render(f.dir, false);
  recordMotion(f.dir);
  stagedDirection(f);
  const frames = raw(f.dir, CURRENT_MOTION_FRAMES);
  const project = raw(f.dir, 'project.json');
  const scene = raw(f.dir, CURRENT_SCENE_PATH);
  const original = raw(f.dir, motionPng);
  const changed = Buffer.from(original);
  changed[0] = changed[0]! ^ 1;
  writeFileSync(join(f.dir, motionPng), changed);
  expect(() => sceneCommand(['write', f.dir, '--compose-scene', partsScene], testClock.now()))
    .toThrow(expect.objectContaining({ code: 'SCENE_CURRENT_MOTION_REQUIRED' }));
  expect(() => recordDirection(f.dir)).toThrow(expect.objectContaining({ code: 'SCENE_CURRENT_MOTION_REQUIRED' }));
  expect(raw(f.dir, CURRENT_SCENE_PATH)).toEqual(scene);
  expect(raw(f.dir, 'project.json')).toEqual(project);
  expect(existsSync(join(f.dir, directionFrom))).toBe(true);
  writeFileSync(join(f.dir, motionPng), original);
  expect(recordDirection(f.dir).exit).toBe(0);
  writeFileSync(join(f.dir, motionPng), changed);
  expect(raw(f.dir, CURRENT_MOTION_FRAMES)).toEqual(frames);
  expect(check(f.dir).warnings).toContainEqual(expect.objectContaining({ code: 'OUTPUT_STALE', path: 'current.direction' }));
});

test('direction record refuses a staged rig copy even if its producer receipt agrees with the copy', () => {
  const f = composeFixture();
  currentRig(f);
  render(f.dir, false);
  recordMotion(f.dir);
  stagedDirection(f);
  const path = `${directionFrom}/${COMPOSE_RUN_PATH}`;
  const run = json(f.dir, path);
  const character = (run.characters as JsonObject[])[0]!;
  const rig = (character.files as JsonObject[]).find(file => file.path === 'rig/rig.json')!;
  write(f.dir, 'derived/compose-input/rig/rig.json', '{}');
  rig.sha256 = binding(f.dir, 'derived/compose-input/rig/rig.json').sha256;
  write(f.dir, path, run);
  const original = raw(f.dir, 'project.json');
  expect(() => recordDirection(f.dir)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_RUN_RIG' }));
  expect(raw(f.dir, 'project.json')).toEqual(original);
  expect(existsSync(join(f.dir, directionFrom))).toBe(true);
  expect(existsSync(join(f.dir, 'outputs/direction'))).toBe(false);
});

test('next offers preparation and recording for missing current direction before compose and without a numbered post', () => {
  const dir = fixture(project => {
    project.stage = 'post';
    project.advances = (project.advances as JsonObject[]).filter(move => !['direction-review', 'accepted'].includes(String(move.stage)));
    project.signoffs = (project.signoffs as JsonObject[]).filter(signoff => signoff.stage !== 'direction-review');
  }, 'example-numbered/example-project.json');
  const f = { dir, model: { stage: { x: -64, y: 0, width: 128, height: 128 }, animations: [{ name: 'idle' }] },
    load: () => json(dir, 'project.json'), save: (value: JsonObject) => write(dir, 'project.json', value) };
  currentRig(f);
  render(dir, false);
  const now = EXAMPLE_ANCHOR + 60 * 60_000;
  expect(nextProject(dir, now).moves).toContainEqual(expect.objectContaining({ field: 'current.motion' }));
  recordMotion(dir);
  const directionMove = expect.objectContaining({ field: 'current.direction', awaits: 'current.direction',
    command: `rig-create record direction ${dir} --from ${directionFrom} --direction ${CURRENT_DIRECTION_PATH}`,
    act: expect.stringContaining(`Prepare ${directionFrom} before recording`) });
  expect(nextProject(dir, now).moves).toContainEqual(directionMove);
  write(dir, CURRENT_DIRECTION_PATH, {});
  write(dir, `${directionFrom}/${COMPOSE_RUN_PATH}`, {});
  write(dir, `${directionFrom}/${COMPOSE_CHECK_PATH}`, {});
  const withPost = f.load();
  const versions = (withPost.versions as JsonObject[]).filter(version => version.kind !== 'post');
  f.save({ ...withPost, versions });
  const danglingPost = nextProject(dir, now);
  expect(danglingPost.refusals.map(({ code, field }) => ({ code, field }))).toEqual([
    { code: 'DIRECTION_CONTRACT_INVALID', field: 'direction_contract.grandfathered_posts' },
  ]);
  expect(danglingPost.moves).toEqual([]);

  f.save({ ...withPost, versions, direction_contract: { ...withPost.direction_contract as JsonObject, grandfathered_posts: [] } });
  const withoutPost = nextProject(dir, now);
  expect(withoutPost.refusals).toEqual([]);
  expect(withoutPost.moves).toContainEqual(directionMove);
  expect(withoutPost.moves.some(move => move.command?.startsWith('rig-create advance direction-review '))).toBe(false);
  f.save(withPost);
  const next = nextProject(dir, now);
  expect(next.moves).toContainEqual(directionMove);
  expect(next.moves.some(move => move.command?.includes('record motion'))).toBe(false);
});

describe('#992 real compose from next in two folders', () => {
  const repo = join(import.meta.dir, '..');
  const templateDir = join(repo, 'templates/example-current');
  const cliAt = join(import.meta.dir, 'cli-at.ts');
  const now = EXAMPLE_ANCHOR + 60_000;
  let suiteRoot = '';
  let dirA = '';
  let dirB = '';
  let composeCmdA = '';
  let composeCmdB = '';

  const cleanupSuite = () => {
    if (suiteRoot && !keepTempDirs()) rmSync(suiteRoot, { recursive: true, force: true });
  };
  afterAll(cleanupSuite);
  process.on('exit', cleanupSuite);

  function buildDirectionFromNext(targetDir: string, env: Record<string, string>): string {
    cpSync(templateDir, targetDir, { recursive: true });
    rmSync(join(targetDir, 'outputs/direction'), { recursive: true, force: true });
    const project = json(targetDir, 'project.json');
    project.stage = 'post';
    project.advances = (project.advances as JsonObject[]).filter(
      move => !['direction-review', 'accepted'].includes(String(move.stage)),
    );
    project.signoffs = (project.signoffs as JsonObject[]).filter(
      signoff => signoff.stage !== 'direction-review',
    );
    delete (project.current as JsonObject).direction;
    writeFileSync(join(targetDir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

    expect(run(['git', 'init'], targetDir, env).code).toBe(0);
    expect(run(['git', 'add', '.'], targetDir, env).code).toBe(0);
    expect(run(['git', 'commit', '-m', 'seed synthetic project before compose'], targetDir, env).code).toBe(0);

    const beforeCompose = nextProject(targetDir, now);
    expect(beforeCompose.refusals).toEqual([]);
    const producerMove = beforeCompose.moves.find(
      move => move.role === 'producer' && move.field === 'current.direction',
    );
    expect(producerMove?.command).toBeDefined();
    const composeCommand = producerMove!.command!;
    const composed = run(['sh', '-c', composeCommand], repo, env);
    expect(composed.code, `${composed.stdout}\n${composed.stderr}`).toBe(0);

    const afterCompose = nextProject(targetDir, now);
    expect(afterCompose.refusals).toEqual([]);
    const recordMove = afterCompose.moves.find(
      move => move.role === 'agent' && move.field === 'current.direction',
    );
    expect(recordMove?.command).toBeDefined();
    const recorded = run(['sh', '-c', recordMove!.command!], repo, env);
    expect(recorded.code, `${recorded.stdout}\n${recorded.stderr}`).toBe(0);

    const report = checkProject(targetDir, undefined, { now });
    expect(report.refusals.map(f => f.code)).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual([]);
    return composeCommand;
  }

  beforeAll(() => {
    suiteRoot = mkdtempSync(join(tmpdir(), 'rig-create-992-'));
    const binDir = join(suiteRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const createBin = join(binDir, 'rig-create');
    writeFileSync(
      createBin,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliAt)} ${JSON.stringify(new Date(now).toISOString())} "$@"\n`,
    );
    chmodSync(createBin, 0o755);

    const gitConfig = join(suiteRoot, 'gitconfig');
    writeFileSync(
      gitConfig,
      '[init]\n\tdefaultBranch = main\n[user]\n\tname = Synthetic Runner\n\temail = synthetic@localhost\n',
    );
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('GIT_')) cleanEnv[key] = value;
    }
    const env: Record<string, string> = {
      ...cleanEnv,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      PATH: [binDir, join(repo, 'node_modules/.bin'), cleanEnv.PATH ?? ''].filter(Boolean).join(delimiter),
    };

    dirA = join(suiteRoot, 'alpha', 'synthetic-project');
    dirB = join(suiteRoot, 'bravo-deeper', 'nested', 'synthetic-project');
    composeCmdA = buildDirectionFromNext(dirA, env);
    composeCmdB = buildDirectionFromNext(dirB, env);
  }, 120_000);

  test('produces byte-identical check/check.json and compose receipts across two folders', () => {
    expect(composeCmdA).toContain('rig-parts compose --scene specs/direction/compose-scene.json --out outputs/direction.next');
    expect(composeCmdB).toContain('rig-parts compose --scene specs/direction/compose-scene.json --out outputs/direction.next');

    const checkA = raw(dirA, `outputs/direction/${COMPOSE_CHECK_PATH}`);
    const checkB = raw(dirB, `outputs/direction/${COMPOSE_CHECK_PATH}`);
    expect(checkA.equals(checkB)).toBe(true);

    const parsed = JSON.parse(checkA.toString('utf8')) as JsonObject;
    expect(parsed.PASS).toBe(true);
    expect(parsed.gate_spine_html_green).toBe(true);
    for (const key of ['TIP_OVER_ROOT', 'BREATH_VISIBLE', 'RECOMPOSITE_HOLES', 'BLINK_NO_HOLE', 'STILL_REGIONS_DARK'] as const) {
      expect(typeof (parsed[key] as JsonObject | undefined)?.reason).toBe('string');
    }
    expect(typeof (parsed.skipped as JsonObject | undefined)?.seam).toBe('string');

    expect(raw(dirA, `outputs/direction/${COMPOSE_RUN_PATH}`).equals(raw(dirB, `outputs/direction/${COMPOSE_RUN_PATH}`))).toBe(true);
    expect(raw(dirA, 'outputs/direction/scene.json').equals(raw(dirB, 'outputs/direction/scene.json'))).toBe(true);

    const directionA = (json(dirA, 'project.json').current as JsonObject).direction as JsonObject;
    const directionB = (json(dirB, 'project.json').current as JsonObject).direction as JsonObject;
    expect(directionA.files_sha256).toBe(directionB.files_sha256);
    expect(directionA.report).toEqual(directionB.report);
    expect(directionA.run).toEqual(directionB.run);
  });

  test('leaves no absolute project path anywhere in the recorded compose tree', () => {
    for (const dir of [dirA, dirB]) {
      const composeTree = join(dir, 'outputs/direction');
      const candidates = [...new Set([dir, realpathSync(dir)])];
      for (const absPath of candidates) {
        const grepped = run(
          ['sh', '-c', 'command grep -rnF "$1" "$2"', 'grep-check', absPath, composeTree],
          repo,
          process.env as Record<string, string>,
        );
        expect(grepped.code, `unexpected match for ${absPath}:\n${grepped.stdout}\n${grepped.stderr}`).toBe(1);
        expect(grepped.stdout).toBe('');
      }
    }
  });
});

test('#1062 direction@4 accepts unsigned post steps, still requires unique camera and timing steps, and binds live post-interview signoffs when present', () => {
  const f = composeFixture();
  currentRig(f);
  render(f.dir, false);
  recordMotion(f.dir);
  const files = ['check/check.json', 'rig/rig.json', 'rig/motion.json', 'rig/images/body.png'];
  const stage = 'derived/compose-input';
  for (const path of files) {
    const current = `outputs/rig/${path.replace(/^rig\//, '')}`;
    mkdirSync(dirname(join(f.dir, stage, path)), { recursive: true });
    cpSync(join(f.dir, current), join(f.dir, stage, path));
  }
  write(f.dir, `${stage}/parts.json`, '{}');
  const scene = structuredClone(f.scene);
  (scene.characters as JsonObject[])[0]!.build = '../../derived/compose-input';
  for (const plate of scene.plates as JsonObject[]) plate.image = `../../${String(plate.image)}`;
  write(f.dir, partsScene, scene);
  sceneCommand(['write', f.dir, '--compose-scene', partsScene], testClock.now());
  write(f.dir, intentPath, { take: f.doc.take!, citations: f.doc.citations! });

  const withSignoffs = f.load();
  const unsigned = structuredClone(withSignoffs);
  unsigned.signoffs = (unsigned.signoffs as JsonObject[]).filter(s => s.stage !== 'post-interview');
  f.save(unsigned);
  expect(directionCommand(['write', f.dir, '--file', intentPath], testClock.now()).exit).toBe(0);

  const missingCamera = structuredClone(unsigned);
  (missingCamera.plan as JsonObject).steps = ((missingCamera.plan as JsonObject).steps as JsonObject[])
    .filter(step => step.id !== 'camera');
  f.save(missingCamera);
  expect(() => directionCommand(['write', f.dir, '--file', intentPath], testClock.now()))
    .toThrow(expect.objectContaining({ code: 'DIRECTION_CITATION', message: expect.stringContaining('plan.steps[camera]') }));

  const staleSigned = structuredClone(withSignoffs);
  (((staleSigned.plan as JsonObject).steps as JsonObject[]).find(step => step.id === 'camera')!).does = 'Changed after post-interview signoff';
  f.save(staleSigned);
  expect(() => directionCommand(['write', f.dir, '--file', intentPath], testClock.now()))
    .toThrow(expect.objectContaining({ code: 'DIRECTION_CITATION', message: expect.stringContaining('plan.steps[camera]') }));
});
