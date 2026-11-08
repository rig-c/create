# Writer-owned live review

Open the standing owner window from a foreground terminal. Keep that command
running while writers commit results. The reviewer identity is the trusted
bootstrap identity used by Review.

```sh
rig-create job open <project> --reviewer <id> --role owner
rig-create job reconcile <project>
rig-create job close <project>
```

The open command prints the private owner-window URL. Keep it private. The
versioned `review_job` stores only `jobId` and `origin`. The host installs its
fetch grant in the owner-only sibling `.rig-create-review-binding.json` and
ensures it and the durable `.rig-create-review/` outbox are ignored before
writing either. New projects declare both root patterns in init's `.gitignore`.
Existing Git projects receive only missing patterns in `.git/info/exclude`,
preserving their tracked `.gitignore` bytes. A folder without Git receives a
minimal `.gitignore` append. Effective ignores are checked before writing.
A tracked private path refuses startup. Agents invoke writers and never construct this file.
Explicit close revokes the grant and removes the matching binding. Listener
shutdown alone preserves the active job. A new incarnation receives a new grant.

The outbox, intents and discard log live in the project-root
`.rig-create-review/`, independently of the binding and TMPDIR. Its directories
are owner-only 0700 and files 0600, with symlinks refused. Private Review host
state stays outside the project under the system temporary directory, as its
host contract requires. Losing that host state leaves the durable publication
HOLE visible.

## Phase 1 results

| Writer | Published result | Review subject |
| --- | --- | --- |
| `draft-rig` | The labelled draft, C4 input inventory and retained output | `draft` selector and `parts-verdict` |
| `rig-version` | The recorded rig and retained review package | `rig` selector and `review-verdict` for `rig-review` |
| `direction write` and `direction patch` | The recorded post, direction document and retained rig package | `post` selector and `review-verdict` for `direction-review` |

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

If the owner host disappears between preflight and startup, Review can briefly
start a replacement listener. The writer checks `reused`, job ID and origin,
stops that handle immediately and leaves a named pending receipt without
publishing. The future Review reuse-only attach option (to be filed) will
replace this single attachment boundary.

Cross-process subscription delivery uses a **30-second server wait cycle**.
Scheduling, transport and rendering add elapsed time. Review 2.4.6 defines
`jobWaitLimitMs = 30_000` in `src/job-api.ts` line 11 and reads durable events
after the timer in `src/job-session.ts` lines 475–498. Its local notification
function is at line 286. The window's previous/new label notice is implemented
in `web/job-session.ts` lines 1711–1712.

Review 2.4.6 refuses records containing answered scene-context choices or
reader diagnostics with `JOB_RECORD_INCOMPLETE` before this reader runs.
Those publications remain pending until review#555 supplies its contract.

## Finalized verdict ingestion

```sh
rig-create review <version> <project> --from-review <actId> --json
```

The synchronous writer uses its private #184 binding to fetch the finalized act
from the exact loopback job API. Its subprocess receives no Review state path or
host callbacks. It opens no host and carries no producer storage file. The grant
travels in Authorization, and the private process transport uses stdin/stdout.
Human-value and feedback flags are exclusive with `--from-review`.

The shared reader checks `rig-review/job-api@2`, `rig-review/act@2`, and the
act's Parts enumerator version against `>=2.25.0 <3.0.0`. API@1 and act@1 are
refused without migration. Rig/post `review-verdict` and draft `parts-verdict` use their respective writers.
Interview picks, signoff and checkpoint ingestion await their follow-up cards. Image-review has no create version writer mapping. Described
correction and mesh-edit retain Review's reserved status.

`approved`, `changes-requested` and `pending` map to the existing verdict
vocabulary `accepted`, `bounced` and `provisional`. Host-attested owner maps to
`by: user`, and delegate maps to `by: delegate`. The complete reviewer identity,
authority, original words, time and source remain in the immutable act receipt.
A verdict records only a verdict. Signoff and stage advance require their own
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
keyed by `(jobId, actId)`. Each retains the API's semantic act encoded once with
`JSON.stringify` as a `bytes` string, SHA-256 of those exact UTF-8 bytes, the
version and verdict index, and the pre-append version-entry hash. This encoding
is explicit and does not claim to be Review's private storage serialization.
The result and receipt are validated with the checker, fsynced and atomically
replaced together. Refusal preserves project.json bytes. `check` validates the
receipt hash, immutable act and linked verdict, including words and authority.
Historical receipts are checked against retained evidence, independently of
whether their sources are still current.

An unchanged replay reports the existing verdict without rewriting the record.
Replay discounts verdicts appended after its recorded verdict index when
comparing the pre-append version-entry hash. Other original version fields and
prior verdicts remain covered. Source changes refuse `REVIEW_ACT_SOURCE_STALE`
with the recorded verdict untouched. This implements create#182's C4 ruling
against the installed dedupe-first order in Review 2.4.6 `src/job-contract.ts`
lines 574–576. C4's source-check requirement is recorded in create#182's
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
