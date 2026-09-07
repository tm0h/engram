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
engram context            # agent-ready digest (paste into a session)

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

This manual flow is for generic harnesses and bots. The native Pi and
OpenCode integrations below load the digest automatically at session start,
so agents there should not duplicate the startup call.

### 2. Harness-specific wiring

- **Pi**: `pi install npm:engram-cli`. Ships native tools, an `/engram`
  command, a skill, and automatic session-start context loading. See
  [Pi extension](#pi-extension).
- **OpenCode**: add `"plugin": ["engram-cli"]` to `opencode.json`. Ships five
  native tools with typed, validated parameters plus experimental automatic
  session-start context loading. See [OpenCode plugin](#opencode-plugin).
- **Claude Code**: `/plugin marketplace add tm0h/engram`, then
  `/plugin install engram@engram` (brings the skill and an `engram`
  launcher). Or simply drop the snippet above into `CLAUDE.md`.
- **Cursor**: `.cursor/rules`.
- **Any other harness or bot**: if it can't run a CLI, it can still **read
  files**. Point it at `.engram/engrams/*.md` (or `.engram/README.md`),
  which is self-describing.

---

## Pi extension

The published `engram-cli` npm package doubles as a
[Pi](https://github.com/earendil-works/pi) package. Installing it
gives the agent native engram tools (`engram_context`, `engram_search`,
`engram_show`, `engram_add`, `engram_edit`) with typed, validated parameters,
plus an `/engram` command, an `engram` skill, and automatic session-start context
loading: every session begins with a compact digest of recorded memory in
the system prompt (bounded, fail-open, configurable via
`engram config set autoContext off`). No CLI-on-PATH shelling out, no
prompt pasting. Successful adds and edits refresh the cached digest.

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
and `engram_edit` tools, plus experimental automatic session-start context
loading (best-effort through OpenCode's
`experimental.chat.system.transform` hook). Successful adds and edits refresh
the calling session's cached digest:

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
reviewAfter: 2026-01-01T00:00:00.000Z
expires: 2026-06-01T00:00:00.000Z
sourceType: conversation
sourceRef: deps standup, 2025-01-14
---

moment.js is frozen/in-maintenance and ships a large bundle…
```

The frontmatter fields `id`, `title`, `type`, `tags`, `scope`, `created`, and
`updated` are required; `author`, `pinned`, and the six lifecycle fields shown
above are optional. Entries without lifecycle fields need no migration. Unknown
fields with other names are tolerated on read but still dropped on edit, while
the six modeled lifecycle fields are preserved.

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

**Authority warning.** Lifecycle and provenance fields are notes anyone (and
any agent) can write. Engram does not authenticate them, does not resolve or
verify the referenced source, and does not establish that a memory is true,
authoritative, or current. Agents must evaluate recorded memory against current
evidence and always follow current system, user, and repository instructions
over recorded memory.

`engram check` reports advisory lifecycle conditions as warnings:
`supersedes_not_found` (a `supersedes` id with no claimant in the same scope),
`review_due`, and `expired` (the timestamp is at or before the check time).
Warnings print as `warning [code]` and never make `check` fail; errors and
unchecked scopes still exit nonzero. `check --json` may therefore return
`ok: true` with `diagnostics[].severity: "warning"`; JSON consumers must accept
that value space.

Hand-edited files are validated on read: malformed entries never disappear
silently. `engram list` stays fail-open but prints one bounded warning to
stderr for skipped files, and `engram context` (plus the automatic digest)
prepends the same warning to its output. Run `engram check` for the exact
paths, machine-readable codes, and repair hints.

You can edit these by hand (they're just files), but never invent an id:
`engram add` mints a globally-unique one.

---

## Commands

| Command                                                   | Purpose                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `engram init [--tracked\|--untracked]`                    | Initialize project memory and choose whether git tracks it.                                 |
| `engram add [content]`                                    | Record an entry from an argument, standard input, or `$EDITOR`.                             |
| `engram list [options]`                                   | List entries, with scope, type, tag, and lifecycle filters.                                 |
| `engram search <query> [options]`                         | Run BM25 search with query syntax, JSON output, explanations, and pagination.               |
| `engram show <id>`                                        | Show one entry by id or unique prefix.                                                      |
| `engram edit <id> [content]`                              | Replace selected fields or edit the entry interactively.                                    |
| `engram remove <id> [-y]`                                 | Delete an entry.                                                                            |
| `engram context [options]`                                | Emit an agent-ready digest, optionally with full bodies or a focused query.                 |
| `engram review [--scope personal\|project\|all] [--json]` | Find superseded, archived, expired, review-due, or broken-lineage entries.                  |
| `engram check [--scope personal\|project\|all] [--json]`  | Check store integrity, configuration, lifecycle warnings, and secret-scan findings.         |
| `engram dedupe [--scope personal\|project]`               | Replace duplicate ids with fresh globally unique ids.                                       |
| `engram config [get\|set] [key] [value]`                  | Manage tracking, defaults, automatic context, and project or personal secret-scan policies. |
| `engram inject`                                           | Print generic agent instructions for a system prompt or project rule.                       |
| `engram where`                                            | Show resolved storage paths and the current default scope.                                  |

### Structured search

Search uses field-weighted Okapi BM25. Tags carry the most weight, followed by
titles, types, and bodies. Ranking also rewards rarer terms, normalizes field
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
