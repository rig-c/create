import { isDeepStrictEqual as equal } from 'node:util';
import { collectItems, isObject, loadCollection } from './check.ts';
import { ChoiceError } from './choices.ts';
import { sceneBinding, sceneBytes, SceneError } from './scene.ts';
import { resolveAnswerValue } from './scene-authority.ts';
import { directionHash, directionJson, objects } from './direction.ts';
import type { Json, JsonObject } from './templates.ts';

export const CAMERA_SCENE_BINDING_SINCE = '2026-11-28T00:00:00Z';

export function hasKeyedCamera(scene: JsonObject): boolean {
  return isObject(scene.camera) && isObject(scene.camera.tracks)
    && Object.values(scene.camera.tracks).some(keys => Array.isArray(keys) && keys.length > 0);
}

export function validateCameraOptions(dir: string, set: JsonObject): void {
  if (set.question !== 'post_composition') return;
  for (const ask of objects(set.asks)) {
    for (const option of objects(ask.options)) {
      const fragment = option.fragment;
      if (!isObject(fragment) || !isObject(fragment.compose) || !('camera_scene' in fragment.compose)) continue;
      const path = `options[${String(option.id)}].fragment.compose`;
      const binding = fragment.compose.camera_scene;
      const file = String(isObject(binding) ? binding.path : '(missing)');
      const invalid = (): never => {
        throw new ChoiceError('INTERVIEW_CAMERA_SCENE_INVALID',
          `${path}.camera_scene: ${file} must bind a retained keyed Parts scene by path and sha256. Fix the option file and regenerate its preview from that scene`);
      };
      if (!sceneBinding(binding)) return invalid();
      try {
        if (file.startsWith('outputs/') || file.startsWith('scratch/') || file.startsWith('.git/') || file.startsWith('node_modules/')) invalid();
        const bytes = sceneBytes(dir, file, 'INTERVIEW_CAMERA_SCENE_INVALID');
        const scene = directionJson(bytes, file);
        if (scene.spec !== 'spine-parts-scene/1' || !hasKeyedCamera(scene) || directionHash(bytes) !== binding.sha256) invalid();
      } catch {
        invalid();
      }
    }
  }
}

export function cameraChoiceId(answer: JsonObject | undefined): string {
  const choice = answer?.choice;
  const pick = isObject(choice) ? objects(choice.picks).find(row => row.ask === 'post_composition') : undefined;
  return String(pick?.option_id ?? '(missing)');
}

export function currentComposition(dir: string, project: JsonObject, snapshots?: Map<string, Buffer>) {
  const item = collectItems(project, { collection: loadCollection(dir) }).find(row => row.id === 'post_composition');
  if (!item || (item.state.state !== 'user' && item.state.state !== 'delegated')) return;
  const answer = item.state.answer;
  if (!isObject(answer.choice)) return { answer, value: undefined };
  const citation: JsonObject = answer.delegated === true ? { delegated: true } : { quote: String(answer.verbatim ?? '') };
  return { answer, value: resolveAnswerValue(dir, item.path, answer, citation, snapshots).value };
}

export function cameraBindingFinding(source: JsonObject, choice: string, selected: Json | undefined): SceneError | undefined {
  if (equal(source, selected)) return;
  const binding = isObject(selected) ? selected : undefined;
  return new SceneError(binding ? 'SCENE_CAMERA_CHOICE_MISMATCH' : 'SCENE_CAMERA_CHOICE_MISSING', String(source.path),
    `post_composition choice ${choice} camera_scene path ${String(binding?.path ?? '(missing)')}, sha256 ${String(binding?.sha256 ?? '(missing)')}; authored scene sha256 ${String(source.sha256)}`,
    binding ? `pass ${String(binding.path)} to scene write with its originally shown bytes, or register a new option file and relay the new pick`
      : 'add camera_scene to a new post_composition option file, register it and relay the owner pick before running scene write');
}

export function currentCameraBindingFinding(dir: string, project: JsonObject, source: JsonObject, snapshots?: Map<string, Buffer>): SceneError | undefined {
  const chosen = currentComposition(dir, project, snapshots);
  const compose = isObject(chosen?.value) && isObject(chosen.value.compose) ? chosen.value.compose : undefined;
  return cameraBindingFinding(source, cameraChoiceId(chosen?.answer), compose?.camera_scene);
}
