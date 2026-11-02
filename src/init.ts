import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { writeAgentGuide } from './agent-guide.ts';
import { PINNED_PACKAGES } from './pins.ts';
import { refuse } from './refusal.ts';
import { readTemplate } from './templates.ts';

export const INTERVIEW_DOC_URL = 'https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md';

/** Folders kept in git while empty (docs/PROJECT.md: tracked). Kept by a .gitkeep. */
export const TRACKED_EMPTY_DIRS = ['inputs/references', 'evidence'] as const;
/** Folders git ignores (docs/PROJECT.md: not tracked). Created empty. */
export const IGNORED_DIRS = ['derived', 'outputs', 'scratch'] as const;

export const GITIGNORE = ['/derived/', '/outputs/', '/scratch/', 'node_modules/', ''].join('\n');

/** Used for the first commit only, and only when git has no identity configured. */
export const FALLBACK_IDENTITY = { name: 'rig-create', email: 'rig-create@localhost' } as const;

export interface InitOptions {
  install: boolean;
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

function run(cmd: string[], cwd: string): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return { ok: proc.exitCode === 0, out };
}

function checkTarget(dir: string): void {
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

function writeProjectJson(dir: string, name: string): void {
  const record = readTemplate('project.json');
  record.name = name;
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(record, null, 2)}\n`);
}

function writePackageJson(dir: string, name: string): void {
  const pkg = {
    name: packageNameFor(name),
    private: true,
    type: 'module',
    dependencies: { ...PINNED_PACKAGES },
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

function hasGitIdentity(dir: string): boolean {
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

  mkdirSync(dir, { recursive: true });
  const written: string[] = [];

  writeProjectJson(dir, name);
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
  lines.push(`  ${step++}. put the painting in inputs/, then start the interview: ${INTERVIEW_DOC_URL}`);
  return lines.join('\n');
}
