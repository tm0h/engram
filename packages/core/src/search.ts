/**
 * Relevance search over engrams.
 *
 * ENG-18 default ranker: a BM25-style lexical scorer (see `./rank.js`) over
 * the title, tag, type, and body fields, with query syntax from
 * `./query.js` (phrases, bounded prefixes, field filters, AND/OR groups).
 * The legacy fixed-points ranker (tag +5, title +3, type +2, body +1,
 * pinned +0.5, substring matching) remains callable as `searchEngramsLegacy`
 * for the benchmark's same-corpus shadow comparison.
 *
 * Queries and indexed fields are folded with `normalizeText` from
 * `./tokenize.js` (ENG-21), so matching is Unicode-normalization safe on
 * both sides; plain word queries are expanded with `tokenizeQuery`
 * (camelCase, snake_case, paths, and so on).
 */
import type { Engram } from "./domain.js";
import { effectiveStatus } from "./domain.js";
import { normalizeText, tokenizeQuery } from "./tokenize.js";
import { parseQuery } from "./query.js";
import { rankEntries } from "./rank.js";

export interface SearchResult {
  readonly engram: Engram;
  readonly score: number;
  readonly explanation?: SearchExplanation;
}

/** Which scoring component produced a contribution (ENG-18). */
export type ScoreComponent = "bm25" | "phrase" | "prefix" | "pinned";

export interface ScoreContribution {
  readonly field: "tag" | "title" | "type" | "body" | "pinned";
  /** Normalized query token (or folded phrase text), not source text or a
   * source offset. */
  readonly token: string | null;
  readonly score: number;
  /** Present on BM25-ranker contributions; absent on legacy ones. */
  readonly component?: ScoreComponent;
}

export interface SearchExplanation {
  readonly mode: "relevance" | "recency";
  readonly contributions: ReadonlyArray<ScoreContribution>;
}

/** ENG-17 options (4th, optional parameter — fully backward compatible).
 * `includeInactive`: re-include superseded/archived/expired entries (the
 * default excludes them). `now`: check time for expiry, for deterministic
 * tests; defaults to `Date.now()`. */
export interface SearchOptions {
  readonly includeInactive?: boolean;
  readonly now?: number;
  readonly explain?: boolean;
}

function activeCandidates(list: ReadonlyArray<Engram>, options: SearchOptions): Engram[] {
  const nowMs = options.now ?? Date.now();
  return options.includeInactive
    ? [...list]
    : list.filter((m) => effectiveStatus(m, nowMs) === "active");
}

function recencyResults(candidates: ReadonlyArray<Engram>, explain: boolean): SearchResult[] {
  return candidates
    .map((engram) => ({
      engram,
      score: 0,
      ...(explain ? { explanation: { mode: "recency" as const, contributions: [] } } : {}),
    }))
    .sort(
      (a, b) =>
        b.engram.updated.localeCompare(a.engram.updated) || a.engram.id.localeCompare(b.engram.id),
    );
}

/** Search engrams with the default BM25-style ranker. With no query (or a
 * query with no searchable content), returns all sorted by recency.
 *
 * ENG-17: inactive entries (explicit superseded/archived status, or `expires`
 * at or before `now`) are excluded by default; pass `{ includeInactive: true }`
 * to re-include them. Filtering runs before scoring and before limit slicing.
 *
 * ENG-18 query syntax: `"exact phrase"` (contiguous boost), `stem*` (bounded
 * prefix, stem >= 2 chars), `tag:`/`title:`/`type:`/`body:` field filters
 * (hard requirements), and `AND` groups (default remains OR, decision D2). */
export function searchEngrams(
  list: ReadonlyArray<Engram>,
  query: string | undefined,
  limit?: number,
  options: SearchOptions = {},
): SearchResult[] {
  const candidates = activeCandidates(list, options);
  const parsed = query ? parseQuery(query) : undefined;
  let results: SearchResult[];
  if (parsed === undefined || parsed.alternatives.length === 0) {
    results = recencyResults(candidates, options.explain === true);
  } else {
    results = rankEntries(candidates, parsed, { explain: options.explain === true });
  }
  return typeof limit === "number" ? results.slice(0, limit) : results;
}

function scoreEngramLegacy(
  m: Engram,
  tokens: ReadonlyArray<string>,
  explain: boolean,
): SearchResult {
  let score = 0;
  const contributions: ScoreContribution[] | undefined = explain ? [] : undefined;
  const add = (field: ScoreContribution["field"], token: string | null, points: number) => {
    score += points;
    contributions?.push({ field, token, score: points });
  };
  const title = normalizeText(m.title);
  const body = normalizeText(m.body);
  const type = normalizeText(m.type);
  const tags = m.tags.map((t) => normalizeText(t));
  for (const t of tokens) {
    if (tags.includes(t)) add("tag", t, 5);
    if (title.includes(t)) add("title", t, 3);
    if (type === t) add("type", t, 2);
    if (body.includes(t)) add("body", t, 1);
  }
  if (m.pinned) add("pinned", null, 0.5);
  return {
    engram: m,
    score,
    ...(contributions ? { explanation: { mode: "relevance" as const, contributions } } : {}),
  };
}

/** The pre-ENG-18 ranker, retained verbatim for the benchmark's shadow
 * comparison (same-corpus old-vs-new evidence): fixed points per query
 * token (tag exact +5, title contains +3, type equals +2, body contains +1,
 * pinned +0.5) with substring matching over folded fields, OR of tokens via
 * the score > 0 filter, and id-ascending ties. Query parsing is the plain
 * tokenizeQuery token list: no phrase, prefix, field-filter, or AND syntax.
 * All other contracts (lifecycle filter, recency path, limit) match
 * `searchEngrams`. */
export function searchEngramsLegacy(
  list: ReadonlyArray<Engram>,
  query: string | undefined,
  limit?: number,
  options: SearchOptions = {},
): SearchResult[] {
  const candidates = activeCandidates(list, options);
  const tokens = query ? tokenizeQuery(query) : [];
  let results: SearchResult[];
  if (tokens.length === 0) {
    results = recencyResults(candidates, options.explain === true);
  } else {
    results = candidates
      .map((engram) => scoreEngramLegacy(engram, tokens, options.explain === true))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.engram.id.localeCompare(b.engram.id));
  }
  return typeof limit === "number" ? results.slice(0, limit) : results;
}
