import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JOB_RECORD_ACT_SCHEMA, parseRecordAct, startJobHost } from '@rig-c/review/job-host';
import { checkProject as rawCheckProject } from '../src/check.ts';
import { agentCall } from '../src/job-acts.ts';
import { openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readAcknowledgedPublication, readWriterBinding, reconcilePublication, type AcknowledgedPublication } from '../src/job-outbox.ts';
import { prepareDraftManifest, prepareLiveManifest, publicationSelector, readPublished, readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { testClock, interviewOptionsCommand, interviewAnswerCommand } from './clock.ts';
import { optionContext } from '../src/choices.ts';
import { clockedCli } from './helpers.ts';
import { OWNER_CHAT_SOURCE } from '../src/owner-chat.ts';
import { nextCommand, nextProject, type NextReport } from '../src/next.ts';
import { locateParts } from '../src/parts-sections.ts';
import { generateExampleParts } from '../scripts/generate-example-parts.ts';
import { EXAMPLE_REOPEN_AT } from '../scripts/example-time.ts';
import { reviewActFindings, decodeReviewAct, reviewActVerdict } from '../src/review-act.ts';
import { USAGE_EXIT } from '../src/refusal.ts';
import { foldHistoricalRigSignoff, seedHistoricalPendingAsk, seedStoredPartsSignoff, seedStoredPartsVerdictAct, seedStoredReviewVerdictAct, seedStoredSignoffAct } from './historical-review-fixture.ts';
import { plantLegacyReopen } from './fixtures.ts';
import { seedRetainedDraft } from './numbered-seed.ts';

const WORDS = '  Synthetic owner review words.\r\n';
// Measured 2.59s–3.67s per multi-spawn CLI + live host flow locally; 15_000ms tier avoids 5s default timeout flakes under load.
const REFRESH_FLOW_TIMEOUT_MS = 15_000;
const roots: string[] = [];
const legacyPackageHosts = new Set<Awaited<ReturnType<typeof openCreateJob>>>();
const opened: { proc: Bun.Subprocess; root: string }[] = [];
const checkProject = (dir: string, candidate?: JsonObject, _options?: { now: number }) =>
  rawCheckProject(dir, candidate, { now: testClock.now() });

afterEach(async () => {
  for (const host of legacyPackageHosts) host.stop();
  legacyPackageHosts.clear();
  for (const { proc, root } of opened.splice(0)) {
    if (readWriterBinding(root) && pendingPublications(root).length === 0) {
      await cli(root, ['job', 'close', root]);
    }
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
  testClock.reset();
});

const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
const write = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

function copy(checkpoint: string, edit?: (project: JsonObject) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-refresh-')));
  roots.push(root);
  const src = checkpoint === 'example-chain'
    ? join(import.meta.dir, '../templates/example-chain')
    : join(import.meta.dir, '../templates/example-chain/checkpoints', checkpoint);
  cpSync(src, root, { recursive: true });
  if (edit) {
    const project = read(root);
    edit(project);
    write(root, project);
  }
  return root;
}

async function cli(root: string, args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), ...clockedCli(), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

async function openLegacyDraftVerdict(
  root: string,
  draftId: string,
  existingHost?: Awaited<ReturnType<typeof openCreateJob>>,
) {
  const subject = { kind: 'parts-verdict', draftId } as const;
  const host = existingHost ?? await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, testClock.now(), options => startJobHost({
    ...options,
    readPublished: async input => {
      const context = await readPublished(input);
      const sel = input.result.selector;
      return sel?.kind === 'draft' && 'id' in sel
        ? { ...context, subjects: [{ kind: 'parts-verdict', draftId: sel.id }] }
        : context;
    },
  }));
  if (!existingHost) legacyPackageHosts.add(host);
  const project = read(root);
  const isRigging = project.stage === 'rigging';
  const manifestOverride = isRigging ? `review-rigging-draft-${draftId}.json` : undefined;
  const path = prepareDraftManifest(root, project, draftId, manifestOverride);
  const result = { path, selector: { kind: 'draft' as const, id: draftId } };
  const binding = readWriterBinding(root)!;
  const entry = enqueuePublication(root, binding, result);
  const requestId = randomUUID();
  await reconcilePublication(root, entry, async pending => {
    const reply = await agentCall(host, {
      schema: binding.identity.apiSchema,
      verb: 'publish',
      requestId,
      idempotencyKey: requestId,
      expectedGeneration: host.session.status().generation,
      result,
      freeze: { kind: 'producer-held', holdId: pending.id, record: { path: 'project.json', sha256: pending.recordHash } },
    });
    expect(reply.error).toBeUndefined();
    expect(reply.ok).toBe(true);
    const publication = host.session.status().publication!;
    const draftSource = isRigging
      ? { sourceHash: publication.source.sourceHash, projectHash: pending.recordHash }
      : undefined;
    acknowledgePublication(pending, publication.publicationId, publication.generation, requestId, [subject], draftSource);
    seedHistoricalPendingAsk(host, publication.publicationId, subject);
  });
  return { host, url: new URL(host.ownerUrl) };
}

async function openLegacyNumberedVerdict(root: string, version: number, stage: 'rig-review' | 'direction-review') {
  const subject = { kind: 'review-verdict', stage } as const;
  let declareLegacySubject = true;
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, testClock.now(), options => startJobHost({
    ...options, readPublished: async input => {
      const context = await readPublished(input);
      return declareLegacySubject ? { ...context, subjects: [subject] } : context;
    },
  }));
  legacyPackageHosts.add(host);
  const project = read(root);
  const result = { path: prepareLiveManifest(root, project, version), selector: publicationSelector(project, version) };
  const binding = readWriterBinding(root)!;
  const entry = enqueuePublication(root, binding, result);
  const requestId = randomUUID();
  await reconcilePublication(root, entry, async pending => {
    const reply = await agentCall(host, { schema: binding.identity.apiSchema, verb: 'publish', requestId, idempotencyKey: requestId,
      expectedGeneration: host.session.status().generation, result,
      freeze: { kind: 'producer-held', holdId: pending.id, record: { path: 'project.json', sha256: pending.recordHash } },
    });
    expect(reply.error).toBeUndefined();
    expect(reply.ok).toBe(true);
    const publication = host.session.status().publication!;
    acknowledgePublication(pending, publication.publicationId, publication.generation, requestId, [subject]);
    seedHistoricalPendingAsk(host, publication.publicationId, subject);
  });
  declareLegacySubject = false;
  return { host, url: new URL(host.ownerUrl) };
}

async function freshRigVerdict(verdict: 'approved' | 'changes-requested' | 'pending' = 'approved') {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  expectExit0(await cli(root, ['advance', 'rig-review', root, '--json']));
  const opening = await openLegacyNumberedVerdict(root, 1, 'rig-review');
  const view = await page(root, opening.url, 1);
  expect(view.asks.map(ask => ask.subject)).toEqual([{ kind: 'review-verdict', stage: 'rig-review' }]);
  const ask = view.asks[0]!;
  const act = await view.act('review-verdict', 'review-verdict', { stage: 'rig-review', verdict, words: WORDS },
    rigCapture(root, view, String(ask.askId)));
  return { root, opening, view, act };
}

async function open(root: string, options: string[] = []): Promise<{ url: URL; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), ...clockedCli(), 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...options], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  opened.push({ proc, root });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!/\njob: .*\n$/.test(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  reader.releaseLock();
  if (!text.trim()) throw new Error(await new Response(proc.stderr).text());
  const lines = text.trim().split('\n');
  return { url: new URL(lines[0]!), lines: lines.slice(1) };
}

