import { lstatSync, realpathSync } from './check-reads.ts';
import { join } from 'node:path';
import { candidateBatchPaths, candidateOptionPaths, CANDIDATE_STORAGE_PATH, readCandidateBatchIdentity } from './candidate-storage.ts';
import { invalidCandidate, readCandidateProof } from './candidate-proof.ts';
import { composableOptions } from './compose-value.ts';
import { isObject, type Ctx } from './check.ts';
import { optionFile } from './choices.ts';
import { currentRigFileBinding } from './current.ts';
import { Refusal } from './refusal.ts';

export function checkCandidateReceipts(ctx: Pick<Ctx, 'dir' | 'items' | 'project' | 'warnings'>): void {
  if (!lstatSync(join(ctx.dir, CANDIDATE_STORAGE_PATH), { throwIfNoEntry: false })) return;
  const root = realpathSync(ctx.dir);
  const storage = join(root, CANDIDATE_STORAGE_PATH);
  try {
    for (const path of candidateBatchPaths(storage)) {
      if (!lstatSync(join(path, 'ready.json'), { throwIfNoEntry: false })) continue;
      const batch = readCandidateBatchIdentity(storage, path);
      const item = batch && ctx.items.find(item => item.kind === 'post' && item.id === batch.question);
      const binding = item?.record.pending_options;
      if (!batch || !isObject(binding) || binding.sha256 !== batch.setSha256) continue;
      const { set } = optionFile(root, binding);
      const expected = composableOptions(set);
      const rig = currentRigFileBinding(ctx.project, 'check/build/skeleton.model.json');
      const motion = isObject(ctx.project.current) && isObject(ctx.project.current.motion) ? ctx.project.current.motion : undefined;
      const seen = new Set<string>();
      for (const row of candidateOptionPaths(path)) {
        const { selector, rigSha256, motionSha256, scene } = readCandidateProof(root, row, batch);
        const option = expected.find(option => option.askId === selector.askId && option.optionId === selector.optionId);
        const compose = isObject(option?.compose) ? option.compose : undefined;
        const camera = compose && isObject(compose.camera_scene) ? compose.camera_scene : undefined;
        const id = JSON.stringify([selector.askId, selector.optionId]);
        if (!compose || seen.has(id) || rig?.sha256 !== rigSha256 || motion?.files_sha256 !== motionSha256
          || (camera && (scene.path !== camera.path || scene.sha256 !== camera.sha256))) {
          invalidCandidate(row, selector.optionId);
        }
        seen.add(id);
      }
      if (seen.size !== expected.length) invalidCandidate(path, batch.setId);
    }
  } catch (error) {
    const code = 'CANDIDATE_RECEIPT_MISMATCH';
    ctx.warnings.push({ code, path: CANDIDATE_STORAGE_PATH, message: error instanceof Refusal && error.code === code ? error.message :
      'scratch/candidates: candidate preview does not match its sealed scene, compose run, or playback files. Rerun rig-create candidate open for the same pending set to rebuild the candidate.' });
  }
}
