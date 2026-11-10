/** Config input identities come from the installed loader's file declarations. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { locateParts, OWN_NODE_MODULES } from './parts-sections.ts';
import type { JsonObject } from './templates.ts';

export const CONFIG_INPUTS_SINCE = '2026-11-06T00:00:00Z';
const load = createRequire(import.meta.url);
export class ConfigInputsUnavailable extends Error {
  constructor(version: string) {
    super(`@rig-c/parts ${version} has no configFileReferences export; install a version providing the config file declarations before recording new named inputs`);
  }
}
export type ConfigInputsWarning = (error: ConfigInputsUnavailable) => void;
export function configInputReferences(dir: string, config: unknown, unavailable?: ConfigInputsWarning): { at: string; value: string }[] {
  const parts = locateParts(dir);
  if (parts === null) throw new Error('install @rig-c/parts to read config-named inputs');
  const mod = load(join(parts, 'src/config.ts')) as { configFileReferences?: (config: unknown) => { at: string; value: string }[] };
  if (typeof mod.configFileReferences !== 'function') {
    // The pinned declaration only detects whether the unavailable capability matters.
    // It supplies no binding on behalf of the project's older loader.
    const own = load(join(OWN_NODE_MODULES, '@rig-c/parts/src/config.ts')) as typeof mod;
    if (typeof own.configFileReferences !== 'function' || !own.configFileReferences(config).length) return [];
    const pkg = JSON.parse(readFileSync(join(parts, 'package.json'), 'utf8')) as { version: string };
    const error = new ConfigInputsUnavailable(pkg.version);
    if (!unavailable) throw error;
    unavailable(error);
    return [];
  }
  return mod.configFileReferences(config);
}
/**
 * The config-named inputs the pinned parts declares for `config` that the
 * project's install does not, with the install's version. The pinned
 * declaration stands in for a newer producer's, which create cannot load; it
 * is used only to refuse a writer, never to bind on the install's behalf.
 */
export function inputsUndeclaredByInstall(dir: string, config: unknown): { version: string; refs: { at: string; value: string }[] } {
  const parts = locateParts(dir);
  if (parts === null) throw new Error('install @rig-c/parts to read config-named inputs');
  type Loader = { configFileReferences?: (config: unknown) => { at: string; value: string }[] };
  const mod = load(join(parts, 'src/config.ts')) as Loader;
  const own = load(join(OWN_NODE_MODULES, '@rig-c/parts/src/config.ts')) as Loader;
  const version = (JSON.parse(readFileSync(join(parts, 'package.json'), 'utf8')) as { version: string }).version;
  if (typeof own.configFileReferences !== 'function') return { version, refs: [] };
  const declared = typeof mod.configFileReferences === 'function' ? new Set(mod.configFileReferences(config).map(ref => ref.at)) : new Set<string>();
  return { version, refs: own.configFileReferences(config).filter(ref => !declared.has(ref.at)) };
}
/** Whether release `a` is later than release `b`; a version that is not plain major.minor.patch is never later. */
export function releaseAfter(a: string, b: string): boolean {
  const x = /^(\d+)\.(\d+)\.(\d+)$/.exec(a);
  const y = /^(\d+)\.(\d+)\.(\d+)$/.exec(b);
  if (x === null || y === null) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}
/**
 * The file a directory reference binds: a See-through occluder plate directory
 * (`comfy plate --mode occluder`) is bound by its producer's receipt, which
 * itself binds the plate's sibling files; create never hashes those siblings.
 */
export const DIRECTORY_INPUT_RECEIPT = 'receipt.json';
/**
 * The plate-receipt spec the project's installed parts declares
 * (`PLATE_RECEIPT_SPEC` in `src/plate.ts`), read from the producer and never
 * copied into create.
 */
export function plateReceiptSpec(dir: string): string {
  const parts = locateParts(dir);
  if (parts === null) throw new Error('install @rig-c/parts to read config-named inputs');
  let spec: unknown;
  try { spec = (load(join(parts, 'src/plate.ts')) as { PLATE_RECEIPT_SPEC?: unknown }).PLATE_RECEIPT_SPEC; } catch { spec = undefined; }
  if (typeof spec !== 'string' || !spec) {
    const pkg = JSON.parse(readFileSync(join(parts, 'package.json'), 'utf8')) as { version: string };
    throw new Error(`@rig-c/parts ${pkg.version} has no PLATE_RECEIPT_SPEC export in src/plate.ts; install a version declaring the plate receipt spec before binding a directory input`);
  }
  return spec;
}
/** The `spec` a receipt's bytes declare, or null when they are not a JSON object with a string spec. */
export function receiptSpec(bytes: Uint8Array): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return null; }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { spec?: unknown }).spec === 'string' ? (parsed as { spec: string }).spec : null;
}
/**
 * One binding per config-named input. A file binds `{path, sha256}`; a
 * directory binds `{path: <dir>/receipt.json, sha256, directory: <dir>, spec}`,
 * so every reader that hashes `path` reads a regular file either way. The
 * receipt must declare the installed parts' plate-receipt spec; its siblings
 * and measurements are parts' to verify, not create's.
 */
