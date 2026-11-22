import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CG_BOUNDARY_ALLOWANCE, CG_DECLARATIONS } from '../src/cg-gates.ts';
import { SETUP_PAINTING_DECLARATION } from '../src/setup-painting.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkVersionDeclarations, type DeclarationReport } from '../src/version-declarations.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { fixture, framing, obj, type Mutate } from './fixtures.ts';
import { rigVersionCommand, testClock } from './clock.ts';

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const asScene: Mutate = (p) => { obj(framing(p, 'rig_type').answer).value = 'fullscreen.minimal'; };

/** A synthetic CG config with one cited and one uncited section. */
const CONFIG: JsonObject = {
  key: 'keeper',
  assemble: { editor_receipts: { trace_parts: true, receipts: [] } },
  limbs: { cut: 'joints' },
  requirements: 'requirements.json',
};
const REQUIREMENTS: JsonObject = {
  spec: 'spine-parts-requirements/1', fps: 12, requirements: [],
  setup_painting: { required: true },
  seam_over_motion: { required: true },
  boundary_colour: { max_step_excess: CG_BOUNDARY_ALLOWANCE },
  behind_seams: { threshold: CG_BOUNDARY_ALLOWANCE },
};
const ASSEMBLE = [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }];
const LIMBS = [{ entry: 'arm_l, arm_r', guide: 'assemble', quote: 'Standard cut, at the joints.', asks: ['cut'] }];
const COMPLETE_CITATIONS: JsonObject = { assemble: ASSEMBLE, limbs: LIMBS };

/** The pilot's three stops at once: an uncited section, no behind-seam threshold, no setup-painting declaration. */
function missingAllThree(): { requirements: JsonObject; citations: JsonObject } {
  const { behind_seams: _b, setup_painting: _s, ...requirements } = REQUIREMENTS;
  return { requirements, citations: { assemble: ASSEMBLE } };
}

function project(requirements: JsonObject | null, citations: JsonObject, config: JsonObject = CONFIG, mutate: Mutate = asScene): string {
  return fixture(mutate, 'legacy-example-project.json', {
    'work/config.json': json(config),
    ...(requirements === null ? {} : { 'work/requirements.json': json(requirements) }),
    'work/citations.json': json(citations),
  });
}

const preflight = (dir: string, extra: string[] = []): { stdout: string; exit: number } =>
  rigVersionCommand(['3', dir, '--preflight', '--config', 'work/config.json', '--citations', 'work/citations.json', ...extra]);
const codes = (report: DeclarationReport): string[] => report.refusals.map(f => `${f.code} ${f.path}`);

