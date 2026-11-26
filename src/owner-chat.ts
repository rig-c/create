/** Relayed words retain their own clock; at remains the writer's clock. */
import { asArray, isObject, type Finding } from './check.ts';
import { latestPartsReceipt, latestPartsVerdictFinding, recordedPartsVerdict } from './parts-verdict-record.ts';
import { decodeReviewAct } from './review-act.ts';
import { readVerbatim } from './record-input.ts';
import { acceptedReviewVerdict, readVersions } from './review.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export const OWNER_CHAT_SOURCE = 'owner chat, relayed';
export const OWNER_CHAT_FLAGS = ['--owner-chat', '--said-at', '--relayed-by'];
export const OWNER_CHAT_USAGE = '--by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>';
export const REOPEN_RESTART_OWNER_CHAT_SINCE = '2026-11-19T00:00:00Z';
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const blankValue = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
const ISO_SAID_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

function ownerWordsField(record: JsonObject, path: string): string {
  if (record.owner_words !== undefined) return 'owner_words';
  if (record.verbatim !== undefined) return 'verbatim';
  if (record.reason !== undefined) return 'reason';
  if (/\brestarts(?:\b|\[)/.test(path)) return 'reason';
  if (/\b(?:signoffs|reopens|amendments)(?:\b|\[)/.test(path)) return 'verbatim';
  return 'owner_words';
}

export function ownerChatFinding(record: JsonObject, path: string, words = record.owner_words ?? record.verbatim): Finding | undefined {
  if (record.source !== OWNER_CHAT_SOURCE && record.said_at === undefined && record.relayed_by === undefined && record.owner_words === undefined) return;
  const problems: string[] = [];
  if (record.source !== OWNER_CHAT_SOURCE) {
    problems.push(`\`source\` must be ${JSON.stringify(OWNER_CHAT_SOURCE)}; record relayed chat with --owner-chat --said-at --relayed-by`);
  }
  if (!nonblank(words)) {
    problems.push(`\`${ownerWordsField(record, path)}\` is missing or blank; pass nonblank owner words with --owner-chat <file>`);
  }
  if (!nonblank(record.by)) {
    problems.push('`by` is missing or blank; a person must be named with --by <owner>');
  } else if (record.by.toLowerCase() === 'agent') {
    problems.push('`by` is agent; a person must be named with --by <owner>');
  }
  if (!nonblank(record.relayed_by)) {
    problems.push('`relayed_by` is missing or blank; name the relaying operator with --relayed-by <operator>');
  }
  const said = record.said_at;
  const saidValid = typeof said === 'string' && ISO_SAID_AT.test(said) && Number.isFinite(Date.parse(said));
  if (!saidValid) {
    problems.push(blankValue(said)
      ? '`said_at` is missing or blank; pass an ISO timestamp with timezone to --said-at <ISO>'
      : `\`said_at\` ${JSON.stringify(said)} is not a valid ISO timestamp with timezone; pass --said-at <ISO>`);
  }
  const atText = String(record.at);
  const atMs = Date.parse(atText);
  const atValid = Number.isFinite(atMs);
  if (!atValid) {
    problems.push(blankValue(record.at)
      ? '`at` is missing or blank; keep the write timestamp `at` on the record'
      : `\`at\` ${JSON.stringify(record.at)} is not a valid timestamp; keep the write timestamp \`at\` on the record`);
  }
  if (saidValid && atValid && Date.parse(said) > atMs) {
    problems.push(`\`said_at\` ${said} is after the write time \`at\` ${atText}; pass the time the owner spoke with --said-at, not a later one`);
  }
  const actFields = (['actId', 'act_id'] as const).filter(key => record[key] !== undefined);
  if (actFields.length > 0) {
    problems.push(`${actFields.map(key => `\`${key}\``).join(' and ')} must be absent on relayed owner chat; omit Review act ids`);
  }
  if (problems.length > 0) {
    return { code: 'OWNER_CHAT_INVALID', path, message: `${path}: ${problems.join('. ')}` };
  }
}

/** Reopen and restart need attributed owner authority; only reopen can carry a Review receipt. */
export function ownerChatAuthorityFinding(record: JsonObject, path: string, words: JsonObject[string], viaReview = false): Finding | undefined {
  return ownerChatFinding(record, path, words) ?? (viaReview || record.source === OWNER_CHAT_SOURCE ? undefined : {
    code: 'OWNER_CHAT_REQUIRED', path,
    message: `${path}: missing owner authority; relay the owner's exact words with --by --owner-chat --said-at --relayed-by`,
  });
}