async function page(root: string, url: URL, expectedAsks = 2) {
  const jobId = /\/jobs\/([^/]+)\//.exec(url.pathname)![1]!;
  const receipts = join(jobPrivateRoot(root), 'acknowledged-publications');
  const expectedPublication = readdirSync(receipts)
    .map(file => JSON.parse(readFileSync(join(receipts, file), 'utf8')) as AcknowledgedPublication)
    .filter(receipt => receipt.jobId === jobId)
    .sort((a, b) => b.generation - a.generation)[0]!;
  expect(expectedPublication).toBeDefined();
  const capability = url.hash.replace('#cap=', '');
  const base = `${url.origin}/jobs/${jobId}/`;
  const headers = { origin: url.origin, 'X-Review-Capability': capability, 'content-type': 'application/json' };
  const abort = new AbortController();
  const response = await fetch(base + 'events', { headers, signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const events: JsonObject[] = [];
  const pending = () => {
    const head = events.filter(event => event.type === 'published').at(-1)?.publication as JsonObject | undefined;
    return {
      head,
      asks: events
        .filter(event => event.type === 'pending' && (event.ask as JsonObject).publicationId === head?.publicationId)
        .map(event => event.ask as JsonObject),
    };
  };
  // Reconnect replays history. Ask counts on an older head do not establish the current page.
  const ready = () => pending().head?.publicationId === expectedPublication.publicationId
    && pending().asks.length >= expectedAsks;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !ready()) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      events.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
      if (ready()) break;
    }
  }
  abort.abort();
  const { head, asks } = pending();
  expect(head?.publicationId).toBe(expectedPublication.publicationId);
  const post = async (route: string, body: object) =>
    (await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })).json() as Promise<JsonObject>;
  const pageId = randomUUID();
  const displayed = await post('ui/displayed', {
    publicationId: head!.publicationId,
    pageId,
    sourceHash: (head!.source as JsonObject).sourceHash,
  });
  let expectedGeneration = Number(events.at(-1)!.generation);
  return {
    pageId,
    head: head!,
    asks,
    tryAct: async (subject: string, kind: string, value: object, extra: object = {}): Promise<JsonObject> => {
      const ask = asks.find(item => (item.subject as JsonObject).kind === subject)!;
      return await post('ui/acts', {
        publicationId: head!.publicationId,
        askId: ask.askId,
        pageId,
        displayedNonce: (displayed.value as JsonObject).displayedNonce,
        expectedGeneration,
        submissionId: randomUUID(),
        kind,
        value,
        ...extra,
      });
    },
    act: async (subject: string, kind: string, value: object, extra: object = {}): Promise<JsonObject> => {
      const ask = asks.find(item => (item.subject as JsonObject).kind === subject)!;
      const result = await post('ui/acts', {
        publicationId: head!.publicationId,
        askId: ask.askId,
        pageId,
        displayedNonce: (displayed.value as JsonObject).displayedNonce,
        expectedGeneration,
        submissionId: randomUUID(),
        kind,
        value,
        ...extra,
      });
      expect(result.error).toBeUndefined();
      expectedGeneration++;
      const actValue = result.value as JsonObject;
      const actAt = Date.parse(String(actValue.at));
      if (Number.isFinite(actAt) && actAt > testClock.now()) testClock.set(actAt);
      return actValue;
    },
  };
}

function rigCapture(root: string, view: Awaited<ReturnType<typeof page>>, askId: string): object {
  const png = readFileSync(join(root, 'evidence/setup.png'));
  return {
    capture: {
      png: `data:image/png;base64,${png.toString('base64')}`,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      camera: 'fixed',
      framing: 'default',
      view: 'whole-rig',
      frame: 'setup',
      playing: false,
      binding: {
        publicationId: view.head.publicationId,
        instanceKey: view.head.instanceKey,
        sourceHash: (view.head.source as JsonObject).sourceHash,
        pageId: view.pageId,
        askId,
        drawGeneration: 1,
        playerGeneration: 0,
      },
    },
  };
}

function expectExit0(result: { stdout: string; stderr: string; exit: number }): void {
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: '' });
}

