import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { amendCommand } from '../src/amend.ts';
import { PLAN_STEP_ANSWER_SINCE, type CheckReport } from '../src/check.ts';
import { interviewAnswerCommand, interviewOptionsCommand } from '../src/choice-writers.ts';
import { openCreateJob, openRecordPublication } from '../src/job-host.ts';
import type { NextReport } from '../src/next.ts';
import { planCommand } from '../src/plan-writers.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { signoffCommand } from '../src/signoff.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, testClock, TEST_NOW } from './clock.ts';
import { arr, obj, plantLegacyReopen, step, waypoint } from './fixtures.ts';
import { cli, clockedCli, ownerChatArgs, run as runProcess, tempDir, treeDigest } from './helpers.ts';

const CHECKPOINTS = join(import.meta.dir, '../templates/example-chain/checkpoints');
const STALE = 'PLAN_STEP_PREDATES_ANSWER';
const UNKNOWN = 'PLAN_STEP_DRAFT_DATE_UNKNOWN';
const T0 = Date.parse(PLAN_STEP_ANSWER_SINCE) + 3_600_000;

const file = (root: string) => join(root, 'project.json');
const read = (root: string): JsonObject => JSON.parse(readFileSync(file(root), 'utf8')) as JsonObject;
const write = (root: string, project: JsonObject): void => writeFileSync(file(root), `${JSON.stringify(project, null, 2)}\n`);
const postItem = (project: JsonObject, id: string): JsonObject =>
  arr(obj(obj(project.interview).post).items).map(obj).find(item => item.id === id)!;
const chronology = (report: CheckReport) => [...report.refusals, ...report.warnings]
  .filter(finding => finding.code === STALE || finding.code === UNKNOWN)
  .map(({ code, path }) => [code, path]);

function completedRemesh(root: string): JsonObject {
  cpSync(join(CHECKPOINTS, '../../example-remesh'), root, { recursive: true });
  const project = read(root);
  delete project.amendments;
  for (const definition of arr(obj(project.plan).steps).map(obj)) {
    definition.status = obj(arr(definition.status_history).at(-1)).status!;
  }
  return project;
}

function prepare(phase: 'rig' | 'post') {
  const root = join(tempDir(), 'project');
  cpSync(join(CHECKPOINTS, phase === 'rig' ? '2-rigging-answers' : '4-direction-post'), root, { recursive: true });
  const project = read(root);
  const id = phase === 'rig' ? 'bones' : 'camera';
  const basis = phase === 'rig' ? 'bones' : 'camera_depth';
  const stage = phase === 'rig' ? 'rigging-interview' : 'post-interview';
  const plan = obj(project.plan);
  plan.steps = arr(plan.steps).filter(step => obj(step).id !== id);
  if (Array.isArray(plan.replaced)) plan.replaced = plan.replaced.filter(entry => obj(obj(entry).step).id !== id);
  if (phase === 'rig') {
    const ready = read(join(CHECKPOINTS, '3-rig-review'));
    cpSync(join(CHECKPOINTS, '3-rig-review/evidence/interview'), join(root, 'evidence/interview'), { recursive: true });
    const interview = obj(project.interview);
    interview.waypoints = arr(interview.waypoints).map(raw => {
      const name = String(obj(raw).id);
      return name === basis ? raw : waypoint(ready, name);
    });
  } else {
    project.stage = stage;
    project.signoffs = arr(project.signoffs).filter(signature => obj(signature).stage !== stage);
    project.advances = arr(project.advances).filter(advance => obj(advance).stage !== 'post');
    for (const raw of arr(plan.steps)) {
      const step = obj(raw);
      if (step.phase !== phase) continue;
      step.checkpoint = null;
      step.status = 'pending';
      delete step.status_history;
      if (step.id === 'timing') delete step.drafted_at;
    }
    if (Array.isArray(plan.replaced)) plan.replaced = plan.replaced.filter(entry => obj(obj(entry).step).id !== 'timing');
    const item = postItem(project, basis);
    item.pending_options = obj(obj(item.guide).choice).set!;
    item.guide = null;
  }
  write(root, project);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    CODEX_HOME: tempDir('create-561-codex-') };
  const words = join(root, 'words.txt');
  writeFileSync(words, 'Keep the approved synthetic option.');
  const run = (...args: string[]) => cli(args, root, env);
  return { root, id, basis, stage, words, env, run, option: phase === 'rig' ? waypoint : postItem };
}

