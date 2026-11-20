/** Writer routing for finalized acts. No event transport or automatic ingestion. */
import type { ActV3, JobEventV3, JobOwnerHost, JobSelector, PendingAskV3, RecordResult, SourceV3 } from '@rig-c/review/job-host';
import { isDeepStrictEqual } from 'node:util';
import { asArray, collectItems, collectSignoffs, isObject, loadCollection, type Finding } from './check.ts';
import { optionFile } from './choices.ts';
import { existsSync, readFileSync } from './check-reads.ts';
import { join } from 'node:path';
import { recordedPartsVerdict } from './parts-verdict-record.ts';
import { isRiggingDraftAct } from './parts-act.ts';
import { refuse } from './refusal.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { OWNER_CHAT_SOURCE } from './owner-chat.ts';
import { SIGNOFF_TARGET_KINDS } from './review-act.ts';
import { stageOfStep, stepCoveredByApproval } from './stages.ts';
import { stepHash } from './step-hash.ts';
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
export async function* jobEvents(host: JobOwnerHost, strict = false, observed?: { askBatch?: boolean; cursor?: string | null }): AsyncGenerator<JobEventV3> {
  let after: unknown = null;
  for (let page = 0; page < 10_000; page++) {
    let reply: AgentReply;
    try { reply = await agentCall(host, { verb: 'next', after, waitMs: 0 }); }
    catch (error) {
      if (strict) refuse('JOB_ACTS_READ_REFUSED', 'project.json: live job event read failed; restore the bound host and retry job acts');
      throw error;
    }
    if (observed && reply.ok && reply.value?.capabilities !== null && typeof reply.value?.capabilities === 'object') {
      observed.askBatch = reply.value.capabilities.askBatch === true;
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
          const rigging = isRiggingDraftAct(act);
          subject = `${rigging ? 'rigging ' : ''}draft ${selector.id}`;
          args = ['parts-review', root];
          if (!rigging && act.value.verdict === 'approved') {
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

export function jobActsText(result: { acts: readonly PendingJobAct[]; ingested?: readonly IngestedJobAct[]; asked?: number }): string {
  const already = (result.ingested ?? []).map(act => `${act.actId} ${act.kind} ${act.subject} at ${act.at}\n  already recorded at ${act.recorded}; no ingest needed`);
  if (!result.acts.length) return [`job: no un-ingested acts; ${ingestedSummary(result)}`, ...already].join('\n');
  return [...result.acts.map(act => `${act.actId} ${act.kind} ${act.subject} at ${act.at}\n${(act.preconditions ?? []).map(step => `  first: ${step.command ?? step.act}\n`).join('')}  ${act.command ?? `${act.unavailable!.code}: ${act.unavailable!.message}`}`), ...already].join('\n');
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

/** A publication target: a package selector, or a record result (`--question` option set or `--plan`). */
export type JobAskTarget = JobSelector | RecordResult;

function sameTarget(source: SourceV3, target: JobAskTarget): boolean {
  if ('selector' in source && source.selector) return isDeepStrictEqual(source.selector, target);
  if ('selection' in source && source.selection) return isDeepStrictEqual(source.selection, target);
  return false;
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

/** A finalized Review act still needs ingestion even if the record was signed separately. */
function signoffSettlesAsk(project: JsonObject, ask: PendingAskV3): boolean {
  if (ask.status !== 'pending' || ask.subject.kind !== 'signoff') return false;
  const { stage } = ask.subject;
  const kind = SIGNOFF_TARGET_KINDS[stage];
  const selector = ask.source.selector;
  const version = selector && 'version' in selector && selector.kind === kind ? selector.version : null;
  if (kind !== undefined && version === null) return false;
  const reopens = collectReopens(project, []);
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  const covered = steps.filter(step => stepCoveredByApproval(project, step, stage));
  return collectSignoffs(project, []).some(signature => {
    const { record } = signature;
    if (signature.stage !== stage || signature.checkpoint !== null
      || (record.source !== undefined && record.source !== OWNER_CHAT_SOURCE)
      || !Number.isFinite(signature.at) || !liveSignoff(reopens, stage, signature.at)) return false;
    if (version !== null && (!isObject(record.target) || record.target.version !== version)) return false;
    if (stage === 'parts-review' && selector?.kind === 'draft' && record.draft_id !== selector.id) return false;
    if (covered.length === 0 && record.step_hashes === undefined) return true;
    const hashes = record.step_hashes;
    return isObject(hashes) && covered.every(step => {
      const id = String(step.id);
      return hashes[id] === stepHash(step) && (ask.source.plan?.steps.some(shown => shown.id === id) ?? false);
    }) && Object.keys(hashes).length === covered.length;
  });
}

/**
 * An owner-chat interview answer (`interview-answer --owner-chat`) creates no Review act.
 * It settles the interview-picks ask when the question's current answer is bound to the
 * same option set the ask published: path and sha256, and the set id they resolve to.
 */
function ownerChatAnswerSettlesAsk(project: JsonObject, root: string, ask: PendingAskV3): boolean {
  if (ask.status !== 'pending' || ask.subject.kind !== 'interview-picks') return false;
  const source = ask.source;
  if (!('selection' in source) || source.selection?.kind !== 'option-set' || !source.optionSet || !source.optionSetFile) return false;
  const { questionId, setId } = source.selection;
  if (ask.subject.questionId !== questionId || ask.subject.setId !== setId || source.optionSet.id !== setId) return false;
  let item: ReturnType<typeof collectItems>[number] | undefined;
  try { item = collectItems(project, { collection: loadCollection(root, project) }).find(candidate => candidate.id === questionId); }
  catch { return false; }
  if (!item || (item.state.state !== 'user' && item.state.state !== 'delegated') || item.state.answer !== item.raw) return false;
  const answer = item.state.answer;
  if (answer.source !== OWNER_CHAT_SOURCE || !isObject(answer.choice)) return false;
  const binding = answer.choice.set;
  if (!isObject(binding) || binding.path !== source.optionSetFile.path || binding.sha256 !== source.optionSet.sha256) return false;
  try { return optionFile(root, binding).set.id === setId; } catch { return false; }
}

export function pendingJobAsksForTarget(
  project: JsonObject,
  asks: readonly PendingAskV3[],
  acts: readonly ActV3[],
  root: string,
  target: JobAskTarget,
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
    if (sameTarget(ask.source, target)) continue;
    const hasUnIngestedAct = actionableActs.some(act => unIngestedIds.has(act.actId) && actMatchesAsk(act, ask));
    if (!hasUnIngestedAct && (signoffSettlesAsk(project, ask) || ownerChatAnswerSettlesAsk(project, root, ask))) continue;
    if (!hasUnIngestedAct && info.selector?.kind === 'draft' && target.kind === 'draft') continue;
    pending.push({ label: `${askSubjectText(ask.subject)} on ${info.label}`, version: info.version });
  }
  for (const act of actionableActs) {
    if (!unIngestedIds.has(act.actId) || actionableAsks.some(ask => actMatchesAsk(act, ask))) continue;
    const info = sourceTargetInfo(act.source);
    if (sameTarget(act.source, target)) continue;
    pending.push({ label: `${act.kind} (${act.actId}) on ${info.label}`, version: info.version });
  }
  return pending;
}
