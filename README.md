# engram

[![npm](https://img.shields.io/npm/v/engram-cli?label=engram-cli)](https://www.npmjs.com/package/engram-cli)
[![Node](https://img.shields.io/node/v/engram-cli)](https://www.npmjs.com/package/engram-cli)

> An engram CLI for AI agents: durable, human-readable memory for any
> AI-assisted workflow. Works with any harness (Pi, Claude Code, Cursor,
> cloud code-review bots, CI, plain scripts).
>
> An **engram** is the physical trace a memory leaves in the brain. This tool
> gives agents one that survives the session.

## Why

Every fresh agent session starts from zero. That's wasteful and dangerous:
a team that **replaced package X with Y for good reasons** will watch a fresh
agent reintroduce X. Recording the _why_, once, means local sessions _and_
cloud review bots stop making the same mistakes.

`engram` gives agents a place to record what should survive the session:
decisions and their rationale, facts, gotchas, conventions, preferences.
Record once, load back on demand.

Engrams are **plain Markdown files with YAML frontmatter**, readable by humans
and by any agent even without this CLI installed. A `project` scope lives in
your working directory and can be committed to git so a whole team (and every
cloud session) shares the same context. A `personal` scope lives in your home
directory and is never committed.

The flagship use case is coding agents working in repositories, but engram is
useful in any recurring AI-assisted workflow: research, writing, ops, data
analysis. If a session keeps re-learning the same things, that belongs in your
engram.

```sh
engram init --tracked
engram add --title "Replaced moment with date-fns" --type decision --tags deps,date \
  "moment.js is frozen/in-maintenance and ships a large bundle. date-fns is \
tree-shakeable and actively maintained. Migrated all call sites in PR #142."
git add .engram && git commit -m "engram: replaced moment with date-fns"
```

Now every teammate's agent, and the cloud code-review bot that clones the repo,
runs `engram context` and immediately knows the decision and its rationale.

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

# 4. Commit so the team inherits it
git add .engram && git commit -m "engram: tooling preferences"

# 5. Search later
engram search "tooling"
engram show 01jb3            # id or unique prefix
```

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

Most commands accept `--scope personal|project|all`. The default is `project` when
inside an initialized project, otherwise `personal`.

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

### 2. Harness-specific wiring

- **Pi**: `pi install npm:engram-cli`. Ships native tools, an `/engram`
  command, and a skill. See [Pi extension](#pi-extension).
- **OpenCode**: add `"plugin": ["engram-cli"]` to `opencode.json`. Ships four
  native tools with typed, validated parameters. See
  [OpenCode plugin](#opencode-plugin).
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
`engram_show`, `engram_add`) with typed, validated parameters, plus an
`/engram` command and an `engram` skill. No CLI-on-PATH shelling out, no
prompt pasting.

```sh
pi install npm:engram-cli          # global (personal memory everywhere)
```

Per-project setup, the full tool reference, and behavior notes (pagination,
result caps, scope fallbacks): see
[packages/harnesses/src/pi/README.md](packages/harnesses/src/pi/README.md).

---

## OpenCode plugin

The same `engram-cli` npm package is an
[OpenCode](https://opencode.ai) plugin. Add it to `opencode.json` to give the
agent the native `engram_context`, `engram_search`, `engram_show`, and
`engram_add` tools:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["engram-cli"]
}
```

OpenCode installs the package automatically and runs the tools in-process.
Configuration details, version pinning, scope behavior, and the full tool
reference: see
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
---

moment.js is frozen/in-maintenance and ships a large bundle…
```

All frontmatter fields except `id`, `title`, `type`, and `created` are optional.
You can edit these by hand (they're just files), but never invent an id:
`engram add` mints a globally-unique one.

---

## Commands

| Command                                   | Description                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `engram init [--tracked\|--untracked]`    | Initialize `.engram/` and choose git tracking.                                                       |
| `engram add [content]`                    | Record an engram. Body from arg, `--stdin`, or `$EDITOR`.                                            |
| `engram list [--scope] [--type] [--tag]`  | List engrams.                                                                                        |
| `engram search <query> [--scope] [-n]`    | Relevance search (tags > title > type > body).                                                       |
| `engram show <id>`                        | Show one engram in full (id or unique prefix).                                                       |
| `engram edit <id> [content]`              | Edit an engram: flags replace fields, no flags opens `$EDITOR`, `--stdin`/content replaces the body. |
| `engram remove <id> [-y]`                 | Delete an engram.                                                                                    |
| `engram context [-q query] [--full] [-n]` | Emit an agent-ready digest.                                                                          |
| `engram config [get\|set] [key] [value]`  | Keys: `tracked`, `defaultType`, `author`, `editor`.                                                  |
| `engram inject`                           | Print the agent-injection snippet.                                                                   |
| `engram where`                            | Show resolved paths and the current default scope.                                                   |

`add` highlights:

```sh
engram add --title "..." --type decision --tags a,b --pinned "the rationale"
echo "body text" | engram add --title "..." --stdin        # pipe from agents
engram add                                                 # opens $EDITOR (interactive)
```

`edit` highlights:

```sh
engram edit 01jb3 --title "New title" --tags a,b           # replace fields (id or prefix)
engram edit 01jb3 --pinned                                # pin (or --no-pinned)
echo "updated body" | engram edit 01jb3 --stdin           # pipe from agents
engram edit 01jb3                                         # opens $EDITOR (interactive)
```

---

## Development

See [AGENTS.md](AGENTS.md) for the repository layout, architecture notes, and
the exact install/build/test/check commands.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
