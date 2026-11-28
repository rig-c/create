import { fixture as materializeExample } from './fixtures.ts';
import { describe, expect, test } from 'bun:test';

import { type CheckReport } from '../src/check.ts';
import { checkReviews, type ReviewCtx } from '../src/review.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { checkProject } from './clock.ts';

type Mutate = (project: JsonObject) => void;

/** The filled example in an OS temp folder, mutated in place. */
function fixture(mutate: Mutate = () => {}): string {
  return materializeExample(mutate, 'legacy-example-project.json');
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

describe('numbered review records', () => {
  test('the filled example passes', () => {
    const r = checkProject(fixture());
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('check reads a post version whose rig has no rig-review acceptance', () => {
    const r = checkProject(fixture((p) => (version(p, 3).rig_version = 1)));
    expect(codes(r)).toEqual([]);
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

  test('check reads a post version on an older rig after a new rig is accepted', () => {
    const ctx: ReviewCtx = {
      project: { versions: [
        { n: 1, kind: 'rig', verdicts: [{ by: 'owner', review: 'rig-review', verdict: 'accepted', at: '2026-11-10T00:00:00Z' }] },
        { n: 2, kind: 'post', rig_version: 1, at: '2026-11-11T00:00:00Z' },
        { n: 3, kind: 'rig', verdicts: [{ by: 'owner', review: 'rig-review', verdict: 'accepted', at: '2026-11-12T00:00:00Z' }] },
      ] },
      effectiveStage: 'post',
      refusals: [],
    };
    checkReviews(ctx);
    expect(ctx.refusals).toEqual([]);
  });
});

describe('historical rig still evidence', () => {
  test('a still on a moving camera, without a frame or with a bad hash is malformed', () => {
    for (const [field, value] of [
      ['camera', 'push_in'],
      ['frame', null],
      ['sha256', 'abc'],
    ] as const) {
      const r = checkProject(fixture((p) => (obj(arr(version(p, 2).evidence)[0])[field] = value)));
      expect(withCode(r, 'STILL_MALFORMED').map((f) => f.path)).toEqual(['versions[v2].evidence[0]']);
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
  const env = gitEnv(undefined, { scope: 'suite' });

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

  test('agent and provisional verdicts cannot authorize handoff', () => {
    const agent = fixture((p) => (obj(arr(version(p, 2).verdicts)[0]).by = 'agent'));
    const provisional = fixture((p) => (obj(arr(version(p, 2).verdicts)[0]).verdict = 'provisional'));
    for (const dir of [agent, provisional]) {
      const r = cli(['handoff', dir], dir, env);
      expect(r.code).toBe(1);
      expect(r.stderr).toStartWith('rig-create: RIG_VERSION_UNACCEPTED:');
    }
  });

  test('a later human bounce withdraws the acceptance used by handoff', () => {
    const dir = fixture((p) => {
      arr(version(p, 2).verdicts).push({ by: 'owner', at: '2026-11-20T10:00:00Z', review: 'rig-review', verdict: 'bounced', verbatim: 'The hem tears after all.', on_items: [] });
    });
    const r = cli(['handoff', dir], dir, env);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith('rig-create: RIG_VERSION_UNACCEPTED:');
  });

  test('#981 no rig-review sign-off: the accepted rig still hands off', () => {
    const dir = fixture((p) => (p.signoffs = arr(p.signoffs).filter((s) => obj(s).stage !== 'rig-review')));
    const r = cli(['handoff', '--rig', '2', dir], dir, env);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' });
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

  test('an accepted rig without a still passes interview check and hands off', () => {
    const dir = fixture((p) => (version(p, 2).evidence = []));
    const check = cli(['interview', '--check', dir, '--json'], dir, env);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout).refusals).toEqual([]);
    const json = cli(['handoff', dir, '--json'], dir, env);
    expect(json.code).toBe(0);
    const result = JSON.parse(json.stdout);
    expect(result).toMatchObject({ ok: true, rig_version: 2 });
    expect(result).not.toHaveProperty('still');
    const plain = cli(['handoff', dir], dir, env);
    expect(plain.code).toBe(0);
    expect(plain.stdout).not.toContain('still frame');
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

test('an undated rig acceptance is malformed', () => {
  const r = checkProject(fixture((p) => { delete obj(arr(version(p, 2).verdicts)[0]).at; }));
  expect(codes(r)).toContain('VERSION_MALFORMED');
});
