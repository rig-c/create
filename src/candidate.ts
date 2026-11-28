import { constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADOPTED_COMPOSE_BUILD, adoptedComposeBuildMatches, stageAdoptedCompose } from './adopted-compose.ts';
import { hasKeyedCamera, validateCameraOptions } from './camera-choice.ts';
import { collectItems, isObject, loadCollection, type Item } from './check.ts';
import { optionFile, pendingInterviewOptions, validateContext, validateSet } from './choices.ts';
import { readComposeValue } from './compose-value.ts';
import { currentFileBinding, outputRoot, sha256, treeFiles } from './current.ts';
import { matchesComposeValue, readComposedTake, readComposeSceneInputs } from './current-direction.ts';
import { COMPOSE_CAMERA_REPORT_SPEC } from './direction-compose.ts';
import { directionFail, directionJson, objects } from './direction.ts';
import { refuse } from './refusal.ts';
import { currentSceneRig, sceneBinding, sceneBytes } from './scene.ts';
import type { JsonObject } from './templates.ts';

const CANDIDATE_OPTION_SET_STALE = 'CANDIDATE_OPTION_SET_STALE';

type Binding = { path: string; sha256: string };

export function composableOptions(set: JsonObject) {
  return objects(set.asks).flatMap(ask => objects(ask.options).flatMap(option => {
    const fragment = option.fragment;
    if (option.kind !== 'value' || !isObject(fragment) || fragment.compose === undefined) return [];
    return [{ askId: String(ask.id), optionId: String(option.id), label: String(option.label), compose: fragment.compose }];
  }));
}

export function resolveCandidateSet(root: string, project: JsonObject, question: string, setId: string, now: number) {
  const stale = (): never => refuse(CANDIDATE_OPTION_SET_STALE,
    `project.json: ${question}/${setId} is no longer the pending post option set. Run rig-create next <dir> and use the candidate open command it shows for the current set.`);
  const collection = loadCollection(root, project);
  const matches = collectItems(project, { collection }).filter(item => item.kind === 'post' && item.id === question);
  if (matches.length !== 1) return stale();
  const item: Item = matches[0]!;
  const binding = pendingInterviewOptions(item);
  if (!sceneBinding(binding)) return stale();
  const { set } = optionFile(root, binding);
  if (set.id !== setId || set.stage !== 'post-interview') return stale();
  validateSet(project, item, set, collection);
  validateContext(root, project, set, now, true);
  validateCameraOptions(root, set);
  return { set, binding, options: composableOptions(set) };
}

function readCandidateScene(root: string, source: Binding, snapshots: Map<string, Buffer>): JsonObject {
  const bytes = sceneBytes(root, source.path, 'INTERVIEW_CAMERA_SCENE_INVALID', snapshots);
  if (sha256(bytes) !== source.sha256) {
    directionFail('INTERVIEW_CAMERA_SCENE_INVALID', source.path, 'restore the exact scene bound by the current option or register a new option set');
  }
  return directionJson(bytes, source.path);
}

/** Compact current-rig staging uses the same Parts build layout as the worked example. */
function stageCurrentCandidateBuild(root: string, project: JsonObject, path: string, snapshots: Map<string, Buffer>): string {
  const rigRoot = outputRoot('rig');
  const rig = isObject(project.current) ? project.current.rig : undefined;
  const parts = isObject(project.current) ? project.current.parts : undefined;
  const fail = (file: string): never => directionFail('DIRECTION_COMPOSE_RUN_RIG', file,
    'restore the recorded current rig, parts and check files before opening candidates');
  if (!isObject(rig)) return fail('current.rig');
  if (currentFileBinding(project, 'rig', `${rigRoot}/parts.json`)
    && currentFileBinding(project, 'rig', `${rigRoot}/rig/rig.json`)
    && currentFileBinding(project, 'rig', `${rigRoot}/rig/motion.json`)) return rigRoot;
  const rigFiles = objects(rig.files);
  const partsRoot = `${outputRoot('parts')}/rig/`;
  if (!isObject(parts) || !currentFileBinding(project, 'parts', `${partsRoot}parts.json`)) return fail('current.parts');
  const rigPrefix = currentFileBinding(project, 'rig', `${rigRoot}/rig/rig.json`) ? `${rigRoot}/rig/` : `${rigRoot}/`;
  const rigRelative = (value: JsonObject) => String(value.path).slice(rigPrefix.length);
  const inputs = [
    ...objects(parts.files).filter(value => String(value.path).startsWith(partsRoot))
      .map(value => ({ file: value, target: String(value.path).slice(partsRoot.length) })),
    ...rigFiles.filter(value => String(value.path).startsWith(rigPrefix)
        && (['rig.json', 'motion.json'].includes(rigRelative(value)) || rigRelative(value).startsWith('images/')))
      .map(value => ({ file: value, target: `rig/${rigRelative(value)}` })),
    { file: currentFileBinding(project, 'rig', `${rigRoot}/check/check.json`), target: 'check/check.json' },
  ];
  for (const rel of ['parts.json', 'rig/rig.json', 'rig/motion.json', 'check/check.json']) {
    if (!inputs.some(input => input.target === rel && input.file)) return fail(rel);
  }
  for (const { file, target } of inputs) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string') return fail(target);
    const bytes = sceneBytes(root, file.path, 'DIRECTION_COMPOSE_RUN_RIG', snapshots);
    if (sha256(bytes) !== file.sha256) return fail(file.path);
    const to = join(root, path, target);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(root, file.path), to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    if (sha256(readFileSync(to)) !== file.sha256) return fail(file.path);
  }
  return path;
}

