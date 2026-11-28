import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { asArray, isObject } from '../src/check.ts';
import { main } from '../src/cli.ts';
import { outputSetHash } from '../src/current.ts';
import {
  enqueuePublication,
  JOB_BINDING_FILE,
  jobHash,
  jobHostStateRoot,
  jobPrivateRoot,
  publicationVersionHash,
  readWriterBinding,
  writePrivateJson,
  type AcknowledgedPublication,
  type WriterBinding,
} from '../src/job-outbox.ts';
import {
  CURRENT_LIVE_MANIFEST,
  currentJobIdentity,
  prepareCurrentManifest,
  prepareLiveManifest,
  readPublished,
} from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { nextProject } from '../src/next.ts';
import { commitCurrentPublication } from '../src/project-step-commit.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { run, treeDigest } from './helpers.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
const EXAMPLE_CURRENT = join(import.meta.dir, '../templates/example-current');
const NOW = EXAMPLE_NOW;

const roots: string[] = [];
const opened: { proc: Bun.Subprocess; root: string }[] = [];

function isolatedGitEnv(): Record<string, string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-current-git-')));
  roots.push(dir);
  const config = join(dir, 'gitconfig');
  writeFileSync(config, '[init]\n\tdefaultBranch = main\n');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
}

afterEach(async () => {
  for (const { proc, root } of opened.splice(0)) {
    if (readWriterBinding(root)) await runCli(root, ['job', 'close', root]);
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
  for (const root of roots.splice(0)) {
    if (existsSync(root)) {
      const state = jobHostStateRoot(root);
      rmSync(state, { recursive: true, force: true });
      if (existsSync(dirname(state))) {
        for (const name of readdirSync(dirname(state))) {
          if (name.startsWith(`${basename(state)}.replaced-`)) {
            rmSync(join(dirname(state), name), { recursive: true, force: true });
          }
        }
      }
      rmSync(jobPrivateRoot(root), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function cloneExampleCurrent(options: { git?: boolean } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-current-')));
  rmSync(root, { recursive: true, force: true });
  cpSync(EXAMPLE_CURRENT, root, { recursive: true });
  roots.push(root);
  if (options.git) {
    const env = isolatedGitEnv();
    expect(run(['git', 'init', '-q'], root, env).code).toBe(0);
    expect(run(['git', 'config', 'user.name', 'Synthetic Test'], root, env).code).toBe(0);
    expect(run(['git', 'config', 'user.email', 'synthetic@example.invalid'], root, env).code).toBe(0);
    expect(run(['git', 'add', '--', 'project.json', '.gitignore', 'inputs', 'specs', 'outputs/parts'], root, env).code).toBe(0);
    expect(run(['git', 'commit', '-q', '-m', 'init synthetic current fixture'], root, env).code).toBe(0);
  }
  return root;
}

async function runCli(
  root: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...isolatedGitEnv(), ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

async function openBackground(root: string, options: string[]): Promise<{ url: URL; lines: string[] }> {
  const proc = Bun.spawn(
    [process.execPath, ...jobRuntimeExecArgv(), CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...options],
    { cwd: root, env: { ...process.env, ...isolatedGitEnv() }, stdout: 'pipe', stderr: 'pipe' },
  );
  opened.push({ proc, root });
  let stderr = '';
  let failedStderr = false;
  let cancelStdout: (() => void) | undefined;
  void (async () => {
    const errReader = proc.stderr.getReader();
    const errDecoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await errReader.read();
        if (chunk.done) break;
        stderr += errDecoder.decode(chunk.value, { stream: true });
        if (/(?:^|\n)[A-Z][A-Z0-9_]+: /.test(stderr)) {
          failedStderr = true;
          cancelStdout?.();
          break;
        }
      }
    } catch { /* Closed on teardown. */ }
    finally { errReader.releaseLock(); }
  })();
  const reader = proc.stdout.getReader();
  cancelStdout = () => { void reader.cancel(); };
  const decoder = new TextDecoder();
  let text = '';
  while (!/\njob: .*\n$/.test(text) && !failedStderr) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  reader.releaseLock();
  const lines = text.trim().split('\n');
  if (failedStderr || !lines[0]?.startsWith('http://') || !lines.some(line => line.startsWith('job: '))) {
    proc.kill('SIGTERM');
    const code = await proc.exited;
    throw new Error(`job open failed (exit ${code}):\nstdout: ${text}\nstderr: ${stderr}`);
  }
  return { url: new URL(lines[0]!), lines: lines.slice(1) };
}

function latestReceipt(root: string): AcknowledgedPublication {
  const jobId = readWriterBinding(root)!.jobId;
  const receipts = join(jobPrivateRoot(root), 'acknowledged-publications');
  return readdirSync(receipts)
    .map(file => JSON.parse(readFileSync(join(receipts, file), 'utf8')) as AcknowledgedPublication)
    .filter(receipt => receipt.jobId === jobId)
    .sort((a, b) => b.generation - a.generation)[0]!;
}

async function openOwnerPage(root: string, url: URL) {
  const jobId = /\/jobs\/([^/]+)\//.exec(url.pathname)![1]!;
  const expected = latestReceipt(root);
  const capability = url.hash.replace('#cap=', '');
  const base = `${url.origin}/jobs/${jobId}/`;
  const headers = { origin: url.origin, 'X-Review-Capability': capability, 'content-type': 'application/json' };
  const abort = new AbortController();
  const response = await fetch(base + 'events', { headers, signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const events: JsonObject[] = [];
  const currentHead = () => events.filter(e => e.type === 'published').at(-1)?.publication as JsonObject | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && currentHead()?.publicationId !== expected.publicationId) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      events.push(JSON.parse(buffered.slice(0, newline)) as JsonObject);
      buffered = buffered.slice(newline + 1);
      if (currentHead()?.publicationId === expected.publicationId) break;
    }
  }
  abort.abort();
  const head = currentHead()!;
  expect(head.publicationId).toBe(expected.publicationId);
  const asks = events.filter(e => e.type === 'pending' && (e.ask as JsonObject).publicationId === head.publicationId);
  const post = async (route: string, body: object) =>
    (await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })).json() as Promise<JsonObject>;
  const pageId = randomUUID();
  const displayed = await post('ui/displayed', {
    publicationId: head.publicationId,
    pageId,
    sourceHash: (head.source as JsonObject).sourceHash,
  });
  expect(displayed.ok).toBe(true);
  let expectedGeneration = Number(events.at(-1)!.generation);
  return {
    head,
    asks,
    submitComment: async (text: string): Promise<JsonObject> => {
      const reply = await post('ui/acts', {
        publicationId: head.publicationId,
        pageId,
        displayedNonce: (displayed.value as JsonObject).displayedNonce,
        expectedGeneration,
        submissionId: randomUUID(),
        kind: 'comments',
        value: { comments: [{ text }] },
      });
      if (reply.ok) expectedGeneration++;
      return reply;
    },
  };
}

test('CLI validates --current options before writes or host startup', () => {
  const root = cloneExampleCurrent();
  const before = treeDigest(root);

  expect(main(['job', 'open', root, '--reviewer', 'owner', '--role', 'owner', '--current', 'rig', '--draft', 'd1'], NOW)).toBe(2);
  expect(main(['job', 'open', root, '--reviewer', 'owner', '--role', 'owner', '--current', 'rig', '--rig', '1'], NOW)).toBe(2);
  expect(main(['job', 'open', root, '--reviewer', 'owner', '--role', 'owner', '--current', 'rig', '--plan'], NOW)).toBe(2);
  expect(main(['job', 'open', root, '--reviewer', 'owner', '--role', 'owner', '--current', 'motion'], NOW)).toBe(2);
  expect(treeDigest(root)).toEqual(before);
  expect(existsSync(join(root, CURRENT_LIVE_MANIFEST))).toBe(false);
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(jobHostStateRoot(root))).toBe(false);
});

test('job open --current refuses missing, malformed, or drifted current outputs before writes or host startup', async () => {
  const missingRoot = cloneExampleCurrent();
  const missingProject = JSON.parse(readFileSync(join(missingRoot, 'project.json'), 'utf8')) as JsonObject;
  delete (missingProject.current as JsonObject).rig;
  writeFileSync(join(missingRoot, 'project.json'), `${JSON.stringify(missingProject, null, 2)}\n`);
  const beforeMissing = treeDigest(missingRoot);

  const missingResult = await runCli(missingRoot, [
    'job', 'open', missingRoot, '--reviewer', 'synthetic-owner', '--role', 'owner', '--current', 'rig',
  ]);
  expect(missingResult.exit).toBe(1);
  expect(missingResult.stderr).toStartWith('JOB_PUBLICATION_INVALID: project.json.current.rig:');
  expect(treeDigest(missingRoot)).toEqual(beforeMissing);
  expect(existsSync(jobHostStateRoot(missingRoot))).toBe(false);

  const driftedRoot = cloneExampleCurrent();
  writeFileSync(join(driftedRoot, 'outputs/parts/rig/parts.json'), '{"corrupted":true}\n');
  const beforeDrifted = treeDigest(driftedRoot);

  const driftedResult = await runCli(driftedRoot, [
    'job', 'open', driftedRoot, '--reviewer', 'synthetic-owner', '--role', 'owner', '--current', 'parts',
  ]);
  expect(driftedResult.exit).toBe(1);
  expect(driftedResult.stderr).toStartWith('JOB_PUBLICATION_INVALID: project.json.current.parts:');
  expect(treeDigest(driftedRoot)).toEqual(beforeDrifted);
  expect(existsSync(jobHostStateRoot(driftedRoot))).toBe(false);

  const malformedRoot = cloneExampleCurrent();
  const malformedProject = JSON.parse(readFileSync(join(malformedRoot, 'project.json'), 'utf8')) as JsonObject;
  ((malformedProject.current as JsonObject).rig as JsonObject).files_sha256 = '0'.repeat(64);
  writeFileSync(join(malformedRoot, 'project.json'), `${JSON.stringify(malformedProject, null, 2)}\n`);
  const beforeMalformed = treeDigest(malformedRoot);

  const malformedResult = await runCli(malformedRoot, [
    'job', 'open', malformedRoot, '--reviewer', 'synthetic-owner', '--role', 'owner', '--current', 'rig',
  ]);
  expect(malformedResult.exit).toBe(1);
  expect(malformedResult.stderr).toStartWith('CURRENT_MALFORMED: current.rig.files_sha256:');
  expect(treeDigest(malformedRoot)).toEqual(beforeMalformed);
  expect(existsSync(jobHostStateRoot(malformedRoot))).toBe(false);

  const badDirectionRoot = cloneExampleCurrent();
  const badDirectionBytes = Buffer.from(`${JSON.stringify({ schema: 'rig-create/direction@3', take: { duration: 4, loop: true } }, null, 2)}\n`);
  writeFileSync(join(badDirectionRoot, 'specs/direction/direction.json'), badDirectionBytes);
  const badDirectionProject = JSON.parse(readFileSync(join(badDirectionRoot, 'project.json'), 'utf8')) as JsonObject;
  const badDirNode = (badDirectionProject.current as JsonObject).direction as JsonObject;
  badDirNode.built_from = asArray(badDirNode.built_from).filter(isObject).map(entry =>
    entry.path === 'specs/direction/direction.json'
      ? { path: 'specs/direction/direction.json', sha256: jobHash(badDirectionBytes) }
      : entry,
  );
  writeFileSync(join(badDirectionRoot, 'project.json'), `${JSON.stringify(badDirectionProject, null, 2)}\n`);
  const beforeBadDirection = treeDigest(badDirectionRoot);

  const badDirectionResult = await runCli(badDirectionRoot, [
    'job', 'open', badDirectionRoot, '--reviewer', 'synthetic-owner', '--role', 'owner', '--current', 'direction',
  ]);
  expect(badDirectionResult.exit).toBe(1);
  expect(badDirectionResult.stderr).toStartWith('JOB_PUBLICATION_INVALID: project.json.current.direction:');
  expect(treeDigest(badDirectionRoot)).toEqual(beforeBadDirection);
  expect(existsSync(jobHostStateRoot(badDirectionRoot))).toBe(false);
});

test('prepareCurrentManifest, readPublished, commitCurrentPublication, and publicationVersionHash obey the current contract', async () => {
  const gitRoot = cloneExampleCurrent({ git: true });
  const recordBytes = readFileSync(join(gitRoot, 'project.json'));
  const recordHash = jobHash(recordBytes);
  const project = JSON.parse(recordBytes.toString('utf8')) as JsonObject;

  // 1. Parts manifest + context + commit binding.
  const partsPrepared = prepareCurrentManifest(gitRoot, project, 'parts', recordHash);
  expect(partsPrepared.path).toBe(CURRENT_LIVE_MANIFEST);
  const partsCommit = commitCurrentPublication(gitRoot, 'parts', recordHash, partsPrepared.closurePaths);
  expect(partsCommit.warning).toBeUndefined();
  expect(partsCommit.commit).toMatch(/^[a-f0-9]{40}$/);

  const partsManifest = JSON.parse(readFileSync(join(gitRoot, CURRENT_LIVE_MANIFEST), 'utf8')) as JsonObject;
  expect(partsManifest).toMatchObject({
    schema: 'rig-review/1',
    id: 'create',
    revision: recordHash.slice(0, 12),
    title: 'current parts',
    animations: [],
    checkpoints: [],
    authoring: [],
    panels: {
      schema: 'rig-review/panels@1',
      left: ['parts.list'],
      stage: ['parts.canvas'],
      toolbar: ['parts.layers'],
      side: ['parts.issues', 'act.submit'],
    },
  });
  expect(Object.hasOwn(partsManifest, 'model')).toBe(false);
  expect(Object.hasOwn(partsManifest, 'direction')).toBe(false);

  const partsSelector = { kind: 'current' as const, output: 'parts' as const, record: recordHash };
  const partsContext = await readPublished({
    root: gitRoot,
    record: { path: 'project.json', sha256: recordHash },
    result: { path: CURRENT_LIVE_MANIFEST, selector: partsSelector as never },
  });
  expect(partsContext).toMatchObject({
    selector: partsSelector,
    plan: null,
    subjects: [],
    commit: partsCommit.commit,
  });
  expect(partsContext.parts).not.toBeNull();
  expect(partsContext.partIds.length).toBeGreaterThan(0);
  for (const forbidden of ['previousDraft', 'previousBuild', 'answeredDirectionFeedback', 'chestLandmarks', 'checkpointEvidence']) {
    expect(Object.hasOwn(partsContext, forbidden)).toBe(false);
  }

  // 2. Rig manifest + context + versionHash stability across project.json edits.
  const rigPrepared = prepareCurrentManifest(gitRoot, project, 'rig', recordHash);
  const rigCommit = commitCurrentPublication(gitRoot, 'rig', recordHash, rigPrepared.closurePaths);
  expect(rigCommit.warning).toBeUndefined();
  expect(rigCommit.commit).toMatch(/^[a-f0-9]{40}$/);

  const rigManifest = JSON.parse(readFileSync(join(gitRoot, CURRENT_LIVE_MANIFEST), 'utf8')) as JsonObject;
  expect(rigManifest).toMatchObject({
    schema: 'rig-review/1',
    id: 'create',
    revision: recordHash.slice(0, 12),
    title: 'current rig',
    model: 'outputs/rig/check/build/skeleton.model.json',
    animations: [],
    checkpoints: [],
    authoring: [],
  });
  expect(Object.hasOwn(rigManifest, 'direction')).toBe(false);

  const rigSelector = { kind: 'current' as const, output: 'rig' as const, record: recordHash };
  const rigContext = await readPublished({
    root: gitRoot,
    record: { path: 'project.json', sha256: recordHash },
    result: { path: CURRENT_LIVE_MANIFEST, selector: rigSelector as never },
  });
  expect(rigContext).toMatchObject({
    selector: rigSelector,
    plan: null,
    parts: null,
    subjects: [],
    partIds: [],
    commit: rigCommit.commit,
  });

  const beforeVersionHash = publicationVersionHash(recordBytes, { path: CURRENT_LIVE_MANIFEST, selector: rigSelector });
  const editedProject = { ...project, title: 'Edited title without touching rig files' };
  const editedBytes = Buffer.from(`${JSON.stringify(editedProject, null, 2)}\n`);
  expect(publicationVersionHash(editedBytes, { path: CURRENT_LIVE_MANIFEST, selector: rigSelector })).toBe(beforeVersionHash);

  // 2b. Direction manifest + context + no scene + versionHash tracks specs/direction/direction.json.
  const directionPrepared = prepareCurrentManifest(gitRoot, project, 'direction', recordHash);
  expect(directionPrepared.closurePaths).toContain('specs/direction/direction.json');
  const directionCommit = commitCurrentPublication(gitRoot, 'direction', recordHash, directionPrepared.closurePaths);
  expect(directionCommit.warning).toBeUndefined();
  expect(directionCommit.commit).toMatch(/^[a-f0-9]{40}$/);

  const directionManifest = JSON.parse(readFileSync(join(gitRoot, CURRENT_LIVE_MANIFEST), 'utf8')) as JsonObject;
  expect(directionManifest).toMatchObject({
    schema: 'rig-review/1',
    id: 'create',
    revision: recordHash.slice(0, 12),
    title: 'current direction',
    model: 'outputs/direction/check/build/skeleton.model.json',
    direction: 'specs/direction/direction.json',
    animations: [],
    checkpoints: [],
    authoring: [],
  });
  expect(Object.hasOwn(directionManifest, 'scene')).toBe(false);

  const directionSelector = { kind: 'current' as const, output: 'direction' as const, record: recordHash };
  const directionContext = await readPublished({
    root: gitRoot,
    record: { path: 'project.json', sha256: recordHash },
    result: { path: CURRENT_LIVE_MANIFEST, selector: directionSelector as never },
  });
  expect(directionContext).toMatchObject({
    selector: directionSelector,
    plan: null,
    parts: null,
    subjects: [],
    partIds: [],
    commit: directionCommit.commit,
  });
  expect(directionContext.files).toContainEqual({
    path: 'specs/direction/direction.json',
    sha256: jobHash(readFileSync(join(gitRoot, 'specs/direction/direction.json'))),
  });
  for (const forbidden of ['previousDraft', 'previousBuild', 'answeredDirectionFeedback', 'chestLandmarks', 'checkpointEvidence']) {
    expect(Object.hasOwn(directionContext, forbidden)).toBe(false);
  }
  const beforeDirectionVersionHash = publicationVersionHash(recordBytes, { path: CURRENT_LIVE_MANIFEST, selector: directionSelector });
  expect(publicationVersionHash(editedBytes, { path: CURRENT_LIVE_MANIFEST, selector: directionSelector })).toBe(beforeDirectionVersionHash);
  const specEditedProject = structuredClone(project);
  const specDirNode = (specEditedProject.current as JsonObject).direction as JsonObject;
  specDirNode.built_from = asArray(specDirNode.built_from).filter(isObject).map(entry =>
    entry.path === 'specs/direction/direction.json' ? { path: 'specs/direction/direction.json', sha256: 'f'.repeat(64) } : entry,
  );
  const specEditedBytes = Buffer.from(`${JSON.stringify(specEditedProject, null, 2)}\n`);
  expect(publicationVersionHash(specEditedBytes, { path: CURRENT_LIVE_MANIFEST, selector: directionSelector })).not.toBe(beforeDirectionVersionHash);

  // 3. Non-git directory warns PROJECT_NOT_IN_GIT and omits commit without blocking readPublished.
  const noGitRoot = cloneExampleCurrent({ git: false });
  const noGitBytes = readFileSync(join(noGitRoot, 'project.json'));
  const noGitHash = jobHash(noGitBytes);
  const noGitProject = JSON.parse(noGitBytes.toString('utf8')) as JsonObject;
  const noGitPrepared = prepareCurrentManifest(noGitRoot, noGitProject, 'rig', noGitHash);
  const noGitCommit = commitCurrentPublication(noGitRoot, 'rig', noGitHash, noGitPrepared.closurePaths);
  expect(noGitCommit).toMatchObject({
    warning: { code: 'PROJECT_NOT_IN_GIT', path: 'project.json' },
  });
  expect(noGitCommit.commit).toBeUndefined();
  const noGitContext = await readPublished({
    root: noGitRoot,
    record: { path: 'project.json', sha256: noGitHash },
    result: { path: CURRENT_LIVE_MANIFEST, selector: { kind: 'current', output: 'rig', record: noGitHash } as never },
  });
  expect(Object.hasOwn(noGitContext, 'commit')).toBe(false);

  // 4. Failed git commit warns PROJECT_COMMIT_FAILED and omits commit when HEAD does not hold the edited project.json.
  writeFileSync(join(gitRoot, 'project.json'), editedBytes);
  const editedHash = jobHash(editedBytes);
  const editedPrepared = prepareCurrentManifest(gitRoot, editedProject, 'rig', editedHash);
  writeFileSync(join(gitRoot, '.git/index.lock'), 'locked\n');
  try {
    const failedCommit = commitCurrentPublication(gitRoot, 'rig', editedHash, editedPrepared.closurePaths);
    expect(failedCommit).toMatchObject({
      warning: { code: 'PROJECT_COMMIT_FAILED', path: 'project.json' },
    });
    expect(failedCommit.commit).toBeUndefined();
    const failedContext = await readPublished({
      root: gitRoot,
      record: { path: 'project.json', sha256: editedHash },
      result: { path: CURRENT_LIVE_MANIFEST, selector: { kind: 'current', output: 'rig', record: editedHash } as never },
    });
    expect(Object.hasOwn(failedContext, 'commit')).toBe(false);
  } finally {
    rmSync(join(gitRoot, '.git/index.lock'), { force: true });
  }
});

test('readPublished omits commit when a matching pending current entry has no commit even if HEAD holds the same project.json', async () => {
  const gitRoot = cloneExampleCurrent({ git: true });
  const recordBytes = readFileSync(join(gitRoot, 'project.json'));
  const recordHash = jobHash(recordBytes);
  const project = JSON.parse(recordBytes.toString('utf8')) as JsonObject;

  // 1. Publish and commit `current parts` so HEAD holds the exact `project.json` (`recordHash`) and the parts manifest.
  const partsPrepared = prepareCurrentManifest(gitRoot, project, 'parts', recordHash);
  const partsCommit = commitCurrentPublication(gitRoot, 'parts', recordHash, partsPrepared.closurePaths);
  expect(partsCommit.warning).toBeUndefined();
  expect(partsCommit.commit).toMatch(/^[a-f0-9]{40}$/);

  // 2. Without modifying `project.json`, prepare `current rig` while `.git/index.lock` forces PROJECT_COMMIT_FAILED.
  const rigPrepared = prepareCurrentManifest(gitRoot, project, 'rig', recordHash);
  const binding: WriterBinding = {
    schema: 'rig-create/job-binding@1',
    identity: currentJobIdentity({
      root: gitRoot,
      stateDir: join(jobHostStateRoot(gitRoot), 'host'),
      fingerprint: 'rig-create/live-review/1',
      reviewer: { id: 'synthetic-owner', role: 'owner' },
      publicationMode: 'record-and-package',
    }, gitRoot),
    jobId: 'synthetic-job',
    origin: 'http://127.0.0.1:9',
    fetchCapability: 'cap',
    listenerIncarnation: 'incarnation',
  };
  writePrivateJson(join(gitRoot, JOB_BINDING_FILE), binding, true);

  writeFileSync(join(gitRoot, '.git/index.lock'), 'locked\n');
  try {
    const failedRigCommit = commitCurrentPublication(gitRoot, 'rig', recordHash, rigPrepared.closurePaths);
    expect(failedRigCommit).toMatchObject({
      warning: { code: 'PROJECT_COMMIT_FAILED', path: 'project.json' },
    });
    expect(failedRigCommit.commit).toBeUndefined();

    const rigSelector = { kind: 'current' as const, output: 'rig' as const, record: recordHash };
    const pending = enqueuePublication(
      gitRoot,
      binding,
      { path: CURRENT_LIVE_MANIFEST, selector: rigSelector },
      undefined,
      failedRigCommit.commit,
    );
    expect(pending.commit).toBeUndefined();

    const rigContext = await readPublished({
      root: gitRoot,
      record: { path: 'project.json', sha256: recordHash },
      result: { path: CURRENT_LIVE_MANIFEST, selector: rigSelector as never },
    });
    expect(Object.hasOwn(rigContext, 'commit')).toBe(false);
    expect(rigContext.commit).toBeUndefined();
  } finally {
    rmSync(join(gitRoot, '.git/index.lock'), { force: true });
  }
});

test('next offers optional job open --current moves beside advance after record parts, record rig and record direction, and leaves numbered projects unchanged', () => {
  const root = cloneExampleCurrent();
  const recordPath = join(root, 'project.json');
  const full = JSON.parse(readFileSync(recordPath, 'utf8')) as JsonObject;

  // 1. At `parts` after `record parts`: advance comes first, optional `--current parts` sits beside it, and `awaits` stays `['project.stage']`.
  const atParts = structuredClone(full);
  atParts.stage = 'parts';
  atParts.signoffs = asArray(atParts.signoffs).slice(0, 2);
  atParts.advances = asArray(atParts.advances).slice(0, 2);
  delete (atParts.current as JsonObject).rig;
  delete (atParts.current as JsonObject).motion;
  delete (atParts.current as JsonObject).direction;
  (atParts.plan as JsonObject).steps = asArray((atParts.plan as JsonObject).steps).filter(
    step => isObject(step) && (step.id === 'seethrough' || step.id === 'assemble'),
  );
  delete (atParts.interview as JsonObject).rigging_context;
  for (const item of asArray(((atParts.interview as JsonObject).post as JsonObject).items).filter(isObject)) item.guide = null;
  writeFileSync(recordPath, `${JSON.stringify(atParts, null, 2)}\n`);

  const partsReport = nextProject(root, NOW);
  expect(partsReport.refusals).toEqual([]);
  expect(partsReport.awaits).toEqual(['project.stage']);
  expect(partsReport.moves).toHaveLength(2);
  expect(partsReport.moves[0]).toMatchObject({ role: 'agent', field: 'stage', awaits: 'project.stage' });
  expect(partsReport.moves[1]).toEqual({
    role: 'agent',
    field: 'current.parts',
    awaits: 'current.parts',
    command: `rig-create job open ${root} --current parts --reviewer '<reviewer>' --role owner`,
    act: expect.stringMatching(/^optional: publish the recorded parts output to Review to look together and comment;/),
  });

  // 2. At `rigging` after `record rig`: advance comes first, optional `--current rig` sits beside it, and stale rig suppresses it.
  const atRigging = structuredClone(full);
  atRigging.stage = 'rigging';
  atRigging.signoffs = asArray(atRigging.signoffs).slice(0, 4);
  atRigging.advances = asArray(atRigging.advances).slice(0, 5);
  delete (atRigging.current as JsonObject).motion;
  delete (atRigging.current as JsonObject).direction;
  (atRigging.plan as JsonObject).steps = asArray((atRigging.plan as JsonObject).steps).filter(
    step => isObject(step) && step.phase === 'rig',
  );
  for (const item of asArray(((atRigging.interview as JsonObject).post as JsonObject).items).filter(isObject)) item.guide = null;
  writeFileSync(recordPath, `${JSON.stringify(atRigging, null, 2)}\n`);

  const riggingReport = nextProject(root, NOW);
  expect(riggingReport.refusals).toEqual([]);
  expect(riggingReport.awaits).toEqual(['project.stage']);
  expect(riggingReport.moves).toHaveLength(2);
  expect(riggingReport.moves[0]).toMatchObject({
    role: 'agent',
    field: 'stage',
    command: `rig-create advance rig-review ${root}`,
  });
  expect(riggingReport.moves[1]).toEqual({
    role: 'agent',
    field: 'current.rig',
    awaits: 'current.rig',
    command: `rig-create job open ${root} --current rig --reviewer '<reviewer>' --role owner`,
    act: expect.stringMatching(/^optional: publish the recorded rig output to Review to look together and comment;/),
  });

  // 3. At `post` after `record direction`: advance comes first, optional `--current direction` sits beside it, and `awaits` stays `['project.stage']`.
  const atPost = structuredClone(full);
  atPost.stage = 'post';
  atPost.signoffs = asArray(atPost.signoffs).slice(0, 6);
  atPost.advances = asArray(atPost.advances).slice(0, 8);
  writeFileSync(recordPath, `${JSON.stringify(atPost, null, 2)}\n`);

  const postReport = nextProject(root, NOW);
  expect(postReport.refusals).toEqual([]);
  expect(postReport.awaits).toEqual(['project.stage']);
  expect(postReport.moves).toHaveLength(2);
  expect(postReport.moves[0]).toMatchObject({
    role: 'agent',
    field: 'stage',
    command: `rig-create advance direction-review ${root}`,
  });
  expect(postReport.moves[1]).toEqual({
    role: 'agent',
    field: 'current.direction',
    awaits: 'current.direction',
    command: `rig-create job open ${root} --current direction --reviewer '<reviewer>' --role owner`,
    act: expect.stringMatching(/^optional: publish the recorded direction output to Review to look together and comment;/),
  });

  // 4. Numbered project offers zero `--current` moves.
  const numberedContainer = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-open-current-numbered-')));
  roots.push(numberedContainer);
  const numberedRoot = join(numberedContainer, 'numbered-check');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), numberedRoot, { recursive: true });
  const numberedReport = nextProject(numberedRoot, NOW);
  expect(numberedReport.moves.some(move => move.command?.includes('--current'))).toBe(false);
});

