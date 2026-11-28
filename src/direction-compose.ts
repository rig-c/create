/** Composed direction reads sealed producer output; it never repeats producer checks. */
import { isDeepStrictEqual as equal } from 'node:util';
import { lstatSync, readdirSync } from './check-reads.ts';
import { join, posix, relative } from 'node:path';
import { CAMERA_SCENE_BINDING_SINCE, cameraBindingFinding, cameraChoiceId, hasKeyedCamera } from './camera-choice.ts';
import { collectItems, isObject, loadCollection, type Finding } from './check.ts';
import { ComposeValueError, readComposeValue } from './compose-value.ts';
import { closed, directionFail, directionHash, directionJson, hex, objects } from './direction.ts';
import { answersOf } from './provenance.ts';
import { plateRegistration, sceneBinding, sceneBytes, validateSceneAcceptance, validateSceneCurrent, SceneError } from './scene.ts';
import { matchesCitationSurface, resolveAnswerValue, validateAgentPlateRegistration } from './scene-authority.ts';
import type { JsonObject } from './templates.ts';

export const DIRECTION_COMPOSE_SPEC = 'rig-create/direction@3';
export const COMPOSE_CAMERA_REPORT_SPEC = 'spine-parts-scene-report/2';
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export const composeRoot = (n: number): string => `outputs/v${n}/compose`;
export const composeScenePath = (n: number): string => `evidence/compose-src/v${n}/scene.json`;

export function validateComposeCameraModel(report: JsonObject, modelSha256: string, path: string): void {
  if (report.spec === COMPOSE_CAMERA_REPORT_SPEC
    && (!isObject(report.camera) || report.camera.model_sha256 !== modelSha256)) {
    directionFail('DIRECTION_COMPOSE_CAMERA_MODEL', `${path}.camera.model_sha256`, 'retain the Parts camera report and packed model from the same compose run');
  }
}

export function validateComposeDirectionShape(doc: JsonObject, path = 'direction'): void {
  const bad = (why: string): never => directionFail('DIRECTION_COMPOSE_SCHEMA', path, why);
  if (!closed(doc, ['schema', 'rig', 'compose', 'model', 'take', 'citations']) || doc.schema !== DIRECTION_COMPOSE_SPEC) bad('expected closed direction@3');
  if (!closed(doc.rig, ['version', 'acceptance']) || !positive(doc.rig.version)) bad('rig requires version and acceptance');
  const a = (doc.rig as JsonObject).acceptance;
  if (!closed(a, ['signoff', 'verdict', 'review_package']) || !closed(a.signoff, ['stage', 'checkpoint', 'at'])
    || a.signoff.stage !== 'rig-review' || a.signoff.checkpoint !== null || typeof a.signoff.at !== 'string' || !Number.isFinite(Date.parse(a.signoff.at))
    || typeof a.verdict !== 'string' || !/^versions\[\d+\]\.verdicts\[\d+\]$/.test(a.verdict) || !sceneBinding(a.review_package)) bad('retain the exact scene@1 acceptance seal');
  if (!closed(doc.compose, ['scene', 'out', 'report', 'check', 'run'], ['clipped_bounds']) || typeof doc.compose.out !== 'string'
    || !['scene', 'report', 'check', 'run'].every(key => sceneBinding((doc.compose as JsonObject)[key]))
    || ('clipped_bounds' in doc.compose && !composeBounds(doc.compose.clipped_bounds)) || !sceneBinding(doc.model)) bad('compose/model require literal paths, sha256 bindings and optional four-number clipped_bounds');
  if (!closed(doc.take, ['duration', 'loop']) || typeof doc.take.duration !== 'number' || !Number.isFinite(doc.take.duration) || doc.take.duration <= 0 || typeof doc.take.loop !== 'boolean') bad('take requires positive finite duration and boolean loop');
  validateComposeCitations(doc, bad);
}

export function validateComposeCitations(doc: JsonObject, bad: (why: string) => never): void {
  if (!closed(doc.citations, ['camera', 'timing', 'composition'])) bad('citations require camera, timing and composition');
  for (const [key, guide] of [['camera', 'camera_depth'], ['timing', 'post_timing'], ['composition', 'post_composition']]) {
    const c = (doc.citations as JsonObject)[key!];
    if (!(closed(c, ['guide', 'asks', 'quote']) && typeof c.quote === 'string' && c.quote.trim().length > 0
      || closed(c, ['guide', 'asks', 'delegated']) && c.delegated === true) || c.guide !== guide || !equal(c.asks, [guide])) bad(`${key}: cite the exact guide/ask with quote or delegated:true`);
  }
}

