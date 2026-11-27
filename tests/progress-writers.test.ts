import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectItems } from '../src/check.ts';
import { applicableAsks, optionContext, sha256 } from '../src/choices.ts';
import { Refusal } from '../src/refusal.ts';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { isOpenInterviewArrivalStage, LEGACY_STAGE_VALUES, STAGE_ORDER_SPEC, STAGE_VALUES } from '../src/stages.ts';
import { PROGRESS_HISTORY_SINCE, signoffIdentity } from '../src/stage-progress.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { plantLegacyReopen, arr, bindFixtureAnswers, fixture, obj, rehashSignoffs, retainSignoffs, retimeFixture, step } from './fixtures.ts';
import { clockedCli, tempDir } from './helpers.ts';
import { directionFixture } from './direction-fixture.ts';
import { withPartsCheck } from './parts-check-fixture.ts';
import { seedStoredVerdict, seedStoredVersionSignoff } from './historical-review-fixture.ts';
import { checkProject, planCommand, advanceCommand, handoff, stepStatusCommand, signoffCommand, interviewAnswerCommand, interviewOptionsCommand, testClock } from './clock.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n');
const codes = (dir: string): string[] => checkProject(dir).refusals.map(f => f.code);
function words(dir: string): string { const path = join(dir, 'words.txt'); writeFileSync(path, '\uFEFFMove the synthetic project.\r\n'); return path; }
function advance(dir: string, stage = 'parts'): void { advanceCommand([stage, dir, '--source', 'synthetic approval']); }
function status(dir: string, id: string, value: string): void { stepStatusCommand([id, value, dir, '--by', 'agent']); }
function refused(dir: string, code: string, action: () => unknown): string {
  const before = readFileSync(join(dir, 'project.json'));
  let message = '';
  try { action(); throw new Error('expected planted refusal'); } catch (error) {
    expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code);
    message = (error as Refusal).message;
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  return message;
}
function partsProject(stage = 'plan-approved', split = false): string {
  return fixture(p => {
    p.stage = stage; p.versions = [];
    p.signoffs = arr(p.signoffs).slice(0, 2);
    retimeFixture(p, Date.parse('2026-11-16T00:00:00Z'));
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
    if (split) {
      obj(p.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-07T00:00:00Z' };
      p.stage_values = [...STAGE_VALUES];
    }
  });
}

function interviewArrival(stage: string): string {
  const dir = join(tempDir(), 'project');
  const checkpoint = stage === 'rigging-interview' ? '2-rigging-answers' : '3-rig-review';
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints', checkpoint), dir, { recursive: true });
  if (stage === 'rigging-interview') {
    const project = read(dir);
    project.stage = 'parts-review';
    project.advances = arr(project.advances ?? []).filter(raw => obj(raw).stage !== stage);
    save(dir, project);
  } else {
    seedStoredVerdict(dir, 1, { review: 'rig-review', verdict: 'accepted', by: 'user', at: testClock.now(), verbatim: readFileSync(words(dir), 'utf8'), source: 'synthetic approval' });
    seedStoredVersionSignoff(dir, 'rig-review', 1, { by: 'user', at: testClock.now(), verbatim: readFileSync(words(dir), 'utf8') });
    const project = read(dir);
    const complete = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-chain/project.json'), 'utf8')) as JsonObject;
    obj(project.plan).steps = [...arr(obj(project.plan).steps), ...arr(obj(complete.plan).steps)
      .filter(raw => obj(raw).phase === 'post').map(raw => ({ ...obj(raw), status: 'pending' }))];
    save(dir, project);
  }
  return dir;
}

beforeEach(() => testClock.set(new Date('2026-11-20T00:00:00Z')));
afterEach(() => testClock.reset());

test('the forward-advance allowance excludes the initial interview', () => {
  expect(isOpenInterviewArrivalStage('interview')).toBe(false);
});

test.each([
  [
    'rigging-interview',
    ['bones', 'meshes', 'constraints', 'turn', 'motion'].map(id => `interview.waypoints[${id}].guide`),
    'SIGNOFF_REASK_PENDING',
  ],
  [
    'post-interview',
    ['camera_depth', 'post_timing', 'post_composition'].map(id => `interview.post.items[${id}].guide`),
    'SIGNOFF_ANSWERS_UNANSWERED',
  ],
] as const)('advance admits only target-owned silent items on arrival at %s', (stage, paths, signoffCode) => {
  const dir = interviewArrival(stage);
  const before = read(dir);
  advance(dir, stage);
  const after = read(dir);
  expect(after.stage).toBe(stage);
  expect(after.interview).toEqual(before.interview);
  expect(after.signoffs).toEqual(before.signoffs);
  expect(arr(after.advances)).toHaveLength(arr(before.advances ?? []).length + 1);
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual(paths.map(path => ['INTERVIEW_INCOMPLETE', path]));
  expect(checkProject(dir).warnings).toEqual([]);
  refused(dir, signoffCode, () => signoffCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]));
});

test.each(['rigging-interview', 'post-interview'])('arrival at %s preserves unrelated candidate refusals', stage => {
  const dir = interviewArrival(stage);
  const project = read(dir);
  project.schema = 'invalid'; save(dir, project);
  refused(dir, 'SCHEMA_UNKNOWN', () => advance(dir, stage));
});

