import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { checkProject, type CheckReport } from '../src/check.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { STAGE_VALUES } from '../src/stages.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { deriveWaypoints, SECTION_PLACEMENT } from '../src/waypoints.ts';
import { supersede } from './fixtures.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';

/** The section list @rig-c/parts 2.3.0 exports (its `CONFIG_SECTIONS`), used by the fake parts sources planted below. */
const PARTS_SECTIONS = [
  'key', 'generation', 'seethrough', 'assemble', 'limbs', 'bones', 'meshes', 'regions', 'motion', 'constraints',
  'stops', 'turn', 'scene', 'cloth', 'proposed_rig_scale', 'requirements', 'motion_seams', 'depth', 'waist',
];

function sectionsSource(sections: string[]): string {
  return `// a fake @rig-c/parts src/config.ts\nexport const CONFIG_SECTIONS = [${sections.map((s) => `'${s}'`).join(', ')}] as const;\n`;
}

/** Plants a fake installed @rig-c/parts in a project folder, so the derivation reads it instead of this repo's. */
function plantParts(projectDir: string, version: string, source: string): void {
  const dir = join(projectDir, 'node_modules', '@rig-c', 'parts');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@rig-c/parts', version }));
  writeFileSync(join(dir, 'src', 'config.ts'), source);
}

type Mutate = (project: JsonObject) => void;

/** A project folder in the OS temp dir holding the filled example, mutated in place. Nothing is copied into the repo. */
function fixture(mutate: Mutate = () => {}, template = 'example-project.json'): string {
  const dir = join(tempDir(), 'project');
  mkdirSync(dir);
  const project = readTemplate(template);
  mutate(project);
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return dir;
}

// Typed access into the record, so a mutation names the object it changes.
function obj(v: Json | undefined): JsonObject {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object');
  return v;
}
function arr(v: Json | undefined): Json[] {
  if (!Array.isArray(v)) throw new Error('expected an array');
  return v;
}
function byId(list: Json[], id: string): JsonObject {
  const found = list.find((x) => obj(x).id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return obj(found);
}
const waypoint = (p: JsonObject, id: string): JsonObject => byId(arr(obj(p.interview).waypoints), id);
const framing = (p: JsonObject, id: string): JsonObject => byId(arr(obj(p.interview).framing), id);
const step = (p: JsonObject, id: string): JsonObject => byId(arr(obj(p.plan).steps), id);
const signoffs = (p: JsonObject): JsonObject[] => arr(p.signoffs).map(obj);
function dropSignoffs(p: JsonObject, keep: (s: JsonObject) => boolean): void {
  p.signoffs = signoffs(p).filter(keep);
}

const codes = (r: CheckReport): string[] => r.refusals.map((f) => f.code);
const withCode = (r: CheckReport, code: string) => r.refusals.filter((f) => f.code === code);

/** The same delegation before the agent decided: no agent_decision. */
const UNDECIDED_GUIDE: JsonObject = {
  delegated: true,
  by: 'user',
  at: '2026-11-10T14:09:00Z',
  verbatim: 'auto',
  source: 'interview, chat',
};

const DELEGATED_GUIDE: JsonObject = {
  delegated: true,
  by: 'user',
  at: '2026-11-10T14:09:00Z',
  verbatim: 'auto',
  source: 'interview, chat',
  agent_decision: { value: [{ chain: 'scarf' }], by: 'agent', at: '2026-11-10T15:00:00Z', reasoning: 'the constraints guide puts wind on it' },
};

describe('the filled example', () => {
  test('passes, with no warnings, against the installed @rig-c/parts pin', () => {
    const report = checkProject(fixture());
    expect(report.refusals).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.parts?.version).toBe(PINNED_PACKAGES['@rig-c/parts']);
    expect(report.parts?.read_from).toBe('CONFIG_SECTIONS');
    expect(report.derived?.waypoints).toEqual(['seethrough', 'assemble', 'bones', 'meshes', 'constraints', 'motion']);
    expect(report.derived?.post_items?.sort()).toEqual(['camera_depth', 'post_composition', 'post_timing']);
  });

  test('exits 0 through the CLI and says so', () => {
    const result = cli(['interview', '--check', fixture()], tempDir(), gitEnv());
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('clean: 0 warnings');
    expect(result.stdout).toContain('stage accepted');
  });

  test('a plan-approved re-sign while the stage stays later is not a refusal (the example carries one)', () => {
    const resigns = signoffs(readTemplate('example-project.json')).filter((s) => s.stage === 'plan-approved');
    expect(resigns).toHaveLength(2);
    expect(resigns[1]?.steps).toEqual(['bones', 'constraints']);
  });
});

