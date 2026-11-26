import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextProject } from '../src/next.ts';
import { inputCommand } from '../src/inputs.ts';
import { sceneCommand } from '../src/scene-writers.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { testClock } from './clock.ts';

const CHAIN = join(import.meta.dir, '../templates/example-chain');
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
afterEach(() => testClock.reset());

function printedArgs(command: string): string[] {
  // Let the shell decode the displayed quoting, without executing a writer.
  const run = Bun.spawnSync(['bash', '-c', `function rig-create() { printf '%s\\0' "$@"; }\n${command}`]);
  expect(run.exitCode).toBe(0);
  expect(run.stderr.toString()).toBe('');
  return run.stdout.toString().split('\0').slice(0, -1);
}

function plateProject(composed = false) {
  const dir = join(tempDir(), "synthetic plate's project");
  cpSync(join(CHAIN, 'checkpoints/4-direction-post'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const item = arr(obj(obj(project.interview).post).items).map(obj).find(item => item.id === 'post_composition')!;
  const answer = obj(item.guide);
  const binding = obj(obj(answer.choice).set);
  const set = JSON.parse(readFileSync(join(dir, String(binding.path)), 'utf8')) as JsonObject;
  const background = "inputs/back plate's.png", foreground = 'inputs/front plate.png';
  const png = readFileSync(join(CHAIN, 'inputs/background.png'));
  writeFileSync(join(dir, background), png);
  writeFileSync(join(dir, foreground), Buffer.concat([png, Buffer.from('\n')]));
  const rect = { x: -64, y: 0, width: 128, height: 128 };
  const value: JsonObject = composed ? { compose: { canvas: { width: 128, height: 128 }, plates: [
    { name: 'back', image: background, at: [0, 0] }, { name: 'front', image: foreground, at: [0, 0] },
  ], order: ['back', 'actor', 'front'], character: { offset: [0, 0], scale: 1 }, idle_tracks: [
    { bone: 'back', property: 'translate', keys: [{ t: 0, v: [0, 0] }, { t: 4, v: [0, 0] }] },
  ] } }
    : { scene: { background: { path: background, rect }, foreground: { path: foreground, rect } } };
  answer.value = value;
  for (const option of arr(obj(arr(set.asks)[0]).options).map(obj).filter(option => option.kind === 'value')) option.fragment = value;
  const save = (): void => {
    const bytes = JSON.stringify(set);
    writeFileSync(join(dir, String(binding.path)), bytes);
    binding.sha256 = hash(bytes);
    for (const signature of arr(project.signoffs).map(obj)) {
      const hashes = selectAnswerHashes(dir, project, signature);
      if (hashes) signature.answer_hashes = hashes;
    }
    writeFileSync(file, JSON.stringify(project));
  };
  save();
  return { dir, file, project, item, answer, set, binding, background, foreground, save };
}

function openPostChoices(f: ReturnType<typeof plateProject>): void {
  f.project.stage = 'post-interview';
  f.project.signoffs = arr(f.project.signoffs).filter(row => obj(row).stage !== 'post-interview');
  f.project.advances = arr(f.project.advances).filter(row => obj(row).stage !== 'post');
  for (const step of arr(obj(f.project.plan).steps).map(obj).filter(step => step.phase === 'post')) {
    step.status = 'pending'; delete step.status_history;
  }
}

test.each([false, true])('#504 names each existing unregistered plate before its dependent writer (compose=%s)', composed => {
  const f = plateProject(composed);
  const before = readFileSync(f.file);
  expect(arr(f.project.inputs).map(obj).some(input => input.path === f.background)).toBe(false);
  const report = nextProject(f.dir, EXAMPLE_NOW);
  expect(report.refusals).toEqual([]);
  const registrations = report.moves.filter(move => move.command?.startsWith('rig-create input add '));
  expect(registrations).toHaveLength(2);
  expect(registrations.map(move => move.role)).toEqual(['agent', 'agent']);
  expect(registrations.map(move => printedArgs(move.command!))).toEqual([f.background, f.foreground].map(path =>
    ['input', 'add', path, f.dir, '--origin', '<origin>']));
  expect(report.awaits).toEqual(expect.arrayContaining(registrations.map(move => move.awaits)));
  const dependent = report.moves.findIndex(move => move.command?.startsWith(composed ? 'rig-create direction write ' : 'rig-create scene write '));
  expect(dependent).toBeGreaterThan(report.moves.indexOf(registrations[1]!));
  expect(readFileSync(f.file)).toEqual(before);
  for (const move of registrations) {
    const args = printedArgs(move.command!).slice(1).map(arg => arg === '<origin>' ? 'synthetic plate source' : arg);
    expect(inputCommand(args, EXAMPLE_NOW).exit).toBe(0);
  }
  expect(nextProject(f.dir, EXAMPLE_NOW).moves.filter(move => move.command?.startsWith('rig-create input add '))).toEqual([]);
  if (!composed) {
    writeFileSync(join(f.dir, 'evidence/plate-citations.json'), JSON.stringify(Object.fromEntries(['background', 'foreground'].map(role =>
      [role, { guide: 'post_composition', asks: ['post_composition'], quote: f.answer.verbatim }]))));
    const command = nextProject(f.dir, EXAMPLE_NOW).moves.find(move => move.command?.startsWith('rig-create scene write '))!.command!;
    const args = printedArgs(command).slice(1).map(arg => arg === '<background.png>' ? f.background
      : arg === '<foreground.png>' ? f.foreground : arg === '<scene-citations.json>' ? 'evidence/plate-citations.json' : arg);
    expect(sceneCommand(args, EXAMPLE_NOW).exit).toBe(0);
  }
});

test('#504 pending option sets include every offered plate, deduplicated across options', () => {
  const f = plateProject(true);
  delete f.item.guide;
  f.item.pending_options = f.binding;
  openPostChoices(f);
  const alternate = 'inputs/alternate.png';
  cpSync(join(f.dir, f.foreground), join(f.dir, alternate));
  obj(arr(obj(arr(f.set.asks)[0]).options)[1]).fragment = { scene: { background: { path: alternate } } };
  f.save();
  const report = nextProject(f.dir, EXAMPLE_NOW);
  expect(report.refusals.map(refusal => refusal.code)).toEqual(['INTERVIEW_INCOMPLETE']);
  const adds = report.moves.filter(move => move.command?.startsWith('rig-create input add '));
  expect(adds.map(move => printedArgs(move.command!)[2])).toEqual([f.background, f.foreground, alternate]);
  expect(report.moves.findIndex(move => move.field === 'interview.post.items[post_composition].pending_options')).toBeGreaterThan(report.moves.indexOf(adds.at(-1)!));
});

test.each(['complete', 'incomplete', 'cycle'])('#504 honors complete prepared-input fan-in chains and repairs missing registration (%s)', kind => {
  const f = plateProject(true);
  const input = obj(arr(f.project.inputs)[0]);
  const intermediate = 'inputs/prepared-intermediate.png';
  cpSync(join(f.dir, f.background), join(f.dir, intermediate));
  const binding = (path: string) => ({ path, sha256: hash(readFileSync(join(f.dir, path))) });
  f.project.derived = [
    { kind: 'prepared-input', ...binding(intermediate), source: kind === 'cycle' ? binding(f.background)
      : { path: input.path!, sha256: kind === 'complete' ? input.sha256! : '0'.repeat(64) }, operation: 'synthetic first preparation' },
    { kind: 'prepared-input', ...binding(f.background), sources: [binding(intermediate), { path: input.path!, sha256: input.sha256! }], operation: 'synthetic fan-in preparation' },
  ];
  f.save();
  const adds = nextProject(f.dir, EXAMPLE_NOW).moves.filter(move => move.command?.startsWith('rig-create input add '));
  expect(adds.map(move => printedArgs(move.command!)[2])).toEqual(kind === 'complete' ? [f.foreground] : [f.background, f.foreground]);
});

test('#504 discovers plates in the current delegated decision, outside the offered values', () => {
  const f = plateProject(true);
  const value = f.answer.value!;
  const choice = obj(f.answer.choice);
  const pick = obj(arr(choice.picks)[0]);
  const options = arr(obj(arr(f.set.asks)[0]).options).map(obj);
  const auto = options.find(option => option.kind === 'auto')!;
  for (const option of options.filter(option => option.kind === 'value')) option.fragment = { framing: 'plain' };
  pick.option_id = auto.id!;
  pick.shown = { label: auto.label!, effect: auto.effect! };
  f.answer.verbatim = `${auto.label}\n${auto.effect}`;
  f.answer.delegated = true;
  f.answer.asks = [{ id: 'post_composition', state: 'delegated' }];
  delete f.answer.value;
  f.answer.agent_decision = { by: 'agent', at: f.answer.at!, covers: 'post_composition', reasoning: 'Use the synthetic plates.',
    fragments: [{ ask: 'post_composition', fragment: value }], value };
  f.save();
  const report = nextProject(f.dir, EXAMPLE_NOW);
  expect(report.refusals).toEqual([]);
  const adds = report.moves.filter(move => move.command?.startsWith('rig-create input add '));
  expect(adds.map(move => printedArgs(move.command!)[2])).toEqual([f.background, f.foreground]);
  expect(report.moves.findIndex(move => move.command?.startsWith('rig-create direction write '))).toBeGreaterThan(report.moves.indexOf(adds.at(-1)!));
});

test('#504 preserves changed-input refusal without suggesting duplicate registration', () => {
  const f = plateProject();
  inputCommand(['add', f.background, f.dir, '--origin', 'synthetic plate'], EXAMPLE_NOW);
  writeFileSync(join(f.dir, f.background), 'changed synthetic bytes');
  const report = nextProject(f.dir, EXAMPLE_NOW);
  expect(report.refusals.map(row => row.code)).toContain('INPUT_FILE_CHANGED');
  expect(report.moves.map(move => printedArgs(move.command!)[2])).toEqual([f.foreground]);
  writeFileSync(f.file, JSON.stringify({ ...JSON.parse(readFileSync(f.file, 'utf8')), current: {} }));
  const withCurrent = nextProject(f.dir, EXAMPLE_NOW);
  expect(withCurrent.refusals.map(row => row.code)).toContain('INPUT_FILE_CHANGED');
  expect(withCurrent.moves).toEqual(report.moves);
});

test('#504 keeps existing named refusals and offers registration before a blocked stored scene', () => {
  const dir = join(tempDir(), 'synthetic stored scene');
  cpSync(CHAIN, dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  // Exercise the committed scene alone, without the option/answer surfaces.
  const composition = arr(obj(obj(project.interview).post).items).map(obj).find(item => item.id === 'post_composition')!;
  delete composition.guide;
  project.inputs = arr(project.inputs).filter(row => obj(row).path !== 'inputs/background.png');
  writeFileSync(file, JSON.stringify(project));
  const before = readFileSync(file);
  const report = nextProject(dir, EXAMPLE_NOW);
  expect(report.refusals.map(row => row.code)).toContain('SCENE_PLATE_UNREGISTERED');
  expect(report.moves.map(move => printedArgs(move.command!))).toEqual([
    ['input', 'add', 'inputs/background.png', dir, '--origin', '<origin>'],
  ]);
  expect(report.accepted).toBe(false);
  expect(readFileSync(file)).toEqual(before);
});

test('#504 skips absent, escaping and symlink plate files', () => {
  const f = plateProject();
  rmSync(join(f.dir, f.foreground));
  const outside = join(tempDir(), 'outside.png');
  cpSync(join(f.dir, f.background), outside);
  symlinkSync(outside, join(f.dir, 'inputs/linked.png'));
  const options = arr(obj(arr(f.set.asks)[0]).options).map(obj);
  options[1]!.fragment = { compose: { plates: [{ image: 'inputs/linked.png' }, { image: '../outside.png' }, { image: outside }] } };
  f.save();
  const adds = nextProject(f.dir, EXAMPLE_NOW).moves.filter(move => move.command?.startsWith('rig-create input add '));
  expect(adds.map(move => printedArgs(move.command!)[2])).toEqual([f.background]);
});

test('#504 ignores historical answers and changed option-set bytes', () => {
  const f = plateProject();
  f.item.history = [structuredClone(f.answer)];
  delete f.item.guide;
  f.item.pending_options = f.binding;
  openPostChoices(f);
  f.save();
  writeFileSync(join(f.dir, String(f.binding.path)), '{}');
  const report = nextProject(f.dir, EXAMPLE_NOW);
  expect(report.refusals.map(row => row.code)).toContain('INTERVIEW_OPTIONS_FILE');
  expect(report.moves).toEqual([]);
});

test('#504 leading-dash plate names remain positional arguments in the printed command', () => {
  const f = plateProject();
  const path = '-alternate.png';
  cpSync(join(f.dir, f.background), join(f.dir, path));
  obj(arr(obj(arr(f.set.asks)[0]).options)[1]).fragment = { scene: { background: { path } } };
  f.save();
  const move = nextProject(f.dir, EXAMPLE_NOW).moves.find(move => move.command?.includes('./-alternate.png'))!;
  expect(move).toBeDefined();
  const args = printedArgs(move.command!).slice(1).map(arg => arg === '<origin>' ? 'synthetic alternate' : arg);
  expect(inputCommand(args, EXAMPLE_NOW).exit).toBe(0);
  expect(nextProject(f.dir, EXAMPLE_NOW).moves.some(move => move.command?.includes('./-alternate.png'))).toBe(false);
});
