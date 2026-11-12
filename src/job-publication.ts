import { checkInputs } from './inputs.ts';
import { pngDimensions } from './scene.ts';
import { checkpointRequired } from './plan-history.ts';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { partsFileReferences } from '@rig-c/parts/src/parts.ts';
import partsPackage from '@rig-c/parts/package.json';
import { JOB_ACT_SCHEMA, JOB_API_SCHEMA, type JobPublicationReader, type JobPublishedContext, type JobSelector } from '@rig-c/review/job-host';
import { stepHash } from './step-hash.ts';
import { checkpointEvidenceContext, type CheckpointEvidence } from './checkpoint-evidence.ts';
import { locateParts, PARTS_PACKAGE } from './parts-sections.ts';
import { asArray, checkProject, collectItems, isObject, loadCollection, postNotPassed, type Finding } from './check.ts';
import { checkDiffMap } from './diff-map.ts';
import {
  COLLECTION_BINDING_SPEC,
  isLiveMemberRoot,
  isValidCollectionBindingPath,
  projectUsesCollection,
  verifyCollectionBinding,
  withCandidateProject,
} from './collection-binding-reader.ts';
import { optionContextFiles, optionFile, validateContext } from './choices.ts';
import { approvalStageOfStep, hasStageOrder, interviewStageOfGuide, stageOfStep } from './stages.ts';
import { selectAnswerHashes } from './signoff-answers.ts';
import { packageSignSubjects, stageSignable } from './signable.ts';
import { latestPartsApproval, riggingContext } from './structure.ts';
import { jobHash, pendingPublications, isRecordResult, type JobIdentity } from './job-outbox.ts';
import { Refusal, refuse } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export const JOB_READER_ID = 'rig-create/publication-reader/2';
export const JOB_BINDING_ID = 'rig-create/writer-binding/1';
export const JOB_ENUMERATOR_ID = 'rig-create/parts-file-references/1';
export const partsEnumerator = { version: partsPackage.version, enumerate: partsFileReferences };

/** The parts the check loads: its name and version, and that version's integrity from the lockfile beside its install. */
export interface RecordPartsIdentity { readonly name: string; readonly version: string; readonly integrity: string }

export interface RecordPublicationRequest {
  readonly root: string;
  readonly record: { readonly path: 'project.json'; readonly sha256: string };
  readonly result: { readonly kind: 'option-set'; readonly questionId: string; readonly setId: string } | { readonly kind: 'plan' };
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
type RecordSignoffStage = 'plan-approved' | 'rigging-interview' | 'post-interview';
type RecordPlanSubject = { readonly kind: 'checkpoint'; readonly checkpointId: string }
  | { readonly kind: 'signoff'; readonly stage: RecordSignoffStage };
export type RecordOptionContext = RecordContextBase & {
  readonly plan: null;
  readonly subjects: readonly [{ readonly kind: 'interview-picks'; readonly questionId: string; readonly setId: string }];
};
export type RecordPlanContext = RecordContextBase & {
  readonly checkpointEvidence?: readonly CheckpointEvidence[];
  readonly plan: NonNullable<JobPublishedContext['plan']>;
  readonly subjects: readonly RecordPlanSubject[];
};
export type RecordPublishedContext = RecordOptionContext | RecordPlanContext;

export class RecordClosureIncomplete extends Refusal {
  constructor(readonly details: readonly { code: string; path: string }[]) {
    super('JOB_RECORD_CLOSURE_INCOMPLETE', 'project.json: the retained check refuses while its sealed files match, so the retained root lacks or changed a file of the inventory closure; restore the complete inventory closure before finalization');
  }
}

/** The lockfile entries for parts beside `base/node_modules`: bun.lock and package-lock.json, each one that exists. */
function lockedParts(base: string): { file: string; version: unknown; integrity: unknown }[] {
  const entries: { file: string; version: unknown; integrity: unknown }[] = [];
  const bun = join(base, 'bun.lock');
  if (existsSync(bun)) {
    let entry: unknown;
    try { entry = (Bun.JSONC.parse(readFileSync(bun, 'utf8')) as { packages?: Record<string, unknown> }).packages?.[PARTS_PACKAGE]; } catch { entry = undefined; }
    const spec = Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].startsWith(`${PARTS_PACKAGE}@`) ? entry[0].slice(PARTS_PACKAGE.length + 1) : undefined;
    entries.push({ file: 'bun.lock', version: spec, integrity: Array.isArray(entry) ? entry.at(-1) : undefined });
  }
  const npm = join(base, 'package-lock.json');
  if (existsSync(npm)) {
    let entry: unknown;
    try { entry = (JSON.parse(readFileSync(npm, 'utf8')) as { packages?: Record<string, unknown> }).packages?.[`node_modules/${PARTS_PACKAGE}`]; } catch { entry = undefined; }
    entries.push({ file: 'package-lock.json', version: isObject(entry as Json) ? (entry as JsonObject).version : undefined, integrity: isObject(entry as Json) ? (entry as JsonObject).integrity : undefined });
  }
  return entries;
}

