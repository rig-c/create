/** Consumer-contract fixtures declare refs locally until parts #1281 is available. */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkDrafts } from '../src/drafts.ts';
import { EDITED_PART_INPUTS_SINCE } from '../src/edited-part-inputs.ts';
import { locateParts } from '../src/parts-sections.ts';
import type { Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, draftRigCommand, testClock } from './clock.ts';
import { arr, fixture, obj } from './fixtures.ts';

const CODE = 'DRAFT_EDITED_PART_UNBOUND';
const ROOT = 'derived/drafts/retouch';
const INPUT = 'inputs/edited/arm.png';
const MANIFEST = `${ROOT}/input/parts.json`;
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
// A synthetic PNG identity; these consumer tests do not claim to build or measure it.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
function put(dir: string, path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes);
}
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
afterEach(() => testClock.reset());

function editedDraft(declares = true, receiptSha = sha(PNG)): { dir: string; args: string[] } {
  const dir = fixture();
  const source = join(locateParts(dir)!, 'src/config.ts');
  // This is a fixture declaration, not a create-owned copy of the producer's path table.
  put(dir, 'node_modules/@rig-c/parts/package.json', JSON.stringify({ name: '@rig-c/parts', version: '0.0.0-synthetic', type: 'module' }));
  put(dir, 'node_modules/@rig-c/parts/src/config.ts', `export * from ${JSON.stringify(source)};
export function configFileReferences(config) { if (!config?.assemble?.edited_parts) return []; return ${JSON.stringify(declares ? [{ at: 'assemble.edited_parts.receipts[0].file', value: '../../../inputs/edited/arm.png' }] : [])}; }
`);
  const receipt = { part: 'arm', file: 'arm.png', from_sha256: 'a'.repeat(64), sha256: receiptSha,
    editor: 'Scripts and an image tool; retouched against the painting reference.' };
  put(dir, `${ROOT}/config.json`, JSON.stringify({ assemble: { edited_parts: { dir: '../../../inputs/edited', receipts: [receipt] } } }));
  put(dir, INPUT, PNG);
  put(dir, MANIFEST, JSON.stringify({ parts: [
    { name: 'arm', provenance: { edited_part: { edit: 'edited_parts[0]', dir: '../../../inputs/edited', receipt,
      changed_px: 1, changed_counted_px: 0, changed_excluded_px: 1, removed_opaque_px: 1 } } },
    { name: 'plain' },
  ] }));
  put(dir, `${ROOT}/input/parts/arm.png`, PNG);
  put(dir, `${ROOT}/input/recomposite_rig.png`, PNG);
  for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) put(dir, `${ROOT}/out/${name}`, '{}');
  return { dir, args: ['retouch', dir, '--config', `${ROOT}/config.json`, '--parts', `${ROOT}/input`, '--from', `${ROOT}/out`, '--json'] };
}

