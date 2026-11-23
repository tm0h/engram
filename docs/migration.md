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
record the project file reference as `path#Lnn`. Personal approvals use a hash
of the resolved source path and the line number to distinguish files with the
same name in different projects. The pending candidate retains the readable
path. Reapplying skips existing candidates and previously approved source
locations. A rejected pending candidate can be
re-imported by explicitly applying again.

## Local template packs

Set `ENGRAM_PACK_DIR` to an absolute path containing named pack directories.
Engram looks for `$ENGRAM_PACK_DIR/<name>/pack.json` using the directory you
explicitly configured. It never looks for packs in the current project or on
the network. The package currently ships without built-in packs.

```sh
export ENGRAM_PACK_DIR="$HOME/memory-packs"
engram import --pack team-conventions
engram import --pack team-conventions --apply
engram pending list --scope project
engram pending show <pending-id> --scope project
engram pending approve <pending-id> --scope project --dry-run
```

Use `--scope personal` to work in the personal queue and store. A pack import
takes no positional filenames or `--format`. Preview is read-only. Apply
prints the preview to stderr and stages eligible candidates in the selected
scope. Treat pack text as untrusted and compare conflicts with local memory.
Use `pending edit`, `pending reject`, or explicit `pending approve` to
review each proposed entry. A pending edit can replace `reviewAfter` or
`expires` with an ISO 8601 timestamp or clear either with `null`:

```sh
engram pending edit <pending-id> --patch '{"reviewAfter":"2090-02-01T00:00:00Z","expires":null}'
```

### Authoring a pack

Place a UTF-8 JSON manifest named `pack.json` in the named pack directory.

```json
{
  "schemaVersion": 1,
  "name": "team-conventions",
  "version": 1,
  "entries": [{ "id": "isolated-checkouts", "file": "entries/isolated-checkouts.json" }]
}
```

Names and entry IDs are lowercase ASCII slugs, up to 64 characters. Start
with a letter or digit and use letters, digits, and hyphens. The name must
match the directory and the argument to `--pack`. Use a positive integer
version up to 999,999,999 and keep entry IDs stable across versions. Include
1–50 entries with unique IDs. Entry files must be relative `.json` paths. Each
component before the extension uses ASCII letters, digits, underscores, or
hyphens. Engram rejects symlinked pack directories, manifests, and entry
paths, including symlinked intermediate directories. Files are limited to
256 KiB each and the combined title and body to 8 KiB.

```json
{
  "schemaVersion": 1,
  "type": "decision",
  "title": "Isolate parallel checkouts",
  "body": "Use a separate Git worktree for each independent change.",
  "reviewAfter": "2090-01-01T00:00:00Z"
}
```

An entry requires a nonblank title and Markdown body and a supported
[entry type](../README.md#commands). Optional lifecycle fields are
`status: "active"`, `reviewAfter`, and `expires`. Dates must have an explicit
ISO 8601 time zone, expiry must be in the future at import, and review must
be due by expiry when both are set. Schema version 1 rejects unknown fields,
including hooks, provenance overrides, and supersession instructions. Engram
reads data files only and never executes pack content or follows Markdown
references. Secret and prompt-injection findings reject a proposal and report
rule codes without including the flagged text.

### Retries and upgrades

A pending pack entry records the pack name, version, entry ID, relative file,
and digest of the original normalized proposal. Approval retains the pack
identity and digest in `sourceRef: pack:<name>@<version>/<entry-id>#<digest>`.
Edits in the pending-review flow keep that original provenance. Rejection
removes the candidate and keeps an identity-only marker in the local queue.

Engram skips a version already pending, approved, or rejected. Changing the
content of a recorded entry requires a new version. On upgrade, unchanged
proposals and revisions older than a recorded revision of that entry are
skipped. Exact and likely duplicates are skipped. Changed entries can be
staged with conflict references. Preview identifies earlier conflicting
proposals in the same batch by their pack entry IDs. Apply reports and saves
their pending IDs, which can be opened with `pending show` while those
proposals remain pending. Approval checks for conflicts again and
requires `--confirm-write` when the same pack entry already exists in
canonical memory. It creates a new entry after explicit review. Existing
pending edits, canonical entries, and local decisions stay in place.
Removing an entry from the manifest has no effect on stored memory.

Each result identifies the manifest or entry and shows whether it was
eligible, staged, skipped, rejected, or failed. Use `--json` for automation.
A batch that includes a rejected or failed entry exits 1 and retains any
successfully staged candidates.

### Reference-pack evidence

The reference-pack gate is pending. Automated tests use a synthetic pack to
verify review and upgrade behavior. Publish a reference pack after
representative users review the candidate set, retain a majority of proposed
entries, and verify that an upgrade preserves prior local decisions. Record
the number proposed and retained and the observed outcome of the upgrade.

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
