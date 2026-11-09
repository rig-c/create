# Source: the layer split and the cut

Most bounces are decided before a bone exists: at the layer split (See-through)
and at the cut. This page is what to do there, in what order, and why. Read it
before `seethrough` and before `assemble`.

It is the working order, not the machine contract. The contract — which fields,
which lines `assemble` prints, which refusals fire — is in rig-c/parts
[AUTHORING.md](https://github.com/rig-c/parts/blob/v2.35.0/docs/AUTHORING.md)
and its [README](https://github.com/rig-c/parts/blob/v2.35.0/README.md), linked
here at the version a new project pins (2.4.0) and not copied. In a project, read
the same files under `node_modules/@rig-c/parts/`.

Every rule carries its source: a parts section, an owner ruling with its date,
or a pilot measurement with its date.

## The order

1. [Upscale a small source](#upscale-a-small-source-first), before it goes into
   `inputs/`.
2. [Run the split twice](#two-passes-the-whole-figure-then-the-head): the whole
   figure, then the head.
3. [Check the split](#look-at-the-split-before-calling-it-good): pairs, hidden
   surface, doubled outlines, specks and holes.
4. [Re-run first](#re-run-first) when it is bad. Several runs before any cut.
5. [Cut only for structure](#where-a-cut-is-allowed), and at a limb only at its
   joint.
6. [Edit in the image editor, with a receipt](#the-editor-rung), when re-runs
   cannot fix a visible-pixel defect.
7. [Check density](#density-the-split-against-the-rig) and
   [mixed sources](#mixed-sources) before `assemble` is called done.

## The layer split

### Upscale a small source first

A painting smaller than the rig needs is upscaled before the split, with a 4x
anime upscaler: the RGB upscaled on a black matte, the alpha upscaled separately
as grey, then the two recombined un-premultiplied and alpha below 8 clipped to 0.
A painting already in `inputs/` gets its upscale as a new input; inputs are never
edited.

- **Why**: See-through and every later stage can only lose detail. Upscaling RGB
  and alpha apart keeps the matte colour out of the edge, which an upscale of the
  composited image does not.
- **A light fringe is not from such an upscale.** When a light halo shows along
  an edge, look for a step later in the chain that flattened the image on white.
- *Source*: owner ruling, 2026-10-29/31 (recipe); pilot measurement, 2026-11-03
  (the fringe).

### Two passes: the whole figure, then the head

Run See-through on the whole figure (`st_input_full.png`), then on the head crop
on its own (`st_input_head.png`, cut by `rig-parts inputs` from
`seethrough.head_box`).

- **Why**: on every route that was read, the model's own head stage pastes the
  face back at the full run's pixel density. The separate head run is what gives
  the eyes their pixels.
- *Source*: parts AUTHORING
  [*See-through head-run source reading*](https://github.com/rig-c/parts/blob/v2.35.0/docs/AUTHORING.md#see-through-head-run-source-reading);
  the routes in the parts README,
  [*Getting See-through layers*](https://github.com/rig-c/parts/blob/v2.35.0/README.md#getting-see-through-layers).

### Resolution: check the memory first

Read the model's memory requirement before raising the run's `resolution`. "The
wrapper accepts it" is not "it fits": a 2048 run needs about 24 GB. Do not raise
the full run's resolution to buy face detail; the face gets its density from the
head pass.

- **Why**: a run that does not fit fails or falls back silently, and the time is
  lost either way; the head pass already does what the higher resolution was for.
- *Source*: owner ruling, 2026-10-29/31; pilot measurement, 2026-11-03.

### Look at the split before calling it good

Before `assemble`, on the raw layers:

- **Pairs** (left/right bust, eyes, hair ends, hem panels): both present,
  comparable area, mirrored edge placement, measured on the layers and compared
  with the same measure on the painting, so an asymmetry the painting has is not
  flagged ([CRAFT.md G8](CRAFT.md#for-the-gates-not-the-interview)).
- **Hidden surface**: under every part that will move over another, the part
  behind is painted (amodal), not empty.
- **No doubled outline**: an edge drawn twice, once on each of two layers, is a
  ghost.
- **Specks and holes**, counted on each layer PNG straight out of See-through, on
  a sentinel colour ([LESSONS.md](LESSONS.md#specks-and-holes-in-the-split-layers),
  [CRAFT.md G9](CRAFT.md#for-the-gates-not-the-interview)).
- **Why**: every one of these is cheaper to fix here than after `assemble`,
  where it is mixed with cut and draw-order effects.
- *Source*: owner ruling, 2026-10-29/31; owner ruling, 2026-11-03 (specks and
  holes).

### Re-run first

When the split is bad — an uneven pair, a poor hidden surface behind an arm, a
ghost, specks or holes — re-run before anything else, and record what each run
measured:

1. another layer or run: `full` versus `head`, another tag, `assemble.alternates`;
2. a tighter crop pass of the bad region, on its own;
3. other settings (a resolution that fits in memory, another run of the same input).

Several runs are cheaper than one bounce. Only when re-runs cannot fix a
visible-pixel defect does the [editor rung](#the-editor-rung) come next.

- **Why**: a defect in the split is a source problem, and a source problem
  patched downstream comes back at every motion extreme.
- *Source*: parts AUTHORING
  [*Source before scissors*](https://github.com/rig-c/parts/blob/v2.35.0/docs/AUTHORING.md#source-before-scissors)
  (the repair ladder: another layer or run, a re-run, then config); owner ruling,
  2026-10-29/31 (re-run first, several runs before a cut).

## Cutting

### Where a cut is allowed

**Scissors are for structure, never for repair.** A cut (`assemble.cuts`, a patch,
an `author:<label>` layer) is admitted only to separate something that must move
or draw on its own and has no layer:

- a joint (an arm or a leg, [below](#at-a-limb-joint));
- an accessory still inside its parent's layer;
- a rear piece that needs its own draw position;
- **a draw-order split**: two arms on opposite sides of a held object are
  separate parts, even though they never move apart.

A tear, ghost, smudge, stray outline or seam is repaired from the source (the
[re-run ladder](#re-run-first)), never by a cut-out or an under-piece. No hand
polygon where the piece has no material past its joint: no source means stop and
name the gap.

- **Why**: a polygon cut supplies no material for the turn it is meant to allow,
  so it tears at the edge in motion; a cut over a defect hides it at rest and
  shows it moving.
- *Source*: parts AUTHORING
  [*Source before scissors*](https://github.com/rig-c/parts/blob/v2.35.0/docs/AUTHORING.md#source-before-scissors)
  (scissors for structure, the cases a cut fits, no material past the joint) and
  its paragraph *A layer the author made*; owner ruling, 2026-10-29/31; pilot
  measurement, 2026-11-03 (the draw-order split).

### At a limb joint

At an arm or leg joint, and only there: cut in the image editor and round the
seam with its smudge tool. The limb is still separate rigid parts, one bone each;
it is never one mesh bent across the joint (`LIMB_ONE_BONE`).

- **Why**: a limb cut anywhere else, or bent as one mesh, shows a straight edge
  or a grotesque bend.
- *Source*: parts AUTHORING
  [*Limbs: cut at their joints*](https://github.com/rig-c/parts/blob/v2.35.0/docs/AUTHORING.md#limbs-cut-at-their-joints-limbs-issue-349);
  [CRAFT.md A2](CRAFT.md#a2-limbs-that-bend-are-cut-at-the-joint-and-rounded);
  owner ruling, 2026-10-29/31.

### The editor rung

The rung after re-runs: a piece taken from the painting along its painted
outlines, in an image editor, with See-through's own alpha loaded as the
selection where no line is painted. Refine the edge with a slight outward shift
and feather 0. Missing material: content-aware fill, clone stamp, healing brush.
Every edit leaves a receipt: the commands, the input and output hashes, and a
layered file saved beside the PNG.

**Never a polygon in code or config, and never a per-pixel repair in code.**
See-through stays the source for hidden surface.

One exception covers step-4 plates only: a receipted generative plate pass from a
package command is a source, not a repair. The parts plate command removes the
figure from the background, or mattes the foreground, using a mask from a source
(See-through figure layers or the declared figure mask). Its
`rig-parts-plate-receipt/1` receipt records the painting, mask, model, every
parameter, the GPU and the output by hash. Character parts and joints never take
this route.

Measured limits:

- an anti-aliased edge that sits inward reads light on white; the outward shift
  fixes it;
- a fill holds flat colour but does not continue an outline.

- **Why**: an edit with a receipt can be checked and redone; a scripted edit
  cannot be told from a defect ([CRAFT.md G6, G7](CRAFT.md#for-the-gates-not-the-interview)).
- *Source*: owner ruling, 2026-10-29/31 (editor and receipt, the fill limit);
  pilot measurement, 2026-11-03 (outline selection, alpha where no line, shift
  outward, feather 0, the inward-edge limit).

### Feather only continuous skin

Feather a cut face only on continuous skin (a bare arm below a short sleeve);
keep a designed cut face (a cuff, an armour plate) crisp.

- *Source*: [CRAFT.md A3](CRAFT.md#a3-soften-a-cut-through-skin-not-a-designed-edge);
  owner ruling, 2026-10-29/31.

## Density: the split against the rig

When the split's canvas is coarser than the rig, every split layer is upscaled
into the rig and reads softer than the painting. Measure the edge rise width
(10–90 % of the step, across an outline) on the parts and on the painting at the
same place. A rig scale near the guide value (parts AUTHORING, `assemble.rig_scale`
in [*`config.json`, field by field*](https://github.com/rig-c/parts/blob/v2.35.0/docs/AUTHORING.md#3-configjson-field-by-field):
the figure about 1,100 to 1,200 rig px tall) can close it. When the guide value
is at least as good on every figure measured, the guide value wins.

- **Why**: softness is not a seam, so no bar reads it, and it shows only beside
  the painting.
- *Source*: pilot measurement, 2026-11-03.

## Mixed sources

When a plan mixes runs (`full` and `head`), keep every run's manifest
(`layers.json`) entries listed, including the entries the plan does not take from
that run. Do not unlist the other run's copies of those regions.

- **Why**: an entry that no planned part takes still holds depth ownership
  (`pixelOwners`) in its run, which stops a neighbouring planned part from
  claiming its pixels. Measured on a pilot (`full` + `head`, same layer PNGs byte
  for byte), unlisting the unused entries changed 12 of 24 planned parts (`face`
  5,424 px, `hair_back` 2,679 px, `neck` 1,575 px, `hair_front` 402 px, and 8
  parts under 100 px) and baked the face and eyes into the back hair, hair
  strands into the face, and the chin line into the neck; with the entries kept
  listed, all three were clean.
- *Source*: pilot measurement, 2026-11-07.
