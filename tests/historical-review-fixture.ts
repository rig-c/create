import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  JOB_CHEST_LANDMARKS_ACT_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, JOB_RECORD_ACT_SCHEMA, parseCommentsAct, parseRecordAct,
  type JobActV3, type JobComment, type JobOwnerHost, type JobRetainedSourceV3, type JobReviewerBinding,
  type JobSourceV3, type RecordCheckpointSubject,
} from '@rig-c/review/job-host';
import { asArray, checkProject, collectItems, collectionAnswer, isObject, loadCollection, type Finding } from '../src/check.ts';
import { CHOICE_SPEC, choiceVerbatim, optionFile, selection, validateChoice } from '../src/choices.ts';
import { INTAKE_QUESTION, intakeItem } from '../src/intake.ts';
import { jobHash, readAcknowledgedPublication } from '../src/job-outbox.ts';
import { overrideFindings } from '../src/overrides.ts';
import { assertPartsActSource, currentPartsAmendment, isRiggingDraftAct, partsActDraftHash } from '../src/parts-act.ts';
import { latestPartsVerdictFinding, recordedPartsVerdict } from '../src/parts-verdict-record.ts';
import { baselineOf, newFindings } from '../src/refusal-baseline.ts';
import { refuse, USAGE_EXIT } from '../src/refusal.ts';
import {
  agentUnderOwner, assertActSubjectDeclared, assertReviewActSource, decodeReviewAct, fetchBustPublicationSeeds,
  interviewFeedbackRoute, isRecordDirectionSignoff, matchesActProjectSource, meshReviewVerdict, recordSignoffActVersion,
  reviewActBy, reviewActFindings, reviewActPublicationWarning, reviewActSignoff, reviewActVerdict, reviewActVerbatim,
  reviewActVersionHash, rigVerdictSignoff, SIGNOFF_TARGET_KINDS, signoffActIdentity, signoffActVersion, type ReviewVerdictAct,
} from '../src/review-act.ts';
import { bustLandmarkCommands, prepareBustConfig, retainedRigActPath } from '../src/review-bust.ts';
import { assertCorrectionApproval, stageReviewMeshDeltaCorrections } from '../src/correction-writers.ts';
import { checkDiffMap } from '../src/diff-map.ts';
import { assertDirectionApproval } from '../src/direction.ts';
import { discardReviewActOutputs, retainReviewSidecar } from '../src/feedback.ts';
import { collectReopens } from '../src/reopen.ts';
import { latestAccepted, readVersions, type RigVersion } from '../src/review.ts';
import { rigVerdictIngestible } from '../src/signable.ts';
import { assertPlanSignoffCandidate } from '../src/signoff.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import { signoffPairFinding } from '../src/signoff-pair.ts';
import { selectSignoffTarget } from '../src/signoff-target.ts';
import { hasStageOrder, stageIndex } from '../src/stages.ts';
import { checkStructure, structurePathIsIgnored } from '../src/structure.ts';
import type { JsonObject } from '../src/templates.ts';

export function assertHistoricalRigReviewSignable(project: JsonObject, path: string): void {
  const versions = readVersions(project);
  const accepted = latestAccepted(versions);
  if (accepted !== null) {
    const latest = versions.rigs.filter(r => r.live).reduce<RigVersion | null>((a, r) => (a === null || r.n > a.n ? r : a), null);
    if (latest !== null && latest.n !== accepted.n) {
      refuse('RIG_VERSION_UNACCEPTED', `${latest.path}: latest live rig v${latest.n} has no accepted rig-review verdict`);
    }
    return;
  }
  const lapsedRig = versions.rigs.filter(r => !r.live && r.accepted !== null).reduce<RigVersion | null>((a, r) => (a === null || r.n > a.n ? r : a), null);
  if (lapsedRig !== null && lapsedRig.accepted !== null) {
    const built = Date.parse(lapsedRig.at ?? '');
    const cutoff = collectReopens(project, []).some(r => stageIndex(r.stage) <= stageIndex('rig-review') && !(built > r.at));
    if (cutoff) refuse('RIG_VERSION_UNACCEPTED', `${path}: rig-review would be signed on a lapsed acceptance of rig v${lapsedRig.n}`);
  }
}

export function selectHistoricalSignoffTarget(
  dir: string,
  project: JsonObject,
  stage: string,
  requested?: string,
  now = Date.now(),
): JsonObject | undefined {
  if (project.current === undefined) {
    assertDirectionApproval(dir, project, stage, now);
    if (stage === 'rig-review') assertHistoricalRigReviewSignable(project, `signoffs[${asArray(project.signoffs).length}]`);
  }
  return selectSignoffTarget(dir, project, stage, requested);
}

export function foldHistoricalRigSignoff(
  root: string,
  candidate: JsonObject,
  act: ReviewVerdictAct,
  original: Buffer,
  asRead: ReturnType<typeof checkProject>,
  now: number,
): JsonObject {
  if (!matchesActProjectSource(act, original)) {
    refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: rig approval predates the current record');
  }
  if (!Array.isArray(candidate.signoffs)) refuse('SIGNOFF_MALFORMED', 'project.json.signoffs: expected a list');
  const selector = act.source.selector;
  if (selector?.kind !== 'rig') refuse('REVIEW_ACT_TARGET_MISMATCH', 'project.json.signoffs.target: rig approval must display a rig version');
  const signoff: JsonObject = rigVerdictSignoff(act);
  assertDirectionApproval(root, candidate, 'rig-review', now);
  assertCorrectionApproval(root, candidate, 'rig-review', now, signoff);
  assertHistoricalRigReviewSignable(candidate, `signoffs[${candidate.signoffs.length}]`);
  signoff.target = selectSignoffTarget(root, candidate, 'rig-review', String(selector.version))!;
  const answerHashes = selectAnswerHashes(root, candidate, signoff);
  if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
  const receipt = asArray(candidate.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === act.actId);
  if (receipt) receipt.signoff = candidate.signoffs.length;
  candidate.signoffs.push(signoff);
  const pair = signoffPairFinding(candidate, signoff, `signoffs[${candidate.signoffs.length - 1}]`, true);
  if (pair) refuse(pair.code, pair.message);
  const afterReport = checkProject(root, candidate, { now });
  const added = newFindings(baselineOf(asRead), afterReport.refusals);
  if (added[0]) refuse(added[0].code, added[0].message);
  return signoff;
}

