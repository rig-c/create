/** Writer routing for finalized acts. No event transport or automatic ingestion. */
import type { ActV3 } from '@rig-c/review/job-host';
import { asArray, isObject } from './check.ts';
import { stageOfStep } from './stages.ts';
import type { JsonObject } from './templates.ts';

export interface PendingJobAct {
  actId: string;
  kind: ActV3['kind'];
  subject: string;
  at: string;
  args: string[] | null;
  command: string | null;
  unavailable?: { code: 'JOB_ACTS_WRITER_UNAVAILABLE'; message: string };
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
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
      case 'signoff':
        subject = `stage ${act.value.stage}`;
        args = ['signoff', act.value.stage, root];
        break;
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
      command: args ? ['rig-create', ...args].map(shellWord).join(' ') : null,
      ...(args ? {} : { unavailable: { code: 'JOB_ACTS_WRITER_UNAVAILABLE' as const,
        message: `project.json: act ${act.actId} (${subject}) has no current writer target; restore its plan step or use a supported Review subject before ingestion` } }) }];
  });
}

export function jobActsText(result: { acts: readonly PendingJobAct[] }): string {
  if (!result.acts.length) return 'job: no finalized acts awaiting ingestion';
  return result.acts.map(act => `${act.actId} ${act.kind} ${act.subject} at ${act.at}\n  ${act.command ?? `${act.unavailable!.code}: ${act.unavailable!.message}`}`).join('\n');
}
