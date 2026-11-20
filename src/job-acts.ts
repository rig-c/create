/** Writer routing for finalized acts. No event transport or automatic ingestion. */
import type { ActV3, JobEventV3, JobOwnerHost, JobSelector, PendingAskV3, SourceV3 } from '@rig-c/review/job-host';
import { isDeepStrictEqual } from 'node:util';
import { asArray, isObject, type Finding } from './check.ts';
import { existsSync, readFileSync } from './check-reads.ts';
import { join } from 'node:path';
import { recordedPartsVerdict } from './parts-verdict-record.ts';
import { refuse } from './refusal.ts';
import { stageOfStep } from './stages.ts';
import { checkStructure } from './structure.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { JsonObject } from './templates.ts';

export type AgentReply = {
  ok?: boolean;
  error?: { code?: string; message?: string };
  value?: { events?: unknown; status?: unknown; cursor?: unknown; capabilities?: { askBatch?: unknown }; asks?: unknown };
};

export async function agentCall(host: JobOwnerHost, body: object): Promise<AgentReply> {
  const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
    method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: host.session.publicationMode === 'record-and-package' ? 'rig-review/job-api@3' : 'rig-review/job-api@2', jobId: host.session.jobId, requestId: randomUUID(), ...body }),
  }));
  return await response.json() as AgentReply;
}

/** The shared agent-next traversal; listing is strict while existing ask retries retain their contract. */
export async function* jobEvents(host: JobOwnerHost, strict = false, capabilities?: { askBatch?: boolean }): AsyncGenerator<JobEventV3> {
  let after: unknown = null;
  for (let page = 0; page < 10_000; page++) {
    let reply: AgentReply;
    try { reply = await agentCall(host, { verb: 'next', after, waitMs: 0 }); }
    catch (error) {
      if (strict) refuse('JOB_ACTS_READ_REFUSED', 'project.json: live job event read failed; restore the bound host and retry job acts');
      throw error;
    }
    if (capabilities && reply.ok && reply.value?.capabilities !== null && typeof reply.value?.capabilities === 'object') {
      capabilities.askBatch = reply.value.capabilities.askBatch === true;
    }
    const events = reply.ok ? reply.value?.events : undefined;
    if (!Array.isArray(events)) {
      if (strict) refuse('JOB_ACTS_READ_REFUSED', 'project.json: live job refused its event stream; restore the bound host and retry job acts');
      return;
    }
    for (const event of events as JobEventV3[]) yield event;
    if (reply.value?.status !== 'events' || reply.value.cursor === after) return;
    after = reply.value.cursor;
  }
  if (strict) refuse('JOB_ACTS_READ_REFUSED', 'project.json: live event stream exceeded the paging bound; retry job acts on a quiescent job');
}

export async function readHostActsAndAsks(host: JobOwnerHost): Promise<{ head: string | null; asks: PendingAskV3[]; acts: ActV3[] }> {
  let head: string | null = null;
  const asks: PendingAskV3[] = [];
  const acts: ActV3[] = [];
  for await (const event of jobEvents(host, true)) {
    if (event.type === 'published') head = event.publication.publicationId;
    else if (event.type === 'pending') asks.push(event.ask);
    else if (event.type === 'act') acts.push(event.act);
  }
  return { head, asks: asks.filter(ask => ask.publicationId === head), acts };
}

export async function readHostActs(host: JobOwnerHost): Promise<ActV3[]> {
  return (await readHostActsAndAsks(host)).acts;
}

export interface PendingJobAct {
  actId: string;
  kind: ActV3['kind'];
  subject: string;
  at: string;
  args: string[] | null;
  command: string | null;
  preconditions?: { command: string | null; act: string }[];
  unavailable?: { code: 'JOB_ACTS_WRITER_UNAVAILABLE' | 'REOPEN_ACT_RETIRED'; message: string };
}

