import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, openSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, join, posix, sep } from 'node:path';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { asArray, collectItems, isObject, PROJECT_SCHEMA, type Finding } from './check.ts';
import { CHOICE_SPEC, OPTIONS_SPEC } from './choices.ts';
import { CURRENT_KINDS, currentShapeFindings, type CurrentKind } from './current.ts';
import { intakeItem } from './intake.ts';
import type { CurrentPublicationOutput } from './job-outbox.ts';
import { refuse } from './refusal.ts';
import { PLAN_STEPS, STEP_PLAN_SCHEMA } from './stages.ts';
import type { Json, JsonObject } from './templates.ts';

type Step = 'scene' | CurrentKind;
export const OUTPUTS_IGNORE = ['/outputs/*', '!/outputs/parts/'] as const;
export const BASELINE_PATHS = ['project.json', 'package.json', 'bun.lock'] as const;
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
  exactPaths?: readonly string[];
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

function projectGit(dir: string, args: string[], input?: string) {
  return spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', ...args], {
    cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, input,
  });
}

function gitFailure(result: ReturnType<typeof projectGit>): string {
  return result.error?.message || result.stderr?.trim() || result.stdout?.trim() || 'Git exited unsuccessfully';
}

function gitRead(dir: string, args: string[], input?: string): string {
  const result = projectGit(dir, args, input);
  if (result.status !== 0) throw new Error(gitFailure(result));
  return result.stdout;
}

function hasProjectGit(dir: string): boolean {
  if (!existsSync(join(dir, 'project.json')) && !existsSync(join(dir, 'collection.json'))) return false;
  const canonical = realpathSync(dir);
  const repo = findProjectRepo(canonical);
  if (!repo) return false;
  const root = projectGit(dir, ['rev-parse', '--show-toplevel']);
  if (root.status !== 0) throw new Error(gitFailure(root));
  return realpathSync(root.stdout.replace(/\r?\n$/, '')) === repo;
}

function projectPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  if (unique.some(path => path.includes('\0') || (sep === '\\' && /\\|^[a-z]:/i.test(path))
    || path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase())))) {
    throw new Error('expected literal project-relative paths');
  }
  return unique;
}

function listPaths(dir: string, flags: string[], scopes: readonly string[]): string[] {
  return scopes.length ? pathsFrom(gitRead(dir, ['ls-files', ...flags, '-z', '--', ...scopes])) : [];
}

/** Expand literal file or tree scopes to tracked paths relative to the project. */
export function trackedProjectStepPaths(dir: string, paths: readonly string[]): string[] {
  try {
    if (!paths.length || !hasProjectGit(dir)) return [];
    const scope = projectPaths(paths);
    const tracked = listPaths(dir, ['--cached', '--deduplicate'], scope);
    const head = projectHead(dir);
    if (head) tracked.push(...pathsFrom(gitRead(dir, ['ls-tree', '-r', '--name-only', '-z', head, '--', ...scope])));
    return [...new Set(tracked)].sort();
  } catch (error) {
    return refuse('PROJECT_COMMIT_FAILED', `project.json: ${String(error)}; repair the project Git work tree and retry`);
  }
}

