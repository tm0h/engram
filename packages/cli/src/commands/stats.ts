import { Effect } from "effect";
import { changeStats, readStats } from "@engram/harnesses/shared";
import { out } from "../io.js";

type StatsOptions = {
  readonly json?: boolean;
  readonly clear?: boolean;
  readonly disable?: boolean;
  readonly enable?: boolean;
};

const rate = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const average = (value: number | null) => (value === null ? "n/a" : value.toFixed(1));

export const statsCommand = (opts: StatsOptions) =>
  Effect.gen(function* () {
    if (opts.disable) yield* changeStats("disable", opts.clear);
    else if (opts.enable) yield* changeStats("enable", opts.clear);
    else if (opts.clear) yield* changeStats("clear");
    const report = yield* readStats();
    if (opts.json) return yield* out(JSON.stringify(report, null, 2));

    yield* out(`Collection: ${report.collection}`);
    if (report.state === "empty") return yield* out("No usage statistics recorded.");
    if (report.state === "invalid")
      return yield* out("Statistics file is invalid. Use engram stats --clear to reset it.");
    if (report.state === "unavailable")
      return yield* out("Local usage statistics are unavailable.");

    const { loads, searches, showAfterSearch, contextBytes, latencyMs, candidates } = report;
    yield* out(`Events: ${report.events} (up to ${report.retention.maxEvents} retained)`);
    yield* out(`Loads: ${loads.total} (${loads.withContext} with context)`);
    yield* out(
      `Load outcomes: ${
        Object.entries(loads.outcomes)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ") || "none"
      }`,
    );
    yield* out(
      `Searches: ${searches.total} (${searches.zeroResults} zero-result, ${rate(searches.zeroResultRate)})`,
    );
    yield* out(
      `Shows: ${showAfterSearch.shows}; searches followed by a show within 5 minutes: ${showAfterSearch.searchesWithShow}/${showAfterSearch.eligibleSearches} (${rate(showAfterSearch.rate)})`,
    );
    yield* out(
      `Context bytes: ${contextBytes.total} total, ${average(contextBytes.average)} average, ${contextBytes.max} max`,
    );
    yield* out(
      `Load latency (ms): ${average(latencyMs.load.average)} average, ${latencyMs.load.max} max`,
    );
    yield* out(
      `Search latency (ms): ${average(latencyMs.search.average)} average, ${latencyMs.search.max} max`,
    );
    for (const [source, totals] of Object.entries(candidates)) {
      yield* out(
        `Candidate decisions (${source}): ${Object.entries(totals)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}`,
      );
    }
  });
