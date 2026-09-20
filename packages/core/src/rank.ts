/**
 * ENG-18 BM25-style lexical ranker. Dependency-free, deterministic, and
 * pure: same candidates + same parsed query always yield the same ranked
 * results, with stable fixed-order float summation and id-ascending ties.
 *
 * Scoring model (Okapi BM25 per field, weighted sum over fields):
 *
 *   idf(t, f)  = ln(1 + (N - df + 0.5) / (df + 0.5))     [Lucene variant:
 *              always positive; df and N are per candidate set, per field]
 *   tfNorm     = tf / (tf + k1 * (1 - b + b * len_f / avgdl_f))
 *              with k1 = 1.2, b = 0.75
 *   points     = FIELD_WEIGHTS[f] * idf * tfNorm
 *
 * Field weights keep the legacy ranker's preference order (tag > title >
 * type > body). Entries get the legacy +0.5 pinned boost when pinned. The
 * boost may surface an otherwise unrelated entry for a plain query, but it
 * cannot bypass explicit field filters or AND requirements.
 *
 * Matching:
 * - word terms match a field by exact token equality, or, when the folded
 *   query token has at least 3 characters, by bounded prefix fallback (any
 *   document token starting with the token; preflight F4). The fallback
 *   restores the legacy substring ranker's recall for morphological
 *   variants like keybinding -> keybindings without unbounded prefixes;
 *   the 3-character minimum keeps short noisy tokens exact-only.
 * - prefix terms (`stem*`) match any field token starting with the folded
 *   stem (stem >= 2 characters, enforced by the parser).
 * - phrase terms score their words as ordinary tokens and add a contiguous
 *   occurrence bonus per field whose folded text contains the phrase.
 *
 * Extras on top of plain per-token BM25:
 * - phrase bonus: FIELD_WEIGHTS[f] * PHRASE_WEIGHT when the field's folded
 *   text contains the folded phrase contiguously;
 * - boolean semantics (query.ts): an entry is INCLUDED when every term of
 *   at least one OR-alternative matches. The legacy pinned inclusion quirk is
 *   kept only for plain, unscoped alternatives. SCORING always sums every
 *   matching term of every alternative, in fixed order, so ranking stays
 *   evidence-complete across the whole query.
 *
 * Explanations (contributions) are token-major, fields in the fixed order
 * tag, title, type, body, pinned last, and sum exactly to the score. They
 * carry normalized query tokens only, never source text or offsets.
 *
 * Performance notes (measured, see benchmark/shadow.ts): field folding has
 * an ASCII fast path (normalizeText is identity-plus-lowercase for ASCII,
 * per tokenize.ts); per-entry token lists are sorted once so term and
 * document frequencies are binary-search range counts; document frequency
 * is memoized per query instead of maintained with per-entry maps.
 */
import type { Engram } from "./domain.js";
import type { QueryTerm, SearchFieldName } from "./query.js";
import type { ParsedQuery } from "./query.js";
import { normalizeText } from "./tokenize.js";
import type { ScoreComponent, ScoreContribution, SearchResult } from "./search.js";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
/** Field weights: the legacy ranker's hierarchy (tag 5, title 3, type 2, body 1). */
export const FIELD_WEIGHTS: Record<SearchFieldName, number> = {
  tag: 5,
  title: 3,
  type: 2,
  body: 1,
};
/** Legacy pinned boost, kept for user-visible parity (preflight F3). */
export const PINNED_BOOST = 0.5;
/** Phrase bonus multiplier over the field weight. */
export const PHRASE_WEIGHT = 2;
/** Minimum folded length for a word token to fall back to prefix matching. */
export const PREFIX_FALLBACK_MIN = 3;

const FIELD_ORDER: ReadonlyArray<SearchFieldName> = ["tag", "title", "type", "body"];

const FIELD_SPLIT = /[^\p{L}\p{N}\p{M}]+/u;

