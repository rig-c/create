/** Writer routing for finalized acts. No event transport or automatic ingestion. */
import { JOB_COMMENT_ONLY_ACT_SCHEMA, type ActV3, type JobEventV3, type JobOwnerHost, type JobSelector, type PendingAskV3, type SourceV3 } from '@rig-c/review/job-host';
import { isDeepStrictEqual } from 'node:util';
import type { RecordPublicationResult } from './job-publication.ts';
import type { CreateJobSelector } from './job-outbox.ts';
import { asArray, collectItems, isObject, loadCollection, type Finding } from './check.ts';
import { existsSync, readFileSync } from './check-reads.ts';
import { join } from 'node:path';
import { LAST_NUMBERED_CREATE_RELEASE } from './numbered-retirement.ts';
import { isRiggingDraftAct } from './parts-act.ts';
import { refuse } from './refusal.ts';
import { liveSignoff } from './reopen.ts';
import { isRecordPicksAct, matchesActProjectSource, SIGNOFF_TARGET_KINDS } from './review-act.ts';
import { readVersions } from './review.ts';
import { collectAmendments } from './amend.ts';
import { stageOfStep } from './stages.ts';
import { checkStructure } from './structure.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Json, JsonObject } from './templates.ts';

export type AgentReply = {
  ok?: boolean;
  error?: { code?: string; message?: string };
  value?: { events?: unknown; status?: unknown; cursor?: unknown; capabilities?: { progress?: unknown } };
};

export async function agentCall(host: JobOwnerHost, body: object, send?: (request: Request) => Promise<Response>): Promise<AgentReply> {
  const request = new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
    method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: host.session.publicationMode === 'record-and-package' ? 'rig-review/job-api@3' : 'rig-review/job-api@2', jobId: host.session.jobId, requestId: randomUUID(), ...body }),
  });
  const response = send ? await send(request) : await host.ports.handleJobApi(request);
  return await response.json() as AgentReply;
}

/** The shared agent-next traversal for listing live job events. */
export async function* jobEvents(host: JobOwnerHost, strict = false, observed?: { cursor?: string | null }): AsyncGenerator<JobEventV3> {
  let after: unknown = null;
  for (let page = 0; page < 10_000; page++) {
    let reply: AgentReply;
    try { reply = await agentCall(host, { verb: 'next', after, waitMs: 0 }); }
    catch (error) {
      if (strict) refuse('JOB_ACTS_READ_REFUSED', 'project.json: live job event read failed; restore the bound host and retry job acts');
      throw error;
    }
    const events = reply.ok ? reply.value?.events : undefined;
    if (!Array.isArray(events)) {
      if (strict) refuse('JOB_ACTS_READ_REFUSED', 'project.json: live job refused its event stream; restore the bound host and retry job acts');
      return;
    }
    const cursor = reply.value?.cursor;
    if (observed && (typeof cursor === 'string' || cursor === null)) observed.cursor = cursor;
    for (const event of events as JobEventV3[]) yield event;
    if (reply.value?.status !== 'events' || reply.value.cursor === after) return;
    after = reply.value.cursor;
  }
  if (strict) refuse('JOB_ACTS_READ_REFUSED', 'project.json: live event stream exceeded the paging bound; retry job acts on a quiescent job');
}

export async function readHostActsAndAsks(host: JobOwnerHost): Promise<{ head: string | null; asks: PendingAskV3[]; acts: ActV3[]; cursor: string | null }> {
  let head: string | null = null;
  const asks: PendingAskV3[] = [];
  const acts: ActV3[] = [];
  const observed: { cursor?: string | null } = {};
  for await (const event of jobEvents(host, true, observed)) {
    if (event.type === 'published') head = event.publication.publicationId;
    else if (event.type === 'pending') asks.push(event.ask);
    else if (event.type === 'act') acts.push(event.act);
  }
  return { head, asks: asks.filter(ask => ask.publicationId === head), acts, cursor: observed.cursor ?? null };
}

export async function readHostActs(host: JobOwnerHost): Promise<ActV3[]> {
  return (await readHostActsAndAsks(host)).acts;
}

export interface PendingJobAct {
  actId: string;
  publicationId?: string;
  kind: ActV3['kind'];
  subject: string;
  at: string;
  value?: ActV3['value'];
  args: string[] | null;
  command: string | null;
  preconditions?: { command: string | null; act: string }[];
  unavailable?: { code: 'JOB_ACTS_WRITER_UNAVAILABLE' | 'REOPEN_ACT_RETIRED' | 'NUMBERED_ACT_RETIRED' | 'SIGNOFF_FROM_REVIEW_REMOVED'; message: string };
  /** A grouped interview page whose other sets have not all submitted: no ingest command yet. */
  waiting?: { received: number; total: number };
}

