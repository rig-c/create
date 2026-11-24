import { assertDirectionApproval } from './direction.ts';
import { assertFigureMaskApproval } from './figure-mask.ts';
import { assertCorrectionApproval, stageReviewMeshDeltaCorrections } from './correction-writers.ts';
import { JOB_CHEST_LANDMARKS_ACT_SCHEMA, JOB_MESH_EDITS_ACT_SCHEMA } from '@rig-c/review/job-host';
import { foldsRigVerdict, foldRigSignoff } from './rig-signoff.ts';
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
 *   stage. A fresh job's approved rig verdict also records its stage signature;
 *   legacy two-subject publications and non-job verdicts keep separate signing.
 * - `checkFeedback` runs inside `interview --check`: bounced feedback with a
 *   later version that does not answer it, an answering ref that points at no
 *   verdict, and a `not-asked` item whose sentence was never added are refused
 *   by name; per bounced verdict, its items are counted by cause.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { shellWord } from './job-acts.ts';
import { acquireBoundJobWrite, beginJobProgress } from './job-writer.ts';
import { acquireJobLock, jobHash, pendingPublications, readWriterBinding } from './job-outbox.ts';
import { assertReviewActSource, decodeReviewAct, fetchBustPublicationSeeds, fetchReviewActRuntime, meshReviewVerdict, reviewActFindings, reviewActPublicationWarning, reviewActStill, reviewActTransport, reviewActVerbatim, reviewActVersionHash, type FetchedReviewAct } from './review-act.ts';
import { agentUnderOwner, assertDraftReviewActSource, draftReviewStillEvidence, isDraftReviewVerdict, retainedActBy, retainedVersionVerdict, reviewActBy, reviewActVerdict, reviewFeedbackComment, reviewStillEvidence, type ReviewVerdictAct } from './review-act.ts';
import { DRAFT_ID } from './draft-reuse.ts';
import { validCarriedRigDraftVerdict } from './rig-draft-verdict.ts';
import { bustLandmarkCommands, prepareBustConfig } from './review-bust.ts';
import { newRefusals } from './refusal-baseline.ts';
import { guideSignoffMatcher } from './signoff-answers.ts';
import { ingestedVerdictPairFinding } from './signoff-pair.ts';
import { dirname, join, resolve } from 'node:path';

import { asArray, asString, checkProject, collectItems, isObject, itemFor, loadCollection, type Ctx, type Item } from './check.ts';
import { draftVersionFindings } from './drafts.ts';
import { assembleOnlyDraftTarget, assertDraftHasRig, readAssembleOnlyDraftTarget } from './draft-layout.ts';
import { answersOf, askAnswers } from './provenance.ts';
import { readVerbatim } from './record-input.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { humanReviewVerdicts, readVersions } from './review.ts';
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

