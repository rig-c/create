/**
 * The project's fix ledger (create#285): the owner fixes every version inherits, and the producer
 * ledger reports a draft is recorded with. create never runs a ledger check. It binds the report a
 * project's own check script wrote by its sha256 and spec, and compares only the report's rows with
 * the ledger: coverage, build identity, the rows the predecessor draft passed, and what a draft fixes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { asArray, isObject, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { IGNORED_DIRS } from './init.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { newRefusals } from './refusal-baseline.ts';
import type { Json, JsonObject } from './templates.ts';

/** Drafts recorded from this date bind a ledger report whenever the ledger has a live row; earlier drafts WARN. */
export const FIX_LEDGER_SINCE = '2026-11-09T00:00:00Z';
export const FIX_LEDGER_REPORT_SPEC = 'rig-create/fix-ledger-report@1';

const RESULTS = ['pass', 'fail', 'unmeasurable'] as const;
const ROW_KEYS = ['id', 'note', 'at', 'by', 'check', 'bar', 'retired'];
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
/** A correction by id, or a verdict by version number and index, as the record paths name them. */
const NOTE_REF = /^(?:corrections\[([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\]|versions\[v(\d+)\]\.verdicts\[(\d+)\])$/;
const hex = (v: Json | undefined): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: Json | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const time = (v: Json | undefined): number => typeof v === 'string' ? Date.parse(v) : NaN;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const literal = (value: Json | undefined): value is string => typeof value === 'string' && value !== ''
  && !isAbsolute(value) && !value.includes('\\') && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
const finding = (code: string, path: string, message: string): Finding => ({ code, path, message: `${path}: ${message}` });

export interface LedgerRow { readonly id: string; readonly at: number; readonly retiredAt: number | null }

/** Rows a draft recorded at `at` must cover: written by then and not retired by then. */
export const liveRows = (rows: readonly LedgerRow[], at: number): LedgerRow[] => rows.filter(r => r.at <= at && (r.retiredAt === null || r.retiredAt > at));

/** The owner words the note's reference points at, or undefined when the record no longer holds it. */
function noteWords(project: JsonObject, ref: string): string | undefined {
  const match = NOTE_REF.exec(ref);
  if (!match) return undefined;
  if (match[1] !== undefined) {
    const correction = asArray(project.corrections).filter(isObject).find(c => c.id === match[1]);
    return typeof correction?.verbatim === 'string' ? correction.verbatim : undefined;
  }
  const version = asArray(project.versions).filter(isObject).find(v => v.n === Number(match[2]));
  const verdict = version === undefined ? undefined : asArray(version.verdicts)[Number(match[3])];
  return isObject(verdict) && typeof verdict.verbatim === 'string' ? verdict.verbatim : undefined;
}

/**
 * Validate `fix_ledger` rows; the ledger writer and check share this. Returns null when the ledger is absent.
 * The row being written (`writing`) must quote a note the record holds. Check does not re-read older rows'
 * notes: a restart retires the record they pointed into, and the row keeps the words it quoted.
 */
export function ledgerRows(project: JsonObject, refusals: Finding[], now: number, writing?: number): LedgerRow[] | null {
  if (project.fix_ledger === undefined) return null;
  if (!Array.isArray(project.fix_ledger)) { refusals.push(finding('FIX_LEDGER_MALFORMED', 'fix_ledger', 'expected a list of rows; restore the rows written by ledger add')); return []; }
  const rows: LedgerRow[] = [];
  const ids = new Set<string>();
  project.fix_ledger.forEach((raw, index) => {
    const path = `fix_ledger[${index}]`;
    const bad = (why: string): void => { refusals.push(finding('FIX_LEDGER_MALFORMED', path, `${why}; restore the row ledger add wrote, or retire it with ledger retire`)); };
    if (!isObject(raw) || Object.keys(raw).some(key => !ROW_KEYS.includes(key))) return bad(`expected only ${ROW_KEYS.join(', ')}`);
    if (typeof raw.id !== 'string' || !idPattern.test(raw.id) || ids.has(raw.id)) return bad('needs a unique id');
    ids.add(raw.id);
    const at = time(raw.at);
    if (!Number.isFinite(at) || at > now) return bad('needs an at that is not in the future');
    if (!text(raw.by) || !text(raw.check) || !text(raw.bar)) return bad('needs by, check and bar text');
    const note = raw.note;
    if (!isObject(note) || typeof note.ref !== 'string' || !NOTE_REF.test(note.ref) || !text(note.verbatim)) {
      return bad('needs note { ref: corrections[<id>] or versions[v<n>].verdicts[<i>], verbatim }');
    }
    let retiredAt: number | null = null;
    if (raw.retired !== undefined) {
      const retired = raw.retired;
      retiredAt = isObject(retired) ? time(retired.at) : NaN;
      if (!isObject(retired) || !Number.isFinite(retiredAt) || retiredAt < at || retiredAt > now || !text(retired.by) || !text(retired.reason)) {
        return bad('retired needs { at, by, reason } dated after the row and not in the future');
      }
    }
    if (index === writing) {
      const words = noteWords(project, note.ref);
      if (words === undefined) refusals.push(finding('FIX_LEDGER_NOTE_UNKNOWN', `${path}.note.ref`, `${note.ref} names no recorded correction or verdict; quote an owner note the record holds`));
      else if (!words.includes(note.verbatim)) refusals.push(finding('FIX_LEDGER_NOTE_MISMATCH', `${path}.note.verbatim`, `the words are not in ${note.ref}; quote the owner's words verbatim`));
    }
    rows.push({ id: raw.id, at, retiredAt });
  });
  return rows;
}

/** The report bytes at a project-relative path outside ignored roots, read the way the writer and check both do. */
function reportBytes(dir: string, path: Json | undefined, at: string): Buffer | Finding {
  const invalid = (why: string): Finding => finding('DRAFT_LEDGER_REPORT_INVALID', at, `${why}; retain the report the project's check script wrote under the project (for example evidence/) and record the draft with --ledger-report`);
  if (!literal(path)) return invalid('the report needs a literal project-relative path');
  if ([...IGNORED_DIRS, 'node_modules', '.git'].includes(path.split('/')[0]!)) return invalid(`${path} is under an ignored root and would not survive a clone`);
  try {
    const root = realpathSync(dir);
    const file = realpathSync(resolve(dir, path));
    const rel = relative(root, file);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return invalid(`${path} leaves the project through a link`);
    if (!statSync(file).isFile()) return invalid(`${path} is not a regular file`);
    return readFileSync(file);
  } catch { return invalid(`${path} is not there or cannot be read`); }
}

interface LedgerReport { readonly manifest: string; readonly results: Map<string, string> }

/** The report's own fields, read and never recomputed. */
function decodeReport(bytes: Buffer, at: string): LedgerReport | Finding {
  const invalid = (why: string): Finding => finding('DRAFT_LEDGER_REPORT_INVALID', at, `${why}; record the draft with the ${FIX_LEDGER_REPORT_SPEC} JSON the project's check script wrote`);
  let report: Json;
  try { report = JSON.parse(bytes.toString('utf8')) as Json; } catch { return invalid('the report is not JSON'); }
  if (!isObject(report) || report.schema !== FIX_LEDGER_REPORT_SPEC) return invalid(`schema is not ${FIX_LEDGER_REPORT_SPEC}`);
  if (!isObject(report.build) || !hex(report.build.manifest_sha256)) return invalid('build.manifest_sha256 must be the sha256 of the build\'s parts.json');
  if (!hex(report.script_sha256)) return invalid('script_sha256 must be the sha256 of the check script');
  if (!Array.isArray(report.rows)) return invalid('rows must be a list');
  const results = new Map<string, string>();
  for (const [index, row] of report.rows.entries()) {
    if (!isObject(row) || typeof row.id !== 'string' || !idPattern.test(row.id) || results.has(row.id) || !RESULTS.includes(row.result as typeof RESULTS[number])) {
      return invalid(`rows[${index}] needs a unique id and a result of ${RESULTS.join(', ')}`);
    }
    results.set(row.id, String(row.result));
  }
  return { manifest: report.build.manifest_sha256, results };
}

/** The report a draft binds, checked against its binding; null when the draft binds none. */
function draftReport(dir: string, draft: JsonObject, path: string): LedgerReport | Finding | null {
  const binding = draft.ledger_report;
  if (binding === undefined) return null;
  const at = `${path}.ledger_report`;
  if (!isObject(binding) || binding.spec !== FIX_LEDGER_REPORT_SPEC || !hex(binding.sha256) || !literal(binding.path)) {
    return finding('DRAFT_LEDGER_REPORT_INVALID', at, `needs { path, sha256, spec: ${FIX_LEDGER_REPORT_SPEC} }; record the draft with --ledger-report`);
  }
  const bytes = reportBytes(dir, binding.path, at);
  if (!Buffer.isBuffer(bytes)) return bytes;
  if (sha(bytes) !== binding.sha256) return finding('DRAFT_LEDGER_REPORT_INVALID', at, `${binding.path} differs from its recorded sha256; restore the report the draft was recorded with`);
  return decodeReport(bytes, at);
}

const manifestOf = (draft: JsonObject): string | undefined => {
  const parts = isObject(draft.parts) ? draft.parts : {};
  const entry = asArray(parts.files).filter(isObject).find(f => f.path === `${String(parts.path)}/parts.json`);
  return typeof entry?.sha256 === 'string' ? entry.sha256 : undefined;
};

const hasPartsReceipt = (project: JsonObject, id: string): boolean => asArray(project.review_acts)
  .some(entry => isObject(entry) && entry.kind === 'parts-verdict' && entry.draft_id === id);

/**
 * "The last draft a person accepted or saw" for drafts[index]: the latest earlier draft with a recorded
 * parts-review receipt (any verdict), else the previous draft, else none.
 */
export function fixesAgainst(project: JsonObject, index: number): string | null {
  const earlier = asArray(project.drafts).slice(0, index).filter(isObject);
  const seen = [...earlier].reverse().find(d => typeof d.id === 'string' && hasPartsReceipt(project, d.id));
  const chosen = seen ?? earlier.at(-1);
  return typeof chosen?.id === 'string' ? chosen.id : null;
}

/** Live rows the report passes that the reference draft's report did not pass, in ledger order. */
const fixedRows = (live: LedgerRow[], results: Map<string, string>, reference: LedgerReport | null): string[] =>
  live.filter(r => results.get(r.id) === 'pass' && reference?.results.get(r.id) !== 'pass').map(r => r.id);

/** The fixes the writer records for drafts[index] against the named reference; reports are read, never produced. */
export function draftFixes(dir: string, project: JsonObject, index: number, against: string | null, now: number): string[] {
  const rows = ledgerRows(project, [], now) ?? [];
  const drafts = asArray(project.drafts);
  const draft = drafts[index] as JsonObject;
  const report = draftReport(dir, draft, `drafts[${index}]`);
  if (report === null || 'code' in report) return [];
  const refIndex = drafts.findIndex(d => isObject(d) && d.id === against);
  const reference = refIndex < 0 ? null : draftReport(dir, drafts[refIndex] as JsonObject, `drafts[${refIndex}]`);
  return fixedRows(liveRows(rows, time(draft.at)), report.results, reference === null || 'code' in reference ? null : reference);
}

export interface LedgerSummary { readonly draft: string; readonly fixes: string[]; readonly known_regressions: string[] }

/**
 * check and the writers: ledger rows, restarts[], and every draft's ledger binding. Returns the
 * per-draft fixes check reports.
 */
export function checkFixLedger(dir: string, project: JsonObject, refusals: Finding[], warnings: Finding[], now: number): LedgerSummary[] {
  checkRestarts(project, refusals);
  const rows = ledgerRows(project, refusals, now);
  const drafts = asArray(project.drafts);
  if (rows === null && drafts.length > 0) {
    warnings.push(finding('FIX_LEDGER_MISSING', 'fix_ledger', 'the project has drafts but no fix ledger, so no draft is checked against earlier accepted fixes; record each accepted owner fix with ledger add'));
  }
  const reports: (LedgerReport | null)[] = [];
  const owed: string[][] = [];
  const summaries: LedgerSummary[] = [];
  drafts.forEach((raw, index) => {
    const path = `drafts[${index}]`;
    reports[index] = null;
    if (!isObject(raw) || typeof raw.id !== 'string') return; // DRAFT_RIG_MALFORMED reports it.
    const at = time(raw.at);
    const live = liveRows(rows ?? [], at);
    const malformed = (why: string): void => { refusals.push(finding('DRAFT_LEDGER_MALFORMED', path, `${why}; record the draft again with draft-rig under a new id; the old record is kept`)); };
    const report = draftReport(dir, raw, path);
    if (report === null) {
      if (raw.fixes !== undefined || raw.fixes_against !== undefined || raw.known_regressions !== undefined) malformed('fixes, fixes_against and known_regressions need a ledger_report');
      if (live.length > 0) {
        const legacy = !Number.isFinite(at) || at < Date.parse(FIX_LEDGER_SINCE);
        (legacy ? warnings : refusals).push(finding('DRAFT_LEDGER_REPORT_MISSING', `${path}.ledger_report`, `the ledger had ${live.length} live row(s) (${live.map(r => r.id).join(', ')}) when the draft was recorded, and it binds no ledger report${legacy ? '; legacy record kept' : ''}; run the project's check script on the build and record the draft with draft-rig --ledger-report <file>`));
      }
      return;
    }
    if ('code' in report) { refusals.push(report); return; }
    reports[index] = report;
    const manifest = manifestOf(raw);
    if (manifest !== report.manifest) {
      refusals.push(finding('DRAFT_LEDGER_BUILD_MISMATCH', `${path}.ledger_report`, `the report's build.manifest_sha256 ${report.manifest} is not the draft's parts.json (${manifest ?? 'unbound'}); run the check script on this draft's build and record the draft with that report`));
    }
    const missing = live.filter(r => !report.results.has(r.id)).map(r => r.id);
    if (missing.length) {
      refusals.push(finding('DRAFT_LEDGER_INCOMPLETE', `${path}.ledger_report`, `the report has no row for ${missing.join(', ')}; run the check script over every non-retired fix_ledger row and record the draft with that report`));
    }
    const known = asArray(raw.known_regressions);
    if (raw.known_regressions !== undefined && (!Array.isArray(raw.known_regressions) || known.length === 0
      || known.some(k => !isObject(k) || typeof k.id !== 'string' || !text(k.reason)) || new Set(known.map(k => (k as JsonObject).id)).size !== known.length)) {
      malformed('known_regressions needs a list of { id, reason } with unique ids');
      return;
    }
    const knownIds = known.map(k => String((k as JsonObject).id));
    owed[index] = knownIds;
    // The predecessor is the previous recorded draft; a restart clears drafts, so its first draft has none.
    // What it owes is every row it passed and every row it recorded as a known regression: a known regression stays owed.
    const predecessor = index > 0 ? reports[index - 1] : null;
    const debt = new Set(index > 0 ? owed[index - 1] ?? [] : []);
    const regressed = predecessor ? live.filter(r => (predecessor.results.get(r.id) === 'pass' || debt.has(r.id)) && report.results.get(r.id) !== 'pass').map(r => r.id) : [];
    const unnamed = regressed.filter(id => !knownIds.includes(id));
    if (unnamed.length) {
      refusals.push(finding('DRAFT_LEDGER_REGRESSION', `${path}.ledger_report`, `${unnamed.map(id => `${id} (${report.results.get(id) ?? 'absent'})`).join(', ')} passed in ${String((drafts[index - 1] as JsonObject).id)}, or are known regressions it still owes, and do not pass here; fix the build, or record it with --known-regression <row id>=<reason file> for each row`));
    }
    const stray = knownIds.filter(id => !regressed.includes(id));
    if (stray.length) malformed(`known_regressions names ${stray.join(', ')}, which the predecessor draft neither passed nor owed`);
    // The writer chose the reference when it recorded the draft; a receipt recorded later for another draft does not move it.
    const against = raw.fixes_against;
    const previous = index > 0 && isObject(drafts[index - 1]) ? (drafts[index - 1] as JsonObject).id : undefined;
    const allowed = index === 0 ? against === null : typeof against === 'string' && (against === previous
      || drafts.slice(0, index).some(d => isObject(d) && d.id === against && hasPartsReceipt(project, against)));
    if (!allowed) {
      malformed(`fixes_against must name an earlier draft with a parts-review receipt, or the previous draft (${fixesAgainst(project, index) ?? 'none'})`);
      return;
    }
    const refIndex = drafts.findIndex(d => isObject(d) && d.id === against);
    const reference = refIndex >= 0 && refIndex < index ? reports[refIndex] ?? null : null;
    const fixes = fixedRows(live, report.results, reference);
    if (!Array.isArray(raw.fixes) || JSON.stringify(raw.fixes) !== JSON.stringify(fixes)) malformed(`fixes must be [${fixes.join(', ')}], the live rows this report passes that ${against ?? 'no earlier draft'} did not`);
    summaries.push({ draft: raw.id, fixes, known_regressions: knownIds });
  });
  return summaries;
}

function checkRestarts(project: JsonObject, refusals: Finding[]): void {
  if (project.restarts === undefined) return;
  if (!Array.isArray(project.restarts)) { refusals.push(finding('RESTART_MALFORMED', 'restarts', 'expected a list written by restart')); return; }
  project.restarts.forEach((raw, index) => {
    if (!isObject(raw) || !Number.isFinite(time(raw.at)) || !text(raw.by) || !text(raw.reason) || !hex(raw.previous_record_sha256)) {
      refusals.push(finding('RESTART_MALFORMED', `restarts[${index}]`, 'needs { at, by, reason, previous_record_sha256 }; restore the entry restart wrote'));
    }
  });
}

/** The draft-rig fields for a ledger report, read from the report and the earlier drafts' reports. */
export function draftLedgerFields(dir: string, project: JsonObject, index: number, reportPath: string, known: [string, string][], now: number): JsonObject {
  const at = `drafts[${index}].ledger_report`;
  const bytes = reportBytes(dir, reportPath, at);
  if (!Buffer.isBuffer(bytes)) refuse(bytes.code, bytes.message);
  const fields: JsonObject = { ledger_report: { path: reportPath, sha256: sha(bytes), spec: FIX_LEDGER_REPORT_SPEC } };
  if (known.length) fields.known_regressions = known.map(([id, reason]) => ({ id, reason }));
  const candidate = structuredClone(project);
  const drafts = asArray(candidate.drafts);
  Object.assign(drafts[index] as JsonObject, fields);
  const against = fixesAgainst(candidate, index);
  fields.fixes_against = against;
  fields.fixes = draftFixes(dir, candidate, index, against, now);
  return fields;
}

export const LEDGER_HELP = `ledger:
  add <id> [<dir>] --by <who> --check <check id> --bar <text> --note <ref> --verbatim-file <file> [--json]
  retire <id> [<dir>] --by <who> --reason-file <file> [--json]
  Append a fix_ledger row { id, note { ref, verbatim }, at, by, check, bar }, or retire one with a reason.
  --note is corrections[<id>] or versions[v<n>].verdicts[<i>]; the words must be quoted from that note.
  Every version inherits every row; draft-rig --ledger-report binds the project's own check report.`;

export function ledgerCommand(args: string[], now: number): { stdout: string; exit: number } {
  const action = args[0];
  if (action !== 'add' && action !== 'retire') refuse('LEDGER_USAGE', LEDGER_HELP, USAGE_EXIT);
  const allowed = action === 'add' ? ['--by', '--check', '--bar', '--note', '--verbatim-file'] : ['--by', '--reason-file'];
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (allowed.includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '' || opts[arg] !== undefined) refuse('LEDGER_USAGE', `ledger ${action}: ${arg} needs one value; see ledger help`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('LEDGER_USAGE', `ledger ${action}: unsupported ${arg}; see ledger help`, USAGE_EXIT);
    else positional.push(arg);
  }
  const id = positional[0];
  if (!id || !idPattern.test(id) || positional.length > 2 || allowed.some(flag => opts[flag] === undefined)) refuse('LEDGER_USAGE', LEDGER_HELP, USAGE_EXIT);
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = readProject(dir);
  const original = readFileSync(file);
  const before = structuredClone(project);
  const rows = project.fix_ledger === undefined ? [] : project.fix_ledger;
  if (!Array.isArray(rows)) refuse('FIX_LEDGER_MALFORMED', 'fix_ledger: expected a list of rows; restore the rows written by ledger add');
  const stamp = new Date(now).toISOString();
  let index: number;
  let row: JsonObject;
  if (action === 'add') {
    const ref = opts['--note']!;
    if (!NOTE_REF.test(ref)) refuse('LEDGER_USAGE', `fix_ledger: --note ${ref} must be corrections[<id>] or versions[v<n>].verdicts[<i>]`, USAGE_EXIT);
    row = { id, note: { ref, verbatim: readVerbatim(opts['--verbatim-file']!).trim() }, at: stamp, by: opts['--by']!, check: opts['--check']!, bar: opts['--bar']! };
    index = rows.length;
    project.fix_ledger = [...rows, row];
  } else {
    index = rows.findIndex(r => isObject(r) && r.id === id);
    if (index < 0) refuse('LEDGER_ROW_UNKNOWN', `fix_ledger: no row has id ${id}; name a row ledger add wrote`);
    const current = rows[index] as JsonObject;
    if (current.retired !== undefined) refuse('LEDGER_ROW_RETIRED', `fix_ledger[${index}]: ${id} is already retired; the retirement is kept`);
    const reason = readVerbatim(opts['--reason-file']!).trim();
    if (!reason) refuse('LEDGER_USAGE', `fix_ledger[${index}].retired.reason: the reason file is empty; say why the fix no longer applies`, USAGE_EXIT);
    row = { ...current, retired: { at: stamp, by: opts['--by']!, reason } };
    project.fix_ledger = rows.map((r, i) => i === index ? row : r);
  }
  const errors: Finding[] = [];
  ledgerRows(project, errors, now, action === 'add' ? index : undefined);
  const own = errors.find(f => f.path.startsWith(`fix_ledger[${index}]`)) ?? errors.find(f => f.path === 'fix_ledger');
  if (own !== undefined) refuse(own.code, own.message);
  const rejected = newRefusals(dir, before, project, { now })[0];
  if (rejected !== undefined) refuse(rejected.code, rejected.message);
  writeRecord(file, original, project, 'ledger');
  return { stdout: json ? JSON.stringify(row, null, 2) : `ledger: ${action === 'add' ? 'added' : 'retired'} ${id}`, exit: 0 };
}

/** Replace project.json in one rename, refusing if it changed since it was read; a refusal writes nothing. */
export function writeRecord(file: string, original: Buffer, project: JsonObject, label: 'ledger' | 'restart'): void {
  const tmp = join(dirname(file), `.${label}-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(project, null, 2)}\n`, { flag: 'wx' });
    if (!readFileSync(file).equals(original)) refuse(label === 'ledger' ? 'LEDGER_SOURCE_CHANGED' : 'RESTART_SOURCE_CHANGED', `project.json: changed while ${label} was validating; retry against the current record`);
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}
