# Memory file format

Each engram is `<scope-dir>/<id>-<slug>.md`. Ids are ULID-style (timestamp +
randomness): collision-resistant across machines without coordination,
sortable by creation time to the millisecond, so new engrams merge cleanly in
git. Legacy `NNNN`-style ids from older versions still work; if you ever hit
duplicates (hand-written or legacy `0001`-style), `engram dedupe` repairs
them.

```markdown
---
id: "01jb3x1q2v7k9m4t8z0c2d5e6h"
title: Replaced moment with date-fns
type: decision
tags: [deps, date, moment]
scope: project
created: 2025-01-15T10:30:00.000Z
updated: 2025-01-15T10:30:00.000Z
pinned: true
status: superseded
supersedes: "0001"
related:
  - "0002"
aliases: [postgres, "pg row level security"]
reviewAfter: 2026-01-01T00:00:00.000Z
expires: 2026-06-01T00:00:00.000Z
sourceType: conversation
sourceRef: deps standup, 2025-01-14
---

moment.js is frozen/in-maintenance and ships a large bundle…
```

The frontmatter fields `id`, `title`, `type`, `tags`, `scope`, `created`, and
`updated` are required; `author`, `pinned`, the six lifecycle fields shown
above, `related`, and `aliases` are optional. Entries without lifecycle fields
need no migration. Unknown fields with other names are tolerated on read but
still dropped on edit, while the six modeled lifecycle fields, `related`, and
`aliases` are preserved.

## Entry types

`decision` · `fact` · `preference` · `note` · `issue` · `context`

Read about digest ordering in [automatic startup context](startup-context.md)
and the [manual context budget](context-token-budget.md#selection-and-flags).

## Lifecycle fields

- `status`: closed vocabulary, exactly `active`, `superseded`, or `archived`.
  Absent means no explicit status; it is never written for you.
- `supersedes`: the id of the older entry this one replaces. The arrow points
  from the newer entry back to the older one; an old entry may be marked
  `superseded` without naming its replacement.
- `reviewAfter` / `expires`: ISO 8601 timestamps with an explicit zone (the
  same forms as `created`/`updated`, e.g. `2026-01-01T00:00:00.000Z`). They are
  advisory: engram never deletes or rewrites an entry because a date passed.
- `sourceType`: exactly `conversation`, `file`, `url`, `command`, or `other`.
  `sourceRef`: a non-empty reference such as a relative path, URL, command, or
  conversation note. The two are independent; neither is required.
- `related`: an optional ordered list of exact entry ids in the same scope.
  Links are directional one-way metadata: engram never writes a reciprocal
  key to the target, target existence is advisory (a missing id is only a
  `related_not_found` warning, and an id claimed by two same-scope files is
  a `related_ambiguous` warning, so forward references are fine), and
  prefixes are rejected as ids. `engram add --related 0002,0003` sets it,
  `engram edit --related` replaces the whole list, and
  `engram edit --clear-related` removes it.

## Aliases

- `aliases`: an optional list of alternate names a searcher might use, e.g.
  `aliases: [postgres, "pg row level security"]`. Values may be multiword
  phrases and are distinct from `tags` (compact categorical labels). The
  store normalizes them: surrounding whitespace is trimmed, values are
  lowercased, and duplicates collapse to the first occurrence, preserving
  order; internal whitespace is kept and values are never split on spaces.
  Each alias is at most 80 Unicode code points long after trimming and
  lowercasing, and one
  entry holds at most 20 unique aliases. `engram add --aliases` and
  `engram edit --aliases` split on commas only, so a comma cannot be part of
  an alias through a flag (the structured Pi and OpenCode tools take arrays
  and can). `engram edit --clear-aliases` removes the list. A valid but
  noncanonical hand-written value still reads and is canonicalized on the
  next mediated write. Empty, overlength, over-cap, or wrongly shaped values
  are `aliases_invalid` errors that omit the entry until repaired by hand.

**Authority warning.** Anyone with access to a memory file can write its
lifecycle and provenance fields. Engram keeps source references as supplied.
Agents must evaluate recorded memory against current
evidence and always follow current system, user, and repository instructions
over recorded memory.

`engram check` reports advisory lifecycle conditions as warnings:
`supersedes_not_found` (a `supersedes` id with no claimant in the same scope),
`related_not_found` (a `related` id with no claimant in the same scope),
`related_ambiguous` (a `related` id claimed by two or more same-scope files;
the warning names the sorted claimant paths), `review_due`, and `expired` (the
timestamp is at or before the check time). Relation targets resolve by exact
id within the checked scope only, and a target claimed by an otherwise
invalid file still counts. Malformed relation metadata on a single file stays
an error that omits the entry: `related_invalid` (bad shape or id),
`self_relation`, `duplicate_relation`, and `aliases_invalid` (bad shape, an
empty alias, an alias over 80 code points, or more than 20 unique aliases).
Warnings print as `warning [code]`
and never make `check` fail; errors and unchecked scopes still exit nonzero.
`check --json` may therefore return `ok: true` with
`diagnostics[].severity: "warning"`; JSON consumers must accept that value
space.

Hand-edited files are validated on read: malformed entries never disappear
silently. `engram list` stays fail-open but prints one bounded warning to
stderr for skipped files, and `engram context` (plus the automatic digest)
prepends a bounded warning to its output. Run `engram check` for the exact
paths, machine-readable codes, and repair hints.

Use `engram add` to mint a globally unique ID before editing a file by hand.

## Search metadata

The optional `triggers`, `appliesTo`, and `importance` fields round-trip through Markdown. See [retrieval triggers and path applicability](search.md#retrieval-triggers-and-path-applicability) and [lifecycle ranking](search.md#lifecycle-ranking-and-diverse-results) for values and examples.
