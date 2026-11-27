/**
 * Stored feedback validation (`checkFeedback`) and shared review sidecar helpers.
 * Numbered verdict writers (`review`) are retired; stored verdicts and feedback
 * references continue to validate at check time.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync } from './check-reads.ts';
import { dirname, join } from 'node:path';
import { validCarriedRigDraftVerdict } from './rig-draft-verdict.ts';
import { asArray, asString, isObject, itemFor, type Ctx, type Finding, type Item } from './check.ts';
import { answersOf, askAnswers } from './provenance.ts';
import { refuse } from './refusal.ts';
import { REVIEW_ACCEPTS } from './stages.ts';
import { WAYPOINT_ASKS } from './waypoints.ts';
import type { Json, JsonObject } from './templates.ts';

export const VERDICTS = ['accepted', 'bounced', 'provisional'] as const;
export const ANSWER_WAS = ['user', 'delegated', 'not-asked'] as const;

/** The `source` of a guide sentence added from feedback on version `n`. */
export function feedbackSource(n: number): string {
  return `polish feedback, v${n}`;
}

function isHuman(by: string | null): boolean {
  return by !== null && by.toLowerCase() !== 'agent';
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

export interface OpenDirectionComment {
  readonly field: 'current.direction';
  readonly verdict: string;
  readonly by: string | null;
  readonly at: string | null;
  readonly source: Json;
  readonly verbatim: string;
  readonly on_items: Json[];
}

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
  readonly answered_by_current_direction?: true;
  /** `true` once a later human acceptance of the same review on the same version withdrew it. */
  readonly withdrawn: boolean;
  /** Read through the adopted version binding while this bounce is open. */
  readonly open_direction_comment?: OpenDirectionComment;
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

export function parseFeedbackPair(value: string): { version: number; verdict: number } | null {
  const match = /^(\d+):(\d+)$/.exec(value);
  return match ? { version: Number(match[1]), verdict: Number(match[2]) } : null;
}

const DIRECTION_FEEDBACK_PATH = 'current.direction.answers_feedback';
const DIRECTION_FEEDBACK_REF_INVALID = 'DIRECTION_FEEDBACK_REF_INVALID';

export function directionFeedbackRefFinding(path: string, why: string): Finding {
  return { code: DIRECTION_FEEDBACK_REF_INVALID, path,
    message: `${path}: ${why}; use record direction --from with --answers-feedback <version>:<verdict> for an open human direction-review bounce` };
}

function currentDirectionFeedbackRefs(direction: JsonObject | undefined, refusals: Finding[]): Map<string, string> {
  const refs = new Map<string, string>();
  if (direction?.answers_feedback === undefined) return refs;
  if (direction.adopted !== undefined || !Array.isArray(direction.answers_feedback)) {
    refusals.push(directionFeedbackRefFinding(DIRECTION_FEEDBACK_PATH, 'expected an array on a newly recorded direction output'));
    return refs;
  }
  for (const [index, ref] of direction.answers_feedback.entries()) {
    const path = `${DIRECTION_FEEDBACK_PATH}[${index}]`;
    if (!isObject(ref) || Object.keys(ref).length !== 2
      || typeof ref.version !== 'number' || !Number.isSafeInteger(ref.version) || ref.version < 1
      || typeof ref.verdict !== 'number' || !Number.isSafeInteger(ref.verdict) || ref.verdict < 0) {
      refusals.push(directionFeedbackRefFinding(path, 'expected { version, verdict } with a positive version and a zero-based verdict index'));
      continue;
    }
    const key = `${ref.version}:${ref.verdict}`;
    if (refs.has(key)) {
      refusals.push({ code: 'FEEDBACK_REF_DUPLICATE', path, message: `${path}: duplicate ${key}; name each feedback verdict once` });
      continue;
    }
    refs.set(key, path);
  }
  return refs;
}

/** Feedback refusals and warnings, appended to the context; returns one summary per human bounced verdict. */
export function checkFeedback(ctx: Ctx): FeedbackSummary[] {
  const versions = versionsOf(ctx.project);
  const directionNode = isObject(ctx.project.current) ? ctx.project.current.direction : undefined;
  const direction = isObject(directionNode) ? directionNode : undefined;
  const adopted = isObject(direction?.adopted) ? direction.adopted.version : undefined;
  const currentRefs = currentDirectionFeedbackRefs(direction, ctx.refusals);
  const directionAt = Date.parse(asString(direction?.at) ?? '');
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
      const key = `${v.n}:${index}`;
      const by = answeredBy.get(key) ?? [];
      const unresolved = !withdrawn && by.length === 0;
      const later = unresolved ? versions.filter((x) => x.n > v.n).map((x) => `v${x.n}`) : [];
      const openDirection = unresolved && later.length === 0 && v.record.kind === 'post' && d.review === 'direction-review';
      const answeredByCurrent = v.record.kind === 'post' && d.review === 'direction-review' && currentRefs.has(key)
        && versions.filter(version => version.n === v.n).length === 1
        && Date.parse(asString(d.at) ?? '') <= directionAt;
      if (answeredByCurrent) currentRefs.delete(key);
      const openDirectionComment: OpenDirectionComment | undefined =
        openDirection && !answeredByCurrent && v.n === adopted && typeof d.verbatim === 'string'
          ? { field: 'current.direction', verdict: path, by: asString(d.by), at: asString(d.at),
            source: d.source ?? null, verbatim: d.verbatim, on_items: asArray(d.on_items) }
          : undefined;
      summaries.push({
        verdict: path,
        version: v.n,
        index,
        review: asString(d.review),
        by: asString(d.by),
        at: asString(d.at),
        items: counts,
        answered_by: by,
        ...(answeredByCurrent ? { answered_by_current_direction: true } as const : {}),
        withdrawn,
        ...(openDirectionComment ? { open_direction_comment: openDirectionComment } : {}),
      });
      if (!unresolved || answeredByCurrent) return;
      if (later.length > 0) {
        push(
          'FEEDBACK_UNANSWERED',
          path,
          `${path}: v${v.n} was bounced, and ${later.join(', ')} ${later.length === 1 ? 'was' : 'were'} built since without listing it in answers_feedback ({ "version": ${v.n}, "verdict": ${index} }); the next version answers the feedback it was built from`,
        );
      } else {
        const message = openDirectionComment
          ? `${path}: current.direction uses bounced v${v.n}. Open comment from ${openDirectionComment.by}: ${JSON.stringify(openDirectionComment.verbatim)}. Use this feedback when rebuilding current.direction.`
          : `${path}: v${v.n} was bounced and no later version is built yet; the next version lists { "version": ${v.n}, "verdict": ${index} } in answers_feedback`;
        ctx.warnings.push({ code: 'FEEDBACK_OPEN', path, message });
      }
    });
  }
  for (const [key, path] of currentRefs) {
    ctx.refusals.push(directionFeedbackRefFinding(path, `${key} does not identify a retained human direction-review bounce at or before the current output`));
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
    const state = s.withdrawn ? 'withdrawn by a later acceptance' : s.answered_by_current_direction ? 'answered by current.direction'
      : s.answered_by.length > 0 ? `answered by ${s.answered_by.map((n) => `v${n}`).join(', ')}` : 'not answered';
    lines.push(`    ${s.verdict} (${s.review ?? '?'}): ${s.items.user} user, ${s.items.delegated} delegated, ${s.items.not_asked} not-asked; ${state}`);
  }
  return lines;
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

