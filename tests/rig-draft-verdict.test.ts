import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startJobHost, type JobSubject } from '@rig-c/review/job-host';
import { EXAMPLE_NOW, EXAMPLE_SOURCE_DATE_EPOCH } from '../scripts/example-time.ts';
import { checkProject } from '../src/check.ts';
import { draftRigCommand } from '../src/drafts.ts';
import { acknowledgePublication, enqueuePublication, jobHash, jobHostStateRoot, pendingPublications, readAcknowledgedPublication, readWriterBinding, reconcilePublication } from '../src/job-outbox.ts';
import { askDeclaredSubjects, openCreateJob } from '../src/job-host.ts';
import { draftPackageIdentity, prepareDraftManifest, publishedSourcePainting, readPublished } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { decodeReviewAct, draftReviewStillEvidence, isDraftReviewVerdict, reviewActFindings } from '../src/review-act.ts';
import { nextProject } from '../src/next.ts';
import type { JsonObject } from '../src/templates.ts';
import { staleRecordPlant, treeDigest } from './helpers.ts';
import { meshEdits } from './mesh-edit-fixture.ts';

const subject = { kind: 'review-verdict', stage: 'rig-review' } as const;
const draftId = 'synthetic-review';
const draft = `derived/drafts/${draftId}`;
const model = `${draft}/out/check/build/skeleton.model.json`;
const selector = { kind: 'draft', id: draftId } as const;
const comment = '  Hold the synthetic pose.\r\n두 번째 줄.\n ';
const verbatim = `[general]\n${comment}`;
// Review stamps its real HTTP acts with the wall clock. Keep their build and
// draft sources in the past, including before noon on the example's anchor day.
const fixtureNow = Math.min(EXAMPLE_NOW, Date.now() - 1000);
const at = new Date(fixtureNow).toISOString();
const testTimeoutMs = 60_000;
// Each mesh edit is one Parts remesh with its own rigc build.
const meshTimeoutMs = 300_000;
const examples = join(import.meta.dir, '../templates/example-chain');
const roots: string[] = [];
const hosts: Bun.Subprocess[] = [];
const legacyHosts: Awaited<ReturnType<typeof openCreateJob>>[] = [];

afterEach(async () => {
  for (const host of legacyHosts.splice(0)) host.stop();
  for (const host of hosts.splice(0)) {
    if (host.exitCode === null) host.kill('SIGTERM');
    await host.exited;
  }
  for (const root of roots.splice(0)) {
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
const write = (root: string, path: string, data: unknown) => writeFileSync(join(root, path), `${JSON.stringify(data, null, 2)}\n`);

function checkpoint(id: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-rig-draft-verdict-')));
  roots.push(root);
  cpSync(join(examples, 'checkpoints', id), root, { recursive: true });
  return root;
}

function spawn(root: string, args: string[], preload?: string, timeout = testTimeoutMs + 5_000, now = Date.now() + 1000) {
  const commandAt = new Date(now).toISOString();
  return Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), ...(preload ? ['--preload', preload] : []),
    join(import.meta.dir, 'cli-at.ts'), '--fetch-timeout-ms', String(timeout), commandAt, ...args], {
    cwd: root, stdout: 'pipe', stderr: 'pipe', timeout,
  });
}

async function cli(root: string, args: string[], preload?: string, timeout?: number, now?: number) {
  const proc = spawn(root, args, preload, timeout, now);
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exit };
}

function assertSuccess(result: { exit: number; stderr: string }): void {
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: '' });
}

const openArgs = (root: string, id: string, kind: 'draft' | 'rig' = 'draft', reviewer = 'synthetic-owner') =>
  ['job', 'open', root, `--${kind}`, id, '--reviewer', reviewer, '--role', 'owner'];

