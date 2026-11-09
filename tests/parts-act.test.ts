import { reviewStdout } from './review-read-fixture.ts';
import { partsReviewCommand } from '../src/parts-review.ts';
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JobAct, JobPartOutcome, JobVerdict } from '../node_modules/@rig-c/review/src/job-contract.ts';
import { loadPartsView, saveVerdict, verdictSource } from '../node_modules/@rig-c/review/src/parts-view.ts';
import type { JobOwnerHost } from '@rig-c/review/job-host';
import { openCreateJob, reconcileCreateJob } from '../src/job-host.ts';
import { partsEnumerator } from '../src/job-publication.ts';
import { jobHash, jobHostStateRoot, pendingPublications } from '../src/job-outbox.ts';
import { checkProject, collectItems } from '../src/check.ts';
import { optionContext } from '../src/choices.ts';
import { interviewOptionsCommand, interviewAnswerCommand } from '../src/choice-writers.ts';
import { interviewStageOfGuide } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import { planCommand } from '../src/plan-writers.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { diffClassesCommand } from '../src/diff-classes.ts';
import { signoffCommand } from '../src/signoff.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import { assertPartsActSource, partsActDraftHash, partsActFindings } from '../src/parts-act.ts';
import { prepareDraftManifest } from '../src/job-publication.ts';
import { recordedPartsVerdict } from '../src/parts-verdict-record.ts';
import { decodeReviewAct, type PartsVerdictActV5 } from '../src/review-act.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
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
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
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

const draftArgs = (id = 'chain') => ['draft-rig', id, '--config', `derived/drafts/${id}/config.json`, '--from', `derived/drafts/${id}/out`, '--parts', `derived/drafts/${id}/input`, '--json'];
async function bound() {
  const root = fixture();
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now());
  hosts.push(host);
  const result = expectCliOk(await cli(root, draftArgs()));
  expect(result.stderr).toBe(''); expect(result.exit).toBe(0);
  expect(host.session.status().publication?.source.selector).toEqual({ kind: 'draft', id: 'chain' });
  expect(host.session.status().publication!.source.parts!.images.map(({ path, role }) => ({ path, role })))
    .toEqual(partsEnumerator.enumerate(join(root, 'derived/drafts/chain/input')));
  return { root, host };
}
async function submit(root: string, host: JobOwnerHost, verdict: JobVerdict = 'approved', outcome: JobPartOutcome = 'clean', mesh: JobPartOutcome = outcome): Promise<JobAct> {
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
  const manifest = readFileSync(join(root, publication.source.parts!.manifest.path), 'utf8');
    const names = (JSON.parse(manifest).parts as { name: string }[]).map(part => part.name);
    const result = await host.ports.commitUIAct(host.session.jobId, ui('acts', { publicationId: publication.publicationId, askId: asked.value.askId,
      pageId, displayedNonce: displayed.value.displayedNonce, expectedGeneration: host.session.status().generation,
      submissionId: randomUUID(), kind: 'parts-verdict', value: { verdict, words: '  Synthetic parts review.\r\n',
        parts: names.map(partId => ({ partId, part: { outcome, note: outcome === 'flagged' ? 'Synthetic edge finding.' : '' },
          mesh: { outcome: mesh, note: mesh === 'flagged' ? 'Synthetic mesh finding.' : '' } })) } }));
    expect(result.ok ? undefined : result.error.code).toBeUndefined();
    expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.code);
    if (result.value.schema === 'rig-review/act@4') throw Error(result.value.schema);
    return result.value;
}

