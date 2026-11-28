import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nextProject } from '../src/next.ts';
import { checkProject, type Finding } from '../src/check.ts';
import { validateCorrectionIdentity } from '../src/corrections.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { validateDirectionRig } from '../src/direction.ts';
import { assembleOnlyVersionFinding } from '../src/draft-layout.ts';
import { checkDrafts } from '../src/drafts.ts';
import { checkFixLedger, FIX_LEDGER_REPORT_SPEC } from '../src/fix-ledger.ts';
import { assertRequestedRig } from '../src/job-host.ts';
import { recordedPartsVerdict } from '../src/parts-verdict-record.ts';
import { handoffCommand } from '../src/review.ts';
import { checkSignoffTarget } from '../src/signoff-target.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, retimeFixture } from './fixtures.ts';
import { seedRetainedDraft } from './numbered-seed.ts';
import { seedPartsCliReceipt } from './parts-receipt-fixture.ts';

const now = Date.parse('2026-11-20T12:00:00Z');
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function write(dir: string, path: string, bytes: string): void {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function read(dir: string): JsonObject {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
}

function stage(dir: string, id: string, layout: 'assemble' | 'flat' | 'build' | 'standalone' = 'assemble') {
  const root = `derived/drafts/${id}`;
  const out = `${root}/out`;
  const config = `${root}/config.json`;
  const parts = layout === 'assemble' ? `${out}/rig` : layout === 'standalone' ? `${root}/input` : out;
  const stack = layout === 'assemble' ? `${out}/render/recomposite_rig.png` : `${parts}/recomposite_rig.png`;
  const manifest = `${parts}/parts.json`;
  const image = `${parts}/parts/sample.png`;
  const stamp = `${out}/run.json`;
  const args = [id, dir, '--config', config, '--from', out, '--json'];
  write(dir, config, '{}');
  write(dir, manifest, '{"parts":[{"name":"sample"}]}');
  write(dir, image, 'synthetic parts PNG');
  write(dir, stack, 'synthetic recomposite PNG');
  const file = (path: string) => ({ path: path.slice(out.length + 1), sha256: sha(readFileSync(join(dir, path))) });
  if (layout === 'assemble') {
    const at = new Date(now).toISOString();
    write(dir, stamp, JSON.stringify({
      spec: 'rig-run/1', package: { name: '@rig-c/parts', version: '2.45.0' }, command: 'assemble',
      started_at: at, finished_at: at, config: { path: '../config.json', sha256: sha('{}') },
      inputs: [{ role: 'source', path: 'input.png', sha256: sha('source') }, { role: 'full', path: '.', sha256: sha('layers') }],
      outputs: [stack, manifest, image].map(file),
    }));
  }
  if (layout === 'build' || layout === 'standalone') {
    const rig = layout === 'build' ? `${out}/rig` : out;
    for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) write(dir, `${rig}/${name}`, '{}');
  }
  if (layout === 'standalone') args.push('--parts', parts);
  return { args, out, parts, config, manifest, image, stack, stamp };
}

function refuses(dir: string, code: string, action: () => unknown): void {
  const file = join(dir, 'project.json');
  const before = readFileSync(file);
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code });
  expect(readFileSync(file)).toEqual(before);
}

