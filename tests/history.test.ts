import { beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { historyCommand } from '../src/history.ts';
import { commitProjectStep, stepCommitSubject } from '../src/project-step-commit.ts';
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
  const textResult = history(root, member);
  const result = history(root, member, '--json');
  expect(textResult.exit).toBe(0);
  expect(textResult.stderr).toBe('');
  expect(textResult.stdout).not.toContain('\n  back: ');
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe('');
  const entries = JSON.parse(result.stdout) as { subject: string; back: string | null }[];
  expect(entries.map(entry => entry.subject)).toEqual([
    'rig: update output', 'direction: record current output', 'motion: record current output', `direction: write ${DIRECTION}`, `scene: write ${SCENE}`,
  ]);
  // Every commit above lacks outputs/parts in this member's tree, so none gets a broken back command.
  expect(entries.map(entry => entry.back)).toEqual([null, null, null, null, null]);
  expect(treeDigest(root)).toEqual(before);

  // Once the member records outputs/parts alongside its existing specs/, later commits carry a runnable back line.
  put(dir, PART, 'member part');
  const withParts = commit(dir, stepMessage(dir, 'parts: add example', 'record parts --from outputs/parts.next --config specs/rig/config.json', [PART]),
    [PART], '2026-11-25T10:00:00Z');
  const realDir = realpathSync(dir);
  const quotedMember = "'" + realDir.replaceAll("'", "'\\''") + "'";
  const updated = JSON.parse(history(root, member, '--json').stdout) as { short_sha: string; back: string | null }[];
  expect(updated[0]).toMatchObject({
    short_sha: withParts.slice(0, 8),
    back: `git -C ${quotedMember} checkout ${withParts.slice(0, 8)} -- specs outputs/parts && rig-create next ${quotedMember}`,
  });
  expect(updated.slice(1).map(entry => entry.back)).toEqual([null, null, null, null, null]);
  put(dir, PART, 'local overwrite');
  const memberRestore = runBack(root, updated[0]!.back!);
  expect([memberRestore.exitCode, memberRestore.stdout.toString(), memberRestore.stderr.toString()]).toEqual([0, `next\n${realDir}\n`, '']);
  expect(readFileSync(join(dir, PART), 'utf8')).toBe('member part');
}, 20_000);

