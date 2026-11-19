import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import type { AutomaticContextResult } from "../src/shared/automatic-compaction.js";
import { frameRecall } from "../src/shared/recall-frame.js";
import { registerAutoContext, type AutoContextLoader } from "../src/pi/context-hook.js";
import engramExtension from "../src/pi/index.js";
import { registerEngramCommand } from "../src/pi/commands.js";
import { registerEngramTools } from "../src/pi/tools.js";

/* --------------------------- fake pi harness --------------------------- */

type AnyHandler = (event: any, ctx: ExtensionContext) => unknown;

function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, AnyHandler>;
} {
  const handlers = new Map<string, AnyHandler>();
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (name: string, handler: AnyHandler) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

/** Context for event handlers: cwd, hasUI, and a recording notify. */
function evtCtx(over: Partial<{ cwd: string; hasUI: boolean }> = {}): {
  ctx: ExtensionContext;
  notes: Array<{ message: string; level: string }>;
} {
  const notes: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      notify: (message: string, level = "info") => notes.push({ message, level }),
      confirm: async () => true,
      input: async () => "",
      select: async () => undefined,
    },
  } as unknown as ExtensionContext;
  return { ctx: { ...ctx, ...over } as ExtensionContext, notes };
}

const sessionStart = (reason: SessionStartEvent["reason"]): SessionStartEvent => ({
  type: "session_start",
  reason,
});

const agentStart = (systemPrompt: string, prompt = "seeded"): BeforeAgentStartEvent => ({
  type: "before_agent_start",
  prompt,
  systemPrompt,
  systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
});

const payloadFor = (title: string) => frameRecall(`project/0001 note ${JSON.stringify(title)}`);
const okResult = (title: string): AutomaticContextResult => ({
  text: "",
  isError: false,
  details: {},
  automatic: {
    rows: title ? [{ id: "0001", scope: "project", type: "note", title, snippet: null }] : [],
    maxChars: 4800,
  },
});

const errResult = (): AutomaticContextResult => ({
  text: "",
  isError: false,
  details: { reason: "unavailable" },
});

const BASE = "You are a helpful coding agent.";

const countOf = (s: string, needle: string): number => s.split(needle).length - 1;

