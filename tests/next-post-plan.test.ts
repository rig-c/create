import { expect, test } from 'bun:test';
import { cpSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { interviewAnswerCommand, interviewOptionsCommand } from '../src/choice-writers.ts';
import { optionContext } from '../src/choices.ts';
import { sha256 } from '../src/current.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { nextProject } from '../src/next.ts';
import { planCommand } from '../src/plan-writers.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { recordCommand } from '../src/record.ts';
import { sceneCommand } from '../src/scene-writers.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, obj } from './fixtures.ts';
import { ownerChatArgs, tempDir } from './helpers.ts';

test('#1131 next restores the post plan after a direct advance and direction write explains the same recovery', () => {
  const dir = join(tempDir(), 'project');
  cpSync(join(import.meta.dir, '../templates/example-current'), dir, { recursive: true });
  const recordPath = join(dir, 'project.json');
  const read = (): JsonObject => JSON.parse(readFileSync(recordPath, 'utf8')) as JsonObject;
  const project = read();
  const questions = arr(obj(obj(project.interview).post).items).map(obj);
  const picks = questions.map(item => ({ id: String(item.id), words: String(obj(item.guide).verbatim) }));
  for (const item of questions) item.guide = null;
  project.stage = 'post-interview';
  project.advances = arr(project.advances).slice(0, 7);
  project.signoffs = arr(project.signoffs).slice(0, 5);
  delete obj(project.current).motion;
  delete obj(project.current).direction;
  const plan = obj(project.plan);
  plan.steps = arr(plan.steps).filter(step => obj(step).phase === 'rig');
  writeFileSync(recordPath, JSON.stringify(project));
  unlinkSync(join(dir, 'specs/direction/scene.json'));
  unlinkSync(join(dir, 'specs/direction/direction.json'));

  let now = Date.parse(String(obj(arr(project.advances).at(-1)).at)) + 120_000;
  writeFileSync(join(dir, 'plans/direction.md'), 'Keep the camera fixed and loop for four seconds.\n');
  expect(planCommand(['propose', 'direction', dir, '--file', 'plans/direction.md', '--by', 'agent'], now++).exit).toBe(0);
  for (const { id, words } of picks) {
    const path = `evidence/interview/${id}.json`;
    const set = JSON.parse(readFileSync(join(dir, path), 'utf8')) as JsonObject;
    set.drafted_at = new Date(now).toISOString();
    set.context = optionContext(read(), 'post-interview', now, dir);
    const bytes = JSON.stringify(set);
    writeFileSync(join(dir, path), bytes);
    interviewOptionsCommand([id, dir, '--file', path], now++);
    const wordsFile = join(dir, 'words.txt');
    writeFileSync(wordsFile, words);
    interviewAnswerCommand([id, dir, '--set', path, '--sha256', sha256(bytes), '--pick', `${id}=keep`,
      '--by', 'owner', ...ownerChatArgs(wordsFile, new Date(now).toISOString())], now++);
  }

  const commands = () => nextProject(dir, now).moves.flatMap(move => move.command ? [move.command] : []);
  const addedRows = () => commands().filter(command => command.startsWith('rig-create plan add '));
  expect(addedRows()).toHaveLength(3);
  expect(advanceCommand(['post', dir], now++).exit).toBe(0);
  expect(nextProject(dir, now)).toMatchObject({ effective_stage: 'post', refusals: [] });
  const postRows = addedRows();

  // Reuse the example's producer bytes to exercise the real motion and scene writers.
  renameSync(join(dir, 'outputs/motion'), join(dir, 'outputs/motion.next'));
  expect(recordCommand(['motion', dir, '--from', 'outputs/motion.next'], now++).exit).toBe(0);
  expect(sceneCommand(['write', dir, '--compose-scene', 'specs/direction/compose-scene.json'], now++).exit).toBe(0);
  const directionArgs = ['write', dir, '--file', 'specs/direction/intent.json'];
  const before = readFileSync(recordPath);
  const blockedCommands = commands();
  expect(() => directionCommand(directionArgs, now)).toThrow(expect.objectContaining({
    code: 'DIRECTION_CITATION',
    message: expect.stringContaining('plan.steps[camera]'),
  }));
  expect(readFileSync(recordPath)).toEqual(before);

  const rows = [['camera', 'camera_depth'], ['timing', 'post_timing'], ['composition', 'post_composition']];
  expect(postRows).toHaveLength(rows.length);
  expect(blockedCommands.some(command => command.startsWith('rig-create direction write '))).toBe(false);
  expect(() => directionCommand(directionArgs, now)).toThrow(expect.objectContaining({
    code: 'DIRECTION_CITATION',
    message: expect.stringContaining('missing post plan steps camera, timing, composition'),
  }));
  expect(() => directionCommand(directionArgs, now)).toThrow(expect.objectContaining({
    code: 'DIRECTION_CITATION',
    message: expect.stringContaining('run rig-create next in the project'),
  }));

  const planArgs = (id: string, guide: string, order: number): string[] =>
    ['add', id, dir, '--by', 'agent', '--phase', 'post', '--order', String(order),
      '--does', 'Prepare the synthetic take.', '--produces', 'A looping take.',
      '--rests-on', guide, '--bar', 'Match the selected choice.', '--checkpoint-proposed', 'false'];
  expect(planCommand(planArgs('camera-alias', 'camera_depth', 7), now++).exit).toBe(0);
  for (const [index, [id, guide]] of rows.entries()) {
    const command = addedRows().find(row => row.startsWith(`rig-create plan add ${id} `));
    expect(command).toContain(`--phase post --order ${index + 8} `);
    expect(command).toContain(`--rests-on ${guide} `);
    expect(planCommand(planArgs(id!, guide!, index + 8), now++).exit).toBe(0);
  }

  expect(addedRows()).toEqual([]);
  expect(commands().some(command => command.startsWith('rig-create direction write '))).toBe(true);
  expect(directionCommand(directionArgs, now++).exit).toBe(0);
});

test('an optional post approval retains its signed answer and plan while direction cites a new choice', () => {
  const dir = join(tempDir(), 'project');
  cpSync(join(import.meta.dir, '../templates/example-current'), dir, { recursive: true });
  const read = (path: string): JsonObject => JSON.parse(readFileSync(join(dir, path), 'utf8')) as JsonObject;
  const project = read('project.json');
  let now = Date.parse(String(obj(arr(project.advances).at(-1)).at)) + 120_000;
  const options = read('evidence/interview/camera_depth.json');
  options.id = 'revised-camera-depth';
  options.drafted_at = new Date(now).toISOString();
  options.context = optionContext(project, 'post-interview', now, dir);
  const path = 'evidence/interview/revised-camera-depth.json';
  const bytes = JSON.stringify(options);
  writeFileSync(join(dir, path), bytes);
  interviewOptionsCommand(['camera_depth', dir, '--file', path], now++);
  const words = join(dir, 'words.txt');
  writeFileSync(words, 'Use the alternative camera depth.\n');
  const answer = JSON.parse(interviewAnswerCommand(['camera_depth', dir, '--set', path, '--sha256', sha256(bytes),
    '--pick', 'camera_depth=alternative', '--by', 'owner', ...ownerChatArgs(words, new Date(now).toISOString())], now++));
  expect(sceneCommand(['write', dir, '--compose-scene', 'specs/direction/compose-scene.json'], now++).exit).toBe(0);
  const intent = read('specs/direction/intent.json');
  obj(obj(intent.citations).camera).quote = answer.verbatim;
  writeFileSync(join(dir, 'specs/direction/intent-revised.json'), JSON.stringify(intent));
  expect(directionCommand(['write', dir, '--file', 'specs/direction/intent-revised.json'], now++).exit).toBe(0);
  expect(planCommand(['revise', 'camera', dir, '--by', 'agent', '--rests-on', 'camera_depth,reference'], now++).exit).toBe(0);
  expect(directionCommand(['write', dir, '--file', 'specs/direction/intent-revised.json'], now++).exit).toBe(0);
  expect(read('project.json').signoffs).toEqual(project.signoffs!);
  expect(nextProject(dir, now).refusals).toEqual([]);
});
