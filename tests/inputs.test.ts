import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkInputs, INPUT_WRITER_SINCE } from '../src/inputs.ts';
import type { Ctx } from '../src/check.ts';
import { checkProject, inputCommand, testClock } from './clock.ts';
import { Refusal } from '../src/refusal.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { cli, tempDir } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => { testClock.reset(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project(): string {
  const dir = tempDir(); dirs.push(dir);
  mkdirSync(join(dir, 'inputs'));
  writeFileSync(join(dir, 'project.json'), JSON.stringify(readTemplate('project.json')) + '\n');
  writeFileSync(join(dir, 'inputs/source.bin'), Buffer.from([0, 255, 239, 187, 191, 13, 10, 32]));
  return dir;
}
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
function findings(dir: string, entries: Json): Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'> {
  const ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'> = { dir, project: { inputs: entries }, refusals: [], warnings: [] };
  checkInputs(ctx); return ctx;
}
function refused(dir: string, args: string[], code: string, exit = 1): void {
  const before = readFileSync(join(dir, 'project.json'));
  try { inputCommand(args); throw new Error('expected refusal'); } catch (error) {
    expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code); expect((error as Refusal).exitCode).toBe(exit);
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}
function register(dir: string): JsonObject {
  testClock.set(new Date(INPUT_WRITER_SINCE));
  return JSON.parse(inputCommand(['add', 'inputs/source.bin', dir, '--origin', '  synthetic raw bytes  ', '--json']).stdout) as JsonObject;
}

test('public CLI registers exact raw bytes, origin words and timestamp from the project cwd', () => {
  const dir = project(); const before = load(dir); const bytes = readFileSync(join(dir, 'inputs/source.bin'));
  const result = cli(['input', 'add', './inputs/source.bin', '--origin', '  synthetic raw bytes  ', '--json'], dir, process.env as Record<string, string>);
  expect(result.code).toBe(0); expect(result.stderr).toBe('');
  const entry = JSON.parse(result.stdout) as JsonObject;
  expect(entry).toEqual({ path: 'inputs/source.bin', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, origin: '  synthetic raw bytes  ', at: expect.any(String) });
  expect(Number.isFinite(Date.parse(String(entry.at)))).toBe(true);
  const after = load(dir); expect(after.inputs).toEqual([entry]); delete after.inputs; delete before.inputs; expect(after).toEqual(before);
  expect(findings(dir, [entry]).refusals).toEqual([]); expect(findings(dir, [entry]).warnings).toEqual([]);
  expect(checkProject(dir).refusals.filter(finding => finding.code.startsWith('INPUT_'))).toEqual([]);
  expect(readFileSync(join(dir, 'inputs/source.bin'))).toEqual(bytes); expect(existsSync(join(dir, '.input.lock'))).toBe(false);
});

test('shared reader and writer refuse duplicate aliases and changed registered bytes atomically', () => {
  const dir = project(); const entry = register(dir);
  refused(dir, ['add', 'inputs/../inputs/source.bin', dir, '--origin', 'again'], 'INPUT_PATH_DUPLICATE');
  expect(findings(dir, [entry, { ...entry, path: './inputs/source.bin' }]).refusals.map(f => f.code)).toEqual(['INPUT_PATH_DUPLICATE']);
  writeFileSync(join(dir, 'inputs/source.bin'), 'changed');
  refused(dir, ['add', 'inputs/source.bin', dir, '--origin', 'again'], 'INPUT_FILE_CHANGED');
  expect(findings(dir, [entry]).refusals.map(f => f.code)).toEqual(['INPUT_FILE_CHANGED']);
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('INPUT_FILE_CHANGED');
  writeFileSync(join(dir, 'inputs/replacement.bin'), 'changed');
  refused(dir, ['add', 'inputs/replacement.bin', dir, '--origin', 'replacement'], 'INPUT_FILE_CHANGED');
});

test('retaining the original permits changed content only at a new name', () => {
  const dir = project(); const original = readFileSync(join(dir, 'inputs/source.bin')); const entry = register(dir);
  writeFileSync(join(dir, 'inputs/replacement.bin'), 'new bytes');
  inputCommand(['add', 'inputs/replacement.bin', dir, '--origin', 'changed source under a new name']);
  expect((load(dir).inputs as Json[])[0]).toEqual(entry); expect(load(dir).inputs).toHaveLength(2);
  expect(readFileSync(join(dir, 'inputs/source.bin'))).toEqual(original);
});

for (const name of ['../outside.bin', '/outside.bin', 'project.json', '.', '.input.lock']) {
  test(`refuses invalid contained source name ${name} before writing`, () => {
    const dir = project(); refused(dir, ['add', name, dir, '--origin', 'synthetic'], 'INPUT_PATH_INVALID');
  });
}
for (const name of ['missing.bin', 'inputs']) {
  test(`refuses absent or non-file source ${name} before writing`, () => {
    const dir = project(); refused(dir, ['add', name, dir, '--origin', 'synthetic'], 'INPUT_FILE_UNREADABLE');
  });
}

test('escaping symlink and project.json aliases refuse through writer and checker', () => {
  const dir = project(); const outside = tempDir(); dirs.push(outside); writeFileSync(join(outside, 'source.bin'), 'outside');
  for (const [name, target] of [['escape.bin', join(outside, 'source.bin')], ['record.bin', join(dir, 'project.json')]]) {
    symlinkSync(target!, join(dir, name!));
    refused(dir, ['add', name!, dir, '--origin', 'synthetic'], 'INPUT_PATH_INVALID');
    const entry = { path: name!, sha256: '0'.repeat(64), bytes: 0, origin: 'synthetic', at: INPUT_WRITER_SINCE };
    expect(findings(dir, [entry]).refusals.map(f => f.code)).toEqual(['INPUT_PATH_INVALID']);
  }
});

