/** Public search summaries. Explicit allowlist: never serialize stored bodies or paths. */
import { rankEntries } from "./rank.js";
import { parseQuery } from "./query.js";
import { normalizeText } from "./tokenize.js";
import { matchingSnippet } from "./snippets.js";
import type { Engram } from "./domain.js";
import type { SearchExplanation, SearchResult } from "./search.js";

export interface SearchSummary extends Pick<
  Engram,
  "id" | "scope" | "title" | "type" | "tags" | "updated" | "pinned"
> {
  readonly score: number;
  readonly snippet: string | null;
  readonly relevance: string;
  readonly explanation?: SearchExplanation;
}

export interface SearchReport {
  readonly schemaVersion: 1;
  readonly query: string;
  readonly results: ReadonlyArray<SearchSummary>;
  readonly total: number;
  readonly offset: number;
  /** Null means uncapped. */
  readonly limit: number | null;
  readonly nextOffset: number | null;
}

export function searchPaginationError(offset: number, limit?: number): string | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0)
    return "offset must be a nonnegative safe integer";
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    return "limit must be a positive safe integer";
  return undefined;
}

/** Compact reasons use the same lexical matcher without changing retrieval scores. */
export function searchRelevance(m: Engram, query: string): string {
  const parsed = parseQuery(query);
  if (!parsed.alternatives.length) return "Recency order";
  const fields = [
    ...new Set(
      rankEntries([m], parsed, { explain: true })[0]
        ?.explanation?.contributions.filter((c) => c.component !== "pinned")
        .map((c) => c.field) ?? [],
    ),
  ];
  const plain = parsed.alternatives.every(
    (a) => a.length === 1 && a[0]!.kind === "word" && !a[0]!.field,
  );
  if (plain && m.triggers?.some((t) => normalizeText(t.trim()) === normalizeText(query.trim())))
    fields.push("trigger");
  return fields.length ? `Matched ${fields.join(", ")}` : "Pinned entry; no lexical body match";
}

/** Takes globally ranked results and slices before producing public summaries. */
export function searchReport(
  ranked: ReadonlyArray<SearchResult>,
  query: string,
  offset = 0,
  limit?: number,
): SearchReport {
  const error = searchPaginationError(offset, limit);
  if (error) throw new RangeError(error);
  const page = ranked.slice(offset, limit === undefined ? undefined : offset + limit);
  return {
    schemaVersion: 1,
    query,
    total: ranked.length,
    offset,
    limit: limit ?? null,
    nextOffset:
      page.length > 0 && offset + page.length < ranked.length ? offset + page.length : null,
    results: page.map(({ engram: m, score, explanation }) => ({
      id: m.id,
      scope: m.scope,
      title: m.title,
      type: m.type,
      tags: m.tags,
      updated: m.updated,
      pinned: m.pinned,
      score,
      snippet: matchingSnippet(m.body, query),
      relevance: searchRelevance(m, query),
      ...(explanation ? { explanation } : {}),
    })),
  };
}

/** Plain-text opt-in explanation. JSON-quote user strings to avoid multiline ambiguity. */
export function renderSearchExplanation(report: SearchReport): string {
  const lines = report.results.map((r) => {
    const why =
      r.explanation?.mode === "recency"
        ? "recency order"
        : r.explanation?.contributions
            .map(
              (c) =>
                `${c.field}${c.token === null ? "" : ` ${JSON.stringify(c.token)}`} +${c.score}`,
            )
            .join(", ");
    return `${r.scope}:${r.id} ${JSON.stringify(r.title)} score=${r.score}\n  ${why ?? r.relevance}${r.snippet === null ? "" : `\n  ${JSON.stringify(r.snippet)}`}`;
  });
  if (lines.length === 0) lines.push("(no matches on this page)");
  lines.push(
    `total=${report.total} offset=${report.offset} limit=${report.limit ?? "all"} nextOffset=${report.nextOffset ?? "none"}`,
  );
  return lines.join("\n");
}
