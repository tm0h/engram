import { describe, expect, it } from "vite-plus/test";
import { ContractCorpusAdapter } from "../../src/benchmark/adapter.js";
import { runBenchmark } from "../../src/benchmark/runner.js";
import type { EvaluateFn } from "../../src/benchmark/types.js";
import type { Engram } from "../../src/domain.js";
import { evaluateCase, loadFixtureLoaded, steppingClock, TEST_CONFIG } from "./helpers.js";

const fixtureInput = () => new ContractCorpusAdapter(loadFixtureLoaded()).toRunInput();

/** Hand-computed rankings for the pinned procedure over searchEngrams
 * (arithmetic in fixtures/README.md). Id shorthand:
 * aa=superseded webpack build, ab=esbuild build, ac/ad=cache pair,
 * ae=expired tls, af=renewed tls, ag=sitemap target, ah=sitemap
 * distractor, ai=superseded sitemap. */
const EXPECTED_RANKINGS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["case-abstention-01", []],
  ["case-ambiguity-01", ["01js9x5e0000000000000000ac", "01js9x5e0000000000000000ad"]],
  ["case-ambiguity-02", ["01js9x5e0000000000000000ac", "01js9x5e0000000000000000ad"]],
  ["case-distractors-01", ["01js9x5e0000000000000000ah", "01js9x5e0000000000000000ag"]],
  ["case-exact-facts-01", ["0001"]],
  ["case-paraphrase-01", ["0002"]],
  ["case-superseded-01", ["01js9x5e0000000000000000ab"]],
  ["case-superseded-02", ["01js9x5e0000000000000000ab"]],
  ["case-temporal-01", ["01js9x5e0000000000000000af"]],
  ["case-temporal-02", ["01js9x5e0000000000000000ae", "01js9x5e0000000000000000af"]],
];

