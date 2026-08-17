/** `engram dedupe` — repair duplicate ids (e.g. after merging branches). */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { resolveScope, isValidScopeArg } from "@engram/core";
import { ValidationError } from "@engram/core";
import { out } from "../io.js";

export interface DedupeOptions {
  readonly scope?: string;
}

export const dedupeCommand = (opts: DedupeOptions) =>
  Effect.gen(function* () {
    // This command rewrites files — an invalid explicit scope must fail, not
    // silently fall back to the default store.
    if (opts.scope !== undefined && !isValidScopeArg(opts.scope)) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Invalid scope "${opts.scope}" — expected "personal" or "project".`,
        }),
      );
    }
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const scope = resolveScope(opts.scope, projectRoot);

    const { renumbered } = yield* store.dedupe(scope);
    if (!renumbered.length) {
      yield* out(chalk.gray("No duplicate ids found."));
      return;
    }
    for (const r of renumbered) {
      yield* out(chalk.yellow(`${r.from} → ${r.to}`) + `  ${chalk.bold(r.title)}`);
    }
    yield* out(chalk.green(`✓ Renumbered ${renumbered.length} engram(s); ids are unique again.`));
    if (scope === "project") {
      yield* out(
        chalk.gray('  commit the fix: git add .engram && git commit -m "engram: dedupe ids"'),
      );
    }
  });