function prepareSignoff(root: string, _evidence: string): void {
  structureSnapshotCommand([root, '--draft', 'chain', '--out', 'evidence/structure.json']);
  advanceCommand(['parts-review', root,
    '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'], Date.now());
  diffClassesCommand([root, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'], Date.now());
}
function sign(root: string, _evidence: string): void {
  signoffCommand(['parts-review', root, '--by', 'user', '--verbatim-file', join(root, 'evidence/approval.txt'), '--draft', 'chain',
    '--structure-file', 'evidence/structure.json'], Date.now());
}

test('bound draft publishes its rows, ingests independent evidence and then signs explicitly', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const before = read(root);
  const first = expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId, '--json']));
  expect(first.stderr).toBe(''); expect(first.exit).toBe(0);
  const result = JSON.parse(first.stdout);
  const project = read(root);
  expect(project.signoffs).toEqual(before.signoffs); expect(project.stage).toBe(before.stage);
  expect(result.verbatim).toBe('  Synthetic parts review.\r\n'); expect(result.by).toBe('user');
  expect(JSON.parse(readFileSync(join(root, result.evidence.path), 'utf8'))).toEqual(act);
  expect(partsActFindings(root, project)).toEqual([]);
  const bytes = readFileSync(join(root, 'project.json'));
  const replay = expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId, '--json']));
  expect(replay.stdout).toBe(first.stdout);
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
  prepareSignoff(root, result.evidence.path);
  sign(root, result.evidence.path);
  expect(checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code)).toEqual(['STAGE_LAGGING']);
}, MULTI_SPAWN_TIMEOUT_MS);

test('legacy owner-shaped producer verdict retains the structure and signoff gate', async () => {
  const root = fixture(true);
  const input = join(root, 'derived/drafts/chain/input');
  const pkg = await loadPartsView(input, { rig: join(root, 'derived/drafts/chain/out/rig.json'),
    meshReport: join(root, 'derived/drafts/chain/out/mesh_report.json'), painting: join(input, 'painting_in_rig.png'),
    verdict: join(root, 'evidence/owner-verdict.json') });
  const source = verdictSource(pkg);
  expect(source.files.some(file => file.path.endsWith('rig.json'))).toBe(true);
  await saveVerdict(pkg, { status: 'approved', parts: Object.fromEntries(pkg.items.map(item => [item.name,
    { outcome: 'clean', ...(item.mesh ? { mesh: { outcome: 'clean' } } : {}) }])) });
  partsReviewCommand([root, '--draft', 'chain', '--from-review-cli', '--by', 'user', '--', 'derived/drafts/chain/input',
    '--rig', 'derived/drafts/chain/out/rig.json', '--mesh-report', 'derived/drafts/chain/out/mesh_report.json', '--painting', 'derived/drafts/chain/input/painting_in_rig.png', '--verdict', 'evidence/owner-verdict.json'], Date.now());
  prepareSignoff(root, 'evidence/owner-verdict.json');
  sign(root, 'evidence/owner-verdict.json');
  expect(checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code)).toEqual(['STAGE_LAGGING']);
});

for (const [verdict, part, mesh] of [
  ['approved', 'clean', 'clean'], ['changes-requested', 'flagged', 'clean'],
  ['changes-requested', 'clean', 'flagged'], ['pending', 'pending', 'pending'],
] as const) test(`semantic ${verdict}/${part}/${mesh} retains every outcome without a signoff`, async () => {
  const { root, host } = await bound();
  const act = await submit(root, host, verdict, part, mesh);
  const before = read(root);
  const result = expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId, '--json']));
  expect(result.exit).toBe(0); expect(result.stderr).toBe('');
  const recorded = JSON.parse(result.stdout);
  expect(recorded.verdict).toBe(verdict);
  const evidence = decodeReviewAct(readFileSync(join(root, recorded.evidence.path), 'utf8'), 'parts-verdict');
  if (evidence.schema !== 'rig-review/act@2') throw Error(evidence.schema);
  expect(evidence.value.parts.every(row => row.part.outcome === part && row.mesh.outcome === mesh)).toBe(true);
  expect(evidence.value.words).toBe('  Synthetic parts review.\r\n');
  expect(read(root).signoffs).toEqual(before.signoffs); expect(read(root).stage).toBe(before.stage);
  if (verdict !== 'approved') {
    expect(() => prepareSignoff(root, recorded.evidence.path)).toThrow(expect.objectContaining({ code: 'PARTS_VERDICT_NOT_APPROVED' }));
  }
}, SINGLE_ACT_TIMEOUT_MS);

