import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startJobHost, type JobHostAttachFailure, type JobHostOptions, type JobOwnerHost } from '@rig-c/review/job-host';
import { attachCreateJob, closeCreateJob, openCreateJob, publishPending, reconcileCreateJob } from '../src/job-host.ts';
import { acquireJobLock, cancelUncommittedIntent, enqueuePublication, failPublication, JOB_BINDING_FILE, jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications, publicationVersionHash, readAcknowledgedPublication, readWriterBinding, reconcilePublication, writePrivateJson } from '../src/job-outbox.ts';
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
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
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
  const acknowledged = readAcknowledgedPublication(root, host.session.jobId, status.publication!.publicationId)!;
  expect(acknowledged.versionHash).toBe(entry.versionHash!);
  expect(acknowledged.generation).toBe(status.publication!.generation);
  expect(lstatSync(join(root, '.rig-create-review/acknowledged-publications')).mode & 0o077).toBe(0);
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
  const project = JSON.parse(original.toString());
  project.versions.push({ ...project.versions[0], n: 2 });
  const intent = prepareVersionIntent(root, Buffer.from(JSON.stringify(project)), 2)!;
  const path = join(jobPrivateRoot(root), 'outbox', `${intent.id}.json`);
  try {
    expect(checkProject(root, undefined, { now }).holes ?? []).toEqual([]);
    expect(existsSync(path)).toBe(true);
    cancelUncommittedIntent(root, intent);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(root, 'project.json'))).toEqual(original);
  } finally { release(); }
});

test('private binding and discard log refuse dangling symlinks without creating their targets', async () => {
  const { root } = setup();
  const target = join(root, 'uncreated-target');
  symlinkSync(target, join(root, JOB_BINDING_FILE));
  expect(() => readWriterBinding(root)).toThrow(expect.objectContaining({ code: 'JOB_PRIVATE_STORAGE_INVALID' }));
  rmSync(join(root, JOB_BINDING_FILE));
  const host = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(host);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  project.versions.push({ ...project.versions[0], n: 2 });
  prepareVersionIntent(root, Buffer.from(JSON.stringify(project)), 2);
  symlinkSync(target, join(jobPrivateRoot(root), 'discarded-intents.jsonl'));
  expect(checkProject(root, undefined, { now }).holes?.map(hole => hole.code)).toEqual(['JOB_OUTBOX_INVALID']);
  expect(existsSync(target)).toBe(false);
});

test('host loss after preflight refuses strict attach without starting a replacement and leaves a named pending receipt', async () => {
  const { root, host, entry } = await bound();
  await expect(reconcileCreateJob(root, item => publishPending(item, undefined, () => host.stop())))
    .rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  const failure = pendingPublications(root)[0].failure!;
  expect(failure.code).toBe('JOB_HOST_ATTACH_REFUSED');
  expect(failure.message).toContain('reason=probe, phase=probe');
  const fresh = await startJobHost({ ...entry.identity, readPublished, partsEnumerator,
    installWriterBinding: () => {}, partsEnumeratorId: entry.identity.partsEnumeratorId });
  hosts.push(fresh);
  expect(fresh.reused).toBe(false);
  expect(fresh.session.status().generation).toBe(0);
});

