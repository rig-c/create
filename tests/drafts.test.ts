import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { checkDrafts, draftRigCommand, draftVersionFindings } from '../src/drafts.ts';
import { handoff } from '../src/review.ts';
import { Refusal } from '../src/refusal.ts';
import { fixture, arr, obj } from './fixtures.ts';
import type { Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';

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
