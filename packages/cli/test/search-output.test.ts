import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MainLive, projectConfigPath, projectEngramsDir } from "@engram/core";
import { searchCommand } from "../src/commands/search.js";

describe("search JSON and explanations", () => {
  let root: string;
  let original: string;
  let originalHome: string | undefined;
  let lines: string[];
  beforeEach(() => {
    original = process.cwd();
    originalHome = process.env.HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "engram-search-json-"));
    fs.mkdirSync(projectEngramsDir(root), { recursive: true });
    fs.writeFileSync(
      projectConfigPath(root),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
    );
    for (const [id, title, body] of [
      ["0001", "Auth choice", "private body"],
      ["0002", "Other", "auth private detail"],
    ]) {
      fs.writeFileSync(
        path.join(projectEngramsDir(root), `${id}-entry.md`),
        `---\nid: "${id}"\ntitle: ${title}\ntype: note\ntags: []\nscope: project\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n${body}\n`,
      );
    }
    process.chdir(root);
    const taskHome = path.join(root, "test-home");
    fs.mkdirSync(path.join(taskHome, ".engram", "engrams"), { recursive: true });
    const personal = fs
      .readFileSync(path.join(projectEngramsDir(root), "0001-entry.md"), "utf8")
      .replace("scope: project", "scope: personal")
      .replace("Auth choice", "Auth personal");
    fs.writeFileSync(path.join(taskHome, ".engram", "engrams", "0001-personal.md"), personal);
    process.env.HOME = taskHome;
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(original);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const run = (opts: Parameters<typeof searchCommand>[1], query = "auth") =>
    Effect.runPromise(
      searchCommand(query, { scope: "project", ...opts }).pipe(Effect.provide(MainLive)),
    );

  it("emits one JSON document with pagination and no memory bodies or filesystem paths", async () => {
    await run({ json: true, explain: true, limit: 1, offset: 1 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      schemaVersion: 1,
      query: "auth",
      total: 2,
      offset: 1,
      limit: 1,
      nextOffset: null,
      results: [
        {
          id: "0002",
          score: 1,
          explanation: { contributions: [{ field: "body", token: "auth", score: 1 }] },
        },
      ],
    });
    expect(lines[0]).not.toContain("private detail");
    expect(lines[0]).not.toContain(root);
  });
  it("emits empty JSON without a prose trailer", async () => {
    await run({ json: true }, "nomatch");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ results: [], total: 0, nextOffset: null });
  });
  it("renders score reasons only with explain", async () => {
    await run({ explain: true, limit: 1 });
    expect(lines.join("\n")).toContain("title");
    expect(lines.join("\n")).toContain("score=3");
    expect(lines.join("\n")).not.toContain("private body");
  });
  it("preserves default text output and does not add explanations", async () => {
    await run({ limit: 1 });
    expect(lines.join("\n")).toContain("Auth choice");
    expect(lines.join("\n")).toContain("private body");
    expect(lines.join("\n")).not.toContain("contributions");
  });
  it("keeps legacy scope headers and per-scope limits", async () => {
    await run({ scope: "all", limit: 1 });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("Project");
    expect(lines[1]).toContain("Auth choice");
    expect(lines[2]).toBe("");
    expect(lines[3]).toContain("Personal");
    expect(lines[4]).toContain("Auth personal");
  });
  it("uses one global limit across scopes in JSON mode", async () => {
    await run({ scope: "all", json: true, limit: 1 });
    expect(JSON.parse(lines[0])).toMatchObject({
      total: 3,
      nextOffset: 1,
      results: [{ scope: "project" }],
    });
  });
  it("rejects offset without an explicit structured or explain mode", async () => {
    await expect(run({ offset: 1 })).rejects.toThrow();
    expect(lines).toEqual([]);
  });
  it("leaves pagination totals intact beyond the last page", async () => {
    await run({ json: true, offset: 100, limit: 1 });
    expect(JSON.parse(lines[0])).toMatchObject({
      total: 2,
      results: [],
      offset: 100,
      nextOffset: null,
    });
  });
  it.each([{ limit: 0 }, { limit: NaN }, { offset: -1 }, { offset: 0.5 }])(
    "rejects invalid pagination %j without stdout",
    async (opts) => {
      await expect(run({ json: true, ...opts })).rejects.toThrow();
      expect(lines).toEqual([]);
    },
  );
});
