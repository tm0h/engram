import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { EngramTypeSchema, ScopeSchema, SourceTypeSchema } from "./domain.js";
import type { Scope } from "./domain.js";
import { ProjectNotInitializedError, SecretScanBlockedError, ValidationError } from "./errors.js";
import { findProjectRoot } from "./location.js";
import { globalRoot, projectDir } from "./paths.js";
import { scanContent } from "./secrets.js";
import { isValidId, nowISO, parseTimestamp } from "./util.js";

const schemaVersion = 1;
const pendingId = /^pending-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nonBlank = Schema.String.check(Schema.makeFilter((value) => value.trim() !== ""));
const reference = {
  scope: ScopeSchema,
  id: Schema.String.check(Schema.makeFilter(isValidId)),
};

const CandidateInput = Schema.Struct({
  scope: ScopeSchema,
  proposed: Schema.Struct({
    title: nonBlank,
    type: EngramTypeSchema,
    tags: Schema.Array(Schema.String),
    body: Schema.String,
  }),
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

/** Publish a complete file without ever replacing an existing destination. */
const publish = Effect.fnUntraced(function* (directory: string, name: string, content: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".write-" });
  const temporary = path.join(staging, name);
  yield* fs.writeFileString(temporary, content, { mode: 0o600, flag: "wx" });
  yield* fs.link(temporary, path.join(directory, name));
});

const ensureIgnored = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const name = ".gitignore";
  const rule = "/*\n";
  const ignoreFile = path.join(directory, name);
  if (!(yield* fs.exists(ignoreFile))) {
    yield* Effect.scoped(publish(directory, name, rule)).pipe(
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
  const { proposed, sourceExcerpt, scope } = validated;
  const findings = [sourceExcerpt, proposed.title, proposed.body, ...proposed.tags].flatMap(
    scanContent,
  );
  if (findings.length > 0) {
    return yield* Effect.fail(
      new SecretScanBlockedError({ file: "pending candidate", policy: "block", findings }),
    );
  }

  const fs = yield* FileSystem;
  const path = yield* Path;
  const directory = yield* queueDirectory(scope, cwd);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const parent = yield* fs.realPath(path.dirname(directory));
  if ((yield* fs.realPath(directory)) !== path.join(parent, path.basename(directory))) {
    return yield* Effect.fail(new ValidationError({ message: "Pending queue is a symlink." }));
  }
  yield* ensureIgnored(directory);

  const candidate: PendingCandidate = {
    schemaVersion,
    id: `pending-${randomUUID()}`,
    created: nowISO(),
    ...validated,
  };
  yield* Effect.scoped(
    publish(directory, candidate.id + ".json", JSON.stringify(candidate, null, 2) + "\n"),
  );
  return candidate;
});

export const readPendingCandidate = Effect.fnUntraced(function* (
  scope: Scope,
  id: string,
  cwd: string = process.cwd(),
) {
  if (!pendingId.test(id)) return yield* Effect.fail(invalidCandidate());
  const fs = yield* FileSystem;
  const path = yield* Path;
  const directory = yield* queueDirectory(scope, cwd);
  const contents = yield* fs.readFileString(path.join(directory, id + ".json"));
  const candidate = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Candidate))(
    contents,
    strict,
  ).pipe(Effect.mapError(invalidCandidate));
  if (candidate.scope !== scope || candidate.id !== id) {
    return yield* Effect.fail(invalidCandidate());
  }
  return candidate;
});
