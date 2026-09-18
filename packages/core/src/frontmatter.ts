/**
 * Minimal YAML frontmatter parse/stringify/validate — the engram file format.
 *
 * Format:
 *   ---
 *   <yaml>
 *   ---
 *   <markdown body>
 *
 * Rules:
 *   - The opening delimiter must be a bare `---` on the first line
 *     (a UTF-8 BOM is tolerated). Language tags (`---json`, …) are not
 *     part of the format and are treated as plain content.
 *   - The block closes with `---` or `...` on its own line, or at EOF.
 *   - Unterminated blocks are treated as plain content, not an error.
 *   - YAML resolves under js-yaml's `JSON_SCHEMA`: no YAML 1.1 booleans,
 *     no timestamps, no octals — strings stay strings in both directions.
 *
 * `parseFrontmatter` stays a low-level parser; `validateEntry` adds the pure
 * staged entry validation (syntax + required fields + field semantics +
 * lifecycle consistency) used by `EngramStore.scan`. This module never
 * touches filesystem paths or scope discovery: diagnostics here are
 * file-free and the store attaches the location.
 */
import { Result } from "effect";
import yaml from "js-yaml";
import { ENGRAM_STATUSES, ENGRAM_TYPES, SOURCE_TYPES } from "./domain.js";
import type { EngramType, Frontmatter, Scope, SourceType, Status } from "./domain.js";
import { isValidId, parseTimestamp } from "./util.js";

export interface ParsedFrontmatter {
  /** Whatever the YAML block resolved to; validating it is the caller's job. */
  readonly data: unknown;
  /** The markdown body below the closing delimiter. */
  readonly content: string;
}

/** Opening delimiter: `---` + optional trailing spaces at byte 0, then a
 * newline (or EOF). */
const OPEN = /^---[ \t]*(\r?\n|$)/;
/** Closing delimiter: `---` or `...` + optional trailing spaces on its own
 * line (or at EOF). */
const CLOSE = /^(?:---|\.\.\.)[ \t]*(\r?\n|$)/m;

/** What the raw text structurally contained. `plain` covers both "no
 * frontmatter at all" and "unterminated block" (treated as content); for
 * `yaml` the data is the raw resolution, so `null` and scalars stay as-is
 * validators can tell them apart from an empty mapping. */
type Block =
  | { readonly kind: "plain"; readonly content: string }
  | { readonly kind: "yaml"; readonly data: unknown; readonly content: string }
  | { readonly kind: "yaml_error"; readonly message: string; readonly content: string };

const parseBlock = (raw: string): Block => {
  const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const open = OPEN.exec(src);
  if (!open) return { kind: "plain", content: src };
  const afterOpen = src.slice(open[0].length);
  const close = CLOSE.exec(afterOpen);
  if (!close) return { kind: "plain", content: src };
  const yamlText = afterOpen.slice(0, close.index);
  const content = afterOpen.slice(close.index + close[0].length);
  try {
    return { kind: "yaml", data: yaml.load(yamlText, { schema: yaml.JSON_SCHEMA }), content };
  } catch (e) {
    return { kind: "yaml_error", message: (e as Error).message, content };
  }
};

/** Parse a raw engram file. Fails only when the YAML block itself is
 * malformed; anything else is data or content. */
export const parseFrontmatter = (raw: string): Result.Result<ParsedFrontmatter, string> => {
  const b = parseBlock(raw);
  return b.kind === "yaml_error"
    ? Result.fail(`invalid YAML: ${b.message}`)
    : Result.succeed({
        data: b.kind === "plain" ? {} : (b.data ?? {}),
        content: b.content,
      });
};

/** Render a file: YAML frontmatter above the body. Inverse of parse. */
export const stringifyFrontmatter = (
  content: string,
  data: Readonly<Record<string, unknown>>,
): string => {
  const y = yaml.dump(data, { schema: yaml.JSON_SCHEMA, quotingType: '"' });
  return `---\n${y}---\n${content}`;
};

/* ------------------------------------------------------------------ */
/* Staged entry validation                                             */
/* ------------------------------------------------------------------ */

/** Codes for entry-level defects (frontmatter syntax + semantics). A subset
 * of `StoreDiagnosticCode`; the store wraps these into full diagnostics. */
export type EntryIssueCode =
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
  /* ENG-13 lifecycle metadata; all entry-preventing except
   * updated_before_created (unchanged). */
  | "status_invalid"
  | "supersedes_invalid"
  | "self_supersession"
  | "review_after_invalid"
  | "expires_invalid"
  | "source_type_invalid"
  | "source_ref_invalid";

