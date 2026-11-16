# Lifecycle ranking evaluation

The ranking policy runs after lexical abstention and exact triggers, before
limits/pagination. Existing lifecycle filtering remains the eligibility gate.
The legacy ranker, corpus labels, corpus identity, and baseline are unchanged.

## Signals

| Signal             | Rule                                                 | Maximum added score |
| ------------------ | ---------------------------------------------------- | ------------------- |
| Pinning            | Existing lexical-ranker behavior                     | 0.5                 |
| Exact trigger      | Existing full-query trigger behavior                 | 4                   |
| Author importance  | Integer 0–5, multiplied by 0.1                       | 0.5                 |
| Path applicability | Explicit current path matched nonempty applicability | 0.25                |
| Type and freshness | Notes/issues only; linear from age zero to 30 days   | 0.25                |
| Active status      | Existing exclusion of inactive entries by default    | Eligibility         |

No age penalty applies to decisions, facts, preferences, or context. Future or
invalid update timestamps receive no freshness bonus. Importance/applicability
and freshness do not make unmatched memories eligible and do not undo abstention.
`includeInactive` still allows inspecting historical memories without the new
active-only bonuses.

## Diversification

The highest-scored representative stays first. Same-type, same-scope memories
with at least 0.8 title-token and 0.9 body-token Jaccard similarity are treated
as repeated content, provided each body contains at least eight unique tokens.
Their score is reduced below the lowest distinct representative (and at least
halved). The negative adjustment is exposed as `diversification`. Entries are
never deleted or collapsed; an unlimited search still returns every eligible hit.

Comparisons use at most 64 representatives and skip bodies above 16 KiB or titles
above 1 KiB. This bounds duplicate-detection work without comparing truncated text.
It is a lexical similarity heuristic, not semantic conflict detection.

## Measurements

On unchanged corpus 0.3.1 (187 cases), evaluated at its fixed timestamps:

| Metric                   | Before              | After               |
| ------------------------ | ------------------- | ------------------- |
| Passing cases            | 185/187             | 185/187             |
| Required-memory Recall@5 | 0.9884393063583815  | 0.9884393063583815  |
| Precision@5              | 0.19884393063583786 | 0.19884393063583786 |
| False abstentions        | 0                   | 0                   |

The two existing semantic-abstention misses remain. No baseline or labels were
regenerated. The checked-in baseline gate still passes.

A separate deterministic duplicate-heavy fixture contains six copies of one
memory plus four distinct required memories. Lexical top five contains zero
required memories; diversified top five contains all four (required Recall@5
0 to 1). Counting one representative as useful, top-five useful precision rises
from 1/5 to 5/5. All ten hits remain in the unlimited result. This fixture and
near-duplicate/scope controls live in `packages/core/test/lifecycle-ranking.test.ts`.
This supports conservative diversification; it does not establish a general
semantic deduplication benefit on the golden corpus, whose aggregate is unchanged.
