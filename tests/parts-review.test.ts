/**
 * The parts are made and reviewed before any rig is built (rig-c/create#48):
 * `plan-approved` → `parts` (closed by its bar) → `parts-review` (closed by a
 * human sign-off) → `rigging`. Planted controls for each refusal, the green
 * path, and a project that passed `plan-approved` before the two stages
 * existed, which is warned about and never given a sign-off nobody made.
 */
import { describe, expect, test } from 'bun:test';
import { PARTS_REVIEW_SINCE, STAGE_VALUES, STAGES } from '../src/stages.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { arr, codes, fixture, historicalFixture, obj, rehashSignoffs, retimeFixture, step, withCode } from './fixtures.ts';
import { checkProject } from './clock.ts';

const BEFORE_RIGGING = new Set(['interview', 'plan-approved', 'parts', 'parts-review']);
const LATER_RIG_STEPS = ['bones', 'meshes', 'constraints', 'motion'];

function dropSignoffs(p: JsonObject, keep: (s: JsonObject) => boolean): void {
  p.signoffs = arr(p.signoffs).filter((s) => keep(obj(s)));
}

/**
 * The filled example rewound to the moment `rigging` starts: the parts are
 * made and reviewed, no rig step after them has run, and nothing later is
 * signed or built.
 */
function atRiggingStart(p: JsonObject): void {
  p.stage = 'rigging';
  dropSignoffs(p, (s) => BEFORE_RIGGING.has(String(s.stage)) && !(s.stage === 'plan-approved' && Array.isArray(s.steps)));
  for (const s of arr(obj(p.plan).steps).map(obj)) if (s.phase === 'post' || LATER_RIG_STEPS.includes(String(s.id))) s.status = 'pending';
  p.versions = [];
  const boundAnswers = arr(p.signoffs).some(raw => obj(raw).answer_hashes !== undefined);
  retimeFixture(p, Date.parse('2026-11-16T00:00:00Z'), boundAnswers);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Moves every timestamp in the record back by `days`, so the whole history happened before the two stages existed. */
function shiftDates(v: Json, days: number): Json {
  if (typeof v === 'string') return ISO.test(v) ? new Date(Date.parse(v) - days * 86_400_000).toISOString() : v;
  if (Array.isArray(v)) return v.map((x) => shiftDates(x, days));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shiftDates(x, days)]));
  return v;
}

/**
 * A synthetic in-flight project: the filled example as it was recorded under
 * the old order — dated before `PARTS_REVIEW_SINCE`, the old `stage_values`,
 * no `parts-review` sign-off, and the `assemble` checkpoint signed as
 * `rigging`, where the rig steps all ran then.
 */
function inFlight(p: JsonObject): void {
  const shifted = obj(shiftDates(p, 30));
  for (const k of Object.keys(p)) delete p[k];
  Object.assign(p, shifted);
  rehashSignoffs(p);
  p.stage_values = STAGE_VALUES.filter((s) => s !== 'parts' && s !== 'parts-review');
  dropSignoffs(p, (s) => s.stage !== 'parts-review');
  for (const s of arr(p.signoffs).map(obj)) if (s.stage === 'parts') s.stage = 'rigging';
}

describe('the order', () => {
  test('parts (a bar) and parts-review (a sign-off) stand between plan-approved and rigging', () => {
    const ids = STAGES.map((s) => s.id);
    expect(ids.slice(ids.indexOf('plan-approved'), ids.indexOf('rigging') + 1)).toEqual(['plan-approved', 'parts', 'parts-review', 'rigging-interview', 'rigging']);
    expect(STAGES.find((s) => s.id === 'parts')).toMatchObject({ closed_by: 'bar', phase: 'rig', steps: ['seethrough', 'assemble'] });
    expect(STAGES.find((s) => s.id === 'parts-review')).toMatchObject({ closed_by: 'signoff' });
  });
});

