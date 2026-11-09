import { draftFileUnavailable, draftInputUnavailable } from './drafts.ts';
import { checkPartsActEvidence, partsActDraftHash, partsActFindings } from './parts-act.ts';
import { realpathSync } from './check-reads.ts';
import { isAbsolute, posix, resolve } from 'node:path';
import { comparePartsVerdictBindings, type FileBinding } from './parts-verdict.ts';
/** Review CLI stdout is retained separately from Review's private saved verdict. */
import { isDeepStrictEqual } from 'node:util';
import { publicationFile } from './job-publication.ts';
import { jobHash } from './job-outbox.ts';
import { decodeReviewAct, reviewActFindings } from './review-act.ts';
import { Refusal, refuse } from './refusal.ts';
import { ReviewReadError, storedReviewRead } from './review-read.ts';
import type { Finding } from './check.ts';
import type { JsonObject } from './templates.ts';

export const PARTS_CLI_RECEIPT = 'rig-create/parts-verdict-cli@1';
export const PARTS_VERDICT_LATEST_SINCE = '2026-11-08T00:00:00Z';
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code: string, detail: string): never => refuse(code, `project.json.review_acts: ${detail}; query the labelled draft with rig-review parts --format json and record its response again`);

export function decodePartsRead(bytes: Buffer): JsonObject {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('PARTS_REVIEW_CLI_INVALID', 'CLI stdout must be a UTF-8 JSON object'); }
  if (!object(value) || !['rig-review-parts-verdict/1', 'rig-review-parts-verdict/2'].includes(String(value.schema))
    || !['approved', 'changes-requested', 'pending'].includes(String(value.status))
    || !object(value.tool) || typeof value.tool.name !== 'string' || !value.tool.name || typeof value.tool.version !== 'string' || !value.tool.version
    || !object(value.source) || !sha(value.source.sha256) || !Array.isArray(value.source.files) || !value.source.files.length
    || !value.source.files.every(file => object(file) && sha(file.sha256)) || !object(value.parts)) {
    return fail('PARTS_REVIEW_CLI_INVALID', 'CLI response needs a supported schema, status, tool, source hashes and per-part outcomes');
  }
  for (const part of Object.values(value.parts)) {
    if (!object(part) || !['clean', 'flagged', 'pending'].includes(String(part.outcome)) || typeof part.note !== 'string') {
      return fail('PARTS_REVIEW_CLI_INVALID', 'each CLI part needs its outcome and note');
    }
  }
  return value;
}

/** Bind a parts receipt's stdout through the shared stored-read validator, keeping this route's codes. */
function partsStdout(root: string, evidence: JsonObject, path: string): Buffer {
  try { return storedReviewRead(root, evidence); }
  catch (error) {
    if (!(error instanceof ReviewReadError)) throw error;
    if (error.reason === 'unavailable') return refuse('JOB_PUBLICATION_INVALID', `project.json: ${String(evidence.path)} must be a regular source without symlinks; restore its retained bytes`);
    return fail('PARTS_VERDICT_RECEIPT_INVALID', `${path}.evidence ${error.reason === 'changed' ? 'bytes changed' : error.why}`);
  }
}

export function partsVerdictNames(verdict: JsonObject): { flagged: string[]; noted: string[] } {
  const entries = Object.entries(verdict.parts as JsonObject);
  return {
    flagged: entries.filter(([, part]) => (part as JsonObject).outcome === 'flagged').map(([name]) => name),
    noted: entries.filter(([, part]) => (part as JsonObject).note !== '').map(([name]) => name),
  };
}

