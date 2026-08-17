/**
 * Domain model for engram, defined with `effect/Schema`.
 */
import { Schema } from "effect";

/** The kind of thing an engram records. */
export const EngramTypeSchema = Schema.Literals([
  "decision",
  "fact",
  "preference",
  "note",
  "issue",
  "context",
]);
export type EngramType = Schema.Schema.Type<typeof EngramTypeSchema>;

export const ENGRAM_TYPES: ReadonlyArray<EngramType> = [
  "decision",
  "fact",
  "preference",
  "note",
  "issue",
  "context",
];

/** Where an engram lives. */
export const ScopeSchema = Schema.Literals(["personal", "project"]);
export type Scope = Schema.Schema.Type<typeof ScopeSchema>;

/** Raw frontmatter as read from an engram Markdown file.
 *
 * `id`: ULID-style (26 lowercase base32 chars — see `newId`) for new
 * engrams; legacy 4-digit numeric ids ("0001") remain valid. Both are
 * unique-per-store by contract; duplicates are a repairable defect
 * (see `EngramStore.dedupe`). */
export const FrontmatterSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  type: EngramTypeSchema,
  tags: Schema.Array(Schema.String),
  scope: ScopeSchema,
  created: Schema.String,
  updated: Schema.String,
  author: Schema.optional(Schema.String),
  pinned: Schema.optional(Schema.Boolean),
});
export type Frontmatter = Schema.Schema.Type<typeof FrontmatterSchema>;

/** A fully-parsed engram entry. */
export interface Engram {
  readonly id: string;
  readonly title: string;
  readonly type: EngramType;
  readonly tags: ReadonlyArray<string>;
  readonly scope: Scope;
  readonly created: string;
  readonly updated: string;
  readonly author: string | undefined;
  readonly pinned: boolean;
  readonly body: string;
  /** absolute path to the source file */
  readonly path: string;
}

export interface EngramInput {
  readonly title: string;
  readonly type: EngramType;
  readonly tags: ReadonlyArray<string>;
  readonly body: string;
  readonly pinned: boolean;
  readonly author: string | undefined;
}

/** Partial changes to an existing engram (see EngramStore.update).
 * Undefined fields keep their current value. */
export interface EngramPatch {
  readonly title?: string;
  readonly type?: EngramType;
  readonly tags?: ReadonlyArray<string>;
  readonly body?: string;
  readonly pinned?: boolean;
  readonly author?: string;
}

/* ------------------------------------------------------------------ */
/* Configuration schemas                                               */
/* ------------------------------------------------------------------ */

export const ProjectConfigSchema = Schema.Struct({
  version: Schema.Number,
  tracked: Schema.Boolean,
  defaultType: EngramTypeSchema,
  author: Schema.optional(Schema.String),
});
export type ProjectConfig = Schema.Schema.Type<typeof ProjectConfigSchema>;

export const GlobalConfigSchema = Schema.Struct({
  version: Schema.Number,
  author: Schema.optional(Schema.String),
  editor: Schema.optional(Schema.String),
});
export type GlobalConfig = Schema.Schema.Type<typeof GlobalConfigSchema>;

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  version: 1,
  tracked: true,
  defaultType: "note",
};

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  version: 1,
  editor: undefined,
};