/** ASCII fast path for field folding: `normalizeText` is documented as
 * identity-plus-lowercase for pure-ASCII input (ENG-21), and an ASCII scan
 * plus native toLowerCase is far cheaper than the per-character NFKD loop.
 * Unicode input takes the full fold; results are identical either way. */
function foldField(raw: string): string {
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 127) return normalizeText(raw);
  }
  return raw.toLowerCase();
}

/** Folded field text: tags join with spaces; everything else is the field. */
function fieldText(m: Engram, field: SearchFieldName): string {
  switch (field) {
    case "tag":
      return m.tags.join(" ");
    case "title":
      return m.title;
    case "type":
      return m.type;
    case "body":
      return m.body;
  }
}

/** Folded tokens of one field: word boundaries are separator runs only
 * (no camel splitting on the document side; the query side expands
 * camelCase via tokenizeQuery instead). */
function fieldTokens(folded: string): string[] {
  return folded.split(FIELD_SPLIT).filter((t) => t !== "");
}

interface FieldStats {
  /** Folded tokens per entry, SORTED ascending, parallel to the candidate
   * array, so term and document frequencies are binary-search range
   * counts. */
  readonly tokens: ReadonlyArray<ReadonlyArray<string>>;
  /** Folded full text per entry (phrase containment). */
  readonly texts: ReadonlyArray<string>;
  readonly lengths: ReadonlyArray<number>;
  readonly avgdl: number;
}

function buildFieldStats(candidates: ReadonlyArray<Engram>, field: SearchFieldName): FieldStats {
  const tokens: string[][] = [];
  const texts: string[] = [];
  const lengths: number[] = [];
  let total = 0;
  for (const m of candidates) {
    const folded = foldField(fieldText(m, field));
    const list = fieldTokens(folded);
    list.sort();
    tokens.push(list);
    texts.push(folded);
    lengths.push(list.length);
    total += list.length;
  }
  const avgdl = candidates.length === 0 ? 0 : total / candidates.length;
  return { tokens, texts, lengths, avgdl };
}

/** First index in the sorted list whose token is >= `from`. */
function lowerBound(list: ReadonlyArray<string>, from: string): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((list[mid] as string) < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Occurrences of `token` in a sorted list. */
function countExact(list: ReadonlyArray<string>, token: string): number {
  let i = lowerBound(list, token);
  let n = 0;
  while (i < list.length && (list[i] as string) === token) {
    n += 1;
    i += 1;
  }
  return n;
}

/** Occurrences of tokens starting with `stem` in a sorted list. */
function countPrefix(list: ReadonlyArray<string>, stem: string): number {
  let i = lowerBound(list, stem);
  let n = 0;
  while (i < list.length && (list[i] as string).startsWith(stem)) {
    n += 1;
    i += 1;
  }
  return n;
}

function candidatesCount(stats: FieldStats): number {
  return stats.lengths.length;
}

/** Any character that is not letter, digit, or mark: a query token
 * containing one internally is a multi-component form (call form, path,
 * dotted name). */
const HAS_SEPARATOR = /[^\p{L}\p{N}\p{M}]/u;

/**
 * Bare-identifier components of multi-component query tokens (ENG-60).
 *
 * The query side emits a call form like `fetchBundle(outPath` as its whole
 * normalized form plus camelCase-split words ("fetch", "bundle", ...), but
 * the document side splits on separators only and keeps the bare identifier
 * `fetchbundle` whole, so no query token equals it and exact identifier
 * relevance collapses into weak prefix noise. Scoring therefore also
 * derives, for every word term, the separator-run pieces of each of its
 * tokens that internally contain a separator (call forms, paths, dotted
 * names). Pieces are already normalized (folding never introduces
 * separators) and are deduplicated query-wide per field scope with the
 * same keying as parseQuery, so a token can never score twice in one
 * query. Word terms and phrase terms then contribute the same bare
 * identifiers. Single-component tokens yield nothing, so plain-word
 * ranking is untouched, and no emitted token stream changes.
 */
function expandCallFormTokens(parsed: ParsedQuery): ParsedQuery {
  const key = (field: SearchFieldName | undefined, token: string): string =>
    `${field ?? ""}\u0000${token}`;
  const seen = new Set<string>();
  for (const alternative of parsed.alternatives) {
    for (const term of alternative) {
      for (const token of term.tokens) seen.add(key(term.field, token));
    }
  }
  let changed = false;
  const alternatives = parsed.alternatives.map((alternative) =>
    alternative.map((term) => {
      if (term.kind !== "word") return term;
      const tokens = [...term.tokens];
      for (const token of term.tokens) {
        if (!HAS_SEPARATOR.test(token)) continue;
        for (const piece of token.split(FIELD_SPLIT)) {
          if (piece === "") continue;
          const k = key(term.field, piece);
          if (seen.has(k)) continue;
          seen.add(k);
          tokens.push(piece);
          changed = true;
        }
      }
      return tokens.length !== term.tokens.length ? { ...term, tokens } : term;
    }),
  );
  return changed ? { alternatives } : parsed;
}

function tfNorm(stats: FieldStats, field: SearchFieldName, index: number, tf: number): number {
  if (tf === 0 || stats.avgdl === 0) return 0;
  return tf / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * stats.lengths[index]) / stats.avgdl));
}

