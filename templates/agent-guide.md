# Agent guide

One painting; one rig and its takes.

## Start here

1. Read `project.json`. Verdicts go through Review; relay interview picks/signoffs with owner words via `--owner-chat --said-at --relayed-by`. Never invent human words.
2. Run `rig-create next` for next moves and owners.
3. Resume: {{RESUME_LINK}}.

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
  Draft, propose, build and measure anytime; production rigging waits for `rigging-interview` ({{STAGES_LINK}}).
- Never infer answers from images. Per ask, offer one reasoned recommendation,
  Other and auto. Retain the shown set; never preselect.
- Record "auto" as delegated with your decision; never leave it blank.
- {{INTERVIEW_CHECK}}

## The user's four steps

1. **Parts and meshes**. Ask framing/source; review a labelled draft's parts and mesh/chest structure. `parts-review` records its Review API response.
   The latest receipt must approve the draft for `structure-snapshot --draft <id>`
   and `signoff parts-review --draft <id> --structure-file <f>`; record component triage with `diff-classes --diff-report <p> --by agent` ({{DRAFTS_LINK}}).
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
refusing {{PARTS_CHECK_LINK}}.
In `parts`, record an `intake-report` preflight and offer its choice, both advisory:
{{INTAKE_LINK}}.

Keep drafts in `derived/drafts/<id>/`, outside versions/handoff.
An owner-accepted retouch enters through parts' `assemble.edited_parts` block and is recorded by `draft-rig` ({{RETOUCH_HANDOFF_LINK}}).
Preserve history/dates; adopt choices explicitly.

**Live Review loop**

Run the first `job open <dir> --reviewer <id> --role owner` in the background.
Add the first selector if ready. Share the private URL once. Publish via bound writers or repeat with the same
reviewer/role and `--draft`, `--rig`, `--question` or `--plan`. Reused opens exit. The page updates in place.
After publishing an ask, run `rig-create job acts --wait` in the background. Ingest with its
printed command, advance as needed and publish again.
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
  with source/date; require a pick. Legacy: {{DERIVED_LINK}}.
- **Bars before sign-off.** Each reading names a command verified against
  installed `--help`; a missing command means STOP before sign-off.
  Loop bars: INTERVIEW.md, "Bars have reading commands".

See: [Before you ask, plan or show](AGENT-REFERENCE.md).

## Where things go

Folder lifetimes and git status: {{LIFETIME_LINK}}.

## What to read, and why

{{READ_FIRST}}

Use installed docs at `package.json`'s pins, not memory.
Run refusal `(see … guide …)` commands first.

{{PACKAGE_DOCS}}

Project docs:

{{CREATE_DOCS}}
