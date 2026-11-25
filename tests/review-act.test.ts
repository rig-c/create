import { afterEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { JOB_CHEST_LANDMARKS_ACT_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, projectComments, startJobHost, type JobComment, type JobOwnerHost, type JobVerdict } from '@rig-c/review/job-host';
import { collectItems, type Finding } from '../src/check.ts';
import { main } from '../src/cli.ts';
import { optionContext } from '../src/choices.ts';
import { directionHash, objects } from '../src/direction.ts';
import { acknowledgePublication, enqueuePublication, jobHash, JOB_BINDING_FILE, jobHostStateRoot, readAcknowledgedPublication, readWriterBinding, writePrivateJson, type WriterBinding } from '../src/job-outbox.ts';
import { currentJobIdentity, partsEnumerator, prepareLiveManifest, readPublished, readRecordPublished } from '../src/job-publication.ts';
import { assertReviewActSource, decodeReviewAct, decodeReviewResponse, fetchReviewAct, REVIEW_ACT_ACTOR_SINCE, reviewActFindings, reviewActTransport, reviewActVerbatim } from '../src/review-act.ts';
import { directionPin, existingShapes, framedRigPin, HISTORICAL_DIRECTION_VALUE, TIME_ONLY_BASIS } from './comment-anchor-shapes.ts';
import { pendingMeshDeltaRevision } from '../src/corrections.ts';
import { republishCommand } from '../src/republish.ts';
import { readVersions } from '../src/review.ts';
import { formatNext, nextProject } from '../src/next.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import { selectSignoffTarget } from '../src/signoff-target.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, checkProject, directionCommand, inputCommand, planCommand, reviewCommand, sceneCommand, signoffCommand, stepStatusCommand, testClock } from './clock.ts';
import { composeFixture, composeRunFixture } from './direction-compose-fixture.ts';
import { plantLegacyReopen, fixture } from './fixtures.ts';
import { clockedCli, staleRecordPlant, treeDigest } from './helpers.ts';
import { legacyRigPublicationCli } from './legacy-rig-publication.ts';
import { meshEdits } from './mesh-edit-fixture.ts';
import { EXAMPLE_NOW, EXAMPLE_REOPEN_AT } from '../scripts/example-time.ts';

const directories: string[] = [];
const hosts: JobOwnerHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of directories.splice(0)) {
    if (existsSync(root)) rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
  testClock.reset();
});
function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(root);
  return root;
}
function projectAt(root: string): JsonObject { return JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')); }
function putProject(root: string, value: JsonObject): void { writeFileSync(join(root, 'project.json'), `${JSON.stringify(value, null, 2)}\n`); }

function reviewVerdictReceipts(project: JsonObject): JsonObject[] {
  return (project.review_acts as JsonObject[]).filter(entry => entry.schema === 'rig-create/review-act@1'
    && typeof entry.bytes === 'string' && JSON.parse(entry.bytes).kind === 'review-verdict');
}

async function published(checkpoint = '3-rig-review', n = 1, role: 'owner' | 'delegate' = 'owner', words = '  Synthetic approval.\r\n', verdict: JobVerdict = 'approved', generation = 1, legacySubjects = false, existing?: { root: string; rigVersion: number; reader?: typeof readPublished },
  extraValue?: (root: string, source: JsonObject, publication: JsonObject) => JsonObject,
  attachable?: 'package-only' | 'record-and-package', reviewerId = 'synthetic-reviewer') {
  // Keep authored moves after the fixture and before the live host's receipts.
  if (!existing) testClock.set(EXAMPLE_REOPEN_AT);
  const root = existing?.root ?? temporary('create-act-project-');
  const versionNumber = n === 1 ? existing?.rigVersion ?? 1 : n;
  if (!existing) cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints', checkpoint), root, { recursive: true });
  if (n === 2 && !existing) {
    mkdirSync(join(root, 'inputs'), { recursive: true });
    for (const path of ['inputs/background.png', 'evidence/scene-citations.json', 'evidence/direction-input.json']) {
      cpSync(join(import.meta.dir, '../templates/example-chain', path), join(root, path));
    }
    inputCommand(['add', 'inputs/background.png', root, '--origin', 'synthetic plate']);
    sceneCommand(['write', '--rig', '1', '--background', 'inputs/background.png', '--citations-file', 'evidence/scene-citations.json', root]);
    directionCommand(['write', '2', root, '--file', 'evidence/direction-input.json', '--rig', '1']);
    advanceCommand(['direction-review', root]);
  }
  if (generation === 2) {
    prepareLiveManifest(root, { ...projectAt(root), inputs: [] }, n);
    expect(republishCommand([String(n), root, '--reason', 'Include the original painting.'], testClock.now()).exit).toBe(0);
  }
  const hidden = temporary('create-act-hidden-');
  // Existing fetch-only fixtures omit the actual host state path.
  const stateDir = join(hidden, 'relocated-state');
  const identity = currentJobIdentity({ root, stateDir, fingerprint: 'rig-create/live-review/1', reviewer: { id: reviewerId, role },
    ...(attachable === 'record-and-package' ? { publicationMode: attachable } : {}) }, root);
  let reader = existing?.reader ?? readPublished;
  if (legacySubjects) {
    const runtime = temporary('create-act-legacy-');
    legacyRigPublicationCli(runtime);
    reader = (await import(join(runtime, 'src/job-publication.ts'))).readPublished;
  }
  let writerGrant: Pick<WriterBinding, 'jobId' | 'origin' | 'fetchCapability'> | undefined;
  const host = await startJobHost({ ...identity, partsEnumerator, readPublished: reader,
    ...(attachable === 'record-and-package' ? { readRecordPublished } : {}),
    installWriterBinding: grant => {
      if (attachable) writerGrant = grant;
      else writePrivateJson(join(root, JOB_BINDING_FILE), {
        schema: 'rig-create/job-binding@1', identity: { ...identity, stateDir: 'not-given-to-writer' }, ...grant,
      }, true);
    } });
  hosts.push(host);
  if (attachable) {
    if (!writerGrant || !host.attachment) throw Error('Review did not install an attachable writer grant');
    writePrivateJson(join(root, JOB_BINDING_FILE), {
      schema: 'rig-create/job-binding@1', identity, ...writerGrant, listenerIncarnation: host.attachment.listenerIncarnation,
    }, true);
  }
  const project = projectAt(root);
  project.review_job = { jobId: host.session.jobId, origin: host.origin };
  putProject(root, project);
  const path = prepareLiveManifest(root, project, versionNumber);
  async function agent(verb: string, fields: object) {
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
      method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 'rig-review/job-api@2', verb, jobId: host.session.jobId, requestId: randomUUID(),
        expectedGeneration: host.session.status().generation, idempotencyKey: randomUUID(), ...fields }),
    }));
    const result = await response.json() as { ok: boolean; error?: { code: string }; value: JsonObject };
    expect(result.error?.code).toBeUndefined();
    expect(result.ok).toBe(true);
    return result.value;
  }
  const selector = n === 1 ? { kind: 'rig', version: versionNumber } : { kind: 'post', version: n, rigVersion: existing?.rigVersion ?? 1 };
  const entry = enqueuePublication(root, readWriterBinding(root)!, { path, selector: selector as NonNullable<Parameters<typeof enqueuePublication>[2]['selector']> });
  const publication = await agent('publish', { result: { path, selector }, freeze: { kind: 'producer-held', holdId: 'synthetic-freeze', record: { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) } } });
  const subjects = existing ? (await reader({ root, record: { path: 'project.json', sha256: entry.recordHash },
    result: entry.result as Parameters<typeof readPublished>[0]['result'] })).subjects : undefined;
  acknowledgePublication(entry, String(publication.publicationId), Number(publication.generation), 'synthetic-request', subjects);
  rmSync(join(root, '.rig-create-review/outbox'), { recursive: true });
  const stage = n === 1 ? 'rig-review' : 'direction-review';
  const ask = await agent('ask', { publicationId: publication.publicationId, subject: { kind: 'review-verdict', stage } });
  function uiRequest(route: string, value: object) {
    return new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, { method: 'POST',
      headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  }
  const displayed = await host.ports.ackDisplayed(host.session.jobId, uiRequest('displayed', { publicationId: publication.publicationId, pageId: 'synthetic-page', sourceHash: (publication.source as JsonObject).sourceHash }));
  expect(displayed.ok).toBe(true);
  if (!displayed.ok) throw Error(displayed.error.code);
  const submitted = await host.ports.commitUIAct(host.session.jobId, uiRequest('acts', {
    publicationId: publication.publicationId, askId: ask.askId, pageId: 'synthetic-page', displayedNonce: displayed.value.displayedNonce,
    expectedGeneration: host.session.status().generation, submissionId: 'synthetic-submission', kind: 'review-verdict',
    value: { stage, verdict, words, ...extraValue?.(root, publication.source as JsonObject, publication) },
    ...(n !== 1 ? {} : (() => {
      const png = readFileSync(join(root, 'evidence/setup.png'));
      return { capture: { png: `data:image/png;base64,${png.toString('base64')}`,
        width: png.readUInt32BE(16), height: png.readUInt32BE(20), camera: 'fixed', framing: 'default',
        view: 'whole-rig', frame: 'setup', playing: false,
        binding: { publicationId: publication.publicationId, instanceKey: publication.instanceKey,
          sourceHash: (publication.source as JsonObject).sourceHash, pageId: 'synthetic-page', askId: ask.askId,
          drawGeneration: 1, playerGeneration: 0 } } };
    })()),
  }));
  if (!submitted.ok) throw Error(`${submitted.error.code}: ${submitted.error.message}`);
  testClock.set(Math.max(testClock.now(), Date.parse(submitted.value.at)));
  return { root, host, act: submitted.value, hidden, n, agent, uiRequest, publication };
}

