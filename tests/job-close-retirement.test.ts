import { afterEach, expect, test } from 'bun:test';
import { Database, constants as sqlite } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startJobHost, type JobHostOptions, type JobOwnerHost } from '@rig-c/review/job-host';
import {
  attachCreateJobForClose,
  closeHostOptions,
  failClosedCloseEnumerate,
  failClosedCloseInstallBinding,
  failClosedCloseReadPublished,
} from '../src/job-close.ts';
import { attachCreateJob, closeCreateJob, openCreateJob, openRecordPublication, publishPending, reconcileCreateJob } from '../src/job-host.ts';
import { reportOwnerSubmitRefusal } from '../src/job-refusal.ts';
import {
  enqueuePublication,
  failPublication,
  JOB_BINDING_FILE,
  jobHash,
  jobHostStateRoot,
  jobPrivateRoot,
  pendingPublications,
  readWriterBinding,
  writePrivateJson,
  type WriterBinding,
} from '../src/job-outbox.ts';
import { currentJobIdentity, partsEnumerator, prepareLiveManifest } from '../src/job-publication.ts';
import type { JsonObject } from '../src/templates.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
const now = Date.parse('2026-11-08T00:00:00Z');
const OLD_ENUMERATOR_VERSION = '2.35.0';
const OLD_READER_ID = 'rig-create/publication-reader/1';

const roots: string[] = [];
const hosts: JobOwnerHost[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

function setupProject(): { root: string; project: JsonObject } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-close-retire-')));
  roots.push(root);
  const project: JsonObject = {
    schema: 'rig-create/project@0',
    owner: { language: 'en' },
    stage: 'interview',
    stage_values: [],
    interview: {},
    plan: { steps: [] },
    versions: [{ n: 1, kind: 'rig' }],
  };
  const put = (path: string, bytes: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  put('project.json', `${JSON.stringify(project, null, 2)}\n`);
  cpSync(join(import.meta.dir, 'fixtures/rig-registration/build'), join(root, 'derived/review/v1/out/check/build'), { recursive: true });
  const png = readFileSync(join(import.meta.dir, 'fixtures/rig-registration/build/rectangle.png'));
  project.inputs = [{ path: 'derived/review/v1/out/painting_in_rig.png', sha256: jobHash(png), bytes: png.length }];
  put('derived/review/v1/out/parts.json', JSON.stringify({
    rig_size: [8, 16],
    scale_rig_per_source: 1,
    ghost_px: {},
    painting_in_rig: { path: 'painting_in_rig.png', sha256: jobHash(png), resample: 'lanczos3-rgb-opaque' },
    parts: [{
      name: 'rectangle',
      from: 'painting:rectangle',
      x: 0,
      y: 0,
      w: 8,
      h: 16,
      opaque_px: 128,
      projected_core_px: 128,
      source_px_taken: 128,
      refused_drift_px: 0,
      merged_px: 0,
      seam_override_px: 0,
    }],
  }));
  put('derived/review/v1/out/parts/rectangle.png', png);
  put('derived/review/v1/out/painting_in_rig.png', png);
  (project.versions as JsonObject[])[0].review_package = {
    files: [
      'out/parts.json',
      'out/painting_in_rig.png',
      'out/parts/rectangle.png',
      ...['rectangle.png', 'skeleton.json', 'skeleton.model.json', 'skeleton.atlas'].map(name => `out/check/build/${name}`),
    ].map(path => ({ path, sha256: jobHash(readFileSync(join(root, 'derived/review/v1', path))) })),
  };
  put('project.json', `${JSON.stringify(project, null, 2)}\n`);
  return { root, project };
}

/**
 * Start a real Review 2.7.0 host bound with an older enumerator version (and optional older readerId),
 * installing the private WriterBinding and project.json review_job exactly as `job open` did before a pin bump.
 */
async function openLegacyBoundHost(
  root: string,
  overrides: { enumeratorVersion?: string; readerId?: string } = {},
): Promise<{ host: JobOwnerHost; binding: WriterBinding }> {
  const enumeratorVersion = overrides.enumeratorVersion ?? OLD_ENUMERATOR_VERSION;
  const readerId = overrides.readerId ?? 'rig-create/publication-reader/2';
  expect(enumeratorVersion).not.toBe(partsEnumerator.version);

  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, now, async (opts: JobHostOptions) => {
    return await startJobHost({
      ...opts,
      readerId,
      partsEnumerator: {
        version: enumeratorVersion,
        enumerate: partsEnumerator.enumerate,
      },
    });
  });
  hosts.push(host);
  const currentBinding = readWriterBinding(root)!;
  const legacyBinding: WriterBinding = {
    ...currentBinding,
    identity: {
      ...currentBinding.identity,
      readerId,
      enumeratorVersion,
    },
  };
  writePrivateJson(join(root, JOB_BINDING_FILE), legacyBinding, true);
  return { host, binding: readWriterBinding(root)! };
}

