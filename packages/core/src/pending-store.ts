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
import {
  PackImportSource,
  packRejectionFile,
  packSourceRef,
  parsePackRejection,
} from "./pack-source.js";
import { parseRepositoryReference } from "./repository-reference.js";
import { isValidId, nowISO, parseTimestamp } from "./util.js";

const schemaVersion = 1;
const pendingId = /^pending-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isPendingCandidateId = (id: string): boolean => pendingId.test(id);
const nonBlank = Schema.String.check(Schema.makeFilter((value) => value.trim() !== ""));
const reference = {
  scope: ScopeSchema,
  id: Schema.String.check(Schema.makeFilter(isValidId)),
};

const timestamp = Schema.String.check(
  Schema.makeFilter((value) => parseTimestamp(value) !== undefined),
);

const Proposed = Schema.Struct({
  title: nonBlank,
  type: EngramTypeSchema,
  tags: Schema.Array(Schema.String),
  body: Schema.String,
  reviewAfter: Schema.optionalKey(timestamp),
  expires: Schema.optionalKey(timestamp),
});

export const CaptureMessageId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
);

export const CaptureOrigin = Schema.Literals([
  "user",
  "assistant",
  "tool",
  "recall",
  "external",
  "system",
]);

const CaptureEvidence = Schema.Struct({ messageId: CaptureMessageId, origin: CaptureOrigin });
const PiCaptureSource = Schema.Struct({
  harness: Schema.Literal("pi"),
  sessionKind: Schema.Literal("tui"),
  sessionId: CaptureMessageId,
  event: Schema.Literals(["agent_settled", "session_before_compact", "session_shutdown"]),
  evidence: Schema.Array(CaptureEvidence),
});
const OpenCodeCaptureSource = Schema.Struct({
  harness: Schema.Literal("opencode"),
  sessionKind: Schema.Literal("root"),
  sessionId: CaptureMessageId,
  event: Schema.Literal("command.execute.before"),
  evidence: Schema.Array(Schema.Struct({ ...CaptureEvidence.fields, partId: CaptureMessageId })),
});
export const CaptureSource = Schema.Union([PiCaptureSource, OpenCodeCaptureSource]);
export type CaptureSource = typeof CaptureSource.Type;

export const ImportFormat = Schema.Literals([
  "agents",
  "claude",
  "cursor",
  "readme",
  "hermes",
  "openclaw",
]);
export type ImportFormat = typeof ImportFormat.Type;
const FileImportSource = Schema.Struct({
  format: ImportFormat,
  path: nonBlank,
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  fileIdentity: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});
export type FileImportSource = typeof FileImportSource.Type;
const ImportSource = Schema.Union([FileImportSource, PackImportSource]);
export type ImportSource = typeof ImportSource.Type;

export const importSourceRef = (source: ImportSource): string =>
  source.format === "pack"
    ? packSourceRef(source)
    : `${source.fileIdentity ? "file-sha256:" + source.fileIdentity : source.path}#L${source.line}`;

export const pendingSourceRef = (pending: PendingCandidate): string =>
  pending.correction?.sourceRef ??
  (pending.importSource ? importSourceRef(pending.importSource) : pending.id);

const CandidateInput = Schema.Struct({
  scope: ScopeSchema,
  proposed: Proposed,
  sourceExcerpt: nonBlank,
  provenanceClass: SourceTypeSchema,
  captureSource: Schema.optionalKey(CaptureSource),
  importSource: Schema.optionalKey(ImportSource),
  correction: Schema.optionalKey(
    Schema.Struct({
      originalId: reference.id,
      originalDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      sourceRef: Schema.String.check(
        Schema.makeFilter((ref) => parseRepositoryReference(ref) !== undefined),
      ),
    }),
  ),
  duplicates: Schema.Array(
    Schema.Struct({ ...reference, kind: Schema.Literals(["exact_duplicate", "likely_duplicate"]) }),
  ),
  conflicts: Schema.Array(
    Schema.Struct({
      ...reference,
      id: Schema.String.check(Schema.makeFilter((id) => isValidId(id) || isPendingCandidateId(id))),
      kind: Schema.Literal("possible_conflict"),
    }),
  ),
});

const Candidate = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  id: Schema.String.check(Schema.isPattern(pendingId)),
  created: timestamp,
  ...CandidateInput.fields,
});

export type PendingCandidateInput = typeof CandidateInput.Type;
export type PendingCandidate = typeof Candidate.Type;

