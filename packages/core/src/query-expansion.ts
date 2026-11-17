/** Shared lexical query expansion for scoring and matching excerpts. */
import type { ParsedQuery, SearchFieldName } from "./query.js";

const FIELD_SPLIT = /[^\p{L}\p{N}\p{M}]+/u;

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
export function expandCallFormTokens(parsed: ParsedQuery): ParsedQuery {
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
