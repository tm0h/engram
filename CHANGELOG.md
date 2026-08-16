# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
