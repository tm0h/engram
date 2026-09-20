/**
 * `engram hook` fail-open contract tests (ENG-58, leader ruling A2):
 * valid invocations always exit 0, injected stdout is capped at 8 KiB with a
 * truncation marker, context loading is wall-clock bounded, and stderr stays
 * suppressed unless ENGRAM_DEBUG is set. Failure paths inject a slow or
 * failing FileSystem under the real store; nothing shells out and no live
 * host is involved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { systemError } from "effect/PlatformError";
import { NodeServices } from "@effect/platform-node";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EngramStoreLive,
  MainLive,
  projectConfigPath,
  projectEngramsDir,
  slugify,
  stringifyFrontmatter,
} from "@engram/core";
import { TRUNCATION_MARKER } from "@engram/harnesses/installer";
import { HOOK_HOSTS, HOOK_EVENTS, capToBytes, hookCommand } from "../src/commands/hook.js";

/* ------------------------------ helpers ------------------------------ */

const fm = (id: string, title: string): string =>
  stringifyFrontmatter("Body\n", {
    id,
    title,
    type: "note",
    tags: [],
    scope: "project",
    created: "2025-08-15T10:00:00.000Z",
    updated: "2025-08-15T11:00:00.000Z",
  });

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-hook-proj-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

const mkHome = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-hook-home-"));
  fs.mkdirSync(path.join(tmp, ".engram", "engrams"), { recursive: true });
  return tmp;
};

const seed = (proj: string, id: string, title: string): string => {
  const file = path.join(projectEngramsDir(proj), `${id}-${slugify(title).slice(0, 80)}.md`);
  fs.writeFileSync(file, fm(id, title));
  return file;
};

/** FileSystem whose readFileString sleeps before delegating (timeout tests). */
const slowReadLive = (ms: number) => {
  const SlowFs = Layer.effect(
    FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem;
      return {
        ...real,
        readFileString: (p: string) =>
          Effect.sleep(ms).pipe(
            Effect.andThen(real.readFileString(p)),
            Effect.provide(NodeServices.layer),
          ),
      } satisfies FileSystem;
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    EngramStoreLive.pipe(Layer.provide(SlowFs), Layer.provide(NodeServices.layer)),
    NodeServices.layer,
  );
};

/** FileSystem whose readDirectory always fails (error fail-open tests). */
const failingReadLive = () => {
  const FailingFs = Layer.effect(
    FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem;
      return {
        ...real,
        readDirectory: () =>
          Effect.fail(
            systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readDirectory",
              pathOrDescriptor: "blocked",
              syscall: "scandir",
            }),
          ),
      } satisfies FileSystem;
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    EngramStoreLive.pipe(Layer.provide(FailingFs), Layer.provide(NodeServices.layer)),
    NodeServices.layer,
  );
};

