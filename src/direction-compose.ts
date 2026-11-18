/** Composed direction reads sealed producer output; it never repeats producer checks. */
import { isDeepStrictEqual as equal } from 'node:util';
import { lstatSync, readdirSync } from './check-reads.ts';
import { join } from 'node:path';
import { collectItems, isObject, loadCollection } from './check.ts';
import { ComposeValueError, readComposeValue } from './compose-value.ts';
import { closed, directionFail, directionHash, directionJson, objects } from './direction.ts';
import { answersOf } from './provenance.ts';
import { plateRegistration, sceneBinding, sceneBytes, validateSceneAcceptance, validateSceneCurrent, SceneError } from './scene.ts';
import { matchesCitationSurface, resolveAnswerValue, validateAgentPlateRegistration } from './scene-authority.ts';
import type { JsonObject } from './templates.ts';

export const DIRECTION_COMPOSE_SPEC = 'rig-create/direction@3';
const positive = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) > 0;
export const composeRoot = (n: number): string => `outputs/v${n}/compose`;
export const composeScenePath = (n: number): string => `evidence/compose-src/v${n}/scene.json`;

export function validateComposeDirectionShape(doc: JsonObject, path = 'direction'): void {
  const bad = (why: string): never => directionFail('DIRECTION_COMPOSE_SCHEMA', path, why);
  if (!closed(doc, ['schema', 'rig', 'compose', 'model', 'take', 'citations']) || doc.schema !== DIRECTION_COMPOSE_SPEC) bad('expected closed direction@3');
  if (!closed(doc.rig, ['version', 'acceptance']) || !positive(doc.rig.version)) bad('rig requires version and acceptance');
  const a = (doc.rig as JsonObject).acceptance;
  if (!closed(a, ['signoff', 'verdict', 'review_package']) || !closed(a.signoff, ['stage', 'checkpoint', 'at'])
    || a.signoff.stage !== 'rig-review' || a.signoff.checkpoint !== null || typeof a.signoff.at !== 'string' || !Number.isFinite(Date.parse(a.signoff.at))
    || typeof a.verdict !== 'string' || !/^versions\[\d+\]\.verdicts\[\d+\]$/.test(a.verdict) || !sceneBinding(a.review_package)) bad('retain the exact scene@1 acceptance seal');
  if (!closed(doc.compose, ['scene', 'out', 'report', 'check', 'run']) || typeof doc.compose.out !== 'string'
    || !['scene', 'report', 'check', 'run'].every(key => sceneBinding((doc.compose as JsonObject)[key])) || !sceneBinding(doc.model)) bad('compose/model require literal paths and sha256 bindings');
  if (!closed(doc.take, ['duration', 'loop']) || typeof doc.take.duration !== 'number' || !Number.isFinite(doc.take.duration) || doc.take.duration <= 0 || typeof doc.take.loop !== 'boolean') bad('take requires positive finite duration and boolean loop');
  if (!closed(doc.citations, ['camera', 'timing', 'composition'])) bad('citations require camera, timing and composition');
  for (const [key, guide] of [['camera', 'camera_depth'], ['timing', 'post_timing'], ['composition', 'post_composition']]) {
    const c = (doc.citations as JsonObject)[key!];
    if (!(closed(c, ['guide', 'asks', 'quote']) && typeof c.quote === 'string' && c.quote.trim().length > 0
      || closed(c, ['guide', 'asks', 'delegated']) && c.delegated === true) || c.guide !== guide || !equal(c.asks, [guide])) bad(`${key}: cite the exact guide/ask with quote or delegated:true`);
  }
}

/** Parts #1348 has not supplied a field-level accepted-build comparison contract yet. */
export function composeRunMatchesAcceptedRig(): 'not yet applicable' { return 'not yet applicable'; }
export function readComposeRun(bytes: Buffer, path: string): JsonObject {
  const run = directionJson(bytes, path);
  if (run.spec !== 'rig-compose-run/1') directionFail('DIRECTION_COMPOSE_RUN', path, 'retain the producer rig-compose-run/1 record, not a core run.json');
  return run;
}

function bound(dir: string, binding: JsonObject, snapshots?: Map<string, Buffer>): Buffer {
  const bytes = sceneBytes(dir, String(binding.path), 'DIRECTION_COMPOSE_FILE', snapshots);
  if (directionHash(bytes) !== binding.sha256) directionFail('DIRECTION_COMPOSE_HASH', String(binding.path), 'restore the exact frozen compose bytes');
  return bytes;
}

