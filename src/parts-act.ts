import { PARTS_CLI_RECEIPT } from './parts-verdict-record.ts';
/** Typed semantic evidence retained by the parts-review API route. */
import { dirname, join } from 'node:path';
import { readFileSync } from './check-reads.ts';
import { isDeepStrictEqual } from 'node:util';
import { publicationFile, publishedDraft } from './job-publication.ts';
import { jobHash, publicationVersionHash } from './job-outbox.ts';
import { decodeReviewAct, partsActIssues, type PartsVerdictAct } from './review-act.ts';
import { stepHash } from './step-hash.ts';
import { refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (why: string): never => refuse('REVIEW_ACT_SOURCE_STALE', `project.json.review_acts: ${why}; restore the reviewed draft or record and review a new draft id`);

export function partsActDraftHash(project: JsonObject, act: PartsVerdictAct): string {
  const hash = publicationVersionHash(Buffer.from(JSON.stringify(project)), { path: '', selector: act.source.selector });
  return hash ?? fail('reviewed draft is absent');
}

export function partsActReceipt(project: JsonObject, act: PartsVerdictAct): JsonObject | undefined {
  return Array.isArray(project.review_acts) ? project.review_acts.find(entry => object(entry) && entry.jobId === act.jobId && entry.actId === act.actId) as JsonObject | undefined : undefined;
}

/** File hashes are checked as declared. No enumeration or producer measurement. */
export function assertPartsActSource(root: string, project: JsonObject, act: PartsVerdictAct, options: { comparePlan?: boolean } = {}): void {
  let draft: JsonObject;
  try { draft = publishedDraft(project, act.source.selector.id); }
  catch { return fail('reviewed draft is absent or ambiguous'); }
  const parts = draft.parts as JsonObject;
  const bound = [draft.config, ...(draft.config_inputs as JsonObject[] ?? []), ...(parts.files as JsonObject[]), ...(draft.files as JsonObject[])];
  const check = (identity: { path: string; sha256: string }): void => {
    try { if (jobHash(publicationFile(root, identity.path)) !== identity.sha256) fail(`${identity.path} changed`); }
    catch { fail(`${identity.path} is absent or changed`); }
  };
  for (const raw of bound) {
    if (!object(raw) || typeof raw.path !== 'string' || typeof raw.sha256 !== 'string') return fail('draft file identity is malformed');
    check({ path: String(raw.path), sha256: String(raw.sha256) });
  }
  if (act.source.parts.manifest.path !== `${parts.path}/parts.json`) fail('parts manifest differs from the selected draft');
  const manifestIdentity = (parts.files as JsonObject[]).find(file => file.path === act.source.parts.manifest.path);
  if (manifestIdentity?.sha256 !== act.source.parts.manifest.sha256) fail('manifest hash differs from the draft');
  check(act.source.parts.manifest);
  for (const image of act.source.parts.images) check({ path: join(dirname(act.source.parts.manifest.path), image.path), sha256: image.sha256 });
  const manifest = JSON.parse(publicationFile(root, act.source.parts.manifest.path).toString('utf8')) as { parts: { name: string }[] };
  const names = manifest.parts.map(part => part.name).sort();
  const issues = partsActIssues(act);
  if (issues !== null) {
    const manifestNames = new Set(names);
    if (issues.some(issue => issue.parts.some(part => !manifestNames.has(part.name)))) fail('verdict part membership differs from the bound manifest');
  } else if (act.schema === 'rig-review/act@2' && !isDeepStrictEqual(names, act.value.parts.map(part => part.partId).sort())) fail('verdict part membership differs from the bound manifest');
  if (act.source.model) {
    if (!(draft.files as JsonObject[]).some(file => file.path === act.source.model!.path && file.sha256 === act.source.model!.sha256)) fail('displayed model is outside the selected draft');
    check(act.source.model);
  }
  if (act.source.direction) check(act.source.direction);
  if (act.source.plan && options.comparePlan !== false) {
    const steps = object(project.plan) && Array.isArray(project.plan.steps) ? project.plan.steps : [];
    if (!isDeepStrictEqual(act.source.plan.steps, steps.map(step => ({ id: object(step) ? step.id : null, hash: object(step) ? stepHash(step) : null })))) fail('displayed plan changed');
  }
  const publication = JSON.parse(publicationFile(root, `review-draft-${draft.id}.json`).toString('utf8')) as JsonObject;
  if (publication.id !== act.source.package.id || publication.revision !== act.source.package.revision
    || act.source.package.revision !== partsActDraftHash(project, act)
    || (publication.model ?? null) !== (act.source.model?.path ?? null)) fail('published package identity changed');
}

export function partsActFindings(root: string, project: JsonObject): { code: string; path: string; message: string }[] {
  if (!Array.isArray(project.review_acts)) return [];
  return project.review_acts.flatMap((entry, index) => {
    if (!object(entry) || entry.kind !== 'parts-verdict' || entry.schema === PARTS_CLI_RECEIPT) return [];
    const path = `review_acts[${index}].evidence`;
    try {
      if (entry.schema !== 'rig-create/review-act@1' || typeof entry.jobId !== 'string' || typeof entry.actId !== 'string'
        || !object(entry.evidence) || entry.evidence.path !== `evidence/review-acts/${jobHash(JSON.stringify([entry.jobId, entry.actId]))}.json`
        || entry.evidence.sha256 !== entry.sha256) throw Error();
      const bytes = publicationFile(root, entry.evidence.path);
      if (jobHash(bytes) !== entry.sha256 || bytes.toString('utf8') !== entry.bytes) throw Error();
      decodeReviewAct(bytes.toString('utf8'), 'parts-verdict');
      return [];
    } catch { return [{ code: 'REVIEW_ACT_LEDGER_INVALID', path, message: `${path}: retained evidence differs from its act receipt; restore the original evidence and ledger together` }]; }
  });
}

export function checkPartsActEvidence(root: string, bytes: Buffer, evidenceHash: string, candidate?: JsonObject): string {
  const act = decodeReviewAct(bytes.toString('utf8'), 'parts-verdict');
  const project = candidate ?? JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  const receipt = partsActReceipt(project, act);
  if (!receipt || receipt.kind !== 'parts-verdict' || receipt.sha256 !== evidenceHash || receipt.bytes !== bytes.toString('utf8')) {
    refuse('REVIEW_ACT_LEDGER_INVALID', 'project.json.review_acts: parts evidence has no matching recorded receipt; ingest it with parts-review --from-review');
  }
  // Later plan approvals can fill checkpoints without changing the reviewed draft.
  assertPartsActSource(root, project, act, { comparePlan: false });
  if (partsActDraftHash(project, act) !== receipt.version_hash) fail('recorded draft entry changed');
  if (act.value.verdict !== 'approved') refuse('PARTS_VERDICT_NOT_APPROVED', 'signoffs.parts-review.evidence: semantic verdict is not approved; review the corrected draft and record a separate approval');
  return join(root, act.source.parts.manifest.path);
}
