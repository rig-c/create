/** Create-owned composition declarations. Producer measurements are only read. */
import { readFileSync } from './check-reads.ts';
import { isDeepStrictEqual as equal } from 'node:util';
import { asArray, collectItems, collectSignoffs, isObject, loadCollection, type Ctx, type Finding } from './check.ts';
import { literalFile } from './choices.ts';
import { closed, directionHash, hex, objects } from './direction.ts';
import { answersOf, checkEntry } from './provenance.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { humanReviewVerdicts, latestAccepted, readVersions } from './review.ts';
import { SCENE_CHOICE_MISMATCH, SCENE_CHOICE_MISSING, sceneAuthor, validateAgentSceneAuthority } from './scene-authority.ts';
import { reviewPackageHash } from './signoff-target.ts';
import type { Json, JsonObject } from './templates.ts';

export { SCENE_CHOICE_MISMATCH, SCENE_CHOICE_MISSING, sceneAuthor };
export const SCENE_SPEC = 'rig-create/scene@1';
export const scenePath = (n: number): string => `evidence/scene/s${n}.json`;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const pathShape = (value: unknown): value is string => text(value) && !value.startsWith('/') && !value.includes('\\') && !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
export const sceneBinding = (value: unknown): value is JsonObject => closed(value, ['path', 'sha256']) && pathShape(value.path) && hex(value.sha256);
export class SceneError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    why: string,
    remedy = 'restore the retained sources and record a new scene with scene write',
  ) {
    super(`${path}: ${why}; ${remedy}`);
  }
}
export function sceneFail(code: string, path: string, why: string, remedy?: string): never { throw new SceneError(code, path, why, remedy); }
export function sceneFinding(error: SceneError): Finding { return { code: error.code, path: error.path, message: error.message }; }

/** Every read is relative to this one project root, including optional source snapshots for writers. */
export function sceneBytes(dir: string, path: string, code: string, snapshots?: Map<string, Buffer>): Buffer {
  try {
    if (!pathShape(path)) throw Error('a literal project-relative path is required');
    const bytes = readFileSync(literalFile(dir, path));
    const previous = snapshots?.get(path);
    if (previous && !previous.equals(bytes)) throw Error('source changed during validation');
    snapshots?.set(path, bytes);
    return bytes;
  } catch (error) { return sceneFail(code, path, error instanceof Error ? error.message : String(error)); }
}
function boundBytes(dir: string, binding: JsonObject, code: string, snapshots?: Map<string, Buffer>): Buffer {
  const bytes = sceneBytes(dir, String(binding.path), code, snapshots);
  if (directionHash(bytes) !== binding.sha256) sceneFail(code, String(binding.path), 'raw bytes differ from the recorded sha256');
  return bytes;
}
function json(bytes: Buffer, path: string): JsonObject {
  try { const value: Json = JSON.parse(bytes.toString('utf8')); if (isObject(value)) return value; } catch { /* Report the scene code below. */ }
  return sceneFail('SCENE_MALFORMED', path, 'expected a JSON object');
}
export function sceneEntries(project: JsonObject): JsonObject[] {
  if (project.scenes === undefined) return [];
  if (!Array.isArray(project.scenes)) sceneFail('SCENE_MALFORMED', 'scenes', 'expected an append-only array');
  for (const [index, entry] of project.scenes.entries()) {
    if (!closed(entry, ['n', 'path', 'sha256', 'at', 'by']) || entry.n !== index + 1 || !positive(entry.n)
      || entry.path !== scenePath(entry.n) || !hex(entry.sha256) || !text(entry.at) || !/Z$/.test(entry.at) || !Number.isFinite(Date.parse(entry.at)) || !sceneAuthor(entry.by)) {
      sceneFail('SCENE_MALFORMED', `scenes[${index}]`, 'expected consecutive n, immutable scene path, sha256, UTC at and by ("agent" or a human identifier)');
    }
  }
  return project.scenes as JsonObject[];
}
export function currentScene(project: JsonObject, at = Infinity): JsonObject | undefined {
  return sceneEntries(project).filter(entry => Date.parse(String(entry.at)) <= at).at(-1);
}
export function sceneReference(entry: JsonObject): JsonObject { return { n: entry.n!, path: entry.path!, sha256: entry.sha256! }; }

