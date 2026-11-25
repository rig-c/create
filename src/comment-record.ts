/**
 * The project's `comments[]` entry made from a Review comment-only act (rig-review/act@10, #982).
 * It records what the person wrote and what was on screen, bound by content hash. It pins nothing.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JobCommentOnlyAct } from '@rig-c/review/job-host';
import type { Json, JsonObject } from './templates.ts';

export type CommentOnlyAct = JobCommentOnlyAct;
type FileRow = { readonly path: string; readonly sha256: string };

/** The record field naming the act, shared by the comment entry and any correction its carriers made. */
export function commentSource(act: { readonly jobId: string; readonly actId: string }): string {
  return `review act ${act.jobId}/${act.actId}`;
}

const fileRow = (value: unknown): value is FileRow => value !== null && typeof value === 'object'
  && typeof (value as FileRow).path === 'string' && typeof (value as FileRow).sha256 === 'string';

/**
 * The files the publication showed, projected from the daemon-attested rows of `source`:
 * model, direction, parts manifest and images (images resolve beside the manifest),
 * option-set file, inputs and files. Order is first appearance; repeats are dropped.
 */
export function commentSaw(act: CommentOnlyAct): FileRow[] {
  const source = act.source as unknown as Record<string, unknown>;
  const rows: FileRow[] = [];
  const add = (row: unknown, base = ''): void => {
    if (!fileRow(row)) return;
    const path = base ? `${base}/${row.path}` : row.path;
    if (!rows.some(seen => seen.path === path && seen.sha256 === row.sha256)) rows.push({ path, sha256: row.sha256 });
  };
  add(source.model);
  add(source.direction);
  const parts = source.parts as { manifest?: unknown; images?: unknown } | null | undefined;
  if (parts && fileRow(parts.manifest)) {
    add(parts.manifest);
    const slash = parts.manifest.path.lastIndexOf('/');
    const base = slash < 0 ? '' : parts.manifest.path.slice(0, slash);
    for (const image of Array.isArray(parts.images) ? parts.images : []) add(image, base);
  }
  add(source.optionSetFile);
  for (const key of ['inputs', 'files']) for (const row of Array.isArray(source[key]) ? source[key] : []) add(row);
  return rows;
}

/** The record hash and commit the publication declared. A commit is kept only when it was checked. */
export function commentRecord(act: CommentOnlyAct, commit: string | null): JsonObject | null {
  const projectHash = act.source.projectHash;
  return typeof projectHash === 'string' ? { sha256: projectHash, commit } : null;
}

/** The entry the comment writer appends; check rebuilds it from the retained act. */
export function commentEntry(act: CommentOnlyAct, by: string, commit: string | null): JsonObject {
  const carriers = act.value.carriers ?? [];
  return {
    source: commentSource(act), at: act.at, by,
    comments: act.value.comments.map(comment => JSON.parse(JSON.stringify(comment)) as Json),
    saw: commentSaw(act),
    record: commentRecord(act, commit),
    ...(carriers.length ? { carriers: carriers.map(carrier => ({ kind: carrier.kind, file: { path: carrier.file.path, sha256: carrier.file.sha256 },
      edits: carrier.kind === 'mesh-edits' ? carrier.meshEdits.length : carrier.chestLandmarks.length })) } : {}),
  };
}

/**
 * Why a recorded entry differs from its act, or null. `record.commit` is the act's
 * `source.commit` when ingest found it to hash to `source.projectHash`, else null.
 */
export function commentEntryFinding(entry: JsonObject, act: CommentOnlyAct, by: string): string | null {
  const record = entry.record;
  const declared = act.source.commit ?? null;
  const commit = record !== null && typeof record === 'object' && !Array.isArray(record) ? record.commit : null;
  if (commit !== null && commit !== declared) return 'record.commit is not the commit its publication declared';
  if (!isDeepStrictEqual(entry, commentEntry(act, by, commit as string | null))) {
    return 'entry differs from its immutable comment act (source, at, by, comments, saw, record or carriers)';
  }
  return null;
}
