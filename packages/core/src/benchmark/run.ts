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
  /** Generation-time provenance block (ENG-76): carried through unchanged
   * from an existing `--out` target exactly when that target parses as JSON
   * and its `source` value is a plain object; never synthesized. The writer
   * re-emits it between `contractHash` and `config`, the position the
   * checked-in baseline has carried since PR #43. */
  source?: Record<string, unknown>;
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
  identity: { contractHash: string; generatedAtUtc: string; source?: Record<string, unknown> },
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
    ...(identity.source === undefined ? {} : { source: identity.source }),
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

/** Canonical serialized form of the benchmark JSON (SPEC ENG-76, review
 * finding F1 option A): the checked-in baseline's historical format, now
 * pinned as the writer's output. Derived empirically from
 * baseline-v0.3.1.json and locked by the round-trip identity test:
 * 2-space indent, a trailing newline, non-empty objects always expanded,
 * empty containers inline, and primitive-element arrays inlined as
 * `[1, 2, 3]` exactly when the member's `"key": [...]` form fits the
 * 96-char budget below (the leading indent is not counted). The budget is
 * a file-pinned constant: the largest inline member in the baseline
 * measures 85, the smallest expanded scalar array 135, and the boundary
 * probes bracket it at 96 inline / 97 expanded. It is not keyed to any
 * specific field: any primitive-array member of any size formats by the
 * same rule, which is what makes the whole-file round-trip byte-identical. */
const INLINE_MEMBER_BUDGET = 96;

const isPrimitiveJson = (value: unknown): boolean => value === null || typeof value !== "object";

/** Single-line form of a JSON value, or null when the pinned rules never
 * inline it (non-empty objects, arrays containing objects or arrays). */
const inlineJson = (value: unknown): string | null => {
  if (isPrimitiveJson(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (!value.every(isPrimitiveJson)) return null;
    return `[${value.map((element) => JSON.stringify(element)).join(", ")}]`;
  }
  return Object.keys(value as Record<string, unknown>).length === 0 ? "{}" : null;
};

const printJson = (value: unknown, indent: number, key: string | null): string => {
  const label = key === null ? "" : `${JSON.stringify(key)}: `;
  const pad = " ".repeat(indent);
  // Primitives (including long strings) always render inline: there is no
  // expanded form for a scalar. Only container members are budget-fitted.
  if (isPrimitiveJson(value)) return `${pad}${label}${JSON.stringify(value)}`;
  const inline = inlineJson(value);
  if (inline !== null && label.length + inline.length <= INLINE_MEMBER_BUDGET) {
    return `${pad}${label}${inline}`;
  }
  if (Array.isArray(value)) {
    const items = value.map((element) => printJson(element, indent + 2, null));
    return `${pad}${label}[\n${items.join(",\n")}\n${pad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) =>
    printJson(v, indent + 2, k),
  );
  return `${pad}${label}{\n${entries.join(",\n")}\n${pad}}`;
};

/** Render `value` in the canonical pinned format (trailing newline
 * included). Applying it to the parsed checked-in baseline reproduces the
 * file's exact bytes; fresh regeneration output uses the same format. */
export function serializeBenchmarkJson(value: unknown): string {
  return `${printJson(value, 0, null)}\n`;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The carried block from an existing `--out` target (F2): exactly when the
 * target parses as JSON and its `source` value is a plain object; any
 * malformed or missing source is omitted silently, never synthesized. */
const readCarriedSource = (outPath: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(outPath, "utf8"));
    if (isPlainObject(parsed) && isPlainObject(parsed.source)) return parsed.source;
  } catch {
    // Unparseable or unreadable target: fresh-generation semantics.
  }
  return undefined;
};

/** Re-emit `json` with `source` in its canonical position between
 * `contractHash` and `config` (the checked-in baseline's position; object
 * literal order is the serializer's emission order). */
const withCarriedSource = (
  json: RepoBenchmarkJson,
  source: Record<string, unknown>,
): RepoBenchmarkJson => ({
  benchmark: json.benchmark,
  corpusVersion: json.corpusVersion,
  schemaVersion: json.schemaVersion,
  contractHash: json.contractHash,
  source,
  config: json.config,
  generatedAtUtc: json.generatedAtUtc,
  metrics: json.metrics,
  comparableMetrics: json.comparableMetrics,
  tolerances: json.tolerances,
  measuredMisses: json.measuredMisses,
  limitations: json.limitations,
  cases: json.cases,
});

/** Write the benchmark JSON to `out` (ENG-76 F3): when the target already
 * contains a parseable benchmark JSON with a plain-object `source` block,
 * the regenerated output carries that block unchanged; otherwise the output
 * is exactly fresh generation. Returns the canonical text (also written to
 * `out` when given); the caller prints it to stdout when `out` is
 * undefined. */
export function writeBenchmarkJson(json: RepoBenchmarkJson, out: string | undefined): string {
  const carried = out !== undefined && existsSync(out) ? readCarriedSource(out) : undefined;
  const text = serializeBenchmarkJson(
    carried === undefined ? json : withCarriedSource(json, carried),
  );
  if (out !== undefined) writeFileSync(out, text);
  return text;
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

/** CLI argument validation for `--out` (ENG-76 F3): kept byte-compatible
 * with the historical messages and exit path; pure so the messages stay
 * testable. The invocation block prints the error and exits 1. */
export function outArgError(out: string | undefined): string | null {
  if (out === undefined) return "--out requires a path";
  if (existsSync(out) && statSync(out).isDirectory()) return `--out points at a directory: ${out}`;
  return null;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  let out: string | undefined;
  const outIndex = args.indexOf("--out");
  if (outIndex >= 0) {
    out = args[outIndex + 1];
    const error = outArgError(out);
    if (error !== null) {
      console.error(error);
      process.exit(1);
    }
  }
  const text = writeBenchmarkJson(runRepoBenchmark(), out);
  if (out !== undefined) {
    console.log(`benchmark: wrote ${out}`);
  } else {
    process.stdout.write(text);
  }
}
