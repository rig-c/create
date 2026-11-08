import { checkPartsActEvidence } from './parts-act.ts';
/**
 * The `parts-review` sign-off carries the verdict it rests on (rig-c/create#51):
 * `evidence: { kind: "parts-verdict", path, sha256 }`, where `path` is relative
 * to the project folder and names the file rig-review's parts view wrote
 * (`rig-review-parts-verdict/1` or `/2`, rig-c/review docs/PARTS_VIEW.md). This module
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
import { Refusal, refuse } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export const PARTS_VERDICT_SCHEMA = 'rig-review-parts-verdict/1';
export const PARTS_VERDICT_SCHEMA_V2 = 'rig-review-parts-verdict/2';
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

/**
 * The `evidence` binding for the verdict file named on a command line (`given`,
 * relative to `dir` or absolute): its project-relative POSIX path, with links
 * followed, and the sha256 of its bytes. Refuses PARTS_VERDICT_UNREAD when the
 * file is missing, unreadable or outside the project. The binding is then read
 * by checkPartsVerdict.
 */
export function partsVerdictEvidence(dir: string, given: string): JsonObject {
  let verdictFile: string;
  try {
    verdictFile = realpathSync(resolve(dir, given));
  } catch (error) {
    refuse('PARTS_VERDICT_UNREAD', `${given}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const path = relative(realpathSync(dir), verdictFile).split(sep).join('/');
  if (path === '' || path.startsWith('..') || isAbsolute(path)) refuse('PARTS_VERDICT_UNREAD', 'the verdict must be under the project');
  let bytes: Buffer;
  try {
    bytes = readFileSync(verdictFile);
  } catch (error) {
    refuse('PARTS_VERDICT_UNREAD', `${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { kind: PARTS_VERDICT_KIND, path, sha256: createHash('sha256').update(bytes).digest('hex') };
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
export function checkPartsVerdict(dir: string, signoff: JsonObject, at: string, refusals: Finding[], project?: JsonObject): string | undefined {
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

  if (v.schema === 'rig-review/act@2') {
    try { return checkPartsActEvidence(dir, bytes, recorded, project); }
    catch (error) { push(error instanceof Refusal ? error.code : 'PARTS_VERDICT_MALFORMED', evPath,
      error instanceof Refusal ? error.message : `${evPath}: invalid semantic evidence; restore its recorded act`); return; }
  }

  if (v.schema !== PARTS_VERDICT_SCHEMA && v.schema !== PARTS_VERDICT_SCHEMA_V2) {
    push('PARTS_VERDICT_SCHEMA_UNKNOWN', `${vAt} schema`, `${relPath}: schema is ${JSON.stringify(v.schema ?? null)}; this check reads ${PARTS_VERDICT_SCHEMA} or ${PARTS_VERDICT_SCHEMA_V2}; save a verdict with a supported rig-review parts view, as rig-review's parts view writes it`);
    return;
  }
  // /2 comments remain in the hash-bound verdict; create does not interpret
  // regions, cameras or crops (the field census is in docs/PROJECT.md). Both
  // supported schemas use every mode, approval and source check below.
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

/**
 * The day the verdict-to-draft binding landed (rig-c/create#236): a parts-review
 * sign-off carrying `draft_id` dated from it is refused when its verdict does
 * not review that draft's parts; an earlier one WARNs with the same code.
 */
export const PARTS_VERDICT_DRAFT_SINCE = '2026-11-08T00:00:00Z';

export type FileBinding = { path: string; sha256: string };

function bindings(list: Json | undefined): FileBinding[] | null {
  if (!Array.isArray(list)) return null;
  const out: FileBinding[] = [];
  for (const raw of list) {
    if (!isObj(raw)) return null;
    const path = str(raw.path);
    const sha = str(raw.sha256);
    if (path === null || sha === null || !SHA256.test(sha)) return null;
    out.push({ path, sha256: sha });
  }
  return out;
}

/** The bytes at `file` when it is a regular file under the project, links followed, hashing to `sha`; else null. */
function boundBytes(dir: string, file: string, sha: string): Buffer | null {
  const realRoot = real(dir) ?? dir;
  if (!inside(dir, file) || insideReal(realRoot, file) !== true || !statSync(file).isFile()) return null;
  const bytes = readFileSync(file);
  return createHash('sha256').update(bytes).digest('hex') === sha ? bytes : null;
}

const listed = (paths: string[]): string => paths.length === 0 ? 'none'
  : `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`;

/** The entries of `side` whose sha256 the other side does not match, one for one. */
function unmatched(side: FileBinding[], other: FileBinding[]): string[] {
  const counts = new Map<string, number>();
  for (const f of other) counts.set(f.sha256, (counts.get(f.sha256) ?? 0) + 1);
  const out: string[] = [];
  for (const f of side) {
    const n = counts.get(f.sha256) ?? 0;
    if (n > 0) counts.set(f.sha256, n - 1);
    else out.push(f.path);
  }
  return out;
}

/**
 * Whether the parts verdict a `parts-review` sign-off rests on reviews the
 * parts of the draft it names (rig-c/create#236), shared by `signoff
 * parts-review --draft`, `structure-snapshot` and the check. It matches the
 * sha256 multiset of the verdict's `source.files[]` against the draft's
 * `parts.files[]` and `files[]`, by bytes and never by path (the verdict may
 * read the assembled root, the draft its own copy). Every verdict file must be
 * one of those, and every `parts.files[]` entry must be in the verdict. A
 * `files[]` entry the verdict does not list is not missing: a parts view that
 * shows meshes also lists `rig.json`, `mesh_report.json` and the mesh rasters
 * (rig-c/create#245), the draft's outputs, while a parts-only view lists none.
 * It leaves out only the raster the draft's `parts.json` declares under
 * `painting_in_rig`, on either side, read from those bytes and never
 * inferred. It measures nothing else.
 *
 * Returns the PARTS_VERDICT_DRAFT_MISMATCH finding at `path`, or null when the
 * two match. It is also null when it cannot read the binding: an unreadable or
 * malformed verdict, an unknown or malformed draft, or a `parts.json` whose
 * bytes are on neither side's disk while both list them. Those are other
 * readers' findings (PARTS_VERDICT_*, STRUCTURE_DECISIONS_*, DRAFT_RIG_*).
 */
export function partsVerdictDraftFinding(dir: string, project: JsonObject, evidence: Json | undefined, draftId: Json | undefined, path: string): Finding | null {
  if (!isObj(evidence) || typeof draftId !== 'string') return null;
  const relPath = str(evidence.path);
  const recorded = str(evidence.sha256);
  if (relPath === null || relPath === '' || recorded === null || !SHA256.test(recorded)) return null;
  const file = resolve(dir, relPath);
  let verdict: Json;
  try {
    const bytes = boundBytes(dir, file, recorded);
    if (bytes === null) return null;
    verdict = JSON.parse(bytes.toString('utf8')) as Json;
  } catch {
    return null;
  }
  if (isObj(verdict) && verdict.schema === 'rig-review/act@2') {
    const source = isObj(verdict.source) ? verdict.source : {};
    const selector = isObj(source.selector) ? source.selector : {};
    return selector.kind === 'draft' && selector.id === draftId ? null : { code: 'PARTS_VERDICT_DRAFT_MISMATCH', path,
      message: `${path}: semantic verdict names draft ${String(selector.id)} rather than ${String(draftId)}; use the reviewed draft id` };
  }
  const reviewed = isObj(verdict) && isObj(verdict.source) ? bindings(verdict.source.files) : null;
  const draft = Array.isArray(project.drafts) ? project.drafts.find(d => isObj(d) && d.id === draftId) : undefined;
  const parts = isObj(draft) && isObj(draft.parts) ? draft.parts : null;
  const partsPath = parts === null ? null : str(parts.path);
  const bound = parts === null ? null : bindings(parts.files);
  if (reviewed === null || reviewed.length === 0 || partsPath === null || bound === null) return null;
  // Outputs that cannot be read match nothing: DRAFT_RIG_MALFORMED is their finding, and the parts still compare.
  const outputs = (isObj(draft) ? bindings(draft.files) : null) ?? [];
  const manifest = bound.find(f => f.path === `${partsPath}/parts.json`);
  if (manifest === undefined) return null;

  // The painting parts.json declares, read from bytes bound to the draft's parts.json: its own copy, or the verdict's.
  const base = dirname(file);
  const verdictManifest = reviewed.find(f => posix.basename(f.path) === 'parts.json');
  const candidates = [resolve(dir, manifest.path), ...reviewed.filter(f => posix.basename(f.path) === 'parts.json' && f.sha256 === manifest.sha256).map(f => resolve(base, ...f.path.split('/')))];
  let painting: string | null | undefined;
  for (const candidate of candidates) {
    try {
      const bytes = boundBytes(dir, candidate, manifest.sha256);
      if (bytes === null) continue;
      const declared = JSON.parse(bytes.toString('utf8')) as Json;
      const entry = isObj(declared) ? declared.painting_in_rig : undefined;
      painting = isObj(entry) ? str(entry.path) : null;
      break;
    } catch {
      continue;
    }
  }
  // Both sides list those parts.json bytes, but neither holds them: the declaration cannot be read (derived/ need not survive a clone).
  if (painting === undefined && reviewed.some(f => f.sha256 === manifest.sha256)) return null;
  const draftPainting = painting ? `${partsPath}/${painting}` : null;
  const verdictPainting = painting && verdictManifest !== undefined ? posix.join(posix.dirname(verdictManifest.path), painting) : null;
  const verdictSide = reviewed.filter(f => f.path !== verdictPainting);
  const draftSide = bound.filter(f => f.path !== draftPainting);
  // A verdict file matches a part or an output; only a part can be missing from the verdict.
  const { verdictOnly, draftOnly } = comparePartsVerdictBindings(verdictSide, draftSide, outputs);
  if (verdictOnly.length === 0 && draftOnly.length === 0) return null;
  const left = draftPainting === null ? 'leaving out nothing, as its parts.json declares no painting_in_rig it could read'
    : `leaving out only ${draftPainting}, which its parts.json declares under painting_in_rig`;
  return {
    code: 'PARTS_VERDICT_DRAFT_MISMATCH',
    path,
    message: `${path}: the parts verdict ${relPath} does not review draft ${draftId}'s parts; compared by sha256, ${left}, the verdict lists ${verdictOnly.length} file(s) the draft does not bind among its parts or outputs (${listed(verdictOnly)}) and the draft binds ${draftOnly.length} the verdict does not list (${listed(draftOnly)}); review the parts of draft ${draftId} in rig-review's parts view and sign with that verdict, or name the draft whose parts the verdict reviewed`,
  };
}

/** Shared source-list comparison, after each reader removes its declared painting. */
export function comparePartsVerdictBindings(reviewed: FileBinding[], parts: FileBinding[], outputs: FileBinding[]): { verdictOnly: string[]; draftOnly: string[] } {
  return { verdictOnly: unmatched(reviewed, [...parts, ...outputs]), draftOnly: unmatched(parts, reviewed) };
}
