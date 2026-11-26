/** Immutable scene publication. The scenes[] append is the commit point. */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { checkProject, isObject, type Finding } from './check.ts';
import { writeDirectionSpec } from './direction-spec-write.ts';
import { closed, directionHash } from './direction.ts';
import { checkPlateRegistrations } from './plate-receipt.ts';
import { commitProjectStep } from './project-step-commit.ts';
import type { CommandResult } from './interview.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { SCENE_CHOICE_MISMATCH, resolveAgentCitationSpec } from './scene-authority.ts';
import { CURRENT_SCENE_PATH, CURRENT_SCENE_SPEC, currentSceneRig, validateCurrentScene, SCENE_SPEC, SceneError, checkScenes, plateRegistration, pngDimensions, sceneBytes, sceneEntries, sceneFail, scenePath, sceneRig, validateScene } from './scene.ts';
import type { JsonObject } from './templates.ts';

export const SCENE_HELP = `scene write --rig <R> --background <path> [--foreground <path>] [--animation <name>]
  [--background-rect x,y,w,h] [--foreground-rect x,y,w,h]
  --citations-file <retained project-relative JSON> [<dir>]
  Retain citations inside the project, for example evidence/scene-src/citations.json; absolute paths are refused.
  Citations are a role map {background: citation, foreground?: citation}.
  Each citation names post_composition, asks:["post_composition"], and quote or delegated:true.
  Paths and rects must match the current ingested post_composition choice.
  Animation defaults to idle and must name a clip in the accepted bound model.
  Only idle binds registration.idle frames; other clips omit optional frames.
  Records by:agent; typed --by is refused. Earlier human scenes remain readable.
  Appends evidence/scene/s<N>.json and scenes[]; stage stays unchanged.
scene write --background <path> [--foreground <path>] [--animation <name>] --citations-file <file> [<dir>]
scene write --compose-scene <Parts scene file> [--animation <name>] [<dir>]
  Write specs/direction/scene.json binding current.rig and current.motion by hash.`;
