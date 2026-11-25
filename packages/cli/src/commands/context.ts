/** `engram context` — emit an agent-ready digest for injection. */
import { Effect, Option } from "effect";
import chalk from "chalk";
import { ConfigRepo, EngramStore, type Engram } from "@engram/core";
import { incompleteMemoryWarning, renderContext, scopesToQuery } from "@engram/core";
import { searchEngrams } from "@engram/core";
import { findProjectRoot } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  contextTokenError,
  elapsedUsageMs,
  prioritizeContext,
  recordUsage,
  renderBudgetedContext,
} from "@engram/harnesses/shared";
import { out } from "../io.js";

export interface ContextOptions {
  readonly scope?: string;
  readonly query?: string;
  readonly full?: boolean;
  readonly pinned?: boolean;
  readonly limit?: number;
  readonly tokens?: string | number;
  /** ENG-17 R13: re-include inactive entries (superseded, archived, expired). */
  readonly all?: boolean;
}

/** Build the full digest text (bounded preamble + body) without printing it.
 * Used by `engram context`. */
const buildContextDigest = (opts: ContextOptions) =>
  Effect.gen(function* () {
    // Output is meant for machine/agent consumption → force plain text.
    chalk.level = 0;

    const tokens = opts.tokens === undefined ? undefined : Number(opts.tokens);
    if (tokens !== undefined) {
      const invalid = contextTokenError(
        typeof opts.tokens === "string" && !/^-?\d+$/.test(opts.tokens) ? NaN : tokens,
      );
      if (invalid) return yield* Effect.fail(new Error(invalid));
    }

    let pinned = opts.pinned;
    if (pinned === undefined) {
      const config = yield* ConfigRepo;
      pinned = (yield* config.loadGlobal()).contextPinned === "on";
    }

    const store = yield* EngramStore;
    const fs = yield* FileSystem;
    const path = yield* Path;
    const root = yield* findProjectRoot(fs, path, process.cwd());
    const projectRootOpt = root === null ? Option.none<string>() : Option.some(root);
    const scopes = scopesToQuery(opts.scope, projectRootOpt);

    const blocks: string[] = [];
    const candidates: Engram[] = [];
    const now = Date.now();
    let duplicateIds = 0;
    let omitted = 0;
    let first = true;
    for (const scope of scopes) {
      // Consume the full scan so malformed candidates cannot vanish silently;
      // the bounded warning below is what the agent sees instead.
      const scanned = yield* store.scan(scope);
      omitted += scanned.omittedFiles;
      duplicateIds += scanned.duplicateIds.length;
      const engrams = searchEngrams(
        pinned ? scanned.entries.filter((entry) => entry.pinned) : scanned.entries,
        opts.query,
        tokens === undefined ? opts.limit : undefined,
        { includeInactive: opts.all === true, now },
      ).map((r) => r.engram);
      if (tokens !== undefined) {
        for (const entry of engrams) candidates.push(entry);
        continue;
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

    if (tokens !== undefined) {
      const ranked = prioritizeContext(candidates);
      let selected = ranked;
      if (opts.limit !== undefined) {
        const withinLimit = new Set(
          scopes.flatMap((scope) =>
            ranked.filter((entry) => entry.scope === scope).slice(0, opts.limit),
          ),
        );
        selected = ranked.filter((entry) => withinLimit.has(entry));
      }
      const { text } = renderBudgetedContext(selected, {
        tokens,
        scopes,
        query: Boolean(opts.query),
        full: opts.full,
        personalOnly: opts.scope === "all" && root === null,
        omittedFiles: omitted,
        duplicateIds,
        limited: ranked.length - selected.length,
        trailingNewline: true,
      });
      return { text, hasPayload: selected.length > 0 || omitted > 0 || duplicateIds > 0 };
    }

    // Bounded, cap-protected preamble, prepended so it can never be cut by
    // downstream truncation: the incomplete-memory warning first (stdout,
    // because agents may ignore stderr), then duplicate visibility that stays
    // constant-length and points to `engram check` instead of listing an
    // unbounded offender set.
    const preamble: string[] = [];
    if (omitted > 0) preamble.push(incompleteMemoryWarning(omitted));
    if (duplicateIds > 0) {
      preamble.push(
        `# WARNING: duplicate engram ids (${duplicateIds} ${duplicateIds === 1 ? "id" : "ids"})\n` +
          "Multiple files claim the same id, so `engram show <id>` cannot resolve them. " +
          "Run `engram check --scope all` for exact paths, or `engram dedupe` to renumber.",
      );
    }

    const body = blocks.length ? blocks.join("\n\n") : "(no engrams available)";
    return {
      text: preamble.length ? [...preamble, body].join("\n\n") : body,
      hasPayload: preamble.length > 0 || blocks.length > 0,
    };
  });

/** `engram context` — print the digest for injection. */
export const contextCommand = (opts: ContextOptions) =>
  Effect.gen(function* () {
    const started = performance.now();
    const { text, hasPayload } = yield* buildContextDigest(opts);
    const ms = elapsedUsageMs(started);
    yield* out(text);
    const bytes = hasPayload ? Buffer.byteLength(text) : 0;
    yield* recordUsage({
      kind: "load",
      source: "cli",
      ms,
      bytes,
      outcome: bytes ? "loaded" : "empty",
    });
  });
