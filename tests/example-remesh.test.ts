import { describe, expect, test } from 'bun:test';
import { consumerOnlyTest } from './consumer-only.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMESH_WARNINGS_AFTER_REOPEN, REMESH_WARNINGS_BEFORE_REOPEN, generateExampleRemesh, remeshFiles } from '../scripts/generate-example-remesh.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { asArray, checkProject, isObject } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';

const templateRoot = join(import.meta.dir, '../templates/example-remesh');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('five-version reopened example with a producer mesh', () => {
  test('committed template checks with 0 refusals, exact warnings before and after reopen, 5 bound versions and producer meshes', () => {
    const project = JSON.parse(readFileSync(join(templateRoot, 'project.json'), 'utf8')) as JsonObject;
    expect(project.stage).toBe('parts-review');

    const reopens = asArray(project.reopens).filter(isObject);
    expect(reopens.map(r => r.stage)).toEqual(['parts-review']);

    const drafts = asArray(project.drafts).filter(isObject);
    expect(drafts.length).toBeGreaterThan(0);
    const currentDraft = drafts.at(-1)!;
    const draftModelEntry = asArray(currentDraft.files)
      .filter(isObject)
      .find(f => String(f.path).endsWith('/out/check/build/skeleton.model.json'));
    expect(draftModelEntry).toBeDefined();
    const draftModelBytes = readFileSync(join(templateRoot, String(draftModelEntry!.path)));
    expect(sha256(draftModelBytes)).toBe(String(draftModelEntry!.sha256));
    const draftModel = JSON.parse(draftModelBytes.toString('utf8')) as { spec: string; meshes: unknown[] };
    expect(draftModel.spec).toBe('rigc-compiled/3');
    expect(draftModel.meshes.length).toBeGreaterThan(0);

    const versions = asArray(project.versions).filter(isObject);
    expect(versions.map(v => [v.n, v.kind])).toEqual([
      [1, 'rig'],
      [2, 'rig'],
      [3, 'rig'],
      [4, 'post'],
      [5, 'post'],
    ]);

    for (const v of versions) {
      const provenance = v.provenance as JsonObject;
      const configBinding = provenance.config as JsonObject;
      expect(typeof configBinding.path).toBe('string');
      const configBytes = readFileSync(join(templateRoot, String(configBinding.path)));
      expect(sha256(configBytes)).toBe(String(configBinding.sha256));

      const outputs = asArray(v.outputs).filter(isObject);
      expect(outputs.length).toBeGreaterThan(0);
      for (const out of outputs) {
        const outBytes = readFileSync(join(templateRoot, String(out.path)));
        expect(sha256(outBytes)).toBe(String(out.sha256));
      }

      if (v.kind === 'rig') {
        const reviewPkg = v.review_package as JsonObject;
        expect(reviewPkg).toBeDefined();
        expect(reviewPkg.open).toBe(`rig-review open 'derived/review/v${String(v.n)}/out'`);
        const pkgFiles = asArray(reviewPkg.files).filter(isObject);
        const inputPartFiles = pkgFiles.filter(f => String(f.path).startsWith('out/parts'));
        expect(inputPartFiles.length).toBeGreaterThan(0);
        for (const pkgFile of pkgFiles) {
          const pkgBytes = readFileSync(join(templateRoot, `derived/review/v${String(v.n)}`, String(pkgFile.path)));
          expect(sha256(pkgBytes)).toBe(String(pkgFile.sha256));
        }
        const pkgModelPath = `derived/review/v${String(v.n)}/out/check/build/skeleton.model.json`;
        expect(existsSync(join(templateRoot, pkgModelPath))).toBe(true);
        const pkgModel = JSON.parse(readFileSync(join(templateRoot, pkgModelPath), 'utf8')) as {
          spec: string;
          meshes: unknown[];
        };
        expect(pkgModel.spec).toBe('rigc-compiled/3');
        expect(pkgModel.meshes.length).toBeGreaterThan(0);
      } else {
        const directionDoc = JSON.parse(configBytes.toString('utf8')) as JsonObject;
        const sceneRef = directionDoc.scene as JsonObject;
        const sceneBytes = readFileSync(join(templateRoot, String(sceneRef.path)));
        expect(sha256(sceneBytes)).toBe(String(sceneRef.sha256));
        const rigRef = (directionDoc.rig as JsonObject).model as JsonObject;
        const rigModelBytes = readFileSync(join(templateRoot, String(rigRef.path)));
        expect(sha256(rigModelBytes)).toBe(String(rigRef.sha256));
      }
    }

    // The reopen receipt records the stage and step statuses needed to check the prior state.
    const before = structuredClone(project);
    const reopen = reopens[0]!;
    before.stage = reopen.from_stage!;
    before.reopens = [];
    const steps = asArray((before.plan as JsonObject).steps).filter(isObject);
    for (const prior of asArray(reopen.steps_before).filter(isObject)) {
      const step = steps.find(step => step.id === prior.id)!;
      if (prior.status === undefined) delete step.status;
      else step.status = prior.status;
    }
    const beforeReport = checkProject(templateRoot, before, { now: EXAMPLE_NOW, readOnly: true });
    expect(beforeReport.refusals).toEqual([]);
    expect(beforeReport.warnings.map(f => [f.code, f.path])).toEqual([...REMESH_WARNINGS_BEFORE_REOPEN]);

    const afterReport = checkProject(templateRoot, undefined, { now: EXAMPLE_NOW, readOnly: true });
    expect(afterReport.refusals).toEqual([]);
    expect(afterReport.warnings.map(f => [f.code, f.path])).toEqual([...REMESH_WARNINGS_AFTER_REOPEN]);
  });

  consumerOnlyTest('tests/example-remesh.test.ts', 'two fresh generator runs match each other and templates/example-remesh byte for byte', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'rig-create-remesh-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'rig-create-remesh-b-'));
    try {
      const runA = generateExampleRemesh(join(dirA, 'run'));
      const runB = generateExampleRemesh(join(dirB, 'run'));
      const committed = remeshFiles(templateRoot);

      expect(Object.keys(runA)).toEqual(Object.keys(committed));
      expect(Object.keys(runB)).toEqual(Object.keys(committed));
      for (const [path, bytes] of Object.entries(committed)) {
        expect(runA[path]!.equals(bytes)).toBe(true);
        expect(runB[path]!.equals(bytes)).toBe(true);
      }
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  }, 120_000);
});