function boxShape(value: unknown): value is JsonObject {
  return closed(value, ['x', 'y', 'width', 'height']) && Object.values(value).every(v => typeof v === 'number');
}
export function validateSceneShape(doc: JsonObject, path = 'scene'): void {
  const bad = (why: string): never => sceneFail('SCENE_MALFORMED', path, why);
  if (!closed(doc, ['schema', 'n', 'rig', 'frame', 'plates', 'layers']) || doc.schema !== SCENE_SPEC || !positive(doc.n)) bad('expected closed scene@1 and positive n');
  const rig = doc.rig;
  if (!closed(rig, ['version', 'acceptance', 'model', 'animation']) || !positive(rig.version) || !sceneBinding(rig.model)
    || !closed(rig.animation, ['name'], ['frames']) || !text(rig.animation.name) || rig.animation.frames !== undefined && !sceneBinding(rig.animation.frames)) bad('rig needs version, model, animation name and optional frames binding');
  const acceptance = (rig as JsonObject).acceptance;
  if (!closed(acceptance, ['signoff', 'verdict', 'review_package']) || !closed(acceptance.signoff, ['stage', 'checkpoint', 'at'])
    || acceptance.signoff.stage !== 'rig-review' || acceptance.signoff.checkpoint !== null || !text(acceptance.signoff.at) || !Number.isFinite(Date.parse(acceptance.signoff.at))
    || !text(acceptance.verdict) || !/^versions\[\d+\]\.verdicts\[\d+\]$/.test(acceptance.verdict)
    || !closed(acceptance.review_package, ['path', 'sha256']) || !text(acceptance.review_package.path) || !hex(acceptance.review_package.sha256)) bad('acceptance needs the exact rig-review signoff identity, verdict and review-package target');
  if (!closed(doc.frame, ['space', 'stage']) || doc.frame.space !== 'rig-world-y-up' || !boxShape(doc.frame.stage)) bad('frame needs rig-world-y-up and a stage box');
  if (!Array.isArray(doc.plates) || !Array.isArray(doc.layers) || doc.layers.some(layer => typeof layer !== 'string')) bad('plates and layers must be arrays');
  for (const [index, plate] of (doc.plates as Json[]).entries()) {
    if (!closed(plate, ['role', 'path', 'sha256', 'width', 'height', 'rect', 'registered'], ['citation'])
      || !['background', 'foreground'].includes(String(plate.role)) || !pathShape(plate.path) || !hex(plate.sha256)
      || !positive(plate.width) || !positive(plate.height) || !boxShape(plate.rect)
      || !closed(plate.registered, ['kind', 'ref']) || !['input', 'derived'].includes(String(plate.registered.kind)) || !text(plate.registered.ref)) bad(`plates[${index}] has unknown keys or invalid fields`);
    const citation = (plate as JsonObject).citation;
    if (citation !== undefined) {
      if (!isObject(citation) || Object.keys(citation).some(key => !['guide', 'asks', 'quote', 'delegated'].includes(key))
        || citation.guide !== undefined && typeof citation.guide !== 'string' || citation.asks !== undefined && (!Array.isArray(citation.asks) || citation.asks.some(ask => typeof ask !== 'string'))
        || citation.quote !== undefined && typeof citation.quote !== 'string' || citation.delegated !== undefined && typeof citation.delegated !== 'boolean') bad(`plates[${index}].citation has unknown keys or wrong type`);
    }
  }
}

