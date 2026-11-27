import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCollectionPinFixture } from '../scripts/generate-collection-pin-fixture.ts';
import { PROJECT_SCHEMA } from '../src/check.ts';
import { outputSetHash, sha256 } from '../src/current.ts';
import { checkCollection } from '../src/pins-check.ts';
import type { JsonObject } from '../src/templates.ts';
import { collectionCommand } from './clock.ts';
import { arr, obj } from './fixtures.ts';
import { gitEnv, run, tempDir } from './helpers.ts';

const FIRST = 'members/first/project.json';
const SECOND = 'members/second/project.json';
const PIN = 'versions[n=2].pins[0]';

function rig(product: string, runRecord = 'run A'): JsonObject {
  const binding = (name: string, content: string) => ({ path: `outputs/rig/${name}`, sha256: sha256(content) });
  const run = binding('build-run.json', runRecord);
  const report = binding('report.json', 'report');
  const model = binding('skeleton.json', product);
  const files = [{ ...run, bytes: runRecord.length }, { ...report, bytes: 6 }, { ...model, bytes: product.length }];
  return {
    at: '2026-11-27T00:00:00.000Z', built_by: 'agent', built_with: { '@rig-c/parts': '2.60.0' },
    files, files_sha256: outputSetHash(files), built_from: [], run, report,
    rebuild: { recorded: false, note: 'Synthetic fixture has no replay.' },
  };
}

