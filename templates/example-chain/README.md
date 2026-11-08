# Synthetic bound chain

The geometric painting and parts come from generateExampleParts. The labelled draft and production model come from generateExampleMeshDraft on those exact parts, with a producer-made torso mesh.

The setup still is the assembly recomposite, retained as synthetic setup evidence. The example demonstrates record binding. Rendered motion and camera behaviour require separate producer validation.

The public create CLI writes stage moves, signoffs, rig/post review verdicts, the review package, immutable input inventory, the sealed scene and authored direction. The direction is direction@2, bound to that scene. The parts verdict is a synthetic review-tool export from tests/parts-package.ts, recorded as a producer step.

Two seed kinds cover plan.steps (setup and status progress) with split.parts, and the rig version declaration. Source inventory is registered by input add. Each seed declares its consuming command and records that command’s step index in chain.json.

checkpoints/ contains frozen prefix projects and adjacent pending-act declarations. Stage 1 precedes the synthetic review-tool parts verdict export. Stage 2 precedes the first rigging answer and still needs later option sets to be agent-drafted in declared steps before registration by public writers. Pending answers use the SHA-256 of the file drafted during the walk. Stage 3 precedes rig review. Stage 4 precedes the background plate registration, the scene write, the declared agent-authored direction@2 input and the direction write. Pending stage moves use advance with the existing authorizing signoffs. Every file authored or copied for a later writer has a declared producer step with output hashes. The chain_step indices are zero-based. Stage 2 has four expected INTERVIEW_INCOMPLETE findings for its unanswered rigging guides. Every prefix has zero warnings and records its stage moves in advances[]. tests/example-chain.test.ts checks these states.

Reproduce with `bun scripts/generate-example-chain.ts <fresh-dir> --check` from the create repository.
