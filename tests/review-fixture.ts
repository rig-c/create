import { reviewPackageHash } from '../src/signoff-target.ts';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { asArray, isObject } from '../src/check.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import { latestPartsApproval } from '../src/structure.ts';
import type { JsonObject } from '../src/templates.ts';

/** Keep unrelated legacy tests on a consistent synthetic build, with raw controls opting out. */
export function alignLegacyBuilds(project: JsonObject, files: Record<string, string | Uint8Array>): void {
  const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  for (const version of asArray(project.versions).filter(isObject)) {
    const pkg = version.review_package;
    const provenance = version.provenance;
    if (version.kind !== 'rig' || !isObject(pkg) || !isObject(pkg.config)) continue;
    if (isObject(provenance) && isObject(provenance.config)) {
      const config = provenance.config;
      const bytes = files[String(config.path)];
      if (bytes !== undefined && hash(bytes) === config.sha256) {
        pkg.config.sha256 = hash(bytes);
        files[String(pkg.config.path)] = bytes;
        files[`derived/review/v${String(version.n)}/config.json`] = bytes;
        const entry = asArray(pkg.files).find(f => isObject(f) && f.path === 'config.json');
        if (isObject(entry)) entry.sha256 = hash(bytes);
      } else if (bytes === undefined) config.sha256 = pkg.config.sha256;
    }
    const approval = latestPartsApproval(project, Date.parse(String(version.at)));
    // A signature-writer test may remove the approval before recording it again.
    const evidence = approval?.evidence ?? { path: 'evidence/parts-review.json' };
    if (!isObject(evidence) || typeof evidence.path !== 'string' || files[evidence.path] === undefined) continue;
    let verdict: JsonObject;
    try { verdict = JSON.parse(Buffer.from(files[evidence.path]!).toString()) as JsonObject; } catch { continue; }
    const source = isObject(verdict.source) ? verdict.source : {};
    const manifest = asArray(source.files).find(isObject);
    if (!manifest || typeof manifest.path !== 'string') continue;
    const path = posix.normalize(posix.join(posix.dirname(evidence.path), manifest.path));
    const manifestBytes = files[path];
    if (manifestBytes === undefined || hash(manifestBytes) !== manifest.sha256) continue;
    const entry = asArray(pkg.files).find(f => isObject(f) && f.path === 'out/parts.json');
    if (isObject(entry)) {
      entry.sha256 = hash(manifestBytes);
      files[`derived/review/v${String(version.n)}/out/parts.json`] = manifestBytes;
      files[`${String(pkg.from)}/parts.json`] = manifestBytes;
    }
  }
  refreshFixtureTargets(project);
}

/** Synthetic producer bytes shipped with the filled example, relative to a review package. */
export function exampleReviewBytes(): Record<string, string> {
  const root = join(import.meta.dir, '..', 'templates', 'example-review');
  const files: Record<string, string> = {};
  const read = (path: string): void => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) read(child);
      else files[child] = readFileSync(join(root, child), 'utf8');
    }
  };
  read('');
  return files;
}

/** Materialize both declared frozen sources and their package copies for the two example rigs. */
export function reviewExampleFiles(): Record<string, string> {
  const bytes = exampleReviewBytes();
  const files: Record<string, string> = {};
  for (const n of [1, 2]) {
    for (const [path, content] of Object.entries(bytes)) {
      files[`derived/review/v${n}/${path}`] = content;
      files[path === 'config.json' ? `evidence/v${n}/review-config.json` : `outputs/v${n}/${path}`] = content;
    }
  }
  return files;
}

/** Rebuild a newly materialized synthetic package after a test replaces its config. */
export function repackageFixtureVersion(dir: string, n: number): string {
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const version = asArray(project.versions).find(v => isObject(v) && v.n === n);
  if (!isObject(version) || !isObject(version.provenance) || !isObject(version.provenance.config) || !isObject(version.review_package)) throw new Error('expected a synthetic rig fixture with config provenance');
  if (version.pre_interview === true) return dir;
  const config = version.provenance.config;
  const bytes = readFileSync(join(dir, String(config.path)));
  // Config-drift controls deliberately retain their mismatched historical binding.
  if (createHash('sha256').update(bytes).digest('hex') !== config.sha256) return dir;
  rmSync(join(dir, `derived/review/v${n}`), { recursive: true });
  reviewPackageCommand([String(n), dir, '--config', String(config.path), '--from', String(version.review_package.from)]);
  const signed = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  refreshFixtureTargets(signed);
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(signed, null, 2)}\n`);
  return dir;
}

/** Setup-only package regeneration precedes the synthetic signature's freeze. */
function refreshFixtureTargets(project: JsonObject): void {
  for (const signoff of asArray(project.signoffs).filter(isObject)) {
    const target = signoff.target;
    if (signoff.stage !== 'rig-review' || !isObject(target) || !isObject(target.review_package)) continue;
    const version = asArray(project.versions).find(v => isObject(v) && v.n === target.version);
    if (isObject(version) && isObject(version.review_package)) target.review_package.sha256 = reviewPackageHash(version.review_package);
  }
}
