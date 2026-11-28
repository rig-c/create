import { beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JOB_COMMENT_ONLY_ACT_SCHEMA, startJobHost, type JobOwnerHost } from '@rig-c/review/job-host';
import { asArray, isObject } from '../src/check.ts';
import { OPTIONS_SPEC, optionContext, sha256 } from '../src/choices.ts';
import { commentCommand } from '../src/comment-act.ts';
import { freshProjectRecord, GITIGNORE } from '../src/init.ts';
import { jobEvents } from '../src/job-acts.ts';
import { closeCreateJob, withdrawCreateJobAct } from '../src/job-close.ts';
import { openCreateJob, publishPending } from '../src/job-host.ts';
import {
  acknowledgePublication,
  enqueuePublication,
  JOB_BINDING_FILE,
  jobHash,
  jobHostStateRoot,
  jobPrivateRoot,
  readWriterBinding,
  reconcilePublication,
  writePrivateJson,
} from '../src/job-outbox.ts';
import {
  currentJobIdentity,
  partsEnumerator,
  prepareCurrentManifest,
  prepareLiveManifest,
  readPublished,
  readRecordPublished,
} from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_REOPEN_AT } from '../scripts/example-time.ts';
import { TEST_NOW } from './clock.ts';
import { checkpointWorkspace } from './checkpoint-evidence-fixture.ts';
import { copyWithRunningCreatePin } from './copied-create-pin.ts';
import { fixture } from './fixtures.ts';
import { gitEnv, run, tempDir, type Run } from './helpers.ts';
import { meshEdits } from './mesh-edit-fixture.ts';

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

let nextTick = TEST_NOW;
beforeEach(() => {
  nextTick = TEST_NOW;
});
function tick(): number {
  nextTick += 1_000;
  return nextTick;
}

function cli(repo: Repo, ...args: string[]): Run {
  return run([process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, new Date(tick()).toISOString(), ...args], repo.dir, repo.env);
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
  git(repo, 'config', '--local', 'user.name', 'Synthetic Writer');
  git(repo, 'config', '--local', 'user.email', 'writer@example.test');
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
  const prefix = git(repo, 'rev-parse', '--show-prefix').replace(/\r?\n$/, '');
  expect(git(repo, 'status', '--porcelain', '--', UNRELATED)).toBe(`MM ${prefix}${UNRELATED}\n`);
  return snapshot(repo);
}

