import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { collectBarAmendments, effectiveBar } from '../src/plan-bar-amendments.ts';
import { Refusal } from '../src/refusal.ts';
import { stepHash } from '../src/step-hash.ts';
import { appearanceBarWarnings, type Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, retimeFixture, step } from './fixtures.ts';
import { checkProject, planCommand, stepStatusCommand, testClock } from './clock.ts';
import { clockedCli } from './helpers.ts';

const NOW = Date.parse('2026-11-20T00:00:00Z');
const read = (dir: string): JsonObject => JSON.parse(fs.readFileSync(join(dir, 'project.json'), 'utf8'));
afterEach(() => testClock.reset());
function project(): string {
  testClock.set(NOW);
  return fixture(p => {
    p.stage = 'parts'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 2);
    retimeFixture(p, Date.parse('2026-11-16T00:00:00Z'));
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
}
function args(dir: string): string[] {
  const files = ['reason.txt', 'quote.txt', 'bar.txt'].map(name => join(dir, name));
  ['\uFEFFUse the registered synthetic source.\r\n', 'Keep the frozen outputs.\n', 'Every synthetic part resolves to its registered source.\r\n']
    .forEach((text, index) => fs.writeFileSync(files[index]!, text));
  return ['bar-amend', 'assemble', dir, '--by', 'operator', '--reason-file', files[0]!, '--quote-file', files[1]!, '--bar-file', files[2]!];
}
function unchanged(dir: string, code: string, run: () => unknown): void {
  const before = fs.readFileSync(join(dir, 'project.json'));
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code);
  expect(fs.readFileSync(join(dir, 'project.json'))).toEqual(before);
}
function journal(): JsonObject {
  const original = { id: 'geometry', phase: 'rig', bar: 'The original numeric bar.', status: 'pending', checkpoint: null };
  return { plan: { steps: [original], bar_amendments: [{ schema: 'rig-create/bar-amendment@1', step: structuredClone(original),
    sha256: stepHash(original), generation: 0, amended_bar: 'The amended source-bound bar.', by: 'operator',
    at: '2026-11-19T00:00:00Z', reason: 'Use the registered source.', verbatim: 'Keep the existing outputs.' }] } };
}

test('public bar-amend preserves all authored steps, approvals and exact policy words; replay is filesystem-identical', () => {
  const dir = project(); const command = args(dir); const before = read(dir);
  const result = Bun.spawnSync([process.execPath, ...clockedCli(), 'plan', ...command], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.stderr.toString()).toBe(''); expect(result.exitCode).toBe(0);
  const after = read(dir); const plan = obj(after.plan);
  expect(plan.steps).toEqual(obj(before.plan).steps); expect(after.signoffs).toEqual(before.signoffs);
  const original = step(before, 'assemble');
  expect(stepHash(step(after, 'assemble'))).toBe(stepHash(original));
  const entry = obj(arr(plan.bar_amendments)[0]);
  expect(entry).toMatchObject({ schema: 'rig-create/bar-amendment@1', step: original, sha256: stepHash(original), generation: 0,
    reason: '\uFEFFUse the registered synthetic source.\r\n', verbatim: 'Keep the frozen outputs.\n', amended_bar: 'Every synthetic part resolves to its registered source.\r\n' });
  const withoutJournal = structuredClone(after); delete obj(withoutJournal.plan).bar_amendments;
  expect(withoutJournal).toEqual(before);
  const file = join(dir, 'project.json'); const bytes = fs.readFileSync(file); const stat = fs.statSync(file, { bigint: true });
  expect(planCommand(command).exit).toBe(0);
  const replayStat = fs.statSync(file, { bigint: true });
  expect(fs.readFileSync(file)).toEqual(bytes);
  expect([replayStat.ino, replayStat.mtimeNs, replayStat.ctimeNs]).toEqual([stat.ino, stat.mtimeNs, stat.ctimeNs]);
  expect(effectiveBar(after, step(after, 'assemble'), NOW)).toBe(entry.amended_bar as string);
  expect(checkProject(dir).refusals).toEqual(checkProject(dir, before).refusals);
  unchanged(dir, 'PLAN_STEP_SIGNED', () => planCommand(['revise', 'assemble', dir, '--by', 'operator', '--bar', 'Unsigned replacement.']));
});

test('bar amendments bind hash and replacement generation without inheriting a restored identical bar', () => {
  const p = journal(); const plan = obj(p.plan); const original = obj(arr(plan.steps)[0]);
  expect(effectiveBar(p, original, NOW)).toBe('The amended source-bound bar.');
  plan.replaced = [{ step: structuredClone(original), sha256: stepHash(original), action: 'revised', by: 'operator', at: '2026-11-20T00:00:00Z' }];
  expect(collectBarAmendments(p, [], NOW)).toHaveLength(1);
  expect(effectiveBar(p, original, NOW)).toBe(original.bar as string);
  original.bar = 'A later authored bar.';
  expect(effectiveBar(p, original, NOW)).toBe('A later authored bar.');
});