for (const source of ['parts', 'config'] as const) test(`changed ${source} refuses stale replay without a record write`, async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  expect(expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId])).exit).toBe(0);
  const before = readFileSync(join(root, 'project.json'));
  const path = source === 'parts' ? act.source.parts!.manifest.path : 'derived/drafts/chain/config.json';
  writeFileSync(join(root, path), '{}\n');
  const result = expectCliRefused(await cli(root, ['parts-review', '--from-review', act.actId]), 'REVIEW_ACT_SOURCE_STALE');
  expect(result.exit).toBe(1); expect(result.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}, MULTI_SPAWN_TIMEOUT_MS);

test('a new-id rebuild with failed publication retries through job reconcile', async () => {
  const { root, host } = await bound();
  cpSync(join(root, 'derived/drafts/chain'), join(root, 'derived/drafts/rebuilt'), { recursive: true });
  writeFileSync(join(root, 'review-draft-rebuilt.json'), '{}\n');
  const failed = expectCliRefused(await cli(root, draftArgs('rebuilt')), 'JOB_PUBLISH_PENDING');
  expect(failed.exit).toBe(1); expect(failed.stderr).toContain('JOB_PUBLISH_PENDING:');
  expect(failed.stderr).toContain('JOB_PUBLICATION_INVALID');
  expect((read(root).drafts as JsonObject[]).map(draft => draft.id)).toEqual(['chain', 'rebuilt']);
  const pending = pendingPublications(root);
  expect(pending.length).toBe(1);
  expect(pending[0]!.failure?.code).toBe('JOB_PUBLICATION_INVALID');
  rmSync(join(root, 'review-draft-rebuilt.json'));
  expect(await reconcileCreateJob(root)).toBe(1);
  expect(host.session.status().publication!.source.selector).toEqual({ kind: 'draft', id: 'rebuilt' });
  const before = readFileSync(join(root, 'project.json'));
  const duplicate = expectCliRefused(await cli(root, draftArgs('rebuilt')), 'DRAFT_RIG_MALFORMED');
  expect(duplicate.exit).toBe(1); expect(duplicate.stderr).toContain('DRAFT_RIG_MALFORMED:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}, MULTI_SPAWN_TIMEOUT_MS);

test('unbound draft registration allocates no job outbox', async () => {
  const root = fixture();
  const result = expectCliOk(await cli(root, draftArgs()));
  expect(result.exit).toBe(0);
  expect(existsSync(join(root, '.rig-create-review'))).toBe(false);
  expect(read(root).review_job).toBeUndefined();
});

async function killAfterEvidence(root: string, actId: string): Promise<string> {
  const script = join(root, 'kill-after-evidence.ts');
  const marker = join(root, 'staged-path.txt');
  writeFileSync(script, `import {partsReviewCommand} from ${JSON.stringify(join(import.meta.dir, '../src/parts-review.ts'))};\nimport {writeFileSync} from 'node:fs';\npartsReviewCommand(['--from-review', ${JSON.stringify(actId)}], Date.now(), {afterEvidence(path) {writeFileSync(${JSON.stringify(marker)}, path); process.kill(process.pid, 'SIGKILL');}});\n`);
  const child = Bun.spawn([process.execPath, script], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit: exit !== 0, signal: child.signalCode, stdout, stderr, staged: existsSync(marker) }).toEqual({
    exit: true,
    signal: 'SIGKILL',
    stdout: '',
    stderr: '',
    staged: true,
  });
  expect(exit).not.toBe(0);
  return readFileSync(marker, 'utf8');
}

test('killed evidence staging retries the same file and commits once', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const before = readFileSync(join(root, 'project.json'));
  const path = await killAfterEvidence(root, act.actId);
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  const evidence = readFileSync(path);
  expect(JSON.parse(evidence.toString())).toEqual(act);
  expect(expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId])).exit).toBe(0);
  expect(readFileSync(path)).toEqual(evidence);
  expect((read(root).review_acts as JsonObject[]).length).toBe(1);
  const committed = readFileSync(join(root, 'project.json'));
  expect(expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId])).exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(committed);
}, MULTI_SPAWN_TIMEOUT_MS);

