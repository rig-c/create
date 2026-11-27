import { resignAfterChange } from './fixtures.ts';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject } from '../src/templates.ts';
import { arr, codes, fixture, obj, version, waypoint, withCode } from './fixtures.ts';
import { cli, gitEnv } from './helpers.ts';
import { checkProject } from './clock.ts';

const warned = (dir: string, code: string) => checkProject(dir).warnings.filter((w) => w.code === code);

describe('feedback answered by the next version (interview --check)', () => {
  test('the filled example passes, and each bounce is counted by cause', () => {
    const r = checkProject(fixture());
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.feedback.map((f) => [f.verdict, f.items, f.answered_by])).toEqual([
      ['versions[v1].verdicts[0]', { user: 1, delegated: 0, not_asked: 1 }, [2]],
      ['versions[v3].verdicts[0]', { user: 1, delegated: 0, not_asked: 0 }, [4]],
    ]);
  });

  test('a bounced version whose later version does not answer it is refused by name', () => {
    const r = checkProject(fixture((p) => (version(p, 2).answers_feedback = [])));
    expect(withCode(r, 'FEEDBACK_UNANSWERED').map((f) => f.path)).toEqual(['versions[v1].verdicts[0]']);
    expect(r.ok).toBe(false);
  });

  test('rig feedback given at the direction review may be answered by a later rig version', () => {
    const r = checkProject(
      fixture((p) => {
        version(p, 4).answers_feedback = [];
        const v5 = JSON.parse(JSON.stringify(version(p, 2))) as JsonObject;
        Object.assign(v5, { n: 5, at: '2026-11-16T10:00:00Z', answers_feedback: [{ version: 3, verdict: 0 }], verdicts: [] });
        arr(p.versions).push(v5);
      }),
    );
    expect(withCode(r, 'FEEDBACK_UNANSWERED')).toEqual([]);
    expect(r.feedback.find((f) => f.version === 3)?.answered_by).toEqual([5]);
  });

  test('a bounce with no later version yet is open work: a warning, not a refusal', () => {
    const dir = fixture((p) => {
      p.versions = [version(p, 1)];
    });
    const r = checkProject(dir);
    expect(withCode(r, 'FEEDBACK_UNANSWERED')).toEqual([]);
    expect(warned(dir, 'FEEDBACK_OPEN').map((w) => w.path)).toEqual(['versions[v1].verdicts[0]']);
  });

  test('a bounce withdrawn by a later acceptance on the same version needs no answer', () => {
    const r = checkProject(
      fixture((p) => {
        version(p, 2).answers_feedback = [];
        arr(version(p, 1).verdicts).push({ by: 'user', at: '2026-11-12T10:00:00Z', review: 'rig-review', verdict: 'accepted', verbatim: 'actually, fine', source: 'chat', on_items: [] });
      }),
    );
    expect(withCode(r, 'FEEDBACK_UNANSWERED')).toEqual([]);
    expect(r.feedback.find((f) => f.version === 1)?.withdrawn).toBe(true);
  });

  test('an answering ref that points at no verdict, or not at an earlier version, is refused', () => {
    const r = checkProject(
      fixture((p) => {
        version(p, 2).answers_feedback = [{ version: 1, verdict: 0 }, { version: 1, verdict: 7 }, { version: 9, verdict: 0 }, { version: 4, verdict: 0 }, 'v1'];
      }),
    );
    expect(withCode(r, 'FEEDBACK_REF_UNKNOWN').map((f) => f.path)).toEqual([
      'versions[v2].answers_feedback[1]',
      'versions[v2].answers_feedback[2]',
      'versions[v2].answers_feedback[3]',
      'versions[v2].answers_feedback[4]',
    ]);
  });

  test('a not-asked item whose sentence was never added to the guide is refused', () => {
    const dropped = checkProject(fixture((p) => delete obj(waypoint(p, 'bones').guide).additions));
    expect(withCode(dropped, 'FEEDBACK_NOT_ADDED').map((f) => f.path)).toEqual(['versions[v1].verdicts[0].on_items[0]']);
    const wrongSource = checkProject(fixture((p) => (obj(arr(obj(waypoint(p, 'bones').guide).additions)[0]).source = 'chat')));
    expect(withCode(wrongSource, 'FEEDBACK_NOT_ADDED')).toHaveLength(1);
    const notQuoted = checkProject(fixture((p) => (obj(arr(obj(waypoint(p, 'bones').guide).additions)[0]).verbatim = 'a hinge on the lantern')));
    expect(withCode(notQuoted, 'FEEDBACK_NOT_ADDED')).toHaveLength(1);
  });

  test('an item id that is no answer, and a malformed item, are refused', () => {
    const r = checkProject(
      fixture((p) => {
        arr(obj(arr(version(p, 1).verdicts)[0]).on_items).push({ id: 'lantern', answer_was: 'user' }, { id: 'motion', answer_was: 'agent' });
      }),
    );
    expect(withCode(r, 'FEEDBACK_ITEM_UNKNOWN').map((f) => f.path)).toEqual(['versions[v1].verdicts[0].on_items[2]']);
    expect(withCode(r, 'VERDICT_MALFORMED').map((f) => f.path)).toEqual(['versions[v1].verdicts[0].on_items[3]']);
  });

  test('a bounce on a delegated item counts as the user\'s chosen cost', () => {
    const r = checkProject(fixture((p) => arr(obj(arr(version(p, 1).verdicts)[0]).on_items).push({ id: 'seethrough', answer_was: 'delegated' })));
    expect(r.feedback.find((f) => f.version === 1)?.items).toEqual({ user: 1, delegated: 1, not_asked: 1 });
  });
});

