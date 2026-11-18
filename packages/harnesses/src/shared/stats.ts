import { Effect, Schema } from "effect";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { globalRoot } from "@engram/core";
import type { OpResult } from "./types.js";

const MAX_EVENTS = 1000;
const MAX_BYTES = 512 * 1024;
const SHOW_WINDOW_MS = 5 * 60 * 1000;
const Count = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));
const Source = Schema.Literals(["cli", "tool"]);
const Outcome = Schema.Literals([
  "loaded",
  "empty",
  "disabled",
  "unavailable",
  "timeout",
  "invalid-input",
  "empty-query",
  "weak",
  "excluded",
]);
const Decisions = Schema.Struct({
  ranked: Count,
  weak: Count,
  duplicate: Count,
  selected: Count,
  limited: Count,
  budget: Count,
  inactive: Count,
  scoped: Count,
  uncurated: Count,
});
const Usage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("search"), source: Source, ms: Count, matches: Count }),
  Schema.Struct({ kind: Schema.Literal("show"), source: Source }),
  Schema.Struct({
    kind: Schema.Literal("load"),
    source: Schema.Literals(["cli", "tool", "hook", "bootstrap", "recall"]),
    ms: Count,
    bytes: Count,
    outcome: Outcome,
    decisions: Schema.optional(Decisions),
  }),
]);
const History = Schema.Struct({
  version: Schema.Literal(1),
  events: Schema.Array(Schema.Struct({ at: Count, usage: Usage })),
});
const decodeHistory = Schema.decodeUnknownSync(History);
const decodeUsage = Schema.decodeUnknownSync(Usage);

type Usage = Schema.Schema.Type<typeof Usage>;
type Outcome = Schema.Schema.Type<typeof Outcome>;
type History = Schema.Schema.Type<typeof History>;
type Collection = "enabled" | "disabled" | "unavailable";
type DataState = "available" | "empty" | "invalid" | "unavailable";

const emptyDecisions = () => ({
  ranked: 0,
  weak: 0,
  duplicate: 0,
  selected: 0,
  limited: 0,
  budget: 0,
  inactive: 0,
  scoped: 0,
  uncurated: 0,
});