test('checks stamped assemble output and binds a parts-review CLI receipt without a rig', () => {
  const dir = fixture();
  const before = read(dir);
  const baseline = checkProject(dir, before, { now, readOnly: true }).refusals;
  const input = stage(dir, 'assemble');
  const result = seedRetainedDraft(input.args, now);
  expect(result.exit).toBe(0);
  const draft = read(dir).drafts;
  expect(draft).toEqual([JSON.parse(result.stdout)]);
  const record = obj(arr(draft)[0]);
  expect(record).toMatchObject({ kind: 'draft-rig', layout: 'assemble-only', producer: { name: '@rig-c/parts', version: '2.45.0' } });
  expect(obj(record.parts).path).toBe(input.parts);
  expect(arr(record.files).map(file => obj(file).path)).toEqual([input.stack, input.image, input.manifest, input.stamp]);
  expect(read(dir).versions).toEqual(before.versions);
  expect(read(dir).signoffs).toEqual(before.signoffs);
  const errors: Finding[] = [], warnings: Finding[] = [];
  checkDrafts(dir, read(dir), errors, warnings);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
  expect(checkProject(dir, undefined, { now, readOnly: true }).refusals).toEqual(baseline);
  expect(structureSnapshotCommand([dir, '--draft', 'assemble']).exit).toBe(0);
  const parts = obj(record.parts);
  const verdict = {
    schema: 'rig-review-parts-verdict/2', tool: { name: '@rig-c/review', version: '2.5.0' },
    source: { sha256: sha('synthetic source'), files: arr(parts.files).map(file => ({ path: 'opaque/frame', sha256: obj(file).sha256 })) },
    status: 'approved', parts: { sample: { outcome: 'clean', note: '' } },
  };
  seedPartsCliReceipt(dir, 'assemble', now, verdict, ['opaque/input']);
  expect(recordedPartsVerdict(dir, read(dir), 'assemble')).toBeDefined();
  const after = read(dir);
  const legacyRefusals: Finding[] = [], legacyWarnings: Finding[] = [];
  checkDrafts(dir, after, legacyRefusals, legacyWarnings);
  expect(legacyRefusals).toEqual([]);
  expect(legacyWarnings.map(finding => finding.code)).toEqual(['DRAFT_ASSEMBLY_CONFIG_UNRECORDED']);
  expect(read(dir).stage).toBe(before.stage);
});

test('next on a numbered project gives read-only draft guidance', () => {
  const dir = fixture(project => {
    project.stage = 'parts';
    project.versions = arr(project.versions).filter(version => obj(version).kind === 'rig');
    project.signoffs = arr(project.signoffs).slice(0, 2);
    retimeFixture(project, Date.parse('2026-11-16T00:00:00Z'));
    for (const raw of arr(obj(project.plan).steps)) obj(raw).status = 'pending';
  });
  const move = nextProject(dir, now).moves.find(move => move.field === 'drafts');
  expect(move).toMatchObject({ command: null, act: expect.stringContaining('Numbered drafts are read-only.') });
});

