/** Current-path scene spec writer and adopted-compose stager. */
import { resolve } from 'node:path';
import { isObject, type Finding } from './check.ts';
import { CAMERA_SCENE_BINDING_SINCE, currentCameraBindingFinding, hasKeyedCamera } from './camera-choice.ts';
import { stageAdoptedCompose } from './adopted-compose.ts';
import { writeDirectionSpec } from './direction-spec-write.ts';
import { closed, directionHash } from './direction.ts';
import { checkPlateRegistrations } from './plate-receipt.ts';
import { commitProjectStep } from './project-step-commit.ts';
import type { CommandResult } from './interview.ts';
import { refuseNumberedWriter } from './numbered-retirement.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { SCENE_CHOICE_MISMATCH, resolveAgentCitationSpec } from './scene-authority.ts';
import { CURRENT_SCENE_PATH, CURRENT_SCENE_SPEC, currentSceneRig, validateCurrentScene, SceneError, plateRegistration, pngDimensions, sceneBytes, sceneFail } from './scene.ts';
import type { JsonObject } from './templates.ts';

export const SCENE_HELP = `scene write --background <path> [--foreground <path>] [--animation <name>]
  [--background-rect x,y,w,h] [--foreground-rect x,y,w,h] --citations-file <file> [<dir>]
scene write --compose-scene <Parts scene file> [--animation <name>] [<dir>]
  Write specs/direction/scene.json binding current.rig and current.motion by hash.
  Retain citations or the Parts scene inside the project; absolute paths and typed --by are refused.
scene stage-adopted [<dir>]
  Copy and verify the retained adopted rig inputs under derived/direction-adopted-build.`;

export interface SceneWriteHooks { beforeCommit?: () => void; }

export function sceneCommand(args: string[], now = Date.now(), hooks: SceneWriteHooks = {}): CommandResult {
  try {
    if (args[0] === 'stage-adopted') return stageAdoptedCompose(args.slice(1));
    if (args.some(arg => arg === '--rig' || arg.startsWith('--rig='))) {
      refuseNumberedWriter('scene write --rig', {
        path: 'project.json.scenes',
        replacement: 'use rig-create scene write --background <path> --citations-file <file> or rig-create scene write --compose-scene <file>',
      });
    }
    return writeCurrentScene(args, now, hooks);
  }
  catch (error) { if (error instanceof SceneError) refuse(error.code, error.message); throw error; }
}

function scenePlates(dir: string, project: JsonObject, opts: Record<string, string>, stage: JsonObject, snapshots: Map<string, Buffer>): JsonObject[] {
  const citationsBytes = sceneBytes(dir, opts['--citations-file']!, 'SCENE_CITATION_MISSING', snapshots);
  let citations: JsonObject;
  try { citations = JSON.parse(citationsBytes.toString('utf8')) as JsonObject; }
  catch { return sceneFail('SCENE_CITATION_MISSING', opts['--citations-file']!, 'expected a plate-role citation map'); }
  if (!closed(citations, ['background'], opts['--foreground'] ? ['foreground'] : []) || opts['--foreground'] && citations.foreground === undefined) sceneFail('SCENE_CITATION_MISSING', opts['--citations-file']!, 'provide exactly the declared plate-role citations');
  const plates: JsonObject[] = [];
  for (const role of ['background', 'foreground']) {
    const path = opts[`--${role}`];
    if (path === undefined) continue;
    const bytes = sceneBytes(dir, path, 'SCENE_PLATE_CHANGED', snapshots);
    const size = pngDimensions(bytes, path);
    const identity = { path, sha256: directionHash(bytes) };
    const registered = plateRegistration(project, identity);
    if (!registered) sceneFail('SCENE_PLATE_UNREGISTERED', path, 'register this plate as an input or a receipted prepared-input chain');
    let rect = stage;
    const value = opts[`--${role}-rect`];
    if (value !== undefined) {
      const parts = value.split(',');
      if (parts.length !== 4 || parts.some(part => !part.trim())) sceneFail('SCENE_PLACEMENT_INVALID', `${path}.rect`, 'supply x,y,width,height');
      const [x, y, width, height] = parts.map(Number);
      rect = { x: x!, y: y!, width: width!, height: height! };
    } else {
      const spec = resolveAgentCitationSpec(dir, project, citations[role]!, snapshots);
      if (role === 'foreground') {
        if (!spec.foreground) {
          sceneFail(
            SCENE_CHOICE_MISMATCH,
            'scene.plates[1]',
            'scene declares a foreground plate not present in post_composition value.scene',
            'match the exact roles, paths and rects from the cited post_composition choice in the Review tool (or record a new post_composition choice in the Review tool) and run scene write',
          );
        }
        rect = spec.foreground.rect;
      } else {
        rect = spec.background.rect;
      }
    }
    plates.push({ role, ...identity, ...size, rect, registered, citation: citations[role]! });
  }
  return plates;
}

