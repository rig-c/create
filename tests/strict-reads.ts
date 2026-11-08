/**
 * Strict mode for the recorded reader (create#286). Once installed, `node:fs`
 * and `fs` are replaced, for every module, by copies whose read functions
 * throw `CHECK_READ_UNRECORDED` when a recording session is active
 * (`checkProject(..., { recordReads: true })`) and a project file is read
 * without going through src/check-reads.ts. Outside a session they forward
 * unchanged, so installing it does not change any other test.
 *
 * The code is a test-only assertion: no user-facing command installs strict
 * mode, so it has no docs/CHECKS.md row.
 */
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { checkReadScope, projectRelative } from '../src/check-reads.ts';

export class CheckReadUnrecorded extends Error {
  readonly code = 'CHECK_READ_UNRECORDED';
  constructor(readonly fn: string, readonly path: string) {
    super(`${fn}(${path}) read a project file outside the recorded reader (src/check-reads.ts)`);
  }
}

const original: Record<string, unknown> = { ...fs };
const READS = ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'realpathSync', 'readdirSync', 'openSync', 'accessSync', 'opendirSync', 'readlinkSync'] as const;

function guarded(name: string, read: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    const scope = checkReadScope();
    const target = args[0];
    if (scope !== null && !scope.inside && (typeof target === 'string' || target instanceof URL || Buffer.isBuffer(target))) {
      const absolute = resolve(target instanceof URL ? target.pathname : String(target));
      // The root itself and every path under it, except the unrecorded subtrees.
      if (scope.roots.includes(absolute) || projectRelative(scope.roots, absolute) !== null) throw new CheckReadUnrecorded(name, absolute);
    }
    return read(...args);
  };
}

const strict: Record<string, unknown> = { ...original };
for (const name of READS) strict[name] = guarded(name, original[name] as (...args: unknown[]) => unknown);
strict.realpathSync = Object.assign(strict.realpathSync as object, { native: guarded('realpathSync.native', fs.realpathSync.native as (...args: unknown[]) => unknown) });
strict.default = strict;

let installed = false;

/** Replace `node:fs` and `fs` with the strict copies. Idempotent. */
export function installStrictReads(): void {
  if (installed) return;
  installed = true;
  mock.module('node:fs', () => strict);
  mock.module('fs', () => strict);
}

/** Restore the original modules. */
export function uninstallStrictReads(): void {
  if (!installed) return;
  installed = false;
  mock.module('node:fs', () => original);
  mock.module('fs', () => original);
}
