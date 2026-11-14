import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { optionContext, sha256 } from '../src/choices.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';
import { arr, fixture, framing, obj, waypoint } from './fixtures.ts';
import { checkProject, interviewAnswerCommand, interviewDecisionCommand, interviewOptionsCommand, testClock } from './clock.ts';

afterEach(() => testClock.reset());
const draftAt = EXAMPLE_ANCHOR + 3 * 60_000;

function transition(value: string) {
  let setPath = '';
  const dir = fixture(p => {
    setPath = String(obj(obj(obj(framing(p, 'rig_type').answer).choice).set).path);
    p.stage = 'interview';
    p.signoffs = [];
    for (const step of arr(obj(p.plan).steps)) obj(step).status = 'pending';
    for (const item of arr(obj(obj(p.interview).post).items)) obj(item).guide = null;
    for (const id of ['bones', 'meshes', 'constraints', 'turn', 'motion']) waypoint(p, id).guide = null;
    // Preserve existing versions, whose missing configs are held only for CG values.
    for (const version of arr(p.versions)) delete obj(obj(version).provenance).config;
    framing(p, 'rig_type').answer = {
      delegated: false, by: 'user', at: new Date(draftAt - 1_000).toISOString(),
      verbatim: 'Use the recorded rig type.', value,
    };
  }, 'example-project.json');
  const file = join(dir, 'project.json');
  const set = JSON.parse(readFileSync(join(dir, setPath), 'utf8')) as JsonObject;
  set.id = 'transition-rig-type';
  set.drafted_at = new Date(draftAt).toISOString();
  set.context = optionContext(JSON.parse(readFileSync(file, 'utf8')) as JsonObject, String(set.stage), Date.parse(set.drafted_at));
  const path = 'evidence/interview/transition-rig-type.json';
  const bytes = JSON.stringify(set, null, 2) + '\n';
  writeFileSync(join(dir, path), bytes);
  testClock.set(draftAt + 1_000);
  interviewOptionsCommand(['rig_type', dir, '--file', path]);
  interviewAnswerCommand(['rig_type', dir, '--set', path, '--sha256', sha256(Buffer.from(bytes)), '--by', 'user', '--pick', `rig_type=${value === 'character.idle' ? 'keep' : 'alternative'}`]);
  interviewOptionsCommand(['rig_type', dir, '--file', path]);
  const before = checkProject(dir).refusals.map(f => `${f.code}:${f.path}`).sort();
  interviewAnswerCommand(['rig_type', dir, '--set', path, '--sha256', sha256(Buffer.from(bytes)), '--by', 'user', '--pick', 'rig_type=auto']);
  writeFileSync(join(dir, 'reason.txt'), 'Retain the same rig type with corrected reasoning.');
  const decide = (next: string) => {
    writeFileSync(join(dir, 'fragment.json'), JSON.stringify(next));
    return interviewDecisionCommand(['rig_type', dir, '--by', 'agent', '--reasoning-file', join(dir, 'reason.txt'), '--fragment', `rig_type=${join(dir, 'fragment.json')}`]);
  };
  const pend = () => {
    interviewOptionsCommand(['rig_type', dir, '--file', path]);
    interviewAnswerCommand(['rig_type', dir, '--set', path, '--sha256', sha256(Buffer.from(bytes)), '--by', 'user', '--pick', 'rig_type=auto']);
  };
  return { dir, file, before, decide, pend, path, sha256: sha256(Buffer.from(bytes)) };
}

test('auto then the same decision preserves pre-transition CG refusals', () => {
  const w = transition('fullscreen.minimal');
  expect(w.before.some(f => f.startsWith('CG_GATES_UNREAD:'))).toBe(true);
  expect(checkProject(w.dir).refusals.some(f => f.code === 'CG_GATES_UNREAD')).toBe(false);
  w.decide('fullscreen.minimal');
  expect(checkProject(w.dir).refusals.map(f => `${f.code}:${f.path}`).sort()).toEqual(w.before);
});

