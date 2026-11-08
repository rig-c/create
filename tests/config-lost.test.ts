import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, versionCommand } from './clock.ts';
import { Refusal } from '../src/refusal.ts';
import { STAGE_PROGRESS_SINCE } from '../src/stage-progress.ts';
import { arr, bindFixtureAnswers, codes, fixture, framing, obj, retainSignoffs, retimeFixture, version, type Mutate } from './fixtures.ts';
import { cli, gitEnv } from './helpers.ts';

const historical = JSON.parse(readFileSync(join(import.meta.dir, 'data/pre-interview.json'), 'utf8')) as {
  versions: JsonObject[];
  files: Record<string, string>;
};

const env = gitEnv();
const LOSS = {
  note: 'The historical build config did not survive.',
  source: 'archive log, config inventory',
} as const;

/** A migrated CG project where pre-interview rig v1 lost its build config and v2 predates the CG gates. */
function migratedCg(mutate: Mutate = () => {}): string {
  return fixture((p) => {
    obj(framing(p, 'rig_type').answer).value = 'fullscreen.minimal';
    for (const s of arr(p.signoffs)) delete obj(s).answer_hashes;
    bindFixtureAnswers(p);
    p.versions = [...structuredClone(historical.versions), version(p, 3), version(p, 4)];
    version(p, 3).answers_feedback = [{ version: 1, verdict: 0 }, { version: 2, verdict: 0 }];
    version(p, 1).provenance = null;
    delete version(p, 1).built_with;
    version(p, 2).built_with = { '@rig-c/parts': '2.3.0' };
    mutate(p);
    // A migrated pre-interview project predates stage-progress authority.
    retimeFixture(p, Date.parse(STAGE_PROGRESS_SINCE));
  }, 'legacy-example-project.json', historical.files);
}

