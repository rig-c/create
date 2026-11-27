import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asArray, checkProject, isObject } from '../src/check.ts';
import { outputSetHash, sha256, treeFiles, type CurrentKind } from '../src/current.ts';
import { ledgerCommand } from '../src/fix-ledger.ts';
import { JOB_BINDING_FILE, writePrivateJson } from '../src/job-outbox.ts';
import { nextCommand, nextProject } from '../src/next.ts';
import { recordCommand } from '../src/record.ts';
import { stageIndex } from '../src/stages.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { advanceCommand, signoffCommand, testClock } from './clock.ts';
import { fixture, plantLegacyReopen, retainSignoffs, type Mutate } from './fixtures.ts';
import { ownerChatArgs, tempDir } from './helpers.ts';

const CONFIG = 'specs/rig/config.json';
const PARTS = 'outputs/parts/parts.json';
const MODEL = 'outputs/rig/check/build/skeleton.model.json';
const FRAMES = 'outputs/motion/frames.json';
const RIG_RUN = 'outputs/rig/build-run.json';
const MOTION_RUN = 'outputs/motion/render-run.json';
const DIRECTION_RUN = 'outputs/direction/compose-run.json';
const BUILD_ARGS = ['build', '--config', `../../${CONFIG}`, '--source', '../../inputs/painting.png', '--full', '../../layers/full', '--out', '.'];
const RENDER_ARGS = ['--candidate', '../rig/check/build', '--animation', "idle's take", '--out=.'];

function put(dir: string, path: string, value: JsonObject): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), `${JSON.stringify(value)}\n`);
}

function binding(dir: string, path: string): { path: string; sha256: string } {
  return { path, sha256: sha256(readFileSync(join(dir, path))) };
}

function currentNode(dir: string, kind: CurrentKind, run: string, report: string, inputs: string[]): JsonObject {
  const files = treeFiles(dir, `outputs/${kind}`);
  return { at: testClock.iso(), built_by: 'agent', built_with: {}, files, files_sha256: outputSetHash(files),
    built_from: inputs.map(path => binding(dir, path)), run: binding(dir, run), report: binding(dir, report) };
}

const stamp = { started_at: '2026-11-25T00:00:00.000Z', finished_at: '2026-11-25T00:00:01.000Z' };
const partsPackage = { name: '@rig-c/parts', version: '2.56.0' };
const corePackage = { name: '@rig-c/core', version: '3.8.1' };

/** Reusable by the before/after `next --json` comparison against the base checkout. */
export function staleFixture(mutate?: Mutate): string {
  const dir = fixture(mutate, 'example-numbered/example-project.json');
  const reasonFile = join(tempDir(), 'retire-t1.txt');
  writeFileSync(reasonFile, 'The signed example fix is outside this synthetic rebuild scenario.\n');
  ledgerCommand(['retire', 'T1', dir, '--by', 'user', '--reason-file', reasonFile], testClock.now());
  put(dir, CONFIG, { synthetic: 'rig config' });
  put(dir, PARTS, { parts: ['face'] });

  put(dir, MODEL, { synthetic: 'model' });
  put(dir, RIG_RUN, { spec: 'rig-run/2', package: partsPackage, command: 'build', ...stamp,
    config: { ...binding(dir, CONFIG), path: `../../${CONFIG}` },
    outputs: [{ ...binding(dir, MODEL), path: 'check/build/skeleton.model.json' }], argv: BUILD_ARGS });
  put(dir, FRAMES, { frames: 1 });
  put(dir, MOTION_RUN, { spec: 'rigc-run/2', package: corePackage, command: 'render', argv: RENDER_ARGS, ...stamp,
    inputs: [{ role: 'skeleton', path: '../rig/check/build/skeleton.model.json', sha256: binding(dir, MODEL).sha256 }],
    outputs: [{ ...binding(dir, FRAMES), path: 'frames.json' }] });
  put(dir, 'outputs/direction/take.json', { take: 1 });
  put(dir, DIRECTION_RUN, { spec: 'rig-compose-run/1', argv: ['compose', '--out', '.'] });

  const rig = currentNode(dir, 'rig', RIG_RUN, MODEL, [PARTS, CONFIG]);
  rig.rebuild = { recorded: true, runs: [{ ...binding(dir, RIG_RUN), spec: 'rig-run/2', argv: BUILD_ARGS }] };
  const motion = currentNode(dir, 'motion', MOTION_RUN, FRAMES, [MODEL]);
  const direction = currentNode(dir, 'direction', DIRECTION_RUN, 'outputs/direction/take.json', [FRAMES]);
  // Parts has already been replaced. Only the rig's direct binding has changed.
  put(dir, PARTS, { parts: ['face', 'eyelid'] });
  put(dir, 'outputs/parts/run.json', { spec: 'rig-run/1', package: partsPackage, command: 'assemble', ...stamp,
    config: { ...binding(dir, CONFIG), path: `../../${CONFIG}` }, outputs: [{ ...binding(dir, PARTS), path: 'parts.json' }] });
  const project = readProject(dir);
  // Deliberately put the downstream nodes first in the record.
  project.current = { direction, motion, rig, parts: currentNode(dir, 'parts', 'outputs/parts/run.json', PARTS, [CONFIG]) };
  put(dir, 'project.json', project);
  return dir;
}

