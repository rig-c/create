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

- **Pending outbox entries must reconcile first.** If `.rig-create-review/outbox/`
  holds a pending publication, `job close` refuses `JOB_PUBLISH_PENDING` until
  that publication is reconciled against its original host configuration.
- **`job close` preserves `project.json`.** Retiring the bound host revokes the
  active job's fetch grant and removes the matching `.rig-create-review-binding.json`
  while leaving `project.json` byte-identical. The subsequent `job open` starts a
  fresh job at the current pin and updates `project.json.review_job` and the
  private binding.
- **Host identity and capability checks remain enforced on close.** `job close`
  still verifies the project `root` (path and inode), `stateDir`, `fingerprint`,
  `reviewer` (`id` and `role`), `jobId`, `origin`, `listenerIncarnation`, and
  host descriptor agreement (`JOB_HOST_REUSE_MISMATCH` or `JOB_HOST_ATTACH_REFUSED`),
  and verifies that the stored `fetchCapability` is authorized for the bound live
  job before closing (`JOB_BINDING_INVALID`). A copied binding or unauthorized
  grant is refused before any unrelated or bound host is retired.
- **Ordinary `job open`, `job reconcile` and bound writers stay strict.** Only
  `job close` accepts the stored binding's earlier hook identifiers and Parts
  enumerator version (within Review's supported `>=2.25.0 <3.0.0` range), with
  reader and enumerator callbacks fail-closed so an older binding never serves
  new producer logic.
