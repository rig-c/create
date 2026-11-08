/** Read Review through its CLI and retain the exact response bytes owned by create. */
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { JsonObject } from './templates.ts';
export const REVIEW_READ_SINCE = '2026-11-08T00:00:00Z';
export class ReviewReadError extends Error {
    readonly code = 'REVIEW_READ_INVALID';
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
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const invalid = (why: string): never => { throw new ReviewReadError(`evidence/review-reads: ${why}; retrieve the saved result through rig-review feedback --format json and retain its CLI receipt`); };
function safePath(dir: string, path: string): string {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))
        invalid('expected a literal project-relative response path');
    let file = realpathSync(dir);
    for (const [index, part] of path.split('/').entries()) {
        file = join(file, part);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || (index === path.split('/').length - 1 ? !stat.isFile() : !stat.isDirectory()))
            invalid('response path contains a symlink or nonregular entry');
    }
    return file;
}
function session(bytes: Buffer): JsonObject {
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        return invalid('CLI stdout is not JSON');
    }
    if (!object(value) || value.schema !== 'rig-review-session/1' || !Array.isArray(value.feedback))
        return invalid('CLI stdout must contain a single review session');
    return value;
}
function runReview(dir: string, argv: string[]): ReviewReadResult {
    const collection = basename(dirname(dir)) === 'members' ? [join(dirname(dirname(dir)), 'node_modules/@rig-c/review')] : [];
    const candidates = [join(dir, 'node_modules/@rig-c/review'), ...collection, join(import.meta.dir, '../node_modules/@rig-c/review')];
    const root = candidates.find(path => existsSync(join(path, 'package.json')));
    if (!root)
        return invalid('install @rig-c/review before querying feedback');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        bin: Record<string, string>;
    };
    if (pkg.name !== '@rig-c/review' || typeof pkg.version !== 'string' || typeof pkg.bin?.['rig-review'] !== 'string')
        return invalid('installed Review has no rig-review CLI');
    const result = Bun.spawnSync([process.execPath, join(root, pkg.bin['rig-review']), ...argv.slice(1)], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    return { stdout: result.stdout, stderr: result.stderr.toString('utf8'), exitCode: result.exitCode, tool: { name: pkg.name, version: pkg.version } };
}
export function readReview(dir: string, input: string, runner: ReviewReadRunner = runReview): {
    receipt: JsonObject;
    value: JsonObject;
    file: JsonObject;
} {
    try {
        return captureReview(dir, input, runner);
    }
    catch (error) {
        if (error instanceof ReviewReadError)
            throw error;
        return invalid(error instanceof Error ? error.message : String(error));
    }
}
function captureReview(dir: string, input: string, runner: ReviewReadRunner): {
    receipt: JsonObject;
    value: JsonObject;
    file: JsonObject;
} {
    const argv = ['rig-review', 'feedback', input, '--format', 'json'];
    const result = runner(dir, [...argv]);
    if (result.exitCode !== 0)
        return invalid(`feedback exited ${result.exitCode}: ${result.stderr.trim()}`);
    if (result.tool.name !== '@rig-c/review' || !result.tool.version.trim())
        return invalid('CLI tool name and version are required');
    const value = session(result.stdout);
    const digest = sha(result.stdout);
    const path = `evidence/review-reads/${digest}.json`;
    // Create one directory at a time, checking each ancestor before using it.
    let parent = realpathSync(dir);
    for (const part of ['evidence', 'review-reads']) {
        parent = join(parent, part);
        try {
            mkdirSync(parent);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
        }
        if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
            return invalid('response store must use real directories');
    }
    const temporary = join(parent, `.review-read-${process.pid}-${crypto.randomUUID()}.tmp`);
    try {
        writeFileSync(temporary, result.stdout, { flag: 'wx' });
        try { linkSync(temporary, join(dir, path)); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
    } finally {
        rmSync(temporary, { force: true });
    }
    if (!readFileSync(safePath(dir, path)).equals(result.stdout))
        return invalid('existing content-addressed response differs from stdout');
    const file = { path, sha256: digest };
    const receipt: JsonObject = { route: 'cli', argv, stdout: file, tool: result.tool };
    return { receipt, value, file };
}
/** Check consumes only create's stored API response and never invokes Review. */
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
        const bytes = readFileSync(safePath(dir, String(receipt.stdout.path)));
        if (sha(bytes) !== receipt.stdout.sha256)
            return invalid('stored stdout differs from its sha256');
        return session(bytes);
    }
    catch (error) {
        if (error instanceof ReviewReadError)
            throw error;
        return invalid(error instanceof Error ? error.message : String(error));
    }
}
export function reviewReadLegacy(at: unknown): boolean {
    const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    return !Number.isFinite(time) || time < Date.parse(REVIEW_READ_SINCE);
}
