# engram OpenCode plugin

The published [`engram-cli`](https://www.npmjs.com/package/engram-cli) npm
package doubles as an [OpenCode](https://opencode.ai) plugin. Adding it to
OpenCode gives the agent native engram tools with typed, validated parameters.
The tools run in-process against the same store as the CLI—no CLI-on-PATH
shelling out and no prompt pasting.

## Install

Add `engram-cli` to the `plugin` array in one of OpenCode's supported config
files:

- `opencode.json` in the project root for project-specific installation.
- `~/.config/opencode/opencode.json` to make the plugin available globally.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["engram-cli"]
}
```

OpenCode installs npm plugins and their dependencies automatically with Bun at
startup and caches them under `~/.cache/opencode/node_modules/`; no separate
`npm install` command is required. After installing a release that contains the
OpenCode plugin, you can keep a project on that tested release by adding its
published version to the package spec.

Memory scope is independent of where the plugin is configured: the tools read
and write the same scopes as the CLI (`project` inside an initialized repo,
`personal` otherwise). Each call resolves project memory from the active
OpenCode session directory, so separate workspaces do not share project scope.

## Automatic session context (experimental)

The plugin also injects a compact digest of this workspace's recorded memory
(`<engram-memory>` block, decisions and pinned entries first) into the system
prompt of each session, before the first model request. Loading is lazy,
per-session, and fail-open: disabled, empty, or unreadable memory leaves the
prompt untouched and never breaks a session.

How it works and what to expect:

- **Experimental seam**: injection uses OpenCode's
  `experimental.chat.system.transform` hook, which is not yet part of the
  documented public plugin API. Treat automatic loading as best-effort; if a
  future OpenCode release changes or removes the hook, the tools (including
  `engram_context` for manual loading) keep working.
- **Directory semantics**: the digest is resolved from the directory OpenCode
  passed when loading the plugin — the workspace the plugin was initialized
  in. Tool calls still resolve memory from their own per-call session
  directory, so subagent or worktree contexts read their own project scope.
- **Per-session cache**: the digest loads once per session and is reapplied to
  every model request in it. A successful `engram_add` invalidates that
  session's cache, so the next request reflects the new entry. Other sessions
  refresh on their next load.
- **Bounded**: at most 25 entries and 8,192 characters; ids, types, titles,
  and tags only — never full bodies.

Configure it with the global config keys (user-level, not committed project
policy):

```sh
engram config set autoContext off            # disable injection (tools stay)
engram config set autoContextScope both      # project (default) | personal | both
engram config set autoContextLimit 10        # entries per digest, 1..100 (default 25)
```

If the automatic digest did not arrive (experimental hook changed, disabled,
or load failed), call `engram_context` — it renders the same digest on demand.

## What you get

| Tool             | What it does                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `engram_context` | Digest one-liners (id · type · title · tags), decisions and pinned entries first, with `limit`/`offset` paging. |
| `engram_search`  | Relevance search (tags > title > type > body), paginated.                                                       |
| `engram_show`    | Full entry by id (unique prefixes work); long bodies are character-sliced with a next-call footer.              |
| `engram_add`     | Record an entry (type defaults from project config; `scope` defaults to `project`, including outside a repo).   |

## Behavior notes

Result footers name the exact next call (for example,
`engram_context({"offset":25})`), and every result is capped at roughly 8 kB
so a growing store cannot flood the context window. Outside a project, reads
fall back to personal scope with a note; writes to an uninitialized project
scope return an actionable `engram init` hint.

Tool failures are returned as readable output with `metadata.isError: true`
instead of throwing an opaque plugin error.
