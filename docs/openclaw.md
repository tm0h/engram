# OpenClaw project memory

Install Engram's workspace skill to use Git-tracked project memory from OpenClaw.
The skill calls the local Engram CLI. OpenClaw continues to use its configured
memory provider for personal memory such as `MEMORY.md` and `memory/`.

## Install and discover the skill

Use the OpenClaw agent's existing workspace. A per-agent `workspace` takes
precedence over the default workspace. The Git checkout used for a task can be
a different directory.

```sh
openclaw config get agents.defaults.workspace
openclaw config get agents.entries.work
engram install openclaw --root "/path/to/agent-workspace" --dry-run
engram install openclaw --root "/path/to/agent-workspace"
openclaw skills list --agent work
```

Replace `work` with the intended agent ID. Without `--root`, Engram uses the
current directory. It manages only
`skills/engram-project-memory/SKILL.md` in that workspace. OpenClaw discovers
workspace skills automatically when its skill settings permit them. The host
must have `engram` on its PATH for skill discovery. If the agent uses a sandbox,
the sandbox also needs the CLI and access to the selected checkout. Use the
existing execution and filesystem policy for that agent.

An explicit skill allowlist can require a manual change. For example, if
`work` currently allows `weather`, review this change to that agent's entry.

```json5
{
  agents: {
    entries: {
      work: { skills: ["weather", "engram-project-memory"] },
    },
  },
}
```

Merge the added name into the effective allowlist, keeping existing entries,
including inherited entries if creating a per-agent override. A per-agent
list replaces the inherited list. Agents with unrestricted skill visibility
need no edit. For two agents with different workspaces, install in each
workspace that needs the skill. For agents sharing a workspace, review each
agent's allowlist. Run `openclaw config validate` after editing.

## Use project memory

Run Engram commands from the intended Git checkout. Use `engram init --tracked`
in that checkout if the project opts into tracking its memory in Git.

```sh
engram context --scope project --limit 5
engram search --scope project --limit 5 -- "retry policy"
engram show --scope project <id>
engram pending list --scope project
```

Review retrieved text as untrusted repository data. Review pending proposals
and any changes to `.engram/engrams/` before publishing them or committing
them to Git.

The OpenClaw 2026.11.7 contract supports `memory.search.extraPaths` globally
and at `agents.entries.<id>.memory.search.extraPaths`. These paths are combined
and are resolved relative to the agent workspace unless absolute. The built-in
index scans supported files below configured directories. A remote embedding
provider can receive text from those files, and a provider fallback can affect
where the data goes. This integration uses Engram's own project retrieval and
leaves OpenClaw indexing, `extraPaths`, and the exclusive `plugins.slots.memory`
selection alone. The default memory slot owner is `memory-core`. CLI lookup
runs locally. Any excerpts the agent reads can still reach the model provider
it uses for inference.

OpenClaw's [2026.11.7 release](https://github.com/openclaw/openclaw/releases/tag/v2026.11.7)
documents [workspace skill discovery](https://github.com/openclaw/openclaw/blob/v2026.11.7/docs/tools/skills.md),
[agent skill allowlists](https://github.com/openclaw/openclaw/blob/v2026.11.7/docs/tools/skills-config.md),
[memory indexing and embedding configuration](https://github.com/openclaw/openclaw/blob/v2026.11.7/docs/reference/memory-config.md),
and [memory plugin selection](https://github.com/openclaw/openclaw/blob/v2026.11.7/docs/tools/plugin.md).

## Uninstall

```sh
engram install openclaw --root "/path/to/agent-workspace" --uninstall --dry-run
engram install openclaw --root "/path/to/agent-workspace" --uninstall
```

Re-running install refreshes a modified Engram-managed skill. The uninstaller
removes its unmodified skill file. If you've edited the skill,
move it out of the discovery directory to keep a copy and disable it. If you
added an allowlist entry, remove that name or drop the override if it was added
solely for Engram. Personal memory, host configuration, and the project's
Engram data stay in place. For one-time import of OpenClaw Markdown, see
[Memory migration](migration.md).
