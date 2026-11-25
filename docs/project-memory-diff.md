# Review project memory changes

| Command             | Comparison                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engram diff`       | `HEAD` to the files currently on disk, including staged files as they exist on disk, unstaged changes, and untracked or ignored memory files. Index-only content is outside the comparison. |
| `engram diff main`  | The given branch, tag, or commit to the same working tree.                                                                                                                                  |
| `engram diff A..B`  | The snapshot at `A` to the snapshot at `B`.                                                                                                                                                 |
| `engram diff A...B` | The unique merge base of `A` and `B` to the snapshot at `B`.                                                                                                                                |

Run inside a Git working tree. The current directory selects the nearest
initialized project within the repository, with the repository root as the
fallback. Both endpoints use that same repository-relative store path.
The comparison reads direct Markdown entries in `.engram/engrams/`. Personal
memory and pending candidates are outside its scope. An absent store directory
is an empty snapshot, including at commits before project initialization.
Unreadable directories and nonregular entries such as symlinks produce
diagnostics. Each Markdown entry may be up to 1 MiB.

Changes follow frontmatter IDs across renames. Edits include parsed
non-lifecycle metadata and the trimmed Markdown body, with line endings
normalized. YAML layout and key ordering alone produce no change. The report
shows stored `status`, `supersedes`, `reviewAfter`, and `expires` transitions,
including values introduced by additions or cleared by removals. Unset values
are `null`. Dates are compared as stored, without using the current time to
infer expiry or review status.

Duplicate claims and unreadable files leave affected IDs indeterminate. If
a file has no readable ID, it can obscure any unmatched ID on the other side.
Readable, unambiguous changes still appear. Diff reports entry-validation
codes. Use `engram check` for filename, configuration, policy, and broader
store integrity checks.

Use `--json` for one schema-versioned report on stdout. Schema version 1
includes `mode`, `project`, resolved `from` and `to` endpoints, `complete`,
`limit`, `totals`, `omitted`, `changes`, and `diagnostics`. Commit endpoints
carry full SHAs, and the working-tree endpoint has `kind: "working-tree"`.
Change rows are sorted by ID, with one `added`, `removed`, or `modified` row
per changed ID. The `edited`, `renamed`, `statusChanged`, and
`supersessionChanged` totals can overlap. `lifecycleChanged` counts rows with
any stored lifecycle transition. `indeterminate` counts known IDs for which
the command could not establish a change or confirm equality. Diagnostics
are ordered by endpoint (`from` first), path, and code. Detail includes
relative paths and diagnostic codes. Paths are bounded and may be unavailable
or redacted. Bodies, titles, and raw parser messages stay out of the report.

`--limit <count>` accepts 0–100 and caps change and diagnostic detail
independently. Both default to 100. Totals include all determined changes and
diagnostics, and `omitted` counts rows left out of the detail.

| Exit | Meaning                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Complete comparison, including an empty diff or warning-only diagnostics.                                                                                                                                                 |
| `1`  | Invalid invocation, unavailable working tree, or unresolved revision. Supply both endpoints of a range. Ambiguous refs, an unborn `HEAD`, and missing or multiple merge bases require an explicit, resolvable comparison. |
| `2`  | Incomplete comparison. The report includes determined changes and diagnostics.                                                                                                                                            |
