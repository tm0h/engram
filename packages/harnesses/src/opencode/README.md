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

## Automatic context (experimental)

OpenCode's `experimental.chat.system.transform` hook can add one
`<engram-memory>` block per model request. Engram uses the active assistant
turn's working directory and the user text from its parent message. Follow-up
requests can retrieve different memories in the same session. The native
tools use the directory supplied on each tool call.

- Pinned and high-importance memories take priority, followed by up to five
  confident query matches. When the query is weak, the bootstrap policy can
  provide title-only context. Engram fits each block to the model headroom
  and global context cap, skips evidence already in the active prompt, and
  keeps each excerpt tied to its scope and ID.
- The plugin caches the latest result per session for up to 30 seconds and
  retains at most 100 sessions. An approved `engram_add` or `engram_edit`
  clears the plugin's cache because sessions can share a project or personal
  store. Session deletion clears that session's entry.
- Automatic delivery leaves the prompt usable when the session or SDK data is
  missing, retrieval fails, or automatic context is disabled. The native tools
  remain available on hosts without the experimental hook.

See the [automatic context budget and evaluation](../../../../docs/automatic-context-compaction.md).

Configure it with the global config keys (user-level, not committed project
policy):

```sh
engram config set autoContext off            # disable injection (tools stay)
engram config set autoContextScope both      # project (default) | personal | both
engram config set autoContextLimit 10        # entries per digest, 1..100 (default 25)
```

Use `engram_context` to read the workspace digest on demand and
`engram_search` when you need more detailed recall.

## What you get

| Tool             | What it does                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `engram_context` | Digest one-liners (id · type · title · tags), decisions and pinned entries first, with `limit`/`offset` paging. |
| `engram_search`  | Relevance search (tags > alias > title > type > body), paginated.                                               |
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

### Curated automatic startup context

OpenCode's fallback uses the same curated selection as the automatic
startup context in other integrations. It selects active pinned memories, decisions with
`importance` at least 3, and critical preferences with `importance` at least 4.
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

| Key                          | Default   | Meaning                                                 |
| ---------------------------- | --------- | ------------------------------------------------------- |
| `autoContext`                | `on`      | Enable automatic context                                |
| `autoContextScope`           | `project` | `project`, `personal`, or `both`                        |
| `autoContextLimit`           | `25`      | Entry ceiling, 1–100                                    |
| `autoContextSelection`       | `curated` | `curated` or legacy decision/pin grouping               |
| `autoContextMaxChars`        | `4800`    | Maximum estimated units for a complete block, 2048–8192 |
| `autoContextIncludeScoped`   | `off`     | Explicitly allow path-specific entries                  |
| `autoContextIncludeInactive` | `off`     | Explicitly allow historical/inactive entries            |

Use `engram config set autoContextMaxChars 6000` to change the budget, or
`engram config set autoContextSelection legacy` for the former selection order.
Existing enable/scope/limit values are retained without rewriting configuration
files; missing new settings use the defaults above. Both selection modes obey
the eligibility toggles and output caps. Manual `engram context` and search
pagination are unchanged. Exact token accounting is a separate capability.
