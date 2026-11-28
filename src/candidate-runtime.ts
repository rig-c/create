import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { waitForJobAct, type ActV3, type JobOwnerHost, type JobReviewerBinding } from '@rig-c/review/job-host';
import { candidateBatchPath, candidateBatchPaths, candidateStorage, candidateStorageBytes, assertCandidateStorage,
  CANDIDATE_STORAGE_PATH, CANDIDATE_OPTION_RESERVATION_BYTES, CANDIDATE_COMPOSE_DISK_RESERVE_BYTES,
  CANDIDATE_JOB_STATE_RESERVATION_BYTES, candidateOptionPaths, readCandidateBatchIdentity, type CandidateBatchIdentity } from './candidate-storage.ts';
import { attachCandidateHost, candidateHostBinding, closeCandidateHost, openCandidateHost, awaitCandidateListenerStop } from './candidate-host.ts';
import { writeCandidatePackage } from './candidate-package.ts';
import { CANDIDATE_PROOF_FILE, invalidCandidate, readCandidateProof, type CandidateProof, type CandidateSelector } from './candidate-proof.ts';
import { composeCandidate, prepareCandidateScene, resolveCandidateSet } from './candidate.ts';
import { ingestReviewComment } from './comment-act.ts';
import { candidateCommentSubject, type CommentOnlyAct } from './comment-record.ts';
import { currentRigFileBinding, sha256 } from './current.ts';
import { directionJson, objects } from './direction.ts';
import { actionablePendingAct, agentCall, ingestedSummary, pendingJobActs, readHostActsAndAsks, type PendingJobAct } from './job-acts.ts';
import { acquireJobLock, privateJson, tryJobDirectoryLock, writePrivateJson } from './job-outbox.ts';
import { requireOwnerLanguage } from './owner-language.ts';
import { formatRefusal, Refusal, refuse } from './refusal.ts';
import { decodeReviewAct, fetchReviewAct, reviewActFindings, type ReviewActTransport } from './review-act.ts';
import { sceneBytes } from './scene.ts';
import { collectItems, isObject, loadCollection } from './check.ts';
import { isDeepStrictEqual as equal } from 'node:util';
import type { JsonObject } from './templates.ts';

interface CandidateLink {
  url: string;
  selector: CandidateSelector;
  publicationId: string;
  sourceHash: string;
}
interface Request {
  root: string;
  question?: string;
  setId?: string;
  reviewer?: JobReviewerBinding;
  actId?: string;
  jobId?: string;
  now: number;
  json?: boolean;
}

const key = (askId: string, optionId: string) => `option-${sha256(JSON.stringify([askId, optionId]))}`;
const readProject = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
const asRelative = (root: string, path: string) => relative(root, path).replaceAll('\\', '/');