function wordFallbackEligible(token: string): boolean {
  return token.length >= PREFIX_FALLBACK_MIN;
}

export interface RankOptions {
  readonly explain: boolean;
}

/** Lucene-variant idf from a document frequency: always positive; zero df
 * never reaches here (callers skip on tf === 0 / df === 0). */
function idfFromDf(stats: FieldStats, df: number): number {
  return Math.log(1 + (candidatesCount(stats) - df + 0.5) / (df + 0.5));
}

/** Memoized document frequency for one (field, stem) with prefix or exact
 * counting, lazily computed over the candidate set once per query. */
function dfOf(
  stats: Record<SearchFieldName, FieldStats>,
  memo: Map<string, number>,
  field: SearchFieldName,
  stem: string,
  prefix: boolean,
): number {
  const key = `${field}\u0000${stem}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let count = 0;
  const fieldStats = stats[field];
  for (const list of fieldStats.tokens) {
    if ((prefix ? countPrefix(list, stem) : countExact(list, stem)) > 0) count += 1;
  }
  memo.set(key, count);
  return count;
}

function scoreTerm(
  term: QueryTerm,
  entryIndex: number,
  stats: Record<SearchFieldName, FieldStats>,
  dfMemo: Map<string, number>,
  /** Point values in contribution order; the entry score is the exact
   * left-to-right sum of this sequence (always collected). */
  pointsList: number[],
  /** Contribution objects; only built when explaining. */
  contributions: ScoreContribution[] | undefined,
): boolean {
  const fields: ReadonlyArray<SearchFieldName> =
    term.field !== undefined ? [term.field] : FIELD_ORDER;
  let matched = false;
  const add = (
    field: SearchFieldName,
    token: string,
    score: number,
    component: ScoreComponent,
  ): void => {
    if (score <= 0) return;
    matched = true;
    pointsList.push(score);
    contributions?.push({ field, token, score, component });
  };

  /** One word token scored against its scoped fields (shared by word and
   * phrase terms): bounded prefix fallback when eligible, exact otherwise.
   * tf and df always use the same counting mode so idf stays consistent. */
  const scoreWord = (token: string): void => {
    const prefix = wordFallbackEligible(token);
    for (const field of fields) {
      const s = stats[field];
      const list = s.tokens[entryIndex];
      if (list === undefined) continue;
      const tf = prefix ? countPrefix(list, token) : countExact(list, token);
      if (tf === 0) continue;
      const df = dfOf(stats, dfMemo, field, token, prefix);
      if (df === 0) continue;
      add(
        field,
        token,
        FIELD_WEIGHTS[field] * idfFromDf(s, df) * tfNorm(s, field, entryIndex, tf),
        "bm25",
      );
    }
  };

  if (term.kind === "prefix") {
    const stem = term.tokens[0] ?? "";
    if (stem === "") return false;
    for (const field of fields) {
      const s = stats[field];
      const list = s.tokens[entryIndex];
      if (list === undefined) continue;
      const tf = countPrefix(list, stem);
      if (tf === 0) continue;
      const df = dfOf(stats, dfMemo, field, stem, true);
      if (df === 0) continue;
      add(
        field,
        stem,
        FIELD_WEIGHTS[field] * idfFromDf(s, df) * tfNorm(s, field, entryIndex, tf),
        "prefix",
      );
    }
    return matched;
  }

  if (term.kind === "phrase") {
    // Words first (ordinary BM25 tokens), then the contiguous bonus.
    for (const token of term.tokens) scoreWord(token);
    const phrase = term.phrase ?? "";
    if (phrase !== "") {
      for (const field of fields) {
        const s = stats[field];
        if ((s.texts[entryIndex] ?? "").includes(phrase)) {
          add(field, phrase, FIELD_WEIGHTS[field] * PHRASE_WEIGHT, "phrase");
        }
      }
    }
    return matched;
  }

  for (const token of term.tokens) scoreWord(token);
  return matched;
}

/** Rank candidates against a parsed query: an entry is returned when every
 * term of at least one OR-alternative matches. For legacy parity, pinning can
 * also include an entry for plain unscoped alternatives, but never for field
 * filters or AND requirements. Results sort score-desc with id-ascending
 * ties. Lifecycle filtering is the caller's job (searchEngrams). */
export function rankEntries(
  candidates: ReadonlyArray<Engram>,
  parsed: ParsedQuery,
  options: RankOptions,
): SearchResult[] {
  const explain = options.explain === true;
  if (candidates.length === 0 || parsed.alternatives.length === 0) return [];
  const expanded = expandCallFormTokens(parsed);
  const stats = {
    tag: buildFieldStats(candidates, "tag"),
    title: buildFieldStats(candidates, "title"),
    type: buildFieldStats(candidates, "type"),
    body: buildFieldStats(candidates, "body"),
  } satisfies Record<SearchFieldName, FieldStats>;
  const dfMemo = new Map<string, number>();

  const results: SearchResult[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const m = candidates[index] as Engram;
    // Point values are always collected in contribution order; the score is
    // their exact left-to-right sum, identical with and without explain.
    // Contribution objects are only materialized when explaining.
    const pointsList: number[] = [];
    const contributions: ScoreContribution[] = [];
    let matched = false;
    for (const alternative of expanded.alternatives) {
      // Inclusion gate: the alternative matches when every term matches.
      // A pinned entry also satisfies a plain, single-term alternative, but
      // never a field-scoped or AND alternative. Eligibility is local to the
      // alternative so a constrained OR branch cannot disable a plain one.
      const pinnedEligible = alternative.length === 1 && alternative[0]?.field === undefined;
      // Scoring is unconditional: every matching term of every alternative
      // contributes, in fixed alternative-then-term order.
      let all = true;
      for (const term of alternative) {
        if (!scoreTerm(term, index, stats, dfMemo, pointsList, explain ? contributions : undefined))
          all = false;
      }
      if (all || (m.pinned === true && pinnedEligible)) matched = true;
    }
    if (!matched) continue;
    // Pinned is pushed and accumulated LAST so the score is exactly the
    // left-to-right sum of the contribution sequence (the documented
    // "contributions sum to the score" invariant holds bit-for-bit).
    if (m.pinned) {
      pointsList.push(PINNED_BOOST);
      if (explain) {
        contributions.push({
          field: "pinned",
          token: null,
          score: PINNED_BOOST,
          component: "pinned",
        });
      }
    }
    let score = 0;
    for (const p of pointsList) score += p;
    if (score > 0) {
      results.push({
        engram: m,
        score,
        ...(explain ? { explanation: { mode: "relevance" as const, contributions } } : {}),
      });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.engram.id.localeCompare(b.engram.id));
}
