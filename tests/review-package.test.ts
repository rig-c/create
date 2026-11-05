import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { checkProject } from '../src/check.ts';
import { checkReviewPackages, reviewPackageCommand } from '../src/review-package.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { generateExampleReview } from '../scripts/generate-example-review.ts';
import { fixture as exampleFixture, obj, version } from './fixtures.ts';
import { reviewExampleFiles } from './review-fixture.ts';
import { CLI, run } from './helpers.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const config = '{"key":"synthetic","bones":[{"name":"root"}]}\n';
const model = JSON.stringify({ spec: 'rigc-compiled/3', referenceScale: 100, stage: { x: 0, y: 0, width: 10, height: 10 }, bones: [{ name: 'root' }], slots: [], skins: [], constraints: [], events: [], animations: [], pages: [] });
function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-package-'));
  roots.push(dir);
  put(dir, 'project.json', JSON.stringify({ schema: 'rig-create/project@0', stage: 'interview', versions: [{ n: 1, kind: 'rig', outputs: [], verdicts: [] }] }));
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
  const ctx = { dir, project: JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject, refusals: [] as { code: string }[], warnings: [] as { code: string; message: string }[] };
  checkReviewPackages(ctx as Parameters<typeof checkReviewPackages>[0]);
  return ctx;
}

describe('frozen review package', () => {
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
  test('the filled example checks clean with real package files', () => {
    const dir = exampleFixture();
    roots.push(dirname(dir));
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY']);
  });
  test('stripping an example package record warns and keeps exit zero', () => {
    const dir = exampleFixture((project) => { delete version(project, 1).review_package; });
    roots.push(dirname(dir));
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map((finding) => finding.code)).toEqual(['QUESTION_SET_STALE', 'REVIEW_PACKAGE_MISSING', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY']);
  });
  test('removing one example package warns with its recorded regeneration command', () => {
    const dir = exampleFixture();
    roots.push(dirname(dir));
    rmSync(join(dir, 'derived/review/v1'), { recursive: true });
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map((finding) => finding.code)).toEqual(['QUESTION_SET_STALE', 'REVIEW_PACKAGE_MISSING', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY']);
    expect(report.warnings[1]?.message).toContain("--config 'evidence/v1/review-config.json' --from 'outputs/v1/out'");
  });
  test('normal CLI writes a package whose installed feedback resolves the config hash', () => {
    const dir = fixture();
    const made = run([process.execPath, CLI, 'review-package', '1', dir, '--config', 'frozen/config.json', '--from', 'build', '--json'], dir, { ...process.env } as Record<string, string>);
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
    put(dir, 'project.json', JSON.stringify({ schema: 'rig-create/project@0', versions: [{ n: 1, kind: 'rig', pre_interview: true }, { n: 2, kind: 'post' }] }));
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
