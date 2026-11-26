import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { sha256, treeFiles } from '../src/current.ts';
import { CURRENT_PARTS_LEDGER_SINCE, FIX_LEDGER_REPORT_SPEC, recordCurrentPartsLedger } from '../src/fix-ledger.ts';
import { PARTS_CHECK_SPEC } from '../src/parts-check.ts';
import { recordCommand } from '../src/record.ts';
import type { JsonObject } from '../src/templates.ts';
import { syntheticLedgerReport } from './fix-ledger-report-fixture.ts';
import { fixture } from './fixtures.ts';

const CURRENT = 'outputs/parts';
const NEXT = 'outputs/parts.next';
const CONFIG = 'specs/rig/config.json';
const SOURCE = 'inputs/source.txt';
const LAYERS = 'derived/layers/layers.json';
const MANIFEST = 'rig/parts.json';
const SINCE = Date.parse(CURRENT_PARTS_LEDGER_SINCE);
const NOW = SINCE + 5000;
const iso = (at: number): string => new Date(at).toISOString();
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const currentParts = (project: JsonObject): JsonObject => (project.current as JsonObject).parts as JsonObject;
const check = (dir: string, project?: JsonObject) => checkProject(dir, project, { now: NOW });

function write(dir: string, path: string, data: JsonObject | string): string {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  const bytes = typeof data === 'string' ? data : `${JSON.stringify(data)}\n`;
  writeFileSync(join(dir, path), bytes);
  return sha256(bytes);
}

function ledgerRow(id: string, at = SINCE - 1000): JsonObject {
  return { id, at: iso(at), by: 'agent', check: 'synthetic', bar: 'The edge is covered.',
    note: { ref: 'corrections[synthetic]', verbatim: 'Cover the edge.' } };
}

function project(): string {
  return fixture(record => { record.fix_ledger = [ledgerRow('Z'), ledgerRow('A')]; }, 'project.json', {
    '.gitignore': '/outputs/*\n!/outputs/parts/\n', [CONFIG]: '{}', [SOURCE]: 'synthetic source', [LAYERS]: '{}',
  });
}

/** Minimal synthetic producer records, with the named bytes and published field order. */
function producer(dir: string, revision: number, out = NEXT): string {
  const manifest = write(dir, `${out}/${MANIFEST}`, { revision });
  const hash = (path: string): string => sha256(readFileSync(join(dir, path)));
  write(dir, `${out}/run.json`, {
    spec: 'rig-run/1', package: { name: '@rig-c/parts', version: '2.57.0' }, command: 'assemble',
    started_at: iso(SINCE), finished_at: iso(SINCE), config: { path: CONFIG, sha256: hash(CONFIG) },
    inputs: [{ role: 'source', path: SOURCE, sha256: hash(SOURCE) }, { role: 'full', path: LAYERS, sha256: hash(LAYERS) }],
    outputs: [{ path: MANIFEST, sha256: manifest }],
  });
  write(dir, `${out}/check/parts-check.json`, {
    spec: PARTS_CHECK_SPEC, stage: 'parts', inputs: [{ path: 'parts.json', status: 'read', sha256: manifest }],
    parts: {}, refusals: [], reported: [], holes: [], exit_code: 0,
  });
  return manifest;
}

function ledgerReport(dir: string, name: string, manifest: string, results = { Z: 'pass', A: 'pass' }): string {
  return syntheticLedgerReport(dir, manifest, results, name);
}

function record(dir: string, report?: string, out = NEXT, at = SINCE): JsonObject {
  const result = recordCommand(['parts', dir, '--from', out, '--config', CONFIG, '--json',
    ...(report === undefined ? [] : ['--ledger-report', report])], at);
  expect(result.exit).toBe(0);
  return JSON.parse(result.stdout) as JsonObject;
}

test('record parts freezes the previous passing IDs and binds the replacement report and canonical manifest', () => {
  const dir = project();
  const before = check(dir);
  const first = ledgerReport(dir, 'first', producer(dir, 1));
  expect(record(dir, first).ledger).toEqual({
    report: { path: first, sha256: sha256(readFileSync(join(dir, first))), spec: FIX_LEDGER_REPORT_SPEC }, replaced_passed_rows: [],
  });
  const manifest = producer(dir, 2);
  const second = ledgerReport(dir, 'second', manifest);
  const replacement = record(dir, second, NEXT, SINCE + 1000);
  expect(replacement.ledger).toEqual({
    report: { path: second, sha256: sha256(readFileSync(join(dir, second))), spec: FIX_LEDGER_REPORT_SPEC }, replaced_passed_rows: ['A', 'Z'],
  });
  expect(sha256(readFileSync(join(dir, CURRENT, MANIFEST)))).toBe(manifest);
  expect(existsSync(join(dir, NEXT))).toBe(false);
  expect(currentParts(load(dir))).toEqual(replacement);
  expect(check(dir).refusals).toEqual(before.refusals);
});

