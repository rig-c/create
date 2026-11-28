import { acceptedReviewVerdict, readVersions } from './review.ts';
import { checkFigureMask } from './figure-mask.ts';
/** Review signatures bind a current output or a numbered review and its retained inputs. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { asArray, collectSignoffs, isObject, type Finding } from './check.ts';
import { currentHash, currentShapeFindings, outputRoot, sha256 } from './current.ts';
import { directionBinding } from './direction.ts';
import { assembleOnlyDraftTarget, assembleOnlyVersionFinding, assertDraftHasRig, draftRigRequired, isAssembleOnlyDraft } from './draft-layout.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { checkReviewPackages } from './review-package.ts';
import { ownerChatAuthorityFinding } from './owner-chat.ts';
import { refuse, Refusal, USAGE_EXIT } from './refusal.ts';
import { SIGNOFF_TARGET_KINDS } from './review-act.ts';
import { sorted } from './step-hash.ts';
import { signoffPairFinding } from './signoff-pair.ts';
import { assertCurrentPartsStructure } from './structure.ts';
import type { Json, JsonObject } from './templates.ts';

export const SIGNOFF_TARGET_SINCE = '2026-11-06T00:00:00Z';

export function outputsHash(outputs: Json[]): string {
  return createHash('sha256').update(JSON.stringify(sorted(outputs))).digest('hex');
}

export function reviewPackageHash(record: JsonObject): string {
  return createHash('sha256').update(JSON.stringify(sorted({ config: record.config, files: record.files }))).digest('hex');
}

const isSha256 = (value: Json | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validBinding(value: Json | undefined): value is JsonObject {
  return isObject(value) && typeof value.path === 'string' && value.path.length > 0 && isSha256(value.sha256);
}

type CurrentTargetKind = 'parts' | 'rig' | 'direction';

export function signoffTargetFormat(target: Json | undefined): 'current' | 'numbered' | 'mixed' | undefined {
  if (!isObject(target)) return;
  const numbered = 'version' in target || 'verdict' in target;
  if ('subject' in target || 'record_sha256' in target || 'files_sha256' in target) return numbered ? 'mixed' : 'current';
  if (numbered) return 'numbered';
}

/** Parts receipts are historical evidence unless the signature explicitly selects current.parts. */
export function isCurrentPartsSignoff(signoff: JsonObject): boolean {
  return signoff.stage === 'parts-review' && isObject(signoff.target) && signoff.target.subject === 'current.parts';
}

function currentTargetFor(dir: string, project: JsonObject, kind: CurrentTargetKind, signedAt?: number) {
  const subject = `current.${kind}` as const;
  if (!isObject(project.current)) throw Error('current is missing or malformed');
  const node = project.current[kind];
  if (node === undefined) throw Error(`${subject} is missing`);
  const problem = currentShapeFindings(kind, node)[0];
  if (problem) throw Error(`${problem.path} is malformed`);
  if (!isObject(node) || !isSha256(node.files_sha256)) throw Error(`${subject}.files_sha256 is malformed`);
  if (signedAt !== undefined && !(Date.parse(String(node.at)) <= signedAt)) throw Error(`${subject} was recorded after the signing time or the signing time is invalid`);
  const root = outputRoot(kind);
  if (currentHash(dir, root) !== node.files_sha256) throw Error(`${root} is missing or differs from ${subject}.files_sha256`);
  return { subject, record_sha256: sha256(JSON.stringify(sorted(node))), files_sha256: node.files_sha256 };
}

function currentRemedy(kind: CurrentTargetKind, stage: string): string {
  return `restore the reviewed current.${kind} record and its outputs or record them with rig-create record ${kind}, then sign ${stage} again`;
}

