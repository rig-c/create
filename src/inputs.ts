/** Register immutable source bytes without interpreting producer content. */
import { createHash } from 'node:crypto';
import { closeSync, fchmodSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFileSync, realpathSync, statSync } from './check-reads.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { asArray, isObject, readJsonObject, type Ctx } from './check.ts';
import { sameArtworkFor } from './init.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
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
  const painting = ctx.project.painting;
  if (painting !== undefined && (!text(painting) || !asArray(ctx.project.inputs).some(input => isObject(input) && input.path === painting))) {
    ctx.refusals.push({ code: 'INPUT_PAINTING_INVALID', path: 'painting', message: 'painting: expected the path of one registered input; restore the declaration written by init --painting or input add --painting' });
  }
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

export const INPUT_HELP = `input add <path> [<project dir>] --origin <words> [--painting [--projects-root <dir>] [--same-artwork-reason <file>]] [--json]
  Register raw source bytes as {path, sha256, bytes, origin, at}.
  --painting declares the project's one painting and checks sibling inputs for the same artwork.
  Paths are project-relative. Changed inputs require a new file name.
input painting <path> [<project dir>] [--projects-root <dir>] [--same-artwork-reason <file>] [--json]
  Declare an already-registered input as the project's one painting, with the same artwork check.`;

type InputProject = Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>;

/** Register a new source; with --painting it is also declared the painting. */
function addInput(dir: string, project: JsonObject, name: string, origin: string, painting: boolean, artwork: ArtworkOptions, now: number): { entry: JsonObject; bytes: Buffer } {
  if (painting && project.painting !== undefined) refuse('INPUT_PAINTING_EXISTS', `painting: '${String(project.painting)}' is already declared; retain the project's painting and register other sources without --painting`);
  const bytes = sourceBytes(dir, name, 'inputs[].path');
  const entry: JsonObject = { path: name, sha256: sha256(bytes), bytes: bytes.length, origin, at: new Date(now).toISOString() };
  const existing = asArray(project.inputs).filter(isObject).find(input => text(input.path) && resolve(dir, input.path) === resolve(dir, name));
  if (existing) {
    if (existing.sha256 !== entry.sha256 || existing.bytes !== entry.bytes) refuse('INPUT_FILE_CHANGED', `inputs[].path: '${name}' has changed under its registered name; restore the old bytes and register a new file name`);
    refuse('INPUT_PATH_DUPLICATE', painting
      ? `inputs[].path: '${name}' is already registered; declare it as the painting with input painting ${name}`
      : `inputs[].path: '${name}' is already registered; keep its record and use a new name for changed bytes`);
  }
  inputsArray({ dir, project, refusals: [], warnings: [] });
  if (painting) {
    const same = sameArtworkFor(dir, name, String(entry.sha256), now, { ...artwork, index: asArray(project.inputs).length });
    project.painting = name;
    if (same !== null && project.same_artwork === undefined) project.same_artwork = same;
  }
  project.inputs = [...asArray(project.inputs), entry];
  return { entry, bytes };
}

/** Declare a registered input as the painting; its record and bytes stay as registered. */
function declarePainting(dir: string, project: JsonObject, name: string, artwork: ArtworkOptions, now: number): { entry: JsonObject; bytes: Buffer } {
  if (project.painting !== undefined) refuse('INPUT_PAINTING_EXISTS', `painting: '${String(project.painting)}' is already declared; retain the project's painting and register other sources without --painting`);
  inputsArray({ dir, project, refusals: [], warnings: [] });
  const inputs = asArray(project.inputs);
  const index = inputs.findIndex(input => isObject(input) && text(input.path) && resolve(dir, input.path) === resolve(dir, name));
  if (index < 0) refuse('INPUT_PAINTING_UNREGISTERED', `painting: '${name}' is not a registered input; register and declare it with input add ${name} --origin <words> --painting`);
  const entry = inputs[index] as JsonObject;
  const recorded = entry.path as string;
  if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.bytes !== 'number') {
    refuse('INPUT_WRITER_MISSING', `inputs[${index}]: '${recorded}' lacks writer metadata {path, sha256, bytes}; preserve historical bytes and register the painting under a new source name with input add --origin --painting`);
  }
  const bytes = sourceBytes(dir, name, `inputs[${index}].path`);
  if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) refuse('INPUT_FILE_CHANGED', `inputs[${index}]: '${recorded}' differs from its recorded raw sha256 or bytes; restore the original file before declaring it the painting`);
  const same = sameArtworkFor(dir, recorded, entry.sha256, now, { ...artwork, index });
  project.painting = recorded;
  if (same !== null && project.same_artwork === undefined) project.same_artwork = same;
  return { entry, bytes };
}

