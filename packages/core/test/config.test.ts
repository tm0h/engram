import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FileSystem } from "effect/FileSystem";
import { systemError } from "effect/PlatformError";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigRepo, ConfigRepoLive } from "../src/config.js";
import {
  AUTO_CONTEXT_LIMIT_MAX,
  AUTO_CONTEXT_LIMIT_MIN,
  AutoContextLimitSchema,
} from "../src/domain.js";
import { Schema } from "effect";
import { projectConfigPath, globalConfigPath } from "../src/paths.js";

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
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
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
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
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

  it("exports canonical limit bounds and the schema enforces them", () => {
    expect(AUTO_CONTEXT_LIMIT_MIN).toBe(1);
    expect(AUTO_CONTEXT_LIMIT_MAX).toBe(100);
    for (const bad of [0, 101, 2.5]) {
      expect(() => Schema.decodeSync(AutoContextLimitSchema)(bad as never)).toThrow();
    }
    expect(Schema.decodeSync(AutoContextLimitSchema)(1)).toBe(1);
    expect(Schema.decodeSync(AutoContextLimitSchema)(100)).toBe(100);
  });
});

/* ------------------------------------------------------------------ */
/* validateGlobal / validateProject: config integrity diagnostics    */
/* ------------------------------------------------------------------ */