function draftAndAnswer(fixture: ReturnType<typeof prepare>, phase: 'rig' | 'post') {
  const { root, id, basis, words, option, run } = fixture;
  testClock.set(T0);
  expect(run('plan', 'add', id, '--by', 'agent', '--phase', phase, '--order', '3',
    '--does', 'Draft the synthetic step.', '--produces', 'A synthetic result.',
    '--rests-on', basis, '--bar', 'Keep the synthetic input.', '--checkpoint-proposed', 'false').code).toBe(0);
  const binding = obj(option(read(root), basis).pending_options);
  const set = JSON.parse(readFileSync(join(root, String(binding.path)), 'utf8')) as JsonObject;
  const picks = arr(set.asks).flatMap(ask => ['--pick', `${String(obj(ask).id)}=keep`]);
  // The owner said it before the draft, and the recorded guide appeared after it.
  testClock.set(T0 + 2_000);
  const result = run('interview-answer', basis, '--set', String(binding.path), '--sha256', String(binding.sha256),
    '--by', 'user', ...ownerChatArgs(words, new Date(T0 - 1_000).toISOString()), ...picks);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  expect(obj(option(read(root), basis).guide).at).toBe(testClock.iso());
}

const jobOpen = ['job', 'open', '--plan', '--reviewer', 'user', '--role', 'owner'];

async function assertSignoffAsk({ root, env, run }: Pick<ReturnType<typeof prepare>, 'root' | 'env' | 'run' | 'stage'>): Promise<void> {
  const proc = Bun.spawn([process.execPath, ...clockedCli(), ...jobOpen], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const errors = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => proc.kill('SIGTERM'), 10_000);
  let output = '';
  try {
    while (!/\njob: plan published \(publication [^\n]+\)\n/.test(output)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    // Keep the owner URL out of test failure output.
    const lines = output.trim().split('\n').slice(1);
    expect(lines).toEqual([expect.stringMatching(/^job: plan published \(publication [A-Za-z0-9._-]+\)$/)]);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
    const closed = run('job', 'close');
    if (closed.code !== 0 && proc.exitCode === null) proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
    expect(await errors).toBe('');
    expect(closed).toMatchObject({ code: 0, stderr: '' });
  }
}

afterEach(() => testClock.reset());

test.each(['rig', 'post'] as const)('#561 %s answer is recordable, then check and approval require a step revision', async phase => {
  const fixture = prepare(phase);
  const { root, id, basis, stage, words, run } = fixture;
  draftAndAnswer(fixture, phase);
  const stepPath = `plan.steps[${id}]`;
  const recorded = run('interview', '--check', '--json');
  expect(recorded.code).toBe(1);
  const report = JSON.parse(recorded.stdout) as CheckReport;
  expect(report.refusals.map(({ code, path }) => [code, path])).toEqual([[STALE, stepPath]]);
  expect(report.refusals[0]!.message).toContain(`${stepPath}.drafted_at at ${new Date(T0).toISOString()}`);
  expect(report.refusals[0]!.message).toContain(`[${basis}].guide.at ${testClock.iso()}`);
  expect(report.refusals[0]!.message).toContain(`plan revise ${id}`);

  const next = JSON.parse(run('next', '--json').stdout) as NextReport;
  expect(next.moves[0]).toMatchObject({ field: stepPath, role: 'agent',
    command: expect.stringContaining(`plan revise ${id}`) });
  expect(next.moves.some(move => move.field === 'signoffs')).toBe(false);

  const before = treeDigest(root);
  const sign = () => run('signoff', stage, '--by', 'user', ...ownerChatArgs(words));
  for (const attempt of [() => run(...jobOpen), sign]) {
    const refused = attempt();
    expect(refused).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining(`${STALE}: ${stepPath}`) });
    expect(treeDigest(root)).toEqual(before);
  }

  const oldStep = step(read(root), id);
  testClock.set(T0 + 3_000);
  const reason = 'This definition already covers the recorded synthetic answer.';
  expect(run('plan', 'revise', id, '--by', 'agent', '--reason', reason).code).toBe(0);
  const revised = read(root);
  const current = step(revised, id);
  expect(current).toEqual({ ...oldStep, drafted_at: testClock.iso() });
  expect(stepHash(current)).toBe(stepHash(oldStep));
  expect(arr(obj(revised.plan).replaced).at(-1)).toMatchObject({ step: oldStep, action: 'revised', reason, at: testClock.iso() });
  const repaired = checkProject(root);
  expect(repaired.refusals).toEqual([]);
  expect(repaired.warnings.filter(finding => finding.path === stepPath)).toEqual([]);
  if (phase === 'post') {
    expect(repaired.warnings).toContainEqual(expect.objectContaining({ code: UNKNOWN, path: 'plan.steps[timing]' }));
  }

  await assertSignoffAsk(fixture);
  testClock.set(T0 + 4_000);
  expect(sign().code).toBe(0);
  const signed = read(root);
  expect(obj(obj(arr(signed.signoffs).at(-1)).step_hashes)[id]).toBe(stepHash(step(signed, id)));
  expect(checkProject(root).refusals).toEqual([]);
}, 30_000);

