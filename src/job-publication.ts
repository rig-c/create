import { checkInputs } from './inputs.ts';
import { pngDimensions } from './scene.ts';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { partsFileReferences } from '@rig-c/parts/src/parts.ts';
import partsPackage from '@rig-c/parts/package.json';
import * as reviewJobHost from '@rig-c/review/job-host';
import { JOB_ACT_SCHEMA, JOB_API_SCHEMA, type JobPublicationReader, type JobPublishedContext, type JobSelector, type PublishResultV3, type RecordPicksSubject, type RecordPlanSubject } from '@rig-c/review/job-host';
import { stepHash } from './step-hash.ts';
import { DIRECTION_COMPOSE_SPEC, composeInventory } from './direction-compose.ts';
import { readDirection } from './direction.ts';
import { checkpointEvidenceContext, type CheckpointEvidence } from './checkpoint-evidence.ts';
import { locateParts, PARTS_PACKAGE } from './parts-sections.ts';
import { asArray, checkProject, collectItems, isObject, loadCollection, type Finding, type Item } from './check.ts';
import { checkDiffMap, diffStackCandidates, reportShape } from './diff-map.ts';
import { relativeInventory } from './draft-reuse.ts';
import { PARTS_CHECK_SPEC, partsCheckFindings } from './parts-check.ts';
import {
  COLLECTION_BINDING_SPEC,
  isLiveMemberRoot,
  isValidCollectionBindingPath,
  projectUsesCollection,
  verifyCollectionBinding,
  withCandidateProject,
} from './collection-binding-reader.ts';
import { choiceAdoption, optionContextFiles, optionFile, pendingInterviewOptionsPath, validateContext } from './choices.ts';
import { approvalStageOfGuide, hasStageOrder, interviewStageOfGuide, isOpenInterviewStage, PAUSED_STAGE, silentInterviewItems, stageIndex, stepCoveredByApproval } from './stages.ts';
import { guideSignoffMatcher, staleSignoffAnswer } from './signoff-answers.ts';
import { reviewVerdictSignable, rigVerdictIngestible } from './signable.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { humanReviewVerdicts, readVersions } from './review.ts';
import { isAssembleOnlyDraft } from './draft-layout.ts';
import { latestPartsApproval, previousPartsApproval, retainedJson } from './structure.ts';
import { partsStructureSnapshot, shellWord } from './job-acts.ts';
import { jobHash, pendingPublications, isRecordResult, type JobIdentity } from './job-outbox.ts';
import { decodeReviewAct, PLAN_BOUND_SIGNOFF_STAGES, retainedActBy, reviewActVerdict } from './review-act.ts';
import { Refusal, refuse } from './refusal.ts';
import { lockedPackage } from './toolchain-lock.ts';
import type { Json, JsonObject } from './templates.ts';

export const JOB_READER_ID = 'rig-create/publication-reader/2';
export const JOB_BINDING_ID = 'rig-create/writer-binding/1';
export const JOB_ENUMERATOR_ID = 'rig-create/parts-file-references/1';
export const partsEnumerator = { version: partsPackage.version, enumerate: partsFileReferences };

const DRAFT_PACKAGE_ID_PREFIX = 'create-draft-';
const RIGGING_DRAFT_PACKAGE_ID_PREFIX = 'create-rigging-draft-';

export function draftPackageIdentity(id: string, rigging = false): { id: string; path: string } {
  return rigging
    ? { id: `${RIGGING_DRAFT_PACKAGE_ID_PREFIX}${id}`, path: `review-rigging-draft-${id}.json` }
    : { id: `${DRAFT_PACKAGE_ID_PREFIX}${id}`, path: `review-draft-${id}.json` };
}

type RiggingDraftOutput = { kind: 'compiled'; model: { path: string; sha256: string } } | { kind: 'mesh' };

function riggingDraftOutput(draft: JsonObject): RiggingDraftOutput | undefined {
  const files = asArray(draft.files).filter(isObject);
  const models = files.filter(file => typeof file.path === 'string' && file.path.endsWith('/skeleton.model.json'));
  if (models.length) {
    const [{ path, sha256 }] = models;
    if (models.length === 1 && !isAssembleOnlyDraft(draft) && typeof path === 'string'
      && typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)) {
      return { kind: 'compiled', model: { path, sha256 } };
    }
    return undefined;
  }
  const paths = files.map(file => String(file.path));
  const rigs = paths.filter(path => path.endsWith('/rig.json'));
  if (rigs.length === 1 && paths.includes(rigs[0].replace(/rig\.json$/, 'mesh_report.json'))) return { kind: 'mesh' };
}

export function eligibleRigDraftModel(draft: JsonObject): { path: string; sha256: string } | undefined {
  const output = riggingDraftOutput(draft);
  return output?.kind === 'compiled' ? output.model : undefined;
}

/** Compare the two recorded inventories in their own parts roots. */
export function riggingDraftPartsChange(root: string, project: JsonObject, draft: JsonObject, stage: string | null): (Finding & { command: string }) | undefined {
  // Draft amendments at rigging require that stage in the writer's record.
  if (stage !== 'rigging' || project.stage !== 'rigging') return undefined;
  if (typeof draft.id !== 'string' || riggingDraftOutput(draft)?.kind !== 'mesh') return undefined;
  const approvedId = latestPartsApproval(project)?.draft_id;
  if (typeof approvedId !== 'string' || approvedId === draft.id) return undefined;
  const approved = asArray(project.drafts).filter((row): row is JsonObject => isObject(row) && row.id === approvedId);
  const approvedParts = approved[0]?.parts;
  if (approved.length !== 1 || !isObject(approvedParts) || !isObject(draft.parts)) return undefined;
  const approvedPath = `drafts[${approvedId}].parts.files`;
  const path = `drafts[${draft.id}].parts.files`;
  try {
    if (isDeepStrictEqual(relativeInventory(approvedParts, approvedPath), relativeInventory(draft.parts, path))) return undefined;
  } catch (error) {
    // The existing record and publication checks report malformed inventories.
    if (error instanceof Refusal && error.code === 'DRAFT_REUSE_MISMATCH') return undefined;
    throw error;
  }
  const manifest = `${draft.parts.path}/parts.json`;
  const command = `rig-create amend parts-review ${shellWord(root)} --kind draft --target ${shellWord(draft.id)} --change ${shellWord(manifest)} --by '<owner>' --owner-chat '<file>' --said-at '<ISO>' --relayed-by '<operator>'`;
  return { code: 'RIGGING_DRAFT_PARTS_CHANGED', path, command,
    message: `${path}: recorded parts differ from parts-review approval for drafts[${approvedId}]; run ${command}` };
}

function reviewPackageIdentity(version: number, row: JsonObject) {
  return { path: `derived/review/v${version}/${String(row.path)}`, sha256: row.sha256 };
}

/** The parts the check loads: its name and version, and its integrity from the governing lockfiles. */
export interface RecordPartsIdentity { readonly name: string; readonly version: string; readonly integrity: string }

type OptionSetRef = Pick<RecordPicksSubject, 'questionId' | 'setId'>;
type RecordOptionResult = Extract<PublishResultV3, { kind: 'option-set' }>;
export type RecordPublicationResult = RecordOptionResult | Extract<PublishResultV3, { kind: 'plan' }>;

export function recordOptionSets(result: RecordOptionResult): readonly OptionSetRef[] {
  return result.sets ?? [{ questionId: result.questionId, setId: result.setId }];
}

/** The live direction bounce reopens post questions without moving the project stage. */
export function optionPublicationStage(project: JsonObject, stage: string | null, now: number): string | null {
  if (stage !== 'direction-review' || project.stage === PAUSED_STAGE) return stage;
  const reopens = collectReopens(project, []).filter(reopen => reopen.at <= now);
  const post = asArray(project.versions).findLast(version => {
    if (!isObject(version) || version.kind !== 'post') return false;
    const at = Date.parse(String(version.at));
    return at <= now && liveSignoff(reopens, 'post', at);
  });
  if (!isObject(post)) return stage;
  const verdict = humanReviewVerdicts(post.verdicts, stage).findLast(({ record }) => {
    const at = Date.parse(String(record.at));
    return at <= now && liveSignoff(reopens, stage, at);
  });
  return verdict?.record.verdict === 'bounced' ? 'post-interview' : stage;
}

export function optionPublicationRemedy(root: string, project: JsonObject, item: Item, stage: string | null, now: number, registered = false): string {
  const split = hasStageOrder(project);
  const post = item.kind === 'post';
  const interview = interviewStageOfGuide(item.id, post, split);
  const dir = shellWord(root);
  const question = shellWord(item.id);
  const check = `rig-create interview --check ${dir} --json`;
  const publicationStage = optionPublicationStage(project, stage, now);
  if (interview === publicationStage) {
    if (!registered && !Number.isFinite(choiceAdoption(project, item))) {
      return `run ${check} and confirm the project's interview choice adoption before registering options`;
    }
    const publish = `rig-create job open ${dir} --reviewer '<owner>' --role owner --question ${question}`;
    const ask = registered ? `publish the current registered set with ${publish}`
      : `register a fresh set with rig-create interview-options ${question} ${dir} --file '<option-set.json>', then run ${publish}`;
    if (stage !== 'direction-review') return ask;
    const answer = `rig-create interview-answer ${question} ${dir} --from-review '<pick-act>'`;
    const amend = `rig-create amend post-interview ${dir} --kind interview-answer --target ${question} --change '<project-relative change>' --by '<owner>' --verbatim-file '<words file>'`;
    return `${ask}. On this direction bounce, record the owner's new pick with ${answer}, then record the owner's amendment with ${amend}, replan the affected steps and re-sign post-interview`;
  }
  const publicationIndex = publicationStage === null ? -1 : stageIndex(publicationStage);
  const interviewIndex = stageIndex(interview);
  if (publicationIndex > interviewIndex) {
    const register = `rig-create interview-options ${question} ${dir} --file '<option-set.json>'`;
    const answer = `rig-create interview-answer ${question} ${dir} --set '<path>' --sha256 '<sha>' --by '<owner>' --pick '<ask>=<option>' --owner-chat '<words file>' --said-at '<ISO>' --relayed-by '<operator>'`;
    const chat = `Review publication is not available at this stage. For an owner-chat correction, register a fresh set with ${register}, show it to the owner in chat, record their pick with ${answer}, then re-sign the approvals named by rig-create next ${dir}`;
    if (rigVerdictIngestible(stage) && item.kind === 'waypoint' && item.state.state === 'user'
      && isObject(item.raw) && item.raw.basis !== 'inherited') {
      const n = Math.max(...readVersions(project).rigs.filter(rig => rig.live).map(rig => rig.n));
      if (Number.isFinite(n) && reviewVerdictSignable(project, n, 'rig-review')) {
        const approval = approvalStageOfGuide(item.id, false, split);
        return `get a fresh owner changes-requested verdict on the latest live rig v${n} with exactly one page-level comment, then run rig-create review ${n} --from-review '<act>' ${dir} --item ${question}:not-asked and re-sign ${approval}. ${chat}`;
      }
    }
    return `run ${check} to inspect the current record and its stage requirements. ${chat}`;
  }
  if (publicationIndex >= 0 && publicationIndex < interviewIndex) {
    return `run ${check} and complete the current stage before asking this question at ${interview}`;
  }
  return `run ${check} to inspect the current record and its stage requirements`;
}

