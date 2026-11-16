# engram Pi extension

The published [`engram-cli`](https://www.npmjs.com/package/engram-cli) npm
package doubles as a [Pi](https://github.com/earendil-works/pi)
package: installing it gives the agent native engram tools with typed,
validated parameters. No CLI-on-PATH shelling out, no prompt pasting.

## Install

```sh
pi install npm:engram-cli          # global: engram tools available in every Pi session
```

Or per-project (committed, teammates get it automatically after trust), in
`.pi/settings.json`. Pin a tested version so everyone loads the same code:

```json
{ "packages": ["npm:engram-cli@0.6.0"] }
```

A git install also works; pin a tag or commit:
`pi install git:github.com/tm0h/engram@v0.6.0`.

Memory scope is independent of install scope: these tools read and write the
same scopes as the CLI (`project` inside an initialized repo, `personal`
otherwise).

## Automatic session context

Every session starts with a compact digest of this workspace's recorded
memory (`<engram-memory>` block, curated pinned/important memories) appended
to the system prompt automatically — startup, `/new`, `/resume`, `/fork`, and
`/reload` all reload it, and it survives compaction because it lives in the
system prompt, not the transcript. No model turn is spent loading it.

Details:

- **Bounded**: at most 25 entries and 4,800 characters by default; the digest lists ids,
  types, titles, and tags only — never full bodies.
- **Fail-open**: disabled, empty, or unreadable memory never blocks a
  session; on failure you get one concise warning and can call
  `engram_context` manually.
- **Fresh after writes**: a successful `engram_add` (tool or `/engram add`)
  invalidates the cached digest, so the next prompt reflects it.

Configure it with the global config keys (user-level, not committed project
policy):

```sh
engram config set autoContext off            # disable injection (tools stay)
engram config set autoContextScope both      # project (default) | personal | both
engram config set autoContextLimit 10        # entries per digest, 1..100 (default 25)
```

## What you get

| Surface               | What it does                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engram_context` tool | Digest one-liners (id · type · title · tags), decisions & pinned first, `limit`/`offset` pagination.                                                 |
| `engram_search` tool  | Relevance search (tags > alias > title > type > body) with paginated score metadata. Optional `explain` adds matched fields and score contributions. |
| `engram_show` tool    | Full entry by id (unique prefixes work); long bodies are char-sliced with a next-call footer.                                                        |
| `engram_add` tool     | Record an entry (type defaults from project config; `scope` defaults to `project` in a repo, `personal` outside).                                    |
| `/engram` command     | Human dispatcher: `context` (default), `search`, `show`, `add <title> -- <body>`, `init`, `help`.                                                    |
| `engram` skill        | When to load, search, and record; personal-vs-project rules.                                                                                         |

## Behavior notes

Result footers always name the exact next call (e.g.
`engram_context({"offset":25})`), and every result is capped (~8 kB) so a
growing store can't flood the context window. Outside a project, reads fall
back to personal scope with a note; writes to an uninitialized project scope
return an actionable init hint.

### Curated automatic startup context

Pi, OpenCode, Claude Code and Codex startup/resume/compaction context uses a
curated bootstrap by default. It selects active pinned memories, decisions with
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
