import { expect, test } from 'bun:test';
import { readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { checkProject } from '../src/check.ts';
import { checkpointEvidenceContext, parseCheckpointEvidence, parseCheckpointTable, readCheckpointEvidence } from '../src/checkpoint-evidence.ts';
import { checkpointEvidenceCommand, checkpointTableCommand } from '../src/checkpoint-evidence-writer.ts';
import { main } from '../src/cli.ts';
import { jobHash } from '../src/job-outbox.ts';
import { readRecordPublished } from '../src/job-publication.ts';
import type { JsonObject } from '../src/templates.ts';
import { TEST_NOW } from './clock.ts';
import { checkpointWorkspace } from './checkpoint-evidence-fixture.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';

function project(root: string): JsonObject { return JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')); }
function unchanged(root: string, action: () => unknown, code: string) {
  const before = readFileSync(join(root, 'project.json'));
  expect(action).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}

/** Use the native temporary-root spelling on macOS, or an owned root alias elsewhere. */
function aliasedRoot(root: string): string {
  const native = resolve(tmpdir(), relative(realpathSync(tmpdir()), root));
  if (native !== root) return native;
  const alias = join(tempDir(), 'project-alias');
  symlinkSync(root, alias, 'dir');
  return alias;
}

test('checkpoint root aliases preserve writer and normal checker evidence reads', () => {
  const f = checkpointWorkspace();
  const alias = aliasedRoot(f.root);
  expect(alias).not.toBe(realpathSync(alias));
  expect(checkProject(alias, undefined, { now: TEST_NOW }).refusals).toEqual([]);
  f.attach();
  expect(checkpointEvidenceCommand([alias, '--file', 'evidence/checkpoint/packets.json'], TEST_NOW).exit).toBe(0);
  const before = readFileSync(join(f.root, 'project.json'));
  expect(checkProject(alias, undefined, { now: TEST_NOW }).refusals).toEqual([]);
  const recorded = checkProject(alias, undefined, { now: TEST_NOW, recordReads: true });
  expect(recorded.refusals).toEqual([]);
  for (const { path, sha256 } of [...f.packet.tiles, f.packet.table]) expect(recorded.reads).toContainEqual({ path, sha256 });
  expect(readFileSync(join(f.root, 'project.json'))).toEqual(before);
});

test.each(['inside', 'outside'])('checkpoint nested %s directory symlinks refuse under a root alias', location => {
  const f = checkpointWorkspace();
  f.attach();
  const alias = aliasedRoot(f.root);
  const directory = join(f.root, 'evidence/checkpoint');
  const target = location === 'inside' ? join(f.root, 'evidence/checkpoint-real') : join(tempDir(), 'checkpoint-real');
  renameSync(directory, target);
  symlinkSync(target, directory, 'dir');
  const before = readFileSync(join(f.root, 'project.json'));
  expect(checkProject(alias, undefined, { now: TEST_NOW }).refusals.map(finding => finding.code)).toContain('CHECKPOINT_EVIDENCE_PATH_REFUSED');
  unchanged(f.root, () => f.attach(), 'CHECKPOINT_EVIDENCE_PATH_REFUSED');
  expect(readFileSync(join(f.root, 'project.json'))).toEqual(before);
});

test('checkpoint missing evidence files retain their named refusal under a root alias', () => {
  const f = checkpointWorkspace();
  f.attach();
  const alias = aliasedRoot(f.root);
  rmSync(join(f.root, f.packet.table.path));
  expect(checkProject(alias, undefined, { now: TEST_NOW }).refusals.map(finding => finding.code)).toContain('CHECKPOINT_EVIDENCE_PATH_REFUSED');
  unchanged(f.root, () => f.attach(), 'CHECKPOINT_EVIDENCE_PATH_REFUSED');
});

test('checkpoint writer and CLI preserve all four images, 103 rows, exact text and historical absence', () => {
  const f = checkpointWorkspace();
  expect(checkProject(f.root, undefined, { now: TEST_NOW }).refusals).toEqual([]);
  const before = readFileSync(join(f.root, 'project.json'));
  expect(readCheckpointEvidence(f.root, project(f.root))).toBeUndefined();
  expect(main(['checkpoint-evidence', f.root, '--file', 'evidence/checkpoint/packets.json'], TEST_NOW)).toBe(1);
  expect(readFileSync(join(f.root, 'project.json'))).toEqual(before);
  expect(f.attach().exit).toBe(0);
  const written = readFileSync(join(f.root, 'project.json'));
  expect(f.attach().exit).toBe(0);
  expect(readFileSync(join(f.root, 'project.json'))).toEqual(written);
  const record = project(f.root);
  expect(readCheckpointEvidence(f.root, record)).toEqual([f.packet]);
  expect(checkProject(f.root, undefined, { now: TEST_NOW }).refusals).toEqual([]);
  const context = readRecordPublished({ root: f.root, record: { path: 'project.json', sha256: jobHash(written) }, result: { kind: 'plan' }, phase: 'inventory' }, TEST_NOW);
  expect(context.checkpointEvidence).toEqual([f.packet]);
  for (const { path, sha256 } of [...f.packet.tiles, f.packet.table]) expect(context.files).toContainEqual({ path, sha256 });
  const table = parseCheckpointTable(readFileSync(join(f.root, String(obj(f.packet.table).path))));
  expect(table.columns).toEqual(Object.keys(f.rows[0]!));
  expect(table.rows).toEqual(f.rows.map(row => Object.values(row).map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value)));
  expect(table.rows).toHaveLength(103);
  expect(table.rows.every(row => row[2] === 'FAIL')).toBe(true);
  const historical = checkpointEvidenceContext(f.root, record, [{ kind: 'signoff' }], []);
  expect(historical).toEqual({});
  expect(Object.hasOwn(historical, 'checkpointEvidence')).toBe(false);
});

test('closed packet grammar rejects aliases, missing and unknown keys, empty and duplicate identities without writing', () => {
  const f = checkpointWorkspace();
  for (const raw of [null, [], [f.packet, f.packet], [{ ...f.packet, planStepId: 'missing' }], [{ ...f.packet, checkpointId: 'alias' }],
    [{ ...f.packet, routesText: '' }], [{ ...f.packet, recommendationText: 'x'.repeat(4097) }], [{ ...f.packet, extra: true }],
    [{ ...f.packet, tiles: [arr(f.packet.tiles)[0], arr(f.packet.tiles)[0]] }], [{ ...f.packet, table: { ...obj(f.packet.table), rows: [] } }]]) {
    unchanged(f.root, () => f.attach(raw), 'CHECKPOINT_EVIDENCE_INVALID');
  }
  for (const key of Object.keys(f.packet)) {
    const copy: JsonObject = { ...f.packet }; delete copy[key];
    unchanged(f.root, () => f.attach([copy]), 'CHECKPOINT_EVIDENCE_INVALID');
  }
  const reordered = Object.fromEntries(Object.entries(f.packet).reverse());
  expect(JSON.stringify(parseCheckpointEvidence([reordered], project(f.root)))).toBe(JSON.stringify([f.packet]));
});

test('unsafe, drifted and symlinked evidence refuses through the writer and the same checker codes', () => {
  const f = checkpointWorkspace();
  for (const path of ['../escape', '/absolute', 'a//b', 'a/./b', 'a\\b', 'a%2fb', 'a?b']) {
    unchanged(f.root, () => f.attach([{ ...f.packet, table: { ...obj(f.packet.table), path } }]), 'CHECKPOINT_EVIDENCE_INVALID');
  }
  const table = obj(f.packet.table);
  const file = join(f.root, String(table.path));
  const raw = readFileSync(file);
  writeFileSync(file, Buffer.concat([raw, Buffer.from(' ')]));
  unchanged(f.root, () => f.attach(), 'CHECKPOINT_EVIDENCE_HASH_MISMATCH');
  writeFileSync(file, raw);
  f.attach();
  writeFileSync(file, Buffer.concat([raw, Buffer.from(' ')]));
  expect(checkProject(f.root, undefined, { now: TEST_NOW }).refusals.map(value => value.code)).toContain('CHECKPOINT_EVIDENCE_HASH_MISMATCH');
  rmSync(file); symlinkSync(join(f.root, 'evidence/checkpoint/producer.json'), file);
  unchanged(f.root, () => f.attach(), 'CHECKPOINT_EVIDENCE_PATH_REFUSED');
});

test('table presentation keeps source bytes, refuses dropping columns, invalid cells and overwriting output', () => {
  const f = checkpointWorkspace();
  const path = join(f.root, 'evidence/checkpoint/producer.json');
  const before = readFileSync(path);
  const args = [f.root, '--file', path, '--rows', 'pairFrames', '--out', 'evidence/checkpoint/table.json'];
  expect(checkpointTableCommand(args).exit).toBe(0);
  expect(readFileSync(path)).toEqual(before);
  writeFileSync(path, JSON.stringify({ pairFrames: [{ a: 1 }, { a: 2, extra: 3 }] }));
  unchanged(f.root, () => checkpointTableCommand(args), 'CHECKPOINT_EVIDENCE_TABLE_INVALID');
  writeFileSync(path, JSON.stringify({ pairFrames: [{ a: 1 }] }));
  unchanged(f.root, () => checkpointTableCommand(args), 'CHECKPOINT_EVIDENCE_WRITE_CONFLICT');
  const base = { schema: 'rig-review-checkpoint-table/1' as const, columns: ['one'], rows: [[null], [''], [true], [1.25]] };
  expect(parseCheckpointTable(Buffer.from(JSON.stringify(base)))).toEqual(base);
  for (const invalid of [{ ...base, extra: 1 }, { ...base, rows: [[{}]] }, { ...base, rows: [[1, 2]] },
    { ...base, columns: [] }, { ...base, rows: [['x'.repeat(2049)]] }, { ...base, rows: [['\r']] }]) {
    expect(() => parseCheckpointTable(Buffer.from(JSON.stringify(invalid)))).toThrow(expect.objectContaining({ code: 'CHECKPOINT_EVIDENCE_TABLE_INVALID' }));
  }
});
