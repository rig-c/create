import { isDeepStrictEqual as equal } from 'node:util';
import { asArray, classify, collectItems, isObject, type Finding } from './check.ts';
import { hasPendingOther, isUndecidedDelegation, optionFile, validateChoice } from './choices.ts';
import { INTAKE_QUESTION, intakeItem } from './intake.ts';
import { jobHash } from './job-outbox.ts';
import { OWNER_CHAT_SOURCE, ownerChatFinding } from './owner-chat.ts';
import { Refusal, refuse } from './refusal.ts';
import { agentUnderOwner, isRecordPicksAct, reviewActFindings, type VerifiedInterviewPick } from './review-act.ts';
import { sorted } from './step-hash.ts';
import type { Json, JsonObject } from './templates.ts';

const FIELD = 'interview_comment_closures';
const CODE = 'INTERVIEW_COMMENT_CLOSURE_INVALID';
type Source = { jobId: string; actId: string; question: string; order: number };
type AnswerResolution = { kind: 'answer'; question: string } & (
  { jobId: string; actId: string } | { answer_sha256: string }
);
type Resolution = { kind: 'no-change' } | AnswerResolution;
type Closure = Source & { by: 'agent'; at: string; reason: string; resolution: Resolution };

const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const actKey = (jobId: Json | undefined, actId: Json | undefined): string => JSON.stringify([jobId, actId]);
const sourceKey = (row: JsonObject): string => JSON.stringify([row.jobId, row.actId, row.order]);

function clock(value: unknown): number {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? Date.parse(value) : NaN;
}

function invalid(path: string, detail: string): never {
  refuse(CODE, `project.json.${path}: ${detail}; use interview-answer --close-comment with the retained route, an agent reason, and any completed answer evidence`);
}

function counts<T>(values: T[], keyOf: (value: T) => string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const value of values) {
    const key = keyOf(value);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return totals;
}