test('a changed live listener incarnation or reader ID preserves the public mismatch field and values', async () => {
  const { root, entry, host, binding } = await bound();
  host.stop();
  const changed = await startJobHost({ ...entry.identity, port: Number(new URL(entry.origin).port),
    readerId: 'changed-reader', readPublished, partsEnumerator, installWriterBinding: () => {} });
  hosts.push(changed);
  await expect(reconcileCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  const incarnationFailure = pendingPublications(root)[0].failure!;
  expect(incarnationFailure.code).toBe('JOB_HOST_REUSE_MISMATCH');
  expect(incarnationFailure.message).toContain('listenerIncarnation');
  expect(incarnationFailure.message).toContain(binding.listenerIncarnation);
  expect(incarnationFailure.message).toContain(changed.attachment!.listenerIncarnation);
  writePrivateJson(join(root, JOB_BINDING_FILE), { ...binding, listenerIncarnation: changed.attachment!.listenerIncarnation }, true);
  await expect(reconcileCreateJob(root)).rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
  const failure = pendingPublications(root)[0].failure!;
  expect(failure.code).toBe('JOB_HOST_REUSE_MISMATCH');
  expect(failure.message).toContain('readerId');
  expect(failure.message).toContain('changed-reader');
  expect(failure.message).toContain(entry.identity.readerId);
  expect(changed.session.status().generation).toBe(0);
});

test('check and reconcile name a changed version entry and preserve its receipt', async () => {
  const { root } = await bound();
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  project.versions[0].changed = 'Changed after publication intent';
  writeFileSync(join(root, 'project.json'), JSON.stringify(project));
  expect(checkProject(root, undefined, { now }).holes?.map(hole => hole.code)).toEqual(['JOB_PUBLICATION_STALE']);
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

test('durable ignored outbox survives a restart with another TMPDIR and preserves tracked ignore bytes', async () => {
  const { root } = setup();
  const ignore = '/derived/\n/review-live-*.json\n';
  writeFileSync(join(root, '.gitignore'), ignore);
  const git = (args: string[]) => Bun.spawnSync(['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(git(['init', '-q']).exitCode).toBe(0);
  expect(git(['add', '--', 'project.json', '.gitignore']).exitCode).toBe(0);
  expect(git(['commit', '-qm', 'Synthetic initial record']).exitCode).toBe(0);
  const host = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(host);
  const entry = enqueuePublication(root, readWriterBinding(root)!, { path: 'review-live-v1.json', selector: { kind: 'rig', version: 1 } });
  failPublication(root, entry, { code: 'JOB_PUBLISH_PENDING', message: 'project.json: planted pending publish' });
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(ignore);
  expect(git(['add', '--', 'project.json']).exitCode).toBe(0);
  expect(git(['commit', '-qm', 'Synthetic bound record']).exitCode).toBe(0);
  expect(git(['check-ignore', JOB_BINDING_FILE, '.rig-create-review/outbox/receipt.json']).exitCode).toBe(0);
  expect(git(['status', '--porcelain']).stdout.toString()).toBe('');
  expect(lstatSync(jobPrivateRoot(root)).mode & 0o077).toBe(0);
  expect(lstatSync(join(jobPrivateRoot(root), 'outbox', `${entry.id}.json`)).mode & 0o077).toBe(0);
  const otherTemp = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-other-temp-')));
  roots.push(otherTemp);
  const before = readFileSync(join(root, 'project.json'));
  const worker = `
    import { readFileSync } from 'node:fs';
    import { checkProject } from ${JSON.stringify(join(import.meta.dir, '../src/check.ts'))};
    import { reconcileCreateJob } from ${JSON.stringify(join(import.meta.dir, '../src/job-host.ts'))};
    const {root, now} = JSON.parse(readFileSync(0, 'utf8'));
    const before = checkProject(root, undefined, {now}).holes?.map(hole => hole.code);
    const count = await reconcileCreateJob(root);
    console.log(JSON.stringify({before, count, after: checkProject(root, undefined, {now}).holes ?? []}));
  `;
  const child = Bun.spawn([process.execPath, '--eval', worker], { env: { ...process.env, TMPDIR: otherTemp },
    stdin: new Blob([JSON.stringify({ root, now })]), stdout: 'pipe', stderr: 'pipe' });
  const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(errors).toBe('');
  expect(exit).toBe(0);
  expect(JSON.parse(output)).toEqual({ before: ['JOB_PUBLISH_PENDING'], count: 1, after: [] });
  expect(readFileSync(join(root, 'project.json'))).toEqual(before);
  expect(git(['status', '--porcelain']).stdout.toString()).toBe('');
});

test('existing nested projects receive project-relative private excludes in the containing repository', async () => {
  const { root: container } = setup();
  const root = join(container, 'member');
  mkdirSync(root);
  for (const path of ['project.json', 'derived']) cpSync(join(container, path), join(root, path), { recursive: true });
  roots.unshift(root);
  expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: container, stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
  const host = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(host);
  enqueuePublication(root, readWriterBinding(root)!, { path: 'review-live-v1.json', selector: { kind: 'rig', version: 1 } });
  expect(Bun.spawnSync(['git', 'check-ignore', JOB_BINDING_FILE, '.rig-create-review/outbox/receipt.json'],
    { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
  expect(existsSync(join(root, '.gitignore'))).toBe(false);
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

test.each(['before-commit', 'after-commit', 'publish-failed'])('process kill %s recovers the version intent across an independent writer', async phase => {
  const { root } = setup();
  const host = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now);
  hosts.push(host);
  const original = readFileSync(join(root, 'project.json'));
  const project = JSON.parse(original.toString());
  project.versions.push({ ...project.versions[0], n: 2 });
  const candidate = Buffer.from(JSON.stringify(project));
  cpSync(join(root, 'derived/review/v1'), join(root, 'derived/review/v2'), { recursive: true });
  const worker = `
    import { readFileSync, writeFileSync, renameSync } from 'node:fs';
    import { join } from 'node:path';
    import { acquireJobLock, reconcilePublication, failPublication } from ${JSON.stringify(join(import.meta.dir, '../src/job-outbox.ts'))};
    import { prepareVersionIntent } from ${JSON.stringify(join(import.meta.dir, '../src/job-writer.ts'))};
    const {root, bytes, phase} = JSON.parse(readFileSync(0, 'utf8'));
    acquireJobLock(root);
    const candidate = Buffer.from(bytes);
    const intent = prepareVersionIntent(root, candidate, 2);
    if (phase !== 'before-commit') {
      writeFileSync(join(root, 'project.crash-control'), candidate);
      renameSync(join(root, 'project.crash-control'), join(root, 'project.json'));
    }
    if (phase === 'publish-failed') {
      try { await reconcilePublication(root, intent, async () => { throw Error('planted publish failure'); }); }
      catch { failPublication(root, intent, {code: 'JOB_PUBLISH_PENDING', message: 'project.json: planted publish failure'}); }
    }
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = Bun.spawn([process.execPath, '--eval', worker], {
    stdin: new Blob([JSON.stringify({ root, bytes: [...candidate], phase })]), stdout: 'pipe', stderr: 'pipe',
  });
  await child.exited;
  expect(child.signalCode).toBe('SIGKILL');
  if (phase !== 'before-commit') {
    writeFileSync(join(root, 'later.txt'), 'Later independent input');
    const input = Bun.spawnSync([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'input', 'add', 'later.txt', root, '--origin', 'synthetic later input'], { stdout: 'pipe', stderr: 'pipe' });
    expect(input.stderr.toString()).toBe('');
    expect(input.exitCode).toBe(0);
  }
  const current = readFileSync(join(root, 'project.json'));
  const report = checkProject(root, undefined, { now });
  if (phase === 'before-commit') {
    expect(report.holes ?? []).toEqual([]);
    expect(readFileSync(join(root, 'project.json'))).toEqual(original);
    const discarded = JSON.parse(readFileSync(join(jobPrivateRoot(root), 'discarded-intents.jsonl'), 'utf8').trim());
    expect(discarded.versionHash).toBe(publicationVersionHash(candidate, { path: 'review-live-v2.json', selector: { kind: 'rig', version: 2 } }));
    expect(discarded.id).toMatch(/^[a-f0-9]{64}$/);
    expect(await reconcileCreateJob(root)).toBe(0);
  } else {
    expect(report.holes?.map(hole => hole.code)).toEqual(['JOB_PUBLISH_PENDING']);
    expect(jobHash(current)).not.toBe(jobHash(candidate));
    expect(await reconcileCreateJob(root)).toBe(1);
    expect(checkProject(root, undefined, { now }).holes ?? []).toEqual([]);
    expect(host.session.status().publication?.source.projectHash).toBe(jobHash(current));
    expect(host.session.status().publication?.source.selector).toEqual({ kind: 'rig', version: 2 });
    expect(readFileSync(join(root, 'project.json'))).toEqual(current);
  }
});

function mockedOwnerHost(
  jobId: string,
  origin: string,
  reused: boolean,
  attachment: JobOwnerHost['attachment'],
): JobOwnerHost {
  return {
    session: {
      jobId,
      status: () => ({ jobId, generation: 0, status: 'active' as const, publication: null, pending: [], cursor: null, enabledActKinds: [] }),
      hostCredentials: () => ({ agent: 'a'.repeat(64), ui: 'b'.repeat(64) }),
      dispose: () => {},
    } as unknown as JobOwnerHost['session'],
    ports: {
      handleJobApi: async () => Response.json({
        schema: 'rig-review/job-api@2', verb: 'publish', jobId, requestId: 'synthetic-req', generation: 1,
        ok: true, value: { publicationId: 'pub-synthetic-1', generation: 1 },
      }),
      subscribeJob: () => { throw Error('unused'); },
      readPublication: () => { throw Error('unused'); },
      commitUIAct: () => { throw Error('unused'); },
      ackDisplayed: () => { throw Error('unused'); },
      jobLiveness: async () => ({ ok: true as const, value: { active: true, busy: false } }),
    },
    origin,
    ownerUrl: `${origin}/jobs/${jobId}/#cap=${'b'.repeat(64)}`,
    reused,
    attachment,
    stop: () => {},
  };
}

test('strict reuseOnly attach passes expected jobId, origin, listenerIncarnation and binding from the locked WriterBinding', async () => {
  const { root, project } = setup();
  const jobId = 'job-synthetic-strict';
  const origin = 'http://127.0.0.1:43111';
  const initialIncarnation = '11111111-1111-4111-8111-111111111111';
  const rotatedIncarnation = '22222222-2222-4222-8222-222222222222';
  const openMock = async (opts: JobHostOptions): Promise<JobOwnerHost> => {
    expect(opts.reuseOnly).toBeUndefined();
    await opts.installWriterBinding?.({ jobId, origin, fetchCapability: 'c'.repeat(64) });
    return mockedOwnerHost(jobId, origin, false, {
      jobId,
      origin,
      listenerIncarnation: initialIncarnation,
      binding: {
        root: opts.root,
        stateDir: opts.stateDir,
        fingerprint: opts.fingerprint,
        reviewer: opts.reviewer,
        readerId: opts.readerId ?? null,
        bindingId: opts.bindingId ?? null,
        partsEnumeratorId: opts.partsEnumeratorId ?? null,
        partsEnumeratorVersion: opts.partsEnumerator?.version ?? null,
        apiSchema: 'rig-review/job-api@2',
        actSchema: 'rig-review/act@2',
      },
    });
  };
  await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now, openMock);
  const binding = readWriterBinding(root)!;
  expect(binding.listenerIncarnation).toBe(initialIncarnation);
  const path = prepareLiveManifest(root, project, 1);
  const entry = enqueuePublication(root, binding, { path, selector: { kind: 'rig', version: 1 } });
  expect('listenerIncarnation' in entry).toBe(false);
  writePrivateJson(join(root, JOB_BINDING_FILE), { ...binding, listenerIncarnation: rotatedIncarnation }, true);
  let capturedOptions: JobHostOptions | undefined;
  let lockHeldDuringAttach = false;
  const attachMock = async (opts: JobHostOptions): Promise<JobOwnerHost> => {
    capturedOptions = opts;
    lockHeldDuringAttach = acquireJobLock(root, false) === null;
    return mockedOwnerHost(jobId, origin, true, opts.reuseOnly!.expected);
  };
  expect(await reconcileCreateJob(root, item => publishPending(item, undefined, undefined, attachMock))).toBe(1);
  expect(lockHeldDuringAttach).toBe(true);
  expect(capturedOptions?.reuseOnly).toEqual({
    expected: {
      jobId,
      origin,
      listenerIncarnation: rotatedIncarnation,
      binding: {
        root: entry.identity.root,
        stateDir: entry.identity.stateDir,
        fingerprint: entry.identity.fingerprint,
        reviewer: entry.identity.reviewer,
        readerId: entry.identity.readerId,
        bindingId: entry.identity.bindingId,
        partsEnumeratorId: entry.identity.partsEnumeratorId,
        partsEnumeratorVersion: entry.identity.enumeratorVersion,
        apiSchema: 'rig-review/job-api@2',
        actSchema: 'rig-review/act@2',
      },
    },
  });
});

test('ordinary GET reuse returning attachment: null is not strictly attached, not an error, and does not reinstall', async () => {
  const { root } = setup();
  const jobId = 'job-synthetic-get-reuse';
  const origin = 'http://127.0.0.1:43112';
  const incarnation = '11111111-1111-4111-8111-111111111111';
  await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now, async opts => {
    await opts.installWriterBinding?.({ jobId, origin, fetchCapability: 'c'.repeat(64) });
    return mockedOwnerHost(jobId, origin, false, {
      jobId,
      origin,
      listenerIncarnation: incarnation,
      binding: {
        root: opts.root,
        stateDir: opts.stateDir,
        fingerprint: opts.fingerprint,
        reviewer: opts.reviewer,
        readerId: opts.readerId ?? null,
        bindingId: opts.bindingId ?? null,
        partsEnumeratorId: opts.partsEnumeratorId ?? null,
        partsEnumeratorVersion: opts.partsEnumerator?.version ?? null,
        apiSchema: 'rig-review/job-api@2',
        actSchema: 'rig-review/act@2',
      },
    });
  });
  const bindingPath = join(root, JOB_BINDING_FILE);
  const beforeSha256 = jobHash(readFileSync(bindingPath));
  let calls = 0;
  const reusedHost = await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now, async opts => {
    calls++;
    await opts.installWriterBinding?.({ jobId, origin, fetchCapability: 'd'.repeat(64) });
    return mockedOwnerHost(jobId, origin, true, null);
  });
  expect(calls).toBe(1);
  expect(reusedHost.reused).toBe(true);
  expect(reusedHost.attachment).toBeNull();
  expect(jobHash(readFileSync(bindingPath))).toBe(beforeSha256);
  expect(readWriterBinding(root)!.listenerIncarnation).toBe(incarnation);

  const { root: unboundRoot } = setup();
  let unboundCalls = 0;
  const unboundHost = await openCreateJob(unboundRoot, { id: 'reviewer', role: 'owner' }, now, async opts => {
    unboundCalls++;
    await opts.installWriterBinding?.({ jobId, origin, fetchCapability: 'e'.repeat(64) });
    return mockedOwnerHost(jobId, origin, true, null);
  });
  expect(unboundCalls).toBe(1);
  expect(unboundHost.reused).toBe(true);
  expect(unboundHost.attachment).toBeNull();
  expect(existsSync(join(unboundRoot, JOB_BINDING_FILE))).toBe(false);
});

test('JOB_HOST_ATTACH_REFUSED and field-level JOB_HOST_REUSE_MISMATCH map to named Refusals and preserve reasons in pending receipts', async () => {
  const { root, project } = setup();
  const jobId = 'job-synthetic-refusals';
  const origin = 'http://127.0.0.1:43113';
  const incarnation = '11111111-1111-4111-8111-111111111111';
  await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now, async opts => {
    await opts.installWriterBinding?.({ jobId, origin, fetchCapability: 'c'.repeat(64) });
    return mockedOwnerHost(jobId, origin, false, {
      jobId,
      origin,
      listenerIncarnation: incarnation,
      binding: {
        root: opts.root,
        stateDir: opts.stateDir,
        fingerprint: opts.fingerprint,
        reviewer: opts.reviewer,
        readerId: opts.readerId ?? null,
        bindingId: opts.bindingId ?? null,
        partsEnumeratorId: opts.partsEnumeratorId ?? null,
        partsEnumeratorVersion: opts.partsEnumerator?.version ?? null,
        apiSchema: 'rig-review/job-api@2',
        actSchema: 'rig-review/act@2',
      },
    });
  });
  const binding = readWriterBinding(root)!;
  const path = prepareLiveManifest(root, project, 1);
  enqueuePublication(root, binding, { path, selector: { kind: 'rig', version: 1 } });

  const attachRefusals: Extract<JobHostAttachFailure, { code: 'JOB_HOST_ATTACH_REFUSED' }>[] = [
    { code: 'JOB_HOST_ATTACH_REFUSED', reason: 'incarnation-missing', phase: 'record' },
    { code: 'JOB_HOST_ATTACH_REFUSED', reason: 'incarnation-missing', phase: 'probe' },
    { code: 'JOB_HOST_ATTACH_REFUSED', reason: 'closed', phase: 'acceptance' },
    { code: 'JOB_HOST_ATTACH_REFUSED', reason: 'stopped', phase: 'acceptance' },
    { code: 'JOB_HOST_ATTACH_REFUSED', reason: 'race', phase: 'adoption' },
  ];
  for (const refusal of attachRefusals) {
    const thrown = Object.assign(new Error(`${refusal.code}: ${refusal.reason} (${refusal.phase})`), refusal);
    await expect(attachCreateJob(pendingPublications(root)[0]!, undefined, undefined, async () => { throw thrown; }))
      .rejects.toMatchObject({ code: 'JOB_HOST_ATTACH_REFUSED' });
    await expect(reconcileCreateJob(root, item => publishPending(item, undefined, undefined, async () => { throw thrown; })))
      .rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
    const receipt = pendingPublications(root)[0]!.failure!;
    expect(receipt.code).toBe('JOB_HOST_ATTACH_REFUSED');
    expect(receipt.message).toContain(refusal.reason);
    expect(receipt.message).toContain(refusal.phase);
  }

  const mismatchFailures: Extract<JobHostAttachFailure, { code: 'JOB_HOST_REUSE_MISMATCH' }>[] = [
    { code: 'JOB_HOST_REUSE_MISMATCH', field: 'listenerIncarnation', expected: incarnation, actual: '33333333-3333-4333-8333-333333333333' },
    { code: 'JOB_HOST_REUSE_MISMATCH', field: 'readerId', expected: binding.identity.readerId, actual: 'different-reader' },
    { code: 'JOB_HOST_REUSE_MISMATCH', field: 'origin', expected: origin, actual: 'http://127.0.0.1:43199' },
  ];
  for (const mismatch of mismatchFailures) {
    const thrown = Object.assign(new Error(`${mismatch.code}: ${mismatch.field}`), mismatch);
    await expect(attachCreateJob(pendingPublications(root)[0]!, undefined, undefined, async () => { throw thrown; }))
      .rejects.toMatchObject({ code: 'JOB_HOST_REUSE_MISMATCH' });
    await expect(reconcileCreateJob(root, item => publishPending(item, undefined, undefined, async () => { throw thrown; })))
      .rejects.toMatchObject({ code: 'JOB_PUBLISH_PENDING' });
    const receipt = pendingPublications(root)[0]!.failure!;
    expect(receipt.code).toBe('JOB_HOST_REUSE_MISMATCH');
    expect(receipt.message).toContain(mismatch.field);
    expect(receipt.message).toContain(String(mismatch.expected));
    expect(receipt.message).toContain(String(mismatch.actual));
  }
});

test('reuse-only attach never writes the binding and leaves its sha256 identical before and after', async () => {
  const { root, project } = setup();
  const jobId = 'job-synthetic-readonly-binding';
  const origin = 'http://127.0.0.1:43114';
  const incarnation = '44444444-4444-4444-8444-444444444444';
  await openCreateJob(root, { id: 'reviewer', role: 'owner' }, now, async opts => {
    await opts.installWriterBinding?.({ jobId, origin, fetchCapability: 'c'.repeat(64) });
    return mockedOwnerHost(jobId, origin, false, {
      jobId,
      origin,
      listenerIncarnation: incarnation,
      binding: {
        root: opts.root,
        stateDir: opts.stateDir,
        fingerprint: opts.fingerprint,
        reviewer: opts.reviewer,
        readerId: opts.readerId ?? null,
        bindingId: opts.bindingId ?? null,
        partsEnumeratorId: opts.partsEnumeratorId ?? null,
        partsEnumeratorVersion: opts.partsEnumerator?.version ?? null,
        apiSchema: 'rig-review/job-api@2',
        actSchema: 'rig-review/act@2',
      },
    });
  });
  const bindingPath = join(root, JOB_BINDING_FILE);
  const beforeSha256 = jobHash(readFileSync(bindingPath));
  const binding = readWriterBinding(root)!;
  const path = prepareLiveManifest(root, project, 1);
  const entry = enqueuePublication(root, binding, { path, selector: { kind: 'rig', version: 1 } });
  const attached = await attachCreateJob(entry, undefined, undefined, async opts => {
    await opts.installWriterBinding?.({ jobId: 'tampered', origin: 'http://127.0.0.1:49999', fetchCapability: 'f'.repeat(64) });
    return mockedOwnerHost(jobId, origin, true, opts.reuseOnly!.expected);
  });
  attached.stop();
  const afterAttachSha256 = jobHash(readFileSync(bindingPath));
  expect(afterAttachSha256).toBe(beforeSha256);
  expect(await reconcileCreateJob(root, item => publishPending(item, undefined, undefined, async opts => {
    await opts.installWriterBinding?.({ jobId: 'tampered', origin: 'http://127.0.0.1:49999', fetchCapability: 'f'.repeat(64) });
    return mockedOwnerHost(jobId, origin, true, opts.reuseOnly!.expected);
  }))).toBe(1);
  const afterReconcileSha256 = jobHash(readFileSync(bindingPath));
  expect(afterReconcileSha256).toBe(beforeSha256);
});
