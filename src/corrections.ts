import { retainedReviewRead, reviewReadLegacy, ReviewReadError } from './review-read.ts';
import { configInputBindings, configInputsLegacy } from './config-inputs.ts';
import { DIRECTION_CORRECTION_SPEC, DirectionError, validateDirectionIdentity, validateDirectionOutcome } from './direction.ts';
/** Correction inventory reads retained producer evidence; it never applies a patch or builds a rig. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from './check-reads.ts';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { asArray, collectSignoffs, isObject, type Finding } from './check.ts';
import { collectReopens, liveSignoff, reopenTime } from './reopen.ts';
import { collectAmendments } from './amend.ts';
import { stageIndex } from './stages.ts';
import type { Json, JsonObject } from './templates.ts';
import { reviewConfigInputs, reviewHandoffInputs } from './review-package.ts';

export const CORRECTIONS_SPEC = 'rig-create/corrections@1';
export const CORRECTION_SPEC = 'rig-create/correction@1';
export const DESCRIBED_DIRECTION_SINCE = '2026-11-06T00:00:00Z';
export const CORRECTION_STAGES = ['parts-review', 'rig-review', 'direction-review'];
// @rig-c/parts 2.16.0, src/check.ts:3094 (CheckStatus), read from the installed producer.
const PRODUCER_CHECK_STATUSES = new Set(['PASS', 'FAIL', 'SKIP', 'WARN', 'CLEAR', 'REPORTED', 'UNCLASSIFIED']);
const requireCore = createRequire(import.meta.url);
const { assertPng } = requireCore('@rig-c/core/png') as { assertPng: (bytes: Uint8Array, label: string) => void };
const { decodePng } = requireCore('@rig-c/core/plate') as { decodePng: (bytes: Uint8Array) => { width: number; height: number; data: Uint8Array } };
const partNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Count retained PASS statuses only; preserve every other named status and the producer line. */
export function correctionCheckCoverage(summary: JsonObject): string {
  const bars = Object.entries(summary.bars as JsonObject);
  const measured = bars.filter(([, status]) => status === 'PASS').length;
  const unmeasured = bars.filter(([, status]) => status !== 'PASS').map(([name, status]) => `${name}=${String(status)}`);
  return `${measured} PASS bar(s) in the summary map; not measured: ${unmeasured.join(', ') || 'none'}; producer: ${String(summary.line)}`;
}

export const correctionHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
const date = (v: unknown): number => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) : NaN;
const closed = (v: JsonObject, required: string[], optional: string[] = []): boolean => required.every(k => k in v) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
export class CorrectionError extends Error {
  constructor(readonly code: string, why: string) { super(why); }
}
function fail(code: string, why: string): never { throw new CorrectionError(code, why); }
export function correctionFinding(code: string, path: string, why: string): Finding {
  return { code, path, message: `${path}: ${why}; retain the original correction evidence, resolve its named source/outcome, or reopen its review before recording again` };
}
/** Every ancestor must be a real directory, including under an otherwise contained symlink. */
export function correctionBytes(dir: string, path: string): Buffer {
  try {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || ['node_modules', '.git', 'scratch'].includes(path.split('/')[0] as string)) throw Error('expected literal retained project-relative file');
    let current = realpathSync(dir);
    for (const [i, part] of path.split('/').entries()) {
      current = join(current, part);
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (i === path.split('/').length - 1 ? !info.isFile() : !info.isDirectory())) throw Error('nonregular file or symlink');
    }
    const rel = relative(realpathSync(dir), realpathSync(current));
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw Error('outside project');
    return readFileSync(current);
  } catch (e) { return fail('CORRECTION_FILE', `${path}: ${e instanceof Error ? e.message : String(e)}`); }
}
export function correctionBinding(dir: string, path: string): JsonObject { return { path, sha256: correctionHash(correctionBytes(dir, path)) }; }
export function correctionFile(dir: string, binding: Json | undefined): Buffer {
  if (!isObject(binding) || !closed(binding, ['path', 'sha256']) || !text(binding.path) || !hex(binding.sha256)) fail('CORRECTION_MALFORMED', 'expected file {path,sha256}');
  const bytes = correctionBytes(dir, binding.path);
  if (correctionHash(bytes) !== binding.sha256) fail('CORRECTION_HASH', `${binding.path}: bytes differ from sha256`);
  return bytes;
}
export function correctionJson(bytes: Buffer): JsonObject {
  try { const v: Json = JSON.parse(bytes.toString('utf8')); if (!isObject(v)) throw Error('expected object'); return v; }
  catch (e) { return fail('CORRECTION_FILE', `invalid retained JSON: ${e instanceof Error ? e.message : String(e)}`); }
}

/** Grammar only. Pointer resolution, JSON Patch replay, route computation and producer measurements are forbidden. */
export function validateCorrectionPatch(v: JsonObject): void {
  const bad = (why: string): never => fail('CORRECTION_PATCH_INVALID', why);
  if (!closed(v, ['schema', 'config_sha256', 'ops', 'producer', 'op']) || v.schema !== 'rig-review-config-patch/1' || !hex(v.config_sha256)) bad('expected exact config-patch/1 fields');
  const producer = v.producer;
  const command = v.op;
  if (!isObject(producer) || !closed(producer, ['name', 'version']) || !text(producer.name) || !text(producer.version)) bad('producer requires name/version');
  if (!isObject(command) || !closed(command, ['cmd', 'args']) || !['rig', 'remesh'].includes(String(command.cmd)) || !Array.isArray(command.args) || command.args.some(a => typeof a !== 'string')) bad('invalid patch command');
  const cmd = command as JsonObject;
  const args = cmd.args as string[];
  const allowed: Record<string, string[]> = { '--idle-keys': ['ctl', 'direct'], '--page-edges': ['pot', 'free'], '--pack-shape': ['rect', 'polygon'] };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] as string; const value = args[i + 1];
    if (seen.has(flag) || !value || (flag === '--part' ? cmd.cmd !== 'remesh' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) : !allowed[flag]?.includes(value))) bad(`invalid/duplicate non-path arg ${flag}`);
    seen.add(flag);
  }
  if (cmd.cmd === 'remesh' && !seen.has('--part')) bad('remesh needs --part');
  if (!Array.isArray(v.ops) || v.ops.length < 1 || v.ops.length > 256) bad('ops must hold 1–256 entries');
  for (const raw of v.ops as Json[]) {
    if (!isObject(raw) || !['add', 'replace', 'remove'].includes(String(raw.op)) || !closed(raw, raw.op === 'remove' ? ['op', 'path'] : ['op', 'path', 'value'], ['name']) || !text(raw.path) || !raw.path.startsWith('/') || /~(?![01])/.test(raw.path) || (raw.name !== undefined && !text(raw.name))) bad('invalid patch operation/pointer');
    const op = raw as JsonObject;
    if (String(op.path).split('/').slice(1).some(s => /^\d+$/.test(s) && s.length > 1 && s.startsWith('0') || s === '-' && op.op !== 'add')) bad('invalid array index or append');
  }
}

