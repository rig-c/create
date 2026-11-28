import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { collectItems } from '../src/check.ts';
import { optionContext } from '../src/choices.ts';
import { CURRENT_RIG_MODEL, sha256 } from '../src/current.ts';
import { freshProjectRecord } from '../src/init.ts';
import { jobPrivateRoot, readWriterBinding, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { CURRENT_LIVE_MANIFEST } from '../src/job-publication.ts';
import { jobRuntimeCommand, jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { NextReport } from '../src/next.ts';
import { runningCreateVersion } from '../src/pins.ts';
import type { JsonObject } from '../src/templates.ts';
import { TEST_NOW } from './clock.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { gitEnv, run, stagedCreateRegistry, tempDir, treeDigest, type Run } from './helpers.ts';

const PROJECT = 'project.json';
const PAINTING = 'inputs/painting.png';
const OPTION = 'evidence/interview/history-composition.json';
const QUESTION = 'post_composition';
const UNRELATED = 'scratchpad.txt';
const PLAN = 'plans/parts [v1].md';
const MODEL = CURRENT_RIG_MODEL;
const OWNER = ['--reviewer', 'synthetic-owner', '--role', 'owner'];
const CLOCKED_CLI = join(import.meta.dir, 'cli-at.ts');
const OPERATOR = 'synthetic-operator';

type Repo = { dir: string; env: Record<string, string> };
type HistoryEntry = { sha: string; subject: string; command?: string; attribution?: string; operator?: string; files?: string[] };

function success(result: Run): string {
  expect({ code: result.code, stderr: result.code === 0 ? '' : result.stderr }).toEqual({ code: 0, stderr: '' });
  return result.stdout;
}

function git(repo: Repo, ...args: string[]): string {
  return success(run(['git', '--literal-pathspecs', ...args], repo.dir, repo.env));
}

function cli(repo: Repo, ...args: string[]): Run {
  return run(cliArgv(args), repo.dir, repo.env);
}

function cliArgv(args: string[]): string[] {
  return [process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, new Date(TEST_NOW).toISOString(), ...args];
}

function gitWrapper(repo: Repo, body: string, env: Record<string, string> = {}): Repo {
  const bin = tempDir();
  const actualGit = Bun.which('git');
  if (!actualGit) throw new Error('fixture needs the real Git executable');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${body}\nexec "$RIG_TEST_REAL_GIT" "$@"\n`, { mode: 0o755 });
  return { dir: repo.dir, env: { ...repo.env, PATH: `${bin}${delimiter}${repo.env.PATH}`, RIG_TEST_REAL_GIT: actualGit, ...env } };
}

function commitFault(repo: Repo, writer: string, killMarker?: string): Repo {
  return gitWrapper(repo, `commit=false
only=false
writer=false
for arg do
  case "$arg" in
    commit) commit=true ;;
    --only) only=true ;;
    *"writer: rig-create $RIG_TEST_WRITER"*) writer=true ;;
  esac
done
if "$commit" && "$only" && "$writer"; then
  if [ -n "$RIG_TEST_KILL_MARKER" ]; then
    test "$PPID" = "$RIG_TEST_WRITER_PID" || exit 71
    printf '%s\\n' "$PPID" > "$RIG_TEST_KILL_MARKER" || exit 72
    kill -KILL "$PPID" || exit 73
    exit 74
  fi
  printf '%s\\n' 'fatal: synthetic scoped commit failure' >&2
  exit 128
fi`, { RIG_TEST_WRITER: writer, RIG_TEST_KILL_MARKER: killMarker ?? '' });
}

function interruptedCommit(repo: Repo, writer: string, argv: string[], stdin?: Buffer): void {
  const marker = join(tempDir(), 'killed-writer');
  const faulty = commitFault(repo, writer, marker);
  const interrupted = Bun.spawnSync(['/bin/sh', '-c', 'export RIG_TEST_WRITER_PID=$$; exec "$@"', 'writer', ...argv], {
    cwd: repo.dir, env: faulty.env, stdin, stdout: 'pipe', stderr: 'pipe', timeout: 12_000,
  });
  expect(interrupted.exitedDueToTimeout).not.toBe(true);
  expect(['SIGKILL', 9]).toContain(interrupted.signalCode ?? '<none>');
  expect(readFileSync(marker, 'utf8')).toBe(`${interrupted.pid}\n`);
}

const probeFailures = [
  ['exit 128', 'fatal: could not read repository metadata'],
  ['dubious ownership', 'fatal: detected dubious ownership in repository'],
  ['missing Git', undefined],
] as const;

function gitProbeFault(repo: Repo, diagnostic: string | undefined): Repo {
  if (diagnostic === undefined) return { dir: repo.dir, env: { ...repo.env, PATH: tempDir() } };
  return gitWrapper(repo, `for arg do
  if [ "$arg" = rev-parse ]; then
    printf '%s\\n' "$RIG_TEST_GIT_DIAGNOSTIC" >&2
    exit 128
  fi
