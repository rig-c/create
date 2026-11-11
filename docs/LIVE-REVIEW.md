# Writer-owned live review

Open the standing owner window from a foreground terminal. Keep that command
running while writers commit results. The reviewer identity is the trusted
bootstrap identity used by Review.

```sh
rig-create job open <project> --reviewer <id> --role owner [--draft <id> | --rig <n>]
rig-create job reconcile <project>
rig-create job close <project>
```

The open command prints the private owner-window URL. Keep it private.
`--rig <n>` selects an already registered rig and its retained review package,
including on a new job with an empty publication head. It accepts `1` or `v1`.
The version, complete retained package inventory and compiled model are checked
before starting the host or installing its binding, including pre-interview rigs.
Invalid selections refuse with `JOB_PUBLICATION_INVALID`; missing or changed
package files use the existing package-check refusal codes. Choose one of `--draft` and `--rig`; combining them
refuses with `JOB_BINDING_INVALID`. Reopening the same rig over unchanged record
bytes reuses its publication and asks each declared subject once.

The default in `parts` and `parts-review` publishes the latest recorded draft.
`--draft` names a recorded draft in any stage. Opening asks every subject that publication declares (see
[Asks](#asks)). It prints `job: draft <id> published`, or `already published`
when the job's head publication is already that draft (or an acknowledged `rig`
or `post` version) over the current record,
then `job: asked …` and `job: already asked …` with each subject. A `--draft` id
the record does not hold refuses `JOB_DRAFT_UNKNOWN` before writing `review_job`. A refused publish or ask
is printed while the foreground host keeps serving. The
versioned `review_job` stores only `jobId` and `origin`. The host installs its
fetch grant in the owner-only sibling `.rig-create-review-binding.json` and
ensures it and the durable `.rig-create-review/` outbox are ignored before
writing either. New projects declare both root patterns in init's `.gitignore`.
Existing Git projects receive only missing patterns in `.git/info/exclude`,
preserving their tracked `.gitignore` bytes. A folder without Git receives a
minimal `.gitignore` append. Effective ignores are checked before writing.
A tracked private path refuses startup. Agents invoke writers and never construct this file.
Explicit close revokes the grant and removes the matching binding (see
[Job retirement](JOB-RETIREMENT.md)). Listener shutdown alone preserves the
active job. A new incarnation receives a new grant.

Re-opening with an existing binding keeps its job. A running host is reused.
A stopped host restarts on the same job, state directory and port, and the
draft is published again only when the head publication no longer matches the
current record bytes. A binding whose root is another directory was copied
with the project (a clone or a move). `job open` never reads that binding's
host state or connects to its port: it opens this root's own job in its own
state directory, replaces the copied binding and rewrites `review_job`. Before
that, `job close` with the copied binding refuses `JOB_HOST_REUSE_MISMATCH` on
`root` before any attach, and a copied outbox entry refuses
`JOB_OUTBOX_INVALID`.

The outbox, intents and discard log live in the project-root
`.rig-create-review/`, independently of the binding and TMPDIR. Its directories
are owner-only 0700 and files 0600, with symlinks refused. Private Review host
state stays outside the project under the system temporary directory, as its
host contract requires. Losing that host state leaves the durable publication
HOLE visible.

## Phase 1 results

| Writer | Published result | Review subject |
| --- | --- | --- |
| `draft-rig` | The labelled draft, C4 input inventory and retained output | `draft` selector and `parts-verdict`, plus sign subjects |
| `rig-version` | The recorded rig and retained review package | `rig` selector and `review-verdict` for `rig-review`, plus sign subjects |
| `direction write` and `direction patch` | The recorded post, direction document and retained rig package | `post` selector and `review-verdict` for `direction-review`, plus sign subjects |
| `advance rig-review` and `advance direction-review` | The current live rig or post version at the entered review stage | `rig` or `post` selector, `review-verdict`, and the stage's `signoff` subject |

The sign subjects are the `signoff` and `checkpoint` subjects of
[Live sign-off routes](#live-sign-off-routes).

Writers produce `review-live-v<N>.json` over the existing model and original
direction bytes, using project-relative paths. Its title is `rig v<N>` or
`post v<N> (rig v<R>)`, so Review's previous/current publication notice names
the exact versions. A post needs the rig's complete retained review package.
Package-less option, plan, scene and stage-only writes await Review's separate
package-less-result contract. Act ingestion belongs to create#182.

The reader takes plan step hashes from create's `stepHash`, binds the retained
package against its recorded file hashes, and calls the installed public Parts
enumerator on the recorded `review_package.from` producer root. Its manifest
must match the packaged manifest hash, and every packaged PNG must match too.
Registration copies every image returned by Parts' public enumerator into its
retained producer output and records it in `review_package.files`. Historical
packages retain their existing file declarations, including their earlier
sibling omissions. Their recorded producer root remains the read path.
A package without `from` uses its own `out` directory. Its `images` preserves every returned row, role, duplicate path and
position. The enumerator version is read from the installed package metadata.
Review re-enumerates and validates the supplied identity under API@2/act@2.

## Commit and recovery

Participating bound writers hold a shared write lock as well as their existing
writer lock until publication acknowledgment. Before replacing the project,
the writer fsyncs a private outbox intent containing the published `versions[]`
entry hash and result selector. The hash uses that entry's two-space JSON
serialization with a final newline. After commit, the matching entry is pending until Review
acknowledges it. The pending identity and generation
remain stable across retries, including acknowledgment loss. A publish failure
leaves the committed result and reports `JOB_PUBLISH_PENDING` beside the write.
`interview --check` includes every pending entry in `holes[]` and exits 1.
Unbound projects retain their existing report shape and writer behavior.

On a bound job, `advance rig-review` and `advance direction-review` follow the
same commit-then-durable-outbox order for the current live `rig` or `post`
version: holding the shared job write lock, the writer validates the post-advance
candidate and live version before writing, records the outbox intent for the
post-advance record bytes, atomically replaces `project.json`, and publishes the
version with its `review-verdict` and stage `signoff` subjects. If publication
fails after `project.json` is committed, the stage advance stays committed in
`project.json`, `JOB_PUBLISH_PENDING` remains in the durable outbox and is
reported in `interview --check` `holes[]`, and `rig-create job reconcile`
publishes and clears it. If the atomic record write itself fails before
`project.json` is replaced, the uncommitted advance intent is removed and
`project.json` stays byte-identical, so there is never a silent half-advance
where the stage is advanced without either an acknowledged publication or a
durable pending outbox entry. Advances into any other stage and advances when no
job is bound do not publish or touch the outbox.

Run `job reconcile` after restoring the host or declared package. It holds the
same lock, verifies the retained version and files, publishes against the
current whole-record hash and removes the acknowledged entry. Later signoffs,
inputs and other independent writes remain in that current record.
Reconciliation never rewrites `project.json`. A changed or missing committed
version refuses with `JOB_PUBLICATION_STALE`. Another participating writer and explicit close
wait until pending work is reconciled. After process loss, `check` and reconcile
recover a dead writer's shared lock. An intent with a matching version entry is
a pending HOLE, including after other writers change the surrounding record.
An intent whose version is absent is dropped with its ID and version hash
in the private `discarded-intents.jsonl` log. Active writer intents stay held.
A different version hash remains a named HOLE and is preserved. A refused
write cancels its absent-version intent. Each current-record snapshot has its
own idempotent request key, with a stable key/generation for retries of that
snapshot. Receipt recovery and
acknowledgment never edit project bytes.

## Host attachment and delivery

Before attaching, the writer compares root, state directory, fingerprint,
reviewer, callback IDs, schemas and installed enumerator version with the
frozen private binding. A mismatch produces a pending receipt containing the
differing field and both values. The writer loads Review's public
`startJobHost` facade and publishes through its in-process `ports.handleJobApi`
with bootstrap agent authority held only in memory.

`job open` stores the bound listener's `listenerIncarnation` in the private
binding when Review returns an attested `attachment`. A `null` attachment from
ordinary reuse means "not strictly attached": it is not an error and nothing
is reinstalled. Every later attach is Review's strict reuse-only POST, with
`reuseOnly.expected.{jobId, origin, listenerIncarnation, binding}` taken from
the locked binding, so Review never starts a replacement listener for a
reconcile. A refused attach keeps Review's `reason` and `phase` in a
`JOB_HOST_ATTACH_REFUSED` pending receipt, including `incarnation-missing` for
a host that predates the token. A field-level mismatch keeps its `field`,
`expected` and `actual` values in `JOB_HOST_REUSE_MISMATCH`. A reuse-only
attach never writes the binding.

Cross-process subscription delivery uses a **30-second server wait cycle**.
Scheduling, transport and rendering add elapsed time. Review 2.8.0 defines
`jobWaitLimitMs = 30_000` in `src/job-api.ts` and reads durable events
after the timer in `src/job-session.ts`. The window's previous/new label
notice is implemented in `web/job-session.ts`.

Review 2.8.0 carries answered scene-context choices and historical reader
diagnostics in `publication.interview` (`rig-review/job-interview@1`), and
refuses invalid or stale editable `pending_options` sets with
`JOB_RECORD_INCOMPLETE` before this reader runs.

## Finalized verdict ingestion

```sh
rig-create review <version> <project> --from-review <actId> --json
```

The synchronous writer uses its private #184 binding to fetch the finalized act
from the exact loopback job API. Its subprocess receives no Review state path or
host callbacks. It opens no host and carries no producer storage file. The grant
travels in Authorization, and the private process transport uses stdin/stdout.
Human-value and feedback flags are exclusive with `--from-review`.

The shared reader checks `rig-review/job-api@2` for semantic API responses,
`rig-review/act@2` for historical acts and `rig-review/act@3` for rig stills, and the
act's Parts enumerator version against `>=2.25.0 <4.0.0`. API@1 and act@1 are
refused without migration. Rig/post `review-verdict` and draft `parts-verdict` use their respective writers.
Interview picks use `interview-answer --from-review`. A passed `checkpoint` act is recorded by
`signoff <stage> --checkpoint <id> --from-review <actId>`: the act's `planStepId` must be `<id>`, an
enabled checkpoint `--checkpoint` accepts in that stage, and its displayed plan must be the current
one. The sign-off takes `by`, `at` and the words from the act and names it in `source`; a `fail`
outcome is refused (`REVIEW_ACT_CHECKPOINT_FAILED`) and writes nothing. A `signoff` act is recorded by
`signoff <stage> --from-review <actId>` (PROJECT.md § Recording a sign-off). Which publications
carry these two subjects is below, in Live sign-off routes. Image-review has no create version writer mapping. Described
correction and mesh-edit retain Review's reserved status.

`approved`, `changes-requested` and `pending` map to the existing verdict
vocabulary `accepted`, `bounced` and `provisional`. Host-attested owner maps to
`by: user`, and delegate maps to `by: delegate`. The complete reviewer identity,
authority, original words, time and source remain in the immutable act receipt.
Verdict ingestion records its verdict and bound still. Signoff and stage advance require their own
separate writer invocations.

### Source checks and replay

The #184 job/write lock spans fetch, validation and commit. Every first ingest
and replay checks the explicit selector, retained model, direction, package,
plan step identities, Parts manifest and declared image hashes against current
files. Create never reconstructs Review's composite `sourceHash` or producer
measurements. `source.projectHash` remains exact publication provenance inside
the retained act. Later unrelated signoffs can change project.json without
invalidating a displayed version.

A successful publish now retains an owner-only acknowledged receipt beside the
outbox in `.rig-create-review/acknowledged-publications/`. It records the job,
publication ID, generation, request ID, selector and #184 `publicationVersionHash`
before the outbox entry is removed. `JobAct.publicationId` links first ingest to
that receipt. A changed version entry refuses `REVIEW_ACT_SOURCE_STALE`. When
private receipts are absent, including after a clone, ingest emits
`REVIEW_ACT_VERSION_UNVERIFIED` and still checks every explicit source binding.
The JSON command result carries `warnings[]`, and the text result prints the
named warning. This warning describes the skipped first-ingest version-entry
comparison. It grants no exemption from the explicit source checks.

The versioned record's `review_acts[]` stores `rig-create/review-act@1` receipts
keyed by `(jobId, actId)`. Review verdicts retain the exact raw export bytes as
`bytes`, their SHA-256, the version and verdict index, the pre-append
version-entry hash and the exact still entries added by ingestion. Historical
semantic-API receipts keep their original encoding. No act has a self-hash.

For rig act@3, `review --from-review <actId>` fetches raw act bytes and the
PNG through the live job API with the consumer grant.
The writer verifies the PNG hash, retains both files under `evidence/v<N>/`,
and records the displayed still first in `evidence[]`. Numeric frames name
the animation in `what`. Create never renders or reconstructs these pixels.
A missing or mismatched PNG refuses `REVIEW_ACT_STILL_INVALID` before writing.
The result and receipt are validated with the checker, fsynced and atomically
replaced together. Refusal preserves project.json bytes. `check` validates the
receipt hash, immutable act and linked verdict, including words and authority.
Historical receipts are checked against retained evidence, independently of
whether their sources are still current.

An unchanged replay reports the existing verdict without rewriting the record.
Replay discounts verdicts and exact still entries appended by ingestion after
its recorded verdict index when comparing the pre-append version-entry hash. Other original version fields and
prior verdicts remain covered. Source changes refuse `REVIEW_ACT_SOURCE_STALE`
with the recorded verdict untouched. This implements create#182's C4 ruling
against the installed dedupe-first order in Review 2.8.0 `src/job-contract.ts`. C4's source-check requirement is recorded in create#182's
“C4 act-side checks” ruling and review#501. [Create ruling](https://github.com/rig-c/create/issues/182), [Review C4](https://github.com/rig-c/review/issues/501).

### Isolation evidence and legacy inputs

The path test starts the host with relocated state, excludes its actual state
path from the writer binding, and guards filesystem calls in the writer and
fetch subprocess against that state path. It exercises the producer-bound
chain checkpoint's rig verdict over the loopback API. Separate-UID filesystem
unreadability is not measurable in this local test environment. The guarded
path test establishes the accepted consumer access boundary.

`--picks-file`, `--verbatim-file`, parts `--evidence`, and reshaped feedback JSON
remain available for legacy/history workflows. The current semantic verdict
path uses `--from-review` and preserves the fetched act directly.

## Live sign-off routes

Every package publication also declares the `signoff` and `checkpoint` subjects
that its record can sign, in the stage the check reads that record in (its
effective stage). The rules are in `src/signable.ts`:

- A `checkpoint` subject is declared for each plan step whose checkpoint
  `signoff <stage> --checkpoint <id>` accepts in that stage. The step runs in
  the stage and its checkpoint is enabled. `signoff` uses the same function.
- A `signoff` subject is declared for the stage itself while it closes on a
  sign-off and has no live stage-level signature. `rig-review` is declared only
  on a `rig` publication and `direction-review` only on a `post` one, because
  the act's selector is the signature's target. A plan-bound stage
  (`plan-approved`, `rigging-interview`, `post-interview`) also needs displayed
  plan steps.

Review 2.8.0 asks only for a declared subject and refuses any other with
`JOB_ASK_INVALID` (`bindJobAsk`, `src/job-act.ts`). Both the ask and the act
also require `project.json` to still hold the published bytes
(`assertJobSourceCurrent`, `src/job-source.ts`). So either the owner submits
both the verdict and `signoff` acts in the Review UI before any writer mutates
`project.json`, or after a CLI writer (`parts-review --from-review`,
`diff-classes`, or `review <n> --from-review`) updates `project.json`, the
agent runs `rig-create job open` to republish the current selector (`draft`,
`rig`, or `post`) over the updated `project.json` bytes and re-ask the stage's
declared subjects before the owner signs off in the UI.

`job reconcile` keeps the declared subjects in the acknowledged receipt.
`signoff … --from-review` compares the act's subject with that list and
refuses one the publication did not declare (`REVIEW_ACT_SUBJECT_UNDECLARED`).
create asks only declared subjects, but an act can also answer an ask sent by
another holder of the agent authority, so the check stays. A receipt without
the list, or no receipt at all (a clone), leaves only Review's ask binding.

### Asks

Every publication create acknowledges is followed, in the same process, by an
ask for each subject it declares. That covers `draft-rig`, `rig-version`,
`direction write|patch`, `advance rig-review|direction-review`, `job reconcile`
and `job open`. The process already
holds Review's agent authority in memory for the publish, so the ask needs no
other transport. The authority never enters argv, the environment or a project
file, and agents never handle it. A subject already asked on that publication,
pending or answered, is not asked again (create reads the job's own `pending`
events), so a retry or re-open shows no second control. A new publication
supersedes the previous one's pending asks, as Review defines.

An ask Review refuses never makes the acknowledged publication pending again.
`job open` and `job reconcile` name it `JOB_ASK_REFUSED`, with each subject and
Review's code. A writer's own publish step reports only publication failures,
so after a writer run whose page lacks a control, run `job open` to ask
again.

| Sign-off | Carried by | When |
| --- | --- | --- |
| `parts` checkpoints | draft | `draft-rig` commits while the record is in `parts` and the checkpoint is enabled |
| `rigging` checkpoints | rig version | `rig-version` commits in `rigging` |
| `post` checkpoints | post version | `direction write` or `direction patch` commits in `post` |
| `parts-review` | draft | `draft-rig` commits in `parts-review`, or the agent runs `job open` to refresh the draft after `parts-review --from-review` / `diff-classes` |
| `rig-review` | rig version | `advance rig-review` commits the move into `rig-review`, `rig-version` commits in `rig-review`, or the agent runs `job open` to refresh the live `rig` head after `review <n> --from-review` |
| `direction-review` | post version | `advance direction-review` commits the move into `direction-review`, `direction write` / `direction patch` commits in `direction-review`, or the agent runs `job open` to refresh the live `post` head after `review <n> --from-review` |
| `rigging-interview`, `post-interview` | any package publication with plan steps | only when a package writer commits in that stage, which the usual order does not do |
| `interview`, `plan-approved` | none | no draft or version exists before they are signed |

A stage with no carrier has no live route yet. The plan-bound stages wait for
record mode (create#317), and `interview` has no record-mode subject.

## Parts drafts and independent verdicts

```sh
rig-create draft-rig <id> <project> --config <config> --from <output> --parts <parts>
rig-create parts-review <project> --from-review <actId> --json
```

Bound draft registration holds the #184 shared lock through intent, atomic
record commit and publication acknowledgment. Its durable identity is the exact
`drafts[id]` entry, hashed by `publicationVersionHash` with the existing
serialization. A rebuild receives a new draft ID. Failed publication retains
its original intent and retries through `job reconcile`. Unbound registration
continues to record the existing draft inventory.

The writer publishes `review-draft-<id>.json` with a labelled draft title, an
entry-hash revision, the recorded compiled model when available, declared image
references, and read-only rig/motion/mesh-report artifacts. Standalone output
without a compiled model uses Review's optional-model manifest form. The host
reader supplies the draft selector and `parts-verdict` subject, part IDs and the
exact C4 Parts enumeration over the recorded draft input. Config, config inputs
and retained outputs are sealed as publication files. Producer bytes are read
and hash-bound. Publication performs no build or producer measurement.

`parts-review` uses the shared API@2/act@2 reader and writer-owned fetch grant.
It records all three verdict values and each part/mesh outcome and note exactly.
The human words, host-attested reviewer, authority, time and original source
remain inside the complete act. The JSON result reports the role mapping and
its explicit evidence path. It appends a `kind: parts-verdict` receipt in
`review_acts[]`, with draft ID, the pinned draft-entry hash and evidence identity.
The evidence file under `evidence/review-acts/` is the same immutable act encoding
and SHA-256 as the ledger bytes.

The semantic evidence branch reads act@2 directly. The legacy
`rig-review-parts-verdict/1` and `/2` approval, source, draft-match, structure and
difference gates continue through their existing branches. A semantic approval
must cover the selected draft's manifest and part membership. Its published
config, config inputs and mesh/output identities remain bound to that draft,
with all C4 image hashes checked. These retain the parts/draft and mesh-output
binding obligations of create#236 and #245. The semantic form carries its actual
C4 inventory and draft receipt, without synthesizing a legacy `source.files`
report or interpreting mesh geometry.

Use the returned evidence explicitly in the separate writers.

```sh
rig-create structure-snapshot <project> --draft <id> --verdict <returned-path> --out evidence/structure.json
rig-create signoff parts-review <project> --draft <id> --evidence <returned-path> --structure-file evidence/structure.json --diff-report <report> --by <human> --verbatim-file <words>
```

The existing difference component options still apply to the report. A pending
or changes-requested act can be retained, while the separate approval writer
refuses it with `PARTS_VERDICT_NOT_APPROVED`. Recording evidence leaves signoff
and stage progression to those explicit writes.

At check, structure-snapshot and signoff, retained parts approval checks its draft
bindings independently of later plan changes, including checkpoint decisions.
The full plan comparison still applies at ingest and replay. Draft publications
declare no direction document, so their acts have `source.direction: null`.

Every ingest and replay checks the draft selection, Parts manifest/images,
config and config inputs, retained outputs, package revision and any declared
model/plan/direction identities before deduplication. Package revision is the
create-owned draft-entry hash. A changed config, part or draft entry refuses
`REVIEW_ACT_SOURCE_STALE`. `sourceHash` remains producer provenance, and
`projectHash` stays publication provenance across unrelated record writes.
First ingest also joins `publicationId` to the private acknowledged receipt.
An absent receipt emits `REVIEW_ACT_VERSION_UNVERIFIED` while the explicit
bindings remain enforced and the current draft-entry hash is pinned.

Evidence is exclusively created, fsynced with its directory, and then linked by
an atomic project commit. If a process dies between staging and record commit,
an identical retry reuses the staged file and commits once. Different bytes at
the deterministic `(jobId, actId)` path refuse
`PARTS_REVIEW_EVIDENCE_CONFLICT`. A failed invocation removes only evidence it
created and has not committed. Existing evidence is preserved.

## Sealed checkpoint attachments

The agent attaches a producer's ordered presentation through the writer.

```sh
rig-create checkpoint-table --file evidence/classification.json --rows pairFrames --out evidence/checkpoint-table.json
rig-create checkpoint-evidence --file evidence/checkpoint-packets.json
```

`checkpoint-table` converts every object in the selected top-level array into
one row, preserving input order and all columns. Columns follow the first row's
key order. Every later row must have the same keys. Nested objects and arrays
become JSON text cells. Scalars retain their values. The command validates the
complete signed table grammar and size before writing, preserves the producer
source, and refuses to overwrite different output bytes.

`checkpoint-evidence` takes a JSON array of `rig-review-checkpoint-evidence/1`
packets. Each packet declares `checkpointId`, `planStepId`, ordered
`tiles[{id,label,path,sha256}]`, `table{path,sha256,label?}`, `routesText` and
`recommendationText`. Paths are literal project-relative asset paths. The table's
raw UTF-8 JSON has exactly `schema`, `columns` and `rows`, with schema
`rig-review-checkpoint-table/1`. Labels, all ordered rows, routes and recommendation
text remain verbatim. The declaration contains the table seal and optional label.

The writer stores the canonical ordered packets in `plan.checkpoint_evidence`.
Each checkpoint ID equals its existing plan step ID. It validates the candidate
with the ordinary check, verifies raw asset seals and table grammar, and commits
atomically under the attachment lock and any bound job write freeze. Refused writes
preserve `project.json` bytes. An identical retry writes nothing. The writer adds
presentation evidence without changing plan approval fields or stage authority.

`checkpoint-evidence --clear` removes the optional `plan.checkpoint_evidence`
field entirely, allowing its plan steps to be edited or removed through the plan
writer. Choose one of `--file` and `--clear`. Clear uses the same locks, candidate
check and atomic commit. Its JSON result is `null`. Repeating clear on an absent
field writes nothing.

The trusted record-plan and package readers include `checkpointEvidence` only
for checkpoint subjects they actually declare. Every supplied asset enters the
trusted closure with its exact path and raw SHA-256. Record option sets omit this
extension. Historical absence emits no evidence field. Review's signed extension
owns full PNG decoding, source/instance hashing, retained delivery and EN/KO owner
presentation. Runtime publication requires that extension in the served Review.

For Create's parts-bound package publications, Review metadata currently requires
a PNG original painting. An SVG source reaches the PNG-only Parts view loader
and refuses with `JOB_SOURCE_MISMATCH` from `PARTS_PAINTING_PNG` before projecting
checkpoint evidence. The PNG-positive and SVG-refusal regression cases cover
this boundary. [Review #636](https://github.com/rig-c/review/issues/636)

The adjacent owner routes use pass for (i), accepting the openings, and fail with
the person's verbatim words for (ii) or (iii). The browser sends
`{checkpointId,outcome,words}` and Review supplies `planStepId`. The separate
`signoff <stage> --checkpoint <id> --from-review <actId>` writer consumes passed
package `act@2` or record `act@4` checkpoints. Failed acts refuse sign-off. A
changed checkpoint packet makes first ingest stale. The immutable passed receipt
keeps its existing replay behavior. The recommendation remains labelled producer
text and grants no approval authority.