export interface RecordPublicationRequest {
  readonly root: string;
  readonly record: { readonly path: 'project.json'; readonly sha256: string };
  readonly result: RecordPublicationResult;
  readonly phase: 'inventory' | 'retained';
  /** Retained phase only: the `parts` identity the inventory phase returned. */
  readonly parts?: RecordPartsIdentity;
}

type RecordContextBase = {
  readonly label: string;
  readonly parts: RecordPartsIdentity;
  readonly inputs: JobPublishedContext['files'];
  readonly files: JobPublishedContext['files'];
};
export type RecordOptionContext = RecordContextBase & {
  readonly plan: null;
  readonly subjects: readonly RecordPicksSubject[];
};
export type RecordPlanContext = RecordContextBase & {
  readonly checkpointEvidence?: readonly CheckpointEvidence[];
  /** Post stages only: the record's latest post picture, one raster entry of `files` (Review #983). */
  readonly planPicture?: { readonly path: string; readonly sha256: string };
  readonly plan: NonNullable<JobPublishedContext['plan']>;
  readonly subjects: readonly RecordPlanSubject[];
};
export type RecordPublishedContext = RecordOptionContext | RecordPlanContext;

export class RecordClosureIncomplete extends Refusal {
  constructor(readonly details: readonly { code: string; path: string }[]) {
    super('JOB_RECORD_CLOSURE_INCOMPLETE', 'project.json: the retained check refuses while its sealed files match, so the retained root lacks or changed a file of the inventory closure; restore the complete inventory closure before finalization');
  }
}

/** Read each lockfile present at this root, using the actual path to the selected install. */
function lockedParts(base: string, installed: string): { file: string; version: unknown; integrity: unknown }[] {
  const entries: { file: string; version: unknown; integrity: unknown }[] = [];
  const installPath = relative(base, installed).split(sep).join('/');
  const bun = join(base, 'bun.lock');
  if (existsSync(bun)) {
    let raw: unknown;
    try { raw = Bun.JSONC.parse(readFileSync(bun, 'utf8')); } catch { raw = undefined; }
    entries.push({ file: 'bun.lock', ...lockedPackage(raw, 'bun-lock', PARTS_PACKAGE, installPath) });
  }
  const npm = join(base, 'package-lock.json');
  if (existsSync(npm)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(npm, 'utf8')); } catch { raw = undefined; }
    entries.push({ file: 'package-lock.json', ...lockedPackage(raw, 'npm-lock-v3', PARTS_PACKAGE, installPath) });
  }
  return entries;
}

/**
 * The identity of the parts `checkProject(dir)` loads (`locateParts`): the installed version and the
 * integrity every lockfile in the nearest enclosing lockfile root records for that install.
 */
export function loadedPartsIdentity(dir: string, who: 'project' | 'host'): RecordPartsIdentity {
  const missing = (why: string): never => refuse('JOB_RECORD_PARTS_LOCK_MISSING', `project.json: the ${who}'s ${PARTS_PACKAGE} ${why}; install it from a lockfile that records its integrity and publish again`);
  const installed = locateParts(dir);
  if (installed === null) return missing('is not installed');
  let version: unknown;
  try { version = (JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { version?: unknown }).version; } catch { version = undefined; }
  if (typeof version !== 'string') return missing(`at ${installed} has no readable version`);
  let base = dirname(dirname(dirname(resolve(installed))));
  let entries = lockedParts(base, installed);
  while (!entries.length && dirname(base) !== base) {
    base = dirname(base);
    entries = lockedParts(base, installed);
  }
  if (!entries.length) return missing(`${version} has no lockfile governing its install`);
  const integrities = new Set<string>();
  for (const entry of entries) {
    if (entry.version !== version || typeof entry.integrity !== 'string' || !/^sha(?:256|384|512)-\S+$/.test(entry.integrity)) {
      return missing(`${version} has no matching ${entry.file} entry with an integrity`);
    }
    integrities.add(entry.integrity);
  }
  if (integrities.size !== 1) return missing(`${version} has different integrities in bun.lock and package-lock.json`);
  return { name: PARTS_PACKAGE, version, integrity: [...integrities][0]! };
}

/** The stages whose plan publication names the post picture the owner judges the plan against. */
const PLAN_PICTURE_STAGES: ReadonlySet<string> = new Set(['post', 'direction-review']);
/** Review draws only these rasters as a plan picture (its package page-image rule). */
const PLAN_PICTURE_RASTER = /\.(png|jpe?g|webp)$/i;

/**
 * The latest picture the record already holds for its live post work: the newest live `kind: "post"`
 * version's first raster in `evidence` (newest first, as verdict ingestion keeps it), or its
 * first checked idle frame in `outputs`.
 * The path and sha256 are the record's own; nothing is re-derived from a producer. A record without
 * one, or whose named file is not on disk, publishes no picture.
 */
function postPlanPicture(root: string, project: JsonObject): { path: string; sha256: string } | undefined {
  const reopens = collectReopens(project, []);
  const post = asArray(project.versions).filter(isObject).filter(version => version.kind === 'post'
    && liveSignoff(reopens, 'post', Date.parse(String(version.at)))).at(-1);
  if (!post) return undefined;
  const idleFramePath = `outputs/v${String(post.n)}/compose/check/idle_frames/idle/f0000.png`;
  const idleFrames = asArray(post.outputs).filter(entry => isObject(entry) && entry.path === idleFramePath);
  const row = [...asArray(post.evidence), ...idleFrames].filter(isObject).find(entry =>
    typeof entry.path === 'string' && PLAN_PICTURE_RASTER.test(entry.path)
      && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256));
  if (!row) return undefined;
  const path = String(row.path);
  if (!existsSync(join(root, path))) return undefined;
  return { path, sha256: String(row.sha256) };
}

function planResignScope(project: JsonObject, steps: readonly JsonObject[], refusals: readonly Finding[]): { stage: string | null; blocking: readonly Finding[] } {
  const signoffs = asArray(project.signoffs);
  const guides = new Set<string>();
  const stages = new Set<string | null>();
  for (const finding of refusals) {
    const stale = staleSignoffAnswer(finding);
    if (!stale) continue;
    guides.add(stale.id);
    const signoff = signoffs[stale.index];
    stages.add(isObject(signoff) && typeof signoff.stage === 'string' && typeof signoff.checkpoint !== 'string'
      ? signoff.stage : null);
  }
  const [stage] = stages;
  const singleStage = stages.size === 1 && typeof stage === 'string' && PLAN_BOUND_SIGNOFF_STAGES.includes(stage);
  const affected = guideSignoffMatcher(guides);
  const blocking = refusals.filter(finding => !affected(finding));
  // Prefer an unrelated finding even when stale signatures precede it in check order.
  if (blocking.length) return { stage: null, blocking };
  return singleStage ? { stage, blocking } : { stage: null, blocking: refusals };
}

