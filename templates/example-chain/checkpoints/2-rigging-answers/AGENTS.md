# Agent guide

One painting in, one rig and its takes out. Read this first; no chat history needed.

## Start here

1. Read `project.json` first. Only its decisions count. Copy chat decisions
   verbatim, with speaker and time.
2. Resume per [PROJECT.md § How an agent resumes a project](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#how-an-agent-resumes-a-project). Read `stage`, last `signoffs[]`, first
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
- Before asking the user to sign the interview, check that no answer belonging to that interview is `null` ([INTERVIEW.md § Every item has an owner](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md#every-item-has-an-owner)).

## The user's four steps

1. **Parts and meshes**. Ask framing/source; review parts and a labelled draft's
   mesh/chest structure. `signoff parts-review --draft --structure-file` binds decisions.
2. **Rigging interview**. Ask fresh bones, deformation, physics and motion
   against approved parts/structure; use interview-options/answer/decision.
3. **Rig and animation**. Hand pass is rig-review's correction loop; keep feedback.
4. **Direction**. Ask after rig acceptance; judge at direction-review.

Use `advance <stage>`, `step-status <id>`.

Drafts stay under `derived/drafts/<id>/`, never versions/handoff. Old records
warn: preserve history and dates; adopt choices explicitly.

## Before you ask, plan or show

- **Prior words.** In adopted projects, show them verbatim as a tailored option
  with source/date; require a pick. Legacy derivation: [INTERVIEW.md § Derived answers](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md#derived-answers).
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
  before calling a pair uneven ([CRAFT.md G8](https://github.com/rig-c/create/blob/main/docs/CRAFT.md#for-the-gates-not-the-interview)).
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

1. **Before the interview**: INTERVIEW.md, and CRAFT.md for the default at each
   waypoint (both linked below); parts AUTHORING §3, *`config.json`, field by
   field*; [CHECKS.md](https://github.com/rig-c/create/blob/main/docs/CHECKS.md) before a sign-off.
2. **Before `seethrough` and `assemble`**: SOURCE.md, the order of the split and
   the cut: [re-running a bad split](https://github.com/rig-c/create/blob/main/docs/SOURCE.md#re-run-first),
   [where a cut is allowed](https://github.com/rig-c/create/blob/main/docs/SOURCE.md#where-a-cut-is-allowed);
   then parts AUTHORING *See-through head-run source reading*, *Source before
   scissors* and *Limbs: cut at their joints*.
3. **Before rigging**: [CRAFT.md § For the gates](https://github.com/rig-c/create/blob/main/docs/CRAFT.md#for-the-gates-not-the-interview)
   (G1–G9); core RIGGING and MOTION; parts AUTHORING §7, the bars `check` enforces.
4. **Before showing the user**: [LESSONS.md § The self-check](https://github.com/rig-c/create/blob/main/docs/LESSONS.md#the-self-check),
   the [per-frame seam count](https://github.com/rig-c/create/blob/main/docs/LESSONS.md#count-the-seam-bar-over-every-frame),
   [what to show first](https://github.com/rig-c/create/blob/main/docs/LESSONS.md#what-to-show-the-user-first).

Read installed docs here at `package.json`'s pins to match tools, not memory.
Run refusal `(see … guide …)` commands before changes.

- [@rig-c/parts README.md](node_modules/@rig-c/parts/README.md): painting-to-rig pipeline and command order.
- [@rig-c/parts docs/AUTHORING.md](node_modules/@rig-c/parts/docs/AUTHORING.md): config fields, interview waypoints and refusal remedies.
- [@rig-c/parts docs/PAINTING.md](node_modules/@rig-c/parts/docs/PAINTING.md): what makes a painting riggable, and the check to run on it before See-through.
- [@rig-c/parts docs/DEPTH.md](node_modules/@rig-c/parts/docs/DEPTH.md): when the plan has a head turn driven by depth.
- [@rig-c/parts docs/STABILITY.md](node_modules/@rig-c/parts/docs/STABILITY.md): stable commands, fields and outputs.
- [@rig-c/parts docs/MIGRATION.md](node_modules/@rig-c/parts/docs/MIGRATION.md): only when the pinned version is bumped.
- [@rig-c/core README.md](node_modules/@rig-c/core/README.md): rigc scope, commands and documentation.
- [@rig-c/core docs/AUTHORING.md](node_modules/@rig-c/core/docs/AUTHORING.md): rig/motion formats, build loop and failure remedies.
- [@rig-c/core docs/RIGGING.md](node_modules/@rig-c/core/docs/RIGGING.md): bones and pivots at the bones waypoint.
- [@rig-c/core docs/MOTION.md](node_modules/@rig-c/core/docs/MOTION.md): key-pose motions at the motion waypoint.
- [@rig-c/core docs/FACE.md](node_modules/@rig-c/core/docs/FACE.md): blink, gaze and head-turn plans.
- [@rig-c/core docs/INGEST.md](node_modules/@rig-c/core/docs/INGEST.md): only when you were handed a skeleton this project did not author.

Project organisation: rig-c/create docs (not installed).

- [docs/PROJECT.md](https://github.com/rig-c/create/blob/main/docs/PROJECT.md): the folder, stages and sign-offs, the plan, versions, and `project.json` field by field.
- [docs/INTERVIEW.md](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md): how to ask, and the shape every answer, delegation and piece of feedback takes.
- [docs/CRAFT.md](https://github.com/rig-c/create/blob/main/docs/CRAFT.md): the default to propose at each waypoint.
- [docs/COLLECTIONS.md](https://github.com/rig-c/create/blob/main/docs/COLLECTIONS.md): when this project is a member of a collection.

In parts, record a head-crop preflight with intake-report, then offer the optional report-bound intake_suitability choice. Counts are advisory and never block approval; this cannot save the first full run. Colour-adjacent ground and enclosed ground are known-not-predicted (two failed model-sweep rounds on a pilot), without thresholds.
