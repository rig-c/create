/** Human-approved structure declarations, without applying producer patches or measuring meshes. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, collectSignoffs, isObject, type Finding } from './check.ts';
import { currentFindings, currentHash, currentOutputSupersedesSignoff, currentShapeFindings, isRunRecordFile, sha256 } from './current.ts';
import { draftFileUnavailable } from './drafts.ts';
import { IGNORED_DIRS } from './init.ts';
import { ownerChatAuthorityFinding } from './owner-chat.ts';
import { latestPartsVerdictStatus, recordedPartsVerdict } from './parts-verdict-record.ts';
import { refuse, Refusal } from './refusal.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { validateRunRecord } from './run-record.ts';
import { hasStageOrder, stageIndex } from './stages.ts';
import { sorted } from './step-hash.ts';
import type { Json, JsonObject } from './templates.ts';

export const STRUCTURE_SCHEMA = 'rig-create/structure-decisions@0';
const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const add = (out: Finding[], code: string, path: string, why: string): void => {
  out.push({ code, path, message: `${path}: ${why}; review the labelled draft, retain its exact structure decisions, and sign again` });
};

export function retainedJson(dir: string, binding: Json | undefined): JsonObject {
  if (!isObject(binding) || typeof binding.path !== 'string' || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256) || isAbsolute(binding.path)) throw new Error('expected project-relative path and sha256');
  const file = realpathSync(resolve(dir, binding.path));
  const rel = relative(realpathSync(dir), file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('file escapes project');
  const bytes = readFileSync(file);
  if (hash(bytes) !== binding.sha256) throw new Error(`${binding.path}: bytes changed`);
  const json: Json = JSON.parse(bytes.toString('utf8'));
  if (!isObject(json)) throw new Error('expected an object');
  return json;
}

export function structurePathIsIgnored(dir: string, path: string): boolean {
  const ignored: readonly string[] = [...IGNORED_DIRS, 'node_modules', '.git'];
  return [relative(resolve(dir), resolve(dir, path)), relative(realpathSync(dir), realpathSync(resolve(dir, path)))]
    .some(rel => ignored.includes(rel.split(sep)[0] as string));
}

const PARTS_ROOT = 'outputs/parts';
const PARTS_RUN = `${PARTS_ROOT}/run.json`;
type Binding = { path: string; sha256: string };
type CurrentPartsTarget = { subject: 'current.parts'; record_sha256: string; files_sha256: string };
type CurrentPartsApproval = { index: number; at: number; signoff_at: string; target: CurrentPartsTarget; structure: Binding };
const digest = (value: Json | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function structureBinding(binding: Json | undefined): binding is Binding {
  return isObject(binding) && Object.keys(binding).length === 2 && digest(binding.sha256) && typeof binding.path === 'string'
    && !/[\\:\0]/.test(binding.path) && binding.path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function hasCurrentParts(project: JsonObject): boolean {
  return isObject(project.current) && Object.hasOwn(project.current, 'parts');
}

/** The same target identity as other current subjects: sorted record JSON and the product-set hash. */
export function currentPartsTarget(parts: JsonObject): CurrentPartsTarget {
  if (!digest(parts.files_sha256)) throw Error('current.parts.files_sha256 is malformed');
  return { subject: 'current.parts', record_sha256: sha256(JSON.stringify(sorted(parts))), files_sha256: parts.files_sha256 };
}

/** --config may name a byte-identical copy of the producer's path. Resolve by the recorded digest. */
function currentPartsConfig(parts: JsonObject, producer: JsonObject): Binding {
  const digest = isObject(producer.config) ? producer.config.sha256 : undefined;
  const inputs = asArray(parts.built_from).filter(isObject);
  const matches = inputs.filter(entry => entry.sha256 === digest);
  const match = matches[0];
  if (matches.length !== 1 || typeof digest !== 'string' || typeof match?.path !== 'string'
    || inputs.filter(entry => entry.path === match.path).length !== 1) {
    throw Error('current.parts.built_from: expected one unambiguous binding for the producer config digest');
  }
  return { path: match.path, sha256: digest };
}

