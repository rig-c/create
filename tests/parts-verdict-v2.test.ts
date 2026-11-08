/** Closed schema adoption using unedited producer-written verdicts, never a sibling checkout. */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkPartsVerdict, sourceSha256 } from '../src/parts-verdict.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { checkProject, reopenCommand, advanceCommand, signoffCommand, testClock } from './clock.ts';

const variants = [
  { name: '/1 unchanged release', folder: 'rig-review-1.5.0', file: 'parts-review.json', schema: 'rig-review-parts-verdict/1', comments: undefined },
  { name: '/2 no comments', folder: 'rig-review-parts-verdict-2', file: 'parts-review.json', schema: 'rig-review-parts-verdict/2', comments: 0 },
  { name: '/2 pointed comments', folder: 'rig-review-parts-verdict-2', file: 'parts-review-comments.json', schema: 'rig-review-parts-verdict/2', comments: 1 },
] as const;
type Variant = typeof variants[number];
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const write = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(p, null, 2) + '\n');
const signoff = (p: JsonObject): JsonObject => obj(arr(p.signoffs).find(s => obj(s).stage === 'parts-review'));

afterEach(() => testClock.reset());
function project(v: Variant): string {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => {
    p.stage = 'rigging'; p.versions = [];
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts', 'parts-review'].includes(String(obj(s).stage)) && !Array.isArray(obj(s).steps));
    for (const s of arr(obj(p.plan).steps).map(obj)) if (s.phase === 'post' || ['bones', 'meshes', 'constraints', 'motion'].includes(String(s.id))) s.status = 'pending';
  });
  const source = join(import.meta.dir, 'fixtures', v.folder);
  for (const folder of ['derived', 'evidence']) cpSync(join(source, folder), join(dir, folder), { recursive: true });
  const p = read(dir);
  signoff(p).evidence = { kind: 'parts-verdict', path: `evidence/${v.file}`, sha256: sha(readFileSync(join(dir, 'evidence', v.file))) };
  write(dir, p);
  return dir;
}

/** Rehash only a planted verdict, to isolate its inner contract from evidence-byte binding. */
function plant(dir: string, v: Variant, edit: (verdict: JsonObject) => void): void {
  const file = join(dir, 'evidence', v.file);
  const verdict = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  edit(verdict);
  writeFileSync(file, JSON.stringify(verdict, null, 2) + '\n');
  const p = read(dir); obj(signoff(p).evidence).sha256 = sha(readFileSync(file)); write(dir, p);
}

function record(dir: string, v: Variant): void {
  writeFileSync(join(dir, 'approval.txt'), 'The reviewed parts are clean.\n');
  const result = signoffCommand(['parts-review', dir, '--by', 'user', '--evidence', `evidence/${v.file}`,
    '--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'p10-n3=in-painting:synthetic painting',
    '--component', 'p1000-n3=in-painting:synthetic painting', '--verbatim-file', join(dir, 'approval.txt')]);
  expect(result.exit).toBe(0);
}

