import { resolve, posix } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { isObject } from './check.ts';
import { ComposeValueError, readComposeValue } from './compose-value.ts';
import { CURRENT_RIG_MODEL, currentFileBinding, outputRoot, sha256 } from './current.ts';
import { citedValues, COMPOSE_CAMERA_REPORT_SPEC, readComposeRun, validateComposeCameraModel, validateComposeCitations, validateComposeRunInputs } from './direction-compose.ts';
import { COMPOSE_CHECK_PATH, COMPOSE_MODEL_PATH } from './direction-loop-seam.ts';
import { closed, directionBytes, directionFail, directionJson, objects, validateDirectionCitations } from './direction.ts';
import { CURRENT_SCENE_PATH, SceneError, plateRegistration, sceneBinding, sceneBytes, validateCurrentScene } from './scene.ts';
import { validateAgentPlateRegistration } from './scene-authority.ts';
import type { JsonObject } from './templates.ts';

export const CURRENT_DIRECTION_PATH = 'specs/direction/direction.json';
export const CURRENT_DIRECTION_SPEC = 'rig-create/direction@4';
export const COMPOSE_RUN_PATH = 'compose-run.json';
export { COMPOSE_CHECK_PATH } from './direction-loop-seam.ts';
const REQUIRED_CHARACTER_FILES = ['check/check.json', 'parts.json', 'rig/rig.json', 'rig/motion.json'];
type Binding = { path: string; sha256: string };

function transitionError(error: unknown): never {
  if (error instanceof SceneError || error instanceof ComposeValueError) directionFail(error.code, error.path, error.message);
  throw error;
}

