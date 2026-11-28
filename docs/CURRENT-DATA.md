# Current data only: one output per kind, history in git

Design for rig-c/create#980 step 4 (card #984). Implementation is #985; old
projects are #986. This document changes no code. Every fact names a
`file:line` at origin/main `fa4c48b5`. A design choice is marked **Choice**
with one line of reason. Anything not measured is marked **unknown**.

#1018 adds current motion and direction alongside the numbered workflow.
See §8 for its post-stage acceptance boundary and the later switch.

Two pilots are measured below. **Pilot A** has 22 `outputs/v<N>/` folders.
**Pilot B** was restarted once and kept its earlier folders on disk. Sizes are
`du -sk` in KB unless they say MB; MB figures come from hashing every file
(1 MB = 1,048,576 bytes).

## 0. The rule in one paragraph

A project has one current output per kind: parts, rig, motion, direction. A
rebuild replaces that output in place. Nothing carries a number. Each output
records the content hashes it was built from. When an earlier output changes,
everything downstream of it is stale and gets rebuilt. Nothing lapses and
nothing rolls back. History is the project folder's git. Create commits by
itself after a step's data changes and the build is green. Git tracks what is
needed to rebuild: sources, specs, records, plan documents, and any output
whose rebuild is not deterministic or costs a model run. A comment records the
`[{path, sha256}]` it was made on. It does not pin those files.

### The four bars HQ set, and where each is met

| Bar | Met by |
| --- | --- |
| (a) One current output per kind; no `v<N>` folder anywhere, including `derived/review/v<N>` | §1 layout; §5 deletes every `v<N>` path pattern, the review package writer and its reader |
| (b) Going back is a project commit; git tracks what rebuilds the outputs, plus outputs that are non-deterministic or cost a model run, named with measured bytes | §4.1 tracked / untracked table with bytes; §4.4 going back |
| (c) Create commits by itself at meaningful points and never asks | §4.2 the committing writers and the commit message |
| (d) A comment binds `[{path, sha256}]`, records what it saw, stays readable after the file moves on, and pins nothing | §3.1 comment record; §3.2 how each reader is served |

---

## 1. Single current output

### 1.1 Today

- `rig-version <n>` copies the producer's parts, rig, build and idle trees
  into `outputs/v<N>/` through `retain` (`src/rig-version.ts:1497-1507`,
  copies at `:1611-1612`, `:1649`, `:1653`, `:1656-1658`). It refuses to
  overwrite a destination (`src/rig-version.ts:1486-1487`) and refuses any
  number not after every registered one (`src/rig-version.ts:1480`).
- It then copies `outputs/v<N>/out` again into `derived/review/v<N>/`
  (`src/rig-version.ts:1710`; `src/review-package.ts:80`).
- `direction write` copies the compose tree into `outputs/v<N>/compose`
  (`src/direction-compose-writer.ts:71`, `:74`; root `src/direction-compose.ts:15`)
  and the direction document into `evidence/direction/v<N>.json`
  (`src/direction.ts:35`).
- `scene write` writes `evidence/scene/s<N>.json` (`src/scene.ts:18`).
- `outputs/`, `derived/` and `scratch/` are git-ignored in every project
  (`src/init.ts:20`, `:22`), so no commit holds an `outputs/v<N>` byte.
- `docs/PROJECT.md:54` defines `outputs/v<N>/` as "one folder per version
  that was shown to anyone, frozen when shown".

### 1.2 Layout after this design

```text
project.json           the record (tracked)
inputs/                painting and references (tracked, unchanged)
specs/                 what a build is made from that an agent or person writes (tracked):
  rig/                 rig config and every file the config names
  motion/              motion spec, cuts
  direction/           scene.json, direction.json, citations, background plates
  plan/                step plan documents (#983 sets the file names)
outputs/parts/         current parts: parts.json, parts/, the recomposite stack,
                       and the model-run inputs they came from (tracked, see §4.1)
outputs/rig/           current compiled rig: producer rig dir and check/build (ignored)
outputs/motion/        current idle render: frames.json and frames (ignored)
outputs/direction/     current composed take: the compose tree (ignored)
evidence/              small files that comments and producer reports rest on (tracked)
derived/               intermediates with a derived[] entry (ignored)
```

**Choice:** sources move to `specs/` and are tracked. Reason: today the rig
config survives only as a copy per version in `evidence/v<N>/registration`
(`src/rig-version.ts:1508`, `:1565-1569`). That copy is the only reason
`evidence/v<N>/` grows by 2.8 MB per rig version in Pilot A, and 2.6–2.7 MB
of that also exists under `outputs/`.

**Choice:** `.gitignore` becomes `/outputs/*` with `!/outputs/parts/` in
place of `/outputs/` (`src/init.ts:22`). Reason: the parts tree is in the
tracked class (§4.1). A child of an ignored directory cannot be un-ignored.
On an older project, the first `record` writer makes this change under three
conditions (HQ ruling, Appendix B Q5):

- it changes only the line `/outputs/` and nothing else in the file;
- it commits `.gitignore` with its own paths, in the same commit;
- it prints one line naming the change:
  `gitignore: /outputs/ -> /outputs/* !/outputs/parts/`.

If the line `/outputs/` is not found, because the file was edited by hand, the
writer changes nothing in `.gitignore` and raises WARN `GITIGNORE_PATTERN_ABSENT`.
It then records as usual, and `outputs/parts/` stays ignored until the pattern
is fixed by hand.

### 1.3 How a rebuild replaces an output

One writer per kind records the current output:

```text
rig-create record parts     [<dir>] --from <producer out> --config <rig config>
rig-create record rig       [<dir>] --from <producer out> --config specs/rig/config.json
rig-create record motion    [<dir>] --from <render out>
rig-create record direction [<dir>] --from <compose out> --direction specs/direction/direction.json
```

**Choice:** one `record <kind>` family for the final design. It replaces the
copies made by `rig-version <n>`, `draft-rig <id>`, `review-package <n>` and
numbered `direction write <n>`.

What the writer does, in order:

1. The producer writes into a folder inside the project, normally
   `outputs/<kind>.next/`, so no copy is needed.
2. The writer reads the producer evidence for the kind and binds the input
   hashes in `built_from` along with the spec paths the operator names.
   Direction binds the producer's actual compose run and check report.
   Parts `assemble` and standalone `rig` use `rig-run/1`. The writer accepts
   `rig-run/2` or `rig-run/3` for Parts `build`. Parts `check` uses `rig-run/2`.
   Core run records use `rigc-run/1` or `rigc-run/2`. For a
   `rig-run/3` build, `record rig` adds each build input to
   `current.rig.built_from` as a project-relative file path with the exact
   SHA-256 from the producer. Create checks that the file matches the digest.
   Each input path resolves from the producer's staging `--out` directory.
   Parent segments are allowed if the resolved file is inside the project
   and outside all three trees: final output `outputs/rig/`, reserved staging
   `outputs/rig.next/` even with a custom `--from`, and the actual staging
   tree selected by `--from`. A See-through input names the actual
   `layers.json` file. If a bound input later goes
   missing or its bytes change, `check` reports `OUTPUT_STALE` for the rig
   and staleness follows its downstream dependents.
   Create reads producer evidence without re-deriving it (AGENTS.md invariant 1).
3. It validates the candidate record with the check function. A refusal leaves
   `project.json` and `outputs/<kind>/` byte-identical (invariant 6).
4. For a staged replacement, it renames `outputs/<kind>/` to a temporary
   name and renames `outputs/<kind>.next/` into place on the same filesystem.
   **Choice:** rename, never copy. Reason: copies are the cost this card
   removes (§7).
5. It writes `current.<kind>` in `project.json` and deletes the old tree
   after a successful write. In #1018, `record motion` and `record direction`
   then attempt a scoped commit (§4.2).

Record shape:

```json
"current": {
  "parts":     { "at": "…", "built_by": "agent", "built_with": { "@rig-c/parts": "…" },
                 "files": [{ "path": "outputs/parts/parts.json", "sha256": "…", "bytes": 0 }],
                 "built_from": [{ "path": "inputs/painting.png", "sha256": "…" }],
                 "run": { "path": "outputs/parts/run.json", "sha256": "…" },
                 "report": { "path": "…", "sha256": "…" } },
  "rig":       { "…": "same shape" },
  "motion":    { "…": "see motion shape below" },
  "direction": { "…": "same shape" }
}
```

For motion records carrying `rebuild`, `report` is optional, `run` is required
when `rebuild.recorded` is true and absent when false, both bindings must match
`files[]` by path and SHA-256 when present, motion runs use only `rigc-run/2`,
and a render from the pinned renderer has `{ recorded: false, note }` and
yields WARN `REBUILD_ARGS_UNRECORDED`.

`record motion` always writes `rebuild`; it writes no report. The checker also
accepts the earlier motion shape with both `run` and `report` and no `rebuild`.

`current.<kind>` replaces `versions[]` (`docs/PROJECT.md:964-1003`; template
`templates/project.json:204`) and `drafts[]` (`src/drafts.ts:499`).
**Choice:** drafts go too. Reason: a draft is a labelled per-attempt copy
under `derived/drafts/<id>/` (`docs/PROJECT.md:1700-1708`). That is 652,516 KB
in Pilot A and 180,108 KB in Pilot B (inventory F2b, F2c). Under this design
"the draft" is just the current parts and current rig.

### 1.4 What happens to the old folders

| Path today | After |
| --- | --- |
| `outputs/v<N>/out/{parts.json,parts/}`, `plate-assemble/` | `outputs/parts/` (one tree) |
| `outputs/v<N>/out/{rig,check/build}` | `outputs/rig/` |
| `outputs/v<N>/idle/` | `outputs/motion/` |
| `outputs/v<N>/compose/` | `outputs/direction/` |
| `evidence/compose-src/v<N>/scene.json` (`src/direction-compose.ts:16`) | `specs/direction/scene.json` |
| `evidence/direction/v<N>.json` (`src/direction.ts:35`) | `specs/direction/direction.json` |
| `evidence/scene/s<N>.json` (`src/scene.ts:18`) | `specs/direction/scene.json` (one current scene) |
| `evidence/v<N>/registration/` (`src/rig-version.ts:1508`) | `specs/rig/` (sources) and `outputs/rig/run.json` (receipt) |
| `derived/review/v<N>/` (`src/review-package.ts:80`) | deleted. Publication reads `outputs/parts/` and `outputs/rig/` directly |
| `review-live-v<N>.json`, `review-live-v<N>-g2.json` (`src/job-publication.ts:803`, `src/republish.ts:29`) | one `review-live.json`, rewritten per publication (§5.5) |
| `evidence/v<N>/<sha256>.png` stills (`src/feedback.ts:707-709`) | `evidence/comments/<sha256>.<ext>`, content-addressed (§3.2 row 20) |
| `evidence/draft-reuse/<sha256>.json` (`src/draft-reuse.ts:17`, `:168-195`) | not written; `--reuse` goes with drafts |
| collection `outputs/v<N>/` (`src/pins-check.ts:267`) | unchanged in #985; a separate card (Appendix B Q3) |

Old projects keep their folders, and readers stay for them (§6).

---

## 2. Dependency rebuild

### 2.1 The graph, from the code

```text
inputs/painting ─┬─> see-through layers, depth maps, figure mask      (model runs)
                 └─> outputs/parts  (assemble: parts.json, parts/, recomposite)
                        ├─> fix-ledger report   binds build.manifest_sha256   (src/fix-ledger.ts:293)
                        ├─> structure snapshot, diff report               (src/structure-snapshot.ts:31; src/diff-map.ts:151)
specs/rig/config ───────┤
                        └─> outputs/rig  (rig-run/1 binds config, src/run-record.ts:18; parts via --parts)
                               └─> outputs/motion  (render of the current rig and motion spec, §1.3)
specs/motion ──────────────────┘     │
specs/direction/scene  binds rig model and idle frames by hash  (src/direction.ts:66-74, :210-216)
                                     └─> specs/direction/direction (binds scene; src/direction.ts:216-221)
                                            └─> outputs/direction  (compose tree; src/direction-compose.ts:172-176)
```

Other edges the code shows:

- depth reports and map bindings bind the parts manifest the rig was built on
  (`src/rig-version.ts:1617-1634`);
- a mesh-delta correction chains on the previous applied receipt for the same
  source (`src/corrections.ts:784-791`);
- post interview options read the current rig and its parts
  (`src/choices.ts:189-198`).

### 2.2 How staleness is detected

- Every node keeps `built_from: [{path, sha256}]` (§1.3).
- A node is **stale** when either is true:
  - a `built_from` path is missing or now hashes differently — except the
    `current.parts` config entry when `outputs/parts/rig/parts.json` still has
    its recorded sha256 and carries `assembly_config`, where Create calls `assemblyConfigChanges` from
    `@rig-c/parts/assembly-reading` and marks parts stale only when the config
    is missing, unreadable, or `assemblyConfigChanges` returns changed field
    names (a legacy `parts.json` without `assembly_config` keeps the whole-file
    sha256 comparison);
  - any node upstream of it is stale.
- The transitive rule matters. Changing parts changes the `parts.json` hash,
  so the rig is stale directly; changing an assembly-read field in the config
  marks parts stale and, through it, the rig. Motion still names the old rig
  model hash, which is unchanged until the rig is rebuilt, so motion is stale
  only through the rig.
- Hashes come from the files' bytes (and for `current.parts`' config edge, from
  Parts' published `assembly_config` reading). Stage, date and number play no
  part.
- `check` reports a stale node as WARN `OUTPUT_STALE` (new code). The message
  names the node, the changed input (including the changed assembly config
  fields or config read error on `current.parts`) and the command that rebuilds
  it.
  **Choice:** WARN, never a refusal. Reason: #980 point 1, nothing waits on
  anything; staleness is information.
- `next` lists stale nodes upstream-first, with the recorded rebuild command
  from the run record.
- Publication shows current files as they are. A stale output is still shown,
  marked stale.

### 2.3 Changing earlier data is never a rollback

Today an edit to parts at rig-review or later lapses every approval after it.
It reopens parts-review and forces each review to be re-asked in order
(inventory C5, C7; `src/amend.ts:178-207`; `src/reopen.ts:93-104`). After #981
removes approvals and this card removes numbers, the same edit does three
things:

1. It changes `outputs/parts` and commits.
2. It makes rig, motion and direction stale.
3. Rebuilding each one changes its current output and commits.

Nothing goes back to a number, and nothing waits on a person. See the walk-through in §9.

---

## 3. Content-hash binding

### 3.1 What a comment records