function currentPartsBytes(dir: string, binding: Binding): Buffer {
  const file = resolve(dir, binding.path);
  if (realpathSync(file) !== resolve(realpathSync(dir), binding.path) || !lstatSync(file).isFile()) {
    throw Error(`${binding.path}: expected a literal regular file in the project`);
  }
  const bytes = readFileSync(file);
  if (hash(bytes) !== binding.sha256) throw Error(`${binding.path}: bytes differ from the retained sha256`);
  return bytes;
}

function invalidCurrentParts(error: unknown): never {
  const why = error instanceof Error ? error.message : String(error);
  return refuse('STRUCTURE_DECISIONS_INVALID', `project.json.current.parts: ${why}. Restore the exact recorded parts and producer config or assemble and record parts again.`);
}

function readCurrentPartsSubject(dir: string, project: JsonObject) {
  const parts = isObject(project.current) ? project.current.parts : undefined;
  try {
    const shape = currentShapeFindings('parts', parts, project)[0];
    if (shape) throw Error(`${shape.path} is malformed`);
    if (!isObject(parts) || parts.adopted !== undefined) throw Error('expected a producer-backed current parts record');
    const target = currentPartsTarget(parts);
    if (realpathSync(resolve(dir, PARTS_ROOT)) !== resolve(realpathSync(dir), PARTS_ROOT)
      || currentHash(dir, PARTS_ROOT) !== target.files_sha256) {
      throw Error(`${PARTS_ROOT} differs from the recorded output-set hash`);
    }
    return { parts, target };
  } catch (error) { return invalidCurrentParts(error); }
}

function readCurrentPartsSource(dir: string, project: JsonObject, { parts, target }: ReturnType<typeof readCurrentPartsSubject>, at: number) {
  try {
    if (!isObject(parts.run) || parts.run.path !== PARTS_RUN || !digest(parts.run.sha256) || !(Date.parse(String(parts.at)) <= at)) {
      throw Error('expected a current parts record with its assemble run available at the requested time');
    }
    const run = { path: PARTS_RUN, sha256: parts.run.sha256 };
    const { record } = validateRunRecord(currentPartsBytes(dir, run), run.path, { specs: ['rig-run/1'], allowAssembleInputs: true });
    if (record.command !== 'assemble' || !Array.isArray(record.inputs)) throw Error(`${run.path}: expected an assemble run with its inputs`);
    const config = currentPartsConfig(parts, record);
    const configValue: unknown = JSON.parse(currentPartsBytes(dir, config).toString('utf8'));
    if (configValue === null || typeof configValue !== 'object' || Array.isArray(configValue)) throw Error(`${config.path}: expected a config object`);
    const warnings: Finding[] = [];
    currentFindings(dir, project, warnings);
    const stale = warnings.find(finding => finding.path === 'current.parts' && finding.code === 'OUTPUT_STALE');
    if (stale) throw Error(stale.message);
    const files = asArray(parts.files).filter(isObject).filter(file => !isRunRecordFile(String(file.path)))
      .map(file => ({ path: String(file.path), sha256: String(file.sha256) }));
    return { target, run, config, configValue: configValue as JsonObject, parts: { path: `${PARTS_ROOT}/rig`, files } };
  } catch (error) { return invalidCurrentParts(error); }
}

/** Resolve the live product and the exact config sealed by its recorded assemble run. */
export function readCurrentPartsContext(dir: string, project: JsonObject, at = Infinity) {
  return readCurrentPartsSource(dir, project, readCurrentPartsSubject(dir, project), at);
}

export function currentPartsStructureSnapshot(parts: ReturnType<typeof readCurrentPartsContext>): JsonObject {
  const { target, run, config, configValue } = parts;
  const meshes = configValue.meshes;
  if (meshes !== undefined && (!isObject(meshes) || Object.hasOwn(meshes, ''))) {
    refuse('STRUCTURE_DECISIONS_INVALID', `${config.path}.meshes: expected an object of named mesh declarations. Record a valid producer config and retain its structure snapshot.`);
  }
  const entries = Object.entries(meshes ?? {}).map(([part, value]) => ({
    path: `/meshes/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`, value,
  }));
  return { schema: STRUCTURE_SCHEMA, target, run, config, entries };
}

