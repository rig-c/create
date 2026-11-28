import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { optionContext } from '../src/choices.ts';
import { FIX_LEDGER_REPORT_SPEC, FIX_LEDGER_SINCE, ledgerCommand } from '../src/fix-ledger.ts';
import { nextCommand } from '../src/next.ts';
import { restartCommand } from '../src/restart.ts';
import { freshProjectRecord } from '../src/init.ts';
import { OWNER_CHAT_SOURCE, REOPEN_RESTART_OWNER_CHAT_SINCE } from '../src/owner-chat.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, waypoint } from './fixtures.ts';
import { checkProject, inputCommand, interviewCommand, testClock, TEST_NOW } from './clock.ts';
import { cli, gitEnv, ownerChatArgs, run, tempDir } from './helpers.ts';
import { seedRetainedDraft } from './numbered-seed.ts';

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
    writeFileSync(join(dir, 'project.json'), before);
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
    return error as Refusal;
  }
  throw new Error(`expected ${code}`);
}

/** Commit `<dir>/project.json` in the repo at `root` (created when absent): restart needs the record clean at HEAD. */
function commit(dir: string, root = dir): void {
  const identity = gitEnv({ name: 'Synthetic Owner', email: 'owner@example.com' });
  const git = (...args: string[]): void => { const r = run(['git', ...args], root, identity); if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`); };
  if (!existsSync(join(root, '.git'))) {
    git('init', '-q');
    git('config', 'user.name', 'Synthetic Owner');
    git('config', 'user.email', 'owner@example.com');
  }
  git('add', '--', relative(root, join(dir, 'project.json')));
  if (run(['git', 'diff', '--cached', '--quiet'], root, identity).code !== 0) {
    git('commit', '-q', '-m', 'record');
  }
}
const restartArgs = (dir: string, reason = 'restart'): string[] => [dir, '--by', 'owner', ...ownerChatArgs(words(dir, reason))];

/** The filled example: ledger row T1, the draft `example` (parts receipt, no report) and `lantern` (T1 pass). */
const example = (): string => fixture(() => {}, 'example-numbered/example-project.json');
const manifest = (dir: string, id: string): string => sha(readFileSync(join(dir, `derived/drafts/${id}/input/parts.json`)));

/** A labelled draft with the example's producer bytes under derived/drafts/<id>/. */
function copyDraft(dir: string, id: string): void { cpSync(join(dir, 'derived/drafts/example'), join(dir, `derived/drafts/${id}`), { recursive: true }); }
function report(dir: string, id: string, rows: Record<string, string> | JsonObject[], build = manifest(dir, id)): string {
  const path = `evidence/fix-ledger/${id}.json`;
  mkdirSync(join(dir, 'evidence/fix-ledger'), { recursive: true });
  writeFileSync(join(dir, path), `${JSON.stringify({ schema: FIX_LEDGER_REPORT_SPEC, build: { dir: `derived/drafts/${id}/out`, manifest_sha256: build }, script_sha256: sha('synthetic'),
    rows: Array.isArray(rows) ? rows : Object.entries(rows).map(([row, result]) => ({ id: row, result, measured: 1, bar: 'synthetic bar', reason: null, extra: true })) })}\n`);
  return path;
}
const draftArgs = (dir: string, id: string, ...extra: string[]): string[] => [id, dir, '--config', `derived/drafts/${id}/config.json`, '--from', `derived/drafts/${id}/out`, '--parts', `derived/drafts/${id}/input`, '--json', ...extra];
const record = (dir: string, id: string, ...extra: string[]): JsonObject => { step(); return JSON.parse(seedRetainedDraft(draftArgs(dir, id, ...extra), testClock.now()).stdout) as JsonObject; };
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
  const beforeSeed = readFileSync(join(dir, 'project.json'));
  seedRetainedDraft(draftArgs(dir, 'd3'), step());
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('DRAFT_LEDGER_REPORT_MISSING');
  writeFileSync(join(dir, 'project.json'), beforeSeed);
  refused(dir, 'DRAFT_LEDGER_INCOMPLETE', () => seedRetainedDraft(draftArgs(dir, 'd3', '--ledger-report', report(dir, 'd3', { other: 'pass' })), step()));
  refused(dir, 'DRAFT_LEDGER_BUILD_MISMATCH', () => seedRetainedDraft(draftArgs(dir, 'd3', '--ledger-report', report(dir, 'd3', { T1: 'pass' }, 'a'.repeat(64))), step()));
  mkdirSync(join(dir, 'scratch'), { recursive: true }); cpSync(join(dir, report(dir, 'd3', { T1: 'pass' })), join(dir, 'scratch/d3.json'));
  refused(dir, 'DRAFT_LEDGER_REPORT_INVALID', () => seedRetainedDraft(draftArgs(dir, 'd3', '--ledger-report', 'scratch/d3.json'), step()));
  writeFileSync(join(dir, 'evidence/fix-ledger/bad.json'), JSON.stringify({ schema: FIX_LEDGER_REPORT_SPEC, build: { manifest_sha256: manifest(dir, 'd3') }, script_sha256: sha('x'), rows: [{ id: 'T1', result: 'ok' }] }));
  refused(dir, 'DRAFT_LEDGER_REPORT_INVALID', () => seedRetainedDraft(draftArgs(dir, 'd3', '--ledger-report', 'evidence/fix-ledger/bad.json'), step()));
  const recorded = record(dir, 'd3', '--ledger-report', report(dir, 'd3', { T1: 'pass' }));
  expect(recorded).toMatchObject({ ledger_report: { path: 'evidence/fix-ledger/d3.json', spec: FIX_LEDGER_REPORT_SPEC }, fixes_against: 'example', fixes: ['T1'] });
  expect(checkProject(dir).refusals).toEqual([]);
  writeFileSync(join(dir, 'evidence/fix-ledger/d3.json'), '{}');
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual([['DRAFT_LEDGER_REPORT_INVALID', 'drafts[2].ledger_report']]);
});

test.each(['fail', 'unmeasurable'])('a row the predecessor passed and the new report marks %s is a named regression unless recorded as known', result => {
  const dir = example(); copyDraft(dir, 'd3');
  const path = report(dir, 'd3', { T1: result });
  const refusal = refused(dir, 'DRAFT_LEDGER_REGRESSION', () => seedRetainedDraft(draftArgs(dir, 'd3', '--ledger-report', path), step()));
  expect(refusal.message).toContain(`T1 (${result}) passed in lantern`);
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
  const refusal = refused(dir, 'DRAFT_LEDGER_REGRESSION', () => seedRetainedDraft(draftArgs(dir, 'd3', '--ledger-report', path), step()));
  expect(refusal.message).toContain('X (fail) passed in d2, or are known regressions it still owes');
  refused(dir, 'DRAFT_LEDGER_REGRESSION', () => seedRetainedDraft(draftArgs(dir, 'd3', '--ledger-report', path, '--accepted-fail', `X=${words(dir, 'Still rebuilding X.')}`), step()));
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
  refused(dir, 'DRAFT_LEDGER_MALFORMED', () => seedRetainedDraft(draftArgs(dir, 'd3', '--ledger-report', report(dir, 'd3', { T1: 'pass' }), '--known-regression', `T1=${words(dir, 'not regressed')}`), step()));
});

function acceptedFailFixture(): string {
  const dir = fixture(project => {
    delete project.fix_ledger;
    project.drafts = arr(project.drafts).slice(0, 1);
  }, 'example-numbered/example-project.json');
  copyDraft(dir, 'reviewed');
  return dir;
}

test('accepted failures show the current machine FAIL and review reasons with no ledger or predecessor report', () => {
  const dir = acceptedFailFixture();
  const before = load(dir);
  expect(before.fix_ledger).toBeUndefined();
  expect(obj(arr(before.drafts).at(-1)).ledger_report).toBeUndefined();
  const reason = 'The remaining flaw is visible but acceptable in this draft.';
  const note = words(dir, `${reason}\n`);
  const rows: (JsonObject & { id: string })[] = [
    { id: 'Q', result: 'fail', measured: 3 },
    { id: 'absent-value', result: 'fail' },
    { id: 'null-value', result: 'fail', measured: null },
    { id: 'compound', result: 'fail', measured: { count: 0, clear: false, angles: [2, 3] }, extra: true },
  ];
  const path = report(dir, 'reviewed', rows);
  const bytes = readFileSync(join(dir, path));
  const expected = rows.map(({ extra: _extra, ...row }) => ({ ...row, reason }));
  const draft = record(dir, 'reviewed', '--ledger-report', path, ...rows.flatMap(row => ['--accepted-fail', `${row.id}=${note}`]));
  expect(draft).toMatchObject({ ledger_report: { path, sha256: sha(bytes), spec: FIX_LEDGER_REPORT_SPEC }, fixes: [], fixes_against: 'example' });
  expect(draft.accepted_failures).toEqual(expected);
  expect(draft.known_regressions).toBeUndefined();
  expect(load(dir)).toEqual({ ...before, drafts: [...arr(before.drafts), draft] });
  expect(readFileSync(join(dir, path))).toEqual(bytes);
  const json = interviewCommand(['--check', dir, '--json']);
  expect(json.exit).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({ refusals: [], ledger: [{ draft: 'reviewed', fixes: [], known_regressions: [], accepted_failures: expected }] });
  const human = interviewCommand(['--check', dir]);
  expect(human.exit).toBe(0);
  expect(human.stdout).toContain(`Q FAIL (measured 3) (accepted failure): ${reason}`);
  expect(human.stdout).toContain(`absent-value FAIL (accepted failure): ${reason}`);
  expect(human.stdout).toContain(`null-value FAIL (measured null) (accepted failure): ${reason}`);
});

test.each(['pass', 'absent', 'unmeasurable'])('an accepted failure with report result %s is refused', result => {
  const dir = acceptedFailFixture();
  const path = report(dir, 'reviewed', result === 'absent' ? [] : [{ id: 'Q', result, measured: 3 }]);
  const error = refused(dir, 'DRAFT_ACCEPTED_FAIL_ROW', () => seedRetainedDraft(draftArgs(dir, 'reviewed', '--ledger-report', path, '--accepted-fail', `Q=${words(dir, 'Synthetic reason')}`), step()));
  expect(error.message).toContain(`row Q is ${result}`);
});

test('accepted-fail refuses a report for a different build or a measurement that cannot round-trip', () => {
  const dir = acceptedFailFixture();
  const rows = [{ id: 'Q', result: 'fail', measured: [3] }];
  const path = report(dir, 'reviewed', rows, 'a'.repeat(64));
  const args = draftArgs(dir, 'reviewed', '--ledger-report', path, '--accepted-fail', `Q=${words(dir, 'Synthetic reason')}`);
  refused(dir, 'DRAFT_LEDGER_BUILD_MISMATCH', () => seedRetainedDraft(args, step()));
  report(dir, 'reviewed', rows);
  const file = join(dir, path);
  writeFileSync(file, readFileSync(file, 'utf8').replace('"measured":[3]', '"measured":[1e400]'));
  refused(dir, 'DRAFT_ACCEPTED_FAIL_MISMATCH', () => seedRetainedDraft(args, step()));
});

test('check refuses accepted-fail record and report tampering before surfacing a note', () => {
  const dir = acceptedFailFixture();
  const path = report(dir, 'reviewed', [{ id: 'Q', result: 'fail', measured: { count: 3, bands: [0, 1] } }]);
  record(dir, 'reviewed', '--ledger-report', path, '--accepted-fail', `Q=${words(dir, 'Synthetic reason')}`);
  const original = load(dir);
  const draft = obj(arr(original.drafts)[1]);
  const entry = obj(arr(draft.accepted_failures)[0]);
  const checkTamper = (changes: JsonObject, code: string, findingPath: string): void => {
    save(dir, { ...original, drafts: [arr(original.drafts)[0]!, { ...draft, ...changes }] });
    const checked = checkProject(dir);
    expect(checked.refusals.map(f => [f.code, f.path])).toEqual([[code, findingPath]]);
    expect(checked.ledger?.[0]?.accepted_failures).toBeUndefined();
  };
  const listPath = 'drafts[1].accepted_failures';
  const entryPath = `${listPath}[0]`;
  for (const malformed of [null, [], [{ ...entry, result: 'pass' }], [{ ...entry, reason: ' ' }], [{ ...entry, verdict: 'accept' }]]) {
    const at = Array.isArray(malformed) && malformed.length ? entryPath : listPath;
    checkTamper({ accepted_failures: malformed }, 'DRAFT_ACCEPTED_FAIL_MALFORMED', at);
  }
  const { ledger_report: _report, fixes: _fixes, fixes_against: _against, ...unboundDraft } = draft;
  save(dir, { ...original, drafts: [arr(original.drafts)[0]!, unboundDraft] });
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual([['DRAFT_ACCEPTED_FAIL_MALFORMED', listPath]]);
  checkTamper({ accepted_failures: [{ ...entry, id: 'absent' }] }, 'DRAFT_ACCEPTED_FAIL_ROW', entryPath);
  checkTamper({ accepted_failures: [{ ...entry, measured: { count: '3', bands: [0, 1] } }] }, 'DRAFT_ACCEPTED_FAIL_MISMATCH', `${entryPath}.measured`);
  const { measured: _measured, ...missingValue } = entry;
  checkTamper({ accepted_failures: [missingValue] }, 'DRAFT_ACCEPTED_FAIL_MISMATCH', `${entryPath}.measured`);
  save(dir, { ...original, drafts: [arr(original.drafts)[0]!, { ...draft, accepted_failures: [entry, entry] }] });
  expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual([['DRAFT_ACCEPTED_FAIL_MALFORMED', `${listPath}[1]`]]);

  save(dir, original);
  report(dir, 'reviewed', [{ id: 'Q', result: 'pass', measured: entry.measured! }]);
  expect(checkProject(dir).refusals.map(f => f.code)).toEqual(['DRAFT_LEDGER_REPORT_INVALID']);
  checkTamper({ ledger_report: { ...obj(draft.ledger_report), sha256: sha(readFileSync(join(dir, path))) } }, 'DRAFT_ACCEPTED_FAIL_ROW', entryPath);
  report(dir, 'reviewed', [{ id: 'Q', result: 'fail' }]);
  checkTamper({ ledger_report: { ...obj(draft.ledger_report), sha256: sha(readFileSync(join(dir, path))) },
    accepted_failures: [{ ...entry, measured: null }] }, 'DRAFT_ACCEPTED_FAIL_MISMATCH', `${entryPath}.measured`);
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
  const historical = load(dir);
  delete historical.painting;
  save(dir, historical);
  // Declare the already registered second input through the public writer.
  inputCommand(['painting', 'inputs/painting.png', dir]);
  const declared = load(dir); expect(declared.painting).toBe('inputs/painting.png');
  declared.owner = { language: 'ko' };
  declared.same_artwork = { reason: 'A different synthetic rig kind.', at: testClock.iso(), projects: ['first'] };
  const motionWords = '  호흡을 조금 천천히 해 주세요.\r\n';
  const motion = { by: 'owner', at: testClock.iso(), source: 'polish feedback, v3', review_act: 'review act synthetic-job/synthetic-act' };
  obj(waypoint(declared, 'motion').guide).additions = [{ ...motion, verbatim: motionWords, value: null }];
  save(dir, declared); commit(dir);
  const before = readFileSync(join(dir, 'project.json'));
  const old = load(dir);
  refused(dir, 'SIGNOFF_NOT_HUMAN', () => restartCommand([dir, '--by', 'agent', '--reason-file', words(dir, 'restart')], step()));
  refused(dir, 'OWNER_CHAT_REQUIRED', () => restartCommand([dir, '--by', 'owner'], step()));
  const reason = '\uFEFF  Restart at v1; delete everything before it.\r\n';
  const saidAt = testClock.iso();
  const result = restartCommand(restartArgs(dir, reason), step());
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain('Dropped 3 answer addition(s)');
  expect(result.stdout).toContain('interview.waypoints[motion].guide.additions[0] (source: "polish feedback, v3")');
  expect(result.stdout).not.toContain(motionWords.trim());
  const restarted = load(dir);
  expect(restarted).toMatchObject({ stage: 'interview', versions: [], signoffs: [], name: old.name!, owner: old.owner!, painting: old.painting!, same_artwork: old.same_artwork!, inputs: old.inputs!, fix_ledger: old.fix_ledger! });
  for (const key of ['drafts', 'review_acts', 'advances', 'scenes']) expect(restarted[key]).toBeUndefined();
  expect(obj(restarted.plan).steps).toEqual([]);
  // The example also contains two copies of the same addition in distinct historical answers.
  const history = arr(waypoint(old, 'bones').history);
  const dropped = [0, 1].map(index => {
    const { by, at, source, verbatim } = obj(arr(obj(history[index]).additions)[0]);
    return { item: 'bones', path: `interview.waypoints[bones].history[${index}].additions[0]`,
      by, at, source, verbatim_sha256: sha(String(verbatim)) };
  });
  expect(arr(restarted.restarts)).toEqual([{ at: testClock.iso(), by: 'owner', reason, previous_record_sha256: sha(before),
    source: OWNER_CHAT_SOURCE, said_at: saidAt, relayed_by: 'synthetic-relay',
    dropped_additions: [...dropped, { ...motion, item: 'motion', path: 'interview.waypoints[motion].guide.additions[0]', verbatim_sha256: sha(motionWords) }] }]);
  for (const row of dropped) expect(result.stdout).toContain(row.path);
  expect(JSON.stringify(restarted)).not.toContain(motionWords.trim());
  // A restarted record checks the same as a fresh init record: the same codes (its open interview) and 0 warnings.
  const checked = checkProject(dir);
  const fresh = checkProject(dir, { ...freshProjectRecord(String(old.name), testClock.now()), owner: old.owner! });
  expect(checked.refusals.map(f => [f.code, f.path])).toEqual(fresh.refusals.map(f => [f.code, f.path]));
  expect(fresh.refusals.map(f => f.code)).toContain('INTERVIEW_INCOMPLETE');
  expect(checked.warnings).toEqual([]);
  expect(fresh.warnings).toEqual([]);
  const open = checked.refusals;
  // The first draft after a restart has no predecessor, but it covers every live row.
  copyDraft(dir, 'r1');
  refused(dir, 'DRAFT_LEDGER_INCOMPLETE', () => seedRetainedDraft(draftArgs(dir, 'r1', '--ledger-report', report(dir, 'r1', {})), step()));
  expect(record(dir, 'r1', '--ledger-report', report(dir, 'r1', { T1: 'fail' }))).toMatchObject({ fixes_against: null, fixes: [] });
  expect(checkProject(dir).refusals).toEqual(open);
});

test('restart JSON reports additions and check refuses malformed inventory rows', () => {
  const dir = example();
  commit(dir);
  const result = restartCommand([...restartArgs(dir), '--json'], step());
  const project = load(dir);
  const entry = obj(arr(project.restarts)[0]);
  expect(JSON.parse(result.stdout)).toEqual(entry);
  const rows = arr(entry.dropped_additions);
  expect(rows).toHaveLength(2);
  const row = obj(rows[0]);
  const path = 'restarts[0].dropped_additions';
  for (const value of [null, {}, [{ ...row, verbatim_sha256: 'invalid' }], [{ ...row, item: 'other' }],
    [{ ...row, review_act: {} }], [{ ...row, verbatim: 'raw text' }]]) {
    entry.dropped_additions = value;
    expect(checkProject(dir, project).refusals).toContainEqual(expect.objectContaining({
      code: 'RESTART_MALFORMED', path: Array.isArray(value) ? `${path}[0]` : path,
    }));
  }
  commit(dir);
  const next = restartCommand([...restartArgs(dir), '--json'], step());
  expect(JSON.parse(next.stdout).dropped_additions).toEqual([]);
  expect(arr(load(dir).restarts)[0]).toEqual(JSON.parse(result.stdout));
});

test('restart refuses an unhashable source addition before replacing the record', () => {
  const dir = example();
  const project = load(dir);
  obj(waypoint(project, 'motion').guide).additions = [{ source: 'polish feedback, v3' }];
  save(dir, project);
  commit(dir);
  refused(dir, 'RESTART_MALFORMED', () => restartCommand(restartArgs(dir), step()));
});

test('restart owner chat authority is dated, refuses agent and malformed relays, and preserves bytes on refusal', () => {
  const dir = example();
  const at = Date.parse(REOPEN_RESTART_OWNER_CHAT_SINCE);
  testClock.set(at);
  const file = words(dir, 'Restart the synthetic project.\r\n');
  refused(dir, 'OWNER_CHAT_REQUIRED', () => restartCommand([dir, '--by', 'owner', '--reason-file', file], at));
  refused(dir, 'SIGNOFF_NOT_HUMAN', () => restartCommand([dir, '--by', 'AGENT', ...ownerChatArgs(file)], at));
  refused(dir, 'OWNER_CHAT_INVALID', () => restartCommand([dir, '--by', 'owner', '--owner-chat', file], at));
  refused(dir, 'OWNER_CHAT_INVALID', () => restartCommand([dir, '--by', 'owner', '--reason-file', file, ...ownerChatArgs(file)], at));
  refused(dir, 'RESTART_USAGE', () => restartCommand([dir, '--from-review', 'synthetic-act'], at));

  testClock.reset();
  const p = load(dir);
  const record: JsonObject = { at: new Date(at - 1).toISOString(), by: 'owner', reason: 'Restart.', previous_record_sha256: '0'.repeat(64) };
  p.restarts = [record];
  const authority = { code: 'OWNER_CHAT_REQUIRED', path: 'restarts[0]' };
  expect(checkProject(dir, p).warnings).toContainEqual(expect.objectContaining(authority));
  expect(checkProject(dir, p).refusals).not.toContainEqual(expect.objectContaining(authority));
  record.at = REOPEN_RESTART_OWNER_CHAT_SINCE;
  expect(checkProject(dir, p).refusals).toContainEqual(expect.objectContaining(authority));
  Object.assign(record, { source: OWNER_CHAT_SOURCE, said_at: new Date(at).toISOString(), relayed_by: 'synthetic-relay' });
  expect(checkProject(dir, p).refusals).toEqual([]);
  record.said_at = new Date(at + 1).toISOString();
  expect(checkProject(dir, p).refusals).toContainEqual(expect.objectContaining({ code: 'OWNER_CHAT_INVALID', path: 'restarts[0]' }));
  record.by = 'AGENT';
  expect(checkProject(dir, p).refusals).toContainEqual(expect.objectContaining({ code: 'SIGNOFF_NOT_HUMAN', path: 'restarts[0].by' }));
});

test('restart refuses before writing: a changed input, a part set without its parts.json or rig, a folder that is not a project', () => {
  const dir = example(); commit(dir);
  writeFileSync(join(dir, 'inputs/painting.png'), 'changed bytes');
  refused(dir, 'RESTART_INPUT_INVALID', () => restartCommand(restartArgs(dir), step()));
  const clean = example();
  const keep = (path: string, bytes = `synthetic ${path}`): void => {
    mkdirSync(dirname(join(clean, path)), { recursive: true }); writeFileSync(join(clean, path), bytes);
    step(); inputCommand(['add', path, clean, '--origin', 'synthetic kept part set']);
    commit(clean);
  };
  keep('inputs/seed/parts/hair.png');
  const refusal = refused(clean, 'RESTART_PART_SET_INCOMPLETE', () => restartCommand(restartArgs(clean), step()));
  expect(refusal.message).toContain('inputs/seed/parts.json');
  keep('inputs/seed/parts.json');
  keep('inputs/seed/rig/rig.json');
  refused(clean, 'RESTART_PART_SET_INCOMPLETE', () => restartCommand(restartArgs(clean), step()));
  keep('inputs/seed/rig/mesh_report.json');
  restartCommand(restartArgs(clean), step());
  expect(checkProject(clean).refusals.map(f => [f.code, f.path])).toEqual(checkProject(clean, freshProjectRecord('project', testClock.now())).refusals.map(f => [f.code, f.path]));
  const empty = tempDir();
  expect(() => restartCommand(restartArgs(empty), step())).toThrow(Refusal);
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
  const committedBytes = readFileSync(join(dirty, 'project.json'));
  writeFileSync(join(dirty, 'project.json'), `${committedBytes.toString('utf8')}\n`);
  const refusal = refused(dirty, 'RESTART_RECORD_UNCOMMITTED', () => restartCommand(restartArgs(dirty), step()));
  expect(refusal.message).toContain(`${join(dirty, 'project.json')}: differs from HEAD:project.json`);
  expect(refusal.message).toContain('commit project.json, then restart');
  // Restoring the committed record makes it clean at HEAD; the restart keeps the ledger row.
  writeFileSync(join(dirty, 'project.json'), committedBytes);
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
  expect(arr(load(dir).restarts)).toEqual([expect.objectContaining({ at: testClock.iso(), by: 'owner', reason: 'restart', previous_record_sha256: sha(before),
    source: OWNER_CHAT_SOURCE, relayed_by: 'synthetic-relay' })]);
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

test('restart leaves out legacy INPUT_WRITER_MISSING entries after re-registration, names them, and next names interview', () => {
  const dir = example(); const project = load(dir);
  delete obj(arr(project.inputs)[0]).at;
  save(dir, project); commit(dir);
  cpSync(join(dir, 'inputs/preparation-source.svg'), join(dir, 'inputs/preparation-source-registered.svg'));
  step(); inputCommand(['add', 'inputs/preparation-source-registered.svg', dir, '--origin', 'registered again for restart']);
  commit(dir);
  const result = restartCommand(restartArgs(dir), step());
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain('left out legacy input(s) inputs[0] (inputs/preparation-source.svg)');
  expect(arr(load(dir).inputs).map(entry => obj(entry).path)).toEqual([
    'inputs/painting.png',
    'evidence/scene-background.png',
    'inputs/preparation-source-registered.svg',
  ]);
  expect(checkProject(dir).warnings).toEqual([]);
  const next = nextCommand([dir], testClock.now());
  expect(next.exit).toBe(0);
  expect(next.stdout).toContain('stage: interview');
});

test('#949: source options put a painting re-added after restart ahead of retained inputs', () => {
  const dir = example();
  const project = load(dir);
  delete project.painting;
  for (const input of arr(project.inputs).map(obj)) {
    if (input.path !== 'evidence/scene-background.png') delete input.at;
  }
  save(dir, project);
  commit(dir);
  restartCommand(restartArgs(dir), step());
  const plate = 'evidence/scene-background.png';
  expect(arr(load(dir).inputs).map(entry => obj(entry).path)).toEqual([plate]);

  const reference = 'inputs/preparation-source.svg';
  const painting = 'inputs/painting.png';
  step(); inputCommand(['add', reference, dir, '--origin', 'synthetic reference']);
  step(); inputCommand(['add', painting, dir, '--origin', 're-added synthetic painting', '--painting']);
  const restarted = load(dir);
  const inputs = arr(restarted.inputs).map(obj);
  expect(inputs.map(input => input.path)).toEqual([plate, reference, painting]);
  expect(restarted.painting).toBe(painting);
  expect(optionContext(restarted, 'interview', testClock.now(), dir)).toEqual({ kind: 'inputs',
    files: [inputs[2]!, inputs[0]!, inputs[1]!].map(({ path, sha256 }) => ({ path, sha256 })),
  });
  expect(load(dir).inputs).toEqual(inputs);
});

test('restart leaves out an untwinned legacy entry, refuses when a left-out legacy entry is the painting without a twin, and keeps the painting when re-registered', () => {
  const dir = example(); const project = load(dir);
  delete obj(arr(project.inputs)[0]).at;
  save(dir, project); commit(dir);
  const untwinned = restartCommand(restartArgs(dir), step());
  expect(untwinned.exit).toBe(0);
  expect(untwinned.stdout).toContain('left out legacy input(s) inputs[0] (inputs/preparation-source.svg)');
  expect(arr(load(dir).inputs).map(entry => obj(entry).path)).toEqual(['inputs/painting.png', 'evidence/scene-background.png']);

  const painted = example(); const paintedRecord = load(painted);
  delete obj(arr(paintedRecord.inputs)[1]).at;
  paintedRecord.painting = 'inputs/painting.png';
  save(painted, paintedRecord); commit(painted);
  const paintingRefusal = refused(painted, 'RESTART_INPUT_INVALID', () => restartCommand(restartArgs(painted), step()));
  expect(paintingRefusal.message).toContain('INPUT_PAINTING_INVALID');

  writeFileSync(join(painted, 'inputs/other-bytes.png'), 'different synthetic bytes');
  step(); inputCommand(['add', 'inputs/other-bytes.png', painted, '--origin', 'different bytes']);
  commit(painted);
  refused(painted, 'RESTART_INPUT_INVALID', () => restartCommand(restartArgs(painted), step()));

  cpSync(join(painted, 'inputs/painting.png'), join(painted, 'inputs/painting-source.png'));
  step(); inputCommand(['add', 'inputs/painting-source.png', painted, '--origin', 'registered painting twin']);
  commit(painted);
  writeFileSync(join(painted, 'evidence/scene-background.png'), 'changed writer-valid bytes');
  const changedRefusal = refused(painted, 'RESTART_INPUT_INVALID', () => restartCommand(restartArgs(painted), step()));
  expect(changedRefusal.message).toContain('INPUT_FILE_CHANGED');
  cpSync(join(dir, 'evidence/scene-background.png'), join(painted, 'evidence/scene-background.png'));
  expect(restartCommand(restartArgs(painted), step()).exit).toBe(0);
  expect(load(painted).painting).toBe('inputs/painting-source.png');

  const undeclared = example(); const undeclaredRecord = load(undeclared);
  delete undeclaredRecord.painting;
  for (const raw of arr(undeclaredRecord.inputs)) delete obj(raw).at;
  save(undeclared, undeclaredRecord); commit(undeclared);
  cpSync(join(undeclared, 'inputs/painting.png'), join(undeclared, 'inputs/painting-source.png'));
  step(); inputCommand(['add', 'inputs/painting-source.png', undeclared, '--painting', '--origin', 'registered painting again']);
  commit(undeclared);
  const restarted = restartCommand(restartArgs(undeclared), step());
  expect(restarted.exit).toBe(0);
  expect(restarted.stdout).toContain('inputs[0] (inputs/preparation-source.svg), inputs[1] (inputs/painting.png), inputs[2] (evidence/scene-background.png)');
  expect(load(undeclared).painting).toBe('inputs/painting-source.png');
  expect(arr(load(undeclared).inputs).map(entry => obj(entry).path)).toEqual(['inputs/painting-source.png']);
});
