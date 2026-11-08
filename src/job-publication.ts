import { writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { partsFileReferences } from '@rig-c/parts/src/parts.ts';
import partsPackage from '@rig-c/parts/package.json';
import { JOB_ACT_SCHEMA, JOB_API_SCHEMA, type JobPublicationReader, type JobPublishedContext, type JobSelector } from '@rig-c/review/job-host';
import { stepHash } from './step-hash.ts';
import { asArray, checkProject, classify, collectItems, collectSignoffs, isObject, loadCollection, postNotPassed } from './check.ts';
import { optionContextFiles, optionFile, validateContext } from './choices.ts';
import { approvalStageOfStep, hasStageOrder, STAGES, stageOfStep } from './stages.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { selectAnswerHashes } from './signoff-answers.ts';
import { latestPartsApproval, riggingContext } from './structure.ts';
import { jobHash, type JobIdentity } from './job-outbox.ts';
import { Refusal, refuse } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export const JOB_READER_ID = 'rig-create/publication-reader/2';
export const JOB_BINDING_ID = 'rig-create/writer-binding/1';
export const JOB_ENUMERATOR_ID = 'rig-create/parts-file-references/1';
export const partsEnumerator = { version: partsPackage.version, enumerate: partsFileReferences };

export interface RecordPublicationRequest {
  readonly root: string;
  readonly record: { readonly path: 'project.json'; readonly sha256: string };
  readonly result: { readonly kind: 'option-set'; readonly questionId: string; readonly setId: string } | { readonly kind: 'plan' };
  readonly phase: 'inventory' | 'retained';
}

type RecordContextBase = {
  readonly label: string;
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
  readonly plan: NonNullable<JobPublishedContext['plan']>;
  readonly subjects: readonly RecordPlanSubject[];
};
export type RecordPublishedContext = RecordOptionContext | RecordPlanContext;

export class RecordClosureIncomplete extends Refusal {
  constructor(readonly details: readonly { code: string; path: string }[]) {
    super('JOB_RECORD_CLOSURE_INCOMPLETE', 'project.json: the retained check refuses while its sealed files match, so the retained root lacks or changed a file of the inventory closure; restore the complete inventory closure before finalization');
  }
}

/** Reuse check's eligibility and the exact retained evidence of its subject. No writes or locks. */
export function readRecordPublished(input: RecordPublicationRequest & { result: Extract<RecordPublicationRequest['result'], { kind: 'option-set' }> }, now?: number): RecordOptionContext;
export function readRecordPublished(input: RecordPublicationRequest & { result: { kind: 'plan' } }, now?: number): RecordPlanContext;
export function readRecordPublished(input: RecordPublicationRequest, now?: number): RecordPublishedContext;
export function readRecordPublished({ root, record, result, phase }: RecordPublicationRequest, now = Date.now()): RecordPublishedContext {
  try {
    const bytes = publicationFile(root, record.path);
    if (record.path !== 'project.json' || jobHash(bytes) !== record.sha256) refuse('JOB_PUBLICATION_INVALID', 'project.json: the committed record binding changed; restore its exact sealed bytes');
    const project: JsonObject = JSON.parse(bytes.toString('utf8'));
    if (phase !== 'inventory' && phase !== 'retained') throw Error('phase must be inventory or retained');
    if (loadCollection(root) !== null) {
      refuse('JOB_RECORD_COLLECTION_EXTERNAL', "project.json: a member record's inherited answers depend on ../../collection.json, which the project-relative closure cannot seal; publish from a standalone project until the collection binding lands");
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
    const inputs = list(project.inputs);
    const items = collectItems(project, { collection: null });
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
    // The closure is every project file the check reads, so a retained copy gives the check identical bytes.
    const report = checkProject(root, project, { now, readOnly: true, recordReads: true });
    for (const { path, sha256 } of report.reads ?? []) seal({ path, sha256 });
    if (report.refusals.length && phase === 'retained') {
      throw new RecordClosureIncomplete(report.refusals.map(({ code, path }) => ({ code, path })));
    }
    const finding = report.refusals[0] ?? report.holes?.[0];
    if (finding) throw Error(`${finding.code} at ${finding.path}`);
    const stage = report.effective_stage;
    let subjects: RecordPlanSubject[] = [];
    let label: string;
    if (result.kind === 'option-set') {
      const set = selectedSet!;
      if (set.id !== result.setId || set.question !== result.questionId || set.stage !== stage) {
        refuse('JOB_RECORD_SUBJECT_INVALID', 'project.json: requested option set does not match its question, set id and effective stage; publish the exact current pending set');
      }
      validateContext(root, project, set, now, true);
      label = `option-set ${result.questionId} / ${result.setId}`;
    } else if (result.kind === 'plan') {
      if (!plan) throw Error('the requested plan is absent');
      const planPhase = stage === 'post-interview' ? 'post' : 'rig';
      const covered = steps.filter(step => step.phase === planPhase && approvalStageOfStep(planPhase, String(step.id), hasStageOrder(project) || stage === 'rigging-interview') === stage);
      const reopens = collectReopens(project, []);
      const signoffs = collectSignoffs(project, []).filter(signature => liveSignoff(reopens, signature.stage, signature.at));
      const signable = stage !== null && ['plan-approved', 'rigging-interview', 'post-interview'].includes(stage)
        && STAGES.some(spec => spec.id === stage && spec.closed_by === 'signoff')
        && !signoffs.some(signature => signature.stage === stage && signature.checkpoint === null);
      const emptyPost = stage === 'post-interview' && !steps.some(step => step.phase === 'post') && postNotPassed({ items });
      if (signable && !covered.length && !emptyPost) throw Error('the requested plan has no steps at this approval stage');
      const signature: JsonObject = { stage, steps: covered.map(step => step.id!) };
      if (signable) selectAnswerHashes(root, project, signature);
      if (signable && stage === 'rigging-interview') {
        const errors: Parameters<typeof riggingContext>[3] = [];
        const context = riggingContext(root, project, new Date(now).toISOString(), errors);
        if (errors.length || !context) throw Error(errors[0]?.code ?? 'rigging evidence is missing');
      }
      subjects = steps.filter(step => {
        if (step.status !== 'at-checkpoint' || (step.phase !== 'rig' && step.phase !== 'post') || stageOfStep(step.phase, String(step.id)) !== stage) return false;
        const checkpoint = classify(step.checkpoint, { collection: null });
        const value = checkpoint.state === 'user' ? checkpoint.answer.value
          : checkpoint.state === 'delegated' && checkpoint.decided && isObject(checkpoint.answer.agent_decision) ? checkpoint.answer.agent_decision.value : undefined;
        return value === true;
      }).map(step => ({ kind: 'checkpoint' as const, checkpointId: String(step.id) }));
      if (signable) subjects = [...subjects, { kind: 'signoff', stage: stage as RecordSignoffStage }];
      label = `plan / ${stage}`;
    } else throw Error('unknown record result');
    // Detect record changes during closure reads as well as changes before entry.
    if (!publicationFile(root, record.path).equals(bytes)) throw Error('project.json changed while reading its closure');
    const files = [...seals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, sha256]) => ({ path, sha256 }));
    if (result.kind === 'option-set') {
      return { label, inputs, files, plan: null,
        subjects: [{ kind: 'interview-picks', questionId: result.questionId, setId: result.setId }] };
    }
    return { label, inputs, files,
      plan: { steps: steps.map(step => ({ id: String(step.id), hash: stepHash(step) })) }, subjects };
  } catch (error) {
    if (error instanceof Refusal && (phase === 'retained' || ['JOB_RECORD_SUBJECT_INVALID', 'JOB_RECORD_COLLECTION_EXTERNAL'].includes(error.code))) throw error;
    refuse('JOB_RECORD_INCOMPLETE', `project.json: ${error instanceof Error ? error.message : String(error)}; restore the requested record and retained evidence, resolve check refusals and reconcile pending publications before publishing`);
  }
}

