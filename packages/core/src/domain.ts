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

/** Lifecycle status of an entry. Absence is not serialized (old files have
 * no `status` key); consumers may treat absence as `active` when they need
 * an effective status. `expired` is deliberately not a status: expiry is
 * time-derived from `expires`. */
export const StatusSchema = Schema.Literals(["active", "superseded", "archived"]);
export type Status = Schema.Schema.Type<typeof StatusSchema>;

/** Valid `status` values (mirrors the ENGRAM_TYPES pattern). */
export const ENGRAM_STATUSES: ReadonlyArray<Status> = ["active", "superseded", "archived"];

/** Shape of the evidence a memory came from. Describes evidence shape only;
 * it never establishes truth or authority. */
export const SourceTypeSchema = Schema.Literals([
  "conversation",
  "file",
  "url",
  "command",
  "other",
]);
export type SourceType = Schema.Schema.Type<typeof SourceTypeSchema>;

/** Valid `sourceType` values (mirrors the ENGRAM_TYPES pattern). */
export const SOURCE_TYPES: ReadonlyArray<SourceType> = [
  "conversation",
  "file",
  "url",
  "command",
  "other",
];

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
  /* ENG-13 lifecycle metadata: all optional, no serialized defaults. Old
   * v0.4 files keep decoding without these keys. */
  status: Schema.optional(StatusSchema),
  /** id of the older entry this one replaces. */
  supersedes: Schema.optional(Schema.String),
  /** ISO 8601 timestamp with explicit zone (same contract as created/updated). */
  reviewAfter: Schema.optional(Schema.String),
  /** ISO 8601 timestamp with explicit zone (same contract as created/updated). */
  expires: Schema.optional(Schema.String),
  sourceType: Schema.optional(SourceTypeSchema),
  /** Non-empty reference for the source (path, URL, command, conversation). */
  sourceRef: Schema.optional(Schema.String),
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
  /* ENG-13 lifecycle metadata. Absence (undefined) stays undefined; no
   * default is ever serialized. */
  readonly status?: Status | undefined;
  readonly supersedes?: string | undefined;
  readonly reviewAfter?: string | undefined;
  readonly expires?: string | undefined;
  readonly sourceType?: SourceType | undefined;
  readonly sourceRef?: string | undefined;
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
  /* ENG-13 lifecycle metadata (optional; absent means "not set"). */
  readonly status?: Status | undefined;
  readonly supersedes?: string | undefined;
  readonly reviewAfter?: string | undefined;
  readonly expires?: string | undefined;
  readonly sourceType?: SourceType | undefined;
  readonly sourceRef?: string | undefined;
}

/** Partial changes to an existing engram (see EngramStore.update).
 * Undefined fields keep their current value; there is deliberately no
 * clearing representation yet (planned as paired CLI clear flags). */
export interface EngramPatch {
  readonly title?: string;
  readonly type?: EngramType;
  readonly tags?: ReadonlyArray<string>;
  readonly body?: string;
  readonly pinned?: boolean;
  readonly author?: string;
  /* ENG-13 lifecycle metadata; same undefined-means-unchanged rule. */
  readonly status?: Status | undefined;
  readonly supersedes?: string | undefined;
  readonly reviewAfter?: string | undefined;
  readonly expires?: string | undefined;
  readonly sourceType?: SourceType | undefined;
  readonly sourceRef?: string | undefined;
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
