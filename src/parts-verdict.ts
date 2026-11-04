/**
 * The `parts-review` sign-off carries the verdict it rests on (rig-c/create#51):
 * `evidence: { kind: "parts-verdict", path, sha256 }`, where `path` is relative
 * to the project folder and names the file rig-review's parts view wrote
 * (`rig-review-parts-verdict/1`, rig-c/review docs/PARTS_VIEW.md). This module
 * reads exactly that file — no default lookup — and refuses `rigging`, each
 * case by name, when the verdict is not an approved parts-mode review of the
 * files now on disk.
 *
 * The verdict's `source.files[]` paths are relative to the verdict file's own
 * directory, in POSIX form. `source.sha256` is recomputed here from those
 * entries and never trusted: the SHA-256 of the UTF-8 lines
 * `<path>\t<sha256>\n`, sorted by path bytewise, as rig-review defines it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';

import type { Finding } from './check.ts';
import type { Json, JsonObject } from './templates.ts';

export const PARTS_VERDICT_SCHEMA = 'rig-review-parts-verdict/1';
export const PARTS_VERDICT_KIND = 'parts-verdict';

const SHA256 = /^[0-9a-f]{64}$/;

const isObj = (v: Json | undefined): v is JsonObject => v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
const str = (v: Json | undefined): string | null => (typeof v === 'string' ? v : null);

/** `source.sha256`: sha256 over the UTF-8 lines `<path>\t<sha256>\n`, sorted by path bytewise. */
export function sourceSha256(files: readonly { path: string; sha256: string }[]): string {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const hash = createHash('sha256');
  for (const f of sorted) hash.update(`${f.path}\t${f.sha256}\n`, 'utf8');
  return hash.digest('hex');
}

function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep);
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null; // missing, or a broken link: reported as the missing case it is
  }
}

/**
 * Whether `file`, with every link on its way followed, is under the real
 * project root: a link inside the project that points out of it leaves the
 * project as surely as a `../` path does. `null` when `file` does not resolve.
 */
function insideReal(realRoot: string, file: string): boolean | null {
  const resolved = real(file);
  return resolved === null ? null : inside(realRoot, resolved);
}

const REVIEW_AGAIN = 'open the parts in rig-review\'s parts view (`rig-review parts`), review them again, save the sign-off, and record a new parts-review sign-off whose evidence names the file it wrote';
const RECORD_EVIDENCE = `the parts-review sign-off carries the verdict it rests on: evidence { "kind": "${PARTS_VERDICT_KIND}", "path": <the file rig-review's parts view wrote, relative to the project>, "sha256": <that file's sha256> }`;

/**
 * Checks the verdict a `parts-review` sign-off rests on. `signoff` is the raw
 * sign-off record, `at` its path in project.json (`signoffs[3]`). Every
 * refusal found is pushed; none is pushed for an approved parts-mode verdict
 * whose source files are on disk as reviewed. Returns the covered parts.json
 * path only after a successful check, for deriving the difference-map stack.
 */
