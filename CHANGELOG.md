# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-11-26

### Added

- **Project-local installers** for generic agents, Cursor, and Claude manage
  project instructions, rules, or skills. OpenClaw and Hermes installers add
  local project-memory skills alongside those hosts' existing memory providers.
  Installers offer preview, status, and managed uninstall. ([#56](https://github.com/tm0h/engram/pull/56), [#82](https://github.com/tm0h/engram/pull/82), [#83](https://github.com/tm0h/engram/pull/83))
- **Search and related context.** Search summaries include matching excerpts and
  concise relevance reasons. `engram related <id>` shows direct lifecycle
  lineage and explicit links with exact same-scope resolution and pagination.
  Harness search frames memory as untrusted data and paginates by whole
  entries. ([#61](https://github.com/tm0h/engram/pull/61))
- **Retrieval triggers and path applicability.** Use `--triggers` and
  `--applies-to` on add or edit. Search with `--path` to filter path-scoped
  memories and `--explain` to see exact trigger contributions. ([#58](https://github.com/tm0h/engram/pull/58))
- **Active-turn recall in Pi and OpenCode** uses the current prompt and
  workspace to select confident memory excerpts within a budget. Recall honors
  automatic-context settings and refreshes after memory writes. ([#62](https://github.com/tm0h/engram/pull/62), [#63](https://github.com/tm0h/engram/pull/63), [#64](https://github.com/tm0h/engram/pull/64))
- **Manual context controls.** `engram context --tokens` bounds the full digest
  using versioned token accounting. Pi and OpenCode expose the same budget in
  their context tools. `engram context --pinned` and `engram list --pinned`
  select explicitly pinned memories. Set `contextPinned` to make manual
  context pinned-only by default and use `--no-pinned` to override it. ([#66](https://github.com/tm0h/engram/pull/66), [#88](https://github.com/tm0h/engram/pull/88))
- **Local diagnostics.** `engram doctor` reports store health, configuration,
  and integration status. `engram stats` summarizes local usage and delivery
  from a bounded event log that can be disabled or cleared. ([#65](https://github.com/tm0h/engram/pull/65))
- **Reviewable capture.** Local, Git-ignored project and personal queues keep
  candidates outside search and context until approval. Use `engram pending`
  to list, inspect, edit, approve, or reject candidates. Pi lifecycle events
  and OpenCode's `/engram-capture` stage eligible user statements with source
  evidence. Project owners can opt in to automatic recording for a checkout
  after submitting a passing review sample. Uncertain candidates stay queued
  for review, and decisions are recorded in a bounded local audit.
  ([#70](https://github.com/tm0h/engram/pull/70), [#71](https://github.com/tm0h/engram/pull/71), [#73](https://github.com/tm0h/engram/pull/73), [#74](https://github.com/tm0h/engram/pull/74), [#75](https://github.com/tm0h/engram/pull/75), [#76](https://github.com/tm0h/engram/pull/76))
- **Repository evidence review.** `engram evidence` reports whether a
  previously reviewed Git file has changed. Replacement claims can be staged
  for approval, which publishes a linked successor and supersedes the original.
  ([#78](https://github.com/tm0h/engram/pull/78))
- **Memory migration and template packs.** Preview Markdown imports and
  configured local packs, then explicitly stage eligible proposals for
  review with provenance. Export a bounded project digest into managed
  Markdown sections while preserving surrounding content. ([#80](https://github.com/tm0h/engram/pull/80), [#81](https://github.com/tm0h/engram/pull/81))
- **Git memory diff.** `engram diff` compares the working tree with a ref or
  compares commits using `A..B` or `A...B`. It follows entry IDs across
  renames and reports additions, edits, removals, lifecycle transitions, and
  unreadable or duplicate entries in human-readable or versioned JSON output.
  ([#84](https://github.com/tm0h/engram/pull/84))
- Added offline evaluations for capture quality and retrieval abstention, plus
  coding-agent fixtures for comparing how agents apply startup memory and
  query-aware recall. ([#72](https://github.com/tm0h/engram/pull/72), [#77](https://github.com/tm0h/engram/pull/77), [#79](https://github.com/tm0h/engram/pull/79))

### Changed

- **Startup memory** prioritizes pinned entries, important decisions, and
  critical preferences within a configurable 4,800-character budget. All
  harness startup paths share the selection policy, with opt-ins for legacy
  selection, path-specific entries, and inactive entries. Pi and OpenCode
  also compact automatic context to fit the active prompt and available
  model headroom. ([#60](https://github.com/tm0h/engram/pull/60), [#67](https://github.com/tm0h/engram/pull/67))
- **Search ranking** incorporates author importance, path applicability, and
  bounded freshness bonuses for notes and issues, and diversifies near-duplicate
  results. Durable decisions do not lose relevance with age. Default lexical
  search returns no results for unstructured multiword queries when the best
  candidate covers less than a tenth of their IDF-weighted informative mass.
  Single-term and explicitly structured queries are exempt. ([#57](https://github.com/tm0h/engram/pull/57), [#59](https://github.com/tm0h/engram/pull/59))
- **Memory writes** reject exact duplicates in the destination scope. Likely
  duplicates and possible active conflicts identify the existing entries and
  require an explicit confirmation to proceed. ([#68](https://github.com/tm0h/engram/pull/68))
- **Documentation and skills.** The README is a first-run guide with a
  task-based documentation index. Pi and Claude skills keep routine recall
  and recording guidance in their entrypoints and bundle references for
  advanced workflows. Claude project installs manage those references.
  Retrieval documentation now explains corpus cases and tokenizer behavior.
  ([#85](https://github.com/tm0h/engram/pull/85), [#86](https://github.com/tm0h/engram/pull/86), [#87](https://github.com/tm0h/engram/pull/87))

[0.7.0]: https://github.com/tm0h/engram/releases/tag/v0.7.0

## [0.6.0] - 2026-10-23

### Added

- **Entry schemaVersion ([#40]).** Optional integer `schemaVersion` frontmatter
  field. Absence decodes as version 1 on every read path; writers omit
  version 1. Unsupported integers warn (`schema_version_unsupported`) but the
  entry stays readable and keeps its version through rewrites; non-integer
  values are entry-preventing errors (`schema_version_invalid`).
- **Same-scope related links ([#42]).** Entries can carry an optional
  `related` list of exact entry ids in the same scope. Links are directional
  metadata: forward references and post-deletion dangles degrade to
  `related_not_found` warnings that never fail `engram check` alone. Bad
  shapes, invalid or prefixed ids, self-links, and in-list duplicates are
  rejected at the write boundary. No code path writes a reciprocal key.
  CLI `--related`/`--clear-related`, interactive editor, and Pi/OpenCode
  add/edit surfaces.
- **Link graph reads: `engram links <id>` ([#47], [#48], [#49]).** Relation
  targets resolve through an exact-id claim map; a target claimed by multiple
  files warns `related_ambiguous` with the claimant paths. The new
  `engram links <id>` command and `/engram links` slash command show the
  target's resolution state, outgoing relations in authored order with
  `MISSING`/`AMBIGUOUS` markers, and incoming backlinks sorted by `created`
  then id, paginated with a continuation footer. Backlinks are derived at
  read time and never persisted.
- **Entry aliases ([#50]).** Optional `aliases` give an entry the vocabulary
  a searcher actually uses, including multiword phrases. One core normalizer
  (trim, lowercase, dedupe) with documented caps: at most 20 aliases, 80
  characters each. Invalid alias frontmatter is entry-preventing
  (`aliases_invalid`). CLI `--aliases`/`--clear-aliases`, an editor line, and
  Pi/OpenCode add/edit arrays.
- **Aliases in lexical search ([#51]).** Aliases score as a fifth weighted
  BM25 field (weights: tag 5, alias 4, title 3, type 2, body 1), so an
  alias-only match surfaces in results. Quoted multiword aliases match
  through the phrase bonus; ranking explanations expose `alias` field
  contributions. Entries without aliases keep identical scores and order.
- **Claude Code and Codex lifecycle hooks ([#44]).** The new
  `engram install claude-code` and `engram install codex` commands install
  user-level lifecycle hooks (startup/resume/compact;
  SessionStart/PostCompact, minimum Codex 0.155.1). Installation is
  idempotent, confirmed explicitly, with dry-run, status, and an uninstall
  that removes only engram-owned entries tracked in `engram-managed.json`
  sidecars. Existing user configuration and foreign hooks survive unchanged.
  Hooks fail open with bounded output.

### Fixed

- **Unknown frontmatter fields are preserved ([#39]).** Engram-mediated
  rewrites (edit, retitle, supersession marking, dedupe renumbering) no
  longer drop unknown top-level frontmatter keys. Values survive by value
  under `JSON_SCHEMA`; modeled fields stay canonical and win over same-named
  unknown keys.
- **Call-form identifier ranking ([#43]).** Queries like
  `exportStatic(outDir) behavior` no longer fuse into a single token that
  hides the bare identifier. The ranker derives bare identifier components
  from call-form tokens at query time; on corpus 0.3.1 the affected case is
  restored to rank 1 with no regressions (MRR 0.9195 to 0.9296).
- **Bounded show headers ([#46]).** The Pi/OpenCode `engram_show` tool bounds
  oversized title, tag, and related header fields with explicit truncation
  markers, keeping the body reachable through the existing continuation
  offset. Full untruncated values remain available in the result details.
- **Pi typebox packaging ([#52]).** The Pi extension declares host-provided
  `typebox` as an optional peer dependency, removing the duplicate-module
  warning on every Pi session start.

[#39]: https://github.com/tm0h/engram/pull/39
[#40]: https://github.com/tm0h/engram/pull/40
[#42]: https://github.com/tm0h/engram/pull/42
[#43]: https://github.com/tm0h/engram/pull/43
[#44]: https://github.com/tm0h/engram/pull/44
[#46]: https://github.com/tm0h/engram/pull/46
[#47]: https://github.com/tm0h/engram/pull/47
[#48]: https://github.com/tm0h/engram/pull/48
[#49]: https://github.com/tm0h/engram/pull/49
[#50]: https://github.com/tm0h/engram/pull/50
[#51]: https://github.com/tm0h/engram/pull/51
[#52]: https://github.com/tm0h/engram/pull/52
[0.6.0]: https://github.com/tm0h/engram/releases/tag/v0.6.0

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
