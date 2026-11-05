/**
 * The rig-c packages a new project uses, at exact versions. This is the only
 * place they are written: init copies them into the project's package.json,
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
  '@rig-c/core': '3.2.1',
  '@rig-c/parts': '2.14.2',
} as const satisfies Record<string, string>;
