import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startJobHost, type JobHostOptions, type JobOwnerHost } from '@rig-c/review/job-host';
import { attachCreateJob, closeCreateJob, openCreateJob, publishPending, reconcileCreateJob } from '../src/job-host.ts';
import { enqueuePublication, JOB_BINDING_FILE, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding, writePrivateJson, type WriterBinding } from '../src/job-outbox.ts';
import { currentJobIdentity, partsEnumerator, prepareLiveManifest, readPublished } from '../src/job-publication.ts';
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

test('Review 2.7.0 runtime surface supports strict reuseOnly attach and close using stored binding identity without invoking enumerator or reader callbacks', async () => {
  const { root } = setupProject();
  const { host, binding } = await openLegacyBoundHost(root, {
    enumeratorVersion: OLD_ENUMERATOR_VERSION,
    readerId: OLD_READER_ID,
  });
  let enumerateCalls = 0;
  let readerCalls = 0;
  const attached = await startJobHost({
    root: binding.identity.root,
    stateDir: binding.identity.stateDir,
    fingerprint: binding.identity.fingerprint,
    reviewer: binding.identity.reviewer,
    readerId: binding.identity.readerId,
    readPublished: async input => {
      readerCalls++;
      return await readPublished(input);
    },
    partsEnumeratorId: binding.identity.partsEnumeratorId,
    partsEnumerator: {
      version: binding.identity.enumeratorVersion,
      enumerate: dir => {
        enumerateCalls++;
        return partsEnumerator.enumerate(dir);
      },
    },
    bindingId: binding.identity.bindingId,
    installWriterBinding: async () => {},
    reuseOnly: {
      expected: {
        jobId: binding.jobId,
        origin: binding.origin,
        listenerIncarnation: binding.listenerIncarnation,
        binding: {
          root: binding.identity.root,
          stateDir: binding.identity.stateDir,
          fingerprint: binding.identity.fingerprint,
          reviewer: binding.identity.reviewer,
          readerId: binding.identity.readerId,
          bindingId: binding.identity.bindingId,
          partsEnumeratorId: binding.identity.partsEnumeratorId,
          partsEnumeratorVersion: binding.identity.enumeratorVersion,
          apiSchema: binding.identity.apiSchema as 'rig-review/job-api@2',
          actSchema: binding.identity.actSchema as 'rig-review/act@2',
        },
      },
    },
  });
  try {
    expect(attached.reused).toBe(true);
    expect(attached.session.jobId).toBe(binding.jobId);
    expect(enumerateCalls).toBe(0);
    expect(readerCalls).toBe(0);
    expect(() => attached.session.authorize('consumer', `Bearer ${binding.fetchCapability}`)).not.toThrow();
    expect(() => attached.session.authorize('consumer', `Bearer ${'0'.repeat(64)}`)).toThrow();
  } finally {
    attached.stop();
  }
  expect(host.session.status().status).toBe('active');
});

test('closeCreateJob retires a live host bound with an older enumeratorVersion and readerId while normal attach/reconcile stay strict and project.json stays byte-identical', async () => {
  const { root, project } = setupProject();
  const { host, binding } = await openLegacyBoundHost(root, {
    enumeratorVersion: OLD_ENUMERATOR_VERSION,
    readerId: OLD_READER_ID,
  });
  const beforeProjectBytes = readFileSync(join(root, 'project.json'));

  // Normal attach / reconcile must stay strict against the current identity.
  const manifestPath = prepareLiveManifest(root, project, 1);
  const entry = enqueuePublication(root, binding, { path: manifestPath, selector: { kind: 'rig', version: 1 } });
  await expect(attachCreateJob(entry)).rejects.toMatchObject({ code: 'JOB_HOST_REUSE_MISMATCH' });
  await expect(reconcileCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  expect(pendingPublications(root)[0]?.failure?.code).toBe('JOB_HOST_REUSE_MISMATCH');
  expect(host.session.status().generation).toBe(0);
  expect(host.session.status().status).toBe('active');

  // Clear the synthetic pending receipt so close can proceed.
  rmSync(join(jobPrivateRoot(root), 'outbox'), { recursive: true, force: true });

  // Close-specific retirement succeeds using the stored binding and valid close authority.
  await closeCreateJob(root);
  expect(host.session.status().status).toBe('closed');
  expect(readWriterBinding(root)).toBeNull();
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeProjectBytes);

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
  const { host } = await openLegacyBoundHost(root, { enumeratorVersion: OLD_ENUMERATOR_VERSION });
  const beforeProjectBytes = readFileSync(join(root, 'project.json'));

  const child = Bun.spawn([process.execPath, CLI, 'job', 'close', root], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exit, stdout: stdout.trim(), stderr }).toEqual({ exit: 0, stdout: 'job: closed', stderr: '' });
  expect(host.session.status().status).toBe('closed');
  expect(readWriterBinding(root)).toBeNull();
  expect(readFileSync(join(root, 'project.json'))).toEqual(beforeProjectBytes);
});

