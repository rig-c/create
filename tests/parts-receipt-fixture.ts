import { reviewStdout } from './review-read-fixture.ts';
import { jobHash } from '../src/job-outbox.ts';
import { draftRigCommand } from '../src/drafts.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
/** Synthetic API stdout for receipt consumers. Review-owned paths are opaque. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { partsReviewCommand } from '../src/parts-review.ts';
import type { JsonObject } from '../src/templates.ts';

export function recordPartsReceipt(root: string, draftId: string, now: number, status = 'approved'): JsonObject {
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  const draft = (project.drafts as JsonObject[]).find(draft => draft.id === draftId)!;
  const response = { schema: 'rig-review-parts-verdict/2', status,
    tool: { name: '@rig-c/review', version: '0.0.0-synthetic' },
    source: { sha256: 'a'.repeat(64), files: ((draft.parts as JsonObject).files as JsonObject[]).map(file => ({ sha256: file.sha256 })) },
    parts: { synthetic: { outcome: status === 'approved' ? 'clean' : status === 'pending' ? 'pending' : 'flagged', note: '' } } };
  const result = partsReviewCommand([root, '--draft', draftId, '--from-review-cli', '--by', 'user', '--json', '--', 'synthetic-review'], now,
    { runCli: reviewStdout(JSON.stringify(response)) });
  return JSON.parse(result.stdout) as JsonObject;
}

/** Supply a labelled synthetic draft when an older writer test starts without one. */
export function preparePartsApproval(root: string, now: number, partsDir = 'derived/parts/rig'): string[] {
  const id = 'receipt-fixture';
  const draftRoot = `derived/drafts/${id}`;
  const put = (path: string, bytes: Buffer | string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  put(`${draftRoot}/config.json`, '{}');
  const manifest = JSON.parse(readFileSync(join(root, partsDir, 'parts.json'), 'utf8')) as { parts: { name: string }[] };
  for (const path of ['parts.json', ...manifest.parts.map(part => `parts/${part.name}.png`)]) {
    put(`${draftRoot}/input/rig/${path}`, readFileSync(join(root, partsDir, path)));
  }
  for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) put(`${draftRoot}/out/${name}`, '{}');
  const direct = join(root, partsDir, 'recomposite_rig.png');
  const stack = existsSync(direct) ? direct : join(root, 'derived/parts/rig/recomposite_rig.png');
  if (existsSync(stack)) put(`${draftRoot}/input/rig/recomposite_rig.png`, readFileSync(stack));
  draftRigCommand([id, root, '--config', `${draftRoot}/config.json`, '--parts', `${draftRoot}/input/rig`, '--from', `${draftRoot}/out`], now);
  const receipt = recordPartsReceipt(root, id, now);
  const snapshot = `evidence/${id}-structure.json`;
  structureSnapshotCommand([root, '--draft', id, '--out', snapshot]);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  const bytes = readFileSync(join(root, snapshot));
  for (const signoff of project.signoffs as JsonObject[]) {
    if (signoff.stage !== 'parts-review') continue;
    signoff.draft_id = id;
    signoff.evidence = { ...(receipt.evidence as JsonObject), spec: 'rig-create/parts-verdict-cli@1' };
    signoff.structure = { path: snapshot, sha256: jobHash(bytes) };
  }
  writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return ['--draft', id, '--structure-file', snapshot];
}
