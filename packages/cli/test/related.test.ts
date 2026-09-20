/**
 * Command-level ENG-42 related surface for `engram add` / `engram edit`:
 * comma-separated flag parsing, three-state edit mapping, value+clear
 * conflicts, and store-boundary rejections without mutation. Runs the real
 * command Effects over MainLive with stdout captured; process-level flag
 * wiring lives in process.test.ts.
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
  parseFrontmatter,
  projectConfigPath,
  projectEngramsDir,
  stringifyFrontmatter,
} from "@engram/core";
import { Option, Result } from "effect";
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

describe("engram add/edit related flags", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  let outLines: string[] = [];
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-related-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-related-home-"));
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
  ): Promise<{ _tag: string; message?: string }> =>
    Effect.runPromise(Effect.provide(Effect.flip(eff) as never, MainLive)) as Promise<{
      _tag: string;
      message?: string;
    }>;

  const engramsDir = (): string => projectEngramsDir(tmp);

  const seedLegacyId = (id: string, title: string, slug: string): void => {
    fs.writeFileSync(
      path.join(engramsDir(), `${id}-${slug}.md`),
      stringifyFrontmatter("Legacy body\n", {
        id,
        title,
        type: "note",
        tags: [],
        scope: "project",
        created: "2025-08-15T10:00:00.000Z",
        updated: "2025-08-15T11:00:00.000Z",
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

  const snapshotAll = (): string =>
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

  it("add parses a comma-separated list, trims members, and preserves order", async () => {
    await run(
      addCommand({
        title: "Linked source",
        content: "Body",
        related: "0003, 0002 ,0004",
      }),
    );
    expect(readEntry(addedId()).data.related).toEqual(["0003", "0002", "0004"]);
  });

  it("add with an empty or whitespace value records no related key", async () => {
    await run(addCommand({ title: "Empty related", content: "Body", related: "   " }));
    const entry = fs
      .readdirSync(engramsDir())
      .map((f) => fs.readFileSync(path.join(engramsDir(), f), "utf8"))
      .join("\n");
    expect(entry).not.toMatch(/^related:/m);
  });

  it("edit replaces the whole list, preserves on omission, and clears with --clear-related", async () => {
    seedLegacyId("0001", "Linked note", "linked-note");
    seedLegacyId("0002", "First target", "first-target");
    seedLegacyId("0003", "Second target", "second-target");
    seedLegacyId("0004", "Third target", "third-target");

    // content rides along so the pre-implementation red run cannot fall into
    // the stdin branch; the flag-only surface is covered at process level
    await run(editCommand("0001", { related: "0002,0003", content: "Set" }));
    expect(readEntry("0001").data.related).toEqual(["0002", "0003"]);

    // omission preserves
    await run(editCommand("0001", { content: "Edited" }));
    expect(readEntry("0001").data.related).toEqual(["0002", "0003"]);

    // a value replaces the entire list
    await run(editCommand("0001", { related: "0004", content: "Replaced" }));
    expect(readEntry("0001").data.related).toEqual(["0004"]);

    // clear removes the key entirely
    await run(editCommand("0001", { clearRelated: true }));
    expect(readEntry("0001").data).not.toHaveProperty("related");
    expect(readEntry("0001").raw).not.toMatch(/^related:/m);
  });

  it("edit with an empty value preserves the current list (no instruction)", async () => {
    seedLegacyId("0001", "Linked note", "linked-note");
    seedLegacyId("0002", "Target", "target");
    await run(editCommand("0001", { related: "0002", content: "Set" }));
    await run(editCommand("0001", { related: "  ", content: "Still linked" }));
    expect(readEntry("0001").data.related).toEqual(["0002"]);
  });

  it("a value plus --clear-related is a usage error before any read or write", async () => {
    seedLegacyId("0002", "Unrelated", "unrelated");
    const before = snapshotAll();
    const e = await runFail(
      editCommand("9999", { related: "0002", clearRelated: true }),
    );
    expect(e._tag).toBe("ValidationError");
    expect(e.message).toContain("--related");
    expect(e.message).toContain("--clear-related");
    expect(snapshotAll()).toBe(before);
  });

  it("empty tokens between separators are a usage error on both commands", async () => {
    seedLegacyId("0001", "Linked note", "linked-note");
    const before = snapshotAll();

    const addE = await runFail(addCommand({ title: "Bad add", content: "B", related: "0001,,0002" }));
    expect(addE._tag).toBe("ValidationError");
    expect(addE.message).toContain("--related");

    const editE = await runFail(
      editCommand("0001", { related: "0001, ,0002", content: "Probe" }),
    );
    expect(editE._tag).toBe("ValidationError");

    expect(snapshotAll()).toBe(before);
  });

  it("duplicates and malformed ids reach the store boundary and are rejected without mutation", async () => {
    seedLegacyId("0001", "Linked note", "linked-note");
    const before = snapshotAll();

    const dup = await runFail(addCommand({ title: "Dup", content: "B", related: "0002,0002" }));
    expect(dup._tag).toBe("FrontmatterParseError");
    expect(snapshotAll()).toBe(before);

    const bad = await runFail(editCommand("0001", { related: "12", content: "Probe" }));
    expect(bad._tag).toBe("FrontmatterParseError");
    expect(snapshotAll()).toBe(before);
  });

  it("a self-link is rejected by the store boundary without mutation", async () => {
    seedLegacyId("0001", "Linked note", "linked-note");
    const before = snapshotAll();
    const e = await runFail(editCommand("0001", { related: "0001", content: "Probe" }));
    expect(e._tag).toBe("FrontmatterParseError");
    expect(e.message).toContain("itself");
    expect(snapshotAll()).toBe(before);
  });

  it("a dangling related id still writes successfully (existence is advisory)", async () => {
    await run(addCommand({ title: "Forward link", content: "Body", related: "0099" }));
    expect(fs.readdirSync(engramsDir())).toHaveLength(1);
    expect(readEntry(addedId()).data.related).toEqual(["0099"]);
  });

  it("the editor diff: unchanged preserves (parsed array equality), changed replaces, blank clears", async () => {
    seedLegacyId("0001", "Linked note", "linked-note");
    seedLegacyId("0002", "Target", "target");
    await run(editCommand("0001", { related: "0002", content: "Set" }));
    expect(readEntry("0001").data.related).toEqual(["0002"]);

    // unchanged list (parsed array equality, whitespace-insensitive) -> omit
    openEditorMock.mockReturnValue(Effect.succeed(edited({ related: ["0002"] })));
    await run(editCommand("0001", {}));
    expect(readEntry("0001").data.related).toEqual(["0002"]);

    // reordered list -> replace
    openEditorMock.mockReturnValue(Effect.succeed(edited({ related: ["0003", "0002"] })));
    await run(editCommand("0001", {}));
    expect(readEntry("0001").data.related).toEqual(["0003", "0002"]);

    // blanked line -> explicit clear
    openEditorMock.mockReturnValue(Effect.succeed(edited({ related: undefined })));
    await run(editCommand("0001", {}));
    expect(readEntry("0001").data).not.toHaveProperty("related");
  });

  it("the editor on add: a populated line links, a blank line records no key", async () => {
    openEditorMock.mockReturnValue(Effect.succeed(edited({ title: "From editor", related: ["0002"] })));
    await run(addCommand({}));
    expect(readEntry(addedId()).data.related).toEqual(["0002"]);

    openEditorMock.mockReturnValue(Effect.succeed(edited({ title: "No links", related: undefined })));
    await run(addCommand({}));
    expect(
      readEntry(addedId()).data,
      "blank related must stay absent",
    ).not.toHaveProperty("related");
  });
});