/** A ConfigRepo layer whose `readFileString` fails for one exact path. */
const unreadableConfigLive = (file: string) =>
  ConfigRepoLive.pipe(
    Layer.provide(
      Layer.effect(
        FileSystem,
        Effect.gen(function* () {
          const real = yield* FileSystem;
          return {
            ...real,
            readFileString: (p: string) =>
              p === file
                ? Effect.fail(
                    systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "readFileString",
                      pathOrDescriptor: p,
                      syscall: "open",
                    }),
                  )
                : real.readFileString(p),
          } satisfies FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(NodeServices.layer),
  );

describe("ConfigRepo / validateProject", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-vcfg-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const writeProject = (data: unknown) => {
    fs.mkdirSync(path.dirname(projectConfigPath(tmp)), { recursive: true });
    fs.writeFileSync(
      projectConfigPath(tmp),
      typeof data === "string" ? data : JSON.stringify(data),
    );
  };

  it.live("a valid v0.4 project config passes", () => {
    writeProject({ version: 1, tracked: true, defaultType: "note", author: "alice" });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      expect(yield* cfg.validateProject(tmp)).toEqual([]);
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("a missing project config is diagnosed (it identified the root)", () => {
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateProject(tmp);
      expect(diags).toHaveLength(1);
      expect(diags[0].code).toBe("config_unreadable");
      expect(diags[0].file).toBe(projectConfigPath(tmp));
      expect(diags[0].severity).toBe("error");
      expect(diags[0].scope).toBe("project");
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("invalid JSON reports the exact path", () => {
    writeProject("{not json");
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateProject(tmp);
      expect(diags.map((d) => d.code)).toEqual(["config_json_invalid"]);
      expect(diags[0].file).toBe(projectConfigPath(tmp));
      expect(diags[0].message).toContain("JSON");
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("schema violations report field-level reasons and the exact path", () => {
    writeProject({ version: 1, tracked: "yes" }); // tracked must be boolean
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateProject(tmp);
      expect(diags.map((d) => d.code)).toEqual(["config_schema_invalid"]);
      expect(diags[0].file).toBe(projectConfigPath(tmp));
      expect(diags[0].message).toContain("tracked");
      expect(diags[0].hint.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("defaults do not hide missing required on-disk fields", () => {
    writeProject({ version: 1 }); // tracked/defaultType missing on disk
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      // validation sees the raw on-disk defect and names the offending field…
      const diags = yield* cfg.validateProject(tmp);
      expect(diags.map((d) => d.code)).toEqual(["config_schema_invalid"]);
      expect(diags[0].message).toContain("tracked");
      // …and normal loading rejects it too (defaults only apply when the
      // config file is absent entirely, never to fill in missing fields)
      const loadErr = yield* Effect.flip(cfg.loadProject(tmp));
      expect((loadErr as { _tag: string })._tag).toBe("ConfigError");
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("names the offending field for wrong-typed values", () => {
    writeProject({ version: 1, tracked: true, defaultType: 42 });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateProject(tmp);
      expect(diags.map((d) => d.code)).toEqual(["config_schema_invalid"]);
      expect(diags[0].message).toContain("defaultType");
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("unsupported versions are diagnosed", () => {
    writeProject({ version: 99, tracked: true, defaultType: "note" });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateProject(tmp);
      expect(diags.map((d) => d.code)).toEqual(["config_version_unsupported"]);
      expect(diags[0].message).toContain("99");
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("an unreadable config is diagnosed", () => {
    writeProject({ version: 1, tracked: true, defaultType: "note" });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateProject(tmp);
      expect(diags.map((d) => d.code)).toEqual(["config_unreadable"]);
      expect(diags[0].message).toContain("PermissionDenied");
    }).pipe(Effect.provide(unreadableConfigLive(projectConfigPath(tmp))));
  });
});

describe("ConfigRepo / validateGlobal", () => {
  let origHome: string | undefined;
  let tmp = "";
  beforeEach(() => {
    origHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-vgcfg-"));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const writeGlobal = (data: unknown) => {
    fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
    fs.writeFileSync(globalConfigPath(), typeof data === "string" ? data : JSON.stringify(data));
  };

  it.live("a missing global config is valid (defaults are supported)", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      expect(yield* cfg.validateGlobal()).toEqual([]);
    }).pipe(Effect.provide(ConfigLayer)),
  );

  it.live("a valid v0.4 global config passes", () => {
    writeGlobal({
      version: 1,
      author: "alice",
      editor: "vim",
      autoContext: "off",
      autoContextScope: "both",
      autoContextLimit: 40,
    });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      expect(yield* cfg.validateGlobal()).toEqual([]);
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("invalid JSON reports the exact path", () => {
    writeGlobal("{oops");
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateGlobal();
      expect(diags.map((d) => d.code)).toEqual(["config_json_invalid"]);
      expect(diags[0].file).toBe(globalConfigPath());
      expect(diags[0].scope).toBe("personal");
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("schema violations are diagnosed with the exact path", () => {
    writeGlobal({ version: 1, autoContext: "maybe" });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateGlobal();
      expect(diags.map((d) => d.code)).toEqual(["config_schema_invalid"]);
      expect(diags[0].file).toBe(globalConfigPath());
      expect(diags[0].message).toContain("autoContext");
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("unsupported versions are diagnosed", () => {
    writeGlobal({ version: 2, author: "from the future" });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateGlobal();
      expect(diags.map((d) => d.code)).toEqual(["config_version_unsupported"]);
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("an unreadable config is diagnosed", () => {
    writeGlobal({ version: 1 });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateGlobal();
      expect(diags.map((d) => d.code)).toEqual(["config_unreadable"]);
      expect(diags[0].file).toBe(globalConfigPath());
    }).pipe(Effect.provide(unreadableConfigLive(globalConfigPath())));
  });
});

describe("ConfigRepo / secret-scan keys (ENG-15)", () => {
  let origHome: string | undefined;
  let home = "";
  let proj = "";
  beforeEach(() => {
    origHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "amem-ssec-home-"));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "amem-ssec-proj-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  });

  const writeProject = (data: unknown) => {
    fs.mkdirSync(path.join(proj, ".engram"), { recursive: true });
    fs.writeFileSync(projectConfigPath(proj), JSON.stringify(data, null, 2));
  };
  const writeGlobal = (data: unknown) => {
    fs.mkdirSync(path.join(home, ".engram"), { recursive: true });
    fs.writeFileSync(globalConfigPath(), JSON.stringify(data, null, 2));
  };

  it.live("project defaults to block", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const loaded = yield* cfg.loadProject(proj);
      expect(loaded.secretScan).toBe("block");
    }).pipe(Effect.provide(ConfigLayer)),
  );

  it.live("global defaults to warn", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const loaded = yield* cfg.loadGlobal();
      expect(loaded.personalSecretScan).toBe("warn");
    }).pipe(Effect.provide(ConfigLayer)),
  );

  it.live("legacy version-1 files without the keys still load and get defaults", () => {
    writeProject({ version: 1, tracked: true, defaultType: "note" });
    writeGlobal({ version: 1, author: "alice" });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const p = yield* cfg.loadProject(proj);
      expect(p.secretScan).toBe("block");
      expect(p.tracked).toBe(true);
      const g = yield* cfg.loadGlobal();
      expect(g.personalSecretScan).toBe("warn");
      expect(g.author).toBe("alice");
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("explicit values round-trip", () => {
    writeProject({ version: 1, tracked: true, defaultType: "note", secretScan: "off" });
    writeGlobal({ version: 1, personalSecretScan: "block" });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const p = yield* cfg.loadProject(proj);
      expect(p.secretScan).toBe("off");
      const g = yield* cfg.loadGlobal();
      expect(g.personalSecretScan).toBe("block");
    }).pipe(Effect.provide(ConfigLayer));
  });

  it.live("an invalid policy value is diagnosed, not loaded", () => {
    writeProject({ version: 1, tracked: true, defaultType: "note", secretScan: "banana" });
    return Effect.gen(function* () {
      const cfg = yield* ConfigRepo;
      const diags = yield* cfg.validateProject(proj);
      expect(diags.map((d) => d.code)).toEqual(["config_schema_invalid"]);
      expect(diags[0].message).toContain("secretScan");
    }).pipe(Effect.provide(ConfigLayer));
  });
});
