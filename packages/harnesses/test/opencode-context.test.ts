import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import {
  createContextTransform,
  MAX_SESSIONS,
  type ActiveRequest,
} from "../src/opencode/context-transform.js";
import engramPlugin from "../src/opencode/index.js";

const MARKER = "<engram-memory>";
const block = (text: string) => `${MARKER}\n${text}\n</engram-memory>`;
const base = () => ({ system: ["base", "other plugin"] });
const occurrences = (system: string[]) => system.join("\n").split(MARKER).length - 1;
const input = (sessionID?: string) => ({
  sessionID,
  model: { id: "model", providerID: "provider" } as NonNullable<
    Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[0]["model"]
  >,
});

const request = {
  directory: "/workspace/active",
  messageID: "msg-1",
  prompt: "bluebird",
} satisfies ActiveRequest;

describe("OpenCode system transform cache", () => {
  it("shares a load for concurrent requests and leaves prior entries in place", async () => {
    const load = vi.fn(async () => block("bluebird advice"));
    const { transform } = createContextTransform(async () => request, { load });
    const first = base();
    const second = base();
    const original = first.system;
    await Promise.all([transform(input("s1"), first), transform(input("s1"), second)]);
    expect(load).toHaveBeenCalledExactlyOnceWith(request);
    expect(first.system).toBe(original);
    expect(first.system).toEqual([...base().system, block("bluebird advice")]);
    expect(second.system).toEqual(first.system);
  });

  it("replaces its block when a reused array changes topic or directory, and clears it on abstention", async () => {
    let active = request;
    const load = vi.fn(async ({ prompt, directory }: ActiveRequest) =>
      prompt ? block(`${prompt}: ${directory}`) : "",
    );
    const { transform } = createContextTransform(async () => active, { load });
    const out = base();
    await transform(input("s1"), out);
    active = { ...active, prompt: "redfinch" };
    await transform(input("s1"), out);
    expect(out.system).toEqual([...base().system, block("redfinch: /workspace/active")]);
    active = { ...active, directory: "/workspace/worktree" };
    out.system.splice(1, 0, "another plugin");
    const priorEntries = ["base", "another plugin", "other plugin"];
    await transform(input("s1"), out);
    expect(out.system).toEqual([...priorEntries, block("redfinch: /workspace/worktree")]);
    active = { ...active, prompt: "" };
    await transform(input("s1"), out);
    expect(out.system).toEqual(priorEntries);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("leaves foreign markers intact and skips missing session IDs or unsupported output", async () => {
    const resolve = vi.fn(async () => request);
    const { transform } = createContextTransform(resolve);
    const foreign = { system: [`prior plugin\n${block("foreign block")}`] };
    const frozen = { system: Object.freeze(["base"]) as string[] };
    await transform(input("s1"), foreign);
    await transform(input(), base());
    await transform(input("s1"), frozen);
    await transform(input("s1"), {} as { system: string[] });
    expect(resolve).not.toHaveBeenCalled();
    expect(foreign.system).toEqual([`prior plugin\n${block("foreign block")}`]);
  });

  it("fails open when the resolver or loader throws or rejects", async () => {
    const rejected = () => Promise.reject(new Error("async failure"));
    const throws = () => {
      throw new Error("sync failure");
    };
    for (const fail of [rejected, throws]) {
      const out = base();
      await createContextTransform(fail).transform(input("s1"), out);
      await createContextTransform(async () => request, { load: fail }).transform(input("s1"), out);
      expect(out).toEqual(base());
    }
  });

  it("evicts the oldest session and removes the deleted session's cache", async () => {
    const load = vi.fn(async () => block("advice"));
    const { transform, dropSession } = createContextTransform(async () => request, { load });
    for (let i = 0; i <= MAX_SESSIONS; i++) await transform(input(`s${i}`), base());
    expect(load).toHaveBeenCalledTimes(MAX_SESSIONS + 1);
    await transform(input(`s${MAX_SESSIONS}`), base());
    expect(load).toHaveBeenCalledTimes(MAX_SESSIONS + 1);
    dropSession(`s${MAX_SESSIONS}`);
    await transform(input(`s${MAX_SESSIONS}`), base());
    await transform(input("s0"), base());
    expect(load).toHaveBeenCalledTimes(MAX_SESSIONS + 3);
  });

  it("drops pre-write loads even when they settle after a refreshed request", async () => {
    let release!: (text: string) => void;
    const load = vi
      .fn(async () => block("fresh"))
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      );
    const { transform, invalidate } = createContextTransform(async () => request, { load });
    const old = base();
    const pending = transform(input("s1"), old);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    invalidate();
    const current = base();
    await transform(input("s1"), current);
    release(block("stale"));
    await pending;
    expect(old).toEqual(base());
    expect(current.system).toEqual([...base().system, block("fresh")]);
    const next = base();
    await transform(input("s1"), next);
    expect(next).toEqual(current);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not let overlapping requests clobber newer output on the same array", async () => {
    let release!: (text: string) => void;
    let active = request;
    const load = vi
      .fn(async () => block("fresh"))
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      );
    const { transform } = createContextTransform(async () => active, { load });
    const out = base();
    const pending = transform(input("s1"), out);
    await Promise.resolve();
    active = { ...request, messageID: "msg-2" };
    await transform(input("s1"), out);
    release(block("stale"));
    await pending;
    expect(out.system).toEqual([...base().system, block("fresh")]);
  });
});