test('#561 stale steps block approval while the post interview continues', () => {
  const fixture = prepare('post');
  const { root, words, run } = fixture;
  const project = read(root);
  const composition = postItem(project, 'post_composition');
  const compositionSet = obj(obj(obj(composition.guide).choice).set);
  const timing = postItem(project, 'post_timing');
  const timingSet = obj(obj(obj(timing.guide).choice).set);
  composition.guide = null;
  composition.pending_options = compositionSet;
  timing.guide = null;
  write(root, project);

  const readNext = (): NextReport => {
    const result = run('next', '--json');
    expect(result.code).toBe(0);
    return JSON.parse(result.stdout) as NextReport;
  };
  const choose = (question: string, binding: JsonObject, pick: string, ...extra: string[]) =>
    run('interview-answer', question, '--set', String(binding.path), '--sha256', String(binding.sha256),
      '--by', 'user', ...ownerChatArgs(words), '--pick', `${question}=${pick}`, ...extra);
  const nextHas = (next: NextReport, field: string, command: string) =>
    expect(next.moves).toContainEqual(expect.objectContaining({ field, command: expect.stringContaining(command) }));
  const assertNoApproval = (next: NextReport) => {
    expect(next.accepted).toBe(false);
    expect(next.moves.filter(move => move.field === 'signoffs' || move.review_act?.kind.startsWith('signoff')
      || move.command?.includes('job open') && move.command.includes('--plan'))).toEqual([]);
  };

  testClock.set(T0);
  const other = join(root, 'other.txt');
  writeFileSync(other, 'Show the synthetic scene with a different framing.');
  expect(choose('post_composition', compositionSet, 'other', '--other', `post_composition=${other}`))
    .toMatchObject({ code: 0, stderr: '' });
  expect(checkProject(root).refusals.filter(finding => finding.code === STALE)).toEqual([]);

  draftAndAnswer(fixture, 'post');
  const next = readNext();
  expect(next.refusals).toContainEqual(expect.objectContaining({ code: STALE, field: 'plan.steps[camera]' }));
  expect(next.refusals).toContainEqual(expect.objectContaining({
    code: 'INTERVIEW_CHOICE_REQUIRED', field: 'interview.post.items[post_composition].guide',
  }));
  nextHas(next, 'plan.steps[camera]', 'plan revise camera');
  nextHas(next, 'interview.post.items[post_timing].guide', 'interview-options post_timing');
  nextHas(next, 'interview.post.items[post_composition].guide', 'interview-options post_composition');
  assertNoApproval(next);

  expect(run('interview-options', 'post_timing', '--file', String(timingSet.path))).toMatchObject({ code: 0, stderr: '' });
  const pending = readNext();
  expect(pending.moves).toContainEqual(expect.objectContaining({ review_act: expect.objectContaining({
    kind: 'interview-picks', question_id: 'post_timing',
  }) }));
  expect(pending.moves.some(move => move.command?.includes('--question post_timing'))).toBe(true);
  assertNoApproval(pending);

  expect(choose('post_timing', timingSet, 'auto')).toMatchObject({ code: 0, stderr: '' });
  const delegated = readNext();
  nextHas(delegated, 'interview.post.items[post_timing].guide', 'interview-decision post_timing');
  assertNoApproval(delegated);
  const timingFragment = join(root, 'timing.json');
  writeFileSync(timingFragment, JSON.stringify({ duration: 4, loop: false }));
  expect(run('interview-decision', 'post_timing', '--by', 'agent', '--reasoning-file', words,
    '--fragment', `post_timing=${timingFragment}`)).toMatchObject({ code: 0, stderr: '' });

  const followUp = JSON.parse(readFileSync(join(root, String(compositionSet.path)), 'utf8')) as JsonObject;
  followUp.id = 'composition-follow-up';
  followUp.drafted_at = testClock.iso();
  const path = 'evidence/interview/composition-follow-up.json';
  const bytes = JSON.stringify(followUp);
  writeFileSync(join(root, path), bytes);
  expect(run('interview-options', 'post_composition', '--file', path)).toMatchObject({ code: 0, stderr: '' });
  expect(choose('post_composition', { path, sha256: createHash('sha256').update(bytes).digest('hex') }, 'keep'))
    .toMatchObject({ code: 0, stderr: '' });
  const answered = readNext();
  expect(answered.refusals.filter(finding => finding.code === STALE).map(finding => finding.field).sort())
    .toEqual(['plan.steps[camera]', 'plan.steps[composition]']);
  nextHas(answered, 'plan.steps[composition]', 'plan revise composition');
  assertNoApproval(answered);
});

