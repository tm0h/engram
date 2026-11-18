import { Effect, Option, Result } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  ConfigRepo,
  EngramStore,
  compareDiagnostics,
  findGitRoot,
  globalConfigPath,
  globalEngramsDir,
  projectEngramsDir,
  type Scope,
  type StoreDiagnostic,
} from "@engram/core";
import { readStats, scanAssets, type AssetStatus } from "@engram/harnesses/shared";
import { CODEX_TARGET } from "@engram/harnesses/installer";
import { INSTALL_TARGETS, readCodexHooksFlag, targetFor, userInstallRoot } from "./install.js";
import { out } from "../io.js";

interface ScopeHealth {
  readonly scope: Scope;
  readonly state: "unavailable" | "unhealthy" | "healthy" | "empty";
  readonly directory?: string;
  readonly message?: string;
  readonly filesChecked?: number;
  readonly validEntries?: number;
  readonly omittedFiles?: number;
  readonly diagnostics?: readonly StoreDiagnostic[];
}

interface IntegrationHealth {
  readonly target: (typeof INSTALL_TARGETS)[number];
  readonly root: string;
  readonly runtime: "unknown";
  readonly state: "unavailable" | "unhealthy" | "installed" | "absent" | "partial";
  readonly message?: string;
  readonly hooks?: "enabled" | "disabled" | "default" | "unavailable";
  readonly assets?: readonly { path: string; state: AssetStatus; reasons: readonly string[] }[];
  readonly leftovers?: readonly string[];
}

const problem = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const scopeHealth = (scope: Scope, directory: string | undefined, unavailable?: string) =>
  Effect.gen(function* (): Effect.fn.Return<ScopeHealth, never, FileSystem | EngramStore> {
    if (!directory) return { scope, state: "unavailable", message: unavailable };
    const fs = yield* FileSystem;
    const store = yield* EngramStore;
    const inspected = yield* Effect.result(
      Effect.gen(function* (): Effect.fn.Return<ScopeHealth, unknown> {
        if (!(yield* fs.exists(directory)))
          return {
            scope,
            directory,
            state: "unavailable",
            message: "Store directory does not exist.",
          };
        const info = yield* fs.stat(directory);
        if (info.type !== "Directory")
          return {
            scope,
            directory,
            state: "unhealthy",
            message: "Store path is not a directory.",
          };
        const scan = yield* store.scan(scope);
        const diagnostics = scan.diagnostics.slice().sort(compareDiagnostics);
        const state = diagnostics.some((item) => item.severity === "error")
          ? "unhealthy"
          : scan.entries.length
            ? "healthy"
            : "empty";
        return {
          scope,
          directory,
          state,
          diagnostics,
          filesChecked: scan.filesChecked,
          validEntries: scan.entries.length,
          omittedFiles: scan.omittedFiles,
        };
      }),
    );
    return Result.isSuccess(inspected)
      ? inspected.success
      : { scope, directory, state: "unavailable", message: problem(inspected.failure) };
  });

const integrationsAt = (directory: string) =>
  Effect.forEach(INSTALL_TARGETS, (target) =>
    Effect.gen(function* (): Effect.fn.Return<IntegrationHealth, never, FileSystem | Path> {
      const spec = targetFor(target)!;
      const root =
        spec.kind === "project" ? spec.root(directory) : userInstallRoot(target, spec.root);
      const base = { target, root, runtime: "unknown" } as const;
      const scan = yield* Effect.result(scanAssets(root, spec.spec));
      if (Result.isFailure(scan))
        return { ...base, state: "unavailable", message: problem(scan.failure) };
      const { states, leftovers } = scan.success;
      const state =
        leftovers.length || states.some((s) => ["drift", "blocked", "corrupt"].includes(s.status))
          ? "unhealthy"
          : states.every((s) => s.status === "current")
            ? "installed"
            : states.every((s) => s.status === "absent")
              ? "absent"
              : "partial";
      const assets = states.map((s) => ({
        path: s.spec.path,
        state: s.status,
        reasons: s.reasons,
      }));
      if (target !== CODEX_TARGET) return { ...base, state, assets, leftovers };
      const flag = yield* Effect.result(readCodexHooksFlag(root));
      return Result.isSuccess(flag)
        ? { ...base, state, assets, leftovers, hooks: flag.success }
        : {
            ...base,
            state,
            assets,
            leftovers,
            hooks: "unavailable",
            message: problem(flag.failure),
          };
    }),
  );

