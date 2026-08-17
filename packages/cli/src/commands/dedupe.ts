/** `engram dedupe` — repair duplicate ids (e.g. after merging branches). */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { resolveScope } from "@engram/core";
import { out } from "../io.js";

export interface DedupeOptions {
  readonly scope?: string;
}

export const dedupeCommand = (opts: DedupeOptions) =>
  Effect.gen(function* () {
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
