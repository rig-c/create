import { resignAfterChange } from './fixtures.ts';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { repackageFixtureVersion } from './review-fixture.ts';
import { type CheckReport } from '../src/check.ts';
import { FIGURE_MASK_MATTE_RECEIPT_SINCE, FIGURE_MASK_SINCE } from '../src/figure-mask.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { externalMaskEvidence } from './external-receipt-fixture.ts';
import { arr, fixture, obj, version, waypoint, type Mutate } from './fixtures.ts';
import { checkProject, derivedCommand, reviewCommand, handoff, signoffCommand } from './clock.ts';
import { tempDir } from './helpers.ts';

const load = createRequire(import.meta.url);
const { MATTE_GRAPH_ID, MATTE_NODE, MATTE_MODEL, matteGraph, matteGraphHash, matteParams, publishMatte } = load('@rig-c/parts/src/matte.ts') as typeof import('../node_modules/@rig-c/parts/src/matte.ts');
const { newRaster } = load('@rig-c/parts/src/raster/types.ts') as typeof import('../node_modules/@rig-c/parts/src/raster/types.ts');
const { encodePngBytes } = load('@rig-c/parts/src/raster/png.ts') as typeof import('../node_modules/@rig-c/parts/src/raster/png.ts');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const findings = (report: CheckReport) => [...report.refusals, ...report.warnings].filter((f) => f.code.startsWith('FIGURE_MASK_'));
const legacyMatte = 'FIGURE_MASK_MATTE_RECEIPT_LEGACY';
// Opaque synthetic bytes exercise binding only. PNG validity is parts' contract.
const mask = 'synthetic figure support';
function project(setup: JsonObject = { figure_mask: { path: 'figure.png', sha256: sha(mask) } }, mutate: Mutate = () => {}, ground = 'busy', files: Record<string, Uint8Array> = {}): string {
  const config = json({ assemble: { project: 'visible', ground }, requirements: 'requirements.json' });
  return repackageFixtureVersion(fixture((p) => {
    const guide = obj(waypoint(p, 'assemble').guide);
    obj(guide.value).project = 'visible';
    obj(guide.value).ground = ground;
    arr(guide.asks).push({ id: 'ground', state: 'user' });
    const v = version(p, 1);
    v.at = FIGURE_MASK_SINCE;
    obj(v.provenance).config = { path: 'evidence/mask/config.json', sha256: sha(config) };
    p.derived = [{ kind: 'prepared-input', path: 'evidence/mask/figure.png', sha256: sha(mask), source: { path: 'painting.txt', sha256: sha('original') }, operation: 'Synthetic matte alpha >= 128 minus no foreground plane' }];
    mutate(p);
  }, 'legacy-example-project.json', {
    'evidence/mask/config.json': config,
    'evidence/mask/requirements.json': json({ setup_painting: { required: true, ...setup } }),
    'evidence/mask/figure.png': mask,
    'painting.txt': 'original',
    'foreground.txt': 'foreground',
    ...files,
  }), 1);
}

function matteProject(): string {
  const producer = tempDir();
  const painting = newRaster(2, 2);
  painting.data.fill(255);
  const bytes = encodePngBytes(painting);
  const paintingPath = join(producer, 'painting.png');
  const output = join(producer, 'matte');
  const graph = matteGraph('painting.png', 'synthetic');
  writeFileSync(paintingPath, bytes);
  const receipt = publishMatte(output, paintingPath, bytes, bytes, {
    model: { node: MATTE_NODE, name: MATTE_MODEL, checkpoint_sha256: 'a'.repeat(64), checkpoint_sha256_from: 'declared' },
    params: matteParams(64, 10),
    graph: { id: MATTE_GRAPH_ID, api: graph, sha256: matteGraphHash(graph) },
    gpu: 'synthetic', input_transform: null, input_sha256: sha(bytes),
  });
  const dir = project({ figure_mask: { path: 'matte/mask.png', sha256: receipt.output.sha256 } }, p => {
    p.derived = [];
    version(p, 1).at = FIGURE_MASK_MATTE_RECEIPT_SINCE;
  }, 'busy', {
    'evidence/mask/painting.png': bytes,
    'evidence/mask/matte/model-mask.png': readFileSync(join(output, 'model-mask.png')),
    'evidence/mask/matte/mask.png': readFileSync(join(output, 'mask.png')),
    'evidence/mask/matte/receipt.json': readFileSync(join(output, 'receipt.json')),
  });
  derivedCommand(['add', dir, '--source', 'evidence/mask/painting.png', '--file', 'evidence/mask/matte/mask.png', '--receipt', 'evidence/mask/matte/receipt.json']);
  return dir;
}