test('post-interview arrival refuses a silent item owned by an earlier interview', () => {
  const dir = interviewArrival('post-interview');
  const project = read(dir);
  obj(arr(obj(project.interview).waypoints).find(raw => obj(raw).id === 'bones')).guide = null;
  save(dir, project);
  expect(codes(dir)).toContain('WAYPOINT_SILENT');
  refused(dir, 'SIGNOFF_ANSWERS_STALE', () => advance(dir, 'post-interview'));
});

test.each([
  ['rigging-interview', 'rigging', 'WAYPOINT_SILENT'],
  ['post-interview', 'post', 'POST_ITEM_SILENT'],
] as const)('departure from %s refuses silent items', (stage, next, code) => {
  const dir = interviewArrival(stage);
  advance(dir, stage);
  expect(checkProject(dir, { ...read(dir), stage: next }).refusals.map(f => f.code)).toContain(code);
  // #981: no signoff is needed to depart; the candidate's own silent-item finding refuses the move.
  refused(dir, code, () => advance(dir, next));
});

test.each([
  ['rigging-interview', 'rigging', 'motion', 'WAYPOINT_SILENT'],
  ['post-interview', 'post', 'composition', 'POST_ITEM_SILENT'],
] as const)('departure from %s with valid authority still refuses a silent guide', (stage, next, unboundStep, code) => {
  const dir = interviewArrival(stage);
  const project = read(dir);
  // This step rests on another guide, leaving its own guide outside the answer hashes.
  step(project, unboundStep).rests_on = [stage === 'rigging-interview' ? 'bones' : 'camera_depth'];
  save(dir, project);
  advance(dir, stage);
  const ids = stage === 'rigging-interview' ? ['bones', 'meshes', 'constraints', 'motion'] : ['camera_depth', 'post_timing', 'post_composition'];
  for (const id of ids) {
    const current = read(dir);
    const item = collectItems(current, { collection: null }).find(item => item.id === id)!;
    const set = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-chain/evidence/interview', `${id}.json`), 'utf8'));
    set.id = `departure-${id}`; set.drafted_at = testClock.iso();
    set.context = optionContext(current, stage, testClock.now());
    const path = `evidence/interview/departure-${id}.json`;
    const bytes = JSON.stringify(set); writeFileSync(join(dir, path), bytes);
    interviewOptionsCommand([id, dir, '--file', path]);
    interviewAnswerCommand([id, dir, '--set', path, '--sha256', sha256(Buffer.from(bytes)), '--by', 'user',
      ...applicableAsks(current, item, set).flatMap(ask => ['--pick', `${ask}=keep`])]);
  }
  signoffCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  const approved = read(dir);
  const item = collectItems(approved, { collection: null }).find(item => item.id === ids.at(-1))!;
  expect(obj(obj(arr(approved.signoffs).at(-1)).answer_hashes)[item.id]).toBeUndefined();
  item.record.guide = null; save(dir, approved);
  refused(dir, code, () => advance(dir, next));
});

test.each([false, true])('lag control becomes green only through advance, split=%s', split => {
  const dir = partsProject('plan-approved', split);
  expect(codes(dir)).toEqual([]);
  const before = read(dir);
  advance(dir);
  const after = read(dir);
  expect(after.stage).toBe('parts'); expect(codes(dir)).toEqual([]);
  expect(after.signoffs).toEqual(before.signoffs);
  expect(after.stage_values).toEqual([...(split ? STAGE_VALUES : LEGACY_STAGE_VALUES)]);
  const entry = obj(arr(after.advances).at(-1));
  expect(entry).toMatchObject({ from_stage: 'plan-approved', stage: 'parts',
    at: '2026-11-20T00:00:00.000Z', source: 'synthetic approval', signoff: signoffIdentity(obj(arr(before.signoffs)[1])) });
  // The move rests on the person's signoff; it records no words or mover of its own.
  expect('by' in entry).toBe(false); expect('verbatim' in entry).toBe(false);
});

test('advance refuses a mover and words of its own with bytes identical', () => {
  const dir = partsProject('plan-approved');
  for (const flags of [['--by', 'owner'], ['--verbatim-file', words(dir)], ['--by', 'agent', '--verbatim-file', words(dir)]]) {
    refused(dir, 'ADVANCE_WORDS_REMOVED', () => advanceCommand(['parts', dir, ...flags]));
  }
});

test('an advance written with by and verbatim still checks clean; half of the pair does not', () => {
  const dir = partsProject('plan-approved');
  advance(dir); expect(codes(dir)).toEqual([]);
  const warnings = checkProject(dir).warnings;
  const p = read(dir); const entry = obj(arr(p.advances).at(-1));
  Object.assign(entry, { by: 'owner', verbatim: '\uFEFFMove the synthetic project.\r\n' }); save(dir, p);
  expect(codes(dir)).toEqual([]); expect(checkProject(dir).warnings).toEqual(warnings);
  delete entry.verbatim; save(dir, p);
  expect(codes(dir)).toEqual(['ADVANCE_MALFORMED']);
});

