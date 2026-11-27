/**
 * Current-output comment status, `next` moves, and `comment_closures[]` (#1064).
 *
 * Why `(comment, act_sha256)` is the comment identifier:
 * - `comments[i]` is re-derived byte-for-byte from its immutable `rig-review/act@10` receipt
 *   (`commentEntryFinding`), so it carries no synthetic `id` field inside `comments[i]`,
 *   and `actId` alone is scoped to a Review `jobId` rather than globally unique or indexed.
 * - Binding `comment` (the 0-based `comments[]` index) together with `act_sha256` (the 64-hex
 *   SHA-256 of the retained `review_acts[]` comment receipt bytes) names the exact `comments[N]`
 *   slot shown in `next` ("Read comment N and act on it") while cryptographically pinning the
 *   full act (`jobId`, `actId`, `saw[]`, words and pins).
 */
import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { asArray, isObject, type Finding } from './check.ts';
import { isCurrentProject, sha256 } from './current.ts';
import { jobHash } from './job-outbox.ts';
import { Refusal, refuse } from './refusal.ts';
import { PAUSED_STAGE } from './stages.ts';
import type { Json, JsonObject } from './templates.ts';

const fieldName = 'comment_closures';
const invalidCode = 'COMMENT_CLOSURE_INVALID';

export type CommentStatus = 'current' | 'earlier';

export interface CommentFileBinding {
  readonly path: string;
  readonly sha256: string;
}

export interface CommentClosure {
  readonly comment: number;
  readonly act_sha256: string;
  readonly by: 'agent';
  readonly at: string;
  readonly after: CommentFileBinding[];
  readonly reason?: string;
}

export interface NextComment {
  readonly comment: number;
  readonly act_sha256: string | null;
  readonly source: Json;
  readonly at: Json;
  readonly by: Json;
  readonly status: CommentStatus;
  readonly closed: boolean;
  readonly saw: CommentFileBinding[];
  readonly comments: Json[];
}

const hex64 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const literalPath = (path: unknown): path is string => typeof path === 'string' && path.length > 0
  && !path.startsWith('/') && !path.includes('\\') && !path.includes(':')
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

function clock(value: unknown): number {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? Date.parse(value) : NaN;
}

function regularProjectFile(dir: string, rel: string): string | undefined {
  if (!literalPath(rel)) return undefined;
  try {
    const file = join(dir, rel);
    if (!existsSync(file)) return undefined;
    if (realpathSync(file) !== join(realpathSync(dir), rel) || !lstatSync(file).isFile()) return undefined;
    return file;
  } catch { return undefined; }
}

function diskFileSha256(dir: string, rel: string): string | undefined {
  const file = regularProjectFile(dir, rel);
  if (!file) return undefined;
  try { return sha256(readFileSync(file)); }
  catch { return undefined; }
}

function readSawBindings(entry: JsonObject): CommentFileBinding[] | undefined {
  if (!Array.isArray(entry.saw) || entry.saw.length === 0) return undefined;
  const rows: CommentFileBinding[] = [];
  for (const row of entry.saw) {
    if (!isObject(row) || !literalPath(row.path) || !hex64(row.sha256)) return undefined;
    rows.push({ path: row.path, sha256: row.sha256 });
  }
  return rows;
}

/**
 * Compute status `current` / `earlier` for one `comments[]` entry against the files now on disk
 * (docs/CURRENT-DATA.md §302-308). Never throws and never raises a refusal.
 */
export function commentStatus(dir: string, entry: JsonObject): CommentStatus {
  const saw = readSawBindings(entry);
  if (!saw) return 'earlier';
  return saw.every(row => diskFileSha256(dir, row.path) === row.sha256) ? 'current' : 'earlier';
}

/**
 * Current-output comment status and moves apply only to current projects and unnumbered projects.
 * Numbered legacy projects without `current` stay on the numbered path.
 */
export function usesCurrentComments(project: JsonObject): boolean {
  if (isCurrentProject(project)) return true;
  return ![project.drafts, project.versions, project.scenes].some(entries => asArray(entries).length > 0);
}

function commentReceiptSha(project: JsonObject, index: number): string | null {
  const matches = asArray(project.review_acts).filter((row): row is JsonObject => isObject(row)
    && row.kind === 'comments' && row.comment === index && hex64(row.sha256)
    && typeof row.bytes === 'string' && jobHash(row.bytes) === row.sha256);
  return matches.length === 1 ? String(matches[0]!.sha256) : null;
}

function invalid(path: string, detail: string): never {
  refuse(invalidCode, `project.json.${path}: ${detail}; use rig-create comment --close <index> --act-sha256 <sha256> --after <path>=<sha256> with the comment receipt hash and the changed file hashes`);
}

