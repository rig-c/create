/**
 * The example's fix ledger (create#285): the owner fix the v1 bounce asked for, recorded with
 * `ledger add`, and a later labelled draft recorded with the synthetic report a project's own check
 * script would write for it. The report is synthetic: create never runs or reproduces a ledger check.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { draftRigCommand } from '../src/drafts.ts';
import { FIX_LEDGER_REPORT_SPEC, ledgerCommand } from '../src/fix-ledger.ts';
import { EXAMPLE_DRAFT } from '../tests/draft-fixture.ts';
import { exampleTime } from './example-time.ts';

export const EXAMPLE_LEDGER_DRAFT = 'derived/drafts/lantern';
export const EXAMPLE_LEDGER_REPORT = 'evidence/fix-ledger/lantern.json';
const ROW = {
  id: 'T1',
  note: 'versions[v1].verdicts[0]',
  verbatim: 'It should hang from her hand and swing on its own.',
  check: 'lantern-hangs-from-hand',
  bar: 'the lantern pivots at the hand: its swing angle differs from the forearm angle by at least 10 degrees in the sway take',
};
/** Stands in for the sha256 of the project's check script; the example has no script. */
const SCRIPT = 'synthetic fix-ledger check script\n';
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The synthetic report bytes: one passing row for the build whose parts.json is `partsJson`. */
export function exampleLedgerReport(partsJson: string | Uint8Array): string {
  return `${JSON.stringify({
    schema: FIX_LEDGER_REPORT_SPEC,
    build: { dir: `${EXAMPLE_LEDGER_DRAFT}/out`, manifest_sha256: sha(partsJson) },
    script_sha256: sha(SCRIPT),
    rows: [{ id: ROW.id, result: 'pass', measured: 24, bar: ROW.bar, reason: null }],
  }, null, 2)}\n`;
}

/** Record the ledger row and the draft that passes it, each at its declared example instant. Returns the files it wrote. */
export function writeExampleLedger(dir: string, files: Record<string, string | Uint8Array>, clock: { now: number }): Record<string, string | Uint8Array> {
  const written: Record<string, string | Uint8Array> = {};
  const write = (path: string, bytes: string | Uint8Array): void => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes); written[path] = bytes; };
  write('words.txt', `${ROW.verbatim}\n`);
  clock.now = Date.parse(exampleTime('2026-11-16T10:00:00Z'));
  ledgerCommand(['add', ROW.id, dir, '--by', 'agent', '--check', ROW.check, '--bar', ROW.bar, '--note', ROW.note, '--verbatim-file', join(dir, 'words.txt')], clock.now);
  // The rebuilt draft carries the same synthetic producer bytes under its own labelled root.
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith(`${EXAMPLE_DRAFT}/`)) continue;
    const copy = `${EXAMPLE_LEDGER_DRAFT}/${path.slice(EXAMPLE_DRAFT.length + 1)}`;
    write(copy, bytes);
  }
  write(EXAMPLE_LEDGER_REPORT, exampleLedgerReport(files[`${EXAMPLE_DRAFT}/input/parts.json`]!));
  clock.now = Date.parse(exampleTime('2026-11-16T10:05:00Z'));
  draftRigCommand(['lantern', dir, '--config', `${EXAMPLE_LEDGER_DRAFT}/config.json`, '--from', `${EXAMPLE_LEDGER_DRAFT}/out`,
    '--parts', `${EXAMPLE_LEDGER_DRAFT}/input`, '--ledger-report', EXAMPLE_LEDGER_REPORT], clock.now);
  delete written['words.txt'];
  return written;
}
