/**
 * Scope resolution helpers. These are pure functions that take the already-
 * resolved project-root option (from EngramStore.projectRoot) so they stay free
 * of filesystem requirements.
 */
import { Option } from "effect";
import type { Scope } from "./domain.js";

export type ScopeArg = Scope | "all";

/** Resolve an explicit scope arg, falling back to the default. */
export const resolveScope = (
  explicit: string | undefined,
  projectRoot: Option.Option<string>,
): Scope =>
  explicit === "personal"
    ? "personal"
    : explicit === "project"
      ? "project"
      : Option.isSome(projectRoot)
        ? "project"
        : "personal";

/** Expand a scope arg (including "all") into concrete scopes to query. */
export const scopesToQuery = (
  explicit: string | undefined,
  projectRoot: Option.Option<string>,
): ReadonlyArray<Scope> =>
  explicit === "all"
    ? Option.isSome(projectRoot)
      ? ["project", "personal"]
      : ["personal"]
    : [resolveScope(explicit, projectRoot)];
