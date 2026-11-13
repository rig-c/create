import { assertDirectionApproval } from './direction.ts';
import { assertFigureMaskApproval } from './figure-mask.ts';
import { assertCorrectionApproval } from './correction-writers.ts';
/**
 * Polish feedback (rig-c/create#9, docs/INTERVIEW.md § Polish feedback):
 * what the user says after seeing a version is kept word for word in that
 * version's `verdicts[]`, tied to the answers it is about (`on_items[]`), and
 * answered by a later version's `answers_feedback`.
 *
 * Two halves:
 * - `rig-create review <version> …` records a verdict. It derives each item's
 *   `answer_was` from the record where the record decides it, refuses a value
 *   the record contradicts, and writes a `not-asked` item as a new sentence in
 *   that answer's `additions[]` (never a silent fix). It never moves `stage`
 *   and never signs anything: a verdict is not a sign-off.
 * - `checkFeedback` runs inside `interview --check`: bounced feedback with a
 *   later version that does not answer it, an answering ref that points at no
 *   verdict, and a `not-asked` item whose sentence was never added are refused
 *   by name; per bounced verdict, its items are counted by cause.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, readFileSync } from './check-reads.ts';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { acquireBoundJobWrite, jobRuntimeExecArgv } from './job-writer.ts';
import { jobHash } from './job-outbox.ts';
import { assertReviewActSource, decodeReviewAct, reviewActFindings, reviewActPublicationWarning, reviewActStill, reviewActTransport, reviewActVerbatim, reviewActVersionHash, type FetchedReviewAct } from './review-act.ts';
import { newRefusals } from './refusal-baseline.ts';
import { ingestedVerdictPairFinding } from './signoff-pair.ts';
import { dirname, join, resolve } from 'node:path';

import { asArray, asString, collectItems, isObject, itemFor, loadCollection, type Ctx, type Item } from './check.ts';
import { draftVersionFindings } from './drafts.ts';
import { answersOf, askAnswers } from './provenance.ts';
import { readVerbatim } from './record-input.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { REVIEW_ACCEPTS } from './stages.ts';
import { WAYPOINT_ASKS } from './waypoints.ts';
import type { Json, JsonObject } from './templates.ts';

export const VERDICTS = ['accepted', 'bounced', 'provisional'] as const;
export const ANSWER_WAS = ['user', 'delegated', 'not-asked'] as const;
type AnswerWas = (typeof ANSWER_WAS)[number];
type Review = keyof typeof REVIEW_ACCEPTS;

/** The `source` of a guide sentence added from feedback on version `n`. */
export function feedbackSource(n: number): string {
  return `polish feedback, v${n}`;
}

function isHuman(by: string | null): boolean {
  return by !== null && by.toLowerCase() !== 'agent';
}

// ------------------------------------------------------ what the record says

/**
 * Which `answer_was` values the record allows for an item, and the one it
 * decides on its own (`derived`), or why the item cannot carry feedback.
 *
 * - A delegation: the agent's decision — `delegated`, nothing else.
 * - A user answer with no `agent_decision`: `user`, unless the feedback names
 *   something the sentence did not cover (`not-asked`), which the record
 *   cannot tell; never `delegated`.
 * - A user answer that left part open (`agent_decision` beside it): any of the
 *   three, and the record cannot choose — the reviewer names it.
 * - No answer: `not-asked`, but the sentence has no guide to be added to;
 *   refused until the item is answered.
 */
type Allowed = { ok: true; derived: AnswerWas | null; allowed: AnswerWas[] } | { ok: false; code: string; why: string };

function allowedFor(item: Item): Allowed {
  const s = item.state;
  switch (s.state) {
    case 'delegated':
      return { ok: true, derived: 'delegated', allowed: ['delegated'] };
    case 'user':
      return isObject(s.answer.agent_decision)
        ? { ok: true, derived: null, allowed: ['user', 'delegated', 'not-asked'] }
        : { ok: true, derived: 'user', allowed: ['user', 'not-asked'] };
    case 'not_applicable':
      return {
        ok: false,
        code: 'FEEDBACK_ITEM_NOT_APPLICABLE',
        why: `${item.path} is answered not applicable (${String(s.answer.because)}); feedback on it says the plan passes it after all — ask it (the new answer replaces this one, which moves to history[]), then record the verdict`,
      };
    case 'silent':
      return {
        ok: false,
        code: 'FEEDBACK_ITEM_SILENT',
        why: `${item.path} has no answer, so a not-asked sentence has no guide to join; hold that question first (the user answers or delegates it), then record the verdict`,
      };
    case 'malformed':
    case 'unresolved':
      return { ok: false, code: 'FEEDBACK_ITEM_SILENT', why: `${item.path} cannot be read (${s.why}); fix the answer first` };
  }
}

/** Validate an explicit delegated feedback ask against one current or historical answer. */
function feedbackAsk(item: Item, ctx: Pick<Ctx, 'collection'>, ask: Json | undefined): { code: string; message: string } | null {
  if (typeof ask !== 'string' || !WAYPOINT_ASKS[item.id]?.some((entry) => entry.id === ask)) {
    return { code: 'FEEDBACK_ASK_UNKNOWN', message: `guide '${item.id}' has no ask ${JSON.stringify(ask ?? null)}; name a canonical ask recorded by this guide` };
  }
  const recorded = askAnswers(item, ctx, ask);
  if (recorded.length === 0) return { code: 'FEEDBACK_ASK_UNRECORDED', message: `guide '${item.id}' does not record ask '${ask}'; record its delegation before naming it in feedback` };
  if (!recorded.some((answer) => asArray(answer.asks).some((entry) => isObject(entry) && entry.id === ask && entry.state === 'delegated'))) {
    return { code: 'FEEDBACK_ASK_STATE', message: `guide '${item.id}' ask '${ask}' is not delegated; use the user's answer as the feedback cause` };
  }
  return null;
}

