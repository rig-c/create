/**
 * The top-level sections of a `@rig-c/parts` config, taken from the installed
 * package's own export — the pipeline's list, not a hand copy.
 *
 * parts exports the list as `CONFIG_SECTIONS` from `src/config.ts` (from
 * 2.3.0; its package.json has no `exports` map, so the subpath is importable).
 * It is loaded at run time from the parts found for the project being checked
 * (`locateParts`), not imported from this repository's own dependency, because
 * `interview --check` reports the sections of the version installed there.
 * There is no static import either, not even a type-only one: it would make
 * this repository's typecheck compile the parts and core sources, which do not
 * typecheck outside their own repositories. A test loads the export from this
 * repository's pinned install instead.
 *
 * Bun's `require` loads that ES module synchronously, so the check stays
 * synchronous. A parts with no such export (older than 2.3.0, or a release that
 * moves it) is `PARTS_SECTIONS_UNREADABLE`, so it fails loudly instead of
 * silently deriving no waypoints.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

export const PARTS_PACKAGE = '@rig-c/parts';
const CONFIG_SOURCE = join('src', 'config.ts');
const SECTIONS_EXPORT = 'CONFIG_SECTIONS';

/** The export's shape: section names, in parts' order. */
type Sections = readonly string[];

export interface PartsSections {
  readonly version: string;
  /** The package folder the sections were read from. */
  readonly dir: string;
  /** The export the list was taken from. */
  readonly read_from: typeof SECTIONS_EXPORT;
  readonly sections: readonly string[];
}

export class PartsUnreadable extends Error {
  readonly code: 'PARTS_NOT_INSTALLED' | 'PARTS_SECTIONS_UNREADABLE';
  constructor(code: 'PARTS_NOT_INSTALLED' | 'PARTS_SECTIONS_UNREADABLE', message: string) {
    super(message);
    this.name = 'PartsUnreadable';
    this.code = code;
  }
}

/** The create repository's own install, used when a project has none (running the check in this repo, or before `bun install` in a project). */
export const OWN_NODE_MODULES = join(import.meta.dir, '..', 'node_modules');

/**
 * Where the installed package is looked for, in order: the project's own
 * install, the collection's for a member (`<collection>/members/<name>/`, which
 * installs nothing itself: docs/COLLECTIONS.md), then create's.
 */
export function partsCandidates(projectDir: string): string[] {
  const pkg = PARTS_PACKAGE.split('/');
  const collection = basename(dirname(projectDir)) === 'members' ? [join(dirname(dirname(projectDir)), 'node_modules', ...pkg)] : [];
  return [join(projectDir, 'node_modules', ...pkg), ...collection, join(OWN_NODE_MODULES, ...pkg)];
}

export function locateParts(projectDir: string): string | null {
  for (const dir of partsCandidates(projectDir)) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, CONFIG_SOURCE))) return dir;
  }
  return null;
}

const load = createRequire(import.meta.url);

function isSections(v: unknown): v is Sections {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string');
}

export function readPartsSections(projectDir: string): PartsSections {
  const dir = locateParts(projectDir);
  if (dir === null) {
    throw new PartsUnreadable(
      'PARTS_NOT_INSTALLED',
      `${PARTS_PACKAGE} is not installed (looked in ${partsCandidates(projectDir).join(', ')}); run bun install in the project`,
    );
  }
  const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const version =
    pkg !== null && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string' ? pkg.version : 'unknown';
  const unreadable = (why: string): PartsUnreadable =>
    new PartsUnreadable('PARTS_SECTIONS_UNREADABLE', `${PARTS_PACKAGE} ${version} at ${dir}: ${why}; the section list cannot be derived (it is exported from 2.3.0)`);
  let mod: unknown;
  try {
    mod = load(join(dir, CONFIG_SOURCE));
  } catch (e) {
    throw unreadable(`${CONFIG_SOURCE} does not load (${e instanceof Error ? e.message : String(e)})`);
  }
  const sections = mod !== null && typeof mod === 'object' && SECTIONS_EXPORT in mod ? (mod as Record<string, unknown>)[SECTIONS_EXPORT] : undefined;
  if (!isSections(sections)) throw unreadable(`${CONFIG_SOURCE} has no ${SECTIONS_EXPORT} export holding section names`);
  return { version, dir, read_from: SECTIONS_EXPORT, sections: [...sections] };
}
