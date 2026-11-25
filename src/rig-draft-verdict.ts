import { dirname, posix, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, isObject } from './check.ts';
import { draftRigDirectory } from './draft-layout.ts';
import { draftAmendmentTime } from './amend.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { decodeReviewAct, draftReviewStillEvidence, isDraftReviewVerdict, retainedActBy, reviewActVerdict, type DraftReviewVerdictAct } from './review-act.ts';
import { jobHash } from './job-outbox.ts';
import { publicationFile } from './job-publication.ts';
import type { JsonObject } from './templates.ts';

function records(value: JsonObject[string]): JsonObject[] {
  return asArray(value).filter(isObject);
}

function draftVerdicts(project: JsonObject, now: number): { receipt: JsonObject; act: DraftReviewVerdictAct }[] {
  const reopens = collectReopens(project, []);
  return records(project.review_acts).flatMap(receipt => {
    if (receipt.kind !== 'review-verdict' || typeof receipt.bytes !== 'string' || typeof receipt.draft_id !== 'string') return [];
    try {
      const act = decodeReviewAct(receipt.bytes);
      const at = Date.parse(act.at);
      return isDraftReviewVerdict(act) && at <= now && at > draftAmendmentTime(project, receipt.draft_id)
        && liveSignoff(reopens, 'rig-review', at) ? [{ receipt, act }] : [];
    } catch { return []; }
  }).sort((a, b) => Date.parse(b.act.at) - Date.parse(a.act.at)
    || Number(a.act.value.verdict === 'approved') - Number(b.act.value.verdict === 'approved'));
}

export function latestRigDraftVerdict(project: JsonObject, id: string, now: number): DraftReviewVerdictAct | undefined {
  return draftVerdicts(project, now).find(({ receipt }) => receipt.draft_id === id)?.act;
}

function comparedFiles(files: JsonObject[], prefix: string): Map<string, unknown> {
  return new Map(files.filter(row => typeof row.path === 'string' && row.path.startsWith(`${prefix}/`))
    .map(row => [String(row.path).slice(prefix.length + 1), row.sha256]));
}

function registeredDirectoryMatches(root: string, input: JsonObject, path: string, files: JsonObject[]): boolean {
  try {
    const bytes = publicationFile(root, path);
    if (jobHash(bytes) !== input.sha256) return false;
    const receipt = JSON.parse(bytes.toString('utf8')) as JsonObject;
    if (receipt.spec !== input.spec || receipt.mode !== 'occluder') return false;
    const siblings = comparedFiles(files, posix.dirname(path));
    siblings.delete(posix.basename(path));
    for (const field of ['mask', 'output']) {
      const bound = receipt[field];
      if (!isObject(bound) || typeof bound.path !== 'string' || !siblings.has(bound.path) || siblings.get(bound.path) !== bound.sha256) return false;
      siblings.delete(bound.path);
    }
    return siblings.size === 0;
  } catch { return false; }
}

function sameRegisteredBytes(dir: string, project: JsonObject, version: JsonObject, receipt: JsonObject, act: DraftReviewVerdictAct, inputs: string[]): boolean {
  const draft = records(project.drafts).find(row => row.id === act.source.selector.id);
  const registration = version.registration;
  const painting = asArray(project.inputs)[0];
  if (!draft || !isObject(draft.config) || !isObject(draft.parts) || !isObject(registration)
    || !isObject(registration.config_source) || draft.config.sha256 !== registration.config_source.sha256
    || !isObject(painting) || !isObject(receipt.painting) || painting.sha256 !== receipt.painting.sha256) return false;
  const files = records(draft.files);
  const outputs = records(version.outputs);
  const root = `outputs/v${String(version.n)}/out`;
  const rig = draftRigDirectory(draft);
  if (!rig || !isDeepStrictEqual(comparedFiles(files, rig), comparedFiles(outputs, `${root}/rig`))
    || !isDeepStrictEqual(comparedFiles(files, dirname(act.source.model.path)), comparedFiles(outputs, `${root}/check/build`))
    || !outputs.some(row => row.path === `${root}/check/build/skeleton.model.json` && row.sha256 === act.source.model.sha256)) return false;
  const parts = comparedFiles(records(draft.parts.files), String(draft.parts.path));
  if (parts.get('parts.json') !== act.source.parts.manifest.sha256) return false;
  for (const image of act.source.parts.images) {
    if (parts.has(image.path) && parts.get(image.path) !== image.sha256) return false;
    parts.set(image.path, image.sha256);
  }
  const registeredParts = comparedFiles(outputs, root);
  for (const path of registeredParts.keys()) if (path.startsWith('rig/') || path.startsWith('check/')) registeredParts.delete(path);
  if (!parts.has('parts.json') || !isDeepStrictEqual(parts, registeredParts)) return false;
  const configured = records(draft.config_inputs);
  const registeredFiles = records(registration.files);
  const retained = new Map(registeredFiles.map(row => [row.path, row.sha256]));
  return configured.length === inputs.length && configured.every((input, i) => {
    const path = inputs[i]!;
    return retained.has(path) && retained.get(path) === input.sha256
      && (input.directory === undefined || registeredDirectoryMatches(dir, input, path, registeredFiles));
  });
}

