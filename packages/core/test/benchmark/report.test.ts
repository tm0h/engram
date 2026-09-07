import { describe, expect, it } from "vite-plus/test";
import { ContractCorpusAdapter } from "../../src/benchmark/adapter.js";
import { renderReport } from "../../src/benchmark/report.js";
import { runBenchmark } from "../../src/benchmark/runner.js";
import { evaluateCase, loadFixtureLoaded, steppingClock, TEST_CONFIG } from "./helpers.js";

/** Snapshot fixture run (ENG-18 BM25 ranker): stepping clock makes every
 * latency exactly 10ns, so the whole report, latency included, is
 * deterministic.
 *
 * Hand-computed aggregates (k = [1, 3, 5]; arithmetic in fixtures
 * README.md): eligible = 9 of 10 cases, returned = 13 rows.
 *   Recall@1 = 6/9 = 0.666667 (case-ambiguity-02, case-distractors-01, and
 *   case-temporal-02 each have their first relevant id at rank 2; the
 *   temporal case now ranks the active entry above the expired one)
 *   Recall@3 = Recall@5 = 1.000000
 *   Precision@1 = 6/9 = 0.666667; Precision@3 = 9 x (1/3) / 9 = 0.333333;
 *   Precision@5 = 9 x (1/5) / 9 = 0.200000 (denominator is k)
 *   MRR = (6 x 1 + 3 x 1/2) / 9 = 7.5/9 = 0.833333
 *   passRate = 10/10; stale = 1/13 = 0.076923; forbidden = 0/13;
 *   abstention = 1/1; falseAbstain = 0/9; rendered chars total = 938. */
const expectedReport =
  [
    "ENG-8 benchmark report",
    "corpus name=benchmark-internal-eval-fixture version=0.0.1 schemaVersion=1",
    "k=1,3,5 abstainThreshold=0 (inert: abstain = empty ranking)",
    'per-case (sorted by id; "-" = excluded):',
    "case-abstention-01  cat=abstention       pass=1 abst=1 exp=1 ret=0 stale=0 forb=0 sup=0 chars=0 lat=10ns R@1=       - R@3=       - R@5=       - P@1=       - P@3=       - P@5=       - RR=       -",
    "case-ambiguity-01   cat=ambiguity        pass=1 abst=0 exp=0 ret=2 stale=0 forb=0 sup=1 chars=116 lat=10ns R@1=1.000000 R@3=1.000000 R@5=1.000000 P@1=1.000000 P@3=0.333333 P@5=0.200000 RR=1.000000",
    "case-ambiguity-02   cat=ambiguity        pass=1 abst=0 exp=0 ret=2 stale=0 forb=0 sup=1 chars=116 lat=10ns R@1=0.000000 R@3=1.000000 R@5=1.000000 P@1=0.000000 P@3=0.333333 P@5=0.200000 RR=0.500000",
    "case-distractors-01 cat=distractors      pass=1 abst=0 exp=0 ret=2 stale=0 forb=0 sup=1 chars=151 lat=10ns R@1=0.000000 R@3=1.000000 R@5=1.000000 P@1=0.000000 P@3=0.333333 P@5=0.200000 RR=0.500000",
    "case-exact-facts-01 cat=exact-facts      pass=1 abst=0 exp=0 ret=1 stale=0 forb=0 sup=0 chars=77 lat=10ns R@1=1.000000 R@3=1.000000 R@5=1.000000 P@1=1.000000 P@3=0.333333 P@5=0.200000 RR=1.000000",
    "case-paraphrase-01  cat=paraphrase       pass=1 abst=0 exp=0 ret=1 stale=0 forb=0 sup=0 chars=76 lat=10ns R@1=1.000000 R@3=1.000000 R@5=1.000000 P@1=1.000000 P@3=0.333333 P@5=0.200000 RR=1.000000",
    "case-superseded-01  cat=superseded       pass=1 abst=0 exp=0 ret=1 stale=0 forb=0 sup=0 chars=68 lat=10ns R@1=1.000000 R@3=1.000000 R@5=1.000000 P@1=1.000000 P@3=0.333333 P@5=0.200000 RR=1.000000",
    "case-superseded-02  cat=superseded       pass=1 abst=0 exp=0 ret=1 stale=0 forb=0 sup=0 chars=68 lat=10ns R@1=1.000000 R@3=1.000000 R@5=1.000000 P@1=1.000000 P@3=0.333333 P@5=0.200000 RR=1.000000",
    "case-temporal-01    cat=temporal         pass=1 abst=0 exp=0 ret=1 stale=0 forb=0 sup=0 chars=87 lat=10ns R@1=1.000000 R@3=1.000000 R@5=1.000000 P@1=1.000000 P@3=0.333333 P@5=0.200000 RR=1.000000",
    "case-temporal-02    cat=temporal         pass=1 abst=0 exp=0 ret=2 stale=1 forb=0 sup=1 chars=179 lat=10ns R@1=0.000000 R@3=1.000000 R@5=1.000000 P@1=0.000000 P@3=0.333333 P@5=0.200000 RR=0.500000",
    "per-category (contract order; n/a = no cases):",
    "exact-facts      1/1=1.000000",
    "paraphrase       1/1=1.000000",
    "code-identifiers 0/0=n/a",
    "multi-token      0/0=n/a",
    "subsystem-paths  0/0=n/a",
    "superseded       2/2=1.000000",
    "temporal         2/2=1.000000",
    "ambiguity        2/2=1.000000",
    "distractors      1/1=1.000000",
    "abstention       1/1=1.000000",
    "aggregate (cases=10 passed=10 eligible=9 returned=13):",
    "Recall@1=0.666667 Recall@3=1.000000 Recall@5=1.000000",
    "Precision@1=0.666667 Precision@3=0.333333 Precision@5=0.200000",
    "MRR=0.833333",
    "passRate=10/10=1.000000 falseAbstain=0/9=0.000000 abstain=1/1=1.000000",
    "stale=1/13=0.076923 forb=0/13=0.000000",
    "chars_total=938",
    "latency p50=10 p95=10 p99=10 samples=10,10,10,10,10,10,10,10,10,10",
  ].join("\n") + "\n";

