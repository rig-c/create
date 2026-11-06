# Synthetic bound chain

The geometric painting and parts come from generateExampleParts. The labelled draft and production model come from generateExampleMeshDraft on those exact parts, with a producer-made torso mesh.

The setup still is the assembly recomposite, retained as synthetic setup evidence. The example demonstrates record binding. Rendered motion and camera behaviour require separate producer validation.

The public create CLI writes signoffs, rig/post review verdicts, the review package and authored direction. The parts verdict is a synthetic review-tool export from tests/parts-package.ts, recorded as a producer step.

Four seed kinds cover forward stages, plan.steps (setup and status progress) with split.parts, the rig version declaration and source inventory. Each seed declares its consuming command and records that command’s step index in chain.json.

checkpoints/ contains frozen prefix projects and adjacent pending-act declarations. Stage 1 precedes the synthetic review-tool parts verdict export. Stage 2 precedes the first rigging answer and still needs later option sets to be agent-drafted in declared steps before registration by public writers. Pending answers use the SHA-256 of the file drafted during the walk. Stage 3 precedes rig review. Stage 4 precedes the declared agent-authored direction input and direction write. In-window stage seeds remain explicit pending steps. Every file authored or copied for a later writer has a declared producer step with output hashes. The chain_step indices are zero-based. Stage 2 has four expected INTERVIEW_INCOMPLETE findings for its unanswered rigging guides. The other three prefixes have no findings. tests/example-chain.test.ts checks these states.

Reproduce with `bun scripts/generate-example-chain.ts <fresh-dir> --check` from the create repository.
