/**
 * The EngramStore service: CRUD over Markdown files with YAML frontmatter.
 *
 * File layout per engram:   <scope-dir>/NNNN-<slug>.md
 *
 * Each file is self-describing:
 *   ---
 *   id: "0001"
 *   title: ...
 *   type: decision
 *   tags: [a, b]
 *   scope: project
 *   created: <iso>
 *   updated: <iso>
 *   author: ...
 *   pinned: true
 *   ---
 *   <markdown body>
 */
import { Context, Effect, Layer, Option, Result, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { PlatformError } from "effect/PlatformError";
import type { Engram, EngramInput, EngramPatch, Scope, Frontmatter } from "./domain.js";
import { FrontmatterSchema } from "./domain.js";
import {
  AmbiguousIdError,
  FrontmatterParseError,
  EngramNotFoundError,
  ProjectNotInitializedError,
} from "./errors.js";
import { globalEngramsDir, projectEngramsDir } from "./paths.js";
import { findProjectRoot } from "./location.js";
import { nowISO, padId, slugify, numericId } from "./util.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

/** Errors the store can surface. */
export type StoreError = ProjectNotInitializedError | FrontmatterParseError | PlatformError;

/** The shape of the EngramStore service. (Methods require nothing — the
 * implementation captures FileSystem/Path at build time.) */
export interface EngramStoreShape {
  readonly projectRoot: () => Effect.Effect<Option.Option<string>, PlatformError>;
  readonly dirForScope: (scope: Scope) => Effect.Effect<string, StoreError>;
  readonly list: (scope: Scope) => Effect.Effect<ReadonlyArray<Engram>, StoreError>;
  readonly get: (
    scope: Scope,
    id: string,
  ) => Effect.Effect<Engram, StoreError | EngramNotFoundError | AmbiguousIdError>;
  readonly add: (scope: Scope, input: EngramInput) => Effect.Effect<Engram, StoreError>;
  readonly update: (
    scope: Scope,
    id: string,
    patch: EngramPatch,
  ) => Effect.Effect<Engram, StoreError | EngramNotFoundError | AmbiguousIdError>;
  readonly remove: (
    scope: Scope,
    id: string,
  ) => Effect.Effect<Engram, StoreError | EngramNotFoundError | AmbiguousIdError>;
}

export class EngramStore extends Context.Service<EngramStore, EngramStoreShape>()("EngramStore") {}

/* ----------------------------- helpers ----------------------------- */

const idFromFilename = (filename: string): number => {
  const m = filename.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
};

const toEngram = (fm: Frontmatter, body: string, file: string): Engram => ({
  id: fm.id,
  title: fm.title,
  type: fm.type,
  tags: fm.tags,
  scope: fm.scope,
  created: fm.created,
  updated: fm.updated,
  author: fm.author,
  pinned: fm.pinned ?? false,
  body,
  path: file,
});

function serialize(m: Engram): string {
  const data: Record<string, unknown> = {
    id: m.id,
    title: m.title,
    type: m.type,
    tags: m.tags,
    scope: m.scope,
    created: m.created,
    updated: m.updated,
  };
  if (m.author) data.author = m.author;
  if (m.pinned) data.pinned = true;
  return stringifyFrontmatter(m.body ? m.body + "\n" : "", data);
}

/* ----------------------------- live layer ----------------------------- */

/** Build the live EngramStore from the platform FileSystem + Path services. */
export const EngramStoreLive: Layer.Layer<EngramStore, never, FileSystem | Path> = Layer.effect(
  EngramStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;

    const parseFile = (file: string): Effect.Effect<Engram, FrontmatterParseError> =>
      Effect.gen(function* () {
        const raw = yield* fs
          .readFileString(file)
          .pipe(Effect.mapError(() => new FrontmatterParseError({ file, message: "read failed" })));
        const parsed = yield* Result.match(parseFrontmatter(raw), {
          onSuccess: (value) => Effect.succeed(value),
          onFailure: (message) => Effect.fail(new FrontmatterParseError({ file, message })),
        });
        return yield* Effect.try({
          try: () =>
            toEngram(
              Schema.decodeSync(FrontmatterSchema)(parsed.data as never),
              parsed.content.trim(),
              file,
            ),
          catch: (e) => new FrontmatterParseError({ file, message: String(e) }),
        });
      });

    const projectRoot: EngramStoreShape["projectRoot"] = () =>
      Effect.flatMap(findProjectRoot(fs, path, process.cwd()), (root) =>
        Effect.succeed(root === null ? Option.none() : Option.some(root)),
      );

    const dirForScope: EngramStoreShape["dirForScope"] = (scope) =>
      Effect.gen(function* () {
        if (scope === "personal") return globalEngramsDir();
        const root = yield* findProjectRoot(fs, path, process.cwd());
        if (root === null) {
          return yield* Effect.fail(new ProjectNotInitializedError({ cwd: process.cwd() }));
        }
        return projectEngramsDir(root);
      });

    const list: EngramStoreShape["list"] = (scope) =>
      Effect.gen(function* () {
        const dir = yield* dirForScope(scope);
        const exists = yield* fs.exists(dir);
        if (!exists) return [];
        const entries = yield* fs.readDirectory(dir);
        const files = entries
          .filter((f) => f.endsWith(".md"))
          .sort()
          .map((f) => path.join(dir, f));
        const parsed = yield* Effect.forEach(files, (f) => parseFile(f).pipe(Effect.option));
        return parsed
          .flatMap((o) => Option.match(o, { onNone: () => [], onSome: (m) => [m] }))
          .sort((a, b) => numericId(a.id) - numericId(b.id));
      });

    const get: EngramStoreShape["get"] = (scope, id) =>
      Effect.gen(function* () {
        const all = yield* list(scope);
        const exact = all.find((m) => m.id === id);
        if (exact) return exact;
        const matches = all.filter((m) => m.id.startsWith(id));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
          return yield* Effect.fail(
            new AmbiguousIdError({
              id,
              matches: matches.map((m) => m.id),
            }),
          );
        }
        return yield* Effect.fail(new EngramNotFoundError({ id, scope }));
      });

    const nextId = (scope: Scope): Effect.Effect<string, StoreError> =>
      Effect.gen(function* () {
        const dir = yield* dirForScope(scope);
        const exists = yield* fs.exists(dir);
        let max = 0;
        if (exists) {
          const entries = yield* fs.readDirectory(dir);
          for (const f of entries) max = Math.max(max, idFromFilename(f));
        }
        return padId(max + 1);
      });

    const add: EngramStoreShape["add"] = (scope, input) =>
      Effect.gen(function* () {
        const dir = yield* dirForScope(scope);
        yield* fs.makeDirectory(dir, { recursive: true });
        const now = nowISO();
        const id = yield* nextId(scope);
        const engram: Engram = {
          id,
          title: input.title.trim(),
          type: input.type,
          tags: [...input.tags],
          scope,
          created: now,
          updated: now,
          author: input.author,
          pinned: input.pinned,
          body: input.body.trim(),
          path: "",
        };
        const file = path.join(dir, `${id}-${slugify(engram.title)}.md`);
        yield* fs.writeFileString(file, serialize(engram));
        return { ...engram, path: file };
      });

    const update: EngramStoreShape["update"] = (scope, id, patch) =>
      Effect.gen(function* () {
        const mem = yield* get(scope, id);
        const next: Engram = {
          ...mem,
          title: patch.title !== undefined ? patch.title.trim() : mem.title,
          type: patch.type ?? mem.type,
          tags: patch.tags !== undefined ? [...patch.tags] : mem.tags,
          body: patch.body !== undefined ? patch.body.trim() : mem.body,
          pinned: patch.pinned ?? mem.pinned,
          author: patch.author !== undefined ? patch.author : mem.author,
          updated: nowISO(),
        };
        const dir = yield* dirForScope(scope);
        const file = path.join(dir, `${next.id}-${slugify(next.title)}.md`);
        yield* fs.writeFileString(file, serialize(next));
        if (file !== mem.path) yield* fs.remove(mem.path);
        return { ...next, path: file };
      });

    const remove: EngramStoreShape["remove"] = (scope, id) =>
      Effect.gen(function* () {
        const mem = yield* get(scope, id);
        yield* fs.remove(mem.path);
        return mem;
      });

    return {
      projectRoot,
      dirForScope,
      list,
      get,
      add,
      update,
      remove,
    } satisfies EngramStoreShape;
  }),
);
