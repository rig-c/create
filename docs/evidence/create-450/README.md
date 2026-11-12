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

The derived test list and its command are retained beside this receipt.
`git diff --name-only origin/main...HEAD` supplies the changed paths; their
paths, basenames and stems are passed to
`rg -l -F -f changed-modules.txt tests --glob '*.test.ts'`, union the changed
test files, sort, and run that exact list in one `bun test` invocation.
The list names 56 of 109 files. The completed run exits 1: 1,333 pass, 2 skip,
1 fail, 1 timeout error, 8,975 assertions; 1,336 tests in 382.02 s. Its only
failure is the pre-existing `job-signal-ask.test.ts` concise text/JSON output
case at the unchanged 5-second limit. No local repeat or limit change was
made. PR CI is the full verdict. The two existing Mac 5-second job-signal-ask timeouts and
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
- `derived-a1`: exit 1; counts and the unchanged known timeout are listed above.

No Review changes, pilot access, automatic ingestion or contract date is
included. The agent guide and generated templates are unchanged. The event
reader was extracted from the existing `askedSubjects` loop; both existing
ask reconciliation and `job acts` use that single agent-next traversal.

## Integration with main 713fe69

Main was merged normally (two-parent merge, no rebase or force push) after
#448 landed. Four textual conflicts were resolved:

- `src/job-host.ts`: union imports; preserve main's record-mode functions and
  API selection, with the shared event traversal and act list on top.
- `src/job-runtime.ts`: combine record-selector fields/imports and `json`/acts;
  leave main's open, publish, reconcile and close paths intact.
- `src/cli.ts`: retain --question/--plan and their exclusivity; add acts/--json
  independently; forward all corresponding stdin fields.
- `docs/CHECKS.md`: keep the complete main record-publication section and the
  new act-discovery section and code rows.

An AST/text control confirms 22 main host function bodies verbatim (the sole
intentional replacement is askedSubjects using the shared reader). A second
control confirms all four main runtime cases verbatim. No #448 tests or
record-mode implementation was edited. A new act-discovery test covers the
actual merged record host: public --question -> owner act@4 -> job acts ->
execute printed interview-answer command -> ordinary check exit 0.

| Post-merge verification | Exit / counts |
| --- | --- |
| Host and runtime preservation controls | 0; 22 function bodies and 4 runtime cases unchanged |
| `bun run typecheck` | 0 |
| `bun run lint` | 0 |
| `bun test tests/job-acts.test.ts` | 0; 6 pass, 66 assertions |
| Fresh derivation against origin/main | 0; 57 of 110 files, `merge-derived-tests.json` |
| One canonical-TMPDIR run of those 57 files | 1; 1,343 pass, 2 skip, 1 fail, 1 timeout error, 9,154 assertions; 1,346 tests in 463.88 s |

The only post-merge failure is again the unchanged 5-second concise text/JSON
job-signal-ask case. No timeout, existing assertion or path guard was changed.
This rerun was explicitly requested for the changed merge tree, not a retry
that relabelled the earlier RED. `merged-user-path.jsonl` retains the updated
CLI/owner API receipt, including actual record-mode act discovery. Typecheck,
lint and both preservation controls are green. The tower owns the subsequent
PR CI watch and merge decision.