/** Reuse check's eligibility and the exact retained evidence of its subject. No writes or locks. */
export function readRecordPublished(input: RecordPublicationRequest & { result: RecordOptionResult }, now?: number): RecordOptionContext;
export function readRecordPublished(input: RecordPublicationRequest & { result: { kind: 'plan' } }, now?: number): RecordPlanContext;
export function readRecordPublished(input: RecordPublicationRequest, now?: number): RecordPublishedContext;
export function readRecordPublished({ root, record, result, phase, parts: sealedParts }: RecordPublicationRequest, now = Date.now()): RecordPublishedContext {
  try {
    const bytes = publicationFile(root, record.path);
    if (record.path !== 'project.json' || jobHash(bytes) !== record.sha256) refuse('JOB_PUBLICATION_INVALID', 'project.json: the committed record binding changed; restore its exact sealed bytes');
    const project: JsonObject = JSON.parse(bytes.toString('utf8'));
    if (phase !== 'inventory' && phase !== 'retained') throw Error('phase must be inventory or retained');
    const needsCollectionBinding = isLiveMemberRoot(root) || project.collection_binding !== undefined || projectUsesCollection(project);
    let verifiedCollection: JsonObject | null = null;
    if (phase === 'inventory' && needsCollectionBinding) {
      const verified = verifyCollectionBinding(root, project, { requireBindingWhenExternal: true });
      if (!verified.valid) {
        refuse(
          'JOB_RECORD_COLLECTION_EXTERNAL',
          verified.finding?.message ??
            "project.json: a member record's inherited answers depend on ../../collection.json, which the project-relative closure cannot seal; bind ../../collection.json with rig-create collection-binding <member dir>",
        );
      }
      verifiedCollection = verified.boundCollection;
    }
    // The check's waypoints come from the parts it loads, which no project file seals.
    let parts = loadedPartsIdentity(root, phase === 'inventory' ? 'project' : 'host');
    if (phase === 'retained') {
      if (!isObject(sealedParts as Json | undefined) || typeof sealedParts!.name !== 'string' || typeof sealedParts!.version !== 'string' || typeof sealedParts!.integrity !== 'string') {
        refuse('JOB_PUBLICATION_INVALID', 'project.json: the retained phase needs the parts identity the inventory phase returned; pass it unchanged');
      }
      if (sealedParts!.name !== parts.name || sealedParts!.version !== parts.version || sealedParts!.integrity !== parts.integrity) {
        refuse('JOB_RECORD_PARTS_MISMATCH', `project.json: the project was checked with ${sealedParts!.name} ${sealedParts!.version} (${sealedParts!.integrity}), but the host loads ${parts.name} ${parts.version} (${parts.integrity}); rebuild the project on the host's ${parts.name} ${parts.version}, or run the check where ${sealedParts!.version} is installed`);
      }
      parts = { name: sealedParts!.name, version: sealedParts!.version, integrity: sealedParts!.integrity };
    }
    const seals = new Map<string, string>();
    const seal = (raw: Json): { path: string; sha256: string } => {
      if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) refuse('JOB_PUBLICATION_INVALID', 'project.json: retained file identity is malformed; restore its literal path and sha256');
      const { path, sha256 } = raw;
      if (seals.has(path) && seals.get(path) !== sha256) refuse('JOB_PUBLICATION_INVALID', `project.json: ${path} has conflicting hashes; restore one immutable identity`);
      if (jobHash(publicationFile(root, path)) !== sha256) refuse('JOB_PUBLICATION_INVALID', `project.json: ${path} differs from its retained bytes; restore its sealed bytes`);
      seals.set(path, sha256);
      return { path, sha256 };
    };
    const list = (raw: Json | undefined): { path: string; sha256: string }[] => {
      if (!Array.isArray(raw)) refuse('JOB_PUBLICATION_INVALID', 'project.json: retained file list is missing; restore its declared identities');
      const paths = new Set<string>();
      return raw.map(value => {
        const identity = seal(value);
        if (paths.has(identity.path)) refuse('JOB_PUBLICATION_INVALID', `project.json: ${identity.path} is declared twice in one list; retain a single declaration`);
        paths.add(identity.path);
        return identity;
      });
    };
    const sealContext = (context: JsonObject): void => {
      if (context.kind === 'inputs') list(context.files);
      if (isObject(context.parts)) list(context.parts.files);
      for (const binding of optionContextFiles(context)) seal(binding);
      if (context.kind !== 'rig') return;
      const rig = asArray(project.versions).filter(isObject).find(version => version.n === context.rig_version);
      if (!rig || typeof rig.n !== 'number' || !isObject(rig.review_package)) return;
      const version = rig.n;
      const buildFiles = asArray(rig.review_package.files).filter(isObject)
        .filter(row => typeof row.path === 'string' && row.path.startsWith('out/check/build/'));
      list(buildFiles.map(row => reviewPackageIdentity(version, row)));
    };
    seal({ path: record.path, sha256: record.sha256 });
    if (project.collection_binding !== undefined) {
      if (
        !isObject(project.collection_binding) ||
        project.collection_binding.spec !== COLLECTION_BINDING_SPEC ||
        typeof project.collection_binding.path !== 'string' ||
        !isValidCollectionBindingPath(project.collection_binding.path) ||
        typeof project.collection_binding.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(project.collection_binding.sha256) ||
        typeof project.collection_binding.collection_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(project.collection_binding.collection_sha256)
      ) {
        refuse('JOB_PUBLICATION_INVALID', 'project.json: retained collection_binding identity is malformed; restore its path, sha256, spec, and collection_sha256');
      }
      if (phase === 'inventory' || existsSync(join(root, project.collection_binding.path))) {
        seal({ path: project.collection_binding.path, sha256: project.collection_binding.sha256 });
        if (phase === 'retained') {
          const verified = verifyCollectionBinding(root, project, { requireBindingWhenExternal: true });
          if (!verified.valid) {
            refuse(
              isLiveMemberRoot(root) ? 'JOB_RECORD_COLLECTION_EXTERNAL' : 'JOB_PUBLICATION_INVALID',
              verified.finding?.message ?? 'project.json: retained collection_binding is invalid',
            );
          }
          verifiedCollection = verified.boundCollection;
        }
      }
    } else if (phase === 'retained' && needsCollectionBinding) {
      refuse(
        'JOB_RECORD_COLLECTION_EXTERNAL',
        "project.json: a member record's inherited answers depend on ../../collection.json, which the project-relative closure cannot seal without collection_binding",
      );
    }
    const inputs = list(project.inputs);
    const collection = verifiedCollection ?? loadCollection(root, project);
    const items = collectItems(project, { collection });
    const plan = isObject(project.plan) ? project.plan : null;
    const steps = asArray(plan?.steps).filter(isObject);
    const sets = result.kind === 'option-set' ? recordOptionSets(result) : [];
    if (result.kind === 'option-set' && result.sets && (sets.length < 2 || sets.length > 64
      || sets[0]?.questionId !== result.questionId || sets[0]?.setId !== result.setId)) {
      refuse('JOB_RECORD_SUBJECT_INVALID', 'project.json: an option-set publication must name 1 to 64 sets and lead with its primary set; select the current sets with --questions or --question');
    }
    const ids = result.kind === 'option-set' ? sets.flatMap(set => [set.questionId, set.setId]) : steps.map(step => step.id);
    if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) {
      refuse('JOB_RECORD_SUBJECT_INVALID', 'project.json: a requested question, set or displayed step id is outside the record publication id domain; retain a representable producer id without aliases');
    }
    const remedyRoot = phase === 'retained' ? '<project dir>' : root;
    let selectedSets: { item: Item; set: JsonObject }[] = [];
    if (result.kind === 'option-set') {
      const seen = new Set<string>();
      for (const { questionId, setId } of sets) {
        const key = JSON.stringify([questionId, setId]);
        if (seen.has(key)) refuse('JOB_OPTION_SET_DUPLICATE', `project.json: option set ${questionId}/${setId} is named twice; select each pending set once`);
        seen.add(key);
      }
      selectedSets = sets.map(({ questionId }) => {
        const matches = items.filter(item => item.id === questionId);
        if (matches.length !== 1) throw Error('the requested question is absent or ambiguous');
        const item = matches[0];
        const binding = item.record.pending_options;
        // A question whose pick is already recorded has no pending set to publish.
        if (binding === undefined) {
          const stage = checkProject(root, project, { now, readOnly: true, recordPublication: true }).effective_stage;
          refuse('JOB_RECORD_SUBJECT_INVALID', `project.json.${pendingInterviewOptionsPath(item)}: no pending option set at effective stage ${stage ?? 'unknown'}; ${optionPublicationRemedy(remedyRoot, project, item, stage, now)}`);
        }
        if (!isObject(binding)) {
          refuse('JOB_RECORD_SUBJECT_INVALID', `project.json.${pendingInterviewOptionsPath(item)}: invalid pending option set binding; run rig-create interview --check ${shellWord(remedyRoot)} --json and restore the retained binding`);
        }
        seal(binding);
        const set = optionFile(root, binding).set;
        sealContext(set.context as JsonObject);
        return { item, set };
      });
    } else if (result.kind === 'plan') {
      if (!plan) throw Error('the requested plan is absent');
      // Seal current answer evidence for every displayed step before checking eligibility.
      const basis = new Set(steps.flatMap(step => asArray(step.rests_on).map(String)));
      for (const item of items.filter(item => basis.has(item.id))) {
        if (item.state.state !== 'user' && item.state.state !== 'delegated') continue;
        const choice = item.state.answer.choice;
        if (!isObject(choice)) continue;
        seal(choice.set!);
        sealContext(optionFile(root, choice.set).set.context as JsonObject);
      }
      const approval = latestPartsApproval(project);
      if (isObject(approval?.evidence)) seal(approval.evidence);
      if (isObject(approval?.structure)) seal(approval.structure);
    } else throw Error('unknown record result');
    // Seal the decision record and every file its record check reads, rather than
    // revalidating all producer artifacts from earlier versions and drafts.
    const pausedPlan = result.kind === 'plan' && project.stage === PAUSED_STAGE;
    const report = checkProject(root, project, { now, readOnly: true, recordReads: true, recordPublication: true });
    for (const { path, sha256 } of report.reads ?? []) seal({ path, sha256 });
    // Picks and read-only paused plans can show unfinished work. Only silent
    // questions of the current interview may remain open.
    const openQuestions = (result.kind === 'option-set' || pausedPlan)
      && isOpenInterviewStage(report.effective_stage)
      ? new Set(silentInterviewItems(project, items, report.effective_stage).map(item => item.path))
      : new Set<string>();
    const coversPlanDate = (finding: Finding, stage: string | null): boolean => finding.code !== 'PLAN_STEP_PREDATES_ANSWER'
      || (result.kind === 'plan' && steps.some(step => finding.path === `plan.steps[${String(step.id)}]`
        && stepCoveredByApproval(project, step, stage)));
    const scopedRefusals = report.refusals.filter(finding => coversPlanDate(finding, report.effective_stage)
      && (finding.code !== 'INTERVIEW_INCOMPLETE' || !openQuestions.has(finding.path)));
    const stalePlan = scopedRefusals.find(finding => finding.code === 'PLAN_STEP_PREDATES_ANSWER');
    if (stalePlan) refuse(stalePlan.code, stalePlan.message);
    const canResign = result.kind === 'plan' && !pausedPlan
      && scopedRefusals.some(finding => staleSignoffAnswer(finding) !== undefined);
    // Inventory sees the live project. A re-sign may only repair the scoped findings,
    // even when another refusal depends on producer files outside the retained plan.
    const baseline = canResign && phase === 'inventory' ? checkProject(root, project, { now, readOnly: true }) : undefined;
    const refusals = baseline?.refusals.filter(finding => coversPlanDate(finding, report.effective_stage)) ?? scopedRefusals;
    const { stage: resignStage, blocking } = canResign ? planResignScope(project, steps, refusals) : { stage: null, blocking: refusals };
    // A re-sign can approve an earlier stage's plan while execution stays at the current stage.
    if (resignStage !== null) {
      const stale = (baseline?.refusals ?? report.refusals).find(finding =>
        finding.code === 'PLAN_STEP_PREDATES_ANSWER' && coversPlanDate(finding, resignStage));
      if (stale) refuse(stale.code, stale.message);
    }
    if (blocking.length && phase === 'retained') {
      throw new RecordClosureIncomplete(blocking.map(({ code, path }) => ({ code, path })));
    }
    // Reconcile publishes the record before queued drafts on the same record and job.
    // Their transport holes do not invalidate the record. Stale and malformed receipts
    // still have their own findings, and an unrelated publication still blocks.
    const pending = phase === 'inventory' ? pendingPublications(root) : [];
    const ownPending = pending.find(entry => entry.phase === 'pending'
      && entry.recordHash === record.sha256 && isRecordResult(entry.result) && isDeepStrictEqual(entry.result, result));
    const sameBatch = ownPending && pending.every(entry => entry.phase === 'pending'
      && entry.recordHash === ownPending.recordHash && entry.jobId === ownPending.jobId
      && entry.origin === ownPending.origin && isDeepStrictEqual(entry.identity, ownPending.identity)
      && (isDeepStrictEqual(entry.result, result) || entry.result.selector?.kind === 'draft'));
    const holes = sameBatch ? report.holes?.filter(hole => hole.code !== 'JOB_PUBLISH_PENDING') : report.holes;
    const finding = blocking[0] ?? holes?.[0];
    if (finding) throw Error(`${finding.code} at ${finding.path}`);
    const stage = resignStage ?? report.effective_stage;
    let label: string;
    if (result.kind === 'option-set') {
      const optionStage = optionPublicationStage(project, stage, now);
      withCandidateProject(root, project, () => {
        for (const [index, { questionId, setId }] of sets.entries()) {
          const { item, set } = selectedSets[index]!;
          if (set.id !== setId || set.question !== questionId || set.stage !== optionStage) {
            refuse('JOB_RECORD_SUBJECT_INVALID', `project.json.${pendingInterviewOptionsPath(item)}: requested set does not match its question, set id and effective stage ${stage ?? 'unknown'}; ${optionPublicationRemedy(remedyRoot, project, item, stage, now, true)}`);
          }
          validateContext(root, project, set, now, true);
        }
      });
      label = result.sets ? `${sets.length} option sets / ${stage}` : `option-set ${result.questionId} / ${result.setId}`;
    } else if (pausedPlan) {
      label = `plan / ${project.stage}`;
    } else if (result.kind === 'plan') {
      if (!plan) throw Error('the requested plan is absent');
      label = `plan / ${stage}`;
    } else throw Error('unknown record result');
    // #665: a post-stage plan names its picture by the record's own identity, sealed into the closure.
    const planPicture = result.kind === 'plan' && stage !== null && PLAN_PICTURE_STAGES.has(stage)
      ? postPlanPicture(root, project) : undefined;
    if (planPicture) seal(planPicture);
    // Detect record changes during closure reads as well as changes before entry.
    if (!publicationFile(root, record.path).equals(bytes)) throw Error('project.json changed while reading its closure');
    const files = [...seals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, sha256]) => ({ path, sha256 }));
    if (result.kind === 'option-set') {
      return { label, parts, inputs, files, plan: null,
        subjects: sets.map(({ questionId, setId }) => ({ kind: 'interview-picks', questionId, setId })) };
    }
    const evidence = checkpointEvidenceContext(root, project, files);
    return { label, parts, inputs, files, ...evidence, ...(planPicture ? { planPicture } : {}),
      plan: { steps: steps.map(step => ({ id: String(step.id), hash: stepHash(step) })) }, subjects: [] };
  } catch (error) {
    const failure = error instanceof Refusal && (phase === 'retained' || ['JOB_RECORD_SUBJECT_INVALID', 'JOB_OPTION_SET_DUPLICATE', 'JOB_RECORD_COLLECTION_EXTERNAL', 'JOB_RECORD_PARTS_LOCK_MISSING', 'PLAN_STEP_PREDATES_ANSWER'].includes(error.code))
      ? error
      : new Refusal('JOB_RECORD_INCOMPLETE', `project.json: ${error instanceof Refusal ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}; restore the requested record and retained evidence, resolve check refusals and reconcile pending publications before publishing`);
    // Review returns only a safe producer token. Its retained root is private and may
    // be removed on refusal, so report here in the host terminal before it is lost.
    if (phase === 'retained') console.error(`${failure.code}: ${failure.message}`);
    throw failure;
  }
}

