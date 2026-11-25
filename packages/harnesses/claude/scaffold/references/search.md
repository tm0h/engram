# Search and recall

Use `engram search "auth" --json --explain` for structured scores, matched
fields, normalized query tokens, and score contributions. Explanations contain
no memory bodies, source references, or filesystem paths. Use `engram show`
to read the selected memory. Identify entries by scope and id.
JSON pagination uses `--limit` and `--offset`; `nextOffset: null` marks the end.

### Precise search

Search supports quoted phrases, bounded prefixes, field filters, and explicit
Boolean groups:

```bash
engram search '"release checklist"'
engram search 'kuber*'
engram search 'tag:auth AND body:rotation'
engram search 'title:deploy OR type:decision'
```

Whitespace behaves like `OR`. Uppercase `AND` binds more tightly than `OR`.
The field filters are `tag:`, `title:`, `type:`, and `body:`. Search, list,
and context exclude inactive entries by default. Pass `--all` only when you
need superseded, archived, or expired entries.

### Link graph

`engram links <id>` shows the link graph around one entry: outgoing
`related` targets in authored order, then incoming backlinks in creation order
(ties break by id). Flags: `--scope project|personal`, `--offset n`,
`--limit n` (max 100). Ids are exact and same-scope only; a strict prefix
never resolves, and a wrong-scope id reads as missing instead of falling
back. Missing targets carry a literal `MISSING` marker; duplicate-id targets
carry `AMBIGUOUS` with a bounded claimant list. Both are successful reads.
Output is size-capped and paginated. Follow the footer with
`engram links <id> --offset n`.

### Retrieval triggers and path applicability

`engram add --triggers "fix login,auth troubleshooting" --applies-to "packages/api/**"`
records exact whole-query trigger phrases and repository-relative path patterns.
Triggers use the alias normalization and limits (20 unique phrases, 80 code points),
but match the entire query and add a fixed +4 contribution labeled `trigger` in
`search --explain`. They do not bypass explicit field filters or AND queries.
Aliases remain the general BM25 vocabulary field.

`engram search "fix login" --path packages/api/auth.ts --explain` filters out
memories whose nonempty `appliesTo` patterns do not match. Unscoped memories stay
eligible. Without `--path`, applicability does not filter. Paths are case-sensitive
and repository-relative with forward slashes; absolute paths and `..` are rejected.
Patterns support `*` within a segment and `**` across segments; no other glob syntax.
At most 20 patterns, 256 characters each. `engram edit <id> --triggers ""` or
`--applies-to ""` clears that field; omitting the flags preserves it. Fields also
round-trip through Markdown. These flags belong to the CLI; use the CLI to manage
them from harnesses.

### Ranking

BM25 field weights are tag 5, alias 4, title 3, type 2, body 1, with
a pinned +0.5 boost. Multi-word aliases can match through the phrase bonus.

Inactive entries are excluded by default. Once a result matches, pinning,
importance, path applicability and freshness for notes or issues can affect
its rank. Diversification places the strongest result from a group of
near-duplicates first and keeps the rest available on later pages.

Use `engram add --importance 5` or `engram edit <id> --importance 3` to set
importance from 0 to 5. Use `engram edit <id> --importance ""` to clear it.

### Budgeted manual context

Use `engram context --tokens 4000` for a bounded manual digest. The minimum is 512.
Engram uses conservative, versioned accounting for the digest text, including
headers and truncation notices. Use `engram show <id>` to read
a complete entry when the digest truncates it.

### Pinned entries

Use `engram context --pinned --full --tokens 4000` when the agent needs a
bounded digest of pinned memory bodies, or `engram list --pinned` to find IDs
for `engram show <id>`. Both accept `--scope all` and `--all` for inactive
pins. Explicit flags keep the intent clear across machines. Use
`engram context --no-pinned` to include unpinned entries when a user has
enabled the manual CLI default with `engram config set contextPinned on`.

### Matching snippets and related context

Search summaries include a deterministic body snippet of at most 240 characters,
centered on the earliest lexical match (contiguous phrases take priority), plus
matched-field relevance reasons. Title/tag/alias/trigger-only hits have a null
snippet; unrelated body text is omitted. JSON exposes `snippet` and `relevance`
without a full `body` or filesystem path. Harness search frames recalled text
as untrusted memory data; it never overrides current instructions. Capped pages
report only emitted entries and preserve the first unread offset.

`engram related <id>` complements `links` with direct lifecycle lineage:
`supersedes`, `superseded by`, outgoing `related`, and incoming `related by`.
It includes inactive history, resolves exact same-scope ids from one scan, and
preserves MISSING/AMBIGUOUS states. It infers no semantic or transitive edges.
Use `--scope project|personal`, `--offset n`, and `--limit n` (default 10,
maximum 100). Follow the continuation footer; related reads never write files.
