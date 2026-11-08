/** Collection question writes preserve all bytes outside the answer and history values. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { asArray, isObject, COLLECTION_SCHEMA, type Finding } from './check.ts';
import { COLLECTION_STAGE_VALUES } from './collection.ts';
import { checkCollectionRecord } from './pins-check.ts';
import type { CommandResult } from './interview.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

/** Locate JSON value spans by structural path, retaining whitespace and unrelated spellings. */
function valueSpans(bytes: string): Map<string, [number, number]> {
  const tokens = [...bytes.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)];
  const spans = new Map<string, [number, number]>();
  let cursor = 0;
  function value(path: (string | number)[]): void {
    const start = cursor;
    const token = tokens[cursor++]![0];
    if (token === '{') {
      while (tokens[cursor]![0] !== '}') {
        const key = JSON.parse(tokens[cursor++]![0]) as string;
        cursor++; // colon
        value([...path, key]);
        if (tokens[cursor]![0] === ',') cursor++;
      }
      cursor++;
    } else if (token === '[') {
      let index = 0;
      while (tokens[cursor]![0] !== ']') {
        value([...path, index++]);
        if (tokens[cursor]![0] === ',') cursor++;
      }
      cursor++;
    }
    const first = tokens[start]!;
    const last = tokens[cursor - 1]!;
    spans.set(JSON.stringify(path), [first.index!, last.index! + last[0].length]);
  }
  value([]);
  return spans;
}

export function collectionAnswerCommand(args: string[], now: number): CommandResult {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const allowed = ['--by', '--value-file', '--defer-until', '--reason-file'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) positional.push(arg);
    else {
      const next = args[++i];
      if (!allowed.includes(arg) || flags[arg] !== undefined || !next || next.startsWith('--')) {
        refuse('COLLECTION_USAGE', 'collection answer: supply a question, --by and exactly one of --value-file or --defer-until with --reason-file', USAGE_EXIT);
      }
      flags[arg] = next;
    }
  }
  if (positional.length < 1 || positional.length > 2 || !flags['--by']?.trim()
    || Boolean(flags['--value-file']) === Boolean(flags['--defer-until'])
    || Boolean(flags['--defer-until']) !== Boolean(flags['--reason-file'])) {
    refuse('COLLECTION_USAGE', 'collection answer: supply a question, --by and exactly one of --value-file or --defer-until with --reason-file', USAGE_EXIT);
  }
  const dir = resolve(positional[1] ?? process.cwd());
  const file = join(dir, 'collection.json');
  let bytes: string;
  let original: JsonObject;
  try {
    bytes = readFileSync(file, 'utf8');
    const parsed: Json = JSON.parse(bytes);
    if (!isObject(parsed)) throw Error('expected an object');
    original = parsed;
  } catch {
    refuse('COLLECTION_JSON_INVALID', `${file}: cannot read a JSON object; restore collection.json before recording an answer`);
  }
  if (original.schema !== COLLECTION_SCHEMA) refuse('SCHEMA_UNKNOWN', `collection.json: expected ${COLLECTION_SCHEMA}; restore the collection record`);
  const stage = original.stage;
  if (typeof stage !== 'string' || !COLLECTION_STAGE_VALUES.includes(stage)) refuse('STAGE_UNKNOWN', 'collection.json stage: restore a known collection stage before recording an answer');
  const candidate = structuredClone(original);
  const interview = isObject(candidate.interview) ? candidate.interview : {};
  const questions = asArray(interview.questions);
  const index = questions.findIndex(q => isObject(q) && q.id === positional[0] && q.scope === 'collection');
  const question = questions[index];
  if (!isObject(question) || !('answer' in question)) refuse('ANSWER_MALFORMED', `interview.questions[${positional[0]}].answer: choose an existing collection-scope question in collection.json`);
  const path = `interview.questions[${positional[0]}].answer`;
  const at = new Date(now).toISOString();
  let answer: Json;
  try {
    answer = flags['--value-file']
      ? JSON.parse(readFileSync(resolve(dir, flags['--value-file']), 'utf8')) as Json
      : { deferred: { by: flags['--by']!, at, reason: readFileSync(resolve(dir, flags['--reason-file']!), 'utf8'), until_stage: flags['--defer-until']! } };
  } catch {
    refuse('ANSWER_MALFORMED', `${path}: cannot read the answer JSON or reason file; supply a readable file`);
  }
  if (flags['--value-file']) {
    if (!isObject(answer) || 'deferred' in answer || answer.basis === 'inherited') refuse('ANSWER_MALFORMED', `${path}: --value-file needs an ordinary answer object; use --defer-until for a deferral`);
    answer = { ...answer, by: flags['--by']!, at };
  }
  const before: Finding[] = [];
  const effective = checkCollectionRecord(original, stage, before);
  question.answer = answer;
  if (Array.isArray(question.history)) {
    const priorInterview = original.interview as JsonObject;
    const prior = (priorInterview.questions as JsonObject[])[index]!.answer;
    if (prior !== null && prior !== undefined) question.history.push(prior);
  }
  const after: Finding[] = [];
  checkCollectionRecord(candidate, stage, after);
  if (flags['--defer-until'] && COLLECTION_STAGE_VALUES.includes(flags['--defer-until'])
    && COLLECTION_STAGE_VALUES.indexOf(flags['--defer-until']) <= COLLECTION_STAGE_VALUES.indexOf(effective)) {
    refuse('ANSWER_MALFORMED', `${path}: until_stage must be later than ${effective}; choose a later lifecycle stage`);
  }
  const counts = new Map<string, number>();
  for (const finding of before) {
    const key = `${finding.code}:${finding.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const finding of after) {
    const key = `${finding.code}:${finding.path}`;
    const count = counts.get(key) ?? 0;
    if (finding.path === path || count === 0) refuse(finding.code, finding.message);
    counts.set(key, count - 1);
  }
  const spans = valueSpans(bytes);
  const edits = ['answer', ...(Array.isArray(question.history) ? ['history'] : [])].map(field => {
    const span = spans.get(JSON.stringify(['interview', 'questions', index, field]));
    if (!span) refuse('ANSWER_MALFORMED', `${path}: missing ${field} value; restore the collection question`);
    return { start: span[0], end: span[1], text: JSON.stringify(question[field]) };
  });
  let output = bytes;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  if (readFileSync(file, 'utf8') !== bytes) refuse('ANSWER_MALFORMED', `${path}: collection.json changed while recording; reread it and retry`);
  const temporary = join(dir, `.collection-answer-${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, output, { flag: 'wx' });
  renameSync(temporary, file);
  return { stdout: `collection answer: recorded ${path}; collection.json is written, not committed.`, exit: 0 };
}
