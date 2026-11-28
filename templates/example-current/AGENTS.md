# Agent guide

One painting; one rig and its takes.

## Start here

1. Read `project.json`. Comments go through Review; relay interview picks/signoffs with owner words via `--owner-chat --said-at --relayed-by`. Never invent human words.
2. Run `rig-create next` for next moves and owners.
3. Resume: [Resume](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#how-an-agent-resumes-a-project).

After an accepted post is bounced, record the owner's correction with `amend direction-review`.

Stale pins: `packages upgrade --by <operator>`.

Declare the painting: `init --painting <file> --origin <words>` or
`input add <path> --painting --origin <words>`. `project.json.painting` binds
one input, survives restart and checks sibling artwork; optional on older records.

## The order, and what you may not do

`interview` → `plan-approved` → `parts` → `parts-review` (parts, by eye) →
`rigging-interview` → `rigging` → `rig-review` (rig) → `post-interview` → `post` →
`direction-review` → `accepted`. Any stage can become `paused`.

- Only human `signoffs[]` advance `stage` or pass plan checkpoints.
  Draft, propose, build and measure anytime; production rigging waits for `rigging-interview` ([Stages](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#stages)).
- Never infer answers from images. Per ask, offer one reasoned recommendation,
  Other and auto. Retain the shown set; never preselect.
- Record "auto" as delegated with your decision; never leave it blank.
- Run `rig-create interview --check` before interview sign-off: it names every `null` answer.

## The user's four steps

Per step, `plan propose` a page of plain sentences in `owner.language`: summary; what and why by area; left out; 2–3 direction questions. `plan feedback` logs replies; no gate.

1. **Parts and meshes**. Assemble and check parts, record `record parts --from <dir> --config <c>`, run `structure-snapshot`, and relay any owner `signoff parts-review` via `--owner-chat`; record component triage with `diff-classes --diff-report <p> --by agent` ([Draft rigs](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#labelled-draft-rigs-and-structure-decisions)).
2. **Rigging interview**. Plan bones, deformation, physics, motion on approved parts/structure.
3. **Rig and animation**. Build, check and record `record rig --from <dir> --config <c>`; relay any owner `signoff rig-review` via `--owner-chat`.
4. **Direction**. Copy owner `value.compose` into Parts' scene; render motion (`record motion --from <dir>`), write `scene write --compose-scene <file>` and `direction write --file <json>`, compose to green, and record `record direction --from <dir> --direction specs/direction/direction.json`. Relay `signoff direction-review` via `--owner-chat`, then `advance accepted`.

Use `advance <stage>`, `step-status <id>`.
`advance parts-review` needs `--parts-check <report> --parts <assembled dir>`,
refusing [`PARTS_CHECK_MISSING`, `PARTS_CHECK_UNREAD`, `PARTS_CHECK_INVALID`, `PARTS_CHECK_CHANGED`, `PARTS_CHECK_FAILED`, `PARTS_CHECK_STALE`](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#parts-stage-check-at-the-parts--parts-review-move).
In `parts`, record an `intake-report` preflight and offer its choice, both advisory: [PROJECT.md § Advisory intake reports](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#advisory-intake-reports).

Keep drafts in `derived/drafts/<id>/`, outside versions/handoff.
An owner-accepted retouch enters through parts' `assemble.edited_parts` block and is recorded by `record parts --from <dir> --config <file>` or `record rig --from <dir> --config <file>` ([SOURCE.md § Handing a retouch to an image editor](https://github.com/rig-c/create/blob/main/docs/SOURCE.md#handing-a-retouch-to-an-image-editor)).
Preserve history/dates; adopt choices explicitly.

**Live Review loop**

Start `job open <dir> --reviewer <id> --role owner` in the background; add a selector when ready.
Share the URL once. Publish via bound writers or reuse `--draft|--rig|--question|--plan`.
Reused opens exit. The page updates in place.
After publishing, run `job acts --wait` in the background to collect comments, relay picks/signoffs via `--owner-chat`, advance, republish.
`job acts [--json]` lists each pending act's comments and `words`, even when ingest is unavailable.
Comment acts (`act@10`, no verdict): `comment --from-review <actId>` records `comments[i]`, bound by content hash.
Plan-picture pin `["rig-review-comment/1", mode, "reference", referenceId, referenceHash, x, y, w, h]` (integer pixels, Y down, `w=h=0` for a point): match `referenceHash` to `referenceId`'s `sha256` in publication `files`, crop `x,y,w,h`.
With all picks recorded, complete the plan, follow `next` for `signoff <stage> --from-picks` or `--owner-chat`.
Keep the job host up across bound writes; if it stopped, run `job open` again with the same reviewer/role and URL, then `job reconcile`.
Legacy package-only host: ingest pending acts, `job close` once, then ask a question/plan.

`job withdraw-act <actId>` (owner-chat flags) keeps the page; a close ends it; reopen shares a new URL.

- `job close` ends/retires the job after a pin/hook bump (`--retire-refused` archives failed publications); `job open`/`job reconcile` archive offline replaced-root jobs.
- `job close --discard-acts <reason> --by agent` (or `--by <owner>` with owner-chat flags) records the discard.

## Before you ask, plan or show

- **Owner language.** Write in `owner.language` (`init --owner-language <tag>` or `owner-language set <tag>`): `plan add|revise` `does`, `produces`, `bar`; `interview-options --file` `asks[].prompt`, options `label`, `effect`, `reason`; `checkpoint-evidence`/`checkpoint-table` labels, routes, recommendations, headings, text cells. Keep IDs, proper names, producer data and quoted words as supplied.
- **Prior words.** Offer adopted projects verbatim prior words as a tailored option
  with source/date; require a pick. Legacy: [INTERVIEW.md § Derived answers](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md#derived-answers).
- **Bars before sign-off.** Each reading names a command verified against installed `--help`; a missing command means STOP before sign-off.
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
