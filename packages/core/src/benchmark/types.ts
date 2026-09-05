/**
 * Types for the ENG-8 deterministic retrieval benchmark runner.
 *
 * The benchmark consumes the real ENG-11 contract through the
 * `@engram/core/corpus` subpath (never the barrel): corpus types are the
 * real ones, the loaded corpus comes from the real `loadCorpus`, and
 * evaluation is the real `evaluateCase` (injected into the runner as a
 * function so the runner stays testable). No mirror types remain.
 *
 * Determinism contract for the whole benchmark module family:
 * - every evaluation instant is resolved per case (case.now, else the
 *   manifest defaultNow) and carried as `nowMs`; wall clocks are never read
 * - stable ordering by engram/case id ascending (codepoint compare)
 *   everywhere this code orders anything
 * - latency is measured through an injected clock and is reported, never
 *   scored, so wall-clock noise cannot change any metric value
 */
import type { Engram } from "../domain.js";
import type { SearchResult } from "../search.js";
import type { CorpusCase, CorpusCategory } from "@engram/core/corpus";

export type { CorpusCase, CorpusCategory };

/** Corpus identity surfaced for the report header. */
export interface CorpusMeta {
  readonly name: string;
  readonly corpusVersion: string;
  readonly schemaVersion: number;
}

/** One benchmark query: the contract case mapped into benchmark terms.
 *
 * Field semantics:
 * - `relevantIds` = requiredIds: ids that must appear. Queries with an
 *   empty list are EXCLUDED from Recall/Precision/MRR aggregation. Per the
 *   fleet ground-truth decision, an empty required list with
 *   `expectAbstain` false is possible only in fixtures; real contract
 *   validation forbids it.
 * - `supportingIds`: tolerated noise, reported per case, never asserted.
 * - `forbiddenIds`: ids that must not appear (contract pass/fail input).
 * - `expectAbstain` = expectEmpty: the correct output is an empty ranking.
 *   Only these queries are abstention-eligible. Over-abstention on other
 *   queries surfaces through falseAbstainRate and Recall.
 * - `nowMs`: resolved evaluation instant (case.now else manifest
 *   defaultNow). Lifecycle staleness is effectiveStatus(engram, nowMs) !=
 *   "active"; the contract has no per-case stale marker.
 * - `source`: the contract case, handed unchanged to the injected evaluate
 *   fn (which reads scope/query/limit/includeInactive/now off it). */
export interface QueryCase {
  readonly id: string;
  readonly query: string;
  readonly category: CorpusCategory;
  readonly scope: "personal" | "project";
  readonly relevantIds: ReadonlyArray<string>;
  readonly supportingIds: ReadonlyArray<string>;
  readonly forbiddenIds: ReadonlyArray<string>;
  readonly expectAbstain: boolean;
  readonly nowMs: number;
  readonly source: CorpusCase;
}

/** Canonical input to the runner: corpus identity, the loaded engrams, and
 * the mapped query cases. */
export interface RunInput {
  readonly meta: CorpusMeta;
  /** Manifest defaultNow as epoch ms, passed through to the injected
   * evaluate fn (evaluateCase's third parameter). */
  readonly defaultNowMs: number | undefined;
  readonly entries: ReadonlyArray<Engram>;
  readonly queries: ReadonlyArray<QueryCase>;
}

/** Benchmark configuration.
 *
 * `abstainThreshold` is defined and carried for a score-aware integration
 * path, but is INERT in this id-only scaffold: abstention is defined as an
 * empty ranking, and no score ever crosses the threshold (guarded by a
 * dedicated runner test). There is deliberately no global `now`: each case
 * carries its own resolved `nowMs`. */
export interface RunConfig {
  /** The k values for Recall@k / Precision@k. Canonicalized to sorted,
   * deduped, integer >= 1 order before use. */
  readonly kValues: ReadonlyArray<number>;
  /** Reserved for a score-aware integration path; inert here (see above). */
  readonly abstainThreshold: number;
}

/** One query's raw run output. */
export interface QueryOutcome {
  readonly queryId: string;
  /** Ranked ids exactly as the evaluate fn returned them. Unknown ids are
   * kept: they count toward returned totals but never match any ground-truth
   * set, never count as stale, and render 0 characters. */
  readonly rankedIds: ReadonlyArray<string>;
  /** True iff the ranking was empty (abstain = empty ranking). */
  readonly abstained: boolean;
  /** Reported only, never scored. Nanoseconds as a number (hrtime bigint
   * difference; realistic benchmark latencies are far below 2^53). */
  readonly latencyNs: number;
  /** Sum of rendered character counts over returned known entries. */
  readonly renderedChars: number;
}

