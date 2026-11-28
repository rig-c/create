# Checking the interview

Run `rig-create interview --check` at completed step boundaries and after
rebuilding stale outputs. It validates the record, authored inputs, producer
reports and dependency bindings. Current progression has no approval gate.
The historical refusal and warning sections still apply to retained numbered
records and any signoff or Review act references they carry. For the current
work order, use `rig-create next`.

Current `camera_depth`, `post_timing` and `post_composition` are relayed owner
chat choices. References to delegated values for these questions describe
retained records. See [the interview](INTERVIEW.md#step-plans).

## Owner language

The check reports declaration problems as warnings at every record date.
Starting a new live publication uses the same findings as refusals before
queuing it. See [Owner language](PROJECT.md#owner-language).

| Code | Finding and remedy |
| --- | --- |
| `OWNER_LANGUAGE_MISSING` | `project.json.owner.language` is absent. Declare the owner's preference with `rig-create owner-language set <tag> [<dir>]`. |
| `OWNER_LANGUAGE_INVALID` | `project.json.owner.language` or its containing object is malformed, or a language argument is invalid. Give a language tag such as `ko` or `en-US` to `owner-language set` or `init --owner-language`. |
| `OWNER_LANGUAGE_USAGE` | The set command or init option is misused. Run `rig-create owner-language set <tag> [<dir>]` or give `init` one `--owner-language <tag>` for a project. |
| `OWNER_LANGUAGE_SOURCE_CHANGED` | The decision record changed during the language write. Retry against the current project. |

## Sealed checkpoint presentation

These additive checks apply when `plan.checkpoint_evidence` is present. Historical
absence keeps its existing behavior. Review validates PNG format at publication.

| Code | Finding and remedy |
| --- | --- |
| `CHECKPOINT_EVIDENCE_USAGE` | `plan.checkpoint_evidence` command options are incomplete, repeated or combine `--file` with `--clear`. Use `checkpoint-evidence --file`, `checkpoint-evidence --clear` or `checkpoint-table --file --rows --out`. |
| `CHECKPOINT_EVIDENCE_INVALID` | `plan.checkpoint_evidence` has an invalid closed packet shape, duplicate identity, unknown step, alias, declaration size or aggregate table size. Retain the exact ordered producer declarations and attach them with `checkpoint-evidence`. |
| `CHECKPOINT_EVIDENCE_PAIR_INVALID` | `plan.checkpoint_evidence[i].pair` is malformed, or its `before` or `after` does not identify a distinct tile by its ID and exact SHA-256 within that packet. Correct the producer pair and attach the sealed packet with `checkpoint-evidence --file`. |
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

Draft, numbered rig and post views open for inspection with no verdict asks.
Declared files must match their recorded hashes.

| Code | Finding and remedy |
| --- | --- |
| `JOB_PUBLISH_PENDING` | A committed `project.json` result awaits publication. A bound writer that committed its record and could not publish it (`record`, `direction`, `advance`, or a historical numbered/draft writer) exits 0 and prints `WARN JOB_PUBLISH_PENDING:` on stderr naming the recorded path; it is not a refusal. Restore its bound host and sources, then run `job reconcile` before another participating write or close. When a receipt records a failure, `next` offers `job close <dir> --retire-refused` to archive failed receipts under the private `retired-publications/` directory without acknowledging them. If unfailed publications remain, the job stays open for `job reconcile`. In that case, run `--retire-refused` separately and reconcile before asking to close with `--discard-acts`. |
| `JOB_OWNER_SUBMIT_REFUSED` (WARN) | Review refused an owner submission for the live `project.json` job. The listening `job open` process prints one stderr line with Review's code, the route template `/jobs/:jobId/ui/acts`, the number of request bytes Review read (possibly zero), and the byte limit if Review supplied one. Use Review's code to resolve the refusal, then have the owner retry in Review. A refused submission produces no finalized act for `job acts --wait`. |
| `JOB_ROOT_REPLACED` | `project.json`: the managed Review state belongs to a replaced project directory, or its ownership/liveness cannot be established safely. Stop the original `job open` host in its terminal, then retry `job open` or `job reconcile`. With no pending publication or startup claim, both commands preserve the old state in a dated `.replaced-…` sibling only when its recorded PID is absent and its recorded loopback port refuses connections. Missing/unsafe metadata, an occupied port or uncertain liveness refuses without retiring state; restore the retained metadata or original directory before retrying. |
| `JOB_HOST_ATTACH_REFUSED` | Strict reuse-only attach to the bound live host was refused. The pending receipt names the host `reason` and `phase` (including `incarnation-missing` on `record` or `probe`). Reopen or restore the bound live host before reconciling. When the binding matches the current pin and hooks, `job close` reads the job's finalized owner acts and retires the job through the live host, never from the record alone, so a stopped host refuses close and the message names the `job open <dir> --reviewer <id> --role <role>` restart; the restart serves the same job, then retry `job close` (for a stopped binding from an older pin or hook that `job open` refuses with `JOB_HOST_REUSE_MISMATCH`, `job close` retires the binding directly; see [job retirement](JOB-RETIREMENT.md)). The refusal leaves `project.json` and the job state byte-identical. |
| `JOB_HOST_REUSE_MISMATCH` | Opening a question or plan against a legacy host can report `publicationMode expected=record-and-package found=package-only`. Finish and ingest its pending acts, explicitly run `job close`, then reopen with `--question <id>` or `--plan`. For other mismatches in the bound host tuple (`jobId`, `origin`, `listenerIncarnation`, `root`, `stateDir`, `fingerprint`, `reviewer.id`, `reviewer.role`, `readerId`, `bindingId`, `partsEnumeratorId`, `partsEnumeratorVersion`, `apiSchema`, `actSchema`, `port`), restore the original bound configuration, then run `job reconcile` for a pending publication or retry the intended command. Field-level pending receipts name the `field` and both `expected` and `actual` values. For a pin or hook bump, follow [job retirement](JOB-RETIREMENT.md). |
| `JOB_PUBLICATION_STALE` | The pending version entry is missing or has a different entry hash. Restore that retained version and its files before reconciling. Later surrounding-record changes do not invalidate version publications. Exception: a record publication binds the whole project.json byte hash, so any record change while it is pending makes it stale; restore the bound record bytes before reconciling. The check preserves the receipt and names the HOLE. If an outbox receipt records a failure, `next` also offers `job close <dir> --retire-refused` to abandon failed publications. |
| `JOB_PUBLICATION_INVALID` | A result, selector or retained file (including a declared rig/post or draft original painting (the input `painting` names, or `inputs[0]` when none is declared) and its PNG header) differs from the writer's recorded rig/post or draft, or a declared publication path violates Review's `jobPath` rule (empty, `.`, `..` or matching `[\\:%?#]`). Restore its declared package, source painting and direction bytes with literal project-relative paths; a `painting` that names no registered input also refuses here. Missing/empty rig/post inputs keep no reference; an unreadable legacy original retains `INPUT_WRITER_MISSING` and no reference, as check does. |
| `JOB_PUBLICATION_SCENE_MISSING` | An @2 post lacks its scene reference or the scene file is missing or unreadable; restore the direction.scene reference and retained scene bytes before publishing. |
| `JOB_ANSWERED_DIRECTION_FEEDBACK_INVALID` | Review refused an answered-feedback reference for the post in `project.json.versions`. Restore the retained earlier post verdict and its ingested act in the publishing Review job, then run `rig-create job reconcile`. |
| `JOB_PUBLICATION_SCENE_CHANGED` | An @2 post scene differs from project.scenes, its path, document identity or recorded hash; restore the committed scene reference and bytes before publishing. |
| `JOB_PUBLICATION_PLATE_MISSING` | An @2 post scene lacks a plate identity or a plate file is missing or unreadable; restore every declared plate before publishing. |
| `JOB_PUBLICATION_PLATE_CHANGED` | An @2 post plate differs from its scene-recorded sha256; restore the retained plate bytes before publishing. |
| `JOB_PUBLICATION_FRAMES_CHANGED` | A rig version's `versions[v<N>].registration.idle` binding is malformed or its `frames.json` file is missing, unreadable or differs from its recorded sha256; restore the recorded `registration.idle` binding and retained `frames.json` bytes before publishing. |
| `JOB_BINDING_INVALID` | The private sibling/outbox is tracked or not effectively ignored, the binding is malformed, unavailable or mismatched, or a job command has invalid arguments. Restore effective private ignores. Restore the matching writer-owned binding through `job open`, then retry publication into the existing job. |
| `JOB_PRIVATE_STORAGE_INVALID` | Private publication storage has unsafe permissions, type or symlinks. Restore owner-only real directories and regular files. |
| `JOB_OUTBOX_INVALID` | A private publication receipt is absent, malformed or unreadable. Restore its writer-owned bytes before reconciling. The check reports this as a HOLE. |
| `JOB_ASK_PENDING` | A publication from a bound writer or `job open` would replace an unresolved owner ask. `input add`, interview record writers, `record`, and `owner-language set` also refuse while a bound live job holds an unresolved ask. The message names the job and pending asks. Comment ingestion with `comment --from-review` can proceed. For one stale act on an active bound job, use the reported `job withdraw-act <actId>` command with the owner-chat flags to keep the page and URL. For multiple stale acts, follow the reported `job close --discard-acts` remedy before retrying with `--owner-chat`. If an interview page needs a refresh, include every remaining unresolved question with its exact option-set binding. A verdict ask or act on a rig or post version that a later amendment made history does not hold the job (a historical reopen still holds it); `job acts` still lists the act as unavailable. Refusal preserves `project.json` and the job state byte-identically. |
| `JOB_PUBLICATION_ASK_REQUIRED` | Retired. Earlier numbered version writers used this refusal when replacing an open publication without an owner ask or a verified carried draft approval. Open the numbered view explicitly for inspection. |
| `JOB_ASK_REFUSED` | Retired. Earlier publications reported declared subjects whose `ask` or `ask-batch` call Review refused with this code; Create no longer sends `ask` or `ask-batch` requests. |
| `JOB_ASK_INVALID` | Retired. Earlier refused ask outcomes used this fallback code when an `ask` or `ask-batch` call failed without a Review error code. |
| `JOB_DRAFT_UNKNOWN` | `job open --draft <id>` names a draft the record does not hold. Name an existing draft in `project.json.drafts`, or record and open current parts with `rig-create record parts` and `rig-create job open --current parts`. |
| `JOB_PARTS_VERDICT_UNASKABLE` | Retired. Earlier draft publications at `parts-review` used this refusal when the draft's structure snapshot was missing or invalid. `job open --draft <id>` now opens the draft view-only. |
| `JOB_RIG_VERDICT_DEFERRED` | Retired. Earlier numbered rig publications used this diagnostic for a verdict ask deferred until rig-review. Use the numbered view for inspection and see `NUMBERED_ACT_RETIRED` for migration. |
| `PREVIOUS_DRAFT_UNAVAILABLE` (WARN) | A draft comparison operand lacks a retained SHA-256 and PNG binding or fails that binding. Restore the producer recomposite with its original seal or register a fresh draft. |
| `JOB_WRITE_BUSY` | A bound writer, `job reconcile`, a feedback route, or a `job open` host publishing into the job holds the shared publication freeze (the `.rig-create-job-write.lock` job write lock). Wait for that operation before retrying. `job close` waits up to 120 s for the lock, as after a host restart, printing the holder's pid on stderr, and then closes; when the wait runs out it refuses with the holding pid and leaves `project.json` and the job state byte-identical. |
| `JOB_RECORD_INCOMPLETE` | Review 2.8.0 carries answered scene-context choices and historical diagnostics in `publication.interview` (`rig-review/job-interview@1`), and refuses invalid or stale editable `pending_options` sets before publication. Restore a current editable option set before reconciling. |

A bound current `rig-review` or `direction-review` advance also refuses with
`JOB_PUBLICATION_INVALID` if its recorded output is missing, stale or differs
from the output tree. Rebuild and record the current output before advancing.

### Current direction scene report

The current direction manifest includes `sceneReport` beside `model` when the
sealed Parts `spine-parts-scene-report/2` has an authored `idle` camera track.
The pointer holds the report path and SHA-256 of its raw bytes. Scenes with a
`/1` report or without an authored `idle` track keep their existing manifest
bytes. The take comes from the cited owner choice.

| Code | When it fires and how to recover |
| --- | --- |
| `JOB_PUBLICATION_INVALID` | The scene report's bytes differ from the seal in `current.direction.files`, its spec is unsupported, or the camera track metadata cannot supply the authored take. Restore the recorded report or compose and record direction again. |
| `DIRECTION_TAKE_MISMATCH` | The current direction's cited take duration or loop differs from the sealed report's `camera.tracks.idle.duration` or `loop`. Compose again using the cited authored duration and loop, then run `rig-create record direction` before publishing. |

The report-to-model digest check uses `DIRECTION_COMPOSE_CAMERA_MODEL`.


## Finalized Review acts

A rig-review Request changes carrying `act@8` mesh edits uses the displayed
package and Parts applier. Each correction's `outcome.revision` names a retained
mesh rig revision. Create commits the verdict, act receipt and corrections
together. A replay uses the retained receipt.

A comment-only act (`rig-review/act@10`) answers no ask. `comment --from-review
<actId>` records it as one `comments[]` entry with a `review_acts[]` receipt of
kind `comments`; its mesh-edits carrier is applied like an act@8 mesh edit.
A chest-landmarks carrier on the live rig takes the project-relative working
`--config`, retains the act bytes, and offers the same two Parts commands as
act@9. Neither carrier records a verdict. Every other writer refuses act@10 with
`REVIEW_ACT_KIND_MISMATCH`.

| Code | Finding and remedy |
| --- | --- |
| `REVIEW_API_SCHEMA_UNSUPPORTED` | `project.json.review_acts` received an unsupported API schema. Restore a live job using job-api@2 and fetch again. |
| `REVIEW_ACT_SCHEMA_UNSUPPORTED` | `project.json.review_acts` received an unsupported act schema, explicitly including act@1. Request a supported act from Review for current work. Retained reopen acts use act@4. |
| `REVIEW_ACT_V8_UNSUPPORTED` | Retired in Create 1.13.0. Earlier Create releases returned this code when `project.json.review_acts` received `rig-review/act@8`. |
| `PARTS_REMESH_API_UNAVAILABLE` | The selected Parts installation lacks `src/remesh-api.ts` or its `applyMeshEditAct` export. Install a project Parts release that provides this API before applying the mesh edit. |
| `REMESH_DELTA_ACT_SUPERSEDED` | Parts found an earlier application of the same act and attachment in the current rig's revision history. Continue from the current revision named by Parts without recording another completion for the attachment. Other Parts refusals retain the producer's code, object and detail. |
| `REVIEW_PARTS_ENUMERATOR_UNSUPPORTED` | The act's Parts enumerator is missing or outside `>=2.25.0 <4.0.0`. Publish through an accepted installed Parts enumerator and review again. A `review-verdict` act on a composed `direction@3` post carries `source.parts: null` and is exempt: it binds the composed build model, not parts. |
| `REVIEW_ACT_INVALID` | The fetched/retained act, response identity, authority, date, rig/post or parts value, or historical reopen value is malformed. Restore the original act evidence or request a new act. |
| `REVIEW_ACT_STILL_INVALID` | A retained Review act JSON sidecar or historical draft still is missing, mismatched or unsafe, or a historical rig verdict act lacks its still metadata. Restore the original retained bytes for `project.json.review_acts`. |
| `REVIEW_ACT_KIND_MISMATCH` | The act is for another version or a kind outside the requested review-verdict, parts-verdict, interview-picks, checkpoint or signoff writer, or a signoff act names a stage other than the requested writer stage. Use the matching version, stage and supported writer. |
| `SIGNOFF_FROM_REVIEW_REMOVED` | `signoff --from-review`, `signoff --checkpoint --from-review`, and `interview-answer --from-review` / `--batch` were removed and exit 2 before reading or writing `project.json`; `job acts` also marks finalized `interview-picks`, `signoff`, and `checkpoint` acts unavailable with this code. Relay the owner's exact words instead with `signoff <stage> [--checkpoint <id>] --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>` or `interview-answer <question> --set <id> --sha256 <hash> --pick <option> --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`. |
| `REVIEW_ACT_TARGET_MISMATCH` | `signoffs[].target.version`: a stored `rig-review` or `direction-review` signoff act's `source.selector` names no version of that stage's kind (`rig` for rig-review, `post` for direction-review), or disagrees with the recorded target version. Restore the original recorded signoff and act receipt. |
| `REVIEW_ACT_DRAFT_MISMATCH` | Retired. Earlier `signoff parts-review --from-review` ingests used this refusal when the act's draft selector differed from `--draft`. |
| `REVIEW_ACT_CHECKPOINT_MISMATCH` | Retired. Earlier `signoff --checkpoint --from-review` ingests used this refusal when the checkpoint act named another step. |
| `REVIEW_ACT_CHECKPOINT_FAILED` | Retired. Earlier `signoff --checkpoint --from-review` ingests used this refusal when the checkpoint act's outcome was `fail`. |
| `REVIEW_ACT_SUBJECT_UNDECLARED` | A fetched act's subject is not among the subjects Create declared for the act's publication, as kept in the private acknowledged receipt. Restore the matching publication receipt or obtain an act on a publication that declared the subject. |
| `REVIEW_FILE_ROUTE_REMOVED` | Retired. Earlier verdict writers used this refusal when given saved act files after file-route removal. |
| `NUMBERED_ACT_RETIRED` | `job acts` marks finalized numbered acts with retired ingest recommendations as unavailable and still exits 0. For a numbered rig or direction verdict gate, adopt retained outputs with `rig-create record <kind> --adopt` or rebuild and record current outputs. Use `direction --adopt` or `correction --adopt` for the corresponding record where applicable. To finish the numbered flow with its original writers and verdict asks, use Create 1.27.0. |
| `REOPEN_ACT_RETIRED` | `job acts` lists a finalized reopen act with no recorded receipt in `project.json.review_acts` as unavailable. For an interview correction register a fresh set with `interview-options`, record the owner's pick with `interview-answer` and re-sign the affected approvals. For an artifact correction use `amend` at the owning stage. Withdraw the retired act with `job withdraw-act <actId>` and relayed owner words. |
| `REVIEW_ACT_FETCH_REFUSED` | The live job refused or could not complete finalized-act fetch. The diagnostic retains the producer refusal code without exposing its private details. Restore the live job and its writer grant. |
| `REVIEW_ACT_SOURCE_STALE` | A retained or incoming act does not bind the exact current `project.json` bytes after undoing any trailing owner withdrawals for that job, or a current source binding or retained version/draft-entry identity differs from the displayed act, including a plan-bound signoff act (`plan-approved`, `rigging-interview`, `post-interview`) whose `source.plan` step ids and hashes, in order, differ from the current `plan.steps`. Restore the retained bytes or publish the current target and retry against the current project record. |
| `REVIEW_ACT_BUST_CONFIG_STALE` | The original Review publication, matched by publication ID and source hash, lacks a seed for a chest edit or its `source.configHash` differs from the portable `config.json` SHA-256 in `versions[vN].review_package.files`. Publish the current rig and request a new chest edit. |
| `REVIEW_ACT_BUST_SOURCE_CHANGED` | The working config supplied with `comment --from-review … --config` differs from the frozen SHA-256 in `versions[vN].registration.config_source`. Restore a matching working copy or build and register a new rig. |
| `REVIEW_ACT_BUST_REPLAY` | Retired. Earlier `review --from-review` chest-edit replays emitted this warning. |
| `REVIEW_ACT_REPLAY_CONFLICT` | A `(jobId, actId)` appears twice or its immutable value changed, or a feedback route's act ID matches more than one retained receipt. Restore the original receipt and its single linked verdict. |
| `COMMENT_COMMIT_MISMATCH` | WARN on `comment --from-review` when the comment act's `source.commit` holds no `project.json` in the project's repository, or one whose SHA-256 differs from `source.projectHash`. The comment is kept in `comments[i]` with `record.commit: null` and stays bound by `saw` and `record.sha256`. Commit the record before publishing so later comments carry a commit. An absent commit, or an absent `projectHash`, records `commit: null` with no WARN. |
| `COMMENT_CARRIER_UNSUPPORTED` | Retired. Earlier Create releases recorded chest carriers without a Parts follow-up. Re-ingest the original act on its live rig with `comment --from-review <actId> --config <path>` to prepare the follow-up. |
| `COMMENT_OPTION_INVALID` | `comment` needs either `--from-review <actId>` (with optional `--config <path>` for a chest carrier, using the recorded path on replay) or `--close <index> --act-sha256 <sha256> --after <path>=<sha256>...` (with optional `--reason` / `--reason-file` and `--by agent`), one optional project folder and optional `--json` (exit 2). |
| `COMMENT_CLOSURE_INVALID` | A closure in `project.json.comment_closures` or a `comment --close` write is malformed, duplicates a comment, names `--by` other than `agent`, predates its comment or is dated in the future, fails to bind a verified `comments[i]` entry and its retained `review_acts[]` comment receipt SHA-256 (`act_sha256`), omits `after` file bindings, repeats or leaves a `saw[]` file at its unchanged pre-comment hash, or (at write time) names a missing, non-regular or hash-mismatched project file. Refusal preserves `project.json` byte-identically. |
| `REVIEW_FEEDBACK_ROUTE_INVALID` | A stored `review_acts[i].feedback_route` does not match its receipt kind and retained act. For a rig verdict, restore the agent's recorded route and original comment. For interview picks, restore the recorded question and the complete list of comments with their original text, order and anchors. |
| `REVIEW_FEEDBACK_ROUTE_CONFLICT` | Retired. Earlier `review --from-review --item` calls used this refusal when `feedback_route` already named another waypoint. |
| `REVIEW_ACT_LEDGER_INVALID` | `review_acts[]` or one receipt's identity, hash, target, linked verdict, linked signoff (the one `signoffs[]` entry whose `source` names the act, with the act's stage, `by`, `at` and words, and for rig-review or direction-review a `target.version` equal to the act's `source.selector` version), linked pick receipts for a derived stage sign-off, linked historical reopen (including its original status snapshot and exact exported reviewer, date and words), retained parts evidence, a folded parts receipt's `signoff` index and its human authority, draft and evidence pointer, a folded rig receipt's unique `signoff` index, human authority, exact words and version/verdict/package target, a discarded act receipt (`kind: "discarded"`, `jobId`, `actId`, `at` and attribution with a reason or relayed owner words), or a comment receipt (`kind: "comments"` naming exactly one `comments[i]` entry that equals its act's projection, and any mesh corrections its carrier made) is invalid. Every `comments[i]` entry is named by exactly one comment receipt. Restore the original receipt and recorded act together. |
| `REVIEW_ACT_VERSION_UNVERIFIED` | WARN on ingest when the acknowledged publication receipt is unavailable. The version-entry comparison was skipped, and all explicit source bindings were checked. Preserve private acknowledged receipts for future ingests. |
| `REVIEW_ANSWER_COMMENTS_UNROUTED` | WARN in `check` when a retained `review_acts[i]` interview-picks receipt has comments in its `rig-review/act@6` bytes and lacks `feedback_route`. This applies at any receipt date, with no cutoff. Preserve the receipt and read the comments in `review_acts[i].bytes` (`value.comments`). |
| `REVIEW_ANSWER_COMMENT_ROUTED` | WARN in `next` text and JSON for each open, validated interview comment in `review_acts[i].feedback_route.comments[j]`. Read the exact text, question, one-based order, any serialized anchor and source path, then use the agent move to record the resolution. Version `FEEDBACK_OPEN` tracks bounced verdicts. |
| `INTERVIEW_COMMENT_CLOSURE_INVALID` | A closure in `project.json.interview_comment_closures` is malformed, duplicates a comment, or fails to bind a validated routed comment and its resolution. Use the job, act, question and one-based order from `next`. Supply the operator's reason and, for an answer resolution, a unique later completed local answer or guide with retained provenance. Restore a damaged closure or its retained evidence. |
| `PARTS_REVIEW_FOLD_NOT_READY` | Retired. Earlier `parts-review --from-review` and amended `signoff parts-review` writers used this refusal outside active `parts-review`. |
| `PARTS_REVIEW_OPTION_INVALID` | Retired. Earlier `parts-review` writer invocations used this refusal on missing, duplicate or competing options. |
| `SIGNOFF_NOT_HUMAN` | A signature or stored parts verdict names `agent` as the human reviewer (trimmed, case-insensitively). Obtain a person's signature. Refusal preserves the project record. |
| `PARTS_REVIEW_EVIDENCE_CONFLICT` | Retired. Earlier `parts-review --from-review` writes used this refusal when the semantic evidence path held conflicting bytes. |
| `PARTS_REVIEW_CLI_ARGUMENT_INVALID` | `review_acts.argv` contains an absolute or escaping argument, or overrides create's JSON format. Restore the retained CLI receipt arguments. |
| `PARTS_REVIEW_CLI_FAILED` | Retired. Earlier `parts-review --from-review-cli` invocations used this refusal when the Review CLI failed. |
| `PARTS_REVIEW_CLI_INVALID` | CLI stdout is not supported UTF-8 verdict JSON with status, tool, source hashes and per-part outcomes and notes. Query a supported review CLI. |
| `PARTS_VERDICT_RECEIPT_INVALID` | A CLI receipt's metadata, retained response hash or copied fields differ, its draft/parts manifest binding is unavailable, or it repeats a receipt. This also covers a parts signature whose explicit evidence names an act outside its parts-review package. Restore the exact retained response and draft record, or review the draft at parts-review to obtain signature evidence. |
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
- **The parts verdict** a `parts-review` sign-off rests on is a retained
  [parts-review receipt](#recorded-parts-verdicts-create267). The check binds
  `signoffs[].draft_id` and `evidence` to the receipt in `review_acts[]` and
  validates the retained response and its draft bindings. A legacy saved-file
  binding is preserved with `PARTS_VERDICT_FILE_LEGACY` without opening the
  old verdict file. The diff-map check uses the manifest from a valid latest
  sign-off while parts gate rigging.
- **A collection member** (`<collection>/members/<name>/project.json`) has its
  `inherited` answers resolved against `<collection>/collection.json`. An
  inherited answer whose collection answer is `null` (or `"per-member"`) is
  silence, reported at the member's waypoint with the reason. Its `@rig-c/parts`
  is looked for in the member's folder, then in the collection's install.
- **A collection** (a folder with `collection.json` and no `project.json`, or
  the `collection.json` itself) is not a project: `interview --check` runs the
  collection check on it, the same as `collection --check` ([§ Collections](#collections)).

## Appearance bar wording

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `STEP_APPEARANCE_REVIEW` | WARN on `plan.steps[<id>].bar`, including pending steps, for appearance wording without a numeric reading | Move the appearance item to the person's `rig-review` for `phase: "rig"` or `direction-review` for `phase: "post"` and attach measured step readings as context ([INTERVIEW.md](INTERVIEW.md#appearance-belongs-to-a-persons-review)) |

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
  as of its `at`. No sign-off is required for a step to run, and a sign-off may
  name any stage (#981).
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
- **A current direction answers a numbered direction bounce** when its
  `answers_feedback[]` names that open verdict. Pass repeatable
  `--answers-feedback <version>:<verdict>` to `record direction --from`; the
  writer records the references with the new output and retains them on later
  direction recordings. Check reports the explicit answer as
  `feedback[].answered_by_current_direction`. Output replacement alone leaves
  the bounce open.
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
of its `rig` versions is held to the `@rig-c/parts` gates that measure
what a CG build is for, declared in the files the version was built from
(`src/cg-gates.ts`):

| Gate | Declared in | What parts refuses under it |
| --- | --- | --- |
| `assemble.editor_receipts.trace_parts: true` | the version's config | a part carved by a shape the config draws (`ASSEMBLE_PART_SOURCE`), an edited image with no receipt (`ASSEMBLE_EDITOR_RECEIPT_MISSING`) |
| `seam_over_motion.required: true` | the requirements file the config names as `requirements` | background at a declared seam pair on any frame, or no pair to read (`CHECK_SEAM_OVER_MOTION_REQUIRED`) |
| `boundary_colour.max_step_excess`, at most 12 | the same requirements file | a part boundary whose colour step exceeds the pieces' own by more than the allowance (`CHECK_BOUNDARY_COLOUR_STEP`), a step that cannot be taken (`CHECK_BOUNDARY_COLOUR_UNMEASURED`) |
| `behind_seams.threshold`, an integer from 0 through 12 (also on any `pairs[].threshold` override) | the same requirements file; required from `CG_BEHIND_SEAMS_SINCE = 2026-11-19T00:00:00Z`, dated by `versions[].at` | a motion-opened or standing seam showing a part drawn behind (`CHECK_BEHIND_PART_SEAMS`); an unread declared seam (`CHECK_BEHIND_PART_SEAMS_UNMEASURED`) |

- **Why `config.requirements`.** `rig-parts build` reads the file the config
  names and forwards it to its check, so a build from the config alone runs
  the requirements-file gates; a file passed only as `--requirements` by hand
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

## Command usage

These refusals exit `2`.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `UNKNOWN_COMMAND` | the first argument names no Create command | choose a command from `rig-create --help` |
| `NUMBERED_WRITER_REMOVED` | a removed numbered writer command or flag is invoked (refused before reading or writing) | use the current-path replacement named in the refusal, adopt onto the current path ([Adopting existing numbered outputs](PROJECT.md#adopting-existing-numbered-outputs)), or stay on Create 1.27.0 to finish the numbered project |
| `INTERVIEW_MODE_MISSING` | `interview` is called without `--check` | use `rig-create interview --check [<project dir>]` |
| `INTERVIEW_TOO_MANY_ARGUMENTS` | `interview --check` receives more than one target | supply one project or collection target, or omit it to use the current folder |

## Initialization

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `INIT_DIR_MISSING` | plain `init` receives no folder, `init --collection` receives other than one folder, or `init --member` receives other than a collection folder and member name (exit 2) | use `init <dir>`, `init --collection <dir>` or `init --member <collection dir> <name>` |
| `INIT_TOO_MANY_ARGUMENTS` | plain `init` receives more than one folder, or both `--collection` and `--member` are present (exit 2) | supply one destination for plain `init`, or choose one initialization mode |
| `INIT_NOT_A_DIRECTORY` | the project or collection destination exists and is not a directory | choose a new or empty directory |
| `INIT_DIR_NOT_EMPTY` | the project or collection destination already contains entries | choose a new or empty directory |
| `INIT_GIT_FAILED` | Git initialization, staging or committing the generated files failed | inspect the Git diagnostic and repair the reported operation in the destination or collection; inspect any files already created before retrying |
| `INIT_INSTALL_FAILED` | `bun install` fails during project or collection initialization, which still creates the record and its initial commit before reporting the error | run `bun install` in that folder and commit `bun.lock` |
| `INIT_NOT_A_COLLECTION` | `init --member` points to a folder with no `collection.json`, an unreadable or invalid record, or a schema other than `rig-create/collection@0` | supply a collection with an intact record, or create one with `init --collection` |
| `INIT_COLLECTION_UNNAMED` | the collection record has no nonempty string `name` to bind inherited answers | restore the collection's name before adding a member |
| `INIT_MEMBER_NAME_INVALID` | the member name is not one folder name beginning with an ASCII letter or digit and using only those characters, `.`, `_` and `-` | supply a valid member name |
| `INIT_MEMBER_EXISTS` | the name is already in `collection.json` `members[]` or its folder exists | use the existing member or supply a new name |
| `INIT_COLLECTION_DIRTY` | `collection.json` has uncommitted changes in the collection's Git work tree | commit those changes before registering the member |

## Split captions

`rig-create split-captions [<project dir|project.json>] [--config <file>]`
prints generated caption JSON. The config defaults to `config.json` beside
the project record. Relative `--config` paths resolve beside that record.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `SPLIT_CAPTIONS_USAGE` | there is more than one target, or `--config` is repeated or lacks a nonempty file argument (exit 2) | supply at most one target and one `--config <file>` |
| `SPLIT_CAPTIONS_INPUT_UNREADABLE` | the project record or config cannot be read | point the command at readable files or restore the named file |
| `SPLIT_CAPTIONS_INPUT_INVALID` | the project record or config is invalid JSON or its root is not an object | restore the named file as a JSON object |
| `SPLIT_CAPTIONS_PARTS_INVALID` | `project.json` has no nonempty `split.parts` list, or a part lacks a unique nonblank name or a supported label | restore the recorded parts with unique names and a `physics`, `wind`, `jiggle`, `rigid` or `still` label for each |
| `SPLIT_CAPTIONS_CONFIG_INVALID` | the installed Parts config parser cannot load or rejects the assembly or full rig config | use the project's pinned Parts installation and fix the named config error |

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
| `PLAN_REPLACED_SIGNOFF` | a signature's hash for a replaced id matches neither the current step nor its retained history | restore the signed step and its replacement history |
| `PLAN_OPTION_INVALID` | plan CLI arguments are missing, repeated or malformed, or plan propose/feedback names no step (exit 2) | use plan propose, feedback, add, revise, remove or replace with the documented fields and drafter |
| `PLAN_STEP_INVALID` | plan writer sees no steps list, a duplicate add id, no unique revise/remove/replace target or a replace that changes the phase | restore the plan and use the appropriate action and id |
| `PLAN_WRITE_CONFLICT` | another plan write holds the project lock, or project bytes change during validation | finish or recover the active writer, reload the project and retry |
| `STEP_MALFORMED` | a step has no string `id`, a `phase` other than `rig` / `post`, or an id used twice | fix the step |
| `STEP_NO_BASIS` | a step's `rests_on` is empty | name the answers it is built on; a step never rests on nothing — ask for the sentence first |
| `STEP_BASIS_UNKNOWN` | `rests_on` names an id that is no framing, waypoint or post item | name an answer id, or add an `x_` prompt at the waypoint it belongs to |
| `STEP_BASIS_SILENT` | `rests_on` names an item that has no answer | answer the item (it is also reported on its own) |
| `PLAN_STEP_PREDATES_ANSWER` | a rigging-interview or post-interview step without a live covering stage signoff has a draft or revision that predates the latest recorded `guide.at` it rests on. For an unstamped rigging step, an earlier `rigging_drafted_at` also proves staleness. A guide dated before `PLAN_STEP_ANSWER_SINCE` warns | record the answer, then use `plan revise <id>` before approval. For completed work, record an owner amendment if needed, then use `plan replace <id>` with the same phase, retaining the completed definition in history. A `post-interview` answer amendment can expose this refusal on a step whose covering signoff has `SIGNOFF_ANSWERS_STALE` for that answer. The amendment writer allows this transition and `check` keeps reporting the refusal until the step is replanned |
| `PLAN_STEP_DRAFT_DATE_UNKNOWN` | WARN for a step without a live covering stage signoff when neither the step nor its latest same-id revision dates the current definition and the shared rigging plan date cannot prove it precedes the answer. Post steps have no shared draft date | review the recorded answer. Use `plan revise <id>` for unfinished work or the completed-step replacement procedure above |
| `STEP_NOT_A_WAYPOINT` | a `rig` step's `id` is not a waypoint id | one step per waypoint, named after it |
| `STEP_MISSING_FOR_WAYPOINT` | the plan is signed, a waypoint has a guide or a delegation, and no rig step has its id | add the step, or answer the waypoint not applicable if the plan does not pass it |
| `GUIDE_PARTIAL_UNMARKED` | a user guide has `agent_decision` without nonempty `covers` | name the delegated remainder in `agent_decision.covers` and write its value and reasoning before plan approval |
| `STEP_STATUS_UNKNOWN` | an explicit step status is outside `pending`, `in-progress`, `at-checkpoint`, `done` | use `pending` before approval, then a documented running status |
| `SIGNOFF_MALFORMED` | a sign-off lacks `stage`, `by`, `at` or `verbatim` | write it in the answer shape |
| `SIGNOFF_NOT_HUMAN` | a sign-off's `by` is `agent` | a person signs; the entry does not count |
| `SIGNOFF_UNKNOWN_STAGE` | a sign-off names a stage that does not exist | fix the stage |
| `SIGNOFF_UNKNOWN_CHECKPOINT` | a sign-off's `checkpoint` names no step that runs in that stage | name the step |
| `DIFF_MAP_MISSING` | the gated latest parts-review sign-off dated from `DIFF_MAP_SINCE`, or without a readable date, has no `diff_map` because `project.json.diff_map` is absent (draft publication readiness instead warns and withholds the parts-review approval subject until the map is prepared) | generate the whole-figure report and record component classifications with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent` |
| `DIFF_MAP_NOT_AGENT` | `project.json.diff_map.by` is not `"agent"` or `at` is missing or unreadable, or `diff-classes` receives `--by` other than `agent` (exit 2) | record component classifications with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent` |
| `SIGNOFF_DIFF_MAP_REMOVED` | `signoff parts-review` receives `--diff-report`, `--triage-file` or `--component` (exit 2), or a `parts-review` sign-off dated from `DIFF_MAP_AGENT_SINCE` (or without a readable date) carries `diff_map` | record component classifications with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent`, and record the person's approval with `signoff parts-review` without diff-map flags |
| `DIFF_MAP_REPORT` | the named report is absent, escapes the project, differs from its SHA-256, or has the wrong spec or shape | regenerate a `rig-parts-diff-components/1` or `rig-parts-diff-components/2` report and record its path and exact hash |
| `DIFF_MAP_STACK_MISMATCH` | neither derived stack exists, both exist ambiguously, or the unique stack differs from `report.stack.sha256` | retain one stack in parts' fixed build or assemble layout and regenerate the report on it |
| `DIFF_MAP_COMPONENT_UNLISTED` | a report id is absent from `diff_map.components` | list the named id with its status and why |
| `DIFF_MAP_COMPONENT_UNKNOWN` | a listed id is absent from the report | use the ids from the bound report |
| `DIFF_MAP_STATUS` | a component is malformed or repeated, has another status, or has an empty why | list each id once with `in-painting`, `fixed` or `left` and a nonempty why |
| `DIFF_MAP_CLASS` | an optional class has a wrong key or member set, repeats, overlaps, or disagrees with its expanded components | derive classes again with `diff-classes` and record with a decision-only triage file via `diff-classes --diff-report <path> --triage-file <file> --by agent` |
| `DIFF_MAP_CLASS_WHY` | a class reason names neither an exact border part nor its coverage band | inspect the class and state its measured property in why |
| `DIFF_MAP_TRIAGE` | the triage file is unreadable or malformed, supplies keys or members, or names unknown ids | read `diff-classes` and supply only status and why per class or component id |
| `DIFF_MAP_POLICY` | `definition.floor_px` exceeds 2 or `definition.threshold` exceeds 40 | regenerate with floor at most 2 and threshold at most 40 |
| `PARTS_VERDICT_MISSING` | Retired. Earlier Create releases used this code when the parts sign-off lacked a saved-file verdict. | Record current parts with `rig-create record parts` and relay any owner chat sign-off; on stored numbered records, see `PARTS_VERDICT_RECEIPT_REQUIRED`. |
| `PARTS_VERDICT_UNREAD` | Retired. Earlier Create releases used this code when the sign-off's saved verdict could not be read or failed its byte binding. | Restore the retained response and receipt on stored numbered records, or record current parts with `rig-create record parts`. |
| `PARTS_VERDICT_SCHEMA_UNKNOWN` | Retired. Earlier Create releases used this code for an unsupported saved-verdict schema. | Record current parts with `rig-create record parts`; historical CLI receipts are validated read-only (`PARTS_REVIEW_CLI_INVALID`). |
| `PARTS_VERDICT_ATLAS` | Retired. Earlier Create releases used this code when a saved build-atlas verdict was supplied for `parts-review`. | Inspect current parts with `rig-create job open --current parts` and record outputs with `rig-create record parts`. |
| `PARTS_VERDICT_MALFORMED` | Retired. Earlier Create releases used this code for an invalid saved-verdict shape or file inventory. | Record current parts with `rig-create record parts`; historical CLI receipts are validated read-only (`PARTS_REVIEW_CLI_INVALID`). |
| `PARTS_VERDICT_NOT_APPROVED` | the verdict's `status` is `pending` or `changes-requested`, or a carried approval comes from a delegate | fix flagged parts and record the owner's approval before signing an amendment |
| `PARTS_VERDICT_SOURCE_CHANGED` | Retired. Earlier Create releases used this code when a file listed by the saved verdict was missing or changed. | Record updated current parts with `rig-create record parts` and relay any owner chat sign-off. |
| `PARTS_VERDICT_SOURCE_MISMATCH` | Retired. Earlier Create releases used this code when the saved verdict's declared source digest differed from its file list. | Record current parts with `rig-create record parts` so the output inventory binds the current build. |
| `VERSION_MALFORMED` | a `versions[]` entry has no integer `n`, a `kind` other than `rig` / `post`, or a rig version has a non-null `rig_version` | fix the entry ([PROJECT.md § Versions](PROJECT.md#versions)) |
| `STILL_MALFORMED` | an `evidence[]` entry of `kind: "still"` lacks `path` or a 64-hex `sha256`, has a `camera` other than `"fixed"`, or no `frame` ≥ 0 | write it in the still-frame shape ([PROJECT.md § The rig review](PROJECT.md#the-rig-review)); it does not count as a still until it is |
| `RIG_ACCEPTED_WITHOUT_STILL` | Retired. Earlier Create releases refused accepted rigs without a still-frame record. | Historical still records remain readable. |
| `PAUSED_UNSIGNED` | `stage` is `paused` with no `{ "stage": "paused" }` sign-off, or `pause` finds no human one dated at or after the latest recorded move | the person who stopped it signs `paused`, then run pause |
| `PROVENANCE_MISSING` | a `rig` or `post` version has no `provenance.sections` object | write the version's provenance: the config it was built from and, per section, its citations |
| `SECTION_UNCITED` | a section that needs a citation (§ Provenance) is listed with no entries, or is in the read config and not listed | cite the guide sentence or delegation it rests on; if there is none, ask for one, or take the section out of the config before the version is shown |
| `SECTION_UNKNOWN` | a `rig` version's provenance names a section that is no `@rig-c/parts` section and not on the placement table | name the section as the config does; a misspelt name leaves the real one uncited |
| `ENTRY_UNCITED` | an entry has neither a non-empty `quote` nor `delegated: true` (or is not an object) | quote the sentence it follows, cite the delegation, or remove the entry |
| `CITATION_GUIDE_UNKNOWN` | an entry's `guide` is missing or names no framing, waypoint or post item | name the answer id it rests on |
| `CITATION_GUIDE_SILENT` | an entry's `guide` names an item with no answer | answer the item (it is also reported on its own) |
| `CITATION_WRONG_PHASE` | a `post` version's entry cites a rig waypoint | cite the post item (or framing answer) it rests on; a rig change is a new rig version |
| `QUOTE_NOT_FOUND` | an entry's `quote` is in no `verbatim` or `additions[].verbatim` of the cited answer (current or `history[]`). If removing one matching pair of outer marks (`「」`, `『』`, `""`, `''`, `“”`, `‘’`, `()`, `[]`) would make the quote equal to an entire stored field, a separate line names the marks and the exact field path | quote the stored sentence exactly; feedback no guide covered goes into `additions[]` first |
| `RIG_VERSION_AT_INVALID` | a rig version in the project's own `versions[]`, including a pre-interview version, has an `at` other than a calendar date `YYYY-MM-DD` or an ISO date-time with mandatory `Z` or `±HH:MM`, or parsing fails or its written calendar date is invalid | restore the named version's valid build date from its record. Package, rig acceptance, rig signoff and handoff refuse the selected version before writing |
| `VERDICT_MALFORMED` | a verdict lacks `by`, `at` or `verbatim`, has a `verdict` other than `accepted` / `bounced` / `provisional` or a `review` other than `rig-review` / `direction-review`, `on_items` is not a list, or an item lacks `id` or a valid `answer_was` | restore the stored entry to the verdict shape ([PROJECT.md § Versions](PROJECT.md#versions)); numbered verdicts are read-only |
| `FEEDBACK_UNANSWERED` | a human bounced verdict on version N, not withdrawn, and a version later than N exists while none lists `{ "version": N, "verdict": i }` in `answers_feedback` | list it in the version built from that feedback, with what changed in `changed`; if the feedback was not acted on, say so to the user — a later version that ignores it is the bounce coming back |
| `PRE_INTERVIEW_ORDER` | pre-interview versions follow a create-built version, or migrated history has nonpositive, repeated or out-of-order version numbers | put historical versions first, with strictly increasing `n` and consistent references |
| `PRE_INTERVIEW_ORIGINAL_N_MISSING` | a pre-interview version omits its source id or it is not a number, string or null | copy its original id unchanged into `original_n` |
| `PRE_INTERVIEW_ORIGINAL_N_DUPLICATE` | two migrated versions have the same non-null `original_n` | restore their distinct source ids; repeated nulls are allowed |
| `PRE_INTERVIEW_CONFIG_LOST_MALFORMED` | `config_lost` lacks nonempty note and source strings, accompanies a non-null `provenance.config`, or is on a create-built version | record `{ note, source }` only on a pre-interview version whose config was lost, or restore its surviving config |
| `PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED` | `outputs_lost` lacks nonempty note and source strings, has an unknown key or malformed/empty `recorded` `{ path, sha256 }` bindings, names a `recorded` path that overlaps `outputs` or is readable on disk, accompanies non-empty `outputs` without `recorded`, or is on a create-built version | restore the original loss declaration on the pre-interview version and keep surviving files in `outputs[]`. Legacy `{ note, source }` is valid beside `outputs: []` |
| `PRE_INTERVIEW_HISTORY_MISSING` | a pre-interview version has no `original_verdicts` array | preserve its complete original verdict array |
| `PRE_INTERVIEW_VERDICT_LOST` | an original verdict has no unchanged `as_recorded` at the matching index, or an extra `as_recorded` has no original | restore the complete original history and its order |
| `PRE_INTERVIEW_VERDICT_UNKNOWN` | an original verdict string has no exact entry in `PRE_INTERVIEW_VERDICTS` | retain it and obtain an explicit mapping, without guessing |
| `PRE_INTERVIEW_VERDICT_MISMATCH` | a converted verdict disagrees with that table | apply the stated mapping and retain the original string |
| `PRE_INTERVIEW_OUTPUT_MALFORMED` | historical outputs are empty without a loss declaration, or lack a distinct project-relative path, lowercase sha256 or nonnegative integer size | list each frozen file with its path, sha256 and bytes |
| `PRE_INTERVIEW_OUTPUT_UNREAD` | a historical output is unreadable or resolves outside the project | restore the frozen file under the project |
| `PRE_INTERVIEW_OUTPUT_CHANGED` | a historical output's hash or size differs from the recorded value | restore the frozen bytes and inspect the migration record |
| `VERDICT_MALFORMED` (pre-interview) | an imported verdict lacks create-shaped fields, a valid date or a nonempty source, or `verbatim: null` lacks a nonempty note recording the user | preserve the source and write the record in `note`. A create-built version still requires the user's words |
| `FEEDBACK_REF_UNKNOWN` | an `answers_feedback` entry is not `{ version, verdict }` integers, names no version or no verdict index, or names a version not earlier than its own | point it at the verdict it answers |
| `FEEDBACK_ITEM_UNKNOWN` | an `on_items[]` id is no framing, waypoint or post item | name the answer the feedback is about; a decision no prompt reaches becomes an `x_` prompt at its waypoint, and the item names that waypoint |
| `FEEDBACK_NOT_ADDED` | an item is `not-asked` and its answer has no `additions[]` entry with `source: "polish feedback, v<N>"` quoting the verdict, or a recorded Review feedback route has no matching addition for its exact comment | restore the original routed addition in the cited guide's `additions[]` (numbered verdicts are read-only) |
| `DELEGATION_NOT_GIVEN` | an entry is `delegated: true`, and no answer of the cited item (current or `history[]`) is a delegation or carries an `agent_decision` — or the delegation has no `agent_decision` | cite the sentence instead, or ask the user; a user answer is not a delegation unless it left part open and the agent's decision is written beside it |
| `RIG_TYPE_UNKNOWN` | the answered `rig_type` (the user's `value`, or the agent's decision on a delegation) is none of `character.idle`, `character.complex`, `character.monster`, `fullscreen.minimal`, `fullscreen.game_logic` | write the value the answer means ([INTERVIEW.md](INTERVIEW.md)); an illustration CG is `fullscreen.minimal` or `fullscreen.game_logic` |
| `CG_GATES_UNREAD` | a CG project's `rig` version (§ CG gates) has no config at `provenance.config.path` under the project with the recorded sha256, or the requirements file its config names is not there, under the project, a JSON object | keep the config the version was built from, and its requirements file, under the project (`evidence/v<N>/`) and record the config's path and sha256 |
| `CG_GATE_UNDECLARED` | a CG project's `rig` version's config lacks `assemble.editor_receipts.trace_parts: true` or a `requirements` path, or its requirements file lacks `seam_over_motion.required: true` or an integer `boundary_colour.max_step_excess`; `path` names the field | declare it and rebuild; a refusal parts then gives is the art's to fix, not a reason to drop the gate |
| `CG_BOUNDARY_ALLOWANCE_RAISED` | a CG version's requirements file declares `boundary_colour.max_step_excess` above 12 | declare 12 or less; fix the piece's image or mesh that the step points at |
| `CG_GATE_UNDECLARED` (behind-part seams) | a CG rig version from `CG_BEHIND_SEAMS_SINCE`, or without a readable `at`, lacks a nonnegative integer `behind_seams.threshold`, or supplies an invalid pair threshold; the field path and found value are named | declare `behind_seams.threshold` from 0 through 12 in the config's requirements file and rebuild; pair thresholds must also be from 0 through 12 |
| `CG_BEHIND_SEAMS_THRESHOLD_RAISED` | a CG rig version from `CG_BEHIND_SEAMS_SINCE`, or without a readable `at`, declares `behind_seams.threshold` or a `behind_seams.pairs[].threshold` above 12 | declare 12 or less and fix the image or mesh behind the seam, then rebuild |
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
`accepted`, and optional `still`); exit `1` prints the first refusal on stderr as
`rig-create: CODE: message`; exit `2` on a usage error (`HANDOFF_RIG_INVALID`,
`HANDOFF_TOO_MANY_ARGUMENTS`, `UNKNOWN_OPTION`).

| Code | Fires when |
| --- | --- |
| `PROJECT_JSON_MISSING`, `PROJECT_JSON_INVALID` | as above |
| `HANDOFF_RIG_INVALID` | `--rig` is missing a value or its value does not select a positive integer. Supply a rig version number such as `3` or `v3`, or omit `--rig`. |
| `HANDOFF_TOO_MANY_ARGUMENTS` | more than one project folder is supplied. Name one folder or use the current folder. |
| `RIG_VERSION_UNACCEPTED` | no live rig version has an accepted human rig-review verdict, or the latest live rig is newer than the accepted rig. If a reopen or amendment made the last acceptance historical, the message names its verdict and the cutoff entry |
| `PRE_INTERVIEW_CONFIG_LOST` | handoff would select an accepted pre-interview rig with a declared lost config. Build and accept a new rig with its retained config before post work |
| `PRE_INTERVIEW_OUTPUTS_LOST` | handoff would select an accepted pre-interview rig with lost outputs. Build and accept a new rig with surviving frozen outputs before post work |
| `POST_ON_UNACCEPTED_RIG` | `--rig <n>` names no rig version or names a rig version without an accepted human rig-review verdict |
| `POST_ON_SUPERSEDED_RIG` | `--rig <n>` names a different accepted rig version from the current handoff target |

## The review command

`rig-create review` and `rig-create parts-review` are retired and refuse with
`NUMBERED_WRITER_REMOVED` (exit 2) before reading or writing `project.json`.
`check` continues to validate stored `versions[].verdicts[]` and
`answers_feedback` entries, and `comment --from-review <actId>` uses
`REVIEW_OPTION_MISSING` when a chest-landmark carrier omits `--config`.

| Code | Fires when |
| --- | --- |
| `PROJECT_JSON_MISSING`, `PROJECT_JSON_INVALID` | as above |
| `REVIEW_VERSION_INVALID` | Retired. Earlier `review` writer invocations refused an absent or non-integer version argument. |
| `REVIEW_OPTION_MISSING` | an ingested chest-landmark comment carrier (`comment --from-review <actId>`) lacks `--config`. Supply the project-relative working config path. |
| `REVIEW_TOO_MANY_ARGUMENTS` | Retired. Earlier `review` writer invocations refused extra positional arguments. |
| `REVIEW_VERSION_UNKNOWN` | Retired. Earlier `review` writer invocations refused an unknown `versions[]` number. |
| `REVIEW_WRONG_KIND` | Retired. Earlier `review` writer invocations refused a `--review` stage mismatched to the version kind. |
| `FEEDBACK_ITEM_DUPLICATE` | Retired. Earlier `review` writer invocations refused duplicate `--item` identifiers. |
| `FEEDBACK_ITEM_UNKNOWN` | a stored verdict `items[]` entry names no framing, waypoint or post item. Restore the recorded target identifier. |
| `FEEDBACK_ITEM_CONTRADICTS` | Retired. Earlier `review` writer invocations refused an `answer_was` value contradicted by the record. |
| `FEEDBACK_ITEM_AMBIGUOUS` | Retired. Earlier `review` writer invocations refused an unnamed `answer_was` on a partially delegated sentence. |
| `FEEDBACK_ITEM_NOT_APPLICABLE` | Retired. Earlier `review` writer invocations refused feedback on a not-applicable item. |
| `FEEDBACK_ITEM_SILENT` | Retired. Earlier `review` writer invocations refused feedback on an unanswered item. |
| `FEEDBACK_ITEM_INHERITED` | Retired. Earlier `review` writer invocations refused a `not-asked` route on an inherited collection answer. |
| `FEEDBACK_QUOTE_NOT_IN_VERBATIM` | Retired. Earlier `review` writer invocations refused a `--quote` outside `--verbatim`. |
| `FEEDBACK_QUOTE_NOT_NOT_ASKED` | Retired. Earlier `review` writer invocations refused `--quote` or `--value` outside `not-asked` items. |

## Warnings

Exit `0`. Bookkeeping that names no missing decision.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `PRE_INTERVIEW_UNMIGRATED` | `x-pre_create.versions` still holds history awaiting migration | follow [PROJECT.md's migration steps](PROJECT.md#migrating-work-done-before-the-interview), preserving originals and outputs before moving the entries. The warning preserves the existing check exit code while migration is pending |
| `STAGE_VALUES_STALE` | the record's `stage_values` differs from `src/stages.ts` | the next `advance` or `step-status` write regenerates it; the warning blocks nothing until then. In a collection, no writer rewrites it yet, and it blocks nothing |
| `CREATE_PIN_MISSING` | a standalone project has no `package.json`, `package.json` is unreadable, or `package.json` does not declare `@rig-c/create` in `dependencies` (collection members share their collection's manifest) | restore `package.json` (as written by `rig-create init`) when missing or unreadable, then run `rig-create packages upgrade --by <operator>` to pin `@rig-c/create` at the running release and record the move |
| `CREATE_PIN_MISMATCH` | `package.json.dependencies[@rig-c/create]` differs from the running `@rig-c/create` version | `rig-create packages upgrade --by <operator>` to move an older pin to the running release, or run the project's declared `@rig-c/create` |
| `QUESTION_SET_STALE` | `interview.question_set` does not name the installed `@rig-c/parts` version | `rig-create packages upgrade --by <operator>`; it moves the string to the pinned parts in the same validated write and records the move ([PROJECT.md § Updating a project's release pins](PROJECT.md#updating-a-projects-release-pins)) |
| `SECTION_RETIRED` | the table places a section on a waypoint or post item, but the installed parts no longer has it | drop it from the table and the record's `config[]` |
| `WAYPOINT_CONFIG_STALE` | a record waypoint's `config[]` is not the set of sections parts places there | `rig-create packages upgrade --by <operator>`; it regenerates `config[]` from the installed parts in the same validated write and records the move |
| `WAYPOINT_UNKNOWN` | the record has a waypoint no parts section is placed on | remove it, or place a section on it |
| `FEEDBACK_OPEN` | the latest version has an unanswered human bounced verdict and no numbered version is built after it yet. If `current.direction.adopted.version` names that post, the warning quotes the owner's open comment and the JSON exposes it in `feedback[].open_direction_comment` (check) and `open_direction_comments[]` (next) | rebuild the current direction and pass repeatable `--answers-feedback <version>:<verdict>` to `record direction --from`, or for a numbered project list the verdict in the next version's `answers_feedback` |
| `PROVENANCE_CONFIG_CHANGED` | a version's `provenance.config.path` is present but its sha256 is not the recorded one, so its sections were not read | regenerate the config from the recorded command, or leave it: the sections provenance lists were checked |
| `DIFF_MAP_MISSING`, `DIFF_MAP_NOT_AGENT`, `DIFF_MAP_REPORT`, `DIFF_MAP_STACK_MISMATCH`, `DIFF_MAP_POLICY`, `DIFF_MAP_COMPONENT_UNLISTED`, `DIFF_MAP_COMPONENT_UNKNOWN`, `DIFF_MAP_STATUS`, `DIFF_MAP_CLASS`, `DIFF_MAP_CLASS_WHY` | a draft at unsigned `parts-review` lacks a valid agent map for its retained stack; the publication reader omits the approval subject, and bound draft writers and `job open` print the named findings as WARNs while draft registration remains usable | prepare the producer report and record agent classifications with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent`, then run `rig-create job open` to publish and ask the prepared approval subject; the person's approval is still required |
| `DIFF_MAP_PREDATES` | a gated parts-review sign-off predates `DIFF_MAP_SINCE` and has no diff_map | preserve the record and include the map when parts are reviewed again |
| `DIFF_MAP_ON_SIGNOFF_LEGACY` | a `parts-review` sign-off dated before `DIFF_MAP_AGENT_SINCE = 2026-11-09T00:00:00Z` carries `diff_map` on the sign-off entry | preserve the historical record; record future component classifications on `project.json.diff_map` with `rig-create diff-classes --diff-report <path> [--triage-file <file> \| --component <id>=<status>:<why>] --by agent` |
| `PARTS_REVIEW_PREDATES_STAGE` | the project passed `plan-approved` (its first sign-off dated before 2026-11-04) before `parts` and `parts-review` existed, is past `parts-review`, and has no `parts-review` sign-off; the message names the project | nothing is assumed: no sign-off is written for it. A person may still review the parts and sign `parts-review`, which clears it ([PROJECT.md § The parts are reviewed before rigging](PROJECT.md#the-parts-are-reviewed-before-rigging)) |
| `CG_GATES_CONFIG_LOST` | a CG rig has a valid pre-interview `config_lost` declaration and no config; may accompany `CG_GATES_PREDATE` | preserve its loss note and source; build and accept a new rig with its retained config before post work |
| `CG_GATES_PREDATE` | a CG project's `rig` version was built with `@rig-c/parts` older than 2.4.0, before the CG gates existed (§ CG gates) | nothing for that version; the next CG version declares the gates |
| `CG_GATE_UNDECLARED`, `CG_BEHIND_SEAMS_THRESHOLD_RAISED` (behind-part seams) | the same missing/invalid or raised behind-part seam threshold on a CG rig version dated before `CG_BEHIND_SEAMS_SINCE` | preserve history; declare the gate with threshold at most 12 on the next CG rig |
| `REOPEN_SIGNOFF_LAPSED` | a human sign-off (stage or checkpoint) is history because of a `reopens[]` entry, and no live sign-off of the same stage and checkpoint exists; one per approval, at its latest lapsed record, naming the reopen (§ Reopening stages) | relay the owner's renewed approval with `signoff` and `--owner-chat` (with `--checkpoint <id>` for a checkpoint; record `current.<kind>` first for a review stage) |
| `REOPEN_VERDICT_LAPSED` | the latest human rig-review or direction-review acceptance is history because of a `reopens[]` entry, and no live acceptance of that review exists; the message names the verdict and the reopen | numbered versions and verdicts are read-only, so no live numbered acceptance remains on that review |

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
`INTERVIEW_INCOMPLETE`, `ANSWER_MALFORMED`, `SIGNOFF_*`,
`PAUSED_UNSIGNED` and `STAGE_VALUES_STALE` fire as for a project, against the
collection's stages.

For a member with `current` outputs, `collection pin` records a
`kind: "current-rig"` pin with the registered project path, the SHA-256 of
its exact record bytes, the collection commit holding those bytes, and
`current.rig.files_sha256`. The pin binds the member record and rig inventory.
Proof of which inputs were used to compose the collection output requires a
separate receipt.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `COLLECTION_USAGE` | `collection` omits its mode, `pin` or `--check` receives more than one folder, `pin --changed` lacks a value, or `answer` receives invalid arguments (exit 2) | use `collection pin [<dir>]` with a sentence if passing `--changed`, `collection --check [<dir>]`, or `collection answer <question> [<dir>] --by <who>` with either `--value-file <file>` or `--defer-until <stage>` and `--reason-file <file>` |
| `COLLECTION_JSON_MISSING` | no `collection.json` in the folder | run in a collection folder, or name one |
| `COLLECTION_JSON_INVALID` | the file is not a JSON object | fix the JSON |
| `COLLECTION_ITEM_SILENT` | a collection question, framing answer or waypoint guide is `null` and the stage is past `interview` (a post item guide: past `post-interview`), or a collection question deferral is past `until_stage` | record an ordinary collection question answer with `collection answer --value-file`; for shared guides, answer, delegate or use `"per-member"` |
| `COLLECTION_ANSWER_DEFERRED` (WARN) | a collection-scope question has a valid `{ deferred: { by, at, reason, until_stage } }` answer before its deadline | record an ordinary answer with `collection answer --value-file` before `until_stage`; the deferral is never inherited as a value |
| `MEMBER_MALFORMED` | a `members[]` entry is not an object with a string `name` | fix the entry |
| `MEMBER_PROJECT_MISSING` | a member's `project.json` (its `project` path, default `members/<name>/project.json`) is missing or not JSON | restore it, or remove the member |
| `PIN_STALE` | the default pin differs from the member's latest build, or an explicit pin's recorded rig version is absent or differs in its file list, variants or recorded/on-disk hashes | make the collection output again from the current builds and `collection pin`; or rebuild the member to the pinned build |
| `PIN_MISSING` | a member has no pin in that version | the same: a new collection version pins it |
| `PIN_UNKNOWN_MEMBER` | that version pins a name not in `members[]` | register the member again, or make a new collection version without it |
| `PIN_MALFORMED` | a numbered pin lacks `{ member, version (number or null), rigs[] }`, a `current-rig` pin lacks `{ member, record: { path, sha256, commit }, rig: { files_sha256 } }` with a full commit ID and SHA-256 digests, or the checked collection version has multiple pins for a member with a `current-rig` pin | restore a single valid pin for the affected member or record a new collection pin |
| `PIN_SELECTION_INVALID` | a persisted pin carries a selection other than `"explicit"` with a positive integer rig version | restore the pin metadata or record a new collection pin |
| `PIN_MEMBER_COMMIT_UNVERIFIED` | a `current-rig` pin cannot be resolved in the collection repository to a regular tracked blob at the literal registered member path, or the blob fails its record or rig digest binding. `collection pin` also requires the live member path to use ordinary files and folders in that repository and the blob to match the exact working record bytes | restore the collection history and exact member record, or commit the live rig record and run `collection pin` for a new output |

`collection pin` refuses, writing nothing:

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `PIN_SELECTION_INVALID` | `--member` is malformed, duplicated, names an unregistered or current-data member, or selects an absent/non-rig version | omit `--member` for a current-data member. Use each numbered member at most once as `--member name=version`, selecting an existing rig version |
| `PIN_MALFORMED` | a member being pinned as `current-rig` has more than one registration in `members[]` | keep one registration for that member and rerun `collection pin` |
| `PIN_NO_MEMBERS` | `members[]` is empty | add members |
| `PIN_NO_BUILD` | a current-data member lacks a valid `current.rig`, a numbered member has no rig version, its version lists no model or atlas, or a rig file has no sha256 and is not on disk | build and record the member's rig before pinning |
| `PIN_SOURCE_DRIFT` | a rig file on disk does not hash to the numbered member version that lists it, the collection record or a current pin source changes during pinning, or another collection pin writer is active | record a numbered rebuild as a new member version. If a source changed or another writer is active, reread the collection once the member records and outputs are stable, then retry |

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `MEMBER_UNREGISTERED` | a folder under `members/` is not in `members[]` | register it, or remove it |
| `OUTPUT_CHANGED` | a collection output on disk does not hash to the version that recorded it | outputs are frozen when pinned: restore it, or make and pin a new version |
| `PIN_MEMBER_EARLIER` (WARN) | the committed rig verifies and the member has a different live rig set digest or no live rig to compare | keep the pinned output, or prepare a new output and pin the live rig |

`collection-binding` refuses, writing nothing:

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `COLLECTION_BINDING_USAGE` | `--out` is missing a value, duplicated, empty, or followed by an unknown flag or extra directory | pass at most one `<member dir>` and optional `--out <project-relative path>` |
| `COLLECTION_BINDING_PATH_INVALID` | `--out` is absolute, leaves `<member dir>`, equals `project.json` or `collection.json`, or traverses a symlink at the member root, parent directories or destination | pass a clean project-relative path inside `<member dir>` (default `evidence/collection-binding.json`) |
| `COLLECTION_BINDING_NOT_A_MEMBER` | `<member dir>` does not have `project.json` inside `<collection>/members/<name>/` with `../../collection.json` (`rig-create/collection@0`) | run `rig-create collection-binding` on a collection member directory |
| `COLLECTION_BINDING_MEMBER_MISMATCH` | `project.json.name` does not match the member folder name, `project.json.collection` disagrees with `collection.json.name`, or `collection.json.members[]` does not list `{ name, project: "members/<name>/project.json" }` | align `project.json` and `../../collection.json` for this member |
| `COLLECTION_BINDING_INHERITED_INVALID` | `../../collection.json` lacks a valid `interview` (`framing`, `waypoints`, `post.items`), a member answer with `basis: "inherited"` has no answered collection entry, or `collection-binding` cannot validate the resulting record | answer the inherited question on the collection first (`rig-create collection answer`) or fix the member's answer basis |

## Reopening stages

The check continues to read and validate historical `reopens[]` entries
and their linked Review acts. Each entry retains `from_stage` as evidence
of the stage the project had reached when that entry was recorded.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `REOPEN_STAGE_UNKNOWN` | a historical target is unknown, `paused` or `accepted` | restore the recorded stage from the original evidence |
| `REOPEN_NOT_PASSED` | a historical target is later than its own `from_stage` and signatures/versions dated by the entry | restore the original stage history and evidence |
| `REOPEN_MALFORMED` | `reopens` is not a list, an entry lacks its human signature, `from_stage`, valid date or status snapshot, or `source` is not text | restore the named entry to the [historical record shape](PROJECT.md#reopening-a-passed-stage) |
| `SIGNOFF_NOT_HUMAN` | a historical reopen is signed by agent, case-insensitively | restore the original human signature |

Sign-offs and checkpoints at or before their applicable reopen are historical.
Live handoff requires a later build and acceptance when the cutoff covers rig-review.
A cutoff covering only post work preserves the unaffected rig acceptance.

`REOPEN_SIGNOFF_LAPSED` and `REOPEN_VERDICT_LAPSED` report approvals lapsed by
historical reopens. Approvals lapsed by an amendment appear in
`amendments[].lapsed` (§ Forward amendments).

## Forward amendments

`rig-create amend` records a human correction against an artifact and its
owning stage. It shares approval cutoff rules with historical reopens, retains the current
stage, and checks the complete candidate before writing. New records carry
`target`, `by`, clock-supplied `at`, unchanged `verbatim`, optional `source`
and new input `changes` hashed by the writer. Existing records acquire no new
obligation. Amended reports add the named lapse and upstream lists and the
`keep_by_binding` list, which only an `interview-answer` amendment fills. The fixed G table and re-signing contract are in
[PROJECT.md](PROJECT.md#forward-amendments).

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `AMENDMENT_MALFORMED` | amendments is not a list, or an entry lacks a human name, valid date, verbatim or optional text source | restore the named amendment to the writer's record shape |
| `AMENDMENT_TARGET_INVALID` | target lacks a supported kind, artifact id or ordered non-terminal stage, or a draft amendment fails to name one registered draft owned by `parts-review`. A changed-parts draft amendment recorded at `rigging` while a live parts-review signoff exists needs a retained target parts inventory and that signoff bound to a registered draft with a parts inventory. An `interview-answer` target must name a question of this interview by id or answer path | supply the artifact and its owning stage, and for a draft the registered target with its retained inventory |
| `RIGGING_DRAFT_PARTS_CHANGED` | a draft at `rigging` has producer parts that differ from the signed-off parts | record the owner's authorization with `rig-create amend parts-review <dir> --kind draft --target <id> --change <draft project-relative parts.json> --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>`, then [sign from the recorded approval for those bytes](PROJECT.md#the-parts-are-reviewed-before-rigging) |
| `AMENDMENT_CHANGES_INVALID` | new input bindings are empty, duplicate or lack paths and lowercase SHA-256 hashes. At recorded and effective `rigging`, a draft amendment also refuses when the changes omit the target draft's inventoried `parts.json`, any change path or hash differs from its registered binding, bytes on disk differ from the target's parts inventory, or the target's parts inventory matches the live parts approval | use `--change` with the target draft's actual project-relative `parts.json` and only paths and bytes that match its registered inventory. Restore the registered files or register a draft with changed parts |
| `AMENDMENT_INPUT_UNREAD` | a new input cannot be read or escapes the project, including through a symlink | retain readable input bytes under the project and amend again |
| `AMENDMENT_OPTION_INVALID` | required arguments are absent, option values are empty/repeated or the argument count is invalid (exit 2) | supply stage, kind, target, new input and signer once, repeating only change |
| `SIGNOFF_NOT_HUMAN` | an amendment is signed by agent, case-insensitively after trimming | obtain a person's signature |

The existing `UNKNOWN_OPTION`, `VERBATIM_*` and project-check codes also apply.
Every refused write leaves the record byte-identical. History checks validate
declared binding shape without requiring old inputs to remain working files.

## Recording signatures and review inputs

```sh
rig-create signoff <stage> --by <who> [--steps <id,id,...>] [--verbatim-file <file>]
rig-create signoff <stage> --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>
rig-create signoff parts-review --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator> [--structure-file <path>]
```

The command records a signature without moving the stage. Exit 0 records it. Exit 1
refuses the record and exit 2 refuses usage. All refusals leave the project
file unchanged.

`--from-review` refuses with `SIGNOFF_FROM_REVIEW_REMOVED` (exit 2). `--version`,
`--draft`, and `signoff parts-review|rig-review|direction-review` on a numbered
project without `current` refuse with `NUMBERED_WRITER_REMOVED` (exit 2). For
`current.parts`, run `structure-snapshot` for the current build and use its
default file or pass `--structure-file` for a custom retained path. An empty
declaration list is `entries: []`.

| Code | Fires when |
| --- | --- |
| `SIGNOFF_PICKS_REQUIRED` | `--from-picks` needs the current interview, plan-approved or rigging-interview stage and an ingested owner pick for every relevant answer; record the missing picks or use the regular sign-off route for other answers |
| `SIGNOFF_PICKS_PLAN_INCOMPLETE` | `--from-picks` cannot sign until the stage's required plan steps exist; add those steps through the plan writer |
| `SIGNOFF_OPTION_INVALID` | missing or repeated options, unknown stage, extra positional arguments, `--steps` outside a plan approval stage or with `--checkpoint`, or `--structure-file` outside `parts-review` (exit 2) |
| `SIGNOFF_NOT_HUMAN` | `--by` is `agent`, case-insensitively |
| `SIGNOFF_MALFORMED` | the record's `signoffs` is not a list |
| `SIGNOFF_REASK_PENDING` | a new `interview`, `rigging-interview` or `post-interview` stage signature has a pending option set in that stage. Show the named question with `rig-create job open --question <id>` if needed, record the owner's pick with `interview-answer --owner-chat`, then ask for sign-off. |
| `SIGNOFF_STEP_INVALID` | coverage is empty, ids are missing or repeated, or a requested step is outside the stage's phase (malformed `--steps` exits 2) |
| `SIGNOFF_CHECKPOINT_INVALID` | a covered step has no boolean `checkpoint_proposed`, an undecided delegation or no boolean checkpoint answer; `--checkpoint` also refuses a missing, ambiguous, disabled or wrong-stage step |
| `RIG_VERSION_UNACCEPTED` | Retired. Earlier numbered `signoff rig-review` writes used this refusal when the latest live rig lacked an accepted verdict; `handoff` still raises `RIG_VERSION_UNACCEPTED` above. |
| `UNKNOWN_OPTION` | an unsupported option, including `signoff --at` (exit 2) |
| `VERBATIM_UNREADABLE` | a verbatim file or stdin cannot be read; relative --verbatim-file paths resolve against the current working directory, not the project folder; use an absolute path or run from the file's folder |
| `VERBATIM_INVALID_UTF8` | the input cannot round-trip as UTF-8 through JSON (exit 2) |
| `REVIEW_NOT_HUMAN` | Retired. Earlier `review` writer invocations refused `agent` reviewers. |
| `REVIEW_OPTION_INVALID` | Retired. Earlier `review` writer invocations refused invalid or competing verdict options. |
| `FEEDBACK_REF_UNKNOWN` | `--answers-feedback` names no existing verdict on an earlier version, or a stored numbered `answers_feedback` entry fails its human-bounce target rule. Name an earlier human bounce in `--answers-feedback <version>:<verdict>` on `record direction`, or restore the stored `versions[vN].answers_feedback` entry |
| `FEEDBACK_REF_DUPLICATE` | `current.direction.answers_feedback` repeats the same `<version>:<verdict>` reference |

`signoff parts-review` on `current.parts` binds the retained structure snapshot
and checks `project.json` before writing. Refusals preserve the project file
bytes. `--checkpoint` records an enabled execution checkpoint without a plan
hash or phase approval.

## Prepared inputs and agent-found history bounces

`derived add` records an external operation, not pixel processing. The check
verifies both files of each `derived[]` entry tagged `prepared-input` against
its sha256. Untagged existing intermediates and empty or absent `derived[]`
are unchanged. No prepared files are silently registered or repaired.

| Refusal | Fires when | Clear it by |
| --- | --- | --- |
| `DERIVED_USAGE` | `derived` omits `add`, the arguments have the wrong count or lack a required value, a value-taking option other than `--source` is repeated, or a file result lacks both operation text and a supported mask receipt (exit 2) | use `derived add` with at most one project folder, one or more `--source <file>` arguments and one `--file <file or run folder>`. For a file result, supply `--operation <text>` or a supported mask `--receipt <path>` |
| `DERIVED_PATH_INVALID` | a source or result path is absolute, escapes the project, or resolves to the project root or `project.json`, or a source resolves to the result or is inside the result run folder | name distinct project-relative sources and a result, keeping all sources outside the run folder |
| `PLATE_RECEIPT_INVALID` | a declared receipt is absent, outside the project, symlinked, changed, has an unknown spec or key order, or disagrees with the recorded painting, mask or output | restore the producer receipt and record it with `derived add --receipt` |
| `MATTE_RECEIPT_INVALID` | a declared `rig-parts-matte-receipt/1` receipt, painting, raw mask, or output is malformed, absent, or disagrees with its path or sha256 binding | restore the producer receipt and its files, then record them with `derived add --receipt` |
| `EXTERNAL_RECEIPT_INVALID` | a declared `rig-parts-external-receipt/1` receipt is malformed, its kind differs from `mask`, or the receipt, painting or mask fails its path or sha256 binding | restore the producer receipt and its files, then record the painting as the sole `--source` and the mask as `--file` with `derived add --receipt`. Operation text is optional |
| `PLATE_RECEIPT_MISSING` | a derived plate first registered by a retained scene on or after `PLATE_RECEIPT_SINCE` lacks a receipt | record the producer receipt with `derived add --receipt` |
| `DERIVED_MALFORMED` | a prepared-input or run entry lacks required source, member or result path/hash fields, has unsorted/duplicate members, or a path escapes the project | use the prepared-input or run shape in PROJECT.md |
| `DERIVED_AT_INVALID` | a present `derived[].at` is not a valid ISO date-time with a zone | restore the timestamp recorded by `derived add` |
| `DERIVED_RUN_MISSING_LAYERS` | a `--file` run folder or `kind: "run"` derived entry has no `layers.json` member | pass a See-through run folder containing `layers.json`, or restore `layers.json` before recording |
| `DERIVED_FILE_UNREADABLE` | the source is absent or unreadable, or a present prepared result or run member cannot be read | restore the named source or make the named result or member readable |
| `DERIVED_FILE_CHANGED` | a source, result or run member's bytes (or the run digest) differ from its recorded sha256 | restore the recorded bytes, or record the new preparation |
| `AGENT_BOUNCE_MALFORMED` | a history entry dated on or after `AGENT_BOUNCE_SINCE` has a `bounce` other than `{ cause: "agent", failed, bar, replacement }` with non-empty text | write what failed, the bar, and its replacement |

Contract dates (`DISCARD_ACT_ACTOR_SINCE`, `CG_BEHIND_SEAMS_SINCE`, `DEPTH_MAP_BINDING_SINCE`, `HEAD_TURN_SINCE`, `AGENT_BOUNCE_SINCE`, `ASK_COVERAGE_SINCE`, `DIFF_MAP_SINCE`, `DIFF_MAP_AGENT_SINCE`, `APPLIED_REVIEW_SINCE`, `PROJECTION_ASKS_SINCE`, `ASSEMBLE_CONFIG_MATCH_SINCE`, `SETUP_PAINTING_SINCE`, `FIGURE_MASK_SINCE`, `FIGURE_MASK_INPUTS_SINCE`, `FIGURE_MASK_MATTE_RECEIPT_SINCE`, `CHOICE_ANSWERS_SINCE`, `BUILD_IDENTITY_SINCE`, `CONFIG_INPUTS_SINCE`, `DESCRIBED_DIRECTION_SINCE`, `SIGNOFF_TARGET_SINCE`, `SIGNOFF_PAIR_SINCE`, `SIGNOFF_ANSWERS_SINCE`, `INPUT_WRITER_SINCE`, `DIRECTION_SCENE_SINCE`, `OVERRIDDEN_ANSWERS_SINCE`, `RUN_RECORD_SINCE`, `RIG_CHECK_REPORT_SINCE`, `DRAFT_STACK_BINDING_SINCE`, `DIRECTION_PATCH_SINCE`, `PROGRESS_HISTORY_SINCE`, `SCENE_CONTEXT_SINCE`, `INTERVIEW_PAINTING_FIRST_SINCE`, `PARTS_CHECK_SINCE`, `PLATE_RECEIPT_SINCE`, `REVIEW_READ_SINCE`, `PARTS_VERDICT_DRAFT_SINCE`, `PARTS_VERDICT_LATEST_SINCE`, `PARTS_VERDICT_RECEIPT_SINCE`, `FIX_LEDGER_SINCE`, `CURRENT_PARTS_LEDGER_SINCE`, `DRAFT_CONFIG_INPUTS_SINCE`, `EDITED_PART_INPUTS_SINCE`, `DIRECTION_REVIEW_ADVANCE_SINCE`, `RIGGING_INTERVIEW_PAINTING_SINCE`, `REOPEN_RESTART_OWNER_CHAT_SINCE`, `REVIEW_ACT_ACTOR_SINCE`, `PLAN_STEP_ANSWER_SINCE`, `TURN_BODY_SINCE`, `SCRATCH_BINDING_SINCE`, `LOOP_SEAM_REPORT_SINCE` and `CAMERA_SCENE_BINDING_SINCE`) are the day the change lands, at 00:00Z, so they are never in the future; a record made earlier that day is checked against pilot projects before the change lands.

Exception for #117 (2026-11-06): `original_n` has no `*_SINCE` boundary because repo HQ counted zero consumer records with `pre_interview: true`, only the synthetic fixture being updated, and historical build dates cannot date a migration.

`AGENT_BOUNCE_SINCE = 2026-11-05T00:00:00Z` in `src/stages.ts` is
independent of the parts-review stage boundary. Read the history entry's own
`at`, including in a collection history cited by an inherited guide.

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `PLATE_RECEIPT_MISSING` | a derived plate first registered by a retained scene before `PLATE_RECEIPT_SINCE` lacks a receipt | retain the legacy record, or record its producer receipt |
| `DERIVED_RESULT_MISSING` | a regenerable prepared result is absent, including on a fresh clone | the message names the file and its recorded operation for regeneration |
| `AGENT_BOUNCE_LEGACY` | a free-form bounce has an entry date before the boundary, or no readable date | preserve its history; the warning names the new shape for future entries |

| HOLE | Fires when | Clear it by |
| --- | --- | --- |
| `PART_EDIT_UNCOVERED` | a dated `derived[]` result binds a named part image by path and sha256, was recorded after an execution checkpoint sign-off, and no later finalized parts-review verdict binds that part and sha256. Entries without `at` remain unclassified | on numbered records, restore the retained parts verdict covering those exact part bytes; for current builds, record `current.parts` and relay any owner chat sign-off |

`derived add` also applies the shared `PROJECT_JSON_INVALID` and
`SCHEMA_UNKNOWN` refusals before writing.

`PLATE_RECEIPT_SINCE = 2026-11-08T00:00:00Z` uses the earliest retained scene registration with matching derived index, path and sha256. Input plates are excluded. Every declared receipt is verified regardless of date or scene registration. `scene write` runs the same project checker before committing.

## Review packages

`BUILD_IDENTITY_SINCE = 2026-11-06T00:00:00Z` dates the build-identity findings by the rig version's `at`. Earlier or unreadably dated versions receive WARNs with the same named codes. An unreadably dated rig version is also refused by `RIG_VERSION_AT_INVALID`; the census for #164 found none among seven template and eighteen consumer rig versions, so this refusal has no date cutoff. The accepted manifest comes from the latest parts approval live at that version's build time; an unreadable build date uses the latest live approval and emits WARNs for any identity disagreement. The comparison reads declared hashes and the retained hash-bound verdict, including when the regenerable package is absent.

| Code | Condition | Remedy |
| --- | --- | --- |
| `REVIEW_PACKAGE_CONFIG_MISMATCH` | package config SHA256 differs from the version's provenance config SHA256 | preserve history and restore the version's recorded config and `review_package` bindings (numbered versions are read-only); record new rig builds with `rig-create record rig --from <dir> --config <file>` |

The package is not compared with a parts approval: parts may change after a rig exists, and the next rig version is built from the current parts (#981).

`rig-create review-package` is retired (`NUMBERED_WRITER_REMOVED`, exit 2).
Stored `versions[].review_package` records retain the complete sorted
package-relative file hashes and `open` command under `derived/review/v<n>/`,
keeping source files comparable through their hashes after the original build
directory is cleaned. `interview --check` continues to verify stored packages
read-only for create-built numbered rig versions. Post and pre-interview
versions are exempt.

| Refusal | Fires when | Clear it by |
| --- | --- | --- |
| `REVIEW_PACKAGE_MALFORMED` | a present `review_package` record lacks its config path/hash, source directory, file list or canonical open command | restore the recorded snapshot shape |
| `REVIEW_PACKAGE_CHANGED` | a present package has missing, extra or changed files, a symlink, or an invalid required layout. Rig acceptance and handoff refuse this for the selected version | inspect and restore its recorded frozen bytes |

| Warning | Fires when | Clear it by |
| --- | --- | --- |
| `REVIEW_PACKAGE_MISSING` | a create-built rig has no package record, or its recorded package is absent, leaving its figure mask unverified | numbered rig versions are read-only; restore `derived/review/v<n>` and its recorded `review_package` entry from git history if available, or record new builds with `rig-create record rig --from <dir> --config <file>` |

| Writer or checker finding | Fires when |
| --- | --- |
| `REVIEW_PACKAGE_USAGE` | Retired. Earlier Create releases refused missing, repeated or invalid `review-package` arguments with this code; `review-package` now refuses `NUMBERED_WRITER_REMOVED`. |
| `REVIEW_PACKAGE_VERSION_UNKNOWN` | Retired. Earlier Create releases refused an absent `review-package` target version with this code; `review-package` now refuses `NUMBERED_WRITER_REMOVED`. |
| `REVIEW_PACKAGE_VERSION_INVALID` | Retired. Earlier Create releases refused a post or pre-interview `review-package` target version with this code; `review-package` now refuses `NUMBERED_WRITER_REMOVED`. |
| `REVIEW_PACKAGE_PATH_INVALID` | Retired. Earlier Create releases refused an escaped or symlinked `review-package` source or destination with this code; `review-package` now refuses `NUMBERED_WRITER_REMOVED`. |
| `FIGURE_MASK_CHANGED` | the packager's declared mask is missing, unreadable, a non-file, or differs from its declared SHA-256. Restore the declared PNG before packaging |
| `FIGURE_MASK_MISSING` | the packager's retained requirements contain a malformed figure-mask declaration. Declare its path and lowercase SHA-256 before packaging |
| `REVIEW_PACKAGE_INPUT_MISSING` | a writer source or required layout entry is absent, or the checker finds a config-named input missing from the frozen inventory. The checker WARNs before CONFIG_INPUTS_SINCE by version.at and refuses from that date. Preserve history and package the complete named inputs on the next build |
| `REVIEW_PACKAGE_INPUT_INVALID` | a writer config is not a JSON object, a layout entry has the wrong kind, a copied tree contains a symlink, or a config-named directory input (such as `assemble.occluders[i].plate`) lacks a regular-file `receipt.json` declaring the installed parts' `PLATE_RECEIPT_SPEC` (or the installed parts exports none, or the frozen inventory records unreferenced sibling files inside that directory). The checker also reports an unreadable frozen config or unavailable config-file declarations, with unavailable declarations WARNed before CONFIG_INPUTS_SINCE by version.at and refused from that date. An existing project-level parts-loader refusal suppresses duplicate input findings |
| `REVIEW_PACKAGE_SOURCE_CHANGED` | Retired. Earlier Create releases refused source byte drift during `review-package` copying with this code; `review-package` now refuses `NUMBERED_WRITER_REMOVED`. |
| `REVIEW_PACKAGE_EXISTS` | Retired. Earlier Create releases refused an existing differing `review-package` output with this code; `review-package` now refuses `NUMBERED_WRITER_REMOVED`. |
| `REVIEW_PACKAGE_BUSY` | Retired. Earlier Create releases refused a concurrent `review-package` lock holder with this code; `review-package` now refuses `NUMBERED_WRITER_REMOVED`. |
| `REVIEW_PACKAGE_RECORD_CHANGED` | Retired. Earlier Create releases refused concurrent `project.json` edits during `review-package` copying with this code; `review-package` now refuses `NUMBERED_WRITER_REMOVED`. |

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

The check reads `config.json` if present and retained numbered rig
configs via their provenance paths and hashes. Core and absent projection add
no ground question or refusal. Unread retained files remain under the existing
provenance checks.

| Code | Finding and remedy |
| --- | --- |
| `ASSEMBLE_GROUND_UNANSWERED` | A readable current or retained config explicitly sets `assemble.project: "visible"` but the assemble guide has no valid ground answer. The guide must be dated from `PROJECTION_ASKS_SINCE` and have no pending Other pick or unresolved choice delegation for ground. Ask `plain` or `busy`, record the ground ask and value or a decided delegation, then write `assemble.ground` in the config. |
| `ASSEMBLE_CONFIG_ANSWER_MISMATCH` | A readable current or retained config differs from the decided projection or ground answer. Align the config with the recorded answer. Omitted fields take Parts defaults (`core` and `plain`). Pending and undecided answers are skipped. Refusal for answers dated at or after `ASSEMBLE_CONFIG_MATCH_SINCE` (2026-11-20T00:00:00Z), WARN for earlier or unreadable answer dates. |

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
| `APPLIED_REVIEW_LEGACY` | WARN for an omitted `review_origin` on a version dated before `APPLIED_REVIEW_SINCE` or without a readable date. Preserve its history. On the next build declare `null` if no feedback was used or bind the applied feedback. |
| `APPLIED_REVIEW_MALFORMED` | the declaration lacks its file path/hash, source, item id or applied result |
| `APPLIED_REVIEW_FILE` | the retained file is unavailable, escapes the project or is not a single-build feedback export |
| `APPLIED_REVIEW_SOURCE` | the source is missing, ambiguous or skipped, or the feedback inputs differ from its package |
| `APPLIED_REVIEW_RESULT` | the selected feedback item is missing or repeated, or its applied result differs |

`APPLIED_REVIEW_SINCE = 2026-11-06T00:00:00Z`. Pre-interview versions are
exempt. Explicit null declarations remain legal.

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
second finding for the same path. Parts owns limit validation and measurement;
frozen registration checks report every missing declaration in order (§ Frozen rig registration).
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
| `FIGURE_MASK_MISSING` | a busy visible config lacks a readable requirements file with a valid figure-mask path and lowercase sha256. Preflight checks the supplied config and registration checks the retained one | declare `setup_painting.figure_mask` in the config-relative requirements file |
| `FIGURE_MASK_CHANGED` | declared PNG is unreadable or its bytes differ from its declared sha256 | restore the PNG relative to requirements or update the declaration and derived record |
| `FIGURE_MASK_UNRECORDED` | no prepared-input record binds that mask and hash with at least one source and operation | record with `derived add`, naming matte, threshold and foreground subtraction in the operation |
| `FIGURE_MASK_MATTE_RECEIPT_INVALID` | a matching prepared figure mask declares a matte receipt that fails verification | restore the matte receipt, painting, raw mask and output, then record with `derived add --receipt` |
| `FIGURE_MASK_EXTERNAL_RECEIPT_INVALID` | a matching prepared figure mask declares an external receipt that fails verification | restore the external receipt, painting and mask, then record with `derived add --receipt`. A bound external mask receipt satisfies the figure-mask receipt requirement at `FIGURE_MASK_MATTE_RECEIPT_SINCE` |
| `FIGURE_MASK_MATTE_RECEIPT_MISSING` | a retained figure mask on or after `FIGURE_MASK_MATTE_RECEIPT_SINCE = 2026-11-19T00:00:00Z` lacks a bound matte receipt, dated by version.at | record the mask and its painting with `derived add --receipt` |
| `FIGURE_MASK_MATTE_RECEIPT_LEGACY` | WARN for a retained older figure mask bound by an operation and source hashes alone | keep the earlier record and bind the matte receipt for the next build |
| `FIGURE_MASK_INPUT_UNBOUND` | a present recorded package lacks the requirements or figure mask binding on or after `FIGURE_MASK_INPUTS_SINCE = 2026-11-06T00:00:00Z`, dated by version.at | preserve the historical package or restore its bound requirements and figure mask; record new builds with `rig-create record rig --from <dir> --config <file>` |
| `FIGURE_MASK_INPUTS_LEGACY` | WARN for those missing bindings before FIGURE_MASK_INPUTS_SINCE or with no readable date | preserve history and package both inputs on the next build |
| `FIGURE_MASK_LEGACY` | WARN for these findings on a record before `FIGURE_MASK_SINCE` or without a readable date | preserve the earlier record and declare and record the mask for its next build |


## Split rigging interview and labelled drafts

Historical `rig-review` verdicts on a rigging draft bound the project hash, joined source
hash and model of their acknowledged publication, retaining the exact act and its comments alongside the draft ID.
Historical draft receipts with a still retain its digest check.
When the registered inputs and model were byte-identical, historical numbered
registration carried the latest approval with its original job and act IDs; a
carried verdict with mismatched provenance or bytes triggers `REVIEW_ACT_LEDGER_INVALID`.

The explicit `interview.order.spec: "rig-create/stage-order@1"` switch enables
parts-only plan approval followed by a post-parts rigging interview. It is not
a date inference. Existing signatures keep their original scope. Draft inventory
is create-owned artifact identity, not producer provenance or reproducibility.

Stored `drafts[]` entries with `layout: "assemble-only"` retain the parts
manifest, part images, recomposite and other bound output under the draft root,
reading the producer from a bound assemble `run.json` when present (`draft-rig`
is retired; new outputs use `record parts` and `record rig`). `job open --draft`
uses the same draft identity as for a full draft. Existing standalone and build
drafts have no `layout` field and retain their rig output requirements.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `STAGE_ORDER_LEGACY` | WARN: order metadata is absent or the old contract is used | preserve historical answers; adopt explicitly with fresh rigging answers after parts review |
| `RIGGING_INTERVIEW_CONTEXT` | the order adoption (`interview.order.adopted_at`) lacks a readable date | restore the recorded adoption date |
| `DRAFT_RIG_MALFORMED` | malformed/duplicate draft identity, ambiguous layout, missing standalone parts inputs, an assemble-only inventory missing its parts bindings or carrying rig output, or a config-named input that leaves the project, is not a regular file, or is a directory without a regular-file `receipt.json` declaring the installed parts' `PLATE_RECEIPT_SPEC` (or the installed parts exports none), or a `config_inputs` directory binding does not bind `<directory>/receipt.json` with a string `spec` | restore the stored `drafts[]` entry and its explicit parts inputs |
| `DRAFT_RIG_REQUIRED` | an assemble-only draft is supplied as a rig source or target for a version, rig review, signoff, handoff, direction, a correction requiring a model, or a rig fix-ledger report | stored drafts are read-only; select a recorded draft that holds a rig output, or record a current rig build with `rig-create record rig --from <dir> --config <file>` |
| `DRAFT_RIG_STACK` | Retired. Earlier Create releases refused missing or ambiguous stack candidates during `draft-rig` registration with this code; `draft-rig` now refuses `NUMBERED_WRITER_REMOVED`. | Record current parts or rig outputs with `rig-create record parts` or `rig-create record rig`. |
| `DRAFT_RIG_STACK_UNBOUND` | a standalone or assemble-only draft's `files` has no SHA-256 binding for the recomposite beside its `parts.json` or, for a `rig/` directory, in `../render/`. For standalone drafts, refuses from `DRAFT_STACK_BINDING_SINCE = 2026-11-19T00:00:00Z` by `drafts[].at`; earlier standalone drafts WARN. The stack is optional with `--reuse` | preserve or restore the recorded draft; record new builds with `rig-create record parts` or `rig-create record rig` |
| `DRAFT_RIG_FILE` | a config-named input points to a dangling symlink, a config-named input lacks a config_inputs binding (WARN before CONFIG_INPUTS_SINCE; an absent key before DRAFT_CONFIG_INPUTS_SINCE is `DRAFT_CONFIG_INPUTS_UNRECORDED` instead), a config_inputs binding outside the draft root is missing, changed or leaves the project (a directory input, such as an occluder plate, by its `receipt.json`, whose declared spec must equal the binding's `spec`), or a present draft artifact is unreadable, changed, unexpected or escapes its root | restore its frozen config, parts and output files |
| `DRAFT_EDITED_PART_UNBOUND` | a draft's hash-bound `parts.json` declares `parts[i].provenance.edited_part`, but `config_inputs` has no regular-file binding (no `directory`) whose `sha256` equals the receipt's `sha256` (including an absent key, empty list, directory binding or wrong hash; `/<receipt.file>` is only a tie-break for naming which binding the finding reports). Refuses from `EDITED_PART_INPUTS_SINCE = 2026-11-15T00:00:00Z` by `draft.at`; earlier drafts WARN with this same code | preserve the historical draft or restore its `config_inputs` bindings; for new work, record current outputs with `rig-create record parts` or `rig-create record rig` |
| `DRAFT_CONFIG_INPUTS_UNRECORDED` | WARN: a draft recorded from CONFIG_INPUTS_SINCE and before DRAFT_CONFIG_INPUTS_SINCE has no `config_inputs` key while its sha256-bound config names inputs (by the installed parts' declarations, or by the pinned ones when the install has no `configFileReferences`). An install that could not declare them recorded nothing; a later absent key refuses `DRAFT_RIG_FILE`. A present key that misses a named input or binds a changed hash refuses `DRAFT_RIG_FILE` on both sides of the date | keep the record; record current outputs with `rig-create record parts` or `rig-create record rig` |
| `DRAFT_PARTS_INSTALL_BEHIND` | Retired. Earlier Create releases refused `draft-rig` when the installed `@rig-c/parts` trailed the draft producer's input declarations; `draft-rig` now refuses `NUMBERED_WRITER_REMOVED`. | Record current outputs with `rig-create record parts` or `rig-create record rig`. |
| `DRAFT_DECLARED_FILE_UNBOUND` | WARN at any date: a present file that the draft's `parts.json` declares under `painting_in_rig` is not bound in `drafts[].parts.files` | preserve the historical draft record; record new builds with `rig-create record parts` or `rig-create record rig` |
| `DRAFT_RIG_UNAVAILABLE` | WARN: declared regenerable draft artifacts are absent under the ignored draft root | restore the named recorded bytes before inspecting or rebuilding the draft; retained structure snapshots still verify |
| `ASSEMBLY_CONFIG_STALE` | Retired. Earlier Create releases refused `draft-rig` when declared config assembly inputs differed from `parts.json`; `draft-rig` now refuses `NUMBERED_WRITER_REMOVED`. | Record current parts outputs with `rig-create record parts --from <dir> --config <file>`. |
| `DRAFT_ASSEMBLY_CONFIG_UNRECORDED` | WARN: an accepted draft binds a legacy parts.json without an assembly config reading | preserve the accepted draft and use `rig-create record parts` for current builds |
| `DRAFT_PRODUCER_ASSUMED` | WARN at any date: no `run.json` is bound beside the draft's `rig.json` or at the assemble output root, so `drafts[].producer` reflects the `@rig-c/parts` version assumed when recorded | preserve the historical draft; regenerate current outputs with `rig-parts assemble` or `rig-parts rig` and record them with `rig-create record parts` or `rig-create record rig` |
| `DRAFT_PRODUCER_MISMATCH` | WARN at any date: `drafts[].producer` differs from the `package` in the bound `rig-run/1` stamp | restore `drafts[].producer` to match the bound `run.json` stamp, or record current outputs with `rig-create record parts` or `rig-create record rig` |
| `DRAFT_RIG_AS_VERSION` | draft role/identity/reserved paths are offered as a numbered version, review, package or handoff | build an independently authorised production rig |
| `STRUCTURE_DECISIONS_MISSING` | new-order numbered parts approval lacks its draft or explicit structure snapshot, or a current parts approval lacks its snapshot | run `structure-snapshot` and supply `--structure-file` when needed, including `entries:[]` when unchanged |
| `STRUCTURE_DECISIONS_INVALID` | snapshot schema/declarations/config binding are malformed or changed | retain the exact human-approved structure file |
| `STRUCTURE_DECISIONS_CONFLICT` | a structure snapshot contradicts the mesh/chest declaration of the config it binds | retain the snapshot written from that config |
| `STRUCTURE_DELTA_MISMATCH` | recorded structure_delta differs from the snapshot/config comparison | restore the version's recorded `provenance.structure_delta` (numbered versions are read-only) |
| `STRUCTURE_DELTA_REVIEW` | WARN: counted structure entries changed under the signed rigging meshes guide | cover changed structure in the rig-review verdict and sign-off |
| `PARTS_VERDICT_DRAFT_MISMATCH` | a parts-review sign-off's verdict `source.files[]` lists a file whose sha256 is in neither its `draft_id` draft's `parts.files[]` nor its `files[]` (the outputs a parts view that shows meshes also lists: `rig.json`, `mesh_report.json`, mesh rasters), or leaves out one of the draft's `parts.files[]`, matched as sha256 multisets and leaving out only the raster the draft's `parts.json` declares under `painting_in_rig`; an output the verdict does not list is not missing; the message lists up to three unmatched files on each side. `structure-snapshot` refuses it; the check refuses a sign-off dated from `PARTS_VERDICT_DRAFT_SINCE = 2026-11-08T00:00:00Z` or without a readable date and WARNs an earlier one | restore the recorded `draft_id` and parts-verdict binding on the historical sign-off, or preserve an earlier record |
| `DRAFT_RIG_USAGE` | Retired. Earlier Create releases refused malformed or unsupported `draft-rig` arguments with this code; `draft-rig` now refuses `NUMBERED_WRITER_REMOVED`. | Record current outputs with `rig-create record parts` or `rig-create record rig`. |
| `STRUCTURE_SNAPSHOT_USAGE` | `structure-snapshot` misses `--draft` when `current.parts` is absent, repeats a flag, takes an unsupported flag or more than one folder (exit 2) | use `structure-snapshot [<dir>] [--out <path>]` for `current.parts` (or pass `--draft <id>` for a recorded draft) |
| `STRUCTURE_SNAPSHOT_DRAFT_UNKNOWN` | `drafts[<id>]`: no recorded draft has the `--draft` id | name an existing id in `project.json.drafts`, or record `current.parts` with `rig-create record parts` and run `rig-create structure-snapshot` without `--draft` |
| `STRUCTURE_SNAPSHOT_CONFIG_CHANGED` | `drafts[i].config` is absent, unreadable, escapes the project or no longer hashes to its recorded sha256 | restore the recorded config bytes, or record the changed config on `current.parts` with `rig-create record parts` |
| `STRUCTURE_SNAPSHOT_OUT_UNREAD` | `--out` is not one of the retained paths `partsStructureSnapshot` reads for `--draft <id>` (`evidence/structure-<encodeURIComponent(id)>.json` or `-<n>.json`) | omit `--out` or write to the expected path named in the refusal |
| `STRUCTURE_SNAPSHOT_OUT_INVALID` | `--out` is absolute or not a literal POSIX path, leads out of the project through a link, sits under a file, or names an existing entry that is not a regular file | name a new file under the project, for example `evidence/structure-<id>.json` |
| `STRUCTURE_SNAPSHOT_OUT_IGNORED` | `--out`, as written or with links followed, is under an ignored root | write the snapshot outside ignored roots, for example `evidence/` |
| `STRUCTURE_SNAPSHOT_OUT_EXISTS` | `--out` already holds bytes other than the snapshot (the same bytes are a no-op success) | name a new file; a retained snapshot is never overwritten |
| `DRAFT_REUSE_SOURCE` | a reused draft in `drafts[]` cannot find a distinct reviewed source with a valid retained parts verdict, or its prior record differs from or is missing at the SHA-256 named by `restarts[]` or `evidence/draft-reuse/<sha256>.json` | restore the referenced reviewed draft or `evidence/draft-reuse/<sha256>.json` snapshot and its verdict evidence |
| `DRAFT_REUSE_MISMATCH` | a reused draft differs from its source in a relative inventory path or SHA-256 for `parts.json`, `parts/` or a declared painting, or its recorded See-through layers differ from the bound manifest | restore the exact reviewed parts on the stored draft, or record current outputs with `rig-create record parts` |
| `DRAFT_REUSE_PRODUCER` | the reused draft's recorded producer or its local run stamp disagrees with the reviewed draft's producer. The inherited identity applies to the reused parts inventory. | restore the matching producer stamp on the stored draft, or record current outputs with `rig-create record parts` |

Each refusal names the record path and writes nothing in the corresponding writer.
`structure-snapshot` reads the draft's retained config. It also refuses with
`STRUCTURE_DECISIONS_INVALID` or `STRUCTURE_DECISIONS_CONFLICT` when its
candidate fails the snapshot rules (a draft config whose `meshes` is not an
object, or a part name that is not a valid pointer segment).


Missing ignored draft files are unavailable, not altered files. Existing files
still verify even when another artifact is missing. A parts-review structure
snapshot must be retained outside ignored roots (`evidence/`, for example);
the writer refuses ignored paths and aliases into them. On a clone its retained
snapshot is still hash/schema checked without requiring the regenerable config.
Production declarations are compared to the latest structure approval live at
their own build date, applying only amendments and historical reopens at or
before that date. Later approval changes preserve each earlier version's obligations. Delegated
framing uses the same central interview membership as source guides, so it
must be decided before the first plan approval or parts execution.

## Per-ask questionnaire choices

`CHOICE_ANSWERS_SINCE = 2026-11-06T00:00:00Z` labels legacy warnings; only
explicit stage-order@2 adoption activates the new-answer contract. Earlier
answers remain unchanged. See INTERVIEW.md for the frozen shapes and writers.

| Code | Trigger | Remedy |
| --- | --- | --- |
| `INTERVIEW_OPTIONS_USAGE` | malformed writer flags or unreadable CLI argument files (exit 2) | supply documented question, file and per-ask arguments |
| `INTERVIEW_OPTION_ID_INVALID` | `options[i].id` does not match `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/` | rename the option id to match `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/` |
| `INTERVIEW_OPTIONS_INVALID` | malformed set, missing or ill-typed option field (`id`, `kind`, `label`, `effect`, explicit `recommended` boolean), recommendation/cardinality/ask/fragment/assembly/constraint schema | draft a complete set using the closed schema and applicable asks |
| `INTERVIEW_OPTIONS_FILE` | missing, changed, nonretained, escaping, symlinked or nonregular option file, reused id/path | restore original bytes and retain a new id/path for redrafts |
| `INTERVIEW_OPTIONS_STALE` | changed displayed sha, source/parts/structure/rig/scene context, a changed or missing file bound by an adopted rig, a relevant amendment or historical reopen, unavailable fresh viewed bytes, or a source list that differs from the draft-time ordering rule during a fresh check; from `SCENE_CONTEXT_SINCE` a scene-kind set on a scene that is not current | restore the named bindings and redraft against the live context with `interview-options` |
| `INTERVIEW_CHOICE_REQUIRED` | newly answered adopted question lacks a choice, or Other is still pending at approval | explicitly pick each ask; resolve Other through a new tailored option and pick |
| `INTERVIEW_REASK_PENDING` | WARN: `project.json` holds a pending option set over the named question's decided answer | have the owner pick from the registered set via `job open --question <id>` and record the pick with `interview-answer`; the owner may keep the previous choice |
| `INTERVIEW_CHOICE_INVALID` | malformed picks payload, shown/value/coverage/verbatim drift, clock/identity/decision mismatch, a Review pick from an owner host opened for the agent (reviewer id `agent`), or an attempt to add a first answer under live approval | retain the shown snapshot and record exact human picks. For a correction, register a fresh set and re-sign the approvals named by next |
| `POST_OWNER_CHOICE_REQUIRED` | a writer attempts an agent decision or a new auto pick for `camera_depth`, `post_timing` or `post_composition` | register a set with `interview-options <id>`, ask the owner in chat for a concrete choice, and relay it with `interview-answer <id> --owner-chat` |
| `INTERVIEW_CHOICE_CONSTRAINT` | disallowed tuple or constrained Other/auto fragment has zero or multiple value-option matches | choose an allowed combination or redraft the set to offer that option |
| `CHOICE_ANSWERS_LEGACY` | WARN: no explicit choice adoption, or grandfathered current sentence/inherited answer | preserve source words/date; adopt explicitly and show a tailored option when asked again |
| `INTERVIEW_OPTIONS_SCENE_LEGACY` | WARN: a scene-kind set drafted before `SCENE_CONTEXT_SINCE = 2026-11-08T00:00:00Z` holds only under that day's rule, because its scene was not current (PROJECT.md "Scene option context"); one per pending set or answer path | preserve the record; redraft against the current context when the question is asked again |

`INTERVIEW_PAINTING_FIRST_SINCE = 2026-11-24T00:00:00Z` dates source interview
option sets by `drafted_at`. At or after that instant, `context.files` puts the
declared painting first when available, followed by the remaining inputs in
record order. Earlier sets use record order without a warning. Fresh validation,
including job publication, applies the same draft-time ordering rule to the
inputs available at drafting and to the inputs available at validation.

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
| `CORRECTION_SOURCE` | unknown/ambiguous/stale source (including a missing, malformed or spec-unbound `current.direction` when `--version` is omitted), stage/kind/config/handoff mismatch, or mutation under a live approval |
| `CORRECTION_PATCH_INVALID` | config-patch/1 grammar, keys, flags or pointer syntax invalid; no operation is replayed |
| `CORRECTION_APPLIED_INVALID` | a config-named input is missing from the handoff (WARN before CONFIG_INPUTS_SINCE) or has an altered hash, a draft handoff path (read relative to the feedback package) or the package itself resolves outside the project or is retained absolute, a draft `--feedback-file` is a directory named `.json` or a manifest file without that suffix, session/item/applied identity or embedded patch differs, optional `stageInputHash` is not a 64-lowercase-hex SHA-256, or a claimed checked result lacks its passing retained summary, has a FAIL/unknown named bar or no PASS bar, or marks a line-named skipped bar PASS |
| `CORRECTION_OUTCOME` | outcome is invalid/nonlater/unchanged (including an unchanged or missing `current.direction` on resolve, or signing the uncorrected `current.direction`), closure bytes are missing, model differs from Apply, origin differs, or closure is repeated |
| `CORRECTION_PART_IMAGE_BEFORE` | `part-image` artifact does not name a `parts-review` parent draft's bound `<parts.path>/parts/<part>.png`, `artifact.draft` disagrees with `on.id`, or `after` has no pixel changes from `before` |
| `CORRECTION_PART_IMAGE_MASK_SIZE` | `part-image` `before`, `after` or `mask` is not a readable PNG or `mask`/`after` dimensions differ from `before` |
| `CORRECTION_PART_IMAGE_OUTSIDE_MASK` | `part-image` `after` differs from `before` outside `mask` |
| `CORRECTION_PART_IMAGE_ADDED_ALPHA` | `part-image` `after` increases alpha (`afterA > beforeA`) outside `mask`; reports the number of outside texels and refuses before writing. Keep alpha restoration inside the declared mask |
| `CORRECTION_PART_IMAGE_ALPHA_COUNT` | present `artifact.added_alpha_texels` differs from the count of texels with `afterA > beforeA`; retain the original bytes and record the masked edit again |
| `DRAFT_PART_REPAINT_UNRECORDED` | Compare only named colour parts in the draft's hash-bound producer `parts.json`, never auxiliary depth maps. WARN only when that part has producer-declared `parts[i].provenance.edited_part`, its bound bytes differ from the immediately preceding draft's same part, and no live correction covers the exact parent/before/after pair, even with no correction records. Byte changes alone do not declare an edit; fresh splits without the declaration do not WARN. The warning itself records the historical gap: postdated correction records refuse, so preserve history on stored drafts and record new part edits on the current path through `assemble.edited_parts` and `rig-create record parts`. Existing refusal remains when a named part binds known repaint bytes with no live covering record (withdrawn, superseded, post-dated or wrong part/draft) |
| `CORRECTION_UNSUPPORTED_OUTCOME` | a named unsupported operation attempts supported completion |
| `CORRECTION_MESH_DELTA_INVALID` | `corrections` cannot bind a finalized mesh edit to one Parts result and its retained revision files, or the act and attachment already have a completion. Restore the exact source and Parts receipt, then replay on the recorded revision. |
| `CORRECTION_MESH_DELTA_REVISION` | A numbered rig version after completed mesh corrections does not bind the final Parts revision. Restore the recorded compile run record and revision bindings on the numbered version (or record current rig builds with `rig-create record rig --from <dir> --config <file>`). |
| `CORRECTION_PENDING` | attempted scoped approval/handoff relies on an unresolved active correction. Resolve the correction before approving or handing off the stage. |
| `CORRECTION_PATH_LEGACY` | WARN once when explicit corrections adoption is absent |
| `DESCRIBED_DIRECTION_REQUIRED` | a described correction on a post with authored direction uses @1 on or after `DESCRIBED_DIRECTION_SINCE = 2026-11-06T00:00:00Z`. Preserve the evidence and capture a new correction@2 request with the exact direction identity |
| `DESCRIBED_DIRECTION_LEGACY` | WARN for the same @1 authored-direction description before DESCRIBED_DIRECTION_SINCE, dated by correction.at. Preserve history and use correction@2 for the next request |
| `CORRECTION_OPEN` | WARN per active described-open or made preview/pending record |
| `CORRECTION_UNSUPPORTED` | WARN per active unsupported made operation; not duplicated as OPEN |

`part-image` writers store `artifact.added_alpha_texels` and report it in text
or JSON output. Alpha increases inside the existing mask are allowed, including
transparent-to-opaque texels. Historical records without the count remain readable;
a present count is checked against the retained PNGs. The newly detected unrecorded
draft transition only WARNs at every date, so it introduces no SINCE constant.

The remedy is to retain the original evidence, select its exact source/outcome,
resolve the correction, or amend its owning stage before changing approved work.
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
| `DIRECTION_FILE` | retained file is missing, ignored, nonregular, a symlink, escaping or not a literal POSIX relative path | retain the exact regular file in a non-ignored project folder such as evidence/direction-src/ and use its project-relative POSIX path |
| `DIRECTION_HASH` | document/model raw bytes differ from the declared SHA256 | restore the bound bytes or author a new version |
| `DIRECTION_RIG_UNKNOWN` | rig number/model hash/path does not resolve to the accepted version's compiled review-package model, or --rig disagrees | bind the exact retained accepted model |
| `DIRECTION_RIG_STALE` | document and post rig differ, current rig is superseded/unaccepted, or packaging would rebind a cited model | accept a new rig and author new direction on it |
| `DIRECTION_KEY_OUTSIDE_TAKE` | a key is outside `[0,duration]`, the first time is not zero, or timing does not end at duration | bound keys and supply endpoints |
| `DIRECTION_TIME_NON_MONOTONIC` | duplicate/decreasing take times or decreasing source time | strictly order take times and use nondecreasing source seconds |
| `DIRECTION_CITATION` | camera/timing citations, resolved selections or live approved step hashes do not match the retained request | preserve words and complete/reapprove the named answers/steps |
| `DIRECTION_VERSION` | post identity/number/path/config/output binding conflicts or is not uniquely later for authoring/current for acceptance | create a later uniquely numbered post and bind its document |
| `DIRECTION_SOURCE_CHANGED` | lock held, immutable destination exists, or any captured source differs before project commit | preserve published bytes and retry against frozen inputs |
| `DIRECTION_PATCH` | Retired. Earlier Create releases refused invalid direction patch input with this code. | Write the current direction spec with `rig-create direction write [<dir>] --file <intent.json>` and record the compose output with `rig-create record direction`. |
| `DIRECTION_CORRECTION_OUTCOME` | a correction@2 source/outcome differs from the exact direction post or `current.direction` identity, or a made direction closure lacks matching patch/base/result and the same rig | retain the exact `current.direction` or post bindings, and resolve a made patch only to its create-ingested result |
| `CORRECTION_DIRECTION_PATCH_FILE_REMOVED` | `correction` receives `--direction-patch-file` or resolves a `direction-patch` record (exit 2) | update the current direction spec with `rig-create direction write [<dir>] --file <intent.json>` and record the compose output with `rig-create record direction --from <dir> --direction specs/direction/direction.json` (with `--answers-feedback <version>:<verdict>` when answering an adopted bounce) |
| `DIRECTION_PATCH_FILE_REMOVED` | Retired. Earlier Create releases refused `direction patch` and `--patch-file` with this code; numbered direction writes now refuse `NUMBERED_WRITER_REMOVED`. | Write the current direction spec with `rig-create direction write [<dir>] --file <intent.json>` and record the compose output with `rig-create record direction`. |
| `DIRECTION_PATCH_LEGACY` | WARN for an existing record before `DIRECTION_PATCH_SINCE = 2026-11-19T00:00:00Z` that binds `versions[].direction_origin.patch` or a correction direction patch | preserve the historical record without reopening the old patch file; record future direction revisions through `direction write [<dir>] --file <intent.json>` and `record direction` |

Each message names the record path and a remedy. Code assertions accompany
negative controls; failed writer/transaction tests also assert unchanged record
bytes. Existing handoff, correction and provenance codes keep their meaning.

`rig-create/correction@2` covers authored-direction descriptions and the
`direction-patch` artifact. When `--version` is omitted on `correction record`
or `correction resolve`, the binding is `{kind:"current.direction",at,record_sha256,direction:{path,sha256}}`,
carrying the sorted-JSON SHA-256 of `current.direction` and the SHA-256 of its
bound direction spec, and resolves once `current.direction` and its bound
direction spec change at or after capture. With `--version`, post identities add
`direction:{path,sha256}` to `{kind:"post",n,config,model}`, binding the source rig's compiled model.
A described artifact remains `{kind:"description"}` with unchanged human words.
Its outcome is a changed `current.direction` or a later post with a different bound direction document hash,
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
| `COMPOSED_INPUT_MISMATCH` | `scripts/generate-composed-direction-fixture.ts`: the fixture directory has missing or unexpected entries, or its input path resolves through a symlink. Restore the retained fixture layout with a regular input directory. |
| `COMPOSED_OUTPUT_PATH` | Retired. Earlier output-generating runs of `scripts/generate-composed-direction-fixture.ts` used this refusal when the destination already existed or lay inside the repository. |
| `UNCONSUMED_SHA256` | `scripts/check-direction-fixture-hashes.ts`: the displayed fixture JSON field has a SHA-256 that the checker cannot bind to a file. Restore the expected binding or teach the checker to verify that field against the retained file. |

### Review sign-off targets

From `SIGNOFF_TARGET_SINCE = 2026-11-06T00:00:00Z`, every rig-review and
direction-review signature binds a target. When `current` is present, parts-review,
rig-review and direction-review select `current.parts`, `current.rig` and
`current.direction` respectively for the owner's chat relay.
The target contains exactly `subject`, `record_sha256` (the SHA-256 of the full
node as recursively key-sorted JSON) and `files_sha256` (the node's recorded
output-set hash, checked against disk). Current parts also binds `structure`
as `{ path, sha256 }` for the exact retained snapshot of the signed output.
Numbered signatures still check their retained review evidence after adoption. For each stage,
`check` validates the latest live current-target signature. A newer current
signature, reopen or amendment can make an earlier current signature historical.

To sign an adopted or replaced `current.parts`, record the producer output
with `rig-create record parts --from <producer out> --config <rig config>` as
needed, then prepare its structure snapshot and relay the owner's approval.

| Code | Meaning | Remedy |
| --- | --- | --- |
| `SIGNOFF_TARGET_MISSING` | A rig-review or direction-review signature dated on or after `SIGNOFF_TARGET_SINCE` has no target, or a new signature would bind an adopted current node | For an adopted node, rebuild and use `rig-create record rig --from outputs/rig --config <rig config>` or `rig-create record direction --from outputs/direction --direction specs/direction/direction.json` before signing. For other current targets, restore or record the stage's current output and sign again. For a stored numbered signature (read-only), restore the recorded target and reviewed inputs |
| `SIGNOFF_TARGET_STALE` | A current target is malformed, or its still-applicable output record or files are missing or differ from the signed hashes. A current parts signature can also carry numbered review fields. For a numbered target, the version, operative human accepted verdict, package inventory, imported outputs or direction binding no longer resolves | Restore the reviewed current record and outputs or record them with `rig-create record rig` or `rig-create record direction`, then sign again. For a stored numbered target (read-only), restore the recorded target and reviewed inputs |
| `SIGNOFF_TARGET_MISSING_LEGACY` | A pre-contract signature has no target | Preserve history and bind the next review signature |
| `SIGNOFF_TARGET_STALE_LEGACY` | WARN when a signature dated before `SIGNOFF_TARGET_SINCE` has a target that no longer resolves | Preserve history and use the remedy for the target format in `SIGNOFF_TARGET_STALE` |
| `SIGNOFF_PAIR_MISMATCH` | A rig-review or direction-review sign-off predates its target verdict without a human accepted pair bound by unique immutable act receipts to the same job, publication and version. Ingest always refuses; check refuses from `SIGNOFF_PAIR_SINCE = 2026-11-13T00:00:00Z`, dated by `signoffs[].at` | Accept the intended version and sign it again in Review, then ingest both acts |
| `SIGNOFF_PAIR_MISMATCH_LEGACY` | WARN: the same inconsistent pair on a sign-off before `SIGNOFF_PAIR_SINCE` | Preserve history; accept and sign the intended version in Review for the next pair |

## Answer revision approvals

`SIGNOFF_ANSWERS_SINCE = 2026-11-06T00:00:00Z` dates missing bindings by the live signature's `at`.

| Code | Fires when | Clear it by |
| --- | --- | --- |
| `SIGNOFF_ANSWERS_UNANSWERED` | The writer's covered `rests_on` item is absent, unanswered or unresolved, and no current step plan covers it (a covered item binds that plan's step and sha256) | Answer the named item, or propose its step plan, before signing |
| `SIGNOFF_ANSWERS_MISSING` | A current-era live approval has no answer hash map or omits an expected item | Sign the named stage again |
| `SIGNOFF_ANSWERS_MISSING_LEGACY` | A pre-contract live approval lacks a complete answer hash map | Preserve history and bind the next approval |
| `SIGNOFF_ANSWERS_STALE` | A live approval's hash does not bind the expected answer or plan. On the current path the check can resolve the retained answer and proposal revisions from the time of signing. Numbered records still compare with the current answer or plan | On the current path, restore the signed answer or proposal in history and its original hash. For a numbered record, complete any missing or unresolved answer and relay the owner's approval for the corrected record |

## Forward stage and step progress

No stage order is enforced (#981). `advance` moves to any stage of the
project's order without a sign-off; its entry records the live stage-level
signature at the move as `signoff`, or `null` when there is none. A step may
change status in any stage, and a checkpointed step may be done without a
checkpoint signature. Dependency, not stage, decides what is rebuilt.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `ADVANCE_WORDS_REMOVED` | advance receives `--by` or `--verbatim-file` (exit 2). advance takes no mover or words of its own | run advance without those flags |
| `ADVANCE_MALFORMED` | advances history is not a list, or an entry lacks `stage`, `from_stage` and `at`, a boolean event-time `post_not_passed`, a recorded `order` naming both stages, `signoff` as `null` or a `{stage,checkpoint,at}` identity naming one recorded signoff, `signoffs_before` identities, or `steps_before` with step ids, phases and statuses; an older entry carrying `by` or `verbatim` carries both as strings | retain the original move through advance |
| `RIGGING_INTERVIEW_PAINTING_REQUIRED` | a move into rigging lacks `painting`. Refused from `RIGGING_INTERVIEW_PAINTING_SINCE = 2026-11-22T00:00:00Z`, dated by the recorded exit | declare the source with `rig-create input painting <registered input path>` before advancing |
| `RIGGING_INTERVIEW_PAINTING_LEGACY` | a retained move before the cutoff lacks `painting`. For records without a move, the earliest retained downstream signature dates the check | preserve the retained move and declare the source with `rig-create input painting <registered input path>` |
| `DIRECTION_REVIEW_POST_MISSING` | a `post` → `direction-review` advance lacks `direction_contract`, a current scene (or composed `direction@3` post) or a live `kind: "post"` version in `versions[]`: refused on the move being written and from `DIRECTION_REVIEW_ADVANCE_SINCE = 2026-11-18T00:00:00Z`, dated by `advances[].at`, a WARN before it | adopt direction with `rig-create direction --adopt`, write the current scene with `rig-create scene write` (or compose `direction@3`) and record the post version with `rig-create direction write` before advancing to `direction-review`; preserve the earlier move and amend `post` if work there needs correction |
| `PROGRESS_OPTION_INVALID` | advance, step-status, pause or resume arguments are missing, repeated or malformed, a step-status note is unreadable, empty, invalid UTF-8, over 1,000 bytes, contains controls other than newline, or has an incomplete or mismatched note/hash pair, or advance's `--parts-check` and `--parts` are not given together or are given on a move other than `parts` → `parts-review` | supply the target (advance) or step/status and --by once (step-status), a valid --note-file with its matching retained note_sha256 when used, and both parts-check flags only on that move |
| `STEP_STATUS_TRANSITION` | step-status skips or reverses the status sequence, names no unique executable step, or history lacks its boolean event-time checkpoint_required snapshot or is malformed | use pending, in-progress, at-checkpoint, done in order (a step without a checkpoint may go from in-progress straight to done, and a done step may return to in-progress to run again); the step-status refusal names the next status to record |
| `STEP_STATUS_SIGNOFF` | a retained status history entry names a checkpoint signature that does not resolve to a human signature of that step dated at or before it | retain the matching checkpoint signoff, or the original history |
| `STAGE_MOVE_UNLINKED` | an advance or reopen's `from_stage` is not the stage the previous recorded move (by time) left, starting from `interview` (`paused` links to either side), or an `advances[]` entry is dated before an earlier one | preserve the history; record later moves through advance, pause or resume |
| `STEP_STATUS_UNLINKED` | a `status_history[]` entry's `from_status` is not the previous entry's `status` (`pending` for the first, or after a reopen or amendment that reset the step), an entry is dated before the one before it, or the step's `status` is not the last recorded status | preserve the history; record transitions through step-status (a reopen copies a hand-set status into `steps_before`, where `REOPEN_STEP_UNLINKED` reports it) |
| `REOPEN_STEP_UNLINKED` | a `reopens[]` entry's `steps_before[]` status (`pending` when omitted) is not the status the step's `status_history[]` chain held at the reopen's `at`; steps with no history entry dated before the reopen, a malformed entry or reordered entries are not judged, and an entry tied with the reopen may fall on either side | restore the status the historical reopen recorded and use step-status for later transitions |

`PROGRESS_HISTORY_SINCE = 2026-11-08T00:00:00Z` dates each link break by the
latest recorded event the unrecorded move must follow: the previous move or
status entry, a reopen or amendment that reset the step, the advance into the
step's execution stage, and for a stage move the latest stage-level signature
at the furthest stage before its `from_stage`. A `steps_before` mismatch is
dated by those events up to the reopen, not by the reopen itself, because the
historical reopen snapshot could carry a hand-set status. A reordered entry is dated by the
later of the two entries. Breaks dated from the cutoff refuse; earlier ones,
and breaks with no preceding dated event, WARN with the same code. A later
writer entry therefore does not turn an older hand move into a refusal. A
reset tied in time with an entry may fall on either side of it.

Both progress writers reconcile stage_values, validate with checkProject and
preserve bytes on refusal. Arrival at rigging-interview or post-interview
admits only INTERVIEW_INCOMPLETE for that target's silent items by code/path
counts. The check still reports them.

History reads `status_history[].checkpoint_required` and
`advances[].post_not_passed` from their event snapshots. Current checkpoint
changes and post applicability changes after reopen preserve the original
authorization. Missing or non-boolean snapshots are malformed. Current `done` writes preserve a live checkpoint signature when present.
Current stage checks use current post applicability.

### Parts-stage check at the parts → parts-review move

The move from `parts` to `parts-review` binds the report of `rig-parts
check-parts`, spec `rig-parts-parts-check/1` (`@rig-c/parts`
docs/STABILITY.md § Parts-stage integrity report). `advance parts-review
--parts-check <report> --parts <assembled dir>` takes both paths
project-relative; retain the report under the project and point to the assembled root it was run on. The entry gains a closed
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
| `PARTS_CHECK_UNREAD` | `advances[].parts_check.path` is not a literal project-relative path, leaves the project (also through a link), is written under an ignored root, is not a regular file, or is not a JSON object | write the report into the project's `evidence/` with `rig-parts check-parts --out <project>/evidence` (a clone does not carry `derived/`, `outputs/` or `scratch/`, and every later check rereads the bound bytes) and advance with `--parts-check evidence/parts-check.json` |
| `PARTS_CHECK_INVALID` | `advances[].parts_check` is not the closed object, its `parts` root is not a literal project-relative path, the report's spec, stage, key order or rows are not `rig-parts-parts-check/1`, the copied `spec`, `exit_code`, `holes` or `reported` differ from the report, or the object is on a move other than `parts` → `parts-review` | record the report through advance |
| `PARTS_CHECK_CHANGED` | the retained report no longer hashes to `advances[].parts_check.sha256` | restore the retained report bytes; a new check is recorded by a new move |
| `PARTS_CHECK_FAILED` | the bound report records a non-zero `exit_code` or any `refusals` row | fix the refused parts, rerun `rig-parts check-parts` and advance with the passing report |
| `PARTS_CHECK_STALE` | at the move, the report's `inputs` do not match the files under `advances[].parts_check.parts` | rerun `rig-parts check-parts` on the parts as they are now and advance with that report |

### Pausing and resuming

`pause` and `resume` append `pauses[]` and set `stage` ([PROJECT.md §
Pausing and resuming](PROJECT.md#pausing-and-resuming)). The history is not
read as an advance or reopen, so `STAGE_MOVE_UNLINKED` reads the same records
as before it existed. `pauses[]` is new,
so its shape check refuses no earlier record and has no contract date.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `PAUSE_ALREADY_PAUSED` | pause runs on a project whose stage is already `paused` | resume it |
| `PAUSE_STAGE_INVALID` | pause runs on `accepted` or on a stage outside the order | pause only work in progress |
| `RESUME_NOT_PAUSED` | resume runs on a project whose stage is not `paused` | resume applies to paused projects. Use advance for a forward move or amend for an artifact change |
| `RESUME_STAGE_MISMATCH` | resume names a stage other than the one the project was paused from (its latest pause's `from_stage`, or for a hand pause the stage its latest recorded move reached) | resume that stage, then use advance or amend as appropriate |
| `PAUSE_MALFORMED` | `pauses` is not a list, or an entry lacks string `stage`, `from_stage`, `verbatim`, a human `by`, a readable `at` or a text `source`, is dated before the entry before it, neither enters `paused` from a stage before `accepted` nor leaves it for a stage in the order, or a pause's `signoff` is not the identity of a human paused sign-off dated at or before it | preserve the history; record pauses through pause and resume |

`SIGNOFF_NOT_HUMAN` refuses either writer run `--by agent`.

## Frozen rig registration

`rig-create rig-version` is retired (`NUMBERED_WRITER_REMOVED`, exit 2); record
current rig and motion builds with `rig-create record rig --from <dir> --config <file>`
and `rig-create record motion --from <dir>`. `interview --check` continues to
validate stored `versions[]` entries carrying `registration` (`frozen-rig/1`)
read-only, including toolchain, producer run-record and dated-source bindings.
`RUN_RECORD_SINCE = 2026-11-08T00:00:00Z` dates lock-only `frozen-rig/1`
registrations by `registration.at`: before it they WARN under
`RUN_RECORD_REQUIRED`, and from it onward they refuse under the same code.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `RIG_REGISTRATION_USAGE` | Retired. Earlier Create releases refused missing, repeated or malformed `rig-version` arguments with this code; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Record current rig and motion outputs with `rig-create record rig` and `rig-create record motion`. |
| `RIG_REGISTRATION_BUSY` | Retired. Earlier Create releases refused a concurrent `rig-version` lock holder with this code; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Record current rig and motion outputs with `rig-create record rig` and `rig-create record motion`. |
| `RIG_PREFLIGHT_CONFIG_OUTSIDE` | Retired. Earlier Create releases refused `rig-version --preflight` when `--config` lay outside the project; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Record current rig outputs with `rig-create record rig --from <dir> --config <file>`. |
| `RIG_PARTS_APPROVAL_INVALID` | the recorded parts approval identity does not resolve uniquely at registration | restore the bound parts signoff and evidence |
| `RIG_REGISTRATION_INVALID` | the version number or registration/source-kind record is malformed | restore the retained numbered registration record (numbered versions are read-only) |
| `RIG_VERSION_ALREADY_REGISTERED` | Retired. Earlier Create releases refused retrying `rig-version <n>` for an already-recorded version with this code; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Record current rig outputs with `rig-create record rig --from <dir> --config <file>`. |
| `RIG_REGISTRATION_EXISTS` | Retired. Earlier Create releases refused `rig-version` when a numbered destination already held frozen files; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Record current rig outputs with `rig-create record rig --from <dir> --config <file>`. |
| `RIG_REGISTRATION_PATH_INVALID` | Retired. Earlier Create releases refused escaped, symlinked or colliding `rig-version` source or destination paths with this code; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Record current rig outputs with `rig-create record rig --from <dir> --config <file>`. |
| `RIG_REGISTRATION_FILE_INVALID` | an unsupported adapter format, a required input, referenced asset, declared sha256, runtime config/requirements adaptation, producer report/manifest, complete output inventory or copied totals is missing, changed or malformed | restore the exact frozen inputs, retained source documents and producer reports on the stored registration |
| `RIG_REGISTRATION_SOURCE_CHANGED` | Retired. Earlier Create releases refused source or project byte drift during `rig-version` copying with this code; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Record current rig outputs with `rig-create record rig --from <dir> --config <file>`. |
| `RIG_TOOLCHAIN_LOCK_INVALID` | the declared lock is absent, unreadable, differs from its hash, has an unsupported format or lacks either producer entry | retain the original Bun text lock with exact versions and integrity, or npm v3 lock with both producer versions |
| `RIG_TOOLCHAIN_MISMATCH` | built_with disagrees with the retained lock's two package versions | restore the declared lock and matching version values |
| `RIG_AT_SOURCE_INVALID` | the cited record/pointer lacks a valid UTC instant, differs from at or is later than registration | restore the retained `at_source` record, pointer and matching `at` timestamp on the stored registration |
| `RIG_PATH_ADAPTER_INVALID` | the adapter lacks distinct `{at,before,after}` or `{doc,pointer,before,after}` mappings, names an unknown document or non-asset pointer, or disagrees with `config-source.json` / `requirements-source.json` | retain an exact adapter matching the original `config` and `requirements` asset pointers and `before` values |
| `RIG_PATH_ADAPTER_OUT_INVALID` | Retired. Earlier Create releases refused an unwritable or conflicting `rig-version adapter --out` path with this code; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Keep current rig sources under `specs/rig/` and record with `rig-create record rig`. |
| `RIG_RUNTIME_PATH_UNRESOLVED` | Retired. Earlier Create releases refused unadapted absolute config or requirements asset paths during `rig-version` copying with this code; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Keep current rig sources under `specs/rig/` and record with `rig-create record rig`. |
| `RIG_IDLE_MANIFEST_MISSING` | Retired. Earlier Create releases refused `rig-version` when `--idle` lacked `frames.json`; `rig-version` now refuses `NUMBERED_WRITER_REMOVED`. | Record current motion renders with `rig-create record motion --from <dir>`. |
| `RIG_CHECK_REPORT_MISSING` | WARN: a frozen rig has no `registration.check_report` | preserve the historical frozen registration; for new builds, run `rig-parts check` and record with `rig-create record rig --from <dir> --config <file>` |
| `RIG_CHECK_REPORT_SPEC_MISSING` | WARN: the retained report has no `spec` | preserve the historical report; for new builds, use a Parts release carrying #1372 and record with `rig-create record rig --from <dir> --config <file>` |
| `RIG_CHECK_REPORT_INVALID` | the report is missing from its declared retention path, differs from its SHA-256 or spec binding, or has invalid JSON, an unsupported spec or malformed outcomes | restore the bound report at its declared retention path (numbered registrations are read-only) |
| `RIG_CHECK_REPORT_MODEL_HASH_INVALID` | a `rig-parts-check/1` report lacks a valid `build.model_sha256`, at any date | restore the valid retained `rig-parts-check/1` report on the stored registration, or record current builds with `rig-create record rig` |
| `RIG_CHECK_REPORT_MODEL_MISMATCH` | the report's `build.model_sha256` differs from the frozen model's SHA-256 | restore the matching retained check report and compiled model from the same Parts check run |
| `RIG_CHECK_BAR_FAILED` | an unaccepted `bar_outcomes` entry is `FAIL`. WARN before `RIG_CHECK_REPORT_SINCE` by `registration.at`, refusal from that date onward | numbered registrations are read-only — restore the retained check report or its recorded `check_report.accepted` owner-chat entry; for current builds, fix the bar and rerun `rig-parts check` before `rig-create record rig` |
| `RIG_CHECK_LINE_UNMET` | an unaccepted `requirements.lines` entry is `FAIL` or `NOT MEASURABLE`, or the report's top-level `SOURCE_EXPOSURE` line is `FAIL` (a declared `source_exposure.max_px` exceeded or unmeasured, Parts 2.53.0; `REPORTED` and an absent line are met). WARN before `RIG_CHECK_REPORT_SINCE` by `registration.at`, refusal from that date onward | numbered registrations are read-only — restore the retained check report or its recorded `check_report.accepted` owner-chat entry; for current builds, fix the line and rerun `rig-parts check` before `rig-create record rig` |
| `RIG_CHECK_ACCEPTANCE_INVALID` | the stored `registration.check_report.accepted` list is present without a report or target, or an acceptance is duplicated, selects no failed bar or unmet line, or has a write time different from registration | restore the stored `registration.check_report.accepted` entries so each failed bar ID or unmet line name matches the retained report |
| `RUN_RECORD_REQUIRED` | a `frozen-rig/1` version has no `registration.runs` (WARN before `RUN_RECORD_SINCE` by `registration.at`, refusal from `RUN_RECORD_SINCE` onward) | restore the stored `registration.runs` entries on the numbered version, or record current builds with `rig-create record rig` and `rig-create record motion` |
| `RUN_RECORD_SPEC_UNKNOWN` | a run record names an unsupported `spec` (outside `rig-run/1`, `rig-run/2`, `rigc-run/1`, `rigc-run/2`), `registration.runs[]` names a `spec` other than `rig-run/1` or `rigc-run/1`, or a draft's bound run stamp is not `rig-run/1`. The check refuses an assemble-only stamp and retains the existing WARN for a full draft without reuse | restore the unedited producer run record on the stored draft or version, or record current builds with `rig-create record parts|rig|motion` |
| `RUN_RECORD_HASH_MISMATCH` | a bound run record is missing, unreadable, absent from `registration.files`, or its bytes differ from its recorded `sha256` | restore the retained run record bytes and `registration.files` binding |
| `RUN_RECORD_ROLE_INVALID` | a `rigc-run/1` record omits a required input role (`rig` or `motion`), names an unknown role, or sorts roles outside `rig`, `motion`, `manifest`, `cuts`; or a `rigc-run/2` record omits `skeleton`, repeats or misorders roles outside `skeleton`, `atlas`, `model`, `environment`, `viewport`, `boundary` | retain the unedited `rigc-run/1` or `rigc-run/2` record with its required inputs |
| `RUN_RECORD_MALFORMED` | a run record has invalid JSON, wrong keys or published key order, invalid package/command/timestamps/paths/hashes/argv, unsorted outputs, or duplicate specs. The assemble-only reader accepts the published optional assemble `inputs` field in its declared key and role order. The check refuses an assemble-only stamp and retains the existing WARN for a full draft without reuse | retain at most one unedited producer run record per spec in its published key order |

Stored `frozen-rig/1` checks run the provenance, CG-gate, setup-painting and
figure-mask declaration checks over the retained config, its requirements and
citations. A visible busy-ground config requires `setup_painting.figure_mask`
with a path and lowercase SHA-256, verified against the retained mask bytes and
evidence.

The date citation declares a completion bound, the toolchain lock declares the
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

`input painting <path> [<project dir>]` declares an input that is already
registered as the project's one painting, for a record whose painting was
registered without `--painting`. It writes only `painting` (and `same_artwork`
when `--same-artwork-reason` is given), never changes the input record, and
runs the same sibling-artwork check as `input add --painting`. `--json` returns
the declared input record. Publications reference the declared painting; an
undeclared record keeps `inputs[0]`.

`INPUT_WRITER_SINCE = 2026-11-08T00:00:00Z` dates incomplete metadata by
`inputs[].at`. An earlier, missing or unreadable date preserves the entry with
a WARN. Complete records always validate their retained file bytes. A legacy
WARN preserves history and asks for a fresh file name when recording a new
input. No producer reports are interpreted or regenerated by this command.

| Code | When | Remedy |
| --- | --- | --- |
| `INPUT_USAGE` | input add or input painting arguments or origin words are missing, repeated or invalid, input painting gets --origin or --painting, or artwork options lack --painting, exit 2 | supply a source path and one non-empty --origin value and --painting for artwork options |
| `INPUT_PAINTING_INVALID` | painting is present but is not the path of a registered input | restore the declaration written by init --painting, input add --painting or input painting |
| `INPUT_PAINTING_EXISTS` | input add --painting or input painting attempts a second declaration | retain the declared painting and its reason, registering other sources without --painting |
| `INPUT_PAINTING_UNREGISTERED` | input painting names a path that is not a registered input | register and declare it with input add <path> --origin <words> --painting |
| `INPUTS_INVALID` | inputs is present but is not an array | restore its array of records before registering a source |
| `INPUT_WRITER_MISSING` | writer metadata is incomplete, WARN before INPUT_WRITER_SINCE or without a readable at, refusal from the cutoff; input painting refuses an input without a recorded sha256 and bytes | preserve historical bytes and register a new source name through input add |
| `INPUT_PATH_INVALID` | a source is absolute, outside the project, resolves outside it, or names project.json or the writer lock | retain a contained project-relative source file |
| `INPUT_FILE_UNREADABLE` | a source file is missing, unreadable or not a regular file | restore the original retained source |
| `INPUT_PATH_DUPLICATE` | a source path is already registered, including normalized path aliases | keep one record per name and use a new name for changed bytes; to declare a registered input as the painting, run input painting <path> |
| `INPUT_FILE_CHANGED` | registered raw sha256 or byte count differs from the file, including a re-registration attempt | restore the original bytes and register changed bytes under a new name |
| `INPUT_SOURCE_CHANGED` | the input writer lock is held, or project/source bytes change before commit | freeze the sources, wait for the writer to finish and retry |
| `INPUT_WRITE_FAILED` | staging or atomic publication of the project record fails | restore writable project storage and retry; the original project remains intact |

## Scene composition and direction@2

`scene write` and `check` share `validateScene`. Scene documents and every file
binding use raw-byte SHA-256. Only a `scenes[]` append commits a document.
Camera scene findings refuse new scene and direction writes from
`CAMERA_SCENE_BINDING_SINCE = 2026-11-28T00:00:00Z`. The scene writer
warns before the cutoff, and the project checker warns on earlier recorded
directions with the same codes. Unkeyed takes need no camera choice binding.

`DIRECTION_SCENE_SINCE` dates posts requiring direction@2. An earlier @1 post
warns with `DIRECTION_SCENE_REQUIRED`. Explicitly grandfathered posts retain
their existing exemption. A reopen preserves historical scenes and direction
documents. The latest-live rig, live-signoff and scene-currentness tests run for authoring and the scene
cited by the latest live post. With no live post, no scene is current. Every
scene still requires historical human acceptance, its matching package identity
and all schema, raw-byte seal, model, animation, frame, plate and citation checks.

`scene write --animation <name>` selects an exact name from the bound model's
catalog, defaulting to `idle`. Idle still copies `registration.idle` exactly.
New non-idle scenes omit optional `animation.frames`: there is no named-animation
registration to copy. The reader preserves the previously accepted non-idle
`frames === registration.idle` binding as legacy metadata, verifying its bytes
without claiming it proves frames of the selected non-idle clip. Other provided
non-idle frame bindings were already refused and remain refused. No historical
acceptance is narrowed, so this change introduces no SINCE date or pilot migration.

| Code | Refuses when | Remedy |
| --- | --- | --- |
| `SCENE_MALFORMED` | unknown keys at any level, wrong types, schema, n, paths or registration frames | restore the closed scene@1 record and run scene write |
| `SCENE_FILE_CHANGED` | committed document or frames are missing or changed, immutable destination is occupied, or a source changes during writing | restore raw-byte seals and retry scene write on frozen sources |
| `SCENE_RIG_STALE` | rig lacks the cited historical human acceptance, or the current rig is not the latest live accepted rig | accept the current rig and run scene write |
| `SCENE_ACCEPTANCE_STALE` | historical acceptance/package identity differs, or a current signoff has lapsed | restore the accepted package and sign rig-review again |
| `SCENE_MODEL_MISMATCH` | model path or raw-byte hash differs from the accepted package inventory | retain the accepted compiled model and run scene write |
| `SCENE_ANIMATION_MISSING` | animation is absent from the bound model catalog | pass --animation with a name from the accepted model and run scene write (default: idle) |
| `SCENE_ANIMATION_FRAMES_UNBOUND` | non-idle frames are present but differ from registration.idle, which the previous reader also refused | omit optional frames and run scene write --animation <name> |
| `SCENE_STAGE_MISSING` | compiled model stage is null or absent | compile a model declaring a stage before scene write |
| `SCENE_STAGE_MISMATCH` | frame.stage differs from model.stage | copy the exact compiled stage through scene write |
| `SCENE_PLATE_CONFLICT` | background is absent, roles duplicate, or roles share a path or hash | designate one background and at most one distinct foreground |
| `SCENE_PLATE_CHANGED` | a declared plate is missing or its raw bytes changed | restore the declared PNG and its registration |
| `SCENE_PLATE_DIMENSIONS` | PNG IHDR is invalid or differs from declared dimensions | retain the PNG and derive its IHDR size with scene write |
| `SCENE_PLACEMENT_INVALID` | rect is nonfinite, nonpositive or nonuniform past relative 1e-9 | use a finite positive uniform world-space rect |
| `SCENE_PLATE_UNREGISTERED` | exact input binding or complete prepared-input receipt chain is absent, or an agent scene derived plate lacks a valid producer receipt | register the input or retain every hashed prepared-input hop and bind the producer receipt with derived add --receipt |
| `SCENE_CITATION_MISSING` | post_composition designation is missing or unresolved | cite recorded post_composition asks and quote or decided delegation |
| `SCENE_AUTHOR_TYPED` | scene write supplies a typed `--by` | omit `--by`; authority comes from the current ingested post_composition Review choice |
| `SCENE_CHOICE_MISSING` | agent scene lacks a retained resolved Review choice or decided delegation with an exact scene map | register a post_composition option set whose value options carry value.scene:{background:{path,rect:{x,y,width,height}},foreground?:{path,rect:{x,y,width,height}}} with rig-create interview-options post_composition [<dir>] --file <retained project-relative JSON>, have the owner answer it with rig-create interview-answer post_composition [<dir>] --set <path> --sha256 <shown sha> --by <human> --pick post_composition=<option> --owner-chat <words file> --said-at <ISO date> --relayed-by <who> (or complete a delegated agent_decision with rig-create interview-decision), and run scene write |
| `SCENE_CHOICE_MISMATCH` | agent scene roles, paths or exact rects differ from the cited choice, or authoring cites a superseded answer | use the current post_composition Review choice and its exact scene map |
| `INTERVIEW_CAMERA_SCENE_INVALID` | a displayed composition option's `camera_scene` fails its retained file, sha256, schema or keyed-camera check | fix the option file and regenerate its preview from the same scene |
| `SCENE_CAMERA_CHOICE_MISSING` | a keyed Parts scene has no camera scene binding in the selected composition option | register a new option file with `camera_scene` and relay the owner's selection |
| `SCENE_CAMERA_CHOICE_MISMATCH` | the selected composition option's camera scene path or hash differs from the authored Parts scene | use the shown scene and its original bytes, or register the replacement and relay a new selection |
| `COMPOSE_VALUE_INVALID` | a `post_composition` choice or decision `value.compose` has an invalid closed shape, invalid `canvas` `{width,height}`, duplicate/unlisted plate name, non-relative plate image path, non-integer `at`, invalid `order` or `character` offset/scale, or invalid `idle_tracks`. The track array may be empty. Each entry must use a known bone property, finite key values (`[x, y]` for vector properties or `[n]` for scalar properties), and times starting at 0, strictly increasing, and sharing one positive end across all tracks | record a post_composition choice in the Review tool (or complete its delegated agent_decision) whose value.compose binds closed {canvas,plates,order,character,idle_tracks} with empty idle_tracks or a common positive track end |
| `SCENE_INPUT_RECEIPT_MISSING` | agent scene input candidate lacks matching input-writer metadata | register a new source name with `input add <path> --origin …` and select it through Review |
| `SCENE_LAYER_ORDER` | layer order differs from background, rig, optional foreground | retain the fixed scene layer order |
| `DIRECTION_SCENE_REQUIRED` | post from SINCE lacks direction@2 or @3, or earlier @1 post warns | run scene write and author the next post with direction@2 |
| `DIRECTION_SCENE_MISMATCH` | direction rig or model differs from the referenced scene | bind the scene's exact rig version and model |
| `DIRECTION_SCENE_STALE` | current authoring or the latest live post cites a superseded scene | bind the current scenes[] entry in the current direction |

## Registered idle frames in a direction post (create#297)

A frozen numbered rig (`versions[].registration`) keeps its idle render under the ignored
`outputs/v<N>/idle/`. Historical `scenes[]` entries copied `registration.idle` into
`scene.rig.animation.frames`, and the direction post reads those frames by
binding, not as a retained file: `check` reads the path only when `versions[v<R>]`
of the post's rig `R` binds it, with the same path and sha256 (`registration.idle`
for `frames.json`, `outputs` for any other idle file). No other `outputs/` path is
admitted; it still refuses `DIRECTION_FILE`. Absent frames refuse `DIRECTION_FILE`,
as `RIG_REGISTRATION_FILE_INVALID` refuses absent frozen outputs. Records that
passed before keep passing, so no contract date is added.

| Code | Refuses when | Remedy |
| --- | --- | --- |
| `DIRECTION_IDLE_VERSION` | the scene's frames are under `outputs/v<M>/idle/` and the post's rig is a different version | restore the stored scene or post `rig_version` binding so both reference the same numbered rig (numbered scenes and posts are read-only) |
| `DIRECTION_IDLE_UNBOUND` | the frames path and sha256 are not `versions[v<R>].registration.idle` (for `frames.json`) or a `versions[v<R>].outputs` row (for other idle files) | restore the stored scene `animation.frames` binding to match `versions[v<R>].registration.idle` |
| `DIRECTION_IDLE_HASH` | the frames bytes on disk differ from the bound sha256 | restore the frozen `outputs/v<R>/idle/` bytes (or record new renders on the current path with `rig-create record motion --from <dir>`) |

## Review CLI response receipts

| Code | Finding and remedy |
| --- | --- |
| `REVIEW_READ_INVALID` | A correction or applied-review record has no valid CLI receipt, or its stored response differs from the content-addressed stdout binding. Retrieve the result through `rig-review feedback --format json` and retain its receipt in the named record. |
| `REVIEW_READ_LEGACY` | WARN for a correction or applied-review record before `REVIEW_READ_SINCE` that has no CLI response receipt. Preserve history and capture new results through Review feedback. Historical producer-saved session and patch files are never opened. |

### Interview picks through the job API

| Code | Condition | Remedy |
| --- | --- | --- |
| `INTERVIEW_PICKS_FILE_REMOVED` | `interview-answer` receives the removed `--picks-file` flag | relay the owner's answer with `interview-answer <question> --set <id> --sha256 <hash> --pick <option> --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>` |

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

In both the inventory and retained phases, `job open --plan` can publish a
re-sign even at `rig-review`. The only record-check refusals allowed through
are `SIGNOFF_ANSWERS_STALE` findings that the one displayed re-sign will clear.

| Code | Finding and remedy |
| --- | --- |
| `JOB_RECORD_SUBJECT_INVALID` | The requested question or option set is absent, ambiguous or mismatched to its effective stage in `project.json`, or a subject id is outside the publication contract. At the question's open interview stage, register a fresh set with `rig-create interview-options` if needed, then publish it with `rig-create job open --question` using the original representable id. On a live direction bounce that opens post questions, record the owner's new pick before `rig-create amend post-interview --kind interview-answer`, then replan and re-sign. Past the question's interview stage, Review publication is unavailable. For an owner-chat correction, register a fresh set with `rig-create interview-options <question> <dir> --file <option-set.json>`, show it to the owner in chat, and record the pick with `rig-create interview-answer <question> <dir> --set <path> --sha256 <sha> --by <owner> --pick <ask>=<option> --owner-chat <words file> --said-at <ISO> --relayed-by <operator>`. Re-sign the approvals named by `rig-create next <dir>`. Run `rig-create interview --check <dir> --json` to inspect the current record. |
| `JOB_OPTION_SET_DUPLICATE` | A grouped question publication names the same set twice or has more than one subject for a set. Check the pending option-set bindings in `project.json` and publish each set once with a single subject. |
| `JOB_GENERATION_STALE` | Review refused a question or plan publication because its job generation moved after Create read it (another publication or act landed first). `project.json` is unchanged; Create drops the retained generation from the pending outbox entry. Run `job reconcile <dir>`, which reads the refreshed asks before it publishes the new generation. |
| `JOB_IDEMPOTENCY_CONFLICT` | Review refused a publication for `project.json` because the request key already belongs to a different request. The pending receipt preserves the refusal. For a legacy current-output receipt, Create clears the retained generation after that refusal so the next `job reconcile <dir>` can send a fresh request. To abandon the refused attempt, run `job close <dir> --retire-refused`. |
| `INTERVIEW_SIGNOFF_NOT_CLEAN` | Pick-derived interview sign-off (`signoff interview --from-picks`, or historical record-mode interview sign-off ingest) finds a refusal or delivery hole from the full `interview --check` function on `project.json`. Resolve that check before recording the interview signature. Existing records and CLI `--by` signatures keep their checks. A refused write leaves the record byte-identical. |
| `INTERVIEW_SIGNOFF_PLAN_REQUIRED` | Pick-derived interview sign-off (`signoff interview --from-picks`, or historical record-mode interview sign-off ingest) has no displayed `project.json.plan.steps`. Draft non-empty plan steps through the writers before recording the interview signature. A refused write leaves the record byte-identical. |
| `REVIEW_ACT_RECORD_TARGET_INVALID` | A stored direction record sign-off act cannot resolve one current/latest live post with an accepted live direction verdict from its hash-bound `project.json` bytes (including a duplicated current version number). Restore the original recorded post and verdict receipt. |
| `JOB_RECORD_COLLECTION_EXTERNAL` | A collection member's `project.json` has no `collection_binding` (`rig-create/collection-binding@1`), its bound `evidence/collection-binding.json` is missing, unreadable, malformed or traverse-unsafe, its `sha256` or `collection_sha256` mismatches the sealed binding or current `../../collection.json`, its bound member/collection identity or `inherited_answers` do not match the member's `basis: "inherited"` items, or the retained snapshot differs from the sealed collection interview. Run `rig-create collection-binding <member dir>` to write and bind the current collection snapshot before publishing. |
| `JOB_RECORD_CLOSURE_INCOMPLETE` | `project.json` passes its retained seals, but the retained check refuses. The closure holds every file the ask's record check read, so this means the retained root lacks or changed one of them. Structured details retain the check's codes and paths. Restore the complete inventory closure before finalization. |
| `JOB_RECORD_PARTS_LOCK_MISSING` | The check cannot bind the loaded `@rig-c/parts` (the project's install, or in the retained phase the host's). At the nearest ancestor with `bun.lock` or `package-lock.json`, each present lockfile must record the actual install path, exact installed version, and the same single integrity token with a `sha256-`, `sha384-`, or `sha512-` prefix and a nonempty digest without whitespace. Install parts from a lockfile that records its integrity and publish again. |
| `JOB_RECORD_PARTS_MISMATCH` | In the retained phase, the host loads a different `@rig-c/parts` version or integrity than the inventory phase sealed. The message names both versions. Rebuild the project on the host's parts, or run the check where the sealed version is installed. |

In the retained phase, unsafe paths, missing or changed sealed files and
invalid or duplicate file declarations refuse with `JOB_PUBLICATION_INVALID`
before the check runs. In the inventory phase, any other check refusal blocks
publication with `JOB_RECORD_INCOMPLETE`, which names the blocking code and
record path. Neither phase changes the record or its tree.


## Recorded parts verdicts (create#267)

`job open --draft <id>` opens a recorded draft view-only (0 asks), and
`parts-review` is retired (`NUMBERED_WRITER_REMOVED`, exit 2). `check` continues
to verify stored `parts-verdict` receipts in `review_acts[]` against their
draft selector, retained manifest and file hashes. Changed or missing source
files give `REVIEW_ACT_SOURCE_STALE`, and `next` still surfaces open
changes-requested evidence on historical numbered records.

| Code | Meaning and remedy |
| --- | --- |
| `PARTS_VERDICT_FILE_ROUTE_REMOVED` | `signoff --evidence` and `structure-snapshot --verdict` are removed and exit 2 before writing. Record `current.parts`, prepare `structure-snapshot`, and relay any owner chat sign-off with `--owner-chat`. |
| `PARTS_VERDICT_RECEIPT_REQUIRED` | Stored `signoffs[].evidence` has no recorded parts-review API receipt for `draft_id`. Restore the retained receipt in `project.json.review_acts`. |
| `PARTS_VERDICT_FILE_LEGACY` | A parts-review signature predates `PARTS_VERDICT_RECEIPT_SINCE = 2026-11-08T00:00:00Z` and lacks the required receipt. Check WARNs and preserves any saved-file binding without opening that file. |

## Fix ledger, ledger reports and restarts (create#285)

`project.json.fix_ledger` holds the owner fixes every version inherits. Each row
is `{ id, note: { ref, verbatim }, at, by, check, bar }`, plus `retired: { at,
by, reason }` once retired. `ledger add` and `ledger retire` write it, and the
writers and check validate rows with the same function. A row's `note.ref`
names `corrections[<id>]` or `versions[v<n>].verdicts[<i>]`, and its words
must be quoted from that note when `ledger add` writes the row. Check does not
re-read an older row's note: a restart retires the record it pointed into, and
the row keeps the words it quoted.

create never runs a ledger check. Stored `drafts[]` entries bind the
project's own `rig-create/fix-ledger-report@1` report in `ledger_report` by
sha256 and spec (`draft-rig` is retired; current builds use
`record parts --ledger-report <file>` below). Check compares the report's rows
with the ledger and does not recompute a row.
A row is live for a draft when it was written by the draft's `at` and not
retired by then. Assemble-only drafts carry no rig ledger report. The predecessor
is the previous draft with a rig output. A restart clears `drafts[]`.
`fixes` counts the live rows the report passes that the `fixes_against` draft did not pass.
That draft is the latest earlier one with a rig output and a parts-review receipt
(any verdict), else the predecessor. `FIX_LEDGER_SINCE = 2026-11-09T00:00:00Z` dates the
report requirement by `drafts[].at`. `check` lists each bound draft's `fixes`,
known regressions and accepted failures under `ledger` in JSON output. The
human output shows each accepted row as FAIL with its measurement, if present,
and the reason.

Stored drafts with `accepted_failures[]` bind failing rows where the bound report
shows `result: "fail"`, retaining the report's `measured` JSON value (including
an explicit `null`, or omitting `measured` when absent) and the reason text.
The row can be report-only and the predecessor can lack a report. Accepted
failures are historical draft annotations; regressions in `drafts[]` still
require matching `known_regressions[]` entries.

`record parts --ledger-report <file>` binds the same report schema for a
producer-backed `current.parts`. It verifies the predecessor's report against
the predecessor's `files[]` and records its sorted passing IDs in
`current.parts.ledger.replaced_passed_rows`. Both writer and check compare the
new report with the `outputs/parts/rig/parts.json` file binding and use
`current.parts.at` to select live rows. `CURRENT_PARTS_LEDGER_SINCE =
2026-11-26T00:00:00Z` dates the check's missing-report refusal. The writer
requires a report whenever there are live rows or a prior current report.
Adopted parts keep the numbered ledger contract.

| Code | When | Remedy |
| --- | --- | --- |
| `FIX_LEDGER_MISSING` | WARN: the project has a draft with a rig output and no `fix_ledger` | record each accepted owner fix with `ledger add` |
| `FIX_LEDGER_MALFORMED` | `fix_ledger` is not a list, or a row has an unknown key, a duplicate or invalid id, a future or unreadable `at`, empty `by`, `check` or `bar`, an invalid `note`, or a `retired` without `{ at, by, reason }` dated after the row | restore the row `ledger add` wrote, or retire it with `ledger retire` |
| `FIX_LEDGER_NOTE_UNKNOWN` | `ledger add`: `--note` names no recorded correction or verdict | quote an owner note the record holds |
| `FIX_LEDGER_NOTE_MISMATCH` | `ledger add`: the `--verbatim-file` words are not in the note `--note` names | quote the owner's words verbatim |
| `LEDGER_USAGE` | `ledger` arguments are missing, repeated or unsupported, `--note` is not a record path, or the retire reason is empty (exit 2) | use `ledger add <id> --by --check --bar --note --verbatim-file` or `ledger retire <id> --by --reason-file` |
| `LEDGER_ROW_UNKNOWN` | `ledger retire` names no row | name a row `ledger add` wrote |
| `LEDGER_ROW_RETIRED` | `ledger retire` names a row already retired | keep the retirement |
| `LEDGER_SOURCE_CHANGED` | `project.json` changed while `ledger` was validating | retry against the current record |
| `DRAFT_LEDGER_REPORT_MISSING` | a draft with a rig output binds no report while the ledger had a live row; a refusal from `FIX_LEDGER_SINCE` or without a readable `at`, a WARN for an earlier draft | restore the bound `ledger_report` on the stored draft, or for current builds run the project's check script and record with `rig-create record parts --ledger-report <file>` |
| `DRAFT_LEDGER_REPORT_INVALID` | the binding is not `{ path, sha256, spec }`, or the report is not a literal project path, is under an ignored root, leaves the project, is missing, changed, not JSON, has another `schema`, lacks `build.manifest_sha256` or `script_sha256`, or has a row without a unique id and a result of `pass`, `fail` or `unmeasurable` | restore the retained report and `ledger_report` binding on the stored draft (or bind current builds with `rig-create record parts --ledger-report <file>`) |
| `DRAFT_LEDGER_BUILD_MISMATCH` | the report's `build.manifest_sha256` is not the sha256 of the draft's bound `parts.json` | restore the report matching the stored draft's `parts.json` |
| `DRAFT_LEDGER_INCOMPLETE` | the report has no row for a live ledger row | restore the complete report on the stored draft (for current builds, run the check script over every live row before `record parts --ledger-report`) |
| `DRAFT_LEDGER_REGRESSION` | a live row the predecessor's report passed, or one the predecessor recorded as a known regression (it stays owed), is `fail`, `unmeasurable` or absent here, and `known_regressions` does not name it | restore the stored draft's report or `known_regressions` entry; for current builds, fix the build and record with `rig-create record parts --ledger-report <file>` |
| `DRAFT_LEDGER_MALFORMED` | `fixes`, `fixes_against` or `known_regressions` without a report; `known_regressions` is not a list of `{ id, reason }` with unique ids, or names a row the predecessor neither passed nor owed; `fixes_against` is not an earlier draft with a parts-review receipt or the previous draft (`null` only for the first); `fixes` differs from the rows the report passes and that draft did not | restore the stored draft's ledger fields (stored drafts are read-only) |
| `CURRENT_PARTS_LEDGER_REPORT_INVALID` | `current.parts.ledger` or its report binding is malformed, the report path or bytes fail verification, or the report names a different build from the bound `outputs/parts/rig/parts.json`. The writer also verifies any predecessor binding before replacing it | restore the prior bound report and retain a report for the new build. Record with `record parts --ledger-report <file>` |
| `CURRENT_PARTS_LEDGER_REPORT_MISSING` | producer-backed `current.parts` has live ledger rows and no report. Check WARNs before `CURRENT_PARTS_LEDGER_SINCE` and refuses from that date. The writer always refuses a missing report when live rows or a prior current report exist | run the project's check script and bind the retained report with `record parts --ledger-report <file>` |
| `CURRENT_PARTS_LEDGER_INCOMPLETE` | the bound current report omits a row live at `current.parts.at` | run the check script over every live row and record parts with its report |
| `CURRENT_PARTS_LEDGER_REGRESSION` | a row live at `current.parts.at` that appears in `replaced_passed_rows` is `fail`, `unmeasurable` or absent in the current report | fix the build and record parts with a passing report for the regressed rows |
| `DRAFT_ACCEPTED_FAIL_MALFORMED` | `accepted_failures` has no bound report, is empty or is not a list, or an entry has an invalid or duplicate row id, a result other than `"fail"`, a blank or invalid reason, or unexpected keys | restore the stored draft's `accepted_failures` and `ledger_report` entries (stored drafts are read-only) |
| `DRAFT_ACCEPTED_FAIL_ROW` | an accepted failure names a row that is absent, passing or unmeasurable in this draft's bound report | restore the stored draft's `accepted_failures` list so every entry names a row marked `"fail"` in its bound report |
| `DRAFT_ACCEPTED_FAIL_MISMATCH` | an accepted failure's `measured` differs from the report's JSON value or its presence, or the report's measurement contains a number outside the representable range | restore the stored draft's bound report and `accepted_failures[].measured` values |
| `INIT_ARTWORK_EXISTS` | `init --painting`, `input add --painting` or `input painting` declares a file whose sha256 is an input of a project directly under `--projects-root` (default: the new project's parent), without `--same-artwork-reason` | continue in the existing project as a new version; restart inherits its correction ledger. A new project is only for different artwork or a different rig kind (with --same-artwork-reason); copying the artwork is not a bypass |
| `INIT_ARTWORK_USAGE` | an init artwork option without `--painting <file> --origin <words>`, an unreadable painting or root, or a reason that is empty or names no matching project (exit 2) | give `--painting` and `--origin`; drop a reason no project needs |
| `RESTART_USAGE` | `restart` arguments are missing, repeated or unsupported, or the reason file is empty (exit 2) | use `restart [<dir>] --by <human> --reason-file <file>` |
| `RESTART_NOT_A_PROJECT` | the folder has no readable `rig-create/project@0` `project.json` | run restart on a create project folder |
| `RESTART_NOT_IN_GIT` | the project folder is not inside a git work tree, so git history cannot hold the record restart replaces | put the project under git, commit `project.json`, then restart |
| `RESTART_RECORD_UNCOMMITTED` | `project.json` is untracked, staged but never committed, or differs from its version at HEAD | commit `project.json`, then restart |
| `RESTART_INPUT_INVALID` | a kept input fails the input writer's checks, or a left-out legacy entry is the declared `painting` without a writer-valid twin for the same bytes | restore the file, or register it again with `input add` (`input add --painting` for the painting) |
| `RESTART_PART_SET_INCOMPLETE` | a kept part set (inputs under `<set>/parts/*.png` or `<set>/parts.json`) lacks `<set>/parts.json`, a part PNG, or its rig: `rig.json` and `mesh_report.json` at `<set>/rig/` or `<set>/` | register the missing files with `input add`, or stop keeping the set |
| `RESTART_MALFORMED` | `restarts` is not a list, an entry lacks `{ at, by, reason, previous_record_sha256 }`, or a present `dropped_additions` list or row is malformed. `restart` also refuses a source addition it cannot hash. | restore the entry `restart` wrote, or restore the source addition and its exact words before restarting |
| `RESTART_SOURCE_CHANGED` | `project.json` changed while `restart` was validating | retry against the current record |
| `NEXT_USAGE` | `next` receives an unsupported option or more than one project directory argument (exit 2) | use `rig-create next [<project dir>] [--json]` |
| `NEXT_NO_FORWARD_MOVE` | `next` derives no moves, awaits or other refusals for an unfinished project | inspect `rig-create interview --check <project dir> --json` and report the missing workflow route with the stored and effective stages |

For a current project, `next` reports completion when the effective stage is
`accepted` and there is no open feedback. An open numbered direction bounce
or an open comment on the recorded direction is input to the current scene,
direction, compose and record sequence. The move names the source record
path. Recording a new output alone does not close feedback.

`restart` does not keep the record it replaces; git history holds it, so
restart refuses before it writes unless `project.json` is committed: tracked
and byte-identical to `HEAD:<path>/project.json`, the path resolved from the
repository root (create#304). `restart` by `agent` refuses with `SIGNOFF_NOT_HUMAN`. A refused `ledger`,
`record` or `restart` write leaves `project.json` byte-identical. A
restarted record carries exactly the refusals a fresh `init` record carries
(its open interview) and no warning; `restart` refuses any other refusal.


## Operator checkpoint withdrawal

| Code | Refuses when | Remedy |
| --- | --- | --- |
| `BAR_AMENDMENT_INVALID` | plan.bar_amendments contains malformed, duplicate, future, hash-mismatched, out-of-order or generation-unbound entries; the entire journal grants no effective bar | Restore the original journal and use plan bar-amend. |
| `BAR_AMENDMENT_SCOPE` | the selected step is finished or lacks an original bar | Select one unfinished step with a bar. |
| `BAR_AMENDMENT_CONFLICT` | a retry changes the amendment's operator, reason, exact words or amended bar for the same step hash and generation | Preserve the original entry and replay its original input files. |
| `CHECKPOINT_WITHDRAWAL_INVALID` | plan.checkpoint_withdrawals has malformed, duplicate, future, hash-mismatched or generation-unbound entries | Restore the original journal and use plan checkpoint-withdraw. |
| `CHECKPOINT_WITHDRAWAL_SCOPE` | the selected checkpoint is disabled or finished | Select one enabled unfinished checkpoint. |
| `CHECKPOINT_WITHDRAWAL_CONFLICT` | a retry changes an existing withdrawal's operator, reason or exact words | Preserve the original entry and replay its original inputs. |

A valid withdrawal removes only the current matching checkpoint requirement,
which step-status records as `checkpoint_required`. No checkpoint signature is
needed for done (#981).

## Publication generations

| Code | Meaning and remedy |
| --- | --- |
| `PUBLICATION_GENERATION_INVALID` | The version's optional publication chain has invalid identity, predecessor, timestamp, reason or bytes; restore its immutable generation files and recorded hashes. |

An existing `versions[].publication_generations` entry binds
`review-live-v<N>-g2.json` and its predecessor `review-live-v<N>.json` by hash
and retains the timestamp and reason. The rig generation adds the original
painting reference to an empty reference list. The direction@2 post generation
adds the bound scene and preserves its references. Both generations carry their
own revision. `job open --rig` selects the recorded generation, and act ingest
selects by the package identity the reviewer saw. Records without a generation
entry continue to use `review-live-v<N>.json`.

### Source CI pin guard

| Code | Refusal | Remedy |
| --- | --- | --- |
| `SOURCE_PIN_ANCESTRY` | `scripts/source-ci-pins.json` names a SHA before the package's release tag, or release metadata/history is unavailable or not exact | fetch complete sibling history and tags; choose a SHA at or after the exact `package.json` release pin; play uses the dependency at the release-pinned Review tag |
| `CONSUMER_CI_COVERAGE` | `scripts/consumer-ci-tests.json` names an absent case, registry check does not pass it, or source CI skips any other case | restore exact consumerOnlyTest registration and registry execution; run every other source case |
| `TMP_LEAK_CHECK` | `scripts/ci-suite.ts`: the test suite left new temporary directories behind | use `tempDir()` from `tests/helpers.ts` or remove the directories during test cleanup |

### Record asks on the live screen

Register a retained set with `interview-options <question> <dir> --file <set>`.
Then run `job open <dir> --reviewer <id> --role owner --questions` for all
pending sets in the effective interview stage, or use one `--question <question>`
per set to select specific pending sets. For an eligible plan use the same
command with `--plan` instead. These selectors are exclusive with each other,
`--draft` and `--rig`; without one, no pending question is selected. Switch
selectors on the same port and owner capability. For a legacy package-only
host, finish and ingest its pending acts, run `job close` once, then reopen
with a question selector or `--plan`.

Record asks seal `project.json`, their declared inputs and context evidence, and
all files read by the shared decision-record check, without rechecking or sealing
unrelated producer artifacts from drafts, earlier versions, scenes or direction.
The record check keeps answer, plan, signature and stage predicates; the ordinary
project-boundary `check` still validates all producer artifacts. Package asks
(draft, rig and post) keep their existing closures. Review's publication refusal
`error.message` is passed through to the agent and durable pending receipt.

Record publications use the existing two-phase `readRecordPublished` closure,
the writer outbox and API@3. Mixed hosts retain Review's API@2/act@2 reuse
markers and accept the ordinary API@2 finalized-act fetch. Historical record picks,
checkpoints and sign-offs used act@4. Package comments are act@6, or act@7 when
a comment carries per-comment `context`. Historical rig-review Request changes with mesh
edits used act@8, and chest landmark edits use act@9 or `act@10` (`comment --from-review <actId> --config <project-relative working config>`, refusing `REVIEW_OPTION_MISSING` when `--config` is omitted). Paths outside the project, inside `evidence/`,
`derived/` or `outputs/`, or using a symlink or hardlink refuse with `JOB_PUBLICATION_INVALID`.
The record reader discounts only pending transport holes for its own exact
record hash and result while publishing; unrelated/stale outbox entries still
block it, and ordinary `check` continues to report pending transport holes.

Interview answers and stage/checkpoint sign-offs are relayed from owner chat
with `interview-answer ... --owner-chat` and `signoff ... --owner-chat`;
calling `interview-answer --from-review` / `--batch` or `signoff --from-review`
refuses with `SIGNOFF_FROM_REVIEW_REMOVED` (exit 2). Historical stored receipts
remain validated by `check`. If an owner-chat write changes `project.json` while
option sets are displayed in Review, refresh any remaining sets with `--question`
and the exact same option-set bindings. Stage advancement remains a separate
`advance` command. This adds no historical record refusal or SINCE.

When publishing an option set in an open interview, the existing reader treats
only `INTERVIEW_INCOMPLETE` on that effective stage's silent question paths as
remaining interview work. Both inventory and retained phases apply this rule.
Plan publication, stage-boundary checks and ordinary `interview --check` keep
all their existing refusals; malformed answers and missing earlier-stage answers
are never discounted.

### Listing finalized Review acts

`job acts [<dir>] [--json] [--wait [--timeout-ms N]]` reads the bound live host's agent `next` events,
using the same reader as publication ask reconciliation. It lists finalized
acts absent from `project.json.review_acts` and signoff source identities,
with their exact writer arguments/POSIX-quoted command. It never ingests, advances,
creates a host or writes the project/binding/outbox. Empty lists succeed.
It also lists, as `ingested` in `--json` and as "already recorded" lines in
text, the acts on the current publication's asks that `project.json` already
holds: ask id, act id, kind, question or stage, `at`, and the `recorded` path
(the answer field, its `history[<i>]` row once superseded, `signoffs[<i>]`
or `review_acts[<i>]`). These need no ingest. `asked` counts the current asks;
with no pending act the text says how many were already ingested, or that none
were asked, so an empty `acts` is never read as unanswered.
With `--wait`, an already-pending act returns immediately. Otherwise, the
command waits on the same Review attachment for a finalized act.
A missing or dead host refuses `JOB_HOST_ATTACH_REFUSED`; restore it with
`job open`. The existing strict close attachment preserves stored identities.

| Code | Meaning and remedy |
| --- | --- |
| `JOB_ACTS_READ_REFUSED` | `project.json`: the live job event read or wait failed, or paging exceeded its bound. Restore or reopen the bound live host as needed, and retry `job acts`. |
| `JOB_NEXT_TIMEOUT` | `project.json`: no finalized un-ingested act arrived during `job acts --wait`. Exit 3 with the code on stderr. The message names the acts already ingested for the current asks and where each is recorded, or that none were asked; those need no ingest. When a grouped interview page has acts for only some of its sets, the message says it is waiting for n/K sets; ingest nothing until the owner submits the rest. Otherwise retry the wait, optionally setting `--timeout-ms` (1–600000, default 600000). |
| `JOB_ACTS_WRITER_UNAVAILABLE` | `project.json`: a listed act has no current writer target (for example a removed checkpoint step or a subject without a Create adapter). Its command is null, not guessed. Restore the named plan step or use a supported Review subject before ingestion. |
| `JOB_ACTS_PENDING` | `project.json.review_acts`: `job close` found finalized human Review acts that have not been ingested into `project.json`. The message names each act id and its ingest command. Ingest each act before closing, or run `rig-create job close --discard-acts <reason>` with `--by agent` to record the discarded act ids and close. To relay a person’s instruction, use `job close --discard-acts --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>`. |
| `JOB_ACT_NOT_PENDING` | `project.json.review_acts`: `job withdraw-act <actId>` named an act id that is not pending on the bound live job, or passed only a prefix of a pending act id (act ids never resolve by prefix; when a prefix matches pending act(s), the refusal names the full pending act id(s)). Pass the full act id from `rig-create job acts`. |
| `REVIEW_ACT_DISCARDED` | `comment --from-review` or `job withdraw-act` named an act id that already has a discard receipt in `project.json.review_acts`. Publish the current target and obtain a fresh act. |
| `REVIEW_ACT_DISCARD_ACTOR_LEGACY` | WARN for a discard receipt before `DISCARD_ACT_ACTOR_SINCE = 2026-11-19T00:00:00Z` with no actor. Preserve the receipt and attribute future discards. From that date an invalid or missing actor is `REVIEW_ACT_LEDGER_INVALID`. |
| `REVIEW_ACT_ACTOR_LEGACY` | WARN for an interview pick, sign-off or verdict receipt dated before `REVIEW_ACT_ACTOR_SINCE = 2026-11-22T00:00:00Z` whose act came from an owner host opened for the agent (reviewer id `agent`) and whose record says `by: user`. Preserve the receipt. From that date the record must carry the act's reviewer id, so such an act refuses at ingest and a `by: user` record is `REVIEW_ACT_LEDGER_INVALID`. Open hosts for the owner with `--reviewer` naming the owner. |

## Package upgrades

`rig-create packages upgrade [dir] --by <operator> [--rehearsal]` checks the
project before and after installing Create's release pins. Existing refusals
may disappear; no refusal may be added or change its code, path or message. The
history is optional on older records; present rows are validated by the writer
and check.

| Code | Meaning and remedy |
| --- | --- |
| `PACKAGE_UPGRADE_MALFORMED` | `project.json.package_upgrades` is not the writer's history: restore its operator, timestamp, three or four from/to package entries and lock sha256, plus any `rehearsal` / `local_dependencies` metadata and `question_set` or `waypoint_config` move it recorded. |
| `CREATE_PIN_MISSING` (WARN) | On a standalone project `package.json` is absent or unreadable, or `package.json.dependencies[@rig-c/create]` is absent (collection members share their parent collection's manifest), so `npx` can run a cached Create release rather than one pinned by the project. Restore `package.json` (as written by `rig-create init`) if missing, and run `rig-create packages upgrade [dir] --by <operator>` to pin `@rig-c/create` and record the move. |
| `CREATE_PIN_MISMATCH` (WARN) | `package.json.dependencies[@rig-c/create]` differs from the running `@rig-c/create` version. Run `rig-create packages upgrade [dir] --by <operator>` to move an older pin, or invoke the project's declared `@rig-c/create`. |
| `PACKAGE_UPGRADE_USAGE` | Supply `packages upgrade [dir] --by <operator> [--rehearsal]`. |
| `PACKAGE_UPGRADE_INPUT` | Restore the named manifest/record field; pins must be exact versions in dependencies, with no duplicate locations, workspace or local dependencies. To rehearse in a clone against an unreleased packed tarball, pass `--rehearsal` with `file:<absolute-path>.tgz` (for example via `bun add file:<absolute-path>.tgz`); relative `file:`, `link:`, `workspace:`, bare paths and missing or non-`.tgz` targets remain refused. |
| `PACKAGE_UPGRADE_REHEARSAL` (WARN) | `project.json.package_upgrades[i]` was recorded with `--rehearsal` (`rehearsal: true` and `local_dependencies` tarball sha256 bindings). A rehearsal clone still checks green on refusals; a live project should rerun `rig-create packages upgrade` against the published release. |
| `PACKAGE_UPGRADE_CURRENT` | All four manifest pins already equal Create's release pins, and `interview.question_set` and every waypoint `config[]` match the installed parts; no write is needed. |
| `PACKAGE_UPGRADE_DOWNGRADE` | The named package is newer than Create's release pin; use a newer Create release. |
| `PACKAGE_UPGRADE_INSTALL` | The staged install failed; repair registry access or the package versions and retry. When the running `@rig-c/create` version is not published on the registry, run a published Create release or use `--rehearsal` with `@rig-c/create` set to `file:<absolute-path>.tgz`. |
| `PACKAGE_UPGRADE_CHECK_FAILED` | The project check could not complete; repair the record or installed packages and retry. |
| `PACKAGE_UPGRADE_REFUSAL` | The named package move adds or changes the named check finding; preserve the original pins and resolve that finding before retrying. |
| `PACKAGE_UPGRADE_CONFLICT` | Another package writer holds the lock, or a source changed during staging; finish the other write and retry against current bytes. |

## Release workflow gates

These CI-only codes name `.github/workflows/release.yml` or its tagged
`package.json`; they do not validate project records.

| Code | Meaning and remedy |
| --- | --- |
| `RELEASE_REF_NOT_TAG` | `release.yml`: use a tag push or dispatch with matching `--ref vX.Y.Z -f tag=vX.Y.Z`. |
| `RELEASE_TAG_FORM` | `release.yml`: supply a strict `vX.Y.Z` tag without prerelease or leading zeros. |
| `RELEASE_TAG_UNRESOLVED` | `release.yml`: restore tag/API access so the explicit tag ref resolves to a full commit SHA. |
| `PROVENANCE_SHA_MISMATCH` | `release.yml`: the run, API or fetched tag commits differ; inspect the cut tag and recover on that exact tag ref without moving it. |
| `RELEASE_TAG_NOT_ON_MAIN` | `release.yml`: restore fetched main/tag history or land the reviewed release commit on main before cutting a new tag. |
| `RELEASE_TAG_VERSION_MISMATCH` | Tagged `package.json`: release the exact `@rig-c/create@X.Y.Z` matching the tag; do not move an existing cut tag. |
| `RELEASE_ALREADY_PUBLISHED` | `release.yml`: npm already serves the version; verify that publication rather than republishing it. |
| `RELEASE_REGISTRY_UNCONFIRMED` | `release.yml`: confirmation of both names timed out; inspect npm before recovery because publication may already have succeeded. |
| `ALIAS_SAME_CONTENT` | `scripts/alias_tarball.ts compare`: an alias differs beyond the `package/package.json` name line; rebuild it from the reviewed scoped tarball and resolve every named file difference before publication. |

## Head turn before rigging

`HEAD_TURN_SINCE = 2026-11-14T00:00:00Z` dates new rig depth obligations
by the rig version's build date. Earlier records WARN with the same code;
fixed-view records retain their historical placement and need no depth outputs.
New interviews put `turn` and `depth` on rigging waypoint `turn`.

| Code | Meaning and remedy |
| --- | --- |
| `RIG_DEPTH_PLAN_MISSING` | At `rigging-interview`, before signoff, `plan.steps[turn]` is absent or ordered after the rig steps for a depth turn. Use `plan revise turn --order <before the first rigging step>`, or `plan add turn --phase rig --rests-on turn --order <before the first rigging step>` if absent, then approve it at rigging-interview. Publication and ingest both refuse an invalid depth plan. Answers before `HEAD_TURN_SINCE` WARN. |
| `RIG_DEPTH_BINDING_MISSING` | A depth-driven rig lacks its retained producer manifests. On stored numbered versions (read-only), restore `depth_sheets.json` and any `registration.depth` manifest and `depth-report.json` bindings; on the current path, keep those files in tracked project paths and run `rig-create record rig --from <dir> --config <file>`. Before `HEAD_TURN_SINCE` this is a WARN. |
| `RIG_DEPTH_MAP_BINDING_MISSING` | A per-part registered depth map has no retained Parts receipt, the same absence that Parts names `DEPTH_MAP_BINDING_ABSENT`. Refuses from `DEPTH_MAP_BINDING_SINCE = 2026-11-19T00:00:00Z`, dated by `registration.at` (falling back to version `at` for an older record); earlier registrations WARN. On stored numbered versions (read-only), restore the retained `registration.depth.map_bindings[]` receipts; for current builds, re-infer changed inputs, call `rig-parts depth-bind` immediately after inference, keep each `<map.binding.json>` in tracked project paths, and run `rig-create record rig --from <dir> --config <file>`. Reuse an existing map and receipt only when prepared `inputSha256` is unchanged; never bind an old map to new input. |
| `RIG_DEPTH_BINDING_INVALID` | `versions[].registration.depth` has changed bytes, the wrong producer spec, or disagrees with its retained inventory/report manifest hash. Pre-depth accepted source parts bind the prepare manifest's parts hash; already depth-applied accepted parts bind the identical registered parts and the producer report-to-manifest chain. Restore the exact retained producer files on the stored numbered version (or record current builds with `rig-create record rig --from <dir> --config <file>`). |
| `TURN_BODY_VALUE_INVALID` | The `turn` answer value (in `value`, `agent_decision.value`, or `additions[].value`) carries `body` other than `true`, or carries `body` without `mode: "depth"`. Record `{ "mode": "depth", "body": true }` for a head-and-body turn, `{ "mode": "depth" }` for a head-only turn, or `{ "mode": "fixed" }` for a fixed view. `interview-answer` and `interview-decision` always refuse before writing; check refuses records (dated by the answer's, the agent decision's or the addition's `at`) from `TURN_BODY_SINCE = 2026-11-25T00:00:00Z`, or without a readable date, and WARNs earlier ones with the same code. |
| `RIG_TURN_EXTRA_GROUP` | WARN. On a head-only answer (`{ "mode": "depth" }` without `"body": true`), the latest registered rig's `config.turn.body` declares body roles, so the rig carries a body dial (`turn.body.slider`, default `body_yaw_dial`) the answer did not ask for. Remove `turn.body` from the working config and re-run `rig-parts depth-apply ... --groups head` (Parts refuses `DEPTH_GROUP_LEFT_OUT` if `turn.body` remains) so `depth-report.json` records `selection.leftOut` for the body group while keeping `recipeSha256` and `manifestSha256` unchanged, or record the dial as unused in a turn step note: `step-status turn <next status> --by <operator> --note-file <file naming the dial>`. `next` names the `depth-apply ... --groups head` command and the dial; the WARN clears once `depth-report.json` records `selection.leftOut` containing the body group or a `plan.steps[turn].status_history[].note` names the dial. |
| `RIG_TURN_BODY_MISSING` | WARN. The `turn` answer asks for head and body (`{ "mode": "depth", "body": true }`), but the latest registered rig's `config.turn.body` declares no body roles. Add `turn.body` to the working config, re-run `rig-parts depth-apply` with the body group and `rig-parts rig`, and record the updated rig with `rig-create record rig --from <dir> --config <file>`, or record a head-only `turn` answer. |

`registration.depth.map_bindings[]` retains each Parts receipt as `part`,
`path`, raw `sha256` and `spec: "rig-parts-depth-map-binding/1"`. Create reads
these declarations against the applied report and prepared manifest; it never
runs inference, binds a map or reconstructs Parts measurements. Missing receipts
use `RIG_DEPTH_MAP_BINDING_MISSING`; malformed, duplicate, wrong-spec or
mismatched present declarations use `RIG_DEPTH_BINDING_INVALID` in every era.
Changed retained bytes use the existing `RIG_REGISTRATION_FILE_INVALID`. Parts
prints absence only on stderr and does not persist it in the depth report;
Create checks the corresponding retained-receipt absence rather than inventing
producer report fields. A receipt attests the files available to `depth-bind`,
not that unobserved inference actually consumed that input.

For a per-part depth registration, `registration.depth.source_parts` retains
the accepted parts manifest. When `--parts` is the accepted directory and
already holds its depth report, `source_parts_applied: true` binds that
snapshot to the identical registered parts and the report-to-manifest chain.
Otherwise it binds the prepare manifest's pre-apply parts hash. No source
measurement is recomputed.

`interview.turn_question: "rig-create/turn-question@1"` explicitly adopts the
new placement. Re-signing or adopting the split order on a later date alone
does not retrofit it into historical interviews. Missing `turn` on an adopted
interview is the existing `WAYPOINT_MISSING` refusal.

### Relayed owner chat

Signing `current.parts` requires `--owner-chat`, `--said-at` and `--relayed-by`.
Omitting any of these flags refuses with `OWNER_CHAT_REQUIRED`. The visual
verdict gate applies to numbered targets. The relay supplies approval for the
current parts target and its bound snapshot.

| Code | Meaning and remedy |
| --- | --- |
| `OWNER_CHAT_INVALID` | The named `project.json` record or command has blank owner words, missing or `agent` `by`, missing `relayed_by`, missing or non-ISO `said_at`, an invalid write `at`, `said_at` after `at`, a Review act id, a non-relay `source`, or incomplete/mixed `--owner-chat` flags. The message names each failed field and its remedy; supply owner `--by`, `--owner-chat`, `--said-at` (at or before `at`) and `--relayed-by` together without Review flags or act ids. |
| `OWNER_CHAT_REQUIRED` | A draft amendment, restart or new stage signoff targeting `current.rig` or `current.direction` lacks relayed owner chat. A human reopen lacks relayed owner chat or a valid immutable Review reopen receipt. For reopen and restart, refuses from `REOPEN_RESTART_OWNER_CHAT_SINCE = 2026-11-19T00:00:00Z` by the entry's `at` and WARNs for earlier records. Preserve earlier records. For an amendment, restart or current-output signoff, relay the owner's exact words with `--by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>`. For a historical reopen, restore its original authority evidence. |
| `OWNER_CHAT_GATE_VISUAL` | Retired. Earlier relayed signoffs on numbered targets required an accepted live Review verdict before signing; numbered review-stage signoffs now refuse with `NUMBERED_WRITER_REMOVED`. |

## Composed idle direction (direction@3)

These findings apply only to @3; @1/@2 retain their existing rules. Existing
`SCENE_RIG_STALE`, `SCENE_ACCEPTANCE_STALE`, `SCENE_INPUT_RECEIPT_MISSING`,
`SCENE_PLATE_UNREGISTERED`, `SCENE_CHOICE_MISSING` and `SCENE_CITATION_MISSING`
also apply when the moved acceptance, registration or authority checks fail.
Numbered composed `direction write` (`--compose-out`) is retired
(`NUMBERED_WRITER_REMOVED`, exit 2); for current builds, run
`scene write --compose-scene <file>`, `direction write --file <intent.json>`,
and `record direction --from <dir> --direction specs/direction/direction.json`.
No date switch is needed. The closed Parts `rig-compose-run/1` record binds
the retained scene and every consumed character and plate to registered bytes.

| Code | Refuses when | Remedy |
| --- | --- | --- |
| `DIRECTION_COMPOSE_SCHEMA` | the @3 document is not closed, bindings name the wrong frozen paths, scene/report fields have the wrong shape, or a scene character carries `canvas_clip` other than `true` | restore the stored @3 document or author a valid current direction spec with `direction write --file <intent.json>` and `record direction` |
| `DIRECTION_COMPOSE_FILE` | a compose or plate source is missing, unreadable, symlinked, nonregular, or an immutable destination exists | restore the regular producer files on the stored post, or compose and record current direction with `record direction` |
| `DIRECTION_COMPOSE_HASH` | a bound compose/model/scene file differs from its recorded raw-byte SHA256 | restore the frozen bytes on the stored post, or compose and record current direction with `record direction` |
| `DIRECTION_COMPOSE_INVENTORY` | a post does not bind its own compose tree and retained scene, or files differ from its inventory | restore the exact `outputs` inventory and bytes on the stored post (or record new compose output with `record direction`) |
| `DIRECTION_COMPOSE_RUN` | compose-run.json is not the closed rig-compose-run/1 shape, has invalid SHA256 bindings, duplicate character ids/file paths/plate names, unknown consumed file roles, lacks the consumed check/check.json binding, or `characters[i].placement` (`{canvas_clip,bounds,clipped_bounds}` in that key order) disagrees with the scene character's `canvas_clip: true` opt-in | retain the complete Parts compose run record with scene, characters, plate and plates; compose again |
| `DIRECTION_COMPOSE_RUN_SCENE` | the producer scene SHA256 differs from the exact retained scene bytes | restore the retained scene bytes, or compose again and record with `scene write --compose-scene` and `record direction` |
| `DIRECTION_COMPOSE_RUN_RIG` | a consumed character id/build differs from the scene; the accepted review_package.from or frozen inventory is absent; mandatory parts.json, rig/rig.json or rig/motion.json entries are missing or hash-mismatched in either direction; a consumed rig/images/* entry is absent or hash-mismatched in the frozen or sealed inventory; frozen outputs differ from the sealed package or their retained bytes | restore the accepted rig's frozen build and compose outputs; unused accepted images may be absent from the run because Parts records only distinct default-skin images it consumed; check/check.json is recorded by Parts but is not compared to the rig record |
| `DIRECTION_COMPOSE_RUN_PLATE` | consumed named plate names, paths or hashes differ from the registered scene plates, a plate is missing or extra, or a nonnull legacy plate does not bind registered plate bytes | restore the registered plate bytes on the stored post, or compose again using the registered plates and record with `record direction` |
| `DIRECTION_COMPOSE_GREEN` | the composed check does not report PASS:true and gate_spine_html_green:true | correct the scene and produce a green Parts compose |
| `DIRECTION_COMPOSE_CAMERA_MODEL` | a Parts `spine-parts-scene-report/2` lacks `camera.model_sha256` or its digest differs from the frozen packed model | retain the Parts camera report and packed model from the same compose run |
| `DIRECTION_COMPOSE_PLATE_UNREGISTERED` | a scene plate has no matching registered input or complete prepared-input chain | register its bytes through input add or the prepared-input writers |
| `DIRECTION_COMPOSE_CITATION` | timing or composition lacks a matching resolved cited answer, or new authoring cites a superseded answer | record and cite the current owner choice or decided delegation |
| `DIRECTION_COMPOSE_CHOICE_MISMATCH` | the scene lacks an explicit `animations.idle` object or literal scene fields differ from the cited `value.compose` after producer placement comparisons | declare `animations.idle` with the take duration, copy the cited values including `tracks: []` for an empty-track take, and compose again |
| `DIRECTION_COMPOSE_PLACEMENT` | report placement/plate hashes disagree, the report lacks a valid `rig_size`, reported character shift differs from the shift implied by that rig size and the cited offset, scale and canvas, compiled stage differs from the cited canvas, or recorded `compose.clipped_bounds` / report `clipped_bounds` differs from the compose-run `placement` | retain the matching Parts report and compiled model from a new compose of the cited scene |
| `DIRECTION_COMPOSE_LOOP` | take.loop or cited post_timing.value.loop is not true | record a repeating timing choice and take.loop:true; producer green proves closure |
| `DIRECTION_COMPOSE_DURATION` | the model lacks a single compiled `idle` animation, or `take.duration` differs from the scene idle duration, compiled idle duration, cited timing seconds or common end when tracks are present | align those declarations, compose and write a new post |

## Step plans

One plan per user step, proposed at once ([INTERVIEW.md § Step plans](INTERVIEW.md#step-plans)).
Feedback is discussion; no code here fires because a plan has none.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `STEP_PLAN_INVALID` | `interview.step_plans` is not a list, or an entry lacks the schema, a known step, a path inside the project, a sha256, bytes, `inputs[]` of `{path, sha256}`, `by`, an ISO `at` or a `feedback` list | restore the writer's record or propose the plan again with plan propose |
| `STEP_PLAN_FEEDBACK_INVALID` | a feedback entry is neither relayed owner chat nor a Review comment with words, comment id, a human `by`, `relayed_by` and an ISO `said_at` no later than `at` | record the person's words with plan feedback |
| `STEP_PLAN_FILE_INVALID` | plan propose names a plan file or `--input` that is not a readable file inside the project folder, or an empty plan | keep the file in the project folder and write the plan before proposing it |
| `STEP_PLAN_MISSING` | plan feedback names a step with no proposed plan, or a `--sha256` no entry of that step has; interview-decision `--value-file` names a question whose step has no plan | propose the plan first, or name the hash of the plan the words were about |
| `STEP_PLAN_STALE` (WARN) | the current plan file or one of its bound inputs no longer matches its recorded sha256 | propose the plan again with plan propose so feedback binds the current content |
| `STEP_PLAN_VALUE_UNSAID` (WARN) | a step-plan value (`source: "step plan"`) has a `plan_quote` that is not in the current plan file of its step, whitespace collapsed | say the value in plain words in the plan, propose it again, and record the value with interview-decision `--plan-quote-file` |

## Current outputs (`record parts`, `record rig`, `record motion`, `record direction`)

### Adopting numbered outputs in place

`rig-create record <kind> [<dir>] --adopt [--json]` records metadata in
`current.<kind>` from the latest live rig version for parts, rig or motion,
or the latest live post version for direction. If that version has no bound
output for the kind, adoption refuses. The writer sets `adopted: { version }`
and verifies each file against the retained SHA-256 and any recorded byte
count. `check` requires the full kind-specific `files[]` inventory to match
the cited version by path, SHA-256 and any recorded byte count, even if that
version later lapses. Adoption leaves the numbered outputs and their records
in place.

`built_from` is empty for adopted parts and motion. For rig it can bind the
recorded config source, and for direction it can bind the retained direction
document and compose scene. The writer omits missing bindings, and
`OUTPUT_STALE` covers the dependencies actually recorded. The writer includes
`run` and `report` when their receipts are bound in the retained inventory. Adopted
rig and motion record `rebuild: { recorded: false, note }`. The writer omits
`rebuild` for adopted parts and direction. Current consumers that require
canonical output paths still need a producer-backed record at
`outputs/<kind>/`. Rebuild and run `record <kind> --from …` to replace the
adopted entry for that kind and install the canonical output.

The legacy numbered write flow is for projects without `current`. Readers
continue to validate retained numbered records and their evidence whether or
not the project has `current`. See [Adopting existing numbered outputs](PROJECT.md#adopting-existing-numbered-outputs).

### Recording producer output

`rig-create record parts [<dir>] --from <producer out> --config <rig config>`
writes `current.parts` and renames the producer's folder, normally
`outputs/parts.next/`, into `outputs/parts/`. It reads `run.json` (`rig-run/1`,
command `assemble`) and `check/parts-check.json` (`rig-parts-parts-check/1`)
from the producer folder, taking `built_from` from `--config` (matched by sha256
against `run.config`) and `run.inputs[]` (resolved against `--from` first and the
project root second, binding `<dir>/layers.json` when a project-root See-through
input names `<dir>`). A malformed, stale-against-`rig/` or red
`parts-check.json` refuses with the parts-check reader's own code
(`PARTS_CHECK_INVALID`, `PARTS_CHECK_STALE`, `PARTS_CHECK_FAILED`; § Parts-stage
check at the parts → parts-review move).

Only producer-backed parts take `--ledger-report`. If a bound ledger report
changes during recording, restore the retained report bytes before retrying.

`rig-create record rig [<dir>] --from <producer out> --config <rig config>`
writes `current.rig` (docs/CURRENT-DATA.md §1.3) and renames the producer's
folder, normally `outputs/rig.next/`, into `outputs/rig/`; the old tree is
deleted after the record is written. It reads `run.json` (`rig-run/1`) or
`build-run.json` (`rig-run/2` or `rig-run/3`), `check/build/run.json` (`rigc-run/1`),
`check/check.json` (`rig-parts-check/1`), and, when present,
`check/check-run.json` (`rig-run/2`) and `render-run.json` (`rigc-run/2`) from
the producer folder and never re-runs them. Every refusal comes before the
first rename, so `project.json` and `outputs/<kind>/` stay byte-identical.
`files_sha256` is the output-set hash: it leaves out every producer run record,
which is any file named `run.json` or any `*-run.json` (the producers' own
rule), and no `built_from` entry may name a run record or
`outputs/direction/check/check.json`. A `built_from` entry may name an output
root (`outputs/<kind>`), which is compared by that hash. A record without
`current` gets none of these findings. When `rig-run/2` or `rig-run/3` (and `rigc-run/2` for
any render outside `check/`) records `argv`, `current.rig.rebuild` is
`{ recorded: true, runs: [{ path, sha256, spec, argv }, ...] }`; otherwise it
is `{ recorded: false, note }` and `check` warns `REBUILD_ARGS_UNRECORDED`. The
writer reads the report's outcomes with the frozen-registration reader and
takes no owner acceptance: a failed bar, an unmet requirement line or a failed
source exposure refuses under `RIG_CHECK_BAR_FAILED` or `RIG_CHECK_LINE_UNMET`
(§ Frozen rig registration).

`rig-create record motion [<dir>] --from <render out>` writes
`current.motion` and binds the current rig model. A present `render-run.json`
must be a `rigc-run/2` render and cover `frames.json`. The pinned renderer
produces no run record, so its motion record binds the model and marks the
rebuild arguments unrecorded.

When the owner accepted a numbered rig and its registration binds the idle
sidecar and frame set, adopted motion can carry
`current.motion.provenance.kind = "legacy-co-registration"`.
The marker names the numbered version and registration and binds the model,
sidecar and verified motion set by SHA-256. Its `files_sha256` hashes the
sorted JSON array of `[path, sha256]` pairs using `outputs/motion/<relative
path>` for every path. The hash excludes `run.json` and `*-run.json`.
Identical files have the same set hash at `outputs/vN/idle/` and
`outputs/motion/`. The outer `current.motion.files_sha256` retains the
historical path-qualified hash of its recorded inventory. A legacy marker
records what was accepted and co-registered. Workflows that require proof
from the renderer still require its own run receipt.

When Parts needs the old rig files in a single build layout, use
`rig-create scene stage-adopted <dir>`. It copies the retained, verified
inputs including the model-bound producer check into
`derived/direction-adopted-build`, and records the source paths and hashes
in `adopted-copy.json` there. The adopted output folders and their
`project.json` entries keep their original bytes.

`rig-create record direction [<dir>] --from <compose out>
--direction specs/direction/direction.json` writes `current.direction`.
It validates the Parts producer evidence and binds `compose-run.json` and
`check/check.json` by hash. The check report must be green and bind the
composed model. The project check validates current record shape and input
staleness. Direction's `built_from` includes the motion output-set hash bound
by scene@2, so a changed frame PNG under `outputs/motion/` yields
`OUTPUT_STALE` for direction even if `frames.json` is unchanged. See
[Recording current motion and direction](PROJECT.md#recording-current-motion-and-direction)
for the post-stage workflow.

On the current path, a later producer-backed `record parts`, `record rig` or
`record direction` supersedes the matching optional signature. The signature
keeps its target digests, owner attribution and signing time. Parts signatures
still verify the retained structure snapshot and its bound target. For rig and
direction, the replaced node's digest can be re-derived from the prior record in
the project's Git history if that record was committed. The active output still
has its own checks. A mixed record retains the numbered-era stale-signature check.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `RECORD_USAGE` | the kind is outside `parts`, `rig`, `motion` and `direction`, a required option is absent, an option is unknown or repeated, or `--adopt` is combined with a producer-backed option | use `--adopt` with an optional project folder and `--json`. For a producer-backed write, use `--from`, add `--config` for parts or rig, and add `--direction specs/direction/direction.json` for direction |
| `RECORD_BUSY` | another record writer holds the project lock | let it finish and retry |
| `RECORD_ADOPT_CURRENT_EXISTS` | `current.<kind>` already exists | rebuild and use `record <kind> --from` to replace that entry |
| `RECORD_ADOPT_SOURCE_MISSING` | there is no live version of the applicable role, or the latest live version has no retained output bindings for the requested kind | restore the source version's bound inventory or produce new output and record it with `--from` |
| `RECORD_ADOPT_SOURCE_INVALID` | `current` has an invalid shape, the source version is ambiguous or has invalid build metadata, a source binding is malformed or duplicated, or a bound file is missing, unreadable, symlinked or differs from its recorded SHA-256 or byte count | restore valid legacy bindings and their exact files, or produce new output and record it with `--from` |
| `RECORD_ADOPT_DIRECTION_BOUNCED` | WARN on stderr after `record direction --adopt` succeeds and the source post's latest human direction verdict is bounced | use `rig-create next` to read the retained verdict's open comment before rebuilding the current direction |
| `DIRECTION_FEEDBACK_REF_INVALID` | `current.direction.answers_feedback` is malformed, appears on an adopted node, or names a verdict other than a human direction-review bounce at or before the current output. The writer also refuses new references to feedback that is no longer open | record the new output using `record direction --from` and repeat `--answers-feedback <version>:<verdict>` once per open verdict you addressed |
| `CURRENT_MOTION_PROVENANCE_INVALID` | an explicit legacy co-registration marker disagrees with the accepted numbered registration or its retained model, sidecar or motion inventory | restore the original registration, bindings and files, or render and record motion again with `--from` |
| `CURRENT_MOTION_PROVENANCE_VERIFIED` | INFO when `check` verifies legacy co-registration for adopted motion. JSON carries the same facts in `current_motion_provenance` | use this evidence for accepted legacy reuse. When a workflow requires a render receipt, supply its own recorded producer receipt |
| `RECORD_ADOPTED_RIG_OUTPUT_CHANGED` | a new rig would replace the accepted adopted model, atlas or atlas page with different bytes without evidence of a changed or previously unrecorded current Parts or config input. The comparison uses the adopted rig's input bindings and the retained numbered Parts inventory | keep the accepted adopted rig or rebuild from the intended changed inputs |
| `RECORD_ADOPTED_RIG_INPUT_CHANGED` | WARN when recording a changed model, atlas or atlas page over an accepted adopted rig and the rebuild names a verified current Parts or config input that changed or has no retained binding | inspect the named input and artifact differences, then revisit downstream outputs that depend on the old rig |
| `RECORD_FROM_INVALID` | `--from` is outside the project, is neither `outputs/<kind>` nor a sibling folder beside `outputs/<kind>/`, is not a real folder, or holds a symlink or other non-regular entry | point `--from` at a folder beside `outputs/<kind>/` (normally `outputs/<kind>.next`) or `outputs/<kind>` itself |
| `RECORD_CONFIG_MISMATCH` | `--config` is outside the project, inside the output, not a regular file, or its sha256 differs from the config the `rig-run/1` record or the `rig-run/2` or `rig-run/3` build record names | pass the config the parts or rig output was built from, kept under `specs/rig/` |
| `RECORD_MOTION_RIG_INVALID` | the current rig lacks a valid compiled-model binding, those model bytes are missing or changed, or the render run's skeleton or any supplied atlas or model input differs in path or hash from the recorded rig | restore or record the current rig, render from its bound build and record motion again |
| `RECORD_MOTION_FRAMES_INVALID` | the render folder lacks a readable `rigc-frames/1` `frames.json` with a nonempty `sets` array, or the supplied render run omits its `frames.json` output | render again into a clean output folder and record motion |
| `MOTION_LOOP_SEAM_POLICY_INVALID` | `specs/motion/loop-seam.json` is unreadable or has no valid channel delta, pixel count or warm-up cap | set a channel delta from 0 through 255 and nonnegative safe integer counts |
| `MOTION_LOOP_SEAM_MISSING` | a project with a seam budget has no bound report for a motion frame set (WARN before `LOOP_SEAM_REPORT_SINCE`, then refusal, and refused on a new write against a declared budget) | render with a Core version that emits `rigc-loop-seam/1` and record motion again |
| `MOTION_LOOP_SEAM_UNJUDGED` | the bound seam report lacks a verdict (WARN without a declared budget or before `LOOP_SEAM_REPORT_SINCE`, then refusal against a declared budget, and refused on a new write against a declared budget) | use a take with a positive period and render with the declared bar and cap to get a judgment |
| `LOOP_SEAM_UNAVAILABLE` | Core's seam report marks an observation unavailable, such as a take with no positive period. Create reports this as `MOTION_LOOP_SEAM_UNJUDGED` | select a looping take with a positive period and render again |
| `MOTION_LOOP_SEAM_INVALID` | the seam report, frame set, endpoint hashes or declared judgment budget are inconsistent | render a clean tree with a Core version that emits `rigc-loop-seam/1` and record motion again |
| `MOTION_LOOP_SEAM_OVER_BAR` | the producer's above-delta pixel count exceeds the judged bar | adjust the take until it meets the declared budget, then render and record motion again |
| `DIRECTION_LOOP_SEAM_MISSING` | Parts' bound check report has no embedded loop seam evidence for the declared budget (WARN before `LOOP_SEAM_REPORT_SINCE`, then refusal, and refused on a new write against a declared budget) | compose again with the declared loop seam bar and cap, then record direction |
| `DIRECTION_LOOP_SEAM_UNJUDGED` | the embedded Core loop seam report lacks a verdict (WARN before `LOOP_SEAM_REPORT_SINCE`, then refusal, and refused on a new write against a declared budget) | use a take with a positive period and compose again with the declared bar and cap |
| `DIRECTION_LOOP_SEAM_INVALID` | the bound Parts report, embedded Core report, take identity, endpoint hashes or declared budget are inconsistent | compose into a clean tree with Parts 2.62.0 or newer and the declared bar and cap, then record direction |
| `DIRECTION_LOOP_SEAM_OVER_BAR` | the embedded producer verdict reports more pixels above the delta than the bar allows | adjust the take until it meets the declared budget, then compose and record direction again |
| `SCENE_CURRENT_RIG_REQUIRED` | current scene or direction validation cannot find a valid compiled model binding in `current.rig.files`, or the adopted rig no longer matches its retained inventory | restore the recorded compiled rig or record a verified replacement before writing the current specs or recording direction |
| `SCENE_CURRENT_MOTION_REQUIRED` | the scene lacks bound motion frames from the current model, the sidecar lacks a frame set for the selected animation, the on-disk motion inventory differs from its recorded hash, legacy co-registration cannot be verified, or the sealed scene cites a different motion binding | restore the recorded frame tree and its evidence, or render and record motion for the current model and selected animation before writing the scene again |
| `ADOPTED_COMPOSE_STAGE_INVALID` | `scene stage-adopted` cannot verify the accepted rig's retained files and model-bound check report, or the derived staging tree differs from the verified copy | restore the hash-bound originals or preserve the occupied staging tree at a separate path, then run `scene stage-adopted` again |
| `DIRECTION_CURRENT_SPEC_INVALID` | the direction intent or current spec object has the wrong shape or citation fields, the current spec or its sealed scene is unreadable, the sealed scene has changed, the spec lacks the matching model and idle compose-scene binding, or `record direction --direction` names a different path | write the current compose scene, then write direction with the cited looping intent and pass `--direction specs/direction/direction.json` to record it |
| `RECORD_RUN_INVALID` | a required run record is missing, a run record is malformed, has the wrong spec or command, lacks `inputs` for `assemble` or a `rig-run/3` build, mixes conflicting run records or producer versions, or one of its outputs is missing from the folder or differs from its sha256 | re-run the producer into the folder and record again |
| `RECORD_INPUT_CHANGED` | a producer run input (`rig-run/1` `assemble` `inputs[]`, `rig-run/3` `build` `inputs[]`, or `rigc-run/1` or `rigc-run/2` `inputs[]`) is missing, resolves outside the project, or now differs from the sha256 the producer read (inside the folder, a mixed tree across runs) (including when `rig` was rerun without rebuilding Core, or `assemble` was run outside the project root) | run `rig-parts assemble` from the project root, rerun the Parts build with the current inputs, rebuild with `rigc` and `rig-parts check`, or re-render from the current rig for motion, then record again |
| `RECORD_BUILT_FROM_INVALID` | a producer input is a run record (`run.json` or any `*-run.json`), the compose check report, or lies inside `outputs/<kind>/`. A `rig-run/3` build input also triggers this refusal if it resolves into reserved `outputs/rig.next/` even with a custom `--from`, or into the actual `--from` tree | keep inputs and configs outside `outputs/<kind>/` and build from product files, not run records. For a `rig-run/3` build, also keep inputs outside `outputs/rig.next/` and the actual `--from` tree |
| `RECORD_REPORT_INVALID` | `check/parts-check.json` (`parts`) or `check/check.json` (`rig`) is missing, unreadable, has the wrong spec, or (for `rig`) its `build.model_sha256` differs from `check/build/skeleton.model.json` | run `rig-parts check-parts --parts <folder>/rig --out <folder>/check` or `rig-parts check --out <folder>/check` and record again |
| `RECORD_DESTINATION_INVALID` | `outputs/<kind>` exists and is not a folder | move that file away and record again |
| `RECORD_SOURCE_CHANGED` | the folder, a bound parts ledger report or `project.json` changed while the writer was validating. Any output renames are undone | let the producer finish and record again |
| `RECORD_WRITE_FAILED` | a rename or the record write failed for another reason; the renames are undone | fix the project storage and record again |
| `CURRENT_MALFORMED` | `current` or a `current.<kind>` entry has the wrong shape. Each entry has `at`, `built_by`, `built_with`, sorted `files[]`, `files_sha256` and `built_from[]`. For producer-backed entries, `files[]` is under `outputs/<kind>/`. Producer-backed parts, rig and direction require `run` and `report`. Rig requires `rebuild` (`{ recorded: false, note }` or `{ recorded: true, runs }`). Producer-backed motion with `rebuild` has an optional `report`, requires `run` when `rebuild.recorded` is true and omits it when false, and allows only `rigc-run/2` in `rebuild.runs`. Earlier producer-backed motion entries without `rebuild` require both `run` and `report`. An adopted entry must cite one numbered version with `adopted: { version }` and match its full kind-specific output inventory. An adopted entry may omit `report` and may omit `run` except for motion with `rebuild.recorded: true`. Each `run` or `report` binding present must match a `files[]` entry by path and sha256. A `built_from` entry naming a run record (`run.json` or any `*-run.json`), the compose check report or the output itself also refuses. | restore the record and its original source bindings, or record the output again |
| `OUTPUT_STALE` | WARN: a `built_from` path is missing or now hashes differently — except the `current.parts` config entry when `outputs/parts/rig/parts.json` still has its recorded sha256 and carries `assembly_config`, which is stale only when the config is missing, unreadable, or `@rig-c/parts/assembly-reading`'s `assemblyConfigChanges` reports changed fields (named in the message; legacy `parts.json` without `assembly_config` keeps the whole-file sha256 comparison) — or a `built_from` path lies in an upstream output that is stale. Adopted motion uses its adoption version as its rig basis, and adopted direction uses the post's `rig_version`. When present, `current.rig` makes these dependents stale if it is canonical, adopts a different version, or matches their rig basis and is itself stale. | rebuild it upstream-first and record it with `record <kind>` |
| `REBUILD_ARGS_UNRECORDED` | WARN for a valid `current.<kind>` entry with `rebuild.recorded: false`. Rig and motion producers can write this form. `next` also names this code when adopted rig or motion inputs changed and there is no verified rebuild recipe. | reuse a verified adopted output for its recorded inputs. To rebuild with changed inputs, obtain the producer arguments and record the verified new output. |
| `REBUILD_PRODUCER_VERSION_MISMATCH` | WARN from `next` when a verified `current.<kind>` replay recipe names a different version of Parts or Core than the package installed with Create. The warning names the receipt and both versions. | replay the recorded arguments and record the verified result as a new output |
| `PROJECT_NOT_IN_GIT` | a current record or spec writer saved its data without a Git work tree at the project root or its collection root, or `history` found no such work tree or no Create step-data commits for the project at HEAD. Both warn on stderr and exit 0. History leaves stdout empty, including in JSON mode. | use a project or collection work tree and run a Create step-data writer to establish history, or fetch the existing history |
| `GITIGNORE_PATTERN_ABSENT` | the record writer found neither the exact legacy `/outputs/` line to migrate nor the current rule pair. The record succeeds and the writer preserves the existing `.gitignore`. | if parts are still ignored, update the applicable rules by hand so `/outputs/*` is followed by `!/outputs/parts/` |
| `HISTORY_USAGE` | history takes at most one project directory and accepts the optional `--json` flag | run `rig-create history [<dir>] [--json]` |
| `HISTORY_READ_FAILED` | Git could not read the selected project's commits or their changed paths | repair or fetch the project Git history and retry `history` |
| `PROJECT_COMMIT_FAILED` | a current record or spec writer saved its data but could not prepare or create its scoped commit. The writer warns on stderr and exits 0. | correct the reported Git error and retry the quoted command from the warning |

## Scratch folder bindings

`scratch/` is git-ignored working storage. Create never deletes it and never binds a record to anything under it (`SCRATCH_BINDING_SINCE = 2026-11-27T00:00:00Z`). Writers that copy UTF-8 words from a temporary file (for example `--owner-chat scratch/owner-words.txt`) store only the text and remain allowed.

| Code | Fires when | Remedy |
| --- | --- | --- |
| `SCRATCH_BINDING_FORBIDDEN` | any recorded binding path or source pointer in `project.json` or `collection.json` (`built_from`, `saw`, `inputs`, owner-chat `source`, `evidence`, `derived`, `drafts`, `versions`, `scenes`, `step_plans`, etc.) points into `scratch/`. Writers always refuse before writing; `check` refuses entries dated from `SCRATCH_BINDING_SINCE` or without a readable date, and WARNs earlier ones | move or regenerate the file outside `scratch/` (for example `inputs/`, `evidence/` or `derived/`) and re-record the binding |
