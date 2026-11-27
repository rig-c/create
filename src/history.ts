import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { CURRENT_KINDS } from './current.ts';
import { CURRENT_DIRECTION_PATH } from './current-direction.ts';
import { CURRENT_SCENE_PATH } from './scene.ts';
import type { CommandResult } from './interview.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';

const USAGE = 'history [<dir>] [--json]';
const SPEC_PATHS = { scene: CURRENT_SCENE_PATH, direction: CURRENT_DIRECTION_PATH } as const;
const RECORD_PATHS = ['project.json', ...CURRENT_KINDS.map(kind => `outputs/${kind}`)];
const quote = (arg: string): string => "'" + arg.replaceAll("'", "'\\''") + "'";

type Entry = { sha: string; short_sha: string; at: string; subject: string; back: string | null };

function git(dir: string, ...args: string[]) {
  return spawnSync('git', ['--literal-pathspecs', ...args], {
    cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
}

function gitOutput(result: ReturnType<typeof git>, dir: string): string {
  if (result.status !== 0) {
    const why = result.error?.message ?? result.stderr?.trim();
    refuse('HISTORY_READ_FAILED', `${join(dir, 'project.json')}: ${why || 'Git could not read the history'}. Repair or fetch the project Git history and retry history.`);
  }
  return result.stdout;
}

// Follow the writer's ownership rule. An arbitrary containing repository is not a project's history.
function projectRepo(dir: string): string | undefined {
  if (existsSync(join(dir, '.git'))) return dir;
  if (basename(dirname(dir)) !== 'members') return undefined;
  const collection = dirname(dirname(dir));
  if (existsSync(join(collection, 'collection.json')) && existsSync(join(collection, '.git'))) return collection;
}

function changedPath(line: string): string | undefined {
  const path = /^changed: (.+) (?:[0-9a-f]{12}|removed)$/.exec(line)?.[1];
  if (!path?.startsWith('"')) return path;
  try {
    const parsed: unknown = JSON.parse(path);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Match the scoped commit format used by the current record and spec writers. */
function stepPaths(message: string): Set<string> | undefined {
  const [subject, blank, writer, ...body] = message.trimEnd().split('\n');
  const stale = body.at(-2);
  const create = body.at(-1);
  if (!subject || subject.length > 72 || blank !== '' || !writer?.startsWith('writer: rig-create ')
    || !stale || !/^stale: (?:none|(?:parts|rig|motion|direction)(?:, (?:parts|rig|motion|direction))*)$/.test(stale)
    || !create || !/^create: @rig-c\/create \d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(create)) return;

  const kind = CURRENT_KINDS.find(kind => subject.startsWith(`${kind}: `)
    && writer.startsWith(`writer: rig-create record ${kind} `));
  const spec = Object.entries(SPEC_PATHS).find(([command]) =>
    subject.startsWith(`${command}: `) && writer.startsWith(`writer: rig-create ${command} write `))?.[1];
  if (!kind && !spec) return;

  const paths = new Set<string>();
  for (const line of body.slice(0, -2)) {
    const path = changedPath(line);
    if (!path || posix.normalize(path) !== path || paths.has(path)) return;
    if (kind ? path !== 'project.json' && path !== '.gitignore' && !path.startsWith(`outputs/${kind}/`) : path !== spec) return;
    paths.add(path);
  }
  return paths.size ? paths : undefined;
}

function readHistory(dir: string, repo: string, head: string): Entry[] {
  const prefix = dir === repo ? '' : relative(repo, dir).split(sep).join('/') + '/';
  const fields = gitOutput(git(dir, 'log', '--full-history', '--no-merges', '--no-follow', '--no-notes', '--no-show-signature',
    '--no-decorate', '--no-color', '--encoding=UTF-8', '--abbrev=8', '-z', '--format=%H%x00%h%x00%cI%x00%B',
    '--grep=^writer: rig-create ', head, '--', ...RECORD_PATHS, ...Object.values(SPEC_PATHS)), dir).split('\0');
  const entries: Entry[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [sha, short_sha, time, message] = fields.slice(i, i + 4) as [string, string, string, string];
    const paths = stepPaths(message);
    if (!paths) continue;
    // The writer lists all of its scoped paths, including unchanged files. Every actual change
    // must be in that scope, including changes outside this member that the log pathspec hides.
    const changed = gitOutput(git(repo, 'diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '--ignore-submodules=none',
      '-r', '-z', sha), dir).split('\0').filter(Boolean);
    if (!changed.length || !changed.every(path => path.startsWith(prefix) && paths.has(path.slice(prefix.length)))) continue;
    const at = new Date(time).toISOString().replace('.000Z', 'Z');
    const subject = message.split('\n', 1)[0]!;
    const present = new Set(gitOutput(git(dir, 'ls-tree', '-z', '--name-only', sha, '--', 'specs', 'outputs/parts'), dir)
      .split('\0').filter(Boolean));
    const back = present.has('specs') && present.has('outputs/parts')
      ? `git -C ${quote(dir)} checkout ${short_sha} -- specs outputs/parts && rig-create next ${quote(dir)}`
      : null;
    entries.push({ sha, short_sha, at, subject, back });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

export function historyCommand(args: string[]): CommandResult {
  const positional = args.filter(arg => arg !== '--json');
  if (positional.length > 1 || positional.some(arg => arg.startsWith('-'))) {
    refuse('HISTORY_USAGE', `history: use rig-create ${USAGE}`, USAGE_EXIT);
  }
  const requested = resolve(positional[0] ?? process.cwd());
  const empty = (why: string): CommandResult => ({
    stdout: '', exit: 0,
    stderr: `rig-create: WARN PROJECT_NOT_IN_GIT: ${join(requested, 'project.json')}: ${why}. Use a project or collection work tree with Create step-data commits.`,
  });
  if (!existsSync(requested)) return empty('no project work tree');
  const dir = realpathSync(requested);
  const repo = projectRepo(dir);
  if (!repo) return empty('no project or collection work tree');
  const root = git(dir, 'rev-parse', '--show-toplevel');
  if (root.error) gitOutput(root, dir);
  if (root.status !== 0 || realpathSync(root.stdout.replace(/\n$/, '')) !== repo) {
    return empty('no project or collection work tree');
  }
  const head = git(dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  if (head.status === 1) return empty('no Create step-data commits at HEAD');
  const entries = readHistory(dir, repo, gitOutput(head, dir).trim());
  if (entries.length === 0) return empty('no Create step-data commits at HEAD');
  return {
    stdout: args.includes('--json') ? JSON.stringify(entries, null, 2)
      : entries.map(({ short_sha, at, subject, back }) =>
        back ? `${short_sha}  ${at}  ${subject}\n  back: ${back}` : `${short_sha}  ${at}  ${subject}`).join('\n'),
    exit: 0,
  };
}
