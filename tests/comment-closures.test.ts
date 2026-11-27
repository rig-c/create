import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JOB_COMMENT_ONLY_ACT_SCHEMA } from '@rig-c/review/job-host';
import { commentCommand, type CommentHooks } from '../src/comment-act.ts';
import { commentStatus } from '../src/comment-closures.ts';
import { outputSetHash, sha256, treeFiles } from '../src/current.ts';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import { nextCommand, nextProject, type NextReport } from '../src/next.ts';
import { Refusal } from '../src/refusal.ts';
import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, testClock } from './clock.ts';
import { arr, fixture, obj } from './fixtures.ts';

afterEach(() => testClock.reset());

const JOB = 'synthetic-comment-closure-job';
const ORIGIN = 'http://127.0.0.1:43126';

const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, project: JsonObject): void => {
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
};

function writeDiskFile(dir: string, rel: string, content: string): string {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return sha256(Buffer.from(content));
}

function makeCurrentCommentProject(): {
  dir: string;
  modelPath: string;
  manifestPath: string;
  partPath: string;
  modelSha: string;
  manifestSha: string;
  partSha: string;
} {
  const dir = realpathSync(fixture(project => {
    project.stage = 'rigging';
    project.signoffs = arr(project.signoffs).filter(entry => stageIndex(String(obj(entry).stage)) < stageIndex('rigging'));
    project.versions = [];
    delete project.drafts;
    delete project.scenes;
  }));

  const builtAt = new Date(testClock.now() - 10_000).toISOString();
  const modelPath = 'outputs/rig/check/build/skeleton.model.json';
  const manifestPath = 'outputs/parts/rig/parts.json';
  const partPath = 'outputs/parts/rig/parts/sleeve_l.png';
  const modelSha = writeDiskFile(dir, modelPath, '{"skeleton":"initial"}\n');
  writeDiskFile(dir, 'outputs/rig/run.json', '{}\n');
  writeDiskFile(dir, 'outputs/rig/check/check.json', '{"ok":true}\n');
  const manifestSha = writeDiskFile(dir, manifestPath, '{"parts":["sleeve_l"]}\n');
  const partSha = writeDiskFile(dir, partPath, 'initial-sleeve-bytes');

  const rigFiles = treeFiles(dir, 'outputs/rig');
  const rigBinding = (rel: string) => {
    const found = rigFiles.find(file => file.path === rel)!;
    return { path: found.path, sha256: found.sha256 };
  };

  const identity = currentJobIdentity({
    root: dir,
    stateDir: 'unused-private-state',
    fingerprint: 'synthetic',
    reviewer: { id: 'synthetic-owner', role: 'owner' },
  }, dir);
  writePrivateJson(join(dir, JOB_BINDING_FILE), {
    schema: 'rig-create/job-binding@1',
    identity,
    jobId: JOB,
    origin: ORIGIN,
    fetchCapability: 'synthetic-read-grant',
  }, true);

  const project = load(dir);
  project.current = {
    rig: {
      at: builtAt,
      built_by: 'agent',
      built_from: [
        { path: manifestPath, sha256: manifestSha },
        { path: partPath, sha256: partSha },
      ],
      built_with: { '@rig-c/parts': '2.60.0' },
      files: rigFiles.map(({ bytes, path, sha256: hash }) => ({ bytes, path, sha256: hash })),
      files_sha256: outputSetHash(rigFiles),
      rebuild: { recorded: false, note: 'synthetic fixture' },
      report: rigBinding('outputs/rig/check/check.json'),
      run: rigBinding('outputs/rig/run.json'),
    },
  };
  project.review_job = { jobId: JOB, origin: ORIGIN };
  save(dir, project);

  return { dir, modelPath, manifestPath, partPath, modelSha, manifestSha, partSha };
}