/** Validate the spec and producer input against current bindings and the existing owner answers. */
export function currentDirectionSource(dir: string, project: JsonObject, doc: JsonObject, snapshots: Map<string, Buffer>) {
  const bad = (why: string): never => directionFail('DIRECTION_CURRENT_SPEC_INVALID', CURRENT_DIRECTION_PATH, why);
  if (!closed(doc, ['schema', 'rig', 'scene', 'take', 'citations']) || doc.schema !== CURRENT_DIRECTION_SPEC
    || !closed(doc.rig, ['model']) || !sceneBinding(doc.rig.model) || !sceneBinding(doc.scene) || doc.scene.path !== CURRENT_SCENE_PATH
    || !closed(doc.take, ['duration', 'loop']) || typeof doc.take.duration !== 'number' || !Number.isFinite(doc.take.duration)
    || doc.take.duration <= 0 || doc.take.loop !== true) return bad('write a direction spec with the current rig, scene and a positive looping take');
  const takeDuration = doc.take.duration;
  validateComposeCitations(doc, bad);
  const sceneBytesRaw = sceneBytes(dir, CURRENT_SCENE_PATH, 'DIRECTION_CURRENT_SPEC_INVALID', snapshots);
  if (sha256(sceneBytesRaw) !== doc.scene.sha256) bad('the scene changed; run direction write again');
  const authoredScene = directionJson(sceneBytesRaw, CURRENT_SCENE_PATH);
  validateCurrentScene(dir, project, authoredScene, snapshots);
  const { model, animation } = authoredScene.rig as JsonObject;
  if (!equal(doc.rig.model, model) || (animation as JsonObject).name !== 'idle' || !sceneBinding(authoredScene.compose)) {
    return bad('run scene write --compose-scene with the current rig and idle frames, then run direction write');
  }
  const source = authoredScene.compose as Binding;
  const sourceBytes = directionBytes(dir, source.path);
  if (sha256(sourceBytes) !== source.sha256) bad('the Parts scene changed; run scene write and direction write again');
  snapshots.set(source.path, sourceBytes);
  const scene = directionJson(sourceBytes, source.path);
  const characters = objects(scene.characters);
  const plates = objects(scene.plates);
  const idle = isObject(scene.animations) ? scene.animations.idle : undefined;
  if (scene.spec !== 'spine-parts-scene/1' || characters.length !== 1 || !Array.isArray(scene.characters) || scene.characters.length !== 1
    || scene.plate !== undefined || !Array.isArray(scene.plates) || plates.length !== scene.plates.length || !isObject(idle)) {
    return directionFail('DIRECTION_COMPOSE_SCHEMA', source.path, 'declare one current character, named plates and an idle in a Parts spine-parts-scene/1 scene');
  }
  const character = characters[0]!;
  const sourceRelative = (path: string): string => posix.normalize(posix.join(posix.dirname(source.path), path));
  if (typeof character.id !== 'string' || typeof character.build !== 'string' || posix.isAbsolute(character.build)
    || character.build.includes('\\') || character.build.includes(':')) {
    return directionFail('DIRECTION_COMPOSE_RUN_RIG', `${source.path}.characters[0].build`, 'use an in-project build path relative to the Parts scene');
  }
  const build = sourceRelative(character.build);
  if (!build || build === '.' || build === '..' || build.startsWith('../')) {
    return directionFail('DIRECTION_COMPOSE_RUN_RIG', `${source.path}.characters[0].build`, 'use outputs/rig or stage the exact producer files inside the project');
  }
  const registered = plates.map(plate => {
    if (typeof plate.image !== 'string' || posix.isAbsolute(plate.image)) {
      return directionFail('DIRECTION_COMPOSE_SCHEMA', source.path, 'name each plate image relative to the Parts scene');
    }
    const path = sourceRelative(plate.image);
    const binding = { path, sha256: sha256(sceneBytes(dir, path, 'DIRECTION_COMPOSE_FILE', snapshots)) };
    const registration = plateRegistration(project, binding);
    if (!registration) return directionFail('DIRECTION_COMPOSE_PLATE_UNREGISTERED', path, 'register the plate or its prepared-input receipt chain');
    return { ...binding, registered: registration };
  });
  validateAgentPlateRegistration(dir, project, registered, snapshots);
  validateDirectionCitations(dir, project, doc, true);
  const composition = citedValues(dir, project, doc, 'post_composition', true, snapshots).filter(value => value.compose !== undefined)
    .map(value => readComposeValue(value.compose, 'direction.citations.composition.value.compose'));
  const plateValues = plates.map((plate, i) => ({ name: plate.name!, image: registered[i]!.path, at: plate.at!,
    ...(plate.opaque_backdrop === undefined ? {} : { opaque_backdrop: plate.opaque_backdrop }) }));
  const chosen = composition.find(value => equal(value.canvas, scene.canvas) && equal(value.plates, plateValues)
    && equal(value.order, scene.order) && equal(value.idle_tracks, idle.tracks)
    && equal(value.character, { offset: character.offset!, ...(character.scale === undefined ? {} : { scale: character.scale }) }));
  if (!chosen) return directionFail('DIRECTION_COMPOSE_CHOICE_MISMATCH', source.path, 'copy canvas, plates, order, placement and idle tracks from the current cited compose choice');
  const timing = citedValues(dir, project, doc, 'post_timing', true, snapshots);
  if (!timing.some(value => value.loop === true)) directionFail('DIRECTION_COMPOSE_LOOP', 'direction.take.loop', 'cite the current looping post_timing value');
  if (idle.duration !== takeDuration || (chosen.end !== undefined && chosen.end !== takeDuration)
    || !timing.some(value => value.seconds === takeDuration && value.loop === true)) {
    directionFail('DIRECTION_COMPOSE_DURATION', 'direction.take.duration', 'match the current cited timing, Parts scene idle and track end');
  }
  return { authoredScene, source, scene, character, build, registered, chosen, takeDuration };
}

export function prepareCurrentDirection(dir: string, project: JsonObject, intent: JsonObject, snapshots: Map<string, Buffer>): JsonObject {
  try {
    if (!closed(intent, ['take', 'citations'])) directionFail('DIRECTION_CURRENT_SPEC_INVALID', 'direction --file', 'supply a JSON object containing the take and citations');
    const raw = sceneBytes(dir, CURRENT_SCENE_PATH, 'DIRECTION_CURRENT_SPEC_INVALID', snapshots);
    const binding = currentFileBinding(project, 'rig', CURRENT_RIG_MODEL);
    if (!binding) directionFail('SCENE_CURRENT_RIG_REQUIRED', 'current.rig.files', 'record the rig before direction write');
    const doc: JsonObject = { schema: CURRENT_DIRECTION_SPEC, rig: { model: binding }, scene: { path: CURRENT_SCENE_PATH, sha256: sha256(raw) },
      take: intent.take!, citations: intent.citations! };
    currentDirectionSource(dir, project, doc, snapshots);
    return doc;
  } catch (error) { return transitionError(error); }
}