test('#561 a recorded reopen restores chronology for previously signed stale and unstamped steps', () => {
  const root = join(tempDir(), 'project');
  const project = completedRemesh(root);
  const camera = step(project, 'camera');
  const timing = step(project, 'timing');
  const signoffs = arr(project.signoffs).map(obj);
  const index = signoffs.findIndex(signature => signature.stage === 'post-interview');
  const hashes = obj(signoffs[index]!.step_hashes);
  camera.drafted_at = PLAN_STEP_ANSWER_SINCE;
  delete timing.drafted_at;
  expect(stepHash(camera)).toBe(hashes.camera as string);
  expect(stepHash(timing)).toBe(hashes.timing as string);
  write(root, project);
  testClock.set(TEST_NOW);
  expect(chronology(checkProject(root))).toEqual([]);

  // Persist a historical reopen because the current writer uses amendments.
  plantLegacyReopen(root, 'post-interview');
  const reopened = checkProject(root);
  expect(reopened.effective_stage).toBe('post-interview');
  expect(reopened.warnings).toContainEqual(expect.objectContaining({ code: 'REOPEN_SIGNOFF_LAPSED', path: `signoffs[${index}]` }));
  expect(reopened.refusals).toContainEqual(expect.objectContaining({ code: STALE, path: 'plan.steps[camera]' }));
  expect(reopened.warnings).toContainEqual(expect.objectContaining({ code: UNKNOWN, path: 'plan.steps[timing]' }));
  expect(chronology(reopened)).toEqual([[STALE, 'plan.steps[camera]'], [UNKNOWN, 'plan.steps[timing]']]);
  const retained = read(root);
  expect(arr(retained.signoffs).map(obj)[index]).toEqual(signoffs[index]!);
  expect(stepHash(step(retained, 'camera'))).toBe(hashes.camera as string);
  expect(stepHash(step(retained, 'timing'))).toBe(hashes.timing as string);
});

