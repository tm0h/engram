/**
 * ENG-8 repository-owned retrieval benchmark command.
 *
 * Runs the real retrieval benchmark over the in-repo `corpus/` directory
 * (path derived from this module's URL: works from any normal checkout,
 * never cwd-dependent, never /tmp or sibling-worktree paths) with the
 * production evaluation seam (`evaluateCase` from the `@engram/core/corpus`
 * subpath, i.e. the wired search).
 *
 * Usage (documented command site):
 *
 *   pnpm --filter @engram/core benchmark
 *   pnpm --filter @engram/core benchmark -- --out /path/to/result.json
 *
 * Output: aggregate + per-case machine-readable JSON on stdout, or written
 * to the explicit `--out` path. A normal run writes NOTHING into the repo
 * tree; pass an explicit --out for a file (the checked-in baseline and its
 * gate live under packages/core/test/benchmark/ and are regenerated only
 * through the documented policy: explicit review of any degradation,
 * regressions require disposition, improvements recorded, never relabel).
 *
 * Latency fields are excluded here: they are inherently nonreproducible and
 * never participate in comparisons.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateCase } from "@engram/core/corpus";
import { ContractCorpusAdapter, DEFAULT_CORPUS_DIR } from "./adapter.js";
import { round6 } from "./metrics.js";
import { runBenchmark } from "./runner.js";
import type { BenchmarkResult, MetricReport, QueryMetrics } from "./types.js";

export const K_VALUES = [1, 3, 5];

/** Metric report as persisted in the benchmark JSON: latency-free at the
 * top level and per query. Latency is inherently nonreproducible, never
 * participates in the gate, and would churn every regeneration (PR #43
 * review: incidental timing churn). */
type BaselineMetrics = Omit<
  MetricReport,
  "latencyP50" | "latencyP95" | "latencyP99" | "latencySamplesNs" | "perQuery"
> & {
  perQuery: ReadonlyArray<Omit<QueryMetrics, "latencyNs">>;
};

export interface RepoBenchmarkJson {
  benchmark: "engram-retrieval-benchmark";
  corpusVersion: string;
  schemaVersion: number;
  /** Snapshot hash over the corpus files, per the contract README recipe
   * (sha256 over <relpath>\n<byte length>\n<bytes> in lexicographic path
   * order over manifest.json + cases/*.json + engrams/*.md). */
  contractHash: string;
  config: { kValues: ReadonlyArray<number>; abstainThreshold: number };
  generatedAtUtc: string;
  /** Aggregate metrics; latency fields excluded, including per-query
   * timing samples: latency is inherently nonreproducible, never
   * participates in the gate, and would churn every regeneration
   * (PR #43 review: incidental timing churn). */
  metrics: BaselineMetrics;
  /** 6-decimal comparable form of the aggregate metrics (the regression
   * gate compares exactly this). */
  comparableMetrics: ReturnType<typeof comparableMetrics>;
  /** Documented gate tolerances and regeneration policy. */
  tolerances: string;
  /** Case ids that did NOT pass under the wired search at generation time.
   * These are measured retrieval limitations, not corpus failures: labels
   * are never edited to make a ranker pass. */
  measuredMisses: string[];
  limitations: string;
  /** Per-case measured results keyed by case id. */
  cases: Record<
    string,
    {
      category: string;
      passed: boolean;
      returned: number;
      rankedIds: string[];
      staleReturned: number;
      forbiddenReturned: number;
      supportingReturned: number;
      renderedChars: number;
      recall: ReadonlyArray<number | null>;
      precision: ReadonlyArray<number | null>;
      reciprocalRank: number | null;
    }
  >;
}

/** Strip every latency measurement: the four top-level latency fields and
 * the per-query timing samples. Latency is inherently nonreproducible and
 * never participates in comparisons, so the persisted JSON records none. */
function stripLatency(metrics: MetricReport): BaselineMetrics {
  const { latencyP50, latencyP95, latencyP99, latencySamplesNs, ...rest } = metrics;
  void latencyP50;
  void latencyP95;
  void latencyP99;
  void latencySamplesNs;
  return {
    ...rest,
    perQuery: rest.perQuery.map(({ latencyNs, ...row }) => {
      void latencyNs;
      return row;
    }),
  };
}

/** Snapshot hash over the corpus files, per the contract README recipe:
 * sha256 over manifest.json, cases/*.json, engrams/*.md in lexicographic
 * path order, fed as <relpath>\n<byte length>\n<bytes>. */
