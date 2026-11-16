/** `engram config [action] [key] [value]` — view/edit configuration. */
import { Effect, Option } from "effect";
import chalk from "chalk";
import { ConfigRepo } from "@engram/core";
import { EngramStore } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  AUTO_CONTEXT_LIMIT_MAX,
  AUTO_CONTEXT_LIMIT_MIN,
  ENGRAM_TYPES,
  AUTO_CONTEXT_SCOPES,
} from "@engram/core";
import {
  DEFAULT_AUTO_CONTEXT_LIMIT,
  DEFAULT_AUTO_CONTEXT_SCOPE,
  DEFAULT_AUTO_CONTEXT_MAX_CHARS,
} from "@engram/core";
import { DEFAULT_PERSONAL_SECRET_SCAN, DEFAULT_SECRET_SCAN, SECRET_POLICIES } from "@engram/core";
import type { AutoContextScope, EngramType, SecretPolicy } from "@engram/core";
import { ValidationError } from "@engram/core";
import { findGitRoot } from "@engram/core";
import { ensureGitignoreLine, removeGitignoreLine } from "@engram/core";
import { globalConfigPath, projectConfigPath } from "@engram/core";
import { out } from "../io.js";

const isProjectKey = (k: string): boolean =>
  k === "tracked" || k === "defaultType" || k === "secretScan";

const isAutoContextKey = (k: string): boolean =>
  [
    "autoContext",
    "autoContextScope",
    "autoContextLimit",
    "autoContextSelection",
    "autoContextMaxChars",
    "autoContextIncludeScoped",
    "autoContextIncludeInactive",
  ].includes(k);

/** ENG-15: the global personal-policy key. */
const isPersonalSecretScanKey = (k: string): boolean => k === "personalSecretScan";

const parseSecretPolicy = (value: string): SecretPolicy | undefined =>
  SECRET_POLICIES.find((p) => p === value.toLowerCase());

