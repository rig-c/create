import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { type Finding } from '../src/check.ts';
import { optionContext, validateContext } from '../src/choices.ts';
import { DIRECTION_PATCH_SPEC, DIRECTION_SCENE_SINCE, DIRECTION_SCENE_SPEC, directionHash, directionPostIdentity, objects, patchDirection, readDirection, validateDirectionScene, validateDirectionShape } from '../src/direction.ts';
import { currentScene, sceneReference } from '../src/scene.ts';
import type { JsonObject } from '../src/templates.ts';
import { sceneFixture } from './scene-fixture.ts';
import { checkDirections, directionCommand, sceneCommand, testClock } from './clock.ts';
import { openCreateJob } from '../src/job-host.ts';
import { jobHash, jobHostStateRoot, jobPrivateRoot } from '../src/job-outbox.ts';
import { clockedCli } from './helpers.ts';
import { readPublished } from '../src/job-publication.ts';

afterEach(() => testClock.reset());

test('direction CLI publishes a committed example-chain post through its bound writer', async () => {
  const shipped = join(import.meta.dir, '../templates/example-chain');
  const dir = mkdtempSync(join(tmpdir(), 'create-direction-job-'));
  cpSync(join(shipped, 'checkpoints/4-direction-post'), dir, { recursive: true });
  const chain = JSON.parse(readFileSync(join(shipped, 'chain.json'), 'utf8')) as {
    steps: { kind: string; command: string[]; outputs?: Record<string, string> }[];
  };
  const declaration = JSON.parse(readFileSync(join(shipped, 'checkpoints/4-direction-post.json'), 'utf8')) as { chain_step: number };
  testClock.set('2026-11-08T00:00:00Z');
  let host: Awaited<ReturnType<typeof openCreateJob>> | undefined;
  try {
    for (const step of chain.steps.slice(declaration.chain_step, declaration.chain_step + 5)) {
      if (step.kind === 'producer') {
        for (const [path, hash] of Object.entries(step.outputs!)) {
          const bytes = readFileSync(join(shipped, path));
          expect(jobHash(bytes)).toBe(hash);
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), bytes);
        }
      } else {
        const result = Bun.spawnSync([process.execPath, ...clockedCli(), ...step.command.slice(1)], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
        expect(result.stderr.toString()).toBe('');
        expect(result.exitCode).toBe(0);
      }
    }
    host = await openCreateJob(dir, { id: 'reviewer', role: 'owner' }, testClock.now());
    const child = Bun.spawn([process.execPath, ...clockedCli(), ...chain.steps[declaration.chain_step + 5]!.command.slice(1)], {
      cwd: dir, stdout: 'pipe', stderr: 'pipe',
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exit !== 0) await readPublished({ root: dir, record: { path: 'project.json', sha256: jobHash(readFileSync(join(dir, 'project.json'))) }, result: { path: 'review-live-v2.json', selector: { kind: 'post', version: 2, rigVersion: 1 } } });
    expect(stderr).toBe('');
    expect(exit).toBe(0);
    const publication = host.session.status().publication!;
    expect(publication.source.projectHash).toBe(jobHash(readFileSync(join(dir, 'project.json'))));
    expect(publication.source.selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
    expect(publication.label).toBe('post v2 (rig v1)');
    expect(publication.source.direction?.sha256).toBe(jobHash(readFileSync(join(dir, 'evidence/direction/v2.json'))));
  } finally {
    host?.stop();
    rmSync(jobPrivateRoot(dir), { recursive: true, force: true });
    rmSync(jobHostStateRoot(dir), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(animation?: string) {
  const f = sceneFixture(animation === undefined ? ['idle'] : ['idle', animation]);
  if (animation === undefined) f.writeScene();
  else sceneCommand([...f.args(), '--animation', animation]);
  const doc: JsonObject = { ...f.doc, schema: DIRECTION_SCENE_SPEC, rig: { version: 1, model: f.modelBinding }, scene: sceneReference(currentScene(f.load())!) };
  const publish = (n = 2) => { f.write('evidence/input.json', JSON.stringify(doc)); return directionCommand(['write', String(n), f.dir, '--file', 'evidence/input.json', '--rig', '1']); };
  return { ...f, doc, publish };
}
function checked(f: ReturnType<typeof setup>) {
  const ctx = { dir: f.dir, project: f.load(), refusals: [] as Finding[], warnings: [] as Finding[] };
  checkDirections(ctx); return ctx;
}
function reject(f: ReturnType<typeof setup>, code: string, run: () => unknown) {
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(run).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
}

test('direction@2 keeps direction@1 camera and timing and gains the scene-bound post identity', () => {
  const f = setup(); expect(f.publish().exit).toBe(0);
  expect(readDirection(f.dir, f.load(), 2)).toEqual(f.doc);
  const identity = directionPostIdentity(f.dir, f.load(), 2);
  expect(identity.scene).toEqual({ path: (f.doc.scene as JsonObject).path!, sha256: (f.doc.scene as JsonObject).sha256! });
  expect(checked(f).refusals).toEqual([]); expect(checked(f).warnings).toEqual([]);
  const patch: JsonObject = { schema: DIRECTION_PATCH_SPEC, source_post: 2, rig_model_sha256: f.modelBinding.sha256!, direction_sha256: (identity.direction as JsonObject).sha256!, replace: { take: { duration: 4, loop: true } } };
  f.write('evidence/patch.json', JSON.stringify(patch));
  expect(directionCommand(['patch', '3', f.dir, '--patch-file', 'evidence/patch.json']).exit).toBe(0);
  expect(readDirection(f.dir, f.load(), 3).scene).toEqual(f.doc.scene);
  patch.replace = { scene: f.doc.scene! };
  expect(() => patchDirection(f.load(), f.doc, patch)).toThrow(expect.objectContaining({ code: 'DIRECTION_PATCH' }));
});

test('non-looping direction@2 retains the selected non-idle scene without idle frames', () => {
  const f = setup('look');
  expect((f.doc.take as JsonObject).loop).toBe(false);
  expect(f.publish().exit).toBe(0);
  const doc = readDirection(f.dir, f.load(), 2);
  expect(doc.scene).toEqual(f.doc.scene);
  expect((doc.take as JsonObject).loop).toBe(false);
  validateDirectionScene(f.dir, f.load(), doc, true);
  const scene = JSON.parse(readFileSync(join(f.dir, String((doc.scene as JsonObject).path)), 'utf8')) as JsonObject;
  expect((scene.rig as JsonObject).animation).toEqual({ name: 'look' });
  expect(checked(f).refusals).toEqual([]);
  expect(checked(f).warnings).toEqual([]);
});

test('DIRECTION_SCENE_MISMATCH refuses direction rig/model differing from the scene', () => {
  const f = setup();
  (f.doc.rig as JsonObject).model = { ...f.modelBinding, sha256: '0'.repeat(64) };
  reject(f, 'DIRECTION_SCENE_MISMATCH', () => f.publish());
});

test('DIRECTION_SCENE_STALE refuses new authoring while historical posts retain their scenes', () => {
  const f = setup(); f.publish();
  const old = f.doc.scene;
  testClock.set('2026-11-07T10:01:00Z');
  const reopened = f.load();
  reopened.reopens = [{stage:'post',from_stage:'post',by:'user',at:testClock.iso(),verbatim:'Revise the composition.',steps_before:[]}]; f.save(reopened);
  testClock.set('2026-11-07T10:01:01Z'); f.writeScene(true);
  expect(readDirection(f.dir, f.load(), 2).scene).toEqual(old);
  expect(checked(f).refusals).toEqual([]);
  reject(f, 'DIRECTION_SCENE_STALE', () => f.publish(3));
  f.doc.scene = sceneReference(currentScene(f.load())!);
  expect(f.publish(3).exit).toBe(0);
  const p = f.load();
  const version = objects(p.versions).find(value => value.n === 3)!;
  const binding = (version.provenance as JsonObject).direction as JsonObject;
  const planted = { ...f.doc, scene: old };
  binding.sha256 = f.write(String(binding.path), JSON.stringify(planted)).sha256!;
  (version.provenance as JsonObject).config = { ...binding };
  version.outputs = [{ ...binding }]; f.save(p);
  expect(checked(f).refusals.map(value => value.code)).toContain('DIRECTION_SCENE_STALE');
});

const sinceOffset = (seconds: number): string => new Date(Date.parse(DIRECTION_SCENE_SINCE) + seconds * 1000).toISOString();
for (const at of [sinceOffset(-1), DIRECTION_SCENE_SINCE, sinceOffset(1)]) {
  test(`DIRECTION_SCENE_REQUIRED dates an @1 post at ${at}`, () => {
    const f = setup();
    f.doc.schema = 'rig-create/direction@1'; delete f.doc.scene;
    testClock.set(at);
    if (Date.parse(at) >= Date.parse(DIRECTION_SCENE_SINCE)) reject(f, 'DIRECTION_SCENE_REQUIRED', () => f.publish());
    else {
      expect(f.publish().exit).toBe(0);
      const ctx = checked(f);
      expect(ctx.refusals).toEqual([]);
      expect(ctx.warnings.map(value => value.code)).toEqual(['DIRECTION_SCENE_REQUIRED']);
      expect(ctx.warnings[0]!.message).toContain('scene write');
      // The same retained document is required at and after the cutoff by its post date.
      const p = f.load(); objects(p.versions).find(value => value.n === 2)!.at = DIRECTION_SCENE_SINCE; f.save(p);
      expect(checked(f).refusals.map(value => value.code)).toEqual(['DIRECTION_SCENE_REQUIRED']);
    }
  });
}

test('grandfathered posts bypass @1 and @2 checks, preserving the adoption record', () => {
  const f = setup();
  const p = f.load();
  const contract = p.direction_contract as JsonObject;
  p.versions = [...objects(p.versions), { n: 2, kind: 'post', rig_version: 1, at: '2026-11-04T08:40:00Z', provenance: { direction: { path: 'missing.json', sha256: '0'.repeat(64) } } }];
  contract.grandfathered_posts = [2]; f.save(p);
  expect(checked(f).refusals).toEqual([]); expect(checked(f).warnings).toEqual([]);
  const before = structuredClone(contract);
  f.writeScene(); expect(f.load().direction_contract).toEqual(before);
});

test('a new post without a direction@2 document refuses even before direction adoption', () => {
  const f = setup(); const p = f.load(); delete p.direction_contract;
  p.versions = [...objects(p.versions), { n: 2, kind: 'post', rig_version: 1, at: DIRECTION_SCENE_SINCE }]; f.save(p);
  expect(checked(f).refusals.map(value => value.code)).toEqual(['DIRECTION_SCENE_REQUIRED']);
});

test('@2 requires the exact closed committed scene reference', () => {
  const f = setup();
  for (const extra of ['missing', 'unknown']) {
    const doc = structuredClone(f.doc);
    if (extra === 'missing') delete doc.scene; else (doc.scene as JsonObject).unexpected = true;
    expect(() => validateDirectionShape(doc)).toThrow(expect.objectContaining({ code: 'DIRECTION_SCHEMA' }));
  }
  (f.doc.scene as JsonObject).sha256 = '0'.repeat(64);
  expect(() => validateDirectionScene(f.dir, f.load(), f.doc)).toThrow(expect.objectContaining({ code: 'SCENE_MALFORMED' }));
});

test('post option context binds scene bytes, resolves freshness and preserves legacy rig contexts', () => {
  const f = setup(); const p = f.load(); const at = Date.parse('2026-11-07T10:00:00Z');
  const context = optionContext(p, 'post-interview', at, f.dir);
  expect(context).toEqual({ kind: 'scene', scene: f.doc.scene! });
  const set = { stage: 'post-interview', drafted_at: '2026-11-07T10:00:00Z', context };
  validateContext(f.dir, p, set, at, true);
  testClock.set('2026-11-07T10:01:00Z');
  const reopened = f.load();
  reopened.reopens = [{stage:'post',from_stage:'post',by:'user',at:testClock.iso(),verbatim:'Revise the composition.',steps_before:[]}]; f.save(reopened);
  testClock.set('2026-11-07T10:01:01Z'); f.writeScene(true);
  expect(() => validateContext(f.dir, f.load(), set, testClock.now(), true)).toThrow(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE' }));
  const latest = currentScene(f.load())!;
  writeFileSync(join(f.dir, String(latest.path)), '{}');
  expect(() => optionContext(f.load(), 'post-interview', testClock.now(), f.dir)).toThrow(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE' }));
  const next = { ...set, drafted_at: testClock.iso(), context: { kind: 'scene', scene: sceneReference(latest) } };
  expect(() => validateContext(f.dir, f.load(), next, testClock.now(), true)).toThrow(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE' }));
});

test('direction source snapshot includes every scene dependency before the project commit', () => {
  const f = setup(); f.write('evidence/input.json', JSON.stringify(f.doc));
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(() => directionCommand(['write', '2', f.dir, '--file', 'evidence/input.json', '--rig', '1'], { beforeCommit: () => { f.write('background.png', 'changed'); } })).toThrow(expect.objectContaining({ code: 'DIRECTION_SOURCE_CHANGED' }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});

test('SCENE_RIG_STALE gates current authoring and the current live post while historical scenes remain valid', () => {
  const f = setup(); f.publish();
  const p = f.load();
  const later = structuredClone(objects(p.versions)[0]!);
  later.n = 3; later.at = '2026-11-07T10:01:00Z'; later.verdicts = [];
  p.versions = [...objects(p.versions), later]; f.save(p);
  const ctx = checked(f);
  expect(ctx.refusals.map(value => value.code)).toEqual(['SCENE_RIG_STALE']);
  reject(f, 'SCENE_RIG_STALE', () => f.writeScene());
});
