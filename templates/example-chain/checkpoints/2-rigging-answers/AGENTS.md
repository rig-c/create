# Agent guide

One painting; one rig and its takes.

## Start here

1. Read `project.json`. Verdicts go through Review; relay interview picks/signoffs with owner words via `--owner-chat --said-at --relayed-by`. Never invent human words.
2. Run `rig-create next` for next moves and owners.
3. Resume: [Resume](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#how-an-agent-resumes-a-project).

After an accepted post is bounced, record the owner's correction with `amend direction-review`.

Stale pins: `rig-create packages upgrade --by <operator>`.

Declare the painting: `init --painting <file> --origin <words>` or
`input add <path> --painting --origin <words>`. `project.json.painting` binds
one input, survives restart and checks sibling artwork; optional on older records.

## The order, and what you may not do

`interview` → `plan-approved` → `parts` → `parts-review` (the parts, by eye) →
`rigging-interview` → `rigging` → `rig-review` (the rig, still frame) → `post-interview` → `post` →
`direction-review` → `accepted`. Any stage can become `paused`.

- Only human `signoffs[]` advance `stage` or pass plan checkpoints.
  Draft, propose, build and measure anytime; production rigging waits for `rigging-interview` ([Stages](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#stages)).
- Never infer answers from images. Per ask, offer one reasoned recommendation,
  Other and auto. Retain the shown set; never preselect.
- Record "auto" as delegated with your decision; never leave it blank.
- Run `rig-create interview --check` before interview sign-off: it names every `null` answer.

## The user's four steps

1. **Parts and meshes**. Ask framing/source; review a labelled draft's parts and mesh/chest structure. `parts-review` records its Review API response.
   The latest receipt must approve the draft for `structure-snapshot --draft <id>`
   and `signoff parts-review --draft <id> --structure-file <f>`; record component triage with `diff-classes --diff-report <p> --by agent` ([Draft rigs](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#labelled-draft-rigs-and-structure-decisions)).
2. **Rigging interview**. Ask fresh bones, deformation, physics and motion
   against approved parts/structure; use interview-options/answer/decision.
3. **Rig and animation**. Keep rig feedback.
   Ingest: `review <version> --from-review <actId>`.
4. **Direction**. Copy owner `value.compose` into Parts' scene and compose to green.
   Record `direction@3`: `direction write <N> --file <json> --rig <R> --compose-out <dir>`
   (optional `--compose-scene <file>`). This route has no `scene write`.
   `job open --rig <post>` asks the verdict only.
   Ingest `review <post> --from-review <actId>`, then `job open --plan` for
   record-page sign-off (source-linked Review).

Use `advance <stage>` and `step-status <id>` (`rig-create --help`).
`advance parts-review` needs `--parts-check <report> --parts <assembled dir>`,
refusing [`PARTS_CHECK_MISSING`, `PARTS_CHECK_UNREAD`, `PARTS_CHECK_INVALID`, `PARTS_CHECK_CHANGED`, `PARTS_CHECK_FAILED`, `PARTS_CHECK_STALE`](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#parts-stage-check-at-the-parts--parts-review-move).
In `parts`, record an `intake-report` preflight and offer its choice, both advisory:
[PROJECT.md § Advisory intake reports](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#advisory-intake-reports).

Keep drafts in `derived/drafts/<id>/`, outside versions/handoff.
An owner-accepted retouch enters through parts' `assemble.edited_parts` block and is recorded by `draft-rig` ([SOURCE.md § Handing a retouch to an image editor](https://github.com/rig-c/create/blob/main/docs/SOURCE.md#handing-a-retouch-to-an-image-editor)).
Preserve history/dates; adopt choices explicitly.

**Live Review loop**

Run the first `job open <dir> --reviewer <id> --role owner` in the background.
Add the first selector if ready. Share the private URL once. Publish via bound writers or repeat with the same
reviewer/role and `--draft`, `--rig`, `--question` or `--plan`. Reused opens exit. The page updates in place.
Until #698, ask the owner to tell you after submitting. Run `job acts`, ingest
via `--from-review`, advance as needed and publish again.
With all owner picks ingested, complete the plan and follow `next` for
`signoff <stage> --from-picks`. Keep the plan sign-off page for other answers.
After a listener stop, reopen with the same reviewer/role, keep the URL, then `job reconcile`.
Until #700, ingest pending acts and close a package-only job before opening a question or plan.

Successful closes end the page. Share a new URL after reopening.

- `job close` ends the job or retires it after a pin/hook bump.
- `job close --retire-refused` archives failed publications.
- `job close --discard-acts <reason> --by agent` records the discard.
- `job close --discard-acts --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>` records the owner's discard.
- `job open` can archive an offline replaced-root job and open a new URL.
- `job reconcile` can archive an offline replaced-root job.

## Before you ask, plan or show

- **Owner language.** Use `owner.language` for the text you write. Set it from
  the owner's preference with `init --owner-language <tag>` or
  `owner-language set <tag>` before publishing.
  In `plan add|revise`, write `does`, `produces` and `bar` in that language.
  In `interview-options --file`, write the question wording (`asks[].prompt`)
  and options' `label`, `effect` and recommendation `reason` in it.
  For `checkpoint-evidence` and `checkpoint-table`, use it for tile/table
  labels, routes, recommendations and authored table headings and text cells.
  Keep question/step IDs, proper names, producer data and quoted owner words as supplied.
- **Prior words.** Offer adopted projects verbatim prior words as a tailored option
  with source/date; require a pick. Legacy: [INTERVIEW.md § Derived answers](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md#derived-answers).
- **Bars before sign-off.** Each reading names a command verified against
  installed `--help`; a missing command means STOP before sign-off.
  Loop bars: INTERVIEW.md, "Bars have reading commands".

See: [Before you ask, plan or show](AGENT-REFERENCE.md).

## Where things go

Folder lifetimes and git status: [PROJECT.md § Data is split by lifetime](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#data-is-split-by-lifetime).

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
- [@rig-c/parts docs/DEPTH.md](node_modules/@rig-c/parts/docs/DEPTH.md): depth-driven head turn before rigging; timed direction is separate.
- [@rig-c/parts docs/STABILITY.md](node_modules/@rig-c/parts/docs/STABILITY.md): stable commands, fields and outputs.
- [@rig-c/parts docs/MIGRATION.md](node_modules/@rig-c/parts/docs/MIGRATION.md): only when the pinned version is bumped.
- [@rig-c/core README.md](node_modules/@rig-c/core/README.md): rigc scope, commands and documentation.
- [@rig-c/core docs/AUTHORING.md](node_modules/@rig-c/core/docs/AUTHORING.md): rig/motion formats, build loop and failure remedies.
- [@rig-c/core docs/RIGGING.md](node_modules/@rig-c/core/docs/RIGGING.md): bones and pivots at the bones waypoint.
- [@rig-c/core docs/MOTION.md](node_modules/@rig-c/core/docs/MOTION.md): key-pose motions at the motion waypoint.
- [@rig-c/core docs/FACE.md](node_modules/@rig-c/core/docs/FACE.md): blink and gaze in the accepted rig.
- [@rig-c/core docs/INGEST.md](node_modules/@rig-c/core/docs/INGEST.md): only when you were handed a skeleton this project did not author.

Project docs:

- [docs/PROJECT.md](https://github.com/rig-c/create/blob/main/docs/PROJECT.md): project fields, stages, sign-offs, and rig registration with the build’s `bun.lock` or npm v3 lock.
- [docs/INTERVIEW.md](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md): how to ask, and the shape every answer, delegation and piece of feedback takes.
- [docs/CRAFT.md](https://github.com/rig-c/create/blob/main/docs/CRAFT.md): the default to propose at each waypoint.
- [docs/COLLECTIONS.md](https://github.com/rig-c/create/blob/main/docs/COLLECTIONS.md): when this project is a member of a collection.