test('closeHostOptions wires fail-closed callbacks so close attach can never serve old identity with new producer logic', async () => {
  const { root } = setupProject();
  const { host, binding } = await openLegacyBoundHost(root, {
    enumeratorVersion: OLD_ENUMERATOR_VERSION,
    readerId: OLD_READER_ID,
  });
  const opts = closeHostOptions(binding);
  expect(opts.readerId).toBe(OLD_READER_ID);
  expect(opts.partsEnumerator?.version).toBe(OLD_ENUMERATOR_VERSION);
  expect(opts.readPublished).toBe(failClosedCloseReadPublished);
  expect(opts.partsEnumerator?.enumerate).toBe(failClosedCloseEnumerate);
  expect(opts.installWriterBinding).toBe(failClosedCloseInstallBinding);
  expect(opts.onRefusal).toBe(reportOwnerSubmitRefusal);

  await expect(opts.readPublished!({
    root,
    record: { path: 'project.json', sha256: '0'.repeat(64) },
    result: { path: 'review-live-v1.json', selector: { kind: 'rig', version: 1 } },
  })).rejects.toMatchObject({ code: 'JOB_HOST_REUSE_MISMATCH' });
  expect(() => opts.partsEnumerator!.enumerate(root)).toThrow(expect.objectContaining({ code: 'JOB_HOST_REUSE_MISMATCH' }));
  await expect(opts.installWriterBinding!({
    jobId: binding.jobId,
    origin: binding.origin,
    fetchCapability: binding.fetchCapability,
  })).rejects.toMatchObject({ code: 'JOB_HOST_REUSE_MISMATCH' });

  const attached = await attachCreateJobForClose(root, binding);
  try {
    expect(attached.reused).toBe(true);
    expect(attached.session.jobId).toBe(binding.jobId);
    expect(() => attached.session.authorize('consumer', `Bearer ${binding.fetchCapability}`)).not.toThrow();
    expect(() => attached.session.authorize('consumer', `Bearer ${'0'.repeat(64)}`)).toThrow();
  } finally {
    attached.stop();
  }
  expect(host.session.status().status).toBe('active');
});

test('closeCreateJob retires a live host bound with an older enumeratorVersion and readerId, revokes the grant, and keeps project.json byte-identical while normal attach/reconcile stay strict', async () => {
  const { root, project } = setupProject();
  const { host, binding } = await openLegacyBoundHost(root, {
    enumeratorVersion: OLD_ENUMERATOR_VERSION,
    readerId: OLD_READER_ID,
  });
  const beforeProjectBytes = readFileSync(join(root, 'project.json'));
  const beforeProjectSha256 = jobHash(beforeProjectBytes);

  // Normal attach / publish / reconcile must stay strict against the current identity.
  const manifestPath = prepareLiveManifest(root, project, 1);
  const entry = enqueuePublication(root, binding, { path: manifestPath, selector: { kind: 'rig', version: 1 } });
  await expect(attachCreateJob(entry)).rejects.toMatchObject({ code: 'JOB_HOST_REUSE_MISMATCH' });
  await expect(publishPending(entry)).rejects.toMatchObject({ code: 'JOB_HOST_REUSE_MISMATCH' });
  await expect(reconcileCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  expect(pendingPublications(root)[0]?.failure?.code).toBe('JOB_HOST_REUSE_MISMATCH');
  expect(host.session.status().generation).toBe(0);
  expect(host.session.status().status).toBe('active');

  // Pending publication blocks close until reconciled or cleared.
  await expect(closeCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  expect(host.session.status().status).toBe('active');

  // Clear the synthetic pending receipt so close can proceed.
  rmSync(join(jobPrivateRoot(root), 'outbox'), { recursive: true, force: true });

  // Before close, the consumer fetchCapability is authorized on the live session.
  expect(() => host.session.authorize('consumer', `Bearer ${binding.fetchCapability}`)).not.toThrow();
  expect(host.session.writerGrant()).toEqual({ jobId: binding.jobId, fetchCapability: binding.fetchCapability });

  // Close-specific retirement succeeds using the stored binding and valid close authority.
  await closeCreateJob(root);
  expect(host.session.status().status).toBe('closed');
  expect(() => host.session.authorize('consumer', `Bearer ${binding.fetchCapability}`)).toThrow();
  expect(() => host.session.writerGrant()).toThrow();
  const postCloseFetch = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${binding.jobId}/api`, {
    method: 'POST',
    headers: { authorization: `Bearer ${binding.fetchCapability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: 'rig-review/job-api@2', verb: 'fetch-act', jobId: binding.jobId, actId: 'act-1', requestId: 'req-1' }),
  }));
  expect((await postCloseFetch.json() as { ok: boolean; error?: { code: string } })).toMatchObject({
    ok: false,
    error: { code: 'JOB_CLOSED' },
  });
  expect(readWriterBinding(root)).toBeNull();
  const afterProjectBytes = readFileSync(join(root, 'project.json'));
  expect(afterProjectBytes).toEqual(beforeProjectBytes);
  expect(jobHash(afterProjectBytes)).toBe(beforeProjectSha256);

  // Subsequent open at the current pin succeeds with a fresh jobId and fetchCapability.
  const next = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, now);
  hosts.push(next);
  const nextBinding = readWriterBinding(root)!;
  expect(next.session.jobId).not.toBe(binding.jobId);
  expect(nextBinding.fetchCapability).not.toBe(binding.fetchCapability);
  expect(nextBinding.identity.enumeratorVersion).toBe(partsEnumerator.version);
  expect(nextBinding.identity.readerId).toBe(currentJobIdentity(nextBinding.identity, root).readerId);
});