const paths = () => {
  const dir = path.join(globalRoot(), "stats");
  return {
    dir,
    file: path.join(dir, "events.json"),
    marker: path.join(dir, "disabled"),
    lock: path.join(dir, ".lock"),
  };
};
type Paths = ReturnType<typeof paths>;
const hasCode = (error: unknown, code: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function checkDirectory(files: Paths) {
  try {
    if (!(await lstat(files.dir)).isDirectory())
      throw new Error("Statistics path is not a directory.");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

const blockedByEnvironment = () => process.env.ENGRAM_STATS === "off";

async function readHistory(file: string): Promise<History["events"] | null> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  if (!handle) return [];
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(info.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead !== info.size) return null;
    try {
      const { events } = decodeHistory(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
      return events.length <= MAX_EVENTS ? events : null;
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

// The lock serializes append, clear and collection changes across processes.
// Readers see either complete snapshot via rename. Contention has a bounded
// retry budget so failed or abandoned writers do not stall memory reads.
async function withLock<A>(files: Paths, run: () => Promise<A>): Promise<A> {
  await mkdir(files.dir, { mode: 0o700, recursive: true });
  await checkDirectory(files);
  for (const delay of [2, 4, 6, 10, 16, 22, 0]) {
    try {
      await mkdir(files.lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (delay === 0) throw new Error("Local statistics are locked.");
      await setTimeout(delay);
    }
  }
  const temp = path.join(files.lock, "events.json");
  try {
    return await run();
  } finally {
    try {
      await rm(temp, { force: true });
    } finally {
      await rmdir(files.lock);
    }
  }
}

export const recordUsage = (usage: Usage) =>
  Effect.tryPromise(async () => {
    if (blockedByEnvironment()) return;
    const files = paths();
    await checkDirectory(files);
    if (await exists(files.marker)) return;
    await withLock(files, async () => {
      if (await exists(files.marker)) return;
      const events = await readHistory(files.file);
      if (events === null) return;
      const event = { at: Date.now(), usage: decodeUsage(usage) };
      const next = [...events.slice(1 - MAX_EVENTS), event];
      const temp = path.join(files.lock, "events.json");
      await writeFile(temp, JSON.stringify({ version: 1, events: next }), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temp, files.file);
    });
  }).pipe(Effect.ignore);

export const changeStats = (action: "clear" | "enable" | "disable", clearHistory = false) =>
  Effect.tryPromise({
    try: async () => {
      const files = paths();
      await checkDirectory(files);
      if (action !== "disable" && !(await exists(files.dir))) return;
      await withLock(files, async () => {
        if (action === "disable") {
          if (!(await exists(files.marker))) {
            await writeFile(files.marker, "", { flag: "wx", mode: 0o600 });
          }
        }
        if (action === "enable") await rm(files.marker, { force: true });
        if (action === "clear" || clearHistory) await rm(files.file, { force: true });
      });
    },
    catch: (error) => new Error(`Could not ${action} local statistics: ${String(error)}`),
  });

export const elapsedUsageMs = (started: number) => Math.round(performance.now() - started);

export const recordBootstrapUsage = (
  source: "hook" | "bootstrap",
  ms: number,
  result: OpResult | undefined,
  text: string,
) => {
  const details = result?.details;
  const outcome: Outcome = !result
    ? "timeout"
    : details?.error
      ? "unavailable"
      : details?.enabled === false
        ? "disabled"
        : text
          ? "loaded"
          : "empty";
  const bootstrap = details?.bootstrap as
    | {
        selected: readonly unknown[];
        skippedLimit: number;
        skippedBudget: number;
        excluded: Record<string, number>;
      }
    | undefined;
  return recordUsage({
    kind: "load",
    source,
    ms,
    bytes: Buffer.byteLength(text),
    outcome,
    ...(bootstrap && {
      decisions: {
        ...emptyDecisions(),
        selected: bootstrap.selected.length,
        limited: bootstrap.skippedLimit,
        budget: bootstrap.skippedBudget,
        inactive: bootstrap.excluded.inactive ?? 0,
        scoped: bootstrap.excluded.scoped ?? 0,
        uncurated: bootstrap.excluded.uncurated ?? 0,
      },
    }),
  });
};

export const recordRecallUsage = (ms: number, result: OpResult) => {
  const details = result.details;
  const outcome = (details.reason === "selected" ? "loaded" : details.reason) as Outcome;
  const ranked = details.rankedCount as number | undefined;
  const confident = details.confidentCount as number;
  const duplicate = details.duplicateCount as number;
  const selected = (details.selected as readonly unknown[]).length;
  const limited = details.limitedCount as number;
  return recordUsage({
    kind: "load",
    source: "recall",
    ms,
    bytes: Buffer.byteLength(result.text),
    outcome,
    ...(ranked !== undefined && {
      decisions: {
        ...emptyDecisions(),
        ranked,
        weak: ranked - confident,
        duplicate,
        selected,
        limited,
        budget: confident - duplicate - selected - limited,
      },
    }),
  });
};

function summarize(state: DataState, collection: Collection, events: History["events"] = []) {
  const loads = { total: 0, withContext: 0, outcomes: {} as Partial<Record<Outcome, number>> };
  const searches = { total: 0, zeroResults: 0 };
  const showAfterSearch = { shows: 0, eligibleSearches: 0, searchesWithShow: 0 };
  const pending: Partial<Record<"cli" | "tool", number>> = {};
  const candidates = { bootstrap: emptyDecisions(), recall: emptyDecisions() };
  const latency = { load: { sum: 0, max: 0 }, search: { sum: 0, max: 0 } };
  const context = { sum: 0, max: 0 };
  for (const { at, usage } of events) {
    if (usage.kind === "show") {
      showAfterSearch.shows++;
      const last = pending[usage.source];
      if (last !== undefined && at >= last && at - last <= SHOW_WINDOW_MS) {
        showAfterSearch.searchesWithShow++;
        delete pending[usage.source];
      }
      continue;
    }
    const timing = latency[usage.kind];
    timing.sum += usage.ms;
    timing.max = Math.max(timing.max, usage.ms);
    if (usage.kind === "search") {
      searches.total++;
      if (usage.matches === 0) {
        searches.zeroResults++;
        delete pending[usage.source];
      } else {
        showAfterSearch.eligibleSearches++;
        pending[usage.source] = at;
      }
    } else {
      loads.total++;
      if (usage.bytes > 0) loads.withContext++;
      loads.outcomes[usage.outcome] = (loads.outcomes[usage.outcome] ?? 0) + 1;
      context.sum += usage.bytes;
      context.max = Math.max(context.max, usage.bytes);
      if (
        usage.decisions &&
        (usage.source === "recall" || usage.source === "bootstrap" || usage.source === "hook")
      ) {
        const totals = candidates[usage.source === "recall" ? "recall" : "bootstrap"];
        for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
          totals[key] += usage.decisions[key];
        }
      }
    }
  }
  const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
  return {
    report: "stats",
    version: 1,
    state,
    collection,
    events: events.length,
    retention: { maxEvents: MAX_EVENTS, showWindowMs: SHOW_WINDOW_MS },
    loads,
    searches: { ...searches, zeroResultRate: ratio(searches.zeroResults, searches.total) },
    showAfterSearch: {
      ...showAfterSearch,
      rate: ratio(showAfterSearch.searchesWithShow, showAfterSearch.eligibleSearches),
    },
    contextBytes: {
      total: context.sum,
      max: context.max,
      average: ratio(context.sum, loads.withContext),
    },
    latencyMs: {
      load: { max: latency.load.max, average: ratio(latency.load.sum, loads.total) },
      search: { max: latency.search.max, average: ratio(latency.search.sum, searches.total) },
    },
    candidates,
  };
}

export const readStats = () =>
  Effect.promise(async () => {
    const files = paths();
    let collection: Collection = blockedByEnvironment() ? "disabled" : "unavailable";
    try {
      await checkDirectory(files);
      if (collection !== "disabled") {
        collection = (await exists(files.marker)) ? "disabled" : "enabled";
      }
      const events = await readHistory(files.file);
      return events === null
        ? summarize("invalid", collection)
        : summarize(events.length ? "available" : "empty", collection, events);
    } catch {
      return summarize("unavailable", collection);
    }
  });