test.each([false, true])('signoff then advance uses the public CLI and reconciles stale stage_values, split=%s', split => {
  testClock.reset();
  const dir = partsProject('plan-approved', split); const p = read(dir);
  p.signoffs = arr(p.signoffs).slice(0, 1); p.stage_values = ['interview'];
  retimeFixture(p, testClock.now()); save(dir, p);
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  const result = Bun.spawnSync([process.execPath, ...clockedCli(), 'advance', 'parts', dir, '--json'], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe('');
  expect(JSON.parse(result.stdout.toString()).signoff).toEqual(signoffIdentity(obj(arr(read(dir).signoffs)[1])));
  expect(codes(dir)).toEqual([]); expect(checkProject(dir).warnings.map(f => f.code)).not.toContain('STAGE_VALUES_STALE');
});

test('step-status records the sequence, checkpoint approval and unchanged signed content', () => {
  const dir = partsProject('parts'); const hash = stepHash(step(read(dir), 'assemble'));
  const p = read(dir); delete step(p, 'assemble').status; save(dir, p);
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'owner', '--verbatim-file', words(dir)]);
  status(dir, 'assemble', 'done');
  const done = step(read(dir), 'assemble');
  expect(stepHash(done)).toBe(hash); expect(codes(dir)).toEqual([]);
  expect(obj(arr(done.status_history)[2])).toMatchObject({ from_status: 'at-checkpoint', status: 'done', by: 'agent', signoff: signoffIdentity(obj(arr(read(dir).signoffs)[2])) });
  const planted = read(dir); obj(arr(step(planted, 'assemble').status_history)[2]).signoff = signoffIdentity(obj(arr(planted.signoffs)[1])); save(dir, planted);
  expect(codes(dir)).toContain('STEP_STATUS_SIGNOFF');
});

test('a step without a checkpoint completes and then permits the bar-stage exit', () => {
  const dir = partsProject('parts');
  for (const id of ['seethrough', 'assemble']) {
    status(dir, id, 'in-progress'); status(dir, id, 'at-checkpoint');
    if (id === 'assemble') signoffCommand(['parts', dir, '--checkpoint', id, '--by', 'owner', '--verbatim-file', words(dir)]);
    status(dir, id, 'done');
  }
  expect(obj(arr(step(read(dir), 'seethrough').status_history)[2]).signoff).toBeNull();
  advanceCommand(['parts-review', dir, ...withPartsCheck(dir)]); expect(codes(dir)).toEqual([]);
  expect(obj(arr(read(dir).advances).at(-1)).signoff).toEqual(signoffIdentity(obj(arr(read(dir).signoffs)[1])));
});

test('status skip, reversal and an unrelated candidate refusal preserve bytes', () => {
  const dir = partsProject('parts');
  refused(dir, 'STEP_STATUS_TRANSITION', () => status(dir, 'assemble', 'done'));
  status(dir, 'assemble', 'in-progress');
  refused(dir, 'STEP_STATUS_TRANSITION', () => status(dir, 'assemble', 'pending'));
  const p = read(dir); p.schema = 'invalid'; save(dir, p);
  refused(dir, 'SCHEMA_UNKNOWN', () => status(dir, 'assemble', 'at-checkpoint'));
});

test('#981 after a reopen a checkpointed step completes again and history remains readable', () => {
  const dir = partsProject('parts');
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'owner', '--verbatim-file', words(dir)]);
  status(dir, 'assemble', 'done');
  testClock.set(new Date('2026-11-21T00:00:00Z'));
  plantLegacyReopen(dir, 'parts', { by: 'owner', wordsFile: words(dir) });
  expect(codes(dir)).toEqual([]);
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  status(dir, 'assemble', 'done');
  expect(codes(dir)).toEqual([]);
});

test('four-step guide names progress writers and stays under 10000 bytes', () => {
  const guide = renderAgentGuide();
  expect(Buffer.byteLength(guide)).toBeLessThan(10_000);
  expect(guide).toContain('advance <stage>'); expect(guide).toContain('step-status <id>');
});

test('an earlier re-signature leaves the furthest live target unchanged', () => {
  const dir = fixture(p => { p.stage = 'post-interview'; p.signoffs = arr(p.signoffs).filter(s => !['post-interview', 'direction-review'].includes(String(obj(s).stage))); for (const raw of arr(obj(p.plan).steps)) if (obj(raw).phase === 'post') obj(raw).status = 'pending'; });
  expect(codes(dir)).toEqual([]);
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(read(dir).stage).toBe('post-interview'); expect(codes(dir)).toEqual([]);
});

test('adopted signoff retains its existing candidate refusal without changing bytes', () => {
  const dir = partsProject('plan-approved', true); const p = read(dir); p.signoffs = arr(p.signoffs).slice(0, 1); p.schema = 'invalid'; save(dir, p);
  refused(dir, 'SCHEMA_UNKNOWN', () => signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]));
});

test('pre-parts history keeps its rigging checkpoint and bar exit through the writer', () => {
  const dir = fixture(p => {
    Object.assign(p, JSON.parse(JSON.stringify(p).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g,
      value => new Date(Date.parse(value) - 30 * 86_400_000).toISOString())));
    p.stage = 'rigging'; p.versions = [];
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts', 'rigging'].includes(String(obj(s).stage)));
    for (const raw of arr(p.signoffs)) {
      const signature = obj(raw); if (signature.stage === 'parts') signature.stage = 'rigging'; delete signature.answer_hashes;
    }
    for (const raw of arr(obj(p.plan).steps)) if (obj(raw).phase === 'post') obj(raw).status = 'pending';
    step(p, 'assemble').status = 'pending'; rehashSignoffs(p); bindFixtureAnswers(p);
  });
  expect(codes(dir)).toEqual([]);
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint'); status(dir, 'assemble', 'done');
  advance(dir, 'rig-review'); expect(codes(dir)).toEqual([]);
  expect(obj(arr(read(dir).advances).at(-1)).order).toBe('pre-parts');
});

