# Offline abstention evaluation

## Protocol

Compare a single offline second-stage verifier with the production lexical search on retrieval corpus 0.3.1. Keep the corpus, checked-in baseline, ranker, and labels fixed. Record the baseline on main before running the verifier.

The candidate passes only if cases 12 and 14 return empty, case 11 and every other previously passing case stay green, and false abstentions stay at zero across the corpus and held-out must-answer queries. Keep the remaining held-out near-misses visible. Use the held-out queries once for this candidate, without adjusting the candidate after seeing their outcomes.

The held-out data includes Mothlight queries using shared hosting, websocket, and thumbnail vocabulary, plus a separate two-note Skylark workspace. The Skylark controls ask both direct and indirect questions, including a product restriction and an affirmative capability described in ordinary prose. These suites are small synthetic diagnostics and do not modify the canonical benchmark.

Report the case-level changes, answer coverage, correct abstentions, false abstentions, Recall@5, and warm latency percentiles. Measure the incremental verifier over the complete search call and run both conditions against identical data and options.

## Prototype

The verifier runs after the production manual-search evaluator. For eligible plain queries, it recognizes two small relation families using normalized phrases for domain acquisition and collaborative editing. It returns the entire lexical ranking if a returned note's title and body support all recognized relations, or if a returned note has an exact author-defined trigger. Otherwise it returns an empty ranking. An empty lexical ranking stays empty, and a query outside both families receives the vanilla lexical result. This experiment reads the already-limited ranking, so relevant evidence below a query's result limit cannot rescue it.

The verifier uses two built-in regular expressions and the existing normalizer. It requires no model, native or peer dependency, download, index, or additional persistence. Both sides of the evaluation run locally on synthetic data and make no network calls. The experiment lives under the benchmark tree and is absent from the published CLI and adapter entry points. Without the experiment, the rule is simply the existing deterministic lexical search.

## Results

Main at `ca6352ae9461f7629954d4ceeb3f219efb2d5431` reproduced both known failures on corpus 0.3.1. The shadow baseline matched the rankings and pass status of all 187 rows from that main run. The candidate changed only cases 12 and 14 on the canonical corpus.

| Suite              |     Passing cases |   Answer coverage | Correct abstentions | False abstentions |        Recall@5 |
| ------------------ | ----------------: | ----------------: | ------------------: | ----------------: | --------------: |
| Corpus 0.3.1       | 185/187 → 187/187 | 175/187 → 173/187 |       12/14 → 14/14 |     0/173 → 0/173 | 98.84% → 98.84% |
| Held-out Mothlight |         3/6 → 5/6 |         6/6 → 4/6 |           0/3 → 2/3 |         0/3 → 0/3 |     100% → 100% |
| Held-out Skylark   |         3/4 → 2/4 |         2/4 → 1/4 |           1/1 → 1/1 |         1/3 → 2/3 | 66.67% → 33.33% |

| Canonical case                            | Best lexical coverage | Results, baseline → verifier | Outcome                            |
| ----------------------------------------- | --------------------: | ---------------------------: | ---------------------------------- |
| Abstention 11, Windows log rotation       |                 9.85% |                        0 → 0 | Pass retained                      |
| Abstention 12, buy a domain               |                23.25% |                       35 → 0 | Fixed                              |
| Abstention 14, collaborative editing      |                22.44% |                       17 → 0 | Fixed                              |
| Exact facts 24, preview-host robots rules |                60.21% |                        5 → 5 | Required result retained at rank 1 |
| Multi-token 02, websocket reconnect loop  |                  100% |                        9 → 9 | Required result retained at rank 1 |
| Paraphrase 19, blocked preview hosts      |                28.87% |                      14 → 14 | Required result retained at rank 2 |
| Paraphrase 30, old thumbnails thrown away |                12.36% |                      10 → 10 | Required result retained at rank 2 |

| Held-out case                               | Results, baseline → verifier | Outcome                   |
| ------------------------------------------- | ---------------------------: | ------------------------- |
| Buy a custom domain for the CDN alias       |                       93 → 0 | Fixed                     |
| Edit together over the dev-server websocket |                       90 → 0 | Fixed                     |
| Image-cache encryption                      |                      89 → 89 | Unresolved near-miss      |
| Preview-host robots exclusion               |                      92 → 92 | Pass retained             |
| Websocket reconnect after restart           |                      91 → 91 | Pass retained             |
| Thumbnail retention                         |                      89 → 89 | Pass retained             |
| Skylark domain purchase policy              |                        2 → 0 | New false abstention      |
| Skylark shared drafts policy                |                        0 → 0 | Existing false abstention |
| Skylark existing hostname setup             |                        2 → 2 | Pass retained             |
| Skylark draft history                       |                        0 → 0 | Pass retained             |

The Skylark domain note answers the purchase question by stating that Skylark only accepts hostnames the customer already owns and directing them to an independent DNS provider. The required information was ranked first by the baseline. The verifier missed that evidence because the note used different phrases. The shared-drafts control already fell below the lexical abstention threshold at 3.10% coverage, so a verifier that only suppresses results could not recover it.

On one local run with Node 24, after three warmups and seven measured runs per condition, median per-run p50/p95/p99 were **2.01/5.34/6.48 ms** for baseline and **2.05/5.43/6.28 ms** for the verifier. Timing includes search and the verifier where applicable, excludes corpus loading, and is descriptive.

## Maple active-turn recall

The [memory application evaluation](memory-application-evaluation.md) recorded an agent returning the pinned Maple database snapshot path for a thumbnail question. An offline replay delivered the same Maple and Juniper entries through Pi's bundled active-turn hook. In a one-note replay through that hook, the Maple database note was delivered with pinning enabled and disappeared with pinning disabled.

Automatic contextual recall ranks with literal search and applies its own per-entry confidence checks. Its separate curated selection can deliver active pinned or high-importance entries even when contextual confidence is insufficient. This manual-search experiment cannot address that delivery path.

## Reproduce

From a clean checkout, install the pinned workspace dependencies and run the following. In an environment where the `tsx` launcher cannot bind its IPC socket, invoke the same benchmark entry point with `node --import tsx packages/core/src/benchmark/run.ts --out /tmp/engram-main.json`.

```sh
pnpm --filter @engram/core benchmark --out /tmp/engram-main.json
node --import tsx packages/core/src/benchmark/experiments/run-abstention.ts > /tmp/engram-abstention-shadow.json
pnpm --filter engram-cli build
node --import tsx scripts/memory-application/evaluate.ts \
  --bin packages/cli/dist/index.js --output /tmp/engram-maple-delivery.json \
  --task location-near-match --offline
```

The shadow report includes all rankings, case labels, scores for the pass criteria, and latency. Capture the baseline on the named main commit for an independent comparison. The offline Maple command replays delivery only. Agent outcomes are in the existing memory application baseline.

## Decision

Reject the prototype for production because it introduces a false abstention on a previously passing held-out control. Keep the lexical policy and the canonical benchmark intact. A future local verifier should test whether a note supports the requested relation in prose, including both affirmative and negative evidence. Use fresh held-out cases for that candidate and keep curated active-turn delivery under separate evaluation.
