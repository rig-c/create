import { asArray, collectItems, isObject, loadCollection } from './check.ts';
import { jobHash } from './job-outbox.ts';
import { decodeReviewAct, reviewActFindings } from './review-act.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { approvalStageOfStep, hasStageOrder, interviewStageOfGuide, PICK_SIGNOFF_STAGES } from './stages.ts';
import type { JsonObject } from './templates.ts';


export function requiredInterviewSteps(stage: string): string[] {
  return stage === 'rigging-interview' ? ['bones', 'meshes', 'constraints', 'motion'] : ['seethrough', 'assemble'];
}

export function missingPickSignoffSteps(project: JsonObject, stage: string): string[] {
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  return requiredInterviewSteps(stage).filter(id => !steps.some(step => step.phase === 'rig' && step.id === id));
}

export function pickSignoffEvidence(dir: string, project: JsonObject, stage: string, now: number) {
  if (!PICK_SIGNOFF_STAGES.includes(stage) || reviewActFindings(project).length) return null;
  const interview = stage === 'plan-approved' ? 'interview' : stage;
  const split = hasStageOrder(project);
  const allItems = collectItems(project, { collection: loadCollection(dir) });
  const items = allItems.filter(item => interviewStageOfGuide(item.id, item.kind === 'post', split) === interview);
  if (stage === 'plan-approved') {
    const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
    const bases = steps.filter(step => step.phase === 'rig' && approvalStageOfStep('rig', String(step.id), split) === stage)
      .flatMap(step => asArray(step.rests_on));
    for (const id of new Set(bases)) {
      const item = allItems.find(item => item.id === id);
      if (!item) return null;
      if (!items.includes(item)) items.push(item);
    }
  }
  const receipts = asArray(project.review_acts).filter(isObject);
  const cutoffs = collectReopens(project, []);
  const picks = [];
  for (const item of items) {
    const answer = item.raw;
    if (!isObject(answer) || item.state.state !== 'user' || !isObject(answer.choice)
        || item.record.pending_options != null) return null;
    const hash = jobHash(JSON.stringify(answer.choice));
    const candidates = receipts.filter(entry => entry.kind === 'interview-picks' && entry.question === item.id && entry.version_hash === hash)
      .map(entry => decodeReviewAct(String(entry.bytes), 'interview-picks'))
      .filter(act => act.at === answer.at && Date.parse(act.at) <= now && act.authority.reviewer.role === 'owner'
        && liveSignoff(cutoffs, interviewStageOfGuide(item.id, item.kind === 'post', split), Date.parse(act.at))
        && liveSignoff(cutoffs, stage, Date.parse(act.at))
        && act.value.selections.every(pick => pick.otherText === null));
    if (candidates.length !== 1) return null;
    picks.push({ act: candidates[0]!, verbatim: String(answer.verbatim) });
  }
  const last = picks.reduce<(typeof picks)[number] | undefined>((latest, pick) =>
    latest === undefined || Date.parse(pick.act.at) >= Date.parse(latest.act.at) ? pick : latest, undefined);
  const by = last?.act.authority.reviewer.id;
  if (!last || !by || by.toLowerCase() === 'agent' || picks.some(({ act }) => act.authority.reviewer.id !== by)) return null;
  return {
    by, verbatim: last.verbatim, questions: picks.map(({ act }) => act.value.questionId),
    evidence: { from: 'picks', act_id: last.act.actId, job_id: last.act.jobId, said_at: last.act.at,
      picks: picks.map(({ act }) => ({ job_id: act.jobId, act_id: act.actId })) },
  };
}
