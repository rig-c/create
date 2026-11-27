/**
 * Create never binds a record to anything under `scratch/` (rig-c/create#988).
 * Writers that read temporary text files from `scratch/` copy the text verbatim into
 * `project.json` without storing the path; any stored binding path into `scratch/`
 * refuses from `SCRATCH_BINDING_SINCE` (or without a readable date) and WARNs earlier.
 */
import { posix } from 'node:path';
import type { Finding } from './check.ts';
import { refuse } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export const SCRATCH_BINDING_SINCE = '2026-11-27T00:00:00Z';
export const SCRATCH_BINDING_FORBIDDEN = 'SCRATCH_BINDING_FORBIDDEN';

const REMEDY = 'move or regenerate the file outside scratch/ (for example inputs/, evidence/ or derived/) and re-record the binding; scratch/ is git-ignored working storage that Create never binds';

const DIRECT_PATH_KEYS = new Set([
  'evidence',
  'structure',
  'report',
  'ledger_report',
  'config',
  'direction',
  'scene',
  'set',
  'pending_options',
  'collection_binding',
  'file',
  'manifest',
  'mask',
  'before',
  'after',
  'idle',
  'sheets',
]);

const STRING_ARRAY_BINDING_KEYS = new Set([
  'built_from',
  'saw',
  'inputs',
  'files',
  'sources',
  'changes',
  'evidence',
  'added_evidence',
]);

function isObject(v: Json | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

/** True when `raw` is a project-relative path resolving to `scratch` or under `scratch/`. */
export function isScratchBindingPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return false;
  const slash = trimmed.replaceAll('\\', '/');
  if (slash.startsWith('/') || /^[A-Za-z]:/.test(slash) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(slash)) return false;
  const normalized = posix.normalize(slash);
  return normalized === 'scratch' || normalized.startsWith('scratch/');
}

/**
 * Source attribution strings (`source`) normally hold labels such as `"owner chat, relayed"`,
 * `"review questionnaire"` or `"interview, chat"`. Flag any `source` value that is itself a
 * `scratch/` path or cites a `scratch/<file>` path token, without matching prose like `"from scratch"`.
 */
