import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { generateExampleDiff } from '../scripts/generate-example-diff.ts';
import { DIFF_MAP_SINCE } from '../src/diff-map.ts';
import { sourceSha256 } from '../src/parts-verdict.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_DIFF_REPORT, generateDiffFixture } from './diff-fixture.ts';
import { arr, fixture, historicalFixture, obj, rehashSignoffs, retimeFixture } from './fixtures.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { EXAMPLE_PARTS_DIR, EXAMPLE_VERDICT } from './parts-package.ts';
import { checkProject, reopenCommand, advanceCommand, signoffCommand, testClock } from './clock.ts';

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const reports: Record<string, string> = {};
beforeAll(() => {
  for (const [name, floor, threshold, other, identical] of [
    ['normal', 2, 40, false, false], ['other', 2, 40, true, false],
    ['floor', 3, 40, false, false], ['threshold', 2, 41, false, false], ['empty', 2, 40, false, true],
  ] as const) reports[name] = generateDiffFixture(join(tempDir(), name), floor, threshold, other, identical);
});
afterEach(() => testClock.reset());

function signoff(p: JsonObject): JsonObject {
  return arr(p.signoffs).map(obj).filter((s) => s.stage === 'parts-review').at(-1)!;
}
function rigging(p: JsonObject): void {
  p.stage = 'rigging';
  p.versions = [];
  p.signoffs = arr(p.signoffs).filter((s) => ['interview', 'plan-approved', 'parts', 'parts-review'].includes(String(obj(s).stage)) && !Array.isArray(obj(s).steps));
  for (const s of arr(obj(p.plan).steps).map(obj)) if (s.phase === 'post' || ['bones', 'meshes', 'constraints', 'motion'].includes(String(s.id))) s.status = 'pending';
}
function project(edit: (s: JsonObject, project: JsonObject) => void = () => {}, name = 'normal', historical = false): string {
  const report = reports[name];
  const materialize = historical ? historicalFixture : fixture;
  return materialize((p) => {
    rigging(p);
    const s = signoff(p);
    s.diff_map = { report: { path: EXAMPLE_DIFF_REPORT, sha256: sha(report) },
      components: (JSON.parse(report) as { components: { id: string }[] }).components.map((c) => ({ id: c.id, status: 'left', why: 'the synthetic difference is accepted' })) };
    edit(s, p);
  }, 'legacy-example-project.json', { [EXAMPLE_DIFF_REPORT]: report });
}
function componentFlags(dir: string): string[] {
  const report = JSON.parse(readFileSync(join(dir, EXAMPLE_DIFF_REPORT), 'utf8')) as { components: { id: string }[] };
  return report.components.flatMap((c, i) => ['--component', `${c.id}=${['in-painting', 'fixed', 'left'][i % 3]}:observed: synthetic difference`]);
}
function writer(dir: string, flags = componentFlags(dir)) {
  writeFileSync(join(dir, 'words.txt'), 'reviewed the synthetic assembly');
  return cli(['signoff', 'parts-review', '--by', 'user', '--evidence', EXAMPLE_VERDICT,
    '--diff-report', EXAMPLE_DIFF_REPORT, ...flags, '--verbatim-file', join(dir, 'words.txt'), '--json'], dir, gitEnv());
}
function only(dir: string, code: string): string {
  const report = checkProject(dir);
  expect(report.refusals.map((f) => f.code)).toEqual([code]);
  const finding = report.refusals[0]!;
  expect(finding.message).toContain('signoffs[');
  expect(finding.message).toContain('diff_map');
  return finding.message;
}
function moveToAssemble(dir: string): void {
  const to = join(dir, EXAMPLE_PARTS_DIR, '../render/recomposite_rig.png');
  mkdirSync(dirname(to), { recursive: true });
  renameSync(join(dir, EXAMPLE_PARTS_DIR, 'recomposite_rig.png'), to);
}

