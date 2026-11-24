# Setup and troubleshooting

## Install targets (generic, cursor, claude, claude-code, codex, openclaw, hermes)

`engram install` scaffolds project-local integration files or user-level
lifecycle hooks. Project targets write inside a project directory
(`--root <dir>`, default: the current directory) and never touch the OS
home; user-level targets write under it (`--home <dir>` overrides).

Project targets (ENG-37):

- `engram install generic`: maintains a managed engram section in the
  project's `AGENTS.md` (HTML-comment markers; foreign content preserved).
- `engram install cursor`: scaffolds `.cursor/rules/engram.mdc` as a
  project rule (frontmatter-first, `alwaysApply: true`). User `.mdc` files
  in `.cursor/rules/` stay untouched.
- `engram install claude`: scaffolds the project skill at
  `.claude/skills/engram/` (`SKILL.md`, `references/`, and a `bin/engram` launcher
  invoked as `sh "${CLAUDE_SKILL_DIR}/bin/engram" <args>`). This is the
  project skill scaffold, distinct from `claude-code`, which installs
  user-level hooks. User skills stay untouched.

- `engram install openclaw --root <agent-workspace>`: installs
  `skills/engram-project-memory/SKILL.md`. Run Engram commands in the task's
  Git checkout with `--scope project`. OpenClaw keeps its own personal
  memory and provider settings.
- `engram install hermes --root <profile-directory>`: installs a profile skill
  that guides the user through project-scoped Engram commands in a local shell
  outside Hermes. Keep project data and command output out of the Hermes session.

User-level targets (ENG-58): `engram install claude-code` and
`engram install codex` set up lifecycle hooks so the engram digest is
injected at startup, resume, and after compaction. Hooks fail open: if
engram is unavailable or the project has no memory, sessions continue
normally, and hook output is capped at 8 KiB.

- `engram install <target> --status`: read-only state view.
- `engram install <target> --dry-run`: preview the exact changes; writes nothing.
- `engram install <target>`: install; asks for confirmation (use `--yes` in scripts).
- `engram install <target> --uninstall`: remove only engram-owned content.

Re-running install repairs drift (for example after an engram upgrade
changes the pinned scaffold content). Targets are exactly `generic`,
`cursor`, `claude`, `claude-code`, `codex`, `openclaw`, and `hermes`. `engram hook <host>
<event>` is the hook entry point; valid invocations always exit 0.

### Curated automatic startup context

Claude Code and Codex use a curated bootstrap by default for their digest
hooks. OpenCode uses its selection policy for weak-query fallback. The bootstrap
selects active pinned memories, decisions with
`importance` at least 3, and critical preferences with `importance` at least 4.
Path-specific entries (`appliesTo`) are excluded unless explicitly enabled.
Pinned entries come first, then importance descending; project scope and id break
ties. Selection does not depend on file scan order or age. Ordinary notes and
unrated decisions remain available through manual context/search/show.

The default budget is 4,800 characters (roughly 1,200 tokens, not an exact token
count), including the wrapper, headers and footer. Whole sanitized digest lines
are packed within both the character budget and the 8 KiB hook byte ceiling;
no bodies are injected. Existing per-line sanitization, fail-open behavior and
hook timeouts remain in place. Structured operation diagnostics expose selected
ids/scopes/reasons, exclusion counts, and budget/entry-limit omissions outside
injected text.

Global settings:

| Key                          | Default   | Meaning                                      |
| ---------------------------- | --------- | -------------------------------------------- |
| `autoContext`                | `on`      | Enable automatic context                     |
| `autoContextScope`           | `project` | `project`, `personal`, or `both`             |
| `autoContextLimit`           | `25`      | Entry ceiling, 1–100                         |
| `autoContextSelection`       | `curated` | `curated` or legacy decision/pin grouping    |
| `autoContextMaxChars`        | `4800`    | Entire payload budget, 2048–8192 characters  |
| `autoContextIncludeScoped`   | `off`     | Explicitly allow path-specific entries       |
| `autoContextIncludeInactive` | `off`     | Explicitly allow historical/inactive entries |

Use `engram config set autoContextMaxChars 6000` to change the budget, or
`engram config set autoContextSelection legacy` for the former selection order.
Existing enable/scope/limit values are retained without rewriting configuration
files; missing new settings use the defaults above. Both selection modes obey
the eligibility toggles and output caps. Manual `engram context` and search
pagination are unchanged. Exact token accounting is a separate capability.

## Diagnostics

Use `engram doctor` to diagnose store, configuration, and managed integration
state. Use `engram stats` to summarize local usage without recording memory
content or query text. Both support `--json`. Run
`engram stats --disable --clear` to stop collection and remove the history.

Change the scan policy only when the user intends to change it:

```bash
engram config set secretScan block|warn|off
engram config set personalSecretScan block|warn|off
```

Use `engram install --help`, `engram config --help`, and `engram doctor --help`
for options.
