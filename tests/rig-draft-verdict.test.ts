import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JobSubject } from '@rig-c/review/job-host';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { checkProject } from '../src/check.ts';
import { draftRigCommand } from '../src/drafts.ts';
import { jobHash, jobHostStateRoot, readAcknowledgedPublication, readWriterBinding } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { nextProject } from '../src/next.ts';
import type { JsonObject } from '../src/templates.ts';

const subject = { kind: 'review-verdict', stage: 'rig-review' } as const;
const draftId = 'synthetic-review';
const draft = `derived/drafts/${draftId}`;
const model = `${draft}/out/check/build/skeleton.model.json`;
const selector = { kind: 'draft', id: draftId } as const;
const comment = '  Hold the synthetic pose.\r\n두 번째 줄.\n ';
const verbatim = `[general]\n${comment}`;
const at = new Date(EXAMPLE_NOW).toISOString();
const testTimeoutMs = 60_000;
const examples = join(import.meta.dir, '../templates/example-chain');
const roots: string[] = [];
const hosts: Bun.Subprocess[] = [];

afterEach(async () => {
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

function spawn(root: string, args: string[]) {
  const commandAt = new Date(Date.now() + 1000).toISOString();
  return Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'cli-at.ts'), commandAt, ...args], {
    cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: testTimeoutMs + 5_000,
  });
}

async function cli(root: string, args: string[]) {
  const proc = spawn(root, args);
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exit };
}

function assertSuccess(result: { exit: number; stderr: string }): void {
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: '' });
}

const openArgs = (root: string, id: string) => ['job', 'open', root, '--draft', id, '--reviewer', 'synthetic-owner', '--role', 'owner'];

