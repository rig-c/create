import { configInputReferences, configInputsLegacy, DIRECTORY_INPUT_RECEIPT, plateReceiptSpec, receiptSpec, type ConfigInputsWarning } from './config-inputs.ts';
/** Frozen producer inputs in review's fixed discovery layout (create#38). */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from './check-reads.ts';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { asArray, isObject, type Ctx } from './check.ts';
import { refuse } from './refusal.ts';
import { rigVersionDateFinding } from './rig-version-date.ts';
import type { JsonObject } from './templates.ts';

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const BUILD_IDENTITY_SINCE = '2026-11-06T00:00:00Z';

/** Compare declared identities even when regenerable package bytes are absent. */
function checkBuildIdentity(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>, version: JsonObject, record: JsonObject): void {
  const at = Date.parse(String(version.at));
  const findings = version.accepted_parts !== undefined || (Number.isFinite(at) && at >= Date.parse(BUILD_IDENTITY_SINCE)) ? ctx.refusals : ctx.warnings;
  const path = `versions[v${String(version.n)}].review_package`;
  const mismatch = (code: string, field: string, expected: string, actual: string): void => {
    findings.push({ code, path: `${path}.${field}`, message: `${path}.${field}: package sha256 ${actual} differs from recorded build sha256 ${expected}; preserve the historical package and record a new version from the same config and accepted parts` });
  };
  const provenance = isObject(version.provenance) ? version.provenance : {};
  const config = isObject(provenance.config) ? provenance.config : {};
  if (typeof config.sha256 === 'string' && isObject(record.config) && typeof record.config.sha256 === 'string' && config.sha256 !== record.config.sha256) {
    mismatch('REVIEW_PACKAGE_CONFIG_MISMATCH', 'config', config.sha256, record.config.sha256);
  }
  // The packaged parts are not compared with a parts approval (#981): parts may change and the rig is rebuilt from them.
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
export function reviewConfigInputs(record: JsonObject, dir: string, n: number, missing?: (path: string) => void, unavailable?: ConfigInputsWarning, pkgDir = join(dir, packagePath(n))): JsonObject[] {
  const path = join(pkgDir, 'config.json');
  if (!existsSync(path)) return [];
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const refs = configInputReferences(dir, config, unavailable);
  const declared = new Set(refs.flatMap(ref => {
    const name = relative(dirname(path), resolve(dirname(path), ref.value)).split(sep).join('/');
    return [name, `${name}/${DIRECTORY_INPUT_RECEIPT}`];
  }));
  if (isObject(config) && typeof config.requirements === 'string') {
    const reqFile = resolve(dirname(path), config.requirements);
    if (existsSync(reqFile) && lstatSync(reqFile).isFile()) {
      try {
        const doc = JSON.parse(readFileSync(reqFile, 'utf8'));
        const setup = isObject(doc) && isObject(doc.setup_painting) ? doc.setup_painting : {};
        for (const key of ['figure_mask', 'backdrop'] as const) {
          const entry = isObject(setup[key]) ? setup[key] : undefined;
          if (typeof entry?.path === 'string' && entry.path.trim()) {
            declared.add(relative(dirname(path), resolve(dirname(reqFile), entry.path)).split(sep).join('/'));
          }
        }
      } catch { /* Handled by figure-mask checks. */ }
    }
  }
  return refs.flatMap(ref => {
    const name = relative(dirname(path), resolve(dirname(path), ref.value)).split(sep).join('/');
    const file = asArray(record.files).find(f => isObject(f) && f.path === name);
    if (isObject(file)) return [file];
    const bound = `${name}/${DIRECTORY_INPUT_RECEIPT}`;
    const receipt = asArray(record.files).find(f => isObject(f) && f.path === bound);
    if (isObject(receipt)) {
      if (asArray(record.files).some(f => isObject(f) && typeof f.path === 'string' && f.path.startsWith(`${name}/`) && f.path !== bound && !declared.has(f.path))) {
        throw new Error(`config.${ref.at}: directory input ${name} must bind only ${bound}`);
      }
      const spec = plateReceiptSpec(dir);
      const receiptFile = join(dirname(path), bound);
      if (existsSync(receiptFile)) {
        const declaredSpec = receiptSpec(readFileSync(receiptFile));
        if (declaredSpec !== spec) throw new Error(`config.${ref.at}: ${bound} declares spec ${JSON.stringify(declaredSpec)}; a directory input binds a ${spec} receipt, such as a comfy plate --mode occluder output`);
      }
      return [receipt];
    }
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

/** Hash each selected package, keeping the full project available for receipt validation. */
export function checkReviewPackages(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>, versionNumber?: number): void {
  for (const version of asArray(ctx.project.versions)) {
    if (!isObject(version) || version.kind !== 'rig' || versionNumber !== undefined && version.n !== versionNumber) continue;
    const dateFinding = rigVersionDateFinding(version);
    if (dateFinding) ctx.refusals.push(dateFinding);
    if (version.pre_interview === true) continue;
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
