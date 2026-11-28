import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { checkDrafts, DRAFT_STACK_BINDING_SINCE, draftInputUnavailable, draftVersionFindings } from '../src/drafts.ts';
import { configInputReferences, DRAFT_CONFIG_INPUTS_SINCE, plateReceiptSpec } from '../src/config-inputs.ts';
import { Refusal } from '../src/refusal.ts';
import { fixture, arr, obj } from './fixtures.ts';
import type { Finding } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, handoff, testClock } from './clock.ts';
import { retainedPartsFiles } from './draft-fixture.ts';
import { locateParts } from '../src/parts-sections.ts';
import { restartCommand } from '../src/restart.ts';
import { gitEnv, ownerChatArgs, run } from './helpers.ts';
import { seedRetainedDraft } from './numbered-seed.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';

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
function rejected(fn: () => unknown, code: string): Refusal {
  try { fn(); } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code} refusal`);
}

test.each([false, true])('retained draft binds standalone/build=%s without creating a version', build => {
  const { dir, args } = draft(build); const before = read(dir);
  const r = seedRetainedDraft(args); expect(r.exit).toBe(0);
  const record = JSON.parse(r.stdout) as JsonObject;
  expect(record.config_inputs).toBeUndefined();
  expect(record.kind).toBe('draft-rig'); expect(record.handoff).toBeUndefined();
  expect(arr(obj(record.parts).files)).toHaveLength(2);
  const stack = `derived/drafts/sample/${build ? 'out' : 'inputs'}/recomposite_rig.png`;
  expect(arr(record.files).filter(file => obj(file).path === stack)).toEqual([
    { path: stack, sha256: createHash('sha256').update(readFileSync(join(dir, stack))).digest('hex') },
  ]);
  expect(read(dir).versions).toEqual(before.versions);
  expect(read(dir).signoffs).toEqual(before.signoffs);
  expect(checkProject(dir).refusals).toEqual([]);
  const errors: Finding[] = []; checkDrafts(dir, read(dir), errors); expect(errors).toEqual([]);
});

test('duplicate draft ids and malformed draft shapes refuse in checkDrafts', () => {
  const { dir, args } = draft();
  seedRetainedDraft(args);
  const dup = read(dir);
  dup.drafts = [...arr(dup.drafts), structuredClone(arr(dup.drafts)[0]!)];
  const errors: Finding[] = [];
  checkDrafts(dir, dup, errors);
  expect(errors.map(f => f.code)).toContain('DRAFT_RIG_MALFORMED');
});

test('changed draft parts/file and an escaping symlink are named refusals in check', () => {
  const { dir, args } = draft(); seedRetainedDraft(args);
  write(dir, 'derived/drafts/sample/inputs/parts/synthetic.png', 'changed');
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
  const other = draft(); seedRetainedDraft(other.args);
  const p = read(other.dir);
  symlinkSync(join(dir, 'derived/drafts/sample/out/rig.json'), join(other.dir, 'derived/drafts/sample/out/escape.json'));
  arr(obj(arr(p.drafts)[0]).files).push({ path: 'derived/drafts/sample/out/escape.json', sha256: '0'.repeat(64) });
  const errors: Finding[] = [];
  checkDrafts(other.dir, p, errors);
  expect(errors.map(f => f.code)).toContain('DRAFT_RIG_FILE');
});

test('draft role, reserved declared path and symlink identity cannot become a handoff version', () => {
  const { dir, args } = draft(); seedRetainedDraft(args); const p = read(dir);
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
  const { dir, args } = draft(); seedRetainedDraft(args);
  rmSync(join(dir, 'derived/drafts/sample/config.json'));
  write(dir, 'derived/drafts/sample/out/rig.json', '{"changed":true}');
  const report = checkProject(dir);
  expect(report.refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
  expect(report.warnings.map(f => f.code)).toContain('DRAFT_RIG_UNAVAILABLE');
});

test.each([false, true])('a declared painting_in_rig is bound with the parts, build=%s', build => {
  const { dir, args } = draft(build); const parts = `derived/drafts/sample/${build ? 'out' : 'inputs'}`;
  write(dir, `${parts}/parts.json`, JSON.stringify({ painting_in_rig: { path: 'painting_in_rig.png', sha256: 'a'.repeat(64), resample: 'lanczos3-rgb-opaque' } }));
  write(dir, `${parts}/painting_in_rig.png`, 'synthetic painting bytes');
  write(dir, `${parts}/undeclared.png`, 'not declared by parts.json');
  const record = JSON.parse(seedRetainedDraft(args).stdout) as JsonObject;
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
  const record = JSON.parse(seedRetainedDraft(args).stdout) as JsonObject;
  expect(arr(obj(record.parts).files).map(f => obj(f).path).sort()).toEqual(['derived/drafts/sample/inputs/parts.json', 'derived/drafts/sample/inputs/parts/synthetic.png']);
  expect(checkProject(dir).refusals).toEqual([]);
});

test('a draft recorded before the painting was carried warns by name and is not refused', () => {
  const { dir, args } = draft();
  write(dir, 'derived/drafts/sample/inputs/parts.json', JSON.stringify({ painting_in_rig: { path: 'painting_in_rig.png' } }));
  write(dir, 'derived/drafts/sample/inputs/painting_in_rig.png', 'synthetic painting bytes');
  seedRetainedDraft(args);
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

function reviewedOutputCopy(): { dir: string; root: string; source: JsonObject; args: string[] } {
  const dir = fixture(project => { project.fix_ledger = []; }, 'example-numbered/example-project.json');
  const source = obj(arr(read(dir).drafts).find(d => obj(d).id === 'example'));
  const sourceRoot = 'derived/drafts/example';
  const root = 'derived/drafts/reused';
  cpSync(join(dir, sourceRoot), join(dir, root), { recursive: true });
  for (const file of ['input/recomposite_rig.png', 'render', 'out/run.json']) {
    rmSync(join(dir, root, file), { recursive: true, force: true });
  }
  const args = ['reused', dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/input`, '--json'];
  return { dir, root, source, args };
}