export const doctorCommand = (opts: { readonly json?: boolean }) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const config = yield* ConfigRepo;
    const fs = yield* FileSystem;
    const path = yield* Path;
    const discovery = yield* Effect.result(store.projectRoot());
    const root = Result.isSuccess(discovery) ? Option.getOrUndefined(discovery.success) : undefined;
    const scopes = [
      yield* scopeHealth(
        "project",
        root ? projectEngramsDir(root) : undefined,
        Result.isFailure(discovery) ? problem(discovery.failure) : "No initialized project found.",
      ),
      yield* scopeHealth("personal", globalEngramsDir()),
    ];

    const personalConfig = yield* Effect.result(config.validateGlobal());
    const projectConfig = root ? yield* Effect.result(config.validateProject(root)) : undefined;
    const diagnostics = [
      ...(Result.isSuccess(personalConfig) ? personalConfig.success : []),
      ...(projectConfig && Result.isSuccess(projectConfig) ? projectConfig.success : []),
    ].sort(compareDiagnostics);
    const personal = Result.isFailure(personalConfig)
      ? "unavailable"
      : personalConfig.success.length
        ? "unhealthy"
        : yield* fs.exists(globalConfigPath()).pipe(
            Effect.map((exists) => (exists ? "valid" : "defaults")),
            Effect.orElseSucceed(() => "unavailable"),
          );
    const project =
      !projectConfig || Result.isFailure(projectConfig)
        ? "unavailable"
        : projectConfig.success.length
          ? "unhealthy"
          : "valid";
    const global =
      personal === "valid" || personal === "defaults"
        ? yield* Effect.result(config.loadGlobal())
        : undefined;
    const effective = global && Result.isSuccess(global) ? global.success : undefined;
    const configuration = {
      personal,
      project,
      automaticContext: effective
        ? effective.autoContext === "on"
          ? "enabled"
          : "disabled"
        : "unavailable",
      ...(effective && {
        scope: effective.autoContextScope,
        limit: effective.autoContextLimit,
        selection: effective.autoContextSelection,
        maxChars: effective.autoContextMaxChars,
        includeScoped: effective.autoContextIncludeScoped === "on",
        includeInactive: effective.autoContextIncludeInactive === "on",
      }),
      diagnostics,
      errors: [
        ...(Result.isFailure(personalConfig) ? [problem(personalConfig.failure)] : []),
        ...(projectConfig && Result.isFailure(projectConfig)
          ? [problem(projectConfig.failure)]
          : []),
        ...(global && Result.isFailure(global) ? [problem(global.failure)] : []),
      ],
    };
    const directory =
      root ??
      (yield* findGitRoot(fs, path).pipe(Effect.orElseSucceed(() => null))) ??
      process.cwd();
    const integrations = yield* integrationsAt(directory);
    const index = {
      state: "on-demand",
      persisted: false,
      description: "BM25 builds in-memory field statistics per relevance search.",
    };
    const usage = yield* readStats();
    const stats = { state: usage.state, collection: usage.collection };
    const report = {
      report: "doctor",
      version: 1,
      scopes,
      configuration,
      integrations,
      index,
      stats,
    };
    if (opts.json) return yield* out(JSON.stringify(report, null, 2));

    for (const scope of scopes) {
      const counts =
        scope.filesChecked === undefined
          ? ""
          : ` (${scope.validEntries} valid, ${scope.omittedFiles} skipped, ${scope.filesChecked} checked)`;
      yield* out(`${scope.scope} store: ${scope.state}${counts}`);
      if (scope.message) yield* out(`  ${scope.message}`);
      for (const item of scope.diagnostics ?? []) {
        yield* out(
          `  ${item.severity} [${item.code}] ${item.file}\n  ${item.message}\n  ${item.hint}`,
        );
      }
    }
    yield* out(`Configuration: personal ${personal}, project ${project}`);
    for (const error of configuration.errors) yield* out(`  ${error}`);
    for (const item of diagnostics) {
      yield* out(
        `  ${item.severity} [${item.code}] ${item.file}\n  ${item.message}\n  ${item.hint}`,
      );
    }
    yield* out(
      `Automatic context: ${configuration.automaticContext}${effective ? ` (scope: ${effective.autoContextScope}, selection: ${effective.autoContextSelection}, limit: ${effective.autoContextLimit}, max chars: ${effective.autoContextMaxChars})` : ""}`,
    );
    for (const integration of integrations) {
      yield* out(`${integration.target}: ${integration.state} (runtime ${integration.runtime})`);
      if (integration.hooks) yield* out(`  Hooks setting: ${integration.hooks}`);
      if (integration.message) yield* out(`  ${integration.message}`);
      for (const asset of integration.assets ?? []) yield* out(`  ${asset.path}: ${asset.state}`);
      for (const leftover of integration.leftovers ?? [])
        yield* out(`  Pending installer file: ${leftover}`);
    }
    yield* out(`Index: ${index.state}. ${index.description}`);
    yield* out(`Statistics: ${stats.state} (collection ${stats.collection})`);
  });