async function command(root: string, actId: string, n = 1, guarded = false, flags = ['--json'], preload?: string) {
  const guard = join(root, 'fs-guard.ts');
  if (guarded) writeFileSync(guard, `import {mock} from 'bun:test';
import fs from 'node:fs';
const methods = ['readFileSync','openSync','statSync','lstatSync','realpathSync','existsSync','readdirSync','accessSync','mkdirSync','watch'];
const originals = Object.fromEntries(methods.map(name => [name, fs[name]]));
const wrappers = Object.fromEntries(methods.map(name => [name, (...args) => {
  if (String(args[0]).includes('create-act-hidden-')) throw Error('REVIEW_STATE_ACCESSED');
  return originals[name](...args);
}]));
Object.assign(fs, wrappers);
mock.module('node:fs', () => ({...fs, ...wrappers}));
const original = Bun.spawnSync;
Bun.spawnSync = (args, options) => original([args[0], '--preload', import.meta.path, ...args.slice(1)], options);
`);
  if (guarded) {
    const planted = join(temporary('create-act-hidden-planted-'), 'file');
    const probe = Bun.spawn([process.execPath, '--preload', guard, '-e', `require('node:fs').readFileSync(${JSON.stringify(planted)})`], { stdout: 'pipe', stderr: 'pipe' });
    const [error, exit] = await Promise.all([new Response(probe.stderr).text(), probe.exited]);
    expect(exit).toBe(1); expect(error).toContain('REVIEW_STATE_ACCESSED');
  }
  const child = Bun.spawn([process.execPath, ...(guarded ? ['--preload', guard] : []), ...(preload ? ['--preload', preload] : []), ...clockedCli(), 'review', String(n), root, '--from-review', actId, ...flags], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

test('#888 signoff rig-review and handoff require acceptance of the latest live rig', async () => {
  const root = temporary('create-latest-rig-');
  const checkpoint = join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review');
  cpSync(checkpoint, root, { recursive: true });
  // Start from the retained earlier approvals and produce both rig entries with rig-version.
  const prefix = projectAt(root);
  const provenance = (prefix.versions as JsonObject[])[0]!.provenance as JsonObject;
  prefix.stage = 'rigging';
  prefix.advances = (prefix.advances as JsonObject[]).filter(move => move.stage !== 'rig-review');
  prefix.versions = [];
  putProject(root, prefix);
  for (const path of ['outputs', 'evidence/v1', 'derived/review']) rmSync(join(root, path), { recursive: true, force: true });

  const source = join(root, 'build-input');
  mkdirSync(source);
  cpSync(join(root, 'derived/drafts/chain/input'), join(source, 'parts'), { recursive: true });
  const put = (path: string, value: object): void => writeFileSync(join(source, path), JSON.stringify(value));
  cpSync(join(checkpoint, 'outputs/v1/out/rig'), join(source, 'rig'), { recursive: true });
  cpSync(join(checkpoint, String((provenance.config as JsonObject).path)), join(source, 'config.json'));
  cpSync(join(checkpoint, 'evidence/v1/interview-requirements.json'), join(source, 'interview-requirements.json'));
  put('citations.json', provenance.sections as JsonObject);
  put('adapter.json', []);
  put('toolchain.json', { lockfileVersion: 3, packages: Object.fromEntries(['@rig-c/parts', '@rig-c/core'].map(name => [`node_modules/${name}`, {
    version: JSON.parse(readFileSync(join(import.meta.dir, '../node_modules', name, 'package.json'), 'utf8')).version,
  }])) });

  testClock.set(EXAMPLE_NOW);
  const cli = (dir: string, args: string[]) => {
    const file = join(dir, 'project.json');
    const before = readFileSync(file);
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const exit = main(args, testClock.now());
      return { exit, before, after: readFileSync(file), stdout: output.mock.calls.map(call => String(call[0])).join(''),
        stderr: errors.mock.calls.map(call => String(call[0])).join('') };
    } finally { output.mockRestore(); errors.mockRestore(); }
  };
  const success = (dir: string, args: string[]) => {
    const result = cli(dir, args);
    expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: '' });
    return result;
  };
  const produce = (dir: string, n: number) => {
    testClock.set(testClock.now() + 1000);
    const core = join(import.meta.dir, '../node_modules/@rig-c/core/bin/rigc.cjs');
    const runCore = (args: string[]) => {
      const result = Bun.spawnSync([process.execPath, core, ...args], { cwd: join(dir, 'build-input'),
        env: { ...process.env, SOURCE_DATE_EPOCH: String(Math.trunc(testClock.now() / 1000)) }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
      expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
    };
    runCore(['build', '--rig', 'rig/rig.json', '--motion', 'rig/motion.json', '--out', `build-${n}`, '--profile', 'rig-play',
      '--pack', '--page-edges', 'free', '--pack-shape', 'polygon', '--report', `compile-${n}.json`]);
    runCore(['render', '--candidate', `build-${n}`, '--out', `idle-${n}`, '--animation', 'idle', '--fps', '1', '--max', '32', '--poser', 'core']);
  };
  const register = (dir: string, n: number) => {
    const inputs = { parts: 'parts', rig: 'rig', build: `build-${n}`, idle: `idle-${n}`, config: 'config.json', 'path-adapter': 'adapter.json',
      'compile-report': `compile-${n}.json`, 'toolchain-lock': 'toolchain.json', citations: 'citations.json', 'run-record': `build-${n}/run.json`, 'at-source': `build-${n}/run.json` };
    success(dir, ['rig-version', String(n), dir, ...Object.entries(inputs).flatMap(([flag, file]) => [`--${flag}`, `build-input/${file}`]),
      '--at-pointer', '/finished_at', '--by', 'registrant']);
  };
  const accept = async (dir: string, n: number) => {
    // The retained two-subject publication records a verdict without folding a signature into it.
    const view = await published('3-rig-review', 1, 'owner', 'Approve the synthetic rig.', 'approved', 1, true, { root: dir, rigVersion: n });
    expect(await command(dir, view.act.actId, n)).toMatchObject({ exit: 0, stderr: '' });
    view.host.stop();
    rmSync(join(dir, JOB_BINDING_FILE));
    testClock.set(testClock.now() + 1000);
  };
  const sign = (dir: string, n?: number) => ['signoff', 'rig-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt'),
    ...(n === undefined ? [] : ['--version', String(n)])];
  const checkRefused = (result: ReturnType<typeof cli>, code: string) => {
    expect(result.exit).toBe(1);
    expect(result.stderr).toStartWith(`rig-create: ${code}:`);
    expect(result.after.equals(result.before)).toBe(true);
  };
  const checkBlocked = (result: ReturnType<typeof cli>) => {
    checkRefused(result, 'RIG_VERSION_UNACCEPTED');
    expect(result.stderr).toContain('rig v2');
  };

  produce(root, 1);
  register(root, 1);
  success(root, ['advance', 'rig-review', root]);
  checkRefused(cli(root, sign(root)), 'SIGNOFF_TARGET_STALE');
  await accept(root, 1);
  expect((projectAt(root).signoffs as JsonObject[]).some(s => s.stage === 'rig-review')).toBe(false);
  produce(root, 2);
  const signed = temporary('create-latest-rig-signed-before-v2-');
  cpSync(root, signed, { recursive: true });
  success(signed, sign(signed, 1));
  register(signed, 2);
  register(root, 2);
  expect(readVersions(projectAt(root)).rigs).toMatchObject([
    { n: 1, live: true, accepted: { verdict: 0 } },
    { n: 2, live: true, accepted: null },
  ]);
  const staleSignoff = cli(root, sign(root));
  checkBlocked(staleSignoff);
  expect(staleSignoff.stderr).toContain('review 2 --verdict accepted --review rig-review');
  checkBlocked(cli(root, sign(root, 1)));
  checkBlocked(cli(root, ['handoff', root]));

  // #981: advance no longer waits for an acceptance; handoff still binds the accepted latest rig (#984/#985).
  success(signed, ['advance', 'post-interview', signed]);
  checkBlocked(cli(signed, ['handoff', signed]));

  await accept(root, 2);
  success(root, sign(root, 2));
  expect((projectAt(root).signoffs as JsonObject[]).find(s => s.stage === 'rig-review')).toMatchObject({ target: { version: 2 } });
  success(root, ['advance', 'post-interview', root]);
  const handoff = success(root, ['handoff', '--json', root]);
  expect(JSON.parse(handoff.stdout).rig_version).toBe(2);
  expect(handoff.after.equals(handoff.before)).toBe(true);
}, 180_000);

