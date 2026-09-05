/**
 * Pure metric functions for the ENG-8 retrieval benchmark.
 *
 * Exact definitions (locked turn 1, extended turn 2):
 * - Recall@k = |relevant ∩ top-k| / |relevant|; relevant = requiredIds
 * - Precision@k = |relevant ∩ top-k| / k  (denominator is k, never the
 *   number of returned results)
 * - RR = 1/rank of the first relevant id, 0 when absent
 * - Recall/Precision/MRR aggregate only over eligible queries (non-empty
 *   relevantIds)
 * - contract pass/fail per case: every requiredIds id present, no
 *   forbiddenIds id present, abstention cases return zero results;
 *   supportingIds carry no assertion
 * - passRate = passed / cases; per-category counts/rates over the 10 fixed
 *   contract categories
 * - falseAbstainRate = non-abstention cases returning zero results /
   non-abstention cases
 * - stale rate = staleReturned / totalReturned where a returned id is stale
 *   iff effectiveStatus(engram, case nowMs) != "active" (lifecycle-derived;
 *   the contract has no per-case stale marker)
 * - forbidden rate = forbiddenReturned / totalReturned
 * - abstention accuracy = correct abstentions / abstention-eligible queries
 *   (expectAbstain = true; abstain = empty ranking)
 * - latency percentiles use the nearest-rank method on sorted samples
 *
 * Every value here is a single division, so IEEE doubles carry full
 * precision end to end; rounding happens once at report render time
 * (round6, 6 decimal places), never mid-pipeline.
 */
import { effectiveStatus, type Engram } from "../domain.js";
import {
  CORPUS_CATEGORIES,
  type CategoryMetric,
  type KAggregate,
  type MetricReport,
  type QueryCase,
  type QueryMetrics,
  type QueryOutcome,
} from "./types.js";

/** Round once, to 6 decimal places. All benchmark metrics are non-negative,
 * so Math.round on the scaled value is half-up with no sign asymmetry. */
export const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/** |relevant ∩ top-k| as a true set-intersection size (a duplicated id in
 * the ranking counts once). */
function hitsWithin(
  relevant: ReadonlyArray<string>,
  ranked: ReadonlyArray<string>,
  k: number,
): number {
  const rel = new Set(relevant);
  const seen = new Set<string>();
  let hits = 0;
  for (let i = 0; i < k && i < ranked.length; i++) {
    const id = ranked[i];
    if (id !== undefined && rel.has(id) && !seen.has(id)) {
      seen.add(id);
      hits += 1;
    }
  }
  return hits;
}

function requireK(k: number): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`benchmark: k must be an integer >= 1, got ${k}`);
  }
}

/** Recall@k. Returns null for queries with empty relevantIds (excluded from
 * aggregation, not zero). */
export function recallAtK(
  relevant: ReadonlyArray<string>,
  ranked: ReadonlyArray<string>,
  k: number,
): number | null {
  requireK(k);
  if (relevant.length === 0) return null;
  return hitsWithin(relevant, ranked, k) / relevant.length;
}

/** Precision@k with denominator k (not |top-k|, not |relevant|). Returns
 * null for queries with empty relevantIds. */
export function precisionAtK(
  relevant: ReadonlyArray<string>,
  ranked: ReadonlyArray<string>,
  k: number,
): number | null {
  requireK(k);
  if (relevant.length === 0) return null;
  return hitsWithin(relevant, ranked, k) / k;
}

/** Reciprocal rank of the first relevant id: 1/rank, 0 when absent, null
 * when the query has no relevantIds at all. */
export function reciprocalRank(
  relevant: ReadonlyArray<string>,
  ranked: ReadonlyArray<string>,
): number | null {
  if (relevant.length === 0) return null;
  const rel = new Set(relevant);
  for (let i = 0; i < ranked.length; i++) {
    const id = ranked[i];
    if (id !== undefined && rel.has(id)) return 1 / (i + 1);
  }
  return 0;
}

/** A rate with a zero-denominator guard: null instead of Infinity. */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

