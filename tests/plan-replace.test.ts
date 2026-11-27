import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import type { NextReport } from '../src/next.ts';
import { planStepCompleted } from '../src/plan-history.ts';
import { Refusal } from '../src/refusal.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, planCommand, testClock, TEST_NOW } from './clock.ts';
import { arr, fixture, obj, plantLegacyReopen, step, waypoint } from './fixtures.ts';
import { cli, ownerChatArgs, tempDir } from './helpers.ts';

const REMESH = join(import.meta.dir, '../templates/example-remesh');
const STALE = 'PLAN_STEP_PREDATES_ANSWER';
const file = (root: string): string => join(root, 'project.json');
const read = (root: string): JsonObject => JSON.parse(readFileSync(file(root), 'utf8')) as JsonObject;
const write = (root: string, project: JsonObject): void => writeFileSync(file(root), `${JSON.stringify(project, null, 2)}\n`);
const codes = (root: string): string[] => checkProject(root).refusals.map(finding => finding.code);
const DEPTH = ['--phase', 'rig', '--order', '2.5', '--does', 'Turn the synthetic head with depth.', '--produces', 'A synthetic depth turn.',
  '--rests-on', 'turn', '--bar', 'The synthetic head turns.', '--checkpoint-proposed', 'false'];

afterEach(() => testClock.reset());

function unchanged(root: string, code: string, action: () => unknown): void {
  const before = readFileSync(file(root));
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Refusal);
  expect((error as Refusal).code).toBe(code);
  expect(readFileSync(file(root))).toEqual(before);
}

/** A completed synthetic project whose turn was answered in depth mode and whose depth step is done and signed. */
function depthProject(root: string): JsonObject {
  cpSync(REMESH, root, { recursive: true });
  const project = read(root);
  delete project.amendments;
  for (const definition of arr(obj(project.plan).steps).map(obj)) definition.status = obj(arr(definition.status_history).at(-1)).status!;
  const guide = obj(waypoint(project, 'turn').guide);
  guide.value = { mode: 'depth' };
  guide.verbatim = 'Head turn\nThe head turns with depth, like the head-turn demo.';
  obj(guide.choice).picks = [{ ask: 'view', option_id: 'turn', shown: { label: 'Head turn', effect: 'The head turns with depth, like the head-turn demo.' } }];
  const steps = arr(obj(project.plan).steps);
  steps.push({ ...structuredClone(step(project, 'bones')), id: 'turn', order: 2.5, rests_on: ['turn'],
    does: 'Turn the synthetic head with depth.', produces: 'A synthetic depth turn.', bar: 'The synthetic head turns.' });
  steps.sort((a, b) => Number(obj(a).order) - Number(obj(b).order));
  for (const signoff of arr(project.signoffs).map(obj).filter(signoff => signoff.stage === 'rigging-interview')) {
    if (Array.isArray(signoff.steps)) signoff.steps.push('turn');
    obj(signoff.step_hashes).turn = stepHash(step(project, 'turn'));
    const hashes = selectAnswerHashes(root, project, signoff);
    if (hashes !== undefined) signoff.answer_hashes = hashes;
  }
  write(root, project);
  return project;
}

test('#993 a done depth step is replaced in one write after a turn amendment, where remove and add each refuse', () => {
  const root = join(tempDir('create-993-'), 'project');
  const project = depthProject(root);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    CODEX_HOME: tempDir('create-993-codex-') };
  const run = (...args: string[]) => cli(args, root, env);
  testClock.set(TEST_NOW);
  expect(codes(root)).toEqual([]);
  const done = step(project, 'turn');
  expect(done.status).toBe('done');

  // The owner amends the depth answer and re-answers it, still in depth mode.
  const words = join(root, 'owner-direction.txt');
  writeFileSync(words, 'Turn the synthetic head the other way.');
  expect(run('amend', 'rigging-interview', '--kind', 'interview-answer', '--target', 'turn',
    '--change', 'owner-direction.txt', '--by', 'user', ...ownerChatArgs(words))).toMatchObject({ code: 0, stderr: '' });
  testClock.set(TEST_NOW + 1_000);
  const options = JSON.parse(readFileSync(join(root, String(obj(obj(obj(waypoint(project, 'turn').guide).choice).set).path)), 'utf8')) as JsonObject;
  options.id = 'turn-amendment';
  options.drafted_at = testClock.iso();
  const path = 'evidence/interview/turn-amendment.json';
  const bytes = JSON.stringify(options);
  writeFileSync(join(root, path), bytes);
  expect(run('interview-options', 'turn', '--file', path)).toMatchObject({ code: 0, stderr: '' });
  testClock.set(TEST_NOW + 2_000);
  expect(run('interview-answer', 'turn', '--set', path, '--sha256', createHash('sha256').update(bytes).digest('hex'),
    '--by', 'user', ...ownerChatArgs(words), '--pick', 'view=turn')).toMatchObject({ code: 0, stderr: '' });
  expect(obj(obj(waypoint(read(root), 'turn').guide).value)).toEqual({ mode: 'depth' });
  const checked = run('interview', '--check', '--json');
  expect(checked.code).toBe(1);
  expect(JSON.parse(checked.stdout).refusals.map((finding: { code: string; path: string }) => [finding.code, finding.path]))
    .toEqual([[STALE, 'plan.steps[turn]']]);

  // next names the one write that reaches the remedy.
  const rendered = run('next', '--json');
  expect(rendered.code).toBe(0);
  const next = JSON.parse(rendered.stdout) as NextReport;
  expect(next.refusals).toEqual([expect.objectContaining({ code: STALE, field: 'plan.steps[turn]', message: expect.stringContaining('plan replace turn') })]);
  expect(next.moves[0]).toMatchObject({ role: 'agent', field: 'plan.steps[turn]' });
  expect(next.moves[0]!.command).toMatch(/^rig-create plan replace turn .* --by agent --phase rig --order 2\.5 .* --rests-on turn .* --checkpoint-proposed false$/);
  expect(next.moves[0]!.command).not.toContain('plan remove');

  // The two-command path next used to offer refuses without a write.
  testClock.set(TEST_NOW + 3_000);
  unchanged(root, 'RIG_DEPTH_PLAN_MISSING', () => planCommand(['remove', 'turn', root, '--by', 'agent']));
  unchanged(root, 'PLAN_STEP_INVALID', () => planCommand(['add', 'turn', root, '--by', 'agent', ...DEPTH]));
  // Replace keeps the phase; a phase change is refused without a write.
  unchanged(root, 'PLAN_STEP_INVALID', () => planCommand(['replace', 'turn', root, '--by', 'agent', ...DEPTH.map(value => value === 'rig' ? 'post' : value)]));

  const reset = step(read(root), 'turn');
  expect(planCommand(['replace', 'turn', root, '--by', 'agent', ...DEPTH]).exit).toBe(0);
  const replaced = read(root);
  expect(arr(obj(replaced.plan).replaced).at(-1)).toEqual({ step: reset, sha256: stepHash(reset), action: 'removed', at: testClock.iso(), by: 'agent' });
  const fresh: JsonObject = { ...reset, checkpoint: null, status: 'pending', drafted_at: testClock.iso() };
  delete fresh.status_history;
  expect(step(replaced, 'turn')).toEqual(fresh);
  expect(arr(obj(replaced.plan).steps).map(value => obj(value).id)).toEqual(arr(obj(project.plan).steps).map(value => obj(value).id));
  const after = run('interview', '--check', '--json');
  expect(JSON.parse(after.stdout).refusals).toEqual([]);
  expect(after.code).toBe(0);
}, 60_000);

