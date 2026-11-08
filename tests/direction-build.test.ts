import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { checkDirectionFixtureHashes } from '../scripts/check-direction-fixture-hashes.ts';
import { run, tempDir } from './helpers.ts';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '../templates/example-direction');
const model = JSON.parse(readFileSync(join(root, 'derived/review/v1/out/check/build/skeleton.model.json'), 'utf8'));

interface TurnDial {axis: string; min: number; max: number}
function readDials(value: unknown): TurnDial[] {
  const reader = join(import.meta.dir, '../node_modules/@rig-c/review/src/turn-pad.ts');
  const result = run([process.execPath, '-e', `
    import { discoverTurnDials } from ${JSON.stringify(reader)};
    console.log(JSON.stringify(discoverTurnDials(${JSON.stringify(value)})));
  `], root, {...process.env} as Record<string, string>);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as TurnDial[];
}

test('compiled build declares yaw and leaves requested camera undeclared', () => {
  expect(model.spec).toBe('rigc-compiled/3');
  const dials = readDials(model);
  expect(dials).toHaveLength(1);
  expect(dials[0]!.axis).toBe('yaw');
  expect(dials[0]!.min).toBeCloseTo(-30, 4);
  expect(dials[0]!.max).toBeCloseTo(30, 4);
  expect(model.camera).toBeUndefined();
  expect(model.animations.some((a: typeof model) => Object.hasOwn(a, 'camera'))).toBe(false);
});

test('removing the declared slider loses the yaw capability', () => {
  expect(readDials(model)).toHaveLength(1);
  expect(readDials({ ...model, constraints: [] })).toEqual([]);
});


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

test('compiled spine digest names a one-byte skeleton change', () => {
  const copy = join(tempDir(), 'direction');
  cpSync(root, copy, {recursive: true});
  const path = 'derived/review/v1/out/check/build/skeleton.json';
  const bytes = readFileSync(join(copy, path));
  bytes[bytes.length - 1] = 32;
  writeFileSync(join(copy, path), bytes);
  expect(() => checkDirectionFixtureHashes(copy)).toThrow(`hash mismatch for ${path}`);
});

test('unknown sha256 fields refuse by name at every nesting depth', () => {
  for (const key of ['sha256', 'future_sha256']) {
    const copy = join(tempDir(), 'direction');
    cpSync(root, copy, {recursive: true});
    writeFileSync(join(copy, 'unknown.json'), JSON.stringify({nested: [{[key]: 'a'.repeat(64)}]}));
    expect(() => checkDirectionFixtureHashes(copy)).toThrow(`UNCONSUMED_SHA256: unknown.json.nested[0].${key}`);
  }
});

test.each([
  ['rigc-run/1', 'inputs'],
  ['rig-run/1', 'config'],
] as const)('%s stamp entries resolve against the stamp directory and a one-byte change is named', (spec, key) => {
  const fixtureDir = tempDir();
  const write = (path: string, text: string): void => { mkdirSync(dirname(join(fixtureDir, path)), {recursive: true}); writeFileSync(join(fixtureDir, path), text); };
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  write('evidence/config.json', '{"synthetic":"config"}\n');
  write('derived/out/build/model.json', '{"synthetic":"model"}\n');
  const input = {path: '../../../evidence/config.json', sha256: sha('{"synthetic":"config"}\n')};
  write('derived/out/build/run.json', JSON.stringify({
    spec,
    [key]: key === 'inputs' ? [{role: 'rig', ...input}] : input,
    outputs: [{path: 'model.json', sha256: sha('{"synthetic":"model"}\n')}],
  }));
  expect(checkDirectionFixtureHashes(fixtureDir)).toBe(2);
  for (const path of ['evidence/config.json', 'derived/out/build/model.json']) {
    const copy = join(tempDir(), 'stamped');
    cpSync(fixtureDir, copy, {recursive: true});
    const bytes = readFileSync(join(copy, path));
    bytes[bytes.length - 1] = 32;
    writeFileSync(join(copy, path), bytes);
    expect(() => checkDirectionFixtureHashes(copy)).toThrow(`hash mismatch for ${path}`);
  }
  write('derived/out/build/run.json', JSON.stringify({spec, outputs: [{...input, path: '../../../../evidence/config.json'}]}));
  expect(() => checkDirectionFixtureHashes(fixtureDir)).toThrow('derived/out/build/run.json.outputs[0]: ../../../../evidence/config.json escapes the fixture');
});