describe('the empty template at stage interview', () => {
  const report = checkProject(fixture(() => {}, 'project.json'));

  test('reports every unanswered item as INTERVIEW_INCOMPLETE and nothing else', () => {
    expect(new Set(codes(report))).toEqual(new Set(['INTERVIEW_INCOMPLETE']));
    expect(report.refusals.map((f) => f.path)).toEqual([
      'interview.framing[rig_type].answer',
      'interview.framing[reference].answer',
      'interview.waypoints[seethrough].guide',
      'interview.waypoints[assemble].guide',
      'interview.waypoints[bones].guide',
      'interview.waypoints[meshes].guide',
      'interview.waypoints[constraints].guide',
      'interview.waypoints[motion].guide',
    ]);
    expect(report.warnings).toEqual([]);
  });

  test('is not clear to rig: exit 1', () => {
    const result = cli(['interview', '--check', fixture(() => {}, 'project.json')], tempDir(), gitEnv());
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('the interview is incomplete');
    expect(result.stdout).toContain('not clear: 8 refusals');
  });

  test("the template's stage_values are the order in src/stages.ts", () => {
    expect(readTemplate('project.json').stage_values).toEqual([...STAGE_VALUES]);
  });

  test("the template's waypoint config lists are exactly what the pinned parts derives", () => {
    const derived = deriveWaypoints(PARTS_SECTIONS);
    const template = arr(obj(readTemplate('project.json').interview).waypoints).map(obj);
    expect(template.map((w) => ({ id: w.id, config: w.config }))).toEqual(derived.waypoints.map((w) => ({ id: w.id, config: [...w.config] })));
    expect(derived.unplaced).toEqual([]);
    expect(derived.retired).toEqual([]);
  });
});

describe('a waypoint with no guide and no delegation', () => {
  test('is refused by name once the interview is signed', () => {
    const report = checkProject(fixture((p) => { waypoint(p, 'bones').guide = null; }));
    const silent = withCode(report, 'WAYPOINT_SILENT');
    expect(silent.map((f) => f.path)).toEqual(['interview.waypoints[bones].guide']);
    // The steps resting on it are named too — every refusal, not the first.
    expect(withCode(report, 'STEP_BASIS_SILENT').map((f) => f.path).sort()).toEqual(['plan.steps[bones]', 'plan.steps[constraints]']);
  });

  test('a framing question is refused the same way', () => {
    const report = checkProject(fixture((p) => { framing(p, 'rig_type').answer = null; }));
    expect(withCode(report, 'FRAMING_SILENT').map((f) => f.path)).toEqual(['interview.framing[rig_type].answer']);
  });

  test('delegation is a pass: the refusal disappears', () => {
    const report = checkProject(fixture((p) => { supersede(waypoint(p, 'bones'), 'guide', DELEGATED_GUIDE); }));
    expect(codes(report)).toEqual([]);
  });

  test('a delegation with no agent_decision is refused once the plan is signed', () => {
    const report = checkProject(fixture((p) => { waypoint(p, 'bones').guide = UNDECIDED_GUIDE; }));
    expect(withCode(report, 'DELEGATION_UNDECIDED').map((f) => f.path)).toEqual(['interview.waypoints[bones].guide']);
  });

  test('a delegation with no agent_decision passes while the plan is unsigned', () => {
    const report = checkProject(
      fixture((p) => {
        p.stage = 'plan-approved';
        dropSignoffs(p, (s) => s.stage === 'interview');
        for (const s of arr(obj(p.plan).steps).map(obj)) s.status = 'pending';
        waypoint(p, 'bones').guide = UNDECIDED_GUIDE;
      }),
    );
    expect(withCode(report, 'DELEGATION_UNDECIDED')).toEqual([]);
  });

  test('not applicable with a reason is a pass; without one it is malformed', () => {
    const na = { not_applicable: true, because: 'pre-layered input, no see-through pass', by: 'interviewer', at: '2026-11-10T14:03:00Z' };
    const pass = checkProject(
      fixture((p) => {
        supersede(waypoint(p, 'seethrough'), 'guide', na);
        obj(p.plan).steps = arr(obj(p.plan).steps).filter((s) => obj(s).id !== 'seethrough');
      }),
    );
    expect(codes(pass)).toEqual([]);
    const fail = checkProject(fixture((p) => { waypoint(p, 'seethrough').guide = { not_applicable: true, by: 'interviewer', at: '2026-11-10T14:03:00Z' }; }));
    expect(withCode(fail, 'ANSWER_MALFORMED').map((f) => f.path)).toEqual(['interview.waypoints[seethrough].guide']);
  });

  test('a waypoint with a guide but no rig step is refused once the plan is signed', () => {
    const report = checkProject(fixture((p) => { obj(p.plan).steps = arr(obj(p.plan).steps).filter((s) => obj(s).id !== 'meshes'); }));
    expect(withCode(report, 'STEP_MISSING_FOR_WAYPOINT').map((f) => f.path)).toEqual(['plan.steps[meshes]']);
  });
});