test('numbered direction publication stays byte-unchanged', async () => {
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'create-numbered-post-invariance-')));
  roots.push(container);
  const numberedRoot = join(container, 'post-project');
  cpSync(join(import.meta.dir, '../templates/example-remesh'), numberedRoot, { recursive: true });

  const recordBytes = readFileSync(join(numberedRoot, 'project.json'));
  const recordHash = jobHash(recordBytes);
  const project = JSON.parse(recordBytes.toString('utf8')) as JsonObject;
  const postEntry = asArray(project.versions).filter(isObject).find(v => v.kind === 'post' && v.n === 5)!;
  const rigN = Number(postEntry.rig_version);

  const manifestRel = prepareLiveManifest(numberedRoot, project, 5);
  expect(manifestRel).toBe('review-live-v5.json');
  const manifestBytes = readFileSync(join(numberedRoot, manifestRel));

  const painting = asArray(project.inputs).filter(isObject)[0]!;
  const scene = asArray(project.scenes).filter(isObject)[0]!;
  const expectedManifest = `${JSON.stringify({
    schema: 'rig-review/1',
    id: 'create-v5',
    revision: 'v5',
    title: `post v5 (rig v${rigN})`,
    model: `derived/review/v${rigN}/out/check/build/skeleton.model.json`,
    direction: 'evidence/direction/v5.json',
    references: [
      {
        id: 'original-painting',
        label: 'Original painting',
        type: 'image',
        path: String(painting.path),
        width: 128,
        height: 128,
      },
    ],
    animations: [],
    checkpoints: [],
    authoring: [],
    scene: String(scene.path),
  }, null, 2)}\n`;
  expect(manifestBytes.toString('utf8')).toBe(expectedManifest);

  const postContext = await readPublished({
    root: numberedRoot,
    record: { path: 'project.json', sha256: recordHash },
    result: { path: manifestRel, selector: { kind: 'post', version: 5, rigVersion: rigN } },
  });
  expect(postContext.selector).toEqual({ kind: 'post', version: 5, rigVersion: rigN });
  expect(postContext.plan).not.toBeNull();
});

