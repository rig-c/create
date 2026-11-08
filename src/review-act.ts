import { PARTS_CLI_RECEIPT } from './parts-verdict-record.ts';
/** Finalized semantic acts. This reader never opens Review's private state. */
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JobAct, JobModelSourceBinding } from '@rig-c/review/job-host';
import { jobHash, publicationVersionHash, readAcknowledgedPublication, readWriterBinding } from './job-outbox.ts';
import { publicationFile } from './job-publication.ts';
import { Refusal, refuse } from './refusal.ts';
import { stepHash } from './step-hash.ts';
import type { Json, JsonObject } from './templates.ts';

export type PartsVerdictAct = Extract<JobAct, { kind: 'parts-verdict' }>;
export type ReviewVerdictAct = Extract<JobAct, { kind: 'review-verdict' }> & { source: JobModelSourceBinding };
export interface FetchedReviewAct { act: ReviewVerdictAct; bytes: string; stillBytes?: string }
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const file = (value: unknown): value is JsonObject => object(value) && typeof value.path === 'string' && sha(value.sha256);
function failure(code: string, detail: string): never {
  refuse(code, `project.json.review_acts: ${detail}; restore the original evidence or request a new act in the live Review job`);
}

/** Also used by check on the retained, explicitly encoded act bytes. */
export function decodeReviewAct(bytes: string): ReviewVerdictAct;
export function decodeReviewAct(bytes: string, kind: 'parts-verdict'): PartsVerdictAct;
export function decodeReviewAct(bytes: string, kind: 'review-verdict' | 'parts-verdict'): ReviewVerdictAct | PartsVerdictAct;
export function decodeReviewAct(bytes: string, kind: 'review-verdict' | 'parts-verdict' = 'review-verdict'): ReviewVerdictAct | PartsVerdictAct {
  let act: JsonObject;
  try { const parsed: unknown = JSON.parse(bytes); if (!object(parsed)) throw Error(); act = parsed; }
  catch { return failure('REVIEW_ACT_INVALID', 'act is not a JSON object'); }
  if (act.schema !== 'rig-review/act@2' && !(kind === 'review-verdict' && act.schema === 'rig-review/act@3')) failure('REVIEW_ACT_SCHEMA_UNSUPPORTED', `act schema ${String(act.schema)} is unsupported, including legacy rig-review/act@1`);
  const source = act.source;
  const parts = object(source) ? source.parts : null;
  const version = object(parts) && typeof parts.enumeratorVersion === 'string' ? parts.enumeratorVersion : '';
  // Only stable releases in the frozen range are accepted. Prereleases are outside it.
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || !match.slice(1).every(piece => Number.isSafeInteger(Number(piece))) || Number(match[1]) !== 2 || Number(match[2]) < 25) failure('REVIEW_PARTS_ENUMERATOR_UNSUPPORTED', `parts enumerator ${version || 'absent'} is outside >=2.25.0 <3.0.0`);
  if (act.kind !== kind) failure('REVIEW_ACT_KIND_MISMATCH', `kind ${String(act.kind)} does not match ${kind}`);
  const authority = act.authority;
  const reviewer = object(authority) ? authority.reviewer : null;
  const value = act.value;
  if (!id(act.actId) || !id(act.jobId) || !id(act.askId) || !id(act.publicationId)
    || typeof act.at !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(act.at) || !Number.isFinite(Date.parse(act.at))
    || !object(authority) || authority.actor !== 'human' || authority.channel !== 'review-ui'
    || !object(reviewer) || typeof reviewer.id !== 'string' || !reviewer.id.trim() || !['owner', 'delegate'].includes(String(reviewer.role))
    || !object(source) || !sha(source.sourceHash) || !sha(source.projectHash)
    || !object(source.package) || !id(source.package.id) || typeof source.package.revision !== 'string'
    || !object(value) || typeof value.words !== 'string' || !['pending', 'approved', 'changes-requested'].includes(String(value.verdict))) {
    failure('REVIEW_ACT_INVALID', 'act identity, authority, source or verdict is malformed');
  }
  if (kind === 'parts-verdict') {
    const selector = source.selector;
    if (!object(selector) || selector.kind !== 'draft' || !id(selector.id) || !object(parts) || !file(parts.manifest)
      || !Array.isArray(parts.images) || parts.images.some(row => !file(row) || typeof row.role !== 'string')
      || source.model !== null && !file(source.model) || source.direction !== null && !file(source.direction)
      || source.plan !== null && (!object(source.plan) || !Array.isArray(source.plan.steps)
        || source.plan.steps.some(step => !object(step) || !id(step.id) || !sha(step.hash)))
      || !Array.isArray(value.parts) || !value.parts.length) failure('REVIEW_ACT_INVALID', 'parts verdict source or rows are malformed');
    const rows = value.parts as JsonObject[];
    const ids = new Set<string>();
    for (const row of rows) {
      if (!object(row) || !id(row.partId) || ids.has(row.partId)) failure('REVIEW_ACT_INVALID', 'part identities are invalid or duplicated');
      ids.add(row.partId);
      for (const outcome of [row.part, row.mesh]) {
        if (!object(outcome) || !['pending', 'clean', 'flagged'].includes(String(outcome.outcome)) || typeof outcome.note !== 'string'
          || outcome.outcome === 'flagged' && !outcome.note.trim()) failure('REVIEW_ACT_INVALID', 'part or mesh outcome is malformed');
      }
    }
    const outcomes = rows.flatMap(row => [(row.part as JsonObject).outcome, (row.mesh as JsonObject).outcome]);
    if (value.verdict === 'approved' && outcomes.some(outcome => outcome !== 'clean')
      || value.verdict === 'changes-requested' && !outcomes.includes('flagged')) failure('REVIEW_ACT_INVALID', 'parts verdict contradicts its outcomes');
    return act as unknown as PartsVerdictAct;
  }
  if (source.subject === 'image-set' || value.stage === 'image-review') failure('REVIEW_ACT_KIND_MISMATCH', 'image-review has no rig/post writer mapping');
  const selector = source.selector;
  if (!object(selector) || !['rig', 'post'].includes(String(selector.kind)) || !Number.isSafeInteger(selector.version) || Number(selector.version) < 1
    || selector.kind === 'post' && (!Number.isSafeInteger(selector.rigVersion) || Number(selector.rigVersion) < 1)
    || value.stage !== (selector.kind === 'rig' ? 'rig-review' : 'direction-review') || !file(source.model)
    || selector.kind === 'post' && !file(source.direction) || selector.kind === 'rig' && source.direction !== null
    || !object(parts) || !file(parts.manifest) || !Array.isArray(parts.images)
    || parts.images.some(row => !file(row) || typeof row.role !== 'string')
    || source.plan !== null && (!object(source.plan) || !Array.isArray(source.plan.steps)
      || source.plan.steps.some(step => !object(step) || !id(step.id) || !sha(step.hash)))) {
    failure('REVIEW_ACT_INVALID', 'rig/post source binding is malformed or contradicts the review stage');
  }
  if (act.schema === 'rig-review/act@3') {
    const still = act.still;
    if (value.stage !== 'rig-review' || !file(still) || still.path !== `${still.sha256}.png`
      || still.camera !== 'fixed' || !(still.frame === 'setup' && still.animation === undefined
        || typeof still.frame === 'number' && Number.isFinite(still.frame) && still.frame >= 0
          && typeof still.animation === 'string' && still.animation.length > 0)) {
      failure('REVIEW_ACT_INVALID', 'rig-review still identity, camera, frame or animation is malformed');
    }
  }
  return act as unknown as ReviewVerdictAct;
}

