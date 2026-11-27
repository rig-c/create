import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { main } from '../src/cli.ts';
import { checkProject } from '../src/check.ts';
import { assertPartsCliArgs, assertPartsReadDraft, decodePartsRead, partsReadFindings, partsVerdictNames, latestPartsVerdictFinding, PARTS_CLI_RECEIPT, recordedPartsVerdict, recordedPartsFinding, PARTS_VERDICT_RECEIPT_SINCE } from '../src/parts-verdict-record.ts';
import { ReviewReadError, storeReviewRead } from '../src/review-read.ts';
import { signoffCommand } from '../src/signoff.ts';
import { Refusal, refuse } from '../src/refusal.ts';
import { jobHash } from '../src/job-outbox.ts';
import type { JsonObject } from '../src/templates.ts';
import { seedStoredPartsSignoff } from './historical-review-fixture.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function read(root: string): JsonObject { return JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')); }
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-cli-parts-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), root, { recursive: true });
  return root;
}
function response(root: string, status = 'approved'): JsonObject {
  const draft = (read(root).drafts as JsonObject[])[0]!;
  const parts = draft.parts as JsonObject;
  return { schema: 'rig-review-parts-verdict/2', tool: { name: '@rig-c/review', version: '2.5.0' },
    source: { sha256: 'a'.repeat(64), files: (parts.files as JsonObject[]).map(file => ({ sha256: file.sha256, path: 'opaque/frame' })) },
    status, parts: { 'synthetic part': { outcome: status === 'changes-requested' ? 'flagged' : status === 'pending' ? 'pending' : 'clean', note: '  Exact note.\r\n' } } };
}
const args = (root: string) => [root, '--draft', 'chain', '--from-review-cli', '--by', 'user', '--json', '--', 'opaque/input', '--verdict', 'never-created.json'];
function record(root: string, value: JsonObject) {
  const bytes = Buffer.from(` ${JSON.stringify(value)}\n`);
  const extra = args(root).slice(args(root).indexOf('--') + 1);
  assertPartsCliArgs(extra);
  const decoded = decodePartsRead(bytes);
  const project = read(root);
  assertPartsReadDraft(root, project, decoded, 'chain');
  let stored;
  try {
    stored = storeReviewRead(root, bytes);
  } catch (error) {
    if (error instanceof ReviewReadError) refuse('PARTS_REVIEW_EVIDENCE_CONFLICT', error.message);
    throw error;
  }
  const existing = Array.isArray(project.review_acts)
    ? (project.review_acts as JsonObject[]).find(row => row.draft_id === 'chain' && (row.evidence as JsonObject | undefined)?.sha256 === stored.file.sha256)
    : undefined;
  if (existing) return { bytes, receipt: existing };
  const names = partsVerdictNames(decoded);
  const receipt: JsonObject = {
    schema: PARTS_CLI_RECEIPT,
    kind: 'parts-verdict',
    route: 'cli',
    draft_id: 'chain',
    argv: extra,
    evidence: { path: stored.file.path, sha256: stored.file.sha256 },
    tool: decoded.tool!,
    status: decoded.status!,
    flagged: names.flagged,
    noted: names.noted,
    by: 'user',
    at: new Date(EXAMPLE_NOW).toISOString(),
  };
  project.review_acts = [...(Array.isArray(project.review_acts) ? project.review_acts : []), receipt];
  writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return { bytes, receipt };
}
function refuses(root: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(root, 'project.json'));
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Refusal);
  expect((caught as Refusal).code).toBe(code);
  expect(readFileSync(join(root, 'project.json')).equals(before)).toBe(true);
}

for (const status of ['approved', 'changes-requested', 'pending']) {
  test(`CLI ${status} records exact stdout and checks without reading opaque paths`, () => {
    const root = fixture();
    const baseline = checkProject(root, undefined, { now: EXAMPLE_NOW }).refusals;
    const { bytes, receipt } = record(root, response(root, status));
    expect(receipt.route).toBe('cli');
    expect(receipt.schema).toBe(PARTS_CLI_RECEIPT);
    expect(receipt.status).toBe(status);
    expect(receipt.flagged).toEqual(status === 'changes-requested' ? ['synthetic part'] : []);
    expect(receipt.noted).toEqual(['synthetic part']);
    expect(receipt.argv).toEqual(args(root).slice(args(root).indexOf('--') + 1));
    const evidence = receipt.evidence as JsonObject;
    expect(evidence.sha256).toBe(jobHash(bytes));
    expect(readFileSync(join(root, String(evidence.path))).equals(bytes)).toBe(true);
    expect(partsReadFindings(root, read(root))).toEqual([]);
    expect(checkProject(root, undefined, { now: EXAMPLE_NOW }).refusals).toEqual(baseline);
    expect(existsSync(join(root, 'never-created.json'))).toBe(false);
  });
}

