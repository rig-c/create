import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import type { CheckReport } from '../src/check.ts';
import { interviewOptionsCommand } from '../src/choice-writers.ts';
import { optionContext } from '../src/choices.ts';
import { diffClassesCommand } from '../src/diff-classes.ts';
import { interviewCommand } from '../src/interview.ts';
import { PARTS_CHECK_SPEC } from '../src/parts-check.ts';
import { PARTS_CLI_RECEIPT } from '../src/parts-verdict-record.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { recordCommand } from '../src/record.ts';
import { signoffCommand } from '../src/signoff.ts';
import { sorted } from '../src/step-hash.ts';
import { currentPartsReviewContext } from '../src/structure.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import { TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import { seedStoredPartsSignoff } from './historical-review-fixture.ts';

const chain = join(TEMPLATES_DIR, 'example-chain');
const stage = 'parts-review';
const draft = 'chain';
const staged = 'outputs/parts.next';
const manifest = 'rig/parts.json';
const config = 'specs/rig/synthetic-current-parts.json';
const source = 'inputs/synthetic-current-parts.png';
const layers = 'inputs/synthetic-current-parts-layers/layers.json';
const owner = 'synthetic-owner';
const operator = 'synthetic-operator';
const iso = (at: number): string => new Date(at).toISOString();
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const json = (file: string): JsonObject => JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
const project = (dir: string): JsonObject => json(join(dir, 'project.json'));

function put(dir: string, path: string, bytes: string): string {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return sha(bytes);
}

function check(dir: string, at: number) {
  const result = interviewCommand(['--check', dir, '--json'], at);
  const { refusals } = JSON.parse(result.stdout) as CheckReport;
  return { exit: result.exit, refusals: refusals.map(({ code, path }) => ({ code, path })) };
}

function partsReviewProject(): string {
  const dir = tempDir('current-parts-signoff-');
  cpSync(join(chain, 'checkpoints/1-parts-verdict'), dir, { recursive: true });
  expect(advanceCommand([stage, dir, '--parts-check', 'evidence/parts-check.json',
    '--parts', 'derived/drafts/chain/input'], EXAMPLE_NOW).exit).toBe(0);
  expect(project(dir).stage).toBe(stage);
  expect(check(dir, EXAMPLE_NOW)).toEqual({ exit: 0, refusals: [] });
  return dir;
}

function approveNumberedParts(dir: string) {
  const diff = 'evidence/diff-components.json';
  cpSync(join(chain, diff), join(dir, diff));
  const components = arr(json(join(dir, diff)).components).map(component => String(obj(component).id));
  expect(diffClassesCommand([dir, '--diff-report', diff, '--by', 'agent', ...components.flatMap(id =>
    ['--component', `${id}=in-painting:the synthetic painting contains this component`])], EXAMPLE_NOW + 1000).exit).toBe(0);
  const receipt = recordPartsReceipt(dir, draft, EXAMPLE_NOW + 2000);
  expect(structureSnapshotCommand([dir, '--draft', draft]).exit).toBe(0);
  const before = project(dir);
  const words = 'Approve the synthetic numbered parts.\n';
  put(dir, 'numbered-approval.txt', words);
  refusesUnchanged(dir, 'NUMBERED_WRITER_REMOVED', () => signoffCommand([stage, dir, '--draft', draft,
    '--structure-file', 'evidence/structure-chain.json', '--by', owner,
    '--verbatim-file', join(dir, 'numbered-approval.txt'), '--json'], EXAMPLE_NOW + 3000));
  const signed = seedStoredPartsSignoff(dir, draft, {
    by: owner,
    at: EXAMPLE_NOW + 3000,
    verbatim: words,
    structureFile: 'evidence/structure-chain.json',
  });
  expect(signed).toMatchObject({ stage, checkpoint: null, by: owner, verbatim: words, draft_id: draft,
    evidence: { ...obj(receipt.evidence), spec: PARTS_CLI_RECEIPT } });
  expect(signed.target).toBeUndefined();
  expect(project(dir)).toEqual({ ...before, signoffs: [...arr(before.signoffs), signed] });
  return signed;
}

