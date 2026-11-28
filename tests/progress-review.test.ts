import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { Refusal } from '../src/refusal.ts';
import { DIRECTION_REVIEW_ADVANCE_SINCE, RIGGING_INTERVIEW_PAINTING_SINCE } from '../src/stage-progress.ts';
/** The retired stage-order contract date (#981), kept as a fixture clock anchor. */
const STAGE_PROGRESS_SINCE = '2026-11-08T00:00:00Z';
import { tempDir } from './helpers.ts';
import { copyWithRunningCreatePin } from './copied-create-pin.ts';
import type { JsonObject } from '../src/templates.ts';
import { plantLegacyReopen, arr, bindFixtureAnswers, fixture, obj, rehashSignoffs, retimeFixture, step } from './fixtures.ts';
import { checkProject, advanceCommand, inputCommand, stepStatusCommand, signoffCommand, testClock } from './clock.ts';

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
  copyWithRunningCreatePin(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), dir);
  plantLegacyReopen(dir, 'rigging-interview', { by: 'owner', wordsFile: words(dir) });
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

test('the rigging-interview exit needs an explicitly declared painting from the cutoff', () => {
  const dir = riggingProject();
  const file = join(dir, 'project.json');
  const project = read(dir);
  const painting = String(project.painting);
  delete project.painting;
  writeFileSync(file, JSON.stringify(project));
  sign(dir, 'rigging-interview');
  expect(codes(dir)).not.toContain('RIGGING_INTERVIEW_PAINTING_REQUIRED');

  const cutoff = Date.parse(RIGGING_INTERVIEW_PAINTING_SINCE);
  testClock.set(cutoff);
  unchangedRefusal(dir, 'RIGGING_INTERVIEW_PAINTING_REQUIRED', () => advance(dir, 'rigging'));

  testClock.set(cutoff - 1);
  const signed = readFileSync(file);
  advance(dir, 'rigging');
  const historical = read(dir);
  expect(checkProject(dir).warnings.filter(f => f.path === 'painting').map(f => f.code))
    .toEqual(['RIGGING_INTERVIEW_PAINTING_LEGACY']);
  obj(arr(historical.advances).at(-1)).at = RIGGING_INTERVIEW_PAINTING_SINCE;
  expect(checkProject(dir, historical).refusals.map(f => f.code)).toContain('RIGGING_INTERVIEW_PAINTING_REQUIRED');

  writeFileSync(file, signed);
  testClock.set(cutoff);
  expect(inputCommand(['painting', painting, dir]).exit).toBe(0);
  expect(read(dir).inputs).toEqual(project.inputs);
  advance(dir, 'rigging');
  expect(codes(dir)).toEqual([]);
  expect(checkProject(dir).warnings.some(f => f.path === 'painting')).toBe(false);
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
  plantLegacyReopen(dir, stage, { by: 'owner', wordsFile: words(dir) });
  expect(codes(dir)).toEqual([]);
  expect(step(read(dir), 'assemble').status_history).toEqual(history);
  const malformed = read(dir);
  for (const raw of arr(malformed.signoffs)) if (obj(raw).stage === 'plan-approved') obj(raw).at = '2026-11-19T00:00:00Z';
  writeFileSync(join(dir, 'project.json'), JSON.stringify(malformed));
  expect(codes(dir)).toContain('STEP_STATUS_SIGNOFF');
});


test('review a hand-set next stage is not a stage-order refusal, and the next advance still needs the recorded move', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 2);
    retimeFixture(p, Date.parse('2026-11-16T00:00:00Z'));
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  const p = read(dir); const recorded = p.advances; p.advances = []; p.stage = 'parts'; writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  // #981: check no longer enforces stage order; the writer still refuses to absorb an unrecorded move.
  expect(codes(dir)).toEqual([]);
  // The next advance cannot absorb the unrecorded move into plan-approved.
  p.stage = 'plan-approved'; writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  unchangedRefusal(dir, 'STAGE_MOVE_UNLINKED', () => advance(dir, 'parts'));
  p.advances = recorded; writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  advance(dir, 'parts'); expect(codes(dir)).toEqual([]);
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