describe('a plan step that rests on no answer', () => {
  test('empty rests_on is refused by step id', () => {
    const report = checkProject(fixture((p) => { step(p, 'bones').rests_on = []; }));
    expect(withCode(report, 'STEP_NO_BASIS').map((f) => f.path)).toEqual(['plan.steps[bones]']);
  });

  test('an id no question has is refused by step id and names the id', () => {
    const report = checkProject(fixture((p) => { step(p, 'bones').rests_on = ['wind_direction']; }));
    const found = withCode(report, 'STEP_BASIS_UNKNOWN');
    expect(found.map((f) => f.path)).toEqual(['plan.steps[bones]']);
    expect(found[0]?.message).toContain("'wind_direction'");
  });

  test('a rig step whose id is no waypoint is refused', () => {
    const report = checkProject(fixture((p) => { step(p, 'bones').id = 'skeleton'; }));
    expect(withCode(report, 'STEP_NOT_A_WAYPOINT').map((f) => f.path)).toEqual(['plan.steps[skeleton]']);
  });

  test('a changed guide with no re-sign covering the step is refused', () => {
    // The example's bones guide gained an addition on 11-12; the plan-approved re-sign on 11-12 covers bones and constraints. Remove it.
    const report = checkProject(fixture((p) => { dropSignoffs(p, (s) => !(s.stage === 'plan-approved' && Array.isArray(s.steps))); }));
    expect(withCode(report, 'GUIDE_CHANGED_UNSIGNED').map((f) => f.path).sort()).toEqual(['plan.steps[bones]', 'plan.steps[constraints]']);
  });

  test('a checkpoint left null under a signed plan is refused', () => {
    const report = checkProject(fixture((p) => { step(p, 'meshes').checkpoint = null; }));
    expect(withCode(report, 'CHECKPOINT_UNANSWERED').map((f) => f.path)).toEqual(['plan.steps[meshes].checkpoint']);
  });
});