function restartForDraftReuse(dir: string): string {
  const env = gitEnv({ name: 'Synthetic Owner', email: 'owner@example.invalid' });
  for (const args of [['init', '-q'], ['add', '--', 'project.json'], ['commit', '-qm', 'Reviewed record']]) {
    expect(run(['git', ...args], dir, env)).toMatchObject({ code: 0 });
  }
  const digest = createHash('sha256').update(readFileSync(join(dir, 'project.json'))).digest('hex');
  write(dir, 'restart-reason.txt', 'Start a fresh synthetic record.');
  expect(restartCommand([dir, '--by', 'owner', ...ownerChatArgs(join(dir, 'restart-reason.txt'))], testClock.now()).exit).toBe(0);
  expect(read(dir).drafts).toBeUndefined();
  return digest;
}

test('checkDraftReuse validates retained parts reuse, DRAFT_REUSE_MISMATCH, DRAFT_REUSE_SOURCE, and DRAFT_REUSE_PRODUCER', () => {
  const { dir, root, source, args } = reviewedOutputCopy();
  const digest = restartForDraftReuse(dir);
  const baseline = checkProject(dir);
  const result = seedRetainedDraft([...args, '--reuse', 'example', '--reuse-record', digest]);
  expect(result.exit).toBe(0);
  const record = JSON.parse(result.stdout) as JsonObject;
  expect(record.producer).toEqual(source.producer!);
  expect(arr(obj(record.parts).files)).toEqual(arr(obj(source.parts).files).map(ref => ({
    ...obj(ref), path: String(obj(ref).path).replace('derived/drafts/example', root),
  })));
  expect(obj(record.reuse)).toMatchObject({
    draft_id: 'example',
    previous_record: { sha256: digest },
    seethrough: [
      { part: 'torso', from: 'full:topwear' },
      { part: 'face', from: 'full:face' },
      { part: 'eye_r', from: 'full:eyewhite-r' },
      { part: 'eye_l', from: 'full:eyewhite-l' },
    ],
  });
  expect(arr(record.files).map(file => obj(file).path)).not.toContain(`${root}/out/run.json`);
  expect(read(dir).review_acts).toBeUndefined();
  expect(checkProject(dir).refusals).toEqual(baseline.refusals);
  const warnings: Finding[] = [];
  checkDrafts(dir, read(dir), [], warnings);
  expect(warnings.map(f => f.code)).not.toContain('DRAFT_PRODUCER_ASSUMED');

  const tamperedMismatch = read(dir);
  obj(obj(arr(tamperedMismatch.drafts)[0]).reuse).seethrough = [];
  expect(checkProject(dir, tamperedMismatch).refusals.map(f => f.code)).toContain('DRAFT_REUSE_MISMATCH');

  const tamperedSource = read(dir);
  obj(obj(arr(tamperedSource.drafts)[0]).reuse).draft_id = 'lantern';
  expect(checkProject(dir, tamperedSource).refusals.map(f => f.code)).toContain('DRAFT_REUSE_SOURCE');

  const tamperedProducer = read(dir);
  obj(arr(tamperedProducer.drafts)[0]).producer = { name: '@rig-c/parts', version: '0.0.0-mismatch' };
  expect(checkProject(dir, tamperedProducer).refusals.map(f => f.code)).toContain('DRAFT_REUSE_PRODUCER');
});