/** What the agent does with a pending act: its command, the grouped page it waits on, or why it has none. */
export function pendingActRemedy(act: PendingJobAct): string {
  if (act.command) return act.command;
  if (act.waiting) return `waiting for ${act.waiting.received}/${act.waiting.total} sets on this page; ingest after the remaining submissions with job acts --wait`;
  return `${act.unavailable!.code}: ${act.unavailable!.message}`;
}

/** The act can be acted on now: it is not part of a grouped page that is still waiting for its other sets. */
export function actionablePendingAct(act: PendingJobAct): boolean {
  return act.waiting === undefined;
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

function numberedActRetirement(actId: string): NonNullable<PendingJobAct['unavailable']> {
  return {
    code: 'NUMBERED_ACT_RETIRED',
    message: `project.json.review_acts: numbered act ${actId} is retired; adopt existing outputs with rig-create record <kind> --adopt, rig-create direction --adopt, or rig-create correction --adopt as applicable, or finish the numbered project on Create ${LAST_NUMBERED_CREATE_RELEASE}`,
  };
}

export function pendingJobActs(project: JsonObject, acts: readonly ActV3[], root: string): PendingJobAct[] {
  const ingested = new Set(asArray(project.review_acts).filter(isObject).map(row => JSON.stringify([row.jobId, row.actId])));
  const signoffs = asArray(project.signoffs).filter(isObject);
  const seen = new Set<string>();
  const pending = acts.flatMap<PendingJobAct>(act => {
    const key = JSON.stringify([act.jobId, act.actId]);
    if (seen.has(key) || ingested.has(key) || signoffs.some(row => row.source === `review act ${act.jobId}/${act.actId}`)) return [];
    seen.add(key);
    let subject: string = act.kind;
    let args: string[] | null = null;
    let unavailable: PendingJobAct['unavailable'];
    switch (act.kind) {
      case 'comments': {
        // act@10 answers no ask: it is actionable on its own, whatever asks are pending (#982).
        const comments = act.schema === JOB_COMMENT_ONLY_ACT_SCHEMA ? act.value.comments.length : 0;
        const carriers = act.schema === JOB_COMMENT_ONLY_ACT_SCHEMA ? (act.value.carriers ?? []).map(row => row.kind) : [];
        subject = `${comments} comment(s)${carriers.length ? ` with ${carriers.join(', ')}` : ''}`;
        args = ['comment', root];
        break;
      }
      case 'review-verdict': {
        const selector = act.source.selector as JobSelector | null;
        subject = act.value.stage;
        if (selector?.kind === 'draft' && act.value.stage === 'rig-review') {
          subject = `draft ${selector.id} / rig-review`;
        } else if (selector && (selector.kind === 'rig' || selector.kind === 'post')
          && act.value.stage === (selector.kind === 'rig' ? 'rig-review' : 'direction-review')) {
          subject = `${selector.kind} v${selector.version} / ${act.value.stage}`;
        }
        unavailable = numberedActRetirement(act.actId);
        break;
      }
      case 'parts-verdict': {
        const selector = act.source.selector;
        if (selector?.kind === 'draft') {
          const rigging = isRiggingDraftAct(act);
          subject = `${rigging ? 'rigging ' : ''}draft ${selector.id}`;
        }
        unavailable = numberedActRetirement(act.actId);
        break;
      }
      case 'interview-picks':
        subject = `question ${act.value.questionId}`;
        unavailable = {
          code: 'SIGNOFF_FROM_REVIEW_REMOVED',
          message: `project.json.interview: interview-answer --from-review was removed for act ${act.actId} (${subject}); use interview-answer ${act.value.questionId} ${shellWord(root)} --set <id> --sha256 <hash> --pick <option> --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`,
        };
        break;
      case 'reopen':
        return [{ actId: act.actId, ...(act.publicationId === undefined ? {} : { publicationId: act.publicationId }),
          kind: act.kind, subject: `stage ${act.value.stage}`, at: act.at, value: act.value, args: null, command: null,
          unavailable: { code: 'REOPEN_ACT_RETIRED',
            message: `project.json.review_acts: reopen act ${act.actId} is retired; correct an earlier answer with rig-create interview-options and interview-answer, then re-sign each stale approval. For an artifact change, use rig-create amend. Withdraw this act with rig-create job withdraw-act ${act.actId} and the owner’s relayed words` } }];
      case 'signoff': {
        subject = `stage ${act.value.stage}`;
        if (act.value.stage === 'parts-review') {
          if (act.source.selector?.kind === 'draft') {
            unavailable = numberedActRetirement(act.actId);
          } else if (act.source.selector?.kind === 'current') {
            unavailable = {
              code: 'SIGNOFF_FROM_REVIEW_REMOVED',
              message: `project.json.signoffs: signoff ${act.value.stage} --from-review was removed for act ${act.actId} (${subject}); use signoff ${act.value.stage} ${shellWord(root)} --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`,
            };
          }
        } else {
          unavailable = {
            code: 'SIGNOFF_FROM_REVIEW_REMOVED',
            message: `project.json.signoffs: signoff ${act.value.stage} --from-review was removed for act ${act.actId} (${subject}); use signoff ${act.value.stage} ${shellWord(root)} --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`,
          };
        }
        break;
      }
      case 'checkpoint': {
        const step = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject).find(step => step.id === act.value.planStepId);
        subject = `checkpoint ${act.value.planStepId}`;
        if (step && (step.phase === 'rig' || step.phase === 'post')) {
          const stage = stageOfStep(step.phase, String(step.id));
          subject += ` / ${stage}`;
          unavailable = {
            code: 'SIGNOFF_FROM_REVIEW_REMOVED',
            message: `project.json.signoffs: signoff --checkpoint ${act.value.planStepId} --from-review was removed for act ${act.actId} (${subject}); use signoff ${stage} ${shellWord(root)} --checkpoint ${act.value.planStepId} --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`,
          };
        }
        break;
      }
    }
    if (args) args.push('--from-review', act.actId);
    const row: PendingJobAct = { actId: act.actId, ...(act.publicationId === undefined ? {} : { publicationId: act.publicationId }),
      kind: act.kind, subject, at: act.at, value: act.value, args,
      command: args ? ['rig-create', ...args].map(shellWord).join(' ') : null,
      ...(args ? {} : { unavailable: unavailable ?? { code: 'JOB_ACTS_WRITER_UNAVAILABLE' as const,
        message: `project.json: act ${act.actId} (${subject}) has no current writer target; restore its plan step or use a supported Review subject before ingestion` } }) };
    return [row];
  });
  return pending;
}

