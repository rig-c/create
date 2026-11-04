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
export function checkPreparedInputs(ctx: Ctx): void {
  asArray(ctx.project.derived).forEach((entry, i) => {
    if (!isObject(entry) || entry.kind !== 'prepared-input') return;
    const path = `derived[${i}]`;
    const source = isObject(entry.source) ? entry.source : {};
    const files = [{ record: source, at: `${path}.source` }, { record: entry, at: path }];
    if (!nonempty(entry.operation) || files.some(({ record }) => !nonempty(record.path) || !inside(ctx.dir, record.path) || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(record.sha256)) || (typeof source.path === 'string' && typeof entry.path === 'string' && resolve(ctx.dir, source.path) === resolve(ctx.dir, entry.path))) {
      ctx.refusals.push({ code: 'DERIVED_MALFORMED', path, message: `${path}: prepared-input needs operation, source { path, sha256 }, and derived path and sha256; paths are distinct project-relative files other than project.json` });
      return;
    }
    for (const { record, at } of files) {
      const name = record.path as string;
      let actual: string;
      try { actual = readHash(ctx.dir, name); } catch {
        ctx.refusals.push({ code: 'DERIVED_FILE_UNREADABLE', path: `${at}.path`, message: `${at}: cannot read '${name}'; restore the recorded file` });
        continue;
      }
      if (actual !== (record.sha256 as string).toLowerCase()) ctx.refusals.push({ code: 'DERIVED_FILE_CHANGED', path: `${at}.sha256`, message: `${at}: '${name}' no longer matches its recorded sha256` });
    }
  });
}

export const DERIVED_HELP = `derived add [<project dir>] --source <file> --file <file> --operation <text> [--json]
  Records an operation already run by another tool, with both files' sha256s.
  Paths are relative to the project. No files are transformed; no stage moves.`;

export function derivedCommand(args: string[]): { stdout: string; exit: number } {
  if (args[0] !== 'add') refuse('DERIVED_USAGE', DERIVED_HELP, USAGE_EXIT);
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (['--source', '--file', '--operation'].includes(arg)) {
      const value = args[++i];
      if (opts[arg] !== undefined || value === undefined || value.startsWith('--') || value.trim() === '') refuse('DERIVED_USAGE', `${arg} needs one non-empty value`, USAGE_EXIT);
      opts[arg] = value;
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
  const source = opts['--source'] as string;
  const output = opts['--file'] as string;
  if (![source, output].every((p) => inside(dir, p)) || resolve(dir, source) === resolve(dir, output)) refuse('DERIVED_PATH_INVALID', 'source and derived file must be distinct project-relative files other than project.json');
  const hashes = [source, output].map((p) => {
    try { return readHash(dir, p); } catch { refuse('DERIVED_FILE_UNREADABLE', `cannot read '${p}'; no record written`); }
  });
  const entry: JsonObject = { kind: 'prepared-input', source: { path: source, sha256: hashes[0] as string }, path: output, sha256: hashes[1] as string, operation: opts['--operation'] as string };
  project.derived = [...asArray(project.derived), entry];
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `derived: recorded '${source}' → '${output}' (${entry.operation as string}); stage unchanged`, exit: 0 };
}