export function versionRecord(project: JsonObject, n: Json | undefined): JsonObject {
  const matches = asArray(project.versions).filter(v => isObject(v) && v.n === n);
  if (!Number.isSafeInteger(n) || matches.length !== 1 || !isObject(matches[0])) return fail('CORRECTION_SOURCE', 'version must exist uniquely');
  return matches[0];
}
function draftRecord(project: JsonObject, value: Json | undefined): JsonObject {
  const matches = asArray(project.drafts).filter(v => isObject(v) && v.id === value);
  if (matches.length !== 1 || !isObject(matches[0])) return fail('CORRECTION_SOURCE', 'draft must exist uniquely');
  return matches[0];
}
function bindings(v: Json | undefined): JsonObject[] { return asArray(v).filter(isObject); }
function sameHash(a: Json | undefined, b: Json | undefined): boolean { return isObject(a) && isObject(b) && hex(a.sha256) && a.sha256 === b.sha256; }
function partsIdentity(dir: string, value: JsonObject): void {
  if (!(value.kind === 'parts' ? closed(value, ['kind', 'manifest', 'files']) : closed(value, ['manifest', 'files'])) || !isObject(value.manifest) || !String(value.manifest.path).endsWith('/parts.json') || !Array.isArray(value.files) || value.files.length === 0) fail('CORRECTION_SOURCE', 'parts identity needs manifest and complete files');
  correctionJson(correctionFile(dir, value.manifest));
  const files = bindings(value.files);
  if (files.length !== value.files.length || files.some((f, i) => !text(f.path) || (i > 0 && String(files[i - 1]?.path) >= f.path))) fail('CORRECTION_SOURCE', 'parts files must be unique and sorted');
  for (const f of files) correctionFile(dir, f);
  const root = dirname(String(value.manifest.path));
  const actual: string[] = [String(value.manifest.path)];
  const walk = (path: string): void => {
    for (const name of readdirSync(resolve(dir, path)).sort()) {
      const p = `${path}/${name}`; const info = lstatSync(resolve(dir, p));
      if (info.isSymbolicLink()) fail('CORRECTION_FILE', `${p}: symlink`);
      if (info.isDirectory()) walk(p); else { correctionBytes(dir, p); actual.push(p); }
    }
  };
  try { walk(`${root}/parts`); } catch (e) { if (e instanceof CorrectionError) throw e; fail('CORRECTION_FILE', `${root}/parts: missing/unreadable inventory`); }
  // The raster parts.json declares under painting_in_rig belongs to the inventory when the identity carries it (drafts.ts partsInventory).
  const painting = correctionJson(correctionFile(dir, value.manifest)).painting_in_rig;
  const declared = isObject(painting) && typeof painting.path === 'string' ? `${root}/${painting.path}` : null;
  if (declared !== null && files.some(f => f.path === declared)) actual.push(declared);
  if (!equal(actual.sort(), files.map(f => f.path))) fail('CORRECTION_SOURCE', 'parts manifest/tree inventory is incomplete');
  if (!files.some(f => equal(f, value.manifest))) fail('CORRECTION_SOURCE', 'manifest missing from inventory');
}
export function validateCorrectionIdentity(dir: string, project: JsonObject, value: Json | undefined, stage: string, direction = false): JsonObject {
  if (direction) {
    if (stage !== "direction-review" || !isObject(value)) fail("DIRECTION_CORRECTION_OUTCOME", "direction identity requires post at direction-review");
    try { validateDirectionIdentity(dir, project, value); } catch (e) { if (e instanceof DirectionError) fail(e.code,e.message); throw e; }
    return value;
  }
  if (!isObject(value)) return fail('CORRECTION_SOURCE', 'missing source/outcome identity');
  if (value.kind === 'parts') {
    if (stage !== 'parts-review') fail('CORRECTION_SOURCE', 'parts identity belongs to parts-review');
    partsIdentity(dir, value); return value;
  }
  if (value.kind === 'draft') {
    if (stage !== 'parts-review' || !closed(value, ['kind', 'id', 'config', 'parts', 'model'])) fail('CORRECTION_SOURCE', 'draft identity belongs to parts-review');
    const draft = draftRecord(project, value.id);
    if (!sameHash(value.config, draft.config) || !isObject(value.parts) || !isObject(draft.parts)) fail('CORRECTION_SOURCE', 'draft config/parts do not match inventory');
    correctionJson(correctionFile(dir, value.config)); correctionFile(dir, value.model);
    partsIdentity(dir, value.parts);
    const wanted = bindings(draft.parts.files).map(f => f.sha256).sort();
    if (!equal(bindings(value.parts.files).map(f => f.sha256).sort(), wanted) || !bindings(draft.files).some(f => sameHash(f, value.model) && String(f.path).endsWith('/skeleton.model.json'))) fail('CORRECTION_SOURCE', 'draft parts/model hashes differ from inventory');
    return value;
  }
  if (!['rig', 'post'].includes(String(value.kind)) || !closed(value, ['kind', 'n', 'config', 'model'])) fail('CORRECTION_SOURCE', 'unknown version identity');
  const version = versionRecord(project, value.n);
  if (version.kind !== value.kind || (value.kind === 'rig' ? stage !== 'rig-review' : stage !== 'direction-review')) fail('CORRECTION_SOURCE', 'review stage and version kind differ');
  if (!isObject(version.provenance) || !sameHash(value.config, version.provenance.config)) fail('CORRECTION_SOURCE', 'config differs from version provenance');
  correctionJson(correctionFile(dir, value.config)); correctionFile(dir, value.model);
  if (value.kind === 'post') {
    if (!bindings(version.outputs).some(f => sameHash(f, value.model) && isObject(value.model) && f.path === value.model.path)) fail('CORRECTION_SOURCE', 'post model must name a declared retained output');
  } else {
    const pkg = version.review_package;
    if (!isObject(pkg) || !sameHash(pkg.config, value.config) || !bindings(pkg.files).some(f => f.path === 'out/check/build/skeleton.model.json' && sameHash(f, value.model))) fail('CORRECTION_SOURCE', 'rig identity differs from review package');
  }
  return value;
}
function identityTime(project: JsonObject, v: JsonObject): number {
  return v.kind === 'rig' || v.kind === 'post' ? date(versionRecord(project, v.n).at) : v.kind === 'draft' ? date(draftRecord(project, v.id).at) : -Infinity;
}
function changed(a: JsonObject, b: JsonObject): boolean {
  const inventory = (v: JsonObject): Json[] => bindings(v.kind === 'draft' && isObject(v.parts) ? v.parts.files : v.files).map(f => f.sha256).sort();
  if (a.kind === 'parts' || b.kind === 'parts') return !equal(inventory(a), inventory(b));
  if (a.kind === 'draft' && b.kind === 'draft') return !sameHash(a.model, b.model) || !equal(inventory(a), inventory(b));
  return !sameHash(a.model, b.model);
}
export function correctionApplied(dir: string, artifact: JsonObject): { feedback: JsonObject; item: JsonObject; applied: JsonObject } {
  const binding = artifact.feedback;
  if (!isObject(binding) || !closed(binding, ['file', 'item_id']) || !text(binding.item_id)) return fail('CORRECTION_APPLIED_INVALID', 'feedback requires file and item_id');
  let feedback: JsonObject;
  try { feedback = retainedReviewRead(dir, artifact.review_read, binding.file); }
  catch (error) { if (error instanceof ReviewReadError) return fail(error.code,error.message); throw error; }
  const matches = bindings(feedback.feedback).filter(f => f.id === binding.item_id);
  const item = matches[0];
  if (feedback.schema !== 'rig-review-session/1' || !isObject(feedback.reviewedSource) || matches.length !== 1 || !isObject(item) || !text(item.summary) || !isObject(item.context) || !isObject(item.context.applied)) return fail('CORRECTION_APPLIED_INVALID', 'expected one session feedback item with context.applied');
  const applied = item.context.applied;
  if (applied.schema !== 'rig-review-applied/2' || !hex(applied.configHash) || !hex(applied.modelHash) || !hex(applied.patchSha256) || !hex(applied.buildId) || !isObject(applied.patch) || !isObject(applied.producer) || !text(applied.producer.package) || !text(applied.producer.version) || !isObject(applied.compiler) || !text(applied.compiler.package) || !text(applied.compiler.version) || !(applied.line === null || typeof applied.line === 'string') || !isObject(applied.diff)) fail('CORRECTION_APPLIED_INVALID', 'expected complete published applied/2 identity');
  if (!closed(applied, ['schema','buildId','patch','patchSha256','configHash','producer','compiler','line','check','diff','modelHash'], ['op','files','mesh','cloth','assembled','environment','stageInputHash'])) fail('CORRECTION_APPLIED_INVALID', 'unknown or missing applied/2 fields');
  if (applied.stageInputHash !== undefined && !hex(applied.stageInputHash)) fail('CORRECTION_APPLIED_INVALID', 'stageInputHash must be a 64-lowercase-hex sha256');
  if (!Number.isSafeInteger(applied.diff.count) || Number(applied.diff.count) < 0 || !Array.isArray(applied.diff.paths) || applied.diff.paths.length > 200 || applied.diff.paths.some(p => typeof p !== 'string') || applied.diff.paths.length > Number(applied.diff.count)) fail('CORRECTION_APPLIED_INVALID', 'malformed retained diff');
  const summary = applied.check;
  if (summary !== null && (!isObject(summary) || !closed(summary, ['schema','pass','exitCode','line','bars','gate'], ['source']) || summary.schema !== 'rig-review-check-summary/1' || ![true,false,null].includes(summary.pass as boolean|null) || !(summary.exitCode === null || Number.isInteger(summary.exitCode)) || typeof summary.line !== 'string' || !isObject(summary.bars) || Object.values(summary.bars).some(v => typeof v !== 'string') || typeof summary.gate !== 'boolean')) fail('CORRECTION_APPLIED_INVALID', 'malformed retained check summary');
  if (applied.files !== undefined && applied.files !== null) {
    const f = applied.files;
    if (!isObject(f) || !closed(f,['documents','images']) || !Array.isArray(f.documents) || !isObject(f.images) || !closed(f.images,['changed','unchanged','names']) || !Number.isSafeInteger(f.images.changed) || Number(f.images.changed)<0 || !Number.isSafeInteger(f.images.unchanged) || Number(f.images.unchanged)<0 || !Array.isArray(f.images.names) || f.images.names.length>200 || f.images.names.some(n=>typeof n!=='string')) fail('CORRECTION_APPLIED_INVALID','malformed retained files report');
    const names = new Set<string>();
    for (const d of (f as JsonObject).documents as Json[]) {
      if (!isObject(d) || !closed(d,['file','count','paths']) || !['rig.json','motion.json','sets.json','mesh_report.json'].includes(String(d.file)) || names.has(String(d.file)) || !Number.isSafeInteger(d.count) || Number(d.count)<0 || !Array.isArray(d.paths) || d.paths.length>200 || d.paths.some(p=>typeof p!=='string')) fail('CORRECTION_APPLIED_INVALID','malformed retained document diff');
      names.add(String((d as JsonObject).file));
    }
  }
  if (applied.environment !== undefined && (!isObject(applied.environment) || !closed(applied.environment,['sha256','steps']) || !hex(applied.environment.sha256) || !Number.isSafeInteger(applied.environment.steps) || Number(applied.environment.steps)<1)) fail('CORRECTION_APPLIED_INVALID','malformed retained environment');
  validateCorrectionPatch(applied.patch);
  if (!isObject(applied.patch.producer) || applied.patch.config_sha256 !== applied.configHash || applied.producer.package !== applied.patch.producer.name || applied.producer.version !== applied.patch.producer.version) fail('CORRECTION_APPLIED_INVALID', 'patch/config/producer mismatch');
  if (applied.op !== undefined && !['rig', 'retune', 'remesh', 'cloth', 'build'].includes(String(applied.op))) fail('CORRECTION_APPLIED_INVALID', 'unknown executed operation');
  const command = applied.patch.op as JsonObject;
  if (command.cmd === 'remesh' && applied.op !== undefined && applied.op !== 'remesh' || command.cmd === 'rig' && applied.op === 'remesh') fail('CORRECTION_APPLIED_INVALID','requested and executed operations disagree');
  if (applied.op === 'cloth' && (!isObject(applied.cloth) || !['build','rig'].includes(String(applied.cloth.route)) || !isObject(applied.cloth.keypoints) || !hex(applied.cloth.keypoints.sha256) || typeof applied.cloth.keypoints.path !== 'string' || !isObject(applied.cloth.written))) fail('CORRECTION_APPLIED_INVALID','cloth route needs published context');
  if ((applied.op === 'build' || isObject(applied.cloth) && applied.cloth.route === 'build') && (!isObject(applied.assembled) || typeof applied.assembled.wallMs !== 'number' || !isObject(applied.assembled.recomposite) || !Array.isArray(applied.assembled.partsChanged) || !Array.isArray(applied.assembled.seamPairs))) fail('CORRECTION_APPLIED_INVALID','build route needs published assembled context');
  if (applied.mesh !== undefined) {
    const mesh=applied.mesh;
    if (!isObject(mesh) || typeof mesh.part!=='string' || !isObject(mesh.before) || !isObject(mesh.after) || ['before','after'].some(side=>['vertices','triangles','hull'].some(k=>!Number.isSafeInteger((mesh[side] as JsonObject)[k]) || Number((mesh[side] as JsonObject)[k])<0)) || command.cmd!=='remesh' || (command.args as string[])[(command.args as string[]).indexOf('--part')+1]!==mesh.part) fail('CORRECTION_APPLIED_INVALID','malformed or mismatched retained mesh counts');
  }
  return { feedback, item, applied };
}
const outsideProject = (p: string): boolean => p === '..' || p.startsWith('../') || posix.isAbsolute(p);
/**
 * Review's input contract, @rig-c/review 2.7.0 src/manifest.ts:89-92 (`loadReview`):
 * a directory input is the package, and any other input is a manifest file whose
 * folder is the package. create reads which one a retained input was from its
 * `.json` suffix; the writer refuses an input whose kind on disk disagrees.
 */