// -------------------------------------------------------- interview --check

export interface FeedbackSummary {
  /** `versions[v1].verdicts[0]` */
  readonly verdict: string;
  readonly version: number;
  readonly index: number;
  readonly review: string | null;
  readonly by: string | null;
  readonly at: string | null;
  /** The verdict's items by cause: an agent error (`user`), a cost the user chose (`delegated`), a gap in the guides (`not_asked`). */
  readonly items: { user: number; delegated: number; not_asked: number };
  /** The versions whose `answers_feedback` lists this verdict. */
  readonly answered_by: number[];
  /** `true` once a later human acceptance of the same review on the same version withdrew it. */
  readonly withdrawn: boolean;
}

interface VersionRec {
  readonly n: number;
  readonly path: string;
  readonly record: JsonObject;
}

function versionsOf(project: JsonObject): VersionRec[] {
  const out: VersionRec[] = [];
  for (const v of asArray(project.versions)) {
    if (isObject(v) && typeof v.n === 'number' && Number.isInteger(v.n)) out.push({ n: v.n, path: `versions[v${v.n}]`, record: v });
  }
  return out;
}

/** The refs in `answers_feedback`, read leniently; a malformed ref is reported with its index. */
function refsOf(v: VersionRec): { index: number; version: number | null; verdict: number | null }[] {
  return asArray(v.record.answers_feedback).map((r, index) => {
    const version = isObject(r) && typeof r.version === 'number' && Number.isInteger(r.version) ? r.version : null;
    const verdict = isObject(r) && typeof r.verdict === 'number' && Number.isInteger(r.verdict) ? r.verdict : null;
    return { index, version, verdict };
  });
}

/** Shared reference validation. Historical records retain their original target rules. */
export function feedbackReferenceFinding(project: JsonObject, n: number, ref: Json, path: string, humanBounce = false): { code: string; path: string; message: string } | null {
  const bad = (why: string) => ({ code: 'FEEDBACK_REF_UNKNOWN', path, message: `${path}: ${why}` });
  if (!isObject(ref) || typeof ref.version !== 'number' || !Number.isInteger(ref.version) || typeof ref.verdict !== 'number' || !Number.isInteger(ref.verdict)) return bad('an answering ref is { "version": <n>, "verdict": <index into its verdicts[]> }');
  const target = versionsOf(project).find(v => v.n === ref.version);
  const verdict = target === undefined ? undefined : asArray(target.record.verdicts)[ref.verdict];
  if (target === undefined || !isObject(verdict)) return bad(`answers v${ref.version} verdict ${ref.verdict}, and ${target === undefined ? `there is no version ${ref.version}` : `versions[v${ref.version}].verdicts has no index ${ref.verdict}`}`);
  if (ref.version >= n) return bad(`v${n} answers versions[v${ref.version}].verdicts[${ref.verdict}], which is not an earlier version's; a version answers feedback given before it was built`);
  if (humanBounce && (verdict.verdict !== 'bounced' || !isHuman(asString(verdict.by)))) return bad('target must be a human bounced verdict; name an earlier human bounce in answers_feedback');
  return null;
}

/** Repeatable writer input, validated before any outputs are retained. */
export function parseFeedbackAnswers(project: JsonObject, n: number, values: string[]): JsonObject[] {
  const refs: JsonObject[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const match = /^(\d+):(\d+)$/.exec(value);
    const ref = match ? { version: Number(match[1]), verdict: Number(match[2]) } : null;
    const path = `versions[v${n}].answers_feedback[${refs.length}]`;
    const problem = feedbackReferenceFinding(project, n, ref, path, true);
    if (problem) refuse(problem.code, problem.message);
    const key = `${String(ref!.version)}:${String(ref!.verdict)}`;
    if (seen.has(key)) refuse('FEEDBACK_REF_DUPLICATE', `${path}: duplicate ${key}; name each feedback verdict once`);
    seen.add(key);
    refs.push(ref!);
  }
  return refs;
}

