import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asArray, isObject, type CheckReport, type Finding } from './check.ts';
import { readFileSync } from './check-reads.ts';
import { literalFile } from './choices.ts';
import { currentFindings, currentHash, isCurrentProject, outputRoot, sha256 } from './current.ts';
import { readWriterBinding } from './job-outbox.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { assertCleanProjectStep, commitToolWrite } from './project-step-commit.ts';
import { refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export function isPublishAdvanceStage(stage: string): stage is 'rig-review' | 'direction-review' {
  return stage === 'rig-review' || stage === 'direction-review';
}

export function acquireAdvanceJobWrite(dir: string, stage: string): () => void {
  return acquireBoundJobWrite(dir, isPublishAdvanceStage(stage) ? undefined : { kind: 'record-only' }, true);
}

/** The bound current-output gate shared by advance and its command preview. */
export function currentAdvanceOutputFinding(
  dir: string,
  project: JsonObject,
  stage: 'rig-review' | 'direction-review',
  checked?: Pick<CheckReport, 'refusals' | 'warnings'>,
): Finding | undefined {
  const kind = stage === 'rig-review' ? 'rig' : 'direction';
  const path = `current.${kind}`;
  const node = isObject(project.current) ? project.current[kind] : undefined;
  if (!isObject(node)) {
    return { code: 'JOB_PUBLICATION_INVALID', path,
      message: `${path}: record the current output with rig-create record ${kind} before advancing to ${stage}` };
  }
  const warnings: Finding[] = [];
  const invalid = checked === undefined
    ? currentFindings(dir, project, warnings)[0]
    : checked.refusals.find(finding => finding.code === 'CURRENT_MALFORMED');
  if (invalid) return invalid;
  const stale = (checked?.warnings ?? warnings).find(finding => finding.code === 'OUTPUT_STALE' && finding.path === path);
  if (stale) return { ...stale, code: 'JOB_PUBLICATION_INVALID' };
  if (isObject(node.adopted)) {
    const drift = asArray(node.files).filter(isObject).find(file => {
      try { return sha256(readFileSync(literalFile(dir, String(file.path)))) !== file.sha256; }
      catch { return true; }
    });
    if (drift) return { code: 'JOB_PUBLICATION_INVALID', path,
      message: `${path}: ${String(drift.path)} is missing or differs from the adopted output; restore the retained file before advancing` };
    return;
  }
  const root = outputRoot(kind);
  if (currentHash(dir, root) !== node.files_sha256) {
    return { code: 'JOB_PUBLICATION_INVALID', path,
      message: `${path}: ${root} is missing or differs from the recorded files_sha256; rebuild and record the current output with rig-create record ${kind}` };
  }
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
  assets: readonly string[] = [],
): string | undefined {
  const stage = String(project.stage);
  const serialized = `${JSON.stringify(project, null, 2)}\n`;
  if (!isPublishAdvanceStage(stage) || !readWriterBinding(dir)) {
    assertCleanProjectStep(dir, ['project.json']);
    assertCleanProjectStep(dir, assets, true);
    const temp = join(dir, `.project.json.advance-${process.pid}-${crypto.randomUUID()}`);
    try {
      defaultWriteRecord(temp, file, Buffer.from(serialized));
    } finally {
      rmSync(temp, { force: true });
    }
    return commitToolWrite(dir, 'advance', ['project.json', ...assets]);
  }
  // Current stage approval happens in owner chat. The advance can leave the existing Review page open.
  if (isCurrentProject(project)) {
    const finding = currentAdvanceOutputFinding(dir, project, stage);
    if (finding) refuse(finding.code, finding.message);
  }
  assertCleanProjectStep(dir, ['project.json']);
  assertCleanProjectStep(dir, assets, true);
  const temp = join(dir, `.project.json.advance-${process.pid}-${Date.now()}`);
  try {
    writeRecord(temp, file, Buffer.from(serialized));
  } finally {
    rmSync(temp, { force: true });
  }
  return commitToolWrite(dir, 'advance', ['project.json', ...assets]);
}