const manifestInput = (input: string): boolean => posix.extname(input) === '.json';
/**
 * The `rig-review feedback` input as it is retained. Review runs with the project
 * as its working directory (review-read.ts `runReview`), so an absolute input inside
 * the project names the same package as its project-relative form, which survives
 * the project being moved. A draft route's input must say by its form alone whether
 * it is the package directory or its manifest file, since check reads it that way.
 */
export function feedbackPackageInput(dir: string, input: string, draft: boolean): string {
  let value = input;
  if (isAbsolute(input)) for (const root of [resolve(dir), realpathSync(dir)]) {
    const rel = relative(root, resolve(input)).split(sep).join('/');
    if (!outsideProject(rel)) { value = rel || '.'; break; }
  }
  if (draft) {
    let directory: boolean | null = null;
    try { directory = statSync(resolve(dir, value)).isDirectory(); } catch { /* Review refuses a missing input by name. */ }
    if (directory !== null && directory === manifestInput(value)) fail('CORRECTION_APPLIED_INVALID', `--feedback-file ${value} is a ${directory ? 'directory named .json' : 'manifest file without a .json suffix'}; pass the package directory, or its manifest as a .json file`);
  }
  return value;
}
/**
 * Review writes handoff paths relative to the package it opened (`../../config.json`
 * for a package at `<draft>/out/check`). The package is the retained input of the
 * `rig-review feedback <input>` read, or the folder of a manifest file opened
 * directly, read from the input's form and never from the current filesystem. Each
 * path is rebased onto it to the project-relative form create binds; one that leaves
 * the project is refused by name.
 */