export const configCommand = (action?: string, key?: string, value?: string) =>
  Effect.gen(function* () {
    const cfg = yield* ConfigRepo;
    const store = yield* EngramStore;
    const projectRootOpt = yield* store.projectRoot();

    /* ----------------------------- list ----------------------------- */
    if (!action || action === "list" || action === "show") {
      const g = yield* cfg.loadGlobal();
      yield* out(chalk.bold("Global") + chalk.gray(` (${globalConfigPath()})`));
      yield* out(`  author:  ${g.author ?? "(not set)"}`);
      yield* out(`  editor:  ${g.editor ?? "$EDITOR"}`);
      yield* out(
        `  autoContext:      ${g.autoContext === "off" ? chalk.yellow("off") : chalk.green("on")}`,
      );
      yield* out(
        `  autoContextScope: ${chalk.cyan(g.autoContextScope ?? DEFAULT_AUTO_CONTEXT_SCOPE)}`,
      );
      yield* out(`  autoContextLimit: ${g.autoContextLimit ?? DEFAULT_AUTO_CONTEXT_LIMIT}`);
      yield* out(`  autoContextSelection: ${g.autoContextSelection ?? "curated"}`);
      yield* out(
        `  autoContextMaxChars: ${g.autoContextMaxChars ?? DEFAULT_AUTO_CONTEXT_MAX_CHARS}`,
      );
      yield* out(`  autoContextIncludeScoped: ${g.autoContextIncludeScoped ?? "off"}`);
      yield* out(`  autoContextIncludeInactive: ${g.autoContextIncludeInactive ?? "off"}`);
      yield* out(
        `  personalSecretScan: ${chalk.cyan(g.personalSecretScan ?? DEFAULT_PERSONAL_SECRET_SCAN)}`,
      );
      if (Option.isSome(projectRootOpt)) {
        const p = yield* cfg.loadProject(projectRootOpt.value);
        yield* out("");
        yield* out(
          chalk.bold("Project") + chalk.gray(` (${projectConfigPath(projectRootOpt.value)})`),
        );
        yield* out(`  tracked:     ${p.tracked ? chalk.green("on") : chalk.yellow("off")}`);
        yield* out(`  defaultType: ${chalk.cyan(p.defaultType ?? "note")}`);
        yield* out(`  author:      ${chalk.cyan(p.author ?? "(inherits global)")}`);
        yield* out(`  secretScan:  ${chalk.cyan(p.secretScan ?? DEFAULT_SECRET_SCAN)}`);
      }
      return;
    }

    /* ----------------------------- get ------------------------------ */
    if (action === "get") {
      if (!key) {
        return yield* Effect.fail(
          new ValidationError({ message: "Usage: engram config get <key>" }),
        );
      }
      if (isProjectKey(key)) {
        if (Option.isNone(projectRootOpt)) {
          return yield* Effect.fail(
            new ValidationError({
              message: `"${key}" is a project key, but no .engram/ project is initialized here.`,
            }),
          );
        }
        const p = yield* cfg.loadProject(projectRootOpt.value);
        if (key === "secretScan") {
          yield* out(p.secretScan ?? DEFAULT_SECRET_SCAN);
          return;
        }
        yield* out(key === "tracked" ? (p.tracked ? "on" : "off") : (p.defaultType ?? "note"));
        return;
      }
      const g = yield* cfg.loadGlobal();
      if (key === "author") yield* out(g.author ?? "");
      else if (key === "editor") yield* out(g.editor ?? "");
      else if (key === "autoContext") yield* out(g.autoContext === "off" ? "off" : "on");
      else if (key === "autoContextScope")
        yield* out(g.autoContextScope ?? DEFAULT_AUTO_CONTEXT_SCOPE);
      else if (key === "autoContextLimit")
        yield* out(String(g.autoContextLimit ?? DEFAULT_AUTO_CONTEXT_LIMIT));
      else if (key === "autoContextSelection") yield* out(g.autoContextSelection ?? "curated");
      else if (key === "autoContextMaxChars")
        yield* out(String(g.autoContextMaxChars ?? DEFAULT_AUTO_CONTEXT_MAX_CHARS));
      else if (key === "autoContextIncludeScoped") yield* out(g.autoContextIncludeScoped ?? "off");
      else if (key === "autoContextIncludeInactive")
        yield* out(g.autoContextIncludeInactive ?? "off");
      else if (key === "personalSecretScan")
        yield* out(g.personalSecretScan ?? DEFAULT_PERSONAL_SECRET_SCAN);
      else return yield* Effect.fail(new ValidationError({ message: `Unknown key "${key}".` }));
      return;
    }

    /* ----------------------------- set ------------------------------ */
    if (action === "set") {
      if (!key || value === undefined) {
        return yield* Effect.fail(
          new ValidationError({ message: "Usage: engram config set <key> <value>" }),
        );
      }

      if (isProjectKey(key)) {
        if (Option.isNone(projectRootOpt)) {
          return yield* Effect.fail(
            new ValidationError({
              message: `"${key}" is a project key, but no .engram/ project is initialized here.`,
            }),
          );
        }
        const root = projectRootOpt.value;
        const p = yield* cfg.loadProject(root);

        if (key === "secretScan") {
          const policy = parseSecretPolicy(value);
          if (policy === undefined) {
            return yield* Effect.fail(
              new ValidationError({
                message: `secretScan must be one of: ${SECRET_POLICIES.join(", ")}`,
              }),
            );
          }
          yield* cfg.saveProject(root, { ...p, secretScan: policy });
          yield* out(chalk.green("✓ set ") + `project.${key} = ${policy}`);
          return;
        }

        if (key === "tracked") {
          const on = /^(1|true|on|yes)$/i.test(value);
          const off = /^(0|false|off|no)$/i.test(value);
          if (!on && !off) {
            return yield* Effect.fail(
              new ValidationError({ message: "tracked must be on or off" }),
            );
          }
          yield* cfg.saveProject(root, { ...p, tracked: on });
          const fs = yield* FileSystem;
          const path = yield* Path;
          const gitRoot = yield* findGitRoot(fs, path, process.cwd());
          if (gitRoot !== null) {
            if (on) yield* removeGitignoreLine(fs, gitRoot, ".engram/");
            else yield* ensureGitignoreLine(fs, gitRoot, ".engram/");
          }
          yield* out(chalk.green("✓ set ") + `project.${key} = ${value}`);
          return;
        }

        // defaultType
        const t = value.toLowerCase() as EngramType;
        if (!ENGRAM_TYPES.includes(t)) {
          return yield* Effect.fail(
            new ValidationError({
              message: `type must be one of: ${ENGRAM_TYPES.join(", ")}`,
            }),
          );
        }
        yield* cfg.saveProject(root, { ...p, defaultType: t });
        yield* out(chalk.green("✓ set ") + `project.${key} = ${value}`);
        return;
      }

      // global keys (author, editor, autoContext*, personalSecretScan)
      const g = yield* cfg.loadGlobal();
      if (
        key !== "author" &&
        key !== "editor" &&
        !isAutoContextKey(key) &&
        !isPersonalSecretScanKey(key)
      ) {
        return yield* Effect.fail(new ValidationError({ message: `Unknown key "${key}".` }));
      }

      let updated: typeof g;
      if (key === "personalSecretScan") {
        const policy = parseSecretPolicy(value);
        if (policy === undefined) {
          return yield* Effect.fail(
            new ValidationError({
              message: `personalSecretScan must be one of: ${SECRET_POLICIES.join(", ")}`,
            }),
          );
        }
        updated = { ...g, personalSecretScan: policy };
      } else if (key === "author") {
        updated = { ...g, author: value };
      } else if (key === "editor") {
        updated = { ...g, editor: value === "" ? undefined : value };
      } else if (key === "autoContextSelection") {
        if (value !== "curated" && value !== "legacy")
          return yield* Effect.fail(
            new ValidationError({ message: "autoContextSelection must be curated or legacy" }),
          );
        updated = { ...g, autoContextSelection: value };
      } else if (key === "autoContextMaxChars") {
        const budget = Number(value);
        if (!Number.isInteger(budget) || budget < 2048 || budget > 8192)
          return yield* Effect.fail(
            new ValidationError({
              message: "autoContextMaxChars must be an integer between 2048 and 8192",
            }),
          );
        updated = { ...g, autoContextMaxChars: budget };
      } else if (
        key === "autoContext" ||
        key === "autoContextIncludeScoped" ||
        key === "autoContextIncludeInactive"
      ) {
        const on = /^(1|true|on|yes)$/i.test(value);
        const off = /^(0|false|off|no)$/i.test(value);
        if (!on && !off) {
          return yield* Effect.fail(
            new ValidationError({ message: "autoContext must be on or off" }),
          );
        }
        updated = { ...g, [key]: on ? "on" : "off" };
      } else if (key === "autoContextScope") {
        const scope = value.toLowerCase() as AutoContextScope;
        if (!AUTO_CONTEXT_SCOPES.includes(scope)) {
          return yield* Effect.fail(
            new ValidationError({
              message: `autoContextScope must be one of: ${AUTO_CONTEXT_SCOPES.join(", ")}`,
            }),
          );
        }
        updated = { ...g, autoContextScope: scope };
      } else {
        // autoContextLimit: integer within the canonical bounds
        const limit = Number(value);
        if (
          !Number.isInteger(limit) ||
          limit < AUTO_CONTEXT_LIMIT_MIN ||
          limit > AUTO_CONTEXT_LIMIT_MAX
        ) {
          return yield* Effect.fail(
            new ValidationError({
              message: `autoContextLimit must be an integer between ${AUTO_CONTEXT_LIMIT_MIN} and ${AUTO_CONTEXT_LIMIT_MAX}`,
            }),
          );
        }
        updated = { ...g, autoContextLimit: limit };
      }
      yield* cfg.saveGlobal(updated);
      yield* out(chalk.green("✓ set ") + `global.${key} = ${value}`);
      return;
    }

    return yield* Effect.fail(
      new ValidationError({
        message: `Unknown config action "${action}". Use: get | set | list`,
      }),
    );
  });