test('#1038 older-project history omits back before both specs and outputs/parts exist and commits descriptive subjects', () => {
  const dir = realpathSync(tempDir());
  initRepo(dir);
  git(dir, ['config', 'user.name', 'History Fixture']);
  git(dir, ['config', 'user.email', 'fixture@example.test']);
  put(dir, '.gitignore', '/outputs/*\n!/outputs/parts/\n');
  put(dir, 'project.json', '{"stage":"post"}\n');
  commit(dir, 'Seed older project before current parts', ['.gitignore', 'project.json'], '2026-11-25T08:00:00Z');

  const withCommitClock = <T>(iso: string, fn: () => T): T => {
    const prevAuthor = process.env.GIT_AUTHOR_DATE;
    const prevCommitter = process.env.GIT_COMMITTER_DATE;
    process.env.GIT_AUTHOR_DATE = iso;
    process.env.GIT_COMMITTER_DATE = iso;
    try { return fn(); }
    finally {
      if (prevAuthor === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = prevAuthor;
      if (prevCommitter === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = prevCommitter;
    }
  };

  // 1. Pre-parts motion commit: tree lacks both specs and outputs/parts.
  const rigModelSha = '15146157bfafc565b4eb0da7b66195283504692dc06d512dc404fd8f5849aa7e';
  put(dir, 'project.json', '{"stage":"post","step":1}\n');
  expect(withCommitClock('2026-11-25T08:10:00Z', () =>
    commitProjectStep(dir, 'motion', 'record motion --from outputs/motion.next', 'project.json', 'outputs/motion', [], {
      filesSha256: '06dbcd27bf34a3d9231367d0a3a070a8a30e061fe11316ce6abe82bd7e09e67b',
      builtFrom: [{ path: 'outputs/rig/check/build/skeleton.model.json', sha256: rigModelSha }],
    }))).toBeUndefined();

  // 2. Pre-parts scene commit: tree now has specs/, still lacks outputs/parts.
  put(dir, SCENE, '{"schema":"rig-create/scene@2"}\n');
  expect(withCommitClock('2026-11-25T08:20:00Z', () =>
    commitProjectStep(dir, 'scene', `scene write --compose-scene specs/direction/compose-scene.json`, SCENE))).toBeUndefined();

  // 3. Converse check: a commit whose tree has outputs/parts without specs also gets no back line.
  const noSpecsDir = realpathSync(tempDir());
  initRepo(noSpecsDir);
  git(noSpecsDir, ['config', 'user.name', 'History Fixture']);
  git(noSpecsDir, ['config', 'user.email', 'fixture@example.test']);
  put(noSpecsDir, '.gitignore', '/outputs/*\n!/outputs/parts/\n');
  put(noSpecsDir, 'project.json', '{"stage":"parts"}\n');
  commit(noSpecsDir, 'Seed without specs', ['.gitignore', 'project.json'], '2026-11-25T08:00:00Z');
  put(noSpecsDir, 'project.json', '{"stage":"parts","step":1}\n');
  put(noSpecsDir, 'outputs/parts/rig/parts/torso.png', 'torso');
  expect(withCommitClock('2026-11-25T08:05:00Z', () =>
    commitProjectStep(noSpecsDir, 'parts', 'record parts --from outputs/parts.next --config config.json', 'project.json', 'outputs/parts', [], {
      partsFiles: ['outputs/parts/rig/parts/torso.png'],
      filesSha256: 'aaaa0000'.repeat(8),
      builtFrom: [{ path: 'config.json', sha256: 'bbbb1111'.repeat(8) }],
    }))).toBeUndefined();
  expect(JSON.parse(historyCommand([noSpecsDir, '--json']).stdout)).toEqual([
    expect.objectContaining({ subject: 'parts: add torso', back: null }),
  ]);

  // 4. First record parts commit on the older project (now both specs/ and outputs/parts/ exist).
  put(dir, 'specs/rig/config.json', '{"bones":[]}\n');
  git(dir, ['add', '--', 'specs/rig/config.json']);
  git(dir, ['commit', '--only', '-qm', 'Add rig config', '--', 'specs/rig/config.json'], '2026-11-25T08:25:00Z');
  const configSha = createHash('sha256').update('{"bones":[]}\n').digest('hex');
  const basePartsSha = 'd93e07d90bb34132c296265585160cb37009cfac3c4eda0c19114636ddb41dca';
  put(dir, 'project.json', '{"stage":"parts","step":2}\n');
  put(dir, 'outputs/parts/rig/parts/face.png', 'face-v1');
  put(dir, 'outputs/parts/rig/parts/torso.png', 'torso-v1');
  expect(withCommitClock('2026-11-25T08:30:00Z', () =>
    commitProjectStep(dir, 'parts', 'record parts --from outputs/parts.next --config specs/rig/config.json', 'project.json', 'outputs/parts', ['rig'], {
      partsFiles: ['outputs/parts/rig/parts/face.png', 'outputs/parts/rig/parts/torso.png'],
      filesSha256: basePartsSha,
      builtFrom: [{ path: 'specs/rig/config.json', sha256: configSha }],
    }))).toBeUndefined();

  // 5. Initial current.rig build from base parts + config.
  put(dir, 'project.json', '{"stage":"rigging","step":3}\n');
  expect(withCommitClock('2026-11-25T08:35:00Z', () =>
    commitProjectStep(dir, 'rig', 'record rig --from outputs/rig.next --config specs/rig/config.json', 'project.json', 'outputs/rig', ['motion'], {
      filesSha256: 'a1493faa8c4de2e13339b7f8cd5919693bb76805cd277b212ac9107efda9673a',
      builtFrom: [
        { path: 'outputs/parts/rig/parts.json', sha256: basePartsSha },
        { path: 'specs/rig/config.json', sha256: configSha },
      ],
    }))).toBeUndefined();

  // 6. Add eyelids in parts, then rebuild rig from the new parts hash.
  const blinkPartsSha = '3f2a91c09bb34132c296265585160cb37009cfac3c4eda0c19114636ddb41dca';
  put(dir, 'project.json', '{"stage":"parts","step":4}\n');
  put(dir, 'outputs/parts/rig/parts/eyelid_l.png', 'eyelid-l');
  put(dir, 'outputs/parts/rig/parts/eyelid_r.png', 'eyelid-r');
  expect(withCommitClock('2026-11-25T08:40:00Z', () =>
    commitProjectStep(dir, 'parts', 'record parts --from outputs/parts.next --config specs/rig/config.json', 'project.json', 'outputs/parts', ['rig', 'motion'], {
      partsFiles: [
        'outputs/parts/rig/parts/eyelid_l.png',
        'outputs/parts/rig/parts/eyelid_r.png',
        'outputs/parts/rig/parts/face.png',
        'outputs/parts/rig/parts/torso.png',
      ],
      filesSha256: blinkPartsSha,
      builtFrom: [{ path: 'specs/rig/config.json', sha256: configSha }],
      previousBuiltFrom: [{ path: 'specs/rig/config.json', sha256: configSha }],
    }))).toBeUndefined();

  put(dir, 'project.json', '{"stage":"rigging","step":5}\n');
  expect(withCommitClock('2026-11-25T08:45:00Z', () =>
    commitProjectStep(dir, 'rig', 'record rig --from outputs/rig.next --config specs/rig/config.json', 'project.json', 'outputs/rig', ['motion'], {
      filesSha256: 'c2584fbb8c4de2e13339b7f8cd5919693bb76805cd277b212ac9107efda9673a',
      builtFrom: [
        { path: 'outputs/parts/rig/parts.json', sha256: blinkPartsSha },
        { path: 'specs/rig/config.json', sha256: configSha },
      ],
      previousBuiltFrom: [
        { path: 'outputs/parts/rig/parts.json', sha256: basePartsSha },
        { path: 'specs/rig/config.json', sha256: configSha },
      ],
    }))).toBeUndefined();

  const text = historyCommand([dir]);
  const parsed = JSON.parse(historyCommand([dir, '--json']).stdout) as { short_sha: string; at: string; subject: string; back: string | null }[];
  expect(text.exit).toBe(0);
  expect(text.stderr).toBeUndefined();
  expect(parsed.map(entry => ({ subject: entry.subject, hasBack: entry.back !== null }))).toEqual([
    { subject: 'rig: rebuild from parts 3f2a91c0', hasBack: true },
    { subject: 'parts: add eyelid_l, eyelid_r', hasBack: true },
    { subject: `rig: build from parts d93e07d9, config.json ${configSha.slice(0, 8)}`, hasBack: true },
    { subject: 'parts: add face, torso', hasBack: true },
    { subject: `scene: write ${SCENE}`, hasBack: false },
    { subject: 'motion: build from rig 15146157', hasBack: false },
  ]);
  const quoted = "'" + dir.replaceAll("'", "'\\''") + "'";
  expect(text.stdout).toBe([
    `${parsed[0]!.short_sha}  2026-11-25T08:45:00Z  rig: rebuild from parts 3f2a91c0`,
    `  back: git -C ${quoted} checkout ${parsed[0]!.short_sha} -- specs outputs/parts && rig-create next ${quoted}`,
    `${parsed[1]!.short_sha}  2026-11-25T08:40:00Z  parts: add eyelid_l, eyelid_r`,
    `  back: git -C ${quoted} checkout ${parsed[1]!.short_sha} -- specs outputs/parts && rig-create next ${quoted}`,
    `${parsed[2]!.short_sha}  2026-11-25T08:35:00Z  rig: build from parts d93e07d9, config.json ${configSha.slice(0, 8)}`,
    `  back: git -C ${quoted} checkout ${parsed[2]!.short_sha} -- specs outputs/parts && rig-create next ${quoted}`,
    `${parsed[3]!.short_sha}  2026-11-25T08:30:00Z  parts: add face, torso`,
    `  back: git -C ${quoted} checkout ${parsed[3]!.short_sha} -- specs outputs/parts && rig-create next ${quoted}`,
    `${parsed[4]!.short_sha}  2026-11-25T08:20:00Z  scene: write ${SCENE}`,
    `${parsed[5]!.short_sha}  2026-11-25T08:10:00Z  motion: build from rig 15146157`,
  ].join('\n'));
  for (const entry of [parsed[0]!, parsed[3]!]) {
    const res = runBack(dir, entry.back!);
    expect(res.exitCode).toBe(0);
  }
}, 20_000);

test('#1038 stepCommitSubject enforces the 72-char single-line limit across path and upstream combinations', () => {
  expect(stepCommitSubject('parts', 'project.json', 'outputs/parts', [
    { status: 'A', path: 'outputs/parts/rig/parts/eyelid_l.png' },
    { status: 'A', path: 'outputs/parts/rig/parts/eyelid_r.png' },
    { status: 'M', path: 'outputs/parts/rig/parts.json' },
    { status: 'M', path: 'project.json' },
  ])).toBe('parts: add eyelid_l, eyelid_r');

  expect(stepCommitSubject('parts', 'project.json', 'outputs/parts', [
    { status: 'A', path: 'outputs/parts/rig/parts/eyelid_l.png' },
    { status: 'M', path: 'outputs/parts/rig/parts/face.png' },
    { status: 'D', path: 'outputs/parts/rig/parts/lantern.png' },
  ])).toBe('parts: add eyelid_l; update face; remove lantern');

  expect(stepCommitSubject('parts', 'project.json', 'outputs/parts', [
    { status: 'M', path: 'outputs/parts/rig/part_support_domains.json' },
    { status: 'M', path: 'outputs/parts/run.json' },
    { status: 'M', path: 'outputs/parts/check/parts-check.json' },
  ])).toBe('parts: update part_support_domains.json');

  expect(stepCommitSubject('rig', 'project.json', 'outputs/rig', [{ status: 'M', path: 'project.json' }], {
    builtFrom: [
      { path: 'outputs/parts/rig/parts.json', sha256: '3f2a91c0'.repeat(8) },
      { path: 'specs/rig/config.json', sha256: '03bcce31'.repeat(8) },
    ],
    previousBuiltFrom: [
      { path: 'outputs/parts/rig/parts.json', sha256: '11111111'.repeat(8) },
      { path: 'specs/rig/config.json', sha256: '03bcce31'.repeat(8) },
    ],
  })).toBe('rig: rebuild from parts 3f2a91c0');

  expect(stepCommitSubject('direction', 'project.json', 'outputs/direction', [{ status: 'M', path: 'project.json' }], {
    builtFrom: [
      { path: 'outputs/motion', sha256: '06dbcd27'.repeat(8) },
      { path: 'specs/direction/direction.json', sha256: '8a4f12c0'.repeat(8) },
      { path: 'specs/direction/scene.json', sha256: '2e9813b3'.repeat(8) },
    ],
    previousBuiltFrom: [
      { path: 'outputs/motion', sha256: '06dbcd27'.repeat(8) },
      { path: 'specs/direction/direction.json', sha256: '590bcbcb'.repeat(8) },
      { path: 'specs/direction/scene.json', sha256: '2e9813b3'.repeat(8) },
    ],
  })).toBe('direction: rebuild from direction.json 8a4f12c0');

  const many = Array.from({ length: 20 }, (_, i) => ({
    status: 'A',
    path: `outputs/parts/rig/parts/segment_${String(i).padStart(2, '0')}.png`,
  }));
  const manySubject = stepCommitSubject('parts', 'project.json', 'outputs/parts', many);
  expect(manySubject.length).toBeLessThanOrEqual(72);
  expect(manySubject).toMatch(/^parts: add segment_00, .* \(\+\d+\)$/);

  const huge = stepCommitSubject('parts', 'project.json', 'outputs/parts', [
    { status: 'A', path: `outputs/parts/rig/parts/${'very_long_part_identifier_'.repeat(5)}\nnext.png` },
    { status: 'A', path: 'outputs/parts/rig/parts/zz_other.png' },
  ]);
  expect(huge.length).toBeLessThanOrEqual(72);
  expect(huge).not.toContain('\n');
  expect(huge).toEndWith('... (+1)');
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