test('#561 after an owner amendment next replaces a completed step with its full definition', async () => {
  const root = join(tempDir("create-561-completed-step's-"), 'project');
  const project = completedRemesh(root);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    CODEX_HOME: tempDir('create-561-codex-') };
  const run = (...args: string[]) => cli(args, root, env);
  const stage = 'rigging-interview';
  const id = 'bones';
  const stepPath = `plan.steps[${id}]`;
  // The captions bind the signed project immediately before the fixture's original amendment.
  write(root, project);
  const captions = JSON.parse(readFileSync(join(root, 'evidence/captions.json'), 'utf8')) as JsonObject;
  expect(createHash('sha256').update(readFileSync(file(root))).digest('hex')).toBe(obj(obj(captions.inputs).project).sha256 as string);
  testClock.set(TEST_NOW);
  expect(checkProject(root)).toMatchObject({ refusals: [], warnings: [] });
  const done = step(project, id);
  expect(done.status).toBe('done');
  const words = join(root, 'owner-direction.txt');
  writeFileSync(words, 'Use the synthetic alternate chains, placement, and length.');
  expect(run('amend', stage, '--kind', 'interview-answer', '--target', `interview.waypoints[${id}].guide`,
    '--change', 'owner-direction.txt', '--by', 'user', ...ownerChatArgs(words))).toMatchObject({ code: 0, stderr: '' });
  const reset = step(read(root), id);
  expect(reset).toEqual({ ...done, status: 'pending' });
  const scoped = read(root);
  step(scoped, 'meshes').drafted_at = PLAN_STEP_ANSWER_SINCE;
  write(root, scoped);
  expect(chronology(checkProject(root))).toEqual([]);

  testClock.set(TEST_NOW + 1_000);
  const oldSet = obj(obj(obj(waypoint(project, id).guide).choice).set);
  const options = JSON.parse(readFileSync(join(root, String(oldSet.path)), 'utf8')) as JsonObject;
  options.id = 'completed-step-amendment';
  options.drafted_at = testClock.iso();
  const path = 'evidence/interview/completed-step-amendment.json';
  const bytes = JSON.stringify(options);
  writeFileSync(join(root, path), bytes);
  expect(run('interview-options', id, '--file', path)).toMatchObject({ code: 0, stderr: '' });
  testClock.set(TEST_NOW + 2_000);
  const picks = arr(options.asks).flatMap(ask => ['--pick', `${String(obj(ask).id)}=alternative`]);
  expect(run('interview-answer', id, '--set', path, '--sha256', createHash('sha256').update(bytes).digest('hex'),
    '--by', 'user', ...ownerChatArgs(words), ...picks)).toMatchObject({ code: 0, stderr: '' });
  expect(chronology(checkProject(root))).toEqual([[STALE, stepPath]]);

  const rendered = run('next', '--json');
  expect(rendered.code).toBe(0);
  const next = JSON.parse(rendered.stdout) as NextReport;
  expect(next.refusals).toEqual([expect.objectContaining({ code: STALE, field: stepPath,
    message: expect.stringContaining('plan replace bones with the same phase') })]);
  const move = next.moves[0]!;
  expect(move.role).toBe('agent');
  expect(move.field).toBe(stepPath);
  const command = move.command!;
  expect(command).toMatch(/^rig-create plan replace bones .* --phase rig .* --checkpoint-proposed false$/);
  expect(next.moves.some(move => move.review_act?.kind === 'signoff')).toBe(false);

  testClock.set(TEST_NOW + 3_000);
  const bin = tempDir();
  const shim = join(bin, 'rig-create');
  writeFileSync(shim, '#!/bin/sh\nexec "$RIG_TEST_BUN" "$RIG_TEST_CLI" "$RIG_TEST_NOW" "$@"\n');
  chmodSync(shim, 0o700);
  const [cliPath, now] = clockedCli();
  expect(runProcess(['/bin/sh', '-c', command], root, {
    ...env, PATH: `${bin}:${process.env.PATH ?? ''}`,
    RIG_TEST_BUN: process.execPath, RIG_TEST_CLI: cliPath!, RIG_TEST_NOW: now!,
  })).toMatchObject({ code: 0, stderr: '' });
  const repaired = read(root);
  expect(arr(obj(repaired.plan).replaced).at(-1)).toMatchObject({ action: 'removed', step: reset, sha256: stepHash(reset) });
  const fresh = step(repaired, id);
  const expected: JsonObject = { ...reset, checkpoint: null, drafted_at: testClock.iso() };
  delete expected.status_history;
  expect(fresh).toEqual(expected);
  expect(checkProject(root)).toMatchObject({ refusals: [], warnings: [] });
  await assertSignoffAsk({ root, env, run, stage });
}, 30_000);

test('#561 legacy rig dates prove staleness only in the earlier direction, and a known revision dates its step', () => {
  const fixture = prepare('rig');
  const { root, id, run } = fixture;
  draftAndAnswer(fixture, 'rig');
  const project = read(root);
  delete step(project, id).drafted_at;
  write(root, project);
  expect(checkProject(root).refusals).toEqual([expect.objectContaining({ code: STALE, path: 'plan.steps[bones]',
    message: expect.stringContaining('plan.rigging_drafted_at (latest rigging plan edit)') })]);

  obj(project.plan).rigging_drafted_at = testClock.iso();
  write(root, project);
  const unknown = checkProject(root);
  expect(unknown.refusals).toEqual([]);
  expect(unknown.warnings).toContainEqual(expect.objectContaining({ code: UNKNOWN, path: 'plan.steps[bones]' }));

  testClock.set(T0 + 3_000);
  expect(run('plan', 'revise', id, '--by', 'agent', '--does', 'Review the synthetic answer.').code).toBe(0);
  const revised = read(root);
  delete step(revised, id).drafted_at;
  write(root, revised);
  expect(checkProject(root).warnings.filter(finding => finding.path === 'plan.steps[bones]')).toEqual([]);

  // A last removal does not date a subsequently re-added legacy definition.
  obj(arr(obj(revised.plan).replaced).at(-1)).action = 'removed';
  write(root, revised);
  expect(checkProject(root).warnings).toContainEqual(expect.objectContaining({ code: UNKNOWN, path: 'plan.steps[bones]' }));
});