function claimsCurrentParts(record: JsonObject): boolean {
  return isObject(record.target) && record.target.subject === 'current.parts';
}

/** Resolve owner authority at a clock instant, independent of the mutable output tree. */
export function currentPartsApproval(project: JsonObject, at = Infinity): CurrentPartsApproval | undefined {
  const cutoffs = collectReopens(project, []).filter(reopen => reopen.at <= at);
  const approval = collectSignoffs(project, []).filter(signoff => signoff.stage === 'parts-review' && signoff.record.checkpoint === null
    && Number.isFinite(signoff.at) && signoff.at <= at && liveSignoff(cutoffs, signoff.stage, signoff.at) && claimsCurrentParts(signoff.record))
    .sort((a, b) => b.at - a.at || b.index - a.index)[0];
  if (!approval) return;
  const { target, structure, verbatim, draft_id, evidence } = approval.record;
  if (draft_id !== undefined || evidence !== undefined || !isObject(target) || Object.keys(target).length !== 3
    || target.subject !== 'current.parts' || !digest(target.record_sha256) || !digest(target.files_sha256) || !structureBinding(structure)
    || ownerChatAuthorityFinding(approval.record, `signoffs[${approval.index}]`, verbatim)) return;
  return { index: approval.index, at: approval.at, signoff_at: String(approval.record.at),
    target: { subject: 'current.parts', record_sha256: target.record_sha256, files_sha256: target.files_sha256 }, structure };
}

export function retainedCurrentPartsStructure(dir: string, binding: Json | undefined): JsonObject {
  try {
    if (!structureBinding(binding) || structurePathIsIgnored(dir, binding.path)) throw Error('expected a retained project-relative snapshot path and sha256');
    const snapshot = JSON.parse(currentPartsBytes(dir, binding).toString('utf8')) as Json;
    if (!isObject(snapshot) || snapshot.schema !== STRUCTURE_SCHEMA || Object.keys(snapshot).length !== 5 || !Array.isArray(snapshot.entries)) throw Error('expected a current parts structure snapshot');
    return snapshot;
  } catch (error) {
    refuse('STRUCTURE_DECISIONS_INVALID', `project.json.signoffs[parts-review].structure: ${error instanceof Error ? error.message : String(error)}. Retain the exact current parts structure snapshot.`);
  }
}

function assertPartsSnapshot(dir: string, binding: Json | undefined, source: ReturnType<typeof readCurrentPartsContext>): void {
  if (!isDeepStrictEqual(retainedCurrentPartsStructure(dir, binding), currentPartsStructureSnapshot(source))) {
    refuse('STRUCTURE_DECISIONS_INVALID', 'project.json.signoffs[parts-review].structure: snapshot differs from the current parts target, run, config or declarations. Retain the exact current parts structure snapshot.');
  }
}

/** Validate the retained bytes a signoff will bind, using the same source as the option reader. */
export function assertCurrentPartsStructure(dir: string, project: JsonObject, binding: Json | undefined, at = Infinity): void {
  assertPartsSnapshot(dir, binding, readCurrentPartsContext(dir, project, at));
}

export function currentPartsReviewContext(dir: string, project: JsonObject, at: number) {
  const approval = currentPartsApproval(project, at);
  const subject = readCurrentPartsSubject(dir, project);
  const { target } = subject;
  if (approval && currentOutputSupersedesSignoff(project, 'parts', approval.at)) return null;
  if (approval && (approval.at < Date.parse(String(subject.parts.at)) || !isDeepStrictEqual(approval.target, target))) {
    refuse('SIGNOFF_TARGET_STALE', `signoffs[${approval.index}].target: approval binds a different current.parts. Relay approval for the current output.`);
  }
  const source = readCurrentPartsSource(dir, project, subject, at);
  if (!approval) return null;
  const { signoff_at, structure } = approval;
  assertPartsSnapshot(dir, structure, source);
  return { target, signoff_at, structure, run: source.run, config: source.config, parts: source.parts };
}

