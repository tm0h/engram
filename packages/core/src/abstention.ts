/**
 * ENG-59 abstention policy: a query-level, all-or-nothing layer that
 * abstains (returns no results) when a natural-language query's ranking is
 * a vocabulary graze: entries share query words but no single entry covers
 * a substantive share of the query's informative mass.
 *
 * Decision boundary (closed form, recomputable from this file alone):
 *
 *   abstain(query, ranking)  iff
 *     1. the ranking is non-empty (genuine emptiness stays emptiness),
 *     2. STRUCTURE GATE: every parsed alternative is a single plain word
 *        term (kind "word", no field scope). Any phrase, prefix,
 *        field-scoped, or AND-conjoined shape is explicit user intent and
 *        never abstains,
 *     3. the query has at least `minInformative` alternatives, and
 *     4. bestCoverage < `coverageThreshold`, where bestCoverage is the
 *        maximum, over all returned entries, of the idf-exponent-weighted
 *        share of query mass the entry covers:
 *
 *          w(A)      = max over t in tokens(A) of idf(df(t)) ^ idfExponent
 *          idf(df)   = ln(1 + (N - df + 0.5) / (df + 0.5))
 *          df(t)     = number of candidates whose union of folded field
 *                      tokens (tag, alias, title, type, body) contains t
 *          N         = number of candidates
 *          tokens(A) = the alternative's term tokens plus their separator
 *                      pieces (call-form expansion, mirroring the ranker's
 *                      expandCallFormTokens query-wide dedup: a piece that
 *                      equals another term's token attributes there, not
 *                      here)
 *          cov(e)    = (sum of w(A) for alternatives A where entry e has a
 *                       score contribution whose token is in tokens(A))
 *                      / (sum of all w(A))
 *          bestCoverage = max over entries e of cov(e)
 *
 *   Parameters (calibrated on the corpus, see the wu1 handoffs):
 *   - coverageThreshold T = 0.1: the only corpus miss this policy flips
 *     (case-abstention-11) has bestCoverage 0.0985; the nearest allow-
 *     control above the boundary (case-superseded-11) has 0.1174. T sits
 *     inside the open interval (0.0985, 0.1174) with margins 0.0015
 *     deny-side and 0.0174 control-side; the control floor is a single
 *     case (thin, per the SPEC) and is re-verified in the wu1 calibration
 *     table at every turn.
 *   - idfExponent p = 2: p = 1 makes the boundary non-separable (the miss
 *     rises to 0.1578 while the p = 1 allow-control floor falls to
 *     0.1351 at case-paraphrase-30, so the p = 1 decision set at T = 0.1
 *     is empty).
 *   - minInformative = 2: single-term queries never abstain (ENG-59
 *     constraint: single-token behavior is unchanged).
 *
 * The policy is a boolean over the whole ranking. It never filters,
 * reorders, or rescores entries, and pinned contributions (field "pinned",
 * token null) never count as coverage, so a pinned entry admitted by
 * single-term eligibility cannot by itself defeat abstention for a query it
 * does not substantively cover.
 *
 * Evidence requirement: coverage attribution reads the results' score
 * contributions, so callers must pass explained results (the output of
 * `searchEngrams(..., { explain: true })`). A result without an
 * explanation carries no coverage evidence; the decision is then
 * "ineligible" (never abstain) rather than zero-coverage, because the
 * dangerous failure direction is a false abstention. The wired path
 * always satisfies this (it ranks with explain internally).
 *
 * Pure and deterministic: the decision is a function of (candidates, parsed
 * query, ranked results) alone; no clock, randomness, or global state.
 */
import type { Engram } from "./domain.js";
import type { ParsedQuery, QueryTerm } from "./query.js";
import { normalizeText } from "./tokenize.js";
import type { SearchResult } from "./search.js";

/** Abstention parameters with their calibrated defaults. */
export interface AbstentionParams {
  /** Best-entry coverage below which the ranking abstains. */
  readonly coverageThreshold: number;
  /** Exponent applied to idf when weighting query alternatives. */
  readonly idfExponent: number;
  /** Minimum number of (single plain word term) alternatives for the
   * policy to be eligible at all. */
  readonly minInformative: number;
}

/** Calibrated defaults (wu1 handoffs, ENG-59): T = 0.1 inside the open
 * interval (0.0985, 0.1174); p = 2 (p = 1 does not separate); queries with
 * fewer than 2 alternatives are never eligible. */
export const DEFAULT_ABSTENTION_PARAMS: AbstentionParams = {
  coverageThreshold: 0.1,
  idfExponent: 2,
  minInformative: 2,
};