function parseAfterArray(value: unknown, path: string): CommentFileBinding[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(path, 'after must be a non-empty array of { path, sha256 } bindings for the files changed in response');
  }
  const out: CommentFileBinding[] = [];
  let previous = '';
  for (const [index, entry] of value.entries()) {
    const itemPath = `${path}.after[${index}]`;
    if (!isObject(entry) || Object.keys(entry).length !== 2 || !literalPath(entry.path) || !hex64(entry.sha256)) {
      invalid(itemPath, 'expected { path, sha256 } with a literal project-relative path and a 64-hex sha256');
    }
    if (!(previous < entry.path)) {
      invalid(itemPath, 'after bindings must sort by path with no duplicate');
    }
    previous = entry.path;
    out.push({ path: entry.path, sha256: entry.sha256 });
  }
  return out;
}

/**
 * Validate `project.json.comment_closures[]`. Shared by `check` and the `comment --close` writer
 * (AGENTS.md invariant 6). When `verifyingCommentClosure` names a candidate index at write time,
 * every `after` entry in that closure must also match the file bytes currently on disk.
 */
export function checkCommentClosures(
  dir: string,
  project: JsonObject,
  now: number,
  verifyingCommentClosure?: number,
): { findings: Finding[]; closed: Set<number> } {
  const findings: Finding[] = [];
  const closed = new Set<number>();
  const raw = project[fieldName];
  if (raw === undefined) return { findings, closed };

  const collect = (path: string, validate: () => void): void => {
    try { validate(); }
    catch (error) {
      if (!(error instanceof Refusal) || error.code !== invalidCode) throw error;
      findings.push({ code: invalidCode, path, message: error.message });
    }
  };

  if (!Array.isArray(raw)) {
    collect(fieldName, () => invalid(fieldName, 'expected an array of comment closures'));
    return { findings, closed };
  }

  const counts = new Map<number, number>();
  for (const row of raw) {
    if (isObject(row) && typeof row.comment === 'number' && Number.isSafeInteger(row.comment)) {
      counts.set(row.comment, (counts.get(row.comment) ?? 0) + 1);
    }
  }

  const comments = asArray(project.comments);
  for (const [index, row] of raw.entries()) {
    const path = `${fieldName}[${index}]`;
    collect(path, () => {
      if (!isObject(row)) invalid(path, 'expected a closure object');
      const allowed = new Set(['comment', 'act_sha256', 'by', 'at', 'after', 'reason']);
      if (Object.keys(row).some(key => !allowed.has(key))
        || typeof row.comment !== 'number' || !Number.isSafeInteger(row.comment) || row.comment < 0
        || !hex64(row.act_sha256) || row.by !== 'agent' || !(clock(row.at) <= now)
        || (row.reason !== undefined && !nonblank(row.reason))) {
        invalid(path, 'invalid closure identity, actor, reason or clock');
      }
      const entry = comments[row.comment];
      const expectedActSha = commentReceiptSha(project, row.comment);
      if (!isObject(entry) || expectedActSha === null || row.act_sha256 !== expectedActSha) {
        invalid(path, `comment ${row.comment} and act_sha256 ${row.act_sha256} do not match a verified comments[] entry and its retained act receipt`);
      }
      if (!(clock(entry.at) <= clock(row.at))) {
        invalid(path, 'closure must not predate its source comment');
      }
      if (counts.get(row.comment) !== 1) {
        invalid(path, `multiple closures claim comments[${row.comment}]`);
      }
      const after = parseAfterArray(row.after, path);
      const sawByPath = new Map(asArray(entry.saw).filter(isObject)
        .filter(item => typeof item.path === 'string' && typeof item.sha256 === 'string')
        .map(item => [String(item.path), String(item.sha256)]));
      for (const binding of after) {
        const beforeSha = sawByPath.get(binding.path);
        if (beforeSha !== undefined && binding.sha256 === beforeSha) {
          invalid(path, `${binding.path} still carries its unchanged saw sha256 ${beforeSha.slice(0, 12)}; bind the content hashes after the change`);
        }
        if (verifyingCommentClosure === index) {
          const actual = diskFileSha256(dir, binding.path);
          if (actual === undefined) {
            invalid(path, `${binding.path} is missing or is not a regular project-relative file`);
          }
          if (actual !== binding.sha256) {
            invalid(path, `${binding.path} hashes to ${actual.slice(0, 12)} on disk, not ${binding.sha256.slice(0, 12)}`);
          }
        }
      }
      closed.add(row.comment);
    });
  }
  return { findings, closed };
}

export function parseAfterFlag(spec: string): CommentFileBinding {
  const eq = spec.lastIndexOf('=');
  if (eq <= 0 || eq === spec.length - 1) {
    invalid(fieldName, `expected <path>=<sha256> for --after, got ${JSON.stringify(spec)}`);
  }
  const path = spec.slice(0, eq);
  const hash = spec.slice(eq + 1);
  if (!literalPath(path) || !hex64(hash)) {
    invalid(fieldName, `--after ${JSON.stringify(spec)} must name a literal project-relative path and a 64-hex sha256`);
  }
  return { path, sha256: hash };
}

