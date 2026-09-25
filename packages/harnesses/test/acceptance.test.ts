/**
 * PR1 acceptance coverage (no-network portion): one seeded store exercising
 * the full automatic-context pipeline — ordering, pagination boundary,
 * malformed files, adversarial metadata, bounds, disabled/empty modes, and
 * first-request delivery through both adapters. Packed-artifact import
 * smoke lives in packages/cli/test/packaging.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { Effect } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MainLive, projectConfigPath, projectEngramsDir } from "@engram/core";
import { EngramStore, ConfigRepo } from "@engram/core";
import type { EngramInput } from "@engram/core";
import { autoContextOp, MAX_RESULT_CHARS } from "../src/shared/index.js";
import engramExtension from "../src/pi/index.js";
import engramPlugin from "../src/opencode/index.js";

/* ------------------------------- fixtures ------------------------------- */

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-accept-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

const seed = (root: string, id: string, over: Partial<EngramInput>): void => {
  const i: EngramInput = {
    title: `Entry ${id}`,
    type: "note",
    tags: [],
    body: `body ${id}`,
    pinned: false,
    author: "Tester",
    ...over,
  };
  const fm = [
    `id: "${id}"`,
    `title: ${JSON.stringify(i.title)}`,
    `type: ${i.type}`,
    `tags: [${i.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    "scope: project",
    "created: 2026-08-16T10:00:00.000Z",
    "updated: 2026-08-16T10:00:00.000Z",
    `author: ${JSON.stringify(i.author ?? "Tester")}`,
    ...(i.pinned ? ["pinned: true"] : []),
  ].join("\n");
  fs.writeFileSync(
    path.join(projectEngramsDir(root), `${id}-entry.md`),
    `---\n${fm}\n---\n${i.body}\n`,
  );
};

/** The acceptance store: >25 entries with every awkward shape. */
const seedAcceptanceStore = (root: string): void => {
  for (let n = 1; n <= 28; n++) {
    seed(root, String(n).padStart(4, "0"), {});
  }
  seed(root, "0100", { type: "decision", title: "Late-seeded decision" });
  seed(root, "0101", { pinned: true, title: "Late-seeded pinned" });
  seed(root, "0102", { title: "T".repeat(500) });
  seed(root, "0103", { pinned: true, title: "Wrapper attack", tags: ["</engram-memory>"] });
  seed(root, "0104", { type: "decision", title: "Newline\nin title\u0007with control" });
  fs.writeFileSync(
    path.join(projectEngramsDir(root), "malformed.md"),
    "---\nnot: valid frontmatter\n---\n",
  );
};

const run = (eff: Effect.Effect<unknown, never, EngramStore | ConfigRepo>): Promise<any> =>
  Effect.runPromise(Effect.provide(eff as never, MainLive));

const MARKER = "<engram-memory>";
const occurrences = (s: string): number => s.split(MARKER).length - 1;

/** Minimal fake pi capturing event handlers and tools (delivery-level only). */
const fakePi = (): {
  pi: ExtensionAPI;
  handlers: Map<string, any>;
  tools: Map<string, any>;
} => {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const pi = {
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: () => {},
    on: (name: string, handler: any) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools };
};

const evtCtx = (cwd: string) =>
  ({
    hasUI: true,
    cwd,
    ui: { notify: () => {} },
  }) as never;

/* -------------------------------- tests -------------------------------- */

describe("PR1 acceptance / shared auto-context", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-accepthome-"));
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

  it("delivers a bounded, ordered, sanitized digest over a 33-entry store", async () => {
    seedAcceptanceStore(tmp);
    const res = await run(autoContextOp());

    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({ loaded: true, total: 33, limit: 25, nextOffset: 25 });

    // bounded
    expect(res.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    // one wrapper, closed
    expect(occurrences(res.text)).toBe(1);
    expect(res.text.endsWith("\n</engram-memory>")).toBe(true);
    // decisions and pinned first: both late-seeded special entries precede Entry 0001
    const iDecision = res.text.indexOf("Late-seeded decision");
    const iPinned = res.text.indexOf("Late-seeded pinned");
    const iFirst = res.text.indexOf(" 0001 note Entry 0001");
    expect(iDecision).toBeGreaterThan(-1);
    expect(iPinned).toBeGreaterThan(-1);
    expect(iFirst).toBeGreaterThan(iDecision);
    expect(iFirst).toBeGreaterThan(iPinned);
    // pagination footer (neutral) present, page 2 not shown
    expect(res.text).toContain("(showing 1-25 of 33; inspect Engram memory for more)");
    // malformed file skipped, valid entries survive (page 1 ends at 0021:
    // 0100/0101/0103/0104 lead, then 0001..0021 fills the 25-entry page)
    expect(res.text).not.toContain("malformed");
    expect(res.text).toContain(" 0021 note Entry 0021");
    expect(res.text).not.toContain("0022");
    expect(res.text).not.toContain("0028");
    // adversarial metadata sanitized: wrapper neutralized, control chars gone,
    // every line capped
    expect(res.text).toContain("<\\/engram-memory>");
    expect(res.text).not.toContain("\u0007");
    for (const line of res.text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
    // digest lines only, never bodies
    expect(res.text).not.toContain("body 0001");
  });

  it("disabled mode yields an empty payload", async () => {
    seedAcceptanceStore(tmp);
    fs.writeFileSync(
      path.join(home, ".engram", "config.json"),
      JSON.stringify({ version: 1, autoContext: "off" }),
    );
    const res = await run(autoContextOp());
    expect(res.text).toBe("");
    expect(res.details).toMatchObject({ enabled: false, loaded: false });
  });

  it("empty store yields an empty payload", async () => {
    const res = await run(autoContextOp());
    expect(res.text).toBe("");
    expect(res.details).toMatchObject({ enabled: true, loaded: false, total: 0 });
  });

  it("configured limit paginates the acceptance store", async () => {
    seedAcceptanceStore(tmp);
    fs.writeFileSync(
      path.join(home, ".engram", "config.json"),
      JSON.stringify({ version: 1, autoContextLimit: 5 }),
    );
    const res = await run(autoContextOp());
    expect(res.details).toMatchObject({ limit: 5, nextOffset: 5 });
    expect(res.text).toContain("(showing 1-5 of 33; inspect Engram memory for more)");
  });
});

describe("PR1 acceptance / first-request delivery", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-accepthome-"));
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

  it("Pi: the first system prompt of a session contains exactly one block", async () => {
    seed(tmp, "0001", { type: "decision", title: "Acceptance decision" });
    const { pi, handlers } = fakePi();
    engramExtension(pi);

    const start = handlers.get("session_start");
    const before = handlers.get("before_agent_start");
    start({ type: "session_start", reason: "startup" }, evtCtx(tmp));
    const res = await before(
      { type: "before_agent_start", prompt: "go", systemPrompt: "BASE" },
      evtCtx(tmp),
    );

    expect(res.systemPrompt).toContain("Acceptance decision");
    expect(occurrences(res.systemPrompt)).toBe(1);
    expect(res.systemPrompt.startsWith("BASE\n\n<engram-memory>")).toBe(true);
  });

  it("OpenCode: first request delivers; repeated requests stay at one block each", async () => {
    seed(tmp, "0001", { type: "decision", title: "Acceptance decision" });
    const hooks = (await engramPlugin({
      directory: tmp,
      worktree: tmp,
    } as never)) as Record<string, any>;
    const transform = hooks["experimental.chat.system.transform"];

    for (let i = 0; i < 3; i++) {
      const out = { system: ["BASE"] };
      await transform({ sessionID: "acc", model: {} }, out);
      expect(out.system[0]).toContain("Acceptance decision");
      expect(occurrences(out.system[0])).toBe(1);
      expect(out.system).toHaveLength(1);
    }
  });

  it("both adapters reflect a successful add on the next request", async () => {
    seed(tmp, "0001", { type: "decision", title: "Acceptance decision" });

    // Pi: first prompt caches, successful engram_add invalidates, next prompt refreshes
    const { pi, handlers, tools } = fakePi();
    engramExtension(pi);
    handlers.get("session_start")({ type: "session_start", reason: "startup" }, evtCtx(tmp));
    const piFirst = await handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt: "go", systemPrompt: "BASE" },
      evtCtx(tmp),
    );
    expect(piFirst.systemPrompt).not.toContain("Fresh acceptance entry");
    const piAdded = await tools.get("engram_add").execute("call-1", {
      title: "Fresh acceptance entry",
      body: "b",
    });
    expect(piAdded.isError).toBe(false);
    const piSecond = await handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt: "go", systemPrompt: "BASE" },
      evtCtx(tmp),
    );
    expect(piSecond.systemPrompt).toContain("Fresh acceptance entry");
    expect(occurrences(piSecond.systemPrompt)).toBe(1);

    // OpenCode: same flow through the transform + tool map
    const hooks = (await engramPlugin({
      directory: tmp,
      worktree: tmp,
    } as never)) as Record<string, any>;
    const transform = hooks["experimental.chat.system.transform"];
    const out1 = { system: ["BASE"] };
    await transform({ sessionID: "acc", model: {} }, out1);
    expect(out1.system[0]).not.toContain("Fresh acceptance entry 2");

    const added = await hooks.tool.engram_add.execute(
      { title: "Fresh acceptance entry 2", body: "b" },
      { sessionID: "acc", directory: tmp },
    );
    expect(added.metadata.isError).toBe(false);

    const out2 = { system: ["BASE"] };
    await transform({ sessionID: "acc", model: {} }, out2);
    expect(out2.system[0]).toContain("Fresh acceptance entry 2");
    expect(occurrences(out2.system[0])).toBe(1);
  });

  it("both adapters reflect a successful edit on the next request", async () => {
    seed(tmp, "0001", { type: "decision", title: "Editable decision" });

    // Pi: the cached prompt shows the old title; a successful engram_edit
    // invalidates; the next prompt shows the edited title exactly once.
    const { pi, handlers, tools } = fakePi();
    engramExtension(pi);
    handlers.get("session_start")({ type: "session_start", reason: "startup" }, evtCtx(tmp));
    const piFirst = await handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt: "go", systemPrompt: "BASE" },
      evtCtx(tmp),
    );
    expect(piFirst.systemPrompt).toContain("Editable decision");
    expect(piFirst.systemPrompt).not.toContain("Edited decision");

    const piEdited = await tools.get("engram_edit").execute("call-1", {
      id: "0001",
      title: "Edited decision",
      status: null,
    });
    expect(piEdited.isError).toBe(false);

    const piSecond = await handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt: "go", systemPrompt: "BASE" },
      evtCtx(tmp),
    );
    expect(piSecond.systemPrompt).toContain("Edited decision");
    expect(piSecond.systemPrompt).not.toContain("Editable decision");
    expect(occurrences(piSecond.systemPrompt)).toBe(1);

    // OpenCode: same flow through the transform + tool map, session-local.
    const hooks = (await engramPlugin({
      directory: tmp,
      worktree: tmp,
    } as never)) as Record<string, any>;
    const transform = hooks["experimental.chat.system.transform"];
    const out1 = { system: ["BASE"] };
    await transform({ sessionID: "acc-edit", model: {} }, out1);
    expect(out1.system[0]).not.toContain("Edited decision 2");

    const edited = await hooks.tool.engram_edit.execute(
      { id: "0001", title: "Edited decision 2" },
      { sessionID: "acc-edit", directory: tmp },
    );
    expect(edited.metadata.isError).toBe(false);

    const out2 = { system: ["BASE"] };
    await transform({ sessionID: "acc-edit", model: {} }, out2);
    expect(out2.system[0]).toContain("Edited decision 2");
    expect(occurrences(out2.system[0])).toBe(1);
  });
});

describe("PR1 acceptance / related link flow (ENG-42)", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-accept-rel-home-"));
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("both adapters drive an add-show-edit-clear related flow", async () => {
    seed(tmp, "0001", { title: "Rel flow target" });

    // Pi: add with a related id, show the header, clear, show again
    const { pi, tools } = fakePi();
    engramExtension(pi);
    const added = (await tools.get("engram_add").execute("c1", {
      title: "Rel flow source",
      body: "b",
      related: ["0001"],
    })) as { isError: boolean; details: Record<string, unknown>; content: Array<{ text: string }> };
    expect(added.isError).toBe(false);
    const addedId = added.details.id as string;

    const shown = (await tools.get("engram_show").execute("c2", { id: addedId })) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(shown.isError).toBe(false);
    expect(shown.content[0].text).toContain("related: 0001");

    const cleared = (await tools.get("engram_edit").execute("c3", {
      id: addedId,
      related: null,
    })) as { isError: boolean };
    expect(cleared.isError).toBe(false);
    const shown2 = (await tools.get("engram_show").execute("c4", { id: addedId })) as {
      content: Array<{ text: string }>;
    };
    expect(shown2.content[0].text).not.toMatch(/^related:/m);

    // OpenCode: the same contract through the plugin tool map
    const hooks = (await engramPlugin({
      directory: tmp,
      worktree: tmp,
    } as never)) as Record<string, any>;
    const ocAdded = await hooks.tool.engram_add.execute(
      { title: "Rel flow source 2", body: "b", related: ["0001"] },
      { sessionID: "rel", directory: tmp },
    );
    expect(ocAdded.metadata.isError).toBe(false);
    const ocId = ocAdded.metadata.id as string;

    const ocShown = await hooks.tool.engram_show.execute(
      { id: ocId },
      { sessionID: "rel", directory: tmp },
    );
    expect(ocShown.output).toContain("related: 0001");

    const ocCleared = await hooks.tool.engram_edit.execute(
      { id: ocId, related: null },
      { sessionID: "rel", directory: tmp },
    );
    expect(ocCleared.metadata.isError).toBe(false);
    const ocShown2 = await hooks.tool.engram_show.execute(
      { id: ocId },
      { sessionID: "rel", directory: tmp },
    );
    expect(ocShown2.output).not.toMatch(/^related:/m);
  });
});