/**
 * The identity of the parts `checkProject(dir)` loads (`locateParts`): the installed version and the
 * integrity every lockfile beside that install records for it. Never the version alone.
 */
export function loadedPartsIdentity(dir: string, who: 'project' | 'host'): RecordPartsIdentity {
  const missing = (why: string): never => refuse('JOB_RECORD_PARTS_LOCK_MISSING', `project.json: the ${who}'s ${PARTS_PACKAGE} ${why}; install it from a lockfile that records its integrity and publish again`);
  const installed = locateParts(dir);
  if (installed === null) return missing('is not installed');
  let version: unknown;
  try { version = (JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { version?: unknown }).version; } catch { version = undefined; }
  if (typeof version !== 'string') return missing(`at ${installed} has no readable version`);
  const base = dirname(dirname(dirname(installed)));
  const entries = lockedParts(base);
  if (!entries.length) return missing(`${version} has no lockfile beside its install`);
  const integrities = new Set<string>();
  for (const entry of entries) {
    if (entry.version !== version || typeof entry.integrity !== 'string' || !/^sha(256|384|512)-/.test(entry.integrity)) {
      return missing(`${version} has no matching ${entry.file} entry with an integrity`);
    }
    integrities.add(entry.integrity);
  }
  if (integrities.size !== 1) return missing(`${version} has different integrities in bun.lock and package-lock.json`);
  return { name: PARTS_PACKAGE, version, integrity: [...integrities][0]! };
}

