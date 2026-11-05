import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { asArray, isObject, readJsonObject, type Ctx } from './check.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

const nonempty = (v: Json | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, resolve(dir, path));
  return !isAbsolute(path) && rel !== '' && rel !== 'project.json' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function readHash(dir: string, path: string): string {
  return hash(readFileSync(resolve(dir, path)));
}

/** Only the tagged prepared-input records carry this file/hash contract; legacy intermediates are unchanged. */
export function checkPreparedInputs(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>): void {
  asArray(ctx.project.derived).forEach((entry, i) => {
    if (!isObject(entry) || entry.kind !== 'prepared-input') return;
    const path = `derived[${i}]`;
    const sources = entry.sources === undefined ? [entry.source] : asArray(entry.sources);
    const files = [
      ...sources.map((source, index) => ({
        record: isObject(source) ? source : {},
        at: entry.sources === undefined ? `${path}.source` : `${path}.sources[${index}]`,
        optional: false,
      })),
      { record: entry, at: path, optional: true },
    ];
    if (sources.length === 0 || !nonempty(entry.operation) || files.some(({ record }) => !nonempty(record.path) || !inside(ctx.dir, record.path) || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(record.sha256)) || sources.some((source) => isObject(source) && typeof source.path === 'string' && typeof entry.path === 'string' && resolve(ctx.dir, source.path) === resolve(ctx.dir, entry.path))) {
      ctx.refusals.push({ code: 'DERIVED_MALFORMED', path, message: `${path}: prepared-input needs operation, source or sources { path, sha256 }, and derived path and sha256; paths are distinct project-relative files other than project.json` });
      return;
    }
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
  });
}

export const DERIVED_HELP = `derived add [<project dir>] --source <file> [--source <file> …] --file <file> --operation <text> [--json]
  Records an operation already run by another tool, with the files' sha256s.
  Paths are relative to the project. No files are transformed; no stage moves.`;

export function derivedCommand(args: string[]): { stdout: string; exit: number } {
  if (args[0] !== 'add') refuse('DERIVED_USAGE', DERIVED_HELP, USAGE_EXIT);
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  const sources: string[] = [];
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (['--source', '--file', '--operation'].includes(arg)) {
      const value = args[++i];
      if ((arg !== '--source' && opts[arg] !== undefined) || value === undefined || value.startsWith('--') || value.trim() === '') refuse('DERIVED_USAGE', `${arg} needs one non-empty value`, USAGE_EXIT);
      opts[arg] = value;
      if (arg === '--source') sources.push(value);
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `derived add does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length > 1 || ['--source', '--file', '--operation'].some((k) => opts[k] === undefined)) refuse('DERIVED_USAGE', DERIVED_HELP, USAGE_EXIT);
  const dir = resolve(positional[0] ?? process.cwd());
  const file = resolve(dir, 'project.json');
  const read = readJsonObject(file);
  if (!read.ok) refuse('PROJECT_JSON_INVALID', `${file}: ${read.error}`);
  const project = read.value;
  if (project.schema !== 'rig-create/project@0') refuse('SCHEMA_UNKNOWN', 'derived add reads rig-create/project@0');
  if (project.derived !== undefined && !Array.isArray(project.derived)) refuse('DERIVED_MALFORMED', 'derived must be an array');
  const output = opts['--file'] as string;
  if (![...sources, output].every((p) => inside(dir, p)) || sources.some((p) => resolve(dir, p) === resolve(dir, output))) refuse('DERIVED_PATH_INVALID', 'source and derived file must be distinct project-relative files other than project.json');
  const hashes = [...sources, output].map((p) => {
    try { return readHash(dir, p); } catch { refuse('DERIVED_FILE_UNREADABLE', `cannot read '${p}'; no record written`); }
  });
  const inputs = sources.map((path, i) => ({ path, sha256: hashes[i] as string }));
  const entry: JsonObject = {
    kind: 'prepared-input',
    ...(sources.length === 1 ? { source: inputs[0] as JsonObject } : { sources: inputs }),
    path: output,
    sha256: hashes[sources.length] as string,
    operation: opts['--operation'] as string,
  };
  project.derived = [...asArray(project.derived), entry];
  const ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'> = { dir, project: { ...project, derived: [entry] }, refusals: [], warnings: [] };
  checkPreparedInputs(ctx);
  const finding = ctx.refusals[0];
  if (finding) refuse(finding.code, finding.message);
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `derived: recorded '${sources.join("', '")}' → '${output}' (${entry.operation as string}); stage unchanged`, exit: 0 };
}
