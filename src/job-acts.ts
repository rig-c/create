/** Writer routing for finalized acts. No event transport or automatic ingestion. */
import type { ActV3 } from '@rig-c/review/job-host';
import { asArray, isObject, type Finding } from './check.ts';
import { existsSync, readFileSync } from './check-reads.ts';
import { join } from 'node:path';
import { recordedPartsVerdict } from './parts-verdict-record.ts';
import { stageOfStep } from './stages.ts';
import { checkStructure } from './structure.ts';
import { createHash } from 'node:crypto';
import type { JsonObject } from './templates.ts';

export interface PendingJobAct {
  actId: string;
  kind: ActV3['kind'];
  subject: string;
  at: string;
  args: string[] | null;
  command: string | null;
  preconditions?: { command: string | null; act: string }[];
  unavailable?: { code: 'JOB_ACTS_WRITER_UNAVAILABLE'; message: string };
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** A retained snapshot is reusable only for this exact draft and config.
 * Never overwrite unrelated or invalid bytes: choose the next retained name.
 */
export function partsStructureSnapshot(root: string, project: JsonObject, draft: string): { path: string; valid: boolean } {
  const stem = `evidence/structure-${encodeURIComponent(draft)}`;
  for (let suffix = 0; ; suffix++) {
    const path = `${stem}${suffix === 0 ? '' : `-${suffix}`}.json`;
    if (!existsSync(join(root, path))) return { path, valid: false };
    try {
      const bytes = readFileSync(join(root, path));
      const errors: Finding[] = [];
      const signoff = { draft_id: draft, structure: { path, sha256: createHash('sha256').update(bytes).digest('hex') } };
      if (checkStructure(root, project, signoff, path, errors) !== null && errors.length === 0) return { path, valid: true };
    } catch { /* Preserve the existing bytes and select another output path. */ }
  }
}

export function pendingJobActs(project: JsonObject, acts: readonly ActV3[], root: string): PendingJobAct[] {
  const ingested = new Set(asArray(project.review_acts).filter(isObject).map(row => JSON.stringify([row.jobId, row.actId])));
  const signoffs = asArray(project.signoffs).filter(isObject);
  const seen = new Set<string>();
  return acts.flatMap(act => {
    const key = JSON.stringify([act.jobId, act.actId]);
    if (seen.has(key) || ingested.has(key) || signoffs.some(row => row.source === `review act ${act.jobId}/${act.actId}`)) return [];
    seen.add(key);
    let subject: string = act.kind;
    let args: string[] | null = null;
    const preconditions: { command: string | null; act: string }[] = [];
    switch (act.kind) {
      case 'review-verdict': {
        const selector = act.source.selector;
        subject = act.value.stage;
        if (selector && (selector.kind === 'rig' || selector.kind === 'post')
          && act.value.stage === (selector.kind === 'rig' ? 'rig-review' : 'direction-review')) {
          subject = `${selector.kind} v${selector.version} / ${act.value.stage}`;
          args = ['review', String(selector.version), root];
        }
        break;
      }
      case 'parts-verdict': {
        const selector = act.source.selector;
        if (selector?.kind === 'draft') {
          subject = `draft ${selector.id}`;
          args = ['parts-review', root];
        }
        break;
      }
      case 'interview-picks':
        subject = `question ${act.value.questionId}`;
        args = ['interview-answer', act.value.questionId, root];
        break;
      case 'signoff': {
        subject = `stage ${act.value.stage}`;
        args = ['signoff', act.value.stage, root];
        if (act.value.stage === 'parts-review') {
          const selector = act.source.selector;
          // Select only the draft shown by Review, never the latest draft by guess.
          if (selector?.kind !== 'draft') { args = null; break; }
          const draft = selector.id;
          const structure = partsStructureSnapshot(root, project, draft);
          let approved = false;
          try { recordedPartsVerdict(root, project, draft); approved = true; } catch { /* Ordered prerequisite below. */ }
          if (!approved) preconditions.push({ command: null, act: `ingest the approved parts-verdict for draft ${draft} before structure-snapshot; use its job acts writer command` });
          if (!structure.valid) preconditions.push({
            command: ['rig-create', 'structure-snapshot', root, '--draft', draft, '--out', structure.path].map(shellWord).join(' '),
            act: 'after ingesting the approved parts-verdict, retain the structure snapshot before signoff',
          });
          args.push('--draft', draft, '--structure-file', structure.path);
        }
        break;
      }
      case 'checkpoint': {
        const step = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject).find(step => step.id === act.value.planStepId);
        subject = `checkpoint ${act.value.planStepId}`;
        if (step && (step.phase === 'rig' || step.phase === 'post')) {
          const stage = stageOfStep(step.phase, String(step.id));
          subject += ` / ${stage}`;
          args = ['signoff', stage, root, '--checkpoint', act.value.planStepId];
        }
        break;
      }
    }
    if (args) args.push('--from-review', act.actId);
    return [{ actId: act.actId, kind: act.kind, subject, at: act.at, args,
      ...(preconditions.length ? { preconditions } : {}),
      command: args ? ['rig-create', ...args].map(shellWord).join(' ') : null,
      ...(args ? {} : { unavailable: { code: 'JOB_ACTS_WRITER_UNAVAILABLE' as const,
        message: `project.json: act ${act.actId} (${subject}) has no current writer target; restore its plan step or use a supported Review subject before ingestion` } }) }];
  });
}

export function jobActsText(result: { acts: readonly PendingJobAct[] }): string {
  if (!result.acts.length) return 'job: no finalized acts awaiting ingestion';
  return result.acts.map(act => `${act.actId} ${act.kind} ${act.subject} at ${act.at}\n${(act.preconditions ?? []).map(step => `  first: ${step.command ?? step.act}\n`).join('')}  ${act.command ?? `${act.unavailable!.code}: ${act.unavailable!.message}`}`).join('\n');
}