/** Resolve one cited answer, preserving scene@1's Review choice/delegation authority. */
function citedValues(dir: string, project: JsonObject, doc: JsonObject, question: string, current: boolean, snapshots?: Map<string, Buffer>): JsonObject[] {
  const collection = loadCollection(dir);
  const item = collectItems(project, { collection }).find(i => i.id === question);
  const citation = (doc.citations as JsonObject)[question === 'post_composition' ? 'composition' : 'timing'] as JsonObject;
  if (!item) directionFail('DIRECTION_COMPOSE_CITATION', `direction.citations.${question}`, 'record the cited answer before direction write');
  const all = answersOf(item, { collection });
  const pool = current ? item.state.state === 'user' || item.state.state === 'delegated' ? [item.state.answer] : [] : all;
  const values: JsonObject[] = [];
  for (const answer of pool.filter(a => matchesCitationSurface(a, citation))) {
    if (question === 'post_composition') {
      const resolved = resolveAnswerValue(dir, item.path, answer, citation, snapshots);
      if (isObject(resolved.value)) values.push(resolved.value);
    } else {
      const value = citation.delegated === true && isObject(answer.agent_decision) ? answer.agent_decision.value : answer.value;
      if (isObject(value)) values.push(value);
    }
  }
  if (!values.length) directionFail('DIRECTION_COMPOSE_CITATION', `direction.citations.${question}`, 'cite a recorded resolved answer (the current answer for new authoring)');
  return values;
}

export function composeInventory(project: JsonObject, doc: JsonObject): JsonObject[] {
  const out = String((doc.compose as JsonObject).out);
  const match = /^outputs\/v([1-9][0-9]*)\/compose$/.exec(out);
  const version = match && objects(project.versions).find(v => v.n === Number(match[1]) && v.kind === 'post');
  const rows = objects(version ? version.outputs : undefined).filter(row => typeof row.path === 'string' && row.path.startsWith(`${out}/`));
  if (!version || !rows.length || rows.some(row => !sceneBinding(row)) || new Set(rows.map(row => row.path)).size !== rows.length) directionFail('DIRECTION_COMPOSE_INVENTORY', out, 'retain the post compose inventory in versions[].outputs');
  return rows;
}

