import { describe, expect, test } from 'bun:test';

import { checkProject, type CheckReport } from '../src/check.ts';
import type { Json } from '../src/templates.ts';
import { fixture, obj, waypoint, type Mutate } from './fixtures.ts';

const BUST_CODES = new Set(['BUST_EXCLUSION_UNREASONED', 'BUST_VALUE_UNKNOWN']);
const bust = (r: CheckReport): string[] => r.refusals.filter((f) => BUST_CODES.has(f.code)).map((f) => `${f.code} ${f.path}`);

const PATH = 'interview.waypoints[meshes].guide';
const withBust = (value: Json): Mutate => (p) => { obj(obj(waypoint(p, 'meshes').guide).value).bust = value; };

describe('the bust at meshes', () => {
  test('no bust field (the filled example) is the default and passes', () => {
    const report = checkProject(fixture());
    expect(bust(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('"default" passes', () => {
    const report = checkProject(fixture(withBust('default')));
    expect(bust(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('an exclusion with its reason passes', () => {
    const report = checkProject(fixture(withBust({ excluded: true, reason: 'a rigid breastplate covers the chest' })));
    expect(bust(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('an exclusion with an empty, blank or missing reason is refused', () => {
    const unreasoned: Json[] = [{ excluded: true, reason: '' }, { excluded: true, reason: '   ' }, { excluded: true }];
    for (const excluded of unreasoned) {
      expect(bust(checkProject(fixture(withBust(excluded))))).toEqual([`BUST_EXCLUSION_UNREASONED ${PATH}.value.bust`]);
    }
  });

  test('any other value is refused', () => {
    for (const other of ['excluded', 'none', null, { excluded: false, reason: 'x' }]) {
      expect(bust(checkProject(fixture(withBust(other))))).toEqual([`BUST_VALUE_UNKNOWN ${PATH}.value.bust`]);
    }
  });

  test('a delegation is read from the agent decision', () => {
    const report = checkProject(fixture((p) => {
      waypoint(p, 'meshes').guide = {
        delegated: true, by: 'user', at: '2026-11-10T14:11:00Z', verbatim: 'you decide',
        agent_decision: { value: { bust: { excluded: true, reason: '' } }, reasoning: 'armour', at: '2026-11-10T14:11:00Z' },
      };
    }));
    expect(bust(report)).toEqual([`BUST_EXCLUSION_UNREASONED ${PATH}.agent_decision.value.bust`]);
  });

  test('an addition that excludes the bust needs its reason too', () => {
    const report = checkProject(fixture((p) => {
      obj(waypoint(p, 'meshes').guide).additions = [
        { by: 'user', at: '2026-11-10T14:12:00Z', verbatim: 'leave the bust out', value: { bust: { excluded: true, reason: ' ' } }, source: 'interview, chat' },
      ];
    }));
    expect(bust(report)).toEqual([`BUST_EXCLUSION_UNREASONED ${PATH}.additions[0].value.bust`]);
  });

  test('an unreasoned exclusion makes the report not ok', () => {
    const report = checkProject(fixture(withBust({ excluded: true, reason: '' })));
    expect(report.ok).toBe(false);
  });
});