/** Compare only recorded hashes. Output paths remain in Review's own frame. */
export function assertPartsReadDraft(root: string, project: JsonObject, verdict: JsonObject, draftId: string, options: { requireAvailable?: boolean } = {}): void {
  const drafts = Array.isArray(project.drafts) ? project.drafts.filter(d => object(d) && d.id === draftId) : [];
  const draft = drafts[0];
  if (drafts.length !== 1 || !object(draft) || !object(draft.parts) || !Array.isArray(draft.parts.files)
    || !draft.parts.files.length || !draft.parts.files.every(file => object(file) && sha(file.sha256))) {
    return fail('PARTS_VERDICT_RECEIPT_INVALID', `draft ${draftId} needs unique recorded parts file hashes`);
  }
  const parts = draft.parts;
  const recorded = parts.files as FileBinding[];
  const manifest = recorded.find(file => file.path === `${parts.path}/parts.json`);
  if (!manifest) return fail('PARTS_VERDICT_RECEIPT_INVALID', `draft ${draftId} has no bound parts.json`);
  if (draftFileUnavailable(root, manifest.path, `derived/drafts/${draftId}`)) {
    const source = (verdict.source as JsonObject).files as JsonObject[];
    if (options.requireAvailable === false && source.some(file => file.sha256 === manifest.sha256)) return;
    return fail('PARTS_VERDICT_RECEIPT_INVALID', `draft ${draftId}'s parts.json is unavailable; restore its recorded bytes`);
  }
  const bytes = publicationFile(realpathSync(root), manifest.path);
  if (jobHash(bytes) !== manifest.sha256) return fail('PARTS_VERDICT_RECEIPT_INVALID', `draft ${draftId}'s parts.json differs from its recorded hash`);
  const declared: unknown = JSON.parse(bytes.toString('utf8'));
  const painting = object(declared) && object(declared.painting_in_rig) ? declared.painting_in_rig.path : undefined;
  const paintingFile = typeof painting === 'string' ? recorded.find(file => file.path === posix.join(String(parts.path), painting)) : undefined;
  if (painting !== undefined && !paintingFile) return fail('PARTS_VERDICT_RECEIPT_INVALID', `draft ${draftId}'s declared painting has no recorded hash`);
  const keep = (file: FileBinding): boolean => paintingFile === undefined || file.sha256 !== paintingFile.sha256;
  const reviewed = ((verdict.source as JsonObject).files as JsonObject[]).map((file, index) => ({ path: `source.files[${index}]`, sha256: String(file.sha256) }));
  const outputs = Array.isArray(draft.files) ? draft.files as FileBinding[] : [];
  const reviewedHashes = new Set(reviewed.map(file => file.sha256));
  for (const file of [...recorded, ...outputs.filter(file => reviewedHashes.has(file.sha256))]) {
    if (options.requireAvailable === false && draftFileUnavailable(root, file.path, `derived/drafts/${draftId}`)) continue;
    if (jobHash(publicationFile(realpathSync(root), file.path)) !== file.sha256) {
      fail('PARTS_VERDICT_RECEIPT_INVALID', `draft ${draftId}'s reviewed file ${file.path} differs from its recorded hash`);
    }
  }
  const { verdictOnly, draftOnly } = comparePartsVerdictBindings(reviewed.filter(keep), recorded.filter(keep), outputs);
  if (verdictOnly.length || draftOnly.length) fail('PARTS_VERDICT_DRAFT_MISMATCH', `CLI source hashes do not match draft ${draftId}: ${verdictOnly.length} unbound source file(s), ${draftOnly.length} missing part file(s)`);
}

export function partsReadFindings(root: string, project: JsonObject): Finding[] {
  if (!Array.isArray(project.review_acts)) return [];
  const seen = new Set<string>();
  return project.review_acts.flatMap((entry, index) => {
    if (!object(entry) || entry.schema !== PARTS_CLI_RECEIPT) return [];
    const path = `review_acts[${index}]`;
    try {
      if (entry.kind !== 'parts-verdict' || entry.route !== 'cli' || typeof entry.draft_id !== 'string'
        || typeof entry.by !== 'string' || !entry.by.trim() || entry.by.toLowerCase() === 'agent'
        || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
        || !Array.isArray(entry.argv) || !entry.argv.length || !entry.argv.every(arg => typeof arg === 'string')
        || !object(entry.evidence) || !sha(entry.evidence.sha256)
        || entry.evidence.path !== `evidence/review-reads/${entry.evidence.sha256}.json`) {
        fail('PARTS_VERDICT_RECEIPT_INVALID', `${path} has invalid CLI receipt metadata`);
      }
      assertPartsCliArgs(entry.argv as string[]);
      const evidence = entry.evidence as JsonObject;
      const verdict = decodePartsRead(partsStdout(root, evidence, path));
      const names = partsVerdictNames(verdict);
      if (entry.status !== verdict.status || !isDeepStrictEqual(entry.tool, verdict.tool)
        || !isDeepStrictEqual(entry.flagged, names.flagged) || !isDeepStrictEqual(entry.noted, names.noted)) {
        fail('PARTS_VERDICT_RECEIPT_INVALID', `${path} differs from its retained CLI response`);
      }
      assertPartsReadDraft(root, project, verdict, String(entry.draft_id), { requireAvailable: false });
      const key = JSON.stringify([entry.draft_id, evidence.sha256]);
      if (seen.has(key)) fail('PARTS_VERDICT_RECEIPT_INVALID', `${path} repeats an earlier CLI receipt`);
      seen.add(key);
      return [];
    } catch (error) {
      return [{ code: error instanceof Refusal ? error.code : 'PARTS_VERDICT_RECEIPT_INVALID', path,
        message: error instanceof Refusal ? error.message : `${path}: retained CLI response is unavailable; restore its exact bytes` }];
    }
  });
}

