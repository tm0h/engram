/**
 * Command-level ENG-45 links surface: `linksCommand` mirrors the shared
 * linksOp contract through core only (no harness import): exact ids, one
 * scope, authored outgoing order, chronological backlinks, MISSING/AMBIGUOUS
 * markers, private pagination with the CLI-form continuation footer, the hard
 * cap, validation before scanning, and reads that never write. Process-level
 * flag wiring lives in process.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { Effect } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConfigRepo,
  EngramStore,
  MainLive,
  slugify,
  stringifyFrontmatter,
  projectConfigPath,
  projectEngramsDir,
} from "@engram/core";
import { linksCommand } from "../src/commands/links.js";

describe("engram links command", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  let outLines: string[] = [];
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-links-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-links-home-"));
    fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
    fs.writeFileSync(
      projectConfigPath(tmp),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
    );
    fs.mkdirSync(path.join(home, ".engram", "engrams"), { recursive: true });
    process.chdir(tmp);
    process.env.HOME = home;
    outLines = [];
    spies = [
      vi.spyOn(console, "log").mockImplementation(((...args: unknown[]) => {
        outLines.push(args.map(String).join(" "));
        return undefined;
      }) as typeof console.log),
      vi.spyOn(console, "error").mockImplementation((() => undefined) as typeof console.error),
    ];
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const output = (): string => outLines.join("\n");
  const run = (eff: Effect.Effect<unknown, unknown, EngramStore | ConfigRepo>): Promise<void> =>
    Effect.runPromise(Effect.provide(eff as never, MainLive)) as Promise<void>;
  const runFail = (
    eff: Effect.Effect<unknown, unknown, EngramStore | ConfigRepo>,
  ): Promise<{ _tag?: string; message?: string }> =>
    Effect.runPromise(Effect.provide(Effect.flip(eff) as never, MainLive)) as Promise<{
      _tag?: string;
      message?: string;
    }>;

  const engramsDir = (): string => projectEngramsDir(tmp);

  const seedEntry = (
    id: string,
    title: string,
    over: { related?: string[]; created?: string; body?: string } = {},
  ): void => {
    const created = over.created ?? "2026-08-16T10:00:00.000Z";
    fs.writeFileSync(
      path.join(engramsDir(), `${id}-${slugify(title)}.md`),
      stringifyFrontmatter(over.body ?? `Body of ${title}\n`, {
        id,
        title,
        type: "note",
        tags: [],
        scope: "project",
        created,
        updated: created,
        ...(over.related !== undefined ? { related: over.related } : {}),
      }),
    );
  };

  const snapshotAll = (): string =>
    fs
      .readdirSync(engramsDir())
      .sort()
      .map((f) => fs.readFileSync(path.join(engramsDir(), f), "utf8"))
      .join("\n%%%\n");

  it("renders authored outgoing order with markers and chronological incoming rows", async () => {
    seedEntry("0001", "Root entry", { related: ["0005", "0002", "9999"] });
    seedEntry("0002", "Auth note");
    seedEntry("0005", "Newer peer");
    seedEntry("0007", "Early backlink", { related: ["0001"], created: "2026-08-15T10:00:00.000Z" });
    seedEntry("0008", "Tie backlink", { related: ["0001"], created: "2026-08-16T11:00:00.000Z" });
    seedEntry("0006", "Late backlink", { related: ["0001"], created: "2026-08-17T10:00:00.000Z" });

    await run(linksCommand("0001", { scope: "project" }));
    const out = output();
    expect(out).toContain("Links for 0001 - Root entry (note)");
    expect(out).toContain("Outgoing");
    expect(out.indexOf("0005")).toBeLessThan(out.indexOf("0002"));
    expect(out.indexOf("0002")).toBeLessThan(out.indexOf("9999"));
    expect(out).toContain("9999 MISSING");
    expect(out).toContain("Incoming");
    expect(out.indexOf("0007")).toBeLessThan(out.indexOf("0008"));
    expect(out.indexOf("0008")).toBeLessThan(out.indexOf("0006"));
    // eslint-disable-next-line no-control-regex -- intentionally detecting ANSI escapes
    expect(out).not.toMatch(/\u001b\[/);
  });

  it("treats a strict prefix as missing; the exact id resolves", async () => {
    seedEntry("0001", "One");
    seedEntry("0012", "Twelve");

    outLines = [];
    await run(linksCommand("001", { scope: "project" }));
    expect(output()).toContain("Links for 001 - MISSING");

    outLines = [];
    await run(linksCommand("0012", { scope: "project" }));
    expect(output()).toContain("Links for 0012 - Twelve (note)");
  });

  it("renders an ambiguous target with bounded claimant context", async () => {
    seedEntry("0005", "Claim A");
    seedEntry("0005", "Claim B");
    seedEntry("0005", "Claim C");
    seedEntry("0005", "Claim D");
    seedEntry("0002", "Referrer", { related: ["0005"] });

    await run(linksCommand("0005", { scope: "project" }));
    const out = output();
    expect(out).toContain("Links for 0005 - AMBIGUOUS (4 claimants)");
    expect(out.match(/0005-claim-[abcd]\.md/g)).toHaveLength(3);
    expect(out).toContain("+1 more");
    expect(out).toContain("0002 note Referrer");
  });

  it("renders (none) sections for an empty graph", async () => {
    seedEntry("0001", "Lonely");
    await run(linksCommand("0001", { scope: "project" }));
    const out = output();
    expect(out).toContain("Outgoing\n  (none)");
    expect(out).toContain("Incoming\n  (none)");
  });

  it("paginates with the CLI-form footer and follows the continuation", async () => {
    const authored = [
      "0005",
      "0002",
      "0013",
      "0004",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0003",
    ];
    seedEntry("0001", "Root entry", { related: authored });
    for (const id of authored) seedEntry(id, `Peer ${id}`);

    await run(linksCommand("0001", { scope: "project" }));
    expect(output()).toContain(
      "(showing 1-10 of 12 - call engram links 0001 --scope project --offset 10 for more)",
    );
    const page1Rows = output()
      .split("\n")
      .filter((l) => /^  \d{4} note /.test(l));
    expect(page1Rows).toHaveLength(10);

    outLines = [];
    await run(linksCommand("0001", { scope: "project", offset: 10 }));
    const page2Rows = output()
      .split("\n")
      .filter((l) => /^  \d{4} note /.test(l));
    expect(page2Rows).toHaveLength(2);
    expect(output()).not.toContain("call engram links");
    const combined = [
      ...page1Rows.map((l) => l.trimStart().split(" ")[0]),
      ...page2Rows.map((l) => l.trimStart().split(" ")[0]),
    ];
    expect(combined).toEqual(authored);
  });

  it("rejects invalid numeric options before scanning", async () => {
    seedEntry("0001", "Root");
    await expect(
      runFail(linksCommand("0001", { scope: "project", offset: -1 })),
    ).resolves.toMatchObject({
      message: "offset must be a nonnegative safe integer",
    });
    await expect(
      runFail(linksCommand("0001", { scope: "project", limit: 0 })),
    ).resolves.toMatchObject({
      message: "limit must be a positive safe integer",
    });
    await expect(
      runFail(linksCommand("0001", { scope: "project", limit: 101 })),
    ).resolves.toMatchObject({
      message: "limit must be at most 100",
    });
  });

  it("rejects scope values other than project or personal", async () => {
    await expect(runFail(linksCommand("0001", { scope: "banana" }))).resolves.toMatchObject({
      message: 'scope must be "project" or "personal"',
    });
  });

  it("fails uniformly on scan failures and uninitialized project scope", async () => {
    seedEntry("0001", "Root");
    fs.chmodSync(engramsDir(), 0o000);
    try {
      const ioFailure = await runFail(linksCommand("0001", { scope: "project" }));
      expect(ioFailure.message).toBeDefined();
    } finally {
      fs.chmodSync(engramsDir(), 0o755);
    }

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-links-empty-"));
    process.chdir(empty);
    try {
      const degraded = await runFail(linksCommand("0001", { scope: "project" }));
      expect(degraded._tag).toBe("ProjectNotInitializedError");
    } finally {
      process.chdir(tmp);
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("caps oversized rows and keeps the CLI continuation footer", async () => {
    seedEntry("0001", "Root entry", { related: ["0002", "0003"] });
    seedEntry("0002", "x".repeat(10_000));
    seedEntry("0003", "Small peer");

    await run(linksCommand("0001", { scope: "project", limit: 1 }));
    const out = output();
    expect(out.length).toBeLessThanOrEqual(8192);
    expect(out).toContain("(list truncated to fit the size cap)");
    expect(out).toContain(
      "(showing 1-1 of 2 - call engram links 0001 --scope project --offset 1 --limit 1 for more)",
    );

    outLines = [];
    await run(linksCommand("0001", { scope: "project", offset: 1, limit: 1 }));
    expect(output()).toContain("0003 note Small peer");
    expect(output()).not.toContain("call engram links");
  });

  it("keeps the no-footer truncated output within the hard cap (F1)", async () => {
    seedEntry("0001", "Root entry", { related: ["0003", "0002"] });
    seedEntry("0003", "Small peer");
    seedEntry("0002", "x".repeat(10_000));

    // Page 1: the small leading row fits; the oversized row is deferred.
    await run(linksCommand("0001", { scope: "project" }));
    expect(output()).toContain("0003 note Small peer");
    expect(output()).toContain("--offset 1 for more");

    // Page 2 holds the single oversized last row: no continuation exists, so
    // the no-footer truncated branch bounds it at the cap with the marker.
    outLines = [];
    await run(linksCommand("0001", { scope: "project", offset: 1 }));
    const out = output();
    expect(out.length).toBeLessThanOrEqual(8192);
    expect(out).toContain("(result truncated)");
    expect(out).not.toContain("call engram links");
  });

  it("continues at the first hidden row when the cap cuts the page (P1a)", async () => {
    seedEntry("0001", "Root entry", { related: ["0002", "0003", "0004"] });
    seedEntry("0002", "x".repeat(10_000));
    seedEntry("0003", "Peer 0003");
    seedEntry("0004", "Peer 0004");

    // Greptile's scenario: limit 2 over three links, first peer pathological.
    // The cap cuts the second row, so the continuation must point at the
    // first hidden row (1), never past it (2).
    await run(linksCommand("0001", { scope: "project", limit: 2 }));
    const page1 = output();
    expect(page1.length).toBeLessThanOrEqual(8192);
    expect(page1).toContain("(list truncated to fit the size cap)");
    expect(page1).toContain(
      "(showing 1-1 of 3 - call engram links 0001 --scope project --offset 1 --limit 2 for more)",
    );

    // Full reconstruction covers every row: page 2 starts at the hidden row.
    outLines = [];
    await run(linksCommand("0001", { scope: "project", offset: 1, limit: 2 }));
    expect(output()).toContain("0003 note Peer 0003");
    expect(output()).toContain("0004 note Peer 0004");
    expect(output()).not.toContain("call engram links");
  });

  it("never writes: files stay byte-identical across reads", async () => {
    seedEntry("0001", "Root entry", { related: ["0002"] });
    seedEntry("0002", "Peer 0002");
    const before = snapshotAll();

    await run(linksCommand("0001", { scope: "project" }));
    await run(linksCommand("0002", { scope: "project" }));
    await run(linksCommand("9999", { scope: "project" }));

    expect(snapshotAll()).toBe(before);
  });
});
