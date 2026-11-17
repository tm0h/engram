/** Conservative evidence for automatic recall, independent of BM25's corpus-dependent scale. */
import { parseQuery } from "./query.js";
import { expandCallFormTokens } from "./query-expansion.js";
import { normalizeText } from "./tokenize.js";
import type { SearchResult } from "./search.js";

// Conversational glue contributes no confidence coverage. Domain words and
// identifiers remain intact; this is deliberately a small English-only list.
const GLUE = new Set(
  "a an the and or i we you my our your it this that these those is are was be been to of for in on at with from by as do does how what which can could would should please help me implement fix explain about".split(
    " ",
  ),
);

/** Prompt text never grants field, phrase, prefix, or boolean search intent.
 * Keep case until the tokenizer has expanded camelCase identifiers. */
export function contextualQuery(prompt: string): string {
  return prompt
    .replace(/[":*]/g, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => (word === "AND" || word === "OR" ? word.toLowerCase() : word))
    .join(" ");
}

export interface ContextualEvidence {
  readonly matchedUnits: number;
  readonly totalUnits: number;
  readonly coverage: number;
  readonly trigger: boolean;
  readonly confident: boolean;
}

/** Prepare prompt normalization, query expansion and unit matching keys once.
 * The returned evaluator is reusable and has no mutable per-result state. */
export function prepareContextualEvidence(
  query: string,
  prompt: string,
): (result: SearchResult) => ContextualEvidence {
  const parsed = expandCallFormTokens(parseQuery(query));
  const units = parsed.alternatives
    .flatMap((a) => a.map((t) => t.tokens[0]))
    .filter((exact): exact is string => exact !== undefined && exact !== "" && !GLUE.has(exact))
    .map((exact) => {
      const pieces = exact.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
      const longest = pieces.reduce((a, b) => (a.length >= b.length ? a : b), "");
      return { exact, component: pieces.length > 1 ? longest : undefined };
    });
  const normalizedPrompt = normalizeText(prompt.trim());
  return (result) => {
    const contributions = result.explanation?.contributions ?? [];
    const matched = new Set(
      contributions
        .filter(
          (c) =>
            (c.component === "bm25" || c.component === "phrase" || c.component === "prefix") &&
            ["title", "tag", "alias", "body"].includes(c.field) &&
            c.score > 0,
        )
        .flatMap((c) => (c.token === null ? [] : [c.token])),
    );
    // A call/path may match its bare identifier. A tiny argument or a lone
    // camelCase fragment cannot establish a whole unit of confidence.
    const matchedUnits = units.filter(
      ({ exact, component }) =>
        matched.has(exact) || (component !== undefined && matched.has(component)),
    ).length;
    const coverage = units.length ? matchedUnits / units.length : 0;
    const trigger =
      result.engram.triggers?.some((t) => normalizeText(t.trim()) === normalizedPrompt) === true;
    return {
      matchedUnits,
      totalUnits: units.length,
      coverage,
      trigger,
      confident:
        trigger ||
        (coverage >= 0.6 && matchedUnits >= Math.min(2, units.length) && units.length > 0),
    };
  };
}

/** A unit is one original whitespace term, including shared call-form expansion.
 * Require >=60% coverage and two distinct units, or a complete single unit.
 * Only positive lexical content contributions count: type, pinning, freshness,
 * path applicability and importance cannot supply confidence. An exact authored
 * trigger over the ORIGINAL prompt is an independent sufficient signal.
 * Use prepareContextualEvidence when evaluating several results. */
export function contextualEvidence(
  result: SearchResult,
  query: string,
  prompt: string,
): ContextualEvidence {
  return prepareContextualEvidence(query, prompt)(result);
}