test('no-post approval permits the explicit post-interview to accepted route', () => {
  const dir = fixture(p => {
    p.stage = 'post-interview'; p.versions = arr(p.versions).filter(v => obj(v).kind === 'rig');
    p.signoffs = arr(p.signoffs).filter(s => !['post-interview', 'direction-review'].includes(String(obj(s).stage)));
    obj(p.plan).steps = arr(obj(p.plan).steps).filter(s => obj(s).phase === 'rig');
    for (const raw of arr(obj(obj(p.interview).post).items)) obj(raw).guide = { not_applicable: true, because: 'No post work applies.', by: 'owner', at: '2026-11-20T00:00:00Z' };
    for (const raw of arr(p.signoffs)) delete obj(raw).answer_hashes;
    bindFixtureAnswers(p);
  });
  expect(codes(dir)).toEqual([]);
  signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual([]);
  advance(dir, 'accepted'); expect(codes(dir)).toEqual([]);
});

test('existing post-only direction fixture keeps the legacy scoped signoff contract', () => {
  const dir = join(tempDir(), 'authored');
  const existing = directionFixture(dir);
  expect(arr(existing.load().signoffs)).toHaveLength(2);
  expect(codes(dir)).toContain('WAYPOINT_MISSING');
});


test('stable stage and checkpoint identities survive reordering and unrelated signature insertion', () => {
  const dir = partsProject(); advance(dir);
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'owner', '--verbatim-file', words(dir)]);
  status(dir, 'assemble', 'done');
  const p = read(dir); const advanceIdentity = obj(arr(p.advances).at(-1)).signoff;
  const checkpointIdentity = obj(arr(step(p, 'assemble').status_history)[2]).signoff;
  p.signoffs = [...arr(p.signoffs)].reverse();
  arr(p.signoffs).unshift({ stage: 'interview', checkpoint: null, by: 'owner', at: '2026-11-01T00:00:00Z', verbatim: 'Unrelated history' });
  save(dir, p); expect(codes(dir)).toEqual([]);
  expect(obj(arr(read(dir).advances).at(-1)).signoff).toEqual(advanceIdentity);
  expect(obj(arr(step(read(dir), 'assemble').status_history)[2]).signoff).toEqual(checkpointIdentity);
  p.signoffs = arr(p.signoffs).filter(raw => obj(raw).checkpoint !== 'assemble'); save(dir, p);
  expect(codes(dir)).toContain('STEP_STATUS_SIGNOFF');
  p.signoffs = arr(p.signoffs).filter(raw => obj(raw).at !== obj(advanceIdentity).at); save(dir, p);
  expect(codes(dir)).toContain('ADVANCE_MALFORMED');
});


test('synthetic setup cleanup removes only audit entries dependent on removed signatures', () => {
  const dir = partsProject(); advance(dir);
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'owner', '--verbatim-file', words(dir)]);
  status(dir, 'assemble', 'done');
  const p = read(dir);
  p.advances = [arr(p.advances).at(-1)!];
  retainSignoffs(p, signature => signature.stage !== 'plan-approved');
  expect(p.advances).toEqual([]);
  expect(arr(step(p, 'assemble').status_history)).toHaveLength(3);
  retainSignoffs(p, signature => signature.checkpoint !== 'assemble');
  expect(arr(step(p, 'assemble').status_history)).toHaveLength(2);
});

test('step-status CLI records the same validated transition and JSON audit', () => {
  testClock.reset();
  const dir = partsProject('parts');
  const p = read(dir); retimeFixture(p, testClock.now()); save(dir, p);
  const started = testClock.now();
  const result = Bun.spawnSync([process.execPath, ...clockedCli(), 'step-status', 'seethrough', 'in-progress', dir, '--by', 'agent', '--json'], { stdout: 'pipe', stderr: 'pipe' });
  const finished = testClock.now();
  expect(result.stderr.toString()).toBe(''); expect(result.exitCode).toBe(0);
  const audit = JSON.parse(result.stdout.toString());
  expect(audit).toEqual({ from_status: 'pending', status: 'in-progress', by: 'agent', at: audit.at, checkpoint_required: false, signoff: null });
  expect(Date.parse(audit.at)).toBeGreaterThanOrEqual(started);
  expect(Date.parse(audit.at)).toBeLessThanOrEqual(finished);
  expect(arr(step(read(dir), 'seethrough').status_history)).toEqual([audit]);
  expect(codes(dir)).toEqual([]);
});


test('an unrelated legacy unreadable date stays history without poisoning the authority snapshot', () => {
  const dir = partsProject(); const p = read(dir);
  arr(p.signoffs).unshift({ ...obj(arr(p.signoffs)[0]), at: 'unreadable legacy date' }); save(dir, p);
  advance(dir);
  expect(codes(dir)).toEqual([]);
  expect(obj(arr(read(dir).signoffs)[0]).at).toBe('unreadable legacy date');
});

