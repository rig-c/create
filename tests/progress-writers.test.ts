import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectItems } from '../src/check.ts';
import { applicableAsks, optionContext, sha256 } from '../src/choices.ts';
import { Refusal } from '../src/refusal.ts';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { LEGACY_STAGE_VALUES, STAGE_ORDER_SPEC, STAGE_VALUES } from '../src/stages.ts';
import { PROGRESS_HISTORY_SINCE, signoffIdentity, STAGE_PROGRESS_SINCE } from '../src/stage-progress.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, bindFixtureAnswers, fixture, obj, rehashSignoffs, retainSignoffs, retimeFixture, step } from './fixtures.ts';
import { clockedCli, tempDir } from './helpers.ts';
import { directionFixture } from './direction-fixture.ts';
import { withPartsCheck } from './parts-check-fixture.ts';
import { checkProject, advanceCommand, stepStatusCommand, signoffCommand, reopenCommand, reviewCommand, interviewAnswerCommand, interviewOptionsCommand, testClock } from './clock.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n');
const codes = (dir: string): string[] => checkProject(dir).refusals.map(f => f.code);
function words(dir: string): string { const path = join(dir, 'words.txt'); writeFileSync(path, '\uFEFFMove the synthetic project.\r\n'); return path; }
function advance(dir: string, stage = 'parts'): void { advanceCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir), '--source', 'synthetic approval']); }
function status(dir: string, id: string, value: string): void { stepStatusCommand([id, value, dir, '--by', 'agent']); }
function refused(dir: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  try { action(); throw new Error('expected planted refusal'); } catch (error) {
    expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code);
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
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
    reviewCommand(['1', dir, '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review', '--verbatim-file', words(dir), '--source', 'synthetic approval']);
    signoffCommand(['rig-review', dir, '--by', 'user', '--version', '1', '--verbatim-file', words(dir)]);
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

test.each([
  ['rigging-interview', ['bones', 'meshes', 'constraints', 'motion'].map(id => `interview.waypoints[${id}].guide`)],
  ['post-interview', ['camera_depth', 'post_timing', 'post_composition'].map(id => `interview.post.items[${id}].guide`)],
] as const)('advance admits only target-owned silent items on arrival at %s', (stage, paths) => {
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
  refused(dir, 'SIGNOFF_ANSWERS_UNANSWERED', () => signoffCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]));
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
  refused(dir, 'ADVANCE_MALFORMED', () => advance(dir, next));
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
  expect(codes(dir)).toEqual(['STAGE_LAGGING']);
  const before = read(dir);
  advance(dir);
  const after = read(dir);
  expect(after.stage).toBe('parts'); expect(codes(dir)).toEqual([]);
  expect(after.signoffs).toEqual(before.signoffs);
  expect(after.stage_values).toEqual([...(split ? STAGE_VALUES : LEGACY_STAGE_VALUES)]);
  expect(obj(arr(after.advances).at(-1))).toMatchObject({ from_stage: 'plan-approved', stage: 'parts', by: 'owner',
    at: '2026-11-20T00:00:00.000Z', verbatim: '\uFEFFMove the synthetic project.\r\n', source: 'synthetic approval', signoff: signoffIdentity(obj(arr(before.signoffs)[1])) });
});

test('hand-set skip and writer skip are refused with original bytes retained', () => {
  const dir = partsProject('parts-review');
  expect(codes(dir)).toContain('STAGE_SKIPPED');
  const p = read(dir); p.stage = 'plan-approved'; save(dir, p);
  refused(dir, 'ADVANCE_MALFORMED', () => advance(dir, 'parts-review'));
});

test('agent, repeated move and a target beyond authority leave bytes identical', () => {
  const dir = partsProject();
  refused(dir, 'ADVANCE_MALFORMED', () => advanceCommand(['parts', dir, '--by', 'agent', '--verbatim-file', words(dir)]));
  advance(dir);
  refused(dir, 'ADVANCE_MALFORMED', () => advance(dir));
  refused(dir, 'PARTS_BAR_UNMET', () => advance(dir, 'parts-review'));
});

test('no live stage approval cannot authorize a move', () => {
  const dir = partsProject('interview'); const p = read(dir); p.signoffs = []; save(dir, p);
  refused(dir, 'ADVANCE_UNAUTHORIZED', () => advance(dir, 'plan-approved'));
});

