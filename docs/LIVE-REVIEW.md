# Writer-owned live review

## The live Review loop

1. Start `rig-create job open <project> --reviewer <id> --role owner` as a
   background job. Add the selector for the first ask if it is ready. Keep the
   first process running. The reviewer identity is Review's trusted bootstrap
   identity.
2. Give the owner the printed private URL once. Keep it private. A successful
   open against the running host prints the same URL, including the same
   persisted UI capability in its fragment.
3. Publish each new draft, rig, post, set of stage questions or plan with the matching
   `job open` selector or a bound writer. Repeat the project, reviewer and role
   on each open. A reused open publishes and exits while the original host
   keeps serving. Have the owner leave the page open for live updates.
4. After publishing a verdict ask, run `rig-create job acts --wait` in the background.
5. Ingest the verdict with its printed `--from-review` command (for a legacy
   grouped question page with stored acts, collect every act from that
   publication and ingest the batch together). Ingest the current owner asks
   before sending a new target. Run `advance` if the stage requires it, then
   publish the next target into the same host. Option-set and plan publications
   carry `subjects: []` for viewing and comments; interview answers and stage
   sign-offs are asked in chat and relayed with `--owner-chat`.
6. Use `job close` at the end, for an explicit act discard, or to retire the
   host across a [pin or hook bump](JOB-RETIREMENT.md). If the process stops
   while the job is active, run `job open` again in the background using the
   same project, reviewer and role. It restores the same port and URL, then
   run `job reconcile` before more writes. Share a new URL only after a close.

A draft and a question share the same host and URL. If a legacy host
reports `JOB_HOST_REUSE_MISMATCH` with
`publicationMode expected=record-and-package found=package-only`, finish and
ingest its pending acts and run `job close` once. Reopen in the background
with `--questions`, `--question <id>` or `--plan` and share the new job's URL.

## Job commands

```sh
rig-create job open [<dir>] --reviewer <id> --role owner|delegate [--draft <id> | --rig <n> | --questions | --question <question>... | --plan]
rig-create job acts [<dir>] [--json]
rig-create job reconcile [<dir>]
rig-create job close [<dir>] [--retire-refused]
rig-create job close [<dir>] --discard-acts <reason> --by agent
rig-create job close [<dir>] --discard-acts --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>
```

`--rig <n>` selects an already registered rig or post and its retained review package,
including on a new job with an empty publication head. It accepts `1` or `v1`.
The version, complete retained package inventory and compiled model are checked
before starting the host or installing its binding, including pre-interview rigs.
Invalid selections refuse with `JOB_PUBLICATION_INVALID`; missing or changed
package files use the existing package-check refusal codes. Choose one of `--draft` and `--rig`; combining them
refuses with `JOB_BINDING_INVALID`. For a post, it retains the recorded parent rig and asks only
`review-verdict direction-review`. The legacy direction panel cannot render a post
publication with pending sign-off or checkpoint asks. Reopening an older post head
that declares those subjects replaces it with a verdict-only publication.
Reopening the same result over unchanged record
bytes reuses its publication and asks each declared subject once.