test('CLI job close retires a live host bound with an older enumeratorVersion and keeps project.json byte-identical', async () => {
  const { root } = setupProject();
  const { host, binding } = await openLegacyBoundHost(root, { enumeratorVersion: '2.45.0' });
  const beforeProjectBytes = readFileSync(join(root, 'project.json'));
  const beforeProjectSha256 = jobHash(beforeProjectBytes);

  expect(host.session.status().generation).toBe(0);
  const reuse = Bun.spawnSync([
    process.execPath, CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner',
  ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(reuse.exitCode).toBe(1);
  const detail = reuse.stderr.toString();
  expect(detail).toContain('JOB_HOST_REUSE_MISMATCH');
  expect(detail).toContain('enumeratorVersion expected="2.45.0" found=' + JSON.stringify(partsEnumerator.version));
  expect(detail).toContain('if the change was unintended, restore the bound host configuration');
  expect(detail).toContain('For an intended pin or hook bump, follow job retirement (docs/JOB-RETIREMENT.md): run rig-create job close <project>');
  expect(host.session.writerGrant()).toEqual({ jobId: binding.jobId, fetchCapability: binding.fetchCapability });
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeProjectBytes);

  const child = Bun.spawn([process.execPath, CLI, 'job', 'close', root], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exit, stdout: stdout.trim(), stderr }).toEqual({ exit: 0, stdout: 'job: closed', stderr: '' });
  expect(host.session.status().status).toBe('closed');
  expect(() => host.session.authorize('consumer', `Bearer ${binding.fetchCapability}`)).toThrow();
  expect(readWriterBinding(root)).toBeNull();
  const afterProjectBytes = readFileSync(join(root, 'project.json'));
  expect(afterProjectBytes).toEqual(beforeProjectBytes);
  expect(jobHash(afterProjectBytes)).toBe(beforeProjectSha256);
});

