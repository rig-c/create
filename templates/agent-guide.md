# Agent guide

One painting, one current rig and its takes.

## Start here

Use `rig-create init <dir> --painting <file> --origin <words> --owner-language <tag>`. In an existing project, `rig-create input add <path> --painting --origin <words>`. Keep the source bytes bound in `project.json.painting` unchanged.

Read `project.json`, then run `rig-create next` from the project folder. Read next again after each writer or producer, before advancing. {{RESUME_LINK}}.

## The order, and what you may not do

`interview` → `plan-approved` → `parts` → `parts-review` (parts, by eye) →
`rigging-interview` → `rigging` → `rig-review` → `post-interview` → `post` →
`direction-review` → `accepted`. These are progress markers ({{STAGES_LINK}}).
Use `rig-create advance <stage>` and `rig-create step-status <id> <status> --by agent` when next offers them.

At the end of each step run `rig-create interview --check`. Fix refusals,
read warnings and check again. Retain producer reports and use writers for
every record change. Relay exact owner words with attribution.

## The user's four steps

Write one plan per step with
`rig-create plan propose <step> --file <plan.md> --by agent`. Use a summary,
what and why, exclusions and direction questions. Tell the owner once in
chat and proceed. Record feedback with
`rig-create plan feedback <step> --words-file <file> --by <owner> --said-at <ISO> --relayed-by <operator>`.
Feedback and approval never gate writes. For machine-read plan values use
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
   composition in chat against the recorded rig. Retain each shown set with
   `rig-create interview-options <question> --file <set.json>`. Relay the
   owner's actual pick with
   `rig-create interview-answer <question> --set <set.json> --sha256 <shown-hash> --pick <ask>=<option> --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>`.
   After each pick, read next while still at post-interview. Follow its
   remaining work before advancing. Register any background with
   `rig-create input add <path> --origin <words>`. Render with the producer
   command from next, then use `rig-create record motion --from <dir>`.
   Put the selected composition into the Parts scene. Use
   `rig-create scene write --compose-scene <file>` and
   `rig-create direction write --file <json>` with the take and citations
   to the recorded choices. Run the compose command from next and
   `rig-create record direction --from <dir> --direction specs/direction/direction.json`.
   Inspect the take, check it and follow next to
   `rig-create advance accepted`.

**Live Review loop**

Start `rig-create job open --reviewer <id> --role owner --current <parts|rig|direction>`
with the recorded result you want to show. Keep the host running and share its
private URL once. Run the same invocation to publish another result into the standing job. Reused opens exit. The page updates in place.

`rig-create job acts --json` lists the finalized acts and their comments and
words. Wait for a new act with `rig-create job acts --wait`, then use
`rig-create comment --from-review <actId>` for comment-only acts. The entry binds seen
files by hash. When the owner gives an
optional signoff in chat, use the relay move from next for its recorded target.

If the host stops, repeat the same open with its reviewer and role, then
run `rig-create job reconcile`. Close with `rig-create job close` when done. See the [live Review loop](https://github.com/rig-c/create/blob/main/docs/LIVE-REVIEW.md)
for recovery and stored acts.

## Before you ask, plan or show

- **Owner language.** Use `owner.language` for the plan and its `does`,
  `produces` and `bar` text, plus `asks[].prompt` and each option's `label`,
  `effect` and `reason`. Keep identifiers, producer data and quotes as supplied.
- **Prior words.** Quote reused owner words with their source and date. For
  the three chat choices, retain what was shown, give Other and delegation
  where applicable and record the exact choice.
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

Read installed docs at the pins in `package.json` and run named remedies.

{{PACKAGE_DOCS}}

Project docs:

{{CREATE_DOCS}}
