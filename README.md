# engram

[![npm](https://img.shields.io/npm/v/engram-cli?label=engram-cli)](https://www.npmjs.com/package/engram-cli)
[![Node](https://img.shields.io/node/v/engram-cli)](https://www.npmjs.com/package/engram-cli)
[![CI](https://github.com/tm0h/engram/actions/workflows/ci.yml/badge.svg)](https://github.com/tm0h/engram/actions/workflows/ci.yml)

Engram gives AI agents durable memory across sessions. Save decisions,
preferences, and lessons as plain Markdown with YAML frontmatter so you and
your agents can read them with or without the CLI.

Project memory lives in `.engram/` and can be shared through Git. Personal
memory lives in `~/.engram/` and stays local. Check recalled memory against
current evidence before acting on it.

## Install

Requires Node.js 20 or newer. The npm package installs the `engram` command.

```sh
npm install -g engram-cli
```

## Quick start

From a Git checkout, use `--tracked` if you plan to share project memory.
Use `--untracked` to keep project memory out of Git.

```sh
engram init --tracked
engram add --title "Use pnpm for this project" --type preference --tags tooling \
  "CI expects pnpm-lock.yaml."
engram search "tag:tooling"
```

Use the ID from the result with `engram show <id>` to read the full entry.
To share tracked memory, review the files under `.engram/` and commit them.

## Agent / harness integration

Run `engram inject` and paste the output into your agent's instructions.
For managed setup and host-specific features, see the
[harness guides](https://github.com/tm0h/engram/blob/main/docs/integrations.md).

## Documentation

Start with the [documentation index](https://github.com/tm0h/engram/blob/main/docs/index.md)
for guides and reference. Run `engram --help` or `engram <command> --help`
for the commands and flags available in your installed version.

[Report an issue](https://github.com/tm0h/engram/issues) ·
[Contribute](https://github.com/tm0h/engram/blob/main/AGENTS.md) ·
[Release history](https://github.com/tm0h/engram/blob/main/CHANGELOG.md) ·
[MIT license](https://github.com/tm0h/engram/blob/main/LICENSE)