/** Separator runs for folding query tokens into call-form pieces. Must
 * stay identical to the ranker's FIELD_SPLIT and the tokenizer's
 * SEPARATOR_RUN (any run of characters that is not a letter, digit, or
 * mark); pinned to `tokenizeQuery` behavior in tests. */
const SEPARATOR_RUN = /[^\p{L}\p{N}\p{M}]+/u;

/** Any character that is not a letter, digit, or mark (same class as the
 * separator run, tested as a single character). */
const HAS_SEPARATOR = /[^\p{L}\p{N}\p{M}]/u;

/** Separator-run pieces of a normalized query token: the call-form
 * expansion the ranker scores with (`expandCallFormTokens`). A token
 * without an internal separator yields nothing (the token itself is
 * already in its term's token set). */
export function separatorPieces(token: string): ReadonlyArray<string> {
  if (!HAS_SEPARATOR.test(token)) return [];
  return token.split(SEPARATOR_RUN).filter((piece) => piece !== "");
}

/** Folded text of one indexable field. Mirrors the ranker's fieldText
 * (tags and aliases join with spaces) so document-side tokenization is
 * identical; the fold itself is the shared `normalizeText`. */
function fieldText(m: Engram, field: IndexableField): string {
  switch (field) {
    case "tag":
      return m.tags.join(" ");
    case "alias":
      // aliases is store-defaulted to [] but can be absent on Engram values
      // built outside the store (JSON fixture casts).
      return (m.aliases ?? []).join(" ");
    case "title":
      return m.title;
    case "type":
      return m.type;
    case "body":
      return m.body;
  }
}

type IndexableField = "tag" | "alias" | "title" | "type" | "body";

const INDEXABLE_FIELDS: ReadonlyArray<IndexableField> = ["tag", "alias", "title", "type", "body"];

/** A single plain word term: the only shape the policy may judge. */
function isPlainWordAlternative(terms: ReadonlyArray<QueryTerm>): boolean {
  return (
    terms.length === 1 &&
    terms[0] !== undefined &&
    terms[0].kind === "word" &&
    terms[0].field === undefined
  );
}

/** Weight and attribution tokens of one plain word alternative. Weight
 * tokens include separator pieces (an entry matching a call form's piece
 * carries informative mass). Attribution excludes a piece that equals a
 * DIFFERENT term's token: the ranker's query-wide dedup scores that token
 * under the other term, so the contribution belongs there. */
function alternativeTokens(
  terms: ReadonlyArray<QueryTerm>,
  others: ReadonlyArray<ReadonlyArray<QueryTerm>>,
): { weight: ReadonlyArray<string>; attribute: ReadonlyArray<string> } {
  const tokens: string[] = [];
  for (const term of terms) {
    for (const token of term.tokens) {
      if (!tokens.includes(token)) tokens.push(token);
      for (const piece of separatorPieces(token)) {
        if (!tokens.includes(piece)) tokens.push(piece);
      }
    }
  }
  const foreign = new Set<string>();
  for (const other of others) {
    for (const term of other) {
      for (const token of term.tokens) foreign.add(token);
    }
  }
  return { weight: tokens, attribute: tokens.filter((t) => !foreign.has(t)) };
}

/** Outcome of one policy evaluation, exposed for calibration and tests. */
export interface AbstentionDecision {
  /** The ranking was non-empty, passed the structure and minInformative
   * gates, and carried complete contribution evidence (the only rows
   * where coverage is judged). */
  readonly eligible: boolean;
  /** Number of plain word term alternatives (informative units). */
  readonly informativeAlternatives: number;
  /** Best idf-exponent-weighted coverage over the ranking; null when the
   * policy did not judge the ranking (empty ranking, gate, or missing
   * evidence). */
  readonly bestCoverage: number | null;
  /** Final decision: abstain the entire ranking. */
  readonly abstain: boolean;
}

/** The structure-and-count gate of the abstention policy, computable from
 * the parsed query alone: every alternative must be a single plain word
 * term (no phrase, prefix, field scope, or AND) and there must be at least
 * `minInformative` of them. Callers can use this to skip abstention work
 * (including contribution collection) for queries the policy would never
 * judge. It is exactly the pre-ranking half of `evaluateAbstention`'s
 * eligibility gate; result-side conditions (non-empty ranking, explained
 * evidence) are the caller's or the evaluation's to apply. */
export function abstentionEligible(
  parsed: ParsedQuery,
  params: AbstentionParams = DEFAULT_ABSTENTION_PARAMS,
): boolean {
  const alternatives = parsed.alternatives;
  return alternatives.length >= params.minInformative && alternatives.every(isPlainWordAlternative);
}

