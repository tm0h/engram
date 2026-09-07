/**
 * ENG-18 query syntax parser: turns a free-form search string into a
 * deterministic, structured query. Pure and dependency-free: never throws,
 * never reads global state, same input always yields the same output.
 *
 * Grammar (defined by this module; lowercase `and`/`or` stay ordinary
 * words, operators are uppercase only):
 *
 *   query        := alternative (OR | whitespace alternative)*
 *   alternative  := term (AND term)*        (AND binds tighter than OR)
 *   term         := word | phrase | prefix | field ":" term
 *   word         := <any text>              matched via tokenizeQuery
 *   phrase       := '"' <text> '"'          contiguous, boosted
 *   prefix       := <stem> '*'              stem >= 2 chars after fold
 *   field        := tag | title | type | body
 *
 * Semantics:
 * - The query is a disjunction (OR) of alternatives; an entry matches the
 *   query when every term of at least one alternative matches. Whitespace
 *   and an explicit `OR` both separate alternatives, so plain multi-word
 *   queries keep the legacy OR-compatible default (ENG-18 decision D2).
 * - `AND` binds terms into one alternative (conjunction), tighter than OR:
 *   `alpha OR beta AND gamma` means alpha OR (beta AND gamma).
 * - A field-filtered term (`tag:auth`, `title:"multi word"`, `body:kuber*`)
 *   matches and scores only in its field. Hard requirements are expressed
 *   with AND: `tag:auth AND kubernetes`.
 * - A phrase scores its words as ordinary tokens and adds a contiguous
 *   occurrence bonus per field containing the folded phrase text.
 * - A prefix matches any field token starting with the folded stem. Stems
 *   shorter than 2 characters (after folding) degrade to a plain word term
 *   over the remainder, keeping any field scope (ENG-18 preflight F4:
 *   bounded prefix matching).
 * - An unknown `foo:bar` prefix is not syntax: the whole chunk is a word.
 * - Word tokens are deduplicated across the whole query (per field scope),
 *   first occurrence winning, mirroring tokenizeQuery's dedup so repeated
 *   words cannot double-score.
 * - Degenerate input (empty, punctuation-only, operator-only, unterminated
 *   quote, lone `*`) yields zero alternatives or a safe word fallback; the
 *   empty query path stays the recency list.
 */
import { normalizeText, tokenizeQuery } from "./tokenize.js";

/** Fields a term can be scoped to. `pinned` is not a queryable field. */
export type SearchFieldName = "tag" | "title" | "type" | "body";

const SEARCH_FIELDS: ReadonlyArray<SearchFieldName> = ["tag", "title", "type", "body"];

/** One parsed query term. */
export interface QueryTerm {
  /** `word`: exact form plus expanded subtokens. `phrase`: contiguous text
   * plus word tokens. `prefix`: a single folded stem in `tokens`. */
  readonly kind: "word" | "phrase" | "prefix";
  /** Scoring tokens. Normalized query-side tokens only, never source text. */
  readonly tokens: ReadonlyArray<string>;
  /** Normalized contiguous phrase text; phrase kind only. */
  readonly phrase?: string;
  /** Scoped field; undefined means all fields. */
  readonly field?: SearchFieldName;
}

/** A parsed query: a disjunction of conjunctions. Empty alternatives mean
 * the query has no searchable content and callers fall back to the recency
 * path. */
export interface ParsedQuery {
  readonly alternatives: ReadonlyArray<ReadonlyArray<QueryTerm>>;
}

/** Split on unquoted whitespace runs; double quotes toggle quote mode and
 * are kept in the chunk text for the term builder to strip. An unterminated
 * quote just runs to the end of the input. */
function chunkQuery(query: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of query) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes && /\s/u.test(ch)) {
      if (current !== "") chunks.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/** Words of a normalized phrase: the phrase folded once, split on separator
 * runs, deduplicated in order. */
function phraseWords(phrase: string): string[] {
  const words: string[] = [];
  for (const word of phrase.split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (word !== "" && !words.includes(word)) words.push(word);
  }
  return words;
}

/** Field-scope prefix of a chunk: `tag:`, `title:`, `type:`, or `body:`.
 * Unknown prefixes are not syntax. */
function splitField(chunk: string): { field?: SearchFieldName; rest: string } {
  const index = chunk.indexOf(":");
  if (index === -1) return { rest: chunk };
  const name = chunk.slice(0, index);
  if (!(SEARCH_FIELDS as ReadonlyArray<string>).includes(name)) return { rest: chunk };
  return { field: name as SearchFieldName, rest: chunk.slice(index + 1) };
}

/** Dedup key for a scoring token, scoped by field so the same token can
 * exist once unscoped and once per field scope. */
const tokenKey = (field: SearchFieldName | undefined, token: string, suffix: string): string =>
  `${field ?? ""}\u0000${token}${suffix}`;

export function parseQuery(query: string): ParsedQuery {
  const alternatives: QueryTerm[][] = [];
  let current: QueryTerm[] = [];
  /** Query-wide dedup, per field scope, so a repeated word cannot
   * double-score (parity with tokenizeQuery's whole-query dedup). */
  const seen = new Set<string>();

  const buildTerm = (chunk: string): QueryTerm | undefined => {
    const { field, rest } = splitField(chunk);

    // Quoted phrase (possibly field-scoped): fold once, keep word tokens.
    // An unterminated quote runs to the end of the chunk: still a phrase.
    if (rest.startsWith('"')) {
      const inner = rest.endsWith('"') && rest.length >= 2 ? rest.slice(1, -1) : rest.slice(1);
      const phrase = normalizeText(inner);
      if (phrase === "") return undefined;
      const tokens: string[] = [];
      for (const word of phraseWords(phrase)) {
        const key = tokenKey(field, word, "");
        if (!seen.has(key)) {
          seen.add(key);
          tokens.push(word);
        }
      }
      return { kind: "phrase", tokens, phrase, field };
    }

    // Bounded prefix: a trailing star with a folded stem of at least 2
    // characters. Anything else degrades to a word term over the remainder.
    if (rest.endsWith("*")) {
      const stem = normalizeText(rest.slice(0, -1));
      if (stem.length >= 2) {
        const key = tokenKey(field, stem, "*");
        if (seen.has(key)) return undefined;
        seen.add(key);
        return { kind: "prefix", tokens: [stem], field };
      }
    }

    const tokens = tokenizeQuery(rest).filter((token) => !seen.has(tokenKey(field, token, "")));
    for (const token of tokens) seen.add(tokenKey(field, token, ""));
    if (tokens.length === 0) return undefined;
    return { kind: "word", tokens, field };
  };

  // A term is appended to the current alternative only when the preceding
  // operator was AND (or nothing came before); whitespace and OR start a
  // new alternative. This is what makes whitespace an OR separator while
  // AND chains terms into one conjunction.
  let joinWithAnd = true;
  for (const chunk of chunkQuery(query)) {
    if (chunk === "AND") {
      joinWithAnd = true;
      continue;
    }
    if (chunk === "OR") {
      if (current.length > 0) alternatives.push(current);
      current = [];
      joinWithAnd = false;
      continue;
    }
    const term = buildTerm(chunk);
    if (term !== undefined) {
      if (!joinWithAnd) {
        if (current.length > 0) alternatives.push(current);
        current = [];
      }
      current.push(term);
      joinWithAnd = false;
    }
  }
  if (current.length > 0) alternatives.push(current);

  return { alternatives };
}