export function readDirectionOutput(dir: string, project: JsonObject, from: string, spec: string, inventory: Map<string, string>, snapshots: Map<string, Buffer>) {
  try {
    if (spec !== CURRENT_DIRECTION_PATH) directionFail('DIRECTION_CURRENT_SPEC_INVALID', spec, `pass --direction ${CURRENT_DIRECTION_PATH} after direction write`);
    const bytes = sceneBytes(dir, spec, 'DIRECTION_CURRENT_SPEC_INVALID', snapshots);
    const doc = directionJson(bytes, spec);
    const input = currentDirectionSource(dir, project, doc, snapshots);
    const output = (rel: string, code: string): { bytes: Buffer; binding: Binding } => {
      const path = `${outputRoot('direction')}/${rel}`;
      const raw = sceneBytes(dir, `${from}/${rel}`, code, snapshots);
      const sha = sha256(raw);
      if (inventory.get(path) !== sha) directionFail(code, path, 'compose output changed during recording; run compose into a clean tree and record again');
      return { bytes: raw, binding: { path, sha256: sha } };
    };
    const run = output(COMPOSE_RUN_PATH, 'DIRECTION_COMPOSE_RUN');
    const consumed = readComposeRun(run.bytes, `${from}/${COMPOSE_RUN_PATH}`, input.scene);
    if (resolve(dir, consumed.scene.path) !== resolve(dir, input.source.path)) {
      directionFail('DIRECTION_COMPOSE_RUN_SCENE', `${from}/${COMPOSE_RUN_PATH}.scene`, 'run Parts compose from the project root with the scene named by scene write');
    }
    validateComposeRunInputs(consumed, input.scene, input.source.sha256,
      input.registered.map((plate, i) => ({ ...plate, path: objects(input.scene.plates)[i]!.image! })), `${from}/${COMPOSE_RUN_PATH}`);
    const entry = consumed.characters[0];
    if (consumed.plate !== null || consumed.characters.length !== 1 || !entry || entry.id !== input.character.id || entry.build !== input.character.build
      || !REQUIRED_CHARACTER_FILES.every(path => entry.files.some(file => file.path === path))) {
      return directionFail('DIRECTION_COMPOSE_RUN_RIG', `${from}/${COMPOSE_RUN_PATH}.characters`, 'compose from the current rig build with its check, parts, rig and motion files');
    }
    const rigFiles: Binding[] = [];
    for (const file of entry.files) {
      const readPath = `${input.build}/${file.path}`;
      if (sha256(sceneBytes(dir, readPath, 'DIRECTION_COMPOSE_RUN_RIG', snapshots)) !== file.sha256) {
        directionFail('DIRECTION_COMPOSE_RUN_RIG', readPath, 'restore the exact consumed bytes or recompose from the current rig');
      }
      const root = outputRoot('rig');
      const canonical = currentFileBinding(project, 'rig', `${root}/${file.path}`)
        ?? (file.path.startsWith('rig/') ? currentFileBinding(project, 'rig', `${root}/${file.path.slice('rig/'.length)}`) : undefined);
      // A standalone rig does not own parts.json. Prefer the current parts manifest when recorded,
      // otherwise retain the hash of the manifest the compose producer actually read.
      const binding = canonical ?? (file.path === 'parts.json'
        ? currentFileBinding(project, 'parts', 'outputs/parts/rig/parts.json') ?? { path: readPath, sha256: file.sha256 }
        : undefined);
      if (!binding || binding.sha256 !== file.sha256
        || sha256(sceneBytes(dir, binding.path, 'DIRECTION_COMPOSE_RUN_RIG', snapshots)) !== file.sha256) {
        directionFail('DIRECTION_COMPOSE_RUN_RIG', readPath, 'the consumed file differs from the recorded current build; stage the exact current producer files and recompose');
      }
      if (file.path !== COMPOSE_CHECK_PATH) rigFiles.push(binding!);
    }
    const sceneReportPath = 'scene.json';
    const sceneReport = directionJson(output(sceneReportPath, 'DIRECTION_COMPOSE_FILE').bytes, `${from}/${sceneReportPath}`);
    const placement = objects(sceneReport.characters);
    const reportedPlates = objects(sceneReport.plates);
    const sourcePlates = objects(input.scene.plates);
    const placed = placement[0];
    if ((sceneReport.spec !== 'spine-parts-scene-report/1' && sceneReport.spec !== COMPOSE_CAMERA_REPORT_SPEC) || typeof sceneReport.scene !== 'string'
      || resolve(dir, sceneReport.scene) !== resolve(dir, input.source.path) || !equal(sceneReport.canvas, input.scene.canvas)
      || placement.length !== 1 || !placed || placed.id !== entry.id || placed.build !== entry.build
      || !equal(placed.offset, input.character.offset) || (placed.scale ?? 1) !== (input.character.scale ?? 1)
      || !equal(placed.clipped_bounds, entry.placement?.clipped_bounds) || reportedPlates.length !== sourcePlates.length
      || reportedPlates.some((plate, i) => plate.name !== sourcePlates[i]!.name || plate.image !== sourcePlates[i]!.image
        || !equal(plate.at, sourcePlates[i]!.at) || (plate.opaque_backdrop ?? false) !== (sourcePlates[i]!.opaque_backdrop ?? false)
        || plate.sha256 !== input.registered[i]!.sha256)) {
      directionFail('DIRECTION_COMPOSE_PLACEMENT', `${from}/${sceneReportPath}`, 'retain the Parts scene report matching the source, placement, plates and run; compose again');
    }
    const check = output(COMPOSE_CHECK_PATH, 'DIRECTION_COMPOSE_GREEN');
    const report = directionJson(check.bytes, check.binding.path);
    const model = output(COMPOSE_MODEL_PATH, 'DIRECTION_COMPOSE_FILE');
    validateComposeCameraModel(sceneReport, model.binding.sha256, `${from}/${sceneReportPath}`);
    if (report.spec !== 'rig-parts-check/1' || report.PASS !== true || report.gate_spine_html_green !== true
      || !isObject(report.build) || report.build.model_sha256 !== model.binding.sha256) {
      directionFail('DIRECTION_COMPOSE_GREEN', check.binding.path, 'retain the green Parts compose check that binds this compiled model; compose again');
    }
    const composed = directionJson(model.bytes, model.binding.path);
    const animations = objects(composed.animations).filter(value => value.name === 'idle');
    if (animations.length !== 1 || animations[0]!.duration !== input.takeDuration) {
      directionFail('DIRECTION_COMPOSE_DURATION', model.binding.path, 'composed model idle duration must match the cited take; compose again');
    }
    const { width, height } = input.chosen.canvas;
    if (!equal(composed.stage, { x: -width / 2, y: 0, width, height })) {
      directionFail('DIRECTION_COMPOSE_PLACEMENT', model.binding.path, 'composed model stage must match the cited canvas; compose again');
    }
    const rig = doc.rig as { model: Binding };
    const animation = (input.authoredScene.rig as { animation: { frames: Binding; motion: Binding } }).animation;
    const bindings = [{ path: spec, sha256: sha256(bytes) }, doc.scene as Binding, input.source, rig.model, animation.frames, animation.motion,
      ...rigFiles, ...input.registered.map(({ path, sha256 }) => ({ path, sha256 }))];
    return { built_with: {}, built_from: [...new Map(bindings.map(binding => [binding.path, binding])).values()], run: run.binding,
      report: check.binding, takeDuration: input.takeDuration };
  } catch (error) { return transitionError(error); }
}
