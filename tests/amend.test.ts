import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { AMENDMENT_APPROVAL_GAPS, collectAmendments, keepByBinding } from '../src/amend.ts';
import { collectSignoffs, formatReport } from '../src/check.ts';
import { Refusal } from '../src/refusal.ts';
import { collectReopens, liveSignoff } from '../src/reopen.ts';
import { readVersions } from '../src/review.ts';
import { STAGES, stageIndex, stageOfStep } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
import { plantLegacyReopen, arr, fixture, obj, step } from './fixtures.ts';
import { CLI, cli, clockedCli, gitEnv, tempDir } from './helpers.ts';
import { amendCommand, checkProject, correctionCommand, handoff, signoffCommand, stepStatusCommand, testClock } from './clock.ts';
import { nextProject } from '../src/next.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
function words(dir: string): string {
  const file = join(dir, 'words.txt');
  writeFileSync(file, '\uFEFFReplace the synthetic panel.\r\n');
  return file;
}
function amend(dir: string, stage = 'parts', extra: string[] = []): void {
  writeFileSync(join(dir, 'replacement.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  amendCommand([stage, dir, '--kind', 'part', '--target', 'panel', '--change', 'replacement.svg', '--by', 'owner', '--verbatim-file', words(dir), ...extra]);
}
function refusal(fn: () => unknown, code: string): void {
  try { fn(); throw new Error('expected refusal'); } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
  }
}
const nonLive = (p: JsonObject): number[] => {
  const events = collectReopens(p, []);
  return collectSignoffs(p, []).filter(s => !liveSignoff(events, s.stage, s.at)).map(s => s.index);
};

describe('forward human amendments', () => {
  beforeEach(() => testClock.set(EXAMPLE_NOW));
  afterEach(() => testClock.reset());

  test('writer-built synthetic example names every lapsed approval and the live upstream list', () => {
    // The retained example and its assets are generated through the public writers.
    const dir = fixture(() => {}, 'example-project.json');
    expect(checkProject(dir).refusals).toEqual([]);
    expect(checkProject(dir).warnings).toEqual([]);
    const before = read(dir);
    amend(dir, 'parts', ['--source', 'synthetic relay']);
    const after = read(dir);
    expect(after.stage).toBe(before.stage);
    expect(after.signoffs).toEqual(before.signoffs);
    expect(after.versions).toEqual(before.versions);
    const record = obj(arr(after.amendments)[0]);
    expect(record).toEqual({ target: { stage: 'parts', kind: 'part', id: 'panel' }, by: 'owner', at: new Date(EXAMPLE_NOW).toISOString(), verbatim: '\uFEFFReplace the synthetic panel.\r\n', source: 'synthetic relay', changes: [{ path: 'replacement.svg', sha256: createHash('sha256').update(readFileSync(join(dir, 'replacement.svg'))).digest('hex') }] });
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.effective_stage).toBe('parts');
    const summary = report.amendments![0]!;
    expect(summary.lapsed.filter(a => a.path.startsWith('signoffs')).map(a => a.path)).toEqual(nonLive(after).map(i => `signoffs[${i}]`));
    expect(summary.lapsed.some(a => a.stage === 'parts-review')).toBe(true);
    expect(summary.lapsed.some(a => a.stage === 'rigging-interview')).toBe(true);
    expect(summary.lapsed.some(a => a.stage === 'post-interview')).toBe(true);
    expect(summary.lapsed.some(a => a.stage === 'direction-review')).toBe(true);
    expect(summary.lapsed.some(a => a.path.includes('.verdicts['))).toBe(true);
    expect(summary.upstream.map(a => a.stage)).toEqual(['interview', 'plan-approved']);
    for (const approval of summary.lapsed) {
      expect(approval.reason).toBe('no binding proves independence');
      expect(approval.gap).toBe(AMENDMENT_APPROVAL_GAPS[approval.stage]);
    }
    expect(summary.keep_by_binding).toEqual([]);
    expect(keepByBinding(after, obj(record.target), { stage: 'rigging', checkpoint: 'constraints' })).toBe(false);
    const printed = formatReport(report);
    for (const approval of [...summary.lapsed, ...summary.upstream]) expect(printed).toContain(approval.path);
    expect(printed).toContain('keep-by-binding (0)');
    expect(printed).toContain('no binding proves independence (G7)');
    refusal(() => handoff(dir, null), 'RIG_REVIEW_UNSIGNED');
  });

  test.each(STAGES.filter(s => s.id !== 'accepted').flatMap(s => ['legacy-example-project.json', 'example-project.json'].map(template => [s.id, template] as const))
    .filter(([stage, template]) => stage !== 'rigging-interview' || template !== 'legacy-example-project.json'))('amend %s and reopen have equal liveness in %s', (stage, template) => {
    const amendmentDir = fixture(() => {}, template);
    const reopenDir = fixture(() => {}, template);
    amend(amendmentDir, stage);
    plantLegacyReopen(reopenDir, stage, { by: 'owner', wordsFile: words(reopenDir) });
    const amended = read(amendmentDir);
    const reopened = read(reopenDir);
    expect(nonLive(amended)).toEqual(nonLive(reopened));
    expect(readVersions(amended)).toEqual(readVersions(reopened));
    const history = collectSignoffs(amended, []);
    expect(nonLive(amended)).toEqual(history.filter(s => stageIndex(s.stage) >= stageIndex(stage)).map(s => s.index));
    const report = checkProject(amendmentDir);
    const summary = report.amendments![0]!;
    const reopenedEvents = collectReopens(reopened, []);
    const expectedLapsed = nonLive(reopened).map(index => `signoffs[${index}]`);
    for (const [vi, raw] of arr(reopened.versions).entries()) {
      for (const [di, verdict] of arr(obj(raw).verdicts).entries()) {
        const approval = obj(verdict);
        if (approval.verdict === 'accepted' && !liveSignoff(reopenedEvents, String(approval.review), Date.parse(String(approval.at)))) {
          expectedLapsed.push(`versions[${vi}].verdicts[${di}]`);
        }
      }
    }
    expect(summary.lapsed.map(a => a.path).sort()).toEqual(expectedLapsed.sort());
    expect(summary.keep_by_binding).toEqual([]);
    const printedLapsed = formatReport(report).split('    lapsed (')[1]!.split('    upstream live (')[0]!;
    expect(printedLapsed.split('\n').filter(line => line.startsWith('      ')).map(line => line.trim().split(' ')[0]).sort()).toEqual(expectedLapsed);
    expect(formatReport(report)).toContain('keep-by-binding (0)');
    expect(amended.stage).toBe('accepted');
    expect(reopened.stage).toBe(stage);
    expect(report.refusals).toEqual([]);
  });

  test('a later-stage amendment preserves every preceding plan-step state and rig handoff', () => {
    const dir = fixture();
    const before = read(dir);
    amend(dir, 'post');
    const after = read(dir);
    for (const raw of arr(obj(after.plan).steps)) {
      const s = obj(raw);
      if (stageIndex(stageOfStep(s.phase as 'rig' | 'post', String(s.id))) < stageIndex('post')) expect(s).toEqual(step(before, String(s.id)));
      else expect(s.status).toBe('pending');
    }
    expect(handoff(dir, null).rig_version).toBe(2);
  });

  test.each(([
    ['post-interview', 'motion'],
    ['direction-review', 'motion'],
    ['direction-review', 'timing'],
  ] as const).flatMap(([stage, upstream]) => [false, true].map(resign => [stage, upstream, resign] as const)))('upstream unfinished bars do not lower amend %s with %s unfinished and re-sign %s', (stage, upstream, resign) => {
    const dir = fixture(p => { step(p, upstream).status = 'in-progress'; }, 'example-project.json');
    const before = read(dir);
    const control = checkProject(dir);
    expect(control.refusals).toEqual([]);
    expect(control.effective_stage).toBe(before.stage as string);
    expect(JSON.stringify(checkProject(dir))).toBe(JSON.stringify(control));
    expect(formatReport(checkProject(dir))).toBe(formatReport(control));
    amend(dir, stage);
    if (resign) {
      testClock.set(EXAMPLE_NOW + 86_400_000);
      signoffCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    }
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    const afterSignoff = stage === 'post-interview' ? 'post' : 'accepted';
    expect(report.effective_stage).toBe(resign ? afterSignoff : stage);
    expect(read(dir).stage).toBe(before.stage);
    expect(step(read(dir), upstream)).toEqual(step(before, upstream));
    expect(handoff(dir, null).rig_version).toBe(2);
  });

  test('re-signing only the lapsed suffix keeps the stage and upstream signatures unchanged', () => {
    const dir = fixture();
    const before = read(dir);
    amend(dir, 'post-interview');
    testClock.set(EXAMPLE_NOW + 86_400_000);
    signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    expect(checkProject(dir).effective_stage).toBe('post');
    // The reset post steps are redone through step-status at the effective stage.
    for (const raw of arr(obj(read(dir).plan).steps)) {
      const id = String(obj(raw).id);
      if (obj(raw).phase === 'post') for (const status of ['in-progress', 'at-checkpoint', 'done']) stepStatusCommand([id, status, dir, '--by', 'agent']);
    }
    expect(checkProject(dir).effective_stage).toBe('direction-review');
    signoffCommand(['direction-review', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    const p = read(dir);
    expect(p.stage).toBe(before.stage);
    expect(arr(p.signoffs).slice(0, arr(before.signoffs).length)).toEqual(arr(before.signoffs));
    expect(arr(p.signoffs).slice(arr(before.signoffs).length).map(s => obj(s).stage)).toEqual(['post-interview', 'direction-review']);
    expect(checkProject(dir).refusals).toEqual([]);
    expect(checkProject(dir).effective_stage).toBe('accepted');
    expect(handoff(dir, null).rig_version).toBe(2);
  });

  test('multiple amendments and reopen cutoffs never resurrect an earlier suffix', () => {
    const dir = fixture();
    amend(dir);
    const first = nonLive(read(dir));
    testClock.set(EXAMPLE_NOW + 86_400_000);
    amend(dir, 'post');
    expect(nonLive(read(dir))).toEqual(first);
    plantLegacyReopen(dir, 'rig-review', { by: 'owner', wordsFile: words(dir) });
    expect(nonLive(read(dir))).toEqual(first);
  });

  test('re-sign cannot revive an old rig or bypass candidate validation on an amended legacy project', () => {
    const dir = fixture();
    amend(dir, 'rig-review');
    testClock.set(EXAMPLE_NOW + 86_400_000);
    const before = readFileSync(join(dir, 'project.json'));
    refusal(() => signoffCommand(['rig-review', dir, '--by', 'owner', '--verbatim-file', words(dir)]), 'RIG_VERSION_UNACCEPTED');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    const p = read(dir);
    expect(readVersions(p).rigs.every(v => !v.live)).toBe(true);
    refusal(() => handoff(dir, null), 'RIG_REVIEW_UNSIGNED');
    step(p, 'assemble').rests_on = [];
    save(dir, p);
    const invalid = readFileSync(join(dir, 'project.json'));
    expect(before.equals(invalid)).toBe(false);
    // A carried STEP_NO_BASIS no longer blocks the signature; the old rig stays unrevived.
    signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('STEP_NO_BASIS');
    expect(readVersions(read(dir)).rigs.every(v => !v.live)).toBe(true);
  });

  test('no amendment leaves record bytes and report JSON/text unchanged', () => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    const report = checkProject(dir);
    expect('amendments' in report).toBe(false);
    expect(formatReport(report)).not.toContain('keep-by-binding');
    expect(checkProject(dir)).toEqual(report);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('the retained stage permits a new pending correction while its approval is lapsed', () => {
    const dir = fixture(() => {}, 'example-project.json');
    amend(dir, 'rig-review');
    testClock.set(EXAMPLE_NOW + 86_400_000);
    correctionCommand(['--adopt', dir]);
    correctionCommand(['record', dir, '--id', 'panel-fix', '--path', 'described', '--stage', 'rig-review', '--version', '2', '--by', 'owner', '--verbatim-file', words(dir)]);
    expect(checkProject(dir).refusals).toEqual([]);
    expect(checkProject(dir).warnings.map(w => w.code)).toContain('CORRECTION_OPEN');
    expect(read(dir).stage).toBe('accepted');
    const before = readFileSync(join(dir, 'project.json'));
    refusal(() => signoffCommand(['rig-review', dir, '--by', 'owner', '--verbatim-file', words(dir)]), 'CORRECTION_PENDING');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test.each(['agent', 'AGENT', ' agent '])('refuses %s before writing or reading words', by => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    refusal(() => amend(dir, 'parts', ['--by', by]), 'AMENDMENT_OPTION_INVALID');
    refusal(() => amendCommand(['parts', dir, '--kind', 'part', '--target', 'panel', '--change', 'missing', '--by', by]), 'SIGNOFF_NOT_HUMAN');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test.each(['accepted', 'paused', 'unknown'])('refuses %s target without a write', stage => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    refusal(() => amend(dir, stage), 'AMENDMENT_TARGET_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('malformed planted amendments grant no supersession and are refused by shared history validation', () => {
    const dir = fixture();
    const p = read(dir);
    p.amendments = [{ target: { stage: 'parts', kind: 'part', id: 'panel' }, by: 'agent', at: '2026-11-20T00:00:00Z', verbatim: 'yes', changes: [{ path: 'new', sha256: 'a'.repeat(64) }] }];
    save(dir, p);
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('SIGNOFF_NOT_HUMAN');
    expect(nonLive(p)).toEqual([]);
    obj(arr(p.amendments)[0]).by = 'owner';
    obj(arr(p.amendments)[0]).changes = [{ path: 'new', sha256: 'bad' }];
    const errors: { code: string; path: string; message: string }[] = [];
    expect(collectAmendments(p, errors)).toEqual([]);
    expect(errors.map(e => e.code)).toEqual(['AMENDMENT_CHANGES_INVALID']);
    p.amendments = {};
    save(dir, p);
    const before = readFileSync(join(dir, 'project.json'));
    refusal(() => amend(dir), 'AMENDMENT_MALFORMED');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('unreadable/outside inputs, duplicate bindings, invalid words and candidate refusals preserve bytes', () => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    const args = ['parts', dir, '--kind', 'part', '--target', 'panel', '--by', 'owner', '--verbatim-file', words(dir)];
    refusal(() => amendCommand([...args, '--change', 'absent']), 'AMENDMENT_INPUT_UNREAD');
    symlinkSync(CLI, join(dir, 'outside.ts'));
    refusal(() => amendCommand([...args, '--change', 'outside.ts']), 'AMENDMENT_INPUT_UNREAD');
    refusal(() => amendCommand([...args, '--change', join(dir, 'words.txt')]), 'AMENDMENT_INPUT_UNREAD');
    refusal(() => amendCommand([...args, '--change', 'words.txt', '--change', './words.txt']), 'AMENDMENT_CHANGES_INVALID');
    writeFileSync(join(dir, 'words.txt'), Buffer.from([255]));
    refusal(() => amendCommand([...args, '--change', 'words.txt']), 'VERBATIM_INVALID_UTF8');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    // A carried candidate refusal does not block the amendment, and check still reports it.
    const p = read(dir); step(p, 'assemble').rests_on = []; save(dir, p);
    amend(dir);
    expect(arr(read(dir).amendments)).toHaveLength(1);
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('STEP_NO_BASIS');
  });

  describe('#760 an interview-answer amendment lapses only the steps resting on the changed answer', () => {
    const amendAnswer = (dir: string, answer: string): void => {
      writeFileSync(join(dir, 'direction.txt'), 'Synthetic new direction for the chains.\n');
      amendCommand(['rigging-interview', dir, '--kind', 'interview-answer', '--target', answer, '--change', 'direction.txt', '--by', 'owner', '--verbatim-file', words(dir)]);
    };
    const stepAwaits = (dir: string, now: number): string[] => nextProject(dir, now).awaits.filter(target => target.startsWith('plan.steps['));

    test.each(['bones', 'interview.waypoints[bones].guide'])('target %s: only bones and constraints reset; every other step keeps its record and next names exactly the two', target => {
      const dir = fixture(() => {}, 'example-project.json');
      const before = read(dir);
      amendAnswer(dir, target);
      const after = read(dir);
      const bound = arr(obj(after.plan).steps).map(obj).filter(s => arr(s.rests_on).includes('bones')).map(s => String(s.id));
      expect(bound).toEqual(['bones', 'constraints']);
      for (const raw of arr(obj(after.plan).steps)) {
        const s = obj(raw);
        // Control: an unrelated step's status and history are untouched by the amendment.
        if (bound.includes(String(s.id))) expect(s.status).toBe('pending');
        else expect(s).toEqual(step(before, String(s.id)));
      }
      const report = checkProject(dir);
      expect(report.refusals).toEqual([]);
      expect(report.effective_stage).toBe('rigging-interview');
      expect(stepAwaits(dir, EXAMPLE_NOW)).toEqual(['plan.steps[bones].status', 'plan.steps[constraints].status']);
      const moves = nextProject(dir, EXAMPLE_NOW).moves.filter(move => move.lapse?.target_field.startsWith('plan.steps['));
      expect(moves.map(move => [move.lapse?.code, move.lapse?.target_field])).toEqual([['AMENDED_STEP', 'plan.steps[bones]'], ['AMENDED_STEP', 'plan.steps[constraints]']]);
    });

    test('after the re-signed rigging-interview, next names the two reset steps and the cycle reaches rig-review', () => {
      const dir = fixture(() => {}, 'example-project.json');
      amendAnswer(dir, 'bones');
      testClock.set(EXAMPLE_NOW + 86_400_000);
      signoffCommand(['rigging-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
      const report = checkProject(dir);
      expect(report.refusals).toEqual([]);
      expect(report.effective_stage).toBe('rigging');
      expect(stepAwaits(dir, testClock.now())).toEqual(['plan.steps[bones].status', 'plan.steps[constraints].status']);
      for (const id of ['bones', 'constraints']) {
        stepStatusCommand([id, 'in-progress', dir, '--by', 'agent']);
        stepStatusCommand([id, 'at-checkpoint', dir, '--by', 'agent']);
        if (id === 'constraints') signoffCommand(['rigging', dir, '--by', 'owner', '--checkpoint', id, '--verbatim-file', words(dir)]);
        stepStatusCommand([id, 'done', dir, '--by', 'agent']);
      }
      const done = checkProject(dir);
      expect(done.refusals).toEqual([]);
      expect(done.effective_stage).toBe('rig-review');
      expect(stepAwaits(dir, testClock.now())).toEqual([]);
    });

    test('keep-by-binding keeps the checkpoint of a step that does not rest on the changed answer', () => {
      const dir = fixture(() => {}, 'example-project.json');
      amendAnswer(dir, 'bones');
      const p = read(dir);
      const target = obj(arr(p.amendments)[0]).target as JsonObject;
      expect(keepByBinding(p, target, { stage: 'rigging', checkpoint: 'meshes' })).toBe(true);
      expect(keepByBinding(p, target, { stage: 'rigging', checkpoint: 'constraints' })).toBe(false);
      expect(keepByBinding(p, target, { stage: 'rigging-interview' })).toBe(false);
      const summary = checkProject(dir).amendments![0]!;
      expect(summary.lapsed.filter(a => a.checkpoint !== undefined).map(a => a.checkpoint)).toEqual(['constraints', 'constraints']);
      expect(summary.keep_by_binding).toEqual([]);
    });

    test('a record from the earlier writer, which reset every later step, still checks without a new refusal', () => {
      const dir = fixture(() => {}, 'example-project.json');
      amendAnswer(dir, 'bones');
      const p = read(dir);
      for (const raw of arr(obj(p.plan).steps)) if (['meshes', 'motion', 'camera', 'timing', 'composition'].includes(String(obj(raw).id))) obj(raw).status = 'pending';
      save(dir, p);
      expect(checkProject(dir).refusals).toEqual([]);
    });

    test('an interview-answer target that names no question refuses before writing', () => {
      const dir = fixture(() => {}, 'example-project.json');
      const before = readFileSync(join(dir, 'project.json'));
      writeFileSync(join(dir, 'direction.txt'), 'Synthetic new direction.\n');
      refusal(() => amendCommand(['rigging-interview', dir, '--kind', 'interview-answer', '--target', 'interview.waypoints[bones]', '--change', 'direction.txt', '--by', 'owner', '--verbatim-file', words(dir)]), 'AMENDMENT_TARGET_INVALID');
      expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    });
  });

  test('CLI exposes the writer and refuses a caller-supplied clock', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'replacement.svg'), '<svg/>');
    const bytes = Buffer.from('\uFEFFSynthetic CLI correction.\r\n');
    const written = Bun.spawnSync([process.execPath, ...clockedCli(),
      'amend', 'parts', dir, '--kind', 'part', '--target', 'panel', '--change', 'replacement.svg', '--by', 'owner', '--json'], { stdin: bytes, stdout: 'pipe', stderr: 'pipe' });
    expect(written.exitCode).toBe(0);
    expect(Buffer.from(obj(arr(read(dir).amendments)[0]).verbatim as string)).toEqual(bytes);
    expect(JSON.parse(written.stdout.toString())).toEqual(arr(read(dir).amendments)[0]);
    expect(cli(['--help'], dir, gitEnv()).stdout).toContain('rig-create amend');
    const result = cli(['amend', 'parts', dir, '--kind', 'part', '--target', 'panel', '--change', 'input', '--by', 'owner', '--at', '2026-11-20'], dir, gitEnv());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('UNKNOWN_OPTION');
  });
});