function draftHandoffFiles(artifact: JsonObject, raw: Json[]): { base: string; files: JsonObject[] } {
  const input = String(((artifact.review_read as JsonObject).argv as Json[])[2]);
  if (isAbsolute(input) || input.includes('\\')) fail('CORRECTION_APPLIED_INVALID', `feedback package ${input} is not project-relative; record the correction again with --feedback-file relative to the project`);
  const base = posix.normalize(manifestInput(input) ? posix.dirname(input) : input).replace(/\/+$/, '') || '.';
  if (outsideProject(base)) fail('CORRECTION_APPLIED_INVALID', `feedback package ${input} is outside the project; read the review feedback from the package inside the project`);
  return { base, files: bindings(raw).map(f => {
    if (!text(f.path) || f.path.includes('\\') || posix.isAbsolute(f.path)) fail('CORRECTION_APPLIED_INVALID', `handoff path ${JSON.stringify(f.path)} is not a literal package-relative path`);
    const path = posix.normalize(posix.join(base, f.path));
    if (outsideProject(path)) fail('CORRECTION_APPLIED_INVALID', `handoff path ${f.path} resolves outside the project from package ${base}`);
    return { ...f, path };
  }) };
}
function validateApplied(dir: string, project: JsonObject, record: JsonObject, artifact: JsonObject, on: JsonObject, warnings: Finding[], path: string): void {
  const { feedback, item, applied } = correctionApplied(dir, artifact);
  if (record.verbatim !== item.summary || record.by !== 'user') fail('CORRECTION_APPLIED_INVALID', 'made human fields must retain summary and by:user');
  if (!isObject(on.config) || on.config.sha256 !== applied.configHash || !isObject(on.model)) fail('CORRECTION_APPLIED_INVALID', 'Apply does not bind source config/model');
  const reviewed = feedback.reviewedSource as JsonObject;
  const handoff = reviewed.handoff;
  if (!isObject(reviewed.rig) || reviewed.rig.sha256 !== on.model.sha256 || reviewed.motion !== null || !isObject(handoff) || !sameHash(handoff.config, on.config) || !Array.isArray(handoff.files) || !Array.isArray(handoff.missing) || handoff.missing.length !== 0) fail('CORRECTION_APPLIED_INVALID', 'feedback reviewed source/handoff differs');
  const requireNamed = (named: JsonObject[], files: JsonObject[], from = ''): void => {
    for (const input of named) {
      const matches = files.filter(f => f.path === input.path);
      if (matches.length && (!hex(input.sha256) || matches.length !== 1 || matches[0]!.sha256 !== input.sha256)) fail('CORRECTION_APPLIED_INVALID', `config-named input ${String(input.path)} has an altered hash`);
      if (!matches.length) {
        const reason = `config-named input ${String(input.path)} is missing from handoff${from}`;
        if (!configInputsLegacy(record.at)) fail('CORRECTION_APPLIED_INVALID', reason);
        warnings.push(correctionFinding('CORRECTION_APPLIED_INVALID', path, `${reason}; legacy input omission`));
      }
    }
  };
  if (on.kind === 'rig') {
    const version = versionRecord(project, on.n);
    const pkg = version.review_package as JsonObject;
    const packageIssue = (reason: string, at: unknown): void => {
      if (!configInputsLegacy(at)) fail('CORRECTION_APPLIED_INVALID', reason);
      warnings.push(correctionFinding('CORRECTION_APPLIED_INVALID', path, reason));
    };
    const named = reviewConfigInputs(pkg, dir, Number(on.n), name => packageIssue(`config-named input ${name} is missing from source package`, version.at), error => packageIssue(error.message, record.at));
    const inputs = reviewHandoffInputs(pkg, dir, Number(on.n), named);
    const files: JsonObject[] = bindings(handoff.files).map(f => ({ ...f, path: posix.normalize(`out/check/${String(f.path)}`) }));
    requireNamed(named.filter(f => hex(f.sha256)), files);
    for (const input of named.filter(f => !hex(f.sha256))) if (files.some(f => f.path === input.path)) fail('CORRECTION_APPLIED_INVALID', `config-named input ${String(input.path)} has no frozen package hash`);
    const required = inputs.filter(f => !named.some(n => n.path === f.path));
    if (files.length !== handoff.files.length || !required.every(f => files.some(h => h.path === f.path && h.sha256 === f.sha256)) || !files.every(h => inputs.some(f => f.path === h.path && f.sha256 === h.sha256)) || new Set(files.map(f => f.path)).size !== files.length) fail('CORRECTION_APPLIED_INVALID', 'feedback input inventory differs from source package');
  } else if (on.kind === 'draft') {
    const draft = draftRecord(project, on.id);
    const named = configInputBindings(dir, String((draft.config as JsonObject).path), true, error => {
      if (!configInputsLegacy(record.at)) fail('CORRECTION_APPLIED_INVALID', error.message);
      warnings.push(correctionFinding('CORRECTION_APPLIED_INVALID', path, error.message));
    }).map(input => {
      // A missing directory input names its directory; its binding is the receipt that stands for it.
      const bound = bindings(draft.config_inputs).find(f => f.path === input.path || f.directory === input.path);
      if (bound && input.sha256 === null) return bound;
      return input;
    });
    for (const input of bindings(draft.config_inputs)) {
      if (!named.some(f => f.path === input.path && f.sha256 === input.sha256)) fail('CORRECTION_APPLIED_INVALID', `config-named input ${String(input.path)} differs from draft binding`);
    }
    const { base, files } = draftHandoffFiles(artifact, handoff.files);
    requireNamed(named, files, ` (handoff paths read relative to package ${base})`);
    const expected = [draft.config, ...bindings(isObject(draft.parts) ? draft.parts.files : undefined), ...bindings(draft.files), ...named];
    const required = expected.filter(x => isObject(x) && (x === draft.config || String(x.path).endsWith('/parts.json') || String(x.path).includes('/parts/') || /\/(rig|motion|mesh_report)\.json$/.test(String(x.path))));
    if (!required.every(x=>files.some(f=>sameHash(x,f))) || !files.every(f => expected.some(x => sameHash(x, f)))) fail('CORRECTION_APPLIED_INVALID', 'draft handoff contains foreign inputs');
  } else fail('CORRECTION_APPLIED_INVALID', 'config patch Apply requires rig or reviewed draft');
  const summary = applied.check;
  if (artifact.state === 'applied-and-checked') {
    if (!isObject(summary) || summary.schema !== 'rig-review-check-summary/1' || summary.pass !== true || summary.exitCode !== 0 || summary.gate !== true || !text(summary.line) || !isObject(summary.bars) || (summary.source !== undefined && !['remesh', 'retune', 'check'].includes(String(summary.source)))) fail('CORRECTION_APPLIED_INVALID', 'claimed checked Apply lacks a passing producer check summary');
    const bars = summary.bars as JsonObject;
    for (const [name, status] of Object.entries(bars)) {
      if (status === 'FAIL' || typeof status !== 'string' || !PRODUCER_CHECK_STATUSES.has(status)) fail('CORRECTION_APPLIED_INVALID', `check bar ${name} has invalid status ${String(status)}`);
    }
    if (!Object.values(bars).includes('PASS')) fail('CORRECTION_APPLIED_INVALID', `check bars ${Object.keys(bars).join(', ') || '(empty)'} contain no PASS bar`);
    // parts 2.16.0 src/check.ts:3069–3071 prints coverage's skipped names.
    // Report-only SKIPs need not appear there, so compare only names the line supplies.
    const coverage = /\b\d+ of \d+ bar\(s\) measured, \d+ skipped \(([^)]*)\)/.exec(String(summary.line));
    for (const name of coverage?.[1]?.split(', ') ?? []) {
      if (Object.hasOwn(bars, name) && bars[name] === 'PASS') fail('CORRECTION_APPLIED_INVALID', `check bar ${name} is PASS but the producer line names it skipped`);
    }
    if (!isObject(record.outcome) || !sameHash(record.outcome.model, { sha256: applied.modelHash })) fail('CORRECTION_OUTCOME', 'checked Apply outcome differs from applied.modelHash');
  }
}

