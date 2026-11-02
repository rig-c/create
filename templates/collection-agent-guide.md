# Agent guide

This folder is a rig collection: several rigs that belong together — cut from
one group painting, sharing outfits, a pose and a lineup. Read this page before
you touch anything. What a person decided is in `collection.json` and in each
member's `members/<name>/project.json`, and nowhere else.

## Start here

1. Read `collection.json` first. Its `interview` holds the answers given once
   for every member; `members[]` lists the members; `versions[]` holds each
   collection version with the member builds it pins.
2. A member is an ordinary project under `members/<name>/`, with its own
   `AGENTS.md`. Work on one member from inside its folder.
3. The layout, the inherited answers and the pins are explained in
   {{COLLECTIONS_LINK}}.

## The order, and what you may not do

`interview` → `plan-approved` → `reference` (one member goes first and sets the
direction) → `members` (the rest, in parallel once their interviews are signed)
→ `post-interview` → `post` → `direction-review` → `accepted`. Any stage can
become `paused`.

- Never move `stage` forward yourself. Only a person's `signoffs[]` entry does.
- A member's answer that the collection gave is inherited, not copied. Never
  copy a collection answer into a member; an override names what it overrides
  and why, in the user's words.
- Composition (lineup, overlaps, collection takes) belongs here, never in a
  member.
- A collection output is made from pinned member builds. Make it, then record
  it: `rig-create collection pin`. Before showing one, run
  `rig-create collection --check`: a member rebuilt since the pins is refused
  by name, and its output is stale.

## Where things go

| Path | Lifetime | In git |
| --- | --- | --- |
| `collection.json`, `shared/` | forever | yes |
| `members/<name>/` | as in a project | as in a project |
| `inputs/` | forever, never edited: the group painting, shared references | yes |
| `evidence/v<N>/` | forever: what a collection verdict rested on | yes |
| `derived/` | until regenerated | no |
| `outputs/v<N>/` | until discarded; frozen when pinned | no |
| `scratch/` | none; deleting it must lose nothing | no |

## What to read, and why

These are installed here at the versions `package.json` pins, once for every
member:

{{PACKAGE_DOCS}}

How a collection and its members are organised is documented in rig-c/create:

{{CREATE_DOCS}}