async function preparePublishedRigSignoff(view: Awaited<ReturnType<typeof published>>) {
  const { root, host, agent, uiRequest, publication } = view;
  const ask = await agent('ask', { publicationId: publication.publicationId, subject: { kind: 'signoff', stage: 'rig-review' } });
  const displayed = await host.ports.ackDisplayed(host.session.jobId, uiRequest('displayed', {
    publicationId: publication.publicationId, pageId: 'reopened-sign-page', sourceHash: (publication.source as JsonObject).sourceHash,
  }));
  expect(displayed.ok).toBe(true);
  if (!displayed.ok) throw Error(displayed.error.code);
  const signed = await host.ports.commitUIAct(host.session.jobId, uiRequest('acts', {
    publicationId: publication.publicationId, askId: ask.askId, pageId: 'reopened-sign-page', displayedNonce: displayed.value.displayedNonce,
    expectedGeneration: host.session.status().generation, submissionId: randomUUID(), kind: 'signoff',
    value: { stage: 'rig-review', decision: 'approved', words: 'Sign the displayed synthetic rig.' },
  }));
  expect(signed.ok).toBe(true);
  if (!signed.ok) throw Error(signed.error.code);
  testClock.set(Math.max(testClock.now(), Date.parse(signed.value.at)));
  // Finalize against the displayed record now; ingest only after its verdict is recorded.
  return async () => {
    const child = Bun.spawn([process.execPath, ...clockedCli(), 'signoff', 'rig-review', root,
      '--from-review', signed.value.actId, '--json'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
}

/** Keep a real v1 Review receipt and signature through reopen; seed only the new synthetic build declaration. */
async function reopenedRig(legacySubjects = false) {
  const first = await published('3-rig-review', 1, 'owner', 'Approve the first synthetic rig.', 'approved', 1, true);
  const seed = structuredClone((projectAt(first.root).versions as JsonObject[])[0]!);
  const signFirst = await preparePublishedRigSignoff(first);
  expect(await command(first.root, first.act.actId)).toMatchObject({ exit: 0, stderr: '' });
  expect(await signFirst()).toMatchObject({ exit: 0, stderr: '' });
  const history = projectAt(first.root);
  expect(reviewActFindings(history)).toEqual([]);
  testClock.set(testClock.now() + 1);
  plantLegacyReopen(first.root, 'rig-review', { by: 'user', wordsFile: join(first.root, 'evidence/approval.txt') });
  const reopened = projectAt(first.root);
  const lapseCodes = checkProject(first.root).warnings.map(f => f.code);
  expect(lapseCodes).toContain('REOPEN_SIGNOFF_LAPSED');
  expect(lapseCodes).toContain('REOPEN_VERDICT_LAPSED');
  expect(reopened.signoffs).toEqual(history.signoffs);
  expect(reopened.review_acts).toEqual(history.review_acts);
  // Like the chain fixture's declared build seed, reuse frozen synthetic producer bytes.
  // This tests review/signoff, not the separate frozen-rig registration contract.
  testClock.set(testClock.now() + 1);
  const second: JsonObject = { ...seed, n: 2, at: testClock.iso(), changed: 'Synthetic build after reopening rig-review.', verdicts: [] };
  delete second.review_package;
  reopened.versions = [...reopened.versions as JsonObject[], second];
  putProject(first.root, reopened);
  const config = (second.provenance as JsonObject).config as JsonObject;
  const from = (seed.review_package as JsonObject).from as string;
  expect(reviewPackageCommand(['2', first.root, '--config', String(config.path), '--from', from]).exit).toBe(0);
  const current = await published('3-rig-review', 1, 'owner', 'Approve the replacement synthetic rig.', 'approved', 1, legacySubjects,
    { root: first.root, rigVersion: 2 });
  expect(current.act.source.selector).toEqual({ kind: 'rig', version: 2 });
  expect(Date.parse(String((projectAt(first.root).versions as JsonObject[])[1]!.at)))
    .toBeGreaterThan(Date.parse(String((reopened.reopens as JsonObject[]).at(-1)!.at)));
  return { ...current, history };
}

for (const separate of [false, true]) test(`#578 reopened v2 ${separate ? 'separate signoff' : 'one-subject folded approval'} preserves v1 ledger and signs the current rig`, async () => {
  const view = await reopenedRig(separate);
  const { root, act, history } = view;
  const before = projectAt(root);
  const subjects = readAcknowledgedPublication(root, act.jobId, act.publicationId)!.subjects;
  expect(subjects).toEqual(separate
    ? [{ kind: 'review-verdict', stage: 'rig-review' }, { kind: 'signoff', stage: 'rig-review' }]
    : [{ kind: 'review-verdict', stage: 'rig-review' }]);
  const signSecond = separate ? await preparePublishedRigSignoff(view) : null;
  expect(await command(root, act.actId, 2)).toMatchObject({ exit: 0, stderr: '' });
  if (signSecond) {
    expect(projectAt(root).signoffs).toEqual(before.signoffs);
    expect(await signSecond()).toMatchObject({ exit: 0, stderr: '' });
  }
  const saved = projectAt(root);
  expect((saved.versions as JsonObject[])[0]).toEqual((history.versions as JsonObject[])[0]);
  expect((saved.signoffs as JsonObject[]).slice(0, -1)).toEqual(history.signoffs as JsonObject[]);
  expect((saved.review_acts as JsonObject[]).slice(0, (history.review_acts as JsonObject[]).length)).toEqual(history.review_acts as JsonObject[]);
  expect((saved.signoffs as JsonObject[]).at(-1)).toMatchObject({ stage: 'rig-review', target: {
    version: 2, verdict: 'versions[1].verdicts[0]', review_package: { path: 'versions[1].review_package' },
  } });
  expect((saved.versions as JsonObject[])[1]!.verdicts).toEqual([expect.objectContaining({ review: 'rig-review', verdict: 'accepted' })]);
  expect(reviewActFindings(saved)).toEqual([]);
  expect(checkProject(root).refusals.map(f => f.code)).toEqual([]);
  const next = nextProject(root, testClock.now());
  expect(next.moves.some(move => move.command?.startsWith('rig-create advance post-interview'))).toBe(true);
  expect(next.moves.some(move => move.review_act?.stage === 'rig-review' && move.review_act.kind === 'signoff')).toBe(false);
  const bytes = readFileSync(join(root, 'project.json'));
  expect(await command(root, act.actId, 2)).toMatchObject({ exit: 0, stderr: '' });
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
}, 15_000);

test('#578 tampered reopened v2 package refuses folded approval before writing verdict or signature', async () => {
  const { root, act } = await reopenedRig();
  const before = readFileSync(join(root, 'project.json'));
  writeFileSync(join(root, 'derived/review/v2/out/rig/rig.json'), '{}\n');
  expect(checkProject(root).refusals.map(f => [f.code, f.path])).toContainEqual(['REVIEW_PACKAGE_CHANGED', 'versions[v2].review_package']);
  const result = await command(root, act.actId, 2);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}, 15_000);

test('#578 signoff target isolates an older package finding and still refuses a target package finding', async () => {
  const { root } = await reopenedRig(true);
  const candidate = projectAt(root);
  const versions = candidate.versions as JsonObject[];
  versions[1]!.verdicts = [{ review: 'rig-review', verdict: 'accepted', by: 'user', at: testClock.iso(), verbatim: 'Synthetic target approval.' }];
  // Call target selection directly: full writers also validate unrelated history as their own gate.
  // Alter a retained package file, not the version record hashed by the v1 act ledger.
  writeFileSync(join(root, 'derived/review/v1/out/rig/rig.json'), '{}\n');
  const before = readFileSync(join(root, 'project.json'));
  expect(checkProject(root, candidate).refusals.map(f => [f.code, f.path]))
    .toContainEqual(['REVIEW_PACKAGE_CHANGED', 'versions[v1].review_package']);
  expect(selectSignoffTarget(root, candidate, 'rig-review', '2')).toMatchObject({ version: 2, verdict: 'versions[1].verdicts[0]' });
  expect(selectSignoffTarget(root, candidate, 'rig-review')).toMatchObject({ version: 2 });
  writeFileSync(join(root, 'derived/review/v2/out/rig/rig.json'), '{}\n');
  expect(checkProject(root, candidate).refusals.map(f => [f.code, f.path]))
    .toContainEqual(['REVIEW_PACKAGE_CHANGED', 'versions[v2].review_package']);
  expect(() => selectSignoffTarget(root, candidate, 'rig-review', '2'))
    .toThrow(expect.objectContaining({ code: 'SIGNOFF_TARGET_STALE' }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}, 15_000);

test('producer-bound rig verdict fetch commits once, preserves words, and unchanged replay reports its existing record', async () => {
  const { root, act } = await published();
  const before = projectAt(root);
  const first = await command(root, act.actId);
  expect(first.stderr).toBe(''); expect(first.exit).toBe(0);
  const bytes = readFileSync(join(root, 'project.json'));
  const project = projectAt(root);
  const receipt = reviewVerdictReceipts(project)[0]!;
  expect(JSON.parse(String(receipt.bytes))).toEqual(act);
  expect(receipt.sha256).toBe(jobHash(String(receipt.bytes)));
  const verdict = ((project.versions as JsonObject[])[0].verdicts as JsonObject[]).at(-1)!;
  expect(verdict.verbatim).toBe('[general]\n  Synthetic approval.\r\n');
  expect(verdict.by).toBe('user'); expect(verdict.at).toBe(act.at);
  expect(project.signoffs).toEqual(before.signoffs); expect(project.stage).toBe(before.stage);
  expect(reviewActFindings(project)).toEqual([]);
  expect(checkProject(root, project).refusals).toEqual([]);
  expect(checkProject(root, project).warnings).toEqual([]);
  const replay = await command(root, act.actId);
  expect(replay.exit).toBe(0); expect(replay.stdout).toBe(first.stdout);
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
});

test('review verdict ingestion skips earlier interview receipts in the same job', async () => {
  const { root, act } = await published();
  const project = projectAt(root);
  const answer = collectItems(project, { collection: null }).find(item => item.id === 'reference')!.raw as JsonObject;
  const choice = answer.choice as JsonObject;
  const binding = choice.set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(binding.path)), 'utf8'));
  const interview = { schema: 'rig-review/act@2', kind: 'interview-picks', jobId: act.jobId,
    actId: 'interview-before-verdict', askId: 'interview-ask', publicationId: act.publicationId,
    at: answer.at, authority: act.authority,
    source: { ...act.source, optionSet: { id: set.id, sha256: binding.sha256 } },
    value: { questionId: 'reference', selections: (choice.picks as JsonObject[]).map(pick => ({
      itemId: pick.ask, optionId: pick.option_id, otherText: pick.other_text ?? null,
    })), note: choice.note ?? '' },
  };
  const bytes = JSON.stringify(interview);
  project.review_acts = [{ schema: 'rig-create/review-act@1', kind: 'interview-picks',
    jobId: act.jobId, actId: interview.actId, question: 'reference', bytes, sha256: jobHash(bytes),
    version_hash: jobHash(JSON.stringify(choice)) }];
  expect(reviewActFindings(project)).toEqual([]);
  putProject(root, project);
  const result = await command(root, act.actId);
  expect(result.stderr).toBe(''); expect(result.exit).toBe(0);
  const recorded = projectAt(root);
  expect(recorded.review_acts as JsonObject[]).toHaveLength(2);
  expect(reviewActFindings(recorded)).toEqual([]);
});

test('review verdict ingestion skips earlier checkpoint receipts in the same job', async () => {
  const { root, act } = await published();
  const project = projectAt(root);
  const signoffs = project.signoffs as JsonObject[];
  const index = signoffs.findIndex(signoff => typeof signoff.checkpoint === 'string');
  const signed = signoffs[index];
  const checkpoint = { schema: 'rig-review/act@2', kind: 'checkpoint', jobId: act.jobId,
    actId: 'checkpoint-before-verdict', askId: 'checkpoint-ask', publicationId: act.publicationId,
    at: signed.at, authority: act.authority,
    source: { ...act.source, plan: { steps: ((project.plan as JsonObject).steps as JsonObject[]).map(step => ({ id: step.id, hash: stepHash(step) })) } },
    value: { checkpointId: signed.checkpoint, planStepId: signed.checkpoint, outcome: 'pass', words: signed.verbatim },
  };
  signed.source = `review act ${act.jobId}/${checkpoint.actId}`;
  const bytes = JSON.stringify(checkpoint);
  const step = ((project.plan as JsonObject).steps as JsonObject[]).find(entry => entry.id === signed.checkpoint)!;
  project.review_acts = [...(project.review_acts as JsonObject[]), { schema: 'rig-create/review-act@1', kind: 'checkpoint',
    jobId: act.jobId, actId: checkpoint.actId, checkpoint: signed.checkpoint, signoff: index, bytes, sha256: jobHash(bytes), version_hash: stepHash(step) }];
  expect(reviewActFindings(project)).toEqual([]);
  putProject(root, project);
  const result = await command(root, act.actId);
  expect(result.stderr).toBe(''); expect(result.exit).toBe(0);
  expect(reviewActFindings(projectAt(root))).toEqual([]);
});

test('replay after a displayed source change refuses REVIEW_ACT_SOURCE_STALE with record bytes identical', async () => {
  const { root, act } = await published();
  expect((await command(root, act.actId)).exit).toBe(0);
  const before = readFileSync(join(root, 'project.json'));
  writeFileSync(join(root, act.source.model!.path), '{}\n');
  const replay = await command(root, act.actId);
  expect(replay.exit).toBe(1); expect(replay.stderr.trim()).toContain('REVIEW_ACT_SOURCE_STALE:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
});

test('API and act schemas, @1, enumerator range and unsupported kinds have distinct named refusals', async () => {
  const { act: native } = await published();
  const act = { ...native, schema: 'rig-review/act@3', value: { stage: 'rig-review', verdict: 'approved', words: 'Synthetic approval' } };
  for (const enumeratorVersion of ['3.0.0', '3.7.0', '4.0.0']) {
    expect(() => decodeReviewAct(JSON.stringify({ ...native, source: { ...native.source, parts: { ...native.source.parts, enumeratorVersion } } })))
      .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
  }
  const response = (value: object, schema = 'rig-review/job-api@2') => JSON.stringify({ schema, verb: 'fetch-act', jobId: act.jobId, requestId: 'request', ok: true, value });
  expect(() => decodeReviewResponse(response(act, 'rig-review/job-api@1'), act.jobId, act.actId, 'request')).toThrow(expect.objectContaining({ code: 'REVIEW_API_SCHEMA_UNSUPPORTED' }));
  expect(() => decodeReviewAct(JSON.stringify({ ...act, schema: 'rig-review/act@1' }))).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SCHEMA_UNSUPPORTED' }));
  for (const enumeratorVersion of ['2.25.0', '2.36.0', '3.0.0', '3.7.0']) {
    expect(decodeReviewAct(JSON.stringify({ ...act, source: { ...act.source, parts: { ...act.source.parts, enumeratorVersion } } })).source.parts?.enumeratorVersion).toBe(enumeratorVersion);
  }
  for (const enumeratorVersion of ['2.24.9', '4.0.0', '2.25.0-beta.1', '3.7.0-beta.1', 'absent']) {
    expect(() => decodeReviewAct(JSON.stringify({ ...act, source: { ...act.source, parts: { ...act.source.parts, enumeratorVersion } } }))).toThrow(expect.objectContaining({ code: 'REVIEW_PARTS_ENUMERATOR_UNSUPPORTED' }));
  }
  expect(() => decodeReviewAct(JSON.stringify({ ...act, kind: 'signoff' }))).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_KIND_MISMATCH' }));
});

test('competing human-value flags refuse before fetching or writing', async () => {
  const { root, act } = await published();
  const before = readFileSync(join(root, 'project.json'));
  for (const flag of ['--by', '--verdict', '--review', '--verbatim', '--verbatim-file', '--at', '--source', '--item', '--answers-feedback', '--ask', '--quote', '--value']) {
    const value = flag === '--answers-feedback' ? '1:0' : flag === '--ask' || flag === '--quote' ? 'a=b' : flag === '--value' ? 'a=null' : 'synthetic';
    expect(() => reviewCommand(['1', root, '--from-review', act.actId, flag, value])).toThrow(expect.objectContaining({ code: 'REVIEW_OPTION_INVALID' }));
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  }
});

test('check detects tampered ledger bytes, verdict, duplicate identity and malformed records', async () => {
  const { root, act } = await published();
  expect((await command(root, act.actId)).exit).toBe(0);
  const project = projectAt(root);
  const entry = reviewVerdictReceipts(project)[0]!;
  entry.sha256 = '0'.repeat(64);
  expect(checkProject(root, project).refusals.map(f => f.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
  entry.sha256 = jobHash(String(entry.bytes));
  (project.review_acts as JsonObject[]).push(structuredClone(entry));
  expect(reviewActFindings(project).map(f => f.code)).toContain('REVIEW_ACT_REPLAY_CONFLICT');
  project.review_acts = {};
  expect(reviewActFindings(project)[0].code).toBe('REVIEW_ACT_LEDGER_INVALID');
});

test('producer-bound post verdict uses the displayed post selector and keeps signoff and stage separate', async () => {
  const { root, act, n } = await published('4-direction-post', 2);
  const before = projectAt(root);
  const result = await command(root, act.actId, n);
  expect(result.stderr).toBe(''); expect(result.exit).toBe(0);
  const project = projectAt(root);
  const post = (project.versions as JsonObject[]).find(v => v.n === n)!;
  expect((post.verdicts as JsonObject[]).at(-1)!.review).toBe('direction-review');
  expect(project.signoffs).toEqual(before.signoffs); expect(project.stage).toBe(before.stage);
  expect(reviewActFindings(project)).toEqual([]);
});

test('version metadata changed before first ingest refuses with an acknowledged receipt and preserves bytes', async () => {
  const { root, act } = await published();
  const project = projectAt(root);
  (project.versions as JsonObject[])[0].changed = 'Synthetic metadata changed after publication';
  putProject(root, project);
  const before = readFileSync(join(root, 'project.json'));
  const result = await command(root, act.actId);
  expect(result.exit).toBe(1); expect(result.stderr.trim()).toContain('REVIEW_ACT_SOURCE_STALE:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
});

test('missing acknowledgment permits explicit bindings with a named ingest warning and pins later metadata', async () => {
  const { root, act } = await published();
  rmSync(join(root, '.rig-create-review/acknowledged-publications'), { recursive: true });
  const project = projectAt(root);
  (project.versions as JsonObject[])[0].changed = 'Synthetic metadata without retained acknowledgment';
  putProject(root, project);
  const result = await command(root, act.actId);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).warnings[0]).toStartWith('REVIEW_ACT_VERSION_UNVERIFIED:');
  const next = projectAt(root);
  (next.versions as JsonObject[])[0].changed = 'Synthetic later metadata change';
  putProject(root, next);
  const before = readFileSync(join(root, 'project.json'));
  const replay = await command(root, act.actId);
  expect(replay.stderr.trim()).toContain('REVIEW_ACT_SOURCE_STALE:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
});

test('a later unrelated signoff does not stale an act through projectHash provenance', async () => {
  const { root, act } = await published();
  signoffCommand(['parts', root, '--checkpoint', 'assemble', '--by', 'user', '--verbatim-file', join(root, 'evidence/approval.txt')]);
  expect(jobHash(readFileSync(join(root, 'project.json')))).not.toBe(act.source.projectHash!);
  const result = await command(root, act.actId);
  expect(result.stderr).toBe(''); expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).warnings).toBeUndefined();
});

test('writer fetches through the grant with relocated Review state never supplied or accessed', async () => {
  const { root, act, hidden } = await published();
  const binding = readFileSync(join(root, JOB_BINDING_FILE), 'utf8');
  expect(binding).not.toContain(hidden);
  const result = await command(root, act.actId, 1, true);
  expect(result.stderr).toBe(''); expect(result.exit).toBe(0);
  expect(reviewActFindings(projectAt(root))).toEqual([]);
});

test('unsupported fetched schemas and enumerator refuse at the CLI before any record mutation', async () => {
  const { root, act, host } = await published();
  let planted: 'act' | 'enumerator' = 'act';
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${act.jobId}/api`, request));
    const value = await response.json() as { schema: string; source: { parts: { enumeratorVersion: string } }; value: JsonObject };
    // This control exercises the legacy decoder's named unsupported-enumerator refusal.
    value.schema = 'rig-review/act@3';
    value.value = { stage: 'rig-review', verdict: 'approved', words: 'Synthetic approval' };
    if (planted === 'act') value.schema = 'rig-review/act@1';
    if (planted === 'enumerator') value.source.parts.enumeratorVersion = '4.0.0';
    return Response.json(value);

  } });
  try {
    const binding = readWriterBinding(root)!;
    binding.origin = `http://127.0.0.1:${proxy.port}`;
    writePrivateJson(join(root, JOB_BINDING_FILE), binding, true);
    const project = projectAt(root);
    (project.review_job as JsonObject).origin = binding.origin;
    putProject(root, project);
    const before = readFileSync(join(root, 'project.json'));
    const controls = { act: 'REVIEW_ACT_SCHEMA_UNSUPPORTED', enumerator: 'REVIEW_PARTS_ENUMERATOR_UNSUPPORTED' } as const;
    for (const [kind, code] of Object.entries(controls)) {
      planted = kind as typeof planted;
      const result = await command(root, act.actId);
      expect(result.exit).toBe(1); expect(result.stderr).toContain(`${code}:`);
      expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    }
  } finally { proxy.stop(true); }
});

test('a new act on a changed explicit source refuses before its first write', async () => {
  const { root, act } = await published();
  const before = readFileSync(join(root, 'project.json'));
  writeFileSync(join(root, act.source.parts!.manifest.path), '{}\n');
  testClock.set(Date.parse(act.at) - 1000);
  const futureResult = await command(root, act.actId);
  expect(futureResult.exit).toBe(1); expect(futureResult.stderr).toContain('REVIEW_ACT_INVALID:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  testClock.set(Date.parse(act.at));
  const result = await command(root, act.actId);
  expect(result.exit).toBe(1); expect(result.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
});

test('concurrent consumers keep one verdict and retry reports the same receipt', async () => {
  const { root, act } = await published();
  const results = await Promise.all([command(root, act.actId), command(root, act.actId)]);
  expect(results.some(result => result.exit === 0)).toBe(true);
  for (const result of results) if (result.exit) expect(result.stderr).toContain('JOB_WRITE_BUSY:');
  const before = readFileSync(join(root, 'project.json'));
  expect((await command(root, act.actId)).exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(reviewVerdictReceipts(projectAt(root)).length).toBe(1);
});

test('host-attested delegate and blank-note omission survive the public writer', async () => {
  for (const words of ['', '  \r\n']) {
    const { root, act } = await published('3-rig-review', 1, 'delegate', words);
    const result = await command(root, act.actId);
    expect(result.exit).toBe(0);
    expect(act).toMatchObject({ schema: JOB_COMMENTS_ACT_SCHEMA, value: { comments: [] } });
    const verdict = JSON.parse(result.stdout).verdict;
    expect(verdict.by).toBe('delegate'); expect(verdict.verbatim).toBe(words.trim() ? `[general]\n${words}` : '');
    const receipt = reviewVerdictReceipts(projectAt(root))[0]!;
    expect(JSON.parse(String(receipt.bytes)).authority.reviewer).toEqual({ id: 'synthetic-reviewer', role: 'delegate' });
  }
});

test('changes-requested records a bounced verdict with exact words and the normal open-feedback warning', async () => {
  const words = '  Synthetic changes requested.\r\nKeep the declared timing.\n';
  const { root, act } = await published('3-rig-review', 1, 'owner', words, 'changes-requested');
  const before = projectAt(root);
  const result = await command(root, act.actId);
  expect(result.stderr).toBe(''); expect(result.exit).toBe(0);
  const recorded = JSON.parse(result.stdout);
  expect(recorded.verdict.verdict).toBe('bounced');
  expect(recorded.verdict.verbatim).toBe(`[general]\n${words}`);
  expect(recorded.verdict.by).toBe('user');
  const project = projectAt(root);
  expect(project.stage).toBe(before.stage);
  expect(project.signoffs).toEqual(before.signoffs);
  const receipt = reviewVerdictReceipts(project)[0]!;
  expect(JSON.parse(String(receipt.bytes))).toEqual(act);
  expect(receipt.sha256).toBe(jobHash(String(receipt.bytes)));
  expect(reviewActFindings(project)).toEqual([]);
  const report = checkProject(root, project);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(finding => finding.code)).toEqual(['FEEDBACK_OPEN']);
});

test('#664 keeps the context Review emits in act@7 while recording the signed scalar words', async () => {
  const text = '  Synthetic marked feedback.  ';
  const camera = { space: 'world' as const, center: { x: 0, y: 0 }, zoom: 1, viewport: { width: 100, height: 100 },
    visible: { x: -50, y: -50, width: 100, height: 100 } };
  const frame = { index: 3, basis: 'producer' as const };
  const region = { x: 0, y: 0, width: 0, height: 0 };
  const { root, host, act } = await published('3-rig-review', 1, 'owner', '', 'changes-requested', 1, false, undefined, (root, source) => {
    const png = readFileSync(join(root, 'evidence/setup.png'));
    const sha256 = jobHash(png);
    const sourceHash = source.sourceHash!;
    const modelHash = (source.model as JsonObject).sha256!;
    return { feedback: [{
      id: 'synthetic-mark', frameStart: 3, frameEnd: 3, category: 'defect', summary: text,
      target: { kind: 'rig', name: (source.package as JsonObject).id! },
      context: { time: 0.25, frame: 3, animation: null, interval: { frameStart: 3, frameEnd: 3, inclusive: true }, comment: {
        schema: 'rig-review-comment/1', mode: 'animate', viewport: 'rig', frame, time: 0.25, animation: null,
        sourceHash, modelHash, referenceId: null, referenceHash: null, camera, screen: { ...region, x: 50, y: 50 }, world: region, slots: [],
        crop: { path: `comment-crops/${sha256}.png`, sha256, png: `data:image/png;base64,${png.toString('base64')}`,
          width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
        bookmark: { schema: 'rig-review-inspection/1', binding: { mode: 'single', sourceHash, rigs: [modelHash] },
          time: 0.25, animation: null, theme: 'dark', layers: { images: true, meshes: false, bones: false },
          view: { schema: 'rig-review-view/1', cameras: { rig: camera, a: null, b: null, reference: null } },
          selection: { inspector: 'playback' } },
      } },
    }] };
  });
  expect(act.schema).toBe('rig-review/act@7');
  const result = await command(root, act.actId);
  expect(result.stderr).toBe('');
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).verdict.verbatim).toContain(text);
  const project = projectAt(root);
  const receipt = reviewVerdictReceipts(project)[0]!;
  expect(receipt.bytes).toBe(host.session.readActExport(act.actId, false).toString('utf8'));
  const recorded = decodeReviewAct(String(receipt.bytes));
  if (recorded.schema !== 'rig-review/act@7') throw Error(recorded.schema);
  expect(recorded.value.comments[0]?.context).toEqual({
    subject: { ask: { kind: 'review-verdict', stage: 'rig-review' }, sourceHash: act.source.sourceHash, selector: { kind: 'rig', version: 1 } },
    mode: 'animate', tab: 'playback', region, camera, frame,
  });
  const diagnostics = checkProject(root, project);
  expect(diagnostics.refusals).toEqual([]);
  expect(diagnostics.warnings.map(finding => finding.code)).toEqual(['FEEDBACK_OPEN']);
  const before = readFileSync(join(root, 'project.json'));
  expect((await command(root, act.actId)).exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
});

test('#664 ingests Review mesh-only Request changes with a sized provenance config and replays without a second revision', async () => {
  testClock.set(EXAMPLE_REOPEN_AT);
  const root = temporary('create-mesh-act-project-');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), root, { recursive: true });
  const initial = projectAt(root);
  const provenance = (initial.versions as JsonObject[])[0]!.provenance as JsonObject;
  const { path, sha256 } = provenance.config as JsonObject;
  const config = { path, sha256, bytes: readFileSync(join(root, String(path))).length };
  provenance.config = config;
  putProject(root, initial);
  let sent: JsonObject[] = [];
  const { host, act } = await published('3-rig-review', 1, 'delegate', '', 'changes-requested', 1, false, { root, rigVersion: 1 }, (root, source) => {
    sent = meshEdits(root, source);
    return { meshEdits: sent };
  });
  expect(act.schema).toBe('rig-review/act@8');
  const bytes = host.session.readActExport(act.actId, false).toString('utf8');
  const decoded = decodeReviewAct(bytes);
  expect(decoded.value).toMatchObject({ verdict: 'changes-requested', meshEdits: sent, comments: [] });
  const result = await command(root, act.actId);
  expect(result.stderr).toBe('');
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).bust_landmark_commands).toBeUndefined();
  expect(JSON.parse(result.stdout).verdict).toMatchObject({ verdict: 'bounced', by: 'delegate', verbatim: '' });
  const project = projectAt(root);
  expect(reviewVerdictReceipts(project)[0]?.bytes).toBe(bytes);
  const corrections = project.corrections as JsonObject[];
  expect(corrections).toHaveLength(1);
  expect(((project.versions as JsonObject[])[0]!.provenance as JsonObject).config).toEqual(config);
  expect((corrections[0]!.on as JsonObject).config).toEqual({ path, sha256 });
  const revision = pendingMeshDeltaRevision(project)!;
  expect(revision.sourceVersion).toBe(1);
  expect(revision.revision).toMatch(/^derived\/mesh-delta-.*\/1$/);
  expect(corrections[0]).toMatchObject({
    source: `review act ${act.jobId}/${act.actId}`, by: 'delegate', verbatim: null,
    artifact: { kind: 'mesh-delta', payloadSha256: sent[0]!.sha256 },
    outcome: { revision: revision.revision, provenance: { request: { edit: sent[0]!.edit } } },
  });
  expect(readFileSync(join(root, revision.revision, 'rig.json'))).not.toEqual(readFileSync(join(root, 'derived/review/v1/out/rig/rig.json')));
  expect(checkProject(root, project).refusals).toEqual([]);
  expect(reviewActFindings({ ...project, corrections: [] }).map(finding => finding.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
  const before = readFileSync(join(root, 'project.json'));
  const dirs = readdirSync(join(root, 'derived'));
  expect((await command(root, act.actId)).exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(readdirSync(join(root, 'derived'))).toEqual(dirs);
}, 90_000);

test('#773 a version ingest refused after its evidence write leaves the project tree as it was', async () => {
  const { root, act } = await published('3-rig-review', 1, 'owner', 'Request a synthetic change.', 'changes-requested');
  const record = join(root, 'project.json');
  const original = readFileSync(record);
  const before = treeDigest(root);
  const refused = await command(root, act.actId, 1, false, ['--json'], staleRecordPlant(temporary('create-version-plant-'), record, '.act.json'));
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toMatch(/\bREVIEW_ACT_SOURCE_STALE:/);
  writeFileSync(record, original);
  expect(treeDigest(root)).toEqual(before);
  const ingested = await command(root, act.actId);
  expect({ exit: ingested.exit, stderr: ingested.stderr }).toEqual({ exit: 0, stderr: '' });
  // The still is new, so the refused call had written it. Its directory is evidence/v1, which
  // registration made; the draft test covers a refused call that made the directory too.
  const still = String(((projectAt(root).versions as JsonObject[])[0]!.evidence as JsonObject[])[0]!.path);
  expect([before.has(still), before.has(`${dirname(still)}/`)]).toEqual([false, true]);
});

const workingConfig = "working/owner's config.json";
const frozenConfig = 'evidence/v1/config-source.json';
const portableConfig = 'derived/review/v1/config.json';

async function publishedChest(mixed = false, mode: 'package-only' | 'record-and-package' = 'package-only') {
  testClock.set(EXAMPLE_REOPEN_AT);
  const root = temporary('create-chest-act-');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), root, { recursive: true });
  const project = projectAt(root);
  const version = (project.versions as JsonObject[])[0]!;
  const pkg = version.review_package as JsonObject;
  const config = JSON.parse(readFileSync(join(root, portableConfig), 'utf8'));
  const bust = { alpha: 0.25, apex_l: [74, 44], apex_r: [54, 44], bone_l: 'body', bone_r: 'body', cleavage: [64, 44] };
  // The existing torso mesh supplies the displayed attachment. Adding a bust spec
  // to this synthetic config exercises Review's actual seed and act contract.
  const { r, segments } = config.meshes.torso;
  config.meshes.torso = { r, segments, contour: { tolerance: 1, margin: 1, spacing: 4, bust } };
  const portable = JSON.stringify(config, null, 2) + '\n';
  const working = JSON.stringify(config) + '\n';
  const sha256 = jobHash(working);
  mkdirSync(join(root, 'working'));
  for (const path of [workingConfig, frozenConfig]) writeFileSync(join(root, path), working);
  for (const path of [portableConfig, 'evidence/v1/config.json']) writeFileSync(join(root, path), portable);
  version.registration = { config_source: { path: frozenConfig, sha256 } };
  const configPath = 'evidence/v1/config.json';
  const configSeal = { path: configPath, sha256: jobHash(portable) };
  (version.provenance as JsonObject).config = { ...configSeal, bytes: Buffer.byteLength(portable) };
  pkg.config = configSeal;
  (pkg.files as JsonObject[]).find(row => row.path === 'config.json')!.sha256 = configSeal.sha256;
  putProject(root, project);

  let withSeed = true;
  const reader: typeof readPublished = async input => {
    const context = await readPublished(input);
    if (withSeed) return context;
    const { chestLandmarks: _, ...withoutSeed } = context;
    return withoutSeed;
  };
  const publishChestVersion = (n: number) => published('3-rig-review', 1, 'owner', '', 'changes-requested', 1, false,
    { root, rigVersion: n, reader }, (root, source, publication) => {
      const seeds = publication.chestLandmarks as JsonObject[];
      expect(seeds).toHaveLength(1);
      expect(seeds[0]!.source).toMatchObject({ configHash: configSeal.sha256 });
      const seed = seeds[0]!;
      const { frame, hash } = seed.source as JsonObject;
      const { height, width } = frame as JsonObject;
      // In canonical key order for Review's own request digest.
      const edit = { attachment: seed.attachment, basis: 'setup',
        bust: { ...bust, apex_l: [75, 44] },
        skin: seed.skin, slot: seed.slot, source: { frame: { height, width }, hash } };
      return { chestLandmarks: [{ edit, sha256: jobHash(JSON.stringify(edit)) }], ...(mixed ? { meshEdits: meshEdits(root, source) } : {}) };
    }, mode);
  const view = await publishChestVersion(1);
  expect(view.act.schema).toBe(JOB_CHEST_LANDMARKS_ACT_SCHEMA);
  async function publishWithoutSeed() {
    withSeed = false;
    const path = prepareLiveManifest(root, projectAt(root), 1);
    return view.agent('publish', { result: { path, selector: { kind: 'rig', version: 1 } },
      freeze: { kind: 'producer-held', holdId: 'synthetic-later-freeze', record: { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) } } });
  }
  return { ...view, working, sha256, publishWithoutSeed, publishChestVersion };
}

function treeSnapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        entries[path] = 'directory';
        walk(path);
      } else {
        entries[path] = entry.isSymbolicLink() ? `link:${readlinkSync(join(root, path))}` : jobHash(readFileSync(join(root, path)));
      }
    }
  }
  walk('');
  return entries;
}

test.each(['package-only', 'record-and-package'] as const)('#774 retains act@9 from a %s host and prints the same two commands on replay and next', async mode => {
  const { root, host, act, working, sha256, publishWithoutSeed } = await publishedChest(false, mode);
  const later = await publishWithoutSeed();
  expect(later.publicationId).not.toBe(act.publicationId);
  expect(later.chestLandmarks).toBeUndefined();
  expect((later.source as JsonObject).sourceHash).not.toBe(act.source.sourceHash);
  const exported = host.session.readActExport(act.actId, false);
  const digest = jobHash(exported);
  const base = `evidence/v1/${digest}`;
  const actPath = `${base}.act.json`;
  const configArg = "'working/owner'\\''s config.json'";
  const commands = [
    `rig-parts bust-landmarks --from-act ${actPath} --parts outputs/v1/out --config ${configArg} --out ${base}.bust-landmarks.json --write-config`,
    `rig-parts propose --parts outputs/v1/out --source inputs/painting.png --out ${base}.bust-proposal --write-config ${configArg} --bust-landmarks ${base}.bust-landmarks.json`,
  ];
  const result = await command(root, act.actId, 1, false, ['--config', workingConfig]);
  expect(result.stderr).toBe('');
  expect(result.exit).toBe(0);
  expect(result.stdout.trim().split('\n').slice(-2)).toEqual(commands);
  const receipt = reviewVerdictReceipts(projectAt(root))[0]!;
  expect(receipt).toMatchObject({ bytes: exported.toString('utf8'), sha256: digest, bust_config: { path: workingConfig, sha256 } });
  expect(readFileSync(join(root, actPath))).toEqual(Buffer.from(exported));
  expect(readFileSync(join(root, workingConfig), 'utf8')).toBe(working);
  expect(readFileSync(join(root, frozenConfig), 'utf8')).toBe(working);
  expect(reviewActFindings(projectAt(root))).toEqual([]);
  expect(nextProject(root, testClock.now()).bust_landmark_commands).toEqual(commands);
  expect(formatNext(nextProject(root, testClock.now())).split('\n').filter(line => line.startsWith('rig-parts '))).toEqual(commands);
  writeFileSync(join(root, workingConfig), working.replace('0.25', '0.5'));
  // The fetch grant still works. A replay that attempts the first-ingest attach
  // again will fail because this fixture no longer has a listener incarnation.
  writePrivateJson(join(root, JOB_BINDING_FILE), { ...readWriterBinding(root)!, listenerIncarnation: '' }, true);
  const before = treeSnapshot(root);
  const replay = await command(root, act.actId);
  expect(replay.stderr).toBe('');
  expect(replay.exit).toBe(0);
  expect(JSON.parse(replay.stdout).warnings).toEqual([expect.stringContaining('REVIEW_ACT_BUST_REPLAY')]);
  expect(JSON.parse(replay.stdout).bust_landmark_commands).toEqual(commands);
  expect(nextProject(root, testClock.now()).bust_landmark_commands).toEqual(commands);
  expect(treeSnapshot(root)).toEqual(before);
  writeFileSync(join(root, actPath), Buffer.concat([exported, Buffer.from('\n')]));
  const next = nextProject(root, testClock.now());
  expect(next.bust_landmark_commands).toBeUndefined();
  expect(next.refusals.some(finding => finding.code === 'REVIEW_ACT_LEDGER_INVALID')).toBe(true);
}, 30_000);

