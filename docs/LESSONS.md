# Lessons: what to check before anyone looks

Review lessons that apply to any rig, written so the next rig does not repeat
them. The page opens with the self-check every project runs by default before a
version is shown; the lessons after it say why each check exists and how to
read it.

Each lesson is a *rule*, *why* and *how to check*. Where the rule already lives
in a craft note ([CRAFT.md](CRAFT.md)), the split know-how ([SOURCE.md](SOURCE.md))
or a rig-c/parts section, it is linked, not restated. The parts links point at
the version a new project pins (2.4.0); in a project, read the same files under
`node_modules/@rig-c/parts/`.

Every rule carries its source: a craft note, a parts section, an owner ruling
with its date, or a pilot measurement with its date.

## The self-check

Three items, run on every version before anyone looks, as the default. Each says
what the defect looks like, how to measure it, and what to do when it fires.
*Source*: owner ruling, 2026-11-03.

### Min and max by default, tears always

- **Looks like**: background or another layer showing through the figure (a
  `tear`) at some frame of a motion, usually at an extreme.
- **Measure**: for every animation, render the setup pose, the min and max
  extreme frames and `|max − min|` at native scale. Check for tears on every run,
  not only where the user's crux names a band. The tear count is the
  [per-frame seam count](#count-the-seam-bar-over-every-frame).
- **When it fires**: the defect is in the rig or its source, never the user's to
  accept: fix the cut, mesh or source ([SOURCE.md](SOURCE.md#re-run-first)) and
  measure again. See [CRAFT.md G1](CRAFT.md#for-the-gates-not-the-interview).

### Grey lines at seams

- **Looks like**: a thin grey or dark line along a part boundary — edge pixels
  blended toward grey or black by premultiplied edges, padding bleed, or a matte
  that was not removed.
- **Measure**: crop every part boundary at native scale and 4× nearest-neighbour,
  on a sentinel colour. A line darker or greyer than the painting at that place
  is a defect. [CRAFT.md G2](CRAFT.md#for-the-gates-not-the-interview) is the
  nearest gate row (the colour step across a boundary).
- **When it fires**: find where the edge was blended — an export that
  premultiplied the alpha, a packer's padding, a matte left on — and fix it at
  that step, then crop again. A light line instead of a dark one points at a
  white flatten ([SOURCE.md](SOURCE.md#upscale-a-small-source-first)).

### Specks and holes in the split layers

- **Looks like**: small loose dots of colour apart from a part (specks), and
  transparent pinholes inside it (holes), in the part images straight out of
  See-through.
- **Measure**: on each layer PNG from the split, before `assemble`, on a sentinel
  colour. Islands are 8-connected regions of alpha above 8. An island under 64 px
  is a speck *candidate*; it is a speck only when the painting has no matching
  content there (it lies outside the figure's silhouette, or its colour does not
  match the painting at that place). Islands of 64 px or more, and candidates
  that match the painting, are content. A hole is a transparent pixel inside the
  layer's own silhouette (its alpha with enclosed regions filled). Report both
  counts, specks and holes, per layer.
- **When it fires**: re-run the split first
  ([SOURCE.md § Re-run first](SOURCE.md#re-run-first)), not a cleanup in code.
  This is [CRAFT.md G9](CRAFT.md#for-the-gates-not-the-interview), caught at the
  split, earlier than G4's pinholes at rest.
- *Source*: owner ruling, 2026-11-03; the 64 px candidate rule and the colour
  match, pilot measurement, 2026-11-03.

## What to show the user first

Show the self-check first: the setup, the extremes and `|max − min|` per
animation, the boundary crops labelled, the whole-figure diff map with every
component listed, and the seam counts as max and frame. Then the motion, on the
path that shows it (a gaze path for depth, never a sweep). A defect found by the
self-check is fixed before the version is shown, not shown with a question.

- **Why**: the user judges direction; a defect they find is a check the agent
  skipped, and it costs a whole review.
- *Source*: owner ruling, 2026-11-03.

## The lessons

### Extremes and boundaries before anyone looks

- **Rule**: before anyone looks, have setup, the min and max extreme frames and
  `|max − min|` per animation at native scale, and every changed part boundary
  cropped native and 4× nearest-neighbour, each crop labelled `tear`, `ghost` or
  `clean`, with a written look beside the metrics.
- **Why**: a metric can pass on a defect it was not built for; a written look
  names what the metric missed.
- **How to check**: the crops exist for every boundary the version changed, each
  has a label, and the look is in words, not only numbers.
- *Source*: owner ruling, 2026-11-03.

### Count the seam bar over every frame

- **Rule**: a seam bar is counted over **every** frame of every animation —
  background pixels inside the figure's silhouette, reported as the max and its
  frame — never read from sampled frames. It includes both extremes of every
  physics and breath motion.
- **Why**: a tear opens for a few frames; sampled frames miss it, and a loop that
  looks closed at every sample still tears in motion.
- **How to check**: the report names the frame count rendered, equal to the
  animation's frame count, and the max with its frame.
  [CRAFT.md G1](CRAFT.md#for-the-gates-not-the-interview) is the gate row; parts'
  `SEAM_OVER_MOTION` covers only some pairs as a bar (parts AUTHORING
  [§7](https://github.com/rig-c/parts/blob/v3.7.0/docs/AUTHORING.md#7-the-bars-check-enforces-and-what-only-an-eye-answers-today)).
- *Source*: owner ruling, 2026-11-03.

### Inspect motion on a sentinel colour

- **Rule**: inspect motion and crops on a sentinel colour (one the painting does
  not use), as well as on white; not on a grey near the art.
- **Why**: a grey near the art hides grey seam lines and tears that show it; white
  hides light fringes.
- **How to check**: every crop and motion check names its background, and one of
  them is a sentinel colour.
- *Source*: owner ruling, 2026-11-03.

### Look at the true stack

- **Rule**: look at the true stack of part images, not a render flattened on
  white; crop on white and on a mid-grey or sentinel colour; make a whole-figure
  |composite − painting| map with every component listed.
- **Why**: a flattened render on white hides light fringes and holes over white
  canvas; a list of boxes someone chose misses a seam outside them.
- **How to check**: as the agent guide says, in its section *Before you ask, plan
  or show* ([templates/agent-guide.md](../templates/agent-guide.md#before-you-ask-plan-or-show)).
- *Source*: pilot measurement, 2026-11-03.

### Judge a painted part by its pixels, not its bone axis

- **Rule**: a painted part is judged by its rendered pixels, not by its bone's
  axis or angle.
- **Why**: a bone can sit at the right angle while the painted part it carries
  reads crooked, and the viewer sees only the pixels.
- **How to check**: the verdict on a part's pose cites a render of the part, not a
  bone value.
- *Source*: owner ruling, 2026-11-03.

### Show depth on a gaze path, not a sweep

- **Rule**: depth is shown on a gaze path (yaw and pitch together, uneven speed,
  holds) or combined with an arm turn, never a dial sweep. A sweep finds defects
  only.
- **How to check**: the take shown has both axes moving, uneven timing and at
  least one hold.
- *Source*: [CRAFT.md P2](CRAFT.md#p2-show-depth-on-a-gaze-path-not-a-sweep);
  owner ruling, 2026-11-03.

### Cloth and hair are physics; a hem over nothing stays down; a small breath

- **Rule**: cloth and hair move on physics, not keys; a hem with nothing painted
  under it stays down; breath is small, with no squash.
- **How to check**: no key track on a cloth or hair bone; the hem's lift never
  shows empty canvas under it at any frame; the breath does not stretch the torso,
  and the hips hold still.
- *Source*: [CRAFT.md C1](CRAFT.md#c1-hair-and-loose-cloth-on-physics-soft-enough-to-trail),
  [C3](CRAFT.md#c3-a-hem-over-nothing-stays-down),
  [Mo1](CRAFT.md#mo1-a-small-breath-the-body-must-not-squash); owner ruling,
  2026-11-03.

### A fix is never a repaint or a changed motion offered to the user

- **Rule**: a defect is fixed in the rig or its source. A repaint of the painting
  or a change of motion is never offered to the user as the way out of it.
- **Why**: the user chose the painting and the motion; trading them away for a
  defect moves the agent's work onto the user's decisions.
- **How to check**: a version's change list names the rig or source change for
  each defect fixed; none reads "changed the motion" or "repainted" for a defect.
- *Source*: [CRAFT.md § For the gates](CRAFT.md#for-the-gates-not-the-interview);
  owner ruling, 2026-11-03.