type Turn = {
  directory: string;
  text: string;
  parent?: string;
  summary?: boolean;
  completed?: number;
  modelID?: string;
};
function fakeClient(turns: Map<string, Turn>) {
  return {
    session: {
      messages: vi.fn(
        async ({ path: { id }, query }: { path: { id: string }; query: { limit: number } }) => {
          expect(query.limit).toBe(1);
          const turn = turns.get(id);
          return {
            data: turn
              ? [
                  {
                    info: {
                      id: "assistant",
                      role: "assistant",
                      sessionID: id,
                      parentID: turn.parent ?? "user",
                      path: { cwd: turn.directory },
                      modelID: turn.modelID ?? "model",
                      providerID: "provider",
                      time: { completed: turn.completed },
                      summary: turn.summary,
                    },
                    parts: [],
                  },
                ]
              : [],
          };
        },
      ),
      message: vi.fn(
        async ({ path: { id, messageID } }: { path: { id: string; messageID: string } }) => {
          const turn = turns.get(id)!;
          return {
            data: {
              info: { role: "user", sessionID: id, id: messageID },
              parts: [
                { type: "text", text: turn.text, sessionID: id, messageID },
                { type: "text", text: "distractor", synthetic: true, sessionID: id, messageID },
              ],
            },
          };
        },
      ),
    },
  };
}

