import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { amendCommand } from '../src/amend.ts';
import { checkProject } from '../src/check.ts';
import { draftRigCommand } from '../src/drafts.ts';
import { assertRequestedDraft } from '../src/job-host.ts';
import { acknowledgePublication, JOB_BINDING_FILE, jobHash, publicationVersionHash, writePrivateJson, type WriterBinding } from '../src/job-outbox.ts';
import { currentJobIdentity, draftPackageIdentity, inspectDraftPublication, prepareDraftManifest, readPublished, riggingDraftPartsChange } from '../src/job-publication.ts';
import { prepareDraftIntent } from '../src/job-writer.ts';
import { nextProject } from '../src/next.ts';
import { partsReviewCommand } from '../src/parts-review.ts';
import { pauseCommand } from '../src/pause.ts';
import { signoffCommand } from '../src/signoff.ts';
import type { JsonObject } from '../src/templates.ts';

const roots: string[] = [];
const id = 'mesh-preview';
const preview = `derived/drafts/${id}`;
const refusal = 'RIGGING_DRAFT_PARTS_CHANGED';
const readProject = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
const writeProject = (root: string, project: JsonObject) => writeFileSync(join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(change: boolean, withModel = false, stage = 'rigging'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-rigging-parts-change-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), root, { recursive: true });
  if (stage === 'rigging') {
    const project = readProject(root);
    project.stage = stage;
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
    writeProject(root, project);
  }
  cpSync(join(root, 'derived/drafts/chain'), join(root, preview), { recursive: true });
  if (!withModel) rmSync(join(root, preview, 'out/check'), { recursive: true });
  if (change) appendFileSync(join(root, preview, 'input/parts.json'), '\n');
  expect(draftRigCommand([id, root, '--config', `${preview}/config.json`, '--from', `${preview}/out`,
    '--parts', `${preview}/input`], EXAMPLE_NOW).exit).toBe(0);
  return root;
}

function bindSyntheticJob(root: string): WriterBinding {
  const binding: WriterBinding = {
    schema: 'rig-create/job-binding@1', jobId: 'synthetic-job', origin: 'http://127.0.0.1:43123',
    fetchCapability: 'synthetic-fetch', listenerIncarnation: 'synthetic-listener',
    identity: currentJobIdentity({ root, stateDir: join(root, 'synthetic-state'), fingerprint: 'rig-create/live-review/1',
      reviewer: { id: 'synthetic-owner', role: 'owner' } }, root),
  };
  const project = readProject(root);
  project.review_job = { jobId: binding.jobId, origin: binding.origin };
  writeProject(root, project);
  writePrivateJson(join(root, JOB_BINDING_FILE), binding, true);
  return binding;
}

function recordOlderRiggingAmendment(root: string, now: number): void {
  const words = join(root, 'older-amendment-words.txt');
  writeFileSync(words, 'Redo synthetic rig work.\n');
  expect(amendCommand(['rigging', root, '--kind', 'config-field', '--target', '/rigging',
    '--change', `${preview}/config.json`, '--by', 'owner', '--verbatim-file', words], now).exit).toBe(0);
}

function expectAmendStageRefusal(root: string, now: number): void {
  const words = join(root, 'draft-amendment-words.txt');
  writeFileSync(words, 'Amend the synthetic parts.\n');
  const file = join(root, 'project.json');
  const before = readFileSync(file);
  expect(() => amendCommand(['parts-review', root, '--kind', 'draft', '--target', id, '--change',
    `${preview}/input/parts.json`, '--by', 'owner', '--owner-chat', words, '--said-at', new Date(now).toISOString(),
    '--relayed-by', 'operator'], now)).toThrow(expect.objectContaining({ code: 'AMENDMENT_TARGET_INVALID' }));
  expect(readFileSync(file)).toEqual(before);
}

test('changed model-less draft refuses job open before a write and next names the owner-chat amendment', () => {
  const root = fixture(true);
  const path = join(root, 'project.json');
  const before = readFileSync(path);
  const command = `rig-create amend parts-review ${root} --kind draft --target ${id} --change ${preview}/input/parts.json --by '<owner>' --owner-chat '<file>' --said-at '<ISO>' --relayed-by '<operator>'`;
  expect(assertRequestedDraft(root, undefined, EXAMPLE_NOW).stage).toBe('rigging');
  expect(() => assertRequestedDraft(root, id, EXAMPLE_NOW)).toThrow(expect.objectContaining({
    code: refusal, message: expect.stringContaining(command),
  }));
  const next = nextProject(root, EXAMPLE_NOW);
  expect(next.refusals).toContainEqual(expect.objectContaining({ code: refusal, field: `drafts[${id}].parts.files`, fix: command }));
  expect(next.moves).toEqual([expect.objectContaining({ role: 'human', command })]);
  expect(checkProject(root, undefined, { now: EXAMPLE_NOW, readOnly: true }).refusals.map(row => row.code)).not.toContain(refusal);
  expect(readFileSync(path)).toEqual(before);
  expect(existsSync(join(root, JOB_BINDING_FILE))).toBe(false);

  bindSyntheticJob(root);
  const bound = readFileSync(path);
  expect(prepareDraftIntent(root, bound, id)).toMatchObject({ intent: null, deferred: expect.stringContaining(refusal) });
  expect(readFileSync(path)).toEqual(bound);
});