type PendingCheckpoint = {
  askId: string;
  publicationId: string;
  subject: RecordCheckpointSubject;
  source: JobSourceV3;
  status: 'pending' | 'answered';
};
type StoredJob = { data: {
  generation: number;
  reviewer: JobReviewerBinding;
  publications: Record<string, { retained: JobRetainedSourceV3 }>;
  asks: Record<string, PendingCheckpoint>;
  acts: Record<string, JobActV3>;
} };

function historicalSession(host: JobOwnerHost) {
  return host.session as unknown as {
    jobId: string;
    store: { update(jobId: string, rev: null, write: (row: StoredJob) => StoredJob): StoredJob };
    event(data: StoredJob['data'], event: { type: 'pending'; ask: PendingCheckpoint } | { type: 'act'; act: JobActV3 }): void;
  };
}

/** Seed a retired checkpoint ask against the real retained publication. */
export function seedHistoricalCheckpointAsk(host: JobOwnerHost, publicationId: string, subject: RecordCheckpointSubject): string {
  const session = historicalSession(host);
  const askId = randomUUID();
  session.store.update(session.jobId, null, ({ data }) => {
    const { source, subjects } = data.publications[publicationId]!.retained;
    if (!subjects.some(candidate => candidate.kind === 'checkpoint' && candidate.checkpointId === subject.checkpointId)) {
      throw Error('Historical checkpoint ask needs a publication that declared it');
    }
    const ask: PendingCheckpoint = { askId, publicationId, subject, source, status: 'pending' };
    data.generation++;
    data.asks[askId] = ask;
    session.event(data, { type: 'pending', ask });
    return { data };
  });
  return askId;
}

/** Store the answered ask and finalized event as Review did before retiring checkpoint submissions. */
export function seedHistoricalCheckpointAct(host: JobOwnerHost, askId: string, outcome: 'pass' | 'fail',
  content: { words: string } | { comments: readonly JobComment[] },
  { actId = randomUUID(), at = new Date().toISOString() }: { actId?: string; at?: string } = {}) {
  const session = historicalSession(host);
  const { data } = session.store.update(session.jobId, null, ({ data }) => {
    const ask = data.asks[askId]!;
    const { publicationId, source, subject: { checkpointId } } = ask;
    const act = { actId, jobId: session.jobId, askId, publicationId, kind: 'checkpoint', source, at,
      authority: { actor: 'human', channel: 'review-ui', reviewer: data.reviewer },
      value: { checkpointId, planStepId: checkpointId, outcome, ...content } };
    const parsed = 'words' in content
      ? parseRecordAct({ ...act, schema: JOB_RECORD_ACT_SCHEMA })
      : parseCommentsAct({ ...act, schema: JOB_COMMENTS_ACT_SCHEMA });
    data.generation++;
    data.asks[askId] = { ...ask, status: 'answered' };
    data.acts[actId] = parsed;
    session.event(data, { type: 'act', act: parsed });
    return { data };
  });
  const act = data.acts[actId];
  if (act?.kind !== 'checkpoint') throw Error('Historical checkpoint act was not stored');
  return act;
}

function isoOf(value?: string | number): string {
  if (typeof value === 'number') return new Date(value).toISOString();
  return value ?? new Date().toISOString();
}

/** Seed a historical human verdict directly in versions[n].verdicts[] for check/reader tests. */
export function seedStoredVerdict(
  dir: string,
  n: number,
  entry: {
    review: 'rig-review' | 'direction-review';
    verdict: 'accepted' | 'bounced' | 'provisional';
    by?: string;
    at?: string | number;
    verbatim: string;
    source?: string;
    on_items?: JsonObject[];
    answers_feedback?: JsonObject[];
  },
): JsonObject {
  const projectPath = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
  const version = asArray(project.versions).filter(isObject).find(candidate => candidate.n === n);
  if (!version) throw Error(`Missing version ${n} in ${projectPath}`);
  const row: JsonObject = {
    by: entry.by ?? 'user',
    at: isoOf(entry.at),
    review: entry.review,
    verdict: entry.verdict,
    verbatim: entry.verbatim,
    source: entry.source ?? 'synthetic review',
    on_items: entry.on_items ?? [],
  };
  version.verdicts = [...asArray(version.verdicts), row];
  if (entry.answers_feedback !== undefined) {
    version.answers_feedback = [...asArray(version.answers_feedback), ...entry.answers_feedback];
  }
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  return row;
}

/** Seed a historical numbered version signoff using selectSignoffTarget for check/reader tests. */
export function seedStoredVersionSignoff(
  dir: string,
  stage: 'rig-review' | 'direction-review',
  version: number,
  options: { by?: string; at?: string | number; verbatim: string; source?: string },
): JsonObject {
  const projectPath = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
  const at = isoOf(options.at);
  const target = selectSignoffTarget(dir, project, stage, String(version));
  if (!target) throw Error(`Missing signoff target for ${stage} v${version}`);
  const signoff: JsonObject = {
    stage,
    checkpoint: null,
    by: options.by ?? 'user',
    at,
    verbatim: options.verbatim,
    ...(options.source === undefined ? {} : { source: options.source }),
    target,
  };
  const answerHashes = selectAnswerHashes(dir, project, signoff);
  if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
  project.signoffs = [...asArray(project.signoffs), signoff];
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  return signoff;
}

