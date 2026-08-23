/**
 * OpenCode automatic prompt delivery tests for the experimental
 * `chat.system.transform` seam.
 *
 * Unit level exercises createAutoContextTransform with an injected loader;
 * integration level runs the real plugin over a real store. The transform
 * must lazily load once per session (sharing one never-rejecting promise),
 * mutate output.system in place with at most one marker, stay fail-open, and
 * bound its cache deterministically.
 */
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import type { OpResult } from "../src/shared/index.js";
import { createAutoContextTransform, MAX_SESSIONS } from "../src/opencode/context-transform.js";
import engramPlugin from "../src/opencode/index.js";

/* ------------------------------- fixtures ------------------------------- */

type Loader = (directory: string) => Promise<OpResult>;

const okResult = (text: string): OpResult => ({ text, isError: false, details: {} });
const errResult = (): OpResult => ({
  text: "",
  isError: false,
  details: { loaded: false, error: "load failed" },
});

const PAYLOAD = "<engram-memory>\ndigest\n</engram-memory>";
const MARKER = "<engram-memory>";

const inputFor = (sessionID?: string) => ({ sessionID, model: {} });
const output = (system: string[]) => ({ system });

/** Total occurrences of `needle` across every element (not per-element presence). */
const countOf = (parts: string[], needle: string): number =>
  parts.reduce((sum, part) => sum + part.split(needle).length - 1, 0);

const seedEntry = (root: string, id: string, title: string): void => {
  const fm = [
    `id: "${id}"`,
    `title: ${JSON.stringify(title)}`,
    "type: decision",
    "tags: []",
    "scope: project",
    "created: 2026-08-16T10:00:00.000Z",
    "updated: 2026-08-16T10:00:00.000Z",
  ].join("\n");
  fs.writeFileSync(path.join(projectEngramsDir(root), `${id}-entry.md`), `---\n${fm}\n---\n`);
};

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-octx-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

/* ------------------------- unit: the transform ------------------------- */

