import { describe, expect, it } from "vite-plus/test";
import {
  canonicalizeKValues,
  computeMetrics,
  percentileNearestRank,
  precisionAtK,
  rate,
  recallAtK,
  reciprocalRank,
  round6,
} from "../../src/benchmark/metrics.js";
import type { Engram } from "../../src/domain.js";
import type { QueryCase, QueryOutcome } from "../../src/benchmark/types.js";
import { engram, queryCase } from "./helpers.js";

const outcome = (over: Partial<QueryOutcome> & { queryId: string }): QueryOutcome => ({
  rankedIds: [],
  abstained: true,
  latencyNs: 0,
  renderedChars: 0,
  ...over,
});

const byId = (engrams: ReadonlyArray<Engram>): Map<string, Engram> =>
  new Map(engrams.map((e) => [e.id, e] as const));

describe("recallAtK", () => {
  it("counts relevant ids within the top k", () => {
    // relevant {a,b,c}; top-5 = [a,x,b,c,y] -> |relevant ∩ top-5| = 3 -> 3/3 = 1
    expect(recallAtK(["a", "b", "c"], ["a", "x", "b", "c", "y"], 5)).toBe(1);
    // top-2 = [a,x] -> 1 hit -> 1/3
    expect(recallAtK(["a", "b", "c"], ["a", "x", "b", "c", "y"], 2)).toBe(1 / 3);
  });

  it("counts each relevant id at most once", () => {
    // ranked [a,a]: set intersection |{a} ∩ {a,b}| = 1 -> 1/2, duplicate ignored
    expect(recallAtK(["a", "b"], ["a", "a"], 2)).toBe(1 / 2);
  });

  it("excludes empty-relevant queries by returning null", () => {
    expect(recallAtK([], ["a"], 3)).toBeNull();
  });

  it("rejects k < 1", () => {
    expect(() => recallAtK(["a"], ["a"], 0)).toThrow(RangeError);
  });
});

describe("precisionAtK", () => {
  it("divides by k, never by the number of returned results", () => {
    // relevant {a}; top-3 = [a] -> 1 hit; denominator is k = 3 -> 1/3
    expect(precisionAtK(["a"], ["a"], 3)).toBe(1 / 3);
    // relevant {a,b}; only [a] returned; k = 5 -> 1/5 (not 1/1)
    expect(precisionAtK(["a", "b"], ["a"], 5)).toBe(1 / 5);
  });

  it("excludes empty-relevant queries by returning null", () => {
    expect(precisionAtK([], ["a"], 3)).toBeNull();
  });

  it("rejects k < 1", () => {
    expect(() => precisionAtK(["a"], ["a"], 0)).toThrow(RangeError);
  });
});

describe("reciprocalRank", () => {
  it("returns 1/rank of the first relevant id", () => {
    // first relevant (b) at rank 3 -> 1/3
    expect(reciprocalRank(["b"], ["x", "a", "b", "c"])).toBe(1 / 3);
  });

  it("returns 0 when no relevant id is ranked (still eligible)", () => {
    expect(reciprocalRank(["z"], ["x", "y"])).toBe(0);
  });

  it("excludes empty-relevant queries by returning null", () => {
    expect(reciprocalRank([], ["x"])).toBeNull();
  });
});

describe("rate", () => {
  it("divides numerator by denominator", () => {
    expect(rate(1, 9)).toBe(1 / 9);
    expect(rate(0, 3)).toBe(0);
  });

  it("returns null on a zero denominator instead of Infinity", () => {
    expect(rate(5, 0)).toBeNull();
  });
});

