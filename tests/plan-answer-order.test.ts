import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_STEP_ANSWER_SINCE, type CheckReport } from '../src/check.ts';
import type { NextReport } from '../src/next.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, testClock } from './clock.ts';
import { arr, obj, step, waypoint } from './fixtures.ts';
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

async function assertSignoffAsk({ root, env, run, stage }: Pick<ReturnType<typeof prepare>, 'root' | 'env' | 'run' | 'stage'>): Promise<void> {
  const proc = Bun.spawn([process.execPath, ...clockedCli(), ...jobOpen], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const errors = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => proc.kill('SIGTERM'), 10_000);
  let output = '';
  try {
    while (!output.includes(`job: asked signoff ${stage}\n`)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    // Keep the owner URL out of test failure output.
    expect(output.split('\n').slice(1)).toContain(`job: asked signoff ${stage}`);
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
  expect(checkProject(root).refusals).toEqual([expect.objectContaining({ code: 'STAGE_LAGGING' })]);
}, 30_000);

test('#561 a completed step stays immutable after an owner amendment and next replaces it with its full definition', async () => {
  const root = join(tempDir("create-561-completed-step's-"), 'project');
  cpSync(join(CHECKPOINTS, '../../example-remesh'), root, { recursive: true });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    CODEX_HOME: tempDir('create-561-codex-') };
  const run = (...args: string[]) => cli(args, root, env);
  const stage = 'rigging-interview';
  const id = 'bones';
  const stepPath = `plan.steps[${id}]`;
  const project = read(root);
  // The captions bind the signed project immediately before the fixture's original amendment.
  delete project.amendments;
  for (const definition of arr(obj(project.plan).steps).map(obj)) {
    definition.status = obj(arr(definition.status_history).at(-1)).status!;
  }
  write(root, project);
  const captions = JSON.parse(readFileSync(join(root, 'evidence/captions.json'), 'utf8')) as JsonObject;
  expect(createHash('sha256').update(readFileSync(file(root))).digest('hex')).toBe(obj(obj(captions.inputs).project).sha256 as string);
  testClock.set(T0);
  expect(checkProject(root)).toMatchObject({ refusals: [], warnings: [] });
  const done = step(project, id);
  expect(done.status).toBe('done');
  const withoutAmendment = structuredClone(project);
  step(withoutAmendment, id).drafted_at = PLAN_STEP_ANSWER_SINCE;
  write(root, withoutAmendment);
  const needsOwner = JSON.parse(run('next', '--json').stdout) as NextReport;
  expect(needsOwner.moves[0]?.role).toBe('human');
  expect(needsOwner.moves[0]?.command).toBeNull();
  expect(needsOwner.moves[0]?.act).toContain('record an owner amendment at rigging-interview or earlier after completion');
  write(root, project);

  const words = join(root, 'owner-direction.txt');
  writeFileSync(words, 'Use the synthetic alternate chains, placement, and length.');
  expect(run('amend', stage, '--kind', 'interview-answer', '--target', `interview.waypoints[${id}].guide`,
    '--change', 'owner-direction.txt', '--by', 'user', ...ownerChatArgs(words))).toMatchObject({ code: 0, stderr: '' });
  const reset = step(read(root), id);
  expect(reset).toEqual({ ...done, status: 'pending' });

  testClock.set(T0 + 1_000);
  const oldSet = obj(obj(obj(waypoint(project, id).guide).choice).set);
  const options = JSON.parse(readFileSync(join(root, String(oldSet.path)), 'utf8')) as JsonObject;
  options.id = 'completed-step-amendment';
  options.drafted_at = testClock.iso();
  const path = 'evidence/interview/completed-step-amendment.json';
  const bytes = JSON.stringify(options);
  writeFileSync(join(root, path), bytes);
  expect(run('interview-options', id, '--file', path)).toMatchObject({ code: 0, stderr: '' });
  testClock.set(T0 + 2_000);
  const picks = arr(options.asks).flatMap(ask => ['--pick', `${String(obj(ask).id)}=alternative`]);
  expect(run('interview-answer', id, '--set', path, '--sha256', createHash('sha256').update(bytes).digest('hex'),
    '--by', 'user', ...ownerChatArgs(words), ...picks)).toMatchObject({ code: 0, stderr: '' });

  const rendered = run('next', '--json');
  expect(rendered.code).toBe(0);
  const next = JSON.parse(rendered.stdout) as NextReport;
  expect(next.refusals).toEqual([expect.objectContaining({ code: STALE, field: stepPath,
    message: expect.stringContaining('plan remove bones followed by plan add bones') })]);
  const move = next.moves[0]!;
  expect(move.role).toBe('agent');
  expect(move.field).toBe(stepPath);
  const command = move.command!;
  expect(command).toMatch(/^rig-create plan remove bones .* && rig-create plan add bones .* --phase rig .* --checkpoint-proposed false$/);
  expect(next.moves.some(move => move.review_act?.kind === 'signoff')).toBe(false);
  const before = readFileSync(file(root));
  expect(run('plan', 'revise', id, '--by', 'agent', '--reason', 'Keep the existing synthetic definition.'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('PLAN_STEP_DONE') });
  expect(readFileSync(file(root))).toEqual(before);

  testClock.set(T0 + 3_000);
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

test('#561 legacy post chronology remains unknown while a proved older rig record only warns', () => {
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
  expect(older.warnings).toContainEqual(expect.objectContaining({ code: STALE, path: 'plan.steps[bones]' }));
});

test('#561 approving an uncovered rig step leaves a stale step repairable', () => {
  const fixture = prepare('rig');
  const { root, stage, words, run } = fixture;
  draftAndAnswer(fixture, 'rig');
  const signed = run('signoff', stage, '--steps', 'motion', '--by', 'user', ...ownerChatArgs(words));
  expect(signed).toMatchObject({ code: 0, stderr: '' });
  expect(checkProject(root).refusals).toContainEqual(expect.objectContaining({ code: STALE, path: 'plan.steps[bones]' }));
  testClock.set(T0 + 3_000);
  expect(run('plan', 'revise', 'bones', '--by', 'agent', '--reason', 'Reviewed the recorded bones guide.')).toMatchObject({ code: 0, stderr: '' });
  expect(checkProject(root).refusals).toEqual([expect.objectContaining({ code: 'STAGE_LAGGING' })]);
  const project = read(root);
  expect(obj(obj(arr(project.signoffs).at(-1)).step_hashes).motion).toBe(stepHash(step(project, 'motion')));
});
