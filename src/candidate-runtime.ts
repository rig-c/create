import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ActV3, JobOwnerHost, JobReviewerBinding } from '@rig-c/review/job-host';
import { candidateBatchPath, candidateBatchPaths, candidateStorage, candidateStorageBytes, assertCandidateStorage,
  CANDIDATE_STORAGE_PATH, CANDIDATE_OPTION_RESERVATION_BYTES, CANDIDATE_COMPOSE_DISK_RESERVE_BYTES,
  CANDIDATE_JOB_STATE_RESERVATION_BYTES, candidateOptionPaths, readCandidateBatchIdentity, type CandidateBatchIdentity } from './candidate-storage.ts';
import { attachCandidateHost, candidateHostBinding, closeCandidateHost, openCandidateHost, awaitCandidateListenerStop } from './candidate-host.ts';
import { invalidCandidate, readCandidateProof, writeCandidatePackage, type CandidateSelector } from './candidate-package.ts';
import { composeCandidate, prepareCandidateScene, resolveCandidateSet } from './candidate.ts';
import { ingestReviewComment } from './comment-act.ts';
import { candidateCommentSubject, type CommentOnlyAct } from './comment-record.ts';
import { currentRigFileBinding, sha256 } from './current.ts';
import { agentCall, pendingJobActs, readHostActs, type PendingJobAct } from './job-acts.ts';
import { acquireJobLock, privateJson, tryJobDirectoryLock, writePrivateJson } from './job-outbox.ts';
import { requireOwnerLanguage } from './owner-language.ts';
import { formatRefusal, Refusal, refuse } from './refusal.ts';
import { decodeReviewAct, fetchReviewAct, reviewActFindings, type ReviewActTransport } from './review-act.ts';
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

async function sweep(root: string, storage: string, now: number, closeQuestion?: string): Promise<void> {
  const project = readProject(root);
  for (const path of candidateBatchPaths(storage)) {
    const batch = readCandidateBatchIdentity(storage, path);
    if (!batch || batch.question === closeQuestion || !pendingMatches(project, root, batch)
      || !lstatSync(join(path, 'ready.json'), { throwIfNoEntry: false })) {
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
      const currentModel = currentRigFileBinding(latest, 'check/build/skeleton.model.json');
      const latestMotion = isObject(latest.current) && isObject(latest.current.motion) ? latest.current.motion : undefined;
      const links: { label: string; url: string }[] = [];
      for (const option of selection.options) {
        const row = join(path, key(option.askId, option.optionId));
        const proof = readCandidateProof(root, row, batch);
        if (proof.rigSha256 !== currentModel?.sha256 || proof.motionSha256 !== latestMotion?.files_sha256) {
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

export async function listCandidateActs(root: string, project: JsonObject): Promise<{ jobId?: string; acts: PendingJobAct[] }> {
  const found: ActV3[] = [];
  let jobId: string | undefined;
  for (const batch of candidateBatchPaths(join(root, CANDIDATE_STORAGE_PATH))) {
    for (const row of candidateOptionPaths(batch)) {
      const link = readLink(row);
      const binding = link ? candidateHostBinding(row) : undefined;
      if (!binding) continue;
      const host = await attachCandidateHost(row, binding);
      if (!host) continue;
      try {
        jobId ??= binding.jobId;
        found.push(...(await readHostActs(host)).filter(act => act.kind === 'comments'));
      } finally { host.stop(); }
    }
  }
  return { jobId, acts: pendingJobActs(project, found, root) };
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
