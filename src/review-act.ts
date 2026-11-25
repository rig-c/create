import { OWNER_CHAT_SOURCE, ownerChatFinding } from './owner-chat.ts';
import { PARTS_CLI_RECEIPT, partsReceiptDraftId } from './parts-verdict-record.ts';
/** Finalized semantic acts. This reader never opens Review's private state. */
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from './check-reads.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobRuntimeExecArgv } from './job-writer.ts';
import { isDeepStrictEqual } from 'node:util';
import { JOB_CHEST_LANDMARKS_ACT_SCHEMA, JOB_COMMENT_CONTEXT_ACT_SCHEMA, JOB_COMMENT_ONLY_ACT_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, JOB_MESH_EDITS_ACT_SCHEMA, JOB_RECORD_ACT_SCHEMA,
  parseChestLandmarksAct, parseCommentOnlyAct, parseCommentsAct, parseContextCommentsAct, parseMeshEditsAct, parseRecordAct, projectComments,
  type JobAct, type JobChestLandmarksAct, type JobCommentPartsAnchor, type JobCommentsAct, type JobContextCommentsAct, type JobMeshEdit, type JobMeshEditsAct,
  type JobModelSourceBinding, type JobOptionSource, type JobPublishedChestLandmark, type JobRigStill, type RecordAct } from '@rig-c/review/job-host';
import { DIRECTION_COMPOSE_SPEC } from './direction-compose.ts';
import { assembleOnlyDraftPath, assembleOnlyDraftTarget, assembleOnlyVersionFinding, assertDraftHasRig } from './draft-layout.ts';
import { PICK_SIGNOFF_STAGES } from './stages.ts';
import { isRiggingDraftAct, partsCarryAmendment } from './parts-act.ts';
import { jobHash, publicationVersionHash, readAcknowledgedPublication, readWriterBinding, type AcknowledgedPublication } from './job-outbox.ts';
import { compiledDraftManifestBytes, composedPublishedBuildFiles, draftPackageIdentity, draftPublishedContext, eligibleRigDraftModel, liveManifestPath, publicationFile, publishedSourcePainting } from './job-publication.ts';
import { DRAFT_ID } from './draft-reuse.ts';
import { bustConfigPath, frozenBustConfigHash, type BustWorkingConfig } from './review-bust.ts';
import { Refusal, refuse } from './refusal.ts';
import { INTAKE_QUESTION, intakeItem } from './intake.ts';
import { collectItems, asArray, isObject, type Finding } from './check.ts';
import { stepHash } from './step-hash.ts';
import { recordDirectionTarget } from './record-direction-target.ts';
import { outputsHash, reviewPackageHash } from './signoff-target.ts';
import { commentEntryFinding, commentSource, type CommentOnlyAct } from './comment-record.ts';
import type { Json, JsonObject } from './templates.ts';

export type PartsIssue = {
  readonly id: string;
  readonly summary: string;
  readonly parts: readonly { readonly name: string; readonly imageHash: string }[];
  readonly sourceHash: string;
  readonly rigRegion: JsonObject | JobCommentPartsAnchor['rigRegion'];
  readonly imageRegion: JsonObject | JobCommentPartsAnchor['imageRegion'] | null;
  readonly view: JsonObject | JobCommentPartsAnchor['view'];
  readonly crop: JsonObject | JobCommentPartsAnchor['crop'];
  readonly nativeCrop: JsonObject | JobCommentPartsAnchor['nativeCrop'] | null;
};
/** The older scalar verdicts retain their original source adapters. */
type LegacyJobAct = Exclude<JobAct, { schema: CommentAct['schema'] | typeof JOB_MESH_EDITS_ACT_SCHEMA | typeof JOB_CHEST_LANDMARKS_ACT_SCHEMA | typeof JOB_COMMENT_ONLY_ACT_SCHEMA }>;
type CommentAct = JobCommentsAct | JobContextCommentsAct;
export type ReopenAct = Extract<RecordAct, { kind: 'reopen' }>;
export type ReviewActKind = 'review-verdict' | 'parts-verdict' | 'interview-picks' | 'checkpoint' | 'signoff' | 'reopen' | 'comments';
export type DecodedReviewAct = ReviewVerdictAct | PartsVerdictAct | InterviewPicksAct | CheckpointAct | SignoffAct | ReopenAct | CommentOnlyAct;
export type { CommentOnlyAct };
/** act@6 picks: the survey value plus ordered owner comments (Review #646). */
type CommentsPicksAct = Extract<JobCommentsAct, { kind: 'interview-picks' }>;
export type InterviewPicksAct = Extract<LegacyJobAct | RecordAct, { kind: 'interview-picks' }> | CommentsPicksAct;
/** Record-route picks: act@4, or act@6 on the same option-set record source. */
export function isRecordPicksAct<Act extends { readonly schema: string; readonly kind: string; readonly source: object }>(act: Act):
  act is Act & { readonly kind: 'interview-picks'; readonly source: JobOptionSource } {
  return act.kind === 'interview-picks' && (act.schema === JOB_RECORD_ACT_SCHEMA || act.schema === JOB_COMMENTS_ACT_SCHEMA && 'record' in act.source);
}
/** Owner comments an act@6 answer carries. Older picks carry only the survey value. */
export function picksActComments(act: InterviewPicksAct): CommentsPicksAct['value']['comments'] {
  return act.schema === JOB_COMMENTS_ACT_SCHEMA ? act.value.comments : [];
}

/** The interview feedback route is a projection of the decoded receipt, in submitted order. */
export function interviewFeedbackRoute(act: InterviewPicksAct):
  { question: string; comments: { order: number; text: string; anchor?: JsonObject }[] } | undefined {
  const comments = picksActComments(act);
  if (!comments.length) return;
  return {
    question: act.value.questionId,
    comments: comments.map(({ text, anchor }, index) => ({
      order: index + 1,
      text,
      // Keep the full Review anchor in the JSON representation shared with project.json.
      ...(anchor === undefined ? {} : { anchor: JSON.parse(JSON.stringify(anchor)) as JsonObject }),
    })),
  };
}

export interface VerifiedInterviewPick {
  act: InterviewPicksAct;
  path: string;
  answers: readonly JsonObject[];
  route?: NonNullable<ReturnType<typeof interviewFeedbackRoute>>;
}
export type PartsVerdictActV2 = Extract<LegacyJobAct, { kind: 'parts-verdict' }>;
export type PartsVerdictActV5 = Omit<PartsVerdictActV2, 'schema' | 'value'> & {
  readonly schema: 'rig-review/act@5';
  readonly value: {
    readonly verdict: 'approved' | 'changes-requested';
    readonly issues: readonly PartsIssue[];
    readonly words: string;
  };
};
type CommentsPartsVerdictAct = Extract<CommentAct, { kind: 'parts-verdict' }> & { source: PartsVerdictActV2['source'] };
export type PartsVerdictAct = PartsVerdictActV2 | PartsVerdictActV5 | CommentsPartsVerdictAct;
type LegacyReviewVerdictAct = Extract<LegacyJobAct, { kind: 'review-verdict' }> & { source: JobModelSourceBinding };
type CommentsReviewVerdictAct = Extract<CommentAct, { kind: 'review-verdict' }> & {
  source: JobModelSourceBinding; value: { stage: 'rig-review' | 'direction-review' };
};
export type MeshReviewVerdictAct = Extract<JobAct, { schema: typeof JOB_MESH_EDITS_ACT_SCHEMA }>
  & { source: { readonly parts: NonNullable<JobModelSourceBinding['parts']> } };
export type ChestReviewVerdictAct = JobChestLandmarksAct
  & { source: { readonly parts: NonNullable<JobModelSourceBinding['parts']> } };
type DraftVerdictSource = Omit<JobModelSourceBinding, 'selector' | 'model' | 'parts' | 'direction' | 'projectHash'> & {
  selector: { kind: 'draft'; id: string }; model: NonNullable<JobModelSourceBinding['model']>;
  parts: NonNullable<JobModelSourceBinding['parts']>; direction: null; projectHash: string;
};
type WithDraftSource<Act> = Act extends { source: unknown } ? Omit<Act, 'source'> & { source: DraftVerdictSource } : never;
export type DraftMeshVerdictAct = WithDraftSource<MeshReviewVerdictAct>;
export type DraftReviewVerdictAct = WithDraftSource<CommentsReviewVerdictAct> | DraftMeshVerdictAct;
export type ReviewVerdictAct = LegacyReviewVerdictAct | CommentsReviewVerdictAct | MeshReviewVerdictAct | ChestReviewVerdictAct | DraftReviewVerdictAct;
export const isDraftReviewVerdict = (act: ReviewVerdictAct): act is DraftReviewVerdictAct => act.source.selector?.kind === 'draft';
type LegacyCheckpointAct = Extract<LegacyJobAct | RecordAct, { kind: 'checkpoint' }>;
export type CheckpointAct = LegacyCheckpointAct | (Extract<CommentAct, { kind: 'checkpoint' }> & { source: LegacyCheckpointAct['source'] });
type LegacySignoffAct = Extract<LegacyJobAct | RecordAct, { kind: 'signoff' }>;
export type SignoffAct = LegacySignoffAct | (Extract<CommentAct, { kind: 'signoff' }> & { source: LegacySignoffAct['source'] });
/** Review requires a displayed plan before it creates a signoff act for these stages (job-contract JOB_PLAN_BOUND_SIGNOFF_STAGES). */
export const PLAN_BOUND_SIGNOFF_STAGES: readonly string[] = ['plan-approved', 'rigging-interview', 'post-interview'];
/** Interview is plan-bound only on the record route; legacy package acts keep their contract. */
export function isRecordInterviewSignoff(act: SignoffAct): boolean {
  return act.schema === 'rig-review/act@4' && String(act.value.stage) === 'interview';
}
export interface FetchedReviewAct { act: ReviewVerdictAct; bytes: string; stillBytes?: string; bustConfig?: BustWorkingConfig }

/** The existing mesh writer consumes act@8's fields. The original act stays intact in the ledger. */
export function meshReviewVerdict(act: ReviewVerdictAct): MeshReviewVerdictAct | undefined {
  if (isDraftReviewVerdict(act)) return undefined;
  if (act.schema === JOB_MESH_EDITS_ACT_SCHEMA) return act;
  if (act.schema !== JOB_CHEST_LANDMARKS_ACT_SCHEMA || !act.value.meshEdits) return undefined;
  const { chestLandmarks: _, ...value } = act.value;
  return { ...act, schema: JOB_MESH_EDITS_ACT_SCHEMA, value: { ...value, meshEdits: act.value.meshEdits } };
}

