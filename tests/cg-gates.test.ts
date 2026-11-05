import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { CG_BOUNDARY_ALLOWANCE } from '../src/cg-gates.ts';
import { checkProject, type CheckReport } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { fixture, framing, obj, version, type Mutate } from './fixtures.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** The codes this card adds, so a fixture's unrelated findings (provenance of a planted config) do not hide them. */
const CG_CODES = new Set(['RIG_TYPE_UNKNOWN', 'CG_GATES_UNREAD', 'CG_GATE_UNDECLARED', 'CG_BOUNDARY_ALLOWANCE_RAISED']);
const cg = (r: CheckReport): string[] => r.refusals.filter((f) => CG_CODES.has(f.code)).map((f) => `${f.code} ${f.path}`);

const asScene: Mutate = (p) => { obj(framing(p, 'rig_type').answer).value = 'fullscreen.minimal'; };

const GATED_CONFIG: JsonObject = { key: 'keeper', assemble: { editor_receipts: { trace_parts: true, receipts: [] } }, requirements: 'requirements.json' };
const GATED_REQUIREMENTS: JsonObject = {
  spec: 'spine-parts-requirements/1', fps: 12, requirements: [],
  setup_painting: { required: true },
  seam_over_motion: { required: true },
  boundary_colour: { max_step_excess: CG_BOUNDARY_ALLOWANCE },
};

/** A project whose rig versions v1 and v2 each keep their config (and its requirements file) under `outputs/v<N>/`. */
function scene(config: JsonObject = GATED_CONFIG, requirements: JsonObject | null = GATED_REQUIREMENTS, mutate: Mutate = () => {}): string {
  const files: Record<string, string> = {};
  const configText = json(config);
  for (const n of [1, 2]) {
    files[`outputs/v${n}/config.json`] = configText;
    if (requirements !== null) files[`outputs/v${n}/requirements.json`] = json(requirements);
  }
  return fixture((p) => {
    asScene(p);
    for (const n of [1, 2]) obj(version(p, n).provenance).config = { path: `outputs/v${n}/config.json`, sha256: sha(configText) };
    mutate(p);
  }, 'legacy-example-project.json', files);
}

describe('which projects are held', () => {
  test('a character rig (the filled example) is not a CG build: nothing is read or refused', () => {
    expect(cg(checkProject(fixture()))).toEqual([]);
  });

  test('a rig_type outside the documented values is refused, so a misspelt CG cannot pass ungated', () => {
    const report = checkProject(fixture((p) => { obj(framing(p, 'rig_type').answer).value = 'scene.minimal'; }));
    expect(cg(report)).toEqual(['RIG_TYPE_UNKNOWN interview.framing[rig_type].answer']);
  });

  test('a delegated rig_type is read from the agent decision', () => {
    const report = checkProject(fixture((p) => {
      framing(p, 'rig_type').answer = {
        delegated: true, by: 'user', at: '2026-11-10T14:01:00Z', verbatim: 'you decide',
        agent_decision: { value: 'fullscreen.game_logic', reasoning: 'a full-screen scene driven by game states', at: '2026-11-10T14:01:00Z' },
      };
    }));
    expect(cg(report)).toEqual([
      'CG_GATES_UNREAD versions[v1].provenance.config',
      'CG_GATES_UNREAD versions[v2].provenance.config',
    ]);
  });
});

