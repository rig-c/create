import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freshProjectRecord, GITIGNORE } from '../src/init.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { TEST_NOW } from './clock.ts';
import { gitEnv, run, tempDir, type Run } from './helpers.ts';

const PROJECT = 'project.json';
const UNRELATED = 'unrelated-notes.txt';
const CLOCKED_CLI = join(import.meta.dir, 'cli-at.ts');

export type Repo = { dir: string; env: Record<string, string> };
export type HistoryRow = { sha: string; subject: string; command?: string; attribution?: string };

function success(result: Run): string {
  expect({ code: result.code, stderr: result.code === 0 ? '' : result.stderr }).toEqual({ code: 0, stderr: '' });
  return result.stdout;
}

function git(repo: Repo, ...args: string[]): string {
  return success(run(['git', '--literal-pathspecs', ...args], repo.dir, repo.env));
}

function cli(repo: Repo, ...args: string[]): Run {
  return run([process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, new Date(TEST_NOW).toISOString(), ...args], repo.dir, repo.env);
}

function bytes({ dir }: Repo, path: string): Buffer {
  return readFileSync(join(dir, path));
}

function put({ dir }: Repo, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function putJson(repo: Repo, path: string, value: JsonObject): void {
  put(repo, path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeRepo(record: JsonObject = freshProjectRecord('synthetic-writers', TEST_NOW)): Repo {
  const dir = join(tempDir(), 'project');
  const repo = { dir, env: gitEnv({ name: 'Synthetic Writer', email: 'writer@example.test' }) };
  put(repo, '.gitignore', GITIGNORE);
  putJson(repo, PROJECT, record);
  put(repo, UNRELATED, 'initial unrelated\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '--', '.gitignore', PROJECT, UNRELATED);
  git(repo, 'commit', '-qm', 'Seed synthetic project');
  return repo;
}

function head(repo: Repo): string {
  return git(repo, 'rev-parse', 'HEAD').trim();
}

function committedPaths(repo: Repo): string[] {
  return git(repo, 'show', '--format=', '--name-only', '--no-renames', '-z', 'HEAD').split('\0').filter(Boolean).sort();
}

function plantUnrelated(repo: Repo) {
  put(repo, UNRELATED, 'staged unrelated edit\n');
  git(repo, 'add', '--', UNRELATED);
  put(repo, UNRELATED, 'unstaged unrelated edit\n');
  expect(git(repo, 'status', '--porcelain', '--', UNRELATED)).toBe(`MM ${UNRELATED}\n`);
  return snapshot(repo);
}

function snapshot(repo: Repo) {
  return {
    unrelatedStage: git(repo, 'ls-files', '--stage', '--', UNRELATED),
    unrelatedIndex: git(repo, 'show', `:${UNRELATED}`),
    unrelatedWorktree: bytes(repo, UNRELATED),
  };
}

function fullState(repo: Repo) {
  return {
    head: head(repo),
    index: git(repo, 'ls-files', '--stage'),
    status: git(repo, 'status', '--porcelain', '-z'),
    project: bytes(repo, PROJECT),
    unrelated: bytes(repo, UNRELATED),
  };
}

function assertCommittedStep(
  repo: Repo,
  parent: string,
  command: string,
  declaredPaths: readonly string[],
  unrelatedBefore: ReturnType<typeof snapshot>,
): string {
  const sha = head(repo);
  expect(sha).not.toBe(parent);
  expect(git(repo, 'rev-parse', 'HEAD^').trim()).toBe(parent);
  const subject = git(repo, 'show', '--format=%s', '-s', 'HEAD').trim();
  expect(subject.startsWith(`${command}: `)).toBe(true);
  expect(committedPaths(repo)).toEqual([...declaredPaths].sort());
  for (const path of declaredPaths) {
    expect(git(repo, 'show', `HEAD:${path}`)).toBe(bytes(repo, path).toString());
  }
  expect(snapshot(repo)).toEqual(unrelatedBefore);
  const rows = JSON.parse(success(cli(repo, 'history', repo.dir, '--json'))) as HistoryRow[];
  const entry = rows.find(row => row.sha === sha);
  expect(entry).toMatchObject({ sha, command });
  expect(entry?.subject.startsWith(`${command}: `)).toBe(true);
  return sha;
}

function assertRefusedUnchanged(repo: Repo, args: string[], expectedCode: string): void {
  const before = fullState(repo);
  const result = cli(repo, ...args);
  expect(result.code).toBeGreaterThan(0);
  expect(result.stderr).toContain(expectedCode);
  expect(fullState(repo)).toEqual(before);
}

test('#1168 group 1: input add, input painting, and owner-language set commit exact paths and preserve refused/no-op invariants', () => {
  const repo = makeRepo();
  const unrelated = plantUnrelated(repo);
  let parent = head(repo);

  // Refused input add leaves HEAD, index and tree unchanged.
  assertRefusedUnchanged(repo, ['input', 'add', 'inputs/missing.png', repo.dir, '--origin', 'missing'], 'INPUT_FILE_UNREADABLE');

  const source = 'inputs/painting.png';
  const paintingBytes = readFileSync(join(import.meta.dir, '..', 'templates', 'example-current', source));
  put(repo, source, paintingBytes);
  success(cli(repo, 'input', 'add', source, repo.dir, '--origin', 'synthetic source'));
  parent = assertCommittedStep(repo, parent, 'input add', [PROJECT, source], unrelated);

  // Refused input painting leaves HEAD, index and tree unchanged.
  assertRefusedUnchanged(repo, ['input', 'painting', 'inputs/unknown.png', repo.dir], 'INPUT_PAINTING_UNREGISTERED');

  success(cli(repo, 'input', 'painting', source, repo.dir));
  parent = assertCommittedStep(repo, parent, 'input painting', [PROJECT], unrelated);

  // Dirty project.json refuses before writing on input painting / owner-language set.
  const cleanProject = bytes(repo, PROJECT);
  put(repo, PROJECT, `${cleanProject.toString().trimEnd()}\n\n`);
  assertRefusedUnchanged(repo, ['owner-language', 'set', 'ko', repo.dir], 'PROJECT_COMMIT_DIRTY');
  put(repo, PROJECT, cleanProject);

  // Invalid language refuses without touching HEAD, index or tree.
  assertRefusedUnchanged(repo, ['owner-language', 'set', 'ko_KR', repo.dir], 'OWNER_LANGUAGE_INVALID');

  success(cli(repo, 'owner-language', 'set', 'ko', repo.dir));
  parent = assertCommittedStep(repo, parent, 'owner-language set', [PROJECT], unrelated);

  // Unchanged retry makes no commit.
  const beforeRetry = fullState(repo);
  success(cli(repo, 'owner-language', 'set', 'ko', repo.dir));
  expect(fullState(repo)).toEqual(beforeRetry);
});
