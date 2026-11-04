import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkProject } from '../src/check.ts';
import { recordVerdict, type ReviewInput } from '../src/feedback.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, codes, fixture, obj, version, waypoint, withCode } from './fixtures.ts';
import { cli, gitEnv } from './helpers.ts';

const warned = (dir: string, code: string) => checkProject(dir).warnings.filter((w) => w.code === code);
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;

function refusalOf(f: () => unknown): Refusal {
  try {
    f();
  } catch (e) {
    if (e instanceof Refusal) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

const base = (over: Partial<ReviewInput>): ReviewInput => ({
  version: 4,
  verdict: 'bounced',
  by: 'user',
  review: 'direction-review',
  verbatim: 'too fast',
  source: 'chat',
  items: [],
  quotes: {},
  values: {},
  ...over,
});

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

describe('rig-create review records a verdict', () => {
  test('verbatim byte for byte, answer_was derived, a not-asked item lands in the guide, stage unchanged', () => {
    const words = 'The beam is “too fast” — and the gulls?  None. 灯台は残して.\n';
    const dir = fixture();
    const before = read(dir);
    const r = recordVerdict(
      dir,
      base({
        verbatim: words,
        items: [{ id: 'post_timing', answerWas: null }, { id: 'post_composition', answerWas: 'not-asked' }],
        quotes: { post_composition: 'the gulls?' },
        values: { post_composition: { gulls: true } },
        at: '2026-11-16T09:00:00Z',
      }),
    );
    expect(r.verdict_path).toBe('versions[v4].verdicts[1]');
    const after = read(dir);
    const v = obj(arr(version(after, 4).verdicts)[1]);
    expect(Buffer.from(v.verbatim as string)).toEqual(Buffer.from(words));
    expect(v.on_items).toEqual([
      { id: 'post_timing', answer_was: 'user' },
      { id: 'post_composition', answer_was: 'not-asked' },
    ]);
    const guide = obj(byPost(after, 'post_composition').guide);
    expect(guide.additions).toEqual([{ by: 'user', at: '2026-11-16T09:00:00Z', verbatim: 'the gulls?', value: { gulls: true }, source: 'polish feedback, v4' }]);
    expect(guide.verbatim).toBe(obj(byPost(before, 'post_composition').guide).verbatim as string);
    expect(after.stage).toBe(before.stage);
    expect(after.signoffs).toEqual(before.signoffs);
    // The record it leaves: the bounce is open work, the sentence is in place.
    const check = checkProject(dir);
    expect(withCode(check, 'FEEDBACK_NOT_ADDED')).toEqual([]);
    expect(warned(dir, 'FEEDBACK_OPEN').map((w) => w.path)).toEqual(['versions[v4].verdicts[1]']);
  });

  test('a delegated item derives delegated; naming it a user answer is refused by name and nothing is written', () => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'), 'utf8');
    const e = refusalOf(() => recordVerdict(dir, base({ version: 2, review: 'rig-review', items: [{ id: 'seethrough', answerWas: 'user' }] })));
    expect(e.code).toBe('FEEDBACK_ITEM_CONTRADICTS');
    expect(e.message).toContain('seethrough');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(before);
    const ok = recordVerdict(dir, base({ version: 2, review: 'rig-review', items: [{ id: 'seethrough', answerWas: null }] }));
    expect(ok.items[0]?.answer_was).toBe('delegated');
  });

  test('a user sentence is not a delegation; a sentence that left part open must be named', () => {
    const dir = fixture((p) => {
      const guide = obj(waypoint(p, 'bones').guide);
      guide.verbatim = 'A chain down the scarf, one in each coat tail, one in her hair tail. Place the bones along each named part for its full length.';
      guide.value = { chains: ['scarf', 'coat_tail_l', 'coat_tail_r', 'hair_tail'], placement: 'along each named part', length: 'full part length' };
      guide.asks = [{ id: 'chains', state: 'user' }, { id: 'placement', state: 'user' }, { id: 'length', state: 'user' }];
      delete guide.agent_decision;
    });
    expect(refusalOf(() => recordVerdict(dir, base({ version: 2, review: 'rig-review', items: [{ id: 'bones', answerWas: 'delegated' }] }))).code).toBe('FEEDBACK_ITEM_CONTRADICTS');
    expect(refusalOf(() => recordVerdict(dir, base({ version: 2, review: 'rig-review', items: [{ id: 'assemble', answerWas: null }] }))).code).toBe('FEEDBACK_ITEM_AMBIGUOUS');
    const ok = recordVerdict(dir, base({ version: 2, review: 'rig-review', items: [{ id: 'assemble', answerWas: 'delegated' }] }));
    expect(ok.items[0]).toMatchObject({ answer_was: 'delegated', how: 'named' });
  });

  test('partially delegated bones and meshes accept explicitly named delegated feedback', () => {
    for (const id of ['bones', 'meshes']) {
      const result = recordVerdict(fixture(), base({ version: 2, review: 'rig-review', items: [{ id, answerWas: 'delegated' }] }));
      expect(result.items[0]).toMatchObject({ id, answer_was: 'delegated', how: 'named' });
    }
  });

  test('unknown items, a review of the wrong kind and a quote not in the words are refused', () => {
    const dir = fixture();
    expect(refusalOf(() => recordVerdict(dir, base({ items: [{ id: 'x_gulls', answerWas: 'not-asked' }] }))).code).toBe('FEEDBACK_ITEM_UNKNOWN');
    expect(refusalOf(() => recordVerdict(dir, base({ review: 'rig-review' }))).code).toBe('REVIEW_WRONG_KIND');
    expect(refusalOf(() => recordVerdict(dir, base({ version: 9 }))).code).toBe('REVIEW_VERSION_UNKNOWN');
    expect(
      refusalOf(() => recordVerdict(dir, base({ items: [{ id: 'post_timing', answerWas: 'not-asked' }], quotes: { post_timing: 'slower' } }))).code,
    ).toBe('FEEDBACK_QUOTE_NOT_IN_VERBATIM');
    expect(refusalOf(() => recordVerdict(fixture((p) => (waypoint(p, 'motion').guide = null)), base({ version: 2, review: 'rig-review', items: [{ id: 'motion', answerWas: null }] }))).code).toBe(
      'FEEDBACK_ITEM_SILENT',
    );
  });

  test('the CLI prints what it recorded and exits 0; a contradiction exits 1 with the code', () => {
    const dir = fixture();
    const env = gitEnv();
    const ok = cli(
      ['review', 'v4', dir, '--verdict', 'provisional', '--by', 'user', '--review', 'direction-review', '--verbatim', 'hold on', '--source', 'chat', '--item', 'post_timing'],
      dir,
      env,
    );
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('recorded versions[v4].verdicts[1]');
    expect(ok.stdout).toContain('post_timing: user (from the record)');
    expect(ok.stdout).toContain('stage unchanged (accepted)');
    const bad = cli(
      ['review', '2', dir, '--verdict', 'bounced', '--by', 'user', '--review', 'rig-review', '--verbatim', 'no', '--source', 'chat', '--item', 'seethrough:user'],
      dir,
      env,
    );
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('FEEDBACK_ITEM_CONTRADICTS');
    const usage = cli(['review', '2', dir, '--verdict', 'bounced'], dir, env);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('REVIEW_OPTION_MISSING');
  });
});

function byPost(p: JsonObject, id: string): JsonObject {
  const found = arr(obj(obj(p.interview).post).items).find((x) => obj(x).id === id);
  if (found === undefined) throw new Error(`no post item ${id}`);
  return obj(found);
}

describe('review record input options', () => {
  test('file preserves bytes, --at is verbatim, and answering references are recorded', () => {
    const dir = fixture();
    const file = join(dir, 'words.txt');
    const text = '\uFEFF  좋아\r\n\n';
    writeFileSync(file, text);
    const r = cli(['review', '4', '--verdict', 'accepted', '--by', 'user', '--review', 'direction-review', '--source', 'note', '--verbatim-file', file,
      '--at', '2026-11-16T01:02:03+09:00', '--answers-feedback', '2:0'], dir, gitEnv());
    expect(r.code).toBe(0);
    const v = version(read(dir), 4);
    const verdict = obj(arr(v.verdicts).at(-1));
    expect(Buffer.from(verdict.verbatim as string)).toEqual(readFileSync(file));
    expect(verdict.at).toBe('2026-11-16T01:02:03+09:00');
    expect(arr(v.answers_feedback)).toContainEqual({ version: 2, verdict: 0 });
  });

  test.each(['4:0', '99:0', '1:99', '1:0'])('invalid or already recorded feedback %s writes nothing', (ref) => {
    const dir = fixture((p) => { version(p, 4).answers_feedback = [{ version: 1, verdict: 0 }]; });
    const before = readFileSync(join(dir, 'project.json'));
    const r = cli(['review', '4', '--verdict', 'accepted', '--by', 'user', '--review', 'direction-review', '--source', 'chat', '--verbatim', 'yes', '--answers-feedback', ref], dir, gitEnv());
    expect(r.code).toBe(1);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('duplicates, agent reviewers, invalid time and conflicting input options write nothing', () => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    const base = ['review', '4', '--verdict', 'accepted', '--review', 'direction-review', '--source', 'chat', '--verbatim', 'yes'];
    for (const options of [['--by', 'agent'], ['--by', 'user', '--at', 'bad'], ['--by', 'user', '--verbatim-file', 'missing'],
      ['--by', 'user', '--answers-feedback', '2:0', '--answers-feedback', '2:0']]) {
      expect(cli([...base, ...options], dir, gitEnv()).code).not.toBe(0);
      expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    }
  });
});