export type ComposeBounds = [number, number, number, number];
export interface ComposeRunPlacement {
  canvas_clip: true;
  bounds: ComposeBounds;
  clipped_bounds: ComposeBounds;
}
interface RunFile { path: string; sha256: string }
interface ComposeRun {
  spec: 'rig-compose-run/1';
  scene: RunFile;
  characters: { id: string; build: string; files: RunFile[]; placement?: ComposeRunPlacement }[];
  plate: RunFile | null;
  plates: { name: string; path: string; sha256: string }[];
}
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const relativePath = (v: unknown): v is string => text(v) && !v.startsWith('/') && !v.includes('\\') && !/^[A-Za-z]:/.test(v) && v.split('/').every(p => p !== '' && p !== '.' && p !== '..');
const runFile = (v: unknown): boolean => closed(v, ['path', 'sha256']) && text(v.path) && hex(v.sha256);
export const composeBounds = (v: unknown): v is ComposeBounds => Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n));
const runPlacement = (v: unknown): v is ComposeRunPlacement => isObject(v as JsonObject)
  && equal(Object.keys(v as JsonObject), ['canvas_clip', 'bounds', 'clipped_bounds'])
  && (v as JsonObject).canvas_clip === true && composeBounds((v as JsonObject).bounds) && composeBounds((v as JsonObject).clipped_bounds);
const mandatoryRigFiles = ['parts.json', 'rig/rig.json', 'rig/motion.json'];
const rigFile = (path: string): boolean => mandatoryRigFiles.includes(path) || path.startsWith('rig/images/');
export function readComposeRun(bytes: Buffer, path: string, scene?: JsonObject): ComposeRun {
  const bad = (): never => directionFail('DIRECTION_COMPOSE_RUN', path, 'retain the closed Parts rig-compose-run/1 record with scene, characters, plate and plates; compose again');
  let run: JsonObject;
  try { run = directionJson(bytes, path); } catch { return bad(); }
  if (!closed(run, ['spec', 'scene', 'characters', 'plate', 'plates']) || run.spec !== 'rig-compose-run/1'
    || !runFile(run.scene) || !(run.plate === null || runFile(run.plate)) || !Array.isArray(run.characters) || !Array.isArray(run.plates)) return bad();
  const characters = objects(run.characters); const plates = objects(run.plates);
  if (characters.length !== run.characters.length || characters.length === 0 || new Set(characters.map(c => c.id)).size !== characters.length
    || plates.length !== run.plates.length || new Set(plates.map(p => p.name)).size !== plates.length) return bad();
  const sceneCharacters = scene && Array.isArray(scene.characters) ? objects(scene.characters) : null;
  for (const c of characters) {
    if (!closed(c, ['id', 'build', 'files'], ['placement']) || !text(c.id) || !text(c.build) || !Array.isArray(c.files)
      || ('placement' in c && (!equal(Object.keys(c), ['id', 'build', 'files', 'placement']) || !runPlacement(c.placement)))) return bad();
    if (sceneCharacters) {
      const sc = sceneCharacters.find(row => row.id === c.id) ?? (characters.length === 1 && sceneCharacters.length === 1 ? sceneCharacters[0] : undefined);
      if (sc && (!('canvas_clip' in sc) || sc.canvas_clip === true) && (sc.canvas_clip === true) !== ('placement' in c)) return bad();
    }
    const files = objects(c.files);
    if (files.length !== c.files.length || new Set(files.map(f => f.path)).size !== files.length
      || files.some(f => !runFile(f) || !relativePath(f.path) || !(f.path === 'check/check.json' || rigFile(f.path)))
      || !files.some(f => f.path === 'check/check.json')) return bad();
  }
  if (plates.some(p => !closed(p, ['name', 'path', 'sha256']) || !text(p.name) || !text(p.path) || !hex(p.sha256))) return bad();
  return run as unknown as ComposeRun;
}