/** act@10 mesh carrier, projected onto the fields the mesh writer reads. It carries no verdict (#982). */
export type CommentMeshAct = Omit<CommentOnlyAct, 'source' | 'value'> & {
  readonly source: CommentOnlyAct['source'] & JobModelSourceBinding & {
    readonly selector: { readonly kind: 'rig'; readonly version: number } | { readonly kind: 'draft'; readonly id: string };
    readonly model: NonNullable<JobModelSourceBinding['model']>;
    readonly parts: NonNullable<JobModelSourceBinding['parts']>;
  };
  readonly value: CommentOnlyAct['value'] & { readonly meshEdits: readonly JobMeshEdit[] };
};

/** The mesh-edits carrier of a comment act, or undefined when it has none. The writer refuses an unsupported source. */
export function commentMeshAct(act: CommentOnlyAct): CommentMeshAct | undefined {
  const carrier = act.value.carriers?.find(row => row.kind === 'mesh-edits');
  if (!carrier || carrier.kind !== 'mesh-edits') return undefined;
  return { ...act, value: { ...act.value, meshEdits: carrier.meshEdits } } as unknown as CommentMeshAct;
}

/** The scalar consumed by the existing feedback writers and immutable replay checks. */
export function reviewActVerbatim(act: ReviewVerdictAct | PartsVerdictAct | CheckpointAct | SignoffAct | CommentOnlyAct): string {
  if (!('comments' in act.value)) return act.value.words;
  // The signed scalar projector accepts only text and anchors. The receipt retains the full act.
  return projectComments(act.value.comments.map(({ text, anchor }) => anchor === undefined ? { text } : { text, anchor }));
}

/** A still belongs to the recorded rig verdict, independently of its transport. */
export function reviewActStill(act: ReviewVerdictAct): JobRigStill | null {
  if (act.schema === 'rig-review/act@3' || act.schema === JOB_MESH_EDITS_ACT_SCHEMA || act.schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA) return act.still;
  if ((act.schema === JOB_COMMENTS_ACT_SCHEMA || act.schema === JOB_COMMENT_CONTEXT_ACT_SCHEMA) && act.value.stage === 'rig-review') {
    return act.still ?? failure('REVIEW_ACT_STILL_INVALID', 'comments rig verdict has no recorded still');
  }
  return null;
}

/** Pointed parts evidence stays distinct from the overall verdict's words. */
export function partsActIssues(act: PartsVerdictAct): readonly PartsIssue[] | null {
  if ('comments' in act.value) {
    return act.value.comments.flatMap(comment => comment.anchor && 'schema' in comment.anchor
      ? [{ ...comment.anchor, summary: comment.text }] : []);
  }
  return act.schema === 'rig-review/act@5' ? act.value.issues : null;
}
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
export function isDiscardReceipt(value: unknown): value is JsonObject & { kind: 'discarded' } {
  return object(value) && value.schema === 'rig-create/review-act@1' && value.kind === 'discarded';
}
export function buildDiscardActReceipt(jobId: string, actId: string, evidence: JsonObject): JsonObject {
  return { schema: 'rig-create/review-act@1', kind: 'discarded', jobId, actId, ...evidence };
}

/** Locate token ends in already validated JSON without reserializing the project. */
function recordLedgerOffsets(text: string) {
  let depth = 0;
  let previous = '';
  let end = 0;
  let memberStart = 0;
  let property = '';
  let ledger: { start: number; end: number; entries: number[] } | undefined;
  let readingLedger = false;
  for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}[\],:]|[^\s{}[\],:"]+/g)) {
    const [token] = match;
    if (depth === 1 && (previous === '{' || previous === ',') && token.startsWith('"')) property = JSON.parse(token) as string;
    if (depth === 1 && previous === ':' && property === 'review_acts' && token === '[') {
      ledger = { start: memberStart, end: 0, entries: [match.index + 1] };
      readingLedger = true;
    } else if (depth === 2 && readingLedger && (token === ',' || token === ']')) {
      if (previous !== '[') ledger!.entries.push(end);
      if (token === ']') {
        ledger!.end = match.index + 1;
        readingLedger = false;
      }
    }
    if (depth === 1 && token === '}') return { ledger, lastValueEnd: end, empty: previous === '{' };
    if (token === '[' || token === '{') depth++;
    if (token === ']' || token === '}') depth--;
    // Start an appended member before the comma and after the preceding value.
    if (depth === 1 && token === ',') memberStart = end;
    if (depth === 1 && token === '{') memberStart = match.index + 1;
    end = match.index + token.length;
    previous = token;
  }
  throw new Error('expected a JSON project record');
}

/** Single withdrawal preserves the exact bytes from which pending acts were made. */
export function appendWithdrawalReceipt(original: Buffer, receipt: JsonObject): string {
  const text = original.toString('utf8');
  if (!Buffer.from(text).equals(original)) refuse('REVIEW_ACT_LEDGER_INVALID', 'project.json: record is not valid UTF-8; restore its original record before withdrawing the act');
  const { ledger, lastValueEnd, empty } = recordLedgerOffsets(text);
  const entry = JSON.stringify(receipt, null, 2).replaceAll('\n', '\n    ');
  if (!ledger) {
    return `${text.slice(0, lastValueEnd)}${empty ? '' : ','}\n  "review_acts": [\n    ${entry}\n  ]${text.slice(lastValueEnd)}`;
  }
  const offset = ledger.entries.at(-1)!;
  return `${text.slice(0, offset)}${ledger.entries.length > 1 ? ',' : ''}\n    ${entry}${text.slice(offset)}`;
}

/** Bind the exact source, or undo only a trailing sequence of same-job owner withdrawals. */
export function matchesActProjectSource(act: { jobId: string; source: { projectHash: string | null } }, record: Buffer | string): boolean {
  const { source: { projectHash }, jobId } = act;
  if (projectHash === null) return false;
  if (jobHash(record) === projectHash) return true;
  const text = record.toString();
  if (Buffer.isBuffer(record) && !Buffer.from(text).equals(record)) return false;
  let project: unknown;
  try { project = JSON.parse(text); } catch { return false; }
  if (!object(project) || !Array.isArray(project.review_acts) || project.review_acts.length === 0) return false;
  const entries = project.review_acts;
  const { ledger } = recordLedgerOffsets(text);
  if (!ledger || ledger.entries.length !== entries.length + 1) return false;
  const suffixEnd = ledger.entries[entries.length]!;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isDiscardReceipt(entry) || entry.jobId !== jobId || entry.source !== OWNER_CHAT_SOURCE) return false;
    try { validateDiscardReceipt(entry, `review_acts[${index}]`); } catch { return false; }
    if (jobHash(text.slice(0, ledger.entries[index]!) + text.slice(suffixEnd)) === projectHash) return true;
  }
  // A record that had no ledger can acquire its first one during withdrawal.
  const withoutLedger = text.slice(0, ledger.start) + text.slice(ledger.end);
  if (jobHash(withoutLedger) !== projectHash) return false;
  try {
    const source: unknown = JSON.parse(withoutLedger);
    return object(source) && source.review_acts === undefined;
  } catch { return false; }
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const file = (value: unknown): value is JsonObject => object(value) && typeof value.path === 'string' && sha(value.sha256);
function failure(code: string, detail: string): never {
  refuse(code, `project.json.review_acts: ${detail}; restore the original evidence or request a new act in the live Review job`);
}

/** The shared decoder validates grammar; Create separately admits its existing source adapters. */
function decodeCommentsReviewAct(raw: JsonObject, kind: ReviewActKind): ReviewVerdictAct | PartsVerdictAct | InterviewPicksAct | CheckpointAct | SignoffAct {
  // Review's parsers own the grammar: picks decode at act@6 only, and later versions refuse them.
  let act: CommentAct | JobMeshEditsAct | JobChestLandmarksAct;
  try {
    act = raw.schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA ? parseChestLandmarksAct(raw)
      : raw.schema === JOB_MESH_EDITS_ACT_SCHEMA ? parseMeshEditsAct(raw)
      : raw.schema === JOB_COMMENT_CONTEXT_ACT_SCHEMA ? parseContextCommentsAct(raw) : parseCommentsAct(raw);
  }
  catch { return failure('REVIEW_ACT_INVALID', 'comments act or its declared source binding is malformed'); }
  if (act.kind !== kind) failure('REVIEW_ACT_KIND_MISMATCH', `kind ${act.kind} does not match ${kind}`);
  if (act.schema === JOB_MESH_EDITS_ACT_SCHEMA
    && (act.kind !== 'review-verdict' || !act.value.meshEdits?.length)) {
    failure('REVIEW_ACT_INVALID', 'Review emits act@8 for a rig verdict with mesh edits');
  }
  const source = act.source as unknown as JsonObject;
  if ('record' in source) {
    if (act.kind === 'interview-picks' && source.subject === 'option-set') return act;
    if (act.kind !== 'checkpoint' || source.subject !== 'plan') failure('REVIEW_ACT_KIND_MISMATCH', 'this record-source kind has no Create writer mapping');
    return act as CheckpointAct;
  }
  if (source.subject === 'image-set' || act.kind === 'review-verdict' && act.value.stage === 'image-review') {
    failure('REVIEW_ACT_KIND_MISMATCH', 'image-review has no rig/post writer mapping');
  }
  const parts = source.parts;
  const selector = source.selector;
  const composedPost = act.kind === 'review-verdict' && object(selector) && selector.kind === 'post' && parts === null;
  if (!composedPost) {
    const version = object(parts) && typeof parts.enumeratorVersion === 'string' ? parts.enumeratorVersion : '';
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
    if (!match || !match.slice(1).every(piece => Number.isSafeInteger(Number(piece))) || (Number(match[1]) === 2 ? Number(match[2]) < 25 : Number(match[1]) !== 3)) {
      failure('REVIEW_PARTS_ENUMERATOR_UNSUPPORTED', `parts enumerator ${version || 'absent'} is outside >=2.25.0 <4.0.0`);
    }
  }
  if (!sha(source.projectHash) || !object(source.package) || !id(source.package.id)
    || typeof source.package.revision !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(act.at)) {
    failure('REVIEW_ACT_INVALID', 'comments act lacks the existing package/project identity');
  }
  if (act.kind === 'checkpoint') {
    const plan = source.plan;
    if (!object(plan) || !Array.isArray(plan.steps) || !plan.steps.length
      || !plan.steps.some(step => object(step) && step.id === act.value.planStepId)) {
      failure('REVIEW_ACT_INVALID', 'comments checkpoint has no displayed plan step');
    }
    return act as CheckpointAct;
  }
  if (act.kind === 'signoff') return act as SignoffAct;
  if (act.kind === 'interview-picks') return act;
  if (!composedPost && (!object(parts) || !file(parts.manifest) || !Array.isArray(parts.images)
    || parts.images.some(image => !file(image) || typeof image.role !== 'string'))) {
    failure('REVIEW_ACT_INVALID', 'comments act has no admitted parts binding');
  }
  if (act.kind === 'parts-verdict') {
    if (!object(selector) || selector.kind !== 'draft' || !id(selector.id)) failure('REVIEW_ACT_KIND_MISMATCH', 'parts comments require the existing draft source');
    const issues = partsActIssues(act as CommentsPartsVerdictAct)!;
    if (issues.some(issue => issue.parts.some(part => !((parts as JsonObject).images as Json[]).some(image => object(image)
      && image.role === 'part' && image.path === `parts/${part.name}.png` && image.sha256 === part.imageHash)))) {
      failure('REVIEW_ACT_INVALID', 'comments issue part is outside the bound parts manifest');
    }
    return act as CommentsPartsVerdictAct;
  }
  if (act.kind === 'review-verdict' && object(selector) && selector.kind === 'draft') {
    if (act.schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA) failure('REVIEW_ACT_KIND_MISMATCH', 'chest landmark edits require a live rig version');
    if (act.value.stage !== 'rig-review' || typeof selector.id !== 'string' || !DRAFT_ID.test(selector.id)
      || !file(source.model) || source.direction !== null) {
      failure('REVIEW_ACT_KIND_MISMATCH', 'draft comments verdict needs rig-review, one model and no direction');
    }
    return act as unknown as DraftReviewVerdictAct;
  }
  if (act.kind !== 'review-verdict' || !object(selector) || !['rig', 'post'].includes(String(selector.kind))
    || !Number.isSafeInteger(selector.version) || Number(selector.version) < 1 || !file(source.model)
    || act.value.stage !== (selector.kind === 'rig' ? 'rig-review' : 'direction-review')
    || selector.kind === 'rig' && source.direction !== null
    || selector.kind === 'post' && (!Number.isSafeInteger(selector.rigVersion) || Number(selector.rigVersion) < 1 || !file(source.direction))) {
    failure('REVIEW_ACT_KIND_MISMATCH', 'comments verdict has no existing rig/post source mapping');
  }
  return act as CommentsReviewVerdictAct | MeshReviewVerdictAct | ChestReviewVerdictAct;
}

