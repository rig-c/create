/** Synthetic values in review's published applied/2 serializer shape, not producer measurements. */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCorrections, correctionHash } from '../src/corrections.ts';
import type { JsonObject } from '../src/templates.ts';
import { correctionFixture } from './correction-fixture.ts';

const roots: string[] = [];
afterEach(() => {
  setSystemTime();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(change: (applied: JsonObject) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'correction-applied-'));
  roots.push(dir);
  correctionFixture(dir, 'rig');
  const file = join(dir, 'evidence/feedback.json');
  const session = JSON.parse(readFileSync(file, 'utf8'));
  const original = session.feedback[0].context.applied;
  // review src/applied-context.ts: applied/2 exact key list with stageInputHash present.
  const applied: JsonObject = {
    stageInputHash: 'a'.repeat(64), buildId: original.buildId, check: original.check,
    compiler: original.compiler, configHash: original.configHash, diff: original.diff,
    line: original.line, modelHash: original.modelHash, patch: original.patch,
    patchSha256: original.patchSha256, producer: original.producer, schema: original.schema,
  };
  change(applied);
  session.feedback[0].context.applied = applied;
  writeFileSync(file, JSON.stringify(session, null, 2) + '\n');
  const projectFile = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(projectFile, 'utf8'));
  project.versions[1].review_origin.applied = applied;
  project.versions[1].review_origin.feedback.sha256 = correctionHash(readFileSync(file));
  writeFileSync(projectFile, JSON.stringify(project, null, 2) + '\n');
  return dir;
}
function command(dir: string, action: 'record' | 'resolve') {
  const args = action === 'record'
    ? ['record', dir, '--id', 'fix', '--path', 'made', '--stage', 'rig-review', '--by', 'user', '--version', '1', '--feedback-file', 'evidence/feedback.json', '--item', 'synthetic-apply']
    : ['resolve', 'fix', dir, '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt'), '--version', '2'];
  const clock = join(dir, 'clock.ts');
  const at = action === 'record' ? '2026-11-04T09:10:00Z' : '2026-11-04T10:00:00Z';
  writeFileSync(clock, `import { setSystemTime } from 'bun:test'; setSystemTime(new Date('${at}'));`);
  setSystemTime(new Date(at));
  return Bun.spawnSync([process.execPath, '--preload', clock, 'src/cli.ts', 'correction', ...args], { cwd: process.cwd() });
}
function refused(dir: string, action: 'record' | 'resolve', code: string) {
  const before = readFileSync(join(dir, 'project.json'));
  const result = command(dir, action);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(code);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}
for (const field of ['stageInputHash', 'check.source']) {
  test(`published ${field} records and resolves through CLI`, () => {
    const dir = fixture(applied => {
      if (field === 'check.source') {
        delete applied.stageInputHash;
        (applied.check as JsonObject).source = 'check';
      }
    });
    const record = command(dir, 'record');
    console.log(`${field} record exit=${record.exitCode}`);
    expect(record.exitCode).toBe(0);
    const resolve = command(dir, 'resolve');
    console.log(`${field} resolve exit=${resolve.exitCode} ${resolve.stderr.toString()}`);
    expect(resolve.exitCode).toBe(0);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const ctx = { dir, project, refusals: [], warnings: [] };
    checkCorrections(ctx);
    expect(ctx).toMatchObject({ refusals: [], warnings: [] });
  });
}
for (const value of [null, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 7]) {
  test(`malformed stageInputHash ${JSON.stringify(value)} refuses capture`, () => {
    const dir = fixture(applied => { applied.stageInputHash = value; });
    refused(dir, 'record', 'CORRECTION_APPLIED_INVALID');
  });
}
test('unknown applied field refuses capture', () => {
  const dir = fixture(applied => { delete applied.stageInputHash; applied.unknown = true; });
  refused(dir, 'record', 'CORRECTION_APPLIED_INVALID');
});
for (const field of ['pass', 'exitCode', 'gate', 'bars', 'line', 'absent', 'source']) {
  test(`source check with invalid ${field} refuses closure`, () => {
    const dir = fixture(applied => {
      delete applied.stageInputHash;
      const summary = applied.check as JsonObject;
      summary.source = 'check';
      if (field === 'absent') applied.check = null;
      else summary[field] = ({ pass: false, exitCode: 1, gate: false, bars: { SYNTHETIC: 'FAIL' }, line: '', source: 'unknown' } as JsonObject)[field]!;
    });
    expect(command(dir, 'record').exitCode).toBe(0);
    refused(dir, 'resolve', 'CORRECTION_APPLIED_INVALID');
  });
}
for (const schema of ['rig-review-applied/4', 'rig-review-applied/5']) {
  test(`${schema} stays unsupported`, () => {
    const dir = fixture(applied => { delete applied.stageInputHash; applied.schema = schema; });
    expect(command(dir, 'record').exitCode).toBe(0);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(project.corrections[0].artifact).toMatchObject({ kind: 'unsupported', operation: 'other', producer_schema: schema });
    refused(dir, 'resolve', 'CORRECTION_UNSUPPORTED_OUTCOME');
  });
}
