# rig-c/create

**Every rig starts as a project, and every project starts with the user's direction.**

This repository is where the rig-c project layer is built: the folder a rig is made
in, the interview that comes before any rigging, the plan the user signs, and the
guide an agent reads before it touches anything. It does not cut parts
([rig-c/parts](https://github.com/rig-c/parts) does) and it does not compile or
gate rigs ([rig-c/core](https://github.com/rig-c/core) does). It decides *what* and
*why*; those packages do *how*.

## Why it exists

An agent rigging a painting passes through the same places every time: the layer
split, the cut of each part, the bones, what deforms and what stays rigid, what
gets physics or wind, which motions it plays. Left alone at each of those places,
it guesses — and a guessed direction is only found out when a person watches the
result and sends it back. A precise direction, given before the work, is done in
one pass.

So the user gives direction at those places, in their own sentences, before the
work starts:

1. **Base motion** — the cut, the bones, what deforms, physics, the motions.
   Reviewed on a still frame, the rig alone.
2. **Direction** — camera, depth and timing, applied after the rig is accepted.
   Reviewed as a take. Camera keys and timing are authored with
   [`rig-create direction`](docs/PROJECT.md#authored-camera-direction-create92)
   in a hash-bound direction document; depth and turn remain in parts.
3. **Polish** — what the user says after seeing a result, kept word for word and
   tied to the place it is about.

Choosing "auto" at any place is allowed. It is recorded as the user handing that
decision to the agent, never left blank for the agent to fill.

## What will live here

- A project scaffold: one folder per rig, one record of its direction, sign-offs
  and versions, and data split by lifetime (inputs and evidence kept; derived data,
  outputs and scratch rebuilt or discarded).
- The interview, organised by the places the rig work always passes through.
- Translation of the user's sentences into checks the rig must keep, enforced by
  rig-c's `invariants` and named failures.
- Collections: several rigs that belong together, sharing direction and pinned to
  exact member builds.
- The guide an agent starts from, pointing at the installed packages' own
  documentation rather than copying it.

Nothing is published yet. The structure is being piloted by hand first; the issues
here track what moves in, in order.

## Recording approvals

```sh
rig-create signoff plan-approved --by user --verbatim-file approval.txt <project dir>
rig-create signoff parts-review --by user --evidence evidence/parts-review.json --verbatim-file approval.txt <project dir>
rig-create signoff rigging --checkpoint constraints --by user --verbatim-file approval.txt <project dir>
rig-create signoff post-interview --by user --steps camera,timing --verbatim-file - <project dir>
rig-create review 2 --verdict accepted --by user --review rig-review --source note --verbatim-file feedback.txt --at 2026-11-04T12:00:00Z --answers-feedback 1:0 <project dir>
```

`signoff` records without moving the stage. It uses the clock, signs all steps
of the stage's phase unless `--steps` narrows them, fills null checkpoints from
the draft and preserves existing answers and delegations. Input is UTF-8 and
keeps every byte, including spaces and final newlines. Omitting
`--verbatim-file` reads stdin. Review also supports the existing `--verbatim`
option. See [the record contract](docs/PROJECT.md#recording-a-sign-off).

## The clock

Every command, writer and check takes the instant it runs at as an explicit
`now` (milliseconds since the epoch). That one value dates what a writer records
and bounds every "not in the future" refusal. The process entry in `src/cli.ts`
is the only place create reads the wall clock; it passes `Date.now()` to `main`.

Tests and generators never read or replace the global clock. Generators pass
their declared example instants. Tests call create through
[tests/clock.ts](tests/clock.ts), which passes the suite's instant, by default
twelve hours after the latest `*_SINCE` date; `testClock.set` moves it for the
next call. A test that needs a real process spawns
[tests/cli-at.ts](tests/cli-at.ts) with that instant. The only test that reads
the real clock is [tests/contract-dates.test.ts](tests/contract-dates.test.ts):
it fails, naming the constant, when a `*_SINCE` date is still in the future.

## Docs

- [docs/PROJECT.md](docs/PROJECT.md) — the project folder, data by lifetime,
  stages and sign-offs, the plan, versions.
- [docs/INTERVIEW.md](docs/INTERVIEW.md) — the three user steps, answer states
  and shape, waypoints, post-production, provenance, polish feedback.
- [docs/CHECKS.md](docs/CHECKS.md) — `rig-create interview --check`: every
  refusal code, what fires it, how to clear it.
- [docs/COLLECTIONS.md](docs/COLLECTIONS.md) — several rigs that belong together:
  inherited answers, the reference member, composition, pins.
- [docs/CRAFT.md](docs/CRAFT.md) — craft notes: the default proposed at each
  waypoint, and execution defects handed to rig-c/parts gates.
- [docs/SOURCE.md](docs/SOURCE.md) — the layer split and the cut: what to do, in
  what order and why, read before `seethrough` and `assemble`.
- [docs/LESSONS.md](docs/LESSONS.md) — the self-check every version passes
  before anyone looks, and the review lessons behind it.
- [templates/](templates/) — the empty `project.json` and `collection.json`
  skeletons, and a worked example ([example-interview.md](templates/example-interview.md),
  [example-project.json](templates/example-project.json)) on a made-up painting.
  Its sign-offs and the [reopened variant](templates/example-reopened/project.json)'s reopen
  are synthetic fixture records, not a person's approval
  ([why](templates/example-draft/README.md)).

## Licence

[MIT](LICENSE).

New projects ask a separate multiple-choice question for each applicable ask,
with a reasoned agent recommendation, Other and explicit delegation. The shown
option file is retained by raw sha256. Record it with `interview-options`, then
use `interview-answer --pick` or ingest review's `--picks-file`;
`interview-decision` records only the explicitly delegated asks. See
[the choice contract](docs/INTERVIEW.md#per-ask-choices-interview2) and the
[generated consumer fixture](templates/example-interview-choice.json).
Existing @1 projects keep their sentence history; adopt choices explicitly
with `interview-options --adopt`, without re-dating old answers.
