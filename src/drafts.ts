/** Draft identity is create-owned inventory, never producer provenance or a measurement. */
import { ConfigInputsUnavailable, configInputBindings, configInputReferences, configInputsLegacy } from './config-inputs.ts';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { asArray, checkProject, isObject, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { locateParts } from './parts-sections.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (v: Json | undefined): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const pathOf = (dir: string, path: string): string => relative(realpathSync(dir), realpathSync(path)).split(sep).join('/');

function fileAt(dir: string, path: string, root: string): string {
  if (isAbsolute(path) || path.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error(`${path}: expected a project-relative literal path`);
  if (!inside(realpathSync(dir), realpathSync(resolve(dir, root)))) throw new Error(`${root}: draft root escapes the project`);
  const file = resolve(dir, path);
  if (!inside(resolve(dir, root), file) || !inside(realpathSync(resolve(dir, root)), realpathSync(file))) throw new Error(`${path}: outside ${root}`);
  if (!lstatSync(file).isFile()) throw new Error(`${path}: expected a regular file`);
  return file;
}

function inventory(dir: string, path: string, root: string): JsonObject[] {
  const absolute = resolve(dir, path);
  if (!inside(resolve(dir, root), absolute) && absolute !== resolve(dir, root)) throw new Error(`${path}: outside ${root}`);
  if (!inside(realpathSync(resolve(dir, root)), realpathSync(absolute)) && realpathSync(absolute) !== realpathSync(resolve(dir, root))) throw new Error(`${path}: escapes ${root}`);
  if (!lstatSync(absolute).isDirectory()) throw new Error(`${path}: expected a directory without symlinks`);
  const files: JsonObject[] = [];
  for (const name of readdirSync(absolute).sort()) {
    const entry = join(path, name).split(sep).join('/');
    const info = lstatSync(resolve(dir, entry));
    if (info.isDirectory()) files.push(...inventory(dir, entry, root));
    else files.push({ path: entry, sha256: sha(readFileSync(fileAt(dir, entry, root))) });
  }
  return files;
}

function partsInventory(dir: string, path: string, root: string): JsonObject[] {
  return inventory(dir, path, root).filter(f => f.path === `${path}/parts.json` || String(f.path).startsWith(`${path}/parts/`));
}

function binding(v: Json | undefined): v is JsonObject {
  return isObject(v) && typeof v.path === 'string' && hex(v.sha256);
}

/** Absence may be regenerable; symlinks, escaped paths and present wrong kinds are never absence. */
export function draftFileUnavailable(dir: string, path: string, root: string): boolean {
  if (isAbsolute(path) || path.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error(`${path}: expected a literal project-relative draft path`);
  const target = resolve(dir, path);
  if (target !== resolve(dir, root) && !inside(resolve(dir, root), target)) throw new Error(`${path}: outside ${root}`);
  const names = path.split('/');
  let current = realpathSync(dir);
  for (const [i, name] of names.entries()) {
    current = join(current, name);
    let info;
    try { info = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    if (info.isSymbolicLink() || (i < names.length - 1 && !info.isDirectory())) throw new Error(`${path}: draft path traverses a symlink or non-directory`);
  }
  return false;
}

export function checkDrafts(dir: string, project: JsonObject, refusals: Finding[], warnings: Finding[] = []): void {
  const add = (code: string, path: string, why: string): void => { refusals.push({ code, path, message: `${path}: ${why}; retain a labelled draft with its original config, parts and files` }); };
  if (project.drafts !== undefined && !Array.isArray(project.drafts)) { add('DRAFT_RIG_MALFORMED', 'drafts', 'expected a list'); return; }
  const ids = new Set<string>();
  for (const [index, raw] of asArray(project.drafts).entries()) {
    const path = `drafts[${index}]`;
    if (!isObject(raw) || typeof raw.id !== 'string' || !idPattern.test(raw.id) || ids.has(raw.id) || raw.kind !== 'draft-rig'
      || typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at)) || !isObject(raw.producer)
      || typeof raw.producer.name !== 'string' || !raw.producer.name || typeof raw.producer.version !== 'string' || !raw.producer.version
      || !binding(raw.config) || !isObject(raw.parts) || typeof raw.parts.path !== 'string'
      || !Array.isArray(raw.parts.files) || !Array.isArray(raw.files)) { add('DRAFT_RIG_MALFORMED', path, 'invalid or duplicate draft identity'); continue; }
    ids.add(raw.id);
    const root = `derived/drafts/${raw.id}`;
    const parts = raw.parts;
    const all = [raw.config, ...asArray(parts.files), ...asArray(raw.files), ...asArray(raw.config_inputs)];
    if (raw.config_inputs !== undefined && (!Array.isArray(raw.config_inputs) || raw.config_inputs.some(f => !binding(f)))) { add('DRAFT_RIG_MALFORMED', path, 'config_inputs must bind paths and sha256 hashes'); continue; }
    if (raw.files.length === 0 || asArray(parts.files).length === 0 || all.some(f => !binding(f))
      || !asArray(parts.files).some(f => binding(f) && f.path === `${String(parts.path)}/parts.json`)) { add('DRAFT_RIG_MALFORMED', path, 'file inventories must bind config, parts.json and output'); continue; }
    const rigs = asArray(raw.files).filter(f => binding(f) && String(f.path).endsWith('/rig.json'));
    if (rigs.length !== 1 || !['motion.json', 'mesh_report.json'].every(name => asArray(raw.files).some(f => binding(f) && f.path === String((rigs[0] as JsonObject).path).replace(/rig\.json$/, name)))) { add('DRAFT_RIG_MALFORMED', path, 'expected one complete rig output layout'); continue; }
    const unavailable = new Set<string>();
    for (const entry of all) {
      if (!binding(entry)) continue;
      const file = String(entry.path);
      try {
        if (draftFileUnavailable(dir, file, root)) { unavailable.add(file); continue; }
        const bytes = readFileSync(fileAt(dir, file, root));
        if (sha(bytes) !== entry.sha256) throw new Error(`${file} changed`);
      } catch (error) { add('DRAFT_RIG_FILE', path, error instanceof Error ? error.message : String(error)); }
    }
    try {
      if (!draftFileUnavailable(dir, String(raw.config.path), root)) {
        const config = JSON.parse(readFileSync(fileAt(dir, String(raw.config.path), root), 'utf8'));
        for (const ref of configInputReferences(dir, config)) {
          const named = relative(resolve(dir), resolve(dir, String(raw.config.path), '..', ref.value)).split(sep).join('/');
          if (!asArray(raw.config_inputs).some(f => binding(f) && f.path === named)) {
            const finding = { code: 'DRAFT_RIG_FILE', path, message: `${path}.config_inputs: missing config.${ref.at} input ${named}; preserve the old draft and record a new draft with draft-rig` };
            (configInputsLegacy(raw.at) ? warnings : refusals).push(finding);
          }
        }
      }
    } catch (error) {
      if (error instanceof ConfigInputsUnavailable && configInputsLegacy(raw.at)) warnings.push({ code: 'DRAFT_RIG_FILE', path, message: `${path}: ${error.message}` });
      else add('DRAFT_RIG_FILE', path, error instanceof Error ? error.message : String(error));
    }
    try {
      if (!draftFileUnavailable(dir, String(parts.path), root)) {
        const expected = new Map(asArray(parts.files).filter(binding).map(f => [String(f.path), f.sha256]));
        for (const actual of partsInventory(dir, String(parts.path), root)) {
          if (expected.get(String(actual.path)) !== actual.sha256) throw new Error(`parts inventory changed at ${String(actual.path)}`);
        }
      }
    } catch (error) { add('DRAFT_RIG_FILE', path, error instanceof Error ? error.message : String(error)); }
    if (unavailable.size > 0) warnings.push({ code: 'DRAFT_RIG_UNAVAILABLE', path, message: `${path}: regenerable draft artifacts are unavailable (${[...unavailable].join(', ')}); restore the recorded bytes before inspecting or rebuilding this draft` });
  }
}

/** Check declared identity/paths, including real paths; identical model bytes alone prove nothing. */
export function draftVersionFindings(dir: string, project: JsonObject): Finding[] {
  const out: Finding[] = [];
  const reserved = resolve(realpathSync(dir), 'derived/drafts');
  const declared = new Set(asArray(project.drafts).filter(isObject).flatMap(d => [d.config, ...asArray(d.files), ...(isObject(d.parts) ? asArray(d.parts.files) : [])])
    .filter(binding).map(f => String(f.path)));
  const visit = (value: Json, key = ''): boolean => {
    if (typeof value === 'string' && ['path', 'source_dir', 'from'].includes(key)) {
      const absolute = resolve(dir, value);
      if (declared.has(value) || absolute === reserved || inside(reserved, absolute)) return true;
      try { const real = realpathSync(absolute); if (real === reserved || inside(reserved, real)) return true; } catch { /* Other readers report missing files. */ }
    }
    if (Array.isArray(value)) return value.some(v => visit(v));
    return isObject(value) && Object.entries(value).some(([k, v]) => visit(v, k));
  };
  for (const [i, raw] of asArray(project.versions).entries()) {
    if (!isObject(raw)) continue;
    if (raw.kind === 'draft-rig' || raw.draft === true || raw.draft_id !== undefined || visit(raw)) {
      const path = `versions[${i}]`;
      out.push({ code: 'DRAFT_RIG_AS_VERSION', path, message: `${path}: a draft cannot be reviewed, packaged or handed off as a production version; build a separately authorised production rig` });
    }
  }
  return out;
}

export const DRAFT_RIG_HELP = `draft-rig:
  <id> [<dir>] --config <path> --from <output dir> [--parts <dir>] [--json]
  Record existing labelled draft artifacts under derived/drafts/<id>/; run no producer.
  Standalone rig output requires --parts; only an unambiguous build root supplies it implicitly.
  Config/output association is declared, not measured reproducibility or producer provenance.`;

export function draftRigCommand(args: string[]): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (['--config', '--from', '--parts'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || opts[arg] !== undefined) refuse('DRAFT_RIG_USAGE', `drafts: ${arg} requires one value; see draft-rig help`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('DRAFT_RIG_USAGE', `drafts: unsupported ${arg}; see draft-rig help`, USAGE_EXIT);
    else positional.push(arg);
  }
  const id = positional[0];
  if (!id || !idPattern.test(id) || positional.length > 2 || !opts['--config'] || !opts['--from']) refuse('DRAFT_RIG_USAGE', DRAFT_RIG_HELP, USAGE_EXIT);
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = readProject(dir);
  const root = `derived/drafts/${id}`;
  let record: JsonObject;
  try {
    const from = opts['--from'];
    const output = inventory(dir, from, root);
    const has = (name: string): boolean => output.some(f => f.path === `${from}/${name}`);
    const build = has('parts.json') && output.some(f => String(f.path).startsWith(`${from}/parts/`)) && has('rig/rig.json');
    const standalone = has('rig.json');
    if (build === standalone) throw new Error('ambiguous or missing build/standalone rig layout');
    if (standalone && !opts['--parts']) throw new Error('standalone rig output needs --parts');
    const parts = opts['--parts'] ?? from;
    const partsFiles = partsInventory(dir, parts, root);
    const rigPrefix = build ? `${from}/rig` : from;
    for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) if (!output.some(f => f.path === `${rigPrefix}/${name}`)) throw new Error(`${name}: missing rig output`);
    const configFile = fileAt(dir, opts['--config'], root);
    if (!isObject(JSON.parse(readFileSync(configFile, 'utf8')))) throw new Error('config must be an object');
    const configInputs = configInputBindings(dir, opts['--config']);
    for (const input of configInputs) fileAt(dir, String(input.path), root);
    const installed = locateParts(dir);
    if (installed === null) throw new Error('install @rig-c/parts before recording a draft');
    const pkgFile = join(installed, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name: string; version: string };
    record = { id, kind: 'draft-rig', at: new Date().toISOString(), producer: { name: pkg.name, version: pkg.version }, config: { path: pathOf(dir, configFile), sha256: sha(readFileSync(configFile)) }, parts: { path: parts, files: partsFiles }, files: output, ...(configInputs.length ? { config_inputs: configInputs } : {}) };
  } catch (error) { refuse('DRAFT_RIG_MALFORMED', `drafts[${id}]: ${error instanceof Error ? error.message : String(error)}; retain an unambiguous labelled output and its --parts inputs`); }
  if (project.drafts !== undefined && !Array.isArray(project.drafts)) refuse('DRAFT_RIG_MALFORMED', 'drafts: expected a list; restore the original record');
  project.drafts = [...asArray(project.drafts), record];
  const errors: Finding[] = [];
  checkDrafts(dir, project, errors);
  const first = errors[0] ?? checkProject(dir, project).refusals[0];
  if (first !== undefined) refuse(first.code, first.message);
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(record, null, 2) : `draft-rig: recorded ${id}; no production version created`, exit: 0 };
}
