# Synthetic signed fixture

Every pixel is generated. The fixture sign-offs are synthetic.
The draft build is untouched output of the
installed `@rig-c/parts` 2.62.0 `rig` command from this fixture's own generated
config and producer-assembled parts. The compiled files under `out/check/build/`
are untouched output of installed `@rig-c/core` 3.11.0 `rigc build`, using the
same packed compiler step as `rig-parts check`. The single motion track is a minimal
synthetic declaration. An empty track set fails rigc's duration check.

`scripts/generate-example-draft.ts` builds the config and draft outputs and
also accepts `<fresh-directory> --check` to reproduce their exact bytes.
The signed numbered project and its retained bytes are under
`templates/example-numbered/`. Verify them with
`bun scripts/check-example-numbered.ts <fresh-directory> --check`.

The frozen fixture's events were generated one second apart from the latest
exported `*_SINCE` contract date at the time, with simultaneous events kept
together. `scripts/example-time.ts` defined that timeline without reading the clock.
