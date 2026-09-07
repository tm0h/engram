/**
 * CLI composition for the ENG-18 shadow comparison and latency harness
 * (thin layer over benchmark/shadow.ts; all logic lives in tested
 * functions). Direct invocation only:
 *
 *   pnpm --filter @engram/core benchmark:shadow
 *   pnpm --filter @engram/core benchmark:shadow -- --out /path/report.json
 *
 * Flags:
 *   --out <path>       write the JSON report to <path> (default: stdout)
 *   --runs <n>         measured runs per ranker per corpus (odd; default 7)
 *   --synthetic <n>    synthetic corpus size for the latency section
 *                      (default 1000; 0 skips it)
 *
 * Loads the in-repo golden corpus through the real adapter (never
 * cwd-dependent), runs the legacy-vs-wired comparison, measures latency
 * for BOTH rankers over the golden corpus and over the synthetic corpus,
 * and prints one JSON document. Latency is reported, never scored, and
 * never enters the baseline gate. A normal run writes nothing into the
 * repo tree.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ContractCorpusAdapter } from "./adapter.js";
import { syntheticCorpus } from "./synthetic.js";
import {
  evaluateCaseLegacy,
  measureRankerLatency,
  runShadowComparison,
  type LatencyMeasurement,
} from "./shadow.js";
import { evaluateCase } from "@engram/core/corpus";
import { corpusSnapshotHash, K_VALUES } from "./run.js";

interface CliArgs {
  out: string | undefined;
  runs: number;
  synthetic: number;
}

function fail(message: string): never {
  console.error(`benchmark:shadow ${message}`);
  process.exit(1);
}

function parseArgs(args: ReadonlyArray<string>): CliArgs {
  let out: string | undefined;
  let runs = 7;
  let synthetic = 1000;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
      out = args[++i];
      if (out === undefined) fail("--out requires a path");
      continue;
    }
    if (arg === "--runs") {
      runs = Number(args[++i]);
      if (!Number.isInteger(runs) || runs < 1 || runs % 2 === 0) {
        fail(`--runs must be an odd positive integer, got ${String(args[i])}`);
      }
      continue;
    }
    if (arg === "--synthetic") {
      synthetic = Number(args[++i]);
      if (!Number.isInteger(synthetic) || synthetic < 0) {
        fail(`--synthetic must be a nonnegative integer, got ${String(args[i])}`);
      }
      continue;
    }
    fail(`unknown argument: ${arg ?? "(missing)"}`);
  }
  return { out, runs, synthetic };
}

const roundStats = (m: LatencyMeasurement) => ({
  median: {
    p50Ms: Math.round(m.median.p50Ms * 1e6) / 1e6,
    p95Ms: Math.round(m.median.p95Ms * 1e6) / 1e6,
    p99Ms: Math.round(m.median.p99Ms * 1e6) / 1e6,
  },
  runs: m.runs.map((r) => ({
    p50Ms: Math.round(r.p50Ms * 1e6) / 1e6,
    p95Ms: Math.round(r.p95Ms * 1e6) / 1e6,
    p99Ms: Math.round(r.p99Ms * 1e6) / 1e6,
  })),
});

function runShadowCli(): void {
  const args = parseArgs(process.argv.slice(2));
  const adapter = new ContractCorpusAdapter();
  const loaded = adapter.load();
  if (loaded.issues.length > 0) {
    fail(`golden corpus has ${loaded.issues.length} issue(s); refusing evaluation`);
  }
  const input = adapter.toRunInput(loaded);
  const config = { kValues: K_VALUES, abstainThreshold: 0 };

  const comparison = runShadowComparison(input, config);
  const goldenLatency = {
    legacy: roundStats(
      measureRankerLatency(evaluateCaseLegacy, input, config, { runs: args.runs }),
    ),
    wired: roundStats(measureRankerLatency(evaluateCase, input, config, { runs: args.runs })),
  };
  let syntheticLatency: Record<string, unknown> | undefined;
  if (args.synthetic > 0) {
    const entries = syntheticCorpus(input.entries, args.synthetic);
    const syntheticInput = { ...input, entries };
    syntheticLatency = {
      size: args.synthetic,
      legacy: roundStats(
        measureRankerLatency(evaluateCaseLegacy, syntheticInput, config, { runs: args.runs }),
      ),
      wired: roundStats(
        measureRankerLatency(evaluateCase, syntheticInput, config, { runs: args.runs }),
      ),
    };
  }

  const report = {
    benchmark: "engram-shadow-comparison",
    corpus: {
      name: input.meta.name,
      corpusVersion: input.meta.corpusVersion,
      contractHash: `sha256:${corpusSnapshotHash()}`,
      cases: input.queries.length,
      entries: input.entries.length,
    },
    comparison: {
      totals: comparison.totals,
      improved: comparison.improved,
      regressed: comparison.regressed,
      reorderedCount: comparison.reordered.length,
      deltas: comparison.deltas.map((d) => ({
        queryId: d.queryId,
        outcome: d.outcome,
        before: d.before,
        after: d.after,
      })),
    },
    latency: { golden: goldenLatency, synthetic: syntheticLatency },
    protocol: {
      runsPerRanker: args.runs,
      warmupRuns: 1,
      aggregation: "median of per-run nearest-rank percentiles",
      note: "latency is reported, never scored, and never enters the baseline gate",
    },
    generatedAtUtc: new Date().toISOString(),
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out !== undefined) {
    writeFileSync(args.out, text);
    console.log(`benchmark:shadow wrote ${args.out}`);
  } else {
    process.stdout.write(text);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runShadowCli();
}
