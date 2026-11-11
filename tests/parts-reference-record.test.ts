import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkProject as rawCheckProject, type Finding } from '../src/check.ts';
import { checkPartsReferences, partsReferenceCommand, readPartsReferences } from '../src/parts-reference-record.ts';
import { draftPublishedContext, prepareDraftManifest, readPublished } from '../src/job-publication.ts';
import { acquireJobLock, JOB_BINDING_FILE, jobHash, publicationVersionHash, writePrivateJson } from '../src/job-outbox.ts';
import { checkProject, draftRigCommand, main, TEST_NOW } from './clock.ts';
import { fixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { retainedPartsFiles } from './draft-fixture.ts';
import type { Json, JsonObject } from '../src/templates.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = 'derived/drafts/sample/input';
const sidecarPath = `${input}/painting_in_rig.json`;
const imagePath = `${input}/painting_in_rig.png`;
const put = (root: string, path: string, bytes: string | Buffer): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
const save = (root: string, project: JsonObject): void => put(root, 'project.json', `${JSON.stringify(project, null, 2)}\n`);
const args = (root: string): string[] => ['sample', root, '--file', sidecarPath, '--json'];

/** Byte-only references test hash transport, not Review PNG/opacity or visual acceptance. */
function workspace(full = false, realReference = false): string {
  const producer = retainedPartsFiles(join(import.meta.dir, '../templates/example-draft/input'));
  const painting = Buffer.from(producer['painting_in_rig.png']!);
  const source = { path: 'inputs/painting.png', sha256: jobHash(painting), bytes: painting.length,
    origin: 'synthetic painting from the generated parts fixture', at: '2026-11-09T00:00:00Z' };
  const root = realpathSync(full ? fixture(project => { project.inputs = [source]; }, 'legacy-example-project.json', { [source.path]: painting }) : tempDir());
  roots.push(root);
  // Start from a complete generated producer schema, retaining its real part PNGs.
  // This synthetic variant has no inline key so it can exercise sidecar selection.
  const manifest = JSON.parse(Buffer.from(producer['parts.json']!).toString('utf8')) as JsonObject;
  delete manifest.painting_in_rig;
  put(root, `${input}/parts.json`, JSON.stringify(manifest));
  for (const [path, bytes] of Object.entries(producer)) if (path.startsWith('parts/')) put(root, `${input}/${path}`, Buffer.from(bytes));
  put(root, `${input}/parts/synthetic.png`, 'synthetic part bytes');
  put(root, `${input}/recomposite_rig.png`, 'synthetic stack bytes');
  put(root, 'derived/drafts/sample/config.json', '{}');
  for (const file of ['rig.json', 'motion.json', 'mesh_report.json']) put(root, `derived/drafts/sample/out/${file}`, '{}');
  if (full) {
    draftRigCommand(['sample', root, '--config', 'derived/drafts/sample/config.json', '--from', 'derived/drafts/sample/out', '--parts', input]);
  } else {
    put(root, source.path, painting);
    const seal = (path: string): JsonObject => ({ path, sha256: jobHash(readFileSync(join(root, path))) });
    save(root, { schema: 'rig-create/project@0', stage: 'parts', inputs: [seal('inputs/painting.png')],
      drafts: [{ id: 'sample', kind: 'draft-rig', at: new Date(TEST_NOW).toISOString(), producer: { name: '@rig-c/parts', version: '0.0.0-synthetic' },
        config: seal('derived/drafts/sample/config.json'), parts: { path: input, files: [seal(`${input}/parts.json`), seal(`${input}/parts/synthetic.png`)] },
        files: ['rig.json', 'motion.json', 'mesh_report.json'].map(file => seal(`derived/drafts/sample/out/${file}`)) }] });
  }
  put(root, imagePath, realReference ? painting : 'producer-sealed bytes; PNG decoding belongs to Review');
  sidecar(root);
  // Fixture completeness: every selected publication input exists before a test
  // mutates it, including the original source and the official producer images.
  const project = read(root);
  const draft = (project.drafts as JsonObject[]).find(value => value.id === 'sample')!;
  const bindings = [...project.inputs as JsonObject[], draft.config as JsonObject,
    ...(draft.parts as JsonObject).files as JsonObject[], ...draft.files as JsonObject[]];
  for (const binding of bindings) {
    const path = join(root, String(binding.path));
    if (realpathSync(path) !== path || !fs.lstatSync(path).isFile() || jobHash(readFileSync(path)) !== binding.sha256) throw Error(`incomplete synthetic publication input ${String(binding.path)}`);
  }
  const context = draftPublishedContext(root, project, 'sample');
  for (const file of context.files) if (jobHash(readFileSync(join(root, file.path))) !== file.sha256) throw Error(`incomplete synthetic publication closure ${file.path}`);
  return root;
}

function sidecar(root: string, edit: (value: JsonObject) => void = () => {}): void {
  const manifest = JSON.parse(readFileSync(join(root, input, 'parts.json'), 'utf8')) as JsonObject;
  const value: JsonObject = { schema: 'rig-parts-painting-reference/1', manifest_sha256: jobHash(readFileSync(join(root, input, 'parts.json'))),
    path: 'painting_in_rig.png', sha256: jobHash(readFileSync(join(root, imagePath))), resample: 'lanczos3-rgb-opaque', rig_size: manifest.rig_size ?? null };
  edit(value);
  put(root, sidecarPath, JSON.stringify(value));
}

function expectRefusal(root: string, action: () => unknown, code: string): void {
  const before = readFileSync(join(root, 'project.json'));
  expect(action).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(existsSync(join(root, '.parts-reference.lock'))).toBe(false);
}

test('normal CLI registers producer bytes with unchanged old records, warnings, draft revision and exact retry file identity', () => {
  const root = workspace(true);
  const before = read(root);
  const report = checkProject(root);
  expect(report.refusals).toEqual([]);
  expect(main(['parts-reference', ...args(root)])).toBe(0);
  const project = read(root);
  const references = readPartsReferences(root, project);
  expect(project.parts_references).toEqual([{ draft_id: 'sample', path: sidecarPath, sha256: jobHash(readFileSync(join(root, sidecarPath))) }]);
  const without = structuredClone(project); delete without.parts_references;
  expect(without).toEqual(before);
  expect(checkProject(root).refusals).toEqual([]);
  expect(checkProject(root).warnings).toEqual(report.warnings);
  const selected = { path: 'review-draft-sample.json', selector: { kind: 'draft' as const, id: 'sample' } };
  expect(publicationVersionHash(Buffer.from(JSON.stringify(before)), selected)).toBe(publicationVersionHash(readFileSync(join(root, 'project.json')), selected));
  const bytes = readFileSync(join(root, 'project.json'));
  const stat = statSync(join(root, 'project.json'));
  expect(partsReferenceCommand(args(root)).exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
  expect(statSync(join(root, 'project.json'))).toMatchObject({ ino: stat.ino, mtimeMs: stat.mtimeMs });
  expect(references[0]!.files).toHaveLength(2);
});

test('normal publication carries exactly JSON and declared PNG without changing canonical manifest or official images', async () => {
  const root = workspace(true);
  const before = read(root);
  const context = draftPublishedContext(root, before, 'sample');
  const result = { path: prepareDraftManifest(root, before, 'sample'), selector: { kind: 'draft' as const, id: 'sample' } };
  const manifest = readFileSync(join(root, result.path));
  put(root, `${input}/foreign.png`, 'unregistered bytes');
  partsReferenceCommand(args(root));
  const after = draftPublishedContext(root, read(root), 'sample');
  expect(after.parts).toEqual(context.parts);
  const additions = after.files.filter(file => !context.files.some(old => old.path === file.path));
  expect(additions).toEqual(readPartsReferences(root, read(root))[0]!.files);
  expect(after.files.some(file => file.path.endsWith('/foreign.png'))).toBe(false);
  expect(prepareDraftManifest(root, read(root), 'sample')).toBe(result.path);
  expect(readFileSync(join(root, result.path))).toEqual(manifest);
  const published = await readPublished({ root, record: { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) }, result });
  for (const file of additions) expect(published.files).toContainEqual(file);
  // A retained root consisting of exactly the generic closure can read the same reference.
  const retained = realpathSync(tempDir()); roots.push(retained);
  put(retained, 'project.json', readFileSync(join(root, 'project.json')));
  for (const file of published.files) put(retained, file.path, readFileSync(join(root, file.path)));
  expect(readPartsReferences(retained, read(retained))).toEqual(readPartsReferences(root, read(root)));
  expect(draftPublishedContext(retained, read(retained), 'sample')).toEqual(after);
});

test('real generated synthetic PNG reaches the normal reference writer and generic closure without claiming Review visual acceptance', () => {
  const root = workspace(true, true);
  expect(main(['parts-reference', ...args(root)])).toBe(0);
  const png = readFileSync(join(import.meta.dir, '../templates/example-draft/input/painting_in_rig.png'));
  expect(readFileSync(join(root, imagePath))).toEqual(png);
  expect(readFileSync(join(root, 'inputs/painting.png'))).toEqual(png);
  const context = draftPublishedContext(root, read(root), 'sample');
  expect(context.files).toContainEqual({ path: imagePath, sha256: jobHash(png) });
  expect(readPartsReferences(root, read(root))[0]!.files).toEqual([
    { path: sidecarPath, sha256: jobHash(readFileSync(join(root, sidecarPath))) }, { path: imagePath, sha256: jobHash(png) },
  ]);
});

test('P1 selected publication re-reads its exact closure without opening another registered draft', async () => {
  const root = workspace(true, true);
  const result = { path: prepareDraftManifest(root, read(root), 'sample'), selector: { kind: 'draft' as const, id: 'sample' } };
  const canonical = readFileSync(join(root, result.path));
  const versionHash = publicationVersionHash(readFileSync(join(root, 'project.json')), result);
  const other = 'derived/drafts/second';
  cpSync(join(root, 'derived/drafts/sample'), join(root, other), { recursive: true });
  draftRigCommand(['second', root, '--config', `${other}/config.json`, '--from', `${other}/out`, '--parts', `${other}/input`]);
  expect(partsReferenceCommand(args(root)).exit).toBe(0);
  expect(partsReferenceCommand(['second', root, '--file', `${other}/input/painting_in_rig.json`]).exit).toBe(0);
  const project = read(root);
  expect(project.parts_references).toHaveLength(2);
  expect(checkProject(root).refusals).toEqual([]);
  expect(prepareDraftManifest(root, project, 'sample')).toBe(result.path);
  expect(readFileSync(join(root, result.path))).toEqual(canonical);
  const recordBytes = readFileSync(join(root, 'project.json'));
  expect(publicationVersionHash(recordBytes, result)).toBe(versionHash);
  const record = { path: 'project.json' as const, sha256: jobHash(recordBytes) };
  const published = await readPublished({ root, record, result });
  expect(published.files.some(file => file.path.startsWith(`${other}/`))).toBe(false);
  const retained = realpathSync(tempDir()); roots.push(retained);
  put(retained, 'project.json', recordBytes);
  for (const file of published.files) put(retained, file.path, readFileSync(join(root, file.path)));
  expect(existsSync(join(retained, other, 'input/parts.json'))).toBe(false);
  expect(await readPublished({ root: retained, record, result })).toEqual(published);
  expect(publicationVersionHash(readFileSync(join(retained, 'project.json')), result)).toBe(versionHash);
  expect(readFileSync(join(retained, result.path))).toEqual(canonical);
  // Full-project check/writer validation must still load the missing second registration.
  const errors: Finding[] = []; checkPartsReferences(retained, read(retained), errors);
  expect(errors.map(finding => finding.code)).toContain('PARTS_REFERENCE_PATH');
  expect(errors[0]!.message).toContain(`${other}/input/parts.json`);
  expect(checkProject(retained).refusals.map(finding => finding.code)).toContain('PARTS_REFERENCE_PATH');
  expectRefusal(retained, () => partsReferenceCommand(args(retained)), 'PARTS_REFERENCE_PATH');
  const malformed = read(retained);
  (malformed.parts_references as JsonObject[])[0]!.extra = true;
  expect(() => draftPublishedContext(retained, malformed, 'sample')).toThrow(expect.objectContaining({ code: 'PARTS_REFERENCE_INVALID' }));
  put(retained, imagePath, 'selected PNG seal drift');
  expect(() => draftPublishedContext(retained, read(retained), 'sample')).toThrow(expect.objectContaining({ code: 'PARTS_REFERENCE_HASH' }));
});

test('absence keeps old behavior even with a malformed unregistered sidecar, and recorded check reads include both generic seals', () => {
  const root = workspace(true);
  put(root, sidecarPath, 'broken unregistered JSON');
  expect(readPartsReferences(root, read(root))).toEqual([]);
  expect(checkProject(root).refusals).toEqual([]);
  expect(draftPublishedContext(root, read(root), 'sample').files.some(file => file.path === sidecarPath)).toBe(false);
  sidecar(root); partsReferenceCommand(args(root));
  const report = rawCheckProject(root, undefined, { now: TEST_NOW, readOnly: true, recordReads: true });
  expect(report.refusals).toEqual([]);
  for (const seal of readPartsReferences(root, read(root))[0]!.files) expect(report.reads).toContainEqual(seal);
});

const inlineCases: Json[] = [null, {}, [], 'broken', { path: 'inline.png' }];
test.each(inlineCases.map(inline => ({ inline })))('inline own-key presence %j never falls back, even with a valid sidecar', ({ inline }) => {
  const root = workspace();
  const manifest = JSON.parse(readFileSync(join(root, input, 'parts.json'), 'utf8')) as JsonObject;
  manifest.painting_in_rig = inline;
  put(root, `${input}/parts.json`, JSON.stringify(manifest));
  const project = read(root);
  const draft = (project.drafts as JsonObject[])[0]!;
  ((draft.parts as JsonObject).files as JsonObject[])[0]!.sha256 = jobHash(readFileSync(join(root, input, 'parts.json')));
  save(root, project); sidecar(root);
  expectRefusal(root, () => partsReferenceCommand(args(root)), 'PARTS_REFERENCE_INLINE_PRESENT');
});

const malformedFieldCases: Json[] = [null, {}, 'bad', [null], [{ draft_id: 'sample', path: sidecarPath, sha256: 'A'.repeat(64) }],
  [{ draft_id: 'sample', path: sidecarPath, sha256: '0'.repeat(64), extra: true }]];
test.each(malformedFieldCases.map(raw => ({ raw })))('malformed new field %j refuses through shared check before write', ({ raw }) => {
  const root = workspace(); const project = read(root); project.parts_references = raw;
  save(root, project);
  const errors: Finding[] = []; checkPartsReferences(root, project, errors);
  expect(errors.map(f => f.code)).toContain('PARTS_REFERENCE_INVALID');
  expectRefusal(root, () => partsReferenceCommand(args(root)), 'PARTS_REFERENCE_INVALID');
});

const sidecarCases: [string, (value: JsonObject) => void, string][] = [
  ['extra key', value => { value.extra = 1; }, 'PARTS_REFERENCE_INVALID'],
  ['missing key', value => { delete value.resample; }, 'PARTS_REFERENCE_INVALID'],
  ['schema', value => { value.schema = 'other/1'; }, 'PARTS_REFERENCE_INVALID'],
  ['resampler', value => { value.resample = 'nearest'; }, 'PARTS_REFERENCE_INVALID'],
  ['upper hash', value => { value.sha256 = 'A'.repeat(64); }, 'PARTS_REFERENCE_INVALID'],
  ['manifest hash', value => { value.manifest_sha256 = '0'.repeat(64); }, 'PARTS_REFERENCE_BINDING'],
  ['rig mismatch', value => { value.rig_size = [768, 512]; }, 'PARTS_REFERENCE_BINDING'],
  ['rig zero', value => { value.rig_size = [0, 768]; }, 'PARTS_REFERENCE_INVALID'],
  ['rig fraction', value => { value.rig_size = [1.5, 768]; }, 'PARTS_REFERENCE_INVALID'],
  ['rig unsafe', value => { value.rig_size = [Number.MAX_SAFE_INTEGER + 1, 768]; }, 'PARTS_REFERENCE_INVALID'],
  ['rig triple', value => { value.rig_size = [512, 768, 1]; }, 'PARTS_REFERENCE_INVALID'],
  ['PNG hash', value => { value.sha256 = '0'.repeat(64); }, 'PARTS_REFERENCE_HASH'],
];
test.each(sidecarCases)('sidecar %s refuses byte-identically', (_name, edit, code) => {
  const root = workspace(); sidecar(root, edit);
  expectRefusal(root, () => partsReferenceCommand(args(root)), code);
});

test.each(['../outside.png', './image.png', '/image.png', 'a//image.png', 'a/../image.png', 'a\\image.png', 'a%2fimage.png', 'a:image.png', 'a?x.png', 'a#x.png', 'a\u0000.png'])('portable containment refuses %j', path => {
  const root = workspace(); sidecar(root, value => { value.path = path; });
  expectRefusal(root, () => partsReferenceCommand(args(root)), 'PARTS_REFERENCE_PATH');
});

test.each(['manifest', 'sidecar', 'image', 'directory'])('missing/symlinked %s is refused without record changes', target => {
  const root = workspace();
  const path = target === 'manifest' ? `${input}/parts.json` : target === 'sidecar' ? sidecarPath : target === 'image' ? imagePath : `${input}/parts`;
  const destination = join(root, 'saved-target');
  fs.renameSync(join(root, path), destination);
  symlinkSync(destination, join(root, path));
  if (target === 'directory') {
    // The sidecar itself is below this symlinked directory, too.
    sidecar(root, value => { value.path = 'parts/synthetic.png'; value.sha256 = jobHash(readFileSync(join(root, path, 'synthetic.png'))); });
  }
  expectRefusal(root, () => partsReferenceCommand(args(root)), 'PARTS_REFERENCE_PATH');
});

test('nested portable reference is carried, while a sidecar from another directory is refused', () => {
  const root = workspace();
  put(root, `${input}/reference/reference.png`, 'nested producer bytes');
  sidecar(root, value => { value.path = 'reference/reference.png'; value.sha256 = jobHash(readFileSync(join(root, input, 'reference/reference.png'))); });
  put(root, 'other/painting_in_rig.json', readFileSync(join(root, sidecarPath)));
  expectRefusal(root, () => partsReferenceCommand(['sample', root, '--file', 'other/painting_in_rig.json']), 'PARTS_REFERENCE_PATH');
  partsReferenceCommand(args(root));
  expect(readPartsReferences(root, read(root))[0]!.files[1]!.path).toBe(`${input}/reference/reference.png`);
});

test.each(['missing', 'duplicate', 'unbound'])('draft identity %s refuses', kind => {
  const root = workspace(); const project = read(root);
  if (kind === 'missing') project.drafts = [];
  if (kind === 'duplicate') (project.drafts as Json[]).push(structuredClone((project.drafts as Json[])[0]!));
  if (kind === 'unbound') ((project.drafts as JsonObject[])[0]!.parts as JsonObject).files = [];
  save(root, project);
  expectRefusal(root, () => partsReferenceCommand(args(root)), 'PARTS_REFERENCE_DRAFT');
});

test('changed selected bytes and duplicate bindings refuse in check and publication; conflicting retry is immutable', () => {
  const root = workspace(); partsReferenceCommand(args(root));
  const project = read(root);
  put(root, 'other.json', 'different declaration');
  expectRefusal(root, () => partsReferenceCommand(['sample', root, '--file', 'other.json']), 'PARTS_REFERENCE_CONFLICT');
  project.parts_references = [...project.parts_references as Json[], ...(project.parts_references as Json[])];
  const errors: Finding[] = []; checkPartsReferences(root, project, errors);
  expect(errors[0]!.code).toBe('PARTS_REFERENCE_CONFLICT');
  put(root, imagePath, 'drifted bytes');
  expect(() => draftPublishedContext(root, read(root), 'sample')).toThrow(expect.objectContaining({ code: 'PARTS_REFERENCE_HASH' }));
  expectRefusal(root, () => partsReferenceCommand(args(root)), 'PARTS_REFERENCE_HASH');
});

test.each(['source', 'record', 'write'])('a %s change/failure during staging refuses before rename and preserves the current record', kind => {
  const root = workspace(); const originalWrite = fs.writeFileSync;
  const before = readFileSync(join(root, 'project.json'));
  const concurrent = Buffer.concat([before, Buffer.from(' ')]);
  const staging = spyOn(fs, 'writeFileSync').mockImplementation((...values: Parameters<typeof fs.writeFileSync>) => {
    if (typeof values[0] === 'number' && kind === 'write') throw Error('synthetic storage failure');
    originalWrite(...values);
    if (typeof values[0] === 'number' && kind === 'source') originalWrite(join(root, imagePath), 'concurrent producer replacement');
    if (typeof values[0] === 'number' && kind === 'record') originalWrite(join(root, 'project.json'), concurrent);
  });
  try {
    expect(() => partsReferenceCommand(args(root))).toThrow(expect.objectContaining({ code: kind === 'source' ? 'PARTS_REFERENCE_HASH' : kind === 'record' ? 'PARTS_REFERENCE_WRITE_CONFLICT' : 'PARTS_REFERENCE_WRITE_FAILED' }));
    expect(readFileSync(join(root, 'project.json'))).toEqual(kind === 'record' ? concurrent : before);
    expect(existsSync(join(root, '.parts-reference.lock'))).toBe(false);
    expect(fs.readdirSync(root).filter(name => name.startsWith('.parts-reference-'))).toEqual([]);
  } finally { staging.mockRestore(); }
});

test('writer contention refuses; concurrent exact retry converges to one immutable binding', async () => {
  const root = workspace();
  put(root, '.parts-reference.lock', 'synthetic active writer');
  const before = readFileSync(join(root, 'project.json'));
  expect(() => partsReferenceCommand(args(root))).toThrow(expect.objectContaining({ code: 'PARTS_REFERENCE_WRITE_CONFLICT' }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(readFileSync(join(root, '.parts-reference.lock'), 'utf8')).toBe('synthetic active writer');
  rmSync(join(root, '.parts-reference.lock'));
  const script = `import { partsReferenceCommand } from ${JSON.stringify(join(import.meta.dir, '../src/parts-reference-record.ts'))}; partsReferenceCommand(${JSON.stringify(args(root))});`;
  const children = [0, 1].map(() => Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }));
  const results = await Promise.all(children.map(async child => ({ exit: await child.exited, stderr: await new Response(child.stderr).text() })));
  expect(results.some(row => row.exit === 0)).toBe(true);
  for (const row of results.filter(row => row.exit !== 0)) expect(row.stderr).toContain('PARTS_REFERENCE_WRITE_CONFLICT');
  expect(partsReferenceCommand(args(root)).exit).toBe(0);
  expect(read(root).parts_references).toHaveLength(1);
});

test('bound freeze participates without creating an outbox or publishing, and project mode survives', () => {
  const root = workspace();
  writePrivateJson(join(root, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity: {}, jobId: 'synthetic-job', origin: 'http://127.0.0.1:49999', fetchCapability: 'f'.repeat(64) }, true);
  const release = acquireJobLock(root)!;
  try { expectRefusal(root, () => partsReferenceCommand(args(root)), 'JOB_WRITE_BUSY'); }
  finally { release(); }
  chmodSync(join(root, 'project.json'), 0o600);
  expect(partsReferenceCommand(args(root)).exit).toBe(0);
  expect(statSync(join(root, 'project.json')).mode & 0o777).toBe(0o600);
  expect(existsSync(join(root, '.rig-create-review/outbox'))).toBe(false);
});

const usageCases: string[][] = [[], ['sample'], ['sample', '--file'], ['sample', '--file', 'x', '--file', 'y'], ['sample', '--file', 'x', '--json', '--json']];
test.each(usageCases.map(values => ({ values })))('normal writer usage %j has its own code', ({ values }) => {
  expect(() => partsReferenceCommand(values)).toThrow(expect.objectContaining({ code: 'PARTS_REFERENCE_USAGE', exitCode: 2 }));
});