describe('a stage moved without a human sign-off', () => {
  test('a missing stage sign-off is refused and names the stage', () => {
    const report = checkProject(fixture((p) => { dropSignoffs(p, (s) => s.stage !== 'rig-review'); }));
    const found = withCode(report, 'STAGE_UNSIGNED');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('"stage": "rig-review"');
  });

  test('a step done with its checkpoint on and no checkpoint sign-off is refused by step id', () => {
    const report = checkProject(fixture((p) => { dropSignoffs(p, (s) => !(s.stage === 'rigging' && s.checkpoint === 'assemble')); }));
    expect(withCode(report, 'CHECKPOINT_UNSIGNED').map((f) => f.path)).toEqual(['plan.steps[assemble]']);
  });

  test('a sign-off by the agent is not a sign-off', () => {
    const report = checkProject(fixture((p) => { const s = signoffs(p); const first = obj(s[0]); first.by = 'agent'; }));
    expect(codes(report)).toContain('SIGNOFF_NOT_HUMAN');
    expect(codes(report)).toContain('STAGE_UNSIGNED');
  });

  test('a sign-off for a stage later than the current one is refused', () => {
    const report = checkProject(fixture((p) => { p.stage = 'interview'; }));
    expect(withCode(report, 'SIGNOFF_AHEAD_OF_STAGE').length).toBeGreaterThan(0);
  });

  test('a checkpoint sign-off naming no step is refused', () => {
    const report = checkProject(fixture((p) => { const s = signoffs(p); obj(s[2]).checkpoint = 'split'; }));
    expect(withCode(report, 'SIGNOFF_UNKNOWN_CHECKPOINT').map((f) => f.path)).toEqual(['signoffs[2]']);
  });

  test('an unknown stage is refused and nothing else is attempted', () => {
    const report = checkProject(fixture((p) => { p.stage = 'shipping'; }));
    expect(codes(report)).toEqual(['STAGE_UNKNOWN']);
  });

  test('paused is checked as the first stage whose sign-off is missing, and needs its own sign-off', () => {
    const unsigned = checkProject(fixture((p) => { p.stage = 'paused'; dropSignoffs(p, (s) => s.stage === 'interview'); }));
    expect(unsigned.effective_stage).toBe('plan-approved');
    expect(withCode(unsigned, 'PAUSED_UNSIGNED')).toHaveLength(1);
    const signed = checkProject(
      fixture((p) => {
        p.stage = 'paused';
        dropSignoffs(p, (s) => s.stage === 'interview');
        arr(p.signoffs).push({ stage: 'paused', checkpoint: null, by: 'user', at: '2026-11-10T17:00:00Z', verbatim: 'park it' });
        for (const s of arr(obj(p.plan).steps).map(obj)) s.status = 'pending';
      }),
    );
    expect(codes(signed)).toEqual([]);
  });

  test('when every post item is not applicable, post and direction-review need no sign-off', () => {
    const report = checkProject(
      fixture((p) => {
        for (const item of arr(obj(obj(p.interview).post).items).map(obj)) {
          supersede(item, 'guide', { not_applicable: true, because: 'composition belongs to the collection', by: 'interviewer', at: '2026-11-13T10:00:00Z' });
        }
        obj(p.plan).steps = arr(obj(p.plan).steps).filter((s) => obj(s).phase === 'rig');
        dropSignoffs(p, (s) => s.stage !== 'direction-review');
      }),
    );
    expect(codes(report)).toEqual([]);
  });
});