test(
  '#1065 job open --current parts and --current rig publish review-live.json, bind git commits, and ingest act@10 comments with commit verified',
  async () => {
    const root = cloneExampleCurrent({ git: true });

    // 1. Open `--current parts` in the background, submit an owner comment, and ingest it with `comment --from-review`.
    const openedParts = await openBackground(root, ['--current', 'parts']);
    const partsReceipt = latestReceipt(root);
    expect(openedParts.lines).toEqual([`job: current parts published (publication ${partsReceipt.publicationId})`]);

    const partsHeadSha = run(['git', 'rev-parse', 'HEAD'], root, isolatedGitEnv()).stdout.trim();
    const partsPage = await openOwnerPage(root, openedParts.url);
    expect(partsPage.asks).toEqual([]);
    expect((partsPage.head.source as JsonObject).selector).toMatchObject({ kind: 'current', output: 'parts' });
    expect((partsPage.head.source as JsonObject).commit).toBe(partsHeadSha);

    const partsCommentReply = await partsPage.submitComment('Check the synthetic hair layering.');
    expect(partsCommentReply).toMatchObject({ ok: true, value: { schema: 'rig-review/act@10', kind: 'comments' } });
    const partsActId = String((partsCommentReply.value as JsonObject).actId);

    const actsList = await runCli(root, ['job', 'acts', root, '--json']);
    expect(actsList.exit).toBe(0);
    const parsedActs = JSON.parse(actsList.stdout) as { acts: { actId: string; command: string }[] };
    expect(parsedActs.acts).toEqual([
      expect.objectContaining({
        actId: partsActId,
        command: `rig-create comment ${root} --from-review ${partsActId}`,
      }),
    ]);

    const ingestedParts = await runCli(root, ['comment', root, '--from-review', partsActId, '--json']);
    expect({ exit: ingestedParts.exit, stderr: ingestedParts.stderr }).toEqual({ exit: 0, stderr: '' });
    const partsIngestedJson = JSON.parse(ingestedParts.stdout) as JsonObject;
    expect(partsIngestedJson.warnings).toBeUndefined();
    expect((partsIngestedJson.entry as JsonObject).record).toEqual({
      sha256: String((partsPage.head.source as JsonObject).projectHash),
      commit: partsHeadSha,
    });

    const baseline = await runCli(root, ['history', 'baseline', root, '--by', 'synthetic-operator']);
    expect(baseline).toMatchObject({ exit: 0, stdout: expect.stringContaining('attribution unverified') });

    // 2. Publish `--current rig` into the same running Review host, submit a comment, and ingest it with 0 warnings.
    const switchedRig = await runCli(root, [
      'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--current', 'rig',
    ]);
    expect({ exit: switchedRig.exit, stderr: switchedRig.stderr }).toEqual({ exit: 0, stderr: '' });
    const rigReceipt = latestReceipt(root);
    expect(rigReceipt.publicationId).not.toBe(partsReceipt.publicationId);
    expect(switchedRig.stdout.trim().split('\n').slice(1)).toEqual([
      `job: current rig published (publication ${rigReceipt.publicationId})`,
    ]);

    const rigHeadSha = run(['git', 'rev-parse', 'HEAD'], root, isolatedGitEnv()).stdout.trim();
    expect(rigHeadSha).not.toBe(partsHeadSha);
    const rigPage = await openOwnerPage(root, openedParts.url);
    expect(rigPage.asks).toEqual([]);
    expect((rigPage.head.source as JsonObject).selector).toMatchObject({ kind: 'current', output: 'rig' });
    expect((rigPage.head.source as JsonObject).commit).toBe(rigHeadSha);

    const rigCommentReply = await rigPage.submitComment('Torso deform looks clean on idle.');
    expect(rigCommentReply).toMatchObject({ ok: true, value: { schema: 'rig-review/act@10', kind: 'comments' } });
    const rigActId = String((rigCommentReply.value as JsonObject).actId);

    const ingestedRig = await runCli(root, ['comment', root, '--from-review', rigActId, '--json']);
    expect({ exit: ingestedRig.exit, stderr: ingestedRig.stderr }).toEqual({ exit: 0, stderr: '' });
    const rigIngestedJson = JSON.parse(ingestedRig.stdout) as JsonObject;
    expect(rigIngestedJson.warnings).toBeUndefined();
    expect((rigIngestedJson.entry as JsonObject).record).toEqual({
      sha256: String((rigPage.head.source as JsonObject).projectHash),
      commit: rigHeadSha,
    });
  },
  25_000,
);

