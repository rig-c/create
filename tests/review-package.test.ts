import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { checkAppliedReview } from '../src/applied-review.ts';
import { readReview } from '../src/review-read.ts';
import { decodeReviewAct, reviewActVerdict, reviewActVersionHash } from '../src/review-act.ts';
import { checkReviewPackages, reviewConfigInputs, reviewHandoffInputs } from '../src/review-package.ts';
import { plateReceiptSpec } from '../src/config-inputs.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { fixture as exampleFixture, obj, version } from './fixtures.ts';
import { reviewExampleFiles } from './review-fixture.ts';
import { run } from './helpers.ts';
import { seedRetainedReviewPackage } from './numbered-seed.ts';
import { checkCorrections, checkProject, correctionCommand, TEST_NOW, testClock } from './clock.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const BUILD_AT = '2026-11-06T00:00:00Z';
const config = '{"key":"synthetic","bones":[{"name":"root"}]}\n';
const model = JSON.stringify({ spec: 'rigc-compiled/3', referenceScale: 100, stage: { x: 0, y: 0, width: 10, height: 10 }, bones: [{ name: 'root' }], slots: [], skins: [], constraints: [], events: [], animations: [], pages: [] });
function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-package-'));
  roots.push(dir);
  put(dir, 'project.json', JSON.stringify({ schema: 'rig-create/project@0', stage: 'interview', versions: [{ n: 1, kind: 'rig', at: BUILD_AT, outputs: [], verdicts: [] }] }));
  put(dir, 'frozen/config.json', config);
  put(dir, 'build/parts.json', '{"parts":[]}');
  put(dir, 'build/parts/piece.png', 'synthetic part');
  put(dir, 'build/rig/rig.json', '{"bones":[{"name":"root"}]}');
  put(dir, 'build/rig/motion.json', '{}');
  put(dir, 'build/rig/mesh_report.json', '{}');
  put(dir, 'build/check/build/skeleton.model.json', model);
  return dir;
}
function write(dir: string): JsonObject {
  return JSON.parse(seedRetainedReviewPackage(['1', dir, '--config', 'frozen/config.json', '--from', 'build', '--json']).stdout) as JsonObject;
}
function checked(dir: string) {
  const ctx = { dir, project: JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject, refusals: [] as { code: string; message: string }[], warnings: [] as { code: string; message: string }[] };
  checkReviewPackages(ctx as Parameters<typeof checkReviewPackages>[0]);
  return ctx;
}