test.each([false, true])('the producer is read from the rig output run.json, not the installed package, build=%s', build => {
  const { dir, args } = draft(build);
  expect(installedParts(dir)).not.toBe('0.0.1-synthetic');
  write(dir, stampAt(build), runStamp('0.0.1-synthetic'));
  const record = JSON.parse(seedRetainedDraft(args).stdout) as JsonObject;
  expect(record.producer).toEqual({ name: '@rig-c/parts', version: '0.0.1-synthetic' });
  expect(arr(record.files).map(f => obj(f).path)).toContain(stampAt(build));
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(f => f.code).filter(c => c.startsWith('DRAFT_PRODUCER_'))).toEqual([]);
});

test.each([false, true])('a draft without run.json records the installed package and warns DRAFT_PRODUCER_ASSUMED, build=%s', build => {
  const { dir, args } = draft(build);
  const record = JSON.parse(seedRetainedDraft(args).stdout) as JsonObject;
  expect(record.producer).toEqual({ name: '@rig-c/parts', version: installedParts(dir) });
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.filter(f => f.code === 'DRAFT_PRODUCER_ASSUMED').map(f => f.path)).toEqual(['drafts[0].producer']);
});

test('a recorded producer that disagrees with its bound run.json warns DRAFT_PRODUCER_MISMATCH and is kept', () => {
  const { dir, args } = draft(); write(dir, stampAt(false), runStamp('0.0.1-synthetic'));
  seedRetainedDraft(args);
  const p = read(dir); obj(arr(p.drafts)[0]).producer = { name: '@rig-c/parts', version: '0.0.0-installed' };
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.filter(f => f.code === 'DRAFT_PRODUCER_MISMATCH').map(f => f.path)).toEqual(['drafts[0].producer']);
  expect(report.warnings.map(f => f.code)).not.toContain('DRAFT_PRODUCER_ASSUMED');
});

test('existing build records remain accepted when recomposite_rig.png is absent on disk', () => {
  const { dir, args } = draft(true);
  seedRetainedDraft(args);
  rmSync(join(dir, 'derived/drafts/sample/out/recomposite_rig.png'));
  expect(checkProject(dir).refusals).toEqual([]);
});

test('standalone assemble stack beside rig binds and checks clean, and changed stack bytes refuse DRAFT_RIG_FILE', () => {
  const { dir, args } = draft();
  const root = 'derived/drafts/sample';
  const parts = `${root}/rig`;
  write(dir, `${parts}/parts.json`);
  write(dir, `${parts}/parts/piece.png`, 'synthetic part bytes');
  const stack = `${root}/render/recomposite_rig.png`;
  write(dir, stack, 'synthetic stack bytes');
  args[args.indexOf('--parts') + 1] = parts;
  const record = JSON.parse(seedRetainedDraft(args).stdout) as JsonObject;
  expect(obj(record.parts).path).toBe(parts);
  expect(arr(record.files).filter(file => obj(file).path === stack)).toEqual([
    { path: stack, sha256: createHash('sha256').update(readFileSync(join(dir, stack))).digest('hex') },
  ]);
  write(dir, stack, 'changed stack bytes');
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('DRAFT_RIG_FILE');
});

test('standalone drafts without a stack binding warn before the cutoff and refuse from it', () => {
  const { dir, args } = draft();
  seedRetainedDraft(args);
  const project = read(dir);
  const record = obj(arr(project.drafts)[0]);
  record.files = arr(record.files).filter(file => obj(file).path !== 'derived/drafts/sample/inputs/recomposite_rig.png');
  const stackFinding = { code: 'DRAFT_RIG_STACK_UNBOUND', path: 'drafts[0].files' };
  record.at = new Date(Date.parse(DRAFT_STACK_BINDING_SINCE) - 1).toISOString();
  const legacy = checkProject(dir, project);
  expect(legacy.refusals).toEqual([]);
  expect(legacy.warnings).toContainEqual(expect.objectContaining(stackFinding));
  record.at = DRAFT_STACK_BINDING_SINCE;
  const current = checkProject(dir, project);
  expect(current.refusals).toEqual([expect.objectContaining(stackFinding)]);
  expect(current.warnings).not.toContainEqual(expect.objectContaining(stackFinding));
});

