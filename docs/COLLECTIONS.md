# Collections

Several rigs that belong together — characters cut from one group painting,
wearing one outfit set, sharing a pose, composed into one lineup — are a
**collection**. Shared direction is given once and inherited; a member answers
only what differs; one reference member goes first and sets the direction for
the rest; composition belongs to the collection; and a collection version pins
the exact member builds it was made from. The empty skeleton is
[../templates/collection.json](../templates/collection.json) with
[../templates/shared/conventions.json](../templates/shared/conventions.json);
the schema is `rig-create/collection@0`, v0 like a project's
([PROJECT.md](PROJECT.md)).

## Layout

```
<collection>/
  collection.json      shared interview, member order, cross bars, composition, pins
  AGENTS.md            the collection's agent guide; CLAUDE.md imports it
  package.json         the rig-c packages, pinned once for every member
  shared/
    conventions.json   conventions every member follows
  members/<name>/      an ordinary project (the layout in PROJECT.md), without package.json or .git
  inputs/              the group painting, shared references
    references/
  evidence/v<N>/       what a collection verdict rested on
  derived/             regenerable (ignored by git)
  outputs/v<N>/        lineup, outfit-switch takes (ignored by git)
  scratch/             (ignored by git)
```

### Making one

```
rig-create init --collection <dir> [--no-install]
rig-create init --member <collection dir> <name>
```

`init --collection` writes the layout above: `collection.json` and
`shared/conventions.json` from the templates, both named after the folder, a
`.gitignore` for the untracked folders, the `package.json` pins, the install
(unless skipped), the agent guide, and a first commit of exactly those files.
**The collection is one git repository.** A collection version pins member
builds, so the collection's history has to hold the member records it pins; a
member with a repository of its own would be an opaque gitlink to it.

