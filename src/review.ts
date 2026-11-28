import { assertCorrectionApproval } from './correction-writers.ts';
import { assertFigureMaskApproval } from './figure-mask.ts';
/**
 * The two reviews and the hand-off between them (rig-c/create#8,
 * docs/PROJECT.md § Stages, § The rig review,
 * § The hand-off to post-production).
 *
 * On the current path, handoff reads the recorded current.rig after the
 * project advances past rig-review.
 *
 * The numbered path binds post work to the rig version its verdict accepts.
 * What is recorded where:
 *
 * - **Which rig version was accepted** is the human `accepted` verdict with
 *   `review: "rig-review"` on that `versions[]` entry (kind `rig`). The
 *   `{ stage: "rig-review" }` sign-off moves the stage; the verdict names the
 *   version. Both are written in the same turn.
 * - **Historical still evidence** is a `kind: "still"` entry in that
 *   version's `evidence[]`: `path`, `sha256`, `camera: "fixed"`, `frame`.
 * - **Which rig the post work is on** is a post version's `rig_version`, and
 *   `rig-create handoff` is what post tooling asks before it runs.
 *
 * `checkReviews` runs inside `interview --check`; `handoff` is the command.
 * Both read the record only: nothing is rendered or signed here.
 */
import { existsSync, readFileSync } from './check-reads.ts';
import { join, resolve } from 'node:path';

import { checkProject, collectItems, isCurrentPathProject, loadCollection } from './check.ts';
import { literalFile } from './choices.ts';
import { currentShapeFindings, sha256 } from './current.ts';
import { draftVersionFindings } from './drafts.ts';
import { assembleOnlyDraftTarget, assertDraftHasRig, readAssembleOnlyDraftTarget } from './draft-layout.ts';
import { checkPreInterview } from './pre-interview.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { collectReopens, liveSignoff, reopenIndex, type Reopen } from './reopen.ts';
import { RIG_REVIEW, stageIndex } from './stages.ts';
import type { Json, JsonObject } from './templates.ts';

/** The part of `interview --check`'s context this module reads and writes. */
export interface ReviewCtx {
  readonly project: JsonObject;
  readonly effectiveStage: string;
  readonly refusals: { code: string; path: string; message: string }[];
}

const SHA256 = /^[0-9a-f]{64}$/;

export interface Acceptance {
  readonly verdict: number;
  readonly by: string;
  readonly at: string;
  readonly verbatim: string | null;
  readonly source?: string;
  readonly note?: string;
}

export interface Still {
  readonly evidence: number;
  readonly path: string;
  readonly sha256: string;
  /** Seconds into the motion, or `setup`: the renderer's setup pose, which an idle may pass through rather than start at. */
  readonly frame: number | 'setup';
}

export interface RigVersion {
  readonly preInterview: boolean;
  readonly configLost?: { readonly note: string; readonly source: string };
  readonly outputsLost?: { readonly note: string; readonly source: string };
  readonly live: boolean;
  readonly n: number;
  readonly path: string;
  /** When the version was built; a reopen or amendment after it makes the version history (`live: false`). */
  readonly at: string | null;
  /** The last human `accepted` verdict at `rig-review`, or `null`. */
  readonly accepted: Acceptance | null;
  /** The well-formed still-frame evidence entries. */
  readonly stills: Still[];
  readonly malformedStills: { index: number; why: string }[];
}

export interface PostVersion {
  readonly n: number;
  readonly path: string;
  readonly at: string | null;
  readonly live: boolean;
  readonly rigVersion: Json | undefined;
}

export interface Versions {
  readonly rigs: RigVersion[];
  readonly posts: PostVersion[];
  readonly malformed: { path: string; why: string }[];
}

function isObject(v: Json | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}
function asArray(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : null;
}
function isHuman(by: string | null): by is string {
  return by !== null && by.toLowerCase() !== 'agent';
}

/** Human, non-provisional verdicts retain their original array indices. */
export function humanReviewVerdicts(value: Json | undefined, stage: string): { index: number; record: JsonObject }[] {
  return asArray(value).flatMap((record, index) =>
    isObject(record) && record.review === stage && isHuman(asString(record.by)) && record.verdict !== 'provisional'
      ? [{ index, record }] : []);
}

