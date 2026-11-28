import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { CURRENT_KINDS } from './current.ts';
import { CURRENT_DIRECTION_PATH } from './current-direction.ts';
import { CURRENT_SCENE_PATH } from './scene.ts';
import type { CommandResult } from './interview.ts';
import { acquireJobLock, tryJobDirectoryLock } from './job-outbox.ts';
import { CURRENT_LIVE_MANIFEST } from './job-publication.ts';
import { BASELINE_PATHS, baselineCommitMatches, commitProjectBaseline } from './project-step-commit.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';

const USAGE = 'history [<dir>] [--json]';
const SPEC_PATHS = { scene: CURRENT_SCENE_PATH, direction: CURRENT_DIRECTION_PATH } as const;
const BASELINE_USAGE = 'history baseline [<dir>] --by <operator>';
const LEGACY_PUBLISH = /^publish: current (?:parts|rig|motion|direction) [0-9a-f]{12}$/;
const quote = (arg: string): string => "'" + arg.replaceAll("'", "'\\''") + "'";

type Entry = {
  sha: string; short_sha: string; at: string; subject: string; back: string | null;
  command?: string; attribution?: 'unverified'; operator?: string; files?: string[];
};

type StepScope = { paths: Set<string>; command?: string; operator?: string; baselineAssets?: Map<string, string> };

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

const PROJECT_WRITERS = new Set([
  'input painting',
  'interview-answer',
  'interview-decision',
  'job open',
  'ledger add',
  'ledger retire',
  'owner-language set',
  'plan add',
  'plan bar-amend',
  'plan checkpoint-withdraw',
  'plan feedback',
  'plan remove',
  'plan replace',
  'plan revise',
  ...CURRENT_KINDS.map(kind => `record ${kind} adopt`),
  'restart',
]);
const BINDING_WRITERS = new Set([
  'amend',
  'checkpoint-evidence',
  'collection-binding',
  'comment close',
  'comment ingest',
  'correction',
  'derived add',
  'diff-classes',
  'input add',
  'intake-report',
  'interview-options',
  'plan propose',
  'signoff',
]);
const SHARED_PATHS = new Set<string>(BASELINE_PATHS);

function commandScope(command: string, subject: string): ((path: string) => boolean) | undefined {
  if (command === 'publish current') return LEGACY_PUBLISH.test(subject) ? path => path === CURRENT_LIVE_MANIFEST : undefined;
  const kind = CURRENT_KINDS.find(kind => command === `record ${kind}`);
  if (kind) return subject.startsWith(`${kind}: `)
    ? path => path === 'project.json' || path === '.gitignore' || path.startsWith(`outputs/${kind}/`)
    : undefined;
  const spec = Object.entries(SPEC_PATHS).find(([kind]) => command === `${kind} write`);
  if (spec) return subject.startsWith(`${spec[0]}: `) ? path => path === spec[1] : undefined;
  if (!subject.startsWith(`${command}: `)) return;
  if (command === 'history baseline') return () => true;
  if (command === 'packages upgrade') return path => SHARED_PATHS.has(path);
  if (PROJECT_WRITERS.has(command)) return path => path === 'project.json';
  if (BINDING_WRITERS.has(command)) return path => path === 'project.json' || (
    !SHARED_PATHS.has(path) && !['.gitignore', 'collection.json', CURRENT_LIVE_MANIFEST].includes(path)
    && !/^(?:scratch\/|node_modules\/|\.rig-create-)/.test(path));
}

/** Read the exact paths of new writes and the declared scope of older step messages. */
function stepScope(message: string): StepScope | undefined {
  const [subject, blank, writer, ...body] = message.trimEnd().split('\n');
  const stale = body.at(-2);
  const create = body.at(-1);
  if (!subject || subject.length > 72 || blank !== '' || !writer?.startsWith('writer: rig-create ')
    || !stale || !/^stale: (?:none|(?:parts|rig|motion|direction)(?:, (?:parts|rig|motion|direction))*)$/.test(stale)
    || !create || !/^create: @rig-c\/create \d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(create)) return;

  const command = /^command: ([a-z][a-z0-9]*(?:[ -][a-z0-9]+)*)$/.exec(body[0] ?? '')?.[1];
  const baseline = command === 'history baseline';
  const operator = baseline ? /^operator: (.+)$/.exec(body[1] ?? '')?.[1] : undefined;
  const kind = CURRENT_KINDS.find(kind => subject.startsWith(`${kind}: `)
    && writer.startsWith(`writer: rig-create record ${kind} `));
  const spec = Object.entries(SPEC_PATHS).find(([command]) =>
    subject.startsWith(`${command}: `) && writer.startsWith(`writer: rig-create ${command} write `))?.[1];
  const allows = command ? commandScope(command, subject) : undefined;
  if (command) {
    if (!allows) return;
    const identity = `writer: rig-create ${command}`;
    if (writer !== identity && !writer.startsWith(`${identity} `)) return;
    if (baseline && (!operator || subject !== 'history baseline: attribution unverified')) return;
  } else if (!kind && !spec) return;

  const paths = new Set<string>();
  const baselineAssets = baseline ? new Map<string, string>() : undefined;
  for (const line of body.slice(baseline ? 2 : command ? 1 : 0, -2)) {
    const path = changedPath(line);
    if (!path || posix.normalize(path) !== path || path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase())) || paths.has(path)) return;
    if (allows && !allows(path)) return;
    if (!command && (kind ? path !== 'project.json' && path !== '.gitignore' && !path.startsWith(`outputs/${kind}/`) : path !== spec)) return;
    if (baselineAssets && !SHARED_PATHS.has(path)) {
      const digest = / ([0-9a-f]{12})$/.exec(line)?.[1];
      if (!digest) return;
      baselineAssets.set(path, digest);
    }
    paths.add(path);
  }
  return paths.size ? { paths, command, operator, baselineAssets } : undefined;
}