function checkCurrentPartsReviewContext(dir: string, project: JsonObject, at: number, errors: Finding[]): JsonObject | null {
  try {
    const review = currentPartsReviewContext(dir, project, at);
    return review === null ? null : { accepted_parts: { signoff_at: review.signoff_at, target: review.target }, structure: review.structure };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    errors.push({ code: error.code, path: 'current.parts', message: error.message });
    return null;
  }
}

export function partsApprovalIdentity(review: JsonObject): { signoff_at: string; evidence: JsonObject } | undefined {
  if (typeof review.at !== 'string' || !Number.isFinite(Date.parse(review.at)) || !isObject(review.evidence)) return undefined;
  return { signoff_at: review.at, evidence: review.evidence };
}

function partsApprovalCandidates(project: JsonObject) {
  return collectSignoffs(project, [])
    .filter(s => s.stage === 'parts-review' && s.checkpoint === null && Number.isFinite(s.at) && !claimsCurrentParts(s.record))
    .sort((a, b) => b.at - a.at || b.index - a.index);
}

export function latestPartsApproval(project: JsonObject, at = Infinity, identity?: Json, draftId?: string): JsonObject | undefined {
  const reopens = collectReopens(project, []).filter(r => r.at <= at);
  const signoffs = partsApprovalCandidates(project).filter(s => s.at <= at && liveSignoff(reopens, s.stage, s.at)
    && (draftId === undefined || s.record.draft_id === draftId));
  if (identity !== undefined) {
    const matches = signoffs.filter(s => isDeepStrictEqual(partsApprovalIdentity(s.record), identity));
    return matches.length === 1 ? matches[0]?.record : undefined;
  }
  return signoffs[0]?.record;
}

/** An explicit identity must resolve at registration, even after a later reopen. */
export function rigPartsApproval(project: JsonObject, version: JsonObject, legacyAt = Date.parse(String(version.at))): JsonObject | undefined {
  if (version.accepted_parts === undefined) return latestPartsApproval(project, legacyAt);
  const at = isObject(version.registration) ? Date.parse(String(version.registration.at)) : NaN;
  return latestPartsApproval(project, at, version.accepted_parts);
}

/** A reopen lapses the live approval but leaves its comparison subject in history. */
export function previousPartsApproval(dir: string, project: JsonObject, currentDraftId: string): JsonObject | undefined {
  for (const { record } of partsApprovalCandidates(project)) {
    if (record.checkpoint !== null) continue;
    const draftId = record.draft_id;
    const identity = partsApprovalIdentity(record);
    if (typeof draftId !== 'string' || draftId === currentDraftId || identity === undefined
      || latestPartsVerdictStatus(project, draftId) !== 'approved') continue;
    try {
      recordedPartsVerdict(dir, project, draftId, identity.evidence, { requireAvailable: false });
      return record;
    } catch {
      // This signature has no verifiable approved receipt.
    }
  }
  return undefined;
}

export function checkStructure(dir: string, project: JsonObject, signoff: JsonObject, path: string, errors: Finding[]): JsonObject | null {
  if (signoff.structure === undefined || signoff.draft_id === undefined) {
    add(errors, 'STRUCTURE_DECISIONS_MISSING', path, 'numbered parts approvals are read-only and require recorded draft_id and structure bindings; restore those fields or sign current.parts with rig-create structure-snapshot and rig-create signoff parts-review --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>'); return null;
  }
  let snapshot: JsonObject;
  try { snapshot = retainedJson(dir, signoff.structure); } catch (error) { add(errors, 'STRUCTURE_DECISIONS_INVALID', `${path}.structure`, error instanceof Error ? error.message : String(error)); return null; }
  return validateStructureSnapshot(dir, project, signoff.draft_id, snapshot, `${path}.structure`, errors);
}

/**
 * The rules a structure snapshot meets, shared by the check and the
 * structure-snapshot writer: it binds the named draft and its config, and
 * every entry is a distinct exact `meshes.<part>` declaration of that config
 * when the config is available. `at` is the path findings name.
 */
