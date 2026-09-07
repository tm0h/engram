/**
 * ENG-18 shadow comparison and latency harness.
 *
 * Two responsibilities, both measurement-only:
 *
 * 1. `runShadowComparison` runs the production evaluation seam (the wired
 *    BM25 ranker) and the retained legacy ranker (`evaluateCaseLegacy`,
 *    the pre-ENG-18 fixed-points ranker) over the SAME corpus input via
 *    the real `runBenchmark`, and classifies every case: improved
 *    (legacy miss -> live pass), regressed (legacy pass -> live miss),
 *    reordered (same outcome, different ranking), unchanged. This is the
 *    evidence artifact for the ENG-18 acceptance item "golden-corpus
 *    accuracy improvement without increased forbidden or stale hits" and
 *    for the D3 evidence-first baseline sequencing.
 *
 * 2. `measureRankerLatency` measures per-query latency of BOTH rankers
 *    over the same input with the runner's clock seam: a configurable
 *    number of odd runs after a warmup run, nearest-rank percentiles per
 *    run, medians across runs (the D1 protocol: median of >= 7 runs after
 *    one warmup, both rankers in the same harness). Latency is REPORTED,
 *    never scored, and never enters the baseline gate.
 *
 * Not exported from packages/core/src/index.ts: benchmark scaffold, must
 * not affect the CLI bundle. The direct-invocation CLI lives in
 * benchmark/shadow-cli.ts and never writes into the repo tree.
 */
import type { Engram } from "../domain.js";
import { parseTimestamp } from "../util.js";
import { searchEngramsLegacy } from "../search.js";
import { evaluateCase } from "@engram/core/corpus";
import type { CorpusCase } from "@engram/core/corpus";
import { byIdAsc, percentileNearestRank } from "./metrics.js";
import { runBenchmark } from "./runner.js";
import type { BenchmarkResult, EvaluateFn, RunConfig, RunInput } from "./types.js";

/** The pre-ENG-18 evaluation seam: `evaluateCase`'s pinned procedure over
 * `searchEngramsLegacy` (scope filter, includeInactive, fixed per-case
 * instant). Used as the "before" side of the shadow comparison; the
 * production `evaluateCase` is the "after" side. */
export const evaluateCaseLegacy: EvaluateFn = (
  engrams: ReadonlyArray<Engram>,
  c: CorpusCase,
  defaultNowMs?: number,
) => {
  const scoped = engrams.filter((e) => e.scope === c.scope);
  const fromCase = c.now !== undefined ? parseTimestamp(c.now) : undefined;
  const nowMs = fromCase ?? defaultNowMs;
  if (nowMs === undefined) {
    throw new Error(`case ${c.id} has no fixed timestamp; refusing to read the wall clock`);
  }
  return searchEngramsLegacy(scoped, c.query, c.limit, {
    includeInactive: c.includeInactive ?? false,
    now: nowMs,
  });
};

/** Per-side outcome row for one case (id + the fields the acceptance
 * cares about; latency deliberately excluded). */
export interface ShadowSideRow {
  readonly passed: boolean;
  readonly rankedIds: ReadonlyArray<string>;
  readonly returned: number;
  readonly staleReturned: number;
  readonly forbiddenReturned: number;
  readonly reciprocalRank: number | null;
}

export type ShadowOutcome = "improved" | "regressed" | "reordered" | "unchanged";

export interface ShadowCaseDelta {
  readonly queryId: string;
  readonly outcome: ShadowOutcome;
  readonly before: ShadowSideRow;
  readonly after: ShadowSideRow;
}

export interface ShadowTotals {
  readonly passBefore: number;
  readonly passAfter: number;
  readonly forbiddenBefore: number;
  readonly forbiddenAfter: number;
  readonly staleBefore: number;
  readonly staleAfter: number;
  readonly mrrBefore: number | null;
  readonly mrrAfter: number | null;
}

export interface ShadowComparison {
  readonly totals: ShadowTotals;
  readonly deltas: ReadonlyArray<ShadowCaseDelta>;
  readonly improved: ReadonlyArray<string>;
  readonly regressed: ReadonlyArray<string>;
  readonly reordered: ReadonlyArray<string>;
}

function sideRow(result: BenchmarkResult, queryId: string): ShadowSideRow {
  const outcome = result.outcomes.find((o) => o.queryId === queryId);
  const metrics = result.metrics.perQuery.find((q) => q.queryId === queryId);
  if (outcome === undefined || metrics === undefined) {
    throw new Error(`shadow: missing outcome or metrics row for case ${queryId}`);
  }
  return {
    passed: metrics.passed,
    rankedIds: outcome.rankedIds,
    returned: metrics.returned,
    staleReturned: metrics.staleReturned,
    forbiddenReturned: metrics.forbiddenReturned,
    reciprocalRank: metrics.reciprocalRank,
  };
}

