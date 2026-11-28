import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openCandidateHost } from '../src/candidate-host.ts';
import { writeCandidatePackage } from '../src/candidate-package.ts';
import { readCandidateProof } from '../src/candidate-proof.ts';
import { composeCandidate, prepareCandidateScene, resolveCandidateSet } from '../src/candidate.ts';
import { agentCall } from '../src/job-acts.ts';
import { candidateFixture, CANDIDATE_NOW, CANDIDATE_QUESTION, CANDIDATE_SET, literalDigest } from './candidate-fixture.ts';
import { obj } from './fixtures.ts';
import { sourceOnlyTest } from './source-only.ts';

const GENERATED_SCENE = 'scratch/candidates/preview/camera-free.scene.json';

test('#1171 candidate keyed scene preserves the exact option path and raw digest', () => {
  const f = candidateFixture();
  const scenePath = 'specs/direction/keyed-option.scene.json';
  const scene = f.read('specs/direction/compose-scene.json');
  scene.camera = { backdrop: 'backdrop', tracks: { idle: [
    { t: 0, pan: [0, 0], zoom: 1 }, { t: 4, pan: [0, 0], zoom: 1 },
  ] } };
  const sourcePath = join(f.root, scenePath);
  f.write(scenePath, scene);
  appendFileSync(sourcePath, '\n\t\n'); // The binding measures authored bytes, including whitespace.
  const original = readFileSync(sourcePath);
  const authored = { path: scenePath, sha256: literalDigest(original) };
  obj(obj(f.options[0]!.fragment).compose).camera_scene = authored;
  f.save();
  const { options } = resolveCandidateSet(f.root, f.project, CANDIDATE_QUESTION, CANDIDATE_SET, CANDIDATE_NOW);
  const preview = prepareCandidateScene(f.root, f.project, options[0]!, GENERATED_SCENE, new Map());
  expect(preview.source).toEqual(authored);
  expect(preview.scene).toEqual(scene);
  expect(preview.keyed).toBe(true);
  expect(preview.generated).toBe(false);
  expect(existsSync(join(f.root, GENERATED_SCENE))).toBe(false);
  expect(readFileSync(sourcePath)).toEqual(original);
  appendFileSync(sourcePath, '\n');
  expect(() => prepareCandidateScene(f.root, f.project, options[0]!, GENERATED_SCENE, new Map()))
    .toThrow(expect.objectContaining({ code: 'INTERVIEW_CAMERA_SCENE_INVALID' }));
});

sourceOnlyTest('#1171 candidate unkeyed Parts compose seals the private scene and publishes a null scene report', async () => {
  const f = candidateFixture();
  const binding = f.save();
  const projectPath = join(f.root, 'project.json');
  const before = readFileSync(projectPath);
  const { options } = resolveCandidateSet(f.root, f.project, CANDIDATE_QUESTION, CANDIDATE_SET, CANDIDATE_NOW);
  // The offset option clips the actor, exercising one compose with the generated clip declaration.
  const option = options.find(row => row.optionId === 'alternative')!;
  const row = 'scratch/candidates/preview';
  const rowPath = join(f.root, row);
  mkdirSync(rowPath, { recursive: true, mode: 0o700 });
  const snapshots = new Map<string, Buffer>();
  const scene = prepareCandidateScene(f.root, f.project, option, GENERATED_SCENE, snapshots);
  const { input, output } = await composeCandidate(f.root, f.project, `${row}/compose`, scene, snapshots);
  const identity = { setSha256: binding.sha256, askId: CANDIDATE_QUESTION, optionId: 'alternative' };
  const batch = { question: CANDIDATE_QUESTION, setId: CANDIDATE_SET, setSha256: binding.sha256 };
  writeCandidatePackage(f.root, rowPath, batch, option, input, output, f.project);
  const proof = readCandidateProof(f.root, rowPath, batch);
  const sourcePath = join(f.root, GENERATED_SCENE);
  const source = { path: GENERATED_SCENE, sha256: literalDigest(readFileSync(sourcePath)) };
  expect(statSync(sourcePath).mode & 0o777).toBe(0o600);
  expect(f.read(GENERATED_SCENE)).not.toHaveProperty('camera');
  expect(input.character.canvas_clip).toBe(true);
  expect(scene.source).toEqual(source);
  expect(input.source).toEqual(source);
  expect(proof.scene).toEqual(source);
  expect(f.read(proof.run.path)).toMatchObject({ spec: 'rig-compose-run/1', scene: source });
  expect(output.sceneReport.spec).toBe('spine-parts-scene-report/1');
  expect(proof.selector).toMatchObject({ kind: 'candidate', ...identity });
  expect(f.read(`${row}/package/candidate.json`)).toMatchObject({ ...identity, camera: 'unkeyed', sceneReport: null });
  expect(f.read(`${row}/package/take.json`)).toMatchObject({ clip: 'idle', duration: 4, loop: true, sceneReport: null });
  expect(f.read(`${row}/package/review.json`)).not.toHaveProperty('sceneReport');
  expect(existsSync(join(rowPath, 'package/scene.json'))).toBe(false);

  const host = await openCandidateHost(rowPath, { id: 'synthetic-owner', role: 'owner' });
  try {
    const published = await agentCall(host, {
      verb: 'publish', expectedGeneration: 0, idempotencyKey: 'synthetic-candidate',
      freeze: { kind: 'producer-held', holdId: 'test', record: null },
      result: { path: 'review.json', selector: proof.selector },
    });
    expect(published.ok).toBe(true);
    expect(host.session.status().publication?.source.selector).toEqual(proof.selector);
  } finally { host.stop(); }
  expect(readFileSync(projectPath)).toEqual(before);
}, 15_000);