describe('waypoints come from the installed @rig-c/parts', () => {
  test('a section not on the placement table is refused by name, with the parts version', () => {
    const dir = fixture();
    plantParts(dir, '2.9.0', sectionsSource([...PARTS_SECTIONS, 'foo']));
    const report = checkProject(dir);
    const found = withCode(report, 'SECTION_UNPLACED');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toStartWith("@rig-c/parts 2.9.0 has section 'foo'");
    expect(report.parts?.version).toBe('2.9.0');
    // The record was read from the pin, not 2.9.0: a warning, not a refusal.
    expect(report.warnings.map((w) => w.code)).toContain('QUESTION_SET_STALE');
  });

  test('a section that parts dropped from a waypoint is a warning, and a waypoint parts no longer passes is refused as missing from the record only when added', () => {
    const dir = fixture();
    plantParts(dir, PINNED_PACKAGES['@rig-c/parts'], sectionsSource(PARTS_SECTIONS.filter((s) => s !== 'cloth')));
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map((w) => w.code).sort()).toEqual(['SECTION_RETIRED', 'WAYPOINT_CONFIG_STALE']);
  });

  test('a record missing a derived waypoint is refused by waypoint id', () => {
    const report = checkProject(
      fixture((p) => {
        const i = obj(p.interview);
        i.waypoints = arr(i.waypoints).filter((w) => obj(w).id !== 'meshes');
        obj(p.plan).steps = arr(obj(p.plan).steps).filter((s) => obj(s).id !== 'meshes');
      }),
    );
    expect(withCode(report, 'WAYPOINT_MISSING').map((f) => f.path)).toEqual(['interview.waypoints[meshes]']);
  });

  test('a section the pinned version does not have is refused as SECTION_UNPLACED and named in the report', () => {
    const dir = fixture();
    plantParts(dir, PINNED_PACKAGES['@rig-c/parts'], sectionsSource([...PARTS_SECTIONS.slice(0, 5), 'sway', ...PARTS_SECTIONS.slice(5)]));
    const report = checkProject(dir);
    expect(codes(report)).toEqual(['SECTION_UNPLACED']);
    expect(withCode(report, 'SECTION_UNPLACED')[0]?.message).toContain("'sway'");
    expect(report.parts?.read_from).toBe('CONFIG_SECTIONS');
    expect(report.warnings).toEqual([]);
  });

  test('a parts without the CONFIG_SECTIONS export (older than 2.3.0) is refused, not silently empty', () => {
    const dir = fixture();
    plantParts(dir, '2.2.0', `// what 2.2.0 had: a module-private list\nconst TOP_KEYS = [${PARTS_SECTIONS.map((x) => `'${x}'`).join(', ')}] as const;\nexport const unused = TOP_KEYS;\n`);
    const report = checkProject(dir);
    expect(codes(report)).toEqual(['PARTS_SECTIONS_UNREADABLE']);
    expect(withCode(report, 'PARTS_SECTIONS_UNREADABLE')[0]?.message).toContain('@rig-c/parts 2.2.0');
  });

  test('a parts source that does not load is refused, not thrown', () => {
    const dir = fixture();
    plantParts(dir, '3.0.0', "import './missing.ts';\nexport const CONFIG_SECTIONS = ['key'];\n");
    expect(codes(checkProject(dir))).toEqual(['PARTS_SECTIONS_UNREADABLE']);
  });

  test("the repository's own pinned parts exports CONFIG_SECTIONS, reads as the pin and places every section", () => {
    const own = createRequire(import.meta.url)(join(import.meta.dir, '..', 'node_modules', '@rig-c', 'parts', 'src', 'config.ts')) as { CONFIG_SECTIONS?: unknown };
    expect(own.CONFIG_SECTIONS).toEqual(PARTS_SECTIONS);
    for (const section of PARTS_SECTIONS) expect(SECTION_PLACEMENT[section]).toBeDefined();
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@rig-c/parts']).toBe(PINNED_PACKAGES['@rig-c/parts']);
    const installed = JSON.parse(readFileSync(join(import.meta.dir, '..', 'node_modules', '@rig-c', 'parts', 'package.json'), 'utf8'));
    expect(installed.version).toBe(PINNED_PACKAGES['@rig-c/parts']);
  });
});

describe('collection members', () => {
  function member(collectionMotion: Json): string {
    const root = tempDir();
    const col = join(root, 'harbour');
    mkdirSync(join(col, 'members', 'keeper'), { recursive: true });
    const collection = readTemplate('collection.json');
    collection.name = 'harbour';
    byId(arr(obj(collection.interview).waypoints), 'motion').guide = collectionMotion;
    writeFileSync(join(col, 'collection.json'), JSON.stringify(collection, null, 2));
    const project = readTemplate('example-project.json');
    supersede(waypoint(project, 'motion'), 'guide', { basis: 'inherited', from: { collection: 'harbour', question: 'motion' }, by: 'interviewer', at: '2026-11-12T10:00:00Z' });
    const dir = join(col, 'members', 'keeper');
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2));
    return dir;
  }

  test('an inherited answer resolves against the collection and passes', () => {
    const report = checkProject(member({ delegated: false, by: 'user', at: '2026-11-10T14:00:00Z', verbatim: 'Breath and blink.', value: [{ motion: 'breath' }, { motion: 'blink' }], source: 'interview, chat' }));
    expect(codes(report)).toEqual([]);
  });

  test('an inherited answer pointing at a null collection answer is silence', () => {
    const report = checkProject(member(null));
    const found = withCode(report, 'WAYPOINT_SILENT');
    expect(found.map((f) => f.path)).toEqual(['interview.waypoints[motion].guide']);
    expect(found[0]?.message).toContain("collection 'harbour' answer 'motion' is null");
  });

  test('an inherited answer outside a collection is unresolved', () => {
    const report = checkProject(fixture((p) => { waypoint(p, 'motion').guide = { basis: 'inherited', from: { collection: 'harbour', question: 'motion' }, by: 'interviewer', at: '2026-11-12T10:00:00Z' }; }));
    expect(withCode(report, 'INHERITED_UNRESOLVED').map((f) => f.path)).toEqual(['interview.waypoints[motion].guide']);
  });
});

