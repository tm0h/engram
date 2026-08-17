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

/** Union of all expected domain errors. */
export type DomainError =
  | ProjectNotInitializedError
  | EngramNotFoundError
  | AmbiguousIdError
  | DuplicateIdError
  | InvalidTypeError
  | ValidationError
  | FrontmatterParseError
  | ConfigError;

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
  }
}