test('wrong or copied root, replaced root inode, tampered descriptor/binding fields, and wrong close authority refuse before retiring a host, and only a matching binding is removed', async () => {
  const { root: originalRoot } = setupProject();
  const { host: originalHost, binding: originalBinding } = await openLegacyBoundHost(originalRoot, {
    enumeratorVersion: OLD_ENUMERATOR_VERSION,
  });

  // 1. Direct copied binding in another root refuses JOB_HOST_REUSE_MISMATCH on root without contacting or retiring originalHost.
  const { root: copyRoot } = setupProject();
  cpSync(join(originalRoot, 'project.json'), join(copyRoot, 'project.json'));
  writePrivateJson(join(copyRoot, JOB_BINDING_FILE), originalBinding, true);
  const copyBeforeBytes = readFileSync(join(copyRoot, 'project.json'));
  let contactedHost = false;
  await expect(closeCreateJob(copyRoot, async opts => {
    contactedHost = true;
    return await startJobHost(opts);
  })).rejects.toMatchObject({
    code: 'JOB_HOST_REUSE_MISMATCH',
    message: expect.stringContaining('root'),
  });
  expect(contactedHost).toBe(false);
  expect(originalHost.session.status().status).toBe('active');
  expect(readFileSync(join(copyRoot, 'project.json'))).toEqual(copyBeforeBytes);

  // 2. Copied binding with tampered identity.root = copyRoot still pointing at originalHost stateDir/jobId/origin refuses on root in local SQLite check before retiring originalHost.
  writePrivateJson(join(copyRoot, JOB_BINDING_FILE), {
    ...originalBinding,
    identity: { ...originalBinding.identity, root: copyRoot },
  }, true);
  await expect(closeCreateJob(copyRoot)).rejects.toMatchObject({
    code: 'JOB_HOST_REUSE_MISMATCH',
    message: expect.stringContaining('root'),
  });
  expect(originalHost.session.status().status).toBe('active');

  // 3. Wrong close authority (tampered fetchCapability) on the bound root refuses JOB_BINDING_INVALID before close and preserves active host + binding.
  const originalBeforeBytes = readFileSync(join(originalRoot, 'project.json'));
  writePrivateJson(join(originalRoot, JOB_BINDING_FILE), {
    ...originalBinding,
    fetchCapability: '0'.repeat(64),
  }, true);
  await expect(closeCreateJob(originalRoot)).rejects.toMatchObject({
    code: 'JOB_BINDING_INVALID',
  });
  expect(originalHost.session.status().status).toBe('active');
  expect(existsSync(join(originalRoot, JOB_BINDING_FILE))).toBe(true);
  expect(readFileSync(join(originalRoot, 'project.json'))).toEqual(originalBeforeBytes);

  // 4. Missing listenerIncarnation (pre-incarnation binding shape) refuses JOB_HOST_REUSE_MISMATCH, and an unsupported enumeratorVersion refuses JOB_BINDING_INVALID via Review's contract parser without retiring originalHost.
  const withoutIncarnation = { ...originalBinding } as Record<string, unknown>;
  delete withoutIncarnation.listenerIncarnation;
  writePrivateJson(join(originalRoot, JOB_BINDING_FILE), withoutIncarnation, true);
  await expect(closeCreateJob(originalRoot)).rejects.toMatchObject({
    code: 'JOB_HOST_REUSE_MISMATCH',
    message: expect.stringContaining('listenerIncarnation'),
  });
  expect(originalHost.session.status().status).toBe('active');

  writePrivateJson(join(originalRoot, JOB_BINDING_FILE), {
    ...originalBinding,
    identity: { ...originalBinding.identity, enumeratorVersion: '2.24.0' },
  }, true);
  await expect(closeCreateJob(originalRoot)).rejects.toMatchObject({
    code: 'JOB_BINDING_INVALID',
  });
  expect(originalHost.session.status().status).toBe('active');

  // 5. Wrong listenerIncarnation, origin, jobId, stateDir, descriptor fields (readerId, partsEnumeratorVersion), or reviewer refuses without retiring originalHost.
  for (const [label, mutated, expectedCode] of [
    ['listenerIncarnation', { ...originalBinding, listenerIncarnation: '33333333-3333-4333-8333-333333333333' }, 'JOB_HOST_REUSE_MISMATCH'],
    ['origin', { ...originalBinding, origin: 'http://127.0.0.1:43199' }, 'JOB_HOST_REUSE_MISMATCH'],
    ['jobId', { ...originalBinding, jobId: 'job-unrelated-id' }, 'JOB_HOST_REUSE_MISMATCH'],
    ['readerId', { ...originalBinding, identity: { ...originalBinding.identity, readerId: 'rig-create/publication-reader/999' } }, 'JOB_HOST_REUSE_MISMATCH'],
    ['partsEnumeratorVersion', { ...originalBinding, identity: { ...originalBinding.identity, enumeratorVersion: '2.34.0' } }, 'JOB_HOST_REUSE_MISMATCH'],
    ['reviewer.id', { ...originalBinding, identity: { ...originalBinding.identity, reviewer: { id: 'other-user', role: 'owner' as const } } }, 'JOB_HOST_REUSE_MISMATCH'],
    ['reviewer.role', { ...originalBinding, identity: { ...originalBinding.identity, reviewer: { id: 'synthetic-owner', role: 'delegate' as const } } }, 'JOB_HOST_REUSE_MISMATCH'],
    ['state', { ...originalBinding, identity: { ...originalBinding.identity, stateDir: `${originalBinding.identity.stateDir}-missing` } }, 'JOB_HOST_ATTACH_REFUSED'],
  ] as const) {
    writePrivateJson(join(originalRoot, JOB_BINDING_FILE), mutated, true);
    await expect(closeCreateJob(originalRoot)).rejects.toMatchObject({
      code: expectedCode,
      message: expect.stringContaining(label),
    });
    expect(originalHost.session.status().status).toBe('active');
    expect(existsSync(join(originalRoot, JOB_BINDING_FILE))).toBe(true);
  }

  // 6. Replaced root inode at the same path refuses JOB_HOST_ATTACH_REFUSED (reason=replaced, phase=state) without retiring originalHost.
  writePrivateJson(join(originalRoot, JOB_BINDING_FILE), originalBinding, true);
  const backupRoot = `${originalRoot}-backup`;
  renameSync(originalRoot, backupRoot);
  try {
    mkdirSync(originalRoot, { mode: 0o700 });
    cpSync(join(backupRoot, 'project.json'), join(originalRoot, 'project.json'));
    writePrivateJson(join(originalRoot, JOB_BINDING_FILE), originalBinding, true);
    await expect(closeCreateJob(originalRoot)).rejects.toMatchObject({
      code: 'JOB_HOST_ATTACH_REFUSED',
      message: expect.stringContaining('reason=replaced, phase=state'),
    });
    expect(originalHost.session.status().status).toBe('active');
  } finally {
    rmSync(originalRoot, { recursive: true, force: true });
    renameSync(backupRoot, originalRoot);
  }

  // 7. If the binding on disk no longer matches the binding being closed, close refuses to delete the replacement binding.
  writePrivateJson(join(originalRoot, JOB_BINDING_FILE), originalBinding, true);
  const replacementBinding: WriterBinding = {
    ...originalBinding,
    jobId: 'job-replacement-after-attach',
  };
  await expect(closeCreateJob(originalRoot, async opts => {
    const attached = await startJobHost(opts);
    writePrivateJson(join(originalRoot, JOB_BINDING_FILE), replacementBinding, true);
    return attached;
  })).rejects.toMatchObject({ code: 'JOB_BINDING_INVALID' });
  expect(readWriterBinding(originalRoot)).toEqual(replacementBinding);
  expect(readFileSync(join(originalRoot, 'project.json'))).toEqual(originalBeforeBytes);
});