/** An act on a current ask that project.json already holds; it needs no ingest. */
export interface IngestedJobAct {
  askId: string;
  actId: string;
  kind: ActV3['kind'];
  question?: string;
  stage?: string;
  subject: string;
  at: string;
  /** Where the act's value sits in project.json now (a superseded answer points at its history row). */
  recorded: string;
}

/** Acts already ingested for the asks on the current publication head, so an empty pending list is never read as unanswered. */
export function ingestedJobActs(project: JsonObject, asks: readonly PendingAskV3[], acts: readonly ActV3[], root: string): IngestedJobAct[] {
  const receipts = asArray(project.review_acts);
  const signoffs = asArray(project.signoffs);
  let items: ReturnType<typeof collectItems> | undefined;
  const seen = new Set<string>();
  const rows: IngestedJobAct[] = [];
  for (const ask of asks) {
    for (const act of acts) {
      const key = JSON.stringify([act.jobId, act.actId]);
      if (seen.has(key) || !actMatchesAsk(act, ask)) continue;
      const receipt = receipts.findIndex(row => isObject(row) && row.jobId === act.jobId && row.actId === act.actId);
      const signature = signoffs.findIndex(row => isObject(row) && row.source === `review act ${act.jobId}/${act.actId}`);
      if (receipt < 0 && signature < 0) continue;
      seen.add(key);
      let recorded = signature >= 0 ? `signoffs[${signature}]` : `review_acts[${receipt}]`;
      const value = act.value as { questionId?: string; stage?: string; planStepId?: string };
      if (receipt >= 0 && isObject(receipts[receipt]) && (receipts[receipt] as JsonObject).kind === 'discarded') recorded += ' (discarded)';
      else if (act.kind === 'interview-picks') {
        items ??= collectItems(project, { collection: loadCollection(root, project) });
        const item = items.find(item => item.id === value.questionId);
        if (item && isObject(item.raw) && item.raw.at === act.at) recorded = item.path;
        else if (item) {
          const history = asArray(item.record.history).findIndex(row => isObject(row) && row.at === act.at);
          if (history >= 0) recorded = `${item.path.replace(/\.(answer|guide)$/, '')}.history[${history}]`;
        }
      }
      rows.push({ askId: ask.askId, actId: act.actId, kind: act.kind,
        ...(value.questionId !== undefined ? { question: value.questionId } : {}),
        ...(value.stage !== undefined ? { stage: value.stage } : {}),
        subject: value.questionId !== undefined ? `question ${value.questionId}` : value.stage !== undefined ? `stage ${value.stage}`
          : value.planStepId !== undefined ? `checkpoint ${value.planStepId}` : act.kind,
        at: act.at, recorded });
    }
  }
  return rows;
}

