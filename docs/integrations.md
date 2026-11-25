# Connect Engram to an agent

This works with **any** harness because the interface is the CLI plus plain files.

## Give your agent the instructions

Run `engram inject` and paste the output into your agent's system prompt (or a
project rule / `.cursorrules` / `AGENTS.md`). The snippet tells the agent to:

- run `engram context` at session start to load recorded context,
- run `engram search "<topic>"` when it needs specifics,
- record durable findings with `engram add` (`--type decision` for important
  choices and their rationale),
- use `--scope personal` for notes that must not be shared with the team.

Pi and OpenCode automatically recall relevant memory for the current
request. OpenCode can use the curated digest as a fallback. Agents can use the
manual flow when automatic context is unavailable or they need more detail.

## Harness-specific setup

- **Pi**: `pi install npm:engram-cli`. Ships native tools, an `/engram`
  command, a skill, and automatic contextual recall. See
  [Pi extension guide](../packages/harnesses/src/pi/README.md).
- **OpenCode**: add `"plugin": ["engram-cli"]` to `opencode.json`. Ships five
  native tools with typed, validated parameters plus experimental contextual
  recall. See [OpenCode plugin guide](../packages/harnesses/src/opencode/README.md).
- **Claude Code**: `/plugin marketplace add tm0h/engram`, then
  `/plugin install engram@engram` (brings the skill and an `engram`
  launcher). Or simply drop the snippet above into `CLAUDE.md`. Without the
  plugin, `engram install claude` scaffolds the project skill at
  `.claude/skills/engram/` (project skill scaffold; distinct from
  `engram install claude-code`, which sets up user-level hooks).
- **Codex**: `engram install codex` sets up user-level hooks for
  [automatic startup context](startup-context.md).
- **Cursor**: `engram install cursor` scaffolds `.cursor/rules/engram.mdc`
  as an always-applied project rule (`.cursor/rules` is picked up by
  Cursor; user `.mdc` files stay untouched).
- **OpenClaw**: `engram install openclaw --root <agent-workspace>` installs
  a workspace skill for Git-tracked project memory and preserves OpenClaw
  personal memory. See [OpenClaw setup](openclaw.md).
- **Hermes Agent**: `engram install hermes --root <profile-directory>` installs
  a skill for using project memory in a separate local shell. See
  [Hermes setup](hermes.md).
- **Generic (AGENTS.md)**: `engram install generic` maintains a managed
  engram section in the project's `AGENTS.md`; foreign content is
  preserved and `--uninstall` removes only the managed block.
- **Any other harness or bot**: if it can't run a CLI, it can still **read
  files**. Point it at `.engram/engrams/*.md` (or `.engram/README.md`),
  which is self-describing.

Use `engram install <target> --dry-run` to preview a managed install,
`--status` to inspect it, and `--uninstall` to remove its managed content.
See [automatic startup context](startup-context.md) for digest settings.
