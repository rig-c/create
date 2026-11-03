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
   Reviewed as a take.
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

## Licence

[MIT](LICENSE).
