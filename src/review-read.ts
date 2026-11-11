/** Read Review through its CLI and retain the exact response bytes owned by create.
 * Every Review read (feedback and parts) spawns through one path and is bound at check time by one stored-read validator. */
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_COMMENTS_SESSION_SCHEMA, REVIEW_COMMENTS_COMPARE_SESSION_SCHEMA,
    parseCommentsSession, parseCommentsCompareSession, projectSelectedCommentsFeedback } from '@rig-c/review/job-host';
import { jobRuntimeExecArgv } from './job-writer.ts';
import type { JsonObject } from './templates.ts';
export const REVIEW_READ_SINCE = '2026-11-08T00:00:00Z';
/** `unavailable`: the stored file is missing or not a regular file; `changed`: its bytes differ from the binding. */
export type ReviewReadReason = 'invalid' | 'unavailable' | 'changed';
export class ReviewReadError extends Error {
    readonly code = 'REVIEW_READ_INVALID';
    constructor(readonly why: string, readonly reason: ReviewReadReason = 'invalid') {
        super(`evidence/review-reads: ${why}; retrieve the saved result through rig-review feedback --format json and retain its CLI receipt`);
    }
}
export interface ReviewReadResult {
    stdout: Buffer;
    stderr: string;
    exitCode: number;
    tool: {
        name: string;
        version: string;
    };
}
export type ReviewReadRunner = (dir: string, argv: string[]) => ReviewReadResult;
export interface StoredReviewRead {
    path: string;
    sha256: string;
}
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const invalid = (why: string, reason?: ReviewReadReason): never => { throw new ReviewReadError(why, reason); };
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function safePath(dir: string, path: string): string {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))
        invalid('expected a literal project-relative response path');
    let file = realpathSync(dir);
    for (const [index, part] of path.split('/').entries()) {
        file = join(file, part);
        let stat;
        try { stat = lstatSync(file); }
        catch { return invalid(`${path} is unavailable`, 'unavailable'); }
        if (stat.isSymbolicLink() || (index === path.split('/').length - 1 ? !stat.isFile() : !stat.isDirectory()))
            invalid('response path contains a symlink or nonregular entry', 'unavailable');
    }
    return file;
}
function syncDirectory(path: string): void {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
function session(bytes: Buffer): JsonObject {
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        return invalid('CLI stdout is not JSON');
    }
    if (object(value) && value.schema === REVIEW_COMMENTS_SESSION_SCHEMA)
        return parseCommentsSession(value) as unknown as JsonObject;
    if (object(value) && value.schema === REVIEW_COMMENTS_COMPARE_SESSION_SCHEMA)
        return parseCommentsCompareSession(value) as unknown as JsonObject;
    if (!object(value) || value.schema !== 'rig-review-session/1' || !Array.isArray(value.feedback))
        return invalid('CLI stdout must contain a single review session');
    return value;
}
/** The single-build source required by Create's existing Apply adapters. */
export function reviewSessionSource(value: JsonObject): JsonObject | null {
    return (value.schema === 'rig-review-session/1' || value.schema === REVIEW_COMMENTS_SESSION_SCHEMA) && object(value.reviewedSource)
        ? value.reviewedSource : null;
}

/** Select canonical feedback rows while retaining the original session and bytes. */
export function selectedReviewFeedback(value: JsonObject, itemId: string): JsonObject[] {
    if (value.schema === REVIEW_COMMENTS_SESSION_SCHEMA) {
        const parsed = parseCommentsSession(value);
        const matches = parsed.comments.filter(comment => comment.anchor && 'frameStart' in comment.anchor && comment.anchor.id === itemId);
        if (matches.length !== 1) return [];
        const selected = projectSelectedCommentsFeedback(parsed, itemId);
        return [{ ...selected.anchor, summary: selected.summary } as unknown as JsonObject];
    }
    return Array.isArray(value.feedback)
        ? value.feedback.filter(object).filter(item => item.id === itemId) : [];
}