/** Compare a list of character bindings; the @3 authoring contract currently supplies one. */
export function composeRunMatchesAcceptedRig(dir: string, run: ComposeRun, characters: readonly { id: string; build: string; rig: JsonObject }[], path: string, snapshots?: Map<string, Buffer>): void {
  const bad = (where: string): never => directionFail('DIRECTION_COMPOSE_RUN_RIG', where, 'compose must bind the mandatory rig files and every consumed image to matching accepted frozen outputs and sealed package hashes; restore that build and compose again');
  if (run.characters.length !== characters.length || new Set(characters.map(c => c.id)).size !== characters.length) bad(`${path}.characters`);
  for (const c of characters) {
    const consumed = run.characters.find(row => row.id === c.id);
    if (!consumed || consumed.build !== c.build) return bad(`${path}.characters[${c.id}]`);
    const pkg = c.rig.review_package;
    const where = `versions[v${String(c.rig.n)}].review_package`;
    if (!isObject(pkg) || !relativePath(pkg.from) || !Array.isArray(pkg.files) || !Array.isArray(c.rig.outputs)) return bad(where);
    const root = `${pkg.from}/`;
    const recorded = objects(c.rig.outputs).filter(row => typeof row.path === 'string' && row.path.startsWith(root) && rigFile(row.path.slice(root.length)));
    const expected = recorded.map(row => ({ path: String(row.path).slice(root.length), sha256: row.sha256 }));
    const sealed = objects(pkg.files).filter(row => typeof row.path === 'string' && row.path.startsWith('out/') && rigFile(row.path.slice(4)))
      .map(row => ({ path: String(row.path).slice(4), sha256: row.sha256 }));
    const actual = consumed.files.filter(row => rigFile(row.path));
    const sorted = <T extends { path: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    // Parts records only distinct default-skin images it consumed, not directory extras.
    if (!mandatoryRigFiles.every(name => expected.some(row => row.path === name))
      || new Set(expected.map(row => row.path)).size !== expected.length || expected.some(row => !relativePath(row.path) || !hex(row.sha256))
      || !equal(sorted(expected), sorted(sealed))
      || !equal(sorted(expected.filter(row => mandatoryRigFiles.includes(row.path))), sorted(actual.filter(row => mandatoryRigFiles.includes(row.path))))
      || actual.some(row => !expected.some(file => file.path === row.path && file.sha256 === row.sha256))) return bad(where);
    for (const row of recorded) {
      const bytes = sceneBytes(dir, String(row.path), 'DIRECTION_COMPOSE_RUN_RIG', snapshots);
      if (directionHash(bytes) !== row.sha256) bad(String(row.path));
    }
  }
}

export function validateComposeRunInputs(run: ComposeRun, scene: JsonObject, sceneSha256: string, registered: JsonObject[], path: string): void {
  if (run.scene.sha256 !== sceneSha256) directionFail('DIRECTION_COMPOSE_RUN_SCENE', `${path}.scene`, 'compose again from the exact retained scene bytes');
  const expected = objects(scene.plates).map(p => ({ name: p.name, path: p.image, sha256: registered.find(row => row.path === p.image)?.sha256 }));
  const sorted = <T extends { name: unknown }>(rows: T[]): T[] => [...rows].sort((a, b) => String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
  if (!equal(sorted(run.plates), sorted(expected)) || run.plate !== null && !registered.some(row => row.path === run.plate!.path && row.sha256 === run.plate!.sha256)) {
    directionFail('DIRECTION_COMPOSE_RUN_PLATE', `${path}.plates`, 'every consumed named or legacy plate must bind the registered plate path and sha256; compose again');
  }
}

function bound(dir: string, binding: JsonObject, snapshots?: Map<string, Buffer>): Buffer {
  const bytes = sceneBytes(dir, String(binding.path), 'DIRECTION_COMPOSE_FILE', snapshots);
  if (directionHash(bytes) !== binding.sha256) directionFail('DIRECTION_COMPOSE_HASH', String(binding.path), 'restore the exact frozen compose bytes');
  return bytes;
}

/** Resolve one cited answer, preserving scene@1's Review choice/delegation authority. */
export function citedAnswerValues(dir: string, project: JsonObject, doc: JsonObject, question: string, current: boolean, snapshots?: Map<string, Buffer>, at = Infinity) {
  const collection = loadCollection(dir);
  const item = collectItems(project, { collection }).find(i => i.id === question);
  const citation = (doc.citations as JsonObject)[question === 'post_composition' ? 'composition' : 'timing'] as JsonObject;
  if (!item) directionFail('DIRECTION_COMPOSE_CITATION', `direction.citations.${question}`, 'record the cited answer before direction write');
  const all = answersOf(item, { collection });
  const pool = current ? item.state.state === 'user' || item.state.state === 'delegated' ? [item.state.answer] : [] : all;
  const values: { value: JsonObject; answer: JsonObject }[] = [];
  for (const answer of pool.filter(a => matchesCitationSurface(a, citation))) {
    if (Date.parse(String(answer.at)) > at) continue;
    if (question === 'post_composition') {
      const resolved = resolveAnswerValue(dir, item.path, answer, citation, snapshots);
      if (isObject(resolved.value)) values.push({ value: resolved.value, answer });
    } else {
      const value = citation.delegated === true && isObject(answer.agent_decision) ? answer.agent_decision.value : answer.value;
      if (isObject(value)) values.push({ value, answer });
    }
  }
  if (!values.length) directionFail('DIRECTION_COMPOSE_CITATION', `direction.citations.${question}`, 'cite a recorded resolved answer (the current answer for new authoring)');
  return values;
}

export function citedValues(dir: string, project: JsonObject, doc: JsonObject, question: string, current: boolean, snapshots?: Map<string, Buffer>): JsonObject[] {
  return citedAnswerValues(dir, project, doc, question, current, snapshots).map(({ value }) => value);
}

export function composeInventory(project: JsonObject, doc: JsonObject): JsonObject[] {
  const out = String((doc.compose as JsonObject).out);
  const match = /^outputs\/v([1-9][0-9]*)\/compose$/.exec(out);
  const version = match && objects(project.versions).find(v => v.n === Number(match[1]) && v.kind === 'post');
  const rows = objects(version ? version.outputs : undefined).filter(row => typeof row.path === 'string' && row.path.startsWith(`${out}/`));
  if (!version || !rows.length || rows.some(row => !sceneBinding(row)) || new Set(rows.map(row => row.path)).size !== rows.length) directionFail('DIRECTION_COMPOSE_INVENTORY', out, 'retain the post compose inventory in versions[].outputs');
  return rows;
}

export function validateComposeDirection(dir: string, project: JsonObject, doc: JsonObject, {
  current = false, currentCitations = current, snapshots, pendingInventory, warnings,
}: { current?: boolean; currentCitations?: boolean; snapshots?: Map<string, Buffer>; pendingInventory?: JsonObject[]; warnings?: Finding[] } = {}): void {
  try {
    validateComposeDirectionShape(doc);
    const rig = doc.rig as JsonObject;
    const acceptedRig = validateSceneAcceptance(project, rig);
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
    const model = directionJson(bound(dir, doc.model as JsonObject, snapshots), String((doc.model as JsonObject).path));
    if (scene.spec !== 'spine-parts-scene/1' || (report.spec !== 'spine-parts-scene-report/1' && report.spec !== COMPOSE_CAMERA_REPORT_SPEC)) {
      directionFail('DIRECTION_COMPOSE_SCHEMA', 'direction.compose', 'retain Parts scene input and scene-report/1 or scene-report/2 output');
    }
    validateComposeCameraModel(report, String((doc.model as JsonObject).sha256), paths.report);
    if (check.PASS !== true || check.gate_spine_html_green !== true) directionFail('DIRECTION_COMPOSE_GREEN', paths.check, 'compose must report PASS and gate_spine_html_green; rebuild with Parts');
    if (!Array.isArray(scene.characters) || scene.characters.length !== 1 || !isObject(scene.characters[0]) || !Array.isArray(scene.plates)) directionFail('DIRECTION_COMPOSE_SCHEMA', paths.scene, 'declare one accepted character and the cited named plates');
    if (scene.plate !== undefined) directionFail('DIRECTION_COMPOSE_SCHEMA', paths.scene, 'use only named plates declared by the cited compose value');
    const character = scene.characters[0] as JsonObject;
    if ('canvas_clip' in character && character.canvas_clip !== true) {
      directionFail('DIRECTION_COMPOSE_SCHEMA', `${paths.scene}.characters[0].canvas_clip`, 'canvas_clip must be true when present');
    }
    const run = readComposeRun(bound(dir, compose.run as JsonObject, snapshots), paths.run, scene);
    const version = objects(project.versions).find(row => row.n === n && row.kind === 'post');
    const at = version ? Date.parse(String(version.at)) : Infinity;
    const historical = at < Date.parse(CAMERA_SCENE_BINDING_SINCE);
    const rc = objects(report.characters);
    const placed = rc[0];
    const expectedClipped = run.characters[0]!.placement?.clipped_bounds;
    if (rc.length !== 1 || !placed || placed.id !== character.id || placed.build !== character.build
      || !equal(report.canvas, scene.canvas)
      || ((placed.canvas_clip !== undefined || placed.clipped_bounds !== undefined)
        && (character.canvas_clip !== true || placed.canvas_clip !== true || !equal(placed.clipped_bounds, expectedClipped)
          || (placed.bounds !== undefined && !equal(placed.bounds, run.characters[0]!.placement?.bounds))))
      || !equal(compose.clipped_bounds, expectedClipped)) directionFail('DIRECTION_COMPOSE_PLACEMENT', paths.report, 'retain matching character placement and compose-run bounds');
    const plates = objects(scene.plates); const reported = objects(report.plates);
    if (plates.length !== scene.plates.length || reported.length !== plates.length) directionFail('DIRECTION_COMPOSE_PLACEMENT', paths.report, 'retain one producer report row per named plate');
    const sourcePath = posix.isAbsolute(run.scene.path) ? relative(dir, run.scene.path) : posix.normalize(run.scene.path);
    // Historic runs treated plate paths as project-relative. Only use an original scene
    // directory when the producer report corroborates the run's scene path.
    const paired = relativePath(sourcePath) && typeof report.scene === 'string'
      && (report.scene === run.scene.path || posix.isAbsolute(report.scene) && report.scene.endsWith(`/${sourcePath}`));
    const registered: JsonObject[] = [];
    const producerPlates: JsonObject[] = [];
    for (const [i, plate] of plates.entries()) {
      if (typeof plate.image !== 'string' || posix.isAbsolute(plate.image)) directionFail('DIRECTION_COMPOSE_SCHEMA', paths.scene, 'name each plate image relative to the Parts scene');
      const rp = reported[i]!;
      const oldPath = { path: plate.image, sha256: rp.sha256 };
      const keepHistorical = historical && sceneBinding(oldPath) && plateRegistration(project, oldPath);
      const path = paired && !keepHistorical ? posix.normalize(posix.join(posix.dirname(sourcePath), plate.image)) : plate.image;
      const bytes = sceneBytes(dir, path, 'DIRECTION_COMPOSE_FILE', snapshots);
      const binding = { path, sha256: directionHash(bytes) };
      const registration = plateRegistration(project, binding);
      if (!registration) directionFail('DIRECTION_COMPOSE_PLATE_UNREGISTERED', path, 'register the plate with input add or a complete prepared-input receipt chain');
      registered.push({ ...binding, registered: registration });
      producerPlates.push({ ...binding, path: plate.image });
      if (rp.name !== plate.name || rp.image !== plate.image || !equal(rp.at, plate.at) || (rp.opaque_backdrop ?? false) !== (plate.opaque_backdrop ?? false) || rp.sha256 !== binding.sha256) directionFail('DIRECTION_COMPOSE_PLACEMENT', paths.report, 'plate report must bind the declared image bytes and placement');
    }
    validateAgentPlateRegistration(dir, project, registered, snapshots);
    const compositionAnswers = citedAnswerValues(dir, project, doc, 'post_composition', currentCitations, snapshots);
    // The same words can also match an older scene-only choice.
    const composeAnswers = compositionAnswers.filter(({ value }) => value.compose !== undefined);
    const compositions = (composeAnswers.length ? composeAnswers : compositionAnswers)
      .map(({ value, answer }) => ({ answer, compose: readComposeValue(value.compose, 'direction.citations.composition.value.compose') }));
    const take = doc.take as JsonObject;
    const idle = isObject(scene.animations) ? scene.animations.idle : undefined;
    if (!isObject(idle)) {
      directionFail('DIRECTION_COMPOSE_CHOICE_MISMATCH', `${paths.scene}.animations.idle`,
        `declare the scene idle with the take duration and cited idle tracks, then compose again. For an empty-track take, write "animations": {"idle": {"duration": ${take.duration}, "tracks": []}}`);
    }
    const matching = compositions.filter(({ compose: v }) => equal(v.canvas, scene.canvas) && equal(v.plates, plates.map((p, i) => ({ name: p.name!, image: registered[i]!.path!, at: p.at!, ...(p.opaque_backdrop === undefined ? {} : { opaque_backdrop: p.opaque_backdrop }) })))
      && equal(v.order, scene.order) && equal(v.idle_tracks, idle.tracks));
    const exact = matching.filter(({ compose: v }) => equal(v.character, { offset: character.offset!, ...(character.scale === undefined ? {} : { scale: character.scale }) }));
    const value = exact[0]?.compose;
    // A unique citation with the rest of the scene intact still identifies the intended shift.
    const cited = value ?? (matching.length === 1 ? matching[0]?.compose : undefined);
    const reportCharacterPath = `${paths.report}.characters[0]`;
    if (cited) {
      const size = placed.rig_size;
      if (!Array.isArray(size) || size.length !== 2 || !positive(size[0]) || !positive(size[1])) {
        directionFail('DIRECTION_COMPOSE_PLACEMENT', `${reportCharacterPath}.rig_size`, 'retain the Parts report with the positive integer rig width and height');
      }
      const [ox, oy] = cited.character.offset;
      const scale = cited.character.scale ?? 1;
      const { width, height } = cited.canvas;
      // Use the producer's rootShift operation order so fractional scales compare exactly.
      const expectedShift = [-width / 2 + ox + scale * (size[0] / 2), height - oy - scale * size[1]];
      if (!equal(placed.shift, expectedShift)) {
        directionFail('DIRECTION_COMPOSE_PLACEMENT', `${reportCharacterPath}.shift`, `expected shift ${JSON.stringify(expectedShift)} from the cited placement, reported ${JSON.stringify(placed.shift) ?? 'missing'}; compose again from the cited scene`);
      }
    }
    if (!value) directionFail('DIRECTION_COMPOSE_CHOICE_MISMATCH', paths.scene, 'copy canvas, plates, order, character offset/scale and idle tracks from the cited compose value');
    if (!equal(placed.offset, value.character.offset) || (placed.scale ?? 1) !== (value.character.scale ?? 1)) {
      directionFail('DIRECTION_COMPOSE_PLACEMENT', reportCharacterPath, 'retain the Parts report with the cited character offset and scale');
    }
    const stage = { x: -value.canvas.width / 2, y: 0, width: value.canvas.width, height: value.canvas.height };
    if (!equal(model.stage, stage)) directionFail('DIRECTION_COMPOSE_PLACEMENT', 'direction.model', 'published model stage must equal the cited canvas (root at bottom centre)');
    const timing = citedValues(dir, project, doc, 'post_timing', currentCitations, snapshots);
    if (take.loop !== true || !timing.some(v => v.loop === true)) directionFail('DIRECTION_COMPOSE_LOOP', 'direction.take.loop', 'take.loop and the cited post_timing.value.loop must both be true; compose green proves closure');
    const animation = objects(model.animations).filter(a => a.name === 'idle');
    if (animation.length !== 1 || animation[0]!.duration !== take.duration || idle.duration !== take.duration
      || (value.idle_tracks.length > 0 && value.end !== take.duration) || !timing.some(v => v.seconds === take.duration && v.loop === true)) {
      directionFail('DIRECTION_COMPOSE_DURATION', 'direction.take.duration', 'match the scene idle duration, compiled idle duration, cited timing seconds and, when tracks are present, the compose track end');
    }
    composeRunMatchesAcceptedRig(dir, run, [{ id: String(character.id), build: String(character.build), rig: acceptedRig }], paths.run, snapshots);
    validateComposeRunInputs(run, scene, String((compose.scene as JsonObject).sha256), producerPlates, paths.run);
    if (hasKeyedCamera(scene)) {
      const source = { path: sourcePath, sha256: run.scene.sha256 };
      const findings = exact.map(({ answer, compose: chosen }) => cameraBindingFinding(source, cameraChoiceId(answer), chosen.camera_scene));
      const first = findings[0];
      if (first && findings.every(Boolean)) {
        if (!historical) throw first;
        warnings?.push({ code: first.code, path: first.path, message: first.message });
      }
    }
  } catch (e) {
    if (e instanceof SceneError || e instanceof ComposeValueError) directionFail(e.code, e.path, e.message);
    throw e;
  }
}