async function preparedParts(): Promise<string> {
  // Write after the retained narrative, before the live host stamps its verdict.
  testClock.set(EXAMPLE_REOPEN_AT);
  const root = copy('1-parts-verdict');
  expectExit0(await cli(root, ['structure-snapshot', root, '--draft', 'chain', '--out', 'evidence/structure-chain.json']));
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  expectExit0(await cli(root, ['diff-classes', root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']));
  expectExit0(await cli(root, ['advance', 'parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input']));
  return root;
}

/** Preserve a synthetic issue through Review's public crop writer before submitting a bounce. */
async function partsIssue(root: string, url: URL, head: JsonObject): Promise<JsonObject> {
  const source = head.source as JsonObject;
  const parts = source.parts as JsonObject;
  const part = (parts.images as JsonObject[]).find(row => row.role === 'part')!;
  const png = readFileSync(join(root, dirname(String((parts.manifest as JsonObject).path)), String(part.path)));
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), sha256 = jobHash(png);
  const jobId = /\/jobs\/([^/]+)\//.exec(url.pathname)![1]!;
  const entry = `/jobs/${jobId}/publications/${String(head.publicationId)}/instances/${String(head.instanceKey)}/`;
  const response = await fetch(`${url.origin}${entry}api/stage-parts/comment`, {
    method: 'POST',
    headers: { origin: url.origin, 'X-Review-Capability': url.hash.replace('#cap=', ''), 'content-type': 'application/json' },
    body: JSON.stringify({ schema: 'rig-review-parts-comment/2', id: 'synthetic-issue', summary: 'Synthetic edge needs correction.',
      parts: [{ name: String(part.path).slice('parts/'.length, -'.png'.length), imageHash: part.sha256 }],
      sourceHash: source.sourceHash, rigRegion: { x: 0, y: 0, width, height }, imageRegion: null,
      view: { mode: 'assembled', camera: { zoom: 1, center: { x: 0, y: 0 }, viewport: { width: 800, height: 600 } },
        cameraSync: true, referenceCamera: null, background: 'checker', alpha: false, footprints: true, mesh: false },
      crop: { path: `comment-crops/${sha256}.png`, sha256, png: `data:image/png;base64,${png.toString('base64')}`, width, height }, nativeCrop: null }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { comment: JsonObject }).comment;
}

test.each(['approved', 'changes-requested'] as const)('#557 one parts %s act ingests with no second approval subject', async verdictValue => {
  const root = await preparedParts();
  const opening = await openLegacyDraftVerdict(root, 'chain');
  const firstView = await page(root, opening.url, 1);
  expect(firstView.asks.map(ask => ask.subject)).toEqual([{ kind: 'parts-verdict', draftId: 'chain' }]);
  expect((firstView.head.source as JsonObject).projectHash).toBe(jobHash(readFileSync(join(root, 'project.json'))));
  const issues = verdictValue === 'changes-requested' ? [await partsIssue(root, opening.url, firstView.head)] : [];
  const verdict = await firstView.act('parts-verdict', 'parts-verdict', { verdict: verdictValue, issues, words: WORDS });
  seedStoredPartsVerdictAct(root, verdict, { now: testClock.now(), checkProjectHash: true, checkArrival: true });
  const signatures = (read(root).signoffs as JsonObject[]).filter(row => row.stage === 'parts-review');
  if (verdictValue === 'approved') {
    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({ stage: 'parts-review', checkpoint: null, by: 'user', draft_id: 'chain',
      verbatim: `[general]\n${WORDS}`, source: `review act ${String(verdict.jobId)}/${String(verdict.actId)}` });
    const evidence = (read(root).review_acts as JsonObject[]).at(-1)!.evidence as JsonObject;
    expect(signatures[0]!.evidence).toEqual({ ...evidence,
      kind: 'parts-verdict', spec: verdict.schema });
    expect(signatures[0]!.structure).toEqual({ path: 'evidence/structure-chain.json', sha256: jobHash(readFileSync(join(root, 'evidence/structure-chain.json'))) });
    expect(nextProject(root, testClock.now()).moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'parts-review')).toBe(false);
    expect(checkProject(root).refusals.map(row => row.code)).toEqual([]);
    const saved = readFileSync(join(root, 'project.json'));
    seedStoredPartsVerdictAct(root, verdict, { now: testClock.now(), checkProjectHash: true, checkArrival: true });
    expect(readFileSync(join(root, 'project.json'))).toEqual(saved);
    expectExit0(await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner']));
    expect((await page(root, opening.url, 0)).asks).toEqual([]);
  } else {
    expect(signatures).toEqual([]);
    expect(nextProject(root, testClock.now()).moves.some(move => move.command?.startsWith('rig-create advance rigging-interview'))).toBe(false);
  }
}, REFRESH_FLOW_TIMEOUT_MS);

const MESH_DRAFT = 'mesh-preview';
const MESH_WORDS = '  Keep the silhouette.\r\nAdjust the synthetic mesh edge.  \r\n';

async function recordMeshPreview(root: string, id: string, model: boolean): Promise<void> {
  const path = `derived/drafts/${id}`;
  cpSync(join(root, 'derived/drafts/chain'), join(root, path), { recursive: true });
  if (!model) rmSync(join(root, path, 'out/check'), { recursive: true });
  expect(seedRetainedDraft([id, root, '--config', `${path}/config.json`, '--from', `${path}/out`, '--parts', `${path}/input`], testClock.now()).exit).toBe(0);
}

async function riggingPreview(model = false) {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  await recordMeshPreview(root, MESH_DRAFT, model);
  expect(checkProject(root).effective_stage).toBe('rigging');
  const opening = await open(root, ['--draft', MESH_DRAFT]);
  return { root, opening };
}

test('#712B model-backed rigging draft publishes the model without a verdict ask', async () => {
  const { root, opening } = await riggingPreview(true);
  const view = await page(root, opening.url, 0);
  expect(opening.lines).toEqual([`job: draft ${MESH_DRAFT} published (publication ${view.head.publicationId})`]);
  expect(view.asks).toEqual([]);
  expect(view.head.source).toMatchObject({ selector: { kind: 'draft', id: MESH_DRAFT }, model: {
    path: `derived/drafts/${MESH_DRAFT}/out/check/build/skeleton.model.json`,
  } });
  expect(readAcknowledgedPublication(root, readWriterBinding(root)!.jobId, String(view.head.publicationId))?.subjects).toEqual([]);
}, REFRESH_FLOW_TIMEOUT_MS);

async function riggingLegacyVerdictPreview() {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  await recordMeshPreview(root, MESH_DRAFT, false);
  expect(checkProject(root).effective_stage).toBe('rigging');
  const opening = await openLegacyDraftVerdict(root, MESH_DRAFT);
  return { root, opening };
}

async function reviewedMeshPreview(verdict: 'approved' | 'changes-requested') {
  const { root, opening } = await riggingLegacyVerdictPreview();
  const subject = { kind: 'parts-verdict', draftId: MESH_DRAFT } as const;
  const view = await page(root, opening.url, 1);
  expect(view.asks.map(ask => ask.subject)).toEqual([subject]);
  const source = view.head.source as JsonObject;
  const { sourceHash } = source;
  if (typeof sourceHash !== 'string') throw new Error('Review did not publish a source hash');
  const record = { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) };
  const selector = { kind: 'draft', id: MESH_DRAFT } as const;
  expect(source).toMatchObject({ selector, model: null, projectHash: record.sha256 });
  const jobId = readWriterBinding(root)!.jobId;
  const publication = readAcknowledgedPublication(root, jobId, String(view.head.publicationId));
  const manifestPath = `review-rigging-draft-${MESH_DRAFT}.json`;
  expect(publication?.subjects).toEqual([subject]);
  expect(publication?.result.path).toBe(manifestPath);
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as JsonObject;
  expect(manifest.id).toBe(`create-rigging-draft-${MESH_DRAFT}`);
  expect(source.package).toEqual({ id: manifest.id, revision: manifest.revision });
  expect(manifest.model).toBeUndefined();
  expect(publication?.draftSource).toEqual({ sourceHash, projectHash: record.sha256 });
  const closure = await readPublished({ root, record, result: { path: manifestPath, selector } });
  for (const file of ['rig.json', 'mesh_report.json']) {
    const path = `derived/drafts/${MESH_DRAFT}/out/${file}`;
    expect(closure.files).toContainEqual({ path, sha256: jobHash(readFileSync(join(root, path))) });
  }

  const before = read(root);
  const issue = verdict === 'changes-requested' ? await partsIssue(root, opening.url, view.head) : undefined;
  const act = await view.act('parts-verdict', 'parts-verdict', { verdict, issues: issue ? [issue] : [], words: MESH_WORDS });
  const seeded = seedStoredPartsVerdictAct(root, act, { now: testClock.now(), checkAck: true, checkProjectHash: true });
  expect(seeded).toMatchObject({ draft_id: MESH_DRAFT, verdict });
  const after = read(root);
  expect(after.stage).toBe('rigging');
  expect(after.advances).toEqual(before.advances);
  expect(after.signoffs).toEqual(before.signoffs);
  expect(after.versions).toEqual(before.versions);
  const receipts = after.review_acts as JsonObject[];
  expect<Json>(receipts.slice(0, -1)).toEqual(before.review_acts);
  const receipt = receipts.at(-1)!;
  expect(receipt).toMatchObject({ schema: 'rig-create/review-act@1', kind: 'parts-verdict', actId: act.actId, jobId, draft_id: MESH_DRAFT });
  expect(receipt.signoff).toBeUndefined();
  const evidence = receipt.evidence as JsonObject;
  const bytes = readFileSync(join(root, String(evidence.path)), 'utf8');
  expect(receipt.bytes).toBe(bytes);
  expect(evidence.sha256).toBe(jobHash(bytes));
  expect(JSON.parse(bytes)).toEqual(act);
  const decoded = decodeReviewAct(bytes, 'parts-verdict');
  expect(decoded.source.sourceHash).toBe(sourceHash);
  expect(decoded.source.selector).toEqual(selector);
  if (!('comments' in decoded.value)) throw new Error('Review did not retain a comments act');
  expect(decoded.value.comments).toContainEqual({ text: MESH_WORDS });
  if (issue) expect(decoded.value.comments.map(comment => comment.text)).toContain('Synthetic edge needs correction.');
  expect(checkProject(root).effective_stage).toBe('rigging');
  return { root, opening, act, evidence, manifestPath };
}

test('#712A model-less rigging changes-requested feeds the next draft', async () => {
  const { root, opening, act, evidence } = await reviewedMeshPreview('changes-requested');
  const next = nextProject(root, testClock.now());
  const feedback = next.moves.find(move => move.field === `drafts[${MESH_DRAFT}]` && move.role === 'agent');
  expect(feedback?.command).toBeNull();
  expect(feedback?.act).toContain(String(evidence.path));
  expect(feedback?.act).toContain(String(evidence.sha256));

  const id = 'mesh-revision';
  const before = read(root);
  await recordMeshPreview(root, id, false);
  expect(read(root)).toMatchObject({ stage: 'rigging', signoffs: before.signoffs, review_acts: before.review_acts });
  expect(nextProject(root, testClock.now()).moves.some(move => move.act.includes(String(act.actId))
    || move.act.includes(String(evidence.path)))).toBe(false);
  await openLegacyDraftVerdict(root, id, opening.host);
  const revised = await page(root, opening.url, 1);
  expect(revised.asks.map(ask => ask.subject)).toEqual([{ kind: 'parts-verdict', draftId: id }]);
}, REFRESH_FLOW_TIMEOUT_MS);

test('#712A rigging approval preserves draft evidence and the numbered rig view opens askless', async () => {
  const { root, opening } = await reviewedMeshPreview('approved');
  const draftPath = `derived/drafts/${MESH_DRAFT}`;
  for (const file of ['rig.json', 'mesh_report.json', 'motion.json']) {
    expect(readFileSync(join(root, `outputs/v1/out/rig/${file}`)))
      .toEqual(readFileSync(join(root, draftPath, 'out', file)));
  }
  expect(readFileSync(join(root, 'evidence/v1/config.json'))).toEqual(readFileSync(join(root, draftPath, 'config.json')));
  const draft = (read(root).drafts as JsonObject[]).find(row => row.id === MESH_DRAFT)!;
  for (const file of (draft.parts as JsonObject).files as JsonObject[]) {
    const part = String(file.path).slice(`${draftPath}/input/`.length);
    expect<Json>(jobHash(readFileSync(join(root, 'outputs/v1/out', part)))).toBe(file.sha256);
  }
  expectExit0(await cli(root, ['advance', 'rig-review', root, '--json']));
  expect((await page(root, opening.url, 0)).head.source).toMatchObject({ selector: { kind: 'draft', id: MESH_DRAFT } });
  expectExit0(await cli(root, ['job', 'open', root, '--rig', '1', '--reviewer', 'synthetic-owner', '--role', 'owner']));
  const view = await page(root, opening.url, 0);
  expect(view.head.source).toMatchObject({ selector: { kind: 'rig', version: 1 } });
  expect(view.asks).toEqual([]);
  expect((read(root).versions as JsonObject[])[0]!.verdicts).toEqual([]);
}, REFRESH_FLOW_TIMEOUT_MS);

test('#712A cloned rigging approval cannot sign or authorize a parts-review advance', async () => {
  const { root, act, evidence, manifestPath } = await reviewedMeshPreview('approved');
  const recorded = (read(root).review_acts as JsonObject[]).at(-1)!;
  const clone = copy('1-parts-verdict', project => {
    const draft = (read(root).drafts as JsonObject[]).find(row => row.id === MESH_DRAFT)!;
    project.drafts = [...(project.drafts as JsonObject[]), draft];
    project.review_acts = [recorded];
  });
  const draftPath = `derived/drafts/${MESH_DRAFT}`;
  cpSync(join(root, draftPath), join(clone, draftPath), { recursive: true });
  cpSync(join(root, manifestPath), join(clone, manifestPath));
  mkdirSync(join(clone, dirname(String(evidence.path))), { recursive: true });
  cpSync(join(root, String(evidence.path)), join(clone, String(evidence.path)));

  const advance = ['advance', 'parts-review', clone, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'];
  const recordPath = join(clone, 'project.json');
  async function refuses(args: string[], code: string): Promise<void> {
    const before = readFileSync(recordPath);
    const result = await cli(clone, args);
    expect(result.exit).toBe(1);
    expect(result.stderr).toStartWith(`rig-create: ${code}:`);
    expect(readFileSync(recordPath)).toEqual(before);
  }
  // A copied rigging receipt cannot replace the parts-stage report needed to enter parts-review.
  await refuses(advance.slice(0, 3), 'PARTS_CHECK_MISSING');
  const beforeAdvance = readFileSync(recordPath);
  expectExit0(await cli(clone, advance));
  const words = join(clone, 'parts-signoff-words.txt');
  writeFileSync(words, 'Approve the synthetic parts.\n');
  const retiredSignoff = await cli(clone, ['signoff', 'parts-review', clone, '--draft', MESH_DRAFT, '--by', 'user', '--verbatim-file', words]);
  expect(retiredSignoff.exit).toBe(USAGE_EXIT);
  expect(retiredSignoff.stderr).toStartWith('rig-create: NUMBERED_WRITER_REMOVED:');
  expect(() => seedStoredPartsSignoff(clone, MESH_DRAFT, {
    by: 'user',
    at: testClock.now(),
    verbatim: 'Approve the synthetic parts.\n',
  })).toThrow(expect.objectContaining({ code: 'PARTS_VERDICT_RECEIPT_REQUIRED' }));

  // A copied record can also point explicitly at the wrong receipt. The public
  // advance must verify the evidence even when the ledger contains a signoff row.
  const structure = `evidence/structure-${MESH_DRAFT}.json`;
  expectExit0(await cli(clone, ['structure-snapshot', clone, '--draft', MESH_DRAFT, '--out', structure]));
  const forged = JSON.parse(beforeAdvance.toString('utf8')) as JsonObject;
  forged.signoffs = [...(forged.signoffs as JsonObject[]), {
    stage: 'parts-review', checkpoint: null, by: 'user', at: act.at, verbatim: MESH_WORDS,
    draft_id: MESH_DRAFT, evidence: { ...evidence, kind: 'parts-verdict', spec: act.schema },
    structure: { path: structure, sha256: jobHash(readFileSync(join(clone, structure))) },
  }];
  write(clone, forged);
  // A clone may have dropped regenerable rig artifacts. Exercise the explicit
  // evidence lookup before the fallback that cannot reopen the full closure.
  rmSync(join(clone, draftPath, 'out/mesh_report.json'));
  await refuses(advance, 'PARTS_VERDICT_RECEIPT_INVALID');
}, REFRESH_FLOW_TIMEOUT_MS);

test.each(['missing source binding', 'mismatched source hash'] as const)('#712A rigging ack with %s refuses before recording the act', async fault => {
  const { root, opening } = await riggingLegacyVerdictPreview();
  const view = await page(root, opening.url, 1);
  const act = await view.act('parts-verdict', 'parts-verdict', { verdict: 'approved', issues: [], words: MESH_WORDS });
  const jobId = String(act.jobId), publicationId = String(act.publicationId);
  const ack = readAcknowledgedPublication(root, jobId, publicationId)!;
  const { sourceHash, projectHash } = act.source as JsonObject;
  if (typeof sourceHash !== 'string' || typeof projectHash !== 'string') throw new Error('Review act is missing its source binding');
  expect(ack.draftSource).toEqual({ sourceHash, projectHash });
  const path = join(jobPrivateRoot(root), 'acknowledged-publications', `${jobHash(JSON.stringify([jobId, publicationId]))}.json`);
  const originalAck = readFileSync(path);
  if (fault === 'missing source binding') delete ack.draftSource;
  else ack.draftSource!.sourceHash = jobHash('another synthetic publication');

  const recordPath = join(root, 'project.json');
  const before = readFileSync(recordPath);
  const evidence = join(root, 'evidence/review-acts', `${jobHash(JSON.stringify([jobId, act.actId]))}.json`);
  expect(existsSync(evidence)).toBe(false);
  writeFileSync(path, JSON.stringify(ack));
  try {
    expect(() => seedStoredPartsVerdictAct(root, act, { now: testClock.now(), checkAck: true, checkProjectHash: true }))
      .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
    expect(readFileSync(recordPath)).toEqual(before);
    expect(existsSync(evidence)).toBe(false);
  } finally {
    writeFileSync(path, originalAck);
  }
  seedStoredPartsVerdictAct(root, act, { now: testClock.now(), checkAck: true, checkProjectHash: true });
  expect(existsSync(evidence)).toBe(true);
}, REFRESH_FLOW_TIMEOUT_MS);

test('#557 a stale projectHash refuses parts verdict ingestion before either receipt or signature is written', async () => {
  const root = await preparedParts();
  const opening = await openLegacyDraftVerdict(root, 'chain');
  const view = await page(root, opening.url, 1);
  const verdict = await view.act('parts-verdict', 'parts-verdict', { verdict: 'approved', issues: [], words: WORDS });
  const project = read(root); project.title = 'Synthetic edit after the owner saw the record'; write(root, project);
  const before = readFileSync(join(root, 'project.json'));
  expect(() => seedStoredPartsVerdictAct(root, verdict, { now: testClock.now(), checkProjectHash: true, checkArrival: true }))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(read(root).review_acts ?? []).toEqual([]);
  expect((read(root).signoffs as JsonObject[]).some(row => row.stage === 'parts-review')).toBe(false);
  if (readdirSync(join(root, 'evidence')).includes('review-acts')) expect(readdirSync(join(root, 'evidence/review-acts'))).toEqual([]);
}, REFRESH_FLOW_TIMEOUT_MS);

interface RetouchRaster { width: number; height: number; data: Uint8ClampedArray }
interface RetouchPng {
  readPng(path: string): RetouchRaster;
  encodePngBytes(image: RetouchRaster): Uint8Array;
}

/** Only synthetic producer inputs are authored here. Assemble writes the edited provenance and measurements. */
async function produceRetouch(root: string, parts: string, id: string): Promise<{ args: string[]; input: string; sha256: string }> {
  const relative = `derived/drafts/${id}`;
  const target = join(root, relative);
  mkdirSync(target, { recursive: true });
  generateExampleParts(join(target, 'producer'));
  expect(jobHash(readFileSync(join(target, 'producer/painting.png')))).toBe(jobHash(readFileSync(join(root, 'inputs/painting.png'))));
  const png = await import(pathToFileURL(join(parts, 'src/raster/png.ts')).href) as RetouchPng;
  const baseline = join(target, 'producer/assembled/rig/parts/torso.png');
  const before = readFileSync(baseline);
  const image = png.readPng(baseline);
  const edited = { ...image, data: new Uint8ClampedArray(image.data) };
  let pixel = 0;
  while (pixel < edited.data.length && edited.data[pixel + 3]! <= 8) pixel += 4;
  expect(pixel).toBeLessThan(edited.data.length);
  // Change an opaque edge colour, leaving geometry and the one-pixel floor control explicit.
  edited.data[pixel] = edited.data[pixel]! < 128 ? edited.data[pixel]! + 64 : edited.data[pixel]! - 64;
  const bytes = png.encodePngBytes(edited);
  const sha256 = jobHash(bytes);
  expect(sha256).not.toBe(jobHash(before));
  mkdirSync(join(target, 'edits'));
  writeFileSync(join(target, 'edits/torso.png'), bytes);
  const decoded = png.readPng(join(target, 'edits/torso.png'));
  expect(decoded.data[pixel]).toBe(edited.data[pixel]);
  expect([decoded.width, decoded.height]).toEqual([image.width, image.height]);
  const config = JSON.parse(readFileSync(join(root, 'derived/drafts/chain/config.json'), 'utf8')) as JsonObject;
  config.seethrough = (JSON.parse(readFileSync(join(target, 'producer/config.json'), 'utf8')) as JsonObject).seethrough!;
  const receipt = { part: 'torso', file: 'torso.png', from_sha256: jobHash(before), sha256,
    editor: 'Synthetic script: change one opaque edge pixel against the painting reference' };
  (config.assemble as JsonObject).edited_parts = { dir: 'edits', receipts: [receipt] };
  writeFileSync(join(target, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  cpSync(join(root, 'derived/drafts/chain/interview-requirements.json'), join(target, 'interview-requirements.json'));
  // The rig output is a retained synthetic fixture; this test claims the real assemble edit route, not a rig rebuild.
  cpSync(join(root, 'derived/drafts/chain/out'), join(target, 'out'), { recursive: true });
  const args = ['assemble', '--source', join(target, 'producer/painting.png'), '--full', join(target, 'producer/layers'),
    '--config', join(target, 'config.json'), '--out', join(target, 'build')];
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(parts, 'cli.ts'), ...args],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stdout, stderr }).toMatchObject({ exit: 0 });
  expect(readFileSync(join(target, 'build/rig/parts/torso.png'))).toEqual(Buffer.from(bytes));
  const manifest = JSON.parse(readFileSync(join(target, 'build/rig/parts.json'), 'utf8')) as JsonObject;
  const torso = (manifest.parts as JsonObject[]).find(part => part.name === 'torso')!;
  expect((torso.provenance as JsonObject).edited_part).toMatchObject({ receipt, changed_px: 1 });
  return { args: [id, root, '--config', `${relative}/config.json`, '--parts', `${relative}/build/rig`, '--from', `${relative}/out`, '--json'],
    input: `${relative}/edits/torso.png`, sha256 };
}

function retouchArgs(command: string): string[] {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) { if (char === quote) quote = ''; else word += char; started = true; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === '\\') { word += command[++i]!; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  expect(quote).toBe('');
  if (started) words.push(word);
  return words;
}

test('#557 parts-review retouch lifecycle rejects once, records a real edited draft and folds one new approval', async () => {
  const root = await preparedParts();
  const id = 'retouched';
  const parts = realpathSync(locateParts(root)!);
  const scrub = (text: string) => text.replaceAll(root, '<synthetic>');
  const trace = (step: string): NextReport => {
    const output = nextCommand([root, '--json'], testClock.now());
    console.log('RETOUCH_NEXT', step, scrub(output.stdout));
    return JSON.parse(output.stdout) as NextReport;
  };
  const run = async (args: string[], structural = false) => {
    const result = await cli(root, args);
    console.log(structural && result.exit !== 0 ? 'RETOUCH_STRUCTURAL_STOP' : 'RETOUCH_COMMAND',
      scrub(JSON.stringify({ argv: ['rig-create', ...args], ...result })));
    expectExit0(result);
    return result;
  };
  const initial = read(root);
  const signoffCount = (initial.signoffs as JsonObject[]).length;
  const advances = structuredClone(initial.advances);
  const entry = (initial.advances as JsonObject[]).find(move => move.from_stage === 'parts' && move.stage === 'parts-review')!;
  const entryReport = (entry.parts_check as JsonObject).path as string;
  const oldReport = readFileSync(join(root, entryReport));
  const oldStructure = readFileSync(join(root, 'evidence/structure-chain.json'));
  const oldDiff = readFileSync(join(root, 'evidence/diff-components.json'));
  const oldDraft = structuredClone((initial.drafts as JsonObject[])[0]!);
  trace('ready-original');
  const opening = await openLegacyDraftVerdict(root, 'chain');
  const firstView = await page(root, opening.url, 1);
  const bounced = await firstView.act('parts-verdict', 'parts-verdict', { verdict: 'changes-requested',
    issues: [await partsIssue(root, opening.url, firstView.head)], words: 'Retouch the synthetic edge.' });
  trace('owner-changes-requested');
  seedStoredPartsVerdictAct(root, bounced, { now: testClock.now(), checkProjectHash: true, checkArrival: true });
  trace('changes-requested-ingested');
  expect(read(root).stage).toBe('parts-review');
  expect((read(root).signoffs as JsonObject[]).length).toBe(signoffCount);
  const retouch = await produceRetouch(root, parts, id);
  trace('edited-pixels-and-receipt-produced');
  expect(seedRetainedDraft(retouch.args, testClock.now()).exit).toBe(0);
  console.log('RETOUCH_PREFLIGHT', 'new edited_parts draft registered at parts-review without reopening');
  const registered = read(root);
  const fresh = (registered.drafts as JsonObject[]).find(draft => draft.id === id)!;
  expect(fresh.config_inputs as JsonObject[]).toContainEqual({ path: retouch.input, sha256: retouch.sha256 });
  expect((fresh.parts as JsonObject).files as JsonObject[]).toContainEqual({ path: `derived/drafts/${id}/build/rig/parts/torso.png`, sha256: retouch.sha256 });
  expect(registered.stage).toBe('parts-review');
  expect(registered.advances).toEqual(advances);
  let pending = trace('new-draft-registered');
  let structurePath = '';
  for (const prefix of ['rig-parts check-parts', 'rig-create structure-snapshot', 'rig-parts diff-components', 'rig-create diff-classes']) {
    expect(pending.moves.some(move => move.awaits === `review_acts[kind=parts-verdict,draft_id=${id}]`)).toBe(false);
    const move = pending.moves.find(move => move.command?.startsWith(prefix));
    expect(move, `EXPECTED_NEXT_HINT: ${prefix}`).toBeDefined();
    const argv = retouchArgs(move!.command!);
    if (prefix === 'rig-create structure-snapshot') structurePath = move!.awaits;
    if (argv[0] === 'rig-create') await run(argv.slice(1));
    else {
      const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(parts, 'cli.ts'), ...argv.slice(1)],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      console.log('RETOUCH_PRODUCER', scrub(JSON.stringify({ argv, exit, stdout, stderr })));
      expectExit0({ stdout, stderr, exit });
    }
    expect(read(root).stage).toBe('parts-review');
    expect(readFileSync(join(root, entryReport))).toEqual(oldReport);
    pending = trace(prefix);
  }
  const ready = read(root);
  const diffMap = ready.diff_map as JsonObject;
  const report = diffMap.report as JsonObject;
  expect(report.path).not.toBe('evidence/diff-components.json');
  const currentDiff = JSON.parse(readFileSync(join(root, String(report.path)), 'utf8')) as JsonObject;
  expect(report.sha256).toBe(jobHash(readFileSync(join(root, String(report.path)))));
  expect((currentDiff.stack as JsonObject).sha256).toBe(jobHash(readFileSync(join(root, `derived/drafts/${id}/build/render/recomposite_rig.png`))));
  expect((currentDiff.stack as JsonObject).sha256).not.toBe((JSON.parse(oldDiff.toString()) as { stack: JsonObject }).stack.sha256);
  expect(pending.moves.find(move => move.awaits === `review_acts[kind=parts-verdict,draft_id=${id}]`)).toMatchObject({
    role: 'human',
    command: null,
    act: expect.stringContaining('NUMBERED_ACT_RETIRED'),
  });
  await openLegacyDraftVerdict(root, id, opening.host);
  trace('new-draft-published');
  const secondView = await page(root, opening.url, 1);
  expect(secondView.asks.map(ask => ask.subject)).toEqual([{ kind: 'parts-verdict', draftId: id }]);
  const beforeApproval = readFileSync(join(root, 'project.json'));
  const approved = await secondView.act('parts-verdict', 'parts-verdict', { verdict: 'approved', issues: [], words: 'Approve the retouched synthetic edge.' });
  expect((approved.source as JsonObject).projectHash).toBe(jobHash(beforeApproval));
  trace('owner-approved-new-draft');
  seedStoredPartsVerdictAct(root, approved, { now: testClock.now(), checkProjectHash: true, checkArrival: true });
  const folded = read(root);
  expect(folded.stage).toBe('parts-review');
  expect(folded.advances).toEqual(advances);
  expect(folded.diff_map).toEqual(diffMap);
  expect((folded.drafts as JsonObject[])[0]).toEqual(oldDraft);
  expect((folded.signoffs as JsonObject[]).length).toBe(signoffCount + 1);
  const signature = (folded.signoffs as JsonObject[]).at(-1)!;
  expect(signature).toMatchObject({ stage: 'parts-review', checkpoint: null, draft_id: id,
    source: `review act ${String(approved.jobId)}/${String(approved.actId)}`,
    structure: { path: structurePath, sha256: jobHash(readFileSync(join(root, structurePath))) } });
  expect(structurePath).not.toBe('evidence/structure-chain.json');
  expect(JSON.stringify(signature)).not.toContain('derived/drafts/chain/');
  const acts = folded.review_acts as JsonObject[];
  expect(acts).toHaveLength(2);
  expect(acts.map(act => act.kind)).toEqual(['parts-verdict', 'parts-verdict']);
  expect((signature.evidence as JsonObject).path).toBe((acts[1]!.evidence as JsonObject).path);
  expect((signature.evidence as JsonObject).path).not.toBe((acts[0]!.evidence as JsonObject).path);
  expect(folded.reopens).toEqual(initial.reopens);
  expect(readFileSync(join(root, 'evidence/structure-chain.json'))).toEqual(oldStructure);
  expect(readFileSync(join(root, 'evidence/diff-components.json'))).toEqual(oldDiff);
  expect(checkProject(root).refusals.map(finding => finding.code)).toEqual([]);
  expect(checkProject(root).holes ?? []).toEqual([]);
  const final = trace('new-approval-folded');
  expect(final.moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'parts-review')).toBe(false);
  const advance = final.moves.find(move => move.command?.startsWith('rig-create advance rigging-interview'))!;
  expect(advance).toBeDefined();
  await run(retouchArgs(advance.command!).slice(1), true);
  trace('final-advance');
  expect(read(root).stage).toBe('rigging-interview');
  expect(readFileSync(join(root, entryReport))).toEqual(oldReport);
}, 60_000);

test('#467 source-linked direction verdict then record sign-off ingests and advances accepted', async () => {
  const historyWords = `Synthetic direction history. ${'retained review words. '.repeat(400)}`;
  const root = copy('example-chain', project => {
    project.stage = 'post';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'direction-review' && entry.stage !== 'accepted');
    project.signoffs = (project.signoffs as JsonObject[]).filter(entry => entry.stage !== 'direction-review');
    const postVersion = (project.versions as JsonObject[]).find(v => v.n === 2)!;
    postVersion.verdicts = Array.from({ length: 64 }, (_, index) => ({ by: 'user', at: postVersion.at!,
      review: 'direction-review', verdict: 'provisional', verbatim: `${index}: ${historyWords}`, source: 'synthetic history', on_items: [] }));
  });
  expectExit0(await cli(root, ['advance', 'direction-review', root, '--json']));
  const opening = await openLegacyNumberedVerdict(root, 2, 'direction-review');

  const firstView = await page(root, opening.url, 1);
  expect((firstView.head.source as JsonObject).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  expect(firstView.asks.map(ask => ask.subject)).toEqual([{ kind: 'review-verdict', stage: 'direction-review' }]);
  const verdict = await firstView.act('review-verdict', 'review-verdict', { stage: 'direction-review', verdict: 'approved', words: WORDS });

  seedStoredReviewVerdictAct(root, 2, JSON.stringify(verdict), { now: testClock.now(), checkProjectHash: true });

  // Refresh the post page after ingest; its verdict is already recorded, so no subject is declared.
  const refreshed = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', 'v2']);
  expectExit0(refreshed);
  const refreshedView = await page(root, opening.url, 0);
  expect(refreshed.stdout.trim().split('\n')).toEqual([
    opening.url.href,
    `job: post v2 published (publication ${refreshedView.head.publicationId})`,
  ]);
  expect(refreshedView.asks.map(ask => ask.subject)).toEqual([]);
  expect(refreshedView.head.publicationId).not.toBe(firstView.head.publicationId);
  expect((refreshedView.head.source as JsonObject).selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
  expect((refreshedView.head.source as JsonObject).projectHash).toBe(jobHash(readFileSync(join(root, 'project.json'))));

  const reused = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--rig', '2']);
  expectExit0(reused);
  expect(reused.stdout.trimEnd().split('\n')).toContain(`job: post v2 already published (publication ${refreshedView.head.publicationId})`);
  expect((await page(root, opening.url, 0)).head.publicationId).toBe(refreshedView.head.publicationId);

  const record = await cli(root, ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--plan']);
  expectExit0(record);
  const recordView = await page(root, opening.url, 0);
  expect(record.stdout.trim().split('\n')).toEqual([opening.url.href, `job: plan published (publication ${recordView.head.publicationId})`]);
  expect((recordView.head.source as JsonObject).subject).toBe('plan');
  expect((recordView.head.source as JsonObject).selector).toBeUndefined();
  expect((recordView.head.source as JsonObject).subjects).toEqual([]);
  expect(recordView.asks).toEqual([]);

  // Close the numbered job before serving the historical act@4 from a new record host.
  expectExit0(await cli(root, ['job', 'close', root]));
  opening.host.stop();
  legacyPackageHosts.delete(opening.host);
  expect(readWriterBinding(root)).toBeNull();
  const legacySubjects = [{ kind: 'signoff' as const, stage: 'direction-review' as const }];
  const legacyHost = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, testClock.now(), options => startJobHost({
    ...options,
    readRecordPublished: ((request: RecordPublicationRequest) => {
      const context = readRecordPublished(request, testClock.now());
      return context.plan === null ? context : { ...context, subjects: legacySubjects };
    }) as typeof readRecordPublished,
  }), true);
  try {
    const result = { kind: 'plan' as const };
    enqueuePublication(root, readWriterBinding(root)!, result);
    await reconcileCreateJob(root, async entry => {
      const requestId = randomUUID();
      const reply = await agentCall(legacyHost, { verb: 'publish', requestId, idempotencyKey: requestId,
        expectedGeneration: 0, result,
        freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } } });
      expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
      const { publication, generation } = legacyHost.session.status();
      acknowledgePublication(entry, publication!.publicationId, generation, requestId, legacySubjects);
    });
    const session = legacyHost.session as unknown as {
      jobId: string;
      store: { update(jobId: string, rev: null, fn: (row: { data: { generation: number; reviewer: { id: string; role: string }; publications: Record<string, { retained: { source: unknown } }>; asks: Record<string, unknown>; acts: Record<string, unknown> } }) => { data: unknown }): unknown };
      event(data: unknown, value: object): unknown;
    };
    const publicationId = legacyHost.session.status().publication!.publicationId;
    let signed!: JsonObject;
    session.store.update(session.jobId, null, ({ data }) => {
      data.generation++;
      const askId = randomUUID();
      const source = data.publications[publicationId]!.retained.source;
      const ask = { askId, publicationId, subject: legacySubjects[0], source, status: 'answered' };
      data.asks[askId] = ask;
      session.event(data, { type: 'pending', ask: { ...ask, status: 'pending' } });
      const actId = randomUUID();
      const act = parseRecordAct({
        schema: JOB_RECORD_ACT_SCHEMA, actId, jobId: session.jobId, askId, publicationId,
        authority: { actor: 'human', channel: 'review-ui', reviewer: { ...data.reviewer } },
        at: testClock.iso(), kind: 'signoff', source,
        value: { stage: 'direction-review', decision: 'approved', words: WORDS },
      }) as unknown as JsonObject;
      data.generation++;
      data.acts[actId] = act;
      session.event(data, { type: 'act', act });
      signed = act;
      return { data };
    });
    expect(signed.schema).toBe('rig-review/act@4');
    expect((signed.source as JsonObject).selector).toBeUndefined();
    const original = readFileSync(join(root, 'project.json'));
    expect(original.length).toBeGreaterThan(512_000);
    writeFileSync(join(root, 'project.json'), Buffer.concat([original, Buffer.from(' ')]));
    const staleBytes = readFileSync(join(root, 'project.json'));
    const retiredCli = await cli(root, ['signoff', 'direction-review', root, '--from-review', String(signed.actId)]);
    expect(retiredCli.exit).toBe(USAGE_EXIT);
    expect(retiredCli.stderr).toContain('SIGNOFF_FROM_REVIEW_REMOVED:');
    expect(() => seedStoredSignoffAct(root, 'direction-review', signed, { now: testClock.now(), checkProjectHash: true }))
      .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
    expect(readFileSync(join(root, 'project.json'))).toEqual(staleBytes);
    writeFileSync(join(root, 'project.json'), original);
    expect(() => seedStoredSignoffAct(root, 'direction-review', signed, { now: testClock.now(), checkProjectHash: true, version: '1' }))
      .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_TARGET_MISMATCH' }));
    expect(readFileSync(join(root, 'project.json'))).toEqual(original);
    seedStoredSignoffAct(root, 'direction-review', signed, { now: testClock.now(), checkProjectHash: true });
    const saved = read(root);
    const target = (saved.signoffs as JsonObject[]).at(-1)!.target as JsonObject;
    expect(target.version).toBe(2);
    const signedBytes = readFileSync(join(root, 'project.json'));
    const growth = signedBytes.length - original.length;
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThan(32_768);
    expect(growth).toBeLessThan(original.length / 10);
    const receipt = (saved.review_acts as JsonObject[]).find(entry => entry.actId === signed.actId)!;
    expect(receipt.record_bytes).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain(historyWords);
    expect(receipt.record_sha256).toBe(jobHash(original));
    expect(receipt.record_sha256).toBe((signed.source as JsonObject).projectHash);
    expect(receipt.target_version).toBe(target.version);
    expect(receipt.verdict).toBe(target.verdict);
    console.log(JSON.stringify({ evidence: '#467 compact direction receipt growth', before_bytes: original.length,
      after_bytes: signedBytes.length, delta_bytes: growth }));
    expect(reviewActFindings(saved)).toEqual([]);
    const later = structuredClone(saved);
    (later.versions as JsonObject[]).push({ ...(later.versions as JsonObject[]).find(version => version.n === 2)!, n: 99 });
    expect(reviewActFindings(later)).toEqual([]);
    expectExit0(await cli(root, ['advance', 'accepted', root, '--json']));
    const accepted = readFileSync(join(root, 'project.json'));
    seedStoredSignoffAct(root, 'direction-review', signed, { now: testClock.now(), checkProjectHash: true });
    expect(readFileSync(join(root, 'project.json'))).toEqual(accepted);
    for (const [key, value] of Object.entries({ record_sha256: '0'.repeat(64), target_version: 99, verdict: 'versions[1].verdicts[0]' })) {
      const tampered = JSON.parse(accepted.toString('utf8')) as JsonObject;
      (tampered.review_acts as JsonObject[]).find(entry => entry.actId === signed.actId)![key] = value;
      write(root, tampered);
      expect(reviewActFindings(tampered).map(finding => finding.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
      const beforeRetry = readFileSync(join(root, 'project.json'));
      expect(() => seedStoredSignoffAct(root, 'direction-review', signed, { now: testClock.now(), checkProjectHash: true }))
        .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_LEDGER_INVALID' }));
      expect(readFileSync(join(root, 'project.json'))).toEqual(beforeRetry);
    }
    writeFileSync(join(root, 'project.json'), accepted);
    const report = checkProject(root, undefined, { now: Date.now() });
    expect(report.refusals).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.holes ?? []).toEqual([]);
  } finally {
    legacyHost.stop();
  }
}, 30_000);

// Recreate the historical verdict-only publication to exercise the retained fold path.
test('#574 fresh rig approval folds one signature, preserves words, replays bytes and advances at check0', async () => {
  const { root, act } = await freshRigVerdict();
  const before = read(root);
  expect(nextProject(root, testClock.now()).moves.some(move => move.review_act?.kind === 'review-verdict')).toBe(false);
  seedStoredReviewVerdictAct(root, 1, JSON.stringify(act), { now: testClock.now(), foldSignoff: true, checkProjectHash: true });
  const saved = read(root);
  const signature = (saved.signoffs as JsonObject[]).at(-1)!;
  expect(saved.stage).toBe('rig-review');
  expect((saved.signoffs as JsonObject[]).slice(0, -1)).toEqual(before.signoffs as JsonObject[]);
  expect(signature).toMatchObject({ stage: 'rig-review', checkpoint: null, by: 'user', at: act.at,
    verbatim: `[general]\n${WORDS}`, source: `review act ${String(act.jobId)}/${String(act.actId)}`, target: { version: 1 } });
  expect((saved.review_acts as JsonObject[]).at(-1)!.signoff).toBe((saved.signoffs as JsonObject[]).length - 1);
  expect(reviewActFindings(saved)).toEqual([]);
  expect(checkProject(root).refusals.map(f => f.code)).toEqual([]);
  expect(nextProject(root, testClock.now()).moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'rig-review')).toBe(false);
  const bytes = readFileSync(join(root, 'project.json'));
  seedStoredReviewVerdictAct(root, 1, JSON.stringify(act), { now: testClock.now(), foldSignoff: true, checkProjectHash: true });
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
  expectExit0(await cli(root, ['advance', 'post-interview', root, '--json']));
  expect(read(root).stage).toBe('post-interview');
  // Complete the newly entered interview through its writers, rather than hiding its three real holes.
  writeFileSync(join(root, 'owner-post.txt'), 'Keep each displayed synthetic post choice.\r\n');
  for (const question of ['camera_depth', 'post_timing', 'post_composition']) {
    const set = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-chain/checkpoints/4-direction-post/evidence/interview', `${question}.json`), 'utf8')) as JsonObject;
    set.id = `folded-${question}`;
    set.drafted_at = testClock.iso();
    set.context = optionContext(read(root), 'post-interview', testClock.now());
    const path = `evidence/interview/folded-${question}.json`;
    const bytes = `${JSON.stringify(set, null, 2)}\n`;
    writeFileSync(join(root, path), bytes);
    interviewOptionsCommand([question, root, '--file', path]);
    interviewAnswerCommand([question, root, '--set', path, '--sha256', jobHash(bytes), '--by', 'user',
      ...(set.asks as JsonObject[]).flatMap(ask => ['--pick', `${String(ask.id)}=keep`]),
      '--owner-chat', join(root, 'owner-post.txt'), '--said-at', testClock.iso(), '--relayed-by', 'synthetic-operator']);
  }
  expect(checkProject(root).refusals).toEqual([]);
  expect(checkProject(root).warnings).toEqual([]);
  expectExit0(await cli(root, ['interview', '--check', root, '--json']));
}, REFRESH_FLOW_TIMEOUT_MS);

