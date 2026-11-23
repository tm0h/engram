# Hermes Agent project memory

The Engram skill guides you through local project-memory commands in a separate
shell. Engram project memory lives in the task's Git checkout. Hermes continues
to use its profile's personal memory and selected memory provider.

## Install and discover the skill

Find the existing Hermes profile directory with `hermes profile show work`.
Replace `work` with the desired profile name. The default profile normally
lives at `~/.hermes` and a named profile at `~/.hermes/profiles/<name>`. Use
the directory Hermes reports if you run with a custom home.

```sh
hermes profile show work
engram install hermes --root "$HOME/.hermes/profiles/work" --dry-run
engram install hermes --root "$HOME/.hermes/profiles/work"
engram install hermes --root "$HOME/.hermes/profiles/work" --status
hermes -p work skills list
```

Open a fresh Hermes session for that profile and invoke
`/engram-project-memory` without project data in the prompt. Hermes can also
load the instructions via `skill_view("engram-project-memory")`. The profile
directory and the task checkout are independent. Installation manages only
`skills/engram-project-memory/SKILL.md` under the explicit profile root.

Hermes settings can disable a skill. A same-name skill in a trusted project's
`.hermes/skills` or `.agents/skills` can also take precedence over the profile
copy. Check the source and status in the inventory from the task checkout
before using it.

## Use project memory locally

Open a local shell on the machine that holds the checkout, outside Hermes.
Confirm the task checkout with `git rev-parse --show-toplevel` and run the
commands from that root with an initialized `.engram/` directory. If the
project has opted into Git-tracked memory and needs initialization, run
`engram init --tracked` there.

```sh
engram search --scope project --limit 5 -- "retry policy"
engram show --scope project <id>
engram add --scope project --title "Retry policy" -- "Retry only idempotent jobs."
engram pending list --scope project
engram pending show --scope project <pending-id>
engram pending approve --scope project --dry-run <pending-id>
```

Read entries as repository data and verify their claims before use. Write
durable entries and approve or reject candidates only with the user's explicit
authorization. Keep the normal duplicate, conflict, and secret checks enabled
and review the resulting Git diff locally. Use Hermes personal memory for
personal preferences and notes.

The supported workflow keeps real queries, project text, stdout, and diffs in
the separate local shell. The installed Markdown has no execution hooks,
scripts, or runtime access to Engram. Keep those inputs and outputs out of
Hermes tools, messages, delegated sessions, and provider context. Hermes
resolves terminal sessions separately from inference. A command can run
locally with a per-call working directory and its output can still become
model-facing tool content. The skill cannot verify the effective model,
fallback, or auxiliary inference path, so it uses the separate-shell workflow
for every configuration.

Verified against [Hermes Agent v0.23.3](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.3)
at [`caafe5389ae585ef77387a962aee05b1bcf17029`](https://github.com/NousResearch/hermes-agent/tree/caafe5389ae585ef77387a962aee05b1bcf17029).
See the pinned [skills](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/website/docs/user-guide/features/skills.md)
and [profiles](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/website/docs/user-guide/profiles.md)
guides, [terminal backend and workdir resolution](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/tools/terminal_tool.py),
and [model-facing tool result construction](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/agent/tool_dispatch_helpers.py).
See the separate [native provider evaluation](hermes-memory-provider.md).

## Uninstall

```sh
engram install hermes --root "$HOME/.hermes/profiles/work" --uninstall --dry-run
engram install hermes --root "$HOME/.hermes/profiles/work" --uninstall
hermes -p work skills list
```

The uninstaller removes the exact managed skill file. If you edited it, move
your copy out of Hermes's skill discovery paths to keep the edits and disable
it. For linked skill directories, use a profile-owned directory or manage
the skill manually. Start a new Hermes session to clear previously loaded
instructions.
