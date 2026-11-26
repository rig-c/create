# Composed direction rehearsal

The generator builds a synthetic rig, records a real Review approval with a Parts-generated setup PNG, and writes a four-second repeating `rig-create/direction@3` take. It publishes post v2 after the stored and effective stages reach `direction-review`. The fresh publication has one direction verdict request. The stage signature is requested after the owner accepts that verdict.

## Check the authored inputs

From the Create repository root, install the pinned dependencies and check the input inventory.

```sh
bun install --frozen-lockfile
bun scripts/generate-composed-direction-fixture.ts --check
```

The input seal covers every path and raw byte under `inputs/`. It checks for changed, missing and extra files without starting Review or running a producer. `--write-inputs` regenerates those files from the scripted synthetic art and authored declarations.

The input tree contains the painting, six source layers and their catalogue, Parts assembly and rig settings, the authored `body_turn` clip, requirements, two scene plates, the scene, the retained choice's authored composition value, the direction intent, and three approval texts. `direction-intent.json` declares the rig version, take and citation guides. The generator binds actual producer hashes and recorded owner answers immediately before `direction write`. Project records, acceptance evidence, producer reports and Review publications are generated in the disposable project.

## Generate a disposable project

Use a fresh output directory outside the repository. The last three lines report the canonical project path, the manifest path and its SHA-256.

```sh
scratch=$(mktemp -d)
project="$scratch/project"
bun scripts/generate-composed-direction-fixture.ts "$project"
bun src/cli.ts interview --check "$project" --json
```

Each run records new Review IDs and timestamps. These runtime differences are outside the input seal. Parts 2.53.0 wrote an absolute output path into the sealed compose check report; the pinned Parts 2.60.0 writes it location-independent ([Parts #1492](https://github.com/rig-c/parts/issues/1492)).

Keep the generated project layout, including `derived/drafts/composed/`. Copying the entire project with its paths intact works. Flattening the draft into the project root puts `config.json` and `out/` where Review discovers them as a producer handoff. In that layout, `out/` lacks the handoff's expected `parts.json` and `rig/`. The retained snapshot omits the unbound directory, so its reviewed-source identity differs from the live one. Review refuses with `JOB_SOURCE_UNRETAINABLE`, which Create reports under `JOB_PUBLISH_PENDING`. Leaving the draft nested lets post v2 publish through its recorded closure.

## Rehearse the owner acts

The generator verifies the fresh verdict request and closes its temporary Review host. Reopen the post job in the background and give its URL to the owner. Use the same reviewer ID for the plan publication.

```sh
bun src/cli.ts job open "$project" --rig 2 --reviewer "$reviewer" --role owner &
```

After the owner submits an accepted direction verdict, read its act ID and ingest it. Then open the plan to request the signature.

```sh
bun src/cli.ts job acts "$project" --json
bun src/cli.ts review 2 "$project" --from-review "$verdict_act_id"
bun src/cli.ts job open "$project" --plan --reviewer "$reviewer" --role owner
```

After the owner signs, read and ingest the signoff act.

```sh
bun src/cli.ts job acts "$project" --json
bun src/cli.ts signoff direction-review "$project" --from-review "$signoff_act_id"
bun src/cli.ts advance accepted "$project"
bun src/cli.ts job close "$project"
```

See [Live Review](../../docs/LIVE-REVIEW.md#job-commands) for act order and job behavior.

## Current limits

- **Turn Pad.** The authored `body_turn` slider maps a −12° to +12° dial to a three-second clip. Parts 2.53.0 preserves the slider as `actor:body_turn` on `actor:body_yaw_dial`. Pinned Review 4.22.0 reads the `<id>:` compose namespace and finds the dial on the composed model ([Review #1134](https://github.com/rig-c/review/issues/1134)). Earlier Review versions returned zero dials and `TURN_UNAVAILABLE` here.
- **Frame-indexed pins.** The pinned Parts compose rejects `scene.fps` with `SCENE_KEY_KNOWN`. Its 12 fps check render sidecar is already available on disk. The current composed post publication carries no hash-bound frame clock, so Review supports time-only marks and reports `COMMENT_FRAME_UNAVAILABLE` for an unavailable producer frame. Parts #1494 closed as not planned because the remaining work belongs to the consuming publication path. [Parts #1494](https://github.com/rig-c/parts/issues/1494) · [Create #895](https://github.com/rig-c/create/issues/895).