export function isScratchSource(raw: string): boolean {
  if (isScratchBindingPath(raw)) return true;
  for (const match of raw.matchAll(/(?:^|[\s'"(])((?:\.\.?\/)*scratch\/[^\s'")]+)/g)) {
    if (isScratchBindingPath(match[1]!)) return true;
  }
  return false;
}

export function scratchBindingMessage(path: string, value: string, predatesAt?: string): string {
  const legacy = predatesAt === undefined
    ? ''
    : `; record dated ${predatesAt} predates ${SCRATCH_BINDING_SINCE}, so preserve history and bind outside scratch/ on the next write`;
  return `${path}: ${JSON.stringify(value)} points into scratch/; ${REMEDY}${legacy}`;
}

/** Guard for standalone writers before they write `project.json`. */
export function assertNotScratchBinding(rawPath: string, recordPath: string): void {
  if (isScratchBindingPath(rawPath)) {
    refuse(SCRATCH_BINDING_FORBIDDEN, scratchBindingMessage(recordPath, rawPath));
  }
}

function readableDate(value: Json | undefined): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function actBytesDate(node: JsonObject): string | undefined {
  if (typeof node.bytes !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(node.bytes);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return readableDate((parsed as JsonObject).at);
    }
  } catch { /* Malformed act bytes are reported by the act reader. */ }
  return undefined;
}

function nodeDate(node: JsonObject): string | undefined {
  return readableDate(node.at)
    ?? readableDate(node.drafted_at)
    ?? readableDate(node.adopted_at)
    ?? readableDate(node.updatedAt)
    ?? readableDate(node.proposed_at)
    ?? actBytesDate(node);
}

function paintingInputDate(record: JsonObject, paintingPath: string): string | undefined {
  if (!Array.isArray(record.inputs)) return undefined;
  for (const entry of record.inputs) {
    if (isObject(entry) && entry.path === paintingPath) {
      const at = readableDate(entry.at);
      if (at !== undefined) return at;
    }
  }
  return undefined;
}

function isNonFileDotPath(childPath: string, value: string, node: JsonObject, parentKey?: string): boolean {
  if (/^corrections\[\d+\]\.path$/.test(childPath) && (value === 'made' || value === 'described')) return true;
  if (/\.refusal_baseline\[\d+\]\.path$/.test(childPath)) return true;
  if (/^derived\[\d+\]\.members\[\d+\]\.path$/.test(childPath)) return true;
  if (/^drafts\[\d+\]\.reuse\.parts\[\d+\]\.path$/.test(childPath)) return true;
  if (/^versions\[\d+\]\.review_package\.files\[\d+\]\.path$/.test(childPath)) return true;
  if ((parentKey === 'value' || parentKey === 'other_fragment' || parentKey === 'fragment') && 'camera' in node && !('sha256' in node)) return true;
  return false;
}

function isBindingStringSlot(key: string, childPath: string, value: string, node: JsonObject, parentKey?: string): boolean {
  if (key === 'path') return !isNonFileDotPath(childPath, value, node, parentKey);
  if (childPath === 'painting' || childPath === 'split.proposal_image') return true;
  if (key === 'parts' && /^advances\[\d+\]\.parts_check\.parts$/.test(childPath)) return true;
  if (key === 'from' && (/\.review_package\.from$/.test(childPath) || /^derived\[\d+\]\.from$/.test(childPath))) return true;
  if (key === 'source_path') return true;
  if (key === 'image' && /\.plates\[\d+\]\.image$/.test(childPath)) return true;
  if (key === 'project' && /^members\[\d+\]\.project$/.test(childPath)) return true;
  if (DIRECT_PATH_KEYS.has(key)) return true;
  return false;
}

/**
 * Scan every recorded binding path and source pointer in `project.json` or `collection.json`.
 * Entries dated before `SCRATCH_BINDING_SINCE` emit a WARN; entries at/after it or without a
 * readable date emit a refusal.
 */
export function checkScratchBindings(record: JsonObject, refusals: Finding[], warnings: Finding[]): void {
  const since = Date.parse(SCRATCH_BINDING_SINCE);
  const emit = (path: string, value: string, at: string | undefined): void => {
    const atMs = at === undefined ? Number.NaN : Date.parse(at);
    const legacy = Number.isFinite(atMs) && atMs < since;
    (legacy ? warnings : refusals).push({
      code: SCRATCH_BINDING_FORBIDDEN,
      path,
      message: scratchBindingMessage(path, value, legacy ? at : undefined),
    });
  };

  const visit = (value: Json | undefined, path: string, enclosingAt: string | undefined, parentKey?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (typeof item === 'string') {
          if (
            /^versions\[\d+\]\.registration\.skipped\[\d+\]\.destinations\[\d+\]$/.test(itemPath)
            || (/^review_acts\[\d+\]\.argv\[\d+\]$/.test(itemPath) && !item.startsWith('-'))
            || (parentKey !== undefined && STRING_ARRAY_BINDING_KEYS.has(parentKey))
          ) {
            if (isScratchBindingPath(item)) emit(itemPath, item, enclosingAt);
          }
          return;
        }
        visit(item, itemPath, enclosingAt);
      });
      return;
    }
    if (!isObject(value)) return;

    const currentAt = path === '' ? enclosingAt : (nodeDate(value) ?? enclosingAt);
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (typeof child === 'string') {
        if (key === 'source') {
          if (!/^advances\[\d+\]\.parts_check\.reported\[\d+\]\.source$/.test(childPath) && isScratchSource(child)) {
            emit(childPath, child, currentAt);
          }
        } else if (isBindingStringSlot(key, childPath, child, value, parentKey) && isScratchBindingPath(child)) {
          const at = childPath === 'painting' ? (currentAt ?? paintingInputDate(record, child)) : currentAt;
          emit(childPath, child, at);
        }
        continue;
      }
      visit(child, childPath, currentAt, key);
    }
  };

  visit(record, '', undefined);
}
