import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARTS_CHECK_SINCE } from '../src/parts-check.ts';
import { Refusal } from '../src/refusal.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, retimeFixture } from './fixtures.ts';
import { partsCheckBytes, PARTS_CHECK_ROOT, withPartsCheck } from './parts-check-fixture.ts';
import { advanceCommand, checkProject, signoffCommand, stepStatusCommand, testClock } from './clock.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
const codes = (dir: string): string[] => checkProject(dir).refusals.map(f => f.code);
const report = (): JsonObject => JSON.parse(partsCheckBytes().toString('utf8')) as JsonObject;
const bytesOf = (value: JsonObject): string => `${JSON.stringify(value, null, 2)}\n`;
function words(dir: string): string { const path = join(dir, 'words.txt'); writeFileSync(path, 'Move the synthetic parts to review.\n'); return path; }
function advance(dir: string, flags: string[] = [], stage = 'parts-review', json = false): string {
  return advanceCommand([stage, dir, ...flags, ...(json ? ['--json'] : [])]).stdout;
}
function refused(dir: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  try { action(); throw new Error('expected planted refusal'); } catch (error) {
    expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code);
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

/** A synthetic project at `parts` whose bar is met, ready to move to parts-review. */
function partsDone(): string {
  const dir = fixture(p => {
    p.stage = 'parts'; p.versions = [];
    p.signoffs = arr(p.signoffs).slice(0, 2);
    retimeFixture(p, Date.parse('2026-11-16T00:00:00Z'));
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  for (const id of ['seethrough', 'assemble']) {
    for (const status of ['in-progress', 'at-checkpoint', 'done']) {
      if (id === 'assemble' && status === 'done') signoffCommand(['parts', dir, '--checkpoint', id, '--by', 'owner', '--verbatim-file', words(dir)]);
      stepStatusCommand([id, status, dir, '--by', 'agent']);
    }
  }
  expect(codes(dir)).toEqual([]);
  return dir;
}

/** The planted variant keeps the producer's key order: only values change. */
function planted(edit: (report: JsonObject) => void): string {
  const value = report();
  edit(value);
  return bytesOf(value);
}

beforeEach(() => testClock.set(new Date('2026-11-20T00:00:00Z')));
afterEach(() => testClock.reset());

test('a report with exit_code 1 and a refusal row refuses the move, bytes identical', () => {
  const dir = partsDone();
  const flags = withPartsCheck(dir, PARTS_CHECK_ROOT, 'evidence/refused-check.json', Buffer.from(planted(r => {
    r.refusals = [{ code: 'PARTS_FILE_PRESENT', object: 'parts/torso.png', found: null, required: null, detail: 'planted refusal' }];
    r.exit_code = 1;
  })));
  refused(dir, 'PARTS_CHECK_FAILED', () => advance(dir, flags));
  const exitOnly = withPartsCheck(dir, PARTS_CHECK_ROOT, 'evidence/exit-check.json', Buffer.from(planted(r => { r.exit_code = 1; })));
  refused(dir, 'PARTS_CHECK_FAILED', () => advance(dir, exitOnly));
});

test.each([
  ['a part PNG changed after the check', (dir: string) => appendFileSync(join(dir, PARTS_CHECK_ROOT, 'parts/torso.png'), Buffer.from([0]))],
  ['a part PNG is gone', (dir: string) => rmSync(join(dir, PARTS_CHECK_ROOT, 'parts/lantern.png'))],
  ['a file the report never read', (dir: string) => writeFileSync(join(dir, PARTS_CHECK_ROOT, 'parts/extra.png'), 'x')],
  ['an optional input that was absent now exists', (dir: string) => writeFileSync(join(dir, PARTS_CHECK_ROOT, 'source_cover.json'), '{}')],
] as const)('a stale report refuses the move: %s', (_name, change) => {
  const dir = partsDone();
  const flags = withPartsCheck(dir);
  change(dir);
  refused(dir, 'PARTS_CHECK_STALE', () => advance(dir, flags));
});

test('a stale report names a required row that was missing at the check', () => {
  const dir = partsDone();
  const flags = withPartsCheck(dir, PARTS_CHECK_ROOT, 'evidence/missing-row.json', Buffer.from(planted(r => {
    const inputs = r.inputs as JsonObject[];
    inputs.push({ path: 'parts/zz.png', status: 'missing', sha256: null });
  })));
  refused(dir, 'PARTS_CHECK_STALE', () => advance(dir, flags));
});

test('a passing report with HOLE rows writes, prints every HOLE as a named line and stores them verbatim', () => {
  const dir = partsDone();
  const holes = arr(report().holes).map(obj);
  expect(holes.length).toBeGreaterThan(0);
  const stdout = advance(dir, withPartsCheck(dir));
  const project = read(dir);
  const index = arr(project.advances).length - 1;
  const entry = obj(arr(project.advances)[index]);
  expect(entry).toMatchObject({ from_stage: 'parts', stage: 'parts-review' });
  const check = obj(entry.parts_check);
  expect(Object.keys(check)).toEqual(['path', 'sha256', 'spec', 'parts', 'exit_code', 'holes', 'reported']);
  expect(check).toMatchObject({ path: 'evidence/parts-check.json', spec: 'rig-parts-parts-check/1', parts: PARTS_CHECK_ROOT, exit_code: 0 });
  expect(check.holes).toEqual(report().holes as Json);
  expect(check.reported).toEqual(report().reported as Json);
  const lines = stdout.split('\n');
  for (const [i, hole] of holes.entries()) {
    expect(lines).toContain(`  ${String(hole.line)} (advances[${index}].parts_check.holes[${i}])`);
    expect(String(hole.line).startsWith(`${String(hole.code)}: HOLE`)).toBe(true);
  }
  expect(codes(dir)).toEqual([]);
  expect(checkProject(dir).warnings.filter(f => f.code.startsWith('PARTS_CHECK'))).toEqual([]);
  // The move is judged against the disk once: parts change on purpose after it.
  appendFileSync(join(dir, PARTS_CHECK_ROOT, 'parts/torso.png'), Buffer.from([0]));
  expect(codes(dir)).toEqual([]);
});

test('--json prints the entry with its HOLE rows', () => {
  const dir = partsDone();
  const entry = JSON.parse(advance(dir, withPartsCheck(dir), 'parts-review', true)) as JsonObject;
  expect(obj(entry.parts_check).holes).toEqual(report().holes as Json);
});

test('missing flags, a lone flag and flags on another move are refused, bytes identical', () => {
  const dir = partsDone();
  refused(dir, 'PARTS_CHECK_MISSING', () => advance(dir));
  const [, reportPath, , root] = withPartsCheck(dir);
  refused(dir, 'PROGRESS_OPTION_INVALID', () => advance(dir, ['--parts-check', reportPath!]));
  refused(dir, 'PROGRESS_OPTION_INVALID', () => advance(dir, ['--parts', root!]));
  const earlier = fixture(p => {
    p.stage = 'plan-approved'; p.versions = [];
    p.signoffs = arr(p.signoffs).slice(0, 2);
    retimeFixture(p, Date.parse('2026-11-16T00:00:00Z'));
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  refused(earlier, 'PROGRESS_OPTION_INVALID', () => advance(earlier, withPartsCheck(earlier), 'parts'));
});

test.each([
  ['an unreadable report', 'evidence/none.json', null, 'PARTS_CHECK_UNREAD'],
  ['a report that is not JSON', 'evidence/not-json.json', 'not json', 'PARTS_CHECK_UNREAD'],
  ['a report under an ignored root', 'derived/parts-check.json', null, 'PARTS_CHECK_UNREAD'],
  ['the wrong spec', 'evidence/spec.json', planted(r => { r.spec = 'rig-parts-parts-check/0'; }), 'PARTS_CHECK_INVALID'],
  ['the wrong stage', 'evidence/stage.json', planted(r => { r.stage = 'rig'; }), 'PARTS_CHECK_INVALID'],
  ['a malformed HOLE row', 'evidence/hole.json', planted(r => { (r.holes as JsonObject[])[0] = { code: 'PARTS_PLATE_GHOST' }; }), 'PARTS_CHECK_INVALID'],
] as const)('the writer refuses %s', (_name, path, bytes, code) => {
  const dir = partsDone();
  const flags = withPartsCheck(dir);
  if (path === 'derived/parts-check.json') writeFileSync(join(dir, path), partsCheckBytes());
  else if (bytes !== null) writeFileSync(join(dir, path), bytes);
  flags[1] = path;
  refused(dir, code, () => advance(dir, flags));
});

test('a later check refuses changed retained bytes and a hand-edited copy', () => {
  const dir = partsDone();
  advance(dir, withPartsCheck(dir));
  const index = arr(read(dir).advances).length - 1;
  const path = `advances[${index}].parts_check`;
  writeFileSync(join(dir, 'evidence/parts-check.json'), `${partsCheckBytes().toString('utf8')} `);
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual([['PARTS_CHECK_CHANGED', `${path}.sha256`]]);
  writeFileSync(join(dir, 'evidence/parts-check.json'), partsCheckBytes());
  const project = read(dir);
  obj(obj(arr(project.advances)[index]).parts_check).holes = [];
  save(dir, project);
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual([['PARTS_CHECK_INVALID', path]]);
  obj(obj(arr(project.advances)[index]).parts_check).holes = report().holes as Json;
  obj(obj(arr(project.advances)[index]).parts_check).extra = true;
  save(dir, project);
  expect(codes(dir)).toEqual(['PARTS_CHECK_INVALID']);
});

test('a pre-SINCE move without parts_check WARNs; from the date it refuses', () => {
  // The legacy synthetic cohort is dated before PARTS_CHECK_SINCE.
  const dir = fixture(p => { p.stage = 'parts-review'; p.versions = []; });
  const project = read(dir);
  const index = arr(project.advances).findIndex(raw => obj(raw).from_stage === 'parts' && obj(raw).stage === 'parts-review');
  const entry = obj(arr(project.advances)[index]);
  expect(Date.parse(String(entry.at))).toBeLessThan(Date.parse(PARTS_CHECK_SINCE));
  expect(entry.parts_check).toBeDefined();
  const before = checkProject(dir);
  delete entry.parts_check; save(dir, project);
  const after = checkProject(dir);
  expect(after.refusals).toEqual(before.refusals);
  const known = new Set(before.warnings.map(f => f.code));
  expect(after.warnings.filter(f => !known.has(f.code)).map(f => [f.code, f.path])).toEqual([['PARTS_CHECK_MISSING', `advances[${index}].parts_check`]]);
  expect(after.warnings).toHaveLength(before.warnings.length + 1);
  const bare = checkProject(dir, { ...project, advances: arr(project.advances).map((raw, i) => i === index ? { ...obj(raw), at: PARTS_CHECK_SINCE } : raw) });
  expect(bare.refusals.map(f => [f.code, f.path])).toContainEqual(['PARTS_CHECK_MISSING', `advances[${index}].parts_check`]);
});

test('parts_check on any other move is refused', () => {
  const dir = partsDone();
  advance(dir, withPartsCheck(dir));
  const project = read(dir);
  const moves = arr(project.advances).map(obj);
  const other = moves.findIndex(move => move.stage === 'parts');
  moves[other]!.parts_check = structuredClone(moves.at(-1)!.parts_check!);
  save(dir, project);
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual([['PARTS_CHECK_INVALID', `advances[${other}].parts_check`]]);
});