async function open(root: string, id: string) {
  const proc = spawn(root, openArgs(root, id));
  hosts.push(proc);
  const reader = proc.stdout.getReader();
  const errors = proc.stderr.getReader();
  const failure = errors.read().then(async item => ({ error: item.done
    ? `job open exited ${await proc.exited}` : new TextDecoder().decode(item.value) })).finally(() => errors.releaseLock());
  const decoder = new TextDecoder();
  let output = '';
  try {
    while (!/^job: draft .* published$/m.test(output) || !output.endsWith('\n')) {
      const item = await Promise.race([reader.read(), failure]);
      if ('error' in item) throw new Error(item.error);
      if (item.done) throw new Error((await failure).error);
      output += decoder.decode(item.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  const [url, ...lines] = output.trimEnd().split('\n');
  return { url: new URL(url!), lines };
}

function rigging(): string {
  const root = checkpoint('3-rig-review');
  const project = read(root);
  const citations = ((project.versions as JsonObject[])[0]!.provenance as JsonObject).sections;
  project.stage = 'rigging';
  project.advances = (project.advances as JsonObject[]).filter(row => row.stage !== 'rig-review');
  project.versions = [];
  write(root, 'project.json', project);
  for (const path of ['outputs/v1', 'evidence/v1', 'derived/review/v1']) rmSync(join(root, path), { recursive: true, force: true });

  // Use a real frozen build/idle/report set small enough for the writer. Keep the
  // chain's approved parts and config inputs as the inputs of both record writers.
  cpSync(join(import.meta.dir, 'fixtures/rig-registration'), join(root, 'producer'), { recursive: true });
  write(root, 'producer/citations.json', citations);
  cpSync(join(root, 'derived/drafts/chain/input'), join(root, draft, 'out'), { recursive: true });
  for (const file of ['config.json', 'interview-requirements.json']) {
    cpSync(join(root, 'derived/drafts/chain', file), join(root, draft, file));
  }
  cpSync(join(root, 'producer/rig'), join(root, draft, 'out/rig'), { recursive: true });
  cpSync(join(root, 'producer/build'), join(root, draft, 'out/check/build'), { recursive: true });
  expect(draftRigCommand([draftId, root, '--config', `${draft}/config.json`, '--from', `${draft}/out`,
    '--parts', `${draft}/out`], EXAMPLE_NOW - 1000).exit).toBe(0);
  expect(checkProject(root, undefined, { now: EXAMPLE_NOW, readOnly: true }).effective_stage).toBe('rigging');
  return root;
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

async function submit(root: string, url: URL, verdict: 'approved' | 'changes-requested') {
  const { base, headers, binding, head, ask, generation } = await page(root, url, subject);
  const source = head.source as JsonObject;
  const publicationId = String(head.publicationId);
  expect(readAcknowledgedPublication(root, binding.jobId, publicationId)?.subjects).toEqual([subject]);
  expect(ask.source).toMatchObject({ selector, projectHash: jobHash(readFileSync(join(root, 'project.json'))),
    sourceHash: source.sourceHash, model: { path: model, sha256: jobHash(readFileSync(join(root, model))) }, direction: null });
  const post = async (route: string, body: object) => {
    const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const reply: JsonObject = await response.json();
    expect(reply).toMatchObject({ ok: true });
    return reply.value as JsonObject;
  };
  const pageId = randomUUID();
  const displayed = await post('ui/displayed', { publicationId, pageId, sourceHash: source.sourceHash });
  // Supply synthetic pixels in the ordinary setup-capture envelope. The Review
  // browser proof is responsible for obtaining such pixels from the draft page.
  const png = readFileSync(join(root, 'producer/build/rectangle.png'));
  const act = await post('ui/acts', { publicationId, pageId, askId: ask.askId, displayedNonce: displayed.displayedNonce,
    expectedGeneration: generation, submissionId: randomUUID(), kind: subject.kind,
    value: { stage: subject.stage, verdict, words: '', general: [comment] },
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
  const rows = (JSON.parse(pending.stdout) as { acts: { actId: string; args: string[] | null }[] }).acts;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actId: act.actId, args: ['review', root, '--draft', draftId, '--from-review', act.actId] });
  const ingest = await cli(root, rows[0]!.args!);
  assertSuccess(ingest);
  const receipt = (read(root).review_acts as JsonObject[]).at(-1)!;
  expect(receipt).toMatchObject({ kind: subject.kind, jobId: binding.jobId, actId: act.actId, draft_id: draftId,
    verdict: { review: subject.stage, verdict: verdict === 'approved' ? 'accepted' : 'bounced', verbatim } });
  expect(receipt.bytes).toBe(rawAct);
  expect(jobHash(String(receipt.bytes))).toBe(receipt.sha256 as string);
  expect(JSON.parse(String(receipt.bytes))).toEqual(act);
  const evidencePath = String((receipt.evidence as JsonObject).path);
  expect(readFileSync(join(root, evidencePath))).toEqual(png);
  expect(readFileSync(join(root, dirname(evidencePath), `${String(receipt.sha256)}.act.json`), 'utf8')).toBe(rawAct);
  return receipt;
}

test('#712 a rigging --draft asks for a rig verdict and ingests the exact comment', async () => {
  const root = rigging();
  expect(nextProject(root).moves).toContainEqual(expect.objectContaining({
    review_act: expect.objectContaining({ kind: 'review-verdict', stage: 'rig-review', draft_id: draftId }),
  }));
  const opening = await open(root, draftId);
  // Plant target: removing only the rigging subject must fail at this assertion.
  expect(opening.lines).toContain('job: asked review-verdict rig-review');
  const receipt = await submit(root, opening.url, 'changes-requested');
  expect(read(root)).toMatchObject({ stage: 'rigging', versions: [] });
  expect(nextProject(root).moves).toContainEqual(expect.objectContaining({
    command: expect.stringContaining("draft-rig '<new-id>'"),
    act: expect.stringContaining(String(receipt.actId)),
  }));
  const record = readFileSync(join(root, 'project.json'));
  const actArgs = ['review', root, '--draft', draftId, '--from-review', String(receipt.actId)];
  const replay = await cli(root, actArgs);
  assertSuccess(replay);
  expect(readFileSync(join(root, 'project.json'))).toEqual(record);
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

async function register(root: string, variant: 'identical' | 'changed') {
  const reviewedConfig = readFileSync(join(root, draft, 'config.json'));
  const registrationConfig = variant === 'identical' ? reviewedConfig : Buffer.concat([reviewedConfig, Buffer.from('\n')]);
  // Preserve the shown inputs. The changed case has an unchanged model and
  // equivalent config JSON, so a semantic or model-only comparison cannot pass.
  writeFileSync(join(root, 'producer/config.json'), registrationConfig);
  cpSync(join(root, draft, 'interview-requirements.json'), join(root, 'producer/interview-requirements.json'));
  write(root, 'producer/adapter.json', []);
  write(root, 'producer/at-source.json', { finished_at: at });
  write(root, 'producer/run.json', { spec: 'rigc-run/1', package: { name: 'rig-c', version: '3.4.1' }, command: 'build',
    started_at: new Date(EXAMPLE_NOW - 1000).toISOString(), finished_at: at,
    inputs: ['rig', 'motion'].map(role => ({ role, path: `rig/${role}.json`, sha256: jobHash(readFileSync(join(root, 'producer/rig', `${role}.json`))) })),
    outputs: [{ path: 'build/skeleton.model.json', sha256: jobHash(readFileSync(join(root, 'producer/build/skeleton.model.json'))) }] });
  return await cli(root, ['rig-version', '1', root, '--parts', `${draft}/out`, '--rig', 'producer/rig',
    '--build', 'producer/build', '--idle', 'producer/idle', '--config', 'producer/config.json', '--path-adapter', 'producer/adapter.json',
    '--compile-report', 'producer/compile-report.json', '--toolchain-lock', 'producer/package-lock.json', '--run-record', 'producer/run.json',
    '--at-source', 'producer/at-source.json', '--at-pointer', '/finished_at', '--citations', 'producer/citations.json', '--by', 'synthetic-registrant']);
}

test.each(['identical', 'changed'] as const)('#712 registration with %s bytes determines whether the owner is asked again', async variant => {
  const root = rigging();
  const opening = await open(root, draftId);
  expect(opening.lines).toContain('job: asked review-verdict rig-review');
  const approval = await submit(root, opening.url, 'approved');
  const registration = await register(root, variant);
  assertSuccess(registration);
  const version = (read(root).versions as JsonObject[])[0]!;
  expect(version).toMatchObject({ n: 1, kind: 'rig' });
  expect(readFileSync(join(root, 'outputs/v1/out/check/build/skeleton.model.json'))).toEqual(readFileSync(join(root, model)));
  const published = /job: updated the open page: publication ([\w-]+)/.exec(registration.stdout);
  expect(published).not.toBeNull();
  const ack = readAcknowledgedPublication(root, String(approval.jobId), published![1]!);
  expect(ack?.result).toMatchObject({ selector: { kind: 'rig', version: 1 } });
  const verdictAsks = ack?.subjects?.filter(item => item.kind === 'review-verdict');
  if (variant === 'identical') {
    expect(version.verdicts).toEqual([expect.objectContaining({ review: subject.stage, verdict: 'accepted', verbatim,
      carried_from_draft: expect.objectContaining({ draft_id: draftId, job_id: approval.jobId, act_id: approval.actId }) })]);
    expect(registration.stdout).not.toContain('ask review-verdict rig-review');
    expect(registration.stdout).not.toContain('asked review-verdict rig-review');
    expect(verdictAsks).toEqual([]);
    const project = read(root);
    const verdict = ((project.versions as JsonObject[])[0]!.verdicts as JsonObject[])[0]!;
    (verdict.carried_from_draft as JsonObject).act_id = 'different-act';
    expect(checkProject(root, project, { now: Date.now(), readOnly: true }).refusals).toContainEqual(
      expect.objectContaining({ code: 'REVIEW_ACT_LEDGER_INVALID', path: 'versions[v1].verdicts[0]' }));
  } else {
    expect(version.verdicts).toEqual([]);
    expect(registration.stdout).toContain('job: asked review-verdict rig-review');
    expect(verdictAsks).toEqual([subject]);
  }
}, testTimeoutMs);
