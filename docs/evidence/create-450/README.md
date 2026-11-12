# Finalized act discovery receipt (#450)

A synthetic rig-review prefix exercises the public CLI and Review 2.13.0's
owner HTTP API: `job open` -> `advance rig-review` -> owner verdict ->
`job acts --json` -> execute the exact printed writer command ->
`interview --check` (exit 0). After a refresh, the owner signoff is also
listed and its printed command ingests it. Ingested IDs disappear. Signoff
still does not advance the stage. The project path contains a space and
an apostrophe; the printed POSIX command is executed through a test CLI shim,
not reconstructed from its argument array. These are synthetic test acts,
not a consumer owner's acceptance.

`user-path.jsonl` retains public commands, exits, record hashes, finalized
acts and returned metadata. Ephemeral project/check-out paths and owner URLs
are replaced by placeholders. The lookup is byte/mtime/mode-identical over
the project, binding and outbox; stopped/missing host controls refuse
`JOB_HOST_ATTACH_REFUSED` without bootstrapping. Agent-next pagination and
refusal cleanup share the production reader and are tested separately.
Unavailable writer targets remain listed with a named code and null command;
no version or checkpoint stage is guessed.

## Verification

| Command | Exit / counts |
| --- | --- |
| `bun install --frozen-lockfile` | 0; Review 2.13.0, Parts 2.37.0, Core 3.7.0; Bun 1.4.4 |
| Canonical external TMPDIR, `bun test tests/job-acts.test.ts` | 0; 5 pass, 55 assertions |
| `bun run typecheck` | 0 |
| `bun run lint` | 0 |

The derived test list and its command are retained beside this receipt. PR CI
is the full verdict. The two existing Mac 5-second job-signal-ask timeouts and
the default `/var` alias refusal were already reproduced on main `6e81d1e`
in #448; no timeout, existing assertion or source path guard is changed here.

## Attempt history

- `typecheck-a1`: `bun run typecheck`, exit 2; the public parts source union
  required an explicit draft selector guard. Fixed in this card's new mapper.
- `path-a1`: new public-path tests, exit 0; 3 pass.
- `path-a2`: path plus paging/refusal tests, exit 0; 5 pass, 55 assertions.
- `typecheck-a2`: `bun run typecheck`, exit 2; the new shell execution helper
  omitted `stdout` from its own assertion object's declared type. Fixed.
- `lint-a1`, `typecheck-a3`, `lint-a2`: exit 0.

No Review changes, pilot access, automatic ingestion or contract date is
included. The agent guide and generated templates are unchanged. The event
reader was extracted from the existing `askedSubjects` loop; both existing
ask reconciliation and `job acts` use that single agent-next traversal.
