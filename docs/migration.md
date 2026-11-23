# Import and export memory

Initialize project memory with `engram init` before a project import or
export. Pass explicit filenames. Paths in outcomes and provenance are
relative to the project root for project imports and the current directory
for personal imports.

```sh
engram import AGENTS.md CLAUDE.md README.md .cursor/rules/testing.mdc
engram import AGENTS.md CLAUDE.md README.md .cursor/rules/testing.mdc --apply
engram import ~/.hermes/memories/MEMORY.md --format hermes --scope personal
engram import ~/.openclaw/workspace/MEMORY.md --format openclaw --scope personal
engram pending list --scope project
engram pending show <pending-id> --scope project
engram pending approve <pending-id> --scope project --dry-run
engram export AGENTS.md CLAUDE.md
```

## Supported import files

| File                           | Candidate boundaries                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`, `CLAUDE.md`       | Markdown ATX heading sections and any introductory body. Included files and links are left as text.                                                                                                                                                                                              |
| Cursor                         | `.cursor/rules/**/*.mdc` with delimited frontmatter and legacy `.cursorrules`. MDC activation metadata stays in the preview for review. Engram does not activate the rule or translate Cursor activation settings. See [Cursor rules](https://cursor.com/docs/rules).                            |
| `README.md`                    | ATX sections named Conventions, Coding Style, Coding Standards, Coding Conventions, Style Guide, Development Conventions, Project Conventions, Repository Guidelines, or Guidelines, including descendant sections.                                                                              |
| Hermes (`--format hermes`)     | `MEMORY.md` and `USER.md`. Each entry is split on the on-disk `\n§\n` delimiter after newline normalization. An inline section sign stays in its entry. See the [Hermes memory store](https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool_store.py).                        |
| OpenClaw (`--format openclaw`) | Workspace `MEMORY.md`, `USER.md`, and explicit `memory/YYYY-MM-DD.md` or `memory/YYYY-MM-DD-<slug>.md` files. Markdown portions become review candidates. Review dated entries for relevance before approval. See [OpenClaw workspace files](https://docs.openclaw.ai/concepts/agent-workspace). |

Imports support UTF-8. Markdown heading extraction respects fenced code.
Engram-managed Markdown sections are ignored when extracting Markdown
candidates. The command takes up to 50 files, 256 KiB per file, and 250
proposals per batch, with an 8 KiB limit per candidate. Pass scope explicitly
for Hermes or OpenClaw. The latter two formats can contain personal data, so
choose which store should hold the review queue.

Preview shows eligible proposals before staging and reports skipped, rejected,
or failed inputs with path and line where known. Sensitive candidates are
rejected with rule codes and no matching text. Exact and likely duplicates
and possible conflicts against canonical or pending memory are skipped. On
apply, the preview goes to stderr before any candidate is staged. The command
rechecks pending and canonical memory before staging the eligible candidates.
Source bytes are preserved. Apply stages each candidate with its source
format, path, and line. Approvals use the existing pending review commands and
record the file reference as `path#Lnn`. Reapplying skips existing candidates
and previously approved source locations. A rejected pending candidate can be
re-imported by explicitly applying again.

## Managed export

Export writes a digest of active, globally applicable, canonical project
entries. Personal entries, pending entries, and entries flagged by the
content scanner are excluded. The shared context renderer bounds the digest
body to 2,048 UTF-8/NFKD byte units. Export can target up to 50 explicit
project-relative `.md` files. A missing file is created if its parent exists.
Export refuses symlink targets and parents, Engram and Git storage paths,
invalid UTF-8, ambiguous markers, and targets over the 256 KiB limit.

The digest uses `<!-- BEGIN: engram-memory-digest -->` and
`<!-- END: engram-memory-digest -->` markers. Export adds or replaces only
the managed block and preserves bytes outside it, including CRLF and existing
unterminated text. Repeating an export with the same digest leaves the file
unchanged.

Use `--json` for one versioned result on stdout. Each row identifies the
file, outcome, and any candidate ID, line, or reason. Exit 0 means the batch
completed with successful or skipped items. Exit 1 means at least one
rejection or failure. Successful items in a partial batch are retained.
