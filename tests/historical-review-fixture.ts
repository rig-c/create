import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  JOB_COMMENTS_ACT_SCHEMA, JOB_RECORD_ACT_SCHEMA, parseCommentsAct, parseRecordAct,
  type JobActV3, type JobComment, type JobOwnerHost, type JobRetainedSourceV3, type JobReviewerBinding,
  type JobSourceV3, type RecordCheckpointSubject,
} from '@rig-c/review/job-host';
import { asArray, collectItems, isObject, loadCollection, type Finding } from '../src/check.ts';
import { CHOICE_SPEC, choiceVerbatim, optionFile, selection } from '../src/choices.ts';
import { INTAKE_QUESTION, intakeItem } from '../src/intake.ts';
import { jobHash } from '../src/job-outbox.ts';
import { latestPartsVerdictFinding, recordedPartsVerdict } from '../src/parts-verdict-record.ts';
import { refuse } from '../src/refusal.ts';
import { decodeReviewAct, interviewFeedbackRoute, reviewActBy } from '../src/review-act.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import { selectSignoffTarget } from '../src/signoff-target.ts';
import { checkStructure } from '../src/structure.ts';
import type { JsonObject } from '../src/templates.ts';

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
  options: { by?: string; at?: string | number; verbatim: string; structureFile?: string; source?: string },
): JsonObject {
  const projectPath = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
  const at = isoOf(options.at);
  const latestProblem = latestPartsVerdictFinding(project, draftId, 'signoffs.parts-review.evidence');
  if (latestProblem) refuse(latestProblem.code, latestProblem.message);
  const verdict = recordedPartsVerdict(dir, project, draftId);
  const structurePath = options.structureFile ?? `evidence/structure-${draftId}.json`;
  const structureBytes = readFileSync(join(dir, structurePath));
  const structure = { path: structurePath, sha256: jobHash(structureBytes) };
  const errors: Finding[] = [];
  checkStructure(dir, project, { draft_id: draftId, structure }, `signoffs[${asArray(project.signoffs).length}].structure`, errors);
  if (errors[0]) refuse(errors[0].code, errors[0].message);
  const signoff: JsonObject = {
    stage: 'parts-review',
    checkpoint: null,
    by: options.by ?? 'user',
    at,
    verbatim: options.verbatim,
    draft_id: draftId,
    evidence: verdict.evidence,
    structure,
    ...(options.source === undefined ? {} : { source: options.source }),
  };
  const answerHashes = selectAnswerHashes(dir, project, signoff);
  if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
  project.signoffs = [...asArray(project.signoffs), signoff];
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  return signoff;
}

/** Seed a historical interview-picks answer and its review_acts[] receipt for check/reader tests. */
export function seedStoredInterviewPicks(
  dir: string,
  actInput: JsonObject | string,
  options: { routeComments?: boolean } = {},
): JsonObject {
  const bytes = typeof actInput === 'string' ? actInput : JSON.stringify(actInput);
  const act = decodeReviewAct(bytes, 'interview-picks');
  const projectPath = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
  const item = act.value.questionId === INTAKE_QUESTION
    ? intakeItem(project)
    : collectItems(project, { collection: loadCollection(dir, project) }).find(candidate => candidate.id === act.value.questionId);
  if (!item) throw Error(`Unknown interview question ${act.value.questionId}`);
  const sourceFile = 'optionSetFile' in act.source && act.source.optionSetFile ? act.source.optionSetFile : undefined;
  const pending = isObject(item.record.pending_options) ? item.record.pending_options : undefined;
  const setBinding = sourceFile
    ? { path: sourceFile.path, sha256: sourceFile.sha256 }
    : pending
      ? { path: String(pending.path), sha256: String(pending.sha256) }
      : undefined;
  if (!setBinding) throw Error(`Missing option set file binding for ${act.value.questionId}`);
  const { set } = optionFile(dir, setBinding);
  const picks: JsonObject[] = act.value.selections.map(sel => {
    const ask = asArray(set.asks).filter(isObject).find(candidate => candidate.id === sel.itemId);
    const option = ask ? asArray(ask.options).filter(isObject).find(candidate => candidate.id === sel.optionId) : undefined;
    if (!ask || !option) throw Error(`Missing option ${sel.itemId}=${sel.optionId}`);
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
    ...(act.value.note ? { note: act.value.note } : {}),
  };
  const projected = selection(set, choice);
  const by = reviewActBy(act);
  const answer: JsonObject = {
    delegated: projected.delegated,
    by,
    at: act.at,
    verbatim: choiceVerbatim(picks, choice.note),
    source: 'review questionnaire',
    asks: projected.asks,
    ...(projected.value === undefined ? {} : { value: projected.value }),
    choice,
    ...(projected.autos.length ? { agent_decision: { covers: projected.autos.join(',') } } : {}),
  };
  if (isObject(item.raw)) item.record.history = [...asArray(item.record.history), item.raw];
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
  return receipt;
}