test.each([false, true])('historical checkpoint requirement survives reopen and checkpoint replanning, split=%s', split => {
  const dir = partsProject('parts', split);
  status(dir, 'seethrough', 'in-progress'); status(dir, 'seethrough', 'at-checkpoint'); status(dir, 'seethrough', 'done');
  const oldHistory = structuredClone(step(read(dir), 'seethrough').status_history);
  expect(obj(arr(oldHistory)[2]).signoff).toBeNull();
  testClock.set(new Date('2026-11-21T00:00:00Z'));
  plantLegacyReopen(dir, 'plan-approved', { by: 'owner', wordsFile: words(dir) });
  const draft = read(dir);
  step(draft, 'seethrough').checkpoint = null;
  step(draft, 'seethrough').checkpoint_proposed = true;
  obj(draft.plan).drafted_at = '2026-11-21T00:01:00Z'; save(dir, draft);
  testClock.set(new Date('2026-11-21T00:02:00Z'));
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual([]);
  advance(dir);
  expect(codes(dir)).toEqual([]);
  expect(step(read(dir), 'seethrough').status_history).toEqual(oldHistory);
  expect(obj(arr(oldHistory)[2]).checkpoint_required).toBe(false);
  status(dir, 'seethrough', 'in-progress'); status(dir, 'seethrough', 'at-checkpoint');
  signoffCommand(['parts', dir, '--checkpoint', 'seethrough', '--by', 'owner', '--verbatim-file', words(dir)]);
  status(dir, 'seethrough', 'done');
  expect(codes(dir)).toEqual([]);
  expect(obj(arr(step(read(dir), 'seethrough').status_history).at(-1))).toMatchObject({ checkpoint_required: true,
    signoff: { stage: 'parts', checkpoint: 'seethrough', at: '2026-11-21T00:02:00.000Z' } });
});

test('historical no-post advance survives reopened applicable post answers', () => {
  const dir = fixture(p => {
    p.stage = 'post-interview'; p.versions = arr(p.versions).filter(v => obj(v).kind === 'rig');
    retainSignoffs(p, s => !['post-interview', 'direction-review'].includes(String(s.stage)));
    obj(p.plan).steps = arr(obj(p.plan).steps).filter(s => obj(s).phase === 'rig');
    for (const raw of arr(obj(obj(p.interview).post).items)) obj(raw).guide = { not_applicable: true, because: 'No post work applies.', by: 'owner', at: '2026-11-20T00:00:00Z' };
    for (const raw of arr(p.signoffs)) delete obj(raw).answer_hashes;
    bindFixtureAnswers(p);
  });
  signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  advance(dir, 'accepted');
  const oldAdvanceIndex = arr(read(dir).advances).length - 1;
  const oldAdvance = structuredClone(arr(read(dir).advances)[oldAdvanceIndex]);
  testClock.set(new Date('2026-11-21T00:00:00Z'));
  plantLegacyReopen(dir, 'post-interview', { by: 'owner', wordsFile: words(dir) });
  const draft = read(dir);
  const camera = obj(arr(obj(obj(draft.interview).post).items).find(raw => obj(raw).id === 'camera_depth'));
  camera.history = [...arr(camera.history ?? []), camera.guide!];
  camera.guide = { delegated: false, value: 'A small camera move.', verbatim: 'A small camera move.', by: 'owner', at: '2026-11-21T00:01:00Z' };
  const postStep = { id: 'camera', phase: 'post', order: 1, does: 'Author the camera move', produces: 'A direction document',
    rests_on: ['camera_depth'], bar: 'the direction keys validate', checkpoint_proposed: false, checkpoint: null, status: 'pending' };
  arr(obj(draft.plan).steps).push(postStep); save(dir, draft);
  testClock.set(new Date('2026-11-21T00:02:00Z'));
  signoffCommand(['interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual([]);
  signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual([]);
  advance(dir, 'post');
  expect(codes(dir)).toEqual([]);
  expect(arr(read(dir).advances)[oldAdvanceIndex]).toEqual(oldAdvance);
  expect(obj(oldAdvance).post_not_passed).toBe(true);
  expect(obj(arr(read(dir).advances).at(-1)).post_not_passed).toBe(false);
  const malformed = read(dir);
  // #981: false is a readable flag on a skipping move; only a missing or non-boolean flag is malformed.
  for (const invalid of [undefined, 'yes']) {
    const entry = obj(arr(malformed.advances)[oldAdvanceIndex]);
    if (invalid === undefined) delete entry.post_not_passed; else entry.post_not_passed = invalid;
    save(dir, malformed); expect(codes(dir)).toContain('ADVANCE_MALFORMED');
  }
});


test('historical required checkpoint approval survives a later disabled checkpoint', () => {
  const dir = partsProject('parts');
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'owner', '--verbatim-file', words(dir)]);
  status(dir, 'assemble', 'done');
  const original = structuredClone(step(read(dir), 'assemble').status_history);
  testClock.set(new Date('2026-11-21T00:00:00Z'));
  plantLegacyReopen(dir, 'plan-approved', { by: 'owner', wordsFile: words(dir) });
  const draft = read(dir); step(draft, 'assemble').checkpoint = null; step(draft, 'assemble').checkpoint_proposed = false; save(dir, draft);
  testClock.set(new Date('2026-11-21T00:01:00Z'));
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  advance(dir);
  expect(codes(dir)).toEqual([]);
  expect(step(read(dir), 'assemble').status_history).toEqual(original);
});

