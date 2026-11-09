import { preparePartsApproval } from './parts-receipt-fixture.ts';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { generateExampleDiff } from '../scripts/generate-example-diff.ts';
import { deriveDiffClasses, expandDiffTriage, diffClassesCommand } from '../src/diff-classes.ts';
import { DIFF_MAP_AGENT_SINCE, DIFF_MAP_SINCE } from '../src/diff-map.ts';
import { diffStackCandidates } from '../src/diff-map.ts';
import { acquireJobLock, enqueuePublication, JOB_BINDING_FILE, jobPrivateRoot, readWriterBinding, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_DIFF_REPORT, generateDiffFixture } from './diff-fixture.ts';
import { arr, fixture, historicalFixture, obj, rehashSignoffs, retimeFixture } from './fixtures.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
const EXAMPLE_PARTS_DIR = 'derived/drafts/receipt-fixture/input/rig';
const RECEIPT_FLAGS = ['--draft', 'receipt-fixture', '--structure-file', 'evidence/receipt-fixture-structure.json'];
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
  const dir = materialize((p) => {
    rigging(p);
    const s = signoff(p);
    const baseMap: JsonObject = {
      report: { path: EXAMPLE_DIFF_REPORT, sha256: sha(report) },
      components: (JSON.parse(report) as { components: { id: string }[] }).components.map((c) => ({ id: c.id, status: 'left', why: 'the synthetic difference is accepted' })),
    };
    if (historical) {
      s.diff_map = baseMap;
    } else {
      delete s.diff_map;
      p.diff_map = {
        by: 'agent',
        at: String(s.at ?? '2026-11-09T00:00:00Z'),
        ...baseMap,
      };
    }
    edit(s, p);
  }, 'legacy-example-project.json', { [EXAMPLE_DIFF_REPORT]: report });
  preparePartsApproval(dir, historical ? Date.parse('2026-11-05T00:00:00Z') : testClock.now());
  return dir;
}
function componentFlags(dir: string): string[] {
  const report = JSON.parse(readFileSync(join(dir, EXAMPLE_DIFF_REPORT), 'utf8')) as { components: { id: string }[] };
  return report.components.flatMap((c, i) => ['--component', `${c.id}=${['in-painting', 'fixed', 'left'][i % 3]}:observed: synthetic difference`]);
}
function writer(dir: string, flags = componentFlags(dir)) {
  return cli(['diff-classes', dir, '--diff-report', EXAMPLE_DIFF_REPORT, ...flags, '--by', 'agent', '--json'], dir, gitEnv());
}
function only(dir: string, code: string): string {
  const report = checkProject(dir);
  expect(report.refusals.map((f) => f.code)).toEqual([code]);
  const finding = report.refusals[0]!;
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
    const classified = JSON.parse(result.stdout) as JsonObject;
    expect(obj(classified.diff_map).by).toBe('agent');
    expect(arr(obj(classified.diff_map).components)).toHaveLength(2);
    expect(obj(arr(obj(classified.diff_map).components)[0]).why).toBe('observed: synthetic difference');
    writeFileSync(join(dir, 'words.txt'), 'reviewed the synthetic assembly');
    const signResult = cli(['signoff', 'parts-review', '--by', 'user', ...RECEIPT_FLAGS, '--verbatim-file', join(dir, 'words.txt'), '--json'], dir, gitEnv());
    expect(signResult.code).toBe(0);
    const signed = JSON.parse(signResult.stdout) as JsonObject;
    expect(signed.diff_map).toBeUndefined();
    // Signed after STAGE_PROGRESS_SINCE, the lagging stage is a refusal until advance moves it.
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_LAGGING');
    advanceCommand(['rigging', dir]);
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'DRAFT_PRODUCER_ASSUMED', 'FIX_LEDGER_MISSING', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
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
  const dir = project((_s, p) => { obj(p.diff_map).components = arr(obj(p.diff_map).components).slice(1); });
  expect(only(dir, 'DIFF_MAP_COMPONENT_UNLISTED')).toContain('p10-n3');
  const before = readFileSync(join(dir, 'project.json'));
  const result = writer(dir, componentFlags(dir).slice(2));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('DIFF_MAP_COMPONENT_UNLISTED');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});