describe('B0 normal writer and both producer layouts', () => {
  test.each(['build', 'assemble'])('%s permits rigging with every component listed', (layout) => {
    const dir = project();
    const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    testClock.reset();
    retimeFixture(p, testClock.now());
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
    writeFileSync(join(dir, 'words.txt'), 'Revisit the synthetic parts.');
    reopenCommand(['parts-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
    if (layout === 'assemble') moveToAssemble(dir);
    testClock.set(testClock.now() + 1000);
    const result = writer(dir);
    expect(result.code).toBe(0);
    const signed = JSON.parse(result.stdout) as JsonObject;
    expect(arr(obj(signed.diff_map).components)).toHaveLength(2);
    expect(obj(arr(obj(signed.diff_map).components)[0]).why).toBe('observed: synthetic difference');
    // Signed after STAGE_PROGRESS_SINCE, the lagging stage is a refusal until advance moves it.
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_LAGGING');
    advanceCommand(['rigging', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });
  test('a zero-component producer report needs no component flags', () => {
    const dir = project(() => {}, 'empty');
    // This report was measured on the identical-painting stack.
    const inputs = join(tempDir(), 'empty-stack');
    generateDiffFixture(inputs, 2, 40, false, true);
    writeFileSync(join(dir, EXAMPLE_PARTS_DIR, 'recomposite_rig.png'), readFileSync(join(inputs, 'recomposite_rig.png')));
    expect(writer(dir, []).code).toBe(0);
    expect(checkProject(dir).refusals).toEqual([]);
  });
});

test('B1 missing id is named and the writer leaves project.json unchanged', () => {
  const dir = project((s) => { obj(s.diff_map).components = arr(obj(s.diff_map).components).slice(1); });
  expect(only(dir, 'DIFF_MAP_COMPONENT_UNLISTED')).toContain('p10-n3');
  const before = readFileSync(join(dir, 'project.json'));
  const result = writer(dir, componentFlags(dir).slice(2));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('DIFF_MAP_COMPONENT_UNLISTED');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});
test('B1b unknown id', () => {
  only(project((s) => { arr(obj(s.diff_map).components).push({ id: 'extra', status: 'left', why: 'synthetic' }); }), 'DIFF_MAP_COMPONENT_UNKNOWN');
});
test('B2 other stack is refused at check and write time without changing project.json', () => {
  const dir = project(() => {}, 'other');
  only(dir, 'DIFF_MAP_STACK_MISMATCH');
  const before = readFileSync(join(dir, 'project.json'));
  const result = writer(dir);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('DIFF_MAP_STACK_MISMATCH');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});
test.each(['floor', 'threshold'])('B2b producer %s exceeds policy', (name) => {
  only(project(() => {}, name), 'DIFF_MAP_POLICY');
});

test('B3 absent diff_map', () => { only(project((s) => { delete s.diff_map; }), 'DIFF_MAP_MISSING'); });
test('B3 wrong report hash', () => {
  only(project((s) => { obj(obj(s.diff_map).report).sha256 = '0'.repeat(64); }), 'DIFF_MAP_REPORT');
});
test.each(['spec', 'shape', 'json', 'duplicate'])('B3 bad report %s', (kind) => {
  const parsed = JSON.parse(reports.normal) as JsonObject;
  if (kind === 'spec') parsed.spec = 'other';
  if (kind === 'shape') delete parsed.definition;
  if (kind === 'duplicate') arr(parsed.components).push(arr(parsed.components)[0]);
  const text = kind === 'json' ? '{' : JSON.stringify(parsed);
  const dir = project((s) => { obj(obj(s.diff_map).report).sha256 = sha(text); });
  writeFileSync(join(dir, EXAMPLE_DIFF_REPORT), text);
  only(dir, 'DIFF_MAP_REPORT');
});
test('B3 report absent', () => {
  const dir = project(); rmSync(join(dir, EXAMPLE_DIFF_REPORT)); only(dir, 'DIFF_MAP_REPORT');
});
test.each(['left', 'fixed', 'in-painting'])('B3 empty why for %s', (status) => {
  only(project((s) => { const c = obj(arr(obj(s.diff_map).components)[0]); c.status = status; c.why = '  '; }), 'DIFF_MAP_STATUS');
});
test('B3 bad status', () => {
  only(project((s) => { obj(arr(obj(s.diff_map).components)[0]).status = 'accepted'; }), 'DIFF_MAP_STATUS');
});
test('duplicate sign-off id is refused', () => {
  only(project((s) => { arr(obj(s.diff_map).components).push(arr(obj(s.diff_map).components)[0]); }), 'DIFF_MAP_STATUS');
});
test('neither stack candidate names both paths', () => {
  const dir = project(); rmSync(join(dir, EXAMPLE_PARTS_DIR, 'recomposite_rig.png'));
  const message = only(dir, 'DIFF_MAP_STACK_MISMATCH');
  expect(message).toContain(`${EXAMPLE_PARTS_DIR}/recomposite_rig.png`);
  expect(message).toContain('derived/parts/render/recomposite_rig.png');
});
test('both stack candidates are ambiguous', () => {
  const dir = project();
  const alternate = join(dir, 'derived/parts/render/recomposite_rig.png');
  mkdirSync(dirname(alternate), { recursive: true });
  writeFileSync(alternate, readFileSync(join(dir, EXAMPLE_PARTS_DIR, 'recomposite_rig.png')));
  expect(only(dir, 'DIFF_MAP_STACK_MISMATCH')).toContain('ambiguous');
});
test('a directory not named rig has only the build candidate', () => {
  const dir = project();
  const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const verdict = JSON.parse(readFileSync(join(dir, EXAMPLE_VERDICT), 'utf8')) as JsonObject;
  // Rename all reviewed paths and rebind the synthetic verdict.
  for (const raw of arr(obj(verdict.source).files)) obj(raw).path = String(obj(raw).path).replace('/rig/', '/build/');
  obj(verdict.source).sha256 = sourceSha256(arr(obj(verdict.source).files) as { path: string; sha256: string }[]);
  const text = JSON.stringify(verdict);
  writeFileSync(join(dir, EXAMPLE_VERDICT), text);
  obj(signoff(p).evidence).sha256 = sha(text);
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  renameSync(join(dir, EXAMPLE_PARTS_DIR), join(dir, 'derived/parts/build'));
  expect(checkProject(dir).refusals).toEqual([]);
});
test('legacy B4 without a map gets only DIFF_MAP_PREDATES', () => {
  const dir = project((s, p) => { s.at = '2026-11-05T00:00:00Z'; delete s.diff_map; p.stage = 'parts-review'; p.advances = []; });
  writeFileSync(join(dir, 'words.txt'), 'Advance the historical synthetic approval.');
  advanceCommand(['rigging', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map((f) => f.code)).toEqual(['QUESTION_SET_STALE', 'DIFF_MAP_PREDATES', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
});
test('an old sign-off with a map is checked fully', () => {
  only(project((s, p) => { s.at = '2026-11-05T00:00:00Z'; p.advances = []; obj(arr(obj(s.diff_map).components)[0]).why = ''; }), 'DIFF_MAP_STATUS');
});
test('a pre-stage legacy project still validates a map it carries while rigging', () => {
  const dir = project((s) => { obj(arr(obj(s.diff_map).components)[0]).why = ''; }, 'normal', true);
  const file = join(dir, 'project.json');
  const p = JSON.parse(readFileSync(file, 'utf8'), (_key, value: unknown) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
      return new Date(Date.parse(value) - 30 * 86_400_000).toISOString();
    }
    return value;
  }) as JsonObject;
  rehashSignoffs(p);
  writeFileSync(file, JSON.stringify(p));
  only(dir, 'DIFF_MAP_STATUS');
  expect(checkProject(dir).warnings.filter(f => f.code === 'SIGNOFF_ANSWERS_MISSING_LEGACY')).toHaveLength(2);
});
test('the latest sign-off is read', () => {
  const dir = project();
  const file = join(dir, 'project.json');
  const p = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  arr(p.signoffs).push({ ...signoff(p), at: '2026-11-12T00:00:00Z', diff_map: null });
  writeFileSync(file, JSON.stringify(p));
  only(dir, 'DIFF_MAP_REPORT');
});
test('report symlinks cannot leave the project', () => {
  const dir = project(); const path = join(dir, EXAMPLE_DIFF_REPORT);
  const target = join(tempDir(), 'outside.json');
  renameSync(path, target); symlinkSync(target, path);
  only(dir, 'DIFF_MAP_REPORT');
});
test('B5 example has no findings and generation reproduces all shipped bytes', () => {
  const report = checkProject(fixture());
  expect(report.refusals).toEqual([]); expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  const generated = generateExampleDiff(join(tempDir(), 'generated'));
  expect(generated.report).toBe(reports.normal);
  const p = JSON.parse(readFileSync(join(fixture(), 'project.json'), 'utf8')) as JsonObject;
  expect(generated.record).toEqual(obj(signoff(p).diff_map));
});

describe('writer usage and cutoff', () => {
  test.each([
    { name: 'report on interview', flags: ['interview', '--diff-report', EXAMPLE_DIFF_REPORT] },
    { name: 'component on interview', flags: ['interview', '--component', 'x=left:why'] },
    { name: 'component without report', flags: ['parts-review', '--component', 'x=left:why'] },
    { name: 'duplicate id', flags: ['parts-review', '--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'x=left:why', '--component', 'x=fixed:why'] },
    { name: 'malformed component', flags: ['parts-review', '--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'bad'] },
  ])('rejects invalid options $name', ({ flags }) => {
    const dir = project(); writeFileSync(join(dir, 'words.txt'), 'reviewed');
    const before = readFileSync(join(dir, 'project.json'));
    try {
      signoffCommand([...flags, dir, '--by', 'user', ...(flags[0] === 'parts-review' ? ['--evidence', EXAMPLE_VERDICT] : []), '--verbatim-file', join(dir, 'words.txt')]);
      throw new Error('writer accepted invalid options');
    } catch (error) { expect((error as { code: string }).code).toBe('SIGNOFF_OPTION_INVALID'); }
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
  test('from the cutoff the writer requires the report and preserves the file', () => {
    testClock.set(new Date(DIFF_MAP_SINCE));
    const dir = project(); writeFileSync(join(dir, 'words.txt'), 'reviewed');
    const before = readFileSync(join(dir, 'project.json'));
    try {
      signoffCommand(['parts-review', dir, '--by', 'user', '--evidence', EXAMPLE_VERDICT, '--verbatim-file', join(dir, 'words.txt')]);
      throw new Error('writer accepted a missing map');
    } catch (error) { expect((error as { code: string }).code).toBe('DIFF_MAP_MISSING'); }
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
});