describe('a full-screen scene (CG) rig version', () => {
  test('with the config not kept, it is refused: an unread gate is not a pass', () => {
    const report = checkProject(fixture(asScene));
    expect(cg(report)).toEqual([
      'CG_GATES_UNREAD versions[v1].provenance.config',
      'CG_GATES_UNREAD versions[v2].provenance.config',
    ]);
  });

  test('declaring all three gates, it passes', () => {
    expect(cg(checkProject(scene()))).toEqual([]);
  });

  test('a stricter allowance passes', () => {
    expect(cg(checkProject(scene(GATED_CONFIG, { ...GATED_REQUIREMENTS, boundary_colour: { max_step_excess: 4 } })))).toEqual([]);
  });

  test('without trace_parts, each version is refused at that field', () => {
    const report = checkProject(scene({ ...GATED_CONFIG, assemble: { editor_receipts: { receipts: [] } } }));
    expect(cg(report)).toEqual([
      'CG_GATE_UNDECLARED versions[v1].provenance.config assemble.editor_receipts.trace_parts',
      'CG_GATE_UNDECLARED versions[v2].provenance.config assemble.editor_receipts.trace_parts',
    ]);
  });

  test('a config that names no requirements file is refused', () => {
    const { requirements: _dropped, ...noRequirements } = GATED_CONFIG;
    expect(cg(checkProject(scene(noRequirements, null)))).toContain('CG_GATE_UNDECLARED versions[v1].provenance.config requirements');
  });

  test('a requirements file the config names but the project lacks is unread', () => {
    expect(cg(checkProject(scene(GATED_CONFIG, null)))).toContain('CG_GATES_UNREAD versions[v1].provenance.config requirements');
  });

  test('a requirements file without the two declarations is refused at each', () => {
    const report = checkProject(scene(GATED_CONFIG, { spec: 'spine-parts-requirements/1', fps: 12, requirements: [] }));
    expect(cg(report).filter((r) => r.includes('[v1]'))).toEqual([
      'CG_GATE_UNDECLARED versions[v1].provenance.config requirements seam_over_motion.required',
      'CG_GATE_UNDECLARED versions[v1].provenance.config requirements boundary_colour.max_step_excess',
    ]);
  });

  test(`an allowance over ${CG_BOUNDARY_ALLOWANCE} is refused, not accepted as the author's bar`, () => {
    const report = checkProject(scene(GATED_CONFIG, { ...GATED_REQUIREMENTS, boundary_colour: { max_step_excess: CG_BOUNDARY_ALLOWANCE + 1 } }));
    expect(cg(report).filter((r) => r.includes('[v1]'))).toEqual(['CG_BOUNDARY_ALLOWANCE_RAISED versions[v1].provenance.config requirements boundary_colour.max_step_excess']);
  });

  test('a config whose bytes are not the recorded ones is unread', () => {
    const report = checkProject(scene(GATED_CONFIG, GATED_REQUIREMENTS, (p) => { obj(obj(version(p, 2).provenance).config).sha256 = sha('other'); }));
    expect(cg(report)).toEqual(['CG_GATES_UNREAD versions[v2].provenance.config']);
  });

  test('a config with no recorded hash is unread: its declarations are not verified', () => {
    const report = checkProject(scene(GATED_CONFIG, GATED_REQUIREMENTS, (p) => { delete obj(obj(version(p, 2).provenance).config).sha256; }));
    expect(cg(report)).toEqual(['CG_GATES_UNREAD versions[v2].provenance.config']);
  });

  test('a version built before the gates existed is a warning, not a refusal', () => {
    const report = checkProject(fixture((p) => {
      asScene(p);
      for (const n of [1, 2]) obj(version(p, n).built_with)['@rig-c/parts'] = '2.3.0';
    }));
    expect(cg(report)).toEqual([]);
    expect(report.warnings.map((w) => `${w.code} ${w.path}`)).toEqual([
      'QUESTION_SET_STALE interview.question_set',
      'CG_GATES_PREDATE versions[v1].built_with',
      'CG_GATES_PREDATE versions[v2].built_with',
      'STAGE_ORDER_LEGACY interview.order',
      'CHOICE_ANSWERS_LEGACY interview.order',
      'CORRECTION_PATH_LEGACY corrections_contract',
    ]);
  });

  test('through the CLI: exit 1, the field named', () => {
    const result = cli(['interview', '--check', scene({ ...GATED_CONFIG, assemble: {} })], tempDir(), gitEnv());
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('CG_GATE_UNDECLARED: versions[v1]: outputs/v1/config.json does not declare assemble.editor_receipts.trace_parts: true');
  });
});
