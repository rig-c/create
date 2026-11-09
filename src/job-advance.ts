import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobHash, jobPrivateRoot, readWriterBinding } from './job-outbox.ts';
import { publicationSelector } from './job-publication.ts';
import { acquireBoundJobWrite, prepareVersionIntent, publishCommittedVersion } from './job-writer.ts';
import { refuse } from './refusal.ts';
import { readVersions, type PostVersion, type RigVersion } from './review.ts';
import type { JsonObject } from './templates.ts';

export function isPublishAdvanceStage(stage: string): stage is 'rig-review' | 'direction-review' {
  return stage === 'rig-review' || stage === 'direction-review';
}

export function acquireAdvanceJobWrite(dir: string, stage: string): () => void {
  return isPublishAdvanceStage(stage) ? acquireBoundJobWrite(dir) : () => {};
}

function currentAdvanceVersion(project: JsonObject, stage: 'rig-review' | 'direction-review'): number {
  const versions = readVersions(project);
  if (stage === 'rig-review') {
    const current = versions.rigs.filter(r => r.live).reduce<RigVersion | null>((a, r) => (a === null || r.n > a.n ? r : a), null);
    if (current === null) {
      refuse('JOB_PUBLICATION_INVALID', 'versions: rig-review requires a live rig version to publish; record rig-create rig-version <n> before advancing');
    }
    return current.n;
  }
  const current = versions.posts.filter(p => p.live).reduce<PostVersion | null>((a, p) => (a === null || p.n > a.n ? p : a), null);
  if (current === null) {
    refuse('JOB_PUBLICATION_INVALID', 'versions: direction-review requires a live post version to publish; record rig-create direction write <n> before advancing');
  }
  return current.n;
}

function defaultWriteRecord(temp: string, target: string, bytes: Buffer): void {
  writeFileSync(temp, bytes, { flag: 'wx' });
  renameSync(temp, target);
}

export function commitAdvance(
  dir: string,
  file: string,
  project: JsonObject,
  writeRecord: (temp: string, target: string, bytes: Buffer) => void = defaultWriteRecord,
): void {
  const stage = String(project.stage);
  const serialized = `${JSON.stringify(project, null, 2)}\n`;
  if (!isPublishAdvanceStage(stage) || !readWriterBinding(dir)) {
    writeFileSync(file, serialized);
    return;
  }
  const n = currentAdvanceVersion(project, stage);
  publicationSelector(project, n);
  const recordBytes = Buffer.from(serialized);
  const publicationIntent = prepareVersionIntent(dir, recordBytes, n);
  const temp = join(dir, `.project.json.advance-${process.pid}-${Date.now()}`);
  try {
    writeRecord(temp, file, recordBytes);
  } finally {
    rmSync(temp, { force: true });
    if (publicationIntent && (!existsSync(file) || jobHash(readFileSync(file)) !== publicationIntent.recordHash)) {
      rmSync(join(jobPrivateRoot(dir), 'outbox', `${publicationIntent.id}.json`), { force: true });
    }
  }
  publishCommittedVersion(dir, n);
}
