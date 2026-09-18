# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-18

### Added

- **Store integrity diagnostics.** New `engram check` human and JSON reports
  identify malformed entries, duplicate ids, invalid configuration, and other
  store defects with stable diagnostic codes and actionable hints. Normal
  reads now emit a bounded warning when unreadable entries were omitted instead
  of silently hiding them. ([#19])
- **Lifecycle and provenance metadata.** Entries can record `status`,
  `supersedes`, `reviewAfter`, `expires`, `sourceType`, and `sourceRef`.
  Existing entries remain valid without migration. CLI and harness edit paths
  support explicit clearing without serializing null values. ([#20])
- **Agent-facing edits.** Pi and OpenCode now expose `engram_edit`, and Pi adds
  `/engram edit`. Both preserve omitted fields, clear explicitly nullable
  fields, validate before mutation, and refresh cached context after successful
  writes. ([#21])
- **Supersession, expiry, and review workflows.** Establishing a `supersedes`
  link marks the predecessor superseded as one logical operation and rejects
  invalid or cyclic lineage before writing. Search, list, context, and startup
  injection exclude inactive entries by default; `--all` includes them when
  needed. New `engram review` human and JSON reports identify superseded,
  archived, expired, review-due, and broken-lineage entries. ([#22])
- **Versioned retrieval corpus and regression benchmark.** The repository now
  contains 187 labeled retrieval cases, deterministic benchmark tooling, and a
  checked-in regression gate. Search tokenization now applies consistent
  Unicode normalization and handles code identifiers. ([#24])
- **Secret and prompt-injection scanning on every write (ENG-15).** `engram
add`, `engram edit`, and the Pi/OpenCode `engram_add`/`engram_edit` tools
  scan the complete serialized entry for credentials, high-entropy tokens,
  private-key markers, invisible Unicode, prompt-injection instructions, and
  credential-exfiltration instructions. Findings are deterministic and
  redacted (rule id, line, column; never the matched text). Project writes
  block by default, personal writes warn; new config keys `secretScan`
  (project, default `block`) and `personalSecretScan` (global, default
  `warn`) tune this, and `--allow-secrets` / `allowSecrets` override a block
  for a single write (the bypass is reported). Blocked writes leave storage
  byte-identical; bare hashes, UUIDs, and ULID-style ids are never flagged.
  `engram check` also scans every readable raw Markdown file, including
  malformed frontmatter, emitting `secret_detected` diagnostics (block:
  error, warn: warning, off: none) and failing closed when a scope's config
  cannot be loaded. ([#28])
- Search JSON output and ranking explanations, with scope-qualified results,
  pagination metadata, and equivalent structured metadata in Pi and OpenCode.
  ([#25])
- **Host-neutral installer framework.** Integration authors can build
  previewable, idempotent installers and uninstallers that preserve surrounding
  user content, reject duplicate asset paths, use atomic replacement, and
  recover safely from interrupted staging. Host-specific installers are not
  included in this release. ([#26])
- **BM25-style lexical ranker (ENG-18).** `searchEngrams` now scores the
  tag, title, type, and body fields with per-field Okapi BM25 (weights
  5/3/2/1, k1 = 1.2, b = 0.75, Lucene-variant idf) plus a pinned boost,
  replacing the fixed-points scorer, which remains callable as
  `searchEngramsLegacy` for same-corpus benchmark comparison. New query
  syntax: `"exact phrase"` (contiguous occurrence bonus), `stem*` bounded
  prefix matching (folded stem of at least 2 characters; word tokens of at
  least 3 characters also prefix-fall back so variants like
  keybinding/keybindings keep matching), `tag:`/`title:`/`type:`/`body:`
  field filters, and explicit `AND` groups (`OR`/whitespace stay the
  OR-compatible default). Explanations gain a `component` discriminator
  (`bm25`, `phrase`, `prefix`, `pinned`); scores are now fractional.
  On the golden retrieval corpus the wired ranker passes 184/187 cases
  (legacy: 183) with no forbidden hits and fewer stale hits; latency over a
  1,000-entry corpus is at parity (p95 25.4 ms vs 28.4 ms for the legacy
  ranker in the same harness). New `benchmark:shadow` command reports the
  legacy-vs-wired delta and latency percentiles. ([#27])

### Changed

- Releases now use protected version tags, fail-closed validation, npm trusted
  publishing through OIDC, and GitHub releases created only after npm
  publication succeeds. A dispatch-only workflow prepares version and
  changelog pull requests without publishing. ([#18])
- The README now documents the current quick start, five native agent tools,
  BM25 query syntax, structured search output, write safeguards, command
  reference, retrieval corpus, and release process. ([#30])

### Fixed

- Piping CLI output to an early-closing consumer now exits with conventional
  SIGPIPE status 141 without an `EPIPE` stack trace. Completed mutations remain
  persisted. ([#23])
- Retitles and duplicate-id repairs now compensate for partial filesystem
  failures. Failed removals restore original entries, failed successor writes
  remove partial files, and incomplete cleanup reports both the primary and
  compensation failures. ([#31], [#35], [#36])
- Supersedes validation now identifies the node that actually closes a
  pre-existing cycle and renders the true cycle segment. ([#32])

[#18]: https://github.com/tm0h/engram/pull/18
[#19]: https://github.com/tm0h/engram/pull/19
[#20]: https://github.com/tm0h/engram/pull/20
[#21]: https://github.com/tm0h/engram/pull/21
[#22]: https://github.com/tm0h/engram/pull/22
[#23]: https://github.com/tm0h/engram/pull/23
[#24]: https://github.com/tm0h/engram/pull/24
[#25]: https://github.com/tm0h/engram/pull/25
[#26]: https://github.com/tm0h/engram/pull/26
[#27]: https://github.com/tm0h/engram/pull/27
[#28]: https://github.com/tm0h/engram/pull/28
[#30]: https://github.com/tm0h/engram/pull/30
[#31]: https://github.com/tm0h/engram/pull/31
[#32]: https://github.com/tm0h/engram/pull/32
[#35]: https://github.com/tm0h/engram/pull/35
[#36]: https://github.com/tm0h/engram/pull/36
[0.5.0]: https://github.com/tm0h/engram/releases/tag/v0.5.0

## [0.4.0] - 2026-08-28

### Added

- **OpenCode plugin, bundled in the `engram-cli` tarball.** Adding
  `engram-cli` to OpenCode's plugin configuration gives agents native
  `engram_context`, `engram_search`, `engram_show`, and `engram_add` tools.
  The plugin is shipped through the package's `./server` export and resolves
  each tool call from the active session directory. ([#16])
- **Automatic session context for Pi and OpenCode.** Sessions now start with
  a compact digest of the workspace's recorded memory injected into the
  system prompt before the first model request — no model turn spent on
  loading, and no reliance on the agent remembering to call a tool. Pi
  delivers it through its `session_start`/`before_agent_start` lifecycle
  (reloaded on startup, new, resume, fork, and reload; cached digest
  invalidated after a successful `engram_add`); OpenCode delivers it through
  the experimental `experimental.chat.system.transform` hook (best-effort,
  per-session lazy cache, same add-invalidation). The digest is bounded
  (≤ 25 entries, ≤ 8 kB, metadata only — never bodies), fail-open (disabled,
  empty, or unreadable stores never block a session), and driven by new
  user-level config keys: `autoContext` (on/off, default on),
  `autoContextScope` (project/personal/both, default project), and
  `autoContextLimit` (1..100, default 25), managed via `engram config`.
  ([#17])

### Changed

- **Pi/OpenCode tool guidance no longer instructs agents to call
  `engram_context` at every session start** (which would have duplicated the
  automatic load). The tool is now positioned for refresh, pagination,
  recovery, and pre-work context; skills and READMEs updated to match, with
  the manual startup flow kept for Claude Code and other harnesses until
  they gain native loading. ([#17])

[#17]: https://github.com/tm0h/engram/pull/17
[#16]: https://github.com/tm0h/engram/pull/16
[0.4.0]: https://github.com/tm0h/engram/releases/tag/v0.4.0

## [0.3.0] - 2026-08-19

### Added

- **Pi coding-agent extension, bundled in the `engram-cli` tarball.**
  `pi install npm:engram-cli` now gives agents first-class engram tools —
  `engram_context` (paginated digest, decisions & pinned first),
  `engram_search`, `engram_show` (char-sliced bodies), and `engram_add` —
  plus a `/engram` slash command (context / search / show / add / init /
  help) and an `engram` skill. Tools run in-process over `@engram/core`
  (no CLI on PATH needed); results are plain text with next-call footers
  and an ~8 kB backstop. New private `@engram/harnesses` workspace package
  holds a shared operations layer (substrate for future MCP/JSON surfaces)
  plus the Pi adapters. ([#10])
- **Claude Code plugin.** The repo itself is now a plugin marketplace:
  `/plugin marketplace add tm0h/engram`, then `/plugin install engram@engram`
  brings the `engram` skill and a `bin/engram` launcher (uses an installed
  `engram` CLI or falls back to `npx`). ([#10])

## [0.2.0] - 2026-08-17

### Changed

- **IDs are now globally-unique in practice (ULID-style: timestamp +
  randomness) instead of a sequential `0001`-style counter.** Sequential ids
  collided whenever two people (or two sessions, or two clones) recorded
  engrams independently — git merges the files without conflict, leaving a
  store with duplicate ids that `show`/`edit`/`remove` could not address
  reliably, and asking humans to renumber them after every such merge is
  extra work the ID scheme should have prevented. New ids need no
  coordination: any machine, session, or CI run can mint one, the 80-bit
  random suffix makes accidental id collisions across merged branches
  negligible, and lexicographic order follows creation order (millisecond
  precision) so listing stays chronological. Prefix references still work
  (`engram show 01jb3`). Legacy 4-digit ids remain readable and
  addressable. ([#12])
- `engram add` now creates files exclusively (`wx`) and retries with a fresh
  id if the exact filename already exists — it can no longer overwrite an
  existing engram.

### Added

- `engram dedupe`: repairs duplicate ids (legacy or hand-written) by keeping
  the first file per id and renumbering the rest to fresh globally-unique
  ids. Deterministic winner rule (earliest `created`, then filename), so every
  clone computes the same repair. Note: merge one clone's repair before
  another clone repairs the same duplicate — two independent repairs mint
  different replacement ids and the merge would keep both copies.
- `engram show`/`edit`/`remove` now fail with a clear `DuplicateIdError`
  listing the offending files instead of silently picking one.
- `engram context` surfaces a duplicate-id warning at the top of the digest
  so agents detect the problem at session start.

## [0.1.1] - 2026-08-16

### Fixed

- Project-root discovery no longer escapes a git repo. Previously, in a git repo
  located under `$HOME` with the global `~/.engram` present, `engram init
--tracked` reported `Already initialized: ~/.engram` and refused to set up the
  repo, while `add`/`list`/`search` silently used the personal store for
  project-scope engrams. Discovery now stops at the nearest `.git` boundary and
  never treats the global `~/.engram` as a project root. ([#3])

## [0.1.0] - 2026-08-15

Initial public release.

### Added

- `engram` CLI: `init`, `add`, `list`, `show`, `edit`, `remove`, `search`,
  `context`, `config`, `inject`, `where`.
- Two scopes: `project` (`.engram/` inside the repo, committed and shared with
  the team and cloud sessions) and `personal` (`~/.engram/`, never committed).
- Engrams are plain Markdown files with self-describing YAML frontmatter
  (id, title, type, tags, scope, created, updated, author, pinned).
- Git tracking toggle: `init --tracked`/`--no-tracked` and
  `engram config set tracked on|off`, with automatic `.gitignore` management.
- Agent/harness integration snippet via `engram inject`.
- Effect-based core engine (`@engram/core`, bundled into the CLI).

[0.3.0]: https://github.com/tm0h/engram/releases/tag/v0.3.0
[0.2.0]: https://github.com/tm0h/engram/releases/tag/v0.2.0
[0.1.1]: https://github.com/tm0h/engram/releases/tag/v0.1.1
[0.1.0]: https://github.com/tm0h/engram/releases/tag/v0.1.0
[#12]: https://github.com/tm0h/engram/pull/12
[#3]: https://github.com/tm0h/engram/pull/3
[#10]: https://github.com/tm0h/engram/pull/10
