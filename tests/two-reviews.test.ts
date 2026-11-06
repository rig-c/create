import { bindFixtureAnswers, bindFixtureSignoffs } from './fixtures.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkProject, type CheckReport } from '../src/check.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { writePartsPackage } from './parts-package.ts';

type Mutate = (project: JsonObject) => void;

/** The filled example in an OS temp folder, mutated in place. */
function fixture(mutate: Mutate = () => {}): string {
  const dir = join(tempDir(), 'project');
  mkdirSync(dir);
  const project = readTemplate('legacy-example-project.json');
  bindFixtureAnswers(project, dir);
  mutate(project);
  bindFixtureSignoffs(project);
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  writePartsPackage(dir);
  return dir;
}

function obj(v: Json | undefined): JsonObject {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object');
  return v;
}
function arr(v: Json | undefined): Json[] {
  if (!Array.isArray(v)) throw new Error('expected an array');
  return v;
}
const version = (p: JsonObject, n: number): JsonObject => {
  const found = arr(p.versions).map(obj).find((v) => v.n === n);
  if (found === undefined) throw new Error(`no version ${n}`);
  return found;
};
const codes = (r: CheckReport): string[] => r.refusals.map((f) => f.code);
const withCode = (r: CheckReport, code: string) => r.refusals.filter((f) => f.code === code);

/** A new rig version 5, built after v2's acceptance and not reviewed. */
function addRig5(p: JsonObject, accepted: boolean): void {
  const v2 = version(p, 2);
  const v5: JsonObject = JSON.parse(JSON.stringify(v2)) as JsonObject;
  v5.n = 5;
  v5.at = '2026-11-16T10:00:00Z';
  v5.answers_feedback = [];
  v5.changed = 'the scarf gets a second chain';
  v5.evidence = [
    { kind: 'still', path: 'evidence/v5/still-frame.png', sha256: 'a'.repeat(64), camera: 'fixed', frame: 2, what: 'the rig at the fixed camera' },
  ];
  v5.verdicts = accepted
    ? [{ by: 'user', at: '2026-11-16T12:00:00Z', review: 'rig-review', verdict: 'accepted', verbatim: 'yes', source: 'chat', on_items: [] }]
    : [];
  arr(p.versions).push(v5);
}

