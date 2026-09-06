import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import { Value } from "typebox/value";
import { z } from "zod";
import engramExtension from "../src/pi/index.js";
import { registerEngramCommand } from "../src/pi/commands.js";
import { registerEngramTools, engramSearchTool } from "../src/pi/tools.js";
import { engramAddTool as ocAddTool, engramEditTool as ocEditTool } from "../src/opencode/tools.js";

/* --------------------------- fake pi harness --------------------------- */

interface RegisteredTool {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (id: string, params: unknown) => Promise<unknown>;
}

interface RegisteredCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function fakePi(): {
  pi: ExtensionAPI;
  tools: RegisteredTool[];
  commands: Map<string, RegisteredCommand>;
} {
  const tools: RegisteredTool[] = [];
  const commands = new Map<string, RegisteredCommand>();
  const pi = {
    registerTool: (t: RegisteredTool) => tools.push(t),
    registerCommand: (name: string, def: RegisteredCommand) => commands.set(name, def),
    on: () => {},
  } as unknown as ExtensionAPI;
  return { pi, tools, commands };
}

function fakeCtx(over: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (text: string, level = "info") => notifications.push({ text, level }),
      confirm: async () => true,
      input: async () => "",
      select: async () => undefined,
    },
    cwd: process.cwd(),
  } as unknown as ExtensionCommandContext;
  (ctx as unknown as { __notifications: typeof notifications }).__notifications = notifications;
  void over;
  return ctx;
}

const notified = (ctx: ExtensionCommandContext): Array<{ text: string; level: string }> =>
  (ctx as unknown as { __notifications: Array<{ text: string; level: string }> }).__notifications;

/* ------------------------------- tests ------------------------------- */

const seedEntry = (root: string, id: string, title: string, type = "note"): void => {
  const fm = [
    `id: "${id}"`,
    `title: ${JSON.stringify(title)}`,
    `type: ${type}`,
    "tags: []",
    "scope: project",
    "created: 2026-08-16T10:00:00.000Z",
    "updated: 2026-08-16T10:00:00.000Z",
  ].join("\n");
  fs.writeFileSync(
    path.join(projectEngramsDir(root), `${id}-entry.md`),
    `---\n${fm}\n---\nBody of ${title}\n`,
  );
};

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-pi-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

describe("engram extension / registration", () => {
  it("registers the five engram tools and the /engram command", () => {
    const { pi, tools, commands } = fakePi();
    engramExtension(pi);

    expect(tools.map((t) => t.name)).toEqual([
      "engram_context",
      "engram_search",
      "engram_show",
      "engram_add",
      "engram_edit",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.promptSnippet?.length).toBeGreaterThan(10);
      expect(tool.parameters.properties).toBeDefined();
    }
    expect(commands.has("engram")).toBe(true);
  });

  it("schemas expose the expected params", () => {
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName.get("engram_context")!.parameters.properties!)).toEqual([
      "scope",
      "limit",
      "offset",
    ]);
    expect(Object.keys(byName.get("engram_search")!.parameters.properties!)).toContain("query");
    expect(Object.keys(byName.get("engram_search")!.parameters.properties!)).toContain("explain");
    expect(Value.Check(engramSearchTool.parameters, { query: "auth", explain: true })).toBe(true);
    expect(Value.Check(engramSearchTool.parameters, { query: "auth", explain: "true" })).toBe(
      false,
    );
    expect(Object.keys(byName.get("engram_show")!.parameters.properties!)).toContain("id");
    expect(Object.keys(byName.get("engram_add")!.parameters.properties!)).toEqual([
      "title",
      "body",
      "type",
      "scope",
      "tags",
      "pinned",
      "status",
      "supersedes",
      "reviewAfter",
      "expires",
      "sourceType",
      "sourceRef",
    ]);
    expect(Object.keys(byName.get("engram_edit")!.parameters.properties!)).toEqual([
      "id",
      "scope",
      "title",
      "type",
      "tags",
      "body",
      "pinned",
      "author",
      "status",
      "supersedes",
      "reviewAfter",
      "expires",
      "sourceType",
      "sourceRef",
    ]);
  });
});

