# @rig-c/create

Bring a painting and your direction. Your agent uses Create to build a rig
and a directed animation. [See where Create fits in the rig-c toolchain.](https://github.com/rig-c/getting-started#the-whole-thing-in-one-glance)

## Install and start

You need [Bun](https://bun.sh/) 1.4.0 or newer and Git. From the folder with
your painting, run the following commands. Bun fetches Create on first use.

```sh
bunx --package @rig-c/create rig-create init p1 --painting ./painting.png --origin "My original painting" --owner-language en
bunx --package @rig-c/create rig-create next p1
```

The first line of output from each command looks like this.

```text
Created project p1 at /path/to/p1
next: p1 — stage: interview
```

The folder contains the registered painting, the project record and pinned
tools. Open `p1` with your agent and have it read the generated `AGENTS.md`.

## The four steps

1. **Parts and meshes.** The agent prepares the layers, assembles the parts
   and shows the checked result.
2. **Rigging interview.** The agent explains how the character will be rigged
   and how it will deform.
3. **Rig and animation.** The agent builds the rig and shows its motion.
4. **Direction.** Choose camera, timing and composition in chat. The agent
   composes and shows the take.

<a id="recording-approvals"></a>

The agent tells you its plan once per step in chat and proceeds. Use Review
to look at the current result and comment on what you see. Your project
holds one current result per kind and uses Git for history. When earlier
work changes, the agent rebuilds the results that depend on it.
[Step plans and chat choices](docs/INTERVIEW.md) · [Live Review](docs/LIVE-REVIEW.md)

## Commands

- `init` creates a project and registers its starting painting. [Initialization](docs/CHECKS.md#initialization)
- `next` lists available moves and who takes them. [Project reference](docs/PROJECT.md)
- `plan propose` records a plan for a whole step. [Step plans](docs/INTERVIEW.md#step-plans)
- `plan feedback` attaches the owner's feedback to a plan. [Feedback](docs/INTERVIEW.md#step-plans)
- `interview-answer` records the owner's choice and words from chat. [Interview](docs/INTERVIEW.md)
- `record parts|rig|motion|direction` records a checked producer output. [Current outputs](docs/CHECKS.md#current-outputs-record-parts-record-rig-record-motion-record-direction)
- `job open` publishes the current result for looking and comments. [Job commands](docs/LIVE-REVIEW.md#job-commands)
- `comment` records a Review comment or the work that addressed it. [Live Review loop](docs/LIVE-REVIEW.md#the-live-review-loop)
- `interview --check` reports missing data and invalid bindings. [Checks](docs/CHECKS.md)
- `advance` records progress. [Stages](docs/PROJECT.md#stages)
- `history` lists project step-data commits and their restore commands. [Project layout](docs/PROJECT.md#layout)

See the [worked project](templates/example-current/project.json) or
[adopt retained outputs from a numbered project](docs/PROJECT.md#adopting-existing-numbered-outputs).
[MIT licence](LICENSE)
