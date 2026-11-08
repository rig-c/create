# Agent guide

One painting in, one rig and its takes out. Read this first; no chat history needed.

## Start here

1. Read `project.json` first. Only its decisions count. Copy chat decisions
   verbatim, with speaker and time.
2. Resume per [PROJECT.md § How an agent resumes a project](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#how-an-agent-resumes-a-project).

## The order, and what you may not do

`interview` → `plan-approved` → `parts` → `parts-review` (the parts, by eye) →
`rigging-interview` → `rigging` → `rig-review` (the rig, still frame) → `post-interview` → `post` →
`direction-review` → `accepted`. Any stage can become `paused`.

- Only a person's `signoffs[]` advances `stage` or passes a plan checkpoint.
  You may draft, propose, build and measure in any stage; production rigging
  waits for `rigging-interview` ([PROJECT.md § Stages](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#stages)).
- Never derive answers from the image. Offer a pick per ask, with one reasoned
  recommendation, Other and auto. Retain the shown set; never preselect.
- Record "auto" as delegated, with your decision on the item. It is never a
  blank for you to fill later.
- Before asking the user to sign the interview, run `rig-create interview --check`: it names every `null` answer.

## The user's four steps

1. **Parts and meshes**. Ask framing/source; review parts and a labelled draft's
   mesh/chest structure. `signoff parts-review --draft --structure-file` binds decisions.
2. **Rigging interview**. Ask fresh bones, deformation, physics and motion
   against approved parts/structure; use interview-options/answer/decision.
3. **Rig and animation**. Hand pass is rig-review's correction loop; keep feedback.
4. **Direction**. Ask after rig acceptance; judge at direction-review.

Use `advance <stage>`, `step-status <id>`; see `rig-create --help`.
`advance parts-review` needs `--parts-check <report> --parts <assembled dir>`,
refusing [`PARTS_CHECK_MISSING`, `PARTS_CHECK_UNREAD`, `PARTS_CHECK_INVALID`, `PARTS_CHECK_CHANGED`, `PARTS_CHECK_FAILED`, `PARTS_CHECK_STALE`](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#parts-stage-check-at-the-parts--parts-review-move).
In `parts`, record an `intake-report` preflight and offer its choice, both advisory:
[PROJECT.md § Advisory intake reports](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#advisory-intake-reports).

Drafts stay under `derived/drafts/<id>/`, never versions/handoff. Old records
warn: preserve history and dates; adopt choices explicitly.

## Before you ask, plan or show

- **Prior words.** In adopted projects, show them verbatim as a tailored option
  with source/date; require a pick. Legacy derivation: [INTERVIEW.md § Derived answers](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md#derived-answers).
- **Projection.** Ask and record it per [CHECKS.md § Projection and ground](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#projection-and-ground).
- **Upscale first** a painting smaller than the rig needs (SOURCE.md, step 2 below).
- **The crux is a bar.** Before rigging, name every risk band, count background
  or doubled pixels over every frame and both physics/breath extremes, and
  report the maximum and its frame. Cover every band crossing another bone.
- **Bars before sign-off.** Each reading names its command, checked against
  installed `--help`. A reading with no command is a STOP before sign-off.
  Loop bars: INTERVIEW.md, "Bars have reading commands".
- **Appearance needs a person**, not a step bar: [CHECKS.md § Appearance bar wording](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#appearance-bar-wording).
- **Nothing unnamed.** Add no motion, chain or physics the user did not name. A
  reference ("move like X") is read for what it shows; anything more is a
  question, not a default.
- **Re-run first, cut last**, never a polygon in code or config: the ladder in
  SOURCE.md, step 2 below.
- **A full-screen scene is a CG build.** For `rig_type` `fullscreen.*`, each
  rig version declares the gates in [CHECKS.md § CG gates](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#cg-gates). Refusals are the art's to fix.
- **The bust is meshed** unless the `meshes` guide excludes it with a reason
  ([CHECKS.md § The bust at meshes](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#the-bust-at-meshes)).
- **Overlaps.** A piece over a part with its own animation (glasses over
  eyelids) holds none of that part's pixels, or the animation shows its copy.
- **Pairs.** Measure left/right symmetry against the painting before calling a
  pair uneven ([CRAFT.md G8](https://github.com/rig-c/create/blob/main/docs/CRAFT.md#for-the-gates-not-the-interview)).
- **Look before the user does**, at native resolution and every boundary the
  crux names: a whole-figure |composite − painting| map, every component listed
  by box and part with a status (in the painting / fixed / left, why). Use the
  true stack of part images, not a render flattened on white; crop on white and
  on mid-grey, as white hides light fringes. Eye boxes a
  reviewer chose are not the check: a seam outside them got through.

## Where things go

Each folder's lifetime and git status: [PROJECT.md § Data is split by lifetime](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#data-is-split-by-lifetime).

## What to read, and why

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
