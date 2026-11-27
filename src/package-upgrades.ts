/** Optional package migration history: old records need no adoption date. */
import { join } from 'node:path';
import { existsSync } from './check-reads.ts';
import { isObject, readJsonObject, type Finding } from './check.ts';
import { CREATE_PACKAGE, runningCreateVersion } from './pins.ts';
import type { JsonObject } from './templates.ts';

export const LEGACY_PACKAGE_NAMES = ['@rig-c/core', '@rig-c/parts', '@rig-c/review'] as const;
export const PACKAGE_NAMES = ['@rig-c/core', CREATE_PACKAGE, '@rig-c/parts', '@rig-c/review'] as const;
export const exactVersion = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);

export function createPinWarning(dir: string, running = runningCreateVersion()): Finding | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  const read = readJsonObject(file);
  if (!read.ok) {
    return {
      code: 'CREATE_PIN_MISSING',
      path: 'package.json',
      message: `package.json: ${read.error}; restore a valid manifest and run rig-create packages upgrade --by <operator> to pin ${CREATE_PACKAGE}`,
    };
  }
  const dependencies = isObject(read.value.dependencies) ? read.value.dependencies : undefined;
  const declared = dependencies?.[CREATE_PACKAGE];
  const path = `package.json.dependencies[${CREATE_PACKAGE}]`;
  if (declared === undefined) {
    return {
      code: 'CREATE_PIN_MISSING',
      path,
      message: `${path}: ${CREATE_PACKAGE} is not declared (running ${CREATE_PACKAGE} ${running}); run rig-create packages upgrade --by <operator> to pin it`,
    };
  }
  if (declared !== running) {
    return {
      code: 'CREATE_PIN_MISMATCH',
      path,
      message: `${path}: declares ${JSON.stringify(declared)}, while the running ${CREATE_PACKAGE} is ${running}; run rig-create packages upgrade --by <operator> to move the pin, or run the project's declared ${CREATE_PACKAGE}`,
    };
  }
  return undefined;
}
const sha256Hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function compareVersions(a: string, b: string): number {
  const right = b.split('.').map(Number);
  for (const [index, value] of a.split('.').map(Number).entries()) {
    if (value !== right[index]) return value - right[index]!;
  }
  return 0;
}

function validLocalDependencies(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || Object.keys(item).length !== 2 || typeof item.name !== 'string' || !item.name.trim() || !sha256Hex(item.sha256) || seen.has(item.name)) {
      return false;
    }
    seen.add(item.name);
  }
  return true;
}

export function packageUpgradeFindings(project: JsonObject): Finding[] {
  const history = project.package_upgrades;
  if (history === undefined) return [];
  const bad = (path: string): Finding => ({ code: 'PACKAGE_UPGRADE_MALFORMED', path, message: `${path}: invalid package upgrade history; restore the writer's from/to versions, operator, timestamp, lock integrity, rehearsal metadata and any question_set or waypoint_config move (rig-create packages upgrade)` });
  if (!Array.isArray(history)) return [bad('package_upgrades')];
  const out: Finding[] = [];
  for (const [index, row] of history.entries()) {
    const path = `package_upgrades[${index}]`;
    const expectedNames: readonly string[] = isObject(row) && Array.isArray(row.packages) && row.packages.length === LEGACY_PACKAGE_NAMES.length
      ? LEGACY_PACKAGE_NAMES
      : PACKAGE_NAMES;
    if (!isObject(row) || typeof row.by !== 'string' || !row.by.trim() || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || !sha256Hex(row.lock_sha256) || !Array.isArray(row.packages) || row.packages.length !== expectedNames.length) {
      out.push(bad(path)); continue;
    }
    for (const [i, name] of expectedNames.entries()) {
      const pin = row.packages[i];
      if (!isObject(pin) || pin.name !== name || (pin.from !== null && !exactVersion(pin.from)) || !exactVersion(pin.to) || (typeof pin.from === 'string' && compareVersions(pin.from, pin.to) > 0)) out.push(bad(`${path}.packages[${i}]`));
    }
    if (row.rehearsal !== undefined && row.rehearsal !== true) out.push(bad(`${path}.rehearsal`));
    if (row.rehearsal === true) {
      if (!validLocalDependencies(row.local_dependencies)) out.push(bad(`${path}.local_dependencies`));
    } else if (row.local_dependencies !== undefined) {
      out.push(bad(`${path}.local_dependencies`));
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

export function packageUpgradeWarnings(project: JsonObject): Finding[] {
  const history = project.package_upgrades;
  if (!Array.isArray(history)) return [];
  const out: Finding[] = [];
  for (const [index, row] of history.entries()) {
    if (!isObject(row) || row.rehearsal !== true) continue;
    // A later published upgrade is the remedy; the rehearsal row then stays as history only.
    if (history.slice(index + 1).some(later => isObject(later) && later.rehearsal !== true)) continue;
    const path = `package_upgrades[${index}]`;
    out.push({
      code: 'PACKAGE_UPGRADE_REHEARSAL',
      path,
      message: `${path}: rehearsed package upgrade; a live project should rerun rig-create packages upgrade against the published release`,
    });
  }
  return out;
}