/** Reuse check's eligibility and the exact retained evidence of its subject. No writes or locks. */
export function readRecordPublished(input: RecordPublicationRequest & { result: Extract<RecordPublicationRequest['result'], { kind: 'option-set' }> }, now?: number): RecordOptionContext;
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
    const ids = result.kind === 'option-set' ? [result.questionId, result.setId] : steps.map(step => step.id);
    if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) {
      refuse('JOB_RECORD_SUBJECT_INVALID', 'project.json: a requested question, set or displayed step id is outside the record publication id domain; retain a representable producer id without aliases');
    }
    let selectedSet: JsonObject | undefined;
    if (result.kind === 'option-set') {
      const matches = items.filter(item => item.id === result.questionId);
      if (matches.length !== 1) throw Error('the requested question is absent or ambiguous');
      const binding = matches[0].record.pending_options;
      // A question whose pick is already recorded has no pending set to publish.
      if (!isObject(binding)) refuse('JOB_RECORD_SUBJECT_INVALID', 'project.json: the requested question has no pending option set; publish the exact current pending set');
      seal(binding);
      selectedSet = optionFile(root, binding).set;
      sealContext(selectedSet.context as JsonObject);
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
    const report = checkProject(root, project, { now, readOnly: true, recordReads: true, recordPublication: true });
    for (const { path, sha256 } of report.reads ?? []) seal({ path, sha256 });
    // A pick is how an open interview receives its first answer. Its own silent
    // questions are todos, as in next/advance; they are not a plan-approval waiver.
    const openQuestions = result.kind === 'option-set' && ['interview', 'rigging-interview', 'post-interview'].includes(String(report.effective_stage))
      ? new Set(items.filter(item => item.state.state === 'silent'
        && interviewStageOfGuide(item.id, item.kind === 'post', hasStageOrder(project)) === report.effective_stage).map(item => item.path))
      : new Set<string>();
    const blocking = report.refusals.filter(finding => finding.code !== 'INTERVIEW_INCOMPLETE' || !openQuestions.has(finding.path));
    if (blocking.length && phase === 'retained') {
      throw new RecordClosureIncomplete(blocking.map(({ code, path }) => ({ code, path })));
    }
    // A record publication necessarily owns an outbox entry while its official reader
    // inventories it. Ignore only that exact record/result's pending transport hole;
    // an unrelated, stale or malformed outbox continues to block publication.
    const pending = phase === 'inventory' ? pendingPublications(root) : [];
    const ownPending = pending.length > 0 && pending.every(entry => entry.phase === 'pending'
      && entry.recordHash === record.sha256 && isRecordResult(entry.result) && isDeepStrictEqual(entry.result, result));
    const holes = ownPending ? report.holes?.filter(hole => hole.code !== 'JOB_PUBLISH_PENDING') : report.holes;
    const finding = blocking[0] ?? holes?.[0];
    if (finding) throw Error(`${finding.code} at ${finding.path}`);
    const stage = report.effective_stage;
    let subjects: RecordPlanSubject[] = [];
    let label: string;
    if (result.kind === 'option-set') {
      const set = selectedSet!;
      if (set.id !== result.setId || set.question !== result.questionId || set.stage !== stage) {
        refuse('JOB_RECORD_SUBJECT_INVALID', 'project.json: requested option set does not match its question, set id and effective stage; publish the exact current pending set');
      }
      withCandidateProject(root, project, () => validateContext(root, project, set, now, true));
      label = `option-set ${result.questionId} / ${result.setId}`;
    } else if (result.kind === 'plan') {
      if (!plan) throw Error('the requested plan is absent');
      const planPhase = stage === 'post-interview' ? 'post' : 'rig';
      const covered = steps.filter(step => step.phase === planPhase && approvalStageOfStep(planPhase, String(step.id), hasStageOrder(project) || stage === 'rigging-interview') === stage);
      const signable = stage !== null && ['plan-approved', 'rigging-interview', 'post-interview'].includes(stage) && stageSignable(project, stage);
      const emptyPost = stage === 'post-interview' && !steps.some(step => step.phase === 'post') && postNotPassed({ items });
      if (signable && !covered.length && !emptyPost) throw Error('the requested plan has no steps at this approval stage');
      const signature: JsonObject = { stage, steps: covered.map(step => step.id!) };
      if (signable) withCandidateProject(root, project, () => selectAnswerHashes(root, project, signature));
      if (signable && stage === 'rigging-interview') {
        const errors: Parameters<typeof riggingContext>[3] = [];
        const context = withCandidateProject(root, project, () => riggingContext(root, project, new Date(now).toISOString(), errors));
        if (errors.length || !context) throw Error(errors[0]?.code ?? 'rigging evidence is missing');
      }
      subjects = steps.filter(step => {
        if (step.status !== 'at-checkpoint' || (step.phase !== 'rig' && step.phase !== 'post') || stageOfStep(step.phase, String(step.id)) !== stage) return false;
        return checkpointRequired(project, step, now);
      }).map(step => ({ kind: 'checkpoint' as const, checkpointId: String(step.id) }));
      if (signable) subjects = [...subjects, { kind: 'signoff', stage: stage as RecordSignoffStage }];
      label = `plan / ${stage}`;
    } else throw Error('unknown record result');
    // Detect record changes during closure reads as well as changes before entry.
    if (!publicationFile(root, record.path).equals(bytes)) throw Error('project.json changed while reading its closure');
    const files = [...seals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, sha256]) => ({ path, sha256 }));
    if (result.kind === 'option-set') {
      return { label, parts, inputs, files, plan: null,
        subjects: [{ kind: 'interview-picks', questionId: result.questionId, setId: result.setId }] };
    }
    const evidence = checkpointEvidenceContext(root, project, subjects, files);
    return { label, parts, inputs, files, ...evidence,
      plan: { steps: steps.map(step => ({ id: String(step.id), hash: stepHash(step) })) }, subjects };
  } catch (error) {
    if (error instanceof Refusal && (phase === 'retained' || ['JOB_RECORD_SUBJECT_INVALID', 'JOB_RECORD_COLLECTION_EXTERNAL', 'JOB_RECORD_PARTS_LOCK_MISSING'].includes(error.code))) throw error;
    refuse('JOB_RECORD_INCOMPLETE', `project.json: ${error instanceof Error ? error.message : String(error)}; restore the requested record and retained evidence, resolve check refusals and reconcile pending publications before publishing`);
  }
}

