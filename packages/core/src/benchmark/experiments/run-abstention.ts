import { evaluateCase } from "@engram/core/corpus";
import { evaluateAbstention } from "../../abstention.js";
import { effectiveStatus } from "../../domain.js";
import { parseQuery } from "../../query.js";
import { rankEntries } from "../../rank.js";
import { ContractCorpusAdapter } from "../adapter.js";
import { corpusSnapshotHash, K_VALUES } from "../run.js";
import { runBenchmark } from "../runner.js";
import { measureRankerLatency } from "../shadow.js";
import type { BenchmarkResult, RunInput } from "../types.js";
import { heldOutSuites } from "./abstention-held-out.js";
import { evaluateIntentAbstention } from "./abstention.js";

const targets = ["case-abstention-12", "case-abstention-14"];
const focus = new Set([
  ...targets,
  "case-abstention-11",
  "case-exact-facts-24",
  "case-multi-token-02",
  "case-paraphrase-19",
  "case-paraphrase-30",
]);
const config = { kValues: K_VALUES, abstainThreshold: 0 };

function summarize({ metrics }: BenchmarkResult) {
  const answered = metrics.perQuery.filter((row) => !row.abstained).length;
  return {
    cases: metrics.queryCount,
    passed: metrics.passedCount,
    answered,
    answerCoverage: answered / metrics.queryCount,
    correctAbstentions: metrics.abstentionCorrect,
    expectedAbstentions: metrics.abstentionEligible,
    falseAbstentions: metrics.falseAbstainCases,
    falseAbstainRate: metrics.falseAbstainRate,
    recallAt5: metrics.kMetrics.find(({ k }) => k === 5)?.recall,
  };
}

function compare(input: RunInput, heldOut: boolean) {
  const baseline = runBenchmark(evaluateCase, input, config);
  const candidate = runBenchmark(evaluateIntentAbstention, input, config);
  const titles = new Map(input.entries.map((entry) => [entry.id, entry.title]));
  const candidateById = new Map(candidate.metrics.perQuery.map((row) => [row.queryId, row]));
  const rows = baseline.metrics.perQuery.map((before, index) => {
    const after = candidateById.get(before.queryId)!;
    const query = input.queries.find(({ id }) => id === before.queryId)!;
    const beforeIds = baseline.outcomes[index]!.rankedIds;
    const afterIds = candidate.outcomes[index]!.rankedIds;

    return {
      id: before.queryId,
      query: query.query,
      expectedAbstain: before.expectedAbstain,
      requiredIds: query.relevantIds,
      before: {
        passed: before.passed,
        returned: before.returned,
        rankedIds: beforeIds,
        topTitles: beforeIds.slice(0, 3).map((id) => titles.get(id)),
      },
      after: {
        passed: after.passed,
        returned: after.returned,
        rankedIds: afterIds,
        topTitles: afterIds.slice(0, 3).map((id) => titles.get(id)),
      },
    };
  });
  const regressions = rows.filter(({ before, after }) => before.passed && !after.passed);
  const improvements = rows.filter(({ before, after }) => !before.passed && after.passed);
  const lexicalEvidence = input.queries
    .filter(({ id }) => heldOut || focus.has(id))
    .map((query) => {
      const parsed = parseQuery(query.query);
      const scoped = input.entries.filter(
        (entry) =>
          entry.scope === query.scope &&
          (query.source.includeInactive || effectiveStatus(entry, query.nowMs) === "active"),
      );
      const ranked = rankEntries(scoped, parsed, { explain: true });
      return { id: query.id, ...evaluateAbstention(scoped, parsed, ranked) };
    });
  return {
    baseline: summarize(baseline),
    candidate: summarize(candidate),
    regressions: regressions.map(({ id }) => id),
    improvements: improvements.map(({ id }) => id),
    lexicalEvidence,
    cases: rows,
  };
}

const adapter = new ContractCorpusAdapter();
const loaded = adapter.load();
const input = adapter.toRunInput(loaded);
const corpus = compare(input, false);
const heldOut = Object.fromEntries(
  Object.entries(heldOutSuites(loaded)).map(([name, suite]) => [
    name,
    compare(adapter.toRunInput(suite), true),
  ]),
);
const suites = [corpus, ...Object.values(heldOut)];
const criteria = {
  targetsAbstain: targets.every((id) =>
    corpus.cases.some((row) => row.id === id && row.after.passed && row.after.returned === 0),
  ),
  noRegressions: suites.every((suite) => suite.regressions.length === 0),
  zeroFalseAbstentions: suites.every((suite) => suite.candidate.falseAbstentions === 0),
};
const latencyOptions = { warmup: 3, runs: 7 };

console.log(
  JSON.stringify(
    {
      corpusVersion: input.meta.corpusVersion,
      contractHash: `sha256:${corpusSnapshotHash()}`,
      corpus,
      heldOut,
      criteria,
      accepted: Object.values(criteria).every(Boolean),
      latencyMs: {
        ...latencyOptions,
        baseline: measureRankerLatency(evaluateCase, input, config, latencyOptions).median,
        candidate: measureRankerLatency(evaluateIntentAbstention, input, config, latencyOptions)
          .median,
      },
    },
    null,
    2,
  ),
);
