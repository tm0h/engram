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

# Hand-computed search outcomes (ENG-18 BM25 ranker)

Per-field Okapi BM25 (tag/title/type/body weights 5/3/2/1, k1 = 1.2,
b = 0.75, Lucene-variant idf) with bounded prefix fallback for word tokens
of 3+ characters, OR of words by default, and id-ascending ties. The
legacy fixed-points scoring this fixture used before ENG-18 is retained in
`searchEngramsLegacy` and is not documented here.

- "dev server port" -> 0001 matches on title and body tokens; no other
  candidate matches.
- "keybinding remapping" -> 0002: "keybinding" prefix-fallback matches
  "keybindings" in the body; "remapping" matches nothing, so the single
  matching word carries the alternative.
- "build pipeline" -> ab (title + tag + body); aa is excluded by status
  and would also match.
- "esbuild speed" -> ab ("esbuild" in title and body); aa scores zero by
  design and is status-filtered anyway.
- "tls certificate" -> af (title + body tokens); ae would match too but
  is expiry-filtered at now 2026-03-15.
- "tls certificate audit" -> af then ae (includeInactive): both match on
  title + body; af has the shorter body, so BM25 length normalization
  ranks it first. ae (the required id) stays present, so the case passes
  with one stale row.
- "cache" -> ac and ad: symmetric title + tag + body matches produce
  equal scores, broken id-ascending (ac < ad).
- "sitemap generation" -> ah then ag: ah matches "sitemap" in tag, title,
  and body (weights 5 + 3 + 1), which outranks ag's title + body (3 + 1)
  plus "generation" (3). The required id ag is present, so Recall@1 = 0
  with the case still passing.
- "kubernetes cluster autoscaling" -> nothing.

Aggregate hand-checks (k = [1, 3, 5]): eligible = 9, returned = 13,
Recall@1 = 6/9 (case-ambiguity-02, case-distractors-01, and
case-temporal-02 each have their first relevant id at rank 2),
Recall@3 = Recall@5 = 1, Precision@1 = 6/9, Precision@3 = 1/3,
Precision@5 = 1/5, MRR = (6 x 1 + 3 x 1/2) / 9 = 7.5/9 = 0.833333,
passRate = 10/10, stale = 1/13, forbidden = 0/13, abstention = 1/1,
falseAbstain = 0/9.
