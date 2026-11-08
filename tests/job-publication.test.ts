import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startJobHost, type JobOwnerHost } from '@rig-c/review/job-host';
import { closeCreateJob, openCreateJob, publishPending, reconcileCreateJob } from '../src/job-host.ts';
import { acquireJobLock, cancelUncommittedIntent, enqueuePublication, failPublication, JOB_BINDING_FILE, jobHash, jobPrivateRoot, pendingPublications, readWriterBinding, reconcilePublication } from '../src/job-outbox.ts';
import { prepareVersionIntent } from '../src/job-writer.ts';
import { partsEnumerator, prepareLiveManifest, readPublished } from '../src/job-publication.ts';
import { checkProject, formatReport } from '../src/check.ts';
import { refuse } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';

const roots: string[] = [];
const hosts: JobOwnerHost[] = [];
const now = Date.parse('2026-11-08T00:00:00Z');
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

function setup(): { root: string; project: JsonObject } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-test-')));
  roots.push(root);
  const project: JsonObject = { schema: 'rig-create/project@0', stage: 'interview', stage_values: [],
    interview: {}, plan: { steps: [] }, versions: [{ n: 1, kind: 'rig' }] };
  const put = (path: string, bytes: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  put('project.json', JSON.stringify(project));
  cpSync(join(import.meta.dir, 'fixtures/rig-registration/build'), join(root, 'derived/review/v1/out/check/build'), { recursive: true });
  const png = readFileSync(join(import.meta.dir, 'fixtures/rig-registration/build/rectangle.png'));
  put('derived/review/v1/out/parts.json', JSON.stringify({ rig_size: [8, 16], scale_rig_per_source: 1, ghost_px: {},
    painting_in_rig: { path: 'painting_in_rig.png', sha256: jobHash(png), resample: 'lanczos3-rgb-opaque' },
    parts: [{ name: 'rectangle', from: 'painting:rectangle', x: 0, y: 0, w: 8, h: 16, opaque_px: 128,
      projected_core_px: 128, source_px_taken: 128, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 }] }));
  put('derived/review/v1/out/parts/rectangle.png', png);
  put('derived/review/v1/out/painting_in_rig.png', png);
  (project.versions as JsonObject[])[0].review_package = { files: ['out/parts.json', 'out/painting_in_rig.png', 'out/parts/rectangle.png',
    ...['rectangle.png', 'skeleton.json', 'skeleton.model.json', 'skeleton.atlas'].map(name => `out/check/build/${name}`)]
    .map(path => ({ path, sha256: jobHash(readFileSync(join(root, 'derived/review/v1', path))) })) };
  put('project.json', JSON.stringify(project));
  return { root, project };
}

async function bound() {
  const { root, project } = setup();
  const host = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(host);
  const binding = readWriterBinding(root)!;
  const path = prepareLiveManifest(root, project, 1);
  const entry = enqueuePublication(root, binding, { path, selector: { kind: 'rig', version: 1 } });
  return { root, project, host, binding, entry };
}

test('bound publication retains the committed record hash and the exact parts rows', async () => {
  const { root, host, entry } = await bound();
  await readPublished({ root, record: { path: 'project.json', sha256: entry.recordHash }, result: entry.result });
  await reconcilePublication(root, entry, publishPending);
  const status = host.session.status();
  expect(status.generation).toBe(1);
  expect(status.publication?.source.projectHash).toBe(entry.recordHash);
  expect(status.publication?.source.parts?.images.map(row => ({ path: row.path, role: row.role })))
    .toEqual(partsEnumerator.enumerate(join(root, 'derived/review/v1/out')));
  const cancellation = new AbortController();
  const events = host.ports.subscribeJob({ jobId: host.session.jobId, after: null, signal: cancellation.signal })[Symbol.asyncIterator]();
  const update = await events.next();
  expect(update.value?.type).toBe('published');
  if (update.value?.type === 'published') expect(update.value.publication.source.projectHash).toBe(entry.recordHash);
  cancellation.abort();
  await events.return?.();
  expect(pendingPublications(root)).toEqual([]);
});