const meanRank = (result: BenchmarkResult): number | null => {
  const rrs = result.metrics.perQuery
    .map((q) => q.reciprocalRank)
    .filter((rr): rr is number => rr !== null);
  if (rrs.length === 0) return null;
  return rrs.reduce((a, b) => a + b, 0) / rrs.length;
};

/** Classify one case from its two side rows (see module docblock). */
function classify(before: ShadowSideRow, after: ShadowSideRow): ShadowOutcome {
  if (!before.passed && after.passed) return "improved";
  if (before.passed && !after.passed) return "regressed";
  return before.rankedIds.join("\u0000") === after.rankedIds.join("\u0000")
    ? "unchanged"
    : "reordered";
}

/** Run both rankers over one input and classify every case. The "after"
 * side is the production `evaluateCase` (the same import the benchmark
 * command wires), so the comparison is exactly legacy-vs-wired. */
export function runShadowComparison(
  input: RunInput,
  config: RunConfig,
  options: { clock?: () => bigint } = {},
): ShadowComparison {
  const clock = options.clock;
  const before = runBenchmark(evaluateCaseLegacy, input, config, clock ? { clock } : {});
  const after = runBenchmark(evaluateCase, input, config, clock ? { clock } : {});

  const ids = [...before.outcomes].map((o) => o.queryId).sort(byIdAsc);
  const deltas = ids.map((queryId) => {
    const b = sideRow(before, queryId);
    const a = sideRow(after, queryId);
    return { queryId, outcome: classify(b, a), before: b, after: a };
  });
  const pick = (outcome: ShadowOutcome): string[] =>
    deltas.filter((d) => d.outcome === outcome).map((d) => d.queryId);

  return {
    totals: {
      passBefore: before.metrics.passedCount,
      passAfter: after.metrics.passedCount,
      forbiddenBefore: before.metrics.forbiddenReturned,
      forbiddenAfter: after.metrics.forbiddenReturned,
      staleBefore: before.metrics.staleReturned,
      staleAfter: after.metrics.staleReturned,
      mrrBefore: meanRank(before),
      mrrAfter: meanRank(after),
    },
    deltas,
    improved: pick("improved"),
    regressed: pick("regressed"),
    reordered: pick("reordered"),
  };
}

// (the production seam import lives at the top of the module)

/* ------------------------------------------------------------------ */
/* Latency (D1): reported, never scored.                               */
/* ------------------------------------------------------------------ */

export interface LatencyStats {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface LatencyMeasurement {
  /** Median across runs, per percentile. */
  readonly median: LatencyStats;
  /** Per-run percentiles in execution order. */
  readonly runs: ReadonlyArray<LatencyStats>;
  readonly runsRequested: number;
  readonly warmupRuns: number;
}

function runStats(result: BenchmarkResult): LatencyStats {
  const ms = (p: number): number =>
    (percentileNearestRank(result.metrics.latencySamplesNs, p) ?? 0) / 1e6;
  return { p50Ms: ms(50), p95Ms: ms(95), p99Ms: ms(99) };
}

function medianOf(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) / 2] as number;
}

/** Measure one evaluate fn: `warmup` unmeasured runs (default 1), then
 * `runs` measured runs (odd, >= 1: the median needs a middle). Latency is
 * measured with the runner's clock seam (default hrtime), never scored. */
export function measureRankerLatency(
  evaluate: EvaluateFn,
  input: RunInput,
  config: RunConfig,
  options: { runs?: number; warmup?: number; clock?: () => bigint } = {},
): LatencyMeasurement {
  const runs = options.runs ?? 7;
  if (!Number.isInteger(runs) || runs < 1 || runs % 2 === 0) {
    throw new RangeError(`shadow: runs must be an odd positive integer, got ${runs}`);
  }
  const warmup = options.warmup ?? 1;
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new RangeError(`shadow: warmup must be a nonnegative integer, got ${warmup}`);
  }
  const clock = options.clock;
  for (let i = 0; i < warmup; i++) {
    runBenchmark(evaluate, input, config, clock ? { clock } : {});
  }
  const perRun: LatencyStats[] = [];
  for (let i = 0; i < runs; i++) {
    perRun.push(runStats(runBenchmark(evaluate, input, config, clock ? { clock } : {})));
  }
  return {
    median: {
      p50Ms: medianOf(perRun.map((r) => r.p50Ms)),
      p95Ms: medianOf(perRun.map((r) => r.p95Ms)),
      p99Ms: medianOf(perRun.map((r) => r.p99Ms)),
    },
    runs: perRun,
    runsRequested: runs,
    warmupRuns: warmup,
  };
}

/* ------------------------------------------------------------------ */
/* The direct-invocation CLI lives in benchmark/shadow-cli.ts (thin     */
/* composition of the tested functions above). This module stays        */
/* import-side-effect free.                                             */
/* ------------------------------------------------------------------ */
