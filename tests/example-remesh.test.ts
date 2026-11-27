import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { asArray, checkProject, isObject } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';

const templateRoot = join(import.meta.dir, '../templates/example-remesh');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('five-version amended example with a producer mesh', () => {
  test('committed template checks clean before and after the amendment and binds five versions and producer meshes', () => {
    const project = JSON.parse(readFileSync(join(templateRoot, 'project.json'), 'utf8')) as JsonObject;
    expect(project.stage).toBe('accepted');
    expect(asArray(project.reopens)).toEqual([]);

    const amendments = asArray(project.amendments).filter(isObject);
    expect(amendments).toHaveLength(1);
    const [amendment] = amendments;
    const change = 'evidence/remesh-grid.json';
    expect(amendment).toMatchObject({
      by: 'user', target: { stage: 'parts-review', kind: 'config-field', id: '/meshes/torso/grid' },
      changes: [{ path: change, sha256: sha256(readFileSync(join(templateRoot, change))) }],
    });

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

    // The amendment keeps stage and status_history. Recover the earlier status from each history.
    const before = structuredClone(project);
    delete before.amendments;
    const steps = asArray((before.plan as JsonObject).steps).filter(isObject);
    for (const step of steps) {
      const last = asArray(step.status_history).filter(isObject).at(-1);
      if (last?.status !== undefined) step.status = last.status;
    }
    const beforeReport = checkProject(templateRoot, before, { now: EXAMPLE_NOW, readOnly: true });
    expect(beforeReport).toMatchObject({ refusals: [], warnings: [], effective_stage: 'accepted' });

    const afterReport = checkProject(templateRoot, undefined, { now: EXAMPLE_NOW, readOnly: true });
    expect(afterReport).toMatchObject({ refusals: [], warnings: [], effective_stage: 'parts-review' });
    expect(afterReport.amendments?.[0]?.lapsed.map(approval => approval.path)).toEqual([
      'signoffs[3]', 'signoffs[4]', 'signoffs[5]', 'signoffs[6]', 'signoffs[7]',
      'versions[2].verdicts[0]', 'versions[4].verdicts[0]',
    ]);
  });

  test('generator --check verifies every frozen file hash and reader result against the baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-create-remesh-check-'));
    try {
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/generate-example-remesh.ts'), join(dir, 'run'), '--check'], {
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('example remesh: 264 file hashes, 2 pre-amendment checks and 8 reader results match');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
