import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkProject, type CheckReport } from '../src/check.ts';
import { FIGURE_MASK_SINCE } from '../src/figure-mask.ts';
import { derivedCommand } from '../src/prepared-inputs.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, version, waypoint, type Mutate } from './fixtures.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const findings = (report: CheckReport) => [...report.refusals, ...report.warnings].filter((f) => f.code.startsWith('FIGURE_MASK_'));
// Opaque synthetic bytes exercise binding only. PNG validity is parts' contract.
const mask = 'synthetic figure support';
function project(setup: JsonObject = { figure_mask: { path: 'figure.png', sha256: sha(mask) } }, mutate: Mutate = () => {}, ground = 'busy'): string {
  const config = json({ assemble: { project: 'visible', ground }, requirements: 'requirements.json' });
  return fixture((p) => {
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
  });
}

describe('figure mask declaration and provenance', () => {
  test('declared and recorded busy mask has no mask findings', () => {
    const report = checkProject(project());
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });
  test('missing declaration refuses at the retained version', () => {
    expect(findings(checkProject(project({}))).map((f) => f.code)).toEqual(['FIGURE_MASK_MISSING']);
  });
  test('wrong bytes and missing bytes refuse', () => {
    expect(findings(checkProject(project({ figure_mask: { path: 'figure.png', sha256: sha('wrong') } }))).map((f) => f.code)).toEqual(['FIGURE_MASK_CHANGED']);
    expect(findings(checkProject(project({ figure_mask: { path: 'absent.png', sha256: sha(mask) } }))).map((f) => f.code)).toEqual(['FIGURE_MASK_CHANGED']);
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
    expect(findings(checkProject(project({ figure_mask }))).map((f) => f.code)).toEqual(['FIGURE_MASK_MISSING']);
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