test('#776 next prints only the current rig chest edit and skips superseded working files', async () => {
  const { root, act, working, publishChestVersion } = await publishedChest();
  expect(await command(root, act.actId, 1, false, ['--config', workingConfig])).toMatchObject({ exit: 0, stderr: '' });
  expect(nextProject(root, testClock.now()).bust_landmark_commands).toHaveLength(2);

  // Reuse synthetic producer bytes to declare a replacement rig with its own package.
  testClock.set(testClock.now() + 1);
  const project = projectAt(root);
  const versions = project.versions as JsonObject[];
  const second = structuredClone(versions[0]!);
  Object.assign(second, { n: 2, at: testClock.iso(), changed: 'Build the replacement synthetic rig.', evidence: [], verdicts: [] });
  delete second.review_package;
  for (const output of second.outputs as JsonObject[]) {
    output.path = String(output.path).replace('outputs/v1/', 'outputs/v2/');
  }
  cpSync(join(root, 'outputs/v1'), join(root, 'outputs/v2'), { recursive: true });
  const nextFrozenConfig = 'evidence/v2/config-source.json';
  const configPath = 'evidence/v2/config.json';
  mkdirSync(join(root, 'evidence/v2'));
  cpSync(join(root, frozenConfig), join(root, nextFrozenConfig));
  cpSync(join(root, 'evidence/v1/config.json'), join(root, configPath));
  cpSync(join(root, 'evidence/v1/interview-requirements.json'), join(root, 'evidence/v2/interview-requirements.json'));
  ((second.registration as JsonObject).config_source as JsonObject).path = nextFrozenConfig;
  ((second.provenance as JsonObject).config as JsonObject).path = configPath;
  versions.push(second);
  putProject(root, project);
  expect(reviewPackageCommand(['2', root, '--config', configPath, '--from', 'outputs/v2/out']).exit).toBe(0);
  rmSync(join(root, workingConfig));

  const beforeEdit = nextProject(root, testClock.now());
  expect(beforeEdit.effective_stage).toBe('rig-review');
  expect(beforeEdit.bust_landmark_commands).toBeUndefined();
  expect(beforeEdit.refusals.filter(finding => finding.field.startsWith('review_acts['))).toEqual([]);
  const legacy = projectAt(root);
  (reviewVerdictReceipts(legacy)[0]!.bust_config as JsonObject).path = 'outputs/historical-config.json';
  expect(reviewActFindings(legacy)).toEqual([]);

  const nextConfig = 'working/v2.json';
  writeFileSync(join(root, nextConfig), working);
  const newer = await publishChestVersion(2);
  expect(newer.act.source.selector).toEqual({ kind: 'rig', version: 2 });
  const result = await command(root, newer.act.actId, 2, false, ['--config', nextConfig]);
  expect(result).toMatchObject({ exit: 0, stderr: '' });
  const digest = jobHash(newer.host.session.readActExport(newer.act.actId, false));
  const base = `evidence/v2/${digest}`;
  const commands = [
    `rig-parts bust-landmarks --from-act ${base}.act.json --parts outputs/v2/out --config ${nextConfig} --out ${base}.bust-landmarks.json --write-config`,
    `rig-parts propose --parts outputs/v2/out --source inputs/painting.png --out ${base}.bust-proposal --write-config ${nextConfig} --bust-landmarks ${base}.bust-landmarks.json`,
  ];
  const afterEdit = nextProject(root, testClock.now());
  expect(afterEdit.bust_landmark_commands).toEqual(commands);
  expect(formatNext(afterEdit).split('\n').filter(line => line.startsWith('rig-parts '))).toEqual(commands);
  expect(afterEdit.refusals.filter(finding => finding.field.startsWith('review_acts['))).toEqual([]);

  testClock.set(testClock.now() + 1);
  reviewCommand(['2', root, '--verdict', 'bounced', '--by', 'user', '--review', 'rig-review',
    '--source', 'chat', '--verbatim', 'Request a different change.']);
  rmSync(join(root, nextConfig));
  const afterVerdict = nextProject(root, testClock.now());
  expect(afterVerdict.effective_stage).toBe('rig-review');
  expect(afterVerdict.bust_landmark_commands).toBeUndefined();
  expect(afterVerdict.refusals.filter(finding => finding.field.startsWith('review_acts['))).toEqual([]);
}, 30_000);

