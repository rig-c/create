import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkReviewPackages, reviewPackageCommand, reviewConfigInputs } from '../src/review-package.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { generateExampleReview } from '../scripts/generate-example-review.ts';
import { fixture as exampleFixture, obj, version } from './fixtures.ts';
import { reviewExampleFiles } from './review-fixture.ts';
import { clockedCli, run } from './helpers.ts';
import { Refusal } from '../src/refusal.ts';
import { checkProject } from './clock.ts';

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
  return JSON.parse(reviewPackageCommand(['1', dir, '--config', 'frozen/config.json', '--from', 'build', '--json']).stdout) as JsonObject;
}
function checked(dir: string) {
  const ctx = { dir, project: JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject, refusals: [] as { code: string; message: string }[], warnings: [] as { code: string; message: string }[] };
  checkReviewPackages(ctx as Parameters<typeof checkReviewPackages>[0]);
  return ctx;
}

describe('frozen review package', () => {
  test('a declared mask with changed bytes refuses packaging before publication', () => {
    const dir = fixture();
    put(dir, 'frozen/config.json', JSON.stringify({ requirements: 'requirements.json' }));
    put(dir, 'frozen/requirements.json', JSON.stringify({ setup_painting: { figure_mask: { path: 'figure.png', sha256: sha('declared mask') } } }));
    put(dir, 'frozen/figure.png', 'different mask');
    const before = readFileSync(join(dir, 'project.json'));
    let firstMessage: string | undefined;
    for (let retry = 0; retry < 2; retry++) {
      let error: unknown;
      try { write(dir); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Refusal);
      expect((error as Refusal).code).toBe('FIGURE_MASK_CHANGED');
      firstMessage ??= (error as Refusal).message;
      expect((error as Refusal).message).toBe(firstMessage);
      expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
      expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);
    }
  });
  test('an unreadable verdict cannot silence a parts mismatch after acceptance', () => {
    const dir = exampleFixture(() => {}, 'example-project.json');
    roots.push(dirname(dir));
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const pkg = obj(version(project, 1).review_package);
    const changed = '{"parts":[]}\n';
    (pkg.files as JsonObject[]).find(file => file.path === 'out/parts.json')!.sha256 = sha(changed);
    put(dir, 'derived/review/v1/out/parts.json', changed);
    put(dir, 'project.json', JSON.stringify(project));
    expect(checked(dir).refusals.map(f => f.code)).toEqual(['REVIEW_PACKAGE_PARTS_MISMATCH']);
    appendFileSync(join(dir, 'evidence/parts-review.json'), '\n');
    expect(checked(dir).refusals.map(f => f.code)).toEqual(['REVIEW_PACKAGE_PARTS_UNREAD', 'REVIEW_PACKAGE_PARTS_UNREAD']);
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('REVIEW_PACKAGE_PARTS_UNREAD');
  });
  test('an unreadable verdict before SINCE warns instead of refusing', () => {
    const dir = exampleFixture(project => {
      for (const raw of project.versions as JsonObject[]) raw.at = '2026-11-02T00:00:00Z';
      for (const raw of project.signoffs as JsonObject[]) raw.at = '2026-11-01T00:00:00Z';
    }, 'example-project.json');
    roots.push(dirname(dir));
    appendFileSync(join(dir, 'evidence/parts-review.json'), '\n');
    const result = checked(dir);
    expect(result.refusals).toEqual([]);
    expect(result.warnings.map(f => f.code)).toEqual(['REVIEW_PACKAGE_PARTS_UNREAD', 'REVIEW_PACKAGE_PARTS_UNREAD']);
  });
  test('unknown build dates compare both identities against the latest approval as WARNs', () => {
    const dir = exampleFixture(project => {
      for (const raw of project.versions as JsonObject[]) raw.at = 'unknown';
    }, 'legacy-example-project.json', {}, true);
    roots.push(dirname(dir));
    const result = checked(dir);
    expect(result.refusals.map(f => f.code)).toEqual(['RIG_VERSION_AT_INVALID', 'RIG_VERSION_AT_INVALID']);
    expect(result.warnings.map(f => f.code)).toEqual(['REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_PART_FILE_LEGACY']);
  });
  for (const [field, code] of [['config', 'REVIEW_PACKAGE_CONFIG_MISMATCH'], ['parts', 'REVIEW_PACKAGE_PARTS_MISMATCH']] as const) {
    test(`names a planted ${field} build mismatch in an otherwise passing signed example`, () => {
      const dir = exampleFixture(() => {}, 'example-project.json');
      roots.push(dirname(dir));
      expect(checkProject(dir).refusals).toEqual([]);
      const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
      const pkg = obj(version(project, 1).review_package);
      if (field === 'config') obj(version(project, 1).provenance).config = { ...obj(obj(version(project, 1).provenance).config), sha256: sha('another build config') };
      else (pkg.files as JsonObject[]).find(f => f.path === 'out/parts.json')!.sha256 = sha('another manifest');
      writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
      const report = checkProject(dir);
      expect(report.refusals.map(f => f.code)).toContain(code);
      expect(report.refusals.find(f => f.code === code)?.message).toContain(field === 'config' ? sha('another build config') : sha('another manifest'));
    });
  }
  test('file drift does not conceal disagreement between recorded config identities', () => {
    const dir = exampleFixture(() => {}, 'example-project.json');
    roots.push(dirname(dir));
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const config = obj(obj(version(project, 1).provenance).config);
    writeFileSync(join(dir, String(config.path)), '{}');
    config.sha256 = sha('a third recorded config');
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
    expect(result.warnings.map(f => f.code)).toEqual(['REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_PART_FILE_LEGACY', 'REVIEW_PACKAGE_PART_FILE_LEGACY']);
  });
  test('the public package writer refuses a different config before publishing or recording', () => {
    const dir = exampleFixture(() => {}, 'example-project.json');
    roots.push(dirname(dir));
    put(dir, 'evidence/another-config.json', '{}');
    const before = readFileSync(join(dir, 'project.json'));
    let refusal: unknown;
    try { reviewPackageCommand(['1', dir, '--config', 'evidence/another-config.json', '--from', 'outputs/v1/out']); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Refusal);
    expect((refusal as Refusal).code).toBe('REVIEW_PACKAGE_CONFIG_MISMATCH');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
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
  test('the shipped example regenerates identical records and package bytes in two fresh projects', () => {
    const root = mkdtempSync(join(tmpdir(), 'example-review-'));
    roots.push(root);
    const first = join(root, 'first');
    const second = join(root, 'second');
    const records = generateExampleReview(first);
    expect(generateExampleReview(second)).toEqual(records);
    const example = readTemplate('legacy-example-project.json');
    for (const n of [1, 2]) expect(records[n - 1]).toEqual(obj(version(example, n).review_package));
    expect(readFileSync(join(first, 'project.json'), 'utf8')).toBe(readFileSync(join(second, 'project.json'), 'utf8'));
    for (const [path, bytes] of Object.entries(reviewExampleFiles())) {
      expect(readFileSync(join(first, path), 'utf8')).toBe(bytes);
      expect(readFileSync(join(second, path), 'utf8')).toBe(bytes);
    }
  });
  test('the raw legacy example is refused by build-identity and missing review targets', () => {
    const dir = exampleFixture(() => {}, 'legacy-example-project.json', {}, true);
    roots.push(dirname(dir));
    const report = checkProject(dir);
    expect(report.refusals.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING', 'SIGNOFF_TARGET_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'STAGE_SKIPPED', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'DIRECTION_SCENE_REQUIRED', 'DIRECTION_SCENE_REQUIRED']);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });
  test('stripping a raw legacy package warns and still refuses the other build mismatch', () => {
    const dir = exampleFixture((project) => { delete version(project, 1).review_package; }, 'legacy-example-project.json', {}, true);
    roots.push(dirname(dir));
    const report = checkProject(dir);
    expect(report.refusals.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING', 'SIGNOFF_TARGET_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'STAGE_SKIPPED', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'DIRECTION_SCENE_REQUIRED', 'DIRECTION_SCENE_REQUIRED']);
    expect(report.warnings.map((finding) => finding.code)).toEqual(['QUESTION_SET_STALE', 'REVIEW_PACKAGE_MISSING', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });
  test('removing a raw legacy package warns and keeps declared build mismatches visible', () => {
    const dir = exampleFixture(() => {}, 'legacy-example-project.json', {}, true);
    roots.push(dirname(dir));
    rmSync(join(dir, 'derived/review/v1'), { recursive: true });
    const report = checkProject(dir);
    expect(report.refusals.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING', 'SIGNOFF_TARGET_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'STAGE_SKIPPED', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'DIRECTION_SCENE_REQUIRED', 'DIRECTION_SCENE_REQUIRED']);
    expect(report.warnings.map((finding) => finding.code)).toEqual(['QUESTION_SET_STALE', 'REVIEW_PACKAGE_MISSING', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
    expect(report.warnings[1]?.message).toContain("--config 'evidence/v1/review-config.json' --from 'outputs/v1/out'");
  });
  test('normal CLI writes a package whose installed feedback resolves the config hash', () => {
    const dir = fixture();
    const made = run([process.execPath, ...clockedCli(), 'review-package', '1', dir, '--config', 'frozen/config.json', '--from', 'build', '--json'], dir, { ...process.env } as Record<string, string>);
    expect(made.code).toBe(0);
    const record = JSON.parse(made.stdout);
    expect(record.config.sha256).toBe(sha(config));
    expect(record.open).toBe("rig-review open 'derived/review/v1/out'");
    const feedback = run([process.execPath, join(import.meta.dir, '../node_modules/.bin/rig-review'), 'feedback', join(dir, 'derived/review/v1/out')], dir, { ...process.env, XDG_STATE_HOME: join(dir, 'state') } as Record<string, string>);
    expect(feedback.stderr).toBe('');
    expect(feedback.code).toBe(0);
    const session = JSON.parse(feedback.stdout);
    expect(session.reviewedSource.handoff.how).toBe('discovered');
    expect(session.reviewedSource.handoff.config.sha256).toBe(record.config.sha256);
    expect(session.reviewedSource.handoff.missing).toEqual([]);
    console.log(`rig-review feedback: discovered; config sha256 ${session.reviewedSource.handoff.config.sha256}; missing []`);
    expect(checked(dir).refusals).toEqual([]);
    // The ordinary check entry reaches the new checker even on an incomplete interview.
    expect(checkProject(dir).refusals.some((f) => f.code === 'REVIEW_PACKAGE_CHANGED')).toBe(false);
    put(dir, 'derived/review/v1/config.json', '{}');
    expect(checkProject(dir).refusals.some((f) => f.code === 'REVIEW_PACKAGE_CHANGED')).toBe(true);
  });
  test('copies survive cleaning the original build, and identical retries work', () => {
    const dir = fixture();
    const first = write(dir);
    expect(write(dir)).toEqual(first);
    rmSync(join(dir, 'build'), { recursive: true });
    expect(checked(dir).refusals).toEqual([]);
    expect(readFileSync(join(dir, 'derived/review/v1/config.json'), 'utf8')).toBe(config);
  });
  test('missing recorded package warns with a runnable regeneration command', () => {
    const dir = fixture(); write(dir);
    rmSync(join(dir, 'derived'), { recursive: true });
    const ctx = checked(dir);
    expect(ctx.refusals).toEqual([]);
    expect(ctx.warnings[0]?.code).toBe('REVIEW_PACKAGE_MISSING');
    expect(ctx.warnings[0]?.message).toContain("rig-create review-package 1 --config 'frozen/config.json' --from 'build'");
    write(dir);
    expect(checked(dir).warnings).toEqual([]);
  });
  test('legacy rigs warn while post and pre-interview versions are exempt', () => {
    const dir = fixture();
    expect(checked(dir).warnings[0]?.code).toBe('REVIEW_PACKAGE_MISSING');
    put(dir, 'project.json', JSON.stringify({ schema: 'rig-create/project@0', versions: [{ n: 1, kind: 'rig', at: BUILD_AT, pre_interview: true }, { n: 2, kind: 'post' }] }));
    expect(checked(dir).warnings).toEqual([]);
    expect(() => write(dir)).toThrow('create-built rig');
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
  for (const path of ['parts.json', 'parts', 'rig', 'check/build']) {
    test(`missing required source ${path} refuses without recording`, () => {
      const dir = fixture(); const before = readFileSync(join(dir, 'project.json'), 'utf8');
      rmSync(join(dir, 'build', path), { recursive: true });
      expect(() => write(dir)).toThrow(path);
      expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(before);
    });
  }
  test('outside config and escaping symlinks refuse', () => {
    const dir = fixture(); const other = fixture();
    expect(() => reviewPackageCommand(['1', dir, '--config', join(other, 'frozen/config.json'), '--from', 'build'])).toThrow('project-relative');
    rmSync(join(dir, 'frozen/config.json'));
    symlinkSync(join(other, 'frozen/config.json'), join(dir, 'frozen/config.json'));
    expect(() => write(dir)).toThrow('outside');
  });
  test('source symlinks refuse', () => {
    const dir = fixture();
    symlinkSync(join(dir, 'frozen/config.json'), join(dir, 'build/parts/linked.json'));
    expect(() => write(dir)).toThrow('without symlinks');
  });
  test('a malformed recorded manifest refuses even while the package is absent', () => {
    const dir = fixture(); write(dir);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    project.versions[0].review_package.files = [{ path: '../outside', sha256: 'invalid' }];
    put(dir, 'project.json', JSON.stringify(project));
    rmSync(join(dir, 'derived'), { recursive: true });
    expect(checked(dir).refusals[0]?.code).toBe('REVIEW_PACKAGE_MALFORMED');
  });
  test('another package writer is refused without removing its lock', () => {
    const dir = fixture();
    put(dir, 'project.json.review-package.lock', 'held');
    expect(() => write(dir)).toThrow('project lock');
    expect(readFileSync(join(dir, 'project.json.review-package.lock'), 'utf8')).toBe('held');
  });
  test('a package symlink cannot be adopted on retry', () => {
    const dir = fixture(); const other = fixture(); write(other);
    mkdirSync(join(dir, 'derived/review'), { recursive: true });
    symlinkSync(join(other, 'derived/review/v1'), join(dir, 'derived/review/v1'));
    expect(() => write(dir)).toThrow('symlink');
    expect(checked(other).refusals).toEqual([]);
  });
  test('a destination ancestor symlink refuses before creating external directories', () => {
    const dir = fixture(); const other = fixture();
    symlinkSync(other, join(dir, 'derived'));
    expect(() => write(dir)).toThrow('without symlinks');
    expect(() => readFileSync(join(other, 'review/v1/config.json'))).toThrow();
  });
  test('an existing different package is preserved', () => {
    const dir = fixture(); write(dir);
    put(dir, 'build/parts/piece.png', 'new source');
    const before = readFileSync(join(dir, 'project.json'), 'utf8');
    expect(() => write(dir)).toThrow('existing package differs');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'derived/review/v1/out/parts/piece.png'), 'utf8')).toBe('synthetic part');
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

for (const state of ['missing', 'directory', 'traversal', 'symlink']) {
  test(`packaging refuses a ${state} mask without publishing or writing its record`, () => {
    const dir = fixture();
    const path = state === 'traversal' ? '../figure.png' : 'figure.png';
    put(dir, 'frozen/config.json', JSON.stringify({ requirements: 'requirements.json' }));
    put(dir, 'frozen/requirements.json', JSON.stringify({ setup_painting: { figure_mask: { path, sha256: sha('matte') } } }));
    if (state === 'directory') mkdirSync(join(dir, 'frozen/figure.png'));
    if (state === 'traversal') put(dir, 'figure.png', 'matte');
    if (state === 'symlink') {
      put(dir, 'frozen/original.png', 'matte');
      symlinkSync(join(dir, 'frozen/original.png'), join(dir, 'frozen/figure.png'));
    }
    const before = readFileSync(join(dir, 'project.json'));
    let first: string | undefined;
    for (let retry = 0; retry < 2; retry++) {
      let error: unknown;
      try { write(dir); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Refusal);
      expect((error as Refusal).code).toBe(state === 'traversal' || state === 'symlink' ? 'REVIEW_PACKAGE_PATH_INVALID' : 'FIGURE_MASK_CHANGED');
      first ??= (error as Refusal).message;
      expect((error as Refusal).message).toBe(first);
      expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
      expect(existsSync(join(dir, 'derived/review/v1'))).toBe(false);
    }
  });
}

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
