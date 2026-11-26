import { beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { CLI, gitEnv, tempDir, treeDigest } from './helpers.ts';

const SCENE = 'specs/direction/scene.json';
const DIRECTION = 'specs/direction/direction.json';
const PART = 'outputs/parts/example.txt';
const FIRST = '2026-11-25T09:12:04Z';
let env: Record<string, string>;

beforeEach(() => {
  env = gitEnv({ name: 'History Fixture', email: 'fixture@example.test' });
});

function git(cwd: string, args: string[], at = FIRST): string {
  const result = Bun.spawnSync(['git', '--literal-pathspecs', ...args], {
    cwd, env: { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
  expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
  return result.stdout.toString().trim();
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
}

function put(dir: string, path: string, content: string): void {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function commit(dir: string, message: string, paths: string[], at = FIRST): string {
  git(dir, ['add', '--', ...paths]);
  git(dir, ['commit', '--only', '-qm', message, '--', ...paths], at);
  return git(dir, ['rev-parse', 'HEAD']);
}

function stepMessage(dir: string, subject: string, writer: string, paths: string[]): string {
  const changed = paths.map(path => {
    const sha = createHash('sha256').update(readFileSync(join(dir, path))).digest('hex');
    return `changed: ${/[\r\n]/.test(path) ? JSON.stringify(path) : path} ${sha.slice(0, 12)}`;
  });
  return [subject, '', `writer: rig-create ${writer}`, ...changed, 'stale: none', 'create: @rig-c/create 1.24.0'].join('\n');
}

function history(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, 'history', ...args], { cwd, env });
  return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// Stub next while exercising the real printed command in a synthetic repository.
function runBack(cwd: string, back: string) {
  const bin = tempDir();
  writeFileSync(join(bin, 'rig-create'), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
  return Bun.spawnSync(['sh', '-c', back], { cwd, env: { ...env, PATH: bin + delimiter + env.PATH } });
}

test('history prints exact text and JSON, preserves the work tree and index, and quotes a usable back command', () => {
  const root = realpathSync(tempDir());
  const dir = join(root, "fixture's rig");
  mkdirSync(dir);
  initRepo(dir);
  put(dir, 'project.json', 'initial project');
  put(dir, PART, 'initial part');
  put(dir, 'specs/rig/config.json', 'initial config');
  commit(dir, 'Initialize fixture', ['project.json', PART, 'specs/rig/config.json']);

  put(dir, 'project.json', 'recorded parts');
  put(dir, PART, 'recorded part');
  const subject = 'parts: add a step';
  const partChanges = ['project.json', PART];
  const parts = commit(dir, stepMessage(dir, subject, 'record parts --from outputs/parts --config specs/rig/config.json', partChanges), partChanges);
  put(dir, SCENE, 'recorded scene');
  const sceneSubject = `scene: write ${SCENE}`;
  const scene = commit(dir, stepMessage(dir, sceneSubject, 'scene write --compose-scene specs/input.json', [SCENE]),
    [SCENE], '2026-11-25T10:23:00+01:00');

  put(dir, 'project.json', 'local project edit');
  put(dir, PART, 'local parts edit');
  put(dir, 'unrelated.txt', 'staged bytes');
  git(dir, ['add', '--', 'unrelated.txt']);
  const before = treeDigest(dir);
  const partsShort = parts.slice(0, 8);
  const sceneShort = scene.slice(0, 8);
  const quoted = "'" + dir.replaceAll("'", "'\\''") + "'";
  const back = (sha: string) => `git -C ${quoted} checkout ${sha} -- specs outputs/parts && rig-create next ${quoted}`;
  expect(history(dir)).toEqual({ exit: 0, stderr: '', stdout:
    `${sceneShort}  2026-11-25T09:23:00Z  ${sceneSubject}\n  back: ${back(sceneShort)}\n`
    + `${partsShort}  ${FIRST}  ${subject}\n  back: ${back(partsShort)}\n` });
  const json = history(root, '--json', "fixture's rig");
  expect(json.exit).toBe(0);
  expect(json.stderr).toBe('');
  expect(JSON.parse(json.stdout)).toEqual([
    { sha: scene, short_sha: sceneShort, at: '2026-11-25T09:23:00Z', subject: sceneSubject, back: back(sceneShort) },
    { sha: parts, short_sha: partsShort, at: FIRST, subject, back: back(partsShort) },
  ]);
  expect(treeDigest(dir)).toEqual(before);

  const restore = runBack(root, back(partsShort));
  expect([restore.exitCode, restore.stdout.toString(), restore.stderr.toString()]).toEqual([0, `next\n${dir}\n`, '']);
  expect(readFileSync(join(dir, PART), 'utf8')).toBe('recorded part');
  expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe('local project edit');
  expect(git(dir, ['rev-parse', 'HEAD'])).toBe(scene);
});

test('history accepts #1018 spec and record commits and checks the owning collection member', () => {
  const root = tempDir();
  initRepo(root);
  const member = "members/a[1]'s rig";
  const other = 'members/other';
  const dir = join(root, member);
  const sibling = join(root, other);
  put(root, 'collection.json', '{}');
  put(dir, 'project.json', 'member record');
  put(sibling, 'project.json', 'sibling record');
  commit(root, 'Initialize collection', ['collection.json', `${member}/project.json`, `${other}/project.json`]);

  put(dir, SCENE, 'member scene');
  commit(dir, stepMessage(dir, `scene: write ${SCENE}`, 'scene write --compose-scene specs/input.json', [SCENE]), [SCENE]);
  put(dir, DIRECTION, 'member direction');
  commit(dir, stepMessage(dir, `direction: write ${DIRECTION}`, 'direction write --file specs/intent.json', [DIRECTION]), [DIRECTION]);
  put(dir, 'project.json', 'member motion');
  commit(dir, stepMessage(dir, 'motion: record current output', 'record motion --from outputs/motion.next', ['project.json']),
    ['project.json']);
  put(dir, 'outputs/direction/tracked.txt', 'initially tracked');
  commit(dir, 'Track an output', ['outputs/direction/tracked.txt']);
  put(dir, 'project.json', 'member direction output');
  // #1018 listed its whole writer scope, including unchanged tracked files.
  commit(dir, stepMessage(dir, 'direction: record current output',
    'record direction --from outputs/direction.next --direction specs/direction/direction.json',
    ['project.json', 'outputs/direction/tracked.txt']), ['project.json']);
  const rigPath = 'outputs/rig/tracked\nfile.txt';
  put(dir, rigPath, 'rig output');
  commit(dir, stepMessage(dir, 'rig: update output', 'record rig --from outputs/rig --config specs/rig/config.json', [rigPath]),
    [rigPath]);
  put(sibling, 'project.json', 'sibling motion');
  commit(sibling, stepMessage(sibling, 'motion: record current output', 'record motion --from outputs/motion.next', ['project.json']),
    ['project.json']);

  // Valid-looking metadata in a cross-member commit cannot claim the target record.
  put(dir, 'project.json', 'manual member edit');
  put(sibling, 'project.json', 'manual sibling edit');
  const mixed = stepMessage(dir, 'rig: mixed member edit', 'record rig --from outputs/rig --config specs/rig/config.json', ['project.json']);
  commit(root, mixed, [`${member}/project.json`, `${other}/project.json`]);
  put(dir, 'project.json', 'manual recovery');
  commit(root, 'motion: manual recovery\n\nwriter: rig-create record motion --from outputs/motion', [`${member}/project.json`]);
  put(dir, SCENE, 'hand-edited scene');
  const wrongScope = stepMessage(dir, 'motion: wrong writer path', 'record motion --from outputs/motion', ['project.json']);
  commit(root, wrongScope, [`${member}/${SCENE}`]);

  const before = treeDigest(root);
  const result = history(root, member, '--json');
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe('');
  expect((JSON.parse(result.stdout) as { subject: string }[]).map(entry => entry.subject)).toEqual([
    'rig: update output', 'direction: record current output', 'motion: record current output', `direction: write ${DIRECTION}`, `scene: write ${SCENE}`,
  ]);
  expect(treeDigest(root)).toEqual(before);

  // This early spec commit lacks outputs/parts, so the §4.4 checkout fails before next.
  const entries = JSON.parse(result.stdout) as { back: string }[];
  const early = runBack(root, entries.at(-1)!.back);
  expect(early.exitCode).toBe(1);
  expect(early.stdout.toString()).toBe('');
  expect(early.stderr.toString()).toContain('outputs/parts');
});

test('history warns with zero stdout in text and JSON modes without a work tree or matching commits', () => {
  const root = tempDir();
  const dir = join(root, 'project');
  put(dir, 'project.json', 'record');
  for (const target of [dir, join(dir, 'missing')]) {
    const before = treeDigest(root);
    const result = history(root, target);
    expect(result).toEqual({ exit: 0, stdout: '', stderr: expect.stringContaining('WARN PROJECT_NOT_IN_GIT:') });
    expect(treeDigest(root)).toEqual(before);
  }

  initRepo(root);
  {
    const before = treeDigest(root);
    const result = history(root, '--json');
    expect(result).toEqual({ exit: 0, stdout: '', stderr: expect.stringContaining('WARN PROJECT_NOT_IN_GIT:') });
    expect(treeDigest(root)).toEqual(before);
  }
  // An ordinary enclosing repository does not count as a project repository.
  commit(root, stepMessage(dir, 'parts: sample', 'record parts --from outputs/parts --config specs/rig/config.json', ['project.json']), ['project/project.json']);
  const before = treeDigest(root);
  for (const result of [history(root, dir), history(root, '--json')]) {
    expect(result).toEqual({ exit: 0, stdout: '', stderr: expect.stringContaining('WARN PROJECT_NOT_IN_GIT:') });
  }
  expect(treeDigest(root)).toEqual(before);
});

test('history rejects unsupported options and extra directories', () => {
  const root = tempDir();
  for (const args of [['--unknown'], ['first', 'second']]) {
    expect(history(root, ...args)).toEqual({ exit: 2, stdout: '', stderr: expect.stringContaining('HISTORY_USAGE') });
  }
});