test('#774 rejects either stale hash before output or any project tree change', async () => {
  const { root, act, working } = await publishedChest();
  const originalProject = projectAt(root);
  const project = structuredClone(originalProject);
  const pkg = (project.versions as JsonObject[])[0]!.review_package as JsonObject;
  const config = (pkg.files as JsonObject[]).find(row => row.path === 'config.json')!;
  config.sha256 = 'a'.repeat(64);
  // The on-disk package still agrees with the original published seed.
  putProject(root, project);
  async function expectRefusal(code: string) {
    const before = treeSnapshot(root);
    const refusal = await command(root, act.actId, 1, false, ['--config', workingConfig]);
    expect(refusal.exit).toBe(1);
    expect(refusal.stderr).toContain(code);
    expect(refusal.stdout).toBe('');
    expect(treeSnapshot(root)).toEqual(before);
  }
  await expectRefusal('REVIEW_ACT_BUST_CONFIG_STALE');
  putProject(root, originalProject);
  writeFileSync(join(root, workingConfig), ` ${working}`);
  await expectRefusal('REVIEW_ACT_BUST_SOURCE_CHANGED');
}, 30_000);

test('#774 requires an explicit independent working config and refuses escapes and sealed aliases', async () => {
  const { root, act, working } = await publishedChest();
  const external = join(temporary('create-external-config-'), 'config.json');
  writeFileSync(external, working);
  symlinkSync(external, join(root, 'outside.json'));
  symlinkSync('evidence', join(root, 'alias-evidence'));
  symlinkSync('derived/review/v1', join(root, 'alias-package'));
  linkSync(join(root, frozenConfig), join(root, 'sealed-hardlink.json'));
  mkdirSync(join(root, 'OuTpUtS'), { recursive: true });
  for (const path of ['outputs/working-config.json', 'OuTpUtS/mixed-case-config.json']) {
    writeFileSync(join(root, path), working);
  }
  const before = treeSnapshot(root);
  const missing = await command(root, act.actId);
  expect(missing.exit).toBe(2);
  expect(missing.stderr).toContain('REVIEW_OPTION_MISSING');
  expect(missing.stderr).toContain('--config');
  expect(missing.stdout).toBe('');
  for (const path of [external, 'working/../' + workingConfig, frozenConfig, portableConfig, 'Evidence/v1/config-source.json',
    'outside.json', 'alias-evidence/v1/config-source.json', 'alias-package/config.json', 'sealed-hardlink.json',
    'outputs/working-config.json', 'OuTpUtS/mixed-case-config.json']) {
    const result = await command(root, act.actId, 1, false, ['--config', path]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain('JOB_PUBLICATION_INVALID');
    expect(result.stdout).toBe('');
    expect(treeSnapshot(root)).toEqual(before);
  }
}, 30_000);

test('#774 mixed act@9 keeps the act@8 mesh correction path and validates both in the receipt', async () => {
  const { root, act, host } = await publishedChest(true);
  const result = await command(root, act.actId, 1, false, ['--config', workingConfig, '--json']);
  expect(result.stderr).toBe('');
  expect(result.exit).toBe(0);
  const project = projectAt(root);
  const receipt = reviewVerdictReceipts(project)[0]!;
  expect(receipt.bytes).toBe(host.session.readActExport(act.actId, false).toString('utf8'));
  const revision = pendingMeshDeltaRevision(project)!;
  expect(revision.sourceVersion).toBe(1);
  expect(readFileSync(join(root, revision.revision, 'rig.json'))).not.toEqual(readFileSync(join(root, 'derived/review/v1/out/rig/rig.json')));
  expect(reviewActFindings(project)).toEqual([]);
  expect(reviewActFindings({ ...project, corrections: [] }).map(finding => finding.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
  const before = treeSnapshot(root);
  expect((await command(root, act.actId)).exit).toBe(0);
  expect(treeSnapshot(root)).toEqual(before);
}, 90_000);

/** Inject consumer API responses without materializing a saved Review export. */
function fetchAdapter(root: string, act: { jobId: string }, raw: string | (() => string), png?: Buffer) {
  root = realpathSync(root);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('accept') === 'image/png') {
      return png === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(png));
    }
    const text = typeof raw === 'string' ? raw : raw();
    if (request.headers.get('accept') === 'application/json') {
      const body = await request.json() as { requestId: string };
      return Response.json({ schema: 'rig-review/job-api@2', verb: 'fetch-act', jobId: act.jobId,
        requestId: body.requestId, ok: true, value: JSON.parse(text) });
    }
    return new Response(text, { headers: { 'content-type': 'application/vnd.rig-review.act+json' } });
  } });
  try {
    const binding = readWriterBinding(root)!;
    expect(binding.jobId).toBe(act.jobId);
    binding.origin = `http://127.0.0.1:${server.port}`;
    writePrivateJson(join(root, JOB_BINDING_FILE), binding, true);
    const project = projectAt(root);
    (project.review_job as JsonObject).origin = binding.origin;
    putProject(root, project);
    return server;
  } catch (error) {
    server.stop(true);
    throw error;
  }
}

/** A comments fixture binds the actual published files and captured still. */
function commentsVerdict(act: Awaited<ReturnType<typeof published>>['act'], n: 1 | 2 = 1): JsonObject {
  return {
    schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'review-verdict', jobId: act.jobId, actId: 'comments-verdict',
    askId: act.askId, publicationId: act.publicationId, authority: act.authority as unknown as JsonObject,
    at: act.at, source: act.source as unknown as JsonObject,
    value: { stage: n === 1 ? 'rig-review' : 'direction-review', verdict: 'approved', comments: [{ text: '  First\r\n' }, { text: 'Second' }] },
    ...('still' in act && act.still ? { still: act.still as unknown as JsonObject } : {}),
  };
}

