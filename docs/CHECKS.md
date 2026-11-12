# Checking the interview

## Sealed checkpoint presentation

These additive checks apply when `plan.checkpoint_evidence` is present. Historical
absence keeps its existing behavior. Review validates PNG format at publication.

| Code | Finding and remedy |
| --- | --- |
| `CHECKPOINT_EVIDENCE_USAGE` | `plan.checkpoint_evidence` command options are incomplete, repeated or combine `--file` with `--clear`. Use `checkpoint-evidence --file`, `checkpoint-evidence --clear` or `checkpoint-table --file --rows --out`. |
| `CHECKPOINT_EVIDENCE_INVALID` | `plan.checkpoint_evidence` has an invalid closed packet shape, duplicate identity, unknown step, alias, declaration size or aggregate table size. Retain the exact ordered producer declarations and attach them with `checkpoint-evidence`. |
| `CHECKPOINT_EVIDENCE_PATH_REFUSED` | `plan.checkpoint_evidence` names an unsafe, missing, symlinked, nonregular or oversized asset, or the table output directory is unavailable. Restore a bounded regular project-relative file and its regular directory chain. |
| `CHECKPOINT_EVIDENCE_HASH_MISMATCH` | `plan.checkpoint_evidence` raw asset bytes differ from their recorded SHA-256. Restore the sealed file or attach a new packet with its new seal. |
| `CHECKPOINT_EVIDENCE_TABLE_INVALID` | `plan.checkpoint_evidence.table` is invalid UTF-8/JSON, exceeds the signed table grammar or bounds, or the selected producer rows cannot form a complete rectangular presentation. Preserve all rows and columns through `checkpoint-table`. |
| `CHECKPOINT_EVIDENCE_WRITE_CONFLICT` | `plan.checkpoint_evidence` has a concurrent attachment write, changed project bytes or occupied table output. Wait for the writer, reload the record or select a new immutable table path. |

## Live publication delivery

The local report adds `holes[]` when a private publication gap exists. Each
entry has `code`, `path` and `message`. A HOLE makes the check exit 1 while
record-validation `refusals[]` remain separate. Reconcile acknowledged
publications through `rig-create job reconcile`. The installed Parts runtime
requires Bun 1.4 or later. See [Live review](LIVE-REVIEW.md).

| Code | Finding and remedy |
| --- | --- |
| `JOB_PUBLISH_PENDING` | A committed `project.json` result awaits publication. Restore its bound host and sources, then run `job reconcile` before another participating write or close. |
| `JOB_HOST_ATTACH_REFUSED` | Strict reuse-only attach to the bound live host was refused. The pending receipt names the host `reason` and `phase` (including `incarnation-missing` on `record` or `probe`). Reopen or restore the bound live host before reconciling. |
| `JOB_HOST_REUSE_MISMATCH` | The private binding's host tuple or `listenerIncarnation` (`jobId`, `origin`, `listenerIncarnation`, `root`, `stateDir`, `fingerprint`, `reviewer.id`, `reviewer.role`, `readerId`, `bindingId`, `partsEnumeratorId`, `partsEnumeratorVersion`, `apiSchema`, `actSchema`, `port`) differs. The pending receipt names the `field` and both `expected` and `actual` values. Restore the original host configuration before reconciling. |
| `JOB_PUBLICATION_STALE` | The pending version entry is missing or has a different entry hash. Restore that retained version and its files before reconciling. Later surrounding-record changes do not invalidate it. The check preserves the receipt and names the HOLE. |
| `JOB_PUBLICATION_INVALID` | A result, selector or retained file (including a declared rig/post or draft original painting `inputs[0]` and its PNG header) differs from the writer's recorded rig/post or draft. Restore its declared package, source painting and direction bytes. Missing/empty rig/post inputs keep no reference; an unreadable legacy original retains `INPUT_WRITER_MISSING` and no reference, as check does. |
| `JOB_PUBLICATION_SCENE_MISSING` | An @2 post lacks its scene reference or the scene file is missing or unreadable; restore the direction.scene reference and retained scene bytes before publishing. |
| `JOB_PUBLICATION_SCENE_CHANGED` | An @2 post scene differs from project.scenes, its path, document identity or recorded hash; restore the committed scene reference and bytes before publishing. |
| `JOB_PUBLICATION_PLATE_MISSING` | An @2 post scene lacks a plate identity or a plate file is missing or unreadable; restore every declared plate before publishing. |
| `JOB_PUBLICATION_PLATE_CHANGED` | An @2 post plate differs from its scene-recorded sha256; restore the retained plate bytes before publishing. |
| `JOB_BINDING_INVALID` | The private sibling/outbox is tracked or not effectively ignored, the binding is malformed/unavailable, or a job command has invalid arguments. Restore effective private ignores and the writer-owned binding through `job open`. |
| `JOB_PRIVATE_STORAGE_INVALID` | Private publication storage has unsafe permissions, type or symlinks. Restore owner-only real directories and regular files. |
| `JOB_OUTBOX_INVALID` | A private publication receipt is absent, malformed or unreadable. Restore its writer-owned bytes before reconciling. The check reports this as a HOLE. |
| `JOB_ASK_REFUSED` | A publication is acknowledged, but Review refused the ask for one of its declared subjects. The message names each subject and Review's code. The publication is not pending. Restore the published record bytes and run `job open` to ask again. |
| `JOB_DRAFT_UNKNOWN` | `job open --draft <id>` names a draft the record does not hold. Record the draft with `draft-rig` or name a recorded draft. |
| `JOB_WRITE_BUSY` | A bound writer holds the shared publication freeze. Wait for that operation before retrying. |
| `JOB_RECORD_INCOMPLETE` | Review 2.8.0 carries answered scene-context choices and historical diagnostics in `publication.interview` (`rig-review/job-interview@1`), and refuses invalid or stale editable `pending_options` sets before publication. Restore a current editable option set before reconciling. |


## Finalized Review acts

