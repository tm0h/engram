import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeStats, readStats, recordUsage } from "../src/shared/stats.js";

vi.mock("node:fs/promises", { spy: true });

let home: string;
let file: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "engram-stats-"));
  const dir = join(home, ".engram", "stats");
  mkdirSync(dir, { recursive: true });
  file = join(dir, "events.json");
  vi.stubEnv("HOME", home);
  vi.stubEnv("ENGRAM_STATS", "on");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const read = () => Effect.runPromise(readStats());
const search = (matches = 1, source = "cli" as "cli" | "tool") =>
  ({ kind: "search", source, ms: 3, matches }) as const;
const show = (source = "cli" as "cli" | "tool") => ({ kind: "show", source }) as const;

it("retains only the newest 1000 events and rejects oversized files", async () => {
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      events: Array.from({ length: 1000 }, (_, at) => ({ at, usage: search(at ? 1 : 0) })),
    }),
  );
  await Effect.runPromise(recordUsage(show()));
  expect(await read()).toMatchObject({
    events: 1000,
    searches: { total: 999, zeroResults: 0 },
    showAfterSearch: { searchesWithShow: 0, shows: 1 },
  });
  writeFileSync(file, Buffer.alloc(512 * 1024 + 1));
  expect(await read()).toMatchObject({ state: "invalid", events: 0 });
});

it("only pairs the next show with the latest nonempty search on its own surface inside the time window", async () => {
  const events = [
    [0, search()],
    [1, search()],
    [2, show("tool")],
    [3, show()],
    [4, show()],
    [5, search()],
    [6, search(0)],
    [7, show()],
    [8, search()],
    [300_008, show()],
    [300_009, search()],
    [600_010, show()],
  ].map(([at, usage]) => ({ at, usage }));
  writeFileSync(file, JSON.stringify({ version: 1, events }));
  expect(await read()).toMatchObject({
    state: "available",
    showAfterSearch: { shows: 6, eligibleSearches: 5, searchesWithShow: 2, rate: 0.4 },
  });
});

it("serializes concurrent recording with disable and clear", async () => {
  await Effect.runPromise(
    Effect.all([recordUsage(search()), changeStats("disable"), recordUsage(search())], {
      concurrency: "unbounded",
    }),
  );
  const before = await read();
  expect(before.collection).toBe("disabled");
  await Effect.runPromise(recordUsage(search()));
  expect(await read()).toEqual(before);
  await Effect.runPromise(
    Effect.all([recordUsage(search()), changeStats("clear"), recordUsage(show())], {
      concurrency: "unbounded",
    }),
  );
  expect(await read()).toMatchObject({ state: "empty", collection: "disabled", events: 0 });
  vi.stubEnv("ENGRAM_STATS", "off");
  await Effect.runPromise(changeStats("enable"));
  await Effect.runPromise(recordUsage(search()));
  expect(await read()).toMatchObject({ collection: "disabled", events: 0 });
  expect(() => readFileSync(file)).toThrow();
});

it("returns on a stalled write and leaves cleanup to the writer that holds the lock", async () => {
  const lock = join(home, ".engram", "stats", ".lock");
  const { writeFile: realWriteFile } =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let notifyStarted!: () => void;
  let releaseWrite!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const stalled = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  vi.mocked(writeFile).mockImplementationOnce(async (target, data) => {
    notifyStarted();
    await stalled;
    // Simulate a write already submitted to the filesystem when aborted.
    await realWriteFile(target, data);
  });
  try {
    const recording = Effect.runPromise(recordUsage(search()));
    await started;
    await recording;
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(file)).toBe(false);
    await Effect.runPromise(recordUsage(search()));
    expect(existsSync(lock)).toBe(true);
  } finally {
    releaseWrite();
    await vi.waitFor(() => expect(existsSync(lock)).toBe(false));
  }
  expect(existsSync(file)).toBe(false);
  await Effect.runPromise(recordUsage(search()));
  expect(await read()).toMatchObject({ events: 1 });
}, 3000);
