/** Serializable types shared by every harness adapter (pi tools, CLI, …). */
import type { EngramType, Scope, SourceType, Status } from "@engram/core";

/** Scope selection for read ops: one scope or both. */
export type ScopeFilter = Scope | "both";

/** One digest line's data. */
export interface EngramLine {
  readonly id: string;
  readonly title: string;
  readonly type: EngramType;
  readonly tags: ReadonlyArray<string>;
  readonly pinned: boolean;
  readonly scope: Scope;
  readonly updated: string;
}

/**
 * The universal operation result. Everything a harness tool needs:
 * `text` is the fully rendered, plain-text (no ANSI) payload for the LLM;
 * `details` carries machine-readable metadata (pagination, ids, errors).
 */
export interface OpResult {
  readonly text: string;
  readonly isError: boolean;
  readonly details: Record<string, unknown>;
}

export interface ContextOptions {
  readonly scope?: ScopeFilter;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SearchOptions {
  readonly query: string;
  readonly explain?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  readonly scope?: ScopeFilter;
}

export interface ShowOptions {
  readonly id: string;
  readonly scope?: Scope;
  readonly offset?: number;
  readonly limit?: number;
}

export interface AddOptions {
  readonly title: string;
  readonly body: string;
  readonly type?: EngramType;
  readonly scope?: Scope;
  readonly tags?: ReadonlyArray<string>;
  readonly pinned?: boolean;
  readonly author?: string;
  /* Optional lifecycle metadata. Only the closed enums are checked here;
   * timestamp, id, and sourceRef semantics are enforced by the store write
   * boundary (undefined stays "unset"; there is no clear instruction on an
   * add surface). */
  readonly status?: Status;
  readonly supersedes?: string;
  readonly reviewAfter?: string;
  readonly expires?: string;
  readonly sourceType?: SourceType;
  readonly sourceRef?: string;
}

/** Edit an existing engram (see EngramPatch for the exact contract).
 *
 * Ordinary fields (title, type, tags, body, pinned, author): omitted means
 * unchanged. The six lifecycle fields are three-state: omitted/undefined
 * preserves, `null` clears (the YAML key disappears), a concrete value
 * replaces. Only the closed enums (type, status, sourceType) are checked
 * here; timestamp, id, and sourceRef semantics stay at the store write
 * boundary. */
export interface EditOptions {
  readonly id: string;
  readonly scope?: Scope;
  readonly title?: string;
  readonly type?: EngramType;
  readonly tags?: ReadonlyArray<string>;
  readonly body?: string;
  readonly pinned?: boolean;
  readonly author?: string;
  readonly status?: Status | null;
  readonly supersedes?: string | null;
  readonly reviewAfter?: string | null;
  readonly expires?: string | null;
  readonly sourceType?: SourceType | null;
  readonly sourceRef?: string | null;
}

export interface InitOptions {
  readonly tracked: boolean;
}