export function validateStructureSnapshot(dir: string, project: JsonObject, draftId: Json | undefined, snapshot: JsonObject, at: string, errors: Finding[]): JsonObject | null {
  try {
    const draft = asArray(project.drafts).find(d => isObject(d) && d.id === draftId);
    if (!isObject(draft) || snapshot.schema !== STRUCTURE_SCHEMA || snapshot.draft_id !== draft.id || !isDeepStrictEqual(snapshot.config, draft.config) || !Array.isArray(snapshot.entries)) throw new Error('snapshot must bind the named draft and its config');
    if (!isObject(draft.config) || typeof draft.config.path !== 'string') throw new Error('draft config binding is malformed');
    const config = draftFileUnavailable(dir, draft.config.path, `derived/drafts/${String(draft.id)}`)
      ? undefined : retainedJson(dir, snapshot.config);
    const seen = new Set<string>();
    for (const raw of snapshot.entries) {
      if (!isObject(raw) || typeof raw.path !== 'string' || !/^\/meshes\/(?:[^~/]|~[01])+$/.test(raw.path) || seen.has(raw.path) || !('value' in raw)) throw new Error('entries require distinct complete /meshes/<part> declarations');
      seen.add(raw.path);
      const part = raw.path.slice('/meshes/'.length).replaceAll('~1', '/').replaceAll('~0', '~');
      if (config !== undefined && (!isObject(config.meshes) || !isDeepStrictEqual(config.meshes[part], raw.value))) {
        add(errors, 'STRUCTURE_DECISIONS_CONFLICT', at, `${raw.path} differs from the reviewed config`); return null;
      }
    }
    return snapshot;
  } catch (error) { add(errors, 'STRUCTURE_DECISIONS_INVALID', at, error instanceof Error ? error.message : String(error)); return null; }
}

/** Resolve shared context outside the answer union, ready for later choice-answer schemas. No parts approval is required (#981): without one the context is null. */
export function riggingContext(dir: string, project: JsonObject, at: string, errors: Finding[]): JsonObject | null {
  if (hasCurrentParts(project)) return checkCurrentPartsReviewContext(dir, project, Date.parse(at), errors);
  const review = latestPartsApproval(project);
  if (review === undefined || typeof review.at !== 'string' || !Number.isFinite(Date.parse(review.at)) || !isObject(review.evidence) || !(Date.parse(at) >= Date.parse(review.at))) return null;
  if (checkStructure(dir, project, review, 'signoffs[parts-review]', errors) === null) return null;
  return { accepted_parts: partsApprovalIdentity(review)!, structure: review.structure as Json };
}

/** The meshes answer must be covered by a live later interview approval at build time. */
export function acceptsStructureDelta(project: JsonObject, review: JsonObject, at = Infinity): boolean {
  const partsAt = Date.parse(String(review.at));
  const interview = isObject(project.interview) ? project.interview : {};
  const meshes = asArray(interview.waypoints).find(w => isObject(w) && w.id === 'meshes');
  // Renewed guides must not move the approval gate for retained builds.
  const guideAt = isObject(meshes)
    ? [meshes.guide, ...asArray(meshes.history)].filter(isObject)
      .map(guide => Date.parse(String(guide.at))).filter(when => when <= at)
      .sort((a, b) => b - a)[0] ?? NaN
    : NaN;
  const reopens = collectReopens(project, []).filter(r => r.at <= at);
  return guideAt > partsAt && collectSignoffs(project, []).some(s =>
    s.stage === 'rigging-interview' && s.record.checkpoint === null && s.at > partsAt
    && s.at <= at && guideAt <= s.at && liveSignoff(reopens, s.stage, s.at));
}

/** Snapshot order is retained; null denotes a declaration absent from the version. */
export function structureDelta(snapshot: JsonObject, config: JsonObject): JsonObject[] {
  return asArray(snapshot.entries).flatMap(entry => {
    if (!isObject(entry) || typeof entry.path !== 'string') return [];
    const part = entry.path.slice('/meshes/'.length).replaceAll('~1', '/').replaceAll('~0', '~');
    const value = isObject(config.meshes) ? config.meshes[part] : undefined;
    return isDeepStrictEqual(value, entry.value) ? [] : [{ entry: entry.path, snapshot: entry.value!, version: value ?? null }];
  });
}

