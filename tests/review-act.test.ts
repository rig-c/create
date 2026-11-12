import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JOB_COMMENTS_ACT_SCHEMA, startJobHost, type JobOwnerHost, type JobVerdict } from '@rig-c/review/job-host';
import { collectItems } from '../src/check.ts';
import { acknowledgePublication, enqueuePublication, jobHash, JOB_BINDING_FILE, jobHostStateRoot, readWriterBinding, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity, partsEnumerator, prepareLiveManifest, readPublished } from '../src/job-publication.ts';
import { decodeReviewAct, decodeReviewResponse, fetchReviewAct, reviewActFindings, reviewActTransport } from '../src/review-act.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, checkProject, directionCommand, inputCommand, reviewCommand, sceneCommand, signoffCommand, testClock } from './clock.ts';
import { clockedCli } from './helpers.ts';

const directories: string[] = [];
const hosts: JobOwnerHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of directories.splice(0)) { rmSync(jobHostStateRoot(root), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
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

async function published(checkpoint = '3-rig-review', n = 1, role: 'owner' | 'delegate' = 'owner', words = '  Synthetic approval.\r\n', verdict: JobVerdict = 'approved') {
  testClock.reset();
  const root = temporary('create-act-project-');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints', checkpoint), root, { recursive: true });
  if (n === 2) {
    mkdirSync(join(root, 'inputs'), { recursive: true });
    for (const path of ['inputs/background.png', 'evidence/scene-citations.json', 'evidence/direction-input.json']) {
      cpSync(join(import.meta.dir, '../templates/example-chain', path), join(root, path));
    }
    inputCommand(['add', 'inputs/background.png', root, '--origin', 'synthetic plate']);
    sceneCommand(['write', '--rig', '1', '--background', 'inputs/background.png', '--citations-file', 'evidence/scene-citations.json', '--by', 'user', root]);
    directionCommand(['write', '2', root, '--file', 'evidence/direction-input.json', '--rig', '1']);
    advanceCommand(['direction-review', root]);
  }
  const hidden = temporary('create-act-hidden-');
  // The actual host state path is never installed in the consumer binding.
  const stateDir = join(hidden, 'relocated-state');
  const identity = currentJobIdentity({ root, stateDir, fingerprint: 'rig-create/live-review/1', reviewer: { id: 'synthetic-reviewer', role } }, root);
  const host = await startJobHost({ ...identity, partsEnumerator, readPublished,
    installWriterBinding: grant => writePrivateJson(join(root, JOB_BINDING_FILE), {
      schema: 'rig-create/job-binding@1', identity: { ...identity, stateDir: 'not-given-to-writer' }, ...grant,
    }, true) });
  hosts.push(host);
  const project = projectAt(root);
  project.review_job = { jobId: host.session.jobId, origin: host.origin };
  putProject(root, project);
  const path = prepareLiveManifest(root, project, n);
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
  const selector = n === 1 ? { kind: 'rig', version: n } : { kind: 'post', version: n, rigVersion: 1 };
  const entry = enqueuePublication(root, readWriterBinding(root)!, { path, selector: selector as NonNullable<Parameters<typeof enqueuePublication>[2]['selector']> });
  const publication = await agent('publish', { result: { path, selector }, freeze: { kind: 'producer-held', holdId: 'synthetic-freeze', record: { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) } } });
  acknowledgePublication(entry, String(publication.publicationId), Number(publication.generation), 'synthetic-request');
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
    expectedGeneration: host.session.status().generation, submissionId: 'synthetic-submission', kind: 'review-verdict', value: { stage, verdict, words },
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
  expect(submitted.ok).toBe(true);
  if (!submitted.ok) throw Error(submitted.error.code);
  testClock.set(Math.max(testClock.now(), Date.parse(submitted.value.at)));
  return { root, host, act: submitted.value, hidden, n };
}

async function command(root: string, actId: string, n = 1, guarded = false) {
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
  const child = Bun.spawn([process.execPath, ...(guarded ? ['--preload', guard] : []), ...clockedCli(), 'review', String(n), root, '--from-review', actId, '--json'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

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

/** Inject consumer API responses without materializing a saved Review export. */
function fetchAdapter(root: string, act: { jobId: string }, raw: string | (() => string), png?: Buffer) {
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
  const binding = readWriterBinding(root)!;
  expect(binding.jobId).toBe(act.jobId);
  binding.origin = `http://127.0.0.1:${server.port}`;
  writePrivateJson(join(root, JOB_BINDING_FILE), binding, true);
  const project = projectAt(root);
  (project.review_job as JsonObject).origin = binding.origin;
  putProject(root, project);
  return server;
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

test('@6 interview is refused before any survey projection', () => {
  expect(() => decodeReviewAct(JSON.stringify({ schema: JOB_COMMENTS_ACT_SCHEMA, kind: 'interview-picks' }), 'interview-picks'))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_KIND_MISMATCH' }));
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

test('API retains exact raw act bytes and PNG and binds both hashes', async () => {
  const { root, act } = await published();
  if (act.schema !== JOB_COMMENTS_ACT_SCHEMA || !act.still) throw Error('expected comments rig still');
  const raw = `${JSON.stringify(act, null, 3)}\n`;
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
    expect(checkProject(root, project).refusals).toEqual([]);
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
