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

`interview` → `plan-approved` → `parts` → `parts-review` → `rigging` →
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
| `interview` | 1 | Framing answers and a guide at every rig waypoint the plan passes ([INTERVIEW.md](INTERVIEW.md)): the user's sentences, a delegation ("auto"), or not applicable — never left for the agent to fill. | The user signs `{ "stage": "interview" }`. |
| `plan-approved` | 1 | The rig steps (`phase: "rig"`) are drafted from the guides, with the agent's decision written on every delegated item. The user sets each step's checkpoint and signs. | `{ "stage": "plan-approved" }`. |
| `parts` | 1 | The rig steps that make the parts run: `seethrough` and `assemble`. At a step whose checkpoint is on, work stops until `{ "stage": "parts", "checkpoint": "<step id>" }` is signed (the split, [below](#split-approval-is-a-plan-checkpoint)). No bone, mesh or constraint is built. | Every step it runs is `done`, `assemble`'s bar including the parts check passing on the assembled parts. |
| `parts-review` | 1 | **The parts are reviewed before any rig is built** ([below](#the-parts-are-reviewed-before-rigging)): the user looks at the assembled parts in rig-review's parts view. A bounce is fixed here, in `parts`. | `{ "stage": "parts-review" }`, signed by a person, carrying the approved parts verdict as `evidence`. |
| `rigging` | 1 | The remaining rig steps run in order (`bones`, `meshes`, `constraints`, `motion`); each config section cites its guide (`versions[].provenance`). At a step whose checkpoint is on, work stops until `{ "stage": "rigging", "checkpoint": "<step id>" }` is signed. It does not start without the `parts-review` sign-off (`PARTS_REVIEW_UNSIGNED`), nor on a verdict that is missing, not approved or no longer the parts on disk (`PARTS_VERDICT_*`). | The last rig step's bar is met. |
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
  `rig-review-parts-verdict/1` schema in `parts` mode (an `atlas` verdict is
  informational and never gates), its `status` is `approved`, and every file
  in its `source.files[]` is on disk with the bytes and sha256 it was reviewed
  with. A part added, removed or repainted after the sign-off is a new review:
  the user reviews again and signs again, with the new verdict as evidence.
  The latest `parts-review` sign-off is the one read. **The parts themselves
  must be on disk to rig**: on a fresh clone, re-assemble them before rigging
  continues. The verdict gates rigging only until a rig version is accepted at
  `rig-review`: from then on it is not read, and a part changed after that is a
  new rig version, refused as `RIG_VERSION_UNACCEPTED` until it is reviewed.
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
  that rests on it back for a new `plan-approved` sign-off before it runs.
- **Provenance**: each version built from a config records, per config
  section, the guide sentence or delegation each entry follows
  (`versions[].provenance`, [INTERVIEW.md § Provenance](INTERVIEW.md#provenance-every-config-section-cites-its-guide)).
  An entry with no citation is removed or cited before the version is shown.

## Recording a sign-off

```sh
rig-create signoff <stage> --by <who> [--steps <id,id,...>] [--verbatim-file <file>] [<project dir>] [--json]
```

The command appends `signoffs[]` and leaves `project.stage` unchanged. `at`
comes from the clock. There is no `--at` option. The user's UTF-8 words come
from the file, or stdin when omitted or `-`, preserving BOM, spaces, CRLFs and
final newlines. Invalid UTF-8 is refused because a JSON string cannot retain
its original bytes.

For `plan-approved`, coverage is every rig step. For `post-interview`, it is
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

Only `plan-approved` and `post-interview` accept `--steps`. Stage movement
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

Every build shown to anyone is a `versions[]` entry, numbered in order across
both kinds:

| Field | Holds |
| --- | --- |
| `n` | the version number, `1, 2, …` |
| `kind` | `rig` or `post` |
| `rig_version` | for a post version, the `n` of the accepted rig it is built on (accepted before the post version's `at`); `null` for a rig version |
| `at`, `built_by`, `built_with` | when, which agent or tool, and the package versions used (`{ "@rig-c/parts": "…", "@rig-c/core": "…" }`) |
| `answers_feedback` | the verdicts this version answers: `[{ "version", "verdict" }]` (version number and index into its `verdicts[]`); empty for a first version |
| `changed` | what changed from the previous version of the same kind, in a sentence |
| `outputs` | `outputs/v<N>/` files with sha256 and size, frozen when shown |
| `evidence` | `evidence/v<N>/` files with sha256 and what each shows; on a rig version accepted at `rig-review`, one is the still-frame record (`kind: "still"`, `camera: "fixed"`, `frame`) |
| `provenance` | the config this version was built from and, per section, its citations |
| `verdicts` | what people said: `by`, `at`, `review`, `verdict` (`accepted`, `bounced`, `provisional`), `verbatim`, `source`, `on_items[]` |

`provisional` is a verdict given before the person has seen everything they
want to see — it holds a place and is replaced, never a basis for moving a
stage.

## The record, field by field

Top-level fields of `project.json`:

| Field | Holds |
| --- | --- |
| `schema` | `rig-create/project@0` |
| `name` | the folder name; a short identifier |
| `title` | the human title of the painting or rig |
| `stage`, `stage_values` | the current stage and the list it comes from |
| `signoffs[]` | every human signature: `stage`, `checkpoint` (step id or `null`), `by`, `at`, `verbatim`; plan signatures add `steps[]` naming covered steps and `step_hashes` binding their approval fields |
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
