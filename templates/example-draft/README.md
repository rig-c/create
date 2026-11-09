# Synthetic signed fixture

Every pixel is generated. These fixture sign-offs and the sibling reopened
variant's synthetic fixture reopen do not represent a person's approval.
The draft build is untouched output of the
installed `@rig-c/parts` 2.35.0 `rig` command from this fixture's own generated
config and producer-assembled parts. The compiled files under `out/check/build/`
are untouched output of installed `@rig-c/core` 3.6.0 `rigc build`, using the
same packed compiler step as `rig-parts check`. The single motion track is a minimal
synthetic declaration. An empty track set fails rigc's duration check.

Regenerate with `bun scripts/generate-example-order.ts <fresh-directory>`.
`scripts/generate-example-draft.ts` builds the config and draft outputs and
also accepts `<fresh-directory> --check` to reproduce their exact bytes.
Regenerate the dependent choices, split captions and invariants afterward.

The fixture events are ordered one second apart from the latest exported
`*_SINCE` contract date in `src/`, with simultaneous events kept together.
`scripts/example-time.ts` fixes this timeline without reading the clock.

The record-only variant is `../example-reopened/project.json`. It reopens
`parts-review` through the public writer as the same fixture signer, `user`.
Tests open either record through `fixture(() => {}, template)`, choosing
`example-project.json` or `example-reopened/project.json` as the template.
Both use the same retained asset materializer. No separate consumer open CLI
is provided. Regenerate only the variant with
`bun scripts/generate-example-reopened.ts <fresh-directory>` and append
`--check` to compare it with the shipped writer output.