function decodePartPng(bytes: Uint8Array, label: string): { width: number; height: number; data: Uint8Array } {
  try {
    assertPng(bytes, label);
    return decodePng(bytes);
  } catch (e) {
    return fail('CORRECTION_PART_IMAGE_MASK_SIZE', `${label}: invalid PNG (${e instanceof Error ? e.message : String(e)})`);
  }
}

export function draftPartBinding(draft: JsonObject, part: string): JsonObject | null {
  if (!isObject(draft.parts) || typeof draft.parts.path !== 'string' || !Array.isArray(draft.parts.files)) return null;
  const expectedPath = `${draft.parts.path}/parts/${part}.png`;
  const match = bindings(draft.parts.files).find(f => f.path === expectedPath && hex(f.sha256));
  return match ?? null;
}

export function validatePartImageArtifact(dir: string, project: JsonObject, record: JsonObject, art: JsonObject, on: JsonObject): void {
  if (record.stage !== 'parts-review' || on.kind !== 'draft') fail('CORRECTION_MALFORMED', 'part-image requires parts-review and a parent draft');
  if (!closed(art, ['kind', 'draft', 'part', 'before', 'after', 'mask', 'tool']) || !id(art.draft) || typeof art.part !== 'string' || !partNamePattern.test(art.part) || !text(art.tool)) {
    fail('CORRECTION_MALFORMED', 'part-image requires {kind,draft,part,before,after,mask,tool}');
  }
  if (art.draft !== on.id) fail('CORRECTION_PART_IMAGE_BEFORE', `artifact.draft ${String(art.draft)} differs from parent draft ${String(on.id)}`);
  const parentDraft = draftRecord(project, on.id);
  const expectedBefore = draftPartBinding(parentDraft, art.part);
  if (!expectedBefore) fail('CORRECTION_PART_IMAGE_BEFORE', `parent draft ${String(on.id)} has no bound part ${art.part}`);
  if (!isObject(art.before) || !closed(art.before, ['path', 'sha256']) || !text(art.before.path) || !hex(art.before.sha256)) {
    fail('CORRECTION_MALFORMED', 'before requires file {path,sha256}');
  }
  const beforeBytes = correctionFile(dir, art.before);
  if (art.before.path !== expectedBefore.path || art.before.sha256 !== expectedBefore.sha256) {
    fail('CORRECTION_PART_IMAGE_BEFORE', `before ${String(art.before.path)} is not parent draft ${String(on.id)}'s bound ${String(expectedBefore.path)}`);
  }
  const afterBytes = correctionFile(dir, art.after);
  const maskBytes = correctionFile(dir, art.mask);
  const beforePng = decodePartPng(beforeBytes, String(art.before.path));
  const afterPng = decodePartPng(afterBytes, String((art.after as JsonObject).path));
  const maskPng = decodePartPng(maskBytes, String((art.mask as JsonObject).path));
  if (maskPng.width !== beforePng.width || maskPng.height !== beforePng.height) {
    fail('CORRECTION_PART_IMAGE_MASK_SIZE', `mask ${String((art.mask as JsonObject).path)} (${maskPng.width}x${maskPng.height}) differs from part ${String(art.before.path)} (${beforePng.width}x${beforePng.height})`);
  }
  if (afterPng.width !== beforePng.width || afterPng.height !== beforePng.height) {
    fail('CORRECTION_PART_IMAGE_MASK_SIZE', `after ${String((art.after as JsonObject).path)} (${afterPng.width}x${afterPng.height}) differs from before ${String(art.before.path)} (${beforePng.width}x${beforePng.height})`);
  }
  const maskData = maskPng.data;
  let hasAlphaVariation = false;
  let hasNonZeroRgb = false;
  for (let i = 0; i < maskData.length; i += 4) {
    const a = maskData[i + 3]!;
    if (a < 255) hasAlphaVariation = true;
    if (a > 0 && (maskData[i]! > 0 || maskData[i + 1]! > 0 || maskData[i + 2]! > 0)) hasNonZeroRgb = true;
  }
  const insideMask = (offset: number): boolean => {
    const a = maskData[offset + 3]!;
    if (a === 0) return false;
    if (hasNonZeroRgb) return maskData[offset]! > 0 || maskData[offset + 1]! > 0 || maskData[offset + 2]! > 0;
    return hasAlphaVariation;
  };
  const beforeData = beforePng.data;
  const afterData = afterPng.data;
  let changedPixels = 0;
  let outsideAt: { x: number; y: number } | null = null;
  let addedAlphaAt: { x: number; y: number; beforeA: number; afterA: number } | null = null;
  for (let y = 0; y < beforePng.height; y++) {
    for (let x = 0; x < beforePng.width; x++) {
      const offset = (y * beforePng.width + x) * 4;
      const bR = beforeData[offset]!, bG = beforeData[offset + 1]!, bB = beforeData[offset + 2]!, bA = beforeData[offset + 3]!;
      const aR = afterData[offset]!, aG = afterData[offset + 1]!, aB = afterData[offset + 2]!, aA = afterData[offset + 3]!;
      if (bR === aR && bG === aG && bB === aB && bA === aA) continue;
      changedPixels++;
      if (!insideMask(offset) && outsideAt === null) outsideAt = { x, y };
      if (aA > bA && addedAlphaAt === null) addedAlphaAt = { x, y, beforeA: bA, afterA: aA };
    }
  }
  if (outsideAt !== null) {
    fail('CORRECTION_PART_IMAGE_OUTSIDE_MASK', `after ${String((art.after as JsonObject).path)} differs from before ${String(art.before.path)} outside mask ${String((art.mask as JsonObject).path)} at (${outsideAt.x},${outsideAt.y})`);
  }
  if (addedAlphaAt !== null) {
    fail('CORRECTION_PART_IMAGE_ADDED_ALPHA', `after ${String((art.after as JsonObject).path)} adds alpha at (${addedAlphaAt.x},${addedAlphaAt.y}) (${addedAlphaAt.beforeA} -> ${addedAlphaAt.afterA})`);
  }
  if (changedPixels === 0) {
    fail('CORRECTION_PART_IMAGE_BEFORE', `after ${String((art.after as JsonObject).path)} has no pixel changes from before ${String(art.before.path)}`);
  }
}

