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
import { Context, Effect, Layer, Option, Result } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { PlatformError } from "effect/PlatformError";
import type { Engram, EngramInput, EngramPatch, Scope, Frontmatter } from "./domain.js";
import {
  AmbiguousIdError,
  DuplicateIdError,
  FrontmatterParseError,
  EngramNotFoundError,
  IntegrityCheckFailedError,
  ProjectNotInitializedError,
} from "./errors.js";
import { compareDiagnostics } from "./integrity.js";
import type { DuplicateIdClaim, StoreDiagnostic, StoreScan } from "./integrity.js";
import { globalEngramsDir, projectEngramsDir } from "./paths.js";
import { findProjectRoot } from "./location.js";
import { nowISO, slugify, newId, parseEntryFilename, parseTimestamp } from "./util.js";
import { validateEntry, stringifyFrontmatter } from "./frontmatter.js";
import type { PartialFrontmatter } from "./frontmatter.js";

/** Errors the store can surface. */
export type StoreError =
  | ProjectNotInitializedError
  | FrontmatterParseError
  | PlatformError
  | IntegrityCheckFailedError;

/** The shape of the EngramStore service. (Methods require nothing — the
 * implementation captures FileSystem/Path at build time.) */
export interface EngramStoreShape {
  readonly projectRoot: () => Effect.Effect<Option.Option<string>, PlatformError>;
  readonly dirForScope: (scope: Scope) => Effect.Effect<string, StoreError>;
  readonly list: (scope: Scope) => Effect.Effect<ReadonlyArray<Engram>, StoreError>;
  /** Full integrity scan: every valid entry plus a diagnostic for every
   * invalid or unreadable candidate file. New read paths should consume
   * this, not `list`, so defects cannot silently vanish. */
  readonly scan: (scope: Scope) => Effect.Effect<StoreScan, StoreError>;
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
  status: fm.status,
  supersedes: fm.supersedes,
  reviewAfter: fm.reviewAfter,
  expires: fm.expires,
  sourceType: fm.sourceType,
  sourceRef: fm.sourceRef,
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
  /* Lifecycle fields emit on `!== undefined`, never on truthiness: an
   * unusual-but-valid value must not be silently discarded here. */
  if (m.status !== undefined) data.status = m.status;
  if (m.supersedes !== undefined) data.supersedes = m.supersedes;
  if (m.reviewAfter !== undefined) data.reviewAfter = m.reviewAfter;
  if (m.expires !== undefined) data.expires = m.expires;
  if (m.sourceType !== undefined) data.sourceType = m.sourceType;
  if (m.sourceRef !== undefined) data.sourceRef = m.sourceRef;
  return stringifyFrontmatter(m.body ? m.body + "\n" : "", data);
}

/** Three-state lifecycle patch merge: `undefined` preserves the current
 * value, `null` clears it (becomes absent, never serialized), and a
 * concrete value replaces it. Explicit branches keep null and preserve
 * distinct; defaulting operators like `??` would collapse them. */
const applyLifecyclePatch = <T>(
  current: T | undefined,
  instruction: T | null | undefined,
): T | undefined => {
  if (instruction === undefined) return current;
  if (instruction === null) return undefined;
  return instruction;
};

/** ENG-13 write boundary: the complete candidate is validated with the same
 * entry validation `scan` uses, before any file is written, so neither
 * `add` nor `update` can create a file the next scan would reject (invalid
 * lifecycle values, `supersedes` pointing at the entry itself, a title
 * trimmed to empty, ...). Reuses `FrontmatterParseError`, the store's
 * existing validation error. `updated_before_created` stays out: it is the
 * one non-entry-preventing relation and cannot occur for fresh candidates. */
const validateCandidate = (
  candidate: Engram,
  file: string,
): Effect.Effect<void, FrontmatterParseError> => {
  const defects = validateEntry(serialize(candidate)).issues.filter(
    (i) => i.code !== "updated_before_created",
  );
  return defects.length === 0
    ? Effect.void
    : Effect.fail(
        new FrontmatterParseError({
          file,
          message: defects.map((d) => d.message).join("; "),
        }),
      );
};

/** Advisory lifecycle diagnostics for one valid entry, computed purely from
 * the entry, the check time, and the same-scope id set. "At or before the
 * check time" counts as due/expired (equality included). Warnings never
 * omit the entry. The live scan passes `Date.now()`; tests pass a fixed
 * `nowMs` for deterministic boundaries. */
