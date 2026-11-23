import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstatSync, readdirSync, readFileSync } from './check-reads.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { asArray, isObject, readJsonObject, type Ctx } from './check.ts';
import { sourceSha256, type FileBinding } from './parts-verdict.ts';
import { checkDerivedReceipt, checkPlateRegistrations, maskReceiptSpec, MASK_RECEIPT_SPECS, readDerivedReceipt } from './plate-receipt.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

const nonempty = (v: Json | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const hex = (v: Json | undefined): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const memberPath = (v: Json | undefined): v is string =>
  nonempty(v) && !isAbsolute(v) && !v.includes('\\') && v.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const joinMember = (folder: string, member: string): string => `${folder.replace(/\/+$/, '')}/${member}`;

export function derivedTime(value: Json | undefined): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  const at = Date.parse(value);
  const day = Date.parse(value.slice(0, 10));
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10) ? at : NaN;
}

class RunMemberUnreadable extends Error {
  readonly rel: string;
  readonly memberPath: string;
  constructor(folder: string, rel: string) {
    const full = joinMember(folder, rel);
    super(full);
    this.rel = rel;
    this.memberPath = full;
  }
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, resolve(dir, path));
  return !isAbsolute(path) && rel !== '' && rel !== 'project.json' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Whether a project-relative path names the folder itself or anything under it. */
