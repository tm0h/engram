/**
 * Harness-agnostic engram operations. Every op returns an infallible
 * `OpResult` Effect: domain errors are captured into `isError` results so any
 * harness adapter (pi tools, future MCP/JSON surfaces) gets uniform,
 * serializable output.
 *
 * Rendering is plain text (no ANSI): the primary consumer is the LLM.
 */
import { Effect, Option, Result } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  ConfigRepo,
  EngramStore,
  detectAuthor,
  ensureGitignoreLine,
  findGitRoot,
  findProjectRoot,
  formatDomainError,
  projectEngramsDir,
  projectReadmeContent,
  projectReadmePath,
  removeGitignoreLine,
  searchEngrams,
  type Engram,
  type Scope,
} from "@engram/core";
import { PERSONAL_ONLY_NOTE, projectUninitialized } from "./degraded.js";
import { MAX_RESULT_CHARS, capText, pageFooter, paginate } from "./pagination.js";
import type {
  AddOptions,
  ContextOptions,
  InitOptions,
  OpResult,
  ScopeFilter,
  SearchOptions,
  ShowOptions,
} from "./types.js";

export const DEFAULT_CONTEXT_LIMIT = 25;
export const DEFAULT_SEARCH_LIMIT = 10;

/* ----------------------------- helpers ----------------------------- */

const ok = (text: string, details: Record<string, unknown> = {}): OpResult => ({
  text,
  isError: false,
  details,
});

const err = (text: string, details: Record<string, unknown> = {}): OpResult => ({
  text,
  isError: true,
  details: { ...details, error: text },
});

const KNOWN_DOMAIN_ERRORS = new Set([
  "ProjectNotInitializedError",
  "EngramNotFoundError",
  "AmbiguousIdError",
  "DuplicateIdError",
  "InvalidTypeError",
  "ValidationError",
  "FrontmatterParseError",
  "ConfigError",
]);

const describeError = (e: unknown): string => {
  if (
    typeof e === "object" &&
    e !== null &&
    "_tag" in e &&
    KNOWN_DOMAIN_ERRORS.has(String((e as { _tag: unknown })._tag))
  ) {
    return formatDomainError(e as never);
  }
  return e instanceof Error ? e.message : String(e);
};

/** Capture any op failure into an isError result. */
const capture = <R>(eff: Effect.Effect<OpResult, unknown, R>): Effect.Effect<OpResult, never, R> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(eff);
    return yield* Result.match(result, {
      onSuccess: (value) => Effect.succeed(value),
      onFailure: (e) => Effect.succeed(err(describeError(e))),
    });
  });

const tagsSuffix = (tags: ReadonlyArray<string>): string =>
  tags.length ? " " + tags.map((t) => `#${t}`).join(" ") : "";

/** One digest line: `★ 0012 decision Title #tags` (two-space indent when not pinned). */
const lineOf = (m: Engram, markScope = false): string =>
  `${m.pinned ? "★" : " "} ${m.id} ${m.type} ${m.title}${tagsSuffix(m.tags)}${
    markScope ? ` (${m.scope})` : ""
  }`;

/** Decisions & pinned first, then the rest (mirrors `engram context`). */
const ordered = (list: ReadonlyArray<Engram>): Engram[] => {
  const head = list.filter((m) => m.type === "decision" || m.pinned);
  const tail = list.filter((m) => !(m.type === "decision" || m.pinned));
  return [...head, ...tail];
};

interface ResolvedScopes {
  readonly scopes: ReadonlyArray<Scope>;
  readonly personalOnly: boolean;
}

/**
 * Resolve a scope filter against the project-root option.
 * - explicit `project` with no root → null (caller reports the degraded error)
 * - `both` with no root → personal only + note
 */
const resolveScopes = (filter: ScopeFilter, root: Option.Option<string>): ResolvedScopes | null => {
  if (filter === "personal") return { scopes: ["personal"], personalOnly: false };
  if (filter === "project")
    return Option.isSome(root) ? { scopes: ["project"], personalOnly: false } : null;
  return Option.isSome(root)
    ? { scopes: ["project", "personal"], personalOnly: false }
    : { scopes: ["personal"], personalOnly: true };
};

