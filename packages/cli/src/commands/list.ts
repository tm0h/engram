/** `engram list` */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { scopesToQuery } from "@engram/core";
import { renderList } from "@engram/core";
import { out } from "../io.js";

export interface ListOptions {
  readonly scope?: string;
  readonly type?: string;
  readonly tag?: string;
}

export const listCommand = (opts: ListOptions) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const scopes = scopesToQuery(opts.scope, projectRoot);
    const typeFilter = opts.type?.toLowerCase();
    const tagFilter = opts.tag?.toLowerCase();

    let total = 0;
    let first = true;
    for (const scope of scopes) {
      let engrams = (yield* store.list(scope)).filter((m) => {
        if (typeFilter && m.type !== typeFilter) return false;
        if (tagFilter && !m.tags.includes(tagFilter)) return false;
        return true;
      });
      if (scopes.length > 1) {
        if (!first) yield* out("");
        yield* out(
          chalk.bold(scope === "personal" ? "Personal" : "Project") +
            chalk.gray(` (${engrams.length})`),
        );
        first = false;
      }
      yield* out(renderList(engrams));
      total += engrams.length;
    }
    if (total === 0) yield* out(chalk.gray("No engrams yet. Add one with `engram add`."));
  });