export const lifecycleDiagnostics = (
  m: Engram,
  context: {
    readonly scope: Scope;
    readonly file: string;
    readonly nowMs: number;
    /** every id claimable in this scan's scope (partial ids included) */
    readonly knownIds: ReadonlySet<string>;
  },
): ReadonlyArray<StoreDiagnostic> => {
  const out: Array<StoreDiagnostic> = [];
  const base = { severity: "warning" as const, scope: context.scope, file: context.file };
  if (m.supersedes !== undefined && !context.knownIds.has(m.supersedes)) {
    out.push({
      ...base,
      code: "supersedes_not_found",
      message: `supersedes "${m.supersedes}" does not match any entry in the ${context.scope} store`,
      hint: 'Check the id, add the older entry it replaces, or remove "supersedes" if the predecessor no longer applies.',
    });
  }
  const reviewMs = m.reviewAfter === undefined ? undefined : parseTimestamp(m.reviewAfter);
  if (reviewMs !== undefined && reviewMs <= context.nowMs) {
    out.push({
      ...base,
      code: "review_due",
      message: `"reviewAfter" (${m.reviewAfter}) is due for review`,
      hint: "Review whether this entry still holds, then update it, remove the timestamp, or delete the entry.",
    });
  }
  const expiresMs = m.expires === undefined ? undefined : parseTimestamp(m.expires);
  if (expiresMs !== undefined && expiresMs <= context.nowMs) {
    out.push({
      ...base,
      code: "expired",
      message: `"expires" (${m.expires}) has passed`,
      hint: "Confirm the entry still applies, then update it, remove the timestamp, or delete the entry.",
    });
  }
  return out;
};

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
const makeEngramStoreLive = (
  cwd: () => string,
): Layer.Layer<EngramStore, never, FileSystem | Path> =>
  Layer.effect(
    EngramStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;

      const projectRoot: EngramStoreShape["projectRoot"] = () =>
        Effect.flatMap(findProjectRoot(fs, path, cwd()), (root) =>
          Effect.succeed(root === null ? Option.none() : Option.some(root)),
        );

      const dirForScope: EngramStoreShape["dirForScope"] = (scope) =>
        Effect.gen(function* () {
          if (scope === "personal") return globalEngramsDir();
          const start = cwd();
          const root = yield* findProjectRoot(fs, path, start);
          if (root === null) {
            return yield* Effect.fail(new ProjectNotInitializedError({ cwd: start }));
          }
          return projectEngramsDir(root);
        });

      /** Read and validate every `.md` candidate in one scope's store.
       *
       * File-level failures (unreadable, malformed, semantically invalid)
       * become diagnostics and scanning continues; only a failure to list
       * the store directory itself fails the Effect: validity cannot be
       * established then. Cross-file checks (duplicate ids) run afterwards,
       * over partial values so a file with one bad field still participates. */
      const scan: EngramStoreShape["scan"] = (scope) =>
        Effect.gen(function* () {
          const dir = yield* dirForScope(scope);
          if (!(yield* fs.exists(dir))) {
            return {
              scope,
              directory: dir,
              filesChecked: 0,
              entries: [],
              diagnostics: [],
              duplicateIds: [],
              omittedFiles: 0,
            } satisfies StoreScan;
          }
          const names = yield* fs.readDirectory(dir);
          const files = names
            .filter((f) => f.endsWith(".md"))
            .sort()
            .map((f) => path.join(dir, f));

          type Candidate = {
            readonly file: string;
            readonly engram: Engram | undefined;
            readonly diagnostics: Array<StoreDiagnostic>;
          } & PartialFrontmatter;

          const candidates: ReadonlyArray<Candidate> = yield* Effect.forEach(files, (file) =>
            Effect.gen(function* () {
              const read = yield* Effect.result(fs.readFileString(file));
              return Result.match(read, {
                onSuccess: (raw) => {
                  const v = validateEntry(raw);
                  return {
                    file,
                    engram:
                      v.frontmatter === undefined
                        ? undefined
                        : toEngram(v.frontmatter, v.content.trim(), file),
                    id: v.partial.id,
                    title: v.partial.title,
                    scope: v.partial.scope,
                    supersedes: v.partial.supersedes,
                    diagnostics: v.issues.map((issue): StoreDiagnostic => ({
                      code: issue.code,
                      severity: "error",
                      scope,
                      file,
                      message: issue.message,
                      hint: issue.hint,
                    })),
                  } satisfies Candidate;
                },
                onFailure: (e) =>
                  ({
                    file,
                    engram: undefined,
                    id: undefined,
                    title: undefined,
                    scope: undefined,
                    supersedes: undefined,
                    diagnostics: [
                      {
                        code: "file_unreadable",
                        severity: "error",
                        scope,
                        file,
                        message: `could not read file: ${(e as Error).message}`,
                        hint: "Check the file's permissions and that it is a readable file, then re-run.",
                      },
                    ],
                  }) satisfies Candidate,
              });
            }),
          );

          // Per-file cross-checks against the filename and the directory's scope.
          const cross: Array<StoreDiagnostic> = [];
          for (const c of candidates) {
            const name = path.basename(c.file);
            const parsed = parseEntryFilename(name);
            if (parsed === undefined) {
              cross.push({
                code: "filename_invalid",
                severity: "error",
                scope,
                file: c.file,
                message: `filename "${name}" does not follow <id>-<slug>.md`,
                hint: "Rename to <id>-<slug>.md: the frontmatter id plus a slug of the title, e.g. 0001-my-note.md.",
              });
            } else {
              if (c.id !== undefined && parsed.id !== c.id) {
                cross.push({
                  code: "filename_id_mismatch",
                  severity: "error",
                  scope,
                  file: c.file,
                  message: `filename id "${parsed.id}" does not match frontmatter id "${c.id}"`,
                  hint: "Fix the filename prefix or frontmatter id so they agree.",
                });
              }
              if (c.title !== undefined && parsed.slug !== slugify(c.title)) {
                cross.push({
                  code: "filename_slug_mismatch",
                  severity: "error",
                  scope,
                  file: c.file,
                  message: `filename slug "${parsed.slug}" does not match title ${JSON.stringify(c.title)} (expected "${slugify(c.title)}")`,
                  hint: `Rename the file to ${parsed.id}-${slugify(c.title)}.md, or restore the title it was named after.`,
                });
              }
            }
            if (c.scope !== undefined && c.scope !== scope) {
              cross.push({
                code: "scope_mismatch",
                severity: "error",
                scope,
                file: c.file,
                message: `frontmatter scope "${c.scope}" does not match the ${scope} store this file lives in`,
                hint: `Move the file to the ${c.scope} store, or change its "scope" field to "${scope}".`,
              });
            }
          }

          // Cross-file uniqueness, over partial ids so entries with another
          // defect still participate in duplicate detection. Claims are kept
          // as structured data (StoreScan.duplicateIds), not just prose.
          const byId = new Map<string, ReadonlyArray<string>>();
          for (const c of candidates) {
            if (c.id === undefined || c.id === "") continue;
            byId.set(c.id, [...(byId.get(c.id) ?? []), c.file]);
          }
          const duplicateIds: ReadonlyArray<DuplicateIdClaim> = [...byId]
            .filter(([, files]) => files.length >= 2)
            .map(([id, files]) => ({ id, files: [...files].sort() }))
            .sort((a, b) => a.id.localeCompare(b.id));
          for (const { id, files } of duplicateIds) {
            for (const file of files) {
              const others = files.filter((f) => f !== file);
              cross.push({
                code: "duplicate_id",
                severity: "error",
                scope,
                file,
                message: `duplicate id "${id}": also claimed by ${others.join(", ")}`,
                hint: "Run `engram dedupe` to renumber the extras automatically, or renumber/remove them by hand.",
              });
            }
          }

          // ENG-13 advisory lifecycle diagnostics for valid entries. The
          // claimant set uses partial ids so an otherwise-invalid claimant
          // still counts as present (mirroring duplicate detection).
          const nowMs = Date.now();
          const knownIds = new Set(
            candidates.flatMap((c) => (c.id !== undefined && c.id !== "" ? [c.id] : [])),
          );
          const lifecycle: Array<StoreDiagnostic> = [];
          for (const c of candidates) {
            if (c.engram === undefined) continue;
            lifecycle.push(
              ...lifecycleDiagnostics(c.engram, { scope, file: c.file, nowMs, knownIds }),
            );
          }

          return {
            scope,
            directory: dir,
            filesChecked: files.length,
            entries: candidates.flatMap((c) => (c.engram ? [c.engram] : [])).sort(chronological),
            diagnostics: [...candidates.flatMap((c) => c.diagnostics), ...cross, ...lifecycle].sort(
              compareDiagnostics,
            ),
            duplicateIds,
            omittedFiles: candidates.filter((c) => c.engram === undefined).length,
          } satisfies StoreScan;
        });

      /** Compatibility view: just the valid entries (see `scan`). */
      const list: EngramStoreShape["list"] = (scope) => Effect.map(scan(scope), (s) => s.entries);

      const get: EngramStoreShape["get"] = (scope, id) =>
        Effect.gen(function* () {
          const scanned = yield* scan(scope);

          // A duplicated id must never resolve to a single claimant, even
          // when only some claimants are valid entries: `update` and `remove`
          // build on `get`, so picking one would silently mutate past a
          // known conflict.
          const claimed = scanned.duplicateIds.find((c) => c.id === id);
          if (claimed !== undefined) {
            return yield* Effect.fail(new DuplicateIdError({ id, files: claimed.files }));
          }

          const exact = scanned.entries.filter((m) => m.id === id);
          if (exact.length === 1) return exact[0];
          if (exact.length > 1) {
            // Unreachable while duplicateIds is built from the same data, but
            // keep the refusal explicit in case the invariants drift.
            return yield* Effect.fail(
              new DuplicateIdError({ id, files: exact.map((m) => m.path) }),
            );
          }

          // A prefix reaching into a duplicated id gets the same refusal.
          const claimedByPrefix = scanned.duplicateIds.find((c) => c.id.startsWith(id));
          if (claimedByPrefix !== undefined) {
            return yield* Effect.fail(
              new DuplicateIdError({ id: claimedByPrefix.id, files: claimedByPrefix.files }),
            );
          }

          const matches = scanned.entries.filter((m) => m.id.startsWith(id));
          if (matches.length === 1) return matches[0];
          if (matches.length > 1) {
            return yield* Effect.fail(
              new AmbiguousIdError({
                id,
                matches: matches.map((m) => m.id),
              }),
            );
          }
          // No valid entry has this id, but if an invalid candidate file
          // does, report its actionable parse failure instead of "not found".
          const diagnosed = scanned.diagnostics.filter(
            (d) => parseEntryFilename(path.basename(d.file))?.id === id,
          );
          if (diagnosed.length > 0) {
            const file = diagnosed[0].file;
            const detail = scanned.diagnostics
              .filter((d) => d.file === file)
              .map((d) => d.message)
              .join("; ");
            return yield* Effect.fail(new FrontmatterParseError({ file, message: detail }));
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
              status: input.status,
              supersedes: input.supersedes,
              reviewAfter: input.reviewAfter,
              expires: input.expires,
              sourceType: input.sourceType,
              sourceRef: input.sourceRef,
              body: input.body.trim(),
              path: file,
            };
            return Effect.flatMap(validateCandidate(engram, file), () =>
              Effect.as(fs.writeFileString(file, serialize(engram), { flag: "wx" }), engram),
            );
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
            status: applyLifecyclePatch(mem.status, patch.status),
            supersedes: applyLifecyclePatch(mem.supersedes, patch.supersedes),
            reviewAfter: applyLifecyclePatch(mem.reviewAfter, patch.reviewAfter),
            expires: applyLifecyclePatch(mem.expires, patch.expires),
            sourceType: applyLifecyclePatch(mem.sourceType, patch.sourceType),
            sourceRef: applyLifecyclePatch(mem.sourceRef, patch.sourceRef),
            updated: nowISO(),
          };
          const dir = yield* dirForScope(scope);
          const file = path.join(dir, `${next.id}-${slugify(next.title)}.md`);
          yield* validateCandidate(next, file);
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
          const scanned = yield* scan(scope);
          // A partially readable store must not be rewritten, and repairs
          // need a complete integrity view: error-severity diagnostics other
          // than the duplicate ids `dedupe` itself repairs block the rewrite.
          // Advisory lifecycle warnings (supersedes_not_found, review_due,
          // expired) never block, matching `engram check`.
          const otherDefects = scanned.diagnostics.filter(
            (d) => d.severity === "error" && d.code !== "duplicate_id",
          );
          if (scanned.omittedFiles > 0 || otherDefects.length > 0) {
            // Omitted candidates are exactly the diagnosed files that did not
            // become entries (soft defects like duplicate ids stay listed).
            const entryPaths = new Set(scanned.entries.map((m) => m.path));
            const badFiles = [
              ...new Set(
                scanned.diagnostics.filter((d) => !entryPaths.has(d.file)).map((d) => d.file),
              ),
            ].sort();
            const reason =
              scanned.omittedFiles > 0
                ? `${scanned.omittedFiles} of ${scanned.filesChecked} file(s) in "${dir}" could not be read as valid engrams (${badFiles.join(", ")})`
                : `the store has ${otherDefects.length} diagnostic(s) beyond duplicate ids (e.g. ${path.basename(otherDefects[0].file)})`;
            return yield* Effect.fail(
              new IntegrityCheckFailedError({
                message:
                  `refusing to dedupe: ${reason}. ` +
                  `Run \`engram check\` for exact paths and repair guidance, then retry.`,
              }),
            );
          }
          const byId = new Map<string, Engram[]>();
          for (const m of scanned.entries) byId.set(m.id, [...(byId.get(m.id) ?? []), m]);
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
        scan,
        get,
        add,
        update,
        remove,
        dedupe,
      } satisfies EngramStoreShape;
    }),
  );

/** Store layer pinned to a specific workspace directory. */
export const EngramStoreLiveAt = (
  directory: string,
): Layer.Layer<EngramStore, never, FileSystem | Path> => makeEngramStoreLive(() => directory);

/** Default store layer; resolves from the process cwd at operation time. */
export const EngramStoreLive: Layer.Layer<EngramStore, never, FileSystem | Path> =
  makeEngramStoreLive(() => process.cwd());