function targetFor(dir: string, project: JsonObject, stage: string, version: JsonObject, index: number, verdict: number): JsonObject {
  const target: JsonObject = { version: version.n, verdict: `versions[${index}].verdicts[${verdict}]` };
  if (stage === 'rig-review' && version.pre_interview === true) {
    if (version.outputs_lost !== undefined) throw Error('outputs lost: nothing to bind');
    if (!Array.isArray(version.outputs) || version.outputs.length === 0) throw Error('outputs missing: nothing to bind');
    target.outputs = { path: `versions[${index}].outputs`, sha256: outputsHash(version.outputs) };
  } else if (stage === 'rig-review') {
    if (!isObject(version.review_package) || !isObject(version.review_package.config) || !Array.isArray(version.review_package.files)) throw Error('review_package missing or malformed');
    target.review_package = { path: `versions[${index}].review_package`, sha256: reviewPackageHash(version.review_package) };
  } else {
    const provenance = isObject(version.provenance) ? version.provenance : {};
    if (project.direction_contract !== undefined && provenance.direction !== undefined) {
      if (!validBinding(provenance.direction)) throw Error('direction binding missing or malformed');
      const actual = directionBinding(dir, provenance.direction.path as string);
      if (!isDeepStrictEqual(actual, provenance.direction)) throw Error('direction file hash differs from recorded binding');
      target.direction = actual;
    } else {
      if (!validBinding(provenance.config)) throw Error('post config binding missing or malformed');
      target.post_config = provenance.config;
    }
  }
  return target;
}

