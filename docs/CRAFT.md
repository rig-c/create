# Craft notes

Lessons learned from rigs that were sent back in review, written down so the next
interview starts from them instead of repeating them. Each note is filed under the
waypoint where it is asked (see [INTERVIEW.md](INTERVIEW.md) for the waypoints and
the answer shape) and carries the default the interviewer proposes there.

**A note is a proposal, never a decision.** The interviewer reads the default out
("Usually … — shall we?") and records the user's answer verbatim as the guide for
that waypoint. A "yes" is what makes the default the user's; a different answer
replaces it. A note is never ground for the agent to decide alone, and a default
nobody was asked about decides nothing.

**Direction and execution are kept apart.** A note here is a design call: a
reasonable user could answer it either way. A seam, a hole or a smeared plate is
not a design call — nobody would answer "yes" to it — so it is never asked at the
interview. Those defects are listed at the end, [for the gates](#for-the-gates-not-the-interview),
with the bar that would catch each.

Each note has the same shape: the lesson, why it matters, the waypoint, and the
proposed default.

## Framing

### F1. Two kinds of rig

- **Lesson**: an illustration brought to life and a character made to perform are
  different rigs. Walking, running and other travelling motion belong only to the
  second.
- **Why**: treating a still illustration as a performer invites motion the
  painting cannot carry — feet, a ground line and a back it never drew — and the
  result reads as a puppet instead of a living picture.
- **Waypoint**: `rig_type`
- **Proposed default**: "This reads as an illustration to bring to life — usually
  idle breath, expression, and hair and cloth on physics, with no walking or
  running. Shall we?"

### F2. What the painting leaves out stays out

- **Lesson**: what the painting does not show is not a defect to repair, and no
  part is invented to fill it.
- **Why**: a part invented outside the frame — legs below the crop, a hidden
  back — has no painted source, so it never matches the style and draws the eye
  to exactly what the composition chose to hide.
- **Waypoint**: `rig_type`
- **Proposed default**: "Usually what lies outside the painting — legs below the
  frame, a hidden back — stays out, and the rig works with what is drawn. Shall
  we?"

## `seethrough`

No note yet.

## `assemble`

### A1. Cut the bust, not the waist

- **Lesson**: give the chest its own part, so it can carry volume and motion,
  rather than cutting the torso across the waist.
- **Why**: a waist cut is the seam the eye watches most during a breath, and it
  opens; a separate bust part moves on its own without any seam across the body.
- **Waypoint**: `assemble`
- **Proposed default**: "Usually the bust is its own part and the torso is not
  cut at the waist. Shall we?"

### A2. Limbs that bend are cut at the joint and rounded

- **Lesson**: an arm or leg that has to bend is cut at the elbow or knee, with the
  seam rounded in an image editor, and bends only within a small range; a larger
  bend is a replacement drawing.
- **Why**: a limb cut anywhere else, or bent further than its overlap covers,
  shows a straight cut edge or a gap at the joint.
- **Waypoint**: `assemble`
- **Proposed default**: "Usually an arm or leg that bends is cut at the elbow or
  knee with a rounded seam and bends only a little; anything bigger gets its own
  drawing. Shall we?"

### A3. Soften a cut through skin, not a designed edge

- **Lesson**: a cut through continuous skin gets a soft alpha edge; a cut along
  an edge the design already draws stays hard.
- **Why**: a hard edge across bare skin shows as a line when the parts move apart
  by a pixel, while softening an edge the artist drew on purpose — a cuff, an
  armour plate — blurs the design.
- **Waypoint**: `assemble`
- **Proposed default**: "Usually a cut across bare skin gets a soft edge, and a
  cut on a drawn edge such as a cuff or an armour plate stays sharp. Shall we?"

### A4. The user marks where the arm ends and the sleeve begins

- **Lesson**: where an arm and its sleeve share one layer, the boundary between
  them is a design call shown to the user before rigging, and only the sleeve side
  moves on physics.
- **Why**: a boundary guessed by the agent puts skin on the cloth chain or cloth
  on the rigid arm, and either one is only noticed in motion.
- **Waypoint**: `assemble`
- **Proposed default**: "Usually we show you where the arm ends and the sleeve
  begins before rigging, and only the sleeve sways. Shall we?"

### A5. Variants of one character live in one rig

- **Lesson**: outfits or other variants of one character are swappable sets in one
  rig, not one rig per variant.
- **Why**: one rig per variant multiplies every later fix and lets the variants
  drift apart in bones and motion. In a collection this is answered once, at the
  collection level, and inherited by its members.
- **Waypoint**: `assemble`
- **Proposed default**: "Usually each character is one rig with its outfits as
  swappable sets. Shall we?"

## `bones`

### B1. Hands are not cloth

- **Lesson**: hands and arms ride their own bones, driven by keys, never the tip
  of a cloth chain.
- **Why**: a hand weighted to the soft end of a sleeve's physics chain flaps like
  a paper doll whenever the sleeve moves.
- **Waypoint**: `bones`
- **Proposed default**: "Usually arms and hands get their own bones and stay
  rigid, with the sleeve swaying around them. Shall we?"

## `meshes`

### M1. The torso bends as one piece

- **Lesson**: the torso bends as one weighted mesh, not as cut pieces moved
  rigidly.
- **Why**: rigid pieces moved against each other open at the seam, and the
  background shows through the body in motion even when every still frame looks
  closed.
- **Waypoint**: `meshes`
- **Proposed default**: "Usually the torso is one piece that bends with the
  breath. Shall we?"

## `constraints`

### C1. Hair and loose cloth on physics, soft enough to trail

- **Lesson**: hair and loose cloth move on physics, soft enough to trail the body.
  The rig supplies the response; the consumer supplies the wind.
- **Why**: hair keyed by hand repeats visibly, and a chain stiff enough to hold
  its pose reads as one solid piece — the rig looks stiff even though physics is
  on.
- **Waypoint**: `constraints`
- **Proposed default**: "Usually hair and loose cloth are on physics, soft enough
  to trail the body, and the rig does not bake in a wind of its own. Shall we?"

### C2. Chest volume comes from jiggle

- **Lesson**: a chest reads as having volume when its own part jiggles a beat
  behind the breath.
- **Why**: a chest that moves exactly with the torso reads as painted on, flat.
- **Waypoint**: `constraints`
- **Proposed default**: "Usually the bust jiggles a little, a beat behind the
  breath. Shall we?"

### C3. A hem over nothing stays down

- **Lesson**: a long hem with nothing painted under it moves only so far that the
  empty space beneath never shows.
- **Why**: a hem that swings freely lifts off empty canvas where feet or ground
  should be, and the figure looks like it floats.
- **Waypoint**: `constraints`
- **Proposed default**: "Usually a long hem with no feet painted under it moves
  only slightly. Shall we?"

## `motion`

### Mo1. A small breath; the body must not squash

- **Lesson**: breath is a small rise of the chest with the hips held where they
  are.
- **Why**: a breath large enough to stretch the torso, or one that moves the hips
  with it, reads as the body squashing rather than breathing.
- **Waypoint**: `motion`
- **Proposed default**: "Usually breath is a small chest rise, once per loop, with
  the hips held still. Shall we?"

## Post-production

These are asked after the rig is accepted, never at a rig waypoint: depth and
camera work are direction applied to a finished rig, not part of rigging.

### P1. Depth is judged by eye

- **Lesson**: depth is judged by whether a turn reads as solid beside the
  reference, not by how closely a depth map matches.
- **Why**: a depth map can match well and still turn badly, and a rougher one can
  turn convincingly; only the turn on screen is what the viewer sees.
- **Waypoint**: `camera_depth`
- **Proposed default**: "Usually we judge the 2.5D turn by eye, side by side with
  the reference. Shall we?"

### P2. Show depth on a gaze path, not a sweep

- **Lesson**: depth is shown on an irregular gaze path with pauses, or together
  with a motion such as an arm turn; a steady back-and-forth sweep is for finding
  defects, not for showing depth.
- **Why**: the eye does not read a mechanical sweep as a solid head turning; it
  reads a look that wanders and settles.
- **Waypoint**: `camera_depth`
- **Proposed default**: "Usually the turn is shown as a gaze wandering with
  pauses. Shall we?"

### P3. A head-turn needs an upright head

- **Lesson**: a head already tilted in the painting breaks under a turn; that is a
  limit of the input, not of the tool.
- **Why**: turning a tilted head moves its features along the wrong axis, and the
  skull reads as broken.
- **Waypoint**: `camera_depth`
- **Proposed default**: "This head is already tilted — usually a head-turn is left
  out for such a painting. Shall we?"

### P4. The face turns by depth, within a small range

- **Lesson**: a face turns by depth and change of view, within about ±15° left to
  right and ±12° up and down, and is never rotated flat on the screen.
- **Why**: beyond that range the painted features have nothing behind them, and a
  flat spin reads as the picture rotating, not the head.
- **Waypoint**: `camera_depth`
- **Proposed default**: "Usually the face turns within about ±15° left-right and
  ±12° up-down. Shall we?"

### P5. Depth that is there but invisible reads as flat

- **Lesson**: parallax has to be visible at viewing size.
- **Why**: depth present in the data but spanning only a few pixels across the
  whole figure reads as flat, however correct it is.
- **Waypoint**: `camera_depth`
- **Proposed default**: "Usually the arms visibly lead the body when the view
  turns. Shall we?"

## For the gates, not the interview

These defects were sent back in review, but nobody would answer "yes" to them, so
they are never proposed to the user; the user only sees their absence. Each is a
gate candidate for [rig-c/parts](https://github.com/rig-c/parts), with the bar
that would catch it. The fix belongs in the rig or its source; a repaint or a
change of motion is not offered to the user as the way out of a defect.

| # | Defect | Bar that would catch it | Nearest parts check today |
| --- | --- | --- | --- |
| G1 | Background showing through the torso in motion ("waist tears"); missed when only a few sampled frames were read | 0 background pixels inside the figure band, counted over **every** frame of the loop, not a sample | partial: `SEAM_OVER_MOTION` is a bar for proven body-root pairs and only a warning for internal-joint and explicit seam pairs; `figure_openings` warns, never refuses |
| G2 | A seam line and a colour break across a part boundary, and a square notch at a mesh corner (an image stretched into padded UVs, plus a grid corner) | across every part boundary, the colour step is no larger than the painting's own step at the same place; the outline's turn angle is continuous across the boundary | none named |
| G3 | Kinked folds and a visible seam at rest that the painting does not have, caused by draw order | the setup pose matches the painting within a declared limit, over every part | yes when a limit is declared: `SETUP_MATCHES_PAINTING` (PASS/FAIL, SKIP without a limit); `SETUP_POSE_VS_SOURCE` reports the measurement |
| G4 | Pinholes inside the figure at rest | 0 transparent openings inside the figure silhouette in the setup pose | not as a bar: `figure_openings` warns; `RECOMPOSITE_HOLES` reports, never fails |
| G5 | Background plate residue where the figure was removed: a dark silhouette ghost, pale blurred blocks where a structure behind should continue, a smudged emblem, a colour smear | in a band around the figure mask, 0 figure-coloured pixels on the plate, and the fill continues the structure behind it | none — plates are composed outside the current checks |
| G6 | Plates or character source edited in code (segmentation, patch synthesis, scripted inpainting) instead of in an image editor | every edited image carries an editor receipt; 0 edits without one | none |
| G7 | A part carved out of a layer with a hand-drawn polygon instead of taken from the layer split or another real source; such cuts tear at the edge | every part's pixels trace to a layer of the split or to an editor receipt; 0 parts without a source | none |

The source gives no numeric threshold for G2, G3 and G5 beyond what is written
above; where a limit is needed it is declared per rig, not assumed.
