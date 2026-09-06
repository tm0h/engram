/**
 * Deterministic text report for the ENG-8 benchmark.
 *
 * Pure rendering: fixed column order, case rows sorted by id ascending,
 * metric values rounded exactly once here (6 decimal places). The header
 * names the corpus version it was handed; there is deliberately no
 * provisional notice left (the benchmark-internal test fixture is marked in
 * its own README, not in the production report). The only non-
 * deterministic input a real run can contribute is latency, which is
 * measured, never scored.
 */
import { round6 } from "./metrics.js";
import type { BenchmarkResult, CategoryMetric, QueryMetrics } from "./types.js";

const fmt6 = (value: number): string => round6(value).toFixed(6);

/** Per-case table cell: "-" marks an excluded/absent value (e.g. a case
 * with no requiredIds is excluded from R/P/RR). */
const cell = (value: number | null): string =>
  value === null ? "       -" : fmt6(value).padStart(8);

/** Aggregate value: "n/a" marks an undefined aggregate (e.g. a rate over
 * zero returned rows). */
const agg = (value: number | null): string => (value === null ? "n/a" : fmt6(value));

const flag = (value: boolean): string => (value ? "1" : "0");

const latencyText = (value: number | null): string => (value === null ? "n/a" : String(value));

function renderCaseRow(query: QueryMetrics, ks: ReadonlyArray<number>): string {
  const head =
    query.queryId.padEnd(20) +
    `cat=${query.category.padEnd(16)}` +
    ` pass=${flag(query.passed)}` +
    ` abst=${flag(query.abstained)}` +
    ` exp=${flag(query.expectedAbstain)}` +
    ` ret=${query.returned}` +
    ` stale=${query.staleReturned}` +
    ` forb=${query.forbiddenReturned}` +
    ` sup=${query.supportingReturned}` +
    ` chars=${query.renderedChars}` +
    ` lat=${query.latencyNs}ns`;
  const recallCells = query.recall.map((value, i) => ` R@${ks[i]}=${cell(value)}`).join("");
  const precisionCells = query.precision.map((value, i) => ` P@${ks[i]}=${cell(value)}`).join("");
  return `${head}${recallCells}${precisionCells} RR=${cell(query.reciprocalRank)}`;
}

function renderCategoryRow(row: CategoryMetric): string {
  return `${row.category.padEnd(16)} ${row.passed}/${row.cases}=${agg(row.passRate)}`;
}

/** Render the full report. Same BenchmarkResult bytes -> same output bytes. */
export function renderReport(result: BenchmarkResult): string {
  const { corpus, config, metrics: m } = result;
  const ks = config.kValues;
  const lines: string[] = [];

  lines.push("ENG-8 benchmark report");
  lines.push(
    `corpus name=${corpus.name} version=${corpus.corpusVersion} schemaVersion=${corpus.schemaVersion}`,
  );
  lines.push(
    `k=${ks.join(",")} abstainThreshold=${config.abstainThreshold} (inert: abstain = empty ranking)`,
  );
  lines.push('per-case (sorted by id; "-" = excluded):');
  for (const query of m.perQuery) lines.push(renderCaseRow(query, ks));

  lines.push("per-category (contract order; n/a = no cases):");
  for (const row of m.categoryMetrics) lines.push(renderCategoryRow(row));

  lines.push(
    `aggregate (cases=${m.queryCount} passed=${m.passedCount}` +
      ` eligible=${m.eligibleCount} returned=${m.totalReturned}):`,
  );
  lines.push(m.kMetrics.map((x) => `Recall@${x.k}=${agg(x.recall)}`).join(" "));
  lines.push(m.kMetrics.map((x) => `Precision@${x.k}=${agg(x.precision)}`).join(" "));
  lines.push(`MRR=${agg(m.mrr)}`);
  lines.push(
    `passRate=${m.passedCount}/${m.queryCount}=${agg(m.passRate)}` +
      ` falseAbstain=${m.falseAbstainCases}/${m.queryCount - m.abstentionEligible}=${agg(m.falseAbstainRate)}` +
      ` abstain=${m.abstentionCorrect}/${m.abstentionEligible}=${agg(m.abstentionAccuracy)}`,
  );
  lines.push(
    `stale=${m.staleReturned}/${m.totalReturned}=${agg(m.staleRate)}` +
      ` forb=${m.forbiddenReturned}/${m.totalReturned}=${agg(m.forbiddenRate)}`,
  );
  lines.push(`chars_total=${m.renderedCharsTotal}`);
  lines.push(
    `latency p50=${latencyText(m.latencyP50)} p95=${latencyText(m.latencyP95)}` +
      ` p99=${latencyText(m.latencyP99)} samples=${m.latencySamplesNs.join(",")}`,
  );

  return lines.join("\n") + "\n";
}