done`, { RIG_TEST_GIT_DIAGNOSTIC: diagnostic });
}

function bytes({ dir }: Repo, path: string): Buffer {
  return readFileSync(join(dir, path));
}

function json(repo: Repo, path: string): JsonObject {
  return JSON.parse(bytes(repo, path).toString()) as JsonObject;
}

function put({ dir }: Repo, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function putJson(repo: Repo, path: string, value: JsonObject): void {
  put(repo, path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureRepo(dir: string): Repo {
  return { dir, env: gitEnv({ name: 'History Fixture', email: 'fixture@example.test' }) };
}

function currentFixture(): Repo {
  return fixtureRepo(fixture(() => {}, 'example-current/project.json'));
}

function planFixture(): Repo {
  const repo = fixtureRepo(join(tempDir(), 'project'));
  putJson(repo, PROJECT, freshProjectRecord('synthetic-history', TEST_NOW));
  const example = join(import.meta.dir, '..', 'templates', 'example-current', PAINTING);
  put(repo, PAINTING, readFileSync(example));
  success(cli(repo, 'input', 'add', PAINTING, repo.dir, '--origin', 'synthetic source'));
  return repo;
}

function seed(repo: Repo, subject = 'Seed synthetic consumer', force: string[] = []): void {
  put(repo, UNRELATED, 'original\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '--', '.');
  if (force.length) git(repo, 'add', '--force', '--', ...force);
  git(repo, 'commit', '-qm', subject);
}

function clone(source: Repo): Repo {
  const repo = { dir: join(tempDir(), 'project'), env: source.env };
  git(source, 'clone', '-q', '--local', '--', source.dir, repo.dir);
  // Reuse the same synthetic producer files ignored by a normal consumer clone.
  for (const path of ['outputs', 'derived']) {
    cpSync(join(source.dir, path), join(repo.dir, path), { recursive: true });
  }
  return repo;
}

function head(repo: Repo): string {
  return git(repo, 'rev-parse', 'HEAD').trim();
}

function scope(repo: Repo): string[] {
  return git(repo, 'show', '--format=', '--name-only', '--no-renames', '-z', 'HEAD').split('\0').filter(Boolean).sort();
}

function unrelatedSnapshot(repo: Repo) {
  return [git(repo, 'ls-files', '--stage', '--', UNRELATED), git(repo, 'show', `:${UNRELATED}`), bytes(repo, UNRELATED)];
}

function plantUnrelatedChanges(repo: Repo) {
  put(repo, UNRELATED, 'staged bytes\n');
  git(repo, 'add', '--', UNRELATED);
  put(repo, UNRELATED, 'different unstaged bytes\n');
  expect(git(repo, 'status', '--porcelain', '--', UNRELATED)).toBe(`MM ${UNRELATED}\n`);
  return unrelatedSnapshot(repo);
}

function step(repo: Repo, parent: string, subject: RegExp, paths: string[], unrelated?: ReturnType<typeof unrelatedSnapshot>): string {
  expect(git(repo, 'rev-parse', 'HEAD^').trim()).toBe(parent);
  expect(git(repo, 'show', '--format=%s', '-s', 'HEAD').trim()).toMatch(subject);
  expect(scope(repo)).toEqual([...paths].sort());
  for (const path of paths) expect(git(repo, 'show', `HEAD:${path}`)).toBe(bytes(repo, path).toString());
  if (unrelated) expect(unrelatedSnapshot(repo)).toEqual(unrelated);
  return head(repo);
}

function postInterview(): Repo {
  const repo = currentFixture();
  const project = json(repo, PROJECT);
  project.stage = 'post-interview';
  project.advances = arr(project.advances).slice(0, 7);
  project.signoffs = arr(project.signoffs).slice(0, 5);
  for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
  delete obj(project.current).motion;
  delete obj(project.current).direction;
  obj(project.plan).steps = arr(obj(project.plan).steps).filter(row => obj(row).phase === 'rig');
  putJson(repo, PROJECT, project);
  return repo;
}

function draftOptions(repo: Repo, path = OPTION, id = 'history-composition'): void {
  const set = json(repo, `evidence/interview/${QUESTION}.json`);
  const at = Date.parse(String(set.drafted_at));
  set.id = id;
  set.context = optionContext(json(repo, PROJECT), 'post-interview', at, repo.dir);
  putJson(repo, path, set);
}

function composition(repo: Repo, project = json(repo, PROJECT)): JsonObject {
  return collectItems(project, { collection: null }).find(item => item.id === QUESTION)!.record;
}

function baselineMove(repo: Repo) {
  const next = JSON.parse(success(cli(repo, 'next', repo.dir, '--json'))) as NextReport;
  return next.moves.find(move => move.field === 'git.baseline');
}

function historyEntries(repo: Repo): HistoryEntry[] {
  return JSON.parse(success(cli(repo, 'history', repo.dir, '--json'))) as HistoryEntry[];
}

// `job open` keeps the runtime serving. Wait for a publication line before observing Git.
async function withPublication(repo: Repo, selector: string[], expected: RegExp, inspect?: (stdout: string) => void): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(cliArgv(['job', 'open', repo.dir, ...OWNER, ...selector]),
    { cwd: repo.dir, env: repo.env, stdout: 'pipe', stderr: 'pipe' });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => child.kill('SIGTERM'), 12_000);
  let stdout = '';
  try {
    while (!expected.test(stdout)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`job open exited ${await child.exited}\n${stdout}\n${await stderr}`);
      stdout += decoder.decode(chunk.value, { stream: true });
    }
    inspect?.(stdout);
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await child.exited;
  }
  return { stdout, stderr: await stderr };
}

async function expectUncommittedCurrentPublication(repo: Repo, faulty: Repo, detail?: string): Promise<void> {
  const initial = head(repo);
  const original = bytes(repo, PROJECT);
  const index = git(repo, 'ls-files', '--stage', '--', PROJECT, CURRENT_LIVE_MANIFEST);
  const result = await withPublication(faulty, ['--current', 'rig'], /\njob: current rig published \(publication [^)]+\)\n/);

  const log = `${result.stdout}\n${result.stderr}`;
  expect(log).toMatch(/WARN PROJECT_COMMIT_FAILED:/);
  if (detail !== undefined) expect(log).toContain(detail);
  expect(bytes(repo, PROJECT)).not.toEqual(original);
  const binding = readWriterBinding(repo.dir);
  expect(binding?.jobId).toEqual(expect.any(String));
  expect(json(repo, PROJECT).review_job).toMatchObject({ jobId: binding?.jobId });
  expect(json(repo, CURRENT_LIVE_MANIFEST)).toMatchObject({ schema: 'rig-review/1', title: 'current rig' });
  expect(head(repo)).toBe(initial);
  expect(git(repo, 'ls-files', '--stage', '--', PROJECT, CURRENT_LIVE_MANIFEST)).toBe(index);
}

test('#1165 a clean consumer clone records an upgrade, option set and question job as three exact steps', async () => {
  const source = postInterview();
  const legacyCreate = '2.0.0';
  const manifest = json(source, 'package.json');
  obj(manifest.dependencies)['@rig-c/create'] = legacyCreate;
  delete obj(manifest.dependencies)['@rig-c/review'];
  putJson(source, 'package.json', manifest);
  const registry = stagedCreateRegistry();
  const installEnv = runningCreateVersion() === legacyCreate ? { ...source.env, ...registry } : source.env;
  success(run([process.execPath, 'install', '--ignore-scripts'], source.dir, installEnv));
  seed(source);

  const repo = clone(source);
  repo.env = { ...repo.env, ...registry };
  expect(git(repo, 'status', '--porcelain')).toBe('');
  const start = head(repo);
  const unrelated = plantUnrelatedChanges(repo);
  success(cli(repo, 'packages', 'upgrade', repo.dir, '--by', OPERATOR));
  const upgrade = step(repo, start, /^packages upgrade:/, ['bun.lock', 'package.json', PROJECT], unrelated);
  const upgraded = json(repo, PROJECT);
  expect(arr(upgraded.package_upgrades).at(-1)).toMatchObject({ by: OPERATOR, lock_sha256: sha256(bytes(repo, 'bun.lock')) });
  expect(composition(repo, upgraded).pending_options).toBeUndefined();
  expect(upgraded.review_job).toBeUndefined();

  draftOptions(repo);
  success(cli(repo, 'interview-options', QUESTION, repo.dir, '--file', OPTION));
  const options = step(repo, upgrade, /^interview-options:/, [OPTION, PROJECT], unrelated);
  const pending = { path: OPTION, sha256: sha256(bytes(repo, OPTION)) };
  expect(composition(repo).pending_options).toEqual(pending);
  expect(json(repo, PROJECT).review_job).toBeUndefined();

  await withPublication(repo, ['--question', QUESTION], /\njob: option-set post_composition\/history-composition published \(publication [^)]+\)\n/, () => {
    const binding = step(repo, options, /^job open:/, [PROJECT], unrelated);
    expect(json(repo, PROJECT).review_job).toMatchObject({ jobId: readWriterBinding(repo.dir)?.jobId });
    expect(composition(repo).pending_options).toEqual(pending);
    const history = historyEntries(repo);
    expect(history).toHaveLength(3);
    for (const [sha, command] of [[upgrade, 'packages upgrade'], [options, 'interview-options'], [binding, 'job open']]) {
      expect(history.find(entry => entry.sha === sha)).toMatchObject({ command });
      expect(history.find(entry => entry.sha === sha)?.attribution).toBeUndefined();
    }
    expect(git(repo, 'status', '--porcelain')).toBe(`MM ${UNRELATED}\n`);
    git(repo, 'restore', '--staged', '--worktree', '--', UNRELATED);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
}, 45_000);

test('#1165 plan proposal records its literal retained file and leaves unrelated changes and a no-op retry alone', () => {
  const repo = planFixture();
  seed(repo);
  const initial = head(repo);
  const unrelated = plantUnrelatedChanges(repo);
  put(repo, PLAN, 'Cut along the painted outline so the joints stay readable.\n');
  const args = ['plan', 'propose', 'parts', repo.dir, '--file', PLAN, '--by', OPERATOR];
  success(cli(repo, ...args));
  const plan = step(repo, initial, /^plan propose:/, [PLAN, PROJECT], unrelated);
  expect(historyEntries(repo)).toEqual([expect.objectContaining({ sha: plan, command: 'plan propose' })]);
  expect(arr(obj(json(repo, PROJECT).interview).step_plans).at(-1)).toMatchObject({ path: PLAN, sha256: sha256(bytes(repo, PLAN)) });
  success(cli(repo, ...args));
  expect(head(repo)).toBe(plan);
  expect(unrelatedSnapshot(repo)).toEqual(unrelated);
});

test('#1165 P1-1 option commit failure keeps the registration and baseline includes the bound set', () => {
  const repo = postInterview();
  seed(repo);
  const initial = head(repo);
  const unrelated = plantUnrelatedChanges(repo);
  const original = bytes(repo, PROJECT);
  const decoy = 'evidence/interview/history-composition-unused.json';
  draftOptions(repo);
  draftOptions(repo, decoy, 'history-composition-unused');
  const bound = { path: OPTION, sha256: sha256(bytes(repo, OPTION)) };
  const args = ['interview-options', QUESTION, repo.dir, '--file', OPTION];

  const failed = cli(commitFault(repo, 'interview-options'), ...args);
  expect(JSON.parse(success(failed))).toEqual(bound);
  expect(failed.stderr).toMatch(/WARN PROJECT_COMMIT_FAILED:.*synthetic scoped commit failure/);
  const saved = bytes(repo, PROJECT);
  expect(saved).not.toEqual(original);
  expect(composition(repo).pending_options).toEqual(bound);
  expect(head(repo)).toBe(initial);
  expect(baselineMove(repo)).toBeDefined();

  expect(JSON.parse(success(cli(repo, ...args)))).toEqual(bound);
  expect(head(repo)).toBe(initial);
  expect(bytes(repo, PROJECT)).toEqual(saved);

  success(cli(repo, 'history', 'baseline', repo.dir, '--by', OPERATOR));
  const baseline = step(repo, initial, /baseline/i, [OPTION, PROJECT], unrelated);
  expect(historyEntries(repo)).toEqual([expect.objectContaining({ sha: baseline, command: 'history baseline',
    attribution: 'unverified', operator: OPERATOR, files: [OPTION, PROJECT] })]);
  expect(bytes(repo, PROJECT)).toEqual(saved);
  expect(git(repo, 'status', '--porcelain', '--', OPTION, decoy)).toBe(`?? ${decoy}\n`);
  expect(baselineMove(repo)).toBeUndefined();
});

test('#1165 P1-1 plan commit failure keeps the proposal and baseline includes the bound Markdown', () => {
  const repo = planFixture();
  seed(repo);
  const initial = head(repo);
  const unrelated = plantUnrelatedChanges(repo);
  const original = bytes(repo, PROJECT);
  const decoy = 'plans/parts v.md';
  put(repo, PLAN, 'Cut along the painted outline so the joints stay readable.\n');
  put(repo, decoy, 'Unused proposal.\n');
  const bound = { path: PLAN, sha256: sha256(bytes(repo, PLAN)) };
  const args = ['plan', 'propose', 'parts', repo.dir, '--file', PLAN, '--by', OPERATOR, '--json'];

  const failed = cli(commitFault(repo, 'plan propose'), ...args);
  expect(JSON.parse(success(failed))).toMatchObject(bound);
  expect(failed.stderr).toMatch(/WARN PROJECT_COMMIT_FAILED:.*synthetic scoped commit failure/);
  const saved = bytes(repo, PROJECT);
  expect(saved).not.toEqual(original);
  expect(arr(obj(json(repo, PROJECT).interview).step_plans)).toEqual([expect.objectContaining(bound)]);
  expect(head(repo)).toBe(initial);
  expect(baselineMove(repo)).toBeDefined();

  expect(JSON.parse(success(cli(repo, ...args)))).toMatchObject(bound);
  expect(head(repo)).toBe(initial);
  expect(bytes(repo, PROJECT)).toEqual(saved);

  success(cli(repo, 'history', 'baseline', repo.dir, '--by', OPERATOR));
  const baseline = step(repo, initial, /baseline/i, [PLAN, PROJECT], unrelated);
  expect(historyEntries(repo)).toEqual([expect.objectContaining({ sha: baseline, command: 'history baseline',
    attribution: 'unverified', operator: OPERATOR, files: [PLAN, PROJECT] })]);
  expect(bytes(repo, PROJECT)).toEqual(saved);
  expect(git(repo, 'status', '--porcelain', '-z', '--', PLAN, decoy)).toBe(`?? ${decoy}\0`);
  expect(baselineMove(repo)).toBeUndefined();
});

test('#1165 a cloned 2.0.0 record with registration and job edits needs a baseline before another writer', () => {
  const source = postInterview();
  const manifest = json(source, 'package.json');
  obj(manifest.dependencies)['@rig-c/create'] = '2.0.0';
  putJson(source, 'package.json', manifest);
  seed(source);
  const repo = clone(source);
  const initial = head(repo);
  const unrelated = plantUnrelatedChanges(repo);
  draftOptions(repo);
  const legacyOption = bytes(repo, OPTION);
  const changed = json(repo, PROJECT);
  const pending = { path: OPTION, sha256: sha256(bytes(repo, OPTION)) };
  composition(repo, changed).pending_options = pending;
  changed.review_job = { jobId: 'legacy-view', origin: 'http://127.0.0.1:43123' };
  putJson(repo, PROJECT, changed);
  const oldBytes = bytes(repo, PROJECT);
  const revised = 'evidence/interview/history-composition-revised.json';
  draftOptions(repo, revised, 'history-composition-revised');
  const args = ['interview-options', QUESTION, repo.dir, '--file', revised];
  const refused = cli(repo, ...args);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/PROJECT_COMMIT_DIRTY:.*project\.json.*history baseline/s);
  expect(head(repo)).toBe(initial);
  expect(bytes(repo, PROJECT)).toEqual(oldBytes);
  expect(git(repo, 'ls-files', '--stage', '--', revised)).toBe('');
  expect(unrelatedSnapshot(repo)).toEqual(unrelated);

  expect(baselineMove(repo)).toMatchObject({ command: expect.stringContaining('rig-create history baseline '),
    act: expect.stringContaining(PROJECT) });
  success(cli(repo, 'history', 'baseline', repo.dir, '--by', OPERATOR));
  const saved = step(repo, initial, /baseline/i, [OPTION, PROJECT], unrelated);
  expect(historyEntries(repo)).toEqual([expect.objectContaining({ sha: saved, command: 'history baseline',
    attribution: 'unverified', operator: OPERATOR, files: [OPTION, PROJECT] })]);
  expect(bytes(repo, PROJECT)).toEqual(oldBytes);
  expect(bytes(repo, OPTION)).toEqual(legacyOption);
  expect(git(repo, 'status', '--porcelain', '--', OPTION, revised)).toBe(`?? ${revised}\n`);
  expect(composition(repo).pending_options).toEqual(pending);
  expect(json(repo, PROJECT).review_job).toEqual(changed.review_job!);
  expect(baselineMove(repo)).toBeUndefined();

  success(cli(repo, ...args));
  const options = step(repo, saved, /^interview-options:/, [PROJECT, revised], unrelated);
  expect(composition(repo).pending_options).toEqual({ path: revised, sha256: sha256(bytes(repo, revised)) });
  expect(json(repo, PROJECT).review_job).toEqual(changed.review_job!);

  const directionPlan = 'plans/history-direction.md';
  put(repo, directionPlan, 'Keep the camera fixed and loop for four seconds.\n');
  success(cli(repo, 'plan', 'propose', 'direction', repo.dir, '--file', directionPlan, '--by', OPERATOR));
  const plan = step(repo, options, /^plan propose:/, [PROJECT, directionPlan], unrelated);
  expect(historyEntries(repo)).toContainEqual(expect.objectContaining({ sha: plan, command: 'plan propose' }));
  expect(baselineMove(repo)).toBeUndefined();
});

test('#1165 P2-5 plan proposal refuses an unstaged edit to a tracked explicit input', () => {
  const repo = planFixture();
  const input = 'inputs/plan-notes.txt';
  put(repo, input, 'Reviewed reference.\n');
  seed(repo);
  const initial = head(repo);
  const original = bytes(repo, PROJECT);
  put(repo, input, 'Uncommitted reference.\n');
  const edited = bytes(repo, input);
  put(repo, PLAN, 'Keep the joint line along the outline.\n');

  const refused = cli(repo, 'plan', 'propose', 'parts', repo.dir, '--file', PLAN, '--by', OPERATOR, '--input', input);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/PROJECT_COMMIT_DIRTY:.*inputs\/plan-notes\.txt/);
  expect(bytes(repo, PROJECT)).toEqual(original);
  expect(bytes(repo, input)).toEqual(edited);
  expect(git(repo, 'status', '--porcelain', '--', input)).toBe(` M ${input}\n`);
  expect(git(repo, 'ls-files', '--stage', '--', PLAN)).toBe('');
  expect(head(repo)).toBe(initial);
});

test('#1165 index-only edits to the shared record refuse before a plan is saved', () => {
  const repo = planFixture();
  seed(repo);
  const initial = head(repo);
  const original = bytes(repo, PROJECT);
  put(repo, PROJECT, Buffer.concat([original, Buffer.from('\n')]));
  git(repo, 'add', '--', PROJECT);
  const staged = git(repo, 'ls-files', '--stage', '--', PROJECT);
  put(repo, PROJECT, original);
  put(repo, PLAN, 'Keep the line closely aligned with the original painting.\n');
  const refused = cli(repo, 'plan', 'propose', 'parts', repo.dir, '--file', PLAN, '--by', OPERATOR);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/PROJECT_COMMIT_DIRTY:.*project\.json.*history baseline/s);
  expect(bytes(repo, PROJECT)).toEqual(original);
  expect(git(repo, 'ls-files', '--stage', '--', PROJECT)).toBe(staged);
  expect(git(repo, 'ls-files', '--stage', '--', PLAN)).toBe('');
  expect(head(repo)).toBe(initial);
});

test('#1165 baseline recovers an interrupted job binding and the same job open can publish again', async () => {
  const repo = currentFixture();
  seed(repo);
  const initial = head(repo);
  const original = bytes(repo, PROJECT);
  interruptedCommit(repo, 'job open', jobRuntimeCommand('open'),
    Buffer.from(JSON.stringify({ root: repo.dir, reviewer: OWNER[1], role: 'owner', current: 'rig', now: TEST_NOW })));
  expect(bytes(repo, PROJECT)).not.toEqual(original);
  expect(json(repo, PROJECT).review_job).toMatchObject({ jobId: expect.any(String), origin: expect.stringMatching(/^http:\/\//) });
  expect(head(repo)).toBe(initial);
  expect(baselineMove(repo)).toBeDefined();

  success(cli(repo, 'history', 'baseline', repo.dir, '--by', OPERATOR));
  const saved = step(repo, initial, /baseline/i, [PROJECT]);
  expect(baselineMove(repo)).toBeUndefined();
  await withPublication(repo, ['--current', 'rig'], /\njob: current rig published \(publication [^)]+\)\n/, () => {
    expect(json(repo, PROJECT).review_job).toMatchObject({ jobId: readWriterBinding(repo.dir)?.jobId });
    expect(git(repo, 'merge-base', '--is-ancestor', saved, 'HEAD')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', PROJECT)).toBe('');
  });
}, 25_000);

test('#1165 record refuses a dirty shared record before moving producer outputs, then records after baseline', () => {
  const repo = currentFixture();
  seed(repo);
  const initial = head(repo);
  const unrelated = plantUnrelatedChanges(repo);
  const out = 'outputs/motion';
  const from = `${out}.next`;
  cpSync(join(repo.dir, out), join(repo.dir, from), { recursive: true });
  const changed = json(repo, PROJECT);
  changed.review_job = { jobId: 'legacy-view', origin: 'http://127.0.0.1:43123' };
  putJson(repo, PROJECT, changed);
  const before = [bytes(repo, PROJECT), treeDigest(join(repo.dir, from)), treeDigest(join(repo.dir, out))];
  const args = ['record', 'motion', repo.dir, '--from', from];
  const refused = cli(repo, ...args);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/PROJECT_COMMIT_DIRTY:.*project\.json.*history baseline/s);
  expect([bytes(repo, PROJECT), treeDigest(join(repo.dir, from)), treeDigest(join(repo.dir, out))]).toEqual(before);
  expect(head(repo)).toBe(initial);
  expect(unrelatedSnapshot(repo)).toEqual(unrelated);

  success(cli(repo, 'history', 'baseline', repo.dir, '--by', OPERATOR));
  const saved = step(repo, initial, /baseline/i, [PROJECT], unrelated);
  success(cli(repo, ...args));
  step(repo, saved, /^motion:/, [PROJECT], unrelated);
  expect(existsSync(join(repo.dir, from))).toBe(false);
});

test('#1165 P1-1 interrupted record commit leaves the moved producer output installed', () => {
  const repo = currentFixture();
  const out = 'outputs/motion';
  const from = `${out}.next`;
  const receipt = 'render-run.json';
  const trackedOutput = `${out}/${receipt}`;
  put(repo, '.gitignore', `${bytes(repo, '.gitignore').toString().trimEnd()}\n!/${out}/\n/${out}/*\n!/${trackedOutput}\n`);
  seed(repo);
  const initial = head(repo);
  const original = bytes(repo, PROJECT);
  const oldReceipt = bytes(repo, trackedOutput);
  expect(git(repo, 'show', `HEAD:${trackedOutput}`)).toBe(oldReceipt.toString());
  cpSync(join(repo.dir, out), join(repo.dir, from), { recursive: true });
  // A JSON whitespace change preserves the producer's declared file hashes.
  const movedReceipt = Buffer.concat([oldReceipt, Buffer.from('\n')]);
  put(repo, `${from}/${receipt}`, movedReceipt);
  const installed = treeDigest(join(repo.dir, from));
  expect(treeDigest(join(repo.dir, out))).not.toEqual(installed);

  interruptedCommit(repo, 'record motion', cliArgv(['record', 'motion', repo.dir, '--from', from, '--by', OPERATOR]));
  const saved = bytes(repo, PROJECT);
  expect(saved).not.toEqual(original);
  expect(obj(obj(json(repo, PROJECT).current).motion)).toMatchObject({ built_by: OPERATOR,
    files: expect.arrayContaining([{ path: trackedOutput, sha256: sha256(movedReceipt), bytes: movedReceipt.length }]) });
  expect(existsSync(join(repo.dir, from))).toBe(false);
  expect(treeDigest(join(repo.dir, out))).toEqual(installed);
  expect(head(repo)).toBe(initial);
  expect(git(repo, 'show', `HEAD:${trackedOutput}`)).toBe(oldReceipt.toString());
  expect(baselineMove(repo)).toBeDefined();

  success(cli(repo, 'history', 'baseline', repo.dir, '--by', OPERATOR));
  const baseline = step(repo, initial, /baseline/i, [trackedOutput, PROJECT]);
  expect(historyEntries(repo)).toEqual([expect.objectContaining({ sha: baseline, command: 'history baseline',
    attribution: 'unverified', operator: OPERATOR, files: [trackedOutput, PROJECT] })]);
  expect(git(repo, 'show', `HEAD:${trackedOutput}`)).toBe(movedReceipt.toString());
  expect(bytes(repo, PROJECT)).toEqual(saved);
  expect(treeDigest(join(repo.dir, out))).toEqual(installed);
  expect(baselineMove(repo)).toBeUndefined();
});

for (const [failure, diagnostic] of probeFailures) {
  test(`#1165 P1-2 next warns and keeps its workflow when Git probe fails: ${failure}`, () => {
    const repo = planFixture();
    seed(repo);
    const initial = head(repo);
    const original = bytes(repo, PROJECT);
    const args = ['next', repo.dir, '--json'];
    const healthy = JSON.parse(success(cli(repo, ...args))) as NextReport;
    expect(healthy.moves.length).toBeGreaterThan(0);

    const faulty = gitProbeFault(repo, diagnostic);
    const result = cli(faulty, ...args);
    const next = JSON.parse(success(result)) as NextReport;
    expect(next.warnings).toContainEqual(expect.objectContaining({ code: 'PROJECT_COMMIT_FAILED' }));
    expect(result.stderr).toMatch(/WARN PROJECT_COMMIT_FAILED:/);
    expect(next.moves).toEqual(healthy.moves);
    expect(next.refusals).toEqual(healthy.refusals);
    expect(bytes(repo, PROJECT)).toEqual(original);
    expect(head(repo)).toBe(initial);
  });

  test(`#1165 P1-2 job open publishes with a warning and no commit when Git probe fails: ${failure}`, async () => {
    const repo = currentFixture();
    seed(repo);
    await expectUncommittedCurrentPublication(repo, gitProbeFault(repo, diagnostic), diagnostic);
  }, 20_000);

  test(`#1165 P1-2 plan writer refuses before saving when Git probe fails: ${failure}`, () => {
    const repo = planFixture();
    seed(repo);
    const initial = head(repo);
    const original = bytes(repo, PROJECT);
    put(repo, PLAN, 'Keep the joint line along the outline.\n');
    const refused = cli(gitProbeFault(repo, diagnostic), 'plan', 'propose', 'parts', repo.dir, '--file', PLAN, '--by', OPERATOR);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/PROJECT_COMMIT_FAILED:/);
    expect(refused.stderr).not.toMatch(/WARN PROJECT_COMMIT_FAILED:/);
    expect(bytes(repo, PROJECT)).toEqual(original);
    expect(git(repo, 'ls-files', '--stage', '--', PLAN)).toBe('');
    expect(head(repo)).toBe(initial);
  });
}

test('#1165 P1-2 job open skips both commits when only manifest inspection fails', async () => {
  const repo = currentFixture();
  seed(repo);
  const faulty = gitWrapper(repo, `ls_files=false
manifest=false
for arg do
  case "$arg" in
    ls-files) ls_files=true ;;
    "$RIG_TEST_MANIFEST") manifest=true ;;
  esac
done
if "$ls_files" && "$manifest"; then
  printf '%s\\n' 'fatal: synthetic manifest inspection failure' >&2
  exit 128
fi`, { RIG_TEST_MANIFEST: CURRENT_LIVE_MANIFEST });
  expect(head(faulty)).toBe(head(repo));
  await expectUncommittedCurrentPublication(repo, faulty, 'synthetic manifest inspection failure');
}, 20_000);

test('#1165 P1-2 job open skips both commits when private Git excludes cannot be inspected', async () => {
  const repo = currentFixture();
  seed(repo);
  const exclude = '.git/info/exclude';
  const before = bytes(repo, exclude);
  const faulty = gitWrapper(repo, `for arg do
  if [ "$arg" = --git-path ]; then
    printf '%s\\n' 'fatal: synthetic excludes inspection failure' >&2
    exit 128
  fi
done`);
  await expectUncommittedCurrentPublication(repo, faulty, 'synthetic excludes inspection failure');
  expect(bytes(repo, exclude)).toEqual(before);
}, 20_000);

test('#1165 current publication leaves a live closure edit unstaged and lists the old publish as legacy', async () => {
  const repo = currentFixture();
  const liveModel = bytes(repo, MODEL);
  put(repo, MODEL, `${liveModel.toString().trimEnd()}\n\n`);
  const subject = `publish: current rig ${sha256(bytes(repo, PROJECT)).slice(0, 12)}`;
  seed(repo, subject, [MODEL]);
  const legacy = head(repo);
  const oldModel = git(repo, 'show', `HEAD:${MODEL}`);
  expect(oldModel).not.toBe(liveModel.toString());
  put(repo, MODEL, liveModel);
  const unrelated = plantUnrelatedChanges(repo);

  await withPublication(repo, ['--current', 'rig'], /\njob: current rig published \(publication [^)]+\)\n/, stdout => {
    step(repo, legacy, /^job open:/, [PROJECT], unrelated);
    expect(stdout).toMatch(/WARN PROJECT_COMMIT_FAILED:.*skeleton\.model\.json differs from the publication input at HEAD/);
    expect(git(repo, 'show', `HEAD:${MODEL}`)).toBe(oldModel);
    expect(bytes(repo, MODEL)).toEqual(liveModel);
    expect(git(repo, 'status', '--porcelain', '--', MODEL)).toBe(` M ${MODEL}\n`);
    expect(bytes(repo, CURRENT_LIVE_MANIFEST).length).toBeGreaterThan(0);

    const acknowledgments = join(jobPrivateRoot(repo.dir), 'acknowledged-publications');
    const [receiptFile] = readdirSync(acknowledgments);
    const receipt = JSON.parse(readFileSync(join(acknowledgments, receiptFile!), 'utf8')) as AcknowledgedPublication;
    expect(receipt.result.selector).toMatchObject({ kind: 'current', output: 'rig' });
    expect(historyEntries(repo)).toContainEqual(expect.objectContaining({ sha: legacy, subject, attribution: 'unverified' }));
    const history = success(cli(repo, 'history', repo.dir));
    expect(history.split('\n').find(line => line.includes(subject))).toMatch(/legacy.*unverified/i);
  });
}, 20_000);

test('#1165 plan proposal preserves its output contract outside Git', () => {
  const repo = planFixture();
  put(repo, PLAN, 'Keep the joint line along the outline.\n');
  const result = cli(repo, 'plan', 'propose', 'parts', repo.dir, '--file', PLAN, '--by', OPERATOR);
  success(result);
  expect(result.stderr).toBe('');
  expect(arr(obj(json(repo, PROJECT).interview).step_plans).at(-1)).toMatchObject({ path: PLAN });
  expect(existsSync(join(repo.dir, '.git'))).toBe(false);
});

test('#1165 P2-6 baseline names HISTORY_BASELINE_FAILED when the scoped commit fails', () => {
  const repo = planFixture();
  seed(repo);
  const initial = head(repo);
  const unrelated = plantUnrelatedChanges(repo);
  putJson(repo, PROJECT, { ...json(repo, PROJECT), title: 'Reviewed baseline contents' });
  const saved = bytes(repo, PROJECT);
  const index = git(repo, 'ls-files', '--stage', '--', PROJECT);
  const args = ['history', 'baseline', repo.dir, '--by', OPERATOR];

  const refused = cli(commitFault(repo, 'history baseline'), ...args);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/HISTORY_BASELINE_FAILED:.*synthetic scoped commit failure/);
  expect(bytes(repo, PROJECT)).toEqual(saved);
  expect(head(repo)).toBe(initial);
  expect(git(repo, 'ls-files', '--stage', '--', PROJECT)).toBe(index);
  expect(unrelatedSnapshot(repo)).toEqual(unrelated);

  success(cli(repo, ...args));
  step(repo, initial, /baseline/i, [PROJECT], unrelated);
});

test('#1165 P2-6 baseline refuses differing staged and work-tree contents', () => {
  const repo = planFixture();
  seed(repo);
  const initial = head(repo);
  const original = json(repo, PROJECT);
  putJson(repo, PROJECT, { ...original, title: 'Staged baseline contents' });
  git(repo, 'add', '--', PROJECT);
  const staged = git(repo, 'show', `:${PROJECT}`);
  putJson(repo, PROJECT, { ...original, title: 'Different work-tree contents' });
  const worktree = bytes(repo, PROJECT);
  expect(staged).not.toBe(worktree.toString());
  expect(git(repo, 'status', '--porcelain', '--', PROJECT)).toBe(`MM ${PROJECT}\n`);

  const refused = cli(repo, 'history', 'baseline', repo.dir, '--by', OPERATOR);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/PROJECT_COMMIT_DIRTY:.*project\.json.*staged and work-tree contents differ/);
  expect(head(repo)).toBe(initial);
  expect(git(repo, 'show', `:${PROJECT}`)).toBe(staged);
  expect(bytes(repo, PROJECT)).toEqual(worktree);
});

test('#1165 baseline clears a dead plan writer lock after its record was saved', async () => {
  const repo = planFixture();
  seed(repo);
  const original = json(repo, PROJECT);
  putJson(repo, PROJECT, { ...original, title: 'Saved by the interrupted writer' });
  const deadWriter = Bun.spawn(['/bin/sh', '-c', 'exit 0']);
  expect(await deadWriter.exited).toBe(0);
  const lock = join(repo.dir, '.plan.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, `${deadWriter.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`), '');

  success(cli(repo, 'history', 'baseline', repo.dir, '--by', OPERATOR));
  expect(existsSync(lock)).toBe(false);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(historyEntries(repo)).toEqual([expect.objectContaining({ command: 'history baseline', attribution: 'unverified' })]);
});