test('same response is a byte-identical no-op, new response appends and latest verdict governs', () => {
  const root = fixture();
  const rejected = response(root, 'changes-requested');
  record(root, rejected);
  const before = readFileSync(join(root, 'project.json'));
  record(root, rejected);
  expect(readFileSync(join(root, 'project.json')).equals(before)).toBe(true);
  expect(latestPartsVerdictFinding(read(root), 'chain', 'signoffs[0].draft_id')?.code).toBe('PARTS_VERDICT_LATEST_NOT_APPROVED');
  record(root, response(root));
  expect((read(root).review_acts as JsonObject[]).length).toBe(2);
  expect(latestPartsVerdictFinding(read(root), 'chain', 'signoffs[0].draft_id')).toBeUndefined();
  record(root, rejected);
  expect((read(root).review_acts as JsonObject[]).length).toBe(2);
});

test('a source mismatch refuses with unchanged project bytes', () => {
  const root = fixture();
  const value = response(root);
  ((value.source as JsonObject).files as JsonObject[])[0]!.sha256 = 'b'.repeat(64);
  refuses(root, 'PARTS_VERDICT_DRAFT_MISMATCH', () => record(root, value));
});

test('source multiplicity is compared, outputs are optional, painting occurrences are excluded', () => {
  const root = fixture();
  const value = response(root);
  const project = read(root);
  const draft = (project.drafts as JsonObject[])[0]!;
  const files = (draft.parts as JsonObject).files as JsonObject[];
  const painting = files.find(file => String(file.path).endsWith('/painting_in_rig.png'))!;
  const output = (draft.files as JsonObject[])[0]!;
  const source = (value.source as JsonObject).files as JsonObject[];
  source.push({ sha256: painting.sha256 }, { sha256: painting.sha256 }, { sha256: output.sha256 });
  record(root, value);
  const duplicate = response(root);
  ((duplicate.source as JsonObject).files as JsonObject[]).push({ sha256: files.find(file => file !== painting)!.sha256 });
  refuses(root, 'PARTS_VERDICT_DRAFT_MISMATCH', () => record(root, duplicate));
});

for (const [label, stdout] of [
  ['non-JSON', 'no'], ['unsupported schema', '{"schema":"unsupported"}'], ['invalid UTF-8', Buffer.from([0xff])],
] as const) {
  test(`${label} refuses in decodePartsRead without changing the record`, () => {
    const root = fixture();
    refuses(root, 'PARTS_REVIEW_CLI_INVALID', () => decodePartsRead(Buffer.from(stdout)));
  });
}

for (const path of ['/absolute/file', '../escape', 'inside/../../escape', 'C:\\escape', '--verdict=/absolute/file']) {
  test(`unsafe CLI argument ${path} refuses in assertPartsCliArgs`, () => {
    const root = fixture();
    refuses(root, 'PARTS_REVIEW_CLI_ARGUMENT_INVALID', () => assertPartsCliArgs([path]));
  });
}

test('parts-review CLI writer is retired with NUMBERED_WRITER_REMOVED and exit 2', () => {
  const root = fixture();
  const before = readFileSync(join(root, 'project.json'));
  expect(main(['parts-review', ...args(root)], EXAMPLE_NOW)).toBe(2);
  expect(readFileSync(join(root, 'project.json')).equals(before)).toBe(true);
});

test('unknown draft refuses in assertPartsReadDraft without writing', () => {
  const root = fixture();
  refuses(root, 'PARTS_VERDICT_RECEIPT_INVALID', () => assertPartsReadDraft(root, read(root), response(root), 'unknown'));
});

