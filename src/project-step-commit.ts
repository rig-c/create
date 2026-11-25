import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { existsSync, readFileSync } from './check-reads.ts';
import { sha256, type CurrentKind } from './current.ts';

type Step = 'scene' | Extract<CurrentKind, 'motion' | 'direction'>;
const quote = (arg: string): string => "'" + arg.replaceAll("'", "'\\''") + "'";

/** After a successful write, commit just its paths. Any Git failure leaves the saved data usable. */
export function commitProjectStep(
  dir: string, kind: Step, writer: string, path: string, trackedTree?: string, stale: string[] = [],
): string | undefined {
  const collection = basename(dirname(dir)) === 'members' ? dirname(dirname(dir)) : undefined;
  const repo = existsSync(join(dir, '.git')) ? dir
    : collection && existsSync(join(collection, 'collection.json')) && existsSync(join(collection, '.git')) ? collection : undefined;
  if (!repo) return 'rig-create: WARN PROJECT_NOT_IN_GIT: project.json: the project and its collection have no Git work tree; saved the files without a commit';
  const git = (args: string[]) => spawnSync('git', ['--literal-pathspecs', ...args], { cwd: dir, encoding: 'utf8' });
  const retry = (args: string[], why: string) =>
    `rig-create: WARN PROJECT_COMMIT_FAILED: project.json: ${why.trim() || 'Git exited unsuccessfully'}; retry: cd ${quote(dir)} && git --literal-pathspecs ${args.map(quote).join(' ')}`;
  const paths = [path];
  if (trackedTree) {
    const args = ['ls-files', '-z', '--', trackedTree];
    const tracked = git(args);
    if (tracked.status !== 0) return retry(args, tracked.error?.message ?? tracked.stderr);
    paths.push(...tracked.stdout.split('\0').filter(Boolean));
  } else {
    // A new spec needs an index entry before commit --only accepts its path.
    const args = ['add', '--intent-to-add', '--', path];
    const staged = git(args);
    if (staged.status !== 0) return retry(args, staged.error?.message ?? staged.stderr);
  }
  const diff = ['diff', 'HEAD', '--quiet', '--', ...paths];
  const changed = git(diff);
  if (changed.status === 0) return undefined;
  if (changed.status !== 1) return retry(diff, changed.error?.message ?? changed.stderr);
  let changes: string[];
  let spec: { name: string; version: string };
  try {
    changes = paths.map(file => {
      const full = join(dir, file);
      const hash = existsSync(full) ? sha256(readFileSync(full)).slice(0, 12) : 'removed';
      return `changed: ${file} ${hash}`;
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
