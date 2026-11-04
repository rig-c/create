import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkProject } from '../src/check.ts';
import { PRE_INTERVIEW_VERDICTS } from '../src/pre-interview.ts';
import { latestAccepted, readVersions } from '../src/review.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, codes, fixture, obj, version, withCode, type Mutate } from './fixtures.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';

const historical = JSON.parse(readFileSync(join(import.meta.dir, 'data/pre-interview.json'), 'utf8')) as {
  versions: JsonObject[];
  files: Record<string, string>;
};

/** Two historical rigs followed by the example's create-built post versions. */
function migrated(mutate: Mutate = () => {}): string {
  return fixture((p) => {
    p.versions = [...structuredClone(historical.versions), version(p, 3), version(p, 4)];
    // The first create build answers both the earlier bounce and the carried timing item.
    version(p, 3).answers_feedback = [{ version: 1, verdict: 0 }, { version: 2, verdict: 0 }];
    mutate(p);
  }, 'example-project.json', historical.files);
}

const verdict = (p: JsonObject, n = 2, index = 0): JsonObject => obj(arr(version(p, n).verdicts)[index]);
const original = (p: JsonObject, n = 2, index = 0): JsonObject => obj(arr(version(p, n).original_verdicts)[index]);
const env = gitEnv();

describe('pre-interview migration (#39)', () => {
  test('two preserved versions pass without provenance, including recorded words and a carried item', () => {
    const dir = migrated();
    const before = readFileSync(join(dir, 'project.json'));
    const report = checkProject(dir);
    expect(codes(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.provenance.map((s) => s.version)).toEqual(['versions[v3]', 'versions[v4]']);
    expect(report.feedback[0]).toMatchObject({ version: 1, answered_by: [2, 3], items: { user: 0, delegated: 0, not_asked: 1 } });
    const project = JSON.parse(before.toString()) as JsonObject;
    expect(verdict(project).on_items).toEqual([{ id: 'post_timing', answer_was: 'user' }]);
    expect(verdict(project).as_recorded).toEqual(original(project));
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    const result = cli(['interview', '--check', '--json', dir], dir, env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  test('the exact mapping table preserves original strings and refuses every unlisted spelling', () => {
    for (const [value, mapped] of Object.entries(PRE_INTERVIEW_VERDICTS)) {
      const report = checkProject(migrated((p) => {
        original(p).verdict = value;
        obj(verdict(p).as_recorded).verdict = value;
        verdict(p).verdict = mapped;
      }));
      expect(withCode(report, 'PRE_INTERVIEW_VERDICT_UNKNOWN')).toEqual([]);
      expect(withCode(report, 'PRE_INTERVIEW_VERDICT_MISMATCH')).toEqual([]);
    }
    for (const value of ['approved', 'accepted (probably)', 'ACCEPTED', ' accepted', 'toString']) {
      const report = checkProject(migrated((p) => {
        original(p).verdict = value;
        obj(verdict(p).as_recorded).verdict = value;
      }));
      expect(withCode(report, 'PRE_INTERVIEW_VERDICT_UNKNOWN')).toHaveLength(1);
    }
    const report = checkProject(migrated((p) => { verdict(p).verdict = 'bounced'; }));
    expect(withCode(report, 'PRE_INTERVIEW_VERDICT_MISMATCH')).toHaveLength(1);
  });

  test('every original verdict survives unchanged, in order, even duplicate original values', () => {
    for (const mutate of [
      (p: JsonObject) => { version(p, 2).verdicts = []; },
      (p: JsonObject) => { delete verdict(p).as_recorded; },
      (p: JsonObject) => { obj(verdict(p).as_recorded).ticket = 99; },
      (p: JsonObject) => { arr(version(p, 2).original_verdicts).push(structuredClone(original(p))); },
      (p: JsonObject) => { arr(version(p, 2).verdicts).push(structuredClone(verdict(p))); },
    ]) {
      expect(codes(checkProject(migrated(mutate)))).toContain('PRE_INTERVIEW_VERDICT_LOST');
    }
    const report = checkProject(migrated((p) => {
      arr(version(p, 2).original_verdicts).push({ verdict: 'bounced', note: 'A later bounce.' });
      arr(version(p, 2).verdicts).unshift({ ...structuredClone(verdict(p)), as_recorded: { verdict: 'bounced', note: 'A later bounce.' } });
    }));
    expect(withCode(report, 'PRE_INTERVIEW_VERDICT_LOST')).toHaveLength(2);
  });

  test('repeated originals are retained separately, and later real reviews can be appended', () => {
    const report = checkProject(migrated((p) => {
      arr(version(p, 1).original_verdicts).push(structuredClone(original(p, 1)));
      arr(version(p, 1).verdicts).push(structuredClone(verdict(p, 1)));
      arr(version(p, 2).answers_feedback).push({ version: 1, verdict: 1 });
      arr(version(p, 2).verdicts).push({ by: 'owner', at: '2026-11-03T09:00:00Z', review: 'rig-review', verdict: 'accepted', verbatim: 'Still accepted.', source: 'chat', on_items: [] });
    }));
    expect(report.ok).toBe(true);
    expect(report.feedback.filter((f) => f.version === 1)).toHaveLength(2);
  });

  test('a historical post version keeps its rig basis and needs no provenance', () => {
    const bytes = '{"take":3}\n';
    const dir = migrated((p) => {
      const post = version(p, 3);
      post.pre_interview = true;
      delete post.provenance;
      post.original_verdicts = [structuredClone(verdict(p, 3))];
      verdict(p, 3).as_recorded = structuredClone(original(p, 3));
      post.outputs = [{ path: 'outputs/v3/take.json', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) }];
    });
    const output = join(dir, 'outputs/v3');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'take.json'), bytes);
    const report = checkProject(dir);
    expect(report.ok).toBe(true);
    expect(report.provenance.map((s) => s.version)).toEqual(['versions[v4]']);
  });

  test('a missing original array on a migrated version is refused', () => {
    expect(codes(checkProject(migrated((p) => { delete version(p, 1).original_verdicts; })))).toContain('PRE_INTERVIEW_HISTORY_MISSING');
  });

  test('history only under x-pre_create warns with migration steps and preserves exit 0', () => {
    const beforeMigration: Mutate = (p) => {
      p.stage = 'interview';
      p.signoffs = [];
      obj(p.plan).steps = [];
      p.versions = [];
    };
    const baseline = fixture(beforeMigration);
    const dir = fixture((p) => {
      beforeMigration(p);
      p['x-pre_create'] = { versions: structuredClone(historical.versions) };
    });
    const before = readFileSync(join(dir, 'project.json'));
    const report = checkProject(dir);
    expect(report.ok).toBe(true);
    expect(report.refusals).toEqual(checkProject(baseline).refusals);
    expect(withCode(report, 'PRE_INTERVIEW_UNMIGRATED')).toEqual([]);
    const warnings = report.warnings.filter((w) => w.code === 'PRE_INTERVIEW_UNMIGRATED');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe('x-pre_create.versions');
    expect(warnings[0].message).toContain('steps 1–6');
    expect(warnings[0].message).toContain('docs/PROJECT.md');
    expect(warnings[0].message).toContain('preserve original verdicts and frozen outputs');
    const baselineCli = cli(['interview', '--check', '--json', baseline], baseline, env);
    const result = cli(['interview', '--check', '--json', dir], dir, env);
    expect(baselineCli.code).toBe(0);
    expect(result.code).toBe(baselineCli.code);
    expect(JSON.parse(result.stdout).warnings.some((w: { code: string }) => w.code === 'PRE_INTERVIEW_UNMIGRATED')).toBe(true);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('unmigrated history preserves a valid current handoff', () => {
    const dir = fixture((p) => { p['x-pre_create'] = { versions: structuredClone(historical.versions) }; });
    expect(checkProject(dir).ok).toBe(true);
    expect(cli(['handoff', '--rig', '2', dir], dir, env).code).toBe(0);
  });

  test('the pending-migration warning does not clear migrated-record refusals', () => {
    const dir = migrated((p) => {
      p['x-pre_create'] = { versions: structuredClone(historical.versions) };
      delete version(p, 1).original_verdicts;
    });
    const report = checkProject(dir);
    expect(report.warnings.filter((w) => w.code === 'PRE_INTERVIEW_UNMIGRATED')).toHaveLength(1);
    expect(codes(report)).toContain('PRE_INTERVIEW_HISTORY_MISSING');
    expect(cli(['interview', '--check', '--json', dir], dir, env).code).toBe(1);
  });

  test('null verbatim needs the record in note and its source, and a valid timestamp', () => {
    for (const field of ['note', 'source', 'at', 'by', 'verbatim', 'review', 'on_items']) {
      const report = checkProject(migrated((p) => { delete verdict(p)[field]; }));
      expect(withCode(report, 'VERDICT_MALFORMED').map((f) => f.path)).toContain('versions[v2].verdicts[0]');
    }
    for (const [field, value] of [['note', ' '], ['source', ''], ['at', 'not a date'], ['verbatim', '']] as const) {
      expect(codes(checkProject(migrated((p) => { verdict(p)[field] = value; })))).toContain('VERDICT_MALFORMED');
    }
  });

  test('a historical direct quote is retained verbatim', () => {
    const words = 'Keep the timing item.  그대로.\r\n';
    const dir = migrated((p) => { verdict(p).verbatim = words; });
    expect(checkProject(dir).ok).toBe(true);
    expect(cli(['handoff', '--json', dir], dir, env).stdout).toContain(JSON.stringify(words));
  });

  test('create-built versions still require provenance and the user words', () => {
    const report = checkProject(migrated((p) => {
      delete version(p, 3).provenance;
      verdict(p, 4).verbatim = null;
      verdict(p, 4).note = 'Someone recorded an acceptance.';
    }));
    expect(withCode(report, 'PROVENANCE_MISSING').map((f) => f.path)).toEqual(['versions[v3].provenance']);
    expect(withCode(report, 'VERDICT_MALFORMED').map((f) => f.path)).toEqual(['versions[v4].verdicts[0]']);
  });

  test('pre-interview versions must precede create versions in list and version order', () => {
    const after = checkProject(migrated((p) => { arr(p.versions).push(arr(p.versions).shift()!); }));
    expect(codes(after)).toContain('PRE_INTERVIEW_ORDER');
    const duplicate = checkProject(migrated((p) => { version(p, 2).n = 1; }));
    expect(codes(duplicate)).toContain('PRE_INTERVIEW_ORDER');
    const badFlag = checkProject(migrated((p) => { version(p, 1).pre_interview = 'true'; }));
    expect(codes(badFlag)).toContain('VERSION_MALFORMED');
  });

  test('the first create version can answer pre-interview feedback through the normal review writer', () => {
    const dir = migrated((p) => { version(p, 3).answers_feedback = []; });
    const result = cli(['review', '3', dir, '--verdict', 'provisional', '--by', 'owner', '--review', 'direction-review', '--verbatim', 'Checking the carried timing item.', '--source', 'chat', '--answers-feedback', '1:0', '--answers-feedback', '2:0'], dir, env);
    expect(result.code).toBe(0);
    const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    expect(version(p, 3).answers_feedback).toEqual([{ version: 1, verdict: 0 }, { version: 2, verdict: 0 }]);
    expect(checkProject(dir).ok).toBe(true);
  });

  test('missing, edited, malformed and duplicated outputs are named refusals', () => {
    const missing = migrated();
    rmSync(join(missing, 'outputs/v1/rig.json'));
    expect(codes(checkProject(missing))).toContain('PRE_INTERVIEW_OUTPUT_UNREAD');
    const changed = migrated();
    writeFileSync(join(changed, 'outputs/v2/rig.json'), '{"build":9}\n');
    expect(codes(checkProject(changed))).toContain('PRE_INTERVIEW_OUTPUT_CHANGED');
    expect(codes(checkProject(migrated((p) => { obj(arr(version(p, 2).outputs)[0]).bytes = 0; })))).toContain('PRE_INTERVIEW_OUTPUT_CHANGED');
    for (const outputs of [[], [{}], 'not a list']) {
      expect(codes(checkProject(migrated((p) => { version(p, 1).outputs = outputs; })))).toContain('PRE_INTERVIEW_OUTPUT_MALFORMED');
    }
    expect(codes(checkProject(migrated((p) => { arr(version(p, 1).outputs).push(structuredClone(obj(arr(version(p, 1).outputs)[0]))); })))).toContain('PRE_INTERVIEW_OUTPUT_MALFORMED');
  });

  test('output paths cannot escape, including through a symlink', () => {
    for (const path of ['../escape.json', '/escape.json']) {
      expect(codes(checkProject(migrated((p) => { obj(arr(version(p, 1).outputs)[0]).path = path; })))).toContain('PRE_INTERVIEW_OUTPUT_MALFORMED');
    }
    const dir = migrated();
    const outside = join(tempDir(), 'outside.json');
    writeFileSync(outside, historical.files['outputs/v1/rig.json']);
    rmSync(join(dir, 'outputs/v1/rig.json'));
    symlinkSync(outside, join(dir, 'outputs/v1/rig.json'));
    expect(codes(checkProject(dir))).toContain('PRE_INTERVIEW_OUTPUT_UNREAD');
  });
});

describe('pre-interview handoff', () => {
  test('an owner acceptance authorizes post and prints its pre-interview status and source', () => {
    const dir = migrated();
    const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    expect(latestAccepted(readVersions(p))?.n).toBe(2);
    const result = cli(['handoff', dir], dir, env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('rig v2 (pre-interview)');
    expect(result.stdout).toContain('record of the user: A producer recorded');
    expect(result.stdout).toContain('source: producer log, entry 2');
    const json = cli(['handoff', '--json', dir], dir, env);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ rig_version: 2, pre_interview: true, accepted: { source: 'producer log, entry 2', verbatim: null } });
  });

  test('invalid imported history or a changed output cannot authorize handoff', () => {
    for (const mutate of [
      (p: JsonObject) => { delete verdict(p).source; },
      (p: JsonObject) => { delete verdict(p).note; },
      (p: JsonObject) => { delete verdict(p).as_recorded; },
      (p: JsonObject) => { original(p).verdict = 'approved'; obj(verdict(p).as_recorded).verdict = 'approved'; },
    ]) {
      const dir = migrated(mutate);
      expect(cli(['handoff', dir], dir, env).code).toBe(1);
    }
    const dir = migrated();
    writeFileSync(join(dir, 'outputs/v2/rig.json'), 'changed');
    expect(cli(['handoff', dir], dir, env).stderr).toContain('PRE_INTERVIEW_OUTPUT_CHANGED');
  });

  test('still evidence, human signature, acceptance dates and review remain required', () => {
    const cases: [Mutate, string][] = [
      [(p) => { version(p, 2).evidence = []; }, 'RIG_ACCEPTED_WITHOUT_STILL'],
      [(p) => { p.signoffs = arr(p.signoffs).filter((s) => obj(s).stage !== 'rig-review'); }, 'RIG_REVIEW_UNSIGNED'],
      [(p) => { verdict(p).by = 'agent'; }, 'RIG_VERSION_UNACCEPTED'],
      [(p) => { verdict(p).at = 'not a date'; }, 'VERDICT_MALFORMED'],
    ];
    for (const [mutate, code] of cases) {
      const dir = migrated(mutate);
      expect(cli(['handoff', dir], dir, env).stderr).toContain(code);
    }
    expect(codes(checkProject(migrated((p) => { version(p, 3).at = '2026-11-01T09:00:00Z'; })))).toContain('POST_ON_UNACCEPTED_RIG');
  });

  test('a later create rig requires its own review and then supersedes the historical acceptance', () => {
    const dir = migrated((p) => {
      const next = structuredClone(version(p, 2));
      delete next.pre_interview;
      delete next.original_verdicts;
      next.n = 5;
      next.verdicts = [];
      next.answers_feedback = [];
      arr(p.versions).push(next);
    });
    expect(cli(['handoff', dir], dir, env).stderr).toContain('RIG_VERSION_UNACCEPTED');
    const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    version(p, 5).verdicts = [{ by: 'owner', at: '2026-11-16T09:00:00Z', review: 'rig-review', verdict: 'accepted', verbatim: 'Accepted.', source: 'chat', on_items: [] }];
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
    expect(cli(['handoff', '--rig', '2', dir], dir, env).stderr).toContain('POST_ON_SUPERSEDED_RIG');
    const current = cli(['handoff', '--json', dir], dir, env);
    expect(current.code).toBe(0);
    expect(JSON.parse(current.stdout)).toMatchObject({ rig_version: 5, pre_interview: false });
  });
});
