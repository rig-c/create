import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { partsReviewCommand } from '../src/parts-review.ts';
import { checkProject } from '../src/check.ts';
import { partsReadFindings, latestPartsVerdictFinding, PARTS_CLI_RECEIPT, recordedPartsVerdict, recordedPartsFinding, PARTS_VERDICT_RECEIPT_SINCE } from '../src/parts-verdict-record.ts';
import { signoffCommand } from '../src/signoff.ts';
import { Refusal } from '../src/refusal.ts';
import { jobHash } from '../src/job-outbox.ts';
import type { JsonObject } from '../src/templates.ts';

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
  const result = partsReviewCommand(args(root), EXAMPLE_NOW, { runCli: (argv, cwd) => {
    expect(argv).toEqual(['parts', 'opaque/input', '--verdict', 'never-created.json', '--format', 'json']);
    expect(cwd).toBe(root);
    return { stdout: bytes, exit: 0 };
  } });
  return { result, bytes, receipt: JSON.parse(result.stdout) as JsonObject };
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
  test(`${label} refuses without changing the record`, () => {
    const root = fixture();
    refuses(root, 'PARTS_REVIEW_CLI_INVALID', () => partsReviewCommand(args(root), EXAMPLE_NOW, { runCli: () => ({ stdout: Buffer.from(stdout), exit: 0 }) }));
  });
}

for (const path of ['/absolute/file', '../escape', 'inside/../../escape', 'C:\\escape', '--verdict=/absolute/file']) {
  test(`unsafe CLI argument ${path} refuses before invoking the runner`, () => {
    const root = fixture();
    refuses(root, 'PARTS_REVIEW_CLI_ARGUMENT_INVALID', () => partsReviewCommand([...args(root), path], EXAMPLE_NOW, { runCli: () => { throw Error('must not run'); } }));
  });
}

test('CLI failure carries its code and diagnostic and writes nothing', () => {
  const root = fixture();
  refuses(root, 'PARTS_REVIEW_CLI_FAILED', () => partsReviewCommand(args(root), EXAMPLE_NOW, { runCli: () => ({ stdout: Buffer.alloc(0), stderr: 'PARTS_VERDICT_UNAVAILABLE: save a verdict first\n', exit: 1 }) }));
  try { partsReviewCommand(args(root), EXAMPLE_NOW, { runCli: () => ({ stdout: Buffer.alloc(0), stderr: 'PARTS_VERDICT_UNAVAILABLE: save a verdict first\n', exit: 1 }) }); }
  catch (error) { expect((error as Error).message).toContain('PARTS_VERDICT_UNAVAILABLE: save a verdict first'); }
});

test('invalid human and unknown draft refuse without writing', () => {
  const root = fixture();
  refuses(root, 'SIGNOFF_NOT_HUMAN', () => partsReviewCommand(args(root).map(arg => arg === 'user' ? 'agent' : arg), EXAMPLE_NOW));
  refuses(root, 'PARTS_VERDICT_RECEIPT_INVALID', () => partsReviewCommand(args(root).map(arg => arg === 'chain' ? 'unknown' : arg), EXAMPLE_NOW, { runCli: () => ({ stdout: Buffer.from(JSON.stringify(response(root))), exit: 0 }) }));
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

test('evidence tampering between storage and commit refuses and cleans its new file', () => {
  const root = fixture();
  let evidence = '';
  refuses(root, 'PARTS_VERDICT_RECEIPT_INVALID', () => partsReviewCommand(args(root), EXAMPLE_NOW, {
    runCli: () => ({ stdout: Buffer.from(JSON.stringify(response(root))), exit: 0 }),
    afterEvidence: path => { evidence = path; writeFileSync(path, '{}'); },
  }));
  expect(existsSync(evidence)).toBe(false);
});

test('latest changes-requested receipt blocks the signoff writer before it writes', () => {
  const root = fixture();
  record(root, response(root, 'changes-requested'));
  refuses(root, 'PARTS_VERDICT_LATEST_NOT_APPROVED', () => signoffCommand(['parts-review', root, '--by', 'user', '--draft', 'chain',
    '--structure-file', 'evidence/structure.json', '--verbatim-file', 'unused'], EXAMPLE_NOW));
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
  expect(structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/structure-api.json']).exit).toBe(0);
  record(root, response(root, 'pending'));
  refuses(root, 'PARTS_VERDICT_NOT_APPROVED', () => structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/missing.json']));
  expect(existsSync(join(root, 'evidence/missing.json'))).toBe(false);
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

test('new snapshot and signoff writers require the ignored draft source bytes', () => {
  const root = fixture();
  record(root, response(root));
  rmSync(join(root, 'derived/drafts/chain/input'), { recursive: true });
  refuses(root, 'PARTS_VERDICT_RECEIPT_INVALID', () => structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/unwritten.json']));
  expect(existsSync(join(root, 'evidence/unwritten.json'))).toBe(false);
  refuses(root, 'PARTS_VERDICT_RECEIPT_INVALID', () => signoffCommand(['parts-review', root, '--by', 'user', '--draft', 'chain', '--structure-file', 'evidence/unwritten.json'], EXAMPLE_NOW));
});
