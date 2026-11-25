# Diagnostics and write scanning

Use `engram check` to validate memory files and their configuration. See the
[memory file format](memory-format.md#lifecycle-fields) for lifecycle and
relation diagnostics.

## Local diagnostics and statistics

Run `engram doctor` to see both project and personal stores. It distinguishes
missing or unreadable stores, initialized empty stores, and stores with
integrity errors. Advisory lifecycle warnings include affected files and repair
hints. Configuration and automatic context have their own states, so disabled
automatic context can appear alongside healthy stores. The report checks the
five targets managed by `engram install` and the local Codex hooks setting.
Integration states describe local files, and runtime reachability is unknown.
Pi and OpenCode plugin registration is outside the installer scan. BM25
builds its field statistics in memory on demand. Doctor is read-only
and exits successfully after reporting, including when it finds problems. Use
`engram check` when integrity errors should fail the command.

`engram stats` summarizes recent use of the CLI and harnesses. Both commands
support `--json` for one versioned report on stdout.

| Metric                        | How it is counted                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loads                         | Each completed CLI context request, tool digest, and automatic delivery attempt. An OpenCode fallback counts once with its final fitted output. Cached OpenCode retrieval is fitted and counted for each transform. Pi provider retries reuse the fitted block.                                                      |
| Searches and zero-result rate | Each completed explicit CLI or tool search, including pagination calls. Zero-result rate divides searches with zero matches by all recorded searches. The total match count determines zero-result status even on an empty page. Focused context requests and automatic recall count as loads.                       |
| Show after search             | Percentage of searches with matches followed by a successful show within five minutes on the same surface (CLI or tool). A show is paired once with the most recent search, and a zero-result search breaks the chain. The association uses only timestamps and operation categories across workspaces and sessions. |
| Context bytes                 | UTF-8 payload size before the CLI transport newline. A warning-only payload contributes bytes, while a plain empty placeholder contributes zero. The average uses only loads with a payload.                                                                                                                         |
| Latency                       | Average and maximum wall-clock milliseconds for recorded searches and load attempts. Timing covers retrieval and rendering where applicable and excludes statistics storage.                                                                                                                                         |
| Candidate decisions           | Automatic recall counts ranked matches, weak matches, bootstrap duplicates, selected entries, and entries skipped by the result limit or payload budget. Startup digests count selections, applicable policy exclusions, and entries skipped by limit or budget.                                                     |

Statistics stay in `~/.engram/stats/events.json`, separate from project memory.
The file retains the newest 1,000 events in recording order, without a time
expiry. Records contain only a local timestamp, operation category, counts, sizes,
durations, and outcomes. All collection and reporting happen on the machine.

Use `engram stats --disable` to stop collecting for the local account and
`engram stats --enable` to resume. Set `ENGRAM_STATS=off` in a CLI or host
environment to opt out for those processes regardless of the saved setting.
`engram stats --clear` removes recorded events and preserves the collection
setting. Use `engram stats --disable --clear` to stop collection and remove
history together. Recording has a short deadline so automatic context can
proceed if the statistics directory is slow or the write lock stays busy.
Collection also skips writes to an invalid or inaccessible statistics file.
Use `--clear` to reset an invalid file. If a terminated writer leaves a stale lock and `--clear` reports
that statistics are locked, stop active Engram CLI and harness processes,
remove `~/.engram/stats/.lock`, then retry.

## Secret and prompt-injection scanning

Every write through `engram add` and `engram edit` (and the Pi/OpenCode
`engram_add`/`engram_edit` tools) scans the complete serialized entry for
credentials, high-entropy tokens, private-key markers, invisible Unicode,
prompt-injection instructions, and credential-exfiltration instructions.
Findings are deterministic and redacted: diagnostics name a rule id, line,
and column, and never contain the matched text.

Policy is per scope, defaulting to `block` for project writes and `warn` for
personal writes:

```sh
engram config set secretScan block|warn|off            # project writes
engram config set personalSecretScan block|warn|off    # personal writes
```

`block` rejects the write before any file changes, so a blocked write leaves
storage byte-identical. `warn` writes and prints the findings. `off` disables
scanning. `--allow-secrets` (CLI) / `allowSecrets` (tools) overrides a block
for that one write; the bypass is reported in the output. Bare hashes, UUIDs,
and ULID-style ids are never flagged. Internal lifecycle marking (superseding
a predecessor) bypasses scanning because it introduces no user content;
`engram dedupe` rewrites existing content unchanged and is likewise
unguarded.

`engram check` also scans every readable raw Markdown file in the store,
including files with malformed frontmatter, reporting `secret_detected`
diagnostics: errors under `block`, warnings under `warn`, nothing under
`off`. If a scope's config cannot be loaded, that scope's scan is skipped and
reported uncheckable (fail closed).
