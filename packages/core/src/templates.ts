/**
 * Static content templates: the project README that ships inside .engram/,
 * and the agent-injection snippet printed by `engram inject`.
 */

export function projectReadmeContent(tracked: boolean): string {
  return `# Project Engram

This directory holds **shared agent memory** for this project, managed by the
\`engram\` CLI ([engram](https://www.npmjs.com/package/engram)).

## Why this exists
Agents — local coding assistants (Pi, Claude Code, Cursor), code-review bots,
and CI — read these notes so the whole team shares the same context:
architectural decisions, gotchas, replaced packages, conventions, and "why did
we do X?" Because these are plain Markdown files committed to git, **every
teammate and every cloud session sees them automatically.**

Even without the \`engram\` CLI installed, any agent can read the files in
\`engrams/\` directly — that is by design.

## How agents use it
At the start of a session an agent runs:

    engram context

…to get a digest, and searches when it needs specifics:

    engram search "auth"

When an agent learns something durable, it records it:

    engram add --title "..." --type decision "the rationale..."

## File format
Each file in \`engrams/\` is Markdown with YAML frontmatter:

\`\`\`markdown
---
id: "0001"
title: Replaced libfoo with libbar
type: decision        # decision | fact | preference | note | issue | context
tags: [deps, auth]
scope: project
created: 2025-01-15T10:30:00.000Z
updated: 2025-01-15T10:30:00.000Z
author: ""
pinned: true          # optional
---
<markdown body>
\`\`\`

## Tracking
${
  tracked
    ? "This project's memory is **tracked in git** — it is shared with the whole team and with cloud sessions. Commit changes to `.engram/` like any other code."
    : "This project's memory is **gitignored** — it stays local to you. Toggle with `engram config set tracked on` to share it with the team."
}

Edit by hand if you like — they are just files — but prefer the CLI so ids and
frontmatter stay consistent.
`;
}

/** Snippet of instructions agents/harnesses should put in their system prompt. */
export function injectSnippet(): string {
  return `# Engram tool

You have access to a shared memory tool via the \`engram\` CLI.

- At the start of a session, run \`engram context\` to load the team's recorded context (decisions, gotchas, conventions).
- When you need specifics, run \`engram search "<topic>"\`.
- When you learn a durable fact, decision, or gotcha worth remembering for the team, record it with \`engram add\` (use \`--type decision\` for important choices and their rationale).
- Personal notes that should NOT be shared with the team use \`--scope personal\` (stored globally on your machine, never committed).

Engrams live as plain Markdown in \`.engram/\` and (for this project) are committed to git, so the whole team and every cloud session share them.`;
}
