# Guide sentences and invariants

`translateInvariants(project)` in [`src/invariants.ts`](../src/invariants.ts)
is a pure JSON-to-document translation. It reads **current** framing answers,
waypoint guides, post guides and their `additions[]`. It never reads `history`,
versions, configs, option files, producer reports or the filesystem. It neither
measures a rig nor calls core. The document is not wired into project records,
`interview --check`, builds, signoff, acceptance or handoff yet.

## Document contract

The spec is `rig-create/invariants@1`:

- `sources[]`: question id, record path and a deep copy of the exact current
  answer (including picks, Other text, asks, delegation reasons and additions).
- `entries[]`: `{ invariant, from: { question, verbatim_sha256 }, source_path,
  value_path }`. `invariant` is a core `RigInvariants` object with one field;
  the value is copied without inference or rounding. Entries are kept separate,
  including conflicting declarations; this module does not merge or prioritize
  them. Core must still resolve rig names and enforce the declaration.
- `gaps[]`: `{ gap, from, source_path, value_path, sentence, value }`. `sentence`
  is the **whole unchanged verbatim record**, rather than a guessed sentence
  boundary. The sha256 hashes its exact UTF-8 bytes: no trimming, newline
  conversion or Unicode normalization. A record without verbatim has a null
  sentence and null hash, and cannot produce an entry.

Paths identify records and normalized leaves; object keys in `value_path` use
JSON-quoted brackets, arrays use numeric brackets. A decision's value path names
`agent_decision.value`, but its binding stays on the guide that delegated it.
An addition has its own source path and verbatim hash. Output order follows
record order, then recorded value key/array order. No clock or random input is
used. Outputs share no mutable objects with the input.

The translator is deliberately **not a natural-language interpreter**. Every
verbatim record retains a `sentence_semantics` gap, even when its normalized
value has structural entries. This explicitly records that the words may name
requirements the normalized reading missed, contradicted or weakened. It does
not certify that the agent's reading agrees with the user, and never invents
numeric amplitudes, rig identifiers, thresholds or a meaning for “must”.

Every unsupported normalized leaf becomes a `vocabulary` gap. False, zero,
null, empty arrays and empty objects survive. Unknown or malformed structural
fields are retained as leaves, including unknown fields inside a declaration.
A gap is translation data, **not** a create refusal, WARN or a passed check.

## Exact structural mapping

The installed core's `RigInvariants` is the authority, not a list inferred from
interview prompt names. A **top-level property of a recorded normalized value**
with the following exact spelling and shape can become an entry. This applies
to user readings, decided agent readings and explicit Other fragments. Existing
free-form normalized readings do not need to be rewritten into this shape.

| Recorded normalized property | Core field / limitation |
| --- | --- |
| `meshSlots`, `meshTriangles`: nonnegative safe integer | Same field; explicit budgets only. A part list or “standard density” does not imply a budget. |
| `axisBone`, `massBone`: nonblank string | Same field; named structural roles only. |
| `axes`: nonempty list of `{name, through, bones, tolerance}` | Same field; distinct through pair, nonempty distinct held bones, unique entry names, explicit finite tolerance strictly between 0 and 90 degrees. |
| `detached`: nonempty list of `{bone, notUnder, why?}` | Same field; forbidden ancestry. “Swing independently” is not equivalent. |
| `deformMayFold`: nonempty list of `{slot, why}` | Same field; unique slots, nonblank reason. Explicit opt-out only. |
| `consumerDrivenMix`: nonempty list of `{constraint, type, why}` | Same field; type `ik` or `transform`, unique kind/name pair, nonblank reason. Explicit opt-out only. |
| `idleDrivesMeshes`: `{why}` | Same field; nonblank reason. Explicit opt-out only; “breath” does not authorize it. |
| Any other field, unexpected nested field, empty declaration or incompatible shape | Gap, retaining all its contents. |

