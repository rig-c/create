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
`git log`. `rig-create init <dir>` writes the layout above, a `.gitignore`
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

`interview` → `plan-approved` → `rigging` → `rig-review` → `post-interview` →
`post` → `direction-review` → `accepted`, plus `paused`.

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
| `rigging` | 1 | The rig steps run in order; each config section cites its guide (`versions[].provenance`). At a step whose checkpoint is on, work stops until `{ "stage": "rigging", "checkpoint": "<step id>" }` is signed. | The last rig step's bar is met. |
| `rig-review` | 1 → 3 | **First review, on a still frame**: the rig alone, fixed camera, no post-production — seams, cuts, physics and motion played in place. Feedback is recorded verbatim with `on_items`; a bounce makes a new rig version. | The user accepts one rig version. |
| `post-interview` | 2 | The post items (camera and 2.5D, timing, composition) are asked, and the post steps (`phase: "post"`) drafted from them. | The user signs `{ "stage": "post-interview" }` — guides and post steps together. |
| `post` | 2 | Post-production on the accepted rig version (`versions[].kind: "post"`, `rig_version` naming it). | The last post step's bar is met. |
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
its approval is the `signoffs[]` entry with `"checkpoint": "assemble"`. This checkpoint has no
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

## Versions

Every build shown to anyone is a `versions[]` entry, numbered in order across
both kinds:

| Field | Holds |
| --- | --- |
| `n` | the version number, `1, 2, …` |
| `kind` | `rig` or `post` |
| `rig_version` | for a post version, the `n` of the accepted rig it is built on; `null` for a rig version |
| `at`, `built_by`, `built_with` | when, which agent or tool, and the package versions used (`{ "@rig-c/parts": "…", "@rig-c/core": "…" }`) |
| `answers_feedback` | the verdicts this version answers: `[{ "version", "verdict" }]` (version number and index into its `verdicts[]`); empty for a first version |
| `changed` | what changed from the previous version of the same kind, in a sentence |
| `outputs` | `outputs/v<N>/` files with sha256 and size, frozen when shown |
| `evidence` | `evidence/v<N>/` files with sha256 and what each shows |
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
| `signoffs[]` | every human signature: `stage`, `checkpoint` (step id or `null`), `by`, `at`, `verbatim`; a plan re-signed after a guide changed adds `steps[]` naming the steps re-approved |
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