test(
  'Bar (#1065 §5a): agent writes to project.json do not republish an open current output, while output file changes do republish',
  async () => {
    const root = cloneExampleCurrent({ git: true });
    const openedRig = await openBackground(root, ['--current', 'rig']);
    const firstReceipt = latestReceipt(root);
    const firstManifestBytes = readFileSync(join(root, CURRENT_LIVE_MANIFEST));
    const page = await openOwnerPage(root, openedRig.url);

    // 1. Mutate project.json via an agent writer (`owner-language set en-US`) without changing `outputs/rig/`.
    const beforeProjectBytes = readFileSync(join(root, 'project.json'));
    const langUpdate = await runCli(root, ['owner-language', 'set', 'en-US', root]);
    expect({ exit: langUpdate.exit, stderr: langUpdate.stderr }).toEqual({ exit: 0, stderr: '' });
    expect(readFileSync(join(root, 'project.json')).equals(beforeProjectBytes)).toBe(false);

    // 2. Re-running `job open --current rig` MUST NOT republish or rewrite `review-live.json`.
    const skipped = await runCli(root, [
      'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--current', 'rig',
    ]);
    expect({ exit: skipped.exit, stderr: skipped.stderr }).toEqual({ exit: 0, stderr: '' });
    expect(skipped.stdout.trim().split('\n').slice(1)).toEqual([
      `job: current rig already published (publication ${firstReceipt.publicationId})`,
    ]);
    expect(latestReceipt(root).publicationId).toBe(firstReceipt.publicationId);
    expect(readFileSync(join(root, CURRENT_LIVE_MANIFEST)).equals(firstManifestBytes)).toBe(true);

    // 3. The already-open owner page stays live and accepts comments across the project.json rewrite!
    const commentAfterRewrite = await page.submitComment('Still live after agent project.json write.');
    expect(commentAfterRewrite).toMatchObject({
      ok: true,
      value: { schema: 'rig-review/act@10', publicationId: firstReceipt.publicationId },
    });
    const rewriteActId = String((commentAfterRewrite.value as JsonObject).actId);
    const ingestedAfterRewrite = await runCli(root, ['comment', root, '--from-review', rewriteActId]);
    expect({ exit: ingestedAfterRewrite.exit, stderr: ingestedAfterRewrite.stderr }).toEqual({ exit: 0, stderr: '' });

    // 4. Now change an output file in `outputs/rig/` and update `current.rig` bindings -> `job open --current rig` republishes!
    const modelRel = 'outputs/rig/check/build/skeleton.model.json';
    const modelAbs = join(root, modelRel);
    const mutatedModel = Buffer.from(`${readFileSync(modelAbs, 'utf8').trimEnd()}\n`);
    // Ensure a real content change in skeleton.model.json (pretty-format vs compact).
    const parsedModel = JSON.parse(mutatedModel.toString('utf8')) as JsonObject;
    const updatedModelBytes = Buffer.from(`${JSON.stringify(parsedModel)}\n`);
    expect(updatedModelBytes.equals(readFileSync(modelAbs))).toBe(false);
    writeFileSync(modelAbs, updatedModelBytes);
    const updatedModelSha = createHash('sha256').update(updatedModelBytes).digest('hex');

    const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
    const currentRig = (project.current as JsonObject).rig as JsonObject;
    const files = asArray(currentRig.files).filter(isObject).map(entry =>
      entry.path === modelRel
        ? { path: modelRel, sha256: updatedModelSha, bytes: updatedModelBytes.length }
        : { path: String(entry.path), sha256: String(entry.sha256), bytes: Number(entry.bytes) },
    );
    currentRig.files = files;
    currentRig.files_sha256 = outputSetHash(files);
    // Keep check-report's model_sha256 and report binding consistent with currentShapeFindings.
    const reportRel = String((currentRig.report as JsonObject).path);
    const reportAbs = join(root, reportRel);
    const reportJson = JSON.parse(readFileSync(reportAbs, 'utf8')) as JsonObject;
    if (isObject(reportJson.build)) reportJson.build.model_sha256 = updatedModelSha;
    const updatedReportBytes = Buffer.from(`${JSON.stringify(reportJson, null, 2)}\n`);
    writeFileSync(reportAbs, updatedReportBytes);
    const updatedReportSha = createHash('sha256').update(updatedReportBytes).digest('hex');
    const updatedFiles = files.map(entry =>
      entry.path === reportRel
        ? { path: reportRel, sha256: updatedReportSha, bytes: updatedReportBytes.length }
        : entry,
    );
    currentRig.files = updatedFiles;
    currentRig.files_sha256 = outputSetHash(updatedFiles);
    currentRig.report = { path: reportRel, sha256: updatedReportSha };
    writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

    const republished = await runCli(root, [
      'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--current', 'rig',
    ]);
    expect({ exit: republished.exit, stderr: republished.stderr }).toEqual({ exit: 0, stderr: '' });
    const secondReceipt = latestReceipt(root);
    expect(secondReceipt.publicationId).not.toBe(firstReceipt.publicationId);
    expect(republished.stdout.trim().split('\n').slice(1)).toEqual([
      expect.stringContaining('WARN PROJECT_COMMIT_FAILED:'),
      `job: current rig published (publication ${secondReceipt.publicationId})`,
    ]);

    // And the stale page from the earlier publication now refuses with JOB_GENERATION_STALE or JOB_ACT_SOURCE_STALE.
    const staleAttempt = await page.submitComment('Comment from superseded page.');
    expect(staleAttempt.ok).toBe(false);
  },
  25_000,
);