/** A later human verdict withdraws any earlier acceptance. */
export function acceptedReviewVerdict(version: JsonObject, stage: string): number {
  const last = humanReviewVerdicts(version.verdicts, stage).at(-1);
  return last?.record.verdict === 'accepted' ? last.index : -1;
}

function readStill(e: JsonObject): Still | string {
  const missing = ['path', 'sha256'].filter((k) => asString(e[k]) === null);
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  if (!SHA256.test(e.sha256 as string)) return 'sha256 is not 64 lowercase hex digits';
  if (e.camera !== 'fixed') return `camera is ${JSON.stringify(e.camera ?? null)}; the rig review is on a fixed camera ("camera": "fixed")`;
  if (e.frame === 'setup') return { evidence: -1, path: e.path as string, sha256: e.sha256 as string, frame: 'setup' };
  if (typeof e.frame !== 'number' || !Number.isFinite(e.frame) || e.frame < 0) {
    return `frame is ${JSON.stringify(e.frame ?? null)}; it is "setup" for the renderer's setup pose, or the time in seconds into the motion the still is posed at (0 is the motion's start, not necessarily the setup pose)`;
  }
  return { evidence: -1, path: e.path as string, sha256: e.sha256 as string, frame: e.frame };
}

/** Reads `versions[]` into rig and post versions, in record order. Paths name a version by its number: `versions[v2]`. */
export function readVersions(project: JsonObject): Versions {
  const reopens = collectReopens(project, []);
  const rigs: RigVersion[] = [];
  const posts: PostVersion[] = [];
  const malformed: { path: string; why: string }[] = [];
  asArray(project.versions).forEach((v, index) => {
    if (!isObject(v) || typeof v.n !== 'number' || !Number.isInteger(v.n)) {
      malformed.push({ path: `versions[${index}]`, why: 'a version is an object with an integer n' });
      return;
    }
    const path = `versions[v${v.n}]`;
    if (v.kind === 'post') {
      posts.push({ n: v.n, path, at: asString(v.at), rigVersion: v.rig_version, live: liveSignoff(reopens, 'post', Date.parse(asString(v.at) ?? '')) });
      return;
    }
    if (v.kind !== 'rig') {
      malformed.push({ path, why: `kind is 'rig' or 'post', got ${JSON.stringify(v.kind ?? null)}` });
      return;
    }
    if (v.rig_version !== null && v.rig_version !== undefined) {
      malformed.push({ path: `${path}.rig_version`, why: 'a rig version has rig_version null; only a post version names the rig it is built on' });
    }
    // The last human rig-review verdict decides. A later bounce withdraws an
    // earlier acceptance, and only a dated acceptance can authorize handoff.
    let accepted: Acceptance | null = null;
    for (const { index: verdict, record: d } of humanReviewVerdicts(v.verdicts, RIG_REVIEW)) {
      if (d.verdict !== 'accepted') {
        accepted = null;
        continue;
      }
      const at = asString(d.at);
      if (at === null || !Number.isFinite(Date.parse(at))) {
        malformed.push({ path: `${path}.verdicts[${verdict}].at`, why: 'an acceptance carries a valid `at`; an undated acceptance authorises nothing' });
        accepted = null;
        continue;
      }
      accepted = { verdict, by: d.by as string, at, verbatim: asString(d.verbatim) ?? '' };
      if (v.pre_interview === true) {
        accepted = { ...accepted, verbatim: asString(d.verbatim), source: asString(d.source) ?? '', note: asString(d.note) ?? undefined };
      }
    }
    const stills: Still[] = [];
    const malformedStills: { index: number; why: string }[] = [];
    asArray(v.evidence).forEach((e, i) => {
      if (!isObject(e) || e.kind !== 'still') return;
      const read = readStill(e);
      if (typeof read === 'string') malformedStills.push({ index: i, why: read });
      else stills.push({ ...read, evidence: i });
    });
    const outputsLost = v.pre_interview === true && isObject(v.outputs_lost)
      ? { note: asString(v.outputs_lost.note) ?? '', source: asString(v.outputs_lost.source) ?? '' } : undefined;
    const configLost = v.pre_interview === true && isObject(v.config_lost)
      ? { note: asString(v.config_lost.note) ?? '', source: asString(v.config_lost.source) ?? '' } : undefined;
    rigs.push({ configLost, outputsLost, n: v.n, path, at: asString(v.at), live: liveSignoff(reopens, RIG_REVIEW, Date.parse(asString(v.at) ?? '')), preInterview: v.pre_interview === true, accepted, stills, malformedStills });
  });
  return { rigs, posts, malformed };
}

