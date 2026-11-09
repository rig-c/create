import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { checkDrafts, draftInputUnavailable, draftVersionFindings } from '../src/drafts.ts';
import { configInputReferences } from '../src/config-inputs.ts';
import { Refusal } from '../src/refusal.ts';
import { fixture, arr, obj } from './fixtures.ts';
import type { Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, draftRigCommand, handoff } from './clock.ts';
import { retainedPartsFiles } from './draft-fixture.ts';
import { locateParts } from '../src/parts-sections.ts';

function write(dir: string, path: string, bytes = '{}'): void { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes); }
function draft(build = false): { dir: string; args: string[] } {
  const dir = fixture(); const root = 'derived/drafts/sample'; const out = `${root}/out`; const parts = build ? out : `${root}/inputs`;
  write(dir, `${root}/config.json`);
  write(dir, `${parts}/recomposite_rig.png`, 'synthetic stack bytes');
  write(dir, `${parts}/parts.json`); write(dir, `${parts}/parts/synthetic.png`, 'synthetic part bytes');
  for (const file of ['rig.json', 'motion.json', 'mesh_report.json']) write(dir, `${out}/${build ? 'rig/' : ''}${file}`);
  const args = ['sample', dir, '--config', `${root}/config.json`, '--from', out, '--json'];
  if (!build) args.push('--parts', parts);
  return { dir, args };
}
function read(dir: string): JsonObject { return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject; }
function rejected(fn: () => unknown, code: string): void { try { fn(); throw Error('expected refusal'); } catch (e) { expect(e).toBeInstanceOf(Refusal); expect((e as Refusal).code).toBe(code); } }

test.each([false, true])('draft recorder binds standalone/build=%s without creating a version', build => {
  const { dir, args } = draft(build); const before = read(dir);
  const r = draftRigCommand(args); expect(r.exit).toBe(0);
  const record = JSON.parse(r.stdout) as JsonObject;
  expect(record.config_inputs).toBeUndefined();
  expect(record.kind).toBe('draft-rig'); expect(record.handoff).toBeUndefined();
  expect(arr(obj(record.parts).files)).toHaveLength(2);
  expect(read(dir).versions).toEqual(before.versions);
  expect(read(dir).signoffs).toEqual(before.signoffs);
  expect(checkProject(dir).refusals).toEqual([]);
  const errors: Finding[] = []; checkDrafts(dir, read(dir), errors); expect(errors).toEqual([]);
});

test('standalone parts binding, ambiguous layout and duplicate id refuse before writing', () => {
  const { dir, args } = draft(); const before = readFileSync(join(dir, 'project.json'));
  rejected(() => draftRigCommand(args.slice(0, -2)), 'DRAFT_RIG_MALFORMED');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  draftRigCommand(args);
  const frozen = readFileSync(join(dir, 'project.json'));
  rejected(() => draftRigCommand(args), 'DRAFT_RIG_MALFORMED');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(frozen);
  const other = draft(true); write(other.dir, 'derived/drafts/sample/out/rig.json');
  rejected(() => draftRigCommand(other.args), 'DRAFT_RIG_MALFORMED');
});

test('changed draft parts/file and an escaping symlink are named refusals', () => {
  const { dir, args } = draft(); draftRigCommand(args);
  write(dir, 'derived/drafts/sample/inputs/parts/synthetic.png', 'changed');
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
  const other = draft(); symlinkSync(join(dir, 'derived/drafts/sample/out/rig.json'), join(other.dir, 'derived/drafts/sample/out/escape.json'));
  rejected(() => draftRigCommand(other.args), 'DRAFT_RIG_MALFORMED');
});

test('draft role, reserved declared path and symlink identity cannot become a handoff version', () => {
  const { dir, args } = draft(); draftRigCommand(args); const p = read(dir);
  for (const v of ([{ n: 10, kind: 'draft-rig' }, { n: 10, kind: 'rig', outputs: [{ path: 'derived/drafts/sample/out/rig.json' }] }] as JsonObject[])) {
    expect(draftVersionFindings(dir, { ...p, versions: [v] })).toHaveLength(1);
  }
  symlinkSync(join(dir, 'derived/drafts/sample/out/rig.json'), join(dir, 'outputs/copied-rig.json'));
  arr(p.versions).push({ n: 10, kind: 'rig', outputs: [{ path: 'outputs/copied-rig.json' }] });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  rejected(() => handoff(dir, null), 'DRAFT_RIG_AS_VERSION');
  expect(draftVersionFindings(dir, { ...p, versions: [{ n: 11, kind: 'rig', outputs: [{ path: 'outputs/independent.json', sha256: 'a'.repeat(64) }] }] })).toEqual([]);
});


