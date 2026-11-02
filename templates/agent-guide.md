# Agent guide

This folder is a rig project: one painting in, one rig and the takes made from it
out. Read this page before you touch anything. You need no chat history; what a
person decided is in `project.json`, and nowhere else.

## Start here

1. Read `project.json` first, and nothing else first. It is the only record of
   decisions. A decision made in chat is copied into it word for word, with who
   said it and when, or it was not made.
2. Resume the way {{RESUME_LINK}} says: `stage`, the last `signoffs[]` entry, the
   first `plan.steps[]` entry not `done` and the last `versions[]` entry say
   where the project stands and what the next work is.

## The order, and what you may not do

`interview` → `plan-approved` → `rigging` → `rig-review` (the rig alone, on a
still frame) → `post-interview` → `post` → `direction-review` → `accepted`. Any
stage can become `paused`.

- Do not rig before the plan is signed: no rig step runs until `signoffs[]`
  holds the user's `{ "stage": "plan-approved" }` entry.
- Never move `stage` forward or pass a plan checkpoint yourself. Only a person's
  `signoffs[]` entry does that. You may draft, propose, build and measure in any
  stage.
- Never fill a user's answer from the image. A `null` answer is the next
  question for the user; ask it in plain words.
- "auto" is a delegation the user chose. Record it as delegated, with your
  decision written on the item. It is never a blank for you to fill later.
- {{INTERVIEW_CHECK}}

## The user's three steps

1. **Base motion**: the cut, the bones, what deforms, physics and the motions,
   answered before any rigging and judged at `rig-review`.
2. **Direction**: camera, depth and timing, asked only after a rig version is
   accepted and judged at `direction-review`.
3. **Polish**: what the user says after seeing a version, kept word for word in
   that version's `verdicts[]` and tied to the items it is about.

## Where things go

| Path | Lifetime | In git |
| --- | --- | --- |
| `project.json` | forever | yes |
| `inputs/` | forever, never edited; a changed input is a new file | yes |
| `evidence/v<N>/` | forever: what a verdict rested on | yes |
| `derived/` | until regenerated; each entry listed in `derived[]` with its command | no |
| `outputs/v<N>/` | until discarded; frozen when shown | no |
| `scratch/` | none; deleting it must lose nothing | no |

The user's own references ("make it feel like this") go in `inputs/references/`,
with their sha256 in `project.json` `inputs[]`. They are inputs to the rig, not
documentation, and they are never edited.

## What to read, and why

These are in the project, installed at the versions `package.json` pins, so they
match the tools you run. Read them here, not from memory or from the packages'
repositories. A refusal from either tool usually ends with a `(see … guide …)`
command that prints the matching row of these guides; run it before changing
anything.

{{PACKAGE_DOCS}}

How this project is organised is documented in rig-c/create, which is not
installed here:

{{CREATE_DOCS}}