test('#561 unsigned legacy post chronology remains unknown while a covering rig approval settles an older draft', () => {
  const fixture = prepare('post');
  const { root, id } = fixture;
  draftAndAnswer(fixture, 'post');
  const project = read(root);
  delete step(project, id).drafted_at;
  write(root, project);
  const unknown = checkProject(root);
  expect(unknown.refusals).toEqual([]);
  expect(unknown.warnings).toContainEqual(expect.objectContaining({ code: UNKNOWN, path: 'plan.steps[camera]' }));

  step(project, 'bones').drafted_at = '2026-11-06T01:00:00Z';
  write(root, project);
  const older = checkProject(root);
  expect(older.refusals).toEqual([]);
  expect(chronology(older)).toEqual([[UNKNOWN, 'plan.steps[camera]'], [UNKNOWN, 'plan.steps[timing]']]);
  plantLegacyReopen(root, 'rigging-interview');
  const reopened = checkProject(root);
  expect(reopened.refusals.some(finding => finding.code === STALE)).toBe(false);
  expect(chronology(reopened)).toEqual([[STALE, 'plan.steps[bones]']]);
});

test('#561 approving an uncovered rig step leaves a stale step repairable', () => {
  const fixture = prepare('rig');
  const { root, stage, words, run } = fixture;
  draftAndAnswer(fixture, 'rig');
  const candidate = read(root);
  const ready = read(join(CHECKPOINTS, '3-rig-review'));
  for (const id of ['bones', 'meshes', 'constraints']) step(candidate, id).checkpoint = step(ready, id).checkpoint!;
  write(root, candidate);
  const signed = run('signoff', stage, '--steps', 'motion', '--by', 'user', ...ownerChatArgs(words));
  expect(signed).toMatchObject({ code: 0, stderr: '' });
  expect(checkProject(root).refusals).toContainEqual(expect.objectContaining({ code: STALE, path: 'plan.steps[bones]' }));

  const missingCheckpoints = read(root);
  step(missingCheckpoints, 'bones').checkpoint = null;
  step(missingCheckpoints, 'meshes').checkpoint = { delegated: true, by: 'user', at: testClock.iso(), verbatim: 'Decide for me.' };
  expect(checkProject(root, missingCheckpoints).refusals).toEqual([
    expect.objectContaining({ code: STALE, path: 'plan.steps[bones]' }),
    expect.objectContaining({ code: 'DELEGATION_UNDECIDED', path: 'plan.steps[meshes].checkpoint' }),
  ]);

  testClock.set(T0 + 3_000);
  expect(run('plan', 'revise', 'bones', '--by', 'agent', '--reason', 'Reviewed the recorded bones guide.')).toMatchObject({ code: 0, stderr: '' });
  expect(checkProject(root).refusals).toEqual([]);
  const project = read(root);
  expect(obj(obj(arr(project.signoffs).at(-1)).step_hashes).motion).toBe(stepHash(step(project, 'motion')));
});

