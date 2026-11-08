import { assertPartsCliArgs, assertPartsReadDraft, decodePartsRead, partsReadFindings, partsVerdictNames, PARTS_CLI_RECEIPT } from './parts-verdict-record.ts';
/** A parts verdict is recorded independently of signoff and stage progression. */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProject } from './feedback.ts';
import { readPartsReview, ReviewReadError, storeReviewRead, type ReviewReadRunner } from './review-read.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { acquireJobLock, jobHash, readAcknowledgedPublication, readWriterBinding } from './job-outbox.ts';
import { decodeReviewAct, reviewActFindings, reviewActTransport } from './review-act.ts';
import { assertPartsActSource, partsActDraftHash, partsActFindings, partsActReceipt } from './parts-act.ts';
import { newRefusals } from './refusal-baseline.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export const PARTS_REVIEW_HELP = 'parts-review [<project>] --from-review <actId> [--json] | parts-review [<project>] --draft <id> --from-review-cli --by <name> [--json] -- <rig-review parts arguments>';
export interface PartsReviewHooks {
  afterEvidence?: (path: string) => void;
  /** Replaces Review's resolution and spawn; the exit code and tool identity are still checked. */
  runCli?: ReviewReadRunner;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function partsReviewCommand(args: string[], now: number, hooks: PartsReviewHooks = {}): { stdout: string; exit: number } {
  let actId: string | undefined;
  const options: Record<string, string> = {};
  let json = false;
  let fromCli = false;
  let cliArgs: string[] = [];
  const positional: string[] = [];
  const usage = (): never => refuse('PARTS_REVIEW_OPTION_INVALID', `project.json.review_acts: ${PARTS_REVIEW_HELP}; submit human values through Review`, USAGE_EXIT);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { cliArgs = args.slice(i + 1); break; }
    if (arg === '--from-review-cli') { if (fromCli) usage(); fromCli = true; }
    else if (arg === '--json') { if (json) usage(); json = true; }
    else if (arg === '--from-review') { if (actId) usage(); actId = args[++i]; if (!actId || actId.startsWith('-')) usage(); }
    else if (['--draft', '--by'].includes(arg)) {
      const value = args[++i];
      if (options[arg] !== undefined || !value || value.startsWith('-')) usage();
      options[arg] = value;
    }
    else if (arg.startsWith('-')) usage();
    else positional.push(arg);
  }
  if (positional.length > 1 || (actId ? fromCli || Object.keys(options).length > 0 || cliArgs.length > 0 : !fromCli || Object.keys(options).length !== 2 || cliArgs.length === 0)) usage();
  if (fromCli && cliArgs.some(arg => arg === '--format' || arg.startsWith('--format='))) usage();
  const root = resolve(positional[0] ?? process.cwd());
  if (fromCli) assertPartsCliArgs(cliArgs);
  if (!actId) return recordCliVerdict(root, options, cliArgs, json, now, hooks);
  const release = acquireBoundJobWrite(root);
  let created: string | undefined;
  let committed = false;
  const temporary = join(root, `.parts-review-${randomUUID()}.tmp`);
  try {
    const transport = { ...reviewActTransport(root, actId!), kind: 'parts-verdict' };
    const child = Bun.spawnSync([process.execPath, fileURLToPath(new URL('./review-act-runtime.ts', import.meta.url))], {
      stdin: Buffer.from(JSON.stringify(transport)), stdout: 'pipe', stderr: 'pipe',
    });
    let response: { ok: boolean; bytes: string; code: string; message: string };
    try { response = JSON.parse(child.stdout.toString()); }
    catch { return refuse('REVIEW_ACT_FETCH_REFUSED', 'project.json.review_acts: fetch adapter failed; restore the live Review job'); }
    if (!response.ok || child.exitCode) refuse(response.code, response.message);
    const act = decodeReviewAct(response.bytes, 'parts-verdict');
    if (Date.parse(act.at) > now) refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: act is dated in the future; restore the clock before recording');
    const { file } = readProject(root);
    const original = readFileSync(file);
    const project = JSON.parse(original.toString('utf8')) as JsonObject;
    const invalid = [...reviewActFindings(project), ...partsActFindings(root, project), ...partsReadFindings(root, project)][0];
    if (invalid) refuse(invalid.code, invalid.message);
    assertPartsActSource(root, project, act);
    const hash = partsActDraftHash(project, act);
    const existing = partsActReceipt(project, act);
    const evidence = { path: `evidence/review-acts/${jobHash(JSON.stringify([act.jobId, act.actId]))}.json`, sha256: jobHash(response.bytes) };
    const warnings: string[] = [];
    if (existing) {
      if (existing.bytes !== response.bytes) refuse('REVIEW_ACT_REPLAY_CONFLICT', 'project.json.review_acts: immutable parts act changed; restore the original receipt');
      if (existing.version_hash !== hash) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: reviewed draft entry changed; review a new draft id');
    } else {
      const publication = readAcknowledgedPublication(root, act.jobId, act.publicationId);
      if (publication && (publication.versionHash !== hash || publication.result.selector?.kind !== 'draft' || publication.result.selector.id !== act.source.selector.id)) {
        refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.review_acts: draft differs from its acknowledged publication; record and review a new id');
      }
      if (!publication) warnings.push('REVIEW_ACT_VERSION_UNVERIFIED: project.json.review_acts: publication receipt is absent, so the first-ingest draft-entry check was skipped; retain acknowledged receipts');
      const directory = dirname(join(root, evidence.path));
      for (const segment of ['evidence', 'evidence/review-acts']) {
        const path = join(root, segment);
        let info;
        try { info = lstatSync(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          mkdirSync(path);
          syncDirectory(dirname(path));
          info = lstatSync(path);
        }
        if (!info.isDirectory() || info.isSymbolicLink()) refuse('PARTS_REVIEW_EVIDENCE_CONFLICT', 'project.json.review_acts: evidence directory is unsafe; restore its original real directory');
      }
      const path = join(root, evidence.path);
      let present = false;
      try { lstatSync(path); present = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (present) {
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(Buffer.from(response.bytes))) {
          refuse('PARTS_REVIEW_EVIDENCE_CONFLICT', `project.json.review_acts: ${evidence.path} contains another act; preserve it and restore the original evidence before retrying`);
        }
        const fd = openSync(path, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } else {
        const fd = openSync(path, 'wx', 0o600);
        created = path;
        try { writeFileSync(fd, response.bytes); fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(directory);
      }
      hooks.afterEvidence?.(path);
      const next = structuredClone(project);
      next.review_acts = [...(project.review_acts as JsonObject[] ?? []), { schema: 'rig-create/review-act@1', kind: 'parts-verdict',
        jobId: act.jobId, actId: act.actId, draft_id: act.source.selector.id, version_hash: hash,
        bytes: response.bytes, sha256: evidence.sha256, evidence }];
      const failure = [...reviewActFindings(next), ...partsActFindings(root, next), ...newRefusals(root, project, next, { now })][0];
      if (failure) refuse(failure.code, failure.message);
      assertPartsActSource(root, project, act);
      if (!readFileSync(file).equals(original)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during parts verdict validation; retry against the current job');
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file);
      committed = true;
      syncDirectory(root);
    }
    const result = { draft_id: act.source.selector.id, evidence, verdict: act.value.verdict,
      by: act.authority.reviewer.role === 'owner' ? 'user' : 'delegate', at: act.at, verbatim: act.value.words,
      ...(warnings.length ? { warnings } : {}) };
    return { stdout: json ? JSON.stringify(result, null, 2) : [...warnings, `parts-review: ${result.draft_id} ${result.verdict}, evidence ${evidence.path}`].join('\n'), exit: 0 };
  } finally {
    if (created && !committed) rmSync(created, { force: true });
    rmSync(temporary, { force: true });
    release();
  }
}

function recordCliVerdict(root: string, options: Record<string, string>, cliArgs: string[], json: boolean, now: number, hooks: PartsReviewHooks): { stdout: string; exit: number } {
  if (!options['--by'].trim() || options['--by'].toLowerCase() === 'agent') refuse('SIGNOFF_NOT_HUMAN', 'project.json.review_acts.by: supply the human reviewer with --by');
  const release = readWriterBinding(root) ? acquireBoundJobWrite(root) : acquireJobLock(root)!;
  const temporary = join(root, `.parts-review-${randomUUID()}.tmp`);
  let created: string | undefined;
  let committed = false;
  try {
    const { file } = readProject(root);
    const original = readFileSync(file);
    const project = JSON.parse(original.toString('utf8')) as JsonObject;
    const invalid = [...reviewActFindings(project), ...partsActFindings(root, project), ...partsReadFindings(root, project)][0];
    if (invalid) refuse(invalid.code, invalid.message);
    const draftId = options['--draft'];
    let bytes: Buffer;
    try { bytes = readPartsReview(root, cliArgs, hooks.runCli).stdout; }
    catch (error) {
      if (!(error instanceof ReviewReadError)) throw error;
      return refuse('PARTS_REVIEW_CLI_FAILED', `project.json.review_acts: rig-review ${error.why}; restore the pinned rig-review installation and the saved verdict, then retry its original display arguments`);
    }
    const verdict = decodePartsRead(bytes);
    assertPartsReadDraft(root, project, verdict, draftId);
    const hash = jobHash(bytes);
    const receipts = project.review_acts as JsonObject[] | undefined;
    const existing = receipts?.find(entry => entry.schema === PARTS_CLI_RECEIPT && entry.draft_id === draftId && (entry.evidence as JsonObject).sha256 === hash);
    if (existing) return { stdout: json ? JSON.stringify(existing, null, 2) : `parts-review: ${draftId} ${existing.status}, already recorded`, exit: 0 };
    const evidence = { kind: 'parts-verdict', path: `evidence/review-reads/${hash}.json`, sha256: hash };
    const receipt: JsonObject = { schema: PARTS_CLI_RECEIPT, kind: 'parts-verdict', draft_id: draftId, evidence,
      route: 'cli', argv: cliArgs, tool: verdict.tool, status: verdict.status, ...partsVerdictNames(verdict), by: options['--by'], at: new Date(now).toISOString() };
    const path = join(root, evidence.path);
    try { if (storeReviewRead(root, bytes).created) created = path; }
    catch (error) {
      if (!(error instanceof ReviewReadError)) throw error;
      refuse('PARTS_REVIEW_EVIDENCE_CONFLICT', `project.json.review_acts.evidence: ${error.why}; preserve and restore the original content-addressed verdict in a real evidence directory`);
    }
    hooks.afterEvidence?.(path);
    const next = structuredClone(project);
    next.review_acts = [...(receipts ?? []), receipt];
    const failure = [...partsReadFindings(root, next), ...newRefusals(root, project, next, { now })][0];
    if (failure) refuse(failure.code, failure.message);
    if (!readFileSync(file).equals(original)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during validation; retry against the current record');
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    committed = true;
    syncDirectory(root);
    return { stdout: json ? JSON.stringify(receipt, null, 2) : `parts-review: ${draftId} ${receipt.status}, evidence ${evidence.path}`, exit: 0 };
  } finally {
    if (created && !committed) rmSync(created, { force: true });
    rmSync(temporary, { force: true });
    release();
  }
}