function underFolder(dir: string, folder: string, path: string): boolean {
  const rel = relative(resolve(dir, folder), resolve(dir, path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readHash(dir: string, path: string): string {
  return hash(readFileSync(resolve(dir, path)));
}

export function hashRunFolder(dir: string, folder: string): { members: FileBinding[]; sha256: string } {
  const root = resolve(dir, folder);
  if (!lstatSync(root).isDirectory()) throw new Error(`${folder} is not a directory`);
  const members: FileBinding[] = [];
  const walk = (prefix: string): void => {
    const current = prefix ? resolve(root, prefix) : root;
    let names: string[];
    try { names = readdirSync(current).sort(); }
    catch (error) {
      if (prefix) throw new RunMemberUnreadable(folder, prefix);
      throw error;
    }
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const target = resolve(root, rel);
      let info;
      try { info = lstatSync(target); }
      catch { throw new RunMemberUnreadable(folder, rel); }
      if (info.isDirectory()) walk(rel);
      else if (info.isFile()) {
        try { members.push({ path: rel, sha256: hash(readFileSync(target)) }); }
        catch { throw new RunMemberUnreadable(folder, rel); }
      } else {
        throw new RunMemberUnreadable(folder, rel);
      }
    }
  };
  walk('');
  members.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  return { members, sha256: sourceSha256(members) };
}

type CheckedFile = { record: JsonObject; at: string; optional: boolean };

function verifySourceFiles(ctx: Pick<Ctx, 'dir' | 'refusals' | 'warnings'>, files: CheckedFile[], entry: JsonObject): void {
  for (const { record, at, optional } of files) {
    const name = record.path as string;
    let actual: string;
    try { actual = readHash(ctx.dir, name); } catch (error) {
      if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        ctx.warnings.push({ code: 'DERIVED_RESULT_MISSING', path: `${at}.path`, message: `${at}: '${name}' is absent; regenerate with the recorded operation: ${entry.operation as string}` });
        continue;
      }
      ctx.refusals.push({ code: 'DERIVED_FILE_UNREADABLE', path: `${at}.path`, message: `${at}: cannot read '${name}'; restore the recorded file` });
      continue;
    }
    if (actual !== (record.sha256 as string).toLowerCase()) ctx.refusals.push({ code: 'DERIVED_FILE_CHANGED', path: `${at}.sha256`, message: `${at}: '${name}' no longer matches its recorded sha256` });
  }
}

function checkRunEntry(ctx: Pick<Ctx, 'dir' | 'refusals' | 'warnings'>, entry: JsonObject, path: string, sourceFiles: CheckedFile[]): void {
  const rawMembers = entry.members;
  if (
    sourceFiles.length === 0
    || (entry.operation !== undefined && !nonempty(entry.operation))
    || !nonempty(entry.path)
    || !inside(ctx.dir, entry.path)
    || !hex(entry.sha256)
    || sourceFiles.some(({ record }) => !nonempty(record.path) || !inside(ctx.dir, record.path) || !hex(record.sha256))
    || sourceFiles.some(({ record }) => typeof record.path === 'string' && underFolder(ctx.dir, entry.path as string, record.path))
    || !Array.isArray(rawMembers)
    || !rawMembers.every((m): m is JsonObject => isObject(m) && memberPath(m.path) && hex(m.sha256))
  ) {
    ctx.refusals.push({ code: 'DERIVED_MALFORMED', path, message: `${path}: run needs source or sources { path, sha256 }, sorted members [{ path, sha256 }], and run folder path and sha256; paths are distinct project-relative paths other than project.json` });
    return;
  }
  const members = rawMembers.map((m) => ({ path: m.path as string, sha256: (m.sha256 as string).toLowerCase() }));
  if (!members.every((m, idx) => idx === 0 || Buffer.compare(Buffer.from(members[idx - 1]!.path, 'utf8'), Buffer.from(m.path, 'utf8')) < 0)) {
    ctx.refusals.push({ code: 'DERIVED_MALFORMED', path, message: `${path}: run members must be sorted by unique path` });
    return;
  }
  if (!members.some((m) => m.path === 'layers.json')) {
    ctx.refusals.push({ code: 'DERIVED_RUN_MISSING_LAYERS', path, message: `${path}: run folder '${entry.path}' must contain 'layers.json'` });
    return;
  }
  verifySourceFiles(ctx, sourceFiles, entry);
  const folder = entry.path;
  let actualRun: { members: FileBinding[]; sha256: string };
  try {
    actualRun = hashRunFolder(ctx.dir, folder);
  } catch (error) {
    if (error instanceof RunMemberUnreadable) {
      const idx = members.findIndex((m) => m.path === error.rel);
      const at = idx >= 0 ? `${path}.members[${idx}]` : path;
      ctx.refusals.push({ code: 'DERIVED_FILE_UNREADABLE', path: `${at}.path`, message: `${at}: cannot read '${error.memberPath}'; restore the recorded file` });
      return;
    }
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      if (sourceSha256(members) !== entry.sha256.toLowerCase()) {
        ctx.refusals.push({ code: 'DERIVED_MALFORMED', path, message: `${path}: run sha256 does not match the digest of its recorded members` });
        return;
      }
      const regen = nonempty(entry.operation) ? `regenerate with the recorded operation: ${entry.operation}` : 'regenerate the recorded run';
      ctx.warnings.push({ code: 'DERIVED_RESULT_MISSING', path: `${path}.path`, message: `${path}: '${folder}' is absent; ${regen}` });
      return;
    }
    ctx.refusals.push({ code: 'DERIVED_FILE_UNREADABLE', path: `${path}.path`, message: `${path}: cannot read '${folder}'; restore the recorded run folder` });
    return;
  }
  const actualByPath = new Map(actualRun.members.map((m) => [m.path, m.sha256]));
  const recordedPaths = new Set(members.map((m) => m.path));
  let memberMismatch = false;
  members.forEach((m, idx) => {
    const at = `${path}.members[${idx}]`;
    const name = joinMember(folder, m.path);
    const actualSha = actualByPath.get(m.path);
    if (actualSha === undefined) {
      memberMismatch = true;
      ctx.refusals.push({ code: 'DERIVED_FILE_UNREADABLE', path: `${at}.path`, message: `${at}: cannot read '${name}'; restore the recorded file` });
    } else if (actualSha !== m.sha256) {
      memberMismatch = true;
      ctx.refusals.push({ code: 'DERIVED_FILE_CHANGED', path: `${at}.sha256`, message: `${at}: '${name}' no longer matches its recorded sha256` });
    }
  });
  for (const actualMember of actualRun.members) {
    if (!recordedPaths.has(actualMember.path)) {
      memberMismatch = true;
      const name = joinMember(folder, actualMember.path);
      ctx.refusals.push({ code: 'DERIVED_FILE_CHANGED', path: `${path}.sha256`, message: `${path}: '${name}' no longer matches its recorded sha256` });
    }
  }
  if (!memberMismatch && actualRun.sha256 !== entry.sha256.toLowerCase()) {
    ctx.refusals.push({ code: 'DERIVED_FILE_CHANGED', path: `${path}.sha256`, message: `${path}: '${folder}' no longer matches its recorded sha256` });
  }
}