describe('rig-version --preflight names every missing declaration in one run', () => {
  test('a config missing all three of the pilot stops names each by its code, and writes nothing', () => {
    const { requirements, citations } = missingAllThree();
    const dir = project(requirements, citations);
    const before = readFileSync(join(dir, 'project.json'));
    const result = preflight(dir, ['--json']);
    expect(result.exit).toBe(1);
    const report = JSON.parse(result.stdout) as DeclarationReport;
    expect(codes(report)).toEqual([
      'SECTION_UNCITED versions[v3].provenance.sections[limbs]',
      'CG_GATE_UNDECLARED versions[v3].provenance.config requirements behind_seams.threshold',
      'SETUP_PAINTING_REQUIRED_MISSING versions[v3].provenance.config requirements setup_painting.required',
    ]);
    expect(report.declarations.filter(d => d.status === 'missing').map(d => d.codes[0])).toEqual(['SECTION_UNCITED', 'CG_GATE_UNDECLARED', 'SETUP_PAINTING_REQUIRED_MISSING']);
    expect(report.declarations.filter(d => d.status === 'carried').map(d => d.path)).toEqual([
      'versions[v3].provenance.sections[assemble]',
      ...['assemble.editor_receipts.trace_parts', 'requirements', 'requirements seam_over_motion.required', 'requirements boundary_colour.max_step_excess']
        .map(field => `versions[v3].provenance.config ${field}`),
    ]);
    // A measured value says where it is measured.
    expect(report.refusals.at(-1)?.message).toContain("parts' own pixel_count per region");
    expect(readFileSync(join(dir, 'project.json')).equals(before)).toBe(true);

    expect(report.registration_only).toEqual([]);

    const human = preflight(dir);
    expect(human.stdout).not.toContain('setup_painting.figure_mask');
    expect(human.stdout).toContain('missing versions[v3].provenance.config requirements behind_seams.threshold (CG_GATE_UNDECLARED)');
    expect(human.stdout).toContain('3 refusals, 0 warnings');

    writeFileSync(join(dir, 'work/requirements.json'), json(REQUIREMENTS));
    writeFileSync(join(dir, 'work/citations.json'), json(COMPLETE_CITATIONS));
    const fixed = preflight(dir, ['--json']);
    expect(fixed.exit).toBe(0);
    const passed = JSON.parse(fixed.stdout) as DeclarationReport;
    expect(passed.refusals).toEqual([]);
    expect(passed.declarations.every(d => d.status === 'carried')).toBe(true);
    expect(readFileSync(join(dir, 'project.json')).equals(before)).toBe(true);
  });

  test('a config that names no requirements file shows the setup-painting finding the record check keeps behind the CG one', () => {
    const { requirements: _r, ...config } = CONFIG;
    const dir = project(null, COMPLETE_CITATIONS, config);
    const report = JSON.parse(preflight(dir, ['--json']).stdout) as DeclarationReport;
    expect(codes(report)).toEqual([
      'CG_GATE_UNDECLARED versions[v3].provenance.config requirements',
      'SETUP_PAINTING_REQUIREMENTS_MISSING versions[v3].provenance.config requirements',
    ]);
    expect(report.declarations.filter(d => d.status === 'unread').map(d => d.path.split('config ')[1])).toEqual([
      'requirements seam_over_motion.required', 'requirements boundary_colour.max_step_excess', 'requirements behind_seams.threshold', SETUP_PAINTING_DECLARATION,
    ]);
  });

  test.each([
    ['invalid JSON', '{ not json', 'character'], ['invalid JSON', '{ not json', 'CG'],
    ['a non-object', '[]\n', 'character'], ['a non-object', '[]\n', 'CG'],
  ])('%s as the config of a %s rig is refused as registration refuses it, with no carried config declaration', (_kind, bytes, rig) => {
    const dir = project(REQUIREMENTS, COMPLETE_CITATIONS, CONFIG, rig === 'CG' ? asScene : () => {});
    writeFileSync(join(dir, 'work/config.json'), bytes);
    const before = readFileSync(join(dir, 'project.json'));
    const result = preflight(dir, ['--json']);
    expect(result.exit).toBe(1);
    const report = JSON.parse(result.stdout) as DeclarationReport;
    expect(report.refusals[0]).toMatchObject({ code: 'RIG_REGISTRATION_FILE_INVALID', path: 'versions[v3].provenance.config' });
    expect(report.refusals[0]?.message).toContain('retain the cited frozen inputs and register a new rig version');
    const config = report.declarations.filter(d => d.path.startsWith('versions[v3].provenance.config '));
    expect(config.length).toBe(rig === 'CG' ? CG_DECLARATIONS.length + 1 : 1);
    expect(config.every(d => d.status === 'unread')).toBe(true);
    expect(preflight(dir).exit).toBe(1);
    expect(readFileSync(join(dir, 'project.json')).equals(before)).toBe(true);
  });

  test('a character rig is held to citations and setup painting, not the CG gates', () => {
    const { requirements, citations } = missingAllThree();
    const report = JSON.parse(preflight(project(requirements, citations, CONFIG, () => {}), ['--json']).stdout) as DeclarationReport;
    expect(report.cg).toBe(false);
    expect(codes(report).map(c => c.split(' ')[0])).toEqual(['SECTION_UNCITED', 'SETUP_PAINTING_REQUIRED_MISSING']);
  });

  test('a config outside the project is refused by name, and usage still needs --config', () => {
    const dir = project(REQUIREMENTS, COMPLETE_CITATIONS);
    expect(() => rigVersionCommand(['3', dir, '--preflight', '--config', join(tempDir(), 'elsewhere.json')])).toThrow(expect.objectContaining({ code: 'RIG_PREFLIGHT_CONFIG_OUTSIDE' }));
    expect(() => rigVersionCommand(['3', dir, '--preflight'])).toThrow(expect.objectContaining({ code: 'RIG_REGISTRATION_USAGE' }));
  });

  test('an at-source before a contract date gives the registration its legacy warning, not a refusal', () => {
    const { requirements } = missingAllThree();
    const dir = project(requirements, COMPLETE_CITATIONS);
    writeFileSync(join(dir, 'work/run.json'), json({ finished_at: '2026-11-05T00:00:00Z' }));
    const report = JSON.parse(preflight(dir, ['--at-source', 'work/run.json', '--at-pointer', '/finished_at', '--json']).stdout) as DeclarationReport;
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['CG_GATE_UNDECLARED', 'SETUP_PAINTING_LEGACY']);
  });

  test('a visible busy-ground figure mask follows the cited contract date', () => {
    const config = { ...CONFIG, assemble: { ...obj(CONFIG.assemble), project: 'visible', ground: 'busy' } };
    const dir = project(REQUIREMENTS, COMPLETE_CITATIONS, config);
    const date = (finished_at: string): { result: ReturnType<typeof preflight>; report: DeclarationReport } => {
      writeFileSync(join(dir, 'work/run.json'), json({ finished_at }));
      const result = preflight(dir, ['--at-source', 'work/run.json', '--at-pointer', '/finished_at', '--json']);
      return { result, report: JSON.parse(result.stdout) as DeclarationReport };
    };
    const path = 'versions[v3].provenance.config requirements setup_painting.figure_mask';
    const before = date('2026-11-05T23:59:59.999Z');
    expect(before.result.exit).toBe(0);
    expect(before.report.warnings.map(f => f.code)).toEqual(['FIGURE_MASK_LEGACY']);
    expect(before.report.declarations).toContainEqual({ path, status: 'missing', codes: ['FIGURE_MASK_LEGACY'] });

    const at = date('2026-11-06T00:00:00Z');
    expect(at.result.exit).toBe(1);
    expect(codes(at.report)).toEqual([`FIGURE_MASK_MISSING ${path}`]);

    writeFileSync(join(dir, 'work/config.json'), json({ ...config, assemble: { ...config.assemble, ground: 'plain' } }));
    const plain = date('2026-11-06T00:00:00Z');
    expect(plain.result.exit).toBe(0);
    expect(plain.report.declarations.some(d => d.path === path)).toBe(false);
  });

  test('through the CLI: exit 1 with the three codes', () => {
    const { requirements, citations } = missingAllThree();
    const result = cli(['rig-version', '3', project(requirements, citations), '--preflight', '--config', 'work/config.json', '--citations', 'work/citations.json'], tempDir(), gitEnv());
    expect(result.code).toBe(1);
    for (const code of ['SECTION_UNCITED', 'CG_GATE_UNDECLARED', 'SETUP_PAINTING_REQUIRED_MISSING']) expect(result.stdout).toContain(`REFUSED ${code}:`);
  });
});

describe('the declaration list is the record check\'s', () => {
  test('an empty config and requirements yield a finding at every listed CG field and the setup declaration', () => {
    const dir = project({}, COMPLETE_CITATIONS, { requirements: 'requirements.json' });
    const bytes = readFileSync(join(dir, 'work/config.json'));
    const version: JsonObject = { n: 3, kind: 'rig', at: testClock.iso(), provenance: { config: { path: 'work/config.json', sha256: sha(bytes) }, sections: {} } };
    const report = checkVersionDeclarations(dir, JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject, version);
    const config = 'versions[v3].provenance.config ';
    const fields = report.refusals.filter(f => f.path.startsWith(config)).map(f => f.path.slice(config.length));
    expect(fields).toEqual([CG_DECLARATIONS[0], ...CG_DECLARATIONS.slice(2), SETUP_PAINTING_DECLARATION]);
    expect(report.declarations.map(d => d.status)).toEqual(['missing', 'carried', 'missing', 'missing', 'missing', 'missing']);
  });

});