export function currentJobIdentity(saved: Pick<JobIdentity, 'root' | 'stateDir' | 'fingerprint' | 'reviewer' | 'publicationMode'>, root: string): JobIdentity {
  return { ...saved, root: realpathSync(root), readerId: JOB_READER_ID, bindingId: JOB_BINDING_ID,
    partsEnumeratorId: JOB_ENUMERATOR_ID, apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA,
    enumeratorVersion: partsEnumerator.version };
}

export function publicationFile(root: string, path: string): Buffer {
  if (!path || path.split('/').some(piece => !piece || piece === '.' || piece === '..') || /[\\:%?#\x00-\x1f]/.test(path)) {
    refuse('JOB_PUBLICATION_INVALID', 'project.json: publication references an unsafe path; restore its literal project-relative source');
  }
  const absolute = join(root, path);
  let regular = false;
  try { regular = realpathSync(absolute) === absolute && lstatSync(absolute).isFile(); } catch { /* Named below. */ }
  if (!regular) {
    refuse('JOB_PUBLICATION_INVALID', `project.json: ${path} must be a regular source without symlinks; restore its retained bytes`);
  }
  return readFileSync(absolute);
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

/** A manifest over the existing frozen model/direction, with project-relative paths.
 * Source documents and compiled producer output remain byte-identical.
 */
export function prepareLiveManifest(root: string, project: JsonObject, n: number, warnings: Finding[] = []): string {
  const selected = liveManifestPath(root, project, n);
  if (selected !== `review-live-v${n}.json`) return selected;
  const selector = publicationSelector(project, n);
  const rig = selector.kind === 'post' ? selector.rigVersion : n;
  const model = `derived/review/v${rig}/out/check/build/skeleton.model.json`;
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
  if (existing?.equals(legacyBytes)) return path;
  // init permits projects without an original; publication did not require one.
  if (project.inputs === undefined || (Array.isArray(project.inputs) && project.inputs.length === 0)) {
    if (existing) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: ${path} already differs; preserve it and restore the writer-generated manifest`);
    writeFileSync(join(root, path), legacyBytes, { flag: 'wx' });
    return path;
  }
  try { publishedSourcePainting(root, project, `versions[v${n}]`); }
  catch (error) {
    const findings = { dir: root, project, refusals: [] as Finding[], warnings: [] as Finding[] };
    checkInputs(findings);
    const legacy = findings.warnings.find(finding => finding.code === 'INPUT_WRITER_MISSING' && finding.path === 'inputs[0]');
    if (!legacy) throw error;
    if (existing) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: ${path} already differs; preserve it and restore the writer-generated manifest`);
    warnings.push(legacy);
    writeFileSync(join(root, path), legacyBytes, { flag: 'wx' });
    return path;
  }
  const manifest = { ...legacyManifest, references: [originalPaintingReference(root, project, n)] };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (existing) {
    if (!existing.equals(bytes)) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: ${path} already differs; preserve it and restore the writer-generated manifest`);
  } else writeFileSync(join(root, path), bytes, { flag: 'wx' });
  return path;
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
  const rig = selector.kind === 'post' ? selector.rigVersion : selector.version;
  const rigVersion = (project.versions as JsonObject[]).find(version => version.n === rig);
  const packageRecord = rigVersion?.review_package as JsonObject | undefined;
  if (!Array.isArray(packageRecord?.files)) refuse('JOB_PUBLICATION_INVALID', `versions[v${rig}].review_package: retained package identity is missing; restore the recorded package before reconciling`);
  const packageFiles = packageRecord.files;
  const files = packageFiles.map(raw => {
    const identity = raw as JsonObject;
    const path = `derived/review/v${rig}/${String(identity.path)}`;
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
  if (result.path !== `review-live-v${selector.version}.json`) files.push(publishedSourcePainting(root, project, `versions[v${selector.version}]`));
  files.push({ path: result.path, sha256: jobHash(publicationFile(root, result.path)) });
  if (selector.kind === 'post') {
    const direction = `evidence/direction/v${selector.version}.json`;
    const version = (project.versions as JsonObject[]).find(version => version.n === selector.version)!;
    const binding = (version.provenance as JsonObject)?.direction as JsonObject | undefined;
    const sha256 = jobHash(publicationFile(root, direction));
    if (binding?.path !== direction || binding.sha256 !== sha256) refuse('JOB_PUBLICATION_INVALID', `versions[v${selector.version}].provenance.direction: retained direction changed; restore its recorded bytes before reconciling`);
    files.push({ path: direction, sha256 });
  }
  const plan = project.plan as JsonObject | undefined;
  const steps = Array.isArray(plan?.steps) ? plan.steps as JsonObject[] : [];
  const subjects: JobPublishedContext['subjects'] = [{ kind: 'review-verdict', stage: selector.kind === 'post' ? 'direction-review' : 'rig-review' },
    ...packageSignSubjects(project, effectiveStage(root, project), selector, steps.length)];
  return {
    selector, plan: { steps: steps.map(step => ({ id: String(step.id), hash: stepHash(step) })) },
    parts: { enumeratorVersion: partsEnumerator.version, manifest: { path: manifestPath, sha256: jobHash(manifest) }, images },
    subjects, ...checkpointEvidenceContext(root, project, subjects, files),
    partIds: (JSON.parse(manifest.toString('utf8')).parts as { name: string }[]).map(part => part.name), files,
  };
};

export function publishedDraft(project: JsonObject, id: string): JsonObject {
  const drafts = Array.isArray(project.drafts) ? project.drafts as JsonObject[] : [];
  const found = drafts.filter(draft => draft.id === id);
  if (found.length !== 1) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: a unique retained draft is required; record a labelled draft with a new id`);
  return found[0];
}

function publishedSourcePainting(root: string, project: JsonObject, label: string): { path: string; sha256: string } {
  const inputs = Array.isArray(project.inputs) ? project.inputs : [];
  const first = inputs[0];
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
    refuse('JOB_PUBLICATION_INVALID', `${label}: inputs[0] must record the original painting {path, sha256}; restore the declared inputs[0] entry in project.json before publishing`);
  }
  const path = first.path;
  const sha256 = first.sha256;
  const bytes = publicationFile(root, path);
  if (jobHash(bytes) !== sha256 || (typeof first.bytes === 'number' && bytes.length !== first.bytes)) {
    refuse('JOB_PUBLICATION_INVALID', `${label}: inputs[0] (${path}) differs from its registered sha256; restore the original painting bytes before publishing`);
  }
  return { path, sha256 };
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
    subjects: [{ kind: 'parts-verdict', draftId: id }],
    partIds: (JSON.parse(manifest.toString('utf8')).parts as { name: string }[]).map(part => part.name), files };
}