describe("Pi contextual recall", () => {
  const payload = payloadFor("context");

  it("waits for the first prompt and uses its exact text and directory", async () => {
    let resolve!: (result: AutomaticContextResult) => void;
    const load = vi.fn<AutoContextLoader>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { pi, handlers } = fakePi();
    registerAutoContext(pi, { load });
    const { ctx } = evtCtx({ cwd: "/other/project", hasUI: false });
    handlers.get("session_start")!(sessionStart("startup"), ctx);
    expect(load).not.toHaveBeenCalled();

    const before = handlers.get("before_agent_start")!;
    const event = agentStart(BASE + "\nEarlier extension", "Refactor Redis retries");
    const first = before(event, ctx);
    const repeated = before(event, ctx);
    expect(load).toHaveBeenCalledExactlyOnceWith("/other/project", event.prompt);
    resolve(okResult("context"));
    for (const pending of [first, repeated]) {
      await expect(pending).resolves.toEqual({
        systemPrompt: event.systemPrompt + "\n\n" + payload,
      });
    }
  });

  it("fits each assembled prompt and respects Pi's prior context estimate", async () => {
    const { pi, handlers } = fakePi();
    const diagnostics = vi.fn();
    registerAutoContext(pi, { load: async () => okResult("context"), onDiagnostics: diagnostics });
    const before = handlers.get("before_agent_start")!;
    const { ctx } = evtCtx();
    const output = (await before(agentStart(BASE), ctx)) as { systemPrompt: string };
    expect(output.systemPrompt).toBe(BASE + "\n\n" + payload);
    expect(diagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ window: "fallback" }));
    await expect(before(agentStart(output.systemPrompt), ctx)).resolves.toBeUndefined();
    expect(diagnostics).toHaveBeenLastCalledWith(
      expect.objectContaining({ deduplicated: [{ scope: "project", id: "0001" }] }),
    );
    const crowded = {
      ...ctx,
      model: { contextWindow: 4096, maxTokens: 256 },
      getContextUsage: () => ({ tokens: 3780, contextWindow: 4096, percent: 92 }),
    } as ExtensionContext;
    await expect(before(agentStart(BASE), crowded)).resolves.toBeUndefined();
    await expect(before(agentStart(BASE), ctx)).resolves.toEqual(output);
  });

  it.each(["startup", "reload", "new", "resume", "fork"] as const)(
    "discards in-flight reads on %s",
    async (reason) => {
      let resolve!: (result: AutomaticContextResult) => void;
      const load = vi
        .fn<AutoContextLoader>()
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        )
        .mockResolvedValue(okResult("context"));
      const { pi, handlers } = fakePi();
      registerAutoContext(pi, { load });
      const { ctx } = evtCtx();
      const before = handlers.get("before_agent_start")!;
      const pending = before(agentStart(BASE), ctx);
      handlers.get("session_start")!(sessionStart(reason), ctx);
      await expect(before(agentStart(BASE), ctx)).resolves.toEqual({
        systemPrompt: BASE + "\n\n" + payload,
      });
      resolve(okResult("stale"));
      await expect(pending).resolves.toBeUndefined();
    },
  );

  it.each(["directory", "query", "write"] as const)(
    "drops a pending result after a %s change",
    async (change) => {
      let resolve!: (result: AutomaticContextResult) => void;
      const load = vi
        .fn<AutoContextLoader>()
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        )
        .mockResolvedValue(okResult("context"));
      const { pi, handlers } = fakePi();
      const { invalidate } = registerAutoContext(pi, { load });
      const before = handlers.get("before_agent_start")!;
      const { ctx } = evtCtx({ cwd: "/first" });
      const pending = before(agentStart(BASE), ctx);
      if (change === "write") invalidate();
      await expect(
        before(
          agentStart(BASE, change === "query" ? "Redis" : undefined),
          change === "directory" ? evtCtx({ cwd: "/second" }).ctx : ctx,
        ),
      ).resolves.toEqual({ systemPrompt: BASE + "\n\n" + payload });
      resolve(okResult("stale"));
      await expect(pending).resolves.toBeUndefined();
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it("checks the store again for each full prompt and skips oversized prompts", async () => {
    const load = vi
      .fn<AutoContextLoader>()
      .mockResolvedValueOnce(okResult("context"))
      .mockResolvedValue(okResult(""));
    const { pi, handlers } = fakePi();
    registerAutoContext(pi, { load });
    const before = handlers.get("before_agent_start")!;
    const { ctx } = evtCtx();
    await expect(before(agentStart(BASE), ctx)).resolves.toEqual({
      systemPrompt: BASE + "\n\n" + payload,
    });
    await expect(before(agentStart(BASE), ctx)).resolves.toBeUndefined();
    await expect(before(agentStart(BASE, "x".repeat(4097)), ctx)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unavailable", () => Promise.resolve(errResult())],
    ["rejected", () => Promise.reject(new Error("private async error"))],
    [
      "thrown",
      () => {
        throw new Error("private sync error");
      },
    ],
  ] satisfies Array<[string, AutoContextLoader]>)(
    "fails open for %s reads",
    async (_name, load) => {
      const { pi, handlers } = fakePi();
      registerAutoContext(pi, { load });
      const before = handlers.get("before_agent_start")!;
      const { ctx, notes } = evtCtx();
      await expect(before(agentStart(BASE), ctx)).resolves.toBeUndefined();
      await expect(before(agentStart(BASE), ctx)).resolves.toBeUndefined();
      expect(notes).toEqual([
        { message: expect.stringContaining("could not be loaded"), level: "warning" },
      ]);
      expect(notes[0].message).not.toContain("private");

      const headless = {
        hasUI: false,
        cwd: "/w",
        get ui() {
          throw new Error("UI unavailable");
        },
      } as unknown as ExtensionContext;
      handlers.get("session_start")!(sessionStart("reload"), headless);
      await expect(before(agentStart(BASE), headless)).resolves.toBeUndefined();
      expect(notes).toHaveLength(1);
    },
  );
});

/* ----------------- integration with the real extension ---------------- */

/** Fake pi that captures both tools/commands and event handlers. */
function fullFakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, AnyHandler>;
  tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
} {
  const handlers = new Map<string, AnyHandler>();
  const tools: Array<{
    name: string;
    execute: (id: string, params: unknown) => Promise<unknown>;
  }> = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    registerTool: (t: {
      name: string;
      execute: (id: string, params: unknown) => Promise<unknown>;
    }) => tools.push(t),
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, def),
    on: (name: string, handler: AnyHandler) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, commands };
}

