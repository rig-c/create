/** Member-local departures bind the collection answer they departed from. */
import { asArray, answered, classify, collectItems, collectionAnswer, collectionQuestion, isObject, type Finding } from './check.ts';
import type { JsonObject } from './templates.ts';

export const OVERRIDDEN_ANSWERS_SINCE = '2026-11-06T00:00:00Z';

/** Shared by the record check and the writer, before any write. */
export function overrideFindings(answer: JsonObject, collection: JsonObject | null, path: string): Finding[] {
  const findings: Finding[] = [];
  const add = (code: string, why: string, remedy: string): void => {
    findings.push({ code, path, message: `${path}: ${why}; ${remedy}` });
  };
  const ref = isObject(answer.overrides) ? answer.overrides : {};
  if (collection === null || typeof collection.name !== 'string' || ref.collection !== collection.name) {
    add('OVERRIDE_COLLECTION_INVALID', 'overrides.collection does not name this member\'s collection', 'restore the parent collection and record its name in overrides.collection');
  } else {
    const question = typeof ref.question === 'string' ? collectionQuestion(collection, ref.question) : undefined;
    const current = typeof ref.question === 'string' ? collectionAnswer(collection, ref.question) : undefined;
    const answers = [current, ...asArray(question?.history)].filter(isObject).filter(a => answered(classify(a, { collection: null })));
    if (question === undefined || answers.length === 0) {
      add('OVERRIDE_QUESTION_INVALID', 'overrides.question names no answered collection question', 'reference an answered collection question, retaining its original answer in history');
    } else if (typeof ref.collection_answer_at !== 'string' || !Number.isFinite(Date.parse(ref.collection_answer_at)) || !answers.some(a => a.at === ref.collection_answer_at)) {
      add('OVERRIDE_ANSWER_STALE', 'overrides.collection_answer_at matches no current or historical collection answer', 'restore the referenced collection answer and its exact at timestamp, or ask and record a fresh override');
    }
  }
  if (typeof answer.why_verbatim !== 'string' || !answer.why_verbatim.trim()) {
    add('OVERRIDE_REASON_MISSING', 'why_verbatim is not a nonempty string', 'ask the user why this member differs and record their exact words with interview-answer --why-file');
  }
  return findings;
}

export function checkOverrides(project: JsonObject, collection: JsonObject | null, refusals: Finding[], warnings: Finding[]): void {
  for (const item of collectItems(project, { collection })) {
    const records = [{ answer: item.raw, path: item.path }, ...asArray(item.record.history).map((answer, i) => ({ answer, path: `${item.path.replace(/\.(answer|guide)$/, '')}.history[${i}]` }))];
    for (const { answer, path } of records) {
      if (!isObject(answer) || answer.basis !== 'overridden') continue;
      const at = typeof answer.at === 'string' ? Date.parse(answer.at) : NaN;
      const target = at < Date.parse(OVERRIDDEN_ANSWERS_SINCE) ? warnings : refusals;
      target.push(...overrideFindings(answer, collection, path));
    }
  }
}