function report(dir: string, project = read(dir)): { refusals: Finding[]; warnings: Finding[] } {
  const refusals: Finding[] = [], warnings: Finding[] = [];
  checkDrafts(dir, project, refusals, warnings);
  return { refusals, warnings };
}
function refusedWithoutWrite(dir: string, args: string[], code: string): void {
  const before = readFileSync(join(dir, 'project.json'));
  expect(() => draftRigCommand(args)).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

test('a declared edited receipt file is bound by the existing writer and check has no refusals', () => {
  const { dir, args } = editedDraft();
  const result = draftRigCommand(args);
  expect(result.exit).toBe(0);
  expect((JSON.parse(result.stdout) as JsonObject).config_inputs).toEqual([{ path: INPUT, sha256: sha(PNG) }]);
  expect(report(dir).refusals).toEqual([]);
  expect(checkProject(dir).refusals).toEqual([]);
});

for (const defect of ['omitted', 'empty', 'wrong-sha', 'wrong-path'] as const) {
  for (const at of [new Date(Date.parse(EDITED_PART_INPUTS_SINCE) - 1).toISOString(), EDITED_PART_INPUTS_SINCE]) {
    test(`${defect} edited file binding is dated by draft.at=${at}, including with a loader declaring the ref`, () => {
      const { dir, args } = editedDraft(); draftRigCommand(args);
      const project = read(dir), draft = obj(arr(project.drafts)[0]);
      draft.at = at;
      if (defect === 'omitted') delete draft.config_inputs;
      if (defect === 'empty') draft.config_inputs = [];
      if (defect === 'wrong-path') {
        put(dir, 'inputs/other-arm.png', PNG);
        draft.config_inputs = [{ path: 'inputs/other-arm.png', sha256: sha(PNG) }];
      }
      if (defect === 'wrong-sha') {
        // Both the file and its recorded binding are current; the producer receipt names another sha.
        const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as JsonObject;
        obj(obj(obj(arr(manifest.parts)[0]).provenance).edited_part).receipt = {
          ...obj(obj(obj(obj(arr(manifest.parts)[0]).provenance).edited_part).receipt), sha256: 'b'.repeat(64),
        };
        const bytes = JSON.stringify(manifest); put(dir, MANIFEST, bytes);
        obj(arr(obj(draft.parts).files).find(file => obj(file).path === MANIFEST)).sha256 = sha(bytes);
      }
      const result = report(dir, project);
      const finding = { code: CODE, path: 'drafts[0].parts.files' };
      if (at === EDITED_PART_INPUTS_SINCE) expect(result.refusals).toEqual([expect.objectContaining(finding)]);
      else {
        expect(result.refusals).toEqual([]);
        expect(result.warnings).toContainEqual(expect.objectContaining(finding));
      }
      const found = [...result.refusals, ...result.warnings].find(f => f.code === CODE)!;
      expect(found.message).toContain('parts[0] (arm) provenance.edited_part');
      expect(found.message).toContain(INPUT);
      expect(found.message).toContain('draft-rig');
    });
  }
}

test('an install silently omitting the edited reference refuses before draft-rig writes', () => {
  const { dir, args } = editedDraft(false);
  refusedWithoutWrite(dir, args, CODE);
  expect(read(dir).drafts).toBeUndefined();
});

test('a receipt sha differing from the bound file refuses before draft-rig writes', () => {
  const { dir, args } = editedDraft(true, 'b'.repeat(64));
  refusedWithoutWrite(dir, args, CODE);
});

for (const missing of [false, true]) {
  test(`a recorded edited file that is ${missing ? 'deleted' : 'changed by one byte'} refuses DRAFT_RIG_FILE without changing project.json`, () => {
    const { dir, args } = editedDraft(); draftRigCommand(args);
    const before = readFileSync(join(dir, 'project.json'));
    if (missing) rmSync(join(dir, INPUT));
    else { const changed = Buffer.from(PNG); changed[changed.length - 1] ^= 1; put(dir, INPUT, changed); }
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
}

test('a changed untrusted manifest is refused without interpreting its edited provenance', () => {
  const { dir, args } = editedDraft(); draftRigCommand(args);
  put(dir, MANIFEST, JSON.stringify({ parts: [{ name: 'untrusted', provenance: { edited_part: {} } }] }));
  const result = report(dir);
  expect(result.refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
  expect(result.refusals.map(f => f.code)).not.toContain(CODE);
});

test('regenerable manifest absence keeps the existing unavailable warning and invents no receipt', () => {
  const { dir, args } = editedDraft(); draftRigCommand(args);
  rmSync(join(dir, MANIFEST));
  const result = report(dir);
  expect(result.refusals).toEqual([]);
  expect(result.warnings.map(f => f.code)).toContain('DRAFT_RIG_UNAVAILABLE');
});

test('pixel change figures are producer data and are not recalculated by the receipt binding check', () => {
  const { dir, args } = editedDraft();
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as JsonObject;
  const edit = obj(obj(obj(arr(manifest.parts)[0]).provenance).edited_part);
  edit.changed_px = 999; edit.removed_opaque_px = 888;
  put(dir, MANIFEST, JSON.stringify(manifest));
  expect(draftRigCommand(args).exit).toBe(0);
  expect(report(dir).refusals).toEqual([]);
});
