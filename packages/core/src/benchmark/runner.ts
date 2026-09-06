/**
 * Deterministic benchmark runner for ENG-8.
 *
 * Runs an INJECTED evaluate fn (evaluateCase's signature: engrams, case,
 * defaultNowMs -> results) over a contract-shaped corpus and collects
 * per-case outcomes plus the full metric report. The pinned evaluation
 * procedure is ENG-11's executable contract; the benchmark never
 * reimplements it in src/. No LLM calls, no network, no wall clock in
 * scored values: latency is measured through an injected clock (default
 * process.hrtime.bigint) and is reported, never scored.
 *
 * Not exported from packages/core/src/index.ts: this module is scaffold and
 * must not affect the CLI bundle or other lanes.
 */
import type { Engram } from "../domain.js";
import { renderEntry } from "./adapter.js";
import { byIdAsc, canonicalizeKValues, computeMetrics } from "./metrics.js";
import type { BenchmarkResult, EvaluateFn, QueryOutcome, RunConfig, RunInput } from "./types.js";

/** Default measurement clock. Acceptable because latency is reported only;
 * tests inject deterministic clocks instead. */
export const defaultClock = (): bigint => process.hrtime.bigint();

export interface RunnerOptions {
  /** Injected clock, called twice per case (t0, t1). Default hrtime. */
  readonly clock?: () => bigint;
  /** Rendered-character rule. Default: the benchmark-owned consumer rule
   * (renderEntry length) from the adapter module. */
  readonly renderChars?: (entry: Engram) => number;
}

function canonicalConfig(config: RunConfig): RunConfig {
  if (!Number.isFinite(config.abstainThreshold)) {
    throw new Error("benchmark: RunConfig.abstainThreshold must be a finite number");
  }
  return {
    kValues: canonicalizeKValues(config.kValues),
    abstainThreshold: config.abstainThreshold,
  };
}

/** Run the injected evaluate fn over the corpus and produce outcomes plus
 * metrics.
 *
 * Behavioural contracts (all tested):
 * - corpus engrams are handed to the evaluate fn in input order (the
 *   adapter delivers them sorted id-ascending)
 * - outcomes are sorted by case id
 * - abstained = empty ranking (RunConfig.abstainThreshold is inert here;
 *   reserved for a score-aware integration path, turn-1 ruling Q1)
 * - unknown returned ids count toward returned totals, never toward
 *   stale/forbidden/relevant, and render 0 characters
 * - staleness is lifecycle-derived per case: effectiveStatus(engram,
 *   case nowMs) != "active"
 * - same input + deterministic clock -> byte-identical results */
export function runBenchmark(
  evaluate: EvaluateFn,
  input: RunInput,
  config: RunConfig,
  options: RunnerOptions = {},
): BenchmarkResult {
  const canonical = canonicalConfig(config);
  const clock = options.clock ?? defaultClock;
  const renderChars = options.renderChars ?? ((entry: Engram) => renderEntry(entry).length);

  const byEntryId = new Map<string, Engram>();
  for (const entry of input.entries) {
    if (byEntryId.has(entry.id)) throw new Error(`benchmark: duplicate entry id ${entry.id}`);
    byEntryId.set(entry.id, entry);
  }
  const queries = [...input.queries].sort((a, b) => byIdAsc(a.id, b.id));
  const seenCase = new Set<string>();
  for (const q of queries) {
    if (seenCase.has(q.id)) throw new Error(`benchmark: duplicate case id ${q.id}`);
    seenCase.add(q.id);
  }

  const outcomes: QueryOutcome[] = queries.map((q) => {
    const t0 = clock();
    const results = evaluate(input.entries, q.source, input.defaultNowMs);
    const t1 = clock();
    const rankedIds = results.map((r) => r.engram.id);
    let renderedChars = 0;
    for (const id of rankedIds) {
      const entry = byEntryId.get(id);
      if (entry !== undefined) renderedChars += renderChars(entry);
    }
    return {
      queryId: q.id,
      rankedIds,
      // Abstain = empty ranking. abstainThreshold is intentionally unused:
      // the evaluate seam is id-only in this scaffold (turn-1 ruling Q1).
      abstained: rankedIds.length === 0,
      latencyNs: Number(t1 - t0),
      renderedChars,
    };
  });

  return {
    corpus: input.meta,
    config: canonical,
    outcomes,
    metrics: computeMetrics(queries, outcomes, canonical.kValues, byEntryId),
  };
}
