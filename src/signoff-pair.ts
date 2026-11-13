/** Review act order is immaterial only within one human-reviewed publication. */
import { isDeepStrictEqual } from 'node:util';
import { asArray, isObject, type Finding } from './check.ts';
import { decodeReviewAct, isRecordDirectionSignoff, reviewActFindings, reviewActSignoff, SIGNOFF_TARGET_KINDS, signoffActVersion } from './review-act.ts';
import type { JsonObject } from './templates.ts';

export const SIGNOFF_PAIR_SINCE = '2026-11-13T00:00:00Z';

/** Trust decoded immutable acts and their unique ledger mappings, never copied identity fields. */
export function samePublicationReviewPair(project: JsonObject, signoff: JsonObject, version: JsonObject, verdictIndex: number): boolean {
  if (reviewActFindings(project).length) return false;
  try {
    const receipts = asArray(project.review_acts).filter(isObject);
    const signatures = receipts.filter(entry => entry.kind === 'signoff' && typeof entry.bytes === 'string'
      && reviewActSignoff(decodeReviewAct(entry.bytes, 'signoff')).source === signoff.source);
    const verdicts = receipts.filter(entry => entry.version === version.n && entry.verdict === verdictIndex);
    if (signatures.length !== 1 || verdicts.length !== 1) return false;
    const signed = decodeReviewAct(String(signatures[0]!.bytes), 'signoff');
    // The validated compact record receipt binds the post, record hash and exact verdict;
    // record-source acts deliberately have no model selector.
    const signedVersion = isRecordDirectionSignoff(signed) ? Number(signatures[0]!.target_version) : signoffActVersion(signed);
    const accepted = decodeReviewAct(String(verdicts[0]!.bytes));
    const selector = accepted.source.selector;
    const verdict = asArray(version.verdicts)[verdictIndex];
    return isObject(verdict) && verdict.verdict === 'accepted'
      && Object.entries(reviewActSignoff(signed)).every(([key, value]) => isDeepStrictEqual(signoff[key], value))
      && signed.value.stage === signoff.stage && accepted.value.stage === signoff.stage
      && signedVersion === version.n && selector !== null && 'version' in selector && selector.version === version.n
      && selector.kind === SIGNOFF_TARGET_KINDS[String(signoff.stage)]
      && signed.jobId === accepted.jobId && signed.publicationId === accepted.publicationId;
  } catch { return false; }
}

/** A newly ingested verdict must not complete an invalid pair, including a historical signature. */
export function ingestedVerdictPairFinding(project: JsonObject, version: number, verdict: number): Finding | undefined {
  const index = asArray(project.versions).findIndex(raw => isObject(raw) && raw.n === version);
  for (const [i, signoff] of asArray(project.signoffs).entries()) {
    if (!isObject(signoff) || !isObject(signoff.target) || signoff.target.version !== version
      || signoff.target.verdict !== `versions[${index}].verdicts[${verdict}]`) continue;
    const finding = signoffPairFinding(project, signoff, `signoffs[${i}]`, true);
    if (finding) return finding;
  }
}

/** Check gates history by the signature's date; ingest always enforces the current contract. */
export function signoffPairFinding(project: JsonObject, signoff: JsonObject, path: string, ingest = false): Finding | undefined {
  if (!(String(signoff.stage) in SIGNOFF_TARGET_KINDS) || !isObject(signoff.target)) return;
  const target = signoff.target;
  const match = /^versions\[(\d+)\]\.verdicts\[(\d+)\]$/.exec(String(target.verdict));
  const version = match ? asArray(project.versions)[Number(match[1])] : undefined;
  if (!match || !isObject(version) || version.n !== target.version) return;
  const verdictIndex = Number(match[2]);
  const verdict = asArray(version.verdicts)[verdictIndex];
  if (!isObject(verdict) || !(Date.parse(String(verdict.at)) > Date.parse(String(signoff.at)))
    || samePublicationReviewPair(project, signoff, version, verdictIndex)) return;
  const legacy = !ingest && Date.parse(String(signoff.at)) < Date.parse(SIGNOFF_PAIR_SINCE);
  const at = `${path}.target.verdict`;
  return { code: `SIGNOFF_PAIR_MISMATCH${legacy ? '_LEGACY' : ''}`, path: at,
    message: `${at}: the verdict follows this signoff without a same-publication, same-version human accepted pair; accept the intended version and sign it again in Review, then ingest both acts` };
}