const diffFlags = ['--name-status', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', '--relative', '-z'];

function scopedDiff(dir: string, flags: string[], paths: readonly string[]): ChangedStepPath[] {
  return paths.length ? changedPathsFromStatus(gitRead(dir, ['diff', ...diffFlags, ...flags, '--', ...paths])) : [];
}

function exactDiff(dir: string, flags: string[], paths: readonly string[]): ChangedStepPath[] {
  const scope = new Set(paths);
  return scopedDiff(dir, flags, paths).filter(({ path }) => scope.has(path));
}

function worktreeEntry(dir: string, path: string): Stats | undefined {
  try { return lstatSync(join(dir, path), { throwIfNoEntry: false }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function dirtyPaths(dir: string, paths: readonly string[], indexOnly: boolean): string[] {
  const staged = new Set(exactDiff(dir, ['--cached'], paths).map(entry => entry.path));
  if (indexOnly) return paths.filter(path => staged.has(path));
  const tracked = new Set(listPaths(dir, ['--cached'], paths));
  const changed = new Set(exactDiff(dir, [], paths).map(entry => entry.path));
  return paths.filter(path => staged.has(path) || changed.has(path) || (!tracked.has(path) && worktreeEntry(dir, path)));
}

export function projectStepDirtyPaths(dir: string, paths: readonly string[]): string[] {
  return readProjectDirtyPaths(dir, paths, false);
}

function readProjectDirtyPaths(dir: string, paths: readonly string[], indexOnly: boolean): string[] {
  try {
    return hasProjectGit(dir) ? dirtyPaths(dir, projectPaths(paths), indexOnly) : [];
  } catch (error) {
    return refuse('PROJECT_COMMIT_FAILED', `project.json: ${String(error)}; repair the project Git work tree and retry`);
  }
}

export function assertCleanProjectStep(dir: string, paths: readonly string[], indexOnly = false): void {
  const dirty = readProjectDirtyPaths(dir, paths, indexOnly);
  if (!dirty.length) return;
  const baseline = new Set<string>(BASELINE_PATHS);
  const remedy = dirty.every(path => baseline.has(path))
    ? `review and preserve the existing changes with rig-create history baseline ${quote(dir)} --by <operator>`
    : 'review and commit or set aside the existing changes';
  refuse('PROJECT_COMMIT_DIRTY', `${dirty.map(quote).join(', ')}: ${indexOnly ? 'the index' : 'the index or work tree'} has pending changes; ${remedy} before retrying`);
}

const NO_PROJECT_GIT = 'rig-create: WARN PROJECT_NOT_IN_GIT: project.json: the project and its collection have no Git work tree; saved the files without a commit';

function commitWarning(dir: string, paths: readonly string[], error: unknown): string {
  const baseline = new Set<string>(BASELINE_PATHS);
  const remedy = paths.some(path => baseline.has(path))
    ? `review the saved shared changes with rig-create history baseline ${quote(dir)} --by <operator>`
    : 'review the saved changes before committing';
  return `rig-create: WARN PROJECT_COMMIT_FAILED: project.json: ${error instanceof Error ? error.message : String(error)}; correct the Git error and ${remedy}`;
}

function projectHead(dir: string): string | undefined {
  const head = projectGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.status === 0) return head.stdout.trim();
  if (head.status !== 1) throw new Error(gitFailure(head));
}

function exactChanges(dir: string, paths: readonly string[], staged: ChangedStepPath[] = []): ChangedStepPath[] {
  const scope = new Set(paths);
  const additions = listPaths(dir, ['--others', '--exclude-standard'], paths).filter(path => scope.has(path));
  const head = projectHead(dir);
  const changes = head ? exactDiff(dir, [head], paths) : staged;
  return [...changes, ...additions.map(path => ({ status: 'A', path }))];
}

const BASELINE_PROJECT_FILES = new Set<string>([...BASELINE_PATHS, 'collection.json', 'review-live.json', 'members']);
const BASELINE_RESERVED = new Set([
  '.git', '.gitignore', '.gitattributes', '.gitmodules', 'scratch', 'node_modules', '.plan.lock', 'project.json.record.lock',
]);

function baselineAssetPath(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  return !BASELINE_PROJECT_FILES.has(parts[0]!) && !/[\\:\0\r\n]/.test(path)
    && parts.every(part => part && part !== '.' && part !== '..'
      && !BASELINE_RESERVED.has(part) && !part.startsWith('.rig-create-'));
}

type BaselineBinding = StepBinding & { question?: string };

function baselineBinding(value: Json | undefined): StepBinding | undefined {
  if (!isObject(value) || typeof value.path !== 'string' || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)) return;
  return { path: value.path, sha256: value.sha256 };
}

function baselineRecordBindings(...records: (JsonObject | undefined)[]): Map<string, BaselineBinding[]> {
  const bindings = new Map<string, BaselineBinding[]>();
  const add = (value: Json | undefined, question?: string): void => {
    const binding = baselineBinding(value);
    if (!binding || !baselineAssetPath(binding.path)) return;
    if (question !== undefined && /^(?:derived|outputs)(?:\/|$)/i.test(binding.path)) return;
    const entries = bindings.get(binding.path) ?? [];
    entries.push({ ...binding, question });
    bindings.set(binding.path, entries);
  };
  for (const project of records) {
    if (!project) continue;
    const items = collectItems(project, { collection: null });
    const intake = intakeItem(project);
    if (intake) items.push(intake);
    for (const item of items) {
      add(item.record.pending_options, item.id);
      for (const answer of [item.raw, ...asArray(item.record.history)].filter(isObject)) {
        if (isObject(answer.choice) && answer.choice.spec === CHOICE_SPEC) add(answer.choice.set, item.id);
      }
    }
    const interview = project.interview;
    for (const plan of asArray(isObject(interview) ? interview.step_plans : undefined).filter(isObject)) {
      if (plan.schema !== STEP_PLAN_SCHEMA || !PLAN_STEPS.some(step => step === plan.step) || !baselineBinding(plan)
        || !Number.isSafeInteger(plan.bytes) || Number(plan.bytes) <= 0 || typeof plan.by !== 'string' || !plan.by.trim()
        || typeof plan.at !== 'string' || !Number.isFinite(Date.parse(plan.at)) || !Array.isArray(plan.feedback)
        || !Array.isArray(plan.inputs) || !plan.inputs.every(input => baselineBinding(input))) continue;
      add(plan);
      // plan propose stores registered inputs and --input together, with no source marker.
      for (const input of plan.inputs) add(input);
    }
    if (isObject(project.current)) {
      for (const kind of CURRENT_KINDS) {
        const node = project.current[kind];
        if (isObject(node) && !currentShapeFindings(kind, node, project).length) {
          for (const file of asArray(node.files)) add(file);
        }
      }
    }
  }
  return bindings;
}

function jsonObject(bytes: Buffer | undefined): JsonObject | undefined {
  if (!bytes) return;
  try {
    const value: Json = JSON.parse(bytes.toString('utf8'));
    if (isObject(value)) return value;
  } catch { /* Malformed JSON supplies no bindings. */ }
}

function baselineRecord(bytes: Buffer | undefined): JsonObject | undefined {
  const record = jsonObject(bytes);
  if (record?.schema === PROJECT_SCHEMA) return record;
}

function matchingBaselineHash(bindings: readonly BaselineBinding[], bytes: Buffer): string | undefined {
  const hash = createHash('sha256').update(bytes).digest('hex');
  for (const binding of bindings) {
    if (binding.sha256 !== hash) continue;
    if (binding.question === undefined) return hash;
    const set = jsonObject(bytes);
    if (set?.schema === OPTIONS_SPEC && set.question === binding.question) return hash;
  }
}

function baselineTreeEntries(dir: string, commit: string, paths: readonly string[]): Map<string, { mode: string; oid: string }> {
  return new Map(pathsFrom(gitRead(dir, ['ls-tree', '-z', commit, '--', ...paths])).flatMap(entry => {
    const match = /^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    return match ? [[match[3]!, { mode: match[1]!, oid: match[2]! }]] : [];
  }));
}

function baselineBlob(dir: string, entry: { mode: string; oid: string } | undefined): Buffer | undefined {
  if (!entry || !/^100(?:644|755)$/.test(entry.mode)) return;
  const result = spawnSync('git', ['--no-optional-locks', 'cat-file', 'blob', entry.oid], { cwd: dir, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr?.toString().trim() || 'Git could not read the baseline blob');
  return result.stdout;
}

/** Verify added baseline paths against the exact contents of the commit and its parent record. */
export function baselineCommitMatches(dir: string, commit: string, parent: string | undefined, assets: ReadonlyMap<string, string>): boolean {
  if (!assets.size) return true;
  if ([...assets.keys()].some(path => !baselineAssetPath(path))) return false;
  const tree = baselineTreeEntries(dir, commit, ['project.json', ...assets.keys()]);
  const previous = parent ? baselineTreeEntries(dir, parent, ['project.json']).get('project.json') : undefined;
  const bindings = baselineRecordBindings(baselineRecord(baselineBlob(dir, tree.get('project.json'))), baselineRecord(baselineBlob(dir, previous)));
  for (const [path, declared] of assets) {
    const candidates = bindings.get(path);
    const bytes = candidates && baselineBlob(dir, tree.get(path));
    if (!candidates || !bytes || matchingBaselineHash(candidates, bytes)?.slice(0, 12) !== declared) return false;
  }
  return true;
}

function baselineWorktreeFile(dir: string, path: string): string | undefined {
  const parts = path.split('/');
  const name = parts.pop()!;
  for (const part of parts) {
    if (!worktreeEntry(dir, part)?.isDirectory()) return;
    dir = join(dir, part);
    if (worktreeEntry(dir, '.git')) return;
  }
  if (worktreeEntry(dir, name)?.isFile()) return join(dir, name);
}

/** Select only changed, non-ignored regular files whose working bytes match a record binding. */
function baselineBoundAssetHashes(dir: string, head: string | undefined): Map<string, string> {
  const working = baselineWorktreeFile(dir, 'project.json');
  const previous = head ? baselineTreeEntries(dir, head, ['project.json']).get('project.json') : undefined;
  const bindings = baselineRecordBindings(baselineRecord(working ? readFileSync(working) : undefined), baselineRecord(baselineBlob(dir, previous)));
  const files = new Map([...bindings.keys()].flatMap(path => {
    const full = baselineWorktreeFile(dir, path);
    return full ? [[path, full] as const] : [];
  }));
  if (!files.size) return new Map();
  // check-ignore reads filenames from stdin and rejects pathspec magic, including the global literal flag.
  const ignored = projectGit(dir, ['--no-literal-pathspecs', 'check-ignore', '--no-index', '-z', '--stdin'],
    `${[...files.keys()].join('\0')}\0`);
  if (ignored.status !== 0 && ignored.status !== 1) throw new Error(gitFailure(ignored));
  for (const path of pathsFrom(ignored.stdout)) files.delete(path);
  const candidates = [...files.keys()];
  const staged = exactDiff(dir, ['--cached'], candidates);
  const pending = new Set([...staged, ...exactChanges(dir, candidates, staged)].map(entry => entry.path));
  const hashes = new Map<string, string>();
  for (const path of pending) {
    const hash = matchingBaselineHash(bindings.get(path)!, readFileSync(files.get(path)!));
    if (hash !== undefined) hashes.set(path, hash);
  }
  return hashes;
}

function assertBaselineNamespace(dir: string, head: string | undefined, paths: readonly string[]): void {
  if (!paths.length) return;
  const files = new Set(paths);
  const indexed = listPaths(dir, ['--cached'], paths);
  const tree = head ? baselineTreeEntries(dir, head, paths) : new Map<string, { mode: string }>();
  const collisions = indexed.filter(path => !files.has(path));
  for (const [path, entry] of tree) {
    if (!files.has(path) || !/^100(?:644|755)$/.test(entry.mode)) collisions.push(path);
  }
  const parents = new Set<string>();
  for (const file of paths) {
    for (let path = posix.dirname(file); path !== '.'; path = posix.dirname(path)) parents.add(path);
  }
  if (parents.size) {
    const prefix = gitRead(dir, ['rev-parse', '--show-prefix']).replace(/\r?\n$/, '');
    // Exact object expressions avoid scanning the files beneath each parent directory.
    const queries = [...parents].flatMap(path => [
      ...(head ? [{ path, ref: `${head}:${prefix}${path}`, treeAllowed: true }] : []),
      ...[0, 1, 2, 3].map(stage => ({ path, ref: `:${stage}:${prefix}${path}`, treeAllowed: false })),
    ]);
    const rows = gitRead(dir, ['cat-file', '--batch-check=%(objecttype)'], `${queries.map(query => query.ref).join('\n')}\n`).split('\n');
    for (const [i, { path, ref, treeAllowed }] of queries.entries()) {
      if (rows[i] !== `${ref} missing` && !(treeAllowed && rows[i] === 'tree')) collisions.push(path);
    }
  }
  if (collisions.length) {
    refuse('PROJECT_COMMIT_DIRTY', `${[...new Set(collisions)].map(quote).join(', ')}: overlaps a different Git entry; resolve the file or directory changes before retrying history baseline`);
  }
}

function commitChanges(
  dir: string, command: string, writer: string, subject: string, changed: readonly ChangedStepPath[], stale: readonly string[], operator?: string,
  boundHashes?: ReadonlyMap<string, string>,
): void {
  const paths = changed.map(entry => entry.path).sort();
  const assetPaths = paths.filter(path => boundHashes?.has(path));
  const gitHashes = assetPaths.length ? gitRead(dir, ['hash-object', '--', ...assetPaths]).trim().split('\n') : [];
  const gitAssetHashes = new Map(assetPaths.map((path, i) => [path, gitHashes[i]!]));
  const changes = paths.map(path => {
    const full = join(dir, path);
    const entry = worktreeEntry(dir, path);
    if (entry && !entry.isFile()) throw new Error(`${quote(path)} is not a regular file`);
    const expected = boundHashes?.get(path);
    const bytes = expected === undefined ? (entry ? readFileSync(full) : undefined)
      : (baselineWorktreeFile(dir, path) ? readFileSync(full) : undefined);
    const digest = bytes && createHash('sha256').update(bytes).digest('hex');
    if (expected !== undefined) {
      if (!bytes || digest !== expected) throw new Error(`${quote(path)} changed after its baseline binding was verified`);
      const oid = gitAssetHashes.get(path);
      const rawOid = createHash(oid?.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (oid !== rawOid) throw new Error(`${quote(path)}: Git filters change the bound bytes`);
    }
    const hash = digest?.slice(0, 12) ?? 'removed';
    return `changed: ${path.startsWith('"') || /[\r\n]/.test(path) ? JSON.stringify(path) : path} ${hash}`;
  });
  const spec = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
  const message = [subject, '', `writer: rig-create ${writer}`, `command: ${command}`,
    ...(operator === undefined ? [] : [`operator: ${operator}`]), ...changes, `stale: ${stale.join(', ') || 'none'}`,
    `create: ${spec.name} ${spec.version}`].join('\n');
  const scope = new Set(paths);
  const additions = listPaths(dir, ['--others', '--exclude-standard'], paths).filter(path => scope.has(path));
  if (additions.length) gitRead(dir, ['add', '--intent-to-add', '--', ...additions]);
  gitRead(dir, ['commit', '--only', '-m', message, '--', ...paths]);
}

function requireUnstaged(dir: string, paths: readonly string[]): void {
  const staged = exactDiff(dir, ['--cached'], paths);
  if (staged.length) throw new Error(`${staged.map(entry => quote(entry.path)).join(', ')} has staged changes`);
}

/** Save one command's already-validated writes. The caller holds the writer lock. */
export function commitToolWrite(dir: string, command: string, paths: readonly string[], subject?: string): string | undefined {
  if (!paths.length) return;
  try {
    if (!hasProjectGit(dir)) return;
    const scope = projectPaths(paths);
    requireUnstaged(dir, scope);
    const changed = exactChanges(dir, scope);
    if (!changed.length) return;
    commitChanges(dir, command, command, subject === undefined ? formatActionGroups(`${command}: `, changed.map(entry => ({ ...entry, name: entry.path })))
      : clampSubject(cleanToken(subject)), changed, []);
  } catch (error) {
    return commitWarning(dir, paths, error);
  }
}

/** Commit reviewed work-tree contents as a baseline. The caller holds the writer locks. */
export function commitProjectBaseline(dir: string, operator: string): string[] {
  if (!hasProjectGit(dir)) refuse('PROJECT_NOT_IN_GIT', 'project.json: use a project or collection Git work tree to establish a baseline');
  const head = projectHead(dir);
  const boundHashes = baselineBoundAssetHashes(dir, head);
  const scope = [...BASELINE_PATHS, ...boundHashes.keys()];
  const staged = exactDiff(dir, ['--cached'], scope);
  const unstaged = new Set(exactDiff(dir, [], scope).map(entry => entry.path));
  const conflicts = staged.filter(({ path, status }) => unstaged.has(path) || status === 'U'
    || (status === 'D' && worktreeEntry(dir, path)));
  if (conflicts.length) {
    refuse('PROJECT_COMMIT_DIRTY', `${conflicts.map(entry => quote(entry.path)).join(', ')}: staged and work-tree contents differ; preserve both versions, then make the index agree with the reviewed work-tree choice before retrying history baseline`);
  }
  const changed = exactChanges(dir, scope, staged);
  const included = new Set(changed.map(entry => entry.path));
  const excluded = dirtyPaths(dir, scope, false).filter(path => !included.has(path));
  if (excluded.length) {
    refuse('PROJECT_COMMIT_DIRTY', `${excluded.map(quote).join(', ')}: Git cannot include these paths in the baseline; review their types and ignore rules before retrying history baseline`);
  }
  assertBaselineNamespace(dir, head, [...included]);
  if (changed.length) commitChanges(dir, 'history baseline', 'history baseline', 'history baseline: attribution unverified', changed, [], cleanToken(operator), boundHashes);
  return changed.map(entry => entry.path);
}

/** After a successful write, commit just its paths. Any Git failure leaves the saved data usable. */
export function commitProjectStep(
  dir: string, kind: Step, writer: string, path: string, trackedTree?: string, stale: string[] = [], options: RecordCommitOptions = {},
): string | undefined {
  try {
    if (!hasProjectGit(dir)) return NO_PROJECT_GIT;
    const written = [path, ...(options.migratedGitignore ? ['.gitignore'] : [])];
    const scopes = [...written, ...(trackedTree ? [trackedTree] : [])];
    const exact = trackedTree && options.exactPaths === undefined ? undefined : projectPaths([...written, ...(options.exactPaths ?? [])]);
    let changed: ChangedStepPath[];
    if (exact) {
      requireUnstaged(dir, exact);
      changed = exactChanges(dir, exact);
    } else {
      const bound = new Set([...written, ...(options.partsFiles ?? [])]);
      const additions = listPaths(dir, ['--others', '--exclude-standard'], scopes).filter(file => bound.has(file));
      changed = [...scopedDiff(dir, ['HEAD'], scopes), ...additions.map(file => ({ status: 'A', path: file }))];
    }
    if (!changed.length) return;
    const command = trackedTree ? `record ${kind}` : `${kind} write`;
    commitChanges(dir, command, cleanToken(writer), stepCommitSubject(kind, path, trackedTree, changed, options), changed, stale);
  } catch (error) {
    return commitWarning(dir, [path, ...(options.exactPaths ?? [])], error);
  }
}

function findProjectRepo(dir: string): string | undefined {
  const collection = basename(dirname(dir)) === 'members' ? dirname(dirname(dir)) : undefined;
  return existsSync(join(dir, '.git')) ? dir
    : collection && existsSync(join(collection, 'collection.json')) && existsSync(join(collection, '.git')) ? collection : undefined;
}

/** Verify that `commit` in the project or collection Git repository holds `project.json` with `recordHash`. */
export function resolvePublishedRecordCommit(dir: string, recordHash: string, candidate?: string): string | undefined {
  if (!findProjectRepo(dir)) return undefined;
  const git = (args: string[], encoding?: BufferEncoding) =>
    spawnSync('git', ['--literal-pathspecs', ...args], { cwd: dir, ...(encoding ? { encoding } : {}) });
  let sha = candidate;
  if (!sha) {
    const rev = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 'utf8');
    if (rev.status !== 0 || typeof rev.stdout !== 'string') return undefined;
    sha = rev.stdout.trim();
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) return undefined;
  const shown = git(['show', `${sha}:./project.json`]);
  if (shown.status !== 0 || !Buffer.isBuffer(shown.stdout)) return undefined;
  return createHash('sha256').update(shown.stdout).digest('hex') === recordHash ? sha : undefined;
}

/** Bind an existing, exact input closure and commit only the generated manifest. */
export function commitCurrentPublication(
  dir: string,
  output: CurrentPublicationOutput,
  recordHash: string,
  closurePaths: readonly string[],
  mayCommitManifest = true,
): { commit?: string; warning?: Finding } {
  if (!findProjectRepo(dir)) {
    return {
      warning: {
        code: 'PROJECT_NOT_IN_GIT',
        path: 'project.json',
        message: 'project.json: the project and its collection have no Git work tree; published without a commit',
      },
    };
  }
  const git = (args: string[]) => spawnSync('git', ['--literal-pathspecs', ...args], { cwd: dir, encoding: 'utf8' });
  const failed = (why: string): { warning: Finding } => ({
    warning: {
      code: 'PROJECT_COMMIT_FAILED',
      path: 'project.json',
      message: `project.json: ${why.trim() || 'Git exited unsuccessfully'}; commit or restore the exact publication inputs and rerun job open --current ${output}`,
    },
  });
  const manifest = 'review-live.json';
  const parents = [...new Set(closurePaths.filter(path => path !== manifest && path !== 'project.json'))];
  const parent = resolvePublishedRecordCommit(dir, recordHash);
  if (!parent) return failed('HEAD does not hold the frozen publication record; review pending shared edits with rig-create history baseline --by <operator>');
  if (!mayCommitManifest) return failed(`${manifest} already had pending edits before publication`);
  if (parents.length > 0) {
    const visible = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...parents]);
    if (visible.status !== 0) return failed(visible.error?.message ?? visible.stderr);
    const tree = git(['ls-tree', '-r', '-z', parent, '--', ...parents]);
    if (tree.status !== 0) return failed(tree.error?.message ?? tree.stderr);
    const blobs = new Map(pathsFrom(tree.stdout).flatMap(entry => {
      const match = /^100(?:644|755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      return match ? [[match[2]!, match[1]!] as const] : [];
    }));
    for (const path of new Set([...pathsFrom(visible.stdout), ...blobs.keys()])) {
      try {
        const oid = blobs.get(path);
        const bytes = readFileSync(join(dir, path));
        const hash = oid && createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (oid && hash === oid) continue;
      } catch { /* Report unavailable input as a missing Git binding. */ }
      return failed(`${path} differs from the publication input at HEAD`);
    }
  }
  const warning = commitToolWrite(dir, 'publish current', [manifest], `publish: current ${output} ${recordHash.slice(0, 12)}`);
  if (warning) return failed(warning);
  const commit = resolvePublishedRecordCommit(dir, recordHash);
  return commit ? { commit } : failed('the publication record changed while saving the manifest');
}