/** Feedback refusals and warnings, appended to the context; returns one summary per human bounced verdict. */
export function checkFeedback(ctx: Ctx): FeedbackSummary[] {
  const versions = versionsOf(ctx.project);
  const summaries: FeedbackSummary[] = [];
  const push = (code: string, path: string, message: string): void => {
    ctx.refusals.push({ code, path, message });
  };

  // Every answering ref points at a verdict of an earlier version.
  const answeredBy = new Map<string, number[]>();
  for (const v of versions) {
    for (const ref of refsOf(v)) {
      const path = `${v.path}.answers_feedback[${ref.index}]`;
      const problem = feedbackReferenceFinding(ctx.project, v.n, { version: ref.version, verdict: ref.verdict }, path);
      if (problem) {
        push(problem.code, problem.path, problem.message);
        continue;
      }
      const key = `${ref.version}:${ref.verdict}`;
      answeredBy.set(key, [...(answeredBy.get(key) ?? []), v.n]);
    }
  }

  for (const v of versions) {
    const verdicts = asArray(v.record.verdicts);
    verdicts.forEach((d, index) => {
      const path = `${v.path}.verdicts[${index}]`;
      if (!isObject(d)) {
        push('VERDICT_MALFORMED', path, `${path}: a verdict is { by, at, review, verdict, verbatim, source, on_items[] }`);
        return;
      }
      const preInterview = v.record.pre_interview === true;
      // Imported verdict shape is checked by checkPreInterview, also at handoff.
      if (!preInterview) {
        const problems: string[] = [];
        for (const k of ['by', 'at', 'verbatim']) if (asString(d[k]) === null) problems.push(`no ${k}`);
        if (!(VERDICTS as readonly string[]).includes(d.verdict as string)) problems.push(`verdict is ${JSON.stringify(d.verdict ?? null)} (${VERDICTS.join(', ')})`);
        if (!(typeof d.review === 'string' && d.review in REVIEW_ACCEPTS)) problems.push(`review is ${JSON.stringify(d.review ?? null)} (${Object.keys(REVIEW_ACCEPTS).join(', ')})`);
        if (!Array.isArray(d.on_items)) problems.push('on_items is not a list');
        if (problems.length > 0) push('VERDICT_MALFORMED', path, `${path}: ${problems.join('; ')}`);
      }

      const counts = { user: 0, delegated: 0, not_asked: 0 };
      asArray(d.on_items).forEach((raw, j) => {
        const ipath = `${path}.on_items[${j}]`;
        const id = isObject(raw) ? asString(raw.id) : null;
        const was = isObject(raw) ? raw.answer_was : undefined;
        if (id === null || !(ANSWER_WAS as readonly Json[]).includes(was ?? null)) {
          push('VERDICT_MALFORMED', ipath, `${ipath}: an item is { "id": <answer id>, "answer_was": ${ANSWER_WAS.map((a) => `"${a}"`).join(' | ')} }`);
          return;
        }
        if (was === 'user') counts.user++;
        else if (was === 'delegated') counts.delegated++;
        else counts.not_asked++;
        const item = itemFor(ctx, id);
        if (item === undefined) {
          push('FEEDBACK_ITEM_UNKNOWN', ipath, `${ipath}: '${id}' is no framing, waypoint or post item of this interview; feedback about a decision no waypoint reaches goes to the waypoint it belongs to (an x_ prompt there, INTERVIEW.md § Questions outside this set)`);
          return;
        }
        if (was === 'delegated' && !preInterview) {
          if (isObject(raw) && 'ask' in raw) {
            const problem = feedbackAsk(item, ctx, raw.ask);
            if (problem !== null) push(problem.code, ipath, `${ipath}: ${problem.message}`);
          } else if (answersOf(item, ctx).some((answer) => Array.isArray(answer.asks))) {
            ctx.warnings.push({ code: 'FEEDBACK_ASK_MISSING', path: ipath, message: `${ipath}: guide '${id}' has per-ask coverage; add ask naming the delegated ask this feedback concerns` });
          }
        }
        // Historical feedback predates the guide. Its record is retained here,
        // never promoted into a quotation or an invented interview answer.
        if (was !== 'not-asked' || preInterview) return;
        // The sentence lands in the guide: an addition marked with this version, quoted from this verdict.
        const verbatim = asString(d.verbatim) ?? '';
        const added = answersOf(item, ctx).some((a) =>
          asArray(a.additions).some(
            (add) => isObject(add) && add.source === feedbackSource(v.n) && typeof add.verbatim === 'string' && add.verbatim !== '' && verbatim.includes(add.verbatim),
          ),
        );
        if (!added) {
          push(
            'FEEDBACK_NOT_ADDED',
            ipath,
            `${ipath}: '${id}' was not asked, and ${item.path} has no additions[] entry with source "${feedbackSource(v.n)}" quoting this verdict; the feedback becomes a guide sentence before the next version is built — never a silent fix`,
          );
        }
      });

      if (d.verdict !== 'bounced' || !isHuman(asString(d.by))) return;
      // The last human verdict of a review decides: a later acceptance on the same version withdraws the bounce.
      const withdrawn = verdicts
        .slice(index + 1)
        .some((later) => isObject(later) && later.review === d.review && later.verdict === 'accepted' && isHuman(asString(later.by)));
      const by = answeredBy.get(`${v.n}:${index}`) ?? [];
      summaries.push({
        verdict: path,
        version: v.n,
        index,
        review: asString(d.review),
        by: asString(d.by),
        at: asString(d.at),
        items: counts,
        answered_by: by,
        withdrawn,
      });
      if (withdrawn || by.length > 0) return;
      const later = versions.filter((x) => x.n > v.n).map((x) => `v${x.n}`);
      if (later.length > 0) {
        push(
          'FEEDBACK_UNANSWERED',
          path,
          `${path}: v${v.n} was bounced, and ${later.join(', ')} ${later.length === 1 ? 'was' : 'were'} built since without listing it in answers_feedback ({ "version": ${v.n}, "verdict": ${index} }); the next version answers the feedback it was built from`,
        );
      } else {
        ctx.warnings.push({ code: 'FEEDBACK_OPEN', path, message: `${path}: v${v.n} was bounced and no later version is built yet; the next version lists { "version": ${v.n}, "verdict": ${index} } in answers_feedback` });
      }
    });
  }
  return summaries;
}

