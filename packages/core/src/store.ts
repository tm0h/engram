/**
 * The EngramStore service: CRUD over Markdown files with YAML frontmatter.
 *
 * File layout per engram:   <scope-dir>/<id>-<slug>.md
 *
 * `id` is a ULID-style string (timestamp + randomness, see `newId`) — unique
 * across machines without coordination, and lexicographically sortable by
 * creation time. Legacy 4-digit numeric ids are still read and addressable.
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
  DuplicateIdError,
  FrontmatterParseError,
  EngramNotFoundError,
  ProjectNotInitializedError,
} from "./errors.js";
import { globalEngramsDir, projectEngramsDir } from "./paths.js";
import { findProjectRoot } from "./location.js";
import { nowISO, slugify, newId } from "./util.js";
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
  ) => Effect.Effect<
    Engram,
    StoreError | EngramNotFoundError | AmbiguousIdError | DuplicateIdError
  >;
  readonly add: (scope: Scope, input: EngramInput) => Effect.Effect<Engram, StoreError>;
  readonly update: (
    scope: Scope,
    id: string,
    patch: EngramPatch,
  ) => Effect.Effect<
    Engram,
    StoreError | EngramNotFoundError | AmbiguousIdError | DuplicateIdError
  >;
  readonly remove: (
    scope: Scope,
    id: string,
  ) => Effect.Effect<
    Engram,
    StoreError | EngramNotFoundError | AmbiguousIdError | DuplicateIdError
  >;
  /** Repair duplicate ids (e.g. after a git merge): the first file per id
   * keeps it, the rest are renumbered to fresh ids. */
  readonly dedupe: (scope: Scope) => Effect.Effect<
    {
      readonly renumbered: ReadonlyArray<{
        readonly from: string;
        readonly to: string;
        readonly title: string;
      }>;
    },
    StoreError
  >;
}

export class EngramStore extends Context.Service<EngramStore, EngramStoreShape>()("EngramStore") {}

/* ----------------------------- helpers ----------------------------- */

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

/** Chronological order: by creation time, then id (ULIDs sort by creation;
 * legacy numeric ids tie-break lexicographically). */
const chronological = (a: Engram, b: Engram): number =>
  a.created.localeCompare(b.created) || a.id.localeCompare(b.id);

/** EEXIST from the platform fs surfaces as a PlatformError whose
 * `reason._tag` is "AlreadyExists" (the wrapper `_tag` is always
 * "PlatformError", so that is not a discriminator). */
const isAlreadyExists = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null || !("reason" in e)) return false;
  const reason = (e as { reason?: { _tag?: string } }).reason;
  return reason?._tag === "AlreadyExists";
};

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
          .sort(chronological);
      });

    const get: EngramStoreShape["get"] = (scope, id) =>
      Effect.gen(function* () {
        const all = yield* list(scope);
        const exact = all.filter((m) => m.id === id);
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) {
          // Two files claim the same id (e.g. hand-written with a guessed id) —
          // refuse to pick one silently.
          return yield* Effect.fail(new DuplicateIdError({ id, files: exact.map((m) => m.path) }));
        }
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

    const add: EngramStoreShape["add"] = (scope, input) =>
      Effect.gen(function* () {
        const dir = yield* dirForScope(scope);
        yield* fs.makeDirectory(dir, { recursive: true });
        const now = nowISO();
        const title = input.title.trim();
        const slug = slugify(title);

        /**
         * Ids are globally unique by construction (see `newId`), so no scan
         * or shared counter is needed — different machines, sessions, and CI
         * runs can record concurrently and merged branches can never collide
         * on id. The exclusive `wx` write is belt-and-braces: it never
         * overwrites an existing file and retries with a fresh id on the
         * (astronomically unlikely) exact-filename race.
         */
        const writeWith = (id: string): Effect.Effect<Engram, StoreError> => {
          const file = path.join(dir, `${id}-${slug}.md`);
          const engram: Engram = {
            id,
            title,
            type: input.type,
            tags: [...input.tags],
            scope,
            created: now,
            updated: now,
            author: input.author,
            pinned: input.pinned,
            body: input.body.trim(),
            path: file,
          };
          return Effect.as(fs.writeFileString(file, serialize(engram), { flag: "wx" }), engram);
        };

        const attempt = (tries: number): Effect.Effect<Engram, StoreError> =>
          Effect.flatMap(Effect.result(writeWith(newId())), (r) =>
            Result.isSuccess(r)
              ? Effect.succeed(r.success)
              : tries <= 0 || !isAlreadyExists(r.failure)
                ? Effect.fail(r.failure)
                : attempt(tries - 1),
          );

        return yield* attempt(5);
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

    const dedupe: EngramStoreShape["dedupe"] = (scope) =>
      Effect.gen(function* () {
        const dir = yield* dirForScope(scope);
        const all = yield* list(scope);
        const byId = new Map<string, Engram[]>();
        for (const m of all) byId.set(m.id, [...(byId.get(m.id) ?? []), m]);
        const renumbered: Array<{ from: string; to: string; title: string }> = [];
        for (const group of byId.values()) {
          if (group.length < 2) continue;
          // The oldest record keeps the disputed id; equal `created` values
          // fall back to the alphabetically-first path. Both keys come from
          // file content and file names, so the outcome is deterministic
          // across machines. The displaced records get fresh globally-unique
          // ids — note that a repair should be merged before another clone
          // repairs the same duplicate: two independent repairs mint
          // different ids and the merge would keep both copies.
          const [, ...rest] = [...group].sort(
            (a, b) => a.created.localeCompare(b.created) || a.path.localeCompare(b.path),
          );
          for (const m of rest) {
            // Fresh globally-unique id (see the note above on convergent
            // repairs for why the winner rule alone is not enough).
            const id = newId();
            const file = path.join(dir, `${id}-${slugify(m.title)}.md`);
            yield* fs.writeFileString(file, serialize({ ...m, id, updated: nowISO() }), {
              flag: "wx",
            });
            yield* fs.remove(m.path);
            renumbered.push({ from: m.id, to: id, title: m.title });
          }
        }
        return { renumbered };
      });

    return {
      projectRoot,
      dirForScope,
      list,
      get,
      add,
      update,
      remove,
      dedupe,
    } satisfies EngramStoreShape;
  }),
);
