/**
 * Live verdicts and historical sign-off routes over package publications (#324).
 * Create binds owner acts to the publication's acknowledged subjects on ingestion.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startJobHost, type JobHostOptions, type JobOwnerHost, type JobSubject } from '@rig-c/review/job-host';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';
import { checkProject } from '../src/check.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import { diffClassesCommand } from '../src/diff-classes.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { readHostActsAndAsks } from '../src/job-acts.ts';
import { openCreateJob, openDraftPublication, publishPending, reconcileCreateJob } from '../src/job-host.ts';
import { prepareLiveManifest } from '../src/job-publication.ts';
import { draftPublicationResult, jobRuntimeExecArgv } from '../src/job-writer.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, readAcknowledgedPublication, readWriterBinding, type PublicationSubject } from '../src/job-outbox.ts';
import { assertActSubjectDeclared, decodeReviewAct, reviewActFindings, reviewActVerdict, reviewActVersionHash, rigVerdictSignoff } from '../src/review-act.ts';
import { selectSignoffTarget } from '../src/signoff-target.ts';
import { currentScene, sceneReference } from '../src/scene.ts';
import type { JsonObject } from '../src/templates.ts';
import { plantLegacyReopen } from './fixtures.ts';
import { seedHistoricalCheckpointAct, seedHistoricalCheckpointAsk } from './historical-review-fixture.ts';
import { seedRetainedDraft } from './numbered-seed.ts';

const roots: string[] = [];
const hosts: JobOwnerHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of roots.splice(0)) {
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
const WORDS = '  Synthetic approval, 좋아.\r\n';
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
const write = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
const steps = (project: JsonObject): JsonObject[] => (project.plan as JsonObject).steps as JsonObject[];

function copy(checkpoint: string, edit?: (project: JsonObject) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-sign-subjects-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints', checkpoint), root, { recursive: true });
  if (edit) { const project = read(root); edit(project); write(root, project); }
  return root;
}

async function cli(root: string, args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, '../src/cli.ts'), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

async function open(root: string, startHost?: (options: JobHostOptions) => Promise<JobOwnerHost>): Promise<JobOwnerHost> {
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now(), startHost);
  hosts.push(host);
  return host;
}

/** Review's agent verb; returns its JSON reply unchanged. */
async function agent(host: JobOwnerHost, verb: string, fields: object): Promise<{ ok: boolean; error?: { code: string }; value: JsonObject }> {
  const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, { method: 'POST',
    headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: 'rig-review/job-api@2', verb, jobId: host.session.jobId, requestId: randomUUID(),
      expectedGeneration: host.session.status().generation, idempotencyKey: randomUUID(), ...fields }) }));
  return await response.json() as { ok: boolean; error?: { code: string }; value: JsonObject };
}
const ask = (host: JobOwnerHost, subject: JobSubject) => agent(host, 'ask', { publicationId: host.session.status().publication!.publicationId, subject });

