# Composed direction rehearsal

The generator builds a synthetic rig, records a real Review approval with a Parts-generated setup PNG, and writes a four-second repeating `rig-create/direction@3` take. It publishes post v2 after the stored and effective stages reach `direction-review`. The fresh publication has one direction verdict request. The stage signature is requested after the owner accepts that verdict.

## Check the authored inputs

From the Create repository root, install the pinned dependencies and check the input inventory.

```sh
bun install --frozen-lockfile
bun scripts/generate-composed-direction-fixture.ts --check
```

The input seal covers every path and raw byte under `inputs/`. It checks for changed, missing and extra files without starting Review or running a producer. `--write-inputs` regenerates those files from the scripted synthetic art and authored declarations.

The input tree contains the painting, six source layers and their catalogue, Parts assembly and rig settings, requirements, two scene plates, the scene, the retained choice's authored composition value, the direction intent, and three approval texts. `direction-intent.json` declares the rig version, take and citation guides. The generator binds actual producer hashes and recorded owner answers immediately before `direction write`. Project records, acceptance evidence, producer reports and Review publications are generated in the disposable project.

## Generate a disposable project

Use a fresh output directory outside the repository. The last three lines report the canonical project path, the manifest path and its SHA-256.

```sh
scratch=$(mktemp -d)
project="$scratch/project"
bun scripts/generate-composed-direction-fixture.ts "$project"
bun src/cli.ts interview --check "$project" --json
```

Each run records new Review IDs and timestamps. With the pinned Parts 2.53.0, the sealed compose check report includes an absolute output path. The relative-path fix is tracked for Parts 2.53.1. These runtime differences are outside the input seal. [Parts #1492](https://github.com/rig-c/parts/issues/1492).

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

- **Turn Pad.** An authored `body_turn` slider compiled and produced an eligible dial from −12° to +12° before composition. Parts 2.53.0 composed it as `actor:body_turn` on `actor:body_yaw_dial`. The eligibility functions in pinned Review 4.17.1 and rehearsal revision `6501f21` both returned zero dials for that model. The rehearsal revision's session validator uses `TURN_UNAVAILABLE` for turn feedback without an eligible dial.
- **Frame-indexed pins.** Parts compose refused `scene.fps` with `SCENE_KEY_KNOWN`. An independent Core 3.8.1 build with authored `skeleton.fps: 24` emitted the rate in Spine `skeleton.json`. Its `skeleton.model.json` carried no rate. Compose produced a 12 fps check render sidecar. The current composed post publication exposes neither a report clock nor a frames binding. Review `6501f21` exposes time-only marks when there is no explicit producer frame and uses `COMMENT_FRAME_UNAVAILABLE` for an unavailable producer frame. These Review outcomes come from the source and package inspection.
