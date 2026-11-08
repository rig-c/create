/**
 * `restart`: start a project's record again at v1 through a writer (create#285). The fresh record is
 * the one init writes. It keeps the inputs, re-validated by the input writer's checks, and the fix
 * ledger, because owner feedback belongs to the project, not to a version. create does not keep the
 * earlier project.json; git history holds it, and restarts[] names its sha256.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { asArray, checkProject, isObject, PROJECT_SCHEMA, type Finding } from './check.ts';
import { ledgerRows, writeRecord } from './fix-ledger.ts';
import { freshProjectRecord } from './init.ts';
import { checkInputs } from './inputs.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import type { Json, JsonObject } from './templates.ts';

export const RESTART_HELP = `restart:
  [<dir>] --by <human> --reason-file <file> [--json]
  Replace project.json with the record init writes: the template's stage, no versions, drafts,
  signoffs, plan, answers or review acts. Keeps name, title, same_artwork, inputs[] (each file must
  still match its sha256) and fix_ledger with every row, and appends restarts[] { at, by, reason,
  previous_record_sha256 }. git history holds the earlier record. A kept part set (inputs under
  <set>/parts/*.png or <set>/parts.json) keeps <set>/parts.json and its rig: rig.json and
  mesh_report.json, at <set>/rig/ or <set>/.`;

/** Kept part sets missing their manifest, their rig or their PNGs, by set root. */
export function partSetGaps(inputs: Json | undefined): string[] {
  const paths = new Set(asArray(inputs).filter(isObject).map(input => input.path).filter((path): path is string => typeof path === 'string'));
  const roots = new Set<string>();
  for (const path of paths) {
    const set = /^(?:(.*)\/)?parts\/[^/]+\.png$/i.exec(path) ?? /^(?:(.*)\/)?parts\.json$/.exec(path);
    if (set) roots.add(set[1] ?? '');
  }
  const gaps: string[] = [];
  for (const root of [...roots].sort()) {
    const at = (name: string): string => (root === '' ? name : `${root}/${name}`);
    const missing: string[] = [];
    if (!paths.has(at('parts.json'))) missing.push(at('parts.json'));
    if (![...paths].some(path => path.startsWith(at('parts/')) && /\.png$/i.test(path))) missing.push(at('parts/*.png'));
    const rig = ['rig/', ''].find(prefix => paths.has(at(`${prefix}rig.json`)) && paths.has(at(`${prefix}mesh_report.json`)));
    if (rig === undefined) missing.push(`${at('rig/rig.json')} and ${at('rig/mesh_report.json')} (or ${at('rig.json')} and ${at('mesh_report.json')})`);
    if (missing.length) gaps.push(`${root === '' ? '(project root)' : root}: ${missing.join(', ')}`);
  }
  return gaps;
}

export function restartCommand(args: string[], now: number): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--by' || arg === '--reason-file') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '' || opts[arg] !== undefined) refuse('RESTART_USAGE', `restart: ${arg} needs one value; see restart help`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('RESTART_USAGE', `restart: unsupported ${arg}; see restart help`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length > 1 || opts['--by'] === undefined || opts['--reason-file'] === undefined) refuse('RESTART_USAGE', RESTART_HELP, USAGE_EXIT);
  if (opts['--by'].toLowerCase() === 'agent') refuse('SIGNOFF_NOT_HUMAN', 'restarts[].by: restart by agent; a person orders a restart');
  const reason = readVerbatim(opts['--reason-file']).trim();
  if (!reason) refuse('RESTART_USAGE', 'restarts[].reason: the reason file is empty; say why the record restarts', USAGE_EXIT);
  const dir = resolve(positional[0] ?? process.cwd());
  const file = join(dir, 'project.json');
  const notProject = (why: string): never => refuse('RESTART_NOT_A_PROJECT', `${file}: ${why}; restart runs on a create project folder`);
  if (!existsSync(file)) notProject('does not exist');
  const release = acquireBoundJobWrite(dir);
  try {
    const original = readFileSync(file);
    let project: JsonObject;
    try {
      const parsed: unknown = JSON.parse(original.toString('utf8'));
      if (!isObject(parsed as Json) || (parsed as JsonObject).schema !== PROJECT_SCHEMA) throw new Error('schema');
      project = parsed as JsonObject;
    } catch { return notProject(`is not a ${PROJECT_SCHEMA} record`); }
    const inputs = { dir, project: { inputs: project.inputs ?? [] }, refusals: [] as Finding[], warnings: [] as Finding[] };
    checkInputs(inputs);
    const input = inputs.refusals[0] ?? inputs.warnings[0];
    if (input !== undefined) refuse('RESTART_INPUT_INVALID', `${input.path}: ${input.code}: ${input.message}; a restart keeps only inputs the input writer would record, so restore the file or register it again with input add`);
    const gaps = partSetGaps(project.inputs);
    if (gaps.length) refuse('RESTART_PART_SET_INCOMPLETE', `inputs: a kept part set needs its parts.json and its rig with its PNGs, missing ${gaps.join('; ')}; register the missing files with input add, or stop keeping the set`);
    const candidate = freshProjectRecord(typeof project.name === 'string' ? project.name : '', now);
    if (project.name !== undefined) candidate.name = project.name;
    if (project.title !== undefined) candidate.title = project.title;
    if (project.same_artwork !== undefined) candidate.same_artwork = project.same_artwork;
    candidate.inputs = project.inputs ?? [];
    candidate.fix_ledger = project.fix_ledger ?? [];
    const entry: JsonObject = { at: new Date(now).toISOString(), by: opts['--by'], reason, previous_record_sha256: createHash('sha256').update(original).digest('hex') };
    candidate.restarts = [...asArray(project.restarts), entry];
    const ledger: Finding[] = [];
    ledgerRows(candidate, ledger, now);
    if (ledger[0] !== undefined) refuse(ledger[0].code, `${ledger[0].message}; a restart keeps every ledger row as written`);
    // The restarted record carries exactly what a fresh init record carries (its open interview) and nothing from the retired one.
    const fresh = checkProject(dir, freshProjectRecord(String(candidate.name ?? ''), now), { now });
    const rejected = newFindings(baselineOf(fresh), checkProject(dir, structuredClone(candidate), { now }).refusals)[0];
    if (rejected !== undefined) refuse(rejected.code, rejected.message);
    writeRecord(file, original, candidate, 'restart');
    const rows = asArray(candidate.fix_ledger).length;
    return {
      stdout: json ? JSON.stringify(entry, null, 2)
        : `restart: project record restarted at stage ${String(candidate.stage)}; kept ${asArray(candidate.inputs).length} input(s) and ${rows} ledger row(s); the earlier record (sha256 ${String(entry.previous_record_sha256)}) is in git history`,
      exit: 0,
    };
  } finally { release(); }
}