test('#981 advancing past unfinished post meets only the post evidence rule', () => {
  const dir = join(tempDir(), 'project');
  copyWithRunningCreatePin(join(import.meta.dir, '../templates/example-chain/checkpoints/4-direction-post'), dir);
  testClock.set(new Date('2026-11-06T23:59:00Z'));
  plantLegacyReopen(dir, 'post', { by: 'owner', wordsFile: words(dir) });
  expect(step(read(dir), 'camera').status).toBe('pending');
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  unchangedRefusal(dir, 'DIRECTION_REVIEW_POST_MISSING', () => advance(dir, 'direction-review'));
});

test('review a fresh project remains green at the initial stage', () => {
  const dir = fixture(p => {
    p.stage = 'interview'; p.signoffs = []; p.advances = []; p.versions = [];
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  expect(codes(dir)).toEqual([]);
});

test('review latest reopen is green, and a different hand-set stage is no stage-order refusal (#981)', () => {
  testClock.set(EXAMPLE_NOW);
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  plantLegacyReopen(dir, 'post-interview', { by: 'owner', wordsFile: words(dir) });
  expect(codes(dir)).toEqual([]);
  const p = read(dir); p.stage = 'rig-review';
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  expect(codes(dir)).toEqual([]);
});

test('review advance snapshots require phases', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const original = read(dir);
  const index = arr(original.advances).findIndex(raw => obj(raw).from_stage === 'parts');
  for (const mutation of ['missing-phase', 'invalid-phase']) {
    const p = structuredClone(original);
    const snapshot = obj(arr(obj(arr(p.advances)[index]).steps_before).find(raw => obj(raw).id === 'assemble'));
    if (mutation === 'missing-phase') delete snapshot.phase;
    else snapshot.phase = 'invented';
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
    expect(codes(dir)).toContain('ADVANCE_MALFORMED');
  }
});

const PROGRESS = ['STAGE_LAGGING', 'STAGE_SKIPPED', 'STAGE_SIGNOFF_DATE_INVALID', 'ADVANCE_MALFORMED'];
function progress(dir: string): { refusals: string[]; warnings: string[] } {
  const report = checkProject(dir);
  const pick = (findings: { code: string }[]): string[] => findings.map(f => f.code).filter(code => PROGRESS.includes(code));
  return { refusals: pick(report.refusals), warnings: pick(report.warnings) };
}
function checkpoint(name: string, handMove = false): string {
  const dir = join(tempDir(), 'project');
  copyWithRunningCreatePin(join(import.meta.dir, '../templates/example-chain/checkpoints', name), dir);
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

test('review the advance after a pre-contract hand move records it', () => {
  const dir = join(tempDir(), 'project');
  copyWithRunningCreatePin(join(import.meta.dir, '../templates/example-chain'), dir);
  const project = read(dir);
  project.stage = 'post';
  project.signoffs = arr(project.signoffs).filter(s => obj(s).stage !== 'direction-review');
  obj(arr(project.versions).at(-1)).verdicts = [];
  delete project.advances;
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  expect(progress(dir)).toEqual({ refusals: [], warnings: [] });
  advance(dir, 'direction-review');
  expect(obj(arr(read(dir).advances).at(-1)).stage).toBe('direction-review');
  expect(progress(dir)).toEqual({ refusals: [], warnings: [] });
});

test('#503 advance direction-review from post refuses byte-identically when lacking direction_contract, scene or post version', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = checkpoint('4-direction-post');
  // 1. Lacking direction_contract, scenes[n=1] and versions[n=2].
  const withoutContract = read(dir);
  delete withoutContract.direction_contract;
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(withoutContract, null, 2)}\n`);
  unchangedRefusal(dir, 'DIRECTION_REVIEW_POST_MISSING', () => advance(dir, 'direction-review'));

  // 2. With direction_contract adopted, still lacking scenes[n=1] and versions[n=2].
  const adoptDir = checkpoint('4-direction-post');
  unchangedRefusal(adoptDir, 'DIRECTION_REVIEW_POST_MISSING', () => advance(adoptDir, 'direction-review'));

  // 3. With direction_contract and scenes[n=1], still lacking versions[n=2].
  const sceneOnlyDir = join(tempDir(), 'scene-only');
  copyWithRunningCreatePin(join(import.meta.dir, '../templates/example-chain'), sceneOnlyDir);
  const sceneOnly = read(sceneOnlyDir);
  sceneOnly.stage = 'post';
  sceneOnly.versions = arr(sceneOnly.versions).filter(v => obj(v).kind === 'rig');
  sceneOnly.signoffs = arr(sceneOnly.signoffs).filter(s => obj(s).stage !== 'direction-review');
  sceneOnly.advances = arr(sceneOnly.advances).filter(a => !['direction-review', 'accepted'].includes(String(obj(a).stage)));
  writeFileSync(join(sceneOnlyDir, 'project.json'), `${JSON.stringify(sceneOnly, null, 2)}\n`);
  unchangedRefusal(sceneOnlyDir, 'DIRECTION_REVIEW_POST_MISSING', () => advance(sceneOnlyDir, 'direction-review'));
});

test('#503 advance direction-review succeeds when current scene and live post version exist, and check warns before DIRECTION_REVIEW_ADVANCE_SINCE', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = join(tempDir(), 'post-ready');
  copyWithRunningCreatePin(join(import.meta.dir, '../templates/example-chain'), dir);
  const ready = read(dir);
  ready.stage = 'post';
  obj(arr(ready.versions).at(-1)).verdicts = [];
  ready.signoffs = arr(ready.signoffs).filter(s => obj(s).stage !== 'direction-review');
  ready.advances = arr(ready.advances).filter(a => !['direction-review', 'accepted'].includes(String(obj(a).stage)));
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(ready, null, 2)}\n`);
  advance(dir, 'direction-review');
  expect(read(dir).stage).toBe('direction-review');
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings).toEqual([]);

  // A record that advanced before DIRECTION_REVIEW_ADVANCE_SINCE without scene/post version gets a WARN, not a refusal.
  const preSinceDir = checkpoint('4-direction-post');
  const preSince = read(preSinceDir);
  const lastSignoff = obj(arr(preSince.signoffs).at(-1));
  preSince.stage = 'direction-review';
  preSince.advances = [
    ...arr(preSince.advances),
    {
      stage: 'direction-review',
      from_stage: 'post',
      at: '2026-11-17T23:59:59Z',
      post_not_passed: false,
      order: 'split',
      signoffs_before: arr(preSince.signoffs).map(s => ({ stage: obj(s).stage, checkpoint: obj(s).checkpoint ?? null, at: obj(s).at })),
      signoff: { stage: lastSignoff.stage, checkpoint: null, at: lastSignoff.at },
      steps_before: arr(obj(preSince.plan).steps).map(s => ({ id: obj(s).id, phase: obj(s).phase, status: obj(s).status })),
    },
  ];
  writeFileSync(join(preSinceDir, 'project.json'), `${JSON.stringify(preSince, null, 2)}\n`);
  const preReport = checkProject(preSinceDir);
  expect(preReport.refusals).toEqual([]);
  expect(preReport.warnings.map(w => [w.code, w.path])).toEqual([
    ['DIRECTION_REVIEW_POST_MISSING', `advances[${arr(preSince.advances).length - 1}]`],
  ]);

  // On or after DIRECTION_REVIEW_ADVANCE_SINCE, the same unauthored move is refused in check.
  obj(arr(preSince.advances).at(-1)).at = DIRECTION_REVIEW_ADVANCE_SINCE;
  writeFileSync(join(preSinceDir, 'project.json'), `${JSON.stringify(preSince, null, 2)}\n`);
  const postReport = checkProject(preSinceDir);
  expect(postReport.refusals.map(r => [r.code, r.path])).toEqual([
    ['DIRECTION_REVIEW_POST_MISSING', `advances[${arr(preSince.advances).length - 1}]`],
  ]);
  expect(postReport.warnings).toEqual([]);
});