/** Review is resolved from the project, then its collection, then create's own installation. */
function reviewRoot(dir: string): string | undefined {
    const collection = basename(dirname(dir)) === 'members' ? [join(dirname(dirname(dir)), 'node_modules/@rig-c/review')] : [];
    let installed: string[] = [];
    try { installed = [dirname(fileURLToPath(import.meta.resolve('@rig-c/review/package.json')))]; }
    catch { /* Not installed with create. */ }
    return [join(dir, 'node_modules/@rig-c/review'), ...collection, ...installed].find(path => existsSync(join(path, 'package.json')));
}
function runReview(dir: string, argv: string[]): ReviewReadResult {
    const root = reviewRoot(dir);
    if (!root)
        return invalid('install @rig-c/review before querying it');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        bin: Record<string, string>;
    };
    if (pkg.name !== '@rig-c/review' || typeof pkg.version !== 'string' || typeof pkg.bin?.['rig-review'] !== 'string')
        return invalid('installed Review has no rig-review CLI');
    const result = Bun.spawnSync([process.execPath, ...jobRuntimeExecArgv(), join(root, pkg.bin['rig-review']), ...argv.slice(1)], { cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
    return { stdout: result.stdout, stderr: result.stderr.toString('utf8'), exitCode: result.exitCode, tool: { name: pkg.name, version: pkg.version } };
}
/** The one spawn path: resolve Review, run `rig-review <argv>`, then check its exit code and tool identity. */
function runReviewCli(dir: string, argv: string[], runner: ReviewReadRunner): ReviewReadResult {
    let result: ReviewReadResult;
    try {
        result = runner(dir, [...argv]);
    }
    catch (error) {
        if (error instanceof ReviewReadError)
            throw error;
        return invalid(`${argv[1]} could not run: ${message(error)}`);
    }
    if (result.exitCode !== 0)
        return invalid(`${argv[1]} exited ${result.exitCode}: ${result.stderr.trim() || 'no diagnostic returned'}`);
    if (result.tool?.name !== '@rig-c/review' || typeof result.tool.version !== 'string' || !result.tool.version.trim())
        return invalid('CLI tool name and version are required');
    return result;
}
/** Retain stdout once under its sha256. `created` is false when the same bytes were already stored. */
export function storeReviewRead(dir: string, bytes: Buffer): { file: StoredReviewRead; created: boolean } {
    const digest = sha(bytes);
    const path = `evidence/review-reads/${digest}.json`;
    // Create one directory at a time, checking each ancestor before using it.
    let parent = realpathSync(dir);
    for (const part of ['evidence', 'review-reads']) {
        parent = join(parent, part);
        let made = false;
        try {
            mkdirSync(parent);
            made = true;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
        }
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return invalid('response store must use real directories');
        if (made)
            syncDirectory(dirname(parent));
    }
    const temporary = join(parent, `.review-read-${process.pid}-${crypto.randomUUID()}.tmp`);
    let created = false;
    try {
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        try {
            linkSync(temporary, join(parent, `${digest}.json`));
            created = true;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
    } finally {
        rmSync(temporary, { force: true });
    }
    if (created)
        syncDirectory(parent);
    if (!readFileSync(safePath(dir, path)).equals(bytes))
        return invalid('existing content-addressed response differs from stdout');
    return { file: { path, sha256: digest }, created };
}
/** The one stored-read validator. Check consumes only create's stored stdout and never invokes Review. */
export function storedReviewRead(dir: string, stdout: unknown): Buffer {
    try {
        if (!object(stdout) || typeof stdout.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(stdout.sha256)
            || stdout.path !== `evidence/review-reads/${stdout.sha256}.json`)
            return invalid('stdout binding must name its content-addressed response');
        const bytes = readFileSync(safePath(dir, stdout.path));
        if (sha(bytes) !== stdout.sha256)
            return invalid('stored stdout differs from its sha256', 'changed');
        return bytes;
    }
    catch (error) {
        if (error instanceof ReviewReadError)
            throw error;
        return invalid(message(error), 'unavailable');
    }
}
/** Parts read: `rig-review parts <args> --format json`. Decoding and the draft binding belong to the parts route. */
export function readPartsReview(dir: string, args: string[], runner: ReviewReadRunner = runReview): ReviewReadResult {
    return runReviewCli(dir, ['rig-review', 'parts', ...args, '--format', 'json'], runner);
}
export function readReview(dir: string, input: string, runner: ReviewReadRunner = runReview): {
    receipt: JsonObject;
    value: JsonObject;
    file: JsonObject;
} {
    try {
        const argv = ['rig-review', 'feedback', input, '--format', 'json'];
        const result = runReviewCli(dir, argv, runner);
        const value = session(result.stdout);
        const { file } = storeReviewRead(dir, result.stdout);
        const receipt: JsonObject = { route: 'cli', argv, stdout: { ...file }, tool: result.tool };
        return { receipt, value, file: { ...file } };
    }
    catch (error) {
        if (error instanceof ReviewReadError)
            throw error;
        return invalid(message(error));
    }
}
/** A feedback read's inline receipt, bound through the shared stored-read validator. */
export function retainedReviewRead(dir: string, receipt: unknown, expected?: unknown): JsonObject {
    try {
        if (!object(receipt) || Object.keys(receipt).sort().join(',') !== 'argv,route,stdout,tool' || receipt.route !== 'cli'
            || !Array.isArray(receipt.argv) || receipt.argv.length !== 5 || receipt.argv.some(arg => typeof arg !== 'string')
            || receipt.argv[0] !== 'rig-review' || receipt.argv[1] !== 'feedback' || !receipt.argv[2] || receipt.argv[3] !== '--format' || receipt.argv[4] !== 'json'
            || !object(receipt.tool) || Object.keys(receipt.tool).sort().join(',') !== 'name,version' || receipt.tool.name !== '@rig-c/review' || typeof receipt.tool.version !== 'string' || !receipt.tool.version.trim()
            || !object(receipt.stdout) || Object.keys(receipt.stdout).sort().join(',') !== 'path,sha256' || typeof receipt.stdout.sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(receipt.stdout.sha256) || receipt.stdout.path !== `evidence/review-reads/${receipt.stdout.sha256}.json`)
            return invalid('invalid CLI receipt');
        if (expected !== undefined && (!object(expected) || Object.keys(expected).sort().join(',') !== 'path,sha256' || expected.path !== receipt.stdout.path || expected.sha256 !== receipt.stdout.sha256))
            return invalid('record binding differs from the CLI stdout binding');
        return session(storedReviewRead(dir, receipt.stdout));
    }
    catch (error) {
        if (error instanceof ReviewReadError)
            throw error;
        return invalid(message(error));
    }
}
export function reviewReadLegacy(at: unknown): boolean {
    const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    return !Number.isFinite(time) || time < Date.parse(REVIEW_READ_SINCE);
}
