import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigRepo, ConfigRepoLive } from "../src/config.js";
import { projectConfigPath } from "../src/paths.js";

const ConfigLayer = ConfigRepoLive.pipe(Layer.provide(NodeServices.layer));

describe("ConfigRepo / project", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("returns defaults when no config exists", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const loaded = yield* cfg.loadProject(tmp);
      expect(loaded.tracked).toBe(true);
      expect(loaded.defaultType).toBe("note");
    }).pipe(Effect.provide(ConfigLayer)),
  );

  it.live("saves and reloads config", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      yield* cfg.saveProject(tmp, {
        version: 1,
        tracked: false,
        defaultType: "decision",
      });
      // file actually written to disk
      expect(fs.existsSync(projectConfigPath(tmp))).toBe(true);
      const loaded = yield* cfg.loadProject(tmp);
      expect(loaded.tracked).toBe(false);
      expect(loaded.defaultType).toBe("decision");
    }).pipe(Effect.provide(ConfigLayer)),
  );
});

describe("ConfigRepo / global", () => {
  let origHome: string | undefined;
  let tmp = "";
  beforeEach(() => {
    origHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-gcfg-"));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("saves and reloads global config", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const def = yield* cfg.loadGlobal();
      expect(def.author).toBeUndefined();
      yield* cfg.saveGlobal({ version: 1, author: "alice", editor: "vim" });
      const loaded = yield* cfg.loadGlobal();
      expect(loaded.author).toBe("alice");
      expect(loaded.editor).toBe("vim");
    }).pipe(Effect.provide(ConfigLayer)),
  );
});

describe("ConfigRepo / global auto-context keys", () => {
  let origHome: string | undefined;
  let tmp = "";
  beforeEach(() => {
    origHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-acfg-"));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const globalPath = () => path.join(tmp, ".engram", "config.json");
  const writeGlobal = (data: unknown) => {
    fs.mkdirSync(path.dirname(globalPath()), { recursive: true });
    fs.writeFileSync(globalPath(), typeof data === "string" ? data : JSON.stringify(data));
  };

  it.live("defaults to on/project/25 when no config file exists", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const loaded = yield* cfg.loadGlobal();
      expect(loaded.autoContext).toBe("on");
      expect(loaded.autoContextScope).toBe("project");
      expect(loaded.autoContextLimit).toBe(25);
    }).pipe(Effect.provide(ConfigLayer)),
  );

  it.live("legacy v1 config without the new keys loads with the new defaults", () => {
    writeGlobal({ version: 1, author: "alice", editor: "vim" });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const loaded = yield* cfg.loadGlobal();
      expect(loaded.author).toBe("alice");
      expect(loaded.editor).toBe("vim");
      expect(loaded.autoContext).toBe("on");
      expect(loaded.autoContextScope).toBe("project");
      expect(loaded.autoContextLimit).toBe(25);
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("saves and reloads the new keys", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      yield* cfg.saveGlobal({
        version: 1,
        autoContext: "off",
        autoContextScope: "both",
        autoContextLimit: 40,
      });
      const loaded = yield* cfg.loadGlobal();
      expect(loaded.autoContext).toBe("off");
      expect(loaded.autoContextScope).toBe("both");
      expect(loaded.autoContextLimit).toBe(40);
    }).pipe(Effect.provide(ConfigLayer)),
  );

  it.live("rejects invalid values for the new keys", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const invalid: Array<Record<string, unknown>> = [
        { version: 1, autoContext: "maybe" },
        { version: 1, autoContext: true },
        { version: 1, autoContextScope: "everywhere" },
        { version: 1, autoContextLimit: 0 },
        { version: 1, autoContextLimit: 101 },
        { version: 1, autoContextLimit: 2.5 },
        { version: 1, autoContextLimit: "25" },
      ];
      for (const data of invalid) {
        writeGlobal(data);
        const error = yield* Effect.flip(cfg.loadGlobal());
        expect(error._tag).toBe("ConfigError");
      }
    }).pipe(Effect.provide(ConfigLayer)),
  );
});
