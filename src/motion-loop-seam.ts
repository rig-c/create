import { join } from 'node:path';
import { lstatSync, readFileSync } from './check-reads.ts';
import { isObject, type Finding } from './check.ts';
import { literalFile } from './choices.ts';
import { sha256 } from './current.ts';
import type { Json, JsonObject } from './templates.ts';

const policyPath = 'specs/motion/loop-seam.json';
const seamFile = 'loop-seam.json';
const rerender = 'render again with a Core version that writes rigc-loop-seam/1 and record motion';

function whole(value: Json | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

interface MotionLoopSeamPolicy {
  channel_delta: number;
  pixels_above: number;
  warmup_cap: number;
}

export function readMotionLoopSeamPolicy(dir: string): { policy?: MotionLoopSeamPolicy; finding?: Finding } {
  try {
    lstatSync(join(dir, policyPath));
    const value: Json = JSON.parse(readFileSync(literalFile(dir, policyPath), 'utf8'));
    if (isObject(value) && whole(value.channel_delta) && value.channel_delta <= 255
      && whole(value.pixels_above) && whole(value.warmup_cap)) {
      return { policy: { channel_delta: value.channel_delta, pixels_above: value.pixels_above, warmup_cap: value.warmup_cap } };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
  }
  return { finding: { code: 'MOTION_LOOP_SEAM_POLICY_INVALID', path: policyPath,
    message: `${policyPath}: expected a readable spec with channel_delta in 0..255 and nonnegative safe integers for pixels_above and warmup_cap; correct the loop seam budget` } };
}

export function hasMotionLoopSeam(inventory: ReadonlyMap<string, string>): boolean {
  return [...inventory.keys()].some(path => path.endsWith(`/${seamFile}`));
}

/** Inventory names are canonical while the writer reads the staged tree. Only read bound bytes. */
export function motionLoopSeamFindings(
  dir: string, policy: MotionLoopSeamPolicy | undefined, inventory: ReadonlyMap<string, string>, root: string, from: string,
): Finding[] {
  const reports = new Set([...inventory.keys()].filter(path => path.endsWith(`/${seamFile}`)));

  function boundBytes(rel: string): Buffer | undefined {
    const expected = inventory.get(`${root}/${rel}`);
    if (expected === undefined) return;
    try {
      const bytes = readFileSync(literalFile(dir, `${from}/${rel}`));
      if (sha256(bytes) === expected) return bytes;
    } catch { /* The caller reports the invalid binding. */ }
  }
  function boundJson(rel: string): JsonObject | undefined {
    try {
      const bytes = boundBytes(rel);
      const value: Json | undefined = bytes === undefined ? undefined : JSON.parse(bytes.toString('utf8'));
      if (isObject(value)) return value;
    } catch { /* The caller reports the invalid producer JSON. */ }
  }

  const missing = (path: string): Finding => ({ code: 'MOTION_LOOP_SEAM_MISSING', path,
    message: `${path}: the declared seam budget needs a producer report; older Core can accept these flags without writing one, so ${rerender}` });
  const invalid = (path: string, why: string): Finding => ({ code: 'MOTION_LOOP_SEAM_INVALID', path,
    message: `${path}: ${why}; ${rerender}` });
  if (reports.size === 0) return policy ? [missing(`${from}/frames.json`)] : [];

  const frames = boundJson('frames.json');
  if (frames?.spec !== 'rigc-frames/1' || !Array.isArray(frames.sets) || frames.sets.length === 0) {
    return [invalid(`${from}/frames.json`, 'expected the bound rigc-frames/1 inventory for the seam reports')];
  }
  const findings: Finding[] = [];
  for (const set of frames.sets) {
    if (!isObject(set) || typeof set.dir !== 'string' || !/^[^/\\:]+$/.test(set.dir)
      || set.dir === '.' || set.dir === '..') {
      findings.push(invalid(`${from}/frames.json`, 'expected a literal frame-set directory for the seam report'));
      continue;
    }
    const rel = `${set.dir}/${seamFile}`;
    const path = `${from}/${rel}`;
    if (!reports.delete(`${root}/${rel}`)) {
      if (policy) findings.push(missing(path));
      continue;
    }
    const report = boundJson(rel);
    if (report?.spec !== 'rigc-loop-seam/1' || report.fps !== set.fps) {
      findings.push(invalid(path, 'expected the bound rigc-loop-seam/1 report at the frame-set rate'));
      continue;
    }
    if (report.status === 'skip') {
      if (report.code !== 'LOOP_SEAM_UNAVAILABLE') findings.push(invalid(path, 'unexpected skip code'));
      else findings.push({ code: 'MOTION_LOOP_SEAM_UNJUDGED', path,
        message: `${path}: Core could not measure the seam; use a take with a positive period and ${rerender}` });
      continue;
    }
    const first = `${set.dir}/f0000.png`;
    const wrap = `${set.dir}/loop-wrap.png`;
    function endpoint(value: Json | undefined, rel: string, time: number): boolean {
      return isObject(value) && value.path === rel && value.time === time
        && typeof value.sha256 === 'string' && value.sha256 === inventory.get(`${root}/${rel}`)
        && boundBytes(rel) !== undefined;
    }
    const period = report.period;
    // The frame grid's last sample can be earlier or later than the exact wrap.
    if (typeof set.animation !== 'string' || report.animation !== set.animation
      || typeof set.fps !== 'number' || !Number.isFinite(set.fps) || set.fps <= 0
      || typeof period !== 'number' || !Number.isFinite(period) || period <= 0
      || !whole(report.warmup) || report.warmup !== (set.preroll ?? frames.preroll ?? 0)
      || !endpoint(report.first, first, 0) || !endpoint(report.wrap, wrap, period)) {
      findings.push(invalid(path, 'the take, warm-up or endpoint hashes do not match the bound frame set'));
      continue;
    }
    if (report.status === 'unjudged') {
      findings.push({ code: 'MOTION_LOOP_SEAM_UNJUDGED', path,
        message: `${path}: Core measured the seam without judging it; supply the project budget with --loop-seam-bar and --loop-seam-cap and ${rerender}` });
      continue;
    }
    const bar = report.bar;
    if (report.status !== 'met' || !isObject(bar) || !whole(bar.channelDelta) || bar.channelDelta > 255
      || !whole(bar.pixelsAbove) || !whole(report.pixelsAbove) || !whole(report.cap)
      || report.warmup > report.cap
      || (policy && (bar.channelDelta !== policy.channel_delta || bar.pixelsAbove !== policy.pixels_above || report.cap !== policy.warmup_cap))) {
      findings.push(invalid(path, 'expected a judged report with the declared bar and cap'));
    } else if (report.pixelsAbove > bar.pixelsAbove) {
      findings.push({ code: 'MOTION_LOOP_SEAM_OVER_BAR', path,
        message: `${path}: Core reports ${report.pixelsAbove} pixels above channel delta ${bar.channelDelta}, with ${bar.pixelsAbove} allowed; ${rerender}` });
    }
  }
  for (const path of reports) {
    findings.push(invalid(`${from}/${path.slice(root.length + 1)}`, 'the report names no frame set in frames.json'));
  }
  return findings;
}