/** How many current asks already have an ingested act (and where each is recorded), or that none were asked. */
export function ingestedSummary(result: { ingested?: readonly IngestedJobAct[]; asked?: number }): string {
  const ingested = result.ingested ?? [];
  if (!result.asked) return 'none asked on the current publication';
  return `${ingested.length} already ingested for ${result.asked} current ask(s)${ingested.length
    ? ` (${ingested.map(act => `${act.actId} ${act.subject} -> ${act.recorded}`).join('; ')})` : ''}`;
}

function actContentLines(value: PendingJobAct['value']): string[] {
  if (!value || typeof value !== 'object') return [];
  const lines: string[] = [];
  if ('verdict' in value && typeof value.verdict === 'string') lines.push(`  verdict: ${value.verdict}`);
  if ('comments' in value && Array.isArray(value.comments)) {
    for (const comment of value.comments) {
      if (comment && typeof comment === 'object' && 'text' in comment && typeof comment.text === 'string') {
        lines.push(`  comment: ${comment.text}`);
      }
    }
  } else if ('words' in value && typeof value.words === 'string') {
    lines.push(`  words: ${value.words}`);
  }
  return lines;
}

export function jobActsText(result: { acts: readonly PendingJobAct[]; ingested?: readonly IngestedJobAct[]; asked?: number }): string {
  const already = (result.ingested ?? []).map(act => `${act.actId} ${act.kind} ${act.subject} at ${act.at}\n  already recorded at ${act.recorded}; no ingest needed`);
  if (!result.acts.length) return [`job: no un-ingested acts; ${ingestedSummary(result)}`, ...already].join('\n');
  const printed = new Set<string>();
  const ready = result.acts.map(act => {
    const intro = [`${act.actId} ${act.kind} ${act.subject} at ${act.at}`, ...actContentLines(act.value)].join('\n');
    const preconditions = (act.preconditions ?? []).map(step => `  first: ${step.command ?? step.act}\n`).join('');
    if (!act.command) return `${intro}\n${act.waiting ? '' : preconditions}  ${pendingActRemedy(act)}`;
    if (printed.has(act.command)) return `${intro}\n  included in the batch command above`;
    printed.add(act.command);
    return `${intro}\n${preconditions}  ${act.command}`;
  });
  return [...ready, ...already].join('\n');
}

export interface PendingTargetAsk {
  label: string;
  version: number | null;
  interview: boolean;
  staleInterviewActId?: string;
}

function actMatchesAsk(act: ActV3, ask: PendingAskV3): boolean {
  // A comment-only act has no askId and answers no ask; narrow by schema before reading askId.
  if (act.schema === JOB_COMMENT_ONLY_ACT_SCHEMA) return false;
  const selector = sourceTargetInfo(ask.source).selector;
  if (ask.subject.kind === 'review-verdict' && selector?.kind === 'draft') {
    return act.kind === 'review-verdict' && act.publicationId === ask.publicationId && act.value.stage === ask.subject.stage
      && isDeepStrictEqual(act.source.selector, selector) && act.source.sourceHash === ask.source.sourceHash;
  }
  if (ask.subject.kind === 'interview-picks') {
    return act.kind === 'interview-picks' && act.publicationId === ask.publicationId
      && act.value.questionId === ask.subject.questionId && act.source.optionSet.id === ask.subject.setId;
  }
  if (act.askId === ask.askId) return true;
  if (act.publicationId !== ask.publicationId || act.kind !== ask.subject.kind) return false;
  switch (ask.subject.kind) {
    case 'review-verdict': return act.kind === 'review-verdict' && act.value.stage === ask.subject.stage;
    case 'parts-verdict': return act.kind === 'parts-verdict' && 'selector' in act.source && act.source.selector?.kind === 'draft' && act.source.selector.id === ask.subject.draftId;
    case 'checkpoint': return act.kind === 'checkpoint' && act.value.checkpointId === ask.subject.checkpointId;
    case 'signoff': return act.kind === 'signoff' && act.value.stage === ask.subject.stage;
    case 'reopen': return false;
  }
}

/** A record-only write has no publication target and cannot carry an ask forward. */
export type JobWriteAskTarget = CreateJobSelector | { kind: 'record-only'; writer?: 'interview' };
export type JobAskTarget = JobWriteAskTarget | RecordPublicationResult;