describe('plan-approved → parts → parts-review → rigging', () => {
  test('green: parts done and a person signed parts-review, rigging starts with nothing refused', () => {
    const report = checkProject(fixture(atRiggingStart));
    expect(codes(report)).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });

  test('a project at plan-approved advances to parts: the parts steps run there, nothing refused', () => {
    const report = checkProject(
      fixture((p) => {
        atRiggingStart(p);
        p.stage = 'parts';
        dropSignoffs(p, (s) => s.stage !== 'parts-review');
        step(p, 'assemble').status = 'in-progress';
      }),
    );
    expect(codes(report)).toEqual([]);
  });

  test('the assemble checkpoint is signed as parts: signed as rigging on a new project it names no step of that stage', () => {
    const report = checkProject(
      fixture((p) => {
        for (const s of arr(p.signoffs).map(obj)) if (s.stage === 'parts') s.stage = 'rigging';
      }),
    );
    expect(codes(report).sort()).toEqual(['CHECKPOINT_UNSIGNED', 'SIGNOFF_UNKNOWN_CHECKPOINT']);
    expect(withCode(report, 'CHECKPOINT_UNSIGNED')[0]?.message).toContain('{ "stage": "parts", "checkpoint": "assemble" }');
  });

  test('neither closure: rigging with the parts steps not done and no parts-review sign-off is refused for both', () => {
    const report = checkProject(
      fixture((p) => {
        atRiggingStart(p);
        dropSignoffs(p, (s) => s.stage !== 'parts-review' && s.stage !== 'parts');
        step(p, 'seethrough').status = 'pending';
        step(p, 'assemble').status = 'in-progress';
      }),
    );
    expect(codes(report).sort()).toEqual(['PARTS_BAR_UNMET', 'PARTS_BAR_UNMET', 'PARTS_REVIEW_UNSIGNED', 'STAGE_SKIPPED', 'STAGE_SKIPPED']);
    expect(withCode(report, 'PARTS_BAR_UNMET').map((f) => f.path)).toEqual(['plan.steps[seethrough]', 'plan.steps[assemble]']);
  });

  test('parts met, no sign-off: refused by name, with the remedy', () => {
    const report = checkProject(fixture((p) => { atRiggingStart(p); dropSignoffs(p, (s) => s.stage !== 'parts-review'); }));
    expect(codes(report)).toEqual(['PARTS_REVIEW_UNSIGNED', 'STAGE_SKIPPED', 'STAGE_SKIPPED']);
    const message = withCode(report, 'PARTS_REVIEW_UNSIGNED')[0]?.message ?? '';
    expect(message).toContain('{ "stage": "parts-review", "checkpoint": null }');
    expect(message).toContain("rig-review's parts view");
  });

  test('an agent-made parts-review sign-off is not one: refused as not human, and rigging is refused', () => {
    const report = checkProject(
      fixture((p) => {
        atRiggingStart(p);
        for (const s of arr(p.signoffs).map(obj)) if (s.stage === 'parts-review') s.by = 'agent';
      }),
    );
    expect(codes(report).sort()).toEqual(['PARTS_REVIEW_UNSIGNED', 'SIGNOFF_NOT_HUMAN', 'STAGE_SKIPPED', 'STAGE_SKIPPED']);
  });

  test('a rig step run before parts-review is signed is refused at that step, even while the stage has not moved', () => {
    const report = checkProject(
      fixture((p) => {
        atRiggingStart(p);
        p.stage = 'parts-review';
        dropSignoffs(p, (s) => s.stage !== 'parts-review');
        step(p, 'bones').status = 'done';
      }),
    );
    expect(withCode(report, 'PARTS_REVIEW_UNSIGNED').map((f) => f.path)).toEqual(['plan.steps[bones]']);
  });
});

describe('paused, with the parts stage in it', () => {
  const pause = (p: JsonObject): void => {
    p.stage = 'paused';
    arr(p.signoffs).push({ stage: 'paused', checkpoint: null, by: 'user', at: '2026-11-11T09:00:00Z', verbatim: 'hold' });
  };

  test('paused during parts with its steps unfinished: no refusal, and it resumes at parts', () => {
    const report = checkProject(
      fixture((p) => {
        atRiggingStart(p);
        dropSignoffs(p, (s) => s.stage === 'interview' || s.stage === 'plan-approved');
        step(p, 'seethrough').status = 'done';
        step(p, 'assemble').status = 'in-progress';
        pause(p);
      }),
    );
    expect(report.effective_stage).toBe('parts');
    expect(codes(report)).toEqual([]);
  });

  test('paused with the parts done and parts-review unsigned resumes at parts-review, unrefused', () => {
    const report = checkProject(
      fixture((p) => {
        atRiggingStart(p);
        dropSignoffs(p, (s) => s.stage !== 'parts-review');
        pause(p);
      }),
    );
    expect(report.effective_stage).toBe('parts-review');
    expect(codes(report)).toEqual([]);
  });

  test('paused during rigging resumes at rig-review, as before the parts stages: rigging steps left unfinished are not a resume point', () => {
    const report = checkProject(
      fixture((p) => {
        atRiggingStart(p);
        // meshes and motion: steps whose guides did not change after the first plan sign-off (the example re-signs bones and constraints).
        step(p, 'meshes').status = 'done';
        step(p, 'motion').status = 'in-progress';
        pause(p);
      }),
    );
    expect(report.effective_stage).toBe('rig-review');
    expect(codes(report)).toEqual([]);
  });

  test('not paused, past parts with a parts step unfinished: still refused', () => {
    const report = checkProject(
      fixture((p) => {
        atRiggingStart(p);
        p.stage = 'parts-review';
        dropSignoffs(p, (s) => s.stage !== 'parts-review');
        step(p, 'assemble').status = 'in-progress';
      }),
    );
    expect(withCode(report, 'PARTS_BAR_UNMET').map((f) => f.path)).toEqual(['plan.steps[assemble]']);
  });
});

