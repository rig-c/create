import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { checkProject, type CheckReport } from '../src/check.ts';
import { SETUP_PAINTING_SINCE } from '../src/setup-painting.ts';
import type { JsonObject } from '../src/templates.ts';
import { fixture, framing, obj, version, type Mutate } from './fixtures.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const setup = (report: CheckReport) => report.refusals.filter((f) => f.code.startsWith('SETUP_PAINTING_'));
const warnings = (report: CheckReport) => report.warnings.filter((f) => f.code.startsWith('SETUP_PAINTING_'));
const DECLARED: JsonObject = { spec: 'spine-parts-requirements/1', fps: 12, requirements: [], setup_painting: { required: true } };

/** The declaration is synthetic. No unmeasured limit is presented as a baseline. */
function project(config: JsonObject = { requirements: 'requirements.json' }, requirements: JsonObject | null = DECLARED, mutate: Mutate = () => {}): string {
  const text = json(config);
  return fixture((p) => {
    const v = version(p, 1);
    v.at = SETUP_PAINTING_SINCE;
    obj(v.provenance).config = { path: 'evidence/setup/config.json', sha256: sha(text) };
    mutate(p);
  }, 'legacy-example-project.json', {
    'evidence/setup/config.json': text,
    ...(requirements === null ? {} : { 'evidence/setup/requirements.json': json(requirements) }),
  });
}

describe('setup painting on readable retained configs', () => {
  test('the declaration is accepted without choosing limits for the user', () => {
    const report = checkProject(project());
    expect(setup(report)).toEqual([]);
    expect(warnings(report)).toEqual([]);
  });

  test('explicit synthetic limits leave declaration checking to create and limit enforcement to parts', () => {
    const report = checkProject(project(undefined, {
      ...DECLARED,
      setup_painting: { required: true, rgb_tolerance: 0, regions: [{ name: 'synthetic', box: [0, 0, 1, 1], max_pixels: 0 }] },
    }));
    expect(setup(report)).toEqual([]);
    expect(warnings(report)).toEqual([]);
  });

  test('a config naming no requirements file is refused by name', () => {
    const findings = setup(checkProject(project({})));
    expect(findings.map((f) => f.code)).toEqual(['SETUP_PAINTING_REQUIREMENTS_MISSING']);
    expect(findings[0]?.message).toContain('Write requirements in that config');
  });

  test('a missing named file is refused at its config-relative path', () => {
    expect(setup(checkProject(project(undefined, null)))[0]?.code).toBe('SETUP_PAINTING_REQUIREMENTS_MISSING');
  });

  test.each<JsonObject>([{}, { required: false }, { required: 'true' }])('a missing or non-true declaration is refused: %j', (declaration) => {
    const findings = setup(checkProject(project(undefined, { ...DECLARED, setup_painting: declaration })));
    expect(findings.map((f) => f.code)).toEqual(['SETUP_PAINTING_REQUIRED_MISSING']);
    expect(findings[0]?.message).toContain('Write that declaration in the requirements file');
  });

  test('a file with no setup_painting key is refused', () => {
    expect(setup(checkProject(project(undefined, { fps: 12, requirements: [] })))[0]?.code).toBe('SETUP_PAINTING_REQUIRED_MISSING');
  });

  test.each(['2026-11-05T23:59:59Z', 'unreadable'])('an older or undated record only warns: %s', (at) => {
    const report = checkProject(project({}, null, (p) => { version(p, 1).at = at; }));
    expect(setup(report)).toEqual([]);
    expect(warnings(report).map((f) => f.code)).toEqual(['SETUP_PAINTING_LEGACY']);
    expect(warnings(report)[0]?.message).toContain('SETUP_PAINTING_REQUIREMENTS_MISSING');
  });

  test('an old missing declaration also only warns', () => {
    const report = checkProject(project(undefined, {}, (p) => { version(p, 1).at = '2026-11-01T00:00:00Z'; }));
    expect(setup(report)).toEqual([]);
    expect(warnings(report)[0]?.message).toContain('SETUP_PAINTING_REQUIRED_MISSING');
  });

  test('pre-interview and pre-config records produce no setup finding', () => {
    for (const mutate of [
      (p: JsonObject) => { version(p, 1).pre_interview = true; },
      (p: JsonObject) => { delete obj(version(p, 1).provenance).config; },
    ]) {
      const report = checkProject(project({}, null, mutate));
      expect(setup(report)).toEqual([]);
      expect(warnings(report)).toEqual([]);
    }
  });

  test('unread or hash-mismatched configs retain their existing owner', () => {
    for (const mutate of [
      (p: JsonObject) => { obj(obj(version(p, 1).provenance).config).path = 'missing.json'; },
      (p: JsonObject) => { obj(obj(version(p, 1).provenance).config).sha256 = sha('other'); },
    ]) {
      const report = checkProject(project({}, null, mutate));
      expect(setup(report)).toEqual([]);
      expect(warnings(report)).toEqual([]);
    }
  });

  test('a requirements path outside the project is refused by the shared reader', () => {
    expect(setup(checkProject(project({ requirements: '../../../outside.json' }, null)))[0]?.code)
      .toBe('SETUP_PAINTING_REQUIREMENTS_MISSING');
  });

  test('a config without a recorded hash is still read', () => {
    expect(setup(checkProject(project({}, null, (p) => { delete obj(obj(version(p, 1).provenance).config).sha256; })))[0]?.code)
      .toBe('SETUP_PAINTING_REQUIREMENTS_MISSING');
  });

  test.each<JsonObject>([{}, { requirements: 'missing.json' }])('CG keeps one owner for the requirements path: %j', (config) => {
    const report = checkProject(project(config, null, (p) => { obj(framing(p, 'rig_type').answer).value = 'fullscreen.minimal'; }));
    const findings = report.refusals.filter((f) => f.path === 'versions[v1].provenance.config requirements');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(config.requirements ? 'CG_GATES_UNREAD' : 'CG_GATE_UNDECLARED');
    expect(setup(report)).toEqual([]);
  });

  test('CG with a readable requirements file also needs the setup declaration', () => {
    const report = checkProject(project(undefined, {}, (p) => { obj(framing(p, 'rig_type').answer).value = 'fullscreen.minimal'; }));
    expect(setup(report)[0]?.code).toBe('SETUP_PAINTING_REQUIRED_MISSING');
  });

  test('the filled example remains at zero refusals and warnings', () => {
    const report = checkProject(fixture());
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY']);
  });

  test('the normal interview CLI reports the named refusal', () => {
    const result = cli(['interview', '--check', project({}), '--json'], tempDir(), gitEnv());
    expect(result.code).toBe(1);
    expect(setup(JSON.parse(result.stdout) as CheckReport)[0]?.code).toBe('SETUP_PAINTING_REQUIREMENTS_MISSING');
  });
});