A comment ingested from Review (the comment-only act, rig-c/review#1226)
becomes one `comments[]` entry:

```json
{ "id": "…", "at": "…", "by": "…", "words": "…", "pins": [ … ],
  "saw": [{ "path": "outputs/rig/check/build/skeleton.model.json", "sha256": "…" }],
  "record": { "sha256": "<project.json bytes the publication carried>", "commit": "<project commit, or null>" },
  "attachments": [{ "path": "evidence/comments/<sha256>.png", "sha256": "…" }],
  "carriers": [ … ] }
```

- `saw` is the list of files that were on screen, as Review declares them
  (#1226: "bound by content hash to the files that were on screen").
- `record.commit` is the commit the publication was made from (§4.2: the
  publish writer commits first). It is `null` when that commit was not made:
  no work tree (`PROJECT_NOT_IN_GIT`) or a failed commit
  (`PROJECT_COMMIT_FAILED`). The comment is still recorded, bound by `saw` and
  `record.sha256`.
- `carriers` is optional: mesh edits, chest landmarks and similar payloads that
  travel with a comment (rig-c/review#1225 step 2). There is no verdict field.
- The exact shape is one contract document agreed with the review tower:
  `saw[{path, sha256}]`, record hash, commit, `comments[]`, optional
  `carriers[]`, no verdict. Code waits on HQ's sign (Appendix B Q2).
- A comment **pins nothing**. There is no copy, no refusal when a `saw` file
  changes, and no lapse.
- Its status is computed when it is read:
  - **current** when every `saw` hash equals the file now at that path;
  - **earlier** otherwise.
- `words`, `pins` and `attachments` are in the record, so the comment reads the
  same after every file moves on (bar d).

**Choice:** keep the project commit beside the hashes. Reason: Review's own
snapshot lives in the OS temp folder (`src/job-outbox.ts:16`, `:120-122`). In
Pilot A, all of its files were already gone (inventory F2d), so a commit is the
only durable way back to tracked bytes.

### 3.2 Every reader that needs "the bytes the owner saw" or "the previous state"

Source column:

- **current**: read the current file.
- **git**: `git cat-file` the blob at `record.commit:<path>` or the commit
  named in the record, after checking its sha256.
- **rebuild**: check out the sources from that commit into a work tree and run
  the recorded command.
- **record**: the data is in `project.json`.
- **retained**: a kept file, used only where nothing else works.

| # | Reader today | file:line | Needs | New source | Why |
| --- | --- | --- | --- | --- | --- |
| 1 | Registration validator: every frozen output re-hashed, tree equal to inventory | `src/rig-version.ts:838-847`, called from `src/check.ts:1067` | `outputs/v<N>/` of every version | **current** `current.<kind>.files` against `outputs/<kind>/` | One output per kind; earlier ones are history, not a check subject |
| 2 | Depth and part readers | `src/rig-version.ts:548-552`, `:1863` | `outputs/v<N>/out/parts.json` | **current** `outputs/parts/parts.json` | Same file, one place |
| 3 | Direction idle bytes | `src/direction.ts:66-74`, `:215` | `outputs/v<R>/idle/` of the post's rig | **current** `outputs/motion/`; hash mismatch = `OUTPUT_STALE` | The scene binds frames by hash; a newer render is staleness, not an error |
| 4 | Compose inventory | `src/direction-compose.ts:172-176`; `src/direction.ts:237` | `outputs/v<N>/compose` | **current** `outputs/direction/` | Same |
| 5 | Post publication build files | `src/job-publication.ts:685-702` | `outputs/v<N>/compose/check/build/` | **current** | Publication shows current work (#982) |
| 6 | Plan picture | `src/job-publication.ts:320-327` | `outputs/v<N>/compose/check/idle_frames/idle/f0000.png` | **current** | Same |
| 7 | Correction and draft-verdict bindings | `src/corrections.ts:646-662`, `:840`; `src/rig-draft-verdict.ts:63-69` | `versions[].outputs` hashes, `on {kind, n}` | **record** `on: [{path, sha256}]` | Already hash-only; drop the number |
| 8 | Mesh-delta chain | `src/corrections.ts:784-791` | previous applied receipt per version or draft id | **record**, keyed by the `outputs/parts/parts.json` sha256 it applied to | The chain is already in the record; only the key had a number |
| 9 | Unregistered build discovery | `src/next.ts:366-380`, `:1588-1593` | `outputs/v<N>/` on disk without a record | removed; `next` reads `OUTPUT_STALE` and `outputs/<kind>.next/` | No numbers to discover |
| 10 | Review package check | `src/review-package.ts:223-278`, from `src/check.ts:1066` | `derived/review/v<N>/` | deleted for new records; kept for `versions[]` (§6) | The package is a second copy of `outputs/v<N>/out` (inventory F1a row 3) |
| 11 | Rig publication model and parts | `src/job-publication.ts:781`, `:910-925`; `src/job-host.ts:607` | `derived/review/v<N>/` | **current** `outputs/rig/`, `outputs/parts/` | Same bytes without the copy |
| 12 | Verdict binding on ingest | `src/review-act.ts:657-697` | each package file re-hashed; stale act refused | comment `saw[]` (§3.1); no refusal | Verdicts leave with #982; a comment on older bytes is "earlier", not stale |
| 13 | Act record identity | `src/review-act.ts:211-232` (`matchesActProjectSource`) | `project.json` bytes the act names | **current** if equal, else **git** by sha256 | Per-writer commits (§4.2) put every published `project.json` in history |
| 14 | `handoff` and rig acceptance | `docs/CHECKS.md:883`; `src/review.ts:366-397` | package of the selected version | deleted | No accepted version to name |
| 15 | Registration inputs replay | `src/rig-version.ts:725-760` | `evidence/v<N>/registration/` | **current** `specs/rig/`; earlier from **git** | Sources are tracked (§4.1) |
| 16 | Direction and scene documents | `src/direction.ts:229-235`; `src/job-publication.ts:786`; `src/republish.ts:49` | `evidence/direction/v<N>.json`, `evidence/scene/s<N>.json` | **current** `specs/direction/`; earlier from **git** | Same |
| 17 | Draft reuse across a restart | `src/draft-reuse.ts:41-54`, `:168-195` | earlier `project.json` by sha256 | **git** (already its first route); the retained copy is not written | Its stated reason, check's closure "without git" (`:168`), was for Review's snapshot; comments no longer need a closure check |
| 18 | `restart` | `src/restart.ts:35-54` | earlier `project.json` | **git**, unchanged | Already git-only |
| 19 | Previous-draft view in Review | `src/job-publication.ts:1131-1159` (`previousPartsApproval`, `src/structure.ts:71-86`) | recomposite of the last approved draft | **git**: the recomposite at the commit before the last `record parts` | The recomposite sits in `outputs/parts/`, which is tracked; "previous" means the previous commit, not the previous approval |
| 20 | Review act sidecars and historical still attachments | Verdict ingestion in `src/feedback.ts` and the chest reader in `src/review-bust.ts` | Act JSON under `evidence/v<N>/` and `evidence/drafts/<id>/`, with PNGs in historical records | **retained** `evidence/comments/<sha256>.<ext>` | New verdict ingestion retains the act JSON only. Historical still attachments preserve the original Review bytes. |
| 21 | Parts act receipts and Review reads | `src/parts-review.ts:132`; `src/review-read.ts:158-160` | `evidence/review-acts/<hash>.json`, `evidence/review-reads/<sha256>.json` | **retained** for old records; not written for new | Verdict receipts leave with #982 |
| 22 | Fix-ledger regression against the previous draft | `src/fix-ledger.ts:263-317` | predecessor draft's ledger report rows | **record**: `current.parts.ledger` keeps the report binding and the passed-row set it replaced | The regression gate is correctness and must not depend on git being present |
| 23 | Feedback answered by a later version | `src/feedback.ts:181`; `src/direction-writers.ts:41` | earlier version's verdict index | deleted | Comment threads carry this (#982) |
| 24 | Applied review origin | `src/applied-review.ts:20-48` | earlier version of the same kind | deleted for new records; kept for old | Same |
| 25 | Checkpoint before/after pair | `src/checkpoint-evidence.ts:34-56` | producer-supplied pair | producer bytes as today, or **git** for a tracked "before" | rig-c/review#1225 step 2 makes it an ordinary comparison |
| 26 | Config provenance readers over `versions[]` | `src/provenance.ts:286-290`; `src/cg-gates.ts:146`; `src/setup-painting.ts:18-29`; `src/assemble-answers.ts:43-47`; `src/figure-mask.ts:80-98` | each version's config | **current** `current.rig` (one entry); `versions[]` kept for old | Same rules, one subject |
| 27 | Post option context | `src/choices.ts:189-198` | latest live rig version and its parts | **current** `current.rig`, `current.parts` | No "latest accepted" to find |
| 28 | Collection pins | `src/pins-check.ts:83-135`, `:262-267` | member and collection `outputs/v<N>/` bytes | unchanged in #985: the reader and `--member name=version` are kept; a separate card (Appendix B Q3) | HQ ruling: collections are out of #985 |
| 29 | Review's retained snapshot | `@rig-c/review` `job-source.ts:1273-1300` (inventory F1b row 1) | its own copy | Review side, unchanged by this card | Comments no longer depend on it |

Every row in inventory F1c and every "previous" reader found in `src/` is listed
above. Appendix A lists every source file that names a version and where it is
handled.

---

## 4. Local git

### 4.1 What git tracks

Rule: git tracks what a rebuild needs, plus every output whose rebuild is not
deterministic or costs a model run. It does not track outputs that a recorded,
deterministic command rebuilds from tracked files.

**Tracked: sources, specs, records, plans.** `project.json`, `inputs/`,
`specs/`, `evidence/`. These are small or already tracked.

**Tracked outputs: rebuild costs a model run or is not reproducible.**

| Output | Why it is in this class | Measured bytes |
| --- | --- | --- |
| Parts images and manifest (`outputs/parts/parts.json`, `parts/`) | assembled from model-run layers and touched up by hand or with an image model; no recorded command reproduces a retouch | Pilot A current: 36 + 1,336 KB; Pilot B current: 32 + 3,164 KB (clone `du -sk`) |
| See-through layer splits | model run (GPU) | Pilot B: six runs, 9,448–16,832 KB each, 74,000 KB total (inventory F2c; clone `du -sk`); Pilot A `derived/layers` 56,536 KB |
| Depth maps | model run (`derived/maps` holds a depth-model `inference/` folder) | Pilot A: 44,180 KB |
| Figure mask | model run (the record names the matte model, `src/figure-mask.ts:197`) | Pilot A: `evidence/figure-mask` 3,676 KB, `figure-mask-v2` 15,804 KB (already tracked) |
| Comment attachments (Review stills, chest acts) | made by a person in Review; no other copy | not separately measured (**unknown**) |

Model-run intermediates move from ignored `derived/` into
`outputs/parts/sources/`, where git tracks them. HQ ruled them tracked (Appendix B
Q6). The PR that moves them records what one re-run adds to `.git`, measured
after `git gc`.

**Untracked outputs: rebuilt from tracked files by the recorded command.**

| Output | Measured bytes (current set) | Determinism |
| --- | --- | --- |
| `outputs/rig/` (producer rig dir + `check/build`) | Pilot A: 2,880 + 6,224 KB; Pilot B: 5,096 + 9,204 KB | **Deterministic, measured** (#985 slice 1). Two rebuilds from one commit match, except `run.json` `started_at`/`finished_at`. A rebuild also matches the recorded bytes except `run.json`. Pilot A's recorded `check/build` differs in `skeleton.json` `/skeleton/images` and the model's `/images/*/page` only because it was built at a different folder layout. The check's arguments (`--requirements`, `--source`, `--seam-pairs`) change `check.json`, not the build bytes |
| `outputs/motion/` (idle render) | Pilot A: 74,948 KB; Pilot B: 2,324 KB | **Deterministic, measured.** Run 1 = run 2 = recorded, every file (99 and 43 files) |
| `outputs/direction/` (compose tree) | Pilot A: 109,052 KB (one post) | **Deterministic in its product, measured.** 145 of 147 files match run to run and against the recorded tree. The other two are `check/build/run.json` (times) and `check/check.json` reason text that carries the absolute `--out` path. The rebuild needs the character build root, which today sits in ignored `derived/rig/…`; it rebuilds from tracked files once `outputs/rig/` holds that root |

Measured in #985 slice 1: each output built twice on clones from one commit,
with no model or GPU run. Nothing moves to the tracked class. The measured run
records omitted the check and idle render arguments. When a producer records
the arguments, `rebuild` binds them. A render from the pinned renderer yields
the motion warning in §1.3.

**"Same output" ignores run records.** A run record is a file named `run.json`
or any `*-run.json` (the producers' own rule; for example core's
`render-run.json` and Parts' `check-run.json` and `build-run.json`). It is
provenance, not product: its `started_at`/`finished_at`, `package.version` and
`config.path` change on a rebuild whose bytes are otherwise identical. So:
- a hash over an output set excludes every run record (`isRunRecordFile`,
  `src/current.ts`);
- no writer puts a run record, or the compose `check/check.json` (absolute
  paths in its reasons), into `built_from`. A node names the product files it
  reads (for example idle names `outputs/rig/check/build/skeleton.model.json`).

Without this rule, a byte-identical rig rebuild would mark motion and direction
`OUTPUT_STALE` through a timestamp. Excluding by file name is one rule; a
per-spec field list would have to follow every producer release, and a missed
field would mark every rebuild stale.

### 4.2 Create commits by itself

At the design baseline, Create committed at `init` (`src/init.ts:214-227`) and in collections
(`src/collection.ts:101-106`, `:169-170`). Every other commit in the pilots was
made by agents: 120–143 commits per large pilot (inventory F2f).

**Choice:** a writer commits after the step's data changes and the step is
green. Green means three things:

- the writer's own validation passed (invariant 6);
- for a `record` writer, the producer's bound check report passes;
- check raises no new refusal.

The writer never asks. Reason: the HQ bar, and that the comment and act bindings (§3.2
rows 13, 19) need the published bytes to be in history.

Commit scopes today:

| Writer | Commits |
| --- | --- |
| `init`, `init --collection`, `init --member` | the initial project or collection files (or the new member's files and `collection.json`) |
| `record parts`, `record rig`, `record motion`, `record direction` | `project.json`, eligible verified output paths and removals from the prior recorded output, `.gitignore` when first rewritten |
| `record --adopt` | `project.json` |
| `scene write`, `direction write` | each writer's generated spec (`specs/direction/scene.json` or `specs/direction/direction.json`) |
| `job open` | `project.json` when the live job binding changes |
| `job open --current` | its generated manifest when HEAD already contains the exact record and trackable inputs |
| `packages upgrade` | `project.json`, `package.json` and `bun.lock` |
| `plan propose`, `interview-options` | `project.json` and explicitly registered, trackable files |
| `plan feedback` / `add` / `revise`, `comment --from-review` / `--close`, `input add`, `ledger add` / `retire`, `derived add`, `correction`, `owner-language set` | working-tree writes |

Converted record writers check their shared paths before mutation. Review any
pre-existing edits to `project.json`, `package.json` and `bun.lock` and run
`rig-create history baseline <dir> --by <operator>` to commit the pending record
as a baseline with unverified attribution. The same route can recover a record
saved just before Git failed or the process stopped, including trackable
option documents, step plans and their inputs, and current output files
whose bytes match their recorded hashes. Other staged paths stay staged.
If Git cannot inspect the project, `next` still offers workflow moves and Review
can serve its hash-bound view without a commit pointer.

Commit rules for the final design:

- Pathspec only: `git commit --only -- <paths>`. It never uses `git add -A` or
  touches other staged work. The pattern is `src/collection.ts:101-106`.
- A work tree is required to create a commit. Current output and spec writers
  warn with `PROJECT_NOT_IN_GIT` when Git is unavailable.
- A collection member commits in its collection's repository
  (`docs/PROJECT.md:36-38`).
- A failed commit keeps the written record. It raises WARN
  `PROJECT_COMMIT_FAILED` with a recovery command.
- **A failed Git commit never blocks looking at the work.** `job open --current`
  checks for an exact committed closure before attempting the manifest commit. If
  either Git step fails, it raises WARN
  `PROJECT_COMMIT_FAILED` and publishes anyway. If there is no work tree, it
  raises WARN `PROJECT_NOT_IN_GIT` and publishes anyway. Either way the
  publication carries no commit, and every comment made on it records
  `record.commit: null` (§3.1). Reason: #980 point 2. Review is for looking,
  and a git failure is not a reason to stop a person from looking.

Commit message:

```text
rig: rebuild from parts 3f2a91c0                       ← <kind>: <what changed>, ≤ 72 chars
                                                     
writer: rig-create record rig --from outputs/rig.next --config specs/rig/config.json
changed: outputs/rig/check/build/skeleton.model.json 9c1e…  (one line per tracked path, sha256 prefix)
stale: motion, direction                               ← what this change made stale, or "none"
create: @rig-c/create <version>
```

Create commits with the configured git identity only, or
`rig-create@localhost` when none is configured (`src/init.ts:25`). It adds no
trailer and has no flag to pass one through (HQ ruling, Appendix B Q4).

### 4.3 Growth

**Measured:**

- Pilot A history holds 107 `project.json` blobs: 108.1 MB uncompressed,
  32.8 MB on disk.
- Pilot B holds 95 blobs: 99.0 MB uncompressed, 1.9 MB on disk.
- Pilot A had 34.7 MiB of loose objects. Pilot B was packed.
- The working `project.json` is 2,736,228 bytes in A and 1,058,626 bytes in B.

(inventory F2b, F2c.)

**Effects of this design:**

- Commits per writer raise the commit count. How much is **unknown**.
- The record shrinks: `versions[]`, `drafts[]`, signoffs and per-version
  receipts leave (§5). How much is **unknown**.
- Packing decides most of the on-disk cost: B's packed history is 52× smaller
  than its uncompressed size.

**Choice:** after each commit, the writer runs `git gc --auto`. Reason: git
packs when its own threshold is reached, so the cost stays bounded with no
schedule of our own.

One measured warning sign: another pilot's agent tracked an image folder of
2,278 blobs, which made its `.git` 1,061.9 MB on disk (inventory F2e). This is
why render outputs stay untracked unless §4.1's double-build check says
otherwise.

### 4.4 Going back

Going back is a commit:

1. Restore the step data from an earlier commit: `specs/` and `outputs/parts/`.
   `project.json` is **not** restored, so comments, inputs and the ledger
   recorded since then are kept.
2. `record <kind> --from outputs/<kind>` rebinds the restored tree in place.
   When `--from` is the current folder, the writer swaps nothing and only
   re-hashes it. Then `record` runs again on whatever is now stale.
3. Create commits the result.

History only grows. Nothing is renumbered, and no comment loses its meaning.

**The agent never composes git by hand for this.** A read-only reader prints
the line. **Choice:** a reader, `rig-create history [<dir>] [--json]`, not a
writer. Reason: it only runs `git log` over the commits Create made and writes
nothing. It lists one entry per Create commit that changed step data, newest
first:

```text
7d40c2e1  2026-11-25T09:12:04Z  parts: add eyelid_l, eyelid_r
  back: git -C '<dir>' checkout 7d40c2e1 -- specs outputs/parts && rig-create next '<dir>'
```

- The subject line is the commit subject from §4.2.
- The `back:` line is the exact command. It restores the tracked step data of
  that commit and then runs `next`.
- `next` names `record parts --from outputs/parts`, the rebind in place, and
  then the stale rebuilds upstream-first (§2.2).
- `next` prints the same `back:` line when the owner's request names a step.
  When no commit holds step data, or there is no work tree, `history` prints
  nothing and raises WARN `PROJECT_NOT_IN_GIT`.

### 4.5 Rejected alternatives

| Alternative | Rejected because |
| --- | --- |
| Keep `v<N>` folders but deduplicate them through a content-addressed store or hard links | Version identity stays, and that is the mishap the owner named: an edit during animation reads as a rollback against a version. It also runs a second history system beside git |
| Track every output, renders included | Renders are 74,948 KB (idle) and 109,052 KB (compose) per rebuild in Pilot A. The tracked-images pilot reached 1,061.9 MB of history |
| Leave commits to the agent, as today | Fails bar (c). Comments and acts then depend on agent discipline to keep the bytes they name |
| Retain a copy of every published file (today's Review package approach) | It is the copy this card removes: 172,632 KB of `derived/review` in Pilot A, and Review's own snapshot vanished anyway |

---

## 5. What goes away

This section describes the transition to the final design. "Old" means the
reader is kept for records that still hold `versions[]` (§6).

### 5.1 Record fields

| Field | Where | After |
| --- | --- | --- |
| `versions[]` and every member: `n`, `kind`, `rig_version`, `outputs`, `evidence`, `answers_feedback`, `review_package`, `registration`, `publication_generations`, `verdicts`, `review_origin`, `changed`, `original_n`, `config_lost`, `outputs_lost` | `docs/PROJECT.md:964-1003`; `templates/project.json:204` | `current.<kind>`; old reader |
| `registration.skipped` | `src/rig-version.ts:182-186`, `:1489-1495` | deleted |
| `drafts[]` | `src/drafts.ts:499`; `docs/PROJECT.md:1680-1708` | `current.parts`, `current.rig`; old reader |
| signature target `{version, verdict: "versions[i].verdicts[j]"}` | `src/review-act.ts:1087-1089`; `src/signoff-target.ts:116` | deleted with signoffs (#981); old reader |
| direction@3 `rig.version`, `rig.acceptance` | `src/direction-compose.ts:20-24` | `rig: { model: {path, sha256} }` |
| direction@2 `rig.version` | `src/direction.ts:216-224` | same |
| corrections `on` / `outcome` `{kind, n}` | `src/corrections.ts:840` | `[{path, sha256}]` |
| fix-ledger note ref `versions[v<n>].verdicts[<i>]` | `src/fix-ledger.ts:31`, `:53`, `:413`, `:446` | `comments[<id>]` |
| `restarts[]` | `src/restart.ts:212` | old reader; writer fate is #981/#986 |

### 5.2 Commands and arguments

| Command | Where | After |
| --- | --- | --- |
| `rig-version <n>` and `--answers <v>:<i>`, `--preflight` | `src/cli.ts:118`; `src/rig-version.ts:1476-1730`; `src/version-declarations.ts:44-84` | Refuses `NUMBERED_WRITER_REMOVED` (exit 2); use `record rig --from <producer out> --config <rig config>` and `record motion --from <render out>` (`record` has no preflight flag). |
| `review-package <n>` | `src/cli.ts:116`; `src/review-package.ts:66-71` | Refuses `NUMBERED_WRITER_REMOVED` (exit 2); use `record rig --from <producer out> --config <rig config>`. |
| `republish <rig>` | `src/cli.ts:55`; `src/republish.ts:25-70` | deleted (`UNKNOWN_COMMAND`, exit 2); `job open --current` publishes current |
| `job open --rig <n>`, `--draft <id>` | `src/cli.ts:56`, `:338-341` | `job open` (#982 sets what it shows) |
| `handoff [--rig <n>]` | `src/cli.ts:85`; `src/review.ts` | Still present; reads numbered `versions[]` (exits 0 on an accepted live numbered rig version; refuses `RIG_VERSION_UNACCEPTED`, exit 1, when none exists). |
| `review <version> …`, `parts-review` | `src/cli.ts:87-89` | Refuses `NUMBERED_WRITER_REMOVED` (exit 2); comment ingest (#982). |
| `scene write --rig <R>` | `src/scene-writers.ts` | Refuses `NUMBERED_WRITER_REMOVED` (exit 2). `scene write . --background <path> --citations-file <file>` and `scene write . --compose-scene specs/direction/compose-scene.json` write `specs/direction/scene.json` binding `current.rig` and `current.motion`. |
| `direction write <N> --rig <r>`, `direction patch` | `src/direction-writers.ts` | Refuses `NUMBERED_WRITER_REMOVED` (exit 2). `direction write . --file specs/direction/intent.json` writes `specs/direction/direction.json`, followed by compose and `record direction --from <compose out> --direction specs/direction/direction.json`. |
| `draft-rig <id>`, `--reuse`, `--reuse-record` | `src/cli.ts:108-111`; `src/drafts.ts:359-370` | Refuses `NUMBERED_WRITER_REMOVED` (exit 2); use `record parts` / `record rig`; reuse deleted. |
| `signoff … --version`, `--draft` | `src/signoff.ts:91`, `:203` | Refuses `NUMBERED_WRITER_REMOVED` (exit 2); stage-review `signoff` without `current` also refuses `NUMBERED_WRITER_REMOVED` (#981). |
| `version config-lost <n>`, `version outputs-lost <n>` | `src/cli.ts:122`, `:124`; `src/config-lost.ts` | writers deleted (`UNKNOWN_COMMAND`, exit 2); old readers kept |
| `collection pin --member name=version` | `src/cli.ts:76`; `src/pins-check.ts:262-267` | kept in #985; a separate card (Appendix B Q3) |

### 5.3 CHECKS.md codes

Line numbers are `docs/CHECKS.md` rows.

| Codes | Rows | After |
| --- | --- | --- |
| `VERSION_MALFORMED`, `RIG_VERSION_AT_INVALID` | 536, 551 | old reader; new `CURRENT_MALFORMED` |
| `RIG_VERSION_UNACCEPTED`, `POST_ON_UNACCEPTED_RIG`, `POST_ON_SUPERSEDED_RIG` | 539-541, 605, 609-610, 795 | deleted (no acceptance, no supersession) |
| `FEEDBACK_UNANSWERED`, `FEEDBACK_OPEN` | 553, 659 | deleted; comment threads (#982) |
| `PRE_INTERVIEW_*` (13 codes) | 554-565, 607-608, 653 | old reader only |
| `HANDOFF_RIG_INVALID`, `HANDOFF_TOO_MANY_ARGUMENTS` | 602-603 | deleted |
| `REVIEW_VERSION_INVALID`, `REVIEW_VERSION_UNKNOWN` | 631, 634 | deleted |
| `REVIEW_PACKAGE_*` (17 codes) | 861-865, 882-902 | writer codes deleted; check codes old reader only |
| `APPLIED_REVIEW_*` (6 codes) | 962-967 | old reader only |
| `DRAFT_RIG_*` (8 codes), `DRAFT_REUSE_*` (3 codes) | 1057-1078, 1086-1088 | `RECORD_*` on `record parts/rig`; old reader |
| `STRUCTURE_DELTA_MISMATCH`, `STRUCTURE_DELTA_REVIEW` | 1075-1076 | deleted with approvals (#981) |
| `DIRECTION_RIG_STALE`, `DIRECTION_VERSION` | 1222, 1226 | `OUTPUT_STALE` (WARN); `DIRECTION_VERSION` deleted |
| `SIGNOFF_TARGET_*` | 1291-1294 | deleted (#981); old reader |
| `RIG_REGISTRATION_*`, `RIG_VERSION_ALREADY_REGISTERED`, `RIG_BUILD_BEFORE_REOPEN`, `RIG_IDLE_MANIFEST_MISSING` | 1438-1456 | the integrity codes become `RECORD_*` on the record writer; the "never overwrite" codes (`RIG_REGISTRATION_EXISTS`, `RIG_VERSION_ALREADY_REGISTERED`, the `n` ordering in `RIG_REGISTRATION_INVALID`) are deleted |
| `DIRECTION_IDLE_VERSION`, `DIRECTION_IDLE_UNBOUND`, `DIRECTION_IDLE_HASH` | 1598-1600 | `_VERSION` deleted; `_HASH`/`_UNBOUND` become `OUTPUT_STALE` |
| `CONFIG_LOST_*`, `OUTPUTS_LOST_*` (12 codes) | 1624-1635 | writer codes deleted; old reader |
| `PUBLICATION_GENERATION_DUPLICATE`, `_INVALID` | 1801-1802 | deleted with `republish` |
| `RIG_DEPTH_BINDING_MISSING` and kin | 1958-1960 | kept; path `current.rig.depth` |
| `DIRECTION_COMPOSE_INVENTORY` | 2014 | kept, against `outputs/direction/` |
| `JOB_PUBLICATION_STALE`, `REVIEW_ACT_SOURCE_STALE`, `REVIEW_ACT_VERSION_UNVERIFIED`, `PREVIOUS_DRAFT_UNAVAILABLE` | 51, 99, 107, 69 | act-side codes follow #982; `PREVIOUS_DRAFT_UNAVAILABLE` becomes "no earlier parts commit" |
| collection `PIN_STALE`, `OUTPUT_CHANGED` | 696, 714 | kept unchanged in #985 (Appendix B Q3) |
| New: `OUTPUT_STALE` (WARN), `CURRENT_MALFORMED`, `RECORD_*`, `PROJECT_NOT_IN_GIT` (WARN), `PROJECT_COMMIT_FAILED` (WARN), `GITIGNORE_PATTERN_ABSENT` (WARN, §1.2), `VERSION_AFTER_CURRENT` (§6) | — | rows added in #985 |

`PACKAGE_UPGRADE_*` (1921-1929) and `RELEASE_TAG_VERSION_MISMATCH` (1943) are
about package versions, not records. They are unchanged.

### 5.4 `*_SINCE` rules that assume a version

These are dated by a version's `at`, or they bind version artifacts. They are
all listed in the contract-date sentence at `docs/CHECKS.md:832`.

| Constant | Where | After |
| --- | --- | --- |
| `RIG_PARTS_APPROVAL_SINCE` | `src/rig-version.ts:653` | deleted (#981) |
| `RUN_RECORD_SINCE` | `src/run-record.ts:11` | kept for old records. See §1.3 for the current run bindings. |
| `RIG_CHECK_REPORT_SINCE` | `src/rig-check-report.ts:5` | kept for old records. `record rig` requires the report. |
| `PART_FILE_IDENTITY_SINCE`, `BUILD_IDENTITY_SINCE` | `src/review-package.ts:23-24` | old reader only |
| `CONFIG_INPUTS_SINCE` | `src/config-inputs.ts:10` | old reader; `record rig` requires every config-named input under `specs/rig/` |
| `SIGNOFF_TARGET_SINCE` | `src/signoff-target.ts:17` | deleted (#981) |
| `DIRECTION_SCENE_SINCE` | `src/direction.ts:23` | old reader; new directions always bind a scene |
| `DIRECTION_PATCH_SINCE` | `src/direction.ts:25` | old reader |
| `DESCRIBED_DIRECTION_SINCE` | `src/corrections.ts:22` | old reader |
| `CG_BEHIND_SEAMS_SINCE` | `docs/CHECKS.md:372` (dated by `versions[].at`) | dated by `current.rig.at` |
| New `CURRENT_DATA_SINCE` | — | §6 |

### 5.5 `next` output and Review publication subjects

In #1018, `next` keeps the numbered moves and their existing prerequisites for
`direction-review`. In `post` and `direction-review`, it offers
`record motion` for a current rig with staged frames, and `record direction`
for a current rig with a numbered post, the unnumbered direction spec and
staged compose receipts. The exclusive switch to current moves is §8.6.

| Item | Where | After |
| --- | --- | --- |
| `rig-version ${n}` commands | `src/next.ts:403`, `:428`, `:1589`, `:1657`, `:1695` | `record rig` |
| `--rig ${n}` selectors | `src/next.ts:551-559` | `job open` |
| `scene write --rig ${rigN}` | `src/next.ts:743` | Retained in #1018. |
| `direction write ${nextPostN}` | `src/next.ts:2351`, `:2361` | Retained in #1018. |
| `review ${postN}` (retired) | `src/next.ts` | comment ingest (#982) |
| Stale rebuilds | — | new: upstream-first `OUTPUT_STALE` moves |
| Subject `{kind:'rig', version}` / `{kind:'post', version, rigVersion}` | `src/job-publication.ts:706-712` | `{kind:'current', record: sha256}` (#982 contract) |
| Manifest `id: create-v<N>`, `revision: v<N>`, title `rig v<N>` | `src/job-publication.ts:796-800` | `id: create`, `revision: <record sha256 prefix>` |
| `review-live-v<N>-g2.json` | `src/republish.ts:29`, `:63` | deleted |
| Version lookups for publication | `src/job-outbox.ts:266-268`; `src/job-writer.ts:73`, `:163`; `src/job-acts.ts:501-503`; `src/job-advance.ts:19-29`; `src/signable.ts:61`; `src/rig-signoff.ts:40-43`; `src/record-direction-target.ts:10-24`; `src/owner-chat.ts:64` | read `current`; old reader |

---

## 6. Old projects (step 5)

A project with `versions[]` and `outputs/v<N>/` keeps opening and building.

- **Readers stay** (§3.2 "old" rows):
  - the registration validator;
  - the review-package check;
  - the direction and compose readers;
  - act ingest of historical acts;
  - the pre-interview and lost-output readers.
- **Writers go.** Nothing appends to `versions[]`, `drafts[]` or
  `publication_generations`. Nothing writes under any `v<N>` path.
- **First write after the change.** An old project has no `current`. `next`
  offers `record <kind> --adopt`, which writes `current.<kind>` from the
  latest live version's `outputs` bindings, in place. It copies and moves
  nothing, so the old validator still finds every file.
  **Choice:** adopt in place. Reason: renaming `outputs/v<N>/` would raise
  `RIG_REGISTRATION_FILE_INVALID` for the version that owns it
  (`src/rig-version.ts:838-847`). The next rebuild writes `outputs/<kind>/`.
- **Once `current` exists,** `versions[]` is history. These findings become
  WARN, so the old folders may be deleted: `RIG_REGISTRATION_FILE_INVALID`,
  `REVIEW_PACKAGE_CHANGED`, `DIRECTION_IDLE_HASH`, `DIRECTION_COMPOSE_INVENTORY`.
- **`CURRENT_DATA_SINCE` and `VERSION_AFTER_CURRENT` apply only to a project
  that already has `current`.**
  - `CURRENT_DATA_SINCE` is the #985 landing day at 00:00Z.
  - On a project with `current`, a `versions[]` or `drafts[]` entry dated from
    it refuses as `VERSION_AFTER_CURRENT`. Earlier entries are untouched.
  - A project without `current` never meets this refusal, whatever its dates.
  - Before that PR lands, `check` runs on every live pilot (AGENTS.md
    invariant 3).

  Why a project without `current` cannot reach it:

  1. **The only call site.** The check sits beside the version readers in
     `checkProject`, after
     `refusals.push(...rigRegistrationFindings(dir, project, warnings, collection))`
     (`src/check.ts:1067`).
  2. **The guard.** The function's first line is
     `if (!isObject(project.current)) return [];`. That is the guard. Nothing
     below it runs on a record without `current`, so no date comparison
     happens.
  3. **No old-process writer writes `current`.** Those writers append only to
     `versions[]` and `drafts[]`:
     - `rig-version`: `src/rig-version.ts:1703`;
     - `direction write`: `src/direction-writers.ts:117`;
     - `draft-rig`: `src/drafts.ts:499`.

     Only `record <kind>` and `record <kind> --adopt` write `current` (§1.3,
     this section).
  4. **No call is implicit.** `next` offers `--adopt` as a move. It never runs
     it, and no other writer calls `record`.
  5. **A finishing run never gets the code.** The run finishing under the old
     process stays on its pinned release (#980 "Out of scope"; rig-c/review#1226
     "Constraints"). That release has no `record` command and no
     `VERSION_AFTER_CURRENT` code.

  A test in #985 pins this. A clone of a `versions[]`-only record, with entries
  dated after `CURRENT_DATA_SINCE`, checks with no `VERSION_AFTER_CURRENT`.
- A run already at its finishing stage under the old process completes as it
  is, and gets no release from this card (#980 "Out of scope").

---

## 7. Disk

These are measured duplicates and copies that this design stops writing (inventory F2).

| Pilot | Copy | Measured | After |
| --- | --- | --- | --- |
| A | `outputs/` in 22 `v<N>` folders | 1,195,236 KB (8 registered 542,988; 14 unregistered 652,248) | one current set. The latest rig folder is 88,296 KB and the latest post 109,052 KB, so `outputs/` holds 197,348 KB; 997,888 KB is no longer written |
| A | bytes in `outputs/` identical to another `v<N>` folder | 300.7 MB of 1,161.1 MB (25.9 %) | 0 (one folder per kind) |
| A | `derived/review/` packages (9) | 172,632 KB | 0 |
| A | `evidence/v<N>/registration` duplicating `outputs/` | 2.6–2.7 MB of 2.8 MB per registered rig version, 7 rig versions | 0 (`specs/rig/` once, in git) |
| A | `derived/drafts/` (10 drafts) | 652,516 KB | no longer recorded or required; agent folders, so not counted as saved |
| B | `outputs/` (12 folders, 1 registered) | 360,448 KB, of which 104.9 MB repeats an earlier folder | current set 23,476 KB; 336,972 KB no longer written |
| B | `derived/review/` | 103,880 KB | 0 |
| B | `evidence/draft-reuse` | 2,032 KB | 0 |
| B | Review snapshots outside the project | 476,964 KB | unchanged by this card (Review side) |

**Added to git** by the tracked class in §4.1 (measured above):

- parts at 1,372–3,196 KB per current set, counted once per changed file;
- model-run layers and maps, 44,180–74,000 KB per pilot, that are ignored today.

The net per pilot is **unknown** until two numbers are measured: the §4.1
determinism check, which settles whether the rig build, idle render and compose
tree are tracked, and the `.git` growth after `gc` for one model re-run
(Appendix B Q6).

---

## 8. Order of implementation for #985

Delete first. After each slice, a full run on a production-shaped clone still
goes end to end, an old-process project still opens and builds, and the PR
reports disk before and after (#980 "Verification").

1. **Measure determinism.** Build rig, idle and compose twice from one commit
   on a clone and compare hashes. This settles the §4.1 class. No code change.
2. **Delete `republish` and generation-2 manifests** (`src/republish.ts`,
   `src/cli.ts:55`) and the `version config-lost` / `outputs-lost` writers
   (`src/config-lost.ts`). Nothing in a full run depends on them.
3. **Delete the review package.** Remove the copy in `rig-version`
   (`src/rig-version.ts:1710`) and the `review-package` writer. Publication
   and act binding read `outputs/v<N>/out` directly
   (`src/job-publication.ts:781`, `:910-925`; `src/review-act.ts:687-694`).
   These are the same bytes without the second copy, and the package check
   stays only for old records.
4. **Add `current` and `record <kind>`.** The design calls for per-writer
   commits (§4.2), the `.gitignore` change, `--adopt` and the read-only
   `history` reader (§4.4).
   #1018 adds the motion and direction kinds and the unnumbered scene and
   direction writes. Numbered `direction write`, `scene write --rig` and
   `handoff` stay public and unchanged, with their existing checks and
   historical generators. `next` offers both the existing numbered moves
   and the new record moves (§5.5). #1018 acceptance is
   `rig-create interview --check <dir> --json` at `post`, with exit 0 and no
   `OUTPUT_STALE` after the current-output rebuild.
   Removal of `rig-version`, `draft-rig`, `--answers` and the `v<N>` path
   builders is outside #1018.
5. **Staleness by hash:** `OUTPUT_STALE` in check and stale moves in `next`.
6. **Comments bound by `saw[]`,** once the rig-c/review#1226 contract is
   signed. Delete version-numbered publication subjects and manifests
   (`src/job-publication.ts:706-712`, `:796-800`).
   Switch `direction-review` and `next` to the current-only flow.
7. **Old projects:** WARN demotion once `current` exists, `CURRENT_DATA_SINCE`,
   and the `VERSION_AFTER_CURRENT` row. Run `check` on every live pilot before
   merge (invariant 3).

After the §8.6 Review switch, a separate follow-up removes numbered
`direction write`, `scene write --rig` and `handoff` together. Readers for
retained numbered posts persist.

Docs (#987) follow: `docs/PROJECT.md` layout and lifetimes (`:26-55`),
"Versions" (`:964-1198`) and the agent guide.

---

## 9. Walk-through: adding a capability to a finished project

This walkthrough shows the target design, including the per-writer commits.
The #1018 portion ends with `rig-create interview --check <dir> --json` at
`post` after step 5.

**Start.** A finished project:

- `current.parts`, `.rig`, `.motion` and `.direction` are recorded;
- the owner has looked at the direction in Review and said it is good;
- the last commit is `direction: compose idle take 51be…`.

**The owner asks in chat:** "Can she blink?" Blinking needs an eyelid part, two
rig bones and a motion track.

1. **Plan.** The agent revises the parts step plan and the rig step plan
   (`specs/plan/`, #983) and says in chat what it will change. The writer
   commits `plan: parts, rig — add eyelids`. No sign-off follows (#981).
2. **Parts.** The agent produces eyelid parts. A retouch or model run lands in
   `outputs/parts.next/`. `record parts --from outputs/parts.next` validates,
   swaps the tree, writes `current.parts`, and commits
   `parts: add eyelid_l, eyelid_r`. Then `check` reports `OUTPUT_STALE` for
   rig (its `built_from` names the old `parts.json` sha256), and for motion
   and direction through the rig.
3. **Rig.** The agent edits `specs/rig/config.json`: two bones and the eyelid
   weights. It runs the producer into `outputs/rig.next/`, then `record rig`.
   The commit is `rig: eyelid bones, rebuild from parts 7d40…`, with
   `stale: motion, direction`.
4. **Motion.** The agent adds a blink track to `specs/motion/`, renders, and
   runs `record motion`. The commit is `motion: blink track`.
5. **Direction.** `scene write . --compose-scene specs/direction/compose-scene.json`
   writes the updated `specs/direction/scene.json` with the current rig model,
   idle frame manifest, motion output-set hash and Parts scene bindings.
   `direction write . --file specs/direction/intent.json` writes
   `specs/direction/direction.json`. After compose runs, use
   `record direction --from <compose out> --direction specs/direction/direction.json`.
   The commit is `direction: recompose with blink`.
   `current.direction.built_from` keeps the `outputs/motion` output-set hash,
   so a later frame PNG change makes direction stale even if `frames.json`
   stays the same.
6. **Look together.** `job open` commits the publication closure and shows the
   current work. Old comments on the direction show as "earlier": their `saw`
   hashes differ from the current files, and their words and pins read as
   before. A new comment records the new hashes.

**What did not happen:**

- no `restart`;
- no `amend`, reopen or stage move;
- no version number;
- no parts-review, rig-review or direction-review re-asked;
- no copy of any earlier build.

Today the same request needs `amend parts-review --kind part`, then the whole
approval chain re-run in order: parts verdict, re-dated rig guides,
rigging-interview re-sign, a new rig version and verdict, then post-interview,
a new post and its verdict (inventory C7 row 4; `src/amend.ts:178-207`;
`src/structure.ts:133-136`). The other option is a `restart`, which drops every
record (`src/restart.ts:23-32`).

**Going back.** If the owner says "no blinking after all", the agent runs
`rig-create history` and copies the `back:` line of the commit before step 1
(§4.4). `next` then names the rebind and the stale rebuilds, and each `record`
commits. Nothing is deleted from history.

---

## Appendix A. Every source file that names a record version

Each file is counted by a search of `src/*.ts` for `versions`, `rig_version`
and `v<N>` path patterns. The "Handled in" column points to where this
document disposes of the file. Package-version hits are listed as out of scope.

| File | Hits | Handled in |
| --- | --- | --- |
| `src/rig-version.ts` | 67 | §1.3, §3.2 rows 1-2, 15; §5.2; §8.3-4 |
| `src/job-publication.ts` | 62 | §3.2 rows 5-6, 11, 19; §5.5 |
| `src/review.ts` | 60 | §5.3 (acceptance, handoff); #981 |
| `src/next.ts` | 44 | §3.2 row 9; §5.5 |
| `src/direction.ts` | 30 | §3.2 rows 3, 16; §5.1 |
| `src/feedback.ts` | 27 | §3.2 rows 20, 23 |
| `src/pins-check.ts` | 19 | §3.2 row 28 |
| `src/review-package.ts` | 17 | §3.2 row 10; §8.3 |
| `src/review-act.ts` | 16 | §3.2 rows 12-13 |
| `src/job-host.ts` | 15 | §3.2 row 11 |
| `src/signoff-target.ts` | 12 | §5.1, #981 |
| `src/republish.ts` | 11 | §5.2; §8.2 |
| `src/scene.ts`, `src/scene-writers.ts` | 10, 1 | §1.4; §5.2 |
| `src/pre-interview.ts`, `src/config-lost.ts` | 10, 7 | §5.3; §6 |
| `src/direction-writers.ts`, `src/direction-compose.ts` | 10, 6 | §1.4; §5.2 |
| `src/corrections.ts`, `src/correction-writers.ts` | 8, 4 | §3.2 rows 7-8 |
| `src/applied-review.ts` | 6 | §3.2 row 24 |
| `src/stage-progress.ts`, `src/reopen-lapses.ts`, `src/reopen.ts`, `src/amend.ts`, `src/structure.ts`, `src/signoff-pair.ts`, `src/signoff.ts`, `src/rig-signoff.ts`, `src/owner-chat.ts`, `src/record-direction-target.ts`, `src/job-advance.ts`, `src/signable.ts` | 5, 5, 2, 2, 4, 4, 1, 3, 1, 3, 5, 1 | approval readers: #981 and #982; version lookups §5.5 |
| `src/review-bust.ts` | 5 | §3.2 row 20 |
| `src/provenance.ts`, `src/cg-gates.ts`, `src/setup-painting.ts`, `src/assemble-answers.ts`, `src/figure-mask.ts` | 5, 3, 2, 2, 4 | §3.2 row 26 |
| `src/fix-ledger.ts` | 5 | §3.2 row 22; §5.1 |
| `src/choices.ts` | 4 | §3.2 row 27 |
| `src/check.ts` | 4 | §3.2 rows 1, 10 (call sites) |
| `src/version-declarations.ts` | 3 | §5.2 (preflight) |
| `src/job-outbox.ts`, `src/job-writer.ts`, `src/job-acts.ts` | 3, 2, 2 | §5.5 |
| `src/drafts.ts`, `src/draft-layout.ts` | 2, 1 | §1.3 (drafts go) |
| `src/rig-version-date.ts`, `src/rig-draft-verdict.ts` | 1, 1 | §5.3 `RIG_VERSION_AT_INVALID`; §3.2 row 7 |
| `src/restart.ts` | 1 | §3.2 row 18 |
| `src/plan-history.ts`, `src/plan-bar-amendments.ts` | 2, 2 | not a record version: plan step generations (`plan.replaced`); #983 |
| `src/pins.ts`, `src/packages-upgrade.ts`, `src/package-upgrades.ts`, `src/collection.ts` | 1 each | package versions; out of scope |

## Appendix B. HQ's answers to the open questions

1. **Reproducibility.**
   - #985 slice 1 builds the rig, idle render and compose tree twice from one
     commit, on a clone, and compares hashes.
   - Anything that differs is tracked at its measured size, and §4.1 is
     corrected in that PR.
   - Nothing is declared reproducible on this document's word.
2. **Comment shape.**
   - One contract document with the review tower: `saw[{path, sha256}]`, record
     hash, commit, `comments[]`, optional `carriers[]`, no verdict.
   - Code waits on HQ's sign.
3. **Collections.**
   - A separate card, out of #985.
   - #985 leaves collections working as today: the reader and
     `--member name=version` are kept (§1.4, §3.2 row 28, §5.2, §5.3).
4. **Attribution.**
   - No trailer and no pass-through.
   - Create commits with the configured git identity only (§4.2).
5. **`.gitignore` rewrite.**
   - Acceptable only if it changes that one pattern, is committed with the
     writer's own paths, and the writer prints one line naming the change.
   - If the pattern is not found, because the file was hand-edited, the writer
     raises WARN `GITIGNORE_PATTERN_ABSENT` and changes nothing (§1.2).
6. **Model-run layers, depth maps and figure mask.**
   - Tracked.
   - The PR records what one re-run adds to `.git` after `gc`, measured (§4.1,
     §7).
