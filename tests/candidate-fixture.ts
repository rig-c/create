import { createHash } from 'node:crypto';
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';

export const CANDIDATE_QUESTION = 'post_composition';
export const CANDIDATE_SET = 'current-post-composition';
export const CANDIDATE_SET_PATH = 'evidence/interview/post_composition.json';
export const CANDIDATE_NOW = EXAMPLE_NOW;

export function literalDigest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function candidateFixture() {
  const root = join(realpathSync(tempDir()), 'synthetic-project');
  cpSync(join(import.meta.dir, '../templates/example-current'), root, { recursive: true });
  const read = (path: string): JsonObject => JSON.parse(readFileSync(join(root, path), 'utf8')) as JsonObject;
  const project = read('project.json');
  const set = read(CANDIDATE_SET_PATH);
  const item = arr(obj(obj(project.interview).post).items).map(obj).find(row => row.id === CANDIDATE_QUESTION)!;
  const options = arr(obj(arr(set.asks)[0]).options).map(obj);
  const stage = 'post-interview';
  const stageOrder = stageIndex(stage);
  project.stage = stage;
  project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageOrder);
  project.signoffs = arr(project.signoffs).filter(row => stageIndex(String(obj(row).stage)) < stageOrder);
  const plan = obj(project.plan);
  plan.steps = arr(plan.steps).filter(row => obj(row).phase !== 'post');
  delete obj(project.current).direction;
  item.guide = null;
  const write = (path: string, json: JsonObject) => {
    const bytes = `${JSON.stringify(json, null, 2)}\n`;
    writeFileSync(join(root, path), bytes);
    return { path, sha256: literalDigest(bytes) };
  };
  const save = () => {
    const binding = write(CANDIDATE_SET_PATH, set);
    item.pending_options = binding;
    write('project.json', project);
    return binding;
  };
  return { root, project, options, read, write, save };
}
