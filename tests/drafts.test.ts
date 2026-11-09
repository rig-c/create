import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { checkDrafts, draftInputUnavailable, draftVersionFindings } from '../src/drafts.ts';
import { configInputReferences, DRAFT_CONFIG_INPUTS_SINCE, plateReceiptSpec } from '../src/config-inputs.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
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

/** A synthetic See-through occluder plate directory, as `comfy plate --mode occluder` lays it out: its receipt beside its images. */
function writePlate(dir: string, at: string): string {
  write(dir, `${at}/plate.png`, 'synthetic plate pixels'); write(dir, `${at}/mask.png`, 'synthetic mask pixels');
  write(dir, `${at}/receipt.json`, JSON.stringify({ spec: plateReceiptSpec(dir), synthetic: 'occluder plate receipt', mode: 'occluder' }));
  return createHash('sha256').update(readFileSync(join(dir, `${at}/receipt.json`))).digest('hex');
}
/** A draft whose config names an occluder plate directory: under the draft root (`plate`) or a project input (`../../../inputs/plate`). */
function plateDraft(plate: string): { dir: string; args: string[]; config: JsonObject } {
  const { dir, args } = draft(); const config = { assemble: { occluders: [{ plate }] } };
  write(dir, 'derived/drafts/sample/config.json', JSON.stringify(config));
  return { dir, args, config };
}