function checkPreparedInput(ctx: Pick<Ctx, 'dir' | 'refusals' | 'warnings'>, entry: JsonObject, path: string): void {
  if (entry.at !== undefined && !Number.isFinite(derivedTime(entry.at))) {
    ctx.refusals.push({ code: 'DERIVED_AT_INVALID', path: `${path}.at`, message: `${path}.at: expected an ISO date-time with a zone; restore the timestamp recorded by derived add` });
  }
  checkDerivedReceipt(ctx, entry, path);
  if (entry.kind !== 'prepared-input' && entry.kind !== 'run') return;
  const maskSpec = entry.kind === 'prepared-input' ? maskReceiptSpec(entry.receipt) : undefined;
  if (maskSpec) {
    if (entry.operation !== undefined && !nonempty(entry.operation)) {
      ctx.refusals.push({ code: 'DERIVED_MALFORMED', path, message: `${path}: omit operation for a ${maskSpec} receipt or record non-empty operation text` });
    }
    return;
  }
  const sources = entry.sources === undefined ? [entry.source] : asArray(entry.sources);
  const sourceFiles = sources.map((source, index) => ({
    record: isObject(source) ? source : {},
    at: entry.sources === undefined ? `${path}.source` : `${path}.sources[${index}]`,
    optional: false,
  }));
  if (entry.kind === 'run') {
    checkRunEntry(ctx, entry, path, sourceFiles);
    return;
  }
  const files = [
    ...sourceFiles,
    { record: entry, at: path, optional: true },
  ];
  if (sources.length === 0 || !nonempty(entry.operation) || files.some(({ record }) => !nonempty(record.path) || !inside(ctx.dir, record.path) || !hex(record.sha256)) || sources.some((source) => isObject(source) && typeof source.path === 'string' && typeof entry.path === 'string' && resolve(ctx.dir, source.path) === resolve(ctx.dir, entry.path))) {
    ctx.refusals.push({ code: 'DERIVED_MALFORMED', path, message: `${path}: prepared-input needs operation, source or sources { path, sha256 }, and derived path and sha256; paths are distinct project-relative files other than project.json` });
    return;
  }
  verifySourceFiles(ctx, files, entry);
}

/** Only tagged entries carry the prepared file/hash contract. Undated history remains readable. */
export function checkPreparedInputs(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>): void {
  asArray(ctx.project.derived).forEach((entry, i) => {
    if (isObject(entry)) checkPreparedInput(ctx, entry, `derived[${i}]`);
  });
  checkPlateRegistrations(ctx);
}

export const DERIVED_HELP = `derived add [<project dir>] --source <file> [--source <file> …] --file <file> [--operation <text>] [--receipt <path>] [--json]
  --operation is required unless --receipt names a mask receipt (${MASK_RECEIPT_SPECS}).
  Records an operation already run by another tool, with the files' sha256s.
  Paths are relative to the project. No files are transformed; no stage moves.`;

