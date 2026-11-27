# Agent guide

One painting; one rig and its takes.

## Start here

1. Read `project.json`. Comments go through Review; relay interview picks/signoffs with owner words via `--owner-chat --said-at --relayed-by`. Never invent human words.
2. Run `rig-create next` for next moves and owners.
3. Resume: {{RESUME_LINK}}.

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
  Draft, propose, build and measure anytime; production rigging waits for `rigging-interview` ({{STAGES_LINK}}).
- Never infer answers from images. Per ask, offer one reasoned recommendation,
  Other and auto. Retain the shown set; never preselect.
- Record "auto" as delegated with your decision; never leave it blank.
- {{INTERVIEW_CHECK}}

## The user's four steps

Per step, `plan propose` a page of plain sentences in `owner.language`: summary; what and why by area; left out; 2–3 direction questions. `plan feedback` logs replies; no gate.

1. **Parts and meshes**. Assemble and check parts, record `record parts --from <dir> --config <c>`, run `structure-snapshot`, and relay any owner `signoff parts-review` via `--owner-chat`; record component triage with `diff-classes --diff-report <p> --by agent` ({{DRAFTS_LINK}}).
2. **Rigging interview**. Plan bones, deformation, physics, motion on approved parts/structure.
3. **Rig and animation**. Build, check and record `record rig --from <dir> --config <c>`; relay any owner `signoff rig-review` via `--owner-chat`.
4. **Direction**. Copy owner `value.compose` into Parts' scene; render motion (`record motion --from <dir>`), write `scene write --compose-scene <file>` and `direction write --file <json>`, compose to green, and record `record direction --from <dir> --direction specs/direction/direction.json`. Relay `signoff direction-review` via `--owner-chat`, then `advance accepted`.

Use `advance <stage>`, `step-status <id>`.
`advance parts-review` needs `--parts-check <report> --parts <assembled dir>`,
refusing {{PARTS_CHECK_LINK}}.
In `parts`, record an `intake-report` preflight and offer its choice, both advisory: {{INTAKE_LINK}}.

Keep drafts in `derived/drafts/<id>/`, outside versions/handoff.
An owner-accepted retouch enters through parts' `assemble.edited_parts` block and is recorded by `draft-rig` ({{RETOUCH_HANDOFF_LINK}}).
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
  with source/date; require a pick. Legacy: {{DERIVED_LINK}}.
- **Bars before sign-off.** Each reading names a command verified against installed `--help`; a missing command means STOP before sign-off.
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