/** Nearest-rank percentile: with N sorted samples, the answer is the sample
 * at 1-based index ceil(p/100 * N). Returns null for empty samples. */
export function percentileNearestRank(samples: ReadonlyArray<number>, p: number): number | null {
  if (!Number.isFinite(p) || p <= 0 || p > 100) {
    throw new RangeError(`benchmark: percentile p must be in (0, 100], got ${p}`);
  }
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const idx = Math.min(Math.max(Math.ceil((p / 100) * n), 1), n);
  return sorted[idx - 1];
}

/** Canonical k order: sorted ascending, deduped, integer >= 1. */
export function canonicalizeKValues(kValues: ReadonlyArray<number>): number[] {
  for (const k of kValues) requireK(k);
  return [...new Set(kValues)].sort((a, b) => a - b);
}

/** Stable codepoint-ascending compare, the benchmark's tie-break everywhere
 * (turn-1 ruling Q2). localeCompare is avoided on purpose: results can vary
 * with ICU locale, codepoint order cannot. */
export const byIdAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function countIn(ranked: ReadonlyArray<string>, ids: ReadonlyArray<string>): number {
  if (ids.length === 0) return 0;
  const set = new Set(ids);
  let count = 0;
  for (const id of ranked) if (set.has(id)) count += 1;
  return count;
}

function mean(values: ReadonlyArray<number>): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Contract pass/fail for one case: every requiredIds id present in the
 * ranking, no forbiddenIds id present, abstention cases return zero
 * results. supportingIds carry no assertion. */
function contractPassed(q: QueryCase, ranked: ReadonlyArray<string>): boolean {
  if (q.expectAbstain && ranked.length > 0) return false;
  return (
    q.relevantIds.every((id) => ranked.includes(id)) &&
    q.forbiddenIds.every((id) => !ranked.includes(id))
  );
}

/** Compute the full metric report from ground truth, outcomes, the k
 * values, and the corpus engrams (for lifecycle staleness). Outcomes must
 * map 1:1 onto query cases. All aggregate ratios are unrounded; the report
 * renderer rounds once. */
