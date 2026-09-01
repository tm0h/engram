/**
 * `engram list` and `engram context` integrity-warning behavior: malformed
 * entries can no longer vanish silently. List stays fail-open with exactly
 * one bounded warning on stderr; context prepends the same bounded warning
 * to captured stdout (agents may ignore stderr) plus bounded duplicate-id
 * visibility. Runs the real command Effects over MainLive with output
 * captured; nothing here shells out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { Effect } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MainLive, projectConfigPath, projectEngramsDir } from "@engram/core";
import { EngramStore, ConfigRepo } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { listCommand } from "../src/commands/list.js";
import { contextCommand } from "../src/commands/context.js";

/* ------------------------------ helpers ------------------------------ */

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-read-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

const mkHome = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-rhome-"));
  fs.mkdirSync(path.join(tmp, ".engram", "engrams"), { recursive: true });
  return tmp;
};

const seedBroken = (dir: string, name: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "---\ntitle: [unclosed\n---\nBody\n");
  return file;
};

describe("list and context integrity warnings", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  let outLines: string[] = [];
  let errLines: string[] = [];
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = mkHome();
    process.chdir(tmp);
    process.env.HOME = home;
    outLines = [];
    errLines = [];
    spies = [
      vi.spyOn(console, "log").mockImplementation(((...args: unknown[]) => {
        outLines.push(args.map(String).join(" "));
        return undefined;
      }) as typeof console.log),
      vi.spyOn(console, "error").mockImplementation(((...args: unknown[]) => {
        errLines.push(args.map(String).join(" "));
        return undefined;
      }) as typeof console.error),
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
  const errors = (): string => errLines.join("\n");
  const warningLines = (): string[] =>
    errLines.concat(outLines).filter((l) => l.includes("WARNING: Engram memory is incomplete"));

  const run = <A>(
    eff: Effect.Effect<A, unknown, EngramStore | ConfigRepo | FileSystem | Path>,
  ): Promise<A> => Effect.runPromise(Effect.provide(eff, MainLive)) as Promise<A>;

  const addProject = (title: string): Promise<unknown> =>
    run(
      Effect.gen(function* () {
        const store = yield* EngramStore;
        return yield* store.add("project", {
          title,
          type: "note",
          tags: [],
          body: "b",
          pinned: false,
          author: undefined,
        });
      }),
    );

  const addPersonal = (title: string): Promise<unknown> =>
    run(
      Effect.gen(function* () {
        const store = yield* EngramStore;
        return yield* store.add("personal", {
          title,
          type: "note",
          tags: [],
          body: "b",
          pinned: false,
          author: undefined,
        });
      }),
    );

  /* ------------------------------ list ------------------------------ */

  it("list returns valid entries when one sibling is malformed", async () => {
    await addProject("Healthy note");
    seedBroken(projectEngramsDir(tmp), "0001-broken.md");
    await run(listCommand({}));
    expect(output()).toContain("Healthy note");
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain("Skipped 1 unreadable or invalid file");
    expect(errors()).toContain("engram check --scope all");
  });

  it("list stays fail-open (resolves) despite malformed entries", async () => {
    seedBroken(projectEngramsDir(tmp), "0001-broken.md");
    await expect(run(listCommand({}))).resolves.toBeUndefined();
  });

  it("list does not claim the store is empty when malformed candidates exist", async () => {
    seedBroken(projectEngramsDir(tmp), "0001-broken.md");
    await run(listCommand({}));
    expect(output()).toContain("(no readable engrams)");
    expect(output()).not.toContain("No engrams yet");
  });

  it("a clean empty list still says No engrams yet with no warning", async () => {
    await run(listCommand({}));
    expect(output()).toContain("No engrams yet");
    expect(warningLines()).toHaveLength(0);
  });

  it("warnings aggregate across scopes into exactly one line", async () => {
    seedBroken(projectEngramsDir(tmp), "0001-broken.md");
    seedBroken(projectEngramsDir(tmp), "0002-broken.md");
    seedBroken(path.join(home, ".engram", "engrams"), "0003-broken.md");
    seedBroken(path.join(home, ".engram", "engrams"), "0004-broken.md");
    seedBroken(path.join(home, ".engram", "engrams"), "0005-broken.md");
    await run(listCommand({ scope: "all" }));
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain("Skipped 5 unreadable or invalid files");
  });

  it("the warning length does not grow with 1, 10, or 1000 malformed files", async () => {
    const warnings: string[] = [];
    for (const n of [1, 10, 1000]) {
      fs.rmSync(projectEngramsDir(tmp), { recursive: true, force: true });
      fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
      for (let i = 0; i < n; i++) {
        seedBroken(projectEngramsDir(tmp), `broken-${String(i).padStart(4, "0")}.md`);
      }
      outLines = [];
      errLines = [];
      await run(listCommand({}));
      expect(warningLines()).toHaveLength(1);
      warnings.push(warningLines()[0]);
    }
    // same template; only the count (and its plural form) differs
    const normalize = (s: string): string =>
      s.replace(/\d+/g, "#").replace("invalid file.", "invalid files.");
    expect(normalize(warnings[0])).toBe(normalize(warnings[1]));
    expect(normalize(warnings[1])).toBe(normalize(warnings[2]));
    // bounded: no file lists, no content
    for (const w of warnings) {
      expect(w.length).toBeLessThan(200);
      expect(w).not.toContain(".md");
    }
  });

  /* ----------------------------- context ----------------------------- */

  it("context returns valid entries and prepends one warning", async () => {
    await addProject("Healthy note");
    seedBroken(projectEngramsDir(tmp), "0001-broken.md");
    await run(contextCommand({}));
    expect(output().startsWith("WARNING: Engram memory is incomplete")).toBe(true);
    expect(warningLines()).toHaveLength(1);
    expect(output()).toContain("Healthy note");
  });

  it("context with only malformed entries still warns and never claims empty", async () => {
    seedBroken(projectEngramsDir(tmp), "0001-broken.md");
    await run(contextCommand({}));
    expect(output().startsWith("WARNING: Engram memory is incomplete")).toBe(true);
    expect(output()).toContain("(no engrams available)");
  });

  it("context aggregates scope warnings into one", async () => {
    seedBroken(projectEngramsDir(tmp), "0001-broken.md");
    seedBroken(path.join(home, ".engram", "engrams"), "0002-broken.md");
    await addPersonal("Personal note");
    await run(contextCommand({ scope: "all" }));
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain("Skipped 2");
    expect(output()).toContain("Personal note");
  });

  it("duplicate id visibility stays bounded and points to engram check", async () => {
    const fm = (id: string, title: string): string =>
      [
        "---",
        `id: "${id}"`,
        `title: ${JSON.stringify(title)}`,
        "type: note",
        "tags: []",
        "scope: project",
        "created: 2025-08-15T10:00:00.000Z",
        "updated: 2025-08-15T11:00:00.000Z",
        "---",
        "Body",
        "",
      ].join("\n");
    fs.writeFileSync(path.join(projectEngramsDir(tmp), "0001-a.md"), fm("0001", "A"));
    fs.writeFileSync(path.join(projectEngramsDir(tmp), "0001-b.md"), fm("0001", "B"));
    fs.writeFileSync(path.join(projectEngramsDir(tmp), "0002-a.md"), fm("0002", "C"));
    fs.writeFileSync(path.join(projectEngramsDir(tmp), "0002-b.md"), fm("0002", "D"));
    await run(contextCommand({}));
    const two = output();
    expect(two).toContain("duplicate engram ids");
    expect(two).toContain("engram check");
    // no unbounded offender listing: exact paths stay out of the digest
    expect(two).not.toContain("0001-a.md");

    // a third duplicate group changes only the count in the warning block
    fs.writeFileSync(path.join(projectEngramsDir(tmp), "0003-a.md"), fm("0003", "E"));
    fs.writeFileSync(path.join(projectEngramsDir(tmp), "0003-b.md"), fm("0003", "F"));
    outLines = [];
    await run(contextCommand({}));
    const three = output();
    const dupBlock = (s: string): string => {
      const lines = s.split("\n");
      const i = lines.findIndex((l) => l.startsWith("# WARNING: duplicate engram ids"));
      return lines.slice(i, i + 2).join("\n");
    };
    const normalize = (s: string): string => s.replace(/\d+/g, "#");
    expect(normalize(dupBlock(three))).toBe(normalize(dupBlock(two)));
  });
});
