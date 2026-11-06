# A project

One painting in, one rig (and the takes made from it) out. Each rig is a
**project**: a folder of its own that holds the painting, the user's direction,
the plan the user signed, every version shown and every verdict given. Without
it, the story of a rig is split across a chat thread, a scratch folder and
someone's memory, and every resume re-reads context and re-guesses.

A project's `project.json` is **the only place a decision is recorded**. Chat
is not a record: a decision made in chat is copied here, verbatim, with who said
it and when.

The field set is **v0** — `"schema": "rig-create/project@0"` — and is expected
to change while the structure is piloted by hand. The `@0` is there so a reader
of a record can tell which shape it follows once the shape moves; a validator
and a migration come with the first shape change, not before. The empty
skeleton is [../templates/project.json](../templates/project.json); a filled
record is [../templates/example-project.json](../templates/example-project.json).
Its sign-offs are fixture sign-offs, not a person's approval; see
[../templates/example-draft/README.md](../templates/example-draft/README.md).

## Layout

```
<project>/
  project.json         the decision record: interview, plan, split, stage, sign-offs, versions
  AGENTS.md            the agent guide: the order, and which installed docs to read; CLAUDE.md imports it
  inputs/              immutable: the painting, the user's references
    references/
  evidence/v<N>/       what a verdict rested on: crops, sheets, check tables
  derived/             regenerable intermediates (ignored by git)
  outputs/v<N>/        skeleton, atlas, takes (ignored by git)
  scratch/             anything; deletable any time (ignored by git)
```