function readLink(path: string): CandidateLink | undefined {
  try { return privateJson(join(path, 'link.json')) as CandidateLink; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function assertCandidateAct(act: CommentOnlyAct, link: CandidateLink, transport: ReviewActTransport): void {
  if (act.jobId !== transport.jobId || act.actId !== transport.actId || act.publicationId !== link.publicationId
    || act.source.sourceHash !== link.sourceHash || !equal(act.source.selector, link.selector)
    || act.value.carriers?.length) {
    refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.comments: the comment differs from its candidate publication; reopen the candidate and send the comment again');
  }
}

function commentTransport(host: JobOwnerHost, actId: string): ReviewActTransport {
  const { jobId, fetchCapability } = host.session.writerGrant();
  return { jobId, origin: host.origin, fetchCapability, actId, kind: 'comments' };
}

async function ingestFromCandidate(root: string, host: JobOwnerHost, link: CandidateLink, actId: string, now: number, json = true) {
  const transport = commentTransport(host, actId);
  const fetched = await fetchReviewAct(transport);
  return ingestReviewComment(root, { actId, json }, now, {
    fetch: () => ({ bytes: fetched.bytes }),
  }, { transport: () => transport, verify: act => assertCandidateAct(act, link, transport) });
}

async function retireCandidateBatch(root: string, batch: string, now: number, owned: readonly JobOwnerHost[] = []): Promise<void> {
  for (const path of candidateOptionPaths(batch)) {
    const binding = candidateHostBinding(path);
    if (!binding) continue;
    const original = owned.find(host => host.session.jobId === binding.jobId);
    const host = original ?? await attachCandidateHost(path, binding, true);
    if (!host) { await awaitCandidateListenerStop(binding); continue; }
    try {
      await closeCandidateHost(host, async acts => {
        const link = readLink(path);
        if (acts.length && !link) invalidCandidate(asRelative(root, path), 'preview');
        const project = readProject(root);
        const stored = new Set(Array.isArray(project.review_acts) ? project.review_acts.filter(isObject)
          .map(act => JSON.stringify([act.jobId, act.actId])) : []);
        for (const act of acts) {
          if (act.kind !== 'comments' || stored.has(JSON.stringify([act.jobId, act.actId]))) continue;
          await ingestFromCandidate(root, host, link!, act.actId, Math.max(now, Date.now()));
        }
      });
    } finally { host.stop(); }
    await awaitCandidateListenerStop({ ...binding, origin: host.origin });
  }
  rmSync(batch, { recursive: true });
}

function pendingMatches(project: JsonObject, root: string, batch: CandidateBatchIdentity): boolean {
  const item = collectItems(project, { collection: loadCollection(root, project) }).find(item => item.kind === 'post' && item.id === batch.question);
  const pending = item?.record.pending_options;
  return isObject(pending) && pending.sha256 === batch.setSha256;
}

function candidateSourceChanged(root: string, project: JsonObject, proof: CandidateProof): boolean {
  const model = currentRigFileBinding(project, 'check/build/skeleton.model.json');
  const current = isObject(project.current) ? project.current : {};
  const rig = isObject(current.rig) ? current.rig : {};
  const motion = isObject(current.motion) ? current.motion : undefined;
  if (proof.rigSha256 !== model?.sha256 || proof.motionSha256 !== motion?.files_sha256) return true;
  const run = sceneBytes(root, proof.run.path, 'CANDIDATE_RECEIPT_MISMATCH');
  if (sha256(run) !== proof.run.sha256) invalidCandidate(proof.run.path, proof.selector.optionId);
  const [character] = objects(directionJson(run, proof.run.path).characters);
  return objects(character?.files).some(file => {
    if (typeof file.path !== 'string') return false;
    const binding = currentRigFileBinding(project, file.path)
      ?? (file.path.startsWith('rig/') ? currentRigFileBinding(project, file.path.slice('rig/'.length)) : undefined);
    if (binding) return binding.sha256 !== file.sha256;
    // A standalone or numbered build can hold these inputs outside the rig inventory.
    if (file.path === 'parts.json') return false;
    if (file.path === 'check/check.json' && isObject(rig.adopted) && isObject(rig.report)) {
      return rig.report.sha256 !== file.sha256;
    }
    return true;
  });
}

function hasSupersededSource(root: string, path: string, project: JsonObject): boolean {
  return candidateOptionPaths(path).some(row => {
    try {
      // Older batches already seal these sources in the option proof and producer receipt.
      const proof = privateJson(join(row, CANDIDATE_PROOF_FILE)) as CandidateProof;
      const link = readLink(row);
      if (!link || !equal(link.selector, proof.selector)) return false;
      if (typeof proof.rigSha256 !== 'string' || typeof proof.motionSha256 !== 'string') return false;
      return candidateSourceChanged(root, project, proof);
    } catch { return false; }
  });
}

async function sweep(root: string, storage: string, now: number, closeQuestion?: string): Promise<void> {
  const project = readProject(root);
  for (const path of candidateBatchPaths(storage)) {
    const batch = readCandidateBatchIdentity(storage, path);
    if (!batch || batch.question === closeQuestion || !pendingMatches(project, root, batch)
      || !lstatSync(join(path, 'ready.json'), { throwIfNoEntry: false }) || hasSupersededSource(root, path, project)) {
      await retireCandidateBatch(root, path, now);
    }
  }
}

async function reusable(root: string, path: string, batch: CandidateBatchIdentity, options: { askId: string; optionId: string }[], reviewer: JobReviewerBinding, project: JsonObject): Promise<{ label: string; url: string }[] | undefined> {
  try {
    const rows = options.map(option => join(path, key(option.askId, option.optionId)));
    if (candidateOptionPaths(path).length !== rows.length) return;
    const model = currentRigFileBinding(project, 'check/build/skeleton.model.json');
    const motion = isObject(project.current) && isObject(project.current.motion) ? project.current.motion : undefined;
    const links: { label: string; url: string }[] = [];
    for (const row of rows) {
      const proof = readCandidateProof(root, row, batch);
      if (proof.rigSha256 !== model?.sha256 || proof.motionSha256 !== motion?.files_sha256) return;
      const link = readLink(row);
      const binding = candidateHostBinding(row);
      if (!link || !binding || !equal(reviewer, binding.binding.reviewer) || !equal(link.selector, proof.selector)) return;
      const host = await attachCandidateHost(row, binding);
      if (!host) return;
      try {
        const current = host.session.status().publication;
        if (current?.publicationId !== link.publicationId || current.source.sourceHash !== link.sourceHash) return;
      } finally { host.stop(); }
      links.push({ label: proof.label, url: link.url });
    }
    return links;
  } catch { return; }
}

function assertBatchStorage(storage: string, currentPath: string, batch: CandidateBatchIdentity,
  reserve: number, diskReserve: number, option?: string): void {
  let reclaim = { ...batch, bytes: candidateStorageBytes(currentPath) };
  for (const path of candidateBatchPaths(storage)) {
    if (path === currentPath || !lstatSync(join(path, 'ready.json'), { throwIfNoEntry: false })) continue;
    const candidate = readCandidateBatchIdentity(storage, path);
    const bytes = candidateStorageBytes(path);
    if (candidate && bytes > reclaim.bytes) reclaim = { ...candidate, bytes };
  }
  assertCandidateStorage(storage, reclaim.question, reclaim.setId, reclaim.bytes, reserve, diskReserve, option);
}

async function openBatch(root: string, storage: string, request: Request, owned: JobOwnerHost[]): Promise<void> {
  const { question, setId, reviewer, now } = request as Request & { question: string; setId: string; reviewer: JobReviewerBinding };
  await sweep(root, storage, now);
  const project = readProject(root);
  requireOwnerLanguage(project);
  const selection = resolveCandidateSet(root, project, question, setId, now);
  const batch = { question, setId, setSha256: String(selection.binding.sha256) };
  const path = candidateBatchPath(storage, batch);
  if (lstatSync(path, { throwIfNoEntry: false })) {
    const cached = await reusable(root, path, batch, selection.options, reviewer, project);
    if (cached?.length) {
      for (const item of cached) console.log(`${item.label.replace(/[\r\n]+/g, ' ')} ${item.url}`);
      return;
    }
    await retireCandidateBatch(root, path, now);
  }
  if (!selection.options.length) refuse('COMPOSE_VALUE_INVALID', 'project.json: select a pending post set with a concrete compose option');
  mkdirSync(path, { mode: 0o700 });
  writePrivateJson(join(path, 'batch.json'), batch);
  try {
    let snapshotReserve = 0;
    let optionReserve = CANDIDATE_OPTION_RESERVATION_BYTES;
    for (const option of selection.options) {
      assertBatchStorage(storage, path, batch, snapshotReserve + optionReserve,
        CANDIDATE_COMPOSE_DISK_RESERVE_BYTES + snapshotReserve, option.optionId);
      const row = join(path, key(option.askId, option.optionId));
      mkdirSync(row, { mode: 0o700 });
      const snapshots = new Map<string, Buffer>();
      const scene = prepareCandidateScene(root, project, option, asRelative(root, join(row, 'camera-free.scene.json')), snapshots);
      const { input, output } = await composeCandidate(root, project, asRelative(root, join(row, 'compose')), scene, snapshots);
      writeCandidatePackage(root, row, batch, option, input, output, project);
      rmSync(join(row, 'compose'), { recursive: true });
      rmSync(join(row, 'character'), { recursive: true, force: true });
      const snapshot = candidateStorageBytes(join(row, 'package')) + CANDIDATE_JOB_STATE_RESERVATION_BYTES;
      snapshotReserve += snapshot;
      optionReserve = Math.max(optionReserve, candidateStorageBytes(row) + snapshot);
      assertBatchStorage(storage, path, batch, snapshotReserve, snapshotReserve);
    }
    const release = acquireJobLock(root)!;
    try {
      const latest = readProject(root);
      const fresh = resolveCandidateSet(root, latest, question, setId, Date.now());
      if (fresh.binding.sha256 !== batch.setSha256) {
        refuse('CANDIDATE_OPTION_SET_STALE', `project.json: ${question}/${setId} is no longer the pending post option set. Run rig-create next <dir> and use the candidate open command it shows for the current set.`);
      }
      const links: { label: string; url: string }[] = [];
      for (const option of selection.options) {
        const row = join(path, key(option.askId, option.optionId));
        const proof = readCandidateProof(root, row, batch);
        if (candidateSourceChanged(root, latest, proof)) {
          invalidCandidate(asRelative(root, row), option.optionId);
        }
        const host = await openCandidateHost(row, reviewer);
        owned.push(host);
        const reply = await agentCall(host, {
          verb: 'publish', expectedGeneration: 0, idempotencyKey: proof.selector.receipt.sha256,
          freeze: { kind: 'producer-held', holdId: 'candidate', record: null }, result: { path: 'review.json', selector: proof.selector },
        });
        if (!reply.ok) refuse(reply.error?.code ?? 'JOB_PUBLISH_PENDING', 'scratch/candidates: Review refused the sealed candidate package; resolve the reported code before retrying candidate open');
        const publication = host.session.status().publication;
        if (!publication) invalidCandidate(asRelative(root, row), option.optionId);
        const link = { url: host.ownerUrl, selector: proof.selector, publicationId: publication.publicationId, sourceHash: publication.source.sourceHash };
        writePrivateJson(join(row, 'link.json'), link);
        assertBatchStorage(storage, path, batch, 0, 0);
        links.push({ label: proof.label, url: link.url });
      }
      writePrivateJson(join(path, 'ready.json'), { count: links.length });
      for (const link of links) console.log(`${link.label.replace(/[\r\n]+/g, ' ')} ${link.url}`);
    } finally { release(); }
  } catch (error) {
    await retireCandidateBatch(root, path, now, owned);
    throw error;
  }
}

type CandidateActWait = { timeoutMs: number; signal?: AbortSignal };

async function waitForCandidateAct(cursors: ReadonlyMap<JobOwnerHost, string | null>, deadlineMs: number,
  detachClosed: (host: JobOwnerHost) => void, signal?: AbortSignal) {
  const controller = new AbortController();
  const waitSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const waits = new Map([...cursors].map(([host, after]) => [host,
    waitForJobAct(host, { after, deadlineMs, signal: waitSignal }).then(({ kind }) => {
      if (kind === 'closed') detachClosed(host);
      return { host, kind };
    }),
  ]));
  const pending = [...waits.values()];
  try {
    while (waits.size) {
      const { host, kind } = await Promise.race(waits.values());
      if (kind !== 'closed') return kind;
      waits.delete(host);
    }
    return 'closed' as const;
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
  }
}

export async function listCandidateActs(root: string, project: JsonObject, wait?: CandidateActWait): Promise<{ jobId?: string; acts: PendingJobAct[] }> {
  const hosts = new Set<JobOwnerHost>();
  const detach = (host: JobOwnerHost) => { hosts.delete(host); host.stop(); };
  const read = async (host: JobOwnerHost, snapshot: { found: ActV3[]; cursors: Map<JobOwnerHost, string | null> }) => {
    const { acts, cursor } = await readHostActsAndAsks(host);
    if (wait) snapshot.cursors.set(host, cursor);
    snapshot.found.push(...acts.filter(act => act.kind === 'comments'));
  };
  const snapshot = () => ({ found: [] as ActV3[], cursors: new Map<JobOwnerHost, string | null>() });
  try {
    let jobId: string | undefined;
    let listed = snapshot();
    for (const batch of candidateBatchPaths(join(root, CANDIDATE_STORAGE_PATH))) {
      for (const row of candidateOptionPaths(batch)) {
        wait?.signal?.throwIfAborted();
        const link = readLink(row);
        const binding = link ? candidateHostBinding(row) : undefined;
        if (!binding) continue;
        const host = await attachCandidateHost(row, binding);
        if (!host) continue;
        jobId ??= binding.jobId;
        if (wait) hosts.add(host);
        try { await read(host, listed); }
        finally { if (!wait) host.stop(); }
      }
    }
    let acts = pendingJobActs(wait ? readProject(root) : project, listed.found, root);
    if (!wait || !jobId || acts.some(actionablePendingAct)) return { jobId, acts };

    const deadline = performance.now() + wait.timeoutMs;
    for (;;) {
      wait.signal?.throwIfAborted();
      const remaining = Math.min(wait.timeoutMs, Math.ceil(deadline - performance.now()));
      if (remaining <= 0) break;
      const outcome = await waitForCandidateAct(listed.cursors, remaining, detach, wait.signal).catch((error: unknown) => {
        if (wait.signal?.aborted) throw error;
        refuse('JOB_ACTS_READ_REFUSED', 'scratch/candidates: live candidate act wait failed; restore the candidate job and retry job acts');
      });
      if (outcome === 'timeout') break;
      if (outcome === 'closed') {
        refuse('JOB_ACTS_READ_REFUSED', 'scratch/candidates: all candidate jobs closed during the act wait; reopen a candidate before retrying job acts');
      }
      listed = snapshot();
      for (const host of hosts) await read(host, listed);
      // A writer may have recorded the comment between the wake and this scan.
      acts = pendingJobActs(readProject(root), listed.found, root);
      if (acts.some(actionablePendingAct)) return { jobId: hosts.values().next().value?.session.jobId, acts };
    }
    return refuse('JOB_NEXT_TIMEOUT', `project.json: no finalized un-ingested act arrived before the deadline; ${ingestedSummary({})}; an ingested act needs no ingest, otherwise retry job acts --wait`, 3);
  } finally {
    for (const host of hosts) host.stop();
  }
}

async function importComment(root: string, jobId: string, actId: string, now: number, json: boolean) {
  const project = readProject(root);
  const existing = Array.isArray(project.review_acts) ? project.review_acts.find(row => isObject(row)
    && row.kind === 'comments' && row.jobId === jobId && row.actId === actId) : undefined;
  if (isObject(existing) && typeof existing.bytes === 'string') {
    const finding = reviewActFindings(project)[0];
    if (finding) refuse(finding.code, finding.message);
    if (candidateCommentSubject(decodeReviewAct(existing.bytes, 'comments'))) {
      const result = { comment: `comments[${String(existing.comment)}]`, replayed: true };
      return { stdout: json ? JSON.stringify(result, null, 2)
        : `comment: ${actId} already recorded at ${result.comment}`, exit: 0 };
    }
  }
  for (const batch of candidateBatchPaths(join(root, CANDIDATE_STORAGE_PATH))) {
    for (const row of candidateOptionPaths(batch)) {
      const binding = candidateHostBinding(row);
      const link = readLink(row);
      if (binding?.jobId !== jobId || !link) continue;
      const host = await attachCandidateHost(row, binding);
      if (!host) continue;
      try { return await ingestFromCandidate(root, host, link, actId, now, json); }
      finally { host.stop(); }
    }
  }
  refuse('JOB_BINDING_INVALID', 'scratch/candidates: restore the live candidate job before fetching its comment');
}

function assertCandidateScratchIgnored(root: string): void {
  const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  if (git(['rev-parse', '--is-inside-work-tree']).exitCode !== 0) return;
  const tracked = git(['ls-files', '-z', '--', CANDIDATE_STORAGE_PATH]);
  if (tracked.exitCode !== 0 || tracked.stdout.length !== 0
    || git(['check-ignore', '--quiet', '--no-index', '--', `${CANDIDATE_STORAGE_PATH}/batch.json`]).exitCode !== 0) {
    refuse('JOB_PRIVATE_STORAGE_INVALID', 'scratch/candidates: keep the candidate directories untracked and ignored before running candidate open');
  }
}

async function run() {
  const request = JSON.parse(readFileSync(0, 'utf8')) as Request;
  const root = realpathSync(resolve(request.root));
  const verb = process.argv[2];
  if (verb === 'list') {
    console.log(JSON.stringify(await listCandidateActs(root, readProject(root))));
    return;
  }
  if (verb === 'comment') {
    const result = await importComment(root, request.jobId!, request.actId!, request.now, request.json === true);
    console.log(result.stdout);
    return;
  }
  if (verb !== 'open' && !lstatSync(join(root, CANDIDATE_STORAGE_PATH), { throwIfNoEntry: false })) return;
  if (verb === 'open') assertCandidateScratchIgnored(root);
  const storage = candidateStorage(root);
  const release = tryJobDirectoryLock(join(storage, '.lock'));
  if (!release) refuse('JOB_WRITE_BUSY', 'scratch/candidates: wait for the current candidate operation to finish, then retry');
  const owned: JobOwnerHost[] = [];
  try {
    if (verb === 'open') await openBatch(root, storage, request, owned);
    else await sweep(root, storage, request.now, request.question);
  } catch (error) {
    for (const host of owned) host.stop();
    throw error;
  } finally { release(); }

  if (!owned.length) return;
  const stop = () => {
    clearInterval(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    for (const host of owned) host.stop();
  };
  const timer = setInterval(() => {
    if (owned.every(host => {
      try { return host.session.status().status === 'closed'; }
      catch { return true; }
    })) stop();
  }, 1000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (import.meta.main) {
  try { await run(); }
  catch (error) {
    console.error(error instanceof Refusal ? formatRefusal(error) : error instanceof Error
      ? formatRefusal(new Refusal(String((error as { code?: string }).code ?? 'JOB_PUBLISH_PENDING'), error.message))
      : 'rig-create: JOB_PUBLISH_PENDING: scratch/candidates: retry candidate open or candidate close');
    process.exitCode = error instanceof Refusal ? error.exitCode : 1;
  }
}