describe("percentileNearestRank", () => {
  it("uses the nearest-rank method: index = ceil(p/100 * N), 1-based", () => {
    // N=4: p50 -> ceil(2.0) = 2 -> 20; p95 -> ceil(3.8) = 4 -> 40; p99 -> 4 -> 40
    expect(percentileNearestRank([10, 20, 30, 40], 50)).toBe(20);
    expect(percentileNearestRank([10, 20, 30, 40], 95)).toBe(40);
    expect(percentileNearestRank([10, 20, 30, 40], 99)).toBe(40);
  });

  it("handles the 100-sample case exactly", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    // p50 -> ceil(50) = 50; p95 -> ceil(95) = 95; p99 -> ceil(99) = 99
    expect(percentileNearestRank(samples, 50)).toBe(50);
    expect(percentileNearestRank(samples, 95)).toBe(95);
    expect(percentileNearestRank(samples, 99)).toBe(99);
  });

  it("sorts internally and never mutates the input", () => {
    const samples = [40, 10, 30, 20];
    expect(percentileNearestRank(samples, 50)).toBe(20);
    expect(samples).toEqual([40, 10, 30, 20]);
  });

  it("returns null for empty samples", () => {
    expect(percentileNearestRank([], 50)).toBeNull();
  });

  it("rejects p outside (0, 100]", () => {
    expect(() => percentileNearestRank([1], 0)).toThrow(RangeError);
    expect(() => percentileNearestRank([1], 101)).toThrow(RangeError);
  });
});

describe("round6", () => {
  it("rounds once to 6 decimal places", () => {
    // 1/9 = 0.111111... -> scaled 111111.11 -> 111111 -> 0.111111
    expect(round6(1 / 9)).toBe(0.111111);
    // 2/3 = 0.666666... -> scaled 666666.67 -> 666667 -> 0.666667
    expect(round6(2 / 3)).toBe(0.666667);
    expect(round6(1)).toBe(1);
  });
});

describe("canonicalizeKValues", () => {
  it("sorts and dedupes k values", () => {
    expect(canonicalizeKValues([5, 1, 3, 1])).toEqual([1, 3, 5]);
  });

  it("rejects non-integers and k < 1", () => {
    expect(() => canonicalizeKValues([0])).toThrow(RangeError);
    expect(() => canonicalizeKValues([1.5])).toThrow(RangeError);
  });
});

