import { resignAfterChange } from './fixtures.ts';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { repackageFixtureVersion } from './review-fixture.ts';
import { checkProject, type CheckReport } from '../src/check.ts';
import { FIGURE_MASK_SINCE } from '../src/figure-mask.ts';
import { reviewCommand } from '../src/feedback.ts';
import { handoff } from '../src/review.ts';
import { signoffCommand } from '../src/signoff.ts';
import { derivedCommand } from '../src/prepared-inputs.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, version, waypoint, type Mutate } from './fixtures.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const findings = (report: CheckReport) => [...report.refusals, ...report.warnings].filter((f) => f.code.startsWith('FIGURE_MASK_'));
// Opaque synthetic bytes exercise binding only. PNG validity is parts' contract.
const mask = 'synthetic figure support';
function project(setup: JsonObject = { figure_mask: { path: 'figure.png', sha256: sha(mask) } }, mutate: Mutate = () => {}, ground = 'busy'): string {
  const config = json({ assemble: { project: 'visible', ground }, requirements: 'requirements.json' });
  return repackageFixtureVersion(fixture((p) => {
    const guide = obj(waypoint(p, 'assemble').guide);
    obj(guide.value).ground = ground;
    arr(guide.asks).push({ id: 'ground', state: 'user' });
    const v = version(p, 1);
    v.at = FIGURE_MASK_SINCE;
    obj(v.provenance).config = { path: 'evidence/mask/config.json', sha256: sha(config) };
    p.derived = [{ kind: 'prepared-input', path: 'evidence/mask/figure.png', sha256: sha(mask), source: { path: 'painting.txt', sha256: sha('original') }, operation: 'Synthetic matte alpha >= 128 minus no foreground plane' }];
    mutate(p);
  }, 'legacy-example-project.json', {
    'evidence/mask/config.json': config,
    'evidence/mask/requirements.json': json({ setup_painting: { required: true, ...setup } }),
    'evidence/mask/figure.png': mask,
    'painting.txt': 'original',
    'foreground.txt': 'foreground',
  }), 1);
}

