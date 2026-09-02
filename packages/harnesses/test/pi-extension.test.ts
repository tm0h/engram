import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import { Value } from "typebox/value";
import { z } from "zod";
import engramExtension from "../src/pi/index.js";
import { registerEngramTools } from "../src/pi/tools.js";
import { engramAddTool as ocAddTool } from "../src/opencode/tools.js";

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
  it("registers the four engram tools and the /engram command", () => {
    const { pi, tools, commands } = fakePi();
    engramExtension(pi);

    expect(tools.map((t) => t.name)).toEqual([
      "engram_context",
      "engram_search",
      "engram_show",
      "engram_add",
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
});

describe("engram extension / lifecycle schema contract", () => {
  const baseParams = { title: "T", body: "b" };

  const piAddTool = () => {
    const { pi, tools } = fakePi();
    engramExtension(pi);
    return tools.find((t) => t.name === "engram_add")!;
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
    expect(props.sourceType?.description).toContain(
      "conversation | file | url | command | other",
    );
    // timestamps, ids, and refs are enforced when saved, not by the schema:
    // descriptions must say so instead of claiming schema-level enforcement
    for (const field of ["supersedes", "reviewAfter", "expires", "sourceRef"] as const) {
      expect(props[field]?.description, field).toMatch(/when saved/);
      expect(props[field]?.description, field).not.toMatch(/schema|type:|must be a valid/);
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
});

describe("engram extension / add refresh hook", () => {
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

  it("refreshes the cache on successful adds only", async () => {
    let refreshes = 0;
    const fake = fakePi();
    registerEngramTools(fake.pi, { onAddSuccess: () => refreshes++ });
    const add = fake.tools.find((t) => t.name === "engram_add")!;

    await add.execute("c1", { title: "T", body: "b", status: "bogus" });
    expect(refreshes).toBe(0);

    await add.execute("c2", { title: "T", body: "b", status: "active" });
    expect(refreshes).toBe(1);
  });
});
