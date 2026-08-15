/** `engram search <query>` */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { scopesToQuery } from "@engram/core";
import { searchEngrams } from "@engram/core";
import { renderSearch } from "@engram/core";
import { out } from "../io.js";

export interface SearchOptions {
  readonly scope?: string;
  readonly limit?: number;
}

export const searchCommand = (query: string, opts: SearchOptions) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const scopes = scopesToQuery(opts.scope, projectRoot);
    let first = true;
    let any = false;
    for (const scope of scopes) {
      const engrams = yield* store.list(scope);
      const results = searchEngrams(engrams, query, opts.limit);
      if (scopes.length > 1) {
        if (!first) yield* out("");
        yield* out(chalk.bold(scope === "personal" ? "Personal" : "Project"));
        first = false;
      }
      if (results.length) any = true;
      yield* out(renderSearch(results));
    }
    if (!any) yield* out(chalk.gray(`No matches for "${query}".`));
  });