export function partImageResolvingDraft(project: JsonObject, record: JsonObject): JsonObject | null {
  if (!isObject(record.artifact) || record.artifact.kind !== 'part-image' || record.verdict === 'withdrawn') return null;
  const art = record.artifact;
  if (!id(art.draft) || typeof art.part !== 'string' || !isObject(art.after) || !hex(art.after.sha256)) return null;
  const drafts = bindings(project.drafts);
  if (isObject(record.outcome)) {
    if (record.outcome.kind !== 'draft' || record.outcome.id === art.draft) return null;
    const target = drafts.find(d => d.id === (record.outcome as JsonObject).id);
    if (!target) return null;
    const partBinding = draftPartBinding(target, art.part);
    return partBinding && partBinding.sha256 === art.after.sha256 ? target : null;
  }
  const parentIdx = drafts.findIndex(d => d.id === art.draft);
  const candidates = (parentIdx >= 0 ? drafts.slice(parentIdx + 1) : drafts).filter(d =>
    d.id !== art.draft && Number.isFinite(date(d.at)) && date(d.at) >= date(record.at)
  );
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    const partBinding = draftPartBinding(candidate, art.part);
    if (partBinding && partBinding.sha256 === art.after.sha256) return candidate;
  }
  return null;
}

export function checkUnrecordedPartRepaints(_dir: string, project: JsonObject, refusals: Finding[]): void {
  if (!Array.isArray(project.drafts)) return;
  const drafts = bindings(project.drafts);
  const corrections = bindings(project.corrections);
  const allPartImage = corrections.filter(c =>
    isObject(c.artifact) && c.artifact.kind === 'part-image'
    && isObject(c.artifact.before) && isObject(c.artifact.after)
    && hex(c.artifact.after.sha256) && c.artifact.before.sha256 !== c.artifact.after.sha256
  );
  if (allPartImage.length === 0) return;
  const reopens = collectReopens(project, []);
  const firstResolutionTime = (c: JsonObject): number => {
    const art = c.artifact as JsonObject;
    const parentIdx = drafts.findIndex(d => d.id === art.draft);
    for (const d of parentIdx >= 0 ? drafts.slice(parentIdx + 1) : drafts) {
      if (d.id === art.draft || !(date(d.at) >= date(c.at))) continue;
      const pb = draftPartBinding(d, String(art.part));
      if (pb && pb.sha256 === (art.after as JsonObject).sha256) return date(d.at);
    }
    return Infinity;
  };
  const isWithdrawnAt = (c: JsonObject, draftAt: number): boolean =>
    c.verdict === 'withdrawn' && (!Number.isFinite(date(c.withdrawn_at)) || date(c.withdrawn_at) <= draftAt);
  const isSupersededAt = (c: JsonObject, draftAt: number): boolean => {
    const checkUntil = Math.min(draftAt, firstResolutionTime(c));
    const reopenByThen = reopenTime(reopens.filter(r => r.at <= checkUntil), String(c.stage));
    if (date(c.at) <= reopenByThen) return true;
    return corrections.some(r => r.resolves === c.id && r.verdict !== 'withdrawn' && date(r.at) <= draftAt);
  };
  for (const [index, draft] of drafts.entries()) {
    if (!isObject(draft.parts) || typeof draft.parts.path !== 'string' || !Array.isArray(draft.parts.files)) continue;
    const partsRoot = draft.parts.path;
    const prefix = `${partsRoot}/parts/`;
    const partFiles = bindings(draft.parts.files).filter(f => typeof f.path === 'string' && f.path.startsWith(prefix) && f.path.endsWith('.png') && hex(f.sha256));
    for (const pf of partFiles) {
      const partName = String(pf.path).slice(prefix.length, -4);
      const matchingRepaints = allPartImage.filter(c => ((c.artifact as JsonObject).after as JsonObject).sha256 === pf.sha256);
      if (matchingRepaints.length === 0) continue;
      const draftAt = date(draft.at);
      const covered = matchingRepaints.some(c => {
        if (c.stage !== 'parts-review' || c.path !== 'made' || isWithdrawnAt(c, draftAt) || isSupersededAt(c, draftAt)) return false;
        if (!(date(c.at) <= draftAt)) return false;
        const art = c.artifact as JsonObject;
        if (art.part !== partName || art.draft === draft.id) return false;
        const parent = drafts.slice(0, index).find(prev => prev.id === art.draft);
        if (!parent) return false;
        const parentPf = draftPartBinding(parent, partName);
        return parentPf !== null && isObject(art.before) && art.before.sha256 === parentPf.sha256;
      });
      if (!covered) {
        const ref = matchingRepaints[0]!;
        const refArt = ref.artifact as JsonObject;
        const parentId = typeof refArt.draft === 'string' ? refArt.draft : '<draft-id>';
        const path = `drafts[${index}].parts.files`;
        if (!refusals.some(r => r.code === 'DRAFT_PART_REPAINT_UNRECORDED' && r.path === path)) {
          refusals.push({
            code: 'DRAFT_PART_REPAINT_UNRECORDED',
            path,
            message: `${path}: part ${partName} (${String(pf.path)}) binds part-image after bytes (${String(pf.sha256)}) from correction ${String(ref.id)} without a live covering part-image correction record; record a live masked repaint with correction record --path made --stage parts-review --draft ${parentId} --part ${partName} --part-image-file <after.png> --mask-file <mask.png> --tool <text> before recording the draft`,
          });
        }
      }
    }
  }
}

