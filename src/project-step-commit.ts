import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, openSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { existsSync, lstatSync, readFileSync } from './check-reads.ts';
import type { CurrentKind } from './current.ts';

type Step = 'scene' | CurrentKind;
export const OUTPUTS_IGNORE = ['/outputs/*', '!/outputs/parts/'] as const;
export const GITIGNORE_MIGRATION_LINE = `gitignore: /outputs/ -> ${OUTPUTS_IGNORE.join(' ')}`;
const quote = (arg: string): string => "'" + arg.replaceAll("'", "'\\''") + "'";
const pathsFrom = (stdout: string): string[] => stdout.split('\0').filter(Boolean);

type GitignoreMigration = { changed: true; restore: () => void } | { changed: false; warning?: string; failed?: true };

function replaceGitignore(path: string, original: Stats, bytes: Buffer): Stats {
  const temp = join(dirname(path), `.gitignore-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    chmodSync(temp, original.mode & 0o777);
    const prepared = lstatSync(temp);
    const latest = lstatSync(path);
    if (latest.dev !== original.dev || latest.ino !== original.ino || latest.mtimeMs !== original.mtimeMs || latest.size !== original.size) {
      throw new Error('changed while record was writing');
    }
    renameSync(temp, path);
    return prepared;
  } finally { rmSync(temp, { force: true }); }
}

/** Rewrite only exact legacy lines, preserving the original bytes and each line's separator. */
export function migrateProjectGitignore(dir: string): GitignoreMigration {
  const path = join(dir, '.gitignore');
  const absent: GitignoreMigration = { changed: false, warning: `rig-create: WARN GITIGNORE_PATTERN_ABSENT: .gitignore: no exact /outputs/ line in a regular file; add ${OUTPUTS_IGNORE.join(' and ')} if needed` };
  try {
    const original = lstatSync(path, { throwIfNoEntry: false });
    if (!original?.isFile()) return absent;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== original.dev || opened.ino !== original.ino) return absent;
      bytes = readFileSync(fd);
    }
    finally { closeSync(fd); }
    const source = bytes.toString('latin1');
    const migrated = source.replace(/(?<=^|\n)\/outputs\/(?=(\r?\n|$))/g, (_line: string, ending: string, offset: number) => {
      const separator = ending || (source.slice(offset - 2, offset) === '\r\n' ? '\r\n' : '\n');
      return OUTPUTS_IGNORE.join(separator);
    });
    if (source === migrated) {
      const current = /(?:^|\n)\/outputs\/\*\r?\n!\/outputs\/parts\/(?=\r?\n|$)/.test(source);
      return current ? { changed: false } : absent;
    }
    const prepared = replaceGitignore(path, original, Buffer.from(migrated, 'latin1'));
    return { changed: true, restore: () => { replaceGitignore(path, prepared, bytes); } };
  } catch (error) {
    return { changed: false, failed: true, warning: `rig-create: WARN PROJECT_COMMIT_FAILED: .gitignore: ${String(error)}; restore a writable .gitignore and rerun record to commit` };
  }
}

interface RecordCommitOptions {
  migratedGitignore?: boolean;
  partsFiles?: readonly string[];
}

/** After a successful write, commit just its paths. Any Git failure leaves the saved data usable. */
export function commitProjectStep(
  dir: string, kind: Step, writer: string, path: string, trackedTree?: string, stale: string[] = [], options: RecordCommitOptions = {},
): string | undefined {
  const collection = basename(dirname(dir)) === 'members' ? dirname(dirname(dir)) : undefined;
  const repo = existsSync(join(dir, '.git')) ? dir
    : collection && existsSync(join(collection, 'collection.json')) && existsSync(join(collection, '.git')) ? collection : undefined;
  if (!repo) return 'rig-create: WARN PROJECT_NOT_IN_GIT: project.json: the project and its collection have no Git work tree; saved the files without a commit';
  const git = (args: string[]) => spawnSync('git', ['--literal-pathspecs', ...args], { cwd: dir, encoding: 'utf8' });
  const retry = (args: string[], why: string) =>
    `rig-create: WARN PROJECT_COMMIT_FAILED: project.json: ${why.trim() || 'Git exited unsuccessfully'}; retry: cd ${quote(dir)} && git --literal-pathspecs ${args.map(quote).join(' ')}`;
  const written = [path, ...(options.migratedGitignore ? ['.gitignore'] : [])];
  const indexCandidates = [...written];
  if (trackedTree && options.partsFiles) {
    const args = ['ls-files', '--others', '--exclude-standard', '-z', '--', trackedTree];
    const untracked = git(args);
    if (untracked.status !== 0) return retry(args, untracked.error?.message ?? untracked.stderr);
    const bound = new Set(options.partsFiles);
    indexCandidates.push(...pathsFrom(untracked.stdout).filter(file => bound.has(file)));
  }
  // A new file needs an index entry before commit --only accepts its path.
  const add = ['add', '--intent-to-add', '--', ...indexCandidates];
  const staged = git(add);
  if (staged.status !== 0) return retry(add, staged.error?.message ?? staged.stderr);

  const diff = ['diff', '--name-only', '--no-renames', '--relative', '-z', 'HEAD', '--', ...written, ...(trackedTree ? [trackedTree] : [])];
  const changed = git(diff);
  if (changed.status !== 0) return retry(diff, changed.error?.message ?? changed.stderr);
  const paths = pathsFrom(changed.stdout);
  if (!paths.length) return undefined;
  let changes: string[];
  let spec: { name: string; version: string };
  try {
    changes = paths.map(file => {
      const full = join(dir, file);
      const hash = lstatSync(full, { throwIfNoEntry: false })?.isFile()
        ? createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 12)
        : 'removed';
      return `changed: ${/[\r\n]/.test(file) ? JSON.stringify(file) : file} ${hash}`;
    });
    spec = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
  } catch (error) {
    return retry(['commit', '--only', '-m', `${kind}: save step data`, '--', ...paths], String(error));
  }
  const subject = trackedTree ? `${kind}: record current output` : `${kind}: write ${path}`;
  const message = [subject, '', `writer: rig-create ${writer}`, ...changes, `stale: ${stale.join(', ') || 'none'}`, `create: ${spec.name} ${spec.version}`].join('\n');
  const args = ['commit', '--only', '-m', message, '--', ...paths];
  const commit = git(args);
  if (commit.status !== 0) return retry(args, commit.error?.message ?? commit.stderr ?? commit.stdout);
  git(['gc', '--auto']);
}