export function currentJobIdentity(saved: Pick<JobIdentity, 'root' | 'stateDir' | 'fingerprint' | 'reviewer' | 'publicationMode'>, root: string): JobIdentity {
  return { ...saved, root: realpathSync(root), readerId: JOB_READER_ID, bindingId: JOB_BINDING_ID,
    partsEnumeratorId: JOB_ENUMERATOR_ID, apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA,
    enumeratorVersion: partsEnumerator.version };
}

/** Mirrors Review's `jobPath` refused-character rule (`src/job-api.ts` in `@rig-c/review`). */
export const REVIEW_REFUSED_JOB_PATH = /[\\:%?#]/;

export function isPublicationPath(path: string): boolean {
  return Boolean(path) && path.length <= 4096
    && path.split('/').every(piece => piece && piece !== '.' && piece !== '..')
    && !REVIEW_REFUSED_JOB_PATH.test(path) && !/[\x00-\x1f\x7f]/.test(path);
}

export function assertPublicationPath(path: string): void {
  if (!isPublicationPath(path)) {
    refuse(
      'JOB_PUBLICATION_INVALID',
      `project.json: declared publication path ${path} is refused by Review's jobPath rule (empty, ".", ".." or matching [\\:%?#]); restore a literal project-relative source`,
    );
  }
}

export function publicationFile(root: string, path: string): Buffer {
  return readFileSync(publicationFilePath(root, path));
}

export function publicationFilePath(root: string, path: string): string {
  assertPublicationPath(path);
  try {
    // Allow a project-root alias while still rejecting links below that root.
    const absolute = join(realpathSync(root), path);
    if (realpathSync(absolute) === absolute && lstatSync(absolute).isFile()) return absolute;
  } catch { /* Named below. */ }
  refuse('JOB_PUBLICATION_INVALID', `project.json: ${path} must be a regular source without symlinks; restore its retained bytes`);
}

export function composedPublishedBuildFiles(root: string, project: JsonObject, n: number): { doc: JsonObject; files: { path: string; sha256: string }[] } {
  const buildPrefix = `outputs/v${n}/compose/check/build/`;
  const version = asArray(project.versions).filter(isObject).find(v => v.n === n && v.kind === 'post');
  for (const row of asArray(version?.outputs).filter(isObject)) {
    if (typeof row.path === 'string' && row.path.startsWith(buildPrefix)) assertPublicationPath(row.path);
  }
  const doc = readDirection(root, project, n);
  const prefix = `${String((doc.compose as JsonObject).out)}/check/build/`;
  const files = composeInventory(project, doc)
    .filter(row => String(row.path).startsWith(prefix))
    .map(row => {
      const path = String(row.path);
      const sha256 = String(row.sha256);
      if (jobHash(publicationFile(root, path)) !== sha256) {
        refuse('JOB_PUBLICATION_INVALID', `versions[v${n}].outputs: ${path} differs from its recorded hash; restore the retained bytes before publishing`);
      }
      return { path, sha256 };
    });
  return { doc, files };
}

export function publicationSelector(project: JsonObject, n: number): Exclude<JobSelector, { kind: 'draft' }> {
  const version = (project.versions as JsonObject[]).find(version => version.n === n);
  if (!version) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: result version is missing; restore the recorded version`);
  return version.kind === 'post'
    ? { kind: 'post', version: n, rigVersion: Number(version.rig_version) }
    : { kind: 'rig', version: n };
}

export function originalPaintingReference(root: string, project: JsonObject, n: number) {
  const painting = publishedSourcePainting(root, project, `versions[v${n}]`);
  let size: { width?: number; height?: number } = {};
  if (/\.png$/i.test(painting.path)) {
    try { size = pngDimensions(publicationFile(root, painting.path), painting.path); }
    catch { refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: ${painting.path} needs a valid PNG header; restore the recorded original painting before publishing`); }
  }
  return { id: 'original-painting', label: 'Original painting', type: 'image', path: painting.path, ...size };
}

/** Validate the same retained scene and plate identities for every publication writer and reader. */
export function sealedScene(root: string, project: JsonObject, directionPath: string, direction: JsonObject | undefined): {
  path: string; sha256: string; plates: { path: string; sha256: string }[];
} | undefined {
  if (direction?.schema !== 'rig-create/direction@2') return undefined;
  const reference = direction.scene;
  if (!isObject(reference) || typeof reference.path !== 'string' || typeof reference.sha256 !== 'string') refuse('JOB_PUBLICATION_SCENE_MISSING', `${directionPath}: direction.scene is missing; restore its committed scene reference before publishing`);
  const entry = asArray(project.scenes).filter(isObject).find(value => value.n === reference.n && value.path === reference.path && value.sha256 === reference.sha256);
  if (!entry || reference.path !== `evidence/scene/s${String(reference.n)}.json`) refuse('JOB_PUBLICATION_SCENE_CHANGED', `${directionPath}: direction.scene differs from project.scenes; restore the committed scene reference before publishing`);
  let bytes: Buffer;
  try { bytes = publicationFile(root, reference.path); }
  catch { refuse('JOB_PUBLICATION_SCENE_MISSING', `${reference.path}: scene is missing or unreadable; restore its retained bytes before publishing`); }
  if (jobHash(bytes) !== reference.sha256) refuse('JOB_PUBLICATION_SCENE_CHANGED', `${reference.path}: scene hash moved; restore its retained bytes before publishing`);
  let doc: JsonObject;
  try { doc = JSON.parse(bytes.toString('utf8')) as JsonObject; }
  catch { refuse('JOB_PUBLICATION_SCENE_CHANGED', `${reference.path}: scene is not JSON; restore its retained bytes before publishing`); }
  if (!isObject(doc) || doc.schema !== 'rig-create/scene@1' || doc.n !== reference.n || !Array.isArray(doc.plates) || !doc.plates.length) refuse('JOB_PUBLICATION_SCENE_CHANGED', `${reference.path}: scene identity or plates differ; restore the committed scene before publishing`);
  const plates: { path: string; sha256: string }[] = [];
  for (const plate of doc.plates) {
    if (!isObject(plate) || typeof plate.path !== 'string' || typeof plate.sha256 !== 'string') refuse('JOB_PUBLICATION_PLATE_MISSING', `${reference.path}: plate identity is missing; restore every retained plate before publishing`);
    let plateBytes: Buffer;
    try { plateBytes = publicationFile(root, plate.path); }
    catch { refuse('JOB_PUBLICATION_PLATE_MISSING', `${reference.path}: ${plate.path} is missing or unreadable; restore the retained plate before publishing`); }
    if (jobHash(plateBytes) !== plate.sha256) refuse('JOB_PUBLICATION_PLATE_CHANGED', `${reference.path}: ${plate.path} hash moved; restore the retained plate bytes before publishing`);
    plates.push({ path: plate.path, sha256: plate.sha256 });
  }
  return { path: reference.path, sha256: reference.sha256, plates };
}

