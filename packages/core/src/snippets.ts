/** Query-aware excerpts. Fold graphemes separately and map every folded code
 * unit back to its original grapheme; normalized offsets never index raw text. */
import { parseQuery } from "./query.js";
import { normalizeText } from "./tokenize.js";

export const SNIPPET_MAX_CHARS = 240;
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

export function matchingSnippet(body: string, query: string): string | null {
  const terms = parseQuery(query)
    .alternatives.flat()
    .filter((t) => !t.field || t.field === "body");
  if (!terms.length || !body) return null;
  const parts = Array.from(segmenter.segment(body), (s) => s.segment);
  const offsets: number[] = [];
  const folded = normalizeText(body);
  for (let i = 0; i < parts.length; i++) {
    const text = normalizeText(parts[i]!);
    for (let j = 0; j < text.length; j++) offsets.push(i);
  }
  // Prefer a contiguous phrase; otherwise earliest matching lexical token.
  let at = -1;
  for (const term of terms) {
    if (!term.phrase) continue;
    const index = folded.indexOf(term.phrase);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) {
    for (const match of folded.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
      if (
        terms.some((t) =>
          t.tokens.some(
            (token) =>
              match[0] === token ||
              ((t.kind === "prefix" || token.length >= 3) && match[0].startsWith(token)),
          ),
        )
      ) {
        at = match.index;
        break;
      }
    }
  }
  if (at < 0) return null;
  const center = offsets[at]!;
  // Budget UTF-16 units, but only slice at complete graphemes. Whitespace is
  // collapsed after slicing; ellipses are included in the hard bound.
  let start = center;
  let left = 0;
  while (start > 0 && left + parts[start - 1]!.length <= 100) left += parts[--start]!.length;
  let end = start;
  let used = 0;
  while (end < parts.length && used + parts[end]!.length <= SNIPPET_MAX_CHARS - 2)
    used += parts[end++]!.length;
  if (end <= center) return null;
  const text = parts.slice(start, end).join("").replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < parts.length ? "…" : ""}`;
}
