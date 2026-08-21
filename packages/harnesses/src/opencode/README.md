# engram OpenCode plugin

The published [`engram-cli`](https://www.npmjs.com/package/engram-cli) npm
package doubles as an [OpenCode](https://opencode.ai) plugin. Adding it to
OpenCode gives the agent native engram tools with typed, validated parameters.
The tools run in-process against the same store as the CLI—no CLI-on-PATH
shelling out and no prompt pasting.

## Install

Add `engram-cli` to the `plugin` array in your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["engram-cli"]
}
```

OpenCode installs npm plugins automatically. After installing a release that
contains the OpenCode plugin, you can keep a project on that tested release by
adding its published version to the package spec.

Memory scope is independent of where the plugin is configured: the tools read
and write the same scopes as the CLI (`project` inside an initialized repo,
`personal` otherwise). Each call resolves project memory from the active
OpenCode session directory, so separate workspaces do not share project scope.

## What you get

| Tool             | What it does                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `engram_context` | Digest one-liners (id · type · title · tags), decisions and pinned entries first, with `limit`/`offset` paging.   |
| `engram_search`  | Relevance search (tags > title > type > body), paginated.                                                         |
| `engram_show`    | Full entry by id (unique prefixes work); long bodies are character-sliced with a next-call footer.                |
| `engram_add`     | Record an entry (type defaults from project config; `scope` defaults to `project` in a repo, `personal` outside). |

## Behavior notes

Result footers name the exact next call (for example,
`engram_context({"offset":25})`), and every result is capped at roughly 8 kB
so a growing store cannot flood the context window. Outside a project, reads
fall back to personal scope with a note; writes to an uninitialized project
scope return an actionable `engram init` hint.

Tool failures are returned as readable output with `metadata.isError: true`
instead of throwing an opaque plugin error.
