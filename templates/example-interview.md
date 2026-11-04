# Worked example: the three user steps

A **made-up** painting, for the shape only: a lighthouse keeper standing on a
cliff path at night — long coat, a scarf, hair tied in a tail, a lantern in her
right hand, the lighthouse behind her. The project is `lantern-keeper`. It
follows the user's three steps — base motion, direction, polish feedback — and
shows a user sentence, a full delegation, a sentence that delegates the rest,
and feedback read every way it can be read. The complete record this walk-through
produces is [example-project.json](example-project.json); the shapes are defined
in [../docs/INTERVIEW.md](../docs/INTERVIEW.md) and
[../docs/PROJECT.md](../docs/PROJECT.md).

## Step 1. Base motion (stage `interview`)

Framing first, then a guide at each rig waypoint. Nothing about the camera is
asked here: that is step 2.

| Waypoint | State | What the user said (verbatim) | Agent's reading |
| --- | --- | --- | --- |
| framing `rig_type` | user | "A standing character, idle. She holds a lantern." | `character.idle` |
| framing `reference` | user | "None." | `none`: reviews judge against the painting |
| `seethrough` | **delegated** | "auto" | agent: a full pass plus a head pass, so the eyelids come out as layers |
| `assemble` | user, **rest delegated** | "Standard cut, at the joints. Keep her face exactly as painted. The lantern is its own part. The rest is up to you." | standard cut; face untouched; lantern its own part; the part list and draw order are the agent's |
| `bones` | user | "A chain down the scarf, one in each coat tail, one in her hair tail." | chains: scarf, coat_tail_l, coat_tail_r, hair_tail |
| `meshes` | user | "The coat is one piece that bends with her breath. Face and lantern stay rigid." | torso: mesh; head, lantern: rigid regions |
| `constraints` | user | "The scarf and the coat tails move in the wind off the sea, the scarf a little more than the coat. Her hair tail barely moves. Nothing else on physics." | wind: scarf (most), coat tails, hair tail (barely); everything else still |
| `motion` | user | "Breath and blink. The lantern flame flickers." | breath, blink, flame_flicker; `game_states` is skipped (`required_for` does not include `character.idle`) |

`reference` is a user answer of *none*, not a delegation. `assemble` is a user
answer whose sentence hands over the rest, so the agent's part list is written
beside it in `agent_decision` with `covers` saying what it fills, and that part
of the waypoint reads as delegated.

The `seethrough` waypoint as written in `interview.waypoints[]` (prompts
omitted):

```json
{ "id": "seethrough", "config": ["seethrough"], "guide": {
    "delegated": true, "by": "user", "at": "2026-11-10T14:03:00Z", "verbatim": "auto", "source": "interview, chat",
    "agent_decision": {
      "value": { "passes": ["full", "head"], "head_box": "her face and the hair tail's root, from the painting" },
      "by": "agent", "at": "2026-11-10T15:10:00Z",
      "reasoning": "Blink needs the eyelids as their own layers; at full-figure resolution the face is too small for the split to find them. The lantern is far enough from the body that the full pass separates it on its own."
    } }, "history": [] }
```

Signed: `{ "stage": "interview", "checkpoint": null, "by": "user", "at": "2026-11-10T14:20:00Z", "verbatim": "that's everything" }`.

### The rig plan (stage `plan-approved`)

One step per waypoint, in pipeline order. Checkpoints were set by the user while
reading the draft; one was delegated, and the agent's decision on it was
written before the user signed.

| # | Step | Rests on | Bar | Checkpoint |
| --- | --- | --- | --- | --- |
| 1 | `seethrough` | `seethrough` (delegated) | both passes produce eyelid layers on both eyes; the lantern comes out as its own layer | user: off |
| 2 | `assemble` | `assemble`, `constraints` | every part named exists (face untouched, lantern its own part); limbs cut at shoulder, elbow, wrist; each part one label; setup pose matches the painting | user: on ("yes, show me the cut") |
| 3 | `bones` | `bones` | exactly the four chains the sentence names; no other chain | user: off |
| 4 | `meshes` | `meshes`, `assemble` | torso is a mesh; head and lantern are regions; 0 changed pixels inside the face box outside the eyelid masks, every frame | user: off |
| 5 | `constraints` | `constraints`, `bones` | only scarf, coat tails and hair tail move on physics; scarf largest, hair tail smallest; every other part changes 0 pixels from physics | **delegated** → agent: on |
| 6 | `motion` | `motion`, `rig_type` | every loop closes; breath, blink and flicker each present; renders the still-frame check | user: off |

Signed: `{ "stage": "plan-approved", "checkpoint": null, "by": "user", "at": "2026-11-10T16:05:00Z", "verbatim": "go" }`.
The signature does not make the delegated items the user's.

Steps 1 and 2 run in `parts`. At step 2 the labelled split image is shown and signed
(`{ "stage": "parts", "checkpoint": "assemble", … "verbatim": "the cut is fine" }`);
the assembled parts pass the parts check and the user signs them in rig-review's
parts view (`{ "stage": "parts-review", … "verbatim": "the parts are clean, rig it" }`).
Rigging runs the rest; at step 5 a motion sketch is shown for the checkpoint the agent chose. Each
config section cites its guide in `versions[0].provenance`, for example:

```json
"constraints": [
  { "entry": "scarf_wind", "guide": "constraints", "quote": "the scarf a little more than the coat" },
  { "entry": "coat_tail_l_wind, coat_tail_r_wind", "guide": "constraints", "quote": "The scarf and the coat tails move in the wind off the sea" },
  { "entry": "hair_tail_wind", "guide": "constraints", "quote": "Her hair tail barely moves." }
]
```

### First review, on a still frame (stage `rig-review`)

v1 (`kind: "rig"`) is shown at a fixed camera, the motion and physics playing in
place. Polish feedback, two items in one message:

```json
{
  "by": "user", "at": "2026-11-12T09:30:00Z", "review": "rig-review", "verdict": "bounced",
  "verbatim": "The lantern swings with the whole arm, like it's glued to her hand. It should hang from her hand and swing on its own. And the scarf whips around too hard; I said a little more than the coat, not a flag.",
  "source": "chat",
  "on_items": [
    { "id": "bones", "answer_was": "not-asked" },
    { "id": "constraints", "answer_was": "user" }
  ]
}
```

- **The lantern.** The `bones` sentence named four chains and nothing about the
  lantern; no prompt asked whether a held thing swings. `not-asked`: the
  feedback sentence is added to the `bones` guide as an addition —
  *"It should hang from her hand and swing on its own."*, `"source": "polish
  feedback, v1"` — and the hinge bone and its stop are cited to it in v2's
  provenance. It is not fixed silently, so the next project with a held thing
  will be asked.
- **The scarf.** The `constraints` sentence said *"a little more than the
  coat"*; v1 did not follow it. `user`: an agent error, fixed in v2.

Steps 3 and 5 rest on the changed guide, so the plan is signed again for those
two before they run:
`{ "stage": "plan-approved", "checkpoint": null, "steps": ["bones", "constraints"], … "verbatim": "yes, re-run those two" }`.

v2 names what it answers — `"answers_feedback": [{ "version": 1, "verdict": 0 }]` —
and its `changed` says what moved. The user accepts v2 at `rig-review`:
*"yes, that's her"*, recorded both as v2's verdict and as the sign-off that
closes the stage.

## Step 2. Direction (stage `post-interview`)

Asked only now, about the accepted rig v2:

| Post item | State | What the user said (verbatim) |
| --- | --- | --- |
| `camera_depth` | user | "A slow push-in, no parallax." |
| `post_timing` | user | "Eight seconds, looping. The beam sweeps past once, near the end." |
| `post_composition` | user | "Keep the whole lighthouse in frame. It's night; don't brighten it." |

Three post steps (`camera`, `timing`, `composition`; `phase: "post"`) are
drafted from these and signed with them:
`{ "stage": "post-interview", … "verbatim": "go" }`. No depth is built, because
the camera does not parallax; nothing in the rig changed for that.

### The timing bar's chain-tip reading

The timing bar in `example-project.json` keeps the eight-second length and the
single late beam sweep, and adds a command-backed chain-tip clause. For
`scarf`, `coat_tail_l`, `coat_tail_r`, `hair_tail` and `lantern_hinge`, each boundary jump at
8 seconds and 16 seconds must be no larger than that tip's own largest in-loop
step in each adjacent period.

Run `node_modules/.bin/rigc render --candidate derived/loop-twin --animation idle --fps 24 --geometry --out derived/loop-reading`.
Read each named chain's tip bone in the built rig's `geometry.json` in the
reported set directory. Reduce its world transform and length to its
world-space endpoint, then compute
Euclidean distances between consecutive endpoints. Compare steps 191-to-192
and 383-to-384 with that tip's largest consecutive step inside each adjacent
192-frame period, excluding boundary steps.

`derived/loop-twin` denotes a compiled three-period measurement twin prepared
for this reading. Before using this example in a real project, prepare and
record that twin and check the reading command. The blink remains keyed once;
the beam sweep also remains once unless the twin's recorded differences say
otherwise. Those later periods do not certify repeated blink or beam timing.
The length and beat clauses still need their own reading commands before a
real project's sign-off.

The complete post loop-seam rule compares whole-figure boundary counts with
physics on against physics off on named backgrounds, and retains the per-tip
clause ([INTERVIEW.md](../docs/INTERVIEW.md#post-bars-on-a-looping-idle)).
White `#ffffff` and sentinel magenta `#ff00ff` are the proposed counting
backgrounds here. Today's rigc supplies no command for the physics-off
whole-figure comparison, so the example adds only the chain-tip clause.
Requiring that whole-figure reading is a STOP before sign-off until its tool
exists. The fictional sign-off above supplies no missing measurement command.

### Second review, direction (stage `direction-review`)

v3 (`kind: "post"`, `rig_version: 2`) is shown. Polish feedback:
*"The beam sweeps right at the start. I said near the end."* →
`on_items: [{ "id": "post_timing", "answer_was": "user" }]`: the version did not
follow the user's sentence, so it is an agent error, fixed in v4 on the same rig
v2. The user accepts v4: *"done, I like it"*, and the project is `accepted`.

## What the record shows afterwards

Reading [example-project.json](example-project.json) cold, without this page:

- Two of the nine sign-offs are checkpoints (`assemble`, `constraints`); one
  re-signs two plan steps after a guide changed.
- One waypoint was delegated outright (`seethrough`), one partly (`assemble`);
  both carry the agent's reasoning beside the delegation.
- Of the two bounces, one landed on a user sentence (agent error) and one on
  something never asked (now a sentence at `bones`). Neither landed on a
  delegated item, so no bounce reads as a cost the user chose.
- v2 and v4 each say which verdict they answer; v1 and v3 answer none.