/** act@10 answers no ask: only the comments route reads it, and that route reads nothing else (#982). */
function decodeCommentOnlyAct(raw: JsonObject, kind: ReviewActKind): CommentOnlyAct {
  if (raw.schema !== JOB_COMMENT_ONLY_ACT_SCHEMA) failure('REVIEW_ACT_SCHEMA_UNSUPPORTED', `act schema ${String(raw.schema)} is not a comment-only act; comments are read from ${JOB_COMMENT_ONLY_ACT_SCHEMA} only`);
  if (kind !== 'comments') failure('REVIEW_ACT_KIND_MISMATCH', `a ${JOB_COMMENT_ONLY_ACT_SCHEMA} act carries comments and answers no ${kind} ask; ingest it with rig-create comment --from-review`);
  let act: CommentOnlyAct;
  try { act = parseCommentOnlyAct(raw); }
  catch { return failure('REVIEW_ACT_INVALID', 'comment-only act or its declared source binding is malformed, or it carries no comment and no carrier'); }
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(act.at)) failure('REVIEW_ACT_INVALID', 'comment-only act time is malformed');
  return act;
}

/** Also used by check on the retained, explicitly encoded act bytes. */
export function decodeReviewAct(bytes: string): ReviewVerdictAct;
export function decodeReviewAct(bytes: string, kind: 'interview-picks'): InterviewPicksAct;
export function decodeReviewAct(bytes: string, kind: 'parts-verdict'): PartsVerdictAct;
export function decodeReviewAct(bytes: string, kind: 'checkpoint'): CheckpointAct;
export function decodeReviewAct(bytes: string, kind: 'signoff'): SignoffAct;
export function decodeReviewAct(bytes: string, kind: 'reopen'): ReopenAct;
export function decodeReviewAct(bytes: string, kind: 'comments'): CommentOnlyAct;
export function decodeReviewAct(bytes: string, kind: ReviewActKind): DecodedReviewAct;
export function decodeReviewAct(bytes: string, kind: ReviewActKind = 'review-verdict'): DecodedReviewAct {
  let act: JsonObject;
  try { const parsed: unknown = JSON.parse(bytes); if (!object(parsed)) throw Error(); act = parsed; }
  catch { return failure('REVIEW_ACT_INVALID', 'act is not a JSON object'); }
  if (kind === 'reopen' && act.schema !== 'rig-review/act@4') failure('REVIEW_ACT_SCHEMA_UNSUPPORTED', 'reopen requires a record act@4');
  if (act.schema === 'rig-review/act@4' && act.kind === 'reopen' && kind !== 'reopen') {
    failure('REVIEW_ACT_KIND_MISMATCH', 'record reopen acts are retained for historical ledger validation');
  }
  if (act.schema === JOB_COMMENT_ONLY_ACT_SCHEMA || kind === 'comments') return decodeCommentOnlyAct(act, kind);
  if (act.schema === JOB_COMMENTS_ACT_SCHEMA || act.schema === JOB_COMMENT_CONTEXT_ACT_SCHEMA
    || act.schema === JOB_MESH_EDITS_ACT_SCHEMA || act.schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA) {
    return decodeCommentsReviewAct(act, kind);
  }
  if (['checkpoint', 'interview-picks', 'signoff', 'reopen'].includes(kind) && act.schema === 'rig-review/act@4') {
    try {
      const recordAct = parseRecordAct(act);
      if (recordAct.kind !== kind) return failure('REVIEW_ACT_KIND_MISMATCH', 'record act kind differs from requested kind');
      return recordAct as CheckpointAct | InterviewPicksAct | SignoffAct | ReopenAct;
    } catch { return failure('REVIEW_ACT_INVALID', 'record act or its sealed source is malformed'); }
  }
  if (act.schema !== 'rig-review/act@2' && !(kind === 'review-verdict' && act.schema === 'rig-review/act@3')
    && !(kind === 'parts-verdict' && act.schema === 'rig-review/act@5')) failure('REVIEW_ACT_SCHEMA_UNSUPPORTED', `act schema ${String(act.schema)} is unsupported, including legacy rig-review/act@1`);
  const source = act.source;
  const parts = object(source) ? source.parts : null;
  const composedPost = kind === 'review-verdict' && act.kind === 'review-verdict'
    && object(source) && object(source.selector) && source.selector.kind === 'post' && source.parts === null;
  const version = object(parts) && typeof parts.enumeratorVersion === 'string' ? parts.enumeratorVersion : '';
  // Only stable releases in the frozen range are accepted. Prereleases are outside it.
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!composedPost && (!match || !match.slice(1).every(piece => Number.isSafeInteger(Number(piece))) || (Number(match[1]) === 2 ? Number(match[2]) < 25 : Number(match[1]) !== 3))) failure('REVIEW_PARTS_ENUMERATOR_UNSUPPORTED', `parts enumerator ${version || 'absent'} is outside >=2.25.0 <4.0.0`);
  if (act.kind !== kind) failure('REVIEW_ACT_KIND_MISMATCH', `kind ${String(act.kind)} does not match ${kind}`);
  const authority = act.authority;
  const reviewer = object(authority) ? authority.reviewer : null;
  const value = act.value;
  if (!id(act.actId) || !id(act.jobId) || !id(act.askId) || !id(act.publicationId)
    || typeof act.at !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(act.at) || !Number.isFinite(Date.parse(act.at))
    || !object(authority) || authority.actor !== 'human' || authority.channel !== 'review-ui'
    || !object(reviewer) || typeof reviewer.id !== 'string' || !reviewer.id.trim() || !['owner', 'delegate'].includes(String(reviewer.role))
    || !object(source) || !sha(source.sourceHash) || !sha(source.projectHash)
    || !object(source.package) || !id(source.package.id) || typeof source.package.revision !== 'string'
    || !object(value) || kind !== 'interview-picks' && kind !== 'checkpoint' && kind !== 'signoff' && (typeof value.words !== 'string' || !['pending', 'approved', 'changes-requested'].includes(String(value.verdict)))) {
    failure('REVIEW_ACT_INVALID', 'act identity, authority, source or verdict is malformed');
  }
  if (kind === 'interview-picks') {
    if (!object(source.optionSet) || !id(source.optionSet.id) || !sha(source.optionSet.sha256)
      || !id(value.questionId) || typeof value.note !== 'string' || !Array.isArray(value.selections)
      || !value.selections.length || value.selections.some(row => !object(row) || !id(row.itemId) || !id(row.optionId)
        || row.otherText !== null && typeof row.otherText !== 'string')
      || new Set(value.selections.map(row => (row as JsonObject).itemId)).size !== value.selections.length) {
      failure('REVIEW_ACT_INVALID', 'interview question, option set or selections are malformed');
    }
    return act as unknown as InterviewPicksAct;
  }
  if (kind === 'checkpoint') {
    // Review copies planStepId from the validated ask; Create derives the stage from its own plan.
    const steps = object(source.plan) && Array.isArray(source.plan.steps) ? source.plan.steps : [];
    if (!steps.length || steps.some(step => !object(step) || !id(step.id) || !sha(step.hash))
      || !id(value.checkpointId) || !id(value.planStepId) || !['pass', 'fail'].includes(String(value.outcome))
      || typeof value.words !== 'string' || !steps.some(step => (step as JsonObject).id === value.planStepId)) {
      failure('REVIEW_ACT_INVALID', 'checkpoint plan, step identity, outcome or words are malformed');
    }
    return act as unknown as CheckpointAct;
  }
  if (kind === 'signoff') {
    // The stage is the writer's to validate; a plan-bound stage carries the displayed step identities.
    const plan = source.plan;
    if (!id(value.stage) || value.decision !== 'approved' || typeof value.words !== 'string'
      || Object.keys(value).some(key => !['stage', 'decision', 'words'].includes(key))
      || plan !== null && plan !== undefined && (!object(plan) || !Array.isArray(plan.steps)
        || plan.steps.some(step => !object(step) || !id(step.id) || !sha(step.hash)))
      || PLAN_BOUND_SIGNOFF_STAGES.includes(value.stage) && (!object(plan) || !Array.isArray(plan.steps) || !plan.steps.length)) {
      failure('REVIEW_ACT_INVALID', 'signoff stage, decision, words or displayed plan is malformed');
    }
    return act as unknown as SignoffAct;
  }
  if (kind === 'parts-verdict') {
    const selector = source.selector;
    if (!object(selector) || selector.kind !== 'draft' || !id(selector.id) || !object(parts) || !file(parts.manifest)
      || !Array.isArray(parts.images) || parts.images.some(row => !file(row) || typeof row.role !== 'string')
      || source.model !== null && !file(source.model) || source.direction !== null && !file(source.direction)
      || source.plan !== null && (!object(source.plan) || !Array.isArray(source.plan.steps)
        || source.plan.steps.some(step => !object(step) || !id(step.id) || !sha(step.hash)))) failure('REVIEW_ACT_INVALID', 'parts verdict source or rows are malformed');
    if (act.schema === 'rig-review/act@5') {
      if (!['approved', 'changes-requested'].includes(String(value.verdict)) || !Array.isArray(value.issues)
        || value.parts !== undefined) failure('REVIEW_ACT_INVALID', 'parts verdict source or issues are malformed');
      const issueIds = new Set<string>();
      for (const issue of value.issues) {
        if (!object(issue) || !id(issue.id) || issueIds.has(issue.id)
          || typeof issue.summary !== 'string' || !issue.summary.trim()
          || !Array.isArray(issue.parts) || !issue.parts.length
          || !sha(issue.sourceHash) || !object(issue.rigRegion)
          || !('imageRegion' in issue) || (issue.imageRegion !== null && !object(issue.imageRegion))
          || !object(issue.view) || !object(issue.crop)
          || !('nativeCrop' in issue) || (issue.nativeCrop !== null && !object(issue.nativeCrop))) {
          failure('REVIEW_ACT_INVALID', 'parts verdict issue is malformed');
        }
        issueIds.add(issue.id);
        const partNames = new Set<string>();
        for (const part of issue.parts) {
          if (!object(part) || !id(part.name) || !sha(part.imageHash) || partNames.has(part.name)
            || !parts.images.some(img => object(img) && img.role === 'part' && img.path === `parts/${part.name}.png` && img.sha256 === part.imageHash)) {
            failure('REVIEW_ACT_INVALID', 'parts verdict issue part is invalid, duplicated or outside the bound parts manifest');
          }
          partNames.add(part.name);
        }
      }
      if ((value.verdict === 'approved') !== (value.issues.length === 0)) failure('REVIEW_ACT_INVALID', 'parts verdict contradicts its issues');
      return act as unknown as PartsVerdictAct;
    }
    if (!Array.isArray(value.parts) || !value.parts.length) failure('REVIEW_ACT_INVALID', 'parts verdict source or rows are malformed');
    const rows = value.parts as JsonObject[];
    const ids = new Set<string>();
    for (const row of rows) {
      if (!object(row) || !id(row.partId) || ids.has(row.partId)) failure('REVIEW_ACT_INVALID', 'part identities are invalid or duplicated');
      ids.add(row.partId);
      for (const outcome of [row.part, row.mesh]) {
        if (!object(outcome) || !['pending', 'clean', 'flagged'].includes(String(outcome.outcome)) || typeof outcome.note !== 'string'
          || outcome.outcome === 'flagged' && !outcome.note.trim()) failure('REVIEW_ACT_INVALID', 'part or mesh outcome is malformed');
      }
    }
    const outcomes = rows.flatMap(row => [(row.part as JsonObject).outcome, (row.mesh as JsonObject).outcome]);
    if (value.verdict === 'approved' && outcomes.some(outcome => outcome !== 'clean')
      || value.verdict === 'changes-requested' && !outcomes.includes('flagged')) failure('REVIEW_ACT_INVALID', 'parts verdict contradicts its outcomes');
    return act as unknown as PartsVerdictAct;
  }
  if (source.subject === 'image-set' || value.stage === 'image-review') failure('REVIEW_ACT_KIND_MISMATCH', 'image-review has no rig/post writer mapping');
  const selector = source.selector;
  if (!object(selector) || !['rig', 'post'].includes(String(selector.kind)) || !Number.isSafeInteger(selector.version) || Number(selector.version) < 1
    || selector.kind === 'post' && (!Number.isSafeInteger(selector.rigVersion) || Number(selector.rigVersion) < 1)
    || value.stage !== (selector.kind === 'rig' ? 'rig-review' : 'direction-review') || !file(source.model)
    || selector.kind === 'post' && !file(source.direction) || selector.kind === 'rig' && source.direction !== null
    || !composedPost && (!object(parts) || !file(parts.manifest) || !Array.isArray(parts.images)
      || parts.images.some(row => !file(row) || typeof row.role !== 'string'))
    || source.plan !== null && (!object(source.plan) || !Array.isArray(source.plan.steps)
      || source.plan.steps.some(step => !object(step) || !id(step.id) || !sha(step.hash)))) {
    failure('REVIEW_ACT_INVALID', 'rig/post source binding is malformed or contradicts the review stage');
  }
  if (act.schema === 'rig-review/act@3') {
    const still = act.still;
    if (value.stage !== 'rig-review' || !file(still) || still.path !== `${still.sha256}.png`
      || still.camera !== 'fixed' || !(still.frame === 'setup' && still.animation === undefined
        || typeof still.frame === 'number' && Number.isFinite(still.frame) && still.frame >= 0
          && typeof still.animation === 'string' && still.animation.length > 0)) {
      failure('REVIEW_ACT_INVALID', 'rig-review still identity, camera, frame or animation is malformed');
    }
  }
  return act as unknown as ReviewVerdictAct;
}

