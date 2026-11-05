# Agent guide

One painting in, one rig and its takes out. Read this first; no chat history needed.

## Start here

1. Read `project.json` first. Only its decisions count. Copy chat decisions
   verbatim, with speaker and time.
2. Resume per {{RESUME_LINK}}. Read `stage`, last `signoffs[]`, first
   `plan.steps[]` not `done`, and last `versions[]` for status and next work.

## The order, and what you may not do

`interview` → `plan-approved` → `parts` → `parts-review` (the parts, by eye) →
`rigging-interview` → `rigging` → `rig-review` (the rig, still frame) → `post-interview` → `post` →
`direction-review` → `accepted`. Any stage can become `paused`.

- `plan-approved` approves source/parts steps. Production rigging waits for
  `parts-review` and the later `rigging-interview` sign-off. Only a labelled
  draft may have proposed bones/weights for earlier mesh/chest inspection.
- Only a person's `signoffs[]` advances `stage` or passes a plan checkpoint.
  You may draft, propose, build and measure in any stage.
- Never derive answers from the image. Offer a pick per ask, with one reasoned
  recommendation, Other and auto. Retain the shown set; never preselect.
- Record "auto" as delegated, with your decision on the item. It is never a
  blank for you to fill later.
- {{INTERVIEW_CHECK}}

## The user's four steps

1. **Parts and meshes**. Ask framing/source; review parts and a labelled draft's
   mesh/chest structure. `parts-review --draft --structure-file` binds decisions.
2. **Rigging interview**. Ask fresh bones, deformation, physics and motion
   against approved parts/structure; use interview-options/answer/decision.
3. **Rig and animation**. Hand pass is rig-review's correction loop; keep feedback.
4. **Direction**. Ask after rig acceptance; judge at direction-review.

Drafts stay under `derived/drafts/<id>/`, never versions/handoff. Old records
warn: preserve history and dates; adopt choices explicitly.

## Before you ask, plan or show

- **Prior words.** In adopted projects, show them verbatim as a tailored option
  with source/date; require a pick. Legacy derivation: {{DERIVED_LINK}}.
- **Projection.** Ask core/visible, then plain/busy only for visible. Record the
  assemble guide values and write `assemble.project`/`assemble.ground` in config.
- **Upscale first.** A painting smaller than the rig needs is upscaled before it
  goes into `inputs/`; one already there gets its upscale as a new input.
- **The crux is a bar.** Before rigging, name every risk band, count background
  or doubled pixels over every frame and both physics/breath extremes, and
  report the maximum and its frame. Cover every band crossing another bone.
- **Bars before sign-off.** Each reading names its command, checked against
  installed `--help`. A reading with no command is a STOP before sign-off.
  Loop bars are in rig-c/create `docs/INTERVIEW.md`, "Bars have reading commands".
- **Appearance needs a person.** Whole-piece or moving-image calls go to
  `rig-review` (rig) or `direction-review` (post), with measured context, not
  step bars. See rig-c/create `docs/INTERVIEW.md`, "Appearance belongs to a person's review".
- **Nothing unnamed.** Add no motion, chain or physics the user did not name. A
  reference ("move like X") is read for what it shows; anything more is a
  question, not a default.
- **Re-run first.** Retry bad splits/hidden surfaces with other settings/crops
  several times before cutting. Only then take visible fixes from the painting
  along painted outlines, See-through alpha where no line exists, feather 0,
  with a receipt. Never cut polygons in code/config. Hidden surfaces stay See-through.
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

References: `inputs/references/`, with sha256 in `inputs[]`.

## What to read, and why

Read each before its step.

{{READ_FIRST}}

Read installed docs here at `package.json`'s pins to match tools, not memory.
Run refusal `(see … guide …)` commands before changes.

{{PACKAGE_DOCS}}

Project organisation: rig-c/create docs (not installed).

{{CREATE_DOCS}}
