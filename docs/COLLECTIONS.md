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
  shared/
    conventions.json   conventions every member follows
  members/<name>/      an ordinary project (the layout in PROJECT.md)
  inputs/              the group painting, shared references
  evidence/v<N>/       what a collection verdict rested on
  derived/             regenerable (ignored by git)
  outputs/v<N>/        lineup, outfit-switch takes (ignored by git)
  scratch/
```

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
      { "variant": "default", "model_sha256": "…", "atlas_sha256": "…", "config_sha256": "…" },
      { "variant": "winter", "model_sha256": "…", "atlas_sha256": "…", "config_sha256": "…" } ] }
]
```

The hashes are what is checked; the version number is the readable name. A new
member version changes nothing in the collection until a new collection version
pins it. A collection output whose recorded sources do not hash to its pins is
stale and is not shown. A check that fails by member name when a member is
rebuilt without the pins being updated is a later card.

Where a member has no `versions[]` yet (work that predates this structure), the
pin carries `"version": null` and the hashes alone, and says so in `note`.