function cameraFreeScene(sourcePath: string, value: ReturnType<typeof readComposeValue>, build: string, duration: number): JsonObject {
  const ids = value.order.filter(id => !value.plates.some(plate => plate.name === id));
  if (ids.length !== 1) directionFail('DIRECTION_COMPOSE_SCHEMA', sourcePath, 'name one character and each declared plate in the composition order');
  const relative = (path: string) => posix.relative(posix.dirname(sourcePath), path);
  return {
    spec: 'spine-parts-scene/1',
    canvas: { ...value.canvas },
    order: value.order,
    characters: [{ id: ids[0]!, build: relative(build), ...value.character, canvas_clip: true }],
    plates: value.plates.map(plate => ({ ...plate, image: relative(plate.image), provenance: 'unknown' })),
    animations: { idle: { duration: value.end ?? duration, loop: true, tracks: value.idle_tracks as unknown as JsonObject[] } },
  };
}

export function prepareCandidateScene(root: string, project: JsonObject, option: ReturnType<typeof composableOptions>[number],
  generatedPath: string, snapshots: Map<string, Buffer>) {
  const value = readComposeValue(option.compose, `options[${option.optionId}].fragment.compose`);
  const { rig } = currentSceneRig(root, project, snapshots);
  if (!sceneBinding(rig.model)) directionFail('SCENE_CURRENT_RIG_REQUIRED', 'current.rig.files', 'record the rig with its compiled model before scene write');
  const adopted = isObject(project.current) && isObject(project.current.rig) && isObject(project.current.rig.adopted);
  const authoredScene = value.camera_scene;
  const generated = !sceneBinding(authoredScene);
  let source: Binding;
  let scene: JsonObject;
  if (!generated) {
    source = { path: String(authoredScene.path), sha256: String(authoredScene.sha256) };
    scene = readCandidateScene(root, source, snapshots);
  } else {
    const modelPath = String(rig.model.path);
    const model = directionJson(sceneBytes(root, modelPath, 'SCENE_MODEL_MISMATCH', snapshots), modelPath);
    const duration = objects(model.animations).find(animation => animation.name === 'idle')?.duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
      directionFail('DIRECTION_COMPOSE_DURATION', modelPath, 'restore a current model with a positive idle duration');
    }
    const build = adopted ? ADOPTED_COMPOSE_BUILD : stageCurrentCandidateBuild(root, project, posix.join(posix.dirname(generatedPath), 'character'), snapshots);
    scene = cameraFreeScene(generatedPath, value, build, duration);
    const bytes = Buffer.from(`${JSON.stringify(scene, null, 2)}\n`);
    source = { path: generatedPath, sha256: sha256(bytes) };
    writeFileSync(join(root, generatedPath), bytes, { flag: 'wx', mode: 0o600 });
    snapshots.set(source.path, bytes);
  }
  const inputs = readComposeSceneInputs(root, project, source, scene, snapshots);
  if (adopted && inputs.build === ADOPTED_COMPOSE_BUILD && !adoptedComposeBuildMatches(root, project, inputs.build)) {
    stageAdoptedCompose([root]);
  }
  if (adopted && !adoptedComposeBuildMatches(root, project, inputs.build)) {
    directionFail('DIRECTION_COMPOSE_RUN_RIG', source.path, 'stage and verify the adopted rig build with rig-create scene stage-adopted');
  }
  if (!matchesComposeValue(value, scene, inputs.character, inputs.idle, inputs.registered)) {
    directionFail('DIRECTION_COMPOSE_CHOICE_MISMATCH', source.path, 'copy canvas, plates, order, placement and idle tracks from the bound compose option');
  }
  const takeDuration = inputs.idle.duration;
  if (typeof takeDuration !== 'number' || !Number.isFinite(takeDuration) || takeDuration <= 0
    || (value.end !== undefined && value.end !== takeDuration)) {
    directionFail('DIRECTION_COMPOSE_DURATION', source.path, 'match the take duration to the scene idle and option track end');
  }
  return {
    ...inputs, source, scene, takeDuration, canvas: value.canvas,
    generated, keyed: hasKeyedCamera(scene), loop: inputs.idle.loop !== false, modelSha256: String(rig.model.sha256), rigModelPath: String(rig.model.path),
  };
}