test('regression and omission refuse before changing either output tree or project.json', () => {
  const dir = project();
  const first = ledgerReport(dir, 'first', producer(dir, 1));
  record(dir, first);
  const manifest = producer(dir, 2);
  const file = join(dir, 'project.json');
  const original = readFileSync(file);
  const current = treeFiles(dir, CURRENT);
  const staged = treeFiles(dir, NEXT);
  expect(() => record(dir, ledgerReport(dir, 'regression', manifest, { A: 'fail', Z: 'pass' })))
    .toThrow(expect.objectContaining({ code: 'CURRENT_PARTS_LEDGER_REGRESSION' }));
  expect(() => record(dir, first)).toThrow(expect.objectContaining({ code: 'CURRENT_PARTS_LEDGER_REPORT_INVALID' }));
  expect(() => record(dir)).toThrow(expect.objectContaining({ code: 'CURRENT_PARTS_LEDGER_REPORT_MISSING' }));
  expect(readFileSync(file)).toEqual(original);
  expect(treeFiles(dir, CURRENT)).toEqual(current);
  expect(treeFiles(dir, NEXT)).toEqual(staged);
});

test('an in-place record still requires and verifies the previous report after its rows are retired', () => {
  const dir = project();
  const first = ledgerReport(dir, 'first', producer(dir, 1));
  record(dir, first);
  const retiredAt = SINCE + 1000;
  const candidate = load(dir);
  for (const row of candidate.fix_ledger as JsonObject[]) row.retired = { at: iso(retiredAt), by: 'owner', reason: 'Synthetic fix retired.' };
  write(dir, 'project.json', candidate);
  const manifest = producer(dir, 2, CURRENT);
  const original = readFileSync(join(dir, 'project.json'));
  const installed = treeFiles(dir, CURRENT);
  expect(() => record(dir, undefined, CURRENT, retiredAt)).toThrow(expect.objectContaining({ code: 'CURRENT_PARTS_LEDGER_REPORT_MISSING' }));
  ledgerReport(dir, 'first', manifest, { A: 'fail', Z: 'fail' });
  expect(() => record(dir, first, CURRENT, retiredAt)).toThrow(expect.objectContaining({ code: 'CURRENT_PARTS_LEDGER_REPORT_INVALID' }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(original);
  expect(treeFiles(dir, CURRENT)).toEqual(installed);
});

test('check dates coverage by current.parts.at and validates the retained bytes and replaced row set', () => {
  const dir = project();
  const manifest = producer(dir, 1);
  const path = ledgerReport(dir, 'first', manifest);
  record(dir, path);
  const candidate = load(dir);
  (candidate.fix_ledger as JsonObject[]).push(ledgerRow('LATER', SINCE + 1000));
  const parts = currentParts(candidate);
  const ledger = parts.ledger as JsonObject;
  expect(check(dir, candidate).refusals.some(f => f.code === 'CURRENT_PARTS_LEDGER_INCOMPLETE')).toBe(false);
  ledger.replaced_passed_rows = ['Z', 'A'];
  expect(check(dir, candidate).refusals).toContainEqual(expect.objectContaining({
    code: 'CURRENT_PARTS_LEDGER_REPORT_INVALID', path: 'current.parts.ledger.replaced_passed_rows',
  }));
  ledger.replaced_passed_rows = ['A', 'Z'];
  const regressed = ledgerReport(dir, 'regressed', manifest, { A: 'unmeasurable', Z: 'pass' });
  const binding = ledger.report as JsonObject;
  binding.path = regressed;
  binding.sha256 = sha256(readFileSync(join(dir, regressed)));
  expect(check(dir, candidate).refusals).toContainEqual(expect.objectContaining({ code: 'CURRENT_PARTS_LEDGER_REGRESSION' }));
  parts.at = iso(SINCE + 1000);
  expect(check(dir, candidate).refusals).toContainEqual(expect.objectContaining({ code: 'CURRENT_PARTS_LEDGER_INCOMPLETE' }));
  write(dir, regressed, '{}');
  expect(check(dir, candidate).refusals).toContainEqual(expect.objectContaining({
    code: 'CURRENT_PARTS_LEDGER_REPORT_INVALID', path: 'current.parts.ledger.report',
  }));
});

test('missing current ledger warns only on earlier current parts and leaves a no-current project alone', () => {
  const dir = project();
  record(dir, ledgerReport(dir, 'first', producer(dir, 1)));
  const candidate = load(dir);
  const parts = currentParts(candidate);
  const missing = expect.objectContaining({ code: 'CURRENT_PARTS_LEDGER_REPORT_MISSING', path: 'current.parts.ledger.report' });
  delete parts.ledger;
  expect(check(dir, candidate).refusals).toContainEqual(missing);
  parts.at = iso(SINCE - 1);
  const legacy = check(dir, candidate);
  expect(legacy.refusals).not.toContainEqual(missing);
  expect(legacy.warnings).toContainEqual(missing);
  delete candidate.current;
  const numbered = check(dir, candidate);
  expect([...numbered.refusals, ...numbered.warnings]).not.toContainEqual(missing);
});

test('the commit verifier refuses when a validated report changes', () => {
  const dir = project();
  const report = ledgerReport(dir, 'first', producer(dir, 1, CURRENT));
  const node: JsonObject = { at: iso(SINCE), files: treeFiles(dir, CURRENT) };
  const verify = recordCurrentPartsLedger(dir, load(dir), node, report, NOW)!;
  write(dir, report, '{}');
  expect(verify).toThrow(expect.objectContaining({ code: 'RECORD_SOURCE_CHANGED' }));
});
