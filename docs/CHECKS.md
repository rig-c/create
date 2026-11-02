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
  silence, reported at the member's waypoint with the reason. Its `@rig-c/parts`
  is looked for in the member's folder, then in the collection's install.
- **A collection** (a folder with `collection.json` and no `project.json`, or
  the `collection.json` itself) is not a project: `interview --check` runs the
  collection check on it, the same as `collection --check` ([§ Collections](#collections)).

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

## Provenance

Every `versions[]` entry of kind `rig` or `post` is checked against
[INTERVIEW.md § Provenance](INTERVIEW.md#provenance-every-config-section-cites-its-guide):
each config section cites the guide sentence or the delegation it rests on.

- **Which sections the config has.** When `provenance.config.path` names a
  file under the project and its sha256 is `provenance.config.sha256`, the
  file's top-level keys are the sections, and a key provenance does not list
  is uncited. Otherwise — `derived/` is not kept, so this is the usual case —
  the sections `provenance.sections` lists are the ones checked, and the report
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

## Refusals

Exit `1`. Each names its object in `path`.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `PROJECT_JSON_MISSING` | no `project.json` in the folder | run in a project folder, or name one |
| `PROJECT_JSON_INVALID` | the file is not a JSON object | fix the JSON |
| `SCHEMA_UNKNOWN` | `schema` is not `rig-create/project@0` (a later shape, or a `project.json` holding a collection record) | point the check at a project record; a collection folder is checked as a collection |
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
| `FEEDBACK_REF_UNKNOWN` | an `answers_feedback` entry is not `{ version, verdict }` integers, names no version or no verdict index, or names a version not earlier than its own | point it at the verdict it answers |
| `FEEDBACK_ITEM_UNKNOWN` | an `on_items[]` id is no framing, waypoint or post item | name the answer the feedback is about; a decision no prompt reaches becomes an `x_` prompt at its waypoint, and the item names that waypoint |
| `FEEDBACK_NOT_ADDED` | an item is `not-asked` and its answer has no `additions[]` entry with `source: "polish feedback, v<N>"` quoting the verdict | add the sentence to the guide (`rig-create review` does it when it records the verdict) before the next version is built |
| `DELEGATION_NOT_GIVEN` | an entry is `delegated: true`, and no answer of the cited item (current or `history[]`) is a delegation or carries an `agent_decision` — or the delegation has no `agent_decision` | cite the sentence instead, or ask the user; a user answer is not a delegation unless it left part open and the agent's decision is written beside it |

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
| `STAGE_VALUES_STALE` | the record's `stage_values` differs from `src/stages.ts` | regenerate the list |
| `QUESTION_SET_STALE` | `interview.question_set` does not name the installed `@rig-c/parts` version | re-read the waypoints from the installed version and update the string |
| `SECTION_RETIRED` | the table places a section on a waypoint or post item, but the installed parts no longer has it | drop it from the table and the record's `config[]` |
| `WAYPOINT_CONFIG_STALE` | a record waypoint's `config[]` is not the set of sections parts places there | regenerate `config[]` |
| `WAYPOINT_UNKNOWN` | the record has a waypoint no parts section is placed on | remove it, or place a section on it |
| `FEEDBACK_OPEN` | the latest version has a human bounced verdict and no version is built after it yet | build the next version and list the verdict in its `answers_feedback` |
| `PROVENANCE_CONFIG_CHANGED` | a version's `provenance.config.path` is present but its sha256 is not the recorded one, so its sections were not read | regenerate the config from the recorded command, or leave it: the sections provenance lists were checked |

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
