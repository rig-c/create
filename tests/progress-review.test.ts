import { afterEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { STAGE_PROGRESS_SINCE } from '../src/stage-progress.ts';
import { tempDir } from './helpers.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, bindFixtureAnswers, fixture, obj, rehashSignoffs, retimeFixture, step } from './fixtures.ts';
import { checkProject, advanceCommand, stepStatusCommand, reopenCommand, reviewCommand, signoffCommand, testClock } from './clock.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const codes = (dir: string): string[] => checkProject(dir).refusals.map(f => f.code);
function words(dir: string): string {
  const path = join(dir, 'approval.txt'); writeFileSync(path, 'Approve the synthetic progress.'); return path;
}
function advance(dir: string, stage: string): void {
  advanceCommand([stage, dir]);
}
function sign(dir: string, stage: string): void {
  signoffCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]);
}
function status(dir: string, id: string, value: string): void {
  stepStatusCommand([id, value, dir, '--by', 'agent']);
}
function unchangedRefusal(dir: string, code: string, action: () => void): void {
  const before = readFileSync(join(dir, 'project.json'));
  try { action(); throw new Error('expected refusal'); }
  catch (error) { expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code); }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}
afterEach(() => testClock.reset());

function riggingProject(empty = false): string {
  testClock.set(new Date('2026-11-06T23:59:00Z'));
  const dir = join(tempDir(), 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), dir, { recursive: true });
  reopenCommand(['rigging-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  if (empty) {
    const p = read(dir);
    obj(p.plan).steps = arr(obj(p.plan).steps).filter(raw => obj(raw).phase !== 'rig' || ['assemble', 'seethrough'].includes(String(obj(raw).id)));
    for (const raw of arr(obj(p.interview).waypoints)) if (['bones', 'meshes', 'constraints', 'motion'].includes(String(obj(raw).id))) obj(raw).guide = { not_applicable: true, because: 'No rigging work applies.', by: 'owner', at: '2026-11-06T23:59:00Z' };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  }
  testClock.set(new Date('2026-11-06T23:59:01Z'));
  return dir;
}

test('review empty rigging execution is stopped by the existing no-steps signoff contract', () => {
  const dir = riggingProject(true);
  unchangedRefusal(dir, 'SIGNOFF_STEP_INVALID', () => sign(dir, 'rigging-interview'));
});

test('review a new writer cannot bypass unfinished rigging with a legacy frontier', () => {
  const dir = riggingProject();
  sign(dir, 'rigging-interview'); advance(dir, 'rigging');
  expect(step(read(dir), 'bones').status).toBe('pending');
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  unchangedRefusal(dir, 'STAGE_SKIPPED', () => advance(dir, 'rig-review'));
});

test.each(['plan-approved', 'interview'])('review pre-parts checkpoint history survives upstream reopen %s', stage => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => {
    Object.assign(p, JSON.parse(JSON.stringify(p).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g,
      value => new Date(Date.parse(value) - 30 * 86_400_000).toISOString())));
    p.stage = 'rigging'; p.versions = [];
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts', 'rigging'].includes(String(obj(s).stage)));
    for (const raw of arr(p.signoffs)) { const s = obj(raw); if (s.stage === 'parts') s.stage = 'rigging'; delete s.answer_hashes; }
    for (const raw of arr(obj(p.plan).steps)) if (obj(raw).phase === 'post') obj(raw).status = 'pending';
    step(p, 'assemble').status = 'pending'; rehashSignoffs(p); bindFixtureAnswers(p);
  });
  status(dir, 'assemble', 'in-progress'); status(dir, 'assemble', 'at-checkpoint'); status(dir, 'assemble', 'done');
  const history = structuredClone(step(read(dir), 'assemble').status_history);
  testClock.set(new Date('2026-11-21T00:00:00Z'));
  reopenCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual([]);
  expect(step(read(dir), 'assemble').status_history).toEqual(history);
  const malformed = read(dir);
  for (const raw of arr(malformed.signoffs)) if (obj(raw).stage === 'plan-approved') obj(raw).at = '2026-11-19T00:00:00Z';
  writeFileSync(join(dir, 'project.json'), JSON.stringify(malformed));
  expect(codes(dir)).toContain('STEP_STATUS_SIGNOFF');
});


