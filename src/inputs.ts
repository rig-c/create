/** Register immutable source bytes without interpreting producer content. */
import { createHash } from 'node:crypto';
import { closeSync, fchmodSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFileSync, realpathSync, statSync } from './check-reads.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { asArray, isObject, readJsonObject, type Ctx } from './check.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export const INPUT_WRITER_SINCE = '2026-11-08T00:00:00Z';
const text = (value: Json | undefined): value is string => typeof value === 'string' && value.trim() !== '';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const escapes = (path: string): boolean => isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`);

function inputPath(dir: string, name: string): string {
  const path = relative(dir, resolve(dir, name));
  if (isAbsolute(name) || escapes(path) || path === '' || path === 'project.json' || path === '.input.lock') {
    refuse('INPUT_PATH_INVALID', `inputs[].path: '${name}' must name a project-relative source file other than project.json; retain the source inside the project`);
  }
  return path.split(sep).join('/');
}

function sourceBytes(dir: string, name: string, path: string): Buffer {
  const file = resolve(dir, name);
  try {
    const target = realpathSync(file);
    const source = statSync(file);
    const record = statSync(resolve(dir, 'project.json'));
    if (escapes(relative(realpathSync(dir), target)) || (source.dev === record.dev && source.ino === record.ino) || target === resolve(realpathSync(dir), '.input.lock')) {
      refuse('INPUT_PATH_INVALID', `${path}: '${name}' resolves outside the project, to project.json or to the writer lock; retain a contained source file`);
    }
    if (!source.isFile()) throw new Error('not a regular file');
    return readFileSync(file);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse('INPUT_FILE_UNREADABLE', `${path}: cannot read source file '${name}'; restore the retained file before registering or checking it`);
  }
}

/** The writer and check use the same shape, containment and raw-byte validator. */
export function checkInputs(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>): void {
  if (ctx.project.inputs !== undefined && !Array.isArray(ctx.project.inputs)) {
    ctx.refusals.push({ code: 'INPUTS_INVALID', path: 'inputs', message: 'inputs: expected an array; restore the input records and register new files with input add' });
    return;
  }
  const paths = new Set<string>();
  asArray(ctx.project.inputs).forEach((raw, index) => {
    const path = `inputs[${index}]`;
    const entry = isObject(raw) ? raw : {};
    const at = typeof entry.at === 'string' ? Date.parse(entry.at) : NaN;
    const complete = text(entry.path) && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)
      && typeof entry.bytes === 'number' && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && text(entry.origin) && Number.isFinite(at);
    if (!complete) {
      const legacy = !Number.isFinite(at) || at < Date.parse(INPUT_WRITER_SINCE);
      (legacy ? ctx.warnings : ctx.refusals).push({ code: 'INPUT_WRITER_MISSING', path,
        message: `${path}: '${String(entry.path ?? '(missing path)')}' lacks writer metadata {path, sha256, bytes, origin, at}${legacy ? '; legacy record retained' : ''}; preserve historical bytes and register a new source name with input add --origin` });
      return;
    }
    try {
      const name = inputPath(ctx.dir, entry.path as string);
      if (paths.has(name)) ctx.refusals.push({ code: 'INPUT_PATH_DUPLICATE', path: `${path}.path`, message: `${path}.path: '${name}' is already registered; keep one record per source name and use a new name for changed bytes` });
      paths.add(name);
      const bytes = sourceBytes(ctx.dir, name, `${path}.path`);
      if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) ctx.refusals.push({ code: 'INPUT_FILE_CHANGED', path, message: `${path}: '${name}' differs from its recorded raw sha256 or bytes; restore the original file and register changed bytes under a new name` });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      ctx.refusals.push({ code: error.code, path: `${path}.path`, message: `${path}.path: ${error.message}` });
    }
  });
}

export const INPUT_HELP = `input add <path> [<project dir>] --origin <words> [--json]
  Register raw source bytes as {path, sha256, bytes, origin, at}.
  Paths are project-relative. Changed inputs require a new file name.`;

export function inputCommand(args: string[], now: number): { stdout: string; exit: number } {
  if (args[0] !== 'add') refuse('INPUT_USAGE', INPUT_HELP, USAGE_EXIT);
  const positional: string[] = [];
  let origin: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--origin' && origin === undefined) {
      origin = args[++index];
      if (!origin || origin.startsWith('--') || !origin.trim()) refuse('INPUT_USAGE', 'inputs[].origin: supply --origin with non-empty source words', USAGE_EXIT);
    } else if (arg.startsWith('-')) refuse('INPUT_USAGE', `inputs: unexpected or repeated option '${arg}'; ${INPUT_HELP}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || origin === undefined) refuse('INPUT_USAGE', INPUT_HELP, USAGE_EXIT);
  const dir = resolve(positional[1] ?? process.cwd());
  const name = inputPath(dir, positional[0]!);
  const file = resolve(dir, 'project.json');
  const lock = resolve(dir, '.input.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch { refuse('INPUT_SOURCE_CHANGED', 'inputs: another input writer holds the project lock; wait for it to finish and retry against frozen source bytes'); }
  let published = false;
  try {
    let before: Buffer;
    try { before = readFileSync(file); } catch { refuse('PROJECT_JSON_INVALID', 'project.json: restore a readable project record before input add'); }
    const read = readJsonObject(file);
    if (!read.ok) refuse('PROJECT_JSON_INVALID', `project.json: ${read.error}`);
    const project = read.value;
    if (project.schema !== 'rig-create/project@0') refuse('SCHEMA_UNKNOWN', 'project.json.schema: input add reads rig-create/project@0');
    const bytes = sourceBytes(dir, name, 'inputs[].path');
    const entry: JsonObject = { path: name, sha256: sha256(bytes), bytes: bytes.length, origin, at: new Date(now).toISOString() };
    const existing = asArray(project.inputs).filter(isObject).find(input => text(input.path) && resolve(dir, input.path) === resolve(dir, name));
    if (existing) {
      if (existing.sha256 !== entry.sha256 || existing.bytes !== entry.bytes) refuse('INPUT_FILE_CHANGED', `inputs[].path: '${name}' has changed under its registered name; restore the old bytes and register a new file name`);
      refuse('INPUT_PATH_DUPLICATE', `inputs[].path: '${name}' is already registered; keep its record and use a new name for changed bytes`);
    }
    const ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'> = { dir, project, refusals: [], warnings: [] };
    if (project.inputs !== undefined && !Array.isArray(project.inputs)) {
      checkInputs(ctx);
      refuse(ctx.refusals[0]!.code, ctx.refusals[0]!.message);
    }
    project.inputs = [...asArray(project.inputs), entry];
    checkInputs(ctx);
    const finding = ctx.refusals[0];
    if (finding) refuse(finding.code, finding.message);
    try {
      fchmodSync(fd, statSync(file).mode);
      writeFileSync(fd, `${JSON.stringify(project, null, 2)}\n`);
      if (!readFileSync(file).equals(before) || !sourceBytes(dir, name, 'inputs[].path').equals(bytes)) refuse('INPUT_SOURCE_CHANGED', `inputs[].path: '${name}' or project.json changed during registration; freeze both files and retry`);
      renameSync(lock, file);
      published = true;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      refuse('INPUT_WRITE_FAILED', 'inputs: could not publish the staged project.json record; restore writable project storage and retry');
    }
    return { stdout: json ? JSON.stringify(entry, null, 2) : `input: recorded '${name}' (${bytes.length} bytes)`, exit: 0 };
  } finally { closeSync(fd); if (!published) unlinkSync(lock); }
}