test.each([
  (entry: JsonObject) => { entry.sha256 = '0'.repeat(64); },
  (entry: JsonObject) => { entry.schema = 'other'; },
  (entry: JsonObject) => { entry.generation = 1; },
  (entry: JsonObject) => { entry.generation = -1; },
  (entry: JsonObject) => { entry.amended_bar = ' '; },
  (entry: JsonObject) => { entry.by = ''; },
  (entry: JsonObject) => { entry.reason = ''; },
  (entry: JsonObject) => { entry.verbatim = ''; },
  (entry: JsonObject) => { entry.at = '2026-11-21T00:00:00Z'; },
  (entry: JsonObject) => { entry.at = 'invalid'; },
  (entry: JsonObject) => { entry.extra = true; },
])('malformed or future policy grants no effective bar', edit => {
  const p = journal(); const plan = obj(p.plan); const original = obj(arr(plan.steps)[0]);
  edit(obj(arr(plan.bar_amendments)[0])); const findings: Finding[] = [];
  expect(collectBarAmendments(p, findings, NOW)).toEqual([]);
  expect(findings.map(f => f.code)).toEqual(['BAR_AMENDMENT_INVALID']);
  expect(effectiveBar(p, original, NOW)).toBe(original.bar as string);
});

test('one invalid entry poisons the whole journal; optional absence does not alter legacy bars', () => {
  const p = journal(); const plan = obj(p.plan); const original = obj(arr(plan.steps)[0]);
  arr(plan.bar_amendments).push(null);
  expect(collectBarAmendments(p, [], NOW)).toEqual([]);
  expect(effectiveBar(p, original, NOW)).toBe(original.bar as string);
  delete plan.bar_amendments;
  expect(collectBarAmendments(p, [], NOW)).toEqual([]);
  expect(effectiveBar(p, original, NOW)).toBe(original.bar as string);
});

test('duplicate identities and reversed journal dates refuse instead of partially applying', () => {
  const p = journal(); const plan = obj(p.plan); const first = obj(arr(plan.bar_amendments)[0]);
  arr(plan.bar_amendments).push(structuredClone(first));
  expect(collectBarAmendments(p, [], NOW)).toEqual([]);
  const second = structuredClone(first); obj(second.step).id = 'other'; second.sha256 = stepHash(obj(second.step)); second.at = '2026-11-18T00:00:00Z';
  arr(plan.steps).push(second.step!); plan.bar_amendments = [first, second];
  expect(collectBarAmendments(p, [], NOW)).toEqual([]);
});

test('missing inputs, conflicting flags, wrong scope, locks and conflicting replay leave bytes unchanged', () => {
  const dir = project(); const command = args(dir);
  unchanged(dir, 'PLAN_OPTION_INVALID', () => planCommand(command.slice(0, -2)));
  unchanged(dir, 'PLAN_OPTION_INVALID', () => planCommand([...command, '--bar', 'Authored edit.']));
  unchanged(dir, 'PLAN_OPTION_INVALID', () => planCommand(command.filter(value => value !== '--by' && value !== 'operator')));
  unchanged(dir, 'BAR_AMENDMENT_SCOPE', () => planCommand(command.map(value => value === 'assemble' ? 'bones' : value)));
  fs.writeFileSync(join(dir, 'bar.txt'), ' ');
  unchanged(dir, 'PLAN_OPTION_INVALID', () => planCommand(command)); args(dir);
  fs.writeFileSync(join(dir, '.plan.lock'), 'another writer');
  unchanged(dir, 'PLAN_WRITE_CONFLICT', () => planCommand(command)); fs.unlinkSync(join(dir, '.plan.lock'));
  expect(planCommand(command).exit).toBe(0);
  fs.writeFileSync(join(dir, 'bar.txt'), 'Different policy.');
  unchanged(dir, 'BAR_AMENDMENT_CONFLICT', () => planCommand(command));
  fs.writeFileSync(join(dir, 'bar.txt'), 'Every synthetic part resolves to its registered source.\r\n');
  fs.writeFileSync(join(dir, 'quote.txt'), 'Different words.');
  unchanged(dir, 'BAR_AMENDMENT_CONFLICT', () => planCommand(command));
});

test('input drift while acquiring the plan lock refuses and releases only its owned lock', () => {
  const dir = project(); const command = args(dir); const originalOpen = fs.openSync;
  const intercept = spyOn(fs, 'openSync').mockImplementation((...parameters: Parameters<typeof fs.openSync>) => {
    const descriptor = originalOpen(...parameters);
    if (parameters[0] === join(dir, '.plan.lock')) fs.writeFileSync(join(dir, 'bar.txt'), 'Concurrent input replacement.');
    return descriptor;
  });
  try { unchanged(dir, 'PLAN_WRITE_CONFLICT', () => planCommand(command)); }
  finally { intercept.mockRestore(); }
  expect(fs.existsSync(join(dir, '.plan.lock'))).toBe(false);
});

