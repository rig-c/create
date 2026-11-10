import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { FIX_LEDGER_REPORT_SPEC, FIX_LEDGER_SINCE, ledgerCommand } from '../src/fix-ledger.ts';
import { restartCommand } from '../src/restart.ts';
import { freshProjectRecord } from '../src/init.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { checkProject, draftRigCommand, inputCommand, testClock, TEST_NOW } from './clock.ts';
import { cli, gitEnv, run, tempDir } from './helpers.ts';

afterEach(() => testClock.reset());

const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
let tick = 0;
const step = (): number => { testClock.set(TEST_NOW + 1000 * ++tick); return testClock.now(); };
function words(dir: string, text: string): string { const file = join(dir, `words-${++tick}.txt`); writeFileSync(file, text); return file; }
function refused(dir: string, code: string, action: () => unknown): Refusal {
  const before = readFileSync(join(dir, 'project.json'));
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    return error as Refusal;
  }
  throw new Error(`expected ${code}`);
}

/** Commit `<dir>/project.json` in the repo at `root` (created when absent): restart needs the record clean at HEAD. */
let gitIdentity: Record<string, string> | undefined;
function commit(dir: string, root = dir): void {
  gitIdentity ??= gitEnv({ name: 'Synthetic Owner', email: 'owner@example.com' });
  const git = (...args: string[]): void => { const r = run(['git', ...args], root, gitIdentity!); if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`); };
  if (!existsSync(join(root, '.git'))) git('init', '-q');
  git('add', '--', relative(root, join(dir, 'project.json')));
  git('commit', '-q', '-m', 'record');
}
const restartArgs = (dir: string): string[] => [dir, '--by', 'owner', '--reason-file', words(dir, 'restart')];

/** The filled example: ledger row T1, the draft `example` (parts receipt, no report) and `lantern` (T1 pass). */
const example = (): string => fixture(() => {}, 'example-project.json');
const manifest = (dir: string, id: string): string => sha(readFileSync(join(dir, `derived/drafts/${id}/input/parts.json`)));

/** A labelled draft with the example's producer bytes under derived/drafts/<id>/. */
function copyDraft(dir: string, id: string): void { cpSync(join(dir, 'derived/drafts/example'), join(dir, `derived/drafts/${id}`), { recursive: true }); }
function report(dir: string, id: string, rows: Record<string, string>, build = manifest(dir, id)): string {
  const path = `evidence/fix-ledger/${id}.json`;
  mkdirSync(join(dir, 'evidence/fix-ledger'), { recursive: true });
  writeFileSync(join(dir, path), `${JSON.stringify({ schema: FIX_LEDGER_REPORT_SPEC, build: { dir: `derived/drafts/${id}/out`, manifest_sha256: build }, script_sha256: sha('synthetic'),
    rows: Object.entries(rows).map(([row, result]) => ({ id: row, result, measured: 1, bar: 'synthetic bar', reason: null, extra: true })) })}\n`);
  return path;
}
const draftArgs = (dir: string, id: string, ...extra: string[]): string[] => [id, dir, '--config', `derived/drafts/${id}/config.json`, '--from', `derived/drafts/${id}/out`, '--parts', `derived/drafts/${id}/input`, '--json', ...extra];
const record = (dir: string, id: string, ...extra: string[]): JsonObject => { step(); return JSON.parse(draftRigCommand(draftArgs(dir, id, ...extra)).stdout) as JsonObject; };
const addRow = (dir: string, id: string, note = 'versions[v3].verdicts[0]', quote = 'The beam sweeps right at the start.'): void => {
  const file = words(dir, quote); step();
  ledgerCommand(['add', id, dir, '--by', 'agent', '--check', `${id}-check`, '--bar', 'synthetic bar', '--note', note, '--verbatim-file', file], testClock.now());
};

test('the filled example carries a ledger row and a draft whose passing report fixes it', () => {
  const dir = example();
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(report.ledger).toEqual([{ draft: 'lantern', fixes: ['T1'], known_regressions: [] }]);
  expect(obj(arr(load(dir).drafts)[1]).fixes_against).toBe('example');
});

test('ledger add quotes a recorded owner note; retire needs a reason; refusals leave project.json byte-identical', () => {
  const dir = example();
  refused(dir, 'FIX_LEDGER_NOTE_UNKNOWN', () => addRow(dir, 'T2', 'versions[v9].verdicts[0]'));
  refused(dir, 'FIX_LEDGER_NOTE_MISMATCH', () => addRow(dir, 'T2', 'versions[v3].verdicts[0]', 'words the owner never said'));
  refused(dir, 'FIX_LEDGER_MALFORMED', () => addRow(dir, 'T1'));
  refused(dir, 'LEDGER_USAGE', () => ledgerCommand(['add', 'T2', dir, '--by', 'agent'], step()));
  addRow(dir, 'T2');
  const row = obj(arr(load(dir).fix_ledger)[1]);
  expect(row).toMatchObject({ id: 'T2', note: { ref: 'versions[v3].verdicts[0]', verbatim: 'The beam sweeps right at the start.' }, by: 'agent', check: 'T2-check', bar: 'synthetic bar' });
  refused(dir, 'LEDGER_ROW_UNKNOWN', () => ledgerCommand(['retire', 'T9', dir, '--by', 'owner', '--reason-file', words(dir, 'gone')], step()));
  refused(dir, 'LEDGER_USAGE', () => ledgerCommand(['retire', 'T2', dir, '--by', 'owner', '--reason-file', words(dir, '  \n')], step()));
  ledgerCommand(['retire', 'T2', dir, '--by', 'owner', '--reason-file', words(dir, 'The beam was cut from the take.')], step());
  expect(obj(obj(arr(load(dir).fix_ledger)[1]).retired)).toMatchObject({ by: 'owner', reason: 'The beam was cut from the take.' });
  refused(dir, 'LEDGER_ROW_RETIRED', () => ledgerCommand(['retire', 'T2', dir, '--by', 'owner', '--reason-file', words(dir, 'again')], step()));
  expect(checkProject(dir).refusals).toEqual([]);
});

test('a draft needs a report covering every live row, for its own build', () => {
  const dir = example(); copyDraft(dir, 'd3');
  refused(dir, 'DRAFT_LEDGER_REPORT_MISSING', () => draftRigCommand(draftArgs(dir, 'd3')));
  refused(dir, 'DRAFT_LEDGER_INCOMPLETE', () => draftRigCommand(draftArgs(dir, 'd3', '--ledger-report', report(dir, 'd3', { other: 'pass' }))));
  refused(dir, 'DRAFT_LEDGER_BUILD_MISMATCH', () => draftRigCommand(draftArgs(dir, 'd3', '--ledger-report', report(dir, 'd3', { T1: 'pass' }, 'a'.repeat(64)))));
  mkdirSync(join(dir, 'scratch'), { recursive: true }); cpSync(join(dir, report(dir, 'd3', { T1: 'pass' })), join(dir, 'scratch/d3.json'));
  refused(dir, 'DRAFT_LEDGER_REPORT_INVALID', () => draftRigCommand(draftArgs(dir, 'd3', '--ledger-report', 'scratch/d3.json')));
  writeFileSync(join(dir, 'evidence/fix-ledger/bad.json'), JSON.stringify({ schema: FIX_LEDGER_REPORT_SPEC, build: { manifest_sha256: manifest(dir, 'd3') }, script_sha256: sha('x'), rows: [{ id: 'T1', result: 'ok' }] }));
  refused(dir, 'DRAFT_LEDGER_REPORT_INVALID', () => draftRigCommand(draftArgs(dir, 'd3', '--ledger-report', 'evidence/fix-ledger/bad.json')));
  const recorded = record(dir, 'd3', '--ledger-report', report(dir, 'd3', { T1: 'pass' }));
  expect(recorded).toMatchObject({ ledger_report: { path: 'evidence/fix-ledger/d3.json', spec: FIX_LEDGER_REPORT_SPEC }, fixes_against: 'example', fixes: ['T1'] });
  expect(checkProject(dir).refusals).toEqual([]);
  writeFileSync(join(dir, 'evidence/fix-ledger/d3.json'), '{}');
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual([['DRAFT_LEDGER_REPORT_INVALID', 'drafts[2].ledger_report']]);
});

test.each(['fail', 'unmeasurable'])('a row the predecessor passed and the new report marks %s is a named regression unless recorded as known', result => {
  const dir = example(); copyDraft(dir, 'd3');
  const path = report(dir, 'd3', { T1: result });
  const refusal = refused(dir, 'DRAFT_LEDGER_REGRESSION', () => draftRigCommand(draftArgs(dir, 'd3', '--ledger-report', path)));
  expect(refusal.message).toContain(`T1 (${result}) passed in lantern`);
  refused(dir, 'DRAFT_RIG_USAGE', () => draftRigCommand(draftArgs(dir, 'd3', '--known-regression', `T1=${words(dir, 'x')}`)));
  const recorded = record(dir, 'd3', '--ledger-report', path, '--known-regression', `T1=${words(dir, 'The lantern rig is rebuilt next; the sway is off for this build.\n')}`);
  expect(recorded.known_regressions).toEqual([{ id: 'T1', reason: 'The lantern rig is rebuilt next; the sway is off for this build.' }]);
  expect(recorded.fixes).toEqual([]);
  const checked = checkProject(dir);
  expect(checked.refusals).toEqual([]);
  expect(checked.ledger).toContainEqual({ draft: 'd3', fixes: [], known_regressions: ['T1'] });
});

test('a known regression stays owed: the next draft passes the row or records it as a known regression again', () => {
  const dir = example(); addRow(dir, 'X');
  copyDraft(dir, 'd1'); record(dir, 'd1', '--ledger-report', report(dir, 'd1', { T1: 'pass', X: 'pass' }));
  copyDraft(dir, 'd2'); record(dir, 'd2', '--ledger-report', report(dir, 'd2', { T1: 'pass', X: 'fail' }), '--known-regression', `X=${words(dir, 'X is rebuilt in the next draft.')}`);
  copyDraft(dir, 'd3');
  const path = report(dir, 'd3', { T1: 'pass', X: 'fail' });
  const refusal = refused(dir, 'DRAFT_LEDGER_REGRESSION', () => draftRigCommand(draftArgs(dir, 'd3', '--ledger-report', path)));
  expect(refusal.message).toContain('X (fail) passed in d2, or are known regressions it still owes');
  expect(record(dir, 'd3', '--ledger-report', path, '--known-regression', `X=${words(dir, 'Still rebuilding X.')}`).known_regressions).toEqual([{ id: 'X', reason: 'Still rebuilding X.' }]);
  copyDraft(dir, 'd4');
  // Passing it clears the debt; fixes count against `example`, the only draft with a parts-review receipt.
  const cleared = record(dir, 'd4', '--ledger-report', report(dir, 'd4', { T1: 'pass', X: 'pass' }));
  expect(cleared.known_regressions).toBeUndefined();
  expect(cleared.fixes).toEqual(['T1', 'X']);
  expect(checkProject(dir).refusals).toEqual([]);
});

test('a known regression must name a row that regressed', () => {
  const dir = example(); copyDraft(dir, 'd3');
  refused(dir, 'DRAFT_LEDGER_MALFORMED', () => draftRigCommand(draftArgs(dir, 'd3', '--ledger-report', report(dir, 'd3', { T1: 'pass' }), '--known-regression', `T1=${words(dir, 'not regressed')}`)));
});

test('fixes count against the last draft a person saw, and a retired row is not covered', () => {
  const dir = example(); addRow(dir, 'T2');
  copyDraft(dir, 'd3');
  expect(record(dir, 'd3', '--ledger-report', report(dir, 'd3', { T1: 'pass', T2: 'pass' }))).toMatchObject({ fixes_against: 'example', fixes: ['T1', 'T2'] });
  copyDraft(dir, 'd4');
  // d3 passed both; only `example` carries a parts-review receipt, so the fixes are counted against it again.
  expect(record(dir, 'd4', '--ledger-report', report(dir, 'd4', { T1: 'pass', T2: 'pass' }))).toMatchObject({ fixes_against: 'example', fixes: ['T1', 'T2'] });
  ledgerCommand(['retire', 'T2', dir, '--by', 'owner', '--reason-file', words(dir, 'The beam was cut.')], step());
  copyDraft(dir, 'd5');
  expect(record(dir, 'd5', '--ledger-report', report(dir, 'd5', { T1: 'pass' }))).toMatchObject({ fixes: ['T1'] });
  const project = load(dir);
  obj(arr(project.drafts)[4]).fixes = ['T2'];
  save(dir, project);
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual([['DRAFT_LEDGER_MALFORMED', 'drafts[4]']]);
});

test('legacy records WARN: no ledger beside drafts, and a draft recorded before the contract date without a report', () => {
  const dir = example();
  const project = load(dir);
  const ledger = project.fix_ledger;
  delete project.fix_ledger;
  save(dir, project);
  expect(checkProject(dir).warnings.map(f => [f.code, f.path])).toEqual([['FIX_LEDGER_MISSING', 'fix_ledger']]);
  project.fix_ledger = ledger!;
  const legacy = structuredClone(obj(arr(project.drafts)[1]));
  for (const key of ['ledger_report', 'fixes', 'fixes_against']) delete legacy[key];
  legacy.id = 'legacy';
  legacy.at = new Date(Date.parse(FIX_LEDGER_SINCE) - 1000).toISOString();
  obj(arr(project.fix_ledger)[0]).at = new Date(Date.parse(FIX_LEDGER_SINCE) - 2000).toISOString();
  project.drafts = [...arr(project.drafts), legacy];
  save(dir, project);
  const checked = checkProject(dir);
  expect(checked.warnings.map(f => [f.code, f.path])).toContainEqual(['DRAFT_LEDGER_REPORT_MISSING', 'drafts[2].ledger_report']);
  // The example's own drafts, recorded after the cut-off and now after an earlier-dated row, are refused; the legacy one WARNs.
  expect(checked.refusals.filter(f => f.path.startsWith('drafts[2]') && f.code.startsWith('DRAFT_LEDGER'))).toEqual([]);
  legacy.at = FIX_LEDGER_SINCE;
  save(dir, project);
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toContainEqual(['DRAFT_LEDGER_REPORT_MISSING', 'drafts[2].ledger_report']);
});

test('restart keeps inputs and every ledger row, appends restarts[], and checks clean', () => {
  const dir = example();
  const declared = load(dir); declared.painting = 'inputs/painting.png';
  declared.same_artwork = { reason: 'A different synthetic rig kind.', at: testClock.iso(), projects: ['first'] };
  save(dir, declared); commit(dir);
  const before = readFileSync(join(dir, 'project.json'));
  const old = load(dir);
  refused(dir, 'SIGNOFF_NOT_HUMAN', () => restartCommand([dir, '--by', 'agent', '--reason-file', words(dir, 'restart')], step()));
  refused(dir, 'RESTART_USAGE', () => restartCommand([dir, '--by', 'owner'], step()));
  restartCommand([dir, '--by', 'owner', '--reason-file', words(dir, 'Restart at v1; delete everything before it.')], step());
  const restarted = load(dir);
  expect(restarted).toMatchObject({ stage: 'interview', versions: [], signoffs: [], name: old.name!, painting: old.painting!, same_artwork: old.same_artwork!, inputs: old.inputs!, fix_ledger: old.fix_ledger! });
  for (const key of ['drafts', 'review_acts', 'advances', 'scenes']) expect(restarted[key]).toBeUndefined();
  expect(obj(restarted.plan).steps).toEqual([]);
  expect(arr(restarted.restarts)).toEqual([{ at: testClock.iso(), by: 'owner', reason: 'Restart at v1; delete everything before it.', previous_record_sha256: sha(before) }]);
  // A restarted record checks the same as a fresh init record: the same codes (its open interview) and 0 warnings.
  const checked = checkProject(dir);
  const fresh = checkProject(dir, freshProjectRecord(String(old.name), testClock.now()));
  expect(checked.refusals.map(f => [f.code, f.path])).toEqual(fresh.refusals.map(f => [f.code, f.path]));
  expect(fresh.refusals.map(f => f.code)).toContain('INTERVIEW_INCOMPLETE');
  expect(checked.warnings).toEqual([]);
  expect(fresh.warnings).toEqual([]);
  const open = checked.refusals;
  // The first draft after a restart has no predecessor, but it covers every live row.
  copyDraft(dir, 'r1');
  refused(dir, 'DRAFT_LEDGER_INCOMPLETE', () => draftRigCommand(draftArgs(dir, 'r1', '--ledger-report', report(dir, 'r1', {}))));
  expect(record(dir, 'r1', '--ledger-report', report(dir, 'r1', { T1: 'fail' }))).toMatchObject({ fixes_against: null, fixes: [] });
  expect(checkProject(dir).refusals).toEqual(open);
});

test('restart refuses before writing: a changed input, a part set without its parts.json or rig, a folder that is not a project', () => {
  const dir = example(); commit(dir);
  writeFileSync(join(dir, 'inputs/painting.png'), 'changed bytes');
  refused(dir, 'RESTART_INPUT_INVALID', () => restartCommand([dir, '--by', 'owner', '--reason-file', words(dir, 'restart')], step()));
  const clean = example();
  const keep = (path: string, bytes = `synthetic ${path}`): void => {
    mkdirSync(dirname(join(clean, path)), { recursive: true }); writeFileSync(join(clean, path), bytes);
    step(); inputCommand(['add', path, clean, '--origin', 'synthetic kept part set']);
    commit(clean);
  };
  keep('inputs/seed/parts/hair.png');
  const refusal = refused(clean, 'RESTART_PART_SET_INCOMPLETE', () => restartCommand([clean, '--by', 'owner', '--reason-file', words(clean, 'restart')], step()));
  expect(refusal.message).toContain('inputs/seed/parts.json');
  keep('inputs/seed/parts.json');
  keep('inputs/seed/rig/rig.json');
  refused(clean, 'RESTART_PART_SET_INCOMPLETE', () => restartCommand([clean, '--by', 'owner', '--reason-file', words(clean, 'restart')], step()));
  keep('inputs/seed/rig/mesh_report.json');
  restartCommand([clean, '--by', 'owner', '--reason-file', words(clean, 'restart')], step());
  expect(checkProject(clean).refusals.map(f => [f.code, f.path])).toEqual(checkProject(clean, freshProjectRecord('project', testClock.now())).refusals.map(f => [f.code, f.path]));
  const empty = tempDir();
  expect(() => restartCommand([empty, '--by', 'owner', '--reason-file', words(empty, 'restart')], step())).toThrow(Refusal);
  expect(existsSync(join(empty, 'project.json'))).toBe(false);
});

test('restart refuses before writing unless project.json is committed: untracked, staged, modified, outside git', () => {
  const outside = example();
  refused(outside, 'RESTART_NOT_IN_GIT', () => restartCommand(restartArgs(outside), step()));
  const env = gitEnv({ name: 'Synthetic Owner', email: 'owner@example.com' });
  const untracked = example();
  expect(run(['git', 'init', '-q'], untracked, env).code).toBe(0);
  expect(refused(untracked, 'RESTART_RECORD_UNCOMMITTED', () => restartCommand(restartArgs(untracked), step())).message).toContain('is untracked');
  expect(run(['git', 'add', '--', 'project.json'], untracked, env).code).toBe(0);
  expect(refused(untracked, 'RESTART_RECORD_UNCOMMITTED', () => restartCommand(restartArgs(untracked), step())).message).toContain('never committed');
  const dirty = example(); commit(dirty);
  addRow(dirty, 'T2');
  const refusal = refused(dirty, 'RESTART_RECORD_UNCOMMITTED', () => restartCommand(restartArgs(dirty), step()));
  expect(refusal.message).toContain(`${join(dirty, 'project.json')}: differs from HEAD:project.json`);
  expect(refusal.message).toContain('commit project.json, then restart');
  // Committing the ledger row makes the record clean at HEAD; the restart keeps the row.
  commit(dirty);
  restartCommand(restartArgs(dirty), step());
  expect(arr(load(dirty).fix_ledger).map(row => obj(row).id)).toEqual(['T1', 'T2']);
});

test('restart resolves project.json at HEAD when the project is a subfolder of the repo', () => {
  const dir = example(); const root = dirname(dir);
  commit(dir, root);
  addRow(dir, 'T2');
  expect(refused(dir, 'RESTART_RECORD_UNCOMMITTED', () => restartCommand(restartArgs(dir), step())).message).toContain(`differs from HEAD:${relative(root, dir)}/project.json`);
  commit(dir, root);
  const before = readFileSync(join(dir, 'project.json'));
  restartCommand(restartArgs(dir), step());
  expect(arr(load(dir).restarts)).toEqual([{ at: testClock.iso(), by: 'owner', reason: 'restart', previous_record_sha256: sha(before) }]);
});

test('init with a painting registers it, and refuses a second project for the same artwork unless a reason is given', () => {
  const root = tempDir(); const env = gitEnv();
  const painting = join(tempDir(), 'painting.png'); writeFileSync(painting, 'synthetic painting bytes');
  const first = cli(['init', join(root, 'first'), '--no-install', '--painting', painting, '--origin', 'synthetic painting'], root, env);
  expect(first.stderr).toBe(''); expect(first.code).toBe(0);
  expect(load(join(root, 'first')).painting).toBe('inputs/painting.png');
  expect(checkProject(join(root, 'first')).refusals.filter(f => f.code.startsWith('INPUT_'))).toEqual([]);
  expect(arr(load(join(root, 'first')).inputs)).toEqual([{ path: 'inputs/painting.png', sha256: sha('synthetic painting bytes'), bytes: 24, origin: 'synthetic painting', at: testClock.iso() }]);
  expect(checkProject(join(root, 'first')).refusals.filter(f => f.code.startsWith('INPUT'))).toEqual([]);
  const second = cli(['init', join(root, 'second'), '--no-install', '--painting', painting, '--origin', 'synthetic painting'], root, env);
  expect(second.code).toBe(1);
  expect(second.stderr).toContain('INIT_ARTWORK_EXISTS');
  expect(existsSync(join(root, 'second'))).toBe(false);
  expect(cli(['init', join(root, 'second'), '--no-install', '--painting', painting, '--origin', 'x', '--projects-root', tempDir()], root, env).code).toBe(0);
  const reason = join(tempDir(), 'reason.txt'); writeFileSync(reason, 'A full-screen scene rig of the same painting.\n');
  const third = cli(['init', join(root, 'third'), '--no-install', '--painting', painting, '--origin', 'x', '--same-artwork-reason', reason], root, env);
  expect(third.code).toBe(0);
  expect(load(join(root, 'third')).same_artwork).toEqual({ reason: 'A full-screen scene rig of the same painting.', at: testClock.iso(), projects: ['first', 'second'] });
  expect(cli(['init', join(root, 'fourth'), '--no-install', '--projects-root', root], root, env).stderr).toContain('INIT_ARTWORK_USAGE');
  const other = join(tempDir(), 'other.png'); writeFileSync(other, 'a different synthetic painting');
  const unmatched = cli(['init', join(root, 'fourth'), '--no-install', '--painting', other, '--origin', 'x', '--same-artwork-reason', reason], root, env);
  expect(unmatched.stderr).toContain('INIT_ARTWORK_USAGE');
  expect(existsSync(join(root, 'fourth'))).toBe(false);
});

test('restart validates the declared painting before writing', () => {
  const dir = example(); const project = load(dir);
  project.painting = 'inputs/missing.png'; save(dir, project); commit(dir);
  const error = refused(dir, 'RESTART_INPUT_INVALID', () => restartCommand(restartArgs(dir), step()));
  expect(error.message).toContain('INPUT_PAINTING_INVALID');
});
