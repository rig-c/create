import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Refusal } from '../src/refusal.ts';
import { SIGNOFF_TARGET_SINCE } from '../src/signoff-target.ts';
import { STAGE_PROGRESS_SINCE } from '../src/stage-progress.ts';
import { stageIndex } from '../src/stages.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { checkProject, versionCommand } from './clock.ts';
import { arr, bindFixtureAnswers, codes, fixture, obj, retainSignoffs, retimeFixture, version, type Mutate } from './fixtures.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';

const historical = JSON.parse(readFileSync(join(import.meta.dir, 'data/pre-interview.json'), 'utf8')) as {
  versions: JsonObject[];
  files: Record<string, string>;
};

const env = gitEnv();
const LOSS = {
  note: 'The historical frozen outputs did not survive.',
  source: 'archive log, output inventory',
} as const;

const SECOND_BYTES = '{"build":1,"part":"extra"}\n';
const SECOND_SHA = createHash('sha256').update(SECOND_BYTES).digest('hex');

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

describe('version outputs-lost writer (#344)', () => {
  test('Bar 1 & 2: records outputs_lost with retained bindings, sets outputs to [], and clears every PRE_INTERVIEW_OUTPUT_UNREAD', () => {
    const dir = migratedOutputs();
    rmSync(join(dir, 'outputs/v1/rig.json'));
    rmSync(join(dir, 'outputs/v1/extra.json'));
    const file = join(dir, 'project.json');
    const beforeBytes = readFileSync(file);

    const beforeCheck = cli(['interview', '--check', '--json', dir], dir, env);
    expect(beforeCheck.code).toBe(1);
    const beforeReport = JSON.parse(beforeCheck.stdout) as { refusals: { code: string; path: string }[] };
    expect(beforeReport.refusals.map((f) => f.code)).toEqual(['PRE_INTERVIEW_OUTPUT_UNREAD', 'PRE_INTERVIEW_OUTPUT_UNREAD']);
    expect(beforeReport.refusals.map((f) => f.path)).toEqual(['versions[v1].outputs[0]', 'versions[v1].outputs[1]']);

    const expectedRecord = JSON.parse(beforeBytes.toString('utf8')) as JsonObject;
    const expectedLoss = {
      note: LOSS.note,
      source: LOSS.source,
      recorded: [
        { path: 'outputs/v1/rig.json', sha256: '59e8937fd590eb1fa3c4afb64e78d21707354372f88286931b445279d91058ae' },
        { path: 'outputs/v1/extra.json', sha256: SECOND_SHA },
      ],
    };
    version(expectedRecord, 1).outputs = [];
    version(expectedRecord, 1).outputs_lost = expectedLoss;
    const expectedBytes = Buffer.from(`${JSON.stringify(expectedRecord, null, 2)}\n`);

    const write = cli(['version', 'outputs-lost', '1', '--note', LOSS.note, '--source', LOSS.source, '--json', dir], dir, env);
    expect(write.stderr).toBe('');
    expect(write.code).toBe(0);
    expect(JSON.parse(write.stdout)).toEqual(expectedLoss);

    const afterBytes = readFileSync(file);
    expect(afterBytes).toEqual(expectedBytes);

    const afterCheck = cli(['interview', '--check', '--json', dir], dir, env);
    expect(afterCheck.code).toBe(0);
    const afterReport = JSON.parse(afterCheck.stdout) as { ok: boolean; refusals: { code: string; path: string }[] };
    expect(afterReport.ok).toBe(true);
    expect(afterReport.refusals).toEqual([]);

    const handoffRes = cli(['handoff', dir], dir, env);
    expect(handoffRes.code).toBe(0);
    expect(handoffRes.stdout).toContain(`v1 (pre-interview) outputs lost: ${LOSS.note}; source: ${LOSS.source}`);
  });

  test('partial loss (#346): a version with 2 readable and 2 missing outputs keeps the 2 readable in outputs, records the 2 missing in outputs_lost.recorded, and clears both PRE_INTERVIEW_OUTPUT_UNREAD', () => {
    const THIRD_BYTES = '{"build":1,"part":"third"}\n';
    const THIRD_SHA = createHash('sha256').update(THIRD_BYTES).digest('hex');
    const FOURTH_BYTES = '{"build":1,"part":"fourth"}\n';
    const FOURTH_SHA = createHash('sha256').update(FOURTH_BYTES).digest('hex');

    const dir = migratedOutputs((p) => {
      arr(version(p, 1).outputs).push(
        { path: 'outputs/v1/third.json', sha256: THIRD_SHA, bytes: Buffer.byteLength(THIRD_BYTES) },
        { path: 'outputs/v1/fourth.json', sha256: FOURTH_SHA, bytes: Buffer.byteLength(FOURTH_BYTES) },
      );
    }, {
      ...historical.files,
      'outputs/v1/third.json': THIRD_BYTES,
      'outputs/v1/fourth.json': FOURTH_BYTES,
    });

    // Remove 2 of the 4 outputs; keep outputs/v1/extra.json and outputs/v1/fourth.json readable with their sha256
    rmSync(join(dir, 'outputs/v1/rig.json'));
    rmSync(join(dir, 'outputs/v1/third.json'));
    const file = join(dir, 'project.json');
    const beforeBytes = readFileSync(file);

    const beforeCheck = checkProject(dir);
    expect(beforeCheck.refusals.map((f) => `${f.code}@${f.path}`)).toEqual([
      'PRE_INTERVIEW_OUTPUT_UNREAD@versions[v1].outputs[0]',
      'PRE_INTERVIEW_OUTPUT_UNREAD@versions[v1].outputs[2]',
    ]);

    const expectedRecord = JSON.parse(beforeBytes.toString('utf8')) as JsonObject;
    const expectedLoss = {
      note: LOSS.note,
      source: LOSS.source,
      recorded: [
        { path: 'outputs/v1/rig.json', sha256: '59e8937fd590eb1fa3c4afb64e78d21707354372f88286931b445279d91058ae' },
        { path: 'outputs/v1/third.json', sha256: THIRD_SHA },
      ],
    };
    version(expectedRecord, 1).outputs = [
      { path: 'outputs/v1/extra.json', sha256: SECOND_SHA, bytes: Buffer.byteLength(SECOND_BYTES) },
      { path: 'outputs/v1/fourth.json', sha256: FOURTH_SHA, bytes: Buffer.byteLength(FOURTH_BYTES) },
    ];
    version(expectedRecord, 1).outputs_lost = expectedLoss;
    const expectedBytes = Buffer.from(`${JSON.stringify(expectedRecord, null, 2)}\n`);

    const write = cli(['version', 'outputs-lost', '1', '--note', LOSS.note, '--source', LOSS.source, '--json', dir], dir, env);
    expect(write.stderr).toBe('');
    expect(write.code).toBe(0);
    expect(JSON.parse(write.stdout)).toEqual(expectedLoss);
    expect(readFileSync(file)).toEqual(expectedBytes);
    expect(codes(checkProject(dir))).toEqual([]);

    // Remaining outputs in outputs[] are still checked for sha256 and readability
    writeFileSync(join(dir, 'outputs/v1/extra.json'), '{"corrupted":true}\n');
    expect(codes(checkProject(dir))).toEqual(['PRE_INTERVIEW_OUTPUT_CHANGED']);
    writeFileSync(join(dir, 'outputs/v1/extra.json'), SECOND_BYTES);
    expect(codes(checkProject(dir))).toEqual([]);
  });

  test('Bar 3: refuses non-pre-interview version, no lost output, already set outputs_lost, empty note/source, unknown version, and changed/malformed/escaping outputs, leaving project.json byte-identical', () => {
    // 1. Version is not pre_interview: true
    {
      const dir = migratedOutputs();
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      const res = cli(['version', 'outputs-lost', '3', '--note', LOSS.note, '--source', LOSS.source, dir], dir, env);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('OUTPUTS_LOST_NOT_PRE_INTERVIEW');
      expect(readFileSync(file)).toEqual(before);
    }

    // 2. Nothing is missing (all recorded outputs are still readable with their sha256)
    {
      const dir = migratedOutputs();
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      const res = cli(['version', 'outputs-lost', '1', '--note', LOSS.note, '--source', LOSS.source, dir], dir, env);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('OUTPUTS_LOST_HAS_OUTPUTS');
      expect(res.stderr).toContain('no output is lost');
      expect(res.stderr).toContain('outputs/v1/rig.json, outputs/v1/extra.json');
      expect(readFileSync(file)).toEqual(before);
    }

    // 3. outputs_lost is already set
    {
      const dir = migratedOutputs((p) => {
        version(p, 1).outputs = [];
        version(p, 1).outputs_lost = { note: LOSS.note, source: LOSS.source };
      });
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      const res = cli(['version', 'outputs-lost', '1', '--note', 'Different note', '--source', 'different source', dir], dir, env);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('OUTPUTS_LOST_ALREADY_SET');
      expect(readFileSync(file)).toEqual(before);
    }

    // 5. Note or source is empty (or missing)
    {
      const dir = migratedOutputs();
      rmSync(join(dir, 'outputs/v1/rig.json'));
      rmSync(join(dir, 'outputs/v1/extra.json'));
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      for (const [note, source] of [
        ['', LOSS.source],
        ['   ', LOSS.source],
        [LOSS.note, ''],
        [LOSS.note, '  \t '],
      ] as const) {
        const res = cli(['version', 'outputs-lost', '1', '--note', note, '--source', source, dir], dir, env);
        expect(res.code).toBe(1);
        expect(res.stderr).toContain('OUTPUTS_LOST_EMPTY');
        expect(readFileSync(file)).toEqual(before);
      }
      const missingFlag = cli(['version', 'outputs-lost', '1', '--note', LOSS.note, dir], dir, env);
      expect(missingFlag.code).toBe(2);
      expect(missingFlag.stderr).toContain('OUTPUTS_LOST_USAGE');
      expect(readFileSync(file)).toEqual(before);
      for (const values of [['--note', '--json', '--source', LOSS.source], ['--note', LOSS.note, '--source', '--json']]) {
        const flagAsValue = cli(['version', 'outputs-lost', '1', ...values, dir], dir, env);
        expect(flagAsValue.code).toBe(2);
        expect(flagAsValue.stderr).toContain('OUTPUTS_LOST_USAGE');
        expect(readFileSync(file)).toEqual(before);
      }
    }

    // 6. No such version exists
    {
      const dir = migratedOutputs();
      const file = join(dir, 'project.json');
      const before = readFileSync(file);
      const res = cli(['version', 'outputs-lost', '99', '--note', LOSS.note, '--source', LOSS.source, dir], dir, env);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('OUTPUTS_LOST_VERSION_UNKNOWN');
      expect(readFileSync(file)).toEqual(before);
    }

    // 7. Output on disk has changed bytes (not missing) or malformed outputs list or escaping symlink
    {
      const changed = migratedOutputs();
      rmSync(join(changed, 'outputs/v1/rig.json'));
      writeFileSync(join(changed, 'outputs/v1/extra.json'), '{"build":99}\n');
      const changedFile = join(changed, 'project.json');
      const beforeChanged = readFileSync(changedFile);
      const changedRes = cli(['version', 'outputs-lost', '1', '--note', LOSS.note, '--source', LOSS.source, changed], changed, env);
      expect(changedRes.code).toBe(1);
      expect(changedRes.stderr).toContain('PRE_INTERVIEW_OUTPUT_CHANGED');
      expect(readFileSync(changedFile)).toEqual(beforeChanged);

      const emptyOutputs = migratedOutputs((p) => {
        version(p, 1).outputs = [];
      });
      const emptyFile = join(emptyOutputs, 'project.json');
      const beforeEmpty = readFileSync(emptyFile);
      const emptyRes = cli(['version', 'outputs-lost', '1', '--note', LOSS.note, '--source', LOSS.source, emptyOutputs], emptyOutputs, env);
      expect(emptyRes.code).toBe(1);
      expect(emptyRes.stderr).toContain('PRE_INTERVIEW_OUTPUT_MALFORMED');
      expect(readFileSync(emptyFile)).toEqual(beforeEmpty);

      const symlinked = migratedOutputs();
      const outside = join(tempDir(), 'outside.json');
      writeFileSync(outside, SECOND_BYTES);
      rmSync(join(symlinked, 'outputs/v1/rig.json'));
      rmSync(join(symlinked, 'outputs/v1/extra.json'));
      symlinkSync(outside, join(symlinked, 'outputs/v1/extra.json'));
      const symlinkFile = join(symlinked, 'project.json');
      const beforeSymlink = readFileSync(symlinkFile);
      const symlinkRes = cli(['version', 'outputs-lost', '1', '--note', LOSS.note, '--source', LOSS.source, symlinked], symlinked, env);
      expect(symlinkRes.code).toBe(1);
      expect(symlinkRes.stderr).toContain('PRE_INTERVIEW_OUTPUT_UNREAD');
      expect(readFileSync(symlinkFile)).toEqual(beforeSymlink);
    }
  });

  test('Bar 4: an outputs-lost version cannot authorize post work (handoff refuses PRE_INTERVIEW_OUTPUTS_LOST; post basis refuses POST_ON_UNACCEPTED_RIG; current-era rig-review target refuses SIGNOFF_TARGET_STALE)', () => {
    // 1. Current-era rig-review sign-off binding v2.outputs refuses SIGNOFF_TARGET_STALE
    const currentSignoff = migratedOutputs();
    rmSync(join(currentSignoff, 'outputs/v2/rig.json'));
    const currentSignoffFile = join(currentSignoff, 'project.json');
    const beforeCurrentSignoff = readFileSync(currentSignoffFile);
    const staleTargetWrite = cli(['version', 'outputs-lost', '2', '--note', LOSS.note, '--source', LOSS.source, currentSignoff], currentSignoff, env);
    expect(staleTargetWrite.code).toBe(1);
    expect(staleTargetWrite.stderr).toContain('SIGNOFF_TARGET_STALE');
    expect(readFileSync(currentSignoffFile)).toEqual(beforeCurrentSignoff);

    // 2. Pre-SIGNOFF_TARGET_SINCE record where post versions already rest on the target rig version refuses POST_ON_UNACCEPTED_RIG
    const withPost = migratedOutputs((p) => {
      retimeFixture(p, Date.parse(SIGNOFF_TARGET_SINCE));
    });
    rmSync(join(withPost, 'outputs/v2/rig.json'));
    const withPostFile = join(withPost, 'project.json');
    const beforeWithPost = readFileSync(withPostFile);
    const blockedWrite = cli(['version', 'outputs-lost', '2', '--note', LOSS.note, '--source', LOSS.source, withPost], withPost, env);
    expect(blockedWrite.code).toBe(1);
    expect(blockedWrite.stderr).toContain('POST_ON_UNACCEPTED_RIG');
    expect(readFileSync(withPostFile)).toEqual(beforeWithPost);

    // 3. At rig-review (before post versions exist, pre-SIGNOFF_TARGET_SINCE), writing outputs_lost on the accepted rig succeeds,
    // and then handoff refuses PRE_INTERVIEW_OUTPUTS_LOST and a post version resting on it refuses POST_ON_UNACCEPTED_RIG.
    const prePost = migratedOutputs((p) => {
      p.stage = 'rig-review';
      retainSignoffs(p, (s) => stageIndex(String(s.stage)) <= stageIndex('rig-review'));
      for (const s of arr(obj(p.plan).steps)) {
        if (obj(s).phase === 'post') obj(s).status = 'pending';
      }
      p.versions = structuredClone(historical.versions);
      retimeFixture(p, Date.parse(SIGNOFF_TARGET_SINCE));
    });
    rmSync(join(prePost, 'outputs/v2/rig.json'));
    expect(codes(checkProject(prePost))).toEqual(['PRE_INTERVIEW_OUTPUT_UNREAD']);
    const write = cli(['version', 'outputs-lost', '2', '--note', LOSS.note, '--source', LOSS.source, prePost], prePost, env);
    expect(write.code).toBe(0);
    expect(write.stdout).toContain(`version outputs-lost: recorded versions[v2].outputs_lost (${LOSS.source}); stage unchanged`);
    expect(codes(checkProject(prePost))).toEqual([]);

    const handoffRes = cli(['handoff', prePost], prePost, env);
    expect(handoffRes.code).toBe(1);
    expect(handoffRes.stderr).toContain('PRE_INTERVIEW_OUTPUTS_LOST');

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

  test('Bar 5: check accepts recorded bindings and legacy { note, source }, and refuses overlapping, readable or malformed recorded shapes and create-built declarations', () => {
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
        recorded: [{ path: 'outputs/v1/rig.json', sha256: '59e8937fd590eb1fa3c4afb64e78d21707354372f88286931b445279d91058ae' }],
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

  test('refuses on a record whose stage check stopped early, leaving project.json byte-identical', () => {
    const dir = migratedOutputs();
    rmSync(join(dir, 'outputs/v1/rig.json'));
    rmSync(join(dir, 'outputs/v1/extra.json'));
    const file = join(dir, 'project.json');
    const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    project.stage = 'no-such-stage';
    writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
    expect(codes(checkProject(dir))).toEqual(['STAGE_UNKNOWN']);
    const before = readFileSync(file);
    let error: unknown;
    try {
      versionCommand(['outputs-lost', '1', '--note', LOSS.note, '--source', LOSS.source, dir]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe('STAGE_UNKNOWN');
    expect(readFileSync(file)).toEqual(before);
  });

  test('PRE_INTERVIEW_OUTPUT_UNREAD names version outputs-lost on full and partial loss, and next surfaces the remedy', () => {
    const dir = migratedOutputs();
    rmSync(join(dir, 'outputs/v1/rig.json'));
    rmSync(join(dir, 'outputs/v1/extra.json'));
    const unread = checkProject(dir).refusals.filter((f) => f.code === 'PRE_INTERVIEW_OUTPUT_UNREAD');
    expect(unread.map((f) => f.path)).toEqual(['versions[v1].outputs[0]', 'versions[v1].outputs[1]']);
    expect(unread[0]?.message).toContain('rig-create version outputs-lost 1 --note <text> --source <text>');

    const nextBefore = cli(['next', '--json', dir], dir, env);
    expect(nextBefore.code).toBe(0);
    const nextReportBefore = JSON.parse(nextBefore.stdout) as { refusals: { code: string; fix: string }[] };
    expect(nextReportBefore.refusals.map((r) => r.code)).toEqual(['PRE_INTERVIEW_OUTPUT_UNREAD', 'PRE_INTERVIEW_OUTPUT_UNREAD']);
    expect(nextReportBefore.refusals[0]?.fix).toContain('rig-create version outputs-lost <n> --note <text> --source <text>');

    versionCommand(['outputs-lost', '1', '--note', LOSS.note, '--source', LOSS.source, dir]);
    expect(codes(checkProject(dir))).not.toContain('PRE_INTERVIEW_OUTPUT_UNREAD');

    // On partial loss (one output missing, one still readable), the writer accepts it, so check suggests outputs-lost and the writer clears the refusal.
    const partial = migratedOutputs();
    rmSync(join(partial, 'outputs/v1/rig.json'));
    const partialUnread = checkProject(partial).refusals.filter((f) => f.code === 'PRE_INTERVIEW_OUTPUT_UNREAD');
    expect(partialUnread.map((f) => f.path)).toEqual(['versions[v1].outputs[0]']);
    expect(partialUnread[0]?.message).toContain('rig-create version outputs-lost 1 --note <text> --source <text>');
    versionCommand(['outputs-lost', '1', '--note', LOSS.note, '--source', LOSS.source, partial]);
    expect(codes(checkProject(partial))).toEqual([]);

    // Once outputs_lost is already set, if a remaining output later goes missing, the writer would refuse (OUTPUTS_LOST_ALREADY_SET), so check does not suggest outputs-lost again.
    rmSync(join(partial, 'outputs/v1/extra.json'));
    const secondLossUnread = checkProject(partial).refusals.filter((f) => f.code === 'PRE_INTERVIEW_OUTPUT_UNREAD');
    expect(secondLossUnread.map((f) => f.path)).toEqual(['versions[v1].outputs[0]']);
    expect(secondLossUnread[0]?.message).not.toContain('outputs-lost');
  });
});
