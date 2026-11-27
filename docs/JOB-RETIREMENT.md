# Retiring a live Review job across a pin or hook bump

When a live Review job was opened before a `@rig-c/parts` pin bump or a
producer hook identifier change, ordinary reuse, publication and reconciliation
from the updated checkout refuse `JOB_HOST_REUSE_MISMATCH`. Retire the older
bound host with `job close`, then open a new job at the current pin:

```sh
rig-create job close <project>
rig-create job open <project> --reviewer <id> --role <owner|delegate> [--draft <id>]
```

## Recovery rules

- **Pending outbox entries block close.** If `.rig-create-review/outbox/`
  holds a pending publication, `job close` refuses `JOB_PUBLISH_PENDING`
  whether the host is running or stopped. Reconcile against the original host
  configuration first, or pass `job close --retire-refused` to archive failed
  pending receipts under `retired-publications/` and close without publishing
  them; unfailed pending publications still refuse `JOB_PUBLISH_PENDING`.
- **`job close` preserves `project.json`.** Retiring the bound job revokes the
  active job's fetch grant (when the Review store is present) and removes the
  matching `.rig-create-review-binding.json` while leaving `project.json`
  byte-identical, except when `--discard-acts` explicitly appends `discarded`
  receipts to `project.json.review_acts[]`. The subsequent `job open` starts a
  fresh job at the current pin and updates `project.json.review_job` and the
  private binding.
- **Host identity and capability checks remain enforced on close.** `job close`
  still verifies the project `root` (path and inode), `stateDir`, `fingerprint`,
  `reviewer` (`id` and `role`), `jobId`, `origin`, `listenerIncarnation`, and
  host descriptor agreement (`JOB_HOST_REUSE_MISMATCH` or `JOB_HOST_ATTACH_REFUSED`),
  and verifies that the stored `fetchCapability` is authorized for the bound
  job before closing (`JOB_BINDING_INVALID`). A copied, replaced or foreign
  binding is refused before any unrelated or bound job is retired.
- **Same-pin stopped hosts restart; older-pin stopped hosts retire directly.**
  When the binding matches the current pin and producer hook identifiers, a
  stopped host refuses `JOB_HOST_ATTACH_REFUSED` and names the `job open`
  restart so the same job can be resumed and its finalized owner acts ingested
  before closing (`job close` waits up to 120 s for a restarted host's job
  write lock, then refuses `JOB_WRITE_BUSY` naming the holding process). When
  the binding was made under an older `@rig-c/parts` pin or an earlier hook
  identifier that `job open` refuses with `JOB_HOST_REUSE_MISMATCH`, and the
  bound host is not running (its recorded loopback port refuses connections),
  `job close` retires the binding without needing the older pin installed:
  - **What stopped-host retirement records and cannot do.** It removes the
    matching `.rig-create-review-binding.json`, closes the active job row in
    `stateDir/jobs.sqlite` when that store is still on disk, and leaves
    `project.json` byte-identical unless `--discard-acts` records discarded act
    receipts. It cannot keep the previous Review page or URL alive, cannot
    collect new owner submissions, and cannot serve `comment --from-review`
    ingestion from the stopped job.
  - **Unfetched finalized owner acts on a stopped older-pin job.**
    - *When `stateDir/jobs.sqlite` is still on disk:* finalized acts committed
      before the host stopped are still on disk in Review's SQLite store.
      `job close` opens that store with fail-closed producer callbacks, reads
      its finalized acts, and refuses `JOB_ACTS_PENDING` if any un-ingested act
      is pending so acts are not silently dropped. Because the stopped older-pin
      host cannot serve `comment --from-review`, pass
      `job close --discard-acts <reason> --by agent` (or relayed owner-chat
      flags) to record `discarded` receipts in `project.json.review_acts[]` and
      close the job; the historical act rows remain in the closed SQLite store
      but can no longer be fetched once closed.
    - *When the canonical managed `stateDir/jobs.sqlite` under the system
      temporary directory is already absent (`reason=missing, phase=state`):*
      the stopped host has no store left on disk, so any acts that were never
      fetched were lost with that temporary host state. `job close` records no
      act receipts, leaves `project.json` byte-identical, and removes the
      binding after verifying the canonical `stateDir` and that the recorded
      port refuses connections.
- **Ordinary `job open`, `job reconcile` and bound writers stay strict.** Only
  `job close` accepts the stored binding's earlier hook identifiers and Parts
  enumerator version (within Review's supported `>=2.25.0 <3.0.0` range), with
  reader and enumerator callbacks fail-closed so an older binding never serves
  new producer logic.

## Withdrawing an act while keeping the live page

`job withdraw-act <actId> [<project>] --by <owner> --owner-chat <file>
--said-at <ISO> --relayed-by <operator>` records one owner-authorized discard
and keeps the job and its URL. Other pending acts can still bind the record
they displayed when only withdrawal receipts have been appended.

| Command or condition | Does the current Review page survive? |
| --- | --- |
| `job withdraw-act` | Yes. |
| Successful `job close`, including `--discard-acts` and `--retire-refused` | No. The next open serves a new job. |
| `job open` with the existing live binding and the same reviewer and role | Yes. It publishes into the existing job when a new source is ready. |
| `job reconcile` with the existing live binding | Yes. It publishes pending work into the bound job. |
| `job open` or `job reconcile` archives an offline job bound to a replaced project root | No. `job open` serves a new job; `job reconcile` requires a subsequent open. |