export function configInputBindings(dir: string, configPath: string, allowMissing = false, unavailable?: ConfigInputsWarning): JsonObject[] {
  const config = JSON.parse(readFileSync(resolve(dir, configPath), 'utf8'));
  const root = realpathSync(dir);
  const contained = (at: string, path: string): string => {
    if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error(`${at}: named input leaves the project`);
    return path.split(sep).join('/');
  };
  const canonical = (target: string): string => {
    let cur = target;
    while (!existsSync(cur)) {
      try { if (lstatSync(cur).isSymbolicLink()) break; } catch { /* Missing segment; try parent. */ }
      const parent = dirname(cur);
      if (parent === cur) return target;
      cur = parent;
    }
    return resolve(realpathSync(cur), relative(cur, target));
  };
  return configInputReferences(dir, config, unavailable).map((ref): JsonObject => {
    const file = resolve(dir, dirname(configPath), ref.value);
    const present = existsSync(file);
    const real = present ? realpathSync(file) : canonical(file);
    const path = contained(ref.at, relative(root, real));
    if (!present) {
      if (allowMissing) return { path, sha256: null };
      realpathSync(file);
    }
    if (lstatSync(real).isDirectory()) {
      const receipt = join(real, DIRECTORY_INPUT_RECEIPT);
      const bound = `${path}/${DIRECTORY_INPUT_RECEIPT}`;
      if (allowMissing && !existsSync(receipt)) return { path: bound, sha256: null, directory: path };
      if (!existsSync(receipt) || !lstatSync(receipt).isFile()) throw new Error(`${ref.at}: named input directory ${path} holds no regular-file ${DIRECTORY_INPUT_RECEIPT}; a directory input binds its producer's receipt, such as a comfy plate --mode occluder output`);
      const bytes = readFileSync(receipt);
      const spec = plateReceiptSpec(dir);
      const declared = receiptSpec(bytes);
      if (declared !== spec) throw new Error(`${ref.at}: ${bound} declares spec ${JSON.stringify(declared)}; a directory input binds a ${spec} receipt, such as a comfy plate --mode occluder output`);
      return { path: bound, sha256: createHash('sha256').update(bytes).digest('hex'), directory: path, spec };
    }
    if (!lstatSync(real).isFile()) throw new Error(`${ref.at}: named input ${path} is not a regular file`);
    return { path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  });
}
export function configInputsLegacy(at: unknown): boolean {
  return typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(CONFIG_INPUTS_SINCE);
}
/**
 * Drafts recorded before this date with no `config_inputs` key, on a config
 * that names inputs, WARN DRAFT_CONFIG_INPUTS_UNRECORDED: the config is bound
 * by sha256, so the absent key came from an install that could not declare the
 * inputs, which draft-rig refuses from this date (DRAFT_PARTS_INSTALL_BEHIND).
 */
export const DRAFT_CONFIG_INPUTS_SINCE = '2026-11-09T00:00:00Z';
/**
 * How a draft's unbound config-named input is reported, the one rule for check
 * and every reader that runs it (the job record's inventory phase included):
 * `legacy` WARNs DRAFT_RIG_FILE before CONFIG_INPUTS_SINCE, `unrecorded` WARNs
 * DRAFT_CONFIG_INPUTS_UNRECORDED for an absent key before
 * DRAFT_CONFIG_INPUTS_SINCE, and `refused` is a DRAFT_RIG_FILE refusal.
 */
export function draftUnboundInputs(draft: { at?: unknown; config_inputs?: unknown }): 'legacy' | 'unrecorded' | 'refused' {
  if (configInputsLegacy(draft.at)) return 'legacy';
  return draft.config_inputs === undefined && Date.parse(String(draft.at)) < Date.parse(DRAFT_CONFIG_INPUTS_SINCE) ? 'unrecorded' : 'refused';
}
