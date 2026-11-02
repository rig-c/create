/**
 * The top-level sections of a `@rig-c/parts` config, read from the installed
 * package — the pipeline's own list, not a hand copy.
 *
 * parts exports no section list (its package.json has no `exports`, and the
 * accept list in `src/config.ts` is a module-private `const TOP_KEYS`), so
 * this reads the installed source text. Two readings, in order:
 *
 * 1. `const TOP_KEYS = [...]` — what the loader accepts at the top level; an
 *    unknown key is refused by name there, so this list is the pipeline's
 *    truth about which sections exist.
 * 2. The fields of `export interface CharacterConfig { … }` — the typed shape,
 *    used only when (1) is not found.
 *
 * Neither found: `PARTS_SECTIONS_UNREADABLE`, so a parts release that moves
 * the list fails loudly instead of silently deriving no waypoints. A parts-side
 * export of the list is the connection point that retires this file's regexes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PARTS_PACKAGE = '@rig-c/parts';
const CONFIG_SOURCE = join('src', 'config.ts');

export interface PartsSections {
  readonly version: string;
  /** The package folder the sections were read from. */
  readonly dir: string;
  readonly read_from: 'TOP_KEYS' | 'CharacterConfig';
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

/** Where the installed package is looked for, in order: the project's own install, then create's. */
export function partsCandidates(projectDir: string): string[] {
  return [join(projectDir, 'node_modules', ...PARTS_PACKAGE.split('/')), join(OWN_NODE_MODULES, ...PARTS_PACKAGE.split('/'))];
}

export function locateParts(projectDir: string): string | null {
  for (const dir of partsCandidates(projectDir)) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, CONFIG_SOURCE))) return dir;
  }
  return null;
}

const TOP_KEYS_RE = /^\s*(?:export\s+)?const\s+TOP_KEYS\s*(?::[^=]+)?=\s*\[([^\]]*)\]/m;
const INTERFACE_RE = /export\s+interface\s+CharacterConfig\s*\{([\s\S]*?)\n\}/;

function quotedNames(list: string): string[] {
  return [...list.matchAll(/['"]([A-Za-z_][\w-]*)['"]/g)].map((m) => m[1] as string);
}

function interfaceFields(body: string): string[] {
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...withoutComments.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/gm)].map((m) => m[1] as string);
}

/** Reads the section list out of one parts source file. Exported for the test that plants a fake source. */
export function sectionsFromSource(source: string): { read_from: PartsSections['read_from']; sections: string[] } | null {
  const top = TOP_KEYS_RE.exec(source);
  if (top !== null) {
    const sections = quotedNames(top[1] as string);
    if (sections.length > 0) return { read_from: 'TOP_KEYS', sections };
  }
  const iface = INTERFACE_RE.exec(source);
  if (iface !== null) {
    const sections = interfaceFields(iface[1] as string);
    if (sections.length > 0) return { read_from: 'CharacterConfig', sections };
  }
  return null;
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
  const parsed = sectionsFromSource(readFileSync(join(dir, CONFIG_SOURCE), 'utf8'));
  if (parsed === null) {
    throw new PartsUnreadable(
      'PARTS_SECTIONS_UNREADABLE',
      `${PARTS_PACKAGE} ${version} at ${dir}: neither TOP_KEYS nor interface CharacterConfig found in ${CONFIG_SOURCE}; the section list cannot be derived`,
    );
  }
  return { version, dir, read_from: parsed.read_from, sections: parsed.sections };
}