/** Seed a historical draft parts-review signoff validated through recordedPartsVerdict and checkStructure. */
export function seedStoredPartsSignoff(
  dir: string,
  draftId: string,
  options: { by?: string; at?: string | number; verbatim: string; structureFile?: string; explicitStructure?: boolean; source?: string },
): JsonObject {
  const projectPath = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
  const at = isoOf(options.at);
  const path = `signoffs[${asArray(project.signoffs).length}]`;
  const latestProblem = latestPartsVerdictFinding(project, draftId, `${path}.draft_id`);
  if (latestProblem) refuse(latestProblem.code, latestProblem.message);
  const verdict = recordedPartsVerdict(dir, project, draftId);
  const signoff: JsonObject = {
    stage: 'parts-review',
    checkpoint: null,
    by: options.by ?? 'user',
    at,
    verbatim: options.verbatim,
    ...(options.source === undefined ? {} : { source: options.source }),
  };
  const answerHashes = selectAnswerHashes(dir, project, signoff);
  if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
  signoff.evidence = verdict.evidence;
  signoff.draft_id = draftId;
  const diffErrors: Finding[] = [];
  checkDiffMap(dir, signoff, path, verdict.partsFile, diffErrors, [], project);
  if (diffErrors[0]) refuse(diffErrors[0].code, diffErrors[0].message);
  const structureFile = options.explicitStructure
    ? options.structureFile
    : (options.structureFile ?? `evidence/structure-${draftId}.json`);
  if (hasStageOrder(project) || structureFile !== undefined) {
    if (structureFile !== undefined) {
      try {
        if (structurePathIsIgnored(dir, structureFile)) {
          throw new Error('structure snapshots must survive a clone; retain the file outside ignored roots, for example evidence/');
        }
        const canonical = realpathSync(resolve(dir, structureFile));
        const rel = relative(realpathSync(dir), canonical).split(sep).join('/');
        if (isAbsolute(structureFile)) throw new Error('pass the project-relative path, for example evidence/structure-<id>.json');
        if (rel === '' || rel === '..' || rel.startsWith('../')) throw new Error('structure file must stay under the project');
        signoff.structure = { path: rel, sha256: jobHash(readFileSync(canonical)) };
      } catch (error) {
        refuse('STRUCTURE_DECISIONS_INVALID', `signoffs.structure: ${error instanceof Error ? error.message : String(error)}; retain the structure snapshot under the project`);
      }
    }
    const errors: Finding[] = [];
    checkStructure(dir, project, signoff, path, errors);
    if (errors[0]) refuse(errors[0].code, errors[0].message);
  }
  assertCorrectionApproval(dir, project, 'parts-review', Date.parse(at), signoff);
  project.signoffs = [...asArray(project.signoffs), signoff];
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  return signoff;
}

export interface SeedInterviewPicksOptions {
  routeComments?: boolean;
  whyFile?: string;
  now?: number;
  checkProjectHash?: boolean;
  expectedQuestion?: string;
  extraFlags?: readonly string[];
}

