import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { outputSetHash, sha256, treeFiles } from '../src/current.ts';
import { LOOP_SEAM_REPORT_SINCE } from '../src/motion-loop-seam.ts';
import { nextProject } from '../src/next.ts';
import type { JsonObject } from '../src/templates.ts';
import { tempDir } from './helpers.ts';

const policy = { channel_delta: 9, pixels_above: 2, warmup_cap: 6 };
const flags = ' --loop-seam-bar 9,2 --loop-seam-cap 6';
const budgetPath = 'specs/motion/loop-seam.json';
const motionFrom = 'outputs/motion.next';
const directionFrom = 'outputs/direction.next';
const motionRoot = 'outputs/motion';
const seamRel = 'idle@1fps/loop-seam.json';

function put(dir: string, path: string, value: JsonObject): void {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function postFixture(kind: 'motion' | 'direction', historicalMotion = false, retainDirection = false): string {
  const dir = tempDir();
  cpSync(join(import.meta.dir, '../templates/example-current'), dir, { recursive: true });
  rmSync(join(dir, budgetPath), { force: true });
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  project.stage = 'post';
  project.advances = (project.advances as JsonObject[]).slice(0, -2);
  project.signoffs = (project.signoffs as JsonObject[]).filter(signoff => signoff.stage !== 'direction-review');
  const current = project.current as JsonObject;
  if (!retainDirection) delete current.direction;
  if (historicalMotion) (current.motion as JsonObject).at = new Date(Date.parse(LOOP_SEAM_REPORT_SINCE) - 1).toISOString();
  if (kind === 'motion') {
    delete current.motion;
    for (const step of (project.plan as JsonObject).steps as JsonObject[]) {
      if (step.phase !== 'post') continue;
      step.status = 'in-progress';
      step.status_history = (step.status_history as JsonObject[]).slice(0, 1);
    }
  }
  put(dir, 'project.json', project);
  return dir;
}

function outputMove(dir: string, kind: 'motion' | 'direction') {
  const next = nextProject(dir, EXAMPLE_NOW);
  expect(next.refusals).toEqual([]);
  const moves = next.moves.filter(move => move.field === `current.${kind}`);
  expect(moves).toHaveLength(1);
  return moves[0]!;
}

test('#1073 next preserves a staged render until it can be recorded against the declared seam budget', () => {
  const dir = postFixture('motion');
  mkdirSync(join(dir, motionFrom));
  expect(outputMove(dir, 'motion').command).toContain('rigc render ');
  renameSync(join(dir, motionFrom), join(dir, 'outputs/motion.partial'));
  put(dir, budgetPath, policy);
  expect(outputMove(dir, 'motion').command).toEndWith(`${flags})`);
  cpSync(join(dir, 'outputs/motion'), join(dir, motionFrom), { recursive: true });
  rmSync(join(dir, motionFrom, seamRel), { force: true });
  expect(outputMove(dir, 'motion')).toMatchObject({ command: null, act: expect.stringContaining('MOTION_LOOP_SEAM_MISSING') });

  const set = `${motionFrom}/idle@1fps`;
  const first = readFileSync(join(dir, set, 'f0000.png'));
  const wrap = Buffer.from('synthetic wrap');
  writeFileSync(join(dir, set, 'loop-wrap.png'), wrap);
  const report = {
    spec: 'rigc-loop-seam/1', animation: 'idle', fps: 1, period: 4, warmup: 0,
    first: { path: 'idle@1fps/f0000.png', time: 0, sha256: sha256(first) },
    wrap: { path: 'idle@1fps/loop-wrap.png', time: 4, sha256: sha256(wrap) },
  };
  put(dir, `${set}/loop-seam.json`, { ...report, status: 'unjudged' });
  expect(outputMove(dir, 'motion')).toMatchObject({ command: null, act: expect.stringContaining('MOTION_LOOP_SEAM_UNJUDGED') });
  const held = 'outputs/motion.unjudged';
  renameSync(join(dir, motionFrom), join(dir, held));
  expect(outputMove(dir, 'motion').command).toEndWith(`${flags})`);
  expect(readFileSync(join(dir, held, 'idle@1fps/loop-wrap.png'))).toEqual(wrap);

  cpSync(join(dir, 'outputs/motion'), join(dir, motionFrom), { recursive: true });
  writeFileSync(join(dir, set, 'loop-wrap.png'), wrap);
  put(dir, `${set}/loop-seam.json`, { ...report, status: 'met', bar: { channelDelta: 9, pixelsAbove: 2 }, cap: 6, pixelsAbove: 0 });
  expect(outputMove(dir, 'motion').command).toContain('rig-create record motion ');
});

test('#1073 next passes the declared seam budget to current compose and preserves incomplete output', () => {
  const dir = postFixture('direction', true);
  const compose = outputMove(dir, 'direction').command;
  if (compose === null) throw new Error('next did not offer a compose command');
  expect(compose).toContain('rig-parts compose --scene specs/direction/compose-scene.json --out outputs/direction.next');
  expect(compose).not.toContain('--loop-seam');
  const judgedCompose = compose.replace(/\)$/, ' --loop-seam-bar 8,0 --loop-seam-cap 12)');
  put(dir, `${directionFrom}/scene.json`, { partial: true });
  expect(outputMove(dir, 'direction').command).toBe(compose);
  put(dir, budgetPath, { channel_delta: 8, pixels_above: 0, warmup_cap: 12 });
  expect(outputMove(dir, 'direction')).toMatchObject({ command: null, act: expect.stringContaining('Preserve outputs/direction.next') });
  const held = 'outputs/direction.incomplete';
  renameSync(join(dir, directionFrom), join(dir, held));
  expect(outputMove(dir, 'direction').command).toBe(judgedCompose);
  expect(readFileSync(join(dir, held, 'scene.json'), 'utf8')).toBe('{"partial":true}');

  cpSync(join(dir, 'outputs/direction'), join(dir, directionFrom), { recursive: true });
  const checkPath = `${directionFrom}/check/check.json`;
  const report = JSON.parse(readFileSync(join(dir, checkPath), 'utf8')) as JsonObject;
  delete report.loop_seam;
  put(dir, checkPath, report);
  expect(outputMove(dir, 'direction')).toMatchObject({ command: null, act: expect.stringContaining('DIRECTION_LOOP_SEAM_MISSING') });

  const idleRoot = `${directionFrom}/check/idle_frames`;
  const set = 'idle';
  put(dir, `${idleRoot}/frames.json`, { spec: 'rigc-frames/1', sets: [{ animation: 'idle', dir: set, fps: 12, duration: 4 }] });
  const first = readFileSync(join(dir, idleRoot, set, 'f0000.png'));
  const wrap = Buffer.from('synthetic compose wrap');
  writeFileSync(join(dir, idleRoot, set, 'loop-wrap.png'), wrap);
  const seam = { spec: 'rigc-loop-seam/1', animation: 'idle', fps: 12, period: 4, warmup: 0,
    first: { path: `${set}/f0000.png`, time: 0, sha256: sha256(first) },
    wrap: { path: `${set}/loop-wrap.png`, time: 4, sha256: sha256(wrap), encoding: 'png' },
  };
  put(dir, checkPath, { ...report, loop_seam: { ...seam, status: 'unjudged' } });
  expect(outputMove(dir, 'direction')).toMatchObject({ command: null, act: expect.stringContaining('DIRECTION_LOOP_SEAM_UNJUDGED') });
  put(dir, checkPath, { ...report, loop_seam: { ...seam, status: 'met', bar: { channelDelta: 8, pixelsAbove: 0 }, cap: 12, pixelsAbove: 0 } });
  expect(outputMove(dir, 'direction').command).toContain('rig-create record direction ');
});

