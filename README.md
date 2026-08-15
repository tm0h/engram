# engram

> An engram CLI for AI agents — durable, human-readable memory for any
> AI-assisted workflow. Works with any harness: Pi, Claude Code, Cursor, cloud
> code-review bots, CI, or plain scripts.
>
> An **engram** is the physical trace a memory leaves in the brain. This tool
> gives agents one that survives the session.

Agents re-derive context from scratch every session. `engram` gives them
a place to record what should survive the session: decisions and their
rationale, facts, gotchas, conventions, preferences — once — and load it back
on demand.

Engrams are **plain Markdown files with YAML frontmatter** — readable by
humans, readable by any agent even without this CLI installed. The `engram`
CLI just makes recording and retrieval ergonomic. A `project` scope lives in
your working directory and can be committed to git so a whole team (and every
cloud session) shares the same context; a `personal` scope lives in your home
directory and is never committed.

While the flagship use case is coding agents working in repositories, engram is
useful in any recurring AI-assisted workflow — research, writing, ops, data
analysis. If a session keeps re-learning the same things, that belongs in your engram.

Built with [Effect](https://www.effect.website/) (TypeScript). Tested with
Vitest (`@effect/vitest`).

---

## Why

Every fresh agent session starts from zero. That's wasteful and dangerous:
a team that **replaced package X with Y for good reasons** will watch a fresh
agent reintroduce X. Recording the _why_, once, means local sessions _and_
cloud review bots stop making the same mistakes.

```sh
engram init --tracked
engram add --title "Replaced moment with date-fns" --type decision --tags deps,date \
  "moment.js is frozen/in-maintenance and ships a large bundle. date-fns is \
tree-shakeable and actively maintained. Migrated all call sites in PR #142."
git add .engram && git commit -m "engram: replaced moment with date-fns"
```

Now every teammate's agent — and the cloud code-review bot that clones the repo —
runs `engram context` and immediately knows the decision and its rationale.

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
engram show 0001
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
project rule / `.cursorrules` / `AGENTS.md`):

```text
# Engram tool

You have access to a shared memory tool via the `engram` CLI.

- At the start of a session, run `engram context` to load the recorded
  context (decisions, gotchas, conventions).
- When you need specifics, run `engram search "<topic>"`.
- When you learn a durable fact, decision, or gotcha worth remembering,
  record it with `engram add` (use `--type decision` for important choices
  and their rationale).
- Personal notes that should NOT be shared with the team use `--scope personal`
  (stored globally on your machine, never committed).

Engrams live as plain Markdown in `.engram/` and (for this project) are
committed to git, so the whole team and every cloud session share them.
```

### 2. Harness-specific wiring

- **Pi** — add the snippet above to a prompt template / skill, or to the repo's
  `AGENTS.md`.
- **Claude Code** — drop it in `CLAUDE.md`.
- **Cursor** — `.cursor/rules`.
- **Any other harness or bot** — if it can't run a CLI, it can still **read
  files**: point it at `.engram/engrams/*.md` (or `.engram/README.md`),
  which is self-describing.

### 3. Typical session loop (an agent's perspective)

```sh
engram context                 # load the digest at session start
engram search "auth"           # pull specifics on demand
engram add --title "..." --type decision "..."   # record a durable finding
```

---

## File format

Each engram is `<scope-dir>/NNNN-<slug>.md`:

```markdown
---
id: "0001"
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

You can edit these by hand — they're just files — but prefer the CLI so ids and
frontmatter stay consistent.

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
engram edit 0001 --title "New title" --tags a,b             # replace fields
engram edit 0001 --pinned                                  # pin (or --no-pinned)
echo "updated body" | engram edit 0001 --stdin             # pipe from agents
engram edit 0001                                           # opens $EDITOR (interactive)
```

---

## Development

```sh
vp install             # dependencies (delegates to pnpm workspaces)
vp check               # format + lint + type-check (oxfmt / oxlint / tsgo)
vp test run            # vitest, all packages (69 tests across 11 files)
vp pack                # bundle CLI -> packages/cli/dist/index.js
pnpm run dev -- <args> # run the CLI via tsx during development
```

### Repository layout

pnpm workspace (Vite+ toolchain, versions synced via the pnpm catalog):

```
packages/core   @engram/core — the engine as a library:
                domain, store, config, search, formatting, paths,
                and the Effect layers (MainLive). Consumable by any
                harness, not just the CLI.
packages/cli    engram — the `engram` bin: commander dispatch,
                interactive prompts/editors, stdin handling.
```

The CLI depends on `@engram/core` via `workspace:*` and bundles it into
`dist/index.js` at build time (`deps.alwaysBundle`).

### Architecture (Effect)

The core is a small set of **services** (Effect `Context.Service` tags) with
**layers**, all I/O going through `effect`'s `FileSystem` / `Path` / `Terminal`
(run on Node via `@effect/platform-node`):

- `EngramStore` (`packages/core/src/store.ts`) — CRUD over the Markdown files.
- `ConfigRepo` (`packages/core/src/config.ts`) — load/save global + project JSON config.
- Domain models are `effect/Schema` (`packages/core/src/domain.ts`); errors are tagged
  (`packages/core/src/errors.ts`).
- CLI dispatch is `commander`; each command is an `Effect` provided with the
  main layer (`packages/core/src/layer.ts`) and run via `Effect.runPromiseExit` with uniform
  error formatting (`packages/cli/src/index.ts`).

Services are tested against real `NodeServices` on temp directories; pure logic
(search, formatting, slug/tag helpers, path math, scope resolution) has direct
unit tests.

### Tech choices

- **Effect 4.0 RC** (`effect@4.0.0-rc.108`) + `@effect/platform-node` RC.
- **Vitest 4.1.10** (via Vite+) with `@effect/vitest` for `it.effect` / `it.live`.
- `commander` for argv parsing (effect's own CLI framework is `effect/unstable/cli`
  and still in flux in 4.0, so a stable parser is used here).

---

## License

MIT