function externalMaskProject(at: string): string {
  const { paintingBytes, maskBytes, receipt } = externalMaskEvidence();
  const dir = project({ figure_mask: { path: 'external/mask.png', sha256: receipt.file.sha256 } }, p => {
    p.derived = [];
    version(p, 1).at = at;
  }, 'busy', {
    'evidence/mask/painting.png': paintingBytes,
    'evidence/mask/external/mask.png': maskBytes,
    'evidence/mask/external/receipt.json': Buffer.from(json(receipt)),
  });
  derivedCommand(['add', dir, '--source', 'evidence/mask/painting.png', '--file', 'evidence/mask/external/mask.png', '--receipt', 'evidence/mask/external/receipt.json']);
  return dir;
}

describe('figure mask declaration and provenance', () => {
  test('declared and recorded legacy busy mask passes with an operation provenance warning', () => {
    const report = checkProject(resignAfterChange(project()));
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'PARTS_VERDICT_FILE_LEGACY', 'RIGGING_INTERVIEW_PAINTING_LEGACY', legacyMatte, 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });
  test('valid producer matte clears the busy-ground gate at the cutoff without operation text', () => {
    const report = checkProject(resignAfterChange(matteProject()));
    expect(report.refusals).toEqual([]);
    expect(findings(report)).toEqual([]);
  });
  test.each(['2026-11-18T23:59:59Z', FIGURE_MASK_MATTE_RECEIPT_SINCE])('bound external mask clears the busy-ground gate without operation text at %s', at => {
    const report = checkProject(resignAfterChange(externalMaskProject(at)));
    expect(report.refusals).toEqual([]);
    expect(findings(report)).toEqual([]);
  });
  test.each(['painting.png', 'external/receipt.json'])('a changed external %s refuses figure-mask approval before writing', path => {
    const dir = externalMaskProject(FIGURE_MASK_MATTE_RECEIPT_SINCE);
    const evidence = join(dir, 'evidence/mask', path);
    writeFileSync(evidence, Buffer.concat([readFileSync(evidence), Buffer.from('\n')]));
    const report = checkProject(dir);
    const code = 'FIGURE_MASK_EXTERNAL_RECEIPT_INVALID';
    expect(findings(report).map(f => f.code)).toEqual([code]);
    expect(report.refusals.some(f => f.code === 'EXTERNAL_RECEIPT_INVALID')).toBe(true);
    writeFileSync(join(dir, 'words.txt'), 'Approve synthetic rig');
    const before = readFileSync(join(dir, 'project.json'));
    expect(() => reviewCommand(['1', dir, '--review', 'rig-review', '--verdict', 'accepted', '--by', 'user', '--verbatim-file', join(dir, 'words.txt'), '--source', 'synthetic control']))
      .toThrow(expect.objectContaining({ code }));
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
  test('operation-only provenance warns one second before the cutoff and refuses at it', () => {
    const dir = project(undefined, p => { version(p, 1).at = '2026-11-18T23:59:59Z'; });
    const before = checkProject(resignAfterChange(dir));
    expect(before.refusals).toEqual([]);
    expect(findings(before).map(f => f.code)).toEqual([legacyMatte]);
    changeRecord(dir, p => { version(p, 1).at = FIGURE_MASK_MATTE_RECEIPT_SINCE; });
    const at = checkProject(dir);
    expect(at.refusals.filter(f => f.code.startsWith('FIGURE_MASK_')).map(f => f.code)).toEqual(['FIGURE_MASK_MATTE_RECEIPT_MISSING']);
    expect(at.warnings.some(f => f.code === legacyMatte)).toBe(false);
  });
  test('a changed raw matte invalidates the gate at approval even with intact frozen mask bytes', () => {
    const dir = matteProject();
    writeFileSync(join(dir, 'evidence/mask/matte/model-mask.png'), 'changed');
    const report = checkProject(dir);
    expect(findings(report).map(f => f.code)).toEqual(['FIGURE_MASK_MATTE_RECEIPT_INVALID']);
    expect(report.refusals.some(f => f.code === 'MATTE_RECEIPT_INVALID')).toBe(true);
    writeFileSync(join(dir, 'words.txt'), 'Approve synthetic rig');
    const before = readFileSync(join(dir, 'project.json'));
    expect(() => reviewCommand(['1', dir, '--review', 'rig-review', '--verdict', 'accepted', '--by', 'user', '--verbatim-file', join(dir, 'words.txt'), '--source', 'synthetic control']))
      .toThrow(expect.objectContaining({ code: 'FIGURE_MASK_MATTE_RECEIPT_INVALID' }));
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
  test('a receipt bound to equal mask bytes at another locator cannot authorize the frozen declaration', () => {
    const dir = matteProject();
    const path = 'evidence/mask/matte/mask.png';
    const copy = 'evidence/mask/figure.png';
    writeFileSync(join(dir, copy), readFileSync(join(dir, path)));
    changeRecord(dir, p => { obj(arr(p.derived)[0]).path = copy; });
    expect(findings(checkProject(dir)).map(f => f.code)).toEqual(['FIGURE_MASK_MATTE_RECEIPT_MISSING']);
  });
  test('missing declaration refuses at the retained version', () => {
    expect(findings(checkProject(project({}))).map((f) => f.code)).toEqual(['FIGURE_MASK_MISSING']);
  });
  test.each([
    { path: 'figure.png', sha256: sha('wrong') },
    { path: 'absent.png', sha256: sha(mask) },
  ])('wrong or missing mask bytes refuse packaging: %j', figure_mask => {
    let error: unknown;
    try { project({ figure_mask }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe('FIGURE_MASK_CHANGED');
  });
  test('unrecorded mask refuses', () => {
    const report = findings(checkProject(project(undefined, (p) => { p.derived = []; })));
    expect(report.map((f) => f.code)).toEqual(['FIGURE_MASK_UNRECORDED']);
    expect(report[0]?.message).toContain('evidence/mask/figure.png');
  });
  test.each(['2026-11-05T23:59:59Z', 'undated'])('older declarations warn: %s', (at) => {
    const dir = project({});
    changeRecord(dir, p => { version(p, 1).at = at; });
    const report = checkProject(dir);
    expect(report.refusals.filter(f => f.code === 'RIG_VERSION_AT_INVALID').map(f => f.code)).toEqual(at === 'undated' ? ['RIG_VERSION_AT_INVALID'] : []);
    expect(findings(report).map((f) => f.code)).toEqual(['FIGURE_MASK_LEGACY']);
    expect(report.refusals.some((f) => f.code.startsWith('FIGURE_MASK_'))).toBe(false);
  });
  test.each<JsonObject>([{}, { path: 'figure.png' }, { path: '', sha256: sha(mask) }])('malformed declarations refuse: %j', (figure_mask) => {
    try { project({ figure_mask }); throw new Error('packaging succeeded'); } catch (error) { expect((error as Refusal).code).toBe('FIGURE_MASK_MISSING'); }
  });
  test.each<JsonObject>([{ sources: [] }, { sources: [{}] }])('missing or malformed provenance sources refuse: %j', ({ sources }) => {
    const report = checkProject(project(undefined, (p) => {
      const entry = obj(arr(p.derived)[0]);
      delete entry.source;
      entry.sources = sources;
    }));
    expect(findings(report).map((f) => f.code)).toEqual(['FIGURE_MASK_UNRECORDED']);
    expect(report.refusals.some((f) => f.code === 'DERIVED_MALFORMED')).toBe(true);
  });
  test('pre-interview records skip the declaration', () => {
    expect(findings(checkProject(project({}, (p) => { version(p, 1).pre_interview = true; })))).toEqual([]);
  });
  test('plain ground produces no mask finding', () => {
    expect(findings(checkProject(project({}, () => {}, 'plain')))).toEqual([]);
  });
  test('multiple sources bind each input and retain mask acceptance', () => {
    const dir = project(undefined, (p) => { p.derived = []; });
    derivedCommand(['add', dir, '--source', 'painting.txt', '--source', 'foreground.txt', '--file', 'evidence/mask/figure.png', '--operation', 'Synthetic matte alpha >= 128 minus foreground plane']);
    const report = checkProject(dir);
    expect(findings(report).map(f => f.code)).toEqual([legacyMatte]);
    expect(report.refusals.filter((f) => f.code.startsWith('DERIVED_'))).toEqual([]);
    writeFileSync(join(dir, 'foreground.txt'), 'changed');
    expect(checkProject(dir).refusals.some((f) => f.code === 'DERIVED_FILE_CHANGED' && f.path === 'derived[0].sources[1].sha256')).toBe(true);
  });
  test('a later source cannot name the result itself', () => {
    const dir = project();
    const file = join(dir, 'project.json');
    const before = readFileSync(file);
    expect(() => derivedCommand(['add', dir, '--source', 'painting.txt', '--source', 'evidence/mask/figure.png', '--file', 'evidence/mask/figure.png', '--operation', 'Synthetic matte'])).toThrow();
    expect(readFileSync(file)).toEqual(before);
  });
  test('refused multi-source writer preserves project bytes', () => {
    const dir = project();
    const file = join(dir, 'project.json');
    const before = readFileSync(file);
    expect(() => derivedCommand(['add', dir, '--source', 'painting.txt', '--source', 'missing.txt', '--file', 'evidence/mask/figure.png', '--operation', 'Synthetic matte alpha >= 128 minus none'])).toThrow();
    expect(readFileSync(file)).toEqual(before);
  });
});

function changeRecord(dir: string, mutate: Mutate): void {
  const file = join(dir, 'project.json');
  const value = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  mutate(value);
  writeFileSync(file, json(value));
}

const states = ['honest', 'altered', 'missing'] as const;
for (const input of ['requirements.json', 'figure.png']) {
  for (const frozen of states) {
    test.each(states)(`${input}: frozen ${frozen}, live %s`, live => {
      const dir = project();
      const frozenPath = join(dir, 'derived/review/v1', input);
      const livePath = join(dir, 'evidence/mask', input);
      for (const [path, state] of [[frozenPath, frozen], [livePath, live]] as const) {
        if (state === 'altered') writeFileSync(path, input === 'figure.png' ? 'different matte bytes' : json({ setup_painting: { figure_mask: { path: 'other.png', sha256: sha('other bytes') } } }));
        if (state === 'missing') rmSync(path);
      }
      const report = checkProject(dir);
      expect(findings(report).map(f => f.code)).toEqual(frozen === 'honest' ? [legacyMatte] : []);
      expect(report.refusals.some(f => f.code === 'REVIEW_PACKAGE_CHANGED')).toBe(frozen !== 'honest');
    });
  }
}

test.each(['requirements.json', 'figure.png'])('a removed frozen %s binding has an era-specific finding', input => {
  for (const at of [FIGURE_MASK_SINCE, '2026-11-05T23:59:59Z']) {
    const dir = project(undefined, p => { version(p, 1).at = at; });
    // Remove an existing binding after the real packager produced it.
    rmSync(join(dir, 'derived/review/v1', input));
    changeRecord(dir, p => {
      const pkg = obj(version(p, 1).review_package);
      pkg.files = arr(pkg.files).filter(f => obj(f).path !== input);
    });
    const report = checkProject(dir);
    expect(findings(report).map(f => f.code)).toEqual([at === FIGURE_MASK_SINCE ? 'FIGURE_MASK_INPUT_UNBOUND' : 'FIGURE_MASK_INPUTS_LEGACY']);
  }
});

test.each(['record', 'directory'])('an unpackaged new-era version has no mask verdict when %s is absent', missing => {
  const dir = project({});
  if (missing === 'record') changeRecord(dir, p => { delete version(p, 1).review_package; });
  else rmSync(join(dir, 'derived/review/v1'), { recursive: true });
  const report = checkProject(dir);
  expect(findings(report)).toEqual([]);
  expect(report.warnings.some(f => f.code === 'REVIEW_PACKAGE_MISSING' && f.path === 'versions[v1].review_package')).toBe(true);
});

test('post versions do not receive a rig figure-mask verdict', () => {
  const dir = project({});
  changeRecord(dir, p => { version(p, 1).kind = 'post'; });
  expect(findings(checkProject(dir))).toEqual([]);
});

test('equal mask bytes at a different original locator do not count as prepared input', () => {
  const dir = project(undefined, p => { obj(arr(p.derived)[0]).path = 'another/figure.png'; });
  expect(findings(checkProject(dir)).map(f => f.code)).toEqual(['FIGURE_MASK_UNRECORDED']);
});

test('the nested mask is retained without joining handoff named inputs', async () => {
  const dir = project();
  const value = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const record = obj(version(value, 1).review_package);
  expect(arr(record.files).some(f => obj(f).path === 'figure.png')).toBe(true);
  const { reviewHandoffInputs } = await import('../src/review-package.ts');
  expect(reviewHandoffInputs(record, dir, 1).some(f => f.path === 'figure.png')).toBe(false);
});

test.each(['unrecorded', 'requirements.json', 'figure.png'])('check, acceptance, signoff and handoff share the frozen mask finding: %s', missing => {
  const dir = project(undefined, p => {
    p.versions = arr(p.versions).filter(v => obj(v).n === 1);
    if (missing === 'unrecorded') p.derived = [];
    version(p, 1).verdicts = [{ review: 'rig-review', verdict: 'accepted', by: 'user', at: FIGURE_MASK_SINCE, verbatim: 'Accept synthetic rig' }];
  });
  if (missing !== 'unrecorded') {
    rmSync(join(dir, 'derived/review/v1', missing));
    changeRecord(dir, p => {
      const pkg = obj(version(p, 1).review_package);
      pkg.files = arr(pkg.files).filter(f => obj(f).path !== missing);
    });
  }
  const code = missing === 'unrecorded' ? 'FIGURE_MASK_UNRECORDED' : 'FIGURE_MASK_INPUT_UNBOUND';
  expect(findings(checkProject(dir)).map(f => f.code)).toEqual([code]);
  writeFileSync(join(dir, 'words.txt'), 'Approve synthetic rig');
  const before = readFileSync(join(dir, 'project.json'));
  const operations = [
    () => reviewCommand(['1', dir, '--review', 'rig-review', '--verdict', 'accepted', '--by', 'user', '--verbatim-file', join(dir, 'words.txt'), '--source', 'synthetic control']),
    () => signoffCommand(['rig-review', dir, '--version', '1', '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]),
    () => handoff(dir, 1),
  ];
  for (const operation of operations) {
    let error: unknown;
    try { operation(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  }
});

for (const legacy of [false, true]) {
  test(`an unavailable file-declarations export follows the ${legacy ? 'legacy' : 'current'} package diagnostic`, () => {
    const dir = project(undefined, p => { if (legacy) version(p, 1).at = '2026-11-05T23:59:59Z'; });
    const installed = join(dir, 'node_modules/@rig-c/parts');
    mkdirSync(join(installed, 'src'), { recursive: true });
    writeFileSync(join(installed, 'package.json'), json({ name: '@rig-c/parts', version: '2.8.0', type: 'module' }));
    writeFileSync(join(installed, 'src/config.ts'), 'export const CONFIG_SECTIONS = ["assemble"];');
    const report = checkProject(dir);
    expect(findings(report)).toEqual([]);
    expect((legacy ? report.warnings : report.refusals).some(f => f.code === 'REVIEW_PACKAGE_INPUT_INVALID' && f.path === 'versions[v1].review_package')).toBe(true);
  });
}

test('repointing the live declaration cannot authorize a mask omitted from the frozen package', () => {
  const dir = resignAfterChange(project(undefined, p => {
    arr(p.derived).push({ kind: 'prepared-input', path: 'foreground.txt', sha256: sha('foreground'), source: { path: 'painting.txt', sha256: sha('original') }, operation: 'Synthetic alternate matte' });
  }));
  expect(checkProject(dir).refusals).toEqual([]);
  rmSync(join(dir, 'derived/review/v1/figure.png'), { force: true });
  changeRecord(dir, p => {
    const pkg = obj(version(p, 1).review_package);
    pkg.files = arr(pkg.files).filter(f => obj(f).path !== 'figure.png');
  });
  writeFileSync(join(dir, 'evidence/mask/requirements.json'), json({ setup_painting: { required: true, figure_mask: { path: '../../foreground.txt', sha256: sha('foreground') } } }));
  expect(findings(checkProject(dir)).map(f => f.code)).toEqual(['FIGURE_MASK_INPUT_UNBOUND']);
});
