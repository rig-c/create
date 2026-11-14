# Agent guide

One painting; one rig and its takes.

## Start here

1. Read `project.json`. Human acts go through Review; ingest exports. Never type human answers/signatures.
2. Run `rig-create next` to derive the next moves and whose they are.
3. Resume per [Resume](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#how-an-agent-resumes-a-project).

After an accepted post is bounced, reopen direction-review through Review: `job open --plan`, then `job acts --json`, ingest `reopen direction-review --from-review <actId>`, and `job close`. The exported act supplies the reviewer, date and verbatim words.

Stale pins: `rig-create packages upgrade --by <operator>`.

Declare the painting: `init --painting <file> --origin <words>` or
`input add <path> --painting --origin <words>`. `project.json.painting` binds
one input, survives restart and checks sibling artwork; optional on older records.

## The order, and what you may not do

`interview` → `plan-approved` → `parts` → `parts-review` (the parts, by eye) →
`rigging-interview` → `rigging` → `rig-review` (the rig, still frame) → `post-interview` → `post` →
`direction-review` → `accepted`. Any stage can become `paused`.

- Only human `signoffs[]` advance `stage` or pass plan checkpoints.
  Draft, propose, build and measure in any stage; production rigging waits for `rigging-interview` ([Stages](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#stages)).
- Never infer answers from images. Offer a pick per ask: one reasoned
  recommendation, Other and auto. Retain the shown set; never preselect.
- Record "auto" as delegated with your decision on the item; never leave it blank.
- Run `rig-create interview --check` before interview sign-off: it names every `null` answer.

## The user's four steps

1. **Parts and meshes**. Ask framing/source; review a labelled draft's parts and mesh/chest structure. `parts-review` records its Review API response.
   The latest receipt must approve the draft for `structure-snapshot --draft <id> --out <f>`
   and `signoff parts-review --draft <id> --structure-file <f>`; record component triage with `diff-classes --diff-report <p> --by agent` ([Draft rigs](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#labelled-draft-rigs-and-structure-decisions)).
2. **Rigging interview**. Ask fresh bones, deformation, physics and motion
   against approved parts/structure; use interview-options/answer/decision.
3. **Rig and animation**. Keep rig feedback.
   Ingest: `review <version> --from-review <actId>`.
4. **Direction**. `job open --rig <post>` asks the verdict only.
   Ingest `review <post> --from-review <actId>`, then `job open --plan` for
   record-page sign-off (source-linked Review).

Ask: `job open --reviewer <id> --role owner --question <id>` or `--plan`;
ingest `--from-review <actId>`, then advance.
Keep the host up across bound writes; after a stop, `job open` with reviewer/role,
then `job reconcile` before writing.

Use `advance <stage>` and `step-status <id>` (`rig-create --help`).
`advance parts-review` needs `--parts-check <report> --parts <assembled dir>`,
refusing [`PARTS_CHECK_MISSING`, `PARTS_CHECK_UNREAD`, `PARTS_CHECK_INVALID`, `PARTS_CHECK_CHANGED`, `PARTS_CHECK_FAILED`, `PARTS_CHECK_STALE`](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#parts-stage-check-at-the-parts--parts-review-move).
In `parts`, record an `intake-report` preflight and offer its choice, both advisory:
[PROJECT.md § Advisory intake reports](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#advisory-intake-reports).

Keep drafts in `derived/drafts/<id>/`, outside versions/handoff.
Preserve history/dates; adopt choices explicitly.

## Before you ask, plan or show

- **Prior words.** In adopted projects, show them verbatim as a tailored option
  with source/date; require a pick. Legacy derivation: [INTERVIEW.md § Derived answers](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md#derived-answers).
- **Bars before sign-off.** Each reading names its command, checked against
  installed `--help`. A reading with no command is a STOP before sign-off.
  Loop bars: INTERVIEW.md, "Bars have reading commands".

Stage reference: [Before you ask, plan or show](AGENT-REFERENCE.md).

## Where things go

Each folder's lifetime and git status: [PROJECT.md § Data is split by lifetime](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#data-is-split-by-lifetime).

## What to read, and why

1. **Before the interview**: INTERVIEW.md; CRAFT.md (waypoint defaults);
   parts AUTHORING §3, *`config.json`, field by field*;
   [CHECKS.md](https://github.com/rig-c/create/blob/main/docs/CHECKS.md) before a sign-off.
2. **Before `seethrough` and `assemble`**: SOURCE.md, split/cut order:
   [bad-split reruns](https://github.com/rig-c/create/blob/main/docs/SOURCE.md#re-run-first),
   [allowed cuts](https://github.com/rig-c/create/blob/main/docs/SOURCE.md#where-a-cut-is-allowed);
   parts AUTHORING *See-through head-run source reading*, *Source before
   scissors* and *Limbs: cut at their joints*.
3. **Before rigging**: [CRAFT.md § For the gates](https://github.com/rig-c/create/blob/main/docs/CRAFT.md#for-the-gates-not-the-interview)
   (G1–G9); core RIGGING and MOTION; parts AUTHORING §7, the bars `check` enforces.
4. **Before showing the user**: [LESSONS.md § The self-check](https://github.com/rig-c/create/blob/main/docs/LESSONS.md#the-self-check),
   the [per-frame seam count](https://github.com/rig-c/create/blob/main/docs/LESSONS.md#count-the-seam-bar-over-every-frame),
   [what to show first](https://github.com/rig-c/create/blob/main/docs/LESSONS.md#what-to-show-the-user-first).

Use installed docs at `package.json`'s pins, not memory.
Run refusal `(see … guide …)` commands first.

- [@rig-c/parts README.md](node_modules/@rig-c/parts/README.md): painting-to-rig pipeline and command order.
- [@rig-c/parts docs/AUTHORING.md](node_modules/@rig-c/parts/docs/AUTHORING.md): config fields, interview waypoints and refusal remedies.
- [@rig-c/parts docs/PAINTING.md](node_modules/@rig-c/parts/docs/PAINTING.md): what makes a painting riggable, and the check to run on it before See-through.
- [@rig-c/parts docs/DEPTH.md](node_modules/@rig-c/parts/docs/DEPTH.md): depth reference; unavailable in current direction.
- [@rig-c/parts docs/STABILITY.md](node_modules/@rig-c/parts/docs/STABILITY.md): stable commands, fields and outputs.
- [@rig-c/parts docs/MIGRATION.md](node_modules/@rig-c/parts/docs/MIGRATION.md): only when the pinned version is bumped.
- [@rig-c/core README.md](node_modules/@rig-c/core/README.md): rigc scope, commands and documentation.
- [@rig-c/core docs/AUTHORING.md](node_modules/@rig-c/core/docs/AUTHORING.md): rig/motion formats, build loop and failure remedies.
- [@rig-c/core docs/RIGGING.md](node_modules/@rig-c/core/docs/RIGGING.md): bones and pivots at the bones waypoint.
- [@rig-c/core docs/MOTION.md](node_modules/@rig-c/core/docs/MOTION.md): key-pose motions at the motion waypoint.
- [@rig-c/core docs/FACE.md](node_modules/@rig-c/core/docs/FACE.md): blink and gaze in the accepted rig.
- [@rig-c/core docs/INGEST.md](node_modules/@rig-c/core/docs/INGEST.md): only when you were handed a skeleton this project did not author.

Project docs (not installed):

- [docs/PROJECT.md](https://github.com/rig-c/create/blob/main/docs/PROJECT.md): the folder, stages and sign-offs, the plan, versions, and `project.json` field by field.
- [docs/INTERVIEW.md](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md): how to ask, and the shape every answer, delegation and piece of feedback takes.
- [docs/CRAFT.md](https://github.com/rig-c/create/blob/main/docs/CRAFT.md): the default to propose at each waypoint.
- [docs/COLLECTIONS.md](https://github.com/rig-c/create/blob/main/docs/COLLECTIONS.md): when this project is a member of a collection.
