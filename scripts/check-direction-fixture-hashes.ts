/** Recompute every recorded file digest, including the patch's two scalar bindings. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Producer run stamps record their entries relative to the directory that holds the stamp (core runStampPath, parts relativeToOutRoot).
const RUN_STAMP_SPECS = new Set(['rigc-run/1', 'rig-run/1']);

export function checkDirectionFixtureHashes(root: string): number {
  let count = 0;
  const digest = (path: string, expected: unknown, at: string): void => {
    const actual = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    if (actual !== expected) throw Error(`${at}: hash mismatch for ${path}`);
    count++;
  };
  const visit = (value: unknown, at: string, source: string, stampDir: string | null): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {value.forEach((v, i) => visit(v, `${at}[${i}]`, source, stampDir)); return;}
    const o = value as Record<string, unknown>;
    const consumed = new Set<string>();
    if (typeof o.path === 'string' && typeof o.sha256 === 'string') {
      let path: string;
      if (stampDir !== null) {
        path = join(stampDir, o.path);
        if (path === '..' || path.startsWith('../')) throw Error(`${at}: ${o.path} escapes the fixture`);
      } else {
        // review_package.files paths are relative to the frozen package, unlike project bindings.
        path = o.path.startsWith('out/') ? `derived/review/v1/${o.path}` : o.path;
      }
      digest(path, o.sha256, at);
      consumed.add('sha256');
    }
    if ('rig_model_sha256' in o) {
      digest('derived/review/v1/out/check/build/skeleton.model.json', o.rig_model_sha256, at);
      consumed.add('rig_model_sha256');
    }
    if ('direction_sha256' in o) {
      digest(`evidence/direction/v${o.source_post}.json`, o.direction_sha256, at);
      consumed.add('direction_sha256');
    }
    if (basename(source) === 'skeleton.model.json' && at === `${source}.spine` && 'sha256' in o) {
      digest(join(dirname(source), 'skeleton.json'), o.sha256, `${at}.sha256`);
      consumed.add('sha256');
    }
    for (const [key, v] of Object.entries(o)) {
      if (/sha256$/.test(key) && !consumed.has(key)) throw Error(`UNCONSUMED_SHA256: ${at}.${key}`);
      visit(v, `${at}.${key}`, source, stampDir);
    }
  };
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(root, dir), {withFileTypes: true})) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name.endsWith('.json')) {
        const value: unknown = JSON.parse(readFileSync(join(root, path), 'utf8'));
        const stamp = !!value && typeof value === 'object' && RUN_STAMP_SPECS.has(String((value as Record<string, unknown>).spec));
        visit(value, path, path, stamp ? dirname(path) : null);
      }
    }
  };
  walk('');
  if (!count) throw Error('no recorded hashes');
  return count;
}
if (import.meta.main) console.log(`${checkDirectionFixtureHashes(resolve(process.argv[2] ?? join(import.meta.dir, '../templates/example-direction')))} recorded hashes match`);
