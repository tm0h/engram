import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import engramExtension from "../src/pi/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode = "tui") {
  const cwd = mkdtempSync(join(tmpdir(), "engram-pi-capture-"));
  roots.push(cwd);
  mkdirSync(projectEngramsDir(cwd), { recursive: true });
  writeFileSync(
    projectConfigPath(cwd),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  const queue = join(cwd, ".engram/pending");
  const notices: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  engramExtension({
    on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(name, callback),
    registerTool: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd,
    mode,
    hasUI: true,
    sessionManager: { getSessionId: () => "fixture-session" },
    ui: { notify: (text: string) => notices.push(text) },
  };
  const emit = (type: string, data = {}) => {
    expect(handlers.has(type)).toBe(true);
    return handlers.get(type)!({ type, ...data }, ctx);
  };
  const message = (text: string, role = "user") =>
    emit("message_end", {
      message: { role, timestamp: 1700000000000, content: [{ type: "text", text }] },
    });
  const input = async (text: string, source = "interactive", delivered = text) => {
    await emit("input", { text, source });
    await message(delivered);
  };
  const files = () =>
    existsSync(queue) ? readdirSync(queue).filter((file) => file.endsWith(".json")) : [];
  return { cwd, queue, notices, emit, input, message, files };
}

describe("Pi review-only capture", () => {
  it("stages only delivered interactive input and keeps replayed events silent", async () => {
    const { cwd, queue, notices, emit, input, message, files } = fixture();
    const evidence = "Remember that Violet uses signed fixture bundles.";
    await input(evidence);
    await message("Remember that violet fixtures are public.", "custom");
    await message("Remember that violet tools are public.", "toolResult");
    await message("Remember that violet scaffolds are public.");
    await input("Remember that violet bundles are public.", "extension");
    await input(
      "Remember that violet templates are public.",
      "interactive",
      evidence + "\n\nScaffolding.",
    );
    await emit("session_before_compact", { signal: new AbortController().signal });
    const [file] = files();
    expect(files()).toEqual([file]);
    const candidate = JSON.parse(readFileSync(join(queue, file), "utf8"));
    expect(candidate).toMatchObject({
      provenanceClass: "conversation",
      sourceExcerpt: evidence,
      captureSource: {
        harness: "pi",
        sessionKind: "tui",
        sessionId: "fixture-session",
        event: "session_before_compact",
        evidence: [{ messageId: "message-1700000000000-1", origin: "user" }],
      },
      proposed: { body: "Violet uses signed fixture bundles." },
    });
    expect(notices).toEqual([
      "Engram staged 1 candidate for review. Run engram pending list --scope all.",
    ]);
    rmSync(join(queue, file));
    await message(evidence);
    await emit("session_shutdown", { reason: "quit" });
    expect(files()).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(readdirSync(projectEngramsDir(cwd))).toEqual([]);
  });

  it("bounds a shutdown flush when the pending queue is busy", async () => {
    const { queue, emit, input, files, notices } = fixture();
    const lock = join(queue, ".admission.lock");
    mkdirSync(lock, { recursive: true });
    await input("Remember that Violet uses signed fixture bundles.");
    const started = performance.now();
    await emit("session_shutdown", { reason: "quit" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(files()).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("excludes non-interactive sessions and fails open on unavailable storage", async () => {
    const subagent = fixture("json");
    await subagent.input("Remember that Violet uses signed fixture bundles.");
    await subagent.emit("session_shutdown", { reason: "quit" });
    expect(subagent.files()).toEqual([]);
    expect(subagent.notices).toEqual([]);

    const broken = fixture();
    rmSync(projectConfigPath(broken.cwd), { force: true });
    rmSync(join(broken.cwd, ".engram"), { recursive: true });
    await broken.input("Remember that Violet uses signed fixture bundles.");
    await broken.emit("session_shutdown", { reason: "quit" });
    expect(broken.files()).toEqual([]);
    expect(broken.notices).toEqual([]);
  });
});
