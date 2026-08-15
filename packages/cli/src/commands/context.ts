/** `engram context` — emit an agent-ready digest for injection. */
import { Effect, Option } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { scopesToQuery } from "@engram/core";
import { searchEngrams } from "@engram/core";
import { renderContext } from "@engram/core";
import { findProjectRoot } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { out } from "../io.js";

export interface ContextOptions {
  readonly scope?: string;
  readonly query?: string;
  readonly full?: boolean;
  readonly limit?: number;
}

export const contextCommand = (opts: ContextOptions) =>
  Effect.gen(function* () {
    // Output is meant for machine/agent consumption → force plain text.
    chalk.level = 0;

    const store = yield* EngramStore;
    const fs = yield* FileSystem;
    const path = yield* Path;
    const root = yield* findProjectRoot(fs, path, process.cwd());
    const projectRootOpt = root === null ? Option.none<string>() : Option.some(root);
    const scopes = scopesToQuery(opts.scope, projectRootOpt);

    const blocks: string[] = [];
    let first = true;
    for (const scope of scopes) {
      let engrams = yield* store.list(scope);
      if (opts.query) {
        engrams = searchEngrams(engrams, opts.query, opts.limit).map((r) => r.engram);
      } else if (typeof opts.limit === "number") {
        engrams = searchEngrams(engrams, undefined, opts.limit).map((r) => r.engram);
      }
      if (!engrams.length) continue;
      const rendered = renderContext(engrams, {
        query: opts.query,
        full: opts.full,
        scope,
        root: scope === "project" ? (root ?? undefined) : undefined,
      });
      if (scopes.length > 1) {
        if (!first) blocks.push("");
        blocks.push(`## ${scope === "personal" ? "Personal" : "Project"} engram`);
        first = false;
      }
      blocks.push(rendered);
    }

    yield* out(blocks.length ? blocks.join("\n\n") : "(no engrams available)");
  });