/** Artificial producer records seal the exact fixture bytes; create writes the project record. */
function recordParts(dir: string, revision: number, at: number) {
  const configHash = put(dir, config, '{"meshes":{"synthetic-panel":{"density":2}}}\n');
  const sourceHash = put(dir, source, 'synthetic source bytes\n');
  const layersHash = put(dir, layers, '{"layers":[]}\n');
  const manifestHash = put(dir, `${staged}/${manifest}`, JSON.stringify({ revision, parts: [] }));
  put(dir, `${staged}/run.json`, JSON.stringify({
    spec: 'rig-run/1', package: { name: '@rig-c/parts', version: PINNED_PACKAGES['@rig-c/parts'] }, command: 'assemble',
    started_at: iso(at), finished_at: iso(at), config: { path: config, sha256: configHash },
    inputs: [{ role: 'source', path: source, sha256: sourceHash }, { role: 'full', path: layers, sha256: layersHash }],
    outputs: [{ path: manifest, sha256: manifestHash }],
  }));
  put(dir, `${staged}/check/parts-check.json`, JSON.stringify({
    spec: PARTS_CHECK_SPEC, stage: 'parts', inputs: [{ path: 'parts.json', status: 'read', sha256: manifestHash }],
    parts: {}, refusals: [], reported: [], holes: [], exit_code: 0,
  }));
  expect(recordCommand(['parts', dir, '--from', staged, '--config', config], at).exit).toBe(0);
  expect(existsSync(join(dir, staged))).toBe(false);
  expect(sha(readFileSync(join(dir, 'outputs/parts', manifest)))).toBe(manifestHash);
  const parts = obj(obj(project(dir).current).parts);
  return { subject: 'current.parts', record_sha256: sha(JSON.stringify(sorted(parts))), files_sha256: parts.files_sha256 };
}

function snapshot(dir: string, target: ReturnType<typeof recordParts>) {
  const file = join(dir, 'project.json');
  const before = readFileSync(file);
  expect(structureSnapshotCommand([dir]).exit).toBe(0);
  expect(readFileSync(file)).toEqual(before);
  const path = `evidence/structure/current-parts/${target.record_sha256}.json`;
  const bytes = readFileSync(join(dir, path));
  expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ target,
    entries: [{ path: '/meshes/synthetic-panel', value: { density: 2 } }] });
  return { path, sha256: sha(bytes) };
}

function relay(dir: string, structure: string, at: number, words: string) {
  put(dir, 'current-approval.txt', words);
  const saidAt = iso(at - 500);
  const flags = [['--owner-chat', join(dir, 'current-approval.txt')], ['--said-at', saidAt], ['--relayed-by', operator]];
  return { saidAt, args: (omitted?: string) => [stage, dir, '--by', owner, '--json', '--structure-file', structure,
    ...flags.filter(([flag]) => flag !== omitted).flat()] };
}

