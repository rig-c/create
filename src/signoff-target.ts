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
import { refuse, USAGE_EXIT } from './refusal.ts';
import { SIGNOFF_TARGET_KINDS } from './review-act.ts';
import { sorted } from './step-hash.ts';
import { signoffPairFinding } from './signoff-pair.ts';
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

type CurrentTargetKind = 'rig' | 'direction';

export function signoffTargetFormat(target: Json | undefined): 'current' | 'numbered' | 'mixed' | undefined {
  if (!isObject(target)) return;
  const numbered = 'version' in target || 'verdict' in target;
  if ('subject' in target || 'record_sha256' in target || 'files_sha256' in target) return numbered ? 'mixed' : 'current';
  if (numbered) return 'numbered';
}

function currentTargetFor(dir: string, project: JsonObject, kind: CurrentTargetKind) {
  const subject = `current.${kind}` as const;
  if (!isObject(project.current)) throw Error('current is missing or malformed');
  const node = project.current[kind];
  if (node === undefined) throw Error(`${subject} is missing`);
  const problem = currentShapeFindings(kind, node)[0];
  if (problem) throw Error(`${problem.path} is malformed`);
  if (!isObject(node) || !isSha256(node.files_sha256)) throw Error(`${subject}.files_sha256 is malformed`);
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
  if (!(stage in SIGNOFF_TARGET_KINDS)) return;
  const target = signoff.target;
  const format = signoffTargetFormat(target);
  const current = format === 'current' || format === 'mixed' || (format === undefined && project.current !== undefined);
  const kind = SIGNOFF_TARGET_KINDS[stage] === 'rig' ? 'rig' : 'direction';
  const draft = asArray(project.drafts).filter(isObject).find(d => d.id === signoff.draft_id)
    ?? assembleOnlyDraftTarget(project, !current && isObject(target) ? target.version : undefined);
  if (isAssembleOnlyDraft(draft)) {
    refusals.push(draftRigRequired(`${path}.target`, draft?.id));
    return;
  }
  const missing = target === undefined || target === null;
  let reason = missing ? 'target missing' : '';
  if (!missing && current) {
    try {
      if (!isObject(target) || target.subject !== `current.${kind}` || Object.keys(target).length !== 3
        || !isSha256(target.record_sha256) || !isSha256(target.files_sha256)) {
        throw Error(`expected subject current.${kind}, record_sha256 and files_sha256`);
      }
      const expected = currentTargetFor(dir, project, kind);
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
    const pair = current ? undefined : signoffPairFinding(project, signoff, path);
    if (pair) (pair.code.endsWith('_LEGACY') ? warnings : refusals).push(pair);
    return;
  }
  const legacy = Date.parse(String(signoff.at)) < Date.parse(SIGNOFF_TARGET_SINCE);
  const code = `SIGNOFF_TARGET_${missing ? 'MISSING' : 'STALE'}${legacy ? '_LEGACY' : ''}`;
  const at = `${path}.target`;
  const remedy = current ? currentRemedy(kind, stage) : `preserve the reviewed inputs and sign ${stage} again with --version`;
  (legacy ? warnings : refusals).push({ code, path: at, message: `${at}: ${reason}; ${remedy}` });
}

export function selectSignoffTarget(dir: string, project: JsonObject, stage: string, requested?: string): JsonObject | undefined {
  if (!(stage in SIGNOFF_TARGET_KINDS)) {
    if (requested !== undefined) refuse('SIGNOFF_OPTION_INVALID', 'signoffs.target: --version requires rig-review or direction-review; remove --version');
    return undefined;
  }
  if (project.current !== undefined) {
    const kind = SIGNOFF_TARGET_KINDS[stage] === 'rig' ? 'rig' : 'direction';
    const path = `signoffs[${asArray(project.signoffs).length}].target`;
    if (requested !== undefined) refuse('SIGNOFF_OPTION_INVALID', `${path}: current.${kind} selects the target; remove --version`, USAGE_EXIT);
    const node = isObject(project.current) ? project.current[kind] : undefined;
    if (isObject(node) && 'adopted' in node) {
      const source = kind === 'rig' ? '--config <rig config>' : '--direction specs/direction/direction.json';
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
  const fail = (reason: string): never => refuse('SIGNOFF_TARGET_STALE', `signoffs[${asArray(project.signoffs).length}].target: ${reason}; candidates [${candidates.map(v => String(v.n)).join(', ')}]; select an accepted version with --version and restore its reviewed inputs`);
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