export function decodeReviewResponse(text: string, jobId: string, actId: string, requestId: string, kind: 'review-verdict' | 'parts-verdict' = 'review-verdict'): { act: ReviewVerdictAct | PartsVerdictAct; bytes: string } {
  let response: JsonObject;
  try { const parsed: unknown = JSON.parse(text); if (!object(parsed)) throw Error(); response = parsed; }
  catch { return failure('REVIEW_ACT_INVALID', 'Review response is not JSON'); }
  if (response.schema !== 'rig-review/job-api@2') failure('REVIEW_API_SCHEMA_UNSUPPORTED', `API schema ${String(response.schema)} is unsupported`);
  if (response.verb !== 'fetch-act' || response.jobId !== jobId || response.requestId !== requestId) failure('REVIEW_ACT_INVALID', 'fetch response identity differs from the request');
  if (response.ok !== true) failure('REVIEW_ACT_FETCH_REFUSED', `Review refused fetch (${object(response.error) ? String(response.error.code) : 'invalid response'})`);
  // The API exposes a semantic value, not a producer storage file. Retain this
  // encoding once, and hash its exact UTF-8 bytes without reconstructing reports.
  const bytes = JSON.stringify(response.value);
  const act = decodeReviewAct(bytes, kind);
  if (act.jobId !== jobId || act.actId !== actId) failure('REVIEW_ACT_INVALID', 'fetched act identity differs from the request');
  return { act, bytes };
}

