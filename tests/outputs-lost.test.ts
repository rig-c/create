import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { nextCommand } from '../src/next.ts';
import { SIGNOFF_TARGET_SINCE } from '../src/signoff-target.ts';
import { stageIndex } from '../src/stages.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { checkProject, handoffCommand, interviewCommand, testClock } from './clock.ts';
import { arr, bindFixtureAnswers, bindFixtureSignoffs, codes, fixture, obj, retainSignoffs, retimeFixture, version, type Mutate } from './fixtures.ts';
import { tempDir } from './helpers.ts';

/** The retired stage-order contract date (#981), kept as a fixture clock anchor. */
const STAGE_PROGRESS_SINCE = '2026-11-08T00:00:00Z';

const historical = JSON.parse(readFileSync(join(import.meta.dir, 'data/pre-interview.json'), 'utf8')) as {
  versions: JsonObject[];
  files: Record<string, string>;
};

const LOSS = {
  note: 'The historical frozen outputs did not survive.',
  source: 'archive log, output inventory',
} as const;

const SECOND_BYTES = '{"build":1,"part":"extra"}\n';
const SECOND_SHA = createHash('sha256').update(SECOND_BYTES).digest('hex');
const FIRST_RIG_SHA = '59e8937fd590eb1fa3c4afb64e78d21707354372f88286931b445279d91058ae';

/** A migrated project with two pre-interview rig versions followed by two create-built post versions. */
function migratedOutputs(mutate: Mutate = () => {}, files: Record<string, string> = historical.files): string {
  return fixture((p) => {
    for (const s of arr(p.signoffs)) delete obj(s).answer_hashes;
    bindFixtureAnswers(p);
    p.versions = [...structuredClone(historical.versions), version(p, 3), version(p, 4)];
    version(p, 3).answers_feedback = [{ version: 1, verdict: 0 }, { version: 2, verdict: 0 }];
    arr(version(p, 1).outputs).push({
      path: 'outputs/v1/extra.json',
      sha256: SECOND_SHA,
      bytes: Buffer.byteLength(SECOND_BYTES),
    });
    retimeFixture(p, Date.parse(STAGE_PROGRESS_SINCE));
    mutate(p);
  }, 'legacy-example-project.json', { ...files, 'outputs/v1/extra.json': SECOND_BYTES });
}

function declareAcceptedOutputLoss(p: JsonObject): void {
  bindFixtureSignoffs(p);
  const accepted = version(p, 2);
  const { path, sha256 } = obj(arr(accepted.outputs)[0]);
  accepted.outputs = [];
  accepted.outputs_lost = { ...LOSS, recorded: [{ path, sha256 }] };
}