function seedStoredInterviewPicksInternal(
  dir: string,
  actInput: JsonObject | string,
  options: SeedInterviewPicksOptions = {},
): { receipt: JsonObject; answer: JsonObject; json: string } {
  if (options.extraFlags?.length) {
    refuse('INTERVIEW_OPTIONS_USAGE', 'interview: unexpected extra flags on historical act seed', USAGE_EXIT);
  }
  const bytes = typeof actInput === 'string' ? actInput : JSON.stringify(actInput);
  const act = decodeReviewAct(bytes, 'interview-picks');
  if (options.expectedQuestion !== undefined && act.value.questionId !== options.expectedQuestion) {
    refuse('REVIEW_ACT_INVALID', `project.json.review_acts: act question ${act.value.questionId} differs from ${options.expectedQuestion}`);
  }
  const projectPath = join(dir, 'project.json');
  const rawBytes = readFileSync(projectPath);
  const project = JSON.parse(rawBytes.toString('utf8')) as JsonObject;
  if (isObject(project.review_job) && typeof project.review_job.jobId === 'string' && act.jobId !== project.review_job.jobId) {
    refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: act jobId differs from bound review_job');
  }
  const collection = loadCollection(dir, project);
  const findItem = (record: JsonObject) => act.value.questionId === INTAKE_QUESTION
    ? intakeItem(record)
    : collectItems(record, { collection }).find(candidate => candidate.id === act.value.questionId);
  const existing = asArray(project.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === act.actId);
  if (existing) {
    if (existing.kind !== 'interview-picks' || existing.bytes !== bytes || existing.sha256 !== jobHash(bytes)) {
      refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: act replay bytes differ');
    }
    const ledgerFindings = reviewActFindings(project);
    if (ledgerFindings[0]) refuse(ledgerFindings[0].code, ledgerFindings[0].message);
    const currentItem = findItem(project);
    if (!currentItem) throw Error(`Unknown interview question ${act.value.questionId}`);
    const retained = [currentItem.raw, ...asArray(currentItem.record.history)].filter(isObject);
    const matched = retained.find(candidate => candidate.at === act.at && isObject(candidate.choice)
      && jobHash(JSON.stringify(candidate.choice)) === existing.version_hash) ?? (currentItem.raw as JsonObject);
    return { receipt: existing, answer: matched, json: JSON.stringify(matched) };
  }
  const now = options.now ?? Date.now();
  if (Date.parse(act.at) > now + 5_000) {
    refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: act timestamp is in the future');
  }
  if (options.checkProjectHash && !matchesActProjectSource(act, rawBytes)) {
    refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: projectHash changed');
  }
  assertActSubjectDeclared(dir, act, 'project.json.review_acts');
  const by = reviewActBy(act);
  if (agentUnderOwner(act) || by.trim().toLowerCase() === 'agent') {
    refuse('INTERVIEW_CHOICE_INVALID', 'project.json.interview: --by must name a human reviewer');
  }
  const item = findItem(project);
  if (!item) throw Error(`Unknown interview question ${act.value.questionId}`);
  const sourceFile = 'optionSetFile' in act.source && act.source.optionSetFile ? act.source.optionSetFile : undefined;
  const pending = isObject(item.record.pending_options) ? item.record.pending_options : undefined;
  const setBinding = sourceFile
    ? { path: sourceFile.path, sha256: sourceFile.sha256 }
    : pending
      ? { path: String(pending.path), sha256: String(pending.sha256) }
      : undefined;
  if (!setBinding) refuse('INTERVIEW_OPTIONS_STALE', `${item.path}: pending option set is absent`);
  if (pending && (pending.path !== setBinding.path || pending.sha256 !== setBinding.sha256)) {
    refuse('INTERVIEW_OPTIONS_STALE', `${item.path}: displayed option set differs from pending_options`);
  }
  const { set } = optionFile(dir, setBinding);
  if (String(set.id) !== String(act.source.optionSet.id) || setBinding.sha256 !== String(act.source.optionSet.sha256)) {
    refuse('INTERVIEW_OPTIONS_STALE', `${item.path}: displayed option set id or sha256 differs from registered pending_options`);
  }
  const seenAsks = new Set<string>();
  const picks: JsonObject[] = act.value.selections.map(sel => {
    if (seenAsks.has(sel.itemId)) refuse('REVIEW_ACT_INVALID', `${item.path}: duplicate selection for ${sel.itemId}`);
    seenAsks.add(sel.itemId);
    const ask = asArray(set.asks).filter(isObject).find(candidate => candidate.id === sel.itemId);
    const option = ask ? asArray(ask.options).filter(isObject).find(candidate => candidate.id === sel.optionId) : undefined;
    if (!ask || !option) refuse('INTERVIEW_CHOICE_INVALID', `${item.path}: unknown option ${sel.itemId}=${sel.optionId}`);
    return {
      ask: sel.itemId,
      option_id: sel.optionId,
      shown: { label: option.label!, effect: option.effect! },
      ...(sel.otherText === null ? {} : { other_text: sel.otherText }),
    };
  });
  const choice: JsonObject = {
    spec: CHOICE_SPEC,
    set: setBinding,
    picks,
    ...(act.value.note !== undefined ? { note: act.value.note } : {}),
  };
  const projected = selection(set, choice);
  const answer: JsonObject = {
    delegated: projected.delegated,
    by,
    at: act.at,
    verbatim: choiceVerbatim(picks, choice.note),
    source: 'review questionnaire',
    choice,
    asks: projected.asks,
    ...(projected.value === undefined ? {} : { value: projected.value }),
    ...(projected.autos.length ? { agent_decision: { covers: projected.autos.join(',') } } : {}),
  };
  if (isObject(item.raw) && typeof item.raw.basis === 'string') {
    answer.basis = item.raw.basis === 'inherited' ? (item.state.state === 'silent' ? 'own' : 'overridden') : item.raw.basis;
  }
  if (answer.basis === 'overridden') {
    const prior = item.raw as JsonObject;
    const inherited = prior.basis === 'inherited'
      ? prior
      : prior.overrides === undefined
        ? asArray(item.record.history).filter(isObject).reverse().find(candidate => candidate.basis === 'inherited')
        : undefined;
    if (inherited !== undefined) {
      const from = isObject(inherited.from) ? inherited.from : {};
      const source = collection !== null && typeof from.question === 'string' ? collectionAnswer(collection, from.question) : undefined;
      answer.overrides = {
        collection: from.collection ?? null,
        question: from.question ?? null,
        collection_answer_at: isObject(source) ? source.at ?? null : null,
      };
    } else if (prior.overrides !== undefined) {
      answer.overrides = structuredClone(prior.overrides);
    }
    answer.why_verbatim = null;
    if (options.whyFile) {
      try { answer.why_verbatim = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(options.whyFile)); }
      catch { refuse('OVERRIDE_REASON_MISSING', `${item.path}: --why-file must be readable UTF-8`); }
    }
    const findings = overrideFindings(answer, collection, item.path);
    if (findings[0]) refuse(findings[0].code, findings[0].message);
  } else if (options.whyFile) {
    refuse('INTERVIEW_OPTIONS_USAGE', '--why-file applies only to a member override', USAGE_EXIT);
  }
  if (projected.autos.length || projected.pending.length) {
    answer.refusal_baseline = [...baselineOf(checkProject(dir, project, { now }))].map(([key, count]) => {
      const [code, path] = JSON.parse(key) as [string, string];
      return { code, path, count };
    });
  }
  validateChoice(dir, project, item, answer);
  if (isObject(item.raw)) {
    const prior = [item.raw];
    if (item.raw.basis === 'inherited' && (item.state.state === 'user' || item.state.state === 'delegated')) {
      prior.push(structuredClone(item.state.answer));
    }
    item.record.history = [...asArray(item.record.history), ...prior];
  }
  item.record[item.kind === 'framing' ? 'answer' : 'guide'] = answer;
  delete item.record.pending_options;
  const route = interviewFeedbackRoute(act);
  const receipt: JsonObject = {
    schema: 'rig-create/review-act@1',
    kind: 'interview-picks',
    jobId: act.jobId,
    actId: act.actId,
    question: act.value.questionId,
    bytes,
    sha256: jobHash(bytes),
    version_hash: jobHash(JSON.stringify(choice)),
    ...(options.routeComments !== false && route ? { feedback_route: route } : {}),
  };
  project.review_acts = [...asArray(project.review_acts), receipt];
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  return { receipt, answer, json: JSON.stringify(answer) };
}