test('checks the explicit layout, bound stamp and retained output bytes', () => {
  const dir = fixture();
  const input = stage(dir, 'assemble');
  const bad = (project: JsonObject, code: string) => {
    const errors: Finding[] = [];
    checkDrafts(dir, project, errors);
    expect(errors.map(f => f.code)).toContain(code);
  };
  seedRetainedDraft(input.args, now);
  const noLayout = read(dir);
  delete obj(arr(noLayout.drafts)[0]).layout;
  bad(noLayout, 'DRAFT_RIG_MALFORMED');
  const withRig = read(dir);
  arr(obj(arr(withRig.drafts)[0]).files).push({ path: `${input.out}/rig/rig.json`, sha256: sha('{}') });
  bad(withRig, 'DRAFT_RIG_MALFORMED');
  write(dir, input.image, 'changed image');
  bad(read(dir), 'DRAFT_RIG_FILE');
  expect(checkProject(dir, undefined, { now, readOnly: true }).refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
});

test.each(['flat', 'standalone', 'build'] as const)('recognizes %s and leaves full draft records in their existing format', layout => {
  const dir = fixture();
  const input = stage(dir, 'sample', layout);
  const result = seedRetainedDraft(input.args, now);
  expect(result.exit).toBe(0);
  const record = obj(arr(read(dir).drafts)[0]);
  if (layout === 'flat') expect(record.layout).toBe('assemble-only');
  else expect(record.layout).toBeUndefined();
  const errors: Finding[] = [];
  checkDrafts(dir, read(dir), errors);
  expect(errors).toEqual([]);
});

test('rig consumers refuse explicit assemble sources or targets, with byte-identical project.json', () => {
  const dir = fixture();
  const input = stage(dir, 'assemble');
  seedRetainedDraft(input.args, now);
  const code = 'DRAFT_RIG_REQUIRED';
  refuses(dir, code, () => assertRequestedRig(dir, 'assemble'));
  refuses(dir, code, () => directionCommand(['check', 'assemble', dir], now));
  refuses(dir, code, () => handoffCommand([dir, '--rig', 'assemble'], now));
  refuses(dir, code, () => validateDirectionRig(dir, read(dir), { rig: { version: 99, model: { path: input.manifest, sha256: sha('') } } }, true));
  const errors: Finding[] = [];
  checkSignoffTarget(dir, read(dir), { stage: 'rig-review', draft_id: 'assemble' }, 'signoffs[0]', errors, []);
  expect(errors.map(f => f.code)).toEqual([code]);
  expect(assembleOnlyVersionFinding(dir, read(dir), { kind: 'rig', accepted_parts: { draft_id: 'assemble', manifest: { path: input.manifest } } }, 'versions[0]')).toBeUndefined();
});

test('correction identity admits a part-only edit and refuses the same draft when a model is required', () => {
  const dir = fixture();
  const input = stage(dir, 'assemble');
  seedRetainedDraft(input.args, now);
  const project = read(dir);
  const draft = obj(arr(project.drafts)[0]);
  const files = arr(obj(draft.parts).files).map(obj).sort((a, b) => String(a.path) < String(b.path) ? -1 : 1);
  const identity = { kind: 'draft', id: 'assemble', config: draft.config!, parts: { manifest: files.find(file => file.path === input.manifest)!, files }, model: null };
  expect(validateCorrectionIdentity(dir, project, identity, 'parts-review', false, true)).toEqual(identity);
  refuses(dir, 'DRAFT_RIG_REQUIRED', () => validateCorrectionIdentity(dir, project, identity, 'parts-review'));
});

test('assemble-only drafts neither claim ledger results nor reset the last rig ledger baseline', () => {
  const dir = fixture(project => {
    project.fix_ledger = [{ id: 'T1', at: '2026-11-20T00:00:00Z', by: 'user', note: { ref: 'corrections[T1]', verbatim: 'Retain the fix.' }, check: 'test', bar: 'pass' }];
  });
  const report = (manifest: string, result: string) => {
    const path = `evidence/ledger-${result}.json`;
    write(dir, path, JSON.stringify({ schema: FIX_LEDGER_REPORT_SPEC, build: { manifest_sha256: sha(readFileSync(join(dir, manifest))) },
      script_sha256: sha('synthetic check'), rows: [{ id: 'T1', result }] }));
    return path;
  };
  const first = stage(dir, 'first', 'build');
  seedRetainedDraft([...first.args, '--ledger-report', report(first.manifest, 'pass')], now);
  const assemble = stage(dir, 'assemble');
  seedRetainedDraft(assemble.args, now);
  const next = stage(dir, 'next', 'build');
  const beforeFailed = readFileSync(join(dir, 'project.json'));
  expect(() => seedRetainedDraft([...next.args, '--ledger-report', report(next.manifest, 'fail')], now))
    .toThrow(expect.objectContaining({ code: 'DRAFT_LEDGER_REGRESSION' }));
  writeFileSync(join(dir, 'project.json'), beforeFailed);
  const accepted = JSON.parse(seedRetainedDraft([...next.args, '--ledger-report', report(next.manifest, 'pass')], now).stdout);
  expect(accepted).toMatchObject({ fixes: [], fixes_against: 'first' });
  const forged = read(dir);
  obj(arr(forged.drafts)[1]).fixes = [];
  const errors: Finding[] = [];
  checkFixLedger(dir, forged, errors, [], now);
  expect(errors.map(f => f.code)).toEqual(['DRAFT_RIG_REQUIRED']);
});