function snapshot(repo: Repo) {
  return {
    unrelatedStage: git(repo, 'ls-files', '--stage', '--', UNRELATED),
    unrelatedIndex: git(repo, 'show', `:./${UNRELATED}`),
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

test('#1168 group 2: interview-answer and interview-decision commit exact paths and leave unrelated/refused states untouched', () => {
  const repo = makeRepo();
  const unrelated = plantUnrelated(repo);
  let parent = head(repo);

  const source = 'inputs/painting.png';
  put(repo, source, readFileSync(join(import.meta.dir, '..', 'templates', 'example-current', source)));
  success(cli(repo, 'input', 'add', source, repo.dir, '--origin', 'synthetic source', '--painting'));
  parent = assertCommittedStep(repo, parent, 'input add', [PROJECT, source], unrelated);

  // Register an option set for rig_type with value + auto options, then answer with auto and record a fragment decision.
  const project = JSON.parse(bytes(repo, PROJECT).toString('utf8')) as JsonObject;
  const setPath = 'evidence/interview/rig-type.json';
  const setDoc: JsonObject = {
    schema: OPTIONS_SPEC,
    id: 'set-rig-type',
    question: 'rig_type',
    stage: 'interview',
    drafted_by: 'agent',
    drafted_at: new Date(nextTick).toISOString(),
    context: optionContext(project, 'interview', nextTick, repo.dir),
    assembly: { rule: 'single' },
    asks: [{
      id: 'rig_type',
      prompt: 'Choose the synthetic rig type.',
      options: [
        { id: 'idle', kind: 'value', label: 'Standing idle', effect: 'Use character.idle.', fragment: 'character.idle', recommended: true, reason: 'Synthetic.' },
        { id: 'game', kind: 'value', label: 'Game logic', effect: 'Use fullscreen.game_logic.', fragment: 'fullscreen.game_logic', recommended: false },
        { id: 'other', kind: 'other', label: 'Other', effect: 'Supply other words.', recommended: false },
        { id: 'auto', kind: 'auto', label: 'Delegate', effect: 'Let the agent choose.', recommended: false },
      ],
    }],
  };
  putJson(repo, setPath, setDoc);
  const setSha = sha256(bytes(repo, setPath));
  success(cli(repo, 'interview-options', 'rig_type', repo.dir, '--file', setPath));
  parent = assertCommittedStep(repo, parent, 'interview-options', [PROJECT, setPath], unrelated);

  // Refused interview-answer (wrong sha256) leaves HEAD, index and tree unchanged.
  put(repo, 'scratch/words.txt', 'Delegate rig_type to the agent.\n');
  assertRefusedUnchanged(repo, [
    'interview-answer', 'rig_type', repo.dir, '--set', setPath, '--sha256', '0'.repeat(64),
    '--pick', 'rig_type=auto', '--by', 'synthetic-owner', '--owner-chat', 'scratch/words.txt',
    '--said-at', new Date(TEST_NOW).toISOString(), '--relayed-by', 'agent',
  ], 'INTERVIEW_OPTIONS_STALE');

  // Dirty project.json refuses before writing.
  const cleanProject = bytes(repo, PROJECT);
  put(repo, PROJECT, `${cleanProject.toString().trimEnd()}\n\n`);
  assertRefusedUnchanged(repo, [
    'interview-answer', 'rig_type', repo.dir, '--set', setPath, '--sha256', setSha,
    '--pick', 'rig_type=auto', '--by', 'synthetic-owner', '--owner-chat', 'scratch/words.txt',
    '--said-at', new Date(TEST_NOW).toISOString(), '--relayed-by', 'agent',
  ], 'PROJECT_COMMIT_DIRTY');
  put(repo, PROJECT, cleanProject);

  success(cli(repo,
    'interview-answer', 'rig_type', repo.dir, '--set', setPath, '--sha256', setSha,
    '--pick', 'rig_type=auto', '--by', 'synthetic-owner', '--owner-chat', 'scratch/words.txt',
    '--said-at', new Date(TEST_NOW).toISOString(), '--relayed-by', 'agent',
  ));
  parent = assertCommittedStep(repo, parent, 'interview-answer', [PROJECT], unrelated);

  // Refused interview-decision (missing step plan for --value-file) leaves HEAD, index and tree unchanged.
  put(repo, 'scratch/reason.txt', 'Synthetic decision.\n');
  put(repo, 'scratch/value.json', '"character.idle"\n');
  put(repo, 'scratch/quote.txt', 'Build a standing idle character.\n');
  assertRefusedUnchanged(repo, [
    'interview-decision', 'assemble', repo.dir, '--by', 'agent', '--reasoning-file', 'scratch/reason.txt',
    '--value-file', 'scratch/value.json', '--plan-quote-file', 'scratch/quote.txt',
  ], 'STEP_PLAN_MISSING');

  // Valid fragment interview-decision commits only project.json.
  success(cli(repo,
    'interview-decision', 'rig_type', repo.dir, '--by', 'agent', '--reasoning-file', 'scratch/reason.txt',
    '--fragment', 'rig_type=scratch/value.json',
  ));
  parent = assertCommittedStep(repo, parent, 'interview-decision', [PROJECT], unrelated);

  // Also verify step-plan interview-decision commits only project.json.
  const planPath = 'plans/parts.md';
  put(repo, planPath, 'Use core projection on a plain ground.\n');
  success(cli(repo, 'plan', 'propose', 'parts', repo.dir, '--file', planPath, '--by', 'agent'));
  parent = assertCommittedStep(repo, parent, 'plan propose', [PROJECT, planPath], unrelated);

  put(repo, 'scratch/assemble-val.json', '{"project":"core"}\n');
  put(repo, 'scratch/assemble-quote.txt', 'Use core projection on a plain ground.\n');
  success(cli(repo,
    'interview-decision', 'assemble', repo.dir, '--by', 'agent', '--reasoning-file', 'scratch/reason.txt',
    '--value-file', 'scratch/assemble-val.json', '--plan-quote-file', 'scratch/assemble-quote.txt',
  ));
  assertCommittedStep(repo, parent, 'interview-decision', [PROJECT], unrelated);
});

test('#1168 group 3: plan feedback and all plan step writers commit project.json with exact prefixes and preserve refused/replay states', () => {
  const repo = makeRepo();
  const unrelated = plantUnrelated(repo);
  let parent = head(repo);

  const source = 'inputs/painting.png';
  put(repo, source, readFileSync(join(import.meta.dir, '..', 'templates', 'example-current', source)));
  success(cli(repo, 'input', 'add', source, repo.dir, '--origin', 'synthetic source', '--painting'));
  parent = assertCommittedStep(repo, parent, 'input add', [PROJECT, source], unrelated);

  const planPath = 'plans/parts.md';
  put(repo, planPath, 'Build a standing idle character. Use core projection.\n');
  success(cli(repo, 'plan', 'propose', 'parts', repo.dir, '--file', planPath, '--by', 'agent'));
  parent = assertCommittedStep(repo, parent, 'plan propose', [PROJECT, planPath], unrelated);

  // Refused plan feedback (missing plan for motion) leaves HEAD, index and tree unchanged.
  put(repo, 'scratch/feedback.txt', 'Looks good for parts.\n');
  assertRefusedUnchanged(repo, [
    'plan', 'feedback', 'motion', repo.dir, '--words-file', 'scratch/feedback.txt',
    '--by', 'synthetic-owner', '--said-at', new Date(TEST_NOW).toISOString(), '--relayed-by', 'agent',
  ], 'STEP_PLAN_MISSING');

  success(cli(repo,
    'plan', 'feedback', 'parts', repo.dir, '--words-file', 'scratch/feedback.txt',
    '--by', 'synthetic-owner', '--said-at', new Date(TEST_NOW).toISOString(), '--relayed-by', 'agent',
  ));
  parent = assertCommittedStep(repo, parent, 'plan feedback', [PROJECT], unrelated);

  // Record step-plan values so rig plan steps have answered rests_on guides.
  put(repo, 'scratch/reason.txt', 'Follow the proposed synthetic plan.\n');
  put(repo, 'scratch/rig-type.json', '"character.idle"\n');
  put(repo, 'scratch/rig-quote.txt', 'Build a standing idle character.\n');
  success(cli(repo, 'interview-decision', 'rig_type', repo.dir, '--by', 'agent', '--reasoning-file', 'scratch/reason.txt',
    '--value-file', 'scratch/rig-type.json', '--plan-quote-file', 'scratch/rig-quote.txt'));
  parent = assertCommittedStep(repo, parent, 'interview-decision', [PROJECT], unrelated);

  put(repo, 'scratch/assemble.json', '{"project":"core"}\n');
  put(repo, 'scratch/assemble-quote.txt', 'Use core projection.\n');
  success(cli(repo, 'interview-decision', 'assemble', repo.dir, '--by', 'agent', '--reasoning-file', 'scratch/reason.txt',
    '--value-file', 'scratch/assemble.json', '--plan-quote-file', 'scratch/assemble-quote.txt'));
  parent = assertCommittedStep(repo, parent, 'interview-decision', [PROJECT], unrelated);

  // Refused plan add (unknown rests-on) leaves HEAD, index and tree unchanged.
  assertRefusedUnchanged(repo, [
    'plan', 'add', 'assemble', repo.dir, '--by', 'agent', '--phase', 'rig', '--order', '1',
    '--does', 'Assemble parts.', '--produces', 'Parts output.', '--rests-on', 'unknown_guide',
    '--bar', 'Parts check passes with <= 0 refusals.', '--checkpoint-proposed', 'true',
  ], 'STEP_BASIS_UNKNOWN');

  // Dirty project.json refuses before writing.
  const cleanProject = bytes(repo, PROJECT);
  put(repo, PROJECT, `${cleanProject.toString().trimEnd()}\n\n`);
  assertRefusedUnchanged(repo, [
    'plan', 'add', 'assemble', repo.dir, '--by', 'agent', '--phase', 'rig', '--order', '1',
    '--does', 'Assemble parts.', '--produces', 'Parts output.', '--rests-on', 'assemble',
    '--bar', 'Parts check passes with <= 0 refusals.', '--checkpoint-proposed', 'true',
  ], 'PROJECT_COMMIT_DIRTY');
  put(repo, PROJECT, cleanProject);

  // plan add
  success(cli(repo,
    'plan', 'add', 'assemble', repo.dir, '--by', 'agent', '--phase', 'rig', '--order', '1',
    '--does', 'Assemble parts.', '--produces', 'Parts output.', '--rests-on', 'assemble',
    '--bar', 'Parts check passes with <= 0 refusals.', '--checkpoint-proposed', 'true',
  ));
  parent = assertCommittedStep(repo, parent, 'plan add', [PROJECT], unrelated);

  // plan revise
  success(cli(repo, 'plan', 'revise', 'assemble', repo.dir, '--by', 'agent', '--does', 'Assemble revised synthetic parts.'));
  parent = assertCommittedStep(repo, parent, 'plan revise', [PROJECT], unrelated);

  // plan bar-amend + unchanged replay
  put(repo, 'scratch/bar-reason.txt', 'Owner narrowed the numeric bar.\n');
  put(repo, 'scratch/bar-quote.txt', 'Keep parts check refusals = 0.\n');
  put(repo, 'scratch/bar-text.txt', 'Parts check exits with refusals = 0.');
  const barAmendArgs = [
    'plan', 'bar-amend', 'assemble', repo.dir, '--by', 'operator',
    '--reason-file', 'scratch/bar-reason.txt', '--quote-file', 'scratch/bar-quote.txt', '--bar-file', 'scratch/bar-text.txt',
  ];
  success(cli(repo, ...barAmendArgs));
  parent = assertCommittedStep(repo, parent, 'plan bar-amend', [PROJECT], unrelated);
  const beforeBarReplay = fullState(repo);
  success(cli(repo, ...barAmendArgs));
  expect(fullState(repo)).toEqual(beforeBarReplay);

  // plan checkpoint-withdraw refuses on an unsigned checkpoint, leaving HEAD, index and tree unchanged.
  put(repo, 'scratch/cp-reason.txt', 'Owner asked to skip the intermediate checkpoint.\n');
  put(repo, 'scratch/cp-quote.txt', 'Proceed without stopping at assemble checkpoint.\n');
  assertRefusedUnchanged(repo, [
    'plan', 'checkpoint-withdraw', 'assemble', repo.dir, '--by', 'operator',
    '--reason-file', 'scratch/cp-reason.txt', '--quote-file', 'scratch/cp-quote.txt',
  ], 'CHECKPOINT_WITHDRAWAL_SCOPE');

  // plan replace
  success(cli(repo,
    'plan', 'replace', 'assemble', repo.dir, '--by', 'agent', '--phase', 'rig', '--order', '1',
    '--does', 'Assemble replaced parts.', '--produces', 'Replaced parts output.', '--rests-on', 'assemble',
    '--bar', 'Parts check exits with refusals = 0.', '--checkpoint-proposed', 'false',
  ));
  parent = assertCommittedStep(repo, parent, 'plan replace', [PROJECT], unrelated);

  // plan remove
  success(cli(repo, 'plan', 'remove', 'assemble', repo.dir, '--by', 'agent'));
  assertCommittedStep(repo, parent, 'plan remove', [PROJECT], unrelated);

  // plan checkpoint-withdraw on a seeded enabled checkpoint + unchanged replay
  const seeded = JSON.parse(bytes(repo, PROJECT).toString('utf8')) as JsonObject;
  const atIso = new Date(TEST_NOW - 1_000).toISOString();
  (seeded.plan as JsonObject).steps = [{
    id: 'assemble', phase: 'rig', order: 1, does: 'Assemble parts.', produces: 'Parts output.',
    rests_on: ['assemble'], bar: 'Parts check exits with refusals = 0.', checkpoint_proposed: true,
    checkpoint: { delegated: false, by: 'synthetic-owner', at: atIso, verbatim: 'Keep checkpoint.', value: true },
    status: 'in-progress', drafted_at: atIso,
  }];
  const cpRepo = makeRepo(seeded);
  put(cpRepo, source, readFileSync(join(import.meta.dir, '..', 'templates', 'example-current', source)));
  put(cpRepo, planPath, 'Build a standing idle character. Use core projection.\n');
  git(cpRepo, 'add', '--', source, planPath);
  git(cpRepo, 'commit', '-qm', 'Seed inputs and plan');
  const cpUnrelated = plantUnrelated(cpRepo);
  const cpStart = head(cpRepo);
  put(cpRepo, 'scratch/cp-reason.txt', 'Owner asked to skip the intermediate checkpoint.\n');
  put(cpRepo, 'scratch/cp-quote.txt', 'Proceed without stopping at assemble checkpoint.\n');
  const withdrawArgs = [
    'plan', 'checkpoint-withdraw', 'assemble', cpRepo.dir, '--by', 'operator',
    '--reason-file', 'scratch/cp-reason.txt', '--quote-file', 'scratch/cp-quote.txt',
  ];
  success(cli(cpRepo, ...withdrawArgs));
  assertCommittedStep(cpRepo, cpStart, 'plan checkpoint-withdraw', [PROJECT], cpUnrelated);
  const beforeWithdrawReplay = fullState(cpRepo);
  success(cli(cpRepo, ...withdrawArgs));
  expect(fullState(cpRepo)).toEqual(beforeWithdrawReplay);
});

test('#1168 group 4: comment ingest and comment close commit exact paths, list in history, and leave unrelated/refused/replay states intact', async () => {
  const repo = makeRepo();
  repo.dir = realpathSync(repo.dir);
  const jobId = 'synthetic-comment-history-job';
  const origin = 'http://127.0.0.1:43199';
  const project = JSON.parse(bytes(repo, PROJECT).toString('utf8')) as JsonObject;
  project.review_job = { jobId, origin };
  putJson(repo, PROJECT, project);
  const modelPath = 'specs/rig/config.json';
  put(repo, modelPath, '{"bones":[]}\n');
  git(repo, 'add', '--', PROJECT, modelPath);
  git(repo, 'commit', '-qm', 'Seed job binding and config');

  const identity = currentJobIdentity({
    root: repo.dir, stateDir: 'unused-private-state', fingerprint: 'synthetic',
    reviewer: { id: 'synthetic-owner', role: 'owner' },
  }, repo.dir);
  writePrivateJson(join(repo.dir, JOB_BINDING_FILE), {
    schema: 'rig-create/job-binding@1', identity, jobId, origin, fetchCapability: 'synthetic-grant',
  }, true);

  const unrelated = plantUnrelated(repo);
  let parent = head(repo);
  const recordHash = jobHash(bytes(repo, PROJECT));
  const initialConfigSha = sha256(bytes(repo, modelPath));
  const act: JsonObject = {
    schema: JOB_COMMENT_ONLY_ACT_SCHEMA,
    actId: 'act-comment-1',
    jobId,
    publicationId: 'pub-1',
    kind: 'comments',
    at: new Date(tick()).toISOString(),
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: {
      sourceHash: '1'.repeat(64), projectHash: recordHash,
      package: { id: 'pkg', revision: '1' }, selector: null,
      model: { path: modelPath, sha256: initialConfigSha },
      direction: null, optionSet: null, appliedResult: null, plan: null, parts: null, commit: parent,
    },
    value: { comments: [{ text: 'Tighten the synthetic config.' }] },
  };
  const actBytes = JSON.stringify(act);
  const actSha = jobHash(actBytes);

  // Refused comment ingest (empty comments) leaves HEAD, index and tree unchanged.
  const badAct = { ...act, value: { comments: [] } };
  const beforeBadIngest = fullState(repo);
  expect(() => commentCommand(['--from-review', 'act-comment-1', repo.dir], tick(), { fetch: () => ({ bytes: JSON.stringify(badAct) }) }))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
  expect(fullState(repo)).toEqual(beforeBadIngest);

  // Dirty project.json refuses before writing.
  const cleanProject = bytes(repo, PROJECT);
  put(repo, PROJECT, `${cleanProject.toString().trimEnd()}\n\n`);
  const beforeDirtyIngest = fullState(repo);
  expect(() => commentCommand(['--from-review', 'act-comment-1', repo.dir], tick(), { fetch: () => ({ bytes: actBytes }) }))
    .toThrow(expect.objectContaining({ code: 'PROJECT_COMMIT_DIRTY' }));
  expect(fullState(repo)).toEqual(beforeDirtyIngest);
  put(repo, PROJECT, cleanProject);

  // Valid comment ingest commits project.json with prefix `comment ingest:` and replay makes no commit.
  const ingested = commentCommand(['--from-review', 'act-comment-1', repo.dir, '--json'], tick(), { fetch: () => ({ bytes: actBytes }) });
  expect({ exit: ingested.exit, stderr: ingested.stderr }).toEqual({ exit: 0, stderr: undefined });
  parent = assertCommittedStep(repo, parent, 'comment ingest', [PROJECT], unrelated);

  const beforeReplayIngest = fullState(repo);
  const replayedIngest = commentCommand(['--from-review', 'act-comment-1', repo.dir, '--json'], tick(), { fetch: () => ({ bytes: actBytes }) });
  expect(replayedIngest.exit).toBe(0);
  expect(fullState(repo)).toEqual(beforeReplayIngest);

  // Refused comment close (unchanged saw sha256) leaves HEAD, index and tree unchanged.
  assertRefusedUnchanged(repo, [
    'comment', '--close', '0', repo.dir, '--act-sha256', actSha, '--after', `${modelPath}=${initialConfigSha}`,
  ], 'COMMENT_CLOSURE_INVALID');

  // Edit the bound config file and run comment --close: commits both project.json and the bound file.
  put(repo, modelPath, '{"bones":[{"name":"root"}]}\n');
  const afterConfigSha = sha256(bytes(repo, modelPath));
  const closeArgs = ['comment', '--close', '0', repo.dir, '--act-sha256', actSha, '--after', `${modelPath}=${afterConfigSha}`];
  success(cli(repo, ...closeArgs));
  parent = assertCommittedStep(repo, parent, 'comment close', [PROJECT, modelPath], unrelated);

  // Unchanged replay of comment --close makes no commit.
  const beforeReplayClose = fullState(repo);
  success(cli(repo, ...closeArgs));
  expect(fullState(repo)).toEqual(beforeReplayClose);

  // Mesh-carrying comment act commits project.json, retained act evidence, and written mesh-delta revision files while leaving MM unrelated untouched.
  const meshRoot = join(tempDir(), 'mesh-comment');
  copyWithRunningCreatePin(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), meshRoot);
  const meshDir = realpathSync(meshRoot);
  symlinkSync(join(import.meta.dir, '../node_modules'), join(meshDir, 'node_modules'), 'dir');
  const meshRepo: Repo = { dir: meshDir, env: repo.env };
  const workingConfig = 'working/config.json';
  const frozenConfig = 'evidence/v1/config-source.json';
  const portableConfig = 'derived/review/v1/config.json';
  const meshProject = JSON.parse(bytes(meshRepo, PROJECT).toString('utf8')) as JsonObject;
  const version = (meshProject.versions as JsonObject[])[0]!;
  const pkg = version.review_package as JsonObject;
  const rawConfig = JSON.parse(bytes(meshRepo, portableConfig).toString('utf8')) as JsonObject;
  const bust = { alpha: 0.25, apex_l: [74, 44], apex_r: [54, 44], bone_l: 'body', bone_r: 'body', cleavage: [64, 44] };
  const torsoMesh = (rawConfig.meshes as JsonObject).torso as JsonObject;
  (rawConfig.meshes as JsonObject).torso = {
    r: torsoMesh.r, segments: torsoMesh.segments,
    contour: { tolerance: 1, margin: 1, spacing: 4, bust },
  };
  const portableBytes = `${JSON.stringify(rawConfig, null, 2)}\n`;
  const workingBytes = `${JSON.stringify(rawConfig)}\n`;
  put(meshRepo, workingConfig, workingBytes);
  put(meshRepo, frozenConfig, workingBytes);
  put(meshRepo, portableConfig, portableBytes);
  put(meshRepo, 'evidence/v1/config.json', portableBytes);
  version.registration = { config_source: { path: frozenConfig, sha256: jobHash(workingBytes) } };
  const configSeal = { path: 'evidence/v1/config.json', sha256: jobHash(portableBytes) };
  (version.provenance as JsonObject).config = { ...configSeal, bytes: Buffer.byteLength(portableBytes) };
  pkg.config = configSeal;
  (pkg.files as JsonObject[]).find(row => row.path === 'config.json')!.sha256 = configSeal.sha256;
  putJson(meshRepo, PROJECT, meshProject);
  // Keep derived/ unignored so trackable mesh-delta revisions must be committed by comment ingest itself, not left untracked for baseline.
  put(meshRepo, '.gitignore', GITIGNORE.replace('/derived/\n', ''));
  put(meshRepo, UNRELATED, 'initial unrelated\n');
  git(meshRepo, 'init', '-q');
  git(meshRepo, 'config', '--local', 'user.name', 'Synthetic Writer');
  git(meshRepo, 'config', '--local', 'user.email', 'writer@example.test');
  git(meshRepo, 'add', '--', '.');
  git(meshRepo, 'commit', '-qm', 'Seed rig-review fixture for mesh comment');

  const hostState = jobHostStateRoot(meshDir);
  const meshIdentity = currentJobIdentity({
    root: meshDir, stateDir: hostState, fingerprint: 'rig-create/live-review/1',
    reviewer: { id: 'synthetic-owner', role: 'owner' },
    publicationMode: 'record-and-package',
  }, meshDir);
  let writerGrant: { jobId: string; origin: string; fetchCapability: string } | undefined;
  const host = await startJobHost({
    ...meshIdentity,
    partsEnumerator,
    readRecordPublished,
    readPublished: async input => {
      const ctx = await readPublished(input);
      return { ...ctx, subjects: [...ctx.subjects, { kind: 'review-verdict', stage: 'rig-review' }] };
    },
    installWriterBinding: grant => {
      writerGrant = grant;
    },
  });
  writePrivateJson(join(meshDir, JOB_BINDING_FILE), {
    schema: 'rig-create/job-binding@1',
    identity: meshIdentity,
    ...writerGrant!,
    listenerIncarnation: host.attachment!.listenerIncarnation,
  }, true);
  try {
    const boundRecord = JSON.parse(bytes(meshRepo, PROJECT).toString('utf8')) as JsonObject;
    boundRecord.review_job = { jobId: host.session.jobId, origin: host.origin };
    putJson(meshRepo, PROJECT, boundRecord);
    const livePath = prepareLiveManifest(meshDir, boundRecord, 1);
    git(meshRepo, 'add', '--', PROJECT, livePath);
    git(meshRepo, 'commit', '-qm', 'Bind live review job and manifest');

    const selector = { kind: 'rig' as const, version: 1 };
    const queued = enqueuePublication(meshDir, readWriterBinding(meshDir)!, { path: livePath, selector });
    const pubRes = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
      method: 'POST',
      headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: 'rig-review/job-api@2', verb: 'publish', jobId: host.session.jobId,
        requestId: randomUUID(), expectedGeneration: host.session.status().generation, idempotencyKey: randomUUID(),
        result: { path: livePath, selector },
        freeze: { kind: 'producer-held', holdId: 'synthetic-freeze', record: { path: PROJECT, sha256: jobHash(bytes(meshRepo, PROJECT)) } },
      }),
    }));
    const pubJson = await pubRes.json() as { ok: boolean; value: JsonObject };
    expect(pubJson.ok).toBe(true);
    const pub = pubJson.value;
    acknowledgePublication(queued, String(pub.publicationId), Number(pub.generation), 'synthetic-req');
    rmSync(join(meshDir, '.rig-create-review/outbox'), { recursive: true, force: true });

    const uiHeaders = { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' };
    const pageId = 'mesh-comment-page';
    const displayed = await host.ports.ackDisplayed(host.session.jobId, new Request(`${host.origin}/jobs/${host.session.jobId}/ui/displayed`, {
      method: 'POST', headers: uiHeaders,
      body: JSON.stringify({ publicationId: pub.publicationId, pageId, sourceHash: (pub.source as JsonObject).sourceHash }),
    }));
    if (!displayed.ok) throw new Error(displayed.error.code);

    const seed = (pub.chestLandmarks as JsonObject[])[0]!;
    const seedSource = seed.source as JsonObject;
    const seedFrame = seedSource.frame as JsonObject;
    const chestEdit = {
      attachment: seed.attachment, basis: 'setup',
      bust: { ...bust, apex_l: [75, 44] },
      skin: seed.skin, slot: seed.slot,
      source: { frame: { height: seedFrame.height, width: seedFrame.width }, hash: seedSource.hash },
    };
    const pubSource = pub.source as JsonObject;
    const submitted = await host.ports.commitUIAct(host.session.jobId, new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
      method: 'POST', headers: uiHeaders,
      body: JSON.stringify({
        publicationId: pub.publicationId,
        pageId,
        displayedNonce: displayed.value.displayedNonce,
        expectedGeneration: host.session.status().generation,
        submissionId: pageId,
        kind: 'comments',
        value: {
          comments: [{ text: 'Nudge torso hull and landmark.' }],
          carriers: [
            { kind: 'mesh-edits', file: pubSource.model, meshEdits: meshEdits(meshDir, pubSource) },
            { kind: 'chest-landmarks', file: pubSource.model, chestLandmarks: [{ edit: chestEdit, sha256: jobHash(JSON.stringify(chestEdit)) }] },
          ],
        },
      }),
    }));
    if (!submitted.ok) throw new Error(submitted.error.code);
    const meshActId = submitted.value.actId;
    const meshAt = Math.max(Date.parse(EXAMPLE_REOPEN_AT) + 5_000, Date.parse(submitted.value.at) + 1_000);

    const meshUnrelated = plantUnrelated(meshRepo);
    const meshParent = head(meshRepo);
    const beforeCorrections = asArray((JSON.parse(bytes(meshRepo, PROJECT).toString('utf8')) as JsonObject).corrections).length;

    const meshChild = Bun.spawn(
      [process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, new Date(meshAt).toISOString(), 'comment', '--from-review', meshActId, meshDir, '--config', workingConfig, '--json'],
      { cwd: meshDir, env: meshRepo.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [meshStdout, meshStderr, meshExit] = await Promise.all([
      new Response(meshChild.stdout).text(),
      new Response(meshChild.stderr).text(),
      meshChild.exited,
    ]);
    expect({ exit: meshExit, stderr: meshStderr, ok: meshStdout.length > 0 }).toEqual({ exit: 0, stderr: '', ok: true });

    const afterMeshProject = JSON.parse(bytes(meshRepo, PROJECT).toString('utf8')) as JsonObject;
    const lastReceipt = asArray(afterMeshProject.review_acts).filter(isObject).at(-1)!;
    const evidencePath = `evidence/v1/${String(lastReceipt.sha256)}.act.json`;
    const meshFiles = asArray(afterMeshProject.corrections).slice(beforeCorrections).filter(isObject).flatMap(row =>
      isObject(row.outcome) ? asArray(row.outcome.written).filter(isObject).map(w => String(w.path)) : []);
    expect(meshFiles.length).toBeGreaterThan(0);

    assertCommittedStep(meshRepo, meshParent, 'comment ingest', [PROJECT, evidencePath, ...meshFiles], meshUnrelated);
  } finally {
    host.stop();
    rmSync(jobHostStateRoot(meshDir), { recursive: true, force: true });
  }
});