export function computeMetrics(
  queries: ReadonlyArray<QueryCase>,
  outcomes: ReadonlyArray<QueryOutcome>,
  kValues: ReadonlyArray<number>,
  engramsById: ReadonlyMap<string, Engram>,
): MetricReport {
  const ks = canonicalizeKValues(kValues);
  const byQueryId = new Map<string, QueryCase>();
  for (const q of queries) {
    if (byQueryId.has(q.id)) throw new Error(`benchmark: duplicate case id ${q.id}`);
    byQueryId.set(q.id, q);
  }
  const sorted = [...outcomes].sort((a, b) => byIdAsc(a.queryId, b.queryId));
  /* Exact 1:1 validation (leader final review finding 4): every outcome must
   * map to a case (no orphans), no case may have two outcomes, and every
   * case must have one. Otherwise cases silently vanish from, or count
   * twice in, queryCount/passRate. Check order is pinned deterministic:
   * duplicate -> orphan (over sorted outcomes), then missing (over sorted
   * cases). */
  const seenOutcome = new Set<string>();
  for (const o of sorted) {
    if (seenOutcome.has(o.queryId)) {
      throw new Error(`benchmark: duplicate outcome for case ${o.queryId}`);
    }
    seenOutcome.add(o.queryId);
  }
  for (const o of sorted) {
    if (!byQueryId.has(o.queryId)) {
      throw new Error(`benchmark: outcome for ${o.queryId} without a query case`);
    }
  }
  const casesSorted = [...queries].sort((a, b) => byIdAsc(a.id, b.id));
  for (const q of casesSorted) {
    if (!seenOutcome.has(q.id)) {
      throw new Error(`benchmark: missing outcome for case ${q.id}`);
    }
  }

  const perQuery: QueryMetrics[] = sorted.map((o) => {
    const q = byQueryId.get(o.queryId);
    if (q === undefined) throw new Error("benchmark: unreachable case lookup");
    const eligible = q.relevantIds.length > 0;
    let staleReturned = 0;
    for (const id of o.rankedIds) {
      const entry = engramsById.get(id);
      if (entry !== undefined && effectiveStatus(entry, q.nowMs) !== "active") {
        staleReturned += 1;
      }
    }
    return {
      queryId: o.queryId,
      category: q.category,
      passed: contractPassed(q, o.rankedIds),
      abstained: o.abstained,
      expectedAbstain: q.expectAbstain,
      returned: o.rankedIds.length,
      staleReturned,
      forbiddenReturned: countIn(o.rankedIds, q.forbiddenIds),
      supportingReturned: countIn(o.rankedIds, q.supportingIds),
      renderedChars: o.renderedChars,
      latencyNs: o.latencyNs,
      recall: ks.map((k) => (eligible ? recallAtK(q.relevantIds, o.rankedIds, k) : null)),
      precision: ks.map((k) => (eligible ? precisionAtK(q.relevantIds, o.rankedIds, k) : null)),
      reciprocalRank: eligible ? reciprocalRank(q.relevantIds, o.rankedIds) : null,
    };
  });

  const eligible = perQuery.filter((q) => q.reciprocalRank !== null);
  const eligibleCount = eligible.length;

  const kMetrics: KAggregate[] = ks.map((k, i) => ({
    k,
    recall: eligibleCount === 0 ? null : mean(eligible.map((q) => q.recall[i] ?? 0)),
    precision: eligibleCount === 0 ? null : mean(eligible.map((q) => q.precision[i] ?? 0)),
  }));
  const mrr = eligibleCount === 0 ? null : mean(eligible.map((q) => q.reciprocalRank ?? 0));

  const categoryMetrics: CategoryMetric[] = CORPUS_CATEGORIES.map((category) => {
    const rows = perQuery.filter((q) => q.category === category);
    const passed = rows.reduce((sum, q) => sum + (q.passed ? 1 : 0), 0);
    return {
      category,
      cases: rows.length,
      passed,
      passRate: rate(passed, rows.length),
    };
  });

  const passedCount = perQuery.reduce((sum, q) => sum + (q.passed ? 1 : 0), 0);
  const nonAbstention = perQuery.filter((q) => !q.expectedAbstain);
  const falseAbstainCases = nonAbstention.reduce((sum, q) => sum + (q.abstained ? 1 : 0), 0);

  const totalReturned = perQuery.reduce((sum, q) => sum + q.returned, 0);
  const staleReturned = perQuery.reduce((sum, q) => sum + q.staleReturned, 0);
  const forbiddenReturned = perQuery.reduce((sum, q) => sum + q.forbiddenReturned, 0);

  const abstentionCases = queries.filter((q) => q.expectAbstain);
  const abstainedById = new Map(sorted.map((o) => [o.queryId, o.abstained] as const));
  const abstentionEligible = abstentionCases.length;
  const abstentionCorrect = abstentionCases.reduce(
    (count, q) => count + (abstainedById.get(q.id) === true ? 1 : 0),
    0,
  );

  const latencySamplesNs = perQuery.map((q) => q.latencyNs);

  return {
    queryCount: perQuery.length,
    passedCount,
    passRate: rate(passedCount, perQuery.length),
    categoryMetrics,
    falseAbstainCases,
    falseAbstainRate: rate(falseAbstainCases, nonAbstention.length),
    eligibleCount,
    kValues: ks,
    kMetrics,
    mrr,
    totalReturned,
    staleReturned,
    forbiddenReturned,
    staleRate: rate(staleReturned, totalReturned),
    forbiddenRate: rate(forbiddenReturned, totalReturned),
    abstentionEligible,
    abstentionCorrect,
    abstentionAccuracy: rate(abstentionCorrect, abstentionEligible),
    latencyP50: percentileNearestRank(latencySamplesNs, 50),
    latencyP95: percentileNearestRank(latencySamplesNs, 95),
    latencyP99: percentileNearestRank(latencySamplesNs, 99),
    latencySamplesNs,
    renderedCharsTotal: perQuery.reduce((sum, q) => sum + q.renderedChars, 0),
    perQuery,
  };
}