export interface ReviewActTransport {
  origin: string;
  jobId: string;
  actId: string;
  fetchCapability: string;
  kind?: 'parts-verdict';
}

/** Only the route and fetch grant leave the binding reader. Never attach a host. */
export function reviewActTransport(root: string, actId: string): ReviewActTransport {
  const binding = readWriterBinding(root);
  if (!binding) failure('JOB_BINDING_INVALID', 'writer binding is absent, open the live job first');
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  if (binding.identity.root !== realpathSync(root) || !object(project.review_job)
    || project.review_job.jobId !== binding.jobId || project.review_job.origin !== binding.origin) failure('JOB_BINDING_INVALID', 'writer binding and project job locator disagree');
  let origin: URL;
  try { origin = new URL(binding.origin); } catch { return failure('JOB_BINDING_INVALID', 'writer route is invalid'); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || !id(binding.jobId) || !id(actId)) failure('JOB_BINDING_INVALID', 'fetch requires an exact loopback job route');
  return { origin: origin.origin, jobId: binding.jobId, actId, fetchCapability: binding.fetchCapability };
}

export async function fetchReviewAct(transport: ReviewActTransport): Promise<{ act: ReviewVerdictAct | PartsVerdictAct; bytes: string; stillBytes?: string }> {
  const requestId = randomUUID();
  const request = JSON.stringify({ schema: 'rig-review/job-api@2', verb: 'fetch-act', jobId: transport.jobId, actId: transport.actId, requestId });
  async function read(accept: string): Promise<Response> {
    try {
      const response = await fetch(`${transport.origin}/jobs/${transport.jobId}/api`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${transport.fetchCapability}`, 'content-type': 'application/json', accept }, body: request,
      });
      if (!response.ok) return failure('REVIEW_ACT_FETCH_REFUSED', 'live Review refused fetch');
      return response;
    } catch { return failure('REVIEW_ACT_FETCH_REFUSED', 'live Review fetch failed'); }
  }
  if (transport.kind === 'parts-verdict') return decodeReviewResponse(await (await read('application/json')).text(), transport.jobId, transport.actId, requestId, 'parts-verdict');
  const bytes = await (await read('application/vnd.rig-review.act+json')).text();
  const act = decodeReviewAct(bytes);
  if (act.jobId !== transport.jobId || act.actId !== transport.actId) failure('REVIEW_ACT_INVALID', 'fetched act identity differs from the request');
  if (act.schema !== 'rig-review/act@3') return { act, bytes };
  const png = Buffer.from(await (await read('image/png')).arrayBuffer());
  if (jobHash(png) !== act.still.sha256) failure('REVIEW_ACT_STILL_INVALID', 'exported still sha256 does not match');
  return { act, bytes, stillBytes: png.toString('base64') };
}

/** Exact #184 identity, discounting verdicts and exact evidence added after this receipt. */
export function reviewActVersionHash(project: JsonObject, act: ReviewVerdictAct, verdictsBefore?: number): string {
  const selector = act.source.selector!;
  if (!Array.isArray(project.versions)) return failure('REVIEW_ACT_SOURCE_STALE', 'versions are absent');
  const versions = project.versions.map(raw => {
    if (!object(raw) || !('version' in selector) || raw.n !== selector.version || verdictsBefore === undefined) return raw;
    const added = (Array.isArray(project.review_acts) ? project.review_acts : []).filter(object)
      .filter(receipt => receipt.version === raw.n && Number(receipt.verdict) >= verdictsBefore)
      .flatMap(receipt => Array.isArray(receipt.added_evidence) ? receipt.added_evidence : []);
    return { ...raw, evidence: Array.isArray(raw.evidence) ? raw.evidence.filter(entry => {
        const index = added.findIndex(value => isDeepStrictEqual(value, entry));
        if (index < 0) return true;
        added.splice(index, 1); return false;
      }) : raw.evidence,
      verdicts: Array.isArray(raw.verdicts) ? raw.verdicts.slice(0, verdictsBefore) : [] };
  });
  const hash = publicationVersionHash(Buffer.from(JSON.stringify({ versions })), { path: '', selector });
  if (!hash) return failure('REVIEW_ACT_SOURCE_STALE', 'reviewed version is absent');
  return hash;
}

function previousPublicationVerdict(project: JsonObject, act: ReviewVerdictAct): number | undefined {
  if (!Array.isArray(project.review_acts)) return undefined;
  const receipts = project.review_acts.filter(object).filter(entry => {
    if (entry.kind === 'parts-verdict' || entry.jobId !== act.jobId || typeof entry.bytes !== 'string') return false;
    return decodeReviewAct(entry.bytes).publicationId === act.publicationId;
  });
  return receipts.length ? Math.min(...receipts.map(entry => Number(entry.verdict))) : undefined;
}

export function reviewActPublicationWarning(root: string, project: JsonObject, act: ReviewVerdictAct): string | null {
  const receipt = readAcknowledgedPublication(root, act.jobId, act.publicationId);
  if (!receipt) return 'REVIEW_ACT_VERSION_UNVERIFIED: project.json.review_acts: publication receipt is absent, so the first-ingest version-entry check was skipped; retain acknowledged publications for future ingests';
  if (!isDeepStrictEqual(receipt.result.selector, act.source.selector) || receipt.versionHash !== reviewActVersionHash(project, act, previousPublicationVerdict(project, act))) {
    failure('REVIEW_ACT_SOURCE_STALE', 'version entry differs from its acknowledged publication');
  }
  return null;
}

export function assertReviewActSource(root: string, project: JsonObject, act: ReviewVerdictAct): void {
  const stale = (detail: string): never => failure('REVIEW_ACT_SOURCE_STALE', detail);
  const source = act.source;
  const selector = source.selector!;
  const version = (project.versions as JsonObject[] | undefined)?.find(v => v.n === ('version' in selector ? selector.version : -1));
  if (!version || version.kind !== selector.kind || selector.kind === 'post' && version.rig_version !== selector.rigVersion) stale('reviewed version selection changed');
  const rig = selector.kind === 'post' ? selector.rigVersion : selector.kind === 'rig' ? selector.version : -1;
  const rigVersion = (project.versions as JsonObject[]).find(v => v.n === rig);
  const retained = object(rigVersion?.review_package) ? rigVersion.review_package : null;
  const boundFile = (identity: { readonly path: string; readonly sha256: string }): void => {
    try { if (jobHash(publicationFile(root, identity.path)) !== identity.sha256) stale(`${identity.path} changed`); }
    catch { stale(`${identity.path} is missing or changed`); }
  };
  boundFile(source.model!);
  if (source.model!.path !== `derived/review/v${rig}/out/check/build/skeleton.model.json`) stale('displayed model is not the retained rig model');
  if (selector.kind === 'post') {
    if (source.direction!.path !== `evidence/direction/v${selector.version}.json`) stale('displayed direction is not the retained post direction');
    boundFile(source.direction!);
    const provenance = object(version!.provenance) ? version!.provenance : null;
    if (!object(provenance?.direction) || !isDeepStrictEqual(provenance.direction, source.direction)) stale('post direction binding changed');
  }
  if (!retained || !Array.isArray(retained.files)) stale('retained review package is absent');
  for (const raw of retained!.files as Json[]) {
    if (!file(raw)) return stale('retained review package identity is malformed');
    boundFile({ path: `derived/review/v${rig}/${raw.path}`, sha256: String(raw.sha256) });
  }
  const parts = source.parts!;
  const partsRoot = typeof retained!.from === 'string' ? retained!.from : `derived/review/v${rig}/out`;
  if (parts.manifest.path !== `${partsRoot}/parts.json`) stale('parts producer root changed');
  boundFile(parts.manifest);
  for (const row of parts.images) boundFile({ path: join(dirname(parts.manifest.path), row.path), sha256: row.sha256 });
  const manifestPath = `review-live-v${'version' in selector ? selector.version : -1}.json`;
  let manifest: JsonObject;
  try { manifest = JSON.parse(publicationFile(root, manifestPath).toString('utf8')); }
  catch { return stale('published review manifest is absent or unreadable'); }
  if (manifest.id !== source.package.id || manifest.revision !== source.package.revision
    || manifest.model !== source.model!.path || (manifest.direction ?? null) !== (source.direction?.path ?? null)) stale('published package identity changed');
  if (source.plan) {
    const plan = object(project.plan) ? project.plan : null;
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    if (!isDeepStrictEqual(source.plan.steps, steps.map(raw => ({ id: object(raw) ? raw.id : null, hash: object(raw) ? stepHash(raw) : null })))) stale('displayed plan step identities changed');
  }
}

export function reviewActVerdict(act: ReviewVerdictAct): JsonObject {
  return { by: act.authority.reviewer.role === 'owner' ? 'user' : 'delegate', at: act.at,
    review: act.value.stage, verdict: { approved: 'accepted', 'changes-requested': 'bounced', pending: 'provisional' }[act.value.verdict],
    verbatim: act.value.words, source: `review act ${act.jobId}/${act.actId}`, on_items: [] };
}

/** Ledger validation deliberately checks retained evidence, not current sources. */
export function reviewActFindings(project: JsonObject): { code: string; path: string; message: string }[] {
  if (project.review_acts === undefined) return [];
  const findings: { code: string; path: string; message: string }[] = [];
  const seen = new Set<string>();
  const targets = new Set<string>();
  const add = (code: string, path: string, detail: string): void => { findings.push({ code, path, message: `${path}: ${detail}; restore the original act receipt and its recorded verdict` }); };
  if (!Array.isArray(project.review_acts)) { add('REVIEW_ACT_LEDGER_INVALID', 'review_acts', 'expected a replay ledger array'); return findings; }
  project.review_acts.forEach((entry, index) => {
    const path = `review_acts[${index}]`;
    if (object(entry) && entry.schema === PARTS_CLI_RECEIPT) return;
    try {
      if (!object(entry) || entry.schema !== 'rig-create/review-act@1' || typeof entry.bytes !== 'string'
        || !sha(entry.sha256) || jobHash(entry.bytes) !== entry.sha256 || !sha(entry.version_hash)) failure('REVIEW_ACT_LEDGER_INVALID', 'receipt shape or bytes hash is invalid');
      const act = decodeReviewAct(entry.bytes, entry.kind === 'parts-verdict' ? 'parts-verdict' : 'review-verdict');
      if (entry.jobId !== act.jobId || entry.actId !== act.actId) failure('REVIEW_ACT_LEDGER_INVALID', 'receipt identity differs from its act');
      const key = JSON.stringify([act.jobId, act.actId]);
      if (seen.has(key)) failure('REVIEW_ACT_REPLAY_CONFLICT', 'duplicate act receipt');
      seen.add(key);
      if (act.kind === 'parts-verdict') {
        if (entry.draft_id !== act.source.selector.id || !file(entry.evidence) || entry.evidence.sha256 !== entry.sha256) failure('REVIEW_ACT_LEDGER_INVALID', 'parts receipt target differs from its act');
        return;
      }
      if (!Number.isSafeInteger(entry.verdict) || Number(entry.verdict) < 0 || entry.version !== ('version' in act.source.selector! ? act.source.selector.version : null)) failure('REVIEW_ACT_LEDGER_INVALID', 'verdict receipt target is invalid');
      const target = JSON.stringify([entry.version, entry.verdict]);
      if (targets.has(target)) failure('REVIEW_ACT_LEDGER_INVALID', 'multiple receipts point to one verdict');
      targets.add(target);
      const version = Array.isArray(project.versions) ? project.versions.find(v => object(v) && v.n === entry.version) : null;
      const verdict = object(version) && Array.isArray(version.verdicts) ? version.verdicts[Number(entry.verdict)] : null;
      if (!isDeepStrictEqual(verdict, reviewActVerdict(act))) failure('REVIEW_ACT_LEDGER_INVALID', 'recorded verdict differs from the immutable act');
      if (act.schema === 'rig-review/act@3') {
        const still = act.still;
        const expected = { kind: 'still', path: `evidence/v${entry.version}/${still.path}`, sha256: still.sha256,
          camera: still.camera, frame: still.frame,
          what: still.frame === 'setup' ? 'Review displayed setup pose' : `Review displayed animation ${JSON.stringify(still.animation)} at ${still.frame} seconds` };
        if (!object(version) || !Array.isArray(version.evidence) || !version.evidence.some(e => isDeepStrictEqual(e, expected))
          || !Array.isArray(entry.added_evidence) || entry.added_evidence.some(e => !isDeepStrictEqual(e, expected))) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'recorded still differs from the immutable act');
        }
      }
    } catch (error) { add(error instanceof Refusal ? error.code : 'REVIEW_ACT_LEDGER_INVALID', path, error instanceof Refusal ? error.message : 'invalid act receipt'); }
  });
  return findings;
}
