import { afterEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startJobHost, type RecordPlanSubject } from '@rig-c/review/job-host';
import { askDeclaredSubjects, openCreateJob, openRecordPublication, reconcileCreateJob } from '../src/job-host.ts';
import { agentCall, readHostActsAndAsks } from '../src/job-acts.ts';
import { acknowledgePublication, enqueuePublication, jobHostStateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { fixture, obj } from './fixtures.ts';
import { CLI } from './helpers.ts';

const roots: string[] = [];
const recordBytes = (root: string): Buffer => readFileSync(join(root, 'project.json'));
const reviewer = { id: 'synthetic-owner', role: 'owner' as const };
const signoff = { kind: 'signoff', stage: 'plan-approved' } as const;
const legacyReopen = { kind: 'reopen', stage: 'interview' } as const;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

async function cli(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

function earlyPlan(): string {
  const checkpoint = 'example-chain/checkpoints/0b-plan-pending';
  const root = realpathSync(fixture(() => {}, checkpoint + '/project.json'));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates', checkpoint), root, {
    recursive: true, filter: path => !path.endsWith('/project.json'),
  });
  return root;
}

/** Seed a retained Review publication that predates removal of the Create writer. */
async function openLegacyPlan(root: string, subjects: RecordPlanSubject[]) {
  const host = await openCreateJob(root, reviewer, Date.now(), options => startJobHost({
    ...options,
    readRecordPublished: ((request: RecordPublicationRequest) => {
      const context = readRecordPublished(request);
      return context.plan === null ? context : { ...context, subjects };
    }) as typeof readRecordPublished,
  }), true);
  try {
    const result = { kind: 'plan' as const };
    enqueuePublication(root, readWriterBinding(root)!, result);
    await reconcileCreateJob(root, async entry => {
      const requestId = crypto.randomUUID();
      const reply = await agentCall(host, { verb: 'publish', requestId, idempotencyKey: requestId,
        expectedGeneration: 0, result,
        freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } },
      });
      expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
      const { publication, generation } = host.session.status();
      acknowledgePublication(entry, publication!.publicationId, generation, requestId, subjects);
      expect(await askDeclaredSubjects(host, publication!.publicationId, subjects, false)).toEqual(
        subjects.map(subject => ({ subject, status: 'asked' })));
    });
    return host;
  } catch (error) {
    host.stop();
    throw error;
  }
}

test('#674 a retained un-ingested reopen act reports the correction route and leaves project.json byte-identical', async () => {
  const root = earlyPlan();
  const host = await openLegacyPlan(root, [legacyReopen]);
  try {
    const original = recordBytes(root);
    const { asks } = await readHostActsAndAsks(host);
    expect(asks.map(ask => ask.subject)).toEqual([legacyReopen]);

    const url = new URL(host.ownerUrl);
    const endpoint = url.origin + '/jobs/' + host.session.jobId + '/ui/';
    const headers = {
      origin: url.origin, 'X-Review-Capability': url.hash.slice('#cap='.length), 'content-type': 'application/json',
    };
    const post = async (route: string, body: object) => {
      const response = await fetch(endpoint + route, { method: 'POST', headers, body: JSON.stringify(body) });
      const payload = await response.json() as JsonObject;
      expect(response.ok, JSON.stringify(payload)).toBe(true);
      return obj(payload.value);
    };
    const { generation, publication } = host.session.status();
    const { publicationId, source: { sourceHash } } = publication!;
    const pageId = crypto.randomUUID();
    const { displayedNonce } = await post('displayed', { publicationId, pageId, sourceHash });
    const value = { stage: 'interview', words: '  Please correct the first synthetic answer.\r\n' };
    const exported = await post('acts', {
      publicationId, askId: asks[0]!.askId, pageId, displayedNonce, expectedGeneration: generation,
      submissionId: crypto.randomUUID(), kind: 'reopen', value,
    });
    expect(exported).toMatchObject({ schema: 'rig-review/act@4', kind: 'reopen', value });
    expect(recordBytes(root)).toEqual(original);

    const listed = await cli(root, ['job', 'acts', root, '--json']);
    expect(listed.exit, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).acts).toEqual([expect.objectContaining({
      actId: exported.actId, kind: 'reopen', args: null, command: null,
      unavailable: {
        code: 'REOPEN_ACT_RETIRED',
        message: expect.stringMatching(/interview-options and interview-answer, then re-sign/),
      },
    })]);
    expect(recordBytes(root)).toEqual(original);
    const closed = await cli(root, ['job', 'close', root]);
    expect(closed.exit).toBe(1);
    expect(closed.stderr).toStartWith('JOB_ACTS_PENDING:');
    expect(closed.stderr).toContain('REOPEN_ACT_RETIRED');
    expect(recordBytes(root)).toEqual(original);
    const checked = await cli(root, ['interview', '--check', root]);
    expect(checked.exit, checked.stderr + checked.stdout).toBe(0);
    expect(recordBytes(root)).toEqual(original);
  } finally { host.stop(); }
}, 30_000);

test('#639 open replaces an unchanged old plan head and reuses the new head on retry', async () => {
  const root = earlyPlan();
  const oldHost = await openLegacyPlan(root, [signoff, legacyReopen]);
  const original = recordBytes(root);
  const oldId = oldHost.session.status().publication!.publicationId;
  oldHost.stop();

  const host = await openCreateJob(root, reviewer, Date.now(), undefined, true);
  try {
    expect(await openRecordPublication(root, host, undefined, true, Date.now())).toEqual(
      ['job: plan published', 'job: asked signoff plan-approved']);
    const { publication, generation } = host.session.status();
    expect(publication!.publicationId).not.toBe(oldId);
    expect(publication!.source).toMatchObject({ subjects: [signoff] });
    expect(await openRecordPublication(root, host, undefined, true, Date.now())).toEqual(
      ['job: plan already published', 'job: already asked signoff plan-approved']);
    expect(host.session.status()).toMatchObject({ generation, publication: { publicationId: publication!.publicationId } });
    expect(recordBytes(root)).toEqual(original);
  } finally { host.stop(); }
}, 30_000);
