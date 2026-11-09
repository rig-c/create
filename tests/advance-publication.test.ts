import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JobHostOptions, type JobOwnerHost, type JobSubject } from '@rig-c/review/job-host';
import { checkProject } from '../src/check.ts';
import { openCreateJob } from '../src/job-host.ts';
import { JOB_BINDING_FILE, jobHostStateRoot, jobPrivateRoot, pendingPublications, readAcknowledgedPublication, readWriterBinding, writePrivateJson } from '../src/job-outbox.ts';
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

const WORDS = '  Synthetic approval, 좋아.\r\n';
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
const write = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

function copy(checkpoint: string, edit?: (project: JsonObject) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-advance-pub-')));
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
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

async function open(root: string, startHost?: (options: JobHostOptions) => Promise<JobOwnerHost>): Promise<JobOwnerHost> {
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now(), startHost);
  hosts.push(host);
  return host;
}

async function agent(host: JobOwnerHost, verb: string, fields: object): Promise<{ ok: boolean; error?: { code: string }; value: JsonObject }> {
  const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
    method: 'POST',
    headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      schema: 'rig-review/job-api@2',
      verb,
      jobId: host.session.jobId,
      requestId: randomUUID(),
      expectedGeneration: host.session.status().generation,
      idempotencyKey: randomUUID(),
      ...fields,
    }),
  }));
  return await response.json() as { ok: boolean; error?: { code: string }; value: JsonObject };
}

const ask = (host: JobOwnerHost, subject: JobSubject) => agent(host, 'ask', { publicationId: host.session.status().publication!.publicationId, subject });

async function page(host: JobOwnerHost) {
  const publication = host.session.status().publication!;
  const ui = (route: string, body: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, {
    method: 'POST',
    headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const pageId = randomUUID();
  const displayed = await host.ports.ackDisplayed(host.session.jobId, ui('displayed', {
    publicationId: publication.publicationId,
    pageId,
    sourceHash: publication.source.sourceHash,
  }));
  if (!displayed.ok) throw Error(displayed.error.code);
  return {
    pageId,
    act: async (askId: string, kind: string, value: object, extra: object = {}) => {
      const result = await host.ports.commitUIAct(host.session.jobId, ui('acts', {
        publicationId: publication.publicationId,
        askId,
        pageId,
        displayedNonce: displayed.value.displayedNonce,
        expectedGeneration: host.session.status().generation,
        submissionId: randomUUID(),
        kind,
        value,
        ...extra,
      }));
      if (!result.ok) throw Error(result.error.code);
      return result.value;
    },
  };
}

function declared(root: string, host: JobOwnerHost): readonly JobSubject[] | undefined {
  return readAcknowledgedPublication(root, host.session.jobId, host.session.status().publication!.publicationId)?.subjects;
}

test('advance rig-review on a bound job publishes the current rig with the signoff subject for the first stage sign-off', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  const host = await open(root);

  const advanced = await cli(root, ['advance', 'rig-review', root, '--json']);
  expect({ exit: advanced.exit, stderr: advanced.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root).stage).toBe('rig-review');
  expect(declared(root, host)).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
    { kind: 'signoff', stage: 'rig-review' },
  ]);

  const verdictAsk = await ask(host, { kind: 'review-verdict', stage: 'rig-review' });
  const signoffAsk = await ask(host, { kind: 'signoff', stage: 'rig-review' });
  expect([verdictAsk.ok, signoffAsk.ok]).toEqual([true, true]);

  const { pageId, act } = await page(host);
  const publication = host.session.status().publication!;
  const png = readFileSync(join(root, 'evidence/setup.png'));
  const verdict = await act(String(verdictAsk.value.askId), 'review-verdict', { stage: 'rig-review', verdict: 'approved', words: WORDS }, {
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
        publicationId: publication.publicationId,
        instanceKey: publication.instanceKey,
        sourceHash: publication.source.sourceHash,
        pageId,
        askId: verdictAsk.value.askId,
        drawGeneration: 1,
        playerGeneration: 0,
      },
    },
  });
  const signed = await act(String(signoffAsk.value.askId), 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });

  const reviewed = await cli(root, ['review', '1', root, '--from-review', verdict.actId, '--json']);
  expect({ exit: reviewed.exit, stderr: reviewed.stderr }).toEqual({ exit: 0, stderr: '' });
  const signoffRes = await cli(root, ['signoff', 'rig-review', root, '--from-review', signed.actId, '--json']);
  expect({ exit: signoffRes.exit, stderr: signoffRes.stderr }).toEqual({ exit: 0, stderr: '' });

  const generationBeforePostInterview = host.session.status().generation;
  const toPostInterview = await cli(root, ['advance', 'post-interview', root, '--json']);
  expect({ exit: toPostInterview.exit, stderr: toPostInterview.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root).stage).toBe('post-interview');
  expect(host.session.status().generation).toBe(generationBeforePostInterview);
  expect(pendingPublications(root)).toEqual([]);
});

