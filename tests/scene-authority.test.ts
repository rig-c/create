import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { collectItems } from '../src/check.ts';
import { optionContext } from '../src/choices.ts';
import { nextCommand, nextProject, remedyForFinding } from '../src/next.ts';
import {
  SCENE_CHOICE_MISSING,
  SCENE_CHOICE_MISSING_REMEDY,
  resolveAgentCitationSpec,
  resolveAnswerValue,
} from '../src/scene-authority.ts';
import { validateScene } from '../src/scene.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { testClock } from './clock.ts';
import { tempDir } from './helpers.ts';
import { seedRetainedScene } from './numbered-seed.ts';
import { sceneFixture } from './scene-fixture.ts';

afterEach(() => testClock.reset());
const answerOf = (p: JsonObject): JsonObject => collectItems(p, { collection: null }).find(i => i.id === 'post_composition')!.raw as JsonObject;
function rejected(code: string, edit: (f: ReturnType<typeof sceneFixture>) => void): void {
  const f = sceneFixture(); edit(f);
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(() => f.writeScene()).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
}
test('scene choice must retain its Review selection and scene map', () => {
  for (const field of ['choice', 'value']) rejected('SCENE_CHOICE_MISSING', f => { const p = f.load(); delete answerOf(p)[field]; f.save(p); });
});
test('a changed retained option file cannot authorize a scene', () => {
  rejected('SCENE_CHOICE_MISSING', f => {
    const binding = (answerOf(f.load()).choice as JsonObject).set as JsonObject;
    f.write(String(binding.path), '{}');
  });
});
test('#1084 a scene choice resolves a stored zero against the retained negative-zero fragment', () => {
  const f = sceneFixture();
  f.designateScene({ ...f.model.stage, y: 0 });
  const project = f.load();
  const choice = answerOf(project).choice as JsonObject;
  const path = (choice.set as JsonObject).path as string;
  const optionBytes = readFileSync(join(f.dir, path), 'utf8').replaceAll('"y":0', '"y":-0.0');
  expect(optionBytes).toContain('"y":-0.0');
  choice.set = f.write(path, optionBytes);
  f.save(project);
  expect(f.writeScene().exit).toBe(0);
});
test('a mismatched picked plate path refuses in validateScene', () => {
  const f = sceneFixture(); const args = f.args(); args[args.indexOf('--background') + 1] = 'foreground.png';
  seedRetainedScene(args, testClock.now());
  const doc = JSON.parse(readFileSync(join(f.dir, 'evidence/scene/s1.json'), 'utf8')) as JsonObject;
  expect(() => validateScene(f.dir, f.load(), doc)).toThrow(expect.objectContaining({ code: 'SCENE_CHOICE_MISMATCH' }));
});
test('a pending delegation refuses and a decided delegation supplies exact placement', () => {
  const f = sceneFixture();
  f.designateScene({ ...f.model.stage, y: 0 });
  const p = f.load(); const answer = answerOf(p);
  const value = answer.value!; const choice = answer.choice as JsonObject;
  const binding = choice.set as JsonObject;
  const set = JSON.parse(readFileSync(join(f.dir, String(binding.path)), 'utf8')) as JsonObject;
  const option = (((set.asks as JsonObject[])[0]!.options as JsonObject[]).find(o => o.id === 'auto'))!;
  choice.picks = [{ ask: 'post_composition', option_id: 'auto', shown: { label: option.label!, effect: option.effect! } }];
  answer.delegated = true; answer.asks = [{ id: 'post_composition', state: 'delegated' }]; delete answer.value;
  answer.verbatim = `${String(option.label)}\n${String(option.effect)}`;
  f.write('background-citation.json', JSON.stringify({ background: { guide: 'post_composition', asks: ['post_composition'], delegated: true } }));
  f.save(p);
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(() => f.writeScene()).toThrow(expect.objectContaining({ code: 'SCENE_CHOICE_MISSING' }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  const fragment = JSON.parse(JSON.stringify(value).replace('"y":0', '"y":-0.0')) as JsonObject;
  answer.agent_decision = { by: 'agent', at: testClock.iso(), reasoning: 'Use the declared synthetic scene.', covers: 'post_composition', fragments: [{ ask: 'post_composition', fragment }], value };
  expect(resolveAnswerValue(f.dir, 'interview.post', answer, { delegated: true }).value).toBe(value);
  f.save(p);
  expect(f.writeScene().exit).toBe(0);
});
test('a stale quoted answer cannot authorize current authoring', () => {
  rejected('SCENE_CHOICE_MISMATCH', f => {
    const p = f.load(); const item = collectItems(p, { collection: null }).find(i => i.id === 'post_composition')!;
    item.record.history = [structuredClone(item.raw!)];
    (item.raw as JsonObject).verbatim = 'A different current choice.';
    f.save(p);
  });
});

test('the shared scene checker rechecks agent input receipt metadata', async () => {
  const { checkScenes } = await import('../src/scene.ts');
  const f = sceneFixture(); f.writeScene(); const project = f.load();
  delete (project.inputs as JsonObject[])[0]!.origin;
  const ctx = { dir: f.dir, project, refusals: [] as import('../src/check.ts').Finding[] };
  checkScenes(ctx);
  expect(ctx.refusals.map(f => f.code)).toEqual(['SCENE_INPUT_RECEIPT_MISSING']);
});

test('a post_composition set without value.scene names interview-options registration in the refusal and next moves', () => {
  expect(remedyForFinding(SCENE_CHOICE_MISSING, 'placeholder')).toBe(SCENE_CHOICE_MISSING_REMEDY);

  const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const dir = join(tempDir(), 'scene-choice-repair');
  const chainDir = join(import.meta.dir, '../templates/example-chain');
  cpSync(join(chainDir, 'checkpoints/4-direction-post'), dir, { recursive: true });
  cpSync(join(chainDir, 'inputs/background.png'), join(dir, 'inputs/background.png'));
  expect(main(['input', 'add', 'inputs/background.png', dir, '--origin', 'synthetic plate'], EXAMPLE_NOW)).toBe(0);

  const projectPath = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
  const answer = answerOf(project);
  const binding = (answer.choice as JsonObject).set as JsonObject;
  const setPath = join(dir, String(binding.path));
  const set = JSON.parse(readFileSync(setPath, 'utf8')) as JsonObject;
  const noSceneValue = { framing: 'keep the synthetic lighthouse in frame', light: 'as painted' };
  for (const option of ((set.asks as JsonObject[])[0]!.options as JsonObject[])) {
    if (option.kind === 'value') option.fragment = noSceneValue;
  }
  const setBytes = `${JSON.stringify(set, null, 2)}\n`;
  writeFileSync(setPath, setBytes);
  binding.sha256 = hash(setBytes);
  answer.value = noSceneValue;
  for (const signoff of (project.signoffs as JsonObject[])) {
    const hashes = selectAnswerHashes(dir, project, signoff);
    if (hashes) signoff.answer_hashes = hashes;
  }
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  writeFileSync(join(dir, 'evidence/scene-citations.json'), JSON.stringify({
    background: { guide: 'post_composition', asks: ['post_composition'], quote: answer.verbatim },
  }));

  testClock.set(EXAMPLE_NOW);
  const beforeRefusal = readFileSync(projectPath);
  expect(() => resolveAgentCitationSpec(dir, project, {
    guide: 'post_composition', asks: ['post_composition'], quote: answer.verbatim,
  })).toThrow(expect.objectContaining({
    code: SCENE_CHOICE_MISSING,
    message: expect.stringContaining(
      'rig-create interview-options post_composition [<dir>] --file <retained project-relative JSON>',
    ),
  }));
  expect(readFileSync(projectPath)).toEqual(beforeRefusal);

  const beforeSceneReport = nextProject(dir, EXAMPLE_NOW);
  expect(beforeSceneReport.refusals).toEqual([]);
  expect(beforeSceneReport.moves.some(move => move.command?.startsWith('rig-create scene write '))).toBe(false);
  expect(beforeSceneReport.moves).toContainEqual(expect.objectContaining({
    role: 'agent', field: 'versions', command: null, act: expect.stringContaining('Numbered scenes and posts are read-only.'),
  }));
  expect(nextCommand([dir], EXAMPLE_NOW).stdout).toContain('NUMBERED_ACT_RETIRED: Numbered scenes and posts are read-only.');

  // Also verify when a committed agent scene triggers SCENE_CHOICE_MISSING in checkProject / next refusals.
  const withSceneDir = join(tempDir(), 'stored-scene-without-option-scene');
  cpSync(chainDir, withSceneDir, { recursive: true });
  const storedProjectPath = join(withSceneDir, 'project.json');
  const storedProject = JSON.parse(readFileSync(storedProjectPath, 'utf8')) as JsonObject;
  const storedAnswer = answerOf(storedProject);
  const storedBinding = (storedAnswer.choice as JsonObject).set as JsonObject;
  const storedSetPath = join(withSceneDir, String(storedBinding.path));
  const storedSet = JSON.parse(readFileSync(storedSetPath, 'utf8')) as JsonObject;
  for (const option of ((storedSet.asks as JsonObject[])[0]!.options as JsonObject[])) {
    if (option.kind === 'value') option.fragment = noSceneValue;
  }
  const storedSetBytes = `${JSON.stringify(storedSet, null, 2)}\n`;
  writeFileSync(storedSetPath, storedSetBytes);
  storedBinding.sha256 = hash(storedSetBytes);
  storedAnswer.value = noSceneValue;
  for (const signoff of (storedProject.signoffs as JsonObject[])) {
    const hashes = selectAnswerHashes(withSceneDir, storedProject, signoff);
    if (hashes) signoff.answer_hashes = hashes;
  }
  writeFileSync(storedProjectPath, `${JSON.stringify(storedProject, null, 2)}\n`);

  const refusalReport = nextProject(withSceneDir, EXAMPLE_NOW);
  const sceneRefusal = refusalReport.refusals.find(r => r.code === SCENE_CHOICE_MISSING)!;
  expect(sceneRefusal).toBeDefined();
  expect(sceneRefusal.fix).toBe(SCENE_CHOICE_MISSING_REMEDY);
  expect(sceneRefusal.fix).toContain('rig-create interview-options post_composition [<dir>] --file <retained project-relative JSON>');
  expect(sceneRefusal.fix).toContain('rig-create interview-answer post_composition [<dir>]');
  expect(refusalReport.moves).toContainEqual(expect.objectContaining({
    role: 'agent',
    field: 'interview.post.items[post_composition].guide',
    command: `rig-create interview-options post_composition ${withSceneDir} --file '<option-set.json>'`,
  }));

  // The shared interview writers still record the repaired choice.
  const now = EXAMPLE_NOW + 1_000;
  const replacementRel = 'evidence/interview/post_composition-with-scene.json';
  const replacementSet: JsonObject = {
    ...structuredClone(set),
    id: 'post-composition-with-scene',
    drafted_at: new Date(now).toISOString(),
    context: optionContext(project, 'post-interview', now, dir),
  };
  const sceneFragment = {
    ...noSceneValue,
    scene: { background: { path: 'inputs/background.png', rect: { x: -64, y: 0, width: 128, height: 128 } } },
  };
  for (const option of ((replacementSet.asks as JsonObject[])[0]!.options as JsonObject[])) {
    if (option.kind === 'value') option.fragment = sceneFragment;
  }
  const replacementBytes = `${JSON.stringify(replacementSet, null, 2)}\n`;
  writeFileSync(join(dir, replacementRel), replacementBytes);
  expect(main(['interview-options', 'post_composition', dir, '--file', replacementRel], now)).toBe(0);

  const afterRegister = nextProject(dir, now);
  expect(afterRegister.moves.some(move => move.command?.startsWith('rig-create scene write '))).toBe(false);
  const wordsRel = 'evidence/interview/owner-scene-words.txt';
  writeFileSync(join(dir, wordsRel), 'Use the registered background scene.\n');
  const answerNow = now + 1_000;
  expect(main([
    'interview-answer', 'post_composition', dir,
    '--set', replacementRel, '--sha256', hash(replacementBytes),
    '--by', 'user',
    '--owner-chat', join(dir, wordsRel), '--said-at', new Date(answerNow - 500).toISOString(), '--relayed-by', 'operator',
    '--pick', 'post_composition=keep',
  ], answerNow)).toBe(0);
});