describe("engram hook (fail-open contract, A2)", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let origDebug: string | undefined;
  let tmp = "";
  let home = "";
  let outChunks: string[] = [];
  let errChunks: string[] = [];
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    origDebug = process.env.ENGRAM_DEBUG;
    delete process.env.ENGRAM_DEBUG;
    tmp = mkProject();
    home = mkHome();
    process.chdir(tmp);
    process.env.HOME = home;
    outChunks = [];
    errChunks = [];
    spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        outChunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write),
      vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
        errChunks.push(String(chunk));
        return true;
      }) as typeof process.stderr.write),
    ];
  });

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDebug === undefined) delete process.env.ENGRAM_DEBUG;
    else process.env.ENGRAM_DEBUG = origDebug;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const stdout = (): string => outChunks.join("");
  const stderr = (): string => errChunks.join("");

  const runHook = (opts: Parameters<typeof hookCommand>[0]): Promise<void> =>
    // index.ts performs the same cast once MainLive supplies the services;
    // see run() in src/index.ts.
    Effect.runPromise(
      Effect.provide(hookCommand(opts), MainLive) as unknown as Effect.Effect<void, Error>,
    );

  it("accepts exactly the documented hosts and events (A6)", () => {
    expect([...HOOK_HOSTS]).toEqual(["claude-code", "codex"]);
    expect([...HOOK_EVENTS]).toEqual(["startup", "resume", "compact"]);
  });

  it("rejects unknown hosts and events as usage errors", async () => {
    await expect(runHook({ host: "generic", event: "startup" })).rejects.toThrow(/usage:/);
    await expect(runHook({ host: "claude-code", event: "precompact" })).rejects.toThrow(/usage:/);
  });

  it("prints the digest for a seeded project and exits cleanly", async () => {
    seed(tmp, "0001", "Hook digest note");
    await runHook({ host: "claude-code", event: "startup" });
    expect(stdout()).toContain("Hook digest note");
    expect(stderr()).toBe("");
  });

  it("prints the placeholder for an empty store", async () => {
    await runHook({ host: "codex", event: "startup" });
    expect(stdout()).toContain("(no engrams available)");
    expect(stderr()).toBe("");
  });

  it("caps injected stdout at 8 KiB with the truncation marker (A2)", async () => {
    for (let i = 1; i <= 60; i += 1) {
      seed(tmp, String(i).padStart(4, "0"), `Hookcap ${i} ${"x".repeat(220)}`);
    }
    await runHook({ host: "claude-code", event: "resume" });
    expect(Buffer.byteLength(stdout(), "utf8")).toBeLessThanOrEqual(8192);
    expect(stdout()).toContain(TRUNCATION_MARKER);
  });

  it("fails open with empty output when the store cannot be listed; stderr silent without debug", async () => {
    seed(tmp, "0001", "Unreachable note");
    await Effect.runPromise(
      Effect.provide(hookCommand({ host: "claude-code", event: "startup" }), failingReadLive()),
    );
    expect(stdout()).toBe("");
    expect(stderr()).toBe("");
  });

  it("suppresses stderr unless ENGRAM_DEBUG is set, then explains the failure (A2)", async () => {
    seed(tmp, "0001", "Unreachable note");
    process.env.ENGRAM_DEBUG = "1";
    await Effect.runPromise(
      Effect.provide(hookCommand({ host: "claude-code", event: "startup" }), failingReadLive()),
    );
    expect(stdout()).toBe("");
    expect(stderr()).toContain("engram hook: context load failed:");
  });

  it("bounds context loading by the wall clock and reports timeouts in debug (A2)", async () => {
    seed(tmp, "0001", "Slow store note");
    await Effect.runPromise(
      Effect.provide(
        hookCommand({ host: "codex", event: "compact", timeoutMs: 1 }),
        slowReadLive(250),
      ),
    );
    expect(stdout()).toBe("");
    expect(stderr()).toBe("");

    process.env.ENGRAM_DEBUG = "1";
    await Effect.runPromise(
      Effect.provide(
        hookCommand({ host: "codex", event: "compact", timeoutMs: 1 }),
        slowReadLive(250),
      ),
    );
    expect(stdout()).toBe("");
    expect(stderr()).toContain("engram hook: context load timed out after 1ms");
  });
});

describe("capToBytes (byte-accurate 8 KiB cap)", () => {
  it("leaves text at or under the cap untouched", () => {
    const text = "a".repeat(100);
    expect(capToBytes(text, 8192, "\n[cut]")).toBe(text);
    const exact = "a".repeat(8192);
    expect(capToBytes(exact, 8192, "\n[cut]")).toBe(exact);
  });

  it("cuts at the cap and appends the marker, total within the cap", () => {
    const text = "b".repeat(20_000);
    const capped = capToBytes(text, 8192, "\n[cut]");
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(8192);
    expect(capped.endsWith("\n[cut]")).toBe(true);
  });

  it("never splits a multi-byte codepoint", () => {
    const text = "a".repeat(8190) + "\u{1F642}\u{1F642}";
    const capped = capToBytes(text, 8192, "\n[cut]");
    expect(capped).not.toContain("\uFFFD");
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(8192);
  });
});