export function derivedCommand(args: string[], now: number): { stdout: string; exit: number } {
  if (args[0] !== 'add') refuse('DERIVED_USAGE', DERIVED_HELP, USAGE_EXIT);
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  const sources: string[] = [];
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (['--source', '--file', '--operation', '--receipt'].includes(arg)) {
      const value = args[++i];
      if ((arg !== '--source' && opts[arg] !== undefined) || value === undefined || value.startsWith('--') || value.trim() === '') refuse('DERIVED_USAGE', `${arg} needs one non-empty value`, USAGE_EXIT);
      opts[arg] = value;
      if (arg === '--source') sources.push(value);
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `derived add does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const operation = opts['--operation'];
  const receiptPath = opts['--receipt'];
  const dir = resolve(positional[0] ?? process.cwd());
  const output = opts['--file'];
  let isRun = false;
  if (output !== undefined && inside(dir, output)) {
    try { isRun = lstatSync(resolve(dir, output)).isDirectory(); } catch {}
  }
  if (positional.length > 1 || sources.length === 0 || output === undefined || (!isRun && operation === undefined && receiptPath === undefined)) refuse('DERIVED_USAGE', DERIVED_HELP, USAGE_EXIT);
  const file = resolve(dir, 'project.json');
  const read = readJsonObject(file);
  if (!read.ok) refuse('PROJECT_JSON_INVALID', `${file}: ${read.error}`);
  const project = read.value;
  if (project.schema !== 'rig-create/project@0') refuse('SCHEMA_UNKNOWN', 'derived add reads rig-create/project@0');
  if (project.derived !== undefined && !Array.isArray(project.derived)) refuse('DERIVED_MALFORMED', 'derived must be an array');
  if (![...sources, output].every((p) => inside(dir, p)) || sources.some((p) => (isRun ? underFolder(dir, output, p) : resolve(dir, p) === resolve(dir, output)))) refuse('DERIVED_PATH_INVALID', 'source and derived file must be distinct project-relative files other than project.json');
  let receipt: ReturnType<typeof readDerivedReceipt>['binding'] | undefined;
  if (receiptPath !== undefined) {
    try { receipt = readDerivedReceipt(dir, receiptPath).binding; }
    catch (error) { refuse('PLATE_RECEIPT_INVALID', `derived.receipt: ${(error as Error).message}; supply an intact project-relative producer receipt; no record written`); }
  }
  if (!isRun && operation === undefined && !maskReceiptSpec(receipt)) refuse('DERIVED_USAGE', DERIVED_HELP, USAGE_EXIT);
  const inputs = sources.map((p) => {
    try { return { path: p, sha256: readHash(dir, p) }; } catch { refuse('DERIVED_FILE_UNREADABLE', `cannot read '${p}'; no record written`); }
  });
  let entry: JsonObject;
  if (isRun) {
    let run: { members: FileBinding[]; sha256: string };
    try { run = hashRunFolder(dir, output); }
    catch (error) {
      const failed = error instanceof RunMemberUnreadable ? error.memberPath : output;
      refuse('DERIVED_FILE_UNREADABLE', `cannot read '${failed}'; no record written`);
    }
    entry = {
      kind: 'run',
      ...(inputs.length === 1 ? { source: inputs[0] as JsonObject } : { sources: inputs }),
      path: output,
      members: run.members,
      sha256: run.sha256,
      ...(operation === undefined ? {} : { operation }),
      ...(receipt === undefined ? {} : { receipt }),
    };
  } else {
    let outputHash: string;
    try { outputHash = readHash(dir, output); } catch { refuse('DERIVED_FILE_UNREADABLE', `cannot read '${output}'; no record written`); }
    entry = {
      kind: 'prepared-input',
      ...(inputs.length === 1 ? { source: inputs[0] as JsonObject } : { sources: inputs }),
      path: output,
      sha256: outputHash,
      ...(operation === undefined ? {} : { operation }),
      ...(receipt === undefined ? {} : { receipt }),
    };
  }
  const instant = new Date(now);
  entry.at = Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
  const entries = asArray(project.derived);
  const ctx: Pick<Ctx, 'dir' | 'refusals' | 'warnings'> = { dir, refusals: [], warnings: [] };
  checkPreparedInput(ctx, entry, `derived[${entries.length}]`);
  const finding = ctx.refusals[0];
  if (finding) refuse(finding.code, finding.message);
  project.derived = [...entries, entry];
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `derived: recorded '${sources.join("', '")}' → '${output}' (${operation ?? receipt?.spec ?? 'run'}); stage unchanged`, exit: 0 };
}