const dateShort = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
};

/** Cap a rendered block while reserving room for a trailing footer line. */
const capWithFooter = (block: string, footer: string): { text: string; truncated: boolean } => {
  const capped = capText(block, MAX_RESULT_CHARS - footer.length - 1);
  return capped.truncated
    ? {
        text: `${capped.text}\n${footer}\n(list truncated to fit the size cap)`,
        truncated: true,
      }
    : { text: `${block}\n${footer}`, truncated: false };
};

const applyCap = (text: string): string => {
  const capped = capText(text);
  return capped.truncated ? `${capped.text}\n(result truncated)` : capped.text;
};

/* ------------------------------ ops ------------------------------ */

/** Digest of recorded engrams, decisions & pinned first, paginated. */
export const contextDigest = (
  opts: ContextOptions = {},
): Effect.Effect<OpResult, never, EngramStore> =>
  capture(
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const root = yield* store.projectRoot();
      const resolved = resolveScopes(opts.scope ?? "both", root);
      if (resolved === null) return err(projectUninitialized("read"));

      const sections: Array<{ scope: Scope; items: Engram[] }> = [];
      for (const scope of resolved.scopes) {
        sections.push({ scope, items: ordered(yield* store.list(scope)) });
      }
      const flat = sections.flatMap((s) => s.items);
      const multiScope = resolved.scopes.length > 1;
      const page = paginate(flat, opts.offset ?? 0, opts.limit ?? DEFAULT_CONTEXT_LIMIT);

      const lines: string[] = [];
      if (resolved.personalOnly) lines.push(`(${PERSONAL_ONLY_NOTE})`);

      const where =
        resolved.scopes.length === 1
          ? resolved.scopes[0] === "personal"
            ? "personal engram (~/.engram)"
            : `project engram (${Option.getOrUndefined(root)})`
          : "project + personal engram";
      lines.push(`# Engram context - ${where}`);
      lines.push(`${flat.length} engram${flat.length === 1 ? "" : "s"}.`);

      for (const section of sections) {
        const inPage = page.items.filter((m) => m.scope === section.scope);
        if (!inPage.length) continue;
        if (multiScope) {
          lines.push("");
          lines.push(
            section.scope === "project"
              ? `## Project (${Option.getOrUndefined(root)})`
              : "## Personal (~/.engram)",
          );
        }
        const head = inPage.filter((m) => m.type === "decision" || m.pinned);
        const tail = inPage.filter((m) => !(m.type === "decision" || m.pinned));
        if (head.length) {
          if (multiScope) lines.push("### Decisions & pinned");
          else lines.push("## Decisions & pinned");
          lines.push(...head.map((m) => lineOf(m)));
        }
        if (tail.length) {
          if (multiScope) lines.push("### Other");
          else lines.push("## Other");
          lines.push(...tail.map((m) => lineOf(m)));
        }
      }

      if (!flat.length) lines.push("No engrams in scope yet.");

      const from = page.offset + 1;
      const to = page.offset + page.items.length;
      let footer: string | null = null;
      if (page.nextOffset !== null && page.items.length > 0) {
        const nextParams: Record<string, unknown> = { offset: page.nextOffset };
        if (opts.scope !== undefined) nextParams.scope = opts.scope;
        if (opts.limit !== undefined) nextParams.limit = opts.limit;
        const nextCall = `engram_context(${JSON.stringify(nextParams)})`;
        footer = `${pageFooter({ from, to, total: page.total, nextOffset: page.nextOffset, nextCall })}; use engram_show({"id":"…"}) to read one`;
      }

      const body = lines.join("\n");
      const text = footer === null ? applyCap(body) : capWithFooter(body, footer).text;
      return ok(text, {
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        nextOffset: page.nextOffset,
        personalOnly: resolved.personalOnly,
      });
    }),
  );

