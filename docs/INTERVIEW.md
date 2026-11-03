# The interview

The direction a user gives before any rig work starts, and the shape every
answer takes in `project.json`. The interview is organised by the **waypoints**
the rig work always passes through — the sections of a `@rig-c/parts` config —
and the user's sentences attach at each one. Camera, 2.5D depth and timing are
**post-production**, asked separately after the rig is accepted. The plan the
work follows is drafted from these answers ([PROJECT.md § The plan](PROJECT.md#the-plan));
a worked example is in [../templates/example-interview.md](../templates/example-interview.md),
with its record in [../templates/example-project.json](../templates/example-project.json).

Why this exists: an agent rigging a painting makes direction calls at every
waypoint — which parts move on physics, where the torso is cut, what stays
rigid, whether the hands move. Made alone, each of those calls is only found out
when a person watches the result and sends it back, and every bounce re-runs a
full build and review. The interview moves the calls to before the work. A user
who answers "auto" has chosen to hand that call to the agent, and the record
says so.

## The user's three steps

The user sees three steps. Everything else in this file — waypoints, states,
provenance — is the machinery under them and is not something the user has to
learn; the interviewer asks in plain questions and never shows a waypoint id or
a form.

| User step | In this file | When |
| --- | --- | --- |
| 1. **Base motion** | Framing (`rig_type`, `reference`), then a guide at each rig waypoint: `seethrough`, `assemble`, `bones`, `meshes`, `constraints`, `motion` | stage `interview`, before any rig work; judged at the first review, on a still frame |
| 2. **Direction** | Post items: `camera_depth`, `post_timing`, `post_composition` | stage `post-interview`, after the rig is accepted; judged at the second review |
| 3. **Polish feedback** | Verdicts on a shown version, each tied to a waypoint or post item | at either review, as often as it takes |

## Every item has an owner

No answer is left empty for the agent to fill later. Each question ends in
exactly one of four states:

| State | Meaning | Who writes it |
| --- | --- | --- |
| `null` | Not asked yet. The interview cannot be signed while a framing answer or the guide of a waypoint the plan passes is `null`. Post items are asked when `post-interview` opens, not before. | — |
| user answer | The user's own words, verbatim, plus a normalised `value`. "None" is a user answer (`"value": "none"`), not a delegation: *there is no reference* is a decision. | the interviewer, from the user |
| delegated | The user said "auto" (or "you decide", or pressed a control that means it). The agent decides that item and writes its decision and reasoning into `agent_decision` beside the delegation. | the interviewer records the delegation; the agent fills `agent_decision` |
| not applicable | A prompt's `required_for` does not include the answered `rig_type`, or the pipeline for this project has no such section (a pre-layered input skips `seethrough`). Derived, not judged, so the interviewer may write it. | the interviewer |

Rules that follow from the table:

- **A delegated item stays delegated.** Signing the plan that shows the agent's
  decision does not turn it into a user answer. If the user wants it to be
  theirs, they answer it: the new answer replaces the old, and the old one moves
  to that question's `history[]`. Reason: a bounce on a delegated item is a cost
  the user chose, and the record must still say so after the plan is signed.
- **The agent's decision on a delegated item is written before the plan is
  signed**, so the user sees every agent choice the plan rests on at the moment
  they sign. A delegated item the plan does not need yet may wait, but its
  `agent_decision` is written before the step that uses it starts.
- **A bounce is attributed to the items it is about.** Each verdict lists
  `on_items[]`: the answer ids it concerns and whether each was a user answer,
  delegated, or never asked ([§ Polish feedback](#polish-feedback)).
- **A changed answer reopens what rests on it.** Every plan step whose
  `rests_on` names that answer needs the plan signed again before it runs.

`rig-create interview --check` is the machine check of these rules — refusing
by name every waypoint with neither a guide nor a delegation, every step that
rests on no answer, every stage moved without a sign-off; this document is the
contract it checks and [CHECKS.md](CHECKS.md) lists its codes. Delegation is a
pass for that check, never a hole: the refusal fires only on silence.

## Answer shape

Every record in `project.json` that a person made — an answer, a sign-off, a
verdict — carries the same three fields: `by` (who), `at` (when, ISO 8601) and
`verbatim` (the words used). One shape, so a reader never has to learn which
record calls the date what.

A user answer:

```json
{
  "delegated": false,
  "by": "user",
  "at": "2026-11-10T14:05:00Z",
  "verbatim": "Breath and blink. The scarf lifts when the wind comes.",
  "value": [
    { "motion": "breath" },
    { "motion": "blink" },
    { "motion": "scarf_lift", "note": "only with the wind" }
  ],
  "source": "interview, chat"
}
```

A delegated answer, after the agent has decided:

```json
{
  "delegated": true,
  "by": "user",
  "at": "2026-11-10T14:07:00Z",
  "verbatim": "auto",
  "source": "interview, chat",
  "agent_decision": {
    "value": { "passes": ["full", "head"] },
    "by": "agent",
    "at": "2026-11-10T15:20:00Z",
    "reasoning": "Blink needs the eyelids as their own layers; at full-figure resolution the face is too small for the split to find them."
  }
}
```

Not applicable:

```json
{ "not_applicable": true, "because": "rig_type = fullscreen.minimal", "by": "interviewer", "at": "2026-11-10T14:09:00Z" }
```

- `verbatim` is kept in the language the user used. `value` is the interviewer's
  normalisation of it; when the two disagree, `verbatim` wins and `value` is
  corrected.
- `source` says where the words were given (chat, a call, a note) so the
  record can be traced; chat is not a record — the decision is copied here.
  A **derived answer**, taken from words already on record instead of asked
  again, says so here ([§ Derived answers](#derived-answers)).
- A sentence may leave part of a waypoint open ("the rest is up to you"). Then
  the agent's choice for that part is written to `agent_decision` beside the
  sentence, with `covers` naming what it fills, and that part reads as
  delegated.
- A guide may grow after the interview: a sentence added from polish feedback
  or from an `x_` prompt goes into the guide's `additions[]`, each with `by`,
  `at`, `verbatim`, `value` and `source`. The original sentence is not edited,
  so a provenance `quote` taken from it stays findable; an addition is quoted
  the same way.
- A replaced answer moves whole into the question's `history[]`; the record
  never loses what was once decided.
- Collection members add a `basis` field to every answer
  ([COLLECTIONS.md § Inherited, overridden, own](COLLECTIONS.md#inherited-overridden-own)).

### Derived answers

Before asking, the interviewer reads what is already on record — earlier
answers, an intake note in `inputs/`, a reviewer's past verdicts — and takes
from it every answer those words already give. Only what is left is asked, in
one short message. Asking a user what their own earlier sentence already
answered is a cost the record could have saved.

A derived answer is an ordinary user answer; only `source` says where it came
from:

```json
{
  "delegated": false,
  "by": "user",
  "at": "2026-11-08T10:12:00Z",
  "verbatim": "Only the chest breathes; the hips stay where they are.",
  "value": [{ "motion": "breath", "note": "chest only, hips still" }],
  "source": "derived from inputs/intake.md"
}
```

- `by`, `at` and `verbatim` are those of the words on record — who said them,
  when, the exact fragment — not of the derivation. A reviewer's past verdict
  keeps the reviewer as `by`.
- `source` starts with `derived from` and names the record: a file under
  `inputs/`, an answer (`interview.waypoints[motion].guide`) or a verdict
  (`versions[v1].verdicts[0]`). The `verbatim` fragment is found in that
  record, so anyone can trace it.
- Only words are derived. An answer the record merely implies, and anything
  read off the image, is still a question.
- The message that asks what is left lists each derived answer in one line, so
  the user can correct it; a correction replaces it, and the derived answer
  moves to `history[]`.

No new field is needed: `interview --check` reads a derived answer as the user
answer it is, and a provenance `quote` taken from it resolves against its
`verbatim` like any other.

## Direction is taken in sentences

The split and the direction alike are received in the user's own sentences —
"cut the bust, not the waist, and give it jiggle physics", "the hem moves in the
wind down to the knee" — not as a drawing or a form. The prompts below draw
those sentences out; they are not fields to fill.

- The sentence is the answer, stored `verbatim`. `value` is the agent's
  normalised reading of it and never replaces it. One sentence may answer
  several questions; it is stored once and referenced.
- Every part, effect, motion or extent a sentence names is a line the work is
  checked against: a part said to be cut must exist as a part; an effect said to
  be on a part (wind, physics, jiggle) must be on that part and on no part the
  sentence excludes; an extent ("down to the knee") bounds what moves. A
  sentence that says "must" is a bar, not a preference. Turning these lines into
  `@rig-c/core` `invariants` that the build is gated on is a later card; until then
  they are read at review against the version's provenance.
- Anything the agent shows back — the labelled split image, a motion sketch — is
  its reading of the sentences for the user to sign, not the user's input.

## Waypoints: where the guide attaches

A waypoint is a place the agent always passes while rigging, with the user's
guide waiting at it. The waypoints are not a hand list: **they are the top-level
sections of the `@rig-c/parts` config the work writes**, grouped by the decision
made there. A new config section is a new place a decision is made, so it joins
a waypoint (or becomes one) without anyone editing a list. The template's
waypoint list is a snapshot of the sections at the package version named in
`interview.question_set`; project creation is expected to regenerate it from the
installed package.

Not every section is a waypoint. A section is one when writing it is a
**direction call** — something the user could have an opinion about before
seeing a build. Read from `@rig-c/parts` 2.4.0:

| Config section | Where it goes | Why |
| --- | --- | --- |
| `seethrough` | waypoint `seethrough` | how the painting is decomposed into layers |
| `assemble`, `limbs`, `scene`, `waist` | waypoint `assemble` | what becomes a part, where the cuts are, what the painting is, which outfit sets exist (`assemble.alternates` is a field of `assemble`, not a section of its own) |
| `bones` | waypoint `bones` | where bones sit, which parts get chains |
| `meshes`, `regions` | waypoint `meshes` | what deforms and what rides rigid |
| `constraints`, `stops`, `cloth` | waypoint `constraints` | what moves on physics and how far |
| `motion` | waypoint `motion` | what moves, how far, how fast |
| `turn`, `depth` | post item `camera_depth` | head-turn and 2.5D depth are direction, asked after the rig is accepted |
| `key`, `generation`, `proposed_rig_scale`, `requirements`, `motion_seams`, `note` | not a waypoint | a name, a record of a run, a value the tool proposes, a path to a checks file, an observation, an annotation — none is a direction call. `requirements` is where translated guide sentences will land, not where they are asked. |

A section that cannot be placed on this table when it appears is a question for
the user before it is written. The table lives as data in `src/waypoints.ts`,
and the section list is read from the installed package, so
`interview --check` refuses such a section by name ([CHECKS.md](CHECKS.md)).

**Every waypoint the plan passes carries a guide — the user's sentences or an
explicit delegation. Nothing is decided silently.** The guide is one answer in
the shape above, stored on the waypoint (`interview.waypoints[].guide`). A
waypoint the plan does not pass is answered *not applicable* with the reason,
and is not asked. "None" is a guide: *nothing moves on physics* is a decision
about `constraints`.

Each waypoint has **prompts**: the questions the interviewer asks to draw out the
sentence. `rig_type` and `reference` frame everything and are asked first,
because `rig_type` decides which waypoints are passed and which prompts apply,
and `reference` decides what every review compares against.

| # | Waypoint | What the agent decides there | Prompts | Guide sentence, example |
| --- | --- | --- | --- | --- |
| F1 | framing | which waypoints are passed; the plan's outline | `rig_type` | *"A standing character, idle; she holds a lantern."* |
| F2 | framing | what reviews compare against | `reference` | *"The idle in our trailer, but slower."* |
| W1 | `seethrough` | how the painting is decomposed into layers: resolution, the head crop, the seed | `x_layers` | *"Keep the hat with the head; the lantern she holds is its own layer."* |
| W2 | `assemble` | which layers become which parts and in what draw order, where limbs are cut, what is authored new, what is kept under occluders, which outfit sets exist | `split_granularity`, `split_emphasis` | *"Cut the bust, not the waist."* · *"Keep her face exactly as painted."* |
| W3 | `bones` | where bones sit and which parts get chains (hair, coat tails, sleeves) and how long | `x_chains` | *"Two chains in the back hair, one in each coat tail; the scabbard stays rigid on the hip."* |
| W4 | `meshes` | which parts deform as weighted meshes and which ride one bone as rigid regions; mesh density | `x_deform` | *"The waist stays one piece that bends; the face is rigid on the head."* |
| W5 | `constraints` | which parts move on physics, how strongly, with wind and gravity, and where a chain must stop | `split_effects` | *"The hem moves in the wind down to the knee; the bust jiggles; the sleeves barely move."* |
| W6 | `motion` | the tracks (what moves, how far, how fast), the loop length, blinking; for a game-logic scene, the states | `motions`, `game_states` | *"A slow breath, about three seconds; blink now and then; the head does not sway."* |

[CRAFT.md](CRAFT.md) holds the craft notes: per waypoint, the default the
interviewer may propose ("Usually X — shall we?"). The interviewer may read one
out as a proposal; the user's reply is the guide, and a default nobody was asked
about decides nothing.

### Prompts

Each prompt keeps its `id`, its `text` and its `required_for`; for a `rig_type`
it does not apply to, it is skipped and the waypoint is still asked through its
other prompts. `source` says whether the prompt is part of the standard set
(`rig-create`) or was added for this project (`project`, see
[§ Questions outside this set](#questions-outside-this-set)).

| id | At | Prompt | Required for |
| --- | --- | --- | --- |
| `rig_type` | framing | What is this: a character rig — standing idle, complex motion, or a monster with its own moves — or a full-screen scene — minimal motion (breath, blink) or motion tied to game logic? | all |
| `reference` | framing | "Make it feel like this": a video, an existing demo, a game you have in mind? | all |
| `x_layers` | `seethrough` | Is there anything the layer split must keep together or keep apart — a hat with the head, a held object on its own? | all |
| `split_granularity` | `assemble` | How finely should it be cut? | all |
| `split_emphasis` | `assemble` | Which parts matter most — more detail, or kept exactly as painted? | all |
| `x_chains` | `bones` | What moves on its own — hair strands, coat tails, sleeves, held things? | all |
| `x_deform` | `meshes` | What must bend smoothly as one piece, and what must stay rigid? | all |
| `split_effects` | `constraints` | Which parts have special effects — sway on physics, move in wind, jiggle, glow, flicker — and how far do they move? | all |
| `motions` | `motion` | Which moves? Name each one. | all except `fullscreen.game_logic` |
| `game_states` | `motion` | Which states, and what moves it from one to the next? | `fullscreen.game_logic` |

Values the agent normalises a guide into, per prompt (the sentence stays the
answer):

- `rig_type`: `character.idle`, `character.complex`, `character.monster`,
  `fullscreen.minimal`, `fullscreen.game_logic`. Any other value is refused
  (`RIG_TYPE_UNKNOWN`). A `fullscreen.*` project is a CG build: its rig
  versions declare the three CG gates ([CHECKS.md § CG gates](CHECKS.md#cg-gates)).
- `reference`: a list of `{ "ref", "take" }`, or `"none"`. A file the user hands
  over goes to `inputs/references/` with its sha256 — it is an input, not
  documentation.
- `split_granularity`: `coarse` (only the parts a listed motion moves),
  `standard` (limbs and garments at joints), `fine`, or a part list.
- `split_emphasis`: a list of `{ "part", "want": "detail" | "untouched" | <text> }`,
  or `"none"`.
- `x_deform`: `{ "meshes": [<part>], "rigid": [<part>], "bust": … }`, where
  `bust` is `"default"` (meshed with its own regions; also what no `bust` means)
  or `{ "excluded": true, "reason": "<the user's reason>" }`. A blank reason is
  refused (`BUST_EXCLUSION_UNREASONED`); [CRAFT.md M2](CRAFT.md#m2-the-bust-is-meshed-unless-there-is-a-reason).
- `split_effects`: a list of `{ "part", "effect", "extent" }` — effect from
  `physics`, `wind`, `jiggle`, `rigid`, `still`, or free text; extent as said
  ("down to the knee").
- `motions`: a list of `{ "motion", "note" }`.
- `game_states`: `{ "states": [{ "name", "loop", "motions" }], "transitions": [{ "from", "to", "trigger" }] }`.

The full label map — every part outlined on an image with one label — is the
agent's reading of the `assemble` and `constraints` guides, shown back for the
user to sign at the `assemble` checkpoint ([PROJECT.md § Split approval](PROJECT.md#split-approval-is-a-plan-checkpoint)).
It is not asked.

## Post-production: asked after the rig is accepted

2.5D depth and camera work are far from rigging: nothing in the rig is built or
judged for them. They are not rig waypoints. Their guides are asked when
`post-interview` opens, after the rig has passed `rig-review`, in the same
answer shape and under the same rule: every post item the plan passes carries a
sentence or a delegation. Asking them earlier would ask about a rig that may
still change. "Accepted" means one rig version accepted at `rig-review` on its
still frame; the post work runs on that version, which `rig-create handoff`
names ([PROJECT.md § The hand-off to post-production](PROJECT.md#the-hand-off-to-post-production)).

| id | Config sections | Prompt | What the agent decides there | Guide sentence, example |
| --- | --- | --- | --- | --- |
| `camera_depth` | `turn`, `depth` | Does the view move — a 2.5D head-turn with parallax, a push-in — or is it fixed? | whether depth is built, how far layers shift, the camera path | *"Fixed camera, no parallax."* · *"A slow head-turn to the left, as if she notices someone."* |
| `post_timing` | — | How long, does it loop, and where are the beats? | clip length, loop point, timing of motions against each other | *"Ten seconds, looping; the gust comes once, in the middle."* |
| `post_composition` | — | What is around the figure — background, framing, other figures, light? | framing, background plate, what else is on screen | *"Frame from the knees up; keep the lighthouse in shot."* |

## Provenance: every config section cites its guide

Each section of the config the agent writes cites the guide sentence or the
delegation it rests on. A section with no basis is a value the agent invented,
which is what the interview exists to stop. The citation lives in `project.json`
beside the version built from that config — `versions[].provenance` — not inside
the config, because the config lives with the build in `derived/` and is not
kept:

```json
"provenance": {
  "config": { "path": "derived/v1/config.json", "sha256": "…" },
  "sections": {
    "assemble": [
      { "entry": "plan[bust]", "guide": "assemble", "quote": "Cut the bust, not the waist." },
      { "entry": "plan[*] order", "guide": "assemble", "delegated": true }
    ],
    "constraints": [
      { "entry": "bust_physics", "guide": "constraints", "quote": "the bust jiggles" },
      { "entry": "hem_*", "guide": "constraints", "quote": "The hem moves in the wind down to the knee" }
    ]
  }
}
```

- `sections` is keyed by config section name; `entry` names the item in the
  section (a part, bone, constraint or track, with `*` for a rule that covers
  several); `guide` is the answer id it rests on (a waypoint, framing or post
  item id); `quote` is the exact fragment of the stored sentence it follows;
  `delegated: true` points at the delegation or `agent_decision` instead.
- An entry with no citation is a decision nobody gave. It is either cited (by
  finding the sentence, or asking for one) or removed before the version is
  shown. `interview --check` refuses, by section name, a section with no
  citation and a citation that does not resolve — a `guide` that is no answer,
  a `quote` found in none of that answer's stored sentences, a `delegated: true`
  on an answer the user did not hand over
  ([CHECKS.md § Provenance](CHECKS.md#provenance)).
- A bounce's `on_items` names the waypoint, and the provenance says which
  sentence or delegation the bounced entry came from.

## Polish feedback

What the user says after seeing a version is stored verbatim in that version's
`verdicts[]`, with `review` (`rig-review` or `direction-review`) and
`on_items[]`. Each item names the answer it touches (a waypoint id, a framing id
or a post item id) and `answer_was`:

- `user` — the version did not follow a sentence the user gave: an agent error,
  fixed in the next version.
- `delegated` — the agent's own decision, on an item the user handed over: a
  delegated cost, not an agent error. The user may now answer it themselves
  (the new sentence replaces the delegation, which moves to `history[]`).
- `not-asked` — the feedback names something no guide covered. It becomes a new
  sentence in that waypoint's guide (`guide.additions[]`), quoted from the
  feedback with its date and marked `"source": "polish feedback, v<N>"`, before
  the next version is built.
  It is never fixed silently, so the same feedback is not needed twice: the next
  version's provenance must be able to cite it.

The next version's `answers_feedback` lists the verdicts it answers (version
number and verdict index), and its `changed` says what changed. Feedback on the
rig given at the direction review goes back to the rig waypoints and makes a
new rig version, which needs a new first review.

### Recording a verdict

```
rig-create review <version> --verdict accepted|bounced|provisional --by <who>
  --review rig-review|direction-review --verbatim "<words>" --source <where>
  [--item <id>[:user|delegated|not-asked]]... [--quote <id>=<fragment>]
  [--value <id>=<json>] [<project dir>] [--json]
```

Appends one verdict to `versions[v<N>].verdicts[]`, dated now, with the words
stored exactly as given, and prints what it recorded. The review must be the
one that judges that kind of version (`rig-review` a rig version,
`direction-review` a post version); rig feedback given at the direction review
is recorded on the post version shown and names the rig waypoints in its items.

`answer_was` comes from the record wherever the record decides it, and a value
the record contradicts is refused by name (`FEEDBACK_ITEM_CONTRADICTS`):

| The item's current answer | `answer_was` when not named | Also allowed |
| --- | --- | --- |
| a delegation | `delegated` | — |
| a user sentence | `user` | `not-asked` — the feedback names something the sentence did not cover, which only the reader can tell |
| a user sentence that left part open (`agent_decision` beside it) | none: name it (`FEEDBACK_ITEM_AMBIGUOUS`) | `user`, `delegated`, `not-asked` |
| not applicable, or no answer | refused (`FEEDBACK_ITEM_NOT_APPLICABLE`, `FEEDBACK_ITEM_SILENT`): ask the question first | — |

A `not-asked` item is written in the same turn as a new sentence in that
answer's `additions[]`: `by` and `at` of the verdict, `verbatim` = the
`--quote` fragment (default: the whole feedback; it must be a fragment of it),
`value` = `--value` (default `null`, to be normalised before the next version)
and `source: "polish feedback, v<N>"`. The original sentence is not edited.
Because the guide changed, the steps resting on it need the plan re-signed
before they run again (`GUIDE_CHANGED_UNSIGNED`).

An item id that is no framing, waypoint or post item is refused
(`FEEDBACK_ITEM_UNKNOWN`); `review` does not create an `x_` prompt. A prompt
is a question with its own text and `required_for`, asked of the user like the
rest (§ Questions outside this set) — a verdict cannot write it — and an `x_`
prompt's answer lives in its waypoint's guide, so the item the verdict names is
that waypoint either way. Add the prompt, then name the waypoint.

`review` never moves `stage` and writes no sign-off: a verdict says what a
person thought of a version, and a stage moves only on a sign-off. An
acceptance is recorded with this command and signed with its sign-off in the
same turn ([PROJECT.md § Stages](PROJECT.md#stages)).

`interview --check` then refuses a bounced version that a later version does
not answer, an `answers_feedback` ref that points at no earlier verdict, and a
`not-asked` item whose sentence is not in the guide; and it counts every bounce
by cause, so a bounce on a delegated item reads as the user's chosen cost
([CHECKS.md § Polish feedback](CHECKS.md#polish-feedback)).

## Checking the interview

```
rig-create interview --check [<project dir>] [--json]
```

Before any rigging, and after any change to the record, the check reads
`project.json` and refuses by name everything still open: a waypoint the plan
passes with neither a guide nor a delegation, a delegated item the agent has not
decided while the plan is signed, a plan step resting on no answer, a stage
moved without its sign-off, a `@rig-c/parts` section the waypoint table does not
place. It reports every refusal, not the first; exit `0` means the record is
complete for its stage. The codes, what fires each and how to clear it are in
[CHECKS.md](CHECKS.md).

## Questions outside this set

When a plan step needs a decision no prompt reaches, it is asked like the rest:
add a prompt with an `x_` id (`x_wind_direction`) at the waypoint it belongs to,
with `"source": "project"`, and record the user's sentence or delegation in that
waypoint's guide. A step never rests on nothing. An `x_` prompt that comes up on
a second project is a candidate for the standard set.
