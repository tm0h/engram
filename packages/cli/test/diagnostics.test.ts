import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const entry = new URL("../src/index.ts", import.meta.url).pathname;
const nodeArgs = ["--import", import.meta.resolve("tsx"), entry];
const exec = promisify(execFile);

describe("local diagnostics and statistics", () => {
  let root: string;
  let home: string;
  let project: string;
  let events: string;
  const options = () => ({
    cwd: project,
    encoding: "utf8" as const,
    env: {
      ...process.env,
      HOME: home,
      ENGRAM_STATS: "on",
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    },
  });
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [...nodeArgs, ...args], options());
  const json = (...args: string[]) => JSON.parse(cli(...args, "--json"));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "engram-diagnostics-"));
    home = join(root, "home");
    project = join(root, "project");
    events = join(home, ".engram", "stats", "events.json");
    mkdirSync(home);
    mkdirSync(project);
  });
  afterEach(() => rmSync(root, { force: true, recursive: true }));

  it("reports unavailable, empty and unhealthy scopes alongside config and integration state", () => {
    expect(json("doctor")).toMatchObject({
      report: "doctor",
      configuration: { automaticContext: "enabled" },
      scopes: [
        { scope: "project", state: "unavailable" },
        { scope: "personal", state: "unavailable" },
      ],
      index: { state: "on-demand" },
    });
    expect(existsSync(join(home, ".engram"))).toBe(false);
    cli("init", "--untracked");
    cli("config", "set", "autoContext", "off");
    expect(json("doctor").configuration.automaticContext).toBe("disabled");
    cli("install", "claude-code", "--yes");
    mkdirSync(join(home, ".engram", "engrams"), { recursive: true });
    cli(
      "add",
      "Lifecycle example",
      "--title",
      "Lifecycle example",
      "--review-after",
      "2000-01-01T00:00:00Z",
    );
    expect(json("doctor").scopes[0]).toMatchObject({
      state: "healthy",
      diagnostics: [expect.objectContaining({ code: "review_due", severity: "warning" })],
    });
    writeFileSync(join(project, ".engram", "engrams", "0001-broken.md"), "malformed");
    writeFileSync(join(home, ".engram", "config.json"), "{");
    expect(json("doctor")).toMatchObject({
      configuration: { automaticContext: "unavailable", personal: "unhealthy" },
      integrations: expect.arrayContaining([
        expect.objectContaining({
          target: "claude-code",
          state: "installed",
          runtime: "unknown",
          assets: expect.any(Array),
        }),
      ]),
      scopes: [
        { scope: "project", state: "unhealthy", omittedFiles: 1, diagnostics: expect.any(Array) },
        { scope: "personal", state: "empty" },
      ],
    });
    expect(cli("doctor")).toContain("project store: unhealthy");
  }, 25_000);

  it("counts completed reads, keeps private input out of storage, and supports disable and clear", async () => {
    expect(json("stats")).toMatchObject({ state: "empty", collection: "enabled", events: 0 });
    expect(cli("stats")).toContain("No usage statistics");
    cli("init", "--untracked");
    const added = cli("add", "privatebodyneedle", "--title", "Private Title", "--pinned");
    const id = /\b[0-9a-hjkmnp-tv-z]{26}\b/.exec(added)?.[0];
    expect(id).toBeDefined();
    cli("context");
    cli("search", "privatebodyneedle", "--json", "--offset", "1");
    cli("show", id!);
    cli("search", "title:privatequeryneedle");
    expect(json("stats")).toMatchObject({
      state: "available",
      events: 4,
      loads: { total: 1, withContext: 1 },
      searches: { total: 2, zeroResults: 1, zeroResultRate: 0.5 },
      showAfterSearch: { shows: 1, eligibleSearches: 1, searchesWithShow: 1, rate: 1 },
    });
    expect(cli("stats")).toContain("Searches: 2");
    const raw = readFileSync(events, "utf8");
    for (const secret of [
      "privatebodyneedle",
      "privatequeryneedle",
      "Private Title",
      id!,
      project,
    ]) {
      expect(raw).not.toContain(secret);
    }
    cli("stats", "--disable");
    cli("search", "privatebodyneedle");
    expect(json("stats")).toMatchObject({ collection: "disabled", events: 4 });
    expect(json("stats", "--clear")).toMatchObject({ state: "empty", collection: "disabled" });
    expect(existsSync(events)).toBe(false);
    cli("stats", "--enable");
    cli("search", "privatebodyneedle");
    expect(cli("hook", "claude-code", "startup")).toContain("Private Title");
    // The hook can return context before its statistics child finishes.
    await vi.waitFor(
      () =>
        expect(json("stats")).toMatchObject({
          state: "available",
          events: 2,
          loads: { total: 1, withContext: 1 },
          candidates: { bootstrap: { selected: 1 } },
        }),
      { timeout: 5_000, interval: 100 },
    );
  }, 30_000);

  it("retains concurrent CLI writes and fails open on invalid or locked statistics", async () => {
    const writes = await Promise.all(
      Array.from({ length: 6 }, () =>
        exec(process.execPath, [...nodeArgs, "search", "inventedtoken", "--json"], options()),
      ),
    );
    for (const { stdout, stderr } of writes) {
      expect(JSON.parse(stdout)).toMatchObject({ total: 0 });
      expect(stderr).toBe("");
    }
    expect(json("stats")).toMatchObject({ events: 6 });
    writeFileSync(events, "{");
    expect(json("search", "inventedtoken")).toMatchObject({ total: 0 });
    expect(json("stats")).toMatchObject({ state: "invalid", events: 0 });
    cli("stats", "--clear");
    mkdirSync(join(home, ".engram", "stats", ".lock"));
    expect(json("search", "inventedtoken")).toMatchObject({ total: 0 });
    expect(json("stats")).toMatchObject({ state: "empty", events: 0 });
  }, 25_000);
  it("lets a hook exit with its context while a statistics write is stalled", async () => {
    cli("init", "--untracked");
    cli("add", "Example context", "--title", "Hook context", "--pinned");
    const preload = join(root, "stall-stats.cjs");
    const started = join(root, "started");
    const aborted = join(root, "aborted");
    const release = join(root, "release");
    const lock = join(home, ".engram", "stats", ".lock");
    writeFileSync(
      preload,
      `
      const fs = require("node:fs");
      const pending = require("node:fs/promises");
      const { setTimeout } = require("node:timers/promises");
      const original = pending.writeFile;
      pending.writeFile = async (target, ...args) => {
        if (typeof target === "string" && target.endsWith("/.lock/events.json")) {
          fs.writeFileSync(${JSON.stringify(started)}, "");
          args[1]?.signal?.addEventListener("abort", () => fs.writeFileSync(${JSON.stringify(aborted)}, ""), { once: true });
          for (let attempt = 0; attempt < 500; attempt++) {
            if (fs.existsSync(${JSON.stringify(release)})) break;
            await setTimeout(20);
          }
        }
        return original(target, ...args);
      };
      require("node:module").syncBuiltinESMExports();
    `,
    );
    try {
      const output = execFileSync(
        process.execPath,
        ["--require", preload, ...nodeArgs, "hook", "claude-code", "startup"],
        { ...options(), timeout: 5000 },
      );
      expect(output).toContain("Hook context");
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 5000 });
      await vi.waitFor(() => expect(existsSync(aborted)).toBe(true));
      expect(existsSync(lock)).toBe(true);
    } finally {
      writeFileSync(release, "");
      await vi.waitFor(() => expect(existsSync(lock)).toBe(false));
    }
    expect(existsSync(events)).toBe(false);
  }, 20_000);
});