test('review a hand-set authorized next stage still needs the matching advance', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 2);
    retimeFixture(p, Date.parse('2026-11-16T00:00:00Z'));
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  const p = read(dir); const recorded = p.advances; p.advances = []; p.stage = 'parts'; writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  expect(codes(dir)).toEqual(['STAGE_SKIPPED']);
  // The next advance cannot absorb the unrecorded move into plan-approved.
  p.stage = 'plan-approved'; writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  unchangedRefusal(dir, 'STAGE_MOVE_UNLINKED', () => advance(dir, 'parts'));
  p.advances = recorded; writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  advance(dir, 'parts'); expect(codes(dir)).toEqual([]);
});

test.each(['unreadable', '', '2026-99-99T00:00:00Z'])('review an unreadable frontier date refuses, %s', at => {
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 2);
    obj(arr(p.signoffs)[1]).at = at;
    obj(p.plan).drafted_at = null;
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  expect(codes(dir)).toContain('STAGE_SIGNOFF_DATE_INVALID');
  unchangedRefusal(dir, 'STAGE_SIGNOFF_DATE_INVALID', () => advance(dir, 'parts'));
});

test('review an absent frontier date retains the existing malformed-signoff refusal', () => {
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 2);
    delete obj(arr(p.signoffs)[1]).at; obj(p.plan).drafted_at = null;
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  expect(codes(dir)).toContain('SIGNOFF_MALFORMED');
  unchangedRefusal(dir, 'SIGNOFF_MALFORMED', () => advance(dir, 'parts'));
});

test('review an unreadable competing frontier signature cannot hide behind a readable one', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 2);
    arr(p.signoffs).push({ ...obj(arr(p.signoffs)[1]), at: 'unreadable' });
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  expect(codes(dir)).toContain('STAGE_SIGNOFF_DATE_INVALID');
  unchangedRefusal(dir, 'STAGE_SIGNOFF_DATE_INVALID', () => advance(dir, 'parts'));
});

test('review a new writer cannot bypass unfinished post with a legacy frontier', () => {
  const dir = join(tempDir(), 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/4-direction-post'), dir, { recursive: true });
  testClock.set(new Date('2026-11-06T23:59:00Z'));
  reopenCommand(['post', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(step(read(dir), 'camera').status).toBe('pending');
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  unchangedRefusal(dir, 'STAGE_SKIPPED', () => advance(dir, 'direction-review'));
});

test('review a fresh project remains green at the initial stage', () => {
  const dir = fixture(p => {
    p.stage = 'interview'; p.signoffs = []; p.advances = []; p.versions = [];
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  expect(codes(dir)).toEqual([]);
});

test('review latest reopen is green and a different hand-set stage is refused', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(() => {}, 'example-project.json');
  reopenCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(codes(dir)).toEqual([]);
  const p = read(dir); p.stage = 'rig-review';
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  expect(codes(dir)).toEqual(['STAGE_SKIPPED', 'STAGE_LAGGING']);
});

test('review an advance whose authority was dead at its event is refused', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 2);
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  advance(dir, 'parts');
  const p = read(dir);
  p.reopens = [{ stage: 'plan-approved', from_stage: 'parts', by: 'owner', at: '2026-11-19T00:00:00Z', verbatim: 'Reopen before the planted move.', steps_before: [] }];
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  expect(codes(dir)).toContain('ADVANCE_MALFORMED');
});

test('review advance snapshots require phases and retain completed historical bars', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(() => {}, 'example-project.json');
  const original = read(dir);
  const index = arr(original.advances).findIndex(raw => obj(raw).from_stage === 'parts');
  for (const mutation of ['missing-phase', 'invalid-phase', 'unfinished-status']) {
    const p = structuredClone(original);
    const snapshot = obj(arr(obj(arr(p.advances)[index]).steps_before).find(raw => obj(raw).id === 'assemble'));
    if (mutation === 'missing-phase') delete snapshot.phase;
    else if (mutation === 'invalid-phase') snapshot.phase = 'invented';
    else snapshot.status = 'pending';
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
    expect(codes(dir)).toContain('ADVANCE_MALFORMED');
  }
});

test('review the delayed landing boundary warns the day before and refuses on landing day', () => {
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 2);
    obj(arr(p.signoffs)[1]).at = '2026-11-07T23:59:59Z'; obj(p.plan).drafted_at = null;
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  expect(codes(dir)).not.toContain('STAGE_LAGGING');
  expect(checkProject(dir).warnings.map(f => f.code)).toContain('STAGE_LAGGING');
  const p = read(dir); obj(arr(p.signoffs)[1]).at = STAGE_PROGRESS_SINCE;
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  expect(codes(dir)).toContain('STAGE_LAGGING');
});

