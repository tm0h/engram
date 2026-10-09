/**
 * Command-level ENG-46 alias surface for `engram add` / `engram edit`:
 * comma-splitting that preserves empty members, core-boundary rejection
 * wording, three-state edit mapping, the value+clear conflict, and editor
 * add/edit/clear behavior. Runs the real command Effects over MainLive with
 * stdout captured; process-level flag wiring lives in process.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { Effect, Option, Result } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConfigRepo,
  EngramStore,
  MainLive,
  parseFrontmatter,
  projectConfigPath,
  projectEngramsDir,
  stringifyFrontmatter,
} from "@engram/core";
import { addCommand } from "../src/commands/add.js";
import { editCommand } from "../src/commands/edit.js";
import { openEditor } from "../src/interactive.js";
import type { EditedEngram } from "../src/interactive.js";

// The $EDITOR flow is driven through mocked openEditor + isInteractive (the
// real ones need a TTY), so the editor diff rules are asserted directly.
vi.mock("../src/interactive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/interactive.js")>();
  return {
    ...actual,
    openEditor: vi.fn(actual.openEditor),
    isInteractive: vi.fn(() => Effect.succeed(true)),
  };
});
const openEditorMock = vi.mocked(openEditor);

/** A full editor result with defaults, overridable per test. */
const edited = (over: Partial<EditedEngram> = {}): EditedEngram => ({
  title: "Edited title",
  type: "note",
  tags: [],
  body: "Edited body",
  ...over,
});