function routedCommentFinding(ctx: Pick<Ctx, 'collection'>, item: Item | undefined, version: number, verdict: JsonObject, route: JsonObject, path: string) {
  const added = item?.kind === 'waypoint' && answersOf(item, ctx).some(answer => asArray(answer.additions).some(add =>
    isObject(add) && add.source === feedbackSource(version) && add.review_act === verdict.source
    && add.by === verdict.by && add.at === route.at && add.verbatim === route.verbatim));
  if (added) return undefined;
  return { code: 'FEEDBACK_NOT_ADDED', path,
    message: `${path}: restore the exact routed owner comment in interview.waypoints[${String(route.item)}].guide.additions[] or its answer history` };
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
  const routes = new Map<string, { path: string; route: JsonObject }>();
  asArray(ctx.project.review_acts).forEach((entry, index) => {
    if (isObject(entry) && entry.kind !== 'interview-picks' && isObject(entry.feedback_route)) {
      routes.set(`${entry.version}:${entry.verdict}`, { path: `review_acts[${index}].feedback_route`, route: entry.feedback_route });
    }
  });

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
      if ((d.carried_from_draft !== undefined || typeof d.source === 'string' && d.source.startsWith('carried from draft review act '))
        && !validCarriedRigDraftVerdict(ctx.dir, ctx.project, v.record, d)) {
        push('REVIEW_ACT_LEDGER_INVALID', path, `${path}: carried approval differs from its draft act or registered inputs; restore the original act and bindings or review the version again`);
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
      const routed = routes.get(`${v.n}:${index}`);
      if (routed) {
        const item = itemFor(ctx, String(routed.route.item));
        const problem = routedCommentFinding(ctx, item, v.n, d, routed.route, routed.path);
        if (problem) push(problem.code, problem.path, problem.message);
        counts.not_asked++;
      }
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
  readonly feedback_route?: JsonObject;
  readonly warnings?: string[];
  readonly bust_landmark_commands?: [string, string];
}

export function readProject(dir: string): { file: string; project: JsonObject; bytes: Buffer } {
  const file = join(dir, 'project.json');
  if (!existsSync(file)) refuse('PROJECT_JSON_MISSING', `${file} does not exist; run in a project folder or name one`);
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = readFileSync(file);
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    refuse('PROJECT_JSON_INVALID', `${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) refuse('PROJECT_JSON_INVALID', `${file}: not a JSON object`);
  return { file, project: parsed as JsonObject, bytes };
}

function fetchVerdictAct<Act extends ReviewVerdictAct>(root: string, actId: string, now: number,
  select: (act: ReviewVerdictAct) => Act): FetchedReviewAct & { act: Act } {
  const transport = reviewActTransport(root, actId);
  const { bytes, stillBytes } = fetchReviewActRuntime(transport);
  const decoded = decodeReviewAct(bytes);
  if (decoded.jobId !== transport.jobId || decoded.actId !== actId) refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: fetched verdict differs from the requested act; fetch the correct act');
  const act = select(decoded);
  if (Date.parse(act.at) > now) refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: act is dated in the future; restore the clock before recording');
  return { act, bytes, stillBytes };
}

function replayedVerdictAct(receipts: Json[], { act, bytes }: FetchedReviewAct,
  beforeReplay?: () => void): { index: number; receipt: JsonObject } | undefined {
  const index = receipts.findIndex(row => isObject(row) && row.jobId === act.jobId && row.actId === act.actId);
  if (index < 0) return undefined;
  const receipt = receipts[index] as JsonObject;
  beforeReplay?.();
  const matches = isDraftReviewVerdict(act) || 'comments' in act.value
    ? receipt.bytes === bytes
    : isDeepStrictEqual(JSON.parse(String(receipt.bytes)), act);
  if (!matches) refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: immutable act changed; restore the original receipt');
  return { index, receipt };
}

type ReviewEvidenceFile = { path: string; bytes: Buffer };
type ReviewEvidenceWrite = 'version' | 'draft';

function reviewEvidenceFiles({ bytes, stillBytes }: FetchedReviewAct, path: string, stillHash: string, target: ReviewEvidenceWrite) {
  const png = stillBytes === undefined ? null : Buffer.from(stillBytes, 'base64');
  const stillName = target === 'draft' ? 'draft still' : 'named PNG';
  if (!png || jobHash(png) !== stillHash) refuse('REVIEW_ACT_STILL_INVALID', `project.json.review_acts: ${stillName} is missing or mismatched; fetch act.json and its still together`);
  const sha256 = jobHash(bytes);
  const files: ReviewEvidenceFile[] = [{ path, bytes: png }, { path: `${dirname(path)}/${sha256}.act.json`, bytes: Buffer.from(bytes) }];
  return { sha256, files };
}

function hasRetainedReviewEvidence(destination: string, file: ReviewEvidenceFile, mode: ReviewEvidenceWrite | 'draft-preflight' | 'draft-replay'): boolean {
  const info = mode === 'version' ? undefined : lstatSync(destination, { throwIfNoEntry: false });
  const exists = mode === 'version' ? existsSync(destination) : info !== undefined;
  if (!exists && mode !== 'draft-replay') return false;
  if ((mode !== 'version' && !info?.isFile()) || !readFileSync(destination).equals(file.bytes)) {
    const detail = mode === 'draft-preflight' || mode === 'draft-replay'
      ? 'retained draft review evidence is missing or differs' : 'retained bytes differ';
    refuse('REVIEW_ACT_STILL_INVALID', `${file.path}: ${detail}; restore the original export`);
  }
  return true;
}

function syncReviewDirectory(path: string): void {
  const directory = openSync(path, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Make an evidence directory and record each directory this call made, so a refusal removes only those. */
function makeReviewEvidenceDirectory(directory: string, created: string[]): void {
  const first = mkdirSync(directory, { recursive: true });
  if (first === undefined) return;
  const made: string[] = [];
  for (let path = directory; ; path = dirname(path)) {
    made.unshift(path);
    if (path === first) break;
  }
  created.push(...made);
}

function retainReviewEvidence(root: string, files: ReviewEvidenceFile[], created: string[], target: ReviewEvidenceWrite): void {
  for (const file of files) {
    const destination = join(root, file.path);
    const directory = dirname(destination);
    if (target === 'version') makeReviewEvidenceDirectory(directory, created);
    if (hasRetainedReviewEvidence(destination, file, target)) continue;
    if (target === 'version') {
      writeFileSync(destination, file.bytes, { flag: 'wx' });
      created.push(destination);
    } else {
      makeReviewEvidenceDirectory(directory, created);
      const fd = openSync(destination, 'wx', 0o600);
      created.push(destination);
      try { writeFileSync(fd, file.bytes); fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
}

function writeReviewActRecord(root: string, file: string, project: JsonObject, original: Buffer,
  target: ReviewEvidenceWrite, markCommitted?: () => void): void {
  const verdictName = target === 'draft' ? 'draft verdict' : 'verdict';
  const temporary = join(root, `.rig-create-review-act-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(project, null, 2)}\n`);
    fsyncSync(fd);
    if (!readFileSync(file).equals(original)) refuse('REVIEW_ACT_SOURCE_STALE', `project.json: record changed during ${verdictName} validation; retry against the current project record`);
    renameSync(temporary, file);
    markCommitted?.();
    syncReviewDirectory(root);
  } finally { closeSync(fd); rmSync(temporary, { force: true }); }
}

/** Remove what a refused write created, newest first, so its directories are empty when removed. */
function discardReviewActOutputs(created: string[], discardMesh?: () => void): void {
  discardMesh?.();
  for (const path of [...created].reverse()) {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) rmSync(path, { force: true });
    else {
      // A directory something else wrote into is kept; the refusal is still the one reported.
      try { rmdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
    }
  }
}

/** Appends one verdict to `versions[v<n>].verdicts[]`, writes not-asked sentences into their guides, and saves project.json. Refuses before writing anything. */
export function recordVerdict(projectDirArg: string, input: ReviewInput, now: number): Recorded {
  return writeVerdict(projectDirArg, input, now);
}

type FeedbackRoute = { by: 'agent'; at: string; item: string; comment_index: number; verbatim: string };

function appendFeedbackAddition(item: Item, version: number, addition: JsonObject): string {
  const answer = item.raw as JsonObject;
  const additions = asArray(answer.additions);
  answer.additions = additions;
  additions.push({ ...addition, source: feedbackSource(version) });
  return `${item.path}.additions[${additions.length - 1}]`;
}

function appendRoutedFeedback(items: readonly Item[], version: number, verdict: JsonObject, route: FeedbackRoute): RecordedItem {
  const item = items.find(i => i.id === route.item && i.kind === 'waypoint');
  if (!item) refuse('FEEDBACK_ITEM_UNKNOWN', `interview.waypoints[${route.item}]: name an existing rig waypoint with --item <waypoint>:not-asked`);
  const allowed = allowedFor(item);
  if (!allowed.ok) refuse(allowed.code, allowed.why);
  if (!allowed.allowed.includes('not-asked')) refuse('FEEDBACK_ITEM_CONTRADICTS', `${item.path}: the guide is delegated; record the owner's own answer before routing new words into it`);
  if (isObject(item.raw) && item.raw.basis === 'inherited') refuse('FEEDBACK_ITEM_INHERITED', `${item.path}: record a member override before adding the owner comment`);
  const addition = appendFeedbackAddition(item, version, { by: verdict.by!, at: route.at, verbatim: route.verbatim, value: null, review_act: verdict.source! });
  return { id: route.item, answer_was: 'not-asked', how: 'named', addition };
}

function verdictCandidateFinding(dir: string, before: JsonObject, candidate: JsonObject, now: number, route?: FeedbackRoute) {
  const findings = newRefusals(dir, before, candidate, { now });
  if (!route) return findings[0];
  const steps = isObject(candidate.plan) ? asArray(candidate.plan.steps).filter(isObject) : [];
  const affected = guideSignoffMatcher(steps, new Set([route.item]));
  // The new addition deliberately lapses the affected answer and step approvals until the owner re-signs.
  return findings.find(finding => !affected(finding));
}

/** A first verdict ingest from an owner host opened for the agent records the agent, who cannot review for the owner. */
function refuseAgentVerdict(act: ReviewVerdictAct): void {
  if (agentUnderOwner(act)) refuse('REVIEW_NOT_HUMAN', `project.json.review_acts: act ${act.jobId}/${act.actId} came from a host opened for reviewer ${JSON.stringify(act.authority.reviewer.id)}, so it records the agent, who cannot review for the owner; open the host for the owner and ask the owner for the verdict`);
}

function writeVerdict(projectDirArg: string, input: ReviewInput, now: number, fetched?: FetchedReviewAct, warnings: string[] = [], route?: FeedbackRoute): Recorded {
  if (!isHuman(input.by)) refuse('REVIEW_NOT_HUMAN', 'review must name a human, not agent');
  if (input.at !== undefined && !Number.isFinite(Date.parse(input.at))) refuse('REVIEW_OPTION_INVALID', '--at needs a valid timestamp', USAGE_EXIT);
  const dir = resolve(projectDirArg);
  const { file, project, bytes: originalBytes } = readProject(dir);
  const original = structuredClone(project);
  assertDraftHasRig(assembleOnlyDraftTarget(project, input.version), 'project.json.versions');
  const foldBaseline = fetched ? foldsRigVerdict(dir, original, fetched.act, now) : null;
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
    const addition = appendFeedbackAddition(item, input.version, { by: input.by, at, verbatim: r.addition, value: input.values[r.id] ?? null });
    out.push({ ...r, addition });
  }
  if (route) out.push(appendRoutedFeedback(items, input.version, verdict, route));
  if (verdict.verdict === 'accepted') assertDirectionApproval(dir, project, String(verdict.review), now, input.version);
  if (verdict.verdict === 'accepted' && verdict.review === 'rig-review') assertFigureMaskApproval(dir, project, input.version);
  if (verdict.verdict === 'accepted') assertCorrectionApproval(dir, project, String(verdict.review), now);
  const result = { project_dir: dir, verdict_path: verdictPath, verdict, items: out, stage: asString(project.stage),
    ...(route ? { feedback_route: route } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(fetched?.bustConfig ? { bust_landmark_commands: bustLandmarkCommands(dir, original, version, fetched.bustConfig.path, jobHash(fetched.bytes)) } : {}) };
  const created: string[] = [];
  let discardMeshRevision: (() => void) | undefined;
  let committed = false;
  try {
    const addedEvidence: JsonObject[] = [];
    const still = fetched === undefined ? null : reviewActStill(fetched.act);
    if (fetched !== undefined && still !== null) {
      const evidence = reviewStillEvidence(`evidence/v${input.version}`, still);
      const { files } = reviewEvidenceFiles(fetched, evidence.path, evidence.sha256, 'version');
      retainReviewEvidence(dir, files, created, 'version');
      const entries = asArray(version.evidence);
      if (!isDeepStrictEqual(entries[0], evidence)) {
        entries.unshift(evidence); addedEvidence.push(evidence);
      }
      version.evidence = entries;
    }
    if (fetched) {
      const receipt = { schema: 'rig-create/review-act@1', jobId: fetched.act.jobId, actId: fetched.act.actId,
        bytes: fetched.bytes, sha256: jobHash(fetched.bytes), version: input.version, verdict: verdicts.length - 1,
        version_hash: reviewActVersionHash(original, fetched.act), added_evidence: addedEvidence,
        ...(fetched.bustConfig ? { bust_config: fetched.bustConfig } : {}), ...(route ? { feedback_route: route } : {}) };
      project.review_acts = [...asArray(project.review_acts), receipt];
      if (foldBaseline) foldRigSignoff(dir, project, fetched.act, originalBytes, foldBaseline, now);
      const meshAct = meshReviewVerdict(fetched.act);
      if (meshAct) {
        discardMeshRevision = stageReviewMeshDeltaCorrections(dir, original, project, meshAct, now);
      }
      const invalid = reviewActFindings(project)[0] ?? ingestedVerdictPairFinding(project, input.version, verdicts.length - 1) ?? (foldBaseline ? undefined : verdictCandidateFinding(dir, original, project, now, route));
      if (invalid) refuse(invalid.code, invalid.message);
      assertReviewActSource(dir, original, fetched.act);
      writeReviewActRecord(dir, file, project, originalBytes, 'version', () => { committed = true; });
      return result;
    }
    const invalid = ingestedVerdictPairFinding(project, input.version, verdicts.length - 1) ?? newRefusals(dir, original, project, { now })[0];
    if (invalid) refuse(invalid.code, invalid.message);
    writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
    return { project_dir: dir, verdict_path: verdictPath, verdict, items: out, stage: asString(project.stage) };
  } catch (error) {
    if (!committed) discardReviewActOutputs(created, discardMeshRevision);
    throw error;
  }
}

export function recordDraftReviewAct(root: string, draftId: string, actId: string, now: number): Recorded {
  root = resolve(root);
  const release = acquireBoundJobWrite(root);
  const created: string[] = [];
  let discardMesh: (() => void) | undefined;
  let committed = false;
  try {
    const fetched = fetchVerdictAct(root, actId, now, act => {
      if (!isDraftReviewVerdict(act) || act.source.selector.id !== draftId) {
        refuse('REVIEW_ACT_KIND_MISMATCH', `project.json.review_acts: act does not review draft ${draftId}; invoke review --draft for the displayed draft`);
      }
      return act;
    });
    const { act, bytes } = fetched;
    const file = join(root, 'project.json');
    const original = readFileSync(file);
    const project = JSON.parse(original.toString('utf8')) as JsonObject;
    const invalid = reviewActFindings(project)[0];
    if (invalid) refuse(invalid.code, invalid.message);
    const binding = assertDraftReviewActSource(root, project, act);
    const receipts = asArray(project.review_acts);
    const existing = replayedVerdictAct(receipts, fetched);
    if (!existing) refuseAgentVerdict(act);
    const verdict = existing && isObject(existing.receipt.verdict)
      ? reviewActVerdict(act, retainedActBy(act, existing.receipt.verdict.by)) : reviewActVerdict(act);
    const path = `review_acts[${existing?.index ?? receipts.length}].verdict`;
    const result = { project_dir: root, verdict_path: path, verdict, items: [], stage: asString(project.stage) };
    const still = draftReviewStillEvidence(act);
    const { sha256, files } = reviewEvidenceFiles(fetched, still.path, still.sha256, 'draft');
    const stillDirectory = dirname(still.path);
    const evidenceDirs = ['evidence', 'evidence/drafts', stillDirectory].map(path => join(root, path));
    for (const directory of evidenceDirs) {
      const info = lstatSync(directory, { throwIfNoEntry: false });
      if (info && !info.isDirectory()) refuse('REVIEW_ACT_STILL_INVALID', `${directory}: draft evidence directory is unsafe; restore its original directory`);
    }
    for (const file of files) {
      hasRetainedReviewEvidence(join(root, file.path), file, existing ? 'draft-replay' : 'draft-preflight');
    }
    if (existing) return result;
    const draft = asArray(project.drafts).filter(isObject).find(row => row.id === draftId)!;
    const receipt = { schema: 'rig-create/review-act@1', kind: 'review-verdict', jobId: act.jobId, actId: act.actId,
      bytes, sha256, draft_id: draftId, version_hash: jobHash(`${JSON.stringify(draft, null, 2)}\n`), verdict, evidence: still, painting: binding.painting };
    const next = { ...project, review_acts: [...receipts, receipt] };
    if (act.schema === JOB_MESH_EDITS_ACT_SCHEMA) discardMesh = stageReviewMeshDeltaCorrections(root, project, next, act, now);
    const problem = reviewActFindings(next)[0] ?? newRefusals(root, project, next, { now })[0];
    if (problem) refuse(problem.code, problem.message);
    assertDraftReviewActSource(root, project, act);
    retainReviewEvidence(root, files, created, 'draft');
    syncReviewDirectory(join(root, stillDirectory));
    writeReviewActRecord(root, file, next, original, 'draft', () => { committed = true; });
    return result;
  } finally {
    if (!committed) discardReviewActOutputs(created, discardMesh);
    release();
  }
}

/** The common #184 lock covers fetch, source validation and the atomic write. */
export function recordReviewAct(root: string, requestedVersion: number, actId: string, now: number, afterGate?: () => void, config?: string, routeItem?: string): Recorded {
  root = resolve(root);
  const release = routeItem === undefined ? acquireBoundJobWrite(root) : acquireJobLock(root)!;
  try {
    // Explicit routes share the job lock even after close and honor the bound publication gate.
    if (routeItem !== undefined && readWriterBinding(root) && pendingPublications(root, true).length) {
      refuse('JOB_PUBLISH_PENDING', 'project.json: an earlier committed publication is pending; run rig-create job reconcile before another bound write');
    }
    const snapshot = routeItem === undefined ? undefined : readProject(root);
    const retained = snapshot && retainedVersionVerdict(snapshot.project, actId);
    const select = (act: ReviewVerdictAct): ReviewVerdictAct => {
      const selector = act.source.selector!;
      if (!('version' in selector) || selector.version !== requestedVersion) refuse('REVIEW_ACT_KIND_MISMATCH', 'project.json.review_acts: act names a different version; invoke review for the displayed version');
      return act;
    };
    // Progress starts only once the gate passed and the call needs the live job.
    if (!retained) afterGate?.();
    const fetched = retained ?? fetchVerdictAct(root, actId, now, select);
    const { act } = fetched;
    if (retained) {
      select(act);
      if (Date.parse(act.at) > now) refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: act is dated in the future; restore the clock before recording');
    }
    const { file, project, bytes: originalBytes } = snapshot ?? readProject(root);
    const invalid = retained ? undefined : reviewActFindings(project)[0];
    if (invalid) refuse(invalid.code, invalid.message);
    const chest = act.schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA;
    if (!chest && config !== undefined) refuse('REVIEW_OPTION_INVALID', 'project.json.review_acts: --config applies to a live rig verdict with chest landmark edits', USAGE_EXIT);
    const assertSource = () => assertReviewActSource(root, project, act);
    if (!chest || retained) assertSource();
    const replay = retained ?? replayedVerdictAct(asArray(project.review_acts), fetched, chest ? assertSource : undefined);
    const existing = replay?.receipt;
    const version = asArray(project.versions).filter(isObject).find(v => v.n === requestedVersion);
    const existingRoute = isObject(existing?.feedback_route) ? existing.feedback_route : undefined;
    if (routeItem !== undefined && existingRoute && existingRoute.item !== routeItem) {
      refuse('REVIEW_FEEDBACK_ROUTE_CONFLICT', `review_acts[${replay!.index}].feedback_route: already routed to ${String(existingRoute.item)}; replay with that waypoint or omit --item`);
    }
    let route: FeedbackRoute | undefined;
    if (routeItem !== undefined && !existingRoute) {
      const comment = reviewFeedbackComment(act);
      if (!comment) {
        const workingConfig = chest && !existing ? ` --config ${shellWord(config || '<project-relative working config>')}` : '';
        refuse('REVIEW_FEEDBACK_ROUTE_INVALID', 'project.json.review_acts: routing requires an owner changes-requested rig verdict with exactly one page-level comment. '
          + `With the Review job open, run rig-create review ${requestedVersion} --from-review ${act.actId}${workingConfig} from the project directory to ingest the verdict and preserve pinned comments in the retained Review act.`);
      }
      const rigs = readVersions(project).rigs.filter(rig => rig.live);
      const latest = humanReviewVerdicts(version?.verdicts, 'rig-review').at(-1);
      if (checkProject(root, project, { now }).effective_stage !== 'rig-review'
        || requestedVersion !== Math.max(...rigs.map(rig => rig.n))
        || !liveSignoff(collectReopens(project, []), 'rig-review', Date.parse(act.at))
        || (existing ? latest?.index !== existing.verdict : latest && Date.parse(String(latest.record.at)) > Date.parse(act.at))) {
        refuse('REVIEW_FEEDBACK_ROUTE_INVALID', `versions[v${requestedVersion}].verdicts: route feedback for the current rig-review verdict on the latest live rig`);
      }
      route = { by: 'agent', at: new Date(now).toISOString(), item: routeItem, ...comment };
    }
    if (existing) {
      const pair = ingestedVerdictPairFinding(project, requestedVersion, Number(existing.verdict));
      if (pair) refuse(pair.code, pair.message);
      if (existing.version_hash !== reviewActVersionHash(project, act, Number(existing.verdict))) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: reviewed version changed; request a new review act');
      const bustConfig = chest ? existing.bust_config as JsonObject : undefined;
      if (bustConfig && config !== undefined && config !== bustConfig.path) {
        refuse('REVIEW_OPTION_INVALID', 'project.json.review_acts: replay uses the recorded --config path; omit --config or supply that path', USAGE_EXIT);
      }
      // The prior ledger validation already bound this receipt to its version and verdict.
      const verdict = (version!.verdicts as JsonObject[])[Number(existing.verdict)];
      const items: RecordedItem[] = [];
      if (existingRoute) {
        const ctx = { collection: loadCollection(root) };
        const item = collectItems(project, ctx).find(i => i.id === existingRoute.item);
        const problem = routedCommentFinding(ctx, item, requestedVersion, verdict, existingRoute, `review_acts[${replay!.index}].feedback_route`);
        if (problem) refuse(problem.code, problem.message);
      }
      if (route) {
        const candidate = structuredClone(project);
        const receipt = (candidate.review_acts as JsonObject[])[replay!.index]!;
        receipt.feedback_route = route;
        items.push(appendRoutedFeedback(collectItems(candidate, { collection: loadCollection(root) }), requestedVersion, verdict, route));
        const invalid = reviewActFindings(candidate)[0] ?? verdictCandidateFinding(root, project, candidate, now, route);
        if (invalid) refuse(invalid.code, invalid.message);
        assertSource();
        writeReviewActRecord(root, file, candidate, originalBytes, 'version');
      }
      const recordedRoute = route ?? existingRoute;
      return { project_dir: root, verdict_path: `versions[v${requestedVersion}].verdicts[${existing.verdict}]`, verdict, items, stage: asString(project.stage),
        ...(recordedRoute ? { feedback_route: recordedRoute } : {}),
        ...(bustConfig ? {
          warnings: ['REVIEW_ACT_BUST_REPLAY: project.json.review_acts: chest edit already recorded; the working config SHA-256 was checked only on first ingest'],
          bust_landmark_commands: bustLandmarkCommands(root, project, version!, String(bustConfig.path), String(existing.sha256), true),
        } : {}) };
    }
    refuseAgentVerdict(act);
    let bustConfig;
    if (chest) {
      if (!config) refuse('REVIEW_OPTION_MISSING', 'project.json.review_acts: chest landmark edits require --config <project-relative working config>', USAGE_EXIT);
      const version = asArray(project.versions).filter(isObject).find(v => v.n === requestedVersion && v.kind === 'rig');
      if (!version) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.versions: reviewed rig version is absent; publish the current rig and request a new edit');
      bustConfig = prepareBustConfig(realpathSync(root), version, act, config, fetchBustPublicationSeeds(root, act));
      assertSource();
    }
    const warning = reviewActPublicationWarning(root, project, act);
    return writeVerdict(root, { version: requestedVersion,
      verdict: { approved: 'accepted', 'changes-requested': 'bounced', pending: 'provisional' }[act.value.verdict] as ReviewInput['verdict'],
      by: reviewActBy(act), review: act.value.stage as Review,
      verbatim: reviewActVerbatim(act), at: act.at, source: `review act ${act.jobId}/${act.actId}`, items: [], quotes: {}, values: {},
    }, now, { ...fetched, bustConfig }, warning ? [warning] : [], route);
  } finally { release(); }
}

export const REVIEW_HELP = `review:
  [<project dir>] --draft <id> --from-review <actId>  record a rigging draft verdict
  <version>        the version shown (3 or v3)
  [<project dir>]  the project folder (default: the current directory)
  --from-review <actId>  fetch a rig/post verdict through the live job writer binding on ingest
  --item <waypoint>:not-asked  with --from-review, route the unique page-level comment in an owner
                   changes-requested rig verdict to an existing rig waypoint. Supply one waypoint.
                   An ingested verdict's receipt can supply the comment after the job closes.
  --config <path>  project-relative working config, required on first ingest of chest landmark edits
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
  with source "polish feedback, v<n>". Never moves the stage. A fresh job's approved rig verdict also signs rig-review.`;

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
    } else if (['--draft', '--from-review', '--config', '--verdict', '--by', '--review', '--verbatim', '--verbatim-file', '--at', '--source'].includes(arg)) {
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
  if (opts['--draft'] !== undefined) {
    if (!DRAFT_ID.test(opts['--draft']) || !opts['--from-review'] || Object.keys(opts).length !== 2 || positional.length > 1
      || items.length || answersFeedback.length || Object.keys(asks).length || Object.keys(quotes).length || Object.keys(values).length) {
      refuse('REVIEW_OPTION_INVALID', 'project.json.review_acts: use review [<dir>] --draft <id> --from-review <actId>', USAGE_EXIT);
    }
    const recorded = recordDraftReviewAct(positional[0] ?? process.cwd(), opts['--draft'], opts['--from-review'], now);
    return { stdout: json ? JSON.stringify(recorded, null, 2) : `review: ${recorded.verdict_path} — ${String(recorded.verdict.verdict)} (recorded or replayed)`, exit: 0 };
  }
  if (positional.length > 2) refuse('REVIEW_TOO_MANY_ARGUMENTS', `review takes a version and one folder, got ${positional.join(' ')}`, USAGE_EXIT);
  const dir = positional[1] ?? process.cwd();
  assertDraftHasRig(readAssembleOnlyDraftTarget(dir, positional[0]), 'project.json.versions');
  const version = parseVersion(positional[0]);
  if (opts['--from-review'] !== undefined) {
    if (Object.keys(opts).some(flag => flag !== '--from-review' && flag !== '--config') || items.length > 1
      || items.some(item => item.answerWas !== 'not-asked') || answersFeedback.length || Object.keys(asks).length || Object.keys(quotes).length || Object.keys(values).length) {
      refuse('REVIEW_OPTION_INVALID', 'project.json.review_acts: submit human values through Review; --from-review accepts only one optional --item <waypoint>:not-asked route', USAGE_EXIT);
    }
    let progress: ReturnType<typeof beginJobProgress>;
    const recorded = recordReviewAct(dir, version, opts['--from-review'], now,
      () => { progress = beginJobProgress(dir, 'ingest', 'Reading the Review verdict'); }, opts['--config'], items[0]?.id);
    progress?.('Review verdict recorded');
    return { stdout: json ? JSON.stringify(recorded, null, 2) : [...(recorded.warnings ?? []),
      `review: ${recorded.verdict_path} — ${String(recorded.verdict.verdict)} (recorded or replayed)`,
      ...(recorded.feedback_route ? [`review: page-level comment routed by agent to ${String(recorded.feedback_route.item)}`] : []),
      ...(recorded.bust_landmark_commands ?? []),
    ].join('\n'), exit: 0 };
  }
  if (opts['--config'] !== undefined) refuse('REVIEW_OPTION_INVALID', 'project.json.review_acts: --config requires --from-review for chest landmark edits', USAGE_EXIT);
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
