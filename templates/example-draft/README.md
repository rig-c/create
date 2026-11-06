# Synthetic signed fixture

Every pixel is generated. These sign-offs are fixture sign-offs, and do not
represent a person's approval. The draft build is untouched output of the
installed `@rig-c/parts` 2.16.0 `rig` command from this fixture's own generated
config and producer-assembled parts. The compiled files under `out/check/build/`
are untouched output of installed `@rig-c/core` 3.2.1 `rigc build`, using the
same packed compiler step as `rig-parts check`. The single motion track is a minimal
synthetic declaration. An empty track set fails rigc's duration check.

Regenerate with `bun scripts/generate-example-order.ts <fresh-directory>`.
`scripts/generate-example-draft.ts` builds the config and draft outputs and
also accepts `<fresh-directory> --check` to reproduce their exact bytes.
Regenerate the dependent choices, split captions and invariants afterward.
