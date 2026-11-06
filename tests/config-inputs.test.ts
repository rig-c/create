import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { correctionFixture } from './correction-fixture.ts';
import { correctionCommand } from '../src/correction-writers.ts';
import { checkCorrections, correctionHash } from '../src/corrections.ts';
import { checkAppliedReview } from '../src/applied-review.ts';
import { configInputReferences } from '../src/config-inputs.ts';
import { checkDrafts, draftRigCommand } from '../src/drafts.ts';
import { fixture } from './fixtures.ts';
import type { Finding } from '../src/check.ts';

const roots: string[] = [];
afterEach(() => { setSystemTime(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function sample(kind: 'rig' | 'draft', state: 'honest' | 'absent' | 'altered', legacy: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'named-inputs-')); roots.push(dir); correctionFixture(dir, 'rig');
  const load = (path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
  const save = (path: string, value: unknown) => writeFileSync(join(dir, path), JSON.stringify(value, null, 2) + '\n');
  const binding = (path: string) => ({ path, sha256: correctionHash(readFileSync(join(dir, path))) });
  const p = load('project.json'); const s = load('evidence/feedback.json');
  save('evidence/source-config.json', { requirements: 'requirements.json', note: 'synthetic source' });
  save('evidence/requirements.json', { synthetic: 'requirements input' });
  const config = binding('evidence/source-config.json'); const input = binding('evidence/requirements.json');
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
    p.drafts = [{ id: 'synthetic', kind: 'draft-rig', at: '2026-11-04T08:30:00Z', config, config_inputs: [input], parts, files: [binding('evidence/skeleton.model.json')] }];
    p.stage = 'parts-review'; s.reviewedSource.handoff.files = [config, ...parts.files];
  }
  if (state !== 'absent') s.reviewedSource.handoff.files.push({ ...input, path: kind === 'rig' ? '../../requirements.json' : input.path, sha256: state === 'altered' ? '0'.repeat(64) : input.sha256 });
  mkdirSync(join(dir, 'derived/review/v1'), { recursive: true });
  writeFileSync(join(dir, 'derived/review/v1/config.json'), readFileSync(join(dir, 'evidence/source-config.json')));
  save('evidence/feedback.json', s); save('project.json', p);
  setSystemTime(new Date(legacy ? '2026-11-04T09:10:00Z' : '2026-11-06T09:10:00Z'));
  return { dir, load, save, record: () => correctionCommand(['record', dir, '--id', 'fix', '--path', 'made', '--stage', kind === 'rig' ? 'rig-review' : 'parts-review', '--by', 'user', ...(kind === 'rig' ? ['--version', '1'] : ['--draft', 'synthetic']), '--feedback-file', 'evidence/feedback.json', '--item', 'synthetic-apply']) };
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
          project.versions[1].review_origin.feedback.sha256 = correctionHash(readFileSync(join(f.dir, 'evidence/feedback.json')));
        } else {
          mkdirSync(join(f.dir, 'evidence/after'), { recursive: true });
          writeFileSync(join(f.dir, 'evidence/after/skeleton.model.json'), readFileSync(join(f.dir, 'evidence/outcome.model.json')));
          project.drafts.push({ ...project.drafts[0], id: 'after', at: `${hour}T10:00:00Z`, files: [{ path: 'evidence/after/skeleton.model.json', sha256: correctionHash(readFileSync(join(f.dir, 'evidence/after/skeleton.model.json'))) }] });
        }
        f.save('project.json', project); setSystemTime(new Date(`${hour}T11:00:00Z`));
        expect(correctionCommand(['resolve', 'fix', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'), ...(kind === 'rig' ? ['--version', '2'] : ['--draft', 'after'])]).exit).toBe(0);
        const closed = { dir: f.dir, project: f.load('project.json'), refusals: [] as Finding[], warnings: [] as Finding[] };
        checkCorrections(closed); expect(closed.refusals).toEqual([]); expect(closed.warnings).toEqual([]);
      }
    }
  });
}
for (const legacy of [false, true]) for (const state of ['honest', 'absent', 'altered'] as const) {
  test(`applied version ${legacy ? 'legacy' : 'current'} ${state} named input`, () => {
    const f = sample('rig', state, legacy); const p = f.load('project.json');
    p.versions[1].at = legacy ? '2026-11-04T10:00:00Z' : '2026-11-06T10:00:00Z';
    p.versions[1].review_origin.applied = f.load('evidence/feedback.json').feedback[0].context.applied;
    p.versions[1].review_origin.feedback.sha256 = correctionHash(readFileSync(join(f.dir, 'evidence/feedback.json')));
    const ctx = { dir: f.dir, project: p, refusals: [] as Finding[], warnings: [] as Finding[] }; checkAppliedReview(ctx);
    expect(ctx.refusals.map(f => f.code)).toEqual(state === 'altered' || state === 'absent' && !legacy ? ['APPLIED_REVIEW_SOURCE'] : []);
    expect(ctx.warnings.some(f => f.code === 'APPLIED_REVIEW_SOURCE')).toBe(state === 'absent' && legacy);
  });
}
test('loader declarations exclude built-in skeleton names', () => {
  expect(configInputReferences(process.cwd(), { requirements: 'r.json', motion: { animations_from: 'a.json' }, generation: { control: { skeleton: 's.json' } } }).map(f => f.at)).toEqual(['requirements', 'motion.animations_from', 'generation.control.skeleton']);
  expect(configInputReferences(process.cwd(), { generation: { control: { skeleton: 'stand_sides' } } })).toEqual([]);
});
for (const legacy of [false, true]) test(`draft writer binds files and ${legacy ? 'legacy warns' : 'current refuses'} absent bindings`, () => {
  const dir = fixture(); const root = 'derived/drafts/named';
  mkdirSync(join(dir, root, 'out'), { recursive: true }); mkdirSync(join(dir, root, 'input/parts'), { recursive: true });
  for (const [path, bytes] of Object.entries({ 'config.json': '{"requirements":"requirements.json","motion":{"animations_from":"animation.json"},"generation":{"control":{"skeleton":"skeleton.json"}}}', 'requirements.json': '{}', 'animation.json': '{}', 'skeleton.json': '{}', 'input/parts.json': '{}', 'input/parts/piece.png': 'synthetic', 'out/rig.json': '{}', 'out/motion.json': '{}', 'out/mesh_report.json': '{}' })) writeFileSync(join(dir, root, path), bytes);
  const result = draftRigCommand(['named', dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/input`, '--json']);
  const record = JSON.parse(result.stdout); expect(record.config_inputs.map((f: {path: string}) => f.path)).toEqual(['requirements.json', 'animation.json', 'skeleton.json'].map(p => `${root}/${p}`));
  const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  delete p.drafts[0].config_inputs; p.drafts[0].at = legacy ? '2026-11-04T00:00:00Z' : '2026-11-06T00:00:00Z';
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
  project.versions[1].review_origin.feedback.sha256 = correctionHash(readFileSync(join(f.dir, 'evidence/feedback.json')));
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
  p.versions[1].review_origin.feedback.sha256 = correctionHash(readFileSync(join(f.dir, 'evidence/feedback.json')));
  const ctx = { dir: f.dir, project: p, refusals: [] as Finding[], warnings: [] as Finding[] }; checkAppliedReview(ctx);
  expect((legacy ? ctx.warnings : ctx.refusals).find(f => f.code === 'APPLIED_REVIEW_SOURCE')?.message).toContain('@rig-c/parts 2.8.0');
  expect(legacy ? ctx.refusals : ctx.warnings).toEqual([]);
});
test('older loader and a config with no named files retain the original correction path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'old-loader-no-files-')); roots.push(dir);
  correctionFixture(dir, 'rig'); oldParts(dir); setSystemTime(new Date('2026-11-06T09:10:00Z'));
  expect(configInputReferences(dir, { note: 'no files' })).toEqual([]);
  expect(configInputReferences(dir, { generation: { control: { skeleton: 'stand_sides' } } })).toEqual([]);
  expect(correctionCommand(['record', dir, '--id', 'fix', '--path', 'made', '--stage', 'rig-review', '--by', 'user', '--version', '1', '--feedback-file', 'evidence/feedback.json', '--item', 'synthetic-apply']).exit).toBe(0);
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
  p.versions[1].review_origin.feedback.sha256 = correctionHash(readFileSync(join(f.dir, 'evidence/feedback.json')));
  const ctx = { dir: f.dir, project: p, refusals: [] as Finding[], warnings: [] as Finding[] }; checkAppliedReview(ctx);
  expect((legacy ? ctx.warnings : ctx.refusals).find(f => f.code === 'APPLIED_REVIEW_SOURCE')?.message).toContain('requirements.json is missing from source package');
  expect(legacy ? ctx.refusals : ctx.warnings).toEqual([]);
});