/** Relevance search across scopes, paginated digest lines. */
export const searchOp = (opts: SearchOptions): Effect.Effect<OpResult, never, EngramStore> =>
  capture(
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const root = yield* store.projectRoot();
      const resolved = resolveScopes(opts.scope ?? "both", root);
      if (resolved === null) return err(projectUninitialized("read"));

      // Rank once across the combined candidates so relevance (not scope
      // grouping) decides the order.
      const candidates: Engram[] = [];
      for (const scope of resolved.scopes) {
        candidates.push(...(yield* store.list(scope)));
      }
      const matched = searchEngrams(candidates, opts.query).map((r) => r.engram);
      const multiScope = resolved.scopes.length > 1;
      const page = paginate(matched, opts.offset ?? 0, opts.limit ?? DEFAULT_SEARCH_LIMIT);

      const lines: string[] = [
        `# Engram search: "${opts.query}" - ${matched.length} match${matched.length === 1 ? "" : "es"}.`,
      ];
      if (!matched.length) {
        lines.push(`No matches. Broaden the query, or call engram_context for the digest.`);
        if (resolved.personalOnly) lines.push(`(${PERSONAL_ONLY_NOTE})`);
        return ok(lines.join("\n"), { total: 0, offset: 0, limit: page.limit, nextOffset: null });
      }
      lines.push(...page.items.map((m) => lineOf(m, multiScope)));

      const from = page.offset + 1;
      const to = page.offset + page.items.length;
      let footer: string | null = null;
      if (page.nextOffset !== null && page.items.length > 0) {
        const nextParams: Record<string, unknown> = { query: opts.query, offset: page.nextOffset };
        if (opts.scope !== undefined) nextParams.scope = opts.scope;
        if (opts.limit !== undefined) nextParams.limit = opts.limit;
        const nextCall = `engram_search(${JSON.stringify(nextParams)})`;
        footer = `${pageFooter({ from, to, total: page.total, nextOffset: page.nextOffset, nextCall })}; use engram_show({"id":"…"}) to read one`;
      }

      const body = lines.join("\n");
      const text = footer === null ? applyCap(body) : capWithFooter(body, footer).text;
      return ok(text, {
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        nextOffset: page.nextOffset,
        query: opts.query,
      });
    }),
  );

/** Full view of one engram; body sliced by char offset/limit. */
export const showOp = (opts: ShowOptions): Effect.Effect<OpResult, never, EngramStore> =>
  capture(
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const root = yield* store.projectRoot();
      // Explicit project scope outside a project gets the friendly hint
      // (same contract as contextDigest/searchOp) instead of a raw store error.
      if (opts.scope === "project" && Option.isNone(root)) {
        return err(projectUninitialized("read"));
      }
      const scope: Scope = opts.scope ?? (Option.isSome(root) ? "project" : "personal");

      const m = yield* store.get(scope, opts.id);

      const header = [
        `# [${m.id}] ${m.title}`,
        `type: ${m.type}`,
        ...(m.tags.length ? [`tags:${tagsSuffix(m.tags)}`] : []),
        `scope: ${m.scope}`,
        `created: ${dateShort(m.created)} (updated: ${dateShort(m.updated)})`,
        ...(m.author ? [`author: ${m.author}`] : []),
        ...(m.pinned ? ["pinned: true"] : []),
        "",
      ].join("\n");

      let text: string;
      let nextOffset: number | null = null;
      if (m.body) {
        const bodyOffset = Math.max(0, Math.floor(opts.offset ?? 0));
        const bodyLimit =
          opts.limit === undefined ? m.body.length : Math.max(0, Math.floor(opts.limit));

        // Reserve room for the continuation footer so the hard cap can never
        // cut it off, and derive nextOffset from what was actually returned.
        const nextParams: Record<string, unknown> = { id: m.id };
        if (opts.scope !== undefined) nextParams.scope = opts.scope;
        const footerReserve = 200;
        const available = Math.max(0, MAX_RESULT_CHARS - header.length - footerReserve);
        const sliceLen = Math.min(bodyLimit, available);
        const slice = m.body.slice(bodyOffset, bodyOffset + sliceLen);
        const consumed = bodyOffset + slice.length;
        const hasMore = slice.length > 0 && consumed < m.body.length;

        text = header + slice;
        if (hasMore) {
          nextOffset = consumed;
          nextParams.offset = nextOffset;
          if (opts.limit !== undefined) nextParams.limit = opts.limit;
          const nextCall = `engram_show(${JSON.stringify(nextParams)})`;
          text += `\n\n(body truncated - call ${nextCall} for the rest)`;
        }
      } else {
        text = header + "(no body)";
      }

      return ok(applyCap(text), {
        id: m.id,
        scope: m.scope,
        nextOffset,
        bodyLength: m.body.length,
        path: m.path,
      });
    }),
  );

