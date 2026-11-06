import { amendCommand } from '../src/amend.ts';
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answered, checkProject, collectItems, type Ctx, type Item } from '../src/check.ts';
import { Refusal } from '../src/refusal.ts';
import { reopenCommand } from '../src/reopen.ts';
import { answerRevisionHash, checkSignoffAnswers, selectAnswerHashes, SIGNOFF_ANSWERS_SINCE } from '../src/signoff-answers.ts';
import { signoffCommand } from '../src/signoff.ts';
import { stepHash } from '../src/step-hash.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { arr, fixture, materializeFixture, obj, step, waypoint } from './fixtures.ts';
import { tempDir } from './helpers.ts';

afterEach(() => setSystemTime());
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(p, null, 2) + '\n');
function words(dir: string): string { const path = join(dir, 'approval.txt'); writeFileSync(path, 'Approve the synthetic answer revisions.\n'); return path; }
const findings = (dir: string, p?: JsonObject) => checkProject(dir, p).refusals.filter(f => f.code.startsWith('SIGNOFF_ANSWERS_'));
// Independent canonicalizer and envelope: never call the production hash or sorted helper.
function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function expected(item: Item, stage: string): string {
  const clean = (value: Json): Json => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([k]) => !['history', 'prompts', 'config', 'text', 'source', 'required_for', ...(stage === 'interview' ? ['agent_decision'] : [])].includes(k))) : null;
  const bytes = JSON.stringify(canonical({ raw: clean(item.raw), resolved: clean('answer' in item.state ? item.state.answer : null) }));
  return createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex');
}

test.each(['interview', 'plan-approved', 'rigging-interview', 'post-interview'])('%s writer binds independently computed answer envelopes', stage => {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(() => {}, 'example-project.json');
  const before = load(dir);
  signoffCommand([stage, dir, '--by', 'user', '--verbatim-file', words(dir)]);
  const p = load(dir), signed = obj(arr(p.signoffs).at(-1));
  const items = collectItems(p, { collection: null });
  const covered = arr(obj(p.plan).steps).filter(s => arr(signed.steps ?? []).includes(obj(s).id as Json));
  const ids = stage === 'interview' ? items.filter(i => answered(i.state)).map(i => i.id)
    : [...new Set(covered.flatMap(s => arr(obj(s).rests_on) as string[]))];
  expect(signed.answer_hashes).toEqual(Object.fromEntries(ids.map(id => [id, expected(items.find(i => i.id === id)!, stage)])));
  if (stage !== 'interview') for (const s of covered) expect(obj(signed.step_hashes)[String(obj(s).id)]).toBe(stepHash(obj(s)));
  expect(p.plan).toEqual(before.plan);
  expect(findings(dir)).toEqual([]);
});