test('an unavailable config does not mask a present changed draft output', () => {
  const { dir, args } = draft(); draftRigCommand(args);
  rmSync(join(dir, 'derived/drafts/sample/config.json'));
  write(dir, 'derived/drafts/sample/out/rig.json', '{"changed":true}');
  const report = checkProject(dir);
  expect(report.refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
  expect(report.warnings.map(f => f.code)).toContain('DRAFT_RIG_UNAVAILABLE');
});

test.each([false, true])('a declared painting_in_rig is bound and copied with the parts, build=%s', build => {
  const { dir, args } = draft(build); const parts = `derived/drafts/sample/${build ? 'out' : 'inputs'}`;
  write(dir, `${parts}/parts.json`, JSON.stringify({ painting_in_rig: { path: 'painting_in_rig.png', sha256: 'a'.repeat(64), resample: 'lanczos3-rgb-opaque' } }));
  write(dir, `${parts}/painting_in_rig.png`, 'synthetic painting bytes');
  write(dir, `${parts}/undeclared.png`, 'not declared by parts.json');
  const record = JSON.parse(draftRigCommand(args).stdout) as JsonObject;
  expect(arr(obj(record.parts).files).map(f => obj(f).path).sort()).toEqual([`${parts}/painting_in_rig.png`, `${parts}/parts.json`, `${parts}/parts/synthetic.png`]);
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings.map(f => f.code)).not.toContain('DRAFT_DECLARED_FILE_UNBOUND');
  write(dir, `${parts}/painting_in_rig.png`, 'changed painting bytes');
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
  const helper = retainedPartsFiles(join(dir, parts));
  expect(Object.keys(helper).sort()).toEqual(['painting_in_rig.png', 'parts.json', 'parts/synthetic.png']);
  expect(Buffer.from(helper['painting_in_rig.png']!).toString()).toBe('changed painting bytes');
});

test('a declared painting_in_rig that is absent is left out like a missing part file', () => {
  const { dir, args } = draft();
  write(dir, 'derived/drafts/sample/inputs/parts.json', JSON.stringify({ painting_in_rig: { path: 'painting_in_rig.png' } }));
  const record = JSON.parse(draftRigCommand(args).stdout) as JsonObject;
  expect(arr(obj(record.parts).files).map(f => obj(f).path).sort()).toEqual(['derived/drafts/sample/inputs/parts.json', 'derived/drafts/sample/inputs/parts/synthetic.png']);
  expect(checkProject(dir).refusals).toEqual([]);
});

test('a draft recorded before the painting was carried warns by name and is not refused', () => {
  const { dir, args } = draft();
  write(dir, 'derived/drafts/sample/inputs/parts.json', JSON.stringify({ painting_in_rig: { path: 'painting_in_rig.png' } }));
  write(dir, 'derived/drafts/sample/inputs/painting_in_rig.png', 'synthetic painting bytes');
  draftRigCommand(args);
  const p = read(dir); const parts = obj(obj(arr(p.drafts)[0]).parts);
  parts.files = arr(parts.files).filter(f => !String(obj(f).path).endsWith('/painting_in_rig.png'));
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.filter(f => f.code === 'DRAFT_DECLARED_FILE_UNBOUND').map(f => f.path)).toEqual(['drafts[0].parts.files']);
  expect(report.warnings.find(f => f.code === 'DRAFT_DECLARED_FILE_UNBOUND')!.message).toContain('derived/drafts/sample/inputs/painting_in_rig.png');
});

