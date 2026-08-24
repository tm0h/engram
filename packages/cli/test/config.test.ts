/**
 * `engram config` command tests for the auto-context global keys
 * (autoContext, autoContextScope, autoContextLimit): list/get/set round
 * trips plus validation of rejected values. Runs the real command Effect
 * over MainLive with stdout captured; nothing here shells out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { Effect } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MainLive, projectConfigPath, projectEngramsDir } from "@engram/core";
import { EngramStore, ConfigRepo } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { configCommand } from "../src/commands/configCmd.js";

/* ------------------------------ helpers ------------------------------ */

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-cfg-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

const mkHome = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-home-"));
  fs.mkdirSync(path.join(tmp, ".engram", "engrams"), { recursive: true });
  return tmp;
};

const globalConfigFile = (home: string): string => path.join(home, ".engram", "config.json");

const readGlobal = (home: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(globalConfigFile(home), "utf8"));

describe("engram config / auto-context keys", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  let lines: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = mkHome();
    process.chdir(tmp);
    process.env.HOME = home;
    lines = [];
    spy = vi.spyOn(console, "log").mockImplementation(((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
      return undefined;
    }) as typeof console.log);
  });
  afterEach(() => {
    spy.mockRestore();
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = <A>(
    eff: Effect.Effect<A, unknown, EngramStore | ConfigRepo | FileSystem | Path>,
  ): Promise<A> => Effect.runPromise(Effect.provide(eff, MainLive));
  const runFail = (
    eff: Effect.Effect<unknown, unknown, EngramStore | ConfigRepo | FileSystem | Path>,
  ): Promise<{ message: string }> =>
    Effect.runPromise(Effect.provide(Effect.flip(eff), MainLive)) as Promise<{
      message: string;
    }>;
  const output = (): string => lines.join("");

  /* ------------------------------ list ------------------------------ */

  it("list shows the three keys with their defaults", async () => {
    await run(configCommand("list"));
    expect(output()).toMatch(/autoContext:\s+on/);
    expect(output()).toMatch(/autoContextScope:\s+project/);
    expect(output()).toMatch(/autoContextLimit:\s+25/);
  });

  /* ------------------------------ get ------------------------------- */

  it("get returns defaults for unset keys", async () => {
    await run(configCommand("get", "autoContext"));
    expect(output()).toBe("on");
  });

  it("get returns a configured scope and limit", async () => {
    fs.writeFileSync(
      globalConfigFile(home),
      JSON.stringify({
        version: 1,
        autoContext: "off",
        autoContextScope: "both",
        autoContextLimit: 7,
      }),
    );
    await run(configCommand("get", "autoContextScope"));
    expect(output()).toBe("both");
    lines = [];
    await run(configCommand("get", "autoContextLimit"));
    expect(output()).toBe("7");
    lines = [];
    await run(configCommand("get", "autoContext"));
    expect(output()).toBe("off");
  });

  it("get rejects unknown auto-context key spellings", async () => {
    const error = await runFail(configCommand("get", "autocontext"));
    expect(error.message).toContain("Unknown key");
  });

  /* ------------------------------ set ------------------------------- */

  it("set autoContext off persists to the global config file", async () => {
    await run(configCommand("set", "autoContext", "off"));
    expect(readGlobal(home)).toMatchObject({ autoContext: "off" });
    expect(output()).toContain("global.autoContext");
    lines = [];
    await run(configCommand("get", "autoContext"));
    expect(output()).toBe("off");
  });

  it("set autoContext accepts on", async () => {
    await run(configCommand("set", "autoContext", "on"));
    expect(readGlobal(home)).toMatchObject({ autoContext: "on" });
  });

  it("set autoContext rejects non-toggle values", async () => {
    const error = await runFail(configCommand("set", "autoContext", "maybe"));
    expect(error.message).toMatch(/on or off/);
  });

  it("set autoContextScope persists each valid scope and rejects others", async () => {
    for (const scope of ["project", "personal", "both"] as const) {
      await run(configCommand("set", "autoContextScope", scope));
      expect(readGlobal(home)).toMatchObject({ autoContextScope: scope });
      lines = [];
    }
    const error = await runFail(configCommand("set", "autoContextScope", "everywhere"));
    expect(error.message).toMatch(/project.*personal.*both|both.*personal.*project/);
  });

  it("set autoContextLimit persists 1..100 integers and rejects the rest", async () => {
    await run(configCommand("set", "autoContextLimit", "50"));
    expect(readGlobal(home)).toMatchObject({ autoContextLimit: 50 });
    await run(configCommand("set", "autoContextLimit", "1"));
    expect(readGlobal(home)).toMatchObject({ autoContextLimit: 1 });
    await run(configCommand("set", "autoContextLimit", "100"));
    expect(readGlobal(home)).toMatchObject({ autoContextLimit: 100 });

    for (const bad of ["0", "101", "2.5", "abc", "-3"]) {
      const error = await runFail(configCommand("set", "autoContextLimit", bad));
      expect(error.message).toMatch(/autoContextLimit/);
    }
  });

  it("set unknown key is rejected", async () => {
    const error = await runFail(configCommand("set", "autoContextFoo", "on"));
    expect(error.message).toContain("Unknown key");
  });
});