test('writer refuses unanswered basis by code and leaves project bytes identical', () => {
  const dir = fixture(() => {}, 'example-project.json'), p = load(dir);
  waypoint(p, 'assemble').guide = null; save(dir, p);
  const before = readFileSync(join(dir, 'project.json'));
  let failure: unknown;
  try { signoffCommand(['plan-approved', dir, '--by', 'user', '--verbatim-file', words(dir)]); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Refusal);
  expect((failure as Refusal).code).toBe('SIGNOFF_ANSWERS_UNANSWERED');
  expect((failure as Refusal).message).toContain('assemble');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test.each(['answer', 'removed', 'incomplete'])('reader refuses %s with distinct plants', plant => {
  const dir = fixture(() => {}, 'example-project.json'), p = load(dir);
  const signed = arr(p.signoffs).map(obj).find(s => s.stage === 'plan-approved')!;
  const before = stepHash(step(p, 'assemble'));
  if (plant === 'answer') obj(waypoint(p, 'assemble').guide).verbatim = 'DISTINCT changed assembly answer';
  if (plant === 'removed') obj(p.interview).waypoints = arr(obj(p.interview).waypoints).filter(w => obj(w).id !== 'assemble');
  if (plant === 'incomplete') delete obj(signed.answer_hashes).assemble;
  expect(stepHash(step(p, 'assemble'))).toBe(before);
  const fs = findings(dir, p);
  expect(fs.map(f => f.code)).toContain(plant === 'incomplete' ? 'SIGNOFF_ANSWERS_MISSING' : 'SIGNOFF_ANSWERS_STALE');
  expect(fs.some(f => f.message.includes('assemble'))).toBe(true);
});

test.each([['2026-11-05T23:59:59.999Z', true], [SIGNOFF_ANSWERS_SINCE, false]] as const)('missing map exact boundary %s', (at, legacy) => {
  const dir = fixture(() => {}, 'example-project.json'), p = load(dir);
  p.signoffs = [{ stage: 'interview', by: 'user', at, verbatim: 'Synthetic approval.' }];
  const r = checkProject(dir, p);
  expect((legacy ? r.warnings : r.refusals).filter(f => f.code.startsWith('SIGNOFF_ANSWERS_')).map(f => f.code)).toEqual([legacy ? 'SIGNOFF_ANSWERS_MISSING_LEGACY' : 'SIGNOFF_ANSWERS_MISSING']);
  expect((legacy ? r.refusals : r.warnings).filter(f => f.code.startsWith('SIGNOFF_ANSWERS_'))).toEqual([]);
});

test('question metadata, history and excluded answer fields do not stale approvals', () => {
  const dir = fixture(() => {}, 'example-project.json'), p = load(dir), item = waypoint(p, 'assemble');
  for (const key of ['history', 'prompts', 'text', 'config', 'source', 'required_for']) {
    item[key] = ['DISTINCT question metadata']; obj(item.guide)[key] = ['DISTINCT answer metadata'];
  }
  expect(findings(dir, p)).toEqual([]);
});

test('later first answers are not missing from the earlier interview', () => {
  const dir = fixture(() => {}, 'example-project.json');
  expect(findings(dir)).toEqual([]);
  const p = load(dir);
  obj(p.interview).framing = [...arr(obj(p.interview).framing), { id: 'later', answer: { delegated: false, value: 'later', verbatim: 'Later answer.', at: '2026-11-20T00:00:00Z' } }];
  expect(findings(dir, p)).toEqual([]);
});

test('lapsed approvals never report changed answer bindings', () => {
  const dir = fixture(() => {}, 'example-project.json');
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  reopenCommand(['interview', dir, '--by', 'user', '--verbatim-file', words(dir)]);
  const p = load(dir); obj(waypoint(p, 'assemble').guide).verbatim = 'DISTINCT lapsed answer';
  expect(findings(dir, p)).toEqual([]);
});

test('inheritance binds both resolved content and reference identity', () => {
  const root = tempDir(); mkdirSync(join(root, 'members'));
  let answer: Json = null;
  const dir = materializeFixture(join(root, 'members', 'member'), p => {
    answer = structuredClone(waypoint(p, 'bones').guide as Json);
    waypoint(p, 'bones').guide = { basis: 'inherited', from: { collection: 'group', question: 'bones' }, by: 'user', at: '2026-11-01T00:00:00Z' };
  }, 'example-project.json');
  const collection: JsonObject = { name: 'group', interview: { waypoints: [{ id: 'bones', guide: answer }] } };
  writeFileSync(join(root, 'collection.json'), JSON.stringify(collection));
  const p = load(dir);
  // This is the operation under test: the writer must read the real parent collection.
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  p.signoffs = arr(p.signoffs).filter(s => obj(s).stage !== 'interview');
  for (const s of arr(p.signoffs).map(obj)) { const hashes = selectAnswerHashes(dir, p, s); if (hashes !== undefined) s.answer_hashes = hashes; }
  save(dir, p);
  signoffCommand(['interview', dir, '--by', 'user', '--verbatim-file', words(dir)]);
  const signed = obj(arr(load(dir).signoffs).at(-1));
  const item = collectItems(load(dir), { collection }).find(i => i.id === 'bones')!;
  expect(obj(signed.answer_hashes).bones).toBe(expected(item, 'interview'));
  expect(findings(dir)).toEqual([]);
  const originalAnswer = structuredClone(answer);
  obj(answer).verbatim = 'DISTINCT shared answer revision';
  writeFileSync(join(root, 'collection.json'), JSON.stringify(collection));
  expect(findings(dir).map(f => f.code)).toContain('SIGNOFF_ANSWERS_STALE');
  obj(obj(arr(obj(collection.interview).waypoints)[0])).guide = originalAnswer;
  writeFileSync(join(root, 'collection.json'), JSON.stringify(collection));
  expect(findings(dir)).toEqual([]);
  const local = load(dir); waypoint(local, 'bones').guide = structuredClone(originalAnswer);
  expect(findings(dir, local).map(f => f.code)).toContain('SIGNOFF_ANSWERS_STALE');
});

test('interview excludes later decisions while plan bindings include their full revision', () => {
  const dir = fixture(() => {}, 'example-project.json'), p = load(dir);
  const item = collectItems(p, { collection: null }).find(i => i.id === 'bones')!;
  item.record.guide = { delegated: true, by: 'user', at: SIGNOFF_ANSWERS_SINCE, verbatim: 'Agent chooses later.' };
  const before = collectItems(p, { collection: null }).find(i => i.id === 'bones')!;
  const iHash = answerRevisionHash(before, 'interview'), pHash = answerRevisionHash(before);
  obj(item.record.guide).agent_decision = { value: { bones: 'DISTINCT decision' }, reasoning: 'Synthetic reason.' };
  const after = collectItems(p, { collection: null }).find(i => i.id === 'bones')!;
  expect(answerRevisionHash(after, 'interview')).toBe(iHash);
  expect(answerRevisionHash(after)).not.toBe(pHash);
  const ctx = { project: p, items: collectItems(p, { collection: null }), refusals: [], warnings: [] } as unknown as Ctx;
  checkSignoffAnswers(ctx, { stage: 'interview', at: '2026-11-20T00:00:00Z', answer_hashes: { bones: iHash } }, 'signoffs[0]');
  expect(ctx.refusals.some(f => f.code === 'SIGNOFF_ANSWERS_STALE')).toBe(false);
});

test('empty imported interview has an honestly complete empty binding', () => {
  const dir = tempDir();
  const p: JsonObject = { interview: {}, signoffs: [] };
  const signature: JsonObject = { stage: 'interview', at: SIGNOFF_ANSWERS_SINCE };
  expect(selectAnswerHashes(dir, p, signature)).toEqual({});
  const ctx = { project: p, items: [], refusals: [], warnings: [] } as unknown as Ctx;
  checkSignoffAnswers(ctx, { ...signature, answer_hashes: {} }, 'signoffs[0]');
  expect(ctx.refusals).toEqual([]); expect(ctx.warnings).toEqual([]);
});


test('amendment liveness suppresses stale downstream bindings and keeps no approvals by binding', () => {
  const dir = fixture(() => {}, 'example-project.json');
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  writeFileSync(join(dir, 'replacement.json'), '{"synthetic":"DISTINCT amendment"}');
  amendCommand(['rigging-interview', dir, '--kind', 'interview-answer', '--target', 'bones', '--change', 'replacement.json', '--by', 'user', '--verbatim-file', words(dir)]);
  const p = load(dir); obj(waypoint(p, 'bones').guide).verbatim = 'DISTINCT lapsed rigging answer';
  const r = checkProject(dir, p);
  expect(findings(dir, p)).toEqual([]);
  expect(r.amendments?.[0]?.keep_by_binding).toEqual([]);
});

test('recorded decision drift stales plan approval but leaves interview approval valid', () => {
  const dir = fixture(() => {}, 'example-project.json'), p = load(dir);
  obj(obj(waypoint(p, 'seethrough').guide).agent_decision).reasoning = 'DISTINCT revised decision reasoning';
  const fs = findings(dir, p);
  expect(fs.map(f => f.code)).toEqual(['SIGNOFF_ANSWERS_STALE']);
  expect(fs[0]?.path).toBe('signoffs[1].answer_hashes[seethrough]');
});