/** Evaluate the abstention policy for one query and its ranking. Pure:
 * same inputs always yield the same decision.
 *
 * Results must be explained (see the module docblock): a ranking whose
 * results lack contribution evidence is reported as ineligible (never
 * abstain) instead of judged on absent evidence. */
export function evaluateAbstention(
  candidates: ReadonlyArray<Engram>,
  parsed: ParsedQuery,
  results: ReadonlyArray<SearchResult>,
  params: AbstentionParams = DEFAULT_ABSTENTION_PARAMS,
): AbstentionDecision {
  const alternatives = parsed.alternatives;
  const informativeAlternatives = alternatives.filter(isPlainWordAlternative).length;
  if (results.length === 0) {
    return {
      eligible: false,
      informativeAlternatives,
      bestCoverage: null,
      abstain: false,
    };
  }
  if (!abstentionEligible(parsed, params)) {
    return { eligible: false, informativeAlternatives, bestCoverage: null, abstain: false };
  }
  // Evidence guard: coverage attribution reads score contributions. A
  // result without an explanation makes the ranking unjudgeable, and
  // judging it anyway would count zero coverage for the unexplained rows
  // (a false abstention on fully matched results). Never abstain on
  // insufficient evidence; report the decision as ineligible.
  if (results.some((result) => result.explanation === undefined)) {
    return { eligible: false, informativeAlternatives, bestCoverage: null, abstain: false };
  }

  // Union document frequency over the scoped candidate set: tokens are the
  // folded tokens of all five indexable fields per candidate.
  const n = candidates.length;
  const unionSets: ReadonlyArray<Set<string>> = candidates.map((m) => {
    const set = new Set<string>();
    for (const field of INDEXABLE_FIELDS) {
      for (const token of normalizeText(fieldText(m, field)).split(SEPARATOR_RUN)) {
        if (token !== "") set.add(token);
      }
    }
    return set;
  });
  const tokenSets: ReadonlyArray<ReadonlyArray<string>> = alternatives.map((alternative, i) => {
    const others = alternatives.filter((_, j) => j !== i);
    return alternativeTokens(alternative, others).weight;
  });
  const attributionSets: ReadonlyArray<ReadonlyArray<string>> = alternatives.map(
    (alternative, i) => {
      const others = alternatives.filter((_, j) => j !== i);
      return alternativeTokens(alternative, others).attribute;
    },
  );
  const dfCache = new Map<string, number>();
  const dfOf = (token: string): number => {
    const hit = dfCache.get(token);
    if (hit !== undefined) return hit;
    let df = 0;
    for (const set of unionSets) {
      if (set.has(token)) df += 1;
    }
    dfCache.set(token, df);
    return df;
  };
  const idf = (token: string): number =>
    Math.log(1 + (n - dfOf(token) + 0.5) / (dfOf(token) + 0.5));
  const weights = tokenSets.map((tokens) => {
    let w = 0;
    for (const token of tokens) {
      const value = Math.pow(idf(token), params.idfExponent);
      if (value > w) w = value;
    }
    return w;
  });
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) {
    // Unreachable: every word term carries tokens and idf is positive even
    // at df 0. Defensive: never abstain on a degenerate query.
    return { eligible: false, informativeAlternatives, bestCoverage: null, abstain: false };
  }

  let bestCoverage = 0;
  for (const result of results) {
    const contributions = result.explanation?.contributions ?? [];
    const matched = new Set<string>();
    for (const contribution of contributions) {
      // Pinned contributions carry no token and never count as coverage.
      if (contribution.token === null) continue;
      matched.add(contribution.token);
    }
    let coveredWeight = 0;
    for (let i = 0; i < alternatives.length; i++) {
      const attribute = attributionSets[i] as ReadonlyArray<string>;
      if (attribute.some((token) => matched.has(token))) {
        coveredWeight += weights[i] as number;
      }
    }
    const coverage = coveredWeight / totalWeight;
    if (coverage > bestCoverage) bestCoverage = coverage;
  }

  return {
    eligible: true,
    informativeAlternatives,
    bestCoverage,
    abstain: bestCoverage < params.coverageThreshold,
  };
}

/** The abstention decision for the wired search path: true means the
 * caller drops the entire ranking (return [] exactly like a no-match
 * query). Never filters, reorders, or rescores individual entries. */
export function abstainPolicy(
  candidates: ReadonlyArray<Engram>,
  parsed: ParsedQuery,
  results: ReadonlyArray<SearchResult>,
  params: AbstentionParams = DEFAULT_ABSTENTION_PARAMS,
): boolean {
  return evaluateAbstention(candidates, parsed, results, params).abstain;
}