/** Writer and checker share the approval gate and exact file-derived delta. */
export function approvedStructureDelta(dir: string, project: JsonObject, version: JsonObject, config: JsonObject): JsonObject[] {
  const at = Date.parse(String(version.at));
  const interview = isObject(project.interview) ? project.interview : {};
  const adoptedAt = isObject(interview.order) ? Date.parse(String(interview.order.adopted_at)) : NaN;
  if (version.accepted_parts === undefined && (!(at >= adoptedAt) || !hasStageOrder(project))) return [];
  const review = rigPartsApproval(project, version);
  if (review === undefined) return [];
  const errors: Finding[] = [];
  const snapshot = checkStructure(dir, project, review, 'signoffs[parts-review]', errors);
  return snapshot === null || !acceptsStructureDelta(project, review, at) ? [] : structureDelta(snapshot, config);
}

export function checkRiggingContext(dir: string, project: JsonObject, effectiveStage: string, errors: Finding[], warnings: Finding[] = []): void {
  // checkSignoffTarget checks the active current approval and its structure after the target matches.
  if (!hasCurrentParts(project)) {
    const review = latestPartsApproval(project);
    if (review !== undefined && (hasStageOrder(project) || review.structure !== undefined)) checkStructure(dir, project, review, 'signoffs[parts-review]', errors);
  }
  const ordered = hasStageOrder(project);
  const checkLegacyBuild = ordered && stageIndex(effectiveStage) >= stageIndex('rigging-interview');
  const interview = isObject(project.interview) ? project.interview : {};
  if (ordered && (!isObject(interview.order) || typeof interview.order.adopted_at !== 'string' || !Number.isFinite(Date.parse(interview.order.adopted_at)))) add(errors, 'RIGGING_INTERVIEW_CONTEXT', 'interview.order', 'order adoption needs a clock date');
  // Bind production config declarations, not geometry. Historical pre-adoption builds remain history.
  const adoptedAt = isObject(interview.order) ? Date.parse(String(interview.order.adopted_at)) : NaN;
  for (const version of asArray(project.versions)) {
    if (!isObject(version) || version.kind !== 'rig' || (version.accepted_parts === undefined && (!checkLegacyBuild || !(Date.parse(String(version.at)) >= adoptedAt)))) continue;
    const historicalReview = rigPartsApproval(project, version);
    // Registration owns an invalid binding; a rig may also be built without a parts approval (#981).
    if (historicalReview === undefined) continue;
    const snapshot = checkStructure(dir, project, historicalReview, `versions[v${String(version.n)}].structure`, errors);
    if (snapshot === null) continue;
    const provenance = isObject(version.provenance) ? version.provenance : {};
    if (!isObject(provenance.config)) continue; // Existing provenance reader owns absent configs.
    let config: JsonObject;
    try { config = retainedJson(dir, provenance.config); } catch { continue; }
    const delta = structureDelta(snapshot, config);
    const path = `versions[v${String(version.n)}].provenance`;
    // A structure change not covered by a later rigging-interview signoff is recorded by no delta (#981).
    if (delta.length > 0 && !acceptsStructureDelta(project, historicalReview, Date.parse(String(version.at)))) continue;
    if ((delta.length > 0 || provenance.structure_delta !== undefined) && !isDeepStrictEqual(provenance.structure_delta, delta)) {
      add(errors, 'STRUCTURE_DELTA_MISMATCH', `${path}.structure_delta`, 'recorded delta differs from the snapshot and retained version config; register the rig again');
      continue;
    }
    if (delta.length > 0) warnings.push({ code: 'STRUCTURE_DELTA_REVIEW', path: `${path}.structure_delta`, message: `${path}.structure_delta: ${delta.length} changed structure entries; the rig-review verdict and sign-off must cover changed structure` });
  }
}