test('#1168 group 5: ledger, correction, and diff-classes commit exact paths and leave unrelated/refused/no-op states intact', () => {
  // Use example-current at direction-review so current.direction exists for correction record/resolve.
  const dir = fixture(() => {}, 'example-current/project.json');
  const repo = { dir, env: gitEnv({ name: 'Synthetic Writer', email: 'writer@example.test' }) };
  const record = JSON.parse(bytes(repo, PROJECT).toString('utf8')) as JsonObject;
  record.stage = 'direction-review';
  record.signoffs = (record.signoffs as JsonObject[]).filter(row => row.stage !== 'direction-review');
  record.advances = (record.advances as JsonObject[]).filter(row => row.stage !== 'accepted');
  delete record.corrections_contract;
  delete record.corrections;
  putJson(repo, PROJECT, record);
  put(repo, UNRELATED, 'initial unrelated\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '--', '.');
  git(repo, 'commit', '-qm', 'Seed current direction-review fixture');

  const unrelated = plantUnrelated(repo);
  let parent = head(repo);

  // correction --adopt + unchanged retry
  success(cli(repo, 'correction', '--adopt', repo.dir));
  parent = assertCommittedStep(repo, parent, 'correction', [PROJECT], unrelated);
  const beforeAdoptRetry = fullState(repo);
  success(cli(repo, 'correction', '--adopt', repo.dir));
  expect(fullState(repo)).toEqual(beforeAdoptRetry);

  // Refused correction record (missing verbatim file) leaves HEAD, index and tree unchanged.
  assertRefusedUnchanged(repo, [
    'correction', 'record', repo.dir, '--id', 'dir-fix-1', '--path', 'described',
    '--stage', 'direction-review', '--by', 'synthetic-owner',
  ], 'CORRECTION_USAGE');

  // correction record (described on current.direction)
  put(repo, 'scratch/corr-words.txt', 'Slow the camera settle slightly at the loop seam.\n');
  success(cli(repo,
    'correction', 'record', repo.dir, '--id', 'dir-fix-1', '--path', 'described',
    '--stage', 'direction-review', '--by', 'synthetic-owner', '--verbatim-file', 'scratch/corr-words.txt',
  ));
  parent = assertCommittedStep(repo, parent, 'correction', [PROJECT], unrelated);

  // ledger add + refused duplicate + ledger retire + refused double retire
  put(repo, 'scratch/ledger-quote.txt', 'Slow the camera settle slightly at the loop seam.\n');
  assertRefusedUnchanged(repo, [
    'ledger', 'add', 'L1', repo.dir, '--by', 'agent', '--check', 'seam-settle',
    '--bar', 'seam delta <= 8', '--note', 'corrections[unknown]', '--verbatim-file', 'scratch/ledger-quote.txt',
  ], 'FIX_LEDGER_NOTE_UNKNOWN');

  success(cli(repo,
    'ledger', 'add', 'L1', repo.dir, '--by', 'agent', '--check', 'seam-settle',
    '--bar', 'seam delta <= 8', '--note', 'corrections[dir-fix-1]', '--verbatim-file', 'scratch/ledger-quote.txt',
  ));
  parent = assertCommittedStep(repo, parent, 'ledger add', [PROJECT], unrelated);

  put(repo, 'scratch/retire-reason.txt', 'Superseded by scene loop-seam bar.\n');
  success(cli(repo, 'ledger', 'retire', 'L1', repo.dir, '--by', 'synthetic-owner', '--reason-file', 'scratch/retire-reason.txt'));
  parent = assertCommittedStep(repo, parent, 'ledger retire', [PROJECT], unrelated);
  assertRefusedUnchanged(repo, [
    'ledger', 'retire', 'L1', repo.dir, '--by', 'synthetic-owner', '--reason-file', 'scratch/retire-reason.txt',
  ], 'LEDGER_ROW_RETIRED');

  // Update current.direction.files_sha256 in a fresh record commit or test correction resolve refusal + success:
  // Refused correction resolve (unchanged current.direction output) leaves HEAD, index and tree unchanged.
  put(repo, 'scratch/resolve-reason.txt', 'Recomposed direction with updated loop timing.\n');
  assertRefusedUnchanged(repo, [
    'correction', 'resolve', 'dir-fix-1', repo.dir, '--by', 'agent', '--reasoning-file', 'scratch/resolve-reason.txt',
  ], 'CORRECTION_OUTCOME');

  // diff-classes on example-numbered fixture with a newly added diff-report file
  const draftDir = fixture(() => {}, 'example-numbered/example-project.json');
  const diffRepo = { dir: draftDir, env: repo.env };
  const draftRecord = JSON.parse(bytes(diffRepo, PROJECT).toString('utf8')) as JsonObject;
  delete draftRecord.diff_map;
  putJson(diffRepo, PROJECT, draftRecord);
  put(diffRepo, UNRELATED, 'initial unrelated\n');
  git(diffRepo, 'init', '-q');
  git(diffRepo, 'add', '--', '.');
  git(diffRepo, 'commit', '-qm', 'Seed numbered fixture for diff-classes');
  const diffUnrelated = plantUnrelated(diffRepo);
  const diffParent = head(diffRepo);

  const reportRel = 'evidence/fresh-diff-components.json';
  const srcReport = join(import.meta.dir, '..', 'templates', 'example-numbered', 'evidence', 'diff-components.json');
  cpSync(srcReport, join(diffRepo.dir, reportRel));

  // Read-only diff-classes makes no commit and leaves untracked report + unrelated edits untouched.
  const classesOut = success(cli(diffRepo, 'diff-classes', diffRepo.dir, '--diff-report', reportRel));
  expect(head(diffRepo)).toBe(diffParent);
  expect(snapshot(diffRepo)).toEqual(diffUnrelated);

  // Refused diff-classes (--by human) leaves HEAD, index and tree unchanged.
  const parsedClasses = JSON.parse(classesOut) as { id: string; key: { coverage_band: string; border_parts: string[] } }[];
  const triage: Record<string, { status: string; why: string }> = {};
  for (const cls of parsedClasses) {
    triage[cls.id] = { status: 'in-painting', why: `Measured ${cls.key.coverage_band} border ${cls.key.border_parts[0] ?? 'edge'}.` };
  }
  put(diffRepo, 'scratch/triage.json', `${JSON.stringify({ classes: triage })}\n`);
  assertRefusedUnchanged(diffRepo, [
    'diff-classes', diffRepo.dir, '--diff-report', reportRel, '--triage-file', 'scratch/triage.json', '--by', 'human-user',
  ], 'DIFF_MAP_NOT_AGENT');

  // Valid diff-classes commits project.json and the bound diff report.
  success(cli(diffRepo, 'diff-classes', diffRepo.dir, '--diff-report', reportRel, '--triage-file', 'scratch/triage.json', '--by', 'agent'));
  assertCommittedStep(diffRepo, diffParent, 'diff-classes', [PROJECT, reportRel], diffUnrelated);
});

test('#1168 group 6: restart, derived add, intake-report, checkpoint-evidence, signoff, amend, and collection-binding commit exact paths and preserve refused/replay invariants', () => {
  // 1) restart, derived add, intake-report, signoff, and amend on a seeded numbered fixture
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const repo: Repo = { dir, env: gitEnv({ name: 'Synthetic Writer', email: 'writer@example.test' }) };
  put(repo, '.gitignore', GITIGNORE);
  put(repo, UNRELATED, 'initial unrelated\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '--', '.');
  git(repo, 'commit', '-qm', 'Seed numbered fixture for group 6');
  const unrelated = plantUnrelated(repo);
  let parent = head(repo);

  // amend: domain refusal (agent signer) + dirty project.json refusal + valid forward amendment
  put(repo, 'inputs/replacement-panel.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  put(repo, 'scratch/amend-words.txt', 'Replace the synthetic panel outline.\n');
  assertRefusedUnchanged(repo, [
    'amend', 'parts', repo.dir, '--kind', 'part', '--target', 'panel',
    '--change', 'inputs/replacement-panel.svg', '--by', 'agent', '--verbatim-file', 'scratch/amend-words.txt',
  ], 'SIGNOFF_NOT_HUMAN');

  const cleanBeforeDirtyAmend = bytes(repo, PROJECT);
  put(repo, PROJECT, `${cleanBeforeDirtyAmend.toString('utf8')}\n`);
  assertRefusedUnchanged(repo, [
    'amend', 'parts', repo.dir, '--kind', 'part', '--target', 'panel',
    '--change', 'inputs/replacement-panel.svg', '--by', 'synthetic-owner', '--verbatim-file', 'scratch/amend-words.txt',
  ], 'PROJECT_COMMIT_DIRTY');
  put(repo, PROJECT, cleanBeforeDirtyAmend);

  success(cli(repo,
    'amend', 'parts', repo.dir, '--kind', 'part', '--target', 'panel',
    '--change', 'inputs/replacement-panel.svg', '--by', 'synthetic-owner', '--verbatim-file', 'scratch/amend-words.txt',
  ));
  parent = assertCommittedStep(repo, parent, 'amend', [PROJECT, 'inputs/replacement-panel.svg'], unrelated);

  // signoff (paused): terminal accepted pause refuses, agent signer refuses, valid signoff commits project.json
  put(repo, 'scratch/pause-sign.txt', 'Pause work temporarily.\n');
  assertRefusedUnchanged(repo, ['pause', repo.dir, '--by', 'synthetic-owner', '--verbatim-file', 'scratch/pause-sign.txt'], 'PAUSE_STAGE_INVALID');
  assertRefusedUnchanged(repo, ['signoff', 'paused', repo.dir, '--by', 'agent', '--verbatim-file', 'scratch/pause-sign.txt'], 'SIGNOFF_NOT_HUMAN');
  success(cli(repo, 'signoff', 'paused', repo.dir, '--by', 'synthetic-owner', '--verbatim-file', 'scratch/pause-sign.txt'));
  parent = assertCommittedStep(repo, parent, 'signoff', [PROJECT], unrelated);

  // derived add: domain refusal (missing file) + trackable derived output + ignored derived/ output
  assertRefusedUnchanged(repo, [
    'derived', 'add', repo.dir, '--source', 'inputs/painting.png', '--file', 'evidence/missing-prep.png', '--operation', 'crop plate',
  ], 'DERIVED_FILE_UNREADABLE');

  put(repo, 'evidence/prepared-plate.png', 'synthetic prepared plate bytes');
  success(cli(repo, 'derived', 'add', repo.dir, '--source', 'inputs/painting.png', '--file', 'evidence/prepared-plate.png', '--operation', 'crop plate'));
  parent = assertCommittedStep(repo, parent, 'derived add', [PROJECT, 'evidence/prepared-plate.png'], unrelated);

  put(repo, 'derived/ignored-prep.png', 'synthetic ignored derived bytes');
  success(cli(repo, 'derived', 'add', repo.dir, '--source', 'inputs/painting.png', '--file', 'derived/ignored-prep.png', '--operation', 'denoise plate'));
  parent = assertCommittedStep(repo, parent, 'derived add', [PROJECT], unrelated);

  // restart: prepare writer-dated inputs first so restart keeps them cleanly
  const restartDir = fixture(p => {
    const stamp = new Date(TEST_NOW).toISOString();
    for (const raw of (p.inputs as JsonObject[])) raw.at = stamp;
  }, 'example-numbered/example-project.json');
  const restartRepo: Repo = { dir: restartDir, env: repo.env };
  put(restartRepo, '.gitignore', GITIGNORE);
  put(restartRepo, UNRELATED, 'initial unrelated\n');
  git(restartRepo, 'init', '-q');
  git(restartRepo, 'add', '--', '.');
  git(restartRepo, 'commit', '-qm', 'Seed restart repo');
  const restartUnrelated = plantUnrelated(restartRepo);
  let restartParent = head(restartRepo);

  put(restartRepo, 'scratch/restart-chat.txt', 'Start v1 fresh while keeping inputs and ledger.\n');
  const saidAt = new Date(TEST_NOW).toISOString();
  assertRefusedUnchanged(restartRepo, [
    'restart', restartRepo.dir, '--by', 'agent',
    '--owner-chat', 'scratch/restart-chat.txt', '--said-at', saidAt, '--relayed-by', 'synthetic-operator',
  ], 'SIGNOFF_NOT_HUMAN');
  success(cli(restartRepo,
    'restart', restartRepo.dir, '--by', 'synthetic-owner',
    '--owner-chat', 'scratch/restart-chat.txt', '--said-at', saidAt, '--relayed-by', 'synthetic-operator',
  ));
  restartParent = assertCommittedStep(restartRepo, restartParent, 'restart', [PROJECT], restartUnrelated);

  // intake-report: run on a parts-stage project, verify Refusal codes (PROJECT_COMMIT_DIRTY & INTAKE_REPORT_INVALID) and bound report commit
  const intakeDir = fixture(p => { p.stage = 'parts'; }, 'example-numbered/example-project.json');
  const intakeRepo: Repo = { dir: intakeDir, env: repo.env };
  put(intakeRepo, '.gitignore', GITIGNORE);
  put(intakeRepo, UNRELATED, 'initial unrelated\n');
  git(intakeRepo, 'init', '-q');
  git(intakeRepo, 'add', '--', '.');
  git(intakeRepo, 'commit', '-qm', 'Seed intake repo');
  const intakeUnrelated = plantUnrelated(intakeRepo);
  let intakeParent = head(intakeRepo);
  put(intakeRepo, 'scratch/pause-words.txt', 'Pause parts stage.\n');
  assertRefusedUnchanged(intakeRepo, ['pause', intakeRepo.dir, '--by', 'synthetic-owner', '--verbatim-file', 'scratch/pause-words.txt'], 'PAUSED_UNSIGNED');

  const preflightBytes = readFileSync(join(import.meta.dir, 'fixtures/intake/preflight.json'));
  put(intakeRepo, 'evidence/intake-preflight.json', preflightBytes);
  assertRefusedUnchanged(intakeRepo, [
    'intake-report', intakeRepo.dir, '--id', 'crop-1', '--report', 'evidence/intake-preflight.json',
    '--sha256', '0'.repeat(64), '--parts-version', '2.16.0', '--by', 'agent',
  ], 'INTAKE_REPORT_INVALID');

  const cleanIntakeProject = bytes(intakeRepo, PROJECT);
  put(intakeRepo, PROJECT, `${cleanIntakeProject.toString('utf8')}\n`);
  assertRefusedUnchanged(intakeRepo, [
    'intake-report', intakeRepo.dir, '--id', 'crop-1', '--report', 'evidence/intake-preflight.json',
    '--sha256', sha256(preflightBytes), '--parts-version', '2.16.0', '--by', 'agent',
  ], 'PROJECT_COMMIT_DIRTY');
  put(intakeRepo, PROJECT, cleanIntakeProject);

  success(cli(intakeRepo,
    'intake-report', intakeRepo.dir, '--id', 'crop-1', '--report', 'evidence/intake-preflight.json',
    '--sha256', sha256(preflightBytes), '--parts-version', '2.16.0', '--by', 'agent',
  ));
  intakeParent = assertCommittedStep(intakeRepo, intakeParent, 'intake-report', [PROJECT, 'evidence/intake-preflight.json'], intakeUnrelated);

  // checkpoint-evidence: attach, unchanged replay, clear, and clear replay
  const cw = checkpointWorkspace();
  const cpRepo: Repo = { dir: cw.root, env: repo.env };
  put(cpRepo, '.gitignore', GITIGNORE);
  put(cpRepo, UNRELATED, 'initial unrelated\n');
  const cpBoundAssets = [...cw.packet.tiles.map(tile => tile.path), cw.packet.table.path];
  const savedAssets = new Map(cpBoundAssets.map(path => [path, bytes(cpRepo, path)]));
  for (const path of cpBoundAssets) writeFileSync(join(cpRepo.dir, path), '');
  git(cpRepo, 'init', '-q');
  git(cpRepo, 'add', '--', '.gitignore', PROJECT, UNRELATED);
  git(cpRepo, 'commit', '-qm', 'Seed checkpoint workspace');
  for (const [path, content] of savedAssets) put(cpRepo, path, content);
  const cpUnrelated = plantUnrelated(cpRepo);
  let cpParent = head(cpRepo);

  put(cpRepo, 'scratch/bad-packets.json', '{not-json');
  assertRefusedUnchanged(cpRepo, ['checkpoint-evidence', cpRepo.dir, '--file', 'scratch/bad-packets.json'], 'CHECKPOINT_EVIDENCE_INVALID');

  put(cpRepo, 'scratch/packets.json', `${JSON.stringify([cw.packet], null, 2)}\n`);
  success(cli(cpRepo, 'checkpoint-evidence', cpRepo.dir, '--file', 'scratch/packets.json'));
  cpParent = assertCommittedStep(cpRepo, cpParent, 'checkpoint-evidence', [PROJECT, ...cpBoundAssets], cpUnrelated);

  // Unchanged replay makes no commit.
  const beforeCpReplay = fullState(cpRepo);
  success(cli(cpRepo, 'checkpoint-evidence', cpRepo.dir, '--file', 'scratch/packets.json'));
  expect(fullState(cpRepo)).toEqual(beforeCpReplay);

  // --clear commits project.json; repeating --clear makes no commit.
  success(cli(cpRepo, 'checkpoint-evidence', cpRepo.dir, '--clear'));
  cpParent = assertCommittedStep(cpRepo, cpParent, 'checkpoint-evidence', [PROJECT], cpUnrelated);
  const beforeClearReplay = fullState(cpRepo);
  success(cli(cpRepo, 'checkpoint-evidence', cpRepo.dir, '--clear'));
  expect(fullState(cpRepo)).toEqual(beforeClearReplay);

  // signoff parts-review on current.parts binds and commits its structure snapshot
  const currentDir = join(tempDir(), 'current-signoff');
  cpSync(join(import.meta.dir, '../templates/example-current'), currentDir, { recursive: true });
  const currentRepo: Repo = { dir: currentDir, env: repo.env };
  const currentRecord = JSON.parse(bytes(currentRepo, PROJECT).toString('utf8')) as JsonObject;
  currentRecord.stage = 'parts-review';
  currentRecord.signoffs = (currentRecord.signoffs as JsonObject[]).filter(s => ['interview', 'plan-approved'].includes(String(s.stage)));
  currentRecord.advances = (currentRecord.advances as JsonObject[]).slice(0, 3);
  delete (currentRecord.current as JsonObject).rig;
  delete (currentRecord.current as JsonObject).motion;
  delete (currentRecord.current as JsonObject).direction;
  delete currentRecord.scenes;
  delete currentRecord.directions;
  delete (currentRecord.interview as JsonObject).rigging_context;
  putJson(currentRepo, PROJECT, currentRecord);
  put(currentRepo, UNRELATED, 'initial unrelated\n');
  const structureFiles = readdirSync(join(currentDir, 'evidence/structure/current-parts'))
    .map(name => `evidence/structure/current-parts/${name}`);
  const structureSaved = new Map(structureFiles.map(p => [p, bytes(currentRepo, p)]));
  git(currentRepo, 'init', '-q');
  git(currentRepo, 'add', '--', '.');
  for (const p of structureFiles) git(currentRepo, 'rm', '-f', '--cached', '--', p);
  git(currentRepo, 'commit', '-qm', 'Seed current parts-review before signoff');
  for (const [p, content] of structureSaved) put(currentRepo, p, content);
  const currentUnrelated = plantUnrelated(currentRepo);
  const currentParent = head(currentRepo);

  put(currentRepo, 'scratch/parts-ok.txt', 'Parts look clean.\n');
  const currentSignOut = JSON.parse(success(cli(currentRepo,
    'signoff', 'parts-review', currentRepo.dir, '--by', 'owner',
    '--owner-chat', 'scratch/parts-ok.txt', '--said-at', saidAt, '--relayed-by', 'example-agent', '--json',
  ))) as { structure: { path: string } };
  assertCommittedStep(currentRepo, currentParent, 'signoff', [PROJECT, currentSignOut.structure.path], currentUnrelated);

  // collection-binding: commits member project.json and snapshot in the collection repository, and replays cleanly
  const colRoot = join(tempDir(), 'collection');
  const colRepo: Repo = { dir: colRoot, env: repo.env };
  success(run([process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, new Date(tick()).toISOString(), 'init', '--collection', colRoot, '--no-install'], tempDir(), repo.env));
  git(colRepo, 'config', '--local', 'user.name', 'Synthetic Writer');
  git(colRepo, 'config', '--local', 'user.email', 'writer@example.test');
  const memberDir = join(colRoot, 'members/alpha');
  cpSync(join(import.meta.dir, '../templates/example-current'), memberDir, { recursive: true });
  const memberRepo: Repo = { dir: memberDir, env: repo.env };
  const memberRecord = JSON.parse(bytes(memberRepo, PROJECT).toString('utf8')) as JsonObject;
  memberRecord.name = 'alpha';
  delete memberRecord.collection;
  putJson(memberRepo, PROJECT, memberRecord);
  const colRecord = JSON.parse(bytes(colRepo, 'collection.json').toString('utf8')) as JsonObject;
  colRecord.members = [{ name: 'alpha', project: 'members/alpha/project.json', input: null, note: null }];
  putJson(colRepo, 'collection.json', colRecord);
  put(memberRepo, UNRELATED, 'initial member unrelated\n');
  git(colRepo, 'add', '--', '.');
  git(colRepo, 'commit', '-qm', 'Commit member seed');
  const memberUnrelated = plantUnrelated(memberRepo);
  let colParent = head(colRepo);

  assertRefusedUnchanged(memberRepo, ['collection-binding', memberDir, '--unknown-flag'], 'UNKNOWN_OPTION');
  const cleanMemberProject = bytes(memberRepo, PROJECT);
  put(memberRepo, PROJECT, `${cleanMemberProject.toString('utf8')}\n`);
  assertRefusedUnchanged(memberRepo, ['collection-binding', memberDir, '--out', 'evidence/custom-binding.json'], 'PROJECT_COMMIT_DIRTY');
  expect( { exists: run(['test', '-e', join(memberDir, 'evidence/custom-binding.json')], memberDir, repo.env).code }).toEqual({ exists: 1 });
  put(memberRepo, PROJECT, cleanMemberProject);

  success(cli(memberRepo, 'collection-binding', memberDir, '--out', 'evidence/custom-binding.json'));
  const colSha = head(colRepo);
  expect(colSha).not.toBe(colParent);
  expect(committedPaths(colRepo)).toEqual([
    'members/alpha/evidence/custom-binding.json',
    'members/alpha/project.json',
  ]);
  expect(snapshot(memberRepo)).toEqual(memberUnrelated);
  const memberHistory = JSON.parse(success(cli(memberRepo, 'history', memberDir, '--json'))) as HistoryRow[];
  expect(memberHistory.find(row => row.sha === colSha)).toMatchObject({ sha: colSha, command: 'collection-binding' });
  colParent = colSha;

  // Unchanged retry makes no commit.
  const beforeBindingRetry = fullState(memberRepo);
  success(cli(memberRepo, 'collection-binding', memberDir, '--out', 'evidence/custom-binding.json'));
  expect(fullState(memberRepo)).toEqual(beforeBindingRetry);
  expect(head(colRepo)).toBe(colParent);
});

test('#1168 group 7: pause, resume, advance, step-status, direction --adopt, record --adopt, job withdraw-act, and job close commit exact paths and preserve refused/no-op invariants', async () => {
  // 1) pause, resume, step-status, advance, and direction --adopt on a current-path fixture
  const curDir = join(tempDir(), 'group7-current');
  cpSync(join(import.meta.dir, '../templates/example-current'), curDir, { recursive: true });
  const repo: Repo = { dir: curDir, env: gitEnv({ name: 'Synthetic Writer', email: 'writer@example.test' }) };
  const curRecord = JSON.parse(bytes(repo, PROJECT).toString('utf8')) as JsonObject;
  curRecord.stage = 'parts';
  curRecord.signoffs = (curRecord.signoffs as JsonObject[]).filter(s => ['interview', 'plan-approved'].includes(String(s.stage)));
  curRecord.advances = (curRecord.advances as JsonObject[]).slice(0, 2);
  delete (curRecord.current as JsonObject).rig;
  delete (curRecord.current as JsonObject).motion;
  delete (curRecord.current as JsonObject).direction;
  delete curRecord.scenes;
  delete curRecord.directions;
  delete curRecord.direction_contract;
  delete (curRecord.interview as JsonObject).rigging_context;
  for (const item of (((curRecord.interview as JsonObject).post as JsonObject).items as JsonObject[])) item.guide = null;
  for (const wp of ((curRecord.interview as JsonObject).waypoints as JsonObject[])) {
    if (['turn', 'meshes'].includes(String(wp.id))) wp.guide = null;
  }
  (curRecord.interview as JsonObject).step_plans = ((curRecord.interview as JsonObject).step_plans as JsonObject[])
    .filter(plan => plan.step === 'parts');
  (curRecord.plan as JsonObject).steps = ((curRecord.plan as JsonObject).steps as JsonObject[])
    .filter(step => ['seethrough', 'assemble'].includes(String(step.id)));
  for (const step of ((curRecord.plan as JsonObject).steps as JsonObject[])) {
    step.status = 'pending';
    step.status_history = [];
  }
  putJson(repo, PROJECT, curRecord);
  put(repo, UNRELATED, 'initial unrelated\n');
  const partsCheckSaved = bytes(repo, 'evidence/parts-check.json');
  git(repo, 'init', '-q');
  git(repo, 'config', '--local', 'user.name', 'Synthetic Writer');
  git(repo, 'config', '--local', 'user.email', 'writer@example.test');
  git(repo, 'add', '--', '.');
  git(repo, 'rm', '-f', '--cached', '--', 'evidence/parts-check.json');
  git(repo, 'commit', '-qm', 'Seed current parts stage for group 7');
  put(repo, 'evidence/parts-check.json', partsCheckSaved);
  const unrelated = plantUnrelated(repo);
  let parent = head(repo);

  // pause & resume on current path (#1170): unsigned pause commits project.json -> repeat pause & wrong resume refuse -> resume commits
  put(repo, 'scratch/pause-words.txt', 'Pause parts stage temporarily.\n');
  assertRefusedUnchanged(repo, ['resume', 'parts', repo.dir, '--by', 'synthetic-owner', '--verbatim-file', 'scratch/pause-words.txt'], 'RESUME_NOT_PAUSED');
  assertRefusedUnchanged(repo, ['pause', repo.dir, '--by', 'agent', '--verbatim-file', 'scratch/pause-words.txt'], 'SIGNOFF_NOT_HUMAN');

  success(cli(repo, 'pause', repo.dir, '--by', 'synthetic-owner', '--verbatim-file', 'scratch/pause-words.txt'));
  parent = assertCommittedStep(repo, parent, 'pause', [PROJECT], unrelated);
  assertRefusedUnchanged(repo, ['pause', repo.dir, '--by', 'synthetic-owner', '--verbatim-file', 'scratch/pause-words.txt'], 'PAUSE_ALREADY_PAUSED');

  put(repo, 'scratch/resume-words.txt', 'Resume parts stage.\n');
  assertRefusedUnchanged(repo, ['resume', 'interview', repo.dir, '--by', 'synthetic-owner', '--verbatim-file', 'scratch/resume-words.txt'], 'RESUME_STAGE_MISMATCH');
  success(cli(repo, 'resume', 'parts', repo.dir, '--by', 'synthetic-owner', '--verbatim-file', 'scratch/resume-words.txt'));
  parent = assertCommittedStep(repo, parent, 'resume', [PROJECT], unrelated);

  // step-status: refused skip + valid transitions commit project.json under 'step-status'
  assertRefusedUnchanged(repo, ['step-status', 'seethrough', 'done', repo.dir, '--by', 'agent'], 'STEP_STATUS_TRANSITION');
  for (const stepId of ['seethrough', 'assemble']) {
    for (const status of ['in-progress', 'done']) {
      success(cli(repo, 'step-status', stepId, status, repo.dir, '--by', 'agent'));
      parent = assertCommittedStep(repo, parent, 'step-status', [PROJECT], unrelated);
    }
  }

  // advance: refused removed flag + valid advance with bound --parts-check commits project.json + evidence/parts-check.json
  assertRefusedUnchanged(repo, ['advance', 'parts-review', repo.dir, '--by', 'agent'], 'ADVANCE_WORDS_REMOVED');
  success(cli(repo, 'advance', 'parts-review', repo.dir, '--parts-check', 'evidence/parts-check.json', '--parts', 'outputs/parts/rig'));
  parent = assertCommittedStep(repo, parent, 'advance', [PROJECT, 'evidence/parts-check.json'], unrelated);

  // Plain advance (parts-review -> rigging-interview) commits only project.json
  success(cli(repo, 'advance', 'rigging-interview', repo.dir));
  parent = assertCommittedStep(repo, parent, 'advance', [PROJECT], unrelated);

  // direction --adopt: domain refusal + dirty refusal + adopt commit + unchanged retry makes no commit
  assertRefusedUnchanged(repo, ['direction', '--adopt', repo.dir, '--unknown'], 'DIRECTION_USAGE');
  const cleanBeforeDirAdopt = bytes(repo, PROJECT);
  put(repo, PROJECT, `${cleanBeforeDirAdopt.toString('utf8')}\n`);
  assertRefusedUnchanged(repo, ['direction', '--adopt', repo.dir], 'PROJECT_COMMIT_DIRTY');
  put(repo, PROJECT, cleanBeforeDirAdopt);

  success(cli(repo, 'direction', '--adopt', repo.dir));
  parent = assertCommittedStep(repo, parent, 'direction adopt', [PROJECT], unrelated);

  const beforeDirAdoptRetry = fullState(repo);
  success(cli(repo, 'direction', '--adopt', repo.dir));
  expect(fullState(repo)).toEqual(beforeDirAdoptRetry);

  // 2) record parts|rig|motion|direction --adopt
  const adoptRepo = makeRepo(freshProjectRecord('synthetic-adopt', TEST_NOW));
  git(adoptRepo, 'config', '--local', 'user.name', 'Synthetic Writer');
  git(adoptRepo, 'config', '--local', 'user.email', 'writer@example.test');
  const writeLegacy = (path: string, body: string) => {
    put(adoptRepo, path, body);
    return { path, sha256: sha256(Buffer.from(body)), bytes: Buffer.byteLength(body) };
  };
  const adoptRecord = JSON.parse(bytes(adoptRepo, PROJECT).toString('utf8')) as JsonObject;
  adoptRecord.versions = [
    {
      n: 4,
      kind: 'rig',
      at: '2026-10-01T00:00:00.000Z',
      built_by: 'synthetic-builder',
      built_with: { '@rig-c/parts': '2.57.0', '@rig-c/core': '3.8.1' },
      registration: {
        config_source: writeLegacy('evidence/v4/registration/config-source.json', '{}'),
        check_report: { ...writeLegacy('evidence/v4/registration/check.json', '{"spec":"rig-parts-check/1"}'), spec: 'rig-parts-check/1' },
      },
      outputs: [
        writeLegacy('outputs/v4/out/parts.json', '{}'),
        writeLegacy('outputs/v4/out/parts/body.png', 'synthetic part'),
        writeLegacy('outputs/v4/out/rig/run.json', '{"spec":"rig-run/1","command":"rig"}'),
        writeLegacy('outputs/v4/out/check/build/skeleton.model.json', '{"spec":"rigc-compiled/3"}'),
        writeLegacy('outputs/v4/out/check/build/run.json', '{"spec":"rigc-run/1","command":"build"}'),
        writeLegacy('outputs/v4/idle/frames.json', '{"spec":"rigc-frames/1","sets":[{"animation":"idle"}]}'),
      ],
    },
    {
      n: 7,
      kind: 'post',
      rig_version: 4,
      at: '2026-10-01T00:00:00.000Z',
      built_by: 'synthetic-builder',
      built_with: { '@rig-c/parts': '2.57.0', '@rig-c/core': '3.8.1' },
      outputs: [
        writeLegacy('outputs/v7/compose/check/build/skeleton.model.json', '{"spec":"rigc-compiled/3"}'),
      ],
    },
  ];
  putJson(adoptRepo, PROJECT, adoptRecord);
  git(adoptRepo, 'add', '--', '.');
  git(adoptRepo, 'commit', '-qm', 'Seed legacy versions for record --adopt');
  const adoptUnrelated = plantUnrelated(adoptRepo);
  let adoptParent = head(adoptRepo);

  for (const kind of ['parts', 'rig', 'motion', 'direction'] as const) {
    const res = cli(adoptRepo, 'record', kind, adoptRepo.dir, '--adopt');
    expect(res.code).toBe(0);
    adoptParent = assertCommittedStep(adoptRepo, adoptParent, `record ${kind} adopt`, [PROJECT], adoptUnrelated);
    // Once current.<kind> exists, --adopt refuses and leaves HEAD/index/tree unchanged.
    assertRefusedUnchanged(adoptRepo, ['record', kind, adoptRepo.dir, '--adopt'], 'RECORD_ADOPT_CURRENT_EXISTS');
  }

  // 3) job withdraw-act and job close (with and without disposition)
  const jobRepo = makeRepo({ ...freshProjectRecord('synthetic-job-close', TEST_NOW), owner: { language: 'en' } });
  git(jobRepo, 'config', '--local', 'user.name', 'Synthetic Writer');
  git(jobRepo, 'config', '--local', 'user.email', 'writer@example.test');
  const canonicalDir = realpathSync(jobRepo.dir);
  jobRepo.dir = canonicalDir;
  const origin = 'http://127.0.0.1:43210';

  const installFakeBoundJob = (jobId: string, pendingActIds: string[]) => {
    const identity = currentJobIdentity({
      root: canonicalDir,
      stateDir: join(tempDir(), `state-${jobId}`),
      fingerprint: 'synthetic-close-fp',
      reviewer: { id: 'synthetic-owner', role: 'owner' },
    }, canonicalDir);
    const rec = JSON.parse(bytes(jobRepo, PROJECT).toString('utf8')) as JsonObject;
    rec.review_job = { jobId, origin };
    putJson(jobRepo, PROJECT, rec);
    git(jobRepo, 'add', '--', PROJECT);
    git(jobRepo, 'commit', '-qm', `Bind ${jobId}`, '--only', '--', PROJECT);
    writePrivateJson(join(canonicalDir, JOB_BINDING_FILE), {
      schema: 'rig-create/job-binding@1',
      identity,
      jobId,
      origin,
      fetchCapability: 'cap-fetch',
      listenerIncarnation: `inc-${jobId}`,
    }, true);

    let closed = false;
    const acts = pendingActIds.map(actId => ({
      schema: JOB_COMMENT_ONLY_ACT_SCHEMA,
      jobId,
      actId,
      publicationId: 'pub-1',
      at: new Date(TEST_NOW).toISOString(),
      authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
      kind: 'comments',
      source: {
        sourceHash: 'a'.repeat(64),
        projectHash: 'b'.repeat(64),
        selector: { kind: 'current', output: 'parts' },
        manifest: { path: 'review-live.json', sha256: 'c'.repeat(64) },
      },
      value: { comments: [{ id: 'c1', text: 'Synthetic pending comment.' }] },
    }));
    const startHost = async () => ({
      reused: true,
      origin,
      stop: () => {},
      session: {
        jobId,
        authorize: () => {},
        status: () => ({ generation: 1 }),
        hostCredentials: () => ({ agent: 'cap-agent', owner: 'cap-owner' }),
      },
      ports: {
        handleJobApi: async (req: Request) => {
          const body = await req.json() as { verb: string; after?: unknown };
          if (body.verb === 'next') {
            return Response.json({
              ok: true,
              value: body.after
                ? { status: 'timeout', cursor: 'end', events: [] }
                : { status: acts.length ? 'events' : 'timeout', cursor: 'end', events: acts.map(act => ({ type: 'act', act })) },
            });
          }
          if (body.verb === 'close') {
            closed = true;
            return Response.json({ ok: true, value: { closed: true } });
          }
          return Response.json({ ok: false });
        },
      },
    } as unknown as JobOwnerHost);
    return { startHost, isClosed: () => closed };
  };

  // 3a) job withdraw-act: refuses dirty project.json, then commits project.json with 'job withdraw-act'
  const job1 = installFakeBoundJob('job-withdraw-1', ['act-w1']);
  const jobUnrelated = plantUnrelated(jobRepo);
  let jobParent = head(jobRepo);

  put(jobRepo, 'scratch/withdraw-chat.txt', 'Withdraw my earlier comment act.\n');
  const withdrawOpts = {
    '--by': 'synthetic-owner',
    '--owner-chat': join(canonicalDir, 'scratch/withdraw-chat.txt'),
    '--said-at': new Date(TEST_NOW).toISOString(),
    '--relayed-by': 'synthetic-operator',
  };

  const cleanJob1 = bytes(jobRepo, PROJECT);
  // Stage an index-only edit on project.json while keeping working-tree bytes equal to original so PROJECT_COMMIT_DIRTY fires.
  put(jobRepo, PROJECT, `${cleanJob1.toString('utf8')}\n`);
  git(jobRepo, 'add', '--', PROJECT);
  put(jobRepo, PROJECT, cleanJob1);
  const beforeDirtyWithdraw = fullState(jobRepo);
  await expect(withdrawCreateJobAct(canonicalDir, 'act-w1', withdrawOpts, tick(), job1.startHost))
    .rejects.toMatchObject({ code: 'PROJECT_COMMIT_DIRTY' });
  expect(fullState(jobRepo)).toEqual(beforeDirtyWithdraw);
  git(jobRepo, 'reset', '-q', 'HEAD', '--', PROJECT);

  await withdrawCreateJobAct(canonicalDir, 'act-w1', withdrawOpts, tick(), job1.startHost);
  jobParent = assertCommittedStep(jobRepo, jobParent, 'job withdraw-act', [PROJECT], jobUnrelated);

  // Plain job close (no pending acts / no disposition) makes NO commit even when project.json is dirty!
  const dirtyBeforePlainClose = `${bytes(jobRepo, PROJECT).toString('utf8')}\n`;
  put(jobRepo, PROJECT, dirtyBeforePlainClose);
  const closedPlain = await closeCreateJob(canonicalDir, job1.startHost, false, undefined, tick());
  expect(closedPlain).toEqual({ status: 'closed' });
  expect(job1.isClosed()).toBe(true);
  expect(head(jobRepo)).toBe(jobParent);
  git(jobRepo, 'checkout', '--', PROJECT);

  // 3b) job close --discard-acts: refuses dirty project.json BEFORE closing host, then commits project.json with 'job close'
  const job2 = installFakeBoundJob('job-discard-2', ['act-d1']);
  jobParent = head(jobRepo);

  const cleanJob2 = bytes(jobRepo, PROJECT);
  put(jobRepo, PROJECT, `${cleanJob2.toString('utf8')}\n`);
  git(jobRepo, 'add', '--', PROJECT);
  put(jobRepo, PROJECT, cleanJob2);
  const beforeDirtyClose = fullState(jobRepo);
  await expect(closeCreateJob(canonicalDir, job2.startHost, false, { '--discard-acts': 'Superseded by new stage', '--by': 'agent' }, tick()))
    .rejects.toMatchObject({ code: 'PROJECT_COMMIT_DIRTY' });
  expect(job2.isClosed()).toBe(false);
  expect(fullState(jobRepo)).toEqual(beforeDirtyClose);
  git(jobRepo, 'reset', '-q', 'HEAD', '--', PROJECT);

  const closedDiscard = await closeCreateJob(canonicalDir, job2.startHost, false, { '--discard-acts': 'Superseded by new stage', '--by': 'agent' }, tick());
  expect(closedDiscard).toEqual({ status: 'closed' });
  expect(job2.isClosed()).toBe(true);
  assertCommittedStep(jobRepo, jobParent, 'job close', [PROJECT], jobUnrelated);

  // 3c) With a pending finalized comment act on the bound job, step-status ... done still exits 0 and commits.
  const stepJobRoot = join(tempDir(), 'group7-pending-act-step-status');
  cpSync(join(import.meta.dir, '../templates/example-current'), stepJobRoot, { recursive: true });
  const stepJobDir = realpathSync(stepJobRoot);
  symlinkSync(join(import.meta.dir, '../node_modules'), join(stepJobDir, 'node_modules'), 'dir');
  const stepJobRepo: Repo = { dir: stepJobDir, env: repo.env };
  const stepJobRec = JSON.parse(bytes(stepJobRepo, PROJECT).toString('utf8')) as JsonObject;
  stepJobRec.stage = 'post';
  stepJobRec.signoffs = (stepJobRec.signoffs as JsonObject[]).filter(s => s.stage !== 'direction-review');
  stepJobRec.advances = (stepJobRec.advances as JsonObject[]).filter(a => !['direction-review', 'accepted'].includes(String(a.stage)));
  const composeStep = ((stepJobRec.plan as JsonObject).steps as JsonObject[]).find(s => s.id === 'composition')!;
  composeStep.status = 'in-progress';
  composeStep.status_history = (composeStep.status_history as JsonObject[]).filter(h => h.status !== 'done');
  putJson(stepJobRepo, PROJECT, stepJobRec);
  put(stepJobRepo, UNRELATED, 'initial unrelated\n');
  git(stepJobRepo, 'init', '-q');
  git(stepJobRepo, 'config', '--local', 'user.name', 'Synthetic Writer');
  git(stepJobRepo, 'config', '--local', 'user.email', 'writer@example.test');
  git(stepJobRepo, 'add', '--', '.');
  git(stepJobRepo, 'commit', '-qm', 'Seed current project with in-progress compose step');

  const stepHost = await openCreateJob(stepJobDir, { id: 'synthetic-owner', role: 'owner' }, tick());
  try {
    const stepBoundRec = JSON.parse(bytes(stepJobRepo, PROJECT).toString('utf8')) as JsonObject;
    const stepRecHash = jobHash(bytes(stepJobRepo, PROJECT));
    const { path: curManifest } = prepareCurrentManifest(stepJobDir, stepBoundRec, 'parts', stepRecHash);
    git(stepJobRepo, 'add', '--', curManifest);
    git(stepJobRepo, 'commit', '-qm', 'Commit current live manifest');

    const curSelector = { kind: 'current' as const, output: 'parts' as const, record: stepRecHash };
    const curQueued = enqueuePublication(stepJobDir, readWriterBinding(stepJobDir)!, { path: curManifest, selector: curSelector });
    await reconcilePublication(stepJobDir, curQueued, entry => publishPending(entry, undefined, undefined, undefined, undefined, tick()));
    let curPub: JsonObject | undefined;
    for await (const ev of jobEvents(stepHost, true)) {
      if (ev.type === 'published') curPub = ev.publication as unknown as JsonObject;
    }
    expect(curPub).toBeDefined();

    const curUiHeaders = { origin: stepHost.origin, 'X-Review-Capability': stepHost.session.hostCredentials().ui, 'content-type': 'application/json' };
    const curPageId = 'pending-act-page';
    const curDisplayed = await stepHost.ports.ackDisplayed(stepHost.session.jobId, new Request(`${stepHost.origin}/jobs/${stepHost.session.jobId}/ui/displayed`, {
      method: 'POST',
      headers: curUiHeaders,
      body: JSON.stringify({ publicationId: curPub!.publicationId, pageId: curPageId, sourceHash: (curPub!.source as JsonObject).sourceHash }),
    }));
    if (!curDisplayed.ok) throw new Error(curDisplayed.error.code);

    const pendingSubmitted = await stepHost.ports.commitUIAct(stepHost.session.jobId, new Request(`${stepHost.origin}/jobs/${stepHost.session.jobId}/ui/acts`, {
      method: 'POST',
      headers: curUiHeaders,
      body: JSON.stringify({
        publicationId: curPub!.publicationId,
        pageId: curPageId,
        displayedNonce: curDisplayed.value.displayedNonce,
        expectedGeneration: stepHost.session.status().generation,
        submissionId: curPageId,
        kind: 'comments',
        value: { comments: [{ text: 'Finalized comment act pending ingestion.' }] },
      }),
    }));
    if (!pendingSubmitted.ok) throw new Error(pendingSubmitted.error.code);

    const stepJobUnrelated = plantUnrelated(stepJobRepo);
    const stepJobParent = head(stepJobRepo);
    const spawnAsyncCli = async (cliArgs: string[]) => {
      const child = Bun.spawn(
        [process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, new Date(Math.max(tick(), Date.parse(pendingSubmitted.value.at) + 2_000)).toISOString(), ...cliArgs],
        { cwd: stepJobDir, env: stepJobRepo.env, stdout: 'pipe', stderr: 'pipe' },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    };

    // Confirm the bound job genuinely holds an unresolved finalized act that gates record-only writers (input add).
    put(stepJobRepo, 'inputs/gated-probe.png', 'probe');
    const gatedInput = await spawnAsyncCli(['input', 'add', 'inputs/gated-probe.png', stepJobDir, '--origin', 'synthetic']);
    expect(gatedInput.code).toBeGreaterThan(0);
    expect(gatedInput.stderr).toContain('JOB_ASK_PENDING');
    rmSync(join(stepJobDir, 'inputs/gated-probe.png'), { force: true });
    expect(head(stepJobRepo)).toBe(stepJobParent);

    // step-status ... done is ungated by pending asks, exits 0, and commits project.json.
    const stepDone = await spawnAsyncCli(['step-status', 'composition', 'done', stepJobDir, '--by', 'agent']);
    expect({ code: stepDone.code, stderr: stepDone.stderr }).toEqual({ code: 0, stderr: '' });
    assertCommittedStep(stepJobRepo, stepJobParent, 'step-status', [PROJECT], stepJobUnrelated);
  } finally {
    stepHost.stop();
    rmSync(jobHostStateRoot(stepJobDir), { recursive: true, force: true });
  }
});