test('missing retained file and byte-count-only drift are checked by the shared validator', () => {
  const dir = project(); const entry = register(dir);
  expect(findings(dir, [{ ...entry, bytes: Number(entry.bytes) + 1 }]).refusals.map(f => f.code)).toEqual(['INPUT_FILE_CHANGED']);
  rmSync(join(dir, 'inputs/source.bin'));
  expect(findings(dir, [entry]).refusals.map(f => f.code)).toEqual(['INPUT_FILE_UNREADABLE']);
});

for (const at of ['2026-11-07T23:59:59.999Z', null, 'unreadable']) {
  test(`legacy metadata omission WARNs with entry path and remedy, at ${at}`, () => {
    const dir = project(); const entry: JsonObject = { path: 'inputs/historical.bin', at };
    const report = findings(dir, [entry]); expect(report.refusals).toEqual([]);
    expect(report.warnings).toEqual([expect.objectContaining({ code: 'INPUT_WRITER_MISSING', path: 'inputs[0]', message: expect.stringContaining('input add --origin') })]);
    expect(report.project.inputs).toEqual([entry]);
  });
}

test('metadata at the cutoff refuses every incomplete field through the normal checker', () => {
  const dir = project(); const entry = register(dir);
  const edits: JsonObject[] = [{ path: '' }, { sha256: 'bad' }, { bytes: -1 }, { bytes: 0.5 }, { origin: ' ' }];
  for (const edit of edits) {
    const entries = [{ ...entry, ...edit }];
    expect(findings(dir, entries).refusals.map(f => f.code)).toEqual(['INPUT_WRITER_MISSING']);
    const candidate = load(dir); candidate.inputs = entries;
    expect(checkProject(dir, candidate).refusals.map(f => f.code)).toContain('INPUT_WRITER_MISSING');
  }
  const historical = { ...entry }; delete historical.at;
  expect(findings(dir, [historical]).warnings.map(f => f.code)).toEqual(['INPUT_WRITER_MISSING']);
});

test('invalid input array and a held writer lock preserve project bytes', () => {
  const dir = project(); const record = load(dir); record.inputs = {}; writeFileSync(join(dir, 'project.json'), JSON.stringify(record));
  expect(findings(dir, {}).refusals.map(f => f.code)).toEqual(['INPUTS_INVALID']);
  refused(dir, ['add', 'inputs/source.bin', dir, '--origin', 'synthetic'], 'INPUTS_INVALID');
  writeFileSync(join(dir, '.input.lock'), 'another writer');
  refused(dir, ['add', 'inputs/source.bin', dir, '--origin', 'synthetic'], 'INPUT_SOURCE_CHANGED');
  expect(readFileSync(join(dir, '.input.lock'), 'utf8')).toBe('another writer');
});

for (const args of [[], ['list'], ['add'], ['add', 'source.bin'], ['add', 'source.bin', '--origin'], ['add', 'source.bin', '--origin', ' '], ['add', 'a', 'b', 'c', '--origin', 'words'], ['add', 'a', '--origin', 'one', '--origin', 'two'], ['add', 'a', '--unknown']]) {
  test(`usage refusal is byte-identical for ${JSON.stringify(args)}`, () => { const dir = project(); refused(dir, args, 'INPUT_USAGE', 2); });
}


test('project hard links and aliases to the staging lock cannot become sources', () => {
  const dir = project();
  linkSync(join(dir, 'project.json'), join(dir, 'inputs/record.json'));
  symlinkSync(join(dir, '.input.lock'), join(dir, 'inputs/staged.json'));
  for (const name of ['inputs/record.json', 'inputs/staged.json']) {
    refused(dir, ['add', name, dir, '--origin', 'synthetic'], 'INPUT_PATH_INVALID');
  }
});

test('source drift during staging refuses before publishing and cleans its lock', () => {
  const dir = project(); const originalWrite = fs.writeFileSync;
  const staging = spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    originalWrite(...args);
    if (typeof args[0] === 'number') originalWrite(join(dir, 'inputs/source.bin'), 'concurrent replacement');
  });
  try { refused(dir, ['add', 'inputs/source.bin', dir, '--origin', 'synthetic'], 'INPUT_SOURCE_CHANGED'); }
  finally { staging.mockRestore(); }
  expect(existsSync(join(dir, '.input.lock'))).toBe(false);
});

test('a failed staged write leaves the original project bytes intact', () => {
  const dir = project(); const originalWrite = fs.writeFileSync;
  const staging = spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === 'number') throw new Error('synthetic storage failure');
    originalWrite(...args);
  });
  try { refused(dir, ['add', 'inputs/source.bin', dir, '--origin', 'synthetic'], 'INPUT_WRITE_FAILED'); }
  finally { staging.mockRestore(); }
  expect(existsSync(join(dir, '.input.lock'))).toBe(false);
});


test('atomic publication retains the original project permissions', () => {
  const dir = project(); chmodSync(join(dir, 'project.json'), 0o600);
  register(dir);
  expect(statSync(join(dir, 'project.json')).mode & 0o777).toBe(0o600);
});