function sameTarget(source: SourceV3, target: JobAskTarget): boolean {
  if (target.kind === 'record-only') return false;
  if ('selector' in source && source.selector) return isDeepStrictEqual(source.selector, target);
  if ('selection' in source && source.selection) return isDeepStrictEqual(source.selection, target);
  return false;
}

function sourceTargetInfo(source: SourceV3): { label: string; selector: CreateJobSelector | null; version: number | null } {
  if ('selector' in source && source.selector) {
    const selector = source.selector as CreateJobSelector;
    if (selector.kind === 'draft') return { label: `draft ${selector.id}`, selector, version: null };
    if (selector.kind === 'current') return { label: `current ${selector.output}`, selector, version: null };
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

function isMultiOptionSource(source: SourceV3): boolean {
  return 'optionSets' in source && Array.isArray(source.optionSets);
}

/**
 * A verdict ask or act on a rig or post version that a later amendment made
 * history is settled by the record: its act stays listed by job acts, and its ingest
 * still refuses REVIEW_ACT_SOURCE_STALE, but it no longer holds the job for a new ask.
 */
function supersededVerdictSource(project: JsonObject, subject: { kind: string; stage?: string }, source: SourceV3): boolean {
  if (subject.kind !== 'review-verdict' && !(subject.kind === 'signoff' && SIGNOFF_TARGET_KINDS[String(subject.stage)] !== undefined)) return false;
  const selector = 'selector' in source ? source.selector : null;
  if (!selector || (selector.kind !== 'rig' && selector.kind !== 'post')) return false;
  const versions = readVersions(project);
  const amendments = collectAmendments(project, []);
  return (selector.kind === 'rig' ? versions.rigs : versions.posts).some(version => version.n === selector.version
    && !liveSignoff(amendments, selector.kind === 'rig' ? 'rig-review' : 'post', Date.parse(version.at ?? '')));
}

export function pendingJobAsksForTarget(
  project: JsonObject,
  asks: readonly PendingAskV3[],
  acts: readonly ActV3[],
  root: string,
  target: JobAskTarget,
  record?: Buffer,
): PendingTargetAsk[] {
  // Retired reopens stay visible in job acts and job close, but cannot gate a new target.
  const actionableAsks = asks.filter(ask => ask.subject.kind !== 'reopen');
  const actionableActs = acts.filter(act => act.kind !== 'reopen');
  const unIngested = pendingJobActs(project, actionableActs, root);
  const unIngestedIds = new Set(unIngested.map(act => act.actId));
  const unIngestedActs = actionableActs.filter(act => unIngestedIds.has(act.actId));
  const staleInterviewAct = (act: ActV3 | undefined): string | undefined => act !== undefined
    && isRecordPicksAct(act) && isMultiOptionSource(act.source)
    && record !== undefined && !matchesActProjectSource(act, record) ? act.actId : undefined;
  const pending: PendingTargetAsk[] = [];
  for (const ask of actionableAsks) {
    // An unanswered ask is historical. Only its finalized, unresolved act can hold the target.
    const unIngestedAct = unIngestedActs.find(act => actMatchesAsk(act, ask));
    if (!unIngestedAct) continue;
    const info = sourceTargetInfo(ask.source);
    const interview = ask.subject.kind === 'interview-picks';
    const multiInterview = interview && isMultiOptionSource(ask.source);
    if (!multiInterview && sameTarget(ask.source, target)) continue;
    if (supersededVerdictSource(project, ask.subject, ask.source)) continue;
    const label = askSubjectText(ask.subject);
    const staleInterviewActId = staleInterviewAct(unIngestedAct);
    pending.push({ label: multiInterview ? label : `${label} on ${info.label}`, version: info.version, interview,
      ...(staleInterviewActId === undefined ? {} : { staleInterviewActId }) });
  }
  for (const act of unIngestedActs) {
    if (actionableAsks.some(ask => actMatchesAsk(act, ask))) continue;
    const info = sourceTargetInfo(act.source);
    if (!isMultiOptionSource(act.source) && sameTarget(act.source, target)) continue;
    if (supersededVerdictSource(project, { kind: act.kind, stage: 'stage' in act.value ? String(act.value.stage) : undefined }, act.source)) continue;
    const staleInterviewActId = staleInterviewAct(act);
    pending.push({ label: `${act.kind} (${act.actId}) on ${info.label}`, version: info.version, interview: act.kind === 'interview-picks',
      ...(staleInterviewActId === undefined ? {} : { staleInterviewActId }) });
  }
  return pending;
}
