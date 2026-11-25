# Search memory

Use `engram search <query>` to find entries by topic, or follow entry relationships with `engram links` and `engram related`.

## Structured search

Search uses field-weighted Okapi BM25. Tags carry the most weight, followed by
aliases, titles, types, and bodies (tag 5, alias 4, title 3, type 2, body 1,
plus +0.5 for pinned). Aliases are alternate names, distinct from tags;
entries hold at most 20 aliases of 80 characters, and multi-word aliases match
through the phrase bonus. Ranking also rewards rarer terms, normalizes field
length, and gives pinned entries a small boost.

The query language supports quoted phrases, bounded prefixes, field filters,
and explicit Boolean groups:

```sh
engram search '"release checklist"'                    # boost a contiguous phrase
engram search 'kuber*'                                 # match a token prefix
engram search 'tag:auth AND body:rotation'             # require both terms
engram search 'title:deploy OR type:decision'          # match either term
```

Whitespace has the same meaning as `OR`. Uppercase `AND` binds more tightly
than `OR`; lowercase `and` and `or` remain ordinary terms. Filters accept
`tag:`, `title:`, `type:`, and `body:`. Quoted phrases add a contiguous-match
boost rather than excluding results that match only part of the phrase.

`engram search "auth" --json --explain --limit 10 --offset 0` emits one JSON
document. `--json` alone omits explanations. `--explain` alone emits plain-text
score contributions instead of snippets.

```json
{
  "schemaVersion": 1,
  "query": "auth",
  "total": 1,
  "offset": 0,
  "limit": 10,
  "nextOffset": null,
  "results": [
    {
      "id": "0001",
      "scope": "project",
      "title": "Auth policy",
      "type": "note",
      "tags": [],
      "updated": "2026-01-01T00:00:00.000Z",
      "pinned": false,
      "score": 0.39229373516151933,
      "explanation": {
        "mode": "relevance",
        "contributions": [
          {
            "field": "title",
            "token": "auth",
            "score": 0.39229373516151933,
            "component": "bm25"
          }
        ]
      }
    }
  ]
}
```

Results are globally ranked across selected scopes, then paginated. CLI search
defaults to the current project, or personal scope outside a project. Use
`--scope all` for both. The default limit is unlimited (`limit: null`). A supplied
limit is a positive safe integer; offset is a nonnegative safe integer and
requires `--json` or `--explain`. An offset beyond the end returns an empty page
with the requested offset and unchanged total. `nextOffset: null` means no more
results. Default text mode retains scope grouping and its per-scope limit.

Each result is identified by both `scope` and `id`. Summaries omit bodies,
filesystem paths, authors, and source references. Contributions contain a
normalized query token, score, field, and component (`bm25`, `phrase`,
`prefix`, or `pinned`). Their scores sum to the result score. A pinned entry can
surface without a lexical match. Empty or punctuation-only queries use recency
ordering with score 0.

Pi and OpenCode `engram_search` expose the same versioned report as result
metadata, with `explain: true` enabling contributions. Their text responses
retain 10-result pagination. CLI errors exit nonzero and keep stdout free of
partial JSON. Use `--all` to include inactive entries in CLI search.

## Retrieval triggers and path applicability

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

## Lifecycle ranking and diverse results

Search keeps inactive memories ineligible by default. After lexical abstention and
exact-trigger matching, active results receive small explained bonuses:
`importance` adds 0.1 per level (optional integer 0–5, default absent), matching
`appliesTo` adds 0.25 when `search --path` is supplied, and recent notes/issues
receive up to 0.25, decreasing linearly to zero after 30 days. Invalid or future
update times receive no freshness bonus. Decisions, facts, preferences, and context
have no age-based adjustment. Pinning and trigger contributions remain separately
visible. These new adjustments never admit an otherwise unmatched memory.

Use `engram add --importance 5` or `engram edit <id> --importance 3` to set author
importance; `engram edit <id> --importance ""` clears it. The optional Markdown
`importance` key round-trips through edits and appears in `show`. Use the CLI to
manage importance from harnesses.

Search diversification conservatively compares same-scope, same-type memories
whose titles have at least 80% token-set overlap and whose bodies have at least
90% overlap (at least eight unique body tokens). It keeps the strongest match
from each group ahead of repeated content; duplicates remain available later
with a negative `diversification` contribution. Comparison is bounded to 64 group
representatives and bodies up to 16 KiB/titles up to 1 KiB; larger entries are
never classified using a truncated prefix. `--explain` contributions still sum
to the final score. Recency-only listing and the legacy benchmark ranker are
unchanged. Pagination runs after this ranking.

See the [retrieval ranking evaluation](retrieval-ranking-evaluation.md) for scoring details and measured results.

## Matching snippets and related context

Search text, JSON, and harness results show a bounded matching body excerpt
(maximum 240 UTF-16 characters, including ellipses) and a compact relevance reason.
Excerpts prefer the earliest contiguous query phrase, then the earliest lexical
match. Original Unicode graphemes are retained; whitespace is collapsed.
Metadata-only matches have `snippet: null`, rather than an unrelated body preview.
Detailed score contributions remain opt-in with `--explain`.

`engram related <id> [--scope project|personal] [--offset n] [--limit n]`
shows direct `supersedes` and `superseded by` lineage plus authored `related`
links and computed `related by` backlinks, including inactive entries. It uses
one same-scope scan, exact ids, and the existing missing/ambiguous resolution
rules. Outgoing lineage precedes outgoing links, then incoming lineage and
backlinks; incoming groups sort by creation time and id. The default page is 10
rows, maximum 100, with an 8192-character output cap and continuation footer.
No semantic or transitive edges are inferred or persisted. `engram links` keeps
its explicit-link-only behavior. Pi also supports `/engram related <id>` with
the same flags. Harness recalled snippets and related context are framed as
untrusted data; complete frames and continuation details survive size capping.

## Link graph

`engram links <id>` prints the link graph around one entry. Outgoing rows
follow the entry's authored `related` order; incoming rows list backlinks in
creation order (ties break by id). Ids are exact and same-scope only: a strict
prefix never resolves, and an id present only in the other scope reads as
missing rather than falling back.

A missing target carries a literal `MISSING` marker; an id claimed by several
files carries `AMBIGUOUS` with a bounded claimant list. Both are successful
reads, never errors. Output is plain text, capped at ~8 kB, and paginated over
one flattened row stream:

```sh
engram links 0012                        # default page: 10 rows
engram links 0012 --scope personal       # read the personal scope explicitly
engram links 0012 --offset 10 --limit 20 # continue past the first page
```

The continuation footer names the next call. Related links themselves are
written with `engram add --related` / `engram edit --related`.
