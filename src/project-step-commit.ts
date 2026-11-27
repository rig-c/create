import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, openSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { existsSync, lstatSync, readFileSync } from './check-reads.ts';
import type { CurrentKind } from './current.ts';

type Step = 'scene' | CurrentKind;
export const OUTPUTS_IGNORE = ['/outputs/*', '!/outputs/parts/'] as const;
export const GITIGNORE_MIGRATION_LINE = `gitignore: /outputs/ -> ${OUTPUTS_IGNORE.join(' ')}`;
const MAX_SUBJECT = 72;
const UPSTREAM_ORDER = ['motion', 'rig', 'parts'] as const;
const UPSTREAM_PRIMARY: Record<(typeof UPSTREAM_ORDER)[number], readonly string[]> = {
  motion: ['outputs/motion', 'outputs/motion/frames.json'],
  rig: ['outputs/rig', 'outputs/rig/check/build/skeleton.model.json'],
  parts: ['outputs/parts', 'outputs/parts/rig/parts.json'],
};
const quote = (arg: string): string => "'" + arg.replaceAll("'", "'\\''") + "'";
const pathsFrom = (stdout: string): string[] => stdout.split('\0').filter(Boolean);
const cleanToken = (text: string): string => text.replace(/[\r\n\t\0]+/g, ' ').replace(/\s+/g, ' ').trim();

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

export interface StepBinding {
  path: string;
  sha256: string;
}

export interface ChangedStepPath {
  status: string;
  path: string;
}

export interface RecordCommitOptions {
  migratedGitignore?: boolean;
  partsFiles?: readonly string[];
  filesSha256?: string;
  builtFrom?: readonly StepBinding[];
  previousBuiltFrom?: readonly StepBinding[];
  inPlace?: boolean;
}

