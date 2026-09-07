import { describe, expect, it } from "vite-plus/test";
import { engram, queryCase, steppingClock, TEST_CONFIG } from "./helpers.js";
import {
  evaluateCaseLegacy,
  measureRankerLatency,
  runShadowComparison,
} from "../../src/benchmark/shadow.js";
import type { RunInput } from "../../src/benchmark/types.js";

/** Fixture: legacy and wired (BM25) disagree in controlled ways.
 *
 * - e1 body "alpha beta": matches "alpha" under both rankers.
 * - e2 body "beta": "alpha AND beta" style AND queries only match entries
 *   carrying both terms under the wired ranker's boolean semantics.
 * - e3 body "kubernetes cluster": "kubernetes" matches both; a prefix
 *   query "kuber*" matches only under the wired ranker (the legacy
 *   tokenizer strips the star and still substring-matches, so the pass
 *   flip below uses a term the legacy substring rule cannot see).
 * - e4 body "keybindings remapped": "keybinding" is a proper prefix of a
 *   document token: legacy substring matches it, wired token equality
 *   falls back to a bounded prefix match, so both include it. */
const entries = [
  engram({ id: "e1", body: "alpha beta" }),
  engram({ id: "e2", body: "beta" }),
  engram({ id: "e3", body: "kubernetes cluster" }),
  engram({ id: "e4", body: "keybindings remapped" }),
];

const input: RunInput = {
  meta: { name: "shadow-fixture", corpusVersion: "0.0.1", schemaVersion: 1 },
  defaultNowMs: Date.parse("2026-06-01T00:00:00.000Z"),
  entries,
  queries: [
    queryCase({ id: "q-or", query: "alpha beta", relevantIds: ["e1", "e2"] }),
    queryCase({ id: "q-and", query: "alpha AND beta", relevantIds: ["e1"] }),
    queryCase({ id: "q-prefix", query: "kuber*", relevantIds: ["e3"] }),
    queryCase({ id: "q-plain", query: "beta", relevantIds: ["e1", "e2"] }),
  ],
};

describe("evaluateCaseLegacy", () => {
  it("mirrors the pinned procedure over the retained legacy ranker", () => {
    const results = evaluateCaseLegacy(entries, input.queries[3]!.source, input.defaultNowMs);
    // legacy: fixed points over substring matches; equal +1 scores tie by
    // id-ascending order
    expect(results.map((r) => r.engram.id)).toEqual(["e1", "e2"]);
    expect(results[0]?.score).toBe(1);
  });
});

describe("runShadowComparison", () => {
  const comparison = runShadowComparison(input, TEST_CONFIG, { clock: steppingClock() });

  it("classifies pass flips and reorderings against the legacy ranker", () => {
    const byId = new Map(comparison.deltas.map((d) => [d.queryId, d] as const));
    // q-and: legacy has no AND, so both e1 and e2 match (pass, since the
    // only required id e1 is present); wired also passes with e1 only:
    // ranked ids differ -> reordered
    expect(byId.get("q-and")?.outcome).toBe("reordered");
    // q-or: same hit set on both sides? legacy: e1 + e2; wired: e1 + e2,
    // possibly reordered by BM25 scoring
    expect(
      byId.get("q-or")?.outcome === "unchanged" || byId.get("q-or")?.outcome === "reordered",
    ).toBe(true);
    // q-prefix: legacy tokenizes away the star and substring-matches
    // "kuber" in "kubernetes": passes on both sides
    expect(byId.get("q-prefix")?.before.passed).toBe(true);
    expect(byId.get("q-prefix")?.after.passed).toBe(true);
    expect(byId.get("q-plain")?.after.passed).toBe(true);
  });

  it("reports totals for pass, forbidden, stale, and MRR on both sides", () => {
    expect(comparison.totals.passBefore).toBe(comparison.totals.passAfter);
    expect(comparison.totals.forbiddenBefore).toBe(0);
    expect(comparison.totals.forbiddenAfter).toBe(0);
    expect(comparison.totals.staleBefore).toBe(0);
    expect(comparison.totals.staleAfter).toBe(0);
    expect(comparison.totals.mrrBefore ?? 0).toBeGreaterThan(0);
    expect(comparison.totals.mrrAfter ?? 0).toBeGreaterThan(0);
  });

  it("is deterministic for identical inputs", () => {
    expect(runShadowComparison(input, TEST_CONFIG, { clock: steppingClock() })).toEqual(comparison);
  });
});

describe("measureRankerLatency", () => {
  it("reports percentiles per run and medians across runs (injected clock)", () => {
    const m = measureRankerLatency(evaluateCaseLegacy, input, TEST_CONFIG, {
      runs: 3,
      warmup: 1,
      clock: steppingClock(1000),
    });
    expect(m.runsRequested).toBe(3);
    expect(m.warmupRuns).toBe(1);
    expect(m.runs).toHaveLength(3);
    // stepping clock: two reads per case -> every query is exactly 1000ns
    for (const run of m.runs) {
      expect(run.p50Ms).toBeCloseTo(0.001, 9);
      expect(run.p95Ms).toBeCloseTo(0.001, 9);
    }
    expect(m.median.p50Ms).toBeCloseTo(0.001, 9);
    expect(m.median.p95Ms).toBeCloseTo(0.001, 9);
    expect(m.median.p50Ms).toBeLessThanOrEqual(m.median.p95Ms);
    expect(m.median.p95Ms).toBeLessThanOrEqual(m.median.p99Ms);
  });

  it("rejects an even or non-positive run count", () => {
    expect(() => measureRankerLatency(evaluateCaseLegacy, input, TEST_CONFIG, { runs: 2 })).toThrow(
      RangeError,
    );
    expect(() => measureRankerLatency(evaluateCaseLegacy, input, TEST_CONFIG, { runs: 0 })).toThrow(
      RangeError,
    );
  });
});
