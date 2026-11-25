import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobHash } from '../src/job-outbox.ts';
import type { JsonObject } from '../src/templates.ts';

/** Plant the bytes and history entry of an already-issued publication. */
export function retainPublicationGeneration(root: string, project: JsonObject, n: number,
  previous: JsonObject, current: JsonObject, at: number) {
  const retain = (path: string, value: JsonObject) => {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    writeFileSync(join(root, path), bytes, { flag: 'wx' });
    return { path, sha256: jobHash(bytes) };
  };
  const supersedes = { generation: 1, ...retain(`review-live-v${n}.json`, previous) };
  const manifest = retain(`review-live-v${n}-g2.json`, current);
  const entry = { generation: 2, supersedes, manifest, at: new Date(at).toISOString(), reason: 'Retain synthetic review evidence.' };
  const version = (project.versions as JsonObject[]).find(value => value.n === n)!;
  version.publication_generations = [entry];
  writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return entry;
}

/** The rig-review checkpoint's historical painting upgrade. */
export function retainRigPublicationGeneration(root: string, project: JsonObject, at: number) {
  const previous = { schema: 'rig-review/1', id: 'create-v1', revision: 'v1', title: 'rig v1',
    model: 'derived/review/v1/out/check/build/skeleton.model.json',
    references: [], animations: [], checkpoints: [], authoring: [] };
  const references = [{ id: 'original-painting', label: 'Original painting', type: 'image', path: 'inputs/painting.png', width: 128, height: 128 }];
  return retainPublicationGeneration(root, project, 1, previous, { ...previous, revision: 'v1-g2', references }, at);
}
