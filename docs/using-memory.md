# Use Engram memory

Start with the [quick start](../README.md#quick-start), then use this guide to choose a scope, record an entry, or load a digest.

## Other ways to install

Engram requires Node.js 20 or newer. To try it without a global npm install, or install it with another package manager:

```sh
npx engram-cli@latest --help
pnpm add -g engram-cli
bun add -g engram-cli
```

## Scopes

| Scope      | Location          | Committed?                                    | Use for                                    |
| ---------- | ----------------- | --------------------------------------------- | ------------------------------------------ |
| `project`  | `<repo>/.engram/` | **your choice** (tracked/untracked at `init`) | Team-shared decisions, facts, gotchas      |
| `personal` | `~/.engram/`      | never                                         | Your own global notes, across all projects |

**"Do I want to keep track of this?"** is a per-project decision made at `init`:

- `engram init --tracked` → you can commit `.engram/` to share memory with the team.
- `engram init --untracked` → `.engram/` is gitignored → stays local to you.
- Toggle later with `engram config set tracked on|off` (it keeps `.gitignore` in sync).

Read commands commonly accept `--scope personal|project|all`. Writes accept one
scope. The default is `project` inside an initialized project and `personal`
otherwise.

## Record and edit entries

Use the [entry types and fields](memory-format.md) to pick a type and add lifecycle metadata. `engram add` prints the new ID. Use it or a unique prefix with `engram show` and `engram edit`.

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

## Load a memory digest

`engram list` lists recorded entries. Use `engram context` for an agent-ready digest, or `engram context --tokens 4000` to [limit its size](context-token-budget.md). For individual entries, use [search and related links](search.md).
