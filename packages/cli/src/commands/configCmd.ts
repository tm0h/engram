/** `engram config [action] [key] [value]` — view/edit configuration. */
import { Effect, Option } from "effect";
import chalk from "chalk";
import { ConfigRepo } from "@engram/core";
import { EngramStore } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { ENGRAM_TYPES } from "@engram/core";
import type { EngramType } from "@engram/core";
import { ValidationError } from "@engram/core";
import { findGitRoot } from "@engram/core";
import { ensureGitignoreLine, removeGitignoreLine } from "@engram/core";
import { globalConfigPath, projectConfigPath } from "@engram/core";
import { out } from "../io.js";

const isProjectKey = (k: string): boolean => k === "tracked" || k === "defaultType";

export const configCommand = (
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
) =>
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
      if (Option.isSome(projectRootOpt)) {
        const p = yield* cfg.loadProject(projectRootOpt.value);
        yield* out("");
        yield* out(
          chalk.bold("Project") + chalk.gray(` (${projectConfigPath(projectRootOpt.value)})`),
        );
        yield* out(`  tracked:     ${p.tracked ? chalk.green("on") : chalk.yellow("off")}`);
        yield* out(`  defaultType: ${chalk.cyan(p.defaultType ?? "note")}`);
        yield* out(`  author:      ${chalk.cyan(p.author ?? "(inherits global)")}`);
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
        yield* out(key === "tracked" ? (p.tracked ? "on" : "off") : (p.defaultType ?? "note"));
        return;
      }
      const g = yield* cfg.loadGlobal();
      if (key === "author") yield* out(g.author ?? "");
      else if (key === "editor") yield* out(g.editor ?? "");
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

      // global keys (author, editor)
      const g = yield* cfg.loadGlobal();
      if (key !== "author" && key !== "editor") {
        return yield* Effect.fail(new ValidationError({ message: `Unknown key "${key}".` }));
      }
      const updated =
        key === "author"
          ? { ...g, author: value }
          : { ...g, editor: value === "" ? undefined : value };
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
