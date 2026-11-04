# Agent guide

One painting in, one rig and its takes out. Read this first; no chat history needed.

## Start here

1. Read `project.json` first. Only decisions recorded there count. Copy chat
   decisions verbatim, with speaker and time.
2. Resume per {{RESUME_LINK}}. Read `stage`, last `signoffs[]`, first
   `plan.steps[]` not `done`, and last `versions[]` for status and next work.

## The order, and what you may not do

`interview` → `plan-approved` → `parts` → `parts-review` (the parts, by eye) →
`rigging` → `rig-review` (the rig, still frame) → `post-interview` → `post` →
`direction-review` → `accepted`. Any stage can become `paused`.

- No rig step runs before the user signs `plan-approved`, and none after
  `assemble` before they sign `parts-review` with the approved parts verdict
  as `evidence`.
- Only a person's `signoffs[]` advances `stage` or passes a plan checkpoint.
  You may draft, propose, build and measure in any stage.
- Never derive answers from the image. Ask the next `null` answer in plain words.
- Record "auto" as delegated, with your decision on the item. It is never a
  blank for you to fill later.
- {{INTERVIEW_CHECK}}

## The user's three steps

1. **Base motion**. Cut, bones, deformation, physics and motion. Ask before
   rigging; judge at `rig-review`.
2. **Direction**. Camera, depth, timing. Ask after rig acceptance; judge at
   `direction-review`.
3. **Polish**. Keep feedback verbatim in the shown version's `verdicts[]`, tied
   to its items.

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
- **Bars before sign-off.** Each reading names its command, checked against
  installed `--help`. A reading with no command is a STOP before sign-off.
  Loop bars are in rig-c/create `docs/INTERVIEW.md`, "Bars have reading commands".
- **Appearance needs a person.** Whole-piece or moving-image calls go to
  `rig-review` (rig) or `direction-review` (post), with measured context, not
  step bars. See rig-c/create `docs/INTERVIEW.md`, "Appearance belongs to a person's review".
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
  rig version's config, kept in `evidence/v<N>/`, sets `trace_parts: true` in
  `assemble.editor_receipts` and names a `requirements` file with
  `seam_over_motion.required: true` and `boundary_colour.max_step_excess: 12`.
  Refusals are the art's to fix.
- **The bust is meshed**: a `contour` torso with `contour.bust`, unless the
  `meshes` guide excludes it; then pass the parts opt-out (rig-c/parts#986)
  and its reason.
- **Overlaps.** A piece over a part with its own animation (glasses over
  eyelids) holds none of that part's pixels, or the animation shows its copy.
- **Pairs.** Left/right bust, eyes, hair ends, hem panels: measure symmetry
  (both present, comparable area, mirrored edges) and compare to the painting
  before calling a pair uneven ({{GATES_LINK}}).
- **Look before the user does**, at native resolution and every boundary the
  crux names: a whole-figure |composite − painting| map, every component listed
  by box and part with a status (in the painting / fixed / left, why). Use the
  true stack of part images, not a render flattened on white; crop on white and
  on mid-grey, as white hides light fringes. Eye boxes a
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

User references go in `inputs/references/`; record sha256 in `project.json` `inputs[]`.

## What to read, and why

Read each before its step.

{{READ_FIRST}}

Read installed package docs at `package.json`'s pins. They match the tools you
run, so read them here, not from memory. When a refusal gives a
`(see … guide …)` command, run it before making changes.

{{PACKAGE_DOCS}}

Project organisation is documented in rig-c/create, which is not installed here.

{{CREATE_DOCS}}