describe("engram add/edit aliases flags", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  let outLines: string[] = [];
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-aliases-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-aliases-home-"));
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
    openEditorMock.mockClear();
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
  ): Promise<{ _tag: string; message?: string }> =>
    Effect.runPromise(Effect.provide(Effect.flip(eff) as never, MainLive)) as Promise<{
      _tag: string;
      message?: string;
    }>;

  const engramsDir = (): string => projectEngramsDir(tmp);

  const seed = (id: string, title: string, slug: string, aliases?: ReadonlyArray<string>): void => {
    fs.writeFileSync(
      path.join(engramsDir(), `${id}-${slug}.md`),
      stringifyFrontmatter("Seeded body\n", {
        id,
        title,
        type: "note",
        tags: [],
        scope: "project",
        created: "2025-08-15T10:00:00.000Z",
        updated: "2025-08-15T11:00:00.000Z",
        ...(aliases !== undefined ? { aliases: [...aliases] } : {}),
      }),
    );
  };

  /** Parsed frontmatter data of the single seeded entry, plus its raw text. */
  const readEntry = (id: string): { data: Record<string, unknown>; raw: string } => {
    for (const f of fs.readdirSync(engramsDir()).sort()) {
      const raw = fs.readFileSync(path.join(engramsDir(), f), "utf8");
      const parsed = Option.getOrUndefined(Result.getSuccess(parseFrontmatter(raw)));
      if ((parsed?.data as Record<string, unknown>)?.id === id) {
        return { data: parsed!.data as Record<string, unknown>, raw };
      }
    }
    throw new Error(`entry ${id} not found in ${engramsDir()}`);
  };

  const allBytes = (): string =>
    fs
      .readdirSync(engramsDir())
      .sort()
      .map((f) => fs.readFileSync(path.join(engramsDir(), f), "utf8"))
      .join("\n%%%\n");

  /** The id the CLI reported for the most recent add (output accumulates). */
  const addedId = (): string => {
    const all = [...output().matchAll(/\[([0-9a-z]{26}|\d{4})\]/g)];
    const last = all[all.length - 1];
    if (last === undefined) throw new Error(`no Added id in output: ${output()}`);
    return last[1];
  };

  it("add splits on commas, preserves multiword values, and normalizes", async () => {
    await run(
      addCommand({
        title: "Aliased",
        content: "Body",
        aliases: " Postgres , pg_dump,postgres row level security",
      }),
    );
    expect(readEntry(addedId()).data.aliases).toEqual([
      "postgres",
      "pg_dump",
      "postgres row level security",
    ]);
  });

  it("add without the flag records no aliases key", async () => {
    await run(addCommand({ title: "Plain", content: "Body" }));
    expect(readEntry(addedId()).raw).not.toMatch(/^aliases:/m);
  });

  it("add rejects an empty member with the core wording (R14a: never absent)", async () => {
    const e = await runFail(addCommand({ title: "Bad", content: "Body", aliases: "pg,," }));
    expect(e._tag).toBe("ValidationError");
    expect(e.message).toContain("aliases (position 2) is empty after trimming");
    expect(e.message).toContain("aliases (position 3) is empty after trimming");
    expect(fs.readdirSync(engramsDir())).toEqual([]);
  });

  it("add rejects a whitespace-only flag value (R14a: not silently absent)", async () => {
    const e = await runFail(addCommand({ title: "Bad", content: "Body", aliases: "   " }));
    expect(e._tag).toBe("ValidationError");
    expect(e.message).toContain("aliases (position 1) is empty after trimming");
    expect(fs.readdirSync(engramsDir())).toEqual([]);
  });

  it("add rejects overlength and over-cap values with the core wording", async () => {
    const long = await runFail(
      addCommand({ title: "Bad", content: "Body", aliases: "p".repeat(81) }),
    );
    expect(long.message).toContain("longer than 80 code points (81)");
    const twentyOne = Array.from({ length: 21 }, (_, i) => `a${i}`).join(",");
    const capped = await runFail(addCommand({ title: "Bad", content: "Body", aliases: twentyOne }));
    expect(capped.message).toContain("aliases lists 21 unique values; the maximum is 20");
    expect(fs.readdirSync(engramsDir())).toEqual([]);
  });

  it("edit replaces the whole set, preserves on omission, and clears", async () => {
    seed("0001", "Aliased note", "aliased-note");
    seed("0002", "Unrelated", "unrelated");

    // content rides along so the pre-implementation red run cannot fall into
    // the stdin branch; the flag-only surface is covered at process level
    await run(editCommand("0001", { aliases: " PG ,New One", content: "Set" }));
    expect(readEntry("0001").data.aliases).toEqual(["pg", "new one"]);

    // omission preserves
    await run(editCommand("0001", { content: "Edited" }));
    expect(readEntry("0001").data.aliases).toEqual(["pg", "new one"]);

    // a value replaces the entire set, normalized
    await run(editCommand("0001", { aliases: "Third", content: "Replaced" }));
    expect(readEntry("0001").data.aliases).toEqual(["third"]);

    // clear removes the key entirely
    await run(editCommand("0001", { clearAliases: true }));
    expect(readEntry("0001").data).not.toHaveProperty("aliases");
    expect(readEntry("0001").raw).not.toMatch(/^aliases:/m);
  });

  it("edit rejects an empty member before any mutation", async () => {
    seed("0001", "Aliased note", "aliased-note", ["pg"]);
    const before = allBytes();
    const e = await runFail(editCommand("0001", { aliases: "ok,", content: "Set" }));
    expect(e._tag).toBe("ValidationError");
    expect(e.message).toContain("aliases (position 2) is empty after trimming");
    expect(allBytes()).toBe(before);
  });

  it("a value plus --clear-aliases is a usage error before any read or write", async () => {
    seed("0002", "Unrelated", "unrelated");
    const before = allBytes();
    const e = await runFail(editCommand("9999", { aliases: "pg", clearAliases: true }));
    expect(e._tag).toBe("ValidationError");
    expect(e.message).toBe("Use either --aliases <aliases> or --clear-aliases, not both.");
    expect(allBytes()).toBe(before);
  });

  it("editor add: a changed aliases line replaces and blank means none", async () => {
    // changed line -> replaced into the stored entry
    openEditorMock.mockImplementationOnce(() =>
      Effect.succeed(edited({ aliases: ["From Editor"] })),
    );
    await run(addCommand({ title: "Edited add" }));
    expect(readEntry(addedId()).data.aliases).toEqual(["from editor"]);

    // absent/blank line -> no aliases
    openEditorMock.mockImplementationOnce(() => Effect.succeed(edited({ aliases: undefined })));
    await run(addCommand({ title: "Blank add" }));
    expect(readEntry(addedId()).raw).not.toMatch(/^aliases:/m);
  });

  it("editor add prefill carries the flag values into the document", async () => {
    openEditorMock.mockImplementationOnce(() => Effect.succeed(edited({ title: "Prefilled" })));
    await run(addCommand({ title: "Prefilled", aliases: "pg" }));
    const call = openEditorMock.mock.calls[0]?.[0];
    expect(call?.aliases).toEqual(["pg"]);
  });

  it("editor add surfaces empty members with the flag wording before any write", async () => {
    openEditorMock.mockImplementationOnce(() => Effect.succeed(edited({ aliases: ["ok", ""] })));
    const e = await runFail(addCommand({ title: "Editor bad" }));
    expect(e.message).toContain("aliases (position 2) is empty after trimming");
    expect(fs.readdirSync(engramsDir())).toEqual([]);
  });

  it("editor edit: unchanged preserves, changed replaces, blank or removed clears", async () => {
    seed("0001", "Aliased note", "aliased-note", ["keep", "these"]);

    // unchanged line (the prefill rendered verbatim) preserves
    openEditorMock.mockImplementationOnce(() =>
      Effect.succeed(edited({ title: "Aliased note", aliases: ["keep", "these"] })),
    );
    await run(editCommand("0001", {}));
    expect(readEntry("0001").data.aliases).toEqual(["keep", "these"]);

    // changed line replaces
    openEditorMock.mockImplementationOnce(() =>
      Effect.succeed(edited({ title: "Aliased note", aliases: ["fresh"] })),
    );
    await run(editCommand("0001", {}));
    expect(readEntry("0001").data.aliases).toEqual(["fresh"]);

    // blank or removed line clears a populated list
    openEditorMock.mockImplementationOnce(() =>
      Effect.succeed(edited({ title: "Aliased note", aliases: undefined })),
    );
    await run(editCommand("0001", {}));
    expect(readEntry("0001").data).not.toHaveProperty("aliases");
  });

  it("editor edit prefill shows the stored aliases verbatim", async () => {
    seed("0001", "Aliased note", "aliased-note", ["pg"]);
    openEditorMock.mockImplementationOnce(() => Effect.succeed(edited({ title: "Aliased note" })));
    await run(editCommand("0001", {}));
    const call = openEditorMock.mock.calls[0]?.[0];
    expect(call?.aliases).toEqual(["pg"]);
  });

  it("a comma-containing stored alias survives a body-only editor save (P1-1, R15)", async () => {
    seed("0001", "Aliased note", "aliased-note", ["foo, bar"]);
    // the mock returns what the real openEditor produces after the R15 fix:
    // an unchanged line ("foo, bar") preserves the stored array verbatim,
    // while the body changes.
    openEditorMock.mockImplementationOnce(() =>
      Effect.succeed(
        edited({
          title: "Aliased note",
          body: "New body",
          aliases: ["foo, bar"],
          aliasesRaw: "foo, bar",
        }),
      ),
    );
    await run(editCommand("0001", {}));
    const entry = readEntry("0001");
    expect(entry.data.aliases).toEqual(["foo, bar"]);
    expect(entry.raw).toContain("New body");
  });
});
