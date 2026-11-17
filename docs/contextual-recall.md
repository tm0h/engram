# Shared contextual recall

`contextualRecallOp` is a stateless, harness-neutral operation exported by
`@engram/harnesses/shared`. Adapters inject its `text` only when nonempty.
Pi and OpenCode lifecycle delivery are separate integrations.

```ts
import { contextualRecallOp, runOpAtDirectory } from "@engram/harnesses/shared";

const result = await runOpAtDirectory(
  sessionDirectory,
  contextualRecallOp({
    prompt: userPrompt,
    intent: "task", // or "question"; both use the same confidence policy
    activePaths: ["src/storage.ts"], // optional, repository-relative
    bootstrap: deliveredBootstrap, // optional, actual emitted selection
  }),
);
```

Use the current session's directory with `runOpAtDirectory`, never a process
`chdir` or an unrelated initialization directory. The global `autoContext`
opt-out and `autoContextScope` setting apply. Default scope is project;
`both` outside a project uses personal memory and records that fallback in
structured diagnostics and every nonempty payload.

After a successful startup injection, retain `autoContextOp`'s
`details.bootstrap` snapshot. It now includes `projectRoot` (`null` outside a
project) and the actual `selected` identities. Pass those values only if the
payload was actually delivered. Recall ignores a snapshot from another
project root and deduplicates by scope plus id. It never recomputes bootstrap
selection. There is no implicit repeat-call suppression or process-global
session cache: identical inputs and stores select identical entries; a changed
prompt is ranked afresh. Adapters own session delivery state.

## Retrieval and confidence

Read each configured scope once, filter path-specific entries against the union
of active paths, then rank globally with the production lexical ranker. Without
an active path, scoped memories are ineligible. Inactive and expired entries
remain excluded; old active durable facts do not expire merely because of age.
Path applicability grants eligibility, never confidence. No related entries
are expanded automatically.

The core `searchEngrams` option `literal: true` removes query syntax from prompt
interpretation: quotes, colons and stars become separators, uppercase boolean
operators become ordinary words. CamelCase and call-form token expansion remain
shared with manual search. Whole-query authored triggers still compare against
the original prompt. Manual search without this option is unchanged.

Literal mode delegates abstention to the caller's per-entry policy rather than
using manual search's corpus-relative query-level abstention. Automatic recall
requires either an exact normalized authored trigger or at least 60% coverage
of informative query units, with at least two units matched for multi-unit
queries. A single informative unit must be completely covered. A small explicit
English conversational-word list is excluded from confidence coverage. Other
languages retain all units, which can cause conservative abstention.

A unit is a parsed whitespace term after shared query deduplication/expansion.
A matched unit needs evidence for its whole token or longest separator component
(e.g. `toJSON` from `toJSON(x)`). A lone argument or camelCase fragment does not
suffice. Evidence comes only from positive title/tag/alias/body lexical
contributions, including the production ranker's bounded word-prefix fallback.
Type, pinning, importance, freshness and path metadata cannot supply confidence.
The 60% boundary admits three of five domain units, rejects two of five, and
rejects a one-of-two vocabulary graze. Tests pin these examples. This is a
conservative lexical policy, not a semantic relevance guarantee or a universal
BM25 score threshold. Corpus labels and existing baseline gates are unchanged.

## Bounds and failure behavior

| Boundary            | Limit                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| Prompt              | 4096 UTF-16 code units                                                  |
| Active paths        | 16 paths, 256 UTF-16 code units each; no absolute paths or traversal    |
| Delivered bootstrap | 100 valid scope/id pairs; root at most 4096 UTF-16 code units           |
| Emitted results     | 5 complete rows                                                         |
| Rendered payload    | 4096 UTF-16 code units and 8192 UTF-8 bytes, including frame/provenance |
| Ranking diagnostics | First 20 ranked candidates, without prompt text or contribution tokens  |
| Retrieval deadline  | 500 ms, including configuration and store reads                         |

Oversized or malformed inputs produce an empty result before store/config reads.
Query units and normalized trigger text are prepared once per recall and reused
across candidates. Output is packed by whole rows, with bounded titles and matching
body excerpts; confident metadata/trigger-only matches use a bounded opening
excerpt when no matching body window exists. Manual search keeps its null
excerpt for metadata-only matches.
Only actually emitted entries appear in `details.selected`. Stored controls and
angle brackets are sanitized inside a complete untrusted-memory frame. Scores,
coverage, timing, store paths and continuation/tool instructions are absent from prompt
text. Titles/snippets remain recorded memory data, not instructions.

Empty or weak retrieval, opt-out, unavailable stores, configuration/domain
errors, defects and internal timeouts produce `text: ""`, `isError: false`.
No empty wrapper or error message is injected. External caller interruption
propagates. The asynchronous deadline cancels pending reads; a monotonic elapsed
check also discards synchronous ranking overruns. JavaScript cannot preempt a
running synchronous ranker on the same thread, so this deadline is not a CPU
sandbox. Callers can cancel the operation as part of their request lifecycle.

`details` contains a schema version, reason, elapsed milliseconds and emitted
identities. Successful retrieval also reports scope fallback, store diagnostic
counts, ranked/confident/duplicate counts, and bounded per-candidate scores and
confidence evidence. It includes no raw prompt, filesystem path, error message,
full body, or query contribution tokens. Nothing is logged or written by recall.
