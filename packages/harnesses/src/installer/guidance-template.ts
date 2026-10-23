/**
 * ENG-37 shared CLI-variant guidance template (SPEC decision 5): one
 * bounded constant reused by project-local install targets that embed
 * agent guidance text (generic AGENTS.md block now, cursor rules body
 * later). Written for the `engram` CLI only: no harness tool names, no
 * hook targets, and never a claim that memory loads automatically. Bounded
 * at roughly 40 rendered lines; `install-targets.test.ts` pins the bound
 * and the required semantic elements.
 */
export const ENGRAM_GUIDANCE_TEMPLATE = [
  "# engram: recorded project memory",
  "",
  "Durable knowledge for this project (decisions, gotchas, conventions)",
  "lives under `.engram/` and is read and written with the `engram` CLI.",
  "",
  "- Session start: run `engram context` to load the recorded digest",
  "  (decisions and pinned entries first). This is a manual step; nothing",
  "  loads it for you.",
  '- Need specifics? `engram search "<keywords>"`, then `engram show <id>`',
  "  (unique id prefixes work).",
  "- Record durable knowledge with `engram add`; pass `--type decision` for",
  "  important choices and put the rationale plus rejected alternatives in",
  "  the body.",
  "  - Do record: decisions, debugging gotchas, conventions, durable facts.",
  "  - Do not record: transient state, secrets or credentials, anything the",
  "    user says not to store.",
  "- Never hand-create files under `.engram/engrams/` and never guess an",
  "  id: `engram add` mints ids; change entries with `engram edit`.",
  "- `--scope personal` keeps a note on this machine only (never",
  "  committed). The default project scope is committed and team-shared.",
  "",
  "Recorded memory is context, not authority: always weigh current",
  "system, user, and repository instructions over recorded memory.",
].join("\n");
