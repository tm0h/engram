# Offline abstention evaluation

## Protocol

Compare a single offline second-stage verifier with the production lexical search on retrieval corpus 0.3.1. Keep the corpus, checked-in baseline, ranker, and labels fixed. Record the baseline on main before running the verifier.

The candidate passes only if cases 12 and 14 return empty, case 11 and every other previously passing case stay green, and false abstentions stay at zero across the corpus and held-out must-answer queries. Keep the remaining held-out near-misses visible. Use the held-out queries once for this candidate, without adjusting the candidate after seeing their outcomes.

The held-out data includes Mothlight queries using shared hosting, websocket, and thumbnail vocabulary, plus a separate two-note Skylark workspace. The Skylark controls ask both direct and indirect questions, including a product restriction and an affirmative capability described in ordinary prose. These suites are small synthetic diagnostics and do not modify the canonical benchmark.

Report the case-level changes, answer coverage, correct abstentions, false abstentions, Recall@5, and warm latency percentiles. Measure the incremental verifier over the complete search call and run both conditions against identical data and options.