/** The attribution a retained draft receipt carries, including the pre-attribution legacy record. */
function receiptBy(receipt: JsonObject, act: DraftReviewVerdictAct): string {
  return retainedActBy(act, isObject(receipt.verdict) ? receipt.verdict.by : undefined);
}

function matchingDraftReceipt(project: JsonObject, receipt: JsonObject, act: DraftReviewVerdictAct): boolean {
  const drafts = records(project.drafts).filter(row => row.id === act.source.selector.id);
  return drafts.length === 1 && receipt.sha256 === jobHash(String(receipt.bytes))
    && receipt.version_hash === jobHash(`${JSON.stringify(drafts[0], null, 2)}\n`)
    && receipt.jobId === act.jobId && receipt.actId === act.actId && receipt.draft_id === act.source.selector.id
    && isDeepStrictEqual(receipt.verdict, reviewActVerdict(act, receiptBy(receipt, act)));
}

function carriedVerdict(act: DraftReviewVerdictAct, inputs: string[], by: string): JsonObject {
  return { ...reviewActVerdict(act, by), source: `carried from draft review act ${act.jobId}/${act.actId}`,
    carried_from_draft: { draft_id: act.source.selector.id, job_id: act.jobId, act_id: act.actId, config_inputs: inputs } };
}

function retainedDraftEvidence(root: string, receipt: JsonObject, act: DraftReviewVerdictAct): { evidence?: JsonObject } | undefined {
  const base = `evidence/drafts/${act.source.selector.id}`;
  try {
    if (!publicationFile(root, `${base}/${String(receipt.sha256)}.act.json`).equals(Buffer.from(String(receipt.bytes)))) return;
    if (receipt.evidence === undefined) return {};
    const evidence = draftReviewStillEvidence(act);
    if (evidence && isDeepStrictEqual(receipt.evidence, evidence)
      && jobHash(publicationFile(root, evidence.path)) === evidence.sha256) return { evidence };
  } catch { /* Missing evidence cannot authorize a carried approval. */ }
}

/** Registration checks the exact byte copies it made, using each input's role or relative name. */
export function carryRigDraftVerdict(
  root: string, project: JsonObject, version: JsonObject, configPath: string, copiedInputs: ReadonlyMap<string, string>, now: number,
): { verdict: JsonObject; evidence?: JsonObject } | undefined {
  const bySource = [...copiedInputs].map(([target, source]) => ({ target, relativePath: relative(dirname(configPath), source) }));
  for (const { receipt, act } of draftVerdicts(project, now)) {
    const draft = records(project.drafts).find(row => row.id === receipt.draft_id);
    if (!draft || !isObject(draft.config)) continue;
    const configured = records(draft.config_inputs);
    const configDir = dirname(resolve(root, String(draft.config.path)));
    const relativeInput = (path: unknown): string => relative(configDir, resolve(root, String(path)));
    const named = new Set(configured.map(input => relativeInput(input.path)));
    const directories = configured.filter(input => typeof input.directory === 'string').map(input => relativeInput(input.directory));
    if (bySource.some(({ relativePath }) => !named.has(relativePath) && !directories.some(dir => relativePath.startsWith(`${dir}/`)))) continue;
    const mapped = configured.map(input => bySource.find(row => row.relativePath === relativeInput(input.path))?.target);
    if (mapped.some(path => path === undefined)) continue;
    const inputs = mapped as string[];
    if (!sameRegisteredBytes(root, project, version, receipt, act, inputs)) continue;
    if (act.value.verdict !== 'approved' || !matchingDraftReceipt(project, receipt, act)) return undefined;
    const retained = retainedDraftEvidence(root, receipt, act);
    return retained && { verdict: carriedVerdict(act, inputs, receiptBy(receipt, act)), ...retained };
  }
}

export function validCarriedRigDraftVerdict(root: string, project: JsonObject, version: JsonObject, verdict: JsonObject): boolean {
  const provenance = verdict.carried_from_draft;
  if (version.kind !== 'rig' || !isObject(provenance) || !Array.isArray(provenance.config_inputs)
    || !provenance.config_inputs.every(path => typeof path === 'string')) return false;
  const receipts = records(project.review_acts).filter(row => row.kind === 'review-verdict' && row.draft_id === provenance.draft_id
    && row.jobId === provenance.job_id && row.actId === provenance.act_id);
  const receipt = receipts[0];
  if (receipts.length !== 1 || typeof receipt?.bytes !== 'string') return false;
  try {
    const act = decodeReviewAct(receipt.bytes);
    const inputs = provenance.config_inputs as string[];
    if (!isDraftReviewVerdict(act) || act.value.verdict !== 'approved') return false;
    const retained = retainedDraftEvidence(root, receipt, act);
    return retained !== undefined && (!retained.evidence || records(version.evidence).some(row => isDeepStrictEqual(row, retained.evidence)))
      && matchingDraftReceipt(project, receipt, act)
      && isDeepStrictEqual(verdict, carriedVerdict(act, inputs, receiptBy(receipt, act)))
      && sameRegisteredBytes(root, project, version, receipt, act, inputs);
  } catch { return false; }
}
