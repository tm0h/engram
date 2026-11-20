import { randomUUID } from "node:crypto";
import { Effect, Schedule, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { writeAtomicFile } from "./atomic-file.js";
import { EngramTypeSchema, ScopeSchema, SourceTypeSchema } from "./domain.js";
import type { Scope } from "./domain.js";
import { ProjectNotInitializedError, SecretScanBlockedError, ValidationError } from "./errors.js";
import { findProjectRoot } from "./location.js";
import { globalRoot, projectDir } from "./paths.js";
import { scanContent } from "./secrets.js";
import { isValidId, nowISO, parseTimestamp } from "./util.js";

const schemaVersion = 1;
const pendingId = /^pending-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isPendingCandidateId = (id: string): boolean => pendingId.test(id);
const nonBlank = Schema.String.check(Schema.makeFilter((value) => value.trim() !== ""));
const reference = {
  scope: ScopeSchema,
  id: Schema.String.check(Schema.makeFilter(isValidId)),
};

const Proposed = Schema.Struct({
  title: nonBlank,
  type: EngramTypeSchema,
  tags: Schema.Array(Schema.String),
  body: Schema.String,
});

const CandidateInput = Schema.Struct({
  scope: ScopeSchema,
  proposed: Proposed,
  sourceExcerpt: nonBlank,
  provenanceClass: SourceTypeSchema,
  duplicates: Schema.Array(
    Schema.Struct({ ...reference, kind: Schema.Literals(["exact_duplicate", "likely_duplicate"]) }),
  ),
  conflicts: Schema.Array(
    Schema.Struct({ ...reference, kind: Schema.Literal("possible_conflict") }),
  ),
});

const Candidate = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  id: Schema.String.check(Schema.isPattern(pendingId)),
  created: Schema.String.check(Schema.makeFilter((value) => parseTimestamp(value) !== undefined)),
  ...CandidateInput.fields,
});

export type PendingCandidateInput = typeof CandidateInput.Type;
export type PendingCandidate = typeof Candidate.Type;

const Patch = Schema.Struct({
  title: Schema.optionalKey(Proposed.fields.title),
  type: Schema.optionalKey(Proposed.fields.type),
  tags: Schema.optionalKey(Proposed.fields.tags),
  body: Schema.optionalKey(Proposed.fields.body),
});
export type PendingCandidatePatch = typeof Patch.Type;

const strict = { onExcessProperty: "error" } as const;
const invalidCandidate = () => new ValidationError({ message: "Invalid pending candidate." });

const queueDirectory = Effect.fnUntraced(function* (scope: Scope, cwd: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  if (scope === "personal") return path.join(globalRoot(), "pending");

  const root = yield* findProjectRoot(fs, path, cwd);
  if (root === null) return yield* Effect.fail(new ProjectNotInitializedError({ cwd }));
  return path.join(projectDir(root), "pending");
});

const checkQueueDirectory = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const parent = yield* fs.realPath(path.dirname(directory));
  if ((yield* fs.realPath(directory)) !== path.join(parent, path.basename(directory))) {
    return yield* Effect.fail(new ValidationError({ message: "Pending queue is a symlink." }));
  }
});

const checkQueueContent = (input: PendingCandidateInput) => {
  const { proposed, sourceExcerpt } = input;
  const findings = [sourceExcerpt, proposed.title, proposed.body, ...proposed.tags].flatMap(
    scanContent,
  );
  return findings.length === 0
    ? Effect.void
    : Effect.fail(
        new SecretScanBlockedError({ file: "pending candidate", policy: "block", findings }),
      );
};

const saveCandidate = (directory: string, candidate: PendingCandidate, replace = false) =>
  writeAtomicFile(directory, candidate.id + ".json", JSON.stringify(candidate, null, 2) + "\n", {
    mode: 0o600,
    replace,
  });

const ensureIgnored = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const name = ".gitignore";
  const rule = "/*\n";
  const ignoreFile = path.join(directory, name);
  if (!(yield* fs.exists(ignoreFile))) {
    yield* writeAtomicFile(directory, name, rule, { mode: 0o600 }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    );
  }
  // Git does not read a symlink as a .gitignore file.
  if (
    (yield* fs.realPath(ignoreFile)) !== path.join(yield* fs.realPath(directory), name) ||
    (yield* fs.readFileString(ignoreFile)) !== rule
  ) {
    return yield* Effect.fail(
      new ValidationError({ message: "Pending queue ignore rule is invalid." }),
    );
  }
});

