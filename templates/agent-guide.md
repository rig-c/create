# Agent guide

This folder is a rig project: one painting in, one rig and the takes made from it
out. Read this page before you touch anything. You need no chat history; what a
person decided is in `project.json`, and nowhere else.

## Start here

1. Read `project.json` first, and nothing else first. It is the only record of
   decisions. A decision made in chat is copied into it word for word, with who
   said it and when, or it was not made.
2. Resume the way {{RESUME_LINK}} says: `stage`, the last `signoffs[]` entry, the
   first `plan.steps[]` entry not `done` and the last `versions[]` entry say
   where the project stands and what the next work is.

## The order, and what you may not do

`interview` → `plan-approved` → `rigging` → `rig-review` (the rig alone, on a
still frame) → `post-interview` → `post` → `direction-review` → `accepted`. Any
stage can become `paused`.

- Do not rig before the plan is signed: no rig step runs until `signoffs[]`
  holds the user's `{ "stage": "plan-approved" }` entry.
- Never move `stage` forward or pass a plan checkpoint yourself. Only a person's
  `signoffs[]` entry does that. You may draft, propose, build and measure in any
  stage.
- Never fill a user's answer from the image. A `null` answer is the next
  question for the user; ask it in plain words.
- "auto" is a delegation the user chose. Record it as delegated, with your
  decision written on the item. It is never a blank for you to fill later.
- {{INTERVIEW_CHECK}}

## The user's three steps

1. **Base motion**: the cut, the bones, what deforms, physics and the motions,
   answered before any rigging and judged at `rig-review`.
2. **Direction**: camera, depth and timing, asked only after a rig version is
   accepted and judged at `direction-review`.
3. **Polish**: what the user says after seeing a version, kept word for word in
   that version's `verdicts[]` and tied to the items it is about.

## Before you ask, plan or show

- **Derive first.** Take every answer that earlier answers, an intake note or a
  reviewer's past verdicts already give ({{DERIVED_LINK}}); ask only what is
  left, in one short message. Nothing is derived from the image.
- **Upscale first.** A painting smaller than the rig needs is upscaled before it
  goes into `inputs/`; one already there gets its upscale as a new input.
- **The crux is a bar.** The user's named risk becomes a measured bar in the
  plan before rigging: a named band, what is counted (background or doubled
  pixels), over every frame and at both extremes of every physics and breath
  motion, reported as the max and its frame. It covers every band where a moving
  piece sits over something not on its bone (a hand over the hip when only the
  chest breathes).
- **Nothing unnamed.** Add no motion, chain or physics the user did not name. A
  reference ("move like X") is read for what it shows; anything more is a
  question, not a default.
- **Re-run first.** An uneven split or poor hidden surface is re-run (other
  settings, a tighter crop of that region), several runs before any cut. When
  re-runs cannot fix a visible-pixel defect, the next rung is an editor piece
  taken from the painting along its painted outlines, with See-through's own
  alpha for any border that has no painted line, feather 0, and a receipt. Never
  a polygon in code or config. See-through stays the source for hidden surface.
- **A full-screen scene is a CG build.** For `rig_type` `fullscreen.*`, each
  rig version's config, kept in `outputs/v<N>/`, sets `trace_parts: true` in
  `assemble.editor_receipts` and names a `requirements` file with
  `seam_over_motion.required: true` and `boundary_colour.max_step_excess: 12`.
  Refusals are the art's to fix.
- **Overlaps.** A piece over a part with its own animation (glasses over
  eyelids) holds none of that part's pixels, or the animation shows its copy.
- **Pairs.** Left/right bust, eyes, hair ends, hem panels: measure symmetry
  (both present, comparable area, mirrored edges) and compare to the painting
  before calling a pair uneven ({{GATES_LINK}}).
- **Look before the user does**, at native resolution and every boundary the
  crux names: a whole-figure |composite − painting| map, every component listed
  by box and part with a status (in the painting / fixed / left, why). Use the
  true stack of part images, not a render flattened on white; crop on white and
  on a mid-grey or sentinel colour, as white hides light fringes. Eye boxes a
  reviewer chose are not the check: a seam outside them got through.

## Where things go

| Path | Lifetime | In git |
| --- | --- | --- |
| `project.json` | forever | yes |
| `inputs/` | forever, never edited; a changed input is a new file | yes |
| `evidence/v<N>/` | forever: what a verdict rested on | yes |
| `derived/` | until regenerated; each entry listed in `derived[]` with its command | no |
| `outputs/v<N>/` | until discarded; frozen when shown | no |
| `scratch/` | none; deleting it must lose nothing | no |

The user's own references ("make it feel like this") go in `inputs/references/`,
with their sha256 in `project.json` `inputs[]`. They are inputs to the rig, not
documentation, and they are never edited.

## What to read, and why

Read in this order, each before the step it names:

{{READ_FIRST}}

The packages' documents are in the project, installed at the versions
`package.json` pins, so they match the tools you run. Read them here, not from
memory or from the packages' repositories. A refusal from either tool usually
ends with a `(see … guide …)` command that prints the matching row of these
guides; run it before changing anything.

{{PACKAGE_DOCS}}

How this project is organised is documented in rig-c/create, which is not
installed here:

{{CREATE_DOCS}}
