/** `signoff --checkpoint <id> --from-review <actId>`: a passed Review checkpoint act becomes the checkpoint sign-off. */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { asArray, isObject } from './check.ts';
import { jobHash } from './job-outbox.ts';
import { refuse } from './refusal.ts';
import { assertActSubjectDeclared, checkpointActSignoff, decodeReviewAct, reviewActFindings, reviewActTransport, type CheckpointAct, type ReviewActTransport } from './review-act.ts';
import { stepHash } from './step-hash.ts';
import type { JsonObject } from './templates.ts';

export interface SignoffHooks {
  /** Tests inject the job API response; the command otherwise fetches through the private runtime. */
  fetch?: (transport: ReviewActTransport) => { bytes: string };
}

export interface CheckpointIngest {
  act: CheckpointAct;
  bytes: string;
  by: string;
  at: string;
  verbatim: string;
  source: string;
  /** The sign-off this act already recorded: the command replays it and writes nothing. */
  replay?: JsonObject;
}

function fetchBytes(transport: ReviewActTransport, hooks: SignoffHooks): string {
  if (hooks.fetch) return hooks.fetch(transport).bytes;
  const child = Bun.spawnSync([process.execPath, fileURLToPath(new URL('./review-act-runtime.ts', import.meta.url))], {
    stdin: Buffer.from(JSON.stringify(transport)), stdout: 'pipe', stderr: 'pipe',
  });
  let response: { ok: boolean; bytes: string; code: string; message: string };
  try { response = JSON.parse(child.stdout.toString()); }
  catch { return refuse('REVIEW_ACT_FETCH_REFUSED', 'project.json.review_acts: fetch adapter failed; restore the live Review job'); }
  if (!response.ok || child.exitCode) refuse(response.code, response.message);
  return response.bytes;
}

/** Fetches, decodes and binds the act to the `--checkpoint` step the command already accepted. */
export function ingestCheckpointAct(dir: string, project: JsonObject, actId: string, checkpointId: string, now: number, hooks: SignoffHooks): CheckpointIngest {
  const invalid = reviewActFindings(project)[0];
  if (invalid) refuse(invalid.code, invalid.message);
  const transport: ReviewActTransport = { ...reviewActTransport(dir, actId), kind: 'checkpoint' };
  const bytes = fetchBytes(transport, hooks);
  const act = decodeReviewAct(bytes, 'checkpoint');
  if (act.jobId !== transport.jobId || act.actId !== transport.actId || Date.parse(act.at) > now) {
    refuse('REVIEW_ACT_INVALID', `signoffs.checkpoint ${checkpointId}: fetched act identity or date differs from the request; fetch the checkpoint act again`);
  }
  if (act.value.planStepId !== checkpointId || act.value.checkpointId !== act.value.planStepId) {
    refuse('REVIEW_ACT_CHECKPOINT_MISMATCH', `signoffs.checkpoint ${checkpointId}: act ${act.jobId}/${act.actId} names checkpoint ${act.value.checkpointId} on plan step ${act.value.planStepId}; sign the checkpoint the act names, or ask Review for checkpoint ${checkpointId}`);
  }
  assertActSubjectDeclared(dir, act, `signoffs.checkpoint ${checkpointId}`);
  const fields = { act, bytes, ...checkpointActSignoff(act) };
  const existing = asArray(project.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === act.actId);
  if (existing) {
    if (existing.bytes !== bytes) refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: immutable checkpoint act changed; restore the original receipt');
    const signoff = asArray(project.signoffs)[Number(existing.signoff)];
    if (existing.kind !== 'checkpoint' || !isObject(signoff)) refuse('REVIEW_ACT_LEDGER_INVALID', 'project.json.review_acts: checkpoint receipt has no recorded sign-off; restore the original receipt and sign-off together');
    return { ...fields, replay: signoff };
  }
  if (act.value.outcome !== 'pass') {
    refuse('REVIEW_ACT_CHECKPOINT_FAILED', `signoffs.checkpoint ${checkpointId}: the person failed this checkpoint in Review (act ${act.jobId}/${act.actId}); a failed checkpoint is feedback, not a sign-off, so fix the step from its words and ask for the checkpoint again`);
  }
  const plan = isObject(project.plan) ? project.plan : null;
  const current = asArray(plan?.steps).map(raw => ({ id: isObject(raw) ? raw.id : null, hash: isObject(raw) ? stepHash(raw) : null }));
  if (!isDeepStrictEqual(act.source.plan.steps, current)) {
    refuse('REVIEW_ACT_SOURCE_STALE', `signoffs.checkpoint ${checkpointId}: displayed plan step identities changed since act ${act.jobId}/${act.actId}; ask for the checkpoint again on the current plan`);
  }
  return fields;
}

export function checkpointReceipt(ingest: CheckpointIngest, signoff: number): JsonObject {
  const displayed = ingest.act.source.plan.steps.find(step => step.id === ingest.act.value.planStepId)!;
  return { schema: 'rig-create/review-act@1', kind: 'checkpoint', jobId: ingest.act.jobId, actId: ingest.act.actId,
    checkpoint: ingest.act.value.planStepId, signoff, bytes: ingest.bytes, sha256: jobHash(ingest.bytes), version_hash: displayed.hash };
}

/** Writes only if the record is the one the fetch was validated against, through an exclusive temporary file. */
export function commitIngestedSignoff(file: string, original: Buffer, project: JsonObject): void {
  if (!readFileSync(file).equals(original)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during checkpoint fetch; retry against the current live job');
  const temporary = join(dirname(file), `.rig-create-review-act-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(project, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
}