for (const verdict of ['changes-requested', 'pending'] as const) test(`#574 fresh rig ${verdict} stays unsigned`, async () => {
  const { root, act } = await freshRigVerdict(verdict);
  const before = read(root);
  seedStoredReviewVerdictAct(root, 1, JSON.stringify(act), { now: testClock.now(), foldSignoff: true, checkProjectHash: true });
  const saved = read(root);
  expect(saved.signoffs).toEqual(before.signoffs);
  expect((saved.review_acts as JsonObject[]).at(-1)!.signoff).toBeUndefined();
  expect(saved.stage).toBe('rig-review');
  expect(reviewActFindings(saved)).toEqual([]);
}, REFRESH_FLOW_TIMEOUT_MS);

test('#574 folded rig ledger and replay reject changed authority, target, mapping and duplicate signatures', async () => {
  const { root, act } = await freshRigVerdict();
  seedStoredReviewVerdictAct(root, 1, JSON.stringify(act), { now: testClock.now(), foldSignoff: true, checkProjectHash: true });
  const original = read(root);
  const changes: ((p: JsonObject) => void)[] = [
    p => { (p.signoffs as JsonObject[]).at(-1)!.by = 'delegate'; },
    p => { (p.signoffs as JsonObject[]).at(-1)!.verbatim = 'Replacement words'; },
    p => { (p.signoffs as JsonObject[]).at(-1)!.at = '2020-01-01T00:00:00Z'; },
    p => { ((p.signoffs as JsonObject[]).at(-1)!.target as JsonObject).version = 2; },
    p => { ((p.signoffs as JsonObject[]).at(-1)!.target as JsonObject).verdict = 'versions[0].verdicts[99]'; },
    p => { (((p.signoffs as JsonObject[]).at(-1)!.target as JsonObject).review_package as JsonObject).sha256 = '0'.repeat(64); },
    p => { delete (p.review_acts as JsonObject[]).at(-1)!.signoff; },
    p => { (p.review_acts as JsonObject[]).at(-1)!.signoff = 0; },
    p => { (p.signoffs as JsonObject[]).push(structuredClone((p.signoffs as JsonObject[]).at(-1)!)); },
  ];
  for (const change of changes) {
    const candidate = structuredClone(original);
    change(candidate);
    expect(reviewActFindings(candidate).map(f => f.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
    write(root, candidate);
    const bytes = readFileSync(join(root, 'project.json'));
    expect(() => seedStoredReviewVerdictAct(root, 1, JSON.stringify(act), { now: testClock.now(), foldSignoff: true, checkProjectHash: true }))
      .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_LEDGER_INVALID' }));
    expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
  }
  write(root, original);
}, 30_000);

test('#574 fresh rig approval refuses moved project bytes before creating signature or receipt', async () => {
  const { root, act } = await freshRigVerdict();
  const moved = read(root);
  moved['x-synthetic-note'] = 'Record changed after owner display';
  write(root, moved);
  const bytes = readFileSync(join(root, 'project.json'));
  const retired = await cli(root, ['review', '1', root, '--from-review', String(act.actId), '--json']);
  expect(retired.exit).toBe(USAGE_EXIT);
  expect(retired.stderr).toContain('NUMBERED_WRITER_REMOVED');
  expect(() => seedStoredReviewVerdictAct(root, 1, JSON.stringify(act), { now: testClock.now(), foldSignoff: true, checkProjectHash: true }))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
}, REFRESH_FLOW_TIMEOUT_MS);

test('#574 folded rig shares live-target and retained-package refusal gates before any write', async () => {
  const { root, act } = await freshRigVerdict();
  const before = read(root);
  const bytes = readFileSync(join(root, 'project.json'));
  const decoded = decodeReviewAct(JSON.stringify(act));
  const baseline = checkProject(root, before);
  const acceptedCandidate = () => {
    const candidate = structuredClone(before);
    ((candidate.versions as JsonObject[])[0]!.verdicts as JsonObject[]).push(reviewActVerdict(decoded));
    return candidate;
  };
  const lost = acceptedCandidate();
  (lost.versions as JsonObject[])[0]!.pre_interview = true;
  (lost.versions as JsonObject[])[0]!.outputs_lost = { note: 'Synthetic lost outputs', source: 'synthetic inventory' };
  expect(() => foldHistoricalRigSignoff(root, lost, decoded, bytes, baseline, testClock.now())).toThrow(expect.objectContaining({ code: 'SIGNOFF_TARGET_STALE' }));
  const stale = acceptedCandidate();
  stale.reopens = [{ stage: 'rig-review', from_stage: 'rig-review', by: 'user', at: act.at,
    verbatim: 'Rebuild this synthetic rig.', steps_before: [],
    source: OWNER_CHAT_SOURCE, said_at: act.at, relayed_by: 'synthetic-relay' }];
  expect(() => foldHistoricalRigSignoff(root, stale, decoded, bytes, baseline, testClock.now())).toThrow(expect.objectContaining({ code: 'RIG_VERSION_UNACCEPTED' }));
  const missing = acceptedCandidate();
  delete (missing.versions as JsonObject[])[0]!.review_package;
  expect(() => foldHistoricalRigSignoff(root, missing, decoded, bytes, baseline, testClock.now())).toThrow(expect.objectContaining({ code: 'SIGNOFF_TARGET_STALE' }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
}, REFRESH_FLOW_TIMEOUT_MS);

test('#574 fresh approval refuses actual reopen rigging before ingest without downgrading to legacy', async () => {
  const { root, act } = await freshRigVerdict();
  testClock.set(testClock.now() + 1_000);
  const words = join(root, 'reopen-words.txt');
  writeFileSync(words, 'Rebuild this synthetic rig before accepting it.\r\n');
  plantLegacyReopen(root, 'rigging', { by: 'user', wordsFile: words });
  expect(checkProject(root).effective_stage).toBe('rigging');
  const before = readFileSync(join(root, 'project.json'));
  expect(() => seedStoredReviewVerdictAct(root, 1, JSON.stringify(act), { now: testClock.now(), foldSignoff: true, checkProjectHash: true }))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}, REFRESH_FLOW_TIMEOUT_MS);
