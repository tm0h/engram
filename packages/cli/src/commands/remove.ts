/** `engram remove <id>` */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { resolveScope } from "@engram/core";
import { isInteractive, promptConfirm } from "../interactive.js";
import { out } from "../io.js";

export const removeCommand = (id: string, opts: { scope?: string; yes?: boolean }) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const scope = resolveScope(opts.scope, projectRoot);

    const mem = yield* store.get(scope, id);
    if (!opts.yes) {
      const tty = yield* isInteractive();
      if (tty) {
        const ok = yield* promptConfirm(`Delete [${mem.id}] "${mem.title}"?`, false);
        if (!ok) {
          yield* out(chalk.gray("Cancelled."));
          return;
        }
      }
    }
    yield* store.remove(scope, id);
    yield* out(chalk.green("✓ Deleted ") + chalk.bold(`[${mem.id}]`) + ` ${mem.title}`);
  });
