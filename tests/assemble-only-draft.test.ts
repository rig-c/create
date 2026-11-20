import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateExampleParts } from '../scripts/generate-example-parts.ts';
import { nextProject } from '../src/next.ts';
import { checkProject, type Finding } from '../src/check.ts';
import { validateCorrectionIdentity } from '../src/corrections.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { validateDirectionRig } from '../src/direction.ts';
import { assembleOnlyVersionFinding } from '../src/draft-layout.ts';
import { checkDrafts, draftRigCommand } from '../src/drafts.ts';
import { reviewCommand } from '../src/feedback.ts';
import { checkFixLedger, FIX_LEDGER_REPORT_SPEC } from '../src/fix-ledger.ts';
import { assertRequestedRig } from '../src/job-host.ts';
import { partsReviewCommand } from '../src/parts-review.ts';
import { recordedPartsVerdict } from '../src/parts-verdict-record.ts';
import { handoffCommand } from '../src/review.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import { rigVersionCommand } from '../src/rig-version.ts';
import { checkSignoffTarget } from '../src/signoff-target.ts';
import { signoffCommand } from '../src/signoff.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, retimeFixture } from './fixtures.ts';
import { reviewStdout } from './review-read-fixture.ts';

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

test('records stamped assemble output and binds a parts-review CLI receipt without a rig', () => {
  const dir = fixture();
  const before = read(dir);
  const baseline = checkProject(dir, before, { now, readOnly: true }).refusals;
  const input = stage(dir, 'assemble');
  const result = draftRigCommand(input.args, now);
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
  const reviewed = partsReviewCommand([dir, '--draft', 'assemble', '--from-review-cli', '--by', 'user', '--json', '--', 'opaque/input'],
    now, { runCli: reviewStdout(Buffer.from(JSON.stringify(verdict))) });
  expect(reviewed.exit).toBe(0);
  expect(recordedPartsVerdict(dir, read(dir), 'assemble')).toBeDefined();
  const after = read(dir);
  const legacyRefusals: Finding[] = [], legacyWarnings: Finding[] = [];
  checkDrafts(dir, after, legacyRefusals, legacyWarnings);
  expect(legacyRefusals).toEqual([]);
  expect(legacyWarnings.map(finding => finding.code)).toEqual(['DRAFT_ASSEMBLY_CONFIG_UNRECORDED']);
  expect(read(dir).stage).toBe(before.stage);
});

test('requires the second assemble after propose changes turn', () => {
  const dir = fixture();
  const id = 'turn-draft';
  const root = `derived/drafts/${id}`;
  mkdirSync(join(dir, root), { recursive: true });
  const first = generateExampleParts(join(dir, root), true);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'), ...args],
      { cwd: join(dir, root), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, String(result.stderr)).toBe(0);
    return String(result.stdout);
  };
  expect(run('propose', '--parts', 'assembled/rig', '--source', 'painting.png', '--full', 'layers', '--out', 'proposal',
    '--write-config', 'config.json')).toContain('config.turn');
  const args = [id, dir, '--config', `${root}/config.json`, '--from'];
  refuses(dir, 'ASSEMBLY_CONFIG_STALE', () => draftRigCommand([...args, `${root}/assembled`], now));

  const assemble = (out: string) => run('assemble', '--source', 'painting.png', '--full', 'layers', '--config', 'config.json', '--out', out);
  assemble('fresh');
  const recorded = JSON.parse(draftRigCommand([...args, `${root}/fresh`, '--json'], now).stdout);
  expect(recorded.config.sha256).toBe(sha(readFileSync(join(dir, root, 'config.json'))));
  assemble('replay');
  expect(readFileSync(join(dir, root, 'fresh/rig/parts.json'))).not.toEqual(first['parts.json']!);
  for (const file of Object.keys(first)) {
    expect(readFileSync(join(dir, root, 'fresh/rig', file))).toEqual(readFileSync(join(dir, root, 'replay/rig', file)));
  }
});

test('next names reassembly before draft registration and publication', () => {
  const dir = fixture(project => {
    project.stage = 'parts';
    project.versions = [];
    project.signoffs = arr(project.signoffs).slice(0, 2);
    retimeFixture(project, Date.parse('2026-11-16T00:00:00Z'));
    for (const raw of arr(obj(project.plan).steps)) obj(raw).status = 'pending';
  });
  const move = nextProject(dir, now).moves.find(move => move.field === 'drafts');
  expect(move?.act).toMatch(/assemble.*propose --write-config.*assemble again.*draft-rig.*job open --draft/);
  expect(move?.act).toMatch(/assemble again with the written config\. Finalize the assembly inputs.*only then take edited-part baselines/);
});

test.each(['rig.json', 'motion.json', 'mesh_report.json', 'skeleton.model.json'])('partial output with %s cannot silently become assemble-only', name => {
  const dir = fixture();
  const input = stage(dir, 'partial');
  write(dir, `${input.out}/rig/${name}`, '{}');
  refuses(dir, 'DRAFT_RIG_MALFORMED', () => draftRigCommand(input.args, now));
});