function buildCommentAct(
  dir: string,
  files: { modelPath: string; modelSha: string; manifestPath: string; manifestSha: string; partSha: string },
  actId = 'comment-act-1',
  text = 'Adjust the left sleeve fold.',
): JsonObject {
  const recordHash = jobHash(readFileSync(join(dir, 'project.json')));
  return {
    schema: JOB_COMMENT_ONLY_ACT_SCHEMA,
    actId,
    jobId: JOB,
    publicationId: 'synthetic-publication',
    kind: 'comments',
    at: testClock.iso(),
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: {
      sourceHash: '1'.repeat(64),
      projectHash: recordHash,
      package: { id: 'synthetic-package', revision: 'one' },
      selector: null,
      model: { path: files.modelPath, sha256: files.modelSha },
      direction: null,
      optionSet: null,
      appliedResult: null,
      plan: null,
      parts: {
        enumeratorVersion: '2.60.0',
        manifest: { path: files.manifestPath, sha256: files.manifestSha },
        images: [{ role: 'part', path: 'parts/sleeve_l.png', sha256: files.partSha }],
      },
    },
    value: { comments: [{ text }] },
  };
}

function ingestComment(dir: string, act: JsonObject): string {
  const hooks: CommentHooks = { fetch: () => ({ bytes: JSON.stringify(act) }) };
  const result = commentCommand(['--from-review', String(act.actId), dir, '--json'], testClock.now(), hooks);
  expect(result.exit).toBe(0);
  const receipt = (load(dir).review_acts as JsonObject[]).find(
    row => row.kind === 'comments' && row.actId === act.actId,
  );
  expect(receipt).toBeDefined();
  return String(receipt!.sha256);
}

function expectRefusedByteIdentical(dir: string, fn: () => unknown, expectedCode: string): Refusal {
  const before = readFileSync(join(dir, 'project.json'));
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Refusal);
  expect((caught as Refusal).code).toBe(expectedCode);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  return caught as Refusal;
}

test('#1064 commentStatus is current when all saw files match disk and turns earlier with no refusal when one bound file changes', () => {
  const { dir, modelPath, manifestPath, partPath, modelSha, manifestSha, partSha } = makeCurrentCommentProject();
  const baselineMoves = nextProject(dir, testClock.now()).moves;
  expect(baselineMoves.length).toBeGreaterThan(0);
  expect(baselineMoves.some(m => m.field === 'stage')).toBe(true);

  const actSha = ingestComment(dir, buildCommentAct(dir, { modelPath, modelSha, manifestPath, manifestSha, partSha }));
  const entry = (load(dir).comments as JsonObject[])[0]!;
  expect(commentStatus(dir, entry)).toBe('current');

  // Unacted current comment: check has no comment refusal; next offers the agent move alongside unchanged progression moves.
  const checkBefore = checkProject(dir);
  expect(checkBefore.refusals.filter(r => r.path.startsWith('comments') || r.path.startsWith('comment_closures'))).toEqual([]);
  expect(checkBefore.comments).toEqual([expect.objectContaining({ comment: 0, act_sha256: actSha, status: 'current', closed: false })]);

  const nextCurrent = JSON.parse(nextCommand([dir, '--json'], testClock.now()).stdout) as NextReport;
  expect(nextCurrent.comments).toEqual([expect.objectContaining({ comment: 0, act_sha256: actSha, status: 'current', closed: false })]);
  const commentMove = nextCurrent.moves.find(m => m.field === 'comments[0]');
  expect(commentMove).toBeDefined();
  expect(commentMove!.role).toBe('agent');
  expect(commentMove!.act).toContain('Read comment 0 and act on it');
  expect(commentMove!.command).toContain(`rig-create comment --close 0 ${dir} --act-sha256 ${actSha}`);
  // Progression moves remain intact and in their original order.
  expect(nextCurrent.moves.filter(m => m.field !== 'comments[0]')).toEqual(baselineMoves);

  const formattedCurrent = nextCommand([dir], testClock.now()).stdout;
  expect(formattedCurrent).toContain('comment comments[0] [current]: 1 comment(s)');
  expect(formattedCurrent).toContain('Read comment 0 and act on it');

  // Changing just one saw-bound file flips status to `earlier` with zero refusals and removes the act move.
  writeDiskFile(dir, partPath, 'updated-sleeve-bytes-after-rebuild');
  expect(commentStatus(dir, (load(dir).comments as JsonObject[])[0]!)).toBe('earlier');

  const checkEarlier = checkProject(dir);
  expect(checkEarlier.refusals.filter(r => r.path.startsWith('comments') || r.path.startsWith('comment_closures'))).toEqual([]);
  expect(checkEarlier.warnings.filter(w => w.path.startsWith('comments'))).toEqual([]);
  expect(checkEarlier.comments).toEqual([expect.objectContaining({ comment: 0, status: 'earlier', closed: false })]);

  const nextEarlier = nextProject(dir, testClock.now());
  expect(nextEarlier.comments).toEqual([expect.objectContaining({ comment: 0, status: 'earlier', closed: false })]);
  expect(nextEarlier.moves.filter(m => m.field.startsWith('comments['))).toEqual([]);
  // Stale rebuild progression move remains present without any comment move.
  expect(nextEarlier.moves.some(m => m.field === 'current.rig')).toBe(true);
  expect(nextCommand([dir], testClock.now()).stdout).toContain('comment comments[0] [earlier]: 1 comment(s)');
});