export function prepareDraftManifest(root: string, project: JsonObject, id: string): string {
  const context = draftPublishedContext(root, project, id);
  const draft = publishedDraft(project, id);
  const painting = publishedSourcePainting(root, project, `drafts[${id}]`);
  const files = draft.files as JsonObject[];
  const models = files.filter(file => String(file.path).endsWith('/skeleton.model.json'));
  if (models.length > 1) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: multiple compiled models are ambiguous; retain one draft output`);
  const revision = jobHash(`${JSON.stringify(draft, null, 2)}\n`);
  const legacyManifest = { schema: 'rig-review/1', id: `create-draft-${id}`, revision, title: `draft ${id}`,
    ...(models.length ? { model: models[0].path } : {}),
    references: context.parts!.images.map((image, index) => ({ id: `image-${index}`, label: `${image.role} ${image.path}`, type: 'image',
      path: relative(root, resolve(root, dirname(context.parts!.manifest.path), image.path)).split('\\').join('/') })),
    animations: [], checkpoints: [], authoring: files.filter(file => /\/(rig|motion|mesh_report)\.json$/.test(String(file.path)))
      .map(file => ({ label: String(file.path).split('/').at(-1), path: file.path })) };
  const producer = { config: String((draft.config as JsonObject).path), parts: String((draft.parts as JsonObject).path), source: painting.path };
  const panels = { schema: 'rig-review/panels@1', left: ['parts.list'], stage: ['parts.canvas'], toolbar: ['parts.layers'], side: ['parts.issues', 'act.submit'] };
  const manifest = { ...legacyManifest, producer, panels };
  const path = `review-draft-${id}.json`;
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const legacyPanelsBytes = Buffer.from(`${JSON.stringify({ ...legacyManifest, panels }, null, 2)}\n`);
  const legacyBytes = Buffer.from(`${JSON.stringify(legacyManifest, null, 2)}\n`);
  if (existsSync(join(root, path))) {
    const existing = publicationFile(root, path);
    if (!existing.equals(bytes)) {
      if (!existing.equals(legacyPanelsBytes) && !existing.equals(legacyBytes)) {
        refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: retained publication manifest differs; restore it before reconciling`);
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