describe("engram extension / tool execution", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-pihome-"));
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("engram_context returns the digest as tool content", async () => {
    seedEntry(tmp, "0001", "Use pnpm catalogs", "decision");
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const tool = tools.find((t) => t.name === "engram_context")!;

    const res = (await tool.execute("call-1", {})) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
      details: Record<string, unknown>;
    };
    expect(res.isError).toBe(false);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("Use pnpm catalogs");
    expect(res.details).toMatchObject({ total: 1 });
  });

  it("engram_add writes, then engram_context lists the new entry", async () => {
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const add = tools.find((t) => t.name === "engram_add")!;
    const context = tools.find((t) => t.name === "engram_context")!;

    const res = (await add.execute("call-1", {
      title: "Chose Vitest over Jest",
      body: "native ESM support",
      type: "decision",
      tags: ["testing"],
    })) as { isError: boolean; details: Record<string, unknown> };
    expect(res.isError).toBe(false);
    expect(fs.existsSync(res.details.path as string)).toBe(true);

    const digest = (await context.execute("call-2", {})) as {
      content: Array<{ text: string }>;
    };
    expect(digest.content[0].text).toContain("Chose Vitest over Jest");
  });

  it("engram_add passes lifecycle params through to the store", async () => {
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const add = tools.find((t) => t.name === "engram_add")!;
    // ENG-17 R5: supersedes must resolve to an existing active entry
    seedEntry(tmp, "0001", "Predecessor");

    const res = (await add.execute("call-1", {
      title: "Recorded with lifecycle",
      body: "b",
      status: "superseded",
      supersedes: "0001",
      reviewAfter: "2026-01-01T00:00:00.000Z",
      expires: "2026-06-01T00:00:00.000Z",
      sourceType: "file",
      sourceRef: "docs/a.md",
    })) as { isError: boolean; details: Record<string, unknown> };
    expect(res.isError).toBe(false);
    const content = fs.readFileSync(res.details.path as string, "utf8");
    expect(content).toContain("status: superseded");
    expect(content).toContain("reviewAfter: 2026-01-01T00:00:00.000Z");
    expect(content).toContain("sourceType: file");
  });

  it("engram_edit replaces ordinary fields including pinned and author", async () => {
    seedEntry(tmp, "0001", "Original title");
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const edit = tools.find((t) => t.name === "engram_edit")!;

    const res = (await edit.execute("call-1", {
      id: "0001",
      title: "Edited title",
      type: "decision",
      tags: ["edited"],
      body: "Edited body",
      pinned: true,
      author: "New Author",
    })) as {
      isError: boolean;
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
    };
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Edited title");
    expect(res.details).toMatchObject({ id: "0001", scope: "project", type: "decision" });
    const content = fs.readFileSync(res.details.path as string, "utf8");
    expect(content).toContain("Edited body");
    expect(content).toMatch(/^type: decision$/m);
    expect(content).toMatch(/^pinned: true$/m);
    expect(content).toMatch(/^author: New Author$/m);
    expect(fs.existsSync(path.join(projectEngramsDir(tmp), "0001-entry.md"))).toBe(false);
  });

  it("engram_edit sets, changes, and clears all six lifecycle fields", async () => {
    seedEntry(tmp, "0001", "Lifecycle target");
    // ENG-17 R5: supersedes targets must exist; R1: re-pointing is rejected,
    // so the change step clears the link before setting the new target.
    seedEntry(tmp, "0002", "First target");
    seedEntry(tmp, "0003", "Second target");
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const edit = tools.find((t) => t.name === "engram_edit")!;

    type EditResult = { isError: boolean; details: Record<string, unknown> };
    const keys = ["status", "supersedes", "reviewAfter", "expires", "sourceType", "sourceRef"];
    const fileOf = async (params: Record<string, unknown>): Promise<string> => {
      const res = (await edit.execute("call", params)) as EditResult;
      expect(res.isError).toBe(false);
      return res.details.path as string;
    };

    const setFile = await fileOf({
      id: "0001",
      status: "active",
      supersedes: "0002",
      reviewAfter: "2027-01-01T00:00:00.000Z",
      expires: "2027-06-01T00:00:00.000Z",
      sourceType: "file",
      sourceRef: "docs/a.md",
    });
    let content = fs.readFileSync(setFile, "utf8");
    expect(content).toMatch(/^status: active$/m);
    expect(content).toMatch(/^supersedes: "0002"$/m);
    expect(content).toMatch(/^reviewAfter: 2027-01-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^expires: 2027-06-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^sourceType: file$/m);
    expect(content).toMatch(/^sourceRef: docs\/a\.md$/m);

    // clear only the link, then establish the new target (R1: no repointing)
    await fileOf({ id: "0001", supersedes: null });
    const changeFile = await fileOf({
      id: "0001",
      status: "archived",
      supersedes: "0003",
      reviewAfter: "2028-01-01T00:00:00.000Z",
      expires: "2028-06-01T00:00:00.000Z",
      sourceType: "url",
      sourceRef: "https://example.com/a",
    });
    content = fs.readFileSync(changeFile, "utf8");
    expect(content).toMatch(/^status: archived$/m);
    expect(content).toMatch(/^supersedes: "0003"$/m);
    expect(content).toMatch(/^reviewAfter: 2028-01-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^expires: 2028-06-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^sourceType: url$/m);
    expect(content).toMatch(/^sourceRef: https:\/\/example\.com\/a$/m);

    const clearFile = await fileOf({
      id: "0001",
      status: null,
      supersedes: null,
      reviewAfter: null,
      expires: null,
      sourceType: null,
      sourceRef: null,
    });
    content = fs.readFileSync(clearFile, "utf8");
    for (const key of keys) {
      expect(content, key).not.toMatch(new RegExp(`^${key}:`, "m"));
    }
  });

  it("engram_edit unpinning with pinned: false works", async () => {
    seedEntry(tmp, "0001", "Pinned once");
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const edit = tools.find((t) => t.name === "engram_edit")!;

    const pin = (await edit.execute("call-1", {
      id: "0001",
      pinned: true,
    })) as { isError: boolean; details: Record<string, unknown> };
    expect(pin.isError).toBe(false);
    expect(fs.readFileSync(pin.details.path as string, "utf8")).toMatch(/^pinned: true$/m);

    const unpin = (await edit.execute("call-2", {
      id: "0001",
      pinned: false,
    })) as { isError: boolean; details: Record<string, unknown> };
    expect(unpin.isError).toBe(false);
    expect(fs.readFileSync(unpin.details.path as string, "utf8")).not.toMatch(/^pinned:/m);
  });

  it("engram_edit on an unknown id is an isError result", async () => {
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const edit = tools.find((t) => t.name === "engram_edit")!;
    const res = (await edit.execute("call-1", { id: "9999", title: "X" })) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("9999");
  });

  it("engram_show on an unknown id is an isError result", async () => {
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const show = tools.find((t) => t.name === "engram_show")!;
    const res = (await show.execute("call-1", { id: "9999" })) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("9999");
  });
});