export function decodeReviewResponse(text: string, jobId: string, actId: string, requestId: string, kind: ReviewActKind = 'review-verdict'): { act: DecodedReviewAct; bytes: string } {
  let response: JsonObject;
  try { const parsed: unknown = JSON.parse(text); if (!object(parsed)) throw Error(); response = parsed; }
  catch { return failure('REVIEW_ACT_INVALID', 'Review response is not JSON'); }
  if (response.schema !== 'rig-review/job-api@2') failure('REVIEW_API_SCHEMA_UNSUPPORTED', `API schema ${String(response.schema)} is unsupported`);
  if (response.verb !== 'fetch-act' || response.jobId !== jobId || response.requestId !== requestId) failure('REVIEW_ACT_INVALID', 'fetch response identity differs from the request');
  if (response.ok !== true) failure('REVIEW_ACT_FETCH_REFUSED', `Review refused fetch (${object(response.error) ? String(response.error.code) : 'invalid response'})`);
  // The API exposes a semantic value, not a producer storage file. Retain this
  // encoding once, and hash its exact UTF-8 bytes without reconstructing reports.
  const bytes = JSON.stringify(response.value);
  const act = decodeReviewAct(bytes, kind);
  if (act.jobId !== jobId || act.actId !== actId) failure('REVIEW_ACT_INVALID', 'fetched act identity differs from the request');
  return { act, bytes };
}

export interface ReviewActTransport {
  origin: string;
  jobId: string;
  actId: string;
  fetchCapability: string;
  kind?: Exclude<ReviewActKind, 'review-verdict' | 'reopen'>;
}

export interface BustPublicationQuery {
  root: string;
  jobId: string;
  publicationId: string;
  sourceHash: string;
}

/** Synchronous writers use the same authenticated fetch/decoder through the private runtime. */
export function fetchReviewActRuntime(transport: ReviewActTransport): { bytes: string; stillBytes?: string } {
  const response = reviewActRuntime<{ bytes: string; stillBytes?: string }>(transport);
  return { bytes: response.bytes, stillBytes: response.stillBytes };
}

export function fetchBustPublicationSeeds(root: string, act: ChestReviewVerdictAct): readonly JobPublishedChestLandmark[] {
  const { jobId, publicationId, source: { sourceHash } } = act;
  return reviewActRuntime<{ seeds: JobPublishedChestLandmark[] }>(
    { root: realpathSync(root), jobId, publicationId, sourceHash }, 'bust-publication',
  ).seeds;
}

