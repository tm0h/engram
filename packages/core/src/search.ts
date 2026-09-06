/**
 * Lightweight, dependency-free relevance search.
 *
 * Scoring (per query token):
 *   tag exact match    +5
 *   title contains     +3
 *   type matches       +2
 *   body contains      +1
 * Pinned engrams get a small boost.
 *
 * This is intentionally simple and fast. Semantic/embedding search can be
 * layered behind the same interface later.
 *
 * Queries and indexed fields are folded with `normalizeText` from
 * `./tokenize.js` (ENG-21), so matching is Unicode-normalization safe on
 * both sides; queries are expanded with `tokenizeQuery` (camelCase,
 * snake_case, paths, and so on).
 */
import type { Engram } from "./domain.js";
import { effectiveStatus } from "./domain.js";
import { normalizeText, tokenizeQuery } from "./tokenize.js";

export interface SearchResult {
  readonly engram: Engram;
  readonly score: number;
}

/** ENG-17 options (4th, optional parameter — fully backward compatible).
 * `includeInactive`: re-include superseded/archived/expired entries (the
 * default excludes them). `now`: check time for expiry, for deterministic
 * tests; defaults to `Date.now()`. */
export interface SearchOptions {
  readonly includeInactive?: boolean;
  readonly now?: number;
}

function scoreEngram(m: Engram, tokens: ReadonlyArray<string>): number {
  let score = 0;
  const title = normalizeText(m.title);
  const body = normalizeText(m.body);
  const type = normalizeText(m.type);
  const tags = m.tags.map((t) => normalizeText(t));
  for (const t of tokens) {
    if (tags.includes(t)) score += 5;
    if (title.includes(t)) score += 3;
    if (type === t) score += 2;
    if (body.includes(t)) score += 1;
  }
  if (m.pinned) score += 0.5;
  return score;
}

/** Search engrams. With no query, returns all sorted by recency.
 *
 * ENG-17: inactive entries (explicit superseded/archived status, or `expires`
 * at or before `now`) are excluded by default; pass `{ includeInactive: true }`
 * to re-include them. Filtering runs before scoring and before limit slicing. */
export function searchEngrams(
  list: ReadonlyArray<Engram>,
  query: string | undefined,
  limit?: number,
  options: SearchOptions = {},
): SearchResult[] {
  const nowMs = options.now ?? Date.now();
  const candidates = options.includeInactive
    ? list
    : list.filter((m) => effectiveStatus(m, nowMs) === "active");
  const tokens = query ? tokenizeQuery(query) : [];
  let results: SearchResult[];
  if (tokens.length === 0) {
    results = candidates
      .map((engram) => ({ engram, score: 0 }))
      .sort(
        (a, b) =>
          b.engram.updated.localeCompare(a.engram.updated) ||
          a.engram.id.localeCompare(b.engram.id),
      );
  } else {
    results = candidates
      .map((engram) => ({ engram, score: scoreEngram(engram, tokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.engram.id.localeCompare(b.engram.id));
  }
  return typeof limit === "number" ? results.slice(0, limit) : results;
}