for (const n of [1, 2] as const) {
  test(`@6 v${n} normal verdict ingest and replay retain raw comments and projected words`, async () => {
    const { root, act } = await published(n === 1 ? '3-rig-review' : '4-direction-post', n);
    const fresh = commentsVerdict(act, n);
    let raw = `${JSON.stringify(fresh, null, 3)}\n`;
    const png = n === 1 ? readFileSync(join(root, 'evidence/setup.png')) : undefined;
    const server = fetchAdapter(root, act, () => raw, png);
    try {
      const received = await fetchReviewAct(reviewActTransport(root, String(fresh.actId)));
      expect(received.bytes).toBe(raw);
      expect(jobHash(received.bytes)).toBe(jobHash(raw));
      expect(Object.keys(received.act)).toEqual(Object.keys(fresh));
      const first = await command(root, String(fresh.actId), n);
      expect(first.stderr).toBe(''); expect(first.exit).toBe(0);
      let bytes = readFileSync(join(root, 'project.json'));
      const project = projectAt(root);
      const receipt = reviewVerdictReceipts(project)[0]!;
      expect(receipt.bytes).toBe(raw);
      expect(receipt.sha256).toBe(jobHash(raw));
      expect(JSON.parse(String(receipt.bytes)).schema).toBe(JOB_COMMENTS_ACT_SCHEMA);
      const version = (project.versions as JsonObject[]).find(version => version.n === n)!;
      expect((version.verdicts as JsonObject[]).at(-1)!.verbatim).toBe('[general]\n  First\r\n\n\n[general]\nSecond');
      expect(reviewActFindings(project)).toEqual([]);
      expect(checkProject(root, project).refusals).toEqual([]);
      const replay = await command(root, String(fresh.actId), n);
      expect(replay.stderr).toBe(''); expect(replay.exit).toBe(0);
      expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
      if (n === 1) {
        const still = fresh.still as JsonObject;
        expect(readFileSync(join(root, `evidence/v1/${String(still.path)}`))).toEqual(png!);
      }
      const stage = n === 1 ? 'rig-review' : 'direction-review';
      const signoff: JsonObject = {
        schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'signoff', jobId: fresh.jobId, actId: 'comments-signoff',
        askId: fresh.askId, publicationId: fresh.publicationId, authority: fresh.authority,
        at: fresh.at, source: fresh.source,
        value: { stage, decision: 'approved', comments: (fresh.value as JsonObject).comments },
      };
      raw = JSON.stringify(signoff);
      for (const replaySignoff of [false, true]) {
        const beforeSignoff = readFileSync(join(root, 'project.json'));
        const child = Bun.spawn([process.execPath, ...clockedCli(), 'signoff', stage, root,
          '--from-review', String(signoff.actId), '--json'], { stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(stderr).toBe(''); expect(exit).toBe(0);
        expect(JSON.parse(stdout).verbatim).toBe('[general]\n  First\r\n\n\n[general]\nSecond');
        if (replaySignoff) expect(readFileSync(join(root, 'project.json'))).toEqual(beforeSignoff);
      }
      bytes = readFileSync(join(root, 'project.json'));
      expect(reviewActFindings(projectAt(root))).toEqual([]);
      raw = JSON.stringify(Object.fromEntries(Object.entries(fresh).reverse()));
      const reordered = await fetchReviewAct(reviewActTransport(root, String(fresh.actId)));
      expect(reordered.bytes).toBe(raw);
      expect(jobHash(reordered.bytes)).not.toBe(receipt.sha256);
      expect(Object.keys(reordered.act)).toEqual(Object.keys(fresh).reverse());
      console.log(JSON.stringify({ boundary: 'comments-act-raw-replay', version: n,
        transport_sha256: jobHash(received.bytes), ledger_sha256: receipt.sha256,
        reordered_transport_sha256: jobHash(reordered.bytes),
        original_keys: Object.keys(received.act), reordered_keys: Object.keys(reordered.act) }));
      const representationConflict = await command(root, String(fresh.actId), n);
      expect(representationConflict.exit).toBe(1); expect(representationConflict.stderr).toContain('REVIEW_ACT_REPLAY_CONFLICT:');
      expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
      (fresh.value as JsonObject).comments = [...((fresh.value as JsonObject).comments as JsonObject[])].reverse();
      raw = JSON.stringify(fresh);
      const conflict = await command(root, String(fresh.actId), n);
      expect(conflict.exit).toBe(1); expect(conflict.stderr).toContain('REVIEW_ACT_REPLAY_CONFLICT:');
      expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
    } finally { server.stop(true); }
  });
}

test('@6 source asset change refuses through the normal verdict writer', async () => {
  const { root, act } = await published();
  const fresh = commentsVerdict(act);
  const model = (fresh.source as JsonObject).model as JsonObject;
  const modelPath = join(root, String(model.path));
  writeFileSync(modelPath, `${readFileSync(modelPath, 'utf8')}\n`);
  const server = fetchAdapter(root, act, JSON.stringify(fresh), readFileSync(join(root, 'evidence/setup.png')));
  try {
    const before = readFileSync(join(root, 'project.json'));
    const result = await command(root, String(fresh.actId));
    expect(result.exit).toBe(1); expect(result.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  } finally { server.stop(true); }
});

test('#838 an incomplete @6 interview act is refused by Review\'s parser before any survey projection', () => {
  expect(() => decodeReviewAct(JSON.stringify({ schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'interview-picks' }), 'interview-picks'))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
});

for (const invalid of ['words', 'question-anchor', 'blank', 'too-long'] as const) {
  test(`@6 normal verdict writer refuses ${invalid} comments without writing`, async () => {
    const { root, act } = await published();
    const fresh = commentsVerdict(act);
    const value = fresh.value as JsonObject;
    if (invalid === 'words') value.words = 'legacy key';
    if (invalid === 'question-anchor') value.comments = [{ text: 'Answer', anchor: { questionId: 'framing', itemId: 'palette' } }];
    if (invalid === 'blank') value.comments = [{ text: '  ' }];
    if (invalid === 'too-long') value.comments = [{ text: 'x'.repeat(10_000) }];
    const server = fetchAdapter(root, act, JSON.stringify(fresh), readFileSync(join(root, 'evidence/setup.png')));
    try {
      const before = readFileSync(join(root, 'project.json'));
      const result = await command(root, String(fresh.actId));
      expect(result.exit).toBe(1); expect(result.stderr).toContain('REVIEW_ACT_INVALID:');
      expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    } finally { server.stop(true); }
  });
}

test.each(['missing', 'mismatch'])('API act refuses a %s PNG without changing project bytes', async failure => {
  const { root, act } = await published();
  const server = fetchAdapter(root, act, JSON.stringify(act), failure === 'mismatch' ? Buffer.from('wrong pixels') : undefined);
  try {
    const before = readFileSync(join(root, 'project.json'));
    const result = await command(root, act.actId);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(failure === 'missing' ? 'REVIEW_ACT_FETCH_REFUSED:' : 'REVIEW_ACT_STILL_INVALID:');
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  } finally { server.stop(true); }
});

test.each(['rig-review/act@3', JOB_COMMENTS_ACT_SCHEMA] as const)('API retains exact %s bytes and PNG and binds both hashes', async schema => {
  const { root, act } = await published();
  if (act.schema !== JOB_COMMENTS_ACT_SCHEMA || !act.still) throw Error('expected comments rig still');
  const exported = schema === JOB_COMMENTS_ACT_SCHEMA ? act
    : { ...act, schema, value: { stage: 'rig-review', verdict: 'approved', words: '  Synthetic historical approval.\r\n' } };
  const raw = `${JSON.stringify(exported, null, 3)}\n`;
  const png = readFileSync(join(root, 'evidence/setup.png'));
  const server = fetchAdapter(root, act, raw, png);
  try {
    const result = await command(root, act.actId);
    expect(result.exit).toBe(0);
    const project = projectAt(root);
    const receipt = reviewVerdictReceipts(project)[0]!;
    expect(receipt.bytes).toBe(raw);
    expect(receipt.sha256).toBe(jobHash(raw));
    expect(readFileSync(join(root, `evidence/v1/${jobHash(raw)}.act.json`), 'utf8')).toBe(raw);
    expect(readFileSync(join(root, `evidence/v1/${act.still.path}`))).toEqual(png);
    const diagnostics = checkProject(root, project);
    expect(diagnostics.refusals).toEqual([]);
    expect(diagnostics.warnings).toEqual([]);
  } finally { server.stop(true); }
});

test('manual accepted rig verdict without a still refuses and leaves project bytes unchanged', async () => {
  const { root } = await published();
  const project = projectAt(root);
  const version = (project.versions as JsonObject[])[0];
  version.evidence = (version.evidence as JsonObject[]).filter(e => e.kind !== 'still');
  version.verdicts = [];
  putProject(root, project);
  const before = readFileSync(join(root, 'project.json'));
  expect(() => reviewCommand(['1', root, '--verdict', 'accepted', '--review', 'rig-review', '--by', 'user',
    '--verbatim', 'Synthetic approval', '--source', 'synthetic review']))
    .toThrow(expect.objectContaining({ code: 'RIG_ACCEPTED_WITHOUT_STILL' }));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
});


test('removed file route refuses by name before opening a file and preserves project bytes', async () => {
  const { root } = await published();
  const before = readFileSync(join(root, 'project.json'));
  for (const flags of [['--from-review-file', join(root, 'missing-act.json')], ['--from-review-file'], ['--from-review-file=missing-act.json']]) {
    expect(() => reviewCommand(['1', root, ...flags]))
      .toThrow(expect.objectContaining({ code: 'REVIEW_FILE_ROUTE_REMOVED', exitCode: 2, message: expect.stringContaining('--from-review <actId>') }));
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  }
});


test('g2 publication verdict and signoff ingest through the writers and check', async () => {
  const { root, act, agent, uiRequest, publication, host } = await published('3-rig-review', 1, 'owner', 'Approved.', 'approved', 2, true);
  expect(act.source.package).toEqual({ id: 'create-v1', revision: 'v1-g2' });
  const ask = await agent('ask', { publicationId: publication.publicationId, subject: { kind: 'signoff', stage: 'rig-review' } });
  const displayed = await host.ports.ackDisplayed(host.session.jobId, uiRequest('displayed', { publicationId: publication.publicationId, pageId: 'sign-page', sourceHash: (publication.source as JsonObject).sourceHash }));
  if (!displayed.ok) throw Error(displayed.error.code);
  const signed = await host.ports.commitUIAct(host.session.jobId, uiRequest('acts', {
    publicationId: publication.publicationId, askId: ask.askId, pageId: 'sign-page', displayedNonce: displayed.value.displayedNonce,
    expectedGeneration: host.session.status().generation, submissionId: 'sign-submission', kind: 'signoff', value: { stage: 'rig-review', decision: 'approved', words: 'Sign this rig.' },
  }));
  expect(signed.ok).toBe(true);
  if (!signed.ok) throw Error(signed.error.code);
  testClock.set(Math.max(testClock.now(), Date.parse(signed.value.at)));
  const verdict = await command(root, act.actId);
  expect(verdict.stderr).toBe(''); expect(verdict.exit).toBe(0);
  const child = Bun.spawn([process.execPath, ...clockedCli(), 'signoff', 'rig-review', root, '--from-review', signed.value.actId], { stdout: 'pipe', stderr: 'pipe' });
  const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(''); expect(exit).toBe(0);
  expect(advanceCommand(['post-interview', root]).exit).toBe(0);
  const checked = checkProject(root, projectAt(root));
  expect(checked.refusals.map(f => ({ code: f.code, path: f.path }))).toEqual([
    { code: 'INTERVIEW_INCOMPLETE', path: 'interview.post.items[camera_depth].guide' },
    { code: 'INTERVIEW_INCOMPLETE', path: 'interview.post.items[post_timing].guide' },
    { code: 'INTERVIEW_INCOMPLETE', path: 'interview.post.items[post_composition].guide' },
  ]);
});

test('g2 publication still refuses a mismatched package identity without writing', async () => {
  const { root, act } = await published('3-rig-review', 1, 'owner', 'Approved.', 'approved', 2);
  const changed = structuredClone(act);
  ((changed.source as unknown as JsonObject).package as JsonObject).revision = 'v1-unpublished';
  const server = fetchAdapter(root, act, JSON.stringify(changed), readFileSync(join(root, 'evidence/setup.png')));
  try {
    const before = readFileSync(join(root, 'project.json'));
    const result = await command(root, act.actId);
    expect(result.exit).toBe(1); expect(result.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
    expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  } finally { server.stop(true); }
});


test('a retained g1 identity selects its exact manifest after republishing', async () => {
  const { root, act } = await published('3-rig-review', 1, 'owner', 'Approved.', 'approved', 2);
  const previous = { ...act, source: { ...act.source, package: { id: 'create-v1', revision: 'v1' } } };
  expect(() => assertReviewActSource(root, projectAt(root), decodeReviewAct(JSON.stringify(previous)))).not.toThrow();
});

async function publishedComposed(extraValue?: Parameters<typeof published>[8]) {
  const f = composeFixture();
  directories.push(f.dir);
  const root = fixture(() => {}, 'example-project.json');
  directories.push(root);
  testClock.set(EXAMPLE_REOPEN_AT);
  writeFileSync(join(root, 'words.txt'), 'Revise the synthetic composed take.');
  plantLegacyReopen(root, 'post-interview', { by: 'user', wordsFile: join(root, 'words.txt') });
  for (const name of ['background.png', 'foreground.png']) {
    cpSync(join(f.dir, name), join(root, name));
    inputCommand(['add', name, root, '--origin', 'synthetic plate']);
  }
  const project = projectAt(root);
  const accepted = objects(project.versions).find(v => v.n === 2)!;
  const pkg = accepted.review_package as JsonObject;
  accepted.outputs = [...objects(accepted.outputs), ...objects(pkg.files).filter(row => typeof row.path === 'string' && row.path.startsWith('out/')
    && (['parts.json', 'rig/rig.json', 'rig/motion.json'].includes(row.path.slice(4)) || row.path.startsWith('out/rig/images/')))
    .map(row => ({ path: `${String(pkg.from)}/${String(row.path).slice(4)}`, sha256: row.sha256! }))];
  const context = optionContext(project, 'post-interview', testClock.now(), root);
  const items = collectItems(project, { collection: null });
  for (const [id, value] of [['post_composition', { compose: f.value }], ['post_timing', { seconds: 4, loop: true, beats: [] }]] as const) {
    const item = items.find(i => i.id === id)!;
    const old = structuredClone(item.raw as JsonObject);
    const answer = item.raw as JsonObject;
    const oldChoice = answer.choice as JsonObject;
    const set = JSON.parse(readFileSync(join(root, String((oldChoice.set as JsonObject).path)), 'utf8')) as JsonObject;
    set.id = `composed-${id}`; set.context = context; set.drafted_at = testClock.iso();
    const shown = { label: `Use the synthetic composed ${id}`, effect: 'Keep the declared composed take.' };
    const selected = objects(objects(set.asks)[0]!.options).find(o => o.id === 'keep')!;
    selected.label = shown.label; selected.effect = shown.effect;
    selected.fragment = value as unknown as JsonObject;
    const path = `evidence/interview/composed-${id}.json`;
    const bytes = Buffer.from(JSON.stringify(set));
    writeFileSync(join(root, path), bytes);
    item.record.history = [...objects(item.record.history), old];
    answer.at = testClock.iso(); answer.value = value as unknown as JsonObject;
    answer.verbatim = `${shown.label}\n${shown.effect}`;
    answer.choice = { ...oldChoice, set: { path, sha256: directionHash(bytes) }, picks: [{ ask: id, option_id: 'keep', shown }] };
  }
  putProject(root, project);
  // The owner reopened completed work. Replace only the definitions whose answers changed.
  const plan = project.plan as JsonObject;
  const replacements = [...objects(plan.replaced)];
  for (const id of ['timing', 'composition']) {
    const step = objects(plan.steps).find(candidate => candidate.id === id)!;
    testClock.set(testClock.now() + 1_000);
    expect(planCommand(['remove', id, root, '--by', 'agent']).exit).toBe(0);
    replacements.push({ step, sha256: stepHash(step), action: 'removed', at: testClock.iso(), by: 'agent' });
    testClock.set(testClock.now() + 1_000);
    expect(planCommand(['add', id, root, '--by', 'agent', '--phase', String(step.phase), '--order', String(step.order),
      '--does', String(step.does), '--produces', String(step.produces), '--rests-on', (step.rests_on as string[]).join(','),
      '--bar', String(step.bar), '--checkpoint-proposed', String(step.checkpoint_proposed)]).exit).toBe(0);
  }
  expect((projectAt(root).plan as JsonObject).replaced).toEqual(replacements);
  testClock.set(Date.parse(EXAMPLE_REOPEN_AT) + 60_000);
  signoffCommand(['post-interview', root, '--by', 'user', '--verbatim-file', join(root, 'words.txt')]);
  advanceCommand(['post', root]);
  for (const step of ['camera', 'timing', 'composition']) {
    for (const status of ['in-progress', 'at-checkpoint', 'done']) {
      stepStatusCommand([step, status, root, '--by', 'agent']);
    }
  }
  cpSync(join(f.dir, 'compose-out'), join(root, 'compose-out'), { recursive: true });
  cpSync(join(f.dir, 'compose.scene.json'), join(root, 'compose.scene.json'));
  writeFileSync(join(root, 'compose-out/compose-run.json'), JSON.stringify(composeRunFixture(root, projectAt(root), 2, f.scene)));
  const doc = structuredClone(f.doc);
  doc.rig = { version: 2 };
  const citations = doc.citations as JsonObject;
  for (const [key, id] of [['camera', 'camera_depth'], ['timing', 'post_timing'], ['composition', 'post_composition']]) {
    citations[key!] = { guide: id!, asks: [id!], quote: (items.find(i => i.id === id)!.raw as JsonObject).verbatim! };
  }
  writeFileSync(join(root, 'evidence/composed-direction.json'), JSON.stringify(doc));
  directionCommand(['write', '5', root, '--file', 'evidence/composed-direction.json', '--rig', '2', '--compose-out', 'compose-out', '--compose-scene', 'compose.scene.json']);
  advanceCommand(['direction-review', root]);
  return published('4-direction-post', 5, 'owner', '  Synthetic composed approval.\r\n', 'approved', 1, false, { root, rigVersion: 2 }, extraValue);
}

test('#618 composed post act@6 with parts: null decodes, ingests, signs direction-review and advances to accepted', async () => {
  const { root, act, n } = await publishedComposed();
  expect(act.schema).toBe(JOB_COMMENTS_ACT_SCHEMA);
  expect(act.source.parts).toBeNull();
  expect(act.source.model?.path).toBe('outputs/v5/compose/check/build/skeleton.model.json');
  expect(decodeReviewAct(JSON.stringify(act)) as unknown).toEqual(act);
  const first = await command(root, act.actId, n);
  expect(first.stderr).toBe(''); expect(first.exit).toBe(0);
  const bytes = readFileSync(join(root, 'project.json'));
  const project = projectAt(root);
  const post = (project.versions as JsonObject[]).find(v => v.n === n)!;
  expect((post.verdicts as JsonObject[]).at(-1)).toMatchObject({ review: 'direction-review', verdict: 'accepted', by: 'user' });
  expect(reviewActFindings(project)).toEqual([]);
  expect(checkProject(root, project).refusals).toEqual([]);
  const replay = await command(root, act.actId, n);
  expect(replay.stderr).toBe(''); expect(replay.exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
  expect(signoffCommand(['direction-review', root, '--version', '5', '--by', 'user', '--verbatim-file', join(root, 'words.txt')]).exit).toBe(0);
  expect(advanceCommand(['accepted', root]).exit).toBe(0);
  expect(checkProject(root, projectAt(root)).refusals).toEqual([]);
});

test('#618 parts: null refuses rig and parts-verdict acts and non-composed post ingestion', async () => {
  const { act } = await publishedComposed();
  expect(() => decodeReviewAct(JSON.stringify({
    ...act,
    source: { ...act.source, selector: { kind: 'rig', version: 2 }, direction: null },
    value: { ...act.value, stage: 'rig-review' },
    still: { path: `${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64), camera: 'fixed', frame: 'setup' },
  }))).toThrow(expect.objectContaining({ code: 'REVIEW_PARTS_ENUMERATOR_UNSUPPORTED' }));
  expect(() => decodeReviewAct(JSON.stringify({
    ...act,
    schema: 'rig-review/act@2',
    source: { ...act.source, selector: { kind: 'rig', version: 2 }, direction: null },
    value: { stage: 'rig-review', verdict: 'approved', words: 'Synthetic' },
  }))).toThrow(expect.objectContaining({ code: 'REVIEW_PARTS_ENUMERATOR_UNSUPPORTED' }));
  expect(() => decodeReviewAct(JSON.stringify(act), 'parts-verdict'))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_KIND_MISMATCH' }));
  expect(() => decodeReviewAct(JSON.stringify({
    ...act,
    kind: 'parts-verdict',
    source: { ...act.source, selector: { kind: 'draft', id: 'd1' } },
    value: { verdict: 'approved', comments: [] },
  }), 'parts-verdict')).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
  expect(() => decodeReviewAct(JSON.stringify({
    ...act,
    schema: 'rig-review/act@5',
    kind: 'parts-verdict',
    source: { ...act.source, selector: { kind: 'draft', id: 'd1' } },
    value: { verdict: 'approved', issues: [], words: 'Synthetic' },
  }), 'parts-verdict')).toThrow(expect.objectContaining({ code: 'REVIEW_PARTS_ENUMERATOR_UNSUPPORTED' }));
  const nonComposed = await published('4-direction-post', 2);
  const withoutParts = { ...nonComposed.act, source: { ...nonComposed.act.source, parts: null } };
  expect(decodeReviewAct(JSON.stringify(withoutParts)).source.parts).toBeNull();
  const server = fetchAdapter(nonComposed.root, nonComposed.act, JSON.stringify(withoutParts));
  try {
    const before = readFileSync(join(nonComposed.root, 'project.json'));
    const result = await command(nonComposed.root, nonComposed.act.actId, 2);
    expect(result.exit).toBe(1); expect(result.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
    expect(readFileSync(join(nonComposed.root, 'project.json'))).toEqual(before);
  } finally { server.stop(true); }
});

test('#618 composed post act refuses differing model path, model hash or on-disk build bytes with REVIEW_ACT_SOURCE_STALE', async () => {
  const { root, act, n } = await publishedComposed();
  const rigModelPath = 'derived/review/v2/out/check/build/skeleton.model.json';
  const rigModelSha = jobHash(readFileSync(join(root, rigModelPath)));
  for (const model of [
    { path: rigModelPath, sha256: rigModelSha },
    { path: act.source.model!.path, sha256: '0'.repeat(64) },
  ]) {
    const mutated = { ...act, source: { ...act.source, model } };
    const server = fetchAdapter(root, act, JSON.stringify(mutated));
    try {
      const before = readFileSync(join(root, 'project.json'));
      const result = await command(root, act.actId, n);
      expect(result.exit).toBe(1); expect(result.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
      expect(readFileSync(join(root, 'project.json'))).toEqual(before);
    } finally { server.stop(true); }
  }
  const { root: diskRoot, act: diskAct, n: diskN } = await publishedComposed();
  const beforeDisk = readFileSync(join(diskRoot, 'project.json'));
  writeFileSync(join(diskRoot, diskAct.source.model!.path), '{}\n');
  const staleDisk = await command(diskRoot, diskAct.actId, diskN);
  expect(staleDisk.exit).toBe(1); expect(staleDisk.stderr).toContain('REVIEW_ACT_SOURCE_STALE:');
  expect(readFileSync(join(diskRoot, 'project.json'))).toEqual(beforeDisk);
});

/** #840: the version verdict record an owner-host act writes, as exact bytes. */
function ownerVerdictBytes(act: { jobId: string; actId: string; at: string }, verdict: string, verbatim: string): string {
  return `{"by":"user","at":"${act.at}","review":"rig-review","verdict":"${verdict}","verbatim":${JSON.stringify(verbatim)},"source":"review act ${act.jobId}/${act.actId}","on_items":[]}`;
}

for (const [verdict, recorded, words] of [['approved', 'accepted', '  Synthetic approval.\r\n'], ['changes-requested', 'bounced', '  Synthetic changes.\r\n']] as const) {
  test(`#840 an owner ${verdict} verdict from an owner host keeps its record bytes`, async () => {
    const { root, act } = await published('3-rig-review', 1, 'owner', words, verdict, 1, false, undefined, undefined, undefined, 'synthetic-owner');
    const result = await command(root, act.actId);
    expect(result.stderr).toBe(''); expect(result.exit).toBe(0);
    const record = ((projectAt(root).versions as JsonObject[])[0]!.verdicts as JsonObject[]).at(-1)!;
    expect(JSON.stringify(record)).toBe(ownerVerdictBytes(act, recorded, `[general]\n${words}`));
    expect(reviewActFindings(projectAt(root))).toEqual([]);
  });

  test(`#840 a ${verdict} verdict from an owner host opened for the agent refuses REVIEW_NOT_HUMAN and writes nothing`, async () => {
    const { root, act } = await published('3-rig-review', 1, 'owner', words, verdict, 1, false, undefined, undefined, undefined, verdict === 'approved' ? 'Agent' : 'agent');
    const before = treeDigest(root);
    const result = await command(root, act.actId);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain('REVIEW_NOT_HUMAN:');
    expect(treeDigest(root)).toEqual(before);
  });
}

test('#840 the ledger keeps an earlier agent verdict recorded as user with a WARN and refuses one from REVIEW_ACT_ACTOR_SINCE', async () => {
  const { root, act } = await published('3-rig-review', 1, 'owner', '  Synthetic approval.\r\n', 'approved', 1, false, undefined, undefined, undefined, 'synthetic-owner');
  expect((await command(root, act.actId)).exit).toBe(0);
  const recorded = projectAt(root);
  const agentAct = (project: JsonObject, at?: string): void => {
    const receipt = reviewVerdictReceipts(project)[0]!;
    const value = JSON.parse(String(receipt.bytes)) as JsonObject;
    ((value.authority as JsonObject).reviewer as JsonObject).id = 'agent';
    if (at) { value.at = at; ((project.versions as JsonObject[])[0]!.verdicts as JsonObject[])[Number(receipt.verdict)]!.at = at; }
    receipt.bytes = JSON.stringify(value); receipt.sha256 = jobHash(String(receipt.bytes));
  };
  const current = structuredClone(recorded);
  agentAct(current);
  expect(reviewActFindings(current).map(f => f.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
  const earlier = structuredClone(recorded);
  agentAct(earlier, new Date(Date.parse(REVIEW_ACT_ACTOR_SINCE) - 60_000).toISOString());
  const warnings: Finding[] = [];
  expect(reviewActFindings(earlier, warnings)).toEqual([]);
  expect(warnings.map(f => f.code)).toEqual(['REVIEW_ACT_ACTOR_LEGACY']);
});

// rig-c/review#1136: a direction verdict carries its pins as Feedback anchors. Create carries them as Review wrote
// them and computes nothing from them (AGENTS.md invariant 1); the recorded words stay Review's scalar projection.
test('#1136 a composed direction pin keeps its anchor through the fetched act and the receipt', async () => {
  let comments: JsonObject[] = [];
  const { root, host, act, n } = await publishedComposed((_root, source) => {
    const target = String(((source.package ?? {}) as JsonObject).id ?? 'synthetic-composed');
    comments = [directionPin(String(source.sourceHash), String((source.model as JsonObject).sha256), 1.25, 'Hold the lantern here.', target), { text: 'Overall direction note.' }];
    return { words: undefined, comments } as unknown as JsonObject;
  });
  expect(act.schema).toBe(JOB_COMMENTS_ACT_SCHEMA);
  const exported = host.session.readActExport(act.actId, false).toString('utf8');
  const reviewValue = (JSON.parse(exported) as JsonObject).value as JsonObject;
  expect(reviewValue.comments).toEqual(comments);
  const anchor = (reviewValue.comments as JsonObject[])[0]!.anchor as JsonObject;
  const pin = (anchor.context as JsonObject).comment as JsonObject;
  expect([anchor.frameStart, anchor.frameEnd, pin.frame, pin.time, pin.timeBasis]).toEqual([null, null, null, 1.25, TIME_ONLY_BASIS]);


  const first = await command(root, act.actId, n);
  expect(first.stderr).toBe(''); expect(first.exit).toBe(0);
  const words = projectComments(comments as unknown as JobComment[]);
  const target = String(anchor.target && (anchor.target as JsonObject).name);
  expect(words).toBe(`[["rig-review-comment/1","animate","rig","rig",${JSON.stringify(target)},null,null]]\nHold the lantern here.\n\n[general]\nOverall direction note.`);
  expect(JSON.parse(first.stdout).verdict.verbatim).toBe(words);
  const project = projectAt(root);
  const receipt = reviewVerdictReceipts(project).at(-1)!;
  expect(receipt.bytes).toBe(exported);
  const recorded = decodeReviewAct(String(receipt.bytes));
  if (!('comments' in recorded.value)) throw Error(recorded.schema);
  expect(recorded.value.comments[0]!.anchor as unknown).toEqual(anchor);
  expect(reviewActVerbatim(recorded)).toBe(words);
  const bytes = readFileSync(join(root, 'project.json'));
  expect((await command(root, act.actId, n)).exit).toBe(0);
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
}, 30_000);

test('#1136 historical direction verdict and picks acts replay to their recorded words through the pinned projector', () => {
  // Words recorded under Review 4.18.2, before #1136.
  const direction = { schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'review-verdict', value: HISTORICAL_DIRECTION_VALUE };
  expect(reviewActVerbatim(direction as never)).toBe('[general]\n[["rig-review-comment/1","animate","rig","rig","legacy",null,null]]\nHold this pose');
  const picks = { schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'interview-picks',
    value: { questionId: 'motion', selections: [], note: '', comments: [framedRigPin('Pin on the rig point.'), { text: 'Picks note.' }] } };
  expect(reviewActVerbatim(picks as never)).toBe('[["rig-review-comment/1","animate","rig","rig","synthetic-rig",3,3]]\nPin on the rig point.\n\n[general]\nPicks note.');
});

test('#1136 the scalar label for every existing comment shape is unchanged', () => {
  // Labels Review 4.18.2 projected for the same shapes; a seconds-only pin never gains a derived frame.
  const recorded: Record<string, string> = {
    general: '[general]\n  First\r\nline  ',
    checkpoint: '[["checkpoint","assemble"]]\nApprove assemble.',
    'parts-issue': '[["rig-review-parts-comment/2",["torso","face"],"parts"]]\nEdge needs work.',
    'image-name': '[["candidate"]]\nSecond',
    'feedback-slot': '[["slot","sleeve",3,5,null]]\nFix this',
    'feedback-rig-framed': '[["rig-review-comment/1","animate","rig","rig","synthetic-rig",3,3]]\nReview this point on the rig.',
    'direction-time-only': '[["rig-review-comment/1","animate","rig","rig","synthetic-composed",null,null]]\nHold the lantern here.\n\n[general]\nOverall direction note.',
  };
  const shapes = existingShapes();
  expect(shapes.map(([id]) => id)).toEqual(Object.keys(recorded));
  for (const [id, comments] of shapes) {
    expect(projectComments(comments as unknown as JobComment[])).toBe(recorded[id]!);
    expect(projectComments(structuredClone(comments) as unknown as JobComment[])).toBe(recorded[id]!);
  }
});