/** Both routes append to one ledger, so its order also determines the current verdict. */
export function latestPartsVerdictFinding(project: JsonObject, draftId: string, path: string): Finding | undefined {
  const entry = latestPartsReceipt(project, draftId);
  if (!object(entry)) return;
  let status = entry.status;
  if (entry.schema !== PARTS_CLI_RECEIPT) {
    try { status = decodeReviewAct(String(entry.bytes), 'parts-verdict').value.verdict; }
    catch { return; } // The act reader reports malformed receipts.
  }
  if (status === 'changes-requested') return { code: 'PARTS_VERDICT_LATEST_NOT_APPROVED', path,
    message: `${path}: draft ${draftId}'s latest parts verdict requests changes; record a newer approved verdict with parts-review before signing` };
}

export function assertPartsCliArgs(args: string[]): void {
  for (const arg of args) {
    const value = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    const normalized = posix.normalize(value.replaceAll('\\', '/'));
    if (arg === '--' || arg === '--format' || arg.startsWith('--format=') || isAbsolute(value) || /^[A-Za-z]:/.test(value)
      || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
      refuse('PARTS_REVIEW_CLI_ARGUMENT_INVALID', 'project.json.review_acts.argv: pass project-relative CLI arguments without escapes and let create supply --format json');
    }
  }
}

/** Legacy file bindings remain historical records without opening Review's saved files. */
export const PARTS_VERDICT_RECEIPT_SINCE = '2026-11-08T00:00:00Z';

export function latestPartsReceipt(project: JsonObject, draftId: string): JsonObject | undefined {
  return Array.isArray(project.review_acts) ? [...project.review_acts].reverse().find(
    entry => object(entry) && entry.kind === 'parts-verdict' && entry.draft_id === draftId,
  ) as JsonObject | undefined : undefined;
}

