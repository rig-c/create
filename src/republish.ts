/** Add a publication generation without rebuilding any rig artifact. */
import { closeSync, fchmodSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, checkProject, isObject } from './check.ts';
import { publicationFile, liveManifestPath, originalPaintingReference, prepareLiveManifest, checkPublicationGenerations } from './job-publication.ts';
import { assertRequestedRig } from './job-host.ts';
import { acquireBoundJobWrite, prepareVersionIntent, publishCommittedVersion } from './job-writer.ts';
import { cancelUncommittedIntent, jobHash, type PendingPublication } from './job-outbox.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { refuse } from './refusal.ts';
import type { Finding } from './check.ts';
import type { JsonObject } from './templates.ts';

export function republishCommand(args: string[], now: number): { stdout: string; exit: number } {
  const positional: string[] = []; let reason: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reason' && reason === undefined) reason = args[++i];
    else if (args[i]!.startsWith('-')) refuse('PUBLICATION_GENERATION_INVALID', 'project.json: use republish <rig> [<dir>] --reason <words>');
    else positional.push(args[i]!);
  }
  const n = Number(positional[0]?.replace(/^v/, ''));
  if (!Number.isSafeInteger(n) || n < 1 || positional.length > 2 || !reason?.trim()) refuse('PUBLICATION_GENERATION_INVALID', 'project.json: use republish <rig> [<dir>] --reason <words>');
  const root = realpathSync(positional[1] ?? process.cwd());
  const lock = join(root, '.republish.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch { refuse('PUBLICATION_GENERATION_INVALID', 'project.json: another republish writer holds the lock; wait and retry'); }
  let release = () => {}; let staged = false; let committed = false; let intent: PendingPublication | null = null;
  const path = `review-live-v${n}-g2.json`;
  try {
    release = acquireBoundJobWrite(root);
    const original = publicationFile(root, 'project.json');
    const project = JSON.parse(original.toString('utf8')) as JsonObject;
    assertRequestedRig(root, String(n));
    const version = asArray(project.versions).filter(isObject).find(v => v.n === n)!;
    liveManifestPath(root, project, n);
    if (version.publication_generations !== undefined) refuse('PUBLICATION_GENERATION_DUPLICATE', `versions[v${n}].publication_generations: a publication generation already exists; reopen it with job open --rig ${n}`);
    if (version.kind !== 'post' && (!Array.isArray(project.inputs) || project.inputs.length === 0)) refuse('PUBLICATION_PAINTING_MISSING', `versions[v${n}]: no inputs[0] original painting is declared; register it with input add before republishing`);
    const reference = version.kind === 'post' ? null : originalPaintingReference(root, project, n);
    const legacyPath = `review-live-v${n}.json`;
    const old = publicationFile(root, legacyPath);
    const manifest = JSON.parse(old.toString('utf8')) as JsonObject;
    if (version.kind !== 'post' && Array.isArray(manifest.references) && manifest.references.length) refuse('PUBLICATION_GENERATION_DUPLICATE', `versions[v${n}]: the publication already carries a reference; reopen it with job open --rig ${n}`);
    // Check the exact immutable legacy shape through the original publisher.
    prepareLiveManifest(root, project, n);
    let scene: string | undefined;
    const sources = new Map<string, string>();
    if (version.kind === 'post') {
      const directionPath = `evidence/direction/v${n}.json`;
      const directionBytes = publicationFile(root, directionPath);
      const direction = JSON.parse(directionBytes.toString('utf8')) as JsonObject;
      if (direction.schema !== 'rig-create/direction@2' || !isObject(direction.scene)) refuse('PUBLICATION_GENERATION_INVALID', `${directionPath}: post generation requires direction@2 and its committed scene; retain the existing publication for a scene-less post`);
      if (manifest.scene !== undefined) refuse('PUBLICATION_GENERATION_DUPLICATE', `${legacyPath}: the publication already carries a scene; reopen it with job open --rig ${n}`);
      scene = String(direction.scene.path);
      const sceneBytes = publicationFile(root, scene);
      const doc = JSON.parse(sceneBytes.toString('utf8')) as JsonObject;
      const binding = (version.provenance as JsonObject).direction as JsonObject;
      if (binding.path !== directionPath || binding.sha256 !== jobHash(directionBytes) || direction.scene.sha256 !== jobHash(sceneBytes)) refuse('PUBLICATION_GENERATION_INVALID', `${directionPath}: publication sources changed during republish; restore the frozen direction and scene bytes`);
      sources.set(directionPath, String(binding.sha256));
      sources.set(scene, String(direction.scene.sha256));
      for (const plate of asArray(doc.plates).filter(isObject)) {
        if (jobHash(publicationFile(root, String(plate.path))) !== plate.sha256) refuse('JOB_PUBLICATION_PLATE_CHANGED', `${scene}: ${String(plate.path)} hash moved; restore the retained plate bytes before publishing`);
        sources.set(String(plate.path), String(plate.sha256));
      }
    }
    const before = baselineOf(checkProject(root, project, { now, readOnly: true }));
    const bytes = Buffer.from(`${JSON.stringify({ ...manifest, revision: `v${n}-g2`, ...(scene ? { scene } : { references: [reference] }) }, null, 2)}\n`);
    const next = structuredClone(project);
    const target = asArray(next.versions).filter(isObject).find(v => v.n === n)!;
    target.publication_generations = [{ generation: 2, supersedes: { generation: 1, path: legacyPath, sha256: jobHash(old) },
      manifest: { path, sha256: jobHash(bytes) }, at: new Date(now).toISOString(), reason }];
    try { writeFileSync(join(root, path), bytes, { flag: 'wx' }); staged = true; }
    catch { refuse('PUBLICATION_GENERATION_INVALID', `versions[v${n}]: ${path} already exists or is unwritable; preserve existing generations and restore writable storage`); }
    const findings: Finding[] = [];
    checkPublicationGenerations(root, next, findings);
    findings.push(...newFindings(before, checkProject(root, next, { now, readOnly: true }).refusals));
    if (findings[0]) refuse(findings[0].code, findings[0].message);
    if (!publicationFile(root, 'project.json').equals(original) || !publicationFile(root, legacyPath).equals(old) ||
        (reference !== null && !isDeepStrictEqual(originalPaintingReference(root, project, n), reference)) ||
        [...sources].some(([path, sha256]) => jobHash(publicationFile(root, path)) !== sha256)) refuse('PUBLICATION_GENERATION_INVALID', 'project.json: source changed during republish; freeze the record and publication sources and retry');
    const record = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    intent = prepareVersionIntent(root, record, n);
    fchmodSync(fd, statSync(join(root, 'project.json')).mode);
    writeFileSync(fd, record);
    renameSync(lock, join(root, 'project.json')); committed = true;
    publishCommittedVersion(root, n);
    return { stdout: `republish: ${version.kind === 'post' ? 'post' : 'rig'} v${n} generation 2 recorded (${path})`, exit: 0 };
  } finally {
    closeSync(fd);
    if (!committed) {
      cancelUncommittedIntent(root, intent);
      if (staged) rmSync(join(root, path));
      rmSync(lock, { force: true });
    }
    release();
  }
}