export interface SceneWriteHooks { beforeCommit?: () => void; }
export function sceneCommand(args: string[], now: number, hooks: SceneWriteHooks = {}): CommandResult {
  try {
    return args.includes('--rig') ? writeScene(args, now, hooks) : writeCurrentScene(args, hooks);
  }
  catch (error) { if (error instanceof SceneError) refuse(error.code, error.message); throw error; }
}
function writeScene(args: string[], now: number, hooks: SceneWriteHooks): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  const usage = (): never => refuse('SCENE_MALFORMED', `scene: ${SCENE_HELP}`, USAGE_EXIT);
  if (args[0] !== 'write') usage();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (['--rig', '--background', '--foreground', '--background-rect', '--foreground-rect', '--citations-file', '--animation', '--by'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--') || opts[arg] !== undefined) usage();
      opts[arg] = value;
    } else if (arg.startsWith('-')) usage();
    else positional.push(arg);
  }
  if (opts['--by'] !== undefined) sceneFail('SCENE_AUTHOR_TYPED', 'scene.by', 'typed scene authority is not supported', 'omit --by and cite the current post_composition Review choice');
  if (positional.length > 1 || ['--rig', '--background', '--citations-file'].some(key => !opts[key])
    || !/^[1-9][0-9]*$/.test(opts['--rig']!) || !Number.isSafeInteger(Number(opts['--rig']))
    || opts['--foreground-rect'] && !opts['--foreground']) usage();
  const dir = resolve(positional[0] ?? process.cwd());
  const snapshots = new Map<string, Buffer>();
  const original = sceneBytes(dir, 'project.json', 'SCENE_MALFORMED', snapshots);
  let project: JsonObject;
  try { project = JSON.parse(original.toString('utf8')) as JsonObject; }
  catch { return sceneFail('SCENE_MALFORMED', 'project.json', 'expected a project JSON object'); }
  if (!isObject(project) || project.schema !== 'rig-create/project@0') sceneFail('SCENE_MALFORMED', 'project.json.schema', 'expected rig-create/project@0');
  const collectionRoot = basename(dirname(dir)) === 'members' ? dirname(dirname(dir)) : null;
  const collection = collectionRoot && existsSync(join(collectionRoot, 'collection.json')) ? sceneBytes(collectionRoot, 'collection.json', 'SCENE_MALFORMED') : null;
  // Shares the direction lock because a direction derives the current scene.
  const lock = join(dir, '.direction.lock');
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx'); }
  catch { return sceneFail('SCENE_MALFORMED', 'project.json', 'another scene or direction writer holds the lock'); }
  const createdDirectories: string[] = [];
  let document: string | null = null;
  let temporary: string | null = null;
  try {
    const entries = sceneEntries(project);
    const n = entries.length + 1;
    const binding = sceneRig(dir, project, Number(opts['--rig']), snapshots, opts['--animation']);
    const plates = scenePlates(dir, project, opts, binding.stage, snapshots);
    const doc: JsonObject = { schema: SCENE_SPEC, n, rig: binding.rig, frame: { space: 'rig-world-y-up', stage: binding.stage }, plates, layers: opts['--foreground'] ? ['background', 'rig', 'foreground'] : ['background', 'rig'] };
    validateScene(dir, project, doc, snapshots, true, 'agent');
    const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
    const entry = { n, path: scenePath(n), sha256: directionHash(bytes), at: new Date(now).toISOString(), by: 'agent' };
    const next = { ...project, scenes: [...entries, entry] };
    const baseline = baselineOf(checkProject(dir, project, { now }));
    for (const part of ['evidence', 'scene']) {
      const parent = part === 'evidence' ? join(dir, part) : join(dir, 'evidence', part);
      if (existsSync(parent)) {
        if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) sceneFail('SCENE_MALFORMED', entry.path, 'scene parents must be real directories');
      } else { mkdirSync(parent); createdDirectories.push(parent); }
    }
    const destination = join(dir, entry.path);
    if (existsSync(destination)) sceneFail('SCENE_FILE_CHANGED', entry.path, 'immutable scene destination already exists');
    writeFileSync(destination, bytes, { flag: 'wx' });
    document = destination;
    const own: { dir: string; project: JsonObject; refusals: Finding[] } = { dir, project: next, refusals: [] };
    checkScenes(own);
    checkPlateRegistrations({ ...own, warnings: [] });
    if (own.refusals[0]) sceneFail(own.refusals[0].code, own.refusals[0].path, own.refusals[0].message);
    const fresh = newFindings(baseline, checkProject(dir, next, { now }).refusals)[0];
    if (fresh) sceneFail(fresh.code, fresh.path, fresh.message);
    hooks.beforeCommit?.();
    if (collectionRoot && collection && !sceneBytes(collectionRoot, 'collection.json', 'SCENE_MALFORMED').equals(collection)) sceneFail('SCENE_MALFORMED', 'collection.json', 'inherited citation changed during publication');
    for (const [path, expected] of snapshots) {
      if (!sceneBytes(dir, path, 'SCENE_FILE_CHANGED').equals(expected)) sceneFail('SCENE_FILE_CHANGED', path, 'source changed before the scenes[] commit');
    }
    if (!readFileSync(destination).equals(bytes)) sceneFail('SCENE_FILE_CHANGED', entry.path, 'scene document changed before the commit');
    temporary = join(dir, `.scene-${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, join(dir, 'project.json'));
    document = null;
    return { stdout: `scene: s${n} recorded; stage unchanged`, exit: 0 };
  } finally {
    if (temporary) rmSync(temporary, { force: true });
    if (document) rmSync(document, { force: true });
    for (const directory of createdDirectories.reverse()) { try { rmdirSync(directory); } catch { /* Keep committed evidence. */ } }
    closeSync(descriptor);
    rmSync(lock);
  }
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

function writeCurrentScene(args: string[], hooks: SceneWriteHooks): CommandResult {
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
  writeDirectionSpec(dir, CURRENT_SCENE_PATH, 'SCENE_FILE_CHANGED', snapshots => {
    const original = sceneBytes(dir, 'project.json', 'SCENE_MALFORMED', snapshots);
    let project: JsonObject;
    try { project = JSON.parse(original.toString('utf8')) as JsonObject; }
    catch { return sceneFail('SCENE_MALFORMED', 'project.json', 'expected a project JSON object'); }
    if (!isObject(project) || project.schema !== 'rig-create/project@0') sceneFail('SCENE_MALFORMED', 'project.json.schema', 'expected rig-create/project@0');
    const { rig, stage } = currentSceneRig(dir, project, snapshots, opts['--animation']);
    const doc: JsonObject = { schema: CURRENT_SCENE_SPEC, rig, frame: { space: 'rig-world-y-up', stage } };
    if (composePath) {
      const bytes = sceneBytes(dir, composePath, 'SCENE_MALFORMED', snapshots);
      let source: JsonObject;
      try { source = JSON.parse(bytes.toString('utf8')) as JsonObject; }
      catch { return sceneFail('SCENE_MALFORMED', composePath, 'expected a Parts spine-parts-scene/1 JSON object'); }
      if (!isObject(source) || source.spec !== 'spine-parts-scene/1') sceneFail('SCENE_MALFORMED', composePath, 'expected a Parts spine-parts-scene/1 scene');
      if (composePath === CURRENT_SCENE_PATH || composePath.startsWith('outputs/')) sceneFail('SCENE_MALFORMED', composePath, 'retain the Parts input under specs/direction/ before scene write');
      doc.compose = { path: composePath, sha256: directionHash(bytes) };
    } else {
      doc.plates = scenePlates(dir, project, opts, stage, snapshots);
      doc.layers = opts['--foreground'] ? ['background', 'rig', 'foreground'] : ['background', 'rig'];
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
  const stderr = commitProjectStep(dir, 'scene', ['scene', ...args].join(' '), CURRENT_SCENE_PATH);
  return { stdout: `scene: ${CURRENT_SCENE_PATH} written`, exit: 0, ...(stderr ? { stderr } : {}) };
}
