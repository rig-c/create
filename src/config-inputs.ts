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
 * The file a directory reference binds: a See-through occluder plate directory
 * (`comfy plate --mode occluder`) is bound by its producer's receipt, which
 * itself binds the plate's sibling files; create never hashes those siblings.
 */
export const DIRECTORY_INPUT_RECEIPT = 'receipt.json';
/**
 * One binding per config-named input. A file binds `{path, sha256}`; a
 * directory binds `{path: <dir>/receipt.json, sha256, directory: <dir>}`, so
 * every reader that hashes `path` reads a regular file either way.
 */
export function configInputBindings(dir: string, configPath: string, allowMissing = false, unavailable?: ConfigInputsWarning): JsonObject[] {
  const config = JSON.parse(readFileSync(resolve(dir, configPath), 'utf8'));
  const root = realpathSync(dir);
  const contained = (at: string, path: string): string => {
    if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error(`${at}: named input leaves the project`);
    return path.split(sep).join('/');
  };
  return configInputReferences(dir, config, unavailable).map((ref): JsonObject => {
    const file = resolve(dir, dirname(configPath), ref.value);
    if (allowMissing && !existsSync(file)) return { path: contained(ref.at, relative(root, file)), sha256: null };
    const real = realpathSync(file);
    const path = contained(ref.at, relative(root, real));
    if (lstatSync(real).isDirectory()) {
      const receipt = join(real, DIRECTORY_INPUT_RECEIPT);
      const bound = `${path}/${DIRECTORY_INPUT_RECEIPT}`;
      if (allowMissing && !existsSync(receipt)) return { path: bound, sha256: null, directory: path };
      if (!existsSync(receipt) || !lstatSync(receipt).isFile()) throw new Error(`${ref.at}: named input directory ${path} holds no regular-file ${DIRECTORY_INPUT_RECEIPT}; a directory input binds its producer's receipt, such as a comfy plate --mode occluder output`);
      return { path: bound, sha256: createHash('sha256').update(readFileSync(receipt)).digest('hex'), directory: path };
    }
    if (!lstatSync(real).isFile()) throw new Error(`${ref.at}: named input ${path} is not a regular file`);
    return { path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  });
}
export function configInputsLegacy(at: unknown): boolean {
  return typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(CONFIG_INPUTS_SINCE);
}