/** Validate the retained registration.idle frame record for a rig publication writer and reader. */
export function sealedIdleFrames(root: string, project: JsonObject, n: number): { path: string; sha256: string } | undefined {
  const version = asArray(project.versions).filter(isObject).find(v => v.n === n);
  if (version?.kind !== 'rig') return undefined;
  const idle = isObject(version.registration) ? version.registration.idle : undefined;
  if (idle === undefined) return undefined;
  const recordPath = `versions[v${n}].registration.idle`;
  if (!isObject(idle) || typeof idle.path !== 'string' || typeof idle.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(idle.sha256)) {
    refuse('JOB_PUBLICATION_FRAMES_CHANGED', `${recordPath}: idle frames binding is malformed; restore the recorded {path, sha256} binding and retained frames.json bytes before publishing`);
  }
  assertPublicationPath(idle.path);
  let bytes: Buffer;
  try { bytes = publicationFile(root, idle.path); }
  catch { refuse('JOB_PUBLICATION_FRAMES_CHANGED', `${recordPath}: ${idle.path} is missing or unreadable; restore the retained frames.json bytes before publishing`); }
  if (jobHash(bytes) !== idle.sha256) {
    refuse('JOB_PUBLICATION_FRAMES_CHANGED', `${recordPath}: ${idle.path} differs from its recorded sha256; restore the retained frames.json bytes before publishing`);
  }
  return { path: idle.path, sha256: idle.sha256 };
}

/** A manifest over the existing frozen model/direction, with project-relative paths.
 * Source documents and compiled producer output remain byte-identical.
 */
export function prepareLiveManifest(root: string, project: JsonObject, n: number, warnings: Finding[] = []): string {
  const selected = liveManifestPath(root, project, n);
  if (selected !== `review-live-v${n}.json`) return selected;
  const selector = publicationSelector(project, n);
  const rig = selector.kind === 'post' ? selector.rigVersion : n;
  let model = `derived/review/v${rig}/out/check/build/skeleton.model.json`;
  const frames = selector.kind === 'rig' ? sealedIdleFrames(root, project, n)?.path : undefined;
  let scene: string | undefined;
  let composed = false;
  if (selector.kind === 'post') {
    const directionPath = `evidence/direction/v${n}.json`;
    let direction: JsonObject | undefined;
    try { direction = JSON.parse(publicationFile(root, directionPath).toString('utf8')) as JsonObject; } catch { /* Legacy manifests did not require a direction document. */ }
    if (direction?.schema === DIRECTION_COMPOSE_SPEC) {
      composed = true;
      const { doc } = composedPublishedBuildFiles(root, project, n);
      model = String((doc.model as JsonObject).path);
    }
    scene = sealedScene(root, project, directionPath, direction)?.path;
  }
  publicationFile(root, model);
  const legacyManifest = {
    schema: 'rig-review/1', id: `create-v${n}`, revision: `v${n}`,
    title: selector.kind === 'post' ? `post v${n} (rig v${rig})` : `rig v${n}`,
    model, ...(selector.kind === 'post' ? { direction: `evidence/direction/v${n}.json` } : {}),
    references: [], animations: [], checkpoints: [], authoring: [],
  };
  const path = `review-live-v${n}.json`;
  const existing = existsSync(join(root, path)) ? publicationFile(root, path) : undefined;
  // Reopening an exact old publication preserves both its bytes and its identity.
  const legacyBytes = Buffer.from(`${JSON.stringify(legacyManifest, null, 2)}\n`);
  const currentManifest = { ...legacyManifest, ...(frames ? { frames } : {}), ...(scene ? { scene } : {}) };
  const currentBytes = frames || scene ? Buffer.from(`${JSON.stringify(currentManifest, null, 2)}\n`) : legacyBytes;
  if (existing?.equals(legacyBytes) || existing?.equals(currentBytes)) return path;
  if (composed) {
    if (existing) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: ${path} already differs; restore the composed manifest`);
    writeFileSync(join(root, path), legacyBytes, { flag: 'wx' });
    return path;
  }
  // init permits projects without an original; publication did not require one.
  if (project.inputs === undefined || (Array.isArray(project.inputs) && project.inputs.length === 0)) {
    if (existing) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: ${path} already differs; preserve it and restore the writer-generated manifest`);
    writeFileSync(join(root, path), currentBytes, { flag: 'wx' });
    return path;
  }
  try { publishedSourcePainting(root, project, `versions[v${n}]`); }
  catch (error) {
    const findings = { dir: root, project, refusals: [] as Finding[], warnings: [] as Finding[] };
    checkInputs(findings);
    const legacy = findings.warnings.find(finding => finding.code === 'INPUT_WRITER_MISSING' && finding.path === `inputs[${sourcePaintingIndex(project, `versions[v${n}]`)}]`);
    if (!legacy) throw error;
    if (existing) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: ${path} already differs; preserve it and restore the writer-generated manifest`);
    warnings.push(legacy);
    writeFileSync(join(root, path), currentBytes, { flag: 'wx' });
    return path;
  }
  const reference = originalPaintingReference(root, project, n);
  const manifest = { ...currentManifest, references: [reference] };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (existing) {
    const previous = Buffer.from(`${JSON.stringify({ ...legacyManifest, references: [reference] }, null, 2)}\n`);
    if (!existing.equals(bytes) && !existing.equals(previous)) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: ${path} already differs; preserve it and restore the writer-generated manifest`);
  } else writeFileSync(join(root, path), bytes, { flag: 'wx' });
  return path;
}

// Review main implements the field before its package version moves. Use its
// public error catalogue to detect the contract in source and registry builds.
const reviewJobErrors: readonly string[] = reviewJobHost.JOB_ERROR_CODES;
const supportsAnsweredDirectionFeedback = reviewJobErrors.includes('JOB_ANSWERED_DIRECTION_FEEDBACK_INVALID');

function answeredDirectionFeedbackContext(project: JsonObject, postVersion: number) {
  const jobId = isObject(project.review_job) ? project.review_job.jobId : undefined;
  if (!supportsAnsweredDirectionFeedback || typeof jobId !== 'string' || !jobId) return {};

  const versions = asArray(project.versions).filter(isObject);
  const post = versions.find(version => version.n === postVersion);
  const receipts = asArray(project.review_acts).filter(isObject);
  const answeredDirectionFeedback = asArray(post?.answers_feedback).filter(isObject).flatMap(ref => {
    if (typeof ref.version !== 'number' || ref.version >= postVersion || typeof ref.verdict !== 'number') return [];
    const earlier = versions.find(version => version.n === ref.version && version.kind === 'post');
    const verdict = asArray(earlier?.verdicts)[ref.verdict];
    if (!isObject(verdict) || verdict.review !== 'direction-review' || verdict.verdict !== 'bounced') return [];

    const matches = receipts.filter(row => row.schema === 'rig-create/review-act@1' && row.kind === undefined
      && row.version === ref.version && row.verdict === ref.verdict);
    const receipt = matches[0];
    if (matches.length !== 1 || receipt.jobId !== jobId || typeof receipt.actId !== 'string'
      || typeof receipt.bytes !== 'string' || jobHash(receipt.bytes) !== receipt.sha256) return [];
    try {
      const act = decodeReviewAct(receipt.bytes);
      if (act.jobId !== jobId || act.actId !== receipt.actId || act.source.selector?.kind !== 'post'
        || act.source.selector.version !== ref.version
        || !isDeepStrictEqual(verdict, reviewActVerdict(act, retainedActBy(act, verdict.by)))) return [];
      return [{ jobId, actId: act.actId }];
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return [];
    }
  });
  return answeredDirectionFeedback.length ? { answeredDirectionFeedback } : {};
}

