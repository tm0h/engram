/** `engram search <query>` */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { scopesToQuery } from "@engram/core";
import { searchEngrams } from "@engram/core";
import { renderSearch } from "@engram/core";
import {
  searchReport,
  searchPaginationError,
  renderSearchExplanation,
  ValidationError,
  type Engram,
} from "@engram/core";
import { out } from "../io.js";

export interface SearchOptions {
  readonly scope?: string;
  readonly limit?: number;
  /** ENG-17 R13: re-include inactive entries (superseded, archived, expired). */
  readonly all?: boolean;
  readonly json?: boolean;
  readonly explain?: boolean;
  readonly offset?: number;
}

export const searchCommand = (query: string, opts: SearchOptions) =>
  Effect.gen(function* () {
    const invalid = searchPaginationError(opts.offset ?? 0, opts.limit);
    if (invalid || (opts.offset !== undefined && !opts.json && !opts.explain)) {
      return yield* Effect.fail(
        new ValidationError({ message: invalid ?? "--offset requires --json or --explain" }),
      );
    }
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const scopes = scopesToQuery(opts.scope, projectRoot);
    const now = Date.now();
    if (opts.json || opts.explain) {
      const candidates: Engram[] = [];
      for (const scope of scopes) candidates.push(...(yield* store.list(scope)));
      const ranked = searchEngrams(candidates, query, undefined, {
        includeInactive: opts.all === true,
        explain: opts.explain === true,
        now,
      });
      const report = searchReport(ranked, query, opts.offset ?? 0, opts.limit);
      yield* out(opts.json ? JSON.stringify(report) : renderSearchExplanation(report));
      return;
    }
    let first = true;
    let any = false;
    for (const scope of scopes) {
      const engrams = yield* store.list(scope);
      // ENG-17 R13: --all threads through the core options; the default
      // already excludes inactive entries inside searchEngrams.
      const results = searchEngrams(engrams, query, opts.limit, {
        includeInactive: opts.all === true,
        now,
      });
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