/** Seed a historical interview-picks answer and its review_acts[] receipt for check/reader tests. */
export function seedStoredInterviewPicks(
  dir: string,
  actInput: JsonObject | string,
  options: SeedInterviewPicksOptions = {},
): JsonObject {
  return seedStoredInterviewPicksInternal(dir, actInput, options).receipt;
}

/** Seed a historical interview-picks answer and return the serialized answer record JSON. */
export function seedStoredInterviewPicksAnswer(
  dir: string,
  actInput: JsonObject | string,
  options: SeedInterviewPicksOptions = {},
): string {
  return seedStoredInterviewPicksInternal(dir, actInput, options).json;
}

/** Seed a historical signoff act and its review_acts[] receipt for check/reader tests. */
export function seedStoredSignoffAct(
  dir: string,
  stage: string,
  actInput: JsonObject | string,
  options: { now?: number; draftId?: string; structureFile?: string; version?: string; checkProjectHash?: boolean } = {},
): JsonObject {
  const bytes = typeof actInput === 'string' ? actInput : JSON.stringify(actInput);
  const act = decodeReviewAct(bytes, 'signoff');
  if (act.value.stage !== stage) {
    refuse('REVIEW_ACT_INVALID', `project.json.review_acts: signoff act stage ${act.value.stage} differs from ${stage}`);
  }
  const projectPath = join(dir, 'project.json');
  const rawBytes = readFileSync(projectPath);
  const project = JSON.parse(rawBytes.toString('utf8')) as JsonObject;
  const existing = asArray(project.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === act.actId);
  if (existing) {
    if (existing.kind !== 'signoff' || existing.bytes !== bytes || existing.sha256 !== jobHash(bytes)) {
      refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: signoff act replay bytes differ');
    }
    const ledgerFindings = reviewActFindings(project);
    if (ledgerFindings[0]) refuse(ledgerFindings[0].code, ledgerFindings[0].message);
    const source = `review act ${act.jobId}/${act.actId}`;
    return asArray(project.signoffs).filter(isObject).find(row => row.source === source)!;
  }
  const by = reviewActBy(act);
  if (agentUnderOwner(act) || by.trim().toLowerCase() === 'agent') {
    refuse('SIGNOFF_NOT_HUMAN', 'project.json.signoffs: signoff must be by a human reviewer');
  }
  const now = options.now ?? Date.now();
  if (options.checkProjectHash && !matchesActProjectSource(act, rawBytes)) {
    refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: projectHash changed');
  }
  assertActSubjectDeclared(dir, act, 'project.json.review_acts');
  if (['interview', 'plan-approved', 'rigging-interview', 'post-interview'].includes(stage)) {
    assertPlanSignoffCandidate(dir, project, stage, now);
    const items = collectItems(project, { collection: loadCollection(dir, project) });
    const stageMap: Record<string, string> = { 'plan-approved': 'interview' };
    const reaskStage = stageMap[stage] ?? stage;
    const pendingReask = items.find(candidate => {
      const itemStage = candidate.kind === 'post' ? 'post-interview'
        : ['bones', 'meshes', 'constraints', 'turn', 'motion'].includes(candidate.id) ? 'rigging-interview' : 'interview';
      return itemStage === reaskStage && isObject(candidate.record.pending_options);
    });
    if (pendingReask) refuse('SIGNOFF_REASK_PENDING', `${pendingReask.path}: pending re-ask must be answered before signing ${stage}`);
  }
  const signoff: JsonObject = reviewActSignoff(act, by);
  let extraReceipt: JsonObject = {};
  if (stage === 'parts-review') {
    const draftId = options.draftId ?? (isObject(act.source.selector) && act.source.selector.kind === 'draft' ? String(act.source.selector.id) : '');
    const latestProblem = latestPartsVerdictFinding(project, draftId, 'signoffs.parts-review.evidence');
    if (latestProblem) refuse(latestProblem.code, latestProblem.message);
    const verdict = recordedPartsVerdict(dir, project, draftId);
    const structurePath = options.structureFile ?? `evidence/structure-${draftId}.json`;
    const structure = { path: structurePath, sha256: jobHash(readFileSync(join(dir, structurePath))) };
    const errors: Finding[] = [];
    checkStructure(dir, project, { draft_id: draftId, structure }, `signoffs[${asArray(project.signoffs).length}].structure`, errors);
    if (errors[0]) refuse(errors[0].code, errors[0].message);
    signoff.draft_id = draftId;
    signoff.evidence = verdict.evidence;
    signoff.structure = structure;
  } else if (stage in SIGNOFF_TARGET_KINDS) {
    const recordDir = isRecordDirectionSignoff(act);
    const shown = recordDir ? recordSignoffActVersion(act, rawBytes.toString('utf8')) : signoffActVersion(act);
    if (shown === null) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: signoff target version could not be resolved');
    if (options.version !== undefined && Number(options.version) !== shown) {
      refuse('REVIEW_ACT_TARGET_MISMATCH', `project.json.signoffs: --version ${options.version} differs from act target v${shown}`);
    }
    const target = selectSignoffTarget(dir, project, stage as 'rig-review' | 'direction-review', String(shown));
    if (!target) throw Error(`Missing signoff target for ${stage} v${shown}`);
    signoff.target = target;
    if (recordDir) {
      extraReceipt = { record_sha256: act.source.projectHash, target_version: target.version, verdict: target.verdict };
    }
  }
  const answerHashes = selectAnswerHashes(dir, project, signoff);
  if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
  const candidate = structuredClone(project);
  candidate.signoffs = [...asArray(candidate.signoffs), signoff];
  const receipt: JsonObject = {
    schema: 'rig-create/review-act@1',
    kind: 'signoff',
    jobId: act.jobId,
    actId: act.actId,
    stage,
    bytes,
    sha256: jobHash(bytes),
    version_hash: jobHash(JSON.stringify(signoffActIdentity(act))),
    ...extraReceipt,
  };
  candidate.review_acts = [...asArray(candidate.review_acts), receipt];
  const beforeReport = checkProject(dir, project, { now });
  const afterReport = checkProject(dir, candidate, { now });
  const added = newFindings(baselineOf(beforeReport), afterReport.refusals);
  if (added[0]) refuse(added[0].code, added[0].message);
  writeFileSync(projectPath, `${JSON.stringify(candidate, null, 2)}\n`);
  return signoff;
}

