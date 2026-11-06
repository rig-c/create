# Synthetic bound chain

The geometric painting and parts come from generateExampleParts. The labelled draft and production model come from generateExampleDraft on those exact parts.

The setup still is the assembly recomposite, retained as synthetic setup evidence. The example demonstrates record binding. Rendered motion and camera behaviour require separate producer validation.

The public create CLI writes signoffs, rig/post review verdicts, the review package and authored direction. The parts verdict is a synthetic review-tool export from tests/parts-package.ts, recorded as a producer step.

Four seed kinds cover forward stages, plan.steps (setup and status progress) with split.parts, the rig version declaration and source inventory. Each seed declares its consuming command and records that command’s step index in chain.json.

Reproduce with `bun scripts/generate-example-chain.ts <fresh-dir> --check` from the create repository.