test('native check refuses a malformed or future journal and never substitutes its invalid bar', () => {
  const dir = project(); const command = args(dir);
  expect(planCommand(command).exit).toBe(0);
  const p = read(dir); const entry = obj(arr(obj(p.plan).bar_amendments)[0]);
  entry.at = '2026-11-21T00:00:00Z';
  expect(checkProject(dir, p).refusals.map(f => f.code)).toContain('BAR_AMENDMENT_INVALID');
  expect(effectiveBar(p, step(p, 'assemble'), NOW)).toBe(step(p, 'assemble').bar as string);
  entry.at = '2026-11-19T00:00:00Z'; entry.amended_bar = null;
  expect(checkProject(dir, p).refusals.map(f => f.code)).toContain('BAR_AMENDMENT_INVALID');
});

test('native appearance lint uses only the valid effective bar with unchanged original hash and unrelated bars', () => {
  const p = journal(); const plan = obj(p.plan); const original = obj(arr(plan.steps)[0]);
  original.bar = 'Smooth motion.';
  const entry = obj(arr(plan.bar_amendments)[0]); entry.step = structuredClone(original); entry.sha256 = stepHash(original);
  entry.amended_bar = 'Smooth motion measured at 2 px.';
  plan.steps = [original, { id: 'other', phase: 'rig', bar: 'Smooth motion.', checkpoint: null, status: 'pending' }];
  const hash = stepHash(original);
  expect(appearanceBarWarnings(p, NOW).map(f => f.path)).toEqual(['plan.steps[other].bar']);
  entry.at = '2026-11-21T00:00:00Z';
  expect(appearanceBarWarnings(p, NOW).map(f => f.path)).toEqual(['plan.steps[geometry].bar', 'plan.steps[other].bar']);
  expect(stepHash(original)).toBe(hash);
});

test('bar policy does not waive checkpoints or statuses; normal transitions and withdrawal history stay independent', () => {
  const dir = project(); const command = args(dir);
  const reason = join(dir, 'reason.txt'); const quote = join(dir, 'quote.txt');
  expect(planCommand(['checkpoint-withdraw', 'assemble', dir, '--by', 'operator', '--reason-file', reason, '--quote-file', quote]).exit).toBe(0);
  const before = read(dir);
  expect(planCommand(command).exit).toBe(0);
  expect(obj(read(dir).plan).checkpoint_withdrawals).toEqual(obj(before.plan).checkpoint_withdrawals);
  for (const status of ['in-progress', 'at-checkpoint', 'done']) {
    expect(stepStatusCommand(['assemble', status, dir, '--by', 'operator']).exit).toBe(0);
    expect(checkProject(dir).refusals).toEqual([]);
  }
  expect(read(dir).signoffs).toEqual(before.signoffs);
  expect(effectiveBar(read(dir), step(read(dir), 'assemble'), NOW)).toBe('Every synthetic part resolves to its registered source.\r\n');
  // Replay remains an immutable receipt after normal completion, not a new amendment.
  expect(planCommand(command).exit).toBe(0);
  const other = project(); const otherArgs = args(other);
  for (const status of ['in-progress', 'at-checkpoint']) expect(stepStatusCommand(['assemble', status, other, '--by', 'operator']).exit).toBe(0);
  expect(planCommand(otherArgs).exit).toBe(0);
  unchanged(other, 'CHECKPOINT_UNSIGNED', () => stepStatusCommand(['assemble', 'done', other, '--by', 'operator']));
});

test('new amendment refuses completed history without reopening the authored signature guard', () => {
  const dir = project(); const command = args(dir); const p = read(dir);
  step(p, 'assemble').status_history = [{ from_status: 'at-checkpoint', status: 'done', by: 'operator', at: '2026-11-18T00:00:00Z', checkpoint_required: true, signoff: null }];
  fs.writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  unchanged(dir, 'BAR_AMENDMENT_SCOPE', () => planCommand(command));
});

test('bar input drift after staging refuses without committing the temporary candidate', () => {
  const dir = project(); const command = args(dir); const originalWrite = fs.writeFileSync;
  const intercept = spyOn(fs, 'writeFileSync').mockImplementation((...parameters: Parameters<typeof fs.writeFileSync>) => {
    originalWrite(...parameters);
    if (typeof parameters[0] === 'string' && parameters[0].includes('.plan-') && parameters[0].endsWith('.tmp')) {
      originalWrite(join(dir, 'bar.txt'), 'Concurrent replacement before commit.');
    }
  });
  try { unchanged(dir, 'PLAN_WRITE_CONFLICT', () => planCommand(command)); }
  finally { intercept.mockRestore(); }
  expect(fs.readdirSync(dir).filter(name => name.startsWith('.plan'))).toEqual([]);
});