test('#535 explicit close recovery archives refused pending publications without acknowledging or changing the record', async () => {
  const { root, project } = setupProject();
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, now);
  hosts.push(host);
  const path = prepareLiveManifest(root, project, 1);
  const entry = enqueuePublication(root, readWriterBinding(root)!, { path, selector: { kind: 'rig', version: 1 } });
  const before = readFileSync(join(root, 'project.json'));
  await expect(closeCreateJob(root, undefined, true)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  failPublication(root, entry, { code: 'JOB_PUBLICATION_INVALID', message: 'project.json: planted refusal; restore retained sources' });
  await expect(closeCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING', message: expect.stringContaining('job close --retire-refused') });
  const receipt = pendingPublications(root)[0]!;
  const child = Bun.spawn([process.execPath, CLI, 'job', 'close', root, '--retire-refused'], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stdout: stdout.trim(), stderr }).toEqual({ exit: 0, stdout: 'job: closed', stderr: '' });
  expect(host.session.status().status).toBe('closed');
  expect(pendingPublications(root)).toEqual([]);
  expect(JSON.parse(readFileSync(join(jobPrivateRoot(root), 'retired-publications', `${entry.id}.json`), 'utf8'))).toEqual(receipt);
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(readWriterBinding(root)).toBeNull();
  expect(existsSync(join(jobPrivateRoot(root), 'acknowledged-publications'))).toBe(false);
});

function storedJobActive(stateDir: string, jobId: string): number | null {
  const db = new Database(join(stateDir, 'jobs.sqlite'), sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_NOFOLLOW);
  try {
    return db.query<{ active: number }, [string]>('SELECT active FROM jobs WHERE job_id=?').get(jobId)?.active ?? null;
  } finally {
    db.close();
  }
}