test('another act at the staged deterministic path refuses with bytes identical', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const path = await killAfterEvidence(root, act.actId);
  writeFileSync(path, JSON.stringify({ ...act, actId: 'different-synthetic-act' }));
  const before = readFileSync(join(root, 'project.json'));
  const result = expectCliRefused(await cli(root, ['parts-review', '--from-review', act.actId]), 'PARTS_REVIEW_EVIDENCE_CONFLICT');
  expect(result.exit).toBe(1); expect(result.stderr).toContain('PARTS_REVIEW_EVIDENCE_CONFLICT:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}, MULTI_SPAWN_TIMEOUT_MS);

test('standalone draft without a compiled model publishes through image references', async () => {
  const root = fixture();
  rmSync(join(root, 'derived/drafts/chain/out/check'), { recursive: true });
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now());
  hosts.push(host);
  expect(expectCliOk(await cli(root, draftArgs())).exit).toBe(0);
  expect(host.session.status().publication!.source.model).toBeNull();
  const act = await submit(root, host);
  expect(expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId])).exit).toBe(0);
}, SINGLE_ACT_TIMEOUT_MS);

test('build-root draft binds its own parts inventory and compiled output', async () => {
  const root = fixture();
  const draft = join(root, 'derived/drafts/chain');
  cpSync(join(draft, 'input'), join(draft, 'build'), { recursive: true });
  cpSync(join(draft, 'out'), join(draft, 'build/rig'), { recursive: true });
  cpSync(join(draft, 'out/check'), join(draft, 'build/check'), { recursive: true });
  rmSync(join(draft, 'build/rig/check'), { recursive: true });
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now());
  hosts.push(host);
  const result = expectCliOk(await cli(root, ['draft-rig', 'chain', '--config', 'derived/drafts/chain/config.json', '--from', 'derived/drafts/chain/build']));
  expect(result.stderr).toBe(''); expect(result.exit).toBe(0);
  expect(host.session.status().publication!.source.parts!.manifest.path).toBe('derived/drafts/chain/build/parts.json');
  expect(host.session.status().publication!.source.model!.path).toBe('derived/drafts/chain/build/check/build/skeleton.model.json');
  const act = await submit(root, host);
  expect(expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId])).exit).toBe(0);
}, SINGLE_ACT_TIMEOUT_MS);

test('missing private receipt emits the named warning while retaining source checks', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  rmSync(join(root, '.rig-create-review/acknowledged-publications'), { recursive: true });
  const result = expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId, '--json']));
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).warnings[0]).toStartWith('REVIEW_ACT_VERSION_UNVERIFIED:');
}, SINGLE_ACT_TIMEOUT_MS);

test('competing human value flags refuse without record mutation', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const before = readFileSync(join(root, 'project.json'));
  const result = expectCliRefused(await cli(root, ['parts-review', '--from-review', act.actId, '--verdict', 'approved']), 'PARTS_REVIEW_OPTION_INVALID', 2);
  expect(result.exit).toBe(2); expect(result.stderr).toContain('PARTS_REVIEW_OPTION_INVALID:');
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
      ...asks.flatMap(ask => ['--pick', `${ask.id}=keep`])], now);
  }
}

test('retained parts approval survives real rigging signoff checkpoint changes and still rejects changed images', async () => {
  const { root, host } = await bound();
  const act = await submit(root, host);
  const result = expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId, '--json']));
  expect(result.exit).toBe(0);
  const evidence = JSON.parse(result.stdout).evidence.path;
  prepareSignoff(root, evidence);
  sign(root, evidence);
  answerRiggingInterview(root);
  const steps = (read(root).plan as JsonObject).steps as JsonObject[];
  const before = steps.find(step => step.id === 'bones')!;
  expect(before.checkpoint).toBeNull();
  const hash = stepHash(before);
  signoffCommand(['rigging-interview', root, '--by', 'user', '--verbatim-file', join(root, 'evidence/approval.txt')], Date.now());
  const after = ((read(root).plan as JsonObject).steps as JsonObject[]).find(step => step.id === 'bones')!;
  expect(after.checkpoint).not.toBeNull();
  expect(stepHash(after)).not.toBe(hash);
  expect(checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code)).toEqual(['STAGE_LAGGING']);
  const image = act.source.parts!.images.find(row => row.role === 'part')!;
  writeFileSync(join(root, 'derived/drafts/chain/input', image.path), Buffer.from('synthetic changed image'));
  expect(checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code)).toContain('REVIEW_ACT_SOURCE_STALE');
}, MULTI_SPAWN_TIMEOUT_MS);