type ReviewEvidenceFile = { path: string; bytes: Buffer };
type ReviewEvidenceWrite = 'version' | 'draft';

function hasRetainedReviewEvidence(destination: string, file: ReviewEvidenceFile, mode: ReviewEvidenceWrite): boolean {
  const info = mode === 'version' ? undefined : lstatSync(destination, { throwIfNoEntry: false });
  const exists = mode === 'version' ? existsSync(destination) : info !== undefined;
  if (!exists) return false;
  if ((mode !== 'version' && !info?.isFile()) || !readFileSync(destination).equals(file.bytes)) {
    refuse('REVIEW_ACT_STILL_INVALID', `${file.path}: retained bytes differ; restore the original export`);
  }
  return true;
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

export function retainReviewSidecar(root: string, file: ReviewEvidenceFile, created: string[], target: ReviewEvidenceWrite): void {
  const destination = join(root, file.path);
  if (hasRetainedReviewEvidence(destination, file, target)) return;
  makeReviewEvidenceDirectory(dirname(destination), created);
  if (target === 'version') {
    writeFileSync(destination, file.bytes, { flag: 'wx' });
    created.push(destination);
    return;
  }
  const fd = openSync(destination, 'wx', 0o600);
  created.push(destination);
  try { writeFileSync(fd, file.bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Remove what a refused write created, newest first, so its directories are empty when removed. */
export function discardReviewActOutputs(created: string[], discardMesh?: () => void): void {
  discardMesh?.();
  for (const path of [...created].reverse()) {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) rmSync(path, { force: true });
    else {
      // A directory something else wrote into is kept; the refusal is still the one reported.
      try { rmdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
    }
  }
}