test('#1064 closing a current comment binds comment index, act sha256 and changed file hashes, suppresses the move, and replays cleanly', () => {
  const { dir, modelPath, manifestPath, partPath, modelSha, manifestSha, partSha } = makeCurrentCommentProject();
  const baselineMoves = nextProject(dir, testClock.now()).moves;
  const actSha = ingestComment(dir, buildCommentAct(dir, { modelPath, modelSha, manifestPath, manifestSha, partSha }));

  // Agent edits a spec file in response while the saw outputs have not been rebuilt yet (still `current`).
  testClock.set(testClock.now() + 5_000);
  const configPath = 'specs/rig/config.json';
  const configSha = writeDiskFile(dir, configPath, '{"sleeve_fold": 0.42}\n');

  const closeRes = commentCommand(
    ['--close', '0', dir, '--act-sha256', actSha, '--after', `${configPath}=${configSha}`, '--reason', 'Adjusted sleeve_fold in rig config.', '--json'],
    testClock.now(),
  );
  expect(closeRes.exit).toBe(0);
  const parsed = JSON.parse(closeRes.stdout) as JsonObject;
  expect(parsed).toMatchObject({
    closure: 'comment_closures[0]',
    comment: 'comments[0]',
    entry: {
      comment: 0,
      act_sha256: actSha,
      by: 'agent',
      reason: 'Adjusted sleeve_fold in rig config.',
      after: [{ path: configPath, sha256: configSha }],
    },
  });

  // Closed comment: check is clean; status is still `current` (saw unchanged), closed is true, and next offers no comment move.
  const checked = checkProject(dir);
  expect(checked.refusals.filter(r => r.code === 'COMMENT_CLOSURE_INVALID')).toEqual([]);
  expect(checked.comments).toEqual([expect.objectContaining({ comment: 0, status: 'current', closed: true })]);

  const afterClose = nextProject(dir, testClock.now());
  expect(afterClose.comments).toEqual([expect.objectContaining({ comment: 0, status: 'current', closed: true })]);
  expect(afterClose.moves.filter(m => m.field.startsWith('comments['))).toEqual([]);
  expect(afterClose.moves).toEqual(baselineMoves);
  expect(nextCommand([dir], testClock.now()).stdout).toContain('comment comments[0] [current, closed]: 1 comment(s)');

  // Idempotent replay leaves project.json byte-identical.
  const bytesAfterFirstClose = readFileSync(join(dir, 'project.json'));
  const replayRes = commentCommand(
    ['--close', '0', dir, '--act-sha256', actSha, '--after', `${configPath}=${configSha}`, '--reason', 'Adjusted sleeve_fold in rig config.', '--json'],
    testClock.now() + 1_000,
  );
  expect(JSON.parse(replayRes.stdout)).toMatchObject({ closure: 'comment_closures[0]', replayed: true });
  expect(readFileSync(join(dir, 'project.json'))).toEqual(bytesAfterFirstClose);

  // Subsequent edits to the changed file in later work do not break historical closure validation in check.
  writeDiskFile(dir, configPath, '{"sleeve_fold": 0.50}\n');
  expect(checkProject(dir).refusals.filter(r => r.code === 'COMMENT_CLOSURE_INVALID')).toEqual([]);
});