/** The rig version with the highest number, accepted or not. */
function latestRig(versions: Versions): RigVersion | null {
  return versions.rigs.filter(r => r.live).reduce<RigVersion | null>((a, r) => (a === null || r.n > a.n ? r : a), null);
}
/** The accepted rig version with the highest number. */
export function latestAccepted(versions: Versions): RigVersion | null {
  return versions.rigs.filter((r) => r.live && r.accepted !== null).reduce<RigVersion | null>((a, r) => (a === null || r.n > a.n ? r : a), null);
}

/**
 * When no live rig is accepted but an older one was: that accepted rig, and the first reopen or amendment after
 * its build that made it history, named by its record path. An acceptance that lapsed this way is not a missing verdict.
 */
function lapsedAcceptance(project: JsonObject, versions: Versions): string | null {
  const rig = versions.rigs.filter(r => !r.live && r.accepted !== null).reduce<RigVersion | null>((a, r) => (a === null || r.n > a.n ? r : a), null);
  if (rig === null || rig.accepted === null) return null;
  const built = Date.parse(rig.at ?? '');
  const cutoff = collectReopens(project, []).filter(r => stageIndex(r.stage) <= stageIndex(RIG_REVIEW) && !(built > r.at))
    .reduce<Reopen | null>((a, r) => (a === null || r.at < a.at ? r : a), null);
  if (cutoff === null) return null;
  const when = new Date(cutoff.at).toISOString();
  // collectReopens appends amendment cutoffs, which carry their amendments[] index.
  const amendment = 'index' in cutoff && typeof cutoff.index === 'number' ? cutoff.index : -1;
  const reopen = reopenIndex(project, cutoff);
  const by = amendment >= 0 ? `the amendment at ${when} (amendments[${amendment}])`
    : `the reopen to ${cutoff.stage} at ${when} (reopens[${reopen}])`;
  return `${rig.path}.verdicts[${rig.accepted.verdict}]: rig v${rig.n} was accepted at ${rig.accepted.at}, but ${by} made it history; numbered rig versions and verdicts are read-only, so handoff has no live accepted numbered rig`;
}

// ------------------------------------------------------- interview --check

/** Append structural findings for version records and historical still evidence. */
export function checkReviews(ctx: ReviewCtx): void {
  const versions = readVersions(ctx.project);
  const push = (code: string, path: string, message: string): void => {
    ctx.refusals.push({ code, path, message });
  };
  for (const m of versions.malformed) push('VERSION_MALFORMED', m.path, `${m.path}: ${m.why}`);

  for (const rig of versions.rigs) {
    for (const m of rig.malformedStills) {
      const path = `${rig.path}.evidence[${m.index}]`;
      push('STILL_MALFORMED', path, `${path}: a still-frame record is { kind: "still", path, sha256, camera: "fixed", frame }; ${m.why}`);
    }
  }
}

// ------------------------------------------------------------------ handoff

interface NumberedHandoff {
  readonly ok: true;
  readonly project_dir: string;
  readonly rig_version: number;
  readonly pre_interview: boolean;
  readonly accepted: Acceptance;
  readonly still?: Still;
  readonly outputs_lost?: readonly { readonly version: number; readonly note: string; readonly source: string }[];
}

