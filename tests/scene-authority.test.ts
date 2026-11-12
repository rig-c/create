import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectItems } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { sceneCommand, testClock } from './clock.ts';
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
test('a mismatched picked plate path refuses without changing the project', () => {
  const f = sceneFixture(); const args = f.args(); args[args.indexOf('--background') + 1] = 'foreground.png';
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(() => sceneCommand(args)).toThrow(expect.objectContaining({ code: 'SCENE_CHOICE_MISMATCH' }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});
test('a pending delegation refuses and a decided delegation supplies exact placement', () => {
  const f = sceneFixture(); const p = f.load(); const answer = answerOf(p);
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
  answer.agent_decision = { by: 'agent', at: testClock.iso(), reasoning: 'Use the declared synthetic scene.', covers: 'post_composition', fragments: [{ ask: 'post_composition', fragment: value }], value };
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