test('#1076 CLI job close retires a stopped host bound under an older Parts pin (store on disk and missing tmp stateDir), keeps project.json byte-identical, and reopens at the current pin', async () => {
  // 1. Stopped host with SQLite store still on disk (reason=probe, phase=record).
  const { root, project } = setupProject();
  const { host, binding } = await openLegacyBoundHost(root, { enumeratorVersion: '2.44.0' });
  const beforeBytes = readFileSync(join(root, 'project.json'));
  host.stop();
  expect(storedJobActive(binding.identity.stateDir, binding.jobId)).toBe(1);

  const openRefused = Bun.spawnSync([
    process.execPath, CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner',
  ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(openRefused.exitCode).toBe(1);
  expect(openRefused.stderr.toString()).toContain('JOB_HOST_REUSE_MISMATCH');
  expect(openRefused.stderr.toString()).toContain(`enumeratorVersion expected="2.44.0" found=${JSON.stringify(partsEnumerator.version)}`);

  // Pending outbox still blocks close on a stopped older-pin job until cleared or --retire-refused.
  const manifestPath = prepareLiveManifest(root, project, 1);
  const pendingEntry = enqueuePublication(root, binding, { path: manifestPath, selector: { kind: 'rig', version: 1 } });
  await expect(closeCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  expect(storedJobActive(binding.identity.stateDir, binding.jobId)).toBe(1);
  failPublication(root, pendingEntry, { code: 'JOB_HOST_REUSE_MISMATCH', message: 'project.json: enumerator mismatch' });
  await expect(closeCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  rmSync(join(jobPrivateRoot(root), 'outbox'), { recursive: true, force: true });

  const closedWithStore = Bun.spawnSync([process.execPath, CLI, 'job', 'close', root], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect({
    exit: closedWithStore.exitCode,
    stdout: closedWithStore.stdout.toString().trim(),
    stderr: closedWithStore.stderr.toString(),
  }).toEqual({ exit: 0, stdout: 'job: closed', stderr: '' });
  expect(storedJobActive(binding.identity.stateDir, binding.jobId)).toBe(0);
  expect(readWriterBinding(root)).toBeNull();
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeBytes);

  const reopened = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, now);
  hosts.push(reopened);
  const reopenedBinding = readWriterBinding(root)!;
  expect(reopened.session.jobId).not.toBe(binding.jobId);
  expect(reopenedBinding.identity.enumeratorVersion).toBe(partsEnumerator.version);
  await closeCreateJob(root);

  // 2. Stopped host after TMPDIR removed the canonical managed stateDir (reason=missing, phase=state).
  const { host: secondHost, binding: secondBinding } = await openLegacyBoundHost(root, { enumeratorVersion: '2.44.0' });
  const beforeMissingBytes = readFileSync(join(root, 'project.json'));
  secondHost.stop();
  rmSync(secondBinding.identity.stateDir, { recursive: true, force: true });

  const closedMissingState = Bun.spawnSync([process.execPath, CLI, 'job', 'close', root], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect({
    exit: closedMissingState.exitCode,
    stdout: closedMissingState.stdout.toString().trim(),
    stderr: closedMissingState.stderr.toString(),
  }).toEqual({ exit: 0, stdout: 'job: closed', stderr: '' });
  expect(readWriterBinding(root)).toBeNull();
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeMissingBytes);

  const reopenedAfterMissing = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, now);
  hosts.push(reopenedAfterMissing);
  expect(reopenedAfterMissing.session.jobId).not.toBe(secondBinding.jobId);
  expect(readWriterBinding(root)!.identity.enumeratorVersion).toBe(partsEnumerator.version);
});

async function publishLegacyPlan(root: string, binding: WriterBinding, planNow: number): Promise<void> {
  const entry = enqueuePublication(root, binding, { kind: 'plan' });
  await publishPending(
    entry,
    binding.identity,
    undefined,
    async (opts: JobHostOptions) => await startJobHost({
      ...opts,
      partsEnumerator: { version: binding.identity.enumeratorVersion, enumerate: partsEnumerator.enumerate },
    }),
    undefined,
    planNow,
  );
  rmSync(join(jobPrivateRoot(root), 'outbox'), { recursive: true, force: true });
}

test('#1076 stopped older-pin retirement refuses JOB_ACTS_PENDING when finalized acts remain in jobs.sqlite, preserves descriptor for retry, and closes with --discard-acts', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-close-stopped-acts-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-current'), root, { recursive: true });
  const currentProject = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  currentProject.owner = { language: 'en' };
  writeFileSync(join(root, 'project.json'), `${JSON.stringify(currentProject, null, 2)}\n`);

  const { host, binding } = await openLegacyBoundHost(root, { enumeratorVersion: '2.44.0' });
  await publishLegacyPlan(root, binding, Date.parse('2026-11-26T00:02:00.000Z'));
  const head = host.session.status().publication!;
  const uiCap = host.session.hostCredentials().ui;
  const headers = { origin: host.origin, 'X-Review-Capability': uiCap, 'content-type': 'application/json' };
  const pageId = randomUUID();
  const displayed = await (await fetch(`${host.origin}/jobs/${binding.jobId}/ui/displayed`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ publicationId: head.publicationId, pageId, sourceHash: head.source.sourceHash }),
  })).json() as { ok: boolean; value: { displayedNonce: string } };
  expect(displayed.ok).toBe(true);
  const submitted = await (await fetch(`${host.origin}/jobs/${binding.jobId}/ui/acts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      publicationId: head.publicationId,
      pageId,
      displayedNonce: displayed.value.displayedNonce,
      expectedGeneration: host.session.status().generation,
      submissionId: randomUUID(),
      kind: 'comments',
      value: { comments: [{ text: 'Synthetic unfetched note before stop.' }] },
    }),
  })).json() as { ok: boolean; value: { actId: string } };
  expect(submitted.ok).toBe(true);

  const descriptorPath = join(binding.identity.stateDir, 'job-ui', `${binding.jobId}.json`);
  const beforeDescriptor = readFileSync(descriptorPath);
  const beforeProject = readFileSync(join(root, 'project.json'));
  host.stop();

  await expect(closeCreateJob(root)).rejects.toMatchObject({
    code: 'JOB_ACTS_PENDING',
    message: expect.stringContaining(submitted.value.actId),
  });
  expect(storedJobActive(binding.identity.stateDir, binding.jobId)).toBe(1);
  expect(readFileSync(descriptorPath)).toEqual(beforeDescriptor);
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeProject);
  expect(readWriterBinding(root)).toEqual(binding);

  const discarded = Bun.spawnSync([
    process.execPath, CLI, 'job', 'close', root, '--discard-acts', 'retiring stopped 2.44.0 host', '--by', 'agent',
  ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect({
    exit: discarded.exitCode,
    stdout: discarded.stdout.toString().trim(),
    stderr: discarded.stderr.toString(),
  }).toEqual({ exit: 0, stdout: 'job: closed', stderr: '' });
  expect(storedJobActive(binding.identity.stateDir, binding.jobId)).toBe(0);
  expect(readWriterBinding(root)).toBeNull();
  const updatedProject = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as { review_acts: JsonObject[] };
  expect(updatedProject.review_acts.at(-1)).toMatchObject({
    kind: 'discarded',
    jobId: binding.jobId,
    actId: submitted.value.actId,
    reason: 'retiring stopped 2.44.0 host',
  });
});

test('#1076 current-path project (project.current, record-and-package binding) retires a stopped older-pin binding and reopens --plan at the current pin', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-close-current-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-current'), root, { recursive: true });
  const currentProject = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  currentProject.owner = { language: 'en' };
  writeFileSync(join(root, 'project.json'), `${JSON.stringify(currentProject, null, 2)}\n`);

  const { host, binding } = await openLegacyBoundHost(root, { enumeratorVersion: '2.44.0' });
  expect(binding.identity.publicationMode).toBe('record-and-package');
  await publishLegacyPlan(root, binding, Date.parse('2026-11-26T00:02:00.000Z'));
  const beforeBytes = readFileSync(join(root, 'project.json'));
  host.stop();

  const openRefused = Bun.spawnSync([
    process.execPath, CLI, 'job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--plan',
  ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(openRefused.exitCode).toBe(1);
  expect(openRefused.stderr.toString()).toContain('JOB_HOST_REUSE_MISMATCH');

  const closed = Bun.spawnSync([process.execPath, CLI, 'job', 'close', root], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect({
    exit: closed.exitCode,
    stdout: closed.stdout.toString().trim(),
    stderr: closed.stderr.toString(),
  }).toEqual({ exit: 0, stdout: 'job: closed', stderr: '' });
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeBytes);
  expect(readWriterBinding(root)).toBeNull();

  const next = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.parse('2026-11-26T00:02:00.000Z'), undefined, true);
  hosts.push(next);
  expect(next.session.jobId).not.toBe(binding.jobId);
  const lines = await openRecordPublication(root, next, undefined, true, Date.parse('2026-11-26T00:02:00.000Z'));
  expect(lines[0]).toContain('job: plan published');
});

test('#1076 stopped older-pin close still refuses copied, replaced, tampered or unauthorized bindings', async () => {
  const { root: originalRoot } = setupProject();
  const { host: originalHost, binding: originalBinding } = await openLegacyBoundHost(originalRoot, {
    enumeratorVersion: '2.44.0',
  });
  const descriptorPath = join(originalBinding.identity.stateDir, 'job-ui', `${originalBinding.jobId}.json`);
  const originalDescriptor = readFileSync(descriptorPath);
  const originalBytes = readFileSync(join(originalRoot, 'project.json'));
  originalHost.stop();

  // 1. Copied binding in another root (direct copy and tampered identity.root) refuses without retiring originalRoot's job.
  const { root: copyRoot } = setupProject();
  cpSync(join(originalRoot, 'project.json'), join(copyRoot, 'project.json'));
  writePrivateJson(join(copyRoot, JOB_BINDING_FILE), originalBinding, true);
  await expect(closeCreateJob(copyRoot)).rejects.toMatchObject({
    code: 'JOB_HOST_REUSE_MISMATCH',
    message: expect.stringContaining('root'),
  });
  writePrivateJson(join(copyRoot, JOB_BINDING_FILE), {
    ...originalBinding,
    identity: { ...originalBinding.identity, root: copyRoot },
  }, true);
  await expect(closeCreateJob(copyRoot)).rejects.toMatchObject({
    code: 'JOB_HOST_REUSE_MISMATCH',
    message: expect.stringContaining('root'),
  });
  expect(storedJobActive(originalBinding.identity.stateDir, originalBinding.jobId)).toBe(1);

  // 2. Tampered fetchCapability, non-canonical missing stateDir, and mismatched binding/descriptor fields refuse and preserve state.
  writePrivateJson(join(originalRoot, JOB_BINDING_FILE), {
    ...originalBinding,
    fetchCapability: '0'.repeat(64),
  }, true);
  await expect(closeCreateJob(originalRoot)).rejects.toMatchObject({ code: 'JOB_BINDING_INVALID' });
  expect(storedJobActive(originalBinding.identity.stateDir, originalBinding.jobId)).toBe(1);
  expect(readFileSync(descriptorPath)).toEqual(originalDescriptor);

  for (const [label, mutated, expectedCode] of [
    ['listenerIncarnation', { ...originalBinding, listenerIncarnation: '33333333-3333-4333-8333-333333333333' }, 'JOB_HOST_REUSE_MISMATCH'],
    ['origin', { ...originalBinding, origin: 'http://127.0.0.1:43199' }, 'JOB_HOST_REUSE_MISMATCH'],
    ['jobId', { ...originalBinding, jobId: 'job-unrelated-id' }, 'JOB_HOST_REUSE_MISMATCH'],
    ['fingerprint', { ...originalBinding, identity: { ...originalBinding.identity, fingerprint: 'rig-create/other/1' } }, 'JOB_HOST_REUSE_MISMATCH'],
    ['reviewer.id', { ...originalBinding, identity: { ...originalBinding.identity, reviewer: { id: 'other-user', role: 'owner' as const } } }, 'JOB_HOST_REUSE_MISMATCH'],
    ['reviewer.role', { ...originalBinding, identity: { ...originalBinding.identity, reviewer: { id: 'synthetic-owner', role: 'delegate' as const } } }, 'JOB_HOST_REUSE_MISMATCH'],
    ['state', { ...originalBinding, identity: { ...originalBinding.identity, stateDir: `${originalBinding.identity.stateDir}-missing` } }, 'JOB_HOST_ATTACH_REFUSED'],
  ] as const) {
    writePrivateJson(join(originalRoot, JOB_BINDING_FILE), mutated, true);
    await expect(closeCreateJob(originalRoot)).rejects.toMatchObject({
      code: expectedCode,
      message: expect.stringContaining(label),
    });
    expect(storedJobActive(originalBinding.identity.stateDir, originalBinding.jobId)).toBe(1);
    expect(existsSync(join(originalRoot, JOB_BINDING_FILE))).toBe(true);
  }

  // 3. Replaced root inode at the same path still refuses JOB_HOST_ATTACH_REFUSED (reason=replaced, phase=state).
  writePrivateJson(join(originalRoot, JOB_BINDING_FILE), originalBinding, true);
  const backupRoot = `${originalRoot}-backup`;
  renameSync(originalRoot, backupRoot);
  try {
    mkdirSync(originalRoot, { mode: 0o700 });
    cpSync(join(backupRoot, 'project.json'), join(originalRoot, 'project.json'));
    writePrivateJson(join(originalRoot, JOB_BINDING_FILE), originalBinding, true);
    await expect(closeCreateJob(originalRoot)).rejects.toMatchObject({
      code: 'JOB_HOST_ATTACH_REFUSED',
      message: expect.stringContaining('reason=replaced, phase=state'),
    });
    expect(storedJobActive(originalBinding.identity.stateDir, originalBinding.jobId)).toBe(1);
  } finally {
    rmSync(originalRoot, { recursive: true, force: true });
    renameSync(backupRoot, originalRoot);
  }

  // 4. Copied binding pointing at another root's absent stateDir also refuses JOB_HOST_ATTACH_REFUSED.
  expect(readFileSync(join(originalRoot, 'project.json'))).toEqual(originalBytes);
  await closeCreateJob(originalRoot);
  expect(storedJobActive(originalBinding.identity.stateDir, originalBinding.jobId)).toBe(0);
  rmSync(originalBinding.identity.stateDir, { recursive: true, force: true });
  writePrivateJson(join(copyRoot, JOB_BINDING_FILE), {
    ...originalBinding,
    identity: { ...originalBinding.identity, root: copyRoot },
  }, true);
  await expect(closeCreateJob(copyRoot)).rejects.toMatchObject({ code: 'JOB_HOST_ATTACH_REFUSED' });
  expect(existsSync(join(copyRoot, JOB_BINDING_FILE))).toBe(true);
});