const seedEntry = (root: string, id: string, title: string): void => {
  const fm = [
    `id: "${id}"`,
    `title: ${JSON.stringify(title)}`,
    "type: decision",
    "importance: 3",
    "tags: []",
    "scope: project",
    "created: 2026-08-16T10:00:00.000Z",
    "updated: 2026-08-16T10:00:00.000Z",
  ].join("\n");
  fs.writeFileSync(path.join(projectEngramsDir(root), `${id}-entry.md`), `---\n${fm}\n---\nbody\n`);
};

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-pihook-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

describe("pi extension / auto-context integration", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-pihookhome-"));
    fs.mkdirSync(path.join(home, ".engram", "engrams"), { recursive: true });
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("delivers relevant excerpts into the first system prompt", async () => {
    seedEntry(tmp, "0001", "Seeded decision");
    const { pi, handlers } = fullFakePi();
    engramExtension(pi);

    const { ctx } = evtCtx({ cwd: tmp });
    handlers.get("session_start")!(sessionStart("startup"), ctx);
    const res = (await handlers.get("before_agent_start")!(agentStart(BASE), ctx)) as {
      systemPrompt?: string;
    };

    expect(res.systemPrompt).toContain('project/0001 decision "Seeded decision" — "body"');
    expect(countOf(res.systemPrompt!, "<engram-memory>")).toBe(1);
    await expect(
      handlers.get("before_agent_start")!(agentStart(BASE, "volcano"), ctx),
    ).resolves.toBeUndefined();
  });

  it("a successful engram_add invalidates the cache; the next prompt sees the new entry", async () => {
    seedEntry(tmp, "0001", "Seeded decision");
    const { pi, handlers, tools } = fullFakePi();
    engramExtension(pi);
    const add = tools.find((t) => t.name === "engram_add")!;

    const { ctx } = evtCtx({ cwd: tmp });
    handlers.get("session_start")!(sessionStart("startup"), ctx);
    const first = (await handlers.get("before_agent_start")!(agentStart(BASE), ctx)) as {
      systemPrompt?: string;
    };
    expect(first.systemPrompt).toContain("Seeded decision");
    expect(first.systemPrompt).not.toContain("Chose Postgres");

    const added = (await add.execute("call-1", {
      title: "Chose Postgres",
      pinned: true,
      body: "because of RLS",
      type: "decision",
    })) as { isError: boolean };
    expect(added.isError).toBe(false);

    const second = (await handlers.get("before_agent_start")!(
      agentStart(BASE, "Postgres"),
      ctx,
    )) as {
      systemPrompt?: string;
    };
    expect(second.systemPrompt).toContain("Chose Postgres");
    expect(countOf(second.systemPrompt!, "<engram-memory>")).toBe(1);
  });

  it("a successful engram_edit invalidates the cache; the next prompt sees the edited title", async () => {
    seedEntry(tmp, "0001", "Seeded decision");
    const { pi, handlers, tools } = fullFakePi();
    engramExtension(pi);
    const edit = tools.find((t) => t.name === "engram_edit")!;

    const { ctx } = evtCtx({ cwd: tmp });
    handlers.get("session_start")!(sessionStart("startup"), ctx);
    const first = (await handlers.get("before_agent_start")!(
      agentStart(BASE, "decision"),
      ctx,
    )) as {
      systemPrompt?: string;
    };
    expect(first.systemPrompt).toContain("Seeded decision");

    const edited = (await edit.execute("call-1", {
      id: "0001",
      title: "Edited decision",
    })) as { isError: boolean };
    expect(edited.isError).toBe(false);

    const second = (await handlers.get("before_agent_start")!(
      agentStart(BASE, "decision"),
      ctx,
    )) as {
      systemPrompt?: string;
    };
    expect(second.systemPrompt).toContain("Edited decision");
    expect(second.systemPrompt).not.toContain("Seeded decision");
    expect(countOf(second.systemPrompt!, "<engram-memory>")).toBe(1);
  });

  it("abstains after disabling recall even when the same query just matched", async () => {
    seedEntry(tmp, "0001", "Seeded decision");
    const { pi, handlers } = fullFakePi();
    engramExtension(pi);
    const { ctx } = evtCtx({ cwd: tmp });
    const before = handlers.get("before_agent_start")!;
    const event = agentStart(BASE);
    await expect(before(event, ctx)).resolves.toHaveProperty("systemPrompt");
    fs.writeFileSync(
      path.join(home, ".engram", "config.json"),
      JSON.stringify({ version: 1, autoContext: "off" }),
    );
    await expect(before(event, ctx)).resolves.toBeUndefined();
  });

  it("fails open on an empty store or unreadable configuration", async () => {
    const { pi, handlers } = fullFakePi();
    engramExtension(pi);
    const { ctx } = evtCtx({ cwd: tmp, hasUI: false });
    const before = handlers.get("before_agent_start")!;
    await expect(before(agentStart(BASE), ctx)).resolves.toBeUndefined();

    seedEntry(tmp, "0001", "Seeded decision");
    fs.writeFileSync(path.join(home, ".engram", "config.json"), "{broken");
    await expect(before(agentStart(BASE), ctx)).resolves.toBeUndefined();
  });

  it("invalidates reads only after successful tool and slash writes", async () => {
    const { pi, handlers, tools, commands } = fullFakePi();
    let resolve!: (result: AutomaticContextResult) => void;
    const { invalidate } = registerAutoContext(pi, {
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    registerEngramTools(pi, { onWriteSuccess: invalidate });
    registerEngramCommand(pi, { onWriteSuccess: invalidate });

    const { ctx } = evtCtx({ cwd: tmp });
    const before = handlers.get("before_agent_start")!;
    const add = tools.find((tool) => tool.name === "engram_add")!;
    const slash = commands.get("engram")!;
    const event = agentStart(BASE);

    const surviving = before(event, ctx);
    await expect(add.execute("invalid", { title: " ", body: "invalid" })).resolves.toMatchObject({
      isError: true,
    });
    await expect(
      add.execute("blocked", { title: "Blocked", body: "AKIAIOSFODNN7EXAMPLE" }),
    ).resolves.toMatchObject({
      isError: true,
      details: { reason: "secret_scan_blocked" },
    });
    await slash.handler("edit 9999 --title Missing", ctx);
    resolve(okResult("current"));
    await expect(surviving).resolves.toEqual({
      systemPrompt: BASE + "\n\n" + payloadFor("current"),
    });

    const beforeToolWrite = before(event, ctx);
    await expect(
      add.execute("approved", { title: "New memory", body: "reviewed change" }),
    ).resolves.toMatchObject({ isError: false });
    resolve(okResult("stale"));
    await expect(beforeToolWrite).resolves.toBeUndefined();

    const beforeSlashWrite = before(event, ctx);
    await slash.handler("add New slash memory -- reviewed change", ctx);
    resolve(okResult("stale"));
    await expect(beforeSlashWrite).resolves.toBeUndefined();
  });

  it("recalls successful /engram add and edit writes on following prompts", async () => {
    const { pi, handlers, commands } = fullFakePi();
    engramExtension(pi);
    const { ctx } = evtCtx({ cwd: tmp });
    const before = handlers.get("before_agent_start")!;
    const slash = commands.get("engram")!;
    const event = agentStart(BASE, "slash");

    await expect(before(event, ctx)).resolves.toBeUndefined();
    await slash.handler("add Via slash -- body text", ctx);
    const added = (await before(event, ctx)) as { systemPrompt: string };
    expect(added.systemPrompt).toContain("Via slash");
    const id = /^project\/([a-z0-9]+) /m.exec(added.systemPrompt)?.[1];
    expect(id).toBeDefined();
    await slash.handler(`edit ${id} --title "Edited slash"`, ctx);
    const edited = (await before(event, ctx)) as { systemPrompt: string };
    expect(edited.systemPrompt).toContain("Edited slash");
    expect(edited.systemPrompt).not.toContain("Via slash");
  });

  it("still registers the five tools and keeps their results unchanged", async () => {
    seedEntry(tmp, "0001", "Seeded decision");
    const { pi, tools } = fullFakePi();
    engramExtension(pi);
    expect(tools.map((t) => t.name)).toEqual([
      "engram_context",
      "engram_search",
      "engram_show",
      "engram_add",
      "engram_edit",
    ]);
    const context = tools.find((t) => t.name === "engram_context")!;
    const digest = (await context.execute("call-1", {})) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(digest.isError).toBe(false);
    expect(digest.content[0].text).toContain("Seeded decision");
    expect(digest.content[0].text).not.toContain("<engram-memory>");
  });
});