test.each(['2026-11-06T23:59:59Z', 'unreadable'])('old lag warns while current-day or unreadable authority refuses, %s', at => {
  const dir = partsProject(); const p = read(dir);
  obj(arr(p.signoffs)[1]).at = at; obj(p.plan).drafted_at = null; save(dir, p);
  if (at === 'unreadable') expect(codes(dir)).toContain('STAGE_SIGNOFF_DATE_INVALID');
  else {
    expect(checkProject(dir).warnings.map(f => f.code)).toContain('STAGE_LAGGING');
    expect(codes(dir)).not.toContain('STAGE_LAGGING');
  }
  obj(arr(p.signoffs)[1]).at = STAGE_PROGRESS_SINCE; save(dir, p);
  expect(codes(dir)).toContain('STAGE_LAGGING');
});

test('legacy skip warns before the cutoff and refuses on the cutoff', () => {
  const dir = partsProject('parts-review'); const p = read(dir);
  obj(arr(p.signoffs)[1]).at = '2026-11-06T23:59:59Z'; obj(p.plan).drafted_at = null; save(dir, p);
  expect(checkProject(dir).warnings.map(f => f.code)).toContain('STAGE_SKIPPED');
  expect(codes(dir)).not.toContain('STAGE_SKIPPED');
  obj(arr(p.signoffs)[1]).at = STAGE_PROGRESS_SINCE; save(dir, p);
  expect(codes(dir)).toContain('STAGE_SKIPPED');
});

test.each([false, true])('signoff then advance uses the public CLI and reconciles stale stage_values, split=%s', split => {
  testClock.reset();
  const dir = partsProject('plan-approved', split); const p = read(dir);
  p.signoffs = arr(p.signoffs).slice(0, 1); p.stage_values = ['interview'];
  retimeFixture(p, testClock.now()); save(dir, p);
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  // Signed after STAGE_PROGRESS_SINCE, the lagging stage is a refusal until advance moves it.
  expect(codes(dir)).toContain('STAGE_LAGGING');
  const result = Bun.spawnSync([process.execPath, ...clockedCli(), 'advance', 'parts', dir, '--by', 'owner', '--verbatim-file', words(dir), '--json'], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe('');
  expect(JSON.parse(result.stdout.toString()).signoff).toEqual(signoffIdentity(obj(arr(read(dir).signoffs)[1])));
  expect(codes(dir)).toEqual([]); expect(checkProject(dir).warnings.map(f => f.code)).not.toContain('STAGE_VALUES_STALE');
});

test('step-status records the sequence, checkpoint approval and unchanged signed content', () => {
  const dir = partsProject('parts'); const hash = stepHash(step(read(dir), 'assemble'));
  const p = read(dir); delete step(p, 'assemble').status; save(dir, p);
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  refused(dir, 'CHECKPOINT_UNSIGNED', () => status(dir, 'assemble', 'done'));
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
  advanceCommand(['parts-review', dir, '--by', 'owner', '--verbatim-file', words(dir), ...withPartsCheck(dir)]); expect(codes(dir)).toEqual([]);
  expect(obj(arr(read(dir).advances).at(-1)).signoff).toEqual(signoffIdentity(obj(arr(read(dir).signoffs)[1])));
});

test('status skip, reversal, wrong execution stage and an unrelated candidate refusal preserve bytes', () => {
  const dir = partsProject('parts');
  refused(dir, 'STEP_STATUS_TRANSITION', () => status(dir, 'assemble', 'done'));
  refused(dir, 'STEP_STATUS_TRANSITION', () => status(dir, 'bones', 'in-progress'));
  status(dir, 'assemble', 'in-progress');
  refused(dir, 'STEP_STATUS_TRANSITION', () => status(dir, 'assemble', 'pending'));
  const p = read(dir); p.schema = 'invalid'; save(dir, p);
  refused(dir, 'SCHEMA_UNKNOWN', () => status(dir, 'assemble', 'at-checkpoint'));
});

test('a reopened checkpoint cannot authorize done and history remains readable after reset', () => {
  const dir = partsProject('parts');
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'owner', '--verbatim-file', words(dir)]);
  status(dir, 'assemble', 'done');
  testClock.set(new Date('2026-11-21T00:00:00Z'));
  reopenCommand(['parts', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual([]);
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  refused(dir, 'CHECKPOINT_UNSIGNED', () => status(dir, 'assemble', 'done'));
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
  refused(dir, 'ADVANCE_MALFORMED', () => advance(dir, 'post'));
});

test.each([false, true])('signoff permits only lag introduced by its own signature, split=%s', split => {
  const dir = partsProject('plan-approved', split);
  refused(dir, 'STAGE_LAGGING', () => signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]));
  const p = read(dir); p.signoffs = arr(p.signoffs).slice(0, 1); save(dir, p);
  expect(codes(dir)).toEqual([]);
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual(['STAGE_LAGGING']);
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
  expect(codes(dir)).toEqual(['STAGE_LAGGING']);
  advance(dir, 'accepted'); expect(codes(dir)).toEqual([]);
});