describe("computeMetrics", () => {
  /** Shared synthetic corpus for lifecycle tests.
   * e1: explicitly superseded -> inactive at any instant.
   * e2: expired 2026-01-01 -> inactive at NOW_JUN, active at NOW_JAN.
   * e3: no lifecycle metadata -> always active. */
  const e1 = engram({ id: "e1", status: "superseded" });
  const e2 = engram({ id: "e2", expires: "2026-01-01T00:00:00.000Z" });
  const e3 = engram({ id: "e3" });
  const corpus = [e1, e2, e3];
  const NOW_JUN = Date.parse("2026-06-01T00:00:00.000Z");
  const NOW_JAN = Date.parse("2026-01-01T00:00:00.000Z");

  it("derives staleness from lifecycle at the case's fixed instant", () => {
    // Scenario (k = [1]):
    // qa (nowMs = NOW_JUN): required [e1]; ranked [e1, e2].
    //   e1 superseded -> stale; e2 expired 2026-01-01 <= NOW_JUN -> stale.
    //   staleReturned = 2. pass (e1 present, e3 forbidden absent).
    // qb (nowMs = NOW_JAN): required [e2]; ranked [e2].
    //   e2 expires AT NOW_JAN: boundary is inclusive (expires <= now) ->
    //   stale. pass.
    // qc (nowMs = NOW_JAN): required [e3]; ranked [e3].
    //   e3 active -> staleReturned 0. pass.
    const queries: QueryCase[] = [
      queryCase({
        id: "qa",
        query: "a",
        relevantIds: ["e1"],
        forbiddenIds: ["e3"],
        nowMs: NOW_JUN,
      }),
      queryCase({ id: "qb", query: "b", relevantIds: ["e2"], nowMs: NOW_JAN }),
      queryCase({ id: "qc", query: "c", relevantIds: ["e3"], nowMs: NOW_JAN }),
    ];
    const outcomes: QueryOutcome[] = [
      outcome({ queryId: "qa", rankedIds: ["e1", "e2"], abstained: false, latencyNs: 10 }),
      outcome({ queryId: "qb", rankedIds: ["e2"], abstained: false, latencyNs: 10 }),
      outcome({ queryId: "qc", rankedIds: ["e3"], abstained: false, latencyNs: 10 }),
    ];
    const m = computeMetrics(queries, outcomes, [1], byId(corpus));
    const row = (id: string) => m.perQuery.find((q) => q.queryId === id)!;
    expect(row("qa")?.staleReturned).toBe(2);
    expect(row("qa")?.passed).toBe(true);
    expect(row("qb")?.staleReturned).toBe(1); // inclusive boundary: expires <= now
    expect(row("qb")?.passed).toBe(true);
    expect(row("qc")?.staleReturned).toBe(0);
    expect(row("qc")?.passed).toBe(true);
    expect(m.staleReturned).toBe(3);
    expect(m.totalReturned).toBe(4);
    expect(m.staleRate).toBe(3 / 4);
    expect(m.passedCount).toBe(3);
    expect(m.passRate).toBe(1);
  });

  it("treats unknown returned ids as returned but never stale or forbidden-hit", () => {
    // ghost is not in the corpus map: counts toward returned, no lifecycle.
    const queries: QueryCase[] = [
      queryCase({ id: "qa", query: "a", relevantIds: ["e3"], nowMs: NOW_JUN }),
    ];
    const outcomes: QueryOutcome[] = [
      outcome({ queryId: "qa", rankedIds: ["e3", "ghost"], abstained: false, latencyNs: 5 }),
    ];
    const m = computeMetrics(queries, outcomes, [1], byId(corpus));
    expect(m.perQuery[0]?.staleReturned).toBe(0);
    expect(m.totalReturned).toBe(2);
    expect(m.passedCount).toBe(1);
  });

  it("computes contract pass/fail with hand-checked arithmetic", () => {
    // qa: required [e3], forbidden [e1]; ranked [e1, e3].
    //   required present yes; FORBIDDEN e1 present -> FAIL.
    // qb: required [e3]; ranked [e3] -> PASS.
    // qc (abstention): ranked [] -> PASS.
    // qd (abstention): ranked [e3] -> FAIL (expected empty).
    const queries: QueryCase[] = [
      queryCase({
        id: "qa",
        query: "a",
        relevantIds: ["e3"],
        forbiddenIds: ["e1"],
        nowMs: NOW_JUN,
      }),
      queryCase({ id: "qb", query: "b", relevantIds: ["e3"], nowMs: NOW_JUN }),
      queryCase({
        id: "qc",
        query: "c",
        category: "abstention",
        expectAbstain: true,
        nowMs: NOW_JUN,
      }),
      queryCase({
        id: "qd",
        query: "d",
        category: "abstention",
        expectAbstain: true,
        nowMs: NOW_JUN,
      }),
    ];
    const outcomes: QueryOutcome[] = [
      outcome({ queryId: "qa", rankedIds: ["e1", "e3"], abstained: false, latencyNs: 10 }),
      outcome({ queryId: "qb", rankedIds: ["e3"], abstained: false, latencyNs: 10 }),
      outcome({ queryId: "qc", rankedIds: [], abstained: true, latencyNs: 10 }),
      outcome({ queryId: "qd", rankedIds: ["e3"], abstained: false, latencyNs: 10 }),
    ];
    const m = computeMetrics(queries, outcomes, [1], byId(corpus));
    const row = (id: string) => m.perQuery.find((q) => q.queryId === id)!;
    expect(row("qa")?.passed).toBe(false);
    expect(row("qb")?.passed).toBe(true);
    expect(row("qc")?.passed).toBe(true);
    expect(row("qd")?.passed).toBe(false);
    // qa and qd fail; qb and qc pass. supportingIds never affect pass/fail.
    expect(m.passedCount).toBe(2);
    expect(m.passRate).toBe(2 / 4);
  });

  it("aggregates per category over the 10 fixed contract rows", () => {
    // qa exact-facts pass; qd distractors fail; all other categories empty.
    const queries: QueryCase[] = [
      queryCase({ id: "qa", query: "a", relevantIds: ["e3"], nowMs: NOW_JUN }),
      queryCase({
        id: "qd",
        query: "d",
        category: "distractors",
        relevantIds: ["e3"],
        nowMs: NOW_JUN,
      }),
    ];
    const outcomes: QueryOutcome[] = [
      outcome({ queryId: "qa", rankedIds: ["e3"], abstained: false, latencyNs: 10 }),
      outcome({ queryId: "qd", rankedIds: ["e1"], abstained: false, latencyNs: 10 }),
    ];
    const m = computeMetrics(queries, outcomes, [1], byId(corpus));
    expect(m.categoryMetrics.map((c) => c.category)).toEqual([
      "exact-facts",
      "paraphrase",
      "code-identifiers",
      "multi-token",
      "subsystem-paths",
      "superseded",
      "temporal",
      "ambiguity",
      "distractors",
      "abstention",
    ]);
    const row = (cat: string) => m.categoryMetrics.find((c) => c.category === cat)!;
    expect(row("exact-facts")).toEqual({
      category: "exact-facts",
      cases: 1,
      passed: 1,
      passRate: 1,
    });
    expect(row("distractors")!.cases).toBe(1);
    expect(row("distractors")!.passed).toBe(0);
    expect(row("distractors")!.passRate).toBe(0);
    expect(row("paraphrase")).toEqual({
      category: "paraphrase",
      cases: 0,
      passed: 0,
      passRate: null,
    });
  });

  it("computes falseAbstainRate over non-abstention cases only", () => {
    // qa (non-abstention) abstains -> false abstain. qb abstains correctly
    // (abstention cases are never counted here). qd (non-abstention)
    // returns results. -> 1 false abstain of the 2 non-abstention cases
    // (qa, qd) -> 1/2.
    const queries: QueryCase[] = [
      queryCase({ id: "qa", query: "a", relevantIds: ["e3"], nowMs: NOW_JUN }),
      queryCase({
        id: "qb",
        query: "b",
        category: "abstention",
        expectAbstain: true,
        nowMs: NOW_JUN,
      }),
      queryCase({
        id: "qd",
        query: "d",
        category: "distractors",
        relevantIds: ["e3"],
        nowMs: NOW_JUN,
      }),
    ];
    const outcomes: QueryOutcome[] = [
      outcome({ queryId: "qa", rankedIds: [], abstained: true, latencyNs: 10 }),
      outcome({ queryId: "qb", rankedIds: [], abstained: true, latencyNs: 10 }),
      outcome({ queryId: "qd", rankedIds: ["e3"], abstained: false, latencyNs: 10 }),
    ];
    const m = computeMetrics(queries, outcomes, [1], byId(corpus));
    expect(m.falseAbstainCases).toBe(1);
    // non-abstention cases are qa and qd (qb IS abstention): 1 of 2
    expect(m.falseAbstainRate).toBe(1 / 2);
    expect(m.abstentionEligible).toBe(1);
    expect(m.abstentionCorrect).toBe(1);
    expect(m.abstentionAccuracy).toBe(1);
  });

  it("reports null aggregates when nothing is eligible or nothing is returned", () => {
    const queries: QueryCase[] = [queryCase({ id: "qx", query: "x", nowMs: NOW_JUN })];
    const outcomes: QueryOutcome[] = [outcome({ queryId: "qx", rankedIds: [], abstained: true })];
    const m = computeMetrics(queries, outcomes, [1], byId(corpus));
    expect(m.eligibleCount).toBe(0);
    expect(m.kMetrics[0]?.recall).toBeNull();
    expect(m.kMetrics[0]?.precision).toBeNull();
    expect(m.mrr).toBeNull();
    expect(m.totalReturned).toBe(0);
    expect(m.staleRate).toBeNull();
    expect(m.forbiddenRate).toBeNull();
    expect(m.passRate).toBe(1); // the vacuous non-abstention case passes
    expect(m.falseAbstainCases).toBe(1); // qx is non-abstention but abstained
    expect(m.falseAbstainRate).toBe(1);
  });

  it("guards falseAbstainRate with a null when no non-abstention cases exist", () => {
    const queries: QueryCase[] = [
      queryCase({
        id: "qc",
        query: "c",
        category: "abstention",
        expectAbstain: true,
        nowMs: NOW_JUN,
      }),
    ];
    const outcomes: QueryOutcome[] = [
      outcome({ queryId: "qc", rankedIds: [], abstained: true, latencyNs: 10 }),
    ];
    const m = computeMetrics(queries, outcomes, [1], byId(corpus));
    expect(m.falseAbstainRate).toBeNull();
  });

  it("rejects duplicate query cases and orphan outcomes", () => {
    const dup = queryCase({ id: "qa", query: "a", relevantIds: ["e3"], nowMs: NOW_JUN });
    expect(() => computeMetrics([dup, dup], [], [1], byId(corpus))).toThrow(/duplicate case id/);
    const solo = queryCase({ id: "q1", query: "a", relevantIds: ["e3"], nowMs: NOW_JUN });
    const oc = outcome({ queryId: "ghost" });
    expect(() => computeMetrics([solo], [oc], [1], byId(corpus))).toThrow(/without a query case/);
  });

  it("rejects missing outcomes: every case needs exactly one (finding 4)", () => {
    // Leader probe MISSING scenario: two cases, only qa's outcome supplied.
    // qb's measured result must not silently vanish from queryCount/passRate.
    const queries: QueryCase[] = [
      queryCase({ id: "qa", query: "a", relevantIds: ["e3"], nowMs: NOW_JUN }),
      queryCase({ id: "qb", query: "b", relevantIds: ["e3"], nowMs: NOW_JUN }),
    ];
    const outcomes: QueryOutcome[] = [
      outcome({ queryId: "qa", rankedIds: ["e3"], abstained: false, latencyNs: 10 }),
    ];
    expect(() => computeMetrics(queries, outcomes, [1], byId(corpus))).toThrow(
      /missing outcome for case qb/,
    );
  });

  it("rejects duplicate outcomes: one id may not count twice (finding 4)", () => {
    // Leader probe DUPLICATE scenario: qa's outcome supplied twice, qb absent.
    const queries: QueryCase[] = [
      queryCase({ id: "qa", query: "a", relevantIds: ["e3"], nowMs: NOW_JUN }),
      queryCase({ id: "qb", query: "b", relevantIds: ["e3"], nowMs: NOW_JUN }),
    ];
    const oc = outcome({ queryId: "qa", rankedIds: ["e3"], abstained: false, latencyNs: 10 });
    expect(() => computeMetrics(queries, [oc, oc], [1], byId(corpus))).toThrow(
      /duplicate outcome for case qa/,
    );
  });

  it("pins deterministic check order: duplicate wins before orphan when sorted first", () => {
    // Sorted outcome order is [qa, qa, ghost]; the duplicate is detected
    // before the orphan because checks run in sorted order (doubly-bad
    // input must fail deterministically).
    const queries: QueryCase[] = [
      queryCase({ id: "qa", query: "a", relevantIds: ["e3"], nowMs: NOW_JUN }),
    ];
    const outcomes: QueryOutcome[] = [
      outcome({ queryId: "qa", rankedIds: ["e3"], abstained: false }),
      outcome({ queryId: "qa", rankedIds: ["e3"], abstained: false }),
      outcome({ queryId: "ghost", rankedIds: [], abstained: true }),
    ];
    expect(() => computeMetrics(queries, outcomes, [1], byId(corpus))).toThrow(
      /duplicate outcome for case qa/,
    );
  });

  it("pins exact 1:1 arithmetic: two cases, one pass one fail (finding 4 probe case D)", () => {
    // The reference the corrupted runs got wrong: 1:1 input must yield
    // queryCount 2 and passRate 1/2 (not queryCount 1, passRate 1).
    const queries: QueryCase[] = [
      queryCase({ id: "qa", query: "a", relevantIds: ["e3"], nowMs: NOW_JUN }),
      queryCase({ id: "qb", query: "b", relevantIds: ["e3"], nowMs: NOW_JUN }),
    ];
    const outcomes: QueryOutcome[] = [
      outcome({ queryId: "qa", rankedIds: ["e3"], abstained: false, latencyNs: 10 }),
      outcome({ queryId: "qb", rankedIds: [], abstained: true, latencyNs: 10 }),
    ];
    const m = computeMetrics(queries, outcomes, [1], byId(corpus));
    expect(m.queryCount).toBe(2);
    expect(m.passedCount).toBe(1);
    expect(m.passRate).toBe(1 / 2);
  });
});
