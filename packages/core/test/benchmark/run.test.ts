import { describe, expect, it } from "vite-plus/test";
import { computeMetrics } from "../../src/benchmark/metrics.js";
import { buildBenchmarkJson } from "../../src/benchmark/run.js";
import type { BenchmarkResult, QueryOutcome } from "../../src/benchmark/types.js";
import { engram, queryCase } from "./helpers.js";

const outcome = (over: Partial<QueryOutcome> & { queryId: string }): QueryOutcome => ({
  rankedIds: [],
  abstained: true,
  latencyNs: 0,
  renderedChars: 0,
  ...over,
});

describe("buildBenchmarkJson JSON contract", () => {
  it("emits no latency samples: the persisted baseline JSON is latency-free", () => {
    // Smallest fixture that pins the emitted-JSON contract (PR #43 review:
    // no full-corpus run here; baseline-gate.test.ts already runs one).
    // Latency is inherently nonreproducible and never participates in the
    // gate, so the persisted artifact records no timing samples at all.
    const queries = [queryCase({ id: "qx", query: "x", relevantIds: ["e1"] })];
    const outcomes = [
      outcome({ queryId: "qx", rankedIds: ["e1"], abstained: false, latencyNs: 10, renderedChars: 3 }),
    ];
    const metrics = computeMetrics(queries, outcomes, [1], new Map([["e1", engram({ id: "e1" })]]));
    const result: BenchmarkResult = {
      corpus: { name: "fixture", corpusVersion: "0.0.0-test", schemaVersion: 1 },
      config: { kValues: [1], abstainThreshold: 0 },
      outcomes,
      metrics,
    };

    const json = buildBenchmarkJson(result, {
      contractHash: "sha256:fixture",
      generatedAtUtc: "2026-09-24T00:00:00.000Z",
    });

    expect(json.corpusVersion).toBe("0.0.0-test");
    expect(json.contractHash).toBe("sha256:fixture");
    expect(json.generatedAtUtc).toBe("2026-09-24T00:00:00.000Z");
    expect(json.cases["qx"]?.rankedIds).toEqual(["e1"]);
    expect(json.metrics.perQuery).toHaveLength(1);
    expect(json.measuredMisses).toEqual([]);
    expect(JSON.stringify(json)).not.toContain("latencyNs");
  });
});