test(
  '#1089 job open --current direction publishes example-current direction@4 without scene, Review accepts it, and act@10 comments bind commit',
  async () => {
    const root = cloneExampleCurrent({ git: true });
    const directionSpecPath = 'specs/direction/direction.json';
    const expectedDirectionSha = jobHash(readFileSync(join(root, directionSpecPath)));
    const expectedModelPath = 'outputs/direction/check/build/skeleton.model.json';
    const expectedModelSha = jobHash(readFileSync(join(root, expectedModelPath)));

    const openedDirection = await openBackground(root, ['--current', 'direction']);
    const receipt = latestReceipt(root);
    expect(openedDirection.lines).toEqual([`job: current direction published (publication ${receipt.publicationId})`]);

    const manifest = JSON.parse(readFileSync(join(root, CURRENT_LIVE_MANIFEST), 'utf8')) as JsonObject;
    expect(manifest.model).toBe(expectedModelPath);
    expect(manifest.direction).toBe(directionSpecPath);
    expect(Object.hasOwn(manifest, 'scene')).toBe(false);

    const headCommit = run(['git', 'rev-parse', 'HEAD'], root, isolatedGitEnv()).stdout.trim();
    const page = await openOwnerPage(root, openedDirection.url);
    expect(page.asks).toEqual([]);
    expect((page.head.source as JsonObject).selector).toMatchObject({ kind: 'current', output: 'direction' });
    expect((page.head.source as JsonObject).model).toEqual({ path: expectedModelPath, sha256: expectedModelSha });
    expect((page.head.source as JsonObject).direction).toEqual({ path: directionSpecPath, sha256: expectedDirectionSha });
    expect((page.head.source as JsonObject).commit).toBe(headCommit);

    const commentReply = await page.submitComment('Composed direction@4 loop plays cleanly.');
    expect(commentReply).toMatchObject({ ok: true, value: { schema: 'rig-review/act@10', kind: 'comments' } });
    const actValue = commentReply.value as JsonObject;
    const actId = String(actValue.actId);
    expect((actValue.source as JsonObject).direction).toEqual({ path: directionSpecPath, sha256: expectedDirectionSha });
    expect((actValue.source as JsonObject).model).toEqual({ path: expectedModelPath, sha256: expectedModelSha });

    const ingested = await runCli(root, ['comment', root, '--from-review', actId, '--json']);
    expect({ exit: ingested.exit, stderr: ingested.stderr }).toEqual({ exit: 0, stderr: '' });
    const ingestedJson = JSON.parse(ingested.stdout) as JsonObject;
    expect(ingestedJson.warnings).toBeUndefined();
    expect((ingestedJson.entry as JsonObject).record).toEqual({
      sha256: String((page.head.source as JsonObject).projectHash),
      commit: headCommit,
    });

    console.log(
      `current-direction-receipt: ${JSON.stringify({
        publicationId: receipt.publicationId,
        direction: { path: directionSpecPath, sha256: expectedDirectionSha },
        model: { path: expectedModelPath, sha256: expectedModelSha },
        reviewAccepted: true,
        commentActSchema: actValue.schema,
      })}`,
    );
  },
  25_000,
);
