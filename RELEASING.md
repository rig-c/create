# Releasing @rig-c/create

The first public version, `1.0.0`, was published manually. From the second
version on, the cut is **merge the release PR → tag on main → `release.yml`
publishes**. The owner chooses and bumps each version in the release PR.
The owner sets the npm trusted publisher for `@rig-c/create` on npm to repository
`rig-c/create` and workflow filename `release.yml`. This is an npm setting,
not a repository secret. The workflow uses OIDC with provenance on GitHub-hosted
runners; it needs no npm token or OTP. The owner configures the same trusted
publisher for the convenience alias `rig-create`.

## Prepare the candidate

1. Read the current `AGENTS.md` and the release issue. Keep `private` absent and
   audit the `files` allowlist: runtime source, templates, README, licence and
   the README-linked docs. `docs/CHECKS.md` is also read by `next` at runtime.
   Repository tests, scripts, workflows and development instructions do not ship.
2. Choose an unused version and edit `package.json` manually. Do not use an
   automatic version command that also commits or tags. Update `bun.lock` with
   Bun when the manifest changes require it. Keep dependency pins exact and
   published; a package-version bump alone does not advance dependency pins.
3. Apply the complete dependency-pin checklist below for any release-pin bump.
   Do not move a pin to an unpublished version or substitute a sibling checkout.
4. Run typecheck, lint and the tests mechanically identified from the changed
   paths and module references, following the current validation policy. Review
   every command's exit and first error. Required PR checks and the cross-family
   review in `AGENTS.md` must pass at the candidate head before release.
5. Run `npm pack --dry-run --json`, then `npm pack --json --pack-destination
   <evidence-dir>`. Keep the evidence directory outside the repository. Record
   the exact file list, entry count, packed and unpacked byte sizes, integrity
   and tarball SHA-256. Audit public content and runtime reads, including
   `readFileSync`, `import.meta.dir` and `new URL`. A runtime dependency on an
   excluded test or script blocks release; do not add those development folders
   to hide it.
6. In an empty directory outside the repository, install that tarball using Bun
   and registry dependencies. Run the installed `rig-create --help`,
   `rig-create init p1`, `rig-create interview --check p1 --json` and
   `rig-create next p1 --json`. Try normal init first; use `--no-install` only
   when needed and retain the original failure. A fresh interview's missing-work
   refusals are expected; missing runtime files or imports are release blockers.
7. Repeat in another empty directory with
   `bunx --package <absolute-tarball-path> rig-create` followed by the same four
   command arguments. Verify both routes resolve the tarball, not a checkout or
   global installation. Keep command, exit, first-error and output receipts.

## Dependency pins: AGENTS.md invariant 4

The development pin in `scripts/source-ci-pins.json` and release pins in
`package.json` and `bun.lock` move independently. Development pins may advance
to sibling main SHAs at or after the registry pins' release tags. A dev-only
bump does not rewrite release templates. Release pins use published exact
versions, never ranges. The play floor is the dependency declared by the
release-pinned Review tag.

For every release dependency bump, check all of these:

- `package.json` and `bun.lock` agree on published exact versions.
- Update applicable entries in `src/pins.ts`.
- Update `question_set` in `templates/project.json`,
  `templates/collection.json` and `templates/example-project.json`.
- Update versioned links in `docs/`.
- Keep the transitive `@rig-c/core` equal to the version parts pins.
- Regenerate `templates/example-split/captions.json` whenever
  `templates/example-project.json` changes, using its producer script. Never
  hand-edit producer bytes or reserialize entire JSON templates.
- Confirm no old release version string remains in current pin declarations.
- Re-evaluate `scripts/source-only-tests.json` when the published dependencies
  gain a formerly source-only capability; remove the applicable exclusion and
  verify that exact test executes and passes with registry dependencies.

`source-linked` runs typecheck, lint and the full suite with isolated source
links, retaining exact-name coverage and child-resolution checks. Registry
`check` continues on every PR until main branch protection requires only
`source-linked`; only then does a one-line follow-up remove its general PR
condition. Registry checks remain on main pushes, manual dispatches and PRs
labelled `release`, the explicit Create release trigger. After that protection
change, a consumer-entry generation failure is caught on main rather than on
the PR. Release preparation must include the registry result.

## Tag publication

After the approved candidate lands, the owner verifies its exact main commit,
version and checks, then pushes the matching strict `vX.Y.Z` tag on that commit.
Creating the tag and GitHub release with reviewed notes remains an explicit
owner action, not a side effect of package scripts.

`.github/workflows/release.yml` resolves the tag to a full commit SHA and
requires that SHA to match the run's `GITHUB_SHA` and fetched tag, be reachable
from `origin/main`, and contain exactly `@rig-c/create@X.Y.Z` in `package.json`.
It refuses an already published version. The publish job checks out that
validated SHA, packs the package, publishes it with `--provenance --access public`
over OIDC, then publishes `rig-create` with the same provenance flags. The alias
is packed using `scripts/alias_tarball.ts`, ported from Review: only the manifest's
name line changes, every other unpacked byte must match the exact scoped
tarball just published before alias publication,
and internal packs suppress lifecycle scripts. Both names must be served by
the registry for confirmation to pass.

After both jobs succeed and `npm view` serves both names at the version, create
the GitHub release for the tag:

```sh
gh release create vX.Y.Z --repo rig-c/create --verify-tag --title vX.Y.Z --generate-notes
```

This step stays outside `release.yml`, so the publishing job keeps only
`contents: read` and `id-token: write`.

If the tag push did not publish (for example, a registry or signing outage),
first check whether npm already serves either name at the version. If neither
is published, rerun the
same workflow on the existing tag:

```sh
gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z
```

If only the scoped name was published, the selector refuses to republish it.
Use the owner-directed manual fallback to publish only the missing alias, after
packing it from the reviewed scoped tarball and verifying byte equality with
`scripts/alias_tarball.ts compare`. Do not retry the scoped publication.

A dispatch on a branch is refused. Do not move the cut tag or dispatch on main:
npm provenance records the run's `GITHUB_SHA`. A failed registry confirmation
does not undo a publication; inspect npm before attempting recovery.

## Manual fallback

Use manual publication when trusted publishing is unavailable and tag-based
workflow recovery cannot complete, after the owner explicitly chooses the
fallback and confirms the version is still unpublished. Reuse the reviewed
candidate identity and repeat packing and consumer validation if its bytes
changed. Manual publication does not prove the workflow's OIDC/provenance path;
that proof is the next real workflow cut, not a test release.

The owner authenticates to npm interactively, confirms the intended account
and scope access, and publishes the reviewed tarball from an interactive
terminal:

```sh
npm login
npm whoami
npm publish <reviewed-tarball-path> --access public
```

Complete npm's interactive 2FA/browser prompt. If authentication cannot finish,
stop and resolve it interactively; do not add `--otp`, embed credentials or
add stored npm credentials to the workflow. If the candidate bytes change,
repeat packing and consumer validation before publishing.

After publication, verify the registry version and integrity against the
reviewed tarball. In a new empty directory, run the README's published-version
install and CLI quickstart. Record the registry, tag and GitHub release URLs,
commit, tarball hash, checks and any unverified boundary in the release issue.
