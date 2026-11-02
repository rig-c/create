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
derived from parts), `refusals[]` and `warnings[]`, each `{ code, path, message }`
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
  question before it is a line in the table. parts exports no section list, so
  the reader takes the loader's accept list (`const TOP_KEYS` in its
  `src/config.ts`), falling back to the `CharacterConfig` interface's fields.
- **The stage order** is `src/stages.ts`, the one place it is written: which
  stages end on a sign-off (`interview`, `plan-approved`, `rig-review`,
  `post-interview`, `direction-review`) and which end when the last step of
  their phase meets its bar (`rigging`, `post`).
- **A collection member** (`<collection>/members/<name>/project.json`) has its
  `inherited` answers resolved against `<collection>/collection.json`. An
  inherited answer whose collection answer is `null` (or `"per-member"`) is
  silence, reported at the member's waypoint with the reason.

## Answer states, as the check reads them

| Written in the record | Read as | Passes |
| --- | --- | --- |
| `null` | silence | no — `INTERVIEW_INCOMPLETE` while the stage is still `interview` (post items: `post-interview`), `*_SILENT` once it has moved on |
| `{ "delegated": false, "verbatim", "value", … }` | user answer; `"value": "none"` is an answer | yes |
| `{ "delegated": true, … }` | delegation | yes; `agent_decision` must be present once the plan that uses it is signed (`DELEGATION_UNDECIDED`) |
| `{ "not_applicable": true, "because": "…" }` | not applicable | yes; without `because` it is `ANSWER_MALFORMED` |
| `{ "basis": "inherited", "from": { "collection", "question" } }` | the collection's answer, read as one of the rows above | as the collection's answer does; `INHERITED_UNRESOLVED` when it cannot be found |

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
- **A step is "run"** when its `status` is anything but `pending`; the
  approval and changed-guide checks apply from then. A checkpoint sign-off is
  required only once the step is `done`.

## Refusals

Exit `1`. Each names its object in `path`.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `PROJECT_JSON_MISSING` | no `project.json` in the folder | run in a project folder, or name one |
| `PROJECT_JSON_INVALID` | the file is not a JSON object | fix the JSON |
| `SCHEMA_UNKNOWN` | `schema` is not `rig-create/project@0` (a `collection.json`, or a later shape) | point the check at a project record |
| `STAGE_UNKNOWN` | `stage` is not one of the stages | set a stage from `stage_values`; nothing else is checked until it is |
| `PARTS_NOT_INSTALLED` | `@rig-c/parts` is in neither the project's nor this repository's `node_modules/` | `bun install` in the project |
| `PARTS_SECTIONS_UNREADABLE` | the installed parts source has neither `TOP_KEYS` nor `interface CharacterConfig` | a parts release moved the list: update `src/parts-sections.ts` (or take parts' own export once it has one) |
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
| `STEP_RUN_UNAPPROVED` | a step is past `pending` and no sign-off of its approving stage covers it | sign the plan (a re-sign with `steps[]` covers only the steps it names) |
| `GUIDE_CHANGED_UNSIGNED` | a step is past `pending` and an answer it rests on changed (its `at`, or an `additions[]` entry) after the last sign-off covering it | re-sign `plan-approved` (or `post-interview` for post steps) naming the steps |
| `CHECKPOINT_UNANSWERED` | the plan is signed and a step's `checkpoint` is `null` | the user sets it (`true` / `false`) or delegates it |
| `CHECKPOINT_UNSIGNED` | a step is `done`, its checkpoint is on, and no `{ "stage": <its phase's stage>, "checkpoint": <step id> }` sign-off exists | the user signs the checkpoint |
| `SIGNOFF_MALFORMED` | a sign-off lacks `stage`, `by`, `at` or `verbatim` | write it in the answer shape |
| `SIGNOFF_NOT_HUMAN` | a sign-off's `by` is `agent` | a person signs; the entry does not count |
| `SIGNOFF_UNKNOWN_STAGE` | a sign-off names a stage that does not exist | fix the stage |
| `SIGNOFF_AHEAD_OF_STAGE` | a sign-off names a stage later than the project's `stage` | move the stage, or remove the entry that was never given |
| `SIGNOFF_UNKNOWN_CHECKPOINT` | a sign-off's `checkpoint` names no step of that stage's phase | name the step |
| `STAGE_UNSIGNED` | the project's `stage` is past a stage that ends on a sign-off, and no `{ "stage": <it>, "checkpoint": null }` entry exists | the person signs it, or the stage goes back to where the signatures reach |
| `PAUSED_UNSIGNED` | `stage` is `paused` with no `{ "stage": "paused" }` sign-off | the person who stopped it signs |

## Warnings

Exit `0`. Bookkeeping that names no missing decision.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `STAGE_VALUES_STALE` | the record's `stage_values` differs from `src/stages.ts` | regenerate the list |
| `QUESTION_SET_STALE` | `interview.question_set` does not name the installed `@rig-c/parts` version | re-read the waypoints from the installed version and update the string |
| `SECTION_RETIRED` | the table places a section on a waypoint or post item, but the installed parts no longer has it | drop it from the table and the record's `config[]` |
| `WAYPOINT_CONFIG_STALE` | a record waypoint's `config[]` is not the set of sections parts places there | regenerate `config[]` |
| `WAYPOINT_UNKNOWN` | the record has a waypoint no parts section is placed on | remove it, or place a section on it |