test('historical status entries require an explicit boolean checkpoint snapshot', () => {
  const dir = partsProject('parts'); status(dir, 'seethrough', 'in-progress');
  const malformed = read(dir);
  for (const invalid of [undefined, 'yes']) {
    const entry = obj(arr(step(malformed, 'seethrough').status_history)[0]);
    if (invalid === undefined) delete entry.checkpoint_required; else entry.checkpoint_required = invalid;
    save(dir, malformed); expect(codes(dir)).toContain('STEP_STATUS_TRANSITION');
  }
});

const warned = (dir: string): string[] => checkProject(dir).warnings.map(f => f.code);
const linkage = (dir: string, list: 'refusals' | 'warnings' = 'refusals'): string[][] => checkProject(dir)[list]
  .filter(f => f.code.endsWith('_UNLINKED')).map(f => [f.code, f.path]);
const entry = (from: string, to: string, at: string): JsonObject => ({ from_status: from, status: to, by: 'agent', at, checkpoint_required: false, signoff: null });

test('writer-made status and advance history links through historical same-clock reopen resets', () => {
  const dir = partsProject(); advance(dir);
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'owner', '--verbatim-file', words(dir)]);
  status(dir, 'assemble', 'done');
  plantLegacyReopen(dir, 'parts', { by: 'owner', wordsFile: words(dir) });
  status(dir, 'assemble', 'in-progress');
  expect(codes(dir)).toEqual([]);
  expect(linkage(dir, 'warnings')).toEqual([]);
});

test('a planted status gap is refused by check, and a carried gap does not block another step', () => {
  const dir = partsProject('parts');
  status(dir, 'assemble', 'in-progress');
  const gap = read(dir); step(gap, 'assemble').status = 'at-checkpoint'; save(dir, gap);
  expect(linkage(dir)).toEqual([['STEP_STATUS_UNLINKED', 'plan.steps[assemble].status']]);
  status(dir, 'seethrough', 'in-progress');
  expect(linkage(dir)).toEqual([['STEP_STATUS_UNLINKED', 'plan.steps[assemble].status']]);
  save(dir, gap);
  // The writer reads the hand-set status, so its next entry carries the gap into history.
  const hidden = read(dir); arr(step(hidden, 'assemble').status_history).push(entry('at-checkpoint', 'done', '2026-11-20T00:00:00Z'));
  step(hidden, 'assemble').status = 'done'; save(dir, hidden);
  expect(linkage(dir)).toEqual([['STEP_STATUS_UNLINKED', 'plan.steps[assemble].status_history[1]']]);
});

test.each(['2026-11-20T00:00:00Z', '2026-11-20T00:05:00Z'])('a reordered status entry is refused, second entry at %s', second => {
  const dir = partsProject('parts'); const p = read(dir);
  step(p, 'assemble').status_history = [entry('in-progress', 'at-checkpoint', second), entry('pending', 'in-progress', '2026-11-20T00:00:00Z')];
  step(p, 'assemble').status = 'at-checkpoint'; save(dir, p);
  expect(linkage(dir).map(([, path]) => path)).toContain('plan.steps[assemble].status_history[0]');
  expect(linkage(dir).map(([, path]) => path)).toContain('plan.steps[assemble].status_history[1]');
});

test('a planted advance gap and a reordered advance are refused', () => {
  const dir = partsProject('parts'); const p = read(dir);
  const recorded = structuredClone(arr(p.advances));
  expect(recorded.map(raw => [obj(raw).from_stage, obj(raw).stage])).toEqual([['interview', 'plan-approved'], ['plan-approved', 'parts']]);
  p.advances = [recorded[1]!]; save(dir, p);
  expect(linkage(dir)).toEqual([['STAGE_MOVE_UNLINKED', 'advances[0]']]);
  p.advances = [recorded[1]!, recorded[0]!]; save(dir, p);
  expect(linkage(dir)).toEqual([['STAGE_MOVE_UNLINKED', 'advances[1]']]);
  p.advances = recorded; save(dir, p);
  expect(codes(dir)).toEqual([]);
});

test('a link break warns when its latest preceding event predates PROGRESS_HISTORY_SINCE and refuses from it', () => {
  testClock.reset();
  const dir = partsProject('parts'); const p = read(dir);
  retimeFixture(p, Date.parse('2026-11-07T12:00:00Z'));
  const recorded = structuredClone(arr(p.advances));
  p.advances = [recorded[1]!];
  step(p, 'assemble').status_history = [entry('pending', 'in-progress', '2026-11-07T13:00:00Z')];
  step(p, 'assemble').status = 'at-checkpoint'; save(dir, p);
  expect(linkage(dir)).toEqual([]);
  expect(linkage(dir, 'warnings')).toEqual([['STAGE_MOVE_UNLINKED', 'advances[0]'], ['STEP_STATUS_UNLINKED', 'plan.steps[assemble].status']]);
  step(p, 'assemble').status_history = [entry('pending', 'in-progress', PROGRESS_HISTORY_SINCE)]; save(dir, p);
  expect(linkage(dir)).toEqual([['STEP_STATUS_UNLINKED', 'plan.steps[assemble].status']]);
});

// #221: each refusal names the code of its cause and the writer that clears it.