export function shellWord(value: string): string {
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
  return acts.flatMap<PendingJobAct>(act => {
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
          if (act.value.verdict === 'approved') {
            const structure = partsStructureSnapshot(root, project, selector.id);
            const missing: string[] = [];
            if (!structure.valid) missing.push(`retained structure snapshot ${structure.path}`);
            if (!isObject(project.diff_map)) missing.push('diff-components evidence and diff-classes');
            if (!asArray(project.advances).some(row => isObject(row) && row.stage === 'parts-review' && isObject(row.parts_check))) missing.push('recorded check-parts evidence');
            if (project.stage !== 'parts-review') missing.push('advance parts-review');
            if (missing.length) preconditions.push({ command: null,
              act: `missing ${missing.join(', ')}; prepare all evidence and advance before publishing the draft and asking for a new parts-verdict; changing project.json after this act makes its projectHash stale` });
          }
        }
        break;
      }
      case 'interview-picks':
        subject = `question ${act.value.questionId}`;
        args = ['interview-answer', act.value.questionId, root];
        break;
      case 'reopen':
        return [{ actId: act.actId, kind: act.kind, subject: `stage ${act.value.stage}`, at: act.at, args: null, command: null,
          unavailable: { code: 'REOPEN_ACT_RETIRED',
            message: `project.json.review_acts: reopen act ${act.actId} is retired; correct an earlier answer with rig-create interview-options and interview-answer, then re-sign each stale approval. For an artifact change, use rig-create amend. After handling any other pending acts, close with rig-create job close --discard-acts <reason> --by agent` } }];
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
          if (!approved) preconditions.push({ command: null, act: `this separate signoff route is only for a midflight approved parts-verdict already ingested unsigned for draft ${draft}; otherwise prepare evidence and advance, republish the draft and ask for one parts-verdict` });
          if (!structure.valid) preconditions.push({
            command: ['rig-create', 'structure-snapshot', root, '--draft', draft].map(shellWord).join(' '),
            act: 'retain the structure snapshot from the draft; no verdict is required to create it',
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

export interface PendingTargetAsk {
  label: string;
  version: number | null;
}

function actMatchesAsk(act: ActV3, ask: PendingAskV3): boolean {
  if (act.askId === ask.askId) return true;
  if (act.publicationId !== ask.publicationId || act.kind !== ask.subject.kind) return false;
  switch (ask.subject.kind) {
    case 'review-verdict': return act.kind === 'review-verdict' && act.value.stage === ask.subject.stage;
    case 'parts-verdict': return act.kind === 'parts-verdict' && 'selector' in act.source && act.source.selector?.kind === 'draft' && act.source.selector.id === ask.subject.draftId;
    case 'interview-picks': return act.kind === 'interview-picks' && act.value.questionId === ask.subject.questionId;
    case 'checkpoint': return act.kind === 'checkpoint' && act.value.checkpointId === ask.subject.checkpointId;
    case 'signoff': return act.kind === 'signoff' && act.value.stage === ask.subject.stage;
    case 'reopen': return false;
  }
}

function sourceTargetInfo(source: SourceV3): { label: string; selector: JobSelector | null; version: number | null } {
  if ('selector' in source && source.selector) {
    const selector = source.selector;
    if (selector.kind === 'draft') return { label: `draft ${selector.id}`, selector, version: null };
    return { label: `${selector.kind} v${selector.version}`, selector, version: selector.version };
  }
  if ('selection' in source && source.selection) {
    return source.selection.kind === 'option-set'
      ? { label: `option-set ${source.selection.questionId}/${source.selection.setId}`, selector: null, version: null }
      : { label: 'plan', selector: null, version: null };
  }
  return { label: 'record', selector: null, version: null };
}

function askSubjectText(subject: PendingAskV3['subject']): string {
  switch (subject.kind) {
    case 'parts-verdict': return `parts-verdict ${subject.draftId}`;
    case 'checkpoint': return `checkpoint ${subject.checkpointId}`;
    case 'interview-picks': return `interview-picks ${subject.questionId}/${subject.setId}`;
    default: return `${subject.kind} ${subject.stage}`;
  }
}

export function pendingJobAsksForTarget(
  project: JsonObject,
  asks: readonly PendingAskV3[],
  acts: readonly ActV3[],
  root: string,
  target: JobSelector,
): PendingTargetAsk[] {
  // Retired reopens stay visible in job acts and job close, but cannot gate a new target.
  const actionableAsks = asks.filter(ask => ask.subject.kind !== 'reopen');
  const actionableActs = acts.filter(act => act.kind !== 'reopen');
  const unIngested = pendingJobActs(project, actionableActs, root);
  const unIngestedIds = new Set(unIngested.map(act => act.actId));
  const ingestedActs = actionableActs.filter(act => !unIngestedIds.has(act.actId));
  const pending: PendingTargetAsk[] = [];
  for (const ask of actionableAsks) {
    if (ingestedActs.some(act => actMatchesAsk(act, ask))) continue;
    const info = sourceTargetInfo(ask.source);
    if (info.selector && isDeepStrictEqual(info.selector, target)) continue;
    const hasUnIngestedAct = actionableActs.some(act => unIngestedIds.has(act.actId) && actMatchesAsk(act, ask));
    if (!hasUnIngestedAct && info.selector?.kind === 'draft' && target.kind === 'draft') continue;
    pending.push({ label: `${askSubjectText(ask.subject)} on ${info.label}`, version: info.version });
  }
  for (const act of actionableActs) {
    if (!unIngestedIds.has(act.actId) || actionableAsks.some(ask => actMatchesAsk(act, ask))) continue;
    const info = sourceTargetInfo(act.source);
    if (info.selector && isDeepStrictEqual(info.selector, target)) continue;
    pending.push({ label: `${act.kind} (${act.actId}) on ${info.label}`, version: info.version });
  }
  return pending;
}