/** Actual public create read contract, called only under the writer's freeze. */
export const readPublished: JobPublicationReader = async ({ root, record, result }): Promise<JobPublishedContext> => {
  const bytes = publicationFile(root, record.path);
  if (record.path !== 'project.json' || jobHash(bytes) !== record.sha256 || !result.selector) {
    refuse('JOB_PUBLICATION_INVALID', 'project.json: publication requires the exact committed rig/post record; restore its bound bytes');
  }
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  if (result.selector.kind === 'draft') return readDraftPublished(root, project, result.selector.id, result.path);
  const selector = publicationSelector(project, result.selector.version);
  if (!isDeepStrictEqual(selector, result.selector) || result.path !== liveManifestPath(root, project, selector.version)) {
    refuse('JOB_PUBLICATION_INVALID', 'project.json: publication result differs from its recorded version; restore the writer result');
  }
  const answered = selector.kind === 'post' ? answeredDirectionFeedbackContext(project, selector.version) : {};
  if (selector.kind === 'post') {
    const directionPath = `evidence/direction/v${selector.version}.json`;
    let raw: JsonObject | undefined;
    try { raw = JSON.parse(publicationFile(root, directionPath).toString('utf8')); } catch { /* Legacy post path below. */ }
    if (raw?.schema === DIRECTION_COMPOSE_SPEC) {
      const { files } = composedPublishedBuildFiles(root, project, selector.version);
      files.push({ path: directionPath, sha256: jobHash(publicationFile(root, directionPath)) }, { path: result.path, sha256: jobHash(publicationFile(root, result.path)) });
      const steps = isObject(project.plan) ? asArray(project.plan.steps).filter(isObject) : [];
      return { selector, plan: { steps: steps.map(step => ({ id: String(step.id), hash: stepHash(step) })) }, parts: null,
        subjects: livePublicationSubjects(root, project, selector), partIds: [], files, ...answered };
    }
  }
  const rig = selector.kind === 'post' ? selector.rigVersion : selector.version;
  const rigVersion = (project.versions as JsonObject[]).find(version => version.n === rig);
  const packageRecord = rigVersion?.review_package as JsonObject | undefined;
  if (!Array.isArray(packageRecord?.files)) refuse('JOB_PUBLICATION_INVALID', `versions[v${rig}].review_package: retained package identity is missing; restore the recorded package before reconciling`);
  const packageFiles = packageRecord.files;
  const files = packageFiles.map(raw => {
    const identity = reviewPackageIdentity(rig, raw as JsonObject);
    const { path } = identity;
    if (jobHash(publicationFile(root, path)) !== identity.sha256) {
      refuse('JOB_PUBLICATION_INVALID', `versions[v${rig}].review_package: ${path} differs from its recorded hash; restore the retained bytes before reconciling`);
    }
    return { path, sha256: String(identity.sha256) };
  });
  // The package records its producer root. Its copied layout historically omits
  // sibling painting/mask PNGs, which the official enumerator still references.
  const partsRoot = typeof packageRecord.from === 'string' ? packageRecord.from : `derived/review/v${rig}/out`;
  const manifestPath = `${partsRoot}/parts.json`;
  const manifest = publicationFile(root, manifestPath);
  const retainedManifest = packageFiles.find(raw => (raw as JsonObject).path === 'out/parts.json') as JsonObject | undefined;
  if (retainedManifest?.sha256 !== jobHash(manifest)) refuse('JOB_PUBLICATION_INVALID', `versions[v${rig}].review_package.from: parts manifest differs from the retained package; restore the declared producer bytes`);
  const directory = dirname(join(root, manifestPath));
  let references: ReturnType<typeof partsFileReferences>;
  try { references = partsFileReferences(directory); }
  catch { refuse('JOB_PUBLICATION_INVALID', `versions[v${rig}].review_package.from: official Parts enumeration refused the manifest; restore the retained producer report before reconciling`); }
  const images = references.map(row => {
    const sha256 = jobHash(publicationFile(root, relative(root, resolve(directory, row.path)).split('\\').join('/')));
    const retained = packageFiles.find(raw => (raw as JsonObject).path === `out/${row.path}`) as JsonObject | undefined;
    if (retained && retained.sha256 !== sha256) refuse('JOB_PUBLICATION_INVALID', `versions[v${rig}].review_package.from: ${row.path} differs from its recorded package hash; restore the declared producer bytes`);
    return { ...row, sha256 };
  });
  if (selector.kind === 'rig' && result.path !== `review-live-v${selector.version}.json`) files.push(publishedSourcePainting(root, project, `versions[v${selector.version}]`));
  files.push({ path: result.path, sha256: jobHash(publicationFile(root, result.path)) });
  if (selector.kind === 'rig') {
    const idle = sealedIdleFrames(root, project, selector.version);
    if (idle) files.push(idle);
  }
  if (selector.kind === 'post') {
    const direction = `evidence/direction/v${selector.version}.json`;
    const version = (project.versions as JsonObject[]).find(version => version.n === selector.version)!;
    const binding = (version.provenance as JsonObject)?.direction as JsonObject | undefined;
    const sha256 = jobHash(publicationFile(root, direction));
    if (binding?.path !== direction || binding.sha256 !== sha256) refuse('JOB_PUBLICATION_INVALID', `versions[v${selector.version}].provenance.direction: retained direction changed; restore its recorded bytes before reconciling`);
    files.push({ path: direction, sha256 });
    let docDirection: JsonObject | undefined;
    try { docDirection = JSON.parse(publicationFile(root, direction).toString('utf8')) as JsonObject; } catch { /* Preserve the legacy direction publication contract. */ }
    const scene = sealedScene(root, project, direction, docDirection);
    if (scene) files.push(...scene.plates, { path: scene.path, sha256: scene.sha256 });
  }
  const plan = project.plan as JsonObject | undefined;
  const steps = Array.isArray(plan?.steps) ? plan.steps as JsonObject[] : [];
  const subjects = livePublicationSubjects(root, project, selector);
  return {
    selector, plan: { steps: steps.map(step => ({ id: String(step.id), hash: stepHash(step) })) },
    parts: { enumeratorVersion: partsEnumerator.version, manifest: { path: manifestPath, sha256: jobHash(manifest) }, images },
    ...(selector.kind === 'rig' ? rigChestLandmarks(root, rig, packageFiles) : {}),
    subjects, ...checkpointEvidenceContext(root, project, files),
    partIds: (JSON.parse(manifest.toString('utf8')).parts as { name: string }[]).map(part => part.name), files, ...answered,
  };
};

/** Review's published chest row type where the installed Review declares it; registry releases before act@9 drop the field. */
type PublishedChestLandmarks = JobPublishedContext extends { readonly chestLandmarks?: infer Rows } ? Rows : never;

/**
 * The rig build's own `meshes.<part>.contour.bust` specs (rig-c/review act@9), one row per chest part, sorted by
 * `skin/slot/attachment`. The spec is copied from the config the build read, never derived; the row binds that config's
 * hash, the part's setup attachment in the retained model (the default skin, the slot's `setup` attachment, the hash of
 * its stored entry) and the model stage. A config without a bust spec carries no field.
 */