describe('post on an unaccepted rig', () => {
  test('the filled example passes', () => {
    const r = checkProject(fixture());
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('a post version on a rig version with no rig-review acceptance is refused by name', () => {
    const r = checkProject(fixture((p) => (version(p, 3).rig_version = 1)));
    expect(withCode(r, 'POST_ON_UNACCEPTED_RIG').map((f) => f.path)).toEqual(['versions[v3].rig_version']);
    expect(r.ok).toBe(false);
  });

  test('a post version naming no rig version, or none at all, is refused', () => {
    const r = checkProject(
      fixture((p) => {
        version(p, 3).rig_version = 9;
        version(p, 4).rig_version = null;
      }),
    );
    expect(withCode(r, 'POST_ON_UNACCEPTED_RIG').map((f) => f.path)).toEqual(['versions[v3].rig_version', 'versions[v4].rig_version']);
  });

  test('an acceptance by the agent, or a provisional verdict, is not an acceptance', () => {
    const agent = checkProject(fixture((p) => (obj(arr(version(p, 2).verdicts)[0]).by = 'agent')));
    expect(withCode(agent, 'POST_ON_UNACCEPTED_RIG')).toHaveLength(2);
    const provisional = checkProject(fixture((p) => (obj(arr(version(p, 2).verdicts)[0]).verdict = 'provisional')));
    expect(codes(provisional)).toContain('POST_ON_UNACCEPTED_RIG');
    expect(codes(provisional)).toContain('RIG_VERSION_UNACCEPTED');
  });

  test('a post version built before its rig was accepted is refused', () => {
    const r = checkProject(fixture((p) => (version(p, 3).at = '2026-11-13T08:00:00Z')));
    expect(withCode(r, 'POST_ON_UNACCEPTED_RIG').map((f) => f.path)).toEqual(['versions[v3].rig_version']);
  });

  test('a rig version built after the acceptance and not reviewed is refused once the stage is past rig-review', () => {
    const r = checkProject(fixture((p) => addRig5(p, false)));
    expect(withCode(r, 'RIG_VERSION_UNACCEPTED').map((f) => f.path)).toEqual(['versions[v5]']);
  });

  test('the same unreviewed rig at stage rig-review is the review in progress, not a refusal', () => {
    const r = checkProject(
      fixture((p) => {
        addRig5(p, false);
        p.stage = 'rig-review';
        p.signoffs = arr(p.signoffs).filter((s) => !['post-interview', 'direction-review'].includes(String(obj(s).stage)));
        p.versions = arr(p.versions).filter((v) => obj(v).kind === 'rig');
      }),
    );
    expect(codes(r)).not.toContain('RIG_VERSION_UNACCEPTED');
  });

  test('once the new rig is accepted, the current post version on the old rig is refused as superseded', () => {
    const r = checkProject(fixture((p) => addRig5(p, true)));
    expect(withCode(r, 'POST_ON_SUPERSEDED_RIG').map((f) => f.path)).toEqual(['versions[v4].rig_version']);
    expect(codes(r)).not.toContain('RIG_VERSION_UNACCEPTED');
  });
});

describe('the rig review rests on a still frame', () => {
  test('an acceptance with no still-frame evidence is refused by name', () => {
    const r = checkProject(fixture((p) => (version(p, 2).evidence = [])));
    expect(withCode(r, 'RIG_ACCEPTED_WITHOUT_STILL').map((f) => f.path)).toEqual(['versions[v2].verdicts[0]']);
  });

  test('an evidence entry without kind "still" does not count', () => {
    const r = checkProject(fixture((p) => delete obj(arr(version(p, 2).evidence)[0]).kind));
    expect(codes(r)).toEqual(['RIG_ACCEPTED_WITHOUT_STILL']);
  });

  test('a still on a moving camera, without a frame or with a bad hash is malformed, and does not count', () => {
    for (const [field, value] of [
      ['camera', 'push_in'],
      ['frame', null],
      ['sha256', 'abc'],
    ] as const) {
      const r = checkProject(fixture((p) => (obj(arr(version(p, 2).evidence)[0])[field] = value)));
      expect(withCode(r, 'STILL_MALFORMED').map((f) => f.path)).toEqual(['versions[v2].evidence[0]']);
      expect(codes(r)).toContain('RIG_ACCEPTED_WITHOUT_STILL');
    }
  });

  test('a still at the renderer setup pose is recorded as frame "setup", not as t=0', () => {
    const r = checkProject(fixture((p) => (obj(arr(version(p, 2).evidence)[0]).frame = 'setup')));
    expect(codes(r)).toEqual([]);
    const bad = checkProject(fixture((p) => (obj(arr(version(p, 2).evidence)[0]).frame = 'rest')));
    expect(withCode(bad, 'STILL_MALFORMED').map((f) => f.path)).toEqual(['versions[v2].evidence[0]']);
  });

  test('a bounced rig version needs no still to be refused for', () => {
    const r = checkProject(fixture((p) => (version(p, 1).evidence = [])));
    expect(codes(r)).toEqual([]);
  });
});

describe('rig-create handoff', () => {
  const env = gitEnv();

  test('the filled example: exit 0, prints the accepted rig version', () => {
    const dir = fixture();
    const plain = cli(['handoff', dir], dir, env);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('handoff: post work is on rig v2');
    const named = cli(['handoff', '--rig', '2', dir], dir, env);
    expect(named.code).toBe(0);
    const json = cli(['handoff', '--json', dir], dir, env);
    expect(json.code).toBe(0);
    const out = JSON.parse(json.stdout) as { rig_version: number; still: { path: string } };
    expect(out.rig_version).toBe(2);
    expect(out.still.path).toBe('evidence/v2/still-frame.png');
  });

  test('a rig version with no rig-review acceptance: exit 1, named refusal', () => {
    const dir = fixture();
    const r = cli(['handoff', '--rig', '1', dir], dir, env);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith('rig-create: POST_ON_UNACCEPTED_RIG: versions[v1]');
  });

  test('no rig-review sign-off: exit 1, RIG_REVIEW_UNSIGNED', () => {
    const dir = fixture((p) => (p.signoffs = arr(p.signoffs).filter((s) => obj(s).stage !== 'rig-review')));
    const r = cli(['handoff', '--rig', '2', dir], dir, env);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith('rig-create: RIG_REVIEW_UNSIGNED:');
  });

  test('a newer rig not yet reviewed: exit 1, RIG_VERSION_UNACCEPTED naming it', () => {
    const dir = fixture((p) => addRig5(p, false));
    const r = cli(['handoff', dir], dir, env);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith('rig-create: RIG_VERSION_UNACCEPTED: versions[v5]');
  });

  test('the old rig after a newer one is accepted: exit 1, POST_ON_SUPERSEDED_RIG', () => {
    const dir = fixture((p) => addRig5(p, true));
    const r = cli(['handoff', '--rig', '2', dir], dir, env);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith('rig-create: POST_ON_SUPERSEDED_RIG:');
    expect(cli(['handoff', '--rig', '5', dir], dir, env).code).toBe(0);
  });

  test('an acceptance with no still frame is not handed off', () => {
    const dir = fixture((p) => (version(p, 2).evidence = []));
    const r = cli(['handoff', dir], dir, env);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith('rig-create: RIG_ACCEPTED_WITHOUT_STILL:');
  });

  test('usage errors exit 2', () => {
    const dir = fixture();
    expect(cli(['handoff', '--rig', 'x', dir], dir, env).code).toBe(2);
    expect(cli(['handoff', '--nope', dir], dir, env).code).toBe(2);
  });

  test('--help lists handoff', () => {
    const r = cli(['--help'], tempDir(), env);
    expect(r.stdout).toContain('rig-create handoff');
  });
});

describe('review fixes: the last human verdict decides, and order is dated', () => {
  const codesOf = (r: CheckReport): string[] => r.refusals.map((f) => f.code);

  test('a later human bounce withdraws the acceptance', () => {
    const r = checkProject(
      fixture((p) => {
        arr(version(p, 2).verdicts).push({ by: 'owner', at: '2026-11-20T10:00:00Z', review: 'rig-review', verdict: 'bounced', verbatim: 'No, the hem tears after all.', on_items: [] });
      }),
    );
    expect(codesOf(r)).toContain('POST_ON_UNACCEPTED_RIG');
  });

  test('an undated acceptance authorises nothing', () => {
    const r = checkProject(fixture((p) => { delete obj(arr(version(p, 2).verdicts)[0]).at; }));
    expect(codesOf(r)).toContain('VERSION_MALFORMED');
    expect(codesOf(r)).toContain('POST_ON_UNACCEPTED_RIG');
  });

  test('an undated post version is refused', () => {
    const r = checkProject(fixture((p) => { delete version(p, 3).at; }));
    expect(codesOf(r)).toContain('POST_ON_UNACCEPTED_RIG');
  });
});
