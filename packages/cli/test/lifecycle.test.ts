/**
 * Command-level ENG-13 lifecycle surface for `engram add` / `engram edit`:
 * value flags, clear flags, value+clear conflicts, enum fail-fast, and
 * store-boundary rejections without mutation. Runs the real command Effects
 * over MainLive with stdout captured; process-level flag wiring lives in
 * process.test.ts.
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
  projectConfigPath,
  projectEngramsDir,
  stringifyFrontmatter,
} from "@engram/core";
import { addCommand } from "../src/commands/add.js";
import { editCommand } from "../src/commands/edit.js";
import { showCommand } from "../src/commands/show.js";

const LIFECYCLE_VALUES = {
  status: "active",
  reviewAfter: "2026-06-01T00:00:00.000Z",
  expires: "2027-01-01T00:00:00.000Z",
  sourceType: "file",
  sourceRef: "docs/spec.md",
} as const;

describe("engram add/edit lifecycle flags", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  let outLines: string[] = [];
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-lifecycle-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-lifecycle-home-"));
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
  const fileContent = (needle: string): string => {
    for (const f of fs.readdirSync(engramsDir()).sort()) {
      const c = fs.readFileSync(path.join(engramsDir(), f), "utf8");
      if (c.includes(needle)) return c;
    }
    return "";
  };
  const idOf = (needle: string): string => {
    for (const f of fs.readdirSync(engramsDir()).sort()) {
      const c = fs.readFileSync(path.join(engramsDir(), f), "utf8");
      if (c.includes(needle)) return /^id: ?"?([^"\n]+)"?$/m.exec(c)?.[1] ?? "";
    }
    return "";
  };
  const snapshotAll = (): string =>
    fs
      .readdirSync(engramsDir())
      .sort()
      .map((f) => fs.readFileSync(path.join(engramsDir(), f), "utf8"))
      .join("\n%%%\n");

  /** A deterministic legacy-id entry to supersede (any unique legacy id). */
  const seedLegacy = (): void => {
    seedLegacyId("0001", "Legacy note", "legacy-note");
  };
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

  it("add accepts all six lifecycle flags and show renders them", async () => {
    seedLegacy();
    await run(
      addCommand({
        title: "New guidance",
        type: "decision",
        content: "b",
        ...LIFECYCLE_VALUES,
        supersedes: "0001",
      }),
    );
    const fileRaw = fileContent("New guidance");
    expect(fileRaw).toMatch(/^status: active$/m);
    expect(fileRaw).toMatch(/^supersedes: "0001"$/m);
    expect(fileRaw).toMatch(/^reviewAfter: 2026-06-01T00:00:00\.000Z$/m);
    expect(fileRaw).toMatch(/^expires: 2027-01-01T00:00:00\.000Z$/m);
    expect(fileRaw).toMatch(/^sourceType: file$/m);
    expect(fileRaw).toMatch(/^sourceRef: docs\/spec\.md$/m);

    outLines = [];
    const id = idOf("New guidance");
    await run(showCommand(id, {}));
    expect(output()).toContain("status: active");
    expect(output()).toContain("supersedes: 0001");
    expect(output()).toContain("review-after: 2026-06-01T00:00:00.000Z");
    expect(output()).toContain("source: file · docs/spec.md");
  });

  it("edit accepts all six lifecycle value flags and show renders them", async () => {
    seedLegacy();
    await run(addCommand({ title: "Base note", content: "b" }));
    const id = idOf("Base note");
    await run(
      editCommand(id, {
        ...LIFECYCLE_VALUES,
        supersedes: "0001",
        content: "b",
      }),
    );
    const fileRaw = fileContent("Base note");
    expect(fileRaw).toMatch(/^status: active$/m);
    expect(fileRaw).toMatch(/^supersedes: "0001"$/m);
    expect(fileRaw).toMatch(/^reviewAfter: 2026-06-01T00:00:00\.000Z$/m);
    expect(fileRaw).toMatch(/^expires: 2027-01-01T00:00:00\.000Z$/m);
    expect(fileRaw).toMatch(/^sourceType: file$/m);
    expect(fileRaw).toMatch(/^sourceRef: docs\/spec\.md$/m);

    outLines = [];
    await run(showCommand(id, {}));
    expect(output()).toContain("status: active");
    expect(output()).toContain("review-after: 2026-06-01T00:00:00.000Z");
  });

  it("edit clears each lifecycle field with its paired clear flag", async () => {
    const cases: Array<[flag: string, clear: string, key: string]> = [
      ["status", "clearStatus", "status"],
      ["supersedes", "clearSupersedes", "supersedes"],
      ["reviewAfter", "clearReviewAfter", "reviewAfter"],
      ["expires", "clearExpires", "expires"],
      ["sourceType", "clearSourceType", "sourceType"],
      ["sourceRef", "clearSourceRef", "sourceRef"],
    ];
    let n = 0;
    for (const [flag, clear, key] of cases) {
      // ENG-17 R1/R5: each add needs its own active predecessor; a target
      // already marked superseded by the previous iteration would reject.
      n += 1;
      const predId = String(1000 + n);
      seedLegacyId(predId, `Pred ${predId}`, `pred-${predId}`);
      await run(
        addCommand({
          title: `Clear ${flag}`,
          content: "b",
          ...LIFECYCLE_VALUES,
          supersedes: predId,
        }),
      );
      const id = idOf(`Clear ${flag}`);
      await run(editCommand(id, { [clear]: true, content: "b" }));
      const fileRaw = fileContent(`Clear ${flag}`);
      expect(fileRaw, `${key} key should be gone`).not.toMatch(new RegExp(`^${key}:`, "m"));
      // untouched siblings survive
      if (key !== "status") expect(fileRaw).toMatch(/^status: active$/m);
      if (key !== "reviewAfter") {
        expect(fileRaw).toMatch(/^reviewAfter: 2026-06-01T00:00:00\.000Z$/m);
      }
    }
  });

  it("a value plus clear pair on the same field fails with no mutation", async () => {
    const conflicts: Array<[Record<string, unknown>, string]> = [
      [{ status: "active", clearStatus: true }, "--clear-status"],
      [{ supersedes: "0001", clearSupersedes: true }, "--clear-supersedes"],
      [{ reviewAfter: "2026-06-01T00:00:00.000Z", clearReviewAfter: true }, "--clear-review-after"],
      [{ expires: "2027-01-01T00:00:00.000Z", clearExpires: true }, "--clear-expires"],
      [{ sourceType: "file", clearSourceType: true }, "--clear-source-type"],
      [{ sourceRef: "docs/spec.md", clearSourceRef: true }, "--clear-source-ref"],
    ];
    // ENG-17 R5: the supersedes target must exist and be active
    seedLegacy();
    await run(
      addCommand({
        title: "Conflict target",
        content: "b",
        ...LIFECYCLE_VALUES,
        supersedes: "0001",
      }),
    );
    const id = idOf("Conflict target");
    for (const [opts, clearFlag] of conflicts) {
      const before = snapshotAll();
      const info = await runFail(editCommand(id, { ...opts, content: "b" }));
      expect(info._tag).toBe("ValidationError");
      expect(info.message).toContain(clearFlag);
      expect(snapshotAll()).toBe(before);
    }
  });

  it("unknown enum values fail fast before file creation or mutation", async () => {
    const badStatus = await runFail(
      addCommand({ title: "Bad status", content: "b", status: "draft" }),
    );
    expect(badStatus._tag).toBe("ValidationError");
    expect(badStatus.message).toContain("active, superseded, archived");
    const badSource = await runFail(
      addCommand({ title: "Bad source", content: "b", sourceType: "chatlog" }),
    );
    expect(badSource._tag).toBe("ValidationError");
    expect(badSource.message).toContain("conversation, file, url, command, other");
    // no file was created by either failed add
    expect(fs.readdirSync(engramsDir())).toHaveLength(0);
    expect(snapshotAll()).toBe("");

    seedLegacy();
    const id = idOf("Legacy note");
    const seeded = snapshotAll();
    const editFail = await runFail(editCommand(id, { status: "draft", content: "b" }));
    expect(editFail._tag).toBe("ValidationError");
    expect(snapshotAll()).toBe(seeded);
  });

  it("invalid timestamp, id, and sourceRef values fail via the store boundary without mutation", async () => {
    const badValues: Array<Record<string, string>> = [
      { reviewAfter: "2026-01-01" }, // date-only
      { expires: "2027-01-01T00:00:00" }, // zone-less
      { reviewAfter: "2026-02-30T00:00:00.000Z" }, // impossible calendar date
      { supersedes: "abc" }, // malformed id
      { sourceRef: "   " }, // whitespace-only
    ];
    for (const bad of badValues) {
      const filesBefore = fs.readdirSync(engramsDir()).sort();
      const info = await runFail(addCommand({ title: "Bad value target", content: "b", ...bad }));
      expect(info._tag).toBe("FrontmatterParseError");
      expect(fs.readdirSync(engramsDir()).sort()).toEqual(filesBefore);
    }

    seedLegacy();
    await run(addCommand({ title: "Mutable target", content: "b" }));
    const id = idOf("Mutable target");
    const before = snapshotAll();
    const info = await runFail(editCommand(id, { supersedes: id, content: "b" })); // self-supersession
    expect(info._tag).toBe("FrontmatterParseError");
    expect(snapshotAll()).toBe(before);
  });
});