describe("runBenchmark over the benchmark-internal fixture", () => {
  it("produces the hand-computed rankings via the injected evaluate fn", () => {
    const input = fixtureInput();
    const result = runBenchmark(evaluateCase, input, TEST_CONFIG, {
      clock: steppingClock(),
    });
    const byId = new Map(result.outcomes.map((o) => [o.queryId, o] as const));
    for (const [id, ranked] of EXPECTED_RANKINGS) {
      expect([...(byId.get(id)?.rankedIds ?? [])]).toEqual(ranked);
    }
    const ids = result.outcomes.map((o) => o.queryId);
    expect(ids).toEqual([...ids].sort());
  });

  it("every fixture case passes under the pinned procedure", () => {
    const input = fixtureInput();
    const result = runBenchmark(evaluateCase, input, TEST_CONFIG, {
      clock: steppingClock(),
    });
    expect(result.metrics.passedCount).toBe(10);
    expect(result.metrics.passRate).toBe(1);
    expect(
      result.metrics.categoryMetrics.every((c) => c.passRate === null || c.passRate === 1),
    ).toBe(true);
  });

  it("derives the stale count from lifecycle at the case instant", () => {
    const input = fixtureInput();
    const result = runBenchmark(evaluateCase, input, TEST_CONFIG, {
      clock: steppingClock(),
    });
    // case-temporal-02 returns ae (expired 2026-03-01) at now 2026-03-15
    // under includeInactive: exactly one stale returned row.
    expect(result.metrics.staleReturned).toBe(1);
    expect(result.metrics.totalReturned).toBe(13);
    expect(result.metrics.staleRate).toBe(1 / 13);
    const temporal2 = result.metrics.perQuery.find((q) => q.queryId === "case-temporal-02");
    expect(temporal2?.staleReturned).toBe(1);
    const sup1 = result.metrics.perQuery.find((q) => q.queryId === "case-superseded-01");
    expect(sup1?.staleReturned).toBe(0); // aa filtered before scoring
  });

  it("feeds corpus engrams to the evaluate fn sorted id-ascending (mixed shapes)", () => {
    const input = fixtureInput();
    let seen: ReadonlyArray<string> = [];
    const spy: EvaluateFn = (engrams) => {
      if (seen.length === 0) seen = engrams.map((e) => e.id);
      return [];
    };
    runBenchmark(spy, input, TEST_CONFIG, { clock: steppingClock() });
    expect([...seen]).toEqual(input.entries.map((e) => e.id).sort());
    // both id shapes present; legacy ids sort first by codepoint
    expect(seen[0]).toBe("0001");
    expect(seen[1]).toBe("0002");
    expect(seen[2]).toBe("01js9x5e0000000000000000aa");
  });

  it("is deterministic: two fresh runs produce identical bytes", () => {
    const input = fixtureInput();
    const evaluate = evaluateCase;
    const a = runBenchmark(evaluate, input, TEST_CONFIG, { clock: steppingClock() });
    const b = runBenchmark(evaluate, input, TEST_CONFIG, { clock: steppingClock() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("measures latency through the injected clock only", () => {
    const input = fixtureInput();
    const stepped = runBenchmark(evaluateCase, input, TEST_CONFIG, {
      clock: steppingClock(10),
    });
    for (const o of stepped.outcomes) expect(o.latencyNs).toBe(10);
    const zeroed = runBenchmark(evaluateCase, input, TEST_CONFIG, {
      clock: () => 5n,
    });
    for (const o of zeroed.outcomes) expect(o.latencyNs).toBe(0);
  });

  it("default clock yields structurally valid latency (never scored)", () => {
    const input = fixtureInput();
    const result = runBenchmark(evaluateCase, input, TEST_CONFIG);
    for (const o of result.outcomes) {
      expect(Number.isInteger(o.latencyNs)).toBe(true);
      expect(o.latencyNs).toBeGreaterThanOrEqual(0);
    }
    const { metrics } = result;
    expect(metrics.latencyP50 ?? 0).toBeLessThanOrEqual(metrics.latencyP95 ?? 0);
    expect(metrics.latencyP95 ?? 0).toBeLessThanOrEqual(metrics.latencyP99 ?? 0);
  });

  it("keeps abstainThreshold inert in the id-only path (turn-1 ruling Q1)", () => {
    const input = fixtureInput();
    const evaluate = evaluateCase;
    const a = runBenchmark(
      evaluate,
      input,
      { ...TEST_CONFIG, abstainThreshold: 0 },
      {
        clock: steppingClock(),
      },
    );
    const b = runBenchmark(
      evaluate,
      input,
      { ...TEST_CONFIG, abstainThreshold: 0.75 },
      {
        clock: steppingClock(),
      },
    );
    expect(JSON.stringify(a.outcomes)).toBe(JSON.stringify(b.outcomes));
    expect(a.config.abstainThreshold).toBe(0);
    expect(b.config.abstainThreshold).toBe(0.75);
  });

  it("sums rendered chars over returned entries per case and in total", () => {
    const input = fixtureInput();
    const result = runBenchmark(evaluateCase, input, TEST_CONFIG, {
      clock: steppingClock(),
    });
    // Verified render lengths (title\nbody\ntags):
    //   0001:77 0002:76 aa:80 ab:68 ac:52 ad:64 ae:92 af:87 ag:78 ah:73 ai:84
    // per case: exact 77, paraphrase 76, sup-01/02 68 each, temp-01 87,
    // temp-02 92+87=179, ambiguity 52+64=116 each, distractors 73+78=151,
    // abstention 0. total = 938.
    const chars: Record<string, number> = {
      "case-exact-facts-01": 77,
      "case-paraphrase-01": 76,
      "case-superseded-01": 68,
      "case-superseded-02": 68,
      "case-temporal-01": 87,
      "case-temporal-02": 179,
      "case-ambiguity-01": 116,
      "case-ambiguity-02": 116,
      "case-distractors-01": 151,
      "case-abstention-01": 0,
    };
    for (const q of result.metrics.perQuery) {
      expect(q.renderedChars).toBe(chars[q.queryId]!);
    }
    expect(result.metrics.renderedCharsTotal).toBe(938);
  });

  it("counts unknown returned ids as returned but never stale, forbidden-hit, or rendered", () => {
    const input = fixtureInput();
    const ghostEngram: Engram = {
      id: "ghost",
      title: "Ghost",
      type: "note",
      tags: [],
      scope: "project",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      author: undefined,
      pinned: false,
      body: "",
      path: "engrams/ghost.md",
    };
    const ghost: EvaluateFn = (engrams, c, defaultNowMs) => {
      const base = evaluateCase(engrams, c, defaultNowMs);
      return c.id === "case-exact-facts-01" ? [{ engram: ghostEngram, score: 1 }, ...base] : base;
    };
    const result = runBenchmark(ghost, input, TEST_CONFIG, { clock: steppingClock() });
    const row = result.metrics.perQuery.find((q) => q.queryId === "case-exact-facts-01");
    expect(row?.returned).toBe(2); // ghost + 0001
    expect(row?.renderedChars).toBe(77); // 0001 only; ghost renders 0
    expect(row?.staleReturned).toBe(0);
    expect(row?.passed).toBe(true); // required 0001 present, ghost harmless
    expect(result.metrics.totalReturned).toBe(14); // 13 + ghost
  });

  it("validates config and input before running", () => {
    const input = fixtureInput();
    const evaluate = evaluateCase;
    expect(() => runBenchmark(evaluate, input, { ...TEST_CONFIG, kValues: [0] })).toThrow(
      RangeError,
    );
    expect(() =>
      runBenchmark(
        evaluate,
        { ...input, queries: [...input.queries, ...input.queries.slice(0, 1)] },
        TEST_CONFIG,
      ),
    ).toThrow(/duplicate case id/);
    expect(() =>
      runBenchmark(
        evaluate,
        { ...input, entries: [...input.entries, ...input.entries.slice(0, 1)] },
        TEST_CONFIG,
      ),
    ).toThrow(/duplicate entry id/);
  });
});