function readProject(dir: string): JsonObject {
  return readObject(dir, 'project.json');
}

function readObject(dir: string, path: string): JsonObject {
  const record = JSON.parse(readFileSync(join(dir, path), 'utf8')) as Json;
  if (!isObject(record)) throw new Error('expected synthetic project record');
  return record;
}

function replaceRig(dir: string, run: string, rebuild: JsonObject): void {
  const project = readProject(dir);
  (project.current as JsonObject).rig = { ...currentNode(dir, 'rig', run, MODEL, [CONFIG]), rebuild,
    built_from: (project.current as { rig: JsonObject }).rig.built_from! };
  put(dir, 'project.json', project);
}

const next = (dir: string) => nextProject(dir, testClock.now());

test('next offers the stale cascade after parts is replaced, while check still warns and the stage stays accepted', () => {
  const dir = staleFixture();
  const report = checkProject(dir, undefined, { now: testClock.now(), readOnly: true });
  const fields = ['current.rig', 'current.motion', 'current.direction'];
  expect(report.refusals).toEqual([]);
  expect(report.warnings.filter(f => f.code === 'OUTPUT_STALE').map(f => f.path)).toEqual(fields);
  const result = next(dir);
  expect(result).toMatchObject({ stage: 'accepted', accepted: true, refusals: [], awaits: fields });
  expect(result.moves.map(move => move.field)).toEqual(fields);
  const [rig, motion, direction] = result.moves;
  expect(rig?.command).toBeNull();
  expect(rig?.act).toContain('Have the operator incorporate the current parts into the assembly inputs');
  expect(rig?.act).toContain('rig-parts build ');
  expect(rig?.act).toContain(`After rebuilding, run rig-create record rig ${dir} --from outputs/rig.next --config ${CONFIG}`);
  expect(motion?.command).toBeNull();
  expect(motion?.act).toContain("rigc render --candidate ../rig/check/build --animation 'idle'\\''s take' '--out=.'");
  expect(motion?.act).toContain('After rebuilding, use rig-create record motion when the installed version provides it.');
  expect(direction?.command).toBeNull();
  expect(direction?.act).toContain('obtain the compose arguments from the operator');
  expect(direction?.act).toContain('After rebuilding, use rig-create record direction when the installed version provides it.');
  const human = nextCommand([dir], testClock.now());
  expect(human.exit).toBe(0);
  expect(human.stdout).toContain('rig-create record motion when the installed version provides it');
  expect(human.stdout).toContain('rig-create record direction when the installed version provides it');
});

test('parts appears first when its config changes, with operator work for the legacy assemble receipt', () => {
  const dir = staleFixture();
  put(dir, CONFIG, { synthetic: 'updated config' });
  const moves = next(dir).moves;
  expect(moves.map(move => move.field)).toEqual(['current.parts', 'current.rig', 'current.motion', 'current.direction']);
  expect(moves[0]?.command).toBeNull();
  expect(moves[0]?.act).toContain('Obtain the assemble and parts-check arguments from the operator');
  expect(moves[0]?.act).toContain(`rig-create record parts ${dir} --from outputs/parts.next --config ${CONFIG}`);
});

