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
export const REOPEN_RESTART_OWNER_CHAT_SINCE = '2026-11-19T00:00:00Z';
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export function ownerChatFinding(record: JsonObject, path: string, words = record.owner_words ?? record.verbatim): Finding | undefined {
  if (record.source !== OWNER_CHAT_SOURCE && record.said_at === undefined && record.relayed_by === undefined && record.owner_words === undefined) return;
  const said = record.said_at;
  if (record.source !== OWNER_CHAT_SOURCE || !nonblank(words)
    || !nonblank(record.by) || record.by.toLowerCase() === 'agent' || !nonblank(record.relayed_by)
    || typeof said !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(said)
    || !Number.isFinite(Date.parse(said)) || !Number.isFinite(Date.parse(String(record.at)))
    || Date.parse(said) > Date.parse(String(record.at)) || record.actId !== undefined || record.act_id !== undefined) {
    return {code:'OWNER_CHAT_INVALID',path,message:`${path}: relayed owner chat needs exact nonblank words, owner identity, ISO said_at, relayed_by and a separate write at without an act id; record the owner's words with --owner-chat --said-at --relayed-by`};
  }
}

/** Reopen and restart need attributed owner authority; only reopen can carry a Review receipt. */
export function ownerChatAuthorityFinding(record: JsonObject, path: string, words: JsonObject[string], viaReview = false): Finding | undefined {
  return ownerChatFinding(record, path, words) ?? (viaReview || record.source === OWNER_CHAT_SOURCE ? undefined : {
    code: 'OWNER_CHAT_REQUIRED', path,
    message: `${path}: missing owner authority; relay the owner's exact words with --by --owner-chat --said-at --relayed-by`,
  });
}

export function readOwnerChat(opts: Record<string,string>, by: string, now: number, path: string): JsonObject | undefined {
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
