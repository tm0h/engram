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
