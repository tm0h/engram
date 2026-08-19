---
name: engram
description: Record and recall durable memory for this codebase with the engram tools. Use when starting work in a repo (load context), when the user asks to remember/note/record something, when a durable decision, gotcha, or convention is discovered, or when past decisions would inform current work.
---

# Engram memory

This workspace has shared, git-native memory. Engrams are plain Markdown
entries (decisions, facts, gotchas, conventions) recorded per project
(committed, team-wide) or personally (this machine only, `~/.engram`).

## Session flow

1. **At the start of a session or feature**, call `engram_context` to load the
   digest — decisions and pinned entries surface first. Skim it before
   proposing anything consequential.
2. **When you need specifics** (how auth works, why a library was replaced),
   call `engram_search` with keywords, then `engram_show` on the matching id.
3. **When you learn something durable**, record it with `engram_add`.

## When to record (and when not to)

Record:

- Decisions — with rationale and rejected alternatives in the body
  (`type: "decision"`).
- Gotchas that cost debugging time (surprising behavior, undocumented flags).
- Conventions the codebase follows that aren't obvious from one file.
- Durable facts about the environment or architecture.

Do **not** record:

- Transient state, work-in-progress, secrets, or credentials.
- Anything the user asks not to store.
- Things trivially re-derivable from the code itself.

## Scopes

- `project` (default): committed to git under `.engram/`, shared with the
  whole team and cloud sessions. Record team-relevant knowledge here.
- `personal`: global to your machine, never committed. Use only when the user
  explicitly wants a private note.

Keep titles short and specific; put details in the body; add a few
searchable tags.
