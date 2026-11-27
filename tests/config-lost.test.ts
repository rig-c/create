import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, handoffCommand, interviewCommand } from './clock.ts';
import { arr, bindFixtureAnswers, codes, fixture, framing, obj, retainSignoffs, retimeFixture, version, type Mutate } from './fixtures.ts';

/** The retired stage-order contract date (#981), kept as a fixture clock anchor. */
const STAGE_PROGRESS_SINCE = '2026-11-08T00:00:00Z';

const historical = JSON.parse(readFileSync(join(import.meta.dir, 'data/pre-interview.json'), 'utf8')) as {
  versions: JsonObject[];
  files: Record<string, string>;
};

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

describe('legacy pre-interview config loss', () => {
  test('interview check reads a historical config loss as a warning', () => {
    const unread = migratedCg();
    const beforeCheck = interviewCommand(['--check', '--json', unread]);
    expect(beforeCheck.exit).toBe(1);
    const beforeReport = JSON.parse(beforeCheck.stdout) as { refusals: { code: string; path: string; message: string }[]; warnings: { code: string }[] };
    expect(beforeReport.refusals.map((f) => f.code)).toEqual(['CG_GATES_UNREAD']);
    expect(beforeReport.refusals[0]?.path).toBe('versions[v1].provenance.config');
    expect(beforeReport.refusals[0]?.message).toContain('record its path and sha256');
    expect(beforeReport.refusals[0]?.message).not.toContain('config-lost');
    expect(beforeReport.warnings.map((f) => f.code)).not.toContain('CG_GATES_CONFIG_LOST');

    const declared = migratedCg((p) => {
      version(p, 1).config_lost = LOSS;
    });
    const afterCheck = interviewCommand(['--check', '--json', declared]);
    expect(afterCheck.exit).toBe(0);
    const afterReport = JSON.parse(afterCheck.stdout) as { ok: boolean; refusals: { code: string }[]; warnings: { code: string; path: string }[] };
    expect(afterReport.ok).toBe(true);
    expect(afterReport.refusals).toEqual([]);
    expect(afterReport.warnings.filter((f) => f.code === 'CG_GATES_CONFIG_LOST').map((f) => f.path)).toEqual(['versions[v1].config_lost']);
  });

  test('a pathless build config still refuses CG_GATES_UNREAD', () => {
    const dir = migratedCg((p) => {
      version(p, 1).provenance = { config: { sha256: 'a'.repeat(64) } };
    });
    const pathless = checkProject(dir).refusals.filter((f) => f.code === 'CG_GATES_UNREAD');
    expect(pathless.map((f) => f.path)).toEqual(['versions[v1].provenance.config']);
    expect(pathless[0]?.message).not.toContain('config-lost');
  });

  test('a historical config loss on the accepted rig blocks handoff', () => {
    const declareLoss: Mutate = (p) => {
      version(p, 1).config_lost = LOSS;
      const accepted = version(p, 2);
      accepted.provenance = null;
      delete accepted.built_with;
      accepted.config_lost = LOSS;
    };

    const prePost = migratedCg((p) => {
      p.stage = 'rig-review';
      retainSignoffs(p, (s) => stageIndex(String(s.stage)) <= stageIndex('rig-review'));
      for (const s of arr(obj(p.plan).steps)) {
        if (obj(s).phase === 'post') obj(s).status = 'pending';
      }
      p.versions = structuredClone(historical.versions);
      declareLoss(p);
    });
    expect(codes(checkProject(prePost))).toEqual([]);

    expect(() => handoffCommand([prePost])).toThrow(expect.objectContaining({
      code: 'PRE_INTERVIEW_CONFIG_LOST',
      exitCode: 1,
    }));
  });
});