describe('rig-create review writer retirement', () => {
  test('CLI refuses with NUMBERED_WRITER_REMOVED and exit 2 before mutating project.json', () => {
    const dir = fixture();
    const env = gitEnv();
    const before = readFileSync(join(dir, 'project.json'));
    for (const args of [
      ['review', 'v4', dir, '--verdict', 'provisional', '--by', 'user', '--review', 'direction-review', '--verbatim', 'hold on', '--source', 'chat'],
      ['review', '2', dir, '--verdict', 'bounced'],
      ['review', '2', dir, '--from-review', 'act-1'],
    ]) {
      const result = cli(args, dir, env);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('NUMBERED_WRITER_REMOVED');
      expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    }
  });
});

describe('delegated feedback names its ask', () => {
  function verdict(ask: unknown, include = true, change: (p: JsonObject) => void = () => {}): string {
    return fixture((p) => {
      arr(version(p, 2).verdicts).push({
        by: 'user', at: '2026-11-13T09:16:00Z', review: 'rig-review', verdict: 'provisional',
        verbatim: 'The density should change.', source: 'chat',
        on_items: [{ id: 'meshes', answer_was: 'delegated', ...(include ? { ask } : {}) }],
      } as JsonObject);
      change(p);
    });
  }

  test('the delegated ask passes and the user-answered ask is refused', () => {
    expect(checkProject(verdict('density')).refusals).toEqual([]);
    expect(withCode(checkProject(verdict('bend')), 'FEEDBACK_ASK_STATE')).toHaveLength(1);
  });

  test('an unknown ask and a missing record are refused by name', () => {
    expect(withCode(checkProject(verdict('unknown')), 'FEEDBACK_ASK_UNKNOWN')).toHaveLength(1);
    const r = checkProject(verdict('density', true, (p) => {
      obj(waypoint(p, 'meshes').guide).asks = [{ id: 'bend', state: 'user' }, { id: 'rigid', state: 'user' }];
    }));
    expect(withCode(r, 'FEEDBACK_ASK_UNRECORDED')).toHaveLength(1);
  });

  test('missing ask warns, while a legacy guide gets no new feedback finding', () => {
    const r = checkProject(resignAfterChange(verdict(null, false)));
    expect(r.refusals).toEqual([]);
    expect(r.warnings.map((f) => f.code)).toEqual(['QUESTION_SET_STALE', 'PARTS_VERDICT_FILE_LEGACY', 'RIGGING_INTERVIEW_PAINTING_LEGACY', 'FEEDBACK_ASK_MISSING', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
    const legacy = checkProject(resignAfterChange(verdict(null, false, (p) => {
      const guide = obj(waypoint(p, 'meshes').guide);
      delete guide.asks;
      guide.at = '2026-11-04T00:00:00Z';
      for (const n of [1, 2]) for (const section of ['meshes', 'regions']) {
        for (const entry of arr(obj(obj(version(p, n).provenance).sections)[section])) if (obj(entry).guide === 'meshes') delete obj(entry).asks;
      }
    })));
    expect(legacy.refusals).toEqual([]);
    expect(legacy.warnings.map((f) => f.code)).toEqual(['QUESTION_SET_STALE', 'PARTS_VERDICT_FILE_LEGACY', 'GUIDE_ASKS_LEGACY', 'RIGGING_INTERVIEW_PAINTING_LEGACY', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });

  test('a verdict against the historical delegation survives a user re-answer', () => {
    const r = checkProject(resignAfterChange(verdict('density', true, (p) => {
      const record = waypoint(p, 'meshes');
      record.history = [record.guide!];
      record.guide = { ...obj(record.guide), asks: arr(obj(record.guide).asks).map((entry) => ({ ...obj(entry), state: 'user' })) };
      delete obj(record.guide).agent_decision;
    })));
    expect(r.refusals).toEqual([]);
  });
});

describe('#454 historical feedback compatibility', () => {
  test('check retains accepted, agent, duplicate and integer target refs without new refusals', async () => {
    const { checkFeedback } = await import('../src/feedback.ts');
    const target = 2 ** 53; // Existing check uses integers, not safe integers.
    const project: JsonObject = { versions: [
      { n: target, pre_interview: true, verdicts: [{ by: 'agent', review: 'rig-review', verdict: 'accepted', on_items: [] }] },
      { n: target + 2, pre_interview: true, verdicts: [], answers_feedback: [{ version: target, verdict: 0 }, { version: target, verdict: 0 }] },
    ] };
    const ctx = { project, refusals: [], warnings: [], items: [], signoffs: [], steps: [], stage: 'interview', effectiveStage: 'interview', collection: null, predatesPartsReview: null, dir: '' };
    const before = JSON.stringify(project);
    expect(checkFeedback(ctx)).toEqual([]);
    expect(ctx.refusals).toEqual([]);
    expect(ctx.warnings).toEqual([]);
    expect(JSON.stringify(project)).toBe(before);
  });
  test('shared validator rejects a present same/later target without tightening historical targets', async () => {
    const { feedbackReferenceFinding } = await import('../src/feedback.ts');
    const project: JsonObject = { versions: [{ n: 4, verdicts: [{ by: 'user', verdict: 'bounced' }] }] };
    for (const n of [3, 4]) expect(feedbackReferenceFinding(project, n, { version: 4, verdict: 0 }, `versions[v${n}].answers_feedback[0]`)?.code).toBe('FEEDBACK_REF_UNKNOWN');
  });
});