test('a decision introducing CG refusals is refused without writing', () => {
  const w = transition('character.idle');
  const before = readFileSync(w.file);
  try {
    w.decide('fullscreen.minimal');
    throw new Error('expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe('CG_GATES_UNREAD');
    expect((error as Refusal).exitCode).toBe(1);
  }
  expect(readFileSync(w.file)).toEqual(before);
});

function rewrite(w: ReturnType<typeof transition>, edit: (project: JsonObject) => void): void {
  const project = JSON.parse(readFileSync(w.file, 'utf8')) as JsonObject;
  edit(project);
  writeFileSync(w.file, JSON.stringify(project, null, 2) + '\n');
}

function refused(w: ReturnType<typeof transition>, value: string, code: string): void {
  const before = readFileSync(w.file);
  let error: unknown;
  try { w.decide(value); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Refusal);
  expect((error as Refusal).code).toBe(code);
  expect(readFileSync(w.file)).toEqual(before);
}

test('a version added while pending cannot borrow another version baseline', () => {
  const w = transition('fullscreen.minimal');
  rewrite(w, project => {
    const version = structuredClone(obj(arr(project.versions)[0]));
    version.n = 99;
    arr(project.versions).push(version);
  });
  refused(w, 'fullscreen.minimal', 'CG_GATES_UNREAD');
});

test('older pending answers without a baseline keep the strict guard', () => {
  const w = transition('fullscreen.minimal');
  rewrite(w, project => { delete obj(framing(project, 'rig_type').answer).refusal_baseline; });
  refused(w, 'fullscreen.minimal', 'CG_GATES_UNREAD');
});

test('a decided answer cannot reuse its pending baseline for a later decision', () => {
  const w = transition('fullscreen.minimal');
  w.decide('character.idle');
  refused(w, 'fullscreen.minimal', 'CG_GATES_UNREAD');
});

test('a new pending transition records a fresh baseline and preserves history', () => {
  const w = transition('fullscreen.minimal');
  w.decide('character.idle');
  w.pend();
  const project = JSON.parse(readFileSync(w.file, 'utf8')) as JsonObject;
  const record = framing(project, 'rig_type');
  const answer = obj(record.answer);
  expect(arr(answer.refusal_baseline).some(entry => obj(entry).code === 'CG_GATES_UNREAD')).toBe(false);
  expect(arr(record.history).some(entry => (Array.isArray(obj(entry).refusal_baseline) ? arr(obj(entry).refusal_baseline) : []).some(f => obj(f).code === 'CG_GATES_UNREAD'))).toBe(true);
  refused(w, 'fullscreen.minimal', 'CG_GATES_UNREAD');
});

test('malformed baselines are invalid in both check and decision without writing', () => {
  for (const baseline of [null, {}, [null], [{code: '', path: 'versions[v1]', count: 1}],
    [{code: 'CG_GATES_UNREAD', path: ' ', count: 1}],
    [{code: 'CG_GATES_UNREAD', path: 'versions[v1]', count: 0}],
    [{code: 'CG_GATES_UNREAD', path: 'versions[v1]', count: 1.5}],
    [{code: 'CG_GATES_UNREAD', path: 'versions[v1]', count: 1, extra: true}]]) {
    const w = transition('fullscreen.minimal');
    rewrite(w, project => { obj(framing(project, 'rig_type').answer).refusal_baseline = baseline; });
    expect(checkProject(w.dir).refusals.some(f => f.code === 'INTERVIEW_CHOICE_INVALID')).toBe(true);
    refused(w, 'fullscreen.minimal', 'INTERVIEW_CHOICE_INVALID');
  }
});

/** A check that stopped early is no baseline (docs/PROJECT.md § Refusals a record already carries). */
function unknownStage(w: ReturnType<typeof transition>): void {
  rewrite(w, project => { project.stage = 'no-such-stage'; });
  expect(checkProject(w.dir).refusals.map(f => f.code)).toEqual(['STAGE_UNKNOWN']);
}
function refusedWrite(w: ReturnType<typeof transition>, code: string, write: () => unknown): void {
  const before = readFileSync(w.file);
  let error: unknown;
  try { write(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Refusal);
  expect((error as Refusal).code).toBe(code);
  expect(readFileSync(w.file)).toEqual(before);
}

test('the decision writer is refused on a record whose stage check stopped early', () => {
  const w = transition('fullscreen.minimal');
  unknownStage(w);
  refused(w, 'fullscreen.minimal', 'STAGE_UNKNOWN');
});

test('a stored pending baseline does not stand in for a check that stopped early', () => {
  const w = transition('fullscreen.minimal');
  rewrite(w, project => {
    const answer = obj(framing(project, 'rig_type').answer);
    answer.refusal_baseline = [...arr(answer.refusal_baseline), { code: 'STAGE_UNKNOWN', path: 'stage', count: 1 }];
  });
  unknownStage(w);
  refused(w, 'fullscreen.minimal', 'STAGE_UNKNOWN');
});

test('the options writer is refused on a record whose stage check stopped early', () => {
  const w = transition('fullscreen.minimal');
  w.decide('fullscreen.minimal');
  unknownStage(w);
  refusedWrite(w, 'STAGE_UNKNOWN', () => interviewOptionsCommand(['rig_type', w.dir, '--file', w.path]));
});

test('the answer writer is refused on a record whose stage check stopped early', () => {
  const w = transition('fullscreen.minimal');
  w.decide('fullscreen.minimal');
  interviewOptionsCommand(['rig_type', w.dir, '--file', w.path]);
  unknownStage(w);
  refusedWrite(w, 'STAGE_UNKNOWN', () => interviewAnswerCommand(['rig_type', w.dir, '--set', w.path, '--sha256', w.sha256, '--by', 'user', '--pick', 'rig_type=keep']));
});