/** The person's page: one displayed acknowledgment, then each act through Review's UI port. */
async function page(host: JobOwnerHost) {
  const publication = host.session.status().publication!;
  const ui = (route: string, body: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, { method: 'POST',
    headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pageId = randomUUID();
  const displayed = await host.ports.ackDisplayed(host.session.jobId, ui('displayed', { publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash }));
  if (!displayed.ok) throw Error(displayed.error.code);
  return { pageId, act: async (askId: string, kind: string, value: object, extra: object = {}) => {
    const result = await host.ports.commitUIAct(host.session.jobId, ui('acts', { publicationId: publication.publicationId, askId, pageId,
      displayedNonce: displayed.value.displayedNonce, expectedGeneration: host.session.status().generation, submissionId: randomUUID(), kind, value, ...extra }));
    if (!result.ok) throw Error(result.error.code);
    return result.value;
  } };
}

function declared(root: string, host: JobOwnerHost): readonly PublicationSubject[] | undefined {
  return readAcknowledgedPublication(root, host.session.jobId, host.session.status().publication!.publicationId)?.subjects;
}
const codes = (root: string): string[] => checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code);

/** The parts stage with the enabled `assemble` checkpoint at its checkpoint and unsigned, and no draft yet. */
function partsAtCheckpoint(): string {
  return copy('1-parts-verdict', project => {
    project.drafts = [];
    project.signoffs = (project.signoffs as JsonObject[]).filter(signoff => signoff.checkpoint !== 'assemble');
    const assemble = steps(project).find(step => step.id === 'assemble')!;
    assemble.status = 'at-checkpoint';
    (assemble.status_history as JsonObject[]).pop();
  });
}
function preparedParts(): string {
  const root = copy('1-parts-verdict');
  const checkpoint = read(root);
  // Review stamps its verdict with the wall clock. Date setup from the retained checkpoint and *_SINCE floor.
  const records = [
    ...(Array.isArray(checkpoint.inputs) ? checkpoint.inputs : []),
    ...(Array.isArray(checkpoint.advances) ? checkpoint.advances : []),
    ...(Array.isArray(checkpoint.drafts) ? checkpoint.drafts : []),
    ...(Array.isArray(checkpoint.signoffs) ? checkpoint.signoffs : []),
  ];
  const times = records
    .map(entry => (entry && typeof entry === 'object' && !Array.isArray(entry) ? Date.parse(String((entry as JsonObject).at)) : NaN))
    .filter(Number.isFinite);
  const prepNow = Math.max(EXAMPLE_ANCHOR, ...times) + 1_000;
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/structure-chain.json']);
  diffClassesCommand([root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'], prepNow);
  advanceCommand(['parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'], prepNow);
  return root;
}
const draftArgs = (root: string, id = 'chain') => [id, root, '--config', `derived/drafts/${id}/config.json`, '--from', `derived/drafts/${id}/out`, '--parts', `derived/drafts/${id}/input`, '--json'];

const rigVerdictSubject = { kind: 'review-verdict', stage: 'rig-review' } as const;
const rigResult = { path: 'review-live-v1.json', selector: { kind: 'rig', version: 1 } } as const;

async function publishRigWithoutAsks(root: string, host: JobOwnerHost) {
  enqueuePublication(root, readWriterBinding(root)!, rigResult);
  expect(await reconcileCreateJob(root)).toBe(1);
  expect(declared(root, host)).toEqual([]);
  expect((await readHostActsAndAsks(host)).asks).toEqual([]);
}

async function historicalRigVerdict(root: string) {
  let historical = true;
  const host = await open(root, options => startJobHost({ ...options, readPublished: async input => {
    const context = await options.readPublished!(input);
    return historical ? { ...context, subjects: [rigVerdictSubject] } : context;
  } }));
  const path = prepareLiveManifest(root, read(root), 1);
  enqueuePublication(root, readWriterBinding(root)!, { ...rigResult, path });
  // Only this seeded publication carries historical verdict authority.
  await reconcileCreateJob(root, async entry => {
    const result = await agent(host, 'publish', {
      result: entry.result,
      freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
    });
    expect(result.ok).toBe(true);
    const { publication, generation } = host.session.status();
    acknowledgePublication(entry, publication!.publicationId, generation, randomUUID(), [rigVerdictSubject]);
  });
  historical = false;
  const verdictAsk = await ask(host, rigVerdictSubject);
  expect(verdictAsk.ok).toBe(true);
  const { pageId, act } = await page(host);
  const publication = host.session.status().publication!;
  const png = readFileSync(join(root, 'evidence/setup.png'));
  const verdict = await act(String(verdictAsk.value.askId), 'review-verdict', { stage: 'rig-review', verdict: 'approved', words: WORDS }, {
    capture: { png: `data:image/png;base64,${png.toString('base64')}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
      binding: { publicationId: publication.publicationId, instanceKey: publication.instanceKey, sourceHash: publication.source.sourceHash,
        pageId, askId: verdictAsk.value.askId, drawGeneration: 1, playerGeneration: 0 } } });
  return { host, verdict };
}

function seedFoldedRigVerdict(root: string, rawVerdict: unknown): void {
  const bytes = JSON.stringify(rawVerdict);
  const decoded = decodeReviewAct(bytes);
  const project = read(root);
  const versions = project.versions as JsonObject[];
  const v1 = versions.find(row => row.n === 1)!;
  const verdictIndex = (v1.verdicts as JsonObject[]).length;
  const versionHash = reviewActVersionHash(project, decoded, verdictIndex);
  (v1.verdicts as JsonObject[]).push(reviewActVerdict(decoded));
  const signoffs = project.signoffs as JsonObject[];
  const sig: JsonObject = {
    ...rigVerdictSignoff(decoded),
    target: selectSignoffTarget(root, project, 'rig-review', '1')!,
  };
  signoffs.push(sig);
  project.review_acts = [...(Array.isArray(project.review_acts) ? project.review_acts : []), {
    schema: 'rig-create/review-act@1',
    jobId: decoded.jobId,
    actId: decoded.actId,
    bytes,
    sha256: jobHash(bytes),
    version: 1,
    verdict: verdictIndex,
    signoff: signoffs.length - 1,
    version_hash: versionHash,
  }];
  write(root, project);
}

test('a fresh rig version published in rig-review folds its approval into the displayed version signature', async () => {
  const freshRoot = copy('3-rig-review');
  const freshHost = await open(freshRoot);
  await publishRigWithoutAsks(freshRoot, freshHost);
  // Review still allows a manual verdict ask. Only the retired signoff asks refuse.
  for (const stage of ['rig-review', 'direction-review'] as const) {
    expect((await ask(freshHost, { kind: 'signoff', stage })).error?.code).toBe('JOB_ASK_INVALID');
  }
  const root = copy('3-rig-review');
  const { host, verdict } = await historicalRigVerdict(root);
  expect(verdict).toMatchObject({ schema: 'rig-review/act@6', kind: 'review-verdict', source: { selector: { kind: 'rig', version: 1 } }, value: { stage: 'rig-review', verdict: 'approved', comments: [{ text: WORDS }] } });
  const reviewed = await cli(root, ['review', '1', root, '--from-review', String(verdict.actId), '--json']);
  expect(reviewed.exit).toBe(2);
  expect(reviewed.stderr).toContain('NUMBERED_WRITER_REMOVED');
  seedFoldedRigVerdict(root, verdict);
  const signature = (read(root).signoffs as JsonObject[]).at(-1)!;
  expect(signature).toMatchObject({ stage: 'rig-review', checkpoint: null, by: 'user', verbatim: `[general]\n${WORDS}`, at: verdict.at,
    source: `review act ${host.session.jobId}/${String(verdict.actId)}`, target: { version: 1 } });
  expect(reviewActFindings(read(root))).toEqual([]);
  expect(codes(root)).toEqual([]);
});

test('an act for a subject create did not declare refuses by name and leaves the record byte-identical', async () => {
  const root = partsAtCheckpoint();
  expect(seedRetainedDraft(draftArgs(root)).exit).toBe(0);
  // Model a historical host that declared and finalized more than Create's receipt allowed.
  const subject = { kind: 'checkpoint', checkpointId: 'assemble' } as const;
  const wider = (options: JobHostOptions) => startJobHost({ ...options, readPublished: async input => {
    const context = await options.readPublished!(input);
    return { ...context, subjects: [...context.subjects, subject] };
  } });
  const host = await open(root, wider);
  enqueuePublication(root, readWriterBinding(root)!, draftPublicationResult('chain'));
  expect(await reconcileCreateJob(root, entry => publishPending(entry, undefined, undefined, wider))).toBe(1);
  expect(declared(root, host)).toEqual([]);
  expect(await ask(host, subject)).toMatchObject({ ok: false, error: { code: 'JOB_ASK_INVALID' } });
  const askId = seedHistoricalCheckpointAsk(host, host.session.status().publication!.publicationId, subject);
  const planted = seedHistoricalCheckpointAct(host, askId, 'pass', {
    comments: [{ text: WORDS, anchor: { checkpointId: 'assemble', planStepId: 'assemble' } }],
  });
  const decodedPlanted = decodeReviewAct(JSON.stringify(planted), 'checkpoint');
  const bytes = readFileSync(join(root, 'project.json'));
  expect(() => assertActSubjectDeclared(root, decodedPlanted, 'signoffs.checkpoint assemble'))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SUBJECT_UNDECLARED' }));
  const retired = await cli(root, ['signoff', 'parts', root, '--checkpoint', 'assemble', '--from-review', planted.actId]);
  expect(retired.exit).toBe(2);
  expect(retired.stderr).toContain('SIGNOFF_FROM_REVIEW_REMOVED');
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
  // Control: without the acknowledged receipt (a clone) assertActSubjectDeclared allows the historical act.
  rmSync(join(root, '.rig-create-review/acknowledged-publications'), { recursive: true });
  expect(() => assertActSubjectDeclared(root, decodedPlanted, 'signoffs.checkpoint assemble')).not.toThrow();
});

test('bar: draft publications at parts-review declare no parts-verdict asks before or after new drafts', async () => {
  const root = preparedParts();
  const host = await open(root);
  enqueuePublication(root, readWriterBinding(root)!, draftPublicationResult('chain'));
  expect(await reconcileCreateJob(root)).toBe(1);
  expect(declared(root, host)).toEqual([]);
  expect((await readHostActsAndAsks(host)).asks).toEqual([]);

  cpSync(join(root, 'derived/drafts/chain'), join(root, 'derived/drafts/chain-2'), { recursive: true });
  expect(seedRetainedDraft(draftArgs(root, 'chain-2')).exit).toBe(0);
  structureSnapshotCommand([root, '--draft', 'chain-2', '--out', 'evidence/structure-chain-2.json']);
  enqueuePublication(root, readWriterBinding(root)!, draftPublicationResult('chain-2'));
  expect(await reconcileCreateJob(root)).toBe(1);
  expect(declared(root, host)).toEqual([]);
  expect((await readHostActsAndAsks(host)).asks).toEqual([]);
});

test('bar: review-verdict is not declared once the verdict for the displayed version is stored', async () => {
  const root = copy('3-rig-review');
  const { host, verdict } = await historicalRigVerdict(root);
  seedFoldedRigVerdict(root, verdict);
  await publishRigWithoutAsks(root, host);
});

// Measured 6690ms for this multi-writer flow; 15000ms bounds it above the default 5s timeout.
test('bar: a new numbered post publishes without review-verdict even when only the earlier rig has a verdict', async () => {
  // The earlier rig already has a verdict. Write the new post, then open its numbered view.
  const postRoot = copy('4-direction-post');
  const postHost = await open(postRoot);
  cpSync(join(postRoot, 'derived/drafts/chain/input/parts/background.png'), join(postRoot, 'inputs/background.png'));
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/scene-citations.json'), join(postRoot, 'evidence/scene-citations.json'));
  expect((await cli(postRoot, ['input', 'add', 'inputs/background.png', postRoot, '--origin', 'synthetic background plate, generated by generateExampleParts'])).exit).toBe(0);
  expect((await cli(postRoot, ['scene', 'write', postRoot, '--rig', '1', '--background', 'inputs/background.png', '--citations-file', 'evidence/scene-citations.json'])).exit).toBe(0);
  const directionInput = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-chain/evidence/direction-input.json'), 'utf8')) as JsonObject;
  directionInput.scene = sceneReference(currentScene(read(postRoot))!);
  writeFileSync(join(postRoot, 'evidence/direction-input.json'), `${JSON.stringify(directionInput, null, 2)}\n`);
  const written = await cli(postRoot, ['direction', 'write', '2', postRoot, '--file', 'evidence/direction-input.json', '--rig', '1']);
  expect({ exit: written.exit, stderr: written.stderr }).toEqual({ exit: 0, stderr: '' });
  await openDraftPublication(postRoot, postHost, Date.now(), undefined, '2');
  const publication = postHost.session.status().publication;
  expect(publication).toMatchObject({ source: { selector: { kind: 'post', version: 2, rigVersion: 1 } } });
  expect(declared(postRoot, postHost)).toEqual([]);
  const { head, asks } = await readHostActsAndAsks(postHost);
  expect(head).toBe(publication!.publicationId);
  expect(asks).toEqual([]);
}, 15_000);

test('bar: a retained rig approval folds its signature and reopened stages publish without asks', async () => {
  const root = copy('3-rig-review');
  const { host, verdict } = await historicalRigVerdict(root);
  seedFoldedRigVerdict(root, verdict);
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({
    stage: 'rig-review', source: `review act ${host.session.jobId}/${String(verdict.actId)}`, target: { version: 1 },
  });
  await publishRigWithoutAsks(root, host);
  plantLegacyReopen(root, 'rig-review', { by: 'user', wordsFile: join(root, 'evidence/approval.txt'), at: new Date().toISOString() });
  await publishRigWithoutAsks(root, host);
});