| Code | Finding and remedy |
| --- | --- |
| `REVIEW_API_SCHEMA_UNSUPPORTED` | `project.json.review_acts` received an unsupported API schema. Restore a live job using job-api@2 and fetch again. |
| `REVIEW_ACT_SCHEMA_UNSUPPORTED` | `project.json.review_acts` received an unsupported act schema, explicitly including act@1. Request a new act@2 without migrating the old act. |
| `REVIEW_PARTS_ENUMERATOR_UNSUPPORTED` | The act's Parts enumerator is missing or outside `>=2.25.0 <4.0.0`. Publish through an accepted installed Parts enumerator and review again. |
| `REVIEW_ACT_INVALID` | The fetched/retained act, response identity, authority, date or rig/post or parts value is malformed. Restore the original act evidence or request a new act. |
| `REVIEW_ACT_KIND_MISMATCH` | The act is for another version or a kind outside the requested review-verdict, parts-verdict, interview-picks, checkpoint or signoff writer, or a signoff act signs a stage other than the one `signoff <stage> --from-review` names. Use the matching version, stage and supported writer. |
| `REVIEW_ACT_TARGET_MISMATCH` | `signoffs[].target.version`: a `rig-review` or `direction-review` signoff act is ingested with `signoff <stage> --from-review <actId>`, but its `source.selector` names no version of that stage's kind (`rig` for rig-review, `post` for direction-review), or `--version` names another version than the one the person approved. The signature's target is the version Review displayed, so drop `--version` or ask for the sign-off again in Review on the version to sign. Refusal preserves the project record. |
| `REVIEW_ACT_DRAFT_MISMATCH` | `signoffs[].draft_id`: a `parts-review` signoff act is ingested with `signoff parts-review --from-review <actId>`, and its `source.selector` is a non-draft selector or names another draft than `--draft`. Drop `--draft` so the signature takes the draft from the act's `{ kind: 'draft', id }` selector, or ask for `parts-review` again in Review on the draft to sign. Refusal preserves the project record. |
| `REVIEW_ACT_CHECKPOINT_MISMATCH` | `signoff <stage> --checkpoint <id> --from-review <actId>` fetched a checkpoint act whose `planStepId` is not `<id>`, or whose `checkpointId` differs from its `planStepId` (create publishes no checkpoint alias). Sign the checkpoint the act names, or ask Review for this one. Refusal preserves the project record. |
| `REVIEW_ACT_CHECKPOINT_FAILED` | The fetched checkpoint act's outcome is `fail`. A failed checkpoint is feedback, never a sign-off: nothing is written. Fix the step from the act's words and ask for the checkpoint again in the live Review job. |
| `REVIEW_ACT_SUBJECT_UNDECLARED` | `signoff <stage> --from-review <actId>` or `signoff <stage> --checkpoint <id> --from-review <actId>` fetched an act whose subject (`signoff` for its stage, or `checkpoint` for its checkpoint id) is not among the subjects create declared for the act's publication, as kept in the private acknowledged receipt. A package publication declares only the record's own signable stage and its enabled checkpoints (LIVE-REVIEW.md). Ask for the sign-off in Review on a publication made while the record can sign it. A receipt written before declarations were retained, or none (a clone), skips this comparison. Refusal preserves the project record. |
| `REVIEW_FILE_ROUTE_REMOVED` | `project.json.review_acts` cannot ingest saved act files (exit 2). Use `review <version> --from-review <actId>` through the live Review job API. |
| `REVIEW_ACT_FETCH_REFUSED` | The live job refused or could not complete finalized-act fetch. The diagnostic retains the producer refusal code without exposing its private details. Restore the live job and its writer grant. |
| `REVIEW_ACT_SOURCE_STALE` | A current source binding or retained version/draft-entry identity differs from the displayed act, including a plan-bound signoff act (`plan-approved`, `rigging-interview`, `post-interview`) whose `source.plan` step ids and hashes, in order, differ from the current `plan.steps`. Restore the retained bytes or publish the current plan and request a new review or sign-off. Replays also refuse without changing the recorded verdict. |
| `REVIEW_ACT_REPLAY_CONFLICT` | A `(jobId, actId)` appears twice or its immutable value changed. Restore the original receipt and its single linked verdict. |
| `REVIEW_ACT_LEDGER_INVALID` | `review_acts[]` or one receipt's identity, hash, target, linked verdict, linked signoff (the one `signoffs[]` entry whose `source` names the act, with the act's stage, `by`, `at` and words, and for rig-review or direction-review a `target.version` equal to the act's `source.selector` version) or retained parts evidence is invalid. Restore the original receipt and verdict or signoff together. |
| `REVIEW_ACT_VERSION_UNVERIFIED` | WARN on ingest when the acknowledged publication receipt is unavailable. The version-entry comparison was skipped, and all explicit source bindings were checked. Preserve private acknowledged receipts for future ingests. |
| `PARTS_REVIEW_OPTION_INVALID` | `project.json.review_acts` received missing, duplicate or competing parts-review options. Use `parts-review --from-review <actId>` and submit human values through Review. |
| `PARTS_REVIEW_EVIDENCE_CONFLICT` | The deterministic semantic evidence path contains different bytes or unsafe filesystem entries. Preserve that evidence and restore the original act before retrying. Refusal preserves the project record. |
| `PARTS_REVIEW_CLI_ARGUMENT_INVALID` | `review_acts.argv` contains an absolute or escaping argument, or overrides create's JSON format. Pass literal project-relative arguments after `--`. |
| `PARTS_REVIEW_CLI_FAILED` | The review CLI failed or could not run, or the Review it ran has no `@rig-c/review` name and version. The message retains its exit code and diagnostic line. Restore the saved verdict and repeat its original display arguments. |
| `PARTS_REVIEW_CLI_INVALID` | CLI stdout is not supported UTF-8 verdict JSON with status, tool, source hashes and per-part outcomes and notes. Query a supported review CLI. |
| `PARTS_VERDICT_RECEIPT_INVALID` | A CLI receipt's metadata, retained response hash or copied fields differ, its draft/parts manifest binding is unavailable, or it repeats a receipt. Restore the exact retained response and draft record. |
| `PARTS_VERDICT_LATEST_NOT_APPROVED` | The draft's latest parts receipt, from either CLI or act, requests changes. Record a newer approved verdict before signing. The writer always refuses; check refuses signatures from `PARTS_VERDICT_LATEST_SINCE = 2026-11-08T00:00:00Z` and WARNs earlier ones. |



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
The report also includes `invariants`: the current guide-derived
`rig-create/invariants@1` document (entries and expected gaps, not rig-check
results), or `null` on an early unreadable or malformed project return.

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
- **`paused`** is checked as the first stage whose sign-off is missing,
  and needs its own `{ "stage": "paused" }` sign-off. `resume` returns it to
  the stage it was paused from ([Pausing and resuming](#pausing-and-resuming)).
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

A citation's optional `asks` is a nonempty list of unique canonical ask ids
recorded by the cited guide. A user ask needs a matching `quote` and cannot
be marked `delegated: true`. A delegated ask needs `delegated: true` and a
decided `agent_decision`. Coverage and its supporting words or decision must
match within one current or historical answer, including inherited history.
The check validates the declared ask and stored words, without interpreting
whether the quote semantically answers that ask.

| Code | Finding and remedy |
| --- | --- |
| `CITATION_ASKS_MALFORMED` | `asks` is empty, duplicated or has invalid shape. Write unique string ids. |
| `CITATION_ASK_UNKNOWN` | An id is absent from the guide's canonical waypoint asks. Choose a canonical id. |
| `CITATION_ASK_UNRECORDED` | The guide has no record of that ask. Record its user answer or delegation. |
| `CITATION_ASK_STATE` | The citation conflicts with the recorded state or lacks supporting words or a decided delegation in the same answer. Cite the appropriate evidence. |
| `CITATION_ASKS_MISSING` (WARN) | A covered guide's citation omits `asks`. Name the recorded asks it rests on. |

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

A delegated verdict item's optional `ask` names a canonical ask recorded as
delegated by a current or historical guide. Re-answering a guide preserves
valid earlier feedback through history. A pre-interview verdict retains its
historical treatment. Missing fields on guides without per-ask coverage add
no finding. These new refusals require an explicitly written field.

| Code | Finding and remedy |
| --- | --- |
| `FEEDBACK_ASK_UNKNOWN` | `ask` names no canonical ask of the guide. Choose a recorded canonical id. |
| `FEEDBACK_ASK_UNRECORDED` | The guide does not record that ask. Record its delegation first. |
| `FEEDBACK_ASK_STATE` | The ask is not recorded as delegated, or `--ask` accompanies feedback with another cause. Name the appropriate cause. |
| `FEEDBACK_ASK_MISSING` (WARN) | A delegated item omits `ask` on a covered guide. Name the delegated ask. |

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
| `INTERVIEW_INCOMPLETE` | a collection question deferral reaches `until_stage` (resolve with `collection answer --value-file`); a framing answer or waypoint guide is `null` while the stage is `interview`; a post item guide is `null` while the stage is `post-interview` | hold the interview: the user answers, delegates, or the interviewer writes not applicable with a reason |
| `FRAMING_SILENT` | a framing answer is `null` and the stage is past `interview` | the same; the stage moved on an incomplete interview |
| `WAYPOINT_SILENT` | a waypoint guide is `null` (or inherits a `null` or `per-member` collection answer) and the stage is past `interview` | the same |
| `POST_ITEM_SILENT` | a post item guide is `null` and the stage is past `post-interview` | the same |
| `ANSWER_MALFORMED` | an answer is none of the four states (no `delegated` flag, a user answer without `verbatim`/`value`, not applicable without `because`, an `inherited` without `from`), a member-local deferral, or a collection deferral outside collection-scope questions or without nonblank `by`/`reason`, valid `at` and an ordered lifecycle `until_stage` other than `paused` | write it in the answer shape of INTERVIEW.md |
| `INHERITED_UNRESOLVED` | an `inherited` answer names a collection or question that cannot be found from this folder | put the member under `<collection>/members/<name>/`, or fix `from` |
| `OVERRIDE_COLLECTION_INVALID` | an overridden answer's `overrides.collection` does not name its parent collection, or the collection cannot be read | restore the parent collection and reference its name |
| `OVERRIDE_QUESTION_INVALID` | `overrides.question` names no collection question with an answered current/history record | reference an answered collection question and retain its original answer in history |
| `OVERRIDE_ANSWER_STALE` | `collection_answer_at` is not the exact readable `at` of a current or historical answer to that question | restore the referenced collection answer and timestamp, or ask and record a fresh override |
| `OVERRIDE_REASON_MISSING` | an overridden member answer has missing, non-string or blank `why_verbatim` | ask why this member differs and record the exact user text with `interview-answer --why-file` |
| `DELEGATION_UNDECIDED` | a delegated item (framing, waypoint, step checkpoint) has no `agent_decision`, and the sign-off approving the plan it belongs to exists (`plan-approved` for rig items, `post-interview` for post items) | the agent writes its decision and reasoning, and the plan is signed again seeing it |
| `PLAN_EMPTY` | `plan-approved` is signed and `plan.steps` is empty | draft the steps, then sign |
| `PLAN_REPLACED_INVALID` | optional `plan.replaced` is not a list, or an entry lacks a previous step with id/phase, nonempty drafter or ISO date | restore the original full previous step and metadata |
| `PLAN_REPLACED_HASH` | an archived `sha256` differs from the existing `stepHash(entry.step)` | restore the retained step and its original hash |
| `PLAN_REPLACED_ACTION` | a history action is neither `revised` nor `removed` | retain the writer's original action |
| `PLAN_REPLACED_ORDER` | a history entry predates an earlier entry | preserve append order and restore the recorded dates |
| `PLAN_REPLACED_DUPLICATE` | two entries share `step.id` and `at` | retain unique history identities and retry with the current clock |
| `PLAN_REPLACED_SIGNOFF` | a reopened signature's hash for a replaced id matches neither current nor valid history, or the latest live covering signature matches only history | restore the signed step and history; reopen a live approval before replanning |
| `PLAN_OPTION_INVALID` | plan CLI arguments are missing, repeated or malformed (exit 2) | use plan add, revise or remove with the documented fields and drafter |
| `PLAN_STEP_INVALID` | plan writer sees no steps list, a duplicate add id or no unique revise/remove target | restore the plan and use the appropriate action and id |
| `PLAN_STEP_SIGNED` | revise/remove targets a step bound by a live covering plan signature | reopen its approving stage before replanning |
| `PLAN_STEP_DONE` | revise targets completed work, including completion retained by reopen, or add reuses its archived id | remove the completed step and add a new id |
| `PLAN_WRITE_CONFLICT` | another plan write holds the project lock, or project bytes change during validation | finish or recover the active writer, reload the project and retry |
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
| `SIGNOFF_AHEAD_OF_STAGE` | a sign-off names a stage later than the project's `stage` | move the stage, reopen a previously reached stage to preserve its history, or remove an entry that was never given |
| `SIGNOFF_UNKNOWN_CHECKPOINT` | a sign-off's `checkpoint` names no step that runs in that stage | name the step |
| `PARTS_BAR_UNMET` | the stage is past `parts` and a step it runs (`seethrough`, `assemble`) is not `done` | finish the step and meet its bar (the parts check passing on the assembled parts), or move the stage back to `parts` |
| `PARTS_REVIEW_UNSIGNED` | the stage is past `parts-review`, or a `rigging` step is past `pending`, and no person signed `{ "stage": "parts-review", "checkpoint": null }` | the user reviews the assembled parts in rig-review's parts view and signs; until then the stage stays at `parts-review` and no rig step after `assemble` runs ([PROJECT.md § The parts are reviewed before rigging](PROJECT.md#the-parts-are-reviewed-before-rigging)) |
| `DIFF_MAP_MISSING` | the gated latest parts-review sign-off dated from `DIFF_MAP_SINCE`, or without a readable date, has no `diff_map` because `project.json.diff_map` is absent (draft publication readiness instead warns and withholds the parts-review approval subject until the map is prepared) | generate the whole-figure report and record component classifications with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent` |
| `DIFF_MAP_NOT_AGENT` | `project.json.diff_map.by` is not `"agent"` or `at` is missing or unreadable, or `diff-classes` receives `--by` other than `agent` (exit 2) | record component classifications with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent` |
| `SIGNOFF_DIFF_MAP_REMOVED` | `signoff parts-review` receives `--diff-report`, `--triage-file` or `--component` (exit 2), or a `parts-review` sign-off dated from `DIFF_MAP_AGENT_SINCE` (or without a readable date) carries `diff_map` | record component classifications with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent`, and record the person's approval with `signoff parts-review` without diff-map flags |
| `DIFF_MAP_REPORT` | the named report is absent, escapes the project, differs from its SHA-256, or has the wrong spec or shape | regenerate a `rig-parts-diff-components/1` report and record its path and exact hash |
| `DIFF_MAP_STACK_MISMATCH` | neither derived stack exists, both exist ambiguously, or the unique stack differs from `report.stack.sha256` | retain one stack in parts' fixed build or assemble layout and regenerate the report on it |
| `DIFF_MAP_COMPONENT_UNLISTED` | a report id is absent from `diff_map.components` | list the named id with its status and why |
| `DIFF_MAP_COMPONENT_UNKNOWN` | a listed id is absent from the report | use the ids from the bound report |
| `DIFF_MAP_STATUS` | a component is malformed or repeated, has another status, or has an empty why | list each id once with `in-painting`, `fixed` or `left` and a nonempty why |
| `DIFF_MAP_CLASS` | an optional class has a wrong key or member set, repeats, overlaps, or disagrees with its expanded components | derive classes again with `diff-classes` and record with a decision-only triage file via `diff-classes --diff-report <path> --triage-file <file> --by agent` |
| `DIFF_MAP_CLASS_WHY` | a class reason names neither an exact border part nor its coverage band | inspect the class and state its measured property in why |
| `DIFF_MAP_TRIAGE` | the triage file is unreadable or malformed, supplies keys or members, or names unknown ids | read `diff-classes` and supply only status and why per class or component id |
| `DIFF_MAP_POLICY` | `definition.floor_px` exceeds 2 or `definition.threshold` exceeds 40 | regenerate with floor at most 2 and threshold at most 40 |
| `PARTS_VERDICT_MISSING` | rigging has started (the stage is past `parts-review`, or a `rigging` step is past `pending`), no rig version is accepted at rig-review yet or the stage is at most `rigging`, and the latest `parts-review` sign-off has no `evidence` of `kind: "parts-verdict"` with a `path` and a `sha256`; an in-flight project (`PARTS_REVIEW_PREDATES_STAGE`) is not asked | record the verdict the review wrote as the sign-off's `evidence: { kind: "parts-verdict", path, sha256 }`, `path` relative to the project ([PROJECT.md § The parts are reviewed before rigging](PROJECT.md#the-parts-are-reviewed-before-rigging)) |
| `PARTS_VERDICT_UNREAD` | the evidence `path` leaves the project, the file is not there, its bytes do not hash to the evidence `sha256`, or it is not a JSON object; the check reads exactly that file, never a default location | restore the file the sign-off names, or review again and sign with the new verdict |
| `PARTS_VERDICT_SCHEMA_UNKNOWN` | the verdict's `schema` is neither `rig-review-parts-verdict/1` nor `rig-review-parts-verdict/2` (including unknown `/3`) | sign with a verdict written by rig-review's parts view |
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
| `RIG_VERSION_UNACCEPTED` | the stage is past `rig-review` and the latest rig version has no accepted rig-review verdict (or there is no rig version). When the only accepted rig predates a reopen or amendment of `rig-review` or an earlier stage, the message names that verdict and the `reopens[]` or `amendments[]` entry that made it history | a rig change after rig-review is a new first review: move the stage back to `rig-review` and review the new rig on its still frame. A lapsed acceptance is not revived: register a new rig version (`rig-version`) and accept it (`review <n> --verdict accepted`) |
| `POST_ON_SUPERSEDED_RIG` | the latest post version is on an accepted rig version older than the latest accepted one | redo the post work on the new rig, as a new post version |
| `PAUSED_UNSIGNED` | `stage` is `paused` with no `{ "stage": "paused" }` sign-off, or `pause` finds no human one dated at or after the latest recorded move | the person who stopped it signs `paused`, then run pause |
| `PROVENANCE_MISSING` | a `rig` or `post` version has no `provenance.sections` object | write the version's provenance: the config it was built from and, per section, its citations |
| `SECTION_UNCITED` | a section that needs a citation (§ Provenance) is listed with no entries, or is in the read config and not listed | cite the guide sentence or delegation it rests on; if there is none, ask for one, or take the section out of the config before the version is shown |
| `SECTION_UNKNOWN` | a `rig` version's provenance names a section that is no `@rig-c/parts` section and not on the placement table | name the section as the config does; a misspelt name leaves the real one uncited |
| `ENTRY_UNCITED` | an entry has neither a non-empty `quote` nor `delegated: true` (or is not an object) | quote the sentence it follows, cite the delegation, or remove the entry |
| `CITATION_GUIDE_UNKNOWN` | an entry's `guide` is missing or names no framing, waypoint or post item | name the answer id it rests on |
| `CITATION_GUIDE_SILENT` | an entry's `guide` names an item with no answer | answer the item (it is also reported on its own) |
| `CITATION_WRONG_PHASE` | a `post` version's entry cites a rig waypoint | cite the post item (or framing answer) it rests on; a rig change is a new rig version |
| `QUOTE_NOT_FOUND` | an entry's `quote` is in no `verbatim` or `additions[].verbatim` of the cited answer (current or `history[]`) | quote the stored sentence exactly; feedback no guide covered goes into `additions[]` first |
| `RIG_VERSION_AT_INVALID` | a rig version in the project's own `versions[]`, including a pre-interview version, has an `at` other than a calendar date `YYYY-MM-DD` or an ISO date-time with mandatory `Z` or `±HH:MM`, or parsing fails or its written calendar date is invalid | restore the named version's valid build date from its record. Package, rig acceptance, rig signoff and handoff refuse the selected version before writing |
| `VERDICT_MALFORMED` | a verdict lacks `by`, `at` or `verbatim`, has a `verdict` other than `accepted` / `bounced` / `provisional` or a `review` other than `rig-review` / `direction-review`, `on_items` is not a list, or an item lacks `id` or a valid `answer_was` | write it in the verdict shape ([PROJECT.md § Versions](PROJECT.md#versions)); `rig-create review` writes it |
| `FEEDBACK_UNANSWERED` | a human bounced verdict on version N, not withdrawn, and a version later than N exists while none lists `{ "version": N, "verdict": i }` in `answers_feedback` | list it in the version built from that feedback, with what changed in `changed`; if the feedback was not acted on, say so to the user — a later version that ignores it is the bounce coming back |
| `PRE_INTERVIEW_ORDER` | pre-interview versions follow a create-built version, or migrated history has nonpositive, repeated or out-of-order version numbers | put historical versions first, with strictly increasing `n` and consistent references |
| `PRE_INTERVIEW_ORIGINAL_N_MISSING` | a pre-interview version omits its source id or it is not a number, string or null | copy its original id unchanged into `original_n` |
| `PRE_INTERVIEW_ORIGINAL_N_DUPLICATE` | two migrated versions have the same non-null `original_n` | restore their distinct source ids; repeated nulls are allowed |
| `PRE_INTERVIEW_CONFIG_LOST_MALFORMED` | `config_lost` lacks nonempty note and source strings, accompanies a non-null `provenance.config`, or is on a create-built version | record `{ note, source }` only on a pre-interview version whose config was lost, or restore its surviving config |
| `PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED` | `outputs_lost` lacks nonempty note and source strings, has an unknown key or malformed/empty `recorded` `{ path, sha256 }` bindings, names a `recorded` path that overlaps `outputs` or is readable on disk, accompanies non-empty `outputs` without `recorded`, or is on a create-built version | record `{ note, source, recorded }` with `version outputs-lost <n>` on a pre-interview version (or `{ note, source }` beside `outputs: []`), keeping surviving outputs in `outputs[]` |
| `PRE_INTERVIEW_HISTORY_MISSING` | a pre-interview version has no `original_verdicts` array | preserve its complete original verdict array |
| `PRE_INTERVIEW_VERDICT_LOST` | an original verdict has no unchanged `as_recorded` at the matching index, or an extra `as_recorded` has no original | restore the complete original history and its order |
| `PRE_INTERVIEW_VERDICT_UNKNOWN` | an original verdict string has no exact entry in `PRE_INTERVIEW_VERDICTS` | retain it and obtain an explicit mapping, without guessing |
| `PRE_INTERVIEW_VERDICT_MISMATCH` | a converted verdict disagrees with that table | apply the stated mapping and retain the original string |
| `PRE_INTERVIEW_OUTPUT_MALFORMED` | historical outputs are empty without a loss declaration, or lack a distinct project-relative path, lowercase sha256 or nonnegative integer size | list each frozen file with its path, sha256 and bytes |
| `PRE_INTERVIEW_OUTPUT_UNREAD` | a historical output is unreadable or resolves outside the project | restore the frozen file under the project; if a `pre_interview: true` version's frozen outputs did not survive, record the loss with `rig-create version outputs-lost <n> --note <text> --source <text>` |
| `PRE_INTERVIEW_OUTPUT_CHANGED` | a historical output's hash or size differs from the recorded value | restore the frozen bytes and inspect the migration record |
| `VERDICT_MALFORMED` (pre-interview) | an imported verdict lacks create-shaped fields, a valid date or a nonempty source, or `verbatim: null` lacks a nonempty note recording the user | preserve the source and write the record in `note`. A create-built version still requires the user's words |
| `FEEDBACK_REF_UNKNOWN` | an `answers_feedback` entry is not `{ version, verdict }` integers, names no version or no verdict index, or names a version not earlier than its own | point it at the verdict it answers |
| `FEEDBACK_ITEM_UNKNOWN` | an `on_items[]` id is no framing, waypoint or post item | name the answer the feedback is about; a decision no prompt reaches becomes an `x_` prompt at its waypoint, and the item names that waypoint |
| `FEEDBACK_NOT_ADDED` | an item is `not-asked` and its answer has no `additions[]` entry with `source: "polish feedback, v<N>"` quoting the verdict | add the sentence to the guide (`rig-create review` does it when it records the verdict) before the next version is built |
| `DELEGATION_NOT_GIVEN` | an entry is `delegated: true`, and no answer of the cited item (current or `history[]`) is a delegation or carries an `agent_decision` — or the delegation has no `agent_decision` | cite the sentence instead, or ask the user; a user answer is not a delegation unless it left part open and the agent's decision is written beside it |
| `RIG_TYPE_UNKNOWN` | the answered `rig_type` (the user's `value`, or the agent's decision on a delegation) is none of `character.idle`, `character.complex`, `character.monster`, `fullscreen.minimal`, `fullscreen.game_logic` | write the value the answer means ([INTERVIEW.md](INTERVIEW.md)); an illustration CG is `fullscreen.minimal` or `fullscreen.game_logic` |
| `CG_GATES_UNREAD` | a CG project's `rig` version (§ CG gates) has no config at `provenance.config.path` under the project with the recorded sha256, or the requirements file its config names is not there, under the project, a JSON object | keep the config the version was built from, and its requirements file, under the project (`evidence/v<N>/`) and record the config's path and sha256. For a `pre_interview: true` version with no `provenance.config` whose config did not survive, record the loss with `version config-lost <n>` (`CG_GATES_CONFIG_LOST`) |
| `CG_GATE_UNDECLARED` | a CG project's `rig` version's config lacks `assemble.editor_receipts.trace_parts: true` or a `requirements` path, or its requirements file lacks `seam_over_motion.required: true` or an integer `boundary_colour.max_step_excess`; `path` names the field | declare it and rebuild; a refusal parts then gives is the art's to fix, not a reason to drop the gate |
| `CG_BOUNDARY_ALLOWANCE_RAISED` | a CG version's requirements file declares `boundary_colour.max_step_excess` above 12 | declare 12 or less; fix the piece's image or mesh that the step points at |
| `BUST_EXCLUSION_UNREASONED` | the `meshes` value excludes the bust (`"excluded": true`) with an empty, blank or missing `reason` | write the user's reason (a rigid breastplate, say), or record `"bust": "default"`; the reason goes to parts with the opt-out |
| `BUST_VALUE_UNKNOWN` | the `meshes` value's `bust` is neither `"default"` nor `{ "excluded": true, "reason": "…" }` | write one of the two ([INTERVIEW.md](INTERVIEW.md)) |

The four `OVERRIDE_*` findings above are member `interview --check` findings,
not collection-wide interview checks. They inspect current member answers and
history. An invalid answer before `OVERRIDDEN_ANSWERS_SINCE =
2026-11-06T00:00:00Z` WARNs; on/after that date or without a readable date it
refuses. The writer uses the same validator before saving a fresh override.

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
| `RIG_VERSION_UNACCEPTED` | no live rig version has an accepted rig-review verdict, or a newer rig version than the accepted one has none. An acceptance that a later reopen or amendment made history is named with that entry |
| `RIG_ACCEPTED_WITHOUT_STILL` | the accepted rig version has no still-frame record |
| `PRE_INTERVIEW_CONFIG_LOST` | handoff would select an accepted pre-interview rig with a declared lost config. Build and accept a new rig with its retained config before post work |
| `PRE_INTERVIEW_OUTPUTS_LOST` | handoff would select an accepted pre-interview rig with lost outputs. Build and accept a new rig with surviving frozen outputs before post work |
| `POST_ON_UNACCEPTED_RIG` | `--rig <n>` names no rig version, or one never accepted |
| `POST_ON_SUPERSEDED_RIG` | `--rig <n>` names a rig version accepted before the current one |

## The review command

```
rig-create review <version> --verdict <v> --by <who> --review <r> --verbatim <s> --source <s>
  [--item <id>[:<answer_was>]]... [--ask <id>=<ask-id>] [--quote <id>=<s>] [--value <id>=<json>] [<project dir>] [--json]
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
| `DIFF_MAP_MISSING`, `DIFF_MAP_NOT_AGENT`, `DIFF_MAP_REPORT`, `DIFF_MAP_STACK_MISMATCH`, `DIFF_MAP_POLICY`, `DIFF_MAP_COMPONENT_UNLISTED`, `DIFF_MAP_COMPONENT_UNKNOWN`, `DIFF_MAP_STATUS`, `DIFF_MAP_CLASS`, `DIFF_MAP_CLASS_WHY` | a draft at unsigned `parts-review` lacks a valid agent map for its retained stack; the publication reader omits the approval subject, and bound draft writers and `job open` print the named findings as WARNs while draft registration remains usable | prepare the producer report and record agent classifications with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent`, then run `rig-create job open` to publish and ask the prepared approval subject; the person's approval is still required |
| `DIFF_MAP_PREDATES` | a gated parts-review sign-off predates `DIFF_MAP_SINCE` and has no diff_map | preserve the record and include the map when parts are reviewed again |
| `DIFF_MAP_ON_SIGNOFF_LEGACY` | a `parts-review` sign-off dated before `DIFF_MAP_AGENT_SINCE = 2026-11-09T00:00:00Z` carries `diff_map` on the sign-off entry | preserve the historical record; record future component classifications on `project.json.diff_map` with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent` |
| `PARTS_REVIEW_PREDATES_STAGE` | the project passed `plan-approved` (its first sign-off dated before 2026-11-04) before `parts` and `parts-review` existed, is past `parts-review`, and has no `parts-review` sign-off; the message names the project | nothing is assumed: no sign-off is written for it. A person may still review the parts and sign `parts-review`, which clears it ([PROJECT.md § The parts are reviewed before rigging](PROJECT.md#the-parts-are-reviewed-before-rigging)) |
| `CG_GATES_CONFIG_LOST` | a CG rig has a valid pre-interview `config_lost` declaration and no config; may accompany `CG_GATES_PREDATE` | preserve its loss note and source; build and accept a new rig with its retained config before post work |
| `CG_GATES_PREDATE` | a CG project's `rig` version was built with `@rig-c/parts` older than 2.4.0, before the CG gates existed (§ CG gates) | nothing for that version; the next CG version declares the gates |
| `REOPEN_SIGNOFF_LAPSED` | a human sign-off (stage or checkpoint) is history because of a `reopens[]` entry, and no live sign-off of the same stage and checkpoint exists; one per approval, at its latest lapsed record, naming the reopen (§ Reopening stages) | the person approves it again in the review tool and `signoff` records it (with `--checkpoint <id>` for a checkpoint, `--draft` and `--structure-file` for parts-review) |
| `REOPEN_VERDICT_LAPSED` | the latest human rig-review or direction-review acceptance is history because of a `reopens[]` entry, and no live acceptance of that review exists; the message names the verdict and the reopen | review a live version in the review tool and record the acceptance with `review <n> --verdict accepted`; a lapsed rig needs a new rig version (`rig-version`) first |

## Collections

```
rig-create collection --check [<collection dir>] [--json]
rig-create collection pin [<collection dir>] [--changed <sentence>] [--member <name>=<version>]...
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
| `COLLECTION_ITEM_SILENT` | a collection question, framing answer or waypoint guide is `null` and the stage is past `interview` (a post item guide: past `post-interview`), or a collection question deferral is past `until_stage` | record an ordinary collection question answer with `collection answer --value-file`; for shared guides, answer, delegate or use `"per-member"` |
| `COLLECTION_ANSWER_DEFERRED` (WARN) | a collection-scope question has a valid `{ deferred: { by, at, reason, until_stage } }` answer before its deadline | record an ordinary answer with `collection answer --value-file` before `until_stage`; the deferral is never inherited as a value |
| `MEMBER_MALFORMED` | a `members[]` entry is not an object with a string `name` | fix the entry |
| `MEMBER_PROJECT_MISSING` | a member's `project.json` (its `project` path, default `members/<name>/project.json`) is missing or not JSON | restore it, or remove the member |
| `PIN_STALE` | the default pin differs from the member's latest build, or an explicit pin's recorded rig version is absent or differs in its file list, variants or recorded/on-disk hashes | make the collection output again from the current builds and `collection pin`; or rebuild the member to the pinned build |
| `PIN_MISSING` | a member has no pin in that version | the same: a new collection version pins it |
| `PIN_UNKNOWN_MEMBER` | that version pins a name not in `members[]` | register the member again, or make a new collection version without it |
| `PIN_MALFORMED` | a pin is not `{ member, version (number or null), rigs[] }` | fix the pin |
| `PIN_SELECTION_INVALID` | a persisted pin carries a selection other than `"explicit"` with a positive integer rig version | restore the pin metadata or record a new collection pin |

`collection pin` refuses, writing nothing:

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `PIN_SELECTION_INVALID` | `--member` is malformed, duplicated, names an unregistered member or selects an absent/non-rig version | use each registered member once as `--member name=version`, selecting an existing rig version |
| `PIN_NO_MEMBERS` | `members[]` is empty | add members |
| `PIN_NO_BUILD` | a member has no rig version, its version lists no model or atlas, or a rig file has no sha256 and is not on disk | build and record the member version |
| `PIN_SOURCE_DRIFT` | a rig file on disk does not hash to the member version that lists it (rebuilt in place) | record the rebuild as a new member version, then pin |

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `MEMBER_UNREGISTERED` | a folder under `members/` is not in `members[]` | register it, or remove it |
| `OUTPUT_CHANGED` | a collection output on disk does not hash to the version that recorded it | outputs are frozen when pinned: restore it, or make and pin a new version |

`collection-binding` refuses, writing nothing:

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `COLLECTION_BINDING_USAGE` | `--out` is missing a value, duplicated, empty, or followed by an unknown flag or extra directory | pass at most one `<member dir>` and optional `--out <project-relative path>` |
| `COLLECTION_BINDING_PATH_INVALID` | `--out` is absolute, leaves `<member dir>`, equals `project.json` or `collection.json`, or traverses a symlink at the member root, parent directories or destination | pass a clean project-relative path inside `<member dir>` (default `evidence/collection-binding.json`) |
| `COLLECTION_BINDING_NOT_A_MEMBER` | `<member dir>` does not have `project.json` inside `<collection>/members/<name>/` with `../../collection.json` (`rig-create/collection@0`) | run `rig-create collection-binding` on a collection member directory |
| `COLLECTION_BINDING_MEMBER_MISMATCH` | `project.json.name` does not match the member folder name, `project.json.collection` disagrees with `collection.json.name`, or `collection.json.members[]` does not list `{ name, project: "members/<name>/project.json" }` | align `project.json` and `../../collection.json` for this member |
| `COLLECTION_BINDING_INHERITED_INVALID` | `../../collection.json` lacks a valid `interview` (`framing`, `waypoints`, `post.items`), a member answer with `basis: "inherited"` has no answered collection entry, or `collection-binding` cannot validate the resulting record | answer the inherited question on the collection first (`rig-create collection answer`) or fix the member's answer basis |

## Reopening stages

`rig-create reopen <stage> --by <who> [--verbatim-file <file>] [--source <text>]`
records a human backward move, snapshots affected step statuses into
`steps_before`, resets those statuses to `pending`, and sets `stage` in one
write. Existing signatures and versions remain unchanged. The check and writer
share the reopen validator. Each entry retains `from_stage` as its own reach
evidence, and the writer runs the complete project check on the final candidate
before writing. No reopen list means the existing contract applies.
This new record has no retroactive requirement on earlier project records.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `REOPEN_STAGE_UNKNOWN` | a target is unknown, `paused` or `accepted` | choose a stage in the order that can be reopened |
| `REOPEN_NOT_PASSED` | the target is later than its own from_stage and historical signatures/versions dated by the reopen | reopen a previously reached stage |
| `REOPEN_MALFORMED` | reopens is not a list, an entry lacks its human signature, from_stage, valid date or status snapshot, source is not text, or the writer cannot identify a plan step | restore the named record to the PROJECT.md reopen shape |
| `REOPEN_OPTION_INVALID` | missing/repeated option values or invalid argument count (exit 2) | supply a stage, --by, optional source and one optional folder |
| `SIGNOFF_NOT_HUMAN` | a reopen is signed by agent, case-insensitively | obtain a person's signature |

The existing `UNKNOWN_OPTION`, `VERBATIM_*`, `PROJECT_JSON_*` and
`SCHEMA_UNKNOWN` command refusals apply. A refused command writes nothing.
Sign-offs and checkpoints at or before their applicable reopen are historical,
not live; they cannot satisfy `STAGE_UNSIGNED`, `PARTS_REVIEW_UNSIGNED`,
`PAUSED_UNSIGNED`, `CHECKPOINT_UNSIGNED` or authorise execution. Fresh work on
a historical rig is `POST_ON_SUPERSEDED_RIG`; the hand-off requires a newly
built and accepted rig, using its existing named refusals. Historical rig
acceptances remain recorded, and an unaffected rig survives a post-only reopen.

The check lists what a reopen voided and nothing has restored yet, as WARNs:
`REOPEN_SIGNOFF_LAPSED` and `REOPEN_VERDICT_LAPSED` (§ Warnings). Liveness is
the same cutoff the gates above read. A reopen is legitimate, so the list refuses
nothing and carries no contract date. Approvals voided only by an amendment are
listed by the report's `amendments[].lapsed` instead (§ Forward amendments).

## Forward amendments

`rig-create amend` records a human correction against an artifact and its
owning stage. It shares approval cutoffs with `reopen`, retains the current
stage, and checks the complete candidate before writing. New records carry
`target`, `by`, clock-supplied `at`, unchanged `verbatim`, optional `source`
and new input `changes` hashed by the writer. Existing records acquire no new
obligation. Amended reports add the named lapse and upstream lists and an
empty `keep_by_binding` list. The fixed G table and re-signing contract are in
[PROJECT.md](PROJECT.md#forward-amendments).

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `AMENDMENT_MALFORMED` | amendments is not a list, or an entry lacks a human name, valid date, verbatim or optional text source | restore the named amendment to the writer's record shape |
| `AMENDMENT_TARGET_INVALID` | target lacks a supported kind, artifact id or ordered non-terminal stage | supply the artifact and its owning stage to amend |
| `AMENDMENT_CHANGES_INVALID` | new input bindings are empty, duplicate or lack paths and lowercase SHA-256 hashes | record distinct new input files through amend |
| `AMENDMENT_INPUT_UNREAD` | a new input cannot be read or escapes the project, including through a symlink | retain readable input bytes under the project and amend again |
| `AMENDMENT_OPTION_INVALID` | required arguments are absent, option values are empty/repeated or the argument count is invalid (exit 2) | supply stage, kind, target, new input and signer once, repeating only change |
| `SIGNOFF_NOT_HUMAN` | an amendment is signed by agent, case-insensitively after trimming | obtain a person's signature |

The existing `UNKNOWN_OPTION`, `VERBATIM_*` and project-check codes also apply.
Every refused write leaves the record byte-identical. History checks validate
declared binding shape without requiring old inputs to remain working files.

## Recording signatures and review inputs

```sh
rig-create signoff <stage> --from-review <actId>
rig-create signoff <stage> --by <who> [--steps <id,id,...>] [--verbatim-file <file>]
rig-create signoff parts-review --by <who> --evidence <path> --diff-report <path> [--component '<id>=<status>:<why>'] [--verbatim-file <file>]
```

The command records a signature without moving the stage. Exit 0 records it. Exit 1
refuses the record and exit 2 refuses usage. All refusals leave the project
file unchanged. The shared `VERBATIM_*` codes also apply to `review`.

| Code | Fires when |
| --- | --- |
| `SIGNOFF_OPTION_INVALID` | missing or repeated options, unknown stage, extra positional arguments, `--from-review` with `--by`, `--verbatim-file` or `--steps` on either route (the act supplies the person, words and covered steps; without `--checkpoint` it is the stage sign-off route, with `--checkpoint <id>` the checkpoint route), or `--steps` outside a plan approval stage, `--steps` with `--checkpoint`, missing parts-review `--evidence`, evidence or diff options on another stage, duplicate component ids, malformed component flags, or `--component` without `--diff-report` (exit 2) |
| `SIGNOFF_NOT_HUMAN` | `--by` is `agent`, case-insensitively |
| `SIGNOFF_MALFORMED` | the record's `signoffs` is not a list |
| `SIGNOFF_STEP_INVALID` | coverage is empty, ids are missing or repeated, or a requested step is outside the stage's phase (malformed `--steps` exits 2) |
| `SIGNOFF_CHECKPOINT_INVALID` | a covered step has no boolean `checkpoint_proposed`, an undecided delegation or no boolean checkpoint answer; `--checkpoint` also refuses a missing, ambiguous, disabled or wrong-stage step |
| `RIG_VERSION_UNACCEPTED` | `signoff rig-review` while no live rig version has an accepted rig-review verdict because a reopen or amendment made the accepted one history; the message names that verdict and the `reopens[]` or `amendments[]` entry. Register a new rig version (`rig-version <n>`), accept it (`review <n> --verdict accepted --review rig-review`), then sign. A rig made history is no `--version` target either, and a project with no acceptance at all is refused by the target selection (`SIGNOFF_TARGET_STALE`) |
| `UNKNOWN_OPTION` | an unsupported option, including `signoff --at` (exit 2) |
| `VERBATIM_UNREADABLE` | a verbatim file or stdin cannot be read |
| `VERBATIM_INVALID_UTF8` | the input cannot round-trip as UTF-8 through JSON (exit 2) |
| `REVIEW_NOT_HUMAN` | the reviewer is `agent`, case-insensitively |
| `REVIEW_OPTION_INVALID` | invalid `--at`, malformed feedback ref, both `--verbatim` and `--verbatim-file`, or competing human-value/feedback flags with `--from-review` (exit 2) |
| `FEEDBACK_REF_UNKNOWN` | `--answers-feedback` names no existing verdict on an earlier version; `rig-version` and `direction write/patch --answers` additionally require a human bounced verdict. Name an earlier human bounce in `versions[vN].answers_feedback` |
| `FEEDBACK_REF_DUPLICATE` | the reference already exists or occurs twice in this command |

`signoff parts-review --evidence` also uses the existing `PARTS_VERDICT_*`
refusals from the parts verdict reader before recording anything. `--diff-report`
and repeatable `--component` also run the shared `DIFF_MAP_*` reader before
writing. Missing maps are refused from `DIFF_MAP_SINCE`; a zero-component
report needs no component flags. Refusals preserve the project file bytes. `--checkpoint`
records an enabled execution checkpoint without a plan hash or phase approval.

## Prepared inputs and agent-found history bounces

`derived add` records an external operation, not pixel processing. The check
verifies both files of each `derived[]` entry tagged `prepared-input` against
its sha256. Untagged existing intermediates and empty or absent `derived[]`
are unchanged. No prepared files are silently registered or repaired.

| Refusal | Fires when | Clear it by |
| --- | --- | --- |
| `PLATE_RECEIPT_INVALID` | a declared receipt is absent, outside the project, symlinked, changed, has an unknown spec or key order, or disagrees with the recorded painting, mask or output | restore the producer receipt and record it with `derived add --receipt` |
| `PLATE_RECEIPT_MISSING` | a derived plate first registered by a retained scene on or after `PLATE_RECEIPT_SINCE` lacks a receipt | record the producer receipt with `derived add --receipt` |
| `DERIVED_MALFORMED` | a prepared-input lacks operation, source path/hash, result path/hash, or a path escapes the project | use the prepared-input shape in PROJECT.md |
| `DERIVED_FILE_UNREADABLE` | the source is absent or unreadable, or a present prepared result cannot be read | restore the named source or make the named result readable |
| `DERIVED_FILE_CHANGED` | either file's bytes differ from its recorded sha256 | restore the recorded bytes, or record the new preparation |
| `AGENT_BOUNCE_MALFORMED` | a history entry dated on or after `AGENT_BOUNCE_SINCE` has a `bounce` other than `{ cause: "agent", failed, bar, replacement }` with non-empty text | write what failed, the bar, and its replacement |

Contract dates (`AGENT_BOUNCE_SINCE`, `ASK_COVERAGE_SINCE`, `DIFF_MAP_SINCE`, `DIFF_MAP_AGENT_SINCE`, `APPLIED_REVIEW_SINCE`, `PROJECTION_ASKS_SINCE`, `SETUP_PAINTING_SINCE`, `FIGURE_MASK_SINCE`, `FIGURE_MASK_INPUTS_SINCE`, `CHOICE_ANSWERS_SINCE`, `BUILD_IDENTITY_SINCE`, `PART_FILE_IDENTITY_SINCE`, `CONFIG_INPUTS_SINCE`, `DESCRIBED_DIRECTION_SINCE`, `SIGNOFF_TARGET_SINCE`, `SIGNOFF_ANSWERS_SINCE`, `STAGE_PROGRESS_SINCE`, `INPUT_WRITER_SINCE`, `DIRECTION_SCENE_SINCE`, `OVERRIDDEN_ANSWERS_SINCE`, `RUN_RECORD_SINCE`, `PROGRESS_HISTORY_SINCE`, `SCENE_CONTEXT_SINCE`, `PARTS_CHECK_SINCE`, `PLATE_RECEIPT_SINCE`, `REVIEW_READ_SINCE`, `PARTS_VERDICT_DRAFT_SINCE`, `PARTS_VERDICT_LATEST_SINCE`, `PARTS_VERDICT_RECEIPT_SINCE`, `FIX_LEDGER_SINCE` and `DRAFT_CONFIG_INPUTS_SINCE`) are the day the change lands, at 00:00Z, so they are never in the future; a record made earlier that day is checked against pilot projects before the change lands.

Exception for #117 (2026-11-06): `original_n` has no `*_SINCE` boundary because repo HQ counted zero consumer records with `pre_interview: true`, only the synthetic fixture being updated, and historical build dates cannot date a migration.

`AGENT_BOUNCE_SINCE = 2026-11-05T00:00:00Z` in `src/stages.ts` is
independent of the parts-review stage boundary. Read the history entry's own
`at`, including in a collection history cited by an inherited guide.

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `PLATE_RECEIPT_MISSING` | a derived plate first registered by a retained scene before `PLATE_RECEIPT_SINCE` lacks a receipt | retain the legacy record, or record its producer receipt |
| `DERIVED_RESULT_MISSING` | a regenerable prepared result is absent, including on a fresh clone | the message names the file and its recorded operation for regeneration |
| `AGENT_BOUNCE_LEGACY` | a free-form bounce has an entry date before the boundary, or no readable date | preserve its history; the warning names the new shape for future entries |

`derived add` refuses before writing on `DERIVED_USAGE` (exit 2: missing or
invalid arguments), `DERIVED_PATH_INVALID` (source and result not distinct
project-relative files, or either is `project.json`), `DERIVED_FILE_UNREADABLE`, `DERIVED_MALFORMED` (a
non-array `derived`), `PROJECT_JSON_INVALID`, or `SCHEMA_UNKNOWN` (exit 1).

`PLATE_RECEIPT_SINCE = 2026-11-08T00:00:00Z` uses the earliest retained scene registration with matching derived index, path and sha256. Input plates are excluded. Every declared receipt is verified regardless of date or scene registration. `scene write` runs the same project checker before committing.

## Review packages

`BUILD_IDENTITY_SINCE = 2026-11-06T00:00:00Z` dates the build-identity findings by the rig version's `at`. Earlier or unreadably dated versions receive WARNs with the same named codes. An unreadably dated rig version is also refused by `RIG_VERSION_AT_INVALID`; the census for #164 found none among seven template and eighteen consumer rig versions, so this refusal has no date cutoff. The accepted manifest comes from the latest parts approval live at that version's build time; an unreadable build date uses the latest live approval and emits WARNs for any identity disagreement. The comparison reads declared hashes and the retained hash-bound verdict, including when the regenerable package is absent.

| Code | Condition | Remedy |
| --- | --- | --- |
| `REVIEW_PACKAGE_CONFIG_MISMATCH` | package config SHA256 differs from the version's provenance config SHA256 | preserve history and record a new version whose config and package bind the same build |
| `REVIEW_PACKAGE_PARTS_MISMATCH` | package out/parts.json SHA256 differs from the accepted parts manifest SHA256 at build time. Rig acceptance and handoff refuse this for the selected version | preserve history and record a new version from the accepted parts and its own build outputs |
| `REVIEW_PACKAGE_PART_FILE_MISMATCH` | on or after PART_FILE_IDENTITY_SINCE, a packaged part SHA256 differs from an image listed in the accepted verdict source.files, or that image is missing from the package | preserve the package and record a new version containing the reviewed part files |
| `REVIEW_PACKAGE_PART_FILE_LEGACY` | WARN for the same differing or missing part identity before PART_FILE_IDENTITY_SINCE or with an unreadable version date | preserve historical bytes and include the reviewed part files in the next version |
| `REVIEW_PACKAGE_PARTS_UNREAD` | the hash-bound verdict needed for a version's parts comparison is unreadable or differs from its recorded bytes | restore the retained verdict matching signoffs[].evidence.sha256 before checking or packaging the version; before BUILD_IDENTITY_SINCE or with an unreadable version date this is a WARN |

`PART_FILE_IDENTITY_SINCE = 2026-11-06T00:00:00Z` dates individual part identity by the rig version's `at`. Each non-manifest entry in the selected accepted verdict's `source.files[]` maps relative to its `parts.json` directory into the package's `out/` directory. The package writer checks those identities before publication. Check, rig acceptance, rig signoff and handoff enforce the same cutoff, scoped to the selected rig at writer and handoff boundaries. The message names the part path, reviewed hash and packaged hash or `missing`. Rig acceptance and handoff also propagate `REVIEW_PACKAGE_CHANGED` and `REVIEW_PACKAGE_PARTS_MISMATCH` for the selected version. A date-only `at` compares against each cutoff as UTC midnight, so `2026-11-06` falls on the post-cutoff side exactly like `2026-11-06T00:00:00Z`.

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
| `REVIEW_PACKAGE_CHANGED` | a present package has missing, extra or changed files, a symlink, or an invalid required layout. Rig acceptance and handoff refuse this for the selected version | inspect and restore its recorded frozen bytes |

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `REVIEW_PACKAGE_MISSING` | a create-built rig has no package record, or its recorded package is absent, leaving its figure mask unverified | run the `rig-create review-package` command printed by the warning with the explicit frozen sources |

| Writer or checker finding | Fires when |
| --- | --- |
| `REVIEW_PACKAGE_USAGE` | version/options are missing, repeated or invalid (exit 2) |
| `REVIEW_PACKAGE_VERSION_UNKNOWN` | the requested version is absent |
| `REVIEW_PACKAGE_VERSION_INVALID` | the version is post or pre-interview |
| `REVIEW_PACKAGE_PATH_INVALID` | a source is absolute, escapes the project, a figure-mask path leaves the config directory, or the destination traverses a symlink outside it |
| `FIGURE_MASK_CHANGED` | the packager's declared mask is missing, unreadable, a non-file, or differs from its declared SHA-256. Restore the declared PNG before packaging |
| `FIGURE_MASK_MISSING` | the packager's retained requirements contain a malformed figure-mask declaration. Declare its path and lowercase SHA-256 before packaging |
| `REVIEW_PACKAGE_INPUT_MISSING` | a writer source or required layout entry is absent, or the checker finds a config-named input missing from the frozen inventory. The checker WARNs before CONFIG_INPUTS_SINCE by version.at and refuses from that date. Preserve history and package the complete named inputs on the next build |
| `REVIEW_PACKAGE_INPUT_INVALID` | a writer config is not a JSON object, a layout entry has the wrong kind, a copied tree contains a symlink, or a config-named directory input (such as `assemble.occluders[i].plate`) lacks a regular-file `receipt.json` declaring the installed parts' `PLATE_RECEIPT_SPEC` (or the installed parts exports none, or the frozen inventory records unreferenced sibling files inside that directory). The checker also reports an unreadable frozen config or unavailable config-file declarations, with unavailable declarations WARNed before CONFIG_INPUTS_SINCE by version.at and refused from that date. An existing project-level parts-loader refusal suppresses duplicate input findings |
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

### Projection and ground

New assemble guides cover `projection` and, only for visible, `ground` through
the waypoint ask checks. Values are `guide.value.project` / `.ground` for
user asks or `guide.agent_decision.value.project` / `.ground` for delegated
asks. Projection accepts `core` or `visible`; ground accepts `plain` or `busy`.
Missing or invalid values are `GUIDE_ASK_UNANSWERED` by name, even if coverage
claims an answer. Record the answer or a decided delegation before approval.

`ASSEMBLE_GROUND_UNANSWERED` refuses a readable config declaring
`assemble.project: "visible"` when the guide has no valid ground answer. Ask
plain or busy, record its ask and value, and write `assemble.ground` into the
config. The check reads `config.json` if present and retained rig-version
configs via their provenance paths and hashes. Core and absent projection add
no ground question or refusal. Unread retained files remain under the existing
provenance checks. Answer/config mismatch is outside this check.

The resolved guide's own `at` controls `PROJECTION_ASKS_SINCE`,
2026-11-06T00:00:00Z. Earlier or unreadable dates preserve the legacy contract
with `GUIDE_ASKS_LEGACY` for missing applicable asks. Parts continues to emit
`ASSEMBLE_GROUND_PLAIN` as a WARN for a declared/default plain ground with a
border that is not mostly one colour. Create adds no border measurement.

## Applied review feedback

Each create-built version declares `review_origin` as null for a build made
without feedback, or as one retained applied-round record described in
PROJECT.md. `interview --check` compares the feedback file SHA-256, the source
version's frozen review inputs and compiled model, and the selected feedback
item's complete non-null `context.applied`. The containing version closes the
chain and its source is the immediately preceding version of the same kind.

| Finding | Fires when |
| --- | --- |
| `APPLIED_REVIEW_MISSING` | a version dated on or after `APPLIED_REVIEW_SINCE` omits the origin declaration |
| `APPLIED_REVIEW_MALFORMED` | the declaration lacks its file path/hash, source, item id or applied result |
| `APPLIED_REVIEW_FILE` | the retained file is unavailable, escapes the project or is not a single-build feedback export |
| `APPLIED_REVIEW_SOURCE` | the source is missing, ambiguous or skipped, or the feedback inputs differ from its package |
| `APPLIED_REVIEW_RESULT` | the selected feedback item is missing or repeated, or its applied result differs |

`APPLIED_REVIEW_LEGACY` is a warning for an omitted declaration dated before
`APPLIED_REVIEW_SINCE = 2026-11-06T00:00:00Z`, or with no readable date.
Pre-interview versions are exempt. Explicit null declarations remain legal.

### Setup-painting declaration

Every project is held to this declaration when a version names a readable
`provenance.config.path`. The recorded config hash is verified when present.
A pre-interview version or a version without a config path is exempt. An
unread config is reported by provenance, not here. Config-relative
`requirements` paths use the existing CG reader and project-path boundary.

| Code | Meaning |
| --- | --- |
| `SETUP_PAINTING_REQUIREMENTS_MISSING` | A readable config names no requirements file, or its named file cannot be read. Write `requirements` in the config and retain the readable checks file at that config-relative path. |
| `SETUP_PAINTING_REQUIRED_MISSING` | The named requirements file lacks `setup_painting.required: true`. Write the declaration there. |
| `SETUP_PAINTING_LEGACY` | WARN only for either missing declaration on a version before `SETUP_PAINTING_SINCE = 2026-11-06T00:00:00Z`, or with no readable date. The message names the missing field and its contemporary refusal code. |

An absent or unread requirements file already refused by `CG_GATE_UNDECLARED`
or `CG_GATES_UNREAD` keeps that single CG finding. The setup check adds no
second finding for the same path. Parts owns limit validation and measurement.
Limits come from parts' own `pixel_count` per region on the accepted split
build, recorded with their source as a "no worse than the accepted split" bar.
The filled example retains its historical config references. Synthetic tests
supply readable configs and requirements files without inventing measured limits.

## Busy-ground figure masks

Before a version is packaged, the figure mask has no verdict; packaging and the packaged check bind it.

`FIGURE_MASK_SINCE = 2026-11-06T00:00:00Z` applies to retained visible,
busy configs. Masks come from an external named matte of the original painting
at alpha ≥ 128, minus any foreground plane. Record the model, threshold and
subtraction in `derived add --operation`, repeating `--source` for each input.
Multiple inputs use `sources: [{path, sha256}, …]`; one keeps `source` unchanged.
create binds bytes and source hashes. parts owns PNG decoding, grid and support checks.

Known gap: subtracting the foreground plane also excludes character pixels
covered by that plane in the painting. `SETUP_MATCHES_PAINTING` does not count
pixels outside the mask, so parts that leave those character pixels uncovered
can still pass. A character-plate matte can instead include inpaint fill as
figure. [#113](https://github.com/rig-c/create/issues/113) tracks the upstream
plate-making fix; the default recipe above stays unchanged.

| Code | Condition | Remedy |
|---|---|---|
| `FIGURE_MASK_MISSING` | busy visible retained config lacks a valid requirements figure-mask path and lowercase sha256 | declare `setup_painting.figure_mask` in the config-relative requirements file |
| `FIGURE_MASK_CHANGED` | declared PNG is unreadable or its bytes differ from its declared sha256 | restore the PNG relative to requirements or update the declaration and derived record |
| `FIGURE_MASK_UNRECORDED` | no prepared-input record binds that mask and hash with at least one source and operation | record with `derived add`, naming matte, threshold and foreground subtraction in the operation |
| `FIGURE_MASK_INPUT_UNBOUND` | a present recorded package lacks the requirements or figure mask binding on or after `FIGURE_MASK_INPUTS_SINCE = 2026-11-06T00:00:00Z`, dated by version.at | preserve the package and record a new build with review-package binding both inputs |
| `FIGURE_MASK_INPUTS_LEGACY` | WARN for those missing bindings before FIGURE_MASK_INPUTS_SINCE or with no readable date | preserve history and package both inputs on the next build |
| `FIGURE_MASK_LEGACY` | WARN for these findings on a record before `FIGURE_MASK_SINCE` or without a readable date | preserve the earlier record and declare and record the mask for its next build |


## Split rigging interview and labelled drafts

The explicit `interview.order.spec: "rig-create/stage-order@1"` switch enables
parts-only plan approval followed by a post-parts rigging interview. It is not
a date inference. Existing signatures keep their original scope. Draft inventory
is create-owned artifact identity, not producer provenance or reproducibility.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `STAGE_ORDER_LEGACY` | WARN: order metadata is absent or the old contract is used | preserve historical answers; adopt explicitly with fresh rigging answers after parts review |
| `RIGGING_INTERVIEW_UNSIGNED` | a new-order project reaches or runs production rigging without its human rigging-interview sign-off | leave rig steps pending and sign the later interview plan |
| `RIGGING_INTERVIEW_CONTEXT` | adoption/context lacks its date or current accepted parts and structure binding | retain the reviewed structure and sign the rigging interview |
| `RIG_GUIDE_BEFORE_PARTS` | claimed new rigging answers are undated, earlier than the accepted parts, or later than approval | preserve old answers in history and ask fresh against approved parts |
| `DRAFT_RIG_MALFORMED` | malformed/duplicate draft identity, ambiguous layout, missing standalone parts inputs, or a config-named input `draft-rig` cannot bind because it leaves the project, is not a regular file, or is a directory without a regular-file `receipt.json` declaring the installed parts' `PLATE_RECEIPT_SPEC` (or the installed parts exports none), or a `config_inputs` directory binding does not bind `<directory>/receipt.json` with a string `spec` | retain one labelled output with explicit parts inputs |
| `DRAFT_RIG_STACK` | new draft registration has missing or ambiguous stack candidates beside its parts.json or, for a rig/ directory, in ../render/ | re-run `rig-parts build` into the draft output, or keep assemble's `render/` beside `rig/` |
| `DRAFT_RIG_FILE` | a config-named input lacks a config_inputs binding (WARN before CONFIG_INPUTS_SINCE; an absent key before DRAFT_CONFIG_INPUTS_SINCE is `DRAFT_CONFIG_INPUTS_UNRECORDED` instead), a config_inputs binding outside the draft root is missing, changed or leaves the project (a directory input, such as an occluder plate, by its `receipt.json`, whose declared spec must equal the binding's `spec`), or a present draft artifact is unreadable, changed, unexpected or escapes its root | restore its frozen config, parts and output files |
| `DRAFT_CONFIG_INPUTS_UNRECORDED` | WARN: a draft recorded from CONFIG_INPUTS_SINCE and before DRAFT_CONFIG_INPUTS_SINCE has no `config_inputs` key while its sha256-bound config names inputs (by the installed parts' declarations, or by the pinned ones when the install has no `configFileReferences`). An install that could not declare them recorded nothing; `draft-rig` refuses that from DRAFT_CONFIG_INPUTS_SINCE (`DRAFT_PARTS_INSTALL_BEHIND`), and a later absent key refuses `DRAFT_RIG_FILE`. A present key that misses a named input or binds a changed hash refuses `DRAFT_RIG_FILE` on both sides of the date | keep the record; record a new draft with `draft-rig` under a new id to bind the named inputs |
| `DRAFT_PARTS_INSTALL_BEHIND` | `draft-rig`, before it writes: the draft's `rig-run/1` `run.json` names a `@rig-c/parts` release later than the project's install, and the install cannot declare config-named inputs that the pinned parts declares for the draft's config (it has no `configFileReferences`, or declares fewer). The pinned declaration stands in for the producer's, which create cannot load; `project.json` is left byte-identical | install the `@rig-c/parts` version the message names (the draft's producer) in the project, then record the draft again |
| `DRAFT_DECLARED_FILE_UNBOUND` | WARN at any date: a present file that the draft's `parts.json` declares under `painting_in_rig` is not bound in `drafts[].parts.files` | rebuild the draft and record it again with `draft-rig`; the old record is kept |
| `DRAFT_RIG_UNAVAILABLE` | WARN: declared regenerable draft artifacts are absent under the ignored draft root | restore the named recorded bytes before inspecting or rebuilding the draft; retained structure snapshots still verify |
| `DRAFT_PRODUCER_ASSUMED` | WARN at any date: no `run.json` is bound in `drafts[].files` beside the draft's `rig.json` (`<out>/run.json` of `rig --out`, `<root>/rig/run.json` in a build root), so `drafts[].producer` is the installed `@rig-c/parts` assumed when `draft-rig` recorded it, not read from the run | rebuild the draft with parts `rig`, which writes `run.json` beside `rig.json`, and record it with `draft-rig`; the old record is kept |
| `DRAFT_PRODUCER_MISMATCH` | WARN at any date: `drafts[].producer` differs from the `package` of the `rig-run/1` `run.json` bound beside the draft's `rig.json`; `draft-rig` records that `package`, so only a record made before it did, or edited by hand, disagrees | record the draft again with `draft-rig` under a new id; the old record is kept |
| `DRAFT_RIG_AS_VERSION` | draft role/identity/reserved paths are offered as a numbered version, review, package or handoff | build an independently authorised production rig |
| `STRUCTURE_DECISIONS_MISSING` | new-order parts approval lacks its draft or explicit structure snapshot | supply --draft and --structure-file, including entries:[] when unchanged |
| `STRUCTURE_DECISIONS_INVALID` | snapshot schema/declarations/config binding are malformed or changed | retain the exact human-approved structure file |
| `STRUCTURE_DECISIONS_CONFLICT` | a snapshot or retained production config contradicts the approved mesh/chest declaration | obtain renewed human approval instead of overriding the structure |
| `PARTS_VERDICT_DRAFT_MISMATCH` | a parts-review sign-off's verdict `source.files[]` lists a file whose sha256 is in neither its `draft_id` draft's `parts.files[]` nor its `files[]` (the outputs a parts view that shows meshes also lists: `rig.json`, `mesh_report.json`, mesh rasters), or leaves out one of the draft's `parts.files[]`, matched as sha256 multisets and leaving out only the raster the draft's `parts.json` declares under `painting_in_rig`; an output the verdict does not list is not missing; the message lists up to three unmatched files on each side. `signoff parts-review --draft` and `structure-snapshot` refuse it; the check refuses a sign-off dated from `PARTS_VERDICT_DRAFT_SINCE = 2026-11-08T00:00:00Z` or without a readable date and WARNs an earlier one | review the named draft's parts in rig-review's parts view and sign with that verdict, or name the draft the verdict reviewed; preserve an earlier record |
| `DRAFT_RIG_USAGE` | missing, repeated or unsupported recorder arguments (exit 2) | use draft-rig <id> [dir] --config <path> --from <dir> [--parts <dir>] |
| `STRUCTURE_SNAPSHOT_USAGE` | `structure-snapshot` misses `--draft`, `--verdict` or `--out`, repeats one, takes an unsupported flag or more than one folder (exit 2) | use structure-snapshot [dir] --draft <id> --verdict <path> --out <path> |
| `STRUCTURE_SNAPSHOT_DRAFT_UNKNOWN` | `drafts[<id>]`: no recorded draft has the `--draft` id | record the reviewed draft with `draft-rig`, then name its id |
| `STRUCTURE_SNAPSHOT_CONFIG_CHANGED` | `drafts[i].config` is absent, unreadable, escapes the project or no longer hashes to its recorded sha256 | restore the recorded config bytes, or record the changed config as a new draft and review it |
| `STRUCTURE_SNAPSHOT_OUT_INVALID` | `--out` is absolute or not a literal POSIX path, leads out of the project through a link, sits under a file, or names an existing entry that is not a regular file | name a new file under the project, for example `evidence/structure-decisions.json` |
| `STRUCTURE_SNAPSHOT_OUT_IGNORED` | `--out`, as written or with links followed, is under an ignored root | write the snapshot outside ignored roots, for example `evidence/` |
| `STRUCTURE_SNAPSHOT_OUT_EXISTS` | `--out` already holds bytes other than the snapshot (the same bytes are a no-op success) | name a new file; a retained snapshot is never overwritten |

Each refusal names the record path and writes nothing in the corresponding writer.
The existing plan, checkpoint, parts-verdict and diff-map codes remain active.
`structure-snapshot` also refuses with the `PARTS_VERDICT_*` codes of the verdict
it reads, and with `STRUCTURE_DECISIONS_INVALID` or `STRUCTURE_DECISIONS_CONFLICT`
when its candidate fails the snapshot rules (a draft config whose `meshes` is not
an object, or a part name that is not a valid pointer segment).


Missing ignored draft files are unavailable, not altered files. Existing files
still verify even when another artifact is missing. A parts-review structure
snapshot must be retained outside ignored roots (`evidence/`, for example);
the writer refuses ignored paths and aliases into them. On a clone its retained
snapshot is still hash/schema checked without requiring the regenerable config.
Production declarations are compared to the latest structure approval live at
their own build date, applying only reopens at or before that date. A later
reopen/approval never rewrites an earlier version's obligations. Delegated
framing uses the same central interview membership as source guides, so it
must be decided before the first plan approval or parts execution.

## Per-ask questionnaire choices

`CHOICE_ANSWERS_SINCE = 2026-11-06T00:00:00Z` labels legacy warnings; only
explicit stage-order@2 adoption activates the new-answer contract. Earlier
answers remain unchanged. See INTERVIEW.md for the frozen shapes and writers.

| Code | Trigger | Remedy |
| --- | --- | --- |
| `INTERVIEW_OPTIONS_USAGE` | malformed writer flags or unreadable CLI argument files (exit 2) | supply documented question, file and per-ask arguments |
| `INTERVIEW_OPTIONS_INVALID` | malformed set, recommendation/cardinality/ask/fragment/assembly/constraint schema | draft a complete set using the closed schema and applicable asks |
| `INTERVIEW_OPTIONS_FILE` | missing, changed, nonretained, escaping, symlinked or nonregular option file, reused id/path | restore original bytes and retain a new id/path for redrafts |
| `INTERVIEW_OPTIONS_STALE` | changed displayed sha, source/parts/structure/rig/scene context, relevant reopen, unavailable fresh viewed bytes; from `SCENE_CONTEXT_SINCE` a scene-kind set on a scene that is not current | refresh and redraft against the live accepted context |
| `INTERVIEW_CHOICE_REQUIRED` | newly answered adopted question lacks a choice, or Other is still pending at approval | explicitly pick each ask; resolve Other through a new tailored option and pick |
| `INTERVIEW_CHOICE_INVALID` | malformed picks payload, shown/value/coverage/verbatim drift, clock/identity/decision mismatch or changed still-approved answer | retain the shown snapshot and record exact human picks; reopen before changing approval |
| `INTERVIEW_CHOICE_CONSTRAINT` | disallowed tuple or constrained Other/auto fragment has zero or multiple value-option matches | choose an allowed combination or redraft the set to offer that option |
| `CHOICE_ANSWERS_LEGACY` | WARN: no explicit choice adoption, or grandfathered current sentence/inherited answer | preserve source words/date; adopt explicitly and show a tailored option when asked again |
| `INTERVIEW_OPTIONS_SCENE_LEGACY` | WARN: a scene-kind set drafted before `SCENE_CONTEXT_SINCE = 2026-11-08T00:00:00Z` holds only under that day's rule, because its scene was not current (PROJECT.md "Scene option context"); one per pending set or answer path | preserve the record; redraft against the current context when the question is asked again |

### Member overrides in `interview-answer`

`interview-answer` validates an override before writing. Supply a readable,
nonblank UTF-8 `--why-file` with either pick flags or `--picks-file`; the
payload schema is unchanged. Every fresh override replacement needs a fresh
reason. A legacy answer missing `overrides` derives its reference from the
most recent inherited record in `history[]`; an existing reference is
preserved. If the inherited answer now classifies as silent (`null` or a
user's `"per-member"`), the writer records `basis: "own"` without an override
or required reason. Shared delegations remain classified as delegated.

| Code | Trigger | Remedy |
| --- | --- | --- |
| `OVERRIDE_COLLECTION_INVALID` | an overridden answer's `overrides.collection` does not name its parent collection, or the collection cannot be read | restore the parent collection and reference its name |
| `OVERRIDE_QUESTION_INVALID` | `overrides.question` names no collection question with an answered current/history record | reference an answered collection question and retain its original answer in history |
| `OVERRIDE_ANSWER_STALE` | `collection_answer_at` is not the exact readable `at` of a current or historical answer to that question | restore the referenced collection answer and timestamp, or ask and record a fresh override |
| `OVERRIDE_REASON_MISSING` | `why_verbatim` is missing, non-string or blank; a writer lacks a readable nonblank UTF-8 `--why-file` | ask why this member differs and supply the exact user text with `interview-answer --why-file` for every fresh override |

## Correction paths

`CONFIG_INPUTS_SINCE = 2026-11-06T00:00:00Z` dates missing config-input bindings by `draft.at`, correction handoff omissions by `correction.at`, and applied-review omissions by the resulting version's `at`. Earlier omissions WARN with the same code. Honest named inputs are accepted in every era, and altered hashes always refuse. A missing frozen-package input binding uses the source version's `at`, with `REVIEW_PACKAGE_INPUT_MISSING` for package checks and the existing correction/applied-review code in those readers. An unavailable `configFileReferences` export names the installed parts version in a legacy WARN or a current named-input refusal. `DRAFT_CONFIG_INPUTS_SINCE = 2026-11-09T00:00:00Z` dates, by `draft.at`, a draft with no `config_inputs` key on a config that names inputs: earlier it WARNs `DRAFT_CONFIG_INPUTS_UNRECORDED`, from that date it refuses `DRAFT_RIG_FILE`. Configs naming no files keep their existing checks. Preserve historical bytes and include every config-named input and its raw sha256 in the next draft or handoff.

`corrections_contract.schema = "rig-create/corrections@1"` is explicitly adopted
with `correction --adopt`; it is independent of `interview.order` and dates do
not activate it. Existing records are preserved. Missing adoption warns once,
including on the frozen legacy example. All present records are validated.
Create hashes retained bytes and reads producer reports; it never replays a
patch, computes a producer check/diff, or launches an Apply.

| Finding | Frozen bar list |
| --- | --- |
| `CORRECTION_USAGE` | invalid command arity, unknown/duplicate/conflicting flags or missing values |
| `CORRECTION_CONTRACT_INVALID` | malformed/unknown explicit adoption, or mutation before adoption |
| `CORRECTION_MALFORMED` | invalid closed record/union/human time fields, duplicate id or invalid replacement reference |
| `CORRECTION_FILE` | unavailable/nonregular/symlink/escaping required retained file, or invalid retained JSON |
| `CORRECTION_HASH` | raw retained bytes differ from their recorded SHA-256 |
| `CORRECTION_SOURCE` | unknown/ambiguous/stale source, stage/kind/config/handoff mismatch, or mutation under a live approval |
| `CORRECTION_PATCH_INVALID` | config-patch/1 grammar, keys, flags or pointer syntax invalid; no operation is replayed |
| `CORRECTION_APPLIED_INVALID` | a config-named input is missing from the handoff (WARN before CONFIG_INPUTS_SINCE) or has an altered hash, a draft handoff path (read relative to the feedback package) or the package itself resolves outside the project or is retained absolute, a draft `--feedback-file` is a directory named `.json` or a manifest file without that suffix, session/item/applied identity or embedded patch differs, optional `stageInputHash` is not a 64-lowercase-hex SHA-256, or a claimed checked result lacks its passing retained summary, has a FAIL/unknown named bar or no PASS bar, or marks a line-named skipped bar PASS |
| `CORRECTION_OUTCOME` | outcome is invalid/nonlater/unchanged, closure bytes are missing, model differs from Apply, origin differs, or closure is repeated |
| `CORRECTION_PART_IMAGE_BEFORE` | `part-image` artifact does not name a `parts-review` parent draft's bound `<parts.path>/parts/<part>.png`, `artifact.draft` disagrees with `on.id`, or `after` has no pixel changes from `before` |
| `CORRECTION_PART_IMAGE_MASK_SIZE` | `part-image` `before`, `after` or `mask` is not a readable PNG or `mask`/`after` dimensions differ from `before` |
| `CORRECTION_PART_IMAGE_OUTSIDE_MASK` | `part-image` `after` differs from `before` outside `mask` |
| `CORRECTION_PART_IMAGE_ADDED_ALPHA` | `part-image` `after` increases alpha (`afterA > beforeA`) at any pixel |
| `DRAFT_PART_REPAINT_UNRECORDED` | a draft's bound `parts/<part>.png` matches a `part-image` correction's `after.sha256` whose correction is withdrawn, superseded, dated after the draft, or on another part/draft |
| `CORRECTION_UNSUPPORTED_OUTCOME` | a named unsupported operation attempts supported completion |
| `CORRECTION_PENDING` | attempted scoped approval/handoff relies on an unresolved active correction |
| `CORRECTION_PATH_LEGACY` | WARN once when explicit corrections adoption is absent |
| `DESCRIBED_DIRECTION_REQUIRED` | a described correction on a post with authored direction uses @1 on or after `DESCRIBED_DIRECTION_SINCE = 2026-11-06T00:00:00Z`. Preserve the evidence and capture a new correction@2 request with the exact direction identity |
| `DESCRIBED_DIRECTION_LEGACY` | WARN for the same @1 authored-direction description before DESCRIBED_DIRECTION_SINCE, dated by correction.at. Preserve history and use correction@2 for the next request |
| `CORRECTION_OPEN` | WARN per active described-open or made preview/pending record |
| `CORRECTION_UNSUPPORTED` | WARN per active unsupported made operation; not duplicated as OPEN |

The remedy is to retain the original evidence, select its exact source/outcome,
resolve the correction, or reopen its review before changing approved work.
Unsupported operations remain pending until a separately contracted adapter
exists. Historical superseded corrections remain validated but do not impose
current approval obligations. Existing structure, provenance, feedback and CG
findings retain their existing ownership and meaning.

## Authored camera direction

Explicit `direction_contract` adoption and `rig-create/direction@1` documents
add no legacy warnings and no date switch. Grandfathered post numbers are
captured at adoption, not inferred from dates. All explicit document bindings
are checked, including historical ones. The producer never renders a take or
recomputes another producer's measurement. PROJECT.md, *Authored camera
direction*, defines the closed schema, immutable paths and read contract.

| Code | Frozen refusal bar | Remedy |
| --- | --- | --- |
| `DIRECTION_USAGE` | invalid action, argument count, duplicate/conflicting flags or nonpositive post number | use direction's action-specific flags |
| `DIRECTION_CONTRACT_INVALID` | missing adoption on authoring, malformed schema/clock/grandfather list, or invalid grandfathered identity | adopt explicitly and preserve the captured inventory |
| `DIRECTION_DOCUMENT_REQUIRED` | an adopted, non-grandfathered post lacks `provenance.direction` | produce the retained direction document |
| `DIRECTION_SCHEMA` | malformed JSON, missing/unknown fields, invalid types/counts/easing/box/duration or nonfinite numbers | use the closed direction@1 shape |
| `DIRECTION_FILE` | retained file is missing, ignored, nonregular, a symlink, escaping or not a literal POSIX relative path | retain the exact regular file in the project |
| `DIRECTION_HASH` | document/model raw bytes differ from the declared SHA256 | restore the bound bytes or author a new version |
| `DIRECTION_RIG_UNKNOWN` | rig number/model hash/path does not resolve to the accepted version's compiled review-package model, or --rig disagrees | bind the exact retained accepted model |
| `DIRECTION_RIG_STALE` | document and post rig differ, current rig is superseded/unaccepted, or packaging would rebind a cited model | accept a new rig and author new direction on it |
| `DIRECTION_KEY_OUTSIDE_TAKE` | a key is outside `[0,duration]`, the first time is not zero, or timing does not end at duration | bound keys and supply endpoints |
| `DIRECTION_TIME_NON_MONOTONIC` | duplicate/decreasing take times or decreasing source time | strictly order take times and use nondecreasing source seconds |
| `DIRECTION_CITATION` | camera/timing citations, resolved selections or live approved step hashes do not match the retained request | preserve words and complete/reapprove the named answers/steps |
| `DIRECTION_VERSION` | post identity/number/path/config/output binding conflicts or is not uniquely later for authoring/current for acceptance | create a later uniquely numbered post and bind its document |
| `DIRECTION_REVIEW_CLOSED` | authoring attempts to change still-live approved direction review | explicitly reopen before writing |
| `DIRECTION_SOURCE_CHANGED` | lock held, immutable destination exists, or any captured source differs before project commit | preserve published bytes and retry against frozen inputs |
| `DIRECTION_PATCH` | wrong patch schema/base/allowed replacement fields, absent replacements or semantic no-op | export whole changed camera/timing/take sections on the exact current base |
| `DIRECTION_CORRECTION_OUTCOME` | a correction@2 source/outcome differs from the exact direction post identity, or a made direction closure lacks matching patch/base/result and the same rig | retain the exact compiled model and direction bindings, and resolve a made patch only to its create-ingested result |

Each message names the record path and a remedy. Code assertions accompany
negative controls; failed writer/transaction tests also assert unchanged record
bytes. Existing handoff, correction and provenance codes keep their meaning.

`rig-create/correction@2` covers authored-direction descriptions and the
`direction-patch` artifact. Its post identities add `direction:{path,sha256}`
to `{kind:"post",n,config,model}`, binding the source rig's compiled model.
A described artifact remains `{kind:"description"}` with unchanged human words.
Its outcome is a later post with a different bound direction document hash,
checked with the same exact direction identity validator as its source.
This includes a later accepted rig because direction@1 embeds `rig.model`.
The agent's closure reasoning carries the semantic claim that the request
was met. An optional
`--model-file` must name the bound compiled model, never the direction JSON.

The made artifact remains
`{kind,patch:{path,sha256},state,result:null|{path,sha256}}`, with state
`preview/pending` or `applied-and-checked`. Its exact create-owned
`direction_origin` and typed patch result are checked, and it requires the
same compiled rig model. A preview, same-document result, cross-kind result,
changed rig or `rig-review-applied/2` report cannot close a made patch.

Existing @1 descriptions of authored direction are WARNed before
`DESCRIBED_DIRECTION_SINCE` and refused from that date. Posts without authored
`provenance.direction`, rig/draft/parts identities, unsupported operations and
config-patch behavior keep their existing @1 contracts and fixture bytes.

### Advisory intake

None of these warnings refuses an approval; absent intake adds no warning.
Writer rejection with the same code means invalid recording input, before
any write, not a screening decision about the painting.

| Code | Record path and remedy |
| --- | --- |
| `INTAKE_HEAD_CROP_RISK` | `intake.reports`: reported native alpha > 8 before ghost cleanup crosses a non-bottom head-box edge; shows raw per-tag/side counts, with bottom separate. Show the optional report-bound parts choice; do not refuse approval. |
| `INTAKE_REPORT_INVALID` | `intake.reports`: missing/changed raw bytes, unsupported spec, invalid binding/shape, copied fields or prediction; restore the retained report first, then append a corrected `intake-report` entry if needed. Also names invalid `intake`/`intake-report` CLI input; rejected writes leave project bytes identical. |
| `INTAKE_CHOICE_PENDING` | `intake.choice`: only in `parts`, a HIT with no resolved choice bound to that report; adopt choices with `interview-options --adopt` first when not adopted, then record the person's explicit choice or finish their explicit delegation through the interview writers. Advisory, including Other pending. |
| `INTAKE_CHOICE_INVALID` | `intake.choice`: malformed/stale local choice or shown set; retain and re-show report-bound options through the interview writers. Never an approval refusal. |

## Generator CLI arguments

| Code | Meaning and remedy |
| --- | --- |
| `GENERATOR_ARGS_INVALID` | The named generator refuses the displayed argument (a destination starting with `-`, a missing destination, or any flag but `--check`) before writing its destination. Supply the destination shown in its unchanged usage line and only the optional `--check` flag. |

### Review sign-off targets

From `SIGNOFF_TARGET_SINCE = 2026-11-06T00:00:00Z`, every rig-review and
direction-review signature binds an accepted verdict and its version's reviewed inputs.

| Code | Meaning | Remedy |
| --- | --- | --- |
| `SIGNOFF_TARGET_MISSING` | A current-era review signature has no target | Preserve the reviewed inputs and sign again with `--version` |
| `SIGNOFF_TARGET_STALE` | The version, operative human accepted verdict, package inventory, imported outputs or direction binding no longer resolves, or writer selection is ambiguous | Restore the reviewed inputs and select the accepted version with `--version` |
| `SIGNOFF_TARGET_MISSING_LEGACY` | A pre-contract signature has no target | Preserve history and bind the next review signature |
| `SIGNOFF_TARGET_STALE_LEGACY` | A pre-contract signature's target no longer resolves | Preserve history and bind the next review signature |

## Answer revision approvals

`SIGNOFF_ANSWERS_SINCE = 2026-11-06T00:00:00Z` dates missing bindings by the live signature's `at`.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `SIGNOFF_ANSWERS_UNANSWERED` | The writer's covered `rests_on` item is absent, unanswered or unresolved | Answer the named item before signing |
| `SIGNOFF_ANSWERS_MISSING` | A current-era live approval has no answer hash map or omits an expected item | Sign the named stage again |
| `SIGNOFF_ANSWERS_MISSING_LEGACY` | A pre-contract live approval lacks a complete answer hash map | Preserve history and bind the next approval |
| `SIGNOFF_ANSWERS_STALE` | A live approval's bound item is missing, unresolved or its answer revision differs | Restore the intended answer and sign its stage again |

## Forward stage and step progress

`STAGE_PROGRESS_SINCE = 2026-11-08T00:00:00Z` dates stage lag and skip by
the latest live signature at the furthest signed stage. Older readable
signature dates WARN with the same code. Unreadable frontier dates refuse.
A stage that differs from its latest recorded move is a separate
`STAGE_SKIPPED`, dated by when that unrecorded move could have happened: the
later of the latest recorded move and the latest live signature at the
furthest stage before the current one. It refuses from `STAGE_PROGRESS_SINCE`
and WARNs before it, so a later sign-off does not turn an older hand move into
a refusal; with no such date, or an unreadable one, it refuses. Re-signing an earlier plan does not
revoke later approvals. Stage/checkpoint history invalidated by reopen or
amendment grants no authority. A completed bar permits its next review.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `STAGE_LAGGING` | stage precedes the stage authorized by the live closing signature | run advance for the next authorized stage |
| `STAGE_SKIPPED` | stage exceeds the signature frontier and completed bar exits, differs from its latest advance/reopen, or has no move from the initial stage | reopen the unfinished stage, finish its work and use advance |
| `STAGE_SIGNOFF_DATE_INVALID` | the live frontier approval has an unreadable date | restore its original readable date before advancing |
| `ADVANCE_UNAUTHORIZED` | advance has no live stage-level human approval, or the latest one is at a stage before the one that owns the move (the current stage, or the last signed stage before a bar stage) | record `signoff <stage>` for the stage the message names before advancing |
| `ADVANCE_WORDS_REMOVED` | advance receives `--by` or `--verbatim-file` (exit 2). The move's authority is the live stage sign-off it records in `signoff`, so advance takes no mover or words of its own | record the person's approval with `signoff <stage>` (from the review tool, `signoff <stage> --from-review <actId>`) and run advance without those flags |
| `ADVANCE_MALFORMED` | advances history lacks the human move, adjacent target, a string `by` and `verbatim` pair when an older entry carries either one (a human `by`, never `agent`; current advances carry neither), boolean event-time post_not_passed snapshot, required steps_before phases and completed bars, or matching event-time live authorizing signoff | retain the original move and matching `{stage,checkpoint,at}` signature through advance |
| `PROGRESS_OPTION_INVALID` | advance, step-status, pause or resume arguments are missing, repeated or malformed, a step-status note is unreadable, empty, invalid UTF-8, over 1,000 bytes, contains controls other than newline, or has an incomplete or mismatched note/hash pair, or advance's `--parts-check` and `--parts` are not given together or are given on a move other than `parts` → `parts-review` | supply the target (advance) or step/status and --by once (step-status), a valid --note-file with its matching retained note_sha256 when used, and both parts-check flags only on that move |
| `STEP_STATUS_TRANSITION` | step-status skips or reverses the status sequence, runs outside its execution stage (on an amended project, outside both the retained stage and the effective stage the work resumes at), or history lacks its boolean event-time checkpoint_required snapshot or is malformed | advance to the execution stage, or on an amended project re-sign the lapsed approvals and finish the earlier bars, and use pending, in-progress, at-checkpoint, done in order; the step-status refusal names the next status to record, or `reopen` after done |
| `STEP_STATUS_SIGNOFF` | retained status history has a missing or mismatched checkpoint signature reference | retain its matching human checkpoint signoff and record done through step-status |
| `STAGE_MOVE_UNLINKED` | an advance or reopen's `from_stage` is not the stage the previous recorded move (by time) left, starting from `interview` (`paused` links to either side), or an `advances[]` entry is dated before an earlier one | preserve the history; record each later move through advance or reopen |
| `STEP_STATUS_UNLINKED` | a `status_history[]` entry's `from_status` is not the previous entry's `status` (`pending` for the first, or after a reopen or amendment that reset the step), an entry is dated before the one before it, or the step's `status` is not the last recorded status | preserve the history; record transitions through step-status (a reopen copies a hand-set status into `steps_before`, where `REOPEN_STEP_UNLINKED` reports it) |
| `REOPEN_STEP_UNLINKED` | a `reopens[]` entry's `steps_before[]` status (`pending` when omitted) is not the status the step's `status_history[]` chain held at the reopen's `at`; steps with no history entry dated before the reopen, a malformed entry or reordered entries are not judged, and an entry tied with the reopen may fall on either side | restore the status the reopen recorded; before reopening, return a hand-set status to its last recorded one and record moves through step-status |

`PROGRESS_HISTORY_SINCE = 2026-11-08T00:00:00Z` dates each link break by the
latest recorded event the unrecorded move must follow: the previous move or
status entry, a reopen or amendment that reset the step, the advance into the
step's execution stage, and for a stage move the latest stage-level signature
at the furthest stage before its `from_stage`. A `steps_before` mismatch is
dated by those events up to the reopen, not by the reopen itself, because the
reopen writer copies the current, possibly hand-set status. A reordered entry is dated by the
later of the two entries. Breaks dated from the cutoff refuse; earlier ones,
and breaks with no preceding dated event, WARN with the same code. A later
writer entry therefore does not turn an older hand move into a refusal. A
reset tied in time with an entry may fall on either side of it. The latest
move must still equal `stage` (`STAGE_SKIPPED`).

`CHECKPOINT_UNSIGNED` also refuses a step-status done without its live human
checkpoint approval. A new advance refuses lag and skip even for legacy signatures. Both progress writers reconcile stage_values, validate
with checkProject and preserve bytes on refusal. The signature writer allows
its own pending-advance lag until advance records the separate stage move.
Arrival at rigging-interview or post-interview admits only INTERVIEW_INCOMPLETE
for that target's silent items by code/path counts. The check still reports them,
and signoff or departure requires the answers.
Signoff retains its existing conditional/scoped candidate validation. Its
additional progress guard blocks pre-existing refusal-level lag, permits
legacy WARN lag, and rejects other candidate progress refusals.

History reads `status_history[].checkpoint_required` and
`advances[].post_not_passed` from their event snapshots. Current checkpoint
changes and post applicability changes after reopen preserve the original
authorization. Missing or non-boolean snapshots are malformed. Current done
writes still require a live human checkpoint signature, and current stage
checks still use current post applicability.

### Parts-stage check at the parts → parts-review move

The move from `parts` to `parts-review` binds the report of `rig-parts
check-parts`, spec `rig-parts-parts-check/1` (`@rig-c/parts`
docs/STABILITY.md § Parts-stage integrity report). `advance parts-review
--parts-check <report> --parts <assembled dir>` takes both paths
project-relative; the report is retained the way the parts verdict is, and the
assembled root is the one the report was run on. The entry gains a closed
`parts_check { path, sha256, spec, parts, exit_code, holes, reported }`:
`sha256` binds the report bytes, and `exit_code`, `holes` and `reported` are
copied from the report, never computed. At the write the check refuses a
missing, unreadable or malformed report, a non-zero `exit_code`, a non-empty
`refusals`, and a stale report: an `inputs` row read with a sha256 the file
under `--parts` no longer has, a `missing` or `unreadable` row, an `absent`
row whose file now exists, or a file under the root that no row names. Later
checks keep the shape and the retained bytes; parts change on purpose after
the move, so staleness is judged only at it. Each HOLE row is printed as its
own named line in the `advance` output and stored on the entry; a HOLE neither
passes nor blocks. `reported` rows are printed and stored, never refused.
`PARTS_CHECK_SINCE = 2026-11-08T00:00:00Z` dates a missing report by the
advance's `at`: from the date it refuses, earlier it WARNs. The move being
written always needs the report.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `PARTS_CHECK_MISSING` | a `parts` → `parts-review` advance has no `advances[].parts_check`: refused on the move being written and from `PARTS_CHECK_SINCE`, a WARN before it | run `rig-parts check-parts --parts <assembled dir> --out <dir>`, retain `parts-check.json` under the project and advance with `--parts-check` and `--parts`; preserve an earlier move |
| `PARTS_CHECK_UNREAD` | `advances[].parts_check.path` is not a literal project-relative path, leaves the project (also through a link), is written under an ignored root, is not a regular file, or is not a JSON object | retain the producer's report under the project, for example in `evidence/`, and advance with it |
| `PARTS_CHECK_INVALID` | `advances[].parts_check` is not the closed object, its `parts` root is not a literal project-relative path, the report's spec, stage, key order or rows are not `rig-parts-parts-check/1`, the copied `spec`, `exit_code`, `holes` or `reported` differ from the report, or the object is on a move other than `parts` → `parts-review` | record the report through advance |
| `PARTS_CHECK_CHANGED` | the retained report no longer hashes to `advances[].parts_check.sha256` | restore the retained report bytes; a new check is recorded by a new move |
| `PARTS_CHECK_FAILED` | the bound report records a non-zero `exit_code` or any `refusals` row | fix the refused parts, rerun `rig-parts check-parts` and advance with the passing report |
| `PARTS_CHECK_STALE` | at the move, the report's `inputs` do not match the files under `advances[].parts_check.parts` | rerun `rig-parts check-parts` on the parts as they are now and advance with that report |

### Pausing and resuming

`pause` and `resume` append `pauses[]` and set `stage` ([PROJECT.md §
Pausing and resuming](PROJECT.md#pausing-and-resuming)). The history is not
read as an advance or reopen, so `STAGE_MOVE_UNLINKED` and the latest-move
`STAGE_SKIPPED` read the same records as before it existed. `pauses[]` is new,
so its shape check refuses no earlier record and has no contract date.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `PAUSE_ALREADY_PAUSED` | pause runs on a project whose stage is already `paused` | resume it, or reopen a passed stage |
| `PAUSE_STAGE_INVALID` | pause runs on `accepted` or on a stage outside the order | pause only work in progress |
| `RESUME_NOT_PAUSED` | resume runs on a project whose stage is not `paused` | nothing to resume; use advance or reopen |
| `RESUME_STAGE_MISMATCH` | resume names a stage other than the one the project was paused from (its latest pause's `from_stage`, or for a hand pause the stage its latest recorded move reached) | resume that stage, then advance or reopen from there |
| `PAUSE_MALFORMED` | `pauses` is not a list, or an entry lacks string `stage`, `from_stage`, `verbatim`, a human `by`, a readable `at` or a text `source`, is dated before the entry before it, neither enters `paused` from a stage before `accepted` nor leaves it for a stage in the order, or a pause's `signoff` is not the identity of a human paused sign-off dated at or before it | preserve the history; record pauses through pause and resume |

`SIGNOFF_NOT_HUMAN` refuses either writer run `--by agent`.

## Frozen rig registration

`rig-version` records explicitly declared toolchain, producer run-record and
dated-source bindings. These codes apply only to the new writer and versions
carrying `registration`. The existing template records carry no such field.
`RUN_RECORD_SINCE = 2026-11-08T00:00:00Z` dates lock-only `frozen-rig/1`
registrations by `registration.at`: before it they WARN under
`RUN_RECORD_REQUIRED`, and from it onward they refuse under the same code.
`interview --check` uses the same registration validator.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `RIG_REGISTRATION_USAGE` | required arguments are absent, repeated or malformed | supply the next version and the inputs shown by rig-version help |
| `RIG_REGISTRATION_BUSY` | another registration holds the project lock | finish that registration before retrying |
| `RIG_REGISTRATION_INVALID` | the version number or registration/source-kind record is malformed | restore the retained record and register the next numbered rig |
| `RIG_REGISTRATION_EXISTS` | a destination already holds frozen files | preserve those files and choose the next unused version |
| `RIG_REGISTRATION_PATH_INVALID` | an input escapes project containment, traverses a symlink or collides with reserved metadata, differing file bytes or an incompatible file/directory target | retain regular project-contained source inputs with literal targets and byte-identical shared files |
| `RIG_REGISTRATION_FILE_INVALID` | an unsupported adapter format, a required input, referenced asset, declared sha256, runtime config/requirements adaptation, producer report/manifest, complete output inventory or copied totals is missing, changed or malformed | restore the exact frozen inputs, retained source documents and producer reports before registration |
| `RIG_REGISTRATION_SOURCE_CHANGED` | source or project bytes change during copying | freeze the inputs and retry against the current project |
| `RIG_TOOLCHAIN_LOCK_INVALID` | the declared lock is absent, unreadable, differs from its hash, has lockfileVersion other than 3 or lacks either package version | retain the original npm v3 lock with both producer package entries |
| `RIG_TOOLCHAIN_MISMATCH` | built_with disagrees with the retained lock's two package versions | restore the declared lock and matching version values |
| `RIG_AT_SOURCE_INVALID` | the cited record/pointer lacks a valid UTC instant, differs from at or is later than registration | explicitly cite a retained dated record's UTC timestamp through --at-source and --at-pointer |
| `RIG_BUILD_BEFORE_REOPEN` | the cited not-after instant is at or before a reopen covering rig-review at registration | register a later frozen build with an explicit retained date citation |
| `RIG_PATH_ADAPTER_INVALID` | the adapter lacks distinct `{at,before,after}` or `{doc,pointer,before,after}` mappings, names an unknown document or non-asset pointer, or disagrees with `config-source.json` / `requirements-source.json` | retain an exact adapter matching the original `config` and `requirements` asset pointers and `before` values |
| `RIG_RUNTIME_PATH_UNRESOLVED` | an absolute config input lacks an exact adapter mapping, or a `requirements` asset path is absolute | retain the recorded runtime mapping and project-relative asset paths |
| `RIG_IDLE_MANIFEST_MISSING` | idle evidence lacks the public render's frames.json | render through public rigc render and supply its output directory |
| `RUN_RECORD_REQUIRED` | a `frozen-rig/1` version has no `registration.runs` (WARN before `RUN_RECORD_SINCE` by `registration.at`, refusal from `RUN_RECORD_SINCE` onward) | retain producer `run.json` records with `--run-record` and register a new rig version |
| `RUN_RECORD_SPEC_UNKNOWN` | a run record or `registration.runs[]` entry names a `spec` other than `rig-run/1` or `rigc-run/1`, or the `run.json` beside a draft's `rig.json` is not `rig-run/1` (`draft-rig` refuses; the check WARNs a recorded draft) | supply a producer `rig-run/1` or `rigc-run/1` `run.json` and register a new rig version |
| `RUN_RECORD_HASH_MISMATCH` | a bound run record is missing, unreadable, absent from `registration.files`, or its bytes differ from its recorded `sha256` | restore the retained run record bytes or register a new rig version |
| `RUN_RECORD_ROLE_INVALID` | a `rigc-run/1` record omits a required input role (`rig` or `motion`), names an unknown role, or sorts roles outside `rig`, `motion`, `manifest`, `cuts` | retain the unedited `rigc-run/1` `run.json` with required `rig` and `motion` inputs |
| `RUN_RECORD_MALFORMED` | a run record has invalid JSON, wrong keys or published key order, invalid package/command/timestamps/paths/hashes, unsorted outputs, or duplicate specs; for the `run.json` beside a draft's `rig.json`, `draft-rig` refuses and the check WARNs a recorded draft | retain at most one unedited producer `run.json` per spec in its published key order |

The date citation declares a completion bound, the npm lock declares the
toolchain, and `registration.runs` binds the producer run stamps (`rig-run/1`
from parts#1165 and `rigc-run/1` from core#1718) by raw SHA-256 and spec.
Acceptance and forward stage moves retain their
existing review/signoff and advance contracts. See
[the registration procedure](PROJECT.md#registering-a-frozen-rig-build).

The recursive runtime portability check preserves RFC 6901 JSON pointers at
requirements `x-source.json_pointer` metadata positions, including valid `~0`
and `~1` escapes. Parts treats these extensions as opaque metadata and declares
no target document to resolve. Absolute values in other fields and malformed
pointer escapes refuse with `RIG_REGISTRATION_FILE_INVALID`, naming the retained
document and field. Declared asset paths retain their existing adapter rules.


## Immutable input registration

`input add <path> [<project dir>] --origin <words>` appends
`{path, sha256, bytes, origin, at}` from raw file bytes. Paths are relative to
the project. The writer and `check` share `checkInputs`. Refused writes retain
identical project bytes. `--json` returns the appended record.

`INPUT_WRITER_SINCE = 2026-11-08T00:00:00Z` dates incomplete metadata by
`inputs[].at`. An earlier, missing or unreadable date preserves the entry with
a WARN. Complete records always validate their retained file bytes. A legacy
WARN preserves history and asks for a fresh file name when recording a new
input. No producer reports are interpreted or regenerated by this command.

| Code | When | Remedy |
| --- | --- | --- |
| `INPUT_USAGE` | input add arguments or origin words are missing, repeated or invalid, or artwork options lack --painting, exit 2 | supply a source path and one non-empty --origin value and --painting for artwork options |
| `INPUT_PAINTING_INVALID` | painting is present but is not the path of a registered input | restore the declaration written by init --painting or input add --painting |
| `INPUT_PAINTING_EXISTS` | input add --painting attempts a second declaration | retain the declared painting and its reason, registering other sources without --painting |
| `INPUTS_INVALID` | inputs is present but is not an array | restore its array of records before registering a source |
| `INPUT_WRITER_MISSING` | writer metadata is incomplete, WARN before INPUT_WRITER_SINCE or without a readable at, refusal from the cutoff | preserve historical bytes and register a new source name through input add |
| `INPUT_PATH_INVALID` | a source is absolute, outside the project, resolves outside it, or names project.json or the writer lock | retain a contained project-relative source file |
| `INPUT_FILE_UNREADABLE` | a source file is missing, unreadable or not a regular file | restore the original retained source |
| `INPUT_PATH_DUPLICATE` | a source path is already registered, including normalized path aliases | keep one record per name and use a new name for changed bytes |
| `INPUT_FILE_CHANGED` | registered raw sha256 or byte count differs from the file, including a re-registration attempt | restore the original bytes and register changed bytes under a new name |
| `INPUT_SOURCE_CHANGED` | the input writer lock is held, or project/source bytes change before commit | freeze the sources, wait for the writer to finish and retry |
| `INPUT_WRITE_FAILED` | staging or atomic publication of the project record fails | restore writable project storage and retry; the original project remains intact |

## Scene composition and direction@2

`scene write` and `check` share `validateScene`. Scene documents and every file
binding use raw-byte SHA-256. Only a `scenes[]` append commits a document.
`DIRECTION_SCENE_SINCE` dates posts requiring direction@2. An earlier @1 post
warns with `DIRECTION_SCENE_REQUIRED`. Explicitly grandfathered posts retain
their existing exemption. A reopen preserves historical scenes and direction
documents. The latest-live rig, live-signoff and scene-currentness tests run for authoring and the scene
cited by the latest live post. With no live post, no scene is current. Every
scene still requires historical human acceptance, its matching package identity
and all schema, raw-byte seal, model, animation, frame, plate and citation checks.

| Code | Refuses when | Remedy |
| --- | --- | --- |
| `SCENE_MALFORMED` | unknown keys at any level, wrong types, schema, n, paths or registration frames | restore the closed scene@1 record and run scene write |
| `SCENE_FILE_CHANGED` | committed document or frames are missing or changed, immutable destination is occupied, or a source changes during writing | restore raw-byte seals and retry scene write on frozen sources |
| `SCENE_RIG_STALE` | rig lacks the cited historical human acceptance, or the current rig is not the latest live accepted rig | accept the current rig and run scene write |
| `SCENE_ACCEPTANCE_STALE` | historical acceptance/package identity differs, or a current signoff has lapsed | restore the accepted package and sign rig-review again |
| `SCENE_MODEL_MISMATCH` | model path or raw-byte hash differs from the accepted package inventory | retain the accepted compiled model and run scene write |
| `SCENE_ANIMATION_MISSING` | animation is absent from the model | select a model naming the animation and run scene write |
| `SCENE_STAGE_MISSING` | compiled model stage is null or absent | compile a model declaring a stage before scene write |
| `SCENE_STAGE_MISMATCH` | frame.stage differs from model.stage | copy the exact compiled stage through scene write |
| `SCENE_PLATE_CONFLICT` | background is absent, roles duplicate, or roles share a path or hash | designate one background and at most one distinct foreground |
| `SCENE_PLATE_CHANGED` | a declared plate is missing or its raw bytes changed | restore the declared PNG and its registration |
| `SCENE_PLATE_DIMENSIONS` | PNG IHDR is invalid or differs from declared dimensions | retain the PNG and derive its IHDR size with scene write |
| `SCENE_PLACEMENT_INVALID` | rect is nonfinite, nonpositive or nonuniform past relative 1e-9 | use a finite positive uniform world-space rect |
| `SCENE_PLATE_UNREGISTERED` | exact input binding or complete prepared-input receipt chain is absent, or an agent scene derived plate lacks a valid producer receipt | register the input or retain every hashed prepared-input hop and bind the producer receipt with derived add --receipt |
| `SCENE_CITATION_MISSING` | post_composition designation is missing or unresolved | cite recorded post_composition asks and quote or decided delegation |
| `SCENE_AUTHOR_TYPED` | scene write supplies a typed `--by` | omit `--by`; authority comes from the current ingested post_composition Review choice |
| `SCENE_CHOICE_MISSING` | agent scene lacks a retained resolved Review choice or decided delegation with an exact scene map | record `value.scene` roles, paths and rects through the post_composition Review choice |
| `SCENE_CHOICE_MISMATCH` | agent scene roles, paths or exact rects differ from the cited choice, or authoring cites a superseded answer | use the current post_composition Review choice and its exact scene map |
| `SCENE_INPUT_RECEIPT_MISSING` | agent scene input candidate lacks matching input-writer metadata | register a new source name with `input add <path> --origin …` and select it through Review |
| `SCENE_LAYER_ORDER` | layer order differs from background, rig, optional foreground | retain the fixed scene layer order |
| `DIRECTION_SCENE_REQUIRED` | post from SINCE lacks direction@2, or earlier @1 post warns | run scene write and author the next post with direction@2 |
| `DIRECTION_SCENE_MISMATCH` | direction rig or model differs from the referenced scene | bind the scene's exact rig version and model |
| `DIRECTION_SCENE_STALE` | current authoring or the latest live post cites a superseded scene | bind the current scenes[] entry in the current direction |

## Registered idle frames in a direction post (create#297)

A rig registered with `rig-version` keeps its idle render under the ignored
`outputs/v<N>/idle/`. `scene write` copies `registration.idle` into
`scene.rig.animation.frames`, and the direction post reads those frames by
binding, not as a retained file: `direction write` and `check` read the path
only when `versions[v<R>]` of the post's rig `R` binds it, with the same path
and sha256 (`registration.idle` for `frames.json`, `outputs` for any other idle
file). No other `outputs/` path is admitted; it still refuses `DIRECTION_FILE`.
Absent frames refuse `DIRECTION_FILE`, as `RIG_REGISTRATION_FILE_INVALID`
refuses absent frozen outputs. Records that passed before keep passing, so no
contract date is added.

| Code | Refuses when | Remedy |
| --- | --- | --- |
| `DIRECTION_IDLE_VERSION` | the scene's frames are under `outputs/v<M>/idle/` and the post's rig is a different version | bind a scene written on the post's rig with `scene write --rig <R>` |
| `DIRECTION_IDLE_UNBOUND` | the frames path and sha256 are not `versions[v<R>].registration.idle` (for `frames.json`) or a `versions[v<R>].outputs` row (for other idle files) | run `scene write` again so the frames equal the registration |
| `DIRECTION_IDLE_HASH` | the frames bytes on disk differ from the bound sha256, including a change during `direction write` | restore the frozen `outputs/v<R>/idle/` bytes, or register a new rig version |

## Pre-interview `config_lost` and `outputs_lost` writers

`rig-create version config-lost <n> --note <text> --source <text> [<dir>]`
records `config_lost: { note, source }` on a migrated pre-interview version
whose build config did not survive, validating the candidate with `checkProject`
before writing. A refused write leaves `project.json` byte-identical.

`rig-create version outputs-lost <n> --note <text> --source <text> [<dir>]`
records `outputs_lost: { note, source, recorded }` on a migrated pre-interview
version whose frozen outputs did not survive, keeping any outputs still readable
with their recorded sha256 in `outputs` and moving only the missing ones into
`outputs_lost.recorded` (`outputs: []` when none survived). `recorded` retains
the dropped `{ path, sha256 }` bindings disjoint from `outputs` so the loss stays
auditable; existing `{ note, source }` declarations beside `outputs: []` without
`recorded` remain valid, so no `*_SINCE` cutoff is added. When no output is lost
(every output is readable with its sha256), the writer refuses with
`OUTPUTS_LOST_HAS_OUTPUTS`. The writer validates with
`inspectPreInterviewOutputs`, `validOutputsLoss` and `checkProject`, and a
refused write leaves `project.json` byte-identical.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `CONFIG_LOST_USAGE` | subcommand, version number or required `--note` / `--source` flags are missing, repeated or malformed (exit 2) | supply `rig-create version config-lost <n> --note <text> --source <text> [<dir>]` |
| `CONFIG_LOST_EMPTY` | `--note` or `--source` is empty or whitespace | supply non-empty `--note` and `--source` strings explaining the loss and naming its source record |
| `CONFIG_LOST_VERSION_UNKNOWN` | `versions[]` has no entry with that `n` | name an existing pre-interview version in `versions[]` |
| `CONFIG_LOST_NOT_PRE_INTERVIEW` | the target version does not carry `pre_interview: true` | record `config_lost` only on a migrated `pre_interview: true` version; keep `provenance.config` on create-built versions |
| `CONFIG_LOST_HAS_CONFIG` | the target version carries a non-null `provenance.config` | retain the surviving build config instead of declaring `config_lost` |
| `CONFIG_LOST_ALREADY_SET` | `config_lost` is already present on the target version | preserve the existing `config_lost` declaration |
| `OUTPUTS_LOST_USAGE` | version number or required `--note` / `--source` flags are missing, repeated or malformed (exit 2) | supply `rig-create version outputs-lost <n> --note <text> --source <text> [<dir>]` |
| `OUTPUTS_LOST_EMPTY` | `--note` or `--source` is empty or whitespace | supply non-empty `--note` and `--source` strings explaining the loss and naming its source record |
| `OUTPUTS_LOST_VERSION_UNKNOWN` | `versions[]` has no entry with that `n` | name an existing pre-interview version in `versions[]` |
| `OUTPUTS_LOST_NOT_PRE_INTERVIEW` | the target version does not carry `pre_interview: true` | record `outputs_lost` only on a migrated `pre_interview: true` version; keep `outputs[]` on create-built versions |
| `OUTPUTS_LOST_HAS_OUTPUTS` | no output is lost on the target version (every recorded output is still readable with its recorded sha256) | keep the surviving outputs instead of declaring `outputs_lost` |
| `OUTPUTS_LOST_ALREADY_SET` | `outputs_lost` is already present on the target version | preserve the existing `outputs_lost` declaration |
| `REVIEW_ACT_STILL_INVALID` | `project.json.review_acts`: the exported still PNG is missing, mismatched or conflicts with retained bytes | fetch the complete original act and PNG pair |

## Review CLI response receipts

| Code | Finding and remedy |
| --- | --- |
| `REVIEW_READ_INVALID` | A correction or applied-review record has no valid CLI receipt, or its stored response differs from the content-addressed stdout binding. Retrieve the result through `rig-review feedback --format json` and retain its receipt in the named record. |
| `REVIEW_READ_LEGACY` | WARN for a correction or applied-review record before `REVIEW_READ_SINCE` that has no CLI response receipt. Preserve history and capture new results through Review feedback. Historical producer-saved session and patch files are never opened. |

### Interview picks through the job API

| Code | Condition | Remedy |
| --- | --- | --- |
| `INTERVIEW_PICKS_FILE_REMOVED` | `interview-answer` receives the removed `--picks-file` flag | fetch the finalized interview act with `interview-answer <question> --from-review <actId>` |

The writer binds retained API act bytes in `project.json.review_acts` by
SHA-256 and validates the selected pending option set before writing. Refusals
preserve `project.json` bytes. Earlier file-route answers remain valid records.

## Model-free record publication

`readRecordPublished` reports `JOB_RECORD_INCOMPLETE` for a changed record,
input or evidence file, a malformed or duplicated declaration, conflicting
file identities, a check refusal or an outstanding publication HOLE. Restore
`project.json` and its retained evidence, resolve the check findings and
reconcile pending publications before publishing again. Every refusal leaves
the record unchanged.

| Code | Finding and remedy |
| --- | --- |
| `JOB_RECORD_SUBJECT_INVALID` | `project.json` does not bind the explicitly requested question, option set and effective stage, including a question whose pick is already recorded and so has no pending set, or a subject id cannot be represented by the record publication contract. Publish the exact current pending subject with its original representable id. |
| `JOB_DIRECTION_VERDICT_REQUIRED` | `job open --plan` at `direction-review` finds no accepted live direction verdict on the current live post in `project.json.versions`. Open the post with `job open --rig <n>` and ingest `review <n> --from-review <actId>` before requesting direction sign-off. This is a publication precondition, not a new record-check rule. |
| `REVIEW_ACT_RECORD_TARGET_INVALID` | A direction record publication or first sign-off ingest cannot resolve one current/latest live post with an accepted live direction verdict from the hash-bound `project.json` bytes (including a duplicated current version number). Review that current post and publish its corrected record through the writers. Historical accepted posts do not create ambiguity. A refused ingest leaves the record byte-identical. |
| `JOB_RECORD_COLLECTION_EXTERNAL` | A collection member's `project.json` has no `collection_binding` (`rig-create/collection-binding@1`), its bound `evidence/collection-binding.json` is missing, unreadable, malformed or traverse-unsafe, its `sha256` or `collection_sha256` mismatches the sealed binding or current `../../collection.json`, its bound member/collection identity or `inherited_answers` do not match the member's `basis: "inherited"` items, or the retained snapshot differs from the sealed collection interview. Run `rig-create collection-binding <member dir>` to write and bind the current collection snapshot before publishing. |
| `JOB_RECORD_CLOSURE_INCOMPLETE` | `project.json` passes its retained seals, but the retained check refuses. The closure holds every file the ask's record check read, so this means the retained root lacks or changed one of them. Structured details retain the check's codes and paths. Restore the complete inventory closure before finalization. |
| `JOB_RECORD_PARTS_LOCK_MISSING` | The `@rig-c/parts` the check loads (the project's install, or in the retained phase the host's) has no `bun.lock` or `package-lock.json` entry with its installed version and an integrity, or two lockfiles disagree. The version alone is never used. Install parts from a lockfile that records its integrity and publish again. |
| `JOB_RECORD_PARTS_MISMATCH` | In the retained phase, the host loads a different `@rig-c/parts` version or integrity than the inventory phase sealed. The message names both versions. Rebuild the project on the host's parts, or run the check where the sealed version is installed. |

In the retained phase, unsafe paths, missing or changed sealed files and
invalid or duplicate file declarations refuse with `JOB_PUBLICATION_INVALID`
before the check runs. In the inventory phase, check refusals produce
`JOB_RECORD_INCOMPLETE`. Neither phase changes the record or its tree.


## Recorded parts verdicts (create#267)

| Code | Meaning and remedy |
| --- | --- |
| `PARTS_VERDICT_FILE_ROUTE_REMOVED` | `signoff --evidence` and `structure-snapshot --verdict` are removed and exit 2 before writing. Query the draft with `parts-review`, then select its receipt with `--draft`. |
| `PARTS_VERDICT_RECEIPT_REQUIRED` | `signoffs[].evidence` has no recorded parts-review API receipt for `draft_id`. Record the response with parts-review before signing. |
| `PARTS_VERDICT_FILE_LEGACY` | A parts-review signature predates `PARTS_VERDICT_RECEIPT_SINCE = 2026-11-08T00:00:00Z` and binds a review-saved file. Preserve the binding. Check WARNs without opening that file. Query the reviewed draft through parts-review before signing again. |

## Fix ledger, ledger reports and restarts (create#285)

`project.json.fix_ledger` holds the owner fixes every version inherits. Each row
is `{ id, note: { ref, verbatim }, at, by, check, bar }`, plus `retired: { at,
by, reason }` once retired. `ledger add` and `ledger retire` write it, and the
writers and check validate rows with the same function. A row's `note.ref`
names `corrections[<id>]` or `versions[v<n>].verdicts[<i>]`, and its words
must be quoted from that note when `ledger add` writes the row. Check does not
re-read an older row's note: a restart retires the record it pointed into, and
the row keeps the words it quoted.

create never runs a ledger check. `draft-rig --ledger-report <file>` binds the
project's own `rig-create/fix-ledger-report@1` report by sha256 and spec. Check
then compares the report's rows with the ledger. It does not recompute a row.
A row is live for a draft when it was written by the draft's `at` and not
retired by then. The predecessor is the previous entry in `drafts[]`; a restart
clears `drafts[]`, so the first draft after a restart has none. `fixes` counts
the live rows the report passes that the `fixes_against` draft did not pass.
That draft is the latest earlier one with a parts-review receipt (any verdict),
else the previous draft. `FIX_LEDGER_SINCE = 2026-11-09T00:00:00Z` dates the
report requirement by `drafts[].at`. `check` lists each bound draft's `fixes`
and known regressions under `ledger`.

| Code | When | Remedy |
| --- | --- | --- |
| `FIX_LEDGER_MISSING` | WARN: the project has drafts and no `fix_ledger` | record each accepted owner fix with `ledger add` |
| `FIX_LEDGER_MALFORMED` | `fix_ledger` is not a list, or a row has an unknown key, a duplicate or invalid id, a future or unreadable `at`, empty `by`, `check` or `bar`, an invalid `note`, or a `retired` without `{ at, by, reason }` dated after the row | restore the row `ledger add` wrote, or retire it with `ledger retire` |
| `FIX_LEDGER_NOTE_UNKNOWN` | `ledger add`: `--note` names no recorded correction or verdict | quote an owner note the record holds |
| `FIX_LEDGER_NOTE_MISMATCH` | `ledger add`: the `--verbatim-file` words are not in the note `--note` names | quote the owner's words verbatim |
| `LEDGER_USAGE` | `ledger` arguments are missing, repeated or unsupported, `--note` is not a record path, or the retire reason is empty (exit 2) | use `ledger add <id> --by --check --bar --note --verbatim-file` or `ledger retire <id> --by --reason-file` |
| `LEDGER_ROW_UNKNOWN` | `ledger retire` names no row | name a row `ledger add` wrote |
| `LEDGER_ROW_RETIRED` | `ledger retire` names a row already retired | keep the retirement |
| `LEDGER_SOURCE_CHANGED` | `project.json` changed while `ledger` was validating | retry against the current record |
| `DRAFT_LEDGER_REPORT_MISSING` | a draft binds no report while the ledger had a live row; a refusal from `FIX_LEDGER_SINCE` or without a readable `at`, a WARN for an earlier draft | run the project's check script on the build and record the draft with `draft-rig --ledger-report <file>` |
| `DRAFT_LEDGER_REPORT_INVALID` | the binding is not `{ path, sha256, spec }`, or the report is not a literal project path, is under an ignored root, leaves the project, is missing, changed, not JSON, has another `schema`, lacks `build.manifest_sha256` or `script_sha256`, or has a row without a unique id and a result of `pass`, `fail` or `unmeasurable` | retain the report the check script wrote under the project (for example `evidence/`) and record the draft with it |
| `DRAFT_LEDGER_BUILD_MISMATCH` | the report's `build.manifest_sha256` is not the sha256 of the draft's bound `parts.json` | run the check script on this draft's build and record the draft with that report |
| `DRAFT_LEDGER_INCOMPLETE` | the report has no row for a live ledger row | run the check script over every non-retired row |
| `DRAFT_LEDGER_REGRESSION` | a live row the predecessor's report passed, or one the predecessor recorded as a known regression (it stays owed), is `fail`, `unmeasurable` or absent here, and `--known-regression` does not name it | fix the build, or record the draft with `--known-regression <row id>=<reason file>` for each row |
| `DRAFT_LEDGER_MALFORMED` | `fixes`, `fixes_against` or `known_regressions` without a report; `known_regressions` is not a list of `{ id, reason }` with unique ids, or names a row the predecessor neither passed nor owed; `fixes_against` is not an earlier draft with a parts-review receipt or the previous draft (`null` only for the first); `fixes` differs from the rows the report passes and that draft did not | record the draft again with `draft-rig` under a new id; the old record is kept |
| `INIT_ARTWORK_EXISTS` | `init --painting` or `input add --painting` declares a file whose sha256 is an input of a project directly under `--projects-root` (default: the new project's parent), without `--same-artwork-reason` | record the redo as a version of that project, or give the reason for a different rig kind |
| `INIT_ARTWORK_USAGE` | an init artwork option without `--painting <file> --origin <words>`, an unreadable painting or root, or a reason that is empty or names no matching project (exit 2) | give `--painting` and `--origin`; drop a reason no project needs |
| `RESTART_USAGE` | `restart` arguments are missing, repeated or unsupported, or the reason file is empty (exit 2) | use `restart [<dir>] --by <human> --reason-file <file>` |
| `RESTART_NOT_A_PROJECT` | the folder has no readable `rig-create/project@0` `project.json` | run restart on a create project folder |
| `RESTART_NOT_IN_GIT` | the project folder is not inside a git work tree, so git history cannot hold the record restart replaces | put the project under git, commit `project.json`, then restart |
| `RESTART_RECORD_UNCOMMITTED` | `project.json` is untracked, staged but never committed, or differs from its version at HEAD | commit `project.json`, then restart |
| `RESTART_INPUT_INVALID` | a kept input fails the input writer's checks, including a legacy record without writer metadata | restore the file, or register it again with `input add` |
| `RESTART_PART_SET_INCOMPLETE` | a kept part set (inputs under `<set>/parts/*.png` or `<set>/parts.json`) lacks `<set>/parts.json`, a part PNG, or its rig: `rig.json` and `mesh_report.json` at `<set>/rig/` or `<set>/` | register the missing files with `input add`, or stop keeping the set |
| `RESTART_MALFORMED` | `restarts` is not a list, or an entry lacks `{ at, by, reason, previous_record_sha256 }` | restore the entry `restart` wrote |
| `RESTART_SOURCE_CHANGED` | `project.json` changed while `restart` was validating | retry against the current record |
| `NEXT_USAGE` | `next` receives an unsupported option or more than one project directory argument (exit 2) | use `rig-create next [<project dir>] [--json]` |

`restart` does not keep the record it replaces; git history holds it, so
restart refuses before it writes unless `project.json` is committed: tracked
and byte-identical to `HEAD:<path>/project.json`, the path resolved from the
repository root (create#304). `restart` by `agent` refuses with `SIGNOFF_NOT_HUMAN`. A refused `ledger`,
`draft-rig` or `restart` write leaves `project.json` byte-identical. A
restarted record carries exactly the refusals a fresh `init` record carries
(its open interview) and no warning; `restart` refuses any other refusal.


## Operator checkpoint withdrawal

| Code | Refuses when | Remedy |
| --- | --- | --- |
| `BAR_AMENDMENT_INVALID` | plan.bar_amendments contains malformed, duplicate, future, hash-mismatched, out-of-order or generation-unbound entries; the entire journal grants no effective bar | Restore the original journal and use plan bar-amend. |
| `BAR_AMENDMENT_SCOPE` | the selected step is finished, lacks an original bar or is outside the current execution stage | Select one unfinished step with a bar in the current execution stage. |
| `BAR_AMENDMENT_CONFLICT` | a retry changes the amendment's operator, reason, exact words or amended bar for the same step hash and generation | Preserve the original entry and replay its original input files. |
| `CHECKPOINT_WITHDRAWAL_INVALID` | plan.checkpoint_withdrawals has malformed, duplicate, future, hash-mismatched or generation-unbound entries | Restore the original journal and use plan checkpoint-withdraw. |
| `CHECKPOINT_WITHDRAWAL_SCOPE` | the selected checkpoint is disabled, finished or outside the current execution stage | Select one enabled unfinished checkpoint in the current execution stage. |
| `CHECKPOINT_WITHDRAWAL_CONFLICT` | a retry changes an existing withdrawal's operator, reason or exact words | Preserve the original entry and replay its original inputs. |

A valid withdrawal removes only the current matching checkpoint requirement.
`CHECKPOINT_UNSIGNED` and step-status use that effective requirement. Historical
status entries keep their original checkpoint_required and signoff requirements.

## Publication generations

| Code | Meaning and remedy |
| --- | --- |
| `PUBLICATION_PAINTING_MISSING` | The republished version has no declared `inputs[0]` original painting; register the original with `input add`. |
| `PUBLICATION_GENERATION_DUPLICATE` | The version already has its requested painting or scene publication; reopen its existing generation with `job open --rig`. |
| `PUBLICATION_GENERATION_INVALID` | The version's optional publication chain has invalid identity, predecessor, timestamp, reason or bytes; restore its immutable generation files and recorded hashes. |

`republish <rig> [<dir>] --reason <words>` upgrades a legacy empty-reference
publication once, to `review-live-v<rig>-g2.json`. `versions[].publication_generations`
records generation 2, its generation 1 predecessor and both file hashes, `at` and
`reason`. No stage, verdict, sign-off or rig artifact changes. Legacy-only records
remain valid without adoption or a new contract date. `job open --rig` selects
the recorded generation; the original publication remains byte-identical.

For an already-published direction@2 post, `republish <post> [<dir>] --reason
<words>` adds only `scene` and the `-g2` revision. Its references remain unchanged,
including an empty list; it introduces no original-painting requirement. The scene
and every declared plate are sealed as `{path, sha256}` with the direction. New
post manifests include `scene` only alongside `direction`; existing manifests are
never rewritten. @1 and scene-less publications retain their previous bytes. Any
other post generation delta refuses `PUBLICATION_GENERATION_INVALID`.

### Source CI pin guard

| Code | Refusal | Remedy |
| --- | --- | --- |
| `SOURCE_PIN_ANCESTRY` | `scripts/source-ci-pins.json` names a SHA before the package's release tag, or release metadata/history is unavailable or not exact | fetch complete sibling history and tags; choose a SHA at or after the exact `package.json` release pin; play uses the dependency at the release-pinned Review tag |

| `CONSUMER_CI_COVERAGE` | `scripts/consumer-ci-tests.json` names an absent case, registry check does not pass it, or source CI skips any other case | restore exact consumerOnlyTest registration and registry execution; run every other source case |

### Record asks on the live screen

Register a retained set with `interview-options <question> <dir> --file <set>`.
Then run `job open <dir> --reviewer <id> --role owner --question <question>`.
For an eligible plan use the same command with `--plan` instead. These selectors
are exclusive with each other, `--draft` and `--rig`; no pending question is
selected implicitly. A package-only job from an earlier host must be closed
with `job close` before opening its first record subject. Its exact stored
package reuse identity is never silently upgraded.

Record asks seal `project.json`, their declared inputs and context evidence, and
all files read by the shared decision-record check, without rechecking or sealing
unrelated producer artifacts from drafts, earlier versions, scenes or direction.
The record check keeps answer, plan, signature and stage predicates; the ordinary
project-boundary `check` still validates all producer artifacts. Package asks
(draft, rig and post) keep their existing closures. Review's publication refusal
`error.message` is passed through to the agent and durable pending receipt.

Record publications use the existing two-phase `readRecordPublished` closure,
the writer outbox and API@3. Mixed hosts retain Review's API@2/act@2 reuse
markers and accept the ordinary API@2 finalized-act fetch. Record picks,
checkpoints and sign-offs are act@4; package comments remain act@6.
The record reader discounts only pending transport holes for its own exact
record hash and result while publishing; unrelated/stale outbox entries still
block it, and ordinary `check` continues to report pending transport holes.

After the synthetic or real reviewer acts, ingest with `interview-answer
<question> <dir> --from-review <actId>` or `signoff <stage> <dir> --from-review
<actId>` (add `--checkpoint <step>` for a checkpoint). Refresh the same explicit
selector after writes. A record pick or sign-off binds its displayed record;
changed record bytes require a new publication/ask. Exact retries return the
retained result before current-source checks. Stage advancement remains a
separate `advance` command. This adds no historical record refusal or SINCE.

When publishing an option set in an open interview, the existing reader treats
only `INTERVIEW_INCOMPLETE` on that effective stage's silent question paths as
remaining interview work. Both inventory and retained phases apply this rule.
Plan publication, stage-boundary checks and ordinary `interview --check` keep
all their existing refusals; malformed answers and missing earlier-stage answers
are never discounted.

### Listing finalized Review acts

`job acts [<dir>] [--json]` reads the bound live host's agent `next` events,
using the same reader as publication ask reconciliation. It lists finalized
acts absent from `project.json.review_acts` and signoff source identities,
with their exact writer arguments/POSIX-quoted command. It never ingests, advances,
creates a host or writes the project/binding/outbox. Empty lists succeed.
A missing or dead host refuses `JOB_HOST_ATTACH_REFUSED`; restore it with
`job open`. The existing strict close attachment preserves stored identities.

| Code | Meaning and remedy |
| --- | --- |
| `JOB_ACTS_READ_REFUSED` | `project.json`: the live job refused or failed its event stream, or paging did not finish within the bound. Restore the bound live host and retry `job acts` on a quiescent job. |
| `JOB_ACTS_WRITER_UNAVAILABLE` | `project.json`: a listed act has no current writer target (for example a removed checkpoint step or a subject without a Create adapter). Its command is null, not guessed. Restore the named plan step or use a supported Review subject before ingestion. |

## Package upgrades

`rig-create packages upgrade [dir] --by <operator>` checks the project before
and after installing Create's release pins. Existing refusals may disappear;
no refusal may be added or change its code, path or message. The history is
optional on older records; present rows are validated by the writer and check.

| Code | Meaning and remedy |
| --- | --- |
| `PACKAGE_UPGRADE_MALFORMED` | `project.json.package_upgrades` is not the writer's history: restore its operator, timestamp, three from/to package entries and lock sha256. |
| `PACKAGE_UPGRADE_USAGE` | Supply `packages upgrade [dir] --by <operator>`. |
| `PACKAGE_UPGRADE_INPUT` | Restore the named manifest/record field; pins must be exact versions in dependencies, with no duplicate locations, workspace or local dependencies. |
| `PACKAGE_UPGRADE_CURRENT` | All three manifest pins already equal Create's release pins; no write is needed. |
| `PACKAGE_UPGRADE_DOWNGRADE` | The named package is newer than Create's release pin; use a newer Create release. |
| `PACKAGE_UPGRADE_INSTALL` | The staged install failed; repair registry access or the package versions and retry. |
| `PACKAGE_UPGRADE_CHECK_FAILED` | The project check could not complete; repair the record or installed packages and retry. |
| `PACKAGE_UPGRADE_REFUSAL` | The named package move adds or changes the named check finding; preserve the original pins and resolve that finding before retrying. |
| `PACKAGE_UPGRADE_CONFLICT` | Another package writer holds the lock, or a source changed during staging; finish the other write and retry against current bytes. |
