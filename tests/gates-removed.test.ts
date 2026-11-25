/**
 * #981: writes, builds and stage moves no longer wait on a sign-off, checkpoint, verdict,
 * plan approval, accepted version or the current stage. Dependency decides what is rebuilt.
 * Every project here is a synthetic copy of the shipped example chain.
 */
import { afterEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { checkProject, testClock } from './clock.ts';
import { clockedCli, tempDir } from './helpers.ts';

const chain = join(import.meta.dir, '../templates/example-chain');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

function copy(checkpoint?: string): string {
  const dir = join(tempDir(), 'project');
  cpSync(checkpoint === undefined ? chain : join(chain, 'checkpoints', checkpoint), dir, { recursive: true });
  return dir;
}
function run(dir: string, ...args: string[]): { exit: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, ...clockedCli(), ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
function ok(dir: string, ...args: string[]): void {
  const result = run(dir, ...args);
  expect(result.stderr).toBe('');
  expect(result.exit).toBe(0);
}
function codes(dir: string): { refusals: string[]; warnings: string[] } {
  const report = checkProject(dir);
  return { refusals: report.refusals.map(f => f.code), warnings: report.warnings.map(f => f.code) };
}
/** A rig version declaration, as the example chain seeds its own (chain.json seed_kinds), then packaged by the writer. */
function seedRig(dir: string, n: number, changed: string): void {
  const project = read(dir);
  const first = arr(project.versions).map(obj).find(version => version.kind === 'rig' && version.n === 1)!;
  const rig = structuredClone(first);
  rig.n = n; rig.at = testClock.iso(); rig.changed = changed; rig.verdicts = [];
  delete rig.review_package;
  project.versions = [...arr(project.versions), rig];
  save(dir, project);
}

afterEach(() => testClock.reset());
// Each test spawns several CLI processes.

test('#981 advance moves without a sign-off, skips a stage and goes back', () => {
  const dir = copy('0b-plan-pending');
  expect(read(dir).stage).toBe('plan-approved');
  expect(arr(read(dir).signoffs).some(s => obj(s).stage === 'plan-approved')).toBe(false);
  ok(dir, 'advance', 'parts-review');
  expect(read(dir).stage).toBe('parts-review');
  ok(dir, 'advance', 'interview');
  expect(read(dir).stage).toBe('interview');
  ok(dir, 'advance', 'parts');
  expect(codes(dir)).toEqual({ refusals: [], warnings: [] });
  const moves = arr(read(dir).advances).map(obj).slice(-3);
  expect(moves.map(m => [m.from_stage, m.stage])).toEqual([['plan-approved', 'parts-review'], ['parts-review', 'interview'], ['interview', 'parts']]);
}, 120_000);

test('#981 parts edited after the rig exists rebuild into a new rig version without a rollback', () => {
  const dir = copy('3-rig-review');
  expect(read(dir).stage).toBe('rig-review');
  cpSync(join(dir, 'outputs/v1'), join(dir, 'outputs/v2'), { recursive: true });
  // The edit: one part's pixels change after rig v1 was built from the approved parts.
  cpSync(join(dir, 'outputs/v2/out/parts/eye_r.png'), join(dir, 'outputs/v2/out/parts/eye_l.png'));
  seedRig(dir, 2, 'Rebuild from the edited left eye.');
  ok(dir, 'review-package', '2', '--config', 'evidence/v1/config.json', '--from', 'outputs/v2/out');
  const project = read(dir);
  expect(project.stage).toBe('rig-review');
  expect(arr(project.reopens ?? []).length).toBe(0);
  expect(readFileSync(join(dir, 'derived/review/v2/out/parts/eye_l.png'))).toEqual(readFileSync(join(dir, 'outputs/v1/out/parts/eye_r.png')));
  expect(codes(dir)).toEqual({ refusals: [], warnings: [] });
}, 120_000);

test('#981 old-process projects still open, check and build', () => {
  const legacy = fixture();
  const opened = run(legacy, 'interview', '--check', '--json', legacy);
  expect(opened.exit).toBe(0);
  expect(JSON.parse(opened.stdout).ok).toBe(true);

  // The shipped chain was signed, advanced and accepted under the old approval process.
  const dir = copy();
  expect(read(dir).stage).toBe('accepted');
  const checked = run(dir, 'interview', '--check', '--json');
  expect(checked.exit).toBe(0);
  expect(JSON.parse(checked.stdout).ok).toBe(true);
  seedRig(dir, 3, 'Rebuild on the old-process record.');
  ok(dir, 'review-package', '3', '--config', 'evidence/v1/config.json', '--from', 'outputs/v1/out');
  expect(arr(read(dir).versions).map(obj).find(v => v.n === 3)!.review_package).toBeDefined();
}, 120_000);

test('#981 an accepted project gains a capability by editing current data, up to the accepted-rig binding', () => {
  const dir = copy();
  const signoffs = arr(read(dir).signoffs).length;
  // A new motion is a change to the motion step: revise it, run it again and rebuild the rig.
  ok(dir, 'plan', 'revise', 'motion', '--by', 'agent', '--does', 'Add a wave motion beside the idle',
    '--produces', 'Idle and wave clips on the rig', '--bar', 'The arm waves once and the idle still loops.');
  ok(dir, 'step-status', 'motion', 'in-progress', '--by', 'agent');
  ok(dir, 'step-status', 'motion', 'done', '--by', 'agent');
  seedRig(dir, 3, 'Add a wave motion.');
  ok(dir, 'review-package', '3', '--config', 'evidence/v1/config.json', '--from', 'outputs/v1/out');
  const project = read(dir);
  expect(project.stage).toBe('accepted');
  expect(arr(project.signoffs).length).toBe(signoffs);
  expect(project.reopens).toBeUndefined();
  expect(project.amendments).toBeUndefined();
  // Kept, out of #981's reach (version numbers, #984/#985): post work binds the latest accepted rig.
  expect(codes(dir).refusals).toEqual(['SCENE_RIG_STALE']);
  const scene = run(dir, 'scene', 'write', '--rig', '3', '--background', 'inputs/background.png', '--citations-file', 'evidence/scene-citations.json');
  expect(scene.exit).toBe(1);
  expect(scene.stderr).toContain('SCENE_ACCEPTANCE_STALE');
  const handoff = run(dir, 'handoff', '--json');
  expect(handoff.exit).toBe(1);
  expect(handoff.stderr).toContain('RIG_VERSION_UNACCEPTED');
}, 120_000);
