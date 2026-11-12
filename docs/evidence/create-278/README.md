# Record publication receipt (#278)

The synthetic projects are seeded stage prefixes from `example-project.json`.
All operations under test use the public CLI and Review 2.13.0 authenticated
owner HTTP API, with a synthetic reviewer. These are test acts, not owner
acceptance of a consumer project. No pilot was read or changed.

`user-path.jsonl` retains each CLI command, exit, before/after record hashes,
published source closure, ask identities and finalized acts. Project roots,
the installed checkout path and owner URLs are replaced by placeholders;
act values, source hashes and relative sealed files are unchanged. The raw
unredacted local receipt is retained by the runner. The two unit fixtures in
`tests/fixtures/record-acts/` are frozen finalized acts from the preceding
successful HTTP path capture, with producer source hashes unchanged.

## Completed controls

| Command / control | Exit | Result |
| --- | ---: | --- |
| `bun install --frozen-lockfile` | 0 | Review 2.13.0, Parts 2.37.0, Core 3.7.0; Bun 1.4.4 |
| `bun test tests/record-job-path.test.ts` (canonical external TMPDIR) | 0 | 7 pass, 153 assertions; picks (ordered selections, exact Other text/note, fresh resolution), checkpoint, rigging/post signoffs, replay, refusals, first unanswered questions |
| `bun run typecheck` | 0 | Current implementation and tests |
| `bun run lint` | 0 | Current implementation and tests |
| Nova `generate-example-chain`, `generate-example-remesh`, then both `--check` modes | 0 | Byte-for-byte reproduction; run `20261112T051016Z-82603ccbb8914f7fbfe377f09ed43219`, 20.56 s held |
| `renderAgentGuide()` UTF-8 length | 0 | 9,976 bytes; generated example guides match |
| Legacy API@2 finalized fetch on mixed hosts | 0 | Every successful public act ingestion uses the existing API@2 fetch implementation |
| Compatibility unit file, including direct and API@2 decoding of valid @4 picks/signoff | 0 | 4 cases; unsupported @4 parts/review and API@3 envelope refusals retained |

The ordinary checker still returns exactly
`INTERVIEW_INCOMPLETE` at `interview.waypoints[motion].guide` or
`interview.post.items[camera_depth].guide`, exit 1, immediately before and
after record publication. Both explicit before/after comparisons are in the
receipt. Only option-set publication in an open interview discounts a finding
whose code is `INTERVIEW_INCOMPLETE` and whose path is a currently silent item
belonging to the effective interview stage. Inventory and retained phases use
the same condition. Plan publication and ordinary checks are unchanged.
After the explicit pick, ordinary check exits 0.

## Derived sample and local baseline

The test list was derived from `git diff --name-only origin/main...HEAD`:
collect each changed path, basename and stem, then
`rg -l -F -f changed-modules.txt tests --glob '*.test.ts'`, union the changed
test files, sort, and invoke one `bun test` with that list.
`derived-tests.json` records the exact 93-file sample list and its inputs.
After the approved compatibility fixtures and evidence files were added, the
same derivation names 95 files (`derived-final.json`), adding
`contract-dates.test.ts` and `invariants.test.ts`. The tower's no-repeat ruling
applies; PR CI covers the final tree. The original 93-file sample is preserved
separately and is never described as the final 95-file run.

The sample had a 600-second bound: **exit 124, incomplete**, 1,839 passing
observations and four recorded failures, with 85/93 suites started. This is
not a passing local suite. The tower explicitly ruled to skip the estimated
11-minute repeat and use PR CI as the full verdict.

| Recorded sample failure | Scoped comparison, unchanged assertions/limits |
| --- | --- |
| `still-writer-cycle.test.ts`: `JOB_PUBLICATION_INVALID` for the `/var` alias | Pre-existing on `6e81d1e` locally: `bun test tests/still-writer-cycle.test.ts` exits 1. With canonical external TMPDIR the same command exits 0 on main (1 pass, 2.66 s) and the feature (1 pass, 2.76 s). |
| `job-signal-ask.test.ts`: concise text/JSON subject case exceeds 5 s | Pre-existing on `6e81d1e` locally: canonical TMPDIR + `bun test tests/job-signal-ask.test.ts -t 'bound writers print concise'` exits 1, 1 timeout. Same feature control exits 1. |
| `advance-publication.test.ts`: direction-review case exceeds 5 s | Canonical isolated `bun test tests/advance-publication.test.ts -t 'advance direction-review on a bound job'` exits 0 on main and feature (1 pass each). No limit/assertion changed. |
| `review-280-compat.test.ts`: obsolete unsupported @4 picks/signoff expectation | Changed only by the tower's explicit ruling; new admitted-but-malformed kinds reach act validation. All other assertions remain. |

The additional existing `JOB_ASK_REFUSED` signal case also exceeded 5 s in the
scoped group. Canonical isolated
`bun test tests/job-signal-ask.test.ts -t 'bound writers surface JOB_ASK_REFUSED'`
exits 1 on main and the feature. No fix or filing is included. One earlier
feature ASK probe overlapped a path probe briefly; it was excluded as timing
evidence and replaced by the serial control. These local timeouts are recorded
as pre-existing on `6e81d1e` locally, not silently promoted to PASS.

## Earlier attempt history

All per-attempt logs remain retained by the runner. Nonzero commands, in
execution order (each is a distinct attempt):

| Attempt | Command | Exit / first error |
| --- | --- | --- |
| typecheck-a1 | `bun run typecheck` | 2; missing RecordResult import / result narrowing |
| typecheck-a2 | `bun run typecheck` | 2; package test helper's result type widened |
| precheck-a1 | `bun test tests/record-publication.test.ts tests/job-publication.test.ts` | 1; 82 pass, 5 fail; JOB_HOST_OPTION_ID_INVALID from changing package-only defaults; defaults restored |
| record-path-a1 | `bun test tests/record-job-path.test.ts` | 1; 1 pass, 4 fail; test used nonexistent standalone `check` command |
| record-path-a2 | same | 1; 3 pass, 2 fail; STAGE_LAGGING after signoff; added separate explicit advance |
| typecheck-a3 | `bun run typecheck` | 2; generic enqueue return for existing private receipt |
| record-path-a4 | `bun test tests/record-job-path.test.ts` | 1; 4 pass, 1 fail; JOB_IDEMPOTENCY_CONFLICT; record retry keys now include stored generation |
| first-unanswered-a1 | `bun test tests/record-job-path.test.ts -t 'first unanswered'` | 1; 2 fail; JOB_RECORD_INCOMPLETE / INTERVIEW_INCOMPLETE before the first pick |
| derived-final-a1 | Derived 93-file command above | 124; incomplete, four failures listed above |
| scoped-controls-a1 | Canonical TMPDIR, still-cycle/signal/advance/compat files | 1; 13 pass, 2 fail; unchanged 5 s signal limits |
| signal-isolated-head/main-a1 | Concise subject case above | 1 each; unchanged 5 s limit |
| ask-isolated-main-a1, head-a2 | JOB_ASK_REFUSED case above | 1 each; unchanged 5 s limit |
| still-main-default-a1 | Still-cycle without canonical TMPDIR | 1; JOB_PUBLICATION_INVALID path alias |

Successful intermediate controls include 54/0 publication + record-path tests,
5/0 full record path, 2/0 first-unanswered tests and the final 7/0 path above.
No test timeout or pre-existing path/producer assertion was relaxed.
