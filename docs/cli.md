# CLI command directory

Run `engram --help` for the complete command list and
`engram <command> --help` for the flags available in your installed version.

| Task                                        | Commands                                | Guide                                                   |
| ------------------------------------------- | --------------------------------------- | ------------------------------------------------------- |
| Set up memory and choose a scope            | `init`, `config`, `where`               | [Use Engram memory](using-memory.md)                    |
| Record, inspect, or edit entries            | `add`, `list`, `show`, `edit`, `remove` | [Use Engram memory](using-memory.md)                    |
| Find entries and follow their links         | `search`, `links`, `related`            | [Search memory](search.md)                              |
| Load a digest                               | `context`                               | [Context token budget](context-token-budget.md)         |
| Review memory or capture proposals          | `review`, `pending`, `capture`          | [Review and capture memory](review-and-capture.md)      |
| Compare project memory across Git snapshots | `diff`                                  | [Review project memory changes](project-memory-diff.md) |
| Check the store or inspect local usage      | `check`, `doctor`, `stats`, `dedupe`    | [Diagnostics and write scanning](diagnostics.md)        |
| Set up an agent                             | `inject`, `install`                     | [Connect Engram to an agent](integrations.md)           |
| Migrate or share a digest                   | `import`, `export`                      | [Import and export memory](migration.md)                |

`engram dedupe` replaces duplicate IDs with fresh globally unique IDs.
See [repository-backed memory evidence](repository-evidence.md) for
`engram evidence`.