test('#1064 mismatched comment id, act sha256 or file hashes refuse COMMENT_CLOSURE_INVALID and leave project.json byte-identical', () => {
  const { dir, modelPath, manifestPath, partPath, modelSha, manifestSha, partSha } = makeCurrentCommentProject();
  const actSha = ingestComment(dir, buildCommentAct(dir, { modelPath, modelSha, manifestPath, manifestSha, partSha }));
  testClock.set(testClock.now() + 2_000);

  const configPath = 'specs/rig/config.json';
  const configSha = writeDiskFile(dir, configPath, '{"sleeve_fold": 0.42}\n');

  // 1. Mismatched comment index.
  expectRefusedByteIdentical(
    dir,
    () => commentCommand(['--close', '1', dir, '--act-sha256', actSha, '--after', `${configPath}=${configSha}`], testClock.now()),
    'COMMENT_CLOSURE_INVALID',
  );

  // 2. Mismatched act_sha256.
  expectRefusedByteIdentical(
    dir,
    () => commentCommand(['--close', '0', dir, '--act-sha256', 'f'.repeat(64), '--after', `${configPath}=${configSha}`], testClock.now()),
    'COMMENT_CLOSURE_INVALID',
  );

  // 3. Mismatched file hash vs disk bytes.
  expectRefusedByteIdentical(
    dir,
    () => commentCommand(['--close', '0', dir, '--act-sha256', actSha, '--after', `${configPath}=${'a'.repeat(64)}`], testClock.now()),
    'COMMENT_CLOSURE_INVALID',
  );

  // 4. Missing file on disk.
  expectRefusedByteIdentical(
    dir,
    () => commentCommand(['--close', '0', dir, '--act-sha256', actSha, '--after', `specs/rig/missing.json=${configSha}`], testClock.now()),
    'COMMENT_CLOSURE_INVALID',
  );

  // 5. Saw-bound file passed with its unchanged pre-comment hash.
  expectRefusedByteIdentical(
    dir,
    () => commentCommand(['--close', '0', dir, '--act-sha256', actSha, '--after', `${partPath}=${partSha}`], testClock.now()),
    'COMMENT_CLOSURE_INVALID',
  );

  // 6. Non-agent --by refused.
  expectRefusedByteIdentical(
    dir,
    () => commentCommand(['--close', '0', dir, '--act-sha256', actSha, '--after', `${configPath}=${configSha}`, '--by', 'user'], testClock.now()),
    'COMMENT_CLOSURE_INVALID',
  );

  // 7. Direct record tampering is caught by the same check function.
  const tamperedId = structuredClone(load(dir));
  tamperedId.comment_closures = [{
    comment: 0,
    act_sha256: 'e'.repeat(64),
    by: 'agent',
    at: testClock.iso(),
    after: [{ path: configPath, sha256: configSha }],
  }];
  expect(checkProject(dir, tamperedId).refusals.map(r => r.code)).toContain('COMMENT_CLOSURE_INVALID');

  const tamperedUnchangedSaw = structuredClone(load(dir));
  tamperedUnchangedSaw.comment_closures = [{
    comment: 0,
    act_sha256: actSha,
    by: 'agent',
    at: testClock.iso(),
    after: [{ path: partPath, sha256: partSha }],
  }];
  expect(checkProject(dir, tamperedUnchangedSaw).refusals.map(r => r.code)).toContain('COMMENT_CLOSURE_INVALID');
});

