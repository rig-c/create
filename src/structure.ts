/** Human-approved structure declarations, without applying producer patches or measuring meshes. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from './check-reads.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, collectItems, collectSignoffs, isObject, loadCollection, type Finding } from './check.ts';
import { draftFileUnavailable } from './drafts.ts';
import { IGNORED_DIRS } from './init.ts';
import { latestPartsVerdictStatus, recordedPartsVerdict } from './parts-verdict-record.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { hasStageOrder, interviewStageOfGuide, stageIndex } from './stages.ts';
import type { Json, JsonObject } from './templates.ts';

export const STRUCTURE_SCHEMA = 'rig-create/structure-decisions@0';
const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const add = (out: Finding[], code: string, path: string, why: string, missingPartsApproval = false): void => {
  const remedy = missingPartsApproval
    ? 'no live parts-review approval is recorded in signoffs[stage=parts-review]; advance through parts to parts-review, retain the draft structure decisions with structure-snapshot, publish the labelled draft with job open --draft <id>, and record the approval with parts-review --from-review <actId> (or signoff parts-review)'
    : 'review the labelled draft, retain its exact structure decisions, and sign again';
  out.push({ code, path, message: `${path}: ${why}; ${remedy}` });
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

export function partsApprovalIdentity(review: JsonObject): { signoff_at: string; evidence: JsonObject } | undefined {
  if (typeof review.at !== 'string' || !Number.isFinite(Date.parse(review.at)) || !isObject(review.evidence)) return undefined;
  return { signoff_at: review.at, evidence: review.evidence };
}

function partsApprovalCandidates(project: JsonObject) {
  return collectSignoffs(project, [])
    .filter(s => s.stage === 'parts-review' && s.checkpoint === null && Number.isFinite(s.at))
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
    add(errors, 'STRUCTURE_DECISIONS_MISSING', path, 'parts approval needs --draft and --structure-file, with explicit entries:[] when unchanged'); return null;
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

/** Resolve shared context outside the answer union, ready for later choice-answer schemas. */
export function riggingContext(dir: string, project: JsonObject, at: string, errors: Finding[]): JsonObject | null {
  const review = latestPartsApproval(project);
  if (review === undefined || typeof review.at !== 'string' || !Number.isFinite(Date.parse(review.at)) || !isObject(review.evidence) || !(Date.parse(at) >= Date.parse(review.at))) {
    add(errors, 'RIGGING_INTERVIEW_CONTEXT', 'interview.rigging_context', 'a live dated parts review must precede the rigging interview', review === undefined); return null;
  }
  if (checkStructure(dir, project, review, 'signoffs[parts-review]', errors) === null) return null;
  for (const item of collectItems(project, { collection: loadCollection(dir) })) {
    if (interviewStageOfGuide(item.id, item.kind === 'post', true) !== 'rigging-interview' || item.state.state === 'silent') continue;
    const state = item.state;
    if (state.state !== 'user' && state.state !== 'delegated') continue;
    const when = typeof state.answer.at === 'string' ? Date.parse(state.answer.at) : NaN;
    if (!Number.isFinite(when) || when < Date.parse(review.at) || when > Date.parse(at)) add(errors, 'RIG_GUIDE_BEFORE_PARTS', item.path, 'fresh rig guides must follow the accepted parts and precede their approval; preserve earlier answers as history');
  }
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
  const review = latestPartsApproval(project);
  if (review !== undefined && (hasStageOrder(project) || review.structure !== undefined)) checkStructure(dir, project, review, 'signoffs[parts-review]', errors);
  const ordered = hasStageOrder(project);
  const checkLegacyBuild = ordered && stageIndex(effectiveStage) >= stageIndex('rigging-interview');
  const interview = isObject(project.interview) ? project.interview : {};
  if (ordered && (!isObject(interview.order) || typeof interview.order.adopted_at !== 'string' || !Number.isFinite(Date.parse(interview.order.adopted_at)))) add(errors, 'RIGGING_INTERVIEW_CONTEXT', 'interview.order', 'order adoption needs a clock date');
  const reopens = collectReopens(project, []);
  const approvals = collectSignoffs(project, []).filter(s => ordered && s.stage === 'rigging-interview' && s.checkpoint === null && liveSignoff(reopens, s.stage, s.at));
  for (const approval of approvals.sort((a, b) => b.at - a.at || b.index - a.index).slice(0, 1)) {
    const context = riggingContext(dir, project, String(approval.record.at), errors);
    if (context !== null && (!isDeepStrictEqual(approval.record.accepted_parts, context.accepted_parts) || !isDeepStrictEqual(approval.record.structure, context.structure))) add(errors, 'RIGGING_INTERVIEW_CONTEXT', `signoffs[${approval.index}]`, 'approval does not bind the current parts review and structure');
  }
  if (checkLegacyBuild && review === undefined) add(errors, 'RIGGING_INTERVIEW_CONTEXT', 'interview.rigging_context', 'review parts before asking rigging questions', true);
  // Bind production config declarations, not geometry. Historical pre-adoption builds remain history.
  const adoptedAt = isObject(interview.order) ? Date.parse(String(interview.order.adopted_at)) : NaN;
  for (const version of asArray(project.versions)) {
    if (!isObject(version) || version.kind !== 'rig' || (version.accepted_parts === undefined && (!checkLegacyBuild || !(Date.parse(String(version.at)) >= adoptedAt)))) continue;
    const historicalReview = rigPartsApproval(project, version);
    if (historicalReview === undefined && version.accepted_parts !== undefined) continue; // Registration owns the invalid binding.
    if (historicalReview === undefined) { add(errors, 'RIGGING_INTERVIEW_CONTEXT', `versions[v${String(version.n)}]`, 'no parts structure approval was live when this rig was built', true); continue; }
    const snapshot = checkStructure(dir, project, historicalReview, `versions[v${String(version.n)}].structure`, errors);
    if (snapshot === null) continue;
    const provenance = isObject(version.provenance) ? version.provenance : {};
    if (!isObject(provenance.config)) continue; // Existing provenance reader owns absent configs.
    let config: JsonObject;
    try { config = retainedJson(dir, provenance.config); } catch { continue; }
    const delta = structureDelta(snapshot, config);
    const path = `versions[v${String(version.n)}].provenance`;
    if (delta.length > 0 && !acceptsStructureDelta(project, historicalReview, Date.parse(String(version.at)))) {
      errors.push({ code: 'STRUCTURE_DECISIONS_CONFLICT', path: `${path}.config`, message: `${path}.config: mesh/chest declaration overrides the person-approved structure; answer the rigging meshes guide and sign off rigging-interview, then rebuild the rig after that sign-off; or renew parts-review and rebuild` });
      continue;
    }
    if ((delta.length > 0 || provenance.structure_delta !== undefined) && !isDeepStrictEqual(provenance.structure_delta, delta)) {
      add(errors, 'STRUCTURE_DELTA_MISMATCH', `${path}.structure_delta`, 'recorded delta differs from the snapshot and retained version config; register the rig again');
      continue;
    }
    if (delta.length > 0) warnings.push({ code: 'STRUCTURE_DELTA_REVIEW', path: `${path}.structure_delta`, message: `${path}.structure_delta: ${delta.length} changed structure entries; the rig-review verdict and sign-off must cover changed structure` });
  }
}