test('#1111 a changed input preserves the adopted rig and names the missing rebuild recipe', () => {
  const dir = join(tempDir('next-stale-adopted-'), 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain'), dir, { recursive: true });
  expect(recordCommand(['rig', dir, '--adopt'], testClock.now()).exit).toBe(0);
  const project = readProject(dir);
  const rig = (project.current as { rig: JsonObject }).rig;
  const config = 'specs/rig/rebuild-input.json';
  put(dir, config, { synthetic: 'original input' });
  rig.built_from = [...asArray(rig.built_from), binding(dir, config)];
  put(dir, 'project.json', project);

  const retained = 'outputs/v1/out/check/build/skeleton.model.json';
  const projectBytes = readFileSync(join(dir, 'project.json'));
  const modelBytes = readFileSync(join(dir, retained));
  const fresh = next(dir);
  expect(fresh.moves.some(move => move.field === 'current.rig')).toBe(false);

  put(dir, config, { synthetic: 'changed input' });
  const changed = next(dir);
  expect(changed.refusals).toEqual([]);
  expect(changed.warnings).toContainEqual(expect.objectContaining({ code: 'OUTPUT_STALE', path: 'current.rig',
    message: expect.stringContaining(config) }));
  const repair = changed.moves.find(move => move.field === 'current.rig');
  expect(repair).toMatchObject({ role: 'agent', command: null, awaits: 'current.rig' });
  expect(repair?.act).toContain('Retain the previous rig at outputs/v1/out');
  expect(repair?.act).toContain('REBUILD_ARGS_UNRECORDED: current.rig.rebuild');
  expect(repair?.act).toContain('the retained output can be reused for its recorded inputs');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(projectBytes);
  expect(readFileSync(join(dir, retained))).toEqual(modelBytes);
});

test('rig replay uses fresh sibling and nested directories, unchanged argv and producer-before-writer order', () => {
  const dir = staleFixture();
  const nested = 'outputs/rig/a idle/render-run.json';
  const renderArgs = ['--candidate', '../check/build', '--animation', "idle's take", '--out=.'];
  put(dir, nested, { ...readObject(dir, MOTION_RUN), argv: renderArgs });
  replaceRig(dir, RIG_RUN, { recorded: true, runs: [
    { ...binding(dir, nested), spec: 'rigc-run/2', argv: renderArgs },
    { ...binding(dir, RIG_RUN), spec: 'rig-run/2', argv: BUILD_ARGS },
  ] });
  const project = readProject(dir);
  (project.current as { rig: JsonObject }).rig.built_from = [binding(dir, CONFIG)];
  put(dir, 'project.json', project);
  put(dir, CONFIG, { synthetic: 'updated config' });

  const bin = join(dir, 'stub-bin');
  const trace = join(dir, 'replay.txt');
  mkdirSync(bin);
  for (const executable of ['rig-parts', 'rigc', 'rig-create']) {
    writeFileSync(join(bin, executable), '#!/bin/sh\nprintf "%s\\n" "${0##*/}" "$PWD" "$@" >> "$REPLAY_TRACE"\n', { mode: 0o755 });
  }
  const command = next(dir).moves.find(move => move.field === 'current.rig')?.command;
  expect(command).toBeString();
  const run = () => Bun.spawnSync(['/bin/sh', '-c', command!], { cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, REPLAY_TRACE: trace }, stderr: 'pipe' });
  const output = join(dir, 'outputs');
  const redirected = join(dir, 'redirected-outputs');
  // Replace the parent after next has validated the run bytes, then try the printed command.
  renameSync(output, redirected);
  symlinkSync(redirected, output, 'dir');
  expect(run().exitCode).not.toBe(0);
  expect(existsSync(join(redirected, 'rig.next'))).toBe(false);
  expect(existsSync(trace)).toBe(false);
  rmSync(output);
  renameSync(redirected, output);
  const first = run();
  expect(first.stderr.toString()).toBe('');
  expect(first.exitCode).toBe(0);
  const lines = readFileSync(trace, 'utf8').trimEnd().split('\n');
  const root = realpathSync(dir);
  expect(lines).toEqual(['rig-parts', `${root}/outputs/rig.next`, ...BUILD_ARGS,
    'rigc', `${root}/outputs/rig.next/a idle`, 'render', ...renderArgs,
    'rig-create', root, 'record', 'rig', dir, '--from', 'outputs/rig.next', '--config', CONFIG]);
  expect(run().exitCode).not.toBe(0);
  expect(readFileSync(trace, 'utf8').trimEnd().split('\n')).toEqual(lines);
});