function fixture() {
  const dir = join(tempDir(), 'collection');
  generateCollectionPinFixture(dir);
  const bytes = (path: string) => readFileSync(join(dir, path));
  const read = (path = 'collection.json'): JsonObject => JSON.parse(bytes(path).toString('utf8'));
  const save = (path: string, value: JsonObject) => writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
  const setRig = (node: JsonObject | null): void => {
    const member = read(FIRST);
    member.current = node === null ? {} : { rig: node };
    save(FIRST, member);
  };
  const member = read(FIRST);
  member.schema = PROJECT_SCHEMA;
  for (const version of arr(member.versions).map(obj)) version.pre_interview = true;
  save(FIRST, member);
  const liveRig = rig('rig A');
  setRig(liveRig);
  mkdirSync(join(dir, 'outputs/v2'), { recursive: true });
  writeFileSync(join(dir, 'outputs/v2/lineup.png'), 'second output');

  const env = gitEnv({ name: 'Fixture', email: 'fixture@example.invalid' });
  const git = (...args: string[]): string => {
    const result = run(['git', ...args], dir, env);
    if (result.code !== 0) throw Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('add', '--', 'collection.json', FIRST, SECOND);
  git('commit', '--quiet', '-m', 'member records');
  const head = () => git('rev-parse', 'HEAD');
  const pin = (...flags: string[]) => collectionCommand(['pin', dir, ...flags]);
  const version = (collection: JsonObject) => obj(arr(collection.versions)[1]);
  const editPin = (mutate: (pin: JsonObject) => void) => {
    const collection = read();
    mutate(obj(arr(version(collection).pins)[0]));
    save('collection.json', collection);
  };
  return { dir, bytes, read, save, setRig, liveRig, git, head, pin, version, editPin };
}

function pinned() {
  const f = fixture();
  expect(f.pin().exit).toBe(0);
  return f;
}

test('collection pin binds exact committed current bytes and mixes with an explicit numbered pin', () => {
  const f = fixture();
  f.git('commit', '--quiet', '--allow-empty', '-m', 'unrelated HEAD');
  const before = f.read();
  const written = f.pin('--member', 'second=1');
  expect(written.exit).toBe(0);
  expect(written.stdout).toContain(`first current.rig @ ${f.head()}, second v1`);
  const after = f.read();
  expect(arr(after.versions)[0]).toEqual(arr(before.versions)[0]);
  const pins = arr(f.version(after).pins);
  expect(pins[0]).toEqual({ member: 'first', kind: 'current-rig',
    record: { path: FIRST, commit: f.head(), sha256: sha256(f.bytes(FIRST)) },
    rig: { files_sha256: f.liveRig.files_sha256 } });
  expect(pins[1]).toMatchObject({ member: 'second', version: 1, selection: 'explicit' });
  expect(checkCollection(f.dir)).toMatchObject({ ok: true, pins_checked: 2, refusals: [], warnings: [] });
});

test('a current pin and a legacy null pin both check in the same collection version', () => {
  const f = pinned();
  const collection = f.read();
  const second = obj(arr(f.version(collection).pins)[1]);
  second.version = null;
  const project = f.read(SECOND);
  project.versions = [];
  f.save(SECOND, project);
  f.save('collection.json', collection);
  expect(checkCollection(f.dir)).toMatchObject({ ok: true, pins_checked: 2, refusals: [], warnings: [] });
  writeFileSync(join(f.dir, 'members/second/outputs/v2/default/model.json'), 'legacy drift');
  expect(checkCollection(f.dir).refusals).toMatchObject([{ code: 'PIN_STALE', path: 'members[second]' }]);
});

test('PIN_MEMBER_COMMIT_UNVERIFIED refuses staged but uncommitted bytes without editing the collection', () => {
  const f = fixture();
  const original = f.bytes('collection.json');
  writeFileSync(join(f.dir, FIRST), Buffer.concat([f.bytes(FIRST), Buffer.from('\n')]));
  f.git('add', '--', FIRST);
  const written = f.pin();
  expect(written.exit).toBe(1);
  expect(written.stdout).toContain('PIN_MEMBER_COMMIT_UNVERIFIED: members[first]');
  expect(written.stdout).toContain('commit the live rig record');
  expect(f.bytes('collection.json')).toEqual(original);
});

test('a current-data member cannot fall back to its historical numbered rig', () => {
  const f = fixture();
  const original = f.bytes('collection.json');
  expect(f.pin('--member', 'first=1').stdout).toContain('PIN_SELECTION_INVALID: members[first]');
  f.setRig(null);
  expect(f.pin().stdout).toContain('PIN_NO_BUILD: members[first]');
  expect(f.bytes('collection.json')).toEqual(original);
});

test.each([
  ['missing commit', (f: ReturnType<typeof fixture>, p: JsonObject) => { obj(p.record).commit = '0'.repeat(f.head().length); }],
  ['blob as commit', (f: ReturnType<typeof fixture>, p: JsonObject) => { obj(p.record).commit = f.git('rev-parse', `HEAD:${FIRST}`); }],
  ['different registered path', (_f: ReturnType<typeof fixture>, p: JsonObject) => { obj(p.record).path = SECOND; }],
  ['record digest', (_f: ReturnType<typeof fixture>, p: JsonObject) => { obj(p.record).sha256 = '0'.repeat(64); }],
  ['rig digest', (_f: ReturnType<typeof fixture>, p: JsonObject) => { obj(p.rig).files_sha256 = '0'.repeat(64); }],
] as const)('collection --check refuses the %s mutant at its pin', (_label, mutate) => {
  const f = pinned();
  f.editPin(p => mutate(f, p));
  const report = checkCollection(f.dir);
  expect(report.ok).toBe(false);
  expect(report.refusals).toMatchObject([{ code: 'PIN_MEMBER_COMMIT_UNVERIFIED', path: PIN }]);
  expect(report.warnings).toEqual([]);
});

test('PIN_MALFORMED refuses an abbreviated current pin commit ID', () => {
  const f = pinned();
  f.editPin(p => { obj(p.record).commit = f.head().slice(0, 12); });
  expect(checkCollection(f.dir).refusals[0]).toMatchObject({ code: 'PIN_MALFORMED', path: PIN });
});

test.each(['current-rig', 'numbered'] as const)(
  'PIN_MALFORMED refuses an unverifiable duplicate current pin after a valid %s pin', firstKind => {
    const f = pinned();
    const collection = f.read();
    const pins = arr(f.version(collection).pins);
    const duplicate = structuredClone(obj(pins[0]));
    const record = obj(duplicate.record);
    record.commit = '0'.repeat(String(record.commit).length);
    if (firstKind === 'numbered') pins[0] = arr(obj(arr(collection.versions)[0]).pins)[0]!;
    pins.push(duplicate);
    f.save('collection.json', collection);

    const report = checkCollection(f.dir);
    expect(report.ok).toBe(false);
    expect(report.refusals).toMatchObject([{ code: 'PIN_MALFORMED', path: 'versions[n=2].pins[2]' }]);
  },
);

test('duplicate numbered pins for another member keep using the first pin', () => {
  const f = pinned();
  const collection = f.read();
  const pins = arr(f.version(collection).pins);
  pins.push({ ...obj(pins[1]), version: 999 });
  f.save('collection.json', collection);
  expect(checkCollection(f.dir)).toMatchObject({ ok: true, refusals: [], warnings: [] });
});

test('collection pin refuses duplicate current member registrations byte-identically', () => {
  const f = fixture();
  const collection = f.read();
  const members = arr(collection.members);
  members.push(structuredClone(members[0]!));
  f.save('collection.json', collection);
  const original = f.bytes('collection.json');

  const written = f.pin();
  expect(written.exit).toBe(1);
  expect(written.stdout).toContain('PIN_MALFORMED: members[first]');
  expect(f.bytes('collection.json')).toEqual(original);
});

test('a committed rig inventory must agree with its own files_sha256', () => {
  const f = pinned();
  const malformed = rig('rig A');
  obj(arr(malformed.files)[2]).sha256 = '0'.repeat(64);
  f.setRig(malformed);
  f.git('commit', '--quiet', '-m', 'malformed rig record', '--', FIRST);
  f.editPin(p => {
    obj(p.record).commit = f.head();
    obj(p.record).sha256 = sha256(f.bytes(FIRST));
  });
  const report = checkCollection(f.dir);
  expect(report.refusals).toMatchObject([{ code: 'PIN_MEMBER_COMMIT_UNVERIFIED', path: PIN }]);
  expect(report.refusals[0]!.message).toContain('invalid current.rig.files_sha256');
  expect(report.warnings).toEqual([]);
});

test('a gitlink cannot serve as the committed member source', () => {
  const f = pinned();
  const previous = f.head();
  f.git('rm', '--quiet', '--cached', '--', FIRST);
  f.git('update-index', '--add', '--cacheinfo', `160000,${previous},members/first`);
  f.git('commit', '--quiet', '-m', 'gitlink control');
  f.editPin(p => { obj(p.record).commit = f.head(); });
  expect(checkCollection(f.dir).refusals).toMatchObject([{ code: 'PIN_MEMBER_COMMIT_UNVERIFIED', path: PIN }]);
});

test('matching pin and registration paths still must be literal member paths', () => {
  const f = pinned();
  const collection = f.read();
  const alias = 'members/first/../first/project.json';
  obj(arr(collection.members)[0]).project = alias;
  obj(obj(arr(f.version(collection).pins)[0]).record).path = alias;
  f.save('collection.json', collection);
  const original = f.bytes('collection.json');
  expect(f.pin().stdout).toContain('PIN_MEMBER_COMMIT_UNVERIFIED: members[first]');
  expect(checkCollection(f.dir).refusals).toMatchObject([{ code: 'PIN_MEMBER_COMMIT_UNVERIFIED', path: PIN }]);
  expect(f.bytes('collection.json')).toEqual(original);
});

test('a committed symlink is refused even when its blob bytes match the record binding', () => {
  const f = pinned();
  const blob = f.git('rev-parse', `HEAD:${FIRST}`);
  f.git('update-index', '--cacheinfo', `120000,${blob},${FIRST}`);
  f.git('commit', '--quiet', '-m', 'symlink control');
  f.editPin(p => { obj(p.record).commit = f.head(); });
  expect(checkCollection(f.dir).refusals).toMatchObject([{ code: 'PIN_MEMBER_COMMIT_UNVERIFIED', path: PIN }]);
});

test('live links cannot be pinned and cannot supply the digest for a verified historical pin', () => {
  const f = pinned();
  const original = f.bytes('collection.json');
  const outside = join(tempDir(), 'project.json');
  writeFileSync(outside, f.bytes(FIRST));
  renameSync(join(f.dir, FIRST), join(f.dir, 'members/first/source.json'));
  symlinkSync(outside, join(f.dir, FIRST));
  expect(f.pin().stdout).toContain('PIN_MEMBER_COMMIT_UNVERIFIED: members[first]');
  const report = checkCollection(f.dir);
  expect(report.ok).toBe(true);
  expect(report.warnings).toMatchObject([{ code: 'PIN_MEMBER_EARLIER', path: PIN }]);
  expect(report.warnings[0]!.message).toContain('no live rig to compare');
  expect(f.bytes('collection.json')).toEqual(original);
});

test('historical check resolves the named objects despite local commit and blob replacements', () => {
  const f = pinned();
  const commit = f.head();
  const blob = f.git('rev-parse', `HEAD:${FIRST}`);
  f.setRig(rig('rig B'));
  f.git('commit', '--quiet', '-m', 'different rig', '--', FIRST);
  f.git('replace', commit, f.head());
  f.git('replace', blob, f.git('rev-parse', `HEAD:${FIRST}`));
  const report = checkCollection(f.dir);
  expect(report.ok).toBe(true);
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toMatchObject([{ code: 'PIN_MEMBER_EARLIER', path: PIN }]);
});

test('a changed live rig is earlier, an absent rig is earlier, and the same digest stays current', () => {
  const f = pinned();
  const collection = f.bytes('collection.json');
  const replacement = rig('rig B');
  f.setRig(replacement);
  const check = collectionCommand(['--check', f.dir, '--json']);
  expect(check.exit).toBe(0);
  const report = JSON.parse(check.stdout) as ReturnType<typeof checkCollection>;
  expect(report.warnings).toMatchObject([{ code: 'PIN_MEMBER_EARLIER', path: PIN }]);
  for (const expected of [f.head(), String(f.liveRig.files_sha256).slice(0, 12), String(replacement.files_sha256).slice(0, 12)]) {
    expect(report.warnings[0]!.message).toContain(expected);
  }
  f.setRig(null);
  const absent = checkCollection(f.dir);
  expect(absent.ok).toBe(true);
  expect(absent.warnings).toMatchObject([{ code: 'PIN_MEMBER_EARLIER', path: PIN }]);
  expect(absent.warnings[0]!.message).toContain('no live rig to compare');
  f.setRig({ ...rig('rig A', 'run B'), at: '2026-11-27T01:00:00.000Z' });
  f.git('commit', '--quiet', '-m', 'same rig digest', '--', FIRST);
  expect(checkCollection(f.dir)).toMatchObject({ ok: true, refusals: [], warnings: [] });
  expect(f.bytes('collection.json')).toEqual(collection);
});
