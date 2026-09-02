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

/** The only config schema version this release understands. Configs with a
 * different version load as data but fail integrity validation. */
export const SUPPORTED_CONFIG_VERSION = 1;

export const ProjectConfigSchema = Schema.Struct({
  version: Schema.Number,
  tracked: Schema.Boolean,
  defaultType: EngramTypeSchema,
  author: Schema.optional(Schema.String),
});
export type ProjectConfig = Schema.Schema.Type<typeof ProjectConfigSchema>;

/** Automatic context injection on/off toggle (global user setting). */
export const AutoContextToggleSchema = Schema.Literals(["on", "off"]);
export type AutoContextToggle = Schema.Schema.Type<typeof AutoContextToggleSchema>;

/** Which scopes the automatic startup digest covers (global user setting). */
export const AutoContextScopeSchema = Schema.Literals(["project", "personal", "both"]);
export type AutoContextScope = Schema.Schema.Type<typeof AutoContextScopeSchema>;

/** Valid `autoContextScope` values (mirrors the ENGRAM_TYPES pattern). */
export const AUTO_CONTEXT_SCOPES: ReadonlyArray<AutoContextScope> = ["project", "personal", "both"];

/** How many entries the automatic startup digest includes (global user setting). */
export const AUTO_CONTEXT_LIMIT_MIN = 1;
export const AUTO_CONTEXT_LIMIT_MAX = 100;
export const AutoContextLimitSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(
    Schema.isBetween({ minimum: AUTO_CONTEXT_LIMIT_MIN, maximum: AUTO_CONTEXT_LIMIT_MAX }),
  ),
);
export type AutoContextLimit = Schema.Schema.Type<typeof AutoContextLimitSchema>;

export const GlobalConfigSchema = Schema.Struct({
  version: Schema.Number,
  author: Schema.optional(Schema.String),
  editor: Schema.optional(Schema.String),
  autoContext: Schema.optional(AutoContextToggleSchema),
  autoContextScope: Schema.optional(AutoContextScopeSchema),
  autoContextLimit: Schema.optional(AutoContextLimitSchema),
});
export type GlobalConfig = Schema.Schema.Type<typeof GlobalConfigSchema>;

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  version: SUPPORTED_CONFIG_VERSION,
  tracked: true,
  defaultType: "note",
};

export const DEFAULT_AUTO_CONTEXT: AutoContextToggle = "on";
export const DEFAULT_AUTO_CONTEXT_SCOPE: AutoContextScope = "project";
export const DEFAULT_AUTO_CONTEXT_LIMIT: AutoContextLimit = 25;

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  version: 1,
  editor: undefined,
  autoContext: DEFAULT_AUTO_CONTEXT,
  autoContextScope: DEFAULT_AUTO_CONTEXT_SCOPE,
  autoContextLimit: DEFAULT_AUTO_CONTEXT_LIMIT,
};