test('a recorded rig check survives as a partial step when the preceding rig build arguments are absent', () => {
  const dir = staleFixture();
  const legacy = 'outputs/rig/run.json';
  const check = 'outputs/rig/check/check-run.json';
  const checkArgs = ['check', '--rig', '..', '--out', '.'];
  const { argv: _argv, ...build } = readObject(dir, RIG_RUN);
  put(dir, legacy, { ...build, spec: 'rig-run/1', command: 'rig' });
  rmSync(join(dir, RIG_RUN));
  put(dir, check, { spec: 'rig-run/2', package: partsPackage, command: 'check', ...stamp,
    outputs: [{ ...binding(dir, MODEL), path: 'build/skeleton.model.json' }], argv: checkArgs });
  replaceRig(dir, legacy, { recorded: true, runs: [{ ...binding(dir, check), spec: 'rig-run/2', argv: checkArgs }] });
  const move = next(dir).moves[0];
  expect(move?.command).toBeNull();
  expect(move?.act).toContain('Obtain the missing rig build arguments from the operator');
  expect(move?.act).toContain('/outputs/rig.next/check');
  expect(move?.act).toContain('rig-parts check --rig .. --out .');
  expect(move?.act).toContain(`rig-create record rig ${dir} --from outputs/rig.next --config ${CONFIG}`);
});

test.each([
  ['changed bytes', 'no longer matches its recorded sha256'],
  ['mismatched mirror', 'disagrees with the recorded rebuild spec or argv'],
  ['unsafe out', 'has no single effective --out . for safe staged replay'],
  ['Parts equals spelling', 'has no single effective --out . for safe staged replay'],
  ['duplicate out', 'has no single effective --out . for safe staged replay'],
  ['out consumed as a value', 'has no single effective --out . for safe staged replay'],
] as const)('next requires operator work for %s', (mode, reason) => {
  const dir = staleFixture();
  const v2 = readObject(dir, RIG_RUN);
  const unsafe = mode === 'Parts equals spelling' ? [...BUILD_ARGS.slice(0, -2), '--out=.']
    : mode === 'duplicate out' ? [...BUILD_ARGS, '--out', '../rig']
      : mode === 'out consumed as a value' ? [...BUILD_ARGS.slice(0, -2), '--head', '--out', '.']
        : [...BUILD_ARGS.slice(0, -1), '../rig'];
  if (mode === 'changed bytes') put(dir, RIG_RUN, { ...v2, argv: unsafe });
  else {
    if (mode !== 'mismatched mirror') put(dir, RIG_RUN, { ...v2, argv: unsafe });
    replaceRig(dir, RIG_RUN, { recorded: true, runs: [{ ...binding(dir, RIG_RUN), spec: 'rig-run/2', argv: unsafe }] });
  }
  const move = next(dir).moves[0];
  expect(move?.command).toBeNull();
  expect(move?.act).toContain(reason);
  expect(move?.act).not.toContain('rig-parts build --');
});

