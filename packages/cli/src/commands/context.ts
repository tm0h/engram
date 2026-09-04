/** `engram context` — emit an agent-ready digest for injection. */
import { Effect, Option } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { incompleteMemoryWarning, renderContext, scopesToQuery } from "@engram/core";
import { searchEngrams } from "@engram/core";
import { findProjectRoot } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { out } from "../io.js";

export interface ContextOptions {
  readonly scope?: string;
  readonly query?: string;
  readonly full?: boolean;
  readonly limit?: number;
  /** ENG-17 R13: re-include inactive entries (superseded, archived, expired). */
  readonly all?: boolean;
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
    const duplicateIds: Array<{ id: string; files: ReadonlyArray<string> }> = [];
    let omitted = 0;
    let first = true;
    for (const scope of scopes) {
      // Consume the full scan so malformed candidates cannot vanish silently;
      // the bounded warning below is what the agent sees instead.
      const scanned = yield* store.scan(scope);
      omitted += scanned.omittedFiles;
      duplicateIds.push(...scanned.duplicateIds);
      let engrams = scanned.entries;
      // Ids must be unique; surface duplicates loudly but bounded (this
      // digest is what agents read at session start).
      if (opts.query) {
        engrams = searchEngrams(engrams, opts.query, opts.limit, {
          includeInactive: opts.all === true,
        }).map((r) => r.engram);
      } else {
        // ENG-17 R3: the no-query path routes through searchEngrams too, so
        // the digest excludes inactive entries by default (previously it
        // kept the raw scan entries when no numeric limit was given).
        engrams = searchEngrams(engrams, undefined, opts.limit, {
          includeInactive: opts.all === true,
        }).map((r) => r.engram);
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

    // Bounded, cap-protected preamble, prepended so it can never be cut by
    // downstream truncation: the incomplete-memory warning first (stdout,
    // because agents may ignore stderr), then duplicate visibility that stays
    // constant-length and points to `engram check` instead of listing an
    // unbounded offender set.
    const preamble: string[] = [];
    if (omitted > 0) preamble.push(incompleteMemoryWarning(omitted));
    if (duplicateIds.length > 0) {
      preamble.push(
        `# WARNING: duplicate engram ids (${duplicateIds.length} ${
          duplicateIds.length === 1 ? "id" : "ids"
        })\n` +
          "Multiple files claim the same id, so `engram show <id>` cannot resolve them. " +
          "Run `engram check --scope all` for exact paths, or `engram dedupe` to renumber.",
      );
    }

    const body = blocks.length ? blocks.join("\n\n") : "(no engrams available)";
    yield* out(preamble.length ? [...preamble, body].join("\n\n") : body);
  });