test('B1b unknown id', () => {
  only(project((_s, p) => { arr(obj(p.diff_map).components).push({ id: 'extra', status: 'left', why: 'synthetic' }); }), 'DIFF_MAP_COMPONENT_UNKNOWN');
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

test('B3 absent diff_map', () => { only(project((_s, p) => { delete p.diff_map; }), 'DIFF_MAP_MISSING'); });
test('B3 wrong report hash', () => {
  only(project((_s, p) => { obj(obj(p.diff_map).report).sha256 = '0'.repeat(64); }), 'DIFF_MAP_REPORT');
});
test.each(['spec', 'shape', 'json', 'duplicate'])('B3 bad report %s', (kind) => {
  const parsed = JSON.parse(reports.normal) as JsonObject;
  if (kind === 'spec') parsed.spec = 'other';
  if (kind === 'shape') delete parsed.definition;
  if (kind === 'duplicate') arr(parsed.components).push(arr(parsed.components)[0]);
  const text = kind === 'json' ? '{' : JSON.stringify(parsed);
  const dir = project((_s, p) => { obj(obj(p.diff_map).report).sha256 = sha(text); });
  writeFileSync(join(dir, EXAMPLE_DIFF_REPORT), text);
  only(dir, 'DIFF_MAP_REPORT');
});
test('B3 report absent', () => {
  const dir = project(); rmSync(join(dir, EXAMPLE_DIFF_REPORT)); only(dir, 'DIFF_MAP_REPORT');
});
test.each(['left', 'fixed', 'in-painting'])('B3 empty why for %s', (status) => {
  only(project((_s, p) => { const c = obj(arr(obj(p.diff_map).components)[0]); c.status = status; c.why = '  '; }), 'DIFF_MAP_STATUS');
});
test('B3 bad status', () => {
  only(project((_s, p) => { obj(arr(obj(p.diff_map).components)[0]).status = 'accepted'; }), 'DIFF_MAP_STATUS');
});
test('duplicate sign-off id is refused', () => {
  only(project((_s, p) => { arr(obj(p.diff_map).components).push(arr(obj(p.diff_map).components)[0]); }), 'DIFF_MAP_STATUS');
});
test('neither stack candidate names both paths', () => {
  const dir = project(); rmSync(join(dir, EXAMPLE_PARTS_DIR, 'recomposite_rig.png'));
  const message = only(dir, 'DIFF_MAP_STACK_MISMATCH');
  expect(message).toContain(`${EXAMPLE_PARTS_DIR}/recomposite_rig.png`);
  expect(message).toContain('derived/drafts/receipt-fixture/input/render/recomposite_rig.png');
});
test('both stack candidates are ambiguous', () => {
  const dir = project();
  const alternate = join(dir, 'derived/drafts/receipt-fixture/input/render/recomposite_rig.png');
  mkdirSync(dirname(alternate), { recursive: true });
  writeFileSync(alternate, readFileSync(join(dir, EXAMPLE_PARTS_DIR, 'recomposite_rig.png')));
  expect(only(dir, 'DIFF_MAP_STACK_MISMATCH')).toContain('ambiguous');
});
test('a directory not named rig has only the build candidate', () => {
  expect(diffStackCandidates('/synthetic/build/parts.json')).toEqual(['/synthetic/build/recomposite_rig.png']);
});
test('legacy B4 without a map gets only DIFF_MAP_PREDATES', () => {
  const dir = project((s, p) => { s.at = '2026-11-05T00:00:00Z'; delete s.diff_map; delete p.diff_map; p.stage = 'parts-review'; p.advances = []; });
  writeFileSync(join(dir, 'words.txt'), 'Advance the historical synthetic approval.');
  advanceCommand(['rigging', dir]);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map((f) => f.code)).toEqual(['QUESTION_SET_STALE', 'DRAFT_PRODUCER_ASSUMED', 'FIX_LEDGER_MISSING', 'DIFF_MAP_PREDATES', 'STAGE_MOVE_UNLINKED', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
});
test('an old sign-off with a map emits DIFF_MAP_ON_SIGNOFF_LEGACY and is checked fully', () => {
  const dir = project((s, p) => {
    s.at = '2026-11-05T00:00:00Z';
    const { by: _by, at: _at, ...legacyMap } = obj(p.diff_map);
    s.diff_map = legacyMap;
    delete p.diff_map;
    p.advances = [];
    obj(arr(obj(s.diff_map).components)[0]).why = '';
  });
  only(dir, 'DIFF_MAP_STATUS');
  expect(checkProject(dir).warnings.map(f => f.code)).toContain('DIFF_MAP_ON_SIGNOFF_LEGACY');
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
test('a post-DIFF_MAP_AGENT_SINCE sign-off carrying diff_map is refused with SIGNOFF_DIFF_MAP_REMOVED', () => {
  const dir = project();
  const file = join(dir, 'project.json');
  const p = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  arr(p.signoffs).push({ ...signoff(p), at: '2026-11-12T00:00:00Z', diff_map: p.diff_map! });
  writeFileSync(file, JSON.stringify(p));
  only(dir, 'SIGNOFF_DIFF_MAP_REMOVED');
});
test('report symlinks cannot leave the project', () => {
  const dir = project(); const path = join(dir, EXAMPLE_DIFF_REPORT);
  const target = join(tempDir(), 'outside.json');
  renameSync(path, target); symlinkSync(target, path);
  only(dir, 'DIFF_MAP_REPORT');
});
test('B5 example has no findings and generation reproduces all shipped bytes', () => {
  const report = checkProject(fixture());
  expect(report.refusals).toEqual([]); expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'PARTS_VERDICT_FILE_LEGACY', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  const generated = generateExampleDiff(join(tempDir(), 'generated'));
  expect(generated.report).toBe(reports.normal);
  const p = JSON.parse(readFileSync(join(fixture(() => {}, 'example-project.json'), 'project.json'), 'utf8')) as JsonObject;
  expect(generated.record).toEqual(obj(p.diff_map));
});

describe('writer usage and cutoff', () => {
  test.each([
    { name: 'report on interview', flags: ['interview', '--diff-report', EXAMPLE_DIFF_REPORT], code: 'SIGNOFF_OPTION_INVALID' },
    { name: 'component on interview', flags: ['interview', '--component', 'x=left:why'], code: 'SIGNOFF_OPTION_INVALID' },
    { name: 'report on parts-review', flags: ['parts-review', '--diff-report', EXAMPLE_DIFF_REPORT], code: 'SIGNOFF_DIFF_MAP_REMOVED' },
    { name: 'component on parts-review', flags: ['parts-review', '--component', 'x=left:why'], code: 'SIGNOFF_DIFF_MAP_REMOVED' },
    { name: 'triage-file on parts-review', flags: ['parts-review', '--triage-file', 'triage.json'], code: 'SIGNOFF_DIFF_MAP_REMOVED' },
  ])('signoff rejects $name with $code and leaves project.json byte-identical', ({ flags, code }) => {
    const dir = project(); writeFileSync(join(dir, 'words.txt'), 'reviewed');
    const before = readFileSync(join(dir, 'project.json'));
    try {
      signoffCommand([...flags, dir, '--by', 'user', ...(flags[0] === 'parts-review' ? RECEIPT_FLAGS : []), '--verbatim-file', join(dir, 'words.txt')]);
      throw new Error('writer accepted invalid options');
    } catch (error) { expect((error as { code: string }).code).toBe(code); }
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
  test.each([
    { name: 'duplicate id', flags: ['--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'x=left:why', '--component', 'x=fixed:why', '--by', 'agent'], code: 'DIFF_MAP_STATUS' },
    { name: 'malformed component', flags: ['--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'bad', '--by', 'agent'], code: 'DIFF_MAP_STATUS' },
    { name: 'non-agent --by user', flags: ['--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'p10-n3=left:why', '--component', 'p1000-n3=left:why', '--by', 'user'], code: 'DIFF_MAP_NOT_AGENT' },
  ])('diff-classes rejects $name with $code and leaves project.json byte-identical', ({ flags, code }) => {
    const dir = project();
    const before = readFileSync(join(dir, 'project.json'));
    try {
      diffClassesCommand([dir, ...flags]);
      throw new Error('diff-classes accepted invalid options');
    } catch (error) { expect((error as { code: string }).code).toBe(code); }
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
  test('check refuses project.diff_map when by is not agent', () => {
    const dir = project((_s, p) => { obj(p.diff_map).by = 'user'; });
    only(dir, 'DIFF_MAP_NOT_AGENT');
  });
  test('from the cutoff signoff parts-review requires project.diff_map and preserves the file when missing', () => {
    testClock.set(new Date(DIFF_MAP_AGENT_SINCE));
    const dir = project((_s, p) => { delete p.diff_map; });
    writeFileSync(join(dir, 'words.txt'), 'reviewed');
    const before = readFileSync(join(dir, 'project.json'));
    try {
      signoffCommand(['parts-review', dir, '--by', 'user', ...RECEIPT_FLAGS, '--verbatim-file', join(dir, 'words.txt')]);
      throw new Error('writer accepted a missing map');
    } catch (error) { expect((error as { code: string }).code).toBe('DIFF_MAP_MISSING'); }
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
});


describe('class triage from measured producer properties', () => {
  function inventory() {
    const report = JSON.parse(reports.normal);
    const seed = report.components[0];
    report.components = Array.from({ length: 400 }, (_, i) => ({ ...seed, id: `synthetic-${i}`, px: 100,
      coverage: i < 200 ? 'covered' : 'mixed', uncovered_px: i < 200 ? 0 : i % 2 ? 24 : 25,
      borders: [{ part: i < 300 ? 'panel' : 'trim', px: 2 }] }));
    return report;
  }
  function decisions(report: unknown, why?: string) {
    return { classes: Object.fromEntries(deriveDiffClasses(report).map(c => [c.id, { status: 'left', why: why ?? `${c.key.coverage_band}: inspected the synthetic edge` }])) };
  }
  function prepared() {
    const report = inventory(), text = JSON.stringify(report), dir = project();
    writeFileSync(join(dir, EXAMPLE_DIFF_REPORT), text);
    const file = join(dir, 'triage.json');
    writeFileSync(file, JSON.stringify(decisions(report)));
    return { report, text, dir, file };
  }
  test('400 components expand exhaustively through the writer and read command', () => {
    const { report, dir, file } = prepared();
    const classes = deriveDiffClasses(report);
    expect(classes).toHaveLength(5);
    expect(deriveDiffClasses({ ...report, components: [...report.components].reverse() })).toEqual(classes);
    const read = diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT]);
    expect(read.exit).toBe(0);
    expect(JSON.parse(read.stdout).reduce((n: number, c: {member_count: number}) => n + c.member_count, 0)).toBe(400);
    const result = writer(dir, ['--triage-file', file]);
    expect(result.code).toBe(0);
    const map = obj((JSON.parse(result.stdout) as JsonObject).diff_map);
    expect(arr(map.components)).toHaveLength(400);
    expect(arr(map.classes)).toHaveLength(5);
    expect(checkProject(dir).refusals).toEqual([]);
  });
  test('generic why is refused by the writer with unchanged project bytes', () => {
    const { report, dir, file } = prepared();
    writeFileSync(file, JSON.stringify(decisions(report, 'the difference is acceptable')));
    const before = readFileSync(join(dir, 'project.json'));
    const result = writer(dir, ['--triage-file', file]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DIFF_MAP_CLASS_WHY');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
  test('a border-part observation satisfies specificity for a mixed band', () => {
    const report = inventory();
    const input = { classes: Object.fromEntries(deriveDiffClasses(report).map(c => [c.id, { status: 'in-painting', why: `${c.key.border_parts[0]} edge exists in the painting` }])) };
    expect(arr(expandDiffTriage(report, input, 'diff_map').components)).toHaveLength(400);
  });
  test.each(['members', 'key', 'unknown', 'status'])('refuses supplied %s rather than trusting the caller', (kind) => {
    const report = inventory(), input = decisions(report);
    const id = Object.keys(input.classes)[0];
    if (kind === 'unknown') input.classes.other = input.classes[id];
    else Object.assign(input.classes[id], kind === 'status' ? { status: 'accepted' } : { [kind]: [] });
    try { expandDiffTriage(report, input, 'diff_map'); throw new Error('accepted'); }
    catch (error) { expect((error as {code: string}).code).toBe('DIFF_MAP_TRIAGE'); }
  });
  test.each(['foreign member', 'spread', 'status', 'why', 'orphan', 'duplicate', 'missing class'])('check refuses planted %s', (kind) => {
    const { dir, file } = prepared();
    expect(writer(dir, ['--triage-file', file]).code).toBe(0);
    const path = join(dir, 'project.json'), p = JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
    const map = obj(p.diff_map), classes = arr(map.classes).map(obj), c = classes[0];
    const member = arr(map.components).map(obj).find(m => m.class_id === c.id)!;
    if (kind === 'foreign member') (c.members as string[])[0] = (classes[1].members as string[])[0];
    if (kind === 'spread') obj(c.key).coverage_band = 'mixed:0.00-1.00';
    if (kind === 'status') member.status = 'fixed';
    if (kind === 'why') { c.why = 'looks fine'; for (const m of arr(map.components).map(obj)) if (m.class_id === c.id) m.why = c.why; }
    if (kind === 'orphan') member.class_id = 'class-absent';
    if (kind === 'duplicate') arr(map.classes).push(c);
    if (kind === 'missing class') delete map.classes;
    writeFileSync(path, JSON.stringify(p));
    expect(checkProject(dir).refusals.map(f => f.code)).toContain(kind === 'why' ? 'DIFF_MAP_CLASS_WHY' : 'DIFF_MAP_CLASS');
  });
  test('per-member input can replace a class, but overlapping decisions refuse before writing', () => {
    const { report, dir, file } = prepared(), input = decisions(report);
    const id = Object.keys(input.classes)[0], group = deriveDiffClasses(report).find(c => c.id === id)!;
    const components = Object.fromEntries(group.members.map(id => [id, {status: 'fixed', why: 'individual synthetic repair'}]));
    delete input.classes[id];
    writeFileSync(file, JSON.stringify({ ...input, components }));
    expect(writer(dir, ['--triage-file', file]).code).toBe(0);
    writeFileSync(file, JSON.stringify({ ...decisions(report), components }));
    const before = readFileSync(join(dir, 'project.json'));
    const result = writer(dir, ['--triage-file', file]);
    expect(result.code).toBe(1); expect(result.stderr).toContain('DIFF_MAP_STATUS');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
  test('bound job lock and pending publication gate diff-classes writer while keeping read-only mode unlocked', () => {
    const { dir, file } = prepared();
    const jobId = 'synthetic-diff-classes-job';
    const identity = currentJobIdentity(
      { root: dir, stateDir: 'unused-private-state', fingerprint: 'synthetic', reviewer: { id: 'synthetic-owner', role: 'owner' } },
      dir,
    );
    writePrivateJson(
      join(realpathSync(dir), JOB_BINDING_FILE),
      { schema: 'rig-create/job-binding@1', identity, jobId, origin: 'http://127.0.0.1:43123', fetchCapability: 'synthetic-read-grant' },
      true,
    );
    const projectPath = join(dir, 'project.json');
    const p = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
    delete p.diff_map;
    p.review_job = { jobId, origin: 'http://127.0.0.1:43123' };
    writeFileSync(projectPath, `${JSON.stringify(p, null, 2)}\n`);
    const before = readFileSync(projectPath);

    // 1. When another bound writer holds the job lock, writer refuses with JOB_WRITE_BUSY and leaves project.json byte-identical; read-only mode still works.
    const release = acquireJobLock(dir)!;
    try {
      expect(diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT]).exit).toBe(0);
      const busy = writer(dir, ['--triage-file', file]);
      expect(busy.code).toBe(1);
      expect(busy.stderr).toContain('JOB_WRITE_BUSY');
      expect(readFileSync(projectPath)).toEqual(before);
    } finally {
      release();
    }

    // 2. When a committed publication is pending in the outbox, writer refuses with JOB_PUBLISH_PENDING and leaves project.json byte-identical; read-only mode still works.
    enqueuePublication(dir, readWriterBinding(dir)!, {
      path: 'review-draft-receipt-fixture.json',
      selector: { kind: 'draft', id: 'receipt-fixture' },
    });
    expect(diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT]).exit).toBe(0);
    const pending = writer(dir, ['--triage-file', file]);
    expect(pending.code).toBe(1);
    expect(pending.stderr).toContain('JOB_PUBLISH_PENDING');
    expect(readFileSync(projectPath)).toEqual(before);

    // 3. Once the pending publication is cleared, the bound writer succeeds and records project.diff_map.
    rmSync(jobPrivateRoot(dir), { recursive: true, force: true });
    const succeeded = writer(dir, ['--triage-file', file]);
    expect(succeeded.code).toBe(0);
    const after = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
    expect(obj(after.diff_map).by).toBe('agent');
    expect(arr(obj(after.diff_map).components)).toHaveLength(400);
    expect(checkProject(dir).refusals).toEqual([]);
  });
});