test('post-interview hides stale option authoring, Review groups and answer refresh while preserving independent plan work', () => {
  const dir = staleFixture(project => {
    project.stage = 'post-interview';
    project.versions = asArray(project.versions).filter(v => isObject(v) && v.kind === 'rig');
    (project.direction_contract as JsonObject).grandfathered_posts = [];
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('post-interview'));
    project.advances = asArray(project.advances).filter(row => isObject(row) && stageIndex(String(row.stage)) <= stageIndex('post-interview'));
    const post = (project.interview as JsonObject).post as JsonObject;
    for (const item of asArray(post.items).filter(isObject)) {
      if (item.id !== 'camera_depth' && item.id !== 'post_timing') continue;
      item.pending_options = ((item.guide as JsonObject).choice as JsonObject).set!;
      item.guide = null;
    }
    const plan = project.plan as JsonObject;
    plan.steps = asArray(plan.steps).filter(step => isObject(step) && step.phase !== 'post');
  });
  const staleRecord = readProject(dir);
  const project = structuredClone(staleRecord);
  (project.current as { rig: JsonObject }).rig.built_from = [binding(dir, PARTS), binding(dir, CONFIG)];
  put(dir, 'project.json', project);
  const fresh = next(dir);
  expect(fresh.effective_stage).toBe('post-interview');
  expect(fresh.refusals.map(finding => finding.code)).toEqual(['INTERVIEW_INCOMPLETE', 'INTERVIEW_INCOMPLETE']);
  expect(fresh.moves.filter(move => move.field === 'interview').map(move => move.command?.split(' ').slice(1, 3).join(' ')))
    .toEqual(['job open']);
  const plan = fresh.moves.find(move => move.command?.startsWith('rig-create plan add composition '));
  expect(plan).toBeDefined();
  const answer = fresh.answers?.find(answer => answer.question_id === 'post_composition');
  expect(answer?.command).toStartWith('rig-create interview-options ');

  put(dir, 'project.json', staleRecord);
  const stale = next(dir);
  expect(stale.moves.filter(move => !move.field.startsWith('current.'))).toEqual([plan!]);
  expect(stale.awaits).not.toContain('interview.post.items[camera_depth].guide');
  expect(stale.awaits).not.toContain('interview.post.items[post_timing].guide');
  const { command: _command, ...recorded } = answer!;
  expect(stale.answers?.find(answer => answer.question_id === 'post_composition')).toEqual(recorded);

  // Drop one pending set. Its drafting move and the other set's single Review chain are both dependent.
  for (const record of [project, staleRecord]) {
    const post = (record.interview as JsonObject).post as JsonObject;
    delete asArray(post.items).filter(isObject).find(item => item.id === 'post_timing')!.pending_options;
  }
  put(dir, 'project.json', project);
  const single = next(dir);
  expect(single.moves.some(move => move.command?.startsWith('rig-create interview-options post_timing '))).toBe(true);
  expect(single.moves.some(move => move.command?.startsWith('rig-create job open ') && move.command.includes('--question camera_depth'))).toBe(true);
  put(dir, 'project.json', staleRecord);
  expect(next(dir).moves.filter(move => !move.field.startsWith('current.'))).toEqual([plan!]);
});

function postFixture(stepStatus: 'pending' | 'done'): string {
  return staleFixture(project => {
    project.stage = 'post';
    project.versions = asArray(project.versions).filter(v => isObject(v) && v.kind === 'rig');
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('direction-review'));
    project.advances = asArray(project.advances).filter(row => isObject(row) && stageIndex(String(row.stage)) <= stageIndex('post'));
    (project.direction_contract as JsonObject).grandfathered_posts = [];
    if (stepStatus === 'pending') {
      for (const step of asArray((project.plan as JsonObject).steps).filter(isObject)) {
        if (step.phase !== 'post') continue;
        step.status = 'pending';
        delete step.status_history;
      }
    }
  });
}

function freshPost(dir: string, staleRecord: JsonObject): JsonObject {
  const project = structuredClone(staleRecord);
  (project.current as { rig: JsonObject }).rig.built_from = [binding(dir, PARTS), binding(dir, CONFIG)];
  return project;
}

const rebuildTargets = ['current.rig', 'current.motion', 'current.direction'];

test('stale rig leads with rebuilds while independent post step statuses stay runnable', () => {
  const dir = postFixture('pending');
  put(dir, 'outputs/motion.next/frames.json', { frames: 2 });
  const staleRecord = readProject(dir);
  put(dir, 'project.json', freshPost(dir, staleRecord));
  const fresh = next(dir);
  const plan = ['camera', 'timing', 'composition'].map(id => ({
    role: 'agent' as const, field: `plan.steps[${id}].status`, awaits: `plan.steps[${id}].status`,
    command: `rig-create step-status ${id} in-progress ${dir} --by agent`,
    act: `advance plan.steps[${id}].status from pending to in-progress`,
  }));
  expect(fresh).toMatchObject({ effective_stage: 'post', refusals: [] });
  // A recorded current.motion is replaced only through its rebuild move; staged bytes alone offer no record (#1030).
  expect(fresh.moves).toEqual(plan);
  expect(fresh.awaits).toEqual(plan.map(move => move.awaits));

  put(dir, 'project.json', staleRecord);
  const stale = next(dir);
  expect(stale).toMatchObject({ effective_stage: 'post', refusals: [] });
  expect(stale.moves.slice(0, 3).map(({ field, awaits, command }) => ({ field, awaits, command })))
    .toEqual(rebuildTargets.map(field => ({ field, awaits: field, command: null })));
  expect(stale.moves.slice(3)).toEqual(plan);
  expect(stale.awaits).toEqual([...rebuildTargets, ...plan.map(move => move.awaits)]);
});

