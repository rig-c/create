import { readFileSync } from './check-reads.ts';
import { isObject, type Finding } from './check.ts';
import { literalFile, sha256 } from './choices.ts';
import type { MotionLoopSeamPolicy } from './motion-loop-seam.ts';
import type { Json, JsonObject } from './templates.ts';

export const COMPOSE_CHECK_PATH = 'check/check.json';
export const COMPOSE_MODEL_PATH = 'check/build/skeleton.model.json';
const idleRoot = 'check/idle_frames';
const frameIndexPath = `${idleRoot}/frames.json`;
const idleFps = 12;
// Parts allows rounding between Core's exact period and the last sample on its idle frame grid.
const timeSlack = 1e-9;
const remedy = 'compose again with --loop-seam-bar and --loop-seam-cap using Parts and Core versions that retain the judged evidence, then record direction';

const whole = (value: Json | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: Json | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Read only inventory-bound files. With no staged take duration, use the recorded compose model. */
export function directionLoopSeamFindings(
  dir: string, policy: MotionLoopSeamPolicy | undefined, inventory: ReadonlyMap<string, string>, from: string,
  reportBinding: Json | undefined, duration?: number,
): Finding[] {
  const canonical = (rel: string): string => `outputs/direction/${rel}`;
  const reportPath = `${from}/${COMPOSE_CHECK_PATH}`;
  const seamPath = `${reportPath}.loop_seam`;
  const invalid = (path: string, why: string): Finding[] => [{ code: 'DIRECTION_LOOP_SEAM_INVALID', path,
    message: `${path}: ${why}; ${remedy}` }];
  const unjudged = (why: string): Finding[] => [{ code: 'DIRECTION_LOOP_SEAM_UNJUDGED', path: seamPath,
    message: `${seamPath}: ${why}; ${remedy}` }];

  function boundBytes(rel: string): Buffer | undefined {
    const expected = inventory.get(canonical(rel));
    if (expected === undefined) return;
    try {
      const bytes = readFileSync(literalFile(dir, `${from}/${rel}`));
      if (sha256(bytes) === expected) return bytes;
    } catch { /* Missing or unsafe files have no valid binding. */ }
  }
  function boundJson(rel: string): JsonObject | undefined {
    const bytes = boundBytes(rel);
    if (!bytes) return;
    try {
      const value: Json = JSON.parse(bytes.toString('utf8'));
      if (isObject(value)) return value;
    } catch { /* Malformed JSON has no valid producer evidence. */ }
  }

  if (!isObject(reportBinding) || reportBinding.path !== canonical(COMPOSE_CHECK_PATH) || typeof reportBinding.sha256 !== 'string'
    || reportBinding.sha256 !== inventory.get(canonical(COMPOSE_CHECK_PATH))) {
    return invalid('current.direction.report', 'expected the binding for check/check.json from the direction inventory');
  }
  const report = boundJson(COMPOSE_CHECK_PATH);
  if (report?.spec !== 'rig-parts-check/1') return invalid(reportPath, 'expected inventory-bound rig-parts-check/1 bytes');
  const seam = report.loop_seam;
  if (seam === undefined) return policy ? [{ code: 'DIRECTION_LOOP_SEAM_MISSING', path: seamPath,
    message: `${seamPath}: the declared loop seam budget requires embedded Parts evidence; ${remedy}` }] : [];
  if (!isObject(seam) || seam.spec !== 'rigc-loop-seam/1') return invalid(seamPath, 'expected an embedded rigc-loop-seam/1 report');
  if (seam.status === 'skip' && seam.code === 'LOOP_SEAM_UNAVAILABLE' && seam.bar === undefined && seam.cap === undefined) {
    return unjudged('Core could not measure the seam');
  }
  if (seam.status !== 'met' && seam.status !== 'unjudged') {
    return invalid(seamPath, 'unrecognized seam status or skip code');
  }
  if (seam.status === 'unjudged' && (seam.bar !== undefined || seam.cap !== undefined || seam.pixelsAbove !== undefined)) {
    return invalid(seamPath, 'an unjudged report cannot claim a bar, cap or judged pixel count');
  }

  if (duration === undefined) {
    const model = boundJson(COMPOSE_MODEL_PATH);
    const idle = Array.isArray(model?.animations) ? model.animations.filter(animation => isObject(animation) && animation.name === 'idle') : [];
    if (!isObject(report.build) || typeof report.build.model_sha256 !== 'string'
      || report.build.model_sha256 !== inventory.get(canonical(COMPOSE_MODEL_PATH))
      || idle.length !== 1 || !isObject(idle[0]) || !positive(idle[0].duration)) {
      return invalid(`${from}/${COMPOSE_MODEL_PATH}`, 'expected one positive idle duration in the inventory-bound model named by the Parts report');
    }
    duration = idle[0].duration;
  }

  const frames = boundJson(frameIndexPath);
  const set = Array.isArray(frames?.sets) && frames.sets.length === 1 ? frames.sets[0] : undefined;
  if (frames?.spec !== 'rigc-frames/1' || !isObject(set) || typeof set.dir !== 'string'
    || !/^[A-Za-z0-9_@+.~-]{1,255}$/.test(set.dir) || set.dir.endsWith('.')) {
    return invalid(`${from}/${frameIndexPath}`, 'expected a bound rigc-frames/1 index with one literal idle set');
  }
  const period = seam.period;
  if (seam.animation !== 'idle' || set.animation !== 'idle' || seam.fps !== idleFps || set.fps !== idleFps
    || !positive(period) || !positive(duration) || !positive(set.duration) || Math.abs(period - duration) > timeSlack
    || Math.abs(period - set.duration) > timeSlack || Math.abs(set.duration - duration) > timeSlack) {
    return invalid(seamPath, 'expected a positive idle period matching the composed take and retained idle frames at 12 fps');
  }
  const warmup = seam.warmup;
  const recordedWarmup = seam.status === 'unjudged' ? (set.preroll ?? frames.preroll ?? 0) : set.preroll;
  if (!whole(warmup) || recordedWarmup !== (seam.status === 'met' && warmup === 0 ? undefined : warmup)) {
    return invalid(seamPath, 'the reported warm-up does not match the retained set');
  }
  for (const [key, file, time] of [['first', 'f0000.png', 0], ['wrap', 'loop-wrap.png', period]] as const) {
    const endpoint = seam[key];
    const rel = `${set.dir}/${file}`;
    const path = `${idleRoot}/${rel}`;
    if (!isObject(endpoint) || endpoint.path !== rel || endpoint.time !== time || (key === 'wrap' && endpoint.encoding !== 'png')
      || typeof endpoint.sha256 !== 'string' || endpoint.sha256 !== inventory.get(canonical(path)) || !boundBytes(path)) {
      return invalid(`${from}/${path}`, `expected the bound ${key} endpoint named by the embedded report at t = ${time}s`);
    }
  }
  if (seam.status === 'unjudged') return unjudged('Core measured the seam without judging it');
  const bar = seam.bar;
  if (!isObject(bar) || !whole(bar.channelDelta) || bar.channelDelta > 255 || !whole(bar.pixelsAbove)
    || !whole(seam.pixelsAbove) || !whole(seam.cap) || warmup > seam.cap
    || (policy && (bar.channelDelta !== policy.channel_delta || bar.pixelsAbove !== policy.pixels_above || seam.cap !== policy.warmup_cap))) {
    return invalid(seamPath, 'the judged bar or cap does not match the declared budget or reported warm-up');
  }
  if (seam.pixelsAbove > bar.pixelsAbove) return [{ code: 'DIRECTION_LOOP_SEAM_OVER_BAR', path: seamPath,
    message: `${seamPath}: the producer reports ${seam.pixelsAbove} pixels above channel delta ${bar.channelDelta} with ${bar.pixelsAbove} allowed; adjust the idle to meet its budget and ${remedy}` }];
  return [];
}
