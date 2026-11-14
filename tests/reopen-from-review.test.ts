import { startJobHost } from '@rig-c/review/job-host';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentJobIdentity, partsEnumerator, readPublished } from '../src/job-publication.ts';
import { tempDir } from './helpers.ts';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { decodeReviewAct, fetchReviewAct, reviewActFindings, reviewActTransport } from '../src/review-act.ts';
import { reopenCommand } from '../src/reopen.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { testClock } from './clock.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { exportedReopen, syntheticReopenReader } from './reopen-act-fixture.ts';

afterEach(() => testClock.reset());
const NOW = Date.parse('2026-11-20T00:00:00Z');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const pending = () => fixture(p => { p.stage = 'post'; p.signoffs = arr(p.signoffs).filter(raw => obj(raw).stage !== 'direction-review'); });
function refused(root: string, code: string, run: () => unknown): void {
  const before = readFileSync(join(root, 'project.json'));
  try { run(); throw Error('expected refusal'); }
  catch (error) { expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code); }
  const after = readFileSync(join(root, 'project.json'));
  if (process.env.REOPEN_INGEST_RECEIPT) appendFileSync(process.env.REOPEN_INGEST_RECEIPT, JSON.stringify({ code, before_sha256: jobHash(before), after_sha256: jobHash(after) }) + '\n');
  expect(jobHash(after)).toBe(jobHash(before));
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
}

test('#493 exported act@4 supplies exact reviewer, timestamp and words; replay changes nothing', async () => {
  const dir = pending();
  const exported = await exportedReopen(dir, 'parts', NOW);
  const args = ['parts', dir, '--from-review', exported.act.actId, '--json'];
  const hook = { fetch: () => ({ bytes: exported.bytes }) };
  const result = reopenCommand(args, NOW + 1000, hook);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ stage: 'parts', by: 'synthetic-owner', at: exported.act.at,
    verbatim: exported.act.kind === 'reopen' ? exported.act.value.words : '', source: `review act ${exported.act.jobId}/${exported.act.actId}` });
  expect(reviewActFindings(read(dir))).toEqual([]);
  const beforeReplay = readFileSync(join(dir, 'project.json'));
  expect(reopenCommand(args, NOW + 2000, hook)).toEqual(result);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeReplay);
  const altered = { ...exported.act, at: new Date(NOW + 1).toISOString() };
  refused(dir, 'REVIEW_ACT_REPLAY_CONFLICT', () => reopenCommand(args, NOW + 2000, { fetch: () => ({ bytes: JSON.stringify(altered) }) }));
  const project = read(dir); obj(arr(project.reopens).at(-1)).verbatim = 'different words';
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  expect(reviewActFindings(read(dir)).map(row => row.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
});

test.each(['stage', 'words', 'authority'])('#493 malformed exported %s refuses byte-identically', async field => {
  const dir = pending(); const exported = await exportedReopen(dir, 'parts', NOW);
  const malformed = JSON.parse(exported.bytes) as JsonObject;
  if (field === 'authority') delete malformed.authority; else delete obj(malformed.value)[field];
  refused(dir, 'REVIEW_ACT_INVALID', () => reopenCommand(['parts', dir, '--from-review', exported.act.actId], NOW,
    { fetch: () => ({ bytes: JSON.stringify(malformed) }) }));
});

test.each(['--by', '--verbatim-file', '--source'])('#493 mixed %s refuses byte-identically', flag => {
  const dir = pending();
  refused(dir, 'REOPEN_OPTION_INVALID', () => reopenCommand(['parts', dir, '--from-review', 'synthetic-act', flag, 'synthetic'], NOW));
});

test('#493 stage mismatch, stale record, future act and nonhuman writer refuse', async () => {
  const dir = pending(); const exported = await exportedReopen(dir, 'parts', NOW);
  const from = (stage: string, bytes = exported.bytes, now = NOW) => reopenCommand([stage, dir, '--from-review', exported.act.actId], now, { fetch: () => ({ bytes }) });
  refused(dir, 'REVIEW_ACT_KIND_MISMATCH', () => from('rigging'));
  refused(dir, 'REVIEW_ACT_INVALID', () => from('parts', exported.bytes, NOW - 1));
  writeFileSync(join(dir, 'project.json'), readFileSync(join(dir, 'project.json'), 'utf8') + '\n');
  refused(dir, 'REVIEW_ACT_SOURCE_STALE', () => from('parts'));
  const agent = await exportedReopen(dir, 'parts', NOW, 'unchanged', 'agent');
  refused(dir, 'SIGNOFF_NOT_HUMAN', () => from('parts', agent.bytes));
});