test.each([false, true])('standalone draft reuse keeps the stack optional, present=%s', present => {
  const { dir, args } = draft();
  const source = 'derived/drafts/sample';
  const target = 'derived/drafts/reused';
  write(dir, `${source}/inputs/parts.json`, JSON.stringify({ parts: [{ name: 'synthetic', from: 'painting:synthetic' }] }));
  seedRetainedDraft(args);
  recordPartsReceipt(dir, 'sample', testClock.now());
  cpSync(join(dir, source), join(dir, target), { recursive: true });
  const stack = `${target}/inputs/recomposite_rig.png`;
  if (!present) rmSync(join(dir, stack));
  const result = seedRetainedDraft(['reused', dir, '--config', `${target}/config.json`, '--from', `${target}/out`, '--parts', `${target}/inputs`, '--reuse', 'sample', '--json']);
  expect(result.exit).toBe(0);
  const record = JSON.parse(result.stdout) as JsonObject;
  const stacks = arr(record.files).filter(file => obj(file).path === stack);
  const expected = present ? [{ path: stack, sha256: createHash('sha256').update(readFileSync(join(dir, stack))).digest('hex') }] : [];
  expect(stacks).toEqual(expected);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(f => f.code)).not.toContain('DRAFT_RIG_STACK_UNBOUND');
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
  const record = JSON.parse(seedRetainedDraft(args).stdout) as JsonObject;
  const bytes = readFileSync(join(dir, 'inputs/foreground.png'));
  expect(record.config_inputs).toEqual([{ path: 'inputs/foreground.png', sha256: createHash('sha256').update(bytes).digest('hex') }]);
  expect(arr(read(dir).drafts).at(-1)).toEqual(record);
  expect(checkProject(dir).refusals).toEqual([]);
  const errors: Finding[] = []; const warnings: Finding[] = []; checkDrafts(dir, read(dir), errors, warnings);
  expect(errors).toEqual([]); expect(warnings.map(f => f.code)).toEqual(['DRAFT_PRODUCER_ASSUMED']);
  expect(draftInputUnavailable(dir, 'inputs/foreground.png', 'derived/drafts/sample')).toBe(false);
});

test('a config-named link binds its target and a missing target refuses DRAFT_RIG_FILE', () => {
  const link = 'inputs/linked.png';
  const open = occluderDraft(`../../../${link}`);
  const projectFile = join(open.dir, 'project.json');
  symlinkSync('foreground.png', join(open.dir, link));
  const result = seedRetainedDraft(open.args);
  expect(result.exit).toBe(0);
  expect((JSON.parse(result.stdout) as JsonObject).config_inputs).toEqual([{
    path: 'inputs/foreground.png',
    sha256: createHash('sha256').update(readFileSync(join(open.dir, link))).digest('hex'),
  }]);
  expect(checkProject(open.dir).refusals).toEqual([]);
  const recorded = readFileSync(projectFile);
  rmSync(join(open.dir, 'inputs/foreground.png'));
  const findings = checkProject(open.dir).refusals;
  expect(findings.some(f => f.code === 'DRAFT_RIG_FILE' && f.message.includes(link))).toBe(true);
  expect(readFileSync(projectFile)).toEqual(recorded);
});

