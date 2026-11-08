import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkDrafts, draftVersionFindings } from '../src/drafts.ts';
import { Refusal } from '../src/refusal.ts';
import { fixture, arr, obj } from './fixtures.ts';
import type { Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, draftRigCommand, handoff } from './clock.ts';
import { retainedPartsFiles } from './draft-fixture.ts';

function write(dir: string, path: string, bytes = '{}'): void { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes); }
function draft(build = false): { dir: string; args: string[] } {
  const dir = fixture(); const root = 'derived/drafts/sample'; const out = `${root}/out`; const parts = build ? out : `${root}/inputs`;
  write(dir, `${root}/config.json`);
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