async function open(root: string, id: string, kind: 'draft' | 'rig' = 'draft', reviewer?: string, timeout?: number) {
  const proc = spawn(root, openArgs(root, id, kind, reviewer), undefined, timeout);
  hosts.push(proc);
  const reader = proc.stdout.getReader();
  const errors = proc.stderr.getReader();
  const failure = errors.read().then(async item => ({ error: item.done
    ? `job open exited ${await proc.exited}` : new TextDecoder().decode(item.value) })).finally(() => errors.releaseLock());
  const decoder = new TextDecoder();
  let output = '';
  const prefix = kind === 'draft' ? `job: draft ${id} published ` : `job: rig v${id} published `;
  const published = (line: string) => line.startsWith(prefix)
    && /^\(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)$/.test(line.slice(prefix.length));
  try {
    while (!output.endsWith('\n') || !output.split('\n').some(published)) {
      const item = await Promise.race([reader.read(), failure]);
      if ('error' in item) throw new Error(item.error);
      if (item.done) throw new Error((await failure).error);
      output += decoder.decode(item.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  const [url, ...lines] = output.trimEnd().split('\n');
  return { url: new URL(url!), lines };
}

/** Recreate a retained verdict-era Review publication for the historical ingest tests. */
async function openLegacyVerdict(root: string, reviewer = 'synthetic-owner'): Promise<URL> {
  const host = await openCreateJob(root, { id: reviewer, role: 'owner' }, Date.now(), options => startJobHost({
    ...options, readPublished: async input => ({ ...await readPublished(input), subjects: [subject] }),
  }));
  legacyHosts.push(host);
  const project = read(root);
  const binding = readWriterBinding(root)!;
  const path = prepareDraftManifest(root, project, draftId, draftPackageIdentity(draftId).path);
  const result = { path, selector };
  const entry = enqueuePublication(root, binding, result);
  const requestId = randomUUID();
  const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${binding.jobId}/api`, {
    method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: binding.identity.apiSchema, verb: 'publish', jobId: binding.jobId,
      requestId, idempotencyKey: requestId, expectedGeneration: host.session.status().generation, result,
      freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } } }),
  }));
  const reply = await response.json() as { ok: boolean; value: { publicationId: string; generation: number;
    source: { projectHash: string; sourceHash: string; model: { path: string; sha256: string } } } };
  expect(reply.ok).toBe(true);
  const { publicationId, generation, source } = reply.value;
  await reconcilePublication(root, entry, async pending => {
    acknowledgePublication(pending, publicationId, generation, requestId, [subject], undefined, {
      projectHash: source.projectHash, sourceHash: source.sourceHash, model: source.model,
      painting: publishedSourcePainting(root, project, `drafts[${draftId}]`),
    });
  });
  expect(await askDeclaredSubjects(host, publicationId, [subject], false)).toEqual([{ status: 'asked', subject }]);
  return new URL(host.ownerUrl);
}

/** Rebuild the draft with producer-made meshes on two parts, as the example draft generator does. */
function twoMeshDraft(root: string): void {
  const config = JSON.parse(readFileSync(join(root, draft, 'config.json'), 'utf8'));
  config.meshes.face = { grid: 16, r: 16, segments: [['body', [64, 16], [64, 48]]] };
  delete config.regions.face;
  write(root, `${draft}/config.json`, config);
  const env = { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH };
  for (const args of [['parts/bin/rig-parts.cjs', 'rig', '--config', `${draft}/config.json`, '--parts', `${draft}/out`, '--out', `${draft}/out/rig`],
    ['core/bin/rigc.cjs', 'build', '--rig', `${draft}/out/rig/rig.json`, '--motion', `${draft}/out/rig/motion.json`, '--out', `${draft}/out/check/build`,
      '--profile', 'rig-play', '--pack', '--page-edges', 'free', '--pack-shape', 'polygon']]) {
    const [bin, ...rest] = args;
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c', bin!), ...rest],
      { cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout: testTimeoutMs });
    expect({ exit: run.exitCode, stderr: run.exitCode === 0 ? '' : run.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
  }
}

function rigging(build?: (root: string) => void): string {
  const root = checkpoint('3-rig-review');
  const project = read(root);
  const citations = ((project.versions as JsonObject[])[0]!.provenance as JsonObject).sections;
  project.stage = 'rigging';
  project.advances = (project.advances as JsonObject[]).filter(row => row.stage !== 'rig-review');
  project.versions = [];
  write(root, 'project.json', project);
  for (const path of ['outputs/v1', 'evidence/v1', 'derived/review/v1']) rmSync(join(root, path), { recursive: true, force: true });

  prepareDraft(root, citations, fixtureNow - 1000, build);
  expect(checkProject(root, undefined, { now: fixtureNow, readOnly: true }).effective_stage).toBe('rigging');
  return root;
}

function prepareDraft(root: string, citations: JsonObject[string], draftAt: number, build?: (root: string) => void): void {
  // Use a real frozen build/idle/report set small enough for the writer. Keep the
  // chain's approved parts and config inputs as the inputs of both record writers.
  cpSync(join(import.meta.dir, 'fixtures/rig-registration'), join(root, 'producer'), { recursive: true });
  write(root, 'producer/citations.json', citations);
  cpSync(join(root, 'derived/drafts/chain/input'), join(root, draft, 'out'), { recursive: true });
  for (const file of ['config.json', 'interview-requirements.json']) {
    cpSync(join(root, 'derived/drafts/chain', file), join(root, draft, file));
  }
  if (build) build(root);
  else {
    cpSync(join(root, 'producer/rig'), join(root, draft, 'out/rig'), { recursive: true });
    cpSync(join(root, 'producer/build'), join(root, draft, 'out/check/build'), { recursive: true });
  }
  expect(draftRigCommand([draftId, root, '--config', `${draft}/config.json`, '--from', `${draft}/out`,
    '--parts', `${draft}/out`], draftAt).exit).toBe(0);
}

async function page(root: string, url: URL, expectedSubject: JobSubject) {
  const binding = readWriterBinding(root)!;
  const base = `${url.origin}/jobs/${binding.jobId}/`;
  const headers = { origin: url.origin, 'X-Review-Capability': url.hash.slice('#cap='.length), 'content-type': 'application/json' };
  const abort = new AbortController();
  const response = await fetch(base + 'events', { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
  const reader = response.body!.getReader();
  let head: JsonObject | undefined;
  let buffer = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      buffer += decoder.decode(item.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const event: JsonObject = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event.type === 'published') head = event.publication as JsonObject;
        if (event.type !== 'pending' || !head) continue;
        const ask = event.ask as JsonObject;
        expect(ask.publicationId).toBe(head.publicationId);
        expect<unknown>(ask.subject).toEqual(expectedSubject);
        return { binding, base, headers, head, ask, generation: event.generation };
      }
    }
    throw new Error('Review event stream ended before the declared ask');
  } finally { abort.abort(); reader.releaseLock(); }
}

/** Post one verdict act on the displayed draft and return it with its ingest command, not yet run. */
async function post(root: string, url: URL, verdict: 'approved' | 'changes-requested', extra?: (source: JsonObject) => JsonObject) {
  const { base, headers, binding, head, ask, generation } = await page(root, url, subject);
  const source = head.source as JsonObject;
  const publicationId = String(head.publicationId);
  expect(readAcknowledgedPublication(root, binding.jobId, publicationId)?.subjects).toEqual([subject]);
  expect(ask.source).toMatchObject({ selector, projectHash: jobHash(readFileSync(join(root, 'project.json'))),
    sourceHash: source.sourceHash, model: { path: model, sha256: jobHash(readFileSync(join(root, model))) }, direction: null });
  const send = async (route: string, body: object) => {
    const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const reply: JsonObject = await response.json();
    expect(reply).toMatchObject({ ok: true });
    return reply.value as JsonObject;
  };
  const pageId = randomUUID();
  const displayed = await send('ui/displayed', { publicationId, pageId, sourceHash: source.sourceHash });
  // Supply synthetic pixels in the ordinary setup-capture envelope. The Review
  // browser proof is responsible for obtaining such pixels from the draft page.
  const png = readFileSync(join(root, 'producer/build/rectangle.png'));
  const act = await send('ui/acts', { publicationId, pageId, askId: ask.askId, displayedNonce: displayed.displayedNonce,
    expectedGeneration: generation, submissionId: randomUUID(), kind: subject.kind,
    value: { stage: subject.stage, verdict, words: '', general: [comment], ...extra?.(source) },
    capture: { png: `data:image/png;base64,${png.toString('base64')}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
      binding: { publicationId, instanceKey: head.instanceKey, sourceHash: source.sourceHash, pageId, askId: ask.askId,
        drawGeneration: 1, playerGeneration: 0 } } });
  expect(act).toMatchObject({ source: { selector }, value: { stage: subject.stage, verdict, comments: [{ text: comment }] } });
  const exported = await fetch(base + 'api', { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${binding.fetchCapability}`, 'content-type': 'application/json', accept: 'application/vnd.rig-review.act+json' },
    body: JSON.stringify({ schema: 'rig-review/job-api@2', verb: 'fetch-act', jobId: binding.jobId, actId: act.actId, requestId: randomUUID() }) });
  expect(exported.ok).toBe(true);
  const rawAct = await exported.text();

  const pending = await cli(root, ['job', 'acts', root, '--json']);
  assertSuccess(pending);
  const rows = (JSON.parse(pending.stdout) as { acts: unknown[] }).acts;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actId: act.actId, args: null, unavailable: { code: 'NUMBERED_ACT_RETIRED' } });
  return { binding, act, rawAct, args: ['review', root, '--draft', draftId, '--from-review', String(act.actId)] };
}

async function submit(root: string, url: URL, verdict: 'approved' | 'changes-requested',
  extra?: (source: JsonObject) => JsonObject, timeout?: number) {
  const { binding, act, rawAct, args } = await post(root, url, verdict, extra);
  const ingest = await cli(root, args, undefined, timeout);
  assertSuccess(ingest);
  const receipt = (read(root).review_acts as JsonObject[]).at(-1)!;
  expect(receipt).toMatchObject({ kind: subject.kind, jobId: binding.jobId, actId: act.actId, draft_id: draftId,
    verdict: { review: subject.stage, verdict: verdict === 'approved' ? 'accepted' : 'bounced', verbatim } });
  expect(receipt.bytes).toBe(rawAct);
  expect(jobHash(String(receipt.bytes))).toBe(receipt.sha256 as string);
  expect(JSON.parse(String(receipt.bytes))).toEqual(act);
  const decoded = decodeReviewAct(rawAct);
  if (!isDraftReviewVerdict(decoded)) throw Error('expected draft verdict');
  const historicalStill = draftReviewStillEvidence(decoded);
  expect(historicalStill).toBeDefined();
  expect(receipt).not.toHaveProperty('evidence');
  expect(existsSync(join(root, historicalStill!.path))).toBe(false);
  expect(readFileSync(join(root, `evidence/drafts/${draftId}/${String(receipt.sha256)}.act.json`), 'utf8')).toBe(rawAct);
  return receipt;
}

test('#712 a compiled rigging draft publishes without a verdict ask', async () => {
  const root = rigging();
  const opening = await open(root, draftId);
  expect(opening.lines).toEqual([expect.stringMatching(/^job: draft synthetic-review published /)]);
  expect(opening.lines.join('\n')).not.toMatch(/JOB_PUBLICATION_ASK_REQUIRED|JOB_RIG_VERDICT_DEFERRED/);
  const publicationId = /publication ([\w-]+)\)/.exec(opening.lines[0]!)![1]!;
  const binding = readWriterBinding(root)!;
  expect(readAcknowledgedPublication(root, binding.jobId, publicationId)?.subjects).toEqual([]);
}, testTimeoutMs);

test('#712 a retained rigging draft verdict ingests the exact comment', async () => {
  const root = rigging();
  const url = await openLegacyVerdict(root);
  const receipt = await submit(root, url, 'changes-requested');
  expect(read(root)).toMatchObject({ stage: 'rigging', versions: [] });
  const record = readFileSync(join(root, 'project.json'));
  const actArgs = ['review', root, '--draft', draftId, '--from-review', String(receipt.actId)];
  const replay = await cli(root, actArgs);
  assertSuccess(replay);
  expect(readFileSync(join(root, 'project.json'))).toEqual(record);
  const malformed = read(root);
  (malformed.review_acts as JsonObject[]).at(-1)!.evidence = null;
  expect(reviewActFindings(malformed).map(f => f.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
  const wrongDraft = await cli(root, ['review', root, '--draft', 'chain', '--from-review', String(receipt.actId)]);
  expect(wrongDraft.exit).toBe(1);
  expect(wrongDraft.stderr).toMatch(/\bREVIEW_ACT_KIND_MISMATCH:/);
  expect(readFileSync(join(root, 'project.json'))).toEqual(record);
}, testTimeoutMs);

test('#712 a rigging draft with a changed retained model refuses before publication', async () => {
  const root = rigging();
  writeFileSync(join(root, model), '\n', { flag: 'a' });
  const before = readFileSync(join(root, 'project.json'));
  const result = await cli(root, openArgs(root, draftId));
  expect(result.exit).toBe(1);
  expect(result.stderr).toMatch(/\bJOB_PUBLICATION_INVALID:/);
  expect(result.stderr).toContain(`${model} differs from its retained hash`);
  expect(result.stdout).toBe('');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(jobHostStateRoot(root))).toBe(false);
  expect(existsSync(join(root, `review-draft-${draftId}.json`))).toBe(false);
}, testTimeoutMs);

test('#773 a draft Request changes with two mesh edits records two mesh-delta corrections on the draft', async () => {
  const root = rigging(twoMeshDraft);
  const url = await openLegacyVerdict(root);
  let sent: JsonObject[] = [];
  const receipt = await submit(root, url, 'changes-requested', source => {
    sent = meshEdits(root, source, ['face', 'torso']);
    return { meshEdits: sent };
  }, meshTimeoutMs);
  expect(JSON.parse(String(receipt.bytes)).schema).toBe('rig-review/act@8');
  const project = read(root);
  const corrections = project.corrections as JsonObject[];
  expect(corrections).toHaveLength(2);
  for (const [index, correction] of corrections.entries()) {
    expect(correction).toMatchObject({ source: `review act ${receipt.jobId}/${receipt.actId}`,
      on: { kind: 'draft', id: draftId }, artifact: { kind: 'mesh-delta', payloadSha256: sent[index]!.sha256 },
      outcome: { kind: 'mesh-delta', provenance: { request: { part: ['face', 'torso'][index] } } } });
  }
  // The second edit applies on the first one's revision, keyed by the draft.
  const [first, second] = corrections.map(row => row.outcome as JsonObject);
  expect(String(second!.revision)).not.toBe(String(first!.revision));
  const check = await cli(root, ['interview', '--check', root]);
  expect({ exit: check.exit, stderr: check.stderr }).toEqual({ exit: 0, stderr: '' });
  // Replay keeps the record and makes no second revision.
  const record = readFileSync(join(root, 'project.json'));
  assertSuccess(await cli(root, ['review', root, '--draft', draftId, '--from-review', String(receipt.actId)], undefined, meshTimeoutMs));
  expect(readFileSync(join(root, 'project.json'))).toEqual(record);
}, 3 * meshTimeoutMs);

test('#773 a draft ingest refused after its evidence write leaves the project tree as it was', async () => {
  const root = rigging();
  const url = await openLegacyVerdict(root);
  const { args } = await post(root, url, 'changes-requested');
  const plants = realpathSync(mkdtempSync(join(tmpdir(), 'create-draft-plant-')));
  roots.push(plants);
  const record = join(root, 'project.json');
  const original = readFileSync(record);
  const before = treeDigest(root);
  const refused = await cli(root, args, staleRecordPlant(plants, record, '.act.json'));
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toMatch(/\bREVIEW_ACT_SOURCE_STALE:/);
  writeFileSync(record, original);
  expect(treeDigest(root)).toEqual(before);
  assertSuccess(await cli(root, args));
  // The sidecar directory is new and was removed after the refused write.
  expect(before.has(`evidence/drafts/${draftId}/`)).toBe(false);
}, testTimeoutMs);

async function register(root: string, variant: 'identical' | 'changed', n = 1, flags: string[] = []) {
  const reviewedConfig = readFileSync(join(root, draft, 'config.json'));
  const registrationConfig = variant === 'identical' ? reviewedConfig : Buffer.concat([reviewedConfig, Buffer.from('\n')]);
  // Preserve the shown inputs. The changed case has an unchanged model and
  // equivalent config JSON, so a semantic or model-only comparison cannot pass.
  writeFileSync(join(root, 'producer/config.json'), registrationConfig);
  cpSync(join(root, draft, 'interview-requirements.json'), join(root, 'producer/interview-requirements.json'));
  write(root, 'producer/adapter.json', []);
  write(root, 'producer/at-source.json', { finished_at: at });
  write(root, 'producer/run.json', { spec: 'rigc-run/1', package: { name: 'rig-c', version: '3.4.1' }, command: 'build',
    started_at: new Date(fixtureNow - 1000).toISOString(), finished_at: at,
    inputs: ['rig', 'motion'].map(role => ({ role, path: `rig/${role}.json`, sha256: jobHash(readFileSync(join(root, 'producer/rig', `${role}.json`))) })),
    outputs: [{ path: 'build/skeleton.model.json', sha256: jobHash(readFileSync(join(root, 'producer/build/skeleton.model.json'))) }] });
  return await cli(root, ['rig-version', String(n), root, '--parts', `${draft}/out`, '--rig', 'producer/rig',
    '--build', 'producer/build', '--idle', 'producer/idle', '--config', 'producer/config.json', '--path-adapter', 'producer/adapter.json',
    '--compile-report', 'producer/compile-report.json', '--toolchain-lock', 'producer/package-lock.json', '--run-record', 'producer/run.json',
    '--at-source', 'producer/at-source.json', '--at-pointer', '/finished_at', '--citations', 'producer/citations.json', '--by', 'synthetic-registrant', ...flags]);
}

test.each(['identical', 'changed', 'historical still'] as const)('#712 registration preserves the reviewed bytes and evidence for %s', async mode => {
  const variant = mode === 'changed' ? 'changed' : 'identical';
  const root = rigging();
  const url = await openLegacyVerdict(root);
  const approval = await submit(root, url, 'approved');
  let still: ReturnType<typeof draftReviewStillEvidence>;
  if (mode === 'historical still') {
    const project = read(root);
    const receipt = (project.review_acts as JsonObject[]).at(-1)!;
    const act = decodeReviewAct(String(receipt.bytes));
    if (!isDraftReviewVerdict(act)) throw Error('expected draft verdict');
    still = draftReviewStillEvidence(act)!;
    receipt.evidence = still;
    write(root, 'project.json', project);
    const before = readFileSync(join(root, 'project.json'));
    const args = ['review', root, '--draft', draftId, '--from-review', act.actId];
    const destination = join(root, still.path);
    writeFileSync(destination, 'changed pixels');
    const refused = await cli(root, args);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toMatch(/\bREVIEW_ACT_STILL_INVALID:/);
    writeFileSync(destination, readFileSync(join(root, 'producer/build/rectangle.png')));
    assertSuccess(await cli(root, args));
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  }
  const registration = await register(root, variant);
  assertSuccess(registration);
  const version = (read(root).versions as JsonObject[])[0]!;
  expect(version).toMatchObject({ n: 1, kind: 'rig' });
  expect(readFileSync(join(root, 'outputs/v1/out/check/build/skeleton.model.json'))).toEqual(readFileSync(join(root, model)));
  expect(registration.stdout).toContain('rig-version: v1 committed without publishing');
  expect(pendingPublications(root)).toEqual([]);
  expect(existsSync(join(root, 'review-live-v1.json'))).toBe(false);
  if (variant === 'changed') {
    expect(version.verdicts).toEqual([]);
    return;
  }
  expect(version.verdicts).toEqual([expect.objectContaining({ review: subject.stage, verdict: 'accepted', verbatim,
    carried_from_draft: expect.objectContaining({ draft_id: draftId, job_id: approval.jobId, act_id: approval.actId }) })]);
  expect(version.evidence).toEqual(still ? [still] : []);
  expect(registration.stdout).not.toContain('ask review-verdict rig-review');
  expect(registration.stdout).not.toContain('asked review-verdict rig-review');
  const project = read(root);
  if (still) {
    writeFileSync(join(root, still.path), 'changed after carry');
    expect(checkProject(root, project, { now: Date.now(), readOnly: true }).refusals).toContainEqual(
      expect.objectContaining({ code: 'REVIEW_ACT_LEDGER_INVALID', path: 'versions[v1].verdicts[0]' }));
    writeFileSync(join(root, still.path), readFileSync(join(root, 'producer/build/rectangle.png')));
  }
  const verdict = ((project.versions as JsonObject[])[0]!.verdicts as JsonObject[])[0]!;
  (verdict.carried_from_draft as JsonObject).act_id = 'different-act';
  expect(checkProject(root, project, { now: Date.now(), readOnly: true }).refusals).toContainEqual(
    expect.objectContaining({ code: 'REVIEW_ACT_LEDGER_INVALID', path: 'versions[v1].verdicts[0]' }));
}, testTimeoutMs);

test('#803 a pending correction refuses carry and offers same-input registration without the verdict', async () => {
  const root = checkpoint('3-rig-review');
  const check = () => checkProject(root, undefined, { now: Date.now() + 2000, readOnly: true });
  const initial = read(root);
  const historyRig = (initial.versions as JsonObject[])[0]!;
  const citations = (historyRig.provenance as JsonObject).sections;
  const words = join(root, 'owner-words.txt');
  writeFileSync(words, 'Revise the synthetic rig.\n');
  const amendAt = fixtureNow - 2000;
  cpSync(join(root, 'derived/drafts/chain/config.json'), join(root, 'revised-config.json'));
  // A forward amendment is the current writer that returns the effective stage to rigging.
  assertSuccess(await cli(root, ['amend', 'rigging', root, '--kind', 'config-field', '--target', 'motion',
    '--change', 'revised-config.json', '--by', 'synthetic-owner', '--owner-chat', words,
    '--said-at', new Date(amendAt).toISOString(), '--relayed-by', 'synthetic-operator'], undefined, undefined, amendAt));
  expect(check().effective_stage).toBe('rigging');
  prepareDraft(root, citations, fixtureNow - 1000);
  const beforeCorrection = check();
  expect(beforeCorrection.refusals.map(f => f.code)).toEqual([]);
  assertSuccess(await cli(root, ['correction', 'record', root, '--stage', 'rig-review', '--version', '1',
    '--path', 'described', '--id', 'revise-motion', '--by', 'synthetic-owner', '--verbatim-file', words]));
  const afterCorrection = check();
  expect(afterCorrection.refusals.map(f => f.code)).toEqual([]);
  const url = await openLegacyVerdict(root);
  await submit(root, url, 'approved');

  const before = readFileSync(join(root, 'project.json'));
  const registrations = nextProject(root, Date.now() + 2000).moves.filter(move => move.command?.startsWith('rig-create rig-version '));
  expect(registrations).toHaveLength(1);
  const [move] = registrations;
  expect(move?.act).toContain('CORRECTION_PENDING');
  expect(move?.command).toStartWith('rig-create rig-version 2 ');
  expect(move?.command).toEndWith(' --no-draft-verdict');
  const carrying = await register(root, 'identical', 2);
  expect(carrying.exit).toBe(1);
  expect(carrying.stderr).toMatch(/\bCORRECTION_PENDING:/);
  expect(carrying.stderr.trimEnd()).toEndWith('--by synthetic-registrant --no-draft-verdict');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(check().refusals.map(f => f.code)).toEqual([]);
  const plain = await register(root, 'identical', 2, ['--no-draft-verdict']);
  assertSuccess(plain);
  expect((read(root).versions as JsonObject[]).at(-1)).toMatchObject({ n: 2, verdicts: [], evidence: [] });
  expect(read(root).corrections).toEqual((JSON.parse(before.toString()) as JsonObject).corrections);
  expect(check().refusals.map(f => f.code)).toEqual([]);
}, testTimeoutMs);

for (const [verdict, recorded] of [['approved', 'accepted'], ['changes-requested', 'bounced']] as const) {
  test(`#840 an owner ${verdict} draft verdict from an owner host keeps its receipt verdict bytes`, async () => {
    const root = rigging();
    const url = await openLegacyVerdict(root);
    const receipt = await submit(root, url, verdict);
    expect(JSON.stringify(receipt.verdict)).toBe(`{"by":"user","at":"${String(JSON.parse(String(receipt.bytes)).at)}","review":"rig-review","verdict":"${recorded}","verbatim":${JSON.stringify(verbatim)},"source":"review act ${String(receipt.jobId)}/${String(receipt.actId)}","on_items":[]}`);
  }, testTimeoutMs);

  test(`#840 a ${verdict} draft verdict from an owner host opened for the agent refuses REVIEW_NOT_HUMAN and writes nothing`, async () => {
    const root = rigging();
    const url = await openLegacyVerdict(root, verdict === 'approved' ? 'AGENT' : 'agent');
    const { args } = await post(root, url, verdict);
    const before = treeDigest(root);
    const refused = await cli(root, args);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toMatch(/\bREVIEW_NOT_HUMAN:/);
    expect(treeDigest(root)).toEqual(before);
  }, testTimeoutMs);
}
