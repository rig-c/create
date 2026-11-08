import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCollectionPinFixture } from '../scripts/generate-collection-pin-fixture.ts';
import { checkCollection, sha256File } from '../src/pins-check.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, obj } from './fixtures.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { collectionCommand } from './clock.ts';

function fixture(): string {
  const dir = join(tempDir(), 'collection');
  generateCollectionPinFixture(dir);
  return dir;
}
const read = (dir: string, path = 'collection.json'): JsonObject => JSON.parse(readFileSync(join(dir, path), 'utf8'));
const save = (dir: string, value: JsonObject, path = 'collection.json'): void => writeFileSync(join(dir, path), JSON.stringify(value, null, 2) + '\n');
function pinCode(dir: string, flags: string[]): string {
  try {
    const r = collectionCommand(['pin', dir, ...flags]);
    if (r.exit === 0) return 'NO_REFUSAL';
    return r.stdout.match(/REFUSED ([A-Z_]+):/)?.[1] ?? 'NO_CODE';
  } catch (e) { if (e instanceof Refusal) return e.code; throw e; }
}

test('selected fixture reproduces through the writer, hashes every variant, and checks at 0/0', () => {
  const dir = join(tempDir(), 'generated');
  const bytes = generateCollectionPinFixture(dir);
  expect(bytes).toBe(readFileSync(join(import.meta.dir, 'fixtures/collection-pin.json'), 'utf8'));
  const collection = read(dir);
  const pins = arr(obj(arr(collection.versions)[0]).pins).map(obj);
  expect(pins.map(p => [p.member, p.version, p.selection ?? null])).toEqual([['first', 1, 'explicit'], ['second', 2, null]]);
  for (const p of pins) {
    expect(arr(p.rigs).map(r => obj(r).variant)).toEqual(['default', 'alternate']);
    for (const rig of arr(p.rigs).map(obj)) {
      expect(arr(rig.files)).toHaveLength(4);
      for (const f of arr(rig.files).map(obj)) expect(f.sha256).toBe(sha256File(join(dir, 'members', String(p.member), String(f.path))));
    }
  }
  const report = checkCollection(dir);
  expect(report.ok).toBe(true); expect(report.refusals).toEqual([]); expect(report.warnings).toEqual([]);
});

test('repeatable --member pins distinct older builds; unmarked default pins remain latest', () => {
  const dir = fixture();
  mkdirSync(join(dir, 'outputs/v2'), { recursive: true }); writeFileSync(join(dir, 'outputs/v2/lineup.png'), 'second output');
  const r = cli(['collection', 'pin', dir, '--member', 'first=1', '--member', 'second=1'], dir, gitEnv());
  expect(r.code).toBe(0);
  const pins = arr(obj(arr(read(dir).versions)[1]).pins).map(obj);
  expect(pins.map(p => [p.version, p.selection])).toEqual([[1, 'explicit'], [1, 'explicit']]);
  expect(checkCollection(dir).refusals).toEqual([]);
});

test('PIN_SELECTION_INVALID selectors refuse byte-identically', () => {
  const dir = fixture(); const before = readFileSync(join(dir, 'collection.json'));
  for (const flags of [
    ['--member'], ['--member', '--changed', 'text'], ['--member', 'first'], ['--member', '=1'],
    ['--member', 'first=0'], ['--member', 'first=-1'], ['--member', 'first=1.5'], ['--member', 'first=9007199254740992'],
    ['--member', 'absent=1'], ['--member', 'first=1', '--member', 'first=2'], ['--member', 'first=999'],
  ]) {
    expect(pinCode(dir, flags)).toBe('PIN_SELECTION_INVALID');
    expect(readFileSync(join(dir, 'collection.json'))).toEqual(before);
  }
  const project = read(dir, 'members/first/project.json'); obj(arr(project.versions)[0]).kind = 'post'; save(dir, project, 'members/first/project.json');
  expect(pinCode(dir, ['--member', 'first=1'])).toBe('PIN_SELECTION_INVALID');
  expect(readFileSync(join(dir, 'collection.json'))).toEqual(before);
});

test('PIN_SELECTION_INVALID rejects malformed persisted selection metadata', () => {
  for (const [selection, version] of [['other', 1], ['explicit', null], ['explicit', 1.5], ['explicit', 0]] as const) {
    const dir = fixture(); const c = read(dir); const pin = obj(arr(obj(arr(c.versions)[0]).pins)[0]);
    pin.selection = selection; pin.version = version; save(dir, c);
    expect(checkCollection(dir).refusals.map(f => f.code)).toContain('PIN_SELECTION_INVALID');
  }
});

test('explicit lock survives newer builds but refuses missing version and recorded or disk drift', () => {
  const changes: ((p: JsonObject, dir: string) => void)[] = [
    p => { p.versions = arr(p.versions).slice(1); },
    p => { obj(arr(obj(arr(p.versions)[0]).outputs)[0]).sha256 = '0'.repeat(64); },
    p => { obj(arr(p.versions)[0]).kind = 'post'; },
    p => { arr(obj(arr(p.versions)[0]).outputs).pop(); },
    p => { obj(arr(obj(arr(p.versions)[0]).outputs)[0]).variant = 'changed'; },
    (p, dir) => { writeFileSync(join(dir, 'members/first/derived/v1/config.json'), 'drift'); },
    (p, dir) => { writeFileSync(join(dir, 'members/first/outputs/v1/alternate/sheet.png'), 'drift'); },
  ];
  for (const change of changes) {
    const dir = fixture(); const p = read(dir, 'members/first/project.json'); change(p, dir); save(dir, p, 'members/first/project.json');
    expect(checkCollection(dir).refusals.map(f => f.code)).toContain('PIN_STALE');
  }
});

test('explicit source drift refuses before appending; default still emits no selection marker', () => {
  const dir = fixture(); const before = readFileSync(join(dir, 'collection.json'));
  writeFileSync(join(dir, 'members/first/outputs/v1/default/model.json'), 'drift');
  expect(pinCode(dir, ['--member', 'first=1'])).toBe('PIN_SOURCE_DRIFT');
  expect(readFileSync(join(dir, 'collection.json'))).toEqual(before);
  expect(pinCode(dir, [])).toBe('NO_REFUSAL');
  expect(arr(obj(arr(read(dir).versions)[1]).pins).map(p => obj(p).selection ?? null)).toEqual([null, null]);
});