export function correctionsAdopted(project: JsonObject): boolean { return isObject(project.corrections_contract) && project.corrections_contract.schema === CORRECTIONS_SPEC; }
export function correctionIsLive(project: JsonObject, r: JsonObject): boolean {
  return date(r.at) > reopenTime(collectReopens(project, []), String(r.stage));
}
export function correctionApprovalFindings(project: JsonObject, stage: string, signoff?: JsonObject): Finding[] {
  const out: Finding[] = [];
  if (!correctionsAdopted(project)) return out;
  const records = bindings(project.corrections);
  const relevant = records.filter(r => r.stage === stage && r.verdict !== 'withdrawn' && correctionIsLive(project, r) && date(r.at) >= date((project.corrections_contract as JsonObject).adopted_at));
  for (const r of relevant) {
    const replacement = relevant.find(next => next.resolves === r.id && (next.outcome !== null || partImageResolvingDraft(project, next) !== null));
    if (replacement) continue;
    const path = `corrections[${String(r.id)}]`;
    if (isObject(r.artifact) && r.artifact.kind === 'part-image') {
      const resolving = partImageResolvingDraft(project, r);
      const resolvedAt = isObject(r.closure) ? date(r.closure.at) : resolving ? date(resolving.at) : Infinity;
      if (!resolving || (signoff && resolvedAt > date(signoff.at))) {
        out.push(correctionFinding('CORRECTION_PENDING', path, `resolve active correction before approving ${stage}`));
        continue;
      }
      if (stage === 'parts-review' && signoff) {
        const signedDraft = bindings(project.drafts).find(d => d.id === signoff.draft_id);
        const signedPart = signedDraft ? draftPartBinding(signedDraft, String(r.artifact.part)) : null;
        if (!signedDraft || (isObject(r.outcome) && r.outcome.id !== signoff.draft_id) || !signedPart || !isObject(r.artifact.after) || signedPart.sha256 !== r.artifact.after.sha256) {
          out.push(correctionFinding('CORRECTION_OUTCOME', path, 'approved draft does not bind the repainted part image'));
        }
      }
      continue;
    }
    if (!isObject(r.outcome) || signoff && (!isObject(r.closure) || date(r.closure.at) > date(signoff.at))) { out.push(correctionFinding('CORRECTION_PENDING', path, `resolve active correction before approving ${stage}`)); continue; }
    if (stage === 'parts-review' && signoff) {
      const outcome = r.outcome;
      if (outcome.kind === 'draft' && outcome.id !== signoff.draft_id) out.push(correctionFinding('CORRECTION_OUTCOME', path, 'approved draft is not the corrected draft'));
      else if (outcome.kind === 'parts') {
        const draft = bindings(project.drafts).find(d => d.id === signoff.draft_id);
        if (!draft || !isObject(draft.parts) || !equal(bindings(draft.parts.files).map(f => f.sha256).sort(), bindings(outcome.files).map(f => f.sha256).sort())) out.push(correctionFinding('CORRECTION_OUTCOME', path, 'approved draft does not use corrected parts'));
      }
    }
  }
  return out;
}
export function checkCorrections(ctx: { dir: string; project: JsonObject; refusals: Finding[]; warnings: Finding[] }, now: number): void {
  const { dir, project, refusals, warnings } = ctx;
  const contract = project.corrections_contract;
  if (contract === undefined) warnings.push(correctionFinding('CORRECTION_PATH_LEGACY', 'corrections_contract', 'correction paths are not adopted; adopt explicitly without rewriting history'));
  else if (!isObject(contract) || !closed(contract, ['schema', 'adopted_at']) || contract.schema !== CORRECTIONS_SPEC || !Number.isFinite(date(contract.adopted_at)) || date(contract.adopted_at) > now) refusals.push(correctionFinding('CORRECTION_CONTRACT_INVALID', 'corrections_contract', 'invalid explicit adoption'));
  if (project.corrections === undefined) { if (contract !== undefined) refusals.push(correctionFinding('CORRECTION_MALFORMED', 'corrections', 'adopted contract needs an explicit list')); return; }
  if (!Array.isArray(project.corrections)) { refusals.push(correctionFinding('CORRECTION_MALFORMED', 'corrections', 'expected list')); return; }
  if (!correctionsAdopted(project) && project.corrections.length) refusals.push(correctionFinding('CORRECTION_CONTRACT_INVALID', 'corrections_contract', 'records require explicit adoption'));
  const seen = new Map<string, JsonObject>();
  for (const [index, raw] of project.corrections.entries()) {
    const path = `corrections[${index}]`;
    try {
      const partImage = isObject(raw) && isObject(raw.artifact) && raw.artifact.kind === 'part-image';
      if (!isObject(raw) || !closed(raw, ['schema', 'id', 'path', 'by', 'at', 'verbatim', 'stage', 'on', 'artifact', 'outcome', 'resolves'], ['source', 'closure', 'verdict']) || ![CORRECTION_SPEC,DIRECTION_CORRECTION_SPEC].includes(String(raw.schema)) || !id(raw.id) || seen.has(raw.id) || !['described', 'made'].includes(String(raw.path)) || (partImage ? raw.by !== 'agent' || raw.verbatim !== null : !text(raw.by) || raw.by.toLowerCase() === 'agent' || !text(raw.verbatim)) || !Number.isFinite(date(raw.at)) || date(raw.at) > now || !CORRECTION_STAGES.includes(String(raw.stage)) || (raw.source !== undefined && typeof raw.source !== 'string') || (raw.verdict !== undefined && raw.verdict !== 'withdrawn')) fail('CORRECTION_MALFORMED', 'invalid common fields, duplicate id or human timestamp');
      const record = raw as JsonObject;
      if (record.resolves !== null) {
        const prior = seen.get(String(record.resolves));
        if (!prior || prior.stage !== record.stage || date(prior.at) >= date(record.at)) fail('CORRECTION_MALFORMED', 'replacement must name an earlier same-stage record');
      }
      seen.set(String(record.id), record);
      const direction = record.schema === DIRECTION_CORRECTION_SPEC;
      const describedDirection = record.path === 'described' && record.stage === 'direction-review' && isObject(record.on) && record.on.kind === 'post';
      const directionPatch = isObject(record.artifact) && record.artifact.kind === 'direction-patch';
      if (direction && !describedDirection && !directionPatch || !direction && directionPatch || direction && partImage) fail('CORRECTION_MALFORMED', 'correction@2 requires a direction description or direction-patch');
      if (!direction && describedDirection) {
        const version = versionRecord(project, (record.on as JsonObject).n);
        if (isObject(version.provenance) && isObject(version.provenance.direction)) {
          if (date(record.at) >= Date.parse(DESCRIBED_DIRECTION_SINCE)) fail('DESCRIBED_DIRECTION_REQUIRED', 'authored direction description requires correction@2 and exact direction identity');
          warnings.push(correctionFinding('DESCRIBED_DIRECTION_LEGACY', path, 'historical description lacks the exact direction identity; preserve it and capture a new correction@2 request'));
        }
      }
      const on = validateCorrectionIdentity(dir, project, record.on, String(record.stage), direction);
      if (identityTime(project, on) > date(record.at)) fail('CORRECTION_SOURCE', 'correction predates its source');
      if (record.resolves !== null && (on.kind === 'rig' || on.kind === 'post') && bindings(project.versions).some(v => v.kind === on.kind && Number(v.n) > Number(on.n) && date(v.at) <= date(record.at))) fail('CORRECTION_SOURCE', 'correction must name the latest reviewed version at capture');
      const artifact = record.artifact;
      if (!isObject(artifact)) fail('CORRECTION_MALFORMED', 'missing artifact');
      const art = artifact as JsonObject;
      const apiArtifact = record.path === 'made' && !direction && !partImage;
      const legacyRead = apiArtifact && art.review_read === undefined && reviewReadLegacy(record.at);
      if (legacyRead) warnings.push(correctionFinding('REVIEW_READ_LEGACY', path, 'historical correction has no CLI response receipt; preserve history and capture new results through Review feedback'));
      if (legacyRead) {
        if(record.by !== 'user') fail('CORRECTION_MALFORMED','made requires by:user');
        if(art.kind === 'unsupported') {
          if(!closed(art,['kind','operation','reason','files','producer_schema']) || !['mesh-delta','retarget','keyed-animation','other'].includes(String(art.operation)) || !text(art.reason) || !text(art.producer_schema) || !Array.isArray(art.files) || !art.files.length) fail('CORRECTION_MALFORMED','invalid historical unsupported artifact');
          if(record.outcome !== null) fail('CORRECTION_UNSUPPORTED_OUTCOME','unsupported operations cannot claim completion');
        } else if(art.kind !== 'config-patch' || !closed(art,['kind','state','feedback'],['patch']) || !['preview/pending','applied-and-checked'].includes(String(art.state)) || on.kind === 'post' || on.kind === 'parts' || record.outcome !== null && art.state !== 'applied-and-checked') fail('CORRECTION_MALFORMED','invalid historical config patch artifact');
      }
      if (apiArtifact && !legacyRead) {
        try { retainedReviewRead(dir,art.review_read,art.kind === 'unsupported' ? asArray(art.files)[0] : isObject(art.feedback) ? art.feedback.file : undefined); }
        catch(error) { if(error instanceof ReviewReadError) fail(error.code,error.message); throw error; }
      }
      if (record.path === 'described') {
        if (!closed(art, ['kind']) || art.kind !== 'description') fail('CORRECTION_MALFORMED', 'described artifact is description');
      } else if (direction) {
        if (record.by !== 'user') fail('CORRECTION_MALFORMED','made requires by:user');
        try { validateDirectionOutcome(dir,project,record,art); } catch(e) { if(e instanceof DirectionError) fail(e.code,e.message); throw e; }
      } else if (partImage) {
        if (record.path !== 'made') fail('CORRECTION_MALFORMED', 'part-image requires made path');
        validatePartImageArtifact(dir, project, record, art, on);
      } else if (!legacyRead) {
        if (record.by !== 'user') fail('CORRECTION_MALFORMED', 'made requires by:user');
        if (art.kind === 'unsupported') {
          if (!closed(art, ['kind', 'operation', 'reason', 'files', 'producer_schema'], ['review_read']) || !['mesh-delta', 'retarget', 'keyed-animation', 'other'].includes(String(art.operation)) || !text(art.reason) || !text(art.producer_schema) || !Array.isArray(art.files) || art.files.length!==1) fail('CORRECTION_MALFORMED', 'invalid unsupported artifact');
          if (record.outcome !== null) fail('CORRECTION_UNSUPPORTED_OUTCOME', 'unsupported operations cannot claim completion');
        } else {
          if (art.kind !== 'config-patch' || !closed(art, ['kind', 'state', 'feedback','review_read']) || !['preview/pending', 'applied-and-checked'].includes(String(art.state)) || on.kind === 'post' || on.kind === 'parts') fail('CORRECTION_MALFORMED', 'config patch needs rig/draft and known state');
          if (art.feedback !== null) {
            try { validateApplied(dir, project, record, art, on, warnings, path); }
            catch (error) { if (error instanceof CorrectionError) throw error; fail('CORRECTION_APPLIED_INVALID', `config-named inputs unreadable: ${error instanceof Error ? error.message : String(error)}`); }
          }
          else fail('CORRECTION_APPLIED_INVALID', 'missing preview patch or checked session');
          if (record.outcome !== null && art.state !== 'applied-and-checked') fail('CORRECTION_APPLIED_INVALID', 'pending preview cannot claim completed outcome');
        }
      }
      if (record.outcome !== null) {
        let outcome: JsonObject;
        try { outcome = validateCorrectionIdentity(dir, project, record.outcome, String(record.stage), direction); } catch (e) { if (e instanceof CorrectionError && e.code === 'CORRECTION_SOURCE') fail('CORRECTION_OUTCOME', e.message); throw e; }
        const closure = record.closure;
        if (!isObject(closure) || !closed(closure, ['by', 'at', 'reasoning']) || closure.by !== 'agent' || !text(closure.reasoning) || !Number.isFinite(date(closure.at)) || date(closure.at) < date(record.at) || date(closure.at) > now || outcome.kind !== 'parts' && identityTime(project, outcome) < date(record.at) || identityTime(project, outcome) > date(closure.at) || !(direction && on.kind === 'post' && outcome.kind === 'post' ? (record.path === 'described' || sameHash(on.model,outcome.model)) && !sameHash(on.direction,outcome.direction) : changed(on, outcome)) || equal(on, outcome) || (on.kind === 'rig' || on.kind === 'post') && (outcome.kind !== on.kind || Number(outcome.n) <= Number(on.n)) || on.kind === 'draft' && outcome.kind === 'draft' && on.id === outcome.id) fail('CORRECTION_OUTCOME', 'outcome must be distinct/later/changed with one labelled agent closure');
        if (partImage && (outcome.kind !== 'draft' || !partImageResolvingDraft(project, record))) {
          fail('CORRECTION_OUTCOME', 'part-image outcome must be a later draft whose bound part file equals after');
        }
        if (record.path === 'made' && !legacyRead && on.kind === 'rig' && outcome.kind === 'rig') {
          const target = versionRecord(project, outcome.n); const { applied } = correctionApplied(dir, art);
          const origin = target.review_origin;
          if (!isObject(origin) || origin.source_version !== on.n || !equal(origin.applied, applied) || !isObject(art.feedback) || !equal(origin.feedback, art.feedback.file) || origin.feedback_id !== art.feedback.item_id) fail('CORRECTION_OUTCOME', 'result version must preserve the same review_origin');
        }
      } else if (record.closure !== undefined) fail('CORRECTION_MALFORMED', 'open record cannot carry closure');
      const replacement = bindings(project.corrections).some(r => r.resolves === record.id && r.verdict !== 'withdrawn' && (r.outcome !== null || partImageResolvingDraft(project, r) !== null) && correctionIsLive(project, r));
      if (record.verdict === 'withdrawn') {
        // Withdrawn corrections impose no open/pending obligations; checkUnrecordedPartRepaints refuses drafts that still bind their after bytes.
      } else if (partImage) {
        const resolving = partImageResolvingDraft(project, record);
        if (!resolving && correctionIsLive(project, record) && !replacement) {
          const laterDraftExists = bindings(project.drafts).some(d => d.id !== art.draft && Number.isFinite(date(d.at)) && date(d.at) >= date(record.at));
          if (laterDraftExists) fail('CORRECTION_PENDING', 'open part-image correction has no resolving draft binding its after bytes');
          warnings.push(correctionFinding('CORRECTION_OPEN', path, 'part-image correction awaits its resolving draft'));
        }
      } else if (record.outcome === null && correctionIsLive(project, record) && !replacement) {
        warnings.push(correctionFinding(art.kind === 'unsupported' ? 'CORRECTION_UNSUPPORTED' : 'CORRECTION_OPEN', path, art.kind === 'unsupported' ? 'operation has no checked adapter' : 'correction awaits its outcome'));
      }
    } catch (e) {
      if (!(e instanceof CorrectionError)) throw e;
      refusals.push(correctionFinding(e.code, path, e.message));
    }
  }
  checkUnrecordedPartRepaints(dir, project, refusals);
  const reopens = collectReopens(project, []);
  for (const signoff of collectSignoffs(project, []).filter(s => s.checkpoint === null && liveSignoff(reopens, s.stage, s.at))) {
    if (!CORRECTION_STAGES.includes(signoff.stage) || !isObject(contract) || signoff.at <= date(contract.adopted_at)) continue;
    refusals.push(...correctionApprovalFindings(project, signoff.stage, signoff.record));
  }
  for (const version of bindings(project.versions)) for (const verdict of bindings(version.verdicts)) {
    if (verdict.verdict === 'accepted' && CORRECTION_STAGES.includes(String(verdict.review)) && liveSignoff(reopens, String(verdict.review), date(verdict.at)) && isObject(contract) && date(verdict.at) > date(contract.adopted_at)) refusals.push(...correctionApprovalFindings(project, String(verdict.review), verdict));
  }
  // Accepted verdicts and downstream stages also cannot use an unresolved current correction.
  const amendments = collectAmendments(project, []);
  for (const stage of CORRECTION_STAGES) {
    const accepted = bindings(project.versions).some(v => bindings(v.verdicts).some(d => d.review === stage && d.verdict === 'accepted' && date(d.at) > date(isObject(contract) ? contract.adopted_at : undefined) && liveSignoff(reopens, stage, date(d.at))));
    const awaitsReapproval = amendments.some(a => stageIndex(a.stage) <= stageIndex(stage))
      && !collectSignoffs(project, []).some(s => s.stage === stage && s.checkpoint === null && liveSignoff(reopens, stage, s.at));
    if (accepted || (stageIndex(String(project.stage)) > stageIndex(stage) && !awaitsReapproval)) {
      for (const f of correctionApprovalFindings(project, stage)) if (!refusals.some(x => x.code === f.code && x.path === f.path)) refusals.push(f);
    }
  }
}