for (const [route, plate, at] of [['project input', '../../../inputs/plate', 'inputs/plate'], ['draft-root input', 'plate', 'derived/drafts/sample/plate']] as const) {
  test(`an occluder plate directory as a ${route} binds its receipt, records and checks clean`, () => {
    const { dir, args, config } = plateDraft(plate); const sha256 = writePlate(dir, at);
    // The installed parts declares the plate as a config-named input.
    expect(configInputReferences(dir, config).map(ref => ref.at)).toEqual(['assemble.occluders[0].plate']);
    const record = JSON.parse(draftRigCommand(args).stdout) as JsonObject;
    expect(record.config_inputs).toEqual([{ path: `${at}/receipt.json`, sha256, directory: at, spec: plateReceiptSpec(dir) }]);
    expect(checkProject(dir).refusals).toEqual([]);
    const errors: Finding[] = []; const warnings: Finding[] = []; checkDrafts(dir, read(dir), errors, warnings);
    expect(errors).toEqual([]); expect(warnings.map(f => f.code)).toEqual(['DRAFT_PRODUCER_ASSUMED']);
    expect(draftInputUnavailable(dir, `${at}/receipt.json`, 'derived/drafts/sample')).toBe(false);
    // The receipt binds its siblings; create reads the receipt and never re-hashes them.
    write(dir, `${at}/plate.png`, 'regenerated plate pixels');
    const siblings: Finding[] = []; checkDrafts(dir, read(dir), siblings); expect(siblings).toEqual([]);
  });

  test(`a changed or deleted plate receipt as a ${route} refuses by code`, () => {
    const { dir, args } = plateDraft(plate); writePlate(dir, at); draftRigCommand(args);
    write(dir, `${at}/receipt.json`, JSON.stringify({ spec: plateReceiptSpec(dir), synthetic: 'another receipt' }));
    const changed: Finding[] = []; checkDrafts(dir, read(dir), changed);
    expect(changed.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
    rmSync(join(dir, `${at}/receipt.json`));
    const missing: Finding[] = []; const warnings: Finding[] = []; checkDrafts(dir, read(dir), missing, warnings);
    if (route === 'project input') {
      expect(missing.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
      expect(warnings.map(f => f.code)).not.toContain('DRAFT_RIG_UNAVAILABLE');
    } else {
      // A draft-root plate is a regenerable draft artifact, as a draft-root file input is.
      expect(missing).toEqual([]);
      expect(warnings.map(f => f.code)).toContain('DRAFT_RIG_UNAVAILABLE');
    }
  });
}

test('a plate directory without a plate receipt refuses before writing', () => {
  for (const shape of ['absent', 'directory', 'symlink', 'empty', 'foreign-spec'] as const) {
    const { dir, args } = plateDraft('../../../inputs/plate'); writePlate(dir, 'inputs/plate');
    rmSync(join(dir, 'inputs/plate/receipt.json'));
    if (shape === 'directory') mkdirSync(join(dir, 'inputs/plate/receipt.json'));
    if (shape === 'symlink') { write(dir, 'inputs/other.json', '{}'); symlinkSync(join(dir, 'inputs/other.json'), join(dir, 'inputs/plate/receipt.json')); }
    // A regular file that is not a plate receipt: no spec, or another producer's spec.
    if (shape === 'empty') write(dir, 'inputs/plate/receipt.json', '{}');
    if (shape === 'foreign-spec') write(dir, 'inputs/plate/receipt.json', JSON.stringify({ spec: 'rig-run/1', synthetic: 'unrelated report' }));
    const before = readFileSync(join(dir, 'project.json'));
    try { draftRigCommand(args); throw Error('expected refusal'); } catch (e) {
      expect(e).toBeInstanceOf(Refusal); expect((e as Refusal).code).toBe('DRAFT_RIG_MALFORMED');
      expect((e as Refusal).message).toContain('assemble.occluders[0].plate');
    }
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  }
});

test('check refuses a plate binding that does not stand for the named directory', () => {
  const { dir, args } = plateDraft('../../../inputs/plate'); writePlate(dir, 'inputs/plate'); draftRigCommand(args);
  const forged = read(dir); const input = arr(obj(arr(forged.drafts).at(-1)).config_inputs)[0] as JsonObject;
  input.directory = 'inputs/elsewhere';
  const malformed: Finding[] = []; checkDrafts(dir, forged, malformed);
  expect(malformed.map(f => f.code)).toEqual(['DRAFT_RIG_MALFORMED']);
  const unbound = read(dir); const record = arr(unbound.drafts).at(-1) as JsonObject;
  record.config_inputs = [{ path: 'inputs/plate/receipt.json', sha256: (input.sha256 as string) }];
  const missing: Finding[] = []; checkDrafts(dir, unbound, missing);
  expect(missing.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
  expect(missing[0]?.message).toContain('config.assemble.occluders[0].plate');
  const specless = read(dir); delete (arr(obj(arr(specless.drafts).at(-1)).config_inputs)[0] as JsonObject).spec;
  const shape: Finding[] = []; checkDrafts(dir, specless, shape);
  expect(shape.map(f => f.code)).toEqual(['DRAFT_RIG_MALFORMED']);
  const respecced = read(dir); (arr(obj(arr(respecced.drafts).at(-1)).config_inputs)[0] as JsonObject).spec = 'rig-run/1';
  const wrong: Finding[] = []; checkDrafts(dir, respecced, wrong);
  expect(wrong.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
  expect(wrong[0]?.message).toContain('declares spec');
});

test('an installed parts without PLATE_RECEIPT_SPEC refuses a plate by name before writing', () => {
  const { dir, args } = plateDraft('../../../inputs/plate'); writePlate(dir, 'inputs/plate');
  // A synthetic parts that declares the plate reference but no plate-receipt spec.
  write(dir, 'node_modules/@rig-c/parts/package.json', '{"name":"@rig-c/parts","version":"0.0.1-synthetic","type":"module"}');
  write(dir, 'node_modules/@rig-c/parts/src/config.ts', 'export const CONFIG_SECTIONS = ["assemble"];\nexport function configFileReferences(raw) { return raw.assemble.occluders.map((o, i) => ({ at: `assemble.occluders[${i}].plate`, value: o.plate })); }\n');
  const before = readFileSync(join(dir, 'project.json'));
  try { draftRigCommand(args); throw Error('expected refusal'); } catch (e) {
    expect(e).toBeInstanceOf(Refusal); expect((e as Refusal).code).toBe('DRAFT_RIG_MALFORMED');
    expect((e as Refusal).message).toContain('PLATE_RECEIPT_SPEC');
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

/** #322: a draft recorded with no config_inputs key on a config that names an occluder image, dated `at`. */
function unrecordedDraft(at: string): { dir: string; args: string[]; project: JsonObject } {
  const { dir, args } = occluderDraft(); draftRigCommand(args);
  const project = read(dir); const record = arr(project.drafts).at(-1) as JsonObject;
  delete record.config_inputs; record.at = at;
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return { dir, args, project };
}
const beforeSince = '2026-11-08T22:39:19.613Z';

test('an absent config_inputs key on a config naming an occluder image WARNs before DRAFT_CONFIG_INPUTS_SINCE and refuses from it', () => {
  const early = unrecordedDraft(beforeSince);
  const refusals: Finding[] = []; const warnings: Finding[] = []; checkDrafts(early.dir, early.project, refusals, warnings);
  expect(refusals).toEqual([]);
  expect(warnings.filter(f => f.code === 'DRAFT_CONFIG_INPUTS_UNRECORDED').map(f => f.path)).toEqual(['drafts[0].config_inputs']);
  expect(warnings.find(f => f.code === 'DRAFT_CONFIG_INPUTS_UNRECORDED')!.message).toContain('inputs/foreground.png');
  expect(checkProject(early.dir).refusals).toEqual([]);
  const late = unrecordedDraft(DRAFT_CONFIG_INPUTS_SINCE);
  const lateRefusals: Finding[] = []; const lateWarnings: Finding[] = []; checkDrafts(late.dir, late.project, lateRefusals, lateWarnings);
  expect(lateRefusals.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
  expect(lateWarnings.map(f => f.code)).not.toContain('DRAFT_CONFIG_INPUTS_UNRECORDED');
});

test('a present config_inputs binding that is wrong refuses DRAFT_RIG_FILE on both sides of DRAFT_CONFIG_INPUTS_SINCE', () => {
  for (const at of [beforeSince, DRAFT_CONFIG_INPUTS_SINCE]) {
    const hashed = occluderDraft(); draftRigCommand(hashed.args);
    const project = read(hashed.dir); const record = arr(project.drafts).at(-1) as JsonObject;
    record.at = at; (arr(record.config_inputs)[0] as JsonObject).sha256 = '0'.repeat(64);
    const refusals: Finding[] = []; const warnings: Finding[] = []; checkDrafts(hashed.dir, project, refusals, warnings);
    expect(refusals.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
    expect(warnings.map(f => f.code)).not.toContain('DRAFT_CONFIG_INPUTS_UNRECORDED');
    // A present key missing one of two named inputs is not the unrecorded route.
    const { dir, args } = occluderDraft();
    write(dir, 'derived/drafts/sample/config.json', JSON.stringify({ assemble: { occluders: [{ image: '../../../inputs/foreground.png' }, { image: '../../../inputs/second.png' }] } }));
    write(dir, 'inputs/second.png', 'synthetic second matte');
    draftRigCommand(args);
    const partial = read(dir); const kept = arr(partial.drafts).at(-1) as JsonObject;
    kept.at = at; kept.config_inputs = arr(kept.config_inputs).slice(0, 1);
    const missing: Finding[] = []; const missingWarnings: Finding[] = []; checkDrafts(dir, partial, missing, missingWarnings);
    expect(missing.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
    expect(missing[0]?.message).toContain('inputs/second.png');
    expect(missingWarnings.map(f => f.code)).not.toContain('DRAFT_CONFIG_INPUTS_UNRECORDED');
  }
});

test('draft-rig records a new draft beside a WARN-only unrecorded draft, and check has no refusals', () => {
  const { dir } = unrecordedDraft(beforeSince);
  const root = 'derived/drafts/next';
  write(dir, `${root}/config.json`, JSON.stringify({ assemble: { occluders: [{ image: '../../../inputs/foreground.png' }] } }));
  write(dir, `${root}/inputs/recomposite_rig.png`, 'synthetic stack bytes');
  write(dir, `${root}/inputs/parts.json`); write(dir, `${root}/inputs/parts/synthetic.png`, 'synthetic part bytes');
  for (const file of ['rig.json', 'motion.json', 'mesh_report.json']) write(dir, `${root}/out/${file}`);
  const result = draftRigCommand(['next', dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/inputs`, '--json']);
  expect(result.exit).toBe(0);
  expect(arr((JSON.parse(result.stdout) as JsonObject).config_inputs).map(f => obj(f).path)).toEqual(['inputs/foreground.png']);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.filter(f => f.code === 'DRAFT_CONFIG_INPUTS_UNRECORDED').map(f => f.path)).toEqual(['drafts[0].config_inputs']);
});

/** A synthetic project install of parts at `version`; `references` is its configFileReferences body, or none when null. */
function installParts(dir: string, version: string, references: string | null): void {
  write(dir, 'node_modules/@rig-c/parts/package.json', JSON.stringify({ name: '@rig-c/parts', version, type: 'module' }));
  write(dir, 'node_modules/@rig-c/parts/src/config.ts', `export const CONFIG_SECTIONS = ["assemble"];\n${references === null ? '' : `export function configFileReferences(raw) { ${references} }\n`}`);
}

test('draft-rig refuses DRAFT_PARTS_INSTALL_BEHIND when the install cannot declare inputs its newer producer declares', () => {
  const pinned = PINNED_PACKAGES['@rig-c/parts'];
  for (const references of [null, 'return [];']) {
    const { dir, args } = occluderDraft(); write(dir, stampAt(false), runStamp(pinned));
    installParts(dir, '2.8.0', references);
    const before = readFileSync(join(dir, 'project.json'));
    try { draftRigCommand(args); throw Error('expected refusal'); } catch (e) {
      expect(e).toBeInstanceOf(Refusal); expect((e as Refusal).code).toBe('DRAFT_PARTS_INSTALL_BEHIND');
      expect((e as Refusal).message).toContain(`install @rig-c/parts ${pinned}`);
      expect((e as Refusal).message).toContain('config.assemble.occluders[0].image');
    }
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  }
});

test('without a newer producer, or with a config naming nothing, draft-rig keeps its earlier behaviour', () => {
  const pinned = PINNED_PACKAGES['@rig-c/parts'];
  // The producer is the old install itself: no run.json, so the unavailable loader refuses as before.
  const same = occluderDraft(); installParts(same.dir, '2.8.0', null);
  rejected(() => draftRigCommand(same.args), 'DRAFT_RIG_MALFORMED');
  // A newer producer whose config names no inputs records with no config_inputs key.
  const plain = draft(); write(plain.dir, stampAt(false), runStamp(pinned)); installParts(plain.dir, '2.8.0', null);
  const record = JSON.parse(draftRigCommand(plain.args).stdout) as JsonObject;
  expect(record.config_inputs).toBeUndefined();
  expect(record.producer).toEqual({ name: '@rig-c/parts', version: pinned });
  // An install that declares what the pinned parts declares binds as before.
  const both = occluderDraft(); write(both.dir, stampAt(false), runStamp(pinned));
  expect(arr((JSON.parse(draftRigCommand(both.args).stdout) as JsonObject).config_inputs)).toHaveLength(1);
});