test('#493 shared authenticated fetch decodes Review reopen act@4 using job-api@2', async () => {
  const dir = pending(); const exported = await exportedReopen(dir, 'parts', NOW);
  const transport = { ...reviewActTransport(dir, exported.act.actId), kind: 'reopen' as const };
  let calls = 0;
  const fetched = await fetchReviewAct(transport, (async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init!.body));
    expect(request.schema).toBe('rig-review/job-api@2'); expect(request.verb).toBe('fetch-act');
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer synthetic-read-grant');
    return Response.json({ schema: request.schema, verb: request.verb, jobId: request.jobId, requestId: request.requestId, ok: true, value: exported.act });
  }) as typeof fetch);
  expect(calls).toBe(1); expect(fetched.act).toEqual(decodeReviewAct(exported.bytes, 'reopen'));
});


test('#493 live Review emits reopen act@4 and the production CLI fetch runtime ingests it', async () => {
  const root = realpathSync(pending());
  const stateDir = realpathSync(tempDir());
  const identity = currentJobIdentity({ root, stateDir, fingerprint: 'synthetic-live-reopen', publicationMode: 'record-and-package',
    reviewer: { id: 'synthetic-live-owner', role: 'owner' } }, root);
  const host = await startJobHost({ ...identity, partsEnumerator, readPublished,
    // This transport test uses a synthetic declared plan; it does not claim
    // Create's job open publication adapter has declared reopen subjects.
    readRecordPublished: syntheticReopenReader('parts'),
    installWriterBinding: grant => writePrivateJson(join(root, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, ...grant }, true),
  });
  try {
    const project = read(root); project.review_job = { jobId: host.session.jobId, origin: host.origin };
    writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    const api = async (verb: string, fields: object) => {
      const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
        method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
        body: JSON.stringify({ schema: 'rig-review/job-api@3', jobId: host.session.jobId, requestId: randomUUID(), verb,
          expectedGeneration: host.session.status().generation, idempotencyKey: randomUUID(), ...fields }),
      }));
      const result = await response.json() as { ok: boolean; error?: unknown; value: JsonObject };
      expect(result.error).toBeUndefined(); expect(result.ok).toBe(true); return result.value;
    };
    const publication = await api('publish', { result: { kind: 'plan' }, freeze: { kind: 'producer-held', holdId: 'synthetic-freeze',
      record: { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) } } });
    const ask = await api('ask', { publicationId: publication.publicationId, subject: { kind: 'reopen', stage: 'parts' } });
    const ui = (route: string, value: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, {
      method: 'POST', headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    const displayed = await host.ports.ackDisplayed(host.session.jobId, ui('displayed', { publicationId: publication.publicationId,
      pageId: 'synthetic-page', sourceHash: obj(publication.source).sourceHash }));
    expect(displayed.ok).toBe(true); if (!displayed.ok) throw Error(displayed.error.code);
    const words = '  Revisit the synthetic plan.\r\n';
    const submitted = await host.ports.commitUIAct(host.session.jobId, ui('acts', { publicationId: publication.publicationId,
      askId: ask.askId, pageId: 'synthetic-page', displayedNonce: displayed.value.displayedNonce,
      expectedGeneration: host.session.status().generation, submissionId: randomUUID(), kind: 'reopen', value: { stage: 'parts', words } }));
    expect(submitted.ok).toBe(true); if (!submitted.ok) throw Error(submitted.error.code);
    const act = submitted.value;
    expect(act.schema).toBe('rig-review/act@4'); expect(act.kind).toBe('reopen');
    if (act.schema !== 'rig-review/act@4' || act.kind !== 'reopen') throw Error('unexpected live reopen schema');
    const transport = { ...reviewActTransport(root, act.actId), kind: 'reopen' as const };
    const fetched = await fetchReviewAct(transport);
    expect(fetched.act).toEqual(act);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'cli-at.ts'), new Date(Math.max(NOW, Date.parse(act.at))).toISOString(),
      'reopen', 'parts', root, '--from-review', act.actId, '--json'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (process.env.REOPEN_INGEST_RECEIPT) appendFileSync(process.env.REOPEN_INGEST_RECEIPT, JSON.stringify({ emitted_act: act,
      fetched_schema: fetched.act.schema, command: ['reopen', 'parts', '<synthetic>', '--from-review', act.actId, '--json'], stdout, stderr, exit }) + '\n');
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    expect(JSON.parse(stdout)).toMatchObject({ stage: 'parts', by: 'synthetic-live-owner', at: act.at, verbatim: words });
    expect(reviewActFindings(read(root))).toEqual([]);
  } finally { host.stop(); rmSync(stateDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
}, 30_000);


test.each([['accepted', 'REOPEN_STAGE_UNKNOWN'], ['paused', 'REOPEN_STAGE_UNKNOWN'], ['direction-review', 'REOPEN_NOT_PASSED']])(
  '#493 exported %s still obeys the existing reopen writer refusal', async (stage, code) => {
    const dir = pending(); const exported = await exportedReopen(dir, stage, NOW);
    refused(dir, code, () => reopenCommand([stage, dir, '--from-review', exported.act.actId], NOW,
      { fetch: () => ({ bytes: exported.bytes }) }));
  },
);