describe("engram extension / /engram command", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-pihome-"));
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("default subcommand shows the digest via notify", async () => {
    seedEntry(tmp, "0001", "Digest visible", "decision");
    const { pi, commands } = fakePi();
    engramExtension(pi);

    const ctx = fakeCtx();
    await commands.get("engram")!.handler("", ctx);
    const notes = notified(ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("info");
    expect(notes[0].text).toContain("Digest visible");
  });

  it("search subcommand passes the query through", async () => {
    seedEntry(tmp, "0001", "Auth uses JWT");
    const { pi, commands } = fakePi();
    engramExtension(pi);

    const ctx = fakeCtx();
    await commands.get("engram")!.handler("search auth", ctx);
    expect(notified(ctx)[0].text).toContain("Auth uses JWT");
  });

  it("add subcommand parses title/body and flags", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);

    const ctx = fakeCtx();
    await commands
      .get("engram")!
      .handler(
        "add Pinned the runner -- Runs on GitHub Actions --type decision --tags ci,build --pinned",
        ctx,
      );
    const notes = notified(ctx);
    expect(notes[0].level).toBe("info");
    const file = notes[0].text.match(/  (\S+\.md)/)?.[1];
    expect(file).toBeDefined();
    const content = fs.readFileSync(file!, "utf8");
    expect(content).toContain("Pinned the runner");
    expect(content).toContain("type: decision");
    expect(content).toContain("pinned: true");
    expect(content).toContain("ci");
  });

  /** The single 0001 entry's current file (title edits rename it). */
  const entryFile = (): string =>
    path.join(
      projectEngramsDir(tmp),
      fs.readdirSync(projectEngramsDir(tmp)).find((f) => f.startsWith("0001"))!,
    );

  const editFixture = (): {
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    refreshes: () => number;
  } => {
    seedEntry(tmp, "0001", "Editable");
    let count = 0;
    const fake = fakePi();
    registerEngramCommand(fake.pi, { onWriteSuccess: () => (count += 1) });
    return {
      handler: fake.commands.get("engram")!.handler,
      refreshes: () => count,
    };
  };

  it("edit subcommand edits by unique prefix and by full id", async () => {
    const { handler } = editFixture();

    const byPrefix = fakeCtx();
    await handler("edit 000 --title First", byPrefix);
    expect(notified(byPrefix)[0].level).toBe("info");
    expect(fs.readFileSync(entryFile(), "utf8")).toContain("First");

    const byFullId = fakeCtx();
    await handler("edit 0001 -- Changed body", byFullId);
    expect(notified(byFullId)[0].level).toBe("info");
    expect(fs.readFileSync(entryFile(), "utf8")).toContain("Changed body");
  });

  it("edit subcommand replaces title, type, tags, body, pinned, author, and lifecycle values", async () => {
    const { handler } = editFixture();
    // ENG-17 R5: the supersedes target must exist and be active
    seedEntry(tmp, "0002", "Newer target");

    await handler(
      "edit 0001 --title Renamed --type decision --tags a,b --pinned --author Ada " +
        "--status archived --supersedes 0002 --review-after 2027-01-01T00:00:00.000Z " +
        "--expires 2027-06-01T00:00:00.000Z --source-type url " +
        "--source-ref https://example.com/a -- the new body",
      fakeCtx(),
    );
    const content = fs.readFileSync(entryFile(), "utf8");
    expect(content).toContain("Renamed");
    expect(content).toMatch(/^type: decision$/m);
    expect(content).toContain("a");
    expect(content).toContain("b");
    expect(content).toMatch(/^pinned: true$/m);
    expect(content).toMatch(/^author: Ada$/m);
    expect(content).toMatch(/^status: archived$/m);
    expect(content).toMatch(/^supersedes: "0002"$/m);
    expect(content).toMatch(/^reviewAfter: 2027-01-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^expires: 2027-06-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^sourceType: url$/m);
    expect(content).toMatch(/^sourceRef: https:\/\/example\.com\/a$/m);
    expect(content).toContain("the new body");
  });

  it("edit subcommand clears each lifecycle field with its paired clear flag", async () => {
    const { handler } = editFixture();
    // ENG-17 R5: the supersedes target must exist and be active
    seedEntry(tmp, "0002", "Clear target");

    await handler(
      "edit 0001 --status active --supersedes 0002 --review-after 2027-01-01T00:00:00.000Z " +
        "--expires 2027-06-01T00:00:00.000Z --source-type file --source-ref docs/a.md",
      fakeCtx(),
    );
    let content = fs.readFileSync(entryFile(), "utf8");
    expect(content).toMatch(/^status: active$/m);
    expect(content).toMatch(/^sourceRef: docs\/a\.md$/m);

    await handler(
      "edit 0001 --clear-status --clear-supersedes --clear-review-after " +
        "--clear-expires --clear-source-type --clear-source-ref",
      fakeCtx(),
    );
    content = fs.readFileSync(entryFile(), "utf8");
    for (const key of [
      "status",
      "supersedes",
      "reviewAfter",
      "expires",
      "sourceType",
      "sourceRef",
    ]) {
      expect(content, key).not.toMatch(new RegExp(`^${key}:`, "m"));
    }
  });

  it("edit subcommand supports quoted multiword title, author, and source reference", async () => {
    const { handler } = editFixture();

    await handler(
      `edit 0001 --title "Two words" --author 'Ada Lovelace' --source-ref "docs/a b.md"`,
      fakeCtx(),
    );
    const content = fs.readFileSync(entryFile(), "utf8");
    expect(content).toContain("Two words");
    expect(content).toMatch(/^author: Ada Lovelace$/m);
    expect(content).toMatch(/^sourceRef: docs\/a b\.md$/m);
  });

  it("edit body after -- consumes flag-looking text without parsing it as flags", async () => {
    const { handler } = editFixture();

    await handler("edit 0001 -- --title not a flag --status bogus", fakeCtx());
    const content = fs.readFileSync(entryFile(), "utf8");
    expect(content).toContain("--title not a flag --status bogus");
    expect(content).not.toMatch(/^title: not/m);
    expect(content).not.toMatch(/^status:/m);
  });

  it("conflicting value and clear flags error before mutation with no refresh", async () => {
    const { handler, refreshes } = editFixture();
    const before = fs.readFileSync(entryFile(), "utf8");
    const conflicts = [
      "edit 0001 --status active --clear-status",
      "edit 0001 --supersedes 0002 --clear-supersedes",
      "edit 0001 --review-after 2027-01-01T00:00:00.000Z --clear-review-after",
      "edit 0001 --expires 2027-06-01T00:00:00.000Z --clear-expires",
      "edit 0001 --source-type file --clear-source-type",
      "edit 0001 --source-ref docs/a.md --clear-source-ref",
      "edit 0001 --pinned --no-pinned",
    ];
    for (const cmd of conflicts) {
      const ctx = fakeCtx();
      await handler(cmd, ctx);
      const notes = notified(ctx);
      expect(notes, cmd).toHaveLength(1);
      expect(notes[0].level, cmd).toBe("error");
      expect(fs.readFileSync(entryFile(), "utf8"), cmd).toBe(before);
    }
    expect(refreshes()).toBe(0);
  });

  it("edit subcommand rejects unknown enums, bad scope, unknown flags, missing id, and empty edits", async () => {
    const { handler, refreshes } = editFixture();
    const before = fs.readFileSync(entryFile(), "utf8");
    const badCommands = [
      "edit 0001 --type bogus",
      "edit 0001 --status bogus",
      "edit 0001 --source-type bogus",
      "edit 0001 --scope bogus",
      "edit 0001 --bogus-flag x",
      "edit 0001 unexpected-argument",
      "edit",
      "edit 0001",
    ];
    for (const cmd of badCommands) {
      const ctx = fakeCtx();
      await handler(cmd, ctx);
      const notes = notified(ctx);
      expect(notes, cmd).toHaveLength(1);
      expect(notes[0].level, cmd).toBe("error");
      expect(fs.readFileSync(entryFile(), "utf8"), cmd).toBe(before);
    }
    expect(refreshes()).toBe(0);
  });

  it("edit value flags reject a following bare flag instead of consuming it", async () => {
    const { handler, refreshes } = editFixture();
    const before = fs.readFileSync(entryFile(), "utf8");

    // A value flag followed by its own clear flag must be a missing-value
    // error, not a literal "--clear-source-ref" value that mutates and fires
    // the success hook.
    const ctx1 = fakeCtx();
    await handler("edit 0001 --source-ref --clear-source-ref", ctx1);
    expect(notified(ctx1)).toHaveLength(1);
    expect(notified(ctx1)[0].level).toBe("error");
    expect(fs.readFileSync(entryFile(), "utf8")).toBe(before);
    expect(refreshes()).toBe(0);

    const ctx2 = fakeCtx();
    await handler("edit 0001 --title --clear-status", ctx2);
    expect(notified(ctx2)).toHaveLength(1);
    expect(notified(ctx2)[0].level).toBe("error");
    expect(fs.readFileSync(entryFile(), "utf8")).toBe(before);
    expect(refreshes()).toBe(0);
  });

  it("edit accepts quoted flag-looking strings as values", async () => {
    const { handler, refreshes } = editFixture();

    await handler("edit 0001 --source-ref '--clear-source-ref'", fakeCtx());
    expect(refreshes()).toBe(1);
    expect(fs.readFileSync(entryFile(), "utf8")).toMatch(/^sourceRef: "--clear-source-ref"$/m);

    await handler('edit 0001 --title "--clear-status"', fakeCtx());
    expect(refreshes()).toBe(2);
    expect(fs.readFileSync(entryFile(), "utf8")).toMatch(/^title: "--clear-status"$/m);
  });

  it("edit subcommand surfaces store-boundary rejections with byte identity and no refresh", async () => {
    const { handler, refreshes } = editFixture();
    const before = fs.readFileSync(entryFile(), "utf8");
    const badCommands = [
      "edit 0001 --review-after 2027-01-01",
      "edit 0001 --supersedes nope",
      "edit 0001 --supersedes 0001",
      "edit 0001 --source-ref ''",
    ];
    for (const cmd of badCommands) {
      const ctx = fakeCtx();
      await handler(cmd, ctx);
      const notes = notified(ctx);
      expect(notes, cmd).toHaveLength(1);
      expect(notes[0].level, cmd).toBe("error");
      expect(fs.readFileSync(entryFile(), "utf8"), cmd).toBe(before);
    }
    expect(refreshes()).toBe(0);
  });

  it("successful slash edits fire onWriteSuccess; failures never do", async () => {
    const { handler, refreshes } = editFixture();

    await handler("edit 0001 --status bogus", fakeCtx());
    expect(refreshes()).toBe(0);

    await handler('edit 0001 --title "Renamed once"', fakeCtx());
    expect(refreshes()).toBe(1);

    await handler("edit 0001 --pinned --no-pinned", fakeCtx());
    expect(refreshes()).toBe(1);

    await handler("edit 0001 --no-pinned", fakeCtx());
    expect(refreshes()).toBe(2);
  });

  it("help documents the edit grammar", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    const ctx = fakeCtx();
    await commands.get("engram")!.handler("help", ctx);
    const text = notified(ctx)[0].text;
    expect(text).toContain("/engram edit");
    for (const flag of [
      "--title",
      "--type",
      "--tags",
      "--scope",
      "--pinned",
      "--no-pinned",
      "--author",
      "--status",
      "--supersedes",
      "--review-after",
      "--expires",
      "--source-type",
      "--source-ref",
      "--clear-status",
      "--clear-supersedes",
      "--clear-review-after",
      "--clear-expires",
      "--clear-source-type",
      "--clear-source-ref",
    ]) {
      expect(text, flag).toContain(flag);
    }
    expect(text).toContain("decision|fact|preference|note|issue|context");
    expect(text).toContain("active|superseded|archived");
    expect(text).toContain("conversation|file|url|command|other");
    expect(text).toMatch(/-- <body>/);
    expect(text).toMatch(/quote/i);
  });

  it("init subcommand initializes .engram after confirm", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-empty-"));
    process.chdir(empty);
    try {
      const { pi, commands } = fakePi();
      engramExtension(pi);
      const ctx = fakeCtx();
      await commands.get("engram")!.handler("init", ctx);
      expect(fs.existsSync(projectConfigPath(empty))).toBe(true);
      expect(notified(ctx)[0].text).toContain(".engram");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("help subcommand prints usage", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    const ctx = fakeCtx();
    await commands.get("engram")!.handler("help", ctx);
    expect(notified(ctx)[0].text).toContain("/engram search");
  });

  it("usage errors notify at error level", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    const ctx = fakeCtx();
    await commands.get("engram")!.handler("search", ctx);
    expect(notified(ctx)[0].level).toBe("error");
  });

  it("invalid --scope is rejected, not silently defaulted", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    const ctx = fakeCtx();
    await commands.get("engram")!.handler("add Should not record --scope persoanl -- body", ctx);
    const notes = notified(ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("error");
    expect(notes[0].text).toContain('"persoanl"');
    // nothing was written: the project store stays empty
    expect(fs.readdirSync(projectEngramsDir(tmp))).toEqual([]);
  });

  it("invalid --type is rejected, not silently defaulted", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    const ctx = fakeCtx();
    await commands.get("engram")!.handler("add Also not recorded --type descision -- body", ctx);
    const notes = notified(ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("error");
    expect(notes[0].text).toContain('"descision"');
    expect(fs.readdirSync(projectEngramsDir(tmp))).toEqual([]);
  });

  it("add subcommand accepts the six lifecycle value flags", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    // ENG-17 R5: supersedes must resolve to an existing active entry
    seedEntry(tmp, "0001", "Add predecessor");
    const ctx = fakeCtx();
    await commands
      .get("engram")!
      .handler(
        "add Superseded pick -- the new guidance --status superseded --supersedes 0001 " +
          "--review-after 2026-01-01T00:00:00.000Z --expires 2026-06-01T00:00:00.000Z " +
          "--source-type file --source-ref docs/a.md",
        ctx,
      );
    const notes = notified(ctx);
    expect(notes[0].level).toBe("info");
    const file = notes[0].text.match(/  (\S+\.md)/)?.[1];
    expect(file).toBeDefined();
    const content = fs.readFileSync(file!, "utf8");
    expect(content).toContain("status: superseded");
    expect(content).toContain('supersedes: "0001"');
    expect(content).toContain("reviewAfter: 2026-01-01T00:00:00.000Z");
    expect(content).toContain("expires: 2026-06-01T00:00:00.000Z");
    expect(content).toContain("sourceType: file");
    expect(content).toContain("docs/a.md");
  });

  it("--source-ref accepts a quoted multiword reference verbatim", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    const ctx = fakeCtx();
    await commands
      .get("engram")!
      .handler(
        'add Quoted ref -- body --source-type conversation --source-ref "deps standup, 2025-01-14"',
        ctx,
      );
    const notes = notified(ctx);
    expect(notes[0].level).toBe("info");
    const file = notes[0].text.match(/  (\S+\.md)/)?.[1];
    const content = fs.readFileSync(file!, "utf8");
    // extracted into frontmatter verbatim, not left in the body
    expect(content).toContain("sourceRef: deps standup, 2025-01-14");
    expect(content).not.toContain("--source-ref");
  });

  it("invalid --status is rejected, not silently defaulted", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    const ctx = fakeCtx();
    await commands.get("engram")!.handler("add Never recorded --status bogus -- body", ctx);
    const notes = notified(ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("error");
    expect(notes[0].text).toContain('"bogus"');
    expect(notes[0].text).toContain("active | superseded | archived");
    expect(fs.readdirSync(projectEngramsDir(tmp))).toEqual([]);
  });

  it("invalid --source-type is rejected, not silently defaulted", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    const ctx = fakeCtx();
    await commands.get("engram")!.handler("add Never recorded --source-type website -- body", ctx);
    const notes = notified(ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("error");
    expect(notes[0].text).toContain('"website"');
    expect(fs.readdirSync(projectEngramsDir(tmp))).toEqual([]);
  });

  it("help discloses the lifecycle flags and the quoted source-ref rule", async () => {
    const { pi, commands } = fakePi();
    engramExtension(pi);
    const ctx = fakeCtx();
    await commands.get("engram")!.handler("help", ctx);
    const help = notified(ctx)[0].text;
    expect(help).toContain("--status active|superseded|archived");
    expect(help).toContain("--supersedes");
    expect(help).toContain("--review-after");
    expect(help).toContain("--expires");
    expect(help).toContain("--source-type");
    expect(help).toContain("--source-ref");
    expect(help).toMatch(/--source-ref .*quot/i);
  });

  it("command adds refresh the cache on success only", async () => {
    let refreshes = 0;
    const fake = fakePi();
    registerEngramCommand(fake.pi, { onWriteSuccess: () => refreshes++ });
    const handler = fake.commands.get("engram")!.handler;

    const bad = fakeCtx();
    await handler("add Never recorded --status bogus -- body", bad);
    expect(refreshes).toBe(0);

    const good = fakeCtx();
    await handler("add Refreshed -- it worked --status active", good);
    expect(refreshes).toBe(1);
  });
});