test('changed plan still refuses first ingest and replay before deduplication', async () => {
  for (const replay of [false, true]) {
    const { root, host } = await bound();
    const act = await submit(root, host);
    if (replay) expect(expectCliOk(await cli(root, ['parts-review', '--from-review', act.actId])).exit).toBe(0);
    planCommand(['revise', 'bones', root, '--by', 'agent', '--bar', 'The revised synthetic bone plan meets its declared bar.'], Date.now());
    const before = readFileSync(join(root, 'project.json'));
    const result = expectCliRefused(await cli(root, ['parts-review', '--from-review', act.actId]), 'REVIEW_ACT_SOURCE_STALE');
    expect(result.exit).toBe(1); expect(result.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  }
}, DUAL_REPLAY_TIMEOUT_MS);

test('CLI and act receipts share current-verdict ordering', async () => {
  const { partsReviewCommand } = await import('../src/parts-review.ts');
  const { latestPartsVerdictFinding } = await import('../src/parts-verdict-record.ts');
  const { root, host } = await bound();
  const rejected = await submit(root, host, 'changes-requested', 'flagged');
  const nextRejected = await submit(root, host, 'changes-requested', 'flagged');
  expect(expectCliOk(await cli(root, ['parts-review', '--from-review', rejected.actId])).exit).toBe(0);
  expect(latestPartsVerdictFinding(read(root), 'chain', 'signoffs[0].draft_id')?.code).toBe('PARTS_VERDICT_LATEST_NOT_APPROVED');
  const draft = (read(root).drafts as JsonObject[])[0]!;
  const response = { schema: 'rig-review-parts-verdict/2', status: 'approved', tool: { name: '@rig-c/review', version: '2.5.0' },
    source: { sha256: 'a'.repeat(64), files: (draft.parts as JsonObject).files }, parts: { torso: { outcome: 'clean', note: '' } } };
  partsReviewCommand([root, '--draft', 'chain', '--from-review-cli', '--by', 'user', '--', 'opaque', '--verdict', 'opaque.json'], Date.now(), {
    runCli: reviewStdout(JSON.stringify(response)),
  });
  expect(latestPartsVerdictFinding(read(root), 'chain', 'signoffs[0].draft_id')).toBeUndefined();
  expect(expectCliOk(await cli(root, ['parts-review', '--from-review', nextRejected.actId])).exit).toBe(0);
  expect(latestPartsVerdictFinding(read(root), 'chain', 'signoffs[0].draft_id')?.code).toBe('PARTS_VERDICT_LATEST_NOT_APPROVED');
  expect(partsActFindings(root, read(root))).toEqual([]);
}, MULTI_SPAWN_TIMEOUT_MS);

test('act@5 issue-list parts verdict decodes, enforces verdict/issues invariant and checks manifest inclusion and draft panels', () => {
  const root = fixture(true);
  const project = read(root);
  const manifestFile = prepareDraftManifest(root, project, 'chain');
  const publishedManifest = JSON.parse(readFileSync(join(root, manifestFile), 'utf8')) as JsonObject;
  expect(publishedManifest.panels).toEqual({
    schema: 'rig-review/panels@1',
    left: ['parts.list'],
    stage: ['parts.canvas'],
    toolbar: ['parts.layers'],
    side: ['parts.issues', 'act.submit'],
  });

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

  // 6. act@2 per-part rows still decode unchanged
  const actV2 = decodeReviewAct(
    JSON.stringify({
      ...makeActV5({}),
      schema: 'rig-review/act@2',
      value: {
        verdict: 'approved',
        parts: partImages.map(img => ({
          partId: img.path.slice('parts/'.length, -'.png'.length),
          part: { outcome: 'clean', note: '' },
          mesh: { outcome: 'clean', note: '' },
        })),
        words: 'Legacy v2 approved.',
      },
    }),
    'parts-verdict',
  );
  expect(actV2.schema).toBe('rig-review/act@2');
  assertPartsActSource(root, project, actV2);

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
});