test('advance direction-review on a bound job publishes the current post with the signoff subject for the first stage sign-off', async () => {
  const root = copy('example-chain', project => {
    project.stage = 'post';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'direction-review' && entry.stage !== 'accepted');
    project.signoffs = (project.signoffs as JsonObject[]).filter(entry => entry.stage !== 'direction-review');
    const postVersion = (project.versions as JsonObject[]).find(v => v.n === 2)!;
    postVersion.verdicts = [];
  });

  const host = await open(root);

  const advanced = await cli(root, ['advance', 'direction-review', root, '--json']);
  expect({ exit: advanced.exit, stderr: advanced.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root).stage).toBe('direction-review');
  expect(declared(root, host)).toEqual([
    { kind: 'review-verdict', stage: 'direction-review' },
    { kind: 'signoff', stage: 'direction-review' },
  ]);

  const verdictAsk = await ask(host, { kind: 'review-verdict', stage: 'direction-review' });
  const signoffAsk = await ask(host, { kind: 'signoff', stage: 'direction-review' });
  expect([verdictAsk.ok, signoffAsk.ok]).toEqual([true, true]);

  const { act } = await page(host);
  const verdict = await act(String(verdictAsk.value.askId), 'review-verdict', { stage: 'direction-review', verdict: 'approved', words: WORDS });
  const signed = await act(String(signoffAsk.value.askId), 'signoff', { stage: 'direction-review', decision: 'approved', words: WORDS });

  const reviewed = await cli(root, ['review', '2', root, '--from-review', verdict.actId, '--json']);
  expect({ exit: reviewed.exit, stderr: reviewed.stderr }).toEqual({ exit: 0, stderr: '' });
  const signoffRes = await cli(root, ['signoff', 'direction-review', root, '--from-review', signed.actId, '--json']);
  expect({ exit: signoffRes.exit, stderr: signoffRes.stderr }).toEqual({ exit: 0, stderr: '' });

  const generationBeforeAccepted = host.session.status().generation;
  const toAccepted = await cli(root, ['advance', 'accepted', root, '--json']);
  expect({ exit: toAccepted.exit, stderr: toAccepted.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root).stage).toBe('accepted');
  expect(host.session.status().generation).toBe(generationBeforeAccepted);
  const report = checkProject(root, undefined, { now: Date.now() });
  expect(report.refusals).toEqual([]);
  expect(report.holes ?? []).toEqual([]);
});

test('forced publish failure after advance commits project.json, leaves JOB_PUBLISH_PENDING in the outbox, and job reconcile recovers it', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });

  const host = await open(root);
  const binding = readWriterBinding(root)!;
  writePrivateJson(join(root, JOB_BINDING_FILE), { ...binding, listenerIncarnation: 'offline-incarnation' }, true);

  const advanced = await cli(root, ['advance', 'rig-review', root, '--json']);
  expect(advanced.exit).toBe(1);
  expect(advanced.stderr).toContain('JOB_PUBLISH_PENDING');
  expect(read(root).stage).toBe('rig-review');
  expect(pendingPublications(root)).toHaveLength(1);
  expect(pendingPublications(root)[0]!.phase).toBe('pending');

  const checkWhilePending = await cli(root, ['interview', root, '--check', '--json']);
  expect(checkWhilePending.exit).toBe(1);
  const parsedPending = JSON.parse(checkWhilePending.stdout) as { refusals: unknown[]; holes: { code: string }[] };
  expect(parsedPending.refusals).toEqual([]);
  expect(parsedPending.holes.map(h => h.code)).toEqual(['JOB_PUBLISH_PENDING']);

  writePrivateJson(join(root, JOB_BINDING_FILE), binding, true);

  const reconciled = await cli(root, ['job', 'reconcile', root]);
  expect({ exit: reconciled.exit, stderr: reconciled.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(reconciled.stdout.trim()).toBe('job: reconciled 1 publication(s)');
  expect(pendingPublications(root)).toEqual([]);

  const checkAfterReconcile = await cli(root, ['interview', root, '--check', '--json']);
  expect(checkAfterReconcile.exit).toBe(0);
  expect(declared(root, host)).toEqual([
    { kind: 'review-verdict', stage: 'rig-review' },
    { kind: 'signoff', stage: 'rig-review' },
  ]);

  const signoffAsked = await ask(host, { kind: 'signoff', stage: 'rig-review' });
  expect(signoffAsked.ok).toBe(true);
});

test('advance rig-review without a bound job preserves unbound behavior and creates no private job directory', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });

  const advanced = await cli(root, ['advance', 'rig-review', root, '--json']);
  expect({ exit: advanced.exit, stderr: advanced.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(read(root).stage).toBe('rig-review');
  expect(existsSync(jobPrivateRoot(root))).toBe(false);
});

test('advance rig-review on a bound job refuses before writing when no live rig version exists', async () => {
  const root = copy('3-rig-review', project => {
    project.stage = 'rigging';
    project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  });
  await open(root);
  const withoutVersions = read(root);
  withoutVersions.versions = [];
  write(root, withoutVersions);
  const beforeBytes = readFileSync(join(root, 'project.json'));

  const advanced = await cli(root, ['advance', 'rig-review', root, '--json']);
  expect(advanced.exit).toBe(1);
  expect(advanced.stderr).toContain('JOB_PUBLICATION_INVALID');
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeBytes);
  expect(pendingPublications(root)).toEqual([]);
});
