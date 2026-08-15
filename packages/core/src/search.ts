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
 */
import type { Engram } from "./domain.js";
import { numericId } from "./util.js";

export interface SearchResult {
  readonly engram: Engram;
  readonly score: number;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function scoreEngram(m: Engram, tokens: ReadonlyArray<string>): number {
  let score = 0;
  const title = m.title.toLowerCase();
  const body = m.body.toLowerCase();
  const type = m.type.toLowerCase();
  const tags = m.tags.map((t) => t.toLowerCase());
  for (const t of tokens) {
    if (tags.includes(t)) score += 5;
    if (title.includes(t)) score += 3;
    if (type === t) score += 2;
    if (body.includes(t)) score += 1;
  }
  if (m.pinned) score += 0.5;
  return score;
}

/** Search engrams. With no query, returns all sorted by recency. */
export function searchEngrams(
  list: ReadonlyArray<Engram>,
  query: string | undefined,
  limit?: number,
): SearchResult[] {
  const tokens = query ? tokenize(query) : [];
  let results: SearchResult[];
  if (tokens.length === 0) {
    results = list
      .map((engram) => ({ engram, score: 0 }))
      .sort(
        (a, b) =>
          b.engram.updated.localeCompare(a.engram.updated) ||
          numericId(a.engram.id) - numericId(b.engram.id),
      );
  } else {
    results = list
      .map((engram) => ({ engram, score: scoreEngram(engram, tokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || numericId(a.engram.id) - numericId(b.engram.id));
  }
  return typeof limit === "number" ? results.slice(0, limit) : results;
}