/** One entry defect without file/scope context (added by the store). */
export interface EntryIssue {
  readonly code: EntryIssueCode;
  readonly message: string;
  readonly hint: string;
}

/** Safely decoded fragments, kept even when the entry as a whole is invalid,
 * for cross-file checks (duplicate ids, filename consistency, scope,
 * dangling-supersedes warnings). */
export interface PartialFrontmatter {
  /** the id when it decoded as a string, even when malformed */
  readonly id: string | undefined;
  /** the title when it is a non-empty string */
  readonly title: string | undefined;
  /** the scope when it is a valid scope literal */
  readonly scope: Scope | undefined;
  /** the supersedes id when it decoded as a valid id, even when another
   * field makes the entry invalid */
  readonly supersedes: string | undefined;
}

export interface ValidatedEntry {
  /** Fully valid frontmatter; undefined when any entry-preventing issue was
   * found. A lifecycle-only defect (`updated_before_created`) keeps the
   * entry usable: it is diagnosed, not hidden. */
  readonly frontmatter: Frontmatter | undefined;
  /** Unknown top-level keys with their parsed values, kept so mediated
   * rewrites do not delete user metadata. Known keys are never part of this
   * set. Empty when the block has no unknown keys. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
  /** Every issue found, in a fixed check order. */
  readonly issues: ReadonlyArray<EntryIssue>;
  readonly partial: PartialFrontmatter;
}

/** The v0.4 required fields (the README is corrected to match). */
const REQUIRED_FIELDS = ["id", "title", "type", "tags", "scope", "created", "updated"] as const;

/** Every top-level frontmatter key the engram schema decodes. Keys outside
 * this set are user metadata: preserved verbatim across rewrites, never
 * validated, and never allowed to shadow a known field. */
export const KNOWN_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_FIELDS,
  "author",
  "pinned",
  "status",
  "supersedes",
  "reviewAfter",
  "expires",
  "sourceType",
  "sourceRef",
]);

/** The unknown top-level keys of a parsed frontmatter mapping: user metadata
 * that must survive a mediated rewrite. Known keys are excluded by name, so
 * a preserved value can never be re-emitted as a known field. */
export const unknownFrontmatterFields = (
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) out[key] = value;
  }
  return out;
};

/** Merge preserved unknown metadata under canonical known fields. Known
 * fields always win: metadata can add keys, never override or forge one. */
export const mergeUnknownFields = (
  canonical: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...canonical };
  if (metadata === undefined) return out;
  for (const [key, value] of Object.entries(metadata)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) out[key] = value;
  }
  return out;
};

type RequiredField = (typeof REQUIRED_FIELDS)[number];

const REQUIRED_HINTS: Record<RequiredField, string> = {
  id: 'Add an "id" line: four digits (legacy, e.g. 0001) or 26 lowercase base32 characters, as written by `engram add`.',
  title: 'Add a non-empty "title" line.',
  type: 'Add a "type" line: decision, fact, preference, note, issue, or context.',
  tags: "Add a `tags` list of strings, e.g. `tags: [deps, auth]`.",
  scope: 'Add a "scope" line: personal or project.',
  created: 'Add a "created" ISO 8601 timestamp, e.g. `created: 2025-08-15T10:00:00.000Z`.',
  updated: 'Add an "updated" ISO 8601 timestamp, e.g. `updated: 2025-08-15T10:00:00.000Z`.',
};

const FIELD_TYPE_HINTS: Record<string, string> = {
  id: 'Set "id" to a string (four digits or 26 lowercase base32 characters).',
  title: 'Set "title" to a string.',
  tags: "Write tags as a YAML list of strings, e.g. `tags: [deps, auth]`.",
  author: 'Set "author" to a string, or remove the line.',
  pinned: 'Set "pinned" to true or false, or remove the line.',
};

const describeValue = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "a sequence" : `a ${typeof v}`;

const quote = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? describeValue(v) : s;
};

const fieldTypeIssue = (name: string, expected: string, got: unknown): EntryIssue => ({
  code: "field_type_invalid",
  message: `field "${name}" must be ${expected}, got ${describeValue(got)}`,
  hint: FIELD_TYPE_HINTS[name] ?? `Fix or remove the "${name}" field.`,
});

const timestampIssue = (
  name: "created" | "updated" | "reviewAfter" | "expires",
  value: unknown,
): EntryIssue => ({
  code:
    name === "created"
      ? "created_invalid"
      : name === "updated"
        ? "updated_invalid"
        : name === "reviewAfter"
          ? "review_after_invalid"
          : "expires_invalid",
  message: `"${name}" is not an ISO 8601 timestamp with zone: ${quote(value)}`,
  hint: `Use the UTC form engram writes, e.g. \`${name}: 2026-01-01T00:00:00.000Z\`.`,
});

