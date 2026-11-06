import { acceptedReviewVerdict } from './review.ts';
/** Review signatures bind accepted verdicts and the reviewed version's retained inputs. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { asArray, collectSignoffs, isObject, type Finding } from './check.ts';
import { directionBinding } from './direction.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { checkReviewPackages } from './review-package.ts';
import { refuse } from './refusal.ts';
import { sorted } from './step-hash.ts';
import type { Json, JsonObject } from './templates.ts';

export const SIGNOFF_TARGET_SINCE = '2026-11-06T00:00:00Z';
const kinds: Record<string, string> = { 'rig-review': 'rig', 'direction-review': 'post' };

export function outputsHash(outputs: Json[]): string {
  return createHash('sha256').update(JSON.stringify(sorted(outputs))).digest('hex');
}

export function reviewPackageHash(record: JsonObject): string {
  return createHash('sha256').update(JSON.stringify(sorted({ config: record.config, files: record.files }))).digest('hex');
}

function validBinding(value: Json | undefined): value is JsonObject {
  return isObject(value) && typeof value.path === 'string' && value.path.length > 0
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
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
  if (!(stage in kinds)) return;
  const missing = signoff.target === undefined || signoff.target === null;
  let reason = missing ? 'target missing' : '';
  if (!missing) {
    try {
      const target = signoff.target;
      if (!isObject(target) || !Number.isSafeInteger(target.version) || Number(target.version) < 1) throw Error('target version missing or malformed');
      const versions = asArray(project.versions);
      const matches = versions.map((v, i) => ({ v, i })).filter(({ v }) => isObject(v) && v.n === target.version);
      if (matches.length !== 1) throw Error('target version does not exist uniquely');
      const { v, i } = matches[0] as { v: JsonObject; i: number };
      if (v.kind !== kinds[stage]) throw Error('target version belongs to another stage kind');
      const match = typeof target.verdict === 'string' ? /^versions\[(\d+)\]\.verdicts\[(\d+)\]$/.exec(target.verdict) : null;
      if (!match || Number(match[1]) !== i) throw Error('verdict path does not resolve to the target version');
      const verdictIndex = Number(match[2]);
      const verdict = asArray(v.verdicts)[verdictIndex];
      if (!isObject(verdict) || verdictIndex !== acceptedReviewVerdict(v, stage)) throw Error('named verdict is missing, not accepted or belongs to another review stage');
      const expected = targetFor(dir, project, stage, v, i, verdictIndex);
      if (!isDeepStrictEqual(target, expected)) throw Error(expected.outputs ? 'outputs changed since signing' : stage === 'rig-review' ? 'review_package changed since signing' : expected.direction ? 'direction changed since signing' : 'post config changed since signing');
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  }
  if (!reason) return;
  const legacy = Date.parse(String(signoff.at)) < Date.parse(SIGNOFF_TARGET_SINCE);
  const code = `SIGNOFF_TARGET_${missing ? 'MISSING' : 'STALE'}${legacy ? '_LEGACY' : ''}`;
  const at = `${path}.target`;
  (legacy ? warnings : refusals).push({ code, path: at, message: `${at}: ${reason}; preserve the reviewed inputs and sign ${stage} again with --version` });
}

export function selectSignoffTarget(dir: string, project: JsonObject, stage: string, requested?: string): JsonObject | undefined {
  if (!(stage in kinds)) {
    if (requested !== undefined) refuse('SIGNOFF_OPTION_INVALID', 'signoffs.target: --version requires rig-review or direction-review; remove --version');
    return undefined;
  }
  const reopens = collectReopens(project, []);
  const signed = collectSignoffs(project, []).filter(s => s.stage === stage && liveSignoff(reopens, stage, s.at));
  const versions = asArray(project.versions);
  const candidates = versions.filter((v): v is JsonObject => isObject(v) && v.kind === kinds[stage]
    && acceptedReviewVerdict(v, stage) >= 0
    && !signed.some(s => isObject(s.record.target) && s.record.target.version === v.n));
  const fail = (reason: string): never => refuse('SIGNOFF_TARGET_STALE', `signoffs[${asArray(project.signoffs).length}].target: ${reason}; candidates [${candidates.map(v => String(v.n)).join(', ')}]; select an accepted version with --version and restore its reviewed inputs`);
  let version: JsonObject;
  if (requested === undefined) {
    if (candidates.length !== 1) fail('exactly one unsigned accepted candidate is required');
    version = candidates[0]!;
  } else {
    const matches = versions.filter((v): v is JsonObject => isObject(v) && v.n === Number(requested));
    if (!/^[1-9][0-9]*$/.test(requested) || matches.length !== 1 || matches[0]?.kind !== kinds[stage]) fail('requested version does not exist uniquely with this stage kind');
    version = matches[0]!;
  }
  const verdictIndex = acceptedReviewVerdict(version, stage);
  if (verdictIndex < 0) fail('version has no accepted verdict');
  let target: JsonObject;
  try { target = targetFor(dir, project, stage, version, versions.indexOf(version), verdictIndex); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  if (stage === 'rig-review' && version.pre_interview !== true) {
    const ctx = { dir, project: { ...project, versions: [{ ...version, pre_interview: false }] }, refusals: [] as Finding[], warnings: [] as Finding[] };
    checkReviewPackages(ctx);
    if (ctx.refusals.length || ctx.warnings.some(w => w.code === 'REVIEW_PACKAGE_MISSING')) fail('review package is missing or differs from its recorded binding');
  }
  const errors: Finding[] = [];
  checkSignoffTarget(dir, project, { stage, target, at: SIGNOFF_TARGET_SINCE }, `signoffs[${asArray(project.signoffs).length}]`, errors, []);
  if (errors[0]) refuse(errors[0].code, errors[0].message);
  return target;
}