describe('figure mask declaration and provenance', () => {
  test('declared and recorded busy mask has no mask findings', () => {
    const report = checkProject(resignAfterChange(project()));
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });
  test('missing declaration refuses at the retained version', () => {
    expect(findings(checkProject(project({}))).map((f) => f.code)).toEqual(['FIGURE_MASK_MISSING']);
  });
  test.each([
    { path: 'figure.png', sha256: sha('wrong') },
    { path: 'absent.png', sha256: sha(mask) },
  ])('wrong or missing mask bytes refuse packaging: %j', figure_mask => {
    let error: unknown;
    try { project({ figure_mask }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe('FIGURE_MASK_CHANGED');
  });
  test('unrecorded mask refuses', () => {
    expect(findings(checkProject(project(undefined, (p) => { p.derived = []; }))).map((f) => f.code)).toEqual(['FIGURE_MASK_UNRECORDED']);
  });
  test.each(['2026-11-05T23:59:59Z', 'undated'])('older declarations warn: %s', (at) => {
    const report = checkProject(project({}, (p) => { version(p, 1).at = at; }));
    expect(findings(report).map((f) => f.code)).toEqual(['FIGURE_MASK_LEGACY']);
    expect(report.refusals.some((f) => f.code.startsWith('FIGURE_MASK_'))).toBe(false);
  });
  test.each<JsonObject>([{}, { path: 'figure.png' }, { path: '', sha256: sha(mask) }])('malformed declarations refuse: %j', (figure_mask) => {
    try { project({ figure_mask }); throw new Error('packaging succeeded'); } catch (error) { expect((error as Refusal).code).toBe('FIGURE_MASK_MISSING'); }
  });
  test.each<JsonObject>([{ sources: [] }, { sources: [{}] }])('missing or malformed provenance sources refuse: %j', ({ sources }) => {
    const report = checkProject(project(undefined, (p) => {
      const entry = obj(arr(p.derived)[0]);
      delete entry.source;
      entry.sources = sources;
    }));
    expect(findings(report).map((f) => f.code)).toEqual(['FIGURE_MASK_UNRECORDED']);
    expect(report.refusals.some((f) => f.code === 'DERIVED_MALFORMED')).toBe(true);
  });
  test('pre-interview records skip the declaration', () => {
    expect(findings(checkProject(project({}, (p) => { version(p, 1).pre_interview = true; })))).toEqual([]);
  });
  test('plain ground produces no mask finding', () => {
    expect(findings(checkProject(project({}, () => {}, 'plain')))).toEqual([]);
  });
  test('multiple sources bind each input and retain mask acceptance', () => {
    const dir = project(undefined, (p) => { p.derived = []; });
    derivedCommand(['add', dir, '--source', 'painting.txt', '--source', 'foreground.txt', '--file', 'evidence/mask/figure.png', '--operation', 'Synthetic matte alpha >= 128 minus foreground plane']);
    const report = checkProject(dir);
    expect(findings(report)).toEqual([]);
    expect(report.refusals.filter((f) => f.code.startsWith('DERIVED_'))).toEqual([]);
    writeFileSync(join(dir, 'foreground.txt'), 'changed');
    expect(checkProject(dir).refusals.some((f) => f.code === 'DERIVED_FILE_CHANGED' && f.path === 'derived[0].sources[1].sha256')).toBe(true);
  });
  test('a later source cannot name the result itself', () => {
    const dir = project();
    const file = join(dir, 'project.json');
    const before = readFileSync(file);
    expect(() => derivedCommand(['add', dir, '--source', 'painting.txt', '--source', 'evidence/mask/figure.png', '--file', 'evidence/mask/figure.png', '--operation', 'Synthetic matte'])).toThrow();
    expect(readFileSync(file)).toEqual(before);
  });
  test('refused multi-source writer preserves project bytes', () => {
    const dir = project();
    const file = join(dir, 'project.json');
    const before = readFileSync(file);
    expect(() => derivedCommand(['add', dir, '--source', 'painting.txt', '--source', 'missing.txt', '--file', 'evidence/mask/figure.png', '--operation', 'Synthetic matte alpha >= 128 minus none'])).toThrow();
    expect(readFileSync(file)).toEqual(before);
  });
});

function changeRecord(dir: string, mutate: Mutate): void {
  const file = join(dir, 'project.json');
  const value = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  mutate(value);
  writeFileSync(file, json(value));
}

const states = ['honest', 'altered', 'missing'] as const;
for (const input of ['requirements.json', 'figure.png']) {
  for (const frozen of states) {
    test.each(states)(`${input}: frozen ${frozen}, live %s`, live => {
      const dir = project();
      const frozenPath = join(dir, 'derived/review/v1', input);
      const livePath = join(dir, 'evidence/mask', input);
      for (const [path, state] of [[frozenPath, frozen], [livePath, live]] as const) {
        if (state === 'altered') writeFileSync(path, input === 'figure.png' ? 'different matte bytes' : json({ setup_painting: { figure_mask: { path: 'other.png', sha256: sha('other bytes') } } }));
        if (state === 'missing') rmSync(path);
      }
      const report = checkProject(dir);
      expect(findings(report)).toEqual([]);
      expect(report.refusals.some(f => f.code === 'REVIEW_PACKAGE_CHANGED')).toBe(frozen !== 'honest');
    });
  }
}

test.each(['requirements.json', 'figure.png'])('a removed frozen %s binding has an era-specific finding', input => {
  for (const at of [FIGURE_MASK_SINCE, '2026-11-05T23:59:59Z']) {
    const dir = project(undefined, p => { version(p, 1).at = at; });
    // Remove an existing binding after the real packager produced it.
    rmSync(join(dir, 'derived/review/v1', input));
    changeRecord(dir, p => {
      const pkg = obj(version(p, 1).review_package);
      pkg.files = arr(pkg.files).filter(f => obj(f).path !== input);
    });
    const report = checkProject(dir);
    expect(findings(report).map(f => f.code)).toEqual([at === FIGURE_MASK_SINCE ? 'FIGURE_MASK_INPUT_UNBOUND' : 'FIGURE_MASK_INPUTS_LEGACY']);
  }
});

test.each(['record', 'directory'])('an unpackaged new-era version has no mask verdict when %s is absent', missing => {
  const dir = project({});
  if (missing === 'record') changeRecord(dir, p => { delete version(p, 1).review_package; });
  else rmSync(join(dir, 'derived/review/v1'), { recursive: true });
  const report = checkProject(dir);
  expect(findings(report)).toEqual([]);
  expect(report.warnings.some(f => f.code === 'REVIEW_PACKAGE_MISSING' && f.path === 'versions[v1].review_package')).toBe(true);
});

test('post versions do not receive a rig figure-mask verdict', () => {
  const dir = project({});
  changeRecord(dir, p => { version(p, 1).kind = 'post'; });
  expect(findings(checkProject(dir))).toEqual([]);
});

test('equal mask bytes at a different original locator do not count as prepared input', () => {
  const dir = project(undefined, p => { obj(arr(p.derived)[0]).path = 'another/figure.png'; });
  expect(findings(checkProject(dir)).map(f => f.code)).toEqual(['FIGURE_MASK_UNRECORDED']);
});

test('the nested mask is retained without joining handoff named inputs', async () => {
  const dir = project();
  const value = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const record = obj(version(value, 1).review_package);
  expect(arr(record.files).some(f => obj(f).path === 'figure.png')).toBe(true);
  const { reviewHandoffInputs } = await import('../src/review-package.ts');
  expect(reviewHandoffInputs(record, dir, 1).some(f => f.path === 'figure.png')).toBe(false);
});

test.each(['unrecorded', 'requirements.json', 'figure.png'])('check, acceptance, signoff and handoff share the frozen mask finding: %s', missing => {
  const dir = project(undefined, p => {
    if (missing === 'unrecorded') p.derived = [];
    version(p, 1).verdicts = [{ review: 'rig-review', verdict: 'accepted', by: 'user', at: FIGURE_MASK_SINCE, verbatim: 'Accept synthetic rig' }];
  });
  if (missing !== 'unrecorded') {
    rmSync(join(dir, 'derived/review/v1', missing));
    changeRecord(dir, p => {
      const pkg = obj(version(p, 1).review_package);
      pkg.files = arr(pkg.files).filter(f => obj(f).path !== missing);
    });
  }
  const code = missing === 'unrecorded' ? 'FIGURE_MASK_UNRECORDED' : 'FIGURE_MASK_INPUT_UNBOUND';
  expect(findings(checkProject(dir)).map(f => f.code)).toEqual([code]);
  writeFileSync(join(dir, 'words.txt'), 'Approve synthetic rig');
  const before = readFileSync(join(dir, 'project.json'));
  const operations = [
    () => reviewCommand(['1', dir, '--review', 'rig-review', '--verdict', 'accepted', '--by', 'user', '--verbatim-file', join(dir, 'words.txt'), '--source', 'synthetic control']),
    () => signoffCommand(['rig-review', dir, '--version', '1', '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]),
    () => handoff(dir, 1),
  ];
  for (const operation of operations) {
    let error: unknown;
    try { operation(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  }
});

for (const legacy of [false, true]) {
  test(`an unavailable file-declarations export follows the ${legacy ? 'legacy' : 'current'} package diagnostic`, () => {
    const dir = project(undefined, p => { if (legacy) version(p, 1).at = '2026-11-05T23:59:59Z'; });
    const installed = join(dir, 'node_modules/@rig-c/parts');
    mkdirSync(join(installed, 'src'), { recursive: true });
    writeFileSync(join(installed, 'package.json'), json({ name: '@rig-c/parts', version: '2.8.0', type: 'module' }));
    writeFileSync(join(installed, 'src/config.ts'), 'export const CONFIG_SECTIONS = ["assemble"];');
    const report = checkProject(dir);
    expect(findings(report)).toEqual([]);
    expect((legacy ? report.warnings : report.refusals).some(f => f.code === 'REVIEW_PACKAGE_INPUT_INVALID' && f.path === 'versions[v1].review_package')).toBe(true);
  });
}

test('repointing the live declaration cannot authorize a mask omitted from the frozen package', () => {
  const dir = resignAfterChange(project(undefined, p => {
    arr(p.derived).push({ kind: 'prepared-input', path: 'foreground.txt', sha256: sha('foreground'), source: { path: 'painting.txt', sha256: sha('original') }, operation: 'Synthetic alternate matte' });
  }));
  expect(checkProject(dir).refusals).toEqual([]);
  rmSync(join(dir, 'derived/review/v1/figure.png'), { force: true });
  changeRecord(dir, p => {
    const pkg = obj(version(p, 1).review_package);
    pkg.files = arr(pkg.files).filter(f => obj(f).path !== 'figure.png');
  });
  writeFileSync(join(dir, 'evidence/mask/requirements.json'), json({ setup_painting: { required: true, figure_mask: { path: '../../foreground.txt', sha256: sha('foreground') } } }));
  expect(findings(checkProject(dir)).map(f => f.code)).toEqual(['FIGURE_MASK_INPUT_UNBOUND']);
});
