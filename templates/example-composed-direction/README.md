# Composed direction inputs

Sealed synthetic inputs for a four-second repeating composed post (`spine-parts-scene/1` with an authored `body_turn` slider clip).

## Check the authored inputs

From the Create repository root, install the pinned dependencies and check the input inventory.

```sh
bun install --frozen-lockfile
bun scripts/generate-composed-direction-fixture.ts --check
```

The input seal covers every path and raw byte under `inputs/`. It checks for changed, missing and extra files without starting Review or running a producer. `--write-inputs` regenerates those files from the scripted synthetic art and authored declarations.

The input tree contains the painting, six source layers and their catalogue, Parts assembly and rig settings, the authored `body_turn` clip, requirements, two scene plates, the scene, the retained choice's authored composition value, the direction intent, and three approval texts.

## Current limits

- **Turn Pad.** The authored `body_turn` slider maps a −12° to +12° dial to a three-second clip. Parts 2.53.0 preserves the slider as `actor:body_turn` on `actor:body_yaw_dial`. Review 4.22.0 and later read the `<id>:` compose namespace and finds the dial on the composed model ([Review #1134](https://github.com/rig-c/review/issues/1134)). Earlier Review versions returned zero dials and `TURN_UNAVAILABLE` here.
- **Frame-indexed pins.** The pinned Parts compose rejects `scene.fps` with `SCENE_KEY_KNOWN`. Its 12 fps check render sidecar is already available on disk. The current composed post publication carries no hash-bound frame clock, so Review supports time-only marks and reports `COMMENT_FRAME_UNAVAILABLE` for an unavailable producer frame. Parts #1494 closed as not planned because the remaining work belongs to the consuming publication path. [Parts #1494](https://github.com/rig-c/parts/issues/1494) · [Create #895](https://github.com/rig-c/create/issues/895).