describe('legacy pre-interview output loss', () => {
  test('interview check and handoff read a historical loss of all outputs', () => {
    const unread = migratedOutputs();
    rmSync(join(unread, 'outputs/v1/rig.json'));
    rmSync(join(unread, 'outputs/v1/extra.json'));

    const beforeCheck = interviewCommand(['--check', '--json', unread]);
    expect(beforeCheck.exit).toBe(1);
    const beforeReport = JSON.parse(beforeCheck.stdout) as { refusals: { code: string; path: string; message: string }[] };
    expect(beforeReport.refusals.map((f) => [f.code, f.path])).toEqual([
      ['PRE_INTERVIEW_OUTPUT_UNREAD', 'versions[v1].outputs[0]'],
      ['PRE_INTERVIEW_OUTPUT_UNREAD', 'versions[v1].outputs[1]'],
    ]);
    for (const refusal of beforeReport.refusals) {
      expect(refusal.message).toContain('restore the frozen file');
      expect(refusal.message).not.toContain('outputs-lost');
    }

    const next = nextCommand(['--json', unread], testClock.now());
    expect(next.exit).toBe(0);
    const nextReport = JSON.parse(next.stdout) as { refusals: { code: string; fix: string }[] };
    expect(nextReport.refusals.map((r) => r.code)).toEqual(['PRE_INTERVIEW_OUTPUT_UNREAD', 'PRE_INTERVIEW_OUTPUT_UNREAD']);
    for (const refusal of nextReport.refusals) {
      expect(refusal.fix).toContain('restore the frozen file');
      expect(refusal.fix).not.toContain('outputs-lost');
    }

    const declared = migratedOutputs((p) => {
      version(p, 1).outputs = [];
      version(p, 1).outputs_lost = {
        ...LOSS,
        recorded: [
          { path: 'outputs/v1/rig.json', sha256: FIRST_RIG_SHA },
          { path: 'outputs/v1/extra.json', sha256: SECOND_SHA },
        ],
      };
    });
    rmSync(join(declared, 'outputs/v1/rig.json'));
    rmSync(join(declared, 'outputs/v1/extra.json'));

    const afterCheck = interviewCommand(['--check', '--json', declared]);
    expect(afterCheck.exit).toBe(0);
    const afterReport = JSON.parse(afterCheck.stdout) as { ok: boolean; refusals: { code: string }[] };
    expect(afterReport.ok).toBe(true);
    expect(afterReport.refusals).toEqual([]);

    const handoffRes = handoffCommand([declared]);
    expect(handoffRes.exit).toBe(0);
    expect(handoffRes.stdout).toContain(`v1 (pre-interview) outputs lost: ${LOSS.note}; source: ${LOSS.source}`);
  });

  test('check reads multiple recorded losses and still verifies surviving outputs (#346)', () => {
    const thirdBytes = '{"build":1,"part":"third"}\n';
    const fourthBytes = '{"build":1,"part":"fourth"}\n';
    const third = {
      path: 'outputs/v1/third.json',
      sha256: createHash('sha256').update(thirdBytes).digest('hex'),
    };
    const fourth = {
      path: 'outputs/v1/fourth.json',
      sha256: createHash('sha256').update(fourthBytes).digest('hex'),
      bytes: Buffer.byteLength(fourthBytes),
    };

    const unread = migratedOutputs((p) => {
      arr(version(p, 1).outputs).push({ ...third, bytes: Buffer.byteLength(thirdBytes) }, fourth);
    }, { ...historical.files, [fourth.path]: fourthBytes });
    rmSync(join(unread, 'outputs/v1/rig.json'));
    const before = checkProject(unread).refusals;
    expect(before.map((f) => [f.code, f.path])).toEqual([
      ['PRE_INTERVIEW_OUTPUT_UNREAD', 'versions[v1].outputs[0]'],
      ['PRE_INTERVIEW_OUTPUT_UNREAD', 'versions[v1].outputs[2]'],
    ]);
    for (const refusal of before) expect(refusal.message).not.toContain('outputs-lost');

    const declared = migratedOutputs((p) => {
      version(p, 1).outputs = [
        { path: 'outputs/v1/extra.json', sha256: SECOND_SHA, bytes: Buffer.byteLength(SECOND_BYTES) },
        fourth,
      ];
      version(p, 1).outputs_lost = {
        ...LOSS,
        recorded: [{ path: 'outputs/v1/rig.json', sha256: FIRST_RIG_SHA }, third],
      };
    }, { ...historical.files, [fourth.path]: fourthBytes });
    rmSync(join(declared, 'outputs/v1/rig.json'));
    expect(codes(checkProject(declared))).toEqual([]);

    const surviving = join(declared, 'outputs/v1/extra.json');
    writeFileSync(surviving, '{"corrupted":true}\n');
    expect(codes(checkProject(declared))).toEqual(['PRE_INTERVIEW_OUTPUT_CHANGED']);
    writeFileSync(surviving, SECOND_BYTES);
    expect(codes(checkProject(declared))).toEqual([]);

    rmSync(surviving);
    const laterLoss = checkProject(declared).refusals;
    expect(laterLoss.map((f) => [f.code, f.path])).toEqual([
      ['PRE_INTERVIEW_OUTPUT_UNREAD', 'versions[v1].outputs[0]'],
    ]);
    expect(laterLoss[0]?.message).not.toContain('outputs-lost');
  });

  test('check flags changed, malformed and escaping frozen outputs', () => {
    const changed = migratedOutputs();
    rmSync(join(changed, 'outputs/v1/rig.json'));
    writeFileSync(join(changed, 'outputs/v1/extra.json'), '{"build":99}\n');
    expect(checkProject(changed).refusals.map((f) => [f.code, f.path])).toEqual([
      ['PRE_INTERVIEW_OUTPUT_UNREAD', 'versions[v1].outputs[0]'],
      ['PRE_INTERVIEW_OUTPUT_CHANGED', 'versions[v1].outputs[1]'],
    ]);

    const empty = migratedOutputs((p) => { version(p, 1).outputs = []; });
    expect(codes(checkProject(empty))).toEqual(['PRE_INTERVIEW_OUTPUT_MALFORMED']);

    const symlinked = migratedOutputs();
    const outside = join(tempDir(), 'outside.json');
    writeFileSync(outside, SECOND_BYTES);
    rmSync(join(symlinked, 'outputs/v1/rig.json'));
    rmSync(join(symlinked, 'outputs/v1/extra.json'));
    symlinkSync(outside, join(symlinked, 'outputs/v1/extra.json'));
    const refusals = checkProject(symlinked).refusals;
    expect(refusals.map((f) => [f.code, f.path])).toEqual([
      ['PRE_INTERVIEW_OUTPUT_UNREAD', 'versions[v1].outputs[0]'],
      ['PRE_INTERVIEW_OUTPUT_UNREAD', 'versions[v1].outputs[1]'],
    ]);
    expect(refusals[1]?.message).toContain('resolves outside the project');
  });

  test('a rig-review signoff bound to lost outputs is stale', () => {
    const dir = migratedOutputs(declareAcceptedOutputLoss);
    rmSync(join(dir, 'outputs/v2/rig.json'));
    const stale = checkProject(dir).refusals.filter((f) => f.code === 'SIGNOFF_TARGET_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.message).toContain('outputs lost: nothing to bind');
  });

  test('a historical output loss on the accepted rig blocks handoff and post work', () => {
    const withPost = migratedOutputs((p) => {
      retimeFixture(p, Date.parse(SIGNOFF_TARGET_SINCE));
      declareAcceptedOutputLoss(p);
    });
    rmSync(join(withPost, 'outputs/v2/rig.json'));
    expect(codes(checkProject(withPost))).toContain('POST_ON_UNACCEPTED_RIG');

    const prePost = migratedOutputs((p) => {
      p.stage = 'rig-review';
      retainSignoffs(p, (s) => stageIndex(String(s.stage)) <= stageIndex('rig-review'));
      for (const s of arr(obj(p.plan).steps)) {
        if (obj(s).phase === 'post') obj(s).status = 'pending';
      }
      p.versions = structuredClone(historical.versions);
      retimeFixture(p, Date.parse(SIGNOFF_TARGET_SINCE));
      declareAcceptedOutputLoss(p);
    });
    rmSync(join(prePost, 'outputs/v2/rig.json'));
    expect(codes(checkProject(prePost))).toEqual([]);

    expect(() => handoffCommand([prePost])).toThrow(expect.objectContaining({
      code: 'PRE_INTERVIEW_OUTPUTS_LOST',
      exitCode: 1,
    }));

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

  test('check validates legacy and recorded output loss declarations', () => {
    const validWithRecorded = migratedOutputs((p) => {
      version(p, 1).outputs = [];
      version(p, 1).outputs_lost = {
        note: LOSS.note,
        source: LOSS.source,
        recorded: [{ path: 'outputs/v1/rig.json', sha256: 'a'.repeat(64) }],
      };
    });
    rmSync(join(validWithRecorded, 'outputs/v1/rig.json'));
    expect(codes(checkProject(validWithRecorded))).toEqual([]);

    // Legacy { note, source } without recorded beside outputs: [] stays valid
    const validLegacy = migratedOutputs((p) => {
      version(p, 1).outputs = [];
      version(p, 1).outputs_lost = {
        note: LOSS.note,
        source: LOSS.source,
      };
    });
    expect(codes(checkProject(validLegacy))).toEqual([]);

    // Legacy { note, source } without recorded beside non-empty outputs refuses PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED
    const legacyBesideNonEmpty = migratedOutputs((p) => {
      version(p, 1).outputs_lost = {
        note: LOSS.note,
        source: LOSS.source,
      };
    });
    expect(codes(checkProject(legacyBesideNonEmpty))).toEqual(['PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED']);

    // recorded overlapping outputs refuses PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED
    const overlapping = migratedOutputs((p) => {
      version(p, 1).outputs = [
        { path: 'outputs/v1/extra.json', sha256: SECOND_SHA, bytes: Buffer.byteLength(SECOND_BYTES) },
      ];
      version(p, 1).outputs_lost = {
        note: LOSS.note,
        source: LOSS.source,
        recorded: [{ path: 'outputs/v1/extra.json', sha256: SECOND_SHA }],
      };
    });
    expect(codes(checkProject(overlapping))).toEqual(['PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED']);

    // A recorded path that is readable on disk (matching sha256 or different sha256) refuses PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED
    const readableMatchingSha = migratedOutputs((p) => {
      version(p, 1).outputs = [
        { path: 'outputs/v1/extra.json', sha256: SECOND_SHA, bytes: Buffer.byteLength(SECOND_BYTES) },
      ];
      version(p, 1).outputs_lost = {
        note: LOSS.note,
        source: LOSS.source,
        recorded: [{ path: 'outputs/v1/rig.json', sha256: FIRST_RIG_SHA }],
      };
    });
    expect(codes(checkProject(readableMatchingSha))).toEqual(['PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED']);

    const readableDifferentSha = migratedOutputs((p) => {
      version(p, 1).outputs = [
        { path: 'outputs/v1/extra.json', sha256: SECOND_SHA, bytes: Buffer.byteLength(SECOND_BYTES) },
      ];
      version(p, 1).outputs_lost = {
        note: LOSS.note,
        source: LOSS.source,
        recorded: [{ path: 'outputs/v1/rig.json', sha256: 'a'.repeat(64) }],
      };
    });
    expect(codes(checkProject(readableDifferentSha))).toEqual(['PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED']);

    const malformedLosses: Json[] = [
      { note: LOSS.note, source: LOSS.source, extra: true },
      { note: LOSS.note, source: LOSS.source, recorded: [] },
      { note: LOSS.note, source: LOSS.source, recorded: 'not-an-array' },
      { note: LOSS.note, source: LOSS.source, recorded: [{}] },
      { note: LOSS.note, source: LOSS.source, recorded: [{ path: 'outputs/v1/rig.json', sha256: 'bad' }] },
      { note: LOSS.note, source: LOSS.source, recorded: [{ path: '../outside.json', sha256: 'a'.repeat(64) }] },
      { note: LOSS.note, source: LOSS.source, recorded: [{ path: '/abs.json', sha256: 'a'.repeat(64) }] },
      { note: LOSS.note, source: LOSS.source, recorded: [{ path: 'outputs/v1/rig.json', sha256: 'a'.repeat(64), bytes: 12 }] },
      {
        note: LOSS.note,
        source: LOSS.source,
        recorded: [
          { path: 'outputs/v1/rig.json', sha256: 'a'.repeat(64) },
          { path: 'outputs/v1/rig.json', sha256: 'b'.repeat(64) },
        ],
      },
    ];
    for (const bad of malformedLosses) {
      const dir = migratedOutputs((p) => {
        version(p, 1).outputs = [];
        version(p, 1).outputs_lost = bad;
      });
      rmSync(join(dir, 'outputs/v1/rig.json'));
      expect(codes(checkProject(dir))).toContain('PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED');
    }

    // Create-built version with outputs_lost is refused
    const onCreateBuilt = migratedOutputs((p) => {
      version(p, 3).outputs = [];
      version(p, 3).outputs_lost = { note: LOSS.note, source: LOSS.source };
    });
    expect(codes(checkProject(onCreateBuilt))).toContain('PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED');
  });
});