function writeCurrentScene(args: string[], now: number, hooks: SceneWriteHooks): CommandResult {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  const usage = (): never => refuse('SCENE_MALFORMED', `scene: ${SCENE_HELP}`, USAGE_EXIT);
  if (args[0] !== 'write') return usage();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (['--compose-scene', '--background', '--foreground', '--background-rect', '--foreground-rect', '--citations-file', '--animation', '--by'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || opts[arg] !== undefined) return usage();
      opts[arg] = value;
    } else if (arg.startsWith('-')) return usage();
    else positional.push(arg);
  }
  if (opts['--by'] !== undefined) sceneFail('SCENE_AUTHOR_TYPED', 'scene.by', 'typed scene authority is not supported', 'omit --by and cite the current post_composition Review choice');
  const composePath = opts['--compose-scene'];
  const plateArgs = ['--background', '--foreground', '--background-rect', '--foreground-rect', '--citations-file'];
  if (positional.length > 1 || (composePath ? plateArgs.some(key => opts[key] !== undefined)
    : !opts['--background'] || !opts['--citations-file'] || opts['--foreground-rect'] && !opts['--foreground'])) return usage();
  const dir = resolve(positional[0] ?? process.cwd());
  let warning: string | undefined;
  writeDirectionSpec(dir, CURRENT_SCENE_PATH, 'SCENE_FILE_CHANGED', snapshots => {
    const original = sceneBytes(dir, 'project.json', 'SCENE_MALFORMED', snapshots);
    let project: JsonObject;
    try { project = JSON.parse(original.toString('utf8')) as JsonObject; }
    catch { return sceneFail('SCENE_MALFORMED', 'project.json', 'expected a project JSON object'); }
    if (!isObject(project) || project.schema !== 'rig-create/project@0') sceneFail('SCENE_MALFORMED', 'project.json.schema', 'expected rig-create/project@0');
    const { rig, stage } = currentSceneRig(dir, project, snapshots, opts['--animation']);
    const doc: JsonObject = { schema: CURRENT_SCENE_SPEC, rig, frame: { space: 'rig-world-y-up', stage } };
    let keyed = false;
    if (composePath) {
      const bytes = sceneBytes(dir, composePath, 'SCENE_MALFORMED', snapshots);
      let source: JsonObject;
      try { source = JSON.parse(bytes.toString('utf8')) as JsonObject; }
      catch { return sceneFail('SCENE_MALFORMED', composePath, 'expected a Parts spine-parts-scene/1 JSON object'); }
      if (!isObject(source) || source.spec !== 'spine-parts-scene/1') sceneFail('SCENE_MALFORMED', composePath, 'expected a Parts spine-parts-scene/1 scene');
      if (composePath === CURRENT_SCENE_PATH || composePath.startsWith('outputs/')) sceneFail('SCENE_MALFORMED', composePath, 'retain the Parts input under specs/direction/ before scene write');
      doc.compose = { path: composePath, sha256: directionHash(bytes) };
      keyed = hasKeyedCamera(source);
    } else {
      doc.plates = scenePlates(dir, project, opts, stage, snapshots);
      doc.layers = opts['--foreground'] ? ['background', 'rig', 'foreground'] : ['background', 'rig'];
    }
    const finding = currentCameraBindingFinding(dir, project, (doc.compose as JsonObject | undefined) ?? { path: CURRENT_SCENE_PATH }, keyed, snapshots);
    if (finding) {
      if (now >= Date.parse(CAMERA_SCENE_BINDING_SINCE)) throw finding;
      warning = `rig-create: WARN ${finding.code}: ${finding.message}`;
    }
    validateCurrentScene(dir, project, doc, snapshots);
    if (!composePath) {
      const refusals: Finding[] = [];
      checkPlateRegistrations({ dir, project, refusals, warnings: [] });
      const issue = refusals[0];
      if (issue) sceneFail(issue.code, issue.path, issue.message);
    }
    return doc;
  }, hooks.beforeCommit);
  const stderr = [warning, commitProjectStep(dir, 'scene', ['scene', ...args].join(' '), CURRENT_SCENE_PATH)].filter(Boolean).join('\n');
  return { stdout: `scene: ${CURRENT_SCENE_PATH} written`, exit: 0, ...(stderr ? { stderr } : {}) };
}
