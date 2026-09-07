/**
 * Tagged errors for the engram domain. These flow through the Effect error
 * channel and are formatted into friendly CLI messages at the edge.
 */
import { Data } from "effect";

export class ProjectNotInitializedError extends Data.TaggedError("ProjectNotInitializedError")<{
  readonly cwd: string;
}> {}

export class EngramNotFoundError extends Data.TaggedError("EngramNotFoundError")<{
  readonly id: string;
  readonly scope?: string;
}> {}

export class AmbiguousIdError extends Data.TaggedError("AmbiguousIdError")<{
  readonly id: string;
  readonly matches: ReadonlyArray<string>;
}> {}

export class DuplicateIdError extends Data.TaggedError("DuplicateIdError")<{
  readonly id: string;
  readonly files: ReadonlyArray<string>;
}> {}

export class InvalidTypeError extends Data.TaggedError("InvalidTypeError")<{
  readonly type: string;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
}> {}

export class FrontmatterParseError extends Data.TaggedError("FrontmatterParseError")<{
  readonly file: string;
  readonly message: string;
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
}> {}

/** A store or config integrity check failed: unreadable or invalid files
 * were found where a complete view was required (e.g. `dedupe` refusing to
 * rewrite a partially readable store, or `engram check` reporting defects). */
export class IntegrityCheckFailedError extends Data.TaggedError("IntegrityCheckFailedError")<{
  readonly message: string;
}> {}

/** ENG-15: a write was rejected because the secret scanner found findings
 * under a blocking policy. Findings are redacted by construction: they name
 * rule, line, and column, never the matched text. */
export class SecretScanBlockedError extends Data.TaggedError("SecretScanBlockedError")<{
  readonly file: string;
  readonly policy: string;
  readonly findings: ReadonlyArray<{
    readonly rule: string;
    readonly category: string;
    readonly line: number;
    readonly column: number;
  }>;
}> {}

/** Union of all expected domain errors. */
export type DomainError =
  | ProjectNotInitializedError
  | EngramNotFoundError
  | AmbiguousIdError
  | DuplicateIdError
  | InvalidTypeError
  | ValidationError
  | FrontmatterParseError
  | ConfigError
  | IntegrityCheckFailedError
  | SecretScanBlockedError;

/** Render a domain error to a human-friendly string. */
export function formatDomainError(err: DomainError): string {
  switch (err._tag) {
    case "ProjectNotInitializedError":
      return (
        `No .engram/ project found in "${err.cwd}".\n` +
        `Run \`engram init\` here, or use \`--scope personal\` for global memory.`
      );
    case "EngramNotFoundError":
      return err.scope
        ? `No engram with id "${err.id}" in scope "${err.scope}".`
        : `No engram with id "${err.id}".`;
    case "AmbiguousIdError":
      return `Ambiguous id "${err.id}" — matches: ${err.matches.join(", ")}`;
    case "DuplicateIdError":
      return (
        `Duplicate id "${err.id}" — ${err.files.length} files claim it:\n` +
        err.files.map((f) => `  ${f}`).join("\n") +
        `\nIds must be unique. Run \`engram dedupe\` to assign fresh ids automatically, ` +
        `or renumber one file by hand (filename prefix and frontmatter id), or remove it.`
      );
    case "InvalidTypeError":
      return `Unknown type "${err.type}". Valid: ${[
        "decision",
        "fact",
        "preference",
        "note",
        "issue",
        "context",
      ].join(", ")}`;
    case "ValidationError":
      return err.message;
    case "FrontmatterParseError":
      return `Failed to parse "${err.file}": ${err.message}`;
    case "ConfigError":
      return err.message;
    case "IntegrityCheckFailedError":
      return err.message;
    case "SecretScanBlockedError":
      return (
        `Write blocked by the secret scanner (policy: ${err.policy}) for "${err.file}".\n` +
        err.findings
          .map((f) => `  line ${f.line}, column ${f.column}: ${f.rule} (${f.category})`)
          .join("\n") +
        `\nRemove the secret and keep it in a dedicated secret manager, or retry the write with the per-write override (--allow-secrets / allowSecrets).`
      );
  }
}