test('#1073 next offers a replacement render when recorded motion is refused for a missing seam report', () => {
  const dir = postFixture('direction');
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const motion = (project.current as JsonObject).motion as JsonObject;
  rmSync(join(dir, motionRoot, seamRel), { force: true });
  const files = treeFiles(dir, motionRoot);
  motion.files = files;
  motion.files_sha256 = outputSetHash(files);
  put(dir, 'project.json', project);
  put(dir, budgetPath, policy);
  const next = nextProject(dir, EXAMPLE_NOW);
  expect(next.refusals.map(finding => finding.code)).toEqual(['MOTION_LOOP_SEAM_MISSING']);
  expect(next.moves.find(move => move.field === 'current.motion')?.command).toEndWith(`${flags})`);
  expect(next.moves.some(move => move.command?.includes('rig-parts compose'))).toBe(false);
});

test('#1073 next offers a replacement compose when recorded direction is refused for missing seam evidence', () => {
  const dir = postFixture('direction', true, true);
  const root = 'outputs/direction';
  const checkPath = `${root}/check/check.json`;
  const report = JSON.parse(readFileSync(join(dir, checkPath), 'utf8')) as JsonObject;
  delete report.loop_seam;
  put(dir, checkPath, report);
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const direction = (project.current as JsonObject).direction as JsonObject;
  const files = treeFiles(dir, root);
  direction.files = files;
  direction.files_sha256 = outputSetHash(files);
  direction.report = { path: checkPath, sha256: sha256(readFileSync(join(dir, checkPath))) };
  put(dir, 'project.json', project);
  put(dir, budgetPath, { channel_delta: 8, pixels_above: 0, warmup_cap: 12 });

  const next = nextProject(dir, EXAMPLE_NOW);
  expect(next.refusals.map(finding => finding.code)).toEqual(['DIRECTION_LOOP_SEAM_MISSING']);
  expect(next.moves.find(move => move.field === 'current.direction')?.command)
    .toEndWith(' --loop-seam-bar 8,0 --loop-seam-cap 12)');
});