test('#1064 numbered non-current projects get no current-comment moves', () => {
  const dir = realpathSync(fixture());
  const modelPath = 'outputs/rig/check/build/skeleton.model.json';
  const manifestPath = 'outputs/parts/rig/parts.json';
  const partPath = 'outputs/parts/rig/parts/sleeve_l.png';
  const modelSha = writeDiskFile(dir, modelPath, '{"skeleton":"numbered"}\n');
  const manifestSha = writeDiskFile(dir, manifestPath, '{"parts":["sleeve_l"]}\n');
  const partSha = writeDiskFile(dir, partPath, 'numbered-sleeve');

  const identity = currentJobIdentity({
    root: dir,
    stateDir: 'unused-private-state',
    fingerprint: 'synthetic',
    reviewer: { id: 'synthetic-owner', role: 'owner' },
  }, dir);
  writePrivateJson(join(dir, JOB_BINDING_FILE), {
    schema: 'rig-create/job-binding@1',
    identity,
    jobId: JOB,
    origin: ORIGIN,
    fetchCapability: 'synthetic-read-grant',
  }, true);

  const project = load(dir);
  expect(project.current).toBeUndefined();
  expect((project.versions as unknown[]).length).toBeGreaterThan(0);
  project.review_job = { jobId: JOB, origin: ORIGIN };
  save(dir, project);

  ingestComment(dir, buildCommentAct(dir, { modelPath, modelSha, manifestPath, manifestSha, partSha }));
  const report = nextProject(dir, testClock.now());
  expect(report.comments).toBeUndefined();
  expect(report.moves.filter(m => m.field.startsWith('comments['))).toEqual([]);
});

test('#1064 multiple comments track independent closure and CLI option misuse refuses COMMENT_OPTION_INVALID', () => {
  const { dir, modelPath, manifestPath, partPath, modelSha, manifestSha, partSha } = makeCurrentCommentProject();
  const actSha0 = ingestComment(dir, buildCommentAct(dir, { modelPath, modelSha, manifestPath, manifestSha, partSha }, 'comment-act-1', 'First comment.'));
  testClock.set(testClock.now() + 1_000);
  const actSha1 = ingestComment(dir, buildCommentAct(dir, { modelPath, modelSha, manifestPath, manifestSha, partSha }, 'comment-act-2', 'Second comment.'));

  const bothOpen = nextProject(dir, testClock.now());
  expect(bothOpen.moves.filter(m => m.field.startsWith('comments['))).toHaveLength(2);

  testClock.set(testClock.now() + 1_000);
  const specSha = writeDiskFile(dir, 'specs/rig/config.json', '{"first":true}\n');
  expect(commentCommand(['--close', '0', dir, '--act-sha256', actSha0, '--after', `specs/rig/config.json=${specSha}`], testClock.now()).exit).toBe(0);

  const oneLeft = nextProject(dir, testClock.now());
  expect(oneLeft.comments).toEqual([
    expect.objectContaining({ comment: 0, act_sha256: actSha0, status: 'current', closed: true }),
    expect.objectContaining({ comment: 1, act_sha256: actSha1, status: 'current', closed: false }),
  ]);
  const remaining = oneLeft.moves.filter(m => m.field.startsWith('comments['));
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.field).toBe('comments[1]');
  expect(remaining[0]!.act).toContain('Read comment 1 and act on it');

  const invalidOpt = expectRefusedByteIdentical(
    dir,
    () => commentCommand(['--from-review', 'comment-act-1', '--close', '0', dir], testClock.now()),
    'COMMENT_OPTION_INVALID',
  );
  expect(invalidOpt.exitCode).toBe(2);
});

