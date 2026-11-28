# AGENTS.md

This file is for agents that work on or review this repository. What the
package does is in [README.md](README.md), and the refusal catalogue is in
[docs/CHECKS.md](docs/CHECKS.md).

## Standing goal: the four-step user cycle

Read this before choosing work. It ranks every issue in this repository.

1. **The goal.** The user takes a project through four steps: parts and
   meshes, the rigging interview, rig and animation, then direction (the
   agent guide, "The user's four steps"). The goal is done when a project
   passes all four on the tools alone:
   - every record is written by create's writers, with no hand edit of
     `project.json`;
   - `check` exits 0 at every stage boundary;
   - the project reaches `accepted`; a numbered project also needs the
     user's acceptance at direction-review.
2. **create owns the cycle end to end.** create says what the cycle needs
   from parts, review and core. When a project hits a gap in another
   package, file the issue in that package's repository, name the step it
   blocks, and follow it until it lands. Don't work around the gap here.
3. **On the current path no stage waits for an approval; owner words go
   through the relayed chat.** The agent tells the owner each stage's plan
   once in chat and moves on (owner ruling 2026-11-27). The three
   post-interview questions (`camera_depth`, `post_timing`,
   `post_composition`) stay chat questions: they are choices, not approvals.
   Interview answers, and a stage signoff when the owner actually said
   something about a stage, relay owner chat through the existing writers
   with
   `--owner-chat <words file> --said-at <ISO date> --relayed-by <operator>`
   and the owner's `--by`. Interview picks still bind the displayed set and
   option ids. A signoff recorded on `current.<kind>` binds the live
   recorded output and quotes the owner's words, when they were said and who
   relayed them; it never gates progression. The numbered verdict and
   stage-review signoff writers (`review`, `parts-review`, and numbered
   `signoff parts-review|rig-review|direction-review`) and Review act signoff,
   checkpoint, and interview-pick ingestion routes are retired; `job open --draft`
   publishes view-only, and on `current.parts` an optional parts-review signoff
   binds the live recorded output by the owner's relayed words. Stored numbered
   verdicts and stored signoffs with verdict or Review act references still
   validate those references at check time.
   Shared context images and option images shown in Review do not remove an
   interview question from this route.
   Typing a pick or signoff into a record without the owner's recorded words,
   or moving a stage by hand, remains a bypass: record a finding and file an
   issue; it never counts as done even when `check` passes.

   Direct owner instructions provide authority. Record the operator,
   reason file and owner's exact words through `plan checkpoint-withdraw` or
   `plan bar-amend`. Neither creates or replaces a verdict, pick, correction
   or signature. If implementation is difficult or regressive, give grounded
   pushback to the owner through HQ before acting.
4. **Pilot projects exist to exercise the cycle.** A pilot that stalls is a
   measurement of the tools. Fix the tool, not the pilot.
5. **Queue rule.** Every open issue is either on the cycle's path or off it.
   Off-path work waits until the on-path queue is empty, or until the issue
   is moved onto the path with a reason.

## Code Review Rules

Review a pull request against its issue's change list and against the rules
below. Report each finding with a severity, `file:line`, the defect in one
sentence and a concrete failure scenario (input, then the wrong result):

- **P0:** wrong output on a normal path.
- **P1:** wrong output on an edge case a user can reach.
- **P2:** minor issues and hardening.

Leave out style, and hardening for scenarios that cannot occur. A pull
request gets one review. A fix pushed after it is not re-reviewed.

The review comes from the other model family. A pull request written by
Claude gets Codex's automatic review when it opens. A pull request written by
Codex (labelled `by:codex`) gets the Claude tower's review, posted on the pull
request as a comment headed "Claude review (cross-family)". That comment names
the reviewer, what was read (files, at which head) and the verdict, then lists
the findings in the form above. A `by:codex` pull request merges only after
that comment exists. Codex's own review of it does not count.

### Invariants a diff can break

1. **create reads producer reports and never computes them.** It takes what
   parts and review measure from their own reports. It binds a report by the
   sha256 of its bytes and by its spec, and it does not re-run the producer
   to verify it. Code that re-derives a producer's measurement in create is a
   defect, even if its numbers agree.
2. **Every finding has a named code.** A refusal or WARN has a code in
   `SCREAMING_SNAKE_CASE`, and its message names the record path and the
   remedy. Every new code needs a row in [docs/CHECKS.md](docs/CHECKS.md).
   Tests assert on codes, never on message text alone, and never filter a
   new code out of an existing assertion.
3. **Contract dates.** A rule that would refuse records made before it
   existed is dated by a `*_SINCE` constant. The date is the landing day at
   00:00Z, so it is never in the future (the signed example is anchored at
   the latest one). Before a PR that adds or moves a SINCE lands, run `check`
   on every live pilot project; a new refusal on a record dated that day is a
   STOP, not a merge. The constant is named in the one CHECKS.md sentence that
   lists all of them, and earlier records get a WARN, not a refusal.
4. **Two pins move independently.** `scripts/source-ci-pins.json` is the dev
   pin: it may move to sibling main SHAs in a PR, at or after the release
   tags of the registry pins. `package.json` and `bun.lock` are the release
   pin and move only to published exact versions, never ranges. The play
   floor is the dependency declared by the release-pinned Review tag.
   Dev-only bumps do not rewrite release templates. Release bumps use this checklist:
   - `src/pins.ts`;
   - `question_set` in `templates/project.json`, `templates/collection.json`
     and `templates/example-current/project.json`;
   - versioned links in `docs/`;
   - the transitive `@rig-c/core`, which matches the version parts pins;
   - the current worked example, regenerated with its producer when the release
     pins change. The numbered split captions stay bound to their frozen source.

   No old release version string remains in current pin declarations.
   `source-linked` runs typecheck, lint and the full suite with isolated
   source links, retaining exact-name coverage and child-resolution checks.
   Main branch protection requires only `source-linked`. Registry `check`
   runs on main pushes, manual dispatches and PRs labelled `release` (the
   explicit Create release trigger), so a PR that breaks consumer-entry
   generation is caught on main, not on the PR.
5. **The filled example checks at 0 refusals and 0 warnings.**
   - Producer bytes under `templates/example-*` are generated by the scripts
     in `scripts/`, each with a `--check` mode that reproduces them; they are
     never written by hand.
   - JSON templates are edited in place; a whole-file reserialization is a
     defect.
   - The frozen numbered fixtures (`templates/example-numbered/`,
     `templates/example-chain/` and `templates/example-remesh/`) have no
     writers: they are verified by SHA-256 and never regenerated.
   - The 0-warnings rule applies to `templates/example-current/`; the frozen
     numbered fixtures check at 0 refusals and only WARN `CREATE_PIN_MISMATCH`
     when running Create 2.x.
6. **Writers refuse before they write.** A command that records into
   `project.json` validates with the same function the check uses, and a
   refused write leaves the file byte-identical.
7. **The agent guide stays under 10,000 bytes as rendered**
   (`renderAgentGuide()`, `tests/agent-guide.test.ts`).
8. **This repository is public.** Code, tests, docs and commit messages
   contain no private project, painting or character names and no local
   paths. Fixtures are synthetic, and a real project is "a pilot" or "a
   consumer project".