test('stale direction suppresses the advance to direction-review and its stage await', () => {
  const dir = postFixture('done');
  const staleRecord = readProject(dir);
  const freshRecord = freshPost(dir, staleRecord);
  put(dir, 'project.json', freshRecord);
  const fresh = next(dir);
  expect(fresh).toMatchObject({ effective_stage: 'post', refusals: [] });
  expect(fresh.moves.filter(move => move.field === 'stage')).toEqual([{
    role: 'agent', field: 'stage', awaits: 'project.stage',
    command: `rig-create advance direction-review ${dir}`, act: 'advance stage from post to direction-review',
  }]);
  expect(fresh.awaits).toContain('project.stage');
  expect(fresh.moves.some(move => move.command?.startsWith('rig-create direction write '))).toBe(false);

  put(dir, 'project.json', staleRecord);
  const stale = next(dir);
  expect(stale).toMatchObject({ effective_stage: 'post', refusals: [] });
  expect(stale.moves.map(move => move.field)).toEqual(rebuildTargets);
  expect(stale.awaits).not.toContain('project.stage');

  put(dir, 'project.json', freshRecord);
  expect(advanceCommand(['direction-review', dir])).toMatchObject({ exit: 0 });
  expect(readProject(dir).stage).toBe('direction-review');
});

function bindReviewWriter(dir: string): void {
  writePrivateJson(join(dir, JOB_BINDING_FILE), {
    schema: 'rig-create/job-binding@1', identity: { root: realpathSync(dir) },
    jobId: 'synthetic-job', origin: 'http://127.0.0.1', fetchCapability: 'synthetic', listenerIncarnation: '',
  }, true);
}

function expectCurrentReview(dir: string, stage: 'rig-review' | 'direction-review'): void {
  const report = next(dir);
  const awaits = `signoffs[stage=${stage}]`;
  expect(report).toMatchObject({ effective_stage: stage, refusals: [] });
  expect(report.awaits).toContain(awaits);
  expect(report.awaits.some(field => field.startsWith('versions['))).toBe(false);
  expect(report.moves.some(move => move.review_act?.kind === 'review-verdict')).toBe(false);
  const approvals = report.moves.filter(move => move.awaits === awaits);
  expect(approvals.map(move => [move.role, move.command, move.review_act?.kind ?? null])).toEqual([
    ['human', `rig-create signoff ${stage} ${dir} --by '<owner>' --owner-chat '<words file>' --said-at '<ISO date>' --relayed-by '<operator>'`, null],
  ]);
}

test('next guides current rigging through owner chat approval and onward to post-interview without an accepted rig verdict', () => {
  const unstartedPost = (readTemplate('project.json').interview as JsonObject).post!;
  const dir = staleFixture(project => {
    project.stage = 'rigging';
    project.versions = asArray(project.versions).filter(v => isObject(v) && v.kind === 'rig');
    for (const version of asArray(project.versions).filter(isObject)) {
      version.verdicts = asArray(version.verdicts).filter(verdict => isObject(verdict) && verdict.verdict !== 'accepted');
    }
    (project.direction_contract as JsonObject).grandfathered_posts = [];
    // No post options or scene have been authored against the still-unsigned rig.
    (project.interview as JsonObject).post = unstartedPost;
    project.scenes = [];
    const plan = project.plan as JsonObject;
    plan.steps = asArray(plan.steps).filter(step => isObject(step) && step.phase === 'rig');
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('rig-review'));
    project.advances = asArray(project.advances).filter(row => isObject(row) && stageIndex(String(row.stage)) <= stageIndex('rigging'));
  });
  put(dir, 'project.json', freshPost(dir, readProject(dir)));
  bindReviewWriter(dir);
  const rigging = next(dir);
  expect(rigging.refusals).toEqual([]);
  expect(rigging.moves).toContainEqual(expect.objectContaining({ command: `rig-create advance rig-review ${dir}` }));
  expect(advanceCommand(['rig-review', dir])).toMatchObject({ exit: 0 });
  expectCurrentReview(dir, 'rig-review');
  const words = join(dir, 'owner-rig-approval.txt');
  writeFileSync(words, 'The synthetic rig is approved.\n');
  expect(signoffCommand(['rig-review', dir, '--by', 'owner', ...ownerChatArgs(words)])).toMatchObject({ exit: 0 });
  expect(asArray(readProject(dir).signoffs).at(-1)).toMatchObject({ target: { subject: 'current.rig' } });
  expect(next(dir).moves).toContainEqual(expect.objectContaining({ command: `rig-create advance post-interview ${dir}` }));
});

