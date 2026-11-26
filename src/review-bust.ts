import type { JobPublishedChestLandmark } from '@rig-c/review/job-host';
import { lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { join } from 'node:path';
import { shellWord } from './job-acts.ts';
import { jobHash } from './job-outbox.ts';
import { isPublicationPath, publicationFile, publicationFilePath, publishedSourcePainting } from './job-publication.ts';
import { Refusal, refuse } from './refusal.ts';
import { asArray, isObject } from './check.ts';
import type { JsonObject } from './templates.ts';
import type { ChestReviewVerdictAct } from './review-act.ts';

export type BustWorkingConfig = { path: string; sha256: string };

export function frozenBustConfigHash(version: JsonObject): string | undefined {
  const registration = version.registration;
  const binding = isObject(registration) ? registration.config_source : undefined;
  return isObject(binding) && typeof binding.sha256 === 'string' ? binding.sha256 : undefined;
}

/** A numbered rig can still be live after that exact output has been adopted. */
export function currentUsesBustVersion(project: JsonObject, version: number): boolean {
  const rig = isObject(project.current) ? project.current.rig : undefined;
  return rig === undefined || isObject(rig) && isObject(rig.adopted) && rig.adopted.version === version;
}

export function bustConfigPath(path: unknown): path is string {
  return typeof path === 'string' && isPublicationPath(path)
    && !/^(?:evidence|derived|project\.json|\.rig-create-review|\.input\.lock)(?:\/|$)/i.test(path);
}

function bustConfigFile(root: string, path: string): string {
  const unsafe = () => refuse('JOB_PUBLICATION_INVALID',
    `project.json.review_acts: --config ${JSON.stringify(path)} must name a project-relative working file outside evidence/, derived/ and outputs/ with no symlinks or hardlinks; choose an independent working copy`);
  // Keep the receipt path syntax accepted by the ledger for earlier acts.
  if (!bustConfigPath(path) || /^outputs(?:\/|$)/i.test(path)) return unsafe();
  let absolute: string;
  try { absolute = publicationFilePath(root, path); }
  catch (error) {
    if (error instanceof Refusal && error.code === 'JOB_PUBLICATION_INVALID') return unsafe();
    throw error;
  }
  if (lstatSync(absolute).nlink !== 1) return unsafe();
  return absolute;
}

export function prepareBustConfig(
  root: string, version: JsonObject, act: {
    source: { selector: { version: number } };
    value: Pick<ChestReviewVerdictAct['value'], 'chestLandmarks'>;
  }, path: string,
  seeds: readonly JobPublishedChestLandmark[],
): BustWorkingConfig {
  const at = `versions[v${act.source.selector.version}]`;
  const retained = isObject(version.review_package) ? version.review_package : null;
  const config = asArray(retained?.files).filter(isObject).filter(row => row.path === 'config.json');
  const configHash = config.length === 1 ? config[0]?.sha256 : undefined;
  if (typeof configHash !== 'string' || !/^[a-f0-9]{64}$/.test(configHash)
    || act.value.chestLandmarks.some(({ edit }) => {
      const seed = seeds.find(row => row.skin === edit.skin && row.slot === edit.slot && row.attachment === edit.attachment);
      return seed?.source.configHash !== configHash;
    })) {
    refuse('REVIEW_ACT_BUST_CONFIG_STALE',
      `${at}.review_package.files: the act's original Review publication has missing or mismatched chest seeds for the recorded config.json SHA-256; publish the current rig and request a new edit`);
  }
  const sha256 = jobHash(readFileSync(bustConfigFile(root, path)));
  if (sha256 !== frozenBustConfigHash(version)) {
    refuse('REVIEW_ACT_BUST_SOURCE_CHANGED',
      `${at}.registration.config_source: --config ${JSON.stringify(path)} differs from the registered source SHA-256; restore the matching working config or rebuild and register a new version`);
  }
  return { path, sha256 };
}

export function retainedRigActPath(version: number, sha256: string): string {
  return `evidence/v${version}/${sha256}.act.json`;
}

export function bustLandmarkCommands(
  root: string, project: JsonObject, version: JsonObject, config: string, sha256: string, retained = false,
): [string, string] {
  root = realpathSync(root);
  const n = Number(version.n);
  const at = `versions[v${n}].review_package.from`;
  const parts = isObject(version.review_package) ? version.review_package.from : undefined;
  if (typeof parts !== 'string') refuse('JOB_PUBLICATION_INVALID', `${at}: restore the recorded parts directory before applying the chest edit`);
  publicationFilePath(root, `${parts}/parts.json`);
  bustConfigFile(root, config);
  const source = publishedSourcePainting(root, project, `versions[v${n}]`).path;
  const act = retainedRigActPath(n, sha256);
  if (retained && jobHash(publicationFile(root, act)) !== sha256) {
    refuse('REVIEW_ACT_LEDGER_INVALID', `${act}: retained chest act bytes differ from the recorded SHA-256; restore the original act file`);
  }
  const base = `evidence/v${n}/${sha256}`;
  const landmarks = `${base}.bust-landmarks.json`;
  const proposal = `${base}.bust-proposal`;
  const partsPath = parts.toLowerCase();
  if ([act, landmarks, proposal].some(path => path.toLowerCase() === partsPath || path.toLowerCase().startsWith(`${partsPath}/`))
    || partsPath.startsWith(`${proposal}/`)) {
    refuse('JOB_PUBLICATION_INVALID', `${at}: keep the Parts directory separate from the chest edit evidence and proposal output`);
  }
  for (const [path, directory] of [
    ['evidence', true], [`evidence/v${n}`, true], [act, false],
    [landmarks, false], [`${landmarks}.provenance.json`, false], [proposal, true],
  ] as const) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat && (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      refuse('JOB_PUBLICATION_INVALID', `${path}: restore a regular project evidence destination with no links before applying the chest edit`);
    }
  }
  const word = (path: string) => shellWord(path.startsWith('-') ? `./${path}` : path);
  return [
    `rig-parts bust-landmarks --from-act ${word(act)} --parts ${word(parts)} --config ${word(config)} --out ${word(landmarks)} --write-config`,
    `rig-parts propose --parts ${word(parts)} --source ${word(source)} --out ${word(proposal)} --write-config ${word(config)} --bust-landmarks ${word(landmarks)}`,
  ];
}
