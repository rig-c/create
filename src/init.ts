import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync, readFileSync, readdirSync, statSync } from './check-reads.ts';
import { basename, dirname, join, resolve } from 'node:path';

import { writeAgentGuide } from './agent-guide.ts';
import { PINNED_PACKAGES } from './pins.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { CHOICE_ORDER_SPEC } from './stages.ts';
import { readTemplate, type JsonObject } from './templates.ts';
import { JOB_BINDING_FILE, JOB_OUTBOX_DIRECTORY } from './job-outbox.ts';

export const INTERVIEW_DOC_URL = 'https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md';

/** Folders kept in git while empty (docs/PROJECT.md: tracked). Kept by a .gitkeep. */
export const TRACKED_EMPTY_DIRS = ['inputs/references', 'evidence'] as const;
/** Folders git ignores (docs/PROJECT.md: not tracked). Created empty. */
export const IGNORED_DIRS = ['derived', 'outputs', 'scratch'] as const;

export const GITIGNORE = ['/derived/', '/outputs/', '/scratch/', 'node_modules/', `/${JOB_BINDING_FILE}`, `/${JOB_OUTBOX_DIRECTORY}/`, ''].join('\n');

/** Used for the first commit only, and only when git has no identity configured. */
export const FALLBACK_IDENTITY = { name: 'rig-create', email: 'rig-create@localhost' } as const;

export interface InitOptions {
  install: boolean;
  /** The instant the record's adoption dates carry (ms since the epoch). */
  now: number;
  /** The painting the project is for, registered as its first input; with it init refuses a second project for the same artwork. */
  painting?: PaintingOption;
}

export interface SameArtworkOptions {
  /** Where sibling projects live; default the new project's parent folder. */
  projectsRoot?: string | undefined;
  /** A file saying why this is a new project for an artwork another project already binds. */
  sameArtworkReason?: string | undefined;
  /** The input index being registered; default 0. */
  index?: number | undefined;
}

export interface PaintingOption extends SameArtworkOptions {
  file: string;
  origin: string;
}

interface Artwork { readonly path: string; readonly bytes: Buffer; readonly entry: JsonObject; readonly same: JsonObject | null }

/**
 * One artwork is one project (create#285, create#291): refuse before writing anything when a
 * project directly under the projects root binds an input with the painting's sha256, unless a reason is given.
 */
export function sameArtworkFor(dir: string, name: string, sha256: string, now: number, options: SameArtworkOptions = {}): JsonObject | null {
  const root = resolve(options.projectsRoot ?? dirname(dir));
  let siblings: string[] = [];
  try { siblings = readdirSync(root).sort(); } catch {
    if (options.projectsRoot !== undefined) refuse('INIT_ARTWORK_USAGE', `--projects-root ${root}: not a readable folder`, USAGE_EXIT);
  }
  const matches = siblings.filter(sibling => {
    if (resolve(root, sibling) === dir) return false;
    let record: unknown;
    try { record = JSON.parse(readFileSync(join(root, sibling, 'project.json'), 'utf8')); } catch { return false; }
    const inputs = record !== null && typeof record === 'object' && 'inputs' in record && Array.isArray(record.inputs) ? record.inputs as unknown[] : [];
    return inputs.some(input => input !== null && typeof input === 'object' && (input as JsonObject).sha256 === sha256);
  });
  if (matches.length > 0 && options.sameArtworkReason === undefined) {
    refuse('INIT_ARTWORK_EXISTS', `inputs[${options.index ?? 0}]: ${name} (sha256 ${sha256}) is already an input of ${matches.join(', ')} under ${root}; one artwork is one project, so record a redo, a new source or a new tool as a version there, or give --same-artwork-reason <file> for a different rig kind`);
  }
  if (options.sameArtworkReason !== undefined) {
    if (matches.length === 0) refuse('INIT_ARTWORK_USAGE', `--same-artwork-reason: no project under ${root} binds ${name}; drop the reason`, USAGE_EXIT);
    const reason = readVerbatim(options.sameArtworkReason).trim();
    if (!reason) refuse('INIT_ARTWORK_USAGE', '--same-artwork-reason: the reason file is empty; say why this artwork needs a second project', USAGE_EXIT);
    return { reason, at: new Date(now).toISOString(), projects: matches };
  }
  return null;
}

function artworkFor(dir: string, painting: PaintingOption, now: number): Artwork {
  let bytes: Buffer;
  try {
    if (!statSync(painting.file).isFile()) throw new Error('not a file');
    bytes = readFileSync(painting.file);
  } catch { refuse('INIT_ARTWORK_USAGE', `--painting ${painting.file}: not a readable file`, USAGE_EXIT); }
  const name = basename(painting.file);
  if (name.startsWith('.') || name === 'references') refuse('INIT_ARTWORK_USAGE', `--painting ${painting.file}: name the painting file so it can sit in inputs/`, USAGE_EXIT);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const same = sameArtworkFor(dir, name, sha256, now, painting);
  const path = `inputs/${name}`;
  return { path, bytes, same, entry: { path, sha256, bytes: bytes.length, origin: painting.origin, at: new Date(now).toISOString() } };
}

export interface InitResult {
  dir: string;
  name: string;
  installed: boolean;
  /** Why `bun install` failed, when it did; the project is still created and committed without bun.lock. */
  installError: string | null;
  committed: string[];
  commit: string;
  fallbackIdentity: boolean;
}

/** A package name npm accepts, from a folder name. */
export function packageNameFor(folder: string): string {
  const name = folder
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 214);
  return name === '' ? 'rig-project' : name;
}

export function run(cmd: string[], cwd: string): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return { ok: proc.exitCode === 0, out };
}

