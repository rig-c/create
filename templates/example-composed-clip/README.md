# Clipped composed direction rehearsal

The generator builds the same synthetic 128×128 figure, records a real Review approval with a Parts-generated setup PNG, and writes a four-second repeating `rig-create/direction@3` take on a narrower frame-bleeding canvas. It shares `scripts/generate-composed-direction-fixture.ts` with [`templates/example-composed-direction`](../example-composed-direction/README.md) through the `--clip` flag, changing three authored scene values:

- `canvas`: `96×128` (instead of `128×128`);
- `character.offset`: `[-16, 0]` (instead of `[0, 0]`);
- `characters[0].canvas_clip`: `true`.

The pinned Parts 2.55.0 `compose` reports shift `[0, 0]` and placement `{ canvas_clip: true, bounds: [-16, 0, 112, 128], clipped_bounds: [0, 0, 96, 128] }`. Without `canvas_clip: true`, the same scene is refused by Parts with `SCENE_CHARACTER_INSIDE_CANVAS`. Create records `compose.clipped_bounds` `[0, 0, 96, 128]` on `evidence/direction/v2.json` and publishes post v2 at `direction-review` with one pending direction verdict request.

## Check the authored inputs

From the Create repository root, install the pinned dependencies and check the clipped input inventory.

```sh
bun install --frozen-lockfile
bun scripts/generate-composed-direction-fixture.ts --clip --check
```

The input seal covers every path and raw byte under `inputs/`. It checks for changed, missing and extra files without starting Review or running a producer. `--clip --write-inputs` regenerates those files from the scripted synthetic art and authored declarations.

## Generate a disposable project

Use a fresh output directory outside the repository. The last three lines report the canonical project path, the manifest path and its SHA-256.

```sh
scratch=$(mktemp -d)
project="$scratch/project"
bun scripts/generate-composed-direction-fixture.ts --clip "$project"
bun src/cli.ts interview --check "$project" --json
```

See [`templates/example-composed-direction/README.md`](../example-composed-direction/README.md) for the generated project layout and owner act rehearsal commands.