test('later same-clock approval cannot change the authorizing signature of an earlier move', () => {
  const dir = partsProject(); advance(dir);
  const p = read(dir); const entry = obj(arr(p.advances)[0]);
  arr(p.signoffs).push({ ...obj(arr(p.signoffs)[1]), at: entry.at! }); save(dir, p);
  expect(codes(dir)).toEqual([]);
  entry.signoff = signoffIdentity(obj(arr(p.signoffs).at(-1))); save(dir, p);
  expect(codes(dir)).toContain('ADVANCE_MALFORMED');
});

test('a stage-level signature on a bar cannot replace its completion bar', () => {
  const dir = partsProject('parts');
  signoffCommand(['parts', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual([]);
  refused(dir, 'PARTS_BAR_UNMET', () => advance(dir, 'parts-review'));
});


test.each([false, true])('legacy WARN lag permits signoff while contemporary lag blocks, split=%s', split => {
  const dir = partsProject('plan-approved', split); const p = read(dir);
  obj(arr(p.signoffs)[1]).at = '2026-11-06T23:59:59Z'; obj(p.plan).drafted_at = null; save(dir, p);
  expect(codes(dir)).toEqual([]);
  expect(checkProject(dir).warnings.map(f => f.code)).toContain('STAGE_LAGGING');
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(arr(read(dir).signoffs)).toHaveLength(3);
  expect(codes(dir)).toEqual(['STAGE_LAGGING']);
  refused(dir, 'STAGE_LAGGING', () => signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]));
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
  reopenCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  const draft = read(dir);
  step(draft, 'seethrough').checkpoint = null;
  step(draft, 'seethrough').checkpoint_proposed = true;
  obj(draft.plan).drafted_at = '2026-11-21T00:01:00Z'; save(dir, draft);
  testClock.set(new Date('2026-11-21T00:02:00Z'));
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual(['STAGE_LAGGING']);
  advance(dir);
  expect(codes(dir)).toEqual([]);
  expect(step(read(dir), 'seethrough').status_history).toEqual(oldHistory);
  expect(obj(arr(oldHistory)[2]).checkpoint_required).toBe(false);
  status(dir, 'seethrough', 'in-progress'); status(dir, 'seethrough', 'at-checkpoint');
  refused(dir, 'CHECKPOINT_UNSIGNED', () => status(dir, 'seethrough', 'done'));
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
  reopenCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
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
  expect(codes(dir)).toEqual(['STAGE_LAGGING']);
  refused(dir, 'ADVANCE_MALFORMED', () => advance(dir, 'accepted'));
  advance(dir, 'post');
  expect(codes(dir)).toEqual([]);
  expect(arr(read(dir).advances)[oldAdvanceIndex]).toEqual(oldAdvance);
  expect(obj(oldAdvance).post_not_passed).toBe(true);
  expect(obj(arr(read(dir).advances).at(-1)).post_not_passed).toBe(false);
  const malformed = read(dir);
  for (const invalid of [undefined, 'yes', false]) {
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
  reopenCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  const draft = read(dir); step(draft, 'assemble').checkpoint = null; step(draft, 'assemble').checkpoint_proposed = false; save(dir, draft);
  testClock.set(new Date('2026-11-21T00:01:00Z'));
  signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  advance(dir);
  expect(codes(dir)).toEqual([]);
  expect(step(read(dir), 'assemble').status_history).toEqual(original);
  const corrupted = read(dir); obj(arr(step(corrupted, 'assemble').status_history)[2]).signoff = null; save(dir, corrupted);
  expect(codes(dir)).toContain('STEP_STATUS_SIGNOFF');
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

test('writer-made status and advance history links through same-clock reopen resets', () => {
  const dir = partsProject(); advance(dir);
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint');
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'owner', '--verbatim-file', words(dir)]);
  status(dir, 'assemble', 'done');
  reopenCommand(['parts', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
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

test('a reopen cannot absorb a hand stage move, and keeps the bytes', () => {
  const dir = partsProject(); advance(dir);
  const p = read(dir); p.stage = 'parts-review'; save(dir, p);
  expect(codes(dir)).toContain('STAGE_SKIPPED');
  refused(dir, 'STAGE_MOVE_UNLINKED', () => reopenCommand(['parts', dir, '--by', 'owner', '--verbatim-file', words(dir)]));
});