test('retained stdout hash and copied receipt fields are checked', () => {
  const root = fixture();
  const { receipt } = record(root, response(root));
  const project = read(root);
  (project.review_acts as JsonObject[])[0]!.status = 'changes-requested';
  expect(partsReadFindings(root, project).map(f => f.code)).toEqual(['PARTS_VERDICT_RECEIPT_INVALID']);
  writeFileSync(join(root, String((receipt.evidence as JsonObject).path)), '{}');
  expect(partsReadFindings(root, read(root)).map(f => f.code)).toEqual(['PARTS_VERDICT_RECEIPT_INVALID']);
});

test('latest changes-requested receipt blocks parts-review signoff gate and numbered signoff refuses exit 2', () => {
  const root = fixture();
  record(root, response(root, 'changes-requested'));
  refuses(root, 'NUMBERED_WRITER_REMOVED', () => signoffCommand(['parts-review', root, '--by', 'user', '--draft', 'chain',
    '--structure-file', 'evidence/structure.json', '--verbatim-file', 'unused'], EXAMPLE_NOW));
  refuses(root, 'PARTS_VERDICT_LATEST_NOT_APPROVED', () => seedStoredPartsSignoff(root, 'chain', {
    by: 'user', at: EXAMPLE_NOW, verbatim: 'Approve', structureFile: 'evidence/structure.json',
  }));
});

test('current signatures refuse a latest changes request while earlier signatures warn', () => {
  const root = fixture();
  record(root, response(root, 'changes-requested'));
  for (const [at, current] of [['2026-11-08T00:00:00Z', true], ['2026-11-07T23:59:59Z', false]] as const) {
    const project = read(root);
    (project.signoffs as JsonObject[]).push({ stage: 'parts-review', checkpoint: null, draft_id: 'chain', by: 'user', at, verbatim: 'Synthetic approval.' });
    const report = checkProject(root, project, { now: EXAMPLE_NOW });
    expect(report.refusals.some(f => f.code === 'PARTS_VERDICT_LATEST_NOT_APPROVED')).toBe(current);
    expect(report.warnings.some(f => f.code === 'PARTS_VERDICT_LATEST_NOT_APPROVED')).toBe(!current);
  }
});

test('unsafe evidence directory refuses without writing or traversing its link', () => {
  const root = fixture();
  const target = realpathSync(mkdtempSync(join(tmpdir(), 'create-cli-evidence-')));
  roots.push(target);
  symlinkSync(target, join(root, 'evidence/review-reads'));
  refuses(root, 'PARTS_REVIEW_EVIDENCE_CONFLICT', () => record(root, response(root)));
});

test('checker rejects an overridden format retained in argv', () => {
  const root = fixture();
  record(root, response(root));
  const project = read(root);
  (project.review_acts as JsonObject[])[0]!.argv = ['opaque', '--format=json'];
  expect(partsReadFindings(root, project).map(f => f.code)).toEqual(['PARTS_REVIEW_CLI_ARGUMENT_INVALID']);
});