describe('frozen review package reader', () => {
  test('#981 a selected package is checked without reading the Parts approval', () => {
    const dir = exampleFixture(() => {}, 'example-numbered/example-project.json');
    roots.push(dirname(dir));
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const history = version(project, 1);
    const bytes = JSON.stringify({
      schema: 'rig-review/act@2', kind: 'review-verdict', jobId: 'synthetic-history-job', actId: 'rig-one-verdict',
      askId: 'ask-rig-one', publicationId: 'publication-rig-one', at: history.at,
      authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
      source: { sourceHash: sha('source'), projectHash: sha('project'), package: { id: 'rig-one', revision: 'one' },
        selector: { kind: 'rig', version: 1 }, model: { path: 'skeleton.model.json', sha256: sha('model') },
        direction: null, plan: null, parts: { enumeratorVersion: '2.45.0', manifest: { path: 'parts.json', sha256: sha('parts') }, images: [] } },
      value: { stage: 'rig-review', verdict: 'changes-requested', words: 'Revise the synthetic rig.' },
    });
    const act = decodeReviewAct(bytes);
    history.verdicts = [reviewActVerdict(act)];
    project.review_acts = [...(project.review_acts as JsonObject[]), {
      schema: 'rig-create/review-act@1', jobId: act.jobId, actId: act.actId, bytes, sha256: sha(bytes),
      version: 1, verdict: 0, version_hash: reviewActVersionHash(project, act, 0), added_evidence: [],
    }];
    const refusals = (record: JsonObject, selected?: number) => {
      const ctx: Parameters<typeof checkReviewPackages>[0] = { dir, project: record, refusals: [], warnings: [] };
      checkReviewPackages(ctx, selected);
      return ctx.refusals;
    };
    expect(refusals(project)).toEqual([]);
    expect(refusals({ ...project, versions: [version(project, 2)] })).toEqual([]);

    history.review_package = {};
    expect(refusals(project).map(({ code, path }) => [code, path])).toEqual([
      ['REVIEW_PACKAGE_MALFORMED', 'versions[v1].review_package'],
    ]);
    expect(refusals(project, 2)).toEqual([]);

    const partsApproval = (project.signoffs as JsonObject[]).find(row => row.stage === 'parts-review')!;
    appendFileSync(join(dir, String(obj(partsApproval.evidence).path)), '\n');
    expect(refusals(project, 2)).toEqual([]);
  });

  test('unknown build dates compare both identities against the latest approval as WARNs', () => {
    const dir = exampleFixture(project => {
      for (const raw of project.versions as JsonObject[]) raw.at = 'unknown';
    }, 'legacy-example-project.json', {}, true);
    roots.push(dirname(dir));
    const result = checked(dir);
    expect(result.refusals.map(f => f.code)).toEqual(['RIG_VERSION_AT_INVALID', 'RIG_VERSION_AT_INVALID']);
    expect(result.warnings.map(f => f.code)).toEqual(['REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_CONFIG_MISMATCH']);
  });

  test('names a planted config build mismatch in an otherwise passing signed example', () => {
    const dir = exampleFixture(() => {}, 'example-numbered/example-project.json');
    roots.push(dirname(dir));
    expect(checkProject(dir).refusals).toEqual([]);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    obj(version(project, 1).provenance).config = { ...obj(obj(version(project, 1).provenance).config), sha256: sha('another build config') };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
    const report = checkProject(dir);
    expect(report.refusals.map(f => f.code)).toContain('REVIEW_PACKAGE_CONFIG_MISMATCH');
    expect(report.refusals.find(f => f.code === 'REVIEW_PACKAGE_CONFIG_MISMATCH')?.message).toContain(sha('another build config'));
  });

  test('file drift does not conceal disagreement between recorded config identities', () => {
    const dir = exampleFixture(() => {}, 'example-numbered/example-project.json');
    roots.push(dirname(dir));
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const cfg = obj(obj(version(project, 1).provenance).config);
    writeFileSync(join(dir, String(cfg.path)), '{}');
    cfg.sha256 = sha('a third recorded config');
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
    const report = checkProject(dir);
    expect(report.refusals.map(f => f.code)).toContain('REVIEW_PACKAGE_CONFIG_MISMATCH');
    expect(report.warnings.map(f => f.code)).toContain('PROVENANCE_CONFIG_CHANGED');
  });

  test('before-SINCE raw identities warn while their frozen bytes remain readable', () => {
    const dir = exampleFixture(project => {
      for (const raw of project.versions as JsonObject[]) raw.at = '2026-11-02T00:00:00Z';
      for (const raw of project.signoffs as JsonObject[]) raw.at = '2026-11-01T00:00:00Z';
    }, 'legacy-example-project.json', {}, true);
    roots.push(dirname(dir));
    const result = checked(dir);
    expect(result.refusals).toEqual([]);
    expect(result.warnings.map(f => f.code)).toEqual(['REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_CONFIG_MISMATCH']);
  });

  test('the unchanged config resolves its adjacent requirements inside the frozen package', () => {
    const dir = fixture();
    put(dir, 'frozen/config.json', JSON.stringify({ requirements: 'interview-requirements.json' }));
    put(dir, 'frozen/interview-requirements.json', '{"requirements":[]}\n');
    const record = write(dir);
    expect(readFileSync(join(dir, 'derived/review/v1/config.json'))).toEqual(readFileSync(join(dir, 'frozen/config.json')));
    expect(readFileSync(join(dir, 'derived/review/v1/interview-requirements.json'), 'utf8')).toBe('{"requirements":[]}\n');
    expect((record.files as JsonObject[]).find(f => f.path === 'interview-requirements.json')?.sha256).toBe(sha('{"requirements":[]}\n'));
    expect(checked(dir).refusals).toEqual([]);
  });

  test('retained review-package seeder reproduces the raw legacy records and bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'example-review-'));
    roots.push(root);
    const dir = join(root, 'first');
    const files = reviewExampleFiles();
    const example = readTemplate('legacy-example-project.json');
    const project = structuredClone(example);
    project.signoffs = [];
    for (const [path, bytes] of Object.entries(files)) {
      if (!path.startsWith('derived/review/')) put(dir, path, bytes);
    }
    for (const n of [1, 2]) {
      const cfg = `evidence/v${n}/review-config.json`;
      obj(version(project, n).provenance).config = { path: cfg, sha256: sha(files[cfg]!) };
    }
    put(dir, 'project.json', `${JSON.stringify(project, null, 2)}\n`);
    for (const n of [1, 2]) {
      const written = seedRetainedReviewPackage([String(n), dir, '--config', `evidence/v${n}/review-config.json`, '--from', `outputs/v${n}/out`, '--json']);
      expect(written.exit).toBe(0);
      expect(JSON.parse(written.stdout)).toEqual(obj(version(example, n).review_package));
    }
    for (const [path, bytes] of Object.entries(files)) {
      expect(readFileSync(join(dir, path), 'utf8')).toBe(bytes);
    }
  });

  test('the raw legacy example is refused by build-identity and missing review targets', () => {
    const dir = exampleFixture(() => {}, 'legacy-example-project.json', {}, true);
    roots.push(dirname(dir));
    const report = checkProject(dir);
    expect(report.refusals.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING', 'SIGNOFF_TARGET_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'PARTS_VERDICT_RECEIPT_REQUIRED', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'DIRECTION_SCENE_REQUIRED', 'DIRECTION_SCENE_REQUIRED']);
    expect(report.warnings.map(f => f.code)).toEqual(['CREATE_PIN_MISSING', 'QUESTION_SET_STALE', 'RIGGING_INTERVIEW_PAINTING_LEGACY', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY', 'OWNER_LANGUAGE_MISSING']);
  });

  test('stripping a raw legacy package warns and still refuses the other build mismatch', () => {
    const dir = exampleFixture(project => { delete version(project, 1).review_package; }, 'legacy-example-project.json', {}, true);
    roots.push(dirname(dir));
    const report = checkProject(dir);
    expect(report.refusals.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING', 'SIGNOFF_TARGET_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'PARTS_VERDICT_RECEIPT_REQUIRED', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'DIRECTION_SCENE_REQUIRED', 'DIRECTION_SCENE_REQUIRED']);
    expect(report.warnings.map(finding => finding.code)).toEqual(['CREATE_PIN_MISSING', 'QUESTION_SET_STALE', 'RIGGING_INTERVIEW_PAINTING_LEGACY', 'REVIEW_PACKAGE_MISSING', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY', 'OWNER_LANGUAGE_MISSING']);
  });

  test('removing a raw legacy package warns and keeps declared build mismatches visible', () => {
    const dir = exampleFixture(() => {}, 'legacy-example-project.json', {}, true);
    roots.push(dirname(dir));
    rmSync(join(dir, 'derived/review/v1'), { recursive: true });
    const report = checkProject(dir);
    expect(report.refusals.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING', 'SIGNOFF_TARGET_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'PARTS_VERDICT_RECEIPT_REQUIRED', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'DIRECTION_SCENE_REQUIRED', 'DIRECTION_SCENE_REQUIRED']);
    expect(report.warnings.map(finding => finding.code)).toEqual(['CREATE_PIN_MISSING', 'QUESTION_SET_STALE', 'RIGGING_INTERVIEW_PAINTING_LEGACY', 'REVIEW_PACKAGE_MISSING', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY', 'OWNER_LANGUAGE_MISSING']);
  });

  test('seeded package resolves config hash through installed rig-review feedback and detects changed files', () => {
    const dir = fixture();
    const record = write(dir);
    expect((record.config as JsonObject).sha256).toBe(sha(config));
    expect(record.open).toBe("rig-review open 'derived/review/v1/out'");
    const feedback = run([process.execPath, join(import.meta.dir, '../node_modules/.bin/rig-review'), 'feedback', join(dir, 'derived/review/v1/out')], dir, { ...process.env, XDG_STATE_HOME: join(dir, 'state') } as Record<string, string>);
    expect(feedback.stderr).toBe('');
    expect(feedback.code).toBe(0);
    const session = JSON.parse(feedback.stdout);
    expect(session.reviewedSource.handoff.how).toBe('discovered');
    expect(session.reviewedSource.handoff.config.sha256).toBe((record.config as JsonObject).sha256);
    expect(session.reviewedSource.handoff.missing).toEqual([]);
    expect(checked(dir).refusals).toEqual([]);
    expect(checkProject(dir).refusals.some(f => f.code === 'REVIEW_PACKAGE_CHANGED')).toBe(false);
    put(dir, 'derived/review/v1/config.json', '{}');
    expect(checkProject(dir).refusals.some(f => f.code === 'REVIEW_PACKAGE_CHANGED')).toBe(true);
  });

  test('copies survive cleaning the original build', () => {
    const dir = fixture();
    write(dir);
    rmSync(join(dir, 'build'), { recursive: true });
    expect(checked(dir).refusals).toEqual([]);
    expect(readFileSync(join(dir, 'derived/review/v1/config.json'), 'utf8')).toBe(config);
  });

  test('missing recorded package warns with REVIEW_PACKAGE_MISSING', () => {
    const dir = fixture();
    write(dir);
    rmSync(join(dir, 'derived'), { recursive: true });
    const ctx = checked(dir);
    expect(ctx.refusals).toEqual([]);
    expect(ctx.warnings[0]?.code).toBe('REVIEW_PACKAGE_MISSING');
  });

  test('legacy rigs warn while post and pre-interview versions are exempt', () => {
    const dir = fixture();
    expect(checked(dir).warnings[0]?.code).toBe('REVIEW_PACKAGE_MISSING');
    put(dir, 'project.json', JSON.stringify({ schema: 'rig-create/project@0', versions: [{ n: 1, kind: 'rig', at: BUILD_AT, pre_interview: true }, { n: 2, kind: 'post' }] }));
    expect(checked(dir).warnings).toEqual([]);
  });

  for (const path of ['config.json', 'out/parts.json', 'out/parts/piece.png', 'out/rig/rig.json', 'out/check/build/skeleton.model.json']) {
    test(`refuses changed ${path}`, () => {
      const dir = fixture(); write(dir);
      put(dir, `derived/review/v1/${path}`, 'changed');
      expect(checked(dir).refusals[0]?.code).toBe('REVIEW_PACKAGE_CHANGED');
    });
  }

  test('added and removed package files refuse', () => {
    const dir = fixture(); write(dir);
    put(dir, 'derived/review/v1/out/rig/unrecorded.json', '{}');
    expect(checked(dir).refusals[0]?.code).toBe('REVIEW_PACKAGE_CHANGED');
    rmSync(join(dir, 'derived/review/v1/out/rig/unrecorded.json'));
    rmSync(join(dir, 'derived/review/v1/out/parts/piece.png'));
    expect(checked(dir).refusals[0]?.code).toBe('REVIEW_PACKAGE_CHANGED');
  });

  test('a malformed recorded manifest refuses even while the package is absent', () => {
    const dir = fixture(); write(dir);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    project.versions[0].review_package.files = [{ path: '../outside', sha256: 'invalid' }];
    put(dir, 'project.json', JSON.stringify(project));
    rmSync(join(dir, 'derived'), { recursive: true });
    expect(checked(dir).refusals[0]?.code).toBe('REVIEW_PACKAGE_MALFORMED');
  });
});

test('package binds every nested config input and ignores later live edits', () => {
  const dir = fixture();
  const named = ['inputs/requirements.json', 'inputs/animations.json', 'inputs/skeleton.json'];
  put(dir, 'frozen/config.json', JSON.stringify({ requirements: named[0], motion: { animations_from: named[1] }, generation: { control: { skeleton: named[2] } } }));
  for (const path of named) put(dir, `frozen/${path}`, JSON.stringify({ synthetic: path }));
  const record = write(dir);
  const files = record.files as JsonObject[];
  const frozen = reviewConfigInputs(record, dir, 1);
  for (const path of named) {
    expect(files.find(f => f.path === path)?.sha256).toBe(sha(JSON.stringify({ synthetic: path })));
    expect(readFileSync(join(dir, 'derived/review/v1', path), 'utf8')).toBe(JSON.stringify({ synthetic: path }));
    put(dir, `frozen/${path}`, 'changed live input');
  }
  put(dir, 'frozen/config.json', '{"note":"edited live config"}');
  expect(reviewConfigInputs(record, dir, 1)).toEqual(frozen);
  expect(checked(dir).refusals).toEqual([]);
});

for (const legacy of [false, true]) test(`a frozen config input missing from inventory ${legacy ? 'warns historically' : 'refuses currently'}`, () => {
  const dir = fixture(); put(dir, 'frozen/config.json', '{"requirements":"inputs/requirements.json"}');
  put(dir, 'frozen/inputs/requirements.json', '{"synthetic":"bound input"}');
  write(dir);
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  project.versions[0].at = legacy ? '2026-11-05T00:00:00Z' : '2026-11-06T00:00:00Z';
  project.versions[0].review_package.files = project.versions[0].review_package.files.filter((f: JsonObject) => f.path !== 'inputs/requirements.json');
  rmSync(join(dir, 'derived/review/v1/inputs/requirements.json'));
  put(dir, 'project.json', JSON.stringify(project));
  const result = checked(dir);
  expect((legacy ? result.warnings : result.refusals).map(f => f.code)).toEqual(['REVIEW_PACKAGE_INPUT_MISSING']);
  expect((legacy ? result.warnings : result.refusals)[0]?.message).toContain('inputs/requirements.json');
  expect(legacy ? result.refusals : result.warnings).toEqual([]);
});

test('a mask nested relative to requirements is retained at its declared locator', () => {
  const dir = fixture();
  put(dir, 'frozen/config.json', JSON.stringify({ requirements: 'inputs/requirements.json' }));
  put(dir, 'frozen/inputs/requirements.json', JSON.stringify({ setup_painting: { figure_mask: { path: 'masks/figure.png', sha256: sha('matte') } } }));
  put(dir, 'frozen/inputs/masks/figure.png', 'matte');
  const record = write(dir);
  expect((record.files as JsonObject[]).find(f => f.path === 'inputs/masks/figure.png')?.sha256).toBe(sha('matte'));
  expect(readFileSync(join(dir, 'derived/review/v1/inputs/masks/figure.png'), 'utf8')).toBe('matte');
  expect(checked(dir).refusals).toEqual([]);
});

test('package freezes an occluder plate directory by its receipt without copying or hashing sibling rasters', () => {
  const dir = fixture();
  const receipt = JSON.stringify({ spec: plateReceiptSpec(dir), synthetic: 'occluder plate receipt' });
  put(dir, 'frozen/config.json', JSON.stringify({
    requirements: 'inputs/requirements.json',
    assemble: { occluders: [{ image: 'inputs/occ.png', plate: 'inputs/plate' }] },
  }));
  put(dir, 'frozen/inputs/requirements.json', '{"synthetic":"requirements"}');
  put(dir, 'frozen/inputs/occ.png', 'synthetic occluder image');
  put(dir, 'frozen/inputs/plate/receipt.json', receipt);
  put(dir, 'frozen/inputs/plate/plate.png', 'synthetic plate raster');
  put(dir, 'frozen/inputs/plate/mask.png', 'synthetic plate mask');
  const record = write(dir);
  const files = record.files as JsonObject[];
  expect(files.find(f => f.path === 'inputs/plate/receipt.json')?.sha256).toBe(sha(receipt));
  expect(files.some(f => String(f.path).startsWith('inputs/plate/') && f.path !== 'inputs/plate/receipt.json')).toBe(false);
  expect(existsSync(join(dir, 'derived/review/v1/inputs/plate/receipt.json'))).toBe(true);
  expect(existsSync(join(dir, 'derived/review/v1/inputs/plate/plate.png'))).toBe(false);
  expect(existsSync(join(dir, 'derived/review/v1/inputs/plate/mask.png'))).toBe(false);
  const frozen = reviewConfigInputs(record, dir, 1);
  expect(frozen).toEqual([
    { path: 'inputs/requirements.json', sha256: sha('{"synthetic":"requirements"}') },
    { path: 'inputs/occ.png', sha256: sha('synthetic occluder image') },
    { path: 'inputs/plate/receipt.json', sha256: sha(receipt) },
  ]);
  expect(reviewHandoffInputs(record, dir, 1)).toContainEqual({ path: 'inputs/plate/receipt.json', sha256: sha(receipt) });
  const feedback = run([process.execPath, join(import.meta.dir, '../node_modules/.bin/rig-review'), 'feedback', join(dir, 'derived/review/v1/out')], join(import.meta.dir, '..'), { ...process.env, XDG_STATE_HOME: join(dir, 'state') } as Record<string, string>);
  expect(feedback.stderr).toBe('');
  expect(feedback.code).toBe(0);
  const session = JSON.parse(feedback.stdout);
  expect(session.reviewedSource.handoff.missing).toEqual([]);
  expect(session.reviewedSource.handoff.config.sha256).toBe(obj(record.config).sha256);
  expect((session.reviewedSource.handoff.files as JsonObject[]).map((f): JsonObject => ({ path: posix.normalize(`out/check/${String(f.path)}`), sha256: String(f.sha256) }))).toEqual([...reviewHandoffInputs(record, dir, 1)].sort((a, b) => String(a.path).localeCompare(String(b.path))));
  expect(session.reviewedSource.handoff.files).toContainEqual({ path: '../../inputs/plate/receipt.json', sha256: sha(receipt), directory: '../../inputs/plate', spec: plateReceiptSpec(dir) });
  expect(checked(dir).refusals).toEqual([]);
  expect(checked(dir).warnings).toEqual([]);
  put(dir, 'frozen/inputs/plate/plate.png', 'altered sibling raster');
  rmSync(join(dir, 'frozen/inputs/plate/mask.png'));
  expect(checked(dir).refusals).toEqual([]);
  put(dir, 'derived/review/v1/inputs/plate/receipt.json', JSON.stringify({ spec: plateReceiptSpec(dir), synthetic: 'tampered frozen receipt' }));
  expect(checked(dir).refusals.map(f => f.code)).toEqual(['REVIEW_PACKAGE_CHANGED']);
});

test('check refuses a frozen occluder plate directory that records sibling files or a wrong receipt spec', () => {
  const dir = fixture();
  const receipt = JSON.stringify({ spec: plateReceiptSpec(dir), synthetic: 'occluder plate receipt' });
  put(dir, 'frozen/config.json', JSON.stringify({ assemble: { occluders: [{ plate: 'inputs/plate' }] } }));
  put(dir, 'frozen/inputs/plate/receipt.json', receipt);
  write(dir);
  put(dir, 'derived/review/v1/inputs/plate/plate.png', 'unexpected sibling');
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  project.versions[0].review_package.files.push({ path: 'inputs/plate/plate.png', sha256: sha('unexpected sibling') });
  project.versions[0].review_package.files.sort((a: JsonObject, b: JsonObject) => String(a.path).localeCompare(String(b.path)));
  put(dir, 'project.json', JSON.stringify(project));
  const extraSibling = checked(dir);
  expect(extraSibling.refusals.map(f => f.code)).toEqual(['REVIEW_PACKAGE_INPUT_INVALID']);
  expect(extraSibling.refusals[0]?.message).toContain('directory input inputs/plate must bind only inputs/plate/receipt.json');
  rmSync(join(dir, 'derived/review/v1/inputs/plate/plate.png'));
  const wrongSpec = '{"spec":"rig-run/1"}';
  put(dir, 'derived/review/v1/inputs/plate/receipt.json', wrongSpec);
  project.versions[0].review_package.files = project.versions[0].review_package.files
    .filter((f: JsonObject) => f.path !== 'inputs/plate/plate.png')
    .map((f: JsonObject) => f.path === 'inputs/plate/receipt.json' ? { path: f.path, sha256: sha(wrongSpec) } : f);
  put(dir, 'project.json', JSON.stringify(project));
  const badSpec = checked(dir);
  expect(badSpec.refusals.map(f => f.code)).toEqual(['REVIEW_PACKAGE_INPUT_INVALID']);
  expect(badSpec.refusals[0]?.message).toContain('inputs/plate/receipt.json declares spec "rig-run/1"');
  rmSync(join(dir, 'derived/review/v1/inputs/plate/receipt.json'));
  project.versions[0].review_package.files = project.versions[0].review_package.files
    .filter((f: JsonObject) => f.path !== 'inputs/plate/receipt.json');
  put(dir, 'project.json', JSON.stringify(project));
  const missingReceipt = checked(dir);
  expect(missingReceipt.refusals.map(f => f.code)).toEqual(['REVIEW_PACKAGE_INPUT_MISSING']);
  expect(missingReceipt.refusals[0]?.message).toContain('inputs/plate');
});

test('check accepts a config naming both an occluder plate directory and an explicit image inside it', () => {
  const dir = fixture();
  const receipt = JSON.stringify({ spec: plateReceiptSpec(dir), synthetic: 'occluder plate receipt' });
  put(dir, 'frozen/config.json', JSON.stringify({
    assemble: { occluders: [{ image: 'inputs/plate/plate.png', plate: 'inputs/plate' }] },
  }));
  put(dir, 'frozen/inputs/plate/receipt.json', receipt);
  put(dir, 'frozen/inputs/plate/plate.png', 'explicitly declared occluder image');
  put(dir, 'frozen/inputs/plate/mask.png', 'unreferenced sibling mask');
  const record = write(dir);
  const files = record.files as JsonObject[];
  expect(files).toContainEqual({ path: 'inputs/plate/plate.png', sha256: sha('explicitly declared occluder image') });
  expect(files).toContainEqual({ path: 'inputs/plate/receipt.json', sha256: sha(receipt) });
  expect(files.some(f => f.path === 'inputs/plate/mask.png')).toBe(false);
  expect(existsSync(join(dir, 'derived/review/v1/inputs/plate/plate.png'))).toBe(true);
  expect(existsSync(join(dir, 'derived/review/v1/inputs/plate/receipt.json'))).toBe(true);
  expect(existsSync(join(dir, 'derived/review/v1/inputs/plate/mask.png'))).toBe(false);
  expect(reviewConfigInputs(record, dir, 1)).toEqual([
    { path: 'inputs/plate/plate.png', sha256: sha('explicitly declared occluder image') },
    { path: 'inputs/plate/receipt.json', sha256: sha(receipt) },
  ]);
  expect(checked(dir).refusals).toEqual([]);
  expect(checked(dir).warnings).toEqual([]);
  put(dir, 'derived/review/v1/inputs/plate/mask.png', 'unreferenced sibling mask');
  const updated = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  updated.versions[0].review_package.files.push({ path: 'inputs/plate/mask.png', sha256: sha('unreferenced sibling mask') });
  updated.versions[0].review_package.files.sort((a: JsonObject, b: JsonObject) => String(a.path).localeCompare(String(b.path)));
  put(dir, 'project.json', JSON.stringify(updated));
  const withUnreferenced = checked(dir);
  expect(withUnreferenced.refusals.map(f => f.code)).toEqual(['REVIEW_PACKAGE_INPUT_INVALID']);
  expect(withUnreferenced.refusals[0]?.message).toContain('directory input inputs/plate must bind only inputs/plate/receipt.json');
});

for (const mode of ['separate', 'overlapping'] as const) {
  test(`installed rig-review feedback handoff for ${mode} occluder image + plate is accepted by applied-review and corrections`, () => {
    const dir = fixture();
    const spec = plateReceiptSpec(dir);
    const receipt = JSON.stringify({ spec, synthetic: 'occluder plate receipt' });
    const imagePath = mode === 'separate' ? 'inputs/occ.png' : 'inputs/plate/plate.png';
    put(dir, 'frozen/config.json', JSON.stringify({
      requirements: 'inputs/requirements.json',
      assemble: { occluders: [{ image: imagePath, plate: 'inputs/plate' }] },
    }));
    put(dir, 'frozen/inputs/requirements.json', '{"synthetic":"requirements"}');
    put(dir, `frozen/${imagePath}`, 'synthetic occluder image');
    put(dir, 'frozen/inputs/plate/receipt.json', receipt);
    put(dir, 'frozen/inputs/plate/mask.png', 'unreferenced sibling mask');
    const record = write(dir);
    const expectedHandoff = reviewHandoffInputs(record, dir, 1);
    expect(expectedHandoff).toHaveLength(9);

    const outcomeModel = JSON.stringify({ ...JSON.parse(model), referenceScale: 101 });
    const configSha = String(obj(record.config).sha256);
    const patch = {
      schema: 'rig-review-config-patch/1', config_sha256: configSha,
      ops: [{ op: 'replace', path: '/requirements', value: 'inputs/requirements.json' }],
      producer: { name: '@rig-c/parts', version: PINNED_PACKAGES['@rig-c/parts'] },
      op: { cmd: 'rig', args: [] },
    };
    const applied = {
      schema: 'rig-review-applied/2', buildId: sha('synthetic-build-id'),
      patch, patchSha256: sha(JSON.stringify(patch)), configHash: configSha,
      producer: { package: '@rig-c/parts', version: PINNED_PACKAGES['@rig-c/parts'] },
      compiler: { package: '@rig-c/core', version: PINNED_PACKAGES['@rig-c/core'] },
      line: 'synthetic shape-only, not measured',
      check: { schema: 'rig-review-check-summary/1', pass: true, exitCode: 0, line: 'check: synthetic shape-only', bars: { SYNTHETIC: 'PASS' }, gate: true },
      diff: { count: 1, paths: ['/requirements'] },
      modelHash: sha(outcomeModel),
    };
    const state = join(dir, 'state');
    const repoRoot = join(import.meta.dir, '..');
    const seeded = run([process.execPath, '-e', `
      import { loadReview } from ${JSON.stringify(join(import.meta.dir, '../node_modules/@rig-c/review/src/manifest.ts'))};
      import { freshSession, saveSession } from ${JSON.stringify(join(import.meta.dir, '../node_modules/@rig-c/review/src/session.ts'))};
      const pkg = await loadReview(${JSON.stringify(join(dir, 'derived/review/v1/out'))});
      const session = freshSession(pkg);
      session.feedback = [{ id: 'apply-occluder', frameStart: 0, frameEnd: 0,
        target: { kind: 'rig', name: pkg.feedbackCatalog.rig }, category: 'quality',
        summary: 'Keep the occluder adjustment.', context: { applied: ${JSON.stringify(applied)} } }];
      await saveSession(pkg, session, ${JSON.stringify(state)});
    `], repoRoot, { ...process.env } as Record<string, string>);
    expect(seeded.stderr).toBe('');
    expect(seeded.code).toBe(0);

    const exported = run([process.execPath, join(import.meta.dir, '../node_modules/.bin/rig-review'), 'feedback', join(dir, 'derived/review/v1/out')], repoRoot, { ...process.env, RIG_REVIEW_STATE_HOME: state, RIG_REVIEW_STATE_DIR: state } as Record<string, string>);
    expect(exported.stderr).toBe('');
    expect(exported.code).toBe(0);
    const session = JSON.parse(exported.stdout) as JsonObject;
    const handoff = obj(obj(session.reviewedSource).handoff);
    expect(handoff.missing).toEqual([]);
    const handoffFiles = handoff.files as JsonObject[];
    expect(handoffFiles).toHaveLength(9);
    expect(handoffFiles.map((f): JsonObject => ({ path: posix.normalize(`out/check/${String(f.path)}`), sha256: String(f.sha256) }))).toEqual([...expectedHandoff].sort((a, b) => String(a.path).localeCompare(String(b.path))));
    expect(handoffFiles).toContainEqual({ path: `../../${imagePath}`, sha256: sha('synthetic occluder image') });
    expect(handoffFiles).toContainEqual({ path: '../../inputs/plate/receipt.json', sha256: sha(receipt), directory: '../../inputs/plate', spec });

    const reviewTool = JSON.parse(readFileSync(join(import.meta.dir, '../node_modules/@rig-c/review/package.json'), 'utf8')).version as string;
    const read = readReview(dir, 'derived/review/v1/out', () => ({
      stdout: Buffer.from(exported.stdout), stderr: '', exitCode: 0,
      tool: { name: '@rig-c/review', version: reviewTool },
    }));
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    project.stage = 'rig-review';
    const v1 = (project.versions as JsonObject[])[0]!;
    v1.outputs = [{ role: 'model', path: 'derived/review/v1/out/check/build/skeleton.model.json', sha256: sha(model) }];
    v1.provenance = { config: { path: 'frozen/config.json', sha256: configSha }, sections: {} };
    v1.review_origin = null;
    put(dir, 'derived/review/v2/out/check/build/skeleton.model.json', outcomeModel);
    (project.versions as JsonObject[]).push({
      n: 2, kind: 'rig', at: '2026-11-06T01:00:00Z', changed: 'synthetic bytes',
      outputs: [{ role: 'model', path: 'derived/review/v2/out/check/build/skeleton.model.json', sha256: sha(outcomeModel) }],
      verdicts: [], provenance: { config: { path: 'frozen/config.json', sha256: configSha }, sections: {} },
      review_package: { config: { path: 'frozen/config.json', sha256: configSha }, files: [{ path: 'config.json', sha256: configSha }, { path: 'out/check/build/skeleton.model.json', sha256: sha(outcomeModel) }] },
      review_origin: { feedback: read.file, review_read: read.receipt, source_version: 1, feedback_id: 'apply-occluder', applied },
    });
    put(dir, 'project.json', JSON.stringify(project, null, 2));

    const appliedCtx = { dir, project: JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject, refusals: [] as { code: string; path: string; message: string }[], warnings: [] as { code: string; path: string; message: string }[] };
    checkAppliedReview(appliedCtx);
    expect(appliedCtx).toMatchObject({ refusals: [], warnings: [] });

    put(dir, 'reasoning.txt', 'Resolved occluder adjustment.\n');
    try {
      testClock.set(TEST_NOW - 1000);
      expect(correctionCommand(['--adopt', dir]).exit).toBe(0);
      testClock.set(TEST_NOW);
      expect(correctionCommand(['record', dir, '--id', 'occ-fix', '--path', 'made', '--stage', 'rig-review', '--by', 'user', '--version', '1', '--feedback-file', 'derived/review/v1/out', '--item', 'apply-occluder'], () => ({
        stdout: Buffer.from(exported.stdout), stderr: '', exitCode: 0,
        tool: { name: '@rig-c/review', version: reviewTool },
      })).exit).toBe(0);
      const afterRecord = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
      ((afterRecord.versions as JsonObject[])[1]!).at = new Date(TEST_NOW + 1000).toISOString();
      put(dir, 'project.json', JSON.stringify(afterRecord, null, 2));
      testClock.set(TEST_NOW + 2000);
      expect(correctionCommand(['resolve', 'occ-fix', dir, '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt'), '--version', '2']).exit).toBe(0);
      const corrCtx = { dir, project: JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject, refusals: [] as { code: string; path: string; message: string }[], warnings: [] as { code: string; path: string; message: string }[] };
      checkCorrections(corrCtx);
      expect(corrCtx).toMatchObject({ refusals: [], warnings: [] });

      const omitted = JSON.parse(exported.stdout) as JsonObject;
      const omittedHandoff = obj(obj(omitted.reviewedSource).handoff);
      omittedHandoff.files = (omittedHandoff.files as JsonObject[]).filter(f => !String(f.path).endsWith(imagePath) && !String(f.path).endsWith('inputs/plate/receipt.json'));
      expect(omittedHandoff.files).toHaveLength(7);
      const omittedBytes = JSON.stringify(omitted);
      const omittedBinding = { path: `evidence/review-reads/${sha(omittedBytes)}.json`, sha256: sha(omittedBytes) };
      put(dir, omittedBinding.path, omittedBytes);
      const brokenProject = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
      const brokenOrigin = obj(((brokenProject.versions as JsonObject[])[1]!).review_origin);
      brokenOrigin.feedback = omittedBinding;
      obj(brokenOrigin.review_read).stdout = omittedBinding;
      const brokenCorrection = obj(((brokenProject.corrections as JsonObject[])[0]!).artifact);
      brokenCorrection.feedback = omittedBinding;
      obj(brokenCorrection.review_read).stdout = omittedBinding;

      const brokenAppliedCtx = { dir, project: brokenProject, refusals: [] as { code: string; path: string; message: string }[], warnings: [] as { code: string; path: string; message: string }[] };
      checkAppliedReview(brokenAppliedCtx);
      expect(brokenAppliedCtx.refusals.map(f => f.code)).toEqual(['APPLIED_REVIEW_SOURCE']);
      const brokenCorrCtx = { dir, project: brokenProject, refusals: [] as { code: string; path: string; message: string }[], warnings: [] as { code: string; path: string; message: string }[] };
      checkCorrections(brokenCorrCtx);
      expect(brokenCorrCtx.refusals.map(f => f.code)).toEqual(['CORRECTION_APPLIED_INVALID']);
    } finally {
      testClock.reset();
    }
  });
}