describe('a project that passed plan-approved before the stages existed', () => {
  test('is warned about by name, never refused, and given no sign-off', () => {
    const dir = historicalFixture(inFlight);
    const report = checkProject(dir);
    expect(codes(report)).toEqual([]);
    const warned = report.warnings.filter((w) => w.code === 'PARTS_REVIEW_PREDATES_STAGE');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toContain("project 'lantern-keeper'");
    expect(warned[0]?.message).toContain(PARTS_REVIEW_SINCE);
    expect(report.warnings.map((w) => w.code).sort()).toEqual(['CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY', 'INPUT_WRITER_MISSING', 'PARTS_REVIEW_PREDATES_STAGE', 'QUESTION_SET_STALE', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'STAGE_MOVE_UNLINKED', 'STAGE_ORDER_LEGACY', 'STAGE_VALUES_STALE']);
  });

  test('one that a person did review is not warned about as predating the stage; its evidence-less approval gets one build-identity WARN per rig version', () => {
    const report = checkProject(
      historicalFixture((p) => {
        inFlight(p);
        const firstRig = obj(arr(p.versions)[0]);
        const at = new Date(Date.parse(String(firstRig.at)) - 1000).toISOString();
        arr(p.signoffs).push({ stage: 'parts-review', checkpoint: null, by: 'user', at, verbatim: 'parts are fine' });
      }),
    );
    expect(codes(report)).toEqual([]);
    expect(report.warnings.map((w) => w.code)).toEqual(['STAGE_VALUES_STALE', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'QUESTION_SET_STALE', 'STAGE_MOVE_UNLINKED', 'REVIEW_PACKAGE_PARTS_UNREAD', 'REVIEW_PACKAGE_PARTS_UNREAD', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });

  test('one signed before the stages existed but still at plan-approved goes through them: no exemption', () => {
    const report = checkProject(
      historicalFixture((p) => {
        atRiggingStart(p);
        inFlight(p);
        p.stage = 'plan-approved';
        dropSignoffs(p, (s) => s.stage === 'interview' || s.stage === 'plan-approved');
        for (const s of arr(obj(p.plan).steps).map(obj)) s.status = 'pending';
      }),
    );
    expect(codes(report)).toEqual([]);
    expect(report.warnings.map((w) => w.code)).toEqual(['STAGE_VALUES_STALE', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'QUESTION_SET_STALE', 'STAGE_LAGGING', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });

  test('a plan-approved sign-off dated on or after the stages arrived is not in flight: rigging without parts-review is refused', () => {
    const report = checkProject(
      historicalFixture((p) => {
        inFlight(p);
        // Every plan-approved sign-off, the re-sign included: the earliest one is what is read.
        for (const s of arr(p.signoffs).map(obj)) if (s.stage === 'plan-approved') s.at = PARTS_REVIEW_SINCE;
      }),
    );
    expect(codes(report)).toContain('PARTS_REVIEW_UNSIGNED');
    expect(report.warnings.map((w) => w.code)).not.toContain('PARTS_REVIEW_PREDATES_STAGE');
  });

  test('paused, it resumes where it would have before the stages existed', () => {
    const report = checkProject(
      historicalFixture((p) => {
        inFlight(p);
        p.stage = 'paused';
        dropSignoffs(p, (s) => s.stage !== 'rig-review' && s.stage !== 'post-interview' && s.stage !== 'direction-review');
        arr(p.signoffs).push({ stage: 'paused', checkpoint: null, by: 'user', at: '2026-10-13T10:00:00Z', verbatim: 'hold' });
      }),
    );
    expect(report.effective_stage).toBe('rig-review');
    expect(codes(report)).not.toContain('PARTS_REVIEW_UNSIGNED');
  });
});