function rigChestLandmarks(root: string, rig: number, packageFiles: Json[]): { chestLandmarks?: PublishedChestLandmarks } {
  const at = `versions[v${rig}].review_package`;
  const row = (name: string) => packageFiles.find(raw => isObject(raw) && raw.path === name) as JsonObject | undefined;
  const configRow = row('config.json');
  if (!configRow) return {};
  const config = JSON.parse(publicationFile(root, reviewPackageIdentity(rig, configRow).path).toString('utf8')) as Json;
  const meshes = isObject(config) && isObject(config.meshes) ? config.meshes : {};
  const chests = Object.entries(meshes).filter(([, entry]) => isObject(entry) && isObject(entry.contour) && Object.hasOwn(entry.contour, 'bust'));
  if (!chests.length) return {};
  const modelRow = row('out/check/build/skeleton.model.json');
  const model = modelRow ? JSON.parse(publicationFile(root, reviewPackageIdentity(rig, modelRow).path).toString('utf8')) as Json : undefined;
  const stage = isObject(model) && isObject(model.stage) ? model.stage : undefined;
  const skin = isObject(model) ? asArray(model.skins).filter(isObject).find(value => value.name === 'default') : undefined;
  const rows = chests.map(([slot, entry]) => {
    const setup = isObject(model) ? asArray(model.slots).filter(isObject).find(value => value.name === slot)?.setup : undefined;
    const attachments = isObject(skin?.attachments) ? skin.attachments[slot] : undefined;
    const attachment = typeof setup === 'string' && isObject(attachments) ? attachments[setup] : undefined;
    if (!stage || !isObject(attachment) || attachment.kind !== 'mesh') {
      refuse('JOB_PUBLICATION_INVALID', `${at}: config meshes.${slot}.contour.bust needs a setup mesh attachment for slot ${slot} in the retained model; rebuild the rig version from that config before publishing`);
    }
    return {
      slot, skin: 'default', attachment: setup as string, basis: 'setup',
      source: { hash: jobHash(JSON.stringify(attachment)), frame: { width: stage.width, height: stage.height }, configHash: String(configRow.sha256) },
      bust: structuredClone(((entry as JsonObject).contour as JsonObject).bust),
    };
  }).sort((a, b) => {
    const x = `${a.skin}/${a.slot}/${a.attachment}`, y = `${b.skin}/${b.slot}/${b.attachment}`;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { chestLandmarks: rows as unknown as PublishedChestLandmarks };
}

/** The same rig/post verdict asks are used for writer preflight and the sealed publication. */
export function livePublicationSubjects(
  root: string, project: JsonObject, selector: Exclude<JobSelector, { kind: 'draft' }>,
): JobPublishedContext['subjects'] {
  if (selector.kind === 'post') {
    return reviewVerdictSignable(project, selector.version, 'direction-review') ? [{ kind: 'review-verdict', stage: 'direction-review' }] : [];
  }
  const stage = effectiveStage(root, project);
  // Before rig-review the owner's approval could not be ingested, so the page omits that ask (#754).
  return rigVerdictIngestible(stage) && reviewVerdictSignable(project, selector.version, 'rig-review')
    ? [{ kind: 'review-verdict', stage: 'rig-review' }]
    : [];
}

export function publishedDraft(project: JsonObject, id: string): JsonObject {
  const drafts = Array.isArray(project.drafts) ? project.drafts as JsonObject[] : [];
  const found = drafts.filter(draft => draft.id === id);
  if (found.length !== 1) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: a unique retained draft is required; record a labelled draft with a new id`);
  return found[0];
}

/**
 * The input that holds the source painting: the one `project.painting` declares, or `inputs[0]` when nothing is
 * declared, so records made before the declaration existed publish unchanged. A declaration that names no
 * registered input refuses rather than falling back to position.
 */
export function sourcePaintingIndex(project: JsonObject, label: string): number {
  if (project.painting === undefined) return 0;
  const inputs = Array.isArray(project.inputs) ? project.inputs : [];
  const index = typeof project.painting === 'string' ? inputs.findIndex(input => isObject(input) && input.path === project.painting) : -1;
  if (index < 0) refuse('JOB_PUBLICATION_INVALID', `${label}: painting must name a registered input; restore the declaration written by init --painting, input add --painting or input painting before publishing`);
  return index;
}

export function publishedSourcePainting(root: string, project: JsonObject, label: string): { path: string; sha256: string } {
  const inputs = Array.isArray(project.inputs) ? project.inputs : [];
  const index = sourcePaintingIndex(project, label);
  const first = inputs[index];
  if (
    !isObject(first) ||
    typeof first.path !== 'string' ||
    !first.path.trim() ||
    first.path === 'project.json' ||
    first.path === '.input.lock' ||
    typeof first.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(first.sha256) ||
    (first.bytes !== undefined && (typeof first.bytes !== 'number' || !Number.isSafeInteger(first.bytes) || first.bytes < 0))
  ) {
    refuse('JOB_PUBLICATION_INVALID', `${label}: inputs[${index}] must record the original painting {path, sha256}; restore the declared inputs[${index}] entry in project.json before publishing`);
  }
  const path = first.path;
  const sha256 = first.sha256;
  const bytes = publicationFile(root, path);
  if (jobHash(bytes) !== sha256 || (typeof first.bytes === 'number' && bytes.length !== first.bytes)) {
    refuse('JOB_PUBLICATION_INVALID', `${label}: inputs[${index}] (${path}) differs from its registered sha256; restore the original painting bytes before publishing`);
  }
  return { path, sha256 };
}

type FileSeal = JobPublishedContext['files'][number];
type PreviousDraft = NonNullable<JobPublishedContext['previousDraft']>;
const PREVIOUS_DRAFT_SCHEMA = 'rig-review-previous-draft/1';

function stackPaths(root: string, manifestPath: string): string[] {
  return diffStackCandidates(resolve(root, manifestPath)).map(file => relative(root, file).split(sep).join('/'));
}

function retainedReport(root: string, binding: Json | undefined): JsonObject | undefined {
  try { return retainedJson(root, binding); } catch { return undefined; }
}

function stackBindings(root: string, project: JsonObject, draft: JsonObject, partsPath: string, candidates: string[]): JsonObject[] {
  const onCandidate = (row: JsonObject) => typeof row.path === 'string' && candidates.includes(row.path);
  const bound = asArray(draft.files).filter(isObject).filter(onCandidate);
  if (bound.length) return bound;

  // The shared map belongs to the stack named by the producer, not the draft currently being published.
  const maps = [project.diff_map, ...asArray(project.signoffs).filter(isObject)
    .filter(row => row.stage === 'parts-review' && row.checkpoint === null && row.draft_id === draft.id)
    .map(row => row.diff_map)];
  const measured = maps.filter(isObject).flatMap(map => {
    const report = retainedReport(root, map.report);
    if (!report || !reportShape(report) || !isObject(report.stack) || typeof report.stack.path !== 'string') return [];
    const row = { path: relative(root, resolve(root, report.stack.path)).split(sep).join('/'), sha256: report.stack.sha256 };
    return onCandidate(row) ? [row] : [];
  });
  if (measured.length) return measured;

  const partFiles = asArray((draft.parts as JsonObject).files).filter(isObject);
  const manifest = partFiles.find(row => row.path === `${partsPath}/parts.json`);
  const audited = manifest ? asArray(project.advances).flatMap((move, index) => {
    if (!isObject(move) || move.from_stage !== 'parts' || move.stage !== 'parts-review') return [];
    const binding = move.parts_check;
    if (!isObject(binding) || binding.parts !== partsPath || binding.spec !== PARTS_CHECK_SPEC
      || partsCheckFindings(root, binding, `advances[${index}].parts_check`, false).length) return [];
    const report = retainedReport(root, binding);
    const inputs = asArray(report?.inputs).filter(isObject).filter(row => row.status === 'read');
    if (!inputs.some(row => row.path === 'parts.json' && row.sha256 === manifest.sha256)) return [];
    return inputs.filter(row => row.path === 'recomposite_rig.png')
      .map(row => ({ path: `${partsPath}/${String(row.path)}`, sha256: row.sha256 }));
  }) : [];
  return [...partFiles.filter(onCandidate), ...audited];
}

function sealedStack(root: string, project: JsonObject, draft: JsonObject, rigSize: Json | undefined): FileSeal {
  const partsPath = String((draft.parts as JsonObject).path);
  const candidates = stackPaths(root, `${partsPath}/parts.json`);
  const bound = stackBindings(root, project, draft, partsPath, candidates);
  const row = bound[0];
  if (!row || typeof row.path !== 'string' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) {
    throw Error(`no bound SHA-256 for ${candidates.join(' or ')}`);
  }
  if (bound.some(other => other.path !== row.path || other.sha256 !== row.sha256)) throw Error('conflicting retained recomposite identities');
  const { path, sha256 } = row;
  const bytes = publicationFile(root, path);
  if (jobHash(bytes) !== sha256) throw Error(`${path} differs from its bound SHA-256`);
  const { width, height } = pngDimensions(bytes, path);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) throw Error(`${path} requires a noninterlaced RGBA8 producer PNG`);
  if (!Array.isArray(rigSize) || width !== rigSize[0] || height !== rigSize[1]) throw Error(`${path} does not match the current rig_size`);
  return { path, sha256 };
}

function previousDraftContext(root: string, project: JsonObject, id: string, manifest: FileSeal,
  files: FileSeal[], warnings: Finding[]): { previousDraft?: PreviousDraft } {
  if (Reflect.get(reviewJobHost, 'JOB_PREVIOUS_DRAFT_SCHEMA') !== PREVIOUS_DRAFT_SCHEMA) return {};
  const precedingId = previousPartsApproval(root, project, id)?.draft_id;
  if (typeof precedingId !== 'string') return {};
  const manifestBytes = publicationFile(root, manifest.path);
  if (jobHash(manifestBytes) !== manifest.sha256) {
    refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: ${manifest.path} differs from its publication seal; restore the retained parts manifest`);
  }
  const { rig_size: rigSize } = JSON.parse(manifestBytes.toString('utf8')) as { rig_size?: Json };
  let path = `drafts[${id}].files`;
  try {
    const current = sealedStack(root, project, publishedDraft(project, id), rigSize);
    path = `drafts[${precedingId}].files`;
    const preceding = publishedDraft(project, precedingId);
    const previous = sealedStack(root, project, preceding, rigSize);
    const previousDraft: PreviousDraft = { schema: PREVIOUS_DRAFT_SCHEMA,
      draft: { id: precedingId, revision: jobHash(`${JSON.stringify(preceding, null, 2)}\n`) }, composites: { current, previous } };
    if (current.path === previous.path && current.sha256 !== previous.sha256) throw Error('operands have conflicting seals for the same path');
    const operands = current.path === previous.path ? [current] : [current, previous];
    if (operands.some(row => files.some(file => file.path === row.path && file.sha256 !== row.sha256))) throw Error('closure contains a conflicting recomposite seal');
    files.push(...operands.filter(row => !files.some(file => file.path === row.path)));
    return { previousDraft };
  } catch (error) {
    warnings.push({ code: 'PREVIOUS_DRAFT_UNAVAILABLE', path,
      message: `${path}: previous-draft comparison omitted (${error instanceof Error ? error.message : String(error)}); restore the bound producer recomposite or register a new draft with its recomposite retained` });
    return {};
  }
}

/** Retain the official positional inventory, including duplicate paths/roles. */
export function draftPublishedContext(root: string, project: JsonObject, id: string): JobPublishedContext {
  const draft = publishedDraft(project, id);
  const painting = publishedSourcePainting(root, project, `drafts[${id}]`);
  const parts = draft.parts as JsonObject;
  const identities = [draft.config, ...(draft.config_inputs as JsonObject[] ?? []), ...(parts.files as JsonObject[]), ...(draft.files as JsonObject[])];
  const files = identities.map(raw => {
    const identity = raw as JsonObject;
    const path = String(identity.path), sha256 = String(identity.sha256);
    if (jobHash(publicationFile(root, path)) !== sha256) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: ${path} differs from its retained hash; restore the draft or record a new id`);
    return { path, sha256 };
  });
  if (!files.some(file => file.path === painting.path)) files.push(painting);
  const manifestPath = `${String(parts.path)}/parts.json`;
  const manifest = publicationFile(root, manifestPath);
  const directory = dirname(join(root, manifestPath));
  const images = partsEnumerator.enumerate(directory).map(row => ({ ...row,
    sha256: jobHash(publicationFile(root, relative(root, resolve(directory, row.path)).split('\\').join('/'))) }));
  const plan = project.plan as JsonObject | undefined;
  return { selector: { kind: 'draft', id }, plan: plan ? { steps: (plan.steps as JsonObject[] ?? []).map(step => ({ id: String(step.id), hash: stepHash(step) })) } : null,
    parts: { enumeratorVersion: partsEnumerator.version, manifest: { path: manifestPath, sha256: jobHash(manifest) }, images },
    subjects: latestPartsApproval(project, Infinity, undefined, id) ? [] : [{ kind: 'parts-verdict', draftId: id }],
    partIds: (JSON.parse(manifest.toString('utf8')).parts as { name: string }[]).map(part => part.name), files };
}

function draftManifest(root: string, project: JsonObject, draft: JsonObject, parts: NonNullable<JobPublishedContext['parts']>, rigging: boolean) {
  const id = String(draft.id);
  const painting = publishedSourcePainting(root, project, `drafts[${id}]`);
  const files = draft.files as JsonObject[];
  const models = files.filter(file => String(file.path).endsWith('/skeleton.model.json'));
  if (models.length > 1) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: multiple compiled models are ambiguous; retain one draft output`);
  const revision = jobHash(`${JSON.stringify(draft, null, 2)}\n`);
  const identity = draftPackageIdentity(id, rigging);
  const legacyManifest = { schema: 'rig-review/1', id: identity.id, revision, title: `draft ${id}`,
    ...(models.length ? { model: models[0].path } : {}),
    references: parts.images.map((image, index) => ({ id: `image-${index}`, label: `${image.role} ${image.path}`, type: 'image',
      path: relative(root, resolve(root, dirname(parts.manifest.path), image.path)).split('\\').join('/') })),
    animations: [], checkpoints: [], authoring: files.filter(file => /\/(rig|motion|mesh_report)\.json$/.test(String(file.path)))
      .map(file => ({ label: String(file.path).split('/').at(-1), path: file.path })) };
  const producer = { config: String((draft.config as JsonObject).path), parts: String((draft.parts as JsonObject).path), source: painting.path };
  const panels = { schema: 'rig-review/panels@1', left: ['parts.list'], stage: ['parts.canvas'], toolbar: ['parts.layers'], side: ['parts.issues', 'act.submit'] };
  const manifest = { ...legacyManifest, producer, panels };
  return { identity, legacyManifest, panels, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
}

export function prepareDraftManifest(root: string, project: JsonObject, id: string, path?: string): string {
  const context = draftPublishedContext(root, project, id);
  const draft = publishedDraft(project, id);
  const rigging = path === undefined
    ? riggingDraftOutput(draft)?.kind === 'mesh' && effectiveStage(root, project) === 'rigging'
    : path === draftPackageIdentity(id, true).path;
  const { identity, legacyManifest, panels, bytes } = draftManifest(root, project, draft, context.parts!, rigging);
  if ((path !== undefined && path !== identity.path) || (rigging && riggingDraftOutput(draft)?.kind !== 'mesh')) {
    refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: result path differs from its draft publication; restore the writer manifest`);
  }
  path = identity.path;
  const legacyPanelsBytes = Buffer.from(`${JSON.stringify({ ...legacyManifest, panels }, null, 2)}\n`);
  const legacyBytes = Buffer.from(`${JSON.stringify(legacyManifest, null, 2)}\n`);
  if (existsSync(join(root, path))) {
    const existing = publicationFile(root, path);
    if (!existing.equals(bytes)) {
      let orphaned = false;
      try {
        const retained: unknown = JSON.parse(existing.toString('utf8'));
        if (isObject(retained as Json)) {
          const prior = retained as JsonObject;
          const revisions = asArray(project.drafts).filter(isObject).map(item => jobHash(`${JSON.stringify(item, null, 2)}\n`));
          orphaned = prior.schema === 'rig-review/1' && prior.id === identity.id
            && typeof prior.revision === 'string' && /^[a-f0-9]{64}$/.test(prior.revision)
            && !revisions.includes(prior.revision)
            && !pendingPublications(root).some(entry => !isRecordResult(entry.result)
              && entry.result.path === path && entry.versionHash === prior.revision);
        }
      } catch { /* An unreadable manifest is never evidence of an orphaned revision. */ }
      if (!orphaned && (rigging || !existing.equals(legacyPanelsBytes) && !existing.equals(legacyBytes))) {
        refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: retained publication manifest differs; restore it before reconciling, or run rig-create job close --retire-refused to retire a refused publication`);
      }
      const target = join(root, path);
      const tmp = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, bytes, { flag: 'wx' });
        renameSync(tmp, target);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  } else writeFileSync(join(root, path), bytes, { flag: 'wx' });
  return path;
}

