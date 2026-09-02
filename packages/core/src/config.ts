/**
 * The ConfigRepo service: load/save global + project JSON configs, validated
 * with Schema and merged with defaults.
 */
import { Context, Effect, Layer, Result, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
  DEFAULT_PROJECT_CONFIG,
  DEFAULT_GLOBAL_CONFIG,
  SUPPORTED_CONFIG_VERSION,
  type ProjectConfig,
  type GlobalConfig,
  type Scope,
} from "./domain.js";
import { globalConfigPath, projectConfigPath } from "./paths.js";
import { ConfigError } from "./errors.js";
import type { StoreDiagnostic } from "./integrity.js";

export type ConfigErrorUnion = ConfigError | PlatformError;

export interface ConfigRepoShape {
  readonly loadGlobal: () => Effect.Effect<GlobalConfig, ConfigErrorUnion>;
  readonly saveGlobal: (cfg: GlobalConfig) => Effect.Effect<void, ConfigErrorUnion>;
  readonly loadProject: (root: string) => Effect.Effect<ProjectConfig, ConfigErrorUnion>;
  readonly saveProject: (root: string, cfg: ProjectConfig) => Effect.Effect<void, ConfigErrorUnion>;
  /** Validate the on-disk global config without merging defaults. A missing
   * global config is valid (defaults are supported). */
  readonly validateGlobal: () => Effect.Effect<ReadonlyArray<StoreDiagnostic>, PlatformError>;
  /** Validate the on-disk project config without merging defaults. The file
   * is required: its presence is what identifies an initialized store. */
  readonly validateProject: (
    root: string,
  ) => Effect.Effect<ReadonlyArray<StoreDiagnostic>, PlatformError>;
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

/** Validate one on-disk config file against its schema, without merging
 * defaults first; defaults must not conceal a missing required field. */
const validateFile = (
  fs: FileSystem,
  file: string,
  scope: Scope,
  required: boolean,
  decode: (data: unknown) => void,
): Effect.Effect<ReadonlyArray<StoreDiagnostic>, PlatformError> =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(file))) {
      if (!required) return []; // a missing global config is valid: defaults apply
      return [
        {
          code: "config_unreadable",
          severity: "error",
          scope,
          file,
          message: `config file not found: ${file}`,
          hint: `Recreate it with \`engram init\`; its presence is what marks this as an initialized store.`,
        },
      ];
    }
    const read = yield* Effect.result(fs.readFileString(file));
    if (Result.isFailure(read)) {
      return [
        {
          code: "config_unreadable",
          severity: "error",
          scope,
          file,
          message: `could not read config: ${(read.failure as Error).message}`,
          hint: "Check the file's permissions and that it is a readable file, then retry.",
        },
      ];
    }
    let data: unknown;
    try {
      data = JSON.parse(read.success);
    } catch (e) {
      return [
        {
          code: "config_json_invalid",
          severity: "error",
          scope,
          file,
          message: `invalid JSON: ${String(e)}`,
          hint: "Fix the JSON syntax; a config file must be a single JSON object.",
        },
      ];
    }
    // Version gate before the full schema: an unknown version means the rest
    // of the file may follow rules this release does not know.
    const version = (data as { readonly version?: unknown } | null)?.version;
    if (typeof version === "number" && version !== SUPPORTED_CONFIG_VERSION) {
      return [
        {
          code: "config_version_unsupported",
          severity: "error",
          scope,
          file,
          message: `unsupported config version ${version} (supported: ${SUPPORTED_CONFIG_VERSION})`,
          hint: `This config was written by a different engram release. Upgrade the engram CLI, or reset the file to version ${SUPPORTED_CONFIG_VERSION}.`,
        },
      ];
    }
    try {
      decode(data);
      return [];
    } catch (e) {
      return [
        {
          code: "config_schema_invalid",
          severity: "error",
          scope,
          file,
          message: `config failed schema validation: ${String(e)}`,
          hint: "Fix the listed fields to match the config format, or remove the file to fall back to defaults (global config only).",
        },
      ];
    }
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

    const validateGlobal: ConfigRepoShape["validateGlobal"] = () =>
      validateFile(fs, globalConfigPath(), "personal", false, (data) => {
        Schema.decodeSync(GlobalConfigSchema)(data as GlobalConfig);
      });

    const validateProject: ConfigRepoShape["validateProject"] = (root) =>
      validateFile(fs, projectConfigPath(root), "project", true, (data) => {
        Schema.decodeSync(ProjectConfigSchema)(data as ProjectConfig);
      });

    return {
      loadGlobal,
      saveGlobal,
      loadProject,
      saveProject,
      validateGlobal,
      validateProject,
    } satisfies ConfigRepoShape;
  }),
);