/** Record a new engram. Defaults mirror the CLI: project scope, config type/author. */
export const addOp = (opts: AddOptions): Effect.Effect<OpResult, never, EngramStore | ConfigRepo> =>
  capture(
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const cfg = yield* ConfigRepo;
      const root = yield* store.projectRoot();

      const scope: Scope = opts.scope ?? "project";
      if (scope === "project" && Option.isNone(root)) {
        return err(projectUninitialized("add"));
      }

      const title = opts.title.trim();
      if (!title) return err("A title is required. Pass a short, descriptive title.");

      const type =
        opts.type ??
        (scope === "project" && Option.isSome(root)
          ? ((yield* cfg.loadProject(root.value)).defaultType ?? "note")
          : "note");
      const projectAuthor =
        scope === "project" && Option.isSome(root)
          ? (yield* cfg.loadProject(root.value)).author
          : undefined;
      const globalAuthor = (yield* cfg.loadGlobal()).author;
      const author = opts.author ?? projectAuthor ?? globalAuthor ?? (yield* detectAuthor());

      const tags = Array.from(
        new Set((opts.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)),
      );

      const m = yield* store.add(scope, {
        title,
        type,
        tags,
        body: opts.body,
        pinned: Boolean(opts.pinned),
        author,
      });

      const tracked =
        scope === "project" && Option.isSome(root)
          ? (yield* cfg.loadProject(root.value)).tracked
          : false;
      const lines = [
        `Added [${m.id}] ${m.title}`,
        `  ${m.path}`,
        tracked
          ? "  scope: project (git-tracked - commit .engram/ to share with the team)"
          : `  scope: ${m.scope}`,
      ];
      return ok(lines.join("\n"), { id: m.id, path: m.path, scope: m.scope, type: m.type });
    }),
  );

/** Non-interactive `engram init`. Creates .engram/, config, README, gitignore line. */
export const initOp = (
  opts: InitOptions,
): Effect.Effect<OpResult, never, FileSystem | Path | ConfigRepo> =>
  capture(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const cfg = yield* ConfigRepo;

      const existing = yield* findProjectRoot(fs, path, process.cwd());
      if (existing !== null) {
        return ok(`Already initialized: ${existing}/.engram`, { root: existing });
      }

      const gitRoot = yield* findGitRoot(fs, path, process.cwd());
      const root = gitRoot ?? process.cwd();

      yield* fs.makeDirectory(projectEngramsDir(root), { recursive: true });
      yield* cfg.saveProject(root, { version: 1, tracked: opts.tracked, defaultType: "note" });
      yield* fs.writeFileString(projectReadmePath(root), projectReadmeContent(opts.tracked));

      const global = yield* cfg.loadGlobal();
      if (global.author === undefined) {
        yield* cfg.saveGlobal({ ...global, author: yield* detectAuthor() });
      }

      if (gitRoot !== null) {
        if (opts.tracked) {
          yield* removeGitignoreLine(fs, gitRoot, ".engram/");
          yield* removeGitignoreLine(fs, gitRoot, ".engram/engrams/");
        } else {
          yield* ensureGitignoreLine(fs, gitRoot, ".engram/");
        }
      }

      const lines = [
        "Project engram initialized.",
        `  location: ${root}/.engram`,
        opts.tracked
          ? "  tracking: git-tracked (shared with team)"
          : "  tracking: gitignored (local only)",
      ];
      return ok(lines.join("\n"), { root, tracked: opts.tracked });
    }),
  );