/** Seed a historical parts-verdict act, evidence file, receipt, and optional folded parts-review signoff. */
export function seedStoredPartsVerdictAct(
  dir: string,
  actInput: JsonObject | string,
  options: {
    now?: number;
    foldSignoff?: boolean;
    structureFile?: string;
    checkProjectHash?: boolean;
    checkAck?: boolean;
    checkArrival?: boolean;
    afterEvidence?: (path: string) => void;
  } = {},
): {
  receipt: JsonObject;
  signoff?: JsonObject;
  verbatim: string;
  by: string;
  verdict: string;
  draft_id: string;
  evidence: { path: string; sha256: string };
  warnings?: string[];
} {
  const bytes = typeof actInput === 'string' ? actInput : JSON.stringify(actInput);
  const act = decodeReviewAct(bytes, 'parts-verdict');
  const projectPath = join(dir, 'project.json');
  const rawBytes = readFileSync(projectPath);
  const project = JSON.parse(rawBytes.toString('utf8')) as JsonObject;
  const sha = jobHash(bytes);
  const evidencePath = `evidence/review-acts/${jobHash(JSON.stringify([act.jobId, act.actId]))}.json`;
  const by = reviewActBy(act);
  const verbatim = reviewActVerbatim(act);
  const draftId = act.source.selector.id;
  const existing = asArray(project.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === act.actId);
  if (existing) {
    if (existing.kind !== 'parts-verdict' || existing.bytes !== bytes || existing.sha256 !== sha) {
      refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: parts-verdict replay bytes differ');
    }
    assertPartsActSource(dir, project, act);
    const ledgerFindings = reviewActFindings(project);
    if (ledgerFindings[0]) refuse(ledgerFindings[0].code, ledgerFindings[0].message);
    return { receipt: existing, verbatim, by, verdict: act.value.verdict, draft_id: draftId, evidence: { path: evidencePath, sha256: sha } };
  }
  if (agentUnderOwner(act) || by.trim().toLowerCase() === 'agent') {
    refuse('SIGNOFF_NOT_HUMAN', 'project.json.review_acts: parts verdict must be by a human reviewer');
  }
  const warnings: string[] = [];
  if (options.checkAck) {
    const ack = readAcknowledgedPublication(dir, act.jobId, act.publicationId);
    if (!ack) {
      warnings.push('REVIEW_ACT_VERSION_UNVERIFIED: project.json.review_acts: acknowledged publication receipt is missing');
    } else if (isRiggingDraftAct(act)) {
      if (!ack.draftSource || ack.draftSource.sourceHash !== act.source.sourceHash || ack.draftSource.projectHash !== act.source.projectHash) {
        refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: rigging draft publication source binding is missing or stale');
      }
    }
  }
  const now = options.now ?? Date.now();
  const amendment = currentPartsAmendment(project, now);
  if (amendment && Date.parse(act.at) <= amendment.at) {
    refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: parts verdict predates the current owner amendment');
  }
  assertPartsActSource(dir, project, act);
  const shouldFold = act.value.verdict === 'approved' && !isRiggingDraftAct(act) && options.foldSignoff !== false;
  const beforeReport = shouldFold ? checkProject(dir, project, { now }) : undefined;
  const fullEvidencePath = join(dir, evidencePath);
  const hadEvidence = existsSync(fullEvidencePath);
  if (hadEvidence) {
    if (readFileSync(fullEvidencePath, 'utf8') !== bytes) {
      refuse('PARTS_REVIEW_EVIDENCE_CONFLICT', `${evidencePath}: existing evidence file differs from act ${act.actId}`);
    }
  } else {
    mkdirSync(dirname(fullEvidencePath), { recursive: true });
    writeFileSync(fullEvidencePath, bytes);
  }
  try {
    options.afterEvidence?.(fullEvidencePath);
    if (shouldFold && options.checkProjectHash && !matchesActProjectSource(act, readFileSync(projectPath))) {
      refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: projectHash changed');
    }
    const candidate = structuredClone(project);
    let signoff: JsonObject | undefined;
    if (shouldFold) {
      if (options.checkArrival) {
        const arrival = asArray(project.advances).filter(isObject).filter(move => move.stage === 'parts-review').at(-1);
        if (project.stage !== 'parts-review' || beforeReport!.effective_stage !== 'parts-review' || !arrival) {
          refuse('PARTS_REVIEW_FOLD_NOT_READY', 'project.json.stage: advance to parts-review before folding an approved parts verdict');
        }
        const arrivalAt = Date.parse(String(arrival.at));
        const diffAt = isObject(project.diff_map) ? Date.parse(String(project.diff_map.at)) : NaN;
        if (Date.parse(act.at) < arrivalAt || (Number.isFinite(diffAt) && Date.parse(act.at) < diffAt)) {
          refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: approval predates parts-review arrival or diff_map');
        }
      }
      const structurePath = options.structureFile ?? `evidence/structure-${draftId}.json`;
      let structureBytes: Buffer;
      try { structureBytes = readFileSync(join(dir, structurePath)); }
      catch { refuse('STRUCTURE_DECISIONS_MISSING', `signoffs[${asArray(candidate.signoffs).length}].structure: ${structurePath} is missing`); }
      const structure = { path: structurePath, sha256: jobHash(structureBytes!) };
      const errors: Finding[] = [];
      checkStructure(dir, candidate, { draft_id: draftId, structure }, `signoffs[${asArray(candidate.signoffs).length}].structure`, errors);
      if (errors[0]) refuse(errors[0].code, errors[0].message);
      signoff = {
        stage: 'parts-review',
        checkpoint: null,
        by,
        at: act.at,
        verbatim,
        source: `review act ${act.jobId}/${act.actId}`,
        evidence: { kind: 'parts-verdict', path: evidencePath, sha256: sha, spec: act.schema },
        draft_id: draftId,
        structure,
      };
      const answerHashes = selectAnswerHashes(dir, candidate, signoff);
      if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
      const diffErrors: Finding[] = [];
      checkDiffMap(dir, signoff, `signoffs[${asArray(candidate.signoffs).length}]`, join(dir, act.source.parts.manifest.path), diffErrors, [], candidate);
      if (diffErrors[0]) refuse(diffErrors[0].code, diffErrors[0].message);
      candidate.signoffs = [...asArray(candidate.signoffs), signoff];
    }
    const receipt: JsonObject = {
      schema: 'rig-create/review-act@1',
      kind: 'parts-verdict',
      jobId: act.jobId,
      actId: act.actId,
      draft_id: draftId,
      version_hash: partsActDraftHash(project, act),
      bytes,
      sha256: sha,
      evidence: { path: evidencePath, sha256: sha },
      ...(signoff ? { signoff: asArray(candidate.signoffs).length - 1 } : {}),
    };
    candidate.review_acts = [...asArray(candidate.review_acts), receipt];
    if (signoff) {
      const afterReport = checkProject(dir, candidate, { now });
      const added = newFindings(baselineOf(beforeReport!), afterReport.refusals);
      if (added[0]) refuse(added[0].code, added[0].message);
    }
    writeFileSync(projectPath, `${JSON.stringify(candidate, null, 2)}\n`);
    return {
      receipt,
      signoff,
      verbatim,
      by,
      verdict: act.value.verdict,
      draft_id: draftId,
      evidence: { path: evidencePath, sha256: sha },
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    if (!hadEvidence) rmSync(fullEvidencePath, { force: true });
    throw error;
  }
}

/** Seed a historical numbered review-verdict act, sidecar file, verdict row, receipt, and optional folded rig signoff. */
export function seedStoredReviewVerdictAct(
  dir: string,
  n: number,
  actInput: JsonObject | string,
  options: { now?: number; foldSignoff?: boolean; bustConfigPath?: string; checkAck?: boolean; checkProjectHash?: boolean } = {},
): {
  receipt: JsonObject;
  verdict: JsonObject;
  signoff?: JsonObject;
  warnings?: string[];
  bust_landmark_commands?: [string, string];
} {
  const bytes = typeof actInput === 'string' ? actInput : JSON.stringify(actInput);
  const act = decodeReviewAct(bytes);
  if (options.bustConfigPath !== undefined && act.schema !== JOB_CHEST_LANDMARKS_ACT_SCHEMA) {
    refuse('REVIEW_OPTION_INVALID', 'review: --config applies only to a chest landmark verdict', USAGE_EXIT);
  }
  const projectPath = join(dir, 'project.json');
  const rawBytes = readFileSync(projectPath);
  const project = JSON.parse(rawBytes.toString('utf8')) as JsonObject;
  const sha = jobHash(bytes);
  const existing = asArray(project.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === act.actId);
  if (existing) {
    if (existing.bytes !== bytes || existing.sha256 !== sha) {
      refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: review-verdict replay bytes differ');
    }
    assertReviewActSource(dir, project, act);
    if (reviewActVersionHash(project, act, Number(existing.verdict)) !== existing.version_hash) {
      refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: version metadata changed since first ingest');
    }
    const ledgerFindings = reviewActFindings(project);
    if (ledgerFindings[0]) refuse(ledgerFindings[0].code, ledgerFindings[0].message);
    const version = asArray(project.versions).filter(isObject).find(row => row.n === n)!;
    const verdict = asArray(version.verdicts)[Number(existing.verdict)] as JsonObject;
    if (isObject(existing.bust_config)) {
      const recordedPath = String(existing.bust_config.path);
      if (options.bustConfigPath !== undefined && options.bustConfigPath !== recordedPath) {
        refuse('REVIEW_OPTION_INVALID', 'review: --config differs from recorded bust_config path', USAGE_EXIT);
      }
      const replayWarnings: string[] = [];
      let currentSha: string | undefined;
      try { currentSha = jobHash(readFileSync(join(dir, recordedPath))); } catch { /* bustLandmarkCommands validates path */ }
      if (currentSha !== existing.bust_config.sha256) {
        replayWarnings.push(`REVIEW_ACT_BUST_REPLAY: ${recordedPath} changed after first ingest; commands retain the recorded working path`);
      }
      const bust_landmark_commands = bustLandmarkCommands(dir, project, version, recordedPath, sha, true);
      return {
        receipt: existing,
        verdict,
        bust_landmark_commands,
        ...(replayWarnings.length ? { warnings: replayWarnings } : {}),
      };
    }
    return { receipt: existing, verdict };
  }
  const by = reviewActBy(act);
  if (agentUnderOwner(act) || by.trim().toLowerCase() === 'agent') {
    refuse('REVIEW_NOT_HUMAN', 'project.json.versions.verdicts: review verdict must be by a human reviewer');
  }
  const now = options.now ?? Date.now();
  if (Date.parse(act.at) > now) {
    refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: act timestamp is in the future');
  }
  if (options.checkProjectHash && !matchesActProjectSource(act, rawBytes)) {
    refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: projectHash changed');
  }
  if (!('version' in act.source.selector!) || act.source.selector.version !== n) {
    refuse('REVIEW_ACT_SOURCE_STALE', `project.json.review_acts: act targets version ${JSON.stringify(act.source.selector)} instead of v${n}`);
  }
  let bustBinding: { path: string; sha256: string } | undefined;
  let commands: [string, string] | undefined;
  if (act.schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA) {
    if (!options.bustConfigPath) refuse('REVIEW_OPTION_MISSING', 'review: chest landmark verdict requires --config <working config>', USAGE_EXIT);
    const rigRow = asArray(project.versions).filter(isObject).find(row => row.n === n && row.kind === 'rig');
    if (!rigRow) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.versions: reviewed rig version is absent');
    bustBinding = prepareBustConfig(dir, rigRow, act, options.bustConfigPath, fetchBustPublicationSeeds(dir, act));
    assertReviewActSource(dir, project, act);
    commands = bustLandmarkCommands(dir, project, rigRow, options.bustConfigPath, sha);
  } else {
    assertReviewActSource(dir, project, act);
  }
  const warnings: string[] = [];
  if (options.checkAck) {
    const pubWarning = reviewActPublicationWarning(dir, project, act);
    if (pubWarning) warnings.push(pubWarning);
  }
  const ack = readAcknowledgedPublication(dir, act.jobId, act.publicationId);
  const canFoldRigSignoff = Boolean(options.foldSignoff)
    && Array.isArray(ack?.subjects)
    && ack.subjects.some(s => s.kind === 'review-verdict' && s.stage === 'rig-review')
    && !ack.subjects.some(s => s.kind === 'signoff' && s.stage === 'rig-review')
    && act.value.stage === 'rig-review'
    && act.value.verdict === 'approved';
  let foldBaseline: ReturnType<typeof checkProject> | undefined;
  if (canFoldRigSignoff) {
    if (!matchesActProjectSource(act, rawBytes)) {
      refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: rig approval predates the current record');
    }
    foldBaseline = checkProject(dir, project, { now });
    if (!rigVerdictIngestible(foldBaseline.effective_stage)) {
      refuse('REVIEW_ACT_TARGET_MISMATCH', 'project.json.stage: this rig approval requires effective rig-review');
    }
  }
  const candidate = structuredClone(project);
  const versionIndex = asArray(candidate.versions).findIndex(row => isObject(row) && row.n === n);
  if (versionIndex < 0) throw Error(`Missing version ${n}`);
  const version = asArray(candidate.versions)[versionIndex] as JsonObject;
  const created: string[] = [];
  let discardMesh: (() => void) | undefined;
  let committed = false;
  try {
    const verdictIndex = asArray(version.verdicts).length;
    const verdict = reviewActVerdict(act, by);
    version.verdicts = [...asArray(version.verdicts), verdict];
    if (verdict.verdict === 'accepted') {
      assertDirectionApproval(dir, candidate, String(verdict.review), now, n);
      assertCorrectionApproval(dir, candidate, String(verdict.review), now);
    }
    const receipt: JsonObject = {
      schema: 'rig-create/review-act@1',
      jobId: act.jobId,
      actId: act.actId,
      version: n,
      verdict: verdictIndex,
      version_hash: reviewActVersionHash(project, act),
      bytes,
      sha256: sha,
      ...(bustBinding ? { bust_config: bustBinding } : {}),
    };
    candidate.review_acts = [...asArray(candidate.review_acts), receipt];
    let signoff: JsonObject | undefined;
    if (canFoldRigSignoff) {
      if (!Array.isArray(candidate.signoffs)) refuse('SIGNOFF_MALFORMED', 'project.json.signoffs: expected a list');
      const createdSignoff: JsonObject = rigVerdictSignoff(act, by);
      assertDirectionApproval(dir, candidate, 'rig-review', now);
      assertCorrectionApproval(dir, candidate, 'rig-review', now, createdSignoff);
      assertHistoricalRigReviewSignable(candidate, `signoffs[${candidate.signoffs.length}]`);
      createdSignoff.target = selectSignoffTarget(dir, candidate, 'rig-review', String(n))!;
      const answerHashes = selectAnswerHashes(dir, candidate, createdSignoff);
      if (answerHashes !== undefined) createdSignoff.answer_hashes = answerHashes;
      receipt.signoff = candidate.signoffs.length;
      candidate.signoffs.push(createdSignoff);
      const pair = signoffPairFinding(candidate, createdSignoff, `signoffs[${candidate.signoffs.length - 1}]`, true);
      if (pair) refuse(pair.code, pair.message);
      signoff = createdSignoff;
    }
    const meshAct = meshReviewVerdict(act);
    if (meshAct) {
      discardMesh = stageReviewMeshDeltaCorrections(dir, project, candidate, meshAct, now);
    }
    const ledgerProblem = reviewActFindings(candidate)[0];
    if (ledgerProblem) refuse(ledgerProblem.code, ledgerProblem.message);
    if (signoff || discardMesh) {
      const beforeReport = foldBaseline ?? checkProject(dir, project, { now });
      const afterReport = checkProject(dir, candidate, { now });
      const added = newFindings(baselineOf(beforeReport), afterReport.refusals);
      if (added[0]) refuse(added[0].code, added[0].message);
    }
    assertReviewActSource(dir, project, act);
    if (act.value.stage === 'rig-review') {
      retainReviewSidecar(dir, { path: retainedRigActPath(n, sha), bytes: Buffer.from(bytes) }, created, 'version');
    }
    if (!readFileSync(projectPath).equals(rawBytes)) {
      refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during verdict validation; retry against the current record');
    }
    writeFileSync(projectPath, `${JSON.stringify(candidate, null, 2)}\n`);
    committed = true;
    return {
      receipt,
      verdict,
      ...(signoff ? { signoff } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(commands ? { bust_landmark_commands: commands } : {}),
    };
  } finally {
    if (!committed) discardReviewActOutputs(created, discardMesh);
  }
}
