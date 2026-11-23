# Evidence gate for optional semantic search

The gate is closed. The thresholds and budgets below are **proposed**. Review
and adopt them before collecting the held-out results used for a decision.
A checked-in report must establish a representative lexical retrieval shortfall
before semantic implementation begins. An experimental semantic candidate must
then satisfy the improvement and operational budgets before it can ship.

## Workload and labels

Run the [canonical retrieval corpus](../corpus/README.md) unchanged as the
regression suite. For the gate decision, also check in a separate, versioned
workload with at least 100 must-answer queries and 30 must-abstain controls
across at least five independent project snapshots. Use public or synthetic
content with realistic memory sizes and query mixes. Include identifiers,
paraphrases, troubleshooting, conventions, file-scoped queries, conflicting and
retired guidance, and personal/project boundaries. Derive the query mix and
store sizes from target coding workflows and record the sampling method.
Split tuning and holdout by project before tuning. Keep the holdout
unchanged across both arms of the comparison.

Freeze gold labels before scoring. Give each case the query, scope, current
path, timestamp, any evaluation limit, required engram IDs, optional supporting
IDs, stale or forbidden IDs, and expected abstention. Have a second reviewer
resolve disagreements before freezing labels. Record the workload version and
hash, gold label changes, commands, engine SHAs, hardware, runtime, and search
settings in the report.

## Opening and shipping criteria

| Measure                   | Proposed criterion                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lexical Recall@5 floor    | Open the gate only if representative held-out lexical Recall@5 is below 98% and the case breakdown shows ranking misses after lexical tuning.                                                                                                                                                                                                                      |
| Recall@5 calculation      | Macro-average over all must-answer queries with at least one required eligible ID. Per-query recall is distinct required IDs in the first five divided by all required eligible IDs. A false abstention contributes zero. Must-abstain and optional supporting IDs are outside this denominator. Publish both the denominator and per-project results.             |
| Semantic improvement      | Reach at least 98% held-out Recall@5 and improve on lexical by at least 2.0 percentage points on the same queries. Report paired per-query changes.                                                                                                                                                                                                                |
| Regression and abstention | Zero false abstentions in both suites for the candidate. Retain every previously passing case and every previously retrieved required top-five ID. Introduce zero forbidden results and no increase in stale results or answers to must-abstain controls.                                                                                                          |
| Offline latency           | At 10,000 memories per scope on the declared reference laptop, warm end-to-end p95 at most 50 ms and at most 15 ms above lexical. Cold p95 at most 300 ms. Run at least 100 queries per condition after warmup and report p50, p95, p99, sample counts, and indexing/rebuild time separately. Include store and index access and rendering in lookup timings.      |
| Privacy and availability  | Run ingest, query, and evaluation offline after optional asset installation. Zero network calls or telemetry with memory or query data. Keep scope-local index data under the corresponding store's access controls. The Markdown source remains authoritative, with lexical fallback when semantic search is disabled or its index is missing, stale, or corrupt. |
| Index size                | At most 50 MiB per 10,000 memories per scope, measured on disk including metadata and index sidecars. Report model assets, dependencies, bundle delta, and rebuild peak disk use separately.                                                                                                                                                                       |

Make the strongest lexical baseline reproducible before attributing misses to
semantics. Report representative outcomes after BM25, Unicode and code-aware
tokenization and query expansion, author triggers, path applicability,
snippets, and lifecycle-aware ranking and diversification. Record any tuned
changes and the scripts or settings needed to replay them. Run candidates with
the same snapshots, labels, retrieval budget, and offline setup as the baseline.

For each miss, show required IDs, returned top-five IDs, ranks where available,
and the cause. Separate required evidence ranked too low or missing from the
eligible results, false abstentions on must-answer cases, and false answers
on must-abstain cases. Measure evidence delivery and application separately
when replaying agent tasks. A delivered memory that the agent ignores or
misapplies is an application failure. A memory that ranks correctly but fails
to reach the agent is a delivery failure.

## Canonical reference measurement

From the repository root:

```sh
pnpm --filter @engram/core benchmark
node --import tsx packages/core/src/benchmark/run.ts --out /var/tmp/engram-retrieval.json
pnpm exec vp test run packages/core/test/benchmark/baseline-gate.test.ts
```

Corpus 0.3.1 at main `cdfb879582cf845dc9cbf32e8512441d999057ff` and with
the migration changes produced the same **185/187 passing cases** and **98.84%
Recall@5** across 173 must-answer cases. Precision@5 was 19.88%. There were
**0/173 false abstentions**, **12/14 correct abstentions**, and zero forbidden
results. The checked-in baseline and corpus labels remain fixed.

| Case                 | Outcome                                                 |
| -------------------- | ------------------------------------------------------- |
| `case-paraphrase-25` | Required memory ranked ninth. Top-five recall was zero. |
| `case-paraphrase-26` | Required memory ranked tenth. Top-five recall was zero. |
| `case-abstention-12` | Returned 35 results on a must-abstain query.            |
| `case-abstention-14` | Returned 17 results on a must-abstain query.            |

This synthetic regression suite does not establish a shortfall on the
representative workload. The [offline abstention experiment](offline-abstention-evaluation.md)
also recorded a new false abstention on a held-out control. The evaluation
remained offline and its prototype stayed outside production search.