function readHistory(dir: string, repo: string, head: string): Entry[] {
  const prefix = dir === repo ? '' : relative(repo, dir).split(sep).join('/') + '/';
  const fields = gitOutput(git(dir, 'log', '--full-history', '--no-merges', '--no-follow', '--no-notes', '--no-show-signature',
    '--no-decorate', '--no-color', '--encoding=UTF-8', '--abbrev=8', '-z', '--format=%H%x00%h%x00%cI%x00%P%x00%B',
    '--grep=^writer: rig-create ', '--grep=^publish: current ', head, '--', '.'), dir).split('\0');
  const entries: Entry[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const [sha, short_sha, time, parent, message] = fields.slice(i, i + 5) as [string, string, string, string, string];
    const subject = message.split('\n', 1)[0]!;
    const scope = stepScope(message);
    const legacyPublish = !scope && LEGACY_PUBLISH.test(message.trimEnd());
    if (!scope && !legacyPublish) continue;
    // The log limits candidate commits to this project. Check the whole commit for sibling changes.
    // Older messages could list unchanged files. New ones list the changed paths exactly.
    const changed = gitOutput(git(repo, 'diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '--ignore-submodules=none',
      '-r', '-z', sha), dir).split('\0').filter(Boolean);
    if (!changed.length || !changed.every(path => path.startsWith(prefix) && (!scope || scope.paths.has(path.slice(prefix.length))))) continue;
    if (scope?.command && changed.length !== scope.paths.size) continue;
    if (scope?.baselineAssets?.size) {
      try {
        if (!baselineCommitMatches(dir, sha, parent || undefined, scope.baselineAssets)) continue;
      } catch (error) {
        refuse('HISTORY_READ_FAILED', `project.json: ${String(error)}. Repair or fetch the project Git history and retry history.`);
      }
    }
    const at = new Date(time).toISOString().replace('.000Z', 'Z');
    const present = new Set(gitOutput(git(dir, 'ls-tree', '-z', '--name-only', sha, '--', 'specs', 'outputs/parts'), dir)
      .split('\0').filter(Boolean));
    const back = present.has('specs') && present.has('outputs/parts')
      ? `git -C ${quote(dir)} checkout ${short_sha} -- specs outputs/parts && rig-create next ${quote(dir)}`
      : null;
    entries.push({ sha, short_sha, at, subject, back,
      ...(scope?.command ? { command: scope.command } : {}),
      ...(legacyPublish || scope?.operator ? { attribution: 'unverified' as const } : {}),
      ...(scope?.operator ? { operator: scope.operator, files: changed.map(path => path.slice(prefix.length)) } : {}),
    });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

function historyBaseline(args: string[]): CommandResult {
  const [first, second, third, ...extra] = args;
  const target = first === '--by' ? third : first;
  const flag = first === '--by' ? first : second;
  const operator = first === '--by' ? second : third;
  if (target?.startsWith('-') || flag !== '--by' || !operator?.trim() || operator.startsWith('-') || extra.length) {
    refuse('HISTORY_USAGE', `history baseline: use rig-create ${BASELINE_USAGE}`, USAGE_EXIT);
  }
  const requested = resolve(target ?? process.cwd());
  if (!['project.json', 'collection.json'].some(path => existsSync(join(requested, path)))) {
    refuse('PROJECT_JSON_MISSING', `${requested}: name a project or collection to establish a baseline`);
  }
  const dir = realpathSync(requested);
  let releaseRecord: (() => void) | null = null;
  let releaseJob: (() => void) | null = null;
  let releasePlan: (() => void) | null = null;
  try {
    releaseRecord = tryJobDirectoryLock(join(dir, 'project.json.record.lock'));
    if (!releaseRecord) refuse('RECORD_BUSY', 'project.json: finish the active record writer before retrying history baseline');
    releaseJob = acquireJobLock(dir);
    releasePlan = tryJobDirectoryLock(join(dir, '.plan.lock'));
    if (!releasePlan) refuse('PLAN_WRITE_CONFLICT', 'project.json: finish the active plan writer before retrying history baseline');
    const paths = commitProjectBaseline(dir, operator);
    return { stdout: paths.length ? `history baseline: attribution unverified (${paths.join(', ')})` : 'history baseline: baseline paths are clean', exit: 0 };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse('HISTORY_BASELINE_FAILED', `project.json: ${error instanceof Error ? error.message : String(error)}; correct the Git error and review the baseline files before retrying history baseline`);
  } finally {
    try { releasePlan?.(); }
    finally {
      try { releaseJob?.(); }
      finally { releaseRecord?.(); }
    }
  }
}

export function historyCommand(args: string[]): CommandResult {
  if (args[0] === 'baseline') return historyBaseline(args.slice(1));
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
      : entries.map(({ short_sha, at, subject, back, attribution, operator, files }) => {
        const note = operator ? ` (by ${operator}, files ${files?.join(', ')})` : attribution ? ' (legacy publication, attribution unverified)' : '';
        const line = `${short_sha}  ${at}  ${subject}${note}`;
        return back ? `${line}\n  back: ${back}` : line;
      }).join('\n'),
    exit: 0,
  };
}