test('matching paths and hashes in a different draft root keep the #718 mesh feedback ask', () => {
  const root = fixture(false);
  const project = readProject(root);
  expect(assertRequestedDraft(root, id, EXAMPLE_NOW)).toMatchObject({ stage: 'rigging', draftId: id });
  const draft = (project.drafts as JsonObject[]).at(-1)!;
  (draft.parts as { files: JsonObject[] }).files.reverse();
  expect(inspectDraftPublication(root, project, id, [], 'rigging')).toMatchObject({
    rigging: true, context: { subjects: [{ kind: 'parts-verdict', draftId: id }] },
  });
  expect(nextProject(root, EXAMPLE_NOW).refusals.map(row => row.code)).not.toContain(refusal);

  // The SHA multiset is identical after this plant, but two relative paths now bind the wrong bytes.
  const files = (draft.parts as { files: JsonObject[] }).files;
  const first = files.find(file => String(file.path).endsWith('/parts/face.png'))!;
  const second = files.find(file => String(file.path).endsWith('/parts/torso.png'))!;
  expect(first.sha256).not.toEqual(second.sha256);
  [first.sha256, second.sha256] = [second.sha256!, first.sha256!];
  expect(riggingDraftPartsChange(root, project, draft, 'rigging')?.code).toBe(refusal);
});

test('a model-backed draft is outside the new amendment route', () => {
  const root = fixture(true, true);
  expect(assertRequestedDraft(root, id, EXAMPLE_NOW)).toMatchObject({ stage: 'rigging', draftId: id });
  expect(inspectDraftPublication(root, readProject(root), id, [], 'rigging')).toMatchObject({
    rigging: false, context: { subjects: [] },
  });
  expect(nextProject(root, EXAMPLE_NOW).refusals.map(row => row.code)).not.toContain(refusal);
});

test('a paused project keeps its resume move when its effective stage is rigging', () => {
  const root = fixture(true);
  recordOlderRiggingAmendment(root, EXAMPLE_NOW + 1000);
  const words = join(root, 'pause-words.txt');
  writeFileSync(words, 'Pause synthetic work.\n');
  expect(signoffCommand(['paused', root, '--by', 'owner', '--verbatim-file', words], EXAMPLE_NOW + 2000).exit).toBe(0);
  const now = EXAMPLE_NOW + 3000;
  expect(pauseCommand([root, '--by', 'owner', '--verbatim-file', words], now).exit).toBe(0);

  const next = nextProject(root, now);
  expect(next).toMatchObject({ stage: 'paused', effective_stage: 'rigging', refusals: [] });
  expect(next.moves).toContainEqual(expect.objectContaining({ field: 'pauses', awaits: 'project.stage' }));
  expect(next.moves.some(move => move.command?.startsWith('rig-create amend '))).toBe(false);
  expect(assertRequestedDraft(root, id, now)).toMatchObject({ stage: 'rigging', draftId: id });
  expect(inspectDraftPublication(root, readProject(root), id, [], 'rigging').rigging).toBe(true);
  expectAmendStageRefusal(root, now);
});

test('previous amendment redo at effective rigging cannot advertise a physical-stage draft amendment', () => {
  const root = fixture(true, false, 'rig-review');
  const now = EXAMPLE_NOW + 1000;
  recordOlderRiggingAmendment(root, now);

  const next = nextProject(root, now);
  expect(next).toMatchObject({ stage: 'rig-review', effective_stage: 'rigging' });
  expect(next.refusals.map(row => row.code)).not.toContain(refusal);
  expect(next.moves.some(move => move.command?.startsWith('rig-create amend parts-review '))).toBe(false);
  expect(assertRequestedDraft(root, id, now)).toMatchObject({ stage: 'rigging', draftId: id });
  expect(inspectDraftPublication(root, readProject(root), id, [], 'rigging').rigging).toBe(true);
  expectAmendStageRefusal(root, now);
});

test('a historical acknowledgment on changed parts still ingests as mesh feedback and replays', async () => {
  const root = fixture(true);
  const binding = bindSyntheticJob(root);
  const project = readProject(root);
  const identity = draftPackageIdentity(id, true);
  const result = { path: identity.path, selector: { kind: 'draft' as const, id } };
  const bytes = readFileSync(join(root, 'project.json'));
  const projectHash = jobHash(bytes);
  const revision = publicationVersionHash(bytes, result)!;
  const publicationId = 'historical-publication';
  const actId = 'historical-act';
  const sourceHash = jobHash('synthetic sealed source');
  prepareDraftManifest(root, project, id, result.path);
  const context = await readPublished({ root, record: { path: 'project.json', sha256: projectHash }, result });
  expect(context.subjects).toEqual([{ kind: 'parts-verdict', draftId: id }]);
  acknowledgePublication({ schema: 'rig-create/job-pending@1', root, jobId: binding.jobId, origin: binding.origin,
    id: 'synthetic-pending', identity: binding.identity, recordHash: projectHash, versionHash: revision, result, failure: null },
  publicationId, 1, 'synthetic-publish-request', context.subjects, { projectHash, sourceHash });

  const act = { schema: 'rig-review/act@5', kind: 'parts-verdict', actId, publicationId, jobId: binding.jobId, askId: 'synthetic-ask',
    at: new Date(EXAMPLE_NOW).toISOString(),
    authority: { actor: 'human', channel: 'review-ui', reviewer: binding.identity.reviewer },
    source: { projectHash, sourceHash, package: { id: identity.id, revision }, selector: result.selector,
      parts: context.parts, plan: context.plan, model: null, direction: null },
    value: { verdict: 'approved', issues: [], words: 'Synthetic owner words.' } };
  const ingest = () => partsReviewCommand([root, '--from-review', actId, '--json'], EXAMPLE_NOW,
    { fetch: () => ({ bytes: JSON.stringify(act) }) });
  expect(ingest().exit).toBe(0);
  expect(readProject(root)).toMatchObject({ stage: 'rigging', signoffs: project.signoffs,
    review_acts: expect.arrayContaining([expect.objectContaining({ actId, draft_id: id })]) });
  const recorded = readFileSync(join(root, 'project.json'));
  expect(ingest().exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(recorded);
});
