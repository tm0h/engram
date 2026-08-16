# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [0.3.0] - 2026-08-17

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
[#6]: https://github.com/tm0h/engram/pull/6
[#10]: https://github.com/tm0h/engram/pull/10