function evidenceContext(dir: string, project: JsonObject, picks: readonly VerifiedInterviewPick[]) {
  const receiptCounts = counts(asArray(project.review_acts).filter(isObject), row => actKey(row.jobId, row.actId));
  const items = collectItems(project, { collection: null });
  const uniqueItem = (question: string) => {
    if (question === INTAKE_QUESTION) return intakeItem(project);
    const matches = items.filter(item => item.id === question);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const unambiguous = (pick: VerifiedInterviewPick) => pick.answers.length === 1
    && receiptCounts.get(actKey(pick.act.jobId, pick.act.actId)) === 1;

  function sourceReceipt(source: Source, path: string) {
    const pick = picks.find(({ act }) => act.jobId === source.jobId && act.actId === source.actId);
    if (!pick || !unambiguous(pick) || !uniqueItem(source.question) || pick.route?.question !== source.question
      || !Number.isSafeInteger(source.order) || source.order < 1
      || pick.route.comments[source.order - 1]?.order !== source.order) {
      invalid(path, 'source must identify one verified routed interview comment by job, act, question and one-based order');
    }
    return pick;
  }

  function answerResolution(question: string, after: number, at: number, path: string, expected?: JsonObject): AnswerResolution {
    const item = nonblank(question) ? uniqueItem(question) : undefined;
    if (!item) invalid(path, `answer question ${JSON.stringify(question)} does not identify one local record`);
    const answers = [item.raw, ...asArray(item.record.history)].filter(isObject);
    const matches = answers.flatMap((answer): AnswerResolution[] => {
      if (answer.basis === 'inherited' || !(clock(answer.at) > after && clock(answer.at) <= at)) return [];
      const revision = { ...item, raw: answer, state: classify(answer, { collection: null }) };
      if ((revision.state.state !== 'user' && revision.state.state !== 'delegated')
        || hasPendingOther(revision) || isUndecidedDelegation(revision)
        || (isObject(answer.agent_decision) && !(clock(answer.agent_decision.at) <= at))) return [];

      const receipts = picks.filter(pick => pick.act.value.questionId === question && pick.answers.includes(answer));
      const [receipt] = receipts;
      let resolution: AnswerResolution;
      if (receipt) {
        if (receipts.length !== 1 || !unambiguous(receipt) || agentUnderOwner(receipt.act)
          || answer.source === OWNER_CHAT_SOURCE || ownerChatFinding(answer, item.path)) return [];
        resolution = { kind: 'answer', question, jobId: receipt.act.jobId, actId: receipt.act.actId };
      } else {
        if (answer.source !== OWNER_CHAT_SOURCE || !nonblank(answer.owner_words) || !nonblank(answer.by)
          || answer.by.trim().toLowerCase() === 'agent' || ownerChatFinding(answer, item.path)) return [];
        // Rig feedback can append guide additions in place. The relay revision stays the same.
        const { additions: _additions, ...relay } = answer;
        resolution = { kind: 'answer', question, answer_sha256: jobHash(JSON.stringify(sorted(relay))) };
      }
      if (expected && !equal(resolution, expected)) return [];
      try {
        validateChoice(dir, project, item, answer);
        if (receipt && isObject(answer.choice)) {
          const { act } = receipt;
          const binding = answer.choice.set;
          if (isRecordPicksAct(act) && (!isObject(binding) || binding.path !== act.source.optionSetFile.path)) return [];
          if (optionFile(dir, binding).set.id !== act.source.optionSet.id) return [];
        }
      }
      catch { return []; }
      return [resolution];
    });
    if (matches.length !== 1) invalid(path, `expected one retained completed Review or owner-chat answer for ${JSON.stringify(question)} after the comment and at or before the closure, found ${matches.length}`);
    return matches[0]!;
  }

  return { sourceReceipt, answerResolution };
}

function validateClosures(project: JsonObject, context: ReturnType<typeof evidenceContext>, now: number) {
  const findings: Finding[] = [];
  const closed = new Set<string>();
  const rows = project[FIELD];
  if (rows === undefined) return { findings, closed };
  const collect = (path: string, validate: () => void) => {
    try { validate(); }
    catch (error) {
      if (!(error instanceof Refusal) || error.code !== CODE) throw error;
      findings.push({ code: CODE, path, message: error.message });
    }
  };
  if (!Array.isArray(rows)) {
    collect(FIELD, () => invalid(FIELD, 'expected an array of comment closures'));
    return { findings, closed };
  }
  const keyCounts = counts(rows.filter(isObject), sourceKey);
  for (const [index, row] of rows.entries()) {
    const path = `${FIELD}[${index}]`;
    collect(path, () => {
      if (!isObject(row) || Object.keys(row).length !== 8 || !nonblank(row.jobId) || !nonblank(row.actId)
        || !nonblank(row.question) || typeof row.order !== 'number' || row.by !== 'agent' || !nonblank(row.reason)
        || !isObject(row.resolution) || !(clock(row.at) <= now)) invalid(path, 'invalid closure identity, fields, reason or clock');
      const source = context.sourceReceipt({ jobId: row.jobId, actId: row.actId, question: row.question, order: row.order }, path);
      const after = clock(source.act.at);
      const at = clock(row.at);
      if (!(after < at)) invalid(path, 'closure must follow the source act');
      if (keyCounts.get(sourceKey(row)) !== 1) invalid(path, 'multiple closures claim this comment');
      if (row.resolution.kind === 'answer' && nonblank(row.resolution.question)) {
        context.answerResolution(row.resolution.question, after, at, path, row.resolution);
      } else if (!equal(row.resolution, { kind: 'no-change' })) invalid(path, 'resolution must identify a retained answer or explicitly record no-change');
      closed.add(`${source.path}.feedback_route.comments[${row.order - 1}]`);
    });
  }
  return { findings, closed };
}

export function checkInterviewCommentClosures(dir: string, project: JsonObject, picks: readonly VerifiedInterviewPick[], now: number) {
  return validateClosures(project, evidenceContext(dir, project, picks), now);
}

export function prepareInterviewCommentClosure(dir: string, project: JsonObject, now: number,
  source: Source, reason: string, answerQuestion: string | undefined): { row: Closure; replay: boolean } {
  const picks: VerifiedInterviewPick[] = [];
  reviewActFindings(project, undefined, undefined, picks);
  const context = evidenceContext(dir, project, picks);
  const key = sourceKey(source);
  const existing = asArray(project[FIELD]).filter(isObject).find(row => sourceKey(row) === key);
  const receipt = context.sourceReceipt(source, FIELD);
  const after = clock(receipt.act.at);
  if (!(after < now) || !nonblank(reason)) invalid(FIELD, 'closure needs a nonblank reason and must follow the source act');

  // A retry names the same question. Keep its original evidence pinned even after a re-answer.
  const resolution = answerQuestion === undefined ? { kind: 'no-change' as const }
    : isObject(existing?.resolution) && existing.resolution.question === answerQuestion
        && clock(existing.at) <= now
      ? context.answerResolution(answerQuestion, after, clock(existing.at), FIELD, existing.resolution)
      : context.answerResolution(answerQuestion, after, now, FIELD);
  const invalidPrior = validateClosures(project, context, now).findings[0];
  if (invalidPrior) refuse(invalidPrior.code, invalidPrior.message);

  const semantic = { ...source, by: 'agent' as const, reason, resolution };
  if (existing) {
    const { at, ...previous } = existing;
    if (!equal(previous, semantic)) invalid(FIELD, 'this comment already has a different closure');
    return { row: { ...semantic, at: String(at) }, replay: true };
  }
  return { row: { ...semantic, at: new Date(now).toISOString() }, replay: false };
}
