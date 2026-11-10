import { syntheticReviewRunner, syntheticReviewOrigin } from './review-read-fixture.ts';
import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { correctionFixture } from './correction-fixture.ts';
import { correctionHash } from '../src/corrections.ts';
import { checkAppliedReview } from '../src/applied-review.ts';
import { configInputBindings, configInputReferences, DRAFT_CONFIG_INPUTS_SINCE, plateReceiptSpec } from '../src/config-inputs.ts';
import { checkDrafts } from '../src/drafts.ts';
import { fixture } from './fixtures.ts';
import type { Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { correctionCommand, checkCorrections, draftRigCommand, testClock } from './clock.ts';

const roots: string[] = [];
const DRAFT_PACKAGE = 'evidence/out/check';
afterEach(() => { testClock.reset(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function sample(kind: 'rig' | 'draft', state: 'honest' | 'absent' | 'altered', legacy: boolean, plate: boolean | 'occluder' = false) {
  const dir = mkdtempSync(join(tmpdir(), 'named-inputs-')); roots.push(dir); correctionFixture(dir, 'rig');
  const load = (path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
  const save = (path: string, value: unknown) => writeFileSync(join(dir, path), JSON.stringify(value, null, 2) + '\n');
  const binding = (path: string) => ({ path, sha256: correctionHash(readFileSync(join(dir, path))) });
  const p = load('project.json'); const s = load('evidence/feedback.json');
  // A plate config names a synthetic occluder plate directory, bound by its receipt.
  // An occluder config names the requirements, one occluder image and its plate directory.
  save('evidence/source-config.json', plate === 'occluder' ? { requirements: 'requirements.json', assemble: { occluders: [{ image: 'occ.png', plate: 'plate' }] }, note: 'synthetic source' } : plate ? { assemble: { occluders: [{ plate: 'plate' }] }, note: 'synthetic source' } : { requirements: 'requirements.json', note: 'synthetic source' });
  if (plate === 'occluder') writeFileSync(join(dir, 'evidence/occ.png'), 'synthetic occluder image');
  save('evidence/requirements.json', { synthetic: 'requirements input' });
  if (plate) { mkdirSync(join(dir, 'evidence/plate'), { recursive: true }); save('evidence/plate/receipt.json', { spec: plateReceiptSpec(dir), synthetic: 'occluder plate receipt' }); writeFileSync(join(dir, 'evidence/plate/plate.png'), 'synthetic plate'); }
  const config = binding('evidence/source-config.json');
  const input: { path: string; sha256: string; directory?: string; spec?: string } = plate ? { ...binding('evidence/plate/receipt.json'), directory: 'evidence/plate', spec: plateReceiptSpec(dir) } : binding('evidence/requirements.json');
  // The draft writer's own binding of every config-named input.
  const inputs = (plate === 'occluder' ? configInputBindings(dir, 'evidence/source-config.json') : [input]) as (typeof input)[];
  p.versions[0].provenance.config = config; p.versions[0].review_package.config = config;
  p.versions[0].review_package.files[0].sha256 = config.sha256;
  p.versions[0].review_package.files.push({ ...input, path: 'requirements.json' });
  s.reviewedSource.handoff.config = config; s.reviewedSource.handoff.files[0].sha256 = config.sha256;
  const applied = s.feedback[0].context.applied; applied.configHash = config.sha256; applied.patch.config_sha256 = config.sha256;
  if (kind === 'draft') {
    mkdirSync(join(dir, 'evidence/input/parts'), { recursive: true }); save('evidence/input/parts.json', { synthetic: 'manifest' });
    writeFileSync(join(dir, 'evidence/input/parts/piece.png'), 'synthetic');
    const parts = { path: 'evidence/input', files: [binding('evidence/input/parts.json'), binding('evidence/input/parts/piece.png')] };
    writeFileSync(join(dir, 'evidence/skeleton.model.json'), readFileSync(join(dir, 'evidence/source.model.json')));
    p.drafts = [{ id: 'synthetic', kind: 'draft-rig', at: '2026-11-04T08:30:00Z', config, config_inputs: inputs, parts, files: [binding('evidence/skeleton.model.json')] }];
    p.stage = 'parts-review'; s.reviewedSource.handoff.files = [config, ...parts.files];
  }
  if (state !== 'absent') s.reviewedSource.handoff.files.push(...inputs.map((f, i) => ({ path: kind === 'rig' ? '../../requirements.json' : f.path, sha256: state === 'altered' && i === inputs.length - 1 ? '0'.repeat(64) : f.sha256 })));
  // Review writes a draft's handoff paths relative to the package it opened, as for the rig package above.
  if (kind === 'draft') {
    mkdirSync(join(dir, DRAFT_PACKAGE), { recursive: true });
    const rebase = (f: { path: string; sha256: string }) => ({ path: posix.relative(DRAFT_PACKAGE, f.path), sha256: f.sha256 });
    s.reviewedSource.handoff.config = rebase(config); s.reviewedSource.handoff.files = s.reviewedSource.handoff.files.map(rebase);
  }
  mkdirSync(join(dir, 'derived/review/v1'), { recursive: true });
  writeFileSync(join(dir, 'derived/review/v1/config.json'), readFileSync(join(dir, 'evidence/source-config.json')));
  save('evidence/feedback.json', s); save('project.json', p);
  testClock.set(new Date(legacy ? '2026-11-04T09:10:00Z' : '2026-11-06T09:10:00Z'));
  return { dir, load, save, inputs, record: (pkg = kind === 'rig' ? 'evidence/feedback.json' : DRAFT_PACKAGE) => correctionCommand(['record', dir, '--id', 'fix', '--path', 'made', '--stage', kind === 'rig' ? 'rig-review' : 'parts-review', '--by', 'user', ...(kind === 'rig' ? ['--version', '1'] : ['--draft', 'synthetic']), '--feedback-file', pkg, '--item', 'synthetic-apply'],syntheticReviewRunner) };
}
for (const kind of ['rig', 'draft'] as const) for (const legacy of [false, true]) for (const state of ['honest', 'absent', 'altered'] as const) {
  test(`${kind} ${legacy ? 'legacy' : 'current'} ${state} named handoff`, () => {
    const f = sample(kind, state, legacy); const before = readFileSync(join(f.dir, 'project.json'));
    if (state === 'altered' || state === 'absent' && !legacy) {
      let error: { code?: string; message?: string } = {};
      try { f.record(); } catch (caught) { error = caught as typeof error; }
      expect(error.code).toBe('CORRECTION_APPLIED_INVALID');
      expect(error.message).toContain('requirements.json');
      expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
    } else {
      expect(f.record().exit).toBe(0);
      const ctx = { dir: f.dir, project: f.load('project.json'), refusals: [] as Finding[], warnings: [] as Finding[] };
      checkCorrections(ctx); expect(ctx.refusals).toEqual([]);
      expect(ctx.warnings.some(f => f.code === 'CORRECTION_APPLIED_INVALID')).toBe(state === 'absent');
      if (state === 'honest') {
        const project = f.load('project.json');
        const hour = legacy ? '2026-11-04' : '2026-11-06';
        if (kind === 'rig') {
          project.versions[1].at = `${hour}T10:00:00Z`;
          project.versions[1].review_origin.applied = f.load('evidence/feedback.json').feedback[0].context.applied;
          project.versions[1].review_origin = syntheticReviewOrigin(f.dir,1,'synthetic-apply',project.versions[1].review_origin.applied);
        } else {
          mkdirSync(join(f.dir, 'evidence/after'), { recursive: true });
          writeFileSync(join(f.dir, 'evidence/after/skeleton.model.json'), readFileSync(join(f.dir, 'evidence/outcome.model.json')));
          project.drafts.push({ ...project.drafts[0], id: 'after', at: `${hour}T10:00:00Z`, files: [{ path: 'evidence/after/skeleton.model.json', sha256: correctionHash(readFileSync(join(f.dir, 'evidence/after/skeleton.model.json'))) }] });
        }
        f.save('project.json', project); testClock.set(new Date(`${hour}T11:00:00Z`));
        expect(correctionCommand(['resolve', 'fix', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'), ...(kind === 'rig' ? ['--version', '2'] : ['--draft', 'after'])]).exit).toBe(0);
        const closed = { dir: f.dir, project: f.load('project.json'), refusals: [] as Finding[], warnings: [] as Finding[] };
        checkCorrections(closed); expect(closed.refusals).toEqual([]); expect(closed.warnings).toEqual([]);
      }
    }
  });
}
for (const state of ['honest', 'absent', 'altered'] as const) test(`draft correction handoff binds an occluder plate by its receipt: ${state}`, () => {
  const f = sample('draft', state, false, true); const before = readFileSync(join(f.dir, 'project.json'));
  if (state === 'honest') {
    expect(f.record().exit).toBe(0);
    const ctx = { dir: f.dir, project: f.load('project.json'), refusals: [] as Finding[], warnings: [] as Finding[] };
    checkCorrections(ctx); expect(ctx.refusals).toEqual([]);
    return;
  }
  let error: { code?: string; message?: string } = {};
  try { f.record(); } catch (caught) { error = caught as typeof error; }
  expect(error.code).toBe('CORRECTION_APPLIED_INVALID'); expect(error.message).toContain('evidence/plate/receipt.json');
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});
test('a missing plate directory in a draft correction keeps its recorded receipt binding', () => {
  const f = sample('draft', 'honest', false, true); rmSync(join(f.dir, 'evidence/plate'), { recursive: true });
  expect(f.record().exit).toBe(0);
});
function refused(f: { dir: string; record: (pkg?: string) => unknown }, pkg?: string): { code?: string; message?: string } {
  const before = readFileSync(join(f.dir, 'project.json'));
  let error: { code?: string; message?: string } = {};
  try { f.record(pkg); } catch (caught) { error = caught as typeof error; }
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  return error;
}
test('a draft correction rebases review\'s package-relative handoff onto the project', () => {
  const f = sample('draft', 'honest', false, 'occluder');
  expect(f.inputs.map(i => i.path)).toEqual(['evidence/requirements.json', 'evidence/occ.png', 'evidence/plate/receipt.json']);
  expect(f.load('evidence/feedback.json').reviewedSource.handoff.files.slice(-3).map((h: { path: string }) => h.path)).toEqual(['../../requirements.json', '../../occ.png', '../../plate/receipt.json']);
  expect(f.record().exit).toBe(0);
  const project = f.load('project.json');
  expect(project.drafts[0].config_inputs).toEqual(f.inputs);
  expect(project.corrections[0].artifact.review_read.argv[2]).toBe(DRAFT_PACKAGE);
  const ctx = { dir: f.dir, project, refusals: [] as Finding[], warnings: [] as Finding[] };
  checkCorrections(ctx); expect(ctx.refusals).toEqual([]); expect(ctx.warnings.map(w => w.code)).toEqual(['CORRECTION_OPEN']);
});
test('a rebased draft handoff with one changed sha256 still refuses', () => {
  const error = refused(sample('draft', 'altered', false, 'occluder'));
  expect(error.code).toBe('CORRECTION_APPLIED_INVALID'); expect(error.message).toContain('evidence/plate/receipt.json');
});
test('a draft handoff path that resolves outside the project is refused by name', () => {
  const f = sample('draft', 'honest', false, 'occluder'); const s = f.load('evidence/feedback.json');
  s.reviewedSource.handoff.files.push({ path: '../../../../outside.json', sha256: '1'.repeat(64) }); f.save('evidence/feedback.json', s);
  const error = refused(f);
  expect(error.code).toBe('CORRECTION_APPLIED_INVALID'); expect(error.message).toContain('../../../../outside.json resolves outside the project');
});
test('a draft feedback package outside the project is refused by name', () => {
  const error = refused(sample('draft', 'honest', false, 'occluder'), '../elsewhere/out/check');
  expect(error.code).toBe('CORRECTION_APPLIED_INVALID'); expect(error.message).toContain('feedback package ../elsewhere/out/check is outside the project');
});
function checked(dir: string, project: unknown): Finding[] {
  const ctx = { dir, project: project as JsonObject, refusals: [] as Finding[], warnings: [] as Finding[] };
  checkCorrections(ctx); return ctx.refusals;
}
test('an absolute feedback package inside the project is retained relative and checks after the project moves', () => {
  const f = sample('draft', 'honest', false, 'occluder');
  expect(f.record(join(f.dir, DRAFT_PACKAGE)).exit).toBe(0);
  expect(f.load('project.json').corrections[0].artifact.review_read.argv[2]).toBe(DRAFT_PACKAGE);
  const moved = mkdtempSync(join(tmpdir(), 'named-inputs-moved-')); roots.push(moved);
  cpSync(f.dir, moved, { recursive: true }); rmSync(f.dir, { recursive: true, force: true });
  expect(checked(moved, JSON.parse(readFileSync(join(moved, 'project.json'), 'utf8')))).toEqual([]);
});
test('a manifest feedback input reads its folder as the package after the manifest is deleted', () => {
  const f = sample('draft', 'honest', false, 'occluder'); const manifest = `${DRAFT_PACKAGE}/review.json`;
  writeFileSync(join(f.dir, manifest), '{}\n');
  expect(f.record(manifest).exit).toBe(0);
  expect(f.load('project.json').corrections[0].artifact.review_read.argv[2]).toBe(manifest);
  rmSync(join(f.dir, manifest));
  expect(checked(f.dir, f.load('project.json'))).toEqual([]);
});
test('a draft feedback input whose form disagrees with its kind on disk is refused before writing', () => {
  const f = sample('draft', 'honest', false, 'occluder');
  mkdirSync(join(f.dir, 'evidence/package.json')); writeFileSync(join(f.dir, 'evidence/manifest'), '{}\n');
  for (const input of ['evidence/package.json', 'evidence/manifest']) {
    const error = refused(f, input);
    expect(error.code).toBe('CORRECTION_APPLIED_INVALID'); expect(error.message).toContain(`--feedback-file ${input} is a`);
  }
});
test('a changed plate receipt differs from the draft binding in a correction handoff', () => {
  const f = sample('draft', 'honest', false, true); f.save('evidence/plate/receipt.json', { spec: plateReceiptSpec(f.dir), synthetic: 'another receipt' });
  const before = readFileSync(join(f.dir, 'project.json'));
  let error: { code?: string; message?: string } = {};
  try { f.record(); } catch (caught) { error = caught as typeof error; }
  expect(error.code).toBe('CORRECTION_APPLIED_INVALID'); expect(error.message).toContain('differs from draft binding');
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});
for (const legacy of [false, true]) for (const state of ['honest', 'absent', 'altered'] as const) {
  test(`applied version ${legacy ? 'legacy' : 'current'} ${state} named input`, () => {
    const f = sample('rig', state, legacy); const p = f.load('project.json');
    p.versions[1].at = legacy ? '2026-11-04T10:00:00Z' : '2026-11-06T10:00:00Z';
    p.versions[1].review_origin.applied = f.load('evidence/feedback.json').feedback[0].context.applied;
    p.versions[1].review_origin = syntheticReviewOrigin(f.dir,1,'synthetic-apply',p.versions[1].review_origin.applied);
    const ctx = { dir: f.dir, project: p, refusals: [] as Finding[], warnings: [] as Finding[] }; checkAppliedReview(ctx);
    expect(ctx.refusals.map(f => f.code)).toEqual(state === 'altered' || state === 'absent' && !legacy ? ['APPLIED_REVIEW_SOURCE'] : []);
    expect(ctx.warnings.some(f => f.code === 'APPLIED_REVIEW_SOURCE')).toBe(state === 'absent' && legacy);
  });
}
test('loader declarations exclude built-in skeleton names', () => {
  expect(configInputReferences(process.cwd(), { requirements: 'r.json', motion: { animations_from: 'a.json' }, generation: { control: { skeleton: 's.json' } } }).map(f => f.at)).toEqual(['requirements', 'motion.animations_from', 'generation.control.skeleton']);
  expect(configInputReferences(process.cwd(), { generation: { control: { skeleton: 'stand_sides' } } })).toEqual([]);
});
/** A rig-run/1 stamp beside rig.json, so the draft's producer is read and only config_inputs findings remain. */
const RIG_STAMP = JSON.stringify({ spec: 'rig-run/1', package: { name: '@rig-c/parts', version: '0.0.1-synthetic' }, command: 'rig', started_at: '2026-11-04T00:00:00.000Z', finished_at: '2026-11-04T00:00:00.000Z', config: { path: '../config.json', sha256: 'a'.repeat(64) }, outputs: [{ path: 'rig.json', sha256: 'b'.repeat(64) }] });
for (const legacy of [false, true]) test(`draft writer binds files and ${legacy ? 'legacy warns' : 'current refuses'} absent bindings`, () => {
  const dir = fixture(); const root = 'derived/drafts/named';
  mkdirSync(join(dir, root, 'out'), { recursive: true }); mkdirSync(join(dir, root, 'input/parts'), { recursive: true });
  for (const [path, bytes] of Object.entries({ 'config.json': '{"requirements":"requirements.json","motion":{"animations_from":"animation.json"},"generation":{"control":{"skeleton":"skeleton.json"}}}', 'requirements.json': '{}', 'animation.json': '{}', 'skeleton.json': '{}', 'input/parts.json': '{}', 'input/recomposite_rig.png': 'synthetic stack bytes', 'input/parts/piece.png': 'synthetic', 'out/rig.json': '{}', 'out/motion.json': '{}', 'out/mesh_report.json': '{}', 'out/run.json': RIG_STAMP })) writeFileSync(join(dir, root, path), bytes);
  const result = draftRigCommand(['named', dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/input`, '--json']);
  const record = JSON.parse(result.stdout); expect(record.config_inputs.map((f: {path: string}) => f.path)).toEqual(['requirements.json', 'animation.json', 'skeleton.json'].map(p => `${root}/${p}`));
  const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  // An absent key from CONFIG_INPUTS_SINCE to DRAFT_CONFIG_INPUTS_SINCE is DRAFT_CONFIG_INPUTS_UNRECORDED; "current" is at or after both.
  delete p.drafts[0].config_inputs; p.drafts[0].at = legacy ? '2026-11-04T00:00:00Z' : DRAFT_CONFIG_INPUTS_SINCE;
  const refusals: Finding[] = []; const warnings: Finding[] = []; checkDrafts(dir, p, refusals, warnings);
  expect((legacy ? warnings : refusals).map(f => f.code)).toEqual(['DRAFT_RIG_FILE', 'DRAFT_RIG_FILE', 'DRAFT_RIG_FILE']);
  expect((legacy ? refusals : warnings)).toEqual([]);
  oldParts(dir);
  const unavailableRefusals: Finding[] = []; const unavailableWarnings: Finding[] = [];
  checkDrafts(dir, p, unavailableRefusals, unavailableWarnings);
  expect((legacy ? unavailableWarnings : unavailableRefusals).map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
  expect((legacy ? unavailableWarnings : unavailableRefusals)[0]?.message).toContain('@rig-c/parts 2.8.0');
  expect(legacy ? unavailableRefusals : unavailableWarnings).toEqual([]);
});

for (const legacy of [false, true]) test(`unavailable unbound input cannot claim a null hash in ${legacy ? 'legacy' : 'current'} rig handoff`, () => {
  const f = sample('rig', 'honest', legacy);
  const project = f.load('project.json'); const feedback = f.load('evidence/feedback.json');
  project.versions[0].at = legacy ? '2026-11-04T08:30:00Z' : '2026-11-06T08:30:00Z';
  project.versions[0].review_package.files.pop();
  rmSync(join(f.dir, 'evidence/requirements.json'));
  feedback.reviewedSource.handoff.files[1].sha256 = null;
  f.save('project.json', project); f.save('evidence/feedback.json', feedback);
  let error: { code?: string; message?: string } = {};
  try { f.record(); } catch (caught) { error = caught as typeof error; }
  expect(error.code).toBe('CORRECTION_APPLIED_INVALID'); expect(error.message).toContain('requirements.json');
  project.versions[1].review_origin = syntheticReviewOrigin(f.dir,1,'synthetic-apply',project.versions[1].review_origin.applied);
  project.versions[1].review_origin.applied = feedback.feedback[0].context.applied;
  const ctx = { dir: f.dir, project, refusals: [] as Finding[], warnings: [] as Finding[] };
  checkAppliedReview(ctx); expect(ctx.refusals.map(f => f.code)).toEqual(['APPLIED_REVIEW_SOURCE']);
});

function oldParts(dir: string): void {
  const root = join(dir, 'node_modules/@rig-c/parts');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"@rig-c/parts","version":"2.8.0","type":"module"}');
  writeFileSync(join(root, 'src/config.ts'), 'export const CONFIG_SECTIONS = ["assemble"];');
}
for (const legacy of [false, true]) test(`older loader named inputs ${legacy ? 'warn' : 'refuse'} with its version`, () => {
  const f = sample('rig', 'absent', legacy); oldParts(f.dir);
  if (legacy) {
    expect(f.record().exit).toBe(0);
    const ctx = { dir: f.dir, project: f.load('project.json'), refusals: [] as Finding[], warnings: [] as Finding[] };
    checkCorrections(ctx); expect(ctx.refusals).toEqual([]);
    expect(ctx.warnings.find(f => f.code === 'CORRECTION_APPLIED_INVALID')?.message).toContain('@rig-c/parts 2.8.0');
  } else {
    let error: { code?: string; message?: string } = {};
    try { f.record(); } catch (caught) { error = caught as typeof error; }
    expect(error.code).toBe('CORRECTION_APPLIED_INVALID'); expect(error.message).toContain('@rig-c/parts 2.8.0');
  }
  const p = f.load('project.json');
  p.versions[1].at = legacy ? '2026-11-05T10:00:00Z' : '2026-11-06T10:00:00Z';
  p.versions[1].review_origin.applied = f.load('evidence/feedback.json').feedback[0].context.applied;
  p.versions[1].review_origin = syntheticReviewOrigin(f.dir,1,'synthetic-apply',p.versions[1].review_origin.applied);
  const ctx = { dir: f.dir, project: p, refusals: [] as Finding[], warnings: [] as Finding[] }; checkAppliedReview(ctx);
  expect((legacy ? ctx.warnings : ctx.refusals).find(f => f.code === 'APPLIED_REVIEW_SOURCE')?.message).toContain('@rig-c/parts 2.8.0');
  expect(legacy ? ctx.refusals : ctx.warnings).toEqual([]);
});
test('older loader and a config with no named files retain the original correction path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'old-loader-no-files-')); roots.push(dir);
  correctionFixture(dir, 'rig'); oldParts(dir); testClock.set(new Date('2026-11-06T09:10:00Z'));
  expect(configInputReferences(dir, { note: 'no files' })).toEqual([]);
  expect(configInputReferences(dir, { generation: { control: { skeleton: 'stand_sides' } } })).toEqual([]);
  expect(correctionCommand(['record', dir, '--id', 'fix', '--path', 'made', '--stage', 'rig-review', '--by', 'user', '--version', '1', '--feedback-file', 'evidence/feedback.json', '--item', 'synthetic-apply'],syntheticReviewRunner).exit).toBe(0);
  const ctx = { dir, project: JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')), refusals: [] as Finding[], warnings: [] as Finding[] };
  checkCorrections(ctx); expect(ctx.refusals).toEqual([]); expect(ctx.warnings.map(f => f.code)).toEqual(['CORRECTION_OPEN']);
});

for (const legacy of [false, true]) test(`missing frozen rig input uses the source version era ${legacy ? 'legacy' : 'current'}`, () => {
  const f = sample('rig', 'absent', legacy); const p = f.load('project.json');
  p.versions[0].at = legacy ? '2026-11-04T08:30:00Z' : '2026-11-06T08:30:00Z';
  p.versions[0].review_package.files.pop(); f.save('project.json', p);
  if (legacy) {
    expect(f.record().exit).toBe(0);
    const ctx = { dir: f.dir, project: f.load('project.json'), refusals: [] as Finding[], warnings: [] as Finding[] };
    checkCorrections(ctx); expect(ctx.refusals).toEqual([]);
    expect(ctx.warnings.find(f => f.code === 'CORRECTION_APPLIED_INVALID')?.message).toContain('requirements.json is missing from source package');
  } else {
    let error: { code?: string; message?: string } = {};
    try { f.record(); } catch (caught) { error = caught as typeof error; }
    expect(error.code).toBe('CORRECTION_APPLIED_INVALID'); expect(error.message).toContain('requirements.json is missing from source package');
  }
  p.versions[1].at = legacy ? '2026-11-04T10:00:00Z' : '2026-11-06T10:00:00Z';
  p.versions[1].review_origin.applied = f.load('evidence/feedback.json').feedback[0].context.applied;
  p.versions[1].review_origin = syntheticReviewOrigin(f.dir,1,'synthetic-apply',p.versions[1].review_origin.applied);
  const ctx = { dir: f.dir, project: p, refusals: [] as Finding[], warnings: [] as Finding[] }; checkAppliedReview(ctx);
  expect((legacy ? ctx.warnings : ctx.refusals).find(f => f.code === 'APPLIED_REVIEW_SOURCE')?.message).toContain('requirements.json is missing from source package');
  expect(legacy ? ctx.refusals : ctx.warnings).toEqual([]);
});

test('a project opened through a symlink binds valid inputs, keeps missing nested inputs missing and refuses symlink escapes', () => {
  const f = sample('draft', 'honest', false, 'occluder');
  const alias = mkdtempSync(join(tmpdir(), 'named-inputs-link-')); roots.push(alias);
  const outside = mkdtempSync(join(tmpdir(), 'named-inputs-outside-')); roots.push(outside);
  writeFileSync(join(outside, 'foreign.json'), '{}\n');
  const linked = join(alias, 'project');
  symlinkSync(f.dir, linked);
  rmSync(join(f.dir, 'evidence/plate'), { recursive: true });
  expect(correctionCommand(['record', linked, '--id', 'fix', '--path', 'made', '--stage', 'parts-review', '--by', 'user', '--draft', 'synthetic', '--feedback-file', DRAFT_PACKAGE, '--item', 'synthetic-apply'], syntheticReviewRunner).exit).toBe(0);
  f.save('evidence/source-config.json', { requirements: 'nested/missing/requirements.json', assemble: { occluders: [{ image: 'occ.png' }] } });
  expect(configInputBindings(linked, 'evidence/source-config.json', true)).toEqual([
    { path: 'evidence/nested/missing/requirements.json', sha256: null },
    f.inputs[1]!,
  ]);
  expect(() => configInputBindings(linked, 'evidence/source-config.json', false)).toThrow(/ENOENT/);
  symlinkSync(outside, join(f.dir, 'evidence/escape-dir'));
  symlinkSync(join(outside, 'foreign.json'), join(f.dir, 'evidence/escape-file.json'));
  for (const [req, allowMissing] of [
    ['../../outside/missing.json', true],
    ['../../outside/missing.json', false],
    ['escape-dir/missing.json', true],
    ['escape-dir/missing.json', false],
    ['escape-file.json', true],
    ['escape-file.json', false],
  ] as const) {
    f.save('evidence/source-config.json', { requirements: req });
    expect(() => configInputBindings(linked, 'evidence/source-config.json', allowMissing)).toThrow('requirements: named input leaves the project');
  }
});
