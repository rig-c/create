import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { partsFileReferences } from '@rig-c/parts/src/parts.ts';
import partsPackage from '@rig-c/parts/package.json';
import { JOB_ACT_SCHEMA, JOB_API_SCHEMA, type JobPublicationReader, type JobPublishedContext, type JobSelector } from '@rig-c/review/job-host';
import { stepHash } from './step-hash.ts';
import { jobHash, type JobIdentity } from './job-outbox.ts';
import { refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export const JOB_READER_ID = 'rig-create/publication-reader/1';
export const JOB_BINDING_ID = 'rig-create/writer-binding/1';
export const JOB_ENUMERATOR_ID = 'rig-create/parts-file-references/1';
export const partsEnumerator = { version: partsPackage.version, enumerate: partsFileReferences };

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
