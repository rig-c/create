# Clipped composed direction inputs

Sealed synthetic inputs for the same 128×128 figure on a narrower frame-bleeding canvas. It shares `scripts/generate-composed-direction-fixture.ts` with [`templates/example-composed-direction`](../example-composed-direction/README.md) through the `--clip` flag, changing three authored scene values:

- `canvas`: `96×128` (instead of `128×128`);
- `character.offset`: `[-16, 0]` (instead of `[0, 0]`);
- `characters[0].canvas_clip`: `true`.

The pinned Parts 2.63.1 `compose` reports shift `[0, 0]` and placement `{ canvas_clip: true, bounds: [-16, 0, 112, 128], clipped_bounds: [0, 0, 96, 128] }`. Without `canvas_clip: true`, the same scene is refused by Parts with `SCENE_CHARACTER_INSIDE_CANVAS`.

## Check the authored inputs

From the Create repository root, install the pinned dependencies and check the clipped input inventory.

```sh
bun install --frozen-lockfile
bun scripts/generate-composed-direction-fixture.ts --clip --check
```

The input seal covers every path and raw byte under `inputs/`. It checks for changed, missing and extra files without starting Review or running a producer. `--clip --write-inputs` regenerates those files from the scripted synthetic art and authored declarations.