export function checkTarget(dir: string): void {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) {
    refuse('INIT_NOT_A_DIRECTORY', `${dir} exists and is not a directory`);
  }
  const entries = readdirSync(dir).sort();
  if (entries.length > 0) {
    const shown = entries.slice(0, 5).join(', ') + (entries.length > 5 ? ', …' : '');
    refuse('INIT_DIR_NOT_EMPTY', `${dir} is not empty (${entries.length} entries: ${shown})`);
  }
}

/** The record init writes, and restart starts from: the template with its contracts adopted at `now`. */
export function freshProjectRecord(name: string, now: number): JsonObject {
  const record = readTemplate('project.json');
  record.name = name;
  const at = new Date(now).toISOString();
  record.corrections_contract = { schema: 'rig-create/corrections@1', adopted_at: at };
  record.corrections = [];
  const interview = record.interview as JsonObject;
  interview.order = { spec: CHOICE_ORDER_SPEC, adopted_at: at, choices_adopted_at: at };
  return record;
}

export function writePackageJson(dir: string, name: string): void {
  const pkg = {
    name: packageNameFor(name),
    private: true,
    type: 'module',
    dependencies: { ...PINNED_PACKAGES },
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

export function hasGitIdentity(dir: string): boolean {
  return run(['git', 'config', 'user.name'], dir).ok && run(['git', 'config', 'user.email'], dir).ok;
}

/**
 * Creates a project in `target`: the layout of docs/PROJECT.md, project.json
 * from the template, .gitignore, a package.json pinning the rig-c packages,
 * the install (unless skipped), the agent guide, and a first commit holding
 * exactly the files written here. Refuses before writing anything if the
 * target exists and is not an empty directory.
 */
export function initProject(target: string, options: InitOptions): InitResult {
  const dir = resolve(target);
  checkTarget(dir);
  const name = basename(dir);
  const artwork = options.painting === undefined ? null : artworkFor(dir, options.painting, options.now);

  mkdirSync(dir, { recursive: true });
  const written: string[] = [];

  const record = freshProjectRecord(name, options.now);
  if (artwork !== null) {
    mkdirSync(join(dir, 'inputs'), { recursive: true });
    writeFileSync(join(dir, artwork.path), artwork.bytes);
    written.push(artwork.path);
    record.inputs = [artwork.entry];
    if (artwork.same !== null) record.same_artwork = artwork.same;
  }
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(record, null, 2)}\n`);
  written.push('project.json');
  writePackageJson(dir, name);
  written.push('package.json');
  writeFileSync(join(dir, '.gitignore'), GITIGNORE);
  written.push('.gitignore');

  for (const sub of TRACKED_EMPTY_DIRS) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, '.gitkeep'), '');
    written.push(`${sub}/.gitkeep`);
  }
  for (const sub of IGNORED_DIRS) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  written.push(...writeAgentGuide(dir));

  // An install failure does not stop init: the project and its first commit
  // are still made (without bun.lock), so the recovery is to run `bun install`
  // in the project and commit bun.lock — never to delete it and start again.
  let installError: string | null = null;
  if (options.install) {
    const install = run([process.execPath, 'install'], dir);
    if (install.ok) written.push('bun.lock');
    else installError = install.out;
  }

  const gitInit = run(['git', 'init', '-q'], dir);
  if (!gitInit.ok) refuse('INIT_GIT_FAILED', `git init failed in ${dir}\n${gitInit.out}`);

  const add = run(['git', 'add', '--', ...written], dir);
  if (!add.ok) refuse('INIT_GIT_FAILED', `git add failed in ${dir}\n${add.out}`);

  const fallbackIdentity = !hasGitIdentity(dir);
  const identity = fallbackIdentity
    ? ['-c', `user.name=${FALLBACK_IDENTITY.name}`, '-c', `user.email=${FALLBACK_IDENTITY.email}`]
    : [];
  const commit = run(['git', ...identity, 'commit', '-q', '-m', `Create project ${name}`], dir);
  if (!commit.ok) refuse('INIT_GIT_FAILED', `git commit failed in ${dir}\n${commit.out}`);

  const head = run(['git', 'rev-parse', '--short', 'HEAD'], dir);
  return {
    dir,
    name,
    installed: options.install && installError === null,
    installError,
    committed: written,
    commit: head.out,
    fallbackIdentity,
  };
}

/** What init prints on success. */
export function describeInit(result: InitResult): string {
  const pins = Object.entries(PINNED_PACKAGES)
    .map(([pkg, version]) => `${pkg} ${version}`)
    .join(', ');
  const lines = [
    `Created project ${result.name} at ${result.dir}`,
    result.installed
      ? `  installed ${pins} (bun.lock written)`
      : result.installError === null
        ? `  pinned ${pins}; install skipped (--no-install)`
        : `  pinned ${pins}; bun install FAILED, so bun.lock is not in the first commit`,
    `  first commit ${result.commit}: ${result.committed.join(', ')}`,
  ];
  if (result.fallbackIdentity) {
    lines.push(
      `  no git identity is configured; the first commit is authored as "${FALLBACK_IDENTITY.name} <${FALLBACK_IDENTITY.email}>" (that commit only, nothing written to git config)`,
    );
  }
  lines.push('', 'Next:');
  let step = 1;
  if (!result.installed) {
    lines.push(`  ${step++}. cd ${result.dir} && bun install, then commit bun.lock`);
  }
  const painting = result.committed.find(path => path.startsWith('inputs/') && !path.endsWith('.gitkeep'));
  lines.push(painting === undefined
    ? `  ${step++}. put the painting in inputs/, then start the interview: ${INTERVIEW_DOC_URL}`
    : `  ${step++}. ${painting} is registered; start the interview: ${INTERVIEW_DOC_URL}`);
  return lines.join('\n');
}
