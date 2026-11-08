/**
 * The recorded reader: the one place the check modules read project files
 * through (create#286). It has the same shape as the `node:fs` read functions
 * it wraps, so a module switches by changing its import and nothing else.
 *
 * Outside a recording session it only forwards to `node:fs`. Inside
 * `recordCheckReads(dir, run)`, every project file the run opens, stats,
 * resolves or lists is recorded as `{path, sha256}` of its bytes at that
 * moment. The set is the check's closure: a copy of exactly those files gives
 * the check the same bytes, so it gives the same result.
 *
 * Two subtrees are not record files and are never recorded: the job's private
 * outbox (`JOB_PRIVATE_DIRECTORY`, job state rather than evidence) and
 * `node_modules/` (the installed toolchain, which `require` loads outside this
 * reader).
 *
 * This module imports only node builtins, so every check module can import
 * it without an evaluation cycle. The strict test harness
 * (tests/strict-reads.ts) reads `checkReadScope()` to tell a read made through
 * this reader from one that bypasses it.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** The job's private sibling inside a project root (src/job-outbox.ts). */
export const JOB_PRIVATE_DIRECTORY = '.rig-create-review';
const UNRECORDED = [JOB_PRIVATE_DIRECTORY, 'node_modules'];

export interface CheckRead { readonly path: string; readonly sha256: string }

interface Session { readonly roots: readonly string[]; readonly files: Map<string, string> }

let session: Session | null = null;
let depth = 0;

/** The active session's roots, and whether the current call is inside this reader. */
export function checkReadScope(): { readonly roots: readonly string[]; readonly inside: boolean } | null {
  return session === null ? null : { roots: session.roots, inside: depth > 0 };
}

/** The project-relative path of `absolute`, or null outside the roots and in an unrecorded subtree. */
export function projectRelative(roots: readonly string[], absolute: string): string | null {
  for (const root of roots) {
    const rel = relative(root, absolute);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    const parts = rel.split(sep);
    return UNRECORDED.includes(parts[0]!) ? null : parts.join('/');
  }
  return null;
}

function note(path: fs.PathLike | number): void {
  if (session === null || typeof path === 'number') return;
  const absolute = resolve(path instanceof URL ? path.pathname : String(path));
  const rel = projectRelative(session.roots, absolute);
  if (rel === null || session.files.has(rel)) return;
  let file = false;
  try { file = fs.statSync(absolute).isFile(); } catch { return; }
  if (file) session.files.set(rel, createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'));
}

function recorded<F extends (...args: never[]) => unknown>(read: F, after: (args: Parameters<F>, out: ReturnType<F>) => void): F {
  return ((...args: Parameters<F>) => {
    depth++;
    try {
      const out = read(...args) as ReturnType<F>;
      if (session !== null) after(args, out);
      return out;
    } finally { depth--; }
  }) as F;
}

const first = (args: readonly unknown[]): void => note(args[0] as fs.PathLike);

export const readFileSync: typeof fs.readFileSync = recorded(fs.readFileSync, first);
export const existsSync: typeof fs.existsSync = recorded(fs.existsSync, first);
export const lstatSync: typeof fs.lstatSync = recorded(fs.lstatSync, first);
export const statSync: typeof fs.statSync = recorded(fs.statSync, first);
export const realpathSync: typeof fs.realpathSync = Object.assign(recorded(fs.realpathSync, first), { native: recorded(fs.realpathSync.native, first) });
/** A listing depends on every entry, so each listed regular file is recorded. */
export const readdirSync: typeof fs.readdirSync = recorded(fs.readdirSync, (args, out) => {
  const dir = String(args[0]);
  for (const entry of out as unknown[]) {
    const name = typeof entry === 'string' ? entry : Buffer.isBuffer(entry) ? entry.toString() : (entry as fs.Dirent).name;
    note(resolve(dir, name));
  }
});

/**
 * Run `run` and return what it produced with every project file it read under
 * `dir`, sorted by path. Sessions do not nest.
 */
export function recordCheckReads<T>(dir: string, run: () => T): { readonly value: T; readonly reads: readonly CheckRead[] } {
  if (session !== null) throw new Error('check read recording does not nest');
  const absolute = resolve(dir);
  let real = absolute;
  try { real = fs.realpathSync(absolute); } catch { /* A missing root records nothing. */ }
  const files = new Map<string, string>();
  session = { roots: real === absolute ? [absolute] : [absolute, real], files };
  try {
    const value = run();
    const reads = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, sha256]) => ({ path, sha256 }));
    return { value, reads };
  } finally { session = null; }
}