describe('the command', () => {
  test('--json prints the report as one object', () => {
    const result = cli(['interview', '--check', '--json', fixture((p) => { waypoint(p, 'bones').guide = null; })], tempDir(), gitEnv());
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as CheckReport;
    expect(report.ok).toBe(false);
    expect(report.refusals.map((f) => [f.code, f.path])).toContainEqual(['WAYPOINT_SILENT', 'interview.waypoints[bones].guide']);
    expect(report.derived?.waypoints).toContain('bones');
  });

  test('defaults to the current directory', () => {
    const dir = fixture();
    expect(cli(['interview', '--check'], dir, gitEnv()).code).toBe(0);
  });

  test('a folder with no project.json is refused by path', () => {
    const dir = tempDir();
    const result = cli(['interview', '--check', dir], dir, gitEnv());
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`PROJECT_JSON_MISSING: ${join(dir, 'project.json')}`);
  });

  test('usage errors exit 2', () => {
    expect(cli(['interview'], tempDir(), gitEnv())).toMatchObject({ code: 2, stderr: expect.stringContaining('INTERVIEW_MODE_MISSING') });
    expect(cli(['interview', '--check', '--loud'], tempDir(), gitEnv())).toMatchObject({ code: 2, stderr: expect.stringContaining('UNKNOWN_OPTION') });
    expect(cli(['interview', '--check', 'a', 'b'], tempDir(), gitEnv())).toMatchObject({ code: 2, stderr: expect.stringContaining('INTERVIEW_TOO_MANY_ARGUMENTS') });
  });

  test('--help lists interview --check', () => {
    expect(cli(['--help'], tempDir(), gitEnv()).stdout).toContain('rig-create interview --check [<project dir>] [--json]');
  });
});

describe('review fixes: an agent decision is real and dated', () => {
  test('an empty agent_decision is not a decision', () => {
    const report = checkProject(fixture((p) => { obj(waypoint(p, 'seethrough').guide).agent_decision = {}; }));
    expect(withCode(report, 'DELEGATION_UNDECIDED').map((f) => f.path)).toEqual(['interview.waypoints[seethrough].guide']);
  });

  test('a delegated checkpoint needs a boolean decision', () => {
    const report = checkProject(
      fixture((p) => {
        const checkpointed = arr(obj(p.plan).steps).map(obj).find((s) => obj(s.checkpoint).delegated === true);
        if (checkpointed === undefined) throw new Error('example has no delegated checkpoint');
        obj(checkpointed.checkpoint).agent_decision = {};
      }),
    );
    expect(withCode(report, 'DELEGATION_UNDECIDED').length).toBe(1);
    expect(withCode(report, 'DELEGATION_UNDECIDED')[0]?.path).toEndWith('.checkpoint');
  });

  test('a decision rewritten after the sign-off sends its steps back', () => {
    const report = checkProject(
      fixture((p) => {
        const decision = obj(obj(waypoint(p, 'assemble').guide).agent_decision);
        decision.at = '2030-01-01T00:00:00Z';
      }),
    );
    expect(withCode(report, 'GUIDE_CHANGED_UNSIGNED').length).toBeGreaterThan(0);
  });
});
