import { join } from 'node:path';
import { readFileSync } from './check-reads.ts';

export const CREATE_PACKAGE = '@rig-c/create';

/** The running Create release version, read from Create's own package.json. */
export function runningCreateVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
  if (pkg !== null && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  return 'unknown';
}

/**
 * The rig-c packages a new project uses alongside `@rig-c/create`, at exact versions.
 * `init` writes these and the running `@rig-c/create` into the project's package.json,
 * and a test checks they stay exact (no ranges).
 *
 * Core is pinned as `@rig-c/core`, its canonical name (rig-c/core README) and
 * the name `@rig-c/parts` depends on. `rig-c` is the same package under a
 * convenience name; pinning it as well installs core twice, with two `rigc` bins.
 *
 * `interview.question_set` in templates/project.json names the @rig-c/parts
 * version its waypoints were read from; a test keeps it equal to the pin, so
 * bumping parts here without re-reading the waypoints fails.
 */
export const PINNED_PACKAGES = {
  '@rig-c/core': '3.9.2',
  '@rig-c/parts': '2.60.0',
} as const satisfies Record<string, string>;