test('ambiguous and incomplete assemble inventories refuse without altering the record', () => {
  const dir = fixture();
  const ambiguous = stage(dir, 'ambiguous');
  write(dir, `${ambiguous.out}/parts.json`, '{}');
  write(dir, `${ambiguous.out}/parts/sample.png`, 'flat part');
  refuses(dir, 'DRAFT_RIG_MALFORMED', () => draftRigCommand(ambiguous.args, now));
  const incomplete = stage(dir, 'incomplete');
  rmSync(join(dir, incomplete.image));
  write(dir, `${incomplete.parts}/parts/readme.txt`, 'an image is required');
  refuses(dir, 'DRAFT_RIG_MALFORMED', () => draftRigCommand(incomplete.args, now));
  const noStack = stage(dir, 'no-stack');
  rmSync(join(dir, noStack.stack));
  refuses(dir, 'DRAFT_RIG_STACK', () => draftRigCommand(noStack.args, now));
});

test('checks the explicit layout, bound stamp and retained output bytes', () => {
  const dir = fixture();
  const input = stage(dir, 'assemble');
  const bad = (project: JsonObject, code: string) => {
    const errors: Finding[] = [];
    checkDrafts(dir, project, errors);
    expect(errors.map(f => f.code)).toContain(code);
  };
  const stamp = readFileSync(join(dir, input.stamp), 'utf8');
  write(dir, input.stamp, stamp.replace('"role":"full"', '"role":"head"'));
  refuses(dir, 'RUN_RECORD_MALFORMED', () => draftRigCommand(input.args, now));
  write(dir, input.stamp, stamp);
  draftRigCommand(input.args, now);
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
  const result = draftRigCommand(input.args, now);
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
  draftRigCommand(input.args, now);
  const code = 'DRAFT_RIG_REQUIRED';
  refuses(dir, code, () => assertRequestedRig(dir, 'assemble'));
  refuses(dir, code, () => reviewCommand(['assemble', dir, '--from-review', 'unneeded'], now));
  refuses(dir, code, () => signoffCommand(['rig-review', dir, '--draft', 'assemble', '--by', 'user'], now));
  refuses(dir, code, () => signoffCommand(['direction-review', dir, '--version', 'assemble', '--by', 'user'], now));
  refuses(dir, code, () => directionCommand(['write', '9', dir, '--rig', 'assemble', '--file', 'unneeded.json'], now));
  refuses(dir, code, () => directionCommand(['check', 'assemble', dir], now));
  refuses(dir, code, () => handoffCommand([dir, '--rig', 'assemble'], now));
  refuses(dir, code, () => validateDirectionRig(dir, read(dir), { rig: { version: 99, model: { path: input.manifest, sha256: sha('') } } }, true));
  refuses(dir, code, () => reviewPackageCommand(['99', dir, '--config', input.config, '--from', input.out]));
  refuses(dir, code, () => rigVersionCommand(['99', dir, '--rig', input.parts, '--parts', input.parts, '--config', input.config,
    '--build', 'unneeded', '--idle', 'unneeded', '--path-adapter', 'unneeded', '--compile-report', 'unneeded', '--toolchain-lock', 'unneeded',
    '--at-source', 'unneeded', '--at-pointer', 'unneeded', '--by', 'agent'], now));
  const errors: Finding[] = [];
  checkSignoffTarget(dir, read(dir), { stage: 'rig-review', draft_id: 'assemble' }, 'signoffs[0]', errors, []);
  expect(errors.map(f => f.code)).toEqual([code]);
  expect(assembleOnlyVersionFinding(dir, read(dir), { kind: 'rig', accepted_parts: { draft_id: 'assemble', manifest: { path: input.manifest } } }, 'versions[0]')).toBeUndefined();
});

test('correction identity admits a part-only edit and refuses the same draft when a model is required', () => {
  const dir = fixture();
  const input = stage(dir, 'assemble');
  draftRigCommand(input.args, now);
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
  draftRigCommand([...first.args, '--ledger-report', report(first.manifest, 'pass')], now);
  const assemble = stage(dir, 'assemble');
  refuses(dir, 'DRAFT_RIG_REQUIRED', () => draftRigCommand([...assemble.args, '--ledger-report', 'unneeded.json'], now));
  draftRigCommand(assemble.args, now);
  const next = stage(dir, 'next', 'build');
  refuses(dir, 'DRAFT_LEDGER_REGRESSION', () => draftRigCommand([...next.args, '--ledger-report', report(next.manifest, 'fail')], now));
  const accepted = JSON.parse(draftRigCommand([...next.args, '--ledger-report', report(next.manifest, 'pass')], now).stdout);
  expect(accepted).toMatchObject({ fixes: [], fixes_against: 'first' });
  const forged = read(dir);
  obj(arr(forged.drafts)[1]).fixes = [];
  const errors: Finding[] = [];
  checkFixLedger(dir, forged, errors, [], now);
  expect(errors.map(f => f.code)).toEqual(['DRAFT_RIG_REQUIRED']);
});
