import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject, type Finding } from '../src/check.ts';
import { correctionCommand } from '../src/correction-writers.ts';
import { checkCorrections } from '../src/corrections.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { directionPostIdentity } from '../src/direction.ts';
import type { JsonObject } from '../src/templates.ts';
import { tempDir } from './helpers.ts';

afterEach(() => setSystemTime());
function setup(at = '2026-11-06T10:00:00Z') {
  const dir = tempDir();
  cpSync(join(import.meta.dir, '../templates/example-direction'), dir, { recursive: true });
  setSystemTime(new Date(at));
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  return { dir, load };
}
function capture(dir: string, n: number, model?: string) {
  return correctionCommand(['record', dir, '--id', 'described-frame', '--path', 'described', '--stage', 'direction-review',
    '--version', String(n), '--by', 'user', '--verbatim-file', join(dir, 'words.txt'), '--json',
    ...(model ? ['--model-file', model] : [])]);
}
function findings(dir: string, project: JsonObject) {
  const ctx = { dir, project, refusals: [] as Finding[], warnings: [] as Finding[] };
  checkCorrections(ctx);
  return ctx;
}
function refusal(dir: string, code: string, run: () => unknown) {
  const before = readFileSync(join(dir, 'project.json'));
  const files = readdirSync(dir, { recursive: true });
  for (let retry = 0; retry < 2; retry++) {
    expect(run).toThrow(expect.objectContaining({ code, exitCode: 1 }));
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(readdirSync(dir, { recursive: true })).toEqual(files);
  }
}

for (const n of [2, 3]) {
  test(`described post v${n} binds the compiled model and exact direction identity`, () => {
    const f = setup();
    const expected = directionPostIdentity(f.dir, f.load(), n);
    const result = capture(f.dir, n, (expected.model as JsonObject).path as string);
    expect(result.exit).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.schema).toBe('rig-create/correction@2');
    expect(JSON.stringify(record.on)).toBe(JSON.stringify(expected));
    expect(record.verbatim).toBe(readFileSync(join(f.dir, 'words.txt'), 'utf8'));
    expect(findings(f.dir, f.load()).refusals).toEqual([]);
  });
  test(`described post v${n} refuses direction JSON as model without publishing`, () => {
    const f = setup();
    refusal(f.dir, 'CORRECTION_SOURCE', () => capture(f.dir, n, `evidence/direction/v${n}.json`));
  });
}

test('described direction derives its model when the optional model flag is absent', () => {
  const f = setup();
  const expected = directionPostIdentity(f.dir, f.load(), 3);
  expect(JSON.parse(capture(f.dir, 3).stdout).on).toEqual(expected);
});
for (const field of ['model', 'direction']) {
  test(`check refuses a one-byte edit to the described ${field} hash`, () => {
    const f = setup();
    capture(f.dir, 3);
    const p = f.load();
    const record = (p.corrections as JsonObject[]).at(-1)!;
    const binding = (record.on as JsonObject)[field] as JsonObject;
    const hash = binding.sha256 as string;
    binding.sha256 = (hash[0] === '0' ? '1' : '0') + hash.slice(1);
    writeFileSync(join(f.dir, 'project.json'), JSON.stringify(p));
    expect(checkProject(f.dir).refusals.map(f => f.code)).toContain('DIRECTION_CORRECTION_OUTCOME');
  });
}

test('described direction resolves to a later authored direction on the same compiled rig', () => {
  const f = setup();
  capture(f.dir, 3);
  setSystemTime(new Date('2026-11-06T10:10:00Z'));
  // The retained input is a different direction than post v3, on the same rig.
  directionCommand(['write', '4', f.dir, '--file', 'evidence/input.json', '--rig', '1']);
  setSystemTime(new Date('2026-11-06T10:20:00Z'));
  const args = ['resolve', 'described-frame', f.dir, '--version', '4', '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt')];
  refusal(f.dir, 'CORRECTION_SOURCE', () => correctionCommand([...args, '--model-file', 'evidence/direction/v4.json']));
  expect(correctionCommand(args).exit).toBe(0);
  expect(findings(f.dir, f.load()).refusals).toEqual([]);
  const record = (f.load().corrections as JsonObject[]).at(-1)!;
  expect(record.outcome).toEqual(directionPostIdentity(f.dir, f.load(), 4));
  expect((record.on as JsonObject).model).toEqual((record.outcome as JsonObject).model);
  expect((record.on as JsonObject).direction).not.toEqual((record.outcome as JsonObject).direction);
  for (const field of ['model', 'direction']) {
    const p = f.load();
    const outcome = (p.corrections as JsonObject[]).at(-1)!.outcome as JsonObject;
    const binding = outcome[field] as JsonObject;
    const hash = binding.sha256 as string;
    binding.sha256 = (hash[0] === '0' ? '1' : '0') + hash.slice(1);
    expect(findings(f.dir, p).refusals.map(f => f.code)).toContain('DIRECTION_CORRECTION_OUTCOME');
  }
});

test('a later post with unchanged direction cannot close a described request', () => {
  const f = setup();
  capture(f.dir, 2);
  setSystemTime(new Date('2026-11-06T10:10:00Z'));
  directionCommand(['write', '4', f.dir, '--file', 'evidence/input.json', '--rig', '1']);
  setSystemTime(new Date('2026-11-06T10:20:00Z'));
  refusal(f.dir, 'CORRECTION_OUTCOME', () => correctionCommand(['resolve', 'described-frame', f.dir,
    '--version', '4', '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt')]));
});

for (const at of ['2026-11-05T23:59:59Z', '2026-11-06T00:00:00Z']) {
  test(`old-schema direction description is dated by its original capture at ${at}`, () => {
    const f = setup(at);
    capture(f.dir, 3);
    const p = f.load();
    const record = (p.corrections as JsonObject[]).at(-1)!;
    // Downgrade only after the public writer has bound the honest source.
    record.schema = 'rig-create/correction@1';
    const on = record.on as JsonObject;
    on.model = on.direction!;
    delete on.direction;
    const ctx = findings(f.dir, p);
    if (at.startsWith('2026-11-05')) {
      expect(ctx.refusals).toEqual([]);
      expect(ctx.warnings.map(w => w.code)).toEqual(['DESCRIBED_DIRECTION_LEGACY', 'CORRECTION_OPEN']);
    } else expect(ctx.refusals.map(f => f.code)).toEqual(['DESCRIBED_DIRECTION_REQUIRED']);
  });
}