/** Shared by both writers and check. Reads only the response retained by parts-review. */
export function recordedPartsVerdict(root: string, project: JsonObject, draftId: unknown, evidence?: unknown, options: { requireAvailable?: boolean } = {}): { evidence: JsonObject; partsFile: string } {
  if (typeof draftId !== 'string' || !draftId) return fail('PARTS_VERDICT_RECEIPT_REQUIRED', 'signoffs.parts-review.draft_id needs a recorded draft id');
  const entries = Array.isArray(project.review_acts) ? project.review_acts : [];
  const receipt = evidence === undefined ? latestPartsReceipt(project, draftId) : entries.find(entry => object(entry)
    && entry.kind === 'parts-verdict' && entry.draft_id === draftId && object(entry.evidence) && object(evidence)
    && entry.evidence.path === evidence.path && entry.evidence.sha256 === evidence.sha256);
  if (!object(receipt) || !object(receipt.evidence)) {
    const boundPath = object(evidence) && entries.some(entry => object(entry) && entry.kind === 'parts-verdict'
      && entry.draft_id === draftId && object(entry.evidence) && entry.evidence.path === evidence.path);
    if (object(evidence) && (evidence.spec !== undefined || boundPath)) {
      return fail('PARTS_VERDICT_RECEIPT_INVALID', `signoffs.parts-review.evidence differs from its recorded receipt for draft ${draftId}`);
    }
    return fail('PARTS_VERDICT_RECEIPT_REQUIRED', `signoffs.parts-review.evidence needs a parts-review receipt for draft ${draftId}`);
  }
  const invalid = [...reviewActFindings(project), ...partsReadFindings(root, project), ...partsActFindings(root, project)][0];
  if (invalid) refuse(invalid.code, invalid.message);
  const binding = receipt.evidence;
  const bytes = receipt.schema === PARTS_CLI_RECEIPT ? partsStdout(root, binding, 'signoffs.parts-review')
    : publicationFile(realpathSync(root), String(binding.path));
  let partsFile: string;
  const spec = receipt.schema === PARTS_CLI_RECEIPT ? PARTS_CLI_RECEIPT : 'rig-review/act@2';
  if (evidence !== undefined && (!object(evidence) || evidence.kind !== 'parts-verdict'
    || (evidence.spec !== undefined && evidence.spec !== spec))) return fail('PARTS_VERDICT_RECEIPT_INVALID', 'signoffs.parts-review.evidence has an invalid receipt spec');
  if (receipt.schema === PARTS_CLI_RECEIPT) {
    const verdict = decodePartsRead(bytes);
    assertPartsReadDraft(root, project, verdict, draftId, options);
    if (verdict.status !== 'approved') return fail('PARTS_VERDICT_NOT_APPROVED', `signoffs.parts-review.evidence for draft ${draftId} is not approved`);
    const draft = (project.drafts as JsonObject[]).find(draft => draft.id === draftId)!;
    partsFile = resolve(root, String((draft.parts as JsonObject).path), 'parts.json');
  } else {
    if (receipt.schema !== 'rig-create/review-act@1') return fail('PARTS_VERDICT_RECEIPT_INVALID', 'signoffs.parts-review.evidence names an unsupported receipt spec');
    const act = decodeReviewAct(bytes.toString('utf8'), 'parts-verdict');
    if (act.source.selector.id !== draftId) return fail('PARTS_VERDICT_DRAFT_MISMATCH', `signoffs.parts-review.draft_id differs from the retained act for ${draftId}`);
    const draft = (project.drafts as JsonObject[]).find(draft => draft.id === draftId);
    const draftRoot = `derived/drafts/${draftId}`;
    const bound = object(draft) && object(draft.parts) ? [draft.config, ...(draft.parts.files as JsonObject[]), ...(draft.files as JsonObject[])] : [];
    const inputs = object(draft) && Array.isArray(draft.config_inputs) ? draft.config_inputs as JsonObject[] : [];
    const unavailable = options.requireAvailable === false && (bound.some(file => object(file)
      && typeof file.path === 'string' && draftFileUnavailable(root, file.path, draftRoot))
      || inputs.some(file => object(file) && typeof file.path === 'string' && draftInputUnavailable(root, file.path, draftRoot)));
    if (unavailable) {
      if (partsActDraftHash(project, act) !== receipt.version_hash) return fail('PARTS_VERDICT_RECEIPT_INVALID', `draft ${draftId}'s recorded identity changed`);
      if (act.value.verdict !== 'approved') return fail('PARTS_VERDICT_NOT_APPROVED', `signoffs.parts-review.evidence for draft ${draftId} is not approved`);
      partsFile = resolve(root, act.source.parts.manifest.path);
    } else partsFile = checkPartsActEvidence(root, bytes, String(binding.sha256), project);
  }
  return { evidence: { kind: 'parts-verdict', path: binding.path, sha256: binding.sha256, spec }, partsFile };
}

export function recordedPartsFinding(root: string, project: JsonObject, signoff: JsonObject, path: string): Finding | undefined {
  try {
    if (!object(signoff.evidence)) fail('PARTS_VERDICT_RECEIPT_REQUIRED', 'signoffs.parts-review.evidence needs a recorded API receipt');
    recordedPartsVerdict(root, project, signoff.draft_id, signoff.evidence, { requireAvailable: false });
  }
  catch (error) {
    const legacy = error instanceof Refusal && error.code === 'PARTS_VERDICT_RECEIPT_REQUIRED'
      && typeof signoff.at === 'string' && Date.parse(signoff.at) < Date.parse(PARTS_VERDICT_RECEIPT_SINCE);
    return { code: legacy ? 'PARTS_VERDICT_FILE_LEGACY' : error instanceof Refusal ? error.code : 'PARTS_VERDICT_RECEIPT_INVALID', path: `${path}.evidence`,
      message: legacy ? `${path}.evidence: legacy review-saved file binding is preserved; query the reviewed draft through parts-review and record a new signature`
        : error instanceof Refusal ? error.message : `${path}.evidence: retained API response is unavailable; restore the parts-review receipt and its response` };
  }
}
