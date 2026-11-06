/** Config input identities come from the installed loader's file declarations. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { locateParts } from './parts-sections.ts';
import type { JsonObject } from './templates.ts';

export const CONFIG_INPUTS_SINCE = '2026-11-06T00:00:00Z';
const load = createRequire(import.meta.url);
export function configInputReferences(dir: string, config: unknown): { at: string; value: string }[] {
  const parts = locateParts(dir);
  if (parts === null) throw new Error('install @rig-c/parts to read config-named inputs');
  const mod = load(join(parts, 'src/config.ts')) as { configFileReferences?: (config: unknown) => { at: string; value: string }[] };
  if (!mod.configFileReferences) throw new Error('installed @rig-c/parts has no configFileReferences export');
  return mod.configFileReferences(config);
}
export function configInputBindings(dir: string, configPath: string, allowMissing = false): JsonObject[] {
  const config = JSON.parse(readFileSync(resolve(dir, configPath), 'utf8'));
  return configInputReferences(dir, config).map(ref => {
    const file = resolve(dir, dirname(configPath), ref.value);
    const path = relative(realpathSync(dir), allowMissing && !existsSync(file) ? file : realpathSync(file));
    if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error(`${ref.at}: named input leaves the project`);
    return { path: path.split(sep).join('/'), sha256: allowMissing && !existsSync(file) ? null : createHash('sha256').update(readFileSync(file)).digest('hex') };
  });
}
export function configInputsLegacy(at: unknown): boolean {
  return typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(CONFIG_INPUTS_SINCE);
}
