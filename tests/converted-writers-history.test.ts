import { beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OPTIONS_SPEC, optionContext, sha256 } from '../src/choices.ts';
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

