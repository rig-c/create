import { reviewPackageHash } from '../src/signoff-target.ts';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { asArray, isObject } from '../src/check.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import { latestPartsApproval } from '../src/structure.ts';
import type { JsonObject } from '../src/templates.ts';

const legacyPartPackages = new Map<string, { records: JsonObject[]; files: Record<string, Uint8Array> }>();

/** Establish legacy test packages from the approved bytes before the test's mutation. */
export function materializeLegacyPartPackages(dir: string, project: JsonObject, files: Record<string, string | Uint8Array>): void {
  alignLegacyBuilds(project, files);
  const rigs = asArray(project.versions).filter(isObject).filter(v => v.kind === 'rig' && v.pre_interview !== true && isObject(v.review_package));
  for (const version of rigs) {
    const pkg = version.review_package as JsonObject;
    const approval = latestPartsApproval(project, Date.parse(String(version.at)));
    const evidence = approval?.evidence ?? { path: 'evidence/parts-review.json' };
    if (!isObject(evidence) || typeof evidence.path !== 'string' || files[evidence.path] === undefined) continue;
    const verdict = JSON.parse(Buffer.from(files[evidence.path]!).toString()) as JsonObject;
    const source = isObject(verdict.source) ? verdict.source : {};
    const entries = asArray(source.files).filter(isObject);
    const manifest = entries.find(f => typeof f.path === 'string' && posix.basename(f.path) === 'parts.json');
    if (!manifest || typeof manifest.path !== 'string') continue;
    for (const entry of entries) {
      if (typeof entry.path !== 'string') continue;
      const sourcePath = posix.normalize(posix.join(posix.dirname(evidence.path), entry.path));
      const bytes = files[sourcePath];
      if (bytes === undefined) throw new Error(`missing synthetic approved source ${sourcePath}`);
      const path = posix.join(String(pkg.from), posix.relative(posix.dirname(manifest.path), entry.path));
      files[path] = bytes;
    }
  }
  // Reuse only writer-produced packages with identical original records and file bytes.
  const key = createHash('sha256').update(JSON.stringify(project)).update(JSON.stringify(Object.entries(files)
    .map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')]))).digest('hex');
  const cached = legacyPartPackages.get(key);
  if (cached) {
    rigs.forEach((version, index) => { version.review_package = structuredClone(cached.records[index]!); });
    Object.assign(files, cached.files);
    refreshFixtureTargets(project);
    return;
  }
  for (const [path, bytes] of Object.entries(files)) {
    if (/^derived\/review\/v\d+\//.test(path)) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  const generated: Record<string, Uint8Array> = {};
  const records: JsonObject[] = [];
  for (const version of rigs) {
    const pkg = version.review_package as JsonObject;
    const config = pkg.config as JsonObject;
    const record = JSON.parse(reviewPackageCommand([String(version.n), dir, '--config', String(config.path), '--from', String(pkg.from), '--json']).stdout) as JsonObject;
    version.review_package = record;
    records.push(structuredClone(record));
    for (const entry of asArray(record.files).filter(isObject)) {
      const path = `derived/review/v${String(version.n)}/${String(entry.path)}`;
      generated[path] = readFileSync(join(dir, path));
    }
  }
  Object.assign(files, generated);
  legacyPartPackages.set(key, { records, files: generated });
  refreshFixtureTargets(project);
}

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
