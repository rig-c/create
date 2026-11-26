import { closeSync, mkdirSync, openSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync, lstatSync } from './check-reads.ts';
import { sceneBytes, sceneFail } from './scene.ts';
import type { JsonObject } from './templates.ts';

/** Serialize with the legacy writers, then publish the spec in one rename after validating its inputs. */
export function writeDirectionSpec(
  dir: string, path: string, code: string, prepare: (snapshots: Map<string, Buffer>) => JsonObject, beforeCommit?: () => void,
): void {
  const lock = join(dir, '.direction.lock');
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx'); }
  catch { return sceneFail(code, path, 'another scene or direction writer holds the lock; retry after it finishes'); }
  const snapshots = new Map<string, Buffer>();
  const created: string[] = [];
  let staged: string | undefined;
  try {
    const doc = prepare(snapshots);
    const [first, second] = path.split('/');
    for (const parent of [first!, `${first}/${second}`]) {
      const absolute = join(dir, parent);
      if (existsSync(absolute)) {
        if (!lstatSync(absolute).isDirectory()) sceneFail(code, path, `${parent} must be a real directory`);
      } else { mkdirSync(absolute); created.push(absolute); }
    }
    const target = join(dir, path);
    const prior = existsSync(target) ? sceneBytes(dir, path, code) : undefined;
    staged = `${target}.${crypto.randomUUID()}.tmp`;
    writeFileSync(staged, `${JSON.stringify(doc, null, 2)}\n`, { flag: 'wx' });
    beforeCommit?.();
    for (const [source, bytes] of snapshots) {
      if (!sceneBytes(dir, source, code).equals(bytes)) sceneFail(code, source, 'source changed before publishing the spec; retry with the current inputs');
    }
    if (prior ? !sceneBytes(dir, path, code).equals(prior) : existsSync(target)) sceneFail(code, path, 'destination changed while validating; retry with the current spec');
    renameSync(staged, target);
    staged = undefined;
  } finally {
    if (staged) rmSync(staged, { force: true });
    for (const path of created.reverse()) { try { rmdirSync(path); } catch { /* Keep directories with a published spec. */ } }
    closeSync(descriptor);
    rmSync(lock);
  }
}