interface CurrentHandoff {
  readonly ok: true;
  readonly project_dir: string;
  readonly record: 'current.rig';
  readonly at: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export type Handoff = (NumberedHandoff & { readonly record?: undefined }) |
  (CurrentHandoff & { readonly rig_version?: undefined });

function currentHandoff(dir: string, project: JsonObject, rig: number | null, now: number): CurrentHandoff {
  if (rig !== null) refuse('HANDOFF_RIG_INVALID', 'current.rig: omit --rig to hand off the current rig', USAGE_EXIT);
  const node = isObject(project.current) ? project.current.rig : undefined;
  if (!isObject(node)) refuse('RIG_VERSION_UNACCEPTED', 'current.rig: record the rig with rig-create record rig and advance past rig-review before handoff');
  const checked = checkProject(dir, project, { now, readOnly: true });
  if (stageIndex(String(project.stage)) <= stageIndex(RIG_REVIEW)
    || stageIndex(checked.effective_stage ?? '') <= stageIndex(RIG_REVIEW)) {
    refuse('RIG_VERSION_UNACCEPTED', 'current.rig: advance past rig-review before handoff');
  }
  const invalid = currentShapeFindings('rig', node, project)[0];
  if (invalid) refuse(invalid.code, invalid.message);
  const files = (node.files as JsonObject[]).map(file => {
    const path = file.path as string;
    let matches = false;
    try {
      const bytes = readFileSync(literalFile(dir, path));
      matches = bytes.length === file.bytes && sha256(bytes) === file.sha256;
    } catch { /* The same remedy applies to missing, unreadable and changed files. */ }
    if (!matches) refuse('RIG_VERSION_UNACCEPTED', `current.rig.files: ${path} is missing or differs from the record; restore it or rebuild and record the current rig`);
    return { path, sha256: file.sha256 as string };
  });
  return { ok: true, project_dir: dir, record: 'current.rig', at: node.at as string, files };
}

/**
 * Read the current or numbered rig post work may run on.
 * A numbered caller can require a particular version with `rig`.
 */
export function handoff(projectDirArg: string, rig: number | null, now: number): Handoff {
  const dir = resolve(projectDirArg);
  const file = join(dir, 'project.json');
  if (!existsSync(file)) refuse('PROJECT_JSON_MISSING', `${file} does not exist; run in a project folder or name one`);
  let project: unknown;
  try {
    project = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    refuse('PROJECT_JSON_INVALID', `${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(project as Json)) refuse('PROJECT_JSON_INVALID', `${file}: not a JSON object`);
  const record = project as JsonObject;
  if (isCurrentPathProject(record, collectItems(record, { collection: loadCollection(dir, record) }))) {
    return currentHandoff(dir, record, rig, now);
  }
  assertDraftHasRig(assembleOnlyDraftTarget(record, rig), 'project.json.versions');
  assertCorrectionApproval(dir, record, RIG_REVIEW, now);
  const historyRefusals: ReviewCtx['refusals'] = draftVersionFindings(dir, record);
  checkPreInterview({ dir, project: record, refusals: historyRefusals, warnings: [] });
  const first = historyRefusals[0];
  if (first !== undefined) refuse(first.code, first.message);

  collectReopens(record, historyRefusals);
  if (historyRefusals[0] !== undefined) refuse(historyRefusals[0].code, historyRefusals[0].message);
  const versions = readVersions(record);
  const accepted = latestAccepted(versions);
  const latest = latestRig(versions);
  if (accepted === null || accepted.accepted === null) {
    const lapsed = lapsedAcceptance(record, versions);
    refuse('RIG_VERSION_UNACCEPTED', lapsed !== null ? `rig-review is signed on a lapsed acceptance: ${lapsed} before post work runs`
      : `rig-review is signed, but no rig version has an accepted rig-review verdict naming it`);
  }
  if (latest !== null && latest.n !== accepted.n) {
    refuse(
      'RIG_VERSION_UNACCEPTED',
      `${latest.path}: rig v${latest.n} was built after rig v${accepted.n} was accepted and has no rig-review acceptance of its own; review it before post work runs`,
    );
  }
  if (accepted.configLost !== undefined) {
    refuse('PRE_INTERVIEW_CONFIG_LOST', `${accepted.path}.config_lost: ${accepted.configLost.note}; source: ${accepted.configLost.source}; build and accept a new rig with its retained config before post work`);
  }
  if (accepted.outputsLost !== undefined) {
    refuse('PRE_INTERVIEW_OUTPUTS_LOST', `${accepted.path}.outputs_lost: ${accepted.outputsLost.note}; source: ${accepted.outputsLost.source}; build and accept a new rig with surviving frozen outputs before post work`);
  }
  const still = accepted.stills[0];

  if (rig !== null && rig !== accepted.n) {
    const named = versions.rigs.find((r) => r.n === rig);
    if (named !== undefined && named.accepted !== null) {
      refuse('POST_ON_SUPERSEDED_RIG', `versions[v${rig}]: rig v${rig} was accepted, but rig v${accepted.n} was accepted since; post work runs on v${accepted.n}`);
    }
    refuse('POST_ON_UNACCEPTED_RIG', `versions[v${rig}]: ${named === undefined ? 'no rig version has that number' : `rig v${rig} has no accepted rig-review verdict`}; post work runs on rig v${accepted.n}`);
  }
  assertFigureMaskApproval(dir, record, accepted.n);
  const losses = asArray(record.versions).flatMap((v) => isObject(v) && v.pre_interview === true && isObject(v.outputs_lost)
    ? [{ version: v.n as number, note: v.outputs_lost.note as string, source: v.outputs_lost.source as string }] : []);
  return { ...(losses.length > 0 ? { outputs_lost: losses } : {}), ok: true, project_dir: dir, rig_version: accepted.n, pre_interview: accepted.preInterview, accepted: accepted.accepted, ...(still ? { still } : {}) };
}

export const HANDOFF_HELP = `handoff:
  [<project dir>]  the project folder (default: the current directory)
  --rig <n>        on numbered projects, require rig version <n>
  --json           print the handoff as JSON
  Current projects hand off the recorded current.rig files after rig-review.
  Numbered projects hand off the accepted rig version. Exit 1 is a named refusal
  (RIG_VERSION_UNACCEPTED, POST_ON_UNACCEPTED_RIG, POST_ON_SUPERSEDED_RIG).`;

export function handoffCommand(args: string[], now: number): { stdout: string; exit: number } {
  let json = false;
  let requested: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (arg === '--rig') {
      const value = args[++i];
      if (value === undefined) refuse('HANDOFF_RIG_INVALID', '--rig takes a rig version number, got nothing', USAGE_EXIT);
      requested = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `handoff does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length > 1) refuse('HANDOFF_TOO_MANY_ARGUMENTS', `handoff takes one folder, got ${positional.join(' ')}`, USAGE_EXIT);
  const dir = positional[0] ?? process.cwd();
  const rig = requested === undefined ? null : Number(requested.replace(/^v/, ''));
  if (rig !== null && (!Number.isInteger(rig) || rig < 1)) {
    assertDraftHasRig(readAssembleOnlyDraftTarget(dir, requested), 'project.json.versions');
    refuse('HANDOFF_RIG_INVALID', `--rig takes a rig version number, got ${requested}`, USAGE_EXIT);
  }
  const h = handoff(dir, rig, now);
  if (json) return { stdout: JSON.stringify(h, null, 2), exit: 0 };
  if (h.record) return {
    stdout: [`handoff: post work is on ${h.record} recorded at ${h.at}`,
      ...h.files.map(file => `  ${file.path} (sha256 ${file.sha256})`)].join('\n'),
    exit: 0,
  };
  const still = h.still;
  return {
    stdout: [
      `handoff: post work is on rig v${h.rig_version}${h.pre_interview ? ' (pre-interview)' : ''}`,
      `  accepted at rig-review by ${h.accepted.by} at ${h.accepted.at}: ${h.accepted.verbatim === null ? `record of the user: ${h.accepted.note}` : `"${h.accepted.verbatim}"`}`,
      ...(h.pre_interview ? [`  source: ${h.accepted.source}`] : []),
      ...(h.outputs_lost ?? []).map((loss) => `  v${loss.version} (pre-interview) outputs lost: ${loss.note}; source: ${loss.source}`),
      ...(still ? [`  still frame ${still.path} (sha256 ${still.sha256}, fixed camera, ${still.frame === 'setup' ? 'setup pose' : `${still.frame} s`})`] : []),
    ].join('\n'),
    exit: 0,
  };
}