/** Lines for the human report: one per bounced verdict, items counted by cause. */
export function formatFeedback(summaries: readonly FeedbackSummary[]): string[] {
  if (summaries.length === 0) return [];
  const total = { user: 0, delegated: 0, not_asked: 0 };
  for (const s of summaries) {
    total.user += s.items.user;
    total.delegated += s.items.delegated;
    total.not_asked += s.items.not_asked;
  }
  const lines = [
    `  feedback: ${summaries.length} bounce${summaries.length === 1 ? '' : 's'}; items ${total.user} user (agent error), ${total.delegated} delegated (the user's chosen cost), ${total.not_asked} not-asked (a guide gap)`,
  ];
  for (const s of summaries) {
    const state = s.withdrawn ? 'withdrawn by a later acceptance' : s.answered_by.length > 0 ? `answered by ${s.answered_by.map((n) => `v${n}`).join(', ')}` : 'not answered';
    lines.push(`    ${s.verdict} (${s.review ?? '?'}): ${s.items.user} user, ${s.items.delegated} delegated, ${s.items.not_asked} not-asked; ${state}`);
  }
  return lines;
}

// ------------------------------------------------------------ review command

export interface ItemArg {
  readonly id: string;
  readonly answerWas: AnswerWas | null;
  readonly ask?: string;
}

export interface ReviewInput {
  readonly version: number;
  readonly verdict: (typeof VERDICTS)[number];
  readonly by: string;
  readonly review: Review;
  readonly verbatim: string;
  readonly source: string;
  readonly items: ItemArg[];
  /** Per not-asked item: the fragment of the verbatim that becomes the guide sentence (default: the whole verbatim). */
  readonly quotes: Record<string, string>;
  /** Per not-asked item: the normalised `value` of the new sentence (default: null — normalise it before the next version). */
  readonly values: Record<string, Json>;
  readonly at?: string;
  readonly answersFeedback?: { version: number; verdict: number }[];
}

export interface RecordedItem {
  readonly id: string;
  readonly answer_was: AnswerWas;
  readonly ask?: string;
  /** How the value was reached: from the record alone, or named by the reviewer and allowed by the record. */
  readonly how: 'derived' | 'named';
  /** For not-asked: where the sentence was added. */
  readonly addition: string | null;
}

export interface Recorded {
  readonly project_dir: string;
  readonly verdict_path: string;
  readonly verdict: JsonObject;
  readonly items: RecordedItem[];
  readonly stage: string | null;
  readonly warnings?: string[];
}

