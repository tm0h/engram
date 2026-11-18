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

## Automatic contextual recall

Pi searches the current workspace with the expanded user prompt on each full
prompt, including the first one. With a confident match, it adds one bounded
block of up to five entries with short excerpts to that run's system prompt.
Pi reuses the system prompt for tool continuations and provider retries, and
rebuilds it on the next full prompt. Messages queued as steering or follow-ups
during streaming continue with the running prompt's context.

Weak matches, empty stores, disabled recall, and read failures leave the system
prompt alone. Print and JSON modes use the same hook without UI. Interactive
sessions can show one warning if memory is unavailable. Successful tool and
`/engram` adds and edits invalidate any in-flight read. The next full prompt
reads the latest store and settings.

```sh
engram config set autoContext off            # disable automatic recall
engram config set autoContextScope both      # project (default) | personal | both
```

Use `engram_context` for a workspace digest, or `engram_search` and
`engram_show` for focused manual recall.

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

### Recall limits

See [shared contextual recall](../../../../docs/contextual-recall.md) for the
confidence policy and bounds. Pi supplies the task prompt and its working
directory. Path-specific memories remain available through manual search.
