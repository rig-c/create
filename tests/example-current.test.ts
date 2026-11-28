import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';
import { checkProject } from '../src/check.ts';
import { interviewCommand } from '../src/interview.ts';
import { nextProject } from '../src/next.ts';
import { handoff } from '../src/review.ts';
import { sha256 } from '../src/current.ts';
import { planCommand } from '../src/plan-writers.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import type { JsonObject } from '../src/templates.ts';
import { consumerOnlyTest } from './consumer-only.ts';
import { arr, obj } from './fixtures.ts';

const retained = join(import.meta.dir, '../templates/example-current');

test('the current-path example checks at acceptance', () => {
  const now = EXAMPLE_ANCHOR + 60 * 60 * 1000;
  const report = checkProject(retained, undefined, { now });
  expect(report.refusals.map(finding => finding.code)).toEqual([]);
  expect(report.warnings.map(finding => finding.code)).toEqual([]);
  expect(nextProject(retained, now)).toMatchObject({
    stage: 'accepted', effective_stage: 'accepted', accepted: true,
    moves: [{ command: `rig-create handoff ${retained} --json` }],
  });
});

test('handoff verifies the current rig when the retained numbered rig differs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-current-handoff-'));
  const now = EXAMPLE_ANCHOR + 60 * 60 * 1000;
  try {
    cpSync(retained, dir, { recursive: true });
    const recordPath = join(dir, 'project.json');
    const project = JSON.parse(readFileSync(recordPath, 'utf8')) as JsonObject;
    const rig = obj(obj(project.current).rig);
    const historic = 'outputs/v1/out/check/build/skeleton.model.json';
    mkdirSync(dirname(join(dir, historic)), { recursive: true });
    const historicBytes = Buffer.from('{"spec":"rigc-compiled/3","synthetic":"numbered"}\n');
    writeFileSync(join(dir, historic), historicBytes);
    const historicHash = sha256(historicBytes);
    project.versions = [{ n: 1, kind: 'rig', at: '2026-11-01T00:00:00.000Z',
      outputs: [{ path: historic, sha256: historicHash, bytes: historicBytes.length }],
      verdicts: [{ by: 'owner', at: '2026-11-01T00:00:00.000Z', review: 'rig-review', verdict: 'accepted', verbatim: 'Historic synthetic rig.' }] }];
    const save = () => writeFileSync(recordPath, JSON.stringify(project));
    save();

    const files = arr(rig.files).map(raw => {
      const { path, sha256: expected } = obj(raw) as { path: string; sha256: string };
      expect(sha256(readFileSync(join(dir, path)))).toBe(expected);
      return { path, sha256: expected };
    });
    expect(files.some(file => file.sha256 === historicHash)).toBe(false);
    expect(handoff(dir, null, now)).toEqual({ ok: true, project_dir: dir, record: 'current.rig', at: String(rig.at), files });
    expect(() => handoff(dir, 1, now)).toThrow(expect.objectContaining({ code: 'HANDOFF_RIG_INVALID' }));

    project.stage = 'rig-review';
    save();
    expect(() => handoff(dir, null, now)).toThrow(expect.objectContaining({ code: 'RIG_VERSION_UNACCEPTED' }));
    project.stage = 'accepted';
    save();
    writeFileSync(join(dir, files[0]!.path), 'changed');
    expect(() => handoff(dir, null, now)).toThrow(expect.objectContaining({ code: 'RIG_VERSION_UNACCEPTED' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a revised parts plan keeps its old signatures verifiable and offers a new accepted boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-revised-plan-'));
  const now = EXAMPLE_ANCHOR + 60 * 60 * 1000;
  const read = () => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  try {
    cpSync(retained, dir, { recursive: true });
    const original = read();
    const plan = 'specs/revised-parts.md';
    writeFileSync(join(dir, plan), 'Synthetic revised parts plan.\n');
    expect(planCommand(['propose', 'parts', dir, '--file', plan, '--by', 'agent'], now).exit).toBe(0);
    expect(interviewCommand(['--check', dir, '--json'], now + 1000).exit).toBe(0);
    expect(nextProject(dir, now + 1000)).toMatchObject({ stage: 'accepted', accepted: false, refusals: [],
      moves: [expect.objectContaining({ command: expect.stringContaining('rig-create advance accepted') })] });

    const tampered = read();
    const signedParts = obj(arr(obj(tampered.interview).step_plans)[0]);
    signedParts.sha256 = '0'.repeat(64);
    expect(checkProject(dir, tampered, { now: now + 1000 }).refusals).toContainEqual(expect.objectContaining({
      code: 'SIGNOFF_ANSWERS_STALE', path: 'signoffs[0].answer_hashes[reference]',
    }));
    expect(advanceCommand(['accepted', dir], now + 1000).exit).toBe(0);
    expect(read().signoffs).toEqual(original.signoffs!);
    expect(nextProject(dir, now + 2000)).toMatchObject({
      stage: 'accepted', accepted: true, moves: [{ command: `rig-create handoff ${dir} --json` }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a later recorded answer preserves the signed answer revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-revised-answer-'));
  const now = EXAMPLE_ANCHOR + 60 * 60 * 1000;
  try {
    cpSync(retained, dir, { recursive: true });
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const item = obj(arr(obj(project.interview).framing).find(entry => obj(entry).id === 'rig_type'));
    const prior = obj(item.answer);
    item.history = [prior];
    item.answer = { ...prior, at: new Date(now).toISOString(), agent_decision: {
      ...obj(prior.agent_decision), at: new Date(now).toISOString(), reasoning: 'Keep the same rig type after reviewing the parts plan.',
    } };
    expect(checkProject(dir, project, { now: now + 1000 }).refusals).toEqual([]);
    obj(arr(item.history)[0]).plan_quote = 'Tampered quote.';
    expect(checkProject(dir, project, { now: now + 1000 }).refusals).toContainEqual(expect.objectContaining({
      code: 'SIGNOFF_ANSWERS_STALE', path: 'signoffs[0].answer_hashes[rig_type]',
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

consumerOnlyTest('tests/example-current.test.ts', 'the current-path example reproduces from the release-pinned producers', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-example-current-'));
  const generator = join(import.meta.dir, '../scripts/generate-example-current.ts');
  try {
    const run = Bun.spawnSync([process.execPath, generator, join(root, 'generated'), '--check'], {
      stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
    });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stderr.toString()).not.toContain('PROJECT_COMMIT_FAILED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 130_000);
