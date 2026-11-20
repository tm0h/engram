# engram

[![npm](https://img.shields.io/npm/v/engram-cli?label=engram-cli)](https://www.npmjs.com/package/engram-cli)
[![Node](https://img.shields.io/node/v/engram-cli)](https://www.npmjs.com/package/engram-cli)
[![CI](https://github.com/tm0h/engram/actions/workflows/ci.yml/badge.svg)](https://github.com/tm0h/engram/actions/workflows/ci.yml)

> An engram CLI for AI agents: durable, human-readable memory for any
> AI-assisted workflow. Works with any harness (Pi, Claude Code, Cursor,
> cloud code-review bots, CI, plain scripts).
>
> An **engram** is the physical trace a memory leaves in the brain. This tool
> gives agents one that survives the session.

## Why engram

Every fresh agent session starts without the decisions, constraints, and
debugging lessons learned before it. Engram records that context once so local
agents, teammates, and cloud review bots can load it again.

Entries are plain Markdown with YAML frontmatter. Project memory can be
committed with the repository and shared by the team. Personal memory stays in
your home directory and is never committed. The files remain readable even
without the CLI.

---

## Install

The CLI is published to npm as
[`engram-cli`](https://www.npmjs.com/package/engram-cli); the binary it installs
is `engram`. Requires Node >= 20.

```sh
# Install globally
npm install -g engram-cli

# Or try it without installing
npx engram-cli@latest init

# Other package managers work too
pnpm add -g engram-cli
bun add -g engram-cli
```

---

## Quick start

```sh
# 1. In a repo, set up project engram (tracked in git by default)
engram init --tracked

# 2. Record something durable
engram add --title "Use pnpm, not npm" --type preference --tags tooling \
  "Lockfile discipline + speed; CI expects pnpm-lock.yaml."

# 3. See what's recorded
engram list
engram context --tokens 4000  # bounded digest to paste into a session

# 4. Search and validate it
engram search "tag:tooling"
engram check

# 5. Commit project memory so the team inherits it
git add .engram && git commit -m "engram: tooling preferences"
```

`engram add` prints the new id. Use that id, or a unique prefix, with
`engram show` and `engram edit`.

## Features

- **Portable memory:** plain Markdown in personal or project scope.
- **Native agent integrations:** five typed tools for Pi and OpenCode,
  automatic context loading, and a Claude Code plugin.
- **Search that explains itself:** field-weighted BM25, phrases, filters,
  pagination, and structured output.
- **Memory maintenance:** lifecycle metadata, review queues, integrity checks,
  and deterministic duplicate repair.
- **Safer writes:** redacted secret and prompt-injection scanning before
  content reaches disk.

---

## Scopes

| Scope      | Location          | Committed?                                    | Use for                                    |
| ---------- | ----------------- | --------------------------------------------- | ------------------------------------------ |
| `project`  | `<repo>/.engram/` | **your choice** (tracked/untracked at `init`) | Team-shared decisions, facts, gotchas      |
| `personal` | `~/.engram/`      | never                                         | Your own global notes, across all projects |

**"Do I want to keep track of this?"** is a per-project decision made at `init`:

- `engram init --tracked` → `.engram/` is committed → **shared with the team**.
- `engram init --untracked` → `.engram/` is gitignored → stays local to you.
- Toggle later with `engram config set tracked on|off` (it keeps `.gitignore` in sync).

Read commands commonly accept `--scope personal|project|all`. Writes accept one
scope. The default is `project` inside an initialized project and `personal`
otherwise.

---

## Engram types

`decision` · `fact` · `preference` · `note` · `issue` · `context`

`decision` is special: decisions (and `--pinned` engrams) always surface at the
top of `engram context`, so the most consequential context is never buried.

---

## Agent / harness integration

This works with **any** harness because the interface is the CLI plus plain files.

### 1. Give your agent the instructions

Run `engram inject` and paste the output into your agent's system prompt (or a
project rule / `.cursorrules` / `AGENTS.md`). The snippet tells the agent to:

- run `engram context` at session start to load recorded context,
- run `engram search "<topic>"` when it needs specifics,
- record durable findings with `engram add` (`--type decision` for important
  choices and their rationale),
- use `--scope personal` for notes that must not be shared with the team.

Pi and OpenCode automatically recall relevant memory for the current
request. OpenCode can use the curated digest as a fallback. Agents can use the
manual flow when automatic context is unavailable or they need more detail.

### 2. Harness-specific wiring

- **Pi**: `pi install npm:engram-cli`. Ships native tools, an `/engram`
  command, a skill, and automatic contextual recall. See
  [Pi extension](#pi-extension).
- **OpenCode**: add `"plugin": ["engram-cli"]` to `opencode.json`. Ships five
  native tools with typed, validated parameters plus experimental contextual
  recall. See [OpenCode plugin](#opencode-plugin).
- **Claude Code**: `/plugin marketplace add tm0h/engram`, then
  `/plugin install engram@engram` (brings the skill and an `engram`
  launcher). Or simply drop the snippet above into `CLAUDE.md`. Without the
  plugin, `engram install claude` scaffolds the project skill at
  `.claude/skills/engram/` (project skill scaffold; distinct from
  `engram install claude-code`, which sets up user-level hooks).
- **Cursor**: `engram install cursor` scaffolds `.cursor/rules/engram.mdc`
  as an always-applied project rule (`.cursor/rules` is picked up by
  Cursor; user `.mdc` files stay untouched).
- **Generic (AGENTS.md)**: `engram install generic` maintains a managed
  engram section in the project's `AGENTS.md`; foreign content is
  preserved and `--uninstall` removes only the managed block.
- **Any other harness or bot**: if it can't run a CLI, it can still **read
  files**. Point it at `.engram/engrams/*.md` (or `.engram/README.md`),
  which is self-describing.

---

## Pi extension

The published `engram-cli` npm package doubles as a
[Pi](https://github.com/earendil-works/pi) package. Installing it
gives the agent native engram tools (`engram_context`, `engram_search`,
`engram_show`, `engram_add`, `engram_edit`) with typed, validated parameters,
plus an `/engram` command, an `engram` skill, and automatic contextual
recall. Pi uses the current prompt to add relevant memory excerpts to the
system prompt. Disable it with `engram config set autoContext off`. The
next prompt after an add or edit uses the updated store.

```sh
pi install npm:engram-cli          # global (personal memory everywhere)
```

For per-project setup and behavior notes such as pagination, result caps, and
scope fallbacks, see
[packages/harnesses/src/pi/README.md](packages/harnesses/src/pi/README.md).

---

## OpenCode plugin

The same `engram-cli` npm package is an
[OpenCode](https://opencode.ai) plugin. Add it to `opencode.json` to give the
agent the native `engram_context`, `engram_search`, `engram_show`, `engram_add`,
and `engram_edit` tools. The experimental system transform injects relevant
memory for the current request from the active workspace. When recall finds
no strong match, the curated digest is available as a fallback. Successful
adds and edits refresh cached context across sessions.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["engram-cli"]
}
```

OpenCode installs the npm package and its dependencies automatically with Bun
at startup, then runs the tools in-process. For configuration locations,
version pinning, and scope behavior, see
[packages/harnesses/src/opencode/README.md](packages/harnesses/src/opencode/README.md).

---

## File format

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

### Lifecycle fields

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

### Aliases

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

**Authority warning.** Lifecycle and provenance fields are notes anyone (and
any agent) can write. Engram does not authenticate them, does not resolve or
verify the referenced source, and does not establish that a memory is true,
authoritative, or current. Agents must evaluate recorded memory against current
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

You can edit these by hand (they're just files), but never invent an id:
`engram add` mints a globally-unique one.

### Local pending memory

The pending-memory store keeps proposals in `.engram/pending/` for the current
project and `~/.engram/pending/` for personal memory. Both queues install a
Git ignore rule before writing, including in projects with tracked canonical
memory. Each version-1 JSON file contains the proposed title, type, tags and
body, a source excerpt, its provenance class, the scope, duplicate and conflict
references by scope and ID, and the creation time. A reference is an advisory
hint. The queue is separate from canonical Markdown, and ordinary search and
context only read canonical memory.

The queue rejects excerpts and proposed text flagged by the secret and
prompt-injection scanner. Diagnostics give scanner rule information without
quoting matched text. Files are published atomically under unique IDs.

Pending files have no automatic expiry. Review them with the packaged CLI:

```sh
engram pending list --scope all
engram pending show <id>
engram pending edit <id> --patch '{"title":"Updated decision","tags":["capture"]}'
engram pending approve <id> --dry-run
engram pending approve <id>
engram pending reject <id>
```

Use full pending IDs. Review defaults to project scope when initialized and
personal scope otherwise. Use `--scope personal` or `--scope project` to select
the queue explicitly. `show` includes the source excerpt and the original
capture hints. `edit` changes only the supplied proposal fields (`title`,
`type`, `tags`, `body`) and accepts a JSON patch on stdin with `--stdin`.
Rejection discards the local queue file.

Approval previews the full canonical Markdown, including its ID, timestamps,
and provenance, before prompting. The timestamps come from the proposal,
`sourceType` comes from its provenance class, and `sourceRef` records its
pending ID. The source excerpt and capture hints stay in the queue. Use
`--dry-run --json` to get the exact file bytes as the `markdown` string.
Approval revalidates the proposal and checks the current canonical store
before publishing. Sensitive content and exact duplicates block approval.
Review likely duplicates and possible conflicts before retrying with
`--confirm-write`. If validation fails, edit or reject the pending candidate.
If queue cleanup fails after publication, retry approval to finish cleanup
using the existing canonical memory. The leftover queue file cannot be edited.
Use `engram edit` on the canonical memory to make changes.

Pass multiple IDs to `show`, `edit`, `approve`, or `reject` to process a
batch in one scope. A batch edit applies the same patch to each candidate.
Each ID has its own outcome, and the process exits 1 if any item fails or
requires cleanup. `--json` emits one versioned document with a `results`
array on stdout. Use `--yes` for non-interactive approval. To approve a
previously reviewed proposal, pass `--expect <revision>` from its dry run
with `--yes` and one ID. With `--yes --json`, pre-write previews go to
stderr. Use `engram review` for
the canonical lifecycle report.

After an interrupted process, remove leftover `.write-*` staging directories
or a candidate's `<id>.json.lock` directory only after all writers have stopped.
If approval also left a canonical store `.write-lock`, clear it under the same
condition before retrying.

---

## Commands

| Command                                                   | Purpose                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `engram init [--tracked\|--untracked]`                    | Initialize project memory and choose whether git tracks it.                                            |
| `engram add [content]`                                    | Record an entry from an argument, standard input, or `$EDITOR`.                                        |
| `engram list [options]`                                   | List entries, with scope, type, tag, and lifecycle filters.                                            |
| `engram search <query> [options]`                         | Run BM25 search with query syntax, JSON output, explanations, and pagination.                          |
| `engram show <id>`                                        | Show one entry by id or unique prefix.                                                                 |
| `engram links <id> [options]`                             | Show the link graph around one entry: outgoing related plus incoming backlinks, exact ids, same scope. |
| `engram edit <id> [content]`                              | Replace selected fields or edit the entry interactively.                                               |
| `engram remove <id> [-y]`                                 | Delete an entry.                                                                                       |
| `engram context [options]`                                | Emit an agent-ready digest with an optional token budget, full bodies, or a focused query.             |
| `engram review [--scope personal\|project\|all] [--json]` | Find superseded, archived, expired, review-due, or broken-lineage entries.                             |
| `engram check [--scope personal\|project\|all] [--json]`  | Check store integrity, configuration, lifecycle warnings, and secret-scan findings.                    |
| `engram doctor [--json]`                                  | Diagnose store health, effective settings, managed integration assets, and index state.                |
| `engram stats [--json] [--clear] [--disable\|--enable]`   | Summarize local memory usage, clear history, or change collection settings.                            |
| `engram dedupe [--scope personal\|project]`               | Replace duplicate ids with fresh globally unique ids.                                                  |
| `engram config [get\|set] [key] [value]`                  | Manage tracking, defaults, automatic context, and project or personal secret-scan policies.            |
| `engram inject`                                           | Print generic agent instructions for a system prompt or project rule.                                  |
| `engram where`                                            | Show resolved storage paths and the current default scope.                                             |

### Budgeted context

`engram context --tokens 4000` fits the entire digest in 4,000 units under
Engram's conservative `utf8-nfkd-bytes-v1` accounting. The minimum is 512.
Combine the budget with `--scope`, `--query`, `--full`, `--limit`, or
`--all` as needed. Pi and OpenCode also accept a numeric `tokens` argument
on `engram_context`. See the [context budget contract and tokenizer
comparison](https://github.com/tm0h/engram/blob/main/docs/context-token-budget.md) for the exact counting rules
and flag interactions.

### Local diagnostics and statistics

Run `engram doctor` to see both project and personal stores. It distinguishes
missing or unreadable stores, initialized empty stores, and stores with
integrity errors. Advisory lifecycle warnings include affected files and repair
hints. Configuration and automatic context have their own states, so disabled
automatic context can appear alongside healthy stores. The report checks the
five targets managed by `engram install` and the local Codex hooks setting.
Integration states describe local files, and runtime reachability is unknown.
Pi and OpenCode plugin registration is outside the installer scan. BM25
builds its field statistics in memory on demand. Doctor is read-only
and exits successfully after reporting, including when it finds problems. Use
`engram check` when integrity errors should fail the command.

`engram stats` summarizes recent use of the CLI and harnesses. Both commands
support `--json` for one versioned report on stdout.

| Metric                        | How it is counted                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loads                         | Each completed CLI context request, tool digest, and automatic delivery attempt. An OpenCode fallback counts once with its final fitted output. Cached OpenCode retrieval is fitted and counted for each transform. Pi provider retries reuse the fitted block.                                                      |
| Searches and zero-result rate | Each completed explicit CLI or tool search, including pagination calls. Zero-result rate divides searches with zero matches by all recorded searches. The total match count determines zero-result status even on an empty page. Focused context requests and automatic recall count as loads.                       |
| Show after search             | Percentage of searches with matches followed by a successful show within five minutes on the same surface (CLI or tool). A show is paired once with the most recent search, and a zero-result search breaks the chain. The association uses only timestamps and operation categories across workspaces and sessions. |
| Context bytes                 | UTF-8 payload size before the CLI transport newline. A warning-only payload contributes bytes, while a plain empty placeholder contributes zero. The average uses only loads with a payload.                                                                                                                         |
| Latency                       | Average and maximum wall-clock milliseconds for recorded searches and load attempts. Timing covers retrieval and rendering where applicable and excludes statistics storage.                                                                                                                                         |
| Candidate decisions           | Automatic recall counts ranked matches, weak matches, bootstrap duplicates, selected entries, and entries skipped by the result limit or payload budget. Startup digests count selections, applicable policy exclusions, and entries skipped by limit or budget.                                                     |

Statistics stay in `~/.engram/stats/events.json`, separate from project memory.
The file retains the newest 1,000 events in recording order, without a time
expiry. Records contain only a local timestamp, operation category, counts, sizes,
durations, and outcomes. All collection and reporting happen on the machine.

Use `engram stats --disable` to stop collecting for the local account and
`engram stats --enable` to resume. Set `ENGRAM_STATS=off` in a CLI or host
environment to opt out for those processes regardless of the saved setting.
`engram stats --clear` removes recorded events and preserves the collection
setting. Use `engram stats --disable --clear` to stop collection and remove
history together. Recording has a short deadline so automatic context can
proceed if the statistics directory is slow or the write lock stays busy.
Collection also skips writes to an invalid or inaccessible statistics file.
Use `--clear` to reset an invalid file. If a terminated writer leaves a stale lock and `--clear` reports
that statistics are locked, stop active Engram CLI and harness processes,
remove `~/.engram/stats/.lock`, then retry.

### Structured search

Search uses field-weighted Okapi BM25. Tags carry the most weight, followed by
aliases, titles, types, and bodies (tag 5, alias 4, title 3, type 2, body 1,
plus +0.5 for pinned). Aliases are alternate names, distinct from tags;
entries hold at most 20 aliases of 80 characters, and multi-word aliases match
through the phrase bonus. Ranking also rewards rarer terms, normalizes field
length, and gives pinned entries a small boost.

The query language supports quoted phrases, bounded prefixes, field filters,
and explicit Boolean groups:

```sh
engram search '"release checklist"'                    # boost a contiguous phrase
engram search 'kuber*'                                 # match a token prefix
engram search 'tag:auth AND body:rotation'             # require both terms
engram search 'title:deploy OR type:decision'          # match either term
```

Whitespace has the same meaning as `OR`. Uppercase `AND` binds more tightly
than `OR`; lowercase `and` and `or` remain ordinary terms. Filters accept
`tag:`, `title:`, `type:`, and `body:`. Quoted phrases add a contiguous-match
boost rather than excluding results that match only part of the phrase.

`engram search "auth" --json --explain --limit 10 --offset 0` emits one JSON
document. `--json` alone omits explanations. `--explain` alone emits plain-text
score contributions instead of snippets.

```json
{
  "schemaVersion": 1,
  "query": "auth",
  "total": 1,
  "offset": 0,
  "limit": 10,
  "nextOffset": null,
  "results": [
    {
      "id": "0001",
      "scope": "project",
      "title": "Auth policy",
      "type": "note",
      "tags": [],
      "updated": "2026-01-01T00:00:00.000Z",
      "pinned": false,
      "score": 0.39229373516151933,
      "explanation": {
        "mode": "relevance",
        "contributions": [
          {
            "field": "title",
            "token": "auth",
            "score": 0.39229373516151933,
            "component": "bm25"
          }
        ]
      }
    }
  ]
}
```

Results are globally ranked across selected scopes, then paginated. CLI search
defaults to the current project, or personal scope outside a project. Use
`--scope all` for both. The default limit is unlimited (`limit: null`). A supplied
limit is a positive safe integer; offset is a nonnegative safe integer and
requires `--json` or `--explain`. An offset beyond the end returns an empty page
with the requested offset and unchanged total. `nextOffset: null` means no more
results. Default text mode retains scope grouping and its per-scope limit.

Each result is identified by both `scope` and `id`. Summaries omit bodies,
filesystem paths, authors, and source references. Contributions contain a
normalized query token, score, field, and component (`bm25`, `phrase`,
`prefix`, or `pinned`). Their scores sum to the result score. A pinned entry can
surface without a lexical match. Empty or punctuation-only queries use recency
ordering with score 0.

Pi and OpenCode `engram_search` expose the same versioned report as result
metadata, with `explain: true` enabling contributions. Their text responses
retain 10-result pagination. CLI errors exit nonzero and keep stdout free of
partial JSON. Use `--all` to include inactive entries in CLI search.

`add` highlights:

### Link graph

`engram links <id>` prints the link graph around one entry. Outgoing rows
follow the entry's authored `related` order; incoming rows list backlinks in
creation order (ties break by id). Ids are exact and same-scope only: a strict
prefix never resolves, and an id present only in the other scope reads as
missing rather than falling back.

A missing target carries a literal `MISSING` marker; an id claimed by several
files carries `AMBIGUOUS` with a bounded claimant list. Both are successful
reads, never errors. Output is plain text, capped at ~8 kB, and paginated over
one flattened row stream:

```sh
engram links 0012                        # default page: 10 rows
engram links 0012 --scope personal       # read the personal scope explicitly
engram links 0012 --offset 10 --limit 20 # continue past the first page
```

The continuation footer names the next call. Related links themselves are
written with `engram add --related` / `engram edit --related`.

`add` highlights:

```sh
engram add --title "..." --type decision --tags a,b --pinned "the rationale"
echo "body text" | engram add --title "..." --stdin        # pipe from agents
engram add                                                 # opens $EDITOR (interactive)

# lifecycle metadata (all optional; enums and zoned timestamps validated)
engram add --title "..." --status active --supersedes 0001 \
  --review-after 2026-06-01T00:00:00.000Z --expires 2027-01-01T00:00:00.000Z \
  --source-type file --source-ref docs/spec.md "the newer guidance"
```

`edit` highlights:

```sh
engram edit 01jb3 --title "New title" --tags a,b           # replace fields (id or prefix)
engram edit 01jb3 --pinned                                # pin (or --no-pinned)
echo "updated body" | engram edit 01jb3 --stdin           # pipe from agents
engram edit 01jb3                                         # opens $EDITOR (interactive)

# lifecycle: set or change values, or clear with the paired --clear-* flags
engram edit 01jb3 --status superseded --supersedes 0001 --review-after 2026-08-01T00:00:00.000Z
engram edit 01jb3 --clear-review-after --clear-expires --clear-source-type
```

### Duplicate and conflict advisories

Add and edit check the destination scope. An exact match has the same title
and body after trimming, Unicode NFC normalization, and line-ending
normalization. Case, punctuation, and interior whitespace still matter.
Metadata differences do not make an exact copy distinct. Exact matches
are refused even against inactive memories. Editing an existing record
excludes that record from comparison, and ordinary metadata-only updates
can still proceed.

Likely duplicates use overlapping title, body, and tag terms. Possible
conflicts use matching subjects and differing preference or decision text.
These advisories consider active entries and exclude an explicitly
superseded predecessor. Each advisory names the existing `scope:id`.
The CLI exits 1 without saving. Review the entries, then retry with
`--confirm-write` if the write is intentional. Pi and OpenCode tools take
`confirmWrite: true`. Confirmation cannot override exact duplicates or
the secret scan. A confirmed write preserves the other entries unless
you explicitly specify a lifecycle change such as `--supersedes`.

### Secret and prompt-injection scanning

Every write through `engram add` and `engram edit` (and the Pi/OpenCode
`engram_add`/`engram_edit` tools) scans the complete serialized entry for
credentials, high-entropy tokens, private-key markers, invisible Unicode,
prompt-injection instructions, and credential-exfiltration instructions.
Findings are deterministic and redacted: diagnostics name a rule id, line,
and column, and never contain the matched text.

Policy is per scope, defaulting to `block` for project writes and `warn` for
personal writes:

```sh
engram config set secretScan block|warn|off            # project writes
engram config set personalSecretScan block|warn|off    # personal writes
```

`block` rejects the write before any file changes, so a blocked write leaves
storage byte-identical. `warn` writes and prints the findings. `off` disables
scanning. `--allow-secrets` (CLI) / `allowSecrets` (tools) overrides a block
for that one write; the bypass is reported in the output. Bare hashes, UUIDs,
and ULID-style ids are never flagged. Internal lifecycle marking (superseding
a predecessor) bypasses scanning because it introduces no user content;
`engram dedupe` rewrites existing content unchanged and is likewise
unguarded.

`engram check` also scans every readable raw Markdown file in the store,
including files with malformed frontmatter, reporting `secret_detected`
diagnostics: errors under `block`, warnings under `warn`, nothing under
`off`. If a scope's config cannot be loaded, that scope's scan is skipped and
reported uncheckable (fail closed).

---

## Help and contributing

Run `engram --help` or `engram <command> --help` for CLI help. Report bugs and
request features in [GitHub Issues](https://github.com/tm0h/engram/issues).

Contributors should start with [AGENTS.md](AGENTS.md) for the repository layout,
coding conventions, and verification commands. Search and corpus changes must
also follow [corpus/README.md](corpus/README.md). Release maintainers should use
[RELEASING.md](RELEASING.md).

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT

### Retrieval triggers and path applicability

`engram add --triggers "fix login,auth troubleshooting" --applies-to "packages/api/**"`
records exact whole-query trigger phrases and repository-relative path patterns.
Triggers use the alias normalization and limits (20 unique phrases, 80 code points),
but match the entire query and add a fixed +4 contribution labeled `trigger` in
`search --explain`. They do not bypass explicit field filters or AND queries.
Aliases remain the general BM25 vocabulary field.

`engram search "fix login" --path packages/api/auth.ts --explain` filters out
memories whose nonempty `appliesTo` patterns do not match. Unscoped memories stay
eligible. Without `--path`, applicability does not filter. Paths are case-sensitive
and repository-relative with forward slashes; absolute paths and `..` are rejected.
Patterns support `*` within a segment and `**` across segments; no other glob syntax.
At most 20 patterns, 256 characters each. `engram edit <id> --triggers ""` or
`--applies-to ""` clears that field; omitting the flags preserves it. Fields also
round-trip through Markdown. These flags belong to the CLI; use the CLI to manage
them from harnesses.

### Lifecycle ranking and diverse results

Search keeps inactive memories ineligible by default. After lexical abstention and
exact-trigger matching, active results receive small explained bonuses:
`importance` adds 0.1 per level (optional integer 0–5, default absent), matching
`appliesTo` adds 0.25 when `search --path` is supplied, and recent notes/issues
receive up to 0.25, decreasing linearly to zero after 30 days. Invalid or future
update times receive no freshness bonus. Decisions, facts, preferences, and context
have no age-based adjustment. Pinning and trigger contributions remain separately
visible. These new adjustments never admit an otherwise unmatched memory.

Use `engram add --importance 5` or `engram edit <id> --importance 3` to set author
importance; `engram edit <id> --importance ""` clears it. The optional Markdown
`importance` key round-trips through edits and appears in `show`. Use the CLI to
manage importance from harnesses.

Search diversification conservatively compares same-scope, same-type memories
whose titles have at least 80% token-set overlap and whose bodies have at least
90% overlap (at least eight unique body tokens). It keeps the strongest match
from each group ahead of repeated content; duplicates remain available later
with a negative `diversification` contribution. Comparison is bounded to 64 group
representatives and bodies up to 16 KiB/titles up to 1 KiB; larger entries are
never classified using a truncated prefix. `--explain` contributions still sum
to the final score. Recency-only listing and the legacy benchmark ranker are
unchanged. Pagination runs after this ranking.

### Curated automatic startup context

Claude Code and Codex use a curated bootstrap by default for their digest
hooks. Pi and OpenCode use [automatic context compaction](docs/automatic-context-compaction.md)
to fit their active prompts, and OpenCode uses the curated selection policy
for fallback candidates.
The digest selects active pinned memories, decisions with `importance` at least 3,
and critical preferences with `importance` at least 4.
Path-specific entries (`appliesTo`) are excluded unless explicitly enabled.
Pinned entries come first, then importance descending; project scope and id break
ties. Selection does not depend on file scan order or age. Ordinary notes and
unrated decisions remain available through manual context/search/show.

The default budget is 4,800 characters (roughly 1,200 tokens, not an exact token
count), including the wrapper, headers and footer. Whole sanitized digest lines
are packed within both the character budget and the 8 KiB hook byte ceiling;
no bodies are injected. Existing per-line sanitization, fail-open behavior and
hook timeouts remain in place. Structured operation diagnostics expose selected
ids/scopes/reasons, exclusion counts, and budget/entry-limit omissions outside
injected text.

Global settings:

| Key                          | Default   | Meaning                                      |
| ---------------------------- | --------- | -------------------------------------------- |
| `autoContext`                | `on`      | Enable automatic context                     |
| `autoContextScope`           | `project` | `project`, `personal`, or `both`             |
| `autoContextLimit`           | `25`      | Entry ceiling, 1–100                         |
| `autoContextSelection`       | `curated` | `curated` or legacy decision/pin grouping    |
| `autoContextMaxChars`        | `4800`    | Entire payload budget, 2048–8192 characters  |
| `autoContextIncludeScoped`   | `off`     | Explicitly allow path-specific entries       |
| `autoContextIncludeInactive` | `off`     | Explicitly allow historical/inactive entries |

Use `engram config set autoContextMaxChars 6000` to change the budget, or
`engram config set autoContextSelection legacy` for the former selection order.
Existing enable/scope/limit values are retained without rewriting configuration
files; missing new settings use the defaults above. Both selection modes obey
the eligibility toggles and output caps. Manual `engram context` and search
pagination are unchanged. Exact token accounting is a separate capability.

### Matching snippets and related context

Search text, JSON, and harness results now show a bounded matching body excerpt
(maximum 240 UTF-16 characters, including ellipses) and a compact relevance reason.
Excerpts prefer the earliest contiguous query phrase, then the earliest lexical
match. Original Unicode graphemes are retained; whitespace is collapsed.
Metadata-only matches have `snippet: null`, rather than an unrelated body preview.
Detailed score contributions remain opt-in with `--explain`.

`engram related <id> [--scope project|personal] [--offset n] [--limit n]`
shows direct `supersedes` and `superseded by` lineage plus authored `related`
links and computed `related by` backlinks, including inactive entries. It uses
one same-scope scan, exact ids, and the existing missing/ambiguous resolution
rules. Outgoing lineage precedes outgoing links, then incoming lineage and
backlinks; incoming groups sort by creation time and id. The default page is 10
rows, maximum 100, with an 8192-character output cap and continuation footer.
No semantic or transitive edges are inferred or persisted. `engram links` keeps
its explicit-link-only behavior. Pi also supports `/engram related <id>` with
the same flags. Harness recalled snippets and related context are framed as
untrusted data; complete frames and continuation details survive size capping.
