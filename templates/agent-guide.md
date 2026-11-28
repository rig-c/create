# Agent guide

## Start here

Use `rig-create init <dir> --painting <file> --origin <words> --owner-language <tag>`. In an existing project, `rig-create input add <path> --painting --origin <words>`. Keep the source bytes bound in `project.json.painting` unchanged.

Read `project.json` and run `rig-create next` in the project folder. Run it again after each writer or producer. {{RESUME_LINK}}.

### Pause

To stop work, use `rig-create pause --by <who>`. Current-path pauses need no
signature. While paused, follow the resume move from next.

## The order, and what you may not do

`interview` → `plan-approved` → `parts` → `parts-review` (parts, by eye) →
`rigging-interview` → `rigging` → `rig-review` → `post-interview` → `post` →
`direction-review` → `accepted`. See {{STAGES_LINK}}.
Follow next for `rig-create advance <stage>` and `rig-create step-status <id> <status> --by agent`.

After each step run `rig-create interview --check`. Fix refusals, read warnings
and check again. Keep producer reports, use record writers and quote exact
owner words with attribution.

## The user's four steps

One plan per step with
`rig-create plan propose <step> --file <plan.md> --by agent`. Summarize the work,
why, exclusions and direction questions. Tell the owner once in chat and
proceed. Record feedback with
`rig-create plan feedback <step> --words-file <file> --by <owner> --said-at <ISO> --relayed-by <operator>`.
Feedback and approval never gate writes. For machine-read parts and rigging values use
`rig-create interview-decision <question> --by agent --reasoning-file <file> --value-file <json> --plan-quote-file <file>`.

1. **Parts and meshes (`parts`).** Prepare layers. Run assemble and the
   parts check from next, then `rig-create record parts --from <dir> --config <file>` with
   the checked output. Retain the boundary report in evidence for
   `rig-create advance parts-review --parts-check <report> --parts <assembled-dir>`
   ({{PARTS_CHECK_LINK}}). Inspect the parts and run `rig-create structure-snapshot`
   when next calls for it. Use {{RETOUCH_HANDOFF_LINK}} for receipted retouches;
   keep `assemble.edited_parts` in the config used by the producer.
2. **Rigging interview (`rigging`).** Use the recorded parts and structure to
   plan bones, deformation and physics. Follow next for work rows and plan values.
3. **Rig and animation (`motion`).** Build and check with next, then
   `rig-create record rig --from <dir> --config <file>`. Look at the rig and
   its motion against the painting at a fixed view before adding direction.
4. **Direction (`direction`).** Ask camera/depth, timing and
   composition in chat against the recorded rig. Use `templates/example-current` option JSON as a specimen. For a new rig, refresh `drafted_at` and the `current-rig`
   context's run and config paths and hashes. Set `target.files_sha256` from the rig
   and `target.record_sha256` to the SHA-256 of its compact recursively key-sorted JSON.
   Omit `signoff_at` without a signoff. Retain each shown set with
   `rig-create interview-options <question> --file <set.json>`. Relay the
   owner's actual pick with
   `rig-create interview-answer <question> --set <set.json> --sha256 <shown-hash> --pick <ask>=<option> --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>`.
   After each pick, read next while still at post-interview. Follow its
   remaining work before advancing. Register any background with
   `rig-create input add <path> --origin <words>`. Render with the producer
   command from next, then use `rig-create record motion --from <dir>`.
   Bind keyed options to the shown Parts scene in
   `value.compose.camera_scene: {path,sha256}`. Use
   `rig-create scene write --compose-scene <file>` and
   `rig-create direction write --file <json>` with the take and citations
   to the recorded choices. Run the compose command from next and
   `rig-create record direction --from <dir> --direction specs/direction/direction.json`.
   Inspect the take, check it and follow next to
   `rig-create advance accepted`.

**Live Review loop**

Start `rig-create job open --reviewer <id> --role owner --current <parts|rig|direction>`
to show a recorded result for looking and comments (Review refuses verdicts,
signoffs, checkpoints and picks). Share its private URL once; rerun it to
update. Reused opens exit. The page updates in place.

`rig-create job acts --json` lists finalized acts; wait with
`rig-create job acts --wait`, then record comment acts with
`rig-create comment --from-review <actId>`. Comments bind files by hash. For an
optional signoff in chat, use its relay move from next.

If the host stops, repeat the same open with its reviewer and role, then
run `rig-create job reconcile`. Close with `rig-create job close`. See the [live Review loop](https://github.com/rig-c/create/blob/main/docs/LIVE-REVIEW.md).

## Before you ask, plan or show

- **Owner language.** Use `owner.language` for the plan and its `does`,
  `produces` and `bar` text, plus `asks[].prompt` and each option's `label`,
  `effect` and `reason`. Keep identifiers, producer data and quotes as supplied.
- **Prior words.** Quote reused owner words with their source and date. For
  the three chat choices, retain what was shown and record the concrete pick.
- **Readings.** Name the producer command for each measurement. Run the
  readings and inspect the report and the visible result.

See [Before you ask, plan or show](AGENT-REFERENCE.md).

## Where things go

Keep one current output for each of parts, rig, motion and direction under
`outputs/`. Keep inputs, plans, authored specs and retained evidence in the
project. When an input or earlier output changes, follow next to rebuild
dependent outputs in order. Recognize `OUTPUT_STALE` and check again after
each replacement. Use `rig-create history` for project git history and its
restore instructions. See {{LIFETIME_LINK}}.

## What to read, and why

{{READ_FIRST}}

Read installed docs at the pins in `package.json` and run named remedies; for `CREATE_PIN_MISMATCH` on a numbered project, use Create 1.27.x or adopt, not `packages upgrade`.

{{PACKAGE_DOCS}}

Project docs:

{{CREATE_DOCS}}
