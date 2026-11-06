import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../templates/example-direction');
const model = JSON.parse(readFileSync(join(root, 'derived/review/v1/out/check/build/skeleton.model.json'), 'utf8'));

// review c3e571d, src/turn-pad.ts:12-29: compiled metadata, not author config.
function yawRange(m: typeof model): number[] | null {
  const sliders = (m.constraints ?? []).filter((c: typeof model) => c.kind === 'slider' && c.bone === 'yaw_dial' && m.bones?.some((b: typeof model) => b.name === c.bone));
  if (sliders.length !== 1) return null;
  const c = sliders[0], duration = m.animations?.find((a: typeof model) => a.name === c.animation)?.duration;
  if (!c.local || c.loop || c.property !== 'rotate' || ![duration, c.from, c.to, c.scale].every(Number.isFinite) || duration <= 0 || c.scale === 0) return null;
  const ends = [c.from - c.to / c.scale, c.from + (duration - c.to) / c.scale].sort((a,b) => a-b);
  return ends[0] < 0 && ends[1] > 0 ? ends : null;
}

test('compiled build declares yaw and leaves requested camera undeclared', () => {
  expect(model.spec).toBe('rigc-compiled/3');
  expect(yawRange(model)?.[0]).toBeCloseTo(-30, 4);
  expect(yawRange(model)?.[1]).toBeCloseTo(30, 4);
  expect(model.camera).toBeUndefined();
  expect(model.animations.some((a: typeof model) => Object.hasOwn(a, 'camera'))).toBe(false);
});

test('removing the declared slider loses the yaw capability', () => {
  expect(yawRange(model)).not.toBeNull();
  expect(yawRange({ ...model, constraints: [] })).toBeNull();
});

import { cpSync, writeFileSync } from 'node:fs';
import { checkDirectionFixtureHashes } from '../scripts/check-direction-fixture-hashes.ts';
import { tempDir } from './helpers.ts';

test('every recorded hash matches and a one-byte model change is named', () => {
  expect(checkDirectionFixtureHashes(root)).toBeGreaterThan(0);
  const copy = join(tempDir(), 'direction');
  cpSync(root, copy, {recursive: true});
  const path = 'derived/review/v1/out/check/build/skeleton.model.json';
  const bytes = readFileSync(join(copy, path));
  bytes[bytes.length - 1] = 32;
  writeFileSync(join(copy, path), bytes);
  expect(() => checkDirectionFixtureHashes(copy)).toThrow(`hash mismatch for ${path}`);
});