const PROGRESS = ['STAGE_LAGGING', 'STAGE_SKIPPED', 'STAGE_SIGNOFF_DATE_INVALID', 'ADVANCE_MALFORMED'];
function progress(dir: string): { refusals: string[]; warnings: string[] } {
  const report = checkProject(dir);
  const pick = (findings: { code: string }[]): string[] => findings.map(f => f.code).filter(code => PROGRESS.includes(code));
  return { refusals: pick(report.refusals), warnings: pick(report.warnings) };
}
function checkpoint(name: string, handMove = false): string {
  const dir = join(tempDir(), 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints', name), dir, { recursive: true });
  if (handMove) {
    // Plant the legacy hand move independently of the writer-generated checkpoint.
    const project = read(dir); delete project.advances;
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  }
  return dir;
}
function hand(dir: string, stage: string): void {
  const p = read(dir); p.stage = stage; writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
}
function acceptRigReview(dir: string, at: string): void {
  testClock.set(new Date(at));
  reviewCommand(['1', dir, '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review',
    '--verbatim-file', join(dir, 'evidence/approval.txt'), '--source', 'synthetic example']);
  testClock.set(new Date(Date.parse(at) + 60_000));
  signoffCommand(['rig-review', dir, '--by', 'user', '--verbatim-file', words(dir), '--version', '1']);
}

test.each([
  ['2026-11-07T12:00:00Z', [], ['STAGE_SKIPPED', 'STAGE_LAGGING']],
  ['2026-11-08T00:05:00Z', ['STAGE_LAGGING'], ['STAGE_SKIPPED']],
  ['2026-11-20T00:00:00Z', ['STAGE_LAGGING'], ['STAGE_SKIPPED']],
])('review a pre-contract hand move warns through a later frontier sign-off at %s', (at, refusals, warnings) => {
  const dir = checkpoint('3-rig-review', true);
  testClock.set(new Date(at));
  expect(progress(dir)).toEqual({ refusals: [], warnings: ['STAGE_SKIPPED'] });
  acceptRigReview(dir, at);
  expect(arr(read(dir).signoffs).map(s => obj(s).stage).at(-1)).toBe('rig-review');
  expect(progress(dir)).toEqual({ refusals, warnings });
});

test('review the advance after a pre-contract hand move records it and clears the mismatch', () => {
  const dir = checkpoint('4-direction-post', true);
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  expect(progress(dir)).toEqual({ refusals: [], warnings: ['STAGE_SKIPPED'] });
  advance(dir, 'direction-review');
  expect(obj(arr(read(dir).advances).at(-1)).stage).toBe('direction-review');
  expect(progress(dir)).toEqual({ refusals: [], warnings: [] });
});

test.each(['interview', 'plan-approved'])('review a post-contract sign-off of earlier %s keeps a pre-contract hand move a warning', stage => {
  const dir = checkpoint('3-rig-review', true);
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  sign(dir, stage);
  expect(arr(read(dir).signoffs).map(s => obj(s).stage).at(-1)).toBe(stage);
  expect(progress(dir)).toEqual({ refusals: [], warnings: ['STAGE_SKIPPED'] });
});

test('review a hand move after a post-contract arrival sign-off is refused', () => {
  const dir = checkpoint('3-rig-review');
  acceptRigReview(dir, '2026-11-20T00:00:00Z');
  hand(dir, 'post-interview');
  expect(progress(dir)).toEqual({ refusals: ['STAGE_SKIPPED'], warnings: [] });
});

test('review a hand move after a post-contract advance is refused although its arrival sign-off is older', () => {
  const dir = riggingProject();
  sign(dir, 'rigging-interview');
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  advance(dir, 'rigging');
  hand(dir, 'rig-review');
  expect(progress(dir)).toEqual({ refusals: ['STAGE_SKIPPED'], warnings: ['STAGE_SKIPPED'] });
});

test('review a hand move after a post-contract reopen is refused although its arrival sign-off is older', () => {
  const dir = checkpoint('3-rig-review');
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  reopenCommand(['rigging-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  hand(dir, 'rig-review');
  expect(progress(dir)).toEqual({ refusals: ['STAGE_SKIPPED'], warnings: ['STAGE_SKIPPED'] });
});