/** A non-array inputs field refuses with the check's own finding. */
function inputsArray(ctx: InputProject): void {
  if (ctx.project.inputs === undefined || Array.isArray(ctx.project.inputs)) return;
  checkInputs(ctx);
  refuse(ctx.refusals[0]!.code, ctx.refusals[0]!.message);
}

interface ArtworkOptions { projectsRoot?: string; sameArtworkReason?: string }

export function inputCommand(args: string[], now: number): { stdout: string; exit: number } {
  const mode = args[0];
  if (mode !== 'add' && mode !== 'painting') refuse('INPUT_USAGE', INPUT_HELP, USAGE_EXIT);
  const positional: string[] = [];
  let origin: string | undefined;
  let projectsRoot: string | undefined;
  let sameArtworkReason: string | undefined;
  let painting = mode === 'painting';
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--painting' && mode === 'add' && !painting) painting = true;
    else if (arg === '--origin' && mode === 'add' && origin === undefined) {
      origin = args[++index];
      if (!origin || origin.startsWith('--') || !origin.trim()) refuse('INPUT_USAGE', 'inputs[].origin: supply --origin with non-empty source words', USAGE_EXIT);
    } else if (arg === '--projects-root' && projectsRoot === undefined) {
      projectsRoot = args[++index];
      if (!projectsRoot || projectsRoot.startsWith('--') || !projectsRoot.trim()) refuse('INPUT_USAGE', 'inputs: supply --projects-root with a directory path', USAGE_EXIT);
    } else if (arg === '--same-artwork-reason' && sameArtworkReason === undefined) {
      sameArtworkReason = args[++index];
      if (!sameArtworkReason || sameArtworkReason.startsWith('--') || !sameArtworkReason.trim()) refuse('INPUT_USAGE', 'inputs: supply --same-artwork-reason with a file path', USAGE_EXIT);
    } else if (arg.startsWith('-')) refuse('INPUT_USAGE', `inputs: unexpected or repeated option '${arg}'; ${INPUT_HELP}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || (mode === 'add' && origin === undefined)) refuse('INPUT_USAGE', INPUT_HELP, USAGE_EXIT);
  if (!painting && (projectsRoot !== undefined || sameArtworkReason !== undefined)) refuse('INPUT_USAGE', 'painting: --projects-root and --same-artwork-reason require input add --painting', USAGE_EXIT);
  const dir = resolve(positional[1] ?? process.cwd());
  const name = inputPath(dir, positional[0]!);
  const file = resolve(dir, 'project.json');
  const lock = resolve(dir, '.input.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch { refuse('INPUT_SOURCE_CHANGED', 'inputs: another input writer holds the project lock; wait for it to finish and retry against frozen source bytes'); }
  let published = false;
  let releaseJob = () => {};
  try {
    if (mode === 'add') releaseJob = acquireBoundJobWrite(dir, { kind: 'record-only' });
    let before: Buffer;
    try { before = readFileSync(file); } catch { refuse('PROJECT_JSON_INVALID', `project.json: restore a readable project record before input ${mode}`); }
    const read = readJsonObject(file);
    if (!read.ok) refuse('PROJECT_JSON_INVALID', `project.json: ${read.error}`);
    const project = read.value;
    if (project.schema !== 'rig-create/project@0') refuse('SCHEMA_UNKNOWN', `project.json.schema: input ${mode} reads rig-create/project@0`);
    const artwork = { projectsRoot, sameArtworkReason };
    const { entry, bytes } = mode === 'add'
      ? addInput(dir, project, name, origin!, painting, artwork, now)
      : declarePainting(dir, project, name, artwork, now);
    const ctx: InputProject = { dir, project, refusals: [], warnings: [] };
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
    const path = String(entry.path);
    const stdout = json ? JSON.stringify(entry, null, 2)
      : mode === 'add' ? `input: recorded '${path}' (${bytes.length} bytes)` : `input: declared '${path}' as the painting`;
    return { stdout, exit: 0 };
  } finally {
    try { closeSync(fd); if (!published) unlinkSync(lock); }
    finally { releaseJob(); }
  }
}