export function readOwnerChat(opts: Record<string,string>, by: string, now: number, path: string, required = false): JsonObject | undefined {
  if (required) {
    const missing = OWNER_CHAT_FLAGS.filter(flag => !nonblank(opts[flag]));
    if (missing.length) refuse('OWNER_CHAT_REQUIRED', `${path}: missing ${missing.join(', ')}; relay the owner's approval with ${OWNER_CHAT_USAGE}`, USAGE_EXIT);
  }
  if (!OWNER_CHAT_FLAGS.some(flag => opts[flag] !== undefined)) return;
  if (OWNER_CHAT_FLAGS.some(flag => !nonblank(opts[flag]))) refuse('OWNER_CHAT_INVALID', `${path}: --owner-chat, --said-at and --relayed-by are required together; supply the words file and explicit owner clock and relay`, USAGE_EXIT);
  if (opts['--from-review'] !== undefined || opts['--verbatim-file'] !== undefined || opts['--source'] !== undefined) refuse('OWNER_CHAT_INVALID', `${path}: owner chat excludes --from-review, --verbatim-file and --source; retain the relayed source`, USAGE_EXIT);
  const record: JsonObject = {by, at:new Date(now).toISOString(), owner_words:readVerbatim(opts['--owner-chat']!),
    said_at:opts['--said-at']!,relayed_by:opts['--relayed-by']!,source:OWNER_CHAT_SOURCE};
  const finding = ownerChatFinding(record,path);
  if (finding) refuse(finding.code,finding.message);
  return record;
}

/** Select the current subject as next does, then require an accepted verdict still live at this review stage. */
export function ownerChatSignoffAllowed(dir: string, project: JsonObject, stage: string, draft?: string, version?: string): boolean {
  const reopens = collectReopens(project,[]);
  if (stage === 'parts-review') {
    const current = asArray(project.drafts).filter(isObject).at(-1);
    if (!current || typeof current.id !== 'string' || (draft !== undefined && draft !== current.id)) return false;
    const receipt = latestPartsReceipt(project,current.id);
    if (!receipt || latestPartsVerdictFinding(project,current.id,'signoffs.draft_id')) return false;
    try {
      const at = receipt.schema === 'rig-create/review-act@1' ? decodeReviewAct(String(receipt.bytes),'parts-verdict').at : receipt.at;
      if (!Number.isFinite(Date.parse(String(at))) || !liveSignoff(reopens,'parts-review',Date.parse(String(at)))) return false;
      recordedPartsVerdict(dir,project,current.id); return true;
    } catch { return false; }
  }
  if (stage !== 'rig-review' && stage !== 'direction-review') return true;
  const phase = stage === 'rig-review' ? 'rigging' : 'post';
  const current = asArray(project.versions).filter(isObject).filter(v => v.kind === (stage === 'rig-review' ? 'rig' : 'post')
    && (stage === 'rig-review' || liveSignoff(reopens,phase,Date.parse(String(v.at))))).at(-1);
  if (!current || (version !== undefined && String(current.n) !== version)) return false;
  if (stage === 'rig-review' && !readVersions(project).rigs.some(rig => rig.n === current.n && rig.live)) return false;
  const index = acceptedReviewVerdict(current,stage);
  const verdict = asArray(current.verdicts)[index];
  return isObject(verdict) && liveSignoff(reopens,stage,Date.parse(String(verdict.at)));
}

export function assertOwnerChatSignoff(dir: string, project: JsonObject, stage: string, draft?: string, version?: string): void {
  if (ownerChatSignoffAllowed(dir,project,stage,draft,version)) return;
  const route = stage === 'parts-review' ? '--draft <current-draft>' : '--rig <current-version>';
  refuse('OWNER_CHAT_GATE_VISUAL', `project.json.signoffs.${stage}: an accepted live verdict for the current subject is required; get the verdict in the review tool first with rig-create job open ${route}, ingest it, then relay the owner's signoff`);
}