`init --member` takes the collection folder and a **name**, not a path: it
derives `members/<name>/`, so a member cannot be made outside `members/`, and a
folder that is not a collection is refused (`INIT_NOT_A_COLLECTION`) before
anything is written. It writes an ordinary project there (`project.json`,
`.gitignore`, `inputs/references/`, `evidence/`, the ignored folders, the
agent guide, its doc links pointing at the collection's install), registers it
in `collection.json` `members[]` (`{ name, project, input: null, note: null }`),
and commits exactly those files and `collection.json` in the collection's
repository. It has **no `package.json` and no repository of its own**: the
collection pins the packages once, so every member is built with the same
versions and a cross bar measures one toolchain; `interview --check` in a
member reads the collection's install.

Every framing answer, waypoint guide and post item guide the collection gave
starts in the member as an `inherited` reference (below), written with
`"by": "rig-create"`. Where the collection's answer is `null` or `"per-member"`,
the member's starts `null`: the member's own question, asked in its interview.
Refused by name: a duplicate (`INIT_MEMBER_EXISTS`, in `members[]` or as a
folder), a name that is not one folder name (`INIT_MEMBER_NAME_INVALID`), a
collection with no `name` (`INIT_COLLECTION_UNNAMED`), and a `collection.json`
with uncommitted changes (`INIT_COLLECTION_DIRTY`), so the member's commit never
carries someone else's edit. Outside a git work tree the files are written and
nothing is committed.

### Members live inside the collection

`members/<name>/project.json`, not top-level projects referenced by name. A
member's input is cut from the collection's painting and its interview inherits
the collection's answers, so it has exactly one parent; a top-level project that
two collections referenced would inherit two answers to the same question. A
character wanted somewhere else is a new project, which may point at this one.
The folder path is the membership record, so `project.json` needs no
back-pointer and keeps its shape.

## What the collection owns

| Field | Holds |
| --- | --- |
| `interview.questions[]` | Questions with `scope: "collection"`, answered here only (`id`, `scope`, `text`, `source`, `answer`, `history[]`): `members`, `reference_member`, `style`, `outfits`, `composition`. Same answer shape as [INTERVIEW.md](INTERVIEW.md#answer-shape). |
| `interview.framing[]`, `interview.waypoints[]`, `interview.post` | The INTERVIEW.md guides, given **once** for every member. An answer whose `value` is `"per-member"` leaves that guide to each member. |
| `plan.order[]` | One entry per phase (`phase`, `members[]`, `runs`: `alone` or `parallel`, `rests_on[]`, `ends_with`). Phase 1: the **reference member** goes alone through its own `interview` → `rig-review`. Phase 2: the rest, in parallel once their interviews are signed — a member's own interview still runs one at a time, because an interview needs the user's full attention and parallel interviews produce contradicting answers. |
| `plan.cross_bars[]` | Bars measured across members, e.g. *the shared pose plays exactly on every member in every outfit*. Each names the answers it rests on (`rests_on`), which members and variants it covers, and the `receipt` that measured it. |
| `plan.steps[]` | Composition steps — post-production at collection level — same shape as a project's post steps ([PROJECT.md § The plan](PROJECT.md#the-plan)). |
| `members[]` | `name`, `project` (path to its `project.json`), `input` (where its painting comes from: its own file, or a crop of the shared one), `note`. |
| `shared` | Path to `shared/conventions.json`: the variant (outfit) set, shared motion, shared pose, bone naming — what every member follows. It points at files by path rather than copying them. |
| `composition` | `lineup`, `layers[]` (who overlaps whom), `outputs_wanted[]`. **Composition belongs to the collection, never to a member**: a member's project does not hold a lineup or a group take, so a lineup cannot drift between two members' records. |
| `inputs[]`, `derived[]`, `archive`, `notes[]` | As in a project. |
| `versions[]` | Collection versions, each with `pins` (below), `composition_inputs`, `outputs`, `evidence`, `verdicts`, `changed`, `answers_feedback`. |
| `signoffs[]`, `stage`, `stage_values` | As in a project, with the collection's stages (below). |

### Deferring a collection question

Only `interview.questions[]` entries with `scope: "collection"` may be
explicitly deferred. Record the person's or delegate's decision with
`rig-create collection answer composition <dir> --by <who> --defer-until post-interview --reason-file <file>`.
File paths are relative to the collection folder, or absolute. The reason
file supplies nonblank text unchanged. The writer records
`{ "deferred": { "by": "…", "at": "…", "reason": "…", "until_stage": "post-interview" } }`
as the question's `answer`, with `at` set from the clock. `until_stage` must
be an ordered collection lifecycle stage strictly later than the effective
current stage. `paused` is excluded as a deadline. A paused collection uses
its effective stage, as the collection check already does.

Before the deadline the check emits `COLLECTION_ANSWER_DEFERRED`, preserving
its exit status. At the deadline it refuses `INTERVIEW_INCOMPLETE`, and past
it `COLLECTION_ITEM_SILENT`. Resolve the deferral with
`rig-create collection answer composition <dir> --by <who> --value-file <file>`.
That file contains an ordinary answer object in the
[interview answer shape](INTERVIEW.md#answer-shape), including `verbatim`
and `value` for a user answer. The writer sets its `by` and `at`. Both forms
validate the candidate with the collection record check before writing;
unrelated pre-existing refusals may remain. Refused writes leave the bytes
unchanged. The previous non-null answer moves into the question's `history[]`
when that array exists, including when an ordinary answer replaces a
deferral. Without a history array it is simply replaced. All bytes outside
the answer and history values remain unchanged.

A deferral supplies no inherited value. New members start with a null answer
where a shared answer is deferred, and an existing inherited reference to a
deferred answer resolves as silence. Member-local deferrals and deferrals on
framing, waypoint or post guides refuse `ANSWER_MALFORMED`. Their existing
stage gates remain the way post items wait for their interview.

### `shared/conventions.json`

| Field | Holds |
| --- | --- |
| `schema` | `rig-create/conventions@0` |
| `collection` | the collection's `name` |
| `variants` | `values[]` (outfit or other variant names), `source` (the answer they come from), `what_changes`, `what_stays` |
| `shared_motion` | `source` (which member's or file's motion every member plays), `note` |
| `shared_pose` | `what` (the pose every member shares), `receipts[]` (the measurements that showed it plays on each) |
| `bone_naming` | `declared` (the naming rule), `observed` (what the builds actually use, if it differs) |
| `notes[]` | free text |

## Inherited, overridden, own

A member answers the same questions as any project, and every one of its
answers carries a `basis`:

| `basis` | Meaning | Shape |
| --- | --- | --- |
| `inherited` | The collection's answer applies unchanged. The value is **not copied**: it is read from the collection, so a later change to the collection answer reaches the member. | `{ "basis": "inherited", "from": { "collection": "<name>", "question": "<id>" }, "by": "interviewer", "at": "…" }` |
| `overridden` | The collection answered, and this member differs. A user answer (or a delegation) plus what it overrides and the user's reason. | the user-answer or delegated shape, plus `"basis": "overridden"`, `"overrides": { "collection", "question", "collection_answer_at" }`, `"why_verbatim"` |
| `own` | The collection did not answer it, or answered `"per-member"`. An ordinary answer. | the user-answer, delegated or not-applicable shape, plus `"basis": "own"` |

An inherited answer is a reference, not a copy:

```json
{ "basis": "inherited", "from": { "collection": "harbour", "question": "motion" },
  "by": "interviewer", "at": "2026-11-12T10:00:00Z" }
```

An override keeps what it overrides and why, so a later reader sees why one
member differs:

```json
{ "basis": "overridden",
  "overrides": { "collection": "harbour", "question": "constraints", "collection_answer_at": "2026-11-11T15:00:00Z" },
  "delegated": false, "by": "user", "at": "2026-11-12T10:04:00Z",
  "verbatim": "Put physics on her skirt.",
  "why_verbatim": "Hers is long; the others are short.",
  "value": [{ "part": "bottomwear", "effect": "physics" }] }
```

An inherited answer is resolved before use: if the collection's answer is
delegated, the member inherits the delegation and the agent's decision with it,
and a bounce on it is attributed to the collection's answer as delegated. An
override is the record of why one member differs; it is never written to make a
member match what the agent already built.

### Recording a member override

`interview-answer` replaces an inherited answer locally. If `classify()`
resolves the shared answer as silent (withdrawn to `null`, or a user answer
of `"per-member"`), it records `basis: "own"` with no `overrides` and no
required `--why-file`. A shared delegation remains shared, as classified,
even when its agent decision says `"per-member"`. These cases are exercised
through the writer and member check in `tests/choices.test.ts`.

When a shared answer still applies, the writer records `basis: "overridden"`.
Supply `--why-file <file>` with either the ordinary
pick flags or `--picks-file`; the picks payload schema stays unchanged. The
file must contain nonblank UTF-8. Its exact text, including spaces and
newlines, becomes `why_verbatim`; a note, an option label or agent reasoning
is not a substitute. A fresh replacement of an overridden answer requires a
fresh reason file too. Missing, blank or unreadable reasons refuse before
writing, leaving `project.json` byte-identical.

The writer fills `overrides` from the inherited collection reference and the
resolved answer's `at`. When replacing an override it preserves that original
reference. A legacy overridden answer without `overrides` recovers its
reference from the most recent inherited record in the item's `history[]`,
using the same collection-answer lookup as a fresh override. It retains
earlier local answers in history and never changes the parent collection.
These writer paths are covered by `tests/choices.test.ts`.

The member check validates overrides in current answers and `history[]`:
`overrides.collection` names the parent collection, `overrides.question`
names a question it answered, and `collection_answer_at` exactly matches a
current or historical answer's `at`. A later collection answer does not
invalidate a reference whose source remains in history. Every override needs
nonblank `why_verbatim`. These checks also run before an override write.
`OVERRIDDEN_ANSWERS_SINCE = 2026-11-06T00:00:00Z` dates the contract by the
member answer's own `at`: earlier invalid records WARN; records on or after
that date, or without a readable date, refuse. The checks and date boundary
are covered by `tests/overrides.test.ts`; codes are in [CHECKS.md](CHECKS.md#refusals).

## Collection stages

`interview` → `plan-approved` → `reference` → `members` → `post-interview` →
`post` → `direction-review` → `accepted`, plus `paused`. Same rule as a
project: a stage moves only on a human `signoffs[]` entry. User step 1 (base
motion) runs in each member; the collection's own steps 2 and 3 are its
composition.

| Stage | User step | What happens | Ends with |
| --- | --- | --- | --- |
| `interview` | 1 | The collection questions and the shared guides are answered. | The user signs `{ "stage": "interview" }`. |
| `plan-approved` | 1 | Order and cross bars are drafted and signed. | `{ "stage": "plan-approved" }`. |
| `reference` | 1 | The reference member runs its own stages through `rig-review`. | The user signs `{ "stage": "reference" }`: *this is the direction for the rest*. Separate from the member's own acceptance, because accepting one rig is not agreeing it sets everyone's direction. |
| `members` | 1 | The other members run through `rig-review`, in parallel once their interviews are signed. | Every member's rig accepted; every cross bar met. |
| `post-interview` | 2 | Composition guides — lineup, overlaps, camera, timing — and the composition steps. | `{ "stage": "post-interview" }`. |
| `post` | 2 | Lineup, layers, collection outputs, each frozen as a collection version with its pins. | The composition steps' bars are met. |
| `direction-review` | 2 → 3 | The user reviews one collection version. Feedback on one member's rig goes back to that member's waypoints (`on_items[].member` names it). | The user accepts it. |
| `accepted` | — | Done. | — |
| `paused` | — | Stopped by a human sign-off. | — |

## Pins: a member change never silently changes a collection output

A collection version pins its members like a lockfile. Each pin names the
member's version **and** the content hashes of every rig it used (model, atlas,
config, per variant):

```json
"pins": [
  { "member": "keeper", "version": 2, "rigs": [
      { "variant": "default", "files": [
          { "role": "model", "path": "outputs/v2/skeleton.json", "sha256": "…" },
          { "role": "atlas", "path": "outputs/v2/atlas.atlas", "sha256": "…" },
          { "role": "atlas", "path": "outputs/v2/atlas.png", "sha256": "…" },
          { "role": "config", "path": "derived/v2/config.json", "sha256": "…" } ] },
      { "variant": "winter", "files": [ … ] } ] }
]
```

A rig is a list of files, not one hash per role: an atlas is its `.atlas` text
and one or more page images, and one `atlas_sha256` cannot pin them. Paths are
relative to the member's folder.

The hashes bind the build named by a pin. An explicitly selected member
version remains locked when newer member builds are recorded. A default pin
keeps the latest-build check described below. A collection output whose
recorded sources do not hash to its pins is stale and is not shown.

Where a member has no `versions[]` yet (work that predates this structure), the
pin carries `"version": null` and the hashes alone, and says so in `note`.

### Recording a collection version

```
rig-create collection pin [<dir>] [--changed <sentence>] [--member <name>=<version>]...
```

Run when a collection output is made: put it in `outputs/v<N>/` (`N` the next
collection version), then pin. It appends `versions[]` entry `N` to
`collection.json` with `pins`, the sha256 and size of every file under
`outputs/v<N>/`, `changed`, and empty `composition_inputs`, `evidence`,
`verdicts` and `answers_feedback` to fill. It writes, it does not commit.

Repeat `--member <name>=<version>` to select an existing rig version by its
positive integer `n`, for example `--member first=1 --member second=2`.
A name may appear only once and must be in `members[]`; malformed selectors,
unknown members and absent or non-rig versions refuse with
`PIN_SELECTION_INVALID`, before any write. Unspecified members use their
**latest rig version** (`kind: "rig"` or no kind, highest `n`). Only explicitly
selected pins carry `"selection": "explicit"`. The writer-generated
`tests/fixtures/collection-pin.json` locks one earlier build and leaves one
member at latest; `bun scripts/generate-collection-pin-fixture.ts <fresh dir> --check` reproduces it. `tests/collection-pin-select.test.ts` covers selection,
byte-identical refusals and every pinned hash across variants.

The rig files are read from the selected/default version: each `outputs[]` entry that is
a model (`.json`, `.skel`) or an atlas (`.atlas`, page images), or that names
its own `role`; and `provenance.config`, for every variant. An output names its
variant with `variant` (default `default`); a take or a contact sheet is not a
rig file and is not pinned. Every file present on disk is hashed there.
Refused by member name, all at once and nothing written: a member with no
project record (`MEMBER_PROJECT_MISSING`), no rig version or no rig file
(`PIN_NO_BUILD`), and a file on disk that no longer hashes to the version that
lists it (`PIN_SOURCE_DRIFT`) — it was rebuilt in place; record a new member
version first, so the pin names a build that exists.

### The pin check

```
rig-create collection --check [<dir>] [--json]
rig-create interview --check <collection dir | collection.json>
```

Both run the same check. The pins checked are those of the **latest collection
version that has outputs** — the one a person would be shown; a version pinned
before its output exists is not checked yet. Every member in `members[]` is
compared with its pin according to its selection mode:

| Pin mode | Version compared | A newer member version alone |
| --- | --- | --- |
| Default, no `selection` | Latest rig version, which must match the recorded pin version | `PIN_STALE`; make and pin a new collection output |
| Explicit lockfile, `"selection": "explicit"` | The recorded rig version `n` | No change; the lock remains valid |
| Legacy, `"version": null`, no `selection` | Hashes alone while the member has no rig versions | `PIN_STALE` when a rig version appears |

Existing default and legacy behavior is retained (`tests/collections.test.ts`).
Explicit locks refuse when the recorded version disappears, its file list or
variant changes, or its recorded/present-on-disk hashes differ from the pin
(`tests/collection-pin-select.test.ts`). Each difference names the member:

- `PIN_STALE members[<name>]`: a default pin's latest rig version is not the
  pinned one, or an explicit pin's recorded rig version is absent; a pinned file's sha256 (on disk where present, else as recorded)
  differs from the pin; a pinned file is no longer listed; a rig file of the
  version is not pinned. For a `"version": null` pin, a member that now has
  versions, or a pinned file on disk that no longer hashes to it.
- `PIN_MISSING members[<name>]`: a member the pinned version does not pin.
- `PIN_UNKNOWN_MEMBER members[<name>]`: a pin for a name not in `members[]`.

The check also reads the collection record: schema, stage (from the collection
stages above), sign-offs (human, known stage, every `signoff` stage passed is
signed, `paused` signed), the collection's own questions, framing answers and
waypoint guides (`INTERVIEW_INCOMPLETE` at `interview`, `COLLECTION_ITEM_SILENT`
after it; post item guides the same from `post-interview`), and that every
`members[]` entry has its `project.json`. It does not check `plan.order`, the
cross bars or composition, and it does not run each member's interview check:
run `interview --check` in the member. Codes: [CHECKS.md § Collections](CHECKS.md#collections).
