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
adds that exact name to `.gitignore` before writing it. A tracked binding
refuses startup. Agents invoke writers and never construct this file.
Explicit close revokes the grant and removes the matching binding. Listener
shutdown alone preserves the active job. A new incarnation receives a new grant.

Private managed state and the writer outbox live under the system's private
temporary directory, outside the project. Preserve that state while a job or
pending publication needs it. Temporary-directory cleanup can remove it.

## Phase 1 results

| Writer | Published result | Review subject |
| --- | --- | --- |
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
This includes declared sibling PNGs omitted by the historical copied package.
A package without `from` uses its own `out` directory. Its `images` preserves every returned row, role, duplicate path and
position. The enumerator version is read from the installed package metadata.
Review re-enumerates and validates the supplied identity under API@2/act@2.

## Commit and recovery

Participating bound writers hold a shared write lock as well as their existing
writer lock until publication acknowledgment. Before replacing the project,
the writer fsyncs a private outbox intent containing the exact candidate hash
and result selector. After commit, the matching intent is pending until Review
acknowledges it. The pending identity and generation
remain stable across retries, including acknowledgment loss. A publish failure
leaves the committed result and reports `JOB_PUBLISH_PENDING` beside the write.
`interview --check` includes every pending entry in `holes[]` and exits 1.
Unbound projects retain their existing report shape and writer behavior.

Run `job reconcile` after restoring the host or declared package. It holds the
same lock, publishes the original record hash and removes the acknowledged
entry. Reconciliation never rewrites `project.json`. A changed record refuses
with `JOB_PUBLICATION_STALE`. Another participating writer and explicit close
wait until pending work is reconciled. After process loss, `check` and reconcile
recover a dead writer's shared lock. An intent matching the current record is
a pending HOLE. An unmatched precommit intent is dropped with its ID and hash
in the private `discarded-intents.jsonl` log. Active writer intents stay held.
A refused write cancels its uncommitted intent. Receipt recovery and
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
