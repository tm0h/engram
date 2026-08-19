/** Serializable types shared by every harness adapter (pi tools, CLI, …). */
import type { EngramType, Scope } from "@engram/core";

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
}

export interface InitOptions {
  readonly tracked: boolean;
}