/** A synthetic rig-run/1 stamp in the producer's published key order; its hashes are not create's to verify. */
function runStamp(version: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ spec: 'rig-run/1', package: { name: '@rig-c/parts', version }, command: 'rig', started_at: '2026-11-08T00:00:00.000Z', finished_at: '2026-11-08T00:00:00.000Z', config: { path: '../config.json', sha256: 'a'.repeat(64) }, outputs: [{ path: 'rig.json', sha256: 'b'.repeat(64) }], ...extra }, null, 1)}\n`;
}
function installedParts(dir: string): string { return (JSON.parse(readFileSync(join(locateParts(dir)!, 'package.json'), 'utf8')) as { version: string }).version; }
const stampAt = (build: boolean): string => `derived/drafts/sample/out/${build ? 'rig/' : ''}run.json`;

test.each([false, true])('the producer is read from the rig output run.json, not the installed package, build=%s', build => {
  const { dir, args } = draft(build);
  expect(installedParts(dir)).not.toBe('0.0.1-synthetic');
  write(dir, stampAt(build), runStamp('0.0.1-synthetic'));
  const record = JSON.parse(draftRigCommand(args).stdout) as JsonObject;
  expect(record.producer).toEqual({ name: '@rig-c/parts', version: '0.0.1-synthetic' });
  expect(arr(record.files).map(f => obj(f).path)).toContain(stampAt(build));
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(f => f.code).filter(c => c.startsWith('DRAFT_PRODUCER_'))).toEqual([]);
});

test.each([false, true])('a draft without run.json records the installed package and warns DRAFT_PRODUCER_ASSUMED, build=%s', build => {
  const { dir, args } = draft(build);
  const record = JSON.parse(draftRigCommand(args).stdout) as JsonObject;
  expect(record.producer).toEqual({ name: '@rig-c/parts', version: installedParts(dir) });
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.filter(f => f.code === 'DRAFT_PRODUCER_ASSUMED').map(f => f.path)).toEqual(['drafts[0].producer']);
});

test('a malformed or foreign run.json refuses with the run record code and leaves project.json byte-identical', () => {
  for (const [bytes, code] of [['{"spec":"rig-run/1"}', 'RUN_RECORD_MALFORMED'], [runStamp('0.0.1-synthetic', { spec: 'other-run/1' }), 'RUN_RECORD_SPEC_UNKNOWN']] as const) {
    const { dir, args } = draft(); write(dir, stampAt(false), bytes);
    const before = readFileSync(join(dir, 'project.json'));
    rejected(() => draftRigCommand(args), code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  }
});

test('a recorded producer that disagrees with its bound run.json warns DRAFT_PRODUCER_MISMATCH and is kept', () => {
  const { dir, args } = draft(); write(dir, stampAt(false), runStamp('0.0.1-synthetic'));
  draftRigCommand(args);
  const p = read(dir); obj(arr(p.drafts)[0]).producer = { name: '@rig-c/parts', version: '0.0.0-installed' };
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.filter(f => f.code === 'DRAFT_PRODUCER_MISMATCH').map(f => f.path)).toEqual(['drafts[0].producer']);
  expect(report.warnings.map(f => f.code)).not.toContain('DRAFT_PRODUCER_ASSUMED');
});


test('a build without a stack refuses before writing and existing records remain accepted', () => {
  const { dir, args } = draft(true);
  draftRigCommand(args);
  rmSync(join(dir, 'derived/drafts/sample/out/recomposite_rig.png'));
  expect(checkProject(dir).refusals).toEqual([]);
  const p = read(dir); p.drafts = [];
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  const before = readFileSync(join(dir, 'project.json'));
  rejected(() => draftRigCommand(args), 'DRAFT_RIG_STACK');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('standalone assemble stack beside rig records and two stack candidates refuse before writing', () => {
  const { dir, args } = draft();
  const root = 'derived/drafts/sample';
  const parts = `${root}/rig`;
  write(dir, `${parts}/parts.json`);
  write(dir, `${parts}/parts/piece.png`, 'synthetic part bytes');
  write(dir, `${root}/render/recomposite_rig.png`, 'synthetic stack bytes');
  args[args.indexOf('--parts') + 1] = parts;
  const record = JSON.parse(draftRigCommand(args).stdout) as JsonObject;
  expect(obj(record.parts).path).toBe(parts);
  const p = read(dir); p.drafts = [];
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
  write(dir, `${parts}/recomposite_rig.png`, 'synthetic stack bytes');
  const before = readFileSync(join(dir, 'project.json'));
  rejected(() => draftRigCommand(args), 'DRAFT_RIG_STACK');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

/** A synthetic occluder matte at the project's inputs/, named from the draft config as the pinned loader declares it. */
function occluderDraft(image = '../../../inputs/foreground.png'): { dir: string; args: string[]; config: JsonObject } {
  const { dir, args } = draft(); const config = { assemble: { occluders: [{ image }] } };
  write(dir, 'derived/drafts/sample/config.json', JSON.stringify(config));
  write(dir, 'inputs/foreground.png', 'synthetic foreground matte');
  return { dir, args, config };
}

test('a config-named project input outside the draft root records and checks clean', () => {
  const { dir, args, config } = occluderDraft();
  expect(configInputReferences(dir, config).map(ref => ref.at)).toEqual(['assemble.occluders[0].image']);
  const record = JSON.parse(draftRigCommand(args).stdout) as JsonObject;
  const bytes = readFileSync(join(dir, 'inputs/foreground.png'));
  expect(record.config_inputs).toEqual([{ path: 'inputs/foreground.png', sha256: createHash('sha256').update(bytes).digest('hex') }]);
  expect(arr(read(dir).drafts).at(-1)).toEqual(record);
  expect(checkProject(dir).refusals).toEqual([]);
  const errors: Finding[] = []; const warnings: Finding[] = []; checkDrafts(dir, read(dir), errors, warnings);
  // The fixture binds no run.json stamp; nothing about the named input warns.
  expect(errors).toEqual([]); expect(warnings.map(f => f.code)).toEqual(['DRAFT_PRODUCER_ASSUMED']);
  expect(draftInputUnavailable(dir, 'inputs/foreground.png', 'derived/drafts/sample')).toBe(false);
});

test('a changed or missing project input refuses DRAFT_RIG_FILE', () => {
  const { dir, args } = occluderDraft(); draftRigCommand(args);
  write(dir, 'inputs/foreground.png', 'changed matte');
  const changed: Finding[] = []; checkDrafts(dir, read(dir), changed);
  expect(changed.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
  rmSync(join(dir, 'inputs/foreground.png'));
  const missing: Finding[] = []; const warnings: Finding[] = []; checkDrafts(dir, read(dir), missing, warnings);
  expect(missing.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
  expect(warnings.map(f => f.code)).not.toContain('DRAFT_RIG_UNAVAILABLE');
  expect(() => draftInputUnavailable(dir, 'inputs/foreground.png', 'derived/drafts/sample')).toThrow('missing');
});

test('an input that escapes the project or is not a regular file refuses before writing', () => {
  const outside = fixture(); write(outside, 'foreign.png', 'foreign matte');
  const lexical = occluderDraft(); const before = readFileSync(join(lexical.dir, 'project.json'));
  write(lexical.dir, 'derived/drafts/sample/config.json', JSON.stringify({ assemble: { occluders: [{ image: relative(join(lexical.dir, 'derived/drafts/sample'), join(outside, 'foreign.png')) }] } }));
  rejected(() => draftRigCommand(lexical.args), 'DRAFT_RIG_MALFORMED');
  expect(readFileSync(join(lexical.dir, 'project.json'))).toEqual(before);
  const linked = occluderDraft(); const linkedBefore = readFileSync(join(linked.dir, 'project.json'));
  rmSync(join(linked.dir, 'inputs/foreground.png')); symlinkSync(join(outside, 'foreign.png'), join(linked.dir, 'inputs/foreground.png'));
  rejected(() => draftRigCommand(linked.args), 'DRAFT_RIG_MALFORMED');
  expect(readFileSync(join(linked.dir, 'project.json'))).toEqual(linkedBefore);
  const folder = occluderDraft('../../../inputs'); const folderBefore = readFileSync(join(folder.dir, 'project.json'));
  rejected(() => draftRigCommand(folder.args), 'DRAFT_RIG_MALFORMED');
  expect(readFileSync(join(folder.dir, 'project.json'))).toEqual(folderBefore);
});

test('check refuses a hand-bound input that escapes the project', () => {
  const { dir, args } = occluderDraft(); draftRigCommand(args);
  const project = read(dir); const record = arr(project.drafts).at(-1) as JsonObject;
  record.config_inputs = [{ path: '../foreground.png', sha256: '0'.repeat(64) }];
  const errors: Finding[] = []; checkDrafts(dir, project, errors);
  expect(errors.map(f => f.code)).toEqual(['DRAFT_RIG_FILE', 'DRAFT_RIG_FILE']);
});