/** The rigging manifest has one canonical form, including its authoring and image paths. */
export function riggingDraftManifestBytes(root: string, project: JsonObject, draft: JsonObject, parts: NonNullable<JobPublishedContext['parts']>): Buffer {
  const { identity, bytes } = draftManifest(root, project, draft, parts, true);
  const retained = publicationFile(root, identity.path);
  if (riggingDraftOutput(draft)?.kind !== 'mesh' || !retained.equals(bytes)) {
    refuse('JOB_PUBLICATION_INVALID', `drafts[${String(draft.id)}]: rigging draft manifest or mesh inventory differs; restore the writer manifest and its recorded rig files`);
  }
  return retained;
}

export function compiledDraftManifestBytes(root: string, project: JsonObject, draft: JsonObject, parts: NonNullable<JobPublishedContext['parts']>): Buffer {
  const { identity, bytes } = draftManifest(root, project, draft, parts, false);
  const retained = publicationFile(root, identity.path);
  if (!retained.equals(bytes)) refuse('JOB_PUBLICATION_INVALID', `drafts[${String(draft.id)}]: compiled draft manifest differs; restore the writer manifest`);
  return retained;
}

/** Register inventory early; ask for approval only after agent evidence and the advance. */
export function draftPublicationContext(root: string, project: JsonObject, id: string, warnings: Finding[] = []): JobPublishedContext {
  return inspectDraftPublication(root, project, id, warnings).context;
}

export function inspectDraftPublication(root: string, project: JsonObject, id: string, warnings: Finding[] = [], stage = effectiveStage(root, project)) {
  const draft = publishedDraft(project, id);
  const change = riggingDraftPartsChange(root, project, draft, stage);
  if (change) refuse(change.code, change.message);
  const rigging = stage === 'rigging' && riggingDraftOutput(draft)?.kind === 'mesh';
  return describeDraftPublication(root, project, id, warnings, stage, rigging);
}

function describeDraftPublication(root: string, project: JsonObject, id: string, warnings: Finding[], stage: string | null, rigging: boolean): {
  context: JobPublishedContext;
  missingStructure: string | undefined;
  diffFinding: Finding | undefined;
  rigging: boolean;
} {
  // Validate the mandatory closure before looking for optional comparison evidence.
  const context = draftPublishedContext(root, project, id);
  let subjects = [...context.subjects];
  const errors: Finding[] = [];
  if (stage === 'parts-review') {
    checkDiffMap(root, { stage: 'parts-review', checkpoint: null, draft_id: id }, `signoffs[${asArray(project.signoffs).length}]`,
      resolve(root, context.parts!.manifest.path), errors, [], project);
    if (errors.length) {
      warnings.push(...errors);
      subjects = subjects.filter(subject => subject.kind !== 'parts-verdict');
    }
  }
  const structure = stage === 'parts-review' ? partsStructureSnapshot(root, project, id) : undefined;
  const missingStructure = structure && !structure.valid && context.subjects.some(subject => subject.kind === 'parts-verdict')
    ? structure.path : undefined;
  if (stage !== 'parts-review' || missingStructure !== undefined) subjects = subjects.filter(subject => subject.kind !== 'parts-verdict');
  if (rigging) subjects.unshift({ kind: 'parts-verdict', draftId: id });
  else if (stage === 'rigging' && eligibleRigDraftModel(publishedDraft(project, id))) {
    subjects.unshift({ kind: 'review-verdict', stage: 'rig-review' });
  }
  const files = [...context.files];
  const checkpoints = checkpointEvidenceContext(root, project, files);
  const comparison = previousDraftContext(root, project, id, context.parts!.manifest, files, warnings);
  return { context: { ...context, subjects, files, ...checkpoints, ...comparison }, missingStructure, diffFinding: errors[0], rigging };
}

function readDraftPublished(root: string, project: JsonObject, id: string, path: string): JobPublishedContext {
  const rigging = path === draftPackageIdentity(id, true).path;
  if (!rigging && path !== draftPackageIdentity(id).path) {
    refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: result path differs from its publication; restore the writer manifest`);
  }
  // Retain the reader for already-issued publications and their acknowledged acts.
  const stage = effectiveStage(root, project);
  const eligible = rigging && stage === 'rigging' && riggingDraftOutput(publishedDraft(project, id))?.kind === 'mesh';
  const { context } = describeDraftPublication(root, project, id, [], stage, eligible);
  if (rigging && !eligible) {
    refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: rigging mesh feedback needs the current model-less rigging draft; publish it at rigging or open the current review`);
  }
  const manifest = rigging ? riggingDraftManifestBytes(root, project, publishedDraft(project, id), context.parts!) : publicationFile(root, path);
  return { ...context, files: [...context.files, { path, sha256: jobHash(manifest) }] };
}

/** The stage the check reads the published record in: the stage its `signoff` and `checkpoint` subjects sign. */
function effectiveStage(root: string, project: JsonObject): string | null {
  return checkProject(root, project, { now: Date.now(), readOnly: true }).effective_stage;
}

/** Optional, append-only legacy-to-painting upgrade. Absent history retains the old contract. */
export function liveManifestPath(root: string, project: JsonObject, n: number, identity?: { readonly id: string; readonly revision: string }): string {
  const version = asArray(project.versions).filter(isObject).find(v => v.n === n);
  const history = version?.publication_generations;
  const legacy = `review-live-v${n}.json`;
  if (history === undefined) return legacy;
  const fail = (): never => refuse('PUBLICATION_GENERATION_INVALID', `versions[v${n}].publication_generations: broken generation chain; restore the immutable predecessor, manifest hashes, timestamp and reason`);
  if ((version?.kind !== 'rig' && version?.kind !== 'post') || !Array.isArray(history) || history.length !== 1) return fail();
  const entry = history[0];
  if (!isObject(entry) || entry.generation !== 2 || !isObject(entry.supersedes) || !isObject(entry.manifest) ||
      entry.supersedes.generation !== 1 || entry.supersedes.path !== legacy || entry.manifest.path !== `review-live-v${n}-g2.json` ||
      typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)) || new Date(entry.at).toISOString() !== entry.at || typeof entry.reason !== 'string' || !entry.reason.trim()) return fail();
  let selected = entry.manifest.path;
  try {
    const old = publicationFile(root, legacy), bytes = publicationFile(root, entry.manifest.path);
    if (jobHash(old) !== entry.supersedes.sha256 || jobHash(bytes) !== entry.manifest.sha256) return fail();
    const previous = JSON.parse(old.toString('utf8'));
    const current = JSON.parse(bytes.toString('utf8'));
    if (version.kind === 'post') {
      const directionPath = `evidence/direction/v${n}.json`;
      const directionBytes = publicationFile(root, directionPath);
      const binding = isObject(version.provenance) ? version.provenance.direction : undefined;
      if (!isObject(binding) || binding.path !== directionPath || binding.sha256 !== jobHash(directionBytes)) return fail();
      const direction = JSON.parse(directionBytes.toString('utf8')) as JsonObject;
      const scene = direction.scene;
      if (direction.schema !== 'rig-create/direction@2' || !isObject(scene) || typeof scene.path !== 'string' ||
          !asArray(project.scenes).filter(isObject).some(value => value.n === scene.n && value.path === scene.path && value.sha256 === scene.sha256) ||
          jobHash(publicationFile(root, scene.path)) !== scene.sha256) return fail();
      if (previous.schema !== 'rig-review/1' || previous.id !== `create-v${n}` || previous.revision !== `v${n}` ||
          previous.model !== `derived/review/v${String(version.rig_version)}/out/check/build/skeleton.model.json` ||
          previous.direction !== directionPath || previous.scene !== undefined || !Array.isArray(previous.references) ||
          !isDeepStrictEqual(current, { ...previous, revision: `v${n}-g2`, scene: scene.path })) return fail();
      return identity && previous.id === identity.id && previous.revision === identity.revision ? legacy : selected;
    }
    if (previous.schema !== 'rig-review/1' || previous.model !== `derived/review/v${n}/out/check/build/skeleton.model.json` || previous.id !== `create-v${n}` || previous.revision !== `v${n}`) return fail();
    if (!Array.isArray(previous.references) || previous.references.length !== 0 ||
        !isDeepStrictEqual(current, { ...previous, revision: `v${n}-g2`, references: [originalPaintingReference(root, project, n)] })) return fail();
    if (identity && previous.id === identity.id && previous.revision === identity.revision) selected = legacy;
  } catch { return fail(); }
  return selected;
}

export function checkPublicationGenerations(root: string, project: JsonObject, refusals: Finding[]): void {
  for (const version of asArray(project.versions).filter(isObject)) {
    if (version.publication_generations === undefined) continue;
    try { liveManifestPath(root, project, Number(version.n)); }
    catch (error) {
      if (!(error instanceof Refusal)) throw error;
      refusals.push({ code: error.code, path: `versions[v${String(version.n)}].publication_generations`, message: error.message });
    }
  }
}
