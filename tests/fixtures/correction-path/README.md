# Correction consumer fixtures

Regenerate with `bun scripts/generate-correction-fixture.ts <fresh directory>`;
verify with the same command plus `--check`. Consumer records are generated
through the public correction writers from retained synthetic bytes.

The positive applied-and-checked case is **synthetic shape-only**. Its session,
check summary and patch hash are synthetic contract data, not an export of a
measured producer run. No producer gate proof is claimed. Every existing file
is bound by the hash of its actual bytes. The preview is deliberately pretty
printed; its raw hash differs from the embedded review-format patch hash.

The parts fixture retains a tiny synthetic PNG. It is not rendered evidence.
