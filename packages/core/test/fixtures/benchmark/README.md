Synthetic benchmark-internal fixture for runner and metric tests; NOT the golden corpus.

# What this is

A single JSON object ({ manifest, engrams, cases }) that mirrors the ENG-11
contract shapes so the ENG-8 benchmark can test mapping, lifecycle staleness,
contract pass/fail math, and deterministic reporting without the real corpus
loader (loading and validation are ENG-11's executable contract, consumed
through an injected evaluate fn). It lives in the benchmark test fixtures
directory, uses no corpus/ directory layout, and has no markdown fixture
files.

# Relationship to the golden corpus

- The golden corpus (ENG-11, name "mothlight-retrieval-corpus",
  corpusVersion 0.2.0) lives in the ENG-11 worktree and is never copied
  here.
- This fixture uses a different name ("benchmark-internal-eval-fixture") and
  corpusVersion 0.0.1 so the report header can never be mistaken for a
  golden-corpus baseline.
- All content is synthetic ("mothlight", a fictional static-site generator,
  plus one personal-scope preference). No real engrams, credentials, or
  private data.

# Shape notes (contract-shaped)

All 10 cases satisfy the real CorpusCase structurally (applicablePaths and
notes present); the adapter consumes them as a LoadedCorpus with an empty
issues list, exactly like loadCorpus output.

- `engrams` entries are { engram, file } records like loadCorpus output;
  the engram objects use the full domain Engram shape (path is synthetic).
- `cases` use the contract case fields the benchmark reads. Extra
  contract-only fields (duplicateOf on case-ambiguity-02) are present as
  data to document the shared-query rule but are not read by the benchmark.
- Ids: nine 26-char Crockford base32 ids plus two legacy 4-digit ids
  (0001, 0002), exercising both id shapes and their codepoint ordering.

# Scenario coverage (11 engrams, 10 cases)

| case id              | exercises                                                        |
| -------------------- | ---------------------------------------------------------------- |
| case-exact-facts-01  | exact fact, manifest defaultNow, legacy id, project scope        |
| case-paraphrase-01   | paraphrase overlap via body, personal scope filter, legacy id    |
| case-superseded-01   | superseded fixture excluded by default visibility                |
| case-superseded-02   | includeInactive: superseded fixture scores zero, still forbidden |
| case-temporal-01     | expired fixture filtered at the case's own now                   |
| case-temporal-02     | expired fixture retrieved on purpose (includeInactive), stale x1 |
| case-ambiguity-01/02 | shared query via duplicateOf, tied scores, id-ascending order    |
| case-distractors-01  | distractor outranks required id (Recall@1 = 0, pass still holds) |
| case-abstention-01   | expectEmpty: query tokens appear nowhere, zero results           |

# Hand-computed search scores (pinned procedure over searchEngrams)

Weights: tag exact +5, title contains +3, type match +2, body contains +1,
pinned +0.5. Ties break by id ascending.

- "dev server port" -> 0001: 12 (title 9 + body 3); expired fixture
  would score 1 via "mothlight.dev" but is expiry-filtered at defaultNow.
- "keybinding remapping" -> 0002: 1 (body only).
- "build pipeline" -> ab: 12 (title 6 + body 1 + tag 5); aa excluded
  by status (would also score 12).
- "esbuild speed" -> ab: 5 (title 3 + body 2); aa scores 0 by design.
- "tls certificate" -> af: 7 (title 6 + body 1); ae would tie at 7 but
  is expiry-filtered at now 2026-03-15.
- "tls certificate audit" -> ae: 7 and af: 7, tie broken ae < af; ae is
  returned under includeInactive and counted stale.
- "cache" -> ac: 9 and ad: 9, tie broken ac < ad.
- "sitemap generation" -> ah: 9 (title 3 + body 1 + tag 5) outranks
  ag: 7 (title 6 + body 1); ai would score 13 but is status-filtered.
- "kubernetes cluster autoscaling" -> nothing.

Aggregate hand-checks (k = [1, 3, 5]): eligible = 9, returned = 13,
Recall@1 = 7/9 (case-ambiguity-02 and case-distractors-01 have their first
relevant id at rank 2), Recall@3 = Recall@5 = 1, Precision@1 = 7/9,
Precision@3 = 1/3, Precision@5 = 1/5, MRR = (7 x 1 + 2 x 1/2) / 9 = 8/9,
passRate = 10/10, stale = 1/13, forbidden = 0/13, abstention = 1/1,
falseAbstain = 0/9.