export function validateComposeDirection(dir: string, project: JsonObject, doc: JsonObject, current = false, snapshots?: Map<string, Buffer>, pendingInventory?: JsonObject[]): void {
  try {
    validateComposeDirectionShape(doc);
    const rig = doc.rig as JsonObject;
    validateSceneAcceptance(project, rig);
    validateSceneCurrent(project, rig, current);
    const compose = doc.compose as JsonObject;
    const match = /^outputs\/v([1-9][0-9]*)\/compose$/.exec(String(compose.out));
    if (!match) directionFail('DIRECTION_COMPOSE_SCHEMA', 'direction.compose.out', 'use outputs/v<N>/compose for this post');
    const n = Number(match[1]); const out = composeRoot(n);
    const paths = { scene: composeScenePath(n), report: `${out}/scene.json`, check: `${out}/check/check.json`, run: `${out}/compose-run.json` };
    for (const [key, path] of Object.entries(paths)) if ((compose[key] as JsonObject).path !== path) directionFail('DIRECTION_COMPOSE_SCHEMA', `direction.compose.${key}`, 'use the immutable post compose path');
    if ((doc.model as JsonObject).path !== `${out}/check/build/skeleton.model.json`) directionFail('DIRECTION_COMPOSE_SCHEMA', 'direction.model.path', 'bind the frozen composed model');
    const rows = pendingInventory ?? composeInventory(project, doc);
    const disk: string[] = [];
    const walk = (path: string): void => {
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of readdirSync(join(dir, path)).sort()) walk(`${path}/${name}`);
      else if (stat.isFile() && !stat.isSymbolicLink()) disk.push(path);
      else directionFail('DIRECTION_COMPOSE_INVENTORY', path, 'frozen compose inventory requires regular files and real directories');
    };
    try { walk(out); } catch (e) {
      if (e instanceof Error && 'code' in e && String(e.code).startsWith('DIRECTION_')) throw e;
      directionFail('DIRECTION_COMPOSE_INVENTORY', out, 'restore the readable frozen compose tree');
    }
    if (!equal(disk.sort(), rows.map(row => String(row.path)).sort())) directionFail('DIRECTION_COMPOSE_INVENTORY', out, 'restore the exact frozen compose file inventory');
    for (const row of rows) bound(dir, row, snapshots);
    for (const binding of [compose.report, compose.check, compose.run, doc.model] as JsonObject[]) if (!rows.some(row => equal(row, binding))) directionFail('DIRECTION_COMPOSE_INVENTORY', String(binding.path), 'bind every compose output in the post inventory');
    const scene = directionJson(bound(dir, compose.scene as JsonObject, snapshots), String(paths.scene));
    const report = directionJson(bound(dir, compose.report as JsonObject, snapshots), paths.report);
    const check = directionJson(bound(dir, compose.check as JsonObject, snapshots), paths.check);
    readComposeRun(bound(dir, compose.run as JsonObject, snapshots), paths.run);
    const model = directionJson(bound(dir, doc.model as JsonObject, snapshots), String((doc.model as JsonObject).path));
    if (scene.spec !== 'spine-parts-scene/1' || report.spec !== 'spine-parts-scene-report/1') directionFail('DIRECTION_COMPOSE_SCHEMA', 'direction.compose', 'retain Parts scene input and scene-report/1 output');
    if (check.PASS !== true || check.gate_spine_html_green !== true) directionFail('DIRECTION_COMPOSE_GREEN', paths.check, 'compose must report PASS and gate_spine_html_green; rebuild with Parts');
    if (!Array.isArray(scene.characters) || scene.characters.length !== 1 || !isObject(scene.characters[0]) || !Array.isArray(scene.plates)) directionFail('DIRECTION_COMPOSE_SCHEMA', paths.scene, 'declare one accepted character and the cited named plates');
    if (scene.plate !== undefined) directionFail('DIRECTION_COMPOSE_SCHEMA', paths.scene, 'use only named plates declared by the cited compose value');
    const character = scene.characters[0] as JsonObject;
    const rc = objects(report.characters);
    if (rc.length !== 1 || rc[0]!.id !== character.id || rc[0]!.build !== character.build || !equal(rc[0]!.offset, character.offset) || (rc[0]!.scale ?? 1) !== (character.scale ?? 1)
      || !equal(report.canvas, scene.canvas) || !equal(rc[0]!.shift, [0, 0])) directionFail('DIRECTION_COMPOSE_PLACEMENT', paths.report, 'retain matching character placement and reported shift [0,0]; do not compare canvas to the rig stage');
    const plates = objects(scene.plates); const reported = objects(report.plates);
    if (plates.length !== scene.plates.length || reported.length !== plates.length) directionFail('DIRECTION_COMPOSE_PLACEMENT', paths.report, 'retain one producer report row per named plate');
    const registered: JsonObject[] = [];
    for (const [i, plate] of plates.entries()) {
      if (typeof plate.image !== 'string') directionFail('DIRECTION_COMPOSE_SCHEMA', paths.scene, 'plate image must name the registered project path');
      const bytes = sceneBytes(dir, plate.image, 'DIRECTION_COMPOSE_FILE', snapshots);
      const binding = { path: plate.image, sha256: directionHash(bytes) };
      const registration = plateRegistration(project, binding);
      if (!registration) directionFail('DIRECTION_COMPOSE_PLATE_UNREGISTERED', plate.image, 'register the plate with input add or a complete prepared-input receipt chain');
      registered.push({ ...binding, registered: registration });
      const rp = reported[i]!;
      if (rp.name !== plate.name || rp.image !== plate.image || !equal(rp.at, plate.at) || (rp.opaque_backdrop ?? false) !== (plate.opaque_backdrop ?? false) || rp.sha256 !== binding.sha256) directionFail('DIRECTION_COMPOSE_PLACEMENT', paths.report, 'plate report must bind the declared image bytes and placement');
    }
    validateAgentPlateRegistration(dir, project, registered, snapshots);
    const compositions = citedValues(dir, project, doc, 'post_composition', current, snapshots).map(v => readComposeValue(v.compose, 'direction.citations.composition.value.compose'));
    const idle = isObject(scene.animations) ? scene.animations.idle : undefined;
    const value = compositions.find(v => equal(v.canvas, scene.canvas) && equal(v.plates, plates.map(p => ({ name: p.name!, image: p.image!, at: p.at!, ...(p.opaque_backdrop === undefined ? {} : { opaque_backdrop: p.opaque_backdrop }) })))
      && equal(v.order, scene.order) && equal(v.character, { offset: character.offset!, ...(character.scale === undefined ? {} : { scale: character.scale }) }) && isObject(idle) && equal(v.idle_tracks, idle.tracks));
    if (!value) directionFail('DIRECTION_COMPOSE_CHOICE_MISMATCH', paths.scene, 'copy canvas, plates, order, character offset/scale and idle tracks from the cited compose value');
    const stage = { x: -value.canvas.width / 2, y: 0, width: value.canvas.width, height: value.canvas.height };
    if (!equal(model.stage, stage)) directionFail('DIRECTION_COMPOSE_PLACEMENT', 'direction.model', 'published model stage must equal the cited canvas (root at bottom centre)');
    const take = doc.take as JsonObject;
    const timing = citedValues(dir, project, doc, 'post_timing', current, snapshots);
    if (take.loop !== true || !timing.some(v => v.loop === true)) directionFail('DIRECTION_COMPOSE_LOOP', 'direction.take.loop', 'take.loop and the cited post_timing.value.loop must both be true; compose green proves closure');
    const animation = objects(model.animations).filter(a => a.name === 'idle');
    if (animation.length !== 1 || animation[0]!.duration !== take.duration || !isObject(idle) || idle.duration !== take.duration || value.end !== take.duration || !timing.some(v => v.seconds === take.duration && v.loop === true)) directionFail('DIRECTION_COMPOSE_DURATION', 'direction.take.duration', 'match the compiled idle duration, cited timing seconds and compose track end');
  } catch (e) {
    if (e instanceof SceneError || e instanceof ComposeValueError) directionFail(e.code, e.path, e.message);
    throw e;
  }
}