describe("OpenCode plugin contextual delivery", () => {
  let root: string;
  let workspace: string;
  let worktree: string;
  let turns: Map<string, Turn>;

  const project = (name: string) => {
    const directory = path.join(root, name);
    fs.mkdirSync(projectEngramsDir(directory), { recursive: true });
    fs.writeFileSync(
      projectConfigPath(directory),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
    );
    return directory;
  };

  const seed = (directory: string, id: string, title: string, body: string, pinned = false) => {
    const filename = path.join(projectEngramsDir(directory), `${id}-${title.toLowerCase()}.md`);
    fs.writeFileSync(
      filename,
      [
        "---",
        `id: "${id}"`,
        `title: ${title}`,
        "type: note",
        `pinned: ${pinned}`,
        "tags: []",
        "scope: project",
        "created: 2026-08-16T10:00:00.000Z",
        "updated: 2026-08-16T10:00:00.000Z",
        "---",
        body,
      ].join("\n"),
    );
  };

  const setup = async (client?: ReturnType<typeof fakeClient>) => {
    const hooks = await engramPlugin({ directory: workspace, client } as unknown as PluginInput);
    const render = async (id = "s1", out = base()) => {
      await hooks["experimental.chat.system.transform"]!(input(id), out);
      return out.system;
    };
    const write = (tool: "engram_add" | "engram_edit", args: unknown, directory = worktree) =>
      hooks.tool![tool].execute(args as never, { sessionID: "s1", directory } as never);
    return { hooks, render, write };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "engram-octx-"));
    workspace = project("init");
    worktree = project("worktree");
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".engram"), { recursive: true });
    vi.stubEnv("HOME", home);
    turns = new Map([
      ["s1", { directory: worktree, text: "bluebird" }],
      ["s2", { directory: worktree, text: "bluebird" }],
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses the actual turn directory and user text on each call, with bootstrap as fallback", async () => {
    seed(workspace, "0001", "Bluebird", "bluebird wrong-workspace");
    seed(worktree, "0001", "Bluebird", "bluebird rollout advice", true);
    seed(worktree, "0002", "Redfinch", "redfinch alternate advice");
    seed(worktree, "0003", "Distractor", "synthetic advice");
    const client = fakeClient(turns);
    const { render } = await setup(client);
    const out = base();
    const first = await render("s1", out);
    expect(first.slice(0, 2)).toEqual(base().system);
    expect(first.join("\n")).toContain("bluebird rollout advice");
    expect(first.join("\n")).not.toMatch(/alternate advice|wrong-workspace|synthetic advice/);
    expect(occurrences(first)).toBe(1);
    turns.set("s1", { directory: worktree, text: "redfinch", parent: "second" });
    expect((await render("s1", out)).join("\n")).toContain("redfinch alternate advice");
    expect(out.system.join("\n")).not.toContain("bluebird rollout advice");
    expect(occurrences(out.system)).toBe(1);
    expect(client.session.message).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: { id: "s1", messageID: "second" },
      }),
    );
    turns.set("s1", { directory: worktree, text: "unrelated" });
    const fallback = (await render("s1", out)).join("\n");
    expect(fallback).toContain("Bluebird");
    expect(fallback).not.toMatch(/rollout advice|alternate advice/);
    expect(occurrences(out.system)).toBe(1);
    expect((await render("s2")).join("\n")).toContain("bluebird rollout advice");
  });

  it("refreshes shared project recall after approved adds and edits but keeps cached results on errors", async () => {
    seed(worktree, "0001", "Bluebird", "bluebird initial advice");
    const { render, write } = await setup(fakeClient(turns));
    await render();
    await render("s2");
    seed(worktree, "0002", "Bluebird2", "bluebird out-of-band advice");
    for (const [tool, args] of [
      ["engram_add", { title: " ", body: "invalid" }],
      ["engram_edit", { id: "0001", title: " " }],
      ["engram_add", { title: "Bluebird blocked", body: "AKIAIOSFODNN7EXAMPLE" }],
    ] as const) {
      const failed = await write(tool, args);
      expect(failed).toMatchObject({ metadata: { isError: true } });
      if ("body" in args && args.body === "AKIAIOSFODNN7EXAMPLE") {
        expect(failed).toMatchObject({ metadata: { reason: "secret_scan_blocked" } });
      }
      expect((await render()).join("\n")).not.toContain("out-of-band advice");
    }
    expect(
      await write("engram_add", { title: "Bluebird new", body: "bluebird new advice" }),
    ).toMatchObject({ metadata: { isError: false } });
    for (const id of ["s1", "s2"]) {
      expect((await render(id)).join("\n")).toContain("bluebird new advice");
    }
    expect(
      await write("engram_edit", { id: "0001", body: "bluebird corrected advice" }),
    ).toMatchObject({ metadata: { isError: false } });
    expect((await render("s2")).join("\n")).toContain("bluebird corrected advice");
    expect((await render("s2")).join("\n")).not.toContain("bluebird initial advice");
  });

  it("fails open with unavailable turns, unsupported SDK, oversized prompts, opt-out, and empty stores", async () => {
    const client = fakeClient(turns);
    const { render } = await setup(client);
    expect(await render()).toEqual(base().system); // Empty store, valid turn.
    seed(worktree, "0001", "Bluebird", "bluebird advice", true);
    expect(await (await setup()).render()).toEqual(base().system);
    for (const turn of [
      { directory: "relative", text: "bluebird" },
      { directory: worktree, text: "bluebird", summary: true },
      { directory: worktree, text: "bluebird", completed: 1 },
      { directory: worktree, text: "bluebird", modelID: "alternate-model" },
      { directory: worktree, text: "x".repeat(4097) },
    ]) {
      turns.set("s1", turn);
      expect(await render()).toEqual(base().system);
    }
    expect(await render("missing")).toEqual(base().system);
    client.session.messages.mockImplementationOnce(() => new Promise(() => {}));
    expect(await render()).toEqual(base().system);
    turns.set("s1", { directory: worktree, text: "bluebird" });
    fs.writeFileSync(
      path.join(root, "home", ".engram", "config.json"),
      JSON.stringify({ version: 1, autoContext: "off" }),
    );
    expect(await (await setup(client)).render()).toEqual(base().system);
  });
});
