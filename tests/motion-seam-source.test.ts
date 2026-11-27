import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_NOW, EXAMPLE_SOURCE_DATE_EPOCH } from '../scripts/example-time.ts';
import { checkProject } from '../src/check.ts';
import { SOURCE_CONDITION_FLAG } from '../src/job-writer.ts';
import { nextProject } from '../src/next.ts';
import { recordCommand } from '../src/record.ts';
import type { JsonObject } from '../src/templates.ts';
import { tempDir, treeDigest } from './helpers.ts';
import { sourceOnlyTest } from './source-only.ts';

const staged = 'outputs/motion.next';
const installed = 'outputs/motion';
const setDir = 'idle@1fps';
const seamReport = `${setDir}/loop-seam.json`;
const firstPng = `${setDir}/f0000.png`;
const wrapPng = `${setDir}/loop-wrap.png`;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const readJson = (path: string): JsonObject => JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
const writeJson = (path: string, value: JsonObject): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function postProject(): string {
  const dir = tempDir();
  cpSync(join(import.meta.dir, '../templates/example-current'), dir, { recursive: true });
  const path = join(dir, 'project.json');
  const project = readJson(path);
  // Rewind the synthetic copy to post just before its first motion render.
  project.stage = 'post';
  project.advances = (project.advances as JsonObject[]).filter(move => !['direction-review', 'accepted'].includes(String(move.stage)));
  project.signoffs = (project.signoffs as JsonObject[]).filter(signoff => signoff.stage !== 'direction-review');
  const current = project.current as JsonObject;
  delete current.motion;
  delete current.direction;
  for (const step of (project.plan as JsonObject).steps as JsonObject[]) {
    if (step.phase !== 'post') continue;
    step.status = 'in-progress';
    step.status_history = (step.status_history as JsonObject[]).filter(event => event.status !== 'done');
  }
  writeJson(path, project);
  for (const path of [installed, 'outputs/direction', 'specs/direction']) {
    rmSync(join(dir, path), { recursive: true });
  }
  return dir;
}

function motionCommand(dir: string, role: 'producer' | 'agent'): string {
  const next = nextProject(dir, EXAMPLE_NOW);
  expect(next.refusals).toEqual([]);
  const command = next.moves.find(move => move.field === 'current.motion' && move.role === role)?.command;
  if (!command) throw new Error(`next did not offer a ${role} command for current.motion: ${JSON.stringify(next.moves)}`);
  return command;
}

sourceOnlyTest('#1073 records real Core loop seam evidence and refuses wrong endpoint identities and hashes', () => {
  const dir = postProject();
  const projectPath = join(dir, 'project.json');
  const ordinary = motionCommand(dir, 'producer');
  expect(ordinary).not.toContain('--loop-seam');

  const policyDir = join(dir, 'specs/motion');
  mkdirSync(policyDir, { recursive: true });
  writeJson(join(policyDir, 'loop-seam.json'), { channel_delta: 8, pixels_above: 0, warmup_cap: 12 });
  const command = motionCommand(dir, 'producer');
  expect(command).toContain('<frames-per-second>');
  // Give the actual next command the same source resolution as the test.
  const rendered = Bun.spawnSync(['sh', '-c', [
    `rigc() { "$RIG_CREATE_TEST_BUN" ${SOURCE_CONDITION_FLAG} "$RIG_CREATE_TEST_CORE" "$@"; }`,
    command.replace('<frames-per-second>', '1'),
  ].join('\n')], {
    cwd: dir,
    env: { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH,
      RIG_CREATE_TEST_BUN: process.execPath, RIG_CREATE_TEST_CORE: Bun.resolveSync('@rig-c/core/cli', import.meta.dir) },
    stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  });
  expect(rendered.exitCode, `${rendered.stdout}\n${rendered.stderr}`).toBe(0);
  expect(motionCommand(dir, 'agent')).toMatch(/^rig-create record motion /);

  const reportPath = join(dir, staged, seamReport);
  const reportBytes = readFileSync(reportPath);
  const report = readJson(reportPath);
  const take = readJson(join(dir, staged, 'frames.json'));
  const first = { path: firstPng, sha256: sha256(readFileSync(join(dir, staged, firstPng))) };
  const wrap = { path: wrapPng, sha256: sha256(readFileSync(join(dir, staged, wrapPng))) };
  expect(take.sets).toEqual([expect.objectContaining({ dir: setDir, animation: 'idle', fps: 1, duration: 4 })]);
  expect(report).toMatchObject({
    spec: 'rigc-loop-seam/1', animation: 'idle', fps: 1, period: 4, viewport: take.viewport,
    status: 'met', bar: { channelDelta: 8, pixelsAbove: 0 }, cap: 12, warmup: 0, pixelsAbove: 0,
    first: { time: 0, ...first }, wrap: { time: 4, encoding: 'png', ...wrap },
  });

  const before = readFileSync(projectPath);
  const runPath = join(dir, staged, 'render-run.json');
  const runBytes = readFileSync(runPath);
  const run = readJson(runPath);
  const receiptEntry = (run.outputs as JsonObject[]).find(output => output.path === seamReport);
  if (!receiptEntry) throw new Error(`Core's render receipt did not list ${seamReport}`);
  expect(receiptEntry.sha256).toBe(sha256(reportBytes));
  const record = () => recordCommand(['motion', dir, '--from', staged, '--json'], EXAMPLE_NOW);
  for (const endpoint of [wrap, { ...first, sha256: sha256(reportBytes) }]) {
    writeJson(reportPath, { ...report, first: { time: 0, ...endpoint } });
    // Keep the outer receipt valid so this probes the seam endpoint validation.
    receiptEntry.sha256 = sha256(readFileSync(reportPath));
    writeJson(runPath, run);
    const stagedBytes = treeDigest(join(dir, staged));
    expect(record).toThrow(expect.objectContaining({ code: 'MOTION_LOOP_SEAM_INVALID' }));
    expect(readFileSync(projectPath)).toEqual(before);
    expect(treeDigest(join(dir, staged))).toEqual(stagedBytes);
    expect(existsSync(join(dir, installed))).toBe(false);
  }

  writeFileSync(reportPath, reportBytes);
  writeFileSync(runPath, runBytes);
  expect(record().exit).toBe(0);
  expect(existsSync(join(dir, staged))).toBe(false);
  const motion = (readJson(projectPath).current as JsonObject).motion as JsonObject;
  for (const relativePath of [seamReport, firstPng, wrapPng]) {
    const path = `${installed}/${relativePath}`;
    const bytes = readFileSync(join(dir, path));
    expect(motion.files).toContainEqual({ path, sha256: sha256(bytes), bytes: bytes.length });
  }
  expect(readFileSync(join(dir, installed, seamReport))).toEqual(reportBytes);
  expect(checkProject(dir, undefined, { now: EXAMPLE_NOW }).refusals).toEqual([]);
}, 30_000);
