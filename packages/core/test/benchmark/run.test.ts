import { describe, expect, it } from "vite-plus/test";
import { runRepoBenchmark } from "../../src/benchmark/run.js";

describe("runRepoBenchmark JSON contract", () => {
  it("emits no latency samples: the persisted baseline JSON is latency-free", () => {
    // Latency is inherently nonreproducible and never participates in the
    // gate, so the persisted artifact records no timing samples at all;
    // regenerations then churn only on real retrieval changes (PR #43
    // review: incidental timing churn).
    const json = runRepoBenchmark();
    expect(json.metrics.perQuery.length).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toContain("latencyNs");
  });
});
