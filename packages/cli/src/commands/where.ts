/** `engram where` — show resolved paths and current default scope. */
import { Effect, Option } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { resolveScope } from "@engram/core";
import {
  globalRoot,
  globalEngramsDir,
  globalConfigPath,
  projectEngramsDir,
  projectConfigPath,
} from "@engram/core";
import { out } from "../io.js";

export const whereCommand = () =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const scope = resolveScope(undefined, projectRoot);

    yield* out(chalk.bold("Current scope:    ") + chalk.cyan(scope));
    yield* out(chalk.bold("CWD:              ") + process.cwd());
    yield* out("");
    yield* out(chalk.bold("Personal (global)"));
    yield* out(`  root:     ${globalRoot()}`);
    yield* out(`  config:   ${globalConfigPath()}`);
    yield* out(`  engrams: ${globalEngramsDir()}`);
    yield* out("");
    yield* out(chalk.bold("Project"));
    if (Option.isSome(projectRoot)) {
      const root = projectRoot.value;
      yield* out(`  root:     ${chalk.cyan(root)}`);
      yield* out(`  config:   ${projectConfigPath(root)}`);
      yield* out(`  engrams: ${projectEngramsDir(root)}`);
    } else {
      yield* out(chalk.gray("  (no .engram/ project initialized here)"));
    }
  });