export function corpusSnapshotHash(dir: string = DEFAULT_CORPUS_DIR): string {
  const entries: Array<{ rel: string; bytes: Buffer }> = [
    { rel: "manifest.json", bytes: readFileSync(path.join(dir, "manifest.json")) },
  ];
  for (const sub of ["cases", "engrams"] as const) {
    for (const name of readdirSync(path.join(dir, sub)).sort()) {
      const abs = path.join(dir, sub, name);
      if (statSync(abs).isFile()) {
        entries.push({ rel: `${sub}/${name}`, bytes: readFileSync(abs) });
      }
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const { rel, bytes } of entries) {
    hash.update(`${rel}\n${bytes.length}\n`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** Run the benchmark over the in-repo corpus and return the
 * machine-readable result (no side effects on the repo tree). */
export function runRepoBenchmark(): RepoBenchmarkJson {
  const adapter = new ContractCorpusAdapter();
  const loaded = adapter.load();
  if (loaded.issues.length > 0) {
    throw new Error(`benchmark: corpus has ${loaded.issues.length} issue(s); refusing evaluation`);
  }
  const input = adapter.toRunInput(loaded);
  const result = runBenchmark(evaluateCase, input, { kValues: K_VALUES, abstainThreshold: 0 });
  return buildBenchmarkJson(result, {
    contractHash: `sha256:${corpusSnapshotHash()}`,
    generatedAtUtc: new Date().toISOString(),
  });
}

const TOLERANCES_TEXT =
  "Gate semantics: identical corpus identity and config (corpusVersion, schemaVersion, " +
  "contract hash, kValues, abstain threshold) and identical case sets are required. Fail " +
  "on any outcome regression (baseline pass -> live miss); fail on any per-case data " +
  "change on non-improvement cases (full row: ranked ids, counts, rendered chars, recall, " +
  "precision, reciprocal rank; still-missing cases included); fail on any aggregate metric " +
  "drift not exactly attributable to improvements (expected aggregates are recomputed from " +
  "baseline rows with improvement rows replaced by live rows; latency excluded). " +
  "Improvements (baseline miss -> live pass) are surfaced with their attributable aggregate " +
  "deltas and never block, including improvements on recorded measuredMisses; they trigger " +
  "the regeneration policy: explicit review of the full delta, regressions require leader " +
  "disposition, corpus labels are never edited to make a ranker pass. Unchanged misses " +
  "are measured retrieval limitations of the wired search and stay visible.";

const LIMITATIONS_TEXT =
  "Measured retrieval limitations of the wired search on this corpus snapshot. " +
  "They are recorded data, not corpus failures: labels are never edited to make " +
  "a ranker pass, and regressions vs a checked-in baseline require leader disposition.";

/** Build the persisted benchmark JSON from a completed run. Deterministic
 * apart from the injected identity values (real runs pass the corpus
 * snapshot hash and the wall-clock instant); latency is stripped here, so
 * the emitted JSON records no timing samples (see RepoBenchmarkJson.metrics
 * and the PR #43 timing-churn review). */
export function buildBenchmarkJson(
  result: BenchmarkResult,
  identity: { contractHash: string; generatedAtUtc: string },
): RepoBenchmarkJson {
  const metrics = stripLatency(result.metrics);
  const cases: RepoBenchmarkJson["cases"] = {};
  for (const q of metrics.perQuery) {
    cases[q.queryId] = {
      category: q.category,
      passed: q.passed,
      returned: q.returned,
      rankedIds: [...(result.outcomes.find((o) => o.queryId === q.queryId)?.rankedIds ?? [])],
      staleReturned: q.staleReturned,
      forbiddenReturned: q.forbiddenReturned,
      supportingReturned: q.supportingReturned,
      renderedChars: q.renderedChars,
      recall: q.recall,
      precision: q.precision,
      reciprocalRank: q.reciprocalRank,
    };
  }
  return {
    benchmark: "engram-retrieval-benchmark",
    corpusVersion: result.corpus.corpusVersion,
    schemaVersion: result.corpus.schemaVersion,
    contractHash: identity.contractHash,
    config: { kValues: result.config.kValues, abstainThreshold: result.config.abstainThreshold },
    generatedAtUtc: identity.generatedAtUtc,
    metrics,
    comparableMetrics: comparableMetrics(metrics),
    tolerances: TOLERANCES_TEXT,
    measuredMisses: Object.keys(cases).filter((id) => !cases[id]!.passed),
    limitations: LIMITATIONS_TEXT,
    cases,
  };
}

/** Round a metric report down to its comparable (6-decimal) form, latency
 * excluded: the regression gate compares exactly this shape. Accepts the
 * latency-stripped metrics emitted by runRepoBenchmark; per-query rows are
 * not part of the comparable shape. */
export function comparableMetrics(
  metrics: Omit<
    MetricReport,
    "latencyP50" | "latencyP95" | "latencyP99" | "latencySamplesNs" | "perQuery"
  >,
) {
  return {
    queryCount: metrics.queryCount,
    passedCount: metrics.passedCount,
    passRate: metrics.passRate === null ? null : round6(metrics.passRate),
    mrr: metrics.mrr === null ? null : round6(metrics.mrr),
    staleRate: metrics.staleRate === null ? null : round6(metrics.staleRate),
    forbiddenRate: metrics.forbiddenRate === null ? null : round6(metrics.forbiddenRate),
    abstentionAccuracy:
      metrics.abstentionAccuracy === null ? null : round6(metrics.abstentionAccuracy),
    falseAbstainRate: metrics.falseAbstainRate === null ? null : round6(metrics.falseAbstainRate),
    eligibleCount: metrics.eligibleCount,
    totalReturned: metrics.totalReturned,
    staleReturned: metrics.staleReturned,
    forbiddenReturned: metrics.forbiddenReturned,
    renderedCharsTotal: metrics.renderedCharsTotal,
    kMetrics: metrics.kMetrics.map((k) => ({
      k: k.k,
      recall: k.recall === null ? null : round6(k.recall),
      precision: k.precision === null ? null : round6(k.precision),
    })),
    categoryMetrics: metrics.categoryMetrics.map((c) => ({
      category: c.category,
      cases: c.cases,
      passed: c.passed,
      passRate: c.passRate === null ? null : round6(c.passRate),
    })),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  let out: string | undefined;
  const outIndex = args.indexOf("--out");
  if (outIndex >= 0) {
    out = args[outIndex + 1];
    if (out === undefined) {
      console.error("--out requires a path");
      process.exit(1);
    }
    if (existsSync(out) && statSync(out).isDirectory()) {
      console.error(`--out points at a directory: ${out}`);
      process.exit(1);
    }
  }
  const json = runRepoBenchmark();
  const text = `${JSON.stringify(json, null, 2)}\n`;
  if (out !== undefined) {
    writeFileSync(out, text);
    console.log(`benchmark: wrote ${out}`);
  } else {
    process.stdout.write(text);
  }
}