test('a rig acceptance lapsed by a reopen is named with the reopen, not reported as missing', () => {
  const dir = join(tempDir(), 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain'), dir, { recursive: true });
  plantLegacyReopen(dir, 'rig-review', { by: 'owner', wordsFile: words(dir) });
  testClock.set(new Date('2026-11-20T00:01:00Z'));
  refused(dir, 'NUMBERED_WRITER_REMOVED', () => signoffCommand(['rig-review', dir, '--by', 'owner', '--verbatim-file', words(dir)]));
  // A signature recorded before #243 is not refused at rig-review; handoff still stops on it (#981: advance does not).
  const reviewed = read(dir);
  const earlier = arr(reviewed.signoffs).map(obj).find(s => s.stage === 'rig-review')!;
  const carried = codes(dir);
  arr(reviewed.signoffs).push({ ...earlier, by: 'owner', at: '2026-11-20T00:01:00.000Z', verbatim: 'Sign the synthetic rig.' });
  save(dir, reviewed);
  // No rig refusal at rig-review (#981: nor a lagging-stage finding).
  expect(codes(dir)).toEqual(carried);
  expect(checkProject(dir).warnings.map(f => f.code)).not.toContain('RIG_VERSION_UNACCEPTED');
  const message = refused(dir, 'RIG_VERSION_UNACCEPTED', () => handoff(dir, null));
  expect(message).toContain('versions[v1].verdicts[0]');
  expect(message).toContain('(reopens[0])');
  expect(message).toContain('rig-create rig-version <n>');
  expect(message).toContain('rig-create review <n> --verdict accepted');
});

test('a skipped or finished step status names the next writer call', () => {
  const dir = partsProject('parts');
  expect(refused(dir, 'STEP_STATUS_TRANSITION', () => status(dir, 'seethrough', 'done'))).toContain('rig-create step-status seethrough in-progress next');
  status(dir, 'assemble', 'in-progress');
  expect(refused(dir, 'STEP_STATUS_TRANSITION', () => status(dir, 'assemble', 'done'))).toContain('rig-create step-status assemble at-checkpoint next');
  status(dir, 'seethrough', 'in-progress'); status(dir, 'seethrough', 'at-checkpoint'); status(dir, 'seethrough', 'done');
  // #981: a done step runs again through in-progress, with no amendment.
  expect(refused(dir, 'STEP_STATUS_TRANSITION', () => status(dir, 'seethrough', 'done'))).toContain('rig-create step-status seethrough in-progress next');
});

test('#681 a step without a checkpoint goes from in-progress straight to done; a checkpointed one keeps the hop', () => {
  const dir = partsProject('parts');
  status(dir, 'seethrough', 'in-progress'); status(dir, 'seethrough', 'done');
  expect(arr(step(read(dir), 'seethrough').status_history).map(raw => [obj(raw).from_status, obj(raw).status, obj(raw).checkpoint_required]))
    .toEqual([['pending', 'in-progress', false], ['in-progress', 'done', false]]);
  expect(codes(dir)).toEqual([]);
  status(dir, 'assemble', 'in-progress');
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'owner', '--verbatim-file', words(dir)]);
  refused(dir, 'STEP_STATUS_TRANSITION', () => status(dir, 'assemble', 'done'));
  // A hand-written skip on a checkpointed step is refused by the check as by the writer.
  const planted = read(dir);
  const assemble = step(planted, 'assemble');
  assemble.status_history = [...arr(assemble.status_history), { from_status: 'in-progress', status: 'done', by: 'agent', at: '2026-11-20T00:00:00.000Z', checkpoint_required: true, signoff: null }];
  assemble.status = 'done';
  save(dir, planted);
  expect(codes(dir)).toContain('STEP_STATUS_TRANSITION');
});