/** Per-case metric row (aligned to the canonical kValues order). */
export interface QueryMetrics {
  readonly queryId: string;
  readonly category: CorpusCategory;
  /** Contract pass: every requiredIds id present, no forbiddenIds id
   * present, abstention cases return zero results. */
  readonly passed: boolean;
  readonly abstained: boolean;
  readonly expectedAbstain: boolean;
  readonly returned: number;
  readonly staleReturned: number;
  readonly forbiddenReturned: number;
  /** Returned ids that are tolerated noise (supportingIds). */
  readonly supportingReturned: number;
  readonly renderedChars: number;
  readonly latencyNs: number;
  /** Recall@k per k; null where the query has no relevantIds. */
  readonly recall: ReadonlyArray<number | null>;
  /** Precision@k per k (denominator is k); null where not eligible. */
  readonly precision: ReadonlyArray<number | null>;
  /** 1/rank of the first relevant id, 0 when absent; null when not eligible. */
  readonly reciprocalRank: number | null;
}

/** Aggregate Recall@k / Precision@k over eligible queries (null when no
 * query is eligible). */
export interface KAggregate {
  readonly k: number;
  readonly recall: number | null;
  readonly precision: number | null;
}

/** Per-category aggregation row (fixed contract order). */
export interface CategoryMetric {
  readonly category: CorpusCategory;
  readonly cases: number;
  readonly passed: number;
  /** null when the category has no cases. */
  readonly passRate: number | null;
}

/** Full metric report. Values are UNROUNDED ratios; rounding happens once,
 * at report render time, to 6 decimal places (never mid-pipeline). */
export interface MetricReport {
  readonly queryCount: number;
  readonly passedCount: number;
  /** passedCount / queryCount; null when the corpus has no cases. */
  readonly passRate: number | null;
  readonly categoryMetrics: ReadonlyArray<CategoryMetric>;
  /** Non-abstention cases that returned zero results. */
  readonly falseAbstainCases: number;
  /** falseAbstainCases / non-abstention case count; null when there are
   * none. */
  readonly falseAbstainRate: number | null;
  /** Queries with non-empty relevantIds (the R/P/MRR denominator set). */
  readonly eligibleCount: number;
  readonly kValues: ReadonlyArray<number>;
  readonly kMetrics: ReadonlyArray<KAggregate>;
  /** Mean reciprocal rank over eligible queries. */
  readonly mrr: number | null;
  readonly totalReturned: number;
  readonly staleReturned: number;
  readonly forbiddenReturned: number;
  /** staleReturned / totalReturned; null when nothing was returned. */
  readonly staleRate: number | null;
  readonly forbiddenRate: number | null;
  /** Queries with expectAbstain = true. */
  readonly abstentionEligible: number;
  /** Eligible queries where the runner abstained. */
  readonly abstentionCorrect: number;
  /** abstentionCorrect / abstentionEligible; null when nothing eligible. */
  readonly abstentionAccuracy: number | null;
  readonly latencyP50: number | null;
  readonly latencyP95: number | null;
  readonly latencyP99: number | null;
  /** Raw per-query samples in case-id order (unrounded). */
  readonly latencySamplesNs: ReadonlyArray<number>;
  readonly renderedCharsTotal: number;
  readonly perQuery: ReadonlyArray<QueryMetrics>;
}

/** Everything one benchmark run produces. Fully JSON-serializable. */
export interface BenchmarkResult {
  readonly corpus: CorpusMeta;
  readonly config: RunConfig;
  /** Sorted by case id ascending. */
  readonly outcomes: ReadonlyArray<QueryOutcome>;
  readonly metrics: MetricReport;
}

/** The injected evaluation seam's shape: identical to the contract's
 * `evaluateCase` (the pinned procedure's executable form). The runner never
 * implements the procedure; production binds the real `evaluateCase`. */
export type EvaluateFn = (
  engrams: ReadonlyArray<Engram>,
  c: CorpusCase,
  defaultNowMs?: number,
) => ReadonlyArray<SearchResult>;