/** Register drafts independently of approval readiness. Only a prepared map declares approval. */
export function draftPublicationContext(root: string, project: JsonObject, id: string, warnings: Finding[] = []): JobPublishedContext {
  const context = draftPublishedContext(root, project, id);
  let subjects = [...context.subjects, ...packageSignSubjects(project, effectiveStage(root, project), context.selector!, context.plan?.steps.length ?? 0)];
  if (subjects.some(subject => subject.kind === 'signoff' && subject.stage === 'parts-review')) {
    const errors: Finding[] = [];
    checkDiffMap(root, { stage: 'parts-review', checkpoint: null, draft_id: id }, `signoffs[${asArray(project.signoffs).length}]`,
      resolve(root, context.parts!.manifest.path), errors, [], project);
    if (errors.length) {
      warnings.push(...errors);
      subjects = subjects.filter(subject => subject.kind !== 'signoff' || subject.stage !== 'parts-review');
    }
  }
  return { ...context, subjects, ...checkpointEvidenceContext(root, project, subjects, context.files as { path: string; sha256: string }[]) };
}

function readDraftPublished(root: string, project: JsonObject, id: string, path: string): JobPublishedContext {
  if (path !== `review-draft-${id}.json`) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: result path differs from its publication; restore the writer manifest`);
  const context = draftPublicationContext(root, project, id);
  return { ...context, files: [...context.files, { path, sha256: jobHash(publicationFile(root, path)) }] };
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
  if (version?.kind !== 'rig' || !Array.isArray(history) || history.length !== 1) return fail();
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
