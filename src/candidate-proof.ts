import { join, relative } from 'node:path';
import type { CandidateBatchIdentity } from './candidate-storage.ts';
import { isObject } from './check.ts';
import { lstatSync, realpathSync } from './check-reads.ts';
import { sha256, treeFiles } from './current.ts';
import { directionJson } from './direction.ts';
import { privateJson } from './job-outbox.ts';
import { refuse } from './refusal.ts';
import { sceneBytes } from './scene.ts';

export type Seal = { path: string; sha256: string };

export interface CandidateSelector {
  kind: 'candidate';
  receipt: Seal;
  setSha256: string;
  askId: string;
  optionId: string;
}

export interface CandidateProof {
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
