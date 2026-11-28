import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { startJobHost } from '@rig-c/review/job-host';
import { readPlatePainting, readSourceMask } from '@rig-c/parts/src/plate.ts';
import { TURN_OPTIONS, TURN_QUESTION } from '../src/waypoints.ts';
import { DEPTH_MAP_BINDING_SINCE, depthPlanFindings, depthPlanMoves, registeredDepthPartsMatch, rigRegistrationFindings, turnExtraGroup, turnExtraGroupMoves, turnMissingBodyGroup } from '../src/rig-version.ts';
import { RIG_CHECK_REPORT_SINCE } from '../src/rig-check-report.ts';
import { checkProject as checkRecordProject } from '../src/check.ts';
import { checkProject, testClock } from './clock.ts';
import { plateReceiptSpec } from '../src/config-inputs.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, waypoint } from './fixtures.ts';
import { clockedCli, run } from './helpers.ts';
import { seedStoredReviewVerdictAct, seedStoredVerdict } from './historical-review-fixture.ts';
import { framedRigPin } from './comment-anchor-shapes.ts';
import { openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding, reconcilePublication } from '../src/job-outbox.ts';
import { prepareLiveManifest, readPublished, readRecordPublished } from '../src/job-publication.ts';
import { seedRetainedDraft, seedRetainedReviewPackage, seedRetainedRigVersion } from './numbered-seed.ts';

/** Retired accepted-parts contract date (#981): kept as a fixture time only. */
const RIG_PARTS_APPROVAL_SINCE = '2026-11-19T00:00:00Z';