for (const flag of ['--evidence', '--evidence=unread.json']) {
  test(`signoff rejects removed ${flag} with exit 2 before writing`, () => {
    const root = fixture();
    const before = readFileSync(join(root, 'project.json'));
    let error: unknown;
    try { signoffCommand(['parts-review', root, flag, 'unread.json'], EXAMPLE_NOW); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe('PARTS_VERDICT_FILE_ROUTE_REMOVED');
    expect((error as Refusal).exitCode).toBe(2);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  });
}

for (const flag of ['--verdict', '--verdict=unread.json']) {
  test(`snapshot rejects removed ${flag} with exit 2 before writing`, () => {
    const root = fixture();
    const before = readFileSync(join(root, 'project.json'));
    let error: unknown;
    try { structureSnapshotCommand([root, '--draft', 'chain', flag, 'unread.json', '--out', 'evidence/new/structure.json']); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe('PARTS_VERDICT_FILE_ROUTE_REMOVED');
    expect((error as Refusal).exitCode).toBe(2);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    expect(existsSync(join(root, 'evidence/new'))).toBe(false);
  });
}

test('receipt consumers select the latest response and retain a historical approved binding', () => {
  const root = fixture();
  record(root, response(root));
  const approved = recordedPartsVerdict(root, read(root), 'chain');
  expect(approved.evidence.spec).toBe(PARTS_CLI_RECEIPT);
  expect(structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/structure-chain.json']).exit).toBe(0);
  record(root, response(root, 'pending'));
  expect(structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/structure-chain-1.json']).exit).toBe(0);
  expect(existsSync(join(root, 'evidence/structure-chain-1.json'))).toBe(true);
  expect(recordedPartsFinding(root, read(root), { draft_id: 'chain', at: new Date(EXAMPLE_NOW).toISOString(), evidence: approved.evidence }, 'signoffs[0]')).toBeUndefined();
  refuses(root, 'PARTS_VERDICT_RECEIPT_INVALID', () => recordedPartsVerdict(root, read(root), 'chain', { ...approved.evidence, spec: 'unknown/1' }));
  refuses(root, 'PARTS_VERDICT_RECEIPT_INVALID', () => recordedPartsVerdict(root, read(root), 'chain', { ...approved.evidence, sha256: '0'.repeat(64) }));
  expect(recordedPartsFinding(root, read(root), { draft_id: 'chain', at: '2026-11-07T00:00:00Z', evidence: { ...approved.evidence, sha256: '0'.repeat(64) } }, 'signoffs[0]')?.code).toBe('PARTS_VERDICT_RECEIPT_INVALID');
});

for (const at of [new Date(Date.parse(PARTS_VERDICT_RECEIPT_SINCE) - 1).toISOString(), PARTS_VERDICT_RECEIPT_SINCE]) {
  test(`saved-file history at ${at} is dated without reading its file`, () => {
    const root = fixture();
    const project = read(root);
    const signoff = { stage: 'parts-review', checkpoint: null, draft_id: 'chain', by: 'user', at, verbatim: 'Synthetic approval.',
      evidence: { kind: 'parts-verdict', path: 'never-created.json', sha256: 'a'.repeat(64) } };
    (project.signoffs as JsonObject[]).push(signoff);
    const before = readFileSync(join(root, 'project.json'));
    const report = checkProject(root, project, { now: EXAMPLE_NOW });
    if (at === PARTS_VERDICT_RECEIPT_SINCE) expect(report.refusals.map(f => f.code)).toContain('PARTS_VERDICT_RECEIPT_REQUIRED');
    else {
      expect(report.warnings.map(f => f.code)).toContain('PARTS_VERDICT_FILE_LEGACY');
      expect(report.refusals.map(f => f.code)).not.toContain('PARTS_VERDICT_RECEIPT_REQUIRED');
    }
    expect(existsSync(join(root, 'never-created.json'))).toBe(false);
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  });
}

test('historical receipt checking warns when ignored draft bytes are unavailable', () => {
  const root = fixture();
  record(root, response(root));
  const selected = recordedPartsVerdict(root, read(root), 'chain');
  rmSync(join(root, 'derived/drafts/chain/input'), { recursive: true });
  expect(recordedPartsFinding(root, read(root), { draft_id: 'chain', at: new Date(EXAMPLE_NOW).toISOString(), evidence: selected.evidence }, 'signoffs[0]')).toBeUndefined();
  const report = checkProject(root, undefined, { now: EXAMPLE_NOW });
  expect(report.warnings.map(f => f.code)).toContain('DRAFT_RIG_UNAVAILABLE');
  expect(report.refusals.map(f => f.code)).not.toContain('PARTS_VERDICT_RECEIPT_INVALID');
});

test('snapshot copies retained config while recordedPartsVerdict still requires ignored draft source bytes', () => {
  const root = fixture();
  record(root, response(root));
  rmSync(join(root, 'derived/drafts/chain/input'), { recursive: true });
  expect(structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/structure-chain.json']).exit).toBe(0);
  expect(existsSync(join(root, 'evidence/structure-chain.json'))).toBe(true);
  refuses(root, 'NUMBERED_WRITER_REMOVED', () => signoffCommand(['parts-review', root, '--by', 'user', '--draft', 'chain', '--structure-file', 'evidence/structure-chain.json'], EXAMPLE_NOW));
  refuses(root, 'PARTS_VERDICT_RECEIPT_INVALID', () => seedStoredPartsSignoff(root, 'chain', {
    by: 'user', at: EXAMPLE_NOW, verbatim: 'Approve', structureFile: 'evidence/structure-chain.json',
  }));
});