function refusedWrite(dir: string, v: Variant, code: string): void {
  const before = readFileSync(join(dir, 'project.json'));
  let failure: unknown;
  try { record(dir, v); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Refusal);
  expect((failure as Refusal).code).toBe(code);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

for (const v of variants) describe(v.name, () => {
  test('producer bytes pass checkProject and writer then checkProject, with the same covered parts path', () => {
    const dir = project(v), file = join(dir, 'evidence', v.file), before = readFileSync(file);
    const verdict = JSON.parse(before.toString()) as JsonObject;
    expect(verdict.schema).toBe(v.schema);
    if (v.comments === undefined) expect(verdict.comments).toBeUndefined();
    else {
      expect(arr(verdict.comments)).toHaveLength(v.comments);
      expect(obj(verdict.tool).version).toBe('1.6.0');
    }
    expect(checkProject(dir)).toMatchObject({ ok: true, refusals: [] });
    const errors: Parameters<typeof checkPartsVerdict>[3] = [];
    expect(checkPartsVerdict(dir, signoff(read(dir)), 'signoffs[3]', errors)).toBe(join(dir, 'derived/parts/rig/parts.json'));
    expect(errors).toEqual([]);
    writeFileSync(join(dir, 'reopen.txt'), 'Revisit the synthetic parts approval.');
    reopenCommand(['parts-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'reopen.txt')]);
    testClock.set(new Date('2026-11-20T00:00:01Z'));
    record(dir, v);
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_LAGGING');
    advanceCommand(['rigging', dir, '--by', 'user', '--verbatim-file', join(dir, 'reopen.txt')]);
    expect(checkProject(dir)).toMatchObject({ ok: true, refusals: [] });
    expect(obj(obj(arr(read(dir).signoffs).at(-1)).evidence)).toEqual({ kind: 'parts-verdict', path: `evidence/${v.file}`, sha256: sha(before) });
    expect(readFileSync(file)).toEqual(before);
  });

  const controls: { name: string; code: string; edit: (verdict: JsonObject) => void }[] = [
    { name: 'atlas is informational', code: 'PARTS_VERDICT_ATLAS', edit: p => { p.mode = 'atlas'; } },
    { name: 'unknown mode', code: 'PARTS_VERDICT_MALFORMED', edit: p => { p.mode = 'sheet'; } },
    ...['pending', 'changes-requested'].map(status => ({ name: status, code: 'PARTS_VERDICT_NOT_APPROVED', edit: (p: JsonObject) => { p.status = status; } })),
    { name: 'empty sources', code: 'PARTS_VERDICT_MALFORMED', edit: p => { obj(p.source).files = []; } },
    { name: 'parts.json must be first', code: 'PARTS_VERDICT_MALFORMED', edit: p => { arr(obj(p.source).files).reverse(); } },
    { name: 'invalid file hash', code: 'PARTS_VERDICT_MALFORMED', edit: p => { obj(arr(obj(p.source).files)[1]).sha256 = 'A'.repeat(64); } },
    { name: 'missing source byte count', code: 'PARTS_VERDICT_MALFORMED', edit: p => { delete obj(arr(obj(p.source).files)[1]).bytes; } },
    { name: 'wrong source byte count', code: 'PARTS_VERDICT_SOURCE_CHANGED', edit: p => { obj(arr(obj(p.source).files)[1]).bytes = 999; } },
    { name: 'absolute source path', code: 'PARTS_VERDICT_MALFORMED', edit: p => { obj(arr(obj(p.source).files)[1]).path = '/part.png'; } },
    { name: 'non-POSIX source path', code: 'PARTS_VERDICT_MALFORMED', edit: p => { obj(arr(obj(p.source).files)[1]).path = 'parts\\part.png'; } },
    { name: 'source escapes project', code: 'PARTS_VERDICT_MALFORMED', edit: p => { obj(arr(obj(p.source).files)[1]).path = '../../part.png'; } },
    { name: 'source manifest digest', code: 'PARTS_VERDICT_SOURCE_MISMATCH', edit: p => { obj(p.source).sha256 = '0'.repeat(64); } },
    ...['rig-review-parts-verdict/3', 'rig-review-parts-verdict/20', 'other/2', null].map(schema => ({ name: `unknown schema ${schema}`, code: 'PARTS_VERDICT_SCHEMA_UNKNOWN', edit: (p: JsonObject) => { p.schema = schema; } })),
  ];
  for (const c of controls) test(`${c.name}: both readers refuse ${c.code}; writer preserves project bytes`, () => {
    const dir = project(v); plant(dir, v, c.edit);
    expect(checkProject(dir).refusals.map(f => f.code)).toEqual([c.code]);
    refusedWrite(dir, v, c.code);
  });

  test.each(['repainted', 'removed', 'same-length change', 'symlink outside'])('source %s remains refused through both readers', kind => {
    const dir = project(v), file = join(dir, 'derived/parts/rig/parts/torso.png');
    if (kind === 'repainted') appendFileSync(file, Buffer.from([0]));
    else if (kind === 'removed') rmSync(file);
    else if (kind === 'same-length change') { const bytes = readFileSync(file); bytes[bytes.length - 1] ^= 1; writeFileSync(file, bytes); }
    else { const target = join(tempDir(), 'torso.png'); renameSync(file, target); symlinkSync(target, file); }
    const code = kind === 'symlink outside' ? 'PARTS_VERDICT_MALFORMED' : 'PARTS_VERDICT_SOURCE_CHANGED';
    expect(checkProject(dir).refusals.map(f => f.code)).toEqual([code]);
    refusedWrite(dir, v, code);
  });

  test.each(['missing', 'invalid JSON', 'array', 'changed bytes', 'symlink outside'])('evidence %s remains refused', kind => {
    const dir = project(v), file = join(dir, 'evidence', v.file);
    if (kind === 'missing') rmSync(file);
    else if (kind === 'symlink outside') { const target = join(tempDir(), v.file); renameSync(file, target); symlinkSync(target, file); }
    else {
      writeFileSync(file, kind === 'invalid JSON' ? '{' : kind === 'array' ? '[]' : readFileSync(file).toString() + ' ');
      // Inner JSON cases bypass only the outer byte guard; changed bytes must hit it.
      if (kind !== 'changed bytes') { const p = read(dir); obj(signoff(p).evidence).sha256 = sha(readFileSync(file)); write(dir, p); }
    }
    expect(checkProject(dir).refusals.map(f => f.code)).toEqual(['PARTS_VERDICT_UNREAD']);
    if (kind !== 'changed bytes') {
      refusedWrite(dir, v, 'PARTS_VERDICT_UNREAD');
    }
  });
});

test('/2 comments: all ignored field paths are present, remain hash-bound and need no external crop state', () => {
  const v = variants[2], dir = project(v), file = join(dir, 'evidence', v.file);
  const verdict = JSON.parse(readFileSync(file, 'utf8')) as JsonObject, comment = obj(arr(verdict.comments)[0]);
  expect(Object.keys(comment).sort()).toEqual(['schema', 'id', 'summary', 'part', 'imageHash', 'sourceHash', 'imageRegion', 'rigRegion', 'view', 'crop', 'nativeCrop'].sort());
  for (const region of ['imageRegion', 'rigRegion']) expect(Object.keys(obj(comment[region])).sort()).toEqual(['height', 'width', 'x', 'y']);
  const view = obj(comment.view);
  expect(Object.keys(view).sort()).toEqual(['camera', 'cameraSync', 'referenceCamera', 'background', 'alpha', 'footprints', 'mesh'].sort());
  for (const key of ['camera', 'referenceCamera']) {
    const camera = obj(view[key]);
    expect(Object.keys(camera).sort()).toEqual(['center', 'viewport', 'zoom']);
    expect(Object.keys(obj(camera.center)).sort()).toEqual(['x', 'y']);
    expect(Object.keys(obj(camera.viewport)).sort()).toEqual(['height', 'width']);
  }
  expect(Object.keys(obj(comment.crop)).sort()).toEqual(['height', 'path', 'png', 'sha256', 'width']);
  expect(Object.keys(obj(comment.nativeCrop)).sort()).toEqual(['height', 'path', 'sha256', 'width']);
  expect(comment.sourceHash).toBe(obj(verdict.source).sha256);
  expect(comment.imageHash).toBe(obj(arr(obj(verdict.source).files)[2]).sha256);
  // No state/ or comment-crops/ is copied into the consumer project.
  record(dir, v);
  expect(checkProject(dir)).toMatchObject({ ok: true, refusals: [] });
  obj(arr(verdict.comments)[0]).summary = 'Changed comment after the sign-off.';
  writeFileSync(file, JSON.stringify(verdict));
  expect(checkProject(dir).refusals.map(f => f.code)).toEqual(['PARTS_VERDICT_UNREAD']);
});

test('/2 verdict kept beside parts.json resolves sources there, and internal links remain contained', () => {
  const v = variants[2], dir = project(v), from = join(dir, 'evidence', v.file), to = join(dir, 'derived/parts/rig', v.file);
  const verdict = JSON.parse(readFileSync(from, 'utf8')) as JsonObject;
  // Planted relocation is not a second producer fixture: only path/digest bindings change.
  const files = arr(obj(verdict.source).files).map(obj);
  for (const file of files) file.path = String(file.path).replace('../derived/parts/rig/', '');
  obj(verdict.source).sha256 = sourceSha256(files as { path: string; sha256: string }[]);
  writeFileSync(to, JSON.stringify(verdict));
  const p = read(dir); signoff(p).evidence = { kind: 'parts-verdict', path: `derived/parts/rig/${v.file}`, sha256: sha(readFileSync(to)) }; write(dir, p);
  const original = join(dir, 'derived/parts/rig/parts/torso.png'), linked = join(dir, 'retained/torso.png');
  mkdirSync(dirname(linked), { recursive: true }); renameSync(original, linked); symlinkSync(linked, original);
  expect(checkProject(dir)).toMatchObject({ ok: true, refusals: [] });
});