describe('version config-lost writer (#171)', () => {
  test('Bar 1 & 2: clears CG_GATES_UNREAD into CG_GATES_CONFIG_LOST warning and writes the exact hand-step bytes', () => {
    const dir = migratedCg();
    const file = join(dir, 'project.json');
    const beforeBytes = readFileSync(file);

    const beforeCheck = cli(['interview', '--check', '--json', dir], dir, env);
    expect(beforeCheck.code).toBe(1);
    const beforeReport = JSON.parse(beforeCheck.stdout) as { refusals: { code: string; path: string }[]; warnings: { code: string; path: string }[] };
    expect(beforeReport.refusals.map((f) => f.code)).toEqual(['CG_GATES_UNREAD']);
    expect(beforeReport.refusals[0]?.path).toBe('versions[v1].provenance.config');
    expect(beforeReport.warnings.map((f) => f.code)).not.toContain('CG_GATES_CONFIG_LOST');

    const expectedRecord = JSON.parse(beforeBytes.toString('utf8')) as JsonObject;
    version(expectedRecord, 1).config_lost = { note: LOSS.note, source: LOSS.source };
    const expectedBytes = Buffer.from(`${JSON.stringify(expectedRecord, null, 2)}\n`);

    const write = cli(['version', 'config-lost', '1', '--note', LOSS.note, '--source', LOSS.source, dir], dir, env);
    expect(write.stderr).toBe('');
    expect(write.code).toBe(0);

    const afterBytes = readFileSync(file);
    expect(afterBytes).toEqual(expectedBytes);

    const afterCheck = cli(['interview', '--check', '--json', dir], dir, env);
    expect(afterCheck.code).toBe(0);
    const afterReport = JSON.parse(afterCheck.stdout) as { ok: boolean; refusals: { code: string; path: string }[]; warnings: { code: string; path: string }[] };
    expect(afterReport.ok).toBe(true);
    expect(afterReport.refusals).toEqual([]);
    expect(afterReport.warnings.filter((f) => f.code === 'CG_GATES_CONFIG_LOST').map((f) => f.path)).toEqual(['versions[v1].config_lost']);
  });

  test('Bar 3: refuses non-pre-interview version, surviving provenance.config, already set config_lost, empty note/source, and unknown version, leaving project.json byte-identical', () => {
    // 1. Version is not pre_interview: true
    {
      const dir = migratedCg((p) => {
        version(p, 1).config_lost = { note: LOSS.note, source: LOSS.source };
      });
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      const res = cli(['version', 'config-lost', '3', '--note', LOSS.note, '--source', LOSS.source, dir], dir, env);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('CONFIG_LOST_NOT_PRE_INTERVIEW');
      expect(readFileSync(file)).toEqual(before);
    }

    // 2. Version has provenance.config
    {
      const dir = migratedCg((p) => {
        version(p, 1).provenance = {
          config: { path: 'evidence/v1/review-config.json', sha256: 'a'.repeat(64) },
          sections: {},
        };
      });
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      const res = cli(['version', 'config-lost', '1', '--note', LOSS.note, '--source', LOSS.source, dir], dir, env);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('CONFIG_LOST_HAS_CONFIG');
      expect(readFileSync(file)).toEqual(before);
    }

    // 3. config_lost is already set
    {
      const dir = migratedCg((p) => {
        version(p, 1).config_lost = { note: LOSS.note, source: LOSS.source };
      });
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      const res = cli(['version', 'config-lost', '1', '--note', 'Different note', '--source', 'different source', dir], dir, env);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('CONFIG_LOST_ALREADY_SET');
      expect(readFileSync(file)).toEqual(before);
    }

    // 4. Note or source is empty (or missing)
    {
      const dir = migratedCg();
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      for (const [note, source] of [
        ['', LOSS.source],
        ['   ', LOSS.source],
        [LOSS.note, ''],
        [LOSS.note, '  \t '],
      ] as const) {
        const res = cli(['version', 'config-lost', '1', '--note', note, '--source', source, dir], dir, env);
        expect(res.code).toBe(1);
        expect(res.stderr).toContain('CONFIG_LOST_EMPTY');
        expect(readFileSync(file)).toEqual(before);
      }
      const missingFlag = cli(['version', 'config-lost', '1', '--note', LOSS.note, dir], dir, env);
      expect(missingFlag.code).toBe(2);
      expect(missingFlag.stderr).toContain('CONFIG_LOST_USAGE');
      expect(readFileSync(file)).toEqual(before);
      // A following option is never taken as the missing value.
      for (const values of [['--note', '--json', '--source', LOSS.source], ['--note', LOSS.note, '--source', '--json']]) {
        const flagAsValue = cli(['version', 'config-lost', '1', ...values, dir], dir, env);
        expect(flagAsValue.code).toBe(2);
        expect(flagAsValue.stderr).toContain('CONFIG_LOST_USAGE');
        expect(readFileSync(file)).toEqual(before);
      }
    }

    // 5. No such version exists
    {
      const dir = migratedCg();
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      const res = cli(['version', 'config-lost', '99', '--note', LOSS.note, '--source', LOSS.source, dir], dir, env);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('CONFIG_LOST_VERSION_UNKNOWN');
      expect(readFileSync(file)).toEqual(before);
    }
  });

  test('Bar 4: a config-lost version cannot authorize post work (handoff refuses PRE_INTERVIEW_CONFIG_LOST; post basis refuses POST_ON_UNACCEPTED_RIG)', () => {
    // Candidate check refuses when post versions already rest on the target rig version
    const withPost = migratedCg((p) => {
      version(p, 1).config_lost = { note: LOSS.note, source: LOSS.source };
      version(p, 2).provenance = null;
      delete version(p, 2).built_with;
    });
    const withPostFile = join(withPost, 'project.json');
    const beforeWithPost = readFileSync(withPostFile);
    const blockedWrite = cli(['version', 'config-lost', '2', '--note', LOSS.note, '--source', LOSS.source, withPost], withPost, env);
    expect(blockedWrite.code).toBe(1);
    expect(blockedWrite.stderr).toContain('POST_ON_UNACCEPTED_RIG');
    expect(readFileSync(withPostFile)).toEqual(beforeWithPost);

    // At rig-review (before post versions exist), writing config_lost on the accepted rig succeeds,
    // and then handoff refuses PRE_INTERVIEW_CONFIG_LOST and a post version resting on it refuses POST_ON_UNACCEPTED_RIG.
    const prePost = migratedCg((p) => {
      p.stage = 'rig-review';
      retainSignoffs(p, (s) => stageIndex(String(s.stage)) <= stageIndex('rig-review'));
      for (const s of arr(obj(p.plan).steps)) {
        if (obj(s).phase === 'post') obj(s).status = 'pending';
      }
      p.versions = structuredClone(historical.versions);
      version(p, 1).config_lost = { note: LOSS.note, source: LOSS.source };
      version(p, 2).provenance = null;
      delete version(p, 2).built_with;
    });
    expect(codes(checkProject(prePost))).toEqual(['CG_GATES_UNREAD']);
    const write = cli(['version', 'config-lost', '2', '--note', LOSS.note, '--source', LOSS.source, prePost], prePost, env);
    expect(write.code).toBe(0);
    expect(codes(checkProject(prePost))).toEqual([]);

    const handoffRes = cli(['handoff', prePost], prePost, env);
    expect(handoffRes.code).toBe(1);
    expect(handoffRes.stderr).toContain('PRE_INTERVIEW_CONFIG_LOST');

    const candidateWithPost = JSON.parse(readFileSync(join(prePost, 'project.json'), 'utf8')) as JsonObject;
    arr(candidateWithPost.versions).push({
      n: 3,
      kind: 'post',
      rig_version: 2,
      at: '2026-11-03T09:00:00Z',
      outputs: [],
      evidence: [],
      verdicts: [],
      answers_feedback: [{ version: 1, verdict: 0 }, { version: 2, verdict: 0 }],
      provenance: { config: null, sections: {} },
    });
    expect(codes(checkProject(prePost, candidateWithPost))).toContain('POST_ON_UNACCEPTED_RIG');
  });

  test('refuses on a record whose stage check stopped early, leaving project.json byte-identical', () => {
    const dir = migratedCg();
    const file = join(dir, 'project.json');
    const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    project.stage = 'no-such-stage';
    writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
    expect(codes(checkProject(dir))).toEqual(['STAGE_UNKNOWN']);
    const before = readFileSync(file);
    let error: unknown;
    try { versionCommand(['config-lost', '1', '--note', LOSS.note, '--source', LOSS.source, dir]); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe('STAGE_UNKNOWN');
    expect(readFileSync(file)).toEqual(before);
  });
});