const NO_PARTIAL: PartialFrontmatter = {
  id: undefined,
  title: undefined,
  scope: undefined,
  supersedes: undefined,
};

/**
 * Validate one raw entry file: syntax, required fields, field semantics, and
 * lifecycle consistency. Collects every safe issue in one pass (partial
 * values survive for cross-file checks) instead of stopping at the first
 * defect; a single-error view hides duplicate ids and slows repair loops.
 */
export const validateEntry = (raw: string): ValidatedEntry => {
  const block = parseBlock(raw);
  if (block.kind === "yaml_error") {
    return {
      frontmatter: undefined,
      metadata: {},
      content: block.content,
      issues: [
        {
          code: "yaml_invalid",
          message: `invalid YAML: ${block.message}`,
          hint: "Fix the YAML syntax inside the frontmatter block.",
        },
      ],
      partial: NO_PARTIAL,
    };
  }
  if (block.kind === "plain") {
    // Covers both "no frontmatter" and an unterminated opening block.
    return {
      frontmatter: undefined,
      metadata: {},
      content: block.content,
      issues: [
        {
          code: "frontmatter_missing",
          message: "no YAML frontmatter block found",
          hint: `Start the file with a --- delimited block containing the required fields: ${REQUIRED_FIELDS.join(", ")}.`,
        },
      ],
      partial: NO_PARTIAL,
    };
  }
  const data = block.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      frontmatter: undefined,
      metadata: {},
      content: block.content,
      issues: [
        {
          code: "frontmatter_not_object",
          message: `frontmatter must be a mapping of fields, got ${describeValue(data)}`,
          hint: "Write field lines like `title: My note` instead of a bare scalar or list.",
        },
      ],
      partial: NO_PARTIAL,
    };
  }

  const fm = data as Record<string, unknown>;
  const issues: Array<EntryIssue> = [];

  // A YAML null (empty value) counts as missing for every check below.
  const field = (name: string): unknown => {
    const value = fm[name];
    return value === null || value === undefined ? undefined : value;
  };

  for (const name of REQUIRED_FIELDS) {
    if (field(name) === undefined) {
      issues.push({
        code: "required_field_missing",
        message: `required field "${name}" is missing`,
        hint: REQUIRED_HINTS[name],
      });
    }
  }

  const id = field("id");
  let partialId: string | undefined;
  if (id !== undefined) {
    if (typeof id === "string") {
      partialId = id;
      if (!isValidId(id)) {
        issues.push({
          code: "id_invalid",
          message: `id ${quote(id)} is not a valid engram id`,
          hint: "Ids are four digits (legacy, e.g. 0001) or 26 lowercase base32 characters, as written by `engram add`.",
        });
      }
    } else {
      issues.push(fieldTypeIssue("id", "a string", id));
    }
  }

  const title = field("title");
  let partialTitle: string | undefined;
  if (title !== undefined) {
    if (typeof title === "string") {
      if (title.trim() === "") {
        issues.push({
          code: "title_invalid",
          message: "title is empty",
          hint: 'Set "title" to a non-empty string.',
        });
      } else {
        partialTitle = title;
      }
    } else {
      issues.push(fieldTypeIssue("title", "a string", title));
    }
  }

  const type = field("type");
  if (type !== undefined && !ENGRAM_TYPES.includes(type as EngramType)) {
    issues.push({
      code: "type_invalid",
      message: `unknown type ${quote(type)}`,
      hint: `Use one of: ${ENGRAM_TYPES.join(", ")}.`,
    });
  }

  const tags = field("tags");
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) {
    issues.push(fieldTypeIssue("tags", "a list of strings", tags));
  }

  const scope = field("scope");
  let partialScope: Scope | undefined;
  if (scope !== undefined) {
    if (scope === "personal" || scope === "project") {
      partialScope = scope;
    } else {
      issues.push({
        code: "scope_invalid",
        message: `unknown scope ${quote(scope)}`,
        hint: 'Set "scope" to "personal" or "project".',
      });
    }
  }

  const author = field("author");
  if (author !== undefined && typeof author !== "string") {
    issues.push(fieldTypeIssue("author", "a string", author));
  }

  const pinned = field("pinned");
  if (pinned !== undefined && typeof pinned !== "boolean") {
    issues.push(fieldTypeIssue("pinned", "true or false", pinned));
  }

  /* ENG-13 lifecycle metadata. All defects here are entry-preventing: a
   * value that fails its contract must not silently become an Engram. */
  const status = field("status");
  if (status !== undefined && !ENGRAM_STATUSES.includes(status as Status)) {
    issues.push({
      code: "status_invalid",
      message: `unknown status ${quote(status)}`,
      hint: `Use one of: ${ENGRAM_STATUSES.join(", ")}.`,
    });
  }

  const supersedes = field("supersedes");
  let partialSupersedes: string | undefined;
  if (supersedes !== undefined) {
    if (typeof supersedes === "string" && isValidId(supersedes)) {
      partialSupersedes = supersedes;
      if (typeof id === "string" && supersedes === id) {
        issues.push({
          code: "self_supersession",
          message: `supersedes ${quote(supersedes)} points at this entry itself`,
          hint: 'Point "supersedes" at the older entry this one replaces.',
        });
      }
    } else {
      issues.push({
        code: "supersedes_invalid",
        message: `supersedes ${quote(supersedes)} is not a valid engram id`,
        hint: "Ids are four digits (legacy, e.g. 0001) or 26 lowercase base32 characters, as written by `engram add`.",
      });
    }
  }

  const reviewAfter = field("reviewAfter");
  if (reviewAfter !== undefined) {
    if (typeof reviewAfter === "string") {
      if (parseTimestamp(reviewAfter) === undefined) {
        issues.push(timestampIssue("reviewAfter", reviewAfter));
      }
    } else {
      issues.push(timestampIssue("reviewAfter", reviewAfter));
    }
  }

  const expires = field("expires");
  if (expires !== undefined) {
    if (typeof expires === "string") {
      if (parseTimestamp(expires) === undefined) {
        issues.push(timestampIssue("expires", expires));
      }
    } else {
      issues.push(timestampIssue("expires", expires));
    }
  }

  const sourceType = field("sourceType");
  if (sourceType !== undefined && !SOURCE_TYPES.includes(sourceType as SourceType)) {
    issues.push({
      code: "source_type_invalid",
      message: `unknown source type ${quote(sourceType)}`,
      hint: `Use one of: ${SOURCE_TYPES.join(", ")}.`,
    });
  }

  const sourceRef = field("sourceRef");
  if (sourceRef !== undefined && (typeof sourceRef !== "string" || sourceRef.trim() === "")) {
    issues.push({
      code: "source_ref_invalid",
      message: `"sourceRef" is empty`,
      hint: 'Set "sourceRef" to a non-empty string, or remove the line.',
    });
  }

  const created = field("created");
  let createdMs: number | undefined;
  if (created !== undefined) {
    if (typeof created === "string") {
      createdMs = parseTimestamp(created);
      if (createdMs === undefined) issues.push(timestampIssue("created", created));
    } else {
      issues.push(timestampIssue("created", created));
    }
  }

  const updated = field("updated");
  let updatedMs: number | undefined;
  if (updated !== undefined) {
    if (typeof updated === "string") {
      updatedMs = parseTimestamp(updated);
      if (updatedMs === undefined) issues.push(timestampIssue("updated", updated));
    } else {
      issues.push(timestampIssue("updated", updated));
    }
  }

  // Lifecycle consistency: both timestamps are individually valid here, so
  // this is a relation defect: diagnosed, but the entry stays usable.
  if (createdMs !== undefined && updatedMs !== undefined && updatedMs < createdMs) {
    issues.push({
      code: "updated_before_created",
      message: `"updated" (${quote(updated)}) precedes "created" (${quote(created)})`,
      hint: 'Set "updated" to the same time as "created" or later; an entry cannot be edited before it exists.',
    });
  }

  // Entry-preventing issues are everything except the lifecycle relation.
  const hard = issues.some((i) => i.code !== "updated_before_created");
  const frontmatter: Frontmatter | undefined = hard
    ? undefined
    : {
        id: id as string,
        title: title as string,
        type: type as EngramType,
        tags: tags as ReadonlyArray<string>,
        scope: scope as Scope,
        created: created as string,
        updated: updated as string,
        author: author as string | undefined,
        pinned: pinned as boolean | undefined,
        status: status as Status | undefined,
        supersedes: supersedes as string | undefined,
        reviewAfter: reviewAfter as string | undefined,
        expires: expires as string | undefined,
        sourceType: sourceType as SourceType | undefined,
        sourceRef: sourceRef as string | undefined,
      };

  return {
    frontmatter,
    metadata: unknownFrontmatterFields(fm),
    content: block.content,
    issues,
    partial: {
      id: partialId,
      title: partialTitle,
      scope: partialScope,
      supersedes: partialSupersedes,
    },
  };
};