describe("opencode auto-context transform / unit", () => {
  it("satisfies the installed SDK transform hook contract", () => {
    const { transform } = createAutoContextTransform("/w", { load: async () => okResult("") });
    // Type-level guard: fails to compile if @opencode-ai/plugin changes shape.
    const _typed: Hooks["experimental.chat.system.transform"] = transform;
    expect(typeof _typed).toBe("function");
  });

  it("loads lazily from the captured directory, once per session", async () => {
    const calls: string[] = [];
    const loader: Loader = async (dir) => {
      calls.push(dir);
      return okResult(PAYLOAD);
    };
    const { transform } = createAutoContextTransform("/w/project", { load: loader });

    const out1 = output(["base"]);
    await transform(inputFor("s1"), out1);
    // OpenCode rebuilds the system array per physical model request.
    const out2 = output(["base"]);
    await transform(inputFor("s1"), out2);
    const out3 = output(["base"]);
    await transform(inputFor("s1"), out3);

    expect(calls).toEqual(["/w/project"]); // exactly one load
    expect(out1.system).toEqual([`base\n\n${PAYLOAD}`]);
    expect(out2.system).toEqual([`base\n\n${PAYLOAD}`]); // reapplied every request
    expect(out3.system).toEqual([`base\n\n${PAYLOAD}`]);
  });

  it("ignores transforms without a sessionID", async () => {
    const loader: Loader = async () => {
      throw new Error("must not load");
    };
    const { transform } = createAutoContextTransform("/w", { load: loader });
    const out = output(["base"]);
    await transform(inputFor(undefined), out);
    await transform({} as { sessionID?: string; model: unknown }, out);
    expect(out.system).toEqual(["base"]);
  });

  it("concurrent first transforms for a session share one promise", async () => {
    let release!: (r: OpResult) => void;
    let loads = 0;
    const loader: Loader = () =>
      new Promise<OpResult>((resolve) => {
        loads += 1;
        release = resolve;
      });
    const { transform } = createAutoContextTransform("/w", { load: loader });

    const p1 = transform(inputFor("s1"), output(["base"]));
    const p2 = transform(inputFor("s1"), output(["base"]));
    release(okResult(PAYLOAD));
    await Promise.all([p1, p2]);

    expect(loads).toBe(1);
  });

  it("mutates output.system in place, preserving identity and prior content", async () => {
    const { transform } = createAutoContextTransform("/w", { load: async () => okResult(PAYLOAD) });

    const out = output(["base", "second element stays"]);
    const before = out.system;
    await transform(inputFor("s1"), out);
    expect(out.system).toBe(before); // same array, mutated in place
    expect(out.system[0]).toBe(`base\n\n${PAYLOAD}`);
    expect(out.system[1]).toBe("second element stays");
  });

  it("pushes a single string when the system array is empty", async () => {
    const { transform } = createAutoContextTransform("/w", { load: async () => okResult(PAYLOAD) });
    const out = output([]);
    await transform(inputFor("s1"), out);
    expect(out.system).toEqual([PAYLOAD]); // one system message, not two
  });

  it("never adds a second marker to the same output array", async () => {
    const { transform } = createAutoContextTransform("/w", { load: async () => okResult(PAYLOAD) });
    const out = output([`prior plugin already added ${PAYLOAD}`]);
    await transform(inputFor("s1"), out);
    expect(countOf(out.system, MARKER)).toBe(1);
    expect(out.system[0].startsWith("prior plugin")).toBe(true); // untouched

    // countOf sums occurrences, so a duplicated append inside one string
    // would be caught (guards against weakening this regression):
    expect(countOf([`x ${PAYLOAD} more ${PAYLOAD}`], MARKER)).toBe(2);
    // and our append path (empty array -> single string) yields exactly one.
    const fresh = output([]);
    await transform(inputFor("s2"), fresh);
    expect(countOf(fresh.system, MARKER)).toBe(1);
  });

  it("disabled, empty, and failed loads preserve the system prompt", async () => {
    for (const result of [okResult(""), errResult()]) {
      const { transform } = createAutoContextTransform("/w", { load: async () => result });
      const out = output(["base"]);
      await transform(inputFor("s1"), out);
      expect(out.system).toEqual(["base"]);
    }
  });

  it("fail-open: rejected, fast-rejected, and sync-throwing loaders never break the prompt", async () => {
    const cases: Array<{ name: string; loader: Loader }> = [
      { name: "rejection", loader: () => Promise.reject(new Error("boom")) },
      {
        name: "sync throw",
        loader: (() => {
          throw new Error("sync");
        }) as unknown as Loader,
      },
    ];
    for (const { name, loader } of cases) {
      const { transform } = createAutoContextTransform("/w", { load: loader });
      const out = output(["base"]);
      await expect(transform(inputFor("s1"), out)).resolves.toBeUndefined();
      expect(out.system).toEqual(["base"]);
      void name;
    }
  });

  it("a fast rejection between load start and the transform await stays handled", async () => {
    const { transform } = createAutoContextTransform("/w", {
      load: () => Promise.reject(new Error("fast")),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Trigger the lazy load, then let a full event-loop turn pass before
      // any transform awaits it.
      const trigger = output(["base"]);
      const pending = transform(inputFor("s1"), trigger); // starts + awaits
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toHaveLength(0);
      await pending;
      expect(trigger.system).toEqual(["base"]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("bounds the cache at 100 sessions with deterministic FIFO eviction", async () => {
    let loads = 0;
    const shared = createAutoContextTransform("/w", {
      load: async () => {
        loads += 1;
        return okResult(PAYLOAD);
      },
    });
    for (let i = 0; i <= MAX_SESSIONS; i++) {
      await shared.transform(inputFor(`sess-${i}`), output(["base"]));
    }
    expect(loads).toBe(MAX_SESSIONS + 1);

    // sess-0 was evicted (oldest); requesting it reloads.
    await shared.transform(inputFor("sess-0"), output(["base"]));
    expect(loads).toBe(MAX_SESSIONS + 2);
    // sess-1 was evicted too (inserted second) — deterministic FIFO.
    await shared.transform(inputFor("sess-1"), output(["base"]));
    expect(loads).toBe(MAX_SESSIONS + 3);
    // The newest session is still cached — no reload.
    await shared.transform(inputFor(`sess-${MAX_SESSIONS}`), output(["base"]));
    expect(loads).toBe(MAX_SESSIONS + 3);
  });

  it("invalidate drops exactly one session; the next request reloads", async () => {
    let payload = PAYLOAD;
    let loads = 0;
    const { transform, invalidate } = createAutoContextTransform("/w", {
      load: async () => {
        loads += 1;
        return okResult(payload);
      },
    });

    await transform(inputFor("s1"), output(["base"]));
    await transform(inputFor("s2"), output(["base"]));
    expect(loads).toBe(2);

    payload = "<engram-memory>\nfresh\n</engram-memory>";
    invalidate("s1");
    const out = output(["base"]);
    await transform(inputFor("s1"), out);
    expect(out.system[0]).toContain("fresh");
    expect(loads).toBe(3);
    // s2 untouched by s1's invalidation
    await transform(inputFor("s2"), output(["base"]));
    expect(loads).toBe(3);
  });

  it("dropSession removes an entry; correctness never depends on it", async () => {
    let loads = 0;
    const { transform, dropSession } = createAutoContextTransform("/w", {
      load: async () => {
        loads += 1;
        return okResult(PAYLOAD);
      },
    });
    await transform(inputFor("s1"), output(["base"]));
    dropSession("s1");
    await transform(inputFor("s1"), output(["base"]));
    expect(loads).toBe(2); // reloaded only because it was dropped
    dropSession("never-existed"); // no throw
    expect(typeof dropSession).toBe("function");
  });
});

/* ------------------------- integration: the plugin ------------------------- */

interface AnyTool {
  description: string;
  args: Record<string, unknown>;
  execute: (
    args: unknown,
    context: { sessionID: string; directory: string },
  ) => Promise<{ title?: string; output: string; metadata?: Record<string, unknown> }>;
}

/** The SDK's transform input requires a full Model; tests drive it loosely. */
const looseTransform = (hooks: Hooks) =>
  hooks["experimental.chat.system.transform"]! as unknown as (
    input: { sessionID?: string; model?: unknown },
    output: { system: string[] },
  ) => Promise<void>;

describe("opencode plugin / auto-context integration", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "engram-octxhome-"));
    fs.mkdirSync(path.join(home, ".engram", "engrams"), { recursive: true });
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const loadHooks = async (directory = tmp) => {
    const hooks = (await engramPlugin({
      directory,
      worktree: directory,
    } as unknown as Parameters<typeof engramPlugin>[0])) as Hooks & {
      tool: Record<string, AnyTool>;
    };
    return { hooks, transform: looseTransform(hooks) };
  };

  it("registers the transform alongside the tool map", async () => {
    const { hooks } = await loadHooks();
    expect(Object.keys(hooks.tool)).toEqual([
      "engram_context",
      "engram_search",
      "engram_show",
      "engram_add",
    ]);
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
  });

  it("uses the PluginInput.directory for the digest, not process.cwd()", async () => {
    seedEntry(tmp, "0001", "Plugin directory entry");
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "engram-octx-other-"));
    process.chdir(elsewhere);
    try {
      const { transform } = await loadHooks(tmp);
      const out = output(["base"]);
      await transform(inputFor("s1"), out);
      expect(out.system[0]).toContain("Plugin directory entry");
      expect(out.system[0]).toContain(tmp);
      expect(countOf(out.system, MARKER)).toBe(1);
    } finally {
      process.chdir(tmp);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("tools still resolve their per-call context.directory (worktree/subagent mismatch)", async () => {
    seedEntry(tmp, "0001", "Main project entry");
    const subagent = mkProject();
    seedEntry(subagent, "0001", "Subagent project entry");
    try {
      const { hooks, transform } = await loadHooks(tmp);
      // The transform serves the init directory's digest...
      const out = output(["base"]);
      await transform(inputFor("s1"), out);
      expect(out.system[0]).toContain("Main project entry");
      // ...while a tool invoked from a subagent/worktree context reads that
      // context's directory instead.
      const digest = await hooks.tool.engram_context.execute(
        {},
        {
          sessionID: "s1",
          directory: subagent,
        },
      );
      expect(digest.output).toContain("Subagent project entry");
      expect(digest.output).not.toContain("Main project entry");
    } finally {
      fs.rmSync(subagent, { recursive: true, force: true });
    }
  });

  it("repeated model requests get exactly one block each without rereading the store", async () => {
    seedEntry(tmp, "0001", "Stable entry");
    const { transform } = await loadHooks(tmp);
    for (let i = 0; i < 3; i++) {
      const out = output(["base"]);
      await transform(inputFor("s1"), out);
      expect(countOf(out.system, MARKER)).toBe(1);
      expect(out.system[0]).toContain("Stable entry");
    }
  });

  it("a successful engram_add invalidates only that session; failed adds do not", async () => {
    seedEntry(tmp, "0001", "Stable entry");
    const { hooks, transform } = await loadHooks(tmp);
    const out1 = output(["base"]);
    await transform(inputFor("s1"), out1);
    expect(out1.system[0]).not.toContain("Fresh from add");
    // Prime s2's cache before any add so its stale digest is observable.
    await transform(inputFor("s2"), output(["base"]));

    // failed add: no invalidation (out-of-band write stays invisible)
    const failed = await hooks.tool.engram_add.execute(
      { title: "   ", body: "b" },
      { sessionID: "s1", directory: tmp },
    );
    expect(failed.metadata?.isError).toBe(true);
    seedEntry(tmp, "0002", "Out of band entry");
    const out2 = output(["base"]);
    await transform(inputFor("s1"), out2);
    expect(out2.system[0]).not.toContain("Out of band entry");

    // successful add: that session reloads and sees it
    const added = await hooks.tool.engram_add.execute(
      { title: "Fresh from add", body: "b" },
      { sessionID: "s1", directory: tmp },
    );
    expect(added.metadata?.isError).toBe(false);
    const out3 = output(["base"]);
    await transform(inputFor("s1"), out3);
    expect(out3.system[0]).toContain("Fresh from add");
    expect(countOf(out3.system, MARKER)).toBe(1);

    // other sessions keep their cached digest
    const outOther = output(["base"]);
    await transform(inputFor("s2"), outOther);
    expect(outOther.system[0]).not.toContain("Fresh from add");
  });

  it("the event hook drops cache entries on session.deleted", async () => {
    seedEntry(tmp, "0001", "Stable entry");
    const { hooks, transform } = await loadHooks(tmp);
    const event = hooks.event!;

    await transform(inputFor("s1"), output(["base"]));
    await transform(inputFor("s2"), output(["base"]));

    // Fake event input: a real Event carries the full Session; only the id
    // matters here.
    const fakeEvent = {
      type: "session.deleted",
      properties: { info: { id: "s1" } },
    } as unknown as Parameters<typeof event>[0]["event"];
    await event({ event: fakeEvent });

    // s1 reloads (fresh digest includes a new out-of-band entry); s2 does not.
    seedEntry(tmp, "0009", "After deletion entry");
    const out1 = output(["base"]);
    await transform(inputFor("s1"), out1);
    expect(out1.system[0]).toContain("After deletion entry");
    const out2 = output(["base"]);
    await transform(inputFor("s2"), out2);
    expect(out2.system[0]).not.toContain("After deletion entry");
  });

  it("autoContext=off leaves the system prompt untouched end-to-end", async () => {
    seedEntry(tmp, "0001", "Stable entry");
    fs.writeFileSync(
      path.join(home, ".engram", "config.json"),
      JSON.stringify({ version: 1, autoContext: "off" }),
    );
    const { transform } = await loadHooks(tmp);
    const out = output(["base"]);
    await transform(inputFor("s1"), out);
    expect(out.system).toEqual(["base"]);
  });

  it("an empty store leaves the system prompt untouched", async () => {
    const { transform } = await loadHooks(tmp);
    const out = output(["base"]);
    await transform(inputFor("s1"), out);
    expect(out.system).toEqual(["base"]);
  });
});