const roots: string[] = [];
const frozen = join(import.meta.dir, 'fixtures/rig-registration');
afterEach(() => { testClock.reset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function put(dir: string, path: string, value: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}
function seedRig(args: string[]) {
  return seedRetainedRigVersion(args, testClock.now());
}
function setup(review = false) {
  const dir = fixture(project => {
    project.stage = review ? 'rig-review' : 'interview';
    if (!review) project.signoffs = [];
    else project.signoffs = arr(project.signoffs).filter(s => !['rig-review', 'post-interview', 'direction-review'].includes(String(obj(s).stage)));
    project.versions = [];
    project.reopens = [];
    for (const step of obj(project.plan).steps as JsonObject[]) step.status = review && step.phase === 'rig' ? 'done' : 'pending';
  });
  roots.push(dirname(dir));
  testClock.set(new Date('2026-11-08T00:00:00Z'));
  for (const path of ['outputs', 'derived/review']) rmSync(join(dir, path), { recursive: true, force: true });
  cpSync(frozen, join(dir, 'source'), { recursive: true });
  put(dir, 'source/config.json', { key: 'synthetic', requirements: 'requirements.json' });
  put(dir, 'source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: { required: true } });
  put(dir, 'source/adapter.json', []);
  const painting = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
  put(dir, 'source/parts/parts.json', {
    rig_size: [8, 16], scale_rig_per_source: 1, ghost_px: {},
    painting_in_rig: { path: 'painting_in_rig.png', sha256: jobHash(painting), resample: 'lanczos3-rgb-opaque' },
    parts: [{
      name: 'rectangle', from: 'painting:rectangle', x: 0, y: 0, w: 8, h: 16,
      opaque_px: 128, projected_core_px: 128, source_px_taken: 128, refused_drift_px: 0, merged_px: 0, seam_override_px: 0,
    }],
  });
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
  put(f.dir, `${draft}/full/layers.json`, {
    width: 8, height: 16, layers: layers.map(name => ({
      name, filename: `${name}.png`, left: 0, top: 0, right: 8, bottom: 16, depth_median: 0.5,
    })),
  });
  put(f.dir, config, {
    key: 'synthetic', scene: {}, seethrough: { resolution: 16, steps: 1, seed: 0, offload: false },
    assemble: { rig_scale: 1, plan: [['rectangle', 'full', 'topwear']] },
    bones: [{ name: 'anchor', parent: 'root', at: [0, 0] }], meshes: {}, regions: { rectangle: 'anchor' },
    motion: { duration: 1, tracks: [{ bone: 'anchor', prop: 'translatey', amp: 1, period: 1, phase: 0 }] },
  });
  const env = { ...process.env, CODEX_HOME: join(dirname(f.dir), 'codex-home'), SOURCE_DATE_EPOCH: String(testClock.now() / 1000) };
  const parts = (...args: string[]) => run([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/cli.ts'), ...args], f.dir, env);
  const assembled = parts('assemble', '--source', painting, '--full', `${draft}/full`, '--config', config, '--out', assembly);
  expect(assembled.stderr).toBe('');
  expect(assembled.code).toBe(0);
  const rigged = parts('rig', '--parts', `${assembly}/rig`, '--config', config, '--out', `${draft}/rig-out`);
  expect(rigged.stderr).toBe('');
  expect(rigged.code).toBe(0);
  expect(seedRetainedDraft(['plate-fixture', f.dir, '--from', `${draft}/rig-out`, '--parts', `${assembly}/rig`, '--config', config], testClock.now()).exit).toBe(0);
  f.args[f.args.indexOf('--parts') + 1] = `${assembly}/rig`;
  f.args[f.args.indexOf('--rig') + 1] = `${draft}/rig-out`;
  f.args.push('--run-record', `${draft}/rig-out/run.json`);
  return { ...f, assembly, painting };
}

describe('#871 retained assemble plate source checking', () => {
  test('Parts and Create reject a changed mask in a retained registration', () => {
    const { dir, args, painting } = setupPlateAssembly();
    expect(seedRig(args).exit).toBe(0);
    expect(checkProject(dir).refusals).toEqual([]);

    const source = readPlatePainting(join(dir, painting));
    const maskDir = join(dir, 'outputs/v1/plate-assemble/rig');
    const readMask = () => readSourceMask('figure-mask', maskDir, 8, 16, source.raster, source.bytes);
    expect(readMask().inside.reduce((sum, pixel) => sum + pixel, 0)).toBe(128);
    const maskPath = 'outputs/v1/plate-assemble/rig/figure_rig.png';
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
  const bytes = `${JSON.stringify({
    schema: 'rig-review-parts-verdict/2', tool, source: { sha256: 'a'.repeat(64), files },
    status: 'approved', parts: {},
  })}\n`;
  const path = `evidence/review-reads/${jobHash(bytes)}.json`;
  put(dir, path, bytes);
  const evidence = { ...bind(path), kind: 'parts-verdict', spec: 'rig-create/parts-verdict-cli@1' };
  const at = '2026-11-18T12:00:00.000Z';
  const draftId = 'synthetic-frozen';
  project.drafts = [{ id: draftId, config, parts: { path: partsPath, files } }];
  project.review_acts = [{
    kind: 'parts-verdict', schema: evidence.spec, route: 'cli', draft_id: draftId, by: 'user', at,
    argv: ['opaque/input', '--verdict', 'opaque/verdict.json'], evidence, tool, status: 'approved', flagged: [], noted: [],
  }];
  put(dir, 'evidence/frozen-structure.json', { schema: 'rig-create/structure-decisions@0', draft_id: draftId, config, entries: [] });
  project.signoffs = [{
    stage: 'parts-review', checkpoint: null, draft_id: draftId, by: 'user', at,
    verbatim: 'Approve the synthetic frozen parts.', evidence, structure: bind('evidence/frozen-structure.json'),
  }];
  put(dir, 'project.json', project);
  return { signoff_at: at, evidence };
}

test('#981 frozen registration without a parts approval validates cleanly', () => {
  const f = setup();
  testClock.set(new Date(RIG_PARTS_APPROVAL_SINCE));
  seedRig(f.args);
  expect(existsSync(join(f.dir, 'outputs/v1'))).toBe(true);
  expect(rigRegistrationFindings(f.dir, f.load())).toEqual([]);
});

describe('#573 frozen Parts check report reader', () => {
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
    const report: JsonObject = {
      spec: 'rig-parts-check/1', build: { model_sha256: modelHash },
      bar_outcomes: { gate: { status: 'PASS' }, loop: { status: 'SKIP', reason: 'no-idle' } },
      requirements: { lines: { steady: { status: 'PASS' } } },
    };
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
    expect(seedRig(f.args).exit).toBe(0);
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
    expect(seedRig([...f.args, ...reportFlag]).exit).toBe(0);
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
    f.report.PASS = false;
    f.report.loop_max_diff = 99;
    f.store();
    const bytes = readFileSync(join(f.dir, source));
    expect(seedRig([...f.args, ...reportFlag]).exit).toBe(0);
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

  test('spec’d report with missing or mismatched model digest refuses in registration reader', () => {
    const f = withCheck(RIG_CHECK_REPORT_SINCE);
    f.store();
    expect(seedRig([...f.args, ...reportFlag]).exit).toBe(0);
    const { project, registration } = f.projectWithRegistration();
    const badMissing = Buffer.from(`${JSON.stringify({ ...f.report, build: {} })}\n`);
    writeFileSync(join(f.dir, retained), badMissing);
    obj(registration.check_report).sha256 = jobHash(badMissing);
    obj(registration.check_report).bytes = badMissing.length;
    expect(rigRegistrationFindings(f.dir, project).map(r => r.code)).toContain('RIG_CHECK_REPORT_MODEL_HASH_INVALID');

    const wrongHash = jobHash('a different synthetic compiled model');
    const badMismatch = Buffer.from(`${JSON.stringify({ ...f.report, build: { model_sha256: wrongHash } })}\n`);
    writeFileSync(join(f.dir, retained), badMismatch);
    obj(registration.check_report).sha256 = jobHash(badMismatch);
    obj(registration.check_report).bytes = badMismatch.length;
    const mismatchFindings = rigRegistrationFindings(f.dir, project);
    expect(mismatchFindings.map(r => r.code)).toContain('RIG_CHECK_REPORT_MODEL_MISMATCH');
  });

  test('pre-contract reds warn individually, including array-free requirement names', () => {
    const f = withCheck(beforeGate);
    redReport(f.report);
    f.store();
    expect(seedRig([...f.args, ...reportFlag]).exit).toBe(0);
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
    const all = [...args, '--accept-check-bar', 'shared', '--accept-check-line', 'shared', '--accept-check-line', 'unmeasured', ...chat];
    expect(seedRig(all).exit).toBe(0);
    const { project, registration } = f.projectWithRegistration();
    const binding = obj(registration.check_report);
    const authority = { by: 'user', owner_words: words, at: registration.at, said_at: beforeGate, relayed_by: 'operator', source: 'owner chat, relayed' };
    expect(binding.acceptances).toEqual([
      { kind: 'bar', id: 'shared', ...authority }, { kind: 'line', id: 'shared', ...authority }, { kind: 'line', id: 'unmeasured', ...authority },
    ]);
    expect(rigRegistrationFindings(f.dir, project)).toEqual([]);
    const invalidAcceptance = structuredClone(project);
    arr(obj(obj(obj(arr(invalidAcceptance.versions)[0]).registration).check_report).acceptances).push({ kind: 'bar', id: 'loop', ...authority });
    expect(rigRegistrationFindings(f.dir, invalidAcceptance).map(r => r.code)).toContain('RIG_CHECK_ACCEPTANCE_INVALID');
    delete obj(arr(binding.acceptances)[0]).owner_words;
    expect(rigRegistrationFindings(f.dir, project).map(finding => finding.code)).toEqual(['OWNER_CHAT_INVALID', barFailure.code]);
    delete binding.acceptances;
    const checkFindings = checkProject(f.dir, project).refusals;
    expect(checkFindings.filter(w => [barFailure.code, lineFailure.code].includes(w.code)).map(({ code, path }) => ({ code, path })))
      .toEqual([barFailure, lineFailure, unmeasurable]);
  });

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
    expect(seedRig([...f.args, ...reportFlag]).exit).toBe(0);
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
    const words = 'I accept the source exposure.\n';
    put(f.dir, 'source/words.txt', words);
    const chat = ['--check-accepted-by', 'user', '--owner-chat', 'source/words.txt', '--said-at', beforeGate, '--relayed-by', 'operator'];
    expect(seedRig([...args, '--accept-check-exposure', ...chat]).exit).toBe(0);
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
    expect(seedRig([...f.args, ...reportFlag]).exit).toBe(0);
    const warnings: Parameters<typeof rigRegistrationFindings>[2] = [];
    expect(rigRegistrationFindings(f.dir, f.load(), warnings)).toEqual([]);
    expect(warnings.map(({ code, path }) => ({ code, path }))).toEqual([exposureFailure]);
    const { project, registration } = f.projectWithRegistration();
    const badReport = Buffer.from(`${JSON.stringify({ ...f.report, SOURCE_EXPOSURE: { ...exposureBlock('PASS'), status: 'SKIP' } })}\n`);
    writeFileSync(join(f.dir, retained), badReport);
    obj(registration.check_report).sha256 = jobHash(badReport);
    obj(registration.check_report).bytes = badReport.length;
    expect(rigRegistrationFindings(f.dir, project).map(r => r.code)).toContain('RIG_CHECK_REPORT_INVALID');
  });
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

describe('frozen rig registration reader', () => {
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
      assemble: {
        edited_parts: {
          dir: editedDir, receipts: names.map((file, index) => ({
            part: index === 0 ? 'rectangle' : 'accent', file,
            sha256: jobHash(imageBytes[index]!), from_sha256: jobHash(imageBytes[index]!), editor: 'synthetic editor',
          })),
        },
      },
    });
    put(base.dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    base.args[base.args.indexOf('--config') + 1] = configPath;
    return { ...base, args: [...base.args, '--citations', 'source/citations.json'], imageBytes, names, editedDir, configPath };
  }

  function assertEditedPartsAccepted(f: ReturnType<typeof setupEditedParts>) {
    const original = readFileSync(join(f.dir, f.configPath));
    expect(seedRig(f.args).exit).toBe(0);
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
    expect(rigRegistrationFindings(f.dir, f.load())).toEqual([]);
    expect(checkProject(f.dir).refusals).toEqual([]);
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

  test.each([false, true])('#570 edited_parts relative dir and bare receipts validate (nested=%s)', nested => {
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

  function rebindRequirementsEvidence(dir: string, project: JsonObject, mutate: (requirements: JsonObject) => void) {
    const registration = obj(obj(arr(project.versions)[0]).registration);
    for (const key of ['requirements_source', 'requirements'] as const) {
      const binding = obj(registration[key]);
      const doc = JSON.parse(readFileSync(join(dir, String(binding.path)), 'utf8')) as JsonObject;
      mutate(doc);
      const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
      writeFileSync(join(dir, String(binding.path)), bytes);
      binding.sha256 = jobHash(bytes);
      binding.bytes = bytes.length;
      for (const entry of arr(registration.files).map(obj)) {
        if (entry.path === binding.path) entry.sha256 = binding.sha256;
      }
    }
  }

  test('#409 seven requirements provenance JSON pointers validate in retained registration', () => {
    const { dir, args, load, requirements } = setupProvenancePointers();
    const originalConfig = readFileSync(join(dir, 'source/config.json'));
    const originalRequirements = readFileSync(join(dir, 'source/requirements.json'));
    expect(seedRig(args).exit).toBe(0);
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
    expect(seedRig(args).exit).toBe(0);
    expect(readFileSync(join(dir, 'evidence/v1/registration/requirements-source.json'))).toEqual(original);
    const runtime = JSON.parse(readFileSync(join(dir, 'evidence/v1/registration/requirements.json'), 'utf8'));
    expect(runtime.setup_painting.regions[0]['x-source'].json_pointer).toBe(pointer);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test.each([
    ['declared asset', (requirements: JsonObject) => {
      obj(requirements.setup_painting).figure_mask = { path: '/foreign/mask.png', sha256: '1'.repeat(64) };
    }],
    ['undeclared field', (requirements: JsonObject) => {
      obj(requirements.setup_painting).unlisted = '/foreign/asset.png';
    }],
    ['other provenance field', (requirements: JsonObject) => {
      obj((obj(requirements.setup_painting).regions as JsonObject[])[0]!['x-source']).unlisted = '/foreign/asset.png';
    }],
    ['json_pointer outside x-source', (requirements: JsonObject) => {
      (obj(requirements.setup_painting).regions as JsonObject[])[0]!.json_pointer = '/METRICS/regions/0/pixel_count';
    }],
    ['json_pointer under another extension', (requirements: JsonObject) => {
      (obj(requirements.setup_painting).regions as JsonObject[])[0]!['x-other'] = { json_pointer: '/METRICS/regions/0/pixel_count' };
    }],
  ] as const)('#409 reader refuses a rehashed absolute value in %s', (_name, mutate) => {
    const { dir, args, load } = setupProvenancePointers();
    expect(seedRig(args).exit).toBe(0);
    const candidate = load();
    rebindRequirementsEvidence(dir, candidate, mutate);
    const finding = rigRegistrationFindings(dir, candidate).find(f => f.code === 'RIG_REGISTRATION_FILE_INVALID');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('evidence/v1/registration/requirements.json#/');
    expect(finding!.message).toContain('restore the retained registration inputs');
    expect(checkProject(dir, candidate).refusals.map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
  });

  test.each(['/METRICS/bad~2escape', '/METRICS/trailing~', 'C:\\foreign\\report.json'])('#409 reader refuses rehashed invalid provenance pointer %j', pointer => {
    const { dir, args, load } = setupProvenancePointers();
    expect(seedRig(args).exit).toBe(0);
    const candidate = load();
    rebindRequirementsEvidence(dir, candidate, requirements => {
      (obj(requirements.setup_painting).regions as JsonObject[])[0]!['x-source'] = { json_pointer: pointer };
    });
    const finding = rigRegistrationFindings(dir, candidate).find(f => f.code === 'RIG_REGISTRATION_FILE_INVALID');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('requirements.json#/setup_painting/regions/0/x-source/json_pointer');
    expect(finding!.message).toContain('RFC 6901');
    expect(checkProject(dir, candidate).refusals.map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
  });

  test('reads a retained Bun text lock with trailing commas', () => {
    const { dir, args } = setup();
    put(dir, 'bun.lock', `{
      "lockfileVersion": 2,
      "workspaces": { "": {}, },
      "packages": {
        "@rig-c/parts": ["@rig-c/parts@2.23.4", "", {}, "sha512-YQ=="],
        "@rig-c/core": ["@rig-c/core@3.4.1", "", {}, "sha512-Yg=="],
      },
    }`);
    args[args.indexOf('--toolchain-lock') + 1] = 'bun.lock';
    expect(seedRig(args).exit).toBe(0);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const version = obj(arr(project.versions)[0]);
    expect(version.built_with).toEqual({ '@rig-c/parts': '2.23.4', '@rig-c/core': '3.4.1' });
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
  });

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
      record.inputs = [{
        path: 'inputs/painting.png', sha256: jobHash(source), bytes: source.length,
        origin: 'synthetic original painting', at: new Date(testClock.now()).toISOString(),
      }];
      writeFileSync(join(dir, 'project.json'), `${JSON.stringify(record, null, 2)}\n`);
      const host = await openCreateJob(dir, { id: 'reviewer', role: 'owner' }, testClock.now());
      let reopened: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
      try {
        expect(seedRig(args).exit).toBe(0);
        const root = realpathSync(dir);
        const v1Path = prepareLiveManifest(root, load(), 1);
        enqueuePublication(root, readWriterBinding(root)!, { path: v1Path, selector: { kind: 'rig', version: 1 } });
        expect(await reconcileCreateJob(root)).toBe(1);
        const [v1] = receipts(dir);
        const v1Id = jobHash(JSON.stringify([v1!.jobId, v1!.versionHash, v1!.result]));
        host.stop();
        expect(seedRig(['2', ...args.slice(1)]).exit).toBe(0);
        expect(arr(load().versions).map(v => obj(v).n)).toEqual([1, 2]);
        const v2Path = prepareLiveManifest(root, load(), 2);
        enqueuePublication(root, readWriterBinding(root)!, { path: v2Path, selector: { kind: 'rig', version: 2 } });
        const [v2] = pendingPublications(dir);
        expect(v2!.result.selector).toEqual({ kind: 'rig', version: 2 });
        if (order !== 'named --rig 1' && (v1Id < v2!.id) !== (order === 'v1 sorts first')) continue;
        const bytes = readFileSync(join(dir, 'project.json'));
        const unknown = await runCli(dir, 'job', 'open', dir, '--reviewer', 'reviewer', '--role', 'owner', '--rig', '3');
        expect(unknown.exit).toBe(1);
        expect(unknown.stderr).toStartWith('JOB_PUBLICATION_INVALID: versions[v3]: --rig needs one recorded rig or post version');
        expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
        expect(pendingPublications(dir).map(entry => entry.id)).toEqual([v2!.id]);

        const named = order === 'named --rig 1' ? ['--rig', '1'] : [];
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
        expect(byGeneration.map(receipt => obj(obj(receipt.result).selector).version)).toEqual(order === 'named --rig 1' ? [1, 2, 1] : [1, 1, 2]);
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

  test('strict shared-target checking rejects a plate rebound to a retained file', () => {
    const { dir, args, load } = setupSharedAssets();
    put(dir, 'source/config.json', {
      key: 'synthetic', requirements: 'requirements.json', assemble: {
        occluders: [{ image: 'inputs/plate/plate.png', plate: 'inputs/plate' }],
      },
    });
    put(dir, 'source/adapter.json', [
      { doc: 'config', pointer: '/assemble/occluders/0/image', before: 'inputs/plate/plate.png', after: 'runtime/plate/plate.png' },
      { doc: 'config', pointer: '/assemble/occluders/0/plate', before: 'inputs/plate', after: 'runtime/plate' },
    ]);
    expect(seedRig(args).exit).toBe(0);
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

  test.each(['built_with', 'at_source', 'outputs', 'config_source', 'copied', 'added-frame'])('check observes planted %s drift through the shared validator', field => {
    const { dir, args, load } = setup();
    seedRig(args);
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

  test('validates registration.skipped receipt shape, remains valid after historical archival, and roundtrips through record publication retained root', () => {
    const { dir, args, load } = setup();
    const painting = Buffer.from('Synthetic immutable painting input');
    put(dir, 'inputs/painting.png', painting.toString('utf8'));
    const initial = load();
    initial.inputs = [{ ...(initial.inputs as JsonObject[])[0], path: 'inputs/painting.png', sha256: jobHash(painting), bytes: painting.length }];
    put(dir, 'project.json', initial);
    mkdirSync(join(dir, 'outputs/v1'), { recursive: true });
    seedRig(['2', ...args.slice(1)]);

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
    expect(checkProject(root).refusals).toEqual([]);
    expect(checkRecordProject(retainedRoot, undefined, { now: testClock.now(), readOnly: true, recordPublication: true }).refusals).toEqual([]);
    expect(readRecordPublished({
      root: retainedRoot, record, result: { kind: 'plan' }, phase: 'retained', parts: inventory.parts,
    }, testClock.now())).toEqual(inventory);

    rmSync(join(dir, 'outputs/v1'), { recursive: true });
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);

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

    const { dir: dirNoSkip, args: argsNoSkip, load: loadNoSkip } = setup();
    seedRig(argsNoSkip);
    const unexpectedSkipped = loadNoSkip();
    obj((unexpectedSkipped.versions as JsonObject[])[0]!.registration).skipped = [{ n: 1, destinations: ['outputs/v1'] }];
    expect(rigRegistrationFindings(dirNoSkip, unexpectedSkipped).map(f => f.code)).toContain('RIG_REGISTRATION_INVALID');
  });

  test('checks a reconstructed pre-#394 frozen-rig/1 layout and roundtrips record publication while refusing unlisted mutations', () => {
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

    seedRig([...args, '--citations', 'source/citations.json']);

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
    seedRetainedReviewPackage(['1', dir, '--config', 'evidence/v1/registration/config.json', '--from', 'outputs/v1/out']);

    const pre394Project = load();
    expect(rigRegistrationFindings(dir, pre394Project)).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);

    const root = realpathSync(dir);
    const record = { path: 'project.json' as const, sha256: jobHash(readFileSync(join(root, 'project.json'))) };
    const inventory = readRecordPublished({ root, record, result: { kind: 'plan' }, phase: 'inventory' }, testClock.now());
    const retainedRoot = join(realpathSync(dirname(dir)), 'retained-pre394');
    mkdirSync(retainedRoot);
    for (const file of inventory.files) {
      mkdirSync(dirname(join(retainedRoot, file.path)), { recursive: true });
      cpSync(join(root, file.path), join(retainedRoot, file.path));
    }
    expect(checkProject(root).refusals).toEqual([]);
    expect(checkRecordProject(retainedRoot, undefined, { now: testClock.now(), readOnly: true, recordPublication: true }).refusals).toEqual([]);
    expect(readRecordPublished({
      root: retainedRoot, record, result: { kind: 'plan' }, phase: 'retained', parts: inventory.parts,
    }, testClock.now())).toEqual(inventory);

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

  test('legacy absolute adapter rows on relative values remain unused declarations', () => {
    const { dir, args, load } = setup();
    const config = {
      key: 'synthetic', requirements: 'requirements.json', assemble: {
        editor_receipts: { receipts: [{ file: 'rig/images/rectangle.png' }] },
      },
    };
    const adapter = [
      { at: '.requirements', before: join(dir, 'unused-requirements.json'), after: 'requirements.json' },
      { at: '.assemble.editor_receipts.receipts.0.file', before: join(dir, 'unused-receipt.png'), after: 'rig/images/rectangle.png' },
    ];
    put(dir, 'source/config.json', config);
    put(dir, 'source/adapter.json', adapter);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    expect(seedRig([...args, '--citations', 'source/citations.json']).exit).toBe(0);
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

  test('accepts explicitly cited UTC microseconds and an escaped JSON pointer', () => {
    const { dir, args, load } = setup();
    put(dir, 'source/at-source.json', { 'event/date': { '~at': '2026-11-06T20:44:42.081669+00:00' } });
    args[args.indexOf('--at-pointer') + 1] = '/event~1date/~0at';
    expect(seedRig(args).exit).toBe(0);
    expect((load().versions as JsonObject[])[0]!.at).toBe('2026-11-06T20:44:42.081669+00:00');
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test.each([false, true])('keeps the pointer contract after removing its sole adapter row (removeRequirementsBindings=%s)', removeRequirementsBindings => {
    const { dir, args, load } = setup();
    put(dir, 'source/donor/input.png', 'synthetic receipt');
    const config: JsonObject = {
      key: 'synthetic', requirements: 'requirements.json',
      assemble: { editor_receipts: { receipts: [{ file: 'donor/input.png' }] } },
    };
    put(dir, 'source/config.json', config);
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    expect(seedRig([...args, '--citations', 'source/citations.json']).exit).toBe(0);
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
    obj(registration.path_adapter).bytes = emptyAdapter.length;
    for (const file of registration.files as JsonObject[]) {
      if (file.path === adapterPath) file.sha256 = jobHash(emptyAdapter);
    }
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
    expect(checkProject(dir, project).refusals.map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
  });

  test('pointer-adapted registration reader refuses rehashed runtime config/requirements edits, backdrop byte drift, and removed config pointer rows', () => {
    const { dir, args, load } = setup();
    const backdropBytes = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(dir, 'source/backdrop.png'), backdropBytes);
    put(dir, 'source/donor/receipt.png', 'synthetic receipt bytes');
    put(dir, 'source/requirements.json', {
      spec: 'spine-parts-requirements/1', fps: 4, requirements: [],
      setup_painting: {
        required: true,
        backdrop: { path: 'backdrop.png', sha256: jobHash(backdropBytes) },
      },
    });
    put(dir, 'source/config.json', {
      key: 'synthetic', requirements: 'requirements.json',
      assemble: { editor_receipts: { receipts: [{ file: 'donor/receipt.png' }] } },
    });
    put(dir, 'source/citations.json', { assemble: [{ entry: 'plan[lantern]', guide: 'assemble', quote: 'The lantern is its own part.', asks: ['emphasis'] }] });
    expect(seedRig([...args, '--citations', 'source/citations.json']).exit).toBe(0);
    const cleanProject = load();
    expect(rigRegistrationFindings(dir, cleanProject)).toEqual([]);

    const rebindFile = (candidate: JsonObject, relPath: string, newBytes: Buffer) => {
      writeFileSync(join(dir, relPath), newBytes);
      const h = jobHash(newBytes);
      const ver = (candidate.versions as JsonObject[])[0]!;
      const reg = obj(ver.registration);
      for (const f of reg.files as JsonObject[]) {
        if (f.path === relPath) f.sha256 = h;
      }
      if (relPath === 'evidence/v1/registration/config.json') {
        obj(obj(ver.provenance).config).sha256 = h;
        obj(obj(ver.provenance).config).bytes = newBytes.length;
      }
      if (relPath === 'evidence/v1/registration/requirements.json') {
        obj(reg.requirements).sha256 = h;
        obj(reg.requirements).bytes = newBytes.length;
      }
      if (relPath === 'evidence/v1/registration/path-adapter.json') {
        obj(reg.path_adapter).sha256 = h;
        obj(reg.path_adapter).bytes = newBytes.length;
      }
    };

    {
      const saved = readFileSync(join(dir, 'evidence/v1/registration/config.json'));
      const candidate = structuredClone(cleanProject);
      const runtimeCfg = JSON.parse(saved.toString('utf8')) as JsonObject;
      runtimeCfg.key = 'tampered-key';
      rebindFile(candidate, 'evidence/v1/registration/config.json', Buffer.from(`${JSON.stringify(runtimeCfg, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/config.json'), saved);
    }
    {
      const saved = readFileSync(join(dir, 'evidence/v1/registration/requirements.json'));
      const candidate = structuredClone(cleanProject);
      const runtimeReq = JSON.parse(saved.toString('utf8')) as JsonObject;
      runtimeReq.fps = 99;
      rebindFile(candidate, 'evidence/v1/registration/requirements.json', Buffer.from(`${JSON.stringify(runtimeReq, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/requirements.json'), saved);
    }
    {
      const targetRel = 'evidence/v1/registration/inputs/setup_painting/backdrop/path';
      const saved = readFileSync(join(dir, targetRel));
      const candidate = structuredClone(cleanProject);
      rebindFile(candidate, targetRel, Buffer.from('tampered backdrop bytes'));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, targetRel), saved);
    }
    {
      const saved = readFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'));
      const candidate = structuredClone(cleanProject);
      const rowsOnlyReq = (JSON.parse(saved.toString('utf8')) as JsonObject[]).filter(r => r.doc === 'requirements');
      rebindFile(candidate, 'evidence/v1/registration/path-adapter.json', Buffer.from(`${JSON.stringify(rowsOnlyReq, null, 2)}\n`));
      expect(rigRegistrationFindings(dir, candidate).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
      writeFileSync(join(dir, 'evidence/v1/registration/path-adapter.json'), saved);
    }
    expect(rigRegistrationFindings(dir, cleanProject)).toEqual([]);
  });
});

describe('#812/#929 historical live rig feedback and citation check', () => {
  test.each(['no route', 'routed', 'pinned comment'] as const)('%s', async mode => {
    const { dir: fixtureDir, args, load } = setup(true);
    const dir = realpathSync(fixtureDir);
    const words = '  Add a keyed wind motion.\r\n';
    const painting = readFileSync(join(dir, 'source/rig/images/rectangle.png'));
    writeFileSync(join(dir, 'inputs/painting.png'), painting);
    const project = load();
    project.inputs = [{
      path: 'inputs/painting.png', sha256: jobHash(painting),
      bytes: painting.length, origin: 'synthetic original painting', at: testClock.iso(),
    }];
    const signoffs = arr(project.signoffs);
    for (const signoff of signoffs.map(obj).filter(row => row.stage === 'interview')) delete obj(signoff.answer_hashes).motion;
    approveFrozenParts(dir, project, args);
    project.signoffs = [...signoffs, ...arr(project.signoffs)];
    const draft = obj(arr(project.drafts)[0]);
    const partsPath = String(obj(draft.parts).path);
    const draftRig = 'derived/drafts/synthetic-frozen/rig';
    cpSync(join(dir, 'source/rig'), join(dir, draftRig), { recursive: true });
    cpSync(join(import.meta.dir, '../templates/example-numbered/example-diff/recomposite_rig.png'), join(dir, partsPath, 'recomposite_rig.png'));
    const artifacts = [`${partsPath}/recomposite_rig.png`, ...['rig.json', 'motion.json', 'mesh_report.json'].map(name => `${draftRig}/${name}`)];
    Object.assign(draft, {
      kind: 'draft-rig', at: '2026-11-07T00:00:00Z', producer: { name: '@rig-c/parts', version: '2.52.0' },
      files: artifacts.map(path => ({ path, sha256: jobHash(readFileSync(join(dir, path))) })),
    });
    const partsSignoff = signoffs.map(obj).find(row => row.stage === 'parts-review')!;
    project.diff_map = { ...obj(partsSignoff.diff_map), by: 'agent', at: testClock.iso() };
    put(dir, 'project.json', project);
    expect(checkProject(dir).refusals).toEqual([]);
    const subjects = [{ kind: 'review-verdict', stage: 'rig-review' }] as const;
    const host = await openCreateJob(dir, { id: 'synthetic-owner', role: 'owner' }, testClock.now(), options => startJobHost({
      ...options, readPublished: async input => ({ ...await readPublished(input), subjects }),
    }));
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
      expect(seedRig(args).exit).toBe(0);
      const binding = readWriterBinding(dir)!;
      const path = prepareLiveManifest(dir, load(), 1);
      const result = { path, selector: { kind: 'rig', version: 1 } } as const;
      const entry = enqueuePublication(dir, binding, result);
      const requestId = crypto.randomUUID();
      await reconcilePublication(dir, entry, async pending => {
        const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${binding.jobId}/api`, {
          method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            schema: binding.identity.apiSchema, verb: 'publish', jobId: binding.jobId,
            requestId, idempotencyKey: requestId, expectedGeneration: host.session.status().generation, result,
            freeze: { kind: 'producer-held', holdId: pending.id, record: { path: 'project.json', sha256: pending.recordHash } },
          }),
        }));
        expect(await response.json()).toMatchObject({ ok: true });
        const published = host.session.status().publication!;
        acknowledgePublication(pending, published.publicationId, published.generation, requestId, subjects);
      });
      const publication = host.session.status().publication!;
      const pinnedWords = 'Adjust the wind pose here.';
      const pin = mode === 'pinned comment'
        ? framedRigPin(pinnedWords, {
            sourceHash: publication.source.sourceHash,
            modelHash: publication.source.model!.sha256, target: publication.source.package!.id,
          })
        : undefined;
      const general = mode === 'pinned comment' ? [] : [words];
      const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
        method: 'POST',
        headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schema: 'rig-review/job-api@2', verb: 'ask', jobId: host.session.jobId, requestId: crypto.randomUUID(),
          expectedGeneration: host.session.status().generation, idempotencyKey: crypto.randomUUID(),
          publicationId: publication.publicationId, subject: { kind: 'review-verdict', stage: 'rig-review' },
        }),
      }));
      const ask = await response.json();
      expect(ask.ok).toBe(true);
      if (!ask.ok) throw Error(ask.error.code);
      const pageId = 'synthetic-page';
      const ui = (route: string, body: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, {
        method: 'POST',
        headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const displayed = await host.ports.ackDisplayed(host.session.jobId, ui('displayed', { publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash }));
      if (!displayed.ok) throw Error(displayed.error.code);
      const act = await host.ports.commitUIAct(host.session.jobId, ui('acts', {
        publicationId: publication.publicationId,
        askId: ask.value.askId, pageId, displayedNonce: displayed.value.displayedNonce, expectedGeneration: host.session.status().generation,
        submissionId: 'synthetic-submission', kind: 'review-verdict', value: {
          stage: 'rig-review',
          verdict: 'changes-requested', words: '',
          general, ...(pin ? { feedback: [{ ...obj(pin.anchor), summary: pin.text }] } : {}),
        },
        capture: {
          png: `data:image/png;base64,${painting.toString('base64')}`, width: 8, height: 16,
          camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
          binding: {
            publicationId: publication.publicationId, instanceKey: publication.instanceKey, sourceHash: publication.source.sourceHash,
            pageId, askId: ask.value.askId, drawGeneration: 1, playerGeneration: 0,
          },
        },
      }));
      if (!act.ok) throw Error(act.error.code);
      testClock.set(act.value.at);
      const projectFile = join(dir, 'project.json');
      const beforeRetired = readFileSync(projectFile);
      const retiredCli = await runCli('review', '1', dir, '--from-review', act.value.actId, '--json');
      expect(retiredCli.exit).toBe(2);
      expect(retiredCli.stderr).toContain('NUMBERED_WRITER_REMOVED:');
      expect(readFileSync(projectFile)).toEqual(beforeRetired);

      const exported = host.session.readActExport(act.value.actId, false).toString('utf8');
      const seeded = seedStoredReviewVerdictAct(dir, 1, exported, { now: testClock.now() });
      const receipt = () => arr(load().review_acts).map(obj).find(row => row.actId === act.value.actId)!;
      if (mode === 'pinned comment') {
        expect(seeded.verdict).toMatchObject({ verdict: 'bounced', on_items: [] });
        expect(String(seeded.verdict.verbatim)).toContain(pinnedWords);
        expect(receipt()).not.toHaveProperty('feedback_route');
        expect(checkProject(dir).refusals).toEqual([]);
        return;
      }
      put(dir, 'source/config-next.json', { key: 'synthetic', requirements: 'requirements.json', motion: { animations_from: 'animations.json' } });
      put(dir, 'source/animations.json', { wind: { duration: 1, tracks: [] } });
      put(dir, 'source/citations.json', { motion: [{ entry: 'animations_from', guide: 'motion', quote: words }] });
      const second = ['2', dir, ...args.slice(2), '--answers', '1:0', '--citations', 'source/citations.json'];
      second[second.indexOf('--config') + 1] = 'source/config-next.json';
      if (mode === 'no route') {
        const snapshotBefore = readFileSync(projectFile);
        expect(seedRig(second).exit).toBe(0);
        const finding = checkProject(dir).refusals.find(f => f.code === 'QUOTE_NOT_FOUND')!;
        expect(finding).toBeDefined();
        expect(finding.message).toContain('interview.waypoints[motion].guide');
        for (const p of ['outputs/v2', 'evidence/v2', 'derived/review/v2']) rmSync(join(dir, p), { recursive: true, force: true });
        writeFileSync(projectFile, snapshotBefore);
        expect(seedRig(['2', dir, ...args.slice(2), '--answers', '1:0']).exit).toBe(0);
        expect(checkProject(dir).refusals).toEqual([]);
        return;
      }

      testClock.set(testClock.now() + 1000);
      const routedAt = testClock.iso();
      const route = { by: 'agent', at: routedAt, item: 'motion', comment_index: 0, verbatim: words };
      const currentRecord = load();
      arr(currentRecord.review_acts).map(obj).find(row => row.actId === act.value.actId)!.feedback_route = route;
      const motionGuide = obj(waypoint(currentRecord, 'motion').guide);
      motionGuide.additions = [...arr(motionGuide.additions ?? []), {
        by: 'user', at: routedAt, verbatim: words, value: null,
        source: 'polish feedback, v1', review_act: seeded.verdict.source!,
      }];
      put(dir, 'project.json', currentRecord);

      expect(checkProject(dir).feedback).toMatchObject([{ items: { user: 0, delegated: 0, not_asked: 1 } }]);
      const changedRoute = load();
      obj(arr(changedRoute.review_acts).map(obj).find(row => row.actId === act.value.actId)!.feedback_route).verbatim = 'Edited owner words';
      expect(checkProject(dir, changedRoute).refusals.map(f => f.code)).toContain('REVIEW_FEEDBACK_ROUTE_INVALID');
      const changedGuide = load();
      arr(obj(waypoint(changedGuide, 'motion').guide).additions).pop();
      expect(checkProject(dir, changedGuide).refusals.map(f => f.code)).toContain('FEEDBACK_NOT_ADDED');

      const next = await cli('next', dir, '--json');
      expect(arr(next.refusals).map(row => obj(row).code)).toContain('SIGNOFF_ANSWERS_STALE');
      put(dir, 'owner-sign.txt', 'Approve the current motion guide.');
      await cli('signoff', 'plan-approved', dir, '--by', 'user', '--owner-chat', join(dir, 'owner-sign.txt'),
        '--said-at', testClock.iso(), '--relayed-by', 'agent', '--json');
      expect(arr((await cli('next', dir, '--json')).refusals)).toEqual([]);

      put(dir, 'source/citations.json', { motion: [{ entry: 'animations_from', guide: 'motion', quote: `「${words}」` }] });
      const before = readFileSync(projectFile);
      expect(seedRig(second).exit).toBe(0);
      const badQuote = checkProject(dir).refusals.find(f => f.code === 'QUOTE_NOT_FOUND')!;
      expect(badQuote).toBeDefined();
      expect(badQuote.message.split('\n')).toContain('  Removing the outer marks 「」 would match interview.waypoints[motion].guide.additions[0].verbatim exactly. Quote that field verbatim.');
      for (const p of ['outputs/v2', 'evidence/v2', 'derived/review/v2']) rmSync(join(dir, p), { recursive: true, force: true });
      writeFileSync(projectFile, before);
      put(dir, 'source/citations.json', { motion: [{ entry: 'animations_from', guide: 'motion', quote: words }] });

      const version = JSON.parse(seedRig(second).stdout) as JsonObject;
      expect(version.answers_feedback).toEqual([{ version: 1, verdict: 0 }]);
      expect(obj(obj(version.provenance).sections).motion).toEqual([{ entry: 'animations_from', guide: 'motion', quote: words }]);
      expect(checkProject(dir).refusals).toEqual([]);
    } finally {
      host.stop();
    }
  }, 30_000);
});

describe('#454 feedback rebuild reader and next', () => {
  test('seeded rig -> human bounce -> next -> repeatable answers -> check -> retired verdict move', async () => {
    const { nextProject } = await import('../src/next.ts');
    const f = setup(true);
    seedRig(f.args);
    for (let i = 0; i < 2; i++) {
      seedStoredVerdict(f.dir, 1, {
        review: 'rig-review',
        verdict: 'bounced',
        by: 'user',
        at: testClock.now(),
        verbatim: 'Adjust the synthetic rig.\n',
        source: 'synthetic review',
      });
    }
    const before = readFileSync(join(f.dir, 'project.json'));
    const nextBefore = nextProject(f.dir, testClock.now());
    expect(nextBefore.refusals).toEqual([]);
    expect(nextBefore.moves[0]).toMatchObject({ role: 'agent', field: 'versions' });
    expect(nextBefore.moves[0]!.command).toContain('rig-version 2');
    expect(nextBefore.moves[0]!.command).toContain('--answers 1:0 --answers 1:1');
    expect(nextBefore.moves).toHaveLength(1);
    expect(nextBefore.awaits).toEqual(['versions[n=2]']);
    expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);

    const args = ['2', ...f.args.slice(1)];
    expect(seedRig([...args, '--answers', '1:0', '--answers', '1:1']).exit).toBe(0);
    expect(obj(arr(f.load().versions)[1]).answers_feedback).toEqual([{ version: 1, verdict: 0 }, { version: 1, verdict: 1 }]);
    const report = checkProject(f.dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.filter(w => w.code === 'FEEDBACK_OPEN')).toEqual([]);
    const next = nextProject(f.dir, testClock.now());
    expect(next.moves.some(m => m.review_act?.kind === 'review-verdict')).toBe(false);
    expect(next.moves.some(m => m.command?.includes('--answers'))).toBe(false);
  });
});

test('#454 no-bounce seeded rig and next preserve record bytes and retired verdict move', async () => {
  const { nextCommand } = await import('../src/next.ts');
  const f = setup(true);
  expect(seedRig(f.args).exit).toBe(0);
  const path = join(f.dir, 'project.json');
  const record = readFileSync(path);

  const json = nextCommand([f.dir, '--json'], testClock.now());
  const text = nextCommand([f.dir], testClock.now());
  expect([json.exit, text.exit]).toEqual([0, 0]);
  const report = JSON.parse(json.stdout) as import('../src/next.ts').NextReport;
  const awaits = 'versions[n=1].verdicts[review=rig-review]';
  const field = 'versions[v1].verdicts';
  const projectId = String(f.load().name ?? '');
  expect(report).toMatchObject({
    schema: 'rig-create/next@1', project_id: projectId, stage: 'rig-review', effective_stage: 'rig-review',
    accepted: false, refusals: [],
  });
  expect(report.awaits).toContain(awaits);
  const verdictMoves = report.moves.filter(move => move.field === field || move.awaits === awaits || move.review_act?.kind === 'review-verdict');
  expect(verdictMoves).toEqual([{
    role: 'human', field, awaits, command: null,
    act: 'NUMBERED_ACT_RETIRED: Rig v1 needs an accepted live rig-review verdict. To continue on the current path, follow the adoption or rebuild instructions in docs/PROJECT.md#adopting-existing-numbered-outputs. To complete the numbered verdict gate, use Create 1.27.0.',
  }]);
  expect(text.stdout.split('\n')[0]).toBe(`next: ${projectId || '(unnamed)'} — stage: rig-review`);
  expect(text.stdout).toContain(`  [human] (${field} -> ${awaits}) ${verdictMoves[0]!.act}`);
  expect(readFileSync(path)).toEqual(record);
});

test('#1044 next uses the frozen registration config for the adopted rig replacement', async () => {
  const { nextProject } = await import('../src/next.ts');
  const { dir, args, load } = setup(true);
  expect(seedRig(args).exit).toBe(0);
  const source = obj(obj(obj(arr(load().versions)[0]).registration).config_source);
  expect(source.path).toBe('evidence/v1/registration/config-source.json');
  expect(existsSync(join(dir, 'specs/rig/config.json'))).toBe(false);

  const adopt = run([process.execPath, ...clockedCli(), 'record', 'rig', '--adopt', dir], dir, process.env as Record<string, string>);
  expect(adopt.code).toBe(0);
  expect(obj(obj(load().current).rig).built_from).toEqual([{ path: source.path, sha256: source.sha256 }]);
  const file = join(dir, 'project.json');
  const before = readFileSync(file);
  const report = nextProject(dir, testClock.now());
  expect(report.refusals).toEqual([]);
  expect(report.moves.filter(move => move.field === 'current.rig')
    .map(move => [move.role, move.command, move.review_act?.kind ?? null])).toEqual([
    ['agent', `rig-create record rig ${dir} --from outputs/rig.next --config ${source.path}`, null],
  ]);
  expect(readFileSync(file)).toEqual(before);
});

describe('#514 producer depth bindings in frozen registration reader', () => {
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
    put(base.dir, 'source/rectangle.json.binding.json', { spec: 'rig-parts-depth-map-binding/1', part: 'rectangle', mapSha256: 'd'.repeat(64), inputSha256: 'c'.repeat(64) });
    return { ...base, args: [...base.args, '--depth-map-binding', 'source/rectangle.json.binding.json'] };
  }

  test('#559 retained registration binds raw Parts receipt bytes, sha256 and spec independently of source files', () => {
    const { dir, args, load } = boundDepthSetup();
    const bytes = readFileSync(join(dir, 'source/rectangle.json.binding.json'));
    seedRig(args);
    const version = obj(arr(load().versions)[0]), registration = obj(version.registration);
    const binding = obj(arr(obj(registration.depth).map_bindings)[0]);
    expect(binding).toMatchObject({ part: 'rectangle', spec: 'rig-parts-depth-map-binding/1', sha256: jobHash(bytes) });
    expect(arr(registration.files)).toContainEqual({ path: binding.path, sha256: binding.sha256 });
    expect(readFileSync(join(dir, String(binding.path)))).toEqual(bytes);
    rmSync(join(dir, 'source'), { recursive: true });
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test('#559 receipt absence warns for older registrations and refuses on the landing boundary, regardless of build date', () => {
    const { dir, args, load } = depthSetup();
    seedRig(args);
    const project = load(), version = obj(arr(project.versions)[0]), registration = obj(version.registration);
    expect(Date.parse(String(version.at))).toBeLessThan(Date.parse(DEPTH_MAP_BINDING_SINCE));
    for (const [at, count] of [['2026-11-18T23:59:59Z', 0], [DEPTH_MAP_BINDING_SINCE, 1]] as const) {
      registration.at = at;
      const warnings: import('../src/check.ts').Finding[] = [];
      const findings = rigRegistrationFindings(dir, project, warnings);
      expect(findings.filter(f => f.code === 'RIG_DEPTH_MAP_BINDING_MISSING')).toHaveLength(count);
      expect(warnings.filter(f => f.code === 'RIG_DEPTH_MAP_BINDING_MISSING')).toHaveLength(1 - count);
    }
  });

  test('#559 current bound registration passes and retained tampering refuses in every era', () => {
    const { dir, args, load } = boundDepthSetup();
    approveFrozenParts(dir, load(), args);
    testClock.set(new Date(DEPTH_MAP_BINDING_SINCE));
    seedRig(args);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    const project = load(), version = obj(arr(project.versions)[0]), registration = obj(version.registration);
    expect(version.accepted_parts).toBeUndefined();
    const binding = obj(arr(obj(registration.depth).map_bindings)[0]);
    writeFileSync(join(dir, String(binding.path)), '{}\n');
    registration.at = '2026-11-18T23:59:59Z';
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
  });

  test.each(['spec', 'part', 'mapSha256', 'inputSha256', 'extra', 'json', 'duplicate'] as const)('#559 reader refuses rehashed %s map-binding receipt tampering', kind => {
    const { dir, args, load } = boundDepthSetup();
    approveFrozenParts(dir, load(), args);
    testClock.set(new Date(DEPTH_MAP_BINDING_SINCE));
    expect(seedRig(args).exit).toBe(0);
    const project = load();
    const registration = obj(obj(arr(project.versions)[0]).registration);
    const bindings = arr(obj(registration.depth).map_bindings);
    const binding = obj(bindings[0]);
    const relPath = String(binding.path);
    const rebind = (bytes: Buffer) => {
      writeFileSync(join(dir, relPath), bytes);
      binding.sha256 = jobHash(bytes);
      binding.bytes = bytes.length;
      for (const file of arr(registration.files).map(obj)) {
        if (file.path === relPath) file.sha256 = binding.sha256;
      }
    };
    if (kind === 'json') {
      rebind(Buffer.from('{\n'));
    } else if (kind === 'duplicate') {
      bindings.push(structuredClone(binding));
    } else {
      const receipt = JSON.parse(readFileSync(join(dir, relPath), 'utf8')) as JsonObject;
      receipt[kind] = kind.endsWith('Sha256') ? 'e'.repeat(64) : 'wrong';
      if (kind === 'spec') binding.spec = 'wrong';
      rebind(Buffer.from(`${JSON.stringify(receipt)}\n`));
    }
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');
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
      expect(seedRig(base.args).exit).toBe(0);
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
      expect(messages[0]).toContain('head-only answer');
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
      expect(codes(dir, project)).toHaveLength(1);
      resealReport({ groups: ['head'], leftOut: ['rectangle'] });
      expect(codes(dir, project)).toHaveLength(1);
      expect(turnExtraGroup(dir, project)?.recorded).toBe(false);
      resealReport({ groups: ['head'], leftOut: ['rectangle', 'torso'] });
      expect(codes(dir, project)).toEqual([]);
      expect(turnExtraGroup(dir, project)).toEqual({ version: 1, dial: 'body_yaw_dial', recorded: true });
      expect(turnExtraGroupMoves(dir, project)).toEqual([]);
      expect(JSON.parse(readFileSync(join(dir, String(reportBinding.path)), 'utf8')).recipeSha256).toBe(recipe);
      writeFileSync(join(dir, String(reportBinding.path)), `${JSON.stringify({ spec: 'rig-parts-depth-report/1', selection: { groups: ['head'], leftOut: ['rectangle', 'torso'] }, parts: [] })}\n`);
      expect(codes(dir, project)).toHaveLength(1);
      expect(turnExtraGroup(dir, project)?.recorded).toBe(false);
    });

    test('#792 registration check accepts a head-only depth-report selection and refuses a left-out part that keeps a sheet', () => {
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
      expect(seedRig(args).exit).toBe(0);
      expect(rigRegistrationFindings(dir, load())).toEqual([]);
      const cleanPartsBytes = readFileSync(join(dir, 'outputs/v1/out/parts.json'));
      const registeredParts = JSON.parse(cleanPartsBytes.toString('utf8'));
      registeredParts.parts[1].depth = registeredParts.parts[0].depth;
      const bytes = Buffer.from(`${JSON.stringify(registeredParts)}\n`);
      writeFileSync(join(dir, 'outputs/v1/out/parts.json'), bytes);
      const p = load(), v = obj(arr(p.versions)[0]);
      for (const f of arr(v.outputs).map(obj)) if (f.path === 'outputs/v1/out/parts.json') { f.sha256 = jobHash(bytes); f.bytes = bytes.length; }
      obj(obj(v.registration).copied).bytes = arr(v.outputs).map(obj).reduce((sum, f) => sum + Number(f.bytes), 0);
      expect(rigRegistrationFindings(dir, p).map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');
      expect(checkProject(dir, p).refusals.map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');

      writeFileSync(join(dir, 'outputs/v1/out/parts.json'), cleanPartsBytes);
      expect(rigRegistrationFindings(dir, load())).toEqual([]);
      const cleanSheetsBytes = readFileSync(join(dir, 'outputs/v1/out/rig/depth_sheets.json'));
      const sheetsDoc = JSON.parse(cleanSheetsBytes.toString('utf8'));
      const torsoSheet = structuredClone(sheetsDoc.parts[0]);
      torsoSheet.part = 'torso';
      torsoSheet.depth.sources[0].from = 'full:author:torso';
      sheetsDoc.parts.push(torsoSheet);
      const tamperedSheets = Buffer.from(`${JSON.stringify(sheetsDoc)}\n`);
      writeFileSync(join(dir, 'outputs/v1/out/rig/depth_sheets.json'), tamperedSheets);
      const pSheets = load(), vSheets = obj(arr(pSheets.versions)[0]);
      for (const f of arr(vSheets.outputs).map(obj)) {
        if (f.path === 'outputs/v1/out/rig/depth_sheets.json') { f.sha256 = jobHash(tamperedSheets); f.bytes = tamperedSheets.length; }
      }
      obj(obj(obj(vSheets.registration).depth).sheets).sha256 = jobHash(tamperedSheets);
      obj(obj(vSheets.registration).copied).bytes = arr(vSheets.outputs).map(obj).reduce((sum, f) => sum + Number(f.bytes), 0);
      expect(rigRegistrationFindings(dir, pSheets).map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');
      writeFileSync(join(dir, 'outputs/v1/out/rig/depth_sheets.json'), cleanSheetsBytes);
    });

    test.each([['head only', undefined, 'depth'], ['fixed view', { bone: 'rectangle', pivot: 15, roles: { rectangle: 'surface' } }, 'fixed'], ['empty body roles', { bone: 'rectangle', pivot: 15, roles: {} }, 'depth']] as const)('%s raises no RIG_TURN_EXTRA_GROUP', (_name, body, mode) => {
      const { dir, project } = bodySetup(body === undefined ? undefined : structuredClone(body) as JsonObject, mode);
      expect(turnExtraGroup(dir, project)).toBeNull();
      expect(codes(dir, project)).toEqual([]);
    });

    test('#1000 body: true suppresses RIG_TURN_EXTRA_GROUP when body roles are declared and raises RIG_TURN_BODY_MISSING when absent', () => {
      const withBody = bodySetup({ bone: 'rectangle', pivot: 15, roles: { rectangle: 'surface' } });
      obj(arr(obj(withBody.project.interview).waypoints).map(obj).find(w => w.id === 'turn')!.guide).value = { mode: 'depth', body: true };
      expect(turnExtraGroup(withBody.dir, withBody.project)).toBeNull();
      expect(turnExtraGroupMoves(withBody.dir, withBody.project)).toEqual([]);
      expect(turnMissingBodyGroup(withBody.dir, withBody.project)).toBeNull();
      const warningsWithBody: import('../src/check.ts').Finding[] = [];
      rigRegistrationFindings(withBody.dir, withBody.project, warningsWithBody);
      expect(warningsWithBody.filter(w => w.code === 'RIG_TURN_EXTRA_GROUP' || w.code === 'RIG_TURN_BODY_MISSING')).toEqual([]);

      for (const absent of [undefined, { bone: 'rectangle', pivot: 15, roles: {} }] as const) {
        const withoutBody = bodySetup(absent === undefined ? undefined : structuredClone(absent) as JsonObject);
        obj(arr(obj(withoutBody.project.interview).waypoints).map(obj).find(w => w.id === 'turn')!.guide).value = { mode: 'depth', body: true };
        expect(turnExtraGroup(withoutBody.dir, withoutBody.project)).toBeNull();
        expect(turnMissingBodyGroup(withoutBody.dir, withoutBody.project)).toEqual({ version: 1 });
        const warningsWithoutBody: import('../src/check.ts').Finding[] = [];
        rigRegistrationFindings(withoutBody.dir, withoutBody.project, warningsWithoutBody);
        expect(warningsWithoutBody.filter(w => w.code === 'RIG_TURN_EXTRA_GROUP')).toEqual([]);
        const missing = warningsWithoutBody.filter(w => w.code === 'RIG_TURN_BODY_MISSING');
        expect(missing).toHaveLength(1);
        expect(missing[0]!.path).toBe('versions[v1].registration.config_source');
        expect(missing[0]!.message).toContain('turn.body');
      }
    });

    test('#1000 interview-decision turn records { mode: "depth", body: true } as a delegated answer with the same WARN behaviour and refuses invalid body', async () => {
      const { interviewAnswerCommand, interviewDecisionCommand, interviewOptionsCommand } = await import('../src/choice-writers.ts');
      const { OPTIONS_SPEC, optionContext } = await import('../src/choices.ts');
      const runDelegatedScenario = (declaredBodyRoles: JsonObject | undefined): import('../src/check.ts').Finding[] => {
        const base = boundDepthSetup();
        const config = JSON.parse(readFileSync(join(base.dir, 'source/config.json'), 'utf8'));
        if (declaredBodyRoles !== undefined) config.turn.body = declaredBodyRoles;
        put(base.dir, 'source/config.json', config);
        const report = JSON.parse(readFileSync(join(base.dir, 'source/parts/depth-report.json'), 'utf8'));
        report.rigConfigSha256 = jobHash(readFileSync(join(base.dir, 'source/config.json')));
        put(base.dir, 'source/parts/depth-report.json', report);
        approveFrozenParts(base.dir, base.load(), base.args);

        const initial = base.load();
        const interview = obj(initial.interview);
        interview.order = { spec: 'rig-create/stage-order@2', choices_adopted_at: '2026-11-18T12:00:00Z' };
        interview.turn_question = 'rig-create/turn-question@1';
        arr(interview.waypoints).push({ id: 'turn', config: ['turn', 'depth'], prompts: [{ id: 'view', text: TURN_QUESTION }], guide: null, history: [] });
        initial.stage = 'rigging-interview';
        writeFileSync(join(base.dir, 'project.json'), `${JSON.stringify(initial, null, 2)}\n`);

        const draftedAt = '2026-11-19T00:01:00Z';
        const set: JsonObject = {
          schema: OPTIONS_SPEC,
          id: 'turn-delegated-only',
          question: 'turn',
          stage: 'rigging-interview',
          drafted_by: 'agent',
          drafted_at: draftedAt,
          context: optionContext(base.load(), 'rigging-interview', Date.parse(draftedAt), base.dir),
          asks: [{
            id: 'view',
            prompt: TURN_QUESTION,
            options: [
              { id: 'fixed', kind: 'value', label: 'Fixed view', effect: 'Keep the painted view.', fragment: { mode: 'fixed' }, recommended: true, reason: 'Synthetic baseline.' },
              { id: 'turn', kind: 'value', label: 'Head turn', effect: 'The head turns with depth.', fragment: { mode: 'depth' }, recommended: false },
              { id: 'other', kind: 'other', label: 'Other', effect: 'Describe the view.', recommended: false },
              { id: 'auto', kind: 'auto', label: 'Let the agent decide', effect: 'The agent records its decision before approval.', recommended: false },
            ],
          }],
          assembly: { rule: 'merge' },
        };
        const setPath = 'evidence/interview/turn-delegated-only.json';
        put(base.dir, setPath, set);
        const reg = JSON.parse(interviewOptionsCommand(['turn', base.dir, '--file', setPath], Date.parse('2026-11-19T00:02:00Z'))) as JsonObject;
        interviewAnswerCommand(['turn', base.dir, '--set', setPath, '--sha256', String(reg.sha256), '--by', 'synthetic-owner', '--pick', 'view=auto'], Date.parse('2026-11-19T00:03:00Z'));

        const badFragment = join(base.dir, 'bad-turn-fragment.json');
        const reasoning = join(base.dir, 'turn-reasoning.txt');
        writeFileSync(badFragment, JSON.stringify({ mode: 'fixed', body: true }));
        writeFileSync(reasoning, 'Whole-figure turn chosen from accepted structure.');
        const beforeBytes = readFileSync(join(base.dir, 'project.json'));
        expect(() => interviewDecisionCommand(['turn', base.dir, '--by', 'agent', '--reasoning-file', reasoning, '--fragment', `view=${badFragment}`], Date.parse('2026-11-19T00:04:00Z')))
          .toThrow(expect.objectContaining({ code: 'TURN_BODY_VALUE_INVALID' }));
        expect(readFileSync(join(base.dir, 'project.json')).equals(beforeBytes)).toBe(true);

        const goodFragment = join(base.dir, 'good-turn-fragment.json');
        writeFileSync(goodFragment, JSON.stringify({ mode: 'depth', body: true }));
        const recorded = JSON.parse(interviewDecisionCommand(['turn', base.dir, '--by', 'agent', '--reasoning-file', reasoning, '--fragment', `view=${goodFragment}`], Date.parse('2026-11-19T00:04:00Z'))) as JsonObject;
        expect(recorded.value).toEqual({ mode: 'depth', body: true });

        const decided = base.load();
        decided.stage = 'rigging';
        const steps = arr(obj(decided.plan).steps);
        steps.push({ ...structuredClone(obj(steps[0])), id: 'turn', order: 0.5, rests_on: ['turn'], status: 'in-progress', status_history: [] });
        put(base.dir, 'source/depth-citations.json', { turn: [{ entry: 'delegated whole-figure turn', guide: 'turn', delegated: true, asks: ['view'] }] });
        put(base.dir, 'source/at-source.json', { finished_at: '2026-11-19T00:05:00Z' });
        writeFileSync(join(base.dir, 'project.json'), `${JSON.stringify(decided, null, 2)}\n`);
        testClock.set(new Date('2026-11-19T00:06:00Z'));
        expect(seedRig(base.args).exit).toBe(0);

        const warnings: import('../src/check.ts').Finding[] = [];
        expect(rigRegistrationFindings(base.dir, base.load(), warnings)).toEqual([]);
        return warnings;
      };

      const runOptionPickScenario = (declaredBodyRoles: JsonObject | undefined): import('../src/check.ts').Finding[] => {
        const base = boundDepthSetup();
        const config = JSON.parse(readFileSync(join(base.dir, 'source/config.json'), 'utf8'));
        if (declaredBodyRoles !== undefined) config.turn.body = declaredBodyRoles;
        put(base.dir, 'source/config.json', config);
        const report = JSON.parse(readFileSync(join(base.dir, 'source/parts/depth-report.json'), 'utf8'));
        report.rigConfigSha256 = jobHash(readFileSync(join(base.dir, 'source/config.json')));
        put(base.dir, 'source/parts/depth-report.json', report);
        approveFrozenParts(base.dir, base.load(), base.args);
        const initial = base.load();
        const interview = obj(initial.interview);
        interview.order = { spec: 'rig-create/stage-order@2', choices_adopted_at: '2026-11-18T12:00:00Z' };
        interview.turn_question = 'rig-create/turn-question@1';
        arr(interview.waypoints).push({ id: 'turn', config: ['turn', 'depth'], prompts: [{ id: 'view', text: TURN_QUESTION }], guide: null, history: [] });
        initial.stage = 'rigging-interview';
        writeFileSync(join(base.dir, 'project.json'), `${JSON.stringify(initial, null, 2)}\n`);
        const draftedAt = '2026-11-19T00:01:00Z';
        const set: JsonObject = {
          schema: OPTIONS_SPEC,
          id: 'turn-standard-options',
          question: 'turn',
          stage: 'rigging-interview',
          drafted_by: 'agent',
          drafted_at: draftedAt,
          context: optionContext(base.load(), 'rigging-interview', Date.parse(draftedAt), base.dir),
          asks: [{
            id: 'view',
            prompt: TURN_QUESTION,
            options: TURN_OPTIONS.map(option => ({ ...structuredClone(option), recommended: option.id === 'fixed', ...(option.id === 'fixed' ? { reason: 'Synthetic baseline.' } : {}) })) as unknown as JsonObject[],
          }],
          assembly: { rule: 'merge' },
        };
        const setPath = 'evidence/interview/turn-standard-options.json';
        put(base.dir, setPath, set);
        const reg = JSON.parse(interviewOptionsCommand(['turn', base.dir, '--file', setPath], Date.parse('2026-11-19T00:02:00Z'))) as JsonObject;
        const picked = JSON.parse(interviewAnswerCommand(['turn', base.dir, '--set', setPath, '--sha256', String(reg.sha256), '--by', 'synthetic-owner', '--pick', 'view=turn-body'], Date.parse('2026-11-19T00:03:00Z'))) as JsonObject;
        expect(picked.value).toEqual({ mode: 'depth', body: true });
        const decided = base.load();
        decided.stage = 'rigging';
        const steps = arr(obj(decided.plan).steps);
        steps.push({ ...structuredClone(obj(steps[0])), id: 'turn', order: 0.5, rests_on: ['turn'], status: 'in-progress', status_history: [] });
        put(base.dir, 'source/depth-citations.json', { turn: [{ entry: 'picked whole-figure turn', guide: 'turn', quote: 'Head and body turn', asks: ['view'] }] });
        put(base.dir, 'source/at-source.json', { finished_at: '2026-11-19T00:05:00Z' });
        writeFileSync(join(base.dir, 'project.json'), `${JSON.stringify(decided, null, 2)}\n`);
        testClock.set(new Date('2026-11-19T00:06:00Z'));
        expect(seedRig(base.args).exit).toBe(0);
        const warnings: import('../src/check.ts').Finding[] = [];
        expect(rigRegistrationFindings(base.dir, base.load(), warnings)).toEqual([]);
        return warnings;
      };

      const warningsWithoutBody = runDelegatedScenario(undefined);
      const optionWarningsWithoutBody = runOptionPickScenario(undefined);
      expect(warningsWithoutBody.filter(w => w.code === 'RIG_TURN_EXTRA_GROUP')).toEqual([]);
      expect(warningsWithoutBody.filter(w => w.code === 'RIG_TURN_BODY_MISSING')).toHaveLength(1);
      expect(warningsWithoutBody).toEqual(optionWarningsWithoutBody);

      const warningsWithBody = runDelegatedScenario({ bone: 'rectangle', pivot: 15, roles: { rectangle: 'surface' } });
      const optionWarningsWithBody = runOptionPickScenario({ bone: 'rectangle', pivot: 15, roles: { rectangle: 'surface' } });
      expect(warningsWithBody.filter(w => w.code === 'RIG_TURN_EXTRA_GROUP' || w.code === 'RIG_TURN_BODY_MISSING')).toEqual([]);
      expect(warningsWithBody).toEqual(optionWarningsWithBody);
    });
  });

  test('#567 accepted depth output binds the applied source and matches registered depth parts', () => {
    const { dir, args, load, acceptedPath } = acceptedDepthSetup();
    const source = readFileSync(join(dir, acceptedPath, 'parts.json'));
    const manifest = readFileSync(join(dir, 'source/manifest.json'));
    const report = readFileSync(join(dir, 'source/parts/depth-report.json'));
    const sheets = readFileSync(join(dir, 'source/rig/depth_sheets.json'));
    expect(JSON.parse(manifest.toString()).partsSha256).not.toBe(jobHash(source));
    expect(seedRig(args).exit).toBe(0);
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
    expect(seedRig(args).exit).toBe(0);
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

  test('#567 predepth accepted source retains exact bytes and the original depth binding', () => {
    const { dir, args, load, acceptedPath } = acceptedDepthSetup(true);
    const source = readFileSync(join(dir, acceptedPath, 'parts.json'));
    const applied = readFileSync(join(dir, 'source/parts/parts.json'));
    expect(seedRig(args).exit).toBe(0);
    const project = load(), version = obj(arr(project.versions)[0]);
    const depth = obj(obj(version.registration).depth);
    expect(depth.source_parts_applied).toBeUndefined();
    expect(readFileSync(join(dir, String(obj(depth.source_parts).path)))).toEqual(source);
    expect(readFileSync(join(dir, 'outputs/v1/out/parts.json'))).toEqual(applied);
    expect(obj(depth.source_parts).sha256).toBe(jobHash(source));
    expect(JSON.parse(readFileSync(join(dir, String(obj(depth.manifest).path)), 'utf8')).partsSha256).toBe(jobHash(source));
    expect(rigRegistrationFindings(dir, project)).toEqual([]);
    expect(registeredDepthPartsMatch(dir, version, jobHash(source), jobHash(applied))).toBe(true);
  });

  test('retains per-part manifest/report/sheets by exact bytes and checks their producer spec', () => {
    const { dir, args, load } = depthSetup();
    const source = readFileSync(join(dir, 'source/manifest.json'));
    expect(seedRig(args).exit).toBe(0);
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
    arr(obj(p.interview).waypoints).push({
      id: 'turn', config: ['turn', 'depth'], prompts: [{ id: 'view', text: TURN_QUESTION }], history: [],
      guide: { delegated: false, by: 'synthetic-owner', at: '2026-11-14T01:00:00Z', verbatim: chosen.label, source: 'synthetic new-question fixture', value: { ...chosen.fragment }, asks: [{ id: 'view', state: 'user' }] },
    });
    arr(obj(p.plan).steps).push({ id: 'turn', phase: 'rig', order: 2.5, rests_on: ['turn'], status: 'pending', does: 'Prepare and apply depth before rig', produces: 'Producer depth reports', bar: 'Producer depth files are bound', checkpoint_proposed: false, checkpoint: null });
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
    put(dir, 'source/depth-citations.json', { turn: [{ entry: 'new synthetic head turn', guide: 'turn', quote: chosen.label, asks: ['view'] }] });
    put(dir, 'source/at-source.json', { finished_at: '2026-11-14T01:30:00Z' });
    testClock.set(new Date('2026-11-14T02:00:00Z'));
    expect(depthPlanFindings({ ...p, stage: 'rigging' }, [])).toEqual([]);
    expect(seedRig(args).exit).toBe(0);
    expect(obj(obj(obj(arr(load().versions)[0]).provenance).sections).turn).toEqual([{ entry: 'new synthetic head turn', guide: 'turn', quote: chosen.label, asks: ['view'] }]);
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
  });

  test('depth-only manifest enrichment is accepted, while changed art declarations are not', () => {
    const { dir, args, load } = depthSetup();
    expect(seedRig(args).exit).toBe(0);
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
      const b = Buffer.from(`${JSON.stringify(value)}\n`);
      writeFileSync(join(dir, String(binding.path)), b); binding.sha256 = jobHash(b);
      for (const row of arr(registration.files).map(obj)) if (row.path === binding.path) row.sha256 = binding.sha256;
    };
    const manifestBinding = obj(depth.manifest), reportBinding = obj(depth.report);
    const manifest = JSON.parse(readFileSync(join(dir, String(manifestBinding.path)), 'utf8')) as JsonObject;
    manifest.partsSha256 = jobHash(changed); reseal(manifestBinding, manifest);
    const report = JSON.parse(readFileSync(join(dir, String(reportBinding.path)), 'utf8')) as JsonObject;
    report.partsSha256 = jobHash(changed); report.manifestSha256 = manifestBinding.sha256!; reseal(reportBinding, report);
    expect(rigRegistrationFindings(dir, p)).toEqual([]);
    expect(registeredDepthPartsMatch(dir, v, jobHash(changed), String(output.sha256))).toBe(false);
  });

  test('per-layer route keeps the existing config.depth image binding without an inference manifest', () => {
    const { dir, args, load } = depthSetup(true);
    expect(seedRig(args).exit).toBe(0);
    const registration = obj(obj(arr(load().versions)[0]).registration);
    expect(obj(registration.depth).route).toBe('per-layer');
    expect(obj(registration.depth).manifest).toBeUndefined();
    expect(rigRegistrationFindings(dir, load())).toEqual([]);
    expect(arr(registration.files).some(raw => obj(raw).path === 'evidence/v1/registration/inputs/depth/full/layers/rectangle/image')).toBe(true);
  });

  test('tampered depth manifest/report/sheets digests refuse in registration reader', () => {
    const { dir, args, load } = depthSetup();
    expect(seedRig(args).exit).toBe(0);
    const base = load();
    const reseal = (project: JsonObject, kind: 'manifest' | 'report' | 'sheets', edit: (doc: JsonObject) => void) => {
      const ver = obj(arr(project.versions)[0]);
      const reg = obj(ver.registration);
      const binding = obj(obj(reg.depth)[kind]);
      const doc = JSON.parse(readFileSync(join(dir, String(binding.path)), 'utf8')) as JsonObject;
      edit(doc);
      const b = Buffer.from(`${JSON.stringify(doc)}\n`);
      writeFileSync(join(dir, String(binding.path)), b);
      binding.sha256 = jobHash(b);
      for (const row of arr(reg.files).map(obj)) if (row.path === binding.path) row.sha256 = binding.sha256;
    };
    const origReport = readFileSync(join(dir, String(obj(obj(obj(obj(arr(base.versions)[0]).registration).depth).report).path)));
    const p1 = structuredClone(base);
    reseal(p1, 'report', doc => { doc.manifestSha256 = 'd'.repeat(64); });
    expect(rigRegistrationFindings(dir, p1).map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');
    writeFileSync(join(dir, String(obj(obj(obj(obj(arr(base.versions)[0]).registration).depth).report).path)), origReport);

    const origSheets = readFileSync(join(dir, String(obj(obj(obj(obj(arr(base.versions)[0]).registration).depth).sheets).path)));
    const p2 = structuredClone(base);
    reseal(p2, 'sheets', doc => { obj(obj(arr(doc.parts)[0]).depth).sources = [{ ...(arr(obj(obj(arr(doc.parts)[0]).depth).sources)[0] as JsonObject), sha256: 'e'.repeat(64) }]; });
    expect(rigRegistrationFindings(dir, p2).map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');
    writeFileSync(join(dir, String(obj(obj(obj(obj(arr(base.versions)[0]).registration).depth).sheets).path)), origSheets);
  });

  test.each(['sourceSha256', 'sheetSha256', 'mapSha256', 'inputSha256'] as const)('another rig %s cannot be paired with a retained depth report', field => {
    const { dir, args, load } = depthSetup();
    expect(seedRig(args).exit).toBe(0);
    const project = load();
    const reg = obj(obj(arr(project.versions)[0]).registration);
    const binding = obj(obj(reg.depth).report);
    const report = JSON.parse(readFileSync(join(dir, String(binding.path)), 'utf8')) as JsonObject;
    obj(arr(report.parts)[0])[field] = 'e'.repeat(64);
    const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
    writeFileSync(join(dir, String(binding.path)), bytes);
    binding.sha256 = jobHash(bytes);
    for (const row of arr(reg.files).map(obj)) if (row.path === binding.path) row.sha256 = binding.sha256;
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');
  });

  test.each(['partsSha256', 'recipeSha256', 'rigConfigSha256'] as const)('missing mandatory digest %s is invalid even when both retained reports omit it', field => {
    const { dir, args, load } = depthSetup();
    expect(seedRig(args).exit).toBe(0);
    const project = load();
    const reg = obj(obj(arr(project.versions)[0]).registration);
    const depth = obj(reg.depth);
    const manifestBinding = obj(depth.manifest);
    const reportBinding = obj(depth.report);
    const manifest = JSON.parse(readFileSync(join(dir, String(manifestBinding.path)), 'utf8')) as JsonObject;
    const report = JSON.parse(readFileSync(join(dir, String(reportBinding.path)), 'utf8')) as JsonObject;
    delete manifest[field];
    delete report[field];
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    writeFileSync(join(dir, String(manifestBinding.path)), manifestBytes);
    manifestBinding.sha256 = jobHash(manifestBytes);
    report.manifestSha256 = manifestBinding.sha256;
    const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`);
    writeFileSync(join(dir, String(reportBinding.path)), reportBytes);
    reportBinding.sha256 = jobHash(reportBytes);
    for (const row of arr(reg.files).map(obj)) {
      if (row.path === manifestBinding.path) row.sha256 = manifestBinding.sha256;
      if (row.path === reportBinding.path) row.sha256 = reportBinding.sha256;
    }
    expect(rigRegistrationFindings(dir, project).map(f => f.code)).toContain('RIG_DEPTH_BINDING_INVALID');
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