export function readProject(dir: string): { file: string; project: JsonObject } {
  const file = join(dir, 'project.json');
  if (!existsSync(file)) refuse('PROJECT_JSON_MISSING', `${file} does not exist; run in a project folder or name one`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    refuse('PROJECT_JSON_INVALID', `${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) refuse('PROJECT_JSON_INVALID', `${file}: not a JSON object`);
  return { file, project: parsed as JsonObject };
}

/** Appends one verdict to `versions[v<n>].verdicts[]`, writes not-asked sentences into their guides, and saves project.json. Refuses before writing anything. */
export function recordVerdict(projectDirArg: string, input: ReviewInput, now: number): Recorded {
  return writeVerdict(projectDirArg, input, now);
}

function writeVerdict(projectDirArg: string, input: ReviewInput, now: number, fetched?: FetchedReviewAct, warnings: string[] = []): Recorded {
  if (!isHuman(input.by)) refuse('REVIEW_NOT_HUMAN', 'review must name a human, not agent');
  if (input.at !== undefined && !Number.isFinite(Date.parse(input.at))) refuse('REVIEW_OPTION_INVALID', '--at needs a valid timestamp', USAGE_EXIT);
  const dir = resolve(projectDirArg);
  const { file, project } = readProject(dir);
  const originalBytes = readFileSync(file);
  const original = structuredClone(project);
  const version = asArray(project.versions).find((v): v is JsonObject => isObject(v) && v.n === input.version);
  if (version === undefined) refuse('REVIEW_VERSION_UNKNOWN', `versions[] has no version ${input.version}; a verdict is on a version that was shown`);
  const draftProblem = draftVersionFindings(dir, { ...project, versions: [version] })[0];
  if (draftProblem !== undefined) refuse(draftProblem.code, draftProblem.message);
  const vpath = `versions[v${input.version}]`;
  const accepts = REVIEW_ACCEPTS[input.review];
  if (version.kind !== accepts) {
    refuse(
      'REVIEW_WRONG_KIND',
      `${vpath} is a ${JSON.stringify(version.kind ?? null)} version, and ${input.review} reviews ${accepts} versions; rig feedback given at the direction review is recorded on the post version shown, with --review direction-review`,
    );
  }

  const collection = loadCollection(dir);
  const items = collectItems(project, { collection });
  const seen = new Set<string>();
  const recorded: RecordedItem[] = [];
  for (const arg of input.items) {
    if (seen.has(arg.id)) refuse('FEEDBACK_ITEM_DUPLICATE', `--item ${arg.id} is given twice; one entry per answer the feedback touches`, USAGE_EXIT);
    seen.add(arg.id);
    const item = items.find((i) => i.id === arg.id);
    if (item === undefined) {
      refuse(
        'FEEDBACK_ITEM_UNKNOWN',
        `'${arg.id}' is no framing, waypoint or post item of this interview (${items.map((i) => i.id).join(', ')}); feedback about a decision no prompt reaches is asked as an x_ prompt at the waypoint it belongs to (INTERVIEW.md § Questions outside this set) — add the prompt there, then name that waypoint's id`,
      );
    }
    const allowed = allowedFor(item);
    if (!allowed.ok) refuse(allowed.code, `--item ${arg.id}: ${allowed.why}`);
    let was: AnswerWas;
    let how: RecordedItem['how'];
    if (arg.answerWas === null) {
      if (allowed.derived === null) {
        refuse(
          'FEEDBACK_ITEM_AMBIGUOUS',
          `--item ${arg.id}: ${item.path} is a user sentence that left part to the agent (agent_decision covers ${JSON.stringify((item.state.state === 'user' && isObject(item.state.answer.agent_decision) ? item.state.answer.agent_decision.covers : null) ?? 'part')}); the record cannot tell which part the feedback is about — name it: --item ${arg.id}:user | ${arg.id}:delegated | ${arg.id}:not-asked`,
          USAGE_EXIT,
        );
      }
      was = allowed.derived;
      how = 'derived';
    } else {
      if (!allowed.allowed.includes(arg.answerWas)) {
        const recordSays = item.state.state === 'delegated' ? 'a delegation (the user said "auto"; the agent decided)' : 'a user sentence with no delegated part';
        refuse(
          'FEEDBACK_ITEM_CONTRADICTS',
          `--item ${arg.id}:${arg.answerWas}: ${item.path} is ${recordSays}, so answer_was is ${allowed.allowed.join(' or ')}; a bounce on a delegated item is the user's chosen cost, not an agent error — if the user now wants it theirs, record their new answer first`,
        );
      }
      was = arg.answerWas;
      how = allowed.derived === arg.answerWas ? 'derived' : 'named';
    }
    if (arg.ask !== undefined) {
      if (was !== 'delegated') refuse('FEEDBACK_ASK_STATE', `guide '${arg.id}' ask '${arg.ask}': --ask requires delegated feedback`);
      const problem = feedbackAsk(item, { collection }, arg.ask);
      if (problem !== null) refuse(problem.code, problem.message);
    }
    let addition: string | null = null;
    if (was === 'not-asked') {
      if (isObject(item.raw) && item.raw.basis === 'inherited') {
        refuse(
          'FEEDBACK_ITEM_INHERITED',
          `--item ${arg.id}:not-asked: ${item.path} is inherited from the collection; the new sentence belongs in the collection's answer, or this member overrides it with its own (COLLECTIONS.md) — record that first`,
        );
      }
      const quote = input.quotes[arg.id] ?? input.verbatim;
      if (quote === '' || !input.verbatim.includes(quote)) {
        refuse('FEEDBACK_QUOTE_NOT_IN_VERBATIM', `--quote ${arg.id}: ${JSON.stringify(quote)} is not a fragment of the verbatim; the guide sentence is quoted from the feedback, word for word`, USAGE_EXIT);
      }
      addition = quote;
    } else if (input.quotes[arg.id] !== undefined || input.values[arg.id] !== undefined) {
      refuse('FEEDBACK_QUOTE_NOT_NOT_ASKED', `--quote/--value ${arg.id}: '${arg.id}' is ${was}, not not-asked; only a not-asked item becomes a new guide sentence`, USAGE_EXIT);
    }
    recorded.push({ id: arg.id, answer_was: was, ...(arg.ask === undefined ? {} : { ask: arg.ask }), how, addition });
  }
  for (const id of [...Object.keys(input.quotes), ...Object.keys(input.values)]) {
    if (!seen.has(id)) refuse('FEEDBACK_QUOTE_NOT_NOT_ASKED', `--quote/--value ${id}: no --item ${id}`, USAGE_EXIT);
  }

  const refs = asArray(version.answers_feedback);
  const seenRefs = new Set(refs.filter(isObject).map((ref) => `${String(ref.version)}:${String(ref.verdict)}`));
  for (const [index, ref] of (input.answersFeedback ?? []).entries()) {
    const key = `${ref.version}:${ref.verdict}`;
    if (seenRefs.has(key)) refuse('FEEDBACK_REF_DUPLICATE', `answers_feedback already names ${key}`);
    const problem = feedbackReferenceFinding(project, input.version, ref, `${vpath}.answers_feedback[${refs.length + index}]`);
    if (problem) refuse(problem.code, problem.message);
    seenRefs.add(key);
  }

  // Everything checked: write.
  const at = input.at ?? new Date(now).toISOString();
  const verdicts = Array.isArray(version.verdicts) ? version.verdicts : [];
  version.verdicts = verdicts;
  const verdict: JsonObject = {
    by: input.by,
    at,
    review: input.review,
    verdict: input.verdict,
    verbatim: input.verbatim,
    source: input.source,
    on_items: recorded.map((r) => ({ id: r.id, answer_was: r.answer_was, ...(r.ask === undefined ? {} : { ask: r.ask }) })),
  };
  verdicts.push(verdict);
  version.answers_feedback = [...refs, ...(input.answersFeedback ?? [])];
  const verdictPath = `${vpath}.verdicts[${verdicts.length - 1}]`;
  const out: RecordedItem[] = [];
  for (const r of recorded) {
    if (r.addition === null) {
      out.push(r);
      continue;
    }
    const item = items.find((i) => i.id === r.id) as Item;
    const answer = item.raw as JsonObject;
    const additions = Array.isArray(answer.additions) ? answer.additions : [];
    answer.additions = additions;
    additions.push({ by: input.by, at, verbatim: r.addition, value: input.values[r.id] ?? null, source: feedbackSource(input.version) });
    out.push({ ...r, addition: `${item.path}.additions[${additions.length - 1}]` });
  }
  if (verdict.verdict === 'accepted') assertDirectionApproval(dir, project, String(verdict.review), now, input.version);
  if (verdict.verdict === 'accepted' && verdict.review === 'rig-review') assertFigureMaskApproval(dir, project, input.version);
  if (verdict.verdict === 'accepted') assertCorrectionApproval(dir, project, String(verdict.review), now);
  const result = { project_dir: dir, verdict_path: verdictPath, verdict, items: out, stage: asString(project.stage), ...(warnings.length ? { warnings } : {}) };
  const created: string[] = [];
  try {
    const addedEvidence: JsonObject[] = [];
    const still = fetched === undefined ? null : reviewActStill(fetched.act);
    if (fetched !== undefined && still !== null) {
      const png = fetched.stillBytes === undefined ? null : Buffer.from(fetched.stillBytes, 'base64');
      if (!png || jobHash(png) !== still.sha256) refuse('REVIEW_ACT_STILL_INVALID', 'project.json.review_acts: named PNG is missing or mismatched; fetch act.json and its still together');
      const base = `evidence/v${input.version}`;
      const images = [
        { path: `${base}/${still.path}`, bytes: png },
        { path: `${base}/${jobHash(fetched.bytes)}.act.json`, bytes: Buffer.from(fetched.bytes) },
      ];
      for (const image of images) {
        const destination = join(dir, image.path);
        mkdirSync(dirname(destination), { recursive: true });
        if (existsSync(destination)) {
          if (!readFileSync(destination).equals(image.bytes)) refuse('REVIEW_ACT_STILL_INVALID', `${image.path}: retained bytes differ; restore the original export`);
        } else { writeFileSync(destination, image.bytes, { flag: 'wx' }); created.push(destination); }
      }
      const evidence: JsonObject = { kind: 'still', path: images[0].path, sha256: still.sha256,
        camera: still.camera, frame: still.frame,
        what: still.frame === 'setup' ? 'Review displayed setup pose' : `Review displayed animation ${JSON.stringify(still.animation)} at ${still.frame} seconds` };
      const entries = asArray(version.evidence);
      if (!isDeepStrictEqual(entries[0], evidence)) {
        entries.unshift(evidence); addedEvidence.push(evidence);
      }
      version.evidence = entries;
    }
    if (fetched) {
      const receipt = { schema: 'rig-create/review-act@1', jobId: fetched.act.jobId, actId: fetched.act.actId,
        bytes: fetched.bytes, sha256: jobHash(fetched.bytes), version: input.version, verdict: verdicts.length - 1,
        version_hash: reviewActVersionHash(original, fetched.act), added_evidence: addedEvidence };
      project.review_acts = [...asArray(project.review_acts), receipt];
      const invalid = reviewActFindings(project)[0] ?? ingestedVerdictPairFinding(project, input.version, verdicts.length - 1) ?? newRefusals(dir, original, project, { now })[0];
      if (invalid) refuse(invalid.code, invalid.message);
      assertReviewActSource(dir, original, fetched.act);
      if (!readFileSync(file).equals(originalBytes)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during verdict validation; retry against the current live job');
      const temporary = join(dir, `.rig-create-review-act-${randomUUID()}.tmp`);
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(project, null, 2)}\n`);
        fsyncSync(fd);
        renameSync(temporary, file);
        const directory = openSync(dir, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } finally { closeSync(fd); rmSync(temporary, { force: true }); }
      return result;
    }
    const invalid = ingestedVerdictPairFinding(project, input.version, verdicts.length - 1) ?? newRefusals(dir, original, project, { now })[0];
    if (invalid) refuse(invalid.code, invalid.message);
    writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
    return { project_dir: dir, verdict_path: verdictPath, verdict, items: out, stage: asString(project.stage) };
  } catch (error) { for (const path of created) rmSync(path, { force: true }); throw error; }
}

/** The common #184 lock covers fetch, source validation and the atomic write. */
export function recordReviewAct(root: string, requestedVersion: number, actId: string, now: number): Recorded {
  root = resolve(root);
  const release = acquireBoundJobWrite(root);
  try {
    const child = Bun.spawnSync([process.execPath, ...jobRuntimeExecArgv(), fileURLToPath(new URL('./review-act-runtime.ts', import.meta.url))], {
      stdin: Buffer.from(JSON.stringify(reviewActTransport(root, actId))), stdout: 'pipe', stderr: 'pipe',
    });
    let response: { ok: boolean; bytes: string; stillBytes?: string; code: string; message: string };
    try { response = JSON.parse(child.stdout.toString()); }
    catch (error) { if (error instanceof Refusal) throw error; return refuse('REVIEW_ACT_FETCH_REFUSED', 'project.json.review_acts: fetch adapter failed; restore the live Review job'); }
    if (!response.ok || child.exitCode !== 0) refuse(response.code, response.message);
    const act = decodeReviewAct(response.bytes);
    const selector = act.source.selector!;
    if (!('version' in selector) || selector.version !== requestedVersion) refuse('REVIEW_ACT_KIND_MISMATCH', 'project.json.review_acts: act names a different version; invoke review for the displayed version');
    if (Date.parse(act.at) > now) refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: act is dated in the future; restore the clock before recording');
    const { project } = readProject(root);
    const invalid = reviewActFindings(project)[0];
    if (invalid) refuse(invalid.code, invalid.message);
    assertReviewActSource(root, project, act);
    const existing = asArray(project.review_acts).find(entry => isObject(entry) && entry.jobId === act.jobId && entry.actId === act.actId);
    if (isObject(existing)) {
      const sameAct = act.schema === 'rig-review/act@6'
        ? existing.bytes === response.bytes
        : isDeepStrictEqual(JSON.parse(String(existing.bytes)), act);
      if (!sameAct) refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: immutable act changed; restore the original receipt');
      const pair = ingestedVerdictPairFinding(project, requestedVersion, Number(existing.verdict));
      if (pair) refuse(pair.code, pair.message);
      if (existing.version_hash !== reviewActVersionHash(project, act, Number(existing.verdict))) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: reviewed version changed; request a new review act');
      const version = asArray(project.versions).find(v => isObject(v) && v.n === requestedVersion) as JsonObject;
      return { project_dir: root, verdict_path: `versions[v${requestedVersion}].verdicts[${existing.verdict}]`,
        verdict: (version.verdicts as JsonObject[])[Number(existing.verdict)], items: [], stage: asString(project.stage) };
    }
    const warning = reviewActPublicationWarning(root, project, act);
    return writeVerdict(root, { version: requestedVersion,
      verdict: { approved: 'accepted', 'changes-requested': 'bounced', pending: 'provisional' }[act.value.verdict] as ReviewInput['verdict'],
      by: act.authority.reviewer.role === 'owner' ? 'user' : 'delegate', review: act.value.stage as Review,
      verbatim: reviewActVerbatim(act), at: act.at, source: `review act ${act.jobId}/${act.actId}`, items: [], quotes: {}, values: {},
    }, now, { act, bytes: response.bytes, stillBytes: response.stillBytes }, warning ? [warning] : []);
  } finally { release(); }
}

export const REVIEW_HELP = `review:
  <version>        the version shown (3 or v3)
  [<project dir>]  the project folder (default: the current directory)
  --from-review <actId>  fetch a rig/post verdict through the live job writer binding
  --verdict <v>    accepted | bounced | provisional
  --by <who>       who gave it (the user's name or role)
  --review <r>     rig-review (a rig version) | direction-review (a post version)
  --verbatim <s>   the words, exactly as given; stored byte for byte
  --verbatim-file <file>  read UTF-8 words unchanged instead of --verbatim (- reads stdin)
  --at <timestamp>       date the verdict (default: the clock)
  --answers-feedback <version>:<verdict-index>  earlier feedback this version answers, repeatable
  --source <s>     where the words were given (chat, a call, a note)
  --item <id>[:<answer_was>]
                   an answer the feedback is about (a waypoint, framing or post item id), repeatable;
                   answer_was (user | delegated | not-asked) is derived from the record when it decides it,
                   and a value the record contradicts is refused (FEEDBACK_ITEM_CONTRADICTS)
  --ask <id>=<ask-id>  the recorded delegated ask for an --item (optional)
  --quote <id>=<s> for a not-asked item: the fragment of the verbatim that becomes the guide sentence (default: all of it)
  --value <id>=<json>
                   for a not-asked item: the sentence's normalised value (default: null)
  --json           print what was recorded as JSON
  Appends the verdict to versions[v<n>].verdicts[] dated now; a not-asked item is written to that answer's additions[]
  with source "polish feedback, v<n>". Never moves the stage: a verdict is not a sign-off.`;

function parseVersion(s: string | undefined): number {
  const n = s === undefined ? Number.NaN : Number(s.replace(/^v/, ''));
  if (!Number.isInteger(n) || n < 1) refuse('REVIEW_VERSION_INVALID', `review takes a version number first (3 or v3), got ${s ?? 'nothing'}`, USAGE_EXIT);
  return n;
}

function pair(flag: string, s: string | undefined): [string, string] {
  const eq = s === undefined ? -1 : s.indexOf('=');
  if (s === undefined || eq < 1) refuse('REVIEW_OPTION_INVALID', `${flag} takes <id>=<text>, got ${s ?? 'nothing'}`, USAGE_EXIT);
  return [s.slice(0, eq), s.slice(eq + 1)];
}

export function reviewCommand(args: string[], now: number): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const items: ItemArg[] = [];
  const answersFeedback: { version: number; verdict: number }[] = [];
  const asks: Record<string, string> = {};
  const quotes: Record<string, string> = {};
  const values: Record<string, Json> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) refuse('REVIEW_OPTION_INVALID', `${arg} needs a value`, USAGE_EXIT);
      return v;
    };
    if (arg === '--json') json = true;
    else if (arg === '--from-review-file' || arg.startsWith('--from-review-file=')) {
      refuse('REVIEW_FILE_ROUTE_REMOVED', 'project.json.review_acts: saved act files are unsupported; use --from-review <actId> through the live Review job API', USAGE_EXIT);
    } else if (['--from-review', '--verdict', '--by', '--review', '--verbatim', '--verbatim-file', '--at', '--source'].includes(arg)) {
      if (arg in opts) refuse('REVIEW_OPTION_INVALID', `${arg} is given twice`, USAGE_EXIT);
      opts[arg] = value();
    } else if (arg === '--answers-feedback') {
      const text = value();
      if (!/^v?[1-9]\d*:\d+$/.test(text)) refuse('REVIEW_OPTION_INVALID', '--answers-feedback takes <version>:<verdict-index>', USAGE_EXIT);
      const [version, verdict] = text.replace(/^v/, '').split(':').map(Number);
      answersFeedback.push({ version, verdict });
    } else if (arg === '--item') {
      const v = value();
      const colon = v.indexOf(':');
      const id = colon === -1 ? v : v.slice(0, colon);
      const was = colon === -1 ? null : v.slice(colon + 1);
      if (id === '' || (was !== null && !(ANSWER_WAS as readonly string[]).includes(was))) {
        refuse('REVIEW_OPTION_INVALID', `--item takes <id> or <id>:${ANSWER_WAS.join('|')}, got ${v}`, USAGE_EXIT);
      }
      items.push({ id, answerWas: was as AnswerWas | null });
    } else if (arg === '--ask') {
      const [id, ask] = pair(arg, value());
      if (id in asks || ask === '') refuse('REVIEW_OPTION_INVALID', `--ask ${id} needs one nonempty ask id`, USAGE_EXIT);
      asks[id] = ask;
    } else if (arg === '--quote') {
      const [id, text] = pair(arg, value());
      quotes[id] = text;
    } else if (arg === '--value') {
      const [id, text] = pair(arg, value());
      try {
        values[id] = JSON.parse(text) as Json;
      } catch {
        refuse('REVIEW_OPTION_INVALID', `--value ${id}: not JSON: ${text}`, USAGE_EXIT);
      }
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `review does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length > 2) refuse('REVIEW_TOO_MANY_ARGUMENTS', `review takes a version and one folder, got ${positional.join(' ')}`, USAGE_EXIT);
  const version = parseVersion(positional[0]);
  if (opts['--from-review'] !== undefined) {
    if (Object.keys(opts).length !== 1 || items.length || answersFeedback.length || Object.keys(asks).length || Object.keys(quotes).length || Object.keys(values).length) {
      refuse('REVIEW_OPTION_INVALID', 'project.json.review_acts: --from-review excludes human-value and feedback flags; submit those values through Review', USAGE_EXIT);
    }
    const recorded = recordReviewAct(positional[1] ?? process.cwd(), version, opts['--from-review'], now);
    return { stdout: json ? JSON.stringify(recorded, null, 2) : [...(recorded.warnings ?? []), `review: ${recorded.verdict_path} — ${String(recorded.verdict.verdict)} (recorded or replayed)`].join('\n'), exit: 0 };
  }
  if (opts['--verbatim'] !== undefined && opts['--verbatim-file'] !== undefined) refuse('REVIEW_OPTION_INVALID', 'choose --verbatim or --verbatim-file', USAGE_EXIT);
  if (opts['--verbatim-file'] !== undefined) opts['--verbatim'] = readVerbatim(opts['--verbatim-file']);
  const missing = ['--verdict', '--by', '--review', '--verbatim', '--source'].filter((k) => opts[k] === undefined || opts[k] === '');
  if (missing.length > 0) refuse('REVIEW_OPTION_MISSING', `review needs ${missing.join(', ')}`, USAGE_EXIT);
  const verdict = opts['--verdict'] as string;
  if (!(VERDICTS as readonly string[]).includes(verdict)) refuse('REVIEW_OPTION_INVALID', `--verdict is ${VERDICTS.join(', ')}, got ${verdict}`, USAGE_EXIT);
  const review = opts['--review'] as string;
  if (!(review in REVIEW_ACCEPTS)) refuse('REVIEW_OPTION_INVALID', `--review is ${Object.keys(REVIEW_ACCEPTS).join(' or ')}, got ${review}`, USAGE_EXIT);

  for (const [id, ask] of Object.entries(asks)) {
    const item = items.find((entry) => entry.id === id);
    if (item === undefined) refuse('REVIEW_OPTION_INVALID', `--ask ${id}=${ask}: no matching --item`, USAGE_EXIT);
  }
  const r = recordVerdict(positional[1] ?? process.cwd(), {
    version,
    verdict: verdict as ReviewInput['verdict'],
    by: opts['--by'] as string,
    review: review as Review,
    verbatim: opts['--verbatim'] as string,
    source: opts['--source'] as string,
    items: items.map((item) => ({ ...item, ...(asks[item.id] === undefined ? {} : { ask: asks[item.id] }) })),
    quotes,
    values,
    at: opts['--at'],
    answersFeedback,
  }, now);
  if (json) return { stdout: JSON.stringify(r, null, 2), exit: 0 };
  const lines = [
    `review: recorded ${r.verdict_path} — ${String(r.verdict.verdict)} at ${String(r.verdict.review)} by ${String(r.verdict.by)}, ${String(r.verdict.at)}`,
    `  verbatim: ${JSON.stringify(r.verdict.verbatim)}`,
  ];
  for (const it of r.items) {
    lines.push(`  ${it.id}: ${it.answer_was} (${it.how === 'derived' ? 'from the record' : 'named, allowed by the record'})${it.addition === null ? '' : `; sentence added at ${it.addition}`}`);
  }
  if (r.items.length === 0) lines.push('  on no items');
  lines.push(`  stage unchanged (${r.stage ?? 'none'}): a verdict is not a sign-off`);
  if (r.items.some((it) => it.addition !== null)) {
    lines.push('  a guide changed: a step resting on it is re-signed before it runs again (interview --check names them)');
  }
  return { stdout: lines.join('\n'), exit: 0 };
}