test('wrong or copied root and tampered close authority refuse before contacting or retiring an unrelated or bound host', async () => {
  const { root: originalRoot } = setupProject();
  const { host: originalHost, binding: originalBinding } = await openLegacyBoundHost(originalRoot, {
    enumeratorVersion: OLD_ENUMERATOR_VERSION,
  });

  // 1. Direct copied binding in another root refuses JOB_HOST_REUSE_MISMATCH on root without retiring originalHost.
  const { root: copyRoot } = setupProject();
  cpSync(join(originalRoot, 'project.json'), join(copyRoot, 'project.json'));
  writePrivateJson(join(copyRoot, JOB_BINDING_FILE), originalBinding, true);
  const copyBeforeBytes = readFileSync(join(copyRoot, 'project.json'));

  await expect(closeCreateJob(copyRoot)).rejects.toMatchObject({
    code: 'JOB_HOST_REUSE_MISMATCH',
    message: expect.stringContaining('root'),
  });
  expect(originalHost.session.status().status).toBe('active');
  expect(readFileSync(join(copyRoot, 'project.json'))).toEqual(copyBeforeBytes);

  // 2. Copied binding with tampered identity.root = copyRoot still pointing at originalHost stateDir/jobId/origin refuses before retiring originalHost.
  writePrivateJson(join(copyRoot, JOB_BINDING_FILE), {
    ...originalBinding,
    identity: { ...originalBinding.identity, root: copyRoot },
  }, true);
  await expect(closeCreateJob(copyRoot)).rejects.toMatchObject({
    code: 'JOB_HOST_REUSE_MISMATCH',
    message: expect.stringContaining('root'),
  });
  expect(originalHost.session.status().status).toBe('active');

  // 3. Wrong close authority (tampered fetchCapability) on the bound root refuses JOB_BINDING_INVALID without retiring originalHost.
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

  // 4. Wrong listenerIncarnation, origin, jobId, or reviewer on the bound root refuses without retiring originalHost.
  for (const [label, mutated, expectedCode] of [
    ['listenerIncarnation', { ...originalBinding, listenerIncarnation: '33333333-3333-4333-8333-333333333333' }, 'JOB_HOST_REUSE_MISMATCH'],
    ['origin', { ...originalBinding, origin: 'http://127.0.0.1:43199' }, 'JOB_HOST_REUSE_MISMATCH'],
    ['jobId', { ...originalBinding, jobId: 'job-unrelated-id' }, 'JOB_HOST_REUSE_MISMATCH'],
    ['reviewer.id', { ...originalBinding, identity: { ...originalBinding.identity, reviewer: { id: 'other-user', role: 'owner' as const } } }, 'JOB_HOST_REUSE_MISMATCH'],
    ['reviewer.role', { ...originalBinding, identity: { ...originalBinding.identity, reviewer: { id: 'synthetic-owner', role: 'delegate' as const } } }, 'JOB_HOST_REUSE_MISMATCH'],
  ] as const) {
    writePrivateJson(join(originalRoot, JOB_BINDING_FILE), mutated, true);
    await expect(closeCreateJob(originalRoot)).rejects.toMatchObject({
      code: expectedCode,
      message: expect.stringContaining(label),
    });
    expect(originalHost.session.status().status).toBe('active');
    expect(existsSync(join(originalRoot, JOB_BINDING_FILE))).toBe(true);
  }
});
