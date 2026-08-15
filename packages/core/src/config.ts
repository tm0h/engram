/**
 * The ConfigRepo service: load/save global + project JSON configs, validated
 * with Schema and merged with defaults.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
  DEFAULT_PROJECT_CONFIG,
  DEFAULT_GLOBAL_CONFIG,
  type ProjectConfig,
  type GlobalConfig,
} from "./domain.js";
import { globalConfigPath, projectConfigPath } from "./paths.js";
import { ConfigError } from "./errors.js";

export type ConfigErrorUnion = ConfigError | PlatformError;

export interface ConfigRepoShape {
  readonly loadGlobal: () => Effect.Effect<GlobalConfig, ConfigErrorUnion>;
  readonly saveGlobal: (cfg: GlobalConfig) => Effect.Effect<void, ConfigErrorUnion>;
  readonly loadProject: (root: string) => Effect.Effect<ProjectConfig, ConfigErrorUnion>;
  readonly saveProject: (root: string, cfg: ProjectConfig) => Effect.Effect<void, ConfigErrorUnion>;
}

export class ConfigRepo extends Context.Service<ConfigRepo, ConfigRepoShape>()("ConfigRepo") {}

const readJson = (fs: FileSystem, file: string): Effect.Effect<unknown, ConfigErrorUnion> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(file);
    if (!exists) return null;
    const raw = yield* fs.readFileString(file);
    try {
      return JSON.parse(raw);
    } catch (e) {
      return yield* Effect.fail(
        new ConfigError({ message: `Invalid JSON in ${file}: ${String(e)}` }),
      );
    }
  });

const writeJson = (
  fs: FileSystem,
  file: string,
  data: unknown,
): Effect.Effect<void, ConfigErrorUnion> =>
  Effect.gen(function* () {
    const dir = file.slice(0, Math.max(file.lastIndexOf("/"), 0));
    if (dir) yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(file, JSON.stringify(data, null, 2) + "\n");
  });

export const ConfigRepoLive: Layer.Layer<ConfigRepo, never, FileSystem> = Layer.effect(
  ConfigRepo,
  Effect.gen(function* () {
    const fs = yield* FileSystem;

    const loadGlobal: ConfigRepoShape["loadGlobal"] = () =>
      Effect.gen(function* () {
        const data = yield* readJson(fs, globalConfigPath());
        if (data === null) return DEFAULT_GLOBAL_CONFIG;
        return yield* Effect.try({
          try: () => ({
            ...DEFAULT_GLOBAL_CONFIG,
            ...Schema.decodeSync(GlobalConfigSchema)(data as GlobalConfig),
          }),
          catch: (e) => new ConfigError({ message: `global config: ${String(e)}` }),
        });
      });

    const saveGlobal: ConfigRepoShape["saveGlobal"] = (cfg) =>
      writeJson(fs, globalConfigPath(), cfg);

    const loadProject: ConfigRepoShape["loadProject"] = (root) =>
      Effect.gen(function* () {
        const data = yield* readJson(fs, projectConfigPath(root));
        if (data === null) return DEFAULT_PROJECT_CONFIG;
        return yield* Effect.try({
          try: () => ({
            ...DEFAULT_PROJECT_CONFIG,
            ...Schema.decodeSync(ProjectConfigSchema)(data as ProjectConfig),
          }),
          catch: (e) => new ConfigError({ message: `project config: ${String(e)}` }),
        });
      });

    const saveProject: ConfigRepoShape["saveProject"] = (root, cfg) =>
      writeJson(fs, projectConfigPath(root), cfg);

    return {
      loadGlobal,
      saveGlobal,
      loadProject,
      saveProject,
    } satisfies ConfigRepoShape;
  }),
);