Shape recognition is not core validation. Name resolution, duplicate parentage,
geometry, actual budgets, whether an opt-out applies and every runtime property
remain core's job. No structural field is inferred by walking nested objects.
The former `editorRoundTrip` field is **retired** in installed core 3.2.1
(core's `docs/AUTHORING.md`, issue #1196); it becomes a gap, not an entry.

## State × reader matrix

These columns describe this module's three readers only; there are no new
project/check or CLI readers. The test matrix in `tests/invariants.test.ts`
exercises each row, including mixed choices and pending siblings.

| Current state | Exact source reader | Normalized-value reader | Gap reader |
| --- | --- | --- | --- |
| Legacy user | Retain verbatim/record | Read `value` | Sentence + unsupported leaves |
| Full delegation pending | Retain delegation | No stale user value or invented decision | `pending_delegation` |
| Full delegation decided | Retain delegation + reasoning | Read `agent_decision.value` only with nonblank reasoning | Sentence + unsupported leaves |
| Legacy partial user/delegation | Retain both | User value plus decided agent value | Unfinished decision remains pending |
| Choices, including mixed user/auto | Retain picks/asks | User value plus decided agent value; per-auto fragment marks each ask landed | Pending delegated asks stay explicit |
| Other with explicit fragment | Retain exact multiline Other text | Read fragment as well as recorded value | Text remains a semantic gap |
| Other pending, including a sibling with explicit fragment | Retain every pick | Retain available recorded value and explicit fragments; no option-file reconstruction | `pending_other`; sibling contribution survives |
| Addition | Separate source and hash | Read its recorded value | Sentence + unsupported leaves |
| Null / not applicable / inherited / malformed | Retain record | No inheritance lookup or fabricated reading | Explicit pending, N/A, inherited or malformed gap |
| Historical replaced answer | Not selected | Not read | Never resurrected as a current requirement |

For adopted choices the aggregate `value` is already assembled by the existing
writer. The translator does not fetch option bytes or recompute that assembly.
In particular a pending Other may leave aggregate `value:null`; explicit sibling
Other fragments and all original pick text remain available. Source retention
is lossless; semantic understanding and agreement are explicitly unproven.

## Current worked example and gaps

[`templates/example-invariants/invariants.json`](../templates/example-invariants/invariants.json)
is generated from the **current** `templates/example-project.json`:

```sh
bun scripts/generate-invariants-example.ts <fresh-directory>
bun scripts/generate-invariants-example.ts <another-fresh-directory> --check
```

The script refuses an existing directory. `--check` regenerates into fresh
scratch, compares byte for byte and never rewrites the committed artifact.
All artifact bytes come from this script.

The current example adopted choices and replaced its detailed rigging prose
with synthetic answers. The independent census in the test enumerates its
current readings and the named concepts still present in its words:

| Question | Current concepts / normalized content retained as gaps |
| --- | --- |
| `rig_type`, `reference` | Standing idle character holding a lantern; `character.idle`; `none`. |
| `seethrough` | Synthetic layers, resolution, head crop; separately decided synthetic seed. |
| `assemble` | Joints, unchanged face, separate lantern, delegated remainder, core projection; `core`, `plain` and synthetic cut/emphasis/draw order/authored/occluders/outfits. |
| `bones` | Synthetic chains, placement, length. |
| `meshes` | Synthetic bend, rigid, density. |
| `constraints` | Synthetic effects, strength, extent, gravity, stops. |
| `motion` | Synthetic tracks, extent, speed, loop, blink. |
| `camera_depth` | Slow push-in, no parallax; `push_in`, `false`. |
| `post_timing` | Eight seconds, loop, beam sweep once near the end; `8`, `true`, `beam sweep`, `near the end`. |
| `post_composition` | Whole lighthouse in frame, night without brightening; `lighthouse fully in frame`, `as painted`. |

None of these current readings directly spells a structural core invariant.
The expected result therefore has **zero entries**, not guessed physics or
mesh opt-outs. The current source never regains scarf wind, coat-tail strength,
hair motion or flame flicker from history. A separate synthetic/legacy control
covers motion, part/effect/extent, partial decisions and added hinge direction.
Dropping just the `post_timing` sentence mapping makes the same completeness
assertion fail, even while its normalized leaves remain.

Concrete vocabulary gaps visible in current words, for repo HQ to route as
core issue drafts (no issues are filed by the translator):

| Gap | Example sentence | Needed invariant / unresolved measurement contract |
| --- | --- | --- |
| Part existence and independent separation | “The lantern is its own part.” | Require named semantic part and separation, bound to the producer's part identity. A mesh-slot budget cannot prove it. |
| Protected painted appearance | “Keep her face exactly as painted.” | Bind a named protected region to source painting and define the appearance comparison. No numeric tolerance is invented here. |
| Camera motion and forbidden parallax | “A slow push-in, no parallax.” | Require camera movement and forbid parallax over a take; define the camera space and measured time span. “Slow” still needs an agreed bar. |
| Clip duration, looping and event placement | “Eight seconds, looping. The beam sweeps past once, near the end.” | Duration/loop condition plus a named beam event's count and bounded time interval. “Near the end” needs normalization, not a guessed cutoff. |
| Framing containment | “Keep the whole lighthouse in frame.” | Named subject containment over the camera take, with the subject/viewport binding. |
| Preserve source lighting | “It's night; don't brighten it.” | A source-bound lighting/brightness preservation condition with its region and comparison contract. |

Synthetic placeholder values do not establish real physics, wind or movement
extent requirements, so they are **unresolved readings**, not evidence for new
physics invariants. Tool choices such as projection, seed and resolution remain
workflow records; retaining them does not assert that core should enforce them.
A real pilot is still needed to establish physics/extent gaps on current data.
