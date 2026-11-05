import { expect, test } from 'bun:test';
import { checkProject } from '../src/check.ts';
import { interviewCommand } from '../src/interview.ts';
import { ASK_COVERAGE_SINCE } from '../src/ask-coverage.ts';
import { WAYPOINT_ASKS } from '../src/waypoints.ts';
import { arr, fixture, obj, waypoint, framing, citedSections } from './fixtures.ts';

test('filled synthetic example covers every applicable ask without warnings', () => {
  const report = checkProject(fixture());
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY']);
  expect(Object.keys(WAYPOINT_ASKS)).toHaveLength(6);
});

function crux(delegated: boolean): string {
  return fixture((p) => {
    const guide = obj(waypoint(p, 'motion').guide);
    guide.verbatim = delegated ? 'Breath and blink. The lantern flame flickers. The rest is yours.' : 'Breath and blink. The lantern flame flickers.';
    guide.asks = [{ id: 'tracks', state: 'user' }, { id: 'blink', state: 'user' }];
    if (delegated) {
      guide.asks.push(...['extent', 'speed', 'loop'].map((id) => ({ id, state: 'delegated' })));
    } else delete guide.agent_decision;
  });
}

test('crux answered with no agent_decision refuses each named remainder through interview --check', () => {
  const result = interviewCommand(['--check', crux(false), '--json']);
  expect(result.exit).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.refusals.map((f: {path: string}) => f.path)).toEqual([
    'interview.waypoints[motion].guide.asks[extent]',
    'interview.waypoints[motion].guide.asks[speed]',
    'interview.waypoints[motion].guide.asks[loop]',
  ]);
  expect(report.refusals[0].message).toContain('How far');
});

test('same crux with explicit delegation and decided remainder passes', () => {
  expect(interviewCommand(['--check', crux(true), '--json']).exit).toBe(0);
});

test('missing entire coverage refuses at the independent boundary', () => {
  const r = checkProject(fixture((p) => {
    const guide = obj(waypoint(p, 'motion').guide);
    guide.at = ASK_COVERAGE_SINCE;
    delete guide.asks;
  }));
  expect(r.refusals.filter((f) => f.code === 'GUIDE_ASK_UNANSWERED')).toHaveLength(5);
});

for (const at of ['2026-11-04T23:59:59Z', 'unreadable']) {
  test(`legacy absent coverage warns and preserves exit 0: ${at}`, () => {
    const dir = fixture((p) => {
      const guide = obj(waypoint(p, 'motion').guide);
      guide.at = at;
      delete guide.asks;
      for (const n of [1, 2]) for (const entry of arr(citedSections(p, n).motion)) delete obj(entry).asks;
    });
    const result = interviewCommand(['--check', dir, '--json']);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout).warnings.map((f: {code: string}) => f.code)).toEqual(['QUESTION_SET_STALE', 'GUIDE_ASKS_LEGACY', 'STAGE_ORDER_LEGACY']);
  });
}

test('explicit partial legacy coverage is still checked', () => {
  const r = checkProject(fixture((p) => {
    const guide = obj(waypoint(p, 'motion').guide);
    guide.at = '2026-11-01T00:00:00Z';
    guide.asks = [{ id: 'tracks', state: 'user' }];
  }));
  expect(r.refusals.filter((f) => f.code === 'GUIDE_ASK_UNANSWERED')).toHaveLength(4);
});

test('a claimed delegation cannot bypass decision requirements by omitting agent_decision', () => {
  const r = checkProject(fixture((p) => { delete obj(waypoint(p, 'motion').guide).agent_decision; }));
  expect(r.refusals.map((f) => f.code)).toEqual(['GUIDE_PARTIAL_UNMARKED', 'DELEGATION_UNDECIDED']);
});

for (const bad of [null, [{ id: 'typo', state: 'user' }], [{ id: 'tracks', state: 'other' }], [{ id: 'tracks', state: 'user' }, { id: 'tracks', state: 'user' }]]) {
  test(`invalid list refuses: ${JSON.stringify(bad)}`, () => {
    const r = checkProject(fixture((p) => { obj(waypoint(p, 'motion').guide).asks = bad; }));
    expect(r.refusals.some((f) => f.code === 'GUIDE_ASKS_MALFORMED')).toBe(true);
  });
}

test('game logic asks states instead of tracks or blink', () => {
  const r = checkProject(fixture((p) => {
    obj(framing(p, 'rig_type').answer).value = 'fullscreen.game_logic';
    const guide = obj(waypoint(p, 'motion').guide);
    guide.asks = arr(guide.asks).filter((entry) => !['tracks', 'blink'].includes(String(obj(entry).id)));
    guide.asks.push({ id: 'states', state: 'user' }, { id: 'transitions', state: 'user' });
  }));
  expect(r.refusals.filter((f) => f.code.startsWith('GUIDE_ASK'))).toEqual([]);
});


test('whole delegation cannot label any ask as user-answered', () => {
  const r = checkProject(fixture((p) => {
    obj(arr(obj(waypoint(p, 'seethrough').guide).asks)[0]).state = 'user';
  }));
  expect(r.refusals.some((f) => f.code === 'GUIDE_ASKS_MALFORMED')).toBe(true);
  expect(r.refusals.some((f) => f.path.endsWith('asks[layers]'))).toBe(true);
});

test('a missing finer-grained ask cannot hide behind its answered sibling', () => {
  const r = checkProject(fixture((p) => {
    const guide = obj(waypoint(p, 'constraints').guide);
    guide.asks = arr(guide.asks).filter((entry) => obj(entry).id !== 'strength');
    for (const n of [1, 2]) for (const entry of arr(citedSections(p, n).constraints)) {
      obj(entry).asks = arr(obj(entry).asks).filter((id) => id !== 'strength');
    }
  }));
  expect(r.refusals.map((f) => f.path)).toEqual(['interview.waypoints[constraints].guide.asks[strength]']);
});