/** Same resolution is used by the reader and by the writer before its commit point. */
export function checkSignoffTarget(dir: string, project: JsonObject, signoff: JsonObject, path: string, refusals: Finding[], warnings: Finding[]): void {
  const stage = String(signoff.stage);
  const target = signoff.target;
  const format = signoffTargetFormat(target);
  const currentParts = stage === 'parts-review' && (format === 'current' || format === 'mixed');
  if (!currentParts && !(stage in SIGNOFF_TARGET_KINDS)) return;
  const current = format === 'current' || format === 'mixed' || (format === undefined && project.current !== undefined);
  const kind = currentParts ? 'parts' : SIGNOFF_TARGET_KINDS[stage] === 'rig' ? 'rig' : 'direction';
  if (!currentParts) {
    const draft = asArray(project.drafts).filter(isObject).find(d => d.id === signoff.draft_id)
      ?? assembleOnlyDraftTarget(project, !current && isObject(target) ? target.version : undefined);
    if (isAssembleOnlyDraft(draft)) {
      refusals.push(draftRigRequired(`${path}.target`, draft?.id));
      return;
    }
  }
  const missing = target === undefined || target === null;
  let reason = missing ? 'target missing' : '';
  if (!missing && current) {
    try {
      if (!isObject(target) || target.subject !== `current.${kind}` || Object.keys(target).length !== 3
        || !isSha256(target.record_sha256) || !isSha256(target.files_sha256)) {
        throw Error(`expected subject current.${kind}, record_sha256 and files_sha256`);
      }
      if (currentParts && (signoff.draft_id !== undefined || signoff.evidence !== undefined || signoff.checkpoint !== null)) {
        throw Error('current.parts needs a stage signature without a draft, verdict receipt or checkpoint');
      }
      const expected = currentTargetFor(dir, project, kind, currentParts ? Date.parse(String(signoff.at)) : undefined);
      if (target.record_sha256 !== expected.record_sha256) throw Error(`current.${kind} record changed since signing`);
      if (target.files_sha256 !== expected.files_sha256) throw Error(`current.${kind} output hash differs from the signed target`);
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  } else if (!missing) {
    try {
      if (!isObject(target) || !Number.isSafeInteger(target.version) || Number(target.version) < 1) throw Error('target version missing or malformed');
      const versions = asArray(project.versions);
      const matches = versions.map((v, i) => ({ v, i })).filter(({ v }) => isObject(v) && v.n === target.version);
      if (matches.length !== 1) throw Error('target version does not exist uniquely');
      const { v, i } = matches[0] as { v: JsonObject; i: number };
      const draftProblem = assembleOnlyVersionFinding(dir, project, v, `${path}.target`);
      if (draftProblem) {
        refusals.push(draftProblem);
        return;
      }
      if (v.kind !== SIGNOFF_TARGET_KINDS[stage]) throw Error('target version belongs to another stage kind');
      const match = typeof target.verdict === 'string' ? /^versions\[(\d+)\]\.verdicts\[(\d+)\]$/.exec(target.verdict) : null;
      if (!match || Number(match[1]) !== i) throw Error('verdict path does not resolve to the target version');
      const verdictIndex = Number(match[2]);
      const verdict = asArray(v.verdicts)[verdictIndex];
      if (!isObject(verdict) || verdictIndex !== acceptedReviewVerdict(v, stage)) throw Error('named verdict is missing, not accepted or belongs to another review stage');
      const expected = targetFor(dir, project, stage, v, i, verdictIndex);
      if (!isDeepStrictEqual(target, expected)) throw Error(expected.outputs ? 'outputs changed since signing' : stage === 'rig-review' ? 'review_package changed since signing' : expected.direction ? 'direction changed since signing' : 'post config changed since signing');
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  }
  if (!reason) {
    if (currentParts) {
      const authority = ownerChatAuthorityFinding(signoff, path, signoff.verbatim);
      // The generic owner-chat scan already reports malformed relay fields.
      if (authority?.code === 'OWNER_CHAT_REQUIRED') refusals.push(authority);
      checkCurrentPartsStructure(dir, project, signoff, path, refusals);
      return;
    }
    const pair = current ? undefined : signoffPairFinding(project, signoff, path);
    if (pair) (pair.code.endsWith('_LEGACY') ? warnings : refusals).push(pair);
    return;
  }
  const legacy = Date.parse(String(signoff.at)) < Date.parse(SIGNOFF_TARGET_SINCE);
  const code = `SIGNOFF_TARGET_${missing ? 'MISSING' : 'STALE'}${legacy ? '_LEGACY' : ''}`;
  const at = `${path}.target`;
  const remedy = current ? currentRemedy(kind, stage) : `numbered ${stage} signatures are read-only — restore the signed target and reviewed inputs, or record current.${kind} with rig-create record ${kind} and relay owner chat sign-off with rig-create signoff ${stage} --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`;
  (legacy ? warnings : refusals).push({ code, path: at, message: `${at}: ${reason}; ${remedy}` });
}

function checkCurrentPartsStructure(dir: string, project: JsonObject, signoff: JsonObject, path: string, refusals: Finding[]): void {
  const at = `${path}.structure`;
  const remedy = 'run structure-snapshot on the current parts and relay the owner approval again';
  const binding = signoff.structure;
  if (binding === undefined) {
    refusals.push({ code: 'STRUCTURE_DECISIONS_MISSING', path: at, message: `${at}: current.parts needs a bound snapshot; ${remedy}` });
    return;
  }
  try {
    assertCurrentPartsStructure(dir, project, binding, Date.parse(String(signoff.at)));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    refusals.push({ code: error.code, path: at, message: `${at}: ${error.message}` });
  }
}

export function selectSignoffTarget(dir: string, project: JsonObject, stage: string, requested?: string): JsonObject | undefined {
  const currentParts = stage === 'parts-review' && project.current !== undefined;
  if (!currentParts && !(stage in SIGNOFF_TARGET_KINDS)) {
    if (requested !== undefined) refuse('SIGNOFF_OPTION_INVALID', 'signoffs.target: --version requires rig-review or direction-review; remove --version');
    return undefined;
  }
  const kind: CurrentTargetKind = currentParts ? 'parts' : SIGNOFF_TARGET_KINDS[stage] === 'rig' ? 'rig' : 'direction';
  if (project.current !== undefined) {
    const path = `signoffs[${asArray(project.signoffs).length}].target`;
    if (requested !== undefined) refuse('SIGNOFF_OPTION_INVALID', `${path}: current.${kind} selects the target; remove --version`, USAGE_EXIT);
    const node = isObject(project.current) ? project.current[kind] : undefined;
    if (isObject(node) && 'adopted' in node) {
      const source = kind === 'direction' ? '--direction specs/direction/direction.json' : '--config <rig config>';
      refuse('SIGNOFF_TARGET_MISSING', `${path}: current.${kind} is an adopted output; rebuild it and run rig-create record ${kind} --from ${outputRoot(kind)} ${source}, then sign ${stage} again`);
    }
    try { return currentTargetFor(dir, project, kind); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return refuse('SIGNOFF_TARGET_STALE', `${path}: ${reason}; ${currentRemedy(kind, stage)}`);
    }
  }
  assertDraftHasRig(assembleOnlyDraftTarget(project, requested), 'project.json.signoffs.target');
  const reopens = collectReopens(project, []);
  const signed = collectSignoffs(project, []).filter(s => s.stage === stage && liveSignoff(reopens, stage, s.at));
  const versions = asArray(project.versions);
  // A rig a reopen or amendment made history is no candidate (rig-c/create#243).
  const history = stage === 'rig-review' ? new Set(readVersions(project).rigs.filter(r => !r.live).map(r => r.n)) : new Set<number>();
  const candidates = versions.filter((v): v is JsonObject => isObject(v) && v.kind === SIGNOFF_TARGET_KINDS[stage]
    && acceptedReviewVerdict(v, stage) >= 0 && !history.has(v.n as number)
    && !signed.some(s => isObject(s.record.target) && s.record.target.version === v.n));
  const fail = (reason: string): never => refuse('SIGNOFF_TARGET_STALE', `signoffs[${asArray(project.signoffs).length}].target: ${reason}; candidates [${candidates.map(v => String(v.n)).join(', ')}]; numbered ${stage} targets are read-only and current.${kind} is absent, so no signable ${stage} target resolves`);
  let version: JsonObject;
  if (requested === undefined) {
    if (candidates.length !== 1) fail('exactly one unsigned accepted candidate is required');
    version = candidates[0]!;
  } else {
    const matches = versions.filter((v): v is JsonObject => isObject(v) && v.n === Number(requested));
    if (!/^[1-9][0-9]*$/.test(requested) || matches.length !== 1 || matches[0]?.kind !== SIGNOFF_TARGET_KINDS[stage]) fail('requested version does not exist uniquely with this stage kind');
    version = matches[0]!;
  }
  const draftProblem = assembleOnlyVersionFinding(dir, project, version, 'project.json.signoffs.target');
  if (draftProblem) refuse(draftProblem.code, draftProblem.message);
  if (history.has(version.n as number)) fail('rig version is history since a reopen or amendment of rig-review or an earlier stage');
  const verdictIndex = acceptedReviewVerdict(version, stage);
  if (verdictIndex < 0) fail('version has no accepted verdict');
  let target: JsonObject;
  try { target = targetFor(dir, project, stage, version, versions.indexOf(version), verdictIndex); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  if (stage === 'rig-review' && version.pre_interview !== true) {
    // Ledger reads need every version, including verdicts retained as history.
    const ctx = { dir, project: { ...project, versions: versions.map(v => v === version ? { ...version, pre_interview: false } : v) }, refusals: [] as Finding[], warnings: [] as Finding[] };
    checkReviewPackages(ctx);
    checkFigureMask(ctx);
    const targetPath = `versions[v${String(version.n)}]`;
    const onTarget = (f: Finding): boolean => f.path === targetPath || f.path.startsWith(`${targetPath}.`);
    const refusals = ctx.refusals.filter(onTarget);
    const mask = refusals.find(f => f.code.startsWith('FIGURE_MASK_')
      || f.code === 'RIG_VERSION_AT_INVALID');
    if (mask) refuse(mask.code, mask.message);
    if (refusals.length || ctx.warnings.some(w => onTarget(w) && w.code === 'REVIEW_PACKAGE_MISSING')) fail('review package is missing or differs from its recorded binding');
  }
  // The writer validates the actual dated signature after attaching its immutable receipt.
  return target;
}