function reviewActRuntime<Result>(input: ReviewActTransport | BustPublicationQuery, action?: 'bust-publication'): Result {
  const child = Bun.spawnSync([process.execPath, ...jobRuntimeExecArgv(), fileURLToPath(new URL('./review-act-runtime.ts', import.meta.url)),
    ...(action ? [action] : [])], { stdin: Buffer.from(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });
  let response: ({ ok: true } & Result) | { ok: false; code: string; message: string };
  try { response = JSON.parse(child.stdout.toString()); }
  catch { return failure('REVIEW_ACT_FETCH_REFUSED', 'fetch adapter failed'); }
  if (!response.ok) refuse(response.code, response.message);
  if (child.exitCode !== 0) failure('REVIEW_ACT_FETCH_REFUSED', 'fetch adapter did not complete');
  return response;
}

export function fetchReviewActBytes(transport: ReviewActTransport): string {
  return fetchReviewActRuntime(transport).bytes;
}

/** Only the route and fetch grant leave the binding reader. Never attach a host. */
export function reviewActTransport(root: string, actId: string): ReviewActTransport {
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  const discarded = asArray(project.review_acts).findIndex(entry => isDiscardReceipt(entry) && entry.actId === actId);
  if (discarded !== -1) refuse('REVIEW_ACT_DISCARDED', `project.json.review_acts[${discarded}]: Review act ${actId} was discarded; publish the current target and obtain a fresh act`);
  const binding = readWriterBinding(root);
  if (!binding) failure('JOB_BINDING_INVALID', 'writer binding is absent, open the live job first');
  if (binding.identity.root !== realpathSync(root) || !object(project.review_job)
    || project.review_job.jobId !== binding.jobId || project.review_job.origin !== binding.origin) failure('JOB_BINDING_INVALID', 'writer binding and project job locator disagree');
  let origin: URL;
  try { origin = new URL(binding.origin); } catch { return failure('JOB_BINDING_INVALID', 'writer route is invalid'); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || !id(binding.jobId) || !id(actId)) failure('JOB_BINDING_INVALID', 'fetch requires an exact loopback job route');
  return { origin: origin.origin, jobId: binding.jobId, actId, fetchCapability: binding.fetchCapability };
}

/** Only an ingested version verdict can supply the words for a later feedback route. */
export function retainedVersionVerdict(project: JsonObject, actId: string): (FetchedReviewAct & { index: number; receipt: JsonObject }) | undefined {
  const matches = asArray(project.review_acts).flatMap((receipt, index) =>
    object(receipt) && receipt.actId === actId ? [{ receipt, index }] : []);
  // Keep the transport's existing refusal for discarded acts, even on a closed job.
  if (matches.some(({ receipt }) => isDiscardReceipt(receipt))) return;
  if (matches.length > 1) failure('REVIEW_ACT_REPLAY_CONFLICT', 'act id matches more than one retained receipt');
  const match = matches[0];
  if (!match || match.receipt.schema === PARTS_CLI_RECEIPT || match.receipt.draft_id !== undefined
    || (match.receipt.kind !== undefined && match.receipt.kind !== 'review-verdict')) return;
  const invalid = reviewActFindings(project)[0];
  if (invalid) refuse(invalid.code, invalid.message);
  const bytes = match.receipt.bytes as string;
  return { ...match, bytes, act: decodeReviewAct(bytes) };
}

export async function fetchReviewAct(transport: ReviewActTransport, fetchAdapter: typeof fetch = fetch): Promise<{ act: DecodedReviewAct; bytes: string; stillBytes?: string }> {
  const requestId = randomUUID();
  const request = JSON.stringify({ schema: 'rig-review/job-api@2', verb: 'fetch-act', jobId: transport.jobId, actId: transport.actId, requestId });
  async function read(accept: string): Promise<Response> {
    try {
      const response = await fetchAdapter(`${transport.origin}/jobs/${transport.jobId}/api`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${transport.fetchCapability}`, 'content-type': 'application/json', accept }, body: request,
      });
      if (!response.ok) return failure('REVIEW_ACT_FETCH_REFUSED', 'live Review refused fetch');
      return response;
    } catch { return failure('REVIEW_ACT_FETCH_REFUSED', 'live Review fetch failed'); }
  }
  if (transport.kind === 'parts-verdict' || transport.kind === 'interview-picks' || transport.kind === 'checkpoint' || transport.kind === 'signoff' || transport.kind === 'comments') return decodeReviewResponse(await (await read('application/json')).text(), transport.jobId, transport.actId, requestId, transport.kind);
  const raw = Buffer.from(await (await read('application/vnd.rig-review.act+json')).arrayBuffer());
  const bytes = new TextDecoder().decode(raw);
  const act = decodeReviewAct(bytes);
  if (act.jobId !== transport.jobId || act.actId !== transport.actId) failure('REVIEW_ACT_INVALID', 'fetched act identity differs from the request');
  if (act.schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA && !Buffer.from(bytes).equals(raw)) {
    failure('REVIEW_ACT_INVALID', 'chest act export cannot be retained byte-for-byte as UTF-8 JSON');
  }
  const still = reviewActStill(act);
  if (still === null) return { act, bytes };
  const png = Buffer.from(await (await read('image/png')).arrayBuffer());
  if (jobHash(png) !== still.sha256) failure('REVIEW_ACT_STILL_INVALID', 'exported still sha256 does not match');
  return { act, bytes, stillBytes: png.toString('base64') };
}

/** Exact #184 identity, discounting verdicts and exact evidence added after this receipt. */
export function reviewActVersionHash(project: JsonObject, act: ReviewVerdictAct, verdictsBefore?: number): string {
  const selector = act.source.selector!;
  if (!Array.isArray(project.versions)) return failure('REVIEW_ACT_SOURCE_STALE', 'versions are absent');
  const versions = project.versions.map(raw => {
    if (!object(raw) || !('version' in selector) || raw.n !== selector.version || verdictsBefore === undefined) return raw;
    const added = (Array.isArray(project.review_acts) ? project.review_acts : []).filter(object)
      .filter(receipt => receipt.version === raw.n && Number(receipt.verdict) >= verdictsBefore)
      .flatMap(receipt => Array.isArray(receipt.added_evidence) ? receipt.added_evidence : []);
    return { ...raw, evidence: Array.isArray(raw.evidence) ? raw.evidence.filter(entry => {
        const index = added.findIndex(value => isDeepStrictEqual(value, entry));
        if (index < 0) return true;
        added.splice(index, 1); return false;
      }) : raw.evidence,
      verdicts: Array.isArray(raw.verdicts) ? raw.verdicts.slice(0, verdictsBefore) : [] };
  });
  const hash = publicationVersionHash(Buffer.from(JSON.stringify({ versions })), { path: '', selector });
  if (!hash) return failure('REVIEW_ACT_SOURCE_STALE', 'reviewed version is absent');
  return hash;
}

function previousPublicationVerdict(project: JsonObject, act: ReviewVerdictAct): number | undefined {
  if (!Array.isArray(project.review_acts)) return undefined;
  const receipts = project.review_acts.filter(object).filter(entry => {
    if (entry.kind === 'review-verdict' && entry.draft_id !== undefined) return false;
    if (entry.kind === 'parts-verdict' || entry.kind === 'interview-picks' || entry.kind === 'checkpoint' || entry.kind === 'signoff' || entry.kind === 'comments' || entry.kind === 'discarded' || entry.jobId !== act.jobId || typeof entry.bytes !== 'string') return false;
    return decodeReviewAct(entry.bytes).publicationId === act.publicationId;
  });
  return receipts.length ? Math.min(...receipts.map(entry => Number(entry.verdict))) : undefined;
}

export function reviewActPublicationWarning(root: string, project: JsonObject, act: ReviewVerdictAct): string | null {
  const receipt = readAcknowledgedPublication(root, act.jobId, act.publicationId);
  if (!receipt) return 'REVIEW_ACT_VERSION_UNVERIFIED: project.json.review_acts: publication receipt is absent, so the first-ingest version-entry check was skipped; retain acknowledged publications for future ingests';
  if (!isDeepStrictEqual(receipt.result.selector, act.source.selector) || receipt.versionHash !== reviewActVersionHash(project, act, previousPublicationVerdict(project, act))) {
    failure('REVIEW_ACT_SOURCE_STALE', 'version entry differs from its acknowledged publication');
  }
  return null;
}

export function assertReviewActSource(root: string, project: JsonObject, act: ReviewVerdictAct): void {
  if (isDraftReviewVerdict(act)) { assertDraftReviewActSource(root, project, act); return; }
  const stale = (detail: string): never => failure('REVIEW_ACT_SOURCE_STALE', detail);
  const source = act.source;
  const selector = source.selector!;
  if ('version' in selector) {
    assertDraftHasRig(assembleOnlyDraftTarget(project, selector.version), 'project.json.review_acts');
  }
  assertDraftHasRig(assembleOnlyDraftPath(root, project, source.model?.path), 'project.json.review_acts.source.model');
  const version = (project.versions as JsonObject[] | undefined)?.find(v => v.n === ('version' in selector ? selector.version : -1));
  if (!version || version.kind !== selector.kind || selector.kind === 'post' && version.rig_version !== selector.rigVersion) stale('reviewed version selection changed');
  const rig = selector.kind === 'post' ? selector.rigVersion : selector.kind === 'rig' ? selector.version : -1;
  const rigVersion = (project.versions as JsonObject[]).find(v => v.n === rig);
  for (const candidate of [version, rigVersion]) {
    if (!candidate) continue;
    const finding = assembleOnlyVersionFinding(root, project, candidate, 'project.json.review_acts');
    if (finding) refuse(finding.code, finding.message);
  }
  const retained = object(rigVersion?.review_package) ? rigVersion.review_package : null;
  const boundFile = (identity: { readonly path: string; readonly sha256: string }): void => {
    try { if (jobHash(publicationFile(root, identity.path)) !== identity.sha256) stale(`${identity.path} changed`); }
    catch { stale(`${identity.path} is missing or changed`); }
  };
  boundFile(source.model!);
  let composed = false;
  if (selector.kind === 'post') {
    if (source.direction!.path !== `evidence/direction/v${selector.version}.json`) stale('displayed direction is not the retained post direction');
    boundFile(source.direction!);
    const provenance = object(version!.provenance) ? version!.provenance : null;
    if (!object(provenance?.direction) || !isDeepStrictEqual(provenance.direction, source.direction)) stale('post direction binding changed');
    let rawDirection: JsonObject | undefined;
    try {
      const parsed: unknown = JSON.parse(publicationFile(root, source.direction!.path).toString('utf8'));
      if (object(parsed)) rawDirection = parsed;
    } catch { /* Legacy post path below. */ }
    if (rawDirection?.schema === DIRECTION_COMPOSE_SPEC) {
      composed = true;
      if (source.parts !== null) stale('composed post does not bind parts');
      let published: ReturnType<typeof composedPublishedBuildFiles>;
      try { published = composedPublishedBuildFiles(root, project, selector.version); }
      catch { return stale('composed post build or direction changed'); }
      const prefix = `${String((published.doc.compose as JsonObject).out)}/check/build/`;
      if (!source.model!.path.startsWith(prefix) || !isDeepStrictEqual(source.model, published.doc.model)
        || !published.files.some(row => isDeepStrictEqual(row, source.model))) {
        stale('displayed model is not the retained composed model');
      }
    }
  }
  if (!composed) {
    if (source.model!.path !== `derived/review/v${rig}/out/check/build/skeleton.model.json`) stale('displayed model is not the retained rig model');
    if (!retained || !Array.isArray(retained.files)) stale('retained review package is absent');
    for (const raw of retained!.files as Json[]) {
      if (!file(raw)) return stale('retained review package identity is malformed');
      boundFile({ path: `derived/review/v${rig}/${raw.path}`, sha256: String(raw.sha256) });
    }
    const parts = source.parts;
    if (!parts) return stale('parts binding is absent');
    const partsRoot = typeof retained!.from === 'string' ? retained!.from : `derived/review/v${rig}/out`;
    if (parts.manifest.path !== `${partsRoot}/parts.json`) stale('parts producer root changed');
    boundFile(parts.manifest);
    for (const row of parts.images) boundFile({ path: join(dirname(parts.manifest.path), row.path), sha256: row.sha256 });
  }
  const manifestPath = liveManifestPath(root, project, 'version' in selector ? selector.version : -1, source.package);
  let manifest: JsonObject;
  try { manifest = JSON.parse(publicationFile(root, manifestPath).toString('utf8')); }
  catch { return stale('published review manifest is absent or unreadable'); }
  if (manifest.id !== source.package.id || manifest.revision !== source.package.revision
    || manifest.model !== source.model!.path || (manifest.direction ?? null) !== (source.direction?.path ?? null)) stale('published package identity changed');
  if (source.plan) {
    const plan = object(project.plan) ? project.plan : null;
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    if (!isDeepStrictEqual(source.plan.steps, steps.map(raw => ({ id: object(raw) ? raw.id : null, hash: object(raw) ? stepHash(raw) : null })))) stale('displayed plan step identities changed');
  }
}

export function assertDraftReviewActSource(root: string, project: JsonObject, act: DraftReviewVerdictAct): NonNullable<AcknowledgedPublication['draftReview']> {
  const source = act.source;
  const { id } = source.selector;
  const publication = readAcknowledgedPublication(root, act.jobId, act.publicationId);
  const binding = publication?.draftReview;
  const stale = (): never => failure('REVIEW_ACT_SOURCE_STALE', `draft ${id} does not match its acknowledged rigging publication`);
  const drafts = asArray(project.drafts).filter(object).filter(draft => draft.id === id);
  if (!binding || drafts.length !== 1 || publication.result.path !== draftPackageIdentity(id).path
    || !isDeepStrictEqual(publication.result.selector, source.selector)
    || publication.versionHash !== jobHash(`${JSON.stringify(drafts[0], null, 2)}\n`)
    || !publication.subjects?.some(subject => subject.kind === 'review-verdict' && subject.stage === 'rig-review')
    || binding.projectHash !== source.projectHash || binding.sourceHash !== source.sourceHash || !isDeepStrictEqual(binding.model, source.model)) return stale();
  try {
    const context = draftPublishedContext(root, project, id);
    const manifest = JSON.parse(compiledDraftManifestBytes(root, project, drafts[0], context.parts!).toString('utf8'));
    if (!isDeepStrictEqual(context.parts, source.parts) || !isDeepStrictEqual(eligibleRigDraftModel(drafts[0]), source.model)
      || !isDeepStrictEqual(publishedSourcePainting(root, project, `drafts[${id}]`), binding.painting)
      || manifest.id !== source.package.id || manifest.revision !== source.package.revision || manifest.model !== source.model.path) return stale();
  } catch { return stale(); }
  return binding;
}

/** A verdict record carries the act's attribution, so an agent's verdict under an owner host is never the owner's. */
export function reviewActVerdict(act: ReviewVerdictAct, by = reviewActBy(act)): JsonObject {
  return { by, at: act.at,
    review: act.value.stage, verdict: { approved: 'accepted', 'changes-requested': 'bounced', pending: 'provisional' }[act.value.verdict],
    verbatim: reviewActVerbatim(act), source: `review act ${act.jobId}/${act.actId}`, on_items: [] };
}

/** A route can quote the unique unanchored comment in an owner's bounced rig verdict. */
export function reviewFeedbackComment(act: ReviewVerdictAct): { comment_index: number; verbatim: string } | undefined {
  if (act.source.selector?.kind !== 'rig' || act.value.stage !== 'rig-review' || act.value.verdict !== 'changes-requested'
    || act.authority.reviewer.role !== 'owner' || !('comments' in act.value)) return undefined;
  const general = act.value.comments.flatMap((comment, comment_index) => comment.anchor === undefined
    ? [{ comment_index, verbatim: comment.text }] : []);
  return general.length === 1 ? general[0] : undefined;
}

function assertMeshActCorrections(project: JsonObject, act: MeshReviewVerdictAct | DraftMeshVerdictAct, by: string): void {
  const verdict = reviewActVerdict(act, by);
  const corrections = asArray(project.corrections).filter(object).filter(record => record.source === verdict.source);
  if (corrections.length !== act.value.meshEdits.length || act.value.meshEdits.some(({ edit, sha256 }, i) => {
    const record = corrections[i];
    const on = record?.on;
    const artifact = record?.artifact;
    const selector = act.source.selector;
    return !object(on) || (selector.kind === 'draft' ? on.kind !== 'draft' || on.id !== selector.id : on.n !== selector.version)
      || !isDeepStrictEqual(on.model, act.source.model)
      || !isDeepStrictEqual(artifact, { kind: 'mesh-delta', actId: act.actId, sourceHash: act.source.sourceHash,
        payloadSha256: sha256, skin: edit.skin, slot: edit.slot, attachment: edit.attachment })
      || record?.by !== verdict.by || record.at !== act.at || record.verbatim !== (verdict.verbatim || null);
  })) failure('REVIEW_ACT_LEDGER_INVALID', 'recorded mesh corrections differ from the immutable act');
}

/** A comment's mesh corrections name the comment act and its words, and no verdict. */
function assertCommentMeshCorrections(project: JsonObject, act: CommentMeshAct): void {
  const source = commentSource(act);
  const words = reviewActVerbatim(act);
  const corrections = asArray(project.corrections).filter(object).filter(record => record.source === source);
  const selector = act.source.selector;
  if (corrections.length !== act.value.meshEdits.length || act.value.meshEdits.some(({ edit, sha256 }, i) => {
    const record = corrections[i];
    const on = record?.on;
    return !object(on) || (selector.kind === 'draft' ? on.kind !== 'draft' || on.id !== selector.id : on.n !== selector.version)
      || !isDeepStrictEqual(on.model, act.source.model)
      || !isDeepStrictEqual(record?.artifact, { kind: 'mesh-delta', actId: act.actId, sourceHash: act.source.sourceHash,
        payloadSha256: sha256, skin: edit.skin, slot: edit.slot, attachment: edit.attachment })
      || record?.by !== reviewActBy(act) || record.at !== act.at || record.verbatim !== (words || null);
  })) failure('REVIEW_ACT_LEDGER_INVALID', 'recorded mesh corrections differ from the immutable comment act');
}

export function reviewStillEvidence(base: string, still: JobRigStill) {
  return { kind: 'still', path: `${base}/${still.path}`, sha256: still.sha256,
    camera: still.camera, frame: still.frame,
    what: still.frame === 'setup' ? 'Review displayed setup pose' : `Review displayed animation ${JSON.stringify(still.animation)} at ${still.frame} seconds` };
}

export function draftReviewStillEvidence(act: DraftReviewVerdictAct) {
  return reviewStillEvidence(`evidence/drafts/${act.source.selector.id}`, reviewActStill(act)!);
}

/** Review declares who a host was opened for; it does not authenticate who pressed the button. */
export const REVIEW_ACT_ACTOR_SINCE = '2026-11-22T00:00:00Z';
type ActAuthor = { readonly authority: { readonly reviewer: { readonly id: string; readonly role: string } }; readonly at: string };

/** An owner-role host opened for the agent declares the agent, which is not the owner. */
export function agentUnderOwner(act: ActAuthor): boolean {
  return act.authority.reviewer.role === 'owner' && act.authority.reviewer.id.trim().toLowerCase() === 'agent';
}

/** The record's `by` for a pick or sign-off act: the declared agent by its own id, otherwise the role's authority. */
export function reviewActBy(act: ActAuthor): string {
  if (agentUnderOwner(act)) return act.authority.reviewer.id;
  return act.authority.reviewer.role === 'owner' ? 'user' : 'delegate';
}

/**
 * The `by` a retained receipt's record must carry. Before REVIEW_ACT_ACTOR_SINCE Create
 * recorded an agent's act under an owner host as `user`; the ledger keeps that with a WARN.
 */
export function retainedActBy(act: ActAuthor, recorded: unknown, path = 'review_acts', warnings?: Finding[]): string {
  if (recorded !== 'user' || !agentUnderOwner(act) || !(Date.parse(act.at) < Date.parse(REVIEW_ACT_ACTOR_SINCE))) return reviewActBy(act);
  warnings?.push({ code: 'REVIEW_ACT_ACTOR_LEGACY', path, message: `project.json.${path}: this act predates actor attribution and records the agent's act under an owner host as user; preserve the receipt, and open hosts for the owner with --reviewer naming the owner` });
  return 'user';
}

/** The sign-off fields a passed checkpoint act supplies; the writer and check share them. */
export function checkpointActSignoff(act: CheckpointAct, by = reviewActBy(act)): { by: string; at: string; verbatim: string; source: string } {
  return { by, at: act.at,
    verbatim: reviewActVerbatim(act), source: `review act ${act.jobId}/${act.actId}` };
}

/** The human values a signoff act records. The act names itself in source; the stage is the writer's, never Review's. */
export function reviewActSignoff(act: SignoffAct, by = reviewActBy(act)): JsonObject {
  return { stage: act.value.stage, checkpoint: null, by,
    at: act.at, verbatim: reviewActVerbatim(act), source: `review act ${act.jobId}/${act.actId}` };
}

/** An approved parts verdict carries the same person's authority for its stage signature. */
export function partsVerdictSignoff(act: PartsVerdictAct, at = act.at, draftId = act.source.selector.id, by = reviewActBy(act)): JsonObject {
  return { stage: 'parts-review', checkpoint: null, draft_id: draftId, by, at,
    verbatim: reviewActVerbatim(act), source: `review act ${act.jobId}/${act.actId}` };
}

/** A folded rig signature retains the verdict's exact human authority, words and clock. */
export function rigVerdictSignoff(act: ReviewVerdictAct, by = reviewActBy(act)): JsonObject {
  return { stage: 'rig-review', checkpoint: null, by,
    at: act.at, verbatim: reviewActVerbatim(act), source: `review act ${act.jobId}/${act.actId}` };
}

/**
 * create's own check that the act answers a subject its publication declared. The
 * acknowledged receipt keeps the subjects create published; a receipt that predates
 * them, or none (a clone), leaves only Review's own ask binding to vouch for it.
 */
export function assertActSubjectDeclared(root: string, act: SignoffAct | CheckpointAct | InterviewPicksAct, path: string): void {
  const receipt = readAcknowledgedPublication(root, act.jobId, act.publicationId);
  if (receipt?.subjects === undefined) return;
  const subject = act.kind === 'interview-picks' ? { kind: 'interview-picks', questionId: act.value.questionId, setId: act.source.optionSet.id } : act.kind === 'signoff' ? { kind: 'signoff', stage: act.value.stage } : { kind: 'checkpoint', checkpointId: act.value.checkpointId };
  if (receipt.subjects.some(declared => isDeepStrictEqual(declared, subject))) return;
  const named = act.kind === 'interview-picks' ? `answers ${act.value.questionId}` : act.kind === 'signoff' ? `signs ${act.value.stage}` : `passes checkpoint ${act.value.checkpointId}`;
  refuse('REVIEW_ACT_SUBJECT_UNDECLARED', `${path}: act ${act.jobId}/${act.actId} ${named}, which its publication ${act.publicationId} did not declare; ask for it in Review on a publication made while the record can sign it`);
}

/** Stages whose sign-off names a reviewed version, and the version kind each one signs. */
export const SIGNOFF_TARGET_KINDS: Readonly<Record<string, 'rig' | 'post'>> = { 'rig-review': 'rig', 'direction-review': 'post' };

/** The version a target-stage signoff act displayed, or null when its selector names no version of that stage's kind. */
export function signoffActVersion(act: SignoffAct): number | null {
  const kind = SIGNOFF_TARGET_KINDS[act.value.stage];
  const selector = act.source.selector;
  if (kind === undefined || !object(selector) || selector.kind !== kind) return null;
  return Number.isSafeInteger(selector.version) && Number(selector.version) >= 1 ? Number(selector.version) : null;
}

/** The Review wire shape stays unchanged; Create resolves record targets before ingest. */
export function isRecordDirectionSignoff(act: SignoffAct): boolean {
  return act.schema === 'rig-review/act@4' && String(act.value.stage) === 'direction-review';
}

export function recordSignoffActVersion(act: SignoffAct, recordBytes: string): number | null {
  if (!isRecordDirectionSignoff(act) || !matchesActProjectSource(act, recordBytes)) return null;
  if (!('record' in act.source) || !act.source.record || act.source.record.sha256 !== act.source.projectHash) return null;
  try {
    const project: unknown = JSON.parse(recordBytes);
    return object(project) ? recordDirectionTarget(project, Date.parse(act.at)) : null;
  } catch { return null; }
}

/** The stable { stage, checkpoint, at } identity its receipt binds. */
export function signoffActIdentity(act: SignoffAct): JsonObject {
  return { stage: act.value.stage, checkpoint: null, at: act.at };
}

export const DISCARD_ACT_ACTOR_SINCE = '2026-11-19T00:00:00Z';

function validateDiscardReceipt(entry: JsonObject, path: string, warnings?: Finding[]): void {
  const { schema: _schema, kind: _kind, jobId, actId, at, reason, by, ...chat } = entry;
  if (!id(jobId) || !id(actId) || typeof at !== 'string'
    || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(at) || !Number.isFinite(Date.parse(at))
    || (reason !== undefined && (typeof reason !== 'string' || !reason.trim()))
    || Object.keys(chat).some(key => !['source', 'owner_words', 'said_at', 'relayed_by'].includes(key))) {
    failure('REVIEW_ACT_LEDGER_INVALID', 'discarded act receipt has invalid identity, time, reason or fields');
  }

  // actId identifies the act being discarded. The relay itself has no Review act.
  const invalidChat = ownerChatFinding({ by, at, ...chat }, `project.json.${path}`);
  if (invalidChat) refuse(invalidChat.code, invalidChat.message);
  if (chat.source === OWNER_CHAT_SOURCE) return;
  if (Object.keys(chat).length || reason === undefined) failure('REVIEW_ACT_LEDGER_INVALID', 'discarded act receipt requires a reason or relayed owner words');
  if (by === 'agent') return;
  if (by === undefined && Date.parse(at) < Date.parse(DISCARD_ACT_ACTOR_SINCE)) {
    warnings?.push({ code: 'REVIEW_ACT_DISCARD_ACTOR_LEGACY', path, message: `project.json.${path}: this discard predates actor attribution; preserve the receipt and use --by for future discards` });
    return;
  }
  failure('REVIEW_ACT_LEDGER_INVALID', 'discarded act receipt requires by: agent with a reason, or the owner and their relayed words');
}

/** Ledger validation checks retained evidence. Routed comment information is opt-in for next. */
export function reviewActFindings(project: JsonObject, warnings?: Finding[], routedAnswerWarnings?: Finding[], verifiedPicks?: VerifiedInterviewPick[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const targets = new Set<string>();
  const ownerPickActs = new Map<string, InterviewPicksAct>();
  const add = (code: string, path: string, detail: string): void => { findings.push({ code, path, message: `${path}: ${detail}; restore the original act receipt and its recorded verdict` }); };
  if (project.review_acts !== undefined && !Array.isArray(project.review_acts)) { add('REVIEW_ACT_LEDGER_INVALID', 'review_acts', 'expected a replay ledger array'); return findings; }
  asArray(project.review_acts).forEach((entry, index) => {
    const path = `review_acts[${index}]`;
    if (object(entry) && entry.schema === PARTS_CLI_RECEIPT) return;
    try {
      if (isDiscardReceipt(entry)) {
        validateDiscardReceipt(entry, path, warnings);
        const key = JSON.stringify([entry.jobId, entry.actId]);
        if (seen.has(key)) failure('REVIEW_ACT_REPLAY_CONFLICT', 'duplicate act receipt');
        seen.add(key);
        if (asArray(project.signoffs).filter(object).some(row => row.source === `review act ${entry.jobId}/${entry.actId}`)) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'discarded act receipt cannot also sign a stage or checkpoint');
        }
        return;
      }
      if (!object(entry) || entry.schema !== 'rig-create/review-act@1' || typeof entry.bytes !== 'string'
        || !sha(entry.sha256) || jobHash(entry.bytes) !== entry.sha256 || entry.kind !== 'comments' && !sha(entry.version_hash)) failure('REVIEW_ACT_LEDGER_INVALID', 'receipt shape or bytes hash is invalid');
      if (entry.kind === 'comments') {
        const act = decodeReviewAct(entry.bytes, 'comments');
        if (entry.jobId !== act.jobId || entry.actId !== act.actId) failure('REVIEW_ACT_LEDGER_INVALID', 'receipt identity differs from its act');
        const key = JSON.stringify([act.jobId, act.actId]);
        if (seen.has(key)) failure('REVIEW_ACT_REPLAY_CONFLICT', 'duplicate act receipt');
        seen.add(key);
        const comments = asArray(project.comments);
        const at = Number.isSafeInteger(entry.comment) && Number(entry.comment) >= 0 ? comments[Number(entry.comment)] : undefined;
        if (Object.keys(entry).some(field => !['schema', 'kind', 'jobId', 'actId', 'bytes', 'sha256', 'comment'].includes(field))
          || !object(at) || asArray(project.comments).filter(object).filter(row => row.source === commentSource(act)).length !== 1) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'comment receipt must name exactly one comments[] entry made from its act');
        }
        const problem = commentEntryFinding(at as JsonObject, act, reviewActBy(act));
        if (problem) failure('REVIEW_ACT_LEDGER_INVALID', `comments[${String(entry.comment)}]: ${problem}`);
        const mesh = commentMeshAct(act);
        if (mesh) assertCommentMeshCorrections(project, mesh);
        return;
      }
      const act = decodeReviewAct(entry.bytes, entry.kind === 'parts-verdict' ? 'parts-verdict' : entry.kind === 'interview-picks' ? 'interview-picks' : entry.kind === 'checkpoint' ? 'checkpoint' : entry.kind === 'signoff' ? 'signoff' : entry.kind === 'reopen' ? 'reopen' : 'review-verdict');
      if (act.kind === 'comments') failure('REVIEW_ACT_LEDGER_INVALID', 'a comment act needs a receipt of kind comments');
      if (entry.jobId !== act.jobId || entry.actId !== act.actId) failure('REVIEW_ACT_LEDGER_INVALID', 'receipt identity differs from its act');
      if (act.kind !== 'interview-picks' && entry.feedback_route !== undefined) {
        const route = entry.feedback_route;
        const comment = act.kind === 'review-verdict' ? reviewFeedbackComment(act) : undefined;
        if (!object(route) || !comment || typeof route.item !== 'string' || !route.item || typeof route.at !== 'string'
          || !Number.isFinite(Date.parse(route.at)) || Date.parse(route.at) < Date.parse(act.at)
          || !isDeepStrictEqual(route, { by: 'agent', at: route.at, item: route.item, ...comment })) {
          failure('REVIEW_FEEDBACK_ROUTE_INVALID', 'feedback_route must name the agent, waypoint, routing time and exact page-level comment from the retained owner act');
        }
      }
      if (entry.bust_config !== undefined && act.schema !== JOB_CHEST_LANDMARKS_ACT_SCHEMA) {
        failure('REVIEW_ACT_LEDGER_INVALID', 'only a chest landmark verdict carries a working bust config');
      }
      const key = JSON.stringify([act.jobId, act.actId]);
      if (seen.has(key)) failure('REVIEW_ACT_REPLAY_CONFLICT', 'duplicate act receipt');
      seen.add(key);
      if (act.kind === 'parts-verdict') {
        if (entry.draft_id !== act.source.selector.id || !file(entry.evidence) || entry.evidence.sha256 !== entry.sha256) failure('REVIEW_ACT_LEDGER_INVALID', 'parts receipt target differs from its act');
        // Older separate approvals have no folded mapping and keep their original route.
        const source = `review act ${act.jobId}/${act.actId}`;
        const named = asArray(project.signoffs).filter(object).filter(row => row.source === source);
        const amendment = entry.signoff_amendment;
        if (amendment !== undefined || entry.signoff !== undefined || named.length > 0) {
          if (act.source.package.id !== draftPackageIdentity(act.source.selector.id).id && !(amendment !== undefined && isRiggingDraftAct(act))) {
            failure('REVIEW_ACT_LEDGER_INVALID', 'a parts signature must bind the parts-review package');
          }
          const signoff = Number.isSafeInteger(entry.signoff) && Number(entry.signoff) >= 0 ? asArray(project.signoffs)[Number(entry.signoff)] : null;
          if (amendment !== undefined && (!object(amendment) || typeof amendment.signed_at !== 'string'
            || (amendment.draft_id !== undefined && !id(amendment.draft_id)))) {
            failure('REVIEW_ACT_LEDGER_INVALID', 'carried parts signature has an invalid amendment, target draft or write clock');
          }
          const at = amendment === undefined ? act.at : String(amendment.signed_at);
          const draftId = partsReceiptDraftId(entry)!;
          const expected = partsVerdictSignoff(act, at, draftId, retainedActBy(act, object(signoff) ? signoff.by : undefined, path, warnings));
          if (act.value.verdict !== 'approved' || !object(signoff) || named.length !== 1 || named[0] !== signoff
            || Object.entries(expected).some(([key, value]) => signoff[key] !== value)
            || !object(signoff.evidence) || signoff.evidence.kind !== 'parts-verdict'
            || signoff.evidence.path !== entry.evidence.path || signoff.evidence.sha256 !== entry.sha256
            || signoff.evidence.spec !== act.schema) {
            failure('REVIEW_ACT_LEDGER_INVALID', 'parts signature differs from its approved verdict');
          }
          if (amendment !== undefined && amendment.index !== partsCarryAmendment(project, draftId, act, entry, Date.parse(at))) {
            failure('REVIEW_ACT_LEDGER_INVALID', 'carried parts signature differs from its owner amendment');
          }
        }
        return;
      }
      if (act.kind === 'interview-picks') {
        const route = interviewFeedbackRoute(act);
        const hasRoute = Object.hasOwn(entry, 'feedback_route');
        if (hasRoute && (route === undefined || !isDeepStrictEqual(entry.feedback_route, route))) {
          failure('REVIEW_FEEDBACK_ROUTE_INVALID', 'feedback_route must match the question and all ordered comments, including their anchors, from the retained interview act and be absent for an answer without comments');
        }
        const item = act.value.questionId === INTAKE_QUESTION ? intakeItem(project)
          : collectItems(project, { collection: null }).find(item => item.id === act.value.questionId);
        const retained = item ? [item.raw, ...asArray(item.record.history)].filter(object) : [];
        const matches = (answer: JsonObject) => answer.at === act.at && object(answer.choice)
          && jobHash(JSON.stringify(answer.choice)) === entry.version_hash;
        const answer = retained.find(matches);
        const choice = object(answer?.choice) ? answer.choice : null;
        const picks = choice && Array.isArray(choice.picks) ? choice.picks : [];
        if (entry.question !== act.value.questionId || !answer || answer.by !== retainedActBy(act, answer.by, path, warnings)
          || !choice || !object(choice.set) || choice.set.sha256 !== act.source.optionSet.sha256
          || (choice.note ?? '') !== act.value.note || !isDeepStrictEqual(picks.map(raw => object(raw)
            ? { itemId: raw.ask, optionId: raw.option_id, otherText: raw.other_text ?? null } : null), act.value.selections)) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'recorded interview answer differs from the immutable act');
        }
        if (route && !hasRoute) {
          const count = route.comments.length;
          warnings?.push({ code: 'REVIEW_ANSWER_COMMENTS_UNROUTED', path, message: `project.json.${path}: ${count} owner comment${count === 1 ? '' : 's'} on interview answer ${route.question} retained, not routed; read them in ${path}.bytes (value.comments) and preserve the receipt` });
        } else if (route && routedAnswerWarnings) {
          for (const [commentIndex, { order, text, anchor }] of route.comments.entries()) {
            const commentPath = `${path}.feedback_route.comments[${commentIndex}]`;
            const anchorText = anchor === undefined ? '' : `\nAnchor: ${JSON.stringify(anchor)}`;
            routedAnswerWarnings.push({ code: 'REVIEW_ANSWER_COMMENT_ROUTED', path: commentPath,
              message: `project.json.${commentPath}: interview answer ${route.question}, owner comment ${order}\n${text}${anchorText}` });
          }
        }
        ownerPickActs.set(JSON.stringify([act.jobId, act.actId]), act);
        verifiedPicks?.push({ act, path, answers: retained.filter(matches), route: hasRoute ? route : undefined });
        return;
      }
      if (act.kind === 'reopen') {
        const recorded = Number.isSafeInteger(entry.reopen) && Number(entry.reopen) >= 0 ? asArray(project.reopens)[Number(entry.reopen)] : null;
        if (!object(recorded) || entry.version_hash !== jobHash(JSON.stringify(recorded))
          || recorded.stage !== act.value.stage || recorded.by !== act.authority.reviewer.id
          || recorded.at !== act.at || recorded.verbatim !== act.value.words
          || recorded.source !== `review act ${act.jobId}/${act.actId}`) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'recorded reopen differs from the immutable act');
        }
        return;
      }
      if (act.kind === 'checkpoint') {
        const signoffs = Array.isArray(project.signoffs) ? project.signoffs : [];
        const signoff = Number.isSafeInteger(entry.signoff) && Number(entry.signoff) >= 0 ? signoffs[Number(entry.signoff)] : undefined;
        const displayed = act.source.plan.steps.find(step => step.id === act.value.planStepId);
        const expected = checkpointActSignoff(act, retainedActBy(act, object(signoff) ? signoff.by : undefined, path, warnings));
        if (act.value.outcome !== 'pass' || act.value.checkpointId !== act.value.planStepId || entry.checkpoint !== act.value.planStepId
          || entry.version_hash !== displayed?.hash || !object(signoff) || signoff.checkpoint !== act.value.planStepId
          || signoff.by !== expected.by || signoff.at !== expected.at || signoff.verbatim !== expected.verbatim || signoff.source !== expected.source) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'recorded checkpoint sign-off differs from the immutable passed act');
        }
        // The sign-off's source names this act, so a second receipt cannot point at it.
        return;
      }
      if (act.kind === 'signoff') {
        const source = `review act ${act.jobId}/${act.actId}`;
        const recorded = asArray(project.signoffs).filter(object).filter(signoff => signoff.source === source);
        const expected = reviewActSignoff(act, retainedActBy(act, recorded.length === 1 ? recorded[0]!.by : undefined, path, warnings));
        const target = recorded.length === 1 && object(recorded[0]!.target) ? recorded[0]!.target : null;
        const recordDirection = isRecordDirectionSignoff(act);
        const shown = recordDirection
          ? Number.isSafeInteger(entry.target_version) && Number(entry.target_version) > 0
            && entry.record_sha256 === act.source.projectHash
            && 'record' in act.source && act.source.record?.sha256 === entry.record_sha256 ? Number(entry.target_version) : null
          : signoffActVersion(act);
        if (entry.stage !== act.value.stage || entry.version_hash !== jobHash(JSON.stringify(signoffActIdentity(act))) || recorded.length !== 1
          || Object.entries(expected).some(([key, value]) => recorded[0]![key] !== value)
          || recordDirection && (typeof entry.verdict !== 'string' || target?.verdict !== entry.verdict)
          // A target stage's signature belongs to the version the person was shown.
          || act.value.stage in SIGNOFF_TARGET_KINDS && (target === null || shown === null || target.version !== shown)) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'recorded signoff differs from the immutable act');
        }
        return;
      }
      if (isDraftReviewVerdict(act)) {
        const id = act.source.selector.id;
        const by = retainedActBy(act, object(entry.verdict) ? entry.verdict.by : undefined, path, warnings);
        const draft = asArray(project.drafts).filter(object).filter(row => row.id === id);
        if (entry.kind !== 'review-verdict' || entry.draft_id !== id || draft.length !== 1 || entry.version !== undefined || entry.signoff !== undefined
          || asArray(project.signoffs).filter(object).some(row => row.source === `review act ${act.jobId}/${act.actId}`)
          || entry.version_hash !== jobHash(`${JSON.stringify(draft[0], null, 2)}\n`)
          || !isDeepStrictEqual(entry.verdict, reviewActVerdict(act, by)) || !file(entry.painting)
          || !isDeepStrictEqual(entry.evidence, draftReviewStillEvidence(act))
          || !isDeepStrictEqual(eligibleRigDraftModel(draft[0]), act.source.model)) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'recorded draft verdict differs from its immutable act and reviewed draft');
        }
        if (act.schema === JOB_MESH_EDITS_ACT_SCHEMA) assertMeshActCorrections(project, act, by);
        return;
      }
      if (!Number.isSafeInteger(entry.verdict) || Number(entry.verdict) < 0 || entry.version !== ('version' in act.source.selector! ? act.source.selector.version : null)) failure('REVIEW_ACT_LEDGER_INVALID', 'verdict receipt target is invalid');
      const target = JSON.stringify([entry.version, entry.verdict]);
      if (targets.has(target)) failure('REVIEW_ACT_LEDGER_INVALID', 'multiple receipts point to one verdict');
      targets.add(target);
      const version = Array.isArray(project.versions) ? project.versions.find(v => object(v) && v.n === entry.version) : null;
      const verdict = object(version) && Array.isArray(version.verdicts) ? version.verdicts[Number(entry.verdict)] : null;
      const by = retainedActBy(act, object(verdict) ? verdict.by : undefined, path, warnings);
      if (!isDeepStrictEqual(verdict, reviewActVerdict(act, by))) failure('REVIEW_ACT_LEDGER_INVALID', 'recorded verdict differs from the immutable act');
      if (act.schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA) {
        if (!file(entry.bust_config) || !bustConfigPath(entry.bust_config.path)
          || !object(version) || entry.bust_config.sha256 !== frozenBustConfigHash(version)) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'working bust config binding differs from the rig registration or does not name an editable path');
        }
      }
      const meshAct = meshReviewVerdict(act);
      if (meshAct) assertMeshActCorrections(project, meshAct, by);
      const expectedSignoff = rigVerdictSignoff(act);
      const namedSignoffs = asArray(project.signoffs).filter(object).filter(row => row.source === expectedSignoff.source);
      if (entry.signoff !== undefined || namedSignoffs.length > 0) {
        const signoff = Number.isSafeInteger(entry.signoff) && Number(entry.signoff) >= 0 ? asArray(project.signoffs)[Number(entry.signoff)] : null;
        const versionIndex = asArray(project.versions).indexOf(version as JsonObject);
        const binding = object(version) && version.pre_interview === true && Array.isArray(version.outputs)
          ? { outputs: { path: `versions[${versionIndex}].outputs`, sha256: outputsHash(version.outputs) } }
          : object(version) && object(version.review_package)
            ? { review_package: { path: `versions[${versionIndex}].review_package`, sha256: reviewPackageHash(version.review_package) } } : null;
        if (act.value.stage !== 'rig-review' || act.value.verdict !== 'approved' || act.source.selector?.kind !== 'rig'
          || !object(signoff) || namedSignoffs.length !== 1 || namedSignoffs[0] !== signoff
          || Object.entries(rigVerdictSignoff(act, retainedActBy(act, signoff.by, path, warnings))).some(([key, value]) => signoff[key] !== value)
          || !object(signoff.target) || signoff.target.version !== entry.version
          || binding === null || !isDeepStrictEqual(signoff.target, { version: entry.version,
            verdict: `versions[${versionIndex}].verdicts[${entry.verdict}]`, ...binding })) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'folded rig signature differs from its approved verdict');
        }
      }
      const still = reviewActStill(act);
      if (still !== null) {
        const expected = reviewStillEvidence(`evidence/v${entry.version}`, still);
        if (!object(version) || !Array.isArray(version.evidence) || !version.evidence.some(e => isDeepStrictEqual(e, expected))
          || !Array.isArray(entry.added_evidence) || entry.added_evidence.some(e => !isDeepStrictEqual(e, expected))) {
          failure('REVIEW_ACT_LEDGER_INVALID', 'recorded still differs from the immutable act');
        }
      }
    } catch (error) { add(error instanceof Refusal ? error.code : 'REVIEW_ACT_LEDGER_INVALID', path, error instanceof Refusal ? error.message : 'invalid act receipt'); }
  });
  // Every comment is made from exactly one retained comment act (#982).
  if (project.comments !== undefined && !Array.isArray(project.comments)) add('REVIEW_ACT_LEDGER_INVALID', 'comments', 'expected a list of comments made from Review comment acts');
  asArray(project.comments).forEach((_, index) => {
    const named = asArray(project.review_acts).filter(entry => object(entry) && entry.kind === 'comments' && entry.comment === index).length;
    if (named !== 1) add('REVIEW_ACT_LEDGER_INVALID', `comments[${index}]`, `is named by ${named} comment act receipts; each comment is made from exactly one`);
  });
  for (const [index, row] of asArray(project.signoffs).entries()) {
    if (!object(row) || !object(row.evidence) || row.evidence.from !== 'picks') continue;
    const evidence = row.evidence;
    const sources = asArray(evidence.picks).map(ref =>
      object(ref) ? ownerPickActs.get(JSON.stringify([ref.job_id, ref.act_id])) : undefined);
    const last = ownerPickActs.get(JSON.stringify([evidence.job_id, evidence.act_id]));
    if (!last || !sources.includes(last) || row.checkpoint !== null
        || !PICK_SIGNOFF_STAGES.includes(String(row.stage))
        || evidence.said_at !== last.at || !(Date.parse(String(row.at)) >= Date.parse(last.at))
        || new Set(sources.map(act => act?.value.questionId)).size !== sources.length
        || sources.some(act => !act || act.authority.reviewer.role !== 'owner'
          || act.authority.reviewer.id !== row.by || Date.parse(act.at) > Date.parse(last.at)
          || !object(row.answer_hashes) || !Object.hasOwn(row.answer_hashes, act.value.questionId)
          || act.value.selections.some(selection => selection.otherText !== null))) {
      add('REVIEW_ACT_LEDGER_INVALID', `signoffs[${index}].evidence`, 'derived pick signoff differs from its owner pick receipts');
    }
  }
  return findings;
}
