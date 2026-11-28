import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { type CandidateBatchIdentity } from './candidate-storage.ts';
import { type prepareCandidateScene, type verifyCandidateOutput } from './candidate.ts';
import { currentFileBinding, sha256, treeFiles } from './current.ts';
import { directionJson, objects } from './direction.ts';
import { privateJson, writePrivateJson } from './job-outbox.ts';
import { refuse } from './refusal.ts';
import { sceneBytes } from './scene.ts';
import { isObject } from './check.ts';
import type { JsonObject } from './templates.ts';

type Seal = { path: string; sha256: string };

export interface CandidateSelector {
  kind: 'candidate';
  receipt: Seal;
  setSha256: string;
  askId: string;
  optionId: string;
}

interface CandidateProof {
  selector: CandidateSelector;
  label: string;
  scene: Seal;
  run: Seal;
  evidence: Seal[];
  files: Seal[];
  rigSha256: string;
  motionSha256: string;
}

export const CANDIDATE_PROOF_FILE = 'proof.json';

export function invalidCandidate(path: string, option: string): never {
  return refuse('CANDIDATE_RECEIPT_MISMATCH',
    `${path}: candidate ${option} does not match its sealed scene, compose run, or playback files. Rerun rig-create candidate open for the same pending set to rebuild the candidate.`);
}

function writePackageJson(root: string, path: string, data: object): Seal {
  const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(join(root, path), bytes, { flag: 'wx', mode: 0o600 });
  return { path, sha256: sha256(bytes) };
}

export function writeCandidatePackage(root: string, path: string, batch: CandidateBatchIdentity,
  option: { askId: string; optionId: string; label: string }, input: ReturnType<typeof prepareCandidateScene>,
  take: ReturnType<typeof verifyCandidateOutput>, project: JsonObject): CandidateProof {
  const pkg = join(path, 'package');
  mkdirSync(join(pkg, 'build'), { recursive: true, mode: 0o700 });
  const copy = (seal: Seal, target: string, destination = pkg): Seal => {
    const bytes = sceneBytes(root, seal.path, 'CANDIDATE_RECEIPT_MISMATCH');
    if (sha256(bytes) !== seal.sha256) invalidCandidate(seal.path, option.optionId);
    const path = join(destination, target);
    copyFileSync(join(root, seal.path), path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    if (sha256(readFileSync(path)) !== seal.sha256) invalidCandidate(seal.path, option.optionId);
    return { path: target, sha256: seal.sha256 };
  };
  const model = copy(take.model.binding, 'build/skeleton.model.json');
  const pages = objects(directionJson(take.model.bytes, model.path).pages);
  for (const page of pages) {
    const name = page.name;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      invalidCandidate(model.path, option.optionId);
    }
    const seal = take.inventory.find(row => row.path === posix.join(posix.dirname(take.model.binding.path), name));
    if (!seal) invalidCandidate(model.path, option.optionId);
    copy(seal, `build/${name}`);
  }
  const sceneReport = input.keyed ? copy(take.report.binding, 'scene.json') : null;
  const descriptor = writePackageJson(pkg, 'take.json', {
    schema: 'rig-create/candidate-take@1', clip: 'idle', duration: take.duration, loop: take.loop, model, sceneReport,
  });
  const identity = { setSha256: batch.setSha256, askId: option.askId, optionId: option.optionId };
  const receipt = writePackageJson(pkg, 'candidate.json', {
    schema: 'rig-create/candidate-preview@1', ...identity, camera: input.keyed ? 'keyed' : 'unkeyed',
    model, take: descriptor, sceneReport,
  });
  writePackageJson(pkg, 'review.json', {
    schema: 'rig-review/1', id: 'candidate', revision: receipt.sha256,
    title: option.label, model: model.path, direction: descriptor.path, ...(sceneReport ? { sceneReport } : {}),
    references: [], animations: [], checkpoints: [], authoring: [],
  });
  const rig = currentFileBinding(project, 'rig', String(input.rigModelPath));
  const motion = isObject(project.current) ? project.current.motion : undefined;
  if (!rig || !isObject(motion) || typeof motion.files_sha256 !== 'string') {
    invalidCandidate('current.rig/current.motion', option.optionId);
  }
  const producer = join(path, 'producer');
  mkdirSync(producer, { mode: 0o700 });
  const projectSeal = ({ path, sha256 }: Seal): Seal => ({ path: relative(root, join(producer, path)).replaceAll('\\', '/'), sha256 });
  const run = projectSeal(copy(take.run.binding, 'compose-run.json', producer));
  const check = projectSeal(copy(take.check.binding, 'check.json', producer));
  const report = projectSeal(copy(take.report.binding, 'scene.json', producer));
  const evidence = [check, report];
  if (!input.keyed) {
    const motion = take.inventory.find(row => row.path === `${posix.dirname(take.report.binding.path)}/rig/motion.json`);
    if (!motion) invalidCandidate(report.path, option.optionId);
    evidence.push(projectSeal(copy(motion, 'motion.json', producer)));
  }
  const selector: CandidateSelector = { kind: 'candidate', ...identity, receipt };
  const prefix = relative(root, pkg).split('\\').join('/');
  const proof: CandidateProof = {
    selector, label: option.label, scene: input.source, run, evidence,
    files: treeFiles(root, prefix).map(({ path, sha256 }) => ({ path, sha256 })),
    rigSha256: rig.sha256, motionSha256: motion.files_sha256,
  };
  writePrivateJson(join(path, CANDIDATE_PROOF_FILE), proof);
  return proof;
}

export function readCandidateProof(root: string, path: string, batch: CandidateBatchIdentity): CandidateProof {
  const file = join(path, CANDIDATE_PROOF_FILE);
  let option = 'preview';
  try {
    const proof = privateJson(file) as CandidateProof;
    option = proof.selector.optionId;
    if (proof.selector.kind !== 'candidate' || proof.selector.setSha256 !== batch.setSha256) invalidCandidate(file, option);
    const pkg = join(path, 'package');
    if (!lstatSync(pkg).isDirectory() || realpathSync(pkg) !== pkg) invalidCandidate(file, option);
    const expectedDir = relative(root, pkg).replaceAll('\\', '/');
    const actual = treeFiles(root, expectedDir).map(({ path, sha256 }) => ({ path, sha256 }));
    if (JSON.stringify(proof.files) !== JSON.stringify(actual)
      || proof.selector.receipt.sha256 !== actual.find(row => row.path === `${expectedDir}/${proof.selector.receipt.path}`)?.sha256) {
      invalidCandidate(file, option);
    }
    for (const seal of proof.evidence) {
      const bytes = sceneBytes(root, seal.path, 'CANDIDATE_RECEIPT_MISMATCH');
      if (sha256(bytes) !== seal.sha256) invalidCandidate(seal.path, option);
    }
    const scene = sceneBytes(root, proof.scene.path, 'CANDIDATE_RECEIPT_MISMATCH');
    const run = sceneBytes(root, proof.run.path, 'CANDIDATE_RECEIPT_MISMATCH');
    const runObject = directionJson(run, proof.run.path);
    if (sha256(scene) !== proof.scene.sha256 || sha256(run) !== proof.run.sha256 || runObject.spec !== 'rig-compose-run/1'
      || !isObject(runObject.scene)
      || runObject.scene.sha256 !== proof.scene.sha256 || runObject.scene.path !== proof.scene.path) invalidCandidate(file, option);
    return proof;
  } catch {
    return invalidCandidate(file, option);
  }
}