test('a bound current direction advances, signs in owner chat and reaches accepted without a numbered post', () => {
  const dir = postFixture('done');
  const staleRecord = readProject(dir);
  const freshRecord = freshPost(dir, staleRecord);
  put(dir, 'project.json', freshRecord);
  bindReviewWriter(dir);

  const bound = next(dir);
  expect(bound).toMatchObject({ effective_stage: 'post', refusals: [] });
  expect(bound.moves.filter(move => move.field === 'stage')).toEqual([{
    role: 'agent', field: 'stage', awaits: 'project.stage',
    command: `rig-create advance direction-review ${dir}`, act: 'advance stage from post to direction-review',
  }]);
  expect(bound.awaits).toContain('project.stage');
  expect(bound.awaits.some(field => field.startsWith('versions['))).toBe(false);
  expect(bound.moves.some(move => move.command?.startsWith('rig-create direction write '))).toBe(false);

  put(dir, 'project.json', staleRecord);
  const stale = next(dir);
  expect(stale.moves.map(move => move.field)).toEqual(rebuildTargets);
  expect(stale.awaits).not.toContain('project.stage');

  put(dir, 'project.json', freshRecord);
  const output = join(dir, 'outputs/direction');
  const moved = join(dir, 'unavailable-direction');
  renameSync(output, moved);
  expect(next(dir).awaits).not.toContain('project.stage');
  expect(() => advanceCommand(['direction-review', dir])).toThrow(expect.objectContaining({ code: 'JOB_PUBLICATION_INVALID' }));
  renameSync(moved, output);

  expect(advanceCommand(['direction-review', dir])).toMatchObject({ exit: 0 });
  expectCurrentReview(dir, 'direction-review');
  renameSync(output, moved);
  expect(next(dir).awaits).not.toContain('signoffs[stage=direction-review]');
  renameSync(moved, output);

  const words = join(dir, 'owner-direction-approval.txt');
  writeFileSync(words, 'The synthetic direction is approved.\n');
  expect(signoffCommand(['direction-review', dir, '--by', 'owner', ...ownerChatArgs(words)])).toMatchObject({ exit: 0 });
  expect(asArray(readProject(dir).signoffs).at(-1)).toMatchObject({ target: { subject: 'current.direction' } });
  expect(next(dir).moves).toContainEqual(expect.objectContaining({ command: `rig-create advance accepted ${dir}` }));
  expect(advanceCommand(['accepted', dir])).toMatchObject({ exit: 0 });
  expect(next(dir)).toMatchObject({ stage: 'accepted', accepted: true, refusals: [] });
  expect(readProject(dir).versions).toEqual(freshRecord.versions!);
});

test('next keeps the numbered rig verdict move for a project without current', () => {
  const dir = tempDir('rig-create-next-legacy-');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), dir, { recursive: true });
  expect(readProject(dir).current).toBeUndefined();
  const report = next(dir);
  const awaits = 'versions[n=1].verdicts[review=rig-review]';
  expect(report.awaits).toContain(awaits);
  expect(report.moves.find(move => move.awaits === awaits && move.role === 'human'
    && move.review_act?.kind === 'review-verdict')).toMatchObject({
    role: 'human', command: null,
    review_act: { kind: 'review-verdict', stage: 'rig-review', version_id: 'v1', review: 'rig-review' },
  });
});

test('a lapsed numbered direction verdict stays visible while next offers current owner chat re-signoff', () => {
  const dir = staleFixture();
  put(dir, 'project.json', freshPost(dir, readProject(dir)));
  plantLegacyReopen(dir, 'direction-review', { at: new Date(testClock.now() - 1_000).toISOString() });
  expectCurrentReview(dir, 'direction-review');
  const report = next(dir);
  expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'REOPEN_VERDICT_LAPSED' }));
  expect(report.moves.find(move => move.awaits === 'signoffs[stage=direction-review]')?.lapse)
    .toMatchObject({ code: 'REOPEN_SIGNOFF_LAPSED' });
});
