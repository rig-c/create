# Agent reference

## Before you ask, plan or show

- **Projection.** Ask and record it per [CHECKS.md § Projection and ground](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#projection-and-ground).
- **Camera options.** Offer fixed view or camera-box moves only. Head turn,
  depth and plate parallax are unavailable: direction has no depth/turn fields.
- **Upscale first** a painting smaller than the rig needs (SOURCE.md, step 2 below).
- **The crux is a bar.** Before rigging, name every risk band, count background
  or doubled pixels over every frame and both physics/breath extremes, and
  report the maximum and its frame. Cover every band crossing another bone.
- **Appearance needs a person**, not a step bar: [CHECKS.md § Appearance bar wording](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#appearance-bar-wording).
- **Nothing unnamed.** Add no unnamed motion, chain or physics. Read references
  for what they show; ask about anything more.
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
- **Look before the user does**, at native resolution and every crux boundary:
  a whole-figure |composite − painting| map, each component by box/part and
  status (in the painting / fixed / left, why). Use the true part stack; crop on
  white and mid-grey to show light fringes. Check beyond reviewer-chosen boxes.

## What to read, and why

1. **Before the interview**: INTERVIEW.md; CRAFT.md (waypoint defaults);
   parts AUTHORING §3, *`config.json`, field by field*;
   [CHECKS.md](https://github.com/rig-c/create/blob/main/docs/CHECKS.md) before a sign-off.
2. **Before `seethrough` and `assemble`**: SOURCE.md, split/cut order:
   [bad-split reruns](https://github.com/rig-c/create/blob/main/docs/SOURCE.md#re-run-first),
   [allowed cuts](https://github.com/rig-c/create/blob/main/docs/SOURCE.md#where-a-cut-is-allowed);
   parts AUTHORING *See-through head-run source reading*, *Source before
   scissors* and *Limbs: cut at their joints*.
3. **Before rigging**: [CRAFT.md § For the gates](https://github.com/rig-c/create/blob/main/docs/CRAFT.md#for-the-gates-not-the-interview)
   (G1–G9); core RIGGING and MOTION; parts AUTHORING §7, the bars `check` enforces.
4. **Before showing the user**: [LESSONS.md § The self-check](https://github.com/rig-c/create/blob/main/docs/LESSONS.md#the-self-check),
   the [per-frame seam count](https://github.com/rig-c/create/blob/main/docs/LESSONS.md#count-the-seam-bar-over-every-frame),
   [what to show first](https://github.com/rig-c/create/blob/main/docs/LESSONS.md#what-to-show-the-user-first).