const POST = ['--phase', 'post', '--order', '1', '--does', 'Frame the approved rig.', '--produces', 'A camera track.',
  '--rests-on', 'bones', '--bar', 'The frame retains every approved part.', '--checkpoint-proposed', 'false'];

function seethroughReplacement(): { dir: string; flags: string[] } {
  testClock.set(EXAMPLE_NOW);
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const original = step(read(dir), 'seethrough');
  const words = join(dir, 'words.txt');
  writeFileSync(words, 'Reopen the plan for a new draft.');
  plantLegacyReopen(dir, 'plan-approved', { by: 'user', wordsFile: words });
  return { dir, flags: ['--phase', 'rig', '--order', String(original.order), '--does', 'Rebuild the approved parts.',
    '--produces', 'Replacement parts.', '--rests-on', 'seethrough', '--bar', 'The replacement meets the owner answer.', '--checkpoint-proposed', 'false'] };
}

test('#993 #981 a completed non-depth step is replaced, the same record as remove then add', () => {
  const viaReplace = seethroughReplacement();
  const viaPair = seethroughReplacement();
  expect(read(viaReplace.dir)).toEqual(read(viaPair.dir));
  const project = read(viaReplace.dir);
  expect(planStepCompleted(project, step(project, 'seethrough'))).toBe(true);
  expect(planCommand(['replace', 'seethrough', viaReplace.dir, '--by', 'agent', ...viaReplace.flags]).exit).toBe(0);
  expect(planCommand(['remove', 'seethrough', viaPair.dir, '--by', 'agent']).exit).toBe(0);
  expect(planCommand(['add', 'seethrough', viaPair.dir, '--by', 'agent', ...viaPair.flags]).exit).toBe(0);
  expect(read(viaReplace.dir)).toEqual(read(viaPair.dir));
  expect(step(read(viaReplace.dir), 'seethrough')).toMatchObject({ status: 'pending', checkpoint: null, does: 'Rebuild the approved parts.' });
  expect(obj(arr(obj(read(viaReplace.dir).plan).replaced).at(-1))).toMatchObject({ action: 'removed' });
  expect(codes(viaReplace.dir)).toEqual([]);
});

test('#993 an unfinished non-depth step is replaced, and replace needs an existing id and every add field', () => {
  testClock.set('2026-11-20T00:00:00Z');
  const dir = fixture(project => {
    waypoint(project, 'bones').guide = { delegated: false, by: 'user', at: '2026-11-10T00:00:00Z', verbatim: 'Use the approved rig.', value: 'Use the approved rig.' };
  }, 'project.json');
  const baseline = codes(dir);
  unchanged(dir, 'PLAN_STEP_INVALID', () => planCommand(['replace', 'camera', dir, '--by', 'agent', ...POST]));
  expect(planCommand(['add', 'camera', dir, '--by', 'agent', ...POST]).exit).toBe(0);
  unchanged(dir, 'PLAN_OPTION_INVALID', () => planCommand(['replace', 'camera', dir, '--by', 'agent', '--does', 'Only one field.']));
  const before = step(read(dir), 'camera');
  testClock.set('2026-11-20T00:00:01Z');
  expect(planCommand(['replace', 'camera', dir, '--by', 'agent', ...POST.map(value => value === 'Frame the approved rig.' ? 'Frame the rig closer.' : value)]).exit).toBe(0);
  const after = read(dir);
  expect(step(after, 'camera')).toMatchObject({ does: 'Frame the rig closer.', status: 'pending', drafted_at: '2026-11-20T00:00:01.000Z' });
  expect(arr(obj(after.plan).replaced)).toEqual([{ step: before, sha256: stepHash(before), action: 'removed', at: '2026-11-20T00:00:01.000Z', by: 'agent' }]);
  expect(codes(dir)).toEqual(baseline);
});