test('a changed or missing project input refuses DRAFT_RIG_FILE', () => {
  const { dir, args } = occluderDraft(); seedRetainedDraft(args);
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

test('check refuses a hand-bound input that escapes the project', () => {
  const { dir, args } = occluderDraft(); seedRetainedDraft(args);
  const project = read(dir); const record = arr(project.drafts).at(-1) as JsonObject;
  record.config_inputs = [{ path: '../foreground.png', sha256: '0'.repeat(64) }];
  const errors: Finding[] = []; checkDrafts(dir, project, errors);
  expect(errors.map(f => f.code)).toEqual(['DRAFT_RIG_FILE', 'DRAFT_RIG_FILE']);
});

function writePlate(dir: string, at: string): string {
  write(dir, `${at}/plate.png`, 'synthetic plate pixels'); write(dir, `${at}/mask.png`, 'synthetic mask pixels');
  write(dir, `${at}/receipt.json`, JSON.stringify({ spec: plateReceiptSpec(dir), synthetic: 'occluder plate receipt', mode: 'occluder' }));
  return createHash('sha256').update(readFileSync(join(dir, `${at}/receipt.json`))).digest('hex');
}
function plateDraft(plate: string): { dir: string; args: string[]; config: JsonObject } {
  const { dir, args } = draft(); const config = { assemble: { occluders: [{ plate }] } };
  write(dir, 'derived/drafts/sample/config.json', JSON.stringify(config));
  return { dir, args, config };
}

for (const [route, plate, at] of [['project input', '../../../inputs/plate', 'inputs/plate'], ['draft-root input', 'plate', 'derived/drafts/sample/plate']] as const) {
  test(`an occluder plate directory as a ${route} binds its receipt and checks clean`, () => {
    const { dir, args, config } = plateDraft(plate); const sha256 = writePlate(dir, at);
    expect(configInputReferences(dir, config).map(ref => ref.at)).toEqual(['assemble.occluders[0].plate']);
    const record = JSON.parse(seedRetainedDraft(args).stdout) as JsonObject;
    expect(record.config_inputs).toEqual([{ path: `${at}/receipt.json`, sha256, directory: at, spec: plateReceiptSpec(dir) }]);
    expect(checkProject(dir).refusals).toEqual([]);
    const errors: Finding[] = []; const warnings: Finding[] = []; checkDrafts(dir, read(dir), errors, warnings);
    expect(errors).toEqual([]); expect(warnings.map(f => f.code)).toEqual(['DRAFT_PRODUCER_ASSUMED']);
    expect(draftInputUnavailable(dir, `${at}/receipt.json`, 'derived/drafts/sample')).toBe(false);
    write(dir, `${at}/plate.png`, 'regenerated plate pixels');
    const siblings: Finding[] = []; checkDrafts(dir, read(dir), siblings); expect(siblings).toEqual([]);
  });

  test(`a changed or deleted plate receipt as a ${route} refuses by code`, () => {
    const { dir, args } = plateDraft(plate); writePlate(dir, at); seedRetainedDraft(args);
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
      expect(missing).toEqual([]);
      expect(warnings.map(f => f.code)).toContain('DRAFT_RIG_UNAVAILABLE');
    }
  });
}

test('check refuses a plate binding that does not stand for the named directory', () => {
  const { dir, args } = plateDraft('../../../inputs/plate'); writePlate(dir, 'inputs/plate'); seedRetainedDraft(args);
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

function unrecordedDraft(at: string): { dir: string; args: string[]; project: JsonObject } {
  const { dir, args } = occluderDraft(); seedRetainedDraft(args);
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
    const hashed = occluderDraft(); seedRetainedDraft(hashed.args);
    const project = read(hashed.dir); const record = arr(project.drafts).at(-1) as JsonObject;
    record.at = at; (arr(record.config_inputs)[0] as JsonObject).sha256 = '0'.repeat(64);
    const refusals: Finding[] = []; const warnings: Finding[] = []; checkDrafts(hashed.dir, project, refusals, warnings);
    expect(refusals.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
    expect(warnings.map(f => f.code)).not.toContain('DRAFT_CONFIG_INPUTS_UNRECORDED');
    const { dir, args } = occluderDraft();
    write(dir, 'derived/drafts/sample/config.json', JSON.stringify({ assemble: { occluders: [{ image: '../../../inputs/foreground.png' }, { image: '../../../inputs/second.png' }] } }));
    write(dir, 'inputs/second.png', 'synthetic second matte');
    seedRetainedDraft(args);
    const partial = read(dir); const kept = arr(partial.drafts).at(-1) as JsonObject;
    kept.at = at; kept.config_inputs = arr(kept.config_inputs).slice(0, 1);
    const missing: Finding[] = []; const missingWarnings: Finding[] = []; checkDrafts(dir, partial, missing, missingWarnings);
    expect(missing.map(f => f.code)).toEqual(['DRAFT_RIG_FILE']);
    expect(missing[0]?.message).toContain('inputs/second.png');
    expect(missingWarnings.map(f => f.code)).not.toContain('DRAFT_CONFIG_INPUTS_UNRECORDED');
  }
});

test('a new draft beside a WARN-only unrecorded draft checks with 0 refusals', () => {
  const { dir } = unrecordedDraft(beforeSince);
  const root = 'derived/drafts/next';
  write(dir, `${root}/config.json`, JSON.stringify({ assemble: { occluders: [{ image: '../../../inputs/foreground.png' }] } }));
  write(dir, `${root}/inputs/recomposite_rig.png`, 'synthetic stack bytes');
  write(dir, `${root}/inputs/parts.json`); write(dir, `${root}/inputs/parts/synthetic.png`, 'synthetic part bytes');
  for (const file of ['rig.json', 'motion.json', 'mesh_report.json']) write(dir, `${root}/out/${file}`);
  const result = seedRetainedDraft(['next', dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/inputs`, '--json']);
  expect(result.exit).toBe(0);
  expect(arr((JSON.parse(result.stdout) as JsonObject).config_inputs).map(f => obj(f).path)).toEqual(['inputs/foreground.png']);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.filter(f => f.code === 'DRAFT_CONFIG_INPUTS_UNRECORDED').map(f => f.path)).toEqual(['drafts[0].config_inputs']);
});