export function prepareCommentClosure(
  dir: string,
  project: JsonObject,
  now: number,
  input: {
    comment: number;
    actSha256: string;
    by: string;
    afterSpecs: readonly string[];
    reason?: string;
  },
): { row: CommentClosure; index: number; replay: boolean } {
  if (input.by !== 'agent') invalid(fieldName, 'name the agent with --by agent');
  if (!Number.isSafeInteger(input.comment) || input.comment < 0 || !hex64(input.actSha256)) {
    invalid(fieldName, 'supply a non-negative comment index and a 64-hex --act-sha256');
  }
  if (input.reason !== undefined && !nonblank(input.reason)) {
    invalid(fieldName, 'closure reason must not be blank');
  }
  if (input.afterSpecs.length === 0) {
    invalid(fieldName, 'supply at least one --after <path>=<sha256> binding for the files changed in response');
  }

  const parsed = input.afterSpecs.map(parseAfterFlag).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i - 1]!.path === parsed[i]!.path) {
      invalid(fieldName, `duplicate --after path ${parsed[i]!.path}`);
    }
  }

  const priorProblem = checkCommentClosures(dir, project, now).findings[0];
  if (priorProblem) refuse(priorProblem.code, priorProblem.message);

  const semantic = {
    comment: input.comment,
    act_sha256: input.actSha256,
    by: 'agent' as const,
    after: parsed,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };

  const existingIndex = asArray(project[fieldName]).findIndex(row => isObject(row) && row.comment === input.comment);
  if (existingIndex >= 0) {
    const existing = asArray(project[fieldName])[existingIndex] as JsonObject;
    const { at, ...previous } = existing;
    if (!equal(previous, semantic)) {
      invalid(`${fieldName}[${existingIndex}]`, `comments[${input.comment}] already has a different closure`);
    }
    const verifyProblem = checkCommentClosures(dir, project, now, existingIndex).findings[0];
    if (verifyProblem) refuse(verifyProblem.code, verifyProblem.message);
    return { row: { ...semantic, at: String(at) }, index: existingIndex, replay: true };
  }

  const row: CommentClosure = { ...semantic, at: new Date(now).toISOString() };
  const index = asArray(project[fieldName]).length;
  const candidate: JsonObject = { ...project, [fieldName]: [...asArray(project[fieldName]), row as unknown as Json] };
  const problem = checkCommentClosures(dir, candidate, now, index).findings[0];
  if (problem) refuse(problem.code, problem.message);
  return { row, index, replay: false };
}

/** Project `comments[]` views with live `current` / `earlier` status and closure state. */
export function projectCommentViews(
  dir: string,
  project: JsonObject,
  closed: ReadonlySet<number>,
  enabled = usesCurrentComments(project),
): NextComment[] {
  if (!enabled || !Array.isArray(project.comments) || project.comments.length === 0) return [];
  return project.comments.flatMap((raw, index): NextComment[] => {
    if (!isObject(raw)) return [];
    const saw = asArray(raw.saw).filter(isObject)
      .filter(item => typeof item.path === 'string' && typeof item.sha256 === 'string')
      .map(item => ({ path: String(item.path), sha256: String(item.sha256) }));
    return [{
      comment: index,
      act_sha256: commentReceiptSha(project, index),
      source: raw.source ?? null,
      at: raw.at ?? null,
      by: raw.by ?? null,
      status: commentStatus(dir, raw),
      closed: closed.has(index),
      saw,
      comments: asArray(raw.comments),
    }];
  });
}

export interface CommentActMove {
  readonly role: 'agent';
  readonly field: string;
  readonly awaits: string;
  readonly command: string;
  readonly act: string;
}

/**
 * Attach `comments` status views and unacted current comment moves beside `next`'s progression moves.
 * Never removes or reorders advance or producer moves, and adds no human gate.
 */
export function withCurrentComments<Report extends {
  stage: string;
  awaits: string[];
  moves: { role: 'agent' | 'producer' | 'human'; field: string; awaits: string; command: string | null; act: string }[];
  comments?: NextComment[];
}>(
  dir: string,
  project: JsonObject,
  next: Report,
  quote: (value: string) => string,
  now: number,
  enabled = usesCurrentComments(project),
): Report {
  if (!enabled || !Array.isArray(project.comments) || project.comments.length === 0) return next;
  const { closed } = checkCommentClosures(dir, project, now);
  const comments = projectCommentViews(dir, project, closed, true);
  if (comments.length === 0) return next;

  const actMoves: CommentActMove[] = next.stage === PAUSED_STAGE ? [] : comments.flatMap((view): CommentActMove[] => {
    if (view.status !== 'current' || view.closed || view.act_sha256 === null) return [];
    const field = `comments[${view.comment}]`;
    return [{
      role: 'agent',
      field,
      awaits: field,
      command: `rig-create comment --close ${view.comment} ${quote(dir)} --act-sha256 ${view.act_sha256} --after '<path>=<sha256>'`,
      act: `Read comment ${view.comment} and act on it (project.json.${field}), then record the closure with the content hashes after the change.`,
    }];
  });

  const awaits = [...next.awaits];
  for (const move of actMoves) {
    if (!awaits.includes(move.awaits)) awaits.push(move.awaits);
  }
  return {
    ...next,
    comments,
    awaits,
    moves: [...next.moves, ...actMoves],
  };
}