test('binding is private, ignored and unstaged in a tracked project', async () => {
  const { root } = setup();
  for (const args of [['init', '-q'], ['add', 'project.json']]) {
    expect(Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
  }
  const host = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(host);
  expect(lstatSync(join(root, JOB_BINDING_FILE)).mode & 0o077).toBe(0);
  expect(Bun.spawnSync(['git', 'check-ignore', JOB_BINDING_FILE], { cwd: root }).exitCode).toBe(0);
  expect(Bun.spawnSync(['git', 'ls-files', JOB_BINDING_FILE], { cwd: root }).stdout.toString()).toBe('');
  expect(JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')).review_job).toEqual({ jobId: host.session.jobId, origin: host.origin });
});

test('failed publication is a named check HOLE and reconciliation clears it without changing the record', async () => {
  const { root, entry } = await bound();
  const before = readFileSync(join(root, 'project.json'));
  failPublication(root, entry, { code: 'JOB_SOURCE_MISMATCH', message: 'project.json: planted failure' });
  const report = checkProject(root, undefined, { now });
  expect(report.holes?.map(hole => hole.code)).toEqual(['JOB_PUBLISH_PENDING']);
  expect(formatReport(report)).toContain('HOLE JOB_PUBLISH_PENDING');
  expect(await reconcileCreateJob(root)).toBe(1);
  expect(checkProject(root, undefined, { now }).holes ?? []).toEqual([]);
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
});

test('stateDir mismatch records both values in a pending receipt and publishes nothing', async () => {
  const { root, host, entry } = await bound();
  const requested = { ...entry.identity, stateDir: `${entry.identity.stateDir}-different` };
  await expect(reconcileCreateJob(root, item => publishPending(item, requested))).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  const failure = pendingPublications(root)[0].failure!;
  expect(failure.code).toBe('JOB_HOST_REUSE_MISMATCH');
  expect(failure.message).toContain('stateDir');
  expect(failure.message).toContain(requested.stateDir);
  expect(failure.message).toContain(entry.identity.stateDir);
  expect(existsSync(requested.stateDir)).toBe(false);
  expect(host.session.status().generation).toBe(0);
});

test('a copied binding refuses the actual root instead of publishing the original project', async () => {
  const { host, binding } = await bound();
  const { root } = setup();
  enqueuePublication(root, binding, { path: 'review-live-v1.json', selector: { kind: 'rig', version: 1 } });
  await expect(reconcileCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  expect(pendingPublications(root)[0].failure?.code).toBe('JOB_HOST_REUSE_MISMATCH');
  expect(pendingPublications(root)[0].failure?.message).toContain('root');
  expect(host.session.status().generation).toBe(0);
});

test('check preserves a live precommit intent and refusal cancels it without a project write', async () => {
  const { root } = setup();
  const host = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(host);
  const original = readFileSync(join(root, 'project.json'));
  const release = acquireJobLock(root)!;
  const intent = prepareVersionIntent(root, Buffer.from(`${original.toString()}\n`), 1)!;
  const path = join(jobPrivateRoot(root), 'outbox', `${intent.id}.json`);
  try {
    expect(checkProject(root, undefined, { now }).holes ?? []).toEqual([]);
    expect(existsSync(path)).toBe(true);
    cancelUncommittedIntent(root, intent);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(root, 'project.json'))).toEqual(original);
  } finally { release(); }
});

test('host loss after preflight stops the replacement and leaves a named pending receipt', async () => {
  const { root, host, entry } = await bound();
  await expect(reconcileCreateJob(root, item => publishPending(item, undefined, () => host.stop())))
    .rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  const failure = pendingPublications(root)[0].failure!;
  expect(failure.code).toBe('JOB_HOST_REUSE_MISMATCH');
  expect(failure.message).toContain('host incarnation');
  const fresh = await startJobHost({ ...entry.identity, readPublished, partsEnumerator,
    installWriterBinding: () => {}, partsEnumeratorId: entry.identity.partsEnumeratorId });
  hosts.push(fresh);
  expect(fresh.reused).toBe(false);
  expect(fresh.session.status().generation).toBe(0);
});

test('a changed live listener reader ID preserves the public mismatch field and values', async () => {
  const { root, entry, host } = await bound();
  host.stop();
  const changed = await startJobHost({ ...entry.identity, readerId: 'changed-reader', readPublished, partsEnumerator, installWriterBinding: () => {} });
  hosts.push(changed);
  await expect(reconcileCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  const failure = pendingPublications(root)[0].failure!;
  expect(failure.code).toBe('JOB_HOST_REUSE_MISMATCH');
  expect(failure.message).toContain('readPublished');
  expect(failure.message).toContain('changed-reader');
  expect(failure.message).toContain(entry.identity.readerId);
  expect(changed.session.status().generation).toBe(0);
});

test('reconcile refuses stale committed bytes and preserves the receipt', async () => {
  const { root } = await bound();
  writeFileSync(join(root, 'project.json'), `${readFileSync(join(root, 'project.json'), 'utf8')}\n`);
  await expect(reconcileCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  expect(pendingPublications(root)[0].failure?.code).toBe('JOB_PUBLICATION_STALE');
});

test('lost acknowledgment replays the same request without a second publication', async () => {
  const { root, host } = await bound();
  await expect(reconcileCreateJob(root, async entry => {
    await publishPending(entry);
    refuse('JOB_PUBLISH_PENDING', 'project.json: planted acknowledgment loss');
  })).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  expect(host.session.status().generation).toBe(1);
  expect(await reconcileCreateJob(root)).toBe(1);
  expect(host.session.status().generation).toBe(1);
  expect(pendingPublications(root)).toEqual([]);
});

test('explicit close removes the fetch binding and the next incarnation gets a fresh grant', async () => {
  const { root } = setup();
  const first = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(first);
  const original = readWriterBinding(root)!;
  await closeCreateJob(root);
  expect(first.session.status().status).toBe('closed');
  expect(readWriterBinding(root)).toBeNull();
  const next = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(next);
  expect(next.session.jobId === original.jobId).toBe(false);
  expect(readWriterBinding(root)!.fetchCapability === original.fetchCapability).toBe(false);
});

test('public job CLI opens and explicitly closes its foreground host', async () => {
  const { root } = setup();
  const cli = join(import.meta.dir, '../src/cli.ts');
  const opening = Bun.spawn([process.execPath, cli, 'job', 'open', root, '--reviewer', 'reviewer', '--role', 'owner'], {
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const output = opening.stdout.getReader();
    const first = await output.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value).startsWith('http://127.0.0.1:')).toBe(true);
    expect(readWriterBinding(root) !== null).toBe(true);
    const closing = Bun.spawn([process.execPath, cli, 'job', 'close', root], { stdout: 'pipe', stderr: 'pipe' });
    expect(await closing.exited).toBe(0);
    expect(await new Response(closing.stderr).text()).toBe('');
    expect(await opening.exited).toBe(0);
    expect(readWriterBinding(root)).toBeNull();
    await output.cancel();
  } finally {
    if (readWriterBinding(root)) await closeCreateJob(root);
    if (opening.exitCode === null) opening.kill();
  }
});

test('Review names the scene-answer publication boundary before invoking the producer reader', async () => {
  const { root, host } = await bound();
  const options = { schema: 'rig-create/interview-options@1', id: 'scene-options', question: 'post_timing', stage: 'post-interview',
    drafted_by: 'agent', drafted_at: '2026-11-06T00:00:00Z', context: { kind: 'scene' }, assembly: { rule: 'single' },
    asks: [{ id: 'timing', prompt: 'Choose timing', options: [
      { id: 'first', kind: 'value', label: 'First', effect: 'First timing', recommended: true, reason: 'Simple', fragment: 1 },
      { id: 'second', kind: 'value', label: 'Second', effect: 'Second timing', recommended: false, fragment: 2 },
      { id: 'other', kind: 'other', label: 'Other', effect: 'Describe timing', recommended: false },
      { id: 'auto', kind: 'auto', label: 'Auto', effect: 'Delegate timing', recommended: false },
    ] }] };
  const optionBytes = Buffer.from(JSON.stringify(options));
  writeFileSync(join(root, 'scene-options.json'), optionBytes);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  project.interview = { post: { items: [{ id: 'post_timing', guide: { at: '2026-11-07T00:00:00Z',
    choice: { spec: 'rig-create/interview-choice@1', set: { path: 'scene-options.json', sha256: jobHash(optionBytes) } } } }] } };
  writeFileSync(join(root, 'project.json'), JSON.stringify(project));
  const entry = enqueuePublication(root, readWriterBinding(root)!, { path: 'review-live-v1.json', selector: { kind: 'rig', version: 1 } });
  await expect(publishPending(entry)).rejects.toMatchObject({ code: 'JOB_RECORD_INCOMPLETE' });
  expect(host.session.status().generation).toBe(0);
});

test.each(['drop', 'reorder', 'version'])('review refuses the C4 %s control', async control => {
  const { root, entry, host } = await bound();
  // The valid two-row fixture makes positional reordering observable.
  const corrupt: typeof readPublished = async input => {
    const context = await readPublished(input);
    const identity = context.parts!;
    const images = [...identity.images];
    if (control === 'drop') images.pop();
    if (control === 'reorder') images.reverse();
    return { ...context, parts: { ...identity, images, enumeratorVersion: control === 'version' ? '3.0.0' : identity.enumeratorVersion } };
  };
  host.stop();
  const corruptedHost = await startJobHost({ ...entry.identity, readPublished: corrupt, partsEnumerator,
    installWriterBinding: () => {} });
  hosts.push(corruptedHost);
  const response = await corruptedHost.ports.handleJobApi(new Request(`${corruptedHost.origin}/jobs/${entry.jobId}/api`, {
    method: 'POST', headers: { authorization: `Bearer ${corruptedHost.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: entry.identity.apiSchema, verb: 'publish', jobId: entry.jobId, requestId: entry.id,
      idempotencyKey: entry.id, expectedGeneration: 0, result: entry.result,
      freeze: { kind: 'producer-held', holdId: entry.id, record: { path: 'project.json', sha256: entry.recordHash } } }),
  }));
  const result = await response.json() as { ok: boolean; error: { code: string; detail: string } };
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe(control === 'version' ? 'JOB_SOURCE_UNRETAINABLE' : 'JOB_SOURCE_MISMATCH');
  expect(corruptedHost.session.status().generation).toBe(0);
});

test('unbound writer publishes nothing and allocates no outbox', async () => {
  const { root } = setup();
  const { publishCommittedVersion } = await import('../src/job-writer.ts');
  publishCommittedVersion(root, 1);
  expect(existsSync(jobPrivateRoot(root))).toBe(false);
  expect(existsSync(join(root, 'review-live-v1.json'))).toBe(false);
});

test.each(['before-commit', 'after-commit'])('process kill %s recovers the durable intent', async phase => {
  const { root } = setup();
  const host = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(host);
  const original = readFileSync(join(root, 'project.json'));
  const candidate = Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), title: 'Intent crash control' }));
  const worker = `
    import { readFileSync, writeFileSync, renameSync } from 'node:fs';
    import { join } from 'node:path';
    import { acquireJobLock } from ${JSON.stringify(join(import.meta.dir, '../src/job-outbox.ts'))};
    import { prepareVersionIntent } from ${JSON.stringify(join(import.meta.dir, '../src/job-writer.ts'))};
    const {root, bytes, phase} = JSON.parse(readFileSync(0, 'utf8'));
    acquireJobLock(root);
    const candidate = Buffer.from(bytes);
    prepareVersionIntent(root, candidate, 1);
    if (phase === 'after-commit') {
      writeFileSync(join(root, 'project.crash-control'), candidate);
      renameSync(join(root, 'project.crash-control'), join(root, 'project.json'));
    }
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = Bun.spawn([process.execPath, '--eval', worker], {
    stdin: new Blob([JSON.stringify({ root, bytes: [...candidate], phase })]), stdout: 'pipe', stderr: 'pipe',
  });
  await child.exited;
  expect(child.signalCode).toBe('SIGKILL');
  const report = checkProject(root, undefined, { now });
  if (phase === 'before-commit') {
    expect(report.holes ?? []).toEqual([]);
    expect(readFileSync(join(root, 'project.json'))).toEqual(original);
    const discarded = JSON.parse(readFileSync(join(jobPrivateRoot(root), 'discarded-intents.jsonl'), 'utf8').trim());
    expect(discarded.recordHash).toBe(jobHash(candidate));
    expect(discarded.id).toMatch(/^[a-f0-9]{64}$/);
    expect(await reconcileCreateJob(root)).toBe(0);
  } else {
    expect(report.holes?.map(hole => hole.code)).toEqual(['JOB_PUBLISH_PENDING']);
    expect(readFileSync(join(root, 'project.json'))).toEqual(candidate);
    expect(await reconcileCreateJob(root)).toBe(1);
    expect(checkProject(root, undefined, { now }).holes ?? []).toEqual([]);
    expect(host.session.status().publication?.source.projectHash).toBe(jobHash(candidate));
    expect(readFileSync(join(root, 'project.json'))).toEqual(candidate);
  }
});
