# Checking the interview

```
rig-create interview --check [<project dir>] [--json]
```

Reads `project.json` and reports **every** refusal it finds, each by name: a
stable code and the object it is about (a waypoint id, a plan step id, a
sign-off index, a parts section). Exit `0` when nothing is refused (warnings do
not fail it), `1` when anything is, `2` on a usage error. `--json` prints the
report as one object — `ok`, `stage`, `effective_stage`, `parts` (version and
where the sections were read from), `derived` (the waypoint and post item ids
derived from parts), `provenance[]` (per version checked: `version`, `kind`,
`config_path`, `config` — whether the config file was read, below — and the
`sections` checked), `feedback[]` (per human bounced verdict, § Polish
feedback), `refusals[]` and `warnings[]`, each `{ code, path, message }`
— for agents and later checks to read.

The contract it checks is [INTERVIEW.md](INTERVIEW.md) and
[PROJECT.md](PROJECT.md); this file only lists what fires and how to clear it.
It does not rig, draft or sign anything: every clearing action below is a
person's (an answer, a sign-off) or the agent's (a decision on a delegated item,
a plan step), written to `project.json`.

## What the check reads

- **The waypoints come from the pipeline.** The top-level sections of the
  installed `@rig-c/parts` config are read from the package in the project's
  `node_modules/` (or, failing that, from this repository's own pinned dev
  dependency), and placed through the table in `src/waypoints.ts` — the same
  table as [INTERVIEW.md § Waypoints](INTERVIEW.md#waypoints-where-the-guide-attaches).
  A section the table does not place is a refusal; a new parts section is a
  question before it is a line in the table. The list is parts' own export,
  `CONFIG_SECTIONS` in its `src/config.ts` (from 2.3.0; the loader's accept
  list), loaded from the install the check found, not from this repository's.
- **The stage order** is `src/stages.ts`, the one place it is written: which
  stages end on a sign-off (`interview`, `plan-approved`, `rig-review`,
  `post-interview`, `direction-review`) and which end when the last step of
  their phase meets its bar (`rigging`, `post`).
- **The parts verdict** a `parts-review` sign-off rests on is the file its
  `evidence.path` names, relative to the project, and nothing else. Its
  `source.files[]` paths are relative to the verdict file's own directory
  (POSIX), so a verdict kept outside the parts directory lists `../` paths.
  Every listed file is hashed again, and `source.sha256` is recomputed from the
  entries the way rig-review defines it; the field is never trusted. It is
  read from the latest `parts-review` sign-off once rigging has started, and
  only while the parts gate rigging: the stage is at most `rigging`, or no rig
  version has an accepted rig-review verdict yet. After acceptance a part
  change is a new rig version (`RIG_VERSION_UNACCEPTED`), and an accepted
  project on a fresh clone, whose `derived/` parts are not there, is not
  refused for them.
- **A collection member** (`<collection>/members/<name>/project.json`) has its
  `inherited` answers resolved against `<collection>/collection.json`. An
  inherited answer whose collection answer is `null` (or `"per-member"`) is
  silence, reported at the member's waypoint with the reason. Its `@rig-c/parts`
  is looked for in the member's folder, then in the collection's install.
- **A collection** (a folder with `collection.json` and no `project.json`, or
  the `collection.json` itself) is not a project: `interview --check` runs the
  collection check on it, the same as `collection --check` ([§ Collections](#collections)).

## Appearance bar wording

`STEP_APPEARANCE_REVIEW` is a **warning**, not a refusal, on
`plan.steps[<id>].bar`, including pending steps. It names the person's review:
`rig-review` for `phase: "rig"`, `direction-review` for `phase: "post"`. Move
the appearance item there in the plan and attach measured step readings as
context ([INTERVIEW.md](INTERVIEW.md#appearance-belongs-to-a-persons-review)).

The single exported phrase list, `APPEARANCE_IN_MOTION_PHRASES` in
`src/check.ts`, is: `perceived jiggle`, `perceived motion`, `looks right in the
loop`, `looks right in loop`, `looks natural in motion`, `natural motion`,
`smooth motion`, `visible at 1x`, `seen at 1x`. Matching ignores case and
collapses whitespace, with word boundaries; one warning is emitted per bar.

A numeric reading here means an Arabic number (signed/decimal allowed) followed
by `px`, `pixel(s)`, `mm`, `cm`, `m`, `deg`, `degree(s)`, `rad`, `radian(s)`,
`ms`, `s`, `second(s)`, `frame(s)`, `world unit(s)`, `unit(s)`, `%` or `°`,
or beside `<`, `>`, `<=`, `>=`, `=`, `≤` or `≥`. Inline backtick spans and
HTTP(S) URLs are excluded from this numeric search. `1x`, bare numbers,
numbered versions and command flags alone are not readings. Missing or
non-string bars and malformed steps are outside this wording lint.

This is deliberately a heuristic. A quoted or negated phrase can be a false
positive. A paraphrase, number written in words, unlisted unit or punctuation
inside a phrase can be missed; an unrelated numeric clause (including a time)
can suppress a warning. It does not associate each phrase with a reading or
validate a measurement command. Numeric text never replaces a person's
appearance verdict, and a clear lint does not authorize an appearance bar.

## Answer states, as the check reads them

| Written in the record | Read as | Passes |
| --- | --- | --- |
| `null` | silence | no — `INTERVIEW_INCOMPLETE` while the stage is still `interview` (post items: `post-interview`), `*_SILENT` once it has moved on |
| `{ "delegated": false, "verbatim", "value", … }` | user answer; `"value": "none"` is an answer | yes |
| `{ "delegated": true, … }` | delegation | yes; `agent_decision` must be present once the plan that uses it is signed (`DELEGATION_UNDECIDED`) |
| `{ "not_applicable": true, "because": "…" }` | not applicable | yes; without `because` it is `ANSWER_MALFORMED` |
| `{ "basis": "inherited", "from": { "collection", "question" } }` | the collection's answer, read as one of the rows above | as the collection's answer does; `INHERITED_UNRESOLVED` when it cannot be found |

A user guide carrying `agent_decision` marks a partial delegation. Its
`covers` must name the delegated remainder, and its decision must carry
`value` and nonempty `reasoning` before the approving plan is signed
(`DELEGATION_UNDECIDED`). A user sentence without `agent_decision` has no
machine-readable remainder. The check cannot infer missing coverage from
free text, so that case needs an explicit interview coverage contract.

## Decisions the docs left open

- **A `plan-approved` sign-off while the stage is later** is a re-sign, not a
  refusal: it approves the steps named in its `steps[]` (all steps when absent)
  as of its `at`. It is *required* when a guide a step rests on changed after
  the last sign-off covering that step (`GUIDE_CHANGED_UNSIGNED`): a changed
  guide sends the step back for a new signature before it runs. A sign-off for
  a stage *later* than the project's is refused (`SIGNOFF_AHEAD_OF_STAGE`).
- **An empty project at stage `interview`** (the template as `init` writes it)
  has moved nothing, so every `null` framing answer and waypoint guide is
  reported as `INTERVIEW_INCOMPLETE`, one per item, and the command exits `1`:
  the project is not clear to rig, and the list is the interview's to-do. It
  is a different code from `WAYPOINT_SILENT` because nothing was skipped —
  the interview has not been held yet.
- **`paused`** is checked as the first stage whose sign-off is missing
  (where it resumes), and needs its own `{ "stage": "paused" }` sign-off.
- **When every post item is not applicable**, `post` and `direction-review` are
  not required ([PROJECT.md § When post is not passed](PROJECT.md#stages)).
- **A project that predates `parts-review`** is read from the date of its
  first `plan-approved` sign-off, not from `stage_values` or a schema mark:
  `stage_values` is copied at `init`, so a project made before the change and
  still at `interview` would be exempted by it, and signing `plan-approved` is
  the dated, human act that moved a project past where the two stages stand.
  Only a project past `parts-review` is exempt; one at or before it goes
  through both. An undated sign-off does not exempt.
- **A step is "run"** when its `status` is `in-progress`, `at-checkpoint` or `done`; the
  approval and changed-guide checks apply from then. A checkpoint sign-off is
  required only once the step is `done`.

Signed steps are compared using `stepHash` from `src/step-hash.ts`, the
same hash the `signoff` command writes. Each step reads its latest covering
stage-level approval by date, breaking ties by array position. Rig steps use
`plan-approved` and post steps use `post-interview`. A subset re-sign applies
only to its `steps[]`. The check includes signed steps still `pending`.
Execution `status` is excluded from the hash. Re-signing clears a content
mismatch. A historical signature without the field warns per covered step,
while a present malformed or incomplete map refuses.

## Provenance

Every `versions[]` entry of kind `rig` or `post` is checked against
[INTERVIEW.md § Provenance](INTERVIEW.md#provenance-every-config-section-cites-its-guide):
each config section cites the guide sentence or the delegation it rests on.

- **Which sections the config has.** When `provenance.config.path` names a
  file under the project and its sha256 is `provenance.config.sha256`, the
  file's top-level keys are the sections, and a key provenance does not list
  is uncited. In a `rig` config, parts' records (`x-` and at least one more
  character, any JSON) and annotations (`note` or `<name>_note`, a string) are
  read by nothing and are not sections, so they need no citation; a
  provenance entry under one (other than `note`, which the placement table
  places `none`) is still `SECTION_UNKNOWN`. Otherwise — `derived/` is not
  kept, so this is the usual case — the sections `provenance.sections` lists are the ones checked, and the report
  says so: `provenance[].config` is `absent` (no file), `changed` (the file's
  hash is not the recorded one; also a `PROVENANCE_CONFIG_CHANGED` warning) or
  `unreadable` (not a JSON object, or a path outside the project), and the text
  report names those versions. No field is added to the record for this.
- **Which sections need a citation.** In a `rig` version the config is a
  `@rig-c/parts` config, and a section the placement table places `none`
  (`key`, `generation`, `proposed_rig_scale`, `requirements`, `motion_seams`,
  `note`) is not a direction call: it needs no citation, though an entry
  written under it is still checked. In a `post` version the config is the post
  tool's; its sections are not parts sections and are not on the table, so
  every one is a direction call and needs a citation, and it cites a post item
  or a framing answer — never a rig waypoint (rig feedback makes a new rig
  version).
- **What a citation resolves against.** `guide` resolves as a step's
  `rests_on` does (a framing, waypoint or post item id that is answered). A
  `quote` is an exact, case-sensitive substring of that answer's `verbatim` or
  of an `additions[].verbatim`. `delegated: true` needs an answer that is a
  delegation with an `agent_decision`, or a user answer that left part open
  with an `agent_decision` beside it. Both look in the answer's `history[]` as
  well as the current answer: a version built before an answer was replaced
  was built from the answer as it was then.

## Polish feedback

Every verdict in `versions[].verdicts[]` is read against
[INTERVIEW.md § Polish feedback](INTERVIEW.md#polish-feedback).

- **Which feedback needs an answer.** A human (`by` not `agent`) `bounced`
  verdict, unless a later human `accepted` verdict of the same review on the
  same version withdrew it (the last human verdict decides, as for
  acceptance). `provisional` holds a place and needs none.
- **What answers it.** Any later version (higher `n`) whose `answers_feedback`
  lists `{ "version": <n>, "verdict": <index> }`. Any kind, not only the same
  kind: rig feedback given at the direction review is answered by a new rig
  version. With a later version built and none listing it, it is a refusal
  (`FEEDBACK_UNANSWERED`); with no later version yet it is open work, a warning
  (`FEEDBACK_OPEN`) — the record is truthful and the next build is simply not
  made, and a refusal there would fail the check between every bounce and its
  rebuild.
- **A `not-asked` item** needs an `additions[]` entry at that answer (current or
  `history[]`) with `source: "polish feedback, v<n>"` whose `verbatim` is a
  fragment of the verdict's `verbatim`.
- **Counted by cause.** `feedback[]` holds, per bounced verdict, `verdict` (its
  path), `version`, `index`, `review`, `by`, `at`, `items` (`user`,
  `delegated`, `not_asked` counts from its `on_items`), `answered_by` (version
  numbers) and `withdrawn`; the text report prints one line per bounce and the
  totals. `user` is an agent error, `delegated` a cost the user chose,
  `not_asked` a gap in the guides.
- `answer_was` is not re-derived here: the answer may have changed since the
  verdict (a delegated item the user then answered), and the command that
  wrote it checked it against the record as it stood ([§ The review
  command](#the-review-command)).

## CG gates

A project whose `rig_type` is a full-screen scene (`fullscreen.minimal` or
`fullscreen.game_logic`) is a CG build: a painting brought to life whole. Each
of its `rig` versions is held to the three `@rig-c/parts` gates that measure
what a CG build is for, declared in the files the version was built from
(`src/cg-gates.ts`):

| Gate | Declared in | What parts refuses under it |
| --- | --- | --- |
| `assemble.editor_receipts.trace_parts: true` | the version's config | a part carved by a shape the config draws (`ASSEMBLE_PART_SOURCE`), an edited image with no receipt (`ASSEMBLE_EDITOR_RECEIPT_MISSING`) |
| `seam_over_motion.required: true` | the requirements file the config names as `requirements` | background at a declared seam pair on any frame, or no pair to read (`CHECK_SEAM_OVER_MOTION_REQUIRED`) |
| `boundary_colour.max_step_excess`, at most 12 | the same requirements file | a part boundary whose colour step exceeds the pieces' own by more than the allowance (`CHECK_BOUNDARY_COLOUR_STEP`), a step that cannot be taken (`CHECK_BOUNDARY_COLOUR_UNMEASURED`) |

- **Why `config.requirements`.** `rig-parts build` reads the file the config
  names and forwards it to its check, so a build from the config alone runs
  both requirements-file gates; a file passed only as `--requirements` by hand
  is a gate someone has to remember.
- **Why 12.** parts declares no default. Its public examples read 1 to 4 clean
  and 21 and up on planted stretches and notches, and each declares 12 (parts
  AUTHORING, *Boundary colour step*). A lower value is stricter and passes this
  check; a higher one is refused (`CG_BOUNDARY_ALLOWANCE_RAISED`): a step over
  12 is the piece's image or mesh to fix.
- **What is read.** The config at `provenance.config.path`, under the project
  and with its recorded sha256, then the requirements file it names (relative
  to the config's folder, under the project). A CG version's config and its
  requirements file are kept in `evidence/v<N>/`, which is in git and lives
  forever as what the verdict rested on (not in `outputs/`, which init ignores,
  nor `derived/`, which is regenerated): a gate that cannot be read is
  refused (`CG_GATES_UNREAD`), never passed.
- **What is not read.** Whether the gates pass. That is parts' check on the
  build; this check only refuses a CG version that does not ask for them. A
  refusal under a gate is a finding about the art, not a reason to drop the
  declaration.
- **Versions built before the gates.** A version whose `built_with` names a
  `@rig-c/parts` older than 2.4.0 could not declare them; it is a warning
  (`CG_GATES_PREDATE`), and the next CG version declares them.
- **`rig_type` values.** An answered `rig_type` outside the five values
  [INTERVIEW.md](INTERVIEW.md) lists is refused (`RIG_TYPE_UNKNOWN`): the value
  decides whether a version is held here, so a misspelt full-screen scene would
  otherwise pass ungated.

## The bust at meshes

The bust is meshed with its own regions by default ([CRAFT.md M2](CRAFT.md#m2-the-bust-is-meshed-unless-there-is-a-reason)).
The `meshes` guide's `x_deform` value records it as `"bust": "default"` or
`"bust": { "excluded": true, "reason": "…" }`; no `bust` field is the default
(`src/meshes-bust.ts`). The check reads the user's `value`, the agent's decision
on a delegation, and every `additions[].value`. An exclusion with an empty,
blank or missing `reason` is refused (`BUST_EXCLUSION_UNREASONED`), and any
other `bust` value is refused (`BUST_VALUE_UNKNOWN`). A value that is not an
object is not read.

## Refusals

Exit `1`. Each names its object in `path`.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `PROJECT_JSON_MISSING` | no `project.json` in the folder | run in a project folder, or name one |
| `PROJECT_JSON_INVALID` | the file is not a JSON object | fix the JSON |
| `SCHEMA_UNKNOWN` | `schema` is not `rig-create/project@0` (a later shape, or a `project.json` holding a collection record) | point the check at a project record; a collection folder is checked as a collection |
| `STAGE_UNKNOWN` | `stage` is not one of the stages | set a stage from `stage_values`; nothing else is checked until it is |
| `PARTS_NOT_INSTALLED` | `@rig-c/parts` is in neither the project's nor this repository's `node_modules/` | `bun install` in the project |
| `PARTS_SECTIONS_UNREADABLE` | the installed parts' `src/config.ts` does not load, or has no `CONFIG_SECTIONS` export of section names (parts older than 2.3.0, or a release that moved it) | install the pinned parts in the project; if a parts release moved the export, update `src/parts-sections.ts` |
| `SECTION_UNPLACED` | parts has a top-level section the placement table does not place | decide what it is — a waypoint, a post item, or not a direction call — in `src/waypoints.ts` and the INTERVIEW.md table, then ask it in the project |
| `WAYPOINT_MISSING` | a waypoint derived from parts is not in `interview.waypoints[]` | add the waypoint (with its `config[]` and prompts) and ask it |
| `POST_ITEM_MISSING` | a post item derived from parts (or `post_timing` / `post_composition`) is not in `interview.post.items[]` | add it |
| `FRAMING_MISSING` | `rig_type` or `reference` is not in `interview.framing[]` | add it |
| `INTERVIEW_INCOMPLETE` | a framing answer or waypoint guide is `null` while the stage is `interview`; a post item guide is `null` while the stage is `post-interview` | hold the interview: the user answers, delegates, or the interviewer writes not applicable with a reason |
| `FRAMING_SILENT` | a framing answer is `null` and the stage is past `interview` | the same; the stage moved on an incomplete interview |
| `WAYPOINT_SILENT` | a waypoint guide is `null` (or inherits a `null` or `per-member` collection answer) and the stage is past `interview` | the same |
| `POST_ITEM_SILENT` | a post item guide is `null` and the stage is past `post-interview` | the same |
| `ANSWER_MALFORMED` | an answer is none of the four states (no `delegated` flag, a user answer without `verbatim`/`value`, not applicable without `because`, an `inherited` without `from`) | write it in the answer shape of INTERVIEW.md |
| `INHERITED_UNRESOLVED` | an `inherited` answer names a collection or question that cannot be found from this folder | put the member under `<collection>/members/<name>/`, or fix `from` |
| `DELEGATION_UNDECIDED` | a delegated item (framing, waypoint, step checkpoint) has no `agent_decision`, and the sign-off approving the plan it belongs to exists (`plan-approved` for rig items, `post-interview` for post items) | the agent writes its decision and reasoning, and the plan is signed again seeing it |
| `PLAN_EMPTY` | `plan-approved` is signed and `plan.steps` is empty | draft the steps, then sign |
| `STEP_MALFORMED` | a step has no string `id`, a `phase` other than `rig` / `post`, or an id used twice | fix the step |
| `STEP_NO_BASIS` | a step's `rests_on` is empty | name the answers it is built on; a step never rests on nothing — ask for the sentence first |
| `STEP_BASIS_UNKNOWN` | `rests_on` names an id that is no framing, waypoint or post item | name an answer id, or add an `x_` prompt at the waypoint it belongs to |
| `STEP_BASIS_SILENT` | `rests_on` names an item that has no answer | answer the item (it is also reported on its own) |
| `STEP_NOT_A_WAYPOINT` | a `rig` step's `id` is not a waypoint id | one step per waypoint, named after it |
| `STEP_MISSING_FOR_WAYPOINT` | the plan is signed, a waypoint has a guide or a delegation, and no rig step has its id | add the step, or answer the waypoint not applicable if the plan does not pass it |
| `SIGNOFF_BEFORE_PLAN` | plan-approved is signed, but no stage-level approval is at or after `plan.drafted_at` | sign the drafted plan before running its steps |
| `GUIDE_PARTIAL_UNMARKED` | a user guide has `agent_decision` without nonempty `covers` | name the delegated remainder in `agent_decision.covers` and write its value and reasoning before plan approval |
| `STEP_STATUS_UNKNOWN` | an explicit step status is outside `pending`, `in-progress`, `at-checkpoint`, `done` | use `pending` before approval, then a documented running status |
| `STEP_RUN_UNAPPROVED` | a step is past `pending` and no sign-off of its approving stage covers it | keep the step `pending` until the plan is signed (a re-sign with `steps[]` covers only the steps it names) |
| `STEP_EDITED_AFTER_SIGNOFF` | a signed step differs from its latest covering sign-off's `step_hashes`, or that present map has no matching hash | sign again at `plan-approved` for rig steps or `post-interview` for post steps |
| `GUIDE_CHANGED_UNSIGNED` | a step is past `pending` and an answer it rests on changed (its `at`, or an `additions[]` entry) after the last sign-off covering it | re-sign `plan-approved` (or `post-interview` for post steps) naming the steps |
| `CHECKPOINT_UNANSWERED` | the plan is signed and a step's `checkpoint` is `null` | the user sets it (`true` / `false`) or delegates it |
| `CHECKPOINT_UNSIGNED` | a step is `done`, its checkpoint is on, and no `{ "stage": <its stage>, "checkpoint": <step id> }` sign-off exists (`parts` for `seethrough` and `assemble`, `rigging` for the other rig steps, `post` for post steps) | the user signs the checkpoint |
| `SIGNOFF_MALFORMED` | a sign-off lacks `stage`, `by`, `at` or `verbatim` | write it in the answer shape |
| `SIGNOFF_NOT_HUMAN` | a sign-off's `by` is `agent` | a person signs; the entry does not count |
| `SIGNOFF_UNKNOWN_STAGE` | a sign-off names a stage that does not exist | fix the stage |
| `SIGNOFF_AHEAD_OF_STAGE` | a sign-off names a stage later than the project's `stage` | move the stage, or remove the entry that was never given |
| `SIGNOFF_UNKNOWN_CHECKPOINT` | a sign-off's `checkpoint` names no step that runs in that stage | name the step |
| `PARTS_BAR_UNMET` | the stage is past `parts` and a step it runs (`seethrough`, `assemble`) is not `done` | finish the step and meet its bar (the parts check passing on the assembled parts), or move the stage back to `parts` |
| `PARTS_REVIEW_UNSIGNED` | the stage is past `parts-review`, or a `rigging` step is past `pending`, and no person signed `{ "stage": "parts-review", "checkpoint": null }` | the user reviews the assembled parts in rig-review's parts view and signs; until then the stage stays at `parts-review` and no rig step after `assemble` runs ([PROJECT.md § The parts are reviewed before rigging](PROJECT.md#the-parts-are-reviewed-before-rigging)) |
| `PARTS_VERDICT_MISSING` | rigging has started (the stage is past `parts-review`, or a `rigging` step is past `pending`), no rig version is accepted at rig-review yet or the stage is at most `rigging`, and the latest `parts-review` sign-off has no `evidence` of `kind: "parts-verdict"` with a `path` and a `sha256`; an in-flight project (`PARTS_REVIEW_PREDATES_STAGE`) is not asked | record the verdict the review wrote as the sign-off's `evidence: { kind: "parts-verdict", path, sha256 }`, `path` relative to the project ([PROJECT.md § The parts are reviewed before rigging](PROJECT.md#the-parts-are-reviewed-before-rigging)) |
| `PARTS_VERDICT_UNREAD` | the evidence `path` leaves the project, the file is not there, its bytes do not hash to the evidence `sha256`, or it is not a JSON object; the check reads exactly that file, never a default location | restore the file the sign-off names, or review again and sign with the new verdict |
| `PARTS_VERDICT_SCHEMA_UNKNOWN` | the verdict's `schema` is not `rig-review-parts-verdict/1` | sign with a verdict written by rig-review's parts view |
| `PARTS_VERDICT_ATLAS` | the verdict's `mode` is `atlas`: a built rig's atlas was reviewed, which is informational and never gates `parts-review` | review the assembled parts (`rig-review parts` on the parts package) and sign with that verdict |
| `PARTS_VERDICT_MALFORMED` | `mode` is neither `parts` nor `atlas`, `source.files[]` is empty or has an entry without `path`, `bytes` and `sha256`, an entry is not a POSIX path relative to the verdict's directory or leaves the project, or `parts.json` is not the first entry | sign with a verdict written by rig-review's parts view |
| `PARTS_VERDICT_NOT_APPROVED` | the verdict's `status` is `pending` or `changes-requested` | fix the flagged parts in `parts`, review again until every part is clean, and sign with the approved verdict |
| `PARTS_VERDICT_SOURCE_CHANGED` | a `source.files[]` entry, resolved against the verdict file's directory, is not on disk, or its byte count or sha256 is not the one reviewed: a part added, removed or repainted after the sign-off | review the parts as they now are and sign again; a parts change after sign-off is a new review |
| `PARTS_VERDICT_SOURCE_MISMATCH` | `source.sha256` is not the sha256 of the UTF-8 lines `<path>\t<sha256>\n` over `source.files[]`, sorted by path bytewise; the check recomputes it and never trusts the field | sign with a verdict written by rig-review's parts view, unedited |
| `STAGE_UNSIGNED` | the project's `stage` is past a stage that ends on a sign-off, and no `{ "stage": <it>, "checkpoint": null }` entry exists | the person signs it, or the stage goes back to where the signatures reach |
| `VERSION_MALFORMED` | a `versions[]` entry has no integer `n`, a `kind` other than `rig` / `post`, or a rig version has a non-null `rig_version` | fix the entry ([PROJECT.md § Versions](PROJECT.md#versions)) |
| `STILL_MALFORMED` | an `evidence[]` entry of `kind: "still"` lacks `path` or a 64-hex `sha256`, has a `camera` other than `"fixed"`, or no `frame` ≥ 0 | write it in the still-frame shape ([PROJECT.md § The rig review rests on a still frame](PROJECT.md#the-rig-review-rests-on-a-still-frame)); it does not count as a still until it is |
| `RIG_ACCEPTED_WITHOUT_STILL` | a rig version has a human `accepted` verdict at `rig-review` and no well-formed still-frame record in its `evidence[]` | record the still the user accepted on (rig-c/core or rig-c/review renders it) |
| `POST_ON_UNACCEPTED_RIG` | a post version's `rig_version` is not an integer, names no rig version, names one with no human `accepted` rig-review verdict, or the post version was built (`at`) before that acceptance | build post work on the accepted rig version; `rig-create handoff` names it |
| `RIG_VERSION_UNACCEPTED` | the stage is past `rig-review` and the latest rig version has no accepted rig-review verdict (or there is no rig version) | a rig change after rig-review is a new first review: move the stage back to `rig-review` and review the new rig on its still frame |
| `POST_ON_SUPERSEDED_RIG` | the latest post version is on an accepted rig version older than the latest accepted one | redo the post work on the new rig, as a new post version |
| `PAUSED_UNSIGNED` | `stage` is `paused` with no `{ "stage": "paused" }` sign-off | the person who stopped it signs |
| `PROVENANCE_MISSING` | a `rig` or `post` version has no `provenance.sections` object | write the version's provenance: the config it was built from and, per section, its citations |
| `SECTION_UNCITED` | a section that needs a citation (§ Provenance) is listed with no entries, or is in the read config and not listed | cite the guide sentence or delegation it rests on; if there is none, ask for one, or take the section out of the config before the version is shown |
| `SECTION_UNKNOWN` | a `rig` version's provenance names a section that is no `@rig-c/parts` section and not on the placement table | name the section as the config does; a misspelt name leaves the real one uncited |
| `ENTRY_UNCITED` | an entry has neither a non-empty `quote` nor `delegated: true` (or is not an object) | quote the sentence it follows, cite the delegation, or remove the entry |
| `CITATION_GUIDE_UNKNOWN` | an entry's `guide` is missing or names no framing, waypoint or post item | name the answer id it rests on |
| `CITATION_GUIDE_SILENT` | an entry's `guide` names an item with no answer | answer the item (it is also reported on its own) |
| `CITATION_WRONG_PHASE` | a `post` version's entry cites a rig waypoint | cite the post item (or framing answer) it rests on; a rig change is a new rig version |
| `QUOTE_NOT_FOUND` | an entry's `quote` is in no `verbatim` or `additions[].verbatim` of the cited answer (current or `history[]`) | quote the stored sentence exactly; feedback no guide covered goes into `additions[]` first |
| `VERDICT_MALFORMED` | a verdict lacks `by`, `at` or `verbatim`, has a `verdict` other than `accepted` / `bounced` / `provisional` or a `review` other than `rig-review` / `direction-review`, `on_items` is not a list, or an item lacks `id` or a valid `answer_was` | write it in the verdict shape ([PROJECT.md § Versions](PROJECT.md#versions)); `rig-create review` writes it |
| `FEEDBACK_UNANSWERED` | a human bounced verdict on version N, not withdrawn, and a version later than N exists while none lists `{ "version": N, "verdict": i }` in `answers_feedback` | list it in the version built from that feedback, with what changed in `changed`; if the feedback was not acted on, say so to the user — a later version that ignores it is the bounce coming back |
| `PRE_INTERVIEW_ORDER` | pre-interview versions follow a create-built version, or migrated history has nonpositive, repeated or out-of-order version numbers | put historical versions first, with strictly increasing `n` and consistent references |
| `PRE_INTERVIEW_HISTORY_MISSING` | a pre-interview version has no `original_verdicts` array | preserve its complete original verdict array |
| `PRE_INTERVIEW_VERDICT_LOST` | an original verdict has no unchanged `as_recorded` at the matching index, or an extra `as_recorded` has no original | restore the complete original history and its order |
| `PRE_INTERVIEW_VERDICT_UNKNOWN` | an original verdict string has no exact entry in `PRE_INTERVIEW_VERDICTS` | retain it and obtain an explicit mapping, without guessing |
| `PRE_INTERVIEW_VERDICT_MISMATCH` | a converted verdict disagrees with that table | apply the stated mapping and retain the original string |
| `PRE_INTERVIEW_OUTPUT_MALFORMED` | historical outputs are empty or lack a distinct project-relative path, lowercase sha256 or nonnegative integer size | list each frozen file with its path, sha256 and bytes |
| `PRE_INTERVIEW_OUTPUT_UNREAD` | a historical output is unreadable or resolves outside the project | restore the frozen file under the project |
| `PRE_INTERVIEW_OUTPUT_CHANGED` | a historical output's hash or size differs from the recorded value | restore the frozen bytes and inspect the migration record |
| `VERDICT_MALFORMED` (pre-interview) | an imported verdict lacks create-shaped fields, a valid date or a nonempty source, or `verbatim: null` lacks a nonempty note recording the user | preserve the source and write the record in `note`. A create-built version still requires the user's words |
| `FEEDBACK_REF_UNKNOWN` | an `answers_feedback` entry is not `{ version, verdict }` integers, names no version or no verdict index, or names a version not earlier than its own | point it at the verdict it answers |
| `FEEDBACK_ITEM_UNKNOWN` | an `on_items[]` id is no framing, waypoint or post item | name the answer the feedback is about; a decision no prompt reaches becomes an `x_` prompt at its waypoint, and the item names that waypoint |
| `FEEDBACK_NOT_ADDED` | an item is `not-asked` and its answer has no `additions[]` entry with `source: "polish feedback, v<N>"` quoting the verdict | add the sentence to the guide (`rig-create review` does it when it records the verdict) before the next version is built |
| `DELEGATION_NOT_GIVEN` | an entry is `delegated: true`, and no answer of the cited item (current or `history[]`) is a delegation or carries an `agent_decision` — or the delegation has no `agent_decision` | cite the sentence instead, or ask the user; a user answer is not a delegation unless it left part open and the agent's decision is written beside it |
| `RIG_TYPE_UNKNOWN` | the answered `rig_type` (the user's `value`, or the agent's decision on a delegation) is none of `character.idle`, `character.complex`, `character.monster`, `fullscreen.minimal`, `fullscreen.game_logic` | write the value the answer means ([INTERVIEW.md](INTERVIEW.md)); an illustration CG is `fullscreen.minimal` or `fullscreen.game_logic` |
| `CG_GATES_UNREAD` | a CG project's `rig` version (§ CG gates) has no config at `provenance.config.path` under the project with the recorded sha256, or the requirements file its config names is not there, under the project, a JSON object | keep the config the version was built from, and its requirements file, under the project (`evidence/v<N>/`) and record the config's path and sha256 |
| `CG_GATE_UNDECLARED` | a CG project's `rig` version's config lacks `assemble.editor_receipts.trace_parts: true` or a `requirements` path, or its requirements file lacks `seam_over_motion.required: true` or an integer `boundary_colour.max_step_excess`; `path` names the field | declare it and rebuild; a refusal parts then gives is the art's to fix, not a reason to drop the gate |
| `CG_BOUNDARY_ALLOWANCE_RAISED` | a CG version's requirements file declares `boundary_colour.max_step_excess` above 12 | declare 12 or less; fix the piece's image or mesh that the step points at |
| `BUST_EXCLUSION_UNREASONED` | the `meshes` value excludes the bust (`"excluded": true`) with an empty, blank or missing `reason` | write the user's reason (a rigid breastplate, say), or record `"bust": "default"`; the reason goes to parts with the opt-out |
| `BUST_VALUE_UNKNOWN` | the `meshes` value's `bust` is neither `"default"` nor `{ "excluded": true, "reason": "…" }` | write one of the two ([INTERVIEW.md](INTERVIEW.md)) |

## The hand-off command

```
rig-create handoff [<project dir>] [--rig <n>] [--json]
```

What post-production tooling runs before it runs
([PROJECT.md § The hand-off to post-production](PROJECT.md#the-hand-off-to-post-production)).
Exit `0` prints the rig version post work is on (with `--json`: `rig_version`,
`accepted`, `still`); exit `1` prints the first refusal on stderr as
`rig-create: CODE: message`; exit `2` on a usage error (`HANDOFF_RIG_INVALID`,
`HANDOFF_TOO_MANY_ARGUMENTS`, `UNKNOWN_OPTION`).

| Code | Fires when |
| --- | --- |
| `PROJECT_JSON_MISSING`, `PROJECT_JSON_INVALID` | as above |
| `RIG_REVIEW_UNSIGNED` | no human `{ "stage": "rig-review", "checkpoint": null }` sign-off |
| `RIG_VERSION_UNACCEPTED` | no rig version has an accepted rig-review verdict, or a newer rig version than the accepted one has none |
| `RIG_ACCEPTED_WITHOUT_STILL` | the accepted rig version has no still-frame record |
| `POST_ON_UNACCEPTED_RIG` | `--rig <n>` names no rig version, or one never accepted |
| `POST_ON_SUPERSEDED_RIG` | `--rig <n>` names a rig version accepted before the current one |

## The review command

```
rig-create review <version> --verdict <v> --by <who> --review <r> --verbatim <s> --source <s>
  [--item <id>[:<answer_was>]]... [--quote <id>=<s>] [--value <id>=<json>] [<project dir>] [--json]
```

Records one verdict ([INTERVIEW.md § Recording a verdict](INTERVIEW.md#recording-a-verdict)).
Exit `0` prints what was recorded (with `--json`: `verdict_path`, `verdict`,
`items[]` with `answer_was`, `how` — `derived` or `named` — and `addition`,
`stage`); exit `1` prints the refusal on stderr and writes nothing; exit `2` on
a usage error (`REVIEW_VERSION_INVALID`, `REVIEW_OPTION_MISSING`,
`REVIEW_OPTION_INVALID`, `REVIEW_TOO_MANY_ARGUMENTS`, `FEEDBACK_ITEM_DUPLICATE`,
`FEEDBACK_ITEM_AMBIGUOUS`, `FEEDBACK_QUOTE_NOT_IN_VERBATIM`,
`FEEDBACK_QUOTE_NOT_NOT_ASKED`, `UNKNOWN_OPTION`).

| Code | Fires when |
| --- | --- |
| `PROJECT_JSON_MISSING`, `PROJECT_JSON_INVALID` | as above |
| `REVIEW_VERSION_UNKNOWN` | `versions[]` has no entry with that `n` |
| `REVIEW_WRONG_KIND` | `--review` does not judge that version's kind (`rig-review` → `rig`, `direction-review` → `post`) |
| `FEEDBACK_ITEM_UNKNOWN` | `--item` names no framing, waypoint or post item; `review` does not create `x_` prompts |
| `FEEDBACK_ITEM_CONTRADICTS` | the named `answer_was` is one the record rules out: anything but `delegated` on a delegation, `delegated` on a user sentence with no delegated part |
| `FEEDBACK_ITEM_AMBIGUOUS` | no `answer_was` is named on a user sentence that left part to the agent; the record cannot choose |
| `FEEDBACK_ITEM_NOT_APPLICABLE` | the item is answered not applicable; ask it first |
| `FEEDBACK_ITEM_SILENT` | the item has no answer (or an unreadable one); ask it first |
| `FEEDBACK_ITEM_INHERITED` | a `not-asked` item is inherited from a collection; the sentence goes in the collection's answer, or the member overrides it first |
| `FEEDBACK_QUOTE_NOT_IN_VERBATIM` | a `--quote` is empty or not a fragment of `--verbatim` |
| `FEEDBACK_QUOTE_NOT_NOT_ASKED` | `--quote` / `--value` names an item that is not `not-asked`, or no `--item` |

## Warnings

Exit `0`. Bookkeeping that names no missing decision.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `STEP_SIGNOFF_HASH_MISSING` | a step's latest covering approval has no `step_hashes` field | sign again to record its contents. The historical signature stays readable, with no assumed hash match |
| `PRE_INTERVIEW_UNMIGRATED` | `x-pre_create.versions` still holds history awaiting migration | follow [PROJECT.md's migration steps](PROJECT.md#migrating-work-done-before-the-interview), preserving originals and outputs before moving the entries. The warning preserves the existing check exit code while migration is pending |
| `STAGE_VALUES_STALE` | the record's `stage_values` differs from `src/stages.ts` | regenerate the list |
| `QUESTION_SET_STALE` | `interview.question_set` does not name the installed `@rig-c/parts` version | re-read the waypoints from the installed version and update the string |
| `SECTION_RETIRED` | the table places a section on a waypoint or post item, but the installed parts no longer has it | drop it from the table and the record's `config[]` |
| `WAYPOINT_CONFIG_STALE` | a record waypoint's `config[]` is not the set of sections parts places there | regenerate `config[]` |
| `WAYPOINT_UNKNOWN` | the record has a waypoint no parts section is placed on | remove it, or place a section on it |
| `FEEDBACK_OPEN` | the latest version has a human bounced verdict and no version is built after it yet | build the next version and list the verdict in its `answers_feedback` |
| `PROVENANCE_CONFIG_CHANGED` | a version's `provenance.config.path` is present but its sha256 is not the recorded one, so its sections were not read | regenerate the config from the recorded command, or leave it: the sections provenance lists were checked |
| `PARTS_REVIEW_PREDATES_STAGE` | the project passed `plan-approved` (its first sign-off dated before 2026-11-04) before `parts` and `parts-review` existed, is past `parts-review`, and has no `parts-review` sign-off; the message names the project | nothing is assumed: no sign-off is written for it. A person may still review the parts and sign `parts-review`, which clears it ([PROJECT.md § The parts are reviewed before rigging](PROJECT.md#the-parts-are-reviewed-before-rigging)) |
| `CG_GATES_PREDATE` | a CG project's `rig` version was built with `@rig-c/parts` older than 2.4.0, before the CG gates existed (§ CG gates) | nothing for that version; the next CG version declares the gates |

## Collections

```
rig-create collection --check [<collection dir>] [--json]
rig-create collection pin [<collection dir>] [--changed <sentence>]
```

What is checked, and why, is [COLLECTIONS.md § The pin check](COLLECTIONS.md#the-pin-check).
Exit codes as above. `--json` prints `{ kind: "collection", ok, collection_dir,
stage, effective_stage, members[], pins_checked, refusals[], warnings[] }`;
`pins_checked` is the collection version compared, `null` when no version has
outputs. The record codes `SCHEMA_UNKNOWN`, `STAGE_UNKNOWN`,
`INTERVIEW_INCOMPLETE`, `ANSWER_MALFORMED`, `SIGNOFF_*`, `STAGE_UNSIGNED`,
`PAUSED_UNSIGNED` and `STAGE_VALUES_STALE` fire as for a project, against the
collection's stages.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `COLLECTION_JSON_MISSING` | no `collection.json` in the folder | run in a collection folder, or name one |
| `COLLECTION_JSON_INVALID` | the file is not a JSON object | fix the JSON |
| `COLLECTION_ITEM_SILENT` | a collection question, framing answer or waypoint guide is `null` and the stage is past `interview` (a post item guide: past `post-interview`) | answer it, delegate it, or answer `"per-member"` to leave it to each member |
| `MEMBER_MALFORMED` | a `members[]` entry is not an object with a string `name` | fix the entry |
| `MEMBER_PROJECT_MISSING` | a member's `project.json` (its `project` path, default `members/<name>/project.json`) is missing or not JSON | restore it, or remove the member |
| `PIN_STALE` | the member's current build differs from its pin in the latest collection version with outputs: another rig version, a file hash, a file listed or no longer listed | make the collection output again from the current builds and `collection pin`; or rebuild the member to the pinned build |
| `PIN_MISSING` | a member has no pin in that version | the same: a new collection version pins it |
| `PIN_UNKNOWN_MEMBER` | that version pins a name not in `members[]` | register the member again, or make a new collection version without it |
| `PIN_MALFORMED` | a pin is not `{ member, version (number or null), rigs[] }` | fix the pin |

`collection pin` refuses, writing nothing:

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `PIN_NO_MEMBERS` | `members[]` is empty | add members |
| `PIN_NO_BUILD` | a member has no rig version, its version lists no model or atlas, or a rig file has no sha256 and is not on disk | build and record the member version |
| `PIN_SOURCE_DRIFT` | a rig file on disk does not hash to the member version that lists it (rebuilt in place) | record the rebuild as a new member version, then pin |

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `MEMBER_UNREGISTERED` | a folder under `members/` is not in `members[]` | register it, or remove it |
| `OUTPUT_CHANGED` | a collection output on disk does not hash to the version that recorded it | outputs are frozen when pinned: restore it, or make and pin a new version |

## Recording signatures and review inputs

`signoff <stage> --by <who> [--steps <id,id,...>] [--verbatim-file <file>]`
records a signature without moving the stage. Exit 0 records it. Exit 1
refuses the record and exit 2 refuses usage. All refusals leave the project
file unchanged. The shared `VERBATIM_*` codes also apply to `review`.

| Code | Fires when |
| --- | --- |
| `SIGNOFF_OPTION_INVALID` | missing or repeated options, unknown stage, extra positional arguments, or `--steps` outside a plan approval stage, `--steps` with `--checkpoint`, missing parts-review `--evidence` or evidence on another stage (exit 2) |
| `SIGNOFF_NOT_HUMAN` | `--by` is `agent`, case-insensitively |
| `SIGNOFF_MALFORMED` | the record's `signoffs` is not a list |
| `SIGNOFF_STEP_INVALID` | coverage is empty, ids are missing or repeated, or a requested step is outside the stage's phase (malformed `--steps` exits 2) |
| `SIGNOFF_CHECKPOINT_INVALID` | a covered step has no boolean `checkpoint_proposed`, an undecided delegation or no boolean checkpoint answer; `--checkpoint` also refuses a missing, ambiguous, disabled or wrong-stage step |
| `UNKNOWN_OPTION` | an unsupported option, including `signoff --at` (exit 2) |
| `VERBATIM_UNREADABLE` | a verbatim file or stdin cannot be read |
| `VERBATIM_INVALID_UTF8` | the input cannot round-trip as UTF-8 through JSON (exit 2) |
| `REVIEW_NOT_HUMAN` | the reviewer is `agent`, case-insensitively |
| `REVIEW_OPTION_INVALID` | invalid `--at`, malformed feedback ref, or both `--verbatim` and `--verbatim-file` (exit 2) |
| `FEEDBACK_REF_UNKNOWN` | `--answers-feedback` names no existing verdict on an earlier version |
| `FEEDBACK_REF_DUPLICATE` | the reference already exists or occurs twice in this command |

`signoff parts-review --evidence` also uses the existing `PARTS_VERDICT_*`
refusals from the parts verdict reader before recording anything. `--checkpoint`
records an enabled execution checkpoint without a plan hash or phase approval.

## Prepared inputs and agent-found history bounces

`derived add` records an external operation, not pixel processing. The check
verifies both files of each `derived[]` entry tagged `prepared-input` against
its sha256. Untagged existing intermediates and empty or absent `derived[]`
are unchanged. No prepared files are silently registered or repaired.

| Refusal | Fires when | Clear it by |
| --- | --- | --- |
| `DERIVED_MALFORMED` | a prepared-input lacks operation, source path/hash, result path/hash, or a path escapes the project | use the prepared-input shape in PROJECT.md |
| `DERIVED_FILE_UNREADABLE` | the source is absent or unreadable, or a present prepared result cannot be read | restore the named source or make the named result readable |
| `DERIVED_FILE_CHANGED` | either file's bytes differ from its recorded sha256 | restore the recorded bytes, or record the new preparation |
| `AGENT_BOUNCE_MALFORMED` | a history entry dated on or after `AGENT_BOUNCE_SINCE` has a `bounce` other than `{ cause: "agent", failed, bar, replacement }` with non-empty text | write what failed, the bar, and its replacement |

`AGENT_BOUNCE_SINCE = 2026-11-05T00:00:00Z` in `src/stages.ts` is
independent of the parts-review stage boundary. Read the history entry's own
`at`, including in a collection history cited by an inherited guide.

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `DERIVED_RESULT_MISSING` | a regenerable prepared result is absent, including on a fresh clone | the message names the file and its recorded operation for regeneration |
| `AGENT_BOUNCE_LEGACY` | a free-form bounce has an entry date before the boundary, or no readable date | preserve its history; the warning names the new shape for future entries |

`derived add` refuses before writing on `DERIVED_USAGE` (exit 2: missing or
invalid arguments), `DERIVED_PATH_INVALID` (source and result not distinct
project-relative files, or either is `project.json`), `DERIVED_FILE_UNREADABLE`, `DERIVED_MALFORMED` (a
non-array `derived`), `PROJECT_JSON_INVALID`, or `SCHEMA_UNKNOWN` (exit 1).

## Review packages

```sh
rig-create review-package <n> [<project dir>] --config <path> --from <build out dir> [--json]
```

Copies the recorded rig version's explicitly supplied producer inputs and
stores `review_package` with the complete sorted package-relative file hashes
and `open` command. The copy lives in `derived/review/v<n>/`. Source files
remain available for comparison through their hashes after the original
build directory is cleaned. `interview --check` calls this package check for
create-built rig versions. Post and pre-interview versions are exempt.

| Refusal | Fires when | Clear it by |
| --- | --- | --- |
| `REVIEW_PACKAGE_MALFORMED` | a present `review_package` record lacks its config path/hash, source directory, file list or canonical open command | restore the recorded snapshot shape |
| `REVIEW_PACKAGE_CHANGED` | a present package has missing, extra or changed files, a symlink, or an invalid required layout | inspect and restore its recorded frozen bytes |

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `REVIEW_PACKAGE_MISSING` | a create-built rig has no package record, or its recorded package is absent | run the `rig-create review-package` command printed by the warning with the explicit frozen sources |

| Command refusal | Fires when |
| --- | --- |
| `REVIEW_PACKAGE_USAGE` | version/options are missing, repeated or invalid (exit 2) |
| `REVIEW_PACKAGE_VERSION_UNKNOWN` | the requested version is absent |
| `REVIEW_PACKAGE_VERSION_INVALID` | the version is post or pre-interview |
| `REVIEW_PACKAGE_PATH_INVALID` | a source is absolute, escapes the project, or the destination traverses a symlink outside it |
| `REVIEW_PACKAGE_INPUT_MISSING` | a source or a required layout entry is absent |
| `REVIEW_PACKAGE_INPUT_INVALID` | config is not a JSON object, a layout entry has the wrong kind or a copied tree contains a symlink |
| `REVIEW_PACKAGE_SOURCE_CHANGED` | source bytes change between hashing and copying |
| `REVIEW_PACKAGE_EXISTS` | an existing package differs from the declared sources |
| `REVIEW_PACKAGE_BUSY` | another writer holds the project's package lock |
| `REVIEW_PACKAGE_RECORD_CHANGED` | project.json changed during copying |

The existing `PROJECT_JSON_MISSING`, `PROJECT_JSON_INVALID`, `SCHEMA_UNKNOWN`
and `UNKNOWN_OPTION` refusals also apply. A rejected copy leaves the prior
project record and package intact. A successful command exits 0 and prints
its open command, or the `review_package` object with `--json`.

## Waypoint asks

Each applicable rig waypoint ask in `src/waypoints.ts` needs a guide `asks`
entry. This checks the recorded coverage, not the semantics of a user's prose.
Post items and not-applicable waypoints are excluded.

| Refusal | Fires when | Clear it by |
| --- | --- | --- |
| `GUIDE_ASK_UNANSWERED` | an applicable ask has no valid user/delegated entry; the message names its waypoint, id and question | ask it, or explicitly record its delegation |
| `GUIDE_ASKS_MALFORMED` | coverage is not a list, or has unknown/repeated ids, invalid states, or user coverage on a whole delegation | use one `{ id, state: "user" or "delegated" }` per applicable ask |
| `GUIDE_PARTIAL_UNMARKED` | a user guide delegates asks without free-text `agent_decision.covers` | name the delegated remainder |
| `DELEGATION_UNDECIDED` | delegated asks have no decision when the plan is approved | write the agent choice and reasoning |

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `GUIDE_ASKS_LEGACY` | no per-ask record and the resolved guide's own `at` predates `ASK_COVERAGE_SINCE` (2026-11-05T00:00:00Z), or is unreadable | preserve the old answer; record coverage when it is next asked |