/** Prepared-input receipts may fan in. Every branch terminates at a registered input. */
function sameFile(entry: JsonObject, binding: JsonObject): boolean { return entry.path === binding.path && entry.sha256 === binding.sha256; }
function receiptChain(project: JsonObject, entry: JsonObject, visiting: Set<JsonObject>): boolean {
  if (entry.kind !== 'prepared-input' || !pathShape(entry.path) || !hex(entry.sha256) || visiting.has(entry)) return false;
  const sources = entry.sources === undefined ? [entry.source] : asArray(entry.sources);
  const next = new Set([...visiting, entry]);
  return sources.length > 0 && sources.every(source => sceneBinding(source) && (objects(project.inputs).some(input => sameFile(input, source))
    || objects(project.derived).some(parent => sameFile(parent, source) && receiptChain(project, parent, next))));
}
export function plateRegistration(project: JsonObject, binding: JsonObject): JsonObject | null {
  const input = asArray(project.inputs).findIndex(entry => isObject(entry) && sameFile(entry, binding));
  if (input >= 0) return { kind: 'input', ref: `inputs[${input}]` };
  const derived = asArray(project.derived).findIndex(entry => isObject(entry) && sameFile(entry, binding) && receiptChain(project, entry, new Set()));
  return derived < 0 ? null : { kind: 'derived', ref: `derived[${derived}]` };
}
function registeredPlate(project: JsonObject, plate: JsonObject): boolean {
  const registration = plate.registered as JsonObject;
  const match = /^(inputs|derived)\[(\d+)\]$/.exec(String(registration.ref));
  if (!match || match[1] !== (registration.kind === 'input' ? 'inputs' : 'derived')) return false;
  const entry = asArray(project[match[1]!])[Number(match[2])];
  return isObject(entry) && sameFile(entry, plate) && (registration.kind === 'input' || receiptChain(project, entry, new Set()));
}
/** One gate for the three authoring-time staleness rules, per the signed HQ ruling. */
export function validateSceneCurrent(project: JsonObject, rig: JsonObject, current: boolean, reference?: JsonObject): void {
  if (!current) return;
  const versions = readVersions(project);
  const accepted = latestAccepted(versions);
  if (accepted?.n !== rig.version || versions.rigs.some(value => value.live && value.n > Number(rig.version))) sceneFail('SCENE_RIG_STALE', 'scene.rig.version', 'select the latest live accepted rig');
  const reopens = collectReopens(project, []);
  const acceptance = rig.acceptance as JsonObject;
  const signatures = collectSignoffs(project, []).filter(value => value.stage === 'rig-review' && value.checkpoint === null && liveSignoff(reopens, value.stage, value.at)
    && isObject(value.record.target) && value.record.target.version === rig.version).sort((a, b) => b.at - a.at);
  const signature = signatures[0];
  if (!signature || !equal(acceptance.signoff, { stage: 'rig-review', checkpoint: null, at: signature.record.at! })
    || !isObject(signature.record.target) || signature.record.target.verdict !== acceptance.verdict || !equal(signature.record.target.review_package, acceptance.review_package)) sceneFail('SCENE_ACCEPTANCE_STALE', 'scene.rig.acceptance', 'retain the current live rig-review signoff target');
  if (reference) {
    const latest = currentScene(project);
    if (!latest || !equal(sceneReference(latest), reference)) sceneFail('DIRECTION_SCENE_STALE', 'direction.scene', 'new direction must cite the current scene');
  }
}
/** The records validateSceneCurrent would have read at `at`: every dated entry at or before it. */
function recordsAt(project: JsonObject, at: number): JsonObject {
  const dated = (value: Json | undefined): JsonObject[] => asArray(value).filter((entry): entry is JsonObject => isObject(entry) && Date.parse(String(entry.at)) <= at);
  const view: JsonObject = { ...project, signoffs: dated(project.signoffs), versions: dated(project.versions).map(version => ({ ...version, verdicts: dated(version.verdicts) })) };
  if (project.reopens !== undefined) view.reopens = dated(project.reopens);
  if (project.amendments !== undefined) view.amendments = dated(project.amendments);
  return view;
}
/** The last scene dated at or before `at`, while it passes validateSceneCurrent on the records of that instant. */
export function sceneCurrentAt(dir: string, project: JsonObject, at: number): JsonObject | undefined {
  const entry = currentScene(project, at);
  if (!entry) return undefined;
  const doc = json(boundBytes(dir, entry, 'SCENE_FILE_CHANGED'), String(entry.path));
  if (doc.n !== entry.n) sceneFail('SCENE_MALFORMED', String(entry.path), 'document n differs from its committed entry');
  validateSceneShape(doc, String(entry.path));
  if (entry.by === 'agent') validateScene(dir, recordsAt(project, at), doc, undefined, false, 'agent');
  try { validateSceneCurrent(recordsAt(project, at), doc.rig as JsonObject, true); }
  catch (error) {
    if (error instanceof SceneError && ['SCENE_RIG_STALE', 'SCENE_ACCEPTANCE_STALE'].includes(error.code)) return undefined;
    throw error;
  }
  return entry;
}
function rigVersion(project: JsonObject, n: number): { version: JsonObject; index: number } {
  const matches = asArray(project.versions).map((version, index) => ({ version, index })).filter(value => isObject(value.version) && value.version.kind === 'rig' && value.version.n === n);
  if (matches.length !== 1) sceneFail('SCENE_RIG_STALE', 'scene.rig.version', 'select a uniquely recorded rig version');
  return matches[0] as { version: JsonObject; index: number };
}
function modelForRig(dir: string, version: JsonObject, snapshots?: Map<string, Buffer>): { binding: JsonObject; model: JsonObject } {
  const path = `derived/review/v${String(version.n)}/out/check/build/skeleton.model.json`;
  const pkg = version.review_package;
  const row = isObject(pkg) ? objects(pkg.files).find(file => file.path === 'out/check/build/skeleton.model.json') : undefined;
  if (!row || !hex(row.sha256)) sceneFail('SCENE_MODEL_MISMATCH', path, 'retain the compiled model in the accepted review-package inventory');
  const binding = { path, sha256: row.sha256 };
  return { binding, model: json(boundBytes(dir, binding, 'SCENE_MODEL_MISMATCH', snapshots), path) };
}
export function sceneRig(dir: string, project: JsonObject, n: number, snapshots?: Map<string, Buffer>): { rig: JsonObject; stage: JsonObject } {
  const { version } = rigVersion(project, n);
  const reopens = collectReopens(project, []);
  const signature = collectSignoffs(project, []).filter(value => value.stage === 'rig-review' && value.checkpoint === null && liveSignoff(reopens, value.stage, value.at)
    && isObject(value.record.target) && value.record.target.version === n).sort((a, b) => b.at - a.at)[0];
  if (!signature || !isObject(signature.record.target)) sceneFail('SCENE_ACCEPTANCE_STALE', 'scene.rig.acceptance', 'sign the accepted rig before scene write');
  const target = signature.record.target;
  const { binding, model } = modelForRig(dir, version, snapshots);
  const registration = isObject(version.registration) ? version.registration : {};
  const rig: JsonObject = { version: n, acceptance: { signoff: { stage: 'rig-review', checkpoint: null, at: signature.record.at! }, verdict: target.verdict!, review_package: target.review_package! },
    model: binding, animation: { name: 'idle', ...(registration.idle === undefined ? {} : { frames: registration.idle }) } };
  validateSceneCurrent(project, rig, true);
  if (model.stage === null || model.stage === undefined) sceneFail('SCENE_STAGE_MISSING', String(binding.path), 'compile a model with a stage box');
  return { rig, stage: model.stage as JsonObject };
}
/** Historical acceptance and its package seal are checked even after a reopen or later verdict. */
function validateSceneAcceptance(project: JsonObject, rig: JsonObject): JsonObject {
  const { version, index } = rigVersion(project, Number(rig.version));
  const acceptance = rig.acceptance as JsonObject;
  const identity = acceptance.signoff as JsonObject;
  const signature = collectSignoffs(project, []).find(value => value.stage === identity.stage && value.checkpoint === identity.checkpoint && value.record.at === identity.at)?.record;
  const match = /^versions\[(\d+)\]\.verdicts\[(\d+)\]$/.exec(String(acceptance.verdict));
  const verdict = match && Number(match[1]) === index ? humanReviewVerdicts(version.verdicts, 'rig-review').find(value => value.index === Number(match[2]) && value.record.verdict === 'accepted') : undefined;
  if (!verdict || !Number.isFinite(Date.parse(String(verdict.record.at))) || Date.parse(String(verdict.record.at)) > Date.parse(String(identity.at))) sceneFail('SCENE_RIG_STALE', 'scene.rig.acceptance.verdict', 'the cited rig must have been human-accepted before this signoff');
  const pkg = version.review_package;
  const target = { version: version.n!, verdict: acceptance.verdict!, review_package: { path: `versions[${index}].review_package`, sha256: isObject(pkg) ? reviewPackageHash(pkg) : '' } };
  if (!signature || !equal(signature.target, target) || !equal(acceptance.review_package, target.review_package)) sceneFail('SCENE_ACCEPTANCE_STALE', 'scene.rig.acceptance.review_package', 'restore the recorded acceptance target and its matching package sha256');
  return version;
}
export function pngDimensions(bytes: Buffer, path: string): { width: number; height: number } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) sceneFail('SCENE_PLATE_DIMENSIONS', path, 'retain a PNG with a valid IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
export function validateScene(dir: string, project: JsonObject, doc: JsonObject, snapshots?: Map<string, Buffer>, current = false, by?: string): void {
  validateSceneShape(doc);
  const rig = doc.rig as JsonObject;
  const version = validateSceneAcceptance(project, rig);
  validateSceneCurrent(project, rig, current);
  const { binding, model } = modelForRig(dir, version, snapshots);
  if (!equal(rig.model, binding)) sceneFail('SCENE_MODEL_MISMATCH', 'scene.rig.model', 'use the accepted package model path and hash');
  const animation = rig.animation as JsonObject;
  if (!objects(model.animations).some(value => value.name === animation.name)) sceneFail('SCENE_ANIMATION_MISSING', 'scene.rig.animation.name', 'choose an animation named by the model');
  const registration = isObject(version.registration) ? version.registration : {};
  if (registration.idle !== undefined && !sceneBinding(registration.idle) || !equal(animation.frames, registration.idle)) sceneFail('SCENE_MALFORMED', 'scene.rig.animation.frames', 'frames must be present exactly when registration.idle exists and equal that binding');
  if (isObject(animation.frames)) boundBytes(dir, animation.frames, 'SCENE_FILE_CHANGED', snapshots);
  if (model.stage === null || model.stage === undefined) sceneFail('SCENE_STAGE_MISSING', String(binding.path), 'compile a model with a stage box');
  if (!boxShape(model.stage) || !Object.values(model.stage).every(finite) || Number(model.stage.width) <= 0 || Number(model.stage.height) <= 0) sceneFail('SCENE_MALFORMED', `${String(binding.path)}.stage`, 'the model stage must be a finite positive box');
  if (!equal((doc.frame as JsonObject).stage, model.stage)) sceneFail('SCENE_STAGE_MISMATCH', 'scene.frame.stage', 'copy the model stage field for field');
  const plates = doc.plates as JsonObject[];
  if (plates.filter(plate => plate.role === 'background').length !== 1 || plates.filter(plate => plate.role === 'foreground').length > 1
    || plates.length === 2 && (plates[0]!.path === plates[1]!.path || plates[0]!.sha256 === plates[1]!.sha256)) sceneFail('SCENE_PLATE_CONFLICT', 'scene.plates', 'declare one background and at most one distinct foreground');
  const collection = loadCollection(dir);
  const ctx: Ctx = { dir, project, collection, items: collectItems(project, { collection }), refusals: [], warnings: [], signoffs: [], steps: [], stage: String(project.stage), effectiveStage: String(project.stage), predatesPartsReview: null };
  if (snapshots) {
    // Freeze the same current and historical answers checkEntry reads, including inherited history.
    for (const item of ctx.items.filter(value => value.id === 'post_composition')) {
      for (const answer of [item.raw, ...answersOf(item, ctx)]) {
        if (isObject(answer) && isObject(answer.choice) && isObject(answer.choice.set) && typeof answer.choice.set.path === 'string') {
          sceneBytes(dir, answer.choice.set.path, 'SCENE_CITATION_MISSING', snapshots);
        }
      }
    }
  }
  for (const [index, plate] of plates.entries()) {
    const path = `scene.plates[${index}]`;
    const bytes = boundBytes(dir, plate, 'SCENE_PLATE_CHANGED', snapshots);
    const size = pngDimensions(bytes, String(plate.path));
    if (size.width !== plate.width || size.height !== plate.height) sceneFail('SCENE_PLATE_DIMENSIONS', path, 'declared dimensions must equal PNG IHDR dimensions');
    const rect = plate.rect as JsonObject;
    const a = Number(rect.width) * size.height;
    const b = Number(rect.height) * size.width;
    if (!Object.values(rect).every(finite) || Number(rect.width) <= 0 || Number(rect.height) <= 0 || !Number.isFinite(a) || !Number.isFinite(b)
      || Math.abs(a - b) > 1e-9 * Math.max(Math.abs(a), Math.abs(b))) sceneFail('SCENE_PLACEMENT_INVALID', `${path}.rect`, 'use a finite positive box and uniform scale within relative 1e-9');
    if (!registeredPlate(project, plate)) sceneFail('SCENE_PLATE_UNREGISTERED', `${path}.registered`, 'register this exact path and sha256 as an input or a complete prepared-input receipt chain');
    const citation = plate.citation;
    if (!(closed(citation, ['guide', 'asks', 'quote']) && text(citation.quote) || closed(citation, ['guide', 'asks', 'delegated']) && citation.delegated === true)
      || citation.guide !== 'post_composition' || !equal(citation.asks, ['post_composition'])) sceneFail('SCENE_CITATION_MISSING', `${path}.citation`, 'cite post_composition with asks and a quote or delegated:true');
    checkEntry(ctx, 'post', `${path}.citation`, citation);
    if (ctx.refusals.length || ctx.warnings.length) sceneFail('SCENE_CITATION_MISSING', `${path}.citation`, 'cite a recorded post_composition answer or decided delegation');
  }
  const layers = plates.some(plate => plate.role === 'foreground') ? ['background', 'rig', 'foreground'] : ['background', 'rig'];
  if (!equal(doc.layers, layers)) sceneFail('SCENE_LAYER_ORDER', 'scene.layers', 'use background, rig and foreground only when declared, in that order');
  const author = by ?? sceneEntries(project).find(entry => entry.n === doc.n)?.by;
  if (author === 'agent') validateAgentSceneAuthority(dir, project, doc, ctx, snapshots, current);
}
/** The committed document a reference names, sealed by its scenes[] entry and not yet validated. */
export function committedScene(dir: string, project: JsonObject, reference: JsonObject, snapshots?: Map<string, Buffer>): JsonObject {
  const entry = sceneEntries(project).find(value => equal(sceneReference(value), reference));
  if (!entry) sceneFail('SCENE_MALFORMED', 'scenes', 'reference must equal a committed scenes[] entry');
  const doc = json(boundBytes(dir, entry, 'SCENE_FILE_CHANGED', snapshots), String(entry.path));
  if (doc.n !== entry.n) sceneFail('SCENE_MALFORMED', String(entry.path), 'document n differs from its committed entry');
  return doc;
}
export function readScene(dir: string, project: JsonObject, reference: JsonObject, snapshots?: Map<string, Buffer>, current = false): JsonObject {
  const entry = sceneEntries(project).find(value => equal(sceneReference(value), reference));
  const doc = committedScene(dir, project, reference, snapshots);
  validateScene(dir, project, doc, snapshots, current, entry ? String(entry.by) : undefined);
  return doc;
}
export function checkScenes(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals'>): void {
  try {
    for (const entry of sceneEntries(ctx.project)) {
      try { readScene(ctx.dir, ctx.project, sceneReference(entry)); }
      catch (error) { if (!(error instanceof SceneError)) throw error; ctx.refusals.push(sceneFinding(error)); }
    }
  } catch (error) { if (!(error instanceof SceneError)) throw error; ctx.refusals.push(sceneFinding(error)); }
}