export function checkPartsVerdict(dir: string, signoff: JsonObject, at: string, refusals: Finding[]): string | undefined {
  const before = refusals.length;
  const push = (code: string, path: string, message: string): void => {
    refusals.push({ code, path, message });
  };
  const evPath = `${at}.evidence`;
  const ev = signoff.evidence;
  if (!isObj(ev) || ev.kind !== PARTS_VERDICT_KIND) {
    push('PARTS_VERDICT_MISSING', evPath, `${at}: the parts-review sign-off has no ${PARTS_VERDICT_KIND} evidence, so nothing ties it to the parts that were reviewed; ${RECORD_EVIDENCE}`);
    return;
  }
  const relPath = str(ev.path);
  const recorded = str(ev.sha256);
  if (relPath === null || relPath === '' || recorded === null || !SHA256.test(recorded)) {
    push('PARTS_VERDICT_MISSING', evPath, `${evPath}: needs path and sha256 (64 lowercase hex digits); ${RECORD_EVIDENCE}`);
    return;
  }

  // The file the sign-off names, exactly; no default lookup. Contained both as written and with links followed.
  const realRoot = real(dir) ?? dir;
  const file = resolve(dir, relPath);
  const notUnder = `${evPath}: ${relPath} is not under the project; the verdict is kept in the project folder`;
  if (!inside(dir, file)) {
    push('PARTS_VERDICT_UNREAD', evPath, notUnder);
    return;
  }
  const verdictInside = insideReal(realRoot, file);
  if (verdictInside === false) {
    push('PARTS_VERDICT_UNREAD', evPath, `${notUnder} (a link on its way points out of it)`);
    return;
  }
  if (verdictInside === null || !existsSync(file) || !statSync(file).isFile()) {
    push('PARTS_VERDICT_UNREAD', evPath, `${evPath}: ${relPath} is not there; the sign-off rests on that file — restore it, or ${REVIEW_AGAIN}`);
    return;
  }
  const bytes = readFileSync(file);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== recorded) {
    push('PARTS_VERDICT_UNREAD', evPath, `${evPath}: ${relPath} hashes to ${actual}, not the recorded ${recorded}; the verdict changed after the sign-off — ${REVIEW_AGAIN}`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    push('PARTS_VERDICT_UNREAD', evPath, `${evPath}: ${relPath} is not JSON`);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    push('PARTS_VERDICT_UNREAD', evPath, `${evPath}: ${relPath} is not a JSON object`);
    return;
  }
  const v = parsed as JsonObject;
  const vAt = `${evPath} ${relPath}`;

  if (v.schema !== PARTS_VERDICT_SCHEMA) {
    push('PARTS_VERDICT_SCHEMA_UNKNOWN', `${vAt} schema`, `${relPath}: schema is ${JSON.stringify(v.schema ?? null)}; this check reads ${PARTS_VERDICT_SCHEMA}, as rig-review's parts view writes it`);
    return;
  }
  if (v.mode === 'atlas') {
    push('PARTS_VERDICT_ATLAS', `${vAt} mode`, `${relPath}: an atlas-mode verdict reviews a built rig's atlas; it is informational and never gates parts-review — ${REVIEW_AGAIN} (parts mode: \`rig-review parts\` on the assembled parts)`);
    return;
  }
  if (v.mode !== 'parts') {
    push('PARTS_VERDICT_MALFORMED', `${vAt} mode`, `${relPath}: mode is ${JSON.stringify(v.mode ?? null)}; a verdict's mode is parts or atlas, and parts-review rests on parts`);
    return;
  }

  if (v.status !== 'approved') {
    push('PARTS_VERDICT_NOT_APPROVED', `${vAt} status`, `${relPath}: status is ${JSON.stringify(v.status ?? null)}; rigging starts on an approved verdict (every part clean) — fix the flagged parts in parts, then ${REVIEW_AGAIN}`);
  }

  const source = isObj(v.source) ? v.source : null;
  const files = source !== null && Array.isArray(source.files) ? source.files : null;
  const field = source !== null ? str(source.sha256) : null;
  if (files === null || files.length === 0 || field === null) {
    push('PARTS_VERDICT_MALFORMED', `${vAt} source`, `${relPath}: source needs files[] (parts.json first, then every part image) and sha256`);
    return;
  }
  const base = dirname(file);
  const entries: { path: string; sha256: string }[] = [];
  let malformed = false;
  files.forEach((raw, k) => {
    const ePath = `${vAt} source.files[${k}]`;
    const e = isObj(raw) ? raw : {};
    const p = str(e.path);
    const sha = str(e.sha256);
    const size = e.bytes;
    if (p === null || p === '' || sha === null || !SHA256.test(sha) || typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      push('PARTS_VERDICT_MALFORMED', ePath, `${relPath} source.files[${k}]: an entry is { path, bytes, sha256 }`);
      malformed = true;
      return;
    }
    if (p.includes('\\') || posix.isAbsolute(p)) {
      push('PARTS_VERDICT_MALFORMED', ePath, `${relPath} source.files[${k}]: ${p} is not a POSIX path relative to the verdict's directory`);
      malformed = true;
      return;
    }
    if (k === 0 && posix.basename(p) !== 'parts.json') {
      push('PARTS_VERDICT_MALFORMED', ePath, `${relPath} source.files[0]: ${p}; a parts verdict lists parts.json first`);
      malformed = true;
    }
    entries.push({ path: p, sha256: sha });
    const abs = resolve(base, ...p.split('/'));
    if (!inside(dir, abs)) {
      push('PARTS_VERDICT_MALFORMED', ePath, `${relPath} source.files[${k}]: ${p} is not under the project`);
      malformed = true;
      return;
    }
    const sourceInside = insideReal(realRoot, abs);
    if (sourceInside === false) {
      push('PARTS_VERDICT_MALFORMED', ePath, `${relPath} source.files[${k}]: ${p} is not under the project (a link on its way points out of it)`);
      malformed = true;
      return;
    }
    if (sourceInside === null || !existsSync(abs) || !statSync(abs).isFile()) {
      push('PARTS_VERDICT_SOURCE_CHANGED', ePath, `${relPath} source.files[${k}]: ${p} is not on disk; the parts changed after the sign-off (a part removed or moved) — ${REVIEW_AGAIN}`);
      return;
    }
    const now = readFileSync(abs);
    const nowSha = createHash('sha256').update(now).digest('hex');
    if (now.length !== size || nowSha !== sha) {
      push('PARTS_VERDICT_SOURCE_CHANGED', ePath, `${relPath} source.files[${k}]: ${p} is ${now.length} B, sha256 ${nowSha}; reviewed as ${size} B, sha256 ${sha} — a part changed after the sign-off; ${REVIEW_AGAIN}`);
    }
  });
  if (malformed) return;
  const recomputed = sourceSha256(entries);
  if (recomputed !== field) {
    push('PARTS_VERDICT_SOURCE_MISMATCH', `${vAt} source.sha256`, `${relPath}: source.sha256 is ${field}, but its files[] hash to ${recomputed}; the verdict's record of what was reviewed does not hold together — ${REVIEW_AGAIN}`);
  }
  if (refusals.length === before) return resolve(base, ...entries[0].path.split('/'));
}
