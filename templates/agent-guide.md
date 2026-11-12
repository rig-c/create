# Agent guide

One painting in, one rig and its takes out. Start here.

## Start here

1. Read `project.json` first. Only its decisions count. Copy chat decisions
   verbatim, with speaker and time.
2. Run `rig-create next` to derive the next moves and whose they are.
3. Resume per {{RESUME_LINK}}.

Update stale pins with `rig-create packages upgrade --by <operator>`; see PROJECT.md.

Declare the project's painting with `init --painting <file> --origin <words>`
or `input add <path> --painting --origin <words>`. `project.json.painting` binds
one input and survives restart; only it checks siblings for duplicate artwork.
Older records may omit it.

## The order, and what you may not do

`interview` → `plan-approved` → `parts` → `parts-review` (the parts, by eye) →
`rigging-interview` → `rigging` → `rig-review` (the rig, still frame) → `post-interview` → `post` →
`direction-review` → `accepted`. Any stage can become `paused`.

- Only a person's `signoffs[]` advances `stage` or passes a plan checkpoint.
  You may draft, propose, build and measure in any stage; production rigging
  waits for `rigging-interview` ({{STAGES_LINK}}).
- Never derive answers from the image. Offer a pick per ask, with one reasoned
  recommendation, Other and auto. Retain the shown set; never preselect.
- Record "auto" as delegated, with your decision on the item. It is never a
  blank for you to fill later.
- {{INTERVIEW_CHECK}}

## The user's four steps

1. **Parts and meshes**. Ask framing/source. Review a labelled draft's parts and
   mesh/chest structure. `parts-review` records its Review API response.
   The latest receipt must approve the draft for `structure-snapshot --draft <id> --out <f>`
   and `signoff parts-review --draft <id> --structure-file <f>`; record component triage with `diff-classes --diff-report <p> --by agent` ({{DRAFTS_LINK}}).
2. **Rigging interview**. Ask fresh bones, deformation, physics and motion
   against approved parts/structure; use interview-options/answer/decision.
3. **Rig and animation**. Keep rig feedback.
   Ingest: `review <version> --from-review <actId>`.
4. **Direction**. `job open --rig <post>` asks the verdict only.
   Ingest `review <post> --from-review <actId>`, then `job open --plan` for
   record-page sign-off (source-linked Review).

Ask: `job open --reviewer <id> --role owner --question <id>` or `--plan`;
ingest `--from-review <actId>`, then advance.

Use `advance <stage>`, `step-status <id>`; see `rig-create --help`.
`advance parts-review` needs `--parts-check <report> --parts <assembled dir>`,
refusing {{PARTS_CHECK_LINK}}.
In `parts`, record an `intake-report` preflight and offer its choice, both advisory:
{{INTAKE_LINK}}.

Drafts stay under `derived/drafts/<id>/`, never versions/handoff. Old records
warn: preserve history and dates; adopt choices explicitly.

## Before you ask, plan or show

- **Prior words.** In adopted projects, show them verbatim as a tailored option
  with source/date; require a pick. Legacy derivation: {{DERIVED_LINK}}.
- **Projection.** Ask and record it per {{PROJECTION_LINK}}.
- **Upscale first** a painting smaller than the rig needs (SOURCE.md, step 2 below).
- **The crux is a bar.** Before rigging, name every risk band, count background
  or doubled pixels over every frame and both physics/breath extremes, and
  report the maximum and its frame. Cover every band crossing another bone.
- **Bars before sign-off.** Each reading names its command, checked against
  installed `--help`. A reading with no command is a STOP before sign-off.
  Loop bars: INTERVIEW.md, "Bars have reading commands".
- **Appearance needs a person**, not a step bar: {{APPEARANCE_LINK}}.
- **Nothing unnamed.** Add no motion, chain or physics the user did not name. A
  reference ("move like X") is read for what it shows; anything more is a
  question, not a default.
- **Re-run first, cut last**, never a polygon in code or config: the ladder in
  SOURCE.md, step 2 below.
- **A full-screen scene is a CG build.** For `rig_type` `fullscreen.*`, each
  rig version declares the gates in {{CG_GATES_LINK}}. Refusals are the art's to fix.
- **The bust is meshed** unless the `meshes` guide excludes it with a reason
  ({{BUST_LINK}}).
- **Overlaps.** A piece over a part with its own animation (glasses over
  eyelids) holds none of that part's pixels, or the animation shows its copy.
- **Pairs.** Measure left/right symmetry against the painting before calling a
  pair uneven ({{GATES_LINK}}).
- **Look before the user does**, at native resolution and every boundary the
  crux names: a whole-figure |composite − painting| map, every component listed
  by box and part with a status (in the painting / fixed / left, why). Use the
  true stack of part images, not a render flattened on white; crop on white and
  on mid-grey, as white hides light fringes. Eye boxes a
  reviewer chose are not the check: a seam outside them got through.

## Where things go

Each folder's lifetime and git status: {{LIFETIME_LINK}}.

## What to read, and why

{{READ_FIRST}}

Read installed docs here at `package.json`'s pins to match tools, not memory.
Run refusal `(see … guide …)` commands before changes.

{{PACKAGE_DOCS}}

Project organisation: rig-c/create docs (not installed).

{{CREATE_DOCS}}