export function currentJobIdentity(saved: Pick<JobIdentity, 'root' | 'stateDir' | 'fingerprint' | 'reviewer'>, root: string): JobIdentity {
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

/** A manifest over the existing frozen model/direction, with project-relative paths.
 * Source documents and compiled producer output remain byte-identical.
 */
export function prepareLiveManifest(root: string, project: JsonObject, n: number): string {
  const selector = publicationSelector(project, n);
  const rig = selector.kind === 'post' ? selector.rigVersion : n;
  const model = `derived/review/v${rig}/out/check/build/skeleton.model.json`;
  publicationFile(root, model);
  const manifest = {
    schema: 'rig-review/1', id: `create-v${n}`, revision: `v${n}`,
    title: selector.kind === 'post' ? `post v${n} (rig v${rig})` : `rig v${n}`,
    model, ...(selector.kind === 'post' ? { direction: `evidence/direction/v${n}.json` } : {}),
    references: [], animations: [], checkpoints: [], authoring: [],
  };
  const path = `review-live-v${n}.json`;
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (existsSync(join(root, path))) {
    if (!publicationFile(root, path).equals(bytes)) refuse('JOB_PUBLICATION_INVALID', `versions[v${n}]: ${path} already differs; preserve it and restore the writer-generated manifest`);
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
  if (!isDeepStrictEqual(selector, result.selector) || result.path !== `review-live-v${selector.version}.json`) {
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
  return {
    selector, plan: { steps: steps.map(step => ({ id: String(step.id), hash: stepHash(step) })) },
    parts: { enumeratorVersion: partsEnumerator.version, manifest: { path: manifestPath, sha256: jobHash(manifest) }, images },
    subjects: [{ kind: 'review-verdict', stage: selector.kind === 'post' ? 'direction-review' : 'rig-review' }],
    partIds: (JSON.parse(manifest.toString('utf8')).parts as { name: string }[]).map(part => part.name), files,
  };
};

export function publishedDraft(project: JsonObject, id: string): JsonObject {
  const drafts = Array.isArray(project.drafts) ? project.drafts as JsonObject[] : [];
  const found = drafts.filter(draft => draft.id === id);
  if (found.length !== 1) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: a unique retained draft is required; record a labelled draft with a new id`);
  return found[0];
}

/** Retain the official positional inventory, including duplicate paths/roles. */
export function draftPublishedContext(root: string, project: JsonObject, id: string): JobPublishedContext {
  const draft = publishedDraft(project, id);
  const parts = draft.parts as JsonObject;
  const identities = [draft.config, ...(draft.config_inputs as JsonObject[] ?? []), ...(parts.files as JsonObject[]), ...(draft.files as JsonObject[])];
  const files = identities.map(raw => {
    const identity = raw as JsonObject;
    const path = String(identity.path), sha256 = String(identity.sha256);
    if (jobHash(publicationFile(root, path)) !== sha256) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: ${path} differs from its retained hash; restore the draft or record a new id`);
    return { path, sha256 };
  });
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
  const files = draft.files as JsonObject[];
  const models = files.filter(file => String(file.path).endsWith('/skeleton.model.json'));
  if (models.length > 1) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: multiple compiled models are ambiguous; retain one draft output`);
  const revision = jobHash(`${JSON.stringify(draft, null, 2)}\n`);
  const manifest = { schema: 'rig-review/1', id: `create-draft-${id}`, revision, title: `draft ${id}`,
    ...(models.length ? { model: models[0].path } : {}),
    references: context.parts!.images.map((image, index) => ({ id: `image-${index}`, label: `${image.role} ${image.path}`, type: 'image',
      path: relative(root, resolve(root, dirname(context.parts!.manifest.path), image.path)).split('\\').join('/') })),
    animations: [], checkpoints: [], authoring: files.filter(file => /\/(rig|motion|mesh_report)\.json$/.test(String(file.path)))
      .map(file => ({ label: String(file.path).split('/').at(-1), path: file.path })) };
  const path = `review-draft-${id}.json`;
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (existsSync(join(root, path))) {
    if (!publicationFile(root, path).equals(bytes)) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: retained publication manifest differs; restore it before reconciling`);
  } else writeFileSync(join(root, path), bytes, { flag: 'wx' });
  return path;
}

function readDraftPublished(root: string, project: JsonObject, id: string, path: string): JobPublishedContext {
  if (path !== `review-draft-${id}.json`) refuse('JOB_PUBLICATION_INVALID', `drafts[${id}]: result path differs from its publication; restore the writer manifest`);
  const context = draftPublishedContext(root, project, id);
  return { ...context, files: [...context.files, { path, sha256: jobHash(publicationFile(root, path)) }] };
}
