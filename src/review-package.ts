import { configInputReferences, configInputsLegacy, type ConfigInputsWarning } from './config-inputs.ts';
import { DirectionError, objects as directionObjects, readDirection } from './direction.ts';
/** Frozen producer inputs in review's fixed discovery layout (create#38). */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { asArray, isObject, readJsonObject, type Ctx } from './check.ts';
import { draftVersionFindings } from './drafts.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { latestPartsApproval, retainedJson } from './structure.ts';
import type { Json, JsonObject } from './templates.ts';

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const BUILD_IDENTITY_SINCE = '2026-11-06T00:00:00Z';

/** Compare declared identities even when regenerable package bytes are absent. */
function checkBuildIdentity(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>, version: JsonObject, record: JsonObject): void {
  const at = Date.parse(String(version.at));
  const findings = Number.isFinite(at) && at >= Date.parse(BUILD_IDENTITY_SINCE) ? ctx.refusals : ctx.warnings;
  const path = `versions[v${String(version.n)}].review_package`;
  const mismatch = (code: string, field: string, expected: string, actual: string): void => {
    findings.push({ code, path: `${path}.${field}`, message: `${path}.${field}: package sha256 ${actual} differs from recorded build sha256 ${expected}; preserve the historical package and record a new version from the same config and accepted parts` });
  };
  const provenance = isObject(version.provenance) ? version.provenance : {};
  const config = isObject(provenance.config) ? provenance.config : {};
  if (typeof config.sha256 === 'string' && isObject(record.config) && typeof record.config.sha256 === 'string' && config.sha256 !== record.config.sha256) {
    mismatch('REVIEW_PACKAGE_CONFIG_MISMATCH', 'config', config.sha256, record.config.sha256);
  }
  const approval = latestPartsApproval(ctx.project, Number.isFinite(at) ? at : Infinity);
  if (!approval) return;
  let verdict: JsonObject;
  try { verdict = retainedJson(ctx.dir, approval.evidence); } catch (error) {
    const evidence = isObject(approval.evidence) ? approval.evidence : {};
    findings.push({ code: 'REVIEW_PACKAGE_PARTS_UNREAD', path: `${path}.files[out/parts.json]`, message: `${path}.files[out/parts.json]: cannot resolve the accepted parts manifest from verdict ${String(evidence.path)} (${error instanceof Error ? error.message : String(error)}); restore the retained verdict bytes matching signoffs[].evidence.sha256 before checking or packaging this version` });
    return;
  }
  const source = isObject(verdict.source) ? verdict.source : {};
  const manifest = asArray(source.files).find(f => isObject(f) && typeof f.path === 'string' && f.path.split('/').at(-1) === 'parts.json');
  const packaged = asArray(record.files).find(f => isObject(f) && f.path === 'out/parts.json');
  if (isObject(manifest) && typeof manifest.sha256 === 'string' && isObject(packaged) && typeof packaged.sha256 === 'string' && manifest.sha256 !== packaged.sha256) {
    mismatch('REVIEW_PACKAGE_PARTS_MISMATCH', 'files[out/parts.json]', manifest.sha256, packaged.sha256);
  }
}
const word = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
const packagePath = (n: number): string => `derived/review/v${n}`;
const openCommand = (n: number): string => `rig-review open ${word(`${packagePath(n)}/out`)}`;
const required = ['parts.json', 'parts', 'rig', 'check/build'] as const;
const inside = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

interface FileHash { path: string; sha256: string }

/** Named files are separate from producer outputs and required by their reader's date. */
export function reviewConfigInputs(record: JsonObject, dir: string, n: number, missing?: (path: string) => void, unavailable?: ConfigInputsWarning): JsonObject[] {
  const path = join(dir, packagePath(n), 'config.json');
  if (!existsSync(path)) return [];
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const refs = configInputReferences(dir, config, unavailable);
  return refs.flatMap(ref => {
    const name = relative(dirname(path), resolve(dirname(path), ref.value)).split(sep).join('/');
    const file = asArray(record.files).find(f => isObject(f) && f.path === name);
    if (isObject(file)) return [file];
    if (!missing) throw new Error(`config.${ref.at}: named input ${name} is missing from source package`);
    missing(name);
    return [{ path: name, sha256: null }];
  });
}
export function reviewHandoffInputs(record: JsonObject, dir: string, n: number, named = reviewConfigInputs(record, dir, n)): JsonObject[] {
  const base = asArray(record.files).filter((file): file is JsonObject => isObject(file) && typeof file.path === 'string'
    && (file.path === 'config.json' || file.path.startsWith('out/') && !file.path.startsWith('out/check/')));
  return [...base, ...named.filter(file => !base.some(f => f.path === file.path))];
}

function packageExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Check each existing ancestor before creating the next directory. */
function makePackageParent(dir: string): void {
  let parent = dir;
  for (const name of ['derived', 'review']) {
    parent = join(parent, name);
    if (!packageExists(parent)) mkdirSync(parent);
    if (!lstatSync(parent).isDirectory()) refuse('REVIEW_PACKAGE_PATH_INVALID', 'derived/review requires real directories without symlinks');
  }
}

function validFiles(value: JsonObject['files']): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  let previous = '';
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.path <= previous
      || isAbsolute(entry.path) || entry.path.split('/').some((part) => part === '..' || part === '.' || part === '')) return false;
    previous = entry.path;
  }
  return value.some((entry) => isObject(entry) && entry.path === 'config.json');
}

function sourceFiles(out: string): FileHash[] {
  return required.flatMap((entry) => entry === 'parts.json'
    ? [{ path: entry, sha256: hash(readFileSync(join(out, entry))) }]
    : filesAt(join(out, entry)).map((file) => ({ ...file, path: `${entry}/${file.path}` })));
}

/** Reject symlinks throughout the copied tree, including otherwise-contained ones. */
function filesAt(root: string, prefix = ''): FileHash[] {
  const files: FileHash[] = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const info = lstatSync(join(root, path));
    if (info.isDirectory()) files.push(...filesAt(root, path));
    else if (info.isFile()) files.push({ path, sha256: hash(readFileSync(join(root, path))) });
    else refuse('REVIEW_PACKAGE_INPUT_INVALID', `${path}: expected a regular file or directory, without symlinks`);
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function requireLayout(out: string): void {
  for (const entry of required) {
    const file = join(out, entry);
    if (!existsSync(file)) refuse('REVIEW_PACKAGE_INPUT_MISSING', `${entry}: required in the declared build out directory`);
    const stat = lstatSync(file);
    if (entry === 'parts.json' ? !stat.isFile() : !stat.isDirectory()) refuse('REVIEW_PACKAGE_INPUT_INVALID', `${entry}: wrong file kind`);
  }
  if (!lstatSync(join(out, 'check')).isDirectory()) refuse('REVIEW_PACKAGE_INPUT_INVALID', 'check: expected a real directory');
  for (const file of ['rig/rig.json', 'rig/motion.json', 'rig/mesh_report.json']) {
    if (!existsSync(join(out, file)) || !lstatSync(join(out, file)).isFile()) refuse('REVIEW_PACKAGE_INPUT_MISSING', `${file}: required producer rig file`);
  }
  const model = join(out, 'check/build/skeleton.model.json');
  if (!existsSync(model) || !lstatSync(model).isFile()) refuse('REVIEW_PACKAGE_INPUT_MISSING', 'check/build/skeleton.model.json: required compiled model');
}

function regeneration(n: number, record: JsonObject | null): string {
  return `rig-create review-package ${n} --config ${word(isObject(record?.config) && typeof record.config.path === 'string' ? record.config.path : '<config>')} --from ${word(typeof record?.from === 'string' ? record.from : '<build out dir>')}`;
}

/** Hash the complete package, so added files cannot silently change discovery. */
export function checkReviewPackages(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>): void {
  for (const version of asArray(ctx.project.versions)) {
    if (!isObject(version) || version.kind !== 'rig' || version.pre_interview === true) continue;
    const path = `versions[v${String(version.n)}].review_package`;
    const record = isObject(version.review_package) ? version.review_package : null;
    if (!Number.isSafeInteger(version.n) || (version.n as number) < 1) continue;
    const n = version.n as number;
    const pkg = join(ctx.dir, packagePath(n));
    if (version.review_package === undefined || version.review_package === null) {
      ctx.warnings.push({ code: 'REVIEW_PACKAGE_MISSING', path, message: `${path}: no package recorded, so the figure mask has no verdict; write it with ${regeneration(n, null)}` });
      continue;
    }
    if (record === null || !isObject(record.config) || typeof record.config.path !== 'string' || typeof record.config.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.config.sha256) || record.config.path.trim() === '' || isAbsolute(record.config.path) || !inside(ctx.dir, resolve(ctx.dir, record.config.path))
      || typeof record.from !== 'string' || record.from.trim() === '' || isAbsolute(record.from) || !inside(ctx.dir, resolve(ctx.dir, record.from)) || !validFiles(record.files)
      || record.open !== openCommand(n)) {
      ctx.refusals.push({ code: 'REVIEW_PACKAGE_MALFORMED', path, message: `${path}: expected config {path, sha256}, from, sorted files {path, sha256} and the package open command` });
      continue;
    }
    checkBuildIdentity(ctx, version, record);
    if (!packageExists(pkg)) {
      ctx.warnings.push({ code: 'REVIEW_PACKAGE_MISSING', path, message: `${path}: package absent, so the figure mask has no verdict; regenerate with ${regeneration(n, record)}` });
      continue;
    }
    try {
      if (!inside(realpathSync(ctx.dir), realpathSync(pkg)) || lstatSync(pkg).isSymbolicLink()) throw new Error('package leaves its project or is a symlink');
      requireLayout(join(pkg, 'out'));
      const actual = filesAt(pkg);
      if (!isDeepStrictEqual(actual, record.files) || hash(readFileSync(join(pkg, 'config.json'))) !== record.config.sha256) throw new Error('package files differ from recorded hashes');
    } catch (error) {
      ctx.refusals.push({ code: 'REVIEW_PACKAGE_CHANGED', path, message: `${path}: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    // The project-level loader diagnostic already owns this unavailable dependency.
    if (ctx.refusals.some(f => f.code === 'PARTS_SECTIONS_UNREADABLE' || f.code === 'PARTS_NOT_INSTALLED')) continue;
    try {
      const missing = (name: string): void => {
        const finding = { code: 'REVIEW_PACKAGE_INPUT_MISSING', path, message: `${path}: config-named input ${name} is missing from the frozen package inventory; preserve the package and record the complete inputs on the next build` };
        (configInputsLegacy(version.at) ? ctx.warnings : ctx.refusals).push(finding);
      };
      const unavailable = (error: Error): void => {
        const finding = { code: 'REVIEW_PACKAGE_INPUT_INVALID', path, message: `${path}: ${error.message}` };
        (configInputsLegacy(version.at) ? ctx.warnings : ctx.refusals).push(finding);
      };
      reviewConfigInputs(record, ctx.dir, n, missing, unavailable);
    } catch (error) { ctx.refusals.push({ code: 'REVIEW_PACKAGE_INPUT_INVALID', path, message: `${path}: ${error instanceof Error ? error.message : String(error)}; restore the frozen package config` }); }
  }
}

export const REVIEW_PACKAGE_HELP = `review-package <n> [<project dir>] --config <path> --from <build out dir> [--json]
  Copy frozen producer inputs into derived/review/v<n>; record hashes and the open command.
  Source paths are relative to the project and must stay inside it. Run the open command there.`;

export function reviewPackageCommand(args: string[]): { stdout: string; exit: number } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (arg === '--config' || arg === '--from') {
      const value = args[++i];
      if (!value || value.startsWith('--') || options[arg] !== undefined) refuse('REVIEW_PACKAGE_USAGE', `${arg} needs one value`, USAGE_EXIT);
      options[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `review-package does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const n = Number(positional[0]?.replace(/^v/, ''));
  if (!Number.isSafeInteger(n) || n < 1 || positional.length > 2 || !options['--config'] || !options['--from']) refuse('REVIEW_PACKAGE_USAGE', REVIEW_PACKAGE_HELP, USAGE_EXIT);
  const dir = realpathSync(resolve(positional[1] ?? process.cwd()));
  const projectFile = join(dir, 'project.json');
  if (!existsSync(projectFile)) refuse('PROJECT_JSON_MISSING', 'project.json is absent');
  const lock = `${projectFile}.review-package.lock`;
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx'); } catch { refuse('REVIEW_PACKAGE_BUSY', 'another package writer holds the project lock'); }
  try {
    const original = readFileSync(projectFile, 'utf8');
    const read = readJsonObject(projectFile);
    if (!read.ok) refuse('PROJECT_JSON_INVALID', read.error);
    const project = read.value;
    if (project.schema !== 'rig-create/project@0') refuse('SCHEMA_UNKNOWN', 'review-package reads rig-create/project@0');
    const version = asArray(project.versions).find((v) => isObject(v) && v.n === n);
    if (!isObject(version)) refuse('REVIEW_PACKAGE_VERSION_UNKNOWN', `no version ${n}`);
    const draftProblem = draftVersionFindings(dir, { ...project, versions: [version] })[0];
    if (draftProblem !== undefined) refuse(draftProblem.code, draftProblem.message);
    if (version.kind !== 'rig' || version.pre_interview === true) refuse('REVIEW_PACKAGE_VERSION_INVALID', 'review packages are for create-built rig versions');
    const source = (value: string): string => {
      const file = resolve(dir, value);
      if (isAbsolute(value) || !inside(dir, file)) refuse('REVIEW_PACKAGE_PATH_INVALID', `${value}: expected a project-relative source`);
      if (!existsSync(file)) refuse('REVIEW_PACKAGE_INPUT_MISSING', `${value}: source absent`);
      const canonical = realpathSync(file);
      if (!inside(dir, canonical)) refuse('REVIEW_PACKAGE_PATH_INVALID', `${value}: source resolves outside the project`);
      return canonical;
    };
    const declaredDraft = draftVersionFindings(dir, { ...project, versions: [{ kind: 'rig', source_dir: options['--from'], config: { path: options['--config'] } }] })[0];
    if (declaredDraft !== undefined) refuse(declaredDraft.code, declaredDraft.message);
    const config = source(options['--config']);
    const from = source(options['--from']);
    if (!lstatSync(config).isFile() || !lstatSync(from).isDirectory()) refuse('REVIEW_PACKAGE_INPUT_INVALID', 'config must be a file and --from a directory');
    requireLayout(from);
    const configBytes = readFileSync(config);
    try { if (!isObject(JSON.parse(configBytes.toString()))) throw new Error(); } catch { refuse('REVIEW_PACKAGE_INPUT_INVALID', 'config must be a JSON object'); }
    let named: { path: string; source: string; bytes: Buffer }[];
    try {
      named = configInputReferences(dir, JSON.parse(configBytes.toString())).map(ref => {
        const path = relative(dirname(config), resolve(dirname(config), ref.value)).split(sep).join('/');
        if (isAbsolute(ref.value) || !path || path.split('/').some(part => part === '..' || part === '.' || part === '')) refuse('REVIEW_PACKAGE_PATH_INVALID', `config.${ref.at}: ${ref.value} cannot be retained inside the package; use a config-relative input inside its directory`);
        const file = source(relative(dir, resolve(dirname(config), ref.value)));
        if (!lstatSync(file).isFile()) refuse('REVIEW_PACKAGE_INPUT_INVALID', `config.${ref.at}: ${path} must be a regular file`);
        return { path, source: file, bytes: readFileSync(file) };
      });
    } catch (error) { if (error instanceof Refusal) throw error; refuse('REVIEW_PACKAGE_INPUT_INVALID', `versions[v${n}].review_package.config: ${error instanceof Error ? error.message : String(error)}`); }
    const configObject = JSON.parse(configBytes.toString()) as JsonObject;
    if (typeof configObject.requirements === 'string') {
      const requirementsPath = relative(dirname(config), resolve(dirname(config), configObject.requirements)).split(sep).join('/');
      const requirements = named.find(input => input.path === requirementsPath);
      if (requirements) {
        let document: Json;
        try { document = JSON.parse(requirements.bytes.toString()); }
        catch { refuse('REVIEW_PACKAGE_INPUT_INVALID', `${requirements.path}: restore readable requirements JSON`); }
        const setup = isObject(document) && isObject(document.setup_painting) ? document.setup_painting : {};
        if (setup.figure_mask !== undefined) {
          const mask = setup.figure_mask;
          if (!isObject(mask) || typeof mask.path !== 'string' || !mask.path.trim()
            || typeof mask.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(mask.sha256)) {
            refuse('FIGURE_MASK_MISSING', `${requirements.path}: declare setup_painting.figure_mask {path, sha256} before packaging`);
          }
          const maskFile = resolve(dirname(config), dirname(requirements.path), mask.path);
          const maskPath = relative(dirname(config), maskFile).split(sep).join('/');
          if (isAbsolute(mask.path) || !maskPath || maskPath.split('/').some(part => part === '..' || part === '.' || part === '')) {
            refuse('REVIEW_PACKAGE_PATH_INVALID', `${requirements.path}: figure mask ${mask.path} must stay inside the config directory`);
          }
          let current = dirname(config);
          for (const part of maskPath.split('/')) {
            current = join(current, part);
            if (existsSync(current) && lstatSync(current).isSymbolicLink()) refuse('REVIEW_PACKAGE_PATH_INVALID', `${maskPath}: retain a figure mask without symlinks`);
          }
          let regularFile = false;
          try { regularFile = lstatSync(maskFile).isFile(); } catch { /* Missing paths are refused below. */ }
          if (!regularFile) refuse('FIGURE_MASK_CHANGED', `${maskPath}: restore the declared mask as a readable PNG file before packaging`);
          let bytes: Buffer;
          try { bytes = readFileSync(maskFile); }
          catch { refuse('FIGURE_MASK_CHANGED', `${maskPath}: cannot read the declared mask; restore its PNG before packaging`); }
          if (hash(bytes) !== mask.sha256) refuse('FIGURE_MASK_CHANGED', `${maskPath}: bytes differ from the declared sha256; restore the mask or record its corrected declaration before packaging`);
          if (maskPath === 'config.json' && !bytes.equals(configBytes)) refuse('REVIEW_PACKAGE_INPUT_INVALID', `${maskPath}: figure mask collides with the packaged config`);
          const existing = named.find(input => input.path === maskPath);
          if (existing && !existing.bytes.equals(bytes)) refuse('REVIEW_PACKAGE_INPUT_INVALID', `${maskPath}: figure mask collides with a named input`);
          if (!existing) named.push({ path: maskPath, source: maskFile, bytes });
        }
      }
    }
    // A compiled model already cited by an authored take cannot be rebound by packaging.
    for (const post of directionObjects(project.versions)) {
      if (post.kind !== 'post' || post.rig_version !== n || !isObject(post.provenance) || post.provenance.direction === undefined) continue;
      try {
        const document = readDirection(dir, project, post.n, false);
        const expected = ((document.rig as JsonObject).model as JsonObject).sha256;
        if (hash(readFileSync(join(from, 'check/build/skeleton.model.json'))) !== expected) refuse('DIRECTION_RIG_STALE', `versions[v${n}].review_package: this model is bound by a direction document; preserve it and author a new rig version`);
      } catch (error) { if (error instanceof DirectionError) refuse(error.code, error.message); throw error; }
    }
    const inputs = sourceFiles(from);
    const pkg = join(dir, packagePath(n));
    makePackageParent(dir);
    const scratch = mkdtempSync(join(dirname(pkg), `.v${n}-`));
    let published = false;
    try {
      writeFileSync(join(scratch, 'config.json'), configBytes);
      for (const input of named) {
        const dest = join(scratch, input.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, input.bytes);
      }
      for (const entry of required) {
        if (entry !== 'parts.json') mkdirSync(join(scratch, 'out', entry), { recursive: true });
      }
      for (const file of inputs) {
        const bytes = readFileSync(join(from, file.path));
        if (hash(bytes) !== file.sha256) refuse('REVIEW_PACKAGE_SOURCE_CHANGED', `${file.path}: source changed during copy`);
        const dest = join(scratch, 'out', file.path);
        if (existsSync(dest) && !readFileSync(dest).equals(bytes)) refuse('REVIEW_PACKAGE_INPUT_INVALID', `${file.path}: config input collides with a producer output`);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
      }
      if (!isDeepStrictEqual(sourceFiles(from), inputs) || hash(readFileSync(config)) !== hash(configBytes)) {
        refuse('REVIEW_PACKAGE_SOURCE_CHANGED', 'producer inputs changed during copy');
      }
      for (const input of named) if (!readFileSync(input.source).equals(input.bytes)) refuse('REVIEW_PACKAGE_SOURCE_CHANGED', `${input.path}: config input changed during copy`);
      const files = filesAt(scratch);
      const record: JsonObject = { config: { path: relative(dir, config), sha256: hash(configBytes) }, from: relative(dir, from), files: files.map((f) => ({ ...f })), open: openCommand(n) };
      const identity = { dir, project, refusals: [] as Ctx['refusals'], warnings: [] as Ctx['warnings'] };
      checkBuildIdentity(identity, version, record);
      if (identity.refusals[0]) refuse(identity.refusals[0].code, identity.refusals[0].message);
      if (packageExists(pkg)) {
        if (lstatSync(pkg).isSymbolicLink() || realpathSync(pkg) !== pkg) refuse('REVIEW_PACKAGE_PATH_INVALID', 'existing package must have no symlink parents');
        if (!isDeepStrictEqual(filesAt(pkg), files)) refuse('REVIEW_PACKAGE_EXISTS', 'existing package differs; preserve it and inspect the recorded version before regenerating');
      } else {
        renameSync(scratch, pkg);
        published = true;
      }
      if (readFileSync(projectFile, 'utf8') !== original) refuse('REVIEW_PACKAGE_RECORD_CHANGED', 'project.json changed during copying; retry from the current record');
      version.review_package = record;
      const pending = join(scratch, 'project.json');
      mkdirSync(scratch, { recursive: true });
      writeFileSync(pending, `${JSON.stringify(project, null, 2)}\n`);
      renameSync(pending, projectFile);
      published = false;
      return { stdout: json ? JSON.stringify(record, null, 2) : `review-package: v${n} copied; ${openCommand(n)}`, exit: 0 };
    } finally {
      if (published) rmSync(pkg, { recursive: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    closeSync(descriptor);
    rmSync(lock);
  }
}
