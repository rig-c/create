import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordCheckReads } from '../src/check-reads.ts';
import { sha256 } from '../src/choices.ts';
import { COMPOSE_CHECK_PATH, COMPOSE_MODEL_PATH, directionLoopSeamFindings } from '../src/direction-loop-seam.ts';
import type { JsonObject } from '../src/templates.ts';
import { tempDir } from './helpers.ts';

const root = 'outputs/direction';
const stage = `${root}.next`;
const idle = 'check/idle_frames';
const set = 'idle@12fps';
const period = 40 / 12;
const policy = { channel_delta: 8, pixels_above: 2, warmup_cap: 4 };

function fixture(from = stage) {
  const dir = tempDir();
  const inventory = new Map<string, string>();
  const write = (rel: string, value: string | JsonObject, bind = true): string => {
    const path = join(dir, from, rel);
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const digest = sha256(bytes);
    if (bind) inventory.set(`${root}/${rel}`, digest);
    return digest;
  };
  const model = write(COMPOSE_MODEL_PATH, { animations: [{ name: 'idle', duration: period }] });
  const first = `${set}/f0000.png`;
  const wrap = `${set}/loop-wrap.png`;
  const seam = {
    spec: 'rigc-loop-seam/1', animation: 'idle', status: 'met', period, fps: 12, warmup: 0, cap: 4,
    bar: { channelDelta: 8, pixelsAbove: 2 }, pixelsAbove: 2,
    first: { path: first, time: 0, sha256: write(`${idle}/${first}`, 'first endpoint') },
    wrap: { path: wrap, time: period, encoding: 'png', sha256: write(`${idle}/${wrap}`, 'wrap endpoint') },
  };
  write(`${idle}/frames.json`, { spec: 'rigc-frames/1', sets: [{ dir: set, animation: 'idle', fps: 12, duration: 40 * (1 / 12) }] });
  const bindReport = (embedded?: JsonObject, spec = 'rig-parts-check/1') => ({ path: `${root}/${COMPOSE_CHECK_PATH}`,
    sha256: write(COMPOSE_CHECK_PATH, { spec, build: { model_sha256: model }, ...(embedded === undefined ? {} : { loop_seam: embedded }) }) });
  return { dir, inventory, write, bindReport, seam, from };
}

test('direction uses the embedded judgment and binds the staged idle endpoints', () => {
  const f = fixture();
  const binding = f.bindReport(f.seam);
  f.write(`${idle}/${set}/loop-seam.json`, { ...f.seam, pixelsAbove: 100 });
  const observed = recordCheckReads(f.dir, () => directionLoopSeamFindings(f.dir, policy, f.inventory, f.from, binding, period));
  expect(observed.value).toEqual([]);
  expect(observed.reads.map(read => read.path)).toEqual([
    COMPOSE_CHECK_PATH, `${idle}/frames.json`, `${idle}/${set}/f0000.png`, `${idle}/${set}/loop-wrap.png`,
  ].map(rel => `${stage}/${rel}`));
  f.write(`${idle}/${set}/loop-wrap.png`, 'different wrap', false);
  expect(directionLoopSeamFindings(f.dir, policy, f.inventory, f.from, binding, period)[0]?.code).toBe('DIRECTION_LOOP_SEAM_INVALID');
  f.write(`${idle}/${set}/loop-wrap.png`, 'different wrap');
  expect(directionLoopSeamFindings(f.dir, policy, f.inventory, f.from, binding, period)[0]?.code).toBe('DIRECTION_LOOP_SEAM_INVALID');
});

test('current direction takes its period from the frozen compose model', () => {
  const f = fixture(root);
  const binding = f.bindReport(f.seam);
  expect(directionLoopSeamFindings(f.dir, policy, f.inventory, f.from, binding)).toEqual([]);
  expect(directionLoopSeamFindings(f.dir, policy, f.inventory, f.from, binding, period + 1)[0]?.code).toBe('DIRECTION_LOOP_SEAM_INVALID');
  f.write(COMPOSE_MODEL_PATH, { animations: [{ name: 'idle', duration: period + 1 }] });
  expect(directionLoopSeamFindings(f.dir, policy, f.inventory, f.from, binding)[0]?.code).toBe('DIRECTION_LOOP_SEAM_INVALID');
});

test('direction distinguishes missing, unjudged, over-budget and invalid evidence', () => {
  const f = fixture();
  const codes = (binding: JsonObject, declared: typeof policy | undefined) =>
    directionLoopSeamFindings(f.dir, declared, f.inventory, f.from, binding, period).map(finding => finding.code);
  const absent = f.bindReport();
  expect(codes(absent, undefined)).toEqual([]);
  expect(codes(absent, policy)).toEqual(['DIRECTION_LOOP_SEAM_MISSING']);
  expect(codes(f.bindReport({ spec: 'rigc-loop-seam/1', status: 'skip', code: 'LOOP_SEAM_UNAVAILABLE' }), policy)).toEqual(['DIRECTION_LOOP_SEAM_UNJUDGED']);
  const { first, wrap, fps, animation, warmup, spec } = f.seam;
  expect(codes(f.bindReport({ first, wrap, fps, animation, warmup, spec, period, status: 'unjudged' }), policy)).toEqual(['DIRECTION_LOOP_SEAM_UNJUDGED']);
  expect(codes(f.bindReport({ ...f.seam, pixelsAbove: 3 }), policy)).toEqual(['DIRECTION_LOOP_SEAM_OVER_BAR']);
  expect(codes(f.bindReport({ ...f.seam, cap: 5 }), policy)).toEqual(['DIRECTION_LOOP_SEAM_INVALID']);
  expect(codes(f.bindReport(f.seam, 'wrong-spec'), policy)).toEqual(['DIRECTION_LOOP_SEAM_INVALID']);
  const staleBinding = f.bindReport({ ...f.seam, cap: 7 });
  f.bindReport(f.seam);
  expect(codes(staleBinding, policy)).toEqual(['DIRECTION_LOOP_SEAM_INVALID']);
});