test('operator withdrawal through public CLI preserves signed content and releases the normal bar', () => {
  const dir = partsProject('parts');
  const reason = join(dir, 'withdraw-reason.txt');
  const quote = join(dir, 'withdraw-quote.txt');
  writeFileSync(reason, 'The operator retires this checkpoint.\n');
  writeFileSync(quote, 'Include this evidence in the later parts review.\n');
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  const before = read(dir);
  const hash = stepHash(step(before, 'assemble'));
  const args = ['plan', 'checkpoint-withdraw', 'assemble', dir, '--by', 'operator', '--reason-file', reason, '--quote-file', quote, '--json'];
  const result = Bun.spawnSync([process.execPath, ...clockedCli(), ...args], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  const withdrawn = read(dir);
  expect(step(withdrawn, 'assemble')).toEqual(step(before, 'assemble'));
  expect(stepHash(step(withdrawn, 'assemble'))).toBe(hash);
  expect(withdrawn.signoffs).toEqual(before.signoffs);
  const bytes = readFileSync(join(dir, 'project.json'));
  expect(Bun.spawnSync([process.execPath, ...clockedCli(), ...args], { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
  status(dir, 'assemble', 'done');
  expect(obj(arr(step(read(dir), 'assemble').status_history).at(-1))).toMatchObject({ checkpoint_required: false, signoff: null });
  status(dir, 'seethrough', 'in-progress'); status(dir, 'seethrough', 'at-checkpoint'); status(dir, 'seethrough', 'done');
  advanceCommand(['parts-review', dir, ...withPartsCheck(dir)]);
  expect(codes(dir)).toEqual([]);
  expect(stepHash(step(read(dir), 'assemble'))).toBe(hash);
});


test('withdrawal refuses missing text, authored patches, locks, a disabled checkpoint and conflicting replay without writes', () => {
  const dir = partsProject('parts');
  const reason = join(dir, 'reason.txt'); const quote = join(dir, 'quote.txt');
  writeFileSync(reason, '\uFEFFRetire one synthetic checkpoint.\r\n'); writeFileSync(quote, 'Keep the evidence.\n');
  const args = ['checkpoint-withdraw', 'assemble', dir, '--by', 'operator', '--reason-file', reason, '--quote-file', quote];
  refused(dir, 'PLAN_OPTION_INVALID', () => planCommand(args.filter(value => value !== '--by' && value !== 'operator')));
  refused(dir, 'PLAN_OPTION_INVALID', () => planCommand([...args, '--bar', 'Changed signed content.']));
  refused(dir, 'CHECKPOINT_WITHDRAWAL_SCOPE', () => planCommand(args.map(value => value === 'assemble' ? 'seethrough' : value)));
  writeFileSync(reason, '  ');
  refused(dir, 'PLAN_OPTION_INVALID', () => planCommand(args));
  writeFileSync(reason, '\uFEFFRetire one synthetic checkpoint.\r\n');
  writeFileSync(join(dir, '.plan.lock'), 'another writer');
  refused(dir, 'PLAN_WRITE_CONFLICT', () => planCommand(args));
  unlinkSync(join(dir, '.plan.lock'));
  const before = read(dir);
  expect(planCommand(args).exit).toBe(0);
  const after = read(dir);
  const entry = obj(arr(obj(after.plan).checkpoint_withdrawals)[0]);
  expect(entry).toMatchObject({ by: 'operator', reason: '\uFEFFRetire one synthetic checkpoint.\r\n', verbatim: 'Keep the evidence.\n', sha256: stepHash(step(before, 'assemble')), generation: 0 });
  expect(obj(after.plan).steps).toEqual(obj(before.plan).steps);
  expect(after.signoffs).toEqual(before.signoffs);
  writeFileSync(quote, 'Different words.');
  refused(dir, 'CHECKPOINT_WITHDRAWAL_CONFLICT', () => planCommand(args));
});


test('step-status note round-trips verbatim without changing signed content; old entries omit both keys', () => {
  const dir = partsProject('parts');
  const hash = stepHash(step(read(dir), 'seethrough'));
  const note = '\uFEFF  Synthetic execution note.\n다음 단계에서 확인.\n';
  const path = join(dir, 'note.txt'); writeFileSync(path, note);
  const result = stepStatusCommand(['seethrough', 'in-progress', dir, '--by', 'agent', '--note-file', path, '--json']);
  const entry = obj(arr(step(read(dir), 'seethrough').status_history).at(-1));
  expect(entry.note).toBe(note);
  expect(entry.note_sha256).toBe(sha256(readFileSync(path)));
  expect(JSON.parse(result.stdout)).toEqual(entry);
  expect(stepHash(step(read(dir), 'seethrough'))).toBe(hash);
  expect(codes(dir)).toEqual([]);
  status(dir, 'seethrough', 'at-checkpoint');
  const old = obj(arr(step(read(dir), 'seethrough').status_history).at(-1));
  expect('note' in old).toBe(false); expect('note_sha256' in old).toBe(false);
  expect(codes(dir)).toEqual([]);
});

test('invalid note files refuse before writing any project bytes', () => {
  const dir = partsProject('parts'); const path = join(dir, 'note.txt');
  const run = (): unknown => stepStatusCommand(['seethrough', 'in-progress', dir, '--by', 'agent', '--note-file', path]);
  refused(dir, 'PROGRESS_OPTION_INVALID', run);
  for (const content of ['', 'é'.repeat(501), 'tab\there', 'carriage\rreturn', 'nul\0here', '\u0085', Buffer.from([0xff])]) {
    writeFileSync(path, content); refused(dir, 'PROGRESS_OPTION_INVALID', run);
  }
  writeFileSync(path, 'é'.repeat(500)); run(); expect(codes(dir)).toEqual([]);
});

test('check refuses mismatched or incomplete status-history notes', () => {
  const dir = partsProject('parts'); status(dir, 'seethrough', 'in-progress');
  const original = read(dir);
  for (const note of [{ note: 'synthetic', note_sha256: '0'.repeat(64) }, { note: 'synthetic' },
    { note_sha256: '0'.repeat(64) }, { note: null, note_sha256: null }]) {
    const planted = structuredClone(original);
    Object.assign(obj(arr(step(planted, 'seethrough').status_history)[0]), note); save(dir, planted);
    expect(codes(dir)).toContain('PROGRESS_OPTION_INVALID');
  }
  save(dir, original); expect(codes(dir)).toEqual([]);
});

test('#514 explicit fresh turn-question adoption refuses a removed required waypoint', () => {
  const dir = fixture(p => {
    const interview = obj(p.interview);
    interview.date = '2026-11-14T01:00:00Z';
    interview.waypoints = arr(interview.waypoints).filter(w => obj(w).id !== 'turn');
  }, 'project.json');
  expect(checkProject(dir).refusals).toContainEqual(expect.objectContaining({ code: 'WAYPOINT_MISSING', path: 'interview.waypoints[turn]' }));
});

test('#514 a later date alone does not retrofit the new question into historical interviews', () => {
  const dir = fixture(p => { obj(p.interview).date = '2026-11-14T01:00:00Z'; });
  expect(checkProject(dir).refusals).not.toContainEqual(expect.objectContaining({ code: 'WAYPOINT_MISSING', path: 'interview.waypoints[turn]' }));
});