const fixtureResult = () => {
  const input = new ContractCorpusAdapter(loadFixtureLoaded()).toRunInput();
  return runBenchmark(evaluateCase, input, TEST_CONFIG, {
    clock: steppingClock(),
  });
};

describe("renderReport", () => {
  it("renders the deterministic snapshot byte-for-byte", () => {
    expect(renderReport(fixtureResult())).toBe(expectedReport);
  });

  it("shows the handed corpus identity, not a provisional notice", () => {
    const report = renderReport(fixtureResult());
    expect(report).toContain("corpus name=benchmark-internal-eval-fixture version=0.0.1");
    expect(report).not.toContain("PROVISIONAL");
  });

  it("lists case rows sorted by id with excluded cells as dashes", () => {
    const lines = renderReport(fixtureResult()).split("\n");
    expect(lines[4]?.startsWith("case-abstention-01")).toBe(true);
    expect(lines[5]?.startsWith("case-ambiguity-01")).toBe(true);
    expect(lines[13]?.startsWith("case-temporal-02")).toBe(true);
    // excluded (no relevant ids) cells render as dashes, never zeros
    expect(lines[4]).toContain("R@1=       -");
    expect(lines[4]).toContain("RR=       -");
  });

  it("rounds aggregates once at report time (6 decimals)", () => {
    const report = renderReport(fixtureResult());
    expect(report).toContain("stale=1/13=0.076923");
    expect(report).toContain("MRR=0.833333");
    expect(report).not.toContain("0.0769230");
  });

  it("keeps latency structural under the default clock", () => {
    const input = new ContractCorpusAdapter(loadFixtureLoaded()).toRunInput();
    const result = runBenchmark(evaluateCase, input, TEST_CONFIG);
    const report = renderReport(result);
    expect(report).toMatch(/latency p50=\d+ p95=\d+ p99=\d+ samples=/);
  });
});
