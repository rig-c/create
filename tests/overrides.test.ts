import { resignAfterChange } from './fixtures.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERRIDDEN_ANSWERS_SINCE } from '../src/overrides.ts';
import type { JsonObject } from '../src/templates.ts';
import { fixture, framing, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { checkProject } from './clock.ts';

const source: JsonObject = { delegated: false, by: 'user', at: '2026-11-04T00:00:00Z', verbatim: 'Synthetic collection reference.', value: 'none' };
function member(edit: (a: JsonObject) => void = () => {}, parentEdit: (c: JsonObject) => void = () => {}): string {
  const root = tempDir(); const dir = join(root, 'members/example'); mkdirSync(join(root, 'members'));
  const original = fixture(p => {
    const a = obj(framing(p, 'reference').answer);
    a.basis = 'overridden'; a.overrides = { collection: 'synthetic', question: 'reference', collection_answer_at: source.at! }; a.why_verbatim = 'This member uses its own reference.';
    edit(a);
  }, 'example-project.json');
  renameSync(original, dir);
  const parent: JsonObject = { schema: 'rig-create/collection@0', name: 'synthetic', interview: { framing: [{ id: 'reference', answer: source, history: [] }] } };
  parentEdit(parent); writeFileSync(join(root, 'collection.json'), JSON.stringify(parent)); return dir;
}
const mutations: [string, (a: JsonObject) => void][] = [
  ['OVERRIDE_COLLECTION_INVALID', a => { obj(a.overrides).collection = 'wrong'; }],
  ['OVERRIDE_QUESTION_INVALID', a => { obj(a.overrides).question = 'absent'; }],
  ['OVERRIDE_ANSWER_STALE', a => { obj(a.overrides).collection_answer_at = '2026-11-07T00:01:00Z'; }],
  ['OVERRIDE_REASON_MISSING', a => { a.why_verbatim = ' \n\t'; }],
];
test('valid override of a current collection answer passes the whole checker at 0/0', () => {
  const r = checkProject(resignAfterChange(member())); expect(r.ok).toBe(true); expect(r.refusals).toEqual([]); expect(r.warnings).toEqual([]);
});
for (const [code, edit] of mutations) {
  test(`${code} is refused from SINCE and WARN before SINCE`, () => {
    const fresh = checkProject(member(a => { edit(a); delete a.choice; a.at = OVERRIDDEN_ANSWERS_SINCE; }));
    expect(fresh.refusals.map(f => f.code)).toContain(code);
    const old = checkProject(resignAfterChange(member(a => { edit(a); delete a.choice; a.at = '2026-11-05T23:59:59Z'; })));
    expect(old.refusals).toEqual([]); expect(old.warnings.map(f => f.code)).toContain(code);
  });
}
test('a collection answer retained in history remains a valid override reference after replacement or withdrawal', () => {
  for (const current of [null, { ...source, at: '2026-11-08T00:00:00Z' }]) {
    const r = checkProject(resignAfterChange(member(() => {}, c => {
      const q = (obj(c.interview).framing as JsonObject[])[0]!; q.answer = current; q.history = [source];
    })));
    expect(r.refusals).toEqual([]); expect(r.warnings).toEqual([]);
  }
});
test('silent questions, invalid timestamp and absent collection are refused by their named codes', () => {
  const dir = member(() => {}, c => { (obj(c.interview).framing as JsonObject[])[0]!.answer = null; });
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('OVERRIDE_QUESTION_INVALID');
  expect(checkProject(member(a => { obj(a.overrides).collection_answer_at = null; })).refusals.map(f => f.code)).toContain('OVERRIDE_ANSWER_STALE');
  const lone = fixture(p => { const a = obj(framing(p, 'reference').answer); a.basis = 'overridden'; a.overrides = {collection:'synthetic'}; a.why_verbatim = 'Separate reference.'; }, 'example-project.json');
  expect(checkProject(lone).refusals.map(f => f.code)).toContain('OVERRIDE_COLLECTION_INVALID');
});
test('historical overrides are checked with their own dates and record paths', () => {
  const dir = member(); const file = join(dir, 'project.json'); const p = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const q = framing(p, 'reference'); const bad = structuredClone(obj(q.answer)); delete bad.choice; bad.why_verbatim = ''; bad.at = '2026-11-05T00:00:00Z'; q.history = [bad];
  writeFileSync(file, JSON.stringify(p));
  const r = checkProject(resignAfterChange(dir)); expect(r.refusals).toEqual([]);
  expect(r.warnings).toContainEqual(expect.objectContaining({code:'OVERRIDE_REASON_MISSING',path:'interview.framing[reference].history[0]'}));
});

test('undated overridden answers cannot bypass the new contract', () => {
  const r = checkProject(member(a => { delete a.at; a.why_verbatim = ''; }));
  expect(r.refusals.map(f => f.code)).toContain('OVERRIDE_REASON_MISSING');
});
