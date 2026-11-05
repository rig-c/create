import { expect, setSystemTime, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject, type CheckReport } from '../src/check.ts';
import { interviewAnswerCommand, interviewOptionsCommand } from '../src/choice-writers.ts';
import { sha256 } from '../src/choices.ts';
import { interviewCommand } from '../src/interview.ts';
import { INVARIANTS_SPEC, translateInvariants } from '../src/invariants.ts';
import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, waypoint } from './fixtures.ts';
import { CLI, tempDir } from './helpers.ts';

/** Shared unchanged by the normal example and disabled report-shape control. */
function expectExampleShape(report: CheckReport): void {
  expect(report.ok).toBe(true);
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(report.invariants?.spec).toBe(INVARIANTS_SPEC);
  expect(report.invariants?.entries).toHaveLength(0);
  expect(report.invariants?.gaps).toHaveLength(49);
}

test('filled example check exposes 0 entries and 49 gaps with no findings', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const bytes = readFileSync(join(dir, 'project.json'));
  const report = checkProject(dir);
  expectExampleShape(report);
  expect(() => expectExampleShape({ ...report, invariants: null })).toThrow();
  expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
});

test('spawned piped CLI drains the filled example JSON beyond 64 KiB', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const expected = Buffer.from(`${interviewCommand(['--check', dir, '--json']).stdout}\n`);
  expect(expected.byteLength).toBeGreaterThan(64 * 1024);
  // subprocess.PIPE exercises the OS pipe that exposed truncation; Bun's direct
  // spawn capture also read all bytes from the broken immediate-exit control.
  const pipe = [
    'import subprocess, sys',
    'result = subprocess.run(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.PIPE)',
    'sys.stdout.buffer.write(result.stdout)',
    'sys.stderr.buffer.write(result.stderr)',
    'sys.exit(result.returncode)',
  ].join('\n');
  const result = Bun.spawnSync(['python3', '-c', pipe, process.execPath, CLI, 'interview', '--check', dir, '--json'], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.byteLength).toBe(0);
  // Also identifies an exact-prefix truncation in the disabled immediate-exit control.
  expect(result.stdout.equals(expected.subarray(0, result.stdout.byteLength))).toBe(true);
  expect(result.stdout.byteLength).toBe(expected.byteLength);
  expectExampleShape(JSON.parse(result.stdout.toString()) as CheckReport);
  expect(result.stdout).toEqual(expected);
});

test.each(['{', 'null', '[]', '{}', '{"schema":"rig-create/project@0","stage":"unknown"}'])('malformed project %s returns null invariants', bytes => {
  const dir = tempDir();
  writeFileSync(join(dir, 'project.json'), bytes);
  const report = checkProject(dir);
  expect(report.ok).toBe(false);
  expect(report.invariants).toBeNull();
  expect(report.refusals[0]?.code).toBe(bytes === '{}' ? 'SCHEMA_UNKNOWN' : bytes.includes('unknown') ? 'STAGE_UNKNOWN' : 'PROJECT_JSON_INVALID');
});

test('missing project returns null invariants', () => {
  const report = checkProject(tempDir());
  expect(report.invariants).toBeNull();
  expect(report.refusals.map(f => f.code)).toEqual(['PROJECT_JSON_MISSING']);
});

test('JSON and text interview reports expose translation without calling it a rig check', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const json = interviewCommand(['--check', dir, '--json']);
  expect(json.exit).toBe(0);
  expectExampleShape(JSON.parse(json.stdout) as CheckReport);
  const text = interviewCommand(['--check', dir]);
  expect(text.exit).toBe(0);
  expect(text.stdout.split('\n').filter(line => line.startsWith('invariants:'))).toEqual([
    'invariants: 0 entries, 49 gaps (translated from the guide; not a rig check)',
  ]);
  expect(interviewCommand(['--check', tempDir()]).stdout).not.toContain('invariants:');
});

test('candidate translation uses the supplied record without rereading or writing the disk guide', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const bytes = readFileSync(join(dir, 'project.json'));
  const candidate: JsonObject = JSON.parse(bytes.toString());
  obj(waypoint(candidate, 'motion').guide).verbatim = 'A new exact candidate sentence.';
  const report = checkProject(dir, candidate);
  expect(report.invariants).toEqual(translateInvariants(candidate));
  expect(report.invariants).not.toEqual(checkProject(dir).invariants);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
});

test('actual answer writer changes the next derived report, with the previous report preserved', () => {
  try {
    const dir = fixture(p => {
      p.stage = 'rigging-interview'; p.versions = [];
      p.signoffs = arr(p.signoffs).filter(s => stageIndex(String(obj(s).stage)) < stageIndex('rigging-interview'));
      for (const step of arr(obj(p.plan).steps).map(obj)) if (!['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
      for (const item of arr(obj(obj(p.interview).post).items).map(obj)) item.guide = null;
    }, 'example-project.json');
    const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const before = checkProject(dir);
    expect(before.ok).toBe(true);
    expect(before.invariants?.entries).toEqual([]);
    const snapshot = JSON.stringify(before.invariants);
    const binding = obj(obj(obj(waypoint(load(), 'motion').guide).choice).set);
    const set: JsonObject = JSON.parse(readFileSync(join(dir, String(binding.path)), 'utf8'));
    set.id = 'derived-invariants-motion'; set.drafted_at = '2026-11-11T11:20:00Z';
    const setPath = 'evidence/interview/derived-invariants-motion.json';
    const bytes = JSON.stringify(set);
    writeFileSync(join(dir, setPath), bytes);
    writeFileSync(join(dir, 'other.txt'), 'Allow a deliberate page fold.');
    writeFileSync(join(dir, 'fragment.json'), JSON.stringify({ deformMayFold: [{ slot: 'page', why: 'deliberate fold' }] }));
    setSystemTime(new Date('2026-11-11T11:21:00Z'));
    interviewOptionsCommand(['motion', dir, '--file', setPath]);
    interviewAnswerCommand(['motion', dir, '--set', setPath, '--sha256', sha256(Buffer.from(bytes)), '--by', 'user',
      ...arr(set.asks).flatMap(a => ['--pick', `${String(obj(a).id)}=${obj(a).id === 'tracks' ? 'other' : 'keep'}`]),
      '--other', `tracks=${join(dir, 'other.txt')}`, '--other-fragment', `tracks=${join(dir, 'fragment.json')}`]);
    const after = checkProject(dir);
    expect(after.ok).toBe(true); expect(after.refusals).toEqual([]); expect(after.warnings).toEqual([]);
    expect(after.invariants?.entries.map(e => e.invariant)).toEqual([{ deformMayFold: [{ slot: 'page', why: 'deliberate fold' }] }]);
    expect(after.invariants).toEqual(translateInvariants(load()));
    expect(after.invariants).not.toEqual(before.invariants);
    expect(JSON.stringify(before.invariants)).toBe(snapshot);
    expect(load()).not.toHaveProperty('invariants');
  } finally { setSystemTime(); }
});
