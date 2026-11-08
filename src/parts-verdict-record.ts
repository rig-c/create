import { realpathSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';
import { comparePartsVerdictBindings, type FileBinding } from './parts-verdict.ts';
/** Review CLI stdout is retained separately from Review's private saved verdict. */
import { isDeepStrictEqual } from 'node:util';
import { publicationFile } from './job-publication.ts';
import { jobHash } from './job-outbox.ts';
import { decodeReviewAct } from './review-act.ts';
import { Refusal, refuse } from './refusal.ts';
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

export function partsVerdictNames(verdict: JsonObject): { flagged: string[]; noted: string[] } {
  const entries = Object.entries(verdict.parts as JsonObject);
  return {
    flagged: entries.filter(([, part]) => (part as JsonObject).outcome === 'flagged').map(([name]) => name),
    noted: entries.filter(([, part]) => (part as JsonObject).note !== '').map(([name]) => name),
  };
}

/** Compare only recorded hashes. Output paths remain in Review's own frame. */
export function assertPartsReadDraft(root: string, project: JsonObject, verdict: JsonObject, draftId: string): void {
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
  const bytes = publicationFile(realpathSync(root), manifest.path);
  if (jobHash(bytes) !== manifest.sha256) return fail('PARTS_VERDICT_RECEIPT_INVALID', `draft ${draftId}'s parts.json differs from its recorded hash`);
  const declared: unknown = JSON.parse(bytes.toString('utf8'));
  const painting = object(declared) && object(declared.painting_in_rig) ? declared.painting_in_rig.path : undefined;
  const paintingFile = typeof painting === 'string' ? recorded.find(file => file.path === posix.join(String(parts.path), painting)) : undefined;
  if (painting !== undefined && !paintingFile) return fail('PARTS_VERDICT_RECEIPT_INVALID', `draft ${draftId}'s declared painting has no recorded hash`);
  const keep = (file: FileBinding): boolean => paintingFile === undefined || file.sha256 !== paintingFile.sha256;
  const reviewed = ((verdict.source as JsonObject).files as JsonObject[]).map((file, index) => ({ path: `source.files[${index}]`, sha256: String(file.sha256) }));
  const outputs = Array.isArray(draft.files) ? draft.files as FileBinding[] : [];
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
      const bytes = publicationFile(realpathSync(root), String(evidence.path));
      if (jobHash(bytes) !== evidence.sha256) fail('PARTS_VERDICT_RECEIPT_INVALID', `${path}.evidence bytes changed`);
      const verdict = decodePartsRead(bytes);
      const names = partsVerdictNames(verdict);
      if (entry.status !== verdict.status || !isDeepStrictEqual(entry.tool, verdict.tool)
        || !isDeepStrictEqual(entry.flagged, names.flagged) || !isDeepStrictEqual(entry.noted, names.noted)) {
        fail('PARTS_VERDICT_RECEIPT_INVALID', `${path} differs from its retained CLI response`);
      }
      assertPartsReadDraft(root, project, verdict, String(entry.draft_id));
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
  if (!Array.isArray(project.review_acts)) return;
  const entry = [...project.review_acts].reverse().find(entry => object(entry) && entry.kind === 'parts-verdict' && entry.draft_id === draftId);
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