function clampSubject(text: string, max = MAX_SUBJECT): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, Math.max(0, max));
  let cut = text.slice(0, max - 3);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}...`;
}

function joinWithinBudget(prefix: string, items: readonly string[], max = MAX_SUBJECT): string {
  const cleaned = items.map(cleanToken).filter(Boolean);
  if (!cleaned.length) return clampSubject(prefix.trimEnd(), max);
  const full = `${prefix}${cleaned.join(', ')}`;
  if (full.length <= max) return full;
  for (let count = cleaned.length - 1; count >= 1; count--) {
    const more = ` (+${cleaned.length - count})`;
    const candidate = `${prefix}${cleaned.slice(0, count).join(', ')}${more}`;
    if (candidate.length <= max) return candidate;
  }
  const more = cleaned.length > 1 ? ` (+${cleaned.length - 1})` : '';
  return `${prefix}${clampSubject(cleaned[0]!, max - prefix.length - more.length)}${more}`;
}

function formatActionGroups(prefix: string, entries: readonly { status: string; name: string }[]): string {
  const buckets = { add: new Set<string>(), update: new Set<string>(), remove: new Set<string>() };
  for (const { status, name } of entries) {
    const cleaned = cleanToken(name);
    if (!cleaned) continue;
    if (status === 'A') buckets.add.add(cleaned);
    else if (status === 'D') buckets.remove.add(cleaned);
    else buckets.update.add(cleaned);
  }
  const groups = (['add', 'update', 'remove'] as const)
    .map(verb => [verb, [...buckets[verb]].sort()] as const)
    .filter(([, names]) => names.length > 0);
  if (groups.length === 1) {
    const [verb, names] = groups[0]!;
    return joinWithinBudget(`${prefix}${verb} `, names);
  }
  const full = `${prefix}${groups.map(([verb, names]) => `${verb} ${names.join(', ')}`).join('; ')}`;
  if (full.length <= MAX_SUBJECT) return full;
  const compact = `${prefix}${groups.map(([verb, names]) =>
    `${verb} ${names[0]!}${names.length > 1 ? ` (+${names.length - 1})` : ''}`).join('; ')}`;
  return clampSubject(compact, MAX_SUBJECT);
}

function isPartsProvenance(path: string): boolean {
  const base = posix.basename(path);
  return base === 'run.json' || base.endsWith('-run.json') || path === 'outputs/parts/check/parts-check.json';
}

interface UpstreamToken {
  key: string;
  label: string;
  digest: string;
}

function upstreamTokens(builtFrom: readonly StepBinding[]): UpstreamToken[] {
  const tokens: UpstreamToken[] = [];
  const used = new Set<string>();
  for (const up of UPSTREAM_ORDER) {
    const root = `outputs/${up}`;
    const group = builtFrom
      .filter(entry => entry.path === root || entry.path.startsWith(`${root}/`))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (!group.length) continue;
    for (const entry of group) used.add(entry.path);
    const rep = UPSTREAM_PRIMARY[up].map(primary => group.find(entry => entry.path === primary)).find(Boolean) ?? group[0]!;
    tokens.push({
      key: `kind:${up}`,
      label: `${up} ${rep.sha256.slice(0, 8)}`,
      digest: group.map(entry => `${entry.path}:${entry.sha256}`).join('|'),
    });
  }
  const rest = builtFrom.filter(entry => !used.has(entry.path)).slice().sort((a, b) => {
    const rank = (path: string): number =>
      path === 'specs/direction/direction.json' ? 0
        : path === 'specs/direction/scene.json' ? 1
          : path.startsWith('specs/') ? 2 : 3;
    return rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  const strip = (path: string): string => path.replace(/^(?:specs\/(?:rig|direction|motion)\/|specs\/|inputs\/|derived\/)/, '');
  const counts = new Map<string, number>();
  for (const entry of rest) {
    const short = strip(entry.path);
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  for (const entry of rest) {
    const short = strip(entry.path);
    const display = (counts.get(short) ?? 0) > 1 ? entry.path : short;
    tokens.push({
      key: `file:${entry.path}`,
      label: `${display} ${entry.sha256.slice(0, 8)}`,
      digest: entry.sha256,
    });
  }
  return tokens;
}

/** Derive a `<= 72`-character `<kind>: <what changed>` commit subject from changed paths and upstream hashes (§4.2). */
export function stepCommitSubject(
  kind: Step,
  path: string,
  trackedTree: string | undefined,
  changed: readonly ChangedStepPath[],
  options: RecordCommitOptions = {},
): string {
  const prefix = `${kind}: `;
  if (!trackedTree) return clampSubject(`${prefix}write ${cleanToken(path)}`);

  const treeChanges = changed.filter(entry => entry.path.startsWith(`${trackedTree}/`));
  if (kind === 'parts' && treeChanges.length) {
    const partImages = treeChanges.flatMap(entry => {
      const match = /^outputs\/parts\/(?:rig\/)?parts\/([^/]+)\.png$/.exec(entry.path);
      return match ? [{ status: entry.status, name: match[1]! }] : [];
    });
    if (partImages.length) return formatActionGroups(prefix, partImages);
    const product = treeChanges.filter(entry => !isPartsProvenance(entry.path));
    const chosen = product.length ? product : treeChanges;
    return formatActionGroups(prefix, chosen.map(entry => ({
      status: entry.status,
      name: entry.path.slice(`${trackedTree}/`.length).replace(/^rig\//, ''),
    })));
  }

  const tokens = upstreamTokens(options.builtFrom ?? []);
  if (tokens.length) {
    if (!options.previousBuiltFrom) {
      const verb = options.inPlace ? 'rebind' : 'build';
      return joinWithinBudget(`${prefix}${verb} from `, tokens.map(token => token.label));
    }
    const prior = new Map(upstreamTokens(options.previousBuiltFrom).map(token => [token.key, token.digest]));
    const updated = tokens.filter(token => prior.get(token.key) !== token.digest);
    const verb = options.inPlace ? 'rebind' : 'rebuild';
    if (updated.length) return joinWithinBudget(`${prefix}${verb} from `, updated.map(token => token.label));
    const tag = options.filesSha256 ? ` ${options.filesSha256.slice(0, 8)}` : '';
    return joinWithinBudget(`${prefix}${verb}${tag} from `, tokens.map(token => token.label));
  }

  if (treeChanges.length) {
    return formatActionGroups(prefix, treeChanges.map(entry => ({
      status: entry.status,
      name: entry.path.slice(`${trackedTree}/`.length),
    })));
  }
  if (options.filesSha256) {
    const verb = options.inPlace ? 'rebind' : options.previousBuiltFrom ? 'rebuild' : 'record';
    return clampSubject(`${prefix}${verb} ${options.filesSha256.slice(0, 8)}`);
  }
  return clampSubject(`${prefix}update ${cleanToken(path)}`);
}

function changedPathsFromStatus(stdout: string): ChangedStepPath[] {
  const fields = pathsFrom(stdout);
  const entries: ChangedStepPath[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    entries.push({ status: fields[i]![0] ?? 'M', path: fields[i + 1]! });
  }
  return entries;
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

  const diff = ['diff', '--name-status', '--no-renames', '--no-ext-diff', '--relative', '-z', 'HEAD', '--', ...written, ...(trackedTree ? [trackedTree] : [])];
  const changed = git(diff);
  if (changed.status !== 0) return retry(diff, changed.error?.message ?? changed.stderr);
  const changedEntries = changedPathsFromStatus(changed.stdout);
  const paths = changedEntries.map(entry => entry.path);
  if (!paths.length) return undefined;
  const subject = stepCommitSubject(kind, path, trackedTree, changedEntries, options);
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
    return retry(['commit', '--only', '-m', subject, '--', ...paths], String(error));
  }
  const message = [subject, '', `writer: rig-create ${writer}`, ...changes, `stale: ${stale.join(', ') || 'none'}`, `create: ${spec.name} ${spec.version}`].join('\n');
  const args = ['commit', '--only', '-m', message, '--', ...paths];
  const commit = git(args);
  if (commit.status !== 0) return retry(args, commit.error?.message ?? commit.stderr ?? commit.stdout);
  git(['gc', '--auto']);
}