const Patch = Schema.Struct({
  title: Schema.optionalKey(Proposed.fields.title),
  type: Schema.optionalKey(Proposed.fields.type),
  tags: Schema.optionalKey(Proposed.fields.tags),
  body: Schema.optionalKey(Proposed.fields.body),
  reviewAfter: Schema.optionalKey(Schema.NullOr(timestamp)),
  expires: Schema.optionalKey(Schema.NullOr(timestamp)),
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

const checkQueueContent = (
  input: PendingCandidateInput,
): Effect.Effect<void, ValidationError | SecretScanBlockedError> => {
  const { proposed, sourceExcerpt } = input;
  if (
    input.correction &&
    (input.scope !== "project" || input.provenanceClass !== "file" || input.captureSource)
  )
    return Effect.fail(invalidCandidate());
  if (
    input.importSource &&
    (input.provenanceClass !== "file" || input.captureSource || input.correction)
  )
    return Effect.fail(invalidCandidate());
  const findings = [
    sourceExcerpt,
    proposed.title,
    proposed.body,
    ...proposed.tags,
    input.correction?.sourceRef ?? "",
    input.importSource?.path ?? "",
    input.importSource?.format === "pack" ? importSourceRef(input.importSource) : "",
  ].flatMap(scanContent);
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

const prepareQueue = Effect.fnUntraced(function* (scope: Scope, cwd: string) {
  const fs = yield* FileSystem;
  const directory = yield* queueDirectory(scope, cwd);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* checkQueueDirectory(directory);
  yield* ensureIgnored(directory);
  return directory;
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

  const directory = yield* prepareQueue(validated.scope, cwd);

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

export const listPackRejections = Effect.fnUntraced(function* (scope: Scope, cwd: string) {
  const fs = yield* FileSystem;
  const directory = yield* queueDirectory(scope, cwd);
  return yield* checkQueueDirectory(directory).pipe(
    Effect.andThen(fs.readDirectory(directory)),
    Effect.map((files) => files.flatMap((file) => parsePackRejection(file) ?? [])),
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
});

export const inspectPendingCandidate = (scope: Scope, id: string, cwd: string = process.cwd()) =>
  readPendingCandidate(scope, id, cwd).pipe(
    Effect.tap(checkQueueContent),
    Effect.tap(({ importSource }) =>
      Effect.gen(function* () {
        if (importSource?.format !== "pack") return;
        const { directory } = yield* candidatePath(scope, id, cwd);
        const fs = yield* FileSystem;
        const path = yield* Path;
        if (yield* fs.exists(path.join(directory, packRejectionFile(importSource)))) {
          return yield* Effect.fail(
            new ValidationError({
              message: "Candidate was rejected. Retry rejection to finish queue cleanup.",
            }),
          );
        }
      }),
    ),
  );

export const parsePendingPatch = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Patch))(json, strict).pipe(
    Effect.mapError(
      () =>
        new ValidationError({
          message:
            "Provide a JSON patch with title, type, tags, body, or ISO 8601 reviewAfter and expires dates (null clears a date).",
        }),
    ),
    Effect.filterOrFail(
      (patch) => Object.keys(patch).length > 0,
      () => new ValidationError({ message: "Provide at least one field to edit." }),
    ),
  );

const withQueueLock = <A, E, R>(
  lock: string,
  operation: Effect.Effect<A, E, R>,
  busyMessage: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const acquire = fs.makeDirectory(lock).pipe(
      Effect.retry({
        times: 80,
        schedule: Schedule.spaced("25 millis"),
        while: (error) => error.reason._tag === "AlreadyExists",
      }),
      Effect.mapError((error) =>
        error.reason._tag === "AlreadyExists"
          ? new ValidationError({
              message: busyMessage,
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

/** Serialize admission checks and writes within a scope. */
export const withPendingAdmissionLock = <A, E, R>(
  scope: Scope,
  operation: Effect.Effect<A, E, R>,
  cwd: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path;
    const directory = yield* prepareQueue(scope, cwd);
    return yield* withQueueLock(
      path.join(directory, ".admission.lock"),
      operation,
      "Pending admission is busy. Retry when the other admission finishes.",
    );
  });

/** Every reviewer mutation shares the same candidate lock. */
export const withPendingCandidateLock = <A, E, R>(
  scope: Scope,
  id: string,
  operation: Effect.Effect<A, E, R>,
  cwd: string = process.cwd(),
) =>
  Effect.gen(function* () {
    const { file } = yield* candidatePath(scope, id, cwd);
    return yield* withQueueLock(
      file + ".lock",
      operation,
      "Candidate is busy. Retry when the other review finishes.",
    );
  });

export const patchPendingCandidate = Effect.fnUntraced(function* (
  candidate: PendingCandidate,
  patch: PendingCandidatePatch,
  cwd: string = process.cwd(),
) {
  const { directory } = yield* candidatePath(candidate.scope, candidate.id, cwd);
  const { reviewAfter, expires, ...fields } = patch;
  const updated = { ...candidate.proposed, ...fields };
  if (reviewAfter !== undefined || expires !== undefined) {
    if (candidate.correction) {
      return yield* Effect.fail(
        new ValidationError({
          message: "Repository corrections inherit lifecycle dates from the original memory.",
        }),
      );
    }
    if (reviewAfter === null) delete updated.reviewAfter;
    else if (reviewAfter !== undefined) updated.reviewAfter = reviewAfter;
    if (expires === null) delete updated.expires;
    else if (expires !== undefined) updated.expires = expires;

    const review =
      updated.reviewAfter === undefined ? undefined : parseTimestamp(updated.reviewAfter);
    const expiry = updated.expires === undefined ? undefined : parseTimestamp(updated.expires);
    if (review !== undefined && expiry !== undefined && review > expiry) {
      return yield* Effect.fail(
        new ValidationError({ message: "The review date must be on or before expiry." }),
      );
    }
  }
  const proposed = yield* Schema.decodeUnknownEffect(Proposed)(updated, strict).pipe(
    Effect.mapError(invalidCandidate),
  );
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

// The rejection marker contains identity only. Write it before removing the
// proposal so import retries still see the decision if cleanup is interrupted.
export const rejectPendingCandidate = Effect.fnUntraced(function* <E, R>(
  scope: Scope,
  id: string,
  assertEditable: (candidate: PendingCandidate) => Effect.Effect<void, E, R>,
  cwd: string = process.cwd(),
) {
  const candidate = yield* readPendingCandidate(scope, id, cwd).pipe(
    Effect.catchTag("ValidationError", () => Effect.succeed(undefined)),
  );
  const source = candidate?.importSource;
  if (candidate && source?.format === "pack") {
    yield* assertEditable(candidate);
    const { directory } = yield* candidatePath(scope, id, cwd);
    yield* ensureIgnored(directory);
    yield* writeAtomicFile(directory, packRejectionFile(source), "", { mode: 0o600 }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    );
  }
  yield* removePendingCandidate(scope, id, cwd);
});