/** Store a proposal without writing to or consulting the canonical store. */
export const enqueuePendingCandidate = Effect.fnUntraced(function* (
  input: PendingCandidateInput,
  cwd: string = process.cwd(),
) {
  const validated = yield* Schema.decodeUnknownEffect(CandidateInput)(input, strict).pipe(
    Effect.mapError(invalidCandidate),
  );
  yield* checkQueueContent(validated);

  const fs = yield* FileSystem;
  const directory = yield* queueDirectory(validated.scope, cwd);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* checkQueueDirectory(directory);
  yield* ensureIgnored(directory);

  const candidate: PendingCandidate = {
    schemaVersion,
    id: `pending-${randomUUID()}`,
    created: nowISO(),
    ...validated,
  };
  yield* saveCandidate(directory, candidate);
  return candidate;
});

const candidatePath = Effect.fnUntraced(function* (scope: Scope, id: string, cwd: string) {
  if (!isPendingCandidateId(id)) {
    return yield* Effect.fail(new ValidationError({ message: "Use a full pending candidate ID." }));
  }
  const fs = yield* FileSystem;
  const path = yield* Path;
  const directory = yield* queueDirectory(scope, cwd);
  yield* checkQueueDirectory(directory);
  const file = path.join(directory, id + ".json");
  // The queue only operates on regular files. Never follow a candidate symlink.
  if (
    (yield* fs.realPath(file)) !== path.join(yield* fs.realPath(directory), id + ".json") ||
    (yield* fs.stat(file)).type !== "File"
  ) {
    return yield* Effect.fail(invalidCandidate());
  }
  return { directory, file };
});

export const readPendingCandidate = Effect.fnUntraced(function* (
  scope: Scope,
  id: string,
  cwd: string = process.cwd(),
) {
  const { file } = yield* candidatePath(scope, id, cwd);
  const fs = yield* FileSystem;
  const contents = yield* fs.readFileString(file);
  const candidate = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Candidate))(
    contents,
    strict,
  ).pipe(Effect.mapError(invalidCandidate));
  if (candidate.scope !== scope || candidate.id !== id) {
    return yield* Effect.fail(invalidCandidate());
  }
  return candidate;
});

export const listPendingIds = Effect.fnUntraced(function* (
  scope: Scope,
  cwd: string = process.cwd(),
) {
  const fs = yield* FileSystem;
  const directory = yield* queueDirectory(scope, cwd);
  return yield* Effect.gen(function* () {
    yield* checkQueueDirectory(directory);
    const files = yield* fs.readDirectory(directory);
    return files
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5))
      .filter(isPendingCandidateId)
      .sort();
  }).pipe(
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
});

export const inspectPendingCandidate = (scope: Scope, id: string, cwd: string = process.cwd()) =>
  readPendingCandidate(scope, id, cwd).pipe(Effect.tap(checkQueueContent));

export const parsePendingPatch = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Patch))(json, strict).pipe(
    Effect.mapError(
      () =>
        new ValidationError({
          message:
            "Provide a JSON patch with a nonblank title, valid type, array of tags, or a string body.",
        }),
    ),
    Effect.filterOrFail(
      (patch) => Object.keys(patch).length > 0,
      () => new ValidationError({ message: "Provide at least one field to edit." }),
    ),
  );

/** Every reviewer mutation uses the same lock for a candidate. Readers see
 * whole old or new files, and admission can still enqueue unrelated IDs. */
export const withPendingCandidateLock = <A, E, R>(
  scope: Scope,
  id: string,
  operation: Effect.Effect<A, E, R>,
  cwd: string = process.cwd(),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const { file } = yield* candidatePath(scope, id, cwd);
    const lock = file + ".lock";
    const acquire = fs.makeDirectory(lock).pipe(
      Effect.retry({
        times: 80,
        schedule: Schedule.spaced("25 millis"),
        while: (error) => error.reason._tag === "AlreadyExists",
      }),
      Effect.mapError((error) =>
        error.reason._tag === "AlreadyExists"
          ? new ValidationError({
              message: "Candidate is busy. Retry when the other review finishes.",
            })
          : error,
      ),
    );
    return yield* Effect.acquireUseRelease(
      acquire,
      () => operation,
      () => fs.remove(lock, { recursive: true }),
    );
  });

export const patchPendingCandidate = Effect.fnUntraced(function* (
  candidate: PendingCandidate,
  patch: PendingCandidatePatch,
  cwd: string = process.cwd(),
) {
  const { directory } = yield* candidatePath(candidate.scope, candidate.id, cwd);
  const proposed = yield* Schema.decodeUnknownEffect(Proposed)(
    { ...candidate.proposed, ...patch },
    strict,
  ).pipe(Effect.mapError(invalidCandidate));
  const next = { ...candidate, proposed };
  yield* checkQueueContent(next);
  yield* ensureIgnored(directory);
  yield* saveCandidate(directory, next, true);
  return next;
});

export const removePendingCandidate = Effect.fnUntraced(function* (
  scope: Scope,
  id: string,
  cwd: string = process.cwd(),
) {
  const fs = yield* FileSystem;
  const { file } = yield* candidatePath(scope, id, cwd);
  yield* fs.remove(file);
});