test('#561 job open refuses a stale step covered by a post-interview re-sign at post', async () => {
  const fixture = prepare('post');
  const { root, id, basis, stage, words, run } = fixture;
  draftAndAnswer(fixture, 'post');
  testClock.set(T0 + 3_000);
  expect(planCommand(['revise', id, root, '--by', 'agent', '--reason', 'Reviewed the initial camera guide.'], testClock.now()).exit).toBe(0);
  expect(planCommand(['revise', 'timing', root, '--by', 'agent', '--rests-on', `post_timing,${basis}`], testClock.now()).exit).toBe(0);
  const project = read(root);
  const ready = read(join(CHECKPOINTS, '4-direction-post'));
  step(project, id).checkpoint = step(ready, id).checkpoint!;
  write(root, project);
  expect(signoffCommand([stage, root, '--steps', 'timing,composition', '--by', 'user', ...ownerChatArgs(words)], testClock.now()).exit).toBe(0);
  testClock.set(T0 + 4_000);
  expect(advanceCommand(['post', root], testClock.now()).exit).toBe(0);
  expect(checkProject(root)).toMatchObject({ effective_stage: 'post', refusals: [] });

  testClock.set(T0 + 5_000);
  expect(amendCommand(['post', root, '--kind', 'interview-answer', '--target', basis,
    '--change', 'words.txt', '--by', 'user', ...ownerChatArgs(words)], testClock.now()).exit).toBe(0);
  const register = (question: string) => {
    const original = obj(obj(obj(postItem(read(root), question).guide).choice).set);
    const options = JSON.parse(readFileSync(join(root, String(original.path)), 'utf8')) as JsonObject;
    options.id = `${question}-resign-amendment`;
    options.drafted_at = testClock.iso();
    const path = `evidence/interview/${String(options.id)}.json`;
    const bytes = JSON.stringify(options);
    writeFileSync(join(root, path), bytes);
    interviewOptionsCommand([question, root, '--file', path], testClock.now());
    return (pick: string) => interviewAnswerCommand([question, root, '--set', path, '--sha256', createHash('sha256').update(bytes).digest('hex'),
      '--by', 'user', ...ownerChatArgs(words), ...arr(options.asks).flatMap(ask => ['--pick', `${String(obj(ask).id)}=${pick}`])], testClock.now());
  };
  const correctCamera = register(basis);
  testClock.set(T0 + 6_000);
  correctCamera('alternative');
  const stepPath = `plan.steps[${id}]`;
  expect(checkProject(root)).toMatchObject({ effective_stage: 'post', refusals: [
    expect.objectContaining({ code: 'SIGNOFF_ANSWERS_STALE', path: `signoffs[6].answer_hashes[${basis}]` }),
    expect.objectContaining({ code: STALE, path: stepPath }),
  ] });

  // The selected plan's stale step must be reported before the signoff preflight
  // can stop at another pending answer.
  testClock.set(T0 + 7_000);
  const correctComposition = register('post_composition');
  const before = treeDigest(root);
  expect(run(...jobOpen)).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining(`${STALE}: ${stepPath}`) });
  expect(treeDigest(root)).toEqual(before);

  testClock.set(T0 + 8_000);
  correctComposition('keep');
  expect(planCommand(['revise', id, root, '--by', 'agent', '--reason', 'Reviewed the amended camera guide.'], testClock.now()).exit).toBe(0);
  const host = await openCreateJob(root, { id: 'user', role: 'owner' }, testClock.now(), undefined, true);
  try {
    expect(await openRecordPublication(root, host, undefined, true, testClock.now())).toEqual([
      expect.stringMatching(/^job: plan published \(publication [A-Za-z0-9._-]+\)$/),
    ]);
  } finally {
    host.stop();
  }
}, 60_000);

test('#997 a step-plan value recorded after a step resting on it was drafted marks that step for revision', () => {
  const fixture = prepare('post');
  const { root, id, basis, run } = fixture;
  const project = read(root);
  delete postItem(project, basis).pending_options;
  write(root, project);
  testClock.set(T0);
  expect(run('plan', 'add', id, '--by', 'agent', '--phase', 'post', '--order', '3',
    '--does', 'Draft the synthetic step.', '--produces', 'A synthetic result.',
    '--rests-on', basis, '--bar', 'Keep the synthetic input.', '--checkpoint-proposed', 'false').code).toBe(0);
  writeFileSync(join(root, 'direction-plan.md'), 'The camera keeps a shallow depth.\n');
  expect(run('plan', 'propose', 'direction', '--file', 'direction-plan.md', '--by', 'agent')).toMatchObject({ code: 0 });
  const files = tempDir();
  writeFileSync(join(files, 'why.md'), 'The plan states this value.\n');
  writeFileSync(join(files, 'value.json'), JSON.stringify('shallow'));
  writeFileSync(join(files, 'quote.txt'), 'The camera keeps a shallow depth.');
  testClock.set(T0 + 2_000);
  const recorded = run('interview-decision', basis, '--by', 'agent', '--reasoning-file', join(files, 'why.md'),
    '--value-file', join(files, 'value.json'), '--plan-quote-file', join(files, 'quote.txt'));
  expect(recorded).toMatchObject({ code: 0, stderr: '' });
  expect(chronology(checkProject(root))).toContainEqual([STALE, `plan.steps[${id}]`]);
}, 60_000);
