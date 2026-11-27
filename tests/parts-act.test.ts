import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JobAct, JobPartOutcome, JobVerdict } from '../node_modules/@rig-c/review/src/job-contract.ts';
import { loadPartsView, verdictSource } from '../node_modules/@rig-c/review/src/parts-view.ts';
import { partsDraftEditable } from '../node_modules/@rig-c/review/src/interview-project.ts';
import { JOB_COMMENTS_ACT_SCHEMA, PARTS_COMMENTS_VERDICT_SCHEMA, projectComments, startJobHost, type JobComment, type JobOwnerHost } from '@rig-c/review/job-host';
import { openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { agentCall } from '../src/job-acts.ts';
import { draftPublishedContext, partsEnumerator, prepareDraftManifest, readPublished } from '../src/job-publication.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, pendingPublications, readWriterBinding, reconcilePublication } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv, prepareDraftIntent, publishCommittedVersion, takePendingNotices } from '../src/job-writer.ts';
import { checkProject, collectItems } from '../src/check.ts';
import { optionContext } from '../src/choices.ts';
import { interviewOptionsCommand, interviewAnswerCommand } from '../src/choice-writers.ts';
import { interviewStageOfGuide } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import { planCommand } from '../src/plan-writers.ts';
import { advanceCommand, stepStatusCommand } from '../src/progress-writers.ts';
import { amendCommand } from '../src/amend.ts';
import { latestPartsApproval } from '../src/structure.ts';
import { diffClassesCommand } from '../src/diff-classes.ts';
import { derivedCommand } from '../src/prepared-inputs.ts';
import { nextProject } from '../src/next.ts';
import { signoffCommand } from '../src/signoff.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import { assertPartsActSource, partsActDraftHash, partsActFindings } from '../src/parts-act.ts';
import { seedRetainedDraft } from './numbered-seed.ts';
import { latestPartsReceipt, latestPartsVerdictStatus, partsReadFindings, recordedPartsVerdict } from '../src/parts-verdict-record.ts';
import { decodeReviewAct, partsActIssues, reviewActFindings, type PartsVerdictActV5 } from '../src/review-act.ts';
import { EXAMPLE_ANCHOR, EXAMPLE_NOW } from '../scripts/example-time.ts';
import { seedStoredPartsSignoff, seedStoredPartsVerdictAct, seedStoredSignoffAct } from './historical-review-fixture.ts';
import { recordPartsReceipt, seedPartsCliReceipt } from './parts-receipt-fixture.ts';
import { treeDigest } from './helpers.ts';
import type { JsonObject } from '../src/templates.ts';

const roots: string[] = [];
const hosts: JobOwnerHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of roots.splice(0)) {
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
function read(root: string): JsonObject { return JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')); }
function write(root: string, project: JsonObject): void { writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`); }
function fixture(recorded = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-parts-act-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), root, { recursive: true });
  cpSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), join(root, 'evidence/diff-components.json'));
  if (!recorded) { const project = read(root); project.drafts = []; write(root, project); }
  return root;
}
const SINGLE_ACT_TIMEOUT_MS = 10_000;
const MULTI_SPAWN_TIMEOUT_MS = 15_000;
const DUAL_REPLAY_TIMEOUT_MS = 20_000;

interface CliResult {
  args: string[];
  stdout: string;
  stderr: string;
  exit: number;
  signal: Bun.Subprocess['signalCode'];
  code: string | null;
}

function refusalCode(stderr: string): string | null {
  const match = /^rig-create: ([A-Z][A-Z0-9_]*): /m.exec(stderr);
  return match ? match[1]! : null;
}

async function cli(root: string, args: string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, '../src/cli.ts'), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { args, stdout, stderr, exit, signal: child.signalCode, code: refusalCode(stderr) };
}

function expectCliOk(result: CliResult): CliResult {
  expect(result.stderr).toBe('');
  expect(result.code).toBeNull();
  expect(result.signal).toBeNull();
  expect({ args: result.args, exit: result.exit, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toEqual({
    args: result.args,
    exit: 0,
    signal: null,
    stdout: result.stdout,
    stderr: '',
  });
  expect(result.exit).toBe(0);
  return result;
}

function expectCliRefused(result: CliResult, code: string, exit = 1): CliResult {
  expect({
    args: result.args,
    exit: result.exit,
    signal: result.signal,
    code: result.code,
    stderr: result.exit === exit && result.code === code ? `${code}:` : result.stderr || result.stdout,
  }).toEqual({
    args: result.args,
    exit,
    signal: null,
    code,
    stderr: `${code}:`,
  });
  expect(result.exit).toBe(exit);
  expect(result.stderr).toContain(`${code}:`);
  return result;
}

const draftArgs = (root: string, id = 'chain') => [id, root, '--config', `derived/drafts/${id}/config.json`, '--from', `derived/drafts/${id}/out`, '--parts', `derived/drafts/${id}/input`, '--json'];
async function openHistoricalPartsJob(root: string, reviewer = 'synthetic-owner') {
  return openCreateJob(root, { id: reviewer, role: 'owner' }, Date.now(), options => startJobHost({
    ...options,
    readPublished: async input => {
      const context = await readPublished(input);
      const sel = input.result.selector;
      return sel?.kind === 'draft' && 'id' in sel
        ? { ...context, subjects: [{ kind: 'parts-verdict', draftId: sel.id }] }
        : context;
    },
  }));
}
async function publishHistoricalDraft(root: string, host: JobOwnerHost, draftId = 'chain'): Promise<void> {
  const project = read(root);
  const result = { path: prepareDraftManifest(root, project, draftId), selector: { kind: 'draft' as const, id: draftId } };
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
    const pub = host.session.status().publication!;
    acknowledgePublication(pending, pub.publicationId, pub.generation, requestId, [{ kind: 'parts-verdict', draftId }]);
  });
}
async function bound(ready = true, reviewer = 'synthetic-owner') {
  const root = fixture();
  const host = await openHistoricalPartsJob(root, reviewer);
  hosts.push(host);
  const result = seedRetainedDraft(draftArgs(root), Date.now());
  expect(result.exit).toBe(0);
  await publishHistoricalDraft(root, host, 'chain');
  expect(host.session.status().publication?.source.selector).toEqual({ kind: 'draft', id: 'chain' });
  expect(host.session.status().publication!.source.parts!.images.map(({ path, role }) => ({ path, role })))
    .toEqual(partsEnumerator.enumerate(join(root, 'derived/drafts/chain/input')));
  if (ready) await readyForVerdict(root, host);
  return { root, host };
}
function prepTime(project: JsonObject): number {
  // Exclude runtime-registered drafts: Review stamps acts on the wall clock, so setup anchors to retained checkpoint dates and *_SINCE.
  const records = [
    ...(Array.isArray(project.inputs) ? project.inputs : []),
    ...(Array.isArray(project.advances) ? project.advances : []),
    ...(Array.isArray(project.signoffs) ? project.signoffs : []),
  ];
  const times = records
    .map(entry => (entry && typeof entry === 'object' && !Array.isArray(entry) ? Date.parse(String((entry as JsonObject).at)) : NaN))
    .filter(Number.isFinite);
  return Math.max(EXAMPLE_ANCHOR, ...times) + 1_000;
}
async function readyForVerdict(root: string, host: JobOwnerHost): Promise<void> {
  const prepNow = prepTime(read(root));
  structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/structure-chain.json']);
  diffClassesCommand([root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'], prepNow);
  advanceCommand(['parts-review', root, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'], prepNow);
  await publishHistoricalDraft(root, host, 'chain');
}
async function submit(
  root: string,
  host: JobOwnerHost,
  verdict: Extract<JobVerdict, 'approved' | 'changes-requested'> = 'approved',
  outcome: JobPartOutcome = 'clean',
  mesh: JobPartOutcome = outcome,
  showLayers = false,
): Promise<JobAct> {
  const publication = host.session.status().publication!;
  const request = { schema: 'rig-review/job-api@2', verb: 'ask', jobId: host.session.jobId, requestId: randomUUID(),
    idempotencyKey: randomUUID(), expectedGeneration: host.session.status().generation, publicationId: publication.publicationId,
    subject: { kind: 'parts-verdict', draftId: 'chain' } };
  const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, { method: 'POST',
    headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' }, body: JSON.stringify(request) }));
  const asked = await response.json() as { ok: boolean; error?: { code: string }; value: { askId: string } };
  expect(asked.error).toBeUndefined(); expect(asked.ok).toBe(true);
  const pageId = randomUUID();
  const ui = (route: string, body: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, { method: 'POST',
    headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const displayed = await host.ports.ackDisplayed(host.session.jobId, ui('displayed', { publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash }));
  expect(displayed.ok ? undefined : displayed.error.code).toBeUndefined();
  expect(displayed.ok).toBe(true); if (!displayed.ok) throw Error(displayed.error.code);
  let issues: Record<string, unknown>[] = [];
  if (verdict === 'changes-requested') {
    const firstPart = publication.source.parts!.images.find(img => img.role === 'part')!;
    const partName = firstPart.path.slice('parts/'.length, -'.png'.length);
    const partsDir = dirname(join(root, publication.source.parts!.manifest.path));
    const partBytes = readFileSync(join(partsDir, firstPart.path));
    const width = partBytes.readUInt32BE(16), height = partBytes.readUInt32BE(20);
    const cropSha = jobHash(partBytes);
    const entryBase = host.session.displayPublication(publication.publicationId).routes.entry;
    const rawIssue = {
      schema: 'rig-review-parts-comment/2',
      id: 'issue-1',
      summary: mesh === 'flagged' ? 'Synthetic mesh finding.' : outcome === 'flagged' ? 'Synthetic edge finding.' : 'Synthetic part finding.',
      parts: [{ name: partName, imageHash: firstPart.sha256 }],
      sourceHash: publication.source.sourceHash,
      rigRegion: { x: 0, y: 0, width, height },
      imageRegion: null,
      view: {
        mode: 'assembled',
        camera: { zoom: 1, center: { x: 0, y: 0 }, viewport: { width: 800, height: 600 } },
        cameraSync: true,
        referenceCamera: null,
        background: 'checker',
        alpha: false,
        footprints: true,
        mesh: mesh === 'flagged',
        ...(showLayers ? { visibleLayers: [
          { name: partName, imageHash: firstPart.sha256 },
          ...publication.source.parts!.images.filter(img => img.role === 'part' && img !== firstPart).slice(0, 1)
            .map(img => ({ name: img.path.slice('parts/'.length, -'.png'.length), imageHash: img.sha256 })),
        ] } : {}),
      },
      crop: {
        path: `comment-crops/${cropSha}.png`,
        sha256: cropSha,
        png: `data:image/png;base64,${partBytes.toString('base64')}`,
        width,
        height,
      },
      nativeCrop: null,
    };
    const cropRes = await fetch(`${host.origin}${entryBase}api/stage-parts/comment`, {
      method: 'POST',
      headers: {
        origin: host.origin,
        'X-Review-Capability': host.session.hostCredentials().ui,
        'content-type': 'application/json',
      },
      body: JSON.stringify(rawIssue),
    });
    expect(cropRes.status).toBe(200);
    const prepared = await cropRes.json() as { comment: Record<string, unknown> };
    issues = [prepared.comment];
  }
  const result = await host.ports.commitUIAct(host.session.jobId, ui('acts', { publicationId: publication.publicationId, askId: asked.value.askId,
    pageId, displayedNonce: displayed.value.displayedNonce, expectedGeneration: host.session.status().generation,
    submissionId: randomUUID(), kind: 'parts-verdict', value: { verdict, issues, words: '  Synthetic parts review.\r\n' } }));
  expect(result.ok ? undefined : result.error.code).toBeUndefined();
  expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.code);
  if (result.value.schema === 'rig-review/act@4') throw Error(result.value.schema);
  return result.value;
}

function prepareSignoff(root: string, _evidence: string): void {
  structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/structure-chain.json']);
  advanceCommand(['parts-review', root,
    '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'], Date.now());
  diffClassesCommand([root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'], Date.now());
}
function sign(root: string, _evidence: string): void {
  seedStoredPartsSignoff(root, 'chain', {
    by: 'user',
    at: Date.now(),
    verbatim: readFileSync(join(root, 'evidence/approval.txt'), 'utf8'),
    structureFile: 'evidence/structure-chain.json',
  });
}

test('an uncovered part edit leaves step completion runnable and historical parts approval clears it', async () => {
  const { root, host } = await bound(false);
  const project = read(root);
  const assemble = ((project.plan as JsonObject).steps as JsonObject[]).find(step => step.id === 'assemble')!;
  assemble.status = 'at-checkpoint';
  (assemble.status_history as JsonObject[]).pop();
  write(root, project);
  const editedAt = Date.now() - 1000;
  expect(derivedCommand(['add', root, '--source', 'inputs/painting.png', '--file', 'derived/drafts/chain/input/parts/torso.png',
    '--operation', 'synthetic part edit'], editedAt).exit).toBe(0);
  const findings = () => checkProject(root, undefined, { now: Date.now() }).holes ?? [];
  expect(findings()).toMatchObject([{ code: 'PART_EDIT_UNCOVERED', path: 'derived[0]' }]);
  expect(checkProject(root, undefined, { now: Date.now(), recordPublication: true }).holes).toBeUndefined();
  expect(nextProject(root, Date.now()).moves.some(move => move.command?.startsWith('rig-create step-status assemble done'))).toBe(true);
  expect(stepStatusCommand(['assemble', 'done', root, '--by', 'agent'], Date.now()).exit).toBe(0);

  await readyForVerdict(root, host);
  const next = nextProject(root, Date.now());
  expect(next.refusals.map(finding => finding.code)).toEqual(['PART_EDIT_UNCOVERED']);
  expect(next.moves.some(move => move.awaits === 'review_acts[kind=parts-verdict,draft_id=chain]' && move.command === null)).toBe(true);
  const act = await submit(root, host);
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
  expect(findings()).toEqual([]);
}, MULTI_SPAWN_TIMEOUT_MS);

for (const verdict of ['approved', 'changes-requested'] as const) {
  test(`@6 ${verdict} normal parts ingest and replay retain actual bound evidence`, async () => {
    const { root, host } = await bound();
    const native = await submit(root, host, verdict, verdict === 'approved' ? 'clean' : 'flagged');
    if (native.schema !== JOB_COMMENTS_ACT_SCHEMA || native.kind !== 'parts-verdict') throw Error('expected native comments parts fixture');
    const comments: JobComment[] = native.value.comments.map(comment => comment.anchor
      ? comment : { text: '  Overall parts feedback.\r\n' });
    const fresh: JsonObject = {
      schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'parts-verdict', jobId: native.jobId, actId: `comments-parts-${verdict}`,
      askId: native.askId, publicationId: native.publicationId, at: native.at,
      authority: native.authority as unknown as JsonObject, source: native.source as unknown as JsonObject,
      value: { verdict, comments: comments as unknown as JsonObject[] },
    };
    (fresh.source as JsonObject).projectHash = jobHash(readFileSync(join(root, 'project.json')));
    expectCliRefused(await cli(root, ['parts-review', '--from-review', String(fresh.actId), '--json']), 'NUMBERED_WRITER_REMOVED', 2);
    const first = seedStoredPartsVerdictAct(root, fresh, { checkProjectHash: true, checkArrival: true });
    expect(first.verbatim).toBe(projectComments(comments));
    const bytes = readFileSync(join(root, 'project.json'));
    const project = read(root);
    const receipt = (project.review_acts as JsonObject[]).at(-1)!;
    expect(receipt.bytes).toBe(JSON.stringify(fresh));
    expect(receipt.sha256).toBe(jobHash(String(receipt.bytes)));
    expect(JSON.parse(String(receipt.bytes)).schema).toBe(JOB_COMMENTS_ACT_SCHEMA);
    expect(partsActFindings(root, project)).toEqual([]);
    expect<unknown>(readFileSync(join(root, String((receipt.evidence as JsonObject).path)), 'utf8')).toBe(receipt.bytes);
    seedStoredPartsVerdictAct(root, fresh, { checkProjectHash: true });
    expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
    const input = join(root, 'derived/drafts/chain/input');
    const view = await loadPartsView(input, { rig: join(root, 'derived/drafts/chain/out/rig.json'),
      meshReport: join(root, 'derived/drafts/chain/out/mesh_report.json'), painting: join(input, 'painting_in_rig.png'),
      verdict: join(root, 'evidence/comments-verdict.json') });
    const source = verdictSource(view);
    const readerPackage = JSON.parse(readFileSync(join(import.meta.dir, '../node_modules/@rig-c/review/package.json'), 'utf8')) as { name: string; version: string };
    const standalone = { schema: PARTS_COMMENTS_VERDICT_SCHEMA, mode: view.mode, tool: { name: readerPackage.name, version: readerPackage.version },
      source, status: verdict, comments: comments.map(comment => comment.anchor && 'schema' in comment.anchor
        ? { text: comment.text, anchor: { ...comment.anchor, sourceHash: source.sha256 } } : comment), updatedAt: native.at };
    const standaloneBytes = Buffer.from(`${JSON.stringify(standalone, null, 2)}\n`);
    const cliReceipt = seedPartsCliReceipt(
      root,
      'chain',
      Date.parse(native.at),
      standalone as unknown as JsonObject,
      ['derived/drafts/chain/input', '--rig', 'derived/drafts/chain/out/rig.json',
        '--mesh-report', 'derived/drafts/chain/out/mesh_report.json', '--painting', 'derived/drafts/chain/input/painting_in_rig.png',
        '--verdict', 'evidence/comments-verdict.json'],
    );
    const standalonePath = String((cliReceipt.evidence as JsonObject).path);
    const expectedNames = comments.flatMap(comment => comment.anchor && 'parts' in comment.anchor
      ? comment.anchor.parts.map(part => part.name) : []);
    expect(cliReceipt.flagged).toEqual(expectedNames); expect(cliReceipt.noted).toEqual(expectedNames);
    expect(JSON.parse(readFileSync(join(root, standalonePath), 'utf8'))).toEqual(JSON.parse(standaloneBytes.toString('utf8')));
    expect(partsReadFindings(root, read(root))).toEqual([]);
  }, DUAL_REPLAY_TIMEOUT_MS);
}

test('bound draft publishes ready evidence and atomically signs from one approval', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const before = read(root);
  const result = JSON.parse(ingestSyntheticFetch(root, act).stdout);
  const project = read(root);
  expect((project.signoffs as JsonObject[]).slice(0, -1)).toEqual(before.signoffs as JsonObject[]); expect(project.stage).toBe(before.stage);
  expect((project.signoffs as JsonObject[]).at(-1)).toMatchObject({ stage: 'parts-review', draft_id: 'chain', checkpoint: null, by: 'user', at: act.at, source: `review act ${act.jobId}/${act.actId}` });
  expect(result.verbatim).toBe('[general]\n  Synthetic parts review.\r\n'); expect(result.by).toBe('user');
  expect(JSON.parse(readFileSync(join(root, result.evidence.path), 'utf8'))).toEqual(act);
  expect(partsActFindings(root, project)).toEqual([]);
  const bytes = readFileSync(join(root, 'project.json'));
  const replay = ingestSyntheticFetch(root, act);
  expect(JSON.parse(replay.stdout)).toMatchObject({ draft_id: 'chain', verdict: 'approved', by: 'user' });
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
  expect(checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code)).toEqual([]);
}, MULTI_SPAWN_TIMEOUT_MS);

test('legacy owner-shaped producer verdict retains the structure and signoff gate', async () => {
  const root = fixture(true);
  const input = join(root, 'derived/drafts/chain/input');
  const pkg = await loadPartsView(input, { rig: join(root, 'derived/drafts/chain/out/rig.json'),
    meshReport: join(root, 'derived/drafts/chain/out/mesh_report.json'), painting: join(input, 'painting_in_rig.png'),
    verdict: join(root, 'evidence/owner-verdict.json') });
  const source = verdictSource(pkg);
  expect(source.files.some(file => file.path.endsWith('rig.json'))).toBe(true);
  recordPartsReceipt(root, 'chain', Date.now(), 'approved');
  prepareSignoff(root, 'evidence/owner-verdict.json');
  sign(root, 'evidence/owner-verdict.json');
  expect(checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code)).toEqual([]);
});

for (const [verdict, part, mesh] of [
  ['approved', 'clean', 'clean'], ['changes-requested', 'flagged', 'clean'],
  ['changes-requested', 'clean', 'flagged'],
] as const) test(`semantic ${verdict}/${part}/${mesh} retains every outcome and folds only approval`, async () => {
  const { root, host } = await bound();
  const act = await submit(root, host, verdict, part, mesh);
  const before = read(root);
  const recorded = JSON.parse(ingestSyntheticFetch(root, act).stdout);
  expect(recorded.verdict).toBe(verdict);
  const evidence = decodeReviewAct(readFileSync(join(root, recorded.evidence.path), 'utf8'), 'parts-verdict');
  if (evidence.schema !== JOB_COMMENTS_ACT_SCHEMA || evidence.kind !== 'parts-verdict') throw Error(evidence.schema);
  const pointed = evidence.value.comments.filter(comment => comment.anchor && 'schema' in comment.anchor);
  if (verdict === 'approved') {
    expect(pointed).toEqual([]);
  } else {
    expect(pointed.length).toBe(1);
    expect(pointed[0]?.text).toBe(mesh === 'flagged' ? 'Synthetic mesh finding.' : 'Synthetic edge finding.');
    expect(pointed[0]?.anchor).toMatchObject({ view: { mesh: mesh === 'flagged' } });
  }
  expect(evidence.value.comments.filter(comment => !comment.anchor)).toEqual([{ text: '  Synthetic parts review.\r\n' }]);
  const signatures = read(root).signoffs as JsonObject[];
  expect(signatures.length).toBe((before.signoffs as JsonObject[]).length + (verdict === 'approved' ? 1 : 0));
  expect(read(root).stage).toBe(before.stage);
  if (verdict !== 'approved') {
    expect(() => sign(root, recorded.evidence.path)).toThrow(expect.objectContaining({ code: 'PARTS_VERDICT_LATEST_NOT_APPROVED' }));
  }
}, SINGLE_ACT_TIMEOUT_MS);

test('#664 retains the assembled visible layers exported with a Parts issue', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host, 'changes-requested', 'flagged', 'clean', true);
  if (act.schema !== JOB_COMMENTS_ACT_SCHEMA || act.kind !== 'parts-verdict') throw Error('expected a Review comments verdict');
  const firstLayers = host.session.status().publication!.source.parts!.images.filter(img => img.role === 'part').slice(0, 2)
    .map(img => ({ name: img.path.slice('parts/'.length, -'.png'.length), imageHash: img.sha256 }));
  expect(firstLayers).toHaveLength(2);
  const exportedBytes = host.session.readActExport(act.actId, false).toString('utf8');
  const result = seedStoredPartsVerdictAct(root, exportedBytes, { checkProjectHash: true, checkArrival: true });
  const bytes = readFileSync(join(root, result.evidence.path), 'utf8');
  expect(bytes).toBe(exportedBytes);
  const recorded = decodeReviewAct(bytes, 'parts-verdict');
  if (recorded.schema !== JOB_COMMENTS_ACT_SCHEMA) throw Error('expected retained comments verdict');
  expect(recorded.value.comments[0]?.anchor).toMatchObject({ view: { mode: 'assembled', visibleLayers: firstLayers } });
  expect(partsActIssues(recorded)?.[0]?.view).toMatchObject({ visibleLayers: firstLayers });
  expect(reviewActFindings(read(root))).toEqual([]);
}, SINGLE_ACT_TIMEOUT_MS);

test('#664 ingests a previous-draft comparison with its exact Review source declaration', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host, 'changes-requested', 'flagged');
  if (act.schema !== JOB_COMMENTS_ACT_SCHEMA || act.kind !== 'parts-verdict') throw Error('expected a Review comments verdict');
  const current = 'derived/drafts/chain/input/recomposite_rig.png';
  const previousDraft = { schema: 'rig-review-previous-draft/1' as const, draft: { id: 'synthetic-prior', revision: 'a'.repeat(64) },
    composites: { current: { path: current, sha256: jobHash(readFileSync(join(root, current))) },
      previous: { path: 'derived/drafts/synthetic-prior/input/recomposite_rig.png', sha256: 'b'.repeat(64) } } };
  const comparison = { mode: 'difference' as const, opacity: 0.5, threshold: 0, operand: 'previous-draft' as const };
  const comments = act.value.comments.map(comment => comment.anchor && 'schema' in comment.anchor
    ? { ...comment, anchor: { ...comment.anchor, view: { ...comment.anchor.view, comparison } } } : comment);
  const unbound = { ...act, value: { ...act.value, comments } };
  expectAtomicRefusal(root, 'REVIEW_ACT_INVALID', () => ingestSyntheticFetch(root, unbound));
  const exportWithPrevious = { ...unbound, source: { ...unbound.source, previousDraft } };
  const result = ingestSyntheticFetch(root, exportWithPrevious);
  expect(result.exit).toBe(0);
  const bytes = readFileSync(join(root, JSON.parse(result.stdout).evidence.path), 'utf8');
  expect(bytes).toBe(JSON.stringify(exportWithPrevious));
  const recorded = decodeReviewAct(bytes, 'parts-verdict');
  expect(recorded.source).toMatchObject({ previousDraft });
  expect(partsActIssues(recorded)?.[0]?.view).toMatchObject({ comparison });
  const warnings: Parameters<typeof reviewActFindings>[1] = [];
  expect(reviewActFindings(read(root), warnings)).toEqual([]);
  expect(warnings).toEqual([]);
}, SINGLE_ACT_TIMEOUT_MS);

for (const source of ['parts', 'config'] as const) test(`changed ${source} refuses stale replay without a record write`, async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
  const before = readFileSync(join(root, 'project.json'));
  const path = source === 'parts' ? act.source.parts!.manifest.path : 'derived/drafts/chain/config.json';
  writeFileSync(join(root, path), '{}\n');
  expectAtomicRefusal(root, 'REVIEW_ACT_SOURCE_STALE', () => ingestSyntheticFetch(root, act));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}, MULTI_SPAWN_TIMEOUT_MS);

test('a new-id rebuild with failed publication retries through job reconcile', async () => {
  const { root, host } = await bound();
  const originalVerdict = await submit(root, host);
  expect(ingestSyntheticFetch(root, originalVerdict).exit).toBe(0);
  cpSync(join(root, 'derived/drafts/chain'), join(root, 'derived/drafts/rebuilt'), { recursive: true });
  const snapshot = JSON.parse(readFileSync(join(root, 'evidence/structure-chain.json'), 'utf8')) as JsonObject;
  snapshot.draft_id = 'rebuilt';
  (snapshot.config as JsonObject).path = 'derived/drafts/rebuilt/config.json';
  writeFileSync(join(root, 'evidence/structure-rebuilt.json'), JSON.stringify(snapshot));
  writeFileSync(join(root, 'review-draft-rebuilt.json'), '{}\n');
  // View-only draft registration defers auto-publish; publishCommittedVersion defers into the outbox on manifest conflict (create#844).
  expect(seedRetainedDraft(draftArgs(root, 'rebuilt'), Date.now()).exit).toBe(0);
  expect(prepareDraftIntent(root, readFileSync(join(root, 'project.json')), 'rebuilt')).toMatchObject({
    intent: null,
    deferred: expect.stringContaining('no owner ask is ready'),
  });
  expect((read(root).drafts as JsonObject[]).map(draft => draft.id)).toEqual(['chain', 'rebuilt']);
  publishCommittedVersion(root, 'rebuilt');
  const notices = takePendingNotices();
  expect(notices[0]).toMatch(/^WARN JOB_PUBLISH_PENDING: project\.json: drafts\[rebuilt\] is recorded .*\(JOB_PUBLICATION_INVALID: /);
  const pending = pendingPublications(root);
  expect(pending.length).toBe(1);
  expect(pending[0]!.failure?.code).toBe('JOB_PUBLICATION_INVALID');
  rmSync(join(root, 'review-draft-rebuilt.json'));
  expect(await reconcileCreateJob(root)).toBe(1);
  expect(host.session.status().publication!.source.selector).toEqual({ kind: 'draft', id: 'rebuilt' });
  expectCliOk(await cli(root, ['job', 'close']));
  const current = read(root);
  const duplicateCandidate: JsonObject = {
    ...current,
    drafts: [...(current.drafts as JsonObject[]), (current.drafts as JsonObject[])[1]!],
  };
  expect(checkProject(root, duplicateCandidate, { now: Date.now() }).refusals.map(f => f.code)).toContain('DRAFT_RIG_MALFORMED');
}, MULTI_SPAWN_TIMEOUT_MS);

test('unbound draft seed allocates no job outbox', () => {
  const root = fixture();
  const result = seedRetainedDraft(draftArgs(root), Date.now());
  expect(result.exit).toBe(0);
  expect(existsSync(join(root, '.rig-create-review'))).toBe(false);
  expect(read(root).review_job).toBeUndefined();
});

test('killed evidence staging retries the same file and commits once', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const before = readFileSync(join(root, 'project.json'));
  const relPath = `evidence/review-acts/${jobHash(JSON.stringify([act.jobId, act.actId]))}.json`;
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(act));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  const evidence = readFileSync(path);
  expect(JSON.parse(evidence.toString())).toEqual(act);
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
  expect(readFileSync(path)).toEqual(evidence);
  expect((read(root).review_acts as JsonObject[]).length).toBe(1);
  const committed = readFileSync(join(root, 'project.json'));
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(committed);
}, MULTI_SPAWN_TIMEOUT_MS);

test('another act at the staged deterministic path refuses with bytes identical', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const relPath = `evidence/review-acts/${jobHash(JSON.stringify([act.jobId, act.actId]))}.json`;
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...act, actId: 'different-synthetic-act' }));
  expectAtomicRefusal(root, 'PARTS_REVIEW_EVIDENCE_CONFLICT', () => ingestSyntheticFetch(root, act));
}, MULTI_SPAWN_TIMEOUT_MS);

test('standalone draft without a compiled model publishes through image references', async () => {
  const root = fixture();
  rmSync(join(root, 'derived/drafts/chain/out/check'), { recursive: true });
  const host = await openHistoricalPartsJob(root, 'synthetic-owner');
  hosts.push(host);
  expect(seedRetainedDraft(draftArgs(root), Date.now()).exit).toBe(0);
  await publishHistoricalDraft(root, host, 'chain');
  expect(host.session.status().publication!.source.model).toBeNull();
  await readyForVerdict(root, host);
  const act = await submit(root, host);
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
}, SINGLE_ACT_TIMEOUT_MS);

test('build-root draft binds its own parts inventory and compiled output', async () => {
  const root = fixture();
  const draft = join(root, 'derived/drafts/chain');
  cpSync(join(draft, 'input'), join(draft, 'build'), { recursive: true });
  cpSync(join(draft, 'out'), join(draft, 'build/rig'), { recursive: true });
  cpSync(join(draft, 'out/check'), join(draft, 'build/check'), { recursive: true });
  rmSync(join(draft, 'build/rig/check'), { recursive: true });
  const host = await openHistoricalPartsJob(root, 'synthetic-owner');
  hosts.push(host);
  const result = seedRetainedDraft(['chain', root, '--config', 'derived/drafts/chain/config.json', '--from', 'derived/drafts/chain/build'], Date.now());
  expect(result.exit).toBe(0);
  await publishHistoricalDraft(root, host, 'chain');
  expect(host.session.status().publication!.source.parts!.manifest.path).toBe('derived/drafts/chain/build/parts.json');
  expect(host.session.status().publication!.source.model!.path).toBe('derived/drafts/chain/build/check/build/skeleton.model.json');
  await readyForVerdict(root, host);
  const act = await submit(root, host);
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
}, SINGLE_ACT_TIMEOUT_MS);

test('missing private receipt emits the named warning while retaining source checks', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  rmSync(join(root, '.rig-create-review/acknowledged-publications'), { recursive: true });
  const result = JSON.parse(ingestSyntheticFetch(root, act).stdout);
  expect(result.warnings[0]).toStartWith('REVIEW_ACT_VERSION_UNVERIFIED:');
}, SINGLE_ACT_TIMEOUT_MS);

test('competing human value flags refuse without record mutation', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const before = readFileSync(join(root, 'project.json'));
  const result = expectCliRefused(await cli(root, ['parts-review', '--from-review', act.actId, '--verdict', 'approved']), 'NUMBERED_WRITER_REMOVED', 2);
  expect(result.exit).toBe(2); expect(result.stderr).toContain('NUMBERED_WRITER_REMOVED:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}, SINGLE_ACT_TIMEOUT_MS);

function answerRiggingInterview(root: string): void {
  advanceCommand(['rigging-interview', root], Date.now());
  const items = collectItems(read(root), { collection: null })
    .filter(item => interviewStageOfGuide(item.id, item.kind === 'post', true) === 'rigging-interview');
  for (const item of items) {
    const now = Date.now();
    const path = `evidence/interview/${item.id}.json`;
    const set = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-chain', path), 'utf8')) as JsonObject;
    set.context = optionContext(read(root), 'rigging-interview', now, root);
    set.drafted_at = new Date(now).toISOString();
    writeFileSync(join(root, path), `${JSON.stringify(set, null, 2)}\n`);
    interviewOptionsCommand([item.id, root, '--file', path], now);
    const asks = set.asks as JsonObject[];
    interviewAnswerCommand([item.id, root, '--set', path, '--sha256', jobHash(readFileSync(join(root, path))), '--by', 'user',
      ...asks.flatMap(ask => ['--pick', `${ask.id}=${item.id === 'turn' ? 'fixed' : 'keep'}`])], now);
  }
}

test('retained parts approval survives real rigging signoff checkpoint changes and still rejects changed images', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
  answerRiggingInterview(root);
  const revisingAt = Date.now();
  const staleIds = ['bones', 'meshes', 'constraints', 'motion'];
  expect(checkProject(root, undefined, { now: revisingAt }).refusals.map(({ code, path }) => [code, path]))
    .toEqual(staleIds.map(id => ['PLAN_STEP_PREDATES_ANSWER', `plan.steps[${id}]`]));
  for (const id of staleIds) {
    expect(planCommand(['revise', id, root, '--by', 'agent',
      '--reason', 'Keep the existing definition after reviewing the recorded rigging guides.'], revisingAt).exit).toBe(0);
  }
  const steps = (read(root).plan as JsonObject).steps as JsonObject[];
  const before = steps.find(step => step.id === 'bones')!;
  expect(before.checkpoint).toBeNull();
  const hash = stepHash(before);
  signoffCommand(['rigging-interview', root, '--by', 'user', '--verbatim-file', join(root, 'evidence/approval.txt')], Date.now());
  const after = ((read(root).plan as JsonObject).steps as JsonObject[]).find(step => step.id === 'bones')!;
  expect(after.checkpoint).not.toBeNull();
  expect(stepHash(after)).not.toBe(hash);
  expect(checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code)).toEqual([]);
  const image = act.source.parts!.images.find(row => row.role === 'part')!;
  writeFileSync(join(root, 'derived/drafts/chain/input', image.path), Buffer.from('synthetic changed image'));
  expect(checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code)).toContain('REVIEW_ACT_SOURCE_STALE');
}, MULTI_SPAWN_TIMEOUT_MS);

test('changed plan still refuses first ingest and replay before deduplication', async () => {
  for (const replay of [false, true]) {
    const { root, host } = await bound();
    const act = await submit(root, host);
    if (replay) expect(ingestSyntheticFetch(root, act).exit).toBe(0);
    planCommand(['revise', 'bones', root, '--by', 'agent', '--bar', 'The revised synthetic bone plan meets its declared bar.'], Date.now());
    const before = readFileSync(join(root, 'project.json'));
    if (replay) {
      // Replay uses comparePlan: false on recorded receipts, while direct assertPartsActSource enforces plan identity.
      expect(() => assertPartsActSource(root, read(root), decodeReviewAct(JSON.stringify(act), 'parts-verdict'))).toThrow(
        expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }),
      );
    } else {
      expectAtomicRefusal(root, 'REVIEW_ACT_SOURCE_STALE', () => ingestSyntheticFetch(root, act));
    }
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  }
}, DUAL_REPLAY_TIMEOUT_MS);

test('CLI and act receipts share current-verdict ordering', async () => {
  const { latestPartsVerdictFinding } = await import('../src/parts-verdict-record.ts');
  const { root, host } = await bound();
  const rejected = await submit(root, host, 'changes-requested', 'flagged');
  const nextRejected = await submit(root, host, 'changes-requested', 'flagged');
  expect(ingestSyntheticFetch(root, rejected).exit).toBe(0);
  expect(latestPartsVerdictFinding(read(root), 'chain', 'signoffs[0].draft_id')?.code).toBe('PARTS_VERDICT_LATEST_NOT_APPROVED');
  recordPartsReceipt(root, 'chain', Date.now(), 'approved');
  expect(latestPartsVerdictFinding(read(root), 'chain', 'signoffs[0].draft_id')).toBeUndefined();
  expect(ingestSyntheticFetch(root, nextRejected).exit).toBe(0);
  expect(latestPartsVerdictFinding(read(root), 'chain', 'signoffs[0].draft_id')?.code).toBe('PARTS_VERDICT_LATEST_NOT_APPROVED');
  expect(partsActFindings(root, read(root))).toEqual([]);
}, MULTI_SPAWN_TIMEOUT_MS);

test('#686 owner amendment lapses parts approval and view-only openDraftPublication asks nothing', async () => {
  const { root, host } = await bound();
  const approved = await submit(root, host);
  ingestSyntheticFetch(root, approved);
  const before = read(root);
  expect(partsDraftEditable(before)).toBe(false);
  expect(await openDraftPublication(root, host, Date.now(), 'chain')).not.toContain('job: asked parts-verdict chain');

  const amendmentAt = Date.now();
  const words = 'Please enter the three synthetic corrections again.\n';
  writeFileSync(join(root, 'evidence/correction.txt'), words);
  const args = ['parts-review', root, '--kind', 'draft', '--target', 'chain', '--change', 'evidence/correction.txt', '--by', 'synthetic-owner'];
  const relay = ['--owner-chat', join(root, 'evidence/correction.txt'), '--said-at', new Date(amendmentAt).toISOString(), '--relayed-by', 'operator'];
  expectAtomicRefusal(root, 'OWNER_CHAT_REQUIRED', () => amendCommand(args, amendmentAt));
  expectAtomicRefusal(root, 'AMENDMENT_TARGET_INVALID', () => amendCommand([...args.slice(0, 5), 'missing', ...args.slice(6), ...relay], amendmentAt));
  expect(amendCommand([...args, ...relay], amendmentAt).exit).toBe(0);

  const amended = read(root);
  expect(amended.amendments).toEqual([expect.objectContaining({ target: { stage: 'parts-review', kind: 'draft', id: 'chain' },
    verbatim: words, said_at: new Date(amendmentAt).toISOString(), relayed_by: 'operator' })]);
  const report = checkProject(root, undefined, { now: Date.now() });
  expect(report.amendments?.[0]?.lapsed).toContainEqual(expect.objectContaining({ stage: 'parts-review', gap: 'G5' }));
  expect(partsDraftEditable(amended)).toBe(true);
  expect(latestPartsReceipt(amended, 'chain')).toBeUndefined();
  const sameTime = structuredClone(amended);
  const approval = (sameTime.signoffs as JsonObject[]).find(row => row.stage === 'parts-review')!;
  approval.at = new Date(amendmentAt).toISOString();
  expect(latestPartsApproval(sameTime)).toBeUndefined();
  expect(partsDraftEditable(sameTime)).toBe(true);

  expect(await openDraftPublication(root, host, Date.now(), 'chain')).not.toContain('job: asked parts-verdict chain');
  await publishHistoricalDraft(root, host, 'chain');
  const requested = await submit(root, host, 'changes-requested', 'flagged');
  expectAtomicRefusal(root, 'REVIEW_ACT_SOURCE_STALE', () =>
    ingestSyntheticFetch(root, { ...requested, at: new Date(amendmentAt).toISOString() }));
  expect(ingestSyntheticFetch(root, requested).exit).toBe(0);
  const after = read(root);
  expect(after.drafts).toEqual(before.drafts);
  expect(after.signoffs).toEqual(before.signoffs);
  expect(after.amendments).toEqual(amended.amendments);
  expect((after.review_acts as JsonObject[]).filter(row => row.kind === 'parts-verdict').map(row => row.actId)).toEqual([approved.actId, requested.actId]);
  expect(latestPartsReceipt(after, 'chain')?.actId).toBe(requested.actId);
  expect(latestPartsVerdictStatus(after, 'chain')).toBe('changes-requested');
  expect(checkProject(root, undefined, { now: Date.now() }).refusals).toEqual([]);
  expect(partsDraftEditable(after)).toBe(true);
  expect(await openDraftPublication(root, host, Date.now(), 'chain')).not.toContain('job: asked parts-verdict chain');
  await publishHistoricalDraft(root, host, 'chain');
  const reapproved = await submit(root, host);
  expect(ingestSyntheticFetch(root, reapproved).exit).toBe(0);
  expect(latestPartsReceipt(read(root), 'chain')?.actId).toBe(reapproved.actId);
  expect(latestPartsApproval(read(root))?.at).toBe(reapproved.at);
  expect(partsDraftEditable(read(root))).toBe(false);
}, MULTI_SPAWN_TIMEOUT_MS);

test('act@5 issue-list parts verdict decodes, enforces verdict/issues invariant and checks manifest inclusion and draft panels', () => {
  const root = fixture(true);
  const project = read(root);
  const manifestFile = prepareDraftManifest(root, project, 'chain');
  const publishedManifest = JSON.parse(readFileSync(join(root, manifestFile), 'utf8')) as JsonObject;
  expect(publishedManifest.producer).toEqual({
    config: 'derived/drafts/chain/config.json',
    parts: 'derived/drafts/chain/input',
    source: 'inputs/painting.png',
  });
  expect(publishedManifest.panels).toEqual({
    schema: 'rig-review/panels@1',
    left: ['parts.list'],
    stage: ['parts.canvas'],
    toolbar: ['parts.layers'],
    side: ['parts.issues', 'act.submit'],
  });
  expect(draftPublishedContext(root, project, 'chain').files).toContainEqual({
    path: 'inputs/painting.png',
    sha256: String(((project.inputs as JsonObject[])[0]!).sha256),
  });
  expect(prepareDraftManifest(root, project, 'chain')).toBe(manifestFile);

  const canonicalBytes = `${JSON.stringify(publishedManifest, null, 2)}\n`;
  const { producer: _producer, ...legacyPanelsManifest } = publishedManifest;
  const { panels: _panels, ...legacyManifest } = legacyPanelsManifest;
  for (const legacyCandidate of [legacyManifest, legacyPanelsManifest]) {
    writeFileSync(join(root, manifestFile), `${JSON.stringify(legacyCandidate, null, 2)}\n`);
    expect(prepareDraftManifest(root, project, 'chain')).toBe(manifestFile);
    expect(readFileSync(join(root, manifestFile), 'utf8')).toBe(canonicalBytes);
    expect(JSON.parse(readFileSync(join(root, manifestFile), 'utf8')).producer).toEqual({
      config: 'derived/drafts/chain/config.json',
      parts: 'derived/drafts/chain/input',
      source: 'inputs/painting.png',
    });
  }

  writeFileSync(join(root, manifestFile), `${JSON.stringify({ ...legacyManifest, title: 'tampered' }, null, 2)}\n`);
  expect(() => prepareDraftManifest(root, project, 'chain')).toThrow(
    expect.objectContaining({ code: 'JOB_PUBLICATION_INVALID' }),
  );
  writeFileSync(join(root, manifestFile), canonicalBytes);

  const inputDir = join(root, 'derived/drafts/chain/input');
  const images = partsEnumerator.enumerate(inputDir).map(row => ({
    ...row,
    sha256: jobHash(readFileSync(join(inputDir, row.path))),
  }));
  const partImages = images.filter(img => img.role === 'part');
  const firstPart = partImages[0]!;
  const firstPartName = firstPart.path.slice('parts/'.length, -'.png'.length);
  const manifestPath = 'derived/drafts/chain/input/parts.json';
  const manifestSha = jobHash(readFileSync(join(root, manifestPath)));
  const modelPath = 'derived/drafts/chain/out/check/build/skeleton.model.json';
  const modelSha = jobHash(readFileSync(join(root, modelPath)));
  const steps = ((project.plan as JsonObject).steps as JsonObject[]).map(step => ({
    id: String(step.id),
    hash: stepHash(step),
  }));

  const baseSource = {
    sourceHash: 'a'.repeat(64),
    projectHash: jobHash(readFileSync(join(root, 'project.json'))),
    package: { id: 'create-draft-chain', revision: String(publishedManifest.revision) },
    selector: { kind: 'draft' as const, id: 'chain' },
    model: { path: modelPath, sha256: modelSha },
    direction: null,
    optionSet: null,
    appliedResult: null,
    plan: { steps },
    parts: {
      enumeratorVersion: partsEnumerator.version,
      manifest: { path: manifestPath, sha256: manifestSha },
      images,
    },
  };

  const baseView = {
    mode: 'item',
    camera: { zoom: 2, center: { x: 14, y: 13 }, viewport: { width: 800, height: 600 } },
    cameraSync: true,
    referenceCamera: null,
    background: 'checker',
    alpha: false,
    footprints: true,
    mesh: false,
  };

  const sampleIssue = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schema: 'rig-review-parts-comment/2',
    id: 'issue-1',
    summary: 'Ragged sleeve cuff seam',
    parts: [{ name: firstPartName, imageHash: firstPart.sha256 }],
    sourceHash: 'b'.repeat(64),
    rigRegion: { x: 10, y: 12, width: 24, height: 18 },
    imageRegion: { x: 2, y: 4, width: 24, height: 18 },
    view: baseView,
    crop: { path: `comment-crops/${'c'.repeat(64)}.png`, sha256: 'c'.repeat(64), width: 24, height: 18 },
    nativeCrop: null,
    ...overrides,
  });

  const makeActV5 = (value: Record<string, unknown>, sourceOverrides: Partial<typeof baseSource> = {}): Record<string, unknown> => ({
    schema: 'rig-review/act@5',
    actId: 'act-v5-1',
    jobId: 'job-v5-1',
    askId: 'ask-v5-1',
    publicationId: 'pub-v5-1',
    kind: 'parts-verdict',
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    at: new Date(EXAMPLE_NOW).toISOString(),
    source: { ...baseSource, ...sourceOverrides },
    value,
  });

  // 1. act@5 approved with zero issues is accepted
  const approvedBytes = JSON.stringify(makeActV5({ verdict: 'approved', issues: [], words: 'All parts clean.' }));
  const approvedAct = decodeReviewAct(approvedBytes, 'parts-verdict');
  expect(approvedAct.schema).toBe('rig-review/act@5');
  expect(approvedAct.value.verdict).toBe('approved');
  if (approvedAct.schema !== 'rig-review/act@5') throw Error(approvedAct.schema);
  expect(approvedAct.value.issues).toEqual([]);
  assertPartsActSource(root, project, approvedAct);

  // 2. act@5 approved with one or more issues is refused
  expect(() =>
    decodeReviewAct(
      JSON.stringify(makeActV5({ verdict: 'approved', issues: [sampleIssue()], words: 'Contradictory.' })),
      'parts-verdict',
    ),
  ).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));

  // 3. act@5 changes-requested with zero issues is refused
  expect(() =>
    decodeReviewAct(
      JSON.stringify(makeActV5({ verdict: 'changes-requested', issues: [], words: 'No issues.' })),
      'parts-verdict',
    ),
  ).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));

  // 4. act@5 changes-requested with valid subset of parts is accepted by both decodeReviewAct and assertPartsActSource
  const changesAct = decodeReviewAct(
    JSON.stringify(
      makeActV5({
        verdict: 'changes-requested',
        issues: [sampleIssue({ imageRegion: null, view: { ...baseView, mode: 'assembled' } })],
        words: 'Fix cuff.',
      }),
    ),
    'parts-verdict',
  );
  expect(changesAct.schema).toBe('rig-review/act@5');
  assertPartsActSource(root, project, changesAct);

  // 5. an issue naming a part outside the bound manifest is refused in decodeReviewAct and in assertPartsActSource
  expect(() =>
    decodeReviewAct(
      JSON.stringify(
        makeActV5({
          verdict: 'changes-requested',
          issues: [sampleIssue({ parts: [{ name: 'nonexistent_part', imageHash: firstPart.sha256 }] })],
          words: 'Unknown part.',
        }),
      ),
      'parts-verdict',
    ),
  ).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));

  expect(() =>
    decodeReviewAct(
      JSON.stringify(
        makeActV5({
          verdict: 'changes-requested',
          issues: [
            sampleIssue({
              parts: [
                { name: firstPartName, imageHash: firstPart.sha256 },
                { name: firstPartName, imageHash: firstPart.sha256 },
              ],
            }),
          ],
          words: 'Duplicate part in one issue.',
        }),
      ),
      'parts-verdict',
    ),
  ).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));

  const forgedUnboundAct = makeActV5({
    verdict: 'changes-requested',
    issues: [sampleIssue({ parts: [{ name: 'nonexistent_part', imageHash: firstPart.sha256 }] })],
    words: 'Forged manifest mismatch.',
  }) as unknown as PartsVerdictActV5;
  expect(() => assertPartsActSource(root, project, forgedUnboundAct)).toThrow(
    expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }),
  );

  // 6. act@2 per-part rows still decode unchanged across all historical verdict/part/mesh combinations
  for (const [verdict, part, mesh] of [
    ['approved', 'clean', 'clean'],
    ['changes-requested', 'flagged', 'clean'],
    ['changes-requested', 'clean', 'flagged'],
    ['pending', 'pending', 'pending'],
  ] as const) {
    const actV2 = decodeReviewAct(
      JSON.stringify({
        ...makeActV5({}),
        schema: 'rig-review/act@2',
        value: {
          verdict,
          parts: partImages.map(img => ({
            partId: img.path.slice('parts/'.length, -'.png'.length),
            part: { outcome: part, note: part === 'flagged' ? 'Legacy edge finding.' : '' },
            mesh: { outcome: mesh, note: mesh === 'flagged' ? 'Legacy mesh finding.' : '' },
          })),
          words: 'Legacy v2 review.',
        },
      }),
      'parts-verdict',
    );
    expect(actV2.schema).toBe('rig-review/act@2');
    if (actV2.schema !== 'rig-review/act@2') throw Error(actV2.schema);
    expect(actV2.value.verdict).toBe(verdict);
    expect(actV2.value.parts.every(row => row.part.outcome === part && row.mesh.outcome === mesh)).toBe(true);
    assertPartsActSource(root, project, actV2);
  }

  // 7. recordedPartsVerdict preserves rig-review/act@5 as the evidence spec
  const evidencePath = `evidence/review-acts/${jobHash(JSON.stringify([approvedAct.jobId, approvedAct.actId]))}.json`;
  mkdirSync(join(root, 'evidence/review-acts'), { recursive: true });
  writeFileSync(join(root, evidencePath), approvedBytes);
  project.review_acts = [
    {
      schema: 'rig-create/review-act@1',
      kind: 'parts-verdict',
      jobId: approvedAct.jobId,
      actId: approvedAct.actId,
      draft_id: 'chain',
      version_hash: partsActDraftHash(project, approvedAct),
      bytes: approvedBytes,
      sha256: jobHash(approvedBytes),
      evidence: { path: evidencePath, sha256: jobHash(approvedBytes) },
    },
  ];
  write(root, project);
  const recorded = recordedPartsVerdict(root, project, 'chain');
  expect(recorded.evidence.spec).toBe('rig-review/act@5');
  const warnings: Parameters<typeof reviewActFindings>[1] = [];
  expect(reviewActFindings(project, warnings)).toEqual([]);
  expect(partsActFindings(root, project)).toEqual([]);
  expect(warnings).toEqual([]);
});

test('draft publication binds inputs[0] in producer.source, seals it in files, and refuses missing or drifted painting bytes before manifest write', () => {
  const root = fixture(true);
  const manifestPath = join(root, 'review-draft-chain.json');
  rmSync(manifestPath, { force: true });

  // 1. Missing inputs[0] registration is refused before writing review-draft-chain.json
  const missingInputs = read(root);
  missingInputs.inputs = [];
  expect(() => draftPublishedContext(root, missingInputs, 'chain')).toThrow(
    expect.objectContaining({ code: 'JOB_PUBLICATION_INVALID' }),
  );
  expect(() => prepareDraftManifest(root, missingInputs, 'chain')).toThrow(
    expect.objectContaining({ code: 'JOB_PUBLICATION_INVALID' }),
  );
  expect(existsSync(manifestPath)).toBe(false);

  // 2. Drifted painting bytes on disk are refused when rehashing inputs[0] at publish time
  const originalPainting = readFileSync(join(root, 'inputs/painting.png'));
  writeFileSync(join(root, 'inputs/painting.png'), Buffer.concat([originalPainting, Buffer.from([0x00])]));
  expect(() => draftPublishedContext(root, read(root), 'chain')).toThrow(
    expect.objectContaining({ code: 'JOB_PUBLICATION_INVALID' }),
  );
  expect(() => prepareDraftManifest(root, read(root), 'chain')).toThrow(
    expect.objectContaining({ code: 'JOB_PUBLICATION_INVALID' }),
  );
  expect(existsSync(manifestPath)).toBe(false);

  // 3. Missing painting file on disk is refused before writing review-draft-chain.json
  rmSync(join(root, 'inputs/painting.png'));
  expect(() => prepareDraftManifest(root, read(root), 'chain')).toThrow(
    expect.objectContaining({ code: 'JOB_PUBLICATION_INVALID' }),
  );
  expect(existsSync(manifestPath)).toBe(false);

  // 4. Restoring exact registered painting bytes succeeds, writes producer.source, and seals inputs/painting.png
  writeFileSync(join(root, 'inputs/painting.png'), originalPainting);
  const project = read(root);
  const context = draftPublishedContext(root, project, 'chain');
  const expectedPainting = (project.inputs as JsonObject[])[0]!;
  expect(context.files).toContainEqual({
    path: String(expectedPainting.path),
    sha256: String(expectedPainting.sha256),
  });
  const writtenManifest = prepareDraftManifest(root, project, 'chain');
  expect(writtenManifest).toBe('review-draft-chain.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as JsonObject;
  expect(parsed.producer).toEqual({
    config: 'derived/drafts/chain/config.json',
    parts: 'derived/drafts/chain/input',
    source: 'inputs/painting.png',
  });
});


function expectAtomicRefusal(root: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(root, 'project.json'));
  expect(action).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(readdirSync(root).filter(name => name.startsWith('.parts-review-'))).toEqual([]);
}

function ingestSyntheticFetch(root: string, act: JobAct, afterEvidence?: (path: string) => void) {
  const seeded = seedStoredPartsVerdictAct(root, act as unknown as JsonObject, {
    now: Date.now(),
    checkProjectHash: true,
    checkAck: true,
    checkArrival: true,
    afterEvidence,
  });
  return { exit: 0, stdout: JSON.stringify(seeded) };
}

test('fold refuses stale projectHash after a non-draft record change and rolls back receipt and evidence', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const project = read(root); project.title = 'Changed synthetic title'; write(root, project);
  let staged = '';
  expectAtomicRefusal(root, 'REVIEW_ACT_SOURCE_STALE', () => ingestSyntheticFetch(root, act, path => { staged = path; }));
  expect(staged).not.toBe(''); expect(existsSync(staged)).toBe(false);
  expect(read(root).review_acts ?? []).toEqual([]);
}, SINGLE_ACT_TIMEOUT_MS);

for (const broken of ['structure', 'diff'] as const) test(`fold shares the separate signoff ${broken} validation and rolls back atomically`, async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const target = join(root, broken === 'structure' ? 'evidence/structure-chain.json' : 'evidence/diff-components.json');
  const original = readFileSync(target);
  let staged = '';
  try {
    expectAtomicRefusal(root, broken === 'structure' ? 'STRUCTURE_DECISIONS_INVALID' : 'DIFF_MAP_REPORT', () => ingestSyntheticFetch(root, act, path => {
      staged = path; writeFileSync(target, '{}\n');
    }));
    expect(existsSync(staged)).toBe(false);
  } finally { writeFileSync(target, original); }
}, SINGLE_ACT_TIMEOUT_MS);

test('fold staging exception leaves project bytes and old evidence untouched', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const before = readFileSync(join(root, 'project.json'));
  let staged = '';
  expect(() => ingestSyntheticFetch(root, act, path => { staged = path; throw Error('synthetic staging interruption'); })).toThrow('synthetic staging interruption');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(existsSync(staged)).toBe(false);
  expect(readdirSync(root).filter(name => name.startsWith('.parts-review-'))).toEqual([]);
}, SINGLE_ACT_TIMEOUT_MS);

test('fold ledger binds approval authority, draft, evidence and unique signature', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
  const project = read(root);
  expect(reviewActFindings(project)).toEqual([]);
  const receipt = (project.review_acts as JsonObject[]).at(-1)!;
  const index = Number(receipt.signoff);
  const signoff = (project.signoffs as JsonObject[])[index]!;
  expect(signoff.structure).toMatchObject({ path: 'evidence/structure-chain.json' });
  expect(signoff.evidence).toMatchObject({ path: (receipt.evidence as JsonObject).path, sha256: receipt.sha256, spec: act.schema });
  for (const [key, value] of Object.entries({ by: 'agent', at: '2020-01-01T00:00:00Z', stage: 'rig-review', draft_id: 'other', verbatim: 'changed', source: 'copied' })) {
    const changed = structuredClone(project);
    (changed.signoffs as JsonObject[])[index]![key] = value;
    expect(reviewActFindings(changed).map(f => f.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
  }
  for (const change of [
    (p: JsonObject) => { (p.signoffs as JsonObject[]).splice(index, 1); },
    (p: JsonObject) => { (p.signoffs as JsonObject[]).push(structuredClone(signoff)); },
    (p: JsonObject) => { ((p.signoffs as JsonObject[])[index]!.evidence as JsonObject).sha256 = 'a'.repeat(64); },
    (p: JsonObject) => { (p.review_acts as JsonObject[])[0]!.signoff = -1; },
    (p: JsonObject) => { delete (p.review_acts as JsonObject[])[0]!.signoff; },
  ]) {
    const changed = structuredClone(project); change(changed);
    expect(reviewActFindings(changed).map(f => f.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
  }
}, SINGLE_ACT_TIMEOUT_MS);

for (const missing of ['arrival', 'effective-stage'] as const) test(`fold refuses ${missing} readiness even with a matching project hash`, async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const project = read(root);
  if (missing === 'arrival') project.advances = (project.advances as JsonObject[]).filter(move => move.stage !== 'parts-review');
  else project.stage = 'parts';
  write(root, project);
  const synthetic = { ...act, source: { ...act.source, projectHash: jobHash(readFileSync(join(root, 'project.json'))) } } as JobAct;
  expectAtomicRefusal(root, 'PARTS_REVIEW_FOLD_NOT_READY', () => ingestSyntheticFetch(root, synthetic));
}, SINGLE_ACT_TIMEOUT_MS);

test('fold refuses an approval predating the evidence and physical advance', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const earlier = new Date(Date.parse(String((read(root).diff_map as JsonObject).at)) - 1000).toISOString();
  expectAtomicRefusal(root, 'REVIEW_ACT_SOURCE_STALE', () => ingestSyntheticFetch(root, { ...act, at: earlier } as JobAct));
}, SINGLE_ACT_TIMEOUT_MS);

test('historical approved UI receipt stays unsigned on replay and accepts the old separate signoff act', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
  // Reconstruct the pre-fold history explicitly, without changing shared receipt fixtures.
  const historical = read(root);
  const receipt = (historical.review_acts as JsonObject[]).at(-1)!;
  (historical.signoffs as JsonObject[]).splice(Number(receipt.signoff), 1);
  delete receipt.signoff;
  write(root, historical);
  const before = readFileSync(join(root, 'project.json'));
  expect(ingestSyntheticFetch(root, act).exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(reviewActFindings(read(root))).toEqual([]);
  const separate = {
    ...act, kind: 'signoff', actId: 'historical-separate-signoff', publicationId: 'historical-unretained-publication', at: new Date().toISOString(),
    source: { ...act.source, projectHash: jobHash(before) },
    value: { stage: 'parts-review', decision: 'approved', comments: [{ text: 'Separate synthetic approval.' }] },
  };
  seedStoredSignoffAct(root, 'parts-review', separate as unknown as JsonObject, {
    now: Date.now(),
    draftId: 'chain',
    structureFile: 'evidence/structure-chain.json',
    checkProjectHash: true,
  });
  const project = read(root);
  expect((project.signoffs as JsonObject[]).at(-1)).toMatchObject({ source: `review act ${act.jobId}/${separate.actId}`, stage: 'parts-review' });
  expect(reviewActFindings(project)).toEqual([]);
  expect(checkProject(root, undefined, { now: Date.now() }).refusals.map(f => f.code)).toEqual([]);
}, SINGLE_ACT_TIMEOUT_MS);

for (const verdict of ['approved', 'changes-requested'] as const) {
  test(`#840 an owner ${verdict} parts verdict from an owner host keeps its record bytes`, async () => {
    const { root, host } = await bound();
    const act = await submit(root, host, verdict, verdict === 'approved' ? 'clean' : 'flagged');
    const before = read(root);
    const result = JSON.parse(ingestSyntheticFetch(root, act).stdout);
    expect(result.by).toBe('user');
    const signoffs = read(root).signoffs as JsonObject[];
    if (verdict === 'changes-requested') { expect(signoffs).toEqual(before.signoffs as JsonObject[]); return; }
    const evidence = result.evidence as JsonObject;
    const structure = (signoffs.at(-1)!.structure as JsonObject).sha256;
    expect(JSON.stringify(signoffs.at(-1))).toBe(`{"stage":"parts-review","checkpoint":null,"by":"user","at":"${act.at}","verbatim":${JSON.stringify(result.verbatim)},"source":"review act ${act.jobId}/${act.actId}","evidence":{"kind":"parts-verdict","path":"${String(evidence.path)}","sha256":"${String(evidence.sha256)}","spec":"${act.schema}"},"draft_id":"chain","structure":{"path":"evidence/structure-chain.json","sha256":"${String(structure)}"}}`);
  }, MULTI_SPAWN_TIMEOUT_MS);

  test(`#840 a ${verdict} parts verdict from an owner host opened for the agent refuses SIGNOFF_NOT_HUMAN and writes nothing`, async () => {
    const { root, host } = await bound(true, verdict === 'approved' ? ' agent ' : 'agent');
    const act = await submit(root, host, verdict, verdict === 'approved' ? 'clean' : 'flagged');
    const before = treeDigest(root);
    expect(() => ingestSyntheticFetch(root, act)).toThrow(expect.objectContaining({ code: 'SIGNOFF_NOT_HUMAN' }));
    expect(treeDigest(root)).toEqual(before);
  }, MULTI_SPAWN_TIMEOUT_MS);
}
