/**
 * Store integrity diagnostics: the machine-facing result contract shared by
 * `EngramStore.scan` and the `engram check` command.
 *
 * Codes are a stable API: they stay concise and independent of the rendered
 * `message`/`hint` prose, so later checks (lifecycle schemas, secret
 * scanning) can append findings without changing scan or CLI consumers.
 * Every diagnostic names the exact file; `severity` is `"error"` today and
 * can gain milder levels later without changing the shape.
 */
import type { Engram, Scope } from "./domain.js";

/** Every invalid store condition `engram check` can report. */
export type StoreDiagnosticCode =
  /* frontmatter parsing and semantic validation (packages/core/src/frontmatter.ts) */
  | "frontmatter_missing"
  | "yaml_invalid"
  | "frontmatter_not_object"
  | "required_field_missing"
  | "field_type_invalid"
  | "type_invalid"
  | "scope_invalid"
  | "id_invalid"
  | "title_invalid"
  | "created_invalid"
  | "updated_invalid"
  | "updated_before_created"
  /* store scanning and cross-file checks (packages/core/src/store.ts) */
  | "file_unreadable"
  | "filename_invalid"
  | "filename_id_mismatch"
  | "filename_slug_mismatch"
  | "scope_mismatch"
  | "duplicate_id"
  /* ENG-13 lifecycle advisory conditions (packages/core/src/store.ts:
   * lifecycleDiagnostics). Warnings never omit an entry and never fail a
   * check on their own. */
  | "supersedes_not_found"
  | "review_due"
  | "expired"
  /* config validation (packages/core/src/config.ts) */
  | "config_unreadable"
  | "config_json_invalid"
  | "config_schema_invalid"
  | "config_version_unsupported";

/** Diagnostic weight. "error" marks a defect that makes a check fail;
 * "warning" is advisory (ENG-13 lifecycle conditions): reported in every
 * output mode, but a warning-only scan still passes. */
export type StoreDiagnosticSeverity = "error" | "warning";

/** One defect in one file: `message` states the problem, `hint` the repair. */
export interface StoreDiagnostic {
  readonly code: StoreDiagnosticCode;
  readonly severity: StoreDiagnosticSeverity;
  readonly scope: Scope;
  /** absolute path of the offending file */
  readonly file: string;
  readonly message: string;
  readonly hint: string;
}

/** An id claimed by two or more candidate files, valid or not. Structured
 * data (not rendered prose) so consumers like `get()` can refuse to pick a
 * claimant without re-parsing diagnostic messages. */
export interface DuplicateIdClaim {
  readonly id: string;
  /** absolute paths of every claiming file, sorted */
  readonly files: ReadonlyArray<string>;
}

/** Result of scanning one scope's store directory. */
export interface StoreScan {
  readonly scope: Scope;
  readonly directory: string;
  readonly filesChecked: number;
  /** Entries whose frontmatter passed validation (the `list()` view). */
  readonly entries: ReadonlyArray<Engram>;
  /** Every detected defect, sorted by scope, absolute path, then code. */
  readonly diagnostics: ReadonlyArray<StoreDiagnostic>;
  /** Every id claimed by two or more candidate files, sorted by id. Feeds
   * `duplicate_id` diagnostics and refusal logic in `get()`. */
  readonly duplicateIds: ReadonlyArray<DuplicateIdClaim>;
  /** Candidates that could not become an entry (unreadable or invalid). */
  readonly omittedFiles: number;
}

/** Deterministic diagnostic order (scope, then file path, then code) so
 * human output, JSON output, and tests all agree. */
export const compareDiagnostics = (a: StoreDiagnostic, b: StoreDiagnostic): number =>
  a.scope.localeCompare(b.scope) || a.file.localeCompare(b.file) || a.code.localeCompare(b.code);

/** The single bounded warning emitted when a read had to skip candidate
 * files: fail-open but loud. Its length is constant apart from the count;
 * no file list, no entry content. `engram list` prints it to stderr, and
 * context paths prepend it to their captured output. */
export const incompleteMemoryWarning = (omittedFiles: number): string =>
  `WARNING: Engram memory is incomplete. Skipped ${omittedFiles} unreadable or invalid ${
    omittedFiles === 1 ? "file" : "files"
  }. Run \`engram check --scope all\` for exact paths and repair guidance.`;