A project is its own git repository, so the history of its decisions is its
`git log`. A collection member is the exception: it lives in its collection's
repository, which holds its history ([COLLECTIONS.md § Making one](COLLECTIONS.md#making-one)). `rig-create init <dir>` writes the layout above, a `.gitignore`
for the untracked folders, a `package.json` pinning the rig-c packages, and a
first commit.

## Data is split by lifetime

Rigging derives far more data than it ships. Sorting every file by how long it
must live keeps the record small and makes "can I delete this?" a question the
folder answers.

| Folder | Lifetime | Tracked | Rule |
| --- | --- | --- | --- |
| `project.json` | forever | yes | The only place a decision is recorded. |
| `inputs/` | forever, never edited | yes | Every file has its sha256 in `project.json` `inputs[]`. A changed input is a new file with a new name, not an edit — otherwise a verdict given on the old file cannot be re-read. |
| `evidence/v<N>/` | forever | yes | The crop, sheet or table a bounce or an acceptance rested on, for the version it judged. If it is not here, the verdict cannot be re-read later. Keep each file small; a larger review image stays where it is and is listed in `versions[].evidence` with its path and sha256. |
| `derived/` | until regenerated | no | Depth maps, masks, layers, configs, frames. Every file (or folder) is listed in `derived[]` with the command and the input hashes that made it. Something that cannot be listed that way is either an input or scratch. |
| `outputs/v<N>/` | until discarded | no | One folder per version that was shown to anyone, frozen when shown. Hashes go into `versions[].outputs`. If the user keeps finals elsewhere, `archive` records where. |
| `scratch/` | none | no | Anything. Deleting it must never lose information; if it would, the file belongs in `evidence/` or `derived/`. |

## Stages

`interview` → `plan-approved` → `parts` → `parts-review` → `rigging-interview` → `rigging` →
`rig-review` → `post-interview` → `post` → `direction-review` → `accepted`,
plus `paused`.

**A stage moves only on a human `signoffs[]` entry**: the stage it closes, who,
when, and the words used. A plan checkpoint is signed the same way, with
`checkpoint` naming the plan step. An agent may draft, propose, build and
measure in any stage; it may not move `stage` forward or pass a checkpoint by
itself. Reason: the stages exist to put a person's eyes before each piece of
work that is expensive to redo; an agent that could advance them would be
grading its own work.

A project is *in* a stage while that stage's work happens; the sign-off named
in the last column ends it and moves the project to the next. The order and
which stages end on a sign-off are written once, in `src/stages.ts`;
`rig-create interview --check` refuses a stage moved past a missing sign-off
([CHECKS.md](CHECKS.md)).

| Stage | User step | What happens | Ends with |
| --- | --- | --- | --- |
| `interview` | 1 | Framing and source/parts guides (the later rig guides wait for rigging-interview) ([INTERVIEW.md](INTERVIEW.md)): the user's sentences, a delegation ("auto"), or not applicable — never left for the agent to fill. | The user signs `{ "stage": "interview" }`. |
| `plan-approved` | 1 | The parts steps (`phase: "rig"`) are drafted from the guides, with the agent's decision written on every delegated item. The user sets each step's checkpoint and signs. | `{ "stage": "plan-approved" }`. |
| `parts` | 1 | The rig steps that make the parts run: `seethrough` and `assemble`. At a step whose checkpoint is on, work stops until `{ "stage": "parts", "checkpoint": "<step id>" }` is signed (the split, [below](#split-approval-is-a-plan-checkpoint)). Only a labelled draft may contain proposed bones/weights for mesh/chest inspection; production rigging remains forbidden. | Every step it runs is `done`, `assemble`'s bar including the parts check passing on the assembled parts. |
| `parts-review` | 1 | **The parts are reviewed before any production rig is built** ([below](#the-parts-are-reviewed-before-rigging)): the user looks at the assembled parts in rig-review's parts view. A bounce is fixed here, in `parts`. | `{ "stage": "parts-review" }`, signed by a person, carrying the approved parts verdict as `evidence`. |
| `rigging-interview` | 2 | Ask bones, meshes, constraints and motion while viewing the approved parts and structure; draft their rigging plan. | The human signs `rigging-interview`, binding accepted parts and structure. |
| `rigging` | 3 | The remaining rig steps run in order (`bones`, `meshes`, `constraints`, `motion`); each config section cites its guide (`versions[].provenance`). At a step whose checkpoint is on, work stops until `{ "stage": "rigging", "checkpoint": "<step id>" }` is signed. It does not start without the `parts-review` sign-off (`PARTS_REVIEW_UNSIGNED`), nor on a verdict that is missing, not approved or no longer the parts on disk (`PARTS_VERDICT_*`). | The last rig step's bar is met. |
| `rig-review` | 1 → 3 | **First review, on a still frame**: the rig alone, fixed camera, no post-production — seams, cuts, physics and motion played in place. Feedback is recorded verbatim with `on_items`; a bounce makes a new rig version. | The user accepts one rig version: an `accepted` verdict with `review: "rig-review"` on it, resting on its still frame, and `{ "stage": "rig-review" }` signed ([below](#the-rig-review-rests-on-a-still-frame)). |
| `post-interview` | 2 | The post items (camera and 2.5D, timing, composition) are asked, and the post steps (`phase: "post"`) drafted from them. | The user signs `{ "stage": "post-interview" }` — guides and post steps together. |
| `post` | 2 | Post-production on the accepted rig version (`versions[].kind: "post"`, `rig_version` naming it); post tooling asks `rig-create handoff` first ([below](#the-hand-off-to-post-production)). | The last post step's bar is met. |
| `direction-review` | 2 → 3 | **Second review, direction**: camera, depth, timing, framing. Same feedback rule. | The user accepts one post version. |
| `accepted` | — | Done. If finals go somewhere else, `archive` says where. | — |
| `paused` | — | Work stopped by a human sign-off. Resuming starts at the first stage whose sign-off is missing. | — |

**Why two reviews.** The rig is reviewed first on a still frame with a fixed
camera — the rig alone — so a seam cannot hide behind a camera move, and a
depth complaint cannot bounce a correct rig. `post-interview` mirrors
`interview`: post guides are asked only once the rig they apply to is accepted,
so they are not asked about a rig that may still change. A rig change after
`rig-review` means a new rig version and a new first review, and the post
version built on the old rig is redone on the new one.

### Reopening a passed stage

```sh
rig-create reopen <stage> --by <who> [--verbatim-file <file>] [--source <text>] [<project dir>] [--json]
```

A human may return to a previously reached stage without deleting signatures.
`reopen` appends `reopens[]` and sets `stage` to its target in the same validated
write. This backward move is the exception to `signoff`'s record-only writer:
leaving the old forward stage would require signatures the reopen supersedes.
The target is in the stage order, excluding `paused` and `accepted`, and no
later than the furthest stage evidenced by the current stage, historical human
sign-offs or dated rig/post versions. No producer is run.

Each entry is `{ stage, from_stage, by, at, verbatim, source?, steps_before }`. `at` comes
from the clock; words come unchanged from UTF-8 file or stdin (omitted or `-`).
`--source` separately records where the words came from. `from_stage` records
where the project stood when the reopen was written. Each entry's eligibility
uses its own `from_stage` and historical evidence dated no later than that entry,
so later backward moves neither erase nor manufacture its reach. An agent cannot sign.
`steps_before` snapshots `{ id, status }` for every plan step running in the
target stage or later, preserving an absent status by omitting it. Those steps
are reset to `pending`; their other fields stay unchanged. Status is outside
`step_hashes`, so existing plan hashes still verify. The append, resets and
stage move happen together, or the file is unchanged on refusal. Before writing,
the command runs the complete project check against the candidate record and
the existing project files; any refusal leaves the original bytes unchanged.

For each stage, a sign-off is live only if dated strictly after every reopen
whose target is that stage or earlier. Checkpoints follow the same rule;
undated entries cannot outrank a reopen. A second reopen advances that cutoff
without restoring signatures invalidated by an earlier, wider reopen. All
signatures remain in place, structurally checked as history. Advancing again
requires live signatures under the existing stage/checkpoint rules. A newly
run step without them is still refused; there is no execution exemption.

Accepted historical rig versions remain accepted as history. If the reopen
covers rig-review, a live hand-off requires a rig version built after it;
a new verdict on an old build cannot revive that build. Historical post
versions keep their original basis; new post work requires the live rig.
Reopening only post work preserves the unaffected rig acceptance.

### The parts are reviewed before rigging

A defect in the parts — a part with nothing painted under its occluder, a
boundary between two parts nobody composed — is cheapest to fix before a bone
is placed on it. Found at `rig-review`, every build in between was spent on
parts that were already wrong, and the fix goes back through the split and
every step after it. So the steps that make the parts (`seethrough`,
`assemble`) run in their own stage, `parts`, and a person looks at the
assembled parts before `rigging` starts.

- **`parts` ends on its bar**: the parts check's gates pass on the assembled
  parts, recorded as `assemble`'s bar met (`status: "done"`). Coverage under
  occluders joins this bar from rig-c/parts#998 once it ships; until then the
  bar is the parts check as it is. A project past `parts` with one of its steps
  not `done` is refused (`PARTS_BAR_UNMET`).
- **`parts-review` ends on a human sign-off**, `{ "stage": "parts-review",
  "checkpoint": null }`, given in rig-review's parts view. Without it the stage
  does not move to `rigging`, and no `rigging` step runs
  (`PARTS_REVIEW_UNSIGNED`). An agent's entry does not count.
- **The sign-off carries the verdict it rests on**: `"evidence": { "kind":
  "parts-verdict", "path": "<the file>", "sha256": "<its sha256>" }`, where
  `path` is relative to the project and names the file rig-review's parts view
  wrote (`rig-review parts`; by default `parts-review.json` beside
  `parts.json`, or wherever `--verdict` put it). Write it to a tracked path,
  `--verdict evidence/parts-review.json`, so the sign-off's evidence survives a
  clone: `derived/`, where the parts are assembled, is not in git. The check
  reads exactly that file, never a default location. Rigging is refused, each case by name
  ([CHECKS.md § Refusals](CHECKS.md#refusals)), unless the verdict is the
  `rig-review-parts-verdict/1` or `rig-review-parts-verdict/2` schema in `parts` mode (an `atlas` verdict is
  informational and never gates), its `status` is `approved`, and every file
  in its `source.files[]` is on disk with the bytes and sha256 it was reviewed
  with. A part added, removed or repainted after the sign-off is a new review:
  the user reviews again and signs again, with the new verdict as evidence.
  The latest `parts-review` sign-off is the one read. **The parts themselves
  must be on disk to rig**: on a fresh clone, re-assemble them before rigging
  continues. The verdict gates rigging only until a rig version is accepted at
  `rig-review`: from then on it is not read, and a part changed after that is a
  new rig version, refused as `RIG_VERSION_UNACCEPTED` until it is reviewed.

  Both schemas take the same approval, mode, evidence SHA-256, source path,
  byte-count and source SHA-256 checks. The schema allowlist is closed: `/3`
  and any other value refuse `PARTS_VERDICT_SCHEMA_UNKNOWN`. The signoff writer
  calls this reader before writing; the difference-map reader receives only
  its successfully checked `parts.json` path. These readers do not need new
  fields (`tests/parts-verdict-v2.test.ts`).

  **Fields added by `/2`.** The schema-final review writer at
  [`07c07d254725c97cfc63aa7b028cb8ef8ccf9045`](https://github.com/rig-c/review/blob/07c07d254725c97cfc63aa7b028cb8ef8ccf9045/src/parts-view.ts)
  adds `comments[]`; its complete nested shape comes from
  [`PartsComment`](https://github.com/rig-c/review/blob/07c07d254725c97cfc63aa7b028cb8ef8ccf9045/src/parts-comment.ts).
  All fields below are explicitly ignored **for create's gate**, retained
  unchanged in the verdict file and covered by `evidence.sha256`. create
  neither copies nor rewrites them into `project.json`, and does not open crop
  paths or require the review machine's crop state. Review owns comment
  validation and crop generation; an approved verdict may include comments.

  | New field paths | Why create does not interpret them |
  | --- | --- |
  | `comments` (including an empty list), `comments[].schema`, `.id`, `.summary` | Reviewer annotations, not a second approval status. The gate reads the producer's top-level `status`. |
  | `comments[].part`, `.imageHash`, `.sourceHash` | Comment-specific identities owned by review. The gate binds all original source bytes through `source.files[]` and `source.sha256`, regardless of comments. |
  | `comments[].imageRegion.{x,y,width,height}`, `.rigRegion.{x,y,width,height}` | Native and placed annotation coordinates; create consumes no region measurement and must not rederive it. |
  | `comments[].view.camera.zoom`, `.camera.center.{x,y}`, `.camera.viewport.{width,height}` | Primary viewport camera, used to replay the review view, not to approve parts. All camera paths in this row are under `comments[].view`. |
  | `comments[].view.cameraSync`, `.referenceCamera` (nullable), `.referenceCamera.zoom`, `.referenceCamera.center.{x,y}`, `.referenceCamera.viewport.{width,height}` | Reference viewport replay and synchronization; no camera consumer in this gate. |
  | `comments[].view.{background,alpha,footprints,mesh}` | Display toggles, not part outcomes or producer measurements. |
  | `comments[].crop.{path,sha256,width,height,png}` | Viewport crop metadata and inline PNG, owned by review; not the assembly source inventory. |
  | `comments[].nativeCrop` (nullable in the type), `.nativeCrop.{path,sha256,width,height}` | Review-generated native crop evidence, not a replacement for the original part image. create binds the original bytes without regenerating a crop. |

  `tests/fixtures/rig-review-parts-verdict-2/README.md` records the exact producer
  head and reproducible command. Its empty-comment and pointed-comment verdicts
  are unedited writer output. `tests/parts-verdict-v2.test.ts` exercises both
  through `signoffCommand` then `checkProject`, tests comment-byte binding and
  operation without external crop state, and applies source/mode refusal
  controls to both schema versions. Existing `/1` fixture bytes are unchanged.

- **The same sign-off carries a whole-figure difference map**, beside `evidence`.
  Generate its report with the installed `rig-parts diff-components --out` on
  the assembled stack and the painting in the same native canvas. create reads
  the report and binds its exact bytes by SHA-256.

  ```json
  "diff_map": {
    "report": { "path": "evidence/diff-components.json", "sha256": "<report sha256>" },
    "components": [ { "id": "<report component id>", "status": "in-painting", "why": "<what was observed>" } ]
  }
  ```

  ```sh
  rig-create signoff parts-review --by user --evidence evidence/parts-review.json --diff-report evidence/diff-components.json --component 'p10-n3=in-painting:the painting contains this edge' --verbatim-file approval.txt
  ```

  The writer hashes the report and validates the entire map before recording
  anything. Repeat `--component <id>=<status>:<why>` for every component. The
  first `=` and first following `:` separate fields, so `why` may contain colons.
  Every report id must appear exactly once, with no extra ids. Status is
  `in-painting`, `fixed` or `left`, and every status requires a nonempty `why`.
  A report with no components needs no component flags. Its spec must be
  `rig-parts-diff-components/1`, `definition.floor_px` at most 2 and
  `definition.threshold` at most 40. The stack is derived from the verdict's
  covered `parts.json`, resolved relative to that verdict. For its directory D,
  build writes `D/recomposite_rig.png`, while standalone assemble writes
  `D/../render/recomposite_rig.png` only when D is named `rig`.
  Exactly one candidate must exist and hash to the report's `stack.sha256`.
  Neither or both candidates refuse rigging. create never computes the map or
  runs the producer's `--verify`. This uses the latest sign-off and the same
  rigging gate and acceptance boundary as the parts verdict above.
  From `DIFF_MAP_SINCE` (2026-11-06T00:00:00Z), a missing map refuses writing
  the sign-off and rigging. An earlier sign-off without one gets only
  `DIFF_MAP_PREDATES`; a map carried by an earlier sign-off is checked fully.
  Both flags are accepted only on `parts-review`; component flags require a report.

  The filled example's report and stack are synthetic, with two listed
  components. `bun scripts/generate-example-diff.ts <fresh scratch directory>`
  regenerates them through the installed parts CLI and the sign-off writer.
  Add `--check` to reproduce the shipped report, stack and inline record bytes.
- **A project that passed `plan-approved` before these two stages existed**
  (its first `plan-approved` sign-off is dated before 2026-11-04, the
  `PARTS_REVIEW_SINCE` in `src/stages.ts`) is not given a sign-off nobody made.
  The check reports it as a warning naming the project
  (`PARTS_REVIEW_PREDATES_STAGE`): its parts were not reviewed before rigging.
  Its `assemble` checkpoint, signed then as `rigging`, still counts. The date
  is read from that sign-off because signing `plan-approved` is the dated,
  human act that moved the project past where the two stages now stand.

### The rig review rests on a still frame

The rig is accepted at `rig-review` by **one verdict on one version**: a
human `verdicts[]` entry with `"review": "rig-review"` and `"verdict":
"accepted"` on a `kind: "rig"` version. The `{ "stage": "rig-review" }`
sign-off moves the stage; the verdict names the version. They are the same
act and are written in the same turn (the sign-off has no version field
because the verdict already carries `by`, `at` and `verbatim` on the version
it is about — a second copy would be a second place for one decision).

That acceptance rests on a **still-frame record** in the same version's
`evidence[]`:

```json
{ "kind": "still", "path": "evidence/v2/still-frame.png", "sha256": "…", "camera": "fixed", "frame": 2, "what": "the rig at the fixed camera, posed 2 s into the loop" }
```

| Field | Holds |
| --- | --- |
| `kind` | `"still"` — what marks this entry as the rig review's frame; other evidence entries may leave `kind` out |
| `path`, `sha256` | the image under `evidence/v<N>/` and its 64-hex sha256 |
| `camera` | `"fixed"`: no camera move, no parallax, no post-production; any other value is not a still frame |
| `frame` | `"setup"` for the renderer's setup pose, or the time in seconds into the motion the rig is posed at. `0` is the motion's start, which is not the setup pose when the idle rests off it (a breath track whose `base` equals its `amp` passes through setup mid-loop) |
| `what` | what it shows, in words |

This repository does not render the still: rig-c/core and rig-c/review render,
the agent records the file here. An acceptance with no such record is refused
(`RIG_ACCEPTED_WITHOUT_STILL`, [CHECKS.md](CHECKS.md)); a bounce needs none to
be recorded, though what it rested on still goes in `evidence/`.

**A rig changed after `rig-review`** is a new rig version, and the project is
back at `rig-review` for it: past that stage, the latest rig version must carry
its own acceptance (`RIG_VERSION_UNACCEPTED`). Once it is accepted, the post
version built on the old rig is redone on the new one — the current (latest)
post version naming an older accepted rig is refused (`POST_ON_SUPERSEDED_RIG`);
earlier post versions are history and are left as they are. This is a refusal,
not a warning: a direction review of a take built on a rig the user has since
replaced would accept something that no longer matches the rig.

### The hand-off to post-production

```
rig-create handoff [<project dir>] [--rig <n>] [--json]
```

Post-production tooling runs this before it runs. It exits `0` and prints the
one rig version post work may run on — the latest accepted rig version, with
its acceptance and its still frame — and exits `1` with a named refusal when
there is none: no `rig-review` sign-off (`RIG_REVIEW_UNSIGNED`), no accepted
rig version or a newer rig version not yet reviewed (`RIG_VERSION_UNACCEPTED`),
an acceptance with no still frame (`RIG_ACCEPTED_WITHOUT_STILL`). With
`--rig <n>` it also refuses when `<n>` is not that version
(`POST_ON_UNACCEPTED_RIG`, `POST_ON_SUPERSEDED_RIG`). The `n` it prints is what
the post version's `rig_version` holds. It reads the record and writes nothing.

**When post is not passed.** If every post item is answered *not applicable* in
`post-interview` (a collection member whose composition belongs to the
collection, for example), the sign-off of `post-interview` says so and the
project moves from there to `accepted`.

### Split approval is a plan checkpoint

The split — which parts the painting becomes — is the decision most often sent
back, so it is shown to the user as a labelled image before the rest of the rig
is built. It is a **checkpoint on the `assemble` step**, not a stage of its own:
a stage and a checkpoint are the same act (a human signature before the next
piece of work runs), so keeping both would record one approval in two places,
and the plan lets the user stop at any waypoint, not only the split. The split's
data (proposal image under `evidence/split/`, parts, labels) lives in `split`;
its approval is the `signoffs[]` entry with `"stage": "parts", "checkpoint": "assemble"`. This checkpoint has no
default: the user turns it on or off, or delegates it, like every other.

### Generated split captions

```sh
rig-create split-captions [<project dir|project.json>] [--config <file>]
```

The command prints `rig-create/split-captions@0` JSON to stdout. A directory
uses its `project.json`, and the default is the current directory. Config
paths are relative to the project record's directory, defaulting to
`config.json`. Redirect the result into the proposal's evidence directory.

`inputs` records the project and config paths and SHA-256 of their exact bytes.
`config[]` carries each top-level setting's `path`, structured `value` and
machine-generated `text` (`path = JSON(value)`), including the assembly scale,
plan, limb routes and bone bindings. `parts[]` preserves `split.parts` order
and carries each `name`, `label` and generated `text` (`JSON(name) = JSON(label)`).
A sheet renderer can use those strings directly. Every caption comes from the
input data. Config annotations (`note`, `*_note`, `x-*`) are omitted, preserving
exact-name map keys, including limb names, turn depth part names and depth
source-layer names. `split.parts.note` is excluded.

The installed parts parser validates complete rig configs through its full
config door, and incomplete configs through its early `assemble` door, which
checks the split's settings and reads bones with declared limbs. The output
records declarations. Pixel assembly, rendered scale and motion acceptance
require their own evidence. Exit 1 names an unreadable or malformed input,
unknown project schema, malformed or duplicate split name, invalid label, or
parts config refusal. Usage errors exit 2. Refusals produce no caption stdout.

The worked list is [example-split/captions.json](../templates/example-split/captions.json),
generated with the existing filled record and a synthetic config. Regenerate it
from the repository root with

```sh
bun src/cli.ts split-captions templates/example-project.json --config example-split/config.json > templates/example-split/captions.json
```

[example-split/config.json](../templates/example-split/config.json) supplies
synthetic config bytes because the filled record's historical config paths
have no corresponding files. Its scale, coordinates, source tags, bindings and
empty motion tracks are test inputs. The painting, split layers and rig output
remain unverified by this caption fixture.

## The plan

The plan lives in `project.json` `plan`, not in a separate file: `project.json`
is already the only place a decision is recorded and the first thing a resuming
agent reads, and a second file is one a resume can skip.

```json
"plan": {
  "drafted_by": "agent",
  "drafted_at": "2026-11-10T15:30:00Z",
  "steps": [
    {
      "id": "assemble",
      "phase": "rig",
      "order": 2,
      "does": "Turn layers into parts, in draw order; propose the split as an image, one label per part",
      "produces": "config assemble; split.proposal_image, split.parts[]",
      "rests_on": ["assemble", "constraints"],
      "bar": "Every part the assemble guide names exists; every part has one label; the setup-pose recomposite matches the painting",
      "checkpoint_proposed": true,
      "checkpoint": { "delegated": false, "by": "user", "at": "2026-11-10T16:00:00Z", "verbatim": "yes, show me", "value": true },
      "status": "pending"
    }
  ]
}
```

- **Rig steps follow the waypoints**: one step per waypoint the plan passes, in
  pipeline order, with the step's `id` equal to the waypoint's. The last rig
  step also renders the still-frame check for `rig-review`. **Post steps**
  (`phase: "post"`) are added in `post-interview`, one per post item passed.
- **`rests_on` names the answers a step is built on** — waypoint ids, framing
  ids (`rig_type`, `reference`) or post item ids; at least one. A step no answer
  covers is not allowed: ask for the sentence first
  ([INTERVIEW.md § Questions outside this set](INTERVIEW.md#questions-outside-this-set)).
  A step resting on a delegation is legal; the delegation is read from the
  guide, not restated here.
- **`checkpoint`** takes the answer shape from INTERVIEW.md: the user's `true` /
  `false` as `value`, or delegated. The drafter may fill `checkpoint_proposed`;
  only the user (or a delegation) fills `checkpoint`.
- **`bar`** is what *done* is measured by for that step, written before the
  step runs. A sentence that names a part, effect or extent is a bar line
  ([INTERVIEW.md § Direction is taken in sentences](INTERVIEW.md#direction-is-taken-in-sentences)).
- **`status`**: `pending` → `in-progress` → `at-checkpoint` (waiting for a
  sign-off) → `done`.
- A changed guide — including one added from polish feedback — sends every step
  that rests on it back for a new sign-off by its step-specific approval stage before it runs.
- **Provenance**: each version built from a config records, per config
  section, the guide sentence or delegation each entry follows
  (`versions[].provenance`, [INTERVIEW.md § Provenance](INTERVIEW.md#provenance-every-config-section-cites-its-guide)).
  An entry with no citation is removed or cited before the version is shown.

## Recording a sign-off

```sh
rig-create signoff <stage> --by <who> [--steps <id,id,...>] [--verbatim-file <file>] [<project dir>] [--json]
```

The `signoff` command appends `signoffs[]` and leaves `project.stage` unchanged. `at`
comes from the clock. There is no `--at` option. The user's UTF-8 words come
from the file, or stdin when omitted or `-`, preserving BOM, spaces, CRLFs and
final newlines. Invalid UTF-8 is refused because a JSON string cannot retain
its original bytes.

For new-order `plan-approved`, coverage is the parts steps; `rigging-interview` covers the remaining rig steps. Legacy `plan-approved` covers every rig step. For `post-interview`, it is
every post step. `--steps` narrows coverage within that phase and stores the
covered ids in `steps[]`. Execution stages accept `--checkpoint <step id>`
when that step runs in the
named stage and its recorded checkpoint is enabled. This records
`checkpoint: <step id>`, without `steps` or `step_hashes`. It cannot be combined
with `--steps`.

`parts-review` requires `--evidence <verdict path>`. The command stores
`{ kind: "parts-verdict", path, sha256 }`, resolving filesystem links,
normalising the path to project-relative POSIX form and hashing the file. The existing parts-verdict reader validates
approval, shape and source freshness before anything is written. Other stages
refuse `--evidence`.

Only `plan-approved`, `rigging-interview` and `post-interview` accept `--steps`. Stage movement
remains a separate act read by the check.

Each covered step needs a boolean `checkpoint_proposed`. A null checkpoint
becomes `{ delegated: false, by, at, verbatim, value: checkpoint_proposed }`.
Existing user answers and decided delegations stay as recorded. An undecided
delegation, malformed checkpoint or unknown step refuses the whole command
before the file is written.

Each plan signature also records `step_hashes`, mapping covered step ids to
SHA-256 of UTF-8 JSON with object keys recursively sorted and array order
preserved. The fields are `id`, `phase`, `order`, `does`, `produces`,
`rests_on`, `bar`, `checkpoint_proposed` and `checkpoint`, after filling the
checkpoint. Absent fields are omitted. `status` and other fields are excluded.
The shared implementation is `src/step-hash.ts`.

`review` accepts `--verbatim-file <file>` (or `-` for stdin) instead of
`--verbatim`, and `--at <timestamp>` instead of the clock. Repeatable
`--answers-feedback <version>:<verdict-index>` appends references to the
reviewed version's `answers_feedback`. Each reference must identify an
existing verdict of an earlier version and must not duplicate an existing or
new reference. Both writers refuse `by: agent` case-insensitively.

## Versions

A reopen preserves every version and verdict; a rebuild is a new numbered
version, never an overwrite of an accepted historical build.

A rig version's provenance config, review package and accepted parts must identify the same build.

Every build shown to anyone is a `versions[]` entry, numbered in order across
both kinds:

| Field | Holds |
| --- | --- |
| `n` | the version number, `1, 2, …` |
| `original_n` | on pre-interview versions only, the unchanged source id as a number, string or `null`; non-null ids are unique |
| `config_lost` | on pre-interview versions only, `{ note, source }` with nonempty strings when the build config did not survive; cannot accompany `provenance.config` or authorize post work |
| `outputs_lost` | on pre-interview versions only, `{ note, source }` with nonempty strings beside `outputs: []` when frozen outputs did not survive |
| `kind` | `rig` or `post` |
| `rig_version` | for a post version, the `n` of the accepted rig it is built on (accepted before the post version's `at`); `null` for a rig version |
| `at`, `built_by`, `built_with` | when, which agent or tool, and the package versions used (`{ "@rig-c/parts": "…", "@rig-c/core": "…" }`) |
| `review_origin` | null for a build made without review feedback, otherwise the applied-round record below |
| `answers_feedback` | the verdicts this version answers: `[{ "version", "verdict" }]` (version number and index into its `verdicts[]`); empty for a first version |
| `changed` | what changed from the previous version of the same kind, in a sentence |
| `outputs` | `outputs/v<N>/` files with sha256 and size, frozen when shown |
| `evidence` | `evidence/v<N>/` files with sha256 and what each shows; on a rig version accepted at `rig-review`, one is the still-frame record (`kind: "still"`, `camera: "fixed"`, `frame`) |
| `provenance` | the config this version was built from and, per section, its citations |
| `verdicts` | what people said: `by`, `at`, `review`, `verdict` (`accepted`, `bounced`, `provisional`), `verbatim`, `source`, `on_items[]` |

A provenance citation may add `asks: ["<ask id>", …]`, naming the
canonical asks its guide records in `answer.asks`. For example,
`{ "entry": "torso", "guide": "meshes", "asks": ["bend"], "quote": "The coat is one piece" }`
cites the user-answered bend ask. A delegated density citation uses
`{ "entry": "density", "guide": "meshes", "asks": ["density"], "delegated": true }`
and needs that answer's decided `agent_decision`. Each named ask's coverage
and supporting quote or decision must come from the same answer, including
answers preserved in history. A user ask requires a quote and cannot be
claimed as delegated. Missing ids on a guide with per-ask coverage warn.

A verdict item with `answer_was: "delegated"` may add `ask: "<ask id>"`.
The ask must be recorded as delegated in a current or historical answer.
`rig-create review … --item meshes:delegated --ask meshes=density` writes
that field. `--ask` is optional, accepts one ask per named item, and is for
delegated feedback. Missing it on a guide with per-ask coverage warns.
Guides without per-ask coverage gain no finding when these fields are absent.

`provisional` is a verdict given before the person has seen everything they
want to see — it holds a place and is replaced, never a basis for moving a
stage.

### Migrating work done before the interview

Keep `kind: "rig"` or `"post"` and add `pre_interview: true`. The flag records
when the work was made while preserving which review judges it and which rig
post work rests on. These versions need no `provenance`. Create-built versions
continue to cite their interview and retain the user's words in verdicts.

A pre-interview verdict has create's `by`, valid `at`, `review`, `verdict`,
`source` and `on_items[]`. When the words survive, keep them in `verbatim`.
When only someone's record of the user survives, set `verbatim: null`, state
that it is a record in `note`, put the record there and name its `source`.
The check requires the note and source. A summary never becomes an interview
quotation. Historical `not-asked` items remain in the verdict without invented
`additions[]` in today's guide. Current answers and sign-offs are still checked.

Keep the complete original verdict array unchanged in `original_verdicts` on
the version. Its entries occupy the same indices in `verdicts[]`, each copied
unchanged into `as_recorded` beside the converted fields. The check compares
all fields and the array order, including repeated verdicts. Further reviews
may be appended without `as_recorded`. The original `verdict` string maps by
this exact table, also exported as `PRE_INTERVIEW_VERDICTS`.

| Original `verdict` | Create `verdict` |
| --- | --- |
| `accepted`, `Accepted` | `accepted` |
| `accepted (sent to owner)`, `Accepted (sent to owner)` | `accepted` |
| `bounced`, `Bounced` | `bounced` |
| `provisional`, `Provisional` | `provisional` |
| `accepted (HQ-provisional, sent to owner)` | `provisional` — the reviewer marked “HQ-provisional”, org HQ ruling 2026-11-06 |
| `accepted-provisional` | `provisional` — the reviewer marked “provisional”, org HQ ruling 2026-11-06 |
| `ok for now, polish wanted` | `accepted`, polish in `on_items[]` — owner 2026-11-03, “`<pilot>`도 여기까지 OK” and “일단 여기까지는 OK”; org HQ ruling 2026-11-06 |
| `close, polish wanted` | `provisional`, polish as its open item — owner 2026-11-03, “`<pilot>` 많이 좋아졌다. 조금만 더 다듬으면 되겠어”; org HQ ruling 2026-11-06 |

An unlisted string is refused as `PRE_INTERVIEW_VERDICT_UNKNOWN`. Preserve it
and obtain an explicit mapping before extending the table. A converted value
that disagrees with the table is `PRE_INTERVIEW_VERDICT_MISMATCH`.

Every historical version lists its frozen `outputs[]` with project-relative
`path`, `sha256` and `bytes`. The check reads every file and compares its hash
and size. If no frozen output survived, use `outputs: []` with
`outputs_lost: { note, source }`, recording what was lost and the record that
says so. Both strings must be nonempty. A loss declaration beside nonempty
outputs is refused. Such a version can never authorize post work. All
pre-interview versions precede the first create-built version, with positive,
strictly increasing `n` across the combined history.

For a lost build config, first recover the producer version from that version's
own source record and put it in `built_with["@rig-c/parts"]`. A version's
producer is recorded from its own source record, never inferred from neighbours.
A producer older than 2.4.0 receives `CG_GATES_PREDATE` on a CG rig.
If the config did not survive, declare `config_lost: { note, source }` with
nonempty strings explaining the loss and naming its source. This requires
`pre_interview: true` and absent or null `provenance.config`. A CG rig receives
`CG_GATES_CONFIG_LOST` instead of `CG_GATES_UNREAD`, preserving the check exit
when the rest of the record passes. A known old producer and a declared config
loss receive both warnings. The declaration is also available when the source
names no producer version. Handoff refuses a selected rig with this declaration
as `PRE_INTERVIEW_CONFIG_LOST`; post records cannot use it as their rig basis.
Build and accept a new rig with its retained config before post work.

An accepted pre-interview rig with surviving outputs and no config loss still
authorizes post work. Its human
`rig-review` verdict, valid acceptance time, still-frame record and
`rig-review` sign-off remain required. `handoff` reports `pre_interview` in
JSON and prints that status and the verdict's source in text. It also lists
the note and source of historical output losses, and refuses a selected rig
whose outputs were lost. A later rig
requires its own acceptance and supersedes the older rig in the usual way.
Other checks, including the CG gates where applicable, continue to run.

For an in-flight consumer project keeping history under `x-pre_create.versions`,
perform the following migration on its own decision record.

1. Preserve the original array and frozen outputs before editing. For each
   version, recover its complete original verdict array from the existing
   `as_recorded` entries or the source record. Keep that array in
   `original_verdicts` and retain each full entry as `as_recorded` at the same
   index. Do not replace a missing original with a reconstructed quote.
2. Move the historical entries into `versions[]`, keeping `kind` and adding
   `pre_interview: true`. Put them before the create-built entries, preserve
   a copy of the source id in `original_n` (number, string or `null`). Assign
   positive, strictly increasing `n` in record order. Non-null `original_n`
   values must be unique; multiple nulls are allowed. Rewrite `answers_feedback`
   version references and post `rig_version` references to the new `n`.
   Create-built versions carry no `original_n`.
   Remove the moved `x-pre_create.versions` array. A nonempty array left there
   produces the `PRE_INTERVIEW_UNMIGRATED` warning while migration is pending.
   It preserves the existing check exit code. Migrated records are checked
   with the refusals described above.
3. Fill create-shaped verdict fields from known records, using the mapping
   table, stating their source and recording summaries as `verbatim: null`
   with `note`. Preserve carried `on_items[]` and map them to the interview's
   item ids. Recover dates from dated evidence without inventing them.
4. First record any producer version named by each version's own source in
   `built_with`; never infer it from neighbouring versions. Restore the build
   config and its provenance binding if it survived. Otherwise declare
   `config_lost: { note, source }` explaining the loss and its source; this
   version cannot authorize post work.
   Restore each frozen output and record its actual `path`, `sha256` and
   `bytes`. When none survived, declare `outputs: []` and `outputs_lost`
   with the known loss in `note` and its record in `source`. Check that all
   `answers_feedback` and `rig_version` references use the new `n`, including
   references from create-built entries. Retain acceptance stills and genuine
   stage sign-offs. The flag
   supplies no missing review evidence or sign-off.
5. On the first create-built version, list the earlier feedback it answers in
   `answers_feedback`, including carried items where relevant. The existing
   `review --answers-feedback <version>:<verdict-index>` writer can append
   these references. Keep that version's provenance and interview words.
6. Run `rig-create interview --check <project dir> --json`, resolve the named
   refusals and inspect `rig-create handoff <project dir> --json` before post
   work. The synthetic [migration fixture](../tests/data/pre-interview.json)
   contains one bounced rig and one accepted rig carrying a timing item.

## The record, field by field

Top-level fields of `project.json`:

| Field | Holds |
| --- | --- |
| `schema` | `rig-create/project@0` |
| `name` | the folder name; a short identifier |
| `title` | the human title of the painting or rig |
| `stage`, `stage_values` | the current stage and the list it comes from |
| `signoffs[]` | every human signature: `stage`, `checkpoint` (step id or `null`), `by`, `at`, `verbatim`; plan signatures add `steps[]` naming covered steps and `step_hashes` binding their approval fields. `by` names whose decision is recorded, including their delegated instruction written by an agent, and `by: "agent"` remains refused (`SIGNOFF_NOT_HUMAN`). |
| `interview` | `question_set` (the prompt set and package version the waypoints were read from), `held`, `date`, `interviewer`, `respondent`, `framing[]` (`id`, `text`, `source`, `required_for`, `answer`, `history[]`), `waypoints[]` (`id`, `config[]`, `prompts[]` of `id`/`text`/`source`/`required_for`, `guide`, `history[]`), `post` (`held`, `date`, `items[]` shaped like waypoints with `guide`) — answer shapes in [INTERVIEW.md](INTERVIEW.md) |
| `plan` | `drafted_by`, `drafted_at`, `steps[]` — above |
| `split` | the `assemble` checkpoint's data: `label_values`, `proposal_image`, `proposed_by`, `proposed_at`, `parts[]` (`name`, `label`, `note`) |
| `inputs[]` | `path`, `sha256`, `bytes`, `origin` (where the file came from, in words) |
| `derived[]` | `path`, `what`, `command`, `inputs[]` (`path`, `sha256`), `bytes` |
| `versions[]` | above |
| `archive` | `null`, or `{ "where", "at", "by" }` if the finals were moved out of the project |
| `notes[]` | free text that is not a decision; anything that is one goes in the field it belongs to |

## How an agent resumes a project

1. Read `project.json` — nothing else first. `stage`, the last `signoffs[]`
   entry, the first `plan.steps[]` entry not `done` and the last `versions[]`
   entry say where it stands. For a collection member, read the collection's
   `collection.json` next ([COLLECTIONS.md](COLLECTIONS.md)): its stage and
   `plan.order` say whether this member may run now, and its interview holds
   every answer marked `inherited`.
2. If the interview has a `null` answer or the plan is unsigned, that is the
   next work, and it is the user's to answer; do not fill it from the image.
3. If the last version was bounced, its verdict's `verbatim`, its `on_items`
   and the files in its `evidence` are the brief. Open the evidence; do not
   reconstruct the reason from chat. Feedback with `answer_was: "not-asked"`
   becomes a guide sentence at its waypoint before the next version is built.
4. Check `inputs[]` hashes against `inputs/` before using them.
5. Reuse `derived/` only through `derived[]`: an entry whose input hashes no
   longer match is stale — regenerate it with its recorded command.
6. When a new version is shown to anyone: freeze `outputs/v<N>/`, hash it, add
   the `versions[]` entry and its evidence in the same turn.

## Prepared inputs and agent-found bounces

`rig-create derived add [<project dir>] --source inputs/source.svg --file derived/prepared.svg --operation "external scale and white composite"`
records work already performed by another tool. It appends one `derived[]`
entry; it transforms no pixels and changes no sign-off or stage. `derived add`
is used instead of `prepare` because the operation has already run elsewhere.
Both files must exist, have distinct project-relative paths, and be readable.
Neither may be `project.json`: appending the record would change its own hash.
The command measures both sha256s before writing anything:

```json
{
  "kind": "prepared-input",
  "source": { "path": "inputs/source.svg", "sha256": "<64 hex digits>" },
  "path": "derived/prepared.svg",
  "sha256": "<64 hex digits>",
  "operation": "external scale and white composite"
}
```

`interview --check` requires the source and verifies its hash. A missing source
or changed bytes in either present file are refused by name. A missing result
warns with its file name and recorded operation, so a fresh clone passes while
regenerable intermediates are absent. Only entries tagged `kind: "prepared-input"` use this contract; older
untagged intermediates and projects with no `derived[]` entries keep passing.
Restore derived files with the recorded operation when needed. The recorded
hashes describe the bytes that must return.
The filled example ships synthetic SVG bytes under
[example-prepared](../templates/example-prepared/); copy `source.svg` to
`inputs/preparation-source.svg` and `prepared.svg` to `derived/prepared.svg`
when materializing its prepared-input record. These fixtures demonstrate
recording, not a claim that the tool performed or verified pixel processing.

Busy-ground figure masks have a coverage gap: foreground subtraction excludes
character pixels under that plane, so `SETUP_MATCHES_PAINTING` can pass with
parts missing there. Keep the [default recipe](CHECKS.md#busy-ground-figure-masks).
A character-plate matte can include inpaint fill as figure;
[#113](https://github.com/rig-c/create/issues/113) tracks that upstream plate-making
problem.

An agent rejecting its own route mid-step records it in that guide's
`history[]`, separately from human `versions[].verdicts[]`:

```json
{
  "at": "2026-11-11T08:00:00Z",
  "bounce": {
    "cause": "agent",
    "failed": "The first split merged the eyelids into the face",
    "bar": "Blink needs the eyelids as their own layers",
    "replacement": "Run a head pass as well as the full pass"
  }
}
```

`failed`, `bar`, and `replacement` are non-empty text: what failed, against
which bar, and what replaced it. This record does not grant a new user choice
or sign-off and does not create a human review verdict. The check reads local
histories and the collection histories an inherited answer cites. Compatibility
is per history entry's own `at`, not the project's age: malformed bounces before
`AGENT_BOUNCE_SINCE` (`2026-11-05T00:00:00Z`), or with no readable date, warn
with the new shape. Malformed bounces on or after it are refused.

### The package handed to rig review

Before showing a create-built rig version, run from the project directory:

```sh
rig-create review-package 1 --config evidence/v1/config.json --from outputs/v1/out
```

The source paths are explicit, project-relative inputs. The command copies the
config unchanged and the build's `parts.json`, `parts/`, `rig/`, and
`check/build/` into `derived/review/v1/`, with the config at `config.json` and
the build files under `out/`. A declared adjacent JSON requirements file is copied beside the config and included in the frozen inventory. The source build must include `rig/rig.json`,
`rig/motion.json`, `rig/mesh_report.json` and
`check/build/skeleton.model.json`. Copies preserve the package when the build
directory is cleaned. Each copied file is hashed. The command writes no new
build and moves no stage.

The version's `review_package` field records `config` (`path`, `sha256`),
`from` (the declared build directory), `files` (sorted package-relative
`{path, sha256}` entries, including the copied config), and `open`:

```json
{"open":"rig-review open 'derived/review/v1/out'"}
```

Run that open command from the project directory. Review recognizes `out/`
as a build root, opens its `check/` package and discovers the config beside
the build root. The installed review package documents this discovery under
*Producer handoff* in `docs/REVIEW_PACKAGE.md`. Its handoff hash identifies
the exact copied config. The hash check binds the copies to this version's
recorded input snapshot. The producer baseline in review determines whether
those inputs reproduce the inspected rig.

`interview --check` warns with the package command when a rig version has no
recorded package or when a recorded package is absent after a fresh clone.
A present package must match the complete recorded file list and hashes.
Regenerate a missing package from its recorded sources. If an existing
package differs, the writer refuses replacement so the frozen copy can be
inspected. A new build shown to the user gets a new version and package.
Post versions go to direction review, outside this package contract.
Pre-interview versions retain their existing history and output checks and
are exempt from review-package warnings.

The filled example ships synthetic producer bytes under
`templates/example-review/`. Its two `review_package` records are generated
by `bun scripts/generate-example-review.ts <fresh scratch project>`. Add
`--check` to verify that generation reproduces the shipped record bytes.
The script runs the public `review-package` command for both rig versions.
`reviewExampleFiles()` in `tests/review-fixture.ts` maps those bytes to the
declared sources and package destinations, and both example fixture helpers
materialize them. The regression test generates two fresh projects and
compares every record and file byte before checking the filled example with
zero refusals and zero warnings.

Apply results return in review feedback as `feedback[].context.applied`.
Keep the JSON written by `rig-review feedback` in the project and record one
applied round on the next version as `review_origin`:

```json
{
  "feedback": { "path": "evidence/review-feedback.json", "sha256": "<file SHA-256>" },
  "source_version": 1,
  "feedback_id": "<feedback item id>",
  "applied": { "schema": "rig-review-applied/1", "...": "complete context.applied object" }
}
```

The containing version is the next-version link. `source_version` names the
immediately preceding version of the same kind. Copy the selected item's
complete non-null `context.applied` into `applied`, preserving every field.
A build made without feedback records `review_origin: null`, including the
filled example. This declaration is independent of human `answers_feedback`.

The check binds the feedback's bytes, selected item and applied result to the
source package's config, handoff files and inspected compiled model. In the
released folder adapter, `reviewedSource.rig` identifies that compiled model
and `motion` is null; producer rig and motion hashes live in `handoff.files`.
The retained feedback is a single-build `rig-review-session/1` export.
Record the resulting version's outputs, hashes and provenance and write its
review package as usual. This chain records the applied result and the next
build's declared origin. Create does not execute the Apply or build.

A missing declaration on a version dated before
`APPLIED_REVIEW_SINCE = 2026-11-06T00:00:00Z`, or without a readable date,
warns to preserve in-flight history. From that boundary it is refused.
Pre-interview versions retain their historical contract.

## Per-ask guide coverage

Rig waypoint guides carry `asks: [{ "id": "tracks", "state": "user" },
{ "id": "extent", "state": "delegated" }, …]`, naming each applicable ask
in `src/waypoints.ts`. A user entry points to the guide's existing `verbatim`
and `value`; it is a recorded interpretation, not automatic proof that prose
answers a question. A delegated entry records an explicit hand-off in those
words and uses the guide's `agent_decision`. Its free-text `covers` still names
the delegated remainder; its `value` and `reasoning` are written before approval.
Whole-guide delegations list every ask as delegated. Not-applicable waypoints
need no coverage. `states` and `transitions` apply only to `fullscreen.game_logic`; `tracks`
and `blink` apply to other rig types. Post items are outside this contract.

The independent `ASK_COVERAGE_SINCE = 2026-11-05T00:00:00Z` boundary reads the
resolved guide's own `at`, including inherited guides. An older or undated guide
with no `asks` is warned about, preserving its exit code. An explicitly recorded
list is checked regardless of age. Missing, unknown, duplicate or invalid entries
must be fixed; free-text `agent_decision.covers` alone is not per-ask coverage.


## Explicit adoption of the split interview

`interview.order: { "spec": "rig-create/stage-order@1", "adopted_at": "<clock ISO date>" }`
is the only order switch. A date does not establish which contract was used.
`init` writes this metadata. An old record keeps its old checks and gets one
`STAGE_ORDER_LEGACY` warning: its old rig guides are historical answers, never
certification that they were asked after parts. No signature, checkpoint hash
or old version is rewritten. To adopt, preserve the old rig guides whole in
that question's `history[]`, ask fresh answers against accepted parts, and
record the first human `signoff rigging-interview`. That writer records adoption
and the live parts/structure context. Stage movement remains a separate human
act, as for existing forward sign-offs. The filled legacy example is frozen in
`templates/legacy-example-project.json`. Read under the current 2.16.0 pin it warns with that order warning plus
`QUESTION_SET_STALE`, because its frozen question set remains at 2.14.1, and it is refused by the build-identity gate
(`REVIEW_PACKAGE_CONFIG_MISMATCH` and `REVIEW_PACKAGE_PARTS_MISMATCH` on v1 and v2): its versions, dated after
`BUILD_IDENTITY_SINCE`, claim configs and parts their review packages do not carry. Its bytes stay frozen.
The new `example-project.json` is a synthetic new-order narrative at 0/0.

Framing and source (`seethrough`, `assemble`) are the first interview. A
`plan-approved` signature covers only those parts steps in new-order records.
The later `rigging-interview` covers `bones`, `meshes`, `constraints`, `motion`.
Keep `phase: "rig"`; approval is resolved by step, not phase alone. Legacy
`plan-approved` retains its old all-rig-step coverage. Post approval is unchanged.
`plan.drafted_at` dates the parts plan; `plan.rigging_drafted_at` dates the later
rigging plan, so drafting it does not invalidate the earlier parts signature.
Each plan signature hashes only its covered steps. `--steps` cannot cross
approval ownership. Pending later steps/answers may remain unfilled before their
interview; production execution still requires its proper human approval.

The hand pass is the correction loop of `rig-review`, including rig and
animation inspection, described corrections and direct edits. It adds no stage
or acceptance authority. Existing `review_origin`/applied-review chains retain
producer feedback; `review_origin: null` remains legal for a first rig. A
separate choice-answer schema and correction-path union are subsequent cards.

## Labelled draft rigs and structure decisions

After assemble, `parts`/`parts-review` may use a proposed draft to inspect meshes
and refine chest structure before asking the production rigging plan. The
draft's proposed bones and weights are not the person's rigging answers.

```sh
rig-create draft-rig <id> [<dir>] --config <path> --from <output dir> [--parts <dir>] [--json]
rig-create signoff parts-review --by <who> --evidence <path> --diff-report <path> --component '<id>=<status>:<why>' --draft <id> --structure-file <path> --verbatim-file <file>
```

The recorder reads existing output; it runs no producer or review command.
It appends `drafts[]` with `{ id, kind: "draft-rig", at, producer: {name,version},
config: {path,sha256}, parts: {path,files:[{path,sha256}]}, files:[{path,sha256}] }`.
All files must resolve under `derived/drafts/<id>/`. Standalone `rig --out`
requires explicit `--parts`; only an unambiguous build root containing
`parts.json`, `parts/` and `rig/` supplies those inputs implicitly. Ambiguous
layouts, symlinks out of the root and changes to present recorded input bytes refuse.
Absent ignored draft files warn as `DRAFT_RIG_UNAVAILABLE`, including after a
clone; they do not invalidate an accepted record. Present files still verify
even when another file is absent.
These are **create-owned artifact identities**. The config/output association
is a declaration, not measured reproducibility or producer provenance. There
is no retained producer handoff file here: review constructs its own live
handoff when it opens the draft.

Drafts allocate no production version number. A declared draft, reserved draft
path or registered draft artifact cannot be reviewed, packaged or handed off
as a `versions[]` rig. A separately authorised production build gets its own
output root and numbered version. This checks declared artifact identity;
it does not claim to recognise untracked byte copies after their identity is
stripped. Identical model hashes alone are not blacklisted.

`--structure-file` retains an agent-prepared declaration snapshot approved by
the human parts sign-off, not a fabricated review export:

```json
{
  "schema": "rig-create/structure-decisions@0",
  "draft_id": "sample",
  "config": { "path": "derived/drafts/sample/config.json", "sha256": "<config hash>" },
  "entries": [ { "path": "/meshes/torso", "value": { "contour": { "regions": [] } } } ]
}
```

Each entry is the complete exact `meshes.<part>` declaration, including
`contour.bust` or `contour.regions` where present. Paths use JSON Pointer
escaping. Explicit `entries: []` is legal when no declarations are carried.
The snapshot must live outside ignored roots, such as `evidence/`; the writer
refuses paths or aliases into ignored storage. The writer hashes the retained
file and checks its config/declaration identity when the draft config is
available. A clone still checks the snapshot hash/schema and its recorded
config identity, without requiring absent regenerable draft artifacts. It
stores `draft_id` and `structure:{path,sha256}` on the parts-review sign-off.
It does not apply patches or measure geometry. The later interview reads this
human-approved snapshot instead of re-asking its structure as a guess.
`signoff rigging-interview` resolves its `accepted_parts:{signoff_at,evidence}`
and `structure` from the live human parts review and stores a shared
`interview.rigging_context`, outside the answer union. Fresh rig guides must
follow that approval and precede their rigging signature. Contradictory retained
production config declarations require renewed approval rather than a silent
override. Each production version uses the latest structure approval live at
its build date, with reopen supersession evaluated at that same date; a later
approval does not impose its declarations on old versions. Both new-order writers validate the full candidate before writing.

Mesh sign-off UI evidence from review#365 is optional in this contract, not a
shipped-capability claim or mandatory gate. Review/producer owners validate the
actual editors and mesh rendering. Create's synthetic tests prove record
binding and refusals, not the physical correctness of a chest rebuild.

The synthetic new-order record and draft declaration files reproduce with
`bun scripts/generate-example-order.ts <fresh scratch dir> --check`. The frozen
legacy record is byte-preserved; generated evidence is never hand-written.

## Correction paths: described and made

A correction lives in project-level `corrections[]`, including at `parts-review`
before a production version exists. Adopt explicitly with `correction --adopt`;
this writes `corrections_contract: {schema: "rig-create/corrections@1", adopted_at}`.
No stage or interview-order schema changes. New projects and the filled example
adopt it with an empty list. Older records get `CORRECTION_PATH_LEGACY` without
inventing corrections, rewriting dates, or changing their existing origins.

Every record has `schema: "rig-create/correction@1"`, `id`, `path`, `by`, `at`,
`verbatim`, optional text `source`, `stage`, `on`, `artifact`, `outcome` and
`resolves`. `path` is `described` or `made`. The stage is `parts-review`,
`rig-review` or `direction-review`. `on` is the source identity; `outcome:null`
means open. A closure sets outcome once and adds `closure:{by:"agent",at,reasoning}`
with create's clock. That note is an agent declaration, never a human quote or
acceptance. `resolves:null` or an earlier correction id records an append-only
replacement; the predecessor remains history and is discharged only by a
completed valid replacement.

- `described` uses `artifact:{kind:"description"}` and unchanged human words.
- A made preview uses `artifact:{kind:"config-patch",patch:{path,sha256},
  state:"preview/pending",feedback:null}`. Its raw file hash is its own identity;
  it makes no claim about review's `patchSha256`.
- A made session uses `artifact:{kind:"config-patch",state:"preview/pending",
  feedback:{file:{path,sha256},item_id}}`. The patch is the selected session
  item's `context.applied.patch`. With a bound result and passing producer
  summary, closure changes state to `applied-and-checked`. An optional retained
  preview `patch` must be parsed-deep-equal to the embedded patch. Create retains
  `applied.patchSha256` as review's claim and never recomputes it.
- Other made operations use `{kind:"unsupported",operation,reason,files,
  producer_schema}`. `operation` is `mesh-delta`, `retarget`, `keyed-animation`
  or `other`. For example, `rig-review-applied/3` is a mesh delta, not a config
  patch. Its opaque producer evidence is retained; completion stays pending.

The pinned patch is exactly `rig-review-config-patch/1` with the five keys
`schema`, `config_sha256`, `ops`, `producer:{name,version}`, `op:{cmd,args}`.
`ops` contains 1–256 add/replace `{op,path,value,name?}` or remove `{op,path,name?}`
operations, with nonempty RFC 6901 pointers and the published non-path flag
allowlist. The session is `rig-review-session/1`, the checked patch Apply is
`rig-review-applied/2` and its summary is `rig-review-check-summary/1`. Source
config, inspected model and handoff input hashes bind to the source. Summary
`pass:true`, `exitCode:0`, `gate:true`, a nonempty line and at least one `PASS`
bar are required. A named `FAIL` or a status outside parts 2.16.0's
`PASS | FAIL | SKIP | WARN | CLEAR | REPORTED | UNCLASSIFIED` set refuses.
A bar named skipped by the producer line cannot be `PASS` in the map.
Report-only SKIPs may be absent from that line. All accepted statuses remain
verbatim by name. Resolution reasoning and text output state the PASS count,
every non-PASS name/status and the retained producer line. The
outcome's retained compiled-model SHA must equal `applied.modelHash`. A built
preview or unknown/failed check cannot claim checked completion. Optional
published route/files/environment context is retained. Optional `stageInputHash`
must be a 64-lowercase-hex SHA-256, accepted as recorded; create cannot re-derive it from the package.
Summary `source` may be absent or `remesh`, `retune`, or `check`, under the same producer-summary gates. No patch application,
producer measurement, build or diff is recomputed by create.

Identities are `{kind:"rig"|"post",n,config:{path,sha256},model:{path,sha256}}`,
`{kind:"parts",manifest:{path,sha256},files:[{path,sha256}]}`, or
`{kind:"draft",id,config,parts,model}` (parts is `{manifest,files}`).
A rig binds to its version's provenance config and frozen review package model.
A post binds config to `provenance.config`, and model to one declared retained
output explicitly selected by `--model-file`; it is output identity only,
without a parts, rig or CG claim. `config-patch/1` is rig/draft-only: a direct
post edit is unsupported. A described post closure requires changed output bytes.
Parts identities retain a complete sorted parts.json + parts/ file inventory.
Draft identities match the labelled draft inventory, including a retained
compiled model when that reviewed identity is selected. Missing regenerable
files never count as correction completion: retain source and result bytes.
Paths must be literal project-relative regular files without symlink traversal;
patch/session evidence belongs in tracked evidence. Outputs and draft files
must survive handoff/clone when used to close a correction.

An ordinary correction may name the historical version actually inspected.
An explicit `resolves` replacement must name the latest source at its capture
time; a future source timestamp always refuses.

A result must be distinct, later and changed. Version and draft times bind the
ordering; for raw parts, create's later closure records the declared response
and changed inventory without inventing a producer timestamp. A rig-version
made result retains the existing matching `review_origin` chain, including its
immediate-predecessor constraint. A first rig may still have `review_origin:null`;
no fake preceding rig is made for stage-1 corrections. `on_items` still names
interview answers and `answers_feedback` still links verdicts; neither is an
operation inventory. A correction does not supply a missing guide citation.

```sh
rig-create correction --adopt <dir>
rig-create correction record <dir> --id refine --path described --stage rig-review \
  --version 1 --by reviewer --verbatim-file words.txt
rig-create correction record <dir> --id tune --path made --stage rig-review \
  --version 1 --by user --patch-file evidence/patch.json --verbatim-file words.txt
rig-create correction record <dir> --id applied --path made --stage rig-review \
  --version 1 --by user --feedback-file evidence/session.json --item change-1
rig-create correction resolve tune <dir> --version 2 --by agent --reasoning-file reasoning.txt \
  --applied-feedback evidence/session.json --feedback-id change-1
```

Use `--draft <id>` or `--parts-file <retained parts identity JSON>` instead of
`--version`; post versions require `--model-file`. `--resolves <id>` appends a
replacement. A made record requires `--by user`; its clock is create's ingest
time. A session item supplies its exact summary as verbatim, otherwise use
`--verbatim-file`. Review does not invoke create or write project.json. There
is no new review correction-export schema and no `--correction-file`.
Record, resolve and check share validation; writes use a same-directory temporary
file and atomic rename. Refusals leave project.json byte-identical. Unrelated
pre-existing interview holes do not prevent capture, but a writer cannot add a
new refusal or bypass correction validation.

Stage-1 corrections use parts/drafts outside versions. The parts-review signoff
must approve the corrected draft and structure snapshot (or a draft using the
corrected parts inventory). Production versions still compare mesh declarations
to that snapshot. Structure changes after approval require the existing reopen
and fresh snapshot, never a correction override.

A valid reopen supersedes the same stage suffix as signoffs: entries at or
before its epoch remain history. A narrower later reopen cannot resurrect an
earlier suffix. Recording under a live scoped approval requires reopening first;
corrections do not move stages or sign plan steps themselves.

| State | check | approval / handoff | reopen | provenance | structure | CG |
| --- | --- | --- | --- | --- | --- | --- |
| described-open | pending/WARN | pending; attempted approval refuses | pass history | pending response, no citation authority | pass existing checks | pass existing checks |
| described-linked | pass declared linkage | pass correction gate only | pass history | pass linkage, citations still required | pass if snapshot matches, else refuse | pass if ordinary gates pass, else refuse |
| made preview/pending | pending/WARN | pending; attempted approval refuses | pass history | pending | pass current snapshot only | pass current config only |
| made applied-and-checked | pass exact result binding | pass correction gate only | pass history | pass linkage, not a replacement citation | pass if snapshot matches | pass if ordinary gates pass |
| invalid checked claim | refuse | refuse | no authority | refuse claimed linkage | mismatch refuses | no fabricated gate pass |
| unsupported | pending/WARN | pending; attempted approval refuses | pass history | pending opaque evidence | pass existing checks | pass existing checks |
| stage-1 parts/draft overlay | pass retained identity; absent closure bytes refuse | pending until corrected draft/parts is approved | parts-review suffix | identity only | pass approved corrected snapshot | pass / not applicable to parts |
| rig-version overlay | pass source/result hashes | pending until correction and normal review complete | rig-review suffix | existing citations required | existing snapshot comparison | normal gates required |
| direction-review post overlay | pass retained declared output | pending until changed output and normal review complete | direction-review suffix | post citations still required | no new rig claim | no new CG claim |
| validly superseded overlay | pass history validation | pass exclusion from current obligations | pass only for valid human reopen | historical only | historical context | existing historical gates remain |

The overlays combine with path state; refuse overrides pending, which overrides
pass. A pass never waives existing gates or manufactures acceptance.

The small consumer fixture is `tests/fixtures/correction-path/`, generated through
writers by `scripts/generate-correction-fixture.ts <fresh dir> [--check]` before
full-example integration. Its checked positive is explicitly **synthetic
shape-only**, not a measured producer-gate result; see its README. Every retained
file uses its real byte hash. The frozen legacy example's exact warning set is
`QUESTION_SET_STALE`, `STAGE_ORDER_LEGACY`, `CHOICE_ANSWERS_LEGACY`,
`CORRECTION_PATH_LEGACY`, and it is refused by the build-identity gate as described
above; the current filled example stays at 0/0.

### Authored camera direction (create#92)

Create owns the authored camera and timing document, not depth or `config.turn`.
Review previews through the published `@rig-c/play` runtime (review README,
*delivery flow*); create renders nothing. A document is authored data, not proof
of a rendered take, seamless looping, source-animation extent, or a parts gate.

Adopt with `rig-create direction --adopt <dir>`. It writes
`direction_contract:{schema:"rig-create/direction-contract@1",adopted_at,
grandfathered_posts}`. The sorted, unique post numbers are existing posts at
adoption. They remain exempt from a missing direction document; explicit
bindings are always checked. There is no date switch and no new legacy warning.
Do not change that list to exempt new work. Existing correction@1 records are
not migrated or rewritten.

```sh
rig-create direction write 5 <dir> --file evidence/authored-direction.json --rig 2
rig-create direction check 5 <dir> --json
```

The writer registers a new post version and never overwrites a previous one.
The exact input bytes become `evidence/direction/v5.json`, schema
`rig-create/direction@1`. `provenance.config`, `provenance.direction`, and one
`outputs[]` entry all bind that same `{path,sha256}`. It is a direction output,
not a compiled model or movie. `provenance.sections.camera` and `.timing` carry
the same citations as the document. Metadata, rig bindings and citations are
not additional executable config sections. Setup-painting requirements apply
to existing build configs as before, not to this camera document.

The closed document has precisely:

| Field | Closed contents |
| --- | --- |
| `schema` | `rig-create/direction@1` |
| `rig` | `{version,model:{path,sha256}}`; accepted rig's review-package compiled model, never config-only identity |
| `take` | `{duration,loop}`; positive finite seconds and boolean |
| `camera` | `{space:"rig-world-y-up",keys:[{time,box:{x,y,width,height},easing}]}` |
| `timing` | `{keys:[{time,source_time,easing}]}` |
| `citations` | `{camera,timing}`; each `{guide,asks,quote}` or `{guide,asks,delegated:true}` |

The model path is
`derived/review/v<R>/out/check/build/skeleton.model.json`; its exact bytes must
match the corresponding review-package inventory SHA. A new write needs the
latest live accepted rig and existing handoff still/signature gates. Missing
model bytes refuse; create never regenerates them. A post's `rig_version` must
match `rig.version`. Historical documents may retain their historical rig;
current authoring and direction approval cannot use a superseded rig.

Boxes describe the visible rectangle in rig world coordinates, Y up. Coordinates
are finite and sizes positive. A preview contains the box at its aspect ratio
(letterbox; do not silently crop). Camera keys number 1–256, start at zero,
strictly increase and stay in `[0,duration]`; the final box holds through the
end. Timing keys number 2–256, start at zero and end at `duration`; their take
times strictly increase, while finite nonnegative `source_time` is nondecreasing
and permits holds. It maps take seconds to source-animation seconds, without
FPS inference or a source-clip-duration claim. `loop` repeats the take clock.

Easing is exactly `linear`, `hold`, or `smoothstep`, attached to the segment
starting at the key. `smoothstep(u)=u*u*(3-2*u)` with normalized segment time;
interpolate box components/source time with that factor. The final key's easing
has no effect. No arbitrary easing, pan/zoom alternative, audio, depth, tilt,
turn, frame-index inference or extension fields exist in @1.

Citations name the actual questions `camera_depth` and `post_timing`, each with
`asks:[guide]`. `camera` and `timing` are executable plan step ids, not question
ids. Quotes are exact stored verbatim/additions fragments, including historical
or inherited answers; delegation uses the existing decided-delegation rules.
A new write additionally requires a live post-interview approval covering both
steps with matching `step_hashes`, and resolved current per-ask selections.
Pending auto/Other responses cannot produce a document. A camera marked not
applicable can supply a single fixed-box key only when its retained verbatim
is cited and the approved post plan still supplies camera/timing; timing must
be applicable. All-post-not-applicable skips post entirely. Prose is never
parsed into authored key values.

Writers validate the prospective record and every owned finding before writing,
retain unrelated pre-existing holes by code/path multiset, and reject concurrent
source changes. Documents are immutable; `project.json` is the commit point.
A lock, staged files, snapshot rechecks and rollback protect a failed publish.
This is not an atomic multi-file filesystem transaction. A refused write leaves
the record and previously published artifacts byte-identical. Source documents
and patches are literal retained POSIX paths below the selected project, without
symlinks, traversal or ignored roots. Only the explicitly bound compiled-model
path above is allowed in regenerable `derived/`. Clone it when using this gate.

### Review reads; create ingests direction patches

Review receives a user-designated project root and post number `N`. It reads
that version's `provenance.direction`, then exactly
`evidence/direction/v<N>.json` as `rig-create/direction@1`, validating raw SHA,
version/path binding and rig model SHA. `readDirection(dir,project,N)` is the
create reader; `direction check N --json` exposes a checked read. Review never
writes `project.json` or invokes create. Review 1.6.0 has no authored camera
consumer; review#373 consumes this contract after it lands. No camera Apply
capability is claimed for that installation.

Review's output is a closed `rig-review-direction-patch/1` file with exactly
`{schema,source_post,rig_model_sha256,direction_sha256,replace}`. `replace` holds
one or more of `camera`, `timing`, `take`, replacing whole typed sections only.
The source is the current post, and both base hashes must match. Unknown keys,
arbitrary pointers and a semantic no-op refuse. Binding/citation changes need
new answer/authoring work, not a patch. The patch's own identity is the raw hash
of its retained bytes, not a review canonicalization claim.

```sh
rig-create correction record <dir> --id framing --path made --stage direction-review \
  --version 5 --direction-patch-file evidence/direction-patch.json \
  --by user --verbatim-file correction-words.txt
rig-create direction patch 6 <dir> --patch-file evidence/direction-patch.json
rig-create correction resolve framing <dir> --version 6 --by agent \
  --reasoning-file resolution.txt
```

The patch writer creates a later immutable document/post and records
`direction_origin:{source_post,patch:{path,sha256},result:{path,sha256}}` on the
version. Capture retains the human words separately; no words are invented from
the patch. Review may label export plus create ingestion “Apply”, but cannot
claim ingestion or checked completion itself. `rig-review-applied/2` is never
used as a direction result or proof.

Only `direction-patch` uses `rig-create/correction@2`. All other correction
records remain `rig-create/correction@1`, with the existing description,
config-patch and unsupported grammar/behavior. The new exact artifact is
`{kind:"direction-patch",patch:{path,sha256},state:"preview/pending"|
"applied-and-checked",result:null|{path,sha256}}`. Its exact post source/outcome
identity is `{kind:"post",n,config,model,direction:{path,sha256}}`; config binds
the direction file, model binds the source rig's compiled model, and direction
matches `provenance.direction`. This identity is not accepted by @1.

A pending record has no outcome/result and cannot approve. On agent resolution,
create checks its own patch/base/result and `direction_origin`, not an external
producer report. The outcome is a later post on exactly the same rig model,
with changed direction bytes and the typed replacements actually present. Only
this post→post direction-patch variant accepts changed direction with unchanged
rig model. Same-document, cross-kind, changed-rig or unrelated authored output
pairs refuse. Existing @1 described corrections still require changed declared
output; a direction file can be explicitly selected as that output without
claiming it is a compiled model. Unsupported operations remain pending.

`checkProject`, direction signoff and the acceptance writer all check the
relevant document. Handoff stays rig-only to bootstrap authoring. Review-package
stays rig-only and cannot rebind a model already cited by a direction document.
Reopen rules, historical evidence, human signoff and agent closure remain
separate gates.

The generated synthetic example is `templates/example-direction/`, including a
small staged project, exact input/result documents, a review-format patch and
@2 correction. It uses invented sentences shaped like a pilot interview, not
pilot words or assets. Reproduce with
`bun scripts/generate-direction-fixture.ts <fresh-dir> --check`. It demonstrates
writer/contract behavior, not a rendered take or upstream producer gate; the
main filled project remains the separate zero-refusal/zero-warning example.

## Advisory intake reports

`project.intake` is optional (`spec: "rig-create/intake@1"`). In `parts`, after
a full run exists, retain the parts `head-crop-preflight` JSON and record it:

```sh
rig-create intake-report . --id crop-1 --report evidence/preflight.json --sha256 <raw-sha256> --parts-version 2.16.0 --by agent
rig-create intake .
```

This reads producer bytes and never runs a producer or verifies its pixels.
`reports[]` is append-only. Each entry keeps its id, by/at, a report binding
(path, raw sha256, spec, head_box, source_canvas, run_canvas), `measurement`
(the report's own fields copied exactly), `prediction` (`hit` or `no-hit`),
and the declared `parts_version`. Version is outside the authenticated v1
report, which does not emit a version. Correct a report with a new retained
path/id and `--supersedes <earlier-id>`; do not replace its bytes or history.
The writer validates before writing and leaves project bytes unchanged on
invalid input. Copied fields are checked against the bound report, never
against a fresh computation.

A HIT is any reported `layers[].sides.top_px`, `left_px` or `right_px` > 0.
Keep the per-tag counts, including zero rows and separate `bottom_px`.
Corners count on two sides; summed edges are incidences, not unique pixels.
Preflight counts native full-run alpha > 8 **before ghost cleanup** and
retains registration and canvas identity. `ASSEMBLE_CROP_CLIPPED` counts
alpha ≥ 128 **after ghost cleanup**; it is a separate instrument. Never
compare or substitute their numbers. Intake only stores the preflight
instrument; downstream outcome labels stay in evidence receipts, not an
in-project label ledger. Missing labels remain unknown, never negative.

Everything about persisted intake is advisory: HIT, absent choice, malformed
record or unavailable report bytes cannot refuse signoff, acceptance or
handoff. A retrospective over three pilots fired on all three; only one had
a labelled positive and none a labelled negative. This shows firing, not
ability to discriminate. The threshold stays > 0; it is not an approval gate.
The filled example does not adopt intake and keeps zero warnings.

Colour-adjacent ground and ground enclosed between strands are
**known-not-predicted** notes in the guide/intake output only (two rounds of
a model sweep on a pilot did not separate them), with no threshold or warning.
Silhouette stepping, source-vs-final alpha classes, patchwork runs and
versioned dark retention need post-assemble outputs and are excluded.