function refusesUnchanged(dir: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  expect(action).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

test('current parts requires every owner relay flag, refuses a draft, and signs the exact retained output without a receipt', () => {
  const dir = partsReviewProject();
  const target = recordParts(dir, 1, EXAMPLE_NOW + 1000);
  const structure = snapshot(dir, target);
  const signedAt = EXAMPLE_NOW + 2000;
  const words = '  Approve these synthetic parts.\r\n\r\n';
  const chat = relay(dir, structure.path, signedAt, words);
  const before = project(dir);
  expect(arr(before.review_acts ?? [])).toEqual([]);
  refusesUnchanged(dir, 'OWNER_CHAT_REQUIRED', () => signoffCommand([
    stage, dir, '--by', owner, '--structure-file', structure.path,
  ], signedAt));
  for (const omitted of ['--owner-chat', '--said-at', '--relayed-by']) {
    refusesUnchanged(dir, 'OWNER_CHAT_REQUIRED', () => signoffCommand(chat.args(omitted), signedAt));
  }
  refusesUnchanged(dir, 'NUMBERED_WRITER_REMOVED', () => signoffCommand([...chat.args(), '--draft', draft], signedAt));

  const result = signoffCommand(chat.args(), signedAt);
  expect(result.exit).toBe(0);
  const signed = { stage, checkpoint: null, by: owner, at: iso(signedAt), verbatim: words,
    source: 'owner chat, relayed', said_at: chat.saidAt, relayed_by: operator, target, structure };
  expect(JSON.parse(result.stdout)).toEqual(signed);
  expect(project(dir)).toEqual({ ...before, signoffs: [...arr(before.signoffs), signed] });
  expect(check(dir, signedAt)).toEqual({ exit: 0, refusals: [] });
});

test('replacing approved current parts stales only its active signature and blocks new numbered options until reapproval', () => {
  const dir = partsReviewProject();
  approveNumberedParts(dir);
  const firstAt = EXAMPLE_NOW + 5000;
  const rigging = 'rigging-interview';
  const numbered = optionContext(project(dir), rigging, firstAt, dir);
  expect(numbered).toMatchObject({ kind: 'parts', draft_id: draft });
  const first = recordParts(dir, 1, firstAt - 1000);
  const firstStructure = snapshot(dir, first);
  const firstChat = relay(dir, firstStructure.path, firstAt, 'Approve synthetic parts revision one.');
  expect(signoffCommand(firstChat.args(), firstAt).exit).toBe(0);
  expect(optionContext(project(dir), rigging, firstAt, dir)).toMatchObject({ kind: 'current-parts', target: first });
  expect(check(dir, firstAt)).toEqual({ exit: 0, refusals: [] });

  const approved = project(dir);
  const signoffs = arr(approved.signoffs);
  const stalePath = `signoffs[${signoffs.length - 1}].target`;
  const rebuiltAt = firstAt + 1000;
  const current = recordParts(dir, 2, rebuiltAt);
  expect(current.record_sha256).not.toBe(first.record_sha256);
  expect(current.files_sha256).not.toBe(first.files_sha256);
  expect(project(dir).signoffs).toEqual(signoffs);
  expect(check(dir, rebuiltAt)).toEqual({ exit: 1, refusals: [{ code: 'SIGNOFF_TARGET_STALE', path: stalePath }] });
  expect(() => optionContext(project(dir), rigging, rebuiltAt, dir)).toThrow(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE' }));

  const optionPath = 'evidence/interview/synthetic-numbered-after-rebuild.json';
  const set = { ...json(join(chain, 'evidence/interview/meshes.json')), id: 'synthetic-numbered-after-rebuild',
    drafted_at: iso(rebuiltAt), context: numbered };
  put(dir, optionPath, JSON.stringify(set));
  refusesUnchanged(dir, 'INTERVIEW_OPTIONS_STALE', () => interviewOptionsCommand(['meshes', dir, '--file', optionPath], rebuiltAt));

  const structure = snapshot(dir, current);
  const signedAt = rebuiltAt + 1000;
  const chat = relay(dir, structure.path, signedAt, 'Approve synthetic parts revision two.');
  const result = signoffCommand(chat.args(), signedAt);
  expect(result.exit).toBe(0);
  const signed = JSON.parse(result.stdout) as JsonObject;
  expect(signed).toMatchObject({ at: iso(signedAt), target: current, structure });
  expect(project(dir).signoffs).toEqual([...signoffs, signed]);
  expect(project(dir).review_acts).toEqual(approved.review_acts!);
  expect(check(dir, signedAt)).toEqual({ exit: 0, refusals: [] });
  expect(optionContext(project(dir), rigging, signedAt, dir)).toMatchObject({
    kind: 'current-parts', target: current, signoff_at: iso(signedAt), structure,
  });
});

test('a project without current still records the numbered draft and verdict through the existing writer', () => {
  const dir = partsReviewProject();
  expect(project(dir).current).toBeUndefined();
  approveNumberedParts(dir);
  expect(project(dir).current).toBeUndefined();
  expect(check(dir, EXAMPLE_NOW + 3000)).toEqual({ exit: 0, refusals: [] });
});

test('current parts options use the replacement and the historical signature still checks its retained snapshot', () => {
  const dir = tempDir('current-parts-history-');
  cpSync(join(TEMPLATES_DIR, 'example-current'), dir, { recursive: true });
  const first = recordParts(dir, 1, EXAMPLE_NOW + 1000);
  const firstStructure = snapshot(dir, first);
  const signedAt = EXAMPLE_NOW + 2000;
  const chat = relay(dir, firstStructure.path, signedAt, 'Approve synthetic parts revision one.');
  expect(signoffCommand(chat.args(), signedAt).exit).toBe(0);
  expect(check(dir, signedAt)).toEqual({ exit: 0, refusals: [] });
  const signed = project(dir);
  const signatureIndex = arr(signed.signoffs).length - 1;

  const replacedAt = signedAt + 1000;
  const current = recordParts(dir, 2, replacedAt);
  const structure = snapshot(dir, current);
  expect(project(dir).signoffs).toEqual(signed.signoffs!);
  expect(check(dir, replacedAt)).toEqual({ exit: 0, refusals: [] });
  const context = optionContext(project(dir), 'rigging-interview', replacedAt, dir);
  expect(context).toMatchObject({ kind: 'current-parts', target: current, structure });
  expect(context).not.toHaveProperty('signoff_at');
  expect(currentPartsReviewContext(dir, project(dir), replacedAt)).toBeNull();
  const runPath = join(dir, 'outputs/parts/run.json');
  const run = readFileSync(runPath);
  writeFileSync(runPath, '{}');
  expect(() => currentPartsReviewContext(dir, project(dir), replacedAt))
    .toThrow(expect.objectContaining({ code: 'STRUCTURE_DECISIONS_INVALID' }));
  writeFileSync(runPath, run);

  put(dir, firstStructure.path, '{}');
  expect(check(dir, replacedAt)).toEqual({ exit: 1, refusals: [{
    code: 'STRUCTURE_DECISIONS_INVALID', path: `signoffs[${signatureIndex}].structure`,
  }] });
});