Judge direction on the post page with `job open --rig <post>`,
then ingest `review <post> --from-review <actId>`. Stage sign-off at
`direction-review` is recorded from owner chat with `signoff direction-review --owner-chat ...`,
followed by `advance accepted`. Previously stored record `signoff` acts from
[Review 4.21.0](https://github.com/rig-c/review/tree/v4.21.0)
([Review #795](https://github.com/rig-c/review/pull/795)) still ingest through
`signoff direction-review --from-review <actId>`.

The act has no version selector. Its record hash binds the exact displayed
`project.json` bytes. Before the first write, create checks those bytes and
selects the current/latest live post and its accepted live direction verdict.
Earlier accepted post versions do not make the current target ambiguous.
Missing, duplicate or unaccepted current targets refuse
`REVIEW_ACT_RECORD_TARGET_INVALID`. Create's compact receipt retains
`record_sha256`, equal to the act's record hash, plus the resolved
`target_version` and `verdict` reference. Ledger validation and replay compare
that target with the recorded signoff and verify the act's hash binding even
after later records or reopens. The full record is not copied into its receipt;
Review's wire shape is unchanged. Immutable-byte replay precedes current-record
checks; a changed act or compact receipt refuses without writing.

The default in `parts` and `parts-review` publishes the latest recorded draft.
`--draft` names a recorded draft in any stage. Opening asks every subject that publication declares (see
[Asks](#asks)). It prints `job: draft <id> published (publication <publication-id>)`,
or `job: draft <id> already published (publication <publication-id>)` when it
reuses the draft publication over the current record. Rig, post, plan and
option-set successes use the same suffix with their own labels.
Then `job: asked …` and `job: already asked …` name each subject. A `--draft` id
the record does not hold refuses `JOB_DRAFT_UNKNOWN` before writing `review_job`. A refused publish or ask
is printed while the background host keeps serving. The
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
active job. A listener restart updates the private binding's listener
incarnation while retaining the active job's capabilities.

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
| `draft-rig` | The labelled draft, C4 input inventory and retained output when its owner ask is ready | `draft` selector with the prepared `parts-verdict` at parts-review, or eligible checkpoint asks at parts |
| `rig-version` | The recorded rig and retained review package. Supply the build’s `bun.lock` or npm v3 `package-lock.json` with `--toolchain-lock`. | `rig` selector and `review-verdict` for `rig-review`, plus sign subjects |
| `direction write` | The recorded post, direction document and retained rig package | `post` selector and only `review-verdict` for `direction-review` |
| `advance rig-review` | The current live rig at the entered review stage | `rig` selector and one `review-verdict`; approval also signs rig-review |
| `advance direction-review` | The current live post at the entered review stage | `post` selector and only `review-verdict direction-review` |

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

When a bound draft is missing evidence for its owner ask, `draft-rig` records it
and leaves the open page and outbox unchanged. Its text output identifies the
missing evidence. Run the preparation moves shown by `next` and then
`job open --draft <id>` to show the prepared draft in the same job.

A bound writer or `job open` that reports
`JOB_ASK_PENDING` needs the owner to finish the current asks. Run
`job acts --wait`, ingest with the printed commands, then retry the command
to publish into the existing job.

A bound version writer refuses with `JOB_PUBLICATION_ASK_REQUIRED` before
committing if its candidate would replace an open page without an owner ask.
When a writer updates an open page, its text output names the new publication
ID and the asks Review accepted.

Participating bound writers hold a shared write lock as well as their existing
writer lock until publication acknowledgment. Before replacing the project,
the writer fsyncs a private outbox intent containing the published `versions[]`
entry hash and result selector. The hash uses that entry's two-space JSON
serialization with a final newline. After commit, the matching entry is pending until Review
acknowledges it. The pending identity and generation
remain stable across retries, including acknowledgment loss. A publish failure
leaves the committed result, and the writer exits 0 with a
`WARN JOB_PUBLISH_PENDING:` line on stderr beside its normal output: a
non-zero exit stays reserved for refusals, which leave the record byte-identical.
`interview --check` includes every pending entry in `holes[]` and exits 1.
Unbound projects retain their existing report shape and writer behavior.

On a bound job, `advance rig-review` and `advance direction-review` follow the
same commit-then-durable-outbox order for the current live `rig` or `post`
version: holding the shared job write lock, the writer validates the post-advance
candidate and live version before writing, records the outbox intent for the
post-advance record bytes, atomically replaces `project.json`, and publishes the
version with its `review-verdict` subject. A fresh rig approval at effective
rig-review also signs that stage, so no separate stage `signoff` is asked. If publication
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
current whole-record hash and removes the acknowledged entry. Reconcile and the
publish step of `job open` take pending entries in record order, not receipt-hash
order: record publications first, then drafts in `drafts[]` order, then rig and post
versions by number, so after a host restart the newest committed version ends as the
page head. A version or draft named with `job open --rig` or `--draft` goes last and
ends as the head. `job open` prints `job: pending rig v<n> published` (or
`draft <id>`, `post v<n>`, `plan`, `option-set …`) for every other pending entry it
published. Later signoffs,
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

When an open Review host advertises progress, Create reports milestones while
ingesting live acts, preparing drafts, versions and review packages, checking
or advancing the project, planning its next actions, and preparing a
publication. The page shows the latest line between asks. Create keeps the
sequence in the private job directory across CLI invocations. Review clears
the display when a publication, ask or close commits. Commands continue with
their usual output and exit status if the host is absent, lacks the capability
or refuses an update.

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
Interview answers are asked in chat and relayed with `interview-answer --owner-chat`; stored `interview-picks` acts still ingest through `interview-answer --from-review`. A passed `checkpoint` act is recorded by
`signoff <stage> --checkpoint <id> --from-review <actId>`: the act's `planStepId` must be `<id>`, an
enabled checkpoint `--checkpoint` accepts in that stage, and its displayed plan must be the current
one. The sign-off takes `by`, `at` and the words from the act and names it in `source`; a `fail`
outcome is refused (`REVIEW_ACT_CHECKPOINT_FAILED`) and writes nothing. A `signoff` act is recorded by
`signoff <stage> --from-review <actId>` (PROJECT.md § Recording a sign-off). Which publications
carry these two subjects is below, in Live sign-off routes. Image-review has no create version writer mapping. Described
correction and mesh-edit retain Review's reserved status.

`approved`, `changes-requested` and `pending` map to the existing verdict
vocabulary `accepted`, `bounced` and `provisional`. Host-attested owner maps to
`by: user`, and delegate maps to `by: delegate`. An interview pick or a sign-off from
an owner host opened for the agent (`--reviewer agent`) records the agent's id
as `by` instead, so it refuses as a pick (`INTERVIEW_CHOICE_INVALID`) or a
sign-off (`SIGNOFF_NOT_HUMAN`) and is never recorded as the owner's act. A
verdict from such a host refuses the same way: a rig, post or draft verdict
with `REVIEW_NOT_HUMAN`, and a parts verdict with `SIGNOFF_NOT_HUMAN`.
Create cannot tell an agent driving a page opened for the owner's own id from
the owner, so that act keeps the role mapping.
The complete reviewer identity,
authority, original words, time and source remain in the immutable act receipt.
Verdict ingestion records the verdict and exact act JSON. Signoff and stage advance require their own
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
version-entry hash. Historical semantic-API receipts keep their original
encoding. No act has a self-hash.

`review --from-review <actId>` fetches the raw act JSON with the consumer
grant. Rig verdict ingestion also retains it under `evidence/v<N>/` or
`evidence/drafts/<id>/`.
An act can carry a still identity, and Create leaves that metadata in the
JSON without fetching its PNG. Historical numbered receipts retain their
`added_evidence` array and corresponding still record. Historical draft
receipts retain their still binding, including its digest check when replayed
or carried into a registered rig.
The result and receipt are validated with the checker, fsynced and atomically
replaced together. Refusal preserves project.json bytes. `check` validates the
receipt hash, immutable act and linked verdict, including words and authority.
Historical receipts are checked against retained evidence, independently of
whether their sources are still current.

An unchanged replay reports the existing verdict without rewriting the record.
Replay discounts verdicts and exact historical still entries appended by ingestion after
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

`--picks-file`, review verdict `--verbatim-file`, parts `--evidence`, and
reshaped feedback JSON remain available for legacy/history workflows.
The current verdict path uses `--from-review` and preserves the fetched act
directly. Already recorded reopen acts remain checkable alongside their
`reopens[]` entries. An un-ingested reopen act produces
`REOPEN_ACT_RETIRED` in `job acts`. To correct an interview answer,
record the owner's new selection with `interview-options` and
`interview-answer`, then re-sign the approvals named by `next`. For an
artifact change, record the owner's correction with `amend` at the owning
stage. After an accepted post is bounced, `next` offers
`amend direction-review`. Then use `direction write` with
`--answers <version>:<verdict>` to bind the replacement post to the bounce.
[Forward amendments](PROJECT.md#forward-amendments).

## Live sign-off routes

Review 4.22.0 refuses fresh `signoff`, `checkpoint` and `interview-picks`
asks with `JOB_ASK_INVALID`. New submissions for those kinds refuse with
`JOB_ACT_KIND_DISABLED`. Eligible `review-verdict` and `parts-verdict` asks
remain available. Relay new owner approvals and interview answers through
Create's writers with the owner's `--by` and
`--owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`.
[Review 4.22.0 changelog](https://github.com/rig-c/review/blob/v4.22.0/CHANGELOG.md#4220)

### Historical subjects and stored-act ingest

Older draft and rig package publications declared `signoff` and `checkpoint`
subjects for the effective stage under the rules in `src/signable.ts`:

- A `checkpoint` subject identified an enabled step in its execution stage.
  The checkpoint writer uses the same eligibility rule.
- A `signoff` subject identified an unsigned stage that closed by sign-off.
  Rig-review used the rig publication's selector to target the signature.
  Direction sign-off used a separate source-linked record page. Plan-bound
  signatures also bound the displayed plan steps.

Review 2.8.0 required a declared subject (`bindJobAsk`, `src/job-act.ts`)
and checked that `project.json` matched the published bytes
(`assertJobSourceCurrent`, `src/job-source.ts`). The earlier rig and parts
flows could ask for separate sign-off on a publication with the appropriate
record bytes. Stored acts from those flows remain ingestible through the
existing `--from-review` writers, and already accepted submissions replay.

`job reconcile` keeps the declared subjects in the acknowledged receipt.
`signoff … --from-review` compares the act's subject with that list and
refuses one the publication did not declare (`REVIEW_ACT_SUBJECT_UNDECLARED`).
A receipt without the list, or no receipt at all (a clone), leaves only
Review's ask binding.

### Asks

Declare [owner language](PROJECT.md#owner-language) before starting a new
live publication. Record-backed asks display the authored plan and option
set copy verbatim. Create submits subject identifiers to Review, which
supplies the control labels and other interface copy in its own language.
Review uses the option set's question ID as the heading and the authored
`asks[].prompt` as the question wording.

Create asks for each eligible verdict subject in the process that acknowledges
the publication. Fresh option-set and plan record publications
declare `subjects: []` (showing the set, images or plan for viewing and
comments without opening an ask). Review's `next` response advertises
`capabilities.askBatch: true` for the host; Create batches eligible record
subjects, with up to 64 subjects per call.
A `draft`, `rig` or `post` selector publication uses one ask per subject,
including when the host advertises the capability. That covers `draft-rig`, `rig-version`,
`direction write`, `advance rig-review|direction-review`, `job reconcile`
and `job open`. The process already
holds Review's agent authority in memory for the publish, so the ask needs no
other transport. The authority never enters argv, the environment or a project
file, and agents never handle it. A subject already asked on that publication,
pending or answered, is not asked again (create reads the job's own `pending`
events), so a retry or re-open shows no second control. A new publication
supersedes the previous one's pending asks, as Review defines.

An ask Review refuses never makes the acknowledged publication pending again.
The publishing command reports `JOB_ASK_REFUSED` with each refused subject and
Review's code. Address the refusal before using `job open` to retry an
eligible verdict ask.

| Sign-off | Route | When |
| --- | --- | --- |
| `parts` checkpoints | owner chat | At an enabled checkpoint in `parts`, relay `signoff parts --checkpoint <id> --owner-chat ...` |
| `rigging` checkpoints | owner chat | At an enabled checkpoint in `rigging`, relay `signoff rigging --checkpoint <id> --owner-chat ...` |
| `post` checkpoints | owner chat | At an enabled checkpoint in `post`, relay `signoff post --checkpoint <id> --owner-chat ...` |
| `parts-review` | Review verdict or owner chat | In numbered projects, open the evidenced draft for `parts-verdict`. Approved ingestion signs the stage. If the verdict was already ingested unsigned, finish the structure snapshot and relay the sign-off against the current accepted parts verdict. On `current.parts`, relay the sign-off against the live recorded output |
| `rig-review` | Review verdict or owner chat | In numbered projects, approved `review-verdict` ingestion signs the stage atomically. If the verdict was already ingested unsigned, relay the sign-off against the current accepted rig verdict. On `current.rig`, relay the sign-off against the live recorded output |
| `direction-review` | owner chat | In numbered projects, ingest the current accepted direction verdict before relaying sign-off. On `current.direction`, relay sign-off against the live recorded output. Then run `advance accepted` |
| `plan-approved`, `rigging-interview`, `post-interview` | owner chat | Relay `signoff <stage> --owner-chat ...` at the approval stage |
| `interview` | owner chat | After `interview --check` passes, relay `signoff interview --owner-chat ...`, then `advance plan-approved` |

Use `job open --questions` to publish the effective interview stage's
registered pending sets on one Review page, or `job open --question <id>` for a
single set. Option-set publications carry `subjects: []`: Review shows the
option sets and their images for looking and commenting, while the owner is
asked in chat and each answer is relayed with `interview-answer --owner-chat`
using the displayed set hash and explicit option IDs. When the current post has
a live changes-requested verdict, both question selectors can publish pending
`post-interview` sets during active `direction-review`, and `next` lists the
owner-chat picks before it offers the replacement post write. Unrelated open
asks and finalized acts awaiting ingest still block replacement with
`JOB_ASK_PENDING`.

For an already-open legacy question page with stored `interview-picks` acts,
`job acts` lists partial arrivals as waiting for n/K sets with no ingest
command, and `--wait` keeps waiting until every set has an act before printing
the one `interview-answer --batch` command; a single stored act ingests with
`interview-answer <id> <dir> --from-review <actId>`. Review checks the exact
displayed `project.json` bytes on stored acts, so a partial ingest or owner-chat
write makes remaining un-ingested acts stale unless withdrawn or refreshed.

`interview-answer --from-review` reads picks at `rig-review/act@2` (package),
`rig-review/act@4` (record) and `rig-review/act@6`, which adds the owner's
ordered comments. An act@6 act is read through Review's `parseCommentsAct`
([Review #646](https://github.com/rig-c/review/issues/646)), and picks at a
later act version refuse `REVIEW_ACT_INVALID`. The answer records the picks and
note. When the act carries comments, Create retains the original act bytes and
records `review_acts[i].feedback_route` on the `interview-picks` receipt as
`{question, comments: [{order, text, anchor?}]}`. The comments keep the act's
order, with numbering from 1, and preserve the owner's exact text and any anchor, copied whole whatever its
kind. `check` validates the route against the retained act and refuses a
mismatch with `REVIEW_FEEDBACK_ROUTE_INVALID`. A retained receipt with comments
and no route gives `REVIEW_ANSWER_COMMENTS_UNROUTED` in `check` at any date.
Preserve that receipt and read its comments in `bytes` under `value.comments`.

`next` and `next --json` show one `REVIEW_ANSWER_COMMENT_ROUTED` warning and
agent move per open routed comment. The warning includes the question, order,
exact text, any serialized anchor and receipt path. Use the source identity
in the move and put the operator's explanation in a reason file.

```sh
rig-create interview-answer <source-question> [<dir>] --close-comment \
  --job <job-id> --act <act-id> --order <order> --by agent \
  --reason-file <file> [--resolved-by-answer <question>]
```

Use `--resolved-by-answer` when a later completed local answer or guide
resolves the comment. The closure binds the exact answer revision, so the
project retains the evidence in answer history if that answer is superseded.
For a no-change resolution, omit the flag and explain the reason in the file.
The writer records the resolution in `interview_comment_closures`, separate
from the original Review receipt. Replaying the same closure is a no-op.
After a valid closure, `next` drops that comment's warning and move. Closing a
comment records agent work. Owner answers and approvals still follow their
existing routes, and version `FEEDBACK_OPEN` counts continue to track bounced
verdicts.

At rigging-interview and post-interview, record the answer first, then revise
each earlier step that rests on it before running `job open --plan`. Compare
the step with the effective guide's recorded `at` even when owner chat carries
an earlier `said_at`. For previously completed work, `next` asks for an owner
amendment when needed, then prints the `plan replace` command that retains
the completed definition and execution history.

After recording every pick, run `interview --check` and relay the owner's
signature with `signoff interview --owner-chat`. Grouped and single-set
option publications remain available for viewing and comments in
[Review 4.24.0](https://github.com/rig-c/review/tree/v4.24.0), including the
multi-set route from [Review #1004](https://github.com/rig-c/review/issues/1004).
After advancing, `next` offers the separate `plan-approved` signature.

Stored interview sign-off acts using the plan carrier from
[Review #803](https://github.com/rig-c/review/pull/803) remain ingestible.
That carrier identifies non-empty displayed plan steps. The signature
approves the interview answers.

The historical publication and first ingest use the same full `checkProject` function as
`interview --check`. An unclean record refuses `INTERVIEW_SIGNOFF_NOT_CLEAN`;
an empty displayed plan refuses `INTERVIEW_SIGNOFF_PLAN_REQUIRED`.
First ingest also checks the act's record hash, displayed plan identities
and current interview stage. Refusals leave `project.json` byte-identical.
Immutable replay returns the recorded signature before current-stage checks.
The CLI `--by` route and earlier package-mode acts retain their behavior.

In `post` and `direction-review`, `job open --plan` names the picture the owner
judges the plan against as `planPicture: {path, sha256}`
([Review #983](https://github.com/rig-c/review/issues/983), issue #665). It is the
first `.png`, `.jpg`, `.jpeg` or `.webp` row of the newest live `kind: "post"`
version, read from `evidence` (newest first) and then `outputs`. The path and
SHA-256 are the record's own, and the file joins `files` like any sealed read. A
record without such a row, or whose named file is absent, publishes no field, as
before. Earlier stages and option sets never carry it. The field needs a served
Review with the #983 contract, which the release-pinned
[Review 4.24.0](https://github.com/rig-c/review/tree/v4.24.0) supports.
A Review host without that contract refuses it with `JOB_SOURCE_MISMATCH`.

## Rig approval in one sitting

At effective `rig-review`, a fresh publication declares one `review-verdict`.
Ingest its approved act with `review <n> --from-review <actId>`: the exact Review
words, human authority and date supply both the verdict and signature in one
atomic record replacement. The signature targets the displayed live rig and its
accepted verdict using the separate writer's candidate and source gates. Advance
normally after ingestion; ingestion never moves the stage. Pending and
changes-requested verdicts do not sign.

The optional `review_acts[].signoff` index binds the signature to its approved
immutable act; check and replay validate its authority, words, target and unique
mapping. Replay returns the original record without adding a signature. Old
verdict-only receipts remain verdict-only. An acknowledged publication declaring
both `review-verdict rig-review` and `signoff rig-review` retains those two acts;
missing retained subject metadata also preserves the separate-signoff contract.
After an old verdict ingest, reopen the same job to refresh the record binding
before its separate signoff. Stale project and package guards remain strict.

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
reader supplies the draft selector, part IDs and the exact C4 Parts enumeration
over the recorded draft input. Draft registration publishes this inventory
before it asks for a verdict. The owner is asked for a `parts-verdict` only
at `parts-review`, once that draft's agent evidence is prepared. An inventory
publication alone does not ask the owner to approve parts. Config, config inputs
and retained outputs are sealed as publication files. Producer bytes are read
and hash-bound. Publication performs no build or producer measurement.

The manifest, and its rigging form `review-rigging-draft-<id>.json`, sits at
the project root beside `project.json`. It is written when a bound `draft-rig`
commits, by `job open --draft <id>` and by `job reconcile`. `parts-review`,
`next` and draft review-verdict ingest read it at that exact path and refuse
if it is missing or changed. It is live state, not scratch: projects commit it, and
init's `.gitignore` does not ignore it. Each draft ID has one file for the
project's life. Publishing the same draft again leaves identical bytes alone,
and no command, `job close` and retirement included, deletes it. Only a
retained legacy or orphaned form is rewritten; any other difference refuses
`JOB_PUBLICATION_INVALID`.

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

Prepare the first draft before asking for a verdict:

1. Retain its `check-parts` report, structure snapshot, `diff-components`
   report and `diff-classes` classifications. Snapshot creation needs no verdict.
2. As soon as that first draft has this agent evidence, advance to
   `parts-review`. Do not wait for owner approval to enter the review stage.
3. Publish the prepared draft with `job open --draft <id>`. The one owner ask
   is `parts-verdict`, and it is asked only at `parts-review`.
4. Run `rig-create job acts --wait` in the background and ingest its printed `parts-review --from-review <actId>` writer command.

Stay at `parts-review` throughout retouch rounds. A changes-requested verdict
leaves the stage unsigned. The agent makes an `edited_parts` correction,
registers a new draft, and prepares fresh check and difference reports,
structure snapshot and classifications for that draft. Open the new draft
with `job open --draft <new id>` and ask for one new verdict. This loop needs
no separate signoff or move back to `parts`.

Approved UI ingestion atomically records the receipt and `parts-review`
signature, taking `draft_id` from the verdict, `structure` from that draft's
retained snapshot and `evidence` from that verdict. It requires no second
human act. Pending and changes-requested verdicts leave the stage unsigned.
Earlier evidence stays historical; prepare the new draft's evidence rather
than reusing the prior round's reports or snapshot. If old evidence blocks the
new approval's signature, or registering the new draft requires an amendment or
moving back to `parts`, stop and report that structural blocker.

Finish each draft's record changes before publishing and asking for its
verdict. A stale `projectHash` refuses ingestion; do not modify the record after
the act to satisfy prerequisites. Complete preparation, republish and ask for a
new verdict instead.

The separate `signoff parts-review <project> --draft <id> --structure-file
<path> --from-review <actId>` route remains only for a midflight approved verdict
already ingested unsigned. Prepare any missing snapshot before publishing and
asking for that separate signoff. Legacy signatures remain readable; this
additive route introduces no SINCE date and changes no other stage's acts.

At check and signoff, retained parts approval checks its draft bindings
independently of later plan changes, including checkpoint decisions. Snapshot
creation checks the draft/config binding, without requiring an approval.
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

The trusted record-plan and package readers include `checkpointEvidence` whenever
the record carries sealed packets, without declaring a checkpoint ask. Every supplied asset enters the
trusted closure with its exact path and raw SHA-256. Record option sets omit this
extension. Historical absence emits no evidence field. Review's signed extension
owns full PNG decoding, source/instance hashing, retained delivery and EN/KO owner
presentation. Runtime publication requires that extension in the served Review.

A rig publication also carries `chestLandmarks` for Review's chest editor
(act@9) when the rig build's own config gives a part a `contour.bust` spec. Each
row copies that spec as written, with the config's SHA-256, and binds the part's
setup mesh attachment (default skin, the slot's `setup` attachment, the hash of
its stored entry) and the model stage. A bust spec whose part has no setup mesh
in the retained model refuses `JOB_PUBLICATION_INVALID`. A rig without a bust
spec, a post and a draft publication carry no field, and Review shows the chest
editor as read-only. Reviews before act@9 drop the field.

Ingest the chest edit with
`rig-create review <n> --from-review <actId> --config <working-config>`.
On first ingest, Create matches the original publication's ID, source hash and
chest row identities using the live Review event stream. Each seed must name
the recorded portable config SHA-256. The working config must be a
project-relative regular file outside `evidence/` and `derived/`, with no
symlinks, hardlinks or `..` components. Its bytes must match the frozen
`registration.config_source.sha256`. Create records the working path and its
pre-edit SHA-256, retains the exact act bytes in `evidence/v<n>/<sha256>.act.json`,
and records the bounced verdict. Mesh edits in the same act follow the existing
mesh correction route. Drafts have no act@9 ingestion route.

The writer and `rig-create next` print two commands to run in order from the
project root with Parts 2.55.0 or later. `rig-parts bust-landmarks --from-act`
uses the retained act, the registered parts directory and the working config
with `--write-config`. Keep its landmarks JSON and the adjacent
`.provenance.json` sidecar together under `evidence/`, outside the parts
directory. `rig-parts propose` uses the same parts and working config
(`--write-config <working> --bust-landmarks <landmarks>`), the recorded
painting and a disposable output directory, without `--full` or `--head`.
Parts may report `BUST_LANDMARKS_*` from the first command or `PROPOSE_BUST_*`
from the second.

Replaying ingestion prints the same chain with `REVIEW_ACT_BUST_REPLAY` and
uses the receipt's working path, even after Parts has updated that file.

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


### Withdrawn checkpoint subjects

After `plan checkpoint-withdraw`, the next normal publication omits the matching
withdrawn checkpoint subject and its checkpoint presentation. Other checkpoint
and signoff subjects retain their existing selection rules. The withdrawal
writer does not refresh an existing publication or alter packet records/assets.


### Execution-bar policy journal

`plan bar-amend <id> --by <operator> --reason-file <file> --quote-file <file>
--bar-file <file>` records an explicitly authorized operator policy with its
exact quoted words. It creates no Review act or signature, changes no original
step approval hash and adds no Review panel, subject or gate. This narrow policy
operation does not replace the Review path for any other human decision.
The bound journal and effective-bar rules are in PROJECT.md, "Operator amendment
of an execution bar". Existing publications are not refreshed by this writer.