export function verifyCandidateOutput(root: string, project: JsonObject, from: string,
  input: ReturnType<typeof prepareCandidateScene>, snapshots: Map<string, Buffer>) {
  const inventory = treeFiles(root, from);
  const files = new Map(inventory.map(({ path, sha256 }) => [path, sha256]));
  const take = readComposedTake(root, project, from, from, input, input.modelSha256, files, snapshots);
  if (input.keyed !== (take.sceneReport.spec === COMPOSE_CAMERA_REPORT_SPEC)) {
    directionFail('DIRECTION_COMPOSE_RUN_SCENE', take.run.binding.path, 'compose the exact candidate scene into a fresh output directory');
  }
  const clockPath = input.keyed ? `${from}/scene.json` : `${from}/rig/motion.json`;
  const clockBytes = sceneBytes(root, clockPath, 'DIRECTION_COMPOSE_DURATION', snapshots);
  if (sha256(clockBytes) !== files.get(clockPath)) {
    directionFail('DIRECTION_COMPOSE_DURATION', clockPath, 'restore the exact producer clock evidence or compose into a fresh candidate directory');
  }
  const clock = directionJson(clockBytes, clockPath);
  const clips = input.keyed && isObject(clock.camera) ? clock.camera.tracks : clock.animations;
  const idle = isObject(clips) ? clips.idle : undefined;
  if (!isObject(idle) || idle.duration !== input.takeDuration || idle.loop !== input.loop) {
    directionFail('DIRECTION_COMPOSE_DURATION', clockPath, 'compose the exact candidate scene with its bound idle duration and loop');
  }
  return { ...take, inventory, duration: input.takeDuration, loop: input.loop };
}

/** Invoke the same pinned Parts producer used by the recorded-direction path. */
export async function composeCandidate(root: string, project: JsonObject, from: string,
  input: ReturnType<typeof prepareCandidateScene>, snapshots: Map<string, Buffer>) {
  const partsCli = fileURLToPath(import.meta.resolve('@rig-c/parts/cli.ts'));
  const run = async () => {
    const child = Bun.spawn([process.execPath, partsCli, 'compose', '--scene', input.source.path, '--out', from], {
      cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
    });
    const diagnostics = await new Response(child.stdout).text();
    return { diagnostics, exit: await child.exited };
  };
  let result = await run();
  // Parts owns the bounds decision. Its compose-stage refusal leaves the output unwritten.
  if (result.exit !== 0 && input.generated
    && /^\[compose\]\s+FAIL\s+SCENE_CHARACTER_CLIP_UNUSED:/m.test(result.diagnostics)
    && /^\[compose\] refused: 1 problem\(s\)$/m.test(result.diagnostics)) {
    const character = { ...input.character };
    delete character.canvas_clip;
    const scene = { ...input.scene, characters: [character] };
    const bytes = Buffer.from(`${JSON.stringify(scene, null, 2)}\n`);
    const source = { ...input.source, sha256: sha256(bytes) };
    writeFileSync(join(root, source.path), bytes, { mode: 0o600 });
    snapshots.set(source.path, bytes);
    input = { ...input, source, character, scene };
    result = await run();
  }
  if (result.exit !== 0) {
    if (result.diagnostics) process.stderr.write(result.diagnostics);
    directionFail('DIRECTION_COMPOSE_GREEN', from, 'resolve the Parts compose diagnostics and run candidate open again');
  }
  // Check the literal scene again after the producer has consumed it.
  readCandidateScene(root, input.source, new Map());
  return { input, output: verifyCandidateOutput(root, project, from, input, snapshots) };
}
