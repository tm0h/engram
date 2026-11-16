import type { Engram } from "./domain.js";
import { effectiveStatus } from "./domain.js";
import { normalizeText, tokenizeQuery } from "./tokenize.js";
import type { SearchResult, SearchOptions, ScoreContribution } from "./search.js";

const DAY = 86_400_000;
const sortResults = (a: SearchResult, b: SearchResult): number =>
  b.score - a.score || a.engram.id.localeCompare(b.engram.id);

function adjust(
  result: SearchResult,
  field: ScoreContribution["field"],
  token: string | null,
  points: number,
  explain: boolean,
): SearchResult {
  if (points === 0) return result;
  return {
    engram: result.engram,
    score: result.score + points,
    ...(explain
      ? {
          explanation: {
            mode: "relevance" as const,
            contributions: [
              ...(result.explanation?.contributions ?? []),
              { field, token, score: points, component: "metadata" as const },
            ],
          },
        }
      : {}),
  };
}

const words = (text: string): Set<string> => new Set(tokenizeQuery(text));
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}
interface Fingerprint {
  entry: Engram;
  title: Set<string>;
  body: Set<string>;
}
// Large bodies have bounded duplicate-comparison cost; never silently compare
// only a prefix, since omitted content can contain distinct required facts.
function fingerprint(entry: Engram): Fingerprint | undefined {
  if (entry.body.length > 16_384 || entry.title.length > 1024) return undefined;
  const body = words(normalizeText(entry.body));
  if (body.size < 8) return undefined;
  return { entry, title: words(normalizeText(entry.title)), body };
}
function duplicates(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.entry.scope === b.entry.scope &&
    a.entry.type === b.entry.type &&
    similarity(a.title, b.title) >= 0.8 &&
    similarity(a.body, b.body) >= 0.9
  );
}

/** Post-retrieval signals cannot admit a memory or bypass lexical abstention.
 * Freshness is a bounded bonus for transient types, never an age penalty on
 * durable knowledge. Paths have already passed the search eligibility gate. */
export function rankMetadata(
  results: ReadonlyArray<SearchResult>,
  options: SearchOptions,
): SearchResult[] {
  const now = options.now ?? Date.now();
  const explain = options.explain === true;
  const ranked = results
    .map((result) => {
      const m = result.engram;
      let next = result;
      if (effectiveStatus(m, now) !== "active") return next;
      if (Number.isInteger(m.importance) && m.importance! >= 0 && m.importance! <= 5)
        next = adjust(next, "importance", null, m.importance! * 0.1, explain);
      if (options.currentPath !== undefined && m.appliesTo?.length)
        next = adjust(next, "applicability", null, 0.25, explain);
      if (m.type === "note" || m.type === "issue") {
        const age = now - Date.parse(m.updated);
        // Future/invalid timestamps are not evidence of freshness.
        if (Number.isFinite(age) && age >= 0 && age < 30 * DAY)
          next = adjust(next, "freshness", m.type, 0.25 * (1 - age / (30 * DAY)), explain);
      }
      return next;
    })
    .sort(sortResults);

  const representatives: Fingerprint[] = [];
  const unique: SearchResult[] = [];
  const repeated: SearchResult[] = [];
  for (const result of ranked) {
    const candidate = fingerprint(result.engram);
    if (candidate && representatives.some((rep) => duplicates(candidate, rep)))
      repeated.push(result);
    else {
      unique.push(result);
      // Bound comparisons independently of store size. The first 64 diverse
      // results cover the search budget; later entries remain eligible.
      if (candidate && representatives.length < 64) representatives.push(candidate);
    }
  }
  if (!repeated.length) return ranked;
  const floor = unique[unique.length - 1]!.score;
  const demoted = repeated.map((result) =>
    adjust(
      result,
      "diversification",
      null,
      Math.min(result.score / 2, floor / 2) - result.score,
      explain,
    ),
  );
  return [...unique, ...demoted].sort(sortResults);
}