describe("engram extension / lifecycle schema contract", () => {
  const baseParams = { title: "T", body: "b" };

  const piAddTool = () => {
    const { pi, tools } = fakePi();
    engramExtension(pi);
    return tools.find((t) => t.name === "engram_add")!;
  };

  const piEditTool = () => {
    const { pi, tools } = fakePi();
    engramExtension(pi);
    return tools.find((t) => t.name === "engram_edit")!;
  };

  it("engram_add schema enforces the lifecycle enums (TypeBox Value.Check)", () => {
    const parameters = piAddTool().parameters;
    const accepts = {
      ...baseParams,
      status: "active",
      supersedes: "0001",
      reviewAfter: "2026-01-01T00:00:00.000Z",
      expires: "2026-06-01T00:00:00.000Z",
      sourceType: "file",
      sourceRef: "docs/a.md",
    };
    expect(Value.Check(parameters, accepts)).toBe(true);
    for (const status of ["active", "superseded", "archived"]) {
      expect(Value.Check(parameters, { ...baseParams, status })).toBe(true);
    }
    expect(Value.Check(parameters, { ...baseParams, status: "bogus" })).toBe(false);
    for (const sourceType of ["conversation", "file", "url", "command", "other"]) {
      expect(Value.Check(parameters, { ...baseParams, sourceType })).toBe(true);
    }
    expect(Value.Check(parameters, { ...baseParams, sourceType: "website" })).toBe(false);
  });

  it("lifecycle param descriptions state the real contract without overclaims", () => {
    const props = piAddTool().parameters.properties as Record<
      string,
      { description?: string } | undefined
    >;
    expect(props.status?.description).toContain("active | superseded | archived");
    expect(props.sourceType?.description).toContain("conversation | file | url | command | other");
    // timestamps, ids, and refs are enforced when saved, not by the schema:
    // descriptions must say so instead of claiming schema-level enforcement
    for (const field of ["supersedes", "reviewAfter", "expires", "sourceRef"] as const) {
      expect(props[field]?.description, field).toMatch(/when saved/);
      expect(props[field]?.description, field).not.toMatch(/schema|type:|must be a valid/);
    }
  });

  it("engram_edit schema accepts the three-state lifecycle and rejects bad shapes (TypeBox Value.Check)", () => {
    const parameters = piEditTool().parameters;
    const base = { id: "0001" };
    // omission-only edits are schema-valid; id is the only required field
    expect(Value.Check(parameters, base)).toBe(true);
    expect(Value.Check(parameters, {})).toBe(false);

    for (const type of ["decision", "fact", "preference", "note", "issue", "context"]) {
      expect(Value.Check(parameters, { ...base, type }), type).toBe(true);
    }
    expect(Value.Check(parameters, { ...base, type: "bogus" })).toBe(false);
    expect(Value.Check(parameters, { ...base, type: null })).toBe(false);

    for (const status of ["active", "superseded", "archived", null]) {
      expect(Value.Check(parameters, { ...base, status }), String(status)).toBe(true);
    }
    expect(Value.Check(parameters, { ...base, status: "bogus" })).toBe(false);

    for (const sourceType of ["conversation", "file", "url", "command", "other", null]) {
      expect(Value.Check(parameters, { ...base, sourceType }), String(sourceType)).toBe(true);
    }
    expect(Value.Check(parameters, { ...base, sourceType: "website" })).toBe(false);

    // nullable lifecycle strings: value or null accepted, wrong type rejected
    expect(Value.Check(parameters, { ...base, supersedes: "0001" })).toBe(true);
    expect(Value.Check(parameters, { ...base, supersedes: null })).toBe(true);
    expect(Value.Check(parameters, { ...base, supersedes: 5 })).toBe(false);
    expect(Value.Check(parameters, { ...base, reviewAfter: "2026-01-01" })).toBe(true);
    expect(Value.Check(parameters, { ...base, reviewAfter: null })).toBe(true);
    expect(Value.Check(parameters, { ...base, expires: null })).toBe(true);
    expect(Value.Check(parameters, { ...base, sourceRef: null })).toBe(true);

    // ordinary fields accept values and reject null
    expect(Value.Check(parameters, { ...base, title: "New" })).toBe(true);
    expect(Value.Check(parameters, { ...base, title: null })).toBe(false);
    expect(Value.Check(parameters, { ...base, tags: ["a"] })).toBe(true);
    expect(Value.Check(parameters, { ...base, tags: "a,b" })).toBe(false);
    expect(Value.Check(parameters, { ...base, tags: null })).toBe(false);
    expect(Value.Check(parameters, { ...base, body: null })).toBe(false);
    expect(Value.Check(parameters, { ...base, pinned: false })).toBe(true);
    expect(Value.Check(parameters, { ...base, pinned: null })).toBe(false);
    expect(Value.Check(parameters, { ...base, author: null })).toBe(false);
    expect(Value.Check(parameters, { ...base, scope: "bogus" })).toBe(false);
    expect(Value.Check(parameters, { ...base, id: 5 })).toBe(false);
  });

  it("engram_edit param descriptions state the real contract without overclaims", () => {
    const props = piEditTool().parameters.properties as Record<
      string,
      { description?: string } | undefined
    >;
    // every nullable field must disclose the three-state contract
    for (const field of [
      "status",
      "supersedes",
      "reviewAfter",
      "expires",
      "sourceType",
      "sourceRef",
    ] as const) {
      expect(props[field]?.description, field).toMatch(/null clears/i);
      expect(props[field]?.description, field).toMatch(/omit to preserve/i);
    }
    // save-time semantic validation is disclosed, never claimed as schema-level
    for (const field of ["supersedes", "reviewAfter", "expires", "sourceRef"] as const) {
      expect(props[field]?.description, field).toMatch(/when saved/);
      expect(props[field]?.description, field).not.toMatch(/schema|type:|must be a valid/);
    }
    // ordinary and replacement-only fields disclose the two-state contract
    for (const field of ["title", "type", "tags", "body", "pinned", "author"] as const) {
      expect(props[field]?.description, field).toMatch(/omit to preserve/i);
      expect(props[field]?.description, field).not.toMatch(/null clears/i);
    }
  });

  it("add schemas agree on the lifecycle contract across pi and opencode", () => {
    const parameters = piAddTool().parameters;
    const ocSchema = z.object(ocAddTool.args as z.ZodRawShape);
    const cases: Array<Record<string, unknown>> = [
      { ...baseParams },
      { ...baseParams, status: "active" },
      { ...baseParams, status: "superseded" },
      { ...baseParams, status: "archived" },
      { ...baseParams, status: "bogus" },
      { ...baseParams, sourceType: "conversation" },
      { ...baseParams, sourceType: "other" },
      { ...baseParams, sourceType: "website" },
      { ...baseParams, reviewAfter: "2026-01-01T00:00:00.000Z" },
      { ...baseParams, reviewAfter: "2026-01-01" },
      { ...baseParams, expires: "2026-06-01T00:00:00.000Z" },
      { ...baseParams, supersedes: "0001" },
      { ...baseParams, sourceRef: "docs/a.md" },
      { ...baseParams, sourceRef: "" },
    ];
    for (const params of cases) {
      const piOk = Value.Check(parameters, params);
      const ocOk = ocSchema.safeParse(params).success;
      expect(piOk, JSON.stringify(params)).toBe(ocOk);
    }
  });

  it("edit schemas agree on the three-state lifecycle contract across pi and opencode", () => {
    const parameters = piEditTool().parameters;
    const ocSchema = z.object(ocEditTool.args as z.ZodRawShape);
    const base = { id: "0001" };
    const cases: Array<Record<string, unknown>> = [
      base,
      { ...base, title: "New" },
      { ...base, title: null },
      { ...base, type: "decision" },
      { ...base, type: "bogus" },
      { ...base, type: null },
      { ...base, tags: ["a"] },
      { ...base, tags: "a,b" },
      { ...base, tags: null },
      { ...base, body: null },
      { ...base, pinned: false },
      { ...base, pinned: null },
      { ...base, author: "A" },
      { ...base, author: null },
      { ...base, scope: "personal" },
      { ...base, scope: "bogus" },
      { ...base, id: 5 },
      ...["active", "superseded", "archived", null, "bogus"].map((status) => ({
        ...base,
        status,
      })),
      ...["conversation", "file", "url", "command", "other", null, "website"].map((sourceType) => ({
        ...base,
        sourceType,
      })),
      { ...base, supersedes: "0001" },
      { ...base, supersedes: null },
      { ...base, supersedes: 5 },
      { ...base, reviewAfter: "2026-01-01T00:00:00.000Z" },
      { ...base, reviewAfter: "2026-01-01" },
      { ...base, reviewAfter: null },
      { ...base, expires: "2026-06-01T00:00:00.000Z" },
      { ...base, expires: null },
      { ...base, sourceRef: "docs/a.md" },
      { ...base, sourceRef: "" },
      { ...base, sourceRef: null },
      {},
    ];
    for (const params of cases) {
      const piOk = Value.Check(parameters, params);
      const ocOk = ocSchema.safeParse(params).success;
      expect(piOk, JSON.stringify(params)).toBe(ocOk);
    }
  });
});

describe("engram extension / write refresh hook", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-pihome-"));
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refreshes the cache on successful add or edit only", async () => {
    let refreshes = 0;
    const fake = fakePi();
    registerEngramTools(fake.pi, { onWriteSuccess: () => refreshes++ });
    const add = fake.tools.find((t) => t.name === "engram_add")!;
    const edit = fake.tools.find((t) => t.name === "engram_edit")!;

    await add.execute("c1", { title: "T", body: "b", status: "bogus" });
    expect(refreshes).toBe(0);

    await add.execute("c2", { title: "T", body: "b", status: "active" });
    expect(refreshes).toBe(1);

    const seeded = (await add.execute("c3", { title: "Edit target", body: "b" })) as {
      details: { id: string };
    };
    expect(refreshes).toBe(2);

    await edit.execute("c4", { id: seeded.details.id, status: "bogus" });
    expect(refreshes).toBe(2);

    await edit.execute("c5", { id: seeded.details.id, title: "Edited target" });
    expect(refreshes).toBe(3);
  });
});
