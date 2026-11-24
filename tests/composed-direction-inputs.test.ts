import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkInputFiles } from '../scripts/generate-composed-direction-fixture.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';

test('composed direction input check seals the complete file inventory without a Review job', () => {
  const repo = join(import.meta.dir, '..');
  const script = join(repo, 'scripts/generate-composed-direction-fixture.ts');
  const temp = mkdtempSync(join(tmpdir(), 'rig-create-test-composed-inputs-'));
  try {
    for (const [args, dir, variant] of [
      [['--check'], 'templates/example-composed-direction/inputs', 'default'],
      [['--clip', '--check'], 'templates/example-composed-clip/inputs', 'clip'],
    ] as const) {
      const checked = Bun.spawnSync([process.execPath, script, ...args], { cwd: temp, timeout: 10_000 });
      expect(checked.stderr.toString()).toBe('');
      expect(checked.exitCode).toBe(0);
      expect(checked.stdout.toString()).toContain('files match byte for byte');

      const copy = join(temp, `inputs-${variant}`);
      cpSync(join(repo, dir), copy, { recursive: true });
      writeFileSync(join(copy, 'scene.json'), '{}\n');
      rmSync(join(copy, 'approval/rig.txt'));
      writeFileSync(join(copy, 'extra.txt'), 'unexpected');
      expect(() => checkInputFiles(copy, variant)).toThrow(/COMPOSED_INPUT_MISMATCH\nmissing approval\/rig\.txt\nextra extra\.txt\nchanged scene\.json/);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('clipped composed direction scene without canvas_clip is refused by the pinned Parts CLI with SCENE_CHARACTER_INSIDE_CANVAS', () => {
  const repo = join(import.meta.dir, '..');
  const temp = mkdtempSync(join(tmpdir(), 'rig-create-test-composed-clip-negative-'));
  try {
    const clipInputs = join(repo, 'templates/example-composed-clip/inputs');
    mkdirSync(join(temp, 'inputs'), { recursive: true });
    cpSync(join(clipInputs, 'plates/background.png'), join(temp, 'inputs/background.png'));
    cpSync(join(clipInputs, 'plates/foreground.png'), join(temp, 'inputs/foreground.png'));
    const build = join(temp, 'evidence/compose-character');
    cpSync(join(repo, 'templates/example-remesh/outputs/v1/out'), build, { recursive: true });
    mkdirSync(join(build, 'check'), { recursive: true });
    cpSync(join(repo, 'templates/example-remesh/evidence/v1/registration/check.json'), join(build, 'check/check.json'));

    const scene = JSON.parse(readFileSync(join(clipInputs, 'scene.json'), 'utf8')) as {
      characters: Record<string, unknown>[];
    };
    expect(scene.characters[0]?.canvas_clip).toBe(true);
    delete scene.characters[0]!.canvas_clip;
    writeFileSync(join(temp, 'compose.scene.json'), `${JSON.stringify(scene, null, 2)}\n`);

    const partsCli = join(repo, 'node_modules/@rig-c/parts/bin/rig-parts.cjs');
    const result = Bun.spawnSync([process.execPath, partsCli, 'compose', '--scene', 'compose.scene.json', '--out', 'scratch/compose'], {
      cwd: temp, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString() + result.stdout.toString()).toContain('SCENE_CHARACTER_INSIDE_CANVAS');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('public composed example replaces and re-signs a completed composition step after a Review bounce', async () => {
  const repo = join(import.meta.dir, '..');
  const temp = mkdtempSync(join(tmpdir(), 'rig-create-test-composed-bounce-'));
  const project = join(temp, 'project');
  try {
    const run = Bun.spawn([process.execPath, join(repo, 'scripts/generate-composed-direction-fixture.ts'),
      '--revise-after-bounce', project], { cwd: temp, stdout: 'pipe', stderr: 'pipe', timeout: 180_000 });
    const [exit, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    if (exit !== 0) throw Error(`Composed example exited ${exit}\n${stdout}\n${stderr}`);
    expect(stdout).toContain('PLAN_STEP_SIGNED: project.json unchanged');

    const record = JSON.parse(readFileSync(join(project, 'project.json'), 'utf8'));
    expect(record.stage).toBe('accepted');
    expect(record.advances.at(-1)).toMatchObject({ from_stage: 'direction-review', stage: 'accepted' });
    const [v2, v3] = record.versions.filter((version: { kind: string }) => version.kind === 'post');
    expect(v2).toMatchObject({ n: 2, verdicts: [{ review: 'direction-review', verdict: 'bounced' }] });
    expect(record.review_acts).toContainEqual(expect.objectContaining({ version: 2, verdict: 0 }));
    expect(v3).toMatchObject({ n: 3, answers_feedback: [{ version: 2, verdict: 0 }] });
    const composition = record.interview.post.items.find((item: { id: string }) => item.id === 'post_composition');
    expect(composition.history.at(-1).choice.set.path).toBe('evidence/interview/post_composition.json');
    expect(composition.guide.choice).toMatchObject({
      set: { path: 'evidence/interview/post_composition-002.json' },
      picks: [{ ask: 'post_composition', option_id: 'all-still' }],
    });
    expect(composition.guide).toMatchObject({ by: 'synthetic-owner', source: 'owner chat, relayed' });

    const [amendment] = record.amendments.filter(({ target }: { target: { id: string } }) => target.id === 'post_composition');
    expect(amendment).toMatchObject({
      target: { stage: 'post-interview', kind: 'interview-answer', id: 'post_composition' },
      by: 'synthetic-owner',
      source: 'owner chat, relayed',
    });
    expect(amendment.changes).toContainEqual(composition.guide.choice.set);

    const removed = record.plan.replaced.find(({ step }: { step: JsonObject }) => step.id === 'composition');
    expect(removed).toMatchObject({ action: 'removed', step: { phase: 'post', does: 'Author the synthetic composition' } });
    expect(removed.step.status_history.map(({ status }: { status: string }) => status)).toEqual(['in-progress', 'at-checkpoint', 'done']);
    const compositionSteps = record.plan.steps.filter(({ id }: JsonObject) => id === 'composition');
    expect(compositionSteps).toHaveLength(1);
    const [step] = compositionSteps;
    expect(step).toMatchObject({ phase: 'post', does: 'Keep both plates still in the revised post.', rests_on: ['post_composition'], status: 'done' });
    expect(step.status_history[0]).toMatchObject({ from_status: 'pending', status: 'in-progress' });

    const [originalSignoff, reSignoff, otherStepsReSignoff] = record.signoffs.filter(({ stage }: JsonObject) => stage === 'post-interview');
    expect(originalSignoff.step_hashes.composition).toBe(removed.sha256);
    expect(reSignoff).toMatchObject({
      steps: expect.arrayContaining(['composition']),
      step_hashes: { composition: stepHash(step) },
      answer_hashes: { post_composition: expect.stringMatching(/^[0-9a-f]{64}$/) },
      by: 'synthetic-owner',
      source: 'owner chat, relayed',
      relayed_by: 'agent',
      said_at: expect.any(String),
    });
    expect(reSignoff.step_hashes.composition).not.toBe(removed.sha256);
    expect(reSignoff.answer_hashes.post_composition).not.toBe(originalSignoff.answer_hashes.post_composition);
    expect(otherStepsReSignoff).toMatchObject({ steps: ['camera', 'timing'], source: 'owner chat, relayed', step_hashes: {
      camera: originalSignoff.step_hashes.camera, timing: originalSignoff.step_hashes.timing,
    } });
    expect(Date.parse(composition.guide.at)).toBeGreaterThan(Date.parse(v2.verdicts[0].at));
    expect(Date.parse(amendment.at)).toBeGreaterThan(Date.parse(composition.guide.at));
    expect(Date.parse(removed.at)).toBeGreaterThan(Date.parse(amendment.at));
    expect(Date.parse(step.drafted_at)).toBeGreaterThan(Date.parse(removed.at));
    expect(Date.parse(reSignoff.at)).toBeGreaterThan(Date.parse(step.drafted_at));

    const revised = JSON.parse(readFileSync(join(project, 'evidence/direction/v3.json'), 'utf8'));
    expect(revised.citations.composition.quote).toBe(composition.guide.verbatim);
    expect(JSON.parse(readFileSync(join(project, revised.compose.scene.path), 'utf8')).animations.idle.tracks).toEqual([]);
    expect(stdout).toContain('accepted: revised post v3 published from the advanced record with 0 refusals and 0 warnings');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 200_000);
