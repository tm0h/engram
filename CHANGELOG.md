# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **IDs are now globally unique by construction (ULID-style: timestamp +
  randomness) instead of a sequential `0001`-style counter.** Sequential ids
  collided whenever two people (or two sessions, or two clones) recorded
  engrams independently — git merges the files without conflict, leaving a
  store with duplicate ids that `show`/`edit`/`remove` could not address
  reliably, and asking humans to renumber them after every such merge is
  extra work the ID scheme should have prevented. New ids need no
  coordination: any machine, session, or CI run can mint one, merged branches
  can never collide, and lexicographic order equals creation order so listing
  stays chronological. Prefix references still work (`engram show 01jb3`).
  Legacy 4-digit ids remain readable and addressable.
- `engram add` now creates files exclusively (`wx`) and retries with a fresh
  id if the exact filename already exists — it can no longer overwrite an
  existing engram.

### Added

- `engram dedupe`: repairs duplicate ids (legacy or hand-written) by keeping
  the first file per id and renumbering the rest to fresh globally-unique
  ids — safe to run independently on different clones.
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

[0.1.1]: https://github.com/tm0h/engram/releases/tag/v0.1.1
[0.1.0]: https://github.com/tm0h/engram/releases/tag/v0.1.0
[#3]: https://github.com/tm0h/engram/pull/3
