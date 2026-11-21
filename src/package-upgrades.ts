/** Optional package migration history: old records need no adoption date. */
import { isObject, type Finding } from './check.ts';
import type { JsonObject } from './templates.ts';

export const PACKAGE_NAMES = ['@rig-c/core', '@rig-c/parts', '@rig-c/review'] as const;
export const exactVersion = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
export function compareVersions(a: string, b: string): number {
  const right = b.split('.').map(Number);
  for (const [index, value] of a.split('.').map(Number).entries()) {
    if (value !== right[index]) return value - right[index]!;
  }
  return 0;
}

export function packageUpgradeFindings(project: JsonObject): Finding[] {
  const history = project.package_upgrades;
  if (history === undefined) return [];
  const bad = (path: string): Finding => ({ code: 'PACKAGE_UPGRADE_MALFORMED', path, message: `${path}: invalid package upgrade history; restore the writer's from/to versions, operator, timestamp, lock integrity and any question_set or waypoint_config move (rig-create packages upgrade)` });
  if (!Array.isArray(history)) return [bad('package_upgrades')];
  const out: Finding[] = [];
  for (const [index, row] of history.entries()) {
    const path = `package_upgrades[${index}]`;
    if (!isObject(row) || typeof row.by !== 'string' || !row.by.trim() || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || typeof row.lock_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.lock_sha256) || !Array.isArray(row.packages) || row.packages.length !== PACKAGE_NAMES.length) {
      out.push(bad(path)); continue;
    }
    for (const [i, name] of PACKAGE_NAMES.entries()) {
      const pin = row.packages[i];
      if (!isObject(pin) || pin.name !== name || (pin.from !== null && !exactVersion(pin.from)) || !exactVersion(pin.to) || (typeof pin.from === 'string' && compareVersions(pin.from, pin.to) > 0)) out.push(bad(`${path}.packages[${i}]`));
    }
    // Optional moves the writer records with the pins: absent on older rows.
    const set = row.question_set;
    if (set !== undefined && !(isObject(set) && typeof set.from === 'string' && typeof set.to === 'string' && set.to.includes('@rig-c/parts '))) out.push(bad(`${path}.question_set`));
    const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
    const configs = row.waypoint_config;
    if (configs !== undefined && !(Array.isArray(configs) && configs.length > 0 && configs.every(move => isObject(move) && typeof move.id === 'string' && strings(move.from) && strings(move.to)))) out.push(bad(`${path}.waypoint_config`));
  }
  return out;
}
