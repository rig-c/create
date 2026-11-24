import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { readPlatePainting, readSourceMask } from '@rig-c/parts/src/plate.ts';
import { TURN_OPTIONS, TURN_QUESTION } from '../src/waypoints.ts';
import { DEPTH_MAP_BINDING_SINCE, RIG_PARTS_APPROVAL_SINCE, depthPlanFindings, depthPlanMoves, registeredDepthPartsMatch, rigRegistrationFindings, turnExtraGroup, turnExtraGroupMoves } from '../src/rig-version.ts';
import { RIG_CHECK_REPORT_SINCE } from '../src/rig-check-report.ts';
import { checkProject as checkRecordProject } from '../src/check.ts';
import { checkProject, rigVersionCommand, testClock } from './clock.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import { plateReceiptSpec } from '../src/config-inputs.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, waypoint } from './fixtures.ts';
import { clockedCli, run } from './helpers.ts';
import { framedRigPin } from './comment-anchor-shapes.ts';
import { openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { acquireJobLock, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';
import { readRecordPublished } from '../src/job-publication.ts';

const roots: string[] = [];
const frozen = join(import.meta.dir, 'fixtures/rig-registration');
afterEach(() => { testClock.reset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function put(dir: string, path: string, value: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}
function setup(review = false) {
  const dir = fixture(project => { project.stage = review ? 'rig-review' : 'interview'; if (!review) project.signoffs = []; else project.signoffs = arr(project.signoffs).filter(s => !['rig-review', 'post-interview', 'direction-review'].includes(String(obj(s).stage))); project.versions = []; project.reopens = []; for (const step of obj(project.plan).steps as JsonObject[]) step.status = review && step.phase === 'rig' ? 'done' : 'pending'; });
  roots.push(dirname(dir));
  testClock.set(new Date('2026-11-08T00:00:00Z'));
  for (const path of ['outputs', 'derived/review']) rmSync(join(dir, path), { recursive: true, force: true });
  cpSync(frozen, join(dir, 'source'), { recursive: true });
  put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json' });
  put(dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: { required: true } });
  put(dir, 'source/adapter.json', []);
  const painting = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
  put(dir, 'source/parts/parts.json', { rig_size: [8, 16], scale_rig_per_source: 1, ghost_px: {},
    painting_in_rig: { path: 'painting_in_rig.png', sha256: jobHash(painting), resample: 'lanczos3-rgb-opaque' },
    parts: [{ name: 'rectangle', from: 'painting:rectangle', x: 0, y: 0, w: 8, h: 16,
      opaque_px: 128, projected_core_px: 128, source_px_taken: 128, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 }] });
  writeFileSync(join(dir, 'source/parts/painting_in_rig.png'), painting);
  mkdirSync(join(dir, 'source/parts/parts'), { recursive: true });
  cpSync(join(dir, 'source/rig/images/rectangle.png'), join(dir, 'source/parts/parts/rectangle.png'));
  put(dir, 'source/run.json', {
    spec: 'rigc-run/1',
    package: { name: 'rig-c', version: '3.4.1' },
    command: 'build',
    started_at: '2026-11-06T20:44:40.000Z',
    finished_at: '2026-11-06T20:44:41.000Z',
    inputs: [
      { role: 'rig', path: '../rig/rig.json', sha256: '1'.repeat(64) },
      { role: 'motion', path: '../rig/motion.json', sha256: '2'.repeat(64) },
    ],
    outputs: [
      { path: '../compile-report.json', sha256: '3'.repeat(64) },
      { path: 'skeleton.model.json', sha256: '4'.repeat(64) },
    ],
  });
  const args = ['1', dir, '--parts', 'source/parts', '--rig', 'source/rig', '--build', 'source/build', '--idle', 'source/idle',
    '--config', 'source/config.json', '--path-adapter', 'source/adapter.json', '--compile-report', 'source/compile-report.json',
    '--toolchain-lock', 'source/package-lock.json', '--run-record', 'source/run.json', '--at-source', 'source/at-source.json', '--at-pointer', '/finished_at', '--by', 'registrant', '--json'];
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  return { dir, args, load };
}

function setupPlateAssembly() {
  const f = setup();
  const draft = 'derived/drafts/plate-fixture';
  const assembly = `${draft}/assembly`;
  const painting = `${draft}/painting.png`;
  const config = `${draft}/config.json`;
  const layers = ['topwear', 'face', 'eyewhite-r', 'eyewhite-l'];
  mkdirSync(join(f.dir, draft, 'full/parts'), { recursive: true });
  cpSync(join(f.dir, 'source/rig/images/rectangle.png'), join(f.dir, painting));
  for (const name of layers) cpSync(join(f.dir, painting), join(f.dir, draft, 'full/parts', `${name}.png`));
  put(f.dir, `${draft}/full/layers.json`, { width: 8, height: 16, layers: layers.map(name => ({
    name, filename: `${name}.png`, left: 0, top: 0, right: 8, bottom: 16, depth_median: 0.5,
  })) });
  put(f.dir, config, {
    key: 'synthetic', scene: {}, seethrough: { resolution: 16, steps: 1, seed: 0, offload: false },
    assemble: { rig_scale: 1, plan: [['rectangle', 'full', 'topwear']] },
    bones: [{ name: 'anchor', parent: 'root', at: [0, 0] }], meshes: {}, regions: { rectangle: 'anchor' },
    motion: { duration: 1, tracks: [{ bone: 'anchor', prop: 'translatey', amp: 1, period: 1, phase: 0 }] },
  });
  const env = { ...process.env, CODEX_HOME: join(dirname(f.dir), 'codex-home'), SOURCE_DATE_EPOCH: String(testClock.now() / 1000) };
  const parts = (...args: string[]) => run([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/cli.ts'), ...args], f.dir, env);
  const create = (...args: string[]) => run([process.execPath, ...clockedCli(), ...args], f.dir, env);
  const assembled = parts('assemble', '--source', painting, '--full', `${draft}/full`, '--config', config, '--out', assembly);
  expect(assembled.stderr).toBe('');
  expect(assembled.code).toBe(0);
  const rigged = parts('rig', '--parts', `${assembly}/rig`, '--config', config, '--out', `${draft}/rig-out`);
  expect(rigged.stderr).toBe('');
  expect(rigged.code).toBe(0);
  const recorded = create('draft-rig', 'plate-fixture', f.dir, '--from', `${draft}/rig-out`, '--parts', `${assembly}/rig`, '--config', config);
  expect(recorded.stderr).toBe('');
  expect(recorded.code).toBe(0);
  f.args[f.args.indexOf('--parts') + 1] = `${assembly}/rig`;
  f.args[f.args.indexOf('--rig') + 1] = `${draft}/rig-out`;
  f.args.push('--run-record', `${draft}/rig-out/run.json`);
  return { ...f, assembly, painting, create };
}

describe('#871 the original assemble layout is an optional plate source', () => {
  const target = 'outputs/v1/plate-assemble';

  test('registration retains every receipt byte and Parts and Create reject a changed mask', () => {
    const { dir, args, assembly, painting, create } = setupPlateAssembly();
    const result = create('rig-version', ...args);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const version = JSON.parse(result.stdout) as JsonObject;
    const receipt = readFileSync(join(dir, assembly, 'run.json'));
    const outputs = arr(obj(JSON.parse(receipt.toString())).outputs).map(row => String(obj(row).path));
    for (const path of ['run.json', ...outputs]) {
      const bytes = readFileSync(join(dir, assembly, path));
      expect(readFileSync(join(dir, target, path))).toEqual(bytes);
      expect(version.outputs).toContainEqual({ path: `${target}/${path}`, sha256: jobHash(bytes), bytes: bytes.length });
    }
    const frozenFiles = arr(version.outputs).map(obj);
    expect(frozenFiles.filter(file => String(file.path).startsWith(`${target}/`))).toHaveLength(outputs.length + 1);
    expect(obj(version.registration).copied).toEqual({
      files: frozenFiles.length, bytes: frozenFiles.reduce((sum, file) => sum + Number(file.bytes), 0),
    });
    expect(checkProject(dir).refusals).toEqual([]);

    const source = readPlatePainting(join(dir, painting));
    const readMask = () => readSourceMask('figure-mask', join(dir, target, 'rig'), 8, 16, source.raster, source.bytes);
    expect(readMask().inside.reduce((sum, pixel) => sum + pixel, 0)).toBe(128);
    const maskPath = `${target}/rig/figure_rig.png`;
    const mask = readFileSync(join(dir, maskPath));
    mask[mask.length - 1] = mask[mask.length - 1]! ^ 1;
    writeFileSync(join(dir, maskPath), mask);
    expect(readMask).toThrow(expect.objectContaining({
      problems: [expect.objectContaining({ code: 'PLATE_MASK_RUN', object: join(dir, maskPath) })],
    }));
    expect(checkProject(dir).refusals).toContainEqual(expect.objectContaining({
      code: 'RIG_REGISTRATION_FILE_INVALID', message: expect.stringContaining(`${maskPath} changed`),
    }));
  });

  test.each(['unrecorded-path', 'missing-receipt', 'output-mismatch'] as const)('%s skips the entire optional copy', defect => {
    const { dir, args, assembly, create } = setupPlateAssembly();
    if (defect === 'unrecorded-path') {
      cpSync(join(dir, assembly), join(dir, 'source/unrecorded'), { recursive: true });
      args[args.indexOf('--parts') + 1] = 'source/unrecorded/rig';
    } else if (defect === 'missing-receipt') {
      rmSync(join(dir, assembly, 'run.json'));
    } else {
      writeFileSync(join(dir, assembly, 'render/recomposite_error_rig.png'), 'changed receipt output');
    }
    const result = create('rig-version', ...args);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(existsSync(join(dir, target))).toBe(false);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test('a refused registration preserves the record and leaves no plate source', () => {
    const { dir, args, create } = setupPlateAssembly();
    put(dir, 'source/idle/frames.json', { spec: 'rigc-frames/1', sets: [] });
    const before = readFileSync(join(dir, 'project.json'));
    const result = create('rig-version', ...args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('RIG_REGISTRATION_FILE_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
  });
});

function setupSharedAssets() {
  const base = setup();
  const imageBytes = readFileSync(join(base.dir, 'source/rig/images/rectangle.png'));
  const receiptBytes = `${JSON.stringify({ spec: plateReceiptSpec(base.dir), synthetic: 'occluder plate receipt' })}\n`;
  put(base.dir, 'source/inputs/plate/receipt.json', receiptBytes);
  writeFileSync(join(base.dir, 'source/inputs/plate/plate.png'), imageBytes);
  writeFileSync(join(base.dir, 'source/inputs/other.png'), imageBytes);
  put(base.dir, 'source/inputs/plate/mask.png', 'unreferenced sibling mask');
  put(base.dir, 'source/inputs/different.png', 'different image bytes');
  put(base.dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
  return { ...base, args: [...base.args, '--citations', 'source/citations.json'], imageBytes, receiptBytes };
}

function refused(args: string[], code: string): Refusal {
  const projectFile = join(args[1]!, 'project.json');
  const before = readFileSync(projectFile);
  let caught: unknown;
  try { rigVersionCommand(args); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Refusal);
  expect((caught as Refusal).code).toBe(code);
  expect(readFileSync(projectFile)).toEqual(before);
  return caught as Refusal;
}

function setupVisibleGround(ground: 'busy' | 'plain') {
  const { dir, args, load } = setup();
  put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: { project: 'visible', ground } });
  put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis', 'ground'] }] });
  const project = load();
  const guide = obj(waypoint(project, 'assemble').guide);
  obj(guide.value).ground = ground;
  arr(guide.asks).push({ id: 'ground', state: 'user' });
  put(dir, 'project.json', project);
  const register = [...args, '--citations', 'source/citations.json'];
  return { dir, project, register, preflight: () => rigVersionCommand([...register, '--preflight']) };
}

test('#752 a busy visible build requires a figure mask before registration', () => {
  const { dir, project, register, preflight } = setupVisibleGround('busy');
  const before = readFileSync(join(dir, 'project.json'));
  const missing = preflight();
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  refused(register, 'FIGURE_MASK_MISSING');

  const mask = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
  const figureMask = { path: '../mask.png', sha256: jobHash(mask) };
  writeFileSync(join(dir, 'mask.png'), mask);
  const painting = obj(arr(project.inputs)[0]);
  project.derived = [...arr(project.derived), {
    ...figureMask, path: 'mask.png', kind: 'prepared-input', bytes: mask.length,
    at: '2026-11-06T20:00:00Z', tool: 'synthetic matte', operation: 'alpha >= 128; foreground subtracted: none',
    source: { path: painting.path, sha256: painting.sha256 },
  }];
  put(dir, 'project.json', project);
  const requirements = JSON.parse(readFileSync(join(dir, 'source/requirements.json'), 'utf8')) as JsonObject;
  put(dir, 'source/requirements.json', { ...requirements, setup_painting: { required: true, figure_mask: figureMask } });
  const complete = preflight();
  expect(complete.exit).toBe(0);
  expect(JSON.parse(complete.stdout).declarations).toContainEqual({
    path: 'versions[v1].provenance.config requirements setup_painting.figure_mask', status: 'carried', codes: [],
  });
  expect(rigVersionCommand(register).exit).toBe(0);
  expect(readFileSync(join(dir, 'derived/review/v1/inputs/setup_painting/figure_mask/path'))).toEqual(mask);

  expect({ exit: missing.exit, figureMaskCodes: (JSON.parse(missing.stdout).refusals as JsonObject[]).map(f => f.code) })
    .toEqual({ exit: 1, figureMaskCodes: ['FIGURE_MASK_MISSING'] });
});

test('#752 a plain visible build still passes without a figure mask', () => {
  const { dir, register, preflight } = setupVisibleGround('plain');
  const before = readFileSync(join(dir, 'project.json'));
  expect(preflight().exit).toBe(0);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  expect(rigVersionCommand(register).exit).toBe(0);
});

test('frozen registration without a live parts approval refuses on the contract date', () => {
  const f = setup();
  testClock.set(new Date(RIG_PARTS_APPROVAL_SINCE));
  refused(f.args, 'RIG_PARTS_APPROVAL_REQUIRED');
  expect(existsSync(join(f.dir, 'outputs/v1'))).toBe(false);
});

/** A synthetic retained Review response and structure snapshot for the exact frozen parts. */
function approveFrozenParts(dir: string, project: JsonObject, args: string[]): JsonObject {
  const bind = (path: string) => ({ path, sha256: jobHash(readFileSync(join(dir, path))) });
  const draftPath = 'derived/drafts/synthetic-frozen';
  const partsPath = `${draftPath}/parts`;
  mkdirSync(join(dir, draftPath), { recursive: true });
  cpSync(join(dir, 'source/parts'), join(dir, partsPath), { recursive: true });
  cpSync(join(dir, 'source/config.json'), join(dir, draftPath, 'config.json'));
  args[args.indexOf('--parts') + 1] = partsPath;
  const files = ['parts.json', 'painting_in_rig.png', ...readdirSync(join(dir, partsPath, 'parts')).map(file => `parts/${file}`)]
    .map(path => bind(`${partsPath}/${path}`));
  const config = bind(`${draftPath}/config.json`);
  const tool = { name: '@rig-c/review', version: '2.5.0' };
  const bytes = `${JSON.stringify({ schema: 'rig-review-parts-verdict/2', tool, source: { sha256: 'a'.repeat(64), files },
    status: 'approved', parts: {} })}\n`;
  const path = `evidence/review-reads/${jobHash(bytes)}.json`;
  put(dir, path, bytes);
  const evidence = { ...bind(path), kind: 'parts-verdict', spec: 'rig-create/parts-verdict-cli@1' };
  const at = '2026-11-18T12:00:00.000Z';
  const draftId = 'synthetic-frozen';
  project.drafts = [{ id: draftId, config, parts: { path: partsPath, files } }];
  project.review_acts = [{ kind: 'parts-verdict', schema: evidence.spec, route: 'cli', draft_id: draftId, by: 'user', at,
    argv: ['opaque/input', '--verdict', 'opaque/verdict.json'], evidence, tool, status: 'approved', flagged: [], noted: [] }];
  put(dir, 'evidence/frozen-structure.json', { schema: 'rig-create/structure-decisions@0', draft_id: draftId, config, entries: [] });
  project.signoffs = [{ stage: 'parts-review', checkpoint: null, draft_id: draftId, by: 'user', at,
    verbatim: 'Approve the synthetic frozen parts.', evidence, structure: bind('evidence/frozen-structure.json') }];
  put(dir, 'project.json', project);
  return { signoff_at: at, evidence };
}

describe('#750 a refused registration names every new finding', () => {
  test('a config missing all three declarations is refused once with each code, in preflight order, and writes nothing', () => {
    const f = setup();
    put(f.dir, 'source/config.json', { key: 'synthetic', assemble: { editor_receipts: { trace_parts: true, receipts: [] } }, limbs: { cut: 'joints' }, requirements: 'requirements.json' });
    put(f.dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], seam_over_motion: { required: true }, boundary_colour: { max_step_excess: 12 } });
    put(f.dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    const project = f.load();
    obj(arr(obj(project.interview).framing).map(obj).find(q => q.id === 'rig_type')?.answer).value = 'fullscreen.minimal';
    approveFrozenParts(f.dir, project, f.args);
    testClock.set(new Date(RIG_CHECK_REPORT_SINCE));
    put(f.dir, 'source/at-source.json', { finished_at: RIG_CHECK_REPORT_SINCE });
    const args = [...f.args, '--citations', 'source/citations.json'];
    const tree = (): string[] => ['outputs', 'evidence', 'derived'].flatMap(root => existsSync(join(f.dir, root))
      ? readdirSync(join(f.dir, root), { recursive: true }).map(path => `${root}/${String(path)}`) : []).sort();
    const before = tree();
    const error = refused(args, 'SECTION_UNCITED');
    const lines = error.message.split('\n  ');
    expect([error.code, ...lines.slice(1).map(line => line.split(':')[0])]).toEqual(['SECTION_UNCITED', 'CG_GATE_UNDECLARED', 'SETUP_PAINTING_REQUIRED_MISSING']);
    expect(lines[0]).toStartWith('versions[v1].provenance.sections[limbs]: ');
    expect(lines[1]).toContain('behind_seams.threshold');
    expect(lines[2]).toContain("parts' own pixel_count per region");
    expect(tree()).toEqual(before);

    const preflight = rigVersionCommand([...args.filter(arg => arg !== '--json'), '--preflight', '--json']);
    expect((JSON.parse(preflight.stdout) as { refusals: { code: string }[] }).refusals.map(r => r.code)).toEqual(['SECTION_UNCITED', 'CG_GATE_UNDECLARED', 'SETUP_PAINTING_REQUIRED_MISSING']);
  });
});

describe('#573 frozen Parts check report', () => {
  const path = 'versions[v1].registration.check_report';
  const source = 'source/check.json';
  const retained = 'evidence/v1/registration/check.json';
  const producer = 'rig-parts check --rig <rig dir> --parts <parts dir> --source <painting> --requirements <requirements file> --out <check dir>';
  const beforeGate = '2026-11-18T23:59:59.999Z';
  const reportFlag = ['--check-report', source];
  const barFailure = { code: 'RIG_CHECK_BAR_FAILED', path: `${path}.bar_outcomes["shared"]` };
  const lineFailure = { code: 'RIG_CHECK_LINE_UNMET', path: `${path}.requirements.lines["shared"]` };
  const unmeasurable = { code: 'RIG_CHECK_LINE_UNMET', path: `${path}.requirements.lines["unmeasured"]` };

  function withCheck(at: string) {
    const f = setup();
    if (at === RIG_CHECK_REPORT_SINCE) approveFrozenParts(f.dir, f.load(), f.args);
    testClock.set(new Date(at));
    const modelHash = jobHash(readFileSync(join(f.dir, 'source/build/skeleton.model.json')));
    const report: JsonObject = { spec: 'rig-parts-check/1', build: { model_sha256: modelHash },
      bar_outcomes: { gate: { status: 'PASS' }, loop: { status: 'SKIP', reason: 'no-idle' } },
      requirements: { lines: { steady: { status: 'PASS' } } } };
    const store = (): void => put(f.dir, source, report);
    const projectWithRegistration = () => {
      const project = f.load();
      return { project, registration: obj(obj(arr(project.versions)[0]).registration) };
    };
    return { ...f, modelHash, report, store, projectWithRegistration };
  }

  function redReport(report: JsonObject): void {
    obj(report.bar_outcomes).shared = { status: 'FAIL' };
    const lines = obj(obj(report.requirements).lines);
    lines.shared = { status: 'FAIL' };
    lines.unmeasured = { status: 'NOT MEASURABLE', reason: 'undefined in these frames' };
  }

  test.each([beforeGate, RIG_CHECK_REPORT_SINCE])('omission warns and never discovers a report at %s', at => {
    const f = withCheck(at);
    delete f.report.build;
    f.store();
    expect(rigVersionCommand(f.args).exit).toBe(0);
    expect(f.projectWithRegistration().registration.check_report).toBeUndefined();
    expect(existsSync(join(f.dir, retained))).toBe(false);
    const report = checkProject(f.dir);
    expect(report.warnings).toContainEqual({ code: 'RIG_CHECK_REPORT_MISSING', path, message: expect.stringContaining(producer) });
  });

  test.each([beforeGate, RIG_CHECK_REPORT_SINCE])('a retained spec-less report warns at %s', at => {
    const f = withCheck(at);
    delete f.report.spec;
    delete f.report.build;
    redReport(f.report);
    f.store();
    expect(rigVersionCommand([...f.args, ...reportFlag]).exit).toBe(0);
    expect(obj(f.projectWithRegistration().registration.check_report).spec).toBeNull();
    const checked = checkProject(f.dir);
    const finding = checked.warnings.find(w => w.code === 'RIG_CHECK_REPORT_SPEC_MISSING');
    expect(finding?.path).toBe(path);
    expect(finding?.message).toContain(producer);
    expect(finding!.message.includes('Parts release carrying #1372')).toBe(at === RIG_CHECK_REPORT_SINCE);
    expect(checked.warnings.filter(w => [barFailure.code, lineFailure.code].includes(w.code))).toEqual([]);
  });

  test('binds raw report bytes and matching model digest, preserving SKIP outside Review inputs', () => {
    const f = withCheck(RIG_CHECK_REPORT_SINCE);
    // Only the typed outcomes supply verdicts.
    f.report.PASS = false;
    f.report.loop_max_diff = 99;
    f.store();
    const bytes = readFileSync(join(f.dir, source));
    expect(rigVersionCommand([...f.args, ...reportFlag]).exit).toBe(0);
    const { project, registration } = f.projectWithRegistration();
    expect(registration.check_report).toEqual({ path: retained, sha256: jobHash(bytes), bytes: bytes.length, spec: 'rig-parts-check/1' });
    expect(readFileSync(join(f.dir, retained))).toEqual(bytes);
    const version = obj(arr(project.versions)[0]);
    expect(arr(registration.files).map(row => obj(row).path)).not.toContain(retained);
    expect(arr(obj(version.review_package).files).some(row => String(obj(row).path).endsWith('/check.json'))).toBe(false);
    expect(rigRegistrationFindings(f.dir, project)).toEqual([]);
    obj(registration.check_report).spec = 'other/1';
    expect(checkProject(f.dir, project).refusals).toContainEqual({ code: 'RIG_CHECK_REPORT_INVALID', path, message: expect.stringContaining('recorded spec differs') });
    put(f.dir, retained, `${bytes.toString()}\n`);
    expect(checkProject(f.dir).refusals).toContainEqual({ code: 'RIG_CHECK_REPORT_INVALID', path, message: expect.stringContaining('bytes changed') });
  });

  test.each([[beforeGate, undefined], [RIG_CHECK_REPORT_SINCE, undefined], [beforeGate, 'malformed']] as const)(
    'spec’d report at %s with %s model digest refuses byte-identically', (at, digest) => {
      const f = withCheck(at);
      f.report.build = digest === undefined ? {} : { model_sha256: digest };
      f.store();
      const failure = refused([...f.args, ...reportFlag], 'RIG_CHECK_REPORT_MODEL_HASH_INVALID');
      expect(failure.message).toContain(`${path}.build.model_sha256`);
      expect(failure.message).toContain('Parts #1378');
      expect(existsSync(join(f.dir, retained))).toBe(false);
    },
  );

  test('another frozen model refuses byte-identically and names both digests', () => {
    const f = withCheck(RIG_CHECK_REPORT_SINCE);
    const wrongHash = jobHash('a different synthetic compiled model');
    f.report.build = { model_sha256: wrongHash };
    f.store();
    const failure = refused([...f.args, ...reportFlag], 'RIG_CHECK_REPORT_MODEL_MISMATCH');
    expect(failure.message).toContain(wrongHash);
    expect(failure.message).toContain(f.modelHash);
    expect(existsSync(join(f.dir, 'outputs/v1'))).toBe(false);
  });

  test('pre-contract reds warn individually, including array-free requirement names', () => {
    const f = withCheck(beforeGate);
    redReport(f.report);
    f.store();
    expect(rigVersionCommand([...f.args, ...reportFlag]).exit).toBe(0);
    const warnings: Parameters<typeof rigRegistrationFindings>[2] = [];
    expect(rigRegistrationFindings(f.dir, f.load(), warnings)).toEqual([]);
    expect(warnings.map(({ code, path }) => ({ code, path }))).toEqual([barFailure, lineFailure, unmeasurable]);
  });

  test('at the boundary only the owner-accepted typed keys clear findings', () => {
    const f = withCheck(RIG_CHECK_REPORT_SINCE);
    redReport(f.report);
    f.store();
    const args = [...f.args, ...reportFlag];
    const words = 'I accept the shared bar, the shared requirement, and the unmeasured requirement.\n';
    put(f.dir, 'source/words.txt', words);
    const chat = ['--check-accepted-by', 'user', '--owner-chat', 'source/words.txt', '--said-at', beforeGate, '--relayed-by', 'operator'];
    refused(args, barFailure.code);
    refused([...args, '--accept-check-bar', 'shared'], 'OWNER_CHAT_REQUIRED');
    refused([...args, '--accept-check-bar', 'shared', ...chat], lineFailure.code);
    refused([...args, '--accept-check-bar', 'loop', ...chat], 'RIG_CHECK_ACCEPTANCE_INVALID');
    const all = [...args, '--accept-check-bar', 'shared', '--accept-check-line', 'shared', '--accept-check-line', 'unmeasured', ...chat];
    expect(rigVersionCommand(all).exit).toBe(0);
    const { project, registration } = f.projectWithRegistration();
    const binding = obj(registration.check_report);
    const authority = { by: 'user', owner_words: words, at: registration.at, said_at: beforeGate, relayed_by: 'operator', source: 'owner chat, relayed' };
    expect(binding.acceptances).toEqual([
      { kind: 'bar', id: 'shared', ...authority }, { kind: 'line', id: 'shared', ...authority }, { kind: 'line', id: 'unmeasured', ...authority },
    ]);
    expect(rigRegistrationFindings(f.dir, project)).toEqual([]);
    delete obj(arr(binding.acceptances)[0]).owner_words;
    expect(rigRegistrationFindings(f.dir, project).map(finding => finding.code)).toEqual(['OWNER_CHAT_INVALID', barFailure.code]);
    delete binding.acceptances;
    const checkFindings = checkProject(f.dir, project).refusals;
    expect(checkFindings.filter(w => [barFailure.code, lineFailure.code].includes(w.code)).map(({ code, path }) => ({ code, path })))
      .toEqual([barFailure, lineFailure, unmeasurable]);
  });

  /** The producer's top-level block as Parts 2.53.0 writes it (src/sourceexposure.ts measureSourceExposure); only status is read. */
  const exposureBlock = (status: string, unmeasured = false): JsonObject => ({
    status, instrument: 'synthetic renderer', reading: 'synthetic reading', max_px: status === 'REPORTED' ? null : 4, alternates: 'not measured',
    parts: unmeasured ? [] : ['torso'], texels: unmeasured ? {} : { torso: { hidden: 3, undecided: 1 } }, frames: unmeasured ? 0 : 2, animations: [],
    rows: unmeasured ? [] : [{ part: 'torso', state: 'hidden', px: status === 'FAIL' ? 9 : 2, frame: 'setup', animation: null, index: 0, time: 0 }],
    unmeasured: [],
    ...(unmeasured ? { reason: 'no part in parts.json carries a source_state_map' } : {}),
  });
  const exposureFailure = { code: 'RIG_CHECK_LINE_UNMET', path: `${path}.SOURCE_EXPOSURE` };

  test.each([
    ['REPORTED (no declared limit)', exposureBlock('REPORTED')],
    ['PASS', exposureBlock('PASS')],
    ['absent', undefined],
  ] as const)('a %s SOURCE_EXPOSURE line is met', (_name, block) => {
    const f = withCheck(RIG_CHECK_REPORT_SINCE);
    if (block !== undefined) f.report.SOURCE_EXPOSURE = block;
    f.store();
    expect(rigVersionCommand([...f.args, ...reportFlag]).exit).toBe(0);
    expect(rigRegistrationFindings(f.dir, f.load())).toEqual([]);
  });

  test.each([
    ['FAIL over the declared max_px', exposureBlock('FAIL')],
    ['FAIL unmeasured with a declared max_px', exposureBlock('FAIL', true)],
  ] as const)('a %s SOURCE_EXPOSURE line is unmet until the owner accepts it', (_name, block) => {
    const f = withCheck(RIG_CHECK_REPORT_SINCE);
    f.report.SOURCE_EXPOSURE = block;
    f.store();
    const args = [...f.args, ...reportFlag];
    const failure = refused(args, exposureFailure.code);
    expect(failure.message).toContain(`${exposureFailure.path}: Parts reports FAIL`);
    expect(failure.message).toContain('--accept-check-exposure');
    const words = 'I accept the source exposure.\n';
    put(f.dir, 'source/words.txt', words);
    const chat = ['--check-accepted-by', 'user', '--owner-chat', 'source/words.txt', '--said-at', beforeGate, '--relayed-by', 'operator'];
    refused([...args, '--accept-check-line', 'SOURCE_EXPOSURE', ...chat], 'RIG_CHECK_ACCEPTANCE_INVALID');
    expect(rigVersionCommand([...args, '--accept-check-exposure', ...chat]).exit).toBe(0);
    const { project, registration } = f.projectWithRegistration();
    const binding = obj(registration.check_report);
    expect(arr(binding.acceptances).map(row => [obj(row).kind, obj(row).id])).toEqual([['exposure', 'SOURCE_EXPOSURE']]);
    expect(rigRegistrationFindings(f.dir, project)).toEqual([]);
    delete binding.acceptances;
    expect(checkProject(f.dir, project).refusals.filter(r => r.code === exposureFailure.code).map(({ code, path }) => ({ code, path })))
      .toEqual([exposureFailure]);
  });

  test('a pre-contract FAIL SOURCE_EXPOSURE warns; a malformed status is invalid', () => {
    const f = withCheck(beforeGate);
    f.report.SOURCE_EXPOSURE = exposureBlock('FAIL');
    f.store();
    expect(rigVersionCommand([...f.args, ...reportFlag]).exit).toBe(0);
    const warnings: Parameters<typeof rigRegistrationFindings>[2] = [];
    expect(rigRegistrationFindings(f.dir, f.load(), warnings)).toEqual([]);
    expect(warnings.map(({ code, path }) => ({ code, path }))).toEqual([exposureFailure]);
    const g = withCheck(RIG_CHECK_REPORT_SINCE);
    g.report.SOURCE_EXPOSURE = { ...exposureBlock('PASS'), status: 'SKIP' };
    g.store();
    expect(refused([...g.args, ...reportFlag], 'RIG_CHECK_REPORT_INVALID').message).toContain('invalid SOURCE_EXPOSURE status');
  });
});

test('frozen registration refuses parts bytes that differ from the newer bound approval', () => {
  const f = setup();
  const frozenParts = f.args[f.args.indexOf('--parts') + 1]!;
  approveFrozenParts(f.dir, f.load(), f.args);
  const manifest = `${frozenParts}/parts.json`;
  writeFileSync(join(f.dir, manifest), Buffer.concat([readFileSync(join(f.dir, manifest)), Buffer.from(' ')]));
  f.args[f.args.indexOf('--parts') + 1] = frozenParts;
  testClock.set(new Date(RIG_PARTS_APPROVAL_SINCE));
  refused(f.args, 'REVIEW_PACKAGE_PARTS_MISMATCH');
  expect(existsSync(join(f.dir, 'outputs/v1'))).toBe(false);
});

test('frozen registration refuses structure conflicts against the newer bound approval', () => {
  const f = setup();
  approveFrozenParts(f.dir, f.load(), f.args);
  const project = f.load();
  const approval = obj(arr(project.signoffs)[0]);
  const binding = obj(approval.structure);
  const path = String(binding.path);
  const snapshot = JSON.parse(readFileSync(join(f.dir, path), 'utf8'));
  snapshot.entries = [{ path: '/meshes/rectangle', value: null }];
  put(f.dir, path, snapshot);
  binding.sha256 = jobHash(readFileSync(join(f.dir, path)));
  put(f.dir, 'project.json', project);
  // Keep the approval valid while the frozen producer config overrides its declaration.
  put(f.dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', meshes: { rectangle: { grid: 4 } } });
  testClock.set(new Date(RIG_PARTS_APPROVAL_SINCE));
  refused(f.args, 'STRUCTURE_DECISIONS_CONFLICT');
  expect(existsSync(join(f.dir, 'outputs/v1'))).toBe(false);
});

function setupProvenancePointers() {
  const base = setup();
  const backdrop = readFileSync(join(base.dir, 'source/rig/images/rectangle.png'));
  writeFileSync(join(base.dir, 'source/backdrop.png'), backdrop);
  const requirements = {
    spec: 'spine-parts-requirements/1', fps: 4, requirements: [],
    setup_painting: {
      required: true,
      backdrop: { path: 'backdrop.png', sha256: jobHash(backdrop) },
      regions: Array.from({ length: 7 }, (_, index) => ({
        name: `region-${index}`, box: [0, 0, 1, 1], max_pixels: 0,
        'x-source': { json_pointer: `/METRICS/regions/${index}/pixel_count` },
      })),
    },
  };
  put(base.dir, 'source/requirements.json', requirements);
  return { ...base, requirements };
}

describe('frozen rig registration', () => {
  function setupEditedParts(nested = true, editedDir = nested ? '../../../inputs/edited' : '../inputs/edited') {
    const base = setup();
    const configPath = nested ? 'source/config/nested/config.json' : 'source/config.json';
    const imageBytes = [
      readFileSync(join(base.dir, 'source/rig/images/rectangle.png')),
      readFileSync(join(base.dir, 'source/idle/idle@4fps/f0001.png')),
    ];
    const names = ['rectangle.png', 'accent.png'];
    const assetDir = resolve(base.dir, dirname(configPath), editedDir);
    mkdirSync(assetDir, { recursive: true });
    imageBytes.forEach((image, index) => writeFileSync(join(assetDir, names[index]!), image));
    put(base.dir, configPath, {
      key: 'synthetic', requirements: nested ? '../../requirements.json' : 'requirements.json',
      assemble: { edited_parts: { dir: editedDir, receipts: names.map((file, index) => ({
        part: index === 0 ? 'rectangle' : 'accent', file,
        sha256: jobHash(imageBytes[index]!), from_sha256: jobHash(imageBytes[index]!), editor: 'synthetic editor',
      })) } },
    });
    put(base.dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    base.args[base.args.indexOf('--config') + 1] = configPath;
    return { ...base, args: [...base.args, '--citations', 'source/citations.json'], imageBytes, names, editedDir, configPath };
  }

  function assertEditedPartsAccepted(f: ReturnType<typeof setupEditedParts>) {
    const original = readFileSync(join(f.dir, f.configPath));
    expect(rigVersionCommand(f.args).exit).toBe(0);
    expect(readFileSync(join(f.dir, 'evidence/v1/registration/config-source.json'))).toEqual(original);
    const runtimeBytes = readFileSync(join(f.dir, 'evidence/v1/registration/config.json'));
    expect(readFileSync(join(f.dir, 'derived/review/v1/config.json'))).toEqual(runtimeBytes);
    const edited = obj(obj(JSON.parse(runtimeBytes.toString()).assemble).edited_parts);
    const rows = JSON.parse(readFileSync(join(f.dir, 'evidence/v1/registration/path-adapter.json'), 'utf8')) as JsonObject[];
    const receipts = arr(edited.receipts).map(obj);
    expect(receipts).toHaveLength(2);
    for (const [index, receipt] of receipts.entries()) {
      const row = rows.find(row => row.pointer === `/assemble/edited_parts/receipts/${index}/file`);
      const runtimePath = posix.join(String(edited.dir), String(receipt.file));
      expect(runtimePath).toBe(row ? String(row.after) : posix.join(f.editedDir, f.names[index]!));
      expect(runtimePath.split('/')).not.toContain('..');
      expect(receipt.sha256).toBe(jobHash(f.imageBytes[index]!));
      for (const root of ['evidence/v1/registration', 'derived/review/v1']) {
        expect(readFileSync(join(f.dir, root, runtimePath))).toEqual(f.imageBytes[index]!);
      }
    }
    expect(readFileSync(join(f.dir, f.configPath))).toEqual(original);
    expect(rigRegistrationFindings(f.dir, f.load())).toEqual([]);
    const checked = checkProject(f.dir);
    expect(checked.refusals).toEqual([]);
    return f.load();
  }

  function rebindEditedPartsEvidence(dir: string, project: JsonObject, kind: 'config_source' | 'path_adapter', value: unknown) {
    const registration = obj(obj(arr(project.versions)[0]).registration);
    const binding = obj(registration[kind]);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    writeFileSync(join(dir, String(binding.path)), bytes);
    binding.sha256 = jobHash(bytes);
    binding.bytes = bytes.length;
    for (const entry of arr(registration.files).map(obj)) {
      if (entry.path === binding.path) { entry.sha256 = jobHash(bytes); entry.bytes = bytes.length; }
    }
  }

  test('#720 adapter CLI prints the hand-written rows and registration retains those exact bytes', () => {
    const f = setupEditedParts();
    const projectPath = join(f.dir, 'project.json');
    const projectBytes = readFileSync(projectPath);
    const config = JSON.parse(readFileSync(join(f.dir, f.configPath), 'utf8'));
    config.assemble.editor_receipts = { receipts: [{ file: '../../rig/images/rectangle.png' }] };
    put(f.dir, f.configPath, config);
    const imageSha = jobHash(f.imageBytes[0]!);
    put(f.dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: {
      required: true,
      figure_mask: { path: 'rig/images/rectangle.png', sha256: imageSha },
      backdrop: { path: 'rig/images/rectangle.png', sha256: imageSha },
    } });
    const configBytes = readFileSync(join(f.dir, f.configPath));
    const reqBytes = readFileSync(join(f.dir, 'source/requirements.json'));
    const expected = [
      { doc: 'config', pointer: '/requirements', before: '../../requirements.json', after: 'inputs/requirements' },
      { doc: 'config', pointer: '/assemble/edited_parts/receipts/0/file', before: '../../../inputs/edited/rectangle.png', after: 'inputs/assemble/edited_parts/receipts/0/file' },
      { doc: 'config', pointer: '/assemble/edited_parts/receipts/1/file', before: '../../../inputs/edited/accent.png', after: 'inputs/assemble/edited_parts/receipts/1/file' },
      { doc: 'config', pointer: '/assemble/editor_receipts/receipts/0/file', before: '../../rig/images/rectangle.png', after: 'inputs/assemble/editor_receipts/receipts/0/file' },
      { doc: 'requirements', pointer: '/setup_painting/figure_mask/path', before: 'rig/images/rectangle.png', after: 'rig/images/rectangle.png' },
      { doc: 'requirements', pointer: '/setup_painting/backdrop/path', before: 'rig/images/rectangle.png', after: 'setup_painting/backdrop/path' },
    ];
    const out = 'source/generated-adapter.json';
    const cliArgs = [process.execPath, ...clockedCli(), 'rig-version', 'adapter', f.dir, '--config', f.configPath, '--out', out];
    const result = run(cliArgs, f.dir, process.env as Record<string, string>);
    const handWritten = `${JSON.stringify(expected, null, 2)}\n`;
    expect(result).toEqual({ code: 0, stderr: '', stdout: handWritten });
    expect(readFileSync(join(f.dir, out), 'utf8')).toBe(handWritten);
    expect(readFileSync(projectPath)).toEqual(projectBytes);
    expect(readFileSync(join(f.dir, f.configPath))).toEqual(configBytes);
    expect(readFileSync(join(f.dir, 'source/requirements.json'))).toEqual(reqBytes);
    expect(existsSync(join(f.dir, 'evidence/v1/registration'))).toBe(false);

    f.args[f.args.indexOf('--path-adapter') + 1] = out;
    assertEditedPartsAccepted(f);
    expect(readFileSync(join(f.dir, 'evidence/v1/registration/path-adapter.json'), 'utf8')).toBe(handWritten);
  });

  test('#720 an absolute config reference uses the existing legacy row', () => {
    const { dir, args, load } = setup();
    const asset = join(dir, 'source/rig/images/rectangle.png');
    put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: {
      editor_receipts: { receipts: [{ file: asset, sha256: jobHash(readFileSync(asset)) }] },
    } });
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    const out = 'source/generated-adapter.json';
    expect(rigVersionCommand(['adapter', dir, '--config', 'source/config.json', '--out', out]).exit).toBe(0);
    const bytes = readFileSync(join(dir, out));
    expect(JSON.parse(bytes.toString())).toEqual([
      { doc: 'config', pointer: '/requirements', before: 'requirements.json', after: 'requirements.json' },
      { at: '.assemble.editor_receipts.receipts.0.file', before: asset, after: asset },
    ]);
    args[args.indexOf('--path-adapter') + 1] = out;
    expect(rigVersionCommand([...args, '--citations', 'source/citations.json']).exit).toBe(0);
    expect(readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'))).toEqual(bytes);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test('#720 equal adapter paths replay edited-parts receipt setters', () => {
    const f = setupEditedParts(false, 'inputs/edited');
    const config = JSON.parse(readFileSync(join(f.dir, f.configPath), 'utf8'));
    config.assemble.edited_parts.receipts[0].file = './rectangle.png';
    put(f.dir, f.configPath, config);
    const out = 'source/generated-adapter.json';
    expect(rigVersionCommand(['adapter', f.dir, '--config', f.configPath, '--out', out]).exit).toBe(0);
    f.args[f.args.indexOf('--path-adapter') + 1] = out;
    assertEditedPartsAccepted(f);
    const retained = readFileSync(join(f.dir, 'evidence/v1/registration/path-adapter.json'));
    expect(retained).toEqual(readFileSync(join(f.dir, out)));
  });

  test('#720 an unmappable requirements path leaves both a fresh and an existing output untouched', () => {
    const { dir } = setup();
    const asset = join(dir, 'source/rig/images/rectangle.png');
    const configPath = 'source/config.json';
    const reqPath = 'source/requirements.json';
    put(dir, reqPath, { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: {
      required: true, backdrop: { path: asset, sha256: jobHash(readFileSync(asset)) },
    } });
    const before = ['project.json', configPath, reqPath, 'source/adapter.json'].map(path => [path, readFileSync(join(dir, path))] as const);
    for (const out of ['new-dir/adapter.json', 'source/adapter.json']) {
      const result = run([process.execPath, ...clockedCli(), 'rig-version', 'adapter', dir, '--config', configPath, '--out', out],
        dir, process.env as Record<string, string>);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('RIG_RUNTIME_PATH_UNRESOLVED');
      expect(result.stderr).toContain('requirements.setup_painting.backdrop.path');
    }
    expect(existsSync(join(dir, 'new-dir'))).toBe(false);
    for (const [path, bytes] of before) expect(readFileSync(join(dir, path))).toEqual(bytes);
  });

  test('#720 adapter output accepts identical bytes and refuses to replace different bytes', () => {
    const { dir } = setup();
    const args = ['adapter', dir, '--config', 'source/config.json', '--out', 'source/adapter.json'];
    const out = join(dir, 'source/adapter.json');
    const original = readFileSync(out);
    refused(args, 'RIG_PATH_ADAPTER_OUT_INVALID');
    expect(readFileSync(out)).toEqual(original);
    const fresh = [...args.slice(0, -1), 'source/generated-adapter.json'];
    const created = rigVersionCommand(fresh);
    expect(created.exit).toBe(0);
    expect(rigVersionCommand(fresh)).toEqual(created);
  });

  test.each([false, true])('#570 edited_parts relative dir and bare receipts register and check (nested=%s)', nested => {
    assertEditedPartsAccepted(setupEditedParts(nested));
  });

  test.each(['joined', 'raw'] as const)('#570 edited_parts accepts explicit %s before with shared-dir sibling rebasing', spelling => {
    const f = setupEditedParts();
    put(f.dir, 'source/adapter.json', f.names.map((name, index) => ({
      doc: 'config', pointer: `/assemble/edited_parts/receipts/${index}/file`,
      before: spelling === 'raw' ? name : posix.join(f.editedDir, name),
      after: `inputs/selected-${index}/image.png`,
    })));
    assertEditedPartsAccepted(f);
  });

  test('#570 edited_parts already portable dir retains both receipt targets', () => {
    const f = setupEditedParts(false, 'inputs/edited');
    assertEditedPartsAccepted(f);
    const runtime = JSON.parse(readFileSync(join(f.dir, 'evidence/v1/registration/config.json'), 'utf8')) as JsonObject;
    const edited = obj(obj(runtime.assemble).edited_parts);
    expect(edited.dir).toBe('inputs/edited');
    expect(arr(edited.receipts).map(raw => obj(raw).file)).toEqual(f.names);
  });

  test('#570 invalid edited_parts caller before refuses before any record or evidence write', () => {
    const f = setupEditedParts();
    renameSync(join(f.dir, 'evidence/v1'), join(f.dir, 'source/prior-v1-evidence'));
    expect(existsSync(join(f.dir, 'evidence/v1'))).toBe(false);
    const evidenceBefore = (path: string): unknown[] => readdirSync(join(f.dir, path)).sort().map(name => {
      const entry = `${path}/${name}`;
      return lstatSync(join(f.dir, entry)).isDirectory() ? [entry, evidenceBefore(entry)] : [entry, jobHash(readFileSync(join(f.dir, entry)))];
    });
    const retained = evidenceBefore('evidence');
    put(f.dir, 'source/adapter.json', [{
      doc: 'config', pointer: '/assemble/edited_parts/receipts/0/file',
      before: 'neither-form.png', after: 'inputs/selected/image.png',
    }]);
    refused(f.args, 'RIG_PATH_ADAPTER_INVALID');
    expect(evidenceBefore('evidence')).toEqual(retained);
    for (const path of ['outputs/v1', 'evidence/v1', 'derived/review/v1']) expect(existsSync(join(f.dir, path))).toBe(false);
  });

  test.each(['config_source', 'path_adapter'] as const)('#570 rejects rehashed edited_parts %s tampering with named adapter refusal', kind => {
    const f = setupEditedParts();
    const candidate = assertEditedPartsAccepted(f);
    const registration = obj(obj(arr(candidate.versions)[0]).registration);
    const value = JSON.parse(readFileSync(join(f.dir, String(obj(registration[kind]).path)), 'utf8'));
    if (kind === 'config_source') value.assemble.edited_parts.receipts[0].file = 'changed-receipt.png';
    else (value as JsonObject[]).find(row => row.pointer === '/assemble/edited_parts/receipts/0/file')!.before = 'neither-form.png';
    rebindEditedPartsEvidence(f.dir, candidate, kind, value);
    expect(rigRegistrationFindings(f.dir, candidate).map(finding => finding.code)).toContain('RIG_PATH_ADAPTER_INVALID');
    expect(checkProject(f.dir, candidate).refusals.map(finding => finding.code)).toContain('RIG_PATH_ADAPTER_INVALID');
  });

  test('#409 seven requirements provenance JSON pointers survive public writer registration', () => {
    const { dir, args, load, requirements } = setupProvenancePointers();
    const originalConfig = readFileSync(join(dir, 'source/config.json'));
    const originalRequirements = readFileSync(join(dir, 'source/requirements.json'));
    const result = run([process.execPath, ...clockedCli(), 'rig-version', ...args], dir, process.env as Record<string, string>);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, 'evidence/v1/registration/config-source.json'))).toEqual(originalConfig);
    expect(readFileSync(join(dir, 'evidence/v1/registration/requirements-source.json'))).toEqual(originalRequirements);
    const runtime = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/requirements.json'), 'utf8'));
    const packaged = JSON.parse(readFileSync(join(dir, 'derived/review/v1/requirements.json'), 'utf8'));
    expect(runtime.setup_painting.regions).toEqual(requirements.setup_painting.regions);
    expect(packaged).toEqual(runtime);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test.each(['/METRICS/a~1b/~0name', '/', '/METRICS//pixel_count', '/report.json', ''])('#409 provenance pointer syntax preserves %j', pointer => {
    const { dir, args, load, requirements } = setupProvenancePointers();
    requirements.setup_painting.regions[0]!['x-source'].json_pointer = pointer;
    put(dir, 'source/requirements.json', requirements);
    const original = readFileSync(join(dir, 'source/requirements.json'));
    expect(rigVersionCommand(args).exit).toBe(0);
    expect(readFileSync(join(dir, 'evidence/v1/registration/requirements-source.json'))).toEqual(original);
    const runtime = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/requirements.json'), 'utf8'));
    expect(runtime.setup_painting.regions[0]['x-source'].json_pointer).toBe(pointer);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test.each([
    ['declared asset', 'RIG_RUNTIME_PATH_UNRESOLVED', (requirements: JsonObject) => {
      obj(requirements.setup_painting).figure_mask = { path: '/foreign/mask.png', sha256: '1'.repeat(64) };
    }],
    ['undeclared field', 'RIG_REGISTRATION_FILE_INVALID', (requirements: JsonObject) => {
      obj(requirements.setup_painting).unlisted = '/foreign/asset.png';
    }],
    ['other provenance field', 'RIG_REGISTRATION_FILE_INVALID', (requirements: JsonObject) => {
      obj((obj(requirements.setup_painting).regions as JsonObject[])[0]!['x-source']).unlisted = '/foreign/asset.png';
    }],
    ['json_pointer outside x-source', 'RIG_REGISTRATION_FILE_INVALID', (requirements: JsonObject) => {
      (obj(requirements.setup_painting).regions as JsonObject[])[0]!.json_pointer = '/METRICS/regions/0/pixel_count';
    }],
    ['json_pointer under another extension', 'RIG_REGISTRATION_FILE_INVALID', (requirements: JsonObject) => {
      (obj(requirements.setup_painting).regions as JsonObject[])[0]!['x-other'] = { json_pointer: '/METRICS/regions/0/pixel_count' };
    }],
  ] as const)('#409 refuses an absolute value in %s and rolls back', (name, code, mutate) => {
    const { dir, args, requirements } = setupProvenancePointers();
    mutate(requirements);
    put(dir, 'source/requirements.json', requirements);
    const original = readFileSync(join(dir, 'source/requirements.json'));
    const failure = refused(args, code);
    if (name !== 'declared asset') {
      expect(failure.message).toContain('evidence/v1/registration/requirements.json#/');
      expect(failure.message).toContain('restore the retained registration inputs');
    }
    expect(readFileSync(join(dir, 'source/requirements.json'))).toEqual(original);
    for (const path of ['outputs/v1', 'evidence/v1/registration', 'derived/review/v1']) expect(existsSync(join(dir, path))).toBe(false);
  });

  test.each(['/METRICS/bad~2escape', '/METRICS/trailing~', 'C:\\foreign\\report.json'])('#409 refuses invalid provenance pointer %j', pointer => {
    const { dir, args, requirements } = setupProvenancePointers();
    requirements.setup_painting.regions[0]!['x-source'].json_pointer = pointer;
    put(dir, 'source/requirements.json', requirements);
    const failure = refused(args, 'RIG_REGISTRATION_FILE_INVALID');
    expect(failure.message).toContain('requirements.json#/setup_painting/regions/0/x-source/json_pointer');
    expect(failure.message).toContain('RFC 6901');
    for (const path of ['outputs/v1', 'evidence/v1/registration', 'derived/review/v1']) expect(existsSync(join(dir, path))).toBe(false);
  });

  test.each([false, true])('writer commit owns live publication, with stopped host=%s', async stopped => {
    const { dir, args, load } = setup();
    const source = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(dir, 'inputs/painting.png'), source);
    const record = load();
    record.inputs = [{ path: 'inputs/painting.png', sha256: jobHash(source), bytes: source.length,
      origin: 'synthetic original painting', at: new Date(testClock.now()).toISOString() }];
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(record, null, 2)}\n`);
    const host = await openCreateJob(dir, { id: 'reviewer', role: 'owner' }, testClock.now());
    const binding = readWriterBinding(dir)!;
    expect(binding.listenerIncarnation).toBe(host.attachment!.listenerIncarnation);
    let recovery: Awaited<ReturnType<typeof openCreateJob>> | undefined;
    try {
      if (stopped) host.stop();
      // The agent only invokes the writer. No test/agent publish call occurs here.
      const child = Bun.spawn([process.execPath, ...clockedCli(), 'rig-version', ...args], {
        cwd: dir, stdout: 'pipe', stderr: 'pipe',
      });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      const bytes = readFileSync(join(dir, 'project.json'));
      if (stopped) {
        expect(exit).toBe(0);
        expect(stderr).toStartWith('WARN JOB_PUBLISH_PENDING: project.json: versions[v1] is recorded');
        expect(pendingPublications(dir)[0].failure?.code).toBe('JOB_HOST_ATTACH_REFUSED');
        expect(checkProject(dir).holes?.map(hole => hole.code)).toEqual(['JOB_PUBLISH_PENDING']);
        recovery = await openCreateJob(dir, { id: 'reviewer', role: 'owner' }, testClock.now());
        expect(recovery.session.status().generation).toBe(0);
        await reconcileCreateJob(dir);
        expect(checkProject(dir).holes ?? []).toEqual([]);
        expect(recovery.session.status().publication?.source.projectHash).toBe(jobHash(bytes));
        expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
      } else {
        expect(stderr).toBe('');
        expect(exit).toBe(0);
        expect(host.session.status().publication?.source.projectHash).toBe(jobHash(bytes));
        expect(host.session.status().publication?.label).toBe('rig v1');
        const painting = host.session.status().publication?.source.parts?.images.find(image => image.path === 'painting_in_rig.png');
        expect(painting?.sha256).toBe(jobHash(readFileSync(join(dir, 'outputs/v1/out/painting_in_rig.png'))));
        expect(painting?.sha256).toBe(jobHash(readFileSync(join(dir, 'derived/review/v1/out/painting_in_rig.png'))));
        expect(((load().versions as JsonObject[])[0].review_package as JsonObject).files).toContainEqual({ path: 'out/painting_in_rig.png', sha256: painting!.sha256 });
      }
    } finally {
      recovery?.stop(); host.stop();
      rmSync(jobPrivateRoot(dir), { recursive: true, force: true });
      rmSync(jobHostStateRoot(dir), { recursive: true, force: true });
    }
  });

  test('#844 a registration committed while the host is stopped exits 0, names its pending publication, and a retry names the version', async () => {
    const { dir, args, load } = setup();
    const source = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(dir, 'inputs/painting.png'), source);
    const record = load();
    record.inputs = [{ path: 'inputs/painting.png', sha256: jobHash(source), bytes: source.length,
      origin: 'synthetic original painting', at: new Date(testClock.now()).toISOString() }];
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(record, null, 2)}\n`);
    const file = join(dir, 'project.json');
    const runCli = async (...argv: string[]) => {
      const child = Bun.spawn([process.execPath, ...clockedCli(), ...argv], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exit, stdout, stderr };
    };
    const acknowledged = () => {
      const receipts = join(jobPrivateRoot(dir), 'acknowledged-publications');
      return readdirSync(receipts).map(name => JSON.parse(readFileSync(join(receipts, name), 'utf8')) as JsonObject)
        .map(receipt => obj(obj(receipt.result).selector).version);
    };
    const v2 = ['2', ...args.slice(1)];
    const host = await openCreateJob(dir, { id: 'reviewer', role: 'owner' }, testClock.now());
    let reopened: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      expect((await runCli('rig-version', ...args)).exit).toBe(0);
      host.stop();

      // 1. The record is committed and only its publication waits: success with a named WARN, not a refusal.
      const before = readFileSync(file);
      const committed = await runCli('rig-version', ...v2);
      expect(committed.exit).toBe(0);
      expect(obj(JSON.parse(committed.stdout)).n).toBe(2);
      expect(committed.stderr).toMatch(/^WARN JOB_PUBLISH_PENDING: project\.json: versions\[v2\] is recorded .*\(JOB_HOST_ATTACH_REFUSED: .*job reconcile\n$/);
      expect(readFileSync(file).equals(before)).toBe(false);
      expect(arr(load().versions).map(v => obj(v).n)).toEqual([1, 2]);
      expect(pendingPublications(dir)).toMatchObject([{ result: { selector: { kind: 'rig', version: 2 } }, phase: 'pending', failure: { code: 'JOB_HOST_ATTACH_REFUSED' } }]);

      // 2. A retry names the registered version and its pending publication, and leaves the record byte-identical.
      const committedBytes = readFileSync(file);
      const retry = await runCli('rig-version', ...v2);
      expect(retry.exit).toBe(1);
      expect(retry.stderr).toMatch(/^rig-create: RIG_VERSION_ALREADY_REGISTERED: versions\[v2\]: .*\(JOB_PUBLISH_PENDING: JOB_HOST_ATTACH_REFUSED\).*job reconcile\n$/);
      expect(readFileSync(file)).toEqual(committedBytes);

      // 3. Restarting the host with job open reconciles the pending entry under its own publication step,
      // so close finds nothing pending and a later reconcile has nothing left.
      reopened = Bun.spawn([process.execPath, ...clockedCli(), 'job', 'open', dir, '--reviewer', 'reviewer', '--role', 'owner'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const stderr = new Response(reopened.stderr).text();
      const reader = reopened.stdout.getReader();
      let printed = '';
      while (!/\njob: .*\n$/.test(printed)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        printed += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      // Its printed lines name only the republished head (rig v1); the reconciled v2 is not named (reported on create#844).
      expect(printed).toMatch(/^http:\/\/.*\n[\s\S]*\njob: rig v1 published \(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)\n/);
      expect(pendingPublications(dir)).toEqual([]);
      expect(acknowledged()).toContain(2);
      expect(await runCli('job', 'close', dir)).toEqual({ exit: 0, stdout: 'job: closed\n', stderr: '' });
      expect(existsSync(join(jobPrivateRoot(dir), 'retired-publications'))).toBe(false);
      expect(await runCli('job', 'reconcile', dir)).toEqual({ exit: 0, stdout: 'job: reconciled 0 publication(s)\n', stderr: '' });
      expect(await reopened.exited).toBe(0);
      expect(await stderr).toBe('');

      const settled = await runCli('rig-version', ...v2);
      expect(settled.exit).toBe(1);
      expect(settled.stderr).toMatch(/^rig-create: RIG_VERSION_ALREADY_REGISTERED: versions\[v2\]: .*no publication of it is pending/);
      expect(readFileSync(file)).toEqual(committedBytes);
    } finally {
      reopened?.kill(); host.stop();
      rmSync(jobPrivateRoot(dir), { recursive: true, force: true });
      rmSync(jobHostStateRoot(dir), { recursive: true, force: true });
    }
  }, 90_000);

  test('public CLI records real producer frames, declared tools, cited date and unchanged stage', () => {
    const { dir, args, load } = setup();
    expect(checkProject(dir).refusals).toEqual([]);
    const before = load();
    const result = run([process.execPath, ...clockedCli(), 'rig-version', ...args], dir, process.env as Record<string, string>);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const version = JSON.parse(result.stdout) as JsonObject;
    const paintingHash = jobHash(readFileSync(join(dir, 'source/parts/painting_in_rig.png')));
    expect((version.outputs as JsonObject[]).find(file => file.path === 'outputs/v1/out/painting_in_rig.png')?.sha256).toBe(paintingHash);
    expect((version.review_package as JsonObject).files).toContainEqual({ path: 'out/painting_in_rig.png', sha256: paintingHash });
    expect(version.built_with).toEqual({ '@rig-c/parts': '2.23.4', '@rig-c/core': '3.4.1' });
    expect(version.at).toBe(JSON.parse(readFileSync(join(frozen, 'at-source.json'), 'utf8')).finished_at);
    expect(version.at_basis).toBe('not-after');
    expect(obj(version.registration).at).not.toBe(version.at);
    expect(version.verdicts).toEqual([]);
    expect(load().stage).toBe(before.stage);
    expect(load().signoffs).toEqual(before.signoffs);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
    expect(readFileSync(join(dir, 'outputs/v1/out/check/build/skeleton.model.json'))).toEqual(readFileSync(join(frozen, 'build/skeleton.model.json')));
    expect(readFileSync(join(dir, 'outputs/v1/idle/frames.json'))).toEqual(readFileSync(join(frozen, 'idle/frames.json')));
    const review = run([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/review/src/cli.ts'), 'check', join(dir, 'derived/review/v1/out')], dir, process.env as Record<string, string>);
    expect(review.code).toBe(0);
    rmSync(join(dir, 'source'), { recursive: true });
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  function registerWithBunLock(dir: string, args: string[]): JsonObject {
    args[args.indexOf('--toolchain-lock') + 1] = 'bun.lock';
    const result = rigVersionCommand(args);
    expect(result.exit).toBe(0);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const version = obj(arr(project.versions)[0]);
    const lock = obj(obj(version.registration).toolchain);
    expect(lock.kind).toBe('bun-lock');
    const source = obj(lock.source);
    const bytes = readFileSync(join(dir, 'bun.lock'));
    expect(source.sha256).toBe(jobHash(bytes));
    expect(readFileSync(join(dir, String(source.path)))).toEqual(bytes);
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    return version;
  }

  test('registers and reads a Bun text lock with trailing commas', () => {
    const { dir, args } = setup();
    put(dir, 'bun.lock', `{
      "lockfileVersion": 2,
      "workspaces": { "": {}, },
      "packages": {
        "@rig-c/parts": ["@rig-c/parts@2.23.4", "", {}, "sha512-YQ=="],
        "@rig-c/core": ["@rig-c/core@3.4.1", "", {}, "sha512-Yg=="],
      },
    }`);
    const version = registerWithBunLock(dir, args);
    expect(version.built_with).toEqual({ '@rig-c/parts': '2.23.4', '@rig-c/core': '3.4.1' });
    rmSync(join(dir, 'derived/review/v1'), { recursive: true });
    expect(reviewPackageCommand(['1', dir, '--config', 'evidence/v1/registration/config.json', '--from', 'outputs/v1/out']).exit).toBe(0);
    const regenerated = obj(arr(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).versions)[0]);
    expect(regenerated.review_package).toEqual(version.review_package);
  });

  // #849: v1 is the page head and v2 is pending when the host restarts. Search fresh jobs until the
  // receipt-hash order of v1's republication and v2's pending entry falls the requested way.
  test.each(['v1 sorts first', 'v1 sorts last', 'named --rig 1'] as const)('#849 job open after a restart ends on the newest version unless one is named, and names each pending publication: %s', async order => {
    const runCli = async (dir: string, ...argv: string[]) => {
      const child = Bun.spawn([process.execPath, ...clockedCli(), ...argv], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exit, stdout, stderr };
    };
    const receipts = (dir: string) => {
      const directory = join(jobPrivateRoot(dir), 'acknowledged-publications');
      return readdirSync(directory).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as JsonObject);
    };
    for (let attempt = 0; attempt < 12; attempt++) {
      const { dir, args, load } = setup();
      const source = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
      writeFileSync(join(dir, 'inputs/painting.png'), source);
      const record = load();
      record.inputs = [{ path: 'inputs/painting.png', sha256: jobHash(source), bytes: source.length,
        origin: 'synthetic original painting', at: new Date(testClock.now()).toISOString() }];
      writeFileSync(join(dir, 'project.json'), `${JSON.stringify(record, null, 2)}\n`);
      const host = await openCreateJob(dir, { id: 'reviewer', role: 'owner' }, testClock.now());
      let reopened: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
      try {
        expect((await runCli(dir, 'rig-version', ...args)).exit).toBe(0);
        const [v1] = receipts(dir);
        const v1Id = jobHash(JSON.stringify([v1!.jobId, v1!.versionHash, v1!.result]));
        host.stop();
        // The writer commits v2 and leaves its publication pending (its exit is #844's subject).
        const committed = await runCli(dir, 'rig-version', '2', ...args.slice(1));
        expect(committed.stderr).toContain('JOB_PUBLISH_PENDING');
        expect(arr(load().versions).map(v => obj(v).n)).toEqual([1, 2]);
        const [v2] = pendingPublications(dir);
        expect(v2!.result.selector).toEqual({ kind: 'rig', version: 2 });
        if (order !== 'named --rig 1' && (v1Id < v2!.id) !== (order === 'v1 sorts first')) continue;
        const bytes = readFileSync(join(dir, 'project.json'));
        // A refused open writes nothing and leaves v2 pending.
        const unknown = await runCli(dir, 'job', 'open', dir, '--reviewer', 'reviewer', '--role', 'owner', '--rig', '3');
        expect(unknown.exit).toBe(1);
        expect(unknown.stderr).toStartWith('JOB_PUBLICATION_INVALID: versions[v3]: --rig needs one recorded rig or post version');
        expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
        expect(pendingPublications(dir).map(entry => entry.id)).toEqual([v2!.id]);

        const named = order === 'named --rig 1' ? ['--rig', '1'] : [];
        // --rig reads its files under the real root path (a temporary directory can sit behind a symlink).
        reopened = Bun.spawn([process.execPath, ...clockedCli(), 'job', 'open', realpathSync(dir), '--reviewer', 'reviewer', '--role', 'owner', ...named], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
        const stderr = new Response(reopened.stderr).text();
        const reader = reopened.stdout.getReader();
        let printed = '';
        while (!/\njob: .*\n$/.test(printed)) {
          const chunk = await reader.read();
          if (chunk.done) break;
          printed += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
        const byGeneration = receipts(dir).filter(receipt => receipt.jobId === v1!.jobId).sort((a, b) => Number(a.generation) - Number(b.generation));
        // The page head is the newest committed version, whatever the hash order; a named --rig ends as the head.
        expect(byGeneration.map(receipt => obj(obj(receipt.result).selector).version)).toEqual(order === 'named --rig 1' ? [1, 2, 1] : [1, 1, 2]);
        // job open names the head it republished and, on its own line, every other pending publication it published.
        const republishedV1 = byGeneration[order === 'named --rig 1' ? 2 : 1]!;
        const publicationLines = printed.match(/\n(job: rig v1 published .*)\n([^\n]+)\n(job: asked .*\n)?$/);
        expect(publicationLines?.slice(1, 3)).toEqual([
          `job: rig v1 published (publication ${republishedV1.publicationId})`,
          'job: pending rig v2 published',
        ]);
        expect(pendingPublications(dir)).toEqual([]);
        expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
        expect(await runCli(dir, 'job', 'reconcile', dir)).toEqual({ exit: 0, stdout: 'job: reconciled 0 publication(s)\n', stderr: '' });
        expect(await runCli(dir, 'job', 'close', dir)).toEqual({ exit: 0, stdout: 'job: closed\n', stderr: '' });
        expect(await reopened.exited).toBe(0);
        expect(await stderr).toBe('');
        expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
        return;
      } finally {
        reopened?.kill(); host.stop();
        rmSync(jobPrivateRoot(dir), { recursive: true, force: true });
        rmSync(jobHostStateRoot(dir), { recursive: true, force: true });
      }
    }
    throw new Error(`#849: no job in 12 put the receipt hashes in the order "${order}"`);
  }, 180_000);

  test.skipIf(process.env.RIG_CREATE_NETWORK !== '1')('registers a planted run with the unmodified lock from init', () => {
    const planted = setup();
    const dir = join(dirname(planted.dir), 'initialized');
    const init = run([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'init', dir], dirname(dir), process.env as Record<string, string>);
    expect(init.code).toBe(0);
    expect(existsSync(join(dir, 'package-lock.json'))).toBe(false);
    // Plant the synthetic pre-registration state and producer artifacts in the initialized project.
    put(dir, 'project.json', planted.load());
    cpSync(join(planted.dir, 'source'), join(dir, 'source'), { recursive: true });
    const runRecord = JSON.parse(readFileSync(join(dir, 'source/run.json'), 'utf8')) as JsonObject;
    obj(runRecord.package).version = PINNED_PACKAGES['@rig-c/core'];
    put(dir, 'source/run.json', runRecord);
    planted.args[1] = dir;
    expect(registerWithBunLock(dir, planted.args).built_with).toEqual({
      '@rig-c/parts': PINNED_PACKAGES['@rig-c/parts'],
      '@rig-c/core': PINNED_PACKAGES['@rig-c/core'],
    });
  }, 30000);

  test.each([
    ['missing', null, 'found no lock'],
    ['unparseable', '{ broken', 'found bun.lock'],
    ['missing integrity', '{"lockfileVersion":2,"workspaces":{},"packages":{"@rig-c/parts":["@rig-c/parts@2.23.4","",{}]}}', 'found bun.lock'],
  ])('%s Bun lock identifies the accepted kinds', (_case, content, found) => {
    const { dir, args } = setup();
    args[args.indexOf('--toolchain-lock') + 1] = 'bun.lock';
    if (content !== null) put(dir, 'bun.lock', content);
    const error = refused(args, 'RIG_TOOLCHAIN_LOCK_INVALID');
    expect(error.message).toContain(found);
    expect(error.message).toContain('npm-lock-v3 (package-lock.json) or bun-lock (bun.lock)');
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
  });

  test.each([
    ['missing idle manifest', 'RIG_IDLE_MANIFEST_MISSING', (dir: string) => rmSync(join(dir, 'source/idle/frames.json'))],
    ['missing lock', 'RIG_TOOLCHAIN_LOCK_INVALID', (dir: string) => rmSync(join(dir, 'source/package-lock.json'))],
    ['wrong lock version', 'RIG_TOOLCHAIN_LOCK_INVALID', (dir: string) => put(dir, 'source/package-lock.json', { lockfileVersion: 2 })],
    ['missing package', 'RIG_TOOLCHAIN_LOCK_INVALID', (dir: string) => put(dir, 'source/package-lock.json', { lockfileVersion: 3, packages: {} })],
    ['missing date record', 'RIG_AT_SOURCE_INVALID', (dir: string) => rmSync(join(dir, 'source/at-source.json'))],
    ['unresolved absolute path', 'RIG_RUNTIME_PATH_UNRESOLVED', (dir: string) => put(dir, 'source/config.json', { requirements: '/foreign/requirements.json' })],
    ['Windows absolute path', 'RIG_RUNTIME_PATH_UNRESOLVED', (dir: string) => put(dir, 'source/config.json', { requirements: 'C:\\foreign\\requirements.json' })],
    ['output symlink', 'RIG_REGISTRATION_PATH_INVALID', (dir: string) => symlinkSync(join(dir, 'source/config.json'), join(dir, 'source/rig/link.json'))],
    ['symlinked directory', 'RIG_REGISTRATION_PATH_INVALID', (dir: string) => { mkdirSync(join(dir, 'source/real-sub')); symlinkSync(join(dir, 'source/real-sub'), join(dir, 'source/rig/linked-sub')); }],
    ['symlinked lock', 'RIG_REGISTRATION_PATH_INVALID', (dir: string) => { renameSync(join(dir, 'source/package-lock.json'), join(dir, 'source/real-lock.json')); symlinkSync(join(dir, 'source/real-lock.json'), join(dir, 'source/package-lock.json')); }],
    ['symlinked date record', 'RIG_REGISTRATION_PATH_INVALID', (dir: string) => { renameSync(join(dir, 'source/at-source.json'), join(dir, 'source/real-at.json')); symlinkSync(join(dir, 'source/real-at.json'), join(dir, 'source/at-source.json')); }],
  ])('%s refuses by code and leaves project byte-identical', (_name, code, mutate) => {
    const { dir, args } = setup();
    mutate(dir);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);
  });

  test('registers external frozen sources under os.tmpdir() while refusing symlinked files and directories inside the source tree', () => {
    const { dir, load } = setup();
    const savedTmp = process.env.TMPDIR;
    if (savedTmp?.startsWith(process.cwd())) delete process.env.TMPDIR;
    const realTmp = os.tmpdir();
    if (savedTmp !== undefined) process.env.TMPDIR = savedTmp;
    const external = mkdtempSync(join(realTmp, 'rig-version-ext-'));
    roots.push(external);
    const src = join(external, 'source');
    renameSync(join(dir, 'source'), src);
    const extArgs = ['1', dir, '--parts', join(src, 'parts'), '--rig', join(src, 'rig'), '--build', join(src, 'build'), '--idle', join(src, 'idle'),
      '--config', join(src, 'config.json'), '--path-adapter', join(src, 'adapter.json'), '--compile-report', join(src, 'compile-report.json'),
      '--toolchain-lock', join(src, 'package-lock.json'), '--run-record', join(src, 'run.json'), '--at-source', join(src, 'at-source.json'), '--at-pointer', '/finished_at', '--by', 'registrant', '--json'];
    const before = readFileSync(join(dir, 'project.json'));

    symlinkSync(join(src, 'config.json'), join(src, 'rig/linked-file.json'));
    refused(extArgs, 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    rmSync(join(src, 'rig/linked-file.json'));

    mkdirSync(join(external, 'real-dir'));
    writeFileSync(join(external, 'real-dir/extra.json'), '{}\n');
    symlinkSync(join(external, 'real-dir'), join(src, 'rig/linked-dir'));
    refused(extArgs, 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    rmSync(join(src, 'rig/linked-dir'));

    symlinkSync(join(external, 'real-dir'), join(src, 'linked-lock-dir'));
    cpSync(join(src, 'package-lock.json'), join(external, 'real-dir/package-lock.json'));
    const lockViaSymlinkDir = [...extArgs];
    lockViaSymlinkDir[lockViaSymlinkDir.indexOf('--toolchain-lock') + 1] = join(src, 'linked-lock-dir/package-lock.json');
    refused(lockViaSymlinkDir, 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    rmSync(join(src, 'linked-lock-dir'));

    expect(rigVersionCommand(extArgs).exit).toBe(0);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test.each(['config-pointer', 'requirements-pointer', 'config-project-pointer', 'legacy-absolute'] as const)('external config root refuses new external relative assets and accepts project-relative or legacy absolute adapters (%s)', mode => {
    const { dir, args, load } = setup();
    const external = realpathSync(mkdtempSync(join(os.tmpdir(), 'rig-version-adapter-external-')));
    roots.push(external);
    const assetBytes = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(external, 'receipt.png'), assetBytes);
    writeFileSync(join(external, 'backdrop.png'), assetBytes);
    const receiptPath = mode === 'config-project-pointer'
      ? relative(external, join(dir, 'source/rig/images/rectangle.png')).split(sep).join('/')
      : mode === 'config-pointer' ? 'receipt.png' : '/runtime/receipt.png';
    put(external, 'config.json', { key: 'synthetic', requirements: '/runtime/requirements.json', assemble: {
      editor_receipts: { receipts: [{ file: receiptPath, sha256: jobHash(assetBytes) }] },
    } });
    put(external, 'requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: {
      required: true,
      ...(mode === 'requirements-pointer' ? { backdrop: { path: 'backdrop.png', sha256: jobHash(assetBytes) } } : {}),
    } });
    const adapter: JsonObject[] = [
      { at: '.requirements', before: join(external, 'requirements.json'), after: '/runtime/requirements.json' },
      mode.startsWith('config-')
        ? { doc: 'config', pointer: '/assemble/editor_receipts/receipts/0/file', before: receiptPath, after: 'inputs/receipt.png' }
        : { at: '.assemble.editor_receipts.receipts.0.file', before: join(external, 'receipt.png'), after: '/runtime/receipt.png' },
    ];
    if (mode === 'requirements-pointer') adapter.push({ doc: 'requirements', pointer: '/setup_painting/backdrop/path', before: 'backdrop.png', after: 'inputs/backdrop.png' });
    put(external, 'adapter.json', adapter);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    const externalArgs = [...args, '--citations', 'source/citations.json'];
    externalArgs[externalArgs.indexOf('--config') + 1] = join(external, 'config.json');
    externalArgs[externalArgs.indexOf('--path-adapter') + 1] = join(external, 'adapter.json');
    const originalConfig = readFileSync(join(external, 'config.json'));
    const originalRequirements = readFileSync(join(external, 'requirements.json'));
    if (mode === 'legacy-absolute' || mode === 'config-project-pointer') {
      expect(rigVersionCommand(externalArgs).exit).toBe(0);
      expect(rigRegistrationFindings(dir, load())).toEqual([]);
      expect(checkProject(dir).refusals).toEqual([]);
      const registration = obj((load().versions as JsonObject[])[0]!.registration);
      if (mode === 'legacy-absolute') expect(obj(registration.path_adapter).format).toBeUndefined();
      else expect(obj(registration.path_adapter).format).toBe('json-pointer/1');
      const retainedReceipt = mode === 'legacy-absolute' ? 'inputs/assemble/editor_receipts/receipts/0/file' : 'inputs/receipt.png';
      expect(readFileSync(join(dir, 'evidence/v1/registration', retainedReceipt))).toEqual(assetBytes);
    } else {
      refused(externalArgs, 'RIG_REGISTRATION_PATH_INVALID');
      for (const target of ['outputs/v1', 'evidence/v1/registration', 'derived/review/v1']) expect(existsSync(join(dir, target))).toBe(false);
    }
    expect(readFileSync(join(external, 'config.json'))).toEqual(originalConfig);
    expect(readFileSync(join(external, 'requirements.json'))).toEqual(originalRequirements);
    expect(readFileSync(join(external, 'receipt.png'))).toEqual(assetBytes);
    expect(readFileSync(join(external, 'backdrop.png'))).toEqual(assetBytes);
  });

  test('system temp aliases retain project-contained config and requirements inputs', () => {
    const { dir, args, load } = setup();
    const aliasRoot = mkdtempSync(join(realpathSync(os.tmpdir()), 'rig-version-system-alias-'));
    roots.push(aliasRoot);
    mkdirSync(join(aliasRoot, 'real'));
    symlinkSync(join(aliasRoot, 'real'), join(aliasRoot, 'alias'), 'dir');
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = join(aliasRoot, 'alias');
    try {
    const external = mkdtempSync(join(os.tmpdir(), 'external-'));
    roots.push(external);
    const maskBytes = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(dir, 'mask.png'), maskBytes);
    put(dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: {
      required: true, figure_mask: { path: '../mask.png', sha256: jobHash(maskBytes) },
    } });
    const originalReceipt = relative(external, join(dir, 'source/rig/images/rectangle.png')).split(sep).join('/');
    put(external, 'config.json', { key: 'synthetic', requirements: '/runtime/requirements.json', assemble: {
      editor_receipts: { receipts: [{ file: originalReceipt, sha256: jobHash(maskBytes) }] },
    } });
    put(external, 'adapter.json', [
      { at: '.requirements', before: join(dir, 'source/requirements.json'), after: '/runtime/requirements.json' },
      { doc: 'config', pointer: '/assemble/editor_receipts/receipts/0/file', before: originalReceipt, after: 'inputs/receipt.png' },
    ]);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    const aliasedArgs = [...args, '--citations', 'source/citations.json'];
    aliasedArgs[aliasedArgs.indexOf('--config') + 1] = join(external, 'config.json');
    aliasedArgs[aliasedArgs.indexOf('--path-adapter') + 1] = join(external, 'adapter.json');
    const originalConfig = readFileSync(join(external, 'config.json'));
    const originalRequirements = readFileSync(join(dir, 'source/requirements.json'));
    expect(rigVersionCommand(aliasedArgs).exit).toBe(0);
    const project = load();
    const registration = obj((project.versions as JsonObject[])[0]!.registration);
    expect(obj(registration.requirements_source).source_path).toBe('source/requirements.json');
    expect(readFileSync(join(dir, 'evidence/v1/registration/inputs/receipt.png'))).toEqual(maskBytes);
    expect(readFileSync(join(external, 'config.json'))).toEqual(originalConfig);
    expect(readFileSync(join(dir, 'source/requirements.json'))).toEqual(originalRequirements);
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  test('legacy absolute adapter rows on relative values remain unused declarations', () => {
    const { dir, args, load } = setup();
    const config = { key: 'synthetic', requirements: 'requirements.json', assemble: {
      editor_receipts: { receipts: [{ file: 'rig/images/rectangle.png' }] },
    } };
    const adapter = [
      { at: '.requirements', before: join(dir, 'unused-requirements.json'), after: 'requirements.json' },
      { at: '.assemble.editor_receipts.receipts.0.file', before: join(dir, 'unused-receipt.png'), after: 'rig/images/rectangle.png' },
    ];
    put(dir, 'source/config.json', config);
    put(dir, 'source/adapter.json', adapter);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    expect(rigVersionCommand([...args, '--citations', 'source/citations.json']).exit).toBe(0);
    const project = load();
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
    const runtime = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/config.json'), 'utf8')) as JsonObject;
    expect(runtime.requirements).toBe('requirements.json');
    expect(((obj(obj(runtime.assemble).editor_receipts).receipts as JsonObject[])[0]!).file).toBe('inputs/assemble/editor_receipts/receipts/0/file');
    const retainedRows = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'), 'utf8')) as JsonObject[];
    expect(retainedRows.slice(0, 2)).toEqual(adapter);
    expect(retainedRows[2]!.doc).toBe('config');
  });

  const sharingCases: { name: string; occluders: JsonObject[]; adapter: JsonObject[] }[] = [
    {
      name: 'image inside its plate directory',
      occluders: [{ image: 'inputs/plate/plate.png', plate: 'inputs/plate' }],
      adapter: [],
    },
    {
      name: 'repeated image',
      occluders: [{ image: 'inputs/plate/plate.png' }, { image: 'inputs/plate/plate.png' }],
      adapter: [],
    },
    {
      name: 'pointer image inside its plate directory',
      occluders: [{ image: 'inputs/plate/plate.png', plate: 'inputs/plate' }],
      adapter: [
        { doc: 'config', pointer: '/assemble/occluders/0/image', before: 'inputs/plate/plate.png', after: 'runtime/plate/plate.png' },
        { doc: 'config', pointer: '/assemble/occluders/0/plate', before: 'inputs/plate', after: 'runtime/plate' },
      ],
    },
    {
      name: 'pointer shared image target',
      occluders: [{ image: 'inputs/plate/plate.png' }, { image: 'inputs/other.png' }],
      adapter: [
        { doc: 'config', pointer: '/assemble/occluders/0/image', before: 'inputs/plate/plate.png', after: 'runtime/shared.png' },
        { doc: 'config', pointer: '/assemble/occluders/1/image', before: 'inputs/other.png', after: 'runtime/shared.png' },
      ],
    },
    {
      name: 'pointer shared requirements target',
      occluders: [{ image: 'inputs/plate/plate.png' }],
      adapter: [
        { doc: 'requirements', pointer: '/setup_painting/figure_mask/path', before: 'inputs/plate/plate.png', after: 'runtime/shared.png' },
        { doc: 'requirements', pointer: '/setup_painting/backdrop/path', before: 'inputs/other.png', after: 'runtime/shared.png' },
      ],
    },
  ];
  test.each(sharingCases)('registration shares byte-identical assets for $name', scenario => {
    const { dir, args, load, imageBytes, receiptBytes } = setupSharedAssets();
    put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: { occluders: scenario.occluders } });
    put(dir, 'source/adapter.json', scenario.adapter);
    if (scenario.name === 'pointer shared requirements target') {
      put(dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: {
        required: true,
        figure_mask: { path: 'inputs/plate/plate.png', sha256: jobHash(imageBytes) },
        backdrop: { path: 'inputs/other.png', sha256: jobHash(imageBytes) },
      } });
    }
    const originalConfig = readFileSync(join(dir, 'source/config.json'));
    const originalRequirements = readFileSync(join(dir, 'source/requirements.json'));
    expect(rigVersionCommand(args).exit).toBe(0);
    const project = load();
    const version = (project.versions as JsonObject[])[0]!;
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
    const runtime = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/config.json'), 'utf8')) as JsonObject;
    for (const entry of obj(runtime.assemble).occluders as JsonObject[]) {
      expect(readFileSync(join(dir, 'evidence/v1/registration', String(entry.image)))).toEqual(imageBytes);
      expect(readFileSync(join(dir, 'derived/review/v1', String(entry.image)))).toEqual(imageBytes);
      if (typeof entry.plate === 'string') {
        expect(readFileSync(join(dir, 'derived/review/v1', entry.plate, 'receipt.json'), 'utf8')).toBe(receiptBytes);
        expect(existsSync(join(dir, 'derived/review/v1', entry.plate, 'mask.png'))).toBe(false);
      }
    }
    const inventory = obj(version.registration).files as JsonObject[];
    expect(new Set(inventory.map(file => file.path)).size).toBe(inventory.length);
    expect(readFileSync(join(dir, 'source/config.json'))).toEqual(originalConfig);
    expect(readFileSync(join(dir, 'source/requirements.json'))).toEqual(originalRequirements);
    const beforePackage = version.review_package;
    rmSync(join(dir, 'derived/review/v1'), { recursive: true });
    expect(reviewPackageCommand(['1', dir, '--config', 'evidence/v1/registration/config.json', '--from', 'outputs/v1/out']).exit).toBe(0);
    expect((load().versions as JsonObject[])[0]!.review_package).toEqual(beforePackage);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test.each([
    {
      name: 'different file bytes', firstSource: 'inputs/plate/plate.png', firstTarget: 'runtime/shared.png',
      secondSource: 'inputs/different.png', secondTarget: 'runtime/shared.png', secondKind: 'image',
    },
    {
      name: 'different bytes inside a copied directory', firstSource: 'inputs/different.png', firstTarget: 'runtime/plate/plate.png',
      secondSource: 'inputs/plate', secondTarget: 'runtime/plate', secondKind: 'plate',
    },
    {
      name: 'file replacing a directory', firstSource: 'inputs/plate/plate.png', firstTarget: 'runtime/shared/child.png',
      secondSource: 'inputs/other.png', secondTarget: 'runtime/shared', secondKind: 'image',
    },
    {
      name: 'file used as a parent directory', firstSource: 'inputs/plate/plate.png', firstTarget: 'runtime/shared',
      secondSource: 'inputs/other.png', secondTarget: 'runtime/shared/child.png', secondKind: 'image',
    },
    {
      name: 'directory replacing a file', firstSource: 'inputs/plate/plate.png', firstTarget: 'runtime/shared',
      secondSource: 'inputs/plate', secondTarget: 'runtime/shared', secondKind: 'plate',
    },
    {
      name: 'reserved metadata parent', firstSource: 'inputs/plate/plate.png', firstTarget: 'config-source.json/child.png',
      secondSource: 'inputs/other.png', secondTarget: 'runtime/shared.png', secondKind: 'image',
    },
  ])('registration refuses incompatible asset sharing for $name', scenario => {
    const { dir, args } = setupSharedAssets();
    put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: { occluders: [
      { image: scenario.firstSource }, { [scenario.secondKind]: scenario.secondSource },
    ] } });
    put(dir, 'source/adapter.json', [
      { doc: 'config', pointer: '/assemble/occluders/0/image', before: scenario.firstSource, after: scenario.firstTarget },
      { doc: 'config', pointer: `/assemble/occluders/1/${scenario.secondKind}`, before: scenario.secondSource, after: scenario.secondTarget },
    ]);
    refused(args, 'RIG_REGISTRATION_PATH_INVALID');
    for (const target of ['outputs/v1', 'evidence/v1/registration', 'derived/review/v1']) expect(existsSync(join(dir, target))).toBe(false);
  });

  test('strict shared-target checking rejects a plate rebound to a retained file', () => {
    const { dir, args, load } = setupSharedAssets();
    put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: {
      occluders: [{ image: 'inputs/plate/plate.png', plate: 'inputs/plate' }],
    } });
    put(dir, 'source/adapter.json', [
      { doc: 'config', pointer: '/assemble/occluders/0/image', before: 'inputs/plate/plate.png', after: 'runtime/plate/plate.png' },
      { doc: 'config', pointer: '/assemble/occluders/0/plate', before: 'inputs/plate', after: 'runtime/plate' },
    ]);
    expect(rigVersionCommand(args).exit).toBe(0);
    const candidate = load();
    const version = (candidate.versions as JsonObject[])[0]!;
    const registration = obj(version.registration);
    const saved = new Map<string, Buffer>();
    const replaceRetained = (binding: JsonObject, raw: unknown): void => {
      const path = String(binding.path);
      saved.set(path, readFileSync(join(dir, path)));
      const bytes = Buffer.from(`${JSON.stringify(raw)}\n`);
      writeFileSync(join(dir, path), bytes);
      binding.sha256 = jobHash(bytes);
      binding.bytes = bytes.length;
      for (const file of registration.files as JsonObject[]) if (file.path === path) file.sha256 = binding.sha256;
    };
    try {
      const configBinding = obj(obj(version.provenance).config);
      const runtime = JSON.parse(readFileSync(join(dir, String(configBinding.path)), 'utf8')) as JsonObject;
      ((obj(runtime.assemble).occluders as JsonObject[])[0]!).plate = 'runtime/plate/plate.png';
      replaceRetained(configBinding, runtime);
      const adapterBinding = obj(registration.path_adapter);
      const rows = JSON.parse(readFileSync(join(dir, String(adapterBinding.path)), 'utf8')) as JsonObject[];
      rows[1]!.after = 'runtime/plate/plate.png';
      replaceRetained(adapterBinding, rows);
      expect(rigRegistrationFindings(dir, candidate).map(finding => finding.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
    } finally {
      for (const [path, bytes] of saved) writeFileSync(join(dir, path), bytes);
    }
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test.each(['pending 1', '2026-02-30T00:00:00Z', '2026-11-06', '2026-11-06T20:44:42', '2026-11-06T20:44:42+09:00', '2026-11-06T24:00:00Z'])('refuses invalid/non-UTC date %s', at => {
    const { dir, args } = setup();
    put(dir, 'source/at-source.json', { finished_at: at });
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'RIG_AT_SOURCE_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('resolves an exact adapter and copies relative named inputs into the retained config directory', () => {
    const { dir, args, load } = setup();
    put(dir, 'source/requirements.json', { setup_painting: { required: true } });
    put(dir, 'source/config.json', { key: 'synthetic', requirements: '/runtime/requirements.json' });
    put(dir, 'source/adapter.json', [{ at: '.requirements', before: join(dir, 'source/requirements.json'), after: '/runtime/requirements.json' }]);
    rigVersionCommand(args);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    const version = (load().versions as JsonObject[])[0]!;
    const config = JSON.parse(readFileSync(join(dir, String(obj(obj(version.provenance).config).path)), 'utf8'));
    expect(config.requirements).toBe('inputs/requirements');
    expect(readFileSync(join(dir, 'derived/review/v1/inputs/requirements'), 'utf8')).toBe('{"setup_painting":{"required":true}}\n');
  });

  test.each(['built_with', 'at_source', 'outputs', 'config_source', 'copied', 'added-frame'])('check observes planted %s drift through the shared validator', field => {
    const { dir, args, load } = setup();
    rigVersionCommand(args);
    const project = load();
    const version = (project.versions as JsonObject[])[0]!;
    if (field === 'built_with') obj(version.built_with)['@rig-c/core'] = '0.0.0';
    if (field === 'at_source') obj(version.at_source).pointer = '/missing';
    if (field === 'outputs') writeFileSync(join(dir, 'outputs/v1/idle/idle@4fps/f0000.png'), 'changed bytes');
    if (field === 'config_source') obj(obj(version.registration).config_source).sha256 = 'a'.repeat(64);
    if (field === 'copied') obj(obj(version.registration).copied).files = 1;
    if (field === 'added-frame') writeFileSync(join(dir, 'outputs/v1/idle/idle@4fps/f9999.png'), 'new frame');
    const code = field === 'built_with' ? 'RIG_TOOLCHAIN_MISMATCH' : field === 'at_source' ? 'RIG_AT_SOURCE_INVALID' : 'RIG_REGISTRATION_FILE_INVALID';
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain(code);
    expect(checkProject(dir, project).refusals.map(f => f.code)).toContain(code);
  });

  test('a reopen before registration refuses the cited old bound, but a later reopen preserves history', () => {
    const { dir, args, load } = setup();
    const project = load();
    project.reopens = [{ stage: 'interview', from_stage: 'rig-review', by: 'user', at: '2026-11-07T07:47:00Z', verbatim: 'Reopen', steps_before: [] }];
    put(dir, 'project.json', project);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'RIG_BUILD_BEFORE_REOPEN');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    project.reopens = [];
    put(dir, 'project.json', project);
    rigVersionCommand(args);
    const registered = load();
    registered.reopens = [{ stage: 'interview', from_stage: 'rig-review', by: 'user', at: '2099-01-01T00:00:00Z', verbatim: 'Reopen later', steps_before: [],
      source: 'owner chat, relayed', said_at: '2099-01-01T00:00:00Z', relayed_by: 'synthetic-relay' }];
    expect(rigRegistrationFindings(dir, registered)).toEqual([]);
  });

  test('missing producer files and invalid compile spec roll back the copied package and version', () => {
    const { dir, args } = setup();
    put(dir, 'source/compile-report.json', { spec: 'unknown', gates: [] });
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'RIG_REGISTRATION_FILE_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
  });

  test('a declared built_with disagreement is RED before another registration writes', () => {
    const { dir, args, load } = setup();
    rigVersionCommand(args);
    const project = load();
    obj((project.versions as JsonObject[])[0]!.built_with)['@rig-c/core'] = '0.0.0';
    put(dir, 'project.json', project);
    const before = readFileSync(join(dir, 'project.json'));
    refused(['2', ...args.slice(1)], 'RIG_TOOLCHAIN_MISMATCH');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v2'))).toBe(false);
  });

  test('accepts explicitly cited UTC microseconds and an escaped JSON pointer', () => {
    const { dir, args, load } = setup();
    put(dir, 'source/at-source.json', { 'event/date': { '~at': '2026-11-06T20:44:42.081669+00:00' } });
    args[args.indexOf('--at-pointer') + 1] = '/event~1date/~0at';
    rigVersionCommand(args);
    expect((load().versions as JsonObject[])[0]!.at).toBe('2026-11-06T20:44:42.081669+00:00');
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test('copies and binds a requirements-relative figure mask with its existing producer hash', () => {
    const { dir, args, load } = setup();
    const mask = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    const hash = new Bun.CryptoHasher('sha256').update(mask).digest('hex');
    put(dir, 'source/requirements.json', { setup_painting: { required: true, figure_mask: { path: 'mask.png', sha256: hash } } });
    writeFileSync(join(dir, 'source/mask.png'), mask);
    rigVersionCommand(args);
    expect(readFileSync(join(dir, 'derived/review/v1/mask.png'))).toEqual(mask);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test('relative donor directories and editor files survive package regeneration', () => {
    const { dir, args, load } = setup();
    put(dir, 'source/donor/layers.json', { layers: [] });
    put(dir, 'source/donor/source.png', 'synthetic source input');
    put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json', assemble: {
      take: [{ run: 'full', tags: ['piece'], run_dir: 'donor', st_input: 'donor/source.png' }],
      editor_receipts: { receipts: [{ file: 'donor/source.png' }] },
    } });
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    rigVersionCommand([...args, '--citations', 'source/citations.json']);
    const version = (load().versions as JsonObject[])[0]!;
    const before = version.review_package;
    expect(readFileSync(join(dir, 'derived/review/v1/inputs/assemble/take/0/run_dir/layers.json'), 'utf8')).toBe('{"layers":[]}\n');
    rmSync(join(dir, 'derived/review/v1'), { recursive: true });
    reviewPackageCommand(['1', dir, '--config', String(obj(obj(version.provenance).config).path), '--from', 'outputs/v1/out']);
    expect((load().versions as JsonObject[])[0]!.review_package).toEqual(before);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test.each(['rig/rig.json', 'rig/motion.json', 'build/skeleton.model.json'])('refuses unsupported producer spec in %s before recording', path => {
    const { dir, args } = setup();
    const source = JSON.parse(readFileSync(join(dir, 'source', path), 'utf8'));
    source.spec = 'unsupported/1';
    put(dir, `source/${path}`, source);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'RIG_REGISTRATION_FILE_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
  });

  test.each([
    ['an uncited config section', 'SECTION_UNCITED', { key: 'synthetic', requirements: 'requirements.json', bones: {} }, null],
    ['a misspelt cited section', 'SECTION_UNKNOWN', { key: 'synthetic', requirements: 'requirements.json' }, { bonez: [] }],
  ])('the full check refuses %s before recording', (_name, code, config, citations) => {
    const { dir, args } = setup();
    put(dir, 'source/config.json', config);
    if (citations) { put(dir, 'source/citations.json', citations); args.push('--citations', 'source/citations.json'); }
    expect(checkProject(dir).refusals).toEqual([]);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);
  });

  test('a pre-existing unrelated refusal does not block a valid registration', () => {
    const { dir, args, load } = setup();
    const project = load();
    // An input inventory that is not a list; registration never touches inputs.
    project.inputs = 'not-a-list';
    put(dir, 'project.json', project);
    const planted = checkProject(dir).refusals.map(f => `${f.code} ${f.path}`);
    expect(planted).toEqual(['INPUTS_INVALID inputs']);
    rigVersionCommand(args);
    expect((load().versions as JsonObject[]).length).toBe(1);
    expect(checkProject(dir).refusals.map(f => `${f.code} ${f.path}`)).toEqual(planted);
  });

  test('a record whose stage check stopped early is no baseline: registration is refused', () => {
    const { dir, args, load } = setup();
    const project = load();
    project.stage = 'no-such-stage';
    put(dir, 'project.json', project);
    expect(checkProject(dir).refusals.map(f => f.code)).toEqual(['STAGE_UNKNOWN']);
    const before = readFileSync(join(dir, 'project.json'));
    refused(args, 'STAGE_UNKNOWN');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);
  });

  test('admits n > maxRegistered when every intermediate K has an occupied unregistered destination and binds registration.skipped', () => {
    const { dir, args, load } = setup();
    put(dir, 'outputs/v1/legacy.txt', 'occupied v1 output\n');
    put(dir, 'evidence/v2/registration/note.txt', 'occupied v2 registration\n');
    put(dir, 'derived/review/v2/index.html', '<html>v2</html>\n');
    mkdirSync(join(dir, 'derived/review/v3'), { recursive: true });

    const v4Args = ['4', ...args.slice(1)];
    rigVersionCommand(v4Args);

    const projectAfterV4 = load();
    const v4 = (projectAfterV4.versions as JsonObject[])[0]!;
    expect(v4.n).toBe(4);
    const reg4 = obj(v4.registration);
    expect(reg4.skipped).toEqual([
      { n: 1, destinations: ['outputs/v1'] },
      { n: 2, destinations: ['evidence/v2/registration', 'derived/review/v2'] },
      { n: 3, destinations: ['derived/review/v3'] },
    ]);
    expect(rigRegistrationFindings(dir, projectAfterV4)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);

    // Next contiguous registration (v5) needs no skipped entry.
    rigVersionCommand(['5', ...args.slice(1)]);
    const projectAfterV5 = load();
    const v5 = (projectAfterV5.versions as JsonObject[])[1]!;
    expect(v5.n).toBe(5);
    expect(obj(v5.registration).skipped).toBeUndefined();
    expect(rigRegistrationFindings(dir, projectAfterV5)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test('refuses occupied destination on n itself, unexplained gaps, <= maxRegistered, and non-directory/symlinked skipped paths without touching project.json', () => {
    const { dir, args } = setup();
    put(dir, 'outputs/v1/legacy.txt', 'occupied v1\n');

    // Unexplained gap at v2 when requesting v3 (v1 occupied, v2 empty)
    const beforeGap = readFileSync(join(dir, 'project.json'));
    refused(['3', ...args.slice(1)], 'RIG_REGISTRATION_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeGap);
    expect(existsSync(join(dir, 'outputs/v3'))).toBe(false);

    // Requesting v2 when v2 itself has an occupied destination (evidence/v2/registration or derived/review/v2)
    put(dir, 'derived/review/v2/existing.txt', 'occupied target\n');
    const beforeTargetOccupied = readFileSync(join(dir, 'project.json'));
    refused(['2', ...args.slice(1)], 'RIG_REGISTRATION_EXISTS');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeTargetOccupied);
    expect(readFileSync(join(dir, 'derived/review/v2/existing.txt'), 'utf8')).toBe('occupied target\n');
    rmSync(join(dir, 'derived/review/v2'), { recursive: true });

    // Non-directory file or symlink at skipped destination refuses with RIG_REGISTRATION_PATH_INVALID
    rmSync(join(dir, 'outputs/v1'), { recursive: true });
    put(dir, 'outputs/v1', 'regular file instead of directory');
    const beforeFileDest = readFileSync(join(dir, 'project.json'));
    refused(['2', ...args.slice(1)], 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeFileDest);
    rmSync(join(dir, 'outputs/v1'));

    mkdirSync(join(dir, 'source/real-v1'), { recursive: true });
    symlinkSync(join(dir, 'source/real-v1'), join(dir, 'outputs/v1'));
    const beforeSymlinkDest = readFileSync(join(dir, 'project.json'));
    refused(['2', ...args.slice(1)], 'RIG_REGISTRATION_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeSymlinkDest);
    rmSync(join(dir, 'outputs/v1'));

    // Register v2 cleanly with v1 occupied by a real directory, then refuse n <= maxRegistered (v1 skipped, v2 registered)
    put(dir, 'outputs/v1/legacy.txt', 'occupied v1\n');
    rigVersionCommand(['2', ...args.slice(1)]);
    const afterV2 = readFileSync(join(dir, 'project.json'));
    refused(['1', ...args.slice(1)], 'RIG_REGISTRATION_INVALID');
    // Retrying the registered number names that version (create#844), not the numbering rule.
    expect(refused(['2', ...args.slice(1)], 'RIG_VERSION_ALREADY_REGISTERED').message).toContain('no publication of it is pending');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(afterV2);

    // Malformed existing versions entries (string n or non-object) refuse with RIG_REGISTRATION_INVALID and leave project.json byte-identical
    for (const malformed of [[{ n: '1' }], [null]]) {
      const broken = JSON.parse(afterV2.toString('utf8')) as JsonObject;
      broken.versions = malformed as unknown as JsonObject[];
      put(dir, 'project.json', broken);
      const beforeMalformed = readFileSync(join(dir, 'project.json'));
      refused(['3', ...args.slice(1)], 'RIG_REGISTRATION_INVALID');
      expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeMalformed);
    }
  });

  test('validates registration.skipped receipt shape, remains valid after historical archival, and roundtrips through record publication retained root', () => {
    const { dir, args, load } = setup();
    const painting = Buffer.from('Synthetic immutable painting input');
    put(dir, 'inputs/painting.png', painting.toString('utf8'));
    const initial = load();
    initial.inputs = [{ ...(initial.inputs as JsonObject[])[0], path: 'inputs/painting.png', sha256: jobHash(painting), bytes: painting.length }];
    put(dir, 'project.json', initial);
    // Empty historical skipped directory: no files inside outputs/v1.
    mkdirSync(join(dir, 'outputs/v1'), { recursive: true });
    rigVersionCommand(['2', ...args.slice(1)]);

    // 1. Registration -> record publication inventory (while empty outputs/v1 exists in dir) -> retained root (copying only sealed files, without fabricating outputs/v1).
    const root = realpathSync(dir);
    const record = { path: 'project.json' as const, sha256: jobHash(readFileSync(join(root, 'project.json'))) };
    const inventory = readRecordPublished({ root, record, result: { kind: 'plan' }, phase: 'inventory' }, testClock.now());
    const retainedRoot = join(realpathSync(dirname(dir)), 'retained');
    mkdirSync(retainedRoot);
    for (const file of inventory.files) {
      mkdirSync(dirname(join(retainedRoot, file.path)), { recursive: true });
      cpSync(join(root, file.path), join(retainedRoot, file.path));
    }
    expect(existsSync(join(root, 'outputs/v1'))).toBe(true);
    expect(existsSync(join(retainedRoot, 'outputs/v1'))).toBe(false);
    // Producer integrity is checked at the live boundary, not on the record-only snapshot.
    expect(checkProject(root).refusals).toEqual([]);
    expect(checkRecordProject(retainedRoot, undefined, { now: testClock.now(), readOnly: true, recordPublication: true }).refusals).toEqual([]);
    expect(readRecordPublished({
      root: retainedRoot,
      record,
      result: { kind: 'plan' },
      phase: 'retained',
      parts: inventory.parts,
    }, testClock.now())).toEqual(inventory);

    // 2. Receipt remains valid in the live root after the historical unregistered directory is archived/removed from disk.
    rmSync(join(dir, 'outputs/v1'), { recursive: true });
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);

    // 3. Receipt shape invalid cases in rigRegistrationFindings and checkProject.
    for (const badSkipped of [
      undefined,
      [],
      [{ n: 2, destinations: ['outputs/v2'] }],
      [{ n: 1, destinations: [] }],
      [{ n: 1, destinations: ['outputs/v99'] }],
      [{ n: 1, destinations: ['derived/review/v1', 'outputs/v1'] }],
      [{ n: 1, destinations: ['outputs/v1', 'outputs/v1'] }],
      [{ n: 1, destinations: ['outputs/v1'], extra: true }],
    ]) {
      const candidate = load();
      const reg = obj((candidate.versions as JsonObject[])[0]!.registration);
      if (badSkipped === undefined) delete reg.skipped;
      else reg.skipped = badSkipped as unknown as JsonObject[];
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_INVALID');
      expect(checkProject(dir, candidate).refusals.map(f => f.code)).toContain('RIG_REGISTRATION_INVALID');
    }

    // 4. Supplying registration.skipped when no version gap exists refuses with RIG_REGISTRATION_INVALID.
    const { dir: dirNoSkip, args: argsNoSkip, load: loadNoSkip } = setup();
    rigVersionCommand(argsNoSkip);
    const unexpectedSkipped = loadNoSkip();
    obj((unexpectedSkipped.versions as JsonObject[])[0]!.registration).skipped = [{ n: 1, destinations: ['outputs/v1'] }];
    expect(rigRegistrationFindings(dirNoSkip, unexpectedSkipped).map(f => f.code)).toContain('RIG_REGISTRATION_INVALID');
  });

  test('retains original config/requirements and relative assets byte-identical, adapts runtime package paths, regenerates review-package, and roundtrips record publication', () => {
    const setupRelativeAssets = (explicitAdapter: boolean, literalMask: boolean) => {
      const { dir, load } = setup();
      const paintingBytes = Buffer.from('Synthetic painting input bytes');
      const backdropBytes = Buffer.from('Synthetic backdrop input bytes');
      const maskBytes = Buffer.from('Synthetic figure mask PNG bytes');
      const receiptBytes = [
        Buffer.from('Synthetic receipt author:hand_r.png'),
        Buffer.from('Synthetic receipt author:hand_l.png'),
        Buffer.from('Synthetic receipt handwear-r.png'),
        Buffer.from('Synthetic receipt handwear-l.png'),
      ];
      writeFileSync(join(dir, 'inputs/painting.png'), paintingBytes);
      writeFileSync(join(dir, 'inputs/background.png'), backdropBytes);
      const originalMaskPath = literalMask ? 'evidence/v1/figure_mask.png' : 'evidence/figure-mask/figure_mask.png';
      mkdirSync(dirname(join(dir, originalMaskPath)), { recursive: true });
      writeFileSync(join(dir, originalMaskPath), maskBytes);
      mkdirSync(join(dir, 'derived/v0/layers/full/parts'), { recursive: true });
      const receiptNames = ['author:hand_r.png', 'author:hand_l.png', 'handwear-r.png', 'handwear-l.png'];
      for (const [i, name] of receiptNames.entries()) {
        writeFileSync(join(dir, 'derived/v0/layers/full/parts', name), receiptBytes[i]!);
      }

      const initial = load();
      const guide = obj(waypoint(initial, 'assemble').guide);
      obj(guide.value).ground = 'busy';
      arr(guide.asks).push({ id: 'ground', state: 'user' });
      const baseInput = (initial.inputs as JsonObject[])[0]!;
      initial.inputs = [
        { ...baseInput, path: 'inputs/painting.png', sha256: jobHash(paintingBytes), bytes: paintingBytes.length },
        { ...baseInput, path: 'inputs/background.png', sha256: jobHash(backdropBytes), bytes: backdropBytes.length },
      ];
      initial.derived = [{
        path: originalMaskPath,
        kind: 'prepared-input',
        sha256: jobHash(maskBytes),
        bytes: maskBytes.length,
        at: '2026-11-06T20:00:00Z',
        tool: 'birefnet',
        operation: 'birefnet-general: alpha >= 128; foreground subtracted: none',
        source: { path: 'inputs/painting.png', sha256: jobHash(paintingBytes) },
      }];
      put(dir, 'project.json', initial);

      const originalConfig: JsonObject = {
        key: 'synthetic',
        requirements: 'requirements.json',
        assemble: {
          project: 'visible',
          ground: 'busy',
          editor_receipts: {
            trace_parts: true,
            receipts: receiptNames.map((name, i) => ({
              part: name.replace('.png', ''),
              file: `../../derived/v0/layers/full/parts/${name}`,
              sha256: jobHash(receiptBytes[i]!),
            })),
          },
        },
      };
      const originalRequirements: JsonObject = {
        spec: 'spine-parts-requirements/1',
        fps: 24,
        requirements: [],
        setup_painting: {
          required: true,
          figure_mask: { path: literalMask ? 'figure_mask.png' : '../figure-mask/figure_mask.png', sha256: jobHash(maskBytes) },
          backdrop: { path: '../../inputs/background.png', sha256: jobHash(backdropBytes) },
        },
        seam_over_motion: { required: true },
        boundary_colour: { max_step_excess: 12 },
      };
      put(dir, 'evidence/v1/config.json', originalConfig);
      put(dir, 'evidence/v1/requirements.json', originalRequirements);
      put(dir, 'evidence/v1/citations.json', {
        assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis', 'ground'] }],
      });
      put(dir, 'source/compile-report.json', {
        spec: 'build-report/1',
        command: 'build',
        gates: [
          { gate: 'seam_over_motion', failures: [], checked: 4 },
          { gate: 'boundary_colour', failures: [], worst_step_excess: 4.5 },
        ],
      });
      const adapterEntries = explicitAdapter ? [
        ...receiptNames.map((name, i) => ({
          doc: 'config',
          pointer: `/assemble/editor_receipts/receipts/${i}/file`,
          before: `../../derived/v0/layers/full/parts/${name}`,
          after: `inputs/editor_receipts/${i}.png`,
        })),
        {
          doc: 'requirements',
          pointer: '/setup_painting/figure_mask/path',
          before: '../figure-mask/figure_mask.png',
          after: 'inputs/setup_painting/figure_mask.png',
        },
        {
          doc: 'requirements',
          pointer: '/setup_painting/backdrop/path',
          before: '../../inputs/background.png',
          after: 'inputs/setup_painting/backdrop.png',
        },
      ] : [];
      put(dir, 'evidence/v1/adapter.json', adapterEntries);
      const v1Args = [
        '1', dir,
        '--parts', 'source/parts',
        '--rig', 'source/rig',
        '--build', 'source/build',
        '--idle', 'source/idle',
        '--config', 'evidence/v1/config.json',
        '--path-adapter', 'evidence/v1/adapter.json',
        '--compile-report', 'source/compile-report.json',
        '--toolchain-lock', 'source/package-lock.json',
        '--run-record', 'source/run.json',
        '--at-source', 'source/at-source.json',
        '--at-pointer', '/finished_at',
        '--citations', 'evidence/v1/citations.json',
        '--by', 'registrant',
        '--json',
      ];
      return { dir, v1Args, load, maskBytes, backdropBytes, receiptBytes, receiptNames, originalMaskPath };
    };

    for (const [explicitAdapter, literalMask] of [[true, false], [false, false], [false, true]] as const) {
      const { dir, v1Args, load, maskBytes, backdropBytes, receiptBytes, receiptNames, originalMaskPath } = setupRelativeAssets(explicitAdapter, literalMask);
      const origConfigBytes = readFileSync(join(dir, 'evidence/v1/config.json'));
      const origReqBytes = readFileSync(join(dir, 'evidence/v1/requirements.json'));

      expect(rigVersionCommand(v1Args).exit).toBe(0);

      // 1. Original config and requirements are retained byte-identical.
      expect(readFileSync(join(dir, 'evidence/v1/registration/config-source.json'))).toEqual(origConfigBytes);
      expect(readFileSync(join(dir, 'evidence/v1/registration/requirements-source.json'))).toEqual(origReqBytes);

      const project = load();
      const version = (project.versions as JsonObject[])[0]!;
      const reg = obj(version.registration);
      expect(obj(reg.config_source).sha256).toBe(jobHash(origConfigBytes));
      expect(obj(reg.requirements_source).sha256).toBe(jobHash(origReqBytes));
      expect(obj(reg.requirements_source).source_path).toBe('evidence/v1/requirements.json');
      expect(obj(reg.requirements).path).toBe('evidence/v1/registration/requirements.json');

      // 2. Runtime config and requirements in evidence and review package match each other and have literal paths.
      const runtimeConfig = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/config.json'), 'utf8')) as JsonObject;
      const pkgConfig = JSON.parse(readFileSync(join(dir, 'derived/review/v1/config.json'), 'utf8')) as JsonObject;
      expect(pkgConfig).toEqual(runtimeConfig);

      const runtimeReq = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/requirements.json'), 'utf8')) as JsonObject;
      const pkgReq = JSON.parse(readFileSync(join(dir, 'derived/review/v1/requirements.json'), 'utf8')) as JsonObject;
      expect(pkgReq).toEqual(runtimeReq);

      const maskAfter = literalMask ? 'figure_mask.png' : explicitAdapter ? 'inputs/setup_painting/figure_mask.png' : 'inputs/setup_painting/figure_mask/path';
      const backdropAfter = explicitAdapter ? 'inputs/setup_painting/backdrop.png' : 'inputs/setup_painting/backdrop/path';
      expect(obj(obj(runtimeReq.setup_painting).figure_mask).path).toBe(maskAfter);
      expect(obj(obj(runtimeReq.setup_painting).figure_mask).sha256).toBe(jobHash(maskBytes));
      expect(obj(obj(runtimeReq.setup_painting).backdrop).path).toBe(backdropAfter);
      expect(obj(obj(runtimeReq.setup_painting).backdrop).sha256).toBe(jobHash(backdropBytes));

      expect(readFileSync(join(dir, 'evidence/v1/registration', maskAfter))).toEqual(maskBytes);
      expect(readFileSync(join(dir, 'derived/review/v1', maskAfter))).toEqual(maskBytes);
      expect(readFileSync(join(dir, 'evidence/v1/registration', backdropAfter))).toEqual(backdropBytes);
      expect(readFileSync(join(dir, 'derived/review/v1', backdropAfter))).toEqual(backdropBytes);

      const runtimeReceipts = obj(obj(runtimeConfig.assemble).editor_receipts).receipts as JsonObject[];
      for (let i = 0; i < 4; i++) {
        const expectedPath = explicitAdapter ? `inputs/editor_receipts/${i}.png` : `inputs/assemble/editor_receipts/receipts/${i}/file`;
        expect(runtimeReceipts[i]!.file).toBe(expectedPath);
        expect(runtimeReceipts[i]!.sha256).toBe(jobHash(receiptBytes[i]!));
        expect(readFileSync(join(dir, 'evidence/v1/registration', expectedPath))).toEqual(receiptBytes[i]!);
        expect(readFileSync(join(dir, 'derived/review/v1', expectedPath))).toEqual(receiptBytes[i]!);
        expect(readFileSync(join(dir, 'derived/v0/layers/full/parts', receiptNames[i]!))).toEqual(receiptBytes[i]!);
      }

      expect(readFileSync(join(dir, 'evidence/v1/config.json'))).toEqual(origConfigBytes);
      expect(readFileSync(join(dir, 'evidence/v1/requirements.json'))).toEqual(origReqBytes);
      expect(readFileSync(join(dir, originalMaskPath))).toEqual(maskBytes);
      expect(readFileSync(join(dir, 'inputs/background.png'))).toEqual(backdropBytes);

      // 3. Full check and registration findings pass.
      expect(rigRegistrationFindings(dir, project)).toEqual([]);
      expect(checkProject(dir).refusals).toEqual([]);

      // 4. Review package regeneration preserves all adapted runtime inputs.
      const beforePkg = version.review_package;
      rmSync(join(dir, 'derived/review/v1'), { recursive: true });
      reviewPackageCommand(['1', dir, '--config', 'evidence/v1/registration/config.json', '--from', 'outputs/v1/out']);
      expect((load().versions as JsonObject[])[0]!.review_package).toEqual(beforePkg);
      expect(checkProject(dir).refusals).toEqual([]);

      // 5. Record publication inventory -> retained root roundtrip is GREEN.
      const root = realpathSync(dir);
      const record = { path: 'project.json' as const, sha256: jobHash(readFileSync(join(root, 'project.json'))) };
      const inventory = readRecordPublished({ root, record, result: { kind: 'plan' }, phase: 'inventory' }, testClock.now());
      const retainedRoot = join(realpathSync(dirname(dir)), `retained-${String(explicitAdapter)}`);
      mkdirSync(retainedRoot);
      for (const file of inventory.files) {
        mkdirSync(dirname(join(retainedRoot, file.path)), { recursive: true });
        cpSync(join(root, file.path), join(retainedRoot, file.path));
      }
      // Producer integrity is checked at the live boundary, not on the record-only snapshot.
      expect(checkProject(root).refusals).toEqual([]);
      expect(checkRecordProject(retainedRoot, undefined, { now: testClock.now(), readOnly: true, recordPublication: true }).refusals).toEqual([]);
      expect(readRecordPublished({
        root: retainedRoot,
        record,
        result: { kind: 'plan' },
        phase: 'retained',
        parts: inventory.parts,
      }, testClock.now())).toEqual(inventory);
    }
  });

  test('refuses unlisted runtime edits, wrong path_adapter entries, target collisions, missing/tampered assets, stale figure-mask path, outside-project refs, and symlinks', () => {
    const { dir, load } = setup();
    const maskBytes = Buffer.from('Synthetic figure mask bytes');
    const backdropBytes = Buffer.from('Synthetic backdrop bytes');
    const receiptBytes = Buffer.from('Synthetic receipt bytes');
    const paintingBytes = Buffer.from('Synthetic painting bytes');
    writeFileSync(join(dir, 'inputs/painting.png'), paintingBytes);
    writeFileSync(join(dir, 'inputs/background.png'), backdropBytes);
    mkdirSync(join(dir, 'evidence/figure-mask'), { recursive: true });
    writeFileSync(join(dir, 'evidence/figure-mask/figure_mask.png'), maskBytes);
    mkdirSync(join(dir, 'derived/v0/parts'), { recursive: true });
    writeFileSync(join(dir, 'derived/v0/parts/author:hand_r.png'), receiptBytes);

    const baseProject = load();
    const guide = obj(waypoint(baseProject, 'assemble').guide);
    obj(guide.value).ground = 'busy';
    arr(guide.asks).push({ id: 'ground', state: 'user' });
    const baseInput = (baseProject.inputs as JsonObject[])[0]!;
    baseProject.inputs = [
      { ...baseInput, path: 'inputs/painting.png', sha256: jobHash(paintingBytes), bytes: paintingBytes.length },
      { ...baseInput, path: 'inputs/background.png', sha256: jobHash(backdropBytes), bytes: backdropBytes.length },
    ];
    baseProject.derived = [{
      path: 'evidence/figure-mask/figure_mask.png',
      kind: 'prepared-input',
      sha256: jobHash(maskBytes),
      bytes: maskBytes.length,
      at: '2026-11-06T20:00:00Z',
      tool: 'birefnet',
      operation: 'birefnet-general: alpha >= 128; foreground subtracted: none',
      source: { path: 'inputs/painting.png', sha256: jobHash(paintingBytes) },
    }];
    put(dir, 'project.json', baseProject);

    const writeValidSources = () => {
      put(dir, 'evidence/v1/config.json', {
        key: 'synthetic',
        requirements: 'requirements.json',
        assemble: {
          project: 'visible',
          ground: 'busy',
          editor_receipts: {
            trace_parts: true,
            receipts: [{ part: 'hand_r', file: '../../derived/v0/parts/author:hand_r.png', sha256: jobHash(receiptBytes) }],
          },
        },
      });
      put(dir, 'evidence/v1/requirements.json', {
        spec: 'spine-parts-requirements/1',
        fps: 4,
        requirements: [],
        setup_painting: {
          required: true,
          figure_mask: { path: '../figure-mask/figure_mask.png', sha256: jobHash(maskBytes) },
          backdrop: { path: '../../inputs/background.png', sha256: jobHash(backdropBytes) },
        },
        seam_over_motion: { required: true },
        boundary_colour: { max_step_excess: 12 },
      });
      put(dir, 'evidence/v1/citations.json', {
        assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis', 'ground'] }],
      });
      put(dir, 'source/compile-report.json', {
        spec: 'build-report/1',
        command: 'build',
        gates: [
          { gate: 'seam_over_motion', failures: [], checked: 2 },
          { gate: 'boundary_colour', failures: [], worst_step_excess: 1 },
        ],
      });
      put(dir, 'evidence/v1/adapter.json', []);
    };
    writeValidSources();

    const v1Args = [
      '1', dir,
      '--parts', 'source/parts',
      '--rig', 'source/rig',
      '--build', 'source/build',
      '--idle', 'source/idle',
      '--config', 'evidence/v1/config.json',
      '--path-adapter', 'evidence/v1/adapter.json',
      '--compile-report', 'source/compile-report.json',
      '--toolchain-lock', 'source/package-lock.json',
      '--run-record', 'source/run.json',
      '--at-source', 'source/at-source.json',
      '--at-pointer', '/finished_at',
      '--citations', 'evidence/v1/citations.json',
      '--by', 'registrant',
      '--json',
    ];

    // 1. Wrong path_adapter cases at registration time (wrong before, wrong pointer, non-asset pointer, unknown doc, duplicate pointer).
    for (const badAdapter of [
      [{ doc: 'config', pointer: '/assemble/editor_receipts/receipts/0/file', before: 'wrong.png', after: 'inputs/r0.png' }],
      [{ doc: 'config', pointer: '/assemble/editor_receipts/receipts/99/file', before: '../../derived/v0/parts/author:hand_r.png', after: 'inputs/r0.png' }],
      [{ doc: 'config', pointer: '/key', before: 'synthetic', after: 'inputs/key' }],
      [{ doc: 'requirements', pointer: '/setup_painting/figure_mask/path', before: 'wrong.png', after: 'inputs/mask.png' }],
      [{ doc: 'requirements', pointer: '/fps', before: '4', after: 'inputs/fps' }],
      [{ doc: 'unknown', pointer: '/setup_painting/figure_mask/path', before: '../figure-mask/figure_mask.png', after: 'inputs/mask.png' }],
      [{ doc: 'requirements', pointer: '/setup_painting/figure_mask/path', before: '../figure-mask/figure_mask.png', after: '../escape.png' }],
    ]) {
      put(dir, 'evidence/v1/adapter.json', badAdapter);
      const before = readFileSync(join(dir, 'project.json'));
      refused(v1Args, 'RIG_PATH_ADAPTER_INVALID');
      expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
      expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    }

    // 2. Target path collision in path_adapter refuses with RIG_REGISTRATION_PATH_INVALID.
    put(dir, 'evidence/v1/adapter.json', [
      { doc: 'requirements', pointer: '/setup_painting/figure_mask/path', before: '../figure-mask/figure_mask.png', after: 'inputs/shared.png' },
      { doc: 'requirements', pointer: '/setup_painting/backdrop/path', before: '../../inputs/background.png', after: 'inputs/shared.png' },
    ]);
    refused(v1Args, 'RIG_REGISTRATION_PATH_INVALID');
    writeValidSources();

    // 3. Outside-project relative references refuse with RIG_REGISTRATION_PATH_INVALID before copy/write.
    for (const mutateOutside of [
      () => {
        const cfg = JSON.parse(readFileSync(join(dir, 'evidence/v1/config.json'), 'utf8')) as JsonObject;
        ((obj(obj(cfg.assemble).editor_receipts).receipts as JsonObject[])[0]!).file = '../../../outside.png';
        put(dir, 'evidence/v1/config.json', cfg);
      },
      () => {
        const req = JSON.parse(readFileSync(join(dir, 'evidence/v1/requirements.json'), 'utf8')) as JsonObject;
        obj(obj(req.setup_painting).figure_mask).path = '../../../outside-mask.png';
        put(dir, 'evidence/v1/requirements.json', req);
      },
      () => {
        const req = JSON.parse(readFileSync(join(dir, 'evidence/v1/requirements.json'), 'utf8')) as JsonObject;
        obj(obj(req.setup_painting).backdrop).path = '../../../outside-backdrop.png';
        put(dir, 'evidence/v1/requirements.json', req);
      },
    ]) {
      writeValidSources();
      mutateOutside();
      refused(v1Args, 'RIG_REGISTRATION_PATH_INVALID');
      expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    }

    // 4. Symlinked assets or symlinked parent directories refuse with RIG_REGISTRATION_PATH_INVALID.
    writeValidSources();
    rmSync(join(dir, 'derived/v0/parts/author:hand_r.png'));
    writeFileSync(join(dir, 'derived/v0/real-hand.png'), receiptBytes);
    symlinkSync(join(dir, 'derived/v0/real-hand.png'), join(dir, 'derived/v0/parts/author:hand_r.png'));
    refused(v1Args, 'RIG_REGISTRATION_PATH_INVALID');
    rmSync(join(dir, 'derived/v0/parts/author:hand_r.png'));
    writeFileSync(join(dir, 'derived/v0/parts/author:hand_r.png'), receiptBytes);

    rmSync(join(dir, 'inputs/background.png'));
    symlinkSync(join(dir, 'inputs/painting.png'), join(dir, 'inputs/background.png'));
    refused(v1Args, 'RIG_REGISTRATION_PATH_INVALID');
    rmSync(join(dir, 'inputs/background.png'));
    writeFileSync(join(dir, 'inputs/background.png'), backdropBytes);

    // 5. Missing asset or declared sha256 mismatch refuses with RIG_REGISTRATION_FILE_INVALID.
    rmSync(join(dir, 'inputs/background.png'));
    refused(v1Args, 'RIG_REGISTRATION_FILE_INVALID');
    writeFileSync(join(dir, 'inputs/background.png'), Buffer.from('wrong backdrop bytes'));
    refused(v1Args, 'RIG_REGISTRATION_FILE_INVALID');
    writeFileSync(join(dir, 'inputs/background.png'), backdropBytes);

    writeFileSync(join(dir, 'derived/v0/parts/author:hand_r.png'), Buffer.from('wrong receipt bytes'));
    refused(v1Args, 'RIG_REGISTRATION_FILE_INVALID');
    writeFileSync(join(dir, 'derived/v0/parts/author:hand_r.png'), receiptBytes);

    // 6. Stale user asset at a different path (same sha256) refuses with FIGURE_MASK_UNRECORDED.
    const staleProject = load();
    staleProject.derived = [{
      ...(staleProject.derived as JsonObject[])[0]!,
      path: 'evidence/stale-mask.png',
    }];
    put(dir, 'project.json', staleProject);
    refused(v1Args, 'FIGURE_MASK_UNRECORDED');
    put(dir, 'project.json', baseProject);

    // 7. Register v1 cleanly, then plant post-registration mutations and verify rigRegistrationFindings catches each one.
    expect(rigVersionCommand(v1Args).exit).toBe(0);
    const cleanProject = load();
    const rebindFile = (candidate: JsonObject, relPath: string, newBytes: Buffer) => {
      writeFileSync(join(dir, relPath), newBytes);
      const h = jobHash(newBytes);
      const ver = (candidate.versions as JsonObject[])[0]!;
      const reg = obj(ver.registration);
      for (const f of reg.files as JsonObject[]) {
        if (f.path === relPath) f.sha256 = h;
      }
      if (relPath === 'evidence/v1/registration/config.json') obj(obj(ver.provenance).config).sha256 = h;
      if (relPath === 'evidence/v1/registration/requirements.json') obj(reg.requirements).sha256 = h;
      if (relPath === 'evidence/v1/registration/path-adapter.json') obj(reg.path_adapter).sha256 = h;
    };

    // 7a. Unlisted runtime field change in config.json (even when hashes are updated).
    {
      const candidate = structuredClone(cleanProject);
      const runtimeCfg = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/config.json'), 'utf8')) as JsonObject;
      runtimeCfg.key = 'tampered-key';
      rebindFile(candidate, 'evidence/v1/registration/config.json', Buffer.from(`${JSON.stringify(runtimeCfg, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/config.json'), readFileSync(join(dir, 'derived/review/v1/config.json')));
    }

    // 7b. Unlisted runtime field change in requirements.json (even when hashes are updated).
    {
      const candidate = structuredClone(cleanProject);
      const runtimeReq = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/requirements.json'), 'utf8')) as JsonObject;
      runtimeReq.fps = 99;
      rebindFile(candidate, 'evidence/v1/registration/requirements.json', Buffer.from(`${JSON.stringify(runtimeReq, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/requirements.json'), readFileSync(join(dir, 'derived/review/v1/requirements.json')));
    }

    // 7c. Tampered path-adapter.json with wrong before or non-asset pointer refuses with RIG_PATH_ADAPTER_INVALID.
    {
      const savedAdapter = readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'));
      const candidate = structuredClone(cleanProject);
      const badRows = JSON.parse(savedAdapter.toString('utf8')) as JsonObject[];
      badRows[0]!.before = 'wrong-before.png';
      rebindFile(candidate, 'evidence/v1/registration/path-adapter.json', Buffer.from(`${JSON.stringify(badRows, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_PATH_ADAPTER_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'), savedAdapter);
    }

    // 7d. Tampered retained asset bytes in evidence/v1/registration refuse with RIG_REGISTRATION_FILE_INVALID.
    {
      const targetRel = 'evidence/v1/registration/inputs/setup_painting/backdrop/path';
      const savedBackdrop = readFileSync(join(dir, targetRel));
      const candidate = structuredClone(cleanProject);
      rebindFile(candidate, targetRel, Buffer.from('tampered backdrop bytes'));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, targetRel), savedBackdrop);
    }

    // 7e. Removing a declared config pointer row from path-adapter.json on a new pointer-adapted record refuses with RIG_REGISTRATION_FILE_INVALID.
    {
      const savedAdapter = readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'));
      const candidate = structuredClone(cleanProject);
      const rowsOnlyReq = (JSON.parse(savedAdapter.toString('utf8')) as JsonObject[]).filter(r => r.doc === 'requirements');
      rebindFile(candidate, 'evidence/v1/registration/path-adapter.json', Buffer.from(`${JSON.stringify(rowsOnlyReq, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'), savedAdapter);
    }
    expect(rigRegistrationFindings(dir, cleanProject)).toEqual([]);
  });

  test('keeps the pointer contract after removing its sole adapter row, including stripped requirements bindings', () => {
    for (const removeRequirementsBindings of [false, true]) {
      const { dir, args, load } = setup();
      put(dir, 'source/donor/input.png', 'synthetic receipt');
      const config: JsonObject = { key: 'synthetic', requirements: 'requirements.json', assemble: { editor_receipts: { receipts: [{ file: 'donor/input.png' }] } } };
      put(dir, 'source/config.json', config);
      put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
      rigVersionCommand([...args, '--citations', 'source/citations.json']);
      const project = load();
      const registration = obj((project.versions as JsonObject[])[0]!.registration);
      expect(obj(registration.path_adapter).format).toBe('json-pointer/1');
      expect(rigRegistrationFindings(dir, project)).toEqual([]);
      if (removeRequirementsBindings) {
        delete registration.requirements_source;
        delete registration.requirements;
      }
      const adapterPath = String(obj(registration.path_adapter).path);
      const rows = JSON.parse(readFileSync(join(dir, adapterPath), 'utf8')) as JsonObject[];
      expect(rows).toHaveLength(1);
      const emptyAdapter = Buffer.from('[]\n');
      writeFileSync(join(dir, adapterPath), emptyAdapter);
      obj(registration.path_adapter).sha256 = jobHash(emptyAdapter);
      for (const file of registration.files as JsonObject[]) if (file.path === adapterPath) file.sha256 = jobHash(emptyAdapter);
      expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
    }
  });

  test('checks a reconstructed pre-#394 frozen-rig/1 layout with implicit take/editor_receipts relocation, empty retained directories, legacy extra-key adapters, and uncopied source-only fields while refusing unlisted mutations', () => {
    const { dir, args, load } = setup();
    const paintingBytes = Buffer.from('Synthetic immutable painting input');
    writeFileSync(join(dir, 'inputs/painting.png'), paintingBytes);
    const initial = load();
    initial.inputs = [{ ...(initial.inputs as JsonObject[])[0]!, path: 'inputs/painting.png', sha256: jobHash(paintingBytes), bytes: paintingBytes.length }];
    put(dir, 'project.json', initial);

    mkdirSync(join(dir, 'source/donor'), { recursive: true });
    mkdirSync(join(dir, 'empty-donor'), { recursive: true });
    put(dir, 'source/donor/layers.json', { layers: [] });
    put(dir, 'source/donor/source.png', 'synthetic source input');
    put(dir, 'source/donor/extra.png', 'synthetic extra input');
    const maskBytes = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    const maskHash = jobHash(maskBytes);
    writeFileSync(join(dir, 'mask.png'), maskBytes);
    writeFileSync(join(dir, 'backdrop-old.png'), maskBytes);

    // Pre-#394 config with relative take (including a ../ empty directory and source-only reference.painting), editor_receipts, and absolute requirements via legacy adapter with extra keys.
    const legacyConfigSource: JsonObject = {
      key: 'synthetic',
      requirements: '/runtime/requirements.json',
      assemble: {
        take: [
          { run: 'full', tags: ['piece'], run_dir: 'donor', st_input: 'donor/source.png', reference: { painting: 'donor/extra.png' } },
          { run: 'head', tags: ['piece'], run_dir: '../empty-donor' },
        ],
        editor_receipts: { receipts: [{ file: 'donor/source.png' }] },
      },
    };
    const legacyRequirements: JsonObject = {
      spec: 'spine-parts-requirements/1',
      fps: 4,
      requirements: [],
      setup_painting: {
        required: true,
        figure_mask: { path: '../mask.png', sha256: maskHash },
        backdrop: { path: '../backdrop-old.png', sha256: maskHash },
      },
    };
    const legacyAdapter = [
      { at: '.requirements', before: join(dir, 'source/requirements.json'), after: '/runtime/requirements.json', note: 'legacy extra key allowed' },
      { at: '.unused_abs', before: '/abs/unused-before.json', after: '/abs/unused-after.json', extra: true },
    ];
    put(dir, 'source/config.json', legacyConfigSource);
    put(dir, 'source/requirements.json', legacyRequirements);
    put(dir, 'source/adapter.json', legacyAdapter);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });

    rigVersionCommand([...args, '--citations', 'source/citations.json']);

    // Reconstruct the pre-#394 layout as a checker unit control. This does not execute the historical writer.
    // - path-adapter.json contains only legacyAdapter (no pointer rows)
    // - registration has no requirements_source or requirements bindings
    // - config.json has implicit relocation only on take.run_dir, take.st_input, editor_receipts.file, and legacy-abs .requirements (leaving take[0].reference.painting un-relocated/uncopied and backdrop uncopied)
    const pre394PortableConfig: JsonObject = {
      key: 'synthetic',
      requirements: 'inputs/requirements',
      assemble: {
        take: [
          { run: 'full', tags: ['piece'], run_dir: 'inputs/assemble/take/0/run_dir', st_input: 'inputs/assemble/take/0/st_input', reference: { painting: 'donor/extra.png' } },
          { run: 'head', tags: ['piece'], run_dir: 'inputs/assemble/take/1/run_dir' },
        ],
        editor_receipts: { receipts: [{ file: 'inputs/assemble/editor_receipts/receipts/0/file' }] },
      },
    };
    writeFileSync(join(dir, 'evidence/v1/registration/config.json'), `${JSON.stringify(pre394PortableConfig, null, 2)}\n`);
    writeFileSync(join(dir, 'evidence/v1/registration/inputs/requirements'), `${JSON.stringify(legacyRequirements, null, 2)}\n`);
    writeFileSync(join(dir, 'evidence/v1/registration/mask.png'), maskBytes);
    writeFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'), `${JSON.stringify(legacyAdapter, null, 2)}\n`);
    rmSync(join(dir, 'evidence/v1/registration/requirements-source.json'), { force: true });
    rmSync(join(dir, 'evidence/v1/registration/inputs/assemble/take/0/reference'), { recursive: true, force: true });
    rmSync(join(dir, 'evidence/v1/registration/inputs/setup_painting'), { recursive: true, force: true });

    const rebuildRetainedList = (rootRel: string): JsonObject[] => {
      const out: JsonObject[] = [];
      const scan = (r: string): void => {
        for (const name of readdirSync(join(dir, r)).sort()) {
          const p = `${r}/${name}`;
          if (lstatSync(join(dir, p)).isDirectory()) scan(p);
          else out.push({ path: p, sha256: jobHash(readFileSync(join(dir, p))) });
        }
      };
      scan(rootRel);
      return out;
    };

    const project = load();
    const v1 = (project.versions as JsonObject[])[0]!;
    const reg = obj(v1.registration);
    delete obj(reg.path_adapter).format;
    delete reg.requirements_source;
    delete reg.requirements;
    const cfgBytes = readFileSync(join(dir, 'evidence/v1/registration/config.json'));
    const adapterBytes = readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'));
    obj(v1.provenance).config = { path: 'evidence/v1/registration/config.json', sha256: jobHash(cfgBytes), bytes: cfgBytes.length };
    reg.path_adapter = { path: 'evidence/v1/registration/path-adapter.json', sha256: jobHash(adapterBytes), bytes: adapterBytes.length };
    reg.files = rebuildRetainedList('evidence/v1/registration');
    put(dir, 'project.json', project);

    rmSync(join(dir, 'derived/review/v1'), { recursive: true, force: true });
    reviewPackageCommand(['1', dir, '--config', 'evidence/v1/registration/config.json', '--from', 'outputs/v1/out']);

    const pre394Project = load();
    expect(rigRegistrationFindings(dir, pre394Project)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);

    // Retained publication roundtrip succeeds on the pre-#394 record (including empty run_dir).
    const root = realpathSync(dir);
    const record = { path: 'project.json' as const, sha256: jobHash(readFileSync(join(root, 'project.json'))) };
    const inventory = readRecordPublished({ root, record, result: { kind: 'plan' }, phase: 'inventory' }, testClock.now());
    const retainedRoot = join(realpathSync(dirname(dir)), 'retained-pre394');
    mkdirSync(retainedRoot);
    for (const file of inventory.files) {
      mkdirSync(dirname(join(retainedRoot, file.path)), { recursive: true });
      cpSync(join(root, file.path), join(retainedRoot, file.path));
    }
    // Producer integrity is checked at the live boundary, not on the record-only snapshot.
    expect(checkProject(root).refusals).toEqual([]);
    expect(checkRecordProject(retainedRoot, undefined, { now: testClock.now(), readOnly: true, recordPublication: true }).refusals).toEqual([]);
    expect(readRecordPublished({
      root: retainedRoot,
      record,
      result: { kind: 'plan' },
      phase: 'retained',
      parts: inventory.parts,
    }, testClock.now())).toEqual(inventory);

    // Unlisted runtime field edits on the pre-#394 record still refuse with RIG_REGISTRATION_FILE_INVALID.
    for (const mutateRuntime of [
      (cfg: JsonObject) => { cfg.key = 'tampered'; },
      (cfg: JsonObject) => { ((obj(obj(cfg.assemble).editor_receipts).receipts as JsonObject[])[0]!).file = 'donor/source.png'; },
    ]) {
      const candidate = structuredClone(pre394Project);
      const tamperedCfg = structuredClone(pre394PortableConfig);
      mutateRuntime(tamperedCfg);
      const tamperedBytes = Buffer.from(`${JSON.stringify(tamperedCfg, null, 2)}\n`);
      writeFileSync(join(dir, 'evidence/v1/registration/config.json'), tamperedBytes);
      const h = jobHash(tamperedBytes);
      const cv = (candidate.versions as JsonObject[])[0]!;
      obj(obj(cv.provenance).config).sha256 = h;
      for (const f of obj(cv.registration).files as JsonObject[]) {
        if (f.path === 'evidence/v1/registration/config.json') f.sha256 = h;
      }
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/config.json'), cfgBytes);
    }
  });
});

describe('#812/#929 live rig feedback', () => {
  test.each(['no route', 'first ingest', 'already ingested', 'closed receipt', 'ambiguous comments',
    'approved verdict', 'pinned comment', 'mixed comments'] as const)('%s', async mode => {
    const { dir: fixtureDir, args, load } = setup(true);
    const dir = realpathSync(fixtureDir);
    const words = '  Add a keyed wind motion.\r\n';
    const painting = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(dir, 'inputs/painting.png'), painting);
    const project = load();
    project.inputs = [{ path: 'inputs/painting.png', sha256: jobHash(painting),
      bytes: painting.length, origin: 'synthetic original painting', at: testClock.iso() }];
    const signoffs = arr(project.signoffs);
    // Motion was answered after the initial interview and signed with its rig plan.
    for (const signoff of signoffs.map(obj).filter(row => row.stage === 'interview')) delete obj(signoff.answer_hashes).motion;
    approveFrozenParts(dir, project, args);
    project.signoffs = [...signoffs, ...arr(project.signoffs)];
    const draft = obj(arr(project.drafts)[0]);
    const partsPath = String(obj(draft.parts).path);
    const draftRig = 'derived/drafts/synthetic-frozen/rig';
    cpSync(join(dir, 'source/rig'), join(dir, draftRig), { recursive: true });
    cpSync(join(import.meta.dir, '../templates/example-diff/recomposite_rig.png'), join(dir, partsPath, 'recomposite_rig.png'));
    const artifacts = [`${partsPath}/recomposite_rig.png`, ...['rig.json', 'motion.json', 'mesh_report.json'].map(name => `${draftRig}/${name}`)];
    Object.assign(draft, { kind: 'draft-rig', at: '2026-11-07T00:00:00Z', producer: { name: '@rig-c/parts', version: '2.52.0' },
      files: artifacts.map(path => ({ path, sha256: jobHash(readFileSync(join(dir, path))) })) });
    const partsSignoff = signoffs.map(obj).find(row => row.stage === 'parts-review')!;
    project.diff_map = { ...obj(partsSignoff.diff_map), by: 'agent', at: testClock.iso() };
    put(dir, 'project.json', project);
    expect(checkProject(dir).refusals).toEqual([]);
    const host = await openCreateJob(dir, { id: 'synthetic-owner', role: 'owner' }, testClock.now());
    try {
      const runCli = async (...argv: string[]) => {
        const child = Bun.spawn([process.execPath, ...clockedCli(), ...argv], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
        const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { exit, stdout, stderr };
      };
      const cli = async (...argv: string[]): Promise<JsonObject> => {
        const { exit, stderr, stdout } = await runCli(...argv);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
        return JSON.parse(stdout) as JsonObject;
      };
      await cli('rig-version', ...args);
      const publication = host.session.status().publication!;
      const pinnedWords = 'Adjust the wind pose here.';
      const pin = mode === 'pinned comment' || mode === 'mixed comments'
        ? framedRigPin(pinnedWords, { sourceHash: publication.source.sourceHash,
          modelHash: publication.source.model!.sha256, target: publication.source.package!.id })
        : undefined;
      const general = mode === 'pinned comment' ? [] : mode === 'ambiguous comments' ? [words, 'Leave the blink unchanged.'] : [words];
      const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, { method: 'POST',
        headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
        body: JSON.stringify({ schema: 'rig-review/job-api@2', verb: 'ask', jobId: host.session.jobId, requestId: crypto.randomUUID(),
          expectedGeneration: host.session.status().generation, idempotencyKey: crypto.randomUUID(),
          publicationId: publication.publicationId, subject: { kind: 'review-verdict', stage: 'rig-review' } }) }));
      const ask = await response.json();
      expect(ask.ok).toBe(true);
      if (!ask.ok) throw Error(ask.error.code);
      const pageId = 'synthetic-page';
      const ui = (route: string, body: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, { method: 'POST',
        headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const displayed = await host.ports.ackDisplayed(host.session.jobId, ui('displayed', { publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash }));
      if (!displayed.ok) throw Error(displayed.error.code);
      const act = await host.ports.commitUIAct(host.session.jobId, ui('acts', { publicationId: publication.publicationId,
        askId: ask.value.askId, pageId, displayedNonce: displayed.value.displayedNonce, expectedGeneration: host.session.status().generation,
        submissionId: 'synthetic-submission', kind: 'review-verdict', value: { stage: 'rig-review',
          verdict: mode === 'approved verdict' ? 'approved' : 'changes-requested', words: '',
          general, ...(pin ? { feedback: [{ ...obj(pin.anchor), summary: pin.text }] } : {}) },
        capture: { png: `data:image/png;base64,${painting.toString('base64')}`, width: 8, height: 16,
          camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
          binding: { publicationId: publication.publicationId, instanceKey: publication.instanceKey, sourceHash: publication.source.sourceHash,
            pageId, askId: ask.value.askId, drawGeneration: 1, playerGeneration: 0 } } }));
      if (!act.ok) throw Error(act.error.code);
      testClock.set(act.value.at);
      const reviewArgs = ['review', '1', dir, '--from-review', act.value.actId, '--json'];
      const projectFile = join(dir, 'project.json');
      const recordBytes = () => readFileSync(projectFile);
      const refusedReview = async (argv: string[], code: string, file = projectFile) => {
        const before = readFileSync(file);
        const result = await runCli(...argv);
        expect(result.exit).toBe(code === 'REVIEW_OPTION_INVALID' ? 2 : 1);
        expect(result.stderr).toContain(`${code}:`);
        expect(readFileSync(file)).toEqual(before);
      };
      const refusedRoute = (code: string, ...flags: string[]) => refusedReview([...reviewArgs, ...flags], code);
      if (mode === 'ambiguous comments' || mode === 'approved verdict') {
        await refusedRoute('REVIEW_FEEDBACK_ROUTE_INVALID', '--item', 'motion:not-asked');
        return;
      }
      const receipt = () => arr(load().review_acts).map(obj).find(row => row.actId === act.value.actId)!;
      if (pin) {
        const exported = host.session.readActExport(act.value.actId, false).toString('utf8');
        const comments = arr(obj(JSON.parse(exported).value).comments);
        expect(comments).toHaveLength(mode === 'pinned comment' ? 1 : 2);
        expect(comments[0]).toMatchObject(pin);
        if (mode === 'pinned comment') {
          const before = recordBytes();
          const routed = await runCli(...reviewArgs, '--item', 'motion:not-asked');
          expect(routed.exit).toBe(1);
          expect(routed.stderr).toContain('REVIEW_FEEDBACK_ROUTE_INVALID:');
          expect(recordBytes()).toEqual(before);

          const plain = ['review', '1', '--from-review', act.value.actId];
          const recorded = await cli(...plain, '--json');
          expect(recorded.verdict).toMatchObject({ verdict: 'bounced', on_items: [] });
          expect(obj(recorded.verdict).verbatim).toContain(pinnedWords);
          expect(receipt()).not.toHaveProperty('feedback_route');
          expect(receipt().bytes).toBe(exported);
          expect(checkProject(dir).refusals).toEqual([]);
          expect(routed.stderr).toContain(`rig-create ${plain.join(' ')}`);
          expect(routed.stderr).toContain('preserve pinned comments');
        } else {
          expect(comments[1]).toEqual({ text: words });
          const recorded = await cli(...reviewArgs, '--item', 'motion:not-asked');
          expect(recorded.feedback_route).toMatchObject({ item: 'motion', comment_index: 1, verbatim: words });
          expect(receipt().feedback_route).toEqual(recorded.feedback_route!);
          expect(receipt().bytes).toBe(exported);
          expect(checkProject(dir).refusals.map(f => f.code)).toEqual(['SIGNOFF_ANSWERS_STALE', 'GUIDE_CHANGED_UNSIGNED']);
        }
        return;
      }
      const preIngest = mode === 'closed receipt' ? recordBytes() : undefined;
      const prior = mode === 'first ingest' ? undefined : await cli(...reviewArgs);
      if (mode === 'closed receipt') {
        const before = recordBytes();
        const close = await runCli('job', 'close', dir);
        expect(close).toEqual({ exit: 0, stdout: 'job: closed\n', stderr: '' });
        expect(readWriterBinding(dir)).toBeNull();
        expect(recordBytes()).toEqual(before);

        // The same real act has no authority in the copy of the record from before ingest.
        const copy = join(dirname(dir), 'receipt-control');
        mkdirSync(copy);
        const copyFile = join(copy, 'project.json');
        writeFileSync(copyFile, preIngest!);
        const copyArgs = ['review', '1', copy, ...reviewArgs.slice(3), '--item', 'motion:not-asked'];
        await refusedReview(copyArgs, 'JOB_BINDING_INVALID', copyFile);

        const corrupt = load();
        arr(corrupt.review_acts).map(obj).find(row => row.actId === act.value.actId)!.sha256 = '0'.repeat(64);
        put(copy, 'project.json', corrupt);
        await refusedReview(copyArgs, 'REVIEW_ACT_LEDGER_INVALID', copyFile);

        const release = acquireJobLock(dir)!;
        try {
          await refusedRoute('JOB_WRITE_BUSY', '--item', 'motion:not-asked');
        } finally {
          release();
        }
        expect(receipt()).not.toHaveProperty('feedback_route');
      }
      put(dir, 'source/config-next.json', { key: 'synthetic', requirements: 'requirements.json', motion: { animations_from: 'animations.json' } });
      put(dir, 'source/animations.json', { wind: { duration: 1, tracks: [] } });
      put(dir, 'source/citations.json', { motion: [{ entry: 'animations_from', guide: 'motion', quote: words }] });
      const second = ['2', dir, ...args.slice(2), '--answers', '1:0', '--citations', 'source/citations.json'];
      second[second.indexOf('--config') + 1] = 'source/config-next.json';
      if (mode === 'no route') {
        expect(prior?.verdict).toMatchObject({ verdict: 'bounced', verbatim: `[general]\n${words}`, on_items: [] });
        const finding = refused(second, 'QUOTE_NOT_FOUND');
        expect(finding.message).toContain('interview.waypoints[motion].guide');
        await cli('rig-version', '2', dir, ...args.slice(2), '--answers', '1:0');
        await refusedRoute('REVIEW_FEEDBACK_ROUTE_INVALID', '--item', 'motion:not-asked');
        return;
      }

      const motion = () => obj(waypoint(load(), 'motion').guide);
      await refusedRoute('REVIEW_OPTION_INVALID', '--item', 'motion');
      await refusedRoute('REVIEW_OPTION_INVALID', '--item', 'motion:not-asked', '--quote', 'motion=paraphrase');
      await refusedRoute('FEEDBACK_ITEM_UNKNOWN', '--item', 'missing:not-asked');
      const sign = async () => {
        put(dir, 'owner-sign.txt', 'Approve the current motion guide.');
        return cli('signoff', 'plan-approved', dir, '--by', 'user', '--owner-chat', join(dir, 'owner-sign.txt'),
          '--said-at', testClock.iso(), '--relayed-by', 'agent', '--json');
      };
      const priorReceipt = prior ? structuredClone(receipt()) : undefined;
      if (mode === 'already ingested') {
        testClock.set(testClock.now() + 1000);
        await sign(); // The route's later time must lapse even this post-comment approval.
      }
      testClock.set(testClock.now() + 1000);
      const routedAt = testClock.iso();
      const routeArgs = [...reviewArgs, '--item', 'motion:not-asked'];
      const recorded = await cli(...routeArgs);
      expect(recorded.verdict).toMatchObject({ at: act.value.at, verdict: 'bounced', verbatim: `[general]\n${words}`, on_items: [] });
      const route = { by: 'agent', at: routedAt, item: 'motion', comment_index: 0, verbatim: words };
      expect(recorded.feedback_route).toEqual(route);
      expect(receipt().feedback_route).toEqual(route);
      if (prior) {
        expect(recorded.verdict).toEqual(prior.verdict!);
        expect(receipt()).toEqual({ ...priorReceipt, feedback_route: route });
      }
      expect(motion().additions).toContainEqual({ by: 'user', at: routedAt, verbatim: words, value: null,
        source: 'polish feedback, v1', review_act: obj(recorded.verdict!).source });
      expect(checkProject(dir).feedback).toMatchObject([{ items: { user: 0, delegated: 0, not_asked: 1 } }]);
      const changedRoute = load();
      obj(arr(changedRoute.review_acts).map(obj).find(row => row.actId === act.value.actId)!.feedback_route).verbatim = 'Edited owner words';
      expect(checkProject(dir, changedRoute).refusals.map(f => f.code)).toContain('REVIEW_FEEDBACK_ROUTE_INVALID');
      const changedGuide = load();
      arr(obj(waypoint(changedGuide, 'motion').guide).additions).pop();
      expect(checkProject(dir, changedGuide).refusals.map(f => f.code)).toContain('FEEDBACK_NOT_ADDED');

      const afterRoute = recordBytes();
      testClock.set(testClock.now() + 1000);
      expect((await cli(...routeArgs)).feedback_route).toEqual(route);
      if (mode === 'closed receipt') await refusedRoute('JOB_BINDING_INVALID');
      else expect((await cli(...reviewArgs)).feedback_route).toEqual(route);
      expect(recordBytes()).toEqual(afterRoute);
      await refusedRoute('REVIEW_FEEDBACK_ROUTE_CONFLICT', '--item', 'bones:not-asked');
      const next = await cli('next', dir, '--json');
      expect(arr(next.refusals).map(row => obj(row).code)).toContain('GUIDE_CHANGED_UNSIGNED');
      const human = arr(next.moves).map(obj).filter(move => move.role === 'human');
      expect(human).toHaveLength(1);
      expect(human[0]?.command).toContain('signoff plan-approved');
      await sign();
      expect(arr((await cli('next', dir, '--json')).refusals)).toEqual([]);
      if (mode === 'first ingest') {
        put(dir, 'source/citations.json', { motion: [{ entry: 'animations_from', guide: 'motion', quote: `「${words}」` }] });
        const before = recordBytes();
        const refusedVersion = await runCli('rig-version', ...second);
        expect(refusedVersion.exit).toBe(1);
        expect(refusedVersion.stderr).toContain('QUOTE_NOT_FOUND:');
        expect(refusedVersion.stderr.split('\n')).toContain('  Removing the outer marks 「」 would match interview.waypoints[motion].guide.additions[0].verbatim exactly. Quote that field verbatim.');
        expect(recordBytes()).toEqual(before);
        put(dir, 'source/citations.json', { motion: [{ entry: 'animations_from', guide: 'motion', quote: words }] });
      }
      const version = await cli('rig-version', ...second);
      expect(version.answers_feedback).toEqual([{ version: 1, verdict: 0 }]);
      expect(obj(obj(version.provenance!).sections!).motion).toEqual([{ entry: 'animations_from', guide: 'motion', quote: words }]);
      expect(checkProject(dir).refusals).toEqual([]);
    } finally {
      host.stop();
    }
  }, 30_000);
});

describe('#454 feedback rebuild writer', () => {
  function feedbackSetup() {
    // Synthetic starting checkpoint; every subsequent version and verdict uses a writer.
    const f = setup(true);
    rigVersionCommand(f.args);
    return f;
  }
  async function bounce(dir: string) {
    const { reviewCommand } = await import('./clock.ts');
    put(dir, 'words.txt', 'Adjust the synthetic rig.');
    reviewCommand(['1', dir, '--verdict', 'bounced', '--review', 'rig-review', '--by', 'user', '--source', 'synthetic review', '--verbatim-file', join(dir, 'words.txt')]);
  }
  test('rig version -> human bounce -> next -> repeatable answers -> check -> new verdict', async () => {
    const { nextProject } = await import('../src/next.ts');
    const f = feedbackSetup();
    await bounce(f.dir);
    await bounce(f.dir);
    const before = readFileSync(join(f.dir, 'project.json'));
    const nextBefore = nextProject(f.dir, testClock.now());
    expect(nextBefore.refusals).toEqual([]);
    const moves = nextBefore.moves;
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ role: 'agent', field: 'versions' });
    expect(moves[0]!.command).toContain('rig-version 2');
    expect(moves[0]!.command).toContain('--answers 1:0 --answers 1:1');
    expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
    const args = ['2', ...f.args.slice(1)];
    refused(args, 'FEEDBACK_UNANSWERED');
    for (const path of ['outputs/v2', 'evidence/v2/registration', 'derived/review/v2']) expect(existsSync(join(f.dir, path))).toBe(false);
    expect(rigVersionCommand([...args, '--answers', '1:0', '--answers', '1:1']).exit).toBe(0);
    expect(obj(arr(f.load().versions)[1]).answers_feedback).toEqual([{ version: 1, verdict: 0 }, { version: 1, verdict: 1 }]);
    const report = checkProject(f.dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.filter(w => w.code === 'FEEDBACK_OPEN')).toEqual([]);
    const next = nextProject(f.dir, testClock.now());
    expect(next.moves.find(m => m.review_act?.kind === 'review-verdict')).toMatchObject({ role: 'human', review_act: { version_id: 'v2', review: 'rig-review' } });
    expect(next.moves.some(m => m.command?.includes('--answers'))).toBe(false);
  });
  test.each(['missing', 'accepted', 'agent', 'later', 'malformed', 'duplicate'])('rig answers refuses %s byte-identically', async kind => {
    const f = setup();
    // Only the hostile starting record is synthetic; the attempted version is a real writer.
    const verdict = { by: kind === 'agent' ? 'agent' : 'user', at: testClock.iso(), review: 'rig-review', verdict: kind === 'accepted' ? 'accepted' : 'bounced', verbatim: 'Synthetic feedback', source: 'synthetic', on_items: [] };
    const p = f.load();
    p.versions = [{ n: kind === 'later' ? 2 : 1, kind: 'rig', verdicts: [verdict] }];
    put(f.dir, 'project.json', p);
    const values = kind === 'missing' ? ['1:9'] : kind === 'later' ? ['3:0'] : kind === 'malformed' ? ['v1:0'] : kind === 'duplicate' ? ['1:0', '1:0'] : ['1:0'];
    refused(['3', ...f.args.slice(1), ...values.flatMap(v => ['--answers', v])], kind === 'duplicate' ? 'FEEDBACK_REF_DUPLICATE' : 'FEEDBACK_REF_UNKNOWN');
    expect(existsSync(join(f.dir, 'outputs/v3'))).toBe(false);
  });
});

test('#454 no-bounce rig writer and next preserve previous bytes and output', async () => {
  const { nextCommand } = await import('../src/next.ts');
  const f = setup(true);
  const result = rigVersionCommand(f.args);
  const record = readFileSync(join(f.dir, 'project.json'));
  // Printed Review commands include the synthetic project's temporary root.
  const outputHash = (json = false): string => jobHash(nextCommand([f.dir, ...(json ? ['--json'] : [])], testClock.now()).stdout.replaceAll(f.dir, '<project>'));
  expect({ exit: result.exit, stdout: jobHash(result.stdout), record: jobHash(record), nextJson: outputHash(true), nextText: outputHash() }).toMatchSnapshot();
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(record);
});

describe('#514 producer depth bindings in frozen registration', () => {
  function depthSetup(layer = false) {
    const base = setup();
    const config = { key: 'synthetic', requirements: 'requirements.json', turn: { roles: { rectangle: 'surface' } }, ...(layer ? { depth: { full: { layers: { rectangle: { image: 'sheet.png', near: 'white', zScale: 30 } } } } } : {}) };
    put(base.dir, 'source/config.json', config);
    const art = readFileSync(join(base.dir, 'source/parts/parts/rectangle.png'));
    const sourceSha256 = jobHash(art), inputSha256 = 'c'.repeat(64), mapSha256 = 'd'.repeat(64);
    const reference = { image: 'rectangle_depth.png', near: 'white', zScale: 30, sources: [{ from: 'full:author:rectangle', image: 'rectangle.json', sha256: mapSha256, crop: [0, 0, 8, 16], reading: { orderingMedian: null, sheetMedian: 128, relation: 'indeterminate' } }] };
    const assembled = JSON.parse(readFileSync(join(base.dir, 'source/parts/parts.json'), 'utf8'));
    assembled.parts[0].from = 'full:author:rectangle';
    const partsSha256 = jobHash(Buffer.from(JSON.stringify(assembled)));
    assembled.parts[0].depth = reference;
    put(base.dir, 'source/parts/parts.json', assembled);
    writeFileSync(join(base.dir, 'source/parts/parts/rectangle_depth.png'), art);
    writeFileSync(join(base.dir, 'source/rig/images/rectangle_depth.png'), art);
    writeFileSync(join(base.dir, 'source/sheet.png'), art);
    put(base.dir, 'source/depth-citations.json', Object.fromEntries(['turn', ...(layer ? ['depth'] : [])].map(section => [section, [{ entry: 'synthetic historical depth choice', guide: 'motion', quote: 'Breath and blink.', asks: ['tracks'] }]])));
    put(base.dir, 'source/rig/depth_sheets.json', { spec: 'rig-parts-depth-sheets/1', parts: [{ part: 'rectangle', size: [8, 16], depth: reference }] });
    if (!layer) {
      put(base.dir, 'source/manifest.json', { spec: 'rig-parts-depth-inputs/1', partsSha256, recipeSha256: 'b'.repeat(64), parts: [{ part: 'rectangle', sourceSha256, inputSha256 }] });
      put(base.dir, 'source/parts/depth-report.json', { spec: 'rig-parts-depth-report/1', manifestSha256: jobHash(readFileSync(join(base.dir, 'source/manifest.json'))), partsSha256, recipeSha256: 'b'.repeat(64), rigConfigSha256: jobHash(readFileSync(join(base.dir, 'source/config.json'))), parts: [{ part: 'rectangle', sourceSha256, inputSha256, mapSha256, sheetSha256: jobHash(art), near: 'white', zScale: 30, levels: 30, clip: 0 }] });
    }
    return { ...base, args: [...base.args, '--citations', 'source/depth-citations.json', ...(!layer ? ['--depth-manifest', 'source/manifest.json'] : [])] };
  }

  function acceptedDepthSetup(predepth = false) {
    const base = depthSetup();
    const acceptedPath = predepth ? 'source/assembled' : 'source/parts';
    if (predepth) {
      cpSync(join(base.dir, 'source/parts'), join(base.dir, acceptedPath), { recursive: true });
      const assembled = JSON.parse(readFileSync(join(base.dir, acceptedPath, 'parts.json'), 'utf8'));
      delete assembled.parts[0].depth;
      writeFileSync(join(base.dir, acceptedPath, 'parts.json'), JSON.stringify(assembled));
    }
    const project = base.load();
    // Synthetic pre-receipt approval, shaped like the existing legacy fixture.
    // It must be a stage-level signoff before the producer's cited build date.
    project.drafts = [{ id: 'synthetic-depth', parts: { path: acceptedPath } }];
    project.signoffs = [
      { stage: 'parts-review', checkpoint: null, draft_id: 'synthetic-earlier', by: 'user', at: '2026-11-06T00:00:00Z', verbatim: 'Approve the earlier synthetic parts.' },
      { stage: 'parts-review', checkpoint: null, draft_id: 'synthetic-depth', by: 'user', at: '2026-11-07T00:00:00Z', verbatim: 'Approve these synthetic parts.' },
    ];
    put(base.dir, 'project.json', project);
    return { ...base, acceptedPath };
  }

  function boundDepthSetup() {
    const base = depthSetup();
    // Parts-owned receipt declarations: Create does not reconstruct inference.
    put(base.dir, 'source/rectangle.json.binding.json', { spec: 'rig-parts-depth-map-binding/1', part: 'rectangle', mapSha256: 'd'.repeat(64), inputSha256: 'c'.repeat(64) });
    return { ...base, args: [...base.args, '--depth-map-binding', 'source/rectangle.json.binding.json'] };
  }

  test('#559 registration retains raw Parts receipt bytes, sha256 and spec independently of source files', () => {
    const { dir, args, load } = boundDepthSetup();
    const bytes = readFileSync(join(dir, 'source/rectangle.json.binding.json'));
    rigVersionCommand(args);
    const version = obj(arr(load().versions)[0]), registration = obj(version.registration);
    const binding = obj(arr(obj(registration.depth).map_bindings)[0]);
    expect(binding).toMatchObject({ part: 'rectangle', spec: 'rig-parts-depth-map-binding/1', sha256: jobHash(bytes) });
    expect(arr(registration.files)).toContainEqual({ path: binding.path, sha256: binding.sha256 });
    expect(readFileSync(join(dir, String(binding.path)))).toEqual(bytes);
    rmSync(join(dir, 'source'), { recursive: true });
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test('#559 repeated flags retain every applied map and a partial set names the missing part', () => {
    const { dir, args, load } = boundDepthSetup();
    const parts = JSON.parse(readFileSync(join(dir, 'source/parts/parts.json'), 'utf8'));
    const second = structuredClone(parts.parts[0]);
    second.name = 'second'; second.from = 'full:author:second';
    second.depth.image = 'second_depth.png';
    second.depth.sources[0] = { ...second.depth.sources[0], from: second.from, image: 'second.json', sha256: 'e'.repeat(64) };
    parts.parts.push(second); put(dir, 'source/parts/parts.json', parts);
    const art = readFileSync(join(dir, 'source/parts/parts/rectangle.png'));
    for (const path of ['source/parts/parts/second.png', 'source/parts/parts/second_depth.png', 'source/rig/images/second_depth.png']) writeFileSync(join(dir, path), art);
    const manifest = JSON.parse(readFileSync(join(dir, 'source/manifest.json'), 'utf8'));
    manifest.parts.push({ ...manifest.parts[0], part: 'second' }); put(dir, 'source/manifest.json', manifest);
    const report = JSON.parse(readFileSync(join(dir, 'source/parts/depth-report.json'), 'utf8'));
    report.parts.push({ ...report.parts[0], part: 'second', mapSha256: 'e'.repeat(64) });
    report.manifestSha256 = jobHash(readFileSync(join(dir, 'source/manifest.json'))); put(dir, 'source/parts/depth-report.json', report);
    const sheets = JSON.parse(readFileSync(join(dir, 'source/rig/depth_sheets.json'), 'utf8'));
    sheets.parts.push({ part: 'second', size: [8, 16], depth: second.depth }); put(dir, 'source/rig/depth_sheets.json', sheets);
    approveFrozenParts(dir, load(), args);
    testClock.set(new Date(DEPTH_MAP_BINDING_SINCE));
    const error = refused(args, 'RIG_DEPTH_MAP_BINDING_MISSING');
    expect(error.message).toContain('map_bindings[second]');
    put(dir, 'source/second.json.binding.json', { spec: 'rig-parts-depth-map-binding/1', part: 'second', mapSha256: 'e'.repeat(64), inputSha256: 'c'.repeat(64) });
    rigVersionCommand([...args, '--depth-map-binding', 'source/second.json.binding.json']);
    expect(arr(obj(obj(obj(arr(load().versions)[0]).registration).depth).map_bindings)).toHaveLength(2);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test('#559 binding flags require a manifest and a value without writing', () => {
    const { args } = boundDepthSetup();
    refused([...args, '--depth-map-binding'], 'RIG_REGISTRATION_USAGE');
    args.splice(args.indexOf('--depth-manifest'), 2);
    refused(args, 'RIG_REGISTRATION_USAGE');
  });

  test.each(['spec', 'part', 'mapSha256', 'inputSha256', 'extra', 'json', 'duplicate', 'symlink'] as const)('#559 refuses %s receipt before changing project bytes', kind => {
    const { dir, args } = boundDepthSetup();
    const path = join(dir, 'source/rectangle.json.binding.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (kind === 'json') writeFileSync(path, '{');
    else if (kind === 'duplicate') args.push('--depth-map-binding', 'source/rectangle.json.binding.json');
    else if (kind === 'symlink') { renameSync(path, `${path}.original`); symlinkSync(`${path}.original`, path); }
    else { receipt[kind] = kind.endsWith('Sha256') ? 'e'.repeat(64) : 'wrong'; put(dir, 'source/rectangle.json.binding.json', receipt); }
    refused(args, 'RIG_DEPTH_BINDING_INVALID');
    expect(existsSync(join(dir, 'evidence/v1/registration'))).toBe(false);
    expect(existsSync(join(dir, 'outputs/v1'))).toBe(false);
  });

  test('#559 receipt absence warns for older registrations and refuses on the landing boundary, regardless of build date', () => {
    const { dir, args, load } = depthSetup();
    rigVersionCommand(args);
    const project = load(), version = obj(arr(project.versions)[0]), registration = obj(version.registration);
    expect(Date.parse(String(version.at))).toBeLessThan(Date.parse(DEPTH_MAP_BINDING_SINCE));
    for (const [at, count] of [['2026-11-18T23:59:59Z', 0], [DEPTH_MAP_BINDING_SINCE, 1]] as const) {
      registration.at = at;
      const warnings: import('../src/check.ts').Finding[] = [];
      const findings = rigRegistrationFindings(dir, project, warnings);
      expect(findings.filter(f => f.code === 'RIG_DEPTH_MAP_BINDING_MISSING')).toHaveLength(count);
      expect(warnings.filter(f => f.code === 'RIG_DEPTH_MAP_BINDING_MISSING')).toHaveLength(1 - count);
    }
    testClock.set(new Date(DEPTH_MAP_BINDING_SINCE));
    const fresh = depthSetup();
    approveFrozenParts(fresh.dir, fresh.load(), fresh.args);
    testClock.set(new Date(DEPTH_MAP_BINDING_SINCE));
    refused(fresh.args, 'RIG_DEPTH_MAP_BINDING_MISSING');
  });

  test('#559 current bound registration passes and retained tampering refuses in every era', () => {
    const { dir, args, load } = boundDepthSetup();
    const approval = approveFrozenParts(dir, load(), args);
    testClock.set(new Date(DEPTH_MAP_BINDING_SINCE));
    rigVersionCommand(args);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    const project = load(), version = obj(arr(project.versions)[0]), registration = obj(version.registration);
    expect(version.accepted_parts).toEqual(approval);
    const binding = obj(arr(obj(registration.depth).map_bindings)[0]);
    writeFileSync(join(dir, String(binding.path)), '{}\n');
    registration.at = '2026-11-18T23:59:59Z';
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
  });

  test('#559 depth moves prescribe inference, bind, apply, registration and unchanged-input receipt reuse', () => {
    const project: JsonObject = { interview: { waypoints: [{ id: 'turn', guide: { delegated: false, value: { mode: 'depth' }, by: 'user', at: DEPTH_MAP_BINDING_SINCE, verbatim: 'Head turn.' } }] } };
    const moves = depthPlanMoves(project).map(move => move.act).join('\n');
    expect(moves.indexOf('depth-bind')).toBeLessThan(moves.indexOf('depth-apply'));
    expect(moves).toContain('inputSha256 is unchanged');
    expect(moves).toContain('never bind an old map');
    expect(moves).toContain('--depth-map-binding');
  });

  describe('#563 a head-turn answer and a registered body group', () => {
    function bodySetup(body: JsonObject | undefined, mode = 'depth') {
      const base = depthSetup();
      const config = JSON.parse(readFileSync(join(base.dir, 'source/config.json'), 'utf8'));
      if (body !== undefined) config.turn.body = body;
      put(base.dir, 'source/config.json', config);
      const recipe = JSON.parse(readFileSync(join(base.dir, 'source/manifest.json'), 'utf8')).recipeSha256;
      expect(rigVersionCommand(base.args).exit).toBe(0);
      const project = base.load();
      arr(obj(project.interview).waypoints).push({ id: 'turn', guide: { delegated: false, value: { mode }, by: 'user', at: '2026-11-08T00:00:00Z', verbatim: 'Head turn.' } });
      const steps = arr(obj(project.plan).steps);
      steps.push({ ...structuredClone(obj(steps[0])), id: 'turn', rests_on: ['turn'], status: 'in-progress', status_history: [] });
      return { ...base, project, recipe };
    }
    const codes = (dir: string, project: JsonObject): string[] => {
      const warnings: import('../src/check.ts').Finding[] = [];
      rigRegistrationFindings(dir, project, warnings);
      return warnings.filter(w => w.code === 'RIG_TURN_EXTRA_GROUP').map(w => w.message);
    };

    test('names the default body dial with RIG_TURN_EXTRA_GROUP and keeps the recipe sha256', () => {
      const { dir, project, recipe } = bodySetup({ bone: 'rectangle', pivot: 15, roles: { rectangle: 'surface' } });
      expect(turnExtraGroup(dir, project)).toEqual({ version: 1, dial: 'body_yaw_dial', recorded: false });
      const messages = codes(dir, project);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('body_yaw_dial');
      const depth = obj(obj(obj(arr(project.versions)[0]).registration).depth);
      for (const field of ['manifest', 'report'] as const) {
        expect(JSON.parse(readFileSync(join(dir, String(obj(depth[field]).path)), 'utf8')).recipeSha256).toBe(recipe);
      }
    });

    test('names a declared body slider, and a turn step note naming it clears the WARN', () => {
      const { dir, project } = bodySetup({ bone: 'rectangle', pivot: 15, slider: 'torso_dial', roles: { rectangle: 'surface' } });
      expect(codes(dir, project)[0]).toContain('torso_dial');
      const step = obj(arr(obj(project.plan).steps).map(obj).find(s => s.id === 'turn'));
      step.status_history = [{ from_status: 'pending', status: 'in-progress', by: 'agent', at: '2026-11-08T00:00:00Z', note: 'body_yaw_dial is unused.' }];
      expect(codes(dir, project)).toHaveLength(1);
      step.status_history = [{ from_status: 'pending', status: 'in-progress', by: 'agent', at: '2026-11-08T00:00:00Z', note: 'torso_dial is unused: the answer asked for a head turn.' }];
      expect(codes(dir, project)).toEqual([]);
      expect(turnExtraGroup(dir, project)?.recorded).toBe(true);
    });

    test('next names the unused dial as a RIG_TURN_EXTRA_GROUP turn step move until the step is done', () => {
      const { dir, project } = bodySetup({ bone: 'rectangle', pivot: 15, roles: { rectangle: 'surface' } });
      const [move] = turnExtraGroupMoves(dir, project);
      expect(move?.field).toBe('plan.steps[turn].status_history[].note');
      expect(move?.act).toContain('RIG_TURN_EXTRA_GROUP');
      expect(move?.act).toContain('body_yaw_dial');
      expect(move?.act).toContain('--groups head');
      expect(move?.act).toContain('turn.body');
      expect(move?.act).toContain('DEPTH_GROUP_LEFT_OUT');
      obj(arr(obj(project.plan).steps).map(obj).find(s => s.id === 'turn')).status = 'done';
      expect(turnExtraGroupMoves(dir, project)).toEqual([]);
      expect(codes(dir, project)).toHaveLength(1);
    });

    test('#792 selection.leftOut in the sha256-bound depth-report.json clears RIG_TURN_EXTRA_GROUP', () => {
      const { dir, project, recipe } = bodySetup({ bone: 'rectangle', pivot: 15, roles: { rectangle: 'surface', torso: 'surface' } });
      const registration = obj(obj(arr(project.versions)[0]).registration);
      const reportBinding = obj(obj(registration.depth).report);
      const resealReport = (selection: JsonObject | undefined): void => {
        const report = JSON.parse(readFileSync(join(dir, String(reportBinding.path)), 'utf8')) as JsonObject;
        if (selection === undefined) delete report.selection;
        else report.selection = selection;
        const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
        writeFileSync(join(dir, String(reportBinding.path)), bytes);
        reportBinding.sha256 = jobHash(bytes);
        for (const file of arr(registration.files).map(obj)) if (file.path === reportBinding.path) file.sha256 = reportBinding.sha256;
      };
      // A report without selection or with only a subset of body roles left out keeps today's WARN.
      expect(codes(dir, project)).toHaveLength(1);
      resealReport({ groups: ['head'], leftOut: ['rectangle'] });
      expect(codes(dir, project)).toHaveLength(1);
      expect(turnExtraGroup(dir, project)?.recorded).toBe(false);
      // Once selection.leftOut contains the body group, RIG_TURN_EXTRA_GROUP clears without a step note.
      resealReport({ groups: ['head'], leftOut: ['rectangle', 'torso'] });
      expect(codes(dir, project)).toEqual([]);
      expect(turnExtraGroup(dir, project)).toEqual({ version: 1, dial: 'body_yaw_dial', recorded: true });
      expect(turnExtraGroupMoves(dir, project)).toEqual([]);
      expect(JSON.parse(readFileSync(join(dir, String(reportBinding.path)), 'utf8')).recipeSha256).toBe(recipe);
      // Tampering with the report without updating the sha256 binding does not clear the WARN.
      writeFileSync(join(dir, String(reportBinding.path)), `${JSON.stringify({ spec: 'rig-parts-depth-report/1', selection: { groups: ['head'], leftOut: ['rectangle', 'torso'] }, parts: [] })}\n`);
      expect(codes(dir, project)).toHaveLength(1);
      expect(turnExtraGroup(dir, project)?.recorded).toBe(false);
    });

    test('#792 registration accepts a head-only depth-report selection and refuses a left-out part that keeps a sheet', () => {
      const { dir, args, load } = boundDepthSetup();
      const manifest = JSON.parse(readFileSync(join(dir, 'source/manifest.json'), 'utf8'));
      manifest.parts.push({ ...manifest.parts[0], part: 'torso' });
      put(dir, 'source/manifest.json', manifest);
      const report = JSON.parse(readFileSync(join(dir, 'source/parts/depth-report.json'), 'utf8'));
      report.manifestSha256 = jobHash(readFileSync(join(dir, 'source/manifest.json')));
      report.selection = { groups: ['head'], leftOut: ['torso'] };
      put(dir, 'source/parts/depth-report.json', report);
      const parts = JSON.parse(readFileSync(join(dir, 'source/parts/parts.json'), 'utf8'));
      parts.parts.push({ ...structuredClone(parts.parts[0]), name: 'torso', from: 'full:author:torso' });
      delete parts.parts[1].depth;
      put(dir, 'source/parts/parts.json', parts);
      writeFileSync(join(dir, 'source/parts/parts/torso.png'), readFileSync(join(dir, 'source/parts/parts/rectangle.png')));
      approveFrozenParts(dir, load(), args);
      testClock.set(new Date(DEPTH_MAP_BINDING_SINCE));
      expect(rigVersionCommand(args).exit).toBe(0);
      expect(rigRegistrationFindings(dir, load())).toEqual([]);
      // If a left-out part still carries a depth declaration in assembled parts, registration check refuses.
      const registeredParts = JSON.parse(readFileSync(join(dir, 'outputs/v1/out/parts.json'), 'utf8'));
      registeredParts.parts[1].depth = registeredParts.parts[0].depth;
      const bytes = Buffer.from(`${JSON.stringify(registeredParts)}\n`);
      writeFileSync(join(dir, 'outputs/v1/out/parts.json'), bytes);
      const p = load(), v = obj(arr(p.versions)[0]);
      for (const f of arr(v.outputs).map(obj)) if (f.path === 'outputs/v1/out/parts.json') { f.sha256 = jobHash(bytes); f.bytes = bytes.length; }
      obj(obj(v.registration).copied).bytes = arr(v.outputs).map(obj).reduce((sum, f) => sum + Number(f.bytes), 0);
      expect(rigRegistrationFindings(dir, p).map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');
    });

    test.each([['head only', undefined, 'depth'], ['fixed view', { bone: 'rectangle', pivot: 15, roles: { rectangle: 'surface' } }, 'fixed'], ['empty body roles', { bone: 'rectangle', pivot: 15, roles: {} }, 'depth']] as const)('%s raises no RIG_TURN_EXTRA_GROUP', (_name, body, mode) => {
      const { dir, project } = bodySetup(body === undefined ? undefined : structuredClone(body) as JsonObject, mode);
      expect(turnExtraGroup(dir, project)).toBeNull();
      expect(codes(dir, project)).toEqual([]);
    });
  });

  test('#567 accepted depth output binds the applied source and matches registered depth parts', () => {
    const { dir, args, load, acceptedPath } = acceptedDepthSetup();
    const source = readFileSync(join(dir, acceptedPath, 'parts.json'));
    const manifest = readFileSync(join(dir, 'source/manifest.json'));
    const report = readFileSync(join(dir, 'source/parts/depth-report.json'));
    const sheets = readFileSync(join(dir, 'source/rig/depth_sheets.json'));
    expect(JSON.parse(manifest.toString()).partsSha256).not.toBe(jobHash(source));
    expect(rigVersionCommand(args).exit).toBe(0);
    const project = load(), version = obj(arr(project.versions)[0]);
    const registration = obj(version.registration), depth = obj(registration.depth);
    const output = arr(version.outputs).map(obj).find(file => file.path === 'outputs/v1/out/parts.json')!;
    expect(depth.route).toBe('per-part');
    expect(depth.source_parts_applied).toBe(true);
    expect(obj(depth.source_parts).sha256).toBe(output.sha256);
    expect(readFileSync(join(dir, String(obj(depth.source_parts).path)))).toEqual(source);
    expect(readFileSync(join(dir, String(output.path)))).toEqual(source);
    for (const [field, bytes] of [['manifest', manifest], ['report', report], ['sheets', sheets]] as const) {
      expect(readFileSync(join(dir, String(obj(depth[field]).path)))).toEqual(bytes);
    }
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    expect(registeredDepthPartsMatch(dir, version, jobHash(source), String(output.sha256))).toBe(true);
  });

  test.each(['partsSha256', 'manifestSha256'] as const)('#567 applied source still rejects a resealed report with wrong %s', field => {
    const { dir, args, load, acceptedPath } = acceptedDepthSetup();
    const acceptedSha256 = jobHash(readFileSync(join(dir, acceptedPath, 'parts.json')));
    expect(rigVersionCommand(args).exit).toBe(0);
    const project = load(), version = obj(arr(project.versions)[0]);
    const registration = obj(version.registration), depth = obj(registration.depth);
    const output = arr(version.outputs).map(obj).find(file => file.path === 'outputs/v1/out/parts.json')!;
    const binding = obj(depth.report);
    const report = JSON.parse(readFileSync(join(dir, String(binding.path)), 'utf8'));
    report[field] = 'e'.repeat(64);
    const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
    writeFileSync(join(dir, String(binding.path)), bytes);
    binding.sha256 = jobHash(bytes);
    for (const file of arr(registration.files).map(obj)) if (file.path === binding.path) file.sha256 = binding.sha256;
    expect(depth.source_parts_applied).toBe(true);
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');
    expect(registeredDepthPartsMatch(dir, version, acceptedSha256, String(output.sha256))).toBe(false);
  });

  for (const parents of ['absent', 'evidence', 'evidence/v1'] as const) {
    test.each(['manifest parts hash', 'report manifest hash', 'other parts directory', 'missing report'] as const)(`#567 %s refuses without new directories with ${parents} parents`, scenario => {
      const { dir, args } = acceptedDepthSetup();
      if (scenario === 'manifest parts hash') {
        const manifest = JSON.parse(readFileSync(join(dir, 'source/manifest.json'), 'utf8'));
        manifest.partsSha256 = 'e'.repeat(64);
        put(dir, 'source/manifest.json', manifest);
        const report = JSON.parse(readFileSync(join(dir, 'source/parts/depth-report.json'), 'utf8'));
        // Keep the report's manifest byte binding valid, isolating its parts-hash chain.
        report.manifestSha256 = jobHash(readFileSync(join(dir, 'source/manifest.json')));
        put(dir, 'source/parts/depth-report.json', report);
      } else if (scenario === 'report manifest hash') {
        const report = JSON.parse(readFileSync(join(dir, 'source/parts/depth-report.json'), 'utf8'));
        report.manifestSha256 = 'e'.repeat(64);
        put(dir, 'source/parts/depth-report.json', report);
      } else if (scenario === 'other parts directory') {
        cpSync(join(dir, 'source/parts'), join(dir, 'source/other-parts'), { recursive: true });
        expect(readFileSync(join(dir, 'source/other-parts/parts.json'))).toEqual(readFileSync(join(dir, 'source/parts/parts.json')));
        args[args.indexOf('--parts') + 1] = 'source/other-parts';
      } else {
        rmSync(join(dir, 'source/parts/depth-report.json'));
        testClock.set(new Date('2026-11-14T01:00:00Z'));
      }
      // Preserve the fixture's existing evidence bytes outside the destination tree.
      renameSync(join(dir, 'evidence'), join(dir, 'source/prior-evidence'));
      if (parents !== 'absent') mkdirSync(join(dir, parents), { recursive: true });
      const inventory = (): Map<string, Buffer | null> => {
        const files = new Map<string, Buffer | null>();
        const visit = (root: string): void => {
          for (const entry of readdirSync(join(dir, root), { withFileTypes: true })) {
            const path = root ? `${root}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { files.set(path, null); visit(path); }
            else files.set(path, readFileSync(join(dir, path)));
          }
        };
        visit('');
        return files;
      };
      const before = inventory();
      refused(args, scenario === 'missing report' ? 'RIG_DEPTH_BINDING_MISSING' : 'RIG_DEPTH_BINDING_INVALID');
      expect(inventory()).toEqual(before);
      expect(existsSync(join(dir, 'evidence/v1'))).toBe(parents === 'evidence/v1');
      for (const path of ['outputs', 'outputs/v1', 'evidence/v1/registration', 'derived/review']) expect(existsSync(join(dir, path))).toBe(false);
    });
  }

  test('#567 predepth accepted source retains exact bytes and the original depth binding', () => {
    const { dir, args, load, acceptedPath } = acceptedDepthSetup(true);
    const source = readFileSync(join(dir, acceptedPath, 'parts.json'));
    const applied = readFileSync(join(dir, 'source/parts/parts.json'));
    expect(rigVersionCommand(args).exit).toBe(0);
    const project = load(), version = obj(arr(project.versions)[0]);
    const depth = obj(obj(version.registration).depth);
    expect(depth.source_parts_applied).toBeUndefined();
    expect(readFileSync(join(dir, String(obj(depth.source_parts).path)))).toEqual(source);
    expect(readFileSync(join(dir, 'outputs/v1/out/parts.json'))).toEqual(applied);
    expect(obj(depth.source_parts).sha256).toBe(jobHash(source));
    expect(JSON.parse(readFileSync(join(dir, String(obj(depth.manifest).path)), 'utf8')).partsSha256).toBe(jobHash(source));
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    expect(registeredDepthPartsMatch(dir, version, jobHash(source), jobHash(applied))).toBe(true);
    expect(jobHash(JSON.stringify(depth))).toMatchInlineSnapshot('"bff10528a3d7c3db783376855079cbbfa85b1c352c2f79899f4a28762f344c33"');
    expect(jobHash(JSON.stringify(version))).toMatchInlineSnapshot(`"0a922bab292036c70df1aae621ed05ba94c9cc6a17bf56ce4cda95fcd0ffe8e4"`);
  });

  test('retains per-part manifest/report/sheets by exact bytes and checks their producer spec', () => {
    const { dir, args, load } = depthSetup();
    const source = readFileSync(join(dir, 'source/manifest.json'));
    expect(rigVersionCommand(args).exit).toBe(0);
    const version = obj(arr(load().versions)[0]);
    const depth = obj(obj(version.registration).depth);
    expect(depth.route).toBe('per-part');
    expect(readFileSync(join(dir, String(obj(depth.manifest).path)))).toEqual(source);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    writeFileSync(join(dir, String(obj(depth.manifest).path)), '{}');
    expect(rigRegistrationFindings(dir, load()).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
  });

  test('a synthetic answer to the new turn/view question drives the depth plan and positive registration', () => {
    const { dir, args, load } = depthSetup();
    const chosen = TURN_OPTIONS[1];
    const p = load();
    arr(obj(p.interview).waypoints).push({ id: 'turn', config: ['turn', 'depth'], prompts: [{ id: 'view', text: TURN_QUESTION }], history: [],
      guide: { delegated: false, by: 'synthetic-owner', at: '2026-11-14T01:00:00Z', verbatim: chosen.label, source: 'synthetic new-question fixture', value: { ...chosen.fragment }, asks: [{ id: 'view', state: 'user' }] } });
    arr(obj(p.plan).steps).push({ id: 'turn', phase: 'rig', order: 2.5, rests_on: ['turn'], status: 'pending', does: 'Prepare and apply depth before rig', produces: 'Producer depth reports', bar: 'Producer depth files are bound', checkpoint_proposed: false, checkpoint: null });
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
    put(dir, 'source/depth-citations.json', { turn: [{ entry: 'new synthetic head turn', guide: 'turn', quote: chosen.label, asks: ['view'] }] });
    put(dir, 'source/at-source.json', { finished_at: '2026-11-14T01:30:00Z' });
    testClock.set(new Date('2026-11-14T02:00:00Z'));
    expect(depthPlanFindings({ ...p, stage: 'rigging' }, [])).toEqual([]);
    expect(rigVersionCommand(args).exit).toBe(0);
    expect(obj(obj(obj(arr(load().versions)[0]).provenance).sections).turn).toEqual([{ entry: 'new synthetic head turn', guide: 'turn', quote: chosen.label, asks: ['view'] }]);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test('depth-only manifest enrichment is accepted, while changed art declarations are not', () => {
    const { dir, args, load } = depthSetup();
    expect(rigVersionCommand(args).exit).toBe(0);
    const p = load(), v = obj(arr(p.versions)[0]), registration = obj(v.registration), depth = obj(registration.depth);
    const original = JSON.parse(readFileSync(join(dir, 'source/parts/parts.json'), 'utf8'));
    delete original.parts[0].depth;
    const bytes = Buffer.from(JSON.stringify(original)), path = 'evidence/v1/registration/depth-source-parts.json';
    writeFileSync(join(dir, path), bytes);
    depth.source_parts = { path, sha256: jobHash(bytes) };
    arr(registration.files).push(depth.source_parts);
    const output = arr(v.outputs).map(obj).find(f => f.path === 'outputs/v1/out/parts.json')!;
    expect(registeredDepthPartsMatch(dir, v, jobHash(bytes), String(output.sha256))).toBe(true);
    original.parts[0].x += 1;
    const changed = Buffer.from(JSON.stringify(original)); writeFileSync(join(dir, path), changed);
    obj(depth.source_parts).sha256 = jobHash(changed);
    const reseal = (binding: JsonObject, value: JsonObject): void => {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      writeFileSync(join(dir, String(binding.path)), bytes); binding.sha256 = jobHash(bytes);
      for (const row of arr(registration.files).map(obj)) if (row.path === binding.path) row.sha256 = binding.sha256;
    };
    const manifestBinding = obj(depth.manifest), reportBinding = obj(depth.report);
    const manifest = JSON.parse(readFileSync(join(dir, String(manifestBinding.path)), 'utf8')) as JsonObject;
    manifest.partsSha256 = jobHash(changed); reseal(manifestBinding, manifest);
    const report = JSON.parse(readFileSync(join(dir, String(reportBinding.path)), 'utf8')) as JsonObject;
    report.partsSha256 = jobHash(changed); report.manifestSha256 = manifestBinding.sha256!; reseal(reportBinding, report);
    // All producer and retained hashes now agree; only the non-depth geometry differs.
    expect(rigRegistrationFindings(dir, p)).toEqual([]);
    expect(registeredDepthPartsMatch(dir, v, jobHash(changed), String(output.sha256))).toBe(false);
  });

  test('per-layer route keeps the existing config.depth image binding without an inference manifest', () => {
    const { dir, args, load } = depthSetup(true);
    expect(rigVersionCommand(args).exit).toBe(0);
    const registration = obj(obj(arr(load().versions)[0]).registration);
    expect(obj(registration.depth).route).toBe('per-layer');
    expect(obj(registration.depth).manifest).toBeUndefined();
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(arr(registration.files).some(raw => obj(raw).path === 'evidence/v1/registration/inputs/depth/full/layers/rectangle/image')).toBe(true);
  });

  test.each(['manifest', 'sheets', 'report'] as const)('missing %s refuses before changing the project', missing => {
    const { dir, args } = depthSetup();
    if (missing === 'manifest') args.splice(args.indexOf('--depth-manifest'), 2);
    if (missing === 'sheets') rmSync(join(dir, 'source/rig/depth_sheets.json'));
    if (missing === 'report') rmSync(join(dir, 'source/parts/depth-report.json'));
    testClock.set(new Date('2026-11-14T01:00:00Z'));
    refused(args, 'RIG_DEPTH_BINDING_MISSING');
  });

  test('a producer report bound to another manifest refuses and leaves the record byte-identical', () => {
    const { dir, args } = depthSetup();
    const report = JSON.parse(readFileSync(join(dir, 'source/parts/depth-report.json'), 'utf8'));
    report.manifestSha256 = 'd'.repeat(64);
    put(dir, 'source/parts/depth-report.json', report);
    refused(args, 'RIG_DEPTH_BINDING_INVALID');
  });

  test.each(['sourceSha256', 'sheetSha256', 'mapSha256', 'inputSha256'] as const)('another rig %s cannot be paired with this report', field => {
    const { dir, args } = depthSetup();
    const report = JSON.parse(readFileSync(join(dir, 'source/parts/depth-report.json'), 'utf8'));
    report.parts[0][field] = 'e'.repeat(64);
    put(dir, 'source/parts/depth-report.json', report);
    refused(args, 'RIG_DEPTH_BINDING_INVALID');
  });

  test.each(['partsSha256', 'recipeSha256', 'rigConfigSha256'] as const)('missing mandatory digest %s is invalid even when both reports omit it', field => {
    const { dir, args } = depthSetup();
    const manifest = JSON.parse(readFileSync(join(dir, 'source/manifest.json'), 'utf8'));
    const report = JSON.parse(readFileSync(join(dir, 'source/parts/depth-report.json'), 'utf8'));
    delete manifest[field]; delete report[field];
    put(dir, 'source/manifest.json', manifest);
    report.manifestSha256 = jobHash(readFileSync(join(dir, 'source/manifest.json')));
    put(dir, 'source/parts/depth-report.json', report);
    refused(args, 'RIG_DEPTH_BINDING_INVALID');
  });

  test('a valid prepare/apply pair cannot be attached to unrelated consumed sheet sources', () => {
    const { dir, args } = depthSetup();
    const sheets = JSON.parse(readFileSync(join(dir, 'source/rig/depth_sheets.json'), 'utf8'));
    sheets.parts[0].depth.sources[0].sha256 = 'e'.repeat(64);
    put(dir, 'source/rig/depth_sheets.json', sheets);
    refused(args, 'RIG_DEPTH_BINDING_INVALID');
  });

  test('an unregistered depth rig before the boundary WARNs, and on the boundary refuses', () => {
    const { dir } = depthSetup();
    const configPath = 'source/config.json';
    const config = { path: configPath, sha256: jobHash(readFileSync(join(dir, configPath))) };
    for (const [at, count] of [['2026-11-13T23:59:59Z', 0], ['2026-11-14T00:00:00Z', 1]] as const) {
      const project: JsonObject = { versions: [{ n: 1, kind: 'rig', at, provenance: { config } }] };
      const warnings: import('../src/check.ts').Finding[] = [];
      const findings = rigRegistrationFindings(dir, project, warnings);
      expect(findings.filter(f => f.code === 'RIG_DEPTH_BINDING_MISSING')).toHaveLength(count);
      expect(warnings.filter(f => f.code === 'RIG_DEPTH_BINDING_MISSING')).toHaveLength(1 - count);
    }
  });
});
